/**
 * Playback liveness decision — the pure half of the client stall watchdog.
 *
 * WHY THIS EXISTS
 *
 * The app's old recovery was gated on the *connectivity probe*: audio was
 * reloaded only on a HEAD `/api/config` fail→ok transition. Two real-world
 * failure modes never produce that transition, so the player sat dead until
 * the user reloaded the tab:
 *
 *  1. A TCP connection that goes silent (phone in the car, dead Wi-Fi, NAT
 *     drop): no RST, so no `error` event; the buffer drains, `timeupdate`
 *     stops, and every probe keeps returning 200 because the backend was
 *     never unreachable.
 *  2. A backgrounded/frozen tab (screen off). Chrome stops firing
 *     `timeupdate`, and on Android the media pipeline is discarded ~5 s
 *     (audible) / ~15 s (silent) after the tab stops being visible while the
 *     tab's timers keep running. A reload of the same buffer is a no-op for
 *     a discarded pipeline, so only a *fresh* HTTP load resumes playback.
 *
 * The one signal that separates "playing" from "apparently playing" is the
 * wall clock between audible position advances: a playing MP3 advances
 * `currentTime` ~250 ms apart, so `timeupdate` is a liveness heartbeat. When
 * it is overdue while the element claims to be playing, something is wrong —
 * no matter what the probe says about the backend.
 *
 * Silence is re-armed by a fresh load as well as by progress, so each
 * starving tick necessarily follows a tick in which the previous attempt was
 * still getting its chance: attempts land at ~detect, ~2·detect, ~3·detect
 * after the stall began and the give-up at ~4·detect. A false alarm therefore
 * costs exactly one reload, and a real one costs no more than 4·detect of
 * silence.
 *
 * `evaluateStall` owns only the decision (total and side-effect free over its
 * inputs); `app.component.ts` owns the side effects: reload / skip / show
 * "Reconnecting…" (see `tests/stall-guard.test.mjs`).
 */

/** Budget granted after a frozen/suspended tab comes back (`resume` /
 *  visibilitychange→visible). Its heartbeat is stale by construction, so the
 *  normal detect budget would either forgive everything (frozen longer than
 *  `STALL_DETECT_MS`) or fire on every tab switch. The caller hands this in as
 *  `detectMs` while the grace is unexpired, so 6 s is both "long enough for a
 *  resumed element to prove it is advancing again" and "short enough that a
 *  discarded media pipeline is reloaded within ~12 s of unlock". */
export const RESUME_DETECT_MS = 6_000;

/** Silence that counts as "stalled" (5 × the 4 Hz `timeupdate` cadence): a
 *  playing or genuinely-loading track never goes this long without either
 *  advancing or holding a load in flight. */
export const STALL_DETECT_MS = 20_000;

/** Watchdog cadence. A tick costs a few boolean reads plus at most one HEAD,
 *  so it rides on the existing always-on connectivity probe's 5 s timer. */
export const STALL_CHECK_MS = 5_000;

/** Fresh loads attempted on one track before it is given up on. Any audible
 *  progress clears the count, so only a track that never plays again is
 *  skipped — a flaky link that keeps recovering is never abandoned. */
export const MAX_STALL_RECOVERIES = 3;

/** What `readyState` must reach for the element to count as fed:
 *  HAVE_FUTURE_DATA (3). HAVE_CURRENT_DATA (2) is spec'd as "playback of the
 *  current position is possible but continuous playback of what follows is
 *  not guaranteed", i.e. exactly a starved element — which is why the old
 *  `readyState >= 2` "looks fine" check vetoed the reload a stalled element
 *  needed. Used here only to name the phase (BUFFERING vs RECONNECTING); it
 *  NEVER suppresses a recovery. */
export const READY_STATE_FED = 3;

export type PlaybackPhase = 'idle' | 'buffering' | 'stalling';

/** User-visible status per phase; `idle` renders no badge. */
export const STALL_PHASE_LABEL: Record<Exclude<PlaybackPhase, 'idle'>, string> = {
  buffering: 'Buffering…',
  stalling: 'Reconnecting…'
};

export interface StallTick {
  /** A track is loaded and visible in the player. */
  hasTrack: boolean;
  /** `audio.paused` — the user or the autoplay policy owns the element:
   *  nothing to recover, and nothing to advertise. */
  paused: boolean;
  /** A scrub is in flight: seeking makes position advance erratically. */
  scrubbing: boolean;
  /** ms of silence since the heartbeat was last armed — by an audible
   *  `currentTime` advance or by a fresh load of this track. */
  staleMs: number;
  /** `audio.readyState`. Below READY_STATE_FED the element has no data for
   *  what comes next. Names the phase only; never vetoes a recovery. */
  readyState: number;
  /** A load of this track is mid-flight and young: issued less than
   *  `detectMs` ago with metadata still outstanding (the caller ages it
   *  out, so a hung request cannot hide behind this flag forever). While
   *  true the heartbeat cannot restart, so no attempt has failed yet. */
  loadInFlight: boolean;
  /** A play-after-outage retry loop (`_playRetryTimer`) owns this track. */
  retryPending: boolean;
  /** HEAD `/api/config` says the backend is down: the outage machinery
   *  (state snapshot + resume-on-recovery) owns recovery and a reload now
   *  could only fail. The badge still shows — the user IS waiting. */
  networkDown: boolean;
  /** Is this tick's wall clock trustworthy? TRUE when the page is rendered
   *  or the OS media session still reports playing (lockscreen / car
   *  head-unit). Where FALSE the tab is frozen/suspended: its timers run at
   *  ~1/min so a stale heartbeat proves nothing, and it may well be playing
   *  (Android keeps an audible tab's audio service alive when the screen is
   *  off). Those cases are decided by the tab's own `resume` event. */
  clockTrust: boolean;
  /** Loads attempted for the current track since its last audible progress.
   *  The caller clears it on any audible advance. */
  recoveries: number;
  detectMs?: number;
  maxRecoveries?: number;
}

