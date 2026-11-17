# AGENTS.md - DrivePod Agent Hints

## Docs
- Full technical reference: `ARCHITECTURE.md` (verified against source 2026-10-16).
  Keep it updated when behavior changes; `README.md` is the public overview.

## Build, Lint, Typecheck Commands
- Full project build (includes backend tsc): `docker compose up -d --build`
- No dedicated lint script; tsc catches type issues. Always run after edits.

## Test Suite (content-miss checks, 2026-10-16)
- **T1 — live audit (read-only)**: `node tests/content-audit.mjs` (~4 s).
  DB → `index.json` → `progress.json` consistency: ordering
  (`publishedAt desc, videoId asc`), set equality, audioPath resolvability
  for every non-ignored row, dead grabby-index refs (INFO only when the DB
  row is ignored — the resolver/init exclude those by design), and the grabby
  **authorship marker** (A14/A14b: every `isGrabby` row must carry GrabbyTube's
  `createdAt` sidecar marker and be listed in the authored index — a hard failure
  either way). Run before AND after a deploy; it is the "is content being missed"
  gate.
  CAUTION (2026-11-11): stored `Video.audioPath` values are the NEUTRAL container
  paths (`/cache/<id>/<id>.mp3`); the host-side audit maps them back onto this
  checkout via `hostPath()` — never compare a stored path to `ROOT/cache`
  literally again (a false "1673 non-ignored rows missing audioPath" batch of
  failures was exactly that).
- **T2 — pure logic + scratch-DB integration** (`bash tests/run-scratch.sh`)
  (~1 min). Builds the REAL `backend/dist/server.js` and drives its
  exported seams (`cleanRssItems`, `parseYtDlpDuration`,
  `applyTodayMidnightRule`, `isFilteredOutByDuration`, `readMp3HeaderClaim`,
  `writeIfChanged`, `resolveGrabbyAudioPath`, `folderCorruptionReason`,
  `sidecarIsGrabbyAuthored`, the `DELETE /api/video/:id/grabby` handler via
  `app.handle`, …) in a `node:20-bookworm` docker with a scratch Prisma DB — no
  live system touched. Must be full `bookworm` (slim lacks the `openssl` CLI the
  Prisma engine probes). §17 hands `folderCorruptionReason` name lists (healthy
  grabby folder with a `.tr64k.mp3` + `.bak`, the old rule's 187 false positives,
  a real 0/2-audio corruption); §18 drives the consume route against a stubbed
  grabbytube on :8101 — which is why `run-scratch.sh` passes
  `--add-host grabbytube:127.0.0.1` (the image has no such name and the route's
  remote-first delete must resolve it).
- **T3 — browser E2E**: open the SPA headless on the queue tab (default),
  paginate to the `🎉 End of queue` sentinel by scrolling the
  `↓ Scroll for more items` element (the `#loadMoreTrigger` in the template
  is an Angular reference, NOT a CSS id — match by XPath text), collect the
  rendered videoId set from the YouTube links, diff against
  `index.json.filter(!watched && !ignored)`; then click one
  previously-broken row and confirm playback. The player is a detached
  `new Audio()` (app.component.ts) — `document.querySelector('audio')` is
  always null; verify via page title, the row's ▶️ span, or a network
  response for `/cache/<id>/<id>.mp3`. CAUTION: the headless SPA auto-plays
  and POSTs watched/progress — kill the tab when done, diff the watched set
  before/after, and unwatch test-consumed rows with a direct SQLite
  `UPDATE Video SET watched=0, progress=0` (the index self-heals on the
  next harvest, seconds later).
- **T4 — frontend playback logic (pure, no browser, no network)**:
  `node tests/stall-guard.test.mjs` (~1 s, 64 assertions). Compiles
  `frontend/src/app/stall-guard.ts` and drives the watchdog decision on simulated
  ticks: the `readyState 4` stale-buffer case (the real freeze), a load that never
  answers, scrubbing / paused / frozen-tab immunity, the 3-reload give-up cadence,
  both resume clocks (`stallResumeTarget`: element `currentTime` vs the laggy index
  copy), `streamTrackId(audio.src)` — the function that says WHICH track a
  `currentTime` belongs to, which is what fixes the next-track inherits its
  predecessor's position bug — and the error-attribution rules (`mediaEventTrackId`
  prefers the element's actual selection `currentSrc` over the `src` attribute,
  `mediaErrorIsTrackDefect` / `playRejectIsTrackDefect` decide whether a signal
  implicates the FILE at all), all driven on the shapes measured from the deployed
  chromium on 2026-11-17. No live system, no DB, no build.
- **T5 — advance/resume browser E2E recipe** (headless Chromium + `--autoplay-policy=no-user-gesture-required`):
  open the app, tag a short (≤150 s) queue row by id, click it (a trusted click
  is what grants playback permission), then either await its `ended` event or
  click a row whose id differs from the element's `src`. An auto-advanced track
  that logs `Resumed <id> from <X>s` with X > 0 while X is not that track's own
  saved progress is the bug. Prove the invariant both ways by serving the OLD
  and NEW bundle side by side (`docker cp` the pre-fix `index.html` as
  `old-index.html`, keep the fixed web root) — the buggy bundle reproduces
  `Resumed cm7i62EE7T8 from 105.9s`/`from 80.0s` where the fixed one starts at
  0. CAUTION: instrument the element with an `addInitScript` that wraps
  `window.Audio` (`window.__audios`) BEFORE the goto; a `tab.run`/evaluate after
  load is too late to observe the boot autoplay, and each headless SPA tab
  writes progress/watched — zero or unwatch the touched rows afterwards.
- **T6 — autoplay ordering (pure, no browser, no network)**:
  `node tests/autoplay-order.test.mjs` (~1 s, 38 assertions). Transpiles
  `frontend/src/app/autoplay-order.ts` with the frontend's own `typescript`
  (same recipe as T4) and drives `pickNextTrack(queue, mode, finished?)` on
  literal queues: every mode × finished-position, ties (a grabby cluster band
  shares one drawn timestamp), a shuffled queue giving the same pick as the
  newest-first one, the rowless-finished case (a consumed track is still in the
  queue the caller hands in), NaN `publishedAt` (never picked, never satisfies
  a step, never wins a scan), and the no-finished page-load picks. The bug these
  lock: a chosen mode was honoured only on finish → next; a skipped/broken
  track, the post-refresh advance and the autoplay on page load each hard-coded
  "the newest in the list".

