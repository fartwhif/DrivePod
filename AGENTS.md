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
  connections. index.json now ships ~179KB. The contabo VPS proxy passes
  the client's `Accept-Encoding` through (nginx proxy default), so the
  in-container nginx does the compression and the VPS passes the gzip
  body untouched (confirmed by `Vary: Accept-Encoding` + level-5 size).
  Live-apply edits with `docker cp drivepod-ngnix drivepod:/etc/nginx/
  sites-available/drivepod` + `docker exec drivepod nginx -s reload`
  (avoids container recreation while a harvest is in flight); the repo
  file is only baked into the image on the next `--build`.

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
- **Discovery calls are time-bounded; skip paths are logged**
  (2026-10-16): `safeExec(cmd, context, timeoutMs?)` kills hung yt-dlp
  (120 s on `scrapeTab` + `fillMissingMetadata`). The harvest loop logs
  `⏭️ [videoId] Incomplete metadata (…) — will retry next cycle` and
  `⏭️ [videoId] VODFuture — not downloadable yet, will retry next cycle`
  instead of a silent `continue` — a "missed" video must always leave a log
  line. The post-metadata filter passes the resolved `duration` into
  `ignoreVideo()` (ignored rows were stored NULL duration — unauditable).

- For Git: only commit when user explicitly asks (follow Git Safety Protocol in tools).

## Project Roots
- Backend: TypeScript/Express/Prisma + yt-dlp/ffmpeg
- Cache: `$CACHE_DIR` (videos as `{id}/{id}.mp3`, `{id}.json`, thumbnail)
- Harvest runs on cron + manual.

Update this file with new patterns after each task.
Last updated: 2026-10-16 (content-miss test suite T1/T2/T3 + fixes: publishedAt DB pin, stale audioPath self-heal, grabby path resolver, safeExec timeouts, skip-path logging)