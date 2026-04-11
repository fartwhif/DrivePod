import express from 'express';
import cors from 'cors';
import { PrismaClient } from '@prisma/client';
import Parser from 'rss-parser';
import cron from 'node-cron';
import bodyParser from 'body-parser';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import https from 'https';

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

app.use(cors());
app.use(bodyParser.json());
app.use(upload.single('cookies'));
app.use('/cache', express.static(CACHE_DIR));

if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
if (!fs.existsSync(RSS_CACHE_DIR)) fs.mkdirSync(RSS_CACHE_DIR, { recursive: true });
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// === SETTINGS ===
const MAX_CONCURRENT_CHANNELS = 3;
let isHarvesting = false;

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
      try { fs.rmSync(folderPath, { recursive: true, force: true }); } catch {}
      continue;
    }

    let files: string[] = [];
    try { files = fs.readdirSync(folderPath); } catch { continue; }

    const isEmpty = files.length === 0;
    const mp3Count = files.filter(f => f.endsWith('.mp3')).length;
    const thumbCount = files.filter(f => /\.(webp|jpg|png)$/.test(f)).length;
    const otherCount = files.length - mp3Count - thumbCount;

    let isCorrupted = isEmpty || mp3Count === 0 || mp3Count > 1 || otherCount > 0;

    if (isCorrupted) {
      const reason = isEmpty ? 'Empty folder' : (mp3Count === 0 ? 'No .mp3 file' : (mp3Count > 1 ? 'Multiple .mp3 files' : 'Unexpected files'));
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

  const allVideos = await prisma.video.findMany({ select: { id: true, videoId: true } });

  for (const video of allVideos) {
    const folderPath = path.join(CACHE_DIR, video.videoId);
    const mp3Path = path.join(folderPath, `${video.videoId}.mp3`);

    if (!fs.existsSync(folderPath) || !fs.existsSync(mp3Path)) {
      const reason = !fs.existsSync(folderPath) ? 'Folder missing on disk' : '.mp3 file missing';
      console.log(`   🗑️ ORPHAN DB ENTITY: ${video.videoId} → ${reason}`);
      try { await prisma.video.delete({ where: { id: video.id } }); } catch {}
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

// === ROBUST CHANNEL TITLE FETCHING ===
async function getChannelTitle(channelId: string): Promise<string> {
  const rssUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
  const cacheFile = path.join(RSS_CACHE_DIR, `${channelId}.xml`);

  console.log(`🔍 [getChannelTitle] Fetching title for ${channelId}`);

  try {
    const xml = await fetchRssRaw(rssUrl, channelId);
    fs.writeFileSync(cacheFile, xml);

    const parsed = await parser.parseString(xml);
    
    const title = 
      parsed.title?.trim() ||
      parsed.author?.name?.trim() ||
      parsed.feed?.title?.trim() ||
      parsed.feed?.['title']?.trim() ||
      'Unknown Channel';

    console.log(`✅ [getChannelTitle] SUCCESS → "${title}" for ${channelId}`);
    return title;
  } catch (err: any) {
    console.warn(`⚠️ [getChannelTitle] Live RSS failed for ${channelId}: ${err.message}`);
  }

  if (fs.existsSync(cacheFile)) {
    try {
      const xml = fs.readFileSync(cacheFile, 'utf-8');
      const parsed = await parser.parseString(xml);
      const title = 
        parsed.title?.trim() ||
        parsed.author?.name?.trim() ||
        parsed.feed?.title?.trim() ||
        parsed.feed?.['title']?.trim() ||
        'Unknown Channel';
      console.log(`✅ [getChannelTitle] Used cached title → "${title}" for ${channelId}`);
      return title;
    } catch {}
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

async function getRssFeedWithCache(channelId: string): Promise<{items: any[], channelTitle: string}> {
  const rssUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
  const cacheFile = path.join(RSS_CACHE_DIR, `${channelId}.xml`);
  const timestamp = logTimestamp();
  const maxDays = parseInt(await getConfig('maxHarvestDays', '7'));

  try {
    const xml = await fetchRssRaw(rssUrl, channelId);
    fs.writeFileSync(cacheFile, xml);
    console.log(`💾 Fresh RSS cached for ${channelId}`);
    const parsed = await parser.parseString(xml);
    const channelTitle = 
      parsed.title?.trim() ||
      parsed.author?.name?.trim() ||
      parsed.feed?.title?.trim() ||
      parsed.feed?.['title']?.trim() ||
      'Unknown Channel';
    return { items: cleanRssItems(parsed.items || []), channelTitle };
  } catch {
    console.warn(`⚠️ Live RSS failed for ${channelId} → trying ALTERNATIVE METHOD`);
  }

  try {
    console.log(`🔧 [${timestamp}] Alternative method started for ${channelId}`);
    const items = await getLatestVideosAlternative(channelId, maxDays);
    const channelTitle = await getChannelTitle(channelId);
    return { items, channelTitle };
  } catch {
    console.warn(`⚠️ Alternative method failed → falling back to cached RSS`);
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
      console.log(`✅ Used cached RSS for ${channelId} (age: ${getFileAge(cacheFile)})`);
      return { items: cleanRssItems(parsed.items || []), channelTitle };
    } catch {
      console.error(`❌ Cache parse failed for ${channelId}`);
    }
  }

  console.error(`🚨 All methods failed for ${channelId}`);
  return { items: [], channelTitle: 'Unknown Channel' };
}

function cleanRssItems(items: any[]): any[] {
  return items.map(item => {
    let videoId = item.videoId || item['yt:videoId'] || '';
    if (!videoId && item.id && typeof item.id === 'string') {
      const match = item.id.match(/yt:video:(.+)/);
      if (match) videoId = match[1];
    }

    let pubDate = item.pubDate || item.published || item.updated || null;
    if (pubDate) pubDate = new Date(pubDate);

    return {
      ...item,
      videoId,
      pubDate: pubDate || new Date(),
      title: item.title || 'Untitled',
      link: item.link || `https://www.youtube.com/watch?v=${videoId}`
    };
  }).filter(item => item.videoId);
}

async function scrapeTab(channelId: string, tab: string, maxDays: number): Promise<any[]> {
  const url = `https://www.youtube.com/channel/${channelId}/${tab}`;
  try {
    const { stdout } = await execPromise(
      `yt-dlp --flat-playlist --print "%(id)s|%(title)s|%(upload_date)s" ` +
      `--dateafter today-${maxDays}d --ignore-errors "${url}"`, { maxBuffer: 50 * 1024 * 1024 }
    );
    return stdout.trim().split('\n')
      .filter(l => l.trim())
      .map(line => {
        const [videoId, title, uploadDate] = line.split('|');
        return {
          videoId,
          title: title || 'Untitled',
          pubDate: uploadDate ? new Date(uploadDate) : new Date(),
          link: `https://www.youtube.com/watch?v=${videoId}`
        };
      });
  } catch {
    return [];
  }
}

async function getLatestVideosAlternative(channelId: string, maxDays: number): Promise<any[]> {
  const [videos, streams, shorts] = await Promise.all([
    scrapeTab(channelId, 'videos', maxDays),
    scrapeTab(channelId, 'streams', maxDays),
    scrapeTab(channelId, 'shorts', maxDays)
  ]);

  const all = [...videos, ...streams, ...shorts];
  const seen = new Set<string>();
  const unique = all.filter(item => !seen.has(item.videoId) && seen.add(item.videoId));

  console.log(`✅ Alternative method completed for ${channelId}`);
  console.log(`   → Videos: ${videos.length} | Streams: ${streams.length} | Shorts: ${shorts.length} | Unique total: ${unique.length}`);

  return unique;
}

// === DOWNLOAD + TRANSCODE (FINAL POLISHED) ===
async function downloadAndProcessVideo(
  videoId: string,
  videoUrl: string,
  channelTitle: string,
  preferredBitrate: number,
  preferredMono: boolean,
  onStatusChange?: (status: string) => void
) {
  const videoDir = path.join(CACHE_DIR, videoId);
  const mp3 = path.join(videoDir, `${videoId}.mp3`);

  if (fs.existsSync(mp3)) return false;
  if (!fs.existsSync(videoDir)) fs.mkdirSync(videoDir, { recursive: true });

  let success = false;

  try {
    console.log(`📥 Starting download: ${videoId} (${channelTitle})`);

    const cookies = await getCookies();
    const userAgent = await getConfig('userAgent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36');

    let cookieFlag = '';
    if (cookies.trim()) {
      cookieFlag = `--cookies "${TEMP_COOKIES_FILE}" `;
      console.log(`🍪 Using cookies for ${videoId}`);
    }

    await execPromise(
      `yt-dlp -f bestaudio/best --write-thumbnail --no-overwrites --continue ` +
      `--match-filter "live_status != is_live & live_status != is_upcoming" ` +
      `--js-runtimes node --remote-components ejs:github ` +
      `--user-agent "${userAgent}" ` +
      cookieFlag +
      `--output "${videoDir}/%(id)s.%(ext)s" "${videoUrl}"`, { maxBuffer: 50 * 1024 * 1024 }
    );

    let raw = path.join(videoDir, `${videoId}.webm`);
    const alt = path.join(videoDir, `${videoId}.m4a`);
    if (!fs.existsSync(raw) && fs.existsSync(alt)) raw = alt;

    if (!fs.existsSync(raw)) throw new Error('No audio file was downloaded');

    if (onStatusChange) onStatusChange('Transcoding');
    console.log(`🎚️ Transcoding ${videoId}...`);

    const args = ['-i', raw, '-map_metadata', '-1', '-map_chapters', '-1', '-id3v2_version', '0', '-write_id3v1', '0', '-write_xing', '0', '-fflags', '+bitexact', '-vn', '-c:a', 'libmp3lame', '-ar', '24000', '-b:a', `${preferredBitrate}k`, '-f', 'mp3', mp3];
    if (preferredMono) args.splice(args.length - 1, 0, '-ac', '1');

    await execPromise(`ffmpeg ${args.join(' ')}`, { maxBuffer: 50 * 1024 * 1024 });
    if (fs.existsSync(raw)) fs.unlinkSync(raw);

    success = true;
    return true;
  } catch (err: any) {
    const errorMsg = (err.stderr || err.message || '').toLowerCase();

    // === SMART COOKIE CLEARING ===
    if (errorMsg.includes('cookies are no longer valid') ||
        errorMsg.includes('invalid cookies') ||
        (errorMsg.includes('cookie') && errorMsg.includes('expired'))) {
      console.log(`🔑 [AUTO-CLEAR] Cookies are no longer valid → cleared from database`);
      await setConfig('cookies', '');
    }

    // === CLEAR LOGGING FOR SKIPPED CONTENT ===
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

    console.error(`❌ Download failed for ${videoId}:`, err.message);
    return false;
  } finally {
    if (!success && fs.existsSync(videoDir) && !fs.existsSync(mp3)) {
      fs.rmSync(videoDir, { recursive: true, force: true });
      console.log(`🧹 Cleaned up incomplete folder for ${videoId}`);
    }
  }
}

async function getAudioDuration(filePath: string): Promise<number | null> {
  try {
    const { stdout } = await execPromise(`ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${filePath}"`, { maxBuffer: 50 * 1024 * 1024 });
    const d = parseFloat(stdout.trim());
    return isNaN(d) ? null : Math.round(d * 10) / 10;
  } catch {
    return null;
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

    const maxDays = parseInt(await getConfig('maxHarvestDays', '7'));
    const preferredBitrate = parseInt(await getConfig('preferredBitrate', '128'));
    const preferredMono = (await getConfig('preferredMono', 'false')) === 'true';
    const autoPurgeDays = parseInt(await getConfig('autoPurgeDays', '30'));

    const channels = await prisma.channel.findMany({ orderBy: { order: 'asc' } });
    harvestStatus.totalChannels = channels.length;

    const queue = [...channels];
    const running: Promise<void>[] = [];

    while (queue.length > 0 || running.length > 0) {
      while (running.length < MAX_CONCURRENT_CHANNELS && queue.length > 0) {
        const ch = queue.shift()!;

        harvestStatus.activeItems.push({
          channelId: ch.channelId,
          channelTitle: ch.title,
          videoId: null,
          videoTitle: null,
          action: 'Fetching RSS',
          startedAt: new Date().toISOString()
        });
        harvestStatus.lastUpdate = new Date().toISOString();

        const promise = (async () => {
          try {
            const { items } = await getRssFeedWithCache(ch.channelId);
            harvestStatus.totalVideosThisRun += items.length;

            for (const item of items) {
              const videoId = item.videoId || '';
              if (!videoId) continue;

              const existing = await prisma.video.findUnique({ where: { videoId } });
              if (existing) continue;

              let publishedAt = new Date(item.pubDate || Date.now());
              const ageMs = Date.now() - publishedAt.getTime();
              if (ageMs < 0) publishedAt = new Date();
              if (ageMs / (1000 * 60 * 60) > maxDays * 24) continue;

              const activeItem = harvestStatus.activeItems.find(i => i.channelId === ch.channelId);
              if (activeItem) {
                activeItem.videoId = videoId;
                activeItem.videoTitle = item.title || videoId;
                activeItem.action = 'Downloading';
                harvestStatus.lastUpdate = new Date().toISOString();
              }

              const success = await downloadAndProcessVideo(
                videoId,
                item.link || `https://www.youtube.com/watch?v=${videoId}`,
                ch.title || 'Unknown',
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
                const videoDir = path.join(CACHE_DIR, videoId);
                const audioPath = path.join(videoDir, `${videoId}.mp3`);

                let thumbnailPath: string | null = null;
                try {
                  const files = fs.readdirSync(videoDir);
                  const thumbFile = files.find(f => /\.(jpe?g|webp|png)$/i.test(f));
                  if (thumbFile) {
                    thumbnailPath = `/cache/${videoId}/${thumbFile}`;
                  }
                } catch (e) {}

                const duration = await getAudioDuration(audioPath) || undefined;

                await prisma.video.create({
                  data: {
                    videoId,
                    channelId: ch.channelId,
                    title: item.title || 'Untitled',
                    publishedAt,
                    thumbnailPath,
                    audioPath,
                    duration,
                  }
                });

                console.log(`   ✅ DB WRITE: Video entity successfully created for ${videoId} (${item.title})`);

                harvestStatus.processedVideos++;
                harvestStatus.lastUpdate = new Date().toISOString();
              }
            }
          } catch (err: any) {
            console.error(`   ❌ Error processing channel ${ch.title}:`, err.message);
          } finally {
            harvestStatus.activeItems = harvestStatus.activeItems.filter(i => i.channelId !== ch.channelId);
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
    const old = await prisma.video.findMany({ where: { publishedAt: { lt: cutoff } } });
    for (const v of old) {
      const dir = path.join(CACHE_DIR, v.videoId);
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
      await prisma.video.delete({ where: { videoId: v.videoId } });
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
app.get('/api/harvest-status', (_, res) => {
  res.json(harvestStatus);
});

app.get('/api/config', async (_, res) => {
  const maxDays = await getConfig('maxHarvestDays', '7');
  const preferredBitrate = await getConfig('preferredBitrate', '128');
  const preferredMono = await getConfig('preferredMono', 'false');
  const autoPurgeDays = await getConfig('autoPurgeDays', '30');
  const userAgent = await getConfig('userAgent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36');
  const cookies = await getCookies();

  res.json({
    maxHarvestDays: parseInt(maxDays),
    preferredBitrate: parseInt(preferredBitrate),
    preferredMono: preferredMono === 'true',
    autoPurgeDays: parseInt(autoPurgeDays),
    userAgent,
    cookies
  });
});

app.post('/api/config', async (req, res) => {
  const { maxHarvestDays, preferredBitrate, preferredMono, autoPurgeDays, userAgent, cookies } = req.body;

  if (maxHarvestDays !== undefined) await setConfig('maxHarvestDays', String(maxHarvestDays));
  if (preferredBitrate !== undefined) await setConfig('preferredBitrate', String(preferredBitrate));
  if (preferredMono !== undefined) await setConfig('preferredMono', String(preferredMono));
  if (autoPurgeDays !== undefined) await setConfig('autoPurgeDays', String(autoPurgeDays));
  if (userAgent !== undefined) await setConfig('userAgent', userAgent);
  if (cookies !== undefined) await setConfig('cookies', cookies);

  res.json({ success: true });
});

app.post('/api/cookies', (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, error: 'No cookies.txt file uploaded' });
  }

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
    create: { channelId, title, order: nextOrder }
  });

  res.json(channel);
});

app.delete('/api/channels/:channelId', async (req, res) => {
  const channelId = req.params.channelId;
  try {
    const videos = await prisma.video.findMany({ where: { channelId } });
    for (const video of videos) {
      const dir = path.join(CACHE_DIR, video.videoId);
      if (fs.existsSync(dir)) try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
      await prisma.video.delete({ where: { videoId: video.videoId } });
    }
    const rssFile = path.join(RSS_CACHE_DIR, `${channelId}.xml`);
    if (fs.existsSync(rssFile)) fs.unlinkSync(rssFile);
    await prisma.channel.delete({ where: { channelId } });
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
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
      await prisma.channel.create({
        data: {
          channelId,
          title: channelTitle,
          order: currentOrder
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

app.get('/api/playlist', async (_, res) => {
  const videos = await prisma.video.findMany({
    where: { watched: false },
    orderBy: { publishedAt: 'desc' },
    include: { channel: true }
  });
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
  await prisma.video.update({ where: { videoId: req.params.videoId }, data: { progress: req.body.progress } });
  res.json({ success: true });
});

app.post('/api/video/:videoId/watched', async (req, res) => {
  await prisma.video.update({ where: { videoId: req.params.videoId }, data: { watched: true } });
  res.json({ success: true });
});

app.post('/api/purge-all', async (req, res) => {
  if (fs.existsSync(CACHE_DIR)) {
    const items = fs.readdirSync(CACHE_DIR);
    for (const item of items) {
      if (item === 'rss') continue;
      fs.rmSync(path.join(CACHE_DIR, item), { recursive: true, force: true });
    }
  }
  await prisma.video.deleteMany();
  res.json({ success: true });
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