import express from 'express';
import cors from 'cors';
import { PrismaClient } from '@prisma/client';
import { Video } from '@prisma/client';
import Parser from 'rss-parser';
import cron from 'node-cron';
import bodyParser from 'body-parser';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import https from 'https';
import compression from 'compression';
import type { Request, Response } from 'express';

const execPromise = promisify(exec);

const app = express();
const port = 3000;
const CACHE_DIR = process.env.CACHE_DIR || '/var/www/cache';
const RSS_CACHE_DIR = path.join(CACHE_DIR, 'rss');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../../data');
const TEMP_COOKIES_FILE = path.join(DATA_DIR, 'cookies.txt');

const prisma = new PrismaClient();
const parser = new Parser({
  requestOptions: {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36'
    }
  }
});

const upload = multer({ storage: multer.memoryStorage() });

// === SAFE EXEC WITH FULL ERROR LOGGING ===
async function safeExec(cmd: string, context: string): Promise<{ stdout: string; stderr: string }> {
  try {
    const result = await execPromise(cmd, { maxBuffer: 50 * 1024 * 1024 });
    return { stdout: result.stdout || '', stderr: result.stderr || '' };
  } catch (err: any) {
    console.error(`❌ [${context}] Command failed`);
    console.error(`   Command: ${cmd}`);
    if (err.stdout) console.error(`   stdout: ${err.stdout}`);
    if (err.stderr) console.error(`   stderr: ${err.stderr}`);
    console.error(`   Error: ${err.message}`);
    throw err;
  }
}

// === CRITICAL 56K MODEM OPTIMIZATIONS ===
app.use(compression({
  level: 6,
  threshold: 512,
  filter: (req: Request, res: Response) => {
    if (req.headers['x-no-compression']) return false;
    return compression.filter(req, res);
  }
}));

app.use(cors());
app.use(bodyParser.json());
app.use(upload.single('cookies'));

app.use('/cache', express.static(CACHE_DIR, {
  maxAge: '1d',
  etag: true,
  lastModified: true,
  setHeaders: (res, filepath) => {
    if (filepath.endsWith('.mp3')) {
      res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
    } else if (/\.(jpe?g|webp|png)$/i.test(filepath)) {
      res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=3600');
    }
  }
}));

if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
if (!fs.existsSync(RSS_CACHE_DIR)) fs.mkdirSync(RSS_CACHE_DIR, { recursive: true });
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// === SETTINGS ===
const MAX_CONCURRENT_CHANNELS = 2;
let isHarvesting = false;
let UseAlternateListGetterMethod = true;

// === LIVE HARVEST STATUS ===
let harvestStatus = {
  isRunning: false,
  startTime: null as string | null,
  activeItems: [] as Array<{
    channelId: string;
    channelTitle: string;
    videoId: string | null;
    videoTitle: string | null;
    action: string;
    startedAt: string;
  }>,
  processedVideos: 0,
  totalVideosThisRun: 0,
  channelsProcessed: 0,
  totalChannels: 0,
  lastUpdate: null as string | null
};

// === CONFIG HELPERS ===
async function getConfig(key: string, defaultValue: string): Promise<string> {
  const config = await prisma.config.findUnique({ where: { key } });
  if (!config) {
    await prisma.config.create({ data: { key, value: defaultValue } });
    return defaultValue;
  }
  return config.value;
}

async function setConfig(key: string, value: string) {
  await prisma.config.upsert({ where: { key }, update: { value }, create: { key, value } });
}

// === COOKIE HELPERS ===
async function getCookies(): Promise<string> {
  return await getConfig('cookies', '');
}

async function writeTempCookiesFile() {
  const cookieText = await getCookies();
  if (!cookieText.trim()) return false;

  fs.writeFileSync(TEMP_COOKIES_FILE, cookieText, 'utf-8');
  fs.chmodSync(TEMP_COOKIES_FILE, 0o644);
  console.log(`🍪 Temporary cookies.txt written`);
  return true;
}

async function deleteTempCookiesFile() {
  if (fs.existsSync(TEMP_COOKIES_FILE)) {
    fs.unlinkSync(TEMP_COOKIES_FILE);
    console.log(`🗑️ Temporary cookies.txt deleted`);
  }
}

// === HELPERS ===
function logTimestamp(): string {
  return new Date().toISOString();
}

function getFileAge(filePath: string): string {
  try {
    const stats = fs.statSync(filePath);
    const hours = ((Date.now() - stats.mtimeMs) / (1000 * 60 * 60)).toFixed(1);
    return `${hours}h old`;
  } catch {
    return 'unknown';
  }
}

async function yieldToEventLoop() {
  return new Promise(resolve => setImmediate(resolve));
}

// === FULL CONSISTENCY CLEANUP ===
async function cleanupCorruptedFolders() {
  console.log(`🧹 [${logTimestamp()}] Starting full consistency cleanup...`);
  if (!fs.existsSync(CACHE_DIR)) return;

  const entries = fs.readdirSync(CACHE_DIR, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === 'rss') continue;

    const folderPath = path.join(CACHE_DIR, entry.name);
    const videoId = entry.name;

    const videoRecord = await prisma.video.findUnique({ where: { videoId } });

    if (!videoRecord) {
      console.log(`   🗑️ ORPHAN FOLDER (no DB Video entity): ${videoId}`);
      try { fs.rmSync(folderPath, { recursive: true, force: true }); } catch { }
      continue;
    }

    let files: string[] = [];
    try { files = fs.readdirSync(folderPath); } catch { continue; }

    const isEmpty = files.length === 0;
    const mp3Count = files.filter(f => f.endsWith('.mp3')).length;
    const thumbCount = files.filter(f => /\.(webp|jpg|png)$/i.test(f)).length;
    const jsonCount = files.filter(f => f === `${videoId}.json`).length;
    const otherCount = files.length - mp3Count - thumbCount - jsonCount;

    let isCorrupted = isEmpty || mp3Count !== 1 || jsonCount !== 1 || thumbCount > 2 || otherCount > 0;

    if (isCorrupted) {
      let reason = isEmpty ? 'Empty folder' : 'Unknown';
      if (mp3Count !== 1) reason = mp3Count === 0 ? 'No .mp3 file' : 'Multiple .mp3 files';
      else if (jsonCount !== 1) reason = jsonCount === 0 ? 'No .json file' : 'Multiple .json files';
      else if (thumbCount > 2) reason = `Too many thumbnails (${thumbCount})`;
      else if (otherCount > 0) reason = 'Unexpected files';
      console.log(`   🚨 CORRUPTED: ${videoId} → ${reason}`);
      try {
        fs.rmSync(folderPath, { recursive: true, force: true });
        await prisma.video.deleteMany({ where: { videoId: videoId } });
        console.log(`   ✅ Deleted corrupted folder + DB entry: ${videoId}`);
      } catch (e) {
        console.error(`   ❌ Failed to delete ${videoId}`);
      }
    }
  }

  const allVideos = await prisma.video.findMany({
    where: { ignored: false },
    select: { id: true, videoId: true }
  });

  for (const video of allVideos) {
    const folderPath = path.join(CACHE_DIR, video.videoId);
    const mp3Path = path.join(folderPath, `${video.videoId}.mp3`);

    if (!fs.existsSync(folderPath) || !fs.existsSync(mp3Path)) {
      const reason = !fs.existsSync(folderPath) ? 'Folder missing on disk' : '.mp3 file missing';
      console.log(`   🗑️ ORPHAN DB ENTITY: ${video.videoId} → ${reason}`);
      try { await prisma.video.delete({ where: { id: video.id } }); } catch { }
    }
  }

  console.log(`🧹 Full consistency cleanup finished\n`);
}

