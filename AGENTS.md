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
- For Git: only commit when user explicitly asks (follow Git Safety Protocol in tools).

## Project Roots
- Backend: TypeScript/Express/Prisma + yt-dlp/ffmpeg
- Cache: `$CACHE_DIR` (videos as `{id}/{id}.mp3`, `{id}.json`, thumbnail)
- Harvest runs on cron + manual.

Update this file with new patterns after each task.
Last updated: 2026-08-30 (added ARCHITECTURE.md pointer; docs audited)