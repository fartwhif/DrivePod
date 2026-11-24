#!/usr/bin/env node
/**
 * T7 — Outbox policy tests for the watched/progress retry queue
 * (frontend/src/app/retry-policy.ts).
 *
 * retry-policy.ts is deliberately timer-free and fetch-free, so this drives the
 * REAL module with a scripted outcome stream: no Angular, no browser, no backend.
 * The TypeScript is transpiled with the frontend's own compiler so the suite runs
 * on any Node (the scratch container is node:20, which cannot import .ts).
 *
 * The complaint these cases lock: a transient network problem left state damaged
 * AFTER the network came back. One shared `retryAttempts` counter fed both the
 * give-up decision and the backoff, so a ~30-second blip drained the whole backlog
 * of watched marks (ten failures at any point in the process's life ended ALL
 * retrying), a freshly queued op inherited a stranger's delay, and the probe's
 * unconditional flush hammered a backend that answered HEAD with 200 while its
 * POSTs kept failing.
 *
 * Run: node tests/retry-policy.test.mjs   (host or container)
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
const SRC = path.join(ROOT, 'frontend/src/app/retry-policy.ts');
const js = ts.transpileModule(fs.readFileSync(SRC, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  fileName: SRC
}).outputText;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'retry-policy-'));
const tmpFile = path.join(tmpDir, 'retry-policy.mjs');
fs.writeFileSync(tmpFile, js);
const {
  BASE_RETRY_DELAY_MS,
  classifyFailure,
  MAX_RETRY_DELAY_MS,
  Outbox,
  retryDelayMs
} = await import(tmpFile);
fs.rmSync(tmpDir, { recursive: true, force: true });

let pass = 0, fail = 0;
const t = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL ${name} — ${detail}`); }
};
const at = arr => JSON.stringify(arr);

// ── 1. what a failed attempt MEANS ───────────────────────────────────────────
console.log('\nclassifying a failed attempt by the response, not by a counter');
{
  // No response arrived at all: fetch threw, the connection reset, the gateway
  // answered nothing. That is the network being down, so it is never a verdict.
  t('no response is a transport failure, never a verdict',
    at([null, undefined].map(classifyFailure)) === at(['transport', 'transport']));
  // status 0 is the SAME event seen through Angular's HttpClient: HttpErrorResponse
  // reports a transport failure as status 0 (no response, error is a ProgressEvent).
  // Reading 0 as an answer would make every Wi-Fi flap a "verdict" and drop the
  // watched mark it was about to deliver.
  t('status 0 (HttpClient spelling of a dead connection) is transport too',
    classifyFailure(0) === 'transport', `got ${classifyFailure(0)}`);
  // The server is sick, or politely asking again: retrying CAN change the answer.
  t('408, 429 and every 5xx are retryable',
    at([408, 429, 500, 502, 503, 504].map(classifyFailure))
      === at(['retryable', 'retryable', 'retryable', 'retryable', 'retryable', 'retryable']));
  // The server ANSWERED. Re-sending the same bytes cannot overturn an answer:
  // 404 is the row being gone (the consume, the auto-purge, the defunct-MP3
  // filter, another tab), 400 is a rejected payload, 401/403 an expired session.
  t('400, 401, 403, 404 and other 4xx are permanent',
    at([400, 401, 403, 404, 405, 409, 410, 422].map(classifyFailure))
      === at(['permanent', 'permanent', 'permanent', 'permanent',
              'permanent', 'permanent', 'permanent', 'permanent']));
  // A 3xx that reached the caller was not followed to anything usable.
  t('a 3xx the client could not use is permanent',
    at([301, 302, 307, 308].map(classifyFailure))
      === at(['permanent', 'permanent', 'permanent', 'permanent']));
  // Nothing outside the three kinds, for any plausible status — the null/undefined
  // inputs have to be classified too, or they leak into the result set untyped.
  const statuses = [null, undefined, 0, ...Array.from({ length: 700 }, (_, i) => i + 100)];
  const kinds = [...new Set(statuses.map(classifyFailure))].sort();
  t('every status lands in exactly one of the three kinds',
    at(kinds) === at(['permanent', 'retryable', 'transport']), at(kinds));
  // The distinction the whole give-up rule rests on: being unreachable is not a verdict.
  t('transport and retryable are never permanent (an op is not lost to being unreachable)',
    at([null, 0, 408, 429, 500, 503].map(s => classifyFailure(s) === 'permanent'))
      === at([false, false, false, false, false, false]));
}

// ── 2. the backoff belongs to the attempt count, and to no one else ─────────
console.log('\nper-op backoff');
{
  t('the first retry lands at the base delay',
    retryDelayMs(0) === BASE_RETRY_DELAY_MS, `got ${retryDelayMs(0)}`);
  t('the wait doubles with THIS op\'s failures',
    at([1, 2, 3, 4].map(retryDelayMs)) === at([4000, 8000, 16000, 32000]));
  t('the wait saturates at one minute and never exceeds it',
    at([5, 6, 7, 12, 1000, 1e9].map(retryDelayMs))
      === at([60000, 60000, 60000, 60000, 60000, 60000]));
  // A garbage attempt count must not produce NaN: a NaN delay handed to
  // setTimeout fires IMMEDIATELY, i.e. an accidental retry storm.
  t('a non-finite or negative attempt count falls back to the base delay',
    at([NaN, Infinity, -Infinity, -5, undefined, null, 'x'].map(retryDelayMs))
      === at(Array(7).fill(BASE_RETRY_DELAY_MS)));
  // The ceiling is what makes "retry forever" affordable: one request a minute.
  t('the ceiling is one minute, so retrying forever costs at most 60 requests/hour',
    MAX_RETRY_DELAY_MS === 60_000 && retryDelayMs(50) === MAX_RETRY_DELAY_MS);
}

// ── 3. the queue: dedupe, ordering, per-op accounting ───────────────────────
console.log('\nqueue shape');
{
  const o = new Outbox();
  t('a fresh queue owes nothing and arms no timer',
    o.isEmpty && o.size === 0 && o.head() === null && o.nextDelayMs() === 0);

  t('queueing a watched mark adds it and asks for the base delay',
    o.enqueue('a', 'watched') === true && o.size === 1 && o.nextDelayMs() === BASE_RETRY_DELAY_MS);
  // A second watched mark for the same video is the SAME message, so the caller
  // must be told nothing was added (otherwise it re-arms the clock for a no-op).
  t('a duplicate watched mark adds nothing',
    o.enqueue('a', 'watched') === false && o.size === 1);
  // Only the newest resume position matters, so a queued progress supersedes.
  o.enqueue('a', 'progress', { progress: 12 });
  o.enqueue('a', 'progress', { progress: 40 });
  t('a queued progress save is superseded, not duplicated, and carries the newest payload',
    o.size === 2
      && o.snapshot().filter(x => x.videoId === 'a' && x.type === 'progress').length === 1
      && o.snapshot().find(x => x.type === 'progress').payload.progress === 40,
    at(o.snapshot().map(x => [x.videoId, x.type])));
  // A watched and a progress op for one video are DIFFERENT messages.
  t('watched and progress for the same video are distinct ops',
    o.enqueue('a', 'watched') === false
      && o.snapshot().filter(x => x.videoId === 'a').length === 2);

  o.enqueue('b', 'watched');
  o.enqueue('c', 'watched');
  t('ops are served in the order they were queued',
    at(o.snapshot().map(x => x.videoId)) === at(['a', 'a', 'b', 'c']));
  t('every op starts with its own zero attempt count and no block',
    o.snapshot().every(x => x.attempts === 0 && x.blockedOn === null));
  // snapshot() must not hand out the live array.
  o.succeed('a');
  t('snapshot is a copy (later mutations do not rewrite a taken snapshot)',
    o.snapshot().length === 3 && (() => { const s = o.snapshot(); o.succeed('b'); return s.length === 3 && o.size === 2; })(),
    `${o.size}`);
}

// ── 4. an op is lost only when retrying cannot change the answer ────────────
console.log('\nnothing is ever lost to an attempt count');
{
  const o = new Outbox();
  o.enqueue('a', 'watched');
  // 200 consecutive transport failures — a dead link measured in HOURS at the
  // capped delay — and the op is still owed. The bug this locks: ten failures
  // ANYWHERE in the process's life ended all retrying, so a 30-second blip that
  // happened to burn three of them left the rest of the backlog doomed, and the
  // watched mark was gone with the network long since healthy.
  const delays = [];
  for (let i = 0; i < 200; i++) delays.push(o.recordFailure('a', 'transport'));
  t('a watched mark survives 200 straight transport failures',
    o.size === 1 && o.head()?.videoId === 'a' && o.head()?.attempts === 200,
    `size=${o.size} attempts=${o.head()?.attempts}`);
  t('and its backoff stayed capped at one minute for all of them',
    delays.every(d => d >= BASE_RETRY_DELAY_MS && d <= MAX_RETRY_DELAY_MS)
      && delays[199] === MAX_RETRY_DELAY_MS,
    `first=${delays[0]} last=${delays[199]} max=${Math.max(...delays)}`);
  // A sick backend (5xx) is likewise never a reason to lose the mark.
  for (let i = 0; i < 5; i++) o.recordFailure('a', 'retryable');
  t('a 5xx streak is survived too (the server being sick is not a verdict)',
    o.size === 1 && o.head()?.attempts === 205, `attempts=${o.head()?.attempts}`);
  // Only a verdict removes an op, and only the op it names.
  t('a verdict removes exactly the op it names',
    o.drop('a')?.videoId === 'a' && o.isEmpty);
  t('dropping an op that is not queued is a no-op',
    o.drop('nope') === null && o.enqueue('b', 'watched') === true && o.drop('a') === null && o.size === 1);

  const o2 = new Outbox();
  o2.enqueue('x', 'progress', { progress: 5 });
  o2.enqueue('y', 'watched');
  o2.recordFailure('y', 'transport');
  const yBefore = o2.snapshot().find(x => x.videoId === 'y').attempts;
  o2.succeed('x');
  const y = o2.snapshot().find(x => x.videoId === 'y');
  t('a success removes only its own op and leaves the survivor\'s attempt count alone',
    o2.size === 1 && y.videoId === 'y' && y.attempts === yBefore, at(o2.snapshot()));
  t('recording a failure for an op that has left the queue is a harmless no-op',
    o2.recordFailure('x', 'transport') === 0 && o2.size === 1);
  t('clear() starts a clean outbox (a reload or re-login owes nothing)',
    (o2.clear(), o2.isEmpty && o2.nextDelayMs() === 0 && o2.headBlockedOnTransport() === false));
}

// ── 5. a permanently-failing op cannot starve the queue ────────────────────
console.log('\nhead-of-line: the answered op leaves, the rest get their turn');
{
  const o = new Outbox();
  // The consume deleted z's row a moment after the user pressed Delete here;
  // this tab's stale index still lists it, so its watched mark is a 404 forever.
  o.enqueue('z', 'watched');
  o.recordFailure('z', 'transport');
  o.recordFailure('z', 'transport');
  const zDelay = o.nextDelayMs();
  o.enqueue('p', 'watched');
  // The second half of the shared-counter bug: op p inherited op z's backoff and
  // waited its first minute for its first try. nextDelayMs() is the HEAD's delay,
  // so this asserts both that z is still the head (its delay grew) and that a
  // freshly queued op's own first delay is the base one.
  t('a freshly queued op does not inherit the head op\'s backoff',
    o.head()?.videoId === 'z' && o.head()?.attempts === 2 && zDelay === 8000
      && retryDelayMs(o.snapshot().find(x => x.videoId === 'p').attempts) === BASE_RETRY_DELAY_MS,
    `zDelay=${zDelay} headAttempts=${o.head()?.attempts}`);
  const gone = o.drop('z');
  t('the starved ops stay queued behind a verdict and keep their own attempt counts',
    gone?.videoId === 'z' && at(o.snapshot().map(x => [x.videoId, x.attempts])) === at([['p', 0]]),
    at(o.snapshot()));
  t('the dropped op is returned so the caller can clear its local pin',
    gone.type === 'watched');
  // Ten more ops behind a verdict-bearing head all get served: nothing at the
  // head can hold the line for good, because a verdict empties the head at once.
  const o2 = new Outbox();
  for (const v of ['dead', ...Array.from({ length: 10 }, (_, i) => `v${i}`)]) o2.enqueue(v, 'watched');
  const served = [];
  while (!o2.isEmpty) {
    const op = o2.head();
    if (op.videoId === 'dead') { o2.drop('dead'); served.push(op.videoId); }
    else { o2.succeed(op.videoId); served.push(op.videoId); }
  }
  t('every queued op is eventually served (no head can block the queue forever)',
    at(served) === at(['dead', ...Array.from({ length: 10 }, (_, i) => `v${i}`)]), at(served));
}

// ── 6. a probe may cut short ONLY a reachability wait ──────────────────────
console.log('\nwhen a connectivity probe may flush');
{
  const o = new Outbox();
  t('an op that has not failed yet is not waiting on reachability',
    o.enqueue('a', 'watched') === true && o.headBlockedOnTransport() === false);
  o.recordFailure('a', 'transport');
  t('a transport failure is exactly the question the probe asks, so a probe may flush it',
    o.headBlockedOnTransport() === true);
  // An HTTP status is an ANSWER. Proving the server reachable proves nothing
  // about that answer, so the backoff stands — which is what stopped the flat
  // 3 s hammering when the backend answered HEAD with 200 while its POSTs failed.
  const o2 = new Outbox();
  o2.enqueue('b', 'watched');
  o2.recordFailure('b', 'retryable');
  t('a status-judged op keeps its backoff against a probe',
    o2.headBlockedOnTransport() === false);
  o2.recordFailure('b', 'transport');
  t('and regains the right to be flushed once it is the LINK that failed again',
    o2.headBlockedOnTransport() === true);
  const o3 = new Outbox();
  t('an empty queue is never blocked on transport (so the probe stops itself)',
    o3.headBlockedOnTransport() === false && o3.nextDelayMs() === 0);
}

// ── 7. pruning against a freshly fetched index ─────────────────────────────
console.log('\nops whose row is gone');
{
  const o = new Outbox();
  o.enqueue('a', 'watched');
  o.enqueue('b', 'progress', { progress: 3 });
  o.enqueue('c', 'watched');
  // A row absent from a NON-EMPTY index has no row to write to. An empty read
  // proves nothing — pruning on it would drop every pending mark the moment a
  // harvest happened to answer nothing (or the fetch itself failed).
  t('an empty id set prunes nothing (a failed or empty read proves nothing)',
    at(o.pruneNotIn(new Set())) === at([]) && o.size === 3);
  const gone = o.pruneNotIn(new Set(['a', 'b']));
  t('only the absent row\'s ops are dropped, and they are returned for pin clearing',
    at(gone.map(x => [x.videoId, x.type])) === at([['c', 'watched']])
      && at(o.snapshot().map(x => x.videoId)) === at(['a', 'b']),
    at(gone));
  t('pruning preserves queue order and the survivors\' attempt history',
    (o.recordFailure('a', 'transport'), o.pruneNotIn(new Set(['a', 'b'])),
      o.head()?.videoId === 'a' && o.head()?.attempts === 1),
    at(o.snapshot()));
  t('pruning an empty queue is a no-op',
    (o.clear(), at(o.pruneNotIn(new Set(['a']))) === at([]) && o.isEmpty));
  t('pruning keeps ops for every listed id (a watch on a re-listed row survives)',
    (() => { const q = new Outbox(); q.enqueue('a', 'watched'); q.enqueue('a', 'progress', { progress: 1 });
      return q.pruneNotIn(new Set(['a'])).length === 0 && q.size === 2; })());
}

// ── 8. the caller's loop against a scripted network ────────────────────────
console.log('\nthe whole retry loop, end to end');
{
  const PROBE_STEP = 3000;
  const BACK_AT = 40 * 60_000;
  // The shipped-before cap: ONE counter for the whole queue — 10 failures at any
  // point in the page's life ended ALL retrying (`MAX_RETRY_ATTEMPTS`).
  const MAX_RETRY_ATTEMPTS = 10;

  /**
   * Event-simulated model of the shipped loop, with a virtual clock and no timers,
   * fetch, or Angular. `healthy(now)` is the reachability verdict — what the
   * `HEAD /api/config` probe gets at that instant; `answer(op, n)` is what the
   * server SAYS when the link is up, given the attempt count of THAT op. Two armed
   * clocks race, exactly as in the app: the outbox's own `setTimeout` (armed by
   * `_armOutboxClock` from the moment of the failure, for `nextDelayMs()`) and the
   * probe interval. A deadline tick attempts the head; a probe tick attempts it only
   * when the backend is reachable AND the head is the op whose last failure was the
   * link. A success attempts the next op at once (`flushOutbox`'s `next:` chain); a
   * failure or a verdict re-arms the clock from now.
   *
   * `legacy` reproduces the shipped-before policy as a CONTROL — one shared counter
   * feeding BOTH the give-up decision and the backoff, and a probe success flushing
   * whatever the reason — so the assertions below prove the scenarios discriminate
   * and are not tautologies.
   */
  const runLoop = (queue, { healthy, answer, legacy = false, maxTicks = 100000, maxShared = MAX_RETRY_ATTEMPTS }) => {
    const o = new Outbox();
    for (const [videoId, type, payload] of queue) o.enqueue(videoId, type, payload);
    let now = 0, ticks = 0, probeTicks = 0, attempts = 0, shared = 0, deadline = null;
    const landed = [], dropped = [];
    const attemptsOf = (id) => o.snapshot().find(x => x.videoId === id)?.attempts ?? 0;
    // The wait the clock is armed for right now. The legacy one came from the
    // SHARED counter, which is why a fresh op waited a stranger's delay.
    const waitNow = () => (legacy
      ? Math.min(BASE_RETRY_DELAY_MS * 2 ** shared, MAX_RETRY_DELAY_MS)
      : o.nextDelayMs());

    const attempt = () => {
      const op = o.head();
      if (!op) return false;
      attempts++;
      // The legacy failure path: one shared counter, bumped for ANY error —
      // transport included — with the give-up check sitting right behind it.
      // `flushPendingOps` only re-queued the head when NOT giving up, so a
      // give-up discarded that op and recursed straight into the next one.
      const failLegacy = () => {
        shared++;
        if (shared < maxShared) return false;
        o.drop(op.videoId);
        dropped.push([op.videoId, 'capped']);
        return true;
      };
      if (!healthy(now)) {
        if (legacy) return failLegacy();
        o.recordFailure(op.videoId, 'transport');
        return false;
      }
      const res = answer(op, (legacy ? shared : attemptsOf(op.videoId)) + 1);
      if (res === 'ok') {
        o.succeed(op.videoId); landed.push(op.videoId);
        if (legacy) shared = 0;
        return true;
      }
      const kind = classifyFailure(res);
      if (kind === 'permanent') { o.drop(op.videoId); dropped.push([op.videoId, res]); return false; }
      if (legacy) return failLegacy();
      o.recordFailure(op.videoId, kind);
      return false;
    };
    const chain = () => { while (attempt()) { /* ops land back to back */ } };

    while (!o.isEmpty && ticks++ < maxTicks) {
      if (deadline === null) deadline = now + waitNow();
      const nextProbe = (probeTicks + 1) * PROBE_STEP;
      if (nextProbe < deadline) {
        now = nextProbe; probeTicks++;
        if (healthy(now) && (legacy || o.headBlockedOnTransport())) {
          chain(); deadline = null;      // _armOutboxClock re-arms from now
          if (o.isEmpty) break;
        }
      } else {
        now = deadline; deadline = null;
        chain();
      }
    }
    return { landed, dropped, owed: o.snapshot().map(x => x.videoId), now, ticks, attempts, probeTicks, emptied: o.isEmpty };
  };

  const alwaysUp = () => true;
  const allOk = () => 'ok';
  const QUEUE_A = [['v1', 'watched'], ['v2', 'watched'], ['v3', 'watched'],
                   ['v4', 'progress', { progress: 9 }], ['v5', 'watched']];

  // ── scenario A: the link is dead for 40 minutes, then it is simply fine ──
  // Five marks queued while the link was down. Nothing the server says changes —
  // every failure is "no response", which is the network, not a verdict.
  const a = runLoop(QUEUE_A, { healthy: (now) => now >= BACK_AT, answer: allOk });
  t('a 40-minute outage loses NOTHING: every mark lands once the link returns',
    a.emptied && at(a.landed) === at(['v1', 'v2', 'v3', 'v4', 'v5']) && at(a.dropped) === at([]),
    `landed=${at(a.landed)} dropped=${at(a.dropped)} owed=${at(a.owed)}`);
  // Recovery latency is ONE probe tick, not one backoff step. A transport failure
  // asked exactly "is it reachable?", so a positive answer voids the wait that
  // failure earned — otherwise a mark sitting at the 60 s ceiling waited another
  // minute with the network already healthy.
  t('…and everything is on the server within one probe tick of the link returning',
    a.emptied && a.now - BACK_AT <= PROBE_STEP, `late by ${a.now - BACK_AT}ms`);
  // The other half of "bounded work": while the backend could not be reached AT
  // ALL, the op was POSTed on its OWN capped backoff (~every 60 s), not once per
  // probe tick. The probe itself is cheap (one small HEAD every 3 s, 800 of them
  // here) — it is the retry hammering that had to go, and the ratio says which
  // clock drove the POSTs.
  t('…and while the link was down it retried on the capped backoff, not in a storm',
    a.attempts > 40 && a.attempts < 60 && a.attempts * 8 < a.probeTicks,
    `attempts=${a.attempts} probeTicks=${a.probeTicks}`);
  // CONTROL — the shipped-before policy on the SAME 40 minutes. `retryAttempts`
  // was bumped for a no-response just as much as for a 503, so the budget of 10
  // was spent on the OUTAGE, and at ~6 minutes every mark still in the queue was
  // discarded after one try each — 34 minutes before the link came back.
  const aOld = runLoop(QUEUE_A, { healthy: (now) => now >= BACK_AT, answer: allOk, legacy: true });
  t('…where the OLD shared counter discarded ALL FIVE marks ~6 minutes into a 40-minute outage',
    aOld.landed.length === 0 && aOld.dropped.length === 5 && aOld.emptied
      && aOld.now < BACK_AT / 4,
    `landed=${at(aOld.landed)} dropped=${at(aOld.dropped)} elapsed=${Math.round(aOld.now / 1000)}s`);

  // ── scenario B: HEAD answers 200 the whole time, the POSTs fail ──
  // A Prisma SQLITE_BUSY stretch, or a backend mid-restart behind a live gateway:
  // reachability is proven over and over while the ops keep getting 503. Proving
  // the server UP proves nothing about a 503, so the backoff has to stand.
  let busyCalls = 0;
  const b = runLoop([['w', 'watched']], { healthy: alwaysUp, answer: () => (++busyCalls <= 6 ? 503 : 'ok') });
  t('a reachable backend whose POSTs return 503 is retried on the backoff, never on the probe clock',
    b.emptied && at(b.landed) === at(['w']) && b.attempts === 7
      && b.now >= 2000 + 4000 + 8000 + 16000 + 32000 + 60000,
    `attempts=${b.attempts} elapsed=${b.now}ms`);
  t('…even though the probe proved reachability dozens of times while it waited',
    b.probeTicks > 50, `probeTicks=${b.probeTicks}`);
  // CONTROL: the same six 503s under the old unconditional probe flush — six
  // request pairs on six probe ticks, i.e. one every 3 s for as long as the
  // backend stayed sick, which is the hammering the fix exists to stop.
  busyCalls = 0;
  const bOld = runLoop([['w', 'watched']], { healthy: alwaysUp, answer: () => (++busyCalls <= 6 ? 503 : 'ok'), legacy: true });
  t('…where the OLD unconditional probe flush hammered it once every 3 s',
    bOld.emptied && bOld.attempts === 7 && bOld.now === 6 * PROBE_STEP,
    `attempts=${bOld.attempts} elapsed=${bOld.now}ms`);

  // ── scenario C: the row is gone (a verdict), so retrying cannot help ──
  // The consume deleted it in another tab; this tab's index is still stale. Endless
  // retrying is the wrong cure — the mark has nowhere to land — and it must not
  // make the op behind it wait the dead op's accumulated delay.
  const c = runLoop([['gone', 'watched'], ['keep', 'watched']],
    { healthy: alwaysUp, answer: (op) => (op.videoId === 'gone' ? 404 : 'ok') });
  t('a 404 is dropped, not retried, and the op behind it still lands',
    at(c.dropped) === at([['gone', 404]]) && at(c.landed) === at(['keep']) && c.emptied,
    `dropped=${at(c.dropped)} landed=${at(c.landed)}`);
  t('…and it lands on its own first delay, not on any clock the dead op had climbed',
    c.attempts === 2 && c.now === 2 * BASE_RETRY_DELAY_MS,
    `attempts=${c.attempts} elapsed=${c.now}ms`);

  // ── scenario D: the connection resets every other attempt, indefinitely ──
  // status 0 is what Angular's HttpClient reports for a reset connection, so this
  // is a link flapping at the POST layer while HEAD still gets through. Nothing is
  // ever lost, and each op lands on its next try.
  let flapCalls = 0;
  const d = runLoop(QUEUE_A, { healthy: alwaysUp, answer: () => (++flapCalls % 2 === 1 ? 0 : 'ok') });
  t('a link that resets every other attempt never discards a mark',
    d.emptied && d.landed.length === 5 && at(d.dropped) === at([]),
    `landed=${at(d.landed)} dropped=${at(d.dropped)} owed=${at(d.owed)}`);
  t('…and the work stays bounded: 5 marks needed 10 attempts, nothing ran away',
    d.attempts === 10 && d.ticks <= 12 && d.now <= 12 * PROBE_STEP,
    `attempts=${d.attempts} ticks=${d.ticks} elapsed=${d.now}ms`);
}