async function backfillChannelOrders() {
  const count = await prisma.channel.count({ where: { order: 0 } });
  if (count === 0) return;
  console.log(`🔧 Backfilling order for ${count} existing channels...`);
  const channels = await prisma.channel.findMany({ orderBy: { createdAt: 'asc' } });
  for (let i = 0; i < channels.length; i++) {
    await prisma.channel.update({ where: { id: channels[i].id }, data: { order: i } });
  }
  console.log(`✅ Channel order backfill complete`);
}

// === HELPER: Channel title extraction ===
function extractChannelTitle(parsed: any): string {
  return (
    parsed.title?.trim() ||
    parsed.author?.name?.trim() ||
    parsed.feed?.title?.trim() ||
    parsed.feed?.['title']?.trim() ||
    'Unknown Channel'
  );
}

// === ROBUST CHANNEL TITLE FETCHING ===
async function getChannelTitle(channelId: string, preferCache: boolean = false): Promise<string> {
  const rssUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
  const cacheFile = path.join(RSS_CACHE_DIR, `${channelId}.xml`);

  console.log(`🔍 [getChannelTitle] Fetching title for ${channelId}${preferCache ? ' (preferCache=true → skipping live RSS)' : ''}`);

  if (!preferCache) {
    try {
      const xml = await fetchRssRaw(rssUrl, channelId);
      fs.writeFileSync(cacheFile, xml);

      const parsed = await parser.parseString(xml);
      const title = extractChannelTitle(parsed);

      console.log(`✅ [getChannelTitle] LIVE SUCCESS → "${title}" for ${channelId}`);
      return title;
    } catch (err: any) {
      console.warn(`⚠️ [getChannelTitle] Live RSS failed for ${channelId}: ${err.message}`);
    }
  } else {
    console.log(`🔄 [getChannelTitle] Skipping live RSS (preferCache=true) for ${channelId}`);
  }

  if (fs.existsSync(cacheFile)) {
    try {
      const xml = fs.readFileSync(cacheFile, 'utf-8');
      const parsed = await parser.parseString(xml);
      const title = extractChannelTitle(parsed);
      console.log(`✅ [getChannelTitle] Used cached title → "${title}" for ${channelId} (age: ${getFileAge(cacheFile)})`);
      return title;
    } catch { }
  }

  console.warn(`❌ [getChannelTitle] Could not fetch title for ${channelId}`);
  return 'Unknown Channel';
}

// === RSS + FALLBACK ===
async function fetchRssRaw(url: string, channelId: string): Promise<string> {
  const timestamp = logTimestamp();
  console.log(`📡 [${timestamp}] Fetching live RSS for ${channelId}`);

  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/rss+xml, text/xml' } }, (res) => {
      const status = res.statusCode || 0;
      if (status === 404) return reject(new Error('HTTP 404'));
      if (status !== 200) return reject(new Error(`HTTP ${status}`));
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        console.log(`✅ [${timestamp}] Live RSS success for ${channelId}`);
        resolve(data);
      });
    }).on('error', reject).on('timeout', () => reject(new Error('timeout')));
  });
}

async function getRssFeedWithCache(channelId: string): Promise<{ items: any[], channelTitle: string }> {
  const rssUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
  const cacheFile = path.join(RSS_CACHE_DIR, `${channelId}.xml`);
  const timestamp = logTimestamp();
  const maxDays = parseInt(await getConfig('maxHarvestDays', '7'));

  const altEnabled = (await getConfig('alternativeMetadataEnabled', 'true')) === 'true';
  if (!UseAlternateListGetterMethod || !altEnabled) {
    // Normal flow (RSS first, then alternative, then cache)
    try {
      const xml = await fetchRssRaw(rssUrl, channelId);
      fs.writeFileSync(cacheFile, xml);
      console.log(`Fresh RSS cached for ${channelId}`);
      const parsed = await parser.parseString(xml);
      const channelTitle =
        parsed.title?.trim() ||
        parsed.author?.name?.trim() ||
        parsed.feed?.title?.trim() ||
        parsed.feed?.['title']?.trim() ||
        'Unknown Channel';
      return { items: cleanRssItems(parsed.items || []), channelTitle };
    } catch {
      console.warn(`Live RSS failed for ${channelId} → trying ALTERNATIVE METHOD (if enabled)`);
    }
  }

  if (altEnabled) {
    try {
      console.log(`[${timestamp}] Alternative method started for ${channelId}`);
      const items = await getLatestVideosAlternative(channelId, maxDays, false);
      const channelTitle = await getChannelTitle(channelId, true);
      return { items, channelTitle };
    } catch {
      console.warn(`Alternative method failed → falling back to cached RSS`);
    }
  } else {
    console.log(`[${timestamp}] Alternative metadata fetch disabled — skipping fallback for ${channelId}`);
  }

  if (fs.existsSync(cacheFile)) {
    try {
      const xml = fs.readFileSync(cacheFile, 'utf-8');
      const parsed = await parser.parseString(xml);
      const channelTitle =
        parsed.title?.trim() ||
        parsed.author?.name?.trim() ||
        parsed.feed?.title?.trim() ||
        parsed.feed?.['title']?.trim() ||
        'Unknown Channel';
      console.log(`Used cached RSS for ${channelId} (age: ${getFileAge(cacheFile)})`);
      return { items: cleanRssItems(parsed.items || []), channelTitle };
    } catch {
      console.error(`Cache parse failed for ${channelId}`);
    }
  }

  console.error(`All methods failed for ${channelId}`);
  return { items: [], channelTitle: 'Unknown Channel' };
}

function cleanRssItems(items: any[]): any[] {
  return items.map(item => {
    let videoId = item.videoId || item['yt:videoId'] || '';
    if (!videoId && item.id && typeof item.id === 'string') {
      const match = item.id.match(/yt:video:(.+)/);
      if (match) videoId = match[1];
    }

    let pubDateRaw = item.pubDate || item.published || item.updated || null;
    let pubDate = pubDateRaw ? new Date(pubDateRaw) : undefined;
    if (pubDate && isNaN(pubDate.getTime())) pubDate = undefined;

    return {
      ...item,
      videoId,
      pubDate,
      title: item.title || 'Untitled',
      link: item.link || `https://www.youtube.com/watch?v=${videoId}`
    };
  }).filter(item => item.videoId);
}

