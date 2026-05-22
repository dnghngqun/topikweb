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
  res.json({ exam, sections: sections.rows, questions: questions.rows.map(publicQuestion) });
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

function stripHtml(value) {
  return String(value || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function publicMediaUrl(value) {
  if (typeof value !== 'string') return value;
  return value.replace(/https?:\/\/(?:localhost|127\.0\.0\.1):\d+\/media\//g, '/media/');
}

function publicQuestion(row) {
  return {
    ...row,
    content_html: publicMediaUrl(row.content_html),
    image_url: publicMediaUrl(row.image_url),
    audio_url: publicMediaUrl(row.audio_url),
    media: JSON.parse(publicMediaUrl(JSON.stringify(row.media || {}))),
  };
}

async function gradeAttempt(examId, answers) {
  const questionResult = await query(
    `SELECT id, number, points, prompt, passage, content_html, answer, type, choices, explanation
     FROM questions
     WHERE exam_id = $1
     ORDER BY number`,
    [examId],
  );

  let autoScore = 0;
  let autoGradable = 0;
  let autoGradableScore = 0;
  let correctCount = 0;
  let answeredCount = 0;
  let manualCount = 0;
  const choiceText = (question, value) => {
    if (!value) return null;
    const choices = Array.isArray(question.choices) ? question.choices : [];
    const found = choices.find((choice) => String(choice.id) === String(value) || String(choice.label) === String(value));
    const raw = found?.text || found?.html || String(value);
    return String(raw).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  };
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
    if (!gradable && question.type !== 'multiple_choice') manualCount += 1;
    const correct = gradable && String(userAnswer) === String(correctChoice);
    if (gradable) {
      autoGradable += 1;
      autoGradableScore += Number(question.points || 0);
    }
    if (correct) {
      correctCount += 1;
      autoScore += Number(question.points || 0);
    }
    const scoreAwarded = correct ? Number(question.points || 0) : 0;
    return {
      question_id: question.id,
      number: question.number,
      points: question.points,
      type: question.type,
      user_answer: userAnswer || null,
      user_answer_text: choiceText(question, userAnswer),
      correct_answer: gradable ? correctChoice : null,
      correct_answer_text: gradable ? choiceText(question, correctChoice) : null,
      score_awarded: scoreAwarded,
      explanation: question.explanation || '',
      gradable,
      correct,
    };
  });

  return {
    summary: {
      answered_count: answeredCount,
      question_count: questionResult.rows.length,
      auto_gradable_count: autoGradable,
      auto_gradable_score: autoGradableScore,
      manual_count: manualCount,
      correct_count: correctCount,
      auto_score: autoScore,
      has_answer_key: autoGradable > 0,
    },
    items,
  };
}

function parseJsonArray(content) {
  const text = String(content || '').trim();
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : parsed.items || parsed.explanations || [];
  } catch (_error) {
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return [];
    try {
      const parsed = JSON.parse(match[0]);
      return Array.isArray(parsed) ? parsed : [];
    } catch (__error) {
      return [];
    }
  }
}

async function ensureAiExplanations(examId, gradedItems) {
  if (!process.env.OPENROUTER_API_KEY) return;

  const targetItems = gradedItems
    .filter((item) => item.gradable && item.user_answer && !String(item.explanation || '').trim())
    .slice(0, Number(process.env.AI_EXPLANATION_LIMIT || 80));
  if (!targetItems.length) return;

  const questionResult = await query(
    `SELECT id, number, prompt, passage, content_html, choices, answer, explanation
     FROM questions
     WHERE exam_id = $1 AND number = ANY($2::int[])
     ORDER BY number`,
    [examId, targetItems.map((item) => item.number)],
  );
  const itemByNumber = new Map(targetItems.map((item) => [item.number, item]));
  const missing = questionResult.rows.filter((question) => !String(question.explanation || '').trim());
  const chunks = [];
  for (let index = 0; index < missing.length; index += 12) chunks.push(missing.slice(index, index + 12));

  for (const chunk of chunks) {
    const payload = chunk.map((question) => {
      const item = itemByNumber.get(question.number);
      const choices = Array.isArray(question.choices) ? question.choices : [];
      return {
        number: question.number,
        prompt: stripHtml(question.prompt),
        passage: stripHtml(question.passage || question.content_html).slice(0, 900),
        choices: choices.map((choice) => ({
          id: choice.id,
          text: stripHtml(choice.text || choice.html),
        })),
        correct_answer: item?.correct_answer_text || item?.correct_answer,
      };
    });

    try {
      const response = await askOpenRouter([
        {
          role: 'system',
          content:
            'Bạn là giáo viên luyện thi TOPIK cho người Việt. Tạo lời giải ngắn, đúng trọng tâm, giải thích tại sao đáp án đúng. Không nhắc tới lựa chọn của học viên. Không bịa transcript/audio hoặc nội dung không có trong dữ liệu. Nếu thiếu passage/transcript, nói rõ "Theo đáp án chính thức" rồi giải thích ý của đáp án đúng dựa trên choices. Trả về JSON array, mỗi phần tử có number và explanation.',
        },
        {
          role: 'user',
          content: `Tạo lời giải tiếng Việt cho các câu sau. Mỗi explanation tối đa 2 câu.\n${JSON.stringify(payload)}`,
        },
      ], { temperature: 0.15, max_tokens: 2200 });
      const explanations = parseJsonArray(response.content);
      for (const entry of explanations) {
        const number = Number(entry.number);
        const explanation = String(entry.explanation || '').replace(/\s+/g, ' ').trim();
        const question = chunk.find((row) => row.number === number);
        if (!question || explanation.length < 8) continue;
        await query(
          `UPDATE questions
           SET explanation = $1
           WHERE id = $2 AND COALESCE(NULLIF(explanation, ''), '') = ''`,
          [explanation.slice(0, 1200), question.id],
        );
      }
    } catch (error) {
      console.warn(`[ai-explanation] failed: ${error.message}`);
      return;
    }
  }
}

app.patch('/api/attempts/:id', requireAuth, async (req, res) => {
  const answers = req.body.answers || {};
  const status = req.body.status || null;
  const existingResult = await query(
    `SELECT a.*, e.total_score
     FROM attempts a
     JOIN exams e ON e.id = a.exam_id
     WHERE a.id = $1 AND a.user_id = $2`,
    [req.params.id, req.user.id],
  );
  const existingAttempt = existingResult.rows[0];
  if (!existingAttempt) return res.status(404).json({ error: 'Attempt not found' });

  const graded = status === 'submitted' ? await gradeAttempt(existingAttempt.exam_id, answers) : null;
  const result = await query(
    `UPDATE attempts
     SET answers = $1,
         status = COALESCE($2, status),
         score = CASE WHEN $2 = 'submitted' THEN $3 ELSE score END,
         submitted_at = CASE WHEN $2 = 'submitted' THEN now() ELSE submitted_at END
     WHERE id = $4 AND user_id = $5
     RETURNING *`,
    [JSON.stringify(answers), status, graded?.summary.auto_score ?? null, req.params.id, req.user.id],
  );
  res.json({ attempt: result.rows[0], summary: graded?.summary || null });
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

  const answers = attempt.answers || {};
  const graded = await gradeAttempt(attempt.exam_id, answers);
  await ensureAiExplanations(attempt.exam_id, graded.items);
  const enriched = await gradeAttempt(attempt.exam_id, answers);

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
      ...enriched.summary,
      total_score: attempt.total_score,
    },
    items: enriched.items,
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
