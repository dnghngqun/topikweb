import axios from 'axios';
import { query } from './db.js';
import { crawlSource, discoverTopikLinks, isImportableExamSource } from './crawler.js';

function skipDetail(result) {
  const files = (result?.files || result?.assets?.files || [])
    .map((file) => `${file.name}${file.textKind ? `:${file.textKind}` : ''}`)
    .slice(0, 12)
    .join(' | ');
  const answers = (result?.assets?.answers || []).map((file) => file.name).join(' | ');
  const exams = (result?.assets?.usableExamPdfs || []).map((file) => file.name).join(' | ');
  const audio = (result?.assets?.audio || []).map((file) => file.name).join(' | ');
  return [result?.reason, files && `files=${files}`, answers && `answers=${answers}`, exams && `exams=${exams}`, audio && `audio=${audio}`]
    .filter(Boolean)
    .join(' ; ');
}

const DEFAULT_SOURCES = [
  'https://dethitracnghiem.vn/bai-thi/de-thi-topik-1-de-1/',
  'https://dethitracnghiem.vn/de-thi-topik/',
  'https://dethitracnghiem.vn/de-thi-topik-1/',
  'https://dethitracnghiem.vn/de-thi-topik-2/',
  'https://prepedu.com/vi/blog/de-thi-topik-1',
  'https://prepedu.com/vi/blog/de-thi-topik-2',
  'https://onthitopik.com/tai-tron-bo-de-thi-topik-va-dap-an/',
  'https://study4.com/tests/?term=topik&page=1',
  'https://study4.com/tests/topik-i/',
  'https://study4.com/tests/topik-ii/',
  'https://www.thongtinduhochanquoc.com/tron-bo-de-thi-topik-i-topik-ii-tieng-han-ki-52-co-dap-an/',
  'https://koreanlearners.com/topik-past-papers.html',
  'https://www.topikguide.com/previous-papers/',
  'https://www.koreantopik.com/2018/07/download-topik-tests-pdf-audio-answer.html',
  'https://www.topik.go.kr/TWSTDY/TWSTDY0080.do',
  'https://www.studytopik.go.kr/sub-1/link_url.asp?ma_url=sub_1',
];

