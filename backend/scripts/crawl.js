import 'dotenv/config';
import { crawlSource } from '../src/crawler.js';
import { pool } from '../src/db.js';
import { migrate } from '../src/migrations.js';

const sourceUrl = process.argv[2];
const useAi = process.argv.includes('--ai');

if (!sourceUrl) {
  console.error('Usage: npm run crawl -- <source-url> [--ai]');
  process.exit(1);
}

try {
  await migrate();
  const result = await crawlSource(sourceUrl, { ai: useAi });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await pool.end();
}
