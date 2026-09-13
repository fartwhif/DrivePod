# DrivePod — Technical Architecture & Specification

> Authoritative technical reference, verified against the source at commit `5f04b94`
> (2026-08-30) and against the live deployment (396 channels, ~304k video rows,
> 647 live queue items, 669 cache folders, 675 GrabbyTube tracks).
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
`/mnt/c/edrive/projects/grabbytube`): a pre-existing MP3 catalog that DrivePod mixes
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
│   ├── src/server.ts          # ALL of the backend (2,519 lines, single file)
│   ├── prisma/schema.prisma   # 3 models: Channel, Video, Config
│   └── package.json           # express, prisma, rss-parser, node-cron, multer, ...
├── frontend/src/app/
│   ├── app.component.ts       # ALL of the UI logic (1,814 lines, one component)
│   ├── app.component.html     # 807-line template, 6 tabs, Tailwind
│   ├── app.routes.ts          # single route '' → AppComponent (no auth routes)
│   ├── app.config.ts          # provideRouter + provideHttpClient (no interceptors)
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
- **Frontend app version constant**: `1.9.0` (`APP_VERSION` in app.component.ts).

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

| Host path                              | Container path                | Purpose                                    |
|----------------------------------------|-------------------------------|--------------------------------------------|
| `/mnt/c/edrive/projects/DrivePod/data`        | same                          | SQLite DB + temp `cookies.txt`             |
| `/mnt/c/edrive/projects/DrivePod/cache`       | same                          | MP3s, thumbnails, index.json, rss/ cache   |
| `/mnt/c/edrive/projects/ytcookies/data`       | `/shared-cookies` (RO in effect) | live YouTube cookie export (Netscape)    |
| `/lib/modules`                         | same (ro)                     | WireGuard kernel modules                   |

The shared cache dir is **shared with GrabbyTube** — both projects write
per-video folders under `cache/`. DrivePod's cleanup routines must therefore
recognize GrabbyTube folders (a folder whose `{videoId}.json` contains a
`videoId` key is GrabbyTube's and is never deleted).

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
| `channelId`   | String (FK→Channel.channelId) | `UCGrabbyTube` for grabby items   |
| `title`       | String      |                                                        |
| `description` | String?     | (set from metadata JSON if present)                    |
| `publishedAt` | DateTime    | **Grabby items carry a *clustered* timestamp** (±30 min around newest normal content), not the real upload date |
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

### Scale (live, 2026-08-30)

- 396 channels; **304,581 video rows** — the large majority are `ignored: true`
  records created by the per-channel ignore sweeps (§7.4) and duration/pub-date
  filtering. Only **non-ignored** rows appear in `index.json` (647 live items).
- 470 rows currently `isGrabby: true`.
- 669 folders under `cache/` (DrivePod + GrabbyTube items + `rss/` + top-level
  JSON files).

---

## 5. Backend (`backend/src/server.ts`)

Single file, ~2,500 lines, structured top-to-bottom: constants → helpers →
cleanup → shufflebag → discovery → download → harvest → API routes → startup.

### 5.1 Global state & concurrency

```
isHarvesting  — set during harvestAndPurge(); re-entry skipped
isImporting   — set during POST /api/import; harvest skips while true
                (POST /api/import 409s if isHarvesting; harvest skips if isImporting)
UseAlternateListGetterMethod — flipped every harvest run (see §7.2)
harvestStatus — plain object polled by GET /api/harvest-status
```

The harvest/import lock exists because an unlocked import's in-progress cache
folder would be treated as an orphan by `cleanupCorruptedFolders()` and deleted
mid-download.

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
8. Delete the raw container file.

Failure classification:

- cookie-invalid messages → **auto-clears the DB `cookies` config**
  (`setConfig('cookies','')`);
- live / premiere / age-gate errors → logged and skipped (return false);
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
  wins); **grabby items keep the DB's clustered `publishedAt`** (the grabby
  file has the original YouTube date in `YYYYMMDD` format and must not win).