async function ensureSources() {
  await query("UPDATE crawl_sources SET enabled = false, last_status = 'disabled', last_error = '404 sitemap removed from default crawler' WHERE url LIKE '%/sitemap-file.xml'");
  await query("UPDATE crawl_sources SET enabled = false, last_status = 'disabled', last_error = 'Search pages are not used by the crawler; TOPIK index pages replace them' WHERE url LIKE '%?s=%'");
  await query("UPDATE crawl_sources SET enabled = false, last_status = 'disabled', last_error = 'Generated dethi source returned 404 and is no longer retried' WHERE url ~ '/de-thi-topik-[12]-de-([4-9]|1[0-2])/' AND COALESCE(last_error, '') ILIKE '%404%'");
  const configured = (process.env.CRAWL_SOURCES || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const sources = configured.length ? configured : DEFAULT_SOURCES;
  for (const url of sources) {
    await query(
      `INSERT INTO crawl_sources (url, kind, enabled, next_run_at)
       VALUES ($1, $2, true, now())
       ON CONFLICT (url) DO NOTHING`,
      [url, isImportableExamSource(url) ? 'exam' : 'index'],
    );
  }
}

async function fetchHtml(url) {
  const response = await axios.get(url, {
    timeout: 45000,
    headers: { 'User-Agent': 'TopikWebCodex daily crawler' },
  });
  return response.data;
}

export async function runDueCrawls({ force = false } = {}) {
  await ensureSources();
  console.log(`[crawler] checking due sources force=${force}`);
  const due = await query(
    `SELECT * FROM crawl_sources
     WHERE enabled = true AND ($1::boolean OR next_run_at IS NULL OR next_run_at <= now())
     ORDER BY created_at
     LIMIT 80`,
    [force],
  );
  console.log(`[crawler] due sources=${due.rowCount}`);

  const summary = [];
  for (const source of due.rows) {
    let discovered = [];
    let imported = 0;
    try {
      console.log(`[crawler] start ${source.kind || 'auto'} ${source.url}`);
      const html = await fetchHtml(source.url);
      discovered = discoverTopikLinks(source.url, html);
      console.log(`[crawler] discovered ${discovered.length} links from ${source.url}`);
      for (const link of discovered) {
        await query(
          `INSERT INTO crawl_sources (url, kind, enabled, next_run_at)
           VALUES ($1, 'exam', true, now())
           ON CONFLICT (url) DO NOTHING`,
          [link],
        );
      }

      const shouldImportSelf = isImportableExamSource(source.url);
      if (shouldImportSelf) {
        const result = await crawlSource(source.url);
        if (result?.skipped) {
          console.log(`[crawler] skipped self ${source.url}: ${skipDetail(result)}`);
        } else {
          imported += result?.multi ? result.imported.length : 1;
          console.log(`[crawler] imported self ${source.url}`);
        }
      } else if (/koreanlearners\.com|topikguide\.com|koreantopik\.com/i.test(source.url)) {
        const result = await crawlSource(source.url);
        if (result?.skipped) {
          console.log(`[crawler] skipped direct index ${source.url}: ${skipDetail(result)}`);
        } else {
          imported += result?.multi ? result.imported.length : 1;
          console.log(`[crawler] imported direct index ${source.url}: ${result?.multi ? result.imported.length : 1}`);
        }
      } else if (process.env.CRAWL_IMPORT_DISCOVERED !== 'false') {
        const importLimit = Number(process.env.CRAWL_IMPORT_DISCOVERED_LIMIT || 30);
        for (const link of discovered.filter((item) => isImportableExamSource(item)).slice(0, importLimit)) {
          try {
            const result = await crawlSource(link);
            if (result?.skipped) {
              console.log(`[crawler] skipped discovered ${link}: ${skipDetail(result)}`);
            } else {
              imported++;
              console.log(`[crawler] imported discovered ${link}`);
            }
          } catch (error) {
            console.warn(`[crawler] failed discovered ${link}: ${error.message}`);
            await query(
              `UPDATE crawl_sources
               SET last_status = 'failed', last_error = $1, last_run_at = now(),
                   next_run_at = now() + '12 hours'::interval
               WHERE url = $2`,
              [error.message, link],
            );
          }
        }
      }

      await query(
        `UPDATE crawl_sources
         SET last_status = 'ok', last_error = NULL, last_run_at = now(),
             next_run_at = now() + ($1 || ' hours')::interval,
             discovered_count = $2, imported_count = imported_count + $3
         WHERE id = $4`,
        [Number(process.env.CRAWL_INTERVAL_HOURS || 24), discovered.length, imported, source.id],
      );
      console.log(`[crawler] ok ${source.url} discovered=${discovered.length} imported=${imported}`);
      summary.push({ url: source.url, status: 'ok', discovered: discovered.length, imported });
    } catch (error) {
      console.warn(`[crawler] failed ${source.url}: ${error.message}`);
      await query(
        `UPDATE crawl_sources
         SET last_status = 'failed', last_error = $1, last_run_at = now(),
             next_run_at = now() + '6 hours'::interval
         WHERE id = $2`,
        [error.message, source.id],
      );
      summary.push({ url: source.url, status: 'failed', error: error.message });
    }
  }
  return summary;
}

export function startCrawlerScheduler() {
  if (process.env.CRAWLER_ENABLED === 'false') {
    console.log('[crawler] disabled by CRAWLER_ENABLED=false');
    return;
  }
  const intervalMinutes = Number(process.env.CRAWLER_TICK_MINUTES || 60);
  const forceOnStart = process.env.CRAWL_ON_START_FORCE !== 'false';
  console.log(`[crawler] scheduler enabled tick=${intervalMinutes}m forceOnStart=${forceOnStart}`);
  runDueCrawls({ force: forceOnStart }).catch((error) => console.error('Initial crawler failed:', error.message));
  setInterval(() => {
    runDueCrawls().catch((error) => console.error('Scheduled crawler failed:', error.message));
  }, intervalMinutes * 60 * 1000);
}