// ── 8. ONE request at a time ─────────────────────────────────────────────────
// An attempt is an HTTP request, and a request over a half-open connection
// (Wi-Fi association dead, NAT dropped the flow, phone out of coverage) answers
// NOTHING and errors NOTHING for minutes. Nothing used to record that an attempt
// was in progress, so every clock that can flush — the op's own backoff, the 3 s
// booster probe, the 5 s always-on probe — started a FRESH POST for the same head
// op, and when the pile finally answered, every continuation charged the SAME op
// an attempt it never earned.
console.log('\nbeginAttempt: one flight, whoever asks');
{
  const o = new Outbox();
  t('nothing is claimed when nothing is owed',
    o.beginAttempt() === null && o.attemptInFlight === false);

  o.enqueue('a', 'watched');
  o.enqueue('b', 'watched');
  const first = o.beginAttempt();
  t('the claim hands out the head op and marks the flight outstanding',
    first?.videoId === 'a' && first?.type === 'watched' && o.attemptInFlight === true,
    `claimed=${at(first)} inFlight=${o.attemptInFlight}`);

  // 33 flush triggers is ~100 s of the 3 s booster probe: exactly the window a
  // half-open socket stays silent for, measured against a black-hole port.
  let denied = 0;
  for (let i = 0; i < 33; i++) if (o.beginAttempt() === null) denied++;
  t('33 clocks asking during one unanswered request start 33 attempts: zero',
    denied === 33 && o.attemptInFlight === true && o.size === 2,
    `denied=${denied} size=${o.size}`);

  o.settleAttempt();
  o.recordFailure('a', 'transport');
  t('once the answer lands the head op is claimable again',
    o.beginAttempt()?.videoId === 'a' && o.snapshot()[0].attempts === 1,
    `next=${at(o.snapshot().map(x => [x.videoId, x.attempts]))}`);
  o.settleAttempt();

  // A verdict removes the op that is IN FLIGHT (a 404, or a prune against a
  // freshly read index). The flight still has to be settled by its own answer,
  // and the op behind it must not inherit a phantom claim.
  const o2 = new Outbox();
  o2.enqueue('x', 'watched'); o2.enqueue('y', 'watched');
  o2.beginAttempt();
  o2.drop('x');
  o2.settleAttempt();
  t('a dropped mid-flight op cannot wedge the one behind it',
    o2.beginAttempt()?.videoId === 'y' && o2.size === 1,
    `next=${at(o2.snapshot().map(x => x.videoId))}`);
  o2.settleAttempt();

  // Teardown is the one path where NEITHER callback ever runs (Angular cancels
  // the subscription when the component dies), so forgetting the ops has to
  // forget the claim too or the queue is mute for its whole life.
  const o3 = new Outbox();
  o3.enqueue('z', 'watched');
  o3.beginAttempt();
  o3.clear();
  o3.enqueue('z2', 'watched');
  const o3Claimed = o3.beginAttempt();
  t('a rebuilt outbox is not wedged by the flight the old tab abandoned',
    o3Claimed?.videoId === 'z2', `claim=${at(o3Claimed)}`);
  const o4 = new Outbox();
  o4.settleAttempt();
  t('settling without an outstanding attempt is inert', o4.attemptInFlight === false);
}