- Paths are rewritten with the `/cache/` prefix (nginx serves `/cache/` →
  CACHE_DIR). `audioPath` is always `/cache/<id>/<id>.mp3`.
- **Self-heal**: grabby rows whose MP3 is missing are deleted from the DB
  here (they may have been consumed from the GrabbyTube UI).
- Atomic write: `index.tmp.json` → rename.

Nginx serves it with an exact-match `location = /cache/index.json` block:
`Cache-Control: no-store, …` + `default_type application/json`. MP3s and
thumbnails remain cacheable (`immutable`). The SPA additionally cache-busts
(`?_t=…`, `cache:'no-store'`).

### 5.7 Startup sequence (bottom of file)

1. If `index.json` is absent → write one immediately.
2. `initShuffleBag()` (async, non-blocking).
3. `cron.schedule('*/5 * * * *', harvestAndPurge)` **and** one immediate
   `harvestAndPurge()`.
4. `app.listen(3000)`.

---

## 6. Harvest Pipeline (`harvestAndPurge`)

Runs every 5 minutes and once at boot. Full sequence:

1. **Re-entry guards** (`isHarvesting` / `isImporting`), reset `harvestStatus`.
2. **`cleanupCorruptedFolders()`** (full consistency pass):
   - Folder with **no** DB record: if its `{id}.json` has a `videoId` key it's
     a GrabbyTube item → skip; otherwise delete as orphan.
   - Folder **with** record but corrupt (empty, 0/2+ mp3s, 0/2+ `{id}.json`,
     >2 thumbnails): grabby → delete **DB row only, keep files**; normal →
     delete folder + row.
   - Orphan DB rows (`ignored:false, isGrabby:false`) with missing folder/mp3
     → delete row. (Grabby rows are never deleted here; the index self-heal
     owns that path.)
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
       `timestamp|duration_string|live_status` when RSS lacked them;
       members-only → `ignoreVideo()`; `VODFuture` (live/upcoming) → skip
       entirely (not even recorded);
     - re-check filters (metadata may have changed duration/date);
     - **`downloadAndProcessVideo()`**;
     - on success: pick thumbnail, ffprobe duration, write
       `cache/<id>/<id>.json` (rich metadata), stage for batch insert.
   - Batch `prisma.video.createMany` + `updateIndexFile()`.
9. **`distributeGrabbyItems()`** (only when `grabbyMixEnabled`, §9).
10. **Auto-purge**: non-ignored, non-protected, **non-grabby** videos with
    `publishedAt` older than `autoPurgeDays` → delete folder + row; clear
    `currentVideoId` if it was purged.

Note the live deployment runs a tight profile (`maxHarvestDays=1`,
`autoPurgeDays=7`, `limitEnabled=true 2 per 1h`, duration 15–360 min, 64 kbps
mono) — see §10 for the full live values.

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
items missing pubDate/duration/liveStatus. Pub-date parsing applies the
**today-midnight rule**: yt-dlp timestamps that land exactly on local midnight
are treated as "now" (avoids off-by-a-day for fresh uploads).

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
├── grabby-index.json           # written by GRABBYTUBE — its catalog
├── shufflebag.json             # shufflebag state (this app)
├── rss/<channelId>.xml         # RSS fallback cache
└── <videoId>/                  # one folder per item (DrivePod OR GrabbyTube)
    ├── <videoId>.mp3           # final audio
    ├── <videoId>-small.webp    # 400×225 thumbnail (DrivePod)
    ├── <videoId>.jpg|webp      # original thumbnail (may be removed post-transcode? kept)
    └── <videoId>.json          # rich metadata (DrivePod: videoInfo; GrabbyTube: own shape)
