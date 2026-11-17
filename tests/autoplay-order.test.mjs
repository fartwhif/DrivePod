#!/usr/bin/env node
/**
 * T6 — Autoplay ordering tests for the mode-aware next-track pick
 * (frontend/src/app/autoplay-order.ts).
 *
 * The module is deliberately DOM-free and Angular-free, so this drives the REAL
 * module with plain queues: no browser, no backend, no build. The TypeScript is
 * transpiled with the frontend's own compiler so the suite runs on any Node
 * (the scratch container is node:20, which cannot import .ts).
 *
 * The complaint these cases lock: a chosen autoplay mode was honoured only on
 * the finish → next path. A skipped/broken track, a post-refresh advance and
 * the autoplay on page load each hard-coded "play the newest in the list", so
 * 'older'/'oldest'/'newer' silently meant 'newest' exactly when the queue hit
 * trouble.
 *
 * Run: node tests/autoplay-order.test.mjs   (host or container)
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);

const ts = require(path.join(ROOT, 'frontend/node_modules/typescript/lib/typescript.js'));
const SRC = path.join(ROOT, 'frontend/src/app/autoplay-order.ts');
const js = ts.transpileModule(fs.readFileSync(SRC, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  fileName: SRC
}).outputText;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplay-order-'));
const tmpFile = path.join(tmpDir, 'autoplay-order.mjs');
fs.writeFileSync(tmpFile, js);
const { pickNextTrack, manualNextMode, manualPrevMode } = await import(tmpFile);
fs.rmSync(tmpDir, { recursive: true, force: true });

let pass = 0, fail = 0;
const t = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL ${name} — ${detail}`); }
};

// Newest-first, as the player's queue is built. publishedAt drives everything.
const q = (ids) => ids.map(([videoId, day]) => ({ videoId, publishedAt: `2026-01-${String(day).padStart(2, '0')}T00:00:00.000Z` }));
const QUEUE = q([['newest', 28], ['mid', 20], ['target', 12], ['old', 5], ['oldest', 1]]);
const pick = (mode, finishedId, list = QUEUE) => {
  const finished = finishedId ? list.find(v => v.videoId === finishedId) : undefined;
  return pickNextTrack(list, mode, finished);
};
const idOf = (v) => v === undefined ? '<none>' : v.videoId;

console.log('== T6 Autoplay ordering (autoplay-order.ts) ==');

// ── 1. the modes that ignore the finished track ──
t('1a off stops, whatever has played', pickNextTrack(QUEUE, 'off') === undefined && pick(QUEUE.length ? 'off' : 'off', 'mid') === undefined);
t('1b empty queue picks nothing', [
  pickNextTrack([], 'newest'), pickNextTrack([], 'older', QUEUE[1]), pickNextTrack([], 'off')
].every(v => v === undefined));
t('1c newest plays the freshest, ignoring what just finished',
  idOf(pick('newest', 'oldest')) === 'newest', `got ${idOf(pick('newest', 'oldest'))}`);
t('1d oldest plays the oldest, ignoring what just finished',
  idOf(pick('oldest', 'newest')) === 'oldest', `got ${idOf(pick('oldest', 'newest'))}`);

// ── 2. the relative modes pick the NEAREST neighbour ──
t('2a older steps back one step, not to the head or the tail',
  idOf(pick('older', 'mid')) === 'target', `got ${idOf(pick('older', 'mid'))}`);
t('2b newer steps forward one step, not to the freshest',
  idOf(pick('newer', 'mid')) === 'newest', `got ${idOf(pick('newer', 'mid'))}`);
// 'newer' from 'old': both 'target' (day 12) and 'newest' (day 28) are newer;
// the nearest is 'target'. Picking the freshest here was the bug.
t('2c newer prefers the closest newer over the freshest',
  idOf(pick('newer', 'old')) === 'target', `got ${idOf(pick('newer', 'old'))}`);
t('2d older from the freshest lands on the next-oldest',
  idOf(pick('older', 'newest')) === 'mid', `got ${idOf(pick('older', 'newest'))}`);

// ── 3. a direction with nothing left in it stops for the caller ──
t('3a older at the oldest has nowhere to go', pick('older', 'oldest') === undefined, `got ${idOf(pick('older', 'oldest'))}`);
t('3b newer at the newest has nowhere to go', pick('newer', 'newest') === undefined, `got ${idOf(pick('newer', 'newest'))}`);

// ── 4. the finished track is never its own successor ──
{
  // A one-item queue holding only the finished track: the inclusive <=/>= would
  // re-pick it (same timestamp) if the id were not excluded.
  const alone = q([['solo', 10]]);
  t('4a the finished track is excluded by id, not by timestamp',
    pickNextTrack(alone, 'older', alone[0]) === undefined && pickNextTrack(alone, 'newer', alone[0]) === undefined);
  // The extremes skip a `finished` track too: 'newest' of a one-item queue IS
  // that item, so without the id skip a manual ⏭️ under 'newest'/'oldest' would
  // land straight back on the track the user just pressed Next away from.
  t('4b newest/oldest never re-pick the track being left',
    pickNextTrack(alone, 'newest', alone[0]) === undefined && pickNextTrack(alone, 'oldest', alone[0]) === undefined);
  // With nothing being left behind (autoplay on load) the same one-item queue
  // still plays it.
  t('4c newest/oldest play the only item when nothing was left',
    pickNextTrack(alone, 'newest')?.videoId === 'solo' && pickNextTrack(alone, 'oldest')?.videoId === 'solo');
}

// ── 5. same-timestamp siblings stay pickable (inclusive comparison) ──
{
  // A grabby cluster band: several tracks share one drawn timestamp.
  const band = q([['a', 20], ['band-a', 15], ['band-b', 15], ['band-c', 15], ['b', 10]]);
  const fromBandA = pickNextTrack(band, 'older', band[1]);
  t('5a older from a cluster row picks its same-timestamp sibling',
    idOf(fromBandA) === 'band-b', `got ${idOf(fromBandA)}`);
  const fromBandC = pickNextTrack(band, 'newer', band[3]);
  t('5b newer from a cluster row picks a same-timestamp sibling',
    idOf(fromBandC) === 'band-a' || idOf(fromBandC) === 'band-b', `got ${idOf(fromBandC)}`);
  t('5c ties keep list order, so a cluster walks in the order shown',
    idOf(pickNextTrack(band, 'newest')) === 'a' && idOf(pickNextTrack(band, 'oldest')) === 'b');
}

// ── 6. nothing finished yet: the page-load autoplay honours the direction ──
t('6a no finished + newest starts at the head of time', idOf(pick('newest', null)) === 'newest', `got ${idOf(pick('newest', null))}`);
t('6b no finished + newer starts at the newest', idOf(pick('newer', null)) === 'newest', `got ${idOf(pick('newer', null))}`);
t('6c no finished + OLDER starts at the oldest, not the head', idOf(pick('older', null)) === 'oldest', `got ${idOf(pick('older', null))}`);
t('6d no finished + oldest starts at the oldest', idOf(pick('oldest', null)) === 'oldest', `got ${idOf(pick('oldest', null))}`);

// ── 7. selection is by time, so any list order gives the same answer ──
{
  const shuffled = [QUEUE[2], QUEUE[4], QUEUE[1], QUEUE[3], QUEUE[0]];
  for (const mode of ['newest', 'older', 'newer', 'oldest']) {
    for (const finishedId of ['mid', 'target', 'old']) {
      const a = pick(mode, finishedId), b = pickNextTrack(shuffled, mode, QUEUE.find(v => v.videoId === finishedId));
      t(`7 ${mode} after ${finishedId}: same pick from a shuffled queue`, a?.videoId === b?.videoId, `${idOf(a)} vs ${idOf(b)}`);
    }
  }
}

// ── 8. the finished track need not still be in the list ──
{
  // consume/delete removes the row before advancing (consumeGrabbyTrack); the
  // caller passes the removed track as `finished` and the step must still land.
  const gone = QUEUE.filter(v => v.videoId !== 'mid');
  t('8 relative modes work when the finished row is already deleted',
    idOf(pickNextTrack(gone, 'older', QUEUE[1])) === 'target' && idOf(pickNextTrack(gone, 'newer', QUEUE[1])) === 'newest',
    `older=${idOf(pickNextTrack(gone, 'older', QUEUE[1]))} newer=${idOf(pickNextTrack(gone, 'newer', QUEUE[1]))}`);
}

// ── 9. an unparseable publishedAt is never chosen and never poisons the scan ──
{
  const junk = [
    { videoId: 'junk', publishedAt: 'not-a-date' },
    { videoId: 'real-newest', publishedAt: '2026-01-28T00:00:00.000Z' },
    { videoId: 'ref', publishedAt: '2026-01-15T00:00:00.000Z' },
    { videoId: 'real-older', publishedAt: '2026-01-02T00:00:00.000Z' }
  ];
  const ref = junk[2];
  t('9a a NaN date is never picked', pickNextTrack(junk, 'newest')?.videoId === 'real-newest' && pickNextTrack(junk, 'oldest')?.videoId === 'real-older');
  t('9b a NaN date does not satisfy a relative step', idOf(pickNextTrack(junk, 'older', ref)) === 'real-older', `got ${idOf(pickNextTrack(junk, 'older', ref))}`);
  t('9c a NaN reference never wins, so the scan keeps scanning',
    pickNextTrack(junk, 'older', junk[0]) === undefined && pickNextTrack(junk, 'newer', junk[0]) === undefined);
}

// ── 10. the queue the player actually has: a 25-item page slice ──
{
  const page = q(Array.from({ length: 25 }, (_, i) => [`p${i}`, 28 - i]));
  t('10a older walks one step back through a page', idOf(pickNextTrack(page, 'older', page[9])) === 'p10', `got ${idOf(pickNextTrack(page, 'older', page[9]))}`);
  t('10b newer walks one step forward through a page', idOf(pickNextTrack(page, 'newer', page[9])) === 'p8', `got ${idOf(pickNextTrack(page, 'newer', page[9]))}`);
  t('10c oldest is the page tail, newest the head',
    idOf(pickNextTrack(page, 'oldest')) === 'p24' && idOf(pickNextTrack(page, 'newest')) === 'p0');
}

// ── 11. the manual ⏭️ obeys the mode too ──
{
  // The button is the user asking for the next track, so it takes the autoplay
  // mode verbatim — except 'off', which forbids AUTOPLAY, not a button press:
  // it walks one item older, the step the button took before modes existed.
  t('11a manual next maps every mode',
    manualNextMode('off') === 'older' && manualNextMode('older') === 'older' &&
    manualNextMode('newer') === 'newer' && manualNextMode('newest') === 'newest' &&
    manualNextMode('oldest') === 'oldest');
  // 'off' + manual: repeated Next walks the library backwards and stops at the
  // oldest, instead of replaying the freshest (the old head-of-list behaviour
  // a user reported as "it doesn't respect my autoplay mode").
  t('11b manual under off steps older, and stops at the oldest',
    idOf(pickNextTrack(QUEUE, manualNextMode('off'), QUEUE[1])) === 'target' &&
    pickNextTrack(QUEUE, manualNextMode('off'), QUEUE[4]) === undefined,
    `got ${idOf(pickNextTrack(QUEUE, manualNextMode('off'), QUEUE[1]))}`);
  // 'newest' + manual from the freshest track: the extremes now skip what is
  // being left, so Next cannot bounce back onto it.
  t('11c manual under newest leaves the freshest and takes the next',
    idOf(pickNextTrack(QUEUE, manualNextMode('newest'), QUEUE[0])) === 'mid',
    `got ${idOf(pickNextTrack(QUEUE, manualNextMode('newest'), QUEUE[0]))}`);
  t('11d manual under oldest steps back from the oldest',
    idOf(pickNextTrack(QUEUE, manualNextMode('oldest'), QUEUE[4])) === 'old',
    `got ${idOf(pickNextTrack(QUEUE, manualNextMode('oldest'), QUEUE[4]))}`);
}

// ── 12. the manual ⏮️ is the manual ⏭️ read backwards ──
{
  // The mapping: a newer-ward mode steps back by travelling older, an
  // older-ward mode (including 'off', whose Next already walks older) steps
  // back by travelling newer. Never an extreme: the button is a neighbour step.
  t('12a manual prev maps every mode to the opposite direction',
    manualPrevMode('newer') === 'older' && manualPrevMode('newest') === 'older' &&
    manualPrevMode('older') === 'newer' && manualPrevMode('oldest') === 'newer' &&
    manualPrevMode('off') === 'newer');
  // Next then Previous lands back on the track the user started from, for the
  // modes that step by NEIGHBOURS ('newer', 'older', and 'off', whose Next maps
  // to 'older') — the invariant the restored button rests on, and the reason it
  // is hidden while skipMarksWatched is on (there a Next marks the left track
  // watched, so it is out of the queue and nothing is left to step back to).
  // The extremes cannot round-trip by construction: 'newest'/'oldest' jump to
  // the far end of the library instead of to a neighbour, so their Previous is
  // the neighbour AT that end (12c/12d), not the origin.
  const roundTrip = (mode, startId) => {
    const start = QUEUE.find(v => v.videoId === startId);
    const fwd = pickNextTrack(QUEUE, manualNextMode(mode), start);
    return fwd && pickNextTrack(QUEUE, manualPrevMode(mode), fwd);
  };
  t('12b next then prev returns the starting track under the neighbour modes',
    ['newer', 'older', 'off'].every(m =>
      roundTrip(m, 'target')?.videoId === 'target'),
    ['newer', 'older', 'off'].map(m => `${m}=${idOf(roundTrip(m, 'target'))}`).join(' '));
  // Under 'newer'/'newest' the walk goes forward in time, so Previous is the
  // NEAREST older track — the same neighbour Next took one step ago.
  t('12c prev under newer/newest steps to the nearest older neighbour',
    idOf(pickNextTrack(QUEUE, manualPrevMode('newer'), QUEUE[2])) === 'old' &&
    idOf(pickNextTrack(QUEUE, manualPrevMode('newest'), QUEUE[2])) === 'old',
    `got ${idOf(pickNextTrack(QUEUE, manualPrevMode('newer'), QUEUE[2]))}`);
  // Under 'older'/'oldest'/'off' the walk goes backwards, so Previous climbs.
  t('12d prev under older/oldest/off steps to the nearest newer neighbour',
    idOf(pickNextTrack(QUEUE, manualPrevMode('older'), QUEUE[2])) === 'mid' &&
    idOf(pickNextTrack(QUEUE, manualPrevMode('oldest'), QUEUE[2])) === 'mid' &&
    idOf(pickNextTrack(QUEUE, manualPrevMode('off'), QUEUE[2])) === 'mid',
    `got ${idOf(pickNextTrack(QUEUE, manualPrevMode('older'), QUEUE[2]))}`);
  // Where the walk has no step left, `pickNextTrack` answers undefined — the
  // caller's "restart this track from the top" signal (the media-player
  // convention the pre-mode `idx <= 0` branch implemented). The dead end is
  // DIRECTION-dependent: a step that travels newer dead-ends at the freshest
  // track, a step that travels older at the oldest — so it fires at the freshest
  // under an older-ward mode and at the oldest under a newer-ward one.
  t('12e prev dead-ends only at the far end of the direction it travels',
    pickNextTrack(QUEUE, manualPrevMode('older'), QUEUE[0]) === undefined &&
    pickNextTrack(QUEUE, manualPrevMode('oldest'), QUEUE[0]) === undefined &&
    pickNextTrack(QUEUE, manualPrevMode('newer'), QUEUE[4]) === undefined &&
    pickNextTrack(QUEUE, manualPrevMode('newest'), QUEUE[4]) === undefined,
    `newer-ward from freshest=${idOf(pickNextTrack(QUEUE, manualPrevMode('older'), QUEUE[0]))} older-ward from oldest=${idOf(pickNextTrack(QUEUE, manualPrevMode('newer'), QUEUE[4]))}`);
  // And the far end of an older-ward walk: prev under 'off' climbs from the
  // oldest to its neighbour rather than stopping.
  t('12f prev under off climbs from the oldest',
    idOf(pickNextTrack(QUEUE, manualPrevMode('off'), QUEUE[4])) === 'old',
    `got ${idOf(pickNextTrack(QUEUE, manualPrevMode('off'), QUEUE[4]))}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