function parseYtDlpDuration(json: any): number | undefined {
  // 1. Prefer direct numeric duration (seconds, may be float like 7208.0)
  if (typeof json.duration === 'number' && !isNaN(json.duration) && json.duration > 0) {
    return Math.round(json.duration);
  }

  // 2. Fallback to duration_string
  const durStr = json?.duration_string;
  if (typeof durStr === 'string' && durStr.trim()) {
    const parts = durStr.trim().split(':').map(p => parseFloat(p.trim())).filter(p => !isNaN(p));
    if (parts.length === 3) {
      // HH:MM:SS
      return Math.round(parts[0] * 3600 + parts[1] * 60 + parts[2]);
    } else if (parts.length === 2) {
      // MM:SS
      return Math.round(parts[0] * 60 + parts[1]);
    } else if (parts.length === 1) {
      // SS (or just a plain number as string)
      return Math.round(parts[0]);
    }
  }
  return undefined;
}

function applyTodayMidnightRule(date: Date): Date {
  const now = new Date();
  const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  if (date.getTime() === todayMidnight.getTime()) {
    return now;
  }
  return date;
}

function parseYtDlpPubDate(json: any): Date | undefined {
  // 1. Prefer timestamp (Unix timestamp in seconds) — now with midnight rule
  if (typeof json?.timestamp === 'number' && json.timestamp > 0) {
    const date = new Date(json.timestamp * 1000);
    if (!isNaN(date.getTime())) {
      return applyTodayMidnightRule(date);
    }
  }
  
  if (typeof json?.upload_date === 'string' && json.upload_date.length === 8) {
    const year = parseInt(json.upload_date.slice(0, 4), 10);
    const month = parseInt(json.upload_date.slice(4, 6), 10) - 1; // JS months are 0-based
    const day = parseInt(json.upload_date.slice(6, 8), 10);

    if (!isNaN(year) && !isNaN(month) && !isNaN(day)) {
      const candidateDate = new Date(year, month, day);
      if (!isNaN(candidateDate.getTime())) {
        return applyTodayMidnightRule(candidateDate);
      }
    }
  }
  
  return undefined;
}

async function scrapeTab(channelId: string, tab: string, maxDays: number, scrapeIgnore: boolean): Promise<any[]> {
  const url = `https://www.youtube.com/channel/${channelId}/${tab}`;
  try {
    const date = new Date();
    date.setDate(date.getDate() - maxDays);
    const dateStr = date.toISOString().split('T')[0].replace(/-/g, '');

    const cmd = (await getBaseYtDlpCommand()) +
      ((scrapeIgnore) ? '' : `--playlist-items 1-10 `) +
      `--break-on-reject --extractor-args "youtubetab:approximate_date" ` +
      `--dump-json --flat-playlist --dateafter ${dateStr} --ignore-errors "${url}"`;

    const { stdout } = await safeExec(cmd, `scrapeTab ${tab} for ${channelId}`);
    return stdout.trim().split('\n')
      .filter(l => l.trim())
      .map(line => {
        try {
          const json = JSON.parse(line);
          let res = {
            videoId: json.id,
            title: json.title || 'Untitled',
            duration: parseYtDlpDuration(json),
            link: `https://www.youtube.com/watch?v=${json.id}`
          };

          return res;

        } catch {
          return null;
        }
      })
      .filter(item => item !== null);
  } catch {
    return [];
  }
}

// === IGNORE SWEEP ===
async function performIgnoreSweep(channelId: string) {
  const channelRecord = await prisma.channel.findUnique({ where: { channelId } });
  if (!channelRecord || channelRecord.ignoreScrapeDone) return;

  console.log(`🛡️ [IGNORE SWEEP] Starting for ${channelRecord.title} (${channelId})`);

  const maxDaysForSweep = 365 * 2;
  const items = await getLatestVideosAlternative(channelId, maxDaysForSweep, true);

  let count = 0;
  for (const videoItem of items) {
    const existingVideo = await prisma.video.findUnique({ where: { videoId: videoItem.videoId } });
    if (existingVideo) continue;

    let publishedAt = videoItem.pubDate && !isNaN(videoItem.pubDate.getTime()) && videoItem.pubDate.getTime() < Date.now()
      ? videoItem.pubDate
      : new Date();

    await prisma.video.create({
      data: {
        videoId: videoItem.videoId,
        channelId,
        title: videoItem.title || 'Untitled (Ignored)',
        publishedAt,
        thumbnailPath: null,
        audioPath: '',
        ignored: true,
      }
    });
    count++;
  }

  await prisma.channel.update({
    where: { channelId },
    data: { ignoreScrapeDone: true }
  });

  console.log(`✅ [IGNORE SWEEP] Flagged ${count} existing videos for ${channelRecord.title}`);
}

// === ALTERNATIVE METHOD (updated to respect global + per-tab toggles) ===
async function getLatestVideosAlternative(channelId: string, maxDays: number, includeIgnored: boolean = false): Promise<any[]> {
  const altEnabled = (await getConfig('alternativeMetadataEnabled', 'true')) === 'true';
  if (!altEnabled) {
    console.log(`🔧 [Alternative] Disabled globally for ${channelId}`);
    return [];
  }

  const useVideos = (await getConfig('scrapeVideosTab', 'true')) === 'true';
  const useStreams = (await getConfig('scrapeStreamsTab', 'true')) === 'true';
  const useShorts = (await getConfig('scrapeShortsTab', 'true')) === 'true';

  console.log(`🔧 Alternative tabs for ${channelId}: videos=${useVideos}, streams=${useStreams}, shorts=${useShorts}`);

  const scrapePromises: Promise<any[]>[] = [];
  if (useVideos) scrapePromises.push(scrapeTab(channelId, 'videos', maxDays, includeIgnored));
  if (useStreams) scrapePromises.push(scrapeTab(channelId, 'streams', maxDays, includeIgnored));
  if (useShorts) scrapePromises.push(scrapeTab(channelId, 'shorts', maxDays, includeIgnored));

  const results = scrapePromises.length > 0
    ? await Promise.all(scrapePromises)
    : [];

  const allItems = results.flat();

  let ignoredVideoIds = new Set<string>();
  if (!includeIgnored) {
    const ignoredVideos = await prisma.video.findMany({
      where: { channelId },
      select: { videoId: true }
    });
    ignoredVideoIds = new Set(ignoredVideos.map((v: { videoId: string }) => v.videoId));
  }

  const seenVideoIds = new Set<string>();
  const uniqueItems = allItems.filter(item =>
    !ignoredVideoIds.has(item.videoId) && !seenVideoIds.has(item.videoId) && seenVideoIds.add(item.videoId)
  );


  console.log(`✅ Alternative method completed for ${channelId} (includeIgnored=${includeIgnored}, returned ${uniqueItems.length})`);
  return uniqueItems;
}

export async function fillMissingMetadata(item: any): Promise<any> {
  try {
    if (!item.pubDate || !item.duration || !item.liveStatus) {
      console.log(`fetching metadata for ${item.videoId}`);
      const cmd = (await getBaseYtDlpCommand()) +
        `--no-warnings --print '%(timestamp)s|%(duration_string)s|%(live_status)s' "${item.link}"`;
      const { stdout } = await safeExec(cmd, `fetch metadata for ${item.videoId}`);
      const [rawTs, dur, liveStatusRaw] = stdout.trim().split('|');
      const result = {
        timestamp: parseInt(rawTs, 10) || undefined,
        duration_string: dur || undefined,
        live_status: liveStatusRaw?.trim() || 'not_live',
      };

      item.duration = parseYtDlpDuration(result);
      item.pubDate = parseYtDlpPubDate(result);
      item.liveStatus = result.live_status;
      item.liveStatuses = 'not_live|is_live|is_upcoming|was_live|post_live';
      item.VODNow = (item.liveStatus == 'not_live' || item.liveStatus == 'was_live');
      item.VODFuture = (item.liveStatus == 'is_live' || item.liveStatus == 'is_upcoming' || item.liveStatus == 'post_live');

      return { res: !!(item.duration && item.pubDate && item.liveStatus), err: '' }
    }
    return { res: true, err: '' };
  } catch (err) {
    console.error('fillMissingMetadata failed:', err);
    return { res: false, err };
  }
}