```

Corruption definition (per §5.7-2): a valid DrivePod folder has exactly one
mp3, exactly one `{id}.json`, ≤2 image files, and is non-empty.

---

## 9. GrabbyTube Integration ("ShuffleBag")

**Purpose**: mix a pre-downloaded MP3 music catalog into the podcast queue at
a duration ratio, so the player is never silent.

**State**:
- `grabby-index.json` — written by GrabbyTube (single writer):
  `{videoId, channelId, title, author, publishedAt: "YYYYMMDD", thumbnailPath, audioPath, duration, createdAt}`.
- `shufflebag.json` — this app's FIFO state: `[{videoId, used}]`.
- Placeholder channel `UCGrabbyTube` (inactive, `order 999999`, undeletable —
  `DELETE /api/channels/UCGrabbyTube` → 403).

**Lifecycle**:

- **Init** (boot): upsert the placeholder channel; load grabby-index, drop
  defunct items (mp3 missing on disk), Fisher–Yates shuffle, persist.
- **Pull** (`pullFromShuffleBag(n)`): take n `used:false` entries in bag order
  (shuffled order = pseudo-random draw), mark used, persist. On exhaustion,
  reinitialize **once** (reusing items is allowed — grabby tracks re-enter the
  mix; see below).
- **Distribute** (after harvest, before auto-purge; skipped when
  `grabbyMixEnabled=false` — **it is currently OFF in the live deployment**):
  1. Measure normal vs grabby **duration in the past hour** (anchored at the
     newest normal video).
  2. `targetGrabby = normalDuration / ratio`; if satisfied, stop.
  3. Floor: `needed = max(deficit, 5 min if ratio ≤ 5 else 15 min)` —
     keeps music flowing in quiet hours without making a 10:1 ratio
     meaningless (the old flat 60-min floor did).
  4. Estimate count from the **real catalog average duration** (≈18 min) + 5
     buffer, pull from the bag.
  5. For each pulled item (re-verifying mp3 existence):
     - **already in DB → "recondition"**: update row with clustered
       `publishedAt` (±30 min of newest normal content via
       `clusterTimestamp`), fresh title/thumb/duration, `watched:false,
       progress:0` — the track cycles back into the mix window;
     - **not in DB → insert** with `isGrabby:true, protected:false`.
  6. Final pre-insert recheck for mp3s deleted mid-harvest (a concurrent
     grabby delete), then `createMany` + `updateIndexFile()`.

**Guard rails** (the `isGrabby` safety rule):

- Auto-purge and purge-all filter `isGrabby:false`.
- Channel delete skips grabby rows.
- `cleanupCorruptedFolders` preserves grabby **files** (deletes DB row only).
- `updateIndexFile` self-heals grabby rows whose mp3 vanished.
- Every `deleteMany` on non-grabby videos carries `isGrabby:false` — audit
  any new delete path for this.

**Consume-and-delete** (`DELETE /api/video/:videoId/grabby`):

- 404 unknown, 400 non-grabby.
- **Remote first, fail-closed**: `DELETE http://grabbytube:8101/tracks/<id>`
  with `X-Grabby-Token` (shared secret `GRABBY_API_TOKEN` in both projects'
  env). Remote 200/404 → proceed; anything else → 502 and **nothing local is
  touched** (GrabbyTube is the single writer of its catalog/index/files).
- Local: delete the DB row (`isGrabby:true` scope), prune the shufflebag entry,
  regenerate the index.
- **No harvest/import concurrency lock** on purpose (user decision); the
  delete-during-harvest race is neutralized by the index self-heal + the
  pre-insert recheck.
- Frontend: 🗑️ button in the now-playing bar (grabby tracks only) and the
  **Delete** hotkey, both calling `consumeGrabbyTrack()` with no confirmation;
  success advances to the next track via `markAsWatchedAndPlayNext()`.

**Recovery if grabby rows get wiped**: delete `cache/shufflebag.json` (fresh
reinit next harvest); grabby-index.json and the MP3s are untouched.

