CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  firebase_uid TEXT UNIQUE,
  email TEXT UNIQUE NOT NULL,
  display_name TEXT,
  photo_url TEXT,
  provider TEXT DEFAULT 'firebase',
  role TEXT DEFAULT 'student',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS exams (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  slug TEXT UNIQUE NOT NULL,
  topik_level TEXT NOT NULL CHECK (topik_level IN ('I', 'II')),
  round_no INTEGER NOT NULL,
  title_ko TEXT NOT NULL,
  title_en TEXT,
  subject TEXT,
  question_count INTEGER NOT NULL,
  total_score INTEGER NOT NULL,
  duration_minutes INTEGER NOT NULL,
  source_url TEXT,
  audio_url TEXT,
  imported_from TEXT,
  status TEXT DEFAULT 'published',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS exam_sections (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  exam_id UUID NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  section_key TEXT NOT NULL,
  title TEXT NOT NULL,
  question_start INTEGER NOT NULL,
  question_end INTEGER NOT NULL,
  score INTEGER NOT NULL,
  duration_minutes INTEGER NOT NULL,
  sort_order INTEGER NOT NULL,
  UNIQUE (exam_id, section_key)
);

CREATE TABLE IF NOT EXISTS questions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  exam_id UUID NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  section_id UUID REFERENCES exam_sections(id) ON DELETE SET NULL,
  number INTEGER NOT NULL,
  points INTEGER DEFAULT 2,
  prompt TEXT,
  passage TEXT,
  image_url TEXT,
  content_html TEXT,
  audio_url TEXT,
  type TEXT NOT NULL DEFAULT 'multiple_choice',
  choices JSONB DEFAULT '[]'::jsonb,
  answer JSONB,
  explanation TEXT,
  source_url TEXT,
  media JSONB DEFAULT '{}'::jsonb,
  sort_order INTEGER NOT NULL DEFAULT 0,
  UNIQUE (exam_id, number)
);