async function getBaseYtDlpCommand(): Promise<string> {
  const cookies = await getCookies();
  const userAgent = await getConfig('userAgent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36');

  let cookieFlag = '';
  if (cookies.trim()) {
    cookieFlag = `--cookies "${TEMP_COOKIES_FILE}" `;
    console.log(`🍪 Using cookies`);
  }

  const cmd = `yt-dlp --no-progress ` +
    `--js-runtimes node --remote-components ejs:github ` +
    `--user-agent "${userAgent}" ` +
    cookieFlag;

  return cmd;
}

// === DOWNLOAD + TRANSCODE ===
async function downloadAndProcessVideo(
  videoInfo: any,
  videoUrl: string,
  preferredBitrate: number,
  preferredMono: boolean,
  onStatusChange?: (status: string) => void
) {
  const { videoId, title: videoTitle, author = 'Unknown', publishedAt } = videoInfo;
  const videoDir = path.join(CACHE_DIR, videoId);
  const mp3 = path.join(videoDir, `${videoId}.mp3`);

  if (fs.existsSync(mp3)) return false;
  if (!fs.existsSync(videoDir)) fs.mkdirSync(videoDir, { recursive: true });

  let success = false;
  const metadataPath = path.join(videoDir, `${videoId}_metadata.ffmeta`);

  try {
    console.log(`📥 Starting download: ${videoId} (${author})`);

    const downloadCmd = (await getBaseYtDlpCommand()) +
      `-f bestaudio/best --write-thumbnail --no-overwrites --continue ` +
      `--match-filter "live_status != is_live & live_status != is_upcoming" ` +
      `--js-runtimes node --remote-components ejs:github ` +
      `--output "${videoDir}/%(id)s.%(ext)s" "${videoUrl}"`;

    await safeExec(downloadCmd, `yt-dlp download ${videoId}`);

    let raw = path.join(videoDir, `${videoId}.webm`);
    const alt = path.join(videoDir, `${videoId}.m4a`);
    if (!fs.existsSync(raw) && fs.existsSync(alt)) raw = alt;

    if (!fs.existsSync(raw)) throw new Error('No audio file was downloaded');

    if (onStatusChange) onStatusChange('Transcoding');
    console.log(`🎚️ Transcoding ${videoId} (${videoTitle})...`);

    const files = fs.readdirSync(videoDir);
    let originalThumbFile = files.find(f => /\.(jpe?g|webp|png)$/i.test(f));
    let thumbnailPath: string | null = null;

    if (originalThumbFile) {
      const originalPath = path.join(videoDir, originalThumbFile);
      const smallPath = path.join(videoDir, `${videoId}-small.webp`);

      try {
        await safeExec(`ffmpeg -i "${originalPath}" -vf "scale=400:225:force_original_aspect_ratio=decrease" -y "${smallPath}"`, `thumbnail resize ${videoId}`);
        thumbnailPath = `/cache/${videoId}/${videoId}-small.webp`;
        console.log(`📏 Created small thumbnail: ${videoId}-small.webp`);
      } catch (e: any) {
        console.warn(`⚠️ Could not create small thumbnail for ${videoId}`);
        thumbnailPath = `/cache/${videoId}/${originalThumbFile}`;
      }
    }

    const safeTitle = videoTitle.replace(/"/g, '\\"');
    const safeAuthor = author.replace(/"/g, '\\"');
    const dateStr = publishedAt instanceof Date ? publishedAt.toISOString().split('T')[0] : new Date().toISOString().split('T')[0];
    const dateStr2 = publishedAt instanceof Date ? publishedAt.toISOString() : new Date().toISOString();

    const commentData = { ...videoInfo, publishedAt: dateStr2 };
    const metadataContent = `;FFMETADATA1
title=${escapeFFmetadata(videoTitle)}
artist=${escapeFFmetadata(author)}
date=${dateStr}
comment=${JSON.stringify(commentData)}
`;
    fs.writeFileSync(metadataPath, metadataContent, 'utf-8');

    let args: string[];
    if (thumbnailPath && thumbnailPath.includes('-small.webp')) {
      const smallThumbPath = path.join(videoDir, `${videoId}-small.webp`);
      args = ['-i', raw, '-i', smallThumbPath, '-f', 'ffmetadata', '-i', metadataPath,
        '-map', '0:a', '-map', '1:0', '-map_metadata', '2',
        '-c:a', 'libmp3lame', '-c:v', 'mjpeg', '-disposition:v', 'attached_pic',
        '-id3v2_version', '3', '-ar', '24000', '-b:a', `${preferredBitrate}k`, '-f', 'mp3', mp3];
    } else if (originalThumbFile) {
      const originalThumb = path.join(videoDir, originalThumbFile);
      args = ['-i', raw, '-i', originalThumb, '-f', 'ffmetadata', '-i', metadataPath,
        '-map', '0:a', '-map', '1:0', '-map_metadata', '2',
        '-c:a', 'libmp3lame', '-c:v', 'mjpeg', '-disposition:v', 'attached_pic',
        '-id3v2_version', '3', '-ar', '24000', '-b:a', `${preferredBitrate}k`, '-f', 'mp3', mp3];
    } else {
      args = ['-i', raw, '-f', 'ffmetadata', '-i', metadataPath,
        '-map', '0:a', '-map_metadata', '1',
        '-id3v2_version', '3', '-write_id3v1', '0', '-write_xing', '0', '-fflags', '+bitexact',
        '-vn', '-c:a', 'libmp3lame', '-ar', '24000', '-b:a', `${preferredBitrate}k`, '-f', 'mp3', mp3];
    }
    if (preferredMono) args.splice(args.length - 1, 0, '-ac', '1');

    const ffmpegCmd = `ffmpeg ${args.join(' ')}`;
    await safeExec(ffmpegCmd, `ffmpeg transcoding ${videoId}`);

    if (fs.existsSync(raw)) fs.unlinkSync(raw);

    success = true;
    return true;
  } catch (err: any) {
    console.error(`❌ Download / FFmpeg failed for ${videoId}`);
    const errorMsg = (err.stderr || err.message || '').toLowerCase();

    if (errorMsg.includes('cookies are no longer valid') ||
      errorMsg.includes('invalid cookies') ||
      (errorMsg.includes('cookie') && errorMsg.includes('expired'))) {
      console.log(`🔑 [AUTO-CLEAR] Cookies are no longer valid → cleared from database`);
      await setConfig('cookies', '');
    }

    if (errorMsg.includes('live') || errorMsg.includes('is_live')) {
      console.log(`⏳ Skipped LIVE stream: ${videoId}`);
      return false;
    }
    if (errorMsg.includes('premiere') || errorMsg.includes('is_upcoming')) {
      console.log(`⏳ Skipped upcoming premiere: ${videoId}`);
      return false;
    }
    if (errorMsg.includes('sign in to confirm your age')) {
      console.log(`⏳ Skipped age-restricted video: ${videoId}`);
      return false;
    }

    return false;
  } finally {
    if (fs.existsSync(metadataPath)) {
      try { fs.unlinkSync(metadataPath); } catch { }
    }

    if (!success && fs.existsSync(videoDir) && !fs.existsSync(mp3)) {
      fs.rmSync(videoDir, { recursive: true, force: true });
      console.log(`🧹 Cleaned up incomplete folder for ${videoId}`);
    }
  }
}

function escapeFFmetadata(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/=/g, '\\=')
    .replace(/;/g, '\\;')
    .replace(/#/g, '\\#')
    .replace(/\n/g, '\\\n');
}

async function getAudioDuration(filePath: string): Promise<number | null> {
  try {
    const { stdout } = await safeExec(`ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${filePath}"`, `ffprobe duration ${filePath}`);
    const d = parseFloat(stdout.trim());
    return isNaN(d) ? null : Math.round(d * 10) / 10;
  } catch {
    return null;
  }
}

async function isFilteredOutByPubDate(item: any): Promise<boolean> {
  if (item.pubDate) {
    const maxDays = parseInt(await getConfig('maxHarvestDays', '7'));
    let publishedAt = new Date(item.pubDate);
    const ageMs = Date.now() - publishedAt.getTime();
    if (ageMs < 0) publishedAt = new Date();
    if (ageMs / (1000 * 60 * 60) > maxDays * 24) return true;
  }
  return false;
}
async function isFilteredOutByDuration(item: any): Promise<boolean> {
  if (item.duration) {
    const durationFilterEnabled = (await getConfig('durationFilterEnabled', 'false')) === 'true';
    const minDurationMinutes = parseInt(await getConfig('minDurationMinutes', '0'));
    const maxDurationMinutes = parseInt(await getConfig('maxDurationMinutes', '720'));
    if (durationFilterEnabled) {
      const durMinutes = (item.duration || 0) / 60;
      if (durMinutes < minDurationMinutes || durMinutes > maxDurationMinutes) {
        return true;
      }
    }
  }
  return false;
}


async function ignoreVideo(videoInfo: {
  videoId: string;
  channelId: string;
  title?: string;
  pubDate?: Date | string | null;
  duration?: number;
  [key: string]: any;
}): Promise<void> {
  const { videoId, channelId, title, pubDate, duration } = videoInfo;

  if (!videoId?.trim() || !channelId?.trim()) {
    console.warn(`⚠️ [ignoreVideo] Missing videoId or channelId`);
    return;
  }

  console.log(`🛡️ [ignoreVideo] Processing ignore request for ${videoId}`);

  try {
    const existing = await prisma.video.findUnique({ where: { videoId } });

    if (existing) {
      if (existing.ignored) {
        console.log(`ℹ️ [ignoreVideo] ${videoId} is already marked ignored`);
      } else {
        await prisma.video.update({
          where: { videoId },
          data: { ignored: true }
        });
        console.log(`✅ [ignoreVideo] Updated existing video → ignored: true (${videoId})`);
      }
    } else {
      let publishedAt: Date;
      if (pubDate) {
        publishedAt = new Date(pubDate);
        if (isNaN(publishedAt.getTime())) publishedAt = new Date();
      } else {
        publishedAt = new Date();
      }

      await prisma.video.create({
        data: {
          videoId,
          channelId,
          title: (title || 'Untitled (Ignored)').trim(),
          publishedAt,
          duration: duration || null,
          thumbnailPath: null,
          audioPath: '',
          ignored: true,
        }
      });
      console.log(`✅ [ignoreVideo] Created new ignored record for ${videoId}`);
    }

    const videoDir = path.join(CACHE_DIR, videoId);
    if (fs.existsSync(videoDir)) {
      try {
        fs.rmSync(videoDir, { recursive: true, force: true });
        console.log(`🗑️ [ignoreVideo] Deleted cache folder for ignored video: ${videoId}`);
      } catch (err: any) {
        console.warn(`⚠️ [ignoreVideo] Could not delete cache folder ${videoId}:`, err.message);
      }
    }

    const currentVideoId = await getConfig('currentVideoId', '');
    if (currentVideoId === videoId) {
      await setConfig('currentVideoId', '');
      console.log(`🧹 [ignoreVideo] Cleared currentVideoId (was ignored)`);
    }

  } catch (err: any) {
    console.error(`❌ [ignoreVideo] Failed to ignore ${videoId}:`, err.message);
  }
}

// === HARVESTER ===
async function harvestAndPurge() {
  if (isHarvesting) {
    console.log(`⏳ [${logTimestamp()}] Harvest already running — skipping`);
    return;
  }

  isHarvesting = true;

  harvestStatus = {
    isRunning: true,
    startTime: new Date().toISOString(),
    activeItems: [],
    processedVideos: 0,
    totalVideosThisRun: 0,
    channelsProcessed: 0,
    totalChannels: 0,
    lastUpdate: new Date().toISOString()
  };

  console.log(`\n🔄 [${logTimestamp()}] === HARVEST START ===`);

  try {
    await cleanupCorruptedFolders();
    await backfillChannelOrders();

    await deleteTempCookiesFile();
    await writeTempCookiesFile();

    if (UseAlternateListGetterMethod) {
      UseAlternateListGetterMethod = false;
    }
    else if (!UseAlternateListGetterMethod) {
      UseAlternateListGetterMethod = true;
    }

    const maxDays = parseInt(await getConfig('maxHarvestDays', '7'));
    const preferredBitrate = parseInt(await getConfig('preferredBitrate', '128'));
    const preferredMono = (await getConfig('preferredMono', 'false')) === 'true';
    const autoPurgeDays = parseInt(await getConfig('autoPurgeDays', '30'));

    // NEW: X videos per Y hours rate limit (default: OFF, 2 videos per 6 hours)
    const limitEnabled = (await getConfig('limitEnabled', 'false')) === 'true';
    const limitVideos = parseInt(await getConfig('limitVideos', '2'));
    const limitHours = parseInt(await getConfig('limitHours', '6'));

    // NEW: DB-backed global duration filter (optional, default disabled, max default = 12 hours = 720 minutes)
    const durationFilterEnabled = (await getConfig('durationFilterEnabled', 'false')) === 'true';
    const minDurationMinutes = parseInt(await getConfig('minDurationMinutes', '0'));
    const maxDurationMinutes = parseInt(await getConfig('maxDurationMinutes', '720'));

    const channels = await prisma.channel.findMany({ orderBy: { order: 'asc' } });
    harvestStatus.totalChannels = channels.length;

    const queue = [...channels];
    const running: Promise<void>[] = [];

    while (queue.length > 0 || running.length > 0) {
      while (running.length < MAX_CONCURRENT_CHANNELS && queue.length > 0) {
        const currentChannel = queue.shift()!;

        // === CHANNEL-LEVEL RATE LIMIT (skip entire channel if already at limit) ===
        if (limitEnabled) {
          const cutoff = new Date(Date.now() - limitHours * 60 * 60 * 1000);
          const recentCount = await prisma.video.count({
            where: {
              channelId: currentChannel.channelId,
              ignored: false,
              createdAt: { gte: cutoff }
            }
          });

          if (recentCount >= limitVideos) {
            console.log(`⏭️ [Rate Limit ${limitVideos}/${limitHours}h] Skipping entire channel "${currentChannel.title}" (${currentChannel.channelId}) — already ${recentCount} videos in last ${limitHours} hours`);
            harvestStatus.channelsProcessed++;
            harvestStatus.lastUpdate = new Date().toISOString();
            continue;
          }
        }

        harvestStatus.activeItems.push({
          channelId: currentChannel.channelId,
          channelTitle: currentChannel.title,
          videoId: null,
          videoTitle: null,
          action: currentChannel.ignoreScrapeDone ? 'Fetching RSS' : 'Ignore Sweep',
          startedAt: new Date().toISOString()
        });
        harvestStatus.lastUpdate = new Date().toISOString();

        const promise = (async () => {
          try {
            if (!currentChannel.ignoreScrapeDone) {
              const activeItem = harvestStatus.activeItems.find(i => i.channelId === currentChannel.channelId);
              if (activeItem) activeItem.action = 'Ignore Sweep';
              harvestStatus.lastUpdate = new Date().toISOString();

              await performIgnoreSweep(currentChannel.channelId);
            }

            const { items } = await getRssFeedWithCache(currentChannel.channelId);


            
            harvestStatus.totalVideosThisRun += items.length;

            const candidateIds = items.map(item => item.videoId).filter(Boolean);
            const existingIds = new Set(
              (await prisma.video.findMany({
                where: { videoId: { in: candidateIds } },
                select: { videoId: true }
              })).map((v: { videoId: string }) => v.videoId)
            );

            const newVideosToInsert: any[] = [];
            let downloadedThisRun = 0;

            let recentCount: number = 0
            if (limitEnabled) {
              const cutoff = new Date(Date.now() - limitHours * 60 * 60 * 1000);
              recentCount = await prisma.video.count({
                where: {
                  channelId: currentChannel.channelId,
                  ignored: false,
                  createdAt: { gte: cutoff }
                }
              });
            }
            for (const item of items) {
              const videoId = item.videoId || '';
              if (!videoId || existingIds.has(videoId)) continue;

              if (limitEnabled) {
                if (recentCount + downloadedThisRun >= limitVideos) {
                  console.log(`⏹️ [Rate Limit ${limitVideos}/${limitHours}h] Reached limit for channel "${currentChannel.title}" (${recentCount + downloadedThisRun}/${limitVideos} total) — stopping further downloads for this channel`);
                  break;
                }
              }

              const item2 = {
                videoId: item.videoId,
                channelId: currentChannel.channelId,
                title: item.title || '',
                pubDate: item.pubDate || new Date(),
                duration: item.duration || 0
              };
              if (await isFilteredOutByPubDate(item) || await isFilteredOutByDuration(item)) {
                await ignoreVideo(item2);
                continue;
              }

              let meta = await fillMissingMetadata(item);
              
              if (!meta.res) {
                const errorMsg = String(meta.err?.message ?? meta.err ?? '').toLowerCase();
                if (errorMsg.includes('members-only content')) {
                  await ignoreVideo(item2);
                }
                continue;
              }
              if (item.VODFuture) continue;

              if (await isFilteredOutByPubDate(item) || await isFilteredOutByDuration(item)) {
                await ignoreVideo(item2);
                continue;
              }

              let publishedAt = new Date(item.pubDate);

              let videoInfo: any = {
                videoId,
                channelId: currentChannel.channelId,
                title: item.title || 'Untitled',
                author: currentChannel.title || 'Unknown Channel',
                publishedAt,
              };

              const activeItem = harvestStatus.activeItems.find(i => i.channelId === currentChannel.channelId);
              if (activeItem) {
                activeItem.videoId = videoId;
                activeItem.videoTitle = item.title || videoId;
                activeItem.action = 'Downloading';
                harvestStatus.lastUpdate = new Date().toISOString();
              }

              const success = await downloadAndProcessVideo(
                videoInfo,
                item.link || `https://www.youtube.com/watch?v=${videoId}`,
                preferredBitrate,
                preferredMono,
                (newStatus) => {
                  if (activeItem) {
                    activeItem.action = newStatus;
                    harvestStatus.lastUpdate = new Date().toISOString();
                  }
                }
              );

              if (success) {
                downloadedThisRun++;
                const videoDir = path.join(CACHE_DIR, videoId);
                const audioPath = path.join(videoDir, `${videoId}.mp3`);

                let thumbnailPath: string | null = null;
                try {
                  const files = fs.readdirSync(videoDir);
                  const thumbFile = files.find(f => f.endsWith('-small.webp')) || files.find(f => /\.(jpe?g|webp|png)$/i.test(f));
                  if (thumbFile) thumbnailPath = `/cache/${videoId}/${thumbFile}`;
                } catch (e) { }

                const duration = await getAudioDuration(audioPath) || undefined;

                videoInfo.thumbnailPath = thumbnailPath;
                videoInfo.audioPath = audioPath;
                videoInfo.duration = duration;

                const jsonPath = path.join(videoDir, `${videoId}.json`);
                try {
                  fs.writeFileSync(jsonPath, JSON.stringify(videoInfo, null, 2), 'utf-8');
                  console.log(`📄 Wrote ${videoId}.json with metadata`);
                } catch (e) {
                  console.error(`Failed to write ${videoId}.json`);
                }

                delete (videoInfo as any).author;
                newVideosToInsert.push(videoInfo);
              }
            }

            if (newVideosToInsert.length > 0) {
              await prisma.video.createMany({ data: newVideosToInsert });
              harvestStatus.processedVideos += newVideosToInsert.length;
              console.log(`   ✅ Batch inserted ${newVideosToInsert.length} videos for ${currentChannel.title}`);
            }

          } catch (err: any) {
            console.error(`   ❌ Error processing channel ${currentChannel.title}:`, err.message);
          } finally {
            harvestStatus.activeItems = harvestStatus.activeItems.filter(i => i.channelId !== currentChannel.channelId);
            harvestStatus.channelsProcessed++;
            harvestStatus.lastUpdate = new Date().toISOString();
          }
        })();

        running.push(promise);
        promise.finally(() => {
          const idx = running.indexOf(promise);
          if (idx > -1) running.splice(idx, 1);
        });
      }

      if (running.length > 0) await Promise.race(running);
      await yieldToEventLoop();
    }

    harvestStatus.activeItems = [];
    const cutoff = new Date(Date.now() - autoPurgeDays * 24 * 60 * 60 * 1000);
    const oldVideos: Video[] = await prisma.video.findMany({
      where: { publishedAt: { lt: cutoff }, ignored: false }
    });
    for (const video of oldVideos) {
      const dir = path.join(CACHE_DIR, video.videoId);
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
      await prisma.video.delete({ where: { videoId: video.videoId } });
    }
    const currentVideoId = await getConfig('currentVideoId', '');
    if (currentVideoId && oldVideos.some(v => v.videoId === currentVideoId)) {
      await setConfig('currentVideoId', '');
      console.log(`🧹 Cleared currentVideoId because it was auto-purged`);
    }
  } catch (err: any) {
    console.error(`🚨 Unexpected error in harvest:`, err.message);
  } finally {
    await deleteTempCookiesFile();

    isHarvesting = false;
    harvestStatus.isRunning = false;
    harvestStatus.activeItems = [];
    harvestStatus.lastUpdate = new Date().toISOString();
    console.log(`🏁 [${logTimestamp()}] === HARVEST FINISHED ===\n`);
  }
}

// ====================== API ROUTES ======================
app.get('/api/harvest-status', (_, res) => res.json(harvestStatus));

app.get('/api/config', async (_, res) => {
  const maxHarvestDays = await getConfig('maxHarvestDays', '7');
  const preferredBitrate = await getConfig('preferredBitrate', '128');
  const preferredMono = await getConfig('preferredMono', 'false');
  const autoPurgeDays = await getConfig('autoPurgeDays', '30');
  const userAgent = await getConfig('userAgent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36');
  const cookieContent = await getCookies();

  const limitEnabled = await getConfig('limitEnabled', 'false');
  const limitVideos = await getConfig('limitVideos', '2');
  const limitHours = await getConfig('limitHours', '6');
  const currentVideoId = await getConfig('currentVideoId', '');

  const alternativeMetadataEnabled = await getConfig('alternativeMetadataEnabled', 'true');
  const scrapeVideosTab = await getConfig('scrapeVideosTab', 'true');
  const scrapeStreamsTab = await getConfig('scrapeStreamsTab', 'true');
  const scrapeShortsTab = await getConfig('scrapeShortsTab', 'true');

  // NEW: DB-backed global duration filter
  const durationFilterEnabled = await getConfig('durationFilterEnabled', 'false');
  const minDurationMinutes = await getConfig('minDurationMinutes', '0');
  const maxDurationMinutes = await getConfig('maxDurationMinutes', '720');

  res.json({
    maxHarvestDays: parseInt(maxHarvestDays),
    preferredBitrate: parseInt(preferredBitrate),
    preferredMono: preferredMono === 'true',
    autoPurgeDays: parseInt(autoPurgeDays),
    userAgent,
    hasCookies: !!cookieContent.trim(),
    lastPlayedVideoId: currentVideoId || null,
    limitEnabled: limitEnabled === 'true',
    limitVideos: parseInt(limitVideos),
    limitHours: parseInt(limitHours),
    alternativeMetadataEnabled: alternativeMetadataEnabled === 'true',
    scrapeVideosTab: scrapeVideosTab === 'true',
    scrapeStreamsTab: scrapeStreamsTab === 'true',
    scrapeShortsTab: scrapeShortsTab === 'true',
    // NEW duration filter fields
    durationFilterEnabled: durationFilterEnabled === 'true',
    minDurationMinutes: parseInt(minDurationMinutes),
    maxDurationMinutes: parseInt(maxDurationMinutes)
  });
});

app.post('/api/config', async (req, res) => {
  const { maxHarvestDays, preferredBitrate, preferredMono, autoPurgeDays, userAgent, cookies,
    limitEnabled, limitVideos, limitHours,
    alternativeMetadataEnabled, scrapeVideosTab, scrapeStreamsTab, scrapeShortsTab,
    // NEW duration filter
    durationFilterEnabled, minDurationMinutes, maxDurationMinutes } = req.body;

  if (maxHarvestDays !== undefined) await setConfig('maxHarvestDays', String(maxHarvestDays));
  if (preferredBitrate !== undefined) await setConfig('preferredBitrate', String(preferredBitrate));
  if (preferredMono !== undefined) await setConfig('preferredMono', String(preferredMono));
  if (autoPurgeDays !== undefined) await setConfig('autoPurgeDays', String(autoPurgeDays));
  if (userAgent !== undefined) await setConfig('userAgent', userAgent);
  if (cookies !== undefined) await setConfig('cookies', cookies);

  if (limitEnabled !== undefined) await setConfig('limitEnabled', String(limitEnabled));
  if (limitVideos !== undefined) await setConfig('limitVideos', String(limitVideos));
  if (limitHours !== undefined) await setConfig('limitHours', String(limitHours));

  if (alternativeMetadataEnabled !== undefined) await setConfig('alternativeMetadataEnabled', String(alternativeMetadataEnabled));
  if (scrapeVideosTab !== undefined) await setConfig('scrapeVideosTab', String(scrapeVideosTab));
  if (scrapeStreamsTab !== undefined) await setConfig('scrapeStreamsTab', String(scrapeStreamsTab));
  if (scrapeShortsTab !== undefined) await setConfig('scrapeShortsTab', String(scrapeShortsTab));

  // NEW duration filter config
  if (durationFilterEnabled !== undefined) await setConfig('durationFilterEnabled', String(durationFilterEnabled));
  if (minDurationMinutes !== undefined) await setConfig('minDurationMinutes', String(minDurationMinutes));
  if (maxDurationMinutes !== undefined) await setConfig('maxDurationMinutes', String(maxDurationMinutes));

  res.json({ success: true });
});

app.post('/api/cookies', (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, error: 'No cookies.txt file uploaded' });

  const content = req.file.buffer.toString('utf-8');
  setConfig('cookies', content).then(() => {
    console.log(`✅ cookies.txt uploaded and saved (${content.length} characters)`);
    res.json({ success: true });
  });
});