// The same clocks this app really runs, against a flight that answers NOTHING:
// a POST over a half-open connection (Wi-Fi association dead, NAT dropped the
// flow, phone out of coverage) sits for minutes without resolving and without
// erroring. The seed is one delivered transport failure — a reset is instant,
// which is what sets `blockedOn` and lets the probes flush at all — then the
// link goes silent for HANG_MS. `legacy` is the shipped-before caller, which
// asked the outbox for the head op instead of CLAIMING it, so every probe tick
// that found the backend reachable started another request for the same op.
console.log('\nthe unanswered request, measured in POSTs');
{
  const HANG_MS = 100000;      // how long one flight stays silent
  const WINDOW = 140000;       // what we watch
  const PROBE_MS = 3000;       // booster probe while an op is owed
  const ALWAYS_MS = 5000;      // always-on probe
  const CONNECTIONS_PER_ORIGIN = 6;   // Chrome's per-origin HTTP/1.1 pool
  const sim = (legacy) => {
    const o = new Outbox();
    o.enqueue('m', 'watched');
    o.recordFailure('m', 'transport');      // the reset that came before the hang
    const flight = [];                      // unanswered requests, FIFO by answer time
    let issued = 0, delivered = 0, peak = 0, probeTicks = 0, now = 0;
    let timer = now + retryDelayMs(o.snapshot()[0].attempts);   // _armOutboxClock
    const probeAt = (step) => Math.ceil((now + 1) / step) * step;
    while (true) {
      const next = Math.min(flight.length ? flight[0].until : Infinity, timer,
        probeAt(PROBE_MS), probeAt(ALWAYS_MS));
      if (next > WINDOW) break;
      now = next;
      if (flight.length && flight[0].until <= now) {
        // Each request dies at the CLIENT — our own timeout, not a server
        // answer. One subscription ends, so one attempt is charged and the
        // answer re-arms the caller's clock.
        while (flight.length && flight[0].until <= now) {
          flight.shift(); delivered++;
          if (!legacy) o.settleAttempt();
          o.recordFailure('m', 'transport');
          timer = now + retryDelayMs(o.snapshot()[0]?.attempts ?? 10);
        }
        peak = Math.max(peak, issued - delivered);
        continue;
      }
      const isProbe = now % PROBE_MS === 0 || now % ALWAYS_MS === 0;
      if (isProbe) probeTicks++;
      // A probe flushes only what its own answer proves: the head op's last
      // failure said "could not reach the server" and this probe reached it.
      if (isProbe && !o.headBlockedOnTransport()) continue;
      // flushOutbox clears its timer at the top of EVERY call, so a flush that
      // starts a request leaves the caller owning no clock: the answer re-arms
      // it. Before the claim there was nothing to tell the next tick that a
      // request was already out, so it started one too.
      timer = Infinity;
      const claim = legacy ? o.head() : o.beginAttempt();
      if (!claim) continue;
      issued++;
      flight.push({ until: now + HANG_MS });
      peak = Math.max(peak, issued - delivered);
    }
    peak = Math.max(peak, issued - delivered);
    return { issued, delivered, peak, probeTicks, owed: o.snapshot().map(x => [x.videoId, x.attempts]) };
  };
  const neu = sim(false);
  const old = sim(true);
  t('a flight that answers nothing for 100 s costs ONE request and one connection',
    neu.issued === 2 && neu.peak === 1 && neu.delivered === 1,
    `issued=${neu.issued} outstanding=${neu.peak} delivered=${neu.delivered}`);
  t('…and the probe ticks that fired inside the silence started attempts: zero',
    neu.probeTicks > 30 && neu.issued === neu.delivered + 1,
    `probeTicks=${neu.probeTicks} issued=${neu.issued}`);
  t('…the retry that follows waits for the answer instead of racing it',
    at(neu.owed) === at([['m', 2]]), `owed=${at(neu.owed)}`);
  // Control: identical clocks, identical silence, no claim. One POST per probe
  // tick, every one of them unanswered, so far more requests sit against this
  // origin than Chrome gives it connections — which is how the retry queue
  // starved the index.json poll and the audio stream that share the host — and
  // each death is charged to the op, so its backoff climbs on phantom verdicts.
  t('…where an unguarded flush queued 57 POSTs for the ONE owed mark',
    old.issued > 30 && old.issued > neu.issued * 15,
    `issued=${old.issued}`);
  t('…48 of them outstanding at once against an origin with 6 connections',
    old.peak > CONNECTIONS_PER_ORIGIN && neu.peak <= CONNECTIONS_PER_ORIGIN,
    `legacy peak=${old.peak} fixed peak=${neu.peak}`);
  t('…and the client timeouts charged that mark phantom attempts it never earned',
    old.delivered > 5 && old.owed[0][1] > 5 && neu.owed[0][1] === 2,
    `legacy owed=${at(old.owed)} (of ${old.issued} requests, ${old.delivered} died at the client) fixed owed=${at(neu.owed)}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
