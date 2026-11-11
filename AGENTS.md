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
  row is ignored — the resolver/init exclude those by design). Run before
  AND after a deploy; it is the "is content being missed" gate.
  CAUTION (2026-11-11): stored `Video.audioPath` values are the NEUTRAL container
  paths (`/cache/<id>/<id>.mp3`); the host-side audit maps them back onto this
  checkout via `hostPath()` — never compare a stored path to `ROOT/cache`
  literally again (a false "1673 non-ignored rows missing audioPath" batch of
  failures was exactly that).
- **T2 — pure logic (scratch container)**: `bash tests/run-scratch.sh`
  (~1 min). Builds the REAL `backend/dist/server.js` and drives its
  exported seams (`cleanRssItems`, `parseYtDlpDuration`,
  `applyTodayMidnightRule`, `isFilteredOutByDuration`, `readMp3HeaderClaim`,
  `writeIfChanged`, `resolveGrabbyAudioPath`, …) in a `node:20-bookworm`
  docker with a scratch Prisma DB — no live system touched. Must be full
  `bookworm` (slim lacks the `openssl` CLI the Prisma engine probes).
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
- **T4 — frontend liveness logic (pure, no browser, no network)**:
  `node tests/stall-guard.test.mjs` (~1 s). Compiles `frontend/src/app/stall-guard.ts`
  and drives the watchdog decision on simulated ticks: the `readyState 4`
  stale-buffer case (the real freeze), a load that never answers, scrubbing /
  paused / frozen-tab immunity, the 3-reload give-up cadence, and both resume
  clocks (`stallResumeTarget`: element `currentTime` vs the laggy index copy).
  No live system, no DB, no build.

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
  64 kbps mono track. NOTE: this is the *playback* watchdog; the similarly named
  `Config.stallWindowMs` mechanism above is the *download* watchdog — different
  problem, different file.

- For Git: only commit when user explicitly asks (follow Git Safety Protocol in tools).

## Project Roots
- Backend: TypeScript/Express/Prisma + yt-dlp/ffmpeg
- Cache: `$CACHE_DIR` (videos as `{id}/{id}.mp3`, `{id}.json`, thumbnail)
- Harvest runs on cron + manual.

Update this file with new patterns after each task.
Last updated: 2026-11-11 (frontend playback liveness watchdog: `frontend/src/app/stall-guard.ts` + `_runStallCheck()` catch silent starvation — 20 s of no `timeupdate` progress on a "playing" element — with a `⏳ Buffering…/Reconnecting…` badge, a NEW-request reload resumed at `stallResumeTarget()`, and skip-after-3-attempts; T4 = `node tests/stall-guard.test.mjs`, 45 assertions. E2E-proven against a real wedged media socket: old bundle froze at 29.4 s with zero requests and no badge, new bundle recovered in ~12 s and continued from 29.4 s with no replay. T1's `hostPath()` translation of stored `/cache/...` audioPaths fixed 3 false-failure groups.)