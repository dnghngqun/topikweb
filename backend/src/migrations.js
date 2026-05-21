import { query } from './db.js';

export async function migrate() {
  await query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
  await query(`
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
    )
  `);

  await query(`ALTER TABLE questions ADD COLUMN IF NOT EXISTS content_html TEXT`);
  await query(`ALTER TABLE questions ADD COLUMN IF NOT EXISTS audio_url TEXT`);
  await query(`ALTER TABLE questions ADD COLUMN IF NOT EXISTS source_url TEXT`);
  await query(`ALTER TABLE questions ADD COLUMN IF NOT EXISTS media JSONB DEFAULT '{}'::jsonb`);
  await query(`ALTER TABLE exams ADD COLUMN IF NOT EXISTS imported_from TEXT`);
  await query(`ALTER TABLE crawl_jobs ADD COLUMN IF NOT EXISTS source_id UUID REFERENCES crawl_sources(id) ON DELETE SET NULL`);
}
