import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import { query } from './db.js';
import { migrate } from './migrations.js';
import { optionalAuth, requireAuth } from './auth.js';
import { askOpenRouter } from './openrouter.js';
import { crawlSource, importExamPayload, isImportableExamSource } from './crawler.js';
import { runDueCrawls, startCrawlerScheduler } from './scheduler.js';

const app = express();
const port = Number(process.env.PORT || 4000);

app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(cors({ origin: process.env.CORS_ORIGIN?.split(',') || true, credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use('/media', express.static(process.env.CRAWLER_STORAGE_DIR || path.resolve(process.cwd(), 'storage'), {
  maxAge: '7d',
  index: false,
}));
app.use((req, _res, next) => {
  console.log(`${req.method} ${req.path}`);
  next();
});

app.get('/api/health', async (_req, res) => {
  const db = await query('SELECT now() AS now');
  res.json({ ok: true, db: db.rows[0].now });
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

async function getExamWithReadiness(slug) {
  const result = await query(
    `WITH question_stats AS (
       SELECT
         exam_id,
         COUNT(*)::int AS question_imported_count,
         COUNT(*) FILTER (WHERE type = 'multiple_choice')::int AS multiple_choice_count,
         COUNT(*) FILTER (
           WHERE type = 'multiple_choice'
             AND answer IS NOT NULL
             AND COALESCE(answer->>'status', '') <> 'unknown'
             AND COALESCE(answer->>'choice', answer->>'id', answer->>'correct', '') <> ''
         )::int AS answer_key_question_count,
         COUNT(*) FILTER (WHERE COALESCE(audio_url, '') <> '')::int AS audio_question_count,
         COUNT(*) FILTER (WHERE COALESCE(image_url, '') <> '' OR COALESCE(content_html, '') ILIKE '%<img%')::int AS image_question_count,
         COUNT(*) FILTER (
           WHERE type = 'multiple_choice'
             AND (
               jsonb_array_length(COALESCE(choices, '[]'::jsonb)) < 2
               OR EXISTS (
                 SELECT 1
                 FROM jsonb_array_elements(COALESCE(choices, '[]'::jsonb)) AS choice
                 WHERE btrim(regexp_replace(COALESCE(choice->>'html', choice->>'text', ''), '<[^>]+>', '', 'g')) = ''
               )
               OR (
                 COALESCE(image_url, '') = ''
                 AND COALESCE(content_html, '') NOT ILIKE '%<img%'
                 AND NOT EXISTS (
                   SELECT 1
                   FROM jsonb_array_elements(COALESCE(choices, '[]'::jsonb)) AS choice
                   WHERE btrim(regexp_replace(COALESCE(choice->>'text', choice->>'html', ''), '<[^>]+>', '', 'g')) !~ '^[①②③④1-4\\s\\.\\)]+$'
                 )
               )
             )
         )::int AS invalid_choice_count
       FROM questions
       GROUP BY exam_id
     )
     SELECT e.*,
      COALESCE(qs.question_imported_count, 0) AS question_imported_count,
      COALESCE(qs.multiple_choice_count, 0) AS multiple_choice_count,
      COALESCE(qs.answer_key_question_count, 0) AS answer_key_question_count,
      COALESCE(qs.audio_question_count, 0) AS audio_question_count,
      COALESCE(qs.image_question_count, 0) AS image_question_count,
      COALESCE(qs.invalid_choice_count, 0) AS invalid_choice_count,
      (
        CASE
          WHEN e.topik_level = 'I' THEN COALESCE(qs.question_imported_count, 0) >= 70 AND COALESCE(qs.audio_question_count, 0) >= 30
          WHEN e.topik_level = 'II' THEN COALESCE(qs.question_imported_count, 0) >= 100 AND COALESCE(qs.audio_question_count, 0) >= 50
          ELSE false
        END
        AND COALESCE(qs.multiple_choice_count, 0) > 0
        AND COALESCE(qs.answer_key_question_count, 0) >= COALESCE(qs.multiple_choice_count, 0)
        AND COALESCE(qs.invalid_choice_count, 0) = 0
      ) AS ready_for_practice
     FROM exams e
     LEFT JOIN question_stats qs ON qs.exam_id = e.id
     WHERE e.slug = $1 AND e.status = 'published'`,
    [slug],
  );
  return result.rows[0] || null;
}

app.get('/api/exams', optionalAuth, async (req, res) => {
  const { level, includeIncomplete } = req.query;
  const params = [];
  let where = "WHERE e.status = 'published'";
  if (level && ['I', 'II'].includes(String(level))) {
    params.push(level);
    where += ` AND e.topik_level = $${params.length}`;
  }
  const result = await query(
    `WITH question_stats AS (
     SELECT
         exam_id,
         COUNT(*)::int AS question_imported_count,
         COUNT(*) FILTER (WHERE type = 'multiple_choice')::int AS multiple_choice_count,
         COUNT(*) FILTER (
           WHERE type = 'multiple_choice'
             AND answer IS NOT NULL
             AND COALESCE(answer->>'status', '') <> 'unknown'
             AND COALESCE(answer->>'choice', answer->>'id', answer->>'correct', '') <> ''
         )::int AS answer_key_question_count,
         COUNT(*) FILTER (WHERE COALESCE(audio_url, '') <> '')::int AS audio_question_count,
         COUNT(*) FILTER (WHERE COALESCE(image_url, '') <> '' OR COALESCE(content_html, '') ILIKE '%<img%')::int AS image_question_count,
         COUNT(*) FILTER (
           WHERE type = 'multiple_choice'
             AND (
               jsonb_array_length(COALESCE(choices, '[]'::jsonb)) < 2
               OR EXISTS (
                 SELECT 1
                 FROM jsonb_array_elements(COALESCE(choices, '[]'::jsonb)) AS choice
                 WHERE btrim(regexp_replace(COALESCE(choice->>'html', choice->>'text', ''), '<[^>]+>', '', 'g')) = ''
               )
               OR (
                 COALESCE(image_url, '') = ''
                 AND COALESCE(content_html, '') NOT ILIKE '%<img%'
                 AND NOT EXISTS (
                   SELECT 1
                   FROM jsonb_array_elements(COALESCE(choices, '[]'::jsonb)) AS choice
                   WHERE btrim(regexp_replace(COALESCE(choice->>'text', choice->>'html', ''), '<[^>]+>', '', 'g')) !~ '^[①②③④1-4\\s\\.\\)]+$'
                 )
               )
             )
         )::int AS invalid_choice_count
       FROM questions
       GROUP BY exam_id
     ),
     exam_stats AS (
       SELECT e.*,
        COALESCE(qs.question_imported_count, 0) AS question_imported_count,
        COALESCE(qs.multiple_choice_count, 0) AS multiple_choice_count,
        COALESCE(qs.answer_key_question_count, 0) AS answer_key_question_count,
        COALESCE(qs.audio_question_count, 0) AS audio_question_count,
        COALESCE(qs.image_question_count, 0) AS image_question_count,
        COALESCE(qs.invalid_choice_count, 0) AS invalid_choice_count,
        (
          CASE
            WHEN e.topik_level = 'I' THEN COALESCE(qs.question_imported_count, 0) >= 70 AND COALESCE(qs.audio_question_count, 0) >= 30
            WHEN e.topik_level = 'II' THEN COALESCE(qs.question_imported_count, 0) >= 100 AND COALESCE(qs.audio_question_count, 0) >= 50
            ELSE false
          END
          AND COALESCE(qs.multiple_choice_count, 0) > 0
          AND COALESCE(qs.answer_key_question_count, 0) >= COALESCE(qs.multiple_choice_count, 0)
          AND COALESCE(qs.invalid_choice_count, 0) = 0
        ) AS ready_for_practice
       FROM exams e
       LEFT JOIN question_stats qs ON qs.exam_id = e.id
       ${where}
     )
     SELECT es.*,
      COALESCE(json_agg(s ORDER BY s.sort_order) FILTER (WHERE s.id IS NOT NULL), '[]') AS sections
     FROM exam_stats es
     LEFT JOIN exam_sections s ON s.exam_id = es.id
     ${includeIncomplete === '1' ? '' : 'WHERE es.ready_for_practice = true'}
     GROUP BY es.id, es.slug, es.topik_level, es.round_no, es.title_ko, es.title_en, es.subject,
       es.question_count, es.total_score, es.duration_minutes, es.source_url, es.audio_url,
       es.imported_from, es.status, es.created_at, es.updated_at, es.question_imported_count,
       es.multiple_choice_count, es.answer_key_question_count, es.audio_question_count,
       es.image_question_count, es.invalid_choice_count, es.ready_for_practice
     ORDER BY es.topik_level DESC, es.round_no DESC, es.created_at DESC`,
    params,
  );
  res.json({ exams: result.rows });
});

app.get('/api/exams/:slug', optionalAuth, async (req, res) => {
  const exam = await getExamWithReadiness(req.params.slug);
  if (!exam) return res.status(404).json({ error: 'Exam not found' });
  if (req.query.includeIncomplete !== '1' && !exam.ready_for_practice) {
    return res.status(404).json({ error: 'Exam is not ready for practice' });
  }

  const sections = await query('SELECT * FROM exam_sections WHERE exam_id = $1 ORDER BY sort_order', [exam.id]);
  res.json({ exam, sections: sections.rows });
});

app.get('/api/exams/:slug/questions', requireAuth, async (req, res) => {
  const exam = await getExamWithReadiness(req.params.slug);
  if (!exam) return res.status(404).json({ error: 'Exam not found' });
  if (req.query.includeIncomplete !== '1' && !exam.ready_for_practice) {
    return res.status(409).json({
      error: 'Exam is not ready for practice',
      detail: 'Nguồn này chưa có đáp án public hoặc có option lỗi nên không được đưa vào luyện thi.',
      exam,
    });
  }

  const questions = await query(
    `SELECT q.*, s.section_key, s.title AS section_title
     FROM questions q
     LEFT JOIN exam_sections s ON s.id = q.section_id
     WHERE q.exam_id = $1
     ORDER BY q.number`,
    [exam.id],
  );
  const sections = await query('SELECT * FROM exam_sections WHERE exam_id = $1 ORDER BY sort_order', [exam.id]);
  res.json({ exam, sections: sections.rows, questions: questions.rows });
});

app.post('/api/exams/:slug/attempts', requireAuth, async (req, res) => {
  const exam = await getExamWithReadiness(req.params.slug);
  if (!exam) return res.status(404).json({ error: 'Exam not found' });
  if (!exam.ready_for_practice) {
    return res.status(409).json({
      error: 'Exam is not ready for practice',
      detail: 'Nguồn này chưa có đáp án public hoặc có option lỗi nên không được tạo bài làm.',
    });
  }
  const result = await query(
    'INSERT INTO attempts (user_id, exam_id) VALUES ($1, $2) RETURNING *',
    [req.user.id, exam.id],
  );
  res.status(201).json({ attempt: result.rows[0] });
});

app.patch('/api/attempts/:id', requireAuth, async (req, res) => {
  const result = await query(
    `UPDATE attempts
     SET answers = $1, status = COALESCE($2, status), submitted_at = CASE WHEN $2 = 'submitted' THEN now() ELSE submitted_at END
     WHERE id = $3 AND user_id = $4
     RETURNING *`,
    [JSON.stringify(req.body.answers || {}), req.body.status || null, req.params.id, req.user.id],
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'Attempt not found' });
  res.json({ attempt: result.rows[0] });
});

app.get('/api/attempts/:id/result', requireAuth, async (req, res) => {
  const attemptResult = await query(
    `SELECT a.*, e.slug, e.topik_level, e.round_no, e.title_ko, e.title_en, e.question_count, e.total_score
     FROM attempts a
     JOIN exams e ON e.id = a.exam_id
     WHERE a.id = $1 AND a.user_id = $2`,
    [req.params.id, req.user.id],
  );
  const attempt = attemptResult.rows[0];
  if (!attempt) return res.status(404).json({ error: 'Attempt not found' });

  const questionResult = await query(
    `SELECT number, points, answer, type
     FROM questions
     WHERE exam_id = $1
     ORDER BY number`,
    [attempt.exam_id],
  );

  const answers = attempt.answers || {};
  let autoScore = 0;
  let autoGradable = 0;
  let correctCount = 0;
  let answeredCount = 0;
  const items = questionResult.rows.map((question) => {
    const userAnswer = answers[String(question.number)] ?? answers[question.number];
    const answered =
      typeof userAnswer === 'string'
        ? userAnswer.trim().length > 0
        : userAnswer && typeof userAnswer === 'object'
          ? Object.values(userAnswer).some((value) => String(value || '').trim())
          : Boolean(userAnswer);
    if (answered) answeredCount += 1;

    const key = question.answer || {};
    const correctChoice = key.choice || key.id || key.correct;
    const gradable = question.type === 'multiple_choice' && correctChoice && key.status !== 'unknown';
    const correct = gradable && String(userAnswer) === String(correctChoice);
    if (gradable) autoGradable += 1;
    if (correct) {
      correctCount += 1;
      autoScore += Number(question.points || 0);
    }
    return {
      number: question.number,
      points: question.points,
      type: question.type,
      user_answer: userAnswer || null,
      correct_answer: gradable ? correctChoice : null,
      gradable,
      correct,
    };
  });

  res.json({
    attempt,
    exam: {
      slug: attempt.slug,
      topik_level: attempt.topik_level,
      round_no: attempt.round_no,
      title_ko: attempt.title_ko,
      title_en: attempt.title_en,
      question_count: attempt.question_count,
      total_score: attempt.total_score,
    },
    summary: {
      answered_count: answeredCount,
      question_count: questionResult.rows.length,
      auto_gradable_count: autoGradable,
      correct_count: correctCount,
      auto_score: autoScore,
      total_score: attempt.total_score,
      has_answer_key: autoGradable > 0,
    },
    items,
  });
});

app.post('/api/chat', requireAuth, async (req, res) => {
  const content = String(req.body.message || '').trim();
  if (!content) return res.status(400).json({ error: 'Message is required' });

  await query('INSERT INTO chat_messages (user_id, role, content) VALUES ($1, $2, $3)', [req.user.id, 'user', content]);
  const answer = await askOpenRouter([
    {
      role: 'system',
      content:
        'Bạn là trợ lý luyện thi TOPIK cho người Việt. Trả lời ngắn gọn, thực dụng, có ví dụ tiếng Hàn khi cần.',
    },
    { role: 'user', content },
  ]);
  await query('INSERT INTO chat_messages (user_id, role, content) VALUES ($1, $2, $3)', [req.user.id, 'assistant', answer.content]);
  res.json({ answer: answer.content, model: answer.model });
});

app.post('/api/crawl', requireAuth, async (req, res) => {
  const sourceUrl = String(req.body.sourceUrl || '').trim();
  if (!sourceUrl) return res.status(400).json({ error: 'sourceUrl is required' });
  await query(
    `INSERT INTO crawl_sources (url, kind, enabled, next_run_at)
     VALUES ($1, $2, true, now() + ($3 || ' hours')::interval)
     ON CONFLICT (url) DO UPDATE SET enabled = true`,
    [sourceUrl, isImportableExamSource(sourceUrl) ? 'exam' : 'index', Number(process.env.CRAWL_INTERVAL_HOURS || 24)],
  );
  const result = await crawlSource(sourceUrl, { ai: Boolean(req.body.ai) });
  res.status(201).json(result);
});

app.post('/api/crawl/run-due', requireAuth, async (req, res) => {
  const summary = await runDueCrawls({ force: Boolean(req.body.force) });
  res.json({ summary });
});

app.get('/api/crawl/sources', requireAuth, async (_req, res) => {
  const result = await query('SELECT * FROM crawl_sources ORDER BY created_at DESC');
  res.json({ sources: result.rows });
});

app.post('/api/import', requireAuth, async (req, res) => {
  const exam = await importExamPayload(req.body);
  res.status(201).json({ exam });
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: 'Internal server error', detail: error.message });
});

migrate()
  .then(() => {
    startCrawlerScheduler();
    app.listen(port, '0.0.0.0', () => {
      console.log(`TOPIK backend listening on ${port}`);
    });
  })
  .catch((error) => {
    console.error('Migration failed:', error);
    process.exit(1);
  });
