#!/usr/bin/env node
/**
 * Pure decision tests for the playback liveness watchdog
 * (frontend/src/app/stall-guard.ts).
 *
 * stall-guard.ts is deliberately DOM-free, so this drives the REAL module with
 * a synthetic tick stream: no Angular, no browser, no backend. The TypeScript
 * is transpiled with the frontend's own compiler so the suite runs on any Node
 * (the scratch container is node:20, which cannot import .ts).
 *
 * Run: node tests/stall-guard.test.mjs   (host or container)
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
const SRC = path.join(ROOT, 'frontend/src/app/stall-guard.ts');
const js = ts.transpileModule(fs.readFileSync(SRC, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  fileName: SRC
}).outputText;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stall-guard-'));
const tmpFile = path.join(tmpDir, 'stall-guard.mjs');
fs.writeFileSync(tmpFile, js);
const {
  evaluateStall,
  HAVE_POSITION_READY_STATE,
  MAX_STALL_RECOVERIES,
  READY_STATE_FED,
  RESUME_DETECT_MS,
  STALL_CHECK_MS,
  STALL_DETECT_MS,
  STALL_PHASE_LABEL,
  stallResumeTarget
} = await import(tmpFile);

let pass = 0, fail = 0;
const t = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL ${name} — ${detail}`); }
};
const at = arr => JSON.stringify(arr);

/** A tick with everything a healthy playing track looks like. */
const base = (over = {}) => ({
  hasTrack: true,
  paused: false,
  scrubbing: false,
  staleMs: 1_000,
  readyState: 4,
  loadInFlight: false,
  retryPending: false,
  networkDown: false,
  clockTrust: true,
  recoveries: 0,
  ...over
});
const tick = over => evaluateStall(base(over));

/**
 * Faithful model of `app.component.ts`'s side-effect loop, in caller order:
 * the audible heartbeat lands BEFORE a tick (that is what `timeupdate` does
 * between probes) and the decision's side effects after it. Audible progress
 * re-arms the heartbeat AND clears the attempt budget; a recovery reload
 * re-arms the heartbeat (that is what serializes attempts) but keeps the
 * budget; give-up ends the watch, because the caller skips the track. Each
 * entry is one tick's decision, tagged with the wall time it was taken at.
 */
function simulate(opts) {
  const {
    progressAtMs = Infinity,    // when audible progress resumes, if ever
    resumeAfterReload = false,  // flaky link: each reload wins audio back…
    playRunMs = Infinity,       // …and that run survives this long before dying
    loadYieldsMetadata = true,  // whether a recovery load ever feeds the element
    detectMs = STALL_DETECT_MS,
    maxRecoveries = MAX_STALL_RECOVERIES,
    ticks = 40
  } = opts;
  let now = 0;
  let lastProgressAt = 0;
  let recoveries = 0;
  let loadInFlight = false;
  let readyState = opts.initialReadyState ?? 4;
  let nextResume = progressAtMs;
  let playingUntil = 0; // audible progress advances while `now < playingUntil`
  const trace = [];
  for (let i = 0; i < ticks; i++) {
    now += STALL_CHECK_MS;
    if (now >= nextResume) {
      playingUntil = now + playRunMs;
      nextResume = Infinity;
    }
    if (now < playingUntil) {
      readyState = 4;
      loadInFlight = false;
      lastProgressAt = now;
      recoveries = 0;
    }
    const decision = tick({
      staleMs: now - lastProgressAt,
      readyState,
      loadInFlight,
      retryPending: !!opts.retryPending,
      networkDown: !!opts.networkDown,
      clockTrust: opts.clockTrust ?? true,
      recoveries,
      detectMs,
      maxRecoveries
    });
    trace.push({ at: now, ...decision });
    recoveries = decision.nextRecoveries;
    loadInFlight = decision.nextLoadInFlight;
    if (decision.recover) {
      // loadAndSeekVideo(): a new load is outstanding, the heartbeat is
      // re-armed, the budget is kept.
      loadInFlight = true;
      lastProgressAt = now;
      readyState = 0; // audio.load() resets the element to HAVE_NOTHING
      if (resumeAfterReload) nextResume = now + 2_000;
    }
    if (loadYieldsMetadata && loadInFlight && now - lastProgressAt >= 1_000) {
      // metadata landed but the stream still delivers nothing audible
      loadInFlight = false;
      readyState = 2;
    }
    if (decision.giveUp) break;
  }
  return trace;
}
const marks = (trace, key) => trace.filter(x => x[key]).map(x => x.at);