app.get('/api/channels', async (_, res) => {
  const channels = await prisma.channel.findMany({ orderBy: { order: 'asc' } });
  res.json(channels);
});

app.post('/api/channels', async (req, res) => {
  let { channelId, title } = req.body;
  const trimmedTitle = (title || '').toString().trim();

  if (!trimmedTitle || trimmedTitle === 'Unknown Channel') {
    console.log(`🔍 Auto-fetching channel title for ${channelId}`);
    title = await getChannelTitle(channelId);
  } else {
    title = trimmedTitle;
  }

  const maxOrder = await prisma.channel.aggregate({ _max: { order: true } });
  const nextOrder = (maxOrder._max.order ?? 0) + 1;

  const channel = await prisma.channel.upsert({
    where: { channelId },
    update: { title },
    create: { channelId, title, order: nextOrder, ignoreScrapeDone: false }
  });

  res.json(channel);
});

// === ROBUST CHANNEL DELETE ENDPOINT ===
app.delete('/api/channels/:channelId', async (req, res) => {
  const channelId = req.params.channelId;
  console.log(`🗑️ Deleting channel: ${channelId}`);

  try {
    const videos = await prisma.video.findMany({
      where: { channelId },
      select: { videoId: true }
    });

    const videoIds = videos.map(v => v.videoId);

    for (const videoId of videoIds) {
      const dir = path.join(CACHE_DIR, videoId);
      if (fs.existsSync(dir)) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
          console.log(`   🗑️ Deleted folder: ${videoId}`);
        } catch (e) {
          console.warn(`   ⚠️ Could not delete folder ${videoId}`);
        }
      }
    }

    const deletedVideos = await prisma.video.deleteMany({
      where: { channelId }
    });
    console.log(`   ✅ Deleted ${deletedVideos.count} video records`);

    const currentVideoId = await getConfig('currentVideoId', '');
    if (currentVideoId && videoIds.includes(currentVideoId)) {
      await setConfig('currentVideoId', '');
      console.log(`   🧹 Cleared stale currentVideoId → ${currentVideoId} (channel deleted)`);
    }

    const rssFile = path.join(RSS_CACHE_DIR, `${channelId}.xml`);
    if (fs.existsSync(rssFile)) {
      try {
        fs.unlinkSync(rssFile);
        console.log(`   🗑️ Deleted RSS cache: ${channelId}.xml`);
      } catch (e) {
        console.warn(`   ⚠️ Could not delete RSS cache`);
      }
    }

    const deletedChannel = await prisma.channel.deleteMany({
      where: { channelId }
    });

    if (deletedChannel.count === 0) {
      console.warn(`   ⚠️ Channel ${channelId} was already deleted or did not exist`);
    } else {
      console.log(`✅ Channel ${channelId} fully deleted`);
    }

    res.json({
      success: true,
      deletedVideos: deletedVideos.count,
      deletedChannel: deletedChannel.count
    });

  } catch (e: any) {
    console.error(`❌ Failed to delete channel ${channelId}:`, e.message);
    res.status(500).json({
      success: false,
      error: e.message
    });
  }
});

