import axios from 'axios';
import * as cheerio from 'cheerio';
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { withClient } from './db.js';
import { askOpenRouter } from './openrouter.js';

const execFileAsync = promisify(execFile);
const STORAGE_ROOT = process.env.CRAWLER_STORAGE_DIR || path.resolve(process.cwd(), 'storage');
const MEDIA_BASE_URL = (process.env.PUBLIC_BACKEND_URL || '').replace(/\/+$/, '');
const CIRCLED_TO_CHOICE = { '①': '1', '②': '2', '③': '3', '④': '4' };
const CHOICE_LABELS = ['①', '②', '③', '④'];
const PDF_RENDER_DPI = 120;
const PDF_POINT_SCALE = PDF_RENDER_DPI / 72;

function absoluteUrl(base, href) {
  try {
    return new URL(href, base).toString();
  } catch (_error) {
    return href;
  }
}

function normalizeDiscoveredUrl(href) {
  try {
    const parsed = new URL(href);
    parsed.hash = '';
    if (!/drive\.google\.com/i.test(parsed.hostname)) parsed.search = '';
    return parsed.toString();
  } catch (_error) {
    return href;
  }
}

function inferMeta(sourceUrl, html, title) {
  const text = `${title || ''} ${html.slice(0, 5000)}`;
  const level = /TOPIK\s*(?:1|I(?!I))|토픽\s*(?:1|I(?!I))/i.test(text) && !/TOPIK\s*(?:2|II)|토픽\s*(?:2|II)/i.test(text) ? 'I' : 'II';
  const roundMatch = text.match(/(?:제\s*)?(\d{2,3})\s*(?:회|th|st|nd|rd)/i);
  const roundNo = roundMatch ? Number(roundMatch[1]) : Math.floor(Date.now() / 100000000);
  return {
    slug: inferSlug(sourceUrl, level, roundNo),
    topik_level: level,
    round_no: roundNo,
    title_ko: `제${roundNo}회 한국어능력시험`,
    title_en: `The ${roundNo}th Test of Proficiency in Korean`,
    subject: level === 'I' ? 'A (홀수형)' : 'B (홀수형)',
    question_count: level === 'I' ? 70 : 104,
    total_score: level === 'I' ? 200 : 300,
    duration_minutes: level === 'I' ? 100 : 180,
    source_url: sourceUrl,
  };
}

function inferSlug(sourceUrl, level, roundNo) {
  try {
    const pathname = new URL(sourceUrl).pathname.replace(/^\/+|\/+$/g, '');
    const last = pathname.split('/').filter(Boolean).pop();
    if (last) return last.toLowerCase();
  } catch (_error) {
    // Use fallback below.
  }
  return `topik-${level.toLowerCase()}-${roundNo}`;
}

function inferMetaFromName(sourceUrl, name, importedFrom = null) {
  const text = `${sourceUrl} ${name || ''}`;
  const roundMatch =
    text.match(/(?:제\s*)?(\d{2,3})\s*회/i) ||
    text.match(/(?:Ky|Kỳ|Ki|Kì|회|TOPIK\s*[ⅠI12]*\s*Ky)\s*[-_ ]*(\d{2,3})/i) ||
    text.match(/(\d{2,3})(?:th|st|nd|rd)\s+TOPIK/i) ||
    text.match(/TOPIK\s*[ⅠI12]*\s*(\d{2,3})/i);
  const roundNo = roundMatch ? Number(roundMatch[1]) : Math.floor(Date.now() / 100000000);
  const level = /TOPIK\s*(?:1|I(?!I))|TOPIK1|토픽\s*(?:1|I(?!I))/i.test(text) && !/TOPIK\s*(?:2|II)|TOPIK2|토픽\s*(?:2|II)/i.test(text) ? 'I' : 'II';
  return {
    slug: `topik-${level.toLowerCase()}-${roundNo}-${crypto.createHash('sha1').update(sourceUrl).digest('hex').slice(0, 8)}`,
    topik_level: level,
    round_no: roundNo,
    title_ko: `제${roundNo}회 한국어능력시험`,
    title_en: `The ${roundNo}th Test of Proficiency in Korean`,
    subject: level === 'I' ? 'A (홀수형)' : 'B (홀수형)',
    question_count: level === 'I' ? 70 : 104,
    total_score: level === 'I' ? 200 : 300,
    duration_minutes: level === 'I' ? 100 : 180,
    source_url: sourceUrl,
    imported_from: importedFrom,
  };
}

function extractAssets(sourceUrl, html) {
  const $ = cheerio.load(html);
  const links = [];
  $('a[href], audio[src], source[src], img[src]').each((_, element) => {
    const raw = $(element).attr('href') || $(element).attr('src');
    if (!raw) return;
    const url = absoluteUrl(sourceUrl, raw);
    const label = ($(element).text() || $(element).attr('alt') || '').trim();
    links.push({ url, label });
  });

  return {
    audio: links.find((item) => /\.(mp3|wav|m4a|ogg)(\?|$)/i.test(item.url))?.url || '',
    pdfs: links.filter((item) => /\.pdf(\?|$)/i.test(item.url)),
    images: links.filter((item) => /\.(png|jpe?g|webp)(\?|$)/i.test(item.url)),
  };
}

function isAnswerKeyName(name) {
  return /정답|답안|dap[\s_-]*an|đáp[\s_-]*án|answer/i.test(name || '');
}

function isExamPdfName(name) {
  const normalized = String(name || '');
  return /\.pdf$/i.test(normalized) && !isAnswerKeyName(normalized) && /TOPIK|토픽|듣기|읽기|쓰기|기출/i.test(normalized);
}

function driveDownloadUrl(id) {
  return `https://drive.google.com/uc?export=download&id=${encodeURIComponent(id)}`;
}

