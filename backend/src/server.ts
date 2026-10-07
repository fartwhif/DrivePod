import dotenv from 'dotenv';
dotenv.config({ path: '/app/.env' });

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
import type { Request, Response, NextFunction } from 'express';

const execPromise = promisify(exec);

if (!process.env.CACHE_DIR) {
  console.error('❌ CACHE_DIR not set. Create .env file from .env.example');
  process.exit(1);
}
if (!process.env.DATA_DIR) {
  console.error('❌ DATA_DIR not set. Create .env file from .env.example');
  process.exit(1);
}

const app = express();
const port = 3000;
const CACHE_DIR = process.env.CACHE_DIR;
const RSS_CACHE_DIR = path.join(CACHE_DIR, 'rss');
const DATA_DIR = process.env.DATA_DIR;
const TEMP_COOKIES_FILE = path.join(DATA_DIR, 'cookies.txt');
// Shared cookie export from the ytcookies container (RO mount), continuously
// refreshed by its CDP cookie exporter. Preferred over manually uploaded cookies.
const SHARED_COOKIES_FILE = '/shared-cookies/cookies.txt';
function effectiveCookiesFile(): string | null {
  if (fs.existsSync(SHARED_COOKIES_FILE) && fs.statSync(SHARED_COOKIES_FILE).size > 0) return SHARED_COOKIES_FILE;
  if (fs.existsSync(TEMP_COOKIES_FILE) && fs.statSync(TEMP_COOKIES_FILE).size > 0) return TEMP_COOKIES_FILE;
  return null;
}
const INDEX_JSON_PATH = path.join(CACHE_DIR, 'index.json');
const INDEX_TEMP_PATH = path.join(CACHE_DIR, 'index.tmp.json');
const PROGRESS_JSON_PATH = path.join(CACHE_DIR, 'progress.json');
const PROGRESS_TEMP_PATH = path.join(CACHE_DIR, 'progress.tmp.json');
const GRABBY_INDEX_PATH = path.join(CACHE_DIR, 'grabby-index.json');
const SHUFFLEBAG_JSON_PATH = path.join(CACHE_DIR, 'shufflebag.json');
const GRABBY_CHANNEL_ID = 'UCGrabbyTube';

const prisma = new PrismaClient();
const parser = new Parser({
  requestOptions: {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36'
    }
  }
});

