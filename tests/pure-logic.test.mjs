#!/usr/bin/env node
/**
 * T2 — Unit tests for the pure pipeline functions, executed against the
 * REAL compiled code (backend/dist/server.js) in a scratch environment:
 * empty scratch DB, scratch CACHE_DIR/DATA_DIR, so the module's startup
 * side effects (harvest, cron, listen) are inert.
 *
 * Run via tests/run-scratch.sh (container) — do NOT run on the host:
 * the host port 3000 is occupied and the server module listens on boot.
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);

const CACHE_DIR = process.env.CACHE_DIR || '/scratch/cache';
const DATA_DIR = process.env.DATA_DIR || '/scratch/data';
const DB_URL = process.env.DATABASE_URL || `file:${DATA_DIR}/scratch.db`;
for (const [k, v] of Object.entries({ CACHE_DIR, DATA_DIR, DATABASE_URL: DB_URL })) {
  process.env[k] = v;
}
fs.mkdirSync(CACHE_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

let pass = 0, fail = 0;
const t = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL ${name} — ${detail}`); }
};

// ── Seed config BEFORE the server module boots its own PrismaClient ──
const { PrismaClient } = require(path.join(ROOT, 'backend/node_modules/@prisma/client/index.js'));
const prisma = new PrismaClient();
const setCfg = (key, value) =>
  prisma.config.upsert({ where: { key }, update: { value }, create: { key, value } });
for (const [key, value] of Object.entries({
  maxHarvestDays: '7', durationFilterEnabled: 'false', minDurationMinutes: '0', maxDurationMinutes: '720',
})) await setCfg(key, value);

const server = require(path.join(ROOT, 'backend/dist/server.js'));
await new Promise(r => setTimeout(r, 2500)); // let boot side effects settle (no channels → inert)

console.log('\n== T2 Pure pipeline logic (real compiled code) ==\n');

// ── 1. cleanRssItems — real YouTube RSS fixture ──
{
  const Parser = require(path.join(ROOT, 'backend/node_modules/rss-parser'));
  const xml = fs.readFileSync(path.join(__dirname, 'fixtures/rss-superstore.xml'), 'utf-8');
  const parsed = await new Parser().parseString(xml);
  const src = parsed.items || [];
  const items = server.cleanRssItems(src);
  t('rss: all fixture items kept', items.length === src.length, `got ${items.length}/${src.length}`);
  t('rss: every item has an 11-char videoId', items.every(i => typeof i.videoId === 'string' && i.videoId.length === 11));
  t('rss: every item has a finite pubDate', items.every(i => i.pubDate instanceof Date && Number.isFinite(i.pubDate.getTime())));
  t('rss: every item has title + youtube link (watch or short)', items.every(i => typeof i.title === 'string' && i.title.length > 0 && /^https:\/\/www\.youtube\.com\/(watch\?v=|shorts\/)/.test(i.link)));
  const edge = server.cleanRssItems([
    { id: 'no-video-here', title: 'X' },
    { id: 'yt:video:abc123DEF01', title: 'Y', pubDate: '2026-10-01T00:00:00Z' },
  ]);
  t('rss: item without videoId dropped', edge.length === 1, `got ${edge.length}`);
  t('rss: videoId recovered from <id> fallback', edge[0]?.videoId === 'abc123DEF01');
}

// ── 2. parseYtDlpDuration ──
{
  t('dur: numeric seconds rounded', server.parseYtDlpDuration({ duration: 7208.6 }) === 7209);
  t('dur: HH:MM:SS', server.parseYtDlpDuration({ duration: null, duration_string: '1:02:03' }) === 3723);
  t('dur: MM:SS', server.parseYtDlpDuration({ duration_string: '5:00' }) === 300);
  t('dur: SS only', server.parseYtDlpDuration({ duration_string: '42' }) === 42);
  t('dur: junk → undefined', server.parseYtDlpDuration({ duration_string: 'n/a' }) === undefined);
  t('dur: zero/negative numeric ignored', server.parseYtDlpDuration({ duration: 0, duration_string: '1:00' }) === 60);
}

// ── 3. parseYtDlpPubDate + applyTodayMidnightRule ──
{
  const t3dAgo = Math.floor((Date.now() - 3 * 86400000) / 1000);
  const d = server.parseYtDlpPubDate({ timestamp: t3dAgo });
  t('pub: round-second timestamp preserved', d instanceof Date && Math.abs(d.getTime() - t3dAgo * 1000) < 1000);
  const d2 = server.parseYtDlpPubDate({ upload_date: '20240102' });
  t('pub: upload_date parsed (local midnight)', d2 instanceof Date && !isNaN(d2.getTime()));
  t('pub: no fields → undefined', server.parseYtDlpPubDate({}) === undefined);
  t('pub: malformed upload_date → undefined', server.parseYtDlpPubDate({ upload_date: '2024-01-02' }) === undefined);

  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  const r = server.applyTodayMidnightRule(midnight);
  t('midnight rule: today-midnight → now', Math.abs(r.getTime() - Date.now()) < 10000, `got ${r.toISOString()}`);
  const other = new Date('2020-05-05T10:00:00Z');
  t('midnight rule: other dates untouched', server.applyTodayMidnightRule(other).getTime() === other.getTime());
}

// ── 4. isFilteredOutByPubDate (config-driven, hot-readable) ──
{
  const DAY = 86400000;
  t('filter: 8d old filtered at 7d window', await server.isFilteredOutByPubDate({ pubDate: new Date(Date.now() - 8 * DAY) }) === true);
  t('filter: 2d old kept', await server.isFilteredOutByPubDate({ pubDate: new Date(Date.now() - 2 * DAY) }) === false);
  t('filter: future pubDate kept (negative-age path)', await server.isFilteredOutByPubDate({ pubDate: new Date(Date.now() + 3600000) }) === false);
  t('filter: missing pubDate kept', await server.isFilteredOutByPubDate({}) === false);
  await setCfg('maxHarvestDays', '1');
  t('filter: config hot-change honored (1d window filters 2d item)', await server.isFilteredOutByPubDate({ pubDate: new Date(Date.now() - 2 * DAY) }) === true);
  await setCfg('maxHarvestDays', '7');
}

// ── 5. isFilteredOutByDuration (global + per-channel override) ──
{
  t('durfilter: disabled → kept', await server.isFilteredOutByDuration({ duration: 60 }) === false);
  await setCfg('durationFilterEnabled', 'true');
  await setCfg('minDurationMinutes', '60');
  await setCfg('maxDurationMinutes', '120');
  t('durfilter: below min filtered', await server.isFilteredOutByDuration({ duration: 30 * 60 }) === true);
  t('durfilter: within range kept', await server.isFilteredOutByDuration({ duration: 90 * 60 }) === false);
  t('durfilter: above max filtered', await server.isFilteredOutByDuration({ duration: 200 * 60 }) === true);
  await setCfg('durationFilterEnabled', 'false');
  t('durfilter: per-channel min override applies with global disabled',
    await server.isFilteredOutByDuration({ duration: 30 * 60 }, { minDuration: 60, maxDuration: null }) === true);
  t('durfilter: per-channel max override applies with global disabled',
    await server.isFilteredOutByDuration({ duration: 200 * 60 }, { minDuration: null, maxDuration: 120 }) === true);
  t('durfilter: null overrides + disabled → kept',
    await server.isFilteredOutByDuration({ duration: 60 }, { minDuration: null, maxDuration: null }) === false);
}

// ── 6. clusterTimestamp ──
{
  const ref = new Date('2026-10-16T00:00:00Z');
  const c1 = server.clusterTimestamp(ref), c2 = server.clusterTimestamp(ref);
  t('cluster: within ±30 min of reference', Math.abs(c1 - ref) <= 30 * 60000 && Math.abs(c2 - ref) <= 30 * 60000);
  t('cluster: randomizes (two draws differ)', c1.getTime() !== c2.getTime());
}

// ── 7. grabbyChannelIdForArtist ──
{
  const id = server.grabbyChannelIdForArtist('Roxette');
  t('grabby id: UCGrabbyTube + base64url(artist) roundtrip',
    id.startsWith('UCGrabbyTube') && Buffer.from(id.slice('UCGrabbyTube'.length), 'base64url').toString('utf-8') === 'Roxette');
  t('grabby id: empty artist → bare channel id', server.grabbyChannelIdForArtist('') === 'UCGrabbyTube');
  t('grabby id: no padding, url-safe', !/[+/=]/.test(id));
  t('grabby id: distinct artists → distinct ids', server.grabbyChannelIdForArtist('a') !== server.grabbyChannelIdForArtist('b'));
}

// ── 8. readMp3HeaderClaim — synthetic files ──
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp3-claim-'));
  const frame = Buffer.from([0xff, 0xe0, 0x90, 0x00]); // frame header

  const n = 1234567;
  const nb = Buffer.alloc(4); nb.writeUInt32BE(n);

  // No-ID3 file: frame header, 'Xing' at offset 4, flags=0x2 (bytes field), N —
  // padded so the reader sees >=24 bytes from tagEnd.
  const f1 = Buffer.concat([frame, Buffer.from('Xing', 'ascii'), Buffer.from([0, 0, 0, 2]), nb, Buffer.alloc(8)]);
  fs.writeFileSync(path.join(dir, 'f1.mp3'), f1);
  const c1 = server.readMp3HeaderClaim(path.join(dir, 'f1.mp3'));
  t('mp3 claim: no-ID3 Xing → tagEnd(0)+bytes', c1?.claimedSize === n, `got ${JSON.stringify(c1)}`);

  // ID3v2 tag (syncsafe size 32 → tagEnd 42) + Info with bytes field
  const id3 = Buffer.alloc(16);
  id3.write('ID3', 0, 'ascii'); id3[3] = 3;
  id3[6] = 0; id3[7] = 0; id3[8] = 0; id3[9] = 32;
  const f2 = Buffer.concat([id3, Buffer.alloc(32 - 6, 0), frame, Buffer.from('Info', 'ascii'),
    Buffer.from([0, 0, 0, 2]), nb, Buffer.alloc(8)]); // pad: reader needs >=24 bytes from tagEnd (42)
  fs.writeFileSync(path.join(dir, 'f2.mp3'), f2);
  const c2 = server.readMp3HeaderClaim(path.join(dir, 'f2.mp3'));
  t('mp3 claim: ID3v2 + Info → tagEnd(42)+bytes', c2?.claimedSize === 42 + n, `got ${JSON.stringify(c2)}`);

  // No sync, no ID3 → null
  fs.writeFileSync(path.join(dir, 'f3.mp3'), Buffer.from('plain text, not an mp3 file'));
  t('mp3 claim: non-mp3 → null', server.readMp3HeaderClaim(path.join(dir, 'f3.mp3')) === null);

  // Xing without bytes flag → null
  const f4 = Buffer.concat([frame, Buffer.from('Xing', 'ascii'), Buffer.from([0, 0, 0, 1]), nb]);
  fs.writeFileSync(path.join(dir, 'f4.mp3'), f4);
  t('mp3 claim: missing bytes flag → null', server.readMp3HeaderClaim(path.join(dir, 'f4.mp3')) === null);
}

// ── 9. writeIfChanged ──
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wic-'));
  const dest = path.join(dir, 'out.json'), temp = path.join(dir, 'out.tmp');
  server.writeIfChanged(dest, temp, 'v1', 't');
  t('writeIfChanged: first write lands', fs.readFileSync(dest, 'utf-8') === 'v1');
  const m1 = fs.statSync(dest).mtimeMs;
  await new Promise(r => setTimeout(r, 30));
  server.writeIfChanged(dest, temp, 'v1', 't');
  t('writeIfChanged: identical content skipped (mtime unchanged)', fs.statSync(dest).mtimeMs === m1);
  server.writeIfChanged(dest, temp, 'v2', 't');
  t('writeIfChanged: changed content rewritten', fs.readFileSync(dest, 'utf-8') === 'v2');
  t('writeIfChanged: temp consumed by rename', !fs.existsSync(temp));
}

// ── 10. resolveGrabbyAudioPath (stale-absolute fallback) ──
{
  const vid = 'vidX1234567';
  fs.mkdirSync(path.join(CACHE_DIR, vid), { recursive: true });
  fs.writeFileSync(path.join(CACHE_DIR, vid, `${vid}.mp3`), 'x');
  const canonical = path.join(CACHE_DIR, vid, `${vid}.mp3`);
  t('resolve: relative path (normal case)', server.resolveGrabbyAudioPath(vid, `${vid}/${vid}.mp3`) === canonical);
  t('resolve: stale absolute path → canonical fallback',
    server.resolveGrabbyAudioPath(vid, '/mnt/c/edrive/old/cache/' + vid + '/' + vid + '.mp3') === canonical);
  t('resolve: live absolute path wins', server.resolveGrabbyAudioPath(vid, canonical) === canonical);
  t('resolve: nothing exists → literal (joined)',
    server.resolveGrabbyAudioPath('missing999999', 'missing999999/missing999999.mp3') ===
    path.join(CACHE_DIR, 'missing999999', 'missing999999.mp3'));
}

await prisma.$disconnect();
console.log(fail === 0 ? `\nT2 PASS — ${pass} assertions\n` : `\nT2 FAIL — ${fail}/${pass + fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
