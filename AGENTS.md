# AGENTS.md - DrivePod Agent Hints

## Docs
- Full technical reference: `ARCHITECTURE.md` (verified against source 2026-08-30).
  Keep it updated when behavior changes; `README.md` is the public overview.

## Build, Lint, Typecheck Commands
- Full project build (includes backend tsc): `docker compose up -d --build`
- No dedicated lint script; tsc catches type issues. Always run after edits.

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

- For Git: only commit when user explicitly asks (follow Git Safety Protocol in tools).

## Project Roots
- Backend: TypeScript/Express/Prisma + yt-dlp/ffmpeg
- Cache: `$CACHE_DIR` (videos as `{id}/{id}.mp3`, `{id}.json`, thumbnail)
- Harvest runs on cron + manual.

Update this file with new patterns after each task.
Last updated: 2026-10-07 (progress split into progress.json — index byte-stable during playback, ~430 B progress poll while playing)