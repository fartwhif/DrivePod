#!/usr/bin/env node
/**
 * T1 — Live content audit: is any content being MISSED?
 *
 * Read-only check of the live DB + cache + index.json + progress.json.
 * "Content missed" = something that should be in the user's queue is not
 * reachable: on disk but not in the DB/index, in the index but with no
 * playable file, progress/ordering invariants broken, or structurally
 * unreachable by autoplay.
 *
 * Hard failures (exit 1): A1-A9, A11. Informational: A10, A12-A14.
 *
 * Usage: node tests/content-audit.mjs  (run from repo root)
 */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const ROOT = path.resolve(import.meta.dirname, '..');
// Resolve @prisma/client from the backend install without a root-level
// node_modules symlink.
const require = createRequire(import.meta.url);
const { PrismaClient } = require(path.join(ROOT, 'backend/node_modules/@prisma/client/index.js'));

const CACHE_DIR = path.join(ROOT, 'cache');
const DB_URL = `file:${path.join(ROOT, 'data', 'database.db')}`;

const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });

let failures = 0;
const fail = (tag, msg) => { failures++; console.log(`  ✗ FAIL [${tag}] ${msg}`); };
const ok = (tag, msg) => console.log(`  ✓ [${tag}] ${msg}`);
const info = (tag, msg) => console.log(`  · [${tag}] ${msg}`);

function loadJson(p, label) {
  if (!fs.existsSync(p)) { fail('io', `${label} missing: ${p}`); return null; }
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); }
  catch (e) { fail('io', `${label} unparseable: ${e.message}`); return null; }
}

const index = loadJson(path.join(CACHE_DIR, 'index.json'), 'index.json');
const progress = loadJson(path.join(CACHE_DIR, 'progress.json'), 'progress.json');
const bag = loadJson(path.join(CACHE_DIR, 'shufflebag.json'), 'shufflebag.json') ?? [];
const grabbyIndex = loadJson(path.join(CACHE_DIR, 'grabby-index.json'), 'grabby-index.json') ?? [];

if (!index) { console.log('Aborting — no index to audit'); process.exit(1); }

const [videos, channels] = await Promise.all([
  prisma.video.findMany({ select: { videoId: true, channelId: true, title: true, publishedAt: true, watched: true, ignored: true, protected: true, isGrabby: true, duration: true, progress: true, audioPath: true } }),
  prisma.channel.findMany({ select: { channelId: true, title: true, active: true } }),
]);
await prisma.$disconnect();

const videoById = new Map(videos.map(v => [v.videoId, v]));
const dbNonIgnored = new Set(videos.filter(v => !v.ignored).map(v => v.videoId));
const indexIds = index.map(e => e.videoId);
const indexSet = new Set(indexIds);

console.log(`\n== T1 Live content audit ==`);
console.log(`DB videos: ${videos.length} (non-ignored ${dbNonIgnored.size}) | index: ${index.length} | progress: ${progress.length} | bag: ${bag.length} | grabby-index: ${grabbyIndex.length}\n`);

// ── A1: DB(non-ignored) ↔ index.json exact set equality ──
{
  const missingFromIndex = [...dbNonIgnored].filter(id => !indexSet.has(id));
  const extraInIndex = indexIds.filter(id => !videoById.has(id));
  if (missingFromIndex.length) fail('A1', `${missingFromIndex.length} non-ignored DB video(s) missing from index.json: ${missingFromIndex.slice(0, 8).join(', ')}${missingFromIndex.length > 8 ? '…' : ''}`);
  else ok('A1', 'every non-ignored DB video is in index.json');
  if (extraInIndex.length) fail('A1b', `${extraInIndex.length} index entries with NO DB row (ghost content): ${extraInIndex.slice(0, 8).join(', ')}`);
  else ok('A1b', 'no index entries without a DB row');
}

// ── A2: every index entry has a real, sane MP3 at its advertised path ──
{
  const missing = [];
  const corruptHead = [];
  for (const e of index) {
    const p = path.join(CACHE_DIR, e.videoId, `${e.videoId}.mp3`);
    if (!fs.existsSync(p) || fs.statSync(p).size === 0) { missing.push(e.videoId); continue; }
    const fd = fs.openSync(p, 'r');
    const head = Buffer.alloc(4);
    fs.readSync(fd, head, 0, 4, 0); fs.closeSync(fd);
    const isId3 = head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33;
    const isSync = head[0] === 0xFF && (head[1] & 0xE0) === 0xE0;
    if (!isId3 && !isSync) corruptHead.push(e.videoId);
  }
  if (missing.length) fail('A2', `${missing.length} index entr${missing.length === 1 ? 'y' : 'ies'} with missing/empty MP3 (queued but unplayable): ${missing.slice(0, 8).join(', ')}`);
  else ok('A2', 'all index entries have a non-empty MP3');
  if (corruptHead.length) fail('A2b', `${corruptHead.length} MP3s with junk head (zero-hole/sync-merge artifact): ${corruptHead.slice(0, 8).join(', ')}`);
  else ok('A2b', 'no MP3 head corruption');
}