console.log('\nstall-guard: constants');
t('detect budget is 20 s (5 × the 4 Hz timeupdate cadence)', STALL_DETECT_MS === 20_000, `${STALL_DETECT_MS}`);
t('resume grace is shorter than the normal budget', RESUME_DETECT_MS === 6_000, `${RESUME_DETECT_MS}`);
t('watchdog cadence rides the always-on probe (5 s)', STALL_CHECK_MS === 5_000, `${STALL_CHECK_MS}`);
t('an attempt is bounded by 3 reloads', MAX_STALL_RECOVERIES === 3, `${MAX_STALL_RECOVERIES}`);
t('the fed threshold is HAVE_FUTURE_DATA', READY_STATE_FED === 3, `${READY_STATE_FED}`);
t('every visible phase has a label', Object.keys(STALL_PHASE_LABEL).length === 2
  && Object.values(STALL_PHASE_LABEL).every(s => typeof s === 'string' && s.length > 0));

console.log('\nhealthy playback');
t('playing with fresh progress: idle, no reload', (() => {
  const d = tick();
  return d.phase === 'idle' && !d.recover && !d.giveUp && d.nextRecoveries === 0;
})(), JSON.stringify(tick()));
t('a young load buffers without spending an attempt', (() => {
  const d = tick({ staleMs: 5_000, loadInFlight: true, readyState: 0 });
  return d.phase === 'buffering' && !d.recover && d.nextLoadInFlight === true;
})(), JSON.stringify(tick({ staleMs: 5_000, loadInFlight: true, readyState: 0 })));
t('low readyState with no load in flight buffers, flag stays down', (() => {
  const d = tick({ staleMs: 5_000, readyState: 2 });
  return d.phase === 'buffering' && !d.recover && d.nextLoadInFlight === false;
})());
t('a mid-song buffer refill never counts as starving', () => {
  const d = tick({ staleMs: 10_000, readyState: 2 });
  return d.phase === 'buffering' && !d.recover;
});

console.log('\nsilent starvation (the freeze the probe never sees)');
t('no progress past the budget while the element claims to play: reload', (() => {
  const d = tick({ staleMs: 21_000, readyState: 2 });
  return d.phase === 'stalling' && d.recover && !d.giveUp && d.nextRecoveries === 1;
})(), JSON.stringify(tick({ staleMs: 21_000, readyState: 2 })));
t('a dead pipe that fires NO error event is caught anyway', () => {
  // readyState 4: the stale buffer still looks fed, so the old recovery gate
  // (`!paused && readyState >= 2`) was always true here and vetoed the reload
  // the dead connection needed.
  return tick({ staleMs: 21_000, readyState: 4 }).recover === true;
});
t('a reachable backend is not a reason to skip the reload', () => tick({ staleMs: 21_000 }).recover === true);

console.log('\nwho else owns the track');
t('a pending play-after-outage retry suppresses the reload', (() => {
  const d = tick({ staleMs: 21_000, retryPending: true });
  return !d.recover && !d.giveUp && d.nextRecoveries === 0 && d.phase === 'stalling';
})(), JSON.stringify(tick({ staleMs: 21_000, retryPending: true })));
t('backend unreachable: badge shows, no doomed reload, budget intact', (() => {
  const d = tick({ staleMs: 21_000, networkDown: true, recoveries: 2 });
  return d.phase === 'stalling' && !d.recover && !d.giveUp && d.nextRecoveries === 2;
})(), JSON.stringify(tick({ staleMs: 21_000, networkDown: true, recoveries: 2 })));
t('a hung request cannot hide behind the in-flight flag forever', (() => {
  const d1 = tick({ staleMs: 19_000, loadInFlight: true, readyState: 0 });
  const d2 = tick({ staleMs: 24_000, loadInFlight: d1.nextLoadInFlight, readyState: 0 });
  return d1.nextLoadInFlight === true && !d1.recover && d2.recover === true;
})(), JSON.stringify([tick({ staleMs: 19_000, loadInFlight: true, readyState: 0 }),
  tick({ staleMs: 24_000, loadInFlight: true, readyState: 0 })]));

console.log('\nfrozen / suspended tab (phone in the car)');
t('untrusted clock: idle, no reload, budget preserved', (() => {
  const d = tick({ staleMs: 400_000, clockTrust: false, recoveries: 1 });
  return d.phase === 'idle' && !d.recover && !d.giveUp && d.nextRecoveries === 1;
})(), JSON.stringify(tick({ staleMs: 400_000, clockTrust: false, recoveries: 1 })));
t('an hours-old heartbeat does not give the track up while hidden', () =>
  !tick({ staleMs: 3_600_000, clockTrust: false, recoveries: MAX_STALL_RECOVERIES }).giveUp);
