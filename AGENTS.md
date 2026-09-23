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
- For Git: only commit when user explicitly asks (follow Git Safety Protocol in tools).

## Project Roots
- Backend: TypeScript/Express/Prisma + yt-dlp/ffmpeg
- Cache: `$CACHE_DIR` (videos as `{id}/{id}.mp3`, `{id}.json`, thumbnail)
- Harvest runs on cron + manual.

Update this file with new patterns after each task.
Last updated: 2026-09-21 (MP3 size/head integrity gate + post-publish sweep in `cleanupCorruptedFolders`)