// ── A3: orphan folders — content on disk but absent from the DB (missed from queue) ──
{
  const orphanMp3 = [], orphanGrabby = [];
  for (const entry of fs.readdirSync(CACHE_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'rss') continue;
    const id = entry.name;
    const mp3 = path.join(CACHE_DIR, id, `${id}.mp3`);
    if (!fs.existsSync(mp3)) continue;
    if (videoById.has(id)) continue;
    const meta = path.join(CACHE_DIR, id, `${id}.json`);
    const isGrabbyMeta = fs.existsSync(meta) && (() => { try { return !!JSON.parse(fs.readFileSync(meta, 'utf-8')).videoId; } catch { return false; } })();
    (isGrabbyMeta ? orphanGrabby : orphanMp3).push(id);
  }
  if (orphanMp3.length) fail('A3', `${orphanMp3.length} folder(s) with MP3 but NO DB row — content missed from queue (cleanup will delete them): ${orphanMp3.slice(0, 8).join(', ')}`);
  else ok('A3', 'no non-grabby orphan folders with MP3');
  if (orphanGrabby.length) info('A3b', `${orphanGrabby.length} grabby folder(s) with MP3 but no DB row (protected by cleanup; only reachable via re-distribution): ${orphanGrabby.slice(0, 5).join(', ')}`);
  else ok('A3b', 'no grabby orphan folders');
}

// ── A4: progress.json consistent with the queue and the backend filter ──
{
  const byId = new Map(index.map(e => [e.videoId, e]));
  const bad = [], badState = [];
  for (const p of progress) {
    if (typeof p.progress !== 'number' || p.progress <= 0) { bad.push(p.videoId); continue; }
    const e = byId.get(p.videoId);
    if (!e) { bad.push(p.videoId); continue; }
    const inQueue = !e.watched && !e.ignored;
    const partial = e.duration == null || e.duration <= 0 || p.progress < e.duration;
    if (!inQueue || !partial) badState.push(p.videoId);
  }
  if (bad.length) fail('A4', `${bad.length} progress entries invalid or for absent index items: ${bad.slice(0, 8).join(', ')}`);
  else ok('A4', 'all progress entries are for valid queue items');
  if (badState.length) fail('A4b', `${badState.length} progress entries for non-queue/complete items: ${badState.slice(0, 8).join(', ')}`);
  else ok('A4b', 'progress entries all in-queue and partial');
}

// ── A5: index ordering — publishedAt desc, tie → videoId asc ──
{
  let violations = 0, firstBad = null;
  for (let i = 1; i < index.length; i++) {
    const a = index[i - 1], b = index[i];
    const ta = new Date(a.publishedAt).getTime(), tb = new Date(b.publishedAt).getTime();
    const outOfOrder = tb > ta || (tb === ta && b.videoId < a.videoId);
    if (outOfOrder && (violations === 0 || !firstBad)) firstBad = `${a.videoId}→${b.videoId}`;
    if (outOfOrder) violations++;
  }
  if (violations) fail('A5', `index ordering violations: ${violations} (first: ${firstBad})`);
  else ok('A5', 'index ordering invariant holds (publishedAt desc, videoId asc)');
}

// ── A6: publishedAt must be finite — frontend sorts by new Date(publishedAt) ──
{
  const bad = index.filter(e => !Number.isFinite(new Date(e.publishedAt).getTime()));
  if (bad.length) fail('A6', `${bad.length} index entries with non-parseable publishedAt (frontend sort NaN): ${bad.slice(0, 5).map(e => e.videoId).join(', ')}`);
  else ok('A6', 'all index publishedAt values parse to finite dates');
}

// ── A7: index.json must carry progress=0 (byte-stability contract) ──
{
  const nonzero = index.filter(e => e.progress !== 0);
  if (nonzero.length) fail('A7', `${nonzero.length} index entries with progress != 0 (breaks 304/ETag stability): ${nonzero.slice(0, 5).map(e => e.videoId).join(', ')}`);
  else ok('A7', 'index entries all carry progress=0');
}