app.post('/api/channels/import', async (req, res) => {
  const { channelIds } = req.body as { channelIds: string[] };
  const results: any[] = [];
  let currentOrder = (await prisma.channel.aggregate({ _max: { order: true } }))._max.order ?? 0;

  for (const rawId of channelIds) {
    const channelId = rawId.trim();
    if (!channelId) continue;

    if (await prisma.channel.findUnique({ where: { channelId } })) {
      results.push({ channelId, status: 'skipped' });
      continue;
    }

    try {
      const { channelTitle } = await getRssFeedWithCache(channelId);

      currentOrder += 1;
      const newChannel = await prisma.channel.create({
        data: {
          channelId,
          title: channelTitle,
          order: currentOrder,
          ignoreScrapeDone: false
        }
      });

      results.push({ channelId, status: 'added', title: channelTitle });
      console.log(`✅ Imported ${channelId} → ${channelTitle}`);
    } catch (e) {
      console.error(`❌ Import failed for ${channelId}`, e);
      results.push({ channelId, status: 'failed' });
    }

    await new Promise(r => setTimeout(r, 800));
  }

  res.json({ success: true, results });
});

app.get('/api/playlist', async (req, res) => {
  const take = Math.min(Math.max(parseInt(req.query.take as string) || 20, 10), 100);
  const skip = parseInt(req.query.skip as string) || 0;

  let videos = await prisma.video.findMany({
    where: { watched: false, ignored: false },
    orderBy: { publishedAt: 'desc' },
    include: { channel: true },
    take,
    skip,
  });

  if (skip === 0) {
    const currentVideoId = await getConfig('currentVideoId', '');
    if (currentVideoId) {
      if (!videos.some(v => v.videoId === currentVideoId)) {
        const currentVideo = await prisma.video.findUnique({
          where: {
            videoId: currentVideoId,
            watched: false,
            ignored: false
          },
          include: { channel: true },
        });

        if (currentVideo) {
          if (videos.length >= take) {
            videos[videos.length - 1] = currentVideo;
            console.log(`📌 Replaced oldest item in first page with current video ${currentVideoId}`);
          } else {
            videos.push(currentVideo);
            console.log(`📌 Appended current video ${currentVideoId} to first page`);
          }
        }
      }
    }
  }

  res.json(videos);
});

