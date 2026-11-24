# DrivePod — Technical Architecture & Specification

> Authoritative technical reference, verified against the source (2026-10-16)
> and against the live deployment (768 channels, ~309k video rows, 1,592
> index items, 1,624 cache folders, 1,002 GrabbyTube tracks).
>
> - `README.md` — human-facing overview (marketing + install).
> - `AGENTS.md` — agent conventions (build/deploy commands, workflow).
> - `INTELLIGENCE.md` — incident write-up: the datacenter-IP 403 diagnosis and the
>   combined-stream format fix (2026-08-24).
> - `ARCHITECTURE.md` (this file) — how the system actually works, end to end.

---

## 1. What DrivePod Is

A self-hosted, single-purpose podcast player. It continuously harvests new videos
from a prioritized list of YouTube channels, downloads them, transcodes them to
MP3 (optionally mono, 32–192 kbps), and serves them as a resumable,
data-throttled audio queue for a car/phone. It is built for intermittent
low-bandwidth connectivity (driving): everything about playback, state
persistence, and indexing is designed to survive network blackholes.

A second content source is **GrabbyTube** (sibling project,
`/home/user/projects/grabbytube`): a pre-existing MP3 catalog that DrivePod mixes
into the queue at a configurable duration ratio (the "shufflebag").

Two containers, one Docker image:

| Container            | Image                                  | Role                                                        |
|----------------------|----------------------------------------|-------------------------------------------------------------|
| `drivepod`           | built locally from `Dockerfile`        | nginx (SPA + media) + Express backend + yt-dlp/ffmpeg       |
| `drivepod-bgutil`    | `brainicism/bgutil-ytdlp-pot-provider` | PO-Token sidecar on `:4416` for yt-dlp (datacenter IPs)     |

Both join the external Docker network **`shared`** (also shared with
`grabbytube` + `grabbytube-bgutil`), so DrivePod reaches GrabbyTube at
`http://grabbytube:8101` by service name and yt-dlp reaches the sidecar at
`http://drivepod-bgutil:4416`.

The container is `privileged` with `NET_ADMIN`/`SYS_MODULE` and mounts
`/lib/modules:ro` because it brings up a **WireGuard client** (`wg0`) at
startup — the deployment is reached over a VPN tunnel, not a public port.

---

## 2. Repository Layout

```
drivepod/
├── Dockerfile                 # 2-stage: Angular build → node:20-bookworm-slim runtime
├── docker-compose.yml         # drivepod + drivepod-bgutil, external net `shared`
├── drivepod-ngnix             # nginx vhost (SPA + /api proxy + /cache + no-cache index)
├── entrypoint.sh              # sources .env, up WireGuard, prisma db push, node + nginx
├── wireguard/wg0.conf.template
├── deploy-frontend.sh         # bare-metal frontend deploy (ng build → /var/www/drivepod)
├── .env / .env.example        # deployment env (not committed; .env has real keys)
├── AGENTS.md / INTELLIGENCE.md / ARCHITECTURE.md / README.md
├── backend/
│   ├── src/server.ts          # ALL of the backend (3,701 lines, single file)
│   ├── prisma/schema.prisma   # 3 models: Channel, Video, Config
│   └── package.json           # express, prisma, rss-parser, node-cron, multer, ...
├── frontend/src/app/
│   ├── app.component.ts       # ALL of the UI logic (2,464 lines, one component)
│   ├── autoplay-order.ts      # pure queue-advance pick (see §12.3)
│   ├── stall-guard.ts         # pure playback-liveness + error-attribution decision (see §12.3)
│   ├── retry-policy.ts        # pure watched/progress outbox policy (see §12.5)
│   ├── app.routes.ts          # single route '' → AppComponent (no auth routes)
│   ├── app.component.html     # 842-line template, 6 tabs, Tailwind
│   └── root.component.ts      # <router-outlet />
├── cache/                     # mounted volume — see §8 (videos, index.json, rss/)
├── data/                      # mounted volume — database.db, cookies.txt (temp)
├── screenshots/               # README images
└── .hermes/plans/             # agent scratch, not app code
```

Key structural facts:

- **One backend file** (`server.ts`): all routes, the harvester, the index
  writer, the shufflebag, and the import logic live inline. No routers, no
  services, no middleware files.
- **One frontend component** (`AppComponent`): no lazy loading, no per-tab
  components; tabs are `@if (activeTab() === …)` blocks in a single template.
  **There is no login page, no auth guard, no HTTP interceptor** — the router
  has exactly one route (`''` → AppComponent, wildcard redirects to it).
- **Frontend app version constant**: `1.14.0` (`APP_VERSION` in app.component.ts —
  a console banner only; the bundle hashes are what bust caches).

---

## 3. Containers, Ports, Volumes, Networking

### 3.1 Port map (container)

| Port | What                                   |
|------|----------------------------------------|
| 80   | nginx — SPA, `/api/` proxy, `/cache/`  |
| 3000 | Express backend (loopback only; proxied by nginx) |
| 4416 | `drivepod-bgutil` PO-token provider (docker-net only) |

Host mapping: `${VPS_IP:-0.0.0.0}:${NGINX_PORT:-24320}:80` → live deployment
exposes **24320** on all interfaces (access actually arrives via WireGuard).

### 3.2 Volumes (live deployment)

Host sides are repo-relative so the repo carries no machine-specific paths;
container sides are the neutral constants that `.env` (`CACHE_DIR`, `DATA_DIR`,
`DATABASE_URL`) and `drivepod-ngnix` refer to.

| Host path (compose)  | Container path                   | Purpose                                    |
|----------------------|----------------------------------|--------------------------------------------|
| `./data`             | `/data` (`DATA_DIR`)             | SQLite DB + temp `cookies.txt`             |
| `./cache`            | `/cache` (`CACHE_DIR`)           | MP3s, thumbnails, index.json, rss/ cache   |
| `../ytcookies/data`  | `/shared-cookies` (RO in effect) | live YouTube cookie export (Netscape) + the vault's `session-state.json` (§5.3) |
| `/lib/modules`       | same (ro)                        | WireGuard kernel modules                   |

Stale absolute `audioPath` DB rows from an earlier host layout are repaired on
startup by the self-heal pass (§5) to the canonical `{CACHE_DIR}/{videoId}/`
layout, so a relocation needs no manual DB surgery.