---

## 10. Configuration Reference

### 10.1 DB-backed config (Settings tab → `POST /api/config`)

| Key | Default | Live value (2026-08-30) | Meaning |
|---|---|---|---|
| `maxHarvestDays` | 7 | **1** | discovery window (pub-date filter also uses this) |
| `preferredBitrate` | 128 | **64** | MP3 kbps (UI: 32/48/64/96/128/160/192) |
| `preferredMono` | false | **true** | `-ac 1` in transcode |
| `autoPurgeDays` | 30 | **7** | auto-purge age cutoff |
| `userAgent` | Chrome/134 Win | Chrome/151 X11 | yt-dlp `--user-agent` |
| `cookies` | '' | '' | uploaded/pasted cookies (shared export overrides) |
| `limitEnabled` | false | **true** | per-channel X-per-Y-hours limit |
| `limitVideos` | 2 | **2** | X |
| `limitHours` | 6 | **1** | Y |
| `alternativeMetadataEnabled` | true | true | enable the yt-dlp tab scrape method |
| `scrapeVideosTab` | true | true | videos tab |
| `scrapeStreamsTab` | true | true | streams tab |
| `scrapeShortsTab` | true | false | shorts tab |
| `durationFilterEnabled` | false | **true** | global min/max filter |
| `minDurationMinutes` | 0 | **15** | global min |
| `maxDurationMinutes` | 720 | **360** | global max |
| `grabbyMixEnabled` | true | **false** | shufflebag on/off |
| `grabbyMixRatio` | 3 | **10** | normal:grabby duration ratio (UI clamps 1–20) |
| `currentVideoId` | '' | j55r6hpyKl4 | last played video (resume target) |

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
`b7664c0`). Anyone who can reach the port can call the full API, including
destructive routes. Access control is the WireGuard perimeter + network
topology. There are no `/api/auth/*` routes; the `requireAuth` middleware
referenced in older docs does not exist.

### Status & config

| Method | Path | Behavior |
|---|---|---|
| GET | `/api/harvest-status` | live `harvestStatus` object |
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
| DELETE | `/api/channels/:channelId` | refuses `UCGrabbyTube` (403); deletes channel's non-grabby videos (folders + rows), RSS cache, clears `currentVideoId` if affected, regenerates index |

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
| POST | `/api/video/:videoId/watched` | mark watched=true (track finished); regenerates index |
| PATCH | `/api/video/:videoId/watched` | toggle to given value; regenerates index; clears `_localWatched` hold on the client |
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
| DELETE | `/api/video/:videoId/grabby` | consume-and-delete a grabby track (remote-first, fail-closed; §9) |

---

## 12. Frontend (`frontend/src/app/`)

Single standalone `AppComponent` (selector `app-main`) under a one-route
router. Angular 21 + Tailwind; signals for all state; no RxJS in the component
except `HttpClient` subscriptions. Dark, mobile-first, car-optimized UI.

### 12.1 Tabs (signal `activeTab`, no router)

| Tab | Content |
|---|---|
| 🚶 Queue | paged list (PAGE_SIZE 20, IntersectionObserver infinite scroll, 400 px rootMargin) of unwatched non-ignored videos newest-first; thumbnail, channel, "x ago", duration, progress bar, 🔒 protect toggle, YouTube link (deep-links at the current scrubber second), ▶ play |
| 📡 Harvest | live panel polling `/api/harvest-status` every 4 s while the tab is open: running badge, per-channel action (Ignore Sweep / Fetching RSS / Downloading / Transcoding), counters |
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
   - 200 → `_loadAndPlay` (set src, seek to saved progress if <98% of
     duration, `play()`);
   - 404 → **defunct**: `_skipDefunctTrack` (local-watched hold, remove from
     playlist, POST watched, advance);
   - unreachable/other → `_probeAndPlay`: exponential backoff
     (3 s × 1.5^n, cap 30 s), **indefinite** until 200 or 404.