export interface StallDecision {
  /** Status the UI must show. */
  phase: PlaybackPhase;
  /** Issue a fresh load of the current track (a new HTTP request). */
  recover: boolean;
  /** Attempts are spent and the backend is reachable: this track will not
   *  resume, so give up on it instead of freezing the player forever. */
  giveUp: boolean;
  /** Value to store back in the caller's attempt counter. */
  nextRecoveries: number;
  /** Value to store back in the caller's "load mid-flight" flag: aged out
   *  once the attempt has held the budget with no metadata, so a hung
   *  request cannot hide a stall behind the flag forever. */
  nextLoadInFlight: boolean;
}

/**
 * Decide what the watchdog should do on one tick.
 *
 * Timing needs no attempt clock: arming the heartbeat is part of issuing a
 * load, so a starving tick is by construction one where the previous attempt
 * (if any) has already been given the full detect budget.
 */
export function evaluateStall(t: StallTick): StallDecision {
  const detectMs = t.detectMs ?? STALL_DETECT_MS;
  const maxRecoveries = t.maxRecoveries ?? MAX_STALL_RECOVERIES;

  // Age the outstanding load out on the way in: past its budget a hung
  // request has had its chance and must stop suppressing a recovery.
  const loadInFlight = t.loadInFlight && t.staleMs < detectMs;

  // Not a playback situation at all: nothing to watch, nothing to show. The
  // budget survives (the caller clears it on audible progress or on a track
  // change) because `audio.load()` itself pauses the element for a moment, so
  // a paused tick lands in the middle of a recovery attempt as often as not.
  if (!t.hasTrack || t.paused || t.scrubbing) {
    return { phase: 'idle', recover: false, giveUp: false, nextRecoveries: t.recoveries, nextLoadInFlight: loadInFlight };
  }

  // A frozen/suspended tab lies about its clock (and may genuinely still be
  // playing through the OS audio service): its own `resume` event decides.
  if (!t.clockTrust) {
    return { phase: 'idle', recover: false, giveUp: false, nextRecoveries: t.recoveries, nextLoadInFlight: loadInFlight };
  }

  const starving = t.staleMs >= detectMs;
  const phase: PlaybackPhase =
    starving ? 'stalling' : loadInFlight || t.readyState < READY_STATE_FED ? 'buffering' : 'idle';

  // Somebody else is already recovering this track: the play-after-outage
  // retry loop, or the outage machinery while the backend is unreachable
  // (a reload there could only fail, and would spend the attempt budget).
  if (starving && (t.retryPending || t.networkDown)) {
    return { phase, recover: false, giveUp: false, nextRecoveries: t.recoveries, nextLoadInFlight: loadInFlight };
  }

  // A young load is still fetching: the heartbeat cannot restart before it
  // lands, so nothing has failed yet and no attempt is due.
  if (loadInFlight) {
    return { phase, recover: false, giveUp: false, nextRecoveries: t.recoveries, nextLoadInFlight: loadInFlight };
  }

  if (!starving) {
    return { phase, recover: false, giveUp: false, nextRecoveries: t.recoveries, nextLoadInFlight: loadInFlight };
  }

  if (t.recoveries < maxRecoveries) {
    return { phase, recover: true, giveUp: false, nextRecoveries: t.recoveries + 1, nextLoadInFlight: false };
  }

  // Attempts spent, backend reachable, load settled, nothing recovered: this
  // track will not resume by itself. Stop rather than freeze forever.
  return { phase, recover: false, giveUp: true, nextRecoveries: 0, nextLoadInFlight: false };
}

/** `readyState` from which the element's own `currentTime` is a position worth
 *  trusting: HAVE_METADATA (1). Below that the load never answered, so
 *  `currentTime` is 0 and only the index knows where the listener was. */
export const HAVE_POSITION_READY_STATE = 1;

export interface ResumeTarget {
  /** The element's playback position, read BEFORE its source is re-assigned
   *  (the load algorithm wipes it). Pass 0 when the load is a DIFFERENT
   *  track: that position belongs to the track being left. */
  currentTime: number;
  readyState: number;
  /** This track's progress as the index carried it when last fetched. */
  savedProgress: number;
}

/**
 * Where a recovery reload must resume the item.
 *
 * The element KEEPS its playback position when its connection dies or its
 * media pipeline is discarded, so its clock is exactly where the listener
 * stopped being heard. `savedProgress` is what the index carried, which is
 * the progress file's last write — seconds behind, and clobberable to 0 by a
 * spurious element-initiated reset — and a recovery never re-fetches the
 * index. Resuming from it threw a listener back to the START of an item they
 * were minutes into (the e2e reproduction resumed at 0 s after 29.4 s had
 * been heard, then re-saved progress 8 → 18 → 28 on top of the position the
 * user had already listened past).
 *
 * A position that is not finite or not positive is not a position, and one
 * the element never had metadata for is not either: both fall back to the
 * saved progress, which is the only record of where the listener was.
 */
export function stallResumeTarget(t: ResumeTarget): number {
  const usable = t.readyState >= HAVE_POSITION_READY_STATE
    && Number.isFinite(t.currentTime) && t.currentTime > 0;
  if (usable) return t.currentTime;
  return Number.isFinite(t.savedProgress) && t.savedProgress > 0 ? t.savedProgress : 0;
}