The shared cache dir is **shared with GrabbyTube** — both projects write
per-video folders under `cache/`, and DrivePod's cleanup routines may only treat
a folder as its own when the sidecar proves it. The proof is GrabbyTube's
**authorship marker**: a non-empty `createdAt` in `{videoId}.json`. GrabbyTube
writes that key for every track it downloads and nothing else in that directory
emits it (DrivePod's two sidecar writers — harvest and import — omit it), so
`isGrabbyAuthored()` / `sidecarIsGrabbyAuthored()` are the single ownership test
used at *every* decision: the cleanup orphan rule, the bag seed, the distribute
candidate filter, the startup mislabel revert, and the T1 A14 audit. (Checking
for a bare `videoId` key is NOT ownership evidence: DrivePod's own sidecar
carries one too, which is exactly what catalogued 1,340 DrivePod folders as
music.)

### 3.3 Entrypoint order (`entrypoint.sh`)

1. Normalize `.env` (strip spaces around `=`) and `source` it.
2. If `WG_PRIVATE_KEY` + `WG_PEER_PUBLIC_KEY` + `WG_PEER_ENDPOINT` are set,
   render `wg0.conf` from the template and `wg-quick up wg0`.
3. `npx prisma db push --accept-data-loss` (schema sync on every boot).
4. `npm start` (runs `node dist/server.js`) in the background.
5. `nginx -g 'daemon off;'` as the foreground process.

### 3.4 Image build (`Dockerfile`)

Stage 1: `node:20-bookworm-slim` builds the Angular app
(`ng build --configuration=production`).

Stage 2 runtime installs (all required, several are easy to miss):

- `ca-certificates` — must be explicit; `--no-install-recommends` drops it.
- `python3 python3-pip python3-venv` — yt-dlp is a Python script.
- `ffmpeg vbrfix` — transcode + CBR normalization.
- `nginx` — serves SPA/media.
- `wireguard iproute2 procps iptables unzip` — tunnel + WSL2 Docker Desktop
  networking needs.
- `yt-dlp` — latest release binary from GitHub.
- `bgutil-ytdlp-pot-provider` — pip package (PO-token provider discovery).
- `Deno` — installed to `/usr/local/bin/deno`; required by
  `--remote-components ejs:github` (JS challenge solving).

Prisma client is regenerated (`npx prisma generate`) **before** the tsc build.

---

## 4. Data Model (Prisma + SQLite)

`backend/prisma/schema.prisma` — 3 models. SQLite file at
`data/database.db` (`DATABASE_URL=file:/…`).

### Channel

| Field            | Type            | Notes                                              |
|------------------|-----------------|----------------------------------------------------|
| `id`             | String (cuid)   | PK                                                 |
| `channelId`      | String @unique  | The YouTube `UC…` ID (harvest skips non-`UC…`)     |
| `title`          | String          | Display name (auto-fetched from RSS if absent)     |
| `order`          | Int (0)         | Harvest priority; UI ↑↑ ↑ ↓ ↓↓ rewrites it         |
| `ignoreScrapeDone` | Bool (false)  | One-time "ignore sweep" already ran for this channel |
| `active`         | Bool (true)     | Harvest toggle (🟢/⏸️ in Settings)                  |
| `minDuration`    | Int?            | Per-channel duration override (minutes), null=global |
| `maxDuration`    | Int?            | same                                                 |
| `createdAt`      | DateTime        |                                                    |

Indexes: `[order]`.

### Video

| Field         | Type        | Notes                                                   |
|---------------|-------------|---------------------------------------------------------|
| `id`          | String (cuid) | PK                                                    |
| `videoId`     | String @unique | YouTube ID (11 chars) or GrabbyTube track ID         |
| `channelId`   | String (FK→Channel.channelId) | grabby items point at a **per-artist placeholder**: `UCGrabbyTube` + base64url(author), whose `title` = the artist (bare `UCGrabbyTube` when no author) |
| `title`       | String      |                                                        |
| `description` | String?     | (set from metadata JSON if present)                    |
| `publishedAt` | DateTime    | **Grabby items carry a *clustered* timestamp** (uniform inside the 60-min band below the newest normal content, §9), not the real upload date |
| `thumbnailPath` | String?   | `/cache/<id>/<id>-small.webp`                          |
| `audioPath`   | String      | absolute path to `<id>.mp3`                            |
| `subtitlePath`| String?     | unused in practice                                     |
| `watched`     | Bool (false)|                                                        |
| `progress`    | Float (0)   | seconds, int-rounded by the frontend                   |
| `duration`    | Float?      | seconds (ffprobe)                                      |
| `ignored`     | Bool (false)| excluded from index.json and from harvest              |
| `protected`   | Bool (false)| exempt from auto-purge and purge-all                   |
| `isGrabby`    | Bool (false)| GrabbyTube-origin track; special-cased everywhere      |
| `createdAt`   | DateTime    | harvest-side; used by the X-per-Y-hours rate limit     |

Indexes: `[publishedAt]`, `[watched]`, `[ignored]`, `[channelId, ignored]`
(the last is what makes the per-channel "already in DB" check cheap at scale).

### Config

Key/value store (`key` unique, `value` String — everything is stored as a
string; parsed at the read site). See §10 for the full live key table.

### Scale (live, 2026-10-16)

- 975 channels; **310,027 video rows** — the large majority are
  `ignored: true` records created by the per-channel ignore sweeps (§7.4)
  and duration/pub-date filtering. Only **non-ignored** rows appear in
  `index.json` (1,502 items: 1,114 normal + 388 grabby).
- Census 2026-11-15, after the ownership fix (§9): 464 rows the bare-sweep index
  had flipped to `isGrabby` were reverted to normal videos at startup (their
  sidecars carry no `createdAt`), 389 genuine library tracks stayed grabby, and
  `grabby-index.json` went 2,057 → **717 entries** (GrabbyTube now indexes only
  what it authored). 690 of the 1,114 normal rows are watched again.
- 1,833 folders under `cache/` (DrivePod + GrabbyTube items + `rss/` +
  top-level JSON files).

---

## 5. Backend (`backend/src/server.ts`)

Single file, 3,701 lines, structured top-to-bottom: constants → helpers →
cleanup → shufflebag → discovery → download → harvest → API routes → startup.

### 5.1 Global state & concurrency

```
isHarvesting  — set during harvestAndPurge(); re-entry skipped. Taken as the FIRST
                act inside the try, so the `finally` that releases it is armed the
                moment it exists, and NOTHING in that `finally` may throw (see the
                bullets below). Readable as `harvestLockHeld()`.
isImporting   — set during POST /api/import; harvest skips while true. `importLockHeld()`
                is its mirror (exported only for the tests). POST /api/import 409s if
                isHarvesting; harvest skips if isImporting.
UseAlternateListGetterMethod — flipped every harvest run (see §7.2)
harvestStatus — plain object polled by GET /api/harvest-status
```

The harvest/import lock exists because an unlocked import's in-progress cache
folder would be treated as an orphan by `cleanupCorruptedFolders()` and deleted
mid-download.

**Why the release is armored** (fixed 2026-11-20): the harvest `finally` used to
begin with `deleteTempCookiesFile()`, whose `fs.unlinkSync` was unguarded. A throw
from a `finally` REPLACES whatever the try/catch was about to do — including the
later lines of that same block that set `isHarvesting = false` — and node-cron
swallows the rejection (`Task.execute` emits `task-failed`; nothing listens), so
the process stayed up and the flag stayed `true`: every later 5-minute harvest
logged `Harvest already running — skipping` forever and `POST /api/import` 409'd
for the same reason. A one-second EACCES/EBUSY/EROFS on the cookies mount (the
same class of mount this repo already documents corrupting files *after*
publication) therefore froze the queue permanently, with no log line pointing at
it. `deleteTempCookiesFile` now catches and warns, and `harvestAndPurge` takes the
lock as its first statement inside the `try`; T2 §20 drives a real round to that
dead end (`cookies.txt` replaced by a directory, so `unlinkSync` really throws) and
then proves the NEXT round runs.

### 5.2 Config access

`getConfig(key, default)` reads-or-seeds; `setConfig` upserts. All values are
strings. **Gotcha (documented in AGENTS skill): `POST /api/config` only persists
the fields it explicitly destructures** — an unknown field is silently dropped.
Adding a setting requires editing the GET handler, the POST destructuring, the
POST `setConfig` call, and the frontend.

### 5.3 Cookies

Two sources, one precedence (`effectiveCookiesFile()`):

1. `/shared-cookies/cookies.txt` — the live export from the **ytcookies**
   container (headless Chromium login + CDP cookie exporter, refreshed
   continuously). Preferred whenever present and non-empty.
2. `data/cookies.txt` — written from the DB `cookies` config (uploaded via
   `POST /api/cookies` or pasted via `POST /api/config`) for the duration of a
   harvest, then deleted in `finally`.

The DB `cookies` value is also what `getBaseYtDlpCommand()` reads, but the file
precedence above is what actually gets passed to yt-dlp.

**Liveness beside the jar — `COOKIE_SESSION_STATE`.** The vault publishes
`session-state.json` (`{state: "up"|"down", ts: <epoch s>, ua}`) next to the jar
it exports, and `readSessionState()` is the ONLY reader of it: the harvest gate
(`sessionGateOpen()`, §6 step 1) and the harvest tab's session badge (`GET
/api/harvest-status`) share it, so a badge can never disagree with what harvest
did. The path comes from `COOKIE_SESSION_STATE` and falls back to
`/shared-cookies/session-state.json` when unset — because that fallback is a
compose mount, a deployment that relocates the jar (a multi-tenant host gives
every partition its own jar + state file) MUST name the file, or both readers
ENOENT and report "unknown". A missing/torn/older-than-30-min file is NOT a
verdict: `fresh: false` means the badge says "session status unknown" and the
gate stays open. That is deliberate — a vault that stopped writing has stopped
running, and its last word must not hold harvest paused forever. Reading a
mount that does not exist is not a neutral default: the gate silently never
fired for 93 consecutive harvest rounds while the vault's own file said `up`.
T2 §19 locks both directions (unset ⇒ the mount is honoured, set ⇒ my file wins
over a disagreeing mount).

### 5.4 yt-dlp command construction

`getBaseYtDlpCommand()` (single source of truth for every yt-dlp invocation):

```
yt-dlp --no-progress
  --remote-components ejs:github                      # Deno-based JS challenge solving
  --extractor-args youtube:player_client=mweb          # mweb client (not `web`)
  --extractor-args youtubepot-bgutilhttp:base_url=http://drivepod-bgutil:4416
  --min-sleep-interval 5 --max-sleep-interval 15
  --user-agent "<config userAgent>"
  [--cookies "<effective file>"]
```

Download adds:

```
  -f "b[acodec!=none][height<=360]/b[acodec!=none]/ba/b"   # COMBINED stream (see below)
  --write-thumbnail --no-overwrites --continue
  --match-filter "live_status != is_live & live_status != is_upcoming"
  --output "<cacheDir>/<id>/%(id)s.%(ext)s"
```

**Why combined streams**: from datacenter egress, Google 403s audio-only and
video-only signed URLs but serves combined video+audio (≤360p mp4) fine.
`bestaudio` 403'd on every download. The small mp4 is downloaded and audio is
extracted by ffmpeg. Full diagnosis in `INTELLIGENCE.md`. Watch item: if
combined streams ever start 403'ing, a residential proxy is the fix
(`--proxy` in `getBaseYtDlpCommand()`).

### 5.5 Download & transcode pipeline (`downloadAndProcessVideo`)

For one video, into `cache/<videoId>/`:

1. Skip if `<id>.mp3` already exists.
2. yt-dlp download (combined format above) + `--write-thumbnail`.
3. Accept `.webm`, else `.m4a`, else `.mp4` as the raw source.
4. Thumbnail: original → ffmpeg `scale=400:225` (aspect preserved) →
   `<id>-small.webp` (fallback to original on failure).
5. Build a `.ffmeta` sidecar: `title`, `artist` (channel), `date`, and
   `comment` = full video info JSON.
6. ffmpeg → MP3: `libmp3lame`, `-ar 24000`, `-b:a <bitrate>k`,
   `-id3v2_version 3`, embedded cover art (`mjpeg`, `attached_pic`),
   `-ac 1` when mono.
7. `vbrfix -always` → CBR (seekable, player-friendly).
8. `validateMp3File()` — post-transcode integrity gate: zero-run scan
   (any run >256KB of consecutive 0x00 = a hole), head check (ID3 tag or
   frame sync at byte 0), Xing/Info header presence (ffprobe's
   "Estimating duration from bitrate" warning means it's missing), a
   duration check vs the YouTube-reported value (10%, min 30s tolerance)
   when the caller supplied one, and a size/header check: file size must
   equal the Xing "bytes" field + tag size (vbrfix's count is exact —
   `readMp3HeaderClaim()`). A failure re-transcodes once (raw still on
   disk), then discards the file and returns false — the track is never
   published. Why: the cache dir is a 9p-mounted Windows folder; silent
   I/O failures there have produced zero-padded files that ffprobe still
   measures (duration estimated from file size) but no player can demux
   (Chrome: MEDIA_ERR_SRC_NOT_SUPPORTED). On 2026-09-20 the 9p Windows
   I/O path additionally corrupted finished files **post-publication**
   (one track's head spliced ahead of another track's tail; a 1.8MB
   leading zero-hole) — 11 files in one concurrent-write burst; no sync
   software is involved (operator-verified: OneDrive uninstalled, no
   reparse points), so the suspected actor is the 9p/drvfs layer itself.
   Every pre-publish check had already passed — so
   `cleanupCorruptedFolders()` re-checks head + size claim on every
   published file each harvest and quarantines failures (§6, step 2).
9. Delete the raw container file.

Failure classification:

- cookie-invalid messages → **auto-clears the DB `cookies` config**
  (`setConfig('cookies','')`);
- live / premiere / age-gate errors → logged and skipped (return false);
- validation failure after the re-transcode → file deleted, return false;
- any failure with no mp3 → folder removed + index regenerated.

`getAudioDuration()` (ffprobe) measures the final MP3 for the DB row.

### 5.6 Index file (`cache/index.json`) — the contract

`updateIndexFile()` is the single writer of the file the SPA consumes. Called
after every DB/mutation that affects the queue: batch inserts, watched/
progress updates, protect toggles, ignores, purges, channel deletes, grabby
distribution, corruption cleanup.

Behavior:

- Rows: `ignored: false` only, **`orderBy: publishedAt desc, videoId asc`** —
  the `videoId` tiebreaker makes order deterministic for shared timestamps
  (batched imports, grabby clusters); without it the playlist reshuffled
  between refreshes.
- Per row: DB record merged with `cache/<id>/<id>.json` (per-item metadata
  wins) **except `publishedAt`, which is always pinned to the DB value** —
  a diverged per-item JSON (e.g. a re-import that wrote a fresh date into
  the file) must never reorder the queue; the DB is the single source of
  truth. This also covers grabby items, whose file carries the original
  YouTube date in `YYYYMMDD` format.
- Paths are rewritten with the `/cache/` prefix (nginx serves `/cache/` →
  CACHE_DIR). `audioPath` is always `/cache/<id>/<id>.mp3`.
- **Self-heal**: grabby rows whose file resolves to nothing
  (`resolveGrabbyAudioPath()` finds neither the literal nor the canonical
  mp3) are deleted from the DB here (they may have been consumed from the
  GrabbyTube UI).
- Atomic write: `index.tmp.json` → rename.

Nginx serves the queue files via a regex location
`~ ^/cache/(index|progress)\.json$`: `Cache-Control: no-cache` + `etag on`
(no max-age — a changed file is always re-downloaded, an unchanged one is a
~0 B 304). The SPA fetches stable URLs with `cache: 'no-cache'`; never
reintroduce a `?_t=` buster or `no-store`. MP3s and thumbnails remain
cacheable (`immutable`).

`progress.json` is split out of the index: `index.json` carries
`progress: 0` for every item (byte-stable while a track plays) and
`progress.json` holds only in-queue items with `0 < progress < duration`
as `[{videoId, progress}]` (~1.5 KB raw — the only file that churns on the
~10 s progress saves). `writeIfChanged()` skips byte-identical rewrites —
a no-op rewrite would bump the ETag and force a full re-download on every
2-minute poll.

The SPA shell gets `Cache-Control: no-cache` (revalidate via ETag) and the
content-hashed assets (`main-*.js`, `styles-*.css`) get
`public, max-age=31536000, immutable`. Without explicit headers, Chromium
heuristic-caches the header-less `index.html` and kept serving an 8-day-old
deploy's bundle indefinitely (2026-09-20: stale bundle still contained the
unbounded error-reload loop after the fixed build was live on the server).

### 5.7 Startup sequence (bottom of file)

1. `revertForeignGrabbyRows()` (§9) — **first**, because it decides which rows
   are music at all: it returns every `isGrabby` row whose own sidecar lacks
   GrabbyTube's `createdAt` to the normal queue, restoring the `publishedAt` and
   `channelId` the sidecar records (and recreating a sidecar channel that was
   deleted, INACTIVE so it is never silently re-harvested). watched / progress /
   ignored / protected are never touched. Rows with no sidecar, an unreadable
   one, or an authored one stay grabby: without evidence the mix label is the
   safer assumption.
2. `initShuffleBag()` → `backfillGrabbyArtistChannels()`, chained after the
   revert so neither runs against rows step 1 is about to return.
3. `cron.schedule('*/5 * * * *', harvestAndPurge)` **and** one immediate
   `harvestAndPurge()`.
4. `app.listen(3000)`.

---

## 6. Harvest Pipeline (`harvestAndPurge`)

Runs every 5 minutes and once at boot. Full sequence:

1. **Re-entry guards** (`isHarvesting` / `isImporting`), then the **cookie-session
   gate** (`sessionGateOpen()`, §5.3): a vault verdict of `down` written inside
   the last 30 min ends the round here — BEFORE `isHarvesting` is set and before
   any cleanup or download — so a dead session is never burned on cookieless
   yt-dlp runs (those also refresh the jar's mtime, delaying the vault's re-seed
   after a re-sign-in). Throttled log: `⏸️ Cookie session dead … skipping harvest
   round`. Then `harvestStatus` is reset.

   Neither guard has an early return after the lock exists: `isHarvesting = true`
   is the first statement inside the `try`, so the `finally` that clears it is
   already armed the moment the lock is held, and every step of that `finally` is
   non-throwing (§5.1). Before 2026-11-20 the lock was set several lines *before*
   the `try` and the `finally` opened with an unguarded `unlinkSync` — a throw
   there froze the harvest for the life of the process.
2. **`cleanupCorruptedFolders()`** (full consistency pass):
   - Folder with **no** DB record: if its `{id}.json` is GrabbyTube-authored
     (`createdAt`, §3.2) it's a library track → skip (`🎵 GrabbyTube item
     (skipping)`); otherwise delete as orphan. Keying on the marker instead of
     "has a `videoId` key" is what reclaims DrivePod's own leftover folders
     (11 folders / 1.1 GB on 2026-11-15) without ever touching music.
   - Folder **with** record but corrupt, as decided by the exported pure
     `folderCorruptionReason(videoId, files)` — **our own files counted by EXACT
     NAME, never by extension**: no `<id>.mp3` → corrupt; no `<id>.json` → corrupt;
     more than 2 image files → corrupt. A name match can only happen once in a
     directory, so "multiple audio/sidecar" is unrepresentable now, and a foreign
     name is not ours to count. Everything else in the folder is TOLERATED —
     FrogRock's `<id>.mp3.tr64k.mp3` radio transcode, GrabbyTube's `<id>.mp3.bak`,
     yt-dlp's `.part`/`.ytdl`, `.vbrfix.tmp`, `.ffmeta`, the raw `.webm`/`.m4a`, a
     `.json` under a foreign name (2026-11-17: counting `.mp3` SUFFIXES flagged 187
     healthy grabby folders as "Multiple .mp3 files" and deleted their DB rows —
     watched/progress state went with the row and the bag re-queued them as fresh;
     the "watched items come back" symptom). Grabby → delete **DB row only, keep
     files**; normal → delete folder + row.
   - Orphan DB rows (`ignored:false, isGrabby:false`) with missing folder/mp3
     → delete row. (Grabby rows are never deleted here; the index self-heal
     owns that path.)
   - Structurally valid folder whose MP3 fails an integrity check (junk at
     file start — zero-hole or merge artifact; or size vs Xing "bytes"
     claim off by more than max(4KB, 0.5%)) → delete folder + row
     (post-publication corruption via the 9p Windows I/O path; grabby folders exempt).
   - **Stale `audioPath` self-heal**: a row whose stored `audioPath` points
     at a missing file is re-pointed at the canonical `{id}/{id}.mp3` when
     that file exists; logs `🔧 Repaired stale audioPath on N row(s)`.
     (2026-10-16: repaired 224 rows — the stale absolute paths made
     `/api/stream` 404 and the player skipped the tracks as defunct.)
3. **`backfillChannelOrders()`** — assign sequential `order` to any channel
   stuck at 0 (legacy data).
4. Delete temp cookies file, write effective cookies (shared export needs no
   temp file).
5. **Flip `UseAlternateListGetterMethod`** (alternates RSS-first vs
   yt-dlp-first each run — see §7.2).
6. Read config: `maxHarvestDays` (default 7), `preferredBitrate` (128),
   `preferredMono`, `autoPurgeDays` (30), rate limit (`limitEnabled`/
   `limitVideos`/`limitHours`, default off / 2 per 6 h), global duration
   filter (default off, 0–720 min).
7. Load **active** channels ordered by `order`; **drop any whose `channelId`
   doesn't start with `UC`** (legacy bad IDs were URLs — they'd 404 every
   harvest).
8. Process channels with **`MAX_CONCURRENT_CHANNELS = 2`** in a
   promise-pool loop. Per channel:
   - **Rate limit (channel-level)**: if `limitEnabled` and the channel
     already has ≥ `limitVideos` non-ignored videos with `createdAt` in the
     last `limitHours`, skip the whole channel.
   - **Ignore sweep** (once per channel, `ignoreScrapeDone=false`): scrape the
     full catalog (2-year window, `--playlist-items` unbounded, `approximate_date`)
     and insert every existing video as `ignored: true` so only *new* uploads
     are ever downloaded. Sets `ignoreScrapeDone=true`.
   - **Discovery** (`getRssFeedWithCache`): get candidate items + channel title.
   - Dedupe against DB (`videoId IN (…)`, one query).
   - Per candidate (skipping existing):
     - channel-level rate limit re-check (stops mid-list);
     - pub-date filter: older than `maxHarvestDays` → `ignoreVideo()`;
     - duration filter (per-channel override, else global if enabled) →
       `ignoreVideo()`;
     - `fillMissingMetadata()` — yt-dlp one-liner for
       `timestamp|duration_string|live_status` (120 s timeout, §7.3) when
       RSS lacked them; members-only → `ignoreVideo()`; `VODFuture`
       (live/upcoming) → skip this cycle and retry next (not recorded — a
       scheduled stream becomes downloadable once its VOD is processed);
       `post_live` is NOT skipped — it falls through to the download attempt
       (ended streams are often still flagged `post_live` after the VOD is
       already served);
     - re-check filters (metadata may have changed duration/date), passing
       the resolved `duration` into `ignoreVideo()` (ignored rows were
       previously stored with NULL duration — now the ignore reason is
       auditable in the DB);
     - **`downloadAndProcessVideo()`**;
     - on success: pick thumbnail, ffprobe duration, write
       `cache/<id>/<id>.json` (rich metadata), stage for batch insert.
   - Batch `prisma.video.createMany` + `updateIndexFile()`.
9. **`distributeGrabbyItems()`** (only when `grabbyMixEnabled`, §9).
10. **Auto-purge**: non-ignored, non-protected, **non-grabby** videos with
    `publishedAt` older than `autoPurgeDays` → delete folder + row; clear
    `currentVideoId` if it was purged.

Note the live deployment runs a tight profile (`maxHarvestDays=3`,
`autoPurgeDays=30`, `limitEnabled=true 2 per 6h`, duration 15–720 min,
64 kbps mono, grabby mix on at ratio 3) — see §10 for the full live values.

---

## 7. Video Discovery Details

### 7.1 RSS

`https://www.youtube.com/feeds/videos.xml?channel_id=UC…` fetched with a
Chrome UA, 15 s timeout. Raw XML is cached to `cache/rss/<channelId>.xml`
(used as fallback when live fetch fails, and for title resolution). YouTube
RSS contains only the ~15 most recent uploads — the reason for the
alternative method.

### 7.2 The "alternative" method (yt-dlp tab scrape)

`getLatestVideosAlternative()` scrapes the channel's **videos / streams /
shorts** tabs (each toggleable in Settings) via:

```
yt-dlp <base> [--playlist-items 1-10] --break-on-reject
  --extractor-args "youtubetab:approximate_date"
  --dump-json --flat-playlist --dateafter <YYYYMMDD maxDays ago>
  --ignore-errors https://www.youtube.com/channel/UC…/<tab>
```

(`--playlist-items 1-10` caps the harvest scrape; the ignore sweep omits it to
walk the whole 2-year window.) Results are flat-playlist JSON lines →
`{videoId,title,duration,link}`; de-duped and filtered against the channel's
known video IDs.

`getRssFeedWithCache()` flow, per run: the `UseAlternateListGetterMethod` flag
is flipped every harvest, so **alternate runs alternate between**
"live RSS first, alt fallback" and "alt first, RSS fallback, then cached XML".
This hedges against either source rate-limiting the other.

### 7.3 Metadata filling

`fillMissingMetadata()` runs
`yt-dlp --print '%(timestamp)s|%(duration_string)s|%(live_status)s'` for
items missing pubDate/duration/liveStatus, with a **120 s timeout**
(`safeExec`'s optional third arg kills a hung yt-dlp — one hung discovery
call must not stall the whole harvest). Pub-date parsing applies the
**today-midnight rule**: yt-dlp timestamps that land exactly on local
midnight are treated as "now" (avoids off-by-a-day for fresh uploads).

Outcomes — the skip paths log `⏭️ [videoId] …` instead of continuing
silently (an unauditable "miss"):

- empty `%(timestamp)s` → `res: false` →
  "Incomplete metadata — will retry next cycle";
- `live_status` ∈ `is_live` / `is_upcoming` → **`VODFuture`** →
  "not downloadable yet, will retry next cycle" (genuinely not downloadable
  — a scheduled stream becomes downloadable once its VOD is processed, at
  which point yt-dlp reports `was_live` → `VODNow` and the download proceeds);
- `live_status` = `post_live` → **not blocked** — YouTube frequently leaves an
  ended stream flagged `post_live` long after its VOD is already served (stale
  state), so it falls through to `downloadAndProcessVideo()`, which is the real
  availability check: if the VOD is ready it downloads, if not the yt-dlp call
  fails cleanly (no row written) and the item is retried next cycle;
- success logs nothing by design.

### 7.4 Ignore semantics

`ignoreVideo()` = the tombstone mechanism: mark-or-create the row with
`ignored: true`, delete any cache folder, regenerate the index. Ignored rows
never enter `index.json`, never re-download (harvest dedupes on `videoId`
before checking ignored), and are the reason the table holds 300k+ rows.

---

## 8. Cache Directory Layout (`cache/`)

```
cache/
├── index.json                  # THE queue (non-ignored rows, merged w/ per-item JSON)
├── grabby-index.json           # written by GRABBYTUBE — only tracks it authored
├── shufflebag.json             # shufflebag state (this app)
├── rss/<channelId>.xml         # RSS fallback cache
└── <videoId>/                  # one folder per item (DrivePod OR GrabbyTube)
    ├── <videoId>.mp3           # final audio — THE audio, identified by exact name
    ├── <videoId>.mp3.tr64k.mp3 # FrogRock's 64k mono radio transcode (cache, not audio)
    ├── <videoId>.mp3.bak       # GrabbyTube's backup of a replaced file
    ├── <videoId>-small.webp    # 400×225 thumbnail (DrivePod)
    ├── <videoId>.jpg|webp      # original thumbnail (may be removed post-transcode? kept)
    └── <videoId>.json          # sidecar: DrivePod writes videoInfo; GrabbyTube its
                                # own shape PLUS `createdAt` — the ownership marker
```

Corruption definition (per §6-2): exactly one `<id>.mp3`, exactly one `<id>.json`,
≤2 image files — by EXACT name, so transcode/backup/`.part` sidecars neither count
as audio nor make a folder "corrupt". A folder is also corrupt when it is empty,
and its audio can still be rejected later by the MP3 integrity check (same §6-2).

---

## 9. GrabbyTube Integration ("ShuffleBag")

**Purpose**: mix a pre-downloaded MP3 music catalog into the podcast queue at
a duration ratio, so the player is never silent.

**State**:
- `grabby-index.json` — written by GrabbyTube (single writer):
  `{videoId, channelId, title, author, publishedAt: "YYYYMMDD", thumbnailPath, audioPath, duration, createdAt}`.
  Only tracks GrabbyTube **authored** are listed (it rebuilds from the
  authorship marker on its sidecar, §3.2) — DrivePod's videos share the cache
  dir and are not music.
- `shufflebag.json` — this app's FIFO state: `[{videoId, used}]`. Entries the user
  WATCHED are held out of it entirely (see the Init / Reconcile bullets below):
  `initShuffleBag` set-asides any watched grabby row, a watched row pulled mid-run
  is pruned rather than reconditioned, and the
  `/api/video/:id/watched` hooks (`syncBagForWatched`) add or drop entries directly.
  **Read through `readShuffleBag()` and written through `writeShuffleBag()`, never
  bare `JSON.parse(readFileSync(...))` / `writeFileSync`** — see the torn-bytes rule
  below.

**Torn bytes are not a verdict** (fixed 2026-11-23). `readJsonFile` returns a
tri-state — `missing` | `unreadable` | `ok` — and the two failure kinds get
**opposite answers**, because "there is no file" is a fact to act on while "the
bytes are wrong" says nothing about the catalog:

| read | meaning | what a caller may do |
|---|---|---|
| `missing` | the file does not exist | seed it (the bag is derived from the index) |
| `unreadable` | bytes present, unparseable / not an array | **change nothing on disk** |
| `ok` | parsed | normal handling (malformed *entries* still tolerated: a missing `used` reads unused) |

Before this, every consumer sat INSIDE the `JSON.parse` throw, so one truncated
`shufflebag.json` (kill between truncate and close — the in-place
`writeFileSync` did exactly that — or this cache mount's documented
post-publication corruption) 500'd `PATCH /api/video/:id/watched` *after* the row
was already marked (so the outbox retried into the same 500 forever), aborted the
harvest's distribution, and threw inside `pullFromShuffleBag` BEFORE its
exhaustion re-init, i.e. nothing could ever heal it short of a container restart.
A torn `grabby-index.json` was worse: `initShuffleBag` answered it by writing `[]`
— wiping the rotation plus every `used` mark on bytes nobody could read — and
`syncBagForWatched`'s un-watch re-add pruned the bag to ONE entry, because its
`isGrabbyAuthored` throw landed *after* it had emptied the array in memory.
`loadGrabbyIndex()` now returns `null` (= catalog UNKNOWN) on unreadable bytes, and
the bag is only ever replaced by a bounded rebuild-from-the-catalog.
`writeShuffleBag` writes sibling temp + rename and skips byte-identical rewrites,
the same discipline `index.json`/`progress.json` already used, which removes the
truncation these readers exist to survive. T2 §21 is the gate.

- **`resolveGrabbyAudioPath(videoId, audioPath)`** — the single resolver
  for grabby file paths: returns the literal path (absolute as-is, relative
  joined to CACHE_DIR) when the file exists, else the canonical
  `cache/<videoId>/<videoId>.mp3` when that exists, else the literal. Used
  by init, distribute (pull + recondition) and the pre-insert recheck.
  `grabby-index.json` is **never rewritten** by DrivePod — GrabbyTube owns
  it, and its `audioPath` values go stale when its cache moves; we resolve
  at read time.
- **Per-artist placeholder channels** `UCGrabbyTube<base64url(author)>`
  (title = the artist, inactive, `order 999999`). The SPA / car head unit
  render `channel.title` as the artist (media-session metadata, queue rows,
  page title), so grabby tracks show their real artist with **no MP3
  re-tagging or re-encoding**. Bare `UCGrabbyTube` is the fallback for items
  without an author. `DELETE` of any `UCGrabbyTube*` → 403, and the Settings
  tab hides all `UCGrabbyTube*` channels (frontend filter in `loadChannels`).

**Lifecycle**:

- **Init** (boot): upsert the placeholder channel; load grabby-index keeping
  only **authored** entries (`isGrabbyAuthored`, §3.2 — a bare-`videoId` index
  entry is not a music track), drop defunct items
  (`resolveGrabbyAudioPath()` finds no file) **and any row the DB marks watched**
  (`isGrabby:true, watched:true` → `played-and-set-aside`; an unwatched row — and
  a watched row that is NOT grabby — still seeds), Fisher–Yates shuffle, persist.
  In parallel, `backfillGrabbyArtistChannels()` re-points any grabby row still
  on a stale channel (e.g. pre-migration rows on bare `UCGrabbyTube`) to its
  per-artist channel using the index's `author`, and regenerates
  `index.json` if anything moved. Idempotent.
- **Pull** (`pullFromShuffleBag(n)`): take n `used:false` entries in bag order
  (shuffled order = pseudo-random draw), mark used, persist. On exhaustion,
  reinitialize **once** (reusing items is allowed — grabby tracks re-enter the
  mix; see below — but a row the DB marks **watched** is set aside again, so
  finished tracks never re-enter; see the Init bullet).
- **Reconcile** (`reconcileShuffleBag(returnIds, indexIds, pruneIds)`), once per run:
  - candidates the plan did NOT place are un-used and moved to the **tail** of
    the bag. A head-insert would starve the bag (an item too long for the
    current deficit would be pulled and returned every 5 min, blocking every
    shorter item behind it); marking them used — the old behavior — burns them
    out of the rotation for a whole bag cycle, because `used` only resets on
    re-initialization (1,985 entries).
  - entries grabby-index.json no longer lists are **pruned**, `used` or not: a
    `used` one is never pulled again, so without this it stays in the file
    forever (the T1 A9 "stale bag entry" failure mode). Two guards: an empty
    index set (missing/unreadable index) prunes nothing, and a **mass absence**
    (> 10 % of the bag — smells like a partial index rewrite, not real
    deletions) is logged but not pruned, since a pruned entry only rejoins
    after a full ~23 h pass.
  - the third argument `pruneIds` (ids this run's `rowStates` query proved
    **watched**) leaves the bag **unconditionally** — `used` or not — and
    **bypasses the mass-absence guard**: unlike index absence these were checked
    against the DB this run, so there is no transient-read risk, and a played
    track that merely rotated back would be re-pulled on every run until the next
    re-init. Played wins over returned: an id both skipped and proved watched is
    pruned, not rotated to the tail.
- **Distribute** (after harvest, before auto-purge; skipped when
  `grabbyMixEnabled=false` — **it is currently ON in the live deployment**,
  ratio 1, cluster cap 7):
  1. **Repair stranded rows FIRST**: any unwatched, unignored grabby row
     timestamped **above** the anchor is re-clustered into the band
     (`clusterTimestamp`). Those timestamps were invented by us, so moving them
     is safe — and the tally must run after it, or the repaired file is invisible
     to both the ratio and the cluster cap (it would be double-counted by the
     next run's placement). Logs `🔧 Re-clustered N grabby item(s) …`.
  2. **Measure the band**: the 60 minutes of queue content ENDING at the newest
     **normal** video (`ignored:false, watched:false` — the queue excludes
     watched rows, and only grabby depends on this function for replenishment).
     Normal and grabby are tallied over that **one** window, counting both
     `count` and `durationSec`.
  3. **Target** (`grabbyTargets`): duration parity `normalDur/ratio` AND count
     parity `normalCount/ratio`, each floored for quiet hours by
     `max(…, 5 min if ratio ≤ 5 else 15 min)` applied to the **TARGET** — a
     band that already meets its target is left alone, so the 5-min cron cannot
     top it up over and over (the old per-run floor of `max(deficit, …)`
     re-injected 36–180× the target per hour).
  4. **Pull candidates**: `max(count deficit, ceil(budget / longest catalog
     track)) + 5` (the +5 absorbs unusable entries). If
     `grabbyClusterMaxSize > 0`, items already in the band count against the cap
     **across runs**, so a run pulls only the remaining headroom and stops once
     the band is full. A pull whose DB row is already **watched** is not a
     candidate at all (`⏭️ Skipping played item …`): it is collected as a played id
     and handed to reconcile's `pruneIds`, so it leaves the rotation instead of
     cycling back (see the Reconcile bullet above).
  5. **Plan** (`planGrabbyFill`, pure + exported, deterministic — a run is
     reproducible from its log line): which candidates to place, converging on
     **both** targets at once. Hard: the slot cap, and the duration budget
     (overrun by at most `GRABBY_OVERSHOOT_RATIO = 15 %`, and only on the final
     item or to fill an empty cluster). Soft: the count target, widened toward
     the fewest items that can still reach the budget, or narrowed to the most
     that can fit it. Selection is best-fit-to-the-remaining-share per slot
     (`ideal = (budget − placed) / slotsLeft`), candidates sorted ascending by
     duration with a `videoId` tie-break.
     - **Why both targets**: duration parity alone is what made a cluster look
       complete while the user saw one or two items — a single 80-minute
       archive file satisfies a 45-minute budget outright, and the old loop
       stopped the instant the duration was covered. Count parity is what forces
       the same budget across several tracks.
  6. Place the plan's picks (re-verifying each file via
     `resolveGrabbyAudioPath()`). **Ownership guard at two points**: a candidate
     whose DB row exists with `isGrabby: false` is refused (`⛔ … Refusing to
     convert DrivePod's own video …`) — once when candidates are filtered, so the
     planner never spends a slot on it and the bag entry rotates back un-used,
     and again here, because a concurrent import can insert that row in between.
     Converting such a row is precisely what flipped 464 watched videos into
     permanent mix items (§5.7-1). The **watched check is re-run at placement**
     too: the user may have marked the row watched mid-run, after the candidate
     filter saw it unwatched; such a pick is dropped and goes to `pruneIds`.
     - **already in DB → "recondition"** (reached only by UNWATCHED rows — a
       watched pick `continue`s above): update row with clustered
       `publishedAt` (`clusterTimestamp` = uniform inside the band, i.e. **at or
       below** the newest normal video), fresh title/thumb/duration,
       `watched:false, progress:0`, the resolved `audioPath` (literal index path
       if its file exists, else canonical), and re-point to the per-artist
       channel if `author` changed — the track cycles back into the mix window;
     - **not in DB → insert** with `isGrabby:true, protected:false`,
       `channelId` = the per-artist placeholder channel derived from the
       index `author` (bare `UCGrabbyTube` when absent).
  7. Final pre-insert recheck for files deleted mid-harvest (a concurrent
     grabby delete), then `createMany` + `updateIndexFile()`.

**The band window is the load-bearing invariant** (`GRABBY_BAND_LOOKBACK_MS`):
measuring grabby up to `+30 min` **above** the anchor (the jitter ceiling the old
code used, while normal was measured only up to the anchor) inflated grabby,
because no normal video can exist above the anchor by definition. Live example
captured 2026-11-12: band anchored at 07:37 with 1 normal item (2594 s) — the
old windows read normal 2594 s vs grabby **4832 s** → "ratio satisfied", while
that one 80-minute file sat at the very **top** of the queue, above all the
newest normal content, and nothing was placed. The same band measured
symmetrically reads grabby **0 s** → a 2594 s deficit → one best-fit track
placed inside the band.

**Authorship is the other load-bearing invariant**: the cache dir is shared, so
"the file is in `cache/`" and "the index lists this videoId" are both **not**
evidence that the item is music. Only the sidecar `createdAt` marker (§3.2) is,
and every layer consults it — GrabbyTube's index rebuild, DrivePod's bag seed
(`initShuffleBag` → `loadGrabbyIndex`), the cleanup orphan rule (§6-2), the
distribute candidate filter, and the T1 A14 audit. When the marker was missing
from every layer at once, the bare sweep indexed 2,057 "tracks" of which 1,340
were DrivePod videos, and 464 of those had already been converted.

**Guard rails** (the `isGrabby` safety rule):

- Ownership of a shared-cache item is decided by the **authorship marker**, never
  by folder location or by the index listing (§9 invariant above).
- `distributeGrabbyItems` refuses to convert a `isGrabby:false` row (candidate
  filter **and** placement), so a harvested video can never be flipped by a stale
  index entry.
- Auto-purge and purge-all filter `isGrabby:false`.
- Channel delete skips grabby rows.
- `cleanupCorruptedFolders` preserves grabby **files** (deletes DB row only).
- `updateIndexFile` self-heals grabby rows whose mp3 vanished.
- Every `deleteMany` on non-grabby videos carries `isGrabby:false` — audit
  any new delete path for this.

**Consume-and-delete** (`DELETE /api/video/:videoId/grabby`):

Library-track-ness is decided by `sidecarIsGrabbyAuthored`, NOT by the DB row
alone: `video && !video.isGrabby` → 400 (DrivePod's own video); no row AND no
sidecar marker → 404; marker present (row or not) → the consume lands. A missing
row is NOT "unknown track" — it is also the state left behind by the corruption
cleanup (§6-2), `updateIndexFile`'s defunct-MP3 filter, a delete made in the
GrabbyTube UI, or a second tab, while the caller's `index.json` — regenerated
only on a harvest — still lists the track. A hard 404 there made the Delete key
alert "Video not found" and change nothing, forever, on an id that would never
come back (2026-11-17).
- **Remote first, fail-closed**: `DELETE http://grabbytube:8101/tracks/<id>`
  with `X-Grabby-Token` (shared secret `GRABBY_API_TOKEN` in both projects'
  env). Remote 200/404 → proceed; anything else → 502 and **nothing local is
  touched** (GrabbyTube is the single writer of its catalog/index/files).
- Local: delete the DB row (`isGrabby:true` scope — 0 rows is fine and normal,
  `localRecords: 0`), prune the shufflebag entry, regenerate the index (the
  defunct-grabby filter drops the listing even if the row was already gone).
- **No harvest/import concurrency lock** on purpose (user decision); the
  delete-during-harvest race is neutralized by the index self-heal + the
  pre-insert recheck.
- Frontend: 🗑️ button in the now-playing bar (grabby tracks only) and the
  **Delete** hotkey, both calling `consumeGrabbyTrack()` with no confirmation. The
  success handler (and the 404 handler) runs `consumedGrabbyTrack()`: drop the item
  from `rawIndex`, and when **this tab was playing it**, `stopAndAdvance(left,
  autoplayMode())` — the same stop → clear → `pickNextTrack` step the manual ⏭️
  uses. It used to call `markAsWatchedAndPlayNext()` AFTER `removeLocalVideo()`,
  and that function returns on its first line when `currentVideo` is null, so
  Delete on the playing track marked nothing, advanced nothing and left a blank
  player with the deleted file still audible (2026-11-17, second symptom). No
  watched POST: the row is gone — that IS the consume — so posting would only
  retry a 404. A tab that was NOT playing this id just drops the row from its own
  list (the tab that owns playback keeps playing it).

**Recovery if grabby rows get wiped**: delete `cache/shufflebag.json` (fresh
reinit next harvest); grabby-index.json and the MP3s are untouched.

---

## 10. Configuration Reference

### 10.1 DB-backed config (Settings tab → `POST /api/config`)

| Key | Default | Live value (2026-10-16) | Meaning |
|---|---|---|---|
| `maxHarvestDays` | 7 | **3** | discovery window (pub-date filter also uses this) |
| `preferredBitrate` | 128 | **64** | MP3 kbps (UI: 32/48/64/96/128/160/192) |
| `preferredMono` | false | **true** | `-ac 1` in transcode |
| `autoPurgeDays` | 30 | 30 | auto-purge age cutoff |
| `userAgent` | Chrome/134 Win | Chrome/153 X11 | yt-dlp `--user-agent` |
| `cookies` | '' | '' | uploaded/pasted cookies (shared export overrides) |
| `limitEnabled` | false | **true** | per-channel X-per-Y-hours limit |
| `limitVideos` | 2 | 2 | X |
| `limitHours` | 6 | 6 | Y |
| `alternativeMetadataEnabled` | true | true | enable the yt-dlp tab scrape method |
| `scrapeVideosTab` | true | true | videos tab |
| `scrapeStreamsTab` | true | true | streams tab |
| `scrapeShortsTab` | true | false | shorts tab |
| `durationFilterEnabled` | false | **true** | global min/max filter |
| `minDurationMinutes` | 0 | **15** | global min |
| `maxDurationMinutes` | 720 | 720 | global max |
| `grabbyMixEnabled` | true | true | shufflebag on/off |
| `grabbyMixRatio` | 3 | **1** | normal:grabby ratio — drives BOTH parity targets (duration AND item count) in the band (§9) |
| `grabbyClusterMaxSize` | 0 | **7** | hard cap on grabby items in the 60-min band, counted across runs (0 = unlimited) |
| `currentVideoId` | '' | w2drTBjfUk0 | last played video (resume target) |

Per-channel overrides live on the Channel row (`minDuration`/`maxDuration`,
both null = global; **any override present enables the filter for that
channel even when the global toggle is off**).

**Dead keys** (still in the live DB, read by no code — leftovers from
superseded versions): `alternativeMetadataFetchEnabled`,
`consumedGrabbyIds`, `consumedGrabbySeed`, `onePerHours`, `scrapeTabTypes`.

### 10.2 Client-side settings (localStorage, not in DB)

| Key | Meaning |
|---|---|
| `drivepod-lowBandwidth` | hide thumbnails (56k mode) |
| `drivepod-autoplayMode` | `newest` \| `newer` \| `older` \| `oldest` \| `off` (migrated from legacy `next`→`older`, `none`→`off`) |
| `drivepod-skipMarksWatched` | treat next-skip as track completion |

### 10.3 Environment variables (`.env` → container)

| Var | Used by | Notes |
|---|---|---|
| `CACHE_DIR` / `DATA_DIR` / `DATABASE_URL` | backend | required — backend exits if missing |
| `NGINX_PORT` (default 24320) / `VPS_IP` (default 0.0.0.0) | compose | host port map |
| `WG_PRIVATE_KEY` / `WG_ADDRESS` / `WG_DNS` / `WG_PEER_PUBLIC_KEY` / `WG_PEER_ALLOWEDIPS` / `WG_PEER_ENDPOINT` / `WG_PEER_PERSISTENT_KEEPALIVE` | entrypoint | WireGuard client; tunnel skipped if the three required vars are absent |
| `GRABBY_API_TOKEN` | backend | shared secret for the remote grabby delete |

---

## 11. Backend API Reference

**All routes are unauthenticated** (auth was removed 2026-08-23, commit
`bb36974`). Anyone who can reach the port can call the full API, including
destructive routes. Access control is the WireGuard perimeter + network
topology. There are no `/api/auth/*` routes; the `requireAuth` middleware
referenced in older docs does not exist.

### Status & config

| Method | Path | Behavior |
|---|---|---|
| GET | `/api/harvest-status` | live `harvestStatus` object + `session` (the §5.3 state file: `state`, `ts`, `fresh`) |
| GET | `/api/config` | all config keys, parsed (see §10.1 shape) |
| POST | `/api/config` | partial update; only explicitly-listed fields persisted |
| POST | `/api/cookies` | multipart `cookies` file → stored in DB |

### Channels

| Method | Path | Behavior |
|---|---|---|
| GET | `/api/channels` | all channels ordered by `order` |
| POST | `/api/channels` | `{channelId,title?}` upsert; auto-fetches title from RSS when missing/`Unknown Channel`; assigns next `order` |
| PATCH | `/api/channels/:channelId/active` | `{active}` |
| PATCH | `/api/channels/:channelId/duration` | `{minDuration?,maxDuration?}` (null clears) |
| POST | `/api/channels/reorder` | `{channelIds:[…]} → order = array index` |
| POST | `/api/channels/import` | legacy: `{channelIds:[…]}` (RSS title fetch, 800 ms pacing) |
| DELETE | `/api/channels/:channelId` | refuses any `UCGrabbyTube*` placeholder (403); deletes channel's non-grabby videos (folders + rows), RSS cache, clears `currentVideoId` if affected, regenerates index |

### Import (mixed)

| Method | Path | Behavior |
|---|---|---|
| POST | `/api/import` | `{items: string[]}` — mixed channel IDs / channel URLs / video URLs. 409 if harvest or import in flight. Phase 1 classify (below); Phase 2 channels (handle→UC resolution via yt-dlp; existing→skipped); Phase 3 videos (resolve channel from video, create **inactive** channel if new, `importSingleVideo`). 500 ms pacing. |

`classifyYouTubeUrl()` handles: `UC…` IDs, `watch?v=`, `youtu.be/`,
`/shorts/`, `/channel/`, `@handle`, `/c/`, `/user/`. **Fallback: anything
unrecognized is treated as a channel ID** — a stale container running old code
will silently store URLs as channel IDs (rebuild before testing import
changes).

`importSingleVideo()`: existing/ignored video → unignore + protect; if the DB
`audioPath` and folder exist on disk → `already-exists` (no re-download);
otherwise re-download, then `upsert` (preserving the original `publishedAt`).

### Playback state

| Method | Path | Behavior |
|---|---|---|
| PATCH | `/api/video/:videoId/progress` | set progress (int seconds); also sets `currentVideoId`; clears `currentVideoId` if the row is gone |
| POST | `/api/video/:videoId/watched` | mark watched=true (track finished); regenerates index; `syncBagForWatched` drops the shufflebag entry |
| PATCH | `/api/video/:videoId/watched` | toggle to given value; regenerates index; clears `_localWatched` hold on the client; `syncBagForWatched` drops (watched) or re-adds at the tail (unwatched, only if the catalog still lists a playable MP3) |
| PATCH | `/api/video/:videoId/protect` | 404 if unknown; sets protected; regenerates index |
| GET | `/api/player/current` | `{videoId: <currentVideoId> \| null}` |
| PATCH | `/api/player/current` | `{videoId}` — persist last played |

### Media

| Method | Path | Behavior |
|---|---|---|
| GET | `/api/stream/:videoId` | streams the mp3 for any row (incl. grabby) whose file exists; 404 otherwise. **HEAD is auto-served** (Express) — the frontend's defunct-vs-transient probe relies on this. `?bitrate=` / `-mono` query params sent by the SPA are **ignored** (files are pre-transcoded at harvest time). |
| GET | `/cache/…` (nginx) | static: mp3 (immutable 7 d), images (1 d), index.json (no-store, application/json) |

### Destructive / interop

| Method | Path | Behavior |
|---|---|---|
| POST | `/api/purge-all` | delete all non-ignored, non-protected, **non-grabby** rows + folders; regenerates index |
| DELETE | `/api/video/:videoId/grabby` | consume-and-delete a library track: 400 on a DrivePod row, 404 only with no sidecar marker, remote-first + fail-closed (§9) |

---

## 12. Frontend (`frontend/src/app/`)

Single standalone `AppComponent` (selector `app-main`) under a one-route
router. Angular 21 + Tailwind; signals for all state; no RxJS in the component
except `HttpClient` subscriptions. Dark, mobile-first, car-optimized UI.

### 12.1 Tabs (signal `activeTab`, no router)

| Tab | Content |
|---|---|
| 🚶 Queue | paged list (PAGE_SIZE 20, IntersectionObserver infinite scroll, 400 px rootMargin) of unwatched non-ignored videos newest-first; thumbnail, channel, "x ago", duration, progress bar, 🔒 protect toggle, YouTube link (deep-links at the current scrubber second), ▶ play |
| 📡 Harvest | live panel polling `/api/harvest-status` every 4 s while the tab is open: running badge, session badge (green `session live` / red `session dead — harvest paused` / grey `session status unknown`), per-channel action (Ignore Sweep / Fetching RSS / Downloading / Transcoding), counters |
| ⚙️ Settings | all §10.1 controls; channel list with rename, 🟢/⏸️ active toggle, per-channel min/max duration editor, ↑↑ ↑ ↓ ↓↓ reorder, delete; cookies upload/clear; low-bandwidth, autoplay mode, skip-marks-watched; grabby mix toggle + ratio slider (1–20); **Purge All** (confirm dialog) |
| 📥 Import | paste box (mixed channel/video inputs), 10-minute HTTP timeout, per-item added/skipped/failed results; 409 → "Harvest or import already running" |
| 🔒 Protected | protected videos; lock/unlock; play |
| 👁️ Watched | watched history; unwatch (re-queues); play |

Now-playing bar (bottom, always visible when a track is loaded): title,
channel, scrubber (drag = `isScrubbing`, no progress saves while scrubbing),
prev/play-next controls, 🗑️ (grabby only), external YouTube link at the
current position, progress time labels.

### 12.2 Data flow

- **Source of truth for the queue is `cache/index.json`**, fetched via
  `loadIndex()` (cache-busted, `no-store`). No `/api/playlist*` endpoints
  exist.
- `mergeIndexWithLocal()`: **server index is authoritative for watched
  state**, except the `_localWatched` set — tracks marked watched locally
  whose POST is still retrying stay out of the queue until the server
  persists (this prevents played tracks from resurrecting on the 2-min poll
  during network blackholes). Progress: local wins only over a zero server
  value.
- `derivePlaylists()` rebuilds `playlist` (page 0), `protectedPlaylist`,
  `watchedPlaylist` from `rawIndex` and **resets `queuePage`** (stale-page
  guard after the IntersectionObserver race).
- Auto-refresh: `loadIndex()` every **2 minutes** while the SPA is open.
- Every video object carries `channel: {title}`.

### 12.3 Player engine

`playVideo(v)` → `_tryPlay`:

1. **HEAD probe** `/api/stream/<id>` before touching the `<audio>` element:
   - 200 → `_loadAndPlay` (set src, seek to the `stallResumeTarget` position
     if <98% of duration, `play()` — see the watchdog below);
   - 404 → **defunct**: `_skipDefunctTrack` (local-watched hold, remove from
     playlist, POST watched, advance);
   - unreachable/other → `_probeAndPlay`: exponential backoff
     (3 s × 1.5^n, cap 30 s), **indefinite** until 200 or 404.
2. `play()` rejection → `playRejectIsTrackDefect(err.name)`: `NotAllowedError`
   (autoplay policy — stay paused, ready for gesture) and `AbortError` ("the
   play() request was interrupted by a call to `load()`": OUR next selection
   cancelled this attempt, the normal outcome of two presses) say NOTHING about
   the file — no probe, no reload, no charge; a reload would re-point `src` at
   the track being left and wipe the pick. Any other or absent name → probe
   again; on persistent failure stop the player and `advanceToNextTrack()`.
3. `audio.onerror` → **attribute** (`mediaEventTrackId`), then hand the element's
   own **code** to `_handleAudioError`, which **classifies it there**
   (`mediaErrorIsTrackDefect` / `mediaErrorIsTransportError`) and runs the same
   HEAD probe: 404 → skip (the file really is gone, whatever brought the error
   here); file present + the code blames the FILE → charge one recovery of the
   file's budget and reload; file present + `MEDIA_ERR_NETWORK` → reload over a
   NEW request paid from the watchdog's budget, file counter untouched; file
   present + the element not blaming it → nothing, the watchdog owns that attempt.
   Both verdicts are derived from `code` inside the handler rather than passed in
   as a flag, so no caller can bring one out of sync with the signal it came from.

**Every media signal is attributed by `currentSrc`, not by `src`**
(`mediaEventTrackId(audio.currentSrc, audio.src)`, `stall-guard.ts`; T4 drives
it). Assigning `src` updates the ATTRIBUTE synchronously while the selection it
aborts is still being torn down, so a press that lands during the previous load
produces an `error`/`emptied`/`loadstart` for the ABANDONED track with the NEW
track already sitting in `src`. Measured 2026-11-17 in the deployed chromium
against this backend (two presses, first load still in flight): those events
carried `currentSrc` = the pressed-away track with `error.code` 4 /
`networkState` 3 while `audio.src` named the track that press had selected — so
the healthy new track was charged with its predecessor's aborted load, and two
such charges hit `MAX_TRACK_PLAY_FAILURES` and marked watched a file the
listener never heard (a large part of "it does not remember what I watched").
A selection that fails AFTER being chosen reports under its OWN `currentSrc`
(the load algorithm assigns it before the fetch), so preferring `currentSrc`
never hides a real failure of the current track. `onwaiting`/`onstalled` (which
settle the fresh-load window) and `saveProgress` carry the same gate: a stale
`waiting` must not burn the new track's recovery budget, and a position that
belongs to the track being left (0, once its load is aborted) must not be
written over the resume point earned on the candidate.

**What each error shape means** (measured 2026-11-17 in the deployed chromium,
not read off the spec): a stream 404 AND a 200 whose body is not playable both
settle on `MEDIA_ERR_SRC_NOT_SUPPORTED` (4) with a `NotSupportedError` play
rejection — code 4 is the engine's "what I selected is not playable", and both
of those ARE defects of the file we served. A clean supersede fires
`abort`/`emptied` with `audio.error === null` and no code implicating any file,
and its `play()` rejection is named `AbortError`. `src = ''` (every stop path)
is NOT a silent marker: the element re-selects it against the document and
~1.1 s later fires its own code-4 `error` naming the OLD `currentSrc` under the
page URL — attribution plus "not the current track ⇒ ignore" is what keeps that
teardown from charging or reloading the track that replaced it.

**`MEDIA_ERR_NETWORK` (2) is not a defect, and that exclusion is load-bearing**
(fixed 2026-11-20): it is the one code that says *the fetch died*, which is the one
failure a file sitting on disk cannot be guilty of — a dead Wi-Fi association, a NAT
that dropped the connection mid-song, a phone out of coverage, and the half-open
socket of the 2026-11-11 incident all answer with it while the MP3 is byte-perfect.
Charging it to the file let two such blips inside one listening session spend
`MAX_TRACK_PLAY_FAILURES` and mark an unfinished track **watched**, which is exactly
what takes it out of the queue for good: the link came back minutes later and the
track never did. It is still recovered, because an errored element reads as `paused`
and the liveness watchdog vetoes on `paused` — nothing else would ever pick it up —
but the retry it deserves is the watchdog's **fresh-request reload**, paid from
`MAX_STALL_RECOVERIES`, which any audible progress clears. So a flapping link keeps
the track alive (each recovery buys more audible playback and resets the count),
while a stream that never delivers again is skipped after 3 reloads with the backend
reachable, never re-fetched forever.

**Autoplay on load**: first successful `loadIndex()` triggers
`_attemptInitialAutoplay()`. The saved `currentVideoId` wins whenever it is still
in the queue (resuming beats any ordering); only without one does the MODE choose,
via `pickNextTrack(queue, mode)` with no finished track — which starts a direction
mode at the end of the timeline it travels along (`older` → the OLDEST, so walking
backwards has somewhere to walk; `newer` → the newest). `play()` may be
policy-blocked (fine). `oldest`→tail, `newest`→head.

**Autoplay modes — ONE pure pick, every path** (`frontend/src/app/autoplay-order.ts`
→ `pickNextTrack(queue, mode, finished?)`; T6 drives it): `newest`,
`newer`/`older` (the NEAREST neighbour by `publishedAt` in that direction),
`oldest`, `off` (stop). It picks by time, never by list position (a 25-item page
slice gives the same answer as the full queue), breaks ties by scan order, and in
EVERY mode — the extremes included — excludes `finished` BY `videoId`, so the track
being left is never its own successor. It treats an unparseable `publishedAt` as
un-pickable and as never satisfying a step.
The relative comparisons are `<=`/`>=` (not strict) so
same-timestamp siblings (batched imports, grabby clusters drawn to one
`clusterTimestamp`) stay reachable — a strict `<`/`>` strands the player at a shared
timestamp. **Which paths call it**: `markAsWatchedAndPlayNext` (track finished or
skip-marks-watched ⏭️), the shared `advanceToNextTrack` (defunct skip,
unplayable-track give-up, and the manual ⏭️ under `manualNextMode`),
`_skipDefunctTrack`/`_markUnplayable` fallback in `_loadIndexAndPlay`, and
`_attemptInitialAutoplay` (no finished track). Before
2026-11-17 ONLY the finish path consulted the mode; every other path hard-coded
`queue[0]`/`queue[len-1]` — and because the queue is built newest-first, that meant
"newest". A user on `older`/`oldest` therefore got `newest` exactly when the queue
hit trouble, and a relative advance lost its reference track and resumed at the far
END of the timeline, re-entering the broken region it just left. `autoplayMode()` is
re-read AFTER each await so a Settings flip mid-fetch is the honoured one.

**`newest` refreshes the index before picking** (`_playFreshest`, 2026-11-16,
`_nextLeft` since 2026-11-17): `newer`/`older`/`oldest` filter the cached queue by
the finished track's timestamp and have no fresh-surface requirement, so they still
pick straight from `playlist()`. `newest` alone must surface content harvested since
the last poll, so every `newest` advance re-fetches `index.json` first (cheap — the
file is byte-stable + `no-cache`, so it 304s when nothing changed) and plays the
freshest track the RE-derived queue still has, where a freshly-harvested track is
finally visible. "The freshest still there" is `_nextLeft(queue, exclude)` —
`pickNextTrack(…, 'newest', exclude)` plus a list-order fallback for the one case
it answers undefined on a non-empty queue (every `publishedAt` unparseable) — and
`exclude` is the track being left, dropped BY ID from the fresh fetch too: a manual
⏭️ with `skipMarksWatched` OFF leaves that track unwatched, so the refresh still
lists it and a bare head pick would hand it straight back. (The just-finished track
is already pinned watched by the `mergeIndexWithLocal` `_localWatched` pass; passing
it is belt and braces.) The refresh never hard-stops the queue: offline, or if the
refetch itself errors, it rolls to the freshest the CACHE still has; only when the
cache is empty too does it defer on `indexFetchPending` (the §12.5 resume path). If
the mode flips during the fetch, `_playFreshest` BAILS (returns without playing)
rather than playing a head the user no longer asked for; the new mode is honoured by
the next advance, and by `_loadIndexAndPlay`, which re-reads the mode after its own
fetch and runs `pickNextTrack(queued, mode, finished)` on the REFRESHED queue (its
offline and error branches just set `indexFetchPending` — a relative step that found
nothing locally has no head to fall back to).

**Skip semantics**: `skipNext()` (the ⏭️ button and `nexttrack`) with
`skipMarksWatched` on → the full completion path. With it off the left track stays
in the queue UNWATCHED, and the advance is the SAME mode-aware one autoplay uses:
`advanceToNextTrack(left, manualNextMode(autoplayMode()))`, i.e. `pickNextTrack`
under the chosen mode, with 'off' stepping one item older (`manualNextMode`'s
comment says why). It used to play `playlist[idx + 1]` — a neighbour in newest-first
LIST order, which is not what `older`/`oldest`/`newer` ask for, and under 'off' it
re-picked a track the user had just pressed Next away from once the list shifted.
**⏮️ is ⏭️ read backwards, and only exists while `skipMarksWatched` is OFF**:
`skipPrevious()` (button + `previoustrack`) calls the same `stopAndAdvance` with
`manualPrevMode(autoplayMode())` — the OPPOSITE direction, always relative, never
an extreme — so a Next then Previous returns the origin track under every
neighbour-stepping mode. With `skipMarksWatched` ON the button is not rendered and
the handler no-ops: there ⏭️ MARKS the left track finished (watched, out of the
queue and bag), and a finished track is not something a back step can undo. When
the walk has nothing left in that direction the current track restarts from the
top (the media-player convention, as the pre-mode `idx <= 0` branch did) rather
than refreshing and advancing — a Previous is not an advance. The ← / → keys still
seek ∓10 s inside the current item (§12.7); they are a different axis, not a
stand-in for this.

**Hide ⇒ stop invariant**: every path that sets `currentVideo` to null also
does `audio.pause(); audio.src=''; setMediaPlaybackState('none')` (enforced by
an `effect()` in the constructor) — a hidden player must not keep playing.

**Playback liveness watchdog — silent starvation** (`frontend/src/app/stall-guard.ts`
holds the pure decision; `_runStallCheck()` in `app.component.ts` executes it
after every connectivity-probe verdict, so it needs no timer of its own):

- Liveness heartbeat = `timeupdate` (~4 Hz on a playing MP3): `lastProgressAt`
  is the wall clock of the last audible advance. It is re-armed on every fresh
  load, which self-serializes the attempts — no separate per-attempt clock.
- Silence past `STALL_DETECT_MS` (20 s = 5 × the heartbeat cadence) while the
  element claims to play → phase `stalling` → **recovery reload**: the same
  track via a **NEW HTTP request**. Re-assuming the buffer is a no-op —
  `load()` aborts the outstanding fetch but Chromium keeps the buffered
  ranges, so playback resumes from the retained window and re-stalls at its
  edge, forever. Only setting `src` opens a new connection.
- `readyState` NEVER suppresses a recovery: a half-open media socket keeps a
  full buffer (`readyState 4`), which the old gate (`!paused && readyState >= 2`)
  read as perfectly healthy. The 2026-11-11 incident proved the wedge:
  `HEAD /api/config` and `PATCH /api/video/:id/progress` kept answering 200 for
  40 minutes while the one media socket egressed and received nothing — so
  `backendOnline` never flipped, the outage machinery never ran, no badge
  appeared, and `audio.onerror` never fired (a stalled socket raises no error).
  A half-open pipe is therefore detected by **absence of progress**, and the
  watchdog's fresh request is what actually repairs it.
- Give-up: `MAX_STALL_RECOVERIES` (3) fresh loads per track, then
  `_skipDefunctTrack()`. Any audible progress clears the count, so only a track
  that never plays again is abandoned; a flaky link that keeps recovering is not.
- **Resume target** (`stallResumeTarget`): the element's own `currentTime` once
  metadata has landed (`readyState >= HAVE_POSITION_READY_STATE` = 1) — the
  listener is ~10 s ahead of the 10 s-throttled `progress` the index knows —
  else the index copy (the element has no position before metadata, and
  `currentTime` is 0 there). Computed BEFORE `src` is re-assigned: the load
  algorithm wipes the playback position the moment a new source is set. A resume
  at 0 with a 28 MB retained buffer replays ~6 min at 64 kbps mono.
- **"Same track" is a question about the ELEMENT** (`streamTrackId(audio.src)
  === video.videoId`, fixed 2026-11-15): every advance path writes the next
  candidate into `currentVideo` inside `_tryPlay` *before* the HEAD probe
  resolves, and the `currentVideo -> null` effect that would clear `src` is
  scheduled after that set — so at load time the element still holds the track
  being left while `currentVideo` already names the candidate. The old
  `currentVideo`-based check therefore read `sameTrack = true` for the NEXT
  track and seeked it to the finished one's position: a 105.9 s item ending
  parked the 28-minute item that followed at 1:45 (`Resumed … from 105.9s`), and
  any next track longer than the position being left started partway through
  itself (a mid-track row click inherited 80 s the same way). Passing 0 for a
  different track leaves its own saved progress (or 0) as the resume record;
  the same rule now also grants a fresh `MAX_STALL_RECOVERIES` budget per track
  instead of spending the finished track's count.
- Clock trust: a frozen/suspended tab runs its timers ~1/min, so a stale
  heartbeat proves nothing there; `visibilitychange` / `resume` own that
  decision and are granted a shortened budget (`RESUME_DETECT_MS` 6 s).
  `navigator.mediaSession.playbackState === 'playing'` keeps the clock trusted
  while the page is hidden but audible (lockscreen, car head-unit).
- Only watchdog-issued loads (`_stallLoadOutstanding`) may be retried, so a
  playback blocked by the autoplay policy is never reloaded forever.
- A `MEDIA_ERR_NETWORK` reload from `_handleAudioError` is a **watchdog-issued
  fresh load too** (`recoverStalledPlayback(reason: 'reconnecting',
  resumeFromElement: false)`): the errored element is paused with a dead buffer, so
  its `currentTime` is the position it FAILED at and must not become the resume
  point (that is what `resumeFromElement: false` is for, exactly as for the
  buffer-starvation reload). Audible progress clears `MAX_STALL_RECOVERIES` just as
  it does for a wedge, so a flapping link is not a death sentence for the track, and
  a reload that yields 0 B is the only case where the count is spent with nothing
  heard — 3 of those with the backend reachable stops and advances (§12.6).
- UI: the `playbackPhase` signal drives a `role="status" aria-live="polite"`
  badge — `⏳ Buffering…` / `⏳ Reconnecting…` — the only visible sign any of
  this happened (`idle` renders nothing; silent starvation used to render nothing
  at all, which is why "the app just stopped and nothing said why").
- Test: `node tests/stall-guard.test.mjs` (68 assertions, no browser and no
  network: the pure decision plus both resume clocks, the `streamTrackId`
  track-ownership rule and the `mediaEventTrackId` / `mediaErrorIsTrackDefect` /
  `mediaErrorIsTransportError` / `playRejectIsTrackDefect` error-attribution rules,
  driven on simulated ticks — including the `readyState 4` stale buffer, a load that
  never answers, the give-up cadence, scrubbing/paused/frozen-tab immunity, the
  advance cases (a longer next track never inherits the finished track's position, a
  next track resumes at its own saved progress, a same-track re-load keeps its live
  position), and the measured element shapes: an aborted selection is owned by
  `currentSrc` not by the new `src`, a teardown error still names the track the
  element last selected, code 4 is a defect while code 1 and no-code silence are
  not, `AbortError`/`NotAllowedError` play rejections are not, and code 2 — the one
  code a file on disk cannot cause — reloads from the watchdog's budget instead of
  spending the file's.)

### 12.4 Progress persistence

- `ontimeupdate` → throttled save every **10 s**; onseeked → 300 ms debounce;
  onpause/onended/beforeunload → immediate.
- Saves are int seconds; deduped per (videoId, int).
- Failed saves → operation queue (§12.5).
- `saveCurrentVideo()` PATCHes `/api/player/current` on every track start
  (fire-and-forget).

### 12.5 Network resilience (the car-environment design)

- The policy is the pure module `retry-policy.ts` (`Outbox`, `classifyFailure`,
  `retryDelayMs`); **T7** `node tests/retry-policy.test.mjs` (66 assertions, no
  browser, no network, no build) drives it. Wiring in `app.component.ts` keeps the
  signals honest in the same tick: `markAsWatched` / `saveProgress` enqueue AND patch
  `rawIndex`, and `_localWatched` pins a watched id out of every derived queue until
  the server says `persisted`, so an accepted-but-unproven mark never flips back.
- **Operation queue**: `{videoId, type: 'watched'|'progress'}` — progress dedupes to
  latest per video, watched dedupes per video (a repeated press is ONE op, and the
  un-press of a still-queued watched mark CANCELS it rather than queueing a
  contradicting op that FIFO order could deliver last). Backoff 2 s × 2^n capped at
  60 s, **counted per op**, never across the queue.
- **Only a verdict ends an op.** `classifyFailure(status)` separates *the server did
  not answer* (`null`/0 = transport, plus 408/429/5xx → `retryable`: retry, at worst
  one request/minute forever) from *the server answered no* (any other 4xx →
  `permanent`: drop, logged). A transport failure is indistinguishable from the
  network being down, so it can never burn an op: the old shared
  `MAX_RETRY_ATTEMPTS = 10` counter let a ~30 s Wi-Fi flap outlasting the budget
  silently discard the WHOLE backlog of watched marks — every remaining op then got
  a single try — and one permanently-404ing op at the head of the FIFO starved every
  op behind it for the life of the tab while their `_localWatched` pins hid them from
  a queue the server still listed.
- **A probe success cuts the wait only if a transport failure set it.** Each op
  records `blockedOn`, and `Outbox.headBlockedOnTransport()` is what lets a probe
  flush ahead of `retryDelayMs(head.attempts)`: HEAD answering 200 proves
  reachability, which is exactly the question a transport failure left open. An HTTP
  status is an ANSWER, so proving the server reachable proves nothing about it —
  otherwise "HEAD 200 but POST 500" becomes a flat 3 s hammering loop instead of a
  backoff.
- **ONE request in flight, whoever asks for it** (`Outbox.beginAttempt()` /
  `settleAttempt()` / `attemptInFlight`). Three clocks can reach `flushOutbox()`: the
  head op's own backoff timer, the 3 s booster probe and the 5 s always-on probe. A
  POST over a half-open socket answers nothing for minutes, so a claim-free flush
  started a FRESH request for the SAME head op on every tick that found the backend
  reachable — T7's model of the app's own clocks (one reset, then 100 s of silence)
  issues **57 unanswered POSTs** against one mark, **48** of them queued at once against
  an origin Chrome gives **six** connections to, which stalls every `index.json` poll and
  audio stream on that host too (the same pool exhaustion the hung probe shows from the
  other side) — and 19 of those died at the client deadline, each death a verdict the
  subscription reports, so the op climbed to **20 attempts** on requests the server never
  saw. `beginAttempt()` hands out the head op ONLY if
  nothing is outstanding; the outstanding flight owns the next step (it settles from
  its own answer and `_armOutboxClock()` re-arms), so `flushOutbox()` returning early
  is a wait, not a stall. `clear()` releases the claim, because teardown is the one
  path where neither callback runs (Angular drops the subscription), and a stale
  claim would leave a rebuilt outbox mute for its whole life.
- **Two probes, one verdict.** *Always-on*: `HEAD /api/config` every 5 s
  (`ALWAYS_ON_PROBE_INTERVAL`) — that is the outage machinery. *On demand*
  (`probeBackend()`, `PROBE_INTERVAL` 3 s): armed by `outbox.enqueue()` and
  self-stopped only when nothing is owed (`isEmpty && !indexFetchPending`), so a
  backlog left by a drop is driven to an answer instead of parked until the next
  press. Both run `_doConnectivityProbe()`, which counts `_consecutiveProbeFails`
  and at **3** calls `_snapshotPlaybackStateOnDrop()` (recording
  `_wasPlayingBeforeDrop` from `audio.paused`/`audio.error` + currentVideo); 200 or
  **401** clears the count and runs the recovery paths, any other status keeps
  counting. The watchdog tick runs AFTER the verdict, because a probe failure is
  what hands a dead stream to the outage machinery.
- **Every probe carries a deadline and only one is in flight at a time** (fixed
  2026-11-23, `PROBE_TIMEOUT_MS` 4.5 s + `_probeInFlight`). A bare `fetch` to a
  **half-open** TCP connection (Wi-Fi association dead, NAT dropped the flow, phone
  out of coverage) is not a promise that settles: it answers nothing and errors
  nothing for the browser's multi-minute connect timeout. The E2E A/B against a
  black-hole port showed exactly that — six HEAD requests stacked at 5 s intervals,
  none ever answered, so `_consecutiveProbeFails` never reached 3, the
  `Backend unreachable` verdict never fired, and no outage snapshot was ever taken:
  the interval kept firing, but the sixth stacked request held the last slot in the
  origin's connection pool, so nothing after it even reached the server.
  Worse, `_runStallCheck()` runs on this promise's continuations (§12.3): while a
  probe hangs, the playback stall watchdog gets **no tick at all**, so the one
  failure mode `stall-guard.ts` exists for (a socket that answers nothing) became
  "no watchdog" instead of "reload the stream". Both halves are load-bearing: the
  `signal` guarantees a verdict, the single-flight flag guarantees exactly one —
  without it the queued continuations all land at once and each moves the failure
  count. A timeout IS unreachability, so it feeds the same failure path. Measured
  after the fix: outstanding never exceeded 1, every request aborted by the client
  4.50 s after arrival (arrivals 6.14 / 11.14 / 16.14 s), verdict on the 3rd settle
  ~20 s after load. The pre-fix run also showed what the stacked requests cost
  beyond the failure count: **arrivals stopped at six while the interval kept
  firing** — Chrome allows six concurrent connections per origin, so the hung HEADs
  occupied the entire pool and a page-side `fetch` of a DIFFERENT path on that
  origin never completed either. One hung probe therefore stalls every
  `index.json` poll, every outbox POST and the audio stream itself. Teardown drops
  the deadline so an abort cannot settle onto a dead element.
- **On recovery** (the count dropping to 0, so once per outage rather than once per
  probe): resume any pending playback retry immediately; reload audio **only if it
  was playing before the drop** (`recoverAudioPlayback()` — a paused track stays
  paused); flush the outbox when the head op is transport-blocked (bullet above);
  lift `indexFetchPending` and refetch. The outage snapshot is CONSUMED during
  recovery so the second spurious path (`window.online`) cannot double-trigger it.
  Explicit play intents (play button, head-unit play, replay-from-start) set
  `_wasPlayingBeforeDrop=true` so they resume too.
- `window.online` is treated as unreliable (fires on NIC-up, not internet-up) — it
  only triggers a probe.
- **Index fetch deferral**: failed `loadIndex()` sets `backendOnline=false`; the
  2-min poll and autoplay fetches defer (`indexFetchPending`) until the probe confirms
  reachability. Failed fetches never overwrite in-memory state with browser cache.
- **UI/network decoupling rule**: state transitions (track end, skip, hide)
  update signals synchronously; the HTTP call is fire-and-forget + queued.

### 12.6 Media Session (phone lockscreen / car head-unit)

- `metadata` from the current video (title, channel as artist, thumbnail as
  artwork); `playbackState` kept in sync; `setPositionState` (duration,
  position, rate) throttled to **1.8 s** — this is what renders the Ford Sync
  style progress on car displays.
- Handlers: play (re-arms playing flag), pause, `nexttrack` → `skipNext()` (so
  head-unit next respects `skipMarksWatched` AND the autoplay mode) and
  `previoustrack` → `skipPrevious()` (the inverse direction of the same mode;
  **no-ops while `skipMarksWatched` is on**, and the handler stays registered even
  then on purpose — an unregistered `previoustrack` makes the OS key a rewind, and
  that meaning must not flip when the user toggles a Settings checkbox they may be
  looking away from).

### 12.7 Keyboard shortcuts (input-field guarded)

| Key | Action |
|---|---|
| ← / → | seek ∓10 s |
| Delete | consume the current library track (no confirm; lands even when its DB row is already gone, and advances the player under the autoplay mode — §9) |

### 12.8 Known client-side oddities (honest list)

- `importChannels()` splits the paste on the **literal two-character
  sequence `\\n`**, not newlines (`rawText.trim().split('\\n')` in a non-raw
  string). Multi-line pastes are therefore treated as one blob (works for
  space/comma-free single lines only). The backend's classifier would then
  fallback-classify the whole string as a "channel ID". Fix when touched.
- Stream URL sends `?bitrate=…` and `-mono` suffix that the backend ignores
  (§11) — cosmetic; the file is what the file is.
- ~~`probeBackend()`'s recovery branch doesn't handle the 401-as-reachable case~~
  — gone as of 2026-11-20: it now only decides whether the demand probe is still
  owed (`outbox.isEmpty && !indexFetchPending` ⇒ stop) and delegates the request to
  `_doConnectivityProbe()`, so there is exactly ONE reachable-or-not verdict in the
  client (the 401-as-reachable rule can no longer be missed in one of two places).
- `initializeCurrentVideo()` is unused (initial autoplay is handled by
  `_attemptInitialAutoplay`).
- Dead code: nothing auth-related exists client-side anymore; the skill's
  historical `AuthService`/guards/interceptor references predate the
  auth-removal commit.

---

## 13. Deployment & Operations

### 13.1 Build & deploy (the only correct sequence)

```bash
cd /home/user/projects/DrivePod
docker compose build
docker compose create --force-recreate
docker compose start
```

`docker compose up -d --build` is blocked by the terminal tool's server
detection; `create --force-recreate` **without** `build` recreates from the
stale image (classic "my change isn't there" bug). No code changes →
`docker restart drivepod` is enough. Logs: `docker compose logs --tail=30
drivepod`.

Verify running code (examples):
`grep -c "classifyYouTubeUrl" backend/dist/server.js` (source truth),
`grep -n "videoId: 'asc'" /app/backend/dist/server.js` (in container).

### 13.2 External endpoints (host-level nginx + <dns-provider> DNS)

- `drivepod.example.com` → VPS → `10.99.0.229:80` over WireGuard (WG address
  from `.env`; the container's own WG peer config is the client side).
- `grabbytube.example.com` → `10.99.0.234:8101` (sibling project).
- `ytcookies.example.com` → `10.99.0.240:8300` (noVNC cookie exporter; the
  source of `/shared-cookies/cookies.txt`).

Useful verifications:

```bash
curl -sI https://drivepod.example.com/cache/index.json   # must be:
  Content-Type: application/json
  Cache-Control: no-store, no-cache, must-revalidate, max-age=0
docker exec drivepod yt-dlp --cookies /shared-cookies/cookies.txt \
  --skip-download --print "%(id)s" <video-url>          # cookie health
docker exec drivepod curl -s http://drivepod-bgutil:4416/ping  # sidecar
```

### 13.3 WireGuard notes

- Container = WG **client** (one peer = the VPS server). `WG_ADDRESS` live:
  `10.99.0.229/32`; DNS `10.99.0.42` inside the tunnel.
- ⚠️ **Live `.env` sets `WG_PEER_ALLOWEDIPS=0.0.0.0/0`** — the `.env.example`
  warns this causes routing loops inside Docker (WG control packets routed
  through wg0). It works in the current deployment, but treat the example's
  `10.99.0.0/20` as the intended value and revisit if tunnel behavior
  degrades.
- The `privileged` + caps + sysctls + `/lib/modules` mount in compose exist
  solely for this.

### 13.4 Line endings

Repo is normalized to **LF** (commit `2e7c3de`; `.gitattributes`
`* text=auto eol=lf`). Older skill notes about CRLF are stale — normal
`patch`/`write_file` edits are fine now.

### 13.5 Common failures (runbook)

| Symptom | Cause → fix |
|---|---|
| Playlist order changes between refreshes with no state change | missing `videoId asc` tiebreaker in `updateIndexFile` (fixed; verify in dist) |
| Queue renders empty | index.json not `application/json` (nosniff kills `.json()`), or fetch failing → check the nginx exact-match block + `backendOnline` |
| `Only images are available` / format 403 on downloads | bgutil sidecar off the `shared` network → `docker network connect shared drivepod-bgutil`; or PO-token/cookie issue (INTELLIGENCE.md triage) |
| Every download 403 (audio-only) | datacenter format-403 → ensure the combined-stream `-f` filter is in `getBaseYtDlpCommand` |
| Import stores URLs as channel IDs | stale container (old `classifyYouTubeUrl` fallback) → rebuild |
| Harvest and import stomp on each other | the `isHarvesting`/`isImporting` pair — never remove one without the other |
| Grabby items wiped by a purge | any new delete path missing `isGrabby:false` (skill's safety rule) |
| SQLite 2570 disk I/O error | Windows process holding `data/database.db` open (drvfs); recover via `.dump` → restore → `PRAGMA integrity_check` (skill `sqlite-corruption-recovery`) |
| Watched tracks flicker back in | the `_localWatched` guard in `mergeIndexWithLocal` was dropped |
| Harvest tab says `session status unknown` forever | both readers ENOENT: the vault writes `session-state.json` beside the jar, but `COOKIE_SESSION_STATE` was never set to that path (relocated jar → readers still aim at `/shared-cookies/`, §5.3). Grey badge = nothing is gating |
| Playback dies mid-item: no badge, no error, only a new tab fixes it | half-open media socket — the backend answers every NEW request (`HEAD /api/config` → 200) so `backendOnline` never flips and no outage path runs, while the one `/api/stream` connection keeps delivering nothing. Caught since 2026-11-11 by the §12.3 liveness watchdog (badge + new-request reload + resume where the listener stopped); a track that never plays again is skipped after 3 loads |

---

## 14. Security Posture (as-is, honest)

- **No application auth.** All API routes are open; the only perimeter is
  WireGuard + the VPS nginx. Anything bound to this port on a non-VG network
  is fully writable (purge-all, channel delete, cookie read).
- **Cookies at rest**: the DB `cookies` config holds the raw Netscape cookie
  file content; `/shared-cookies/cookies.txt` is a live mount of a logged-in
  YouTube session. Both are readable by anything in the container.
- **`.env` is world-readable** (`777`) on the drvfs mount and contains the WG
  private key + `GRABBY_API_TOKEN` (it is git-ignored; the shared risk is
  local/WSL access and the 777 mode).
- **No auth on the stream endpoint** — audio is streamable by URL to anyone
  who can resolve the hostname (acceptable for a personal deployment; the
  content is the user's own subscription).
- The `X-Grabby-Token` shared-secret pattern is the only inter-service auth
  in the stack.
- index.json carries full video metadata + DB internals (cuid ids,
  createdAt) — fine over the VPN, keep it that way.

If auth is ever re-added: backend middleware from scratch (none exists),
the stream endpoint needs `?token=` support (audio `<src>` can't send
headers), and the always-on probe must send it too.

---

## 15. Design Invariants (don't break these)

1. **`index.json` is the queue's source of truth.** Every DB mutation that
   affects queue membership calls `updateIndexFile()`. New mutation paths
   must too.
2. **Deterministic ordering**: `publishedAt desc, videoId asc` in the index.
3. **Server-authoritative watched state** + the `_localWatched` hold for
   in-flight completions.
4. **`isGrabby` safety**: files preserved on corruption, rows self-healed in
   the index, never touched by purge paths, never deleted with a
   non-grabby `deleteMany`.
5. **UI state never waits on the network**; all state transitions are
   synchronous, all HTTP is fire-and-forget + retried.
6. **Hidden player ⇒ stopped audio** (the `effect()` + explicit paths).
7. **Harvest/import mutual exclusion** protects cache folders from orphan
   cleanup.
8. **Combined-stream download format** is load-bearing (datacenter 403s).
9. **Single writer per file**: GrabbyTube writes `grabby-index.json` +
   grabby folders' canonical state; DrivePod writes `index.json` +
   `shufflebag.json`. The remote-first fail-closed delete keeps that intact.
10. **yt-dlp flags live only in `getBaseYtDlpCommand()`** (plus the download
    extras) — keep it the single source when matching GrabbyTube.
11. **`publishedAt` is pinned to the DB in `index.json`** for every item —
    per-item JSON wins for everything else, never for ordering.
12. **Playable = resolvable file**: stale `audioPath` values are healed at
    read/cleanup time (DrivePod rows in `cleanupCorruptedFolders`, grabby
    rows via `resolveGrabbyAudioPath()`); DrivePod never rewrites
    `grabby-index.json`.
13. **The queue advances the way the MODE says** (2026-11-17): one pure
    `pickNextTrack(queue, mode, finished?)` decides every autoplay pick —
    finish, defunct skip, unplayable give-up, post-refresh advance, page-load
    start. No path may hard-code `queue[0]` / `queue[len-1]` again: the list is
    newest-first by construction, so a head/tail default IS `newest`, silently
    overriding a user who chose `older` or `oldest`. A relative step must always
    be given the track being left behind, or it resumes at the far end of the
    timeline. T6 is the gate.
14. **Folder corruption is judged by EXACT file names** (`folderCorruptionReason`,
    §6-2/§8): `<id>.mp3` is the audio and `<id>.json` the sidecar — extension
    matching mistakes FrogRock's `<id>.mp3.tr64k.mp3` and GrabbyTube's
    `<id>.mp3.bak` for duplicate audio, and destroying a grabby row destroys its
    watched state. T2 §17 is the gate.
15. **A transient network failure may never become a permanent local verdict**
    (2026-11-20): an op is dropped only when the SERVER answered it with a status
    (§12.5), a stream error charges the FILE only when the code blames the file
    (§12.3), and a harvest's `finally` may not throw (§5.1/§6-1). Each of those
    three had a latch that outlived the outage: ops discarded on a shared attempt
    count, `MEDIA_ERR_NETWORK` marking a half-heard track watched, and a
    `deleteTempCookiesFile` throw that left `isHarvesting` true for the life of the
    process. T2 §20, T4 and T7 are the gates.
16. **Unreadable bytes are never a verdict** (2026-11-23): a shared-cache JSON
    read distinguishes `missing` (act: seed) from `unreadable` (change nothing on
    disk), and a bag/catalog rebuild may only be triggered by a bounded
    derivation from a file it CAN read (§9). A connectivity probe always answers:
    deadline + single-flight, so a half-open socket cannot starve the outage verdict
    or the watchdog tick that hangs off it (§12.5). T2 §21 is the gate for the
    first half; the second is proven by the black-hole-port A/B recorded there.

---

## 16. Live Deployment Snapshot (2026-10-16)

- Containers up 3+ days: `drivepod` (24320→80), `drivepod-bgutil` (4416),
  `grabbytube` (8101), `grabbytube-bgutil` (4416).
- DB: 768 channels, 308,749 video rows — 307,157 ignored, 1,592 non-ignored
  (the `index.json` set); 716 of those non-ignored are `isGrabby:true`;
  1,016 unwatched (527 non-grabby) — the playable queue. 25 config rows
  (20 live + 5 dead).
- Cache: 1,624 video folders; `index.json` 1,592 items; `progress.json`
  (split from the index — in-queue resume positions only) ~1.5 KB;
  `grabby-index.json` 1,002 items — 36 point at files that no longer exist
  (their DB rows are ignored; init/resolver/recheck exclude them);
  `shufflebag.json` 966 entries (956 unused).
- Profile: 3-day harvest window, 30-day auto-purge, 64 kbps mono, 2 videos
  per channel per 6 h, 15–720 min duration, shorts tab off, grabby mix
  **on** (ratio 3, cluster cap 3), Chrome/153 UA.

*End of ARCHITECTURE.md.*
