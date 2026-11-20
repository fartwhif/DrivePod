/**
 * The watched/progress outbox — the pure half of "the network went away while
 * I was marking things watched".
 *
 * The app keeps an outbox of state operations (mark watched, save a resume
 * position) that must survive the backend being unreachable: each op is retried
 * until the server has it, and the in-memory `_localWatched` pin holds the UI
 * honest meanwhile. Two properties matter and neither is about how many times we
 * tried:
 *
 *   1. An op is only ever dropped when retrying CANNOT change the answer.
 *      A transport failure or a 5xx means the server has not judged the op at
 *      all — retry forever (capped backoff, one request/minute at worst),
 *      because a Wi-Fi flap that outlasts a budget silently loses the watched
 *      mark, and the next page load shows the track back in the queue with the
 *      network long since healthy. A 404/4xx means the server DID judge it and
 *      said no (the row is gone, the payload was rejected, the session expired)
 *      — dropping is correct, and RETRYING it is the bug: a permanently-failing
 *      op at the head of a FIFO starves every op behind it forever, and the
 *      starved ops' local pins keep them out of a queue the server still lists.
 *
 *   2. Attempt counts belong to the OP, never to the queue. A shared counter
 *      spends one op's failures against another's: the count reached its cap,
 *      every remaining op was then given up after a SINGLE try, and one
 *      ~30-second blip silently discarded the whole backlog of watched marks.
 *      It also picked the backoff: after a few failures of op A, a freshly
 *      queued op B inherited A's delay and waited its first minute for its
 *      first try.
 *
 * A probe success used to force a flush regardless of the backoff, which turns
 * "backend answers HEAD with 200 but its POSTs fail" into a flat 3 s retry
 * loop. Whether the backoff may be cut is therefore decided by the LAST
 * failure: a transport failure is exactly the question the probe asks (is it
 * reachable?) so a positive answer voids it; an HTTP status is an ANSWER from
 * the server, and proving the server reachable proves nothing about it.
 */

export type OpType = 'watched' | 'progress';

/** Why the last attempt on an op failed, and what would have to change. */
export type FailureKind = 'transport' | 'retryable' | 'permanent';

/**
 * Judge a failed attempt by the response, not by the retry count.
 *
 * `status` is null/undefined when no response ever arrived (`fetch` threw, a
 * connection reset, a gateway that answered nothing) — the signature of the
 * network being down, so it is NEVER permanent and never capped. `0` is the
 * SAME event seen through `HttpClient`, whose `HttpErrorResponse` reports a
 * transport failure as status 0 (no response, `error` is a `ProgressEvent`),
 * so both spellings must land in `transport`: reading 0 as an answer would
 * make every Wi-Fi flap a "verdict" and drop the watched mark it was about to
 * deliver, which is the exact loss this module exists to prevent.
 *
 * 408 (request timeout) and 429 (rate limited) are the server asking for the
 * request again; 5xx is the server sick (Prisma SQLITE_BUSY, a worker mid-
 * restart). Everything else the server actually answered — 400 (bad payload),
 * 401/403 (no longer signed in), 404 (the row is gone: the consume, the auto-
 * purge, the defunct-MP3 filter or another tab got there first), other 4xx —
 * is a verdict, and re-sending the same bytes cannot overturn a verdict.
 */
export function classifyFailure(status: number | null | undefined): FailureKind {
  if (status == null || status === 0) return 'transport';
  if (status === 408 || status === 429) return 'retryable';
  if (status >= 500) return 'retryable';
  // A 3xx that reaches the caller was not followed to anything usable; a
  // redirect the client could use would have been followed already.
  if (status >= 300 && status < 400) return 'permanent';
  return 'permanent';
}

/** First retry lands 2 s after a failure, and the wait doubles to a ceiling of
 *  one minute: enough to back off from a sick backend, short enough that a
 *  watched mark is on the server within a minute of the link coming back. */
export const BASE_RETRY_DELAY_MS = 2_000;
export const MAX_RETRY_DELAY_MS = 60_000;

/** How long to wait before the NEXT attempt, given how many already failed.
 *  Exponential, capped, and never derived from another op's history. */
export function retryDelayMs(attempts: number): number {
  const n = Number.isFinite(attempts) && attempts > 0 ? Math.min(attempts, 16) : 0;
  return Math.min(BASE_RETRY_DELAY_MS * 2 ** n, MAX_RETRY_DELAY_MS);
}