## Workflow Reminders
- Use `Task`/`explore` agents for complex searches.
- Run full consistency cleanup + build after changes.
- **Post-transcode MP3 validation is mandatory** (`validateMp3File` in
  `downloadAndProcessVideo`): zero-hole scan, head check, Xing header,
  duration check, size-vs-Xing-header claim (`readMp3HeaderClaim`) —
  re-transcode once, then discard. `cleanupCorruptedFolders()` re-checks
  head + size claim on every published file each harvest and quarantines
  failures: the 9p-mounted Windows cache path corrupts files
  **after** publication (zero-holes and cross-file byte-merges under
  concurrent write load observed 2026-09-20; no sync software involved —
  suspected 9p/drvfs I/O layer). See ARCHITECTURE.md §5.5/§6.
- **`cleanupCorruptedFolders()` counts the audio file by EXACT NAME, not by
  extension** (`folderCorruptionReason(videoId, files)`, exported so T2 §17 can
  hand it name lists): a healthy GrabbyTube track carries
  `<id>.mp3.tr64k.mp3` (FrogRock's transcode cache for the radio broadcast —
  every grabby track gets one, because tunester delivers 160k/44.1k/stereo and
  the stream is 64k/mono/24kHz) and often `<id>.mp3.bak` (GrabbyTube's backup of
  a replaced file). Counting `.mp3` suffixes read "Multiple .mp3 files" on those
  folders and DELETED their DB rows (files preserved), so the item left the
  queue, its watched/progress state went with the row, and the shufflebag re-seeded
  it as fresh — "watched items come back forever". The rule is now: exactly one
  `<id>.mp3`, exactly one `<id>.json`, ≤2 thumbnails, anything else tolerated
  (transcodes, `.bak`, `.part`, `.vbrfix.tmp`, `.ffmeta`, raw `.webm`/`.m4a`).
  Live tally 2026-11-17 (owner's cache, 1,832 folders): the old rule flagged
  **187, the new one 0** — every one of the 187 carried exactly
  `<id>.mp3` + `<id>.mp3.tr64k.mp3`, all 187 had ALREADY lost their row, and 186
  of them are still listed in `shufflebag.json` (33 with `used: true`), so the
  content comes back through distribution instead of being lost — as unwatched,
  because the watched flag lived in the deleted row.
- **`DELETE /api/video/:id/grabby` decides library-track-ness from the sidecar,
  not from the DB row** (2026-11-17): the row is ALSO absent when something else
  already consumed the track (the cleanup above, `updateIndexFile`'s defunct-MP3
  filter, a delete made in the GrabbyTube UI, a second tab), while the caller's
  `index.json` — regenerated only on a harvest — still lists it. Answering 404
  `Video not found` there made the Delete key on a listed-but-rowless track alert
  and do nothing, forever. The rule: `video && !video.isGrabby` → 400 (DrivePod's
  own video, unchanged); no row AND no GrabbyTube `createdAt` marker on the folder
  sidecar → 404; marker present → the consume lands (remote delete, bag prune,
  `localRecords: 0`). Fail-closed on a remote failure is unchanged: 502 and
  nothing local is touched. T2 §18 drives all six paths against a stubbed
  grabbytube on :8101 (`--add-host grabbytube:127.0.0.1` in `run-scratch.sh`).
- Frontend caps repeated load failures per track (`MAX_TRACK_PLAY_FAILURES`)
  and skips unplayable-but-present tracks instead of reloading forever.
- **GrabbyTube tracks display the real artist via per-artist placeholder
  channels** (`channelId` = `UCGrabbyTube` + base64url(author), `title` =
  artist; bare `UCGrabbyTube` when no author). The SPA/head unit render
  `channel.title` as the artist (media session, queue, page title), so NEVER
  re-tag or re-encode grabby MP3s to change displayed metadata. Settings tab
  hides `UCGrabbyTube*` channels (frontend `loadChannels` filter); `DELETE`
  refuses them (403). `backfillGrabbyArtistChannels()` re-points stale rows
  at boot.
- **nginx gzip** (2026-10-06): the `drivepod-ngnix` server block sets
  `gzip_types` (JSON/JS/CSS, comp level 5) — the http-level nginx.conf
  default only compresses text/html, so index.json (~1.06MB, polled every
  2 min per client) and main-*.js (354KB) went out raw on throttled
  connections. index.json now ships ~179KB. The vps VPS proxy passes
  the client's `Accept-Encoding` through (nginx proxy default), so the
  in-container nginx does the compression and the VPS passes the gzip
  body untouched (confirmed by `Vary: Accept-Encoding` + level-5 size).
  Live-apply edits with `docker cp drivepod-ngnix drivepod:/etc/nginx/
  sites-available/drivepod` + `docker exec drivepod nginx -s reload`
  (avoids container recreation while a harvest is in flight); the repo
  file is only baked into the image on the next `--build`.

- **Node backend is supervisor-looped in the entrypoint** (2026-11-03): an
  unhandled Prisma P1008 (SQLite socket timeout) crashed `dist/server.js`
  2026-11-03 01:00 UTC and the entrypoint's bare `npm start &` never
  respawned it — container stayed "Up" (nginx serves statics → 200/304)
  while `/api/*` 502'd via the dead upstream for hours. The entrypoint now
  runs `npm start` in a background `( set +e; while true; do npm start; …done ) &`
  loop: restart with 5s→300s exponential backoff, reset after a ≥5 min
  healthy run, exit on SIGINT/SIGTERM (130/143). `set +e` is MANDATORY in
  the subshell — the entrypoint's top-level `set -e` otherwise kills the
  supervisor the moment `npm start` exits non-zero (verified: first
  iteration of the loop died silently). Kill-test: `docker exec drivepod
  pkill -9 -x node` (the `-f "node dist/server.js"` pattern also matches
  the `sh -c` pkill wrapper and kills itself, exit 137) — expect
  `⚠️ Node backend exited after Ns (code 137) — restarting in 5s` in the
  logs and `/api/config` back to 200 within ~10 s.

- **index.json / progress.json caching** (2026-10-06/07): the frontend
  fetches both files with STABLE URLs + `cache: 'no-cache'` (via the
  `fetchIndexWithProgress()` helper, which merges progress into the index
  BEFORE `mergeIndexWithLocal`) — never reintroduce a `?_t=` cache-buster
  or `no-store`, they kill ETag revalidation. Nginx regex location
  `~ ^/cache/(index|progress)\.json$`: `Cache-Control: no-cache` + `etag
  on` (no max-age, so a changed file is ALWAYS re-downloaded). Progress is
  SPLIT out of the index: `index.json` carries `progress: 0` for every
  item (byte-stable while a track plays), and `progress.json` holds only
  in-queue items with 0 < progress < duration as `[{videoId, progress}]`
  (~1.5 KB raw / ~430 B gzip — the only file that churns on the ~10 s
  progress saves). Backend `writeIfChanged()` (used by
  `updateIndexFile()` for both files) skips byte-identical rewrites — a
  no-op rewrite still bumps inode/mtime → new ETag → full re-download
  instead of a 304. Result: unchanged poll = 304 (~0 B), changed file =
  200 + new ETag, so the frontend always picks up the new version
  (verified in a real browser: wire-level 304s for both files, and a
  fresh tab resumed a track at its saved position — a value that only
  exists in progress.json). While playing: index 304 + progress 200
  (~430 B) per poll; idle: both 304. progress.json is best-effort on the
  frontend — a 404 (first boot) or failed fetch just means resume
  positions read 0 until the next poll.
- **`publishedAt` is DB-authoritative in the index** (2026-10-16):
  `updateIndexFile()` pins `meta.publishedAt = v.publishedAt` for EVERY
  item — a diverged per-item `{id}.json` (e.g. re-import wrote a fresh
  date) must never reorder the queue. Fix ordering in the DB, never by
  editing per-item JSON.
- **Stale `audioPath` self-heal** (2026-10-16): `cleanupCorruptedFolders()`
  re-points any row whose stored `audioPath` file is missing at the
  canonical `{id}/{id}.mp3` (when it exists), logging `🔧 Repaired stale
  audioPath on N row(s)`. 224 rows repaired 2026-10-16 — stale absolute
  paths 404'd on `/api/stream` and the player skipped the tracks as
  defunct.
- **`resolveGrabbyAudioPath()` is the only grabby path resolver**
  (2026-10-16): literal index path if that file exists, else canonical
  `cache/<id>/<id>.mp3` if that exists, else literal. Used by init,
  distribute (pull + recondition) and the pre-insert recheck. NEVER rewrite
  `grabby-index.json` — GrabbyTube owns it; its `audioPath` values go stale
  when its cache moves, which is why we resolve at read time.
- **Ownership is the sidecar `createdAt` marker, never the folder or the index
  listing** (2026-11-15): `cache/` is shared, so "the file is there" and
  "grabby-index.json lists this videoId" are NOT evidence that an item is music.
  GrabbyTube stamps `createdAt` into every sidecar it writes and nothing else in
  that directory does, so `isGrabbyAuthored()` (index entries) /
  `sidecarIsGrabbyAuthored()` (folders) are the single test at every decision:
  cleanup orphan rule, bag seed, distribute candidate filter, startup revert,
  T1 A14. The bare-sweep index that used `videoId`-key presence as ownership
  catalogued 1,340 DrivePod videos as tracks and had already flipped 464 of them
  to `isGrabby` — which reset watched/progress, faked their date (so auto-purge
  never reached them) and hid their real artist. Consequences to preserve:
  `distributeGrabbyItems` **refuses to convert an `isGrabby:false` row** (both at
  candidate filtering, so the planner spends no slot on it and the entry rotates
  back un-used, and again at placement, because a concurrent import can insert
  the row in between), and `revertForeignGrabbyRows()` runs FIRST at startup —
  before the bag seed, the artist backfill and the first harvest — restoring
  `publishedAt`/`channelId` from the sidecar and recreating a deleted channel as
  INACTIVE (re-activating it would silently resume harvesting). Missing or
  unreadable sidecar ⇒ stays grabby: without evidence the mix label is safer.
  T2 section 16 asserts all of it. GrabbyTube's own `update_index_file()` rebuilds
  from the same marker, so its index lists only what it authored (2,057 → 717).
- **Grabby timestamps are OURS, and the band is measured symmetrically**
  (2026-11-12): a grabby row's `publishedAt` is a `clusterTimestamp()` draw
  **inside** the band — at or below the newest normal video — never a real upload
  date, which is why `distributeGrabbyItems()` may rewrite it freely. Both sides
  of the ratio are tallied over that ONE 60-min window (`bandWindow`, lte the
  anchor). The old code measured grabby to a `+30 min` ceiling ABOVE the anchor
  while normal stopped AT the anchor: that space can never fill with normal
  content, so one 80-min archive file read as "grabby 4832 s vs normal 2594 s —
  ratio satisfied" while it sat at the very **top** of the queue above everything
  left to watch, and nothing was placed. Two consequences to preserve:
  (a) the run first **re-clusters any grabby row found above the anchor**
  (`🔧 Re-clustered N …`) and MUST do so *before* the tally, or that file is
  invisible to the ratio and the cluster cap and gets double-counted;
  (b) placement converges on COUNT parity too (`planGrabbyFill`), because
  duration parity alone is satisfied outright by one long file. T2 section 15
  drives the compiled `distributeGrabbyItems()` against a scratch DB and asserts
  these queue-level invariants (every placed row inside the band, nothing above
  the anchor, deficit log, tail-returns, index-wide bag prune, satisfied band
  writes nothing) — the pure planner tests cannot see timestamps or bag state.
- **`reconcileShuffleBag(returnIds, indexIds, pruneIds)` owns ALL bag bookkeeping**
  (2026-11-12, played-prune added 2026-11-16): unplaced pulls rotate back un-used
  at the TAIL (a head-insert re-pulls them every 5 min and starves shorter items),
  and entries grabby-index.json no longer lists are pruned index-wide —
  `used:true` ones included, since `used` only resets on re-init (~23 h for 1,985
  entries) and T1 A9 catches exactly that stranding. Two index-absence guards,
  because a pruned entry never rejoins until the next re-init: an empty `indexIds`
  prunes nothing, and a MASS absence (> 10 % of the bag — a partial index rewrite,
  not real deletions) is logged as `NOT pruned` and left alone. The third arg
  `pruneIds` is for ids the DB proved WATCHED this run (`distributeGrabbyItems`
  collects them from `rowStates`): those leave the bag **unconditionally** — `used`
  or not — and **bypass the mass-absence guard**, because unlike index absence they
  were checked against the DB this run, so there is no transient-read risk and a
  played track that rotated back would be re-pulled on every run until re-init.
  Played wins over returned: an id both skipped and proved watched is pruned, not
  rotated. NEVER rewrite `grabby-index.json` (GrabbyTube is its only writer) —
  read it, and prune OUR bag against it.
- **"Played" means out of the bag AND out of the rotation until un-played**
  (2026-11-16): reconditioning used to reset `watched:false, progress:0` on every
  existing row it placed, so a grabby track the user finished was dragged back to
  the top of the queue with a fresh date on the next 5-min run — and un-watching
  never stuck, because the bag kept holding it. Three points now close that:
  `initShuffleBag` set-asides any `isGrabby:true, watched:true` row (`🎵 … N
  played-and-set-aside`, an UNWATCHED row still seeds, a watched NON-grabby row
  too); `distributeGrabbyItems` treats a pull whose DB row is already watched as
  **not a candidate** (`⏭️ Skipping played item …`, collected into `playedIds` →
  reconcile's `pruneIds`), re-checked at placement in case the user marked it
  watched mid-run; and the two `/api/video/:id/watched` routes call
  `syncBagForWatched(id, watched)`, which drops the entry on watch and re-adds it
  at the tail on un-watch — but ONLY when grabby-index.json still lists the id
  with a playable MP3 (the same eligibility test a pull applies). A track deleted
  from the catalog then un-watched stays out of the bag by design. T2 section 6c
  locks the prune (mass-guard bypass, `used` entries, played-wins-over-returned);
  section 17 locks the seed set-aside and the un-watch re-admit guards.
- **Downloads run under a STALL watchdog, never a wall-clock cap**
  (2026-11-05): `downloadAndProcessVideo` uses
  `safeExecWithStallWatchdog(cmd, context, videoDir, opts)`. While the child
  runs it sums EVERY `.part` under `videoDir` **recursively**
  (`measurePartBytesRecursive`) every `POLL_INTERVAL_MS` (30 s) — recursive
  matters: a top-level-only scan reads 0 for yt-dlp's nested `{id}/ layout and
  mis-flags a healthy download as stalled (now a T2 assertion).
  NO GROWTH for `STALL_WINDOW_MS` (10 min) → SIGKILL the child + ONE retry
  (yt-dlp `--continue` resumes the `.part`, so a transient stall costs
  nothing). Any growth resets the window, so a large-but-slow download over a
  bad link NEVER times out regardless of total size. Rationale: a fixed
  `timeoutMs` would kill legitimate slow big downloads.
  **A SECOND consecutive stall throws `stalledTwice: true` — and the BAN that
  follows is gated by a CIRCUIT BREAKER (`consecutiveStallBans`).** Two stalls
  inside ONE invocation prove the item won't transfer, but NOT that the item is
  at fault: during an ISP/CDN outage every item's `--continue` retry freezes on
  the same dead link, so an unconditional `ignoreVideo()` would silently
  discard one item per ~20 min for the whole outage. The rule in
  `downloadAndProcessVideo`'s catch: ban only the FIRST twice-stalled item
  since the last *successful* download (that one really is dead — the
  successes prove the link works); while a ban is already on record with no
  success since, later stalls log `⛔→🚧 … skipped WITHOUT banning` and the
  item retries next cycle. Net effect: a 4-hour outage costs exactly ONE
  wrongly-ignored item instead of the whole queue. The counter is reset on
  every successful download (and by `resetStallBanCounter()`; it is process-
  local, so a mid-outage restart costs at most one extra collateral ban).
  `existingIds` discovery (server.ts ~L1985) has NO `ignored` filter, which is
  exactly why a banned row is permanent: it is never re-discovered and can never
  re-freeze the serialized harvest. Un-ban needs an explicit un-ignore/re-import.
  Note the `finally` block always rmSync's an incomplete video dir, so a stalled
  `.part` NEVER survives into the next cycle — the cross-cycle signal lives in
  this counter, not in leftover files. The stall budget is **hot-tunable** via
  `Config.stallWindowMs` / `Config.stallPollMs` (defaults to the constants) — no
  rebuild, and it lets T2 drive kill→retry→ban→suppress→reset→ban in ~1 s
  (section 14 uses fake yt-dlp/ffmpeg/ffprobe/vbrfix on PATH plus a canned
  8192-byte file whose Xing header claims its own exact size, so the REAL
  `validateMp3File` accepts it and the success path really clears the breaker).
  CAUTION: `spawn('/bin/sh','-c',cmd)` must stay INSIDE `runOnce` — hoisting it
  makes the "retry" reuse a dead child (invocations=1) and the ban never fires.
  Never reintroduce an unbounded download exec. Note the image's Node 20.20.2
  is a stripped build WITHOUT `Promise.withResolvers` — use the plain
  `new Promise(executor)` form there.
- **Discovery calls are time-bounded; skip paths are logged**
  (2026-10-16): `safeExec(cmd, context, timeoutMs?)` kills hung yt-dlp
  (120 s on `scrapeTab` + `fillMissingMetadata`). The harvest loop logs
  `⏭️ [videoId] Incomplete metadata (…) — will retry next cycle` and
  `⏭️ [videoId] VODFuture — not downloadable yet, will retry next cycle`
  instead of a silent `continue` — a "missed" video must always leave a log
  line. The post-metadata filter passes the resolved `duration` into
  `ignoreVideo()` (ignored rows were stored NULL duration — unauditable).

- **`post_live` streams are NOT hard-blocked** (2026-10-29): the `VODFuture`
  gate only blocks `is_live`/`is_upcoming`. YouTube keeps ended streams
  flagged `post_live` long after the VOD is already served (stale
  `live_status`), so blocking `post_live` strands finished streams forever
  (was `⏭️ … post_live — not downloadable yet` every cycle). `post_live`
  items fall through to `downloadAndProcessVideo()` (the download's
  `--match-filter` already allows it); if the VOD isn't ready yet the yt-dlp
  call fails cleanly (no row written, incomplete folder removed) and the
  item retries next cycle. See ARCHITECTURE.md §7.3.

- **Cross-tab state changes derive LOCALLY, no index re-fetch** (2026-11-04):
  `rawIndex` is the single source every tab derives from via `derivePlaylists()`
  (queue / protected / watched). When a user action MOVES an item between tabs —
  unwatch (`toggleWatched`), lock/unlock (`toggleProtect`, also the `L` hotkey), or
  grabby delete (`consumeGrabbyTrack`) — call `applyLocalVideoChange(videoId, patch)`
  or `removeLocalVideo(videoId)`, which mutate that one item in `rawIndex` and
  re-derive all three lists client-side. This is MANDATORY over re-fetching
  `index.json`: the connections are highly throttled (~180 KB gzipped index) so a
  full fetch per toggle is wasteful. The 2-min poll (`playlistRefreshInterval`)
  reconciles externally-driven changes (harvest, other clients) as the safety net.
  Unwatch zeroes `progress` so replay starts fresh. CAUTION: `derivePlaylists()`
  resets queue paging to page 1, so these toggles jump deep-scrolled Queue views to
  the top (pre-existing semantics — preserve scroll position first if you care).

- **Playback liveness watchdog (frontend) is the fix for "the app froze and
  nothing said why"** (2026-11-11, see ARCHITECTURE.md §12.3): a half-open
  `/api/stream` socket is INVISIBLE to the outage machinery — the backend keeps
  answering every NEW request (`HEAD /api/config` 200 for 40 min in the logged
  incident), so `backendOnline` never flips, no badge appears, and
  `audio.onerror` never fires. Detection is therefore **absence of `timeupdate`
  progress** (`lastProgressAt` vs `STALL_DETECT_MS`), and the repair MUST be a
  NEW HTTP request: re-issuing the same `src`/`load()` reuses Chromium's
  retained byte ranges, so playback resumes at the buffer edge and re-stalls
  there forever (that is exactly why only a fresh tab ever "fixed" it).
  Invariants: `readyState` NEVER gates a recovery (a stale full buffer reads as
  `4` and vetoed the old `!paused && readyState >= 2` check); only
  watchdog-issued loads (`_stallLoadOutstanding`) may be retried (autoplay-policy
  blocks must not reload forever); audible progress clears `_stallRecoveries`, so
  a flaky-but-recovering track is never skipped; a frozen/suspended tab's clock
  is untrusted and `resume`/`visibilitychange` own that decision.
  The resume point comes from `stallResumeTarget()` — the element's own
  `currentTime` once metadata has landed, else the (10 s-laggy) index copy —
  computed BEFORE `src` is re-assigned, because the load algorithm wipes the
  position; resuming at 0 with a 28 MB retained buffer replays ~6 min of a
  64 kbps mono track. Whether a load is a SAME-track load is decided by
  `streamTrackId(this.audio.src) === video.videoId`, NEVER by `currentVideo`
  (see the next bullet). NOTE: this is the *playback* watchdog; the similarly
  named `Config.stallWindowMs` mechanism above is the *download* watchdog —
  different problem, different file.

- **"Same track" is a property of the ELEMENT, not of `currentVideo`**
  (2026-11-15, see ARCHITECTURE.md §12.3): the app keeps one detached
  `new Audio()`, and `_tryPlay` sets `currentVideo` to the candidate BEFORE its
  HEAD probe resolves, while the `currentVideo -> null` effect that would clear
  `audio.src` is scheduled after that set — so on every advance (`onended`,
  `skipNext` with skip-marks-watched, `newest`/`oldest` autoplay, `_loadIndexAndPlay`)
  the element still holds the track being left while `currentVideo` already
  names the next one. `loadAndSeekVideo` used to derive `sameTrack` from
  `currentVideo`, so the NEXT track looked like the same track and was seeked to
  the finished track's position: any next track longer than the position being
  left started partway through itself (a 28-minute item resumed at 1:45 after a
  1:46 item ended; a row click inherited 80 s). Its side effect was also a spent
  watchdog budget — an advance inherited the old track's `_stallRecoveries`.
  `stall-guard.streamTrackId(src)` (the id inside `/api/stream/<id>`, null when
  `src` is '') is the only honest answer; a track the element is not loaded with
  passes `currentTime: 0`, so its own saved progress (or 0) decides. Row clicks
  on the ALREADY-playing track must still keep its live position (verified).

- **'newest' autoplay refreshes the index before picking** (2026-11-16,
  `_playFreshest` in `app.component.ts`): a head-only pick from `playlist()` plays
  "newest as of the last poll", not newest — a track harvested or downloaded since
  that poll is invisible to the cache, so autoplay could keep replaying a stale
  head and never surface a fresh item. Every `newest` advance now re-fetches first
  (cheap: `index.json` is byte-stable + no-cache, so it 304s when nothing changed)
  and plays the FRESHEST track still in the RE-derived queue, where the fresh item
  is finally visible. That pick is `_nextLeft(queue, exclude)` —
  `pickNextTrack(queue, 'newest', exclude)` with a list-order fallback for the one
  non-empty-queue case it answers undefined on (every `publishedAt` unparseable) —
  and `exclude` is the track being LEFT, dropped BY ID from the fresh fetch as well:
  a manual ⏭️ with `skipMarksWatched` OFF leaves it unwatched, so the refresh still
  lists it and a head-only pick would hand it straight back (a just-finished track
  is pinned watched by `mergeIndexWithLocal`'s `_localWatched` anyway). A dead
  backend never hard-stops the queue: offline, or if the refresh itself fails, it
  rolls to the freshest the CACHE has; only when the cache is empty too does it
  defer via `indexFetchPending` (the existing resume path).

- **The manual ⏭️ is the SAME mode-aware advance; the ⏮️ is its inverse, and
  both are gated on `skipMarksWatched`** (2026-11-17): `skipNext()` played
  `playlist[idx + 1]` — a neighbour in newest-first LIST order — so it ignored
  `older`/`oldest`/`newer`, and under `off` re-picked the track the user had just
  pressed Next away from as soon as the list shifted. It now calls
  `advanceToNextTrack(left, manualNextMode(autoplayMode()))`: the same
  `pickNextTrack` autoplay uses, with `off` → `older` (`manualNextMode`'s comment:
  `off` forbids autoplay, not a button the user pressed, and one-step-older is the
  only reading under which repeated Next walks the library instead of stopping).
  `skipPrevious()` (the ⏮️ button and the `previoustrack` handler, restored
  2026-11-17 after briefly being deleted) is the same call with
  `manualPrevMode(mode)` — the OPPOSITE direction, always a relative mode, never
  an extreme — so ⏭️ then ⏮️ lands back on the track the user started from under
  every neighbour-stepping mode (T6 §12b). **While `skipMarksWatched` is ON the
  button is not rendered and the handler no-ops**: with that setting on, ⏭️ does
  not leave the left track in the queue, it MARKS it finished (watched, out of the
  queue, out of the bag), and a finished track is not something a "back" step can
  undo — there is nothing to step back to, so offering ⏮️ would offer either a
  dead press or a re-entry of a finished track. The handler stays REGISTERED even
  then: an unregistered `previoustrack` makes the OS key a rewind, and letting
  that meaning flip on a Settings toggle nobody is looking at is worse than an
  inert key. Dead end of a walk = `pickNextTrack` answers undefined = restart the
  current track from the top, the media-player convention the pre-mode `idx <= 0`
  branch implemented. `skipMarksWatched` OFF is a user setting: the skipped track
  stays UNWATCHED and therefore stays in the queue — the marking is what removes
  it, not the skipping.

- **ALL FIVE autoplay modes are honoured on EVERY advance path** (2026-11-17,
  `frontend/src/app/autoplay-order.ts` → `pickNextTrack(queue, mode, finished?)`):
  the finish → next path was the only one that consulted the mode. Skipping a
  defunct/unplayable track, the post-refresh fallback (`_loadIndexAndPlay`) and
  the autoplay on page load each hard-coded `queue[0]` / `queue[len-1]` — newest
  first, so `queue[0]` meant "newest" — and a user who chose `older` or `oldest`
  got `newest` exactly when the queue hit trouble; a relative mode also lost its
  reference track and restarted at the wrong END of the timeline, re-entering the
  same broken region. Every path now routes through the one pure function, which
  picks by TIME (never by list position, so a page slice gets the same answer),
  resolves ties by scan order, excludes `finished` BY ID IN EVERY MODE (the
  extremes included — that is what stops a manual ⏭️ landing back on the track it
  left; not by strict `</>`, because same-timestamp cluster siblings must stay
  pickable), and with NO finished track starts a direction mode at the end it
  travels along (`older` at the OLDEST, so walking backwards has somewhere to
  walk). `autoplayMode` is read in exactly the paths that advance the queue, and
  `_playFreshest` re-reads it AFTER the fetch, so a Settings change in flight is
  the one honoured. `newest` still refreshes first (bullet above); `off` still
  stops autoplay. T6 covers the pick and `manualNextMode`; T2 cannot see the SPA,
  so the wiring is covered by the typecheck + T5, and the consume path by the live
  harness recorded in the changelog below (round 3).
- **Consuming the playing track advances through `stopAndAdvance`, and the 404
  branch is a success** (2026-11-17, `consumedGrabbyTrack()` in `app.component.ts`):
  both the 🗑️ button and the Delete hotkey route the whole post-delete behavior
  through one method. It snapshots `currentVideo()` BEFORE `removeLocalVideo()`
  (that call nulls `currentVideo`), drops the item from `rawIndex`, and only then
  — when THIS tab was playing this id — stops the element, clears the track and
  advances under `autoplayMode()` via the shared `stopAndAdvance(left, mode)` the
  manual ⏭️ uses. The bug this fixes: the handler called
  `markAsWatchedAndPlayNext()` AFTER the removal, and that function returns on its
  FIRST line when `currentVideo` is null, so Delete on the playing track marked
  nothing, advanced nothing, blanked the player and left the deleted file audible
  until it ran out — "it doesn't remove what I watched from the queue, and it
  ignores my autoplay mode". Snapshots matter twice: `left` is what `pickNextTrack`
  excludes, so a consume under `newer`/`older` continues from the track actually
  being left, not from scratch. NEVER call `markAsWatchedAndPlayNext()` from a
  consume: the row is gone, so a watched POST would only fire at a 404 (and the
  retry queue would hammer it). A tab that was NOT playing this id leaves playback
  in the other tab alone — it just loses the row from its own list.

- For Git: only commit when user explicitly asks (follow Git Safety Protocol in tools).

## Project Roots
- Backend: TypeScript/Express/Prisma + yt-dlp/ffmpeg
- Cache: `$CACHE_DIR` (videos as `{id}/{id}.mp3`, `{id}.json`, thumbnail)
- Harvest runs on cron + manual.

Update this file with new patterns after each task.
Last updated: 2026-11-12 (grabby mix: the ratio band is measured symmetrically
and a grabby row's `publishedAt` is OURS to rewrite, so a distribute run first
re-clusters any grabby row parked ABOVE the anchor, *before* the tally, and
placement converges on COUNT parity rather than duration alone (one 4,832 s
archive file used to read as "ratio satisfied" while sitting at the top of the
queue above everything left to watch). `reconcileShuffleBag(returnIds,
indexIds)` owns all bag bookkeeping: unplaced pulls rotate back un-used at the
tail, catalog-deleted entries are pruned index-wide (empty index set or >10 %
absence → prune nothing, log only). T2 gained section 15 — the compiled
`distributeGrabbyItems()` driven against a scratch DB, 122 assertions — because
the pure planner tests cannot see timestamps or bag state. The frontend
playback liveness watchdog (`stall-guard.ts` + `_runStallCheck()`, T4 =
`node tests/stall-guard.test.mjs`, 64 assertions) is now in the DEPLOYED
bundle: 20 s of no `timeupdate` progress on a "playing" element →
`⏳ Buffering…/Reconnecting…` badge + same-track reload over a NEW request,
resumed at `stallResumeTarget()`, skip after 3 attempts. E2E-proven against a
real wedged media socket: old bundle froze at 29.4 s with zero requests and no
badge, new bundle recovered in ~12 s and continued from 29.4 s with no replay.
T1's `hostPath()` translation of stored `/cache/...` audioPaths fixed 3
false-failure groups.
Last updated: 2026-11-15 (the next track no longer starts where the previous
one stopped. `loadAndSeekVideo` decided "same track" from `currentVideo`, which
`_tryPlay` had ALREADY overwritten with the candidate while the element still
held the finished track — so every advance seeked the next track to the
finished one's `currentTime`, and any next track longer than the position being
left began partway through itself (`Resumed cm7i62EE7T8 from 105.9s` after a
1:46 item; 80 s after a mid-track row click). Same-track identity now comes
from `stall-guard.streamTrackId(audio.src)`, so a different track passes
`currentTime: 0` and resumes at its own saved progress or 0, and gets a fresh
watchdog budget. T4 gained the ownership cases (8 assertions); T5 documents the
paired before/after headless-Chromium recipe. Verified in two real browser tabs
serving the pre-fix and post-fix bundles side by side, then deployed via
`docker compose up -d --build` — the deployed bundle is `main-EPSOMVDU.js` and
T1 still PASSes.)
Last updated (same day, second fix): the shared `cache/` dir had **no ownership
test** — GrabbyTube's index was a bare sweep keyed on "the sidecar has a
`videoId` key", which DrivePod's own sidecar also has, so 1,340 of its 2,057
"tracks" were DrivePod videos and 464 had already been converted to
`isGrabby:true` by reconditioning (watched/progress reset, real upload date
replaced by a band draw so auto-purge never reached them, artist replaced by a
placeholder channel). Ownership is now GrabbyTube's `createdAt` marker
(`isGrabbyAuthored` / `sidecarIsGrabbyAuthored`) and is consulted at EVERY
decision: GrabbyTube's index rebuild (2,057 → 717 entries), DrivePod's bag seed,
the cleanup orphan rule (which reclaimed 11 DrivePod folders / 1.1 GB instead of
skipping everything that looked grabby), the distribute candidate filter (a
`isGrabby:false` row is refused twice — filter time and placement time — and its
bag entry rotates back un-used), the startup `revertForeignGrabbyRows()` (runs
FIRST, before the bag seed / artist backfill / first harvest; restores
`publishedAt` + `channelId` from the sidecar, recreates a deleted channel
INACTIVE, never touches watched/progress/ignored/protected; no sidecar ⇒ stays
grabby) and T1 A14/A14b, which now FAIL on an unmarked grabby row or a grabby
row the authored index dropped. T2 gained section 16 (17 assertions over the real
compiled `initShuffleBag`/`distributeGrabbyItems`/`revertForeignGrabbyRows`;
suite total 139). Deployed: both containers rebuilt + recreated, 464 rows back to
normal (690 watched again, 1,114 normal + 388 grabby in the index), T1 PASS.
Last updated: 2026-11-17 (three symptoms the owner reported — "watched items
come back", "autoplay mode ignored", "Delete key alerts 'not found'" — were three
independent bugs, all fixed here). (1) `cleanupCorruptedFolders()` counted the
audio file by `.mp3` **suffix**, so FrogRock's radio transcode
`<id>.mp3.tr64k.mp3` (one exists for every grabby track: tunester delivers
160k/44.1k/stereo, the stream is 64k/mono/24kHz) read as "Multiple .mp3 files" on
**187 of the owner's 1,832 folders**, each of which lost its DB row (files kept,
so no data loss), its watched/progress state (which lives in the row), and its
queue membership — while `initShuffleBag` re-seeded it as un-played, which is the
"not remembering I watched it" loop. The verdict is now the exported pure
`folderCorruptionReason(videoId, files)`: exactly one `<id>.mp3`, exactly one
`<id>.json`, ≤2 thumbnails, everything else tolerated (transcodes, `.bak`,
`.part`, `.vbrfix.tmp`, `.ffmeta`, raw `.webm`/`.m4a`, a `.json` under a foreign
name — a live census found zero stray `.json` names, so nothing real depends on
flagging one). All 187 had ALREADY lost their row; 186 of them are still listed in
`shufflebag.json` (33 with `used: true`), so the content returns through
distribution — as unwatched. One 6-hour container log holds 34
`🚨 CORRUPTED … (🎵 grabby — preserving files)` lines, and the corruption branch only
runs for a folder that HAS a row, so those are 34 rows `distributeGrabbyItems()`
had just re-created and the cleanup ate again — the live churn. (2) Only the
finish → next path read
`autoplayMode`; skipping a defunct track, the unplayable give-up, the post-refresh
advance and the page-load autoplay each hard-coded `queue[0]`/`queue[len-1]`, and
since the queue is newest-first that IS `newest` — so `older`/`oldest` were
overridden exactly when the queue hit trouble, and a relative mode lost its
reference track and restarted at the wrong END of the timeline, re-entering the
same broken region. All five paths now call the one pure
`pickNextTrack(queue, mode, finished?)` in `frontend/src/app/autoplay-order.ts`
(new T6, 38 assertions; picks by TIME not list position, ties by scan order,
excludes `finished` BY ID so same-timestamp cluster siblings stay pickable, and
with no finished track starts a direction mode at the end it travels along).
(3) `DELETE /api/video/:id/grabby` answered 404 whenever the DB row was missing —
but the row is ALSO missing when something else already consumed the track (the
cleanup above, `updateIndexFile`'s defunct-MP3 filter, the GrabbyTube UI, a second
tab) while the caller's `index.json` (regenerated only on a harvest) still lists
it, so the Delete key alerted and did nothing forever; the folder's sidecar
`createdAt` marker is the ownership record, so marker-present now lands the
consume (remote delete + bag prune + `localRecords: 0`), 400 stays for a DrivePod
row, 404 needs no row AND no marker, fail-closed 502 unchanged. T2 gained §17 (the
verdict + the cleanup end-to-end) and §18 (all six consume paths against a stubbed
grabbytube on :8101, hence `--add-host grabbytube:127.0.0.1` in `run-scratch.sh`):
**185 assertions, exit 0**; T6 38/38; T1 PASS (700 queue, 379 marked grabby rows);
frontend `tsc --noEmit` clean and `ng build` → `main-J3IPX4RB.js`, `APP_VERSION`
1.10.0 → 1.11.0. Deployed through the listen hub (vendored `stack/drivepod/`, clean
3-way merge onto the pin, patch set byte-unchanged).
(2026-11-17, second round) The owner's "it's not respecting my choice of autoplay
mode" was a SECOND, still-unfixed instance of the same bug: the manual ⏭️
(`skipNext`, reached by the button and by `nexttrack` on a head unit) played
`playlist[idx + 1]` — a neighbour in newest-first LIST ORDER, not what
`older`/`oldest`/`newer` ask for — and under `off` re-picked the track just skipped
once the list shifted. Now `advanceToNextTrack(left, manualNextMode(mode))`, i.e.
the same `pickNextTrack` autoplay uses, `off` mapping to `older`;
`pickNextTrack`'s extremes ('newest'/'oldest') skip a `finished` track too, which is
what makes "never return what the user just pressed Next away from" hold in all five
modes, and `_playFreshest` takes that track as `exclude` and drops it from the fresh
fetch (with `skipMarksWatched` OFF the left track is still UNWATCHED, so the refresh
still lists it). New `_nextLeft` is the one "freshest still playable" answer, used
for the offline and failed-refresh rolls too. The ⏮️ button and the `previoustrack`
handler are removed: ← / → already seek ∓10 s inside the item, so Previous had no
mode-consistent meaning and the owner uses the arrow keys instead. T6 38 → 43
assertions (4b/4c = extremes skip what is being left / play it when nothing is; §11 =
`manualNextMode` mapping and the manual walks), T2 185/exit 0, T1 PASS, T4 53 pass,
`tsc --noEmit` clean, `ng build` → `main-T2WQJLFW.js`, `APP_VERSION` 1.11.0 → 1.12.0.
(2026-11-17, third round) The owner reported the app STILL not remembering
watched tracks, still not removing watched items from the queue, still ignoring
the autoplay mode, and the Delete key occasionally alerting "not found". The
404-alert half was already fixed server-side (round 1) — but the DEPLOYED
bundle carried neither that frontend branch nor round 2: the vendored tree in
the listen hub had been re-copied to the `0642f8a` pin, which predates both, so
the hub image served `main-Q75CKKAZ.js` reporting `APP_VERSION 1.13.0` from a
tree whose round-1 backend fix was present while its frontend was 265 lines
behind upstream. Re-vendored the whole set from `0642f8a` + these commits
(clean 3-way merge, hub patch set byte-unchanged) and redeployed. The remaining
"autoplay mode ignored / watched not removed" half was a third instance of the
ordering bug, this time in the consume handler: `markAsWatchedAndPlayNext()`
was called AFTER `removeLocalVideo()` had nulled `currentVideo`, and that
function's first line returns on a null `currentVideo` — so pressing Delete on
the track playing here marked nothing, advanced nothing and blanked the player,
while the deleted file stayed audible to its end (its stream socket was already
open). New `consumedGrabbyTrack()` snapshots the playing item first and routes
the advance through `stopAndAdvance(left, mode)`, the helper `skipNext` now
shares, so the 🗑️ button, the Delete key and the head-unit Next all stop →
clear → advance under the stored mode, and only the tab that owns playback
touches the element. T6 43/43, T2 185/exit 0, T1 PASS, T4 53 pass. The
production Angular build (its own strict typecheck — the host frontend tree has
no `node_modules`, so `ng build`/`tsc` run in the listen image's
`frontend-builder` stage) → `main-J5K7G6VO.js` reporting `APP_VERSION
1.14.0`. Deployed through the listen hub: vendored `stack/drivepod/`
updated, image rebuilt, container recreated, then re-driven live in headless
Chromium against `https://listen.example.com/l/owner/` (autoplay modes + the
Delete key on a fixture row, both below).

(2026-11-17, fourth round) The owner asked the ⏮️ / Previous back: restore the
button, the `skipPrevious()` function and the `previoustrack` MediaSession
handler, but keep them invisible / no-ops whenever "Skip marks as finished" is
enabled — that setting makes ⏭️ a FINISH (it marks the left track watched, so the
row leaves the queue and the bag), and a finished track is nothing a "back" step
can undo, so a Previous in that mode has no coherent meaning. `skipPrevious()`
therefore returns immediately when `skipMarksWatched()` is set and the template
renders the button under `@if (!skipMarksWatched())`, while the handler stays
registered either way (an unregistered `previoustrack` = OS rewind, and that
meaning must not flip on a Settings toggle). With the setting OFF the button is
`stopAndAdvance(left, manualPrevMode(autoplayMode()))` — new pure
`manualPrevMode` returns the OPPOSITE direction of the chosen mode ('newer'/
'newest' → 'older', 'older'/'oldest'/'off' → 'newer'), always relative, so a
Next then Previous returns the origin track and a Previous is a neighbour rather
than a jump to the far end. Nothing left in that direction restarts the current
track from the top, as `idx <= 0` did before the mode rewrite. T6 43 → 49
assertions (§12 = the mapping, the round-trip under the neighbour modes, the
neighbour picks in both directions, and the direction-dependent dead end), T2
185/exit 0, T1 PASS, T4 53 pass, `tsc --noEmit` clean, production `ng build` →
`main-<hash>.js` reporting `APP_VERSION 1.15.0` (bundle hash below), re-vendored
into the listen hub at this pin and redeployed.