2. `play()` rejection: `NotAllowedError` = autoplay policy (stay paused,
   ready for gesture); anything else → probe again; on persistent failure
   stop the player and `advanceToNextTrack()`.
3. `audio.onerror` (fires for both 404 and network loss) → same HEAD probe:
   404 skip, 200 reload, unreachable do nothing (probe loop owns retry).

**Autoplay on load**: first successful `loadIndex()` triggers
`_attemptInitialAutoplay()` — resumes `currentVideoId` if present, else
`oldest`→last else first; `play()` may be policy-blocked (fine).

**Autoplay modes** (after a track ends — `markAsWatchedAndPlayNext`):
`newest` (top of queue, reload index when empty), `newer`/`older` (by
publishedAt relative to the finished track), `oldest` (bottom), `off` (stop).

**Skip semantics**: `skipNext()` = jump without marking watched, unless
`skipMarksWatched` is on → full completion path. `skipPrevious()` at index 0
replays from 0 (and re-arms the playing-before-drop flag).

**Hide ⇒ stop invariant**: every path that sets `currentVideo` to null also
does `audio.pause(); audio.src=''; setMediaPlaybackState('none')` (enforced by
an `effect()` in the constructor) — a hidden player must not keep playing.

### 12.4 Progress persistence

- `ontimeupdate` → throttled save every **10 s**; onseeked → 300 ms debounce;
  onpause/onended/beforeunload → immediate.
- Saves are int seconds; deduped per (videoId, int).
- Failed saves → operation queue (§12.5).
- `saveCurrentVideo()` PATCHes `/api/player/current` on every track start
  (fire-and-forget).

### 12.5 Network resilience (the car-environment design)

- **Operation queue**: `{videoId, type: 'watched'|'progress'}` — progress
  dedupes to latest per video; watched dedupes per video. Exponential backoff
  2 s × 2^n cap 60 s, max 10 attempts, then dropped (logged).
- **Always-on probe**: `HEAD /api/config` every 5 s. 3 consecutive failures =
  unreachable → `_snapshotPlaybackStateOnDrop()` records
  `_wasPlayingBeforeDrop` (from `audio.paused`/`audio.error` + currentVideo).
- **On recovery**: flush pending ops; resume any pending playback retry
  immediately; reload audio **only if it was playing before the drop**
  (`recoverAudioPlayback()` — a paused track stays paused). Explicit play
  intents (play button, head-unit play, replay-from-start) set
  `_wasPlayingBeforeDrop=true` so they resume too.
- `window.online` is treated as unreliable (fires on NIC-up, not
  internet-up) — it only triggers a probe.
- **Index fetch deferral**: failed `loadIndex()` sets `backendOnline=false`;
  the 2-min poll and autoplay fetches defer (`indexFetchPending`) until the
  probe confirms reachability. Failed fetches never overwrite in-memory state
  with browser cache.
- **UI/network decoupling rule**: state transitions (track end, skip, hide)
  update signals synchronously; the HTTP call is fire-and-forget + queued.

### 12.6 Media Session (phone lockscreen / car head-unit)

- `metadata` from the current video (title, channel as artist, thumbnail as
  artwork); `playbackState` kept in sync; `setPositionState` (duration,
  position, rate) throttled to **1.8 s** — this is what renders the Ford Sync
  style progress on car displays.
- Handlers: play (re-arms playing flag), pause, `nexttrack` → `skipNext()`
  (so head-unit next respects `skipMarksWatched`), `previoustrack` →
  `skipPrevious()`.

### 12.7 Keyboard shortcuts (input-field guarded)

| Key | Action |
|---|---|
| ← / → | seek ∓10 s |
| Delete | consume current grabby track (no confirm) |

### 12.8 Known client-side oddities (honest list)