function parseGoogleDriveFiles(html) {
  const match = html.match(/window\['_DRIVE_ivd'\]\s*=\s*'([\s\S]*?)';/);
  if (!match) return [];
  try {
    const decoded = match[1]
      .replace(/\\x([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/\\u003d/g, '=')
      .replace(/\\=/g, '=')
      .replace(/\\\//g, '/');
    const data = JSON.parse(decoded);
    return (data[0] || [])
      .map((file) => ({
        id: file[0],
        name: file[2],
        mime: file[3],
        size: file[13] || 0,
        url: driveDownloadUrl(file[0]),
      }))
      .filter((file) => file.id && file.name && file.mime);
  } catch (error) {
    console.warn(`[crawler] could not parse Google Drive metadata: ${error.message}`);
    return [];
  }
}

function classifyAssetFiles(files) {
  const pdfs = files.filter((file) => /pdf/i.test(file.mime) || /\.pdf$/i.test(file.name));
  const audio = files.filter((file) => /^audio\//i.test(file.mime) || /\.(mp3|wav|m4a|ogg)$/i.test(file.name));
  const answers = pdfs.filter((file) => isAnswerKeyName(file.name));
  const exams = pdfs.filter((file) => isExamPdfName(file.name));
  const combinedExam = exams.find((file) => /(?:듣기|nghe|listening).*(?:읽기|đọc|doc|reading)|(?:읽기|đọc|doc|reading).*(?:듣기|nghe|listening)|기출/i.test(file.name));
  const usableExamPdfs = combinedExam
    ? [combinedExam]
    : exams
        .filter((file) => !/통합|transcript|script|file\s*nghe|mp3|audio/i.test(file.name))
        .sort((a, b) => {
          const rank = (file) => {
            if (/듣기|nghe|listening/i.test(file.name)) return 1;
            if (/쓰기|viet|viết|writing/i.test(file.name)) return 2;
            if (/읽기|doc|đọc|reading/i.test(file.name)) return 3;
            if (/_1(?:\D*)\.pdf$/i.test(file.name)) return 1;
            if (/_2(?:\D*)\.pdf$/i.test(file.name)) return 3;
            return 9;
          };
          return rank(a) - rank(b) || a.name.localeCompare(b.name);
        });
  const primaryExam = usableExamPdfs[0] || exams[0];
  return { pdfs, audio, answers, exams, primaryExam, usableExamPdfs };
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

function storageUrl(filePath) {
  const relative = path.relative(STORAGE_ROOT, filePath).split(path.sep).join('/');
  return `${MEDIA_BASE_URL}/media/${relative}`;
}

function safeFilePart(value) {
  return String(value || 'asset')
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120) || 'asset';
}

async function downloadFile(url, destination) {
  await ensureDir(path.dirname(destination));
  try {
    await fs.access(destination);
    return destination;
  } catch (_error) {
    // Download below.
  }
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 120000,
    maxContentLength: 150 * 1024 * 1024,
    headers: { 'User-Agent': 'TopikWebCodex crawler (+local study app)' },
  });
  await fs.writeFile(destination, Buffer.from(response.data));
  return destination;
}

async function commandText(command, args) {
  const { stdout } = await execFileAsync(command, args, { maxBuffer: 80 * 1024 * 1024 });
  return stdout;
}

async function pdfPageCount(pdfPath) {
  const info = await commandText('pdfinfo', [pdfPath]);
  return Number((info.match(/Pages:\s+(\d+)/) || [])[1]) || 0;
}

async function pdfText(pdfPath) {
  return commandText('pdftotext', [pdfPath, '-']);
}

function decodeHtmlText(text) {
  return String(text || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

async function pdfBboxPages(pdfPath) {
  const html = await commandText('pdftotext', ['-bbox', pdfPath, '-']);
  const $ = cheerio.load(html, { xmlMode: true });
  const pages = [];
  $('page').each((_, page) => {
    const pageNode = $(page);
    const words = [];
    pageNode.find('word').each((__, word) => {
      const wordNode = $(word);
      words.push({
        text: decodeHtmlText(wordNode.text()),
        xMin: Number(wordNode.attr('xMin')),
        yMin: Number(wordNode.attr('yMin')),
        xMax: Number(wordNode.attr('xMax')),
        yMax: Number(wordNode.attr('yMax')),
      });
    });
    pages.push({
      width: Number(pageNode.attr('width')) || 595,
      height: Number(pageNode.attr('height')) || 842,
      words,
    });
  });
  return pages;
}

function parseAnswerKeysFromText(text, { level, sectionHint }) {
  const sourceText = String(text || '');
  const firstScoreLabel = sourceText.indexOf('배점');
  const tableStart = firstScoreLabel >= 0 ? firstScoreLabel + 2 : 0;
  const tableText = sourceText.slice(tableStart);
  const rawTokens = tableText
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
  const tokens = rawTokens.filter((token) => /^\d{1,3}$/.test(token) || /^[①②③④]$/.test(token));
  const answers = new Map();

  const isChoice = (token) => Boolean(CIRCLED_TO_CHOICE[token] || /^[1-4]$/.test(token));
  const isScore = (token) => /^\d{1,3}$/.test(token);
  const firstRow = tokens.findIndex((token, index) => Number(token) > 0 && isChoice(tokens[index + 1]) && isScore(tokens[index + 2]));
  if (firstRow < 0) return answers;

  const addAnswer = (numberToken, answerToken, scoreToken) => {
    const number = Number(numberToken);
    if (!number || number > 120) return;
    const choice = CIRCLED_TO_CHOICE[answerToken] || (/^[1-4]$/.test(answerToken) ? answerToken : '');
    if (!choice) return;
    const points = Number(scoreToken) || 0;
    let questionNumber = number;
    if (/reading/i.test(sectionHint || '') || /읽기/.test(text)) {
      if (level === 'I' && number <= 40) questionNumber = number + 30;
      if (level === 'II' && number <= 50) questionNumber = number + 54;
    }
    answers.set(questionNumber, { choice, points });
  };

  for (let index = firstRow; index < tokens.length - 2; index += 6) {
    if (Number(tokens[index]) && isChoice(tokens[index + 1]) && isScore(tokens[index + 2])) {
      addAnswer(tokens[index], tokens[index + 1], tokens[index + 2]);
    }
    if (Number(tokens[index + 3]) && isChoice(tokens[index + 4]) && isScore(tokens[index + 5])) {
      addAnswer(tokens[index + 3], tokens[index + 4], tokens[index + 5]);
    }
  }
  return answers;
}

async function parseAnswerKeyFiles(answerFiles, workDir, meta) {
  const answers = new Map();
  for (const file of answerFiles) {
    const local = await downloadFile(file.url, path.join(workDir, `${safeFilePart(file.id)}-${safeFilePart(file.name)}`));
    const text = await pdfText(local);
    const sectionHint = /읽기|reading/i.test(file.name) ? 'reading' : /듣기|listening/i.test(file.name) ? 'listening' : '';
    const parsed = parseAnswerKeysFromText(text, { level: meta.topik_level, sectionHint });
    parsed.forEach((answer, number) => answers.set(number, answer));
  }
  return answers;
}

async function renderPdfPages(pdfPath, imageDir, slug, prefix = 'page') {
  await ensureDir(imageDir);
  const marker = path.join(imageDir, `.rendered-${prefix}`);
  const markerValue = `${pdfPath}\n`;
  const pattern = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d+\\.png$`);
  let shouldRender = false;
  try {
    const existingMarker = await fs.readFile(marker, 'utf8');
    shouldRender = existingMarker !== markerValue;
  } catch (_error) {
    shouldRender = true;
  }
  if (shouldRender) {
    const existingFiles = await fs.readdir(imageDir).catch(() => []);
    await Promise.all(existingFiles.filter((file) => pattern.test(file)).map((file) => fs.unlink(path.join(imageDir, file))));
    await execFileAsync('pdftoppm', ['-png', '-r', '120', pdfPath, path.join(imageDir, prefix)], {
      maxBuffer: 20 * 1024 * 1024,
    });
    await fs.writeFile(marker, markerValue);
  }
  const files = (await fs.readdir(imageDir))
    .filter((file) => pattern.test(file))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
  return files.map((file, index) => ({
    page: index + 1,
    url: storageUrl(path.join(imageDir, file)),
    path: path.join(imageDir, file),
    slug,
  }));
}

function sectionBounds(pdfPagesText, meta) {
  const findSectionStart = (sectionKey) => {
    const sectionKorean = sectionKey === 'listening' ? '듣기' : sectionKey === 'reading' ? '읽기' : '쓰기';
    return pdfPagesText.findIndex((pageText) => {
      const compact = pageText.replace(/\s+/g, ' ');
      const hasTopikSection = new RegExp(`TOPIK\\s*(?:Ⅰ|I|Ⅱ|II)?\\s*${sectionKorean}\\s*\\(`, 'i').test(compact);
      const hasQuestionRange = new RegExp(`\\d+\\s*번\\s*[～~\\-]\\s*\\d+\\s*번\\)?\\s*.*${sectionKorean}`, 'i').test(compact);
      return hasTopikSection || hasQuestionRange;
    });
  };
  const listeningStartIndex = findSectionStart('listening');
  const readingStartIndex = findSectionStart('reading');
  const writingStartIndex = findSectionStart('writing');
  const listeningStart = listeningStartIndex >= 0 ? listeningStartIndex : 0;
  const readingStart = readingStartIndex >= 0 ? readingStartIndex : listeningStart;
  const writingStart = writingStartIndex >= 0 ? writingStartIndex : listeningStart;
  return meta.topik_level === 'I'
    ? [
        { from: 1, to: 30, offset: 0, minPage: listeningStart, maxPage: readingStartIndex > 0 ? readingStartIndex : Infinity },
        { from: 31, to: 70, offset: 0, minPage: readingStart, maxPage: Infinity },
      ]
    : [
        { from: 1, to: 50, offset: 0, minPage: listeningStart, maxPage: writingStartIndex > 0 ? writingStartIndex : readingStartIndex > 0 ? readingStartIndex : Infinity },
        { from: 51, to: 54, offset: 0, minPage: writingStart, maxPage: readingStartIndex > 0 ? readingStartIndex : Infinity },
        { from: 55, to: 104, offset: -54, minPage: readingStart, maxPage: Infinity },
      ];
}

function mapQuestionPages(pdfPagesText, pageImages, meta) {
  const pageByQuestion = new Map();
  const sections = sectionBounds(pdfPagesText, meta);

  pdfPagesText.forEach((pageText, pageIndex) => {
    const compact = pageText.replace(/\s+/g, ' ');
    for (const section of sections) {
      if (pageIndex < section.minPage || pageIndex > section.maxPage) continue;
      for (let number = section.from; number <= section.to; number += 1) {
        const printed = number + section.offset;
        const pattern = new RegExp(`(^|[^0-9])${printed}\\s*[\\.)]`);
        if (!pageByQuestion.has(number) && pattern.test(compact)) {
          pageByQuestion.set(number, pageImages[pageIndex]?.url);
        }
      }
    }
  });

  const firstQuestionPage = Number.isFinite(sections[0]?.minPage) ? sections[0].minPage : 0;
  let lastUrl = pageImages[firstQuestionPage]?.url || pageImages.find((page) => page.page > 1)?.url || pageImages[0]?.url || '';
  for (let number = 1; number <= meta.question_count; number += 1) {
    if (pageByQuestion.has(number)) lastUrl = pageByQuestion.get(number);
    else pageByQuestion.set(number, lastUrl);
  }
  return pageByQuestion;
}

function isQuestionMarker(word, printedNumber) {
  const escaped = String(printedNumber).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped}(?:\\s*[.)]|$)`).test(word.text);
}

function hasChoiceMarkerAfter(page, word) {
  return page.words.some((candidate) => (
    candidate.yMin >= word.yMin - 3 &&
    candidate.yMin <= word.yMin + 320 &&
    CHOICE_LABELS.some((label) => candidate.text.includes(label))
  ));
}

function isInstructionPage(page) {
  const text = page.words.map((word) => word.text).join(' ');
  return /Information|Registration\s*No|Do\s+not\s+open|Write\s+your\s+name|유\s*의\s*사\s*항|수험번호/i.test(text);
}

function findQuestionMarkers(bboxPages, pdfPagesText, meta) {
  const sections = sectionBounds(pdfPagesText, meta);
  const markers = [];
  for (const section of sections) {
    for (let pageIndex = section.minPage; pageIndex < Math.min(bboxPages.length, section.maxPage + 1); pageIndex += 1) {
      const page = bboxPages[pageIndex];
      if (isInstructionPage(page)) continue;
      for (let number = section.from; number <= section.to; number += 1) {
        if (markers.some((marker) => marker.number === number)) continue;
        const printed = number + section.offset;
        const needsChoices = questionSection(meta, number) !== 'writing';
        const candidates = page.words.filter((word) => (
          isQuestionMarker(word, printed) &&
          word.xMin >= 40 &&
          word.xMin <= 110 &&
          word.yMin >= 60 &&
          word.yMin <= page.height - 35 &&
          (!needsChoices || hasChoiceMarkerAfter(page, word))
        ));
        if (candidates.length) {
          const chosen = candidates.sort((a, b) => a.yMin - b.yMin)[0];
          markers.push({ number, printed, pageIndex, word: chosen, section });
        }
      }
    }
  }
  return markers.sort((a, b) => a.pageIndex - b.pageIndex || a.word.yMin - b.word.yMin || a.number - b.number);
}

function wordsInBox(page, box) {
  return page.words.filter((word) => (
    word.xMax >= box.x &&
    word.xMin <= box.x + box.width &&
    word.yMax >= box.y &&
    word.yMin <= box.y + box.height
  ));
}

function instructionTopForQuestion(page, marker) {
  const instruction = page.words
    .filter((word) => word.text === '※' && word.yMin >= 90 && word.yMin < marker.word.yMin - 8)
    .sort((a, b) => b.yMin - a.yMin)[0];
  return instruction ? Math.max(65, instruction.yMin - 18) : Math.max(65, marker.word.yMin - 18);
}

function groupContextsForPage(page, pageMarkers) {
  return page.words
    .filter((word) => word.text === '※')
    .map((word) => {
      const lineWords = page.words
        .filter((candidate) => Math.abs(candidate.yMin - word.yMin) <= 8 && candidate.xMin >= word.xMin)
        .sort((a, b) => a.xMin - b.xMin);
      const lineText = lineWords.map((candidate) => candidate.text).join('');
      const range = lineText.match(/[［\[]\s*(\d{1,3})\s*[~～\-–]\s*(\d{1,3})\s*[］\]]/);
      if (!range) return null;
      const first = Number(range[1]);
      const last = Number(range[2]);
      if (!first || !last || first > last) return null;
      const rangeMarkers = pageMarkers.filter((marker) => marker.printed >= first && marker.printed <= last);
      const firstMarker = rangeMarkers[0];
      if (!firstMarker || firstMarker.word.yMin <= word.yMin) return null;
      const questionOffset = firstMarker.number - firstMarker.printed;
      return {
        first: first + questionOffset,
        last: last + questionOffset,
        pageIndex: firstMarker.pageIndex,
        top: Math.max(65, word.yMin - 18),
        bottom: Math.max(word.yMax + 6, firstMarker.word.yMin - 8),
      };
    })
    .filter(Boolean);
}

function parseChoiceText(blockWords) {
  const normalizedWords = blockWords.flatMap((word) => {
    const embeddedLabel = CHOICE_LABELS.find((label) => word.text.includes(label));
    if (!embeddedLabel || word.text === embeddedLabel) return [word];
    const labelIndex = word.text.indexOf(embeddedLabel);
    const before = word.text.slice(0, labelIndex).trim();
    const after = word.text.slice(labelIndex + embeddedLabel.length).trim();
    const markerWidth = Math.min(14, Math.max(10, word.xMax - word.xMin));
    const marker = {
      ...word,
      text: embeddedLabel,
      xMax: Math.min(word.xMax, word.xMin + markerWidth),
    };
    const parts = [marker];
    if (before) {
      parts.push({
        ...word,
        text: before,
        xMax: word.xMin,
      });
    }
    if (after) {
      parts.push({
        ...word,
        text: after,
        xMin: Math.min(word.xMax, marker.xMax + 2),
      });
    }
    return parts;
  });
  const markers = normalizedWords
    .flatMap((word) => {
      const exactIndex = CHOICE_LABELS.indexOf(word.text);
      if (exactIndex >= 0) return [{ ...word, text: CHOICE_LABELS[exactIndex] }];
      const embeddedIndex = CHOICE_LABELS.findIndex((label) => word.text.includes(label));
      if (embeddedIndex < 0) return [];
      return [{
        ...word,
        text: CHOICE_LABELS[embeddedIndex],
        xMin: Math.max(word.xMin, word.xMax - 14),
      }];
    })
    .sort((a, b) => a.yMin - b.yMin || a.xMin - b.xMin);
  const choices = [];
  for (const [index, label] of CHOICE_LABELS.entries()) {
    const marker = markers.find((item) => item.text === label);
    if (!marker) {
      choices.push({ id: String(index + 1), label: String(index + 1), text: label, html: label });
      continue;
    }
    const nextSameRow = markers.find((item) => (
      item.xMin > marker.xMin + 10 &&
      Math.abs(item.yMin - marker.yMin) <= 8
    ));
    const nextSameColumn = markers.find((item) => (
      item.yMin > marker.yMin + 3 &&
      Math.abs(item.xMin - marker.xMin) <= 35
    ));
    const columnRight = nextSameRow
      ? nextSameRow.xMin - 4
      : marker.xMin < 250
        ? 285
        : 530;
    const yEnd = nextSameColumn ? nextSameColumn.yMin - 2 : marker.yMin + 42;
    const text = normalizedWords
      .filter((word) => (
        word !== marker &&
        !CHOICE_LABELS.includes(word.text) &&
        word.xMin >= marker.xMax + 2 &&
        word.xMin <= columnRight &&
        word.yMin >= marker.yMin - 4 &&
        word.yMin <= yEnd
      ))
      .sort((a, b) => a.yMin - b.yMin || a.xMin - b.xMin)
      .map((word) => word.text)
      .join(' ')
      .replace(/\s+([,.?!])/g, '$1')
      .trim();
    const display = text ? `${label} ${text}` : label;
    choices.push({ id: String(index + 1), label: String(index + 1), text: display, html: display });
  }
  return choices;
}

async function cropQuestionImage(sourceImage, outputImage, page, box, options = {}) {
  await ensureDir(path.dirname(outputImage));
  const minWidth = options.minWidth ?? 80;
  const minHeight = options.minHeight ?? 80;
  const x = Math.max(0, Math.floor(box.x * PDF_POINT_SCALE));
  const y = Math.max(0, Math.floor(box.y * PDF_POINT_SCALE));
  const width = Math.max(minWidth, Math.ceil(box.width * PDF_POINT_SCALE));
  const height = Math.max(minHeight, Math.ceil(box.height * PDF_POINT_SCALE));
  await execFileAsync('convert', [sourceImage, '-crop', `${width}x${height}+${x}+${y}`, '+repage', outputImage], {
    maxBuffer: 20 * 1024 * 1024,
  });
  return outputImage;
}

async function buildQuestionLayouts(bboxPages, pdfPagesText, pageImages, cropDir, meta) {
  const layouts = new Map();
  const markers = findQuestionMarkers(bboxPages, pdfPagesText, meta);
  const markerByQuestion = new Map(markers.map((marker) => [marker.number, marker]));
  const defaultPageByQuestion = mapQuestionPages(pdfPagesText, pageImages, meta);
  const layoutVersion = Date.now().toString(36);
  const groupContexts = bboxPages.flatMap((page, pageIndex) => {
    const pageMarkers = markers
      .filter((item) => item.pageIndex === pageIndex)
      .sort((a, b) => a.word.yMin - b.word.yMin);
    return groupContextsForPage(page, pageMarkers);
  });
  const contextUrlByRange = new Map();

  for (let number = 1; number <= meta.question_count; number += 1) {
    const marker = markerByQuestion.get(number);
    if (!marker) {
      const fallbackUrl = defaultPageByQuestion.get(number) || '';
      layouts.set(number, { imageUrl: fallbackUrl, choices: null });
      continue;
    }
    const page = bboxPages[marker.pageIndex];
    const previousMarker = markers
      .filter((item) => item.pageIndex === marker.pageIndex && item.word.yMin < marker.word.yMin - 4)
      .sort((a, b) => b.word.yMin - a.word.yMin)[0];
    const pageMarkers = markers
      .filter((item) => item.pageIndex === marker.pageIndex)
      .sort((a, b) => a.word.yMin - b.word.yMin);
    const groupContext = groupContexts
      .find((context) => number >= context.first && number <= context.last);
    const nextMarker = markers
      .filter((item) => item.pageIndex === marker.pageIndex && item.word.yMin > marker.word.yMin + 4)
      .sort((a, b) => a.word.yMin - b.word.yMin)[0];
    const nextInstruction = page.words
      .filter((word) => word.text === '※' && word.yMin > marker.word.yMin + 8 && (!nextMarker || word.yMin < nextMarker.word.yMin))
      .sort((a, b) => a.yMin - b.yMin)[0];
    const groupedTop =
      groupContext && number === groupContext.first && marker.pageIndex === groupContext.pageIndex
        ? Math.max(groupContext.bottom + 3, marker.word.yMin - 8)
        : marker.word.yMin - 18;
    const top = groupContext ? Math.max(65, groupedTop) : previousMarker ? Math.max(65, marker.word.yMin - 18) : instructionTopForQuestion(page, marker);
    const naturalBottom = nextMarker ? nextMarker.word.yMin - 10 : page.height - 45;
    const bottom = nextInstruction ? Math.min(naturalBottom, nextInstruction.yMin - 10) : naturalBottom;
    const box = {
      x: 58,
      y: top,
      width: Math.min(500, page.width - 90),
      height: Math.min(page.height - top - 35, bottom - top),
    };
    const blockWords = wordsInBox(page, box);
    const answerWords = blockWords.filter((word) => word.yMin >= marker.word.yMin - 4);
    const cropPath = path.join(cropDir, `q-${String(number).padStart(3, '0')}.png`);
    await cropQuestionImage(pageImages[marker.pageIndex].path, cropPath, page, box);
    let contextUrl = '';
    if (groupContext) {
      const contextKey = `${groupContext.first}-${groupContext.last}`;
      contextUrl = contextUrlByRange.get(contextKey) || '';
      if (!contextUrl) {
        const contextPage = bboxPages[groupContext.pageIndex];
        const contextPath = path.join(cropDir, `ctx-${String(groupContext.first).padStart(3, '0')}-${String(groupContext.last).padStart(3, '0')}.png`);
        await cropQuestionImage(pageImages[groupContext.pageIndex].path, contextPath, contextPage, {
          x: 58,
          y: groupContext.top,
          width: Math.min(500, contextPage.width - 90),
          height: Math.min(contextPage.height - groupContext.top - 35, groupContext.bottom - groupContext.top),
        }, { minHeight: 24 });
        contextUrl = `${storageUrl(contextPath)}?v=${layoutVersion}`;
        contextUrlByRange.set(contextKey, contextUrl);
      }
    }
    layouts.set(number, {
      imageUrl: `${storageUrl(cropPath)}?v=${layoutVersion}`,
      contextUrl,
      choices: parseChoiceText(answerWords),
    });
  }
  return layouts;
}

function questionSection(meta, number) {
  if (meta.topik_level === 'I') return number <= 30 ? 'listening' : 'reading';
  if (number <= 50) return 'listening';
  if (number <= 54) return 'writing';
  return 'reading';
}

function defaultQuestionPoints(meta, number) {
  if (meta.topik_level === 'I') return number <= 30 ? (number <= 10 || number >= 13 && number <= 16 || number >= 26 ? 4 : 3) : 2;
  if (number >= 51 && number <= 54) return number <= 52 ? 10 : number === 53 ? 30 : 50;
  return 2;
}

function normalizedQuestionPoints(meta, number, answerPoints) {
  if (Number(answerPoints) >= 1 && Number(answerPoints) <= 5) return Number(answerPoints);
  return defaultQuestionPoints(meta, number);
}

function buildPdfBackedQuestions(meta, answerMap, questionLayouts, audioUrl, sourceUrl) {
  const questions = [];
  for (let number = 1; number <= meta.question_count; number += 1) {
    const sectionKey = questionSection(meta, number);
    const isWriting = sectionKey === 'writing';
    const layout = questionLayouts.get(number) || {};
    const pageUrl = layout.imageUrl || '';
    const contextUrl = layout.contextUrl || '';
    const answerEntry = answerMap.get(number);
    const answerChoice = typeof answerEntry === 'object' ? answerEntry.choice : answerEntry;
    const answerPoints = typeof answerEntry === 'object' ? answerEntry.points : 0;
    questions.push({
      number,
      section_key: sectionKey,
      points: normalizedQuestionPoints(meta, number, answerPoints),
      prompt: sectionKey === 'listening'
        ? '다음을 듣고 알맞은 답을 고르십시오.'
        : sectionKey === 'reading'
          ? '다음을 읽고 알맞은 답을 고르십시오.'
          : '다음 문항에 맞게 쓰십시오.',
      passage: '',
      content_html: pageUrl
        ? `<div class="pdf-page-question">${contextUrl ? `<img src="${contextUrl}" alt="TOPIK shared prompt for question ${number}" loading="lazy" />` : ''}<img src="${pageUrl}" alt="TOPIK question page ${number}" loading="lazy" /></div>`
        : '',
      image_url: pageUrl,
      audio_url: sectionKey === 'listening' ? audioUrl : '',
      type: isWriting ? (number === 54 ? 'essay' : 'short_answer') : 'multiple_choice',
      choices: isWriting
        ? []
        : layout.choices || [
            { id: '1', label: '1', text: '①', html: '①' },
            { id: '2', label: '2', text: '②', html: '②' },
            { id: '3', label: '3', text: '③', html: '③' },
            { id: '4', label: '4', text: '④', html: '④' },
          ],
      answer: answerChoice ? { choice: answerChoice, source: 'public_answer_key_pdf' } : isWriting ? { status: 'manual' } : { status: 'unknown' },
      explanation: '',
      media: { pdf_page_image: pageUrl, context_image: contextUrl, audio: sectionKey === 'listening' && audioUrl ? [audioUrl] : [] },
      source_url: sourceUrl,
    });
  }
  return questions;
}

async function importDriveFolderExam(sourceUrl, html) {
  const files = parseGoogleDriveFiles(html);
  const assets = classifyAssetFiles(files);
  const meta = inferMetaFromName(sourceUrl, files.map((file) => file.name).join(' '), 'google-drive');
  const audioFile = assets.audio[0];
  const missing = [];
  if (!assets.usableExamPdfs?.length) missing.push('exam_pdf');
  if (!assets.answers.length) missing.push('answer_key_pdf');
  if (!audioFile) missing.push('audio');
  if (missing.length) {
    return { skipped: true, reason: `missing_${missing.join('_')}`, files, assets };
  }

  const hash = crypto.createHash('sha1').update(sourceUrl).digest('hex').slice(0, 12);
  meta.slug = `topik-${meta.topik_level.toLowerCase()}-${meta.round_no}-${hash}`;
  const workDir = path.join(STORAGE_ROOT, 'crawler', hash);
  const pdfDir = path.join(workDir, 'pdf');
  const imageDir = path.join(workDir, 'pages');
  const cropDir = path.join(workDir, 'questions');
  const localAudioPath = await downloadFile(audioFile.url, path.join(workDir, `${safeFilePart(audioFile.id)}-${safeFilePart(audioFile.name)}`));
  const audioUrl = storageUrl(localAudioPath);

  const answerMap = await parseAnswerKeyFiles(assets.answers, pdfDir, meta);
  const pageImages = [];
  const pageTexts = [];
  const bboxPages = [];
  for (const [index, examPdf] of assets.usableExamPdfs.entries()) {
    const examPdfPath = await downloadFile(examPdf.url, path.join(pdfDir, `${safeFilePart(examPdf.id)}-${safeFilePart(examPdf.name)}`));
    const pageCount = await pdfPageCount(examPdfPath);
    const prefix = `exam${index + 1}`;
    const rendered = await renderPdfPages(examPdfPath, imageDir, meta.slug, prefix);
    pageImages.push(...rendered);
    const fullText = await pdfText(examPdfPath);
    pageTexts.push(...fullText.split('\f').slice(0, pageCount));
    bboxPages.push(...(await pdfBboxPages(examPdfPath)).slice(0, pageCount));
  }
  const questionLayouts = await buildQuestionLayouts(bboxPages, pageTexts, pageImages, cropDir, meta);
  const questions = buildPdfBackedQuestions(meta, answerMap, questionLayouts, audioUrl, sourceUrl);
  const multipleChoiceCount = questions.filter((question) => question.type === 'multiple_choice').length;
  const answeredCount = questions.filter((question) => question.type !== 'multiple_choice' || question.answer?.choice).length;

  if (answeredCount < multipleChoiceCount) {
    return {
      skipped: true,
      reason: `answer_key_incomplete_${answeredCount}_${multipleChoiceCount}`,
      files,
      assets,
    };
  }

  return {
    meta,
    questions,
    assets: {
      audio: audioUrl,
      audio_source: audioFile.url,
      pdfs: assets.pdfs.map((file) => ({ url: file.url, label: file.name })),
      images: pageImages.map((page) => ({ url: page.url, label: `Page ${page.page}` })),
      files,
    },
  };
}

async function createExam(client, meta, assets) {
  const examResult = await client.query(
    `INSERT INTO exams
      (slug, topik_level, round_no, title_ko, title_en, subject, question_count, total_score, duration_minutes, source_url, audio_url, imported_from)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (slug)
     DO UPDATE SET
       topik_level = EXCLUDED.topik_level,
       round_no = EXCLUDED.round_no,
       title_ko = EXCLUDED.title_ko,
       title_en = EXCLUDED.title_en,
       subject = EXCLUDED.subject,
       source_url = EXCLUDED.source_url,
       audio_url = COALESCE(NULLIF(EXCLUDED.audio_url, ''), exams.audio_url),
       question_count = EXCLUDED.question_count,
       total_score = EXCLUDED.total_score,
       duration_minutes = EXCLUDED.duration_minutes,
       imported_from = COALESCE(EXCLUDED.imported_from, exams.imported_from),
       updated_at = now()
     RETURNING *`,
    [
      meta.slug,
      meta.topik_level,
      meta.round_no,
      meta.title_ko,
      meta.title_en,
      meta.subject,
      meta.question_count,
      meta.total_score,
      meta.duration_minutes,
      meta.source_url,
      assets.audio,
      meta.imported_from || null,
    ],
  );

  const exam = examResult.rows[0];
  await client.query('DELETE FROM exam_sections WHERE exam_id = $1', [exam.id]);
  const sections =
    meta.topik_level === 'I'
      ? [
          ['listening', '듣기 (Nghe)', 1, 30, 100, 40, 1],
          ['reading', '읽기 (Đọc)', 31, 70, 100, 60, 2],
        ]
      : meta.question_count <= 100
        ? [
            ['listening', '듣기 (Nghe)', 1, 50, 100, 60, 1],
            ['reading', '읽기 (Đọc)', 51, 100, 100, 70, 2],
          ]
        : [
            ['listening', '듣기 (Nghe)', 1, 50, 100, 60, 1],
            ['writing', '쓰기 (Viết)', 51, 54, 100, 50, 2],
            ['reading', '읽기 (Đọc)', 55, 104, 100, 70, 3],
          ];

  for (const section of sections) {
    await client.query(
      `INSERT INTO exam_sections
       (exam_id, section_key, title, question_start, question_end, score, duration_minutes, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (exam_id, section_key) DO NOTHING`,
      [exam.id, ...section],
    );
  }

  return exam;
}

function cleanUrl(url) {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    parsed.search = '';
    return parsed.toString();
  } catch (_error) {
    return url;
  }
}

function normalizeQuestionHtml($, baseUrl, html) {
  const fragment = cheerio.load(`<div id="root">${html || ''}</div>`, { decodeEntities: false });
  fragment('audio, source').remove();
  fragment('script, style').remove();
  fragment('img').each((_, img) => {
    const src = fragment(img).attr('src') || fragment(img).attr('data-lazy-src');
    if (src) fragment(img).attr('src', absoluteUrl(baseUrl, src));
    fragment(img).removeAttr('srcset').removeAttr('sizes').removeAttr('class');
  });
  const root = fragment('#root');
  const firstInstruction = root.children().toArray().findIndex((node) => /※/.test(fragment(node).text()));
  if (firstInstruction > 0) {
    root.children().slice(0, firstInstruction).remove();
  }
  root.find('p, div, h1, h2, h3, h4, h5, h6').each((_, node) => {
    if (/^\s*\d+\.\s*$/.test(fragment(node).text())) fragment(node).remove();
  });
  return root.html()?.replace(/https?:\/\/\S+\.(?:mp3|wav|m4a|ogg)(?:\?\S*)?/gi, '').trim() || '';
}

function htmlToText($, html) {
  const fragment = cheerio.load(`<div id="root">${html || ''}</div>`, { decodeEntities: false });
  fragment('audio, source, script, style').remove();
  return fragment('#root')
    .text()
    .replace(/https?:\/\/\S+\.(?:mp3|wav|m4a|ogg)(?:\?\S*)?/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseQuestionRange(text) {
  const match = String(text || '').match(/[［\[]\s*(\d{1,3})\s*[~\-–]\s*(\d{1,3})\s*[］\]]/);
  if (!match) return null;
  return { start: Number(match[1]), end: Number(match[2]) };
}

function isMeaningfulQuestionHtml(html) {
  if (!html) return false;
  const text = cheerio.load(`<div>${html}</div>`).text().replace(/\s+/g, '').trim();
  return text.length > 0 || /<img\b/i.test(html);
}

function choiceOrder(choice) {
  const text = `${choice.html || ''} ${choice.text || ''}`;
  const circled = text.match(/[①②③④]/);
  if (circled) return '①②③④'.indexOf(circled[0]) + 1;
  const numeric = text.match(/^\s*([1-4])[\).]/);
  return numeric ? Number(numeric[1]) : Number(choice.id) || 999;
}

export function parseDethiTracNghiem(sourceUrl, html) {
  const $ = cheerio.load(html, { decodeEntities: false });
  const title = $('h1.entry-title, title').first().text().replace('» Đề Thi Trắc Nghiệm', '').trim();
  const meta = inferMeta(sourceUrl, html, title);
  if (/topik[-\s]*1|topik\s*i(?!i)/i.test(`${sourceUrl} ${title}`)) meta.topik_level = 'I';
  if (/topik[-\s]*2|topik\s*ii/i.test(`${sourceUrl} ${title}`)) meta.topik_level = 'II';
  meta.imported_from = 'dethitracnghiem.vn';
  meta.title_en = title || meta.title_en;
  meta.question_count = $('.iaeb-item[data-questions]').length || meta.question_count;
  meta.duration_minutes = Number((html.match(/"exam_time":"(\d+)"/) || [])[1]) || meta.duration_minutes;
  meta.total_score = meta.topik_level === 'I' ? 200 : 300;
  meta.subject = meta.topik_level === 'I' ? 'A (홀수형)' : 'B (홀수형)';

  const allAudio = [];
  const questions = [];
  let activeGroup = null;

  $('.iaeb-item[data-questions]').each((_, item) => {
    const element = $(item);
    const number = Number(element.attr('data-questions'));
    const rawType = element.attr('data-question-type') || 'multiple_choice';
    const quiz = element.find('.iaeb-quiz').first();
    const rawHtml = quiz.html() || '';
    const audioUrls = [];
    quiz.find('audio source[src], audio a[href]').each((__, node) => {
      const url = cleanUrl(absoluteUrl(sourceUrl, $(node).attr('src') || $(node).attr('href')));
      if (url && !audioUrls.includes(url)) audioUrls.push(url);
      if (url && !allAudio.includes(url)) allAudio.push(url);
    });
    const imageUrls = [];
    quiz.find('img[src], img[data-lazy-src]').each((__, node) => {
      const url = cleanUrl(absoluteUrl(sourceUrl, $(node).attr('src') || $(node).attr('data-lazy-src')));
      if (url && !imageUrls.includes(url)) imageUrls.push(url);
    });

    let contentHtml = normalizeQuestionHtml($, sourceUrl, rawHtml);
    const promptText = htmlToText($, contentHtml || rawHtml);
    const range = parseQuestionRange(promptText);
    if (range) {
      activeGroup = { ...range, prompt: promptText, content_html: contentHtml };
    } else if (activeGroup && number > activeGroup.end) {
      activeGroup = null;
    }

    if (!isMeaningfulQuestionHtml(contentHtml) && activeGroup && number >= activeGroup.start && number <= activeGroup.end) {
      contentHtml = activeGroup.content_html;
    }

    const choices = [];
    element.find('.iaeb-answer li').each((__, li) => {
      const choice = $(li);
      const id = choice.attr('data-answer') || String(choices.length + 1);
      const choiceHtml = choice.find('div').first().html() || choice.text();
      const normalizedChoice = {
        id,
        label: id,
        text: htmlToText($, choiceHtml),
        html: normalizeQuestionHtml($, sourceUrl, choiceHtml),
      };
      choices.push(normalizedChoice);
    });
    choices.sort((a, b) => choiceOrder(a) - choiceOrder(b));
    choices.forEach((choice, index) => {
      choice.id = String(index + 1);
      choice.label = String(index + 1);
    });

    questions.push({
      number,
      section_key:
        meta.topik_level === 'I'
          ? (number <= 30 ? 'listening' : 'reading')
          : meta.question_count <= 100
            ? (number <= 50 ? 'listening' : 'reading')
            : number <= 50
              ? 'listening'
              : number <= 54
                ? 'writing'
                : 'reading',
      points: meta.topik_level === 'I' && number >= 15 && number <= 30 ? 4 : 2,
      prompt: activeGroup && number >= activeGroup.start && number <= activeGroup.end ? activeGroup.prompt : promptText,
      passage: '',
      content_html: contentHtml,
      image_url: imageUrls[0] || '',
      audio_url: audioUrls[0] || '',
      type: rawType === 'fill_blank' ? 'short_answer' : 'multiple_choice',
      choices,
      answer: { status: 'unknown', source: 'not_public_in_html' },
      explanation: '',
      media: { images: imageUrls, audio: audioUrls },
      source_url: sourceUrl,
    });
  });

  return {
    meta,
    questions,
    assets: {
      audio: allAudio.length === 1 ? allAudio[0] : '',
      audio_tracks: allAudio,
      pdfs: [],
      images: questions.flatMap((question) => question.media.images).map((url) => ({ url, label: '' })),
    },
  };
}

export function discoverTopikLinks(sourceUrl, html) {
  const $ = cheerio.load(html);
  const links = new Set();
  $('a[href]').each((_, anchor) => {
    const href = absoluteUrl(sourceUrl, $(anchor).attr('href'));
    const label = $(anchor).text().replace(/\s+/g, ' ').trim();
    const searchable = `${href} ${label}`;
    if (
      /drive\.google\.com\/drive\/folders\//i.test(href) ||
      (/\/bai-thi\//i.test(href) && /topik/i.test(href)) ||
      (/study4\.com\/tests\/\d+\/[^/]*topik/i.test(href)) ||
      (/onthitopik\.com\//i.test(href) && /topik/i.test(searchable) && /(đáp án|dap an|de thi|đề thi|full|chữa|nghe|đọc|thi thử)/i.test(searchable)) ||
      (/thongtinduhochanquoc\.com\//i.test(href) && /topik/i.test(searchable) && /(đáp án|dap an|de thi|đề thi|tron-bo|trọn bộ)/i.test(searchable)) ||
      (/prepedu\.com\/vi\/blog\/de-thi-topik/i.test(href))
    ) {
      links.add(normalizeDiscoveredUrl(href));
    }
  });
  $('loc').each((_, node) => {
    const href = $(node).text().trim();
    if (/\/bai-thi\//i.test(href) && /topik/i.test(href)) {
      links.add(normalizeDiscoveredUrl(href));
    }
  });
  if (/\/bai-thi\/.*topik/i.test(sourceUrl)) links.add(sourceUrl);

  const maxGenerated = Number(process.env.TOPIK_DISCOVERY_MAX_DE || 12);
  const discovered = [...links];
  for (const level of ['1', '2']) {
    const hasLevel = discovered.some((href) => new RegExp(`/de-thi-topik-${level}(?:/|-de-)`, 'i').test(href));
    if (!hasLevel) continue;
    for (let index = 1; index <= maxGenerated; index += 1) {
      links.add(`https://dethitracnghiem.vn/bai-thi/de-thi-topik-${level}-de-${index}/`);
    }
  }
  if (/study4\.com\/tests/i.test(sourceUrl)) {
    links.add('https://study4.com/tests/topik-i/');
    links.add('https://study4.com/tests/topik-ii/');
    for (let page = 1; page <= Number(process.env.STUDY4_DISCOVERY_PAGES || 6); page += 1) {
      links.add(`https://study4.com/tests/?term=topik&page=${page}`);
    }
  }
  if (/onthitopik\.com/i.test(sourceUrl)) {
    links.add('https://onthitopik.com/category/giai-de-nghe-topik/nghe-topik-1/');
    links.add('https://onthitopik.com/category/giai-de-nghe-topik/nghe-topik-2/');
    links.add('https://onthitopik.com/category/giai-de-doc-topik/doc-topik-1/');
    links.add('https://onthitopik.com/category/giai-de-doc-topik/doc-topik-2/');
  }
  return [...links];
}

export function isImportableExamSource(url) {
  return /\/bai-thi\/.*topik/i.test(url) || /drive\.google\.com\/drive\/folders\//i.test(url);
}

export async function crawlSource(sourceUrl, options = {}) {
  const response = await axios.get(sourceUrl, {
    timeout: 45000,
    headers: {
      'User-Agent': 'TopikWebCodex crawler (+local study app)',
    },
  });
  const html = response.data;
  const $ = cheerio.load(html);
  const title = $('title').first().text();
  const specialized = /drive\.google\.com\/drive\/folders\//i.test(sourceUrl)
    ? await importDriveFolderExam(sourceUrl, html)
    : /dethitracnghiem\.vn/i.test(sourceUrl)
      ? parseDethiTracNghiem(sourceUrl, html)
      : null;

  if (specialized?.skipped) {
    return withClient(async (client) => {
      const jobResult = await client.query(
        'INSERT INTO crawl_jobs (source_url, status, result, error, finished_at) VALUES ($1, $2, $3, $4, now()) RETURNING *',
        [sourceUrl, 'skipped', JSON.stringify(specialized), specialized.reason],
      );
      return { skipped: true, reason: specialized.reason, job: jobResult.rows[0], files: specialized.files || [] };
    });
  }

  if (!specialized && !/\/bai-thi\/.*topik/i.test(sourceUrl)) {
    const discovered = discoverTopikLinks(sourceUrl, html);
    return withClient(async (client) => {
      const jobResult = await client.query(
        'INSERT INTO crawl_jobs (source_url, status, result, finished_at) VALUES ($1, $2, $3, now()) RETURNING *',
        [sourceUrl, 'finished', JSON.stringify({ discovered, mode: 'index_only' })],
      );
      return { skipped: true, reason: 'index_only', discovered, job: jobResult.rows[0] };
    });
  }

  const assets = specialized?.assets || extractAssets(sourceUrl, html);
  const meta = specialized?.meta || inferMeta(sourceUrl, html, title);

  let aiExtraction = null;
  if (options.ai) {
    const compactText = $('body').text().replace(/\s+/g, ' ').slice(0, 12000);
    aiExtraction = await askOpenRouter([
      {
        role: 'system',
        content:
          'Extract TOPIK exam metadata, answer keys, audio links and question hints as compact JSON. Return JSON only when possible.',
      },
      { role: 'user', content: `URL: ${sourceUrl}\nTITLE: ${title}\nTEXT:\n${compactText}` },
    ]);
  }

  return withClient(async (client) => {
    const jobResult = await client.query(
      'INSERT INTO crawl_jobs (source_url, status) VALUES ($1, $2) RETURNING *',
      [sourceUrl, 'running'],
    );
    const job = jobResult.rows[0];
    try {
      const exam = await createExam(client, meta, assets);
      if (specialized?.questions?.length) {
        await importQuestions(client, exam, specialized.questions);
      }
      const result = {
        exam,
        assets,
        ai: aiExtraction,
        pdfCount: assets.pdfs.length,
        imageCount: assets.images.length,
        questionCount: specialized?.questions?.length || 0,
      };
      await client.query(
        'UPDATE crawl_jobs SET status = $1, result = $2, finished_at = now() WHERE id = $3',
        ['finished', JSON.stringify(result), job.id],
      );
      return result;
    } catch (error) {
      await client.query(
        'UPDATE crawl_jobs SET status = $1, error = $2, finished_at = now() WHERE id = $3',
        ['failed', error.message, job.id],
      );
      throw error;
    }
  });
}

async function importQuestions(client, exam, questions) {
  const sections = await client.query('SELECT * FROM exam_sections WHERE exam_id = $1', [exam.id]);
  const byKey = new Map(sections.rows.map((section) => [section.section_key, section.id]));
  for (const question of questions || []) {
    const sectionId = byKey.get(question.section_key) || null;
    await client.query(
      `INSERT INTO questions
       (exam_id, section_id, number, points, prompt, passage, content_html, image_url, audio_url, type, choices, answer, explanation, sort_order, source_url, media)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (exam_id, number)
       DO UPDATE SET
         section_id = EXCLUDED.section_id,
         points = EXCLUDED.points,
         prompt = EXCLUDED.prompt,
         passage = EXCLUDED.passage,
         content_html = EXCLUDED.content_html,
         image_url = EXCLUDED.image_url,
         audio_url = EXCLUDED.audio_url,
         type = EXCLUDED.type,
         choices = EXCLUDED.choices,
         answer = EXCLUDED.answer,
         explanation = COALESCE(NULLIF(EXCLUDED.explanation, ''), questions.explanation),
         source_url = EXCLUDED.source_url,
         media = EXCLUDED.media`,
      [
        exam.id,
        sectionId,
        question.number,
        question.points || 2,
        question.prompt || '',
        question.passage || '',
        question.content_html || '',
        question.image_url || '',
        question.audio_url || '',
        question.type || 'multiple_choice',
        JSON.stringify(question.choices || []),
        JSON.stringify(question.answer || null),
        question.explanation || '',
        question.number,
        question.source_url || exam.source_url,
        JSON.stringify(question.media || {}),
      ],
    );
  }
}

export async function importExamPayload(payload) {
  return withClient(async (client) => {
    const exam = await createExam(client, payload.exam, { audio: payload.exam.audio_url || '' });
    await importQuestions(client, exam, payload.questions || []);
    return exam;
  });
}
