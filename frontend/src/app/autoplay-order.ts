/**
 * Which track autoplay plays next, for every mode the Settings row offers.
 *
 * Deliberately pure — no Angular, no DOM, no fetch — so a test can hand it a
 * queue and a finished track and check the pick directly
 * (`node tests/autoplay-order.test.mjs`). Every autoplay decision in the
 * player routes through `pickNextTrack`, which is the point: the modes used to
 * be honoured in ONE code path (finish → next) and hard-coded to "the newest
 * thing in the list" in the others (a defunct/broken track skipped mid-play,
 * the post-refresh fallback, the autoplay on page load), so a chosen mode was
 * silently ignored exactly on the paths that fire when something goes wrong.
 *
 * `queue` is any list of playables. Selection is by TIME, never by position,
 * so the pick does not depend on how the caller sorted it — the player happens
 * to hand in the newest-first queue, but a page slice or a differently ordered
 * list gets the same answer.
 */

export type AutoplayMode = 'newest' | 'newer' | 'older' | 'oldest' | 'off';

/** The two fields a pick can depend on; the player's `Video` satisfies it. */
export interface AutoplayQueueItem {
  videoId: string;
  publishedAt: string;
}

/**
 * @param queue every playable track, in any order.
 * @param mode the user's autoplay choice.
 * @param finished the track the caller is LEAVING — one that just ended, failed
 *        to play, or was skipped by hand. It is never returned: the relative
 *        modes exclude it by id inside their `<=`/`>=` scan, and the extremes
 *        skip it too, so a manual ⏭️ under 'newest'/'oldest' cannot land back on
 *        the track the user just pressed Next away from. Absent means nothing is
 *        being left behind — the autoplay on page load — and the direction modes
 *        then start at the end of the timeline they move along: 'newer'/'newest'
 *        at the newest, 'older'/'oldest' at the oldest. That is what makes a page
 *        load honour a mode instead of defaulting to newest.
 * @returns the track to play, or undefined when the mode stops playback
 *          ('off') or nothing in `queue` satisfies it — the caller refreshes
 *          the index and tries again, or stops.
 */
export function pickNextTrack<T extends AutoplayQueueItem>(
  queue: T[],
  mode: AutoplayMode,
  finished?: AutoplayQueueItem | null
): T | undefined {
  if (mode === 'off' || queue.length === 0) return undefined;

  // The extremes: ties resolved by scan order, so 'newest' takes the first
  // freshest item a newest-first list puts at its head and 'oldest' the last
  // oldest one it puts at its tail — both reproduce the old head/tail pick.
  // With nothing finished, the direction modes land here too. A `finished`
  // track is skipped here as well (see the doc above): 'newest' of a
  // newest-first queue IS that track when it is the freshest thing left, and a
  // manual ⏭️ must not return it.
  if (mode === 'newest' || mode === 'oldest' || !finished) {
    const towardOldest = mode === 'oldest' || (finished === undefined && mode === 'older');
    let pick: T | undefined;
    let best = NaN;
    for (const v of queue) {
      if (finished && v.videoId === finished.videoId) continue;
      const t = new Date(v.publishedAt).getTime();
      // An unparseable date (NaN) loses every comparison, so seeding from the
      // first item would let a junk timestamp win by never being beaten.
      if (Number.isNaN(t)) continue;
      if (pick === undefined || (towardOldest ? t <= best : t > best)) {
        pick = v;
        best = t;
      }
    }
    return pick;
  }

  // Relative modes: the NEAREST neighbour in the requested direction, not the
  // extreme — 'older' taking the head would jump forward in time, and 'newer'
  // taking the tail would land on the oldest thing that is merely newer.
  // Comparisons are INCLUSIVE of the finished track's own timestamp on purpose:
  // same-timestamp siblings (batched imports, grabby cluster bands) would
  // otherwise never be pickable at all. The finished track is excluded by id,
  // which is also what stops it being picked by its own <= / >= — the index
  // still carries it until the next load.
  const finishedTime = new Date(finished.publishedAt).getTime();
  let best: T | undefined;
  for (const v of queue) {
    if (v.videoId === finished.videoId) continue;
    const t = new Date(v.publishedAt).getTime();
    if (Number.isNaN(t)) continue;
    if (mode === 'older' ? t <= finishedTime : t >= finishedTime) {
      if (best === undefined) {
        best = v;
      } else {
        const bt = new Date(best.publishedAt).getTime();
        const nearer = mode === 'older' ? t > bt : t < bt;
        // Ties keep the earlier list position: a cluster band all shares one
        // drawn timestamp, and the newest-first queue's order is then the
        // stable one the user sees.
        if (nearer) best = v;
      }
    }
  }
  return best;
}

/**
 * The step a MANUAL ⏭️ takes, in mode terms.
 *
 * The Next button is the user asking for the next track by hand, so it obeys the
 * same mode as autoplay — except 'off', which means "autoplay plays nothing on
 * its own" and says nothing about a button the user pressed. There is no
 * backwards mode for 'off' to map to, so it steps one item older: the same
 * one-step-older walk the button did before modes existed, and the only reading
 * under which pressing Next repeatedly walks the whole library instead of
 * stopping. Kept here so the mapping is testable without Angular.
 */
export function manualNextMode(mode: AutoplayMode): Exclude<AutoplayMode, 'off'> {
  return mode === 'off' ? 'older' : mode;
}

/**
 * The step a MANUAL ⏮️ takes, in mode terms.
 *
 * Previous is Next read backwards: whichever way the chosen mode travels in
 * time, a step back travels the other way, so the same `pickNextTrack` answers
 * it and a ⏭️ then ⏮️ lands back on the track the user started from (nothing
 * was marked watched in between — `skipMarksWatched` OFF is what keeps the left
 * track in the queue, and the button is hidden when it is ON). 'off' mirrors its
 * own Next mapping: Next there walks one item older, so Previous walks one
 * item newer. The result is always a RELATIVE mode, never an extreme, which is
 * what makes it a NEIGHBOUR rather than a jump to the far end of the library.
 */
export function manualPrevMode(mode: AutoplayMode): Exclude<AutoplayMode, 'off'> {
  return (mode === 'newer' || mode === 'newest') ? 'older' : 'newer';
}