- `importChannels()` splits the paste on the **literal two-character
  sequence `\\n`**, not newlines (`rawText.trim().split('\\n')` in a non-raw
  string). Multi-line pastes are therefore treated as one blob (works for
  space/comma-free single lines only). The backend's classifier would then
  fallback-classify the whole string as a "channel ID". Fix when touched.
- Stream URL sends `?bitrate=…` and `-mono` suffix that the backend ignores
  (§11) — cosmetic; the file is what the file is.
- `probeBackend()`'s recovery branch doesn't handle the 401-as-reachable case
  the way `_doConnectivityProbe()` does (harmless now — there is no auth —
  but don't copy that pattern if auth returns).
- `initializeCurrentVideo()` is unused (initial autoplay is handled by
  `_attemptInitialAutoplay`).
- Dead code: nothing auth-related exists client-side anymore; the skill's
  historical `AuthService`/guards/interceptor references predate the
  auth-removal commit.

---

## 13. Deployment & Operations

### 13.1 Build & deploy (the only correct sequence)

```bash
cd /mnt/c/edrive/projects/DrivePod
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

### 13.2 External endpoints (host-level nginx + Dynu DNS)

- `drivepod.esfbc.com` → VPS → `192.168.0.229:80` over WireGuard (WG address
  from `.env`; the container's own WG peer config is the client side).
- `grabbytube.esfbc.com` → `192.168.0.234:8101` (sibling project).
- `ytcookies.esfbc.com` → `192.168.0.240:8300` (noVNC cookie exporter; the
  source of `/shared-cookies/cookies.txt`).

Useful verifications:

```bash
curl -sI https://drivepod.esfbc.com/cache/index.json   # must be:
  Content-Type: application/json
  Cache-Control: no-store, no-cache, must-revalidate, max-age=0
docker exec drivepod yt-dlp --cookies /shared-cookies/cookies.txt \
  --skip-download --print "%(id)s" <video-url>          # cookie health
docker exec drivepod curl -s http://drivepod-bgutil:4416/ping  # sidecar
```

### 13.3 WireGuard notes

- Container = WG **client** (one peer = the VPS server). `WG_ADDRESS` live:
  `192.168.0.229/32`; DNS `192.168.0.42` inside the tunnel.
- ⚠️ **Live `.env` sets `WG_PEER_ALLOWEDIPS=0.0.0.0/0`** — the `.env.example`
  warns this causes routing loops inside Docker (WG control packets routed
  through wg0). It works in the current deployment, but treat the example's
  `192.168.0.0/20` as the intended value and revisit if tunnel behavior
  degrades.
- The `privileged` + caps + sysctls + `/lib/modules` mount in compose exist
  solely for this.

### 13.4 Line endings

Repo is normalized to **LF** (commit `c6a99e9`; `.gitattributes`
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

---

## 16. Live Deployment Snapshot (2026-08-30)

- Containers up 3+ days: `drivepod` (24320→80), `drivepod-bgutil` (4416),
  `grabbytube` (8101), `grabbytube-bgutil` (4416).
- DB: 396 channels, 304,581 video rows — 303,934 ignored, 647 non-ignored
  (the `index.json` set); 470 of those non-ignored are `isGrabby:true`; 98
  are unwatched non-grabby (the true "next to play" queue). 24 config keys
  (19 live + 5 dead).
- Cache: 669 video folders; `index.json` 647 items; `grabby-index.json` 675
  items. Other top-level files (`completed.json`, `status.json`,
  `shufflebag.json`, `index.json.bak`/`.old`) are app/GrabbyTube state +
  manual backup leftovers — not part of the queue contract.
- Profile: 1-day harvest window, 7-day auto-purge, 64 kbps mono, 2 videos per
  channel per hour, 15–360 min duration, shorts tab off, grabby mix **off**
  (ratio 10 staged), Chrome/151 UA.

*End of ARCHITECTURE.md.*