app.post('/api/channels/reorder', async (req, res) => {
  const { channelIds } = req.body as { channelIds: string[] };
  if (!Array.isArray(channelIds)) return res.status(400).json({ success: false, error: 'Invalid payload' });

  try {
    for (let i = 0; i < channelIds.length; i++) {
      await prisma.channel.update({
        where: { channelId: channelIds[i] },
        data: { order: i }
      });
    }
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.patch('/api/video/:videoId/progress', async (req, res) => {
  const videoId = req.params.videoId;
  const progress = req.body.progress;

  try {
    const result = await prisma.video.updateMany({
      where: { videoId },
      data: { progress: progress ?? undefined }
    });

    if (result.count === 0) {
      const currentId = await getConfig('currentVideoId', '');
      if (currentId === videoId) {
        await setConfig('currentVideoId', '');
        console.log(`🧹 Cleared stale currentVideoId → ${videoId} no longer exists`);
      }
      console.warn(`⚠️ Progress update skipped (video ${videoId} was purged/deleted)`);
      return res.json({ success: true });
    }

    await setConfig('currentVideoId', videoId);
    res.json({ success: true });
  } catch (e: any) {
    console.error(`❌ Failed to save progress for ${videoId}:`, e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/video/:videoId/watched', async (req, res) => {
  try {
    const result = await prisma.video.updateMany({
      where: { videoId: req.params.videoId },
      data: { watched: true }
    });
    if (result.count === 0) {
      console.warn(`⚠️ Mark watched skipped — video ${req.params.videoId} not found`);
    }
    res.json({ success: true });
  } catch (e: any) {
    console.error(`❌ Failed to mark watched:`, e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/player/current', async (_, res) => {
  const videoId = await getConfig('currentVideoId', '');
  res.json({ videoId: videoId || null });
});

app.patch('/api/player/current', async (req, res) => {
  const { videoId } = req.body;
  await setConfig('currentVideoId', videoId || '');
  res.json({ success: true });
});

app.post('/api/purge-all', async (req, res) => {
  console.log(`🗑️ [PURGE-ALL] Starting purge of non-ignored videos only`);

  if (fs.existsSync(CACHE_DIR)) {
    const nonIgnoredVideos = await prisma.video.findMany({
      where: { ignored: false },
      select: { videoId: true }
    });

    for (const video of nonIgnoredVideos) {
      const folderPath = path.join(CACHE_DIR, video.videoId);
      if (fs.existsSync(folderPath)) {
        try {
          fs.rmSync(folderPath, { recursive: true, force: true });
          console.log(`   🗑️ Deleted folder: ${video.videoId}`);
        } catch (e) {
          console.error(`   ❌ Failed to delete folder ${video.videoId}`);
        }
      }
    }
  }

  const deletedCount = await prisma.video.deleteMany({
    where: { ignored: false }
  });

  console.log(`✅ Purge complete — ${deletedCount.count} non-ignored videos removed`);
  res.json({ success: true, deletedCount: deletedCount.count });
});

app.get('/api/stream/:videoId', async (req, res) => {
  const video = await prisma.video.findUnique({ where: { videoId: req.params.videoId } });
  if (!video || !fs.existsSync(video.audioPath)) return res.status(404).send('Video not found');
  res.sendFile(video.audioPath);
});

// === START ===
cron.schedule('*/5 * * * *', harvestAndPurge);
harvestAndPurge();

app.listen(port, () => {
  console.log(`🚀 DrivePod Backend ready on http://localhost:${port}`);
  console.log(`   Cache: ` + CACHE_DIR);
  console.log(`   Data:  ` + DATA_DIR);
});