CREATE TABLE IF NOT EXISTS attempts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  exam_id UUID NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  answers JSONB DEFAULT '{}'::jsonb,
  score INTEGER,
  status TEXT DEFAULT 'in_progress',
  started_at TIMESTAMPTZ DEFAULT now(),
  submitted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS crawl_jobs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  source_id UUID,
  source_url TEXT NOT NULL,
  status TEXT DEFAULT 'queued',
  result JSONB DEFAULT '{}'::jsonb,
  error TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  finished_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS crawl_sources (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  url TEXT UNIQUE NOT NULL,
  kind TEXT DEFAULT 'auto',
  enabled BOOLEAN DEFAULT true,
  last_status TEXT,
  last_error TEXT,
  last_run_at TIMESTAMPTZ,
  next_run_at TIMESTAMPTZ,
  discovered_count INTEGER DEFAULT 0,
  imported_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

INSERT INTO exams (slug, topik_level, round_no, title_ko, title_en, subject, question_count, total_score, duration_minutes, source_url, audio_url)
VALUES
  ('topik-ii-102', 'II', 102, '제102회 한국어능력시험', 'The 102th Test of Proficiency in Korean', 'B (홀수형)', 104, 300, 180, 'https://www.topik.go.kr', ''),
  ('topik-i-102', 'I', 102, '제102회 한국어능력시험', 'The 102th Test of Proficiency in Korean', 'A (홀수형)', 70, 200, 100, 'https://www.topik.go.kr', ''),
  ('topik-ii-96', 'II', 96, '제96회 한국어능력시험', 'The 96th Test of Proficiency in Korean', 'B (홀수형)', 104, 300, 180, 'https://www.topik.go.kr', ''),
  ('topik-ii-91', 'II', 91, '제91회 한국어능력시험', 'The 91st Test of Proficiency in Korean', 'B (홀수형)', 104, 300, 180, 'https://www.topik.go.kr', ''),
  ('topik-ii-83', 'II', 83, '제83회 한국어능력시험', 'The 83rd Test of Proficiency in Korean', 'B (홀수형)', 104, 300, 180, 'https://www.topik.go.kr', ''),
  ('topik-ii-64', 'II', 64, '제64회 한국어능력시험', 'The 64th Test of Proficiency in Korean', 'B (홀수형)', 104, 300, 180, 'https://www.topik.go.kr', ''),
  ('topik-ii-60', 'II', 60, '제60회 한국어능력시험', 'The 60th Test of Proficiency in Korean', 'B (홀수형)', 104, 300, 180, 'https://www.topik.go.kr', '')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO exam_sections (exam_id, section_key, title, question_start, question_end, score, duration_minutes, sort_order)
SELECT id, 'listening', '듣기 (Nghe)', 1, CASE WHEN topik_level = 'I' THEN 30 ELSE 50 END, 100, CASE WHEN topik_level = 'I' THEN 40 ELSE 60 END, 1 FROM exams
ON CONFLICT (exam_id, section_key) DO NOTHING;

INSERT INTO exam_sections (exam_id, section_key, title, question_start, question_end, score, duration_minutes, sort_order)
SELECT id, 'reading', '읽기 (Đọc)', CASE WHEN topik_level = 'I' THEN 31 ELSE 55 END, CASE WHEN topik_level = 'I' THEN 70 ELSE 104 END, 100, CASE WHEN topik_level = 'I' THEN 60 ELSE 70 END, CASE WHEN topik_level = 'I' THEN 2 ELSE 3 END FROM exams
ON CONFLICT (exam_id, section_key) DO NOTHING;

INSERT INTO exam_sections (exam_id, section_key, title, question_start, question_end, score, duration_minutes, sort_order)
SELECT id, 'writing', '쓰기 (Viết)', 51, 54, 100, 50, 2 FROM exams WHERE topik_level = 'II'
ON CONFLICT (exam_id, section_key) DO NOTHING;

WITH target AS (
  SELECT e.id exam_id, s.id section_id
  FROM exams e
  JOIN exam_sections s ON s.exam_id = e.id AND s.section_key = 'listening'
  WHERE e.slug = 'topik-ii-102'
)
INSERT INTO questions (exam_id, section_id, number, points, prompt, passage, image_url, type, choices, answer, explanation, sort_order)
SELECT exam_id, section_id, 1, 2, '다음을 듣고 가장 알맞은 그림 또는 그래프를 고르십시오.', '', '', 'multiple_choice',
  '[{"id":"1","text":"①"},{"id":"2","text":"②"},{"id":"3","text":"③"},{"id":"4","text":"④"}]'::jsonb,
  '{"choice":"2"}'::jsonb, 'Audio và hình gốc sẽ được crawler thay thế khi nhập đề thật.', 1
FROM target
ON CONFLICT (exam_id, number) DO NOTHING;

WITH target AS (
  SELECT e.id exam_id, s.id section_id
  FROM exams e
  JOIN exam_sections s ON s.exam_id = e.id AND s.section_key = 'writing'
  WHERE e.slug = 'topik-ii-102'
)
INSERT INTO questions (exam_id, section_id, number, points, prompt, passage, image_url, type, choices, answer, explanation, sort_order)
SELECT exam_id, section_id, 51, 10, '[51~52] 다음 글의 ㉠과 ㉡에 알맞은 말을 각각 쓰십시오.',
  '[Email - 제목: 개인 물건 정리 요청 - 2025.10.10.(금)]
안녕하세요. 동아리 회장 흥연입니다.
학생회관 공사 때문에 동아리 방을 옮기게 되었습니다.
그런데 현재 개인 물건들이 너무 많습니다.
동아리 방을 옮기려면 이 물건들부터 먼저 (㉠).
방학을 하자마자 공사가 시작됩니다.
방학이 (㉡) 개인 물건을 모두 가져가 주십시오.',
  '', 'short_answer', '[]'::jsonb, '{"sample":["정리해야 합니다","되기 전에"]}'::jsonb, 'Phần viết không tự chấm; đáp án mẫu hiện ở trang kết quả.', 51
FROM target
ON CONFLICT (exam_id, number) DO NOTHING;

WITH target AS (
  SELECT e.id exam_id, s.id section_id
  FROM exams e
  JOIN exam_sections s ON s.exam_id = e.id AND s.section_key = 'writing'
  WHERE e.slug = 'topik-ii-102'
)
INSERT INTO questions (exam_id, section_id, number, points, prompt, passage, image_url, type, choices, answer, explanation, sort_order)
SELECT exam_id, section_id, 53, 30, '다음을 한국 캠핑 인구의 변화에 대한 자료이다. 이 내용을 200~300자의 글로 쓰십시오. 단, 글의 제목은 쓰지 마십시오.',
  '조사 기관: 한국관광공사
캠핑 인구 변화: 2019년 340만 -> 2024년 650만 (약 2배)
연령별 순위 변화:
2019년: 1위 20대~30대, 2위 40대~50대
2024년: 1위 40대~50대, 2위 20대~30대
원인:
• 장비의 고급화와 캠핑장 대여료 증가 -> 경제력이 요구됨
• 자녀와의 여가 활동을 위한 가족 단위 캠핑 증가',
  '', 'essay', '[]'::jsonb, '{"sample":"한국 캠핑 인구는 최근 크게 증가하였다..."}'::jsonb, 'Viết 200-300 ký tự, không tự chấm.', 53
FROM target
ON CONFLICT (exam_id, number) DO NOTHING;

WITH target AS (
  SELECT e.id exam_id, s.id section_id
  FROM exams e
  JOIN exam_sections s ON s.exam_id = e.id AND s.section_key = 'reading'
  WHERE e.slug = 'topik-ii-102'
)
INSERT INTO questions (exam_id, section_id, number, points, prompt, passage, image_url, type, choices, answer, explanation, sort_order)
SELECT exam_id, section_id, 58, 2, '밑줄 친 부분과 의미가 가장 비슷한 것을 고르십시오.',
  '전문가들이 예상한 대로 농산물 가격이 떨어지고 있다.', '', 'multiple_choice',
  '[{"id":"1","text":"예상한 탓에"},{"id":"2","text":"예상하는 동안에"},{"id":"3","text":"예상하기만 하면"},{"id":"4","text":"예상한 것과 같이"}]'::jsonb,
  '{"choice":"4"}'::jsonb, '대로 = như, theo như.', 58
FROM target
ON CONFLICT (exam_id, number) DO NOTHING;