if (!fs.existsSync(INDEX_JSON_PATH) || !fs.existsSync(PROGRESS_JSON_PATH)) {
  updateIndexFile();
}

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
let isImporting = false;
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
  if (effectiveCookiesFile() === SHARED_COOKIES_FILE) {
    // Shared ytcookies export is present and takes precedence; local file not needed
    console.log(`🍪 Using shared ytcookies export at ${SHARED_COOKIES_FILE}`);
    return true;
  }
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
      // Check if this is a GrabbyTube item (has a per-item .json with videoId key)
      const grabbyMeta = path.join(folderPath, `${videoId}.json`);
      if (fs.existsSync(grabbyMeta)) {
        try {
          const meta = JSON.parse(fs.readFileSync(grabbyMeta, 'utf-8'));
          if (meta.videoId) {
            console.log(`   🎵 GrabbyTube item (skipping): ${videoId}`);
            continue;
          }
        } catch { /* not valid JSON, fall through to orphan deletion */ }
      }
      console.log(`   🗑️ ORPHAN FOLDER (no DB Video entity): ${videoId}`);
      try { fs.rmSync(folderPath, { recursive: true, force: true }); await updateIndexFile(); } catch { }
      continue;
    }

    let files: string[] = [];
    try { files = fs.readdirSync(folderPath); } catch { continue; }

    const isEmpty = files.length === 0;
    const mp3Count = files.filter(f => f.endsWith('.mp3')).length;
    const thumbCount = files.filter(f => /\.(webp|jpg|png)$/i.test(f)).length;
    const jsonCount = files.filter(f => f === `${videoId}.json`).length;
    const otherCount = files.length - mp3Count - thumbCount - jsonCount;

    let isCorrupted = isEmpty || mp3Count !== 1 || jsonCount !== 1 || thumbCount > 2;

    if (isCorrupted) {
      // Check if this is a grabby item — protect its files on disk
      const isGrabbyItem = videoRecord?.isGrabby === true;

      let reason = isEmpty ? 'Empty folder' : 'Unknown';
      if (mp3Count !== 1) reason = mp3Count === 0 ? 'No .mp3 file' : 'Multiple .mp3 files';
      else if (jsonCount !== 1) reason = jsonCount === 0 ? 'No .json file' : 'Multiple .json files';
      else if (thumbCount > 2) reason = `Too many thumbnails (${thumbCount})`;
      console.log(`   🚨 CORRUPTED: ${videoId} → ${reason}${isGrabbyItem ? ' (🎵 grabby — preserving files)' : ''}`);
      try {
        if (!isGrabbyItem) {
          fs.rmSync(folderPath, { recursive: true, force: true });
        }
        await prisma.video.deleteMany({ where: { videoId: videoId } });
        await updateIndexFile();
        console.log(`   ✅ Deleted ${isGrabbyItem ? 'DB entry only (files preserved)' : 'corrupted folder + DB entry'}: ${videoId}`);
      } catch (e) {
        console.error(`   ❌ Failed to delete ${videoId}`);
      }
    } else if (videoRecord.isGrabby !== true) {
      // Post-publish integrity gate: the 9p-mounted Windows cache path
      // has corrupted finished MP3s after validation passed (2026-09-20:
      // one track's head spliced ahead of another track's tail, under
      // concurrent write load; no sync software involved) and leading zero-holes
      // (1.8MB of zeros replacing the ID3+Xing head and first minutes).
      // A clean published file starts with an ID3 tag or a frame sync, and
      // its Xing "bytes" field + tag size equals its file size.
      let corruption: string | null = null;
      const mp3Path = path.join(folderPath, `${videoId}.mp3`);
      try {
        const fd = fs.openSync(mp3Path, 'r');
        const head = Buffer.alloc(16);
        const hn = fs.readSync(fd, head, 0, 16, 0);
        fs.closeSync(fd);
        if (hn === 16) {
          const isId3 = head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33; // "ID3"
          const isFrameSync = head[0] === 0xFF && (head[1] & 0xE0) === 0xE0;
          if (!isId3 && !isFrameSync) {
            corruption = `junk at file start (head: ${head.slice(0, 4).toString('hex')}) — zero-hole or sync-merge artifact`;
          }
        }
      } catch { /* unreadable: skip header checks */ }
      if (!corruption) {
        const claim = readMp3HeaderClaim(mp3Path);
        if (claim) {
          const actual = fs.statSync(mp3Path).size;
          const tolerance = Math.max(4096, Math.floor(claim.claimedSize * 0.005));
          if (Math.abs(actual - claim.claimedSize) > tolerance) {
            corruption = `size/header mismatch (file ${actual}B vs header claim ${claim.claimedSize}B) — truncation or I/O-path merge`;
          }
        }
      }
      if (corruption) {
        console.log(`   🚨 CORRUPTED: ${videoId} → ${corruption}`);
        try {
          fs.rmSync(folderPath, { recursive: true, force: true });
          await prisma.video.deleteMany({ where: { videoId, isGrabby: false } });
          await updateIndexFile();
          console.log(`   ✅ Deleted corrupted folder + DB entry: ${videoId}`);
        } catch (e) {
          console.error(`   ❌ Failed to delete corrupted ${videoId}`);
        }
      }
    }
  }

  // Check orphan DB entities (skip grabby items — never delete their DB entries if files go missing)
  const allVideos = await prisma.video.findMany({
    where: { ignored: false, isGrabby: false },
    select: { id: true, videoId: true }
  });

  for (const video of allVideos) {
    const folderPath = path.join(CACHE_DIR, video.videoId);
    const mp3Path = path.join(folderPath, `${video.videoId}.mp3`);

    if (!fs.existsSync(folderPath) || !fs.existsSync(mp3Path)) {
      const reason = !fs.existsSync(folderPath) ? 'Folder missing on disk' : '.mp3 file missing';
      console.log(`   🗑️ ORPHAN DB ENTITY: ${video.videoId} → ${reason}`);
      try { await prisma.video.delete({ where: { id: video.id } }); await updateIndexFile();} catch { }
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

// ====================== SHUFFLEBAG (GrabbyTube) ======================

interface ShuffleBagEntry {
  videoId: string;
  used: boolean;
}

/**
 * Load grabby-index.json, filter defunct items (MP3 missing),
 * Fisher-Yates shuffle, and persist to shufflebag.json.
 */
async function initShuffleBag(): Promise<void> {
  console.log(`🎵 [ShuffleBag] Initializing shufflebag...`);

  // Ensure GrabbyTube placeholder channel exists
  await prisma.channel.upsert({
    where: { channelId: GRABBY_CHANNEL_ID },
    update: {},
    create: { channelId: GRABBY_CHANNEL_ID, title: 'GrabbyTube', order: 999999, active: false }
  });

  if (!fs.existsSync(GRABBY_INDEX_PATH)) {
    console.log(`⚠️ [ShuffleBag] No ${GRABBY_INDEX_PATH} found — shufflebag disabled`);
    fs.writeFileSync(SHUFFLEBAG_JSON_PATH, JSON.stringify([], null, 2));
    return;
  }

  const grabbyIndex: any[] = JSON.parse(fs.readFileSync(GRABBY_INDEX_PATH, 'utf-8'));

  // Filter out defunct items (MP3 missing on disk). Items already in the DB
  // stay in the bag on purpose: grabby tracks are reused indefinitely —
  // distributeGrabbyItems reconditions existing rows instead of skipping them.
  const valid: ShuffleBagEntry[] = [];
  for (const item of grabbyIndex) {
    const mp3Path = path.join(CACHE_DIR, item.audioPath);
    if (fs.existsSync(mp3Path)) {
      valid.push({ videoId: item.videoId, used: false });
    } else {
      console.log(`   🗑️ [ShuffleBag] Skipping defunct item: ${item.videoId} (no MP3)`);
    }
  }

  // Fisher-Yates shuffle
  for (let i = valid.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [valid[i], valid[j]] = [valid[j], valid[i]];
  }

  fs.writeFileSync(SHUFFLEBAG_JSON_PATH, JSON.stringify(valid, null, 2));
  console.log(`✅ [ShuffleBag] Initialized with ${valid.length} valid items (shuffled)`);
}

/**
 * Pull N unused items from the shufflebag. Reinitializes when exhausted.
 * Returns the pulled items (marks them as used).
 */
async function pullFromShuffleBag(count: number, reinitialized = false): Promise<ShuffleBagEntry[]> {
  if (!fs.existsSync(SHUFFLEBAG_JSON_PATH)) {
    console.log(`⚠️ [ShuffleBag] No shufflebag file — pulling 0 items`);
    return [];
  }

  const bag: ShuffleBagEntry[] = JSON.parse(fs.readFileSync(SHUFFLEBAG_JSON_PATH, 'utf-8'));

  const unused = bag.filter(e => !e.used);
  if (unused.length === 0) {
    if (reinitialized) {
      // No new items available (everything in the index is already in the DB
      // or defunct) — don't loop forever reinitializing.
      console.log(`⚠️ [ShuffleBag] No unused items available (all index items already in DB or defunct)`);
      return [];
    }
    console.log(`🔄 [ShuffleBag] Exhausted — reinitializing`);
    await initShuffleBag();
    return pullFromShuffleBag(count, true); // single retry with fresh bag
  }

  const pulled = unused.slice(0, count);
  for (const entry of pulled) {
    entry.used = true;
  }

  fs.writeFileSync(SHUFFLEBAG_JSON_PATH, JSON.stringify(bag, null, 2));
  console.log(`🎵 [ShuffleBag] Pulled ${pulled.length} items (${bag.filter(e => e.used).length} used / ${bag.length} total)`);
  return pulled;
}

/**
 * Load grabby-index.json and return it as a map videoId -> metadata.
 */
function loadGrabbyIndex(): Map<string, any> {
  if (!fs.existsSync(GRABBY_INDEX_PATH)) return new Map();
  const grabbyIndex: any[] = JSON.parse(fs.readFileSync(GRABBY_INDEX_PATH, 'utf-8'));
  const map = new Map<string, any>();
  for (const item of grabbyIndex) {
    map.set(item.videoId, item);
  }
  return map;
}

/**
 * Distribute GrabbyTube items after harvest completes.
 *
 * Evaluates normal:grabby duration ratio in the past hour of content.
 * Target ratio is configurable (default 3:1).
 * Pulls grabby items from shufflebag and inserts them as DB records
 * with isGrabby: true and timestamp clustering near the newest normal content.
 */
async function distributeGrabbyItems(): Promise<void> {
  const grabbyEnabled = (await getConfig('grabbyMixEnabled', 'true')) === 'true';
  if (!grabbyEnabled) {
    console.log(`⏭️ [ShuffleBag] GrabbyTube mix disabled — skipping distribution`);
    return;
  }

  const targetRatio = parseFloat(await getConfig('grabbyMixRatio', '3')); // normal:grabby
  if (targetRatio <= 0) {
    console.log(`⏭️ [ShuffleBag] Invalid grabbyMixRatio (${targetRatio}) — skipping`);
    return;
  }

  // Optional cap on the total number of grabby items in a cluster band
  // (past hour around the newest normal content, incl. the ±30-min jitter).
  // Applies across runs, not just one: the 5-min cron re-distributes
  // constantly, so a per-run cap let a single cluster grow well past it.
  // 0 = no limit (default, preserves current behavior).
  const clusterMaxSize = parseInt(await getConfig('grabbyClusterMaxSize', '0')) || 0;

  // Ensure GrabbyTube channel exists
  await prisma.channel.upsert({
    where: { channelId: GRABBY_CHANNEL_ID },
    update: {},
    create: { channelId: GRABBY_CHANNEL_ID, title: 'GrabbyTube', order: 999999, active: false }
  });

  // Find the newest normal video to establish the timestamp band
  const newestNormal = await prisma.video.findFirst({
    where: { isGrabby: false, ignored: false },
    orderBy: { publishedAt: 'desc' },
    select: { publishedAt: true, duration: true }
  });

  if (!newestNormal) {
    console.log(`⏭️ [ShuffleBag] No normal videos found — skipping distribution`);
    return;
  }

  const newestTime = newestNormal.publishedAt.getTime();
  const oneHourAgo = newestTime - 60 * 60 * 1000;

  // Calculate total duration of normal videos in the past hour
  const normalVideos = await prisma.video.findMany({
    where: {
      isGrabby: false,
      ignored: false,
      publishedAt: { gte: new Date(oneHourAgo), lte: newestNormal.publishedAt }
    },
    select: { duration: true }
  });

  const normalDurationSec = normalVideos.reduce((sum, v) => sum + (v.duration || 0), 0);

  // Calculate total duration of grabby videos in the past hour
  const grabbyVideos = await prisma.video.findMany({
    where: {
      isGrabby: true,
      ignored: false,
      publishedAt: { gte: new Date(oneHourAgo), lte: new Date(newestTime + 30 * 60 * 1000) }
    },
    select: { duration: true }
  });

  const grabbyDurationSec = grabbyVideos.reduce((sum, v) => sum + (v.duration || 0), 0);

  // Target grabby duration = normalDuration / ratio
  const targetGrabbyDuration = normalDurationSec / targetRatio;
  const deficitDuration = targetGrabbyDuration - grabbyDurationSec;

  if (deficitDuration <= 0) {
    console.log(`✅ [ShuffleBag] Grabby ratio satisfied (normal: ${Math.round(normalDurationSec)}s, grabby: ${Math.round(grabbyDurationSec)}s, target: ${Math.round(targetGrabbyDuration)}s)`);
    return;
  }

  console.log(`🎵 [ShuffleBag] Grabby deficit: ${Math.round(deficitDuration)}s (need ~${Math.round(deficitDuration / 60)}min of music)`);

  // Load grabby index for metadata lookups
  const grabbyMap = loadGrabbyIndex();

  // Floor on grabby content per distribution: keeps music flowing in quiet
  // hours without overriding the user's ratio. The old 60-min floor made
  // 10:1 meaningless — a tiny deficit still injected a full hour of grabby.
  // At high ratios the floor scales down to 15 min (still ~3x the 10:1
  // target for a typical hour of normal content).
  const minGrabbySec = targetRatio <= 5 ? 5 * 60 : 15 * 60;
  const neededDuration = Math.max(deficitDuration, minGrabbySec);

  // Pull enough items from shufflebag to cover the needed duration.
  // Use the real average from the index (catalog avg is ~18 min, not 4).
  const allDurations = [...grabbyMap.values()].map(m => m.duration || 0).filter(d => d > 0);
  const avgGrabbyDuration = allDurations.length
    ? allDurations.reduce((a, b) => a + b, 0) / allDurations.length
    : 240;
  let estimatedCount = Math.ceil(neededDuration / avgGrabbyDuration) + 5; // buffer
  let toPull = estimatedCount;
  if (clusterMaxSize > 0) {
    // Cap the whole cluster band, not just this run: grabby items already
    // clustered in the window by earlier cron runs count against the cap.
    const inCluster = await prisma.video.count({
      where: {
        isGrabby: true,
        ignored: false,
        publishedAt: { gte: new Date(oneHourAgo), lte: new Date(newestTime + 30 * 60 * 1000) }
      }
    });
    toPull = Math.min(toPull, clusterMaxSize - inCluster);
    if (toPull <= 0) {
      console.log(`✅ [ShuffleBag] Cluster cap ${clusterMaxSize} already met (${inCluster} in band) — skipping`);
      return;
    }
  }

  const pulled = await pullFromShuffleBag(toPull);
  if (pulled.length === 0) {
    console.log(`⚠️ [ShuffleBag] No items available in shufflebag`);
    return;
  }

  // Collect grabby items until we have enough duration
  const toInsert: any[] = [];
  let accumulatedDuration = 0;
  let reusedCount = 0;

  for (const entry of pulled) {
    const meta = grabbyMap.get(entry.videoId);
    if (!meta) continue;

    const duration = meta.duration || 0;
    if (duration <= 0) continue;

    // Check MP3 exists
    const mp3Path = path.join(CACHE_DIR, meta.audioPath);
    if (!fs.existsSync(mp3Path)) continue;

    // Check if already in DB
    const existing = await prisma.video.findUnique({ where: { videoId: entry.videoId } });
    if (existing) {
      // Recondition the existing row: refresh its timestamp to cluster near the
      // newest normal content and reset its playback state, so it re-enters the
      // mix window instead of being skipped.
      await prisma.video.update({
        where: { id: existing.id },
        data: {
          publishedAt: clusterTimestamp(newestNormal.publishedAt),
          duration,
          title: meta.title || existing.title,
          thumbnailPath: meta.thumbnailPath ? `/cache/${meta.thumbnailPath}` : existing.thumbnailPath,
          audioPath: mp3Path,
          isGrabby: true,
          watched: false,
          progress: 0
        }
      });
      reusedCount++;
      console.log(`   ♻️ [ShuffleBag] Reconditioned existing: ${entry.videoId}`);
    } else {
      toInsert.push({
        videoId: entry.videoId,
        channelId: GRABBY_CHANNEL_ID,
        title: meta.title || 'GrabbyTube Track',
        publishedAt: clusterTimestamp(newestNormal.publishedAt),
        thumbnailPath: meta.thumbnailPath ? `/cache/${meta.thumbnailPath}` : null,
        audioPath: mp3Path,
        duration,
        ignored: false,
        protected: false,
        isGrabby: true
      });
    }

    accumulatedDuration += duration;

    if (accumulatedDuration >= neededDuration) break;
  }

  const totalChanged = toInsert.length + reusedCount;
  if (totalChanged === 0) {
    console.log(`⚠️ [ShuffleBag] No usable grabby items`);
    return;
  }

  if (toInsert.length > 0) {
    // Last-moment recheck: a concurrent grabby delete may have removed an MP3
    // after the per-item check above. Don't insert DB rows for missing files
    // (updateIndexFile's defunct filter is the backstop if one slips through).
    const live = toInsert.filter(i => fs.existsSync(path.join(CACHE_DIR, i.videoId, `${i.videoId}.mp3`)));
    if (live.length < toInsert.length) {
      console.log(`⏭️ [ShuffleBag] Skipping ${toInsert.length - live.length} items deleted mid-harvest`);
    }
    if (live.length > 0) {
      await prisma.video.createMany({ data: live });
    }
  }
  await updateIndexFile();

  console.log(`✅ [ShuffleBag] ${toInsert.length} inserted + ${reusedCount} reconditioned grabby items (${Math.round(accumulatedDuration)}s total${clusterMaxSize > 0 ? `, cluster cap ${clusterMaxSize}` : ''})`);
}

/**
 * Cluster a grabby item's timestamp near the newest normal content.
 * Places it within ±30 minutes of the reference time.
 */
function clusterTimestamp(reference: Date): Date {
  const offsetMs = (Math.random() - 0.5) * 60 * 60 * 1000; // ±30 min
  return new Date(reference.getTime() + offsetMs);
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
  const cookieFile = effectiveCookiesFile();
  if (cookieFile) {
    cookieFlag = `--cookies "${cookieFile}" `;
    console.log(`🍪 Using cookies: ${cookieFile}`);
  }

  const cmd = `yt-dlp --no-progress ` +
    `--remote-components ejs:github ` +
    `--extractor-args youtube:player_client=mweb ` +
    `--extractor-args youtubepot-bgutilhttp:base_url=http://drivepod-bgutil:4416 ` +
    `--min-sleep-interval 5 ` +
    `--max-sleep-interval 15 ` +
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
      `-f "b[acodec!=none][height<=360]/b[acodec!=none]/ba/b" --write-thumbnail --no-overwrites --continue ` +
      `--match-filter "live_status != is_live & live_status != is_upcoming" ` +
      `--output "${videoDir}/%(id)s.%(ext)s" "${videoUrl}"`;

    await safeExec(downloadCmd, `yt-dlp download ${videoId}`);

    let raw = path.join(videoDir, `${videoId}.webm`);
    const alt = path.join(videoDir, `${videoId}.m4a`);
    const mp4alt = path.join(videoDir, `${videoId}.mp4`);
    if (!fs.existsSync(raw) && fs.existsSync(alt)) raw = alt;
    if (!fs.existsSync(raw) && fs.existsSync(mp4alt)) raw = mp4alt;

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
    const vbrfixCmd = `vbrfix -always "${mp3}" "${mp3}.vbrfix.tmp" && mv -f "${mp3}.vbrfix.tmp" "${mp3}"`;

    const transcode = async (attempt: number) => {
      await safeExec(ffmpegCmd, `ffmpeg transcoding ${videoId} (attempt ${attempt})`);
      await safeExec(vbrfixCmd, `vbrfix ${videoId} (attempt ${attempt})`);
    };

    await transcode(1);

    // Validate the finished file before publishing. Silent I/O failures on
    // the synced cache drive have produced zero-holed MP3s that ffprobe
    // still reports as valid (duration estimated from file size) but that
    // no player can demux. One re-transcode attempt, then discard.
    const expectedDuration = typeof videoInfo.duration === 'number' && videoInfo.duration > 0
      ? videoInfo.duration
      : null;
    let validation = await validateMp3File(mp3, expectedDuration);
    if (!validation.ok) {
      console.warn(`⚠️ MP3 validation failed for ${videoId} (${validation.reason}) — re-transcoding once`);
      try { fs.unlinkSync(mp3); } catch { }
      await transcode(2);
      validation = await validateMp3File(mp3, expectedDuration);
    }
    if (!validation.ok) {
      console.error(`❌ MP3 failed validation for ${videoId} after re-transcode (${validation.reason}) — discarding track`);
      try { fs.unlinkSync(mp3); } catch { }
      return false;
    }

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
      await updateIndexFile();
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

/**
 * Parse the leading ID3v2 tag + Xing/Info header of a CBR MP3 and return
 * the total file size the header claims (tag end + Xing "bytes" field).
 * vbrfix's byte count is exact for an untouched file, so any real deviation
 * means the file was truncated or had foreign bytes spliced in. Returns
 * null when the header can't be read (then the size check is skipped).
 */
function readMp3HeaderClaim(filePath: string): { claimedSize: number } | null {
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const head = Buffer.alloc(16);
      if (fs.readSync(fd, head, 0, 16, 0) < 16) return null;
      let tagEnd = 0;
      if (head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) { // "ID3"
        const sz = ((head[6] & 127) << 21) | ((head[7] & 127) << 14) | ((head[8] & 127) << 7) | (head[9] & 127);
        tagEnd = 10 + sz;
        if (tagEnd > 1 << 20) return null;
      } else if (!(head[0] === 0xff && (head[1] & 0xe0) === 0xe0)) {
        return null;
      }
      const tail = Buffer.alloc(256);
      const tn = fs.readSync(fd, tail, 0, 256, tagEnd);
      if (tn < 24) return null;
      for (let i = 0; i + 16 <= tn; i++) {
        const t = tail.slice(i, i + 4).toString('ascii');
        if (t !== 'Xing' && t !== 'Info') continue;
        // Accept only the canonical position (i=4, right after the frame
        // header) or a zero-filled gap (vbrfix pads 0x00 before its Info
        // tag) — never audio bytes that happen to spell "Xing"/"Info".
        let canonical = true;
        for (let j = 4; j < i; j++) {
          if (tail[j] !== 0) { canonical = false; break; }
        }
        if (!canonical) break;
        const flags = tail.readUInt32BE(i + 4);
        if (!(flags & 2)) return null; // no "bytes" field — cannot verify
        const countOff = i + 8 + ((flags & 1) ? 4 : 0);
        return { claimedSize: tagEnd + tail.readUInt32BE(countOff) };
      }
      return null;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/**
 * Validate a finished MP3 before it is published to the queue.
 *
 * The cache dir lives on a synced Windows drive (9p), where silent I/O
 * failures have produced files with zero-padded holes (observed: 46MB of
 * leading zeros on an otherwise complete file). ffprobe cannot catch that —
 * it estimates duration from file size and reports success — but no player
 * can demux such a file (Chrome: MEDIA_ERR_SRC_NOT_SUPPORTED,
 * "DEMUXER_ERROR_COULD_NOT_OPEN"). Checks:
 *  1. No run of 256KB+ consecutive zero bytes. Valid MP3 frames are
 *     417–480 bytes and start with a 0xFF sync; even silence is framed,
 *     so a run this long is always a hole, never audio.
 *  2. File starts with an ID3 tag or an MP3 frame sync.
 *  3. Has a Xing/Info header. vbrfix -always guarantees one; ffprobe warns
 *     "Estimating duration from bitrate" when the header is missing.
 *  4. Probed duration is finite and, if the caller knows the expected one,
 *     within 10% (min 30s).
 *  5. File size matches the Xing/Info header claim (tag end + "bytes"
 *     field). vbrfix writes an exact count; the 9p-mounted Windows cache
 *     path has merged bytes of a concurrently-written file into a
 *     finished MP3 — hybrids with real audio from two videos that pass
 *     every other check (observed 2026-09-20: 23.8MB of one track spliced
 *     ahead of another track's tail).
 */
async function validateMp3File(filePath: string, expectedDuration: number | null): Promise<{ ok: boolean; reason: string }> {
  const MAX_ZERO_RUN = 256 * 1024;
  try {
    const fd = fs.openSync(filePath, 'r');
    let totalBytes = 0;
    try {
      const CHUNK = 4 * 1024 * 1024;
      const buf = Buffer.alloc(CHUNK);
      let carriedRun = 0;
      let offset = 0;
      let headChecked = false;
      while (true) {
        const n = fs.readSync(fd, buf, 0, CHUNK, offset);
        if (n === 0) break;
        totalBytes += n;
        if (!headChecked) {
          headChecked = true;
          const isId3 = buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33; // "ID3"
          const isFrameSync = buf[0] === 0xFF && (buf[1] & 0xE0) === 0xE0;
          if (!isId3 && !isFrameSync) {
            return { ok: false, reason: `no ID3 tag or frame sync at file start (head: ${buf.slice(0, 4).toString('hex')})` };
          }
        }
        let run = carriedRun;
        for (let i = 0; i < n; i++) {
          if (buf[i] === 0) {
            if (++run > MAX_ZERO_RUN) {
              return { ok: false, reason: `zero-hole: ${run >> 10}KB+ of consecutive zero bytes` };
            }
          } else {
            run = 0;
          }
        }
        carriedRun = run;
        offset += n;
      }
    } finally {
      fs.closeSync(fd);
    }
    if (totalBytes === 0) return { ok: false, reason: 'empty file' };

    let stdout: string, stderr: string;
    try {
      ({ stdout, stderr } = await safeExec(
        `ffprobe -v warning -show_entries format=duration -of csv=p=0 "${filePath}"`,
        `ffprobe validate ${path.basename(filePath)}`
      ));
    } catch (err) {
      return { ok: false, reason: `ffprobe failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    const duration = parseFloat(stdout.trim());
    if (isNaN(duration) || duration <= 0) {
      return { ok: false, reason: `ffprobe duration invalid: "${stdout.trim()}"` };
    }
    if (/estimating duration from bitrate/i.test(stderr)) {
      return { ok: false, reason: 'missing Xing/Info header (vbrfix output not applied?)' };
    }
    if (expectedDuration && expectedDuration > 0) {
      const tolerance = Math.max(30, expectedDuration * 0.1);
      if (Math.abs(duration - expectedDuration) > tolerance) {
        return { ok: false, reason: `duration mismatch: probed ${duration.toFixed(1)}s vs expected ${expectedDuration.toFixed(1)}s` };
      }
    }
    const claim = readMp3HeaderClaim(filePath);
    if (claim) {
      const tolerance = Math.max(4096, Math.floor(claim.claimedSize * 0.005));
      if (Math.abs(totalBytes - claim.claimedSize) > tolerance) {
        return { ok: false, reason: `size/header mismatch: file is ${totalBytes}B but Xing header claims ${claim.claimedSize}B (truncated or I/O-path merge)` };
      }
    }
    return { ok: true, reason: '' };
  } catch (err) {
    return { ok: false, reason: `validation error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** The subset of index fields the progress overlay cares about. */
interface IndexEntry {
  videoId: string;
  watched: boolean;
  ignored: boolean;
  progress: number;
  duration: number | null;
}

async function updateIndexFile() {
  try {
    console.log(`📋 Updating ${INDEX_JSON_PATH} (atomic write)`);

    const videos = await prisma.video.findMany({
      where: { ignored: false },
      // Stable ordering: publishedAt desc, then videoId asc to break ties
      // deterministically. Without the tie-breaker, videos sharing a
      // publishedAt (batched imports, grabby cluster timestamps) are returned
      // in a different order on every regeneration, so the index — and thus
      // the playlist — looks inconsistent across refreshes.
      orderBy: [{ publishedAt: 'desc' }, { videoId: 'asc' }],
      include: { channel: true }
    });

    const playlist: any[] = [];

    for (const v of videos) {
      const folder = path.join(CACHE_DIR, v.videoId);
      const jsonPath = path.join(folder, `${v.videoId}.json`);

      // Self-heal: drop grabby items whose MP3 is gone. Grabby MP3s are
      // pre-downloaded, so a missing file means the track was deleted (mid-harvest
      // here, or via the GrabbyTube UI). The stale DB row is removed too so it
      // can't be reconditioned back into the mix on the next harvest.
      if (v.isGrabby) {
        if (!fs.existsSync(path.join(folder, `${v.videoId}.mp3`))) {
          console.log(`🗑️ [Index] Dropping defunct grabby item: ${v.videoId} (no MP3)`);
          await prisma.video.deleteMany({ where: { videoId: v.videoId, isGrabby: true } });
          continue;
        }
      }

      let meta: any = { ...v }; // fallback from DB

      if (fs.existsSync(jsonPath)) {
        try {
          const fileMeta = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
          meta = { ...meta, ...fileMeta }; // prefer rich per-item JSON
        } catch (e) {
          console.warn(`⚠️ Could not read ${v.videoId}.json, using DB fallback`);
        }
      }

      // For grabby items, preserve the DB's clustered timestamp (file has original YouTube date)
      if (v.isGrabby) {
        meta.publishedAt = v.publishedAt;
      }

      // Paths are relative to CACHE_DIR — keep /cache/ prefix for nginx
      if (meta.thumbnailPath && !meta.thumbnailPath.startsWith('http')) {
        if (!meta.thumbnailPath.startsWith('/cache/')) {
          meta.thumbnailPath = `/cache/${v.videoId}/${path.basename(meta.thumbnailPath)}`;
        }
      }
      if (meta.audioPath) {
        meta.audioPath = `/cache/${v.videoId}/${v.videoId}.mp3`;
      }

      playlist.push(meta);
    }

    // ── progress.json: the only file that churns during playback ──
    // In-queue items (matches the frontend's getQueueVideos: !watched &&
    // !ignored) with partial progress — usually 0–3 items, a few hundred
    // bytes. Duration unknown → can't judge "max", so include it.
    const progressList = playlist
      .filter((m: IndexEntry) => !m.watched && !m.ignored && (m.progress || 0) > 0 &&
        (m.duration == null || m.duration <= 0 || m.progress < m.duration))
      .map((m: IndexEntry) => ({ videoId: m.videoId, progress: m.progress }));

    // ── index.json: zero the progress ──
    // Live progress lives in progress.json, so index.json stays byte-stable
    // between real state changes and 304s while a track plays.
    for (const m of playlist) m.progress = 0;

    writeIfChanged(INDEX_JSON_PATH, INDEX_TEMP_PATH,
      JSON.stringify(playlist, null, 2), `index.json (${playlist.length} items)`);
    writeIfChanged(PROGRESS_JSON_PATH, PROGRESS_TEMP_PATH,
      JSON.stringify(progressList, null, 2), `progress.json (${progressList.length} items)`);
  } catch (err: any) {
    console.error(`❌ Failed to update playlist.json:`, err.message);
  }
}

/**
 * Atomically write `content` to `destPath` via `tempPath`, skipping when the
 * existing file is byte-identical. A no-op rewrite would still bump
 * inode/mtime and change nginx's ETag, turning every unchanged regeneration
 * into a full 200 re-download instead of a free 304 revalidation.
 */
function writeIfChanged(destPath: string, tempPath: string, content: string, label: string): void {
  if (fs.existsSync(destPath) && fs.readFileSync(destPath, 'utf-8') === content) {
    console.log(`📋 ${label} unchanged — skipping write`);
    return;
  }
  fs.writeFileSync(tempPath, content, 'utf-8');
  fs.renameSync(tempPath, destPath);
  console.log(`✅ ${label} updated`);
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
async function isFilteredOutByDuration(item: any, channel?: any): Promise<boolean> {
  if (item.duration) {
    const durationFilterEnabled = (await getConfig('durationFilterEnabled', 'false')) === 'true';
    const globalMin = parseInt(await getConfig('minDurationMinutes', '0'));
    const globalMax = parseInt(await getConfig('maxDurationMinutes', '720'));

    // Per-channel overrides: null = use global, set = override that field
    const channelMin = channel?.minDuration ?? globalMin;
    const channelMax = channel?.maxDuration ?? globalMax;
    const hasChannelOverride = channel?.minDuration != null || channel?.maxDuration != null;
    const enabled = hasChannelOverride || durationFilterEnabled;

    if (enabled) {
      const durMinutes = (item.duration || 0) / 60;
      if (durMinutes < channelMin || durMinutes > channelMax) {
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
        await updateIndexFile();
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

    await updateIndexFile();
    
  } catch (err: any) {
    console.error(`❌ [ignoreVideo] Failed to ignore ${videoId}:`, err.message);
  }
}

// === SESSION GATE (ytcookies) ===
// ytcookies writes the shared cookie file's liveness next to it. While the
// session is dead, harvesting only burns yt-dlp runs against dead cookies
// (worse for keeping a session alive) and every write-back refreshes the
// file's mtime, delaying ytcookies' re-seed after a re-sign-in. Missing or
// stale file (ytcookies container down) means "don't gate".
const SESSION_STATE_FILE = '/shared-cookies/session-state.json';
const SESSION_STATE_MAX_AGE_MS = 30 * 60 * 1000; // probes run every ~10.5 min
let lastSessionGateSkipLog = 0;

function sessionGateOpen(): boolean {
  try {
    const parsed = JSON.parse(fs.readFileSync(SESSION_STATE_FILE, 'utf-8'));
    if (typeof parsed?.ts !== 'number') return true;
    if (Date.now() - parsed.ts * 1000 > SESSION_STATE_MAX_AGE_MS) return true; // ts is epoch seconds
    return parsed.state === 'up';
  } catch {
    return true;
  }
}


// === HARVESTER ===
async function harvestAndPurge() {
  if (isHarvesting) {
    console.log(`⏳ [${logTimestamp()}] Harvest already running — skipping`);
    return;
  }
  if (isImporting) {
    console.log(`⏳ [${logTimestamp()}] Import in progress — skipping harvest`);
    return;
  }

  if (!sessionGateOpen()) {
    if (Date.now() - lastSessionGateSkipLog > 10 * 60 * 1000) {
      lastSessionGateSkipLog = Date.now();
      console.log(`⏸️ [${logTimestamp()}] Cookie session dead (ytcookies state file) — skipping harvest round`);
    }
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

    const channels = await prisma.channel.findMany({ where: { active: true }, orderBy: { order: 'asc' } });
    // Skip channels with invalid channel IDs (URLs, handles, etc.)
    const validChannels = channels.filter(ch => ch.channelId.startsWith('UC'));
    if (channels.length !== validChannels.length) {
      const invalid = channels.filter(ch => !ch.channelId.startsWith('UC'));
      console.warn(`⚠️ Skipping ${invalid.length} channel(s) with invalid channelId: ${invalid.map(c => c.channelId.substring(0, 40)).join(', ')}`);
    }
    harvestStatus.totalChannels = validChannels.length;

    const queue = [...validChannels];
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
              if (await isFilteredOutByPubDate(item) || await isFilteredOutByDuration(item, currentChannel)) {
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

              if (await isFilteredOutByPubDate(item) || await isFilteredOutByDuration(item, currentChannel)) {
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
                duration: item.duration ? Number(item.duration) : undefined,
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
              await updateIndexFile();
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

    // === DISTRIBUTE GRABBY ITEMS (after harvest, before auto-purge) ===
    try {
      await distributeGrabbyItems();
    } catch (err: any) {
      console.error(`🚨 [ShuffleBag] Error distributing grabby items:`, err.message);
    }

    // === AUTO-PURGE (skip grabby items) ===
    const cutoff = new Date(Date.now() - autoPurgeDays * 24 * 60 * 60 * 1000);
    const oldVideos: Video[] = await prisma.video.findMany({
      where: { publishedAt: { lt: cutoff }, ignored: false, protected: false, isGrabby: false }
    });
    
    for (const video of oldVideos) {
      const dir = path.join(CACHE_DIR, video.videoId);
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
      await prisma.video.delete({ where: { videoId: video.videoId } });
    }
    if (oldVideos.length > 0) {
      await updateIndexFile();
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

// === HARVEST STATUS ===
app.get('/api/harvest-status', (_, res) => {
  let session = { state: 'unknown', ts: null as number | null, fresh: false };
  try {
    const parsed = JSON.parse(fs.readFileSync(SESSION_STATE_FILE, 'utf-8'));
    const ts: number | null = typeof parsed?.ts === 'number' ? parsed.ts : null;
    session = {
      state: typeof parsed?.state === 'string' ? parsed.state : 'unknown',
      ts,
      fresh: ts !== null && Date.now() - ts * 1000 <= SESSION_STATE_MAX_AGE_MS,
    };
  } catch {
    // no state file (ytcookies down): report unknown, don't fail the request
  }
  res.json({ ...harvestStatus, session });
});

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

  // NEW: GrabbyTube shufflebag mix
  const grabbyMixEnabled = await getConfig('grabbyMixEnabled', 'true');
  const grabbyMixRatio = await getConfig('grabbyMixRatio', '3');
  const grabbyClusterMaxSize = await getConfig('grabbyClusterMaxSize', '0');

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
    maxDurationMinutes: parseInt(maxDurationMinutes),
    // NEW GrabbyTube shufflebag mix
    grabbyMixEnabled: grabbyMixEnabled === 'true',
    grabbyMixRatio: parseInt(grabbyMixRatio),
    grabbyClusterMaxSize: parseInt(grabbyClusterMaxSize)
  });
});

app.post('/api/config', async (req, res) => {
  const { maxHarvestDays, preferredBitrate, preferredMono, autoPurgeDays, userAgent, cookies,
    limitEnabled, limitVideos, limitHours,
    alternativeMetadataEnabled, scrapeVideosTab, scrapeStreamsTab, scrapeShortsTab,
    // NEW duration filter
    durationFilterEnabled, minDurationMinutes, maxDurationMinutes,
    // NEW GrabbyTube shufflebag mix
    grabbyMixEnabled, grabbyMixRatio, grabbyClusterMaxSize } = req.body;

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

  // NEW GrabbyTube shufflebag mix config
  if (grabbyMixEnabled !== undefined) await setConfig('grabbyMixEnabled', String(grabbyMixEnabled));
  if (grabbyMixRatio !== undefined) await setConfig('grabbyMixRatio', String(grabbyMixRatio));
  if (grabbyClusterMaxSize !== undefined) await setConfig('grabbyClusterMaxSize', String(grabbyClusterMaxSize));

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

app.patch('/api/channels/:channelId/active', async (req, res) => {
  const { active } = req.body as { active: boolean };
  await prisma.channel.update({
    where: { channelId: req.params.channelId },
    data: { active }
  });
  console.log(`${active ? '✅' : '⏸️'} [CHANNEL] ${req.params.channelId} → active=${active}`);
  res.json({ success: true });
});

app.patch('/api/channels/:channelId/duration', async (req, res) => {
  const { minDuration, maxDuration } = req.body as { minDuration: number | null; maxDuration: number | null };
  const data: { minDuration?: number | null; maxDuration?: number | null } = {};
  if (minDuration !== undefined) data.minDuration = minDuration;
  if (maxDuration !== undefined) data.maxDuration = maxDuration;
  if (Object.keys(data).length === 0) return res.status(400).json({ success: false, error: 'No fields to update' });
  const result = await prisma.channel.update({
    where: { channelId: req.params.channelId },
    data,
  });
  console.log(`⏱️ [CHANNEL] ${req.params.channelId} → min=${result.minDuration}, max=${result.maxDuration}`);
  res.json({ success: true });
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

  // Protect the GrabbyTube placeholder channel from deletion
  if (channelId === GRABBY_CHANNEL_ID) {
    console.log(`🛡️ Refusing to delete GrabbyTube placeholder channel`);
    return res.status(403).json({ error: 'Cannot delete GrabbyTube channel' });
  }

  try {
    const videos = await prisma.video.findMany({
      where: { channelId, isGrabby: false },
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
      where: { channelId, isGrabby: false }
    });
    console.log(`   ✅ Deleted ${deletedVideos.count} video records (grabby items preserved)`);

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
      await updateIndexFile();
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


// === URL CLASSIFICATION ===

type ImportItemType = 'channel' | 'video';

interface ParsedImportItem {
  type: ImportItemType;
  videoId?: string;
  channelId?: string;
  originalInput: string;
  isHandle?: boolean;
}

function classifyYouTubeUrl(input: string): ParsedImportItem | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Direct channel ID (UC...)
  if (/^UC[A-Za-z0-9_-]{22}$/.test(trimmed)) {
    return { type: 'channel', channelId: trimmed, originalInput: trimmed };
  }

  // Video URL: youtube.com/watch?v=VIDEO_ID
  const watchMatch = trimmed.match(/youtube\.com\/watch\?.*v=([A-Za-z0-9_-]{11})/);
  if (watchMatch) {
    return { type: 'video', videoId: watchMatch[1], originalInput: trimmed };
  }

  // Video URL: youtu.be/VIDEO_ID
  const shortMatch = trimmed.match(/youtu\.be\/([A-Za-z0-9_-]{11})/);
  if (shortMatch) {
    return { type: 'video', videoId: shortMatch[1], originalInput: trimmed };
  }

  // Video URL: youtube.com/shorts/VIDEO_ID
  const shortsMatch = trimmed.match(/youtube\.com\/shorts\/([A-Za-z0-9_-]{11})/);
  if (shortsMatch) {
    return { type: 'video', videoId: shortsMatch[1], originalInput: trimmed };
  }

  // Channel URL: youtube.com/channel/CHANNEL_ID
  const channelMatch = trimmed.match(/youtube\.com\/channel\/([A-Za-z0-9_-]+)/);
  if (channelMatch) {
    return { type: 'channel', channelId: channelMatch[1], originalInput: trimmed };
  }

  // Channel handle: youtube.com/@HANDLE or youtube.com/c/HANDLE or youtube.com/user/HANDLE
  const handleMatch = trimmed.match(/youtube\.com\/(?:@|c\/|user\/)([A-Za-z0-9_-]+)/);
  if (handleMatch) {
    return { type: 'channel', channelId: handleMatch[1], originalInput: trimmed, isHandle: true };
  }

  // Fallback: treat as channel ID (existing behavior)
  return { type: 'channel', channelId: trimmed, originalInput: trimmed };
}

// Resolve @handle, /c/name, /user/name to actual UC... channel ID using yt-dlp.
// Probes the channel page, then falls back to listing videos to find a real UC... ID.
async function resolveChannelHandle(handle: string): Promise<string | null> {
  const normalized = handle.startsWith('@') ? handle : '@' + handle;
  const url = `https://www.youtube.com/${normalized}`;

  // Strategy 1: probe the channel page for channel_id / uploader_url
  try {
    const base = await getBaseYtDlpCommand();
    const cmd = `${base} --skip-download --dump-json "${url}" 2>/dev/null | head -1`;
    const { stdout } = await safeExec(cmd, `resolve handle ${normalized}`);
    const info = JSON.parse(stdout);

    // Extract UC... from any available field
    const extracted = extractChannelId(info);
    if (extracted) return extracted;

    // channel_id might be the handle itself — not useful
    if (info.channel_id && info.channel_id.startsWith('UC')) return info.channel_id;
  } catch {
    console.warn(`[resolveChannelHandle] Strategy 1 failed for ${normalized}`);
  }

  // Strategy 2: list channel videos and grab channel_id from the first video
  try {
    const playlistUrl = `https://www.youtube.com/${normalized}/videos`;
    const base2 = await getBaseYtDlpCommand();
    const cmd = `${base2} --flat-playlist --dump-json "${playlistUrl}" 2>/dev/null | head -1`;
    const { stdout } = await safeExec(cmd, `resolve handle via playlist ${normalized}`);
    const videoInfo = JSON.parse(stdout);
    const extracted = extractChannelId(videoInfo);
    if (extracted) return extracted;
    if (videoInfo.channel_id && videoInfo.channel_id.startsWith('UC')) return videoInfo.channel_id;
  } catch {
    console.warn(`[resolveChannelHandle] Strategy 2 failed for ${normalized}`);
  }

  console.warn(`[resolveChannelHandle] Could not resolve "${normalized}" to a UC... ID`);
  return null;
}

// Extract a UC... channel ID from yt-dlp metadata.
// Tries channel_id, uploader_url, channel_url, url fields.
// Returns null if no valid UC... ID can be extracted.
function extractChannelId(info: any): string | null {
  // Helper: extract UC... from a string that might contain it
  function tryExtract(str: string): string | null {
    if (!str || typeof str !== 'string') return null;
    // Already a UC... ID
    if (str.startsWith('UC') && /^[A-Za-z0-9_-]+$/.test(str)) return str;
    // In a channel URL: /channel/UCxxxxxxxxxxxxxx
    const m = str.match(/(?:^|\/|channel=)(UC[A-Za-z0-9_-]{22})/);
    if (m) return m[1];
    return null;
  }

  // 1. channel_id — often the UC... ID directly
  const found = tryExtract(info.channel_id);
  if (found) return found;

  // 2. uploader_url — e.g. "https://www.youtube.com/channel/UCxxxxxxxxxxxxxx"
  const found2 = tryExtract(info.uploader_url);
  if (found2) return found2;

  // 3. channel_url
  const found3 = tryExtract(info.channel_url);
  if (found3) return found3;

  return null;
}

// Get channel info from a video using yt-dlp.
// Returns { channelId (UC...), channelTitle, videoTitle } or null.
async function getChannelFromVideo(videoId: string): Promise<{ channelId: string; channelTitle: string; videoTitle: string } | null> {
  try {
    const base = await getBaseYtDlpCommand();
    const cmd = `${base} --skip-download --dump-json "https://www.youtube.com/watch?v=${videoId}" 2>/dev/null`;
    const { stdout } = await safeExec(cmd, `get channel for video ${videoId}`);
    const trimmed = stdout.trim();

    if (!trimmed) {
      console.warn(`[IMPORT] yt-dlp returned empty output for video ${videoId} (age-gated? blocked?)`);
      return null;
    }

    // yt-dlp --dump-json outputs a single JSON object; find the line that starts with {
    const jsonLine = trimmed.split('\n').find(l => l.trim().startsWith('{'));
    if (!jsonLine) {
      console.warn(`[IMPORT] No JSON found in yt-dlp output for video ${videoId}`);
      return null;
    }
    const info = JSON.parse(jsonLine);

    // Extract UC... channel ID
    let channelId = extractChannelId(info);

    // Fallback: if channel_id is a handle (not UC...), resolve it
    if (!channelId && info.channel_id && typeof info.channel_id === 'string' && !info.channel_id.startsWith('UC')) {
      console.log(`[IMPORT] channel_id is a handle "${info.channel_id}" — resolving via yt-dlp...`);
      const handle = info.channel_id.startsWith('@') ? info.channel_id : '@' + info.channel_id;
      const resolved = await resolveChannelHandle(handle);
      if (resolved) channelId = resolved;
    }

    if (!channelId) {
      console.warn(`[IMPORT] Could not extract channel ID for video ${videoId}: channel_id=${JSON.stringify(info.channel_id)}, uploader_url=${JSON.stringify(info.uploader_url)}, channel_url=${JSON.stringify(info.channel_url)}`);
      return null;
    }

    console.log(`[IMPORT] Video ${videoId} -> Channel ${channelId} (${info.channel || info.uploader || 'Unknown'})`);

    return {
      channelId,
      channelTitle: info.channel || info.uploader || 'Unknown Channel',
      videoTitle: info.title || 'Untitled'
    };
  } catch (err: any) {
    console.error(`Failed to get channel info for video ${videoId}:`, err.message);
    return null;
  }
}


// === SINGLE VIDEO IMPORT ===
async function importSingleVideo(
  videoId: string,
  channelId: string,
  channelTitle: string,
  videoTitle: string
): Promise<{ success: boolean; reason?: string }> {
  // Already exists? Unignore, then check if we need to re-download.
  const existing = await prisma.video.findUnique({ where: { videoId } });
  const videoExisted = !!existing;
  const originalPublishedAt = existing?.publishedAt;
  if (existing) {
    console.log(`[IMPORT] Video ${videoId} already exists — unignoring, checking cache`);
    await prisma.video.update({
      where: { videoId },
      data: { ignored: false, protected: true }
    });
    // Check if cached files exist and DB has valid paths — skip download if so
    const videoDir = path.join(CACHE_DIR, videoId);
    const dbAudioPath = existing.audioPath || null;
    const filesExist = dbAudioPath && fs.existsSync(dbAudioPath) && fs.existsSync(videoDir);
    if (filesExist) {
      console.log(`[IMPORT] Cache files exist for ${videoId} — skipping download`);
      await updateIndexFile();
      return { success: true, reason: 'already-exists' };
    }
    // Files missing — fall through to download
    console.log(`[IMPORT] Cache files missing for ${videoId} — downloading`);
  }

  const preferredBitrate = parseInt(await getConfig('preferredBitrate', '128'));
  const preferredMono = (await getConfig('preferredMono', 'false')) === 'true';

  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const videoInfo = {
    videoId,
    channelId,
    title: videoTitle,
    author: channelTitle,
    publishedAt: new Date()
  };

  const success = await downloadAndProcessVideo(
    videoInfo,
    videoUrl,
    preferredBitrate,
    preferredMono
  );

  if (!success) {
    return { success: false, reason: 'download-failed' };
  }

  // Build DB record
  const videoDir = path.join(CACHE_DIR, videoId);
  const audioPath = path.join(videoDir, `${videoId}.mp3`);

  let thumbnailPath: string | null = null;
  try {
    const files = fs.readdirSync(videoDir);
    const thumbFile = files.find(f => f.endsWith('-small.webp')) ||
                      files.find(f => /\.(jpe?g|webp|png)$/i.test(f));
    if (thumbFile) thumbnailPath = `/cache/${videoId}/${thumbFile}`;
  } catch { }

  const duration = await getAudioDuration(audioPath) || undefined;

  const dbVideo = {
    videoId,
    channelId,
    title: videoTitle,
    publishedAt: new Date(),
    thumbnailPath,
    audioPath,
    duration,
    protected: true
  };

  // Use upsert — handles both new videos and existing videos that needed re-download
  // For existing videos, preserve the original publishedAt
  const updateData = videoExisted && originalPublishedAt ? { ...dbVideo, publishedAt: originalPublishedAt } : dbVideo;
  await prisma.video.upsert({
    where: { videoId },
    create: dbVideo,
    update: updateData
  });

  // Write metadata JSON
  const jsonPath = path.join(videoDir, `${videoId}.json`);
  try {
    fs.writeFileSync(jsonPath, JSON.stringify(dbVideo, null, 2), 'utf-8');
  } catch { }

  await updateIndexFile();
  console.log(`[IMPORT] Added video ${videoId} (${videoTitle}) from ${channelTitle}`);
  return { success: true };
}


app.post('/api/import', async (req, res) => {
  const { items } = req.body as { items: string[] };
  const results: any[] = [];

  if (isImporting) {
    return res.status(409).json({ error: 'Import already in progress' });
  }
  if (isHarvesting) {
    return res.status(409).json({ error: 'Harvest in progress — try again later' });
  }
  isImporting = true;
  try {
    // Phase 1: Parse and classify all inputs
    const parsed: ParsedImportItem[] = [];
    for (const raw of items) {
      const item = classifyYouTubeUrl(raw);
      if (item) parsed.push(item);
    }

    const channelImports = parsed.filter(i => i.type === 'channel');
    const videoImports = parsed.filter(i => i.type === 'video');

    // Track newly added channels
    const newlyAddedChannels = new Map<string, string>();

    // === Phase 2: Process channel imports ===
    let currentOrder = (await prisma.channel.aggregate({ _max: { order: true } }))._max.order ?? 0;

    for (const ch of channelImports) {
      let channelId = ch.channelId!;

      // Resolve @handle / c/name to UC... ID if needed
      if (ch.isHandle) {
        const resolved = await resolveChannelHandle(channelId);
        if (!resolved) {
          results.push({ input: ch.originalInput, type: 'channel', status: 'failed', reason: 'Could not resolve handle' });
          continue;
        }
        channelId = resolved;
      }

      // Already exists?
      if (await prisma.channel.findUnique({ where: { channelId } })) {
        results.push({ input: ch.originalInput, type: 'channel', status: 'skipped', reason: 'already exists' });
        continue;
      }

      try {
        const { channelTitle } = await getRssFeedWithCache(channelId);
        currentOrder += 1;
        await prisma.channel.create({
          data: { channelId, title: channelTitle, order: currentOrder, ignoreScrapeDone: false, active: true }
        });
        newlyAddedChannels.set(ch.originalInput, channelId);
        results.push({ input: ch.originalInput, type: 'channel', status: 'added', title: channelTitle, channelId });
        console.log(`[IMPORT] Added channel ${channelId} (${channelTitle})`);
      } catch (e: any) {
        results.push({ input: ch.originalInput, type: 'channel', status: 'failed', reason: e.message?.substring(0, 100) });
      }

      await new Promise(r => setTimeout(r, 500));
    }

    // === Phase 3: Process video imports ===
    const videoChannelCache = new Map<string, { channelId: string; channelTitle: string; videoTitle: string }>();

    for (const vid of videoImports) {
      const videoId = vid.videoId!;

      try {
        // Get channel info for this video (cache to avoid repeated yt-dlp calls)
        let channelInfo: { channelId: string; channelTitle: string; videoTitle: string } | undefined =
          videoChannelCache.get(videoId);
        if (!channelInfo) {
          const fetched = await getChannelFromVideo(videoId);
          if (fetched) {
            channelInfo = fetched;
            videoChannelCache.set(videoId, fetched);
          }
        }

        if (!channelInfo) {
          results.push({ input: vid.originalInput, type: 'video', status: 'failed', reason: 'Could not fetch video info' });
          continue;
        }

        // Check if channel exists, if not create as inactive
        const existingChannel = await prisma.channel.findUnique({
          where: { channelId: channelInfo.channelId }
        });

        if (!existingChannel) {
          currentOrder += 1;
          await prisma.channel.create({
            data: {
              channelId: channelInfo.channelId,
              title: channelInfo.channelTitle,
              order: currentOrder,
              active: false,
              ignoreScrapeDone: false
            }
          });
          console.log(`[IMPORT] Created inactive channel ${channelInfo.channelId} (${channelInfo.channelTitle}) for video import`);
        }

        // Download and protect the video
        const result = await importSingleVideo(
          videoId,
          channelInfo.channelId,
          channelInfo.channelTitle,
          channelInfo.videoTitle
        );

        if (result.success) {
          results.push({
            input: vid.originalInput,
            type: 'video',
            status: result.reason === 'already-exists' ? 'skipped' : 'added',
            title: channelInfo.videoTitle,
            channelTitle: channelInfo.channelTitle,
            reason: result.reason
          });
        } else {
          results.push({
            input: vid.originalInput,
            type: 'video',
            status: 'failed',
            reason: result.reason || 'Download failed'
          });
        }
      } catch (e: any) {
        results.push({ input: vid.originalInput, type: 'video', status: 'failed', reason: e.message?.substring(0, 100) });
      }

      await new Promise(r => setTimeout(r, 500));
    }
  } finally {
    isImporting = false;
  }
  res.json({ success: true, results });
});

// Legacy alias for backward compatibility
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
        data: { channelId, title: channelTitle, order: currentOrder, ignoreScrapeDone: false }
      });
      results.push({ channelId, status: 'added', title: channelTitle });
    } catch (e: any) {
      results.push({ channelId, status: 'failed' });
    }
    await new Promise(r => setTimeout(r, 800));
  }

  res.json({ success: true, results });
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
    await updateIndexFile();
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
    await updateIndexFile();
    res.json({ success: true });
  } catch (e: any) {
    console.error(`❌ Failed to mark watched:`, e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.patch('/api/video/:videoId/watched', async (req, res) => {
  const { watched } = req.body as { watched: boolean };
  try {
    const result = await prisma.video.updateMany({
      where: { videoId: req.params.videoId },
      data: { watched }
    });
    if (result.count === 0) {
      console.warn(`⚠️ Toggle watched skipped — video ${req.params.videoId} not found`);
    }
    await updateIndexFile();
    res.json({ success: true });
  } catch (e: any) {
    console.error(`❌ Failed to toggle watched:`, e.message);
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
  console.log(`🗑️ [PURGE-ALL] Starting purge of non-ignored, non-grabby videos only`);

  if (fs.existsSync(CACHE_DIR)) {
    const nonIgnoredVideos = await prisma.video.findMany({
      where: { ignored: false, protected: false, isGrabby: false },
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
    where: { ignored: false, protected: false, isGrabby: false }
  });
  await updateIndexFile();
  console.log(`✅ Purge complete — ${deletedCount.count} non-ignored videos removed (grabby items preserved)`);
  res.json({ success: true, deletedCount: deletedCount.count });
});

app.patch('/api/video/:videoId/protect', async (req, res) => {
  const { videoId } = req.params;
  const { protected: isProtected } = req.body;

  const video = await prisma.video.findUnique({ where: { videoId } });
  if (!video) return res.status(404).json({ error: 'Video not found' });

  await prisma.video.update({
    where: { videoId },
    data: { protected: isProtected }
  });

  console.log(`${isProtected ? '🔒' : '🔓'} [PROTECT] ${videoId} → ${isProtected}`);
  await updateIndexFile();
  res.json({ success: true, protected: isProtected });
});

app.delete('/api/video/:videoId/grabby', async (req, res) => {
  const { videoId } = req.params;

  // No concurrency lock here — delete-during-harvest is allowed on purpose.
  // The only race (harvest inserting a DB row for a track whose MP3 was just
  // deleted) is neutralized by updateIndexFile()'s defunct-grabby filter, which
  // also self-heals deletes made directly from the GrabbyTube UI.

  const video = await prisma.video.findUnique({ where: { videoId } });
  if (!video) return res.status(404).json({ error: 'Video not found' });
  if (!video.isGrabby) return res.status(400).json({ success: false, error: 'Not a GrabbyTube item' });

  // Remote delete (GrabbyTube owns its catalog/index/files — single writer).
  // 200 = deleted, 404 = already gone remotely (treat as success).
  const grabbyUrl = `http://grabbytube:8101/tracks/${videoId}`;
  let remote: 'deleted' | 'already-gone' | 'error';
  try {
    const r = await fetch(grabbyUrl, {
      method: 'DELETE',
      headers: { 'X-Grabby-Token': process.env.GRABBY_API_TOKEN || '' },
      signal: AbortSignal.timeout(15000)
    });
    if (r.ok) remote = 'deleted';
    else if (r.status === 404) remote = 'already-gone';
    else {
      console.error(`❌ [GRABBY-DELETE] Remote delete ${videoId} failed: HTTP ${r.status}`);
      return res.status(502).json({ success: false, error: `GrabbyTube delete failed (HTTP ${r.status}) — nothing was deleted` });
    }
  } catch (e: any) {
    console.error(`❌ [GRABBY-DELETE] GrabbyTube unreachable for ${videoId}:`, e.message);
    return res.status(502).json({ success: false, error: 'GrabbyTube unreachable — nothing was deleted' });
  }

  // Local cleanup — only after the remote side succeeded (fail-closed).
  const deleted = await prisma.video.deleteMany({ where: { videoId, isGrabby: true } });

  // Remove from shufflebag so it can't be re-distributed
  if (fs.existsSync(SHUFFLEBAG_JSON_PATH)) {
    try {
      const bag: ShuffleBagEntry[] = JSON.parse(fs.readFileSync(SHUFFLEBAG_JSON_PATH, 'utf-8'));
      const filtered = bag.filter(e => e.videoId !== videoId);
      if (filtered.length !== bag.length) {
        fs.writeFileSync(SHUFFLEBAG_JSON_PATH, JSON.stringify(filtered, null, 2));
      }
    } catch (e: any) {
      console.warn(`⚠️ [GRABBY-DELETE] Could not prune shufflebag:`, e.message);
    }
  }

  await updateIndexFile();
  console.log(`🗑️ [GRABBY-DELETE] ${videoId} → remote: ${remote}, local records removed: ${deleted.count}`);
  res.json({ success: true, deleted: videoId, remote, localRecords: deleted.count });
});

app.get('/api/stream/:videoId', async (req, res) => {
  const video = await prisma.video.findUnique({ where: { videoId: req.params.videoId } });
  if (!video || !fs.existsSync(video.audioPath)) return res.status(404).send('Video not found');
  res.sendFile(video.audioPath);
});

// === START ===
initShuffleBag().then(() => {
  console.log(`🎵 [ShuffleBag] Startup init complete`);
});

cron.schedule('*/5 * * * *', harvestAndPurge);
harvestAndPurge();

app.listen(port, () => {
  console.log(`🚀 DrivePod Backend ready on http://localhost:${port}`);
  console.log(`   Cache: ` + CACHE_DIR);
  console.log(`   Data:  ` + DATA_DIR);
});