// ── A8: grabby path contract — DB audioPath AND index path must both resolve ──
{
  const missingDbPath = [], missingIndexPath = [];
  for (const v of videos) {
    if (!v.isGrabby) continue;
    if (!fs.existsSync(v.audioPath)) missingDbPath.push(v.videoId);
    if (!fs.existsSync(path.join(CACHE_DIR, v.videoId, `${v.videoId}.mp3`))) missingIndexPath.push(v.videoId);
  }
  // Resolver semantics (resolveGrabbyAudioPath): a stale absolute audioPath
  // written by GrabbyTube on another host is OK as long as the canonical
  // {id}/{id}.mp3 exists — the backend falls back to it at read time.
  const brokenSet = new Set();
  for (const g of grabbyIndex) {
    const literal = path.isAbsolute(g.audioPath) ? g.audioPath : path.join(CACHE_DIR, g.audioPath);
    const canonical = path.join(CACHE_DIR, g.videoId, `${g.videoId}.mp3`);
    if (!fs.existsSync(literal) && !fs.existsSync(canonical)) brokenSet.add(g.videoId);
  }
  if (missingDbPath.length) fail('A8', `${missingDbPath.length} grabby DB rows whose audioPath (served by /api/stream) does not exist: ${missingDbPath.slice(0, 8).join(', ')}`);
  else ok('A8', 'all grabby DB audioPaths exist on disk');
  if (missingIndexPath.length) fail('A8b', `${missingIndexPath.length} grabby rows without the canonical /cache/{id}/{id}.mp3 the index advertises: ${missingIndexPath.slice(0, 8).join(', ')}`);
  else ok('A8b', 'all grabby rows have the canonical mp3 path');
  // A dead ref is only a problem if a LIVE (non-ignored) row points at it
  // (that already fails A11). Otherwise the file is gone and the entry is
  // correctly excluded from the shufflebag; GrabbyTube owns the index.
  const brokenLive = videos.filter(v => !v.ignored && brokenSet.has(v.videoId)).map(v => v.videoId);
  if (brokenLive.length) fail('A8c', `live (non-ignored) DB rows whose file is gone everywhere: ${brokenLive.slice(0, 8).join(', ')}`);
  else info('A8c', `${brokenSet.size} dead grabby-index refs (file deleted, rows ignored) — excluded from shufflebag by design`);
}

// ── A9: shufflebag reachability ──
{
  const grabbySet = new Set(grabbyIndex.map(g => g.videoId));
  const dbSet = new Set(videos.map(v => v.videoId));
  const staleBag = bag.filter(e => !grabbySet.has(e.videoId) && !dbSet.has(e.videoId)).map(e => e.videoId);
  if (staleBag.length) fail('A9', `${staleBag.length} stale shufflebag entries (in bag, in neither DB nor grabby-index — wasted pulls): ${staleBag.slice(0, 8).join(', ')}`);
  else ok('A9', 'no stale shufflebag entries');
  const resolvable = g => { const lit = path.isAbsolute(g.audioPath) ? g.audioPath : path.join(CACHE_DIR, g.audioPath); return fs.existsSync(lit) || fs.existsSync(path.join(CACHE_DIR, g.videoId, `${g.videoId}.mp3`)); };
  const unreachable = grabbyIndex.filter(g => !dbSet.has(g.videoId) && !bag.some(e => e.videoId === g.videoId) && resolvable(g)).length;
  info('A9b', `${unreachable} grabby-index tracks currently reachable only after bag re-init (ratio may already be satisfied — informational)`);
}

// ── A11: every non-ignored DB row's audioPath (the real /api/stream target) exists ──
{
  const missing = videos.filter(v => !v.ignored && !fs.existsSync(v.audioPath)).map(v => v.videoId);
  if (missing.length) fail('A11', `${missing.length} non-ignored DB rows whose audioPath does not exist (/api/stream 404s): ${missing.slice(0, 8).join(', ')}`);
  else ok('A11', 'all non-ignored DB audioPaths exist');
}

// ── A10: same-timestamp cluster census (info). Autoplay since 2026-10-16
// uses <=/>= with finishedId exclusion, so cluster siblings ARE reachable;
// the ordering guarantee (A5) is what makes the autoplay walk total. ──
{
  const queue = index.filter(e => !e.watched && !e.ignored);
  const clusters = new Map();
  for (const e of queue) {
    const t = new Date(e.publishedAt).getTime();
    if (!clusters.has(t)) clusters.set(t, []);
    clusters.get(t).push(e.videoId);
  }
  const big = [];
  for (const [t, ids] of clusters) {
    if (ids.length >= 3) big.push([new Date(t).toISOString(), ids.length]);
  }
  info('A10', `queue=${queue.length}; same-timestamp clusters≥2: ${[...clusters.values()].filter(a => a.length >= 2).length} (autoplay covers these via <=/>= + finishedId exclusion)`);
  if (big.length) info('A10b', `clusters≥3: ${big.map(([t, n]) => `${t}×${n}`).join(', ')}`);
}

// ── A12: silent active channels (no non-ignored content at all) ──
{
  const chanVideos = new Set(videos.filter(v => !v.ignored && !v.isGrabby).map(v => v.channelId));
  const grabbyChan = new Set(videos.filter(v => v.isGrabby).map(v => v.channelId));
  const silent = channels.filter(c => c.active && !c.channelId.startsWith('UCGrabbyTube') && !chanVideos.has(c.channelId));
  info('A12', `${silent.length} active channels with zero queue content: ${silent.slice(0, 6).map(c => c.title).join(', ')}${silent.length > 6 ? '…' : ''}`);
}

// ── A13: stale progress on unwatched rows (progress ≥ duration) ──
{
  const stale = videos.filter(v => !v.ignored && !v.watched && v.progress > 0 && v.duration != null && v.duration > 0 && v.progress >= v.duration).length;
  info('A13', `unwatched rows with stale progress≥duration (resume reads 0): ${stale}`);
}

console.log(failures === 0 ? '\nT1 PASS — no missed content detected\n' : `\nT1 FAIL — ${failures} problem group(s)\n`);
process.exit(failures === 0 ? 0 : 1);