t('a resumed tab runs the SHORT budget', (() => {
  const normal = tick({ staleMs: 8_000 });
  const grace = tick({ staleMs: 8_000, detectMs: RESUME_DETECT_MS });
  return !normal.recover && grace.recover;
})());

console.log('\nuser- and OS-owned element state');
t('user paused: nothing to watch, budget preserved', (() => {
  const d = tick({ paused: true, staleMs: 60_000, recoveries: 2 });
  return d.phase === 'idle' && !d.recover && d.nextRecoveries === 2;
})(), JSON.stringify(tick({ paused: true, staleMs: 60_000, recoveries: 2 })));
t('scrubbing: never a stall', () => {
  const d = tick({ scrubbing: true, staleMs: 60_000 });
  return d.phase === 'idle' && !d.recover;
});
t('no track loaded: idle, no give-up', () => {
  const d = tick({ hasTrack: false, staleMs: 60_000 });
  return d.phase === 'idle' && !d.recover && !d.giveUp;
});
t('a pause taken mid-recovery does not reset the budget', () => {
  // audio.load() pauses the element for a moment, so a paused tick lands in
  // the middle of a recovery attempt as often as not.
  const spent = tick({ staleMs: 21_000 });
  const duringPause = tick({ paused: true, staleMs: 5_000, recoveries: spent.nextRecoveries });
  const nextAttempt = tick({ staleMs: 21_000, recoveries: duringPause.nextRecoveries });
  return spent.nextRecoveries === 1 && duringPause.nextRecoveries === 1 && nextAttempt.nextRecoveries === 2;
}, JSON.stringify([tick({ staleMs: 21_000 }).nextRecoveries,
  tick({ paused: true, staleMs: 5_000, recoveries: 1 }).nextRecoveries]));

console.log('\nattempt cadence and the give-up');
{
  // A track that never plays again: attempts must be self-serialized (one
  // budget apart, no reload storm) and must END.
  const trace = simulate({ progressAtMs: Infinity });
  const attempts = marks(trace, 'recover');
  t(`a permanently dead track gets exactly ${MAX_STALL_RECOVERIES} reloads`,
    attempts.length === MAX_STALL_RECOVERIES, at(attempts));
  t('attempts land one budget apart (no reload storm)',
    at(attempts) === at([20_000, 40_000, 60_000]), at(attempts));
  t('give-up lands one budget after the last attempt, exactly once',
    at(marks(trace, 'giveUp')) === at([80_000]), at(marks(trace, 'giveUp')));
  t('the badge goes lit at the first overdue tick and never goes blank after', (() => {
    const first = trace.findIndex(x => x.phase === 'stalling');
    return first === 3 && trace.slice(first).every(x => x.phase !== 'idle');
  })(), JSON.stringify(trace.map(x => [x.at, x.phase])));
  t('healthy playback shows no badge at all',
    trace.slice(0, 3).every(x => x.phase === 'idle'),
    JSON.stringify(trace.slice(0, 3).map(x => [x.at, x.phase])));
}
{
  const trace = simulate({ progressAtMs: 22_000 });
  t('a stall that recovers on the first reload costs exactly one reload',
    at(marks(trace, 'recover')) === at([20_000]), at(marks(trace, 'recover')));
  t('recovered playback never reaches give-up', !trace.some(x => x.giveUp));
  t('the badge clears itself once the audio is audible again',
    trace.at(-1).phase === 'idle', JSON.stringify(trace.map(x => [x.at, x.phase]).at(-1)));
}
{
  // Flaky link across a long drive: each reload wins the audio back for a
  // while, and every audible recovery clears the budget, so the track is
  // reloaded as often as it needs to be and never abandoned.
  const trace = simulate({ progressAtMs: Infinity, resumeAfterReload: true, playRunMs: 30_000, ticks: 240 });
  const attempts = marks(trace, 'recover');
  t(`a flaky link reloads far more than the ${MAX_STALL_RECOVERIES}-reload budget allows`,
    attempts.length > MAX_STALL_RECOVERIES, `${attempts.length} attempts`);
  t('and is never skipped', !trace.some(x => x.giveUp));
  t('every attempt still waits a full budget after the last arm',
    attempts.every((a, i) => (i === 0 ? a === 20_000 : a - attempts[i - 1] >= STALL_DETECT_MS)), at(attempts));
  t('the badge is dark for the whole run the reload won back', (() => {
    // reload at 20 s → audible at 22 s → dies again at 52 s: every tick of
    // that play run must advertise nothing.
    const run = trace.filter(x => x.at >= 25_000 && x.at <= 50_000);
    return run.length === 6 && run.every(x => x.phase === 'idle');
  })(), JSON.stringify(trace.filter(x => x.phase !== 'buffering').map(x => [x.at, x.phase]).slice(0, 10)));
}
{
  const trace = simulate({ progressAtMs: Infinity, maxRecoveries: 1 });
  t('maxRecoveries=1: one attempt then give-up',
    at(marks(trace, 'recover')) === at([20_000]) && at(marks(trace, 'giveUp')) === at([40_000]),
    `${at(marks(trace, 'recover'))} ${at(marks(trace, 'giveUp'))}`);
}
{
  // A load that never even answers (hung TCP): the flag ages out and the
  // cadence still terminates in a give-up instead of spinning on the flag.
  const trace = simulate({ progressAtMs: Infinity, loadYieldsMetadata: false });
  t('a load that never returns metadata is still bounded',
    at(marks(trace, 'recover')) === at([20_000, 40_000, 60_000]) && at(marks(trace, 'giveUp')) === at([80_000]),
    `${at(marks(trace, 'recover'))} ${at(marks(trace, 'giveUp'))}`);
}