export interface OutboxOp {
  videoId: string;
  type: OpType;
  payload?: unknown;
  /** Attempts this op has burned, driving THIS op's backoff. */
  attempts: number;
  /** What the last failure of this op was; decides whether a connectivity
   *  probe may cut its backoff short. */
  blockedOn: FailureKind | null;
}

/**
 * A FIFO of state operations with per-op accounting.
 *
 * Pure: no timers, no fetch, no `Date.now()`. The caller owns the clock (it
 * asks how long to wait, and tells us what happened); we own the queue, the
 * dedupe, the attempt counts and the verdicts, which is where every version of
 * this outbox has had its bugs.
 */
export class Outbox {
  private ops: OutboxOp[] = [];

  get size(): number {
    return this.ops.length;
  }

  get isEmpty(): boolean {
    return this.ops.length === 0;
  }

  /** The op an attempt would target next (the head — ops are independent, so
   *  ordering only decides which one gets there first). */
  head(): OutboxOp | null {
    return this.ops[0] ?? null;
  }

  snapshot(): readonly OutboxOp[] {
    return this.ops.slice();
  }

  /**
   * Queue an op, keeping at most one live op per (videoId, type).
   *
   * A progress save supersedes the queued one for the same video (only the
   * newest position matters); a queued `watched` is already the whole message,
   * so a second one is dropped. Returns false when nothing was added, so the
   * caller does not re-arm the timer for a no-op.
   */
  enqueue(videoId: string, type: OpType, payload?: unknown): boolean {
    const existing = this.ops.find(o => o.videoId === videoId && o.type === type);
    if (existing) {
      if (type === 'progress') existing.payload = payload;
      return false;
    }
    this.ops.push({ videoId, type, payload, attempts: 0, blockedOn: null });
    return true;
  }

  /** How long until the head op's next attempt; 0 only when the queue is empty. */
  nextDelayMs(): number {
    const head = this.ops[0];
    return head ? retryDelayMs(head.attempts) : 0;
  }

  /** True when the head op's last failure said "I could not reach the server",
   *  which a successful connectivity probe answers — so the probe may flush it
   *  ahead of its backoff. A status-judged op keeps its backoff. */
  headBlockedOnTransport(): boolean {
    return this.ops[0]?.blockedOn === 'transport';
  }

  /**
   * Record a failed attempt; returns how long to wait before the next one.
   *
   * The op STAYS in the queue for every retryable kind: nothing is discarded on
   * a count, so no op is ever lost to a period of bad connectivity.
   */
  recordFailure(videoId: string, kind: Exclude<FailureKind, 'permanent'>): number {
    const op = this.ops.find(o => o.videoId === videoId);
    if (!op) return 0;
    op.attempts += 1;
    op.blockedOn = kind;
    return retryDelayMs(op.attempts);
  }

  /**
   * The server answered and the answer was no: drop this op for good.
   *
   * Only the named op leaves — the ops behind it were never judged, and they
   * get their own attempt next, which is the head-of-line fix.
   */
  drop(videoId: string): OutboxOp | null {
    const i = this.ops.findIndex(o => o.videoId === videoId);
    if (i < 0) return null;
    const [gone] = this.ops.splice(i, 1);
    return gone;
  }

  /** The server has the op now. */
  succeed(videoId: string): OutboxOp | null {
    return this.drop(videoId);
  }

  /**
   * Drop every queued op for a video that is no longer in the library.
   *
   * A row absent from a freshly fetched index has no row to write to: the
   * consume, the auto-purge or the defunct filter deleted it, so its watched/
   * progress op is a guaranteed 404 and would sit at the head of the queue
   * until this tab reloaded. Returns the dropped ops so the caller can clear its
   * local pin (nothing left to pin) and log what left the outbox.
   *
   * The caller must only hand this a NON-EMPTY index: an empty or failed read
   * proves nothing about which rows exist.
   */
  pruneNotIn(presentIds: ReadonlySet<string>): OutboxOp[] {
    if (presentIds.size === 0) return [];
    const kept: OutboxOp[] = [];
    const gone: OutboxOp[] = [];
    for (const op of this.ops) {
      if (presentIds.has(op.videoId)) kept.push(op);
      else gone.push(op);
    }
    this.ops = kept;
    return gone;
  }

  /** Forget everything (a re-login or a full reload starts a clean outbox). */
  clear(): void {
    this.ops = [];
  }
}
