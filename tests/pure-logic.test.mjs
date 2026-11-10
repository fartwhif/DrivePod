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

// ── 11. measurePartBytesRecursive — the watchdog's growth gauge ──
{
  const probeDir = path.join(CACHE_DIR, 'stallprobe');
  fs.mkdirSync(path.join(probeDir, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(probeDir, 'a.m4a.part'), Buffer.alloc(1000));
  fs.writeFileSync(path.join(probeDir, 'notpart.bin'), Buffer.alloc(9999));
  fs.writeFileSync(path.join(probeDir, 'nested/b.webm.part'), Buffer.alloc(500));
  t('measurePartBytesRecursive sums .part files across nested dirs',
    server.measurePartBytesRecursive(probeDir) === 1500,
    `got ${server.measurePartBytesRecursive(probeDir)}`);
  // The exact bug the recursive scan fixes: with only a NESTED .part (yt-dlp's
  // {id}/ layout), a top-level readdir+statSync scan reads 0 and would wrongly
  // flag a healthy download as stalled.
  const nestedOnly = path.join(CACHE_DIR, 'stallnestedonly');
  fs.mkdirSync(path.join(nestedOnly, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(nestedOnly, 'sub', 'x.m4a.part'), Buffer.alloc(100));
  const topLevelScan = fs.readdirSync(nestedOnly)
    .reduce((s, f) => { const p = path.join(nestedOnly, f); return f.endsWith('.part') ? s + fs.statSync(p).size : s; }, 0);
  t('nested-only .part is seen recursively but missed by a top-level scan',
    server.measurePartBytesRecursive(nestedOnly) === 100 && topLevelScan === 0,
    `recursive=${server.measurePartBytesRecursive(nestedOnly)} topLevel=${topLevelScan}`);
  t('measurePartBytesRecursive returns 0 for a missing dir',
    server.measurePartBytesRecursive('/nonexistent/nope') === 0);
  fs.rmSync(probeDir, { recursive: true, force: true });
  fs.rmSync(nestedOnly, { recursive: true, force: true });
}

// ── 12. safeExecWithStallWatchdog — kill/retry/ban-signal via a fake yt-dlp ──
{
  const shimDir = path.join(CACHE_DIR, 'stallshim');
  fs.mkdirSync(shimDir, { recursive: true });
  const shimBin = path.join(shimDir, 'yt-dlp');
  // SCENARIO/recover: 1st invocation starts a .part then wedges; 2nd finishes.
  // SCENARIO/freeze: every invocation wedges (kill+retry+kill+throw).
  // SCENARIO/plainfail: no .part, non-zero exit — the watchdog must NOT treat
  // an ordinary command failure as a stall, and must never set stalledTwice.
  fs.writeFileSync(shimBin, `#!/bin/sh
N=$(cat "$COUNTER" 2>/dev/null || echo 0); N=$((N + 1)); echo $N > "$COUNTER"
DIR=""; prev=""
for a in "$@"; do
  if [ "$prev" = "--output" ]; then DIR="$a"; break; fi
  prev="$a"
done
DIR=$(dirname "$DIR"); mkdir -p "$DIR"
case "$SCENARIO" in
  recover)
    if [ "$N" = "1" ]; then head -c 8000 /dev/zero > "$DIR/stage1.part"; exec sleep 3600; fi
    head -c 16000 /dev/zero > "$DIR/stage1.part"; exit 0 ;;
  freeze)
    head -c $(( N == 1 ? 8000 : 16000 )) /dev/zero > "$DIR/stage1.part"; exec sleep 3600 ;;
  plainfail) exit 1 ;;
esac
`);
  fs.chmodSync(shimBin, 0o755);
  const win = 600, poll = 250; // SIGKILL after ~600 ms of zero .part growth
  // 20 s ceiling: a stalled child is `sleep 3600`, so returning inside the
  // ceiling proves the watchdog actually SIGKILLed it (no hang).
  const timed = (p, ms = 20000) => new Promise((res, rej) => {
    const h = setTimeout(() => rej(new Error('watchdog test hung — child was not killed')), ms);
    p.then(v => { clearTimeout(h); res(v); }, e => { clearTimeout(h); rej(e); });
  });
  const withShim = async (scenario, counterFile, fn) => {
    const oldPath = process.env.PATH;
    process.env.PATH = `${shimDir}:${oldPath}`;
    process.env.SCENARIO = scenario;
    process.env.COUNTER = counterFile;
    fs.writeFileSync(counterFile, '0');
    try { return await fn(); } finally {
      process.env.PATH = oldPath;
      delete process.env.SCENARIO;
      delete process.env.COUNTER;
    }
  };
  const invocations = f => parseInt(fs.readFileSync(f, 'utf-8').trim(), 10);
  const cmd = (id, dir) => `yt-dlp --output "${dir}/%(id)s.%(ext)s" "https://www.youtube.com/watch?v=${id}"`;

  // (a) clean exit — watchdog passes stdout through untouched
  const okRes = await timed(server.safeExecWithStallWatchdog(
    'echo done', 't-normal', shimDir, { stallWindowMs: win, pollMs: poll }));
  t('watchdog returns stdout on a clean exit', okRes.stdout.trim() === 'done');

  // (b) an unrelated non-zero exit must throw WITHOUT stalledTwice (no ban)
  const stubDir = path.join(CACHE_DIR, 'stall-stub');
  let plainErr = null;
  try {
    await withShim('plainfail', path.join(shimDir, 'pf.txt'), () =>
      timed(server.safeExecWithStallWatchdog(cmd('stub', stubDir), 't-plain', stubDir, { stallWindowMs: win, pollMs: poll })));
  } catch (e) { plainErr = e; }
  t('an unrelated command failure never carries stalledTwice',
    !!plainErr && plainErr.stalledTwice === undefined, `err=${plainErr ? plainErr.message : 'no throw'}`);

  // (c) ONE freeze → kill → retry succeeds ⇒ 2 invocations, no throw, no ban
  const recovDir = path.join(CACHE_DIR, 'stall-recover');
  const recovCounter = path.join(shimDir, 'recov.txt');
  let recovErr = null;
  await withShim('recover', recovCounter, () =>
    timed(server.safeExecWithStallWatchdog(cmd('recov', recovDir), 't-recover', recovDir, { stallWindowMs: win, pollMs: poll }))
      .catch(e => { recovErr = e; }));
  t('a single freeze is rescued by the retry (2 invocations, no throw)',
    recovErr === null && invocations(recovCounter) === 2,
    `invocations=${invocations(recovCounter)} err=${recovErr ? recovErr.message : 'none'}`);

  // (d) freeze twice → kill twice → throw tagged stalledTwice (the ban trigger)
  const frzDir = path.join(CACHE_DIR, 'stall-freeze');
  const frzCounter = path.join(shimDir, 'frz.txt');
  let frzErr = null;
  await withShim('freeze', frzCounter, () =>
    timed(server.safeExecWithStallWatchdog(cmd('frz', frzDir), 't-freeze', frzDir, { stallWindowMs: win, pollMs: poll }))
      .catch(e => { frzErr = e; }));
  t('two freezes throw with stalledTwice set (the ban trigger)',
    !!frzErr && frzErr.stalledTwice === true, `err=${frzErr ? frzErr.message : 'no throw'}`);
  t('exactly two download attempts ran before the ban throw',
    invocations(frzCounter) === 2, `invocations=${invocations(frzCounter)}`);

  fs.rmSync(stubDir, { recursive: true, force: true });
  fs.rmSync(recovDir, { recursive: true, force: true });
  fs.rmSync(frzDir, { recursive: true, force: true });
}

// ── 13. twice-stalled item is BANNED durably (the frozen-queue fix) ──
// Reproduces 2026-11-05 (eUAxo-AC5Rs froze harvest ~4 h): after the watchdog
// exhausts its retry, downloadAndProcessVideo must mark the item ignored so
// discovery's existingIds filter (server.ts: findMany by videoId, NO ignored
// filter) can never re-queue it and re-freeze the harvest.
{
  const shimDir = path.join(CACHE_DIR, 'stallshim2');
  fs.mkdirSync(shimDir, { recursive: true });
  fs.writeFileSync(path.join(shimDir, 'yt-dlp'), `#!/bin/sh
DIR=""; prev=""
for a in "$@"; do
  if [ "$prev" = "--output" ]; then DIR="$a"; break; fi
  prev="$a"
done
DIR=$(dirname "$DIR"); mkdir -p "$DIR"
head -c 8000 /dev/zero > "$DIR/stage1.part"
exec sleep 3600
`);
  fs.chmodSync(path.join(shimDir, 'yt-dlp'), 0o755);

  const banChan = 'UCStallBanChan', banVid = 'StallBanVid01';
  await prisma.channel.upsert({
    where: { channelId: banChan },
    update: { title: 'Stall Test Channel' },
    create: { channelId: banChan, title: 'Stall Test Channel' }
  });
  await prisma.video.delete({ where: { videoId: banVid } }).catch(() => {});
  await setCfg('stallWindowMs', '600');   // real download path reads this hot
  await setCfg('stallPollMs', '250');
  fs.rmSync(path.join(CACHE_DIR, banVid), { recursive: true, force: true });

  const oldPath = process.env.PATH;
  process.env.PATH = `${shimDir}:${oldPath}`;
  let dlResult = null, dlErr = null;
  try {
    dlResult = await Promise.race([
      server.downloadAndProcessVideo(
        { videoId: banVid, title: 'Stalled Test Track', author: 'Tester', channelId: banChan, publishedAt: new Date(), duration: 120 },
        `https://www.youtube.com/watch?v=${banVid}`, 128, false),
      new Promise((_, rej) => setTimeout(() => rej(new Error('download path hung — watchdog failed to kill its child')), 20000)),
    ]);
  } catch (e) { dlErr = e; } finally { process.env.PATH = oldPath; }

  t('a twice-stalled download returns false instead of re-throwing',
    dlErr === null && dlResult === false, `err=${dlErr ? dlErr.message : 'none'} result=${dlResult}`);
  const row = await prisma.video.findUnique({ where: { videoId: banVid } });
  t('the twice-stalled item is written as an ignored (banned) DB row',
    !!row && row.ignored === true, `row=${row ? `ignored=${row.ignored}` : 'absent'}`);
  // Discovery's exclusion is "row exists for this videoId, regardless of
  // ignored" — mirror that predicate to prove the ban actually filters it out.
  const existingIds = new Set((await prisma.video.findMany({
    where: { videoId: { in: [banVid] } }, select: { videoId: true }
  })).map(v => v.videoId));
  t("a banned row satisfies discovery's existingIds exclusion", existingIds.has(banVid));
  t('the stalled .part cache dir is purged by the ban',
    !fs.existsSync(path.join(CACHE_DIR, banVid)), 'incomplete folder left behind');
  // Re-run must stay inert: ignoreVideo() is idempotent and the ban never
  // flips back to "downloadable".
  await server.ignoreVideo({ videoId: banVid, channelId: banChan, title: 'Stalled Test Track' });
  const row2 = await prisma.video.findUnique({ where: { videoId: banVid } });
  t('re-ignoring an already-banned item keeps it ignored (idempotent)', !!row2 && row2.ignored === true);
  await prisma.video.delete({ where: { videoId: banVid } }).catch(() => {});
  await prisma.channel.delete({ where: { channelId: banChan } }).catch(() => {});
  await setCfg('stallWindowMs', String(600 * 1000 * 10)).catch(() => {});
}

// ── 14. stall-ban CIRCUIT BREAKER (outage must not burn the queue) ──
// A twice-stalled download is banned, but during an ISP/CDN outage EVERY
// item's --continue retry freezes on the same dead link, so an unconditional
// ban would silently ignore one item per ~20 min for the whole outage. The
// breaker bans only the FIRST stall-item since the last SUCCESSFUL download;
// later ones are collateral damage (skipped, NOT banned, retried next cycle).
// A completed download clears the breaker, so the next real stall bans again.
{
  const win = '600', poll = '250';
  const chan = 'UCStallBreakerChan', vid = 'StallBreaker';
  await prisma.channel.upsert({
    where: { channelId: chan },
    update: { title: 'Breaker Test Channel' },
    create: { channelId: chan, title: 'Breaker Test Channel' }
  });
  await setCfg('stallWindowMs', win);
  await setCfg('stallPollMs', poll);
  server.resetStallBanCounter();
  t('breaker starts open (a stall may be banned)', server.getConsecutiveStallBans() === 0 && server.stallBanAllowed());

  const mkShim = (dir, body) => {
    fs.mkdirSync(dir, { recursive: true });
    for (const name of ['yt-dlp', 'ffmpeg', 'ffprobe', 'vbrfix']) {
      fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`);
      fs.chmodSync(path.join(dir, name), 0o755);
    }
  };
  const parseDirId = `DIR=""; ID=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--output" ]; then DIR="$a"; fi
  case "$a" in
    http*) ID="\${a##*v=}" ;;
  esac
  prev="$a"
done
DIR=$(dirname "$DIR")
mkdir -p "$DIR"
`;
  // --- fake "link dead" toolchain: every download freezes on a .part ---
  const dirStall = path.join(CACHE_DIR, 'shim-stall');
  mkShim(dirStall, parseDirId + `head -c 6000 /dev/zero > "$DIR/$ID.part"
exec sleep 3600`);
  // --- fake "link healthy" toolchain: download finishes, ffmpeg/vbrfix emit
  //     a structurally-valid MP3 (ID3-free frame sync + Xing "bytes" header
  //     claiming the exact file size) that the REAL validateMp3File accepts.
  const dirOk = path.join(CACHE_DIR, 'shim-ok');
  mkShim(dirOk, parseDirId + `head -c 5000 /dev/zero | tr "\\0" "\\001" > "$DIR/$ID.webm"
exit 0`);
  fs.writeFileSync(path.join(dirOk, 'ffmpeg'), `#!/bin/sh
out=""
for a in "$@"; do out="$a"; done
case "$out" in
  *.mp3) head -c 8176 /dev/zero | tr "\\0" "\\001" | { printf "\\377\\353\\000\\000Xing\\000\\000\\000\\002\\000\\000\\040\\000"; cat; } > "$out" ;;
  *) head -c 64 /dev/urandom > "$out" ;;
esac
exit 0`);
  fs.writeFileSync(path.join(dirOk, 'ffprobe'), `#!/bin/sh
echo 119.7
exit 0`);
  fs.writeFileSync(path.join(dirOk, 'vbrfix'), `#!/bin/sh
cat "$2" > "$3"
exit 0`);
  for (const f of ['ffmpeg', 'ffprobe', 'vbrfix']) fs.chmodSync(path.join(dirOk, f), 0o755);

  const oldPath = process.env.PATH;
  const runDl = async (id, shimDir) => {
    process.env.PATH = `${shimDir}:${oldPath}`;
    fs.rmSync(path.join(CACHE_DIR, id), { recursive: true, force: true });
    let res = null, err = null;
    try {
      res = await Promise.race([
        server.downloadAndProcessVideo(
          { videoId: id, title: `Breaker ${id}`, author: 'Tester', channelId: chan, publishedAt: new Date(), duration: 120 },
          `https://www.youtube.com/watch?v=${id}`, 128, false),
        new Promise((_, rej) => setTimeout(() => rej(new Error(`${id} hung — watchdog failed to kill its child`)), 15000)),
      ]);
    } catch (e) { err = e; } finally { process.env.PATH = oldPath; }
    if (err) throw err;
    return res;
  };
  const rowFor = async (id) => prisma.video.findUnique({ where: { videoId: id } });
  const gone = (id) => !fs.existsSync(path.join(CACHE_DIR, id));

  // 1) first twice-stalled item of the day → BANNED (queue must keep moving)
  const r1 = await runDl(`${vid}_A`, dirStall);
  const rowA = await rowFor(`${vid}_A`);
  t('the first twice-stalled item is banned (ignored row)', r1 === false && !!rowA && rowA.ignored === true, `result=${r1} row=${rowA ? rowA.ignored : 'absent'}`);
  t('banning closes the breaker', server.getConsecutiveStallBans() === 1 && !server.stallBanAllowed());
  t('banned item cache dir purged', gone(`${vid}_A`));

  // 2/3) two MORE twice-stalled items while the breaker is closed (the outage)
  const r2 = await runDl(`${vid}_B`, dirStall);
  const r3 = await runDl(`${vid}_C`, dirStall);
  t('outage items return false without crashing', r2 === false && r3 === false, `B=${r2} C=${r3}`);
  const rowB = await rowFor(`${vid}_B`), rowC = await rowFor(`${vid}_C`);
  t('collateral-damage items are NOT banned (no ignored row)', !rowB && !rowC,
    `B=${rowB ? `ignored=${rowB.ignored}` : 'absent'} C=${rowC ? `ignored=${rowC.ignored}` : 'absent'}`);
  t('suppressed items have their .part cache purged (retryable next cycle)', gone(`${vid}_B`) && gone(`${vid}_C`));
  t('suppression does not add extra bans (exactly one item lost to the outage)',
    server.getConsecutiveStallBans() === 1);

  // 4) a SUCCESSFUL download (real validateMp3File on the canned Xing MP3)
  //    must re-open the breaker so a later genuinely-dead item can be banned.
  const r4 = await runDl(`${vid}_D`, dirOk);
  t('the healthy-toolchain download succeeds', r4 === true, `result=${r4}`);
  t('a successful download clears the breaker', server.getConsecutiveStallBans() === 0 && server.stallBanAllowed());
  fs.rmSync(path.join(CACHE_DIR, `${vid}_D`), { recursive: true, force: true });

  // 5) breaker open again → the NEXT twice-stalled item is banned for real
  const r5 = await runDl(`${vid}_E`, dirStall);
  const rowE = await rowFor(`${vid}_E`);
  t('after a success, the next twice-stalled item is banned again', r5 === false && !!rowE && rowE.ignored === true, `result=${r5} row=${rowE ? rowE.ignored : 'absent'}`);

  await prisma.video.delete({ where: { videoId: `${vid}_A` } }).catch(() => {});
  await prisma.video.delete({ where: { videoId: `${vid}_E` } }).catch(() => {});
  await prisma.channel.delete({ where: { channelId: chan } }).catch(() => {});
  server.resetStallBanCounter();
  await setCfg('stallWindowMs', String(600 * 1000 * 10)).catch(() => {});
}

await prisma.$disconnect();
console.log(fail === 0 ? `\nT2 PASS — ${pass} assertions\n` : `\nT2 FAIL — ${fail}/${pass + fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