console.log('\nwhere a recovery resumes the item');
// The freeze the user reported: 29 s of a 58-min item already heard, then a
// dead media socket. The listener's saved progress in the index is a stale,
// lagging copy — and Chromium's reset-to-0 on a broken pipe clobbers it.
t('a recovery resumes where the listener stopped, not where the index says',
  stallResumeTarget({ currentTime: 29.4, readyState: 2, savedProgress: 8 }) === 29.4,
  `${stallResumeTarget({ currentTime: 29.4, readyState: 2, savedProgress: 8 })}`);
t('a stale buffer (readyState 4) still carries the live position',
  stallResumeTarget({ currentTime: 29.4, readyState: 4, savedProgress: 0 }) === 29.4);
t('the index is the fallback only when the element never had metadata',
  stallResumeTarget({ currentTime: 0, readyState: 0, savedProgress: 1200 }) === 1200,
  'boot / play-retry on a track the element never loaded');
t('metadata landed: the element is the authority', () => {
  // readyState 1 = HAVE_METADATA is the first state at which currentTime is
  // meaningful, so a recovery must not prefer the index's copy over it.
  const atMetadata = stallResumeTarget({ currentTime: 29.4, readyState: HAVE_POSITION_READY_STATE, savedProgress: 8 });
  const belowMetadata = stallResumeTarget({ currentTime: 29.4, readyState: HAVE_POSITION_READY_STATE - 1, savedProgress: 8 });
  return atMetadata === 29.4 && belowMetadata === 8;
}, `${HAVE_POSITION_READY_STATE}`);
// A fresh pick passes currentTime 0 (the element's clock belongs to the track
// being left), so the only resume record left is the index copy — even with
// the previous pipeline still looking fed at readyState 4.
t('a fresh pick resumes at the saved position, not the previous track\'s clock',
  stallResumeTarget({ currentTime: 0, readyState: 4, savedProgress: 215 }) === 215,
  `${stallResumeTarget({ currentTime: 0, readyState: 4, savedProgress: 215 })}`);
t('a position Chromium never gave the element falls back to the saved one',
  at([stallResumeTarget({ currentTime: 29.4, readyState: 0, savedProgress: 8 }),
      stallResumeTarget({ currentTime: NaN, readyState: 4, savedProgress: 8 }),
      stallResumeTarget({ currentTime: -1, readyState: 4, savedProgress: 8 }),
      stallResumeTarget({ currentTime: Infinity, readyState: 4, savedProgress: 8 })]) === at([8, 8, 8, 8]));
t('neither clock usable: resume at 0 rather than a garbage offset',
  at([stallResumeTarget({ currentTime: 0, readyState: 0, savedProgress: 0 }),
      stallResumeTarget({ currentTime: NaN, readyState: 0, savedProgress: NaN }),
      stallResumeTarget({ currentTime: -5, readyState: 4, savedProgress: -5 })]) === at([0, 0, 0]));
t('a progress file clobbered to 0 does not override a live position',
  stallResumeTarget({ currentTime: 29.4, readyState: 3, savedProgress: 0 }) === 29.4);

console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(tmpDir, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
