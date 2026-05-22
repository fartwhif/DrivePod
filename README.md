# 🚙📻 DrivePod

**Self-hosted YouTube-to-Audio Podcast Player • Built for the Road**

DrivePod automatically harvests new videos from your favorite YouTube channels, downloads them as high-quality MP3s, and turns them into a smart, data-throttled audio queue — perfect for driving, commuting, or hands-free listening.

No ads. Barely sip data - listen while your phone data is throttled without buffering. Beautiful car-friendly UI with progress resume, priority channels, and live harvest monitoring.


---

## 📸 Screenshots

### Queue Tab
The main playlist view with thumbnails, channel info, publish dates, and one-tap playback.

![Queue Tab](https://github.com/fartwhif/DrivePod/blob/main/screenshots/queue-tab.png?raw=true)  
*Clean queue with currently playing indicator and direct YouTube links*

### Harvest Tab
Live monitoring of the background harvesting process with concurrent channel progress.

![Harvest Tab](https://raw.githubusercontent.com/fartwhif/DrivePod/refs/heads/main/screenshots/harvest-tab.png?raw=true)  
*Real-time "LIVE" status, currently processing items, and run statistics*

### Settings Tab
Full configuration panel including bitrate, mono toggle, harvest window, User-Agent, cookies, and channel priority reordering.

![Settings Tab](https://github.com/fartwhif/DrivePod/blob/main/screenshots/settings-tab.png?raw=true)  
*Channel management with ↑↑ ↑ ↓ ↓↓ priority controls and cookie upload*

### Import Tab
Bulk import of channel IDs with instant results feedback.  

![Import Tab](https://github.com/fartwhif/DrivePod/blob/main/screenshots/import-tab.png?raw=true)  
*Paste channel IDs → instant add/skip/failed results*

### Obtaining a Channel ID
the ID is the key to wiring up your DrivePod.  The manual way to obtain someone's channel ID is via their channel page.  I've created a helpful tampermonkey script for exporting the entire list in one shot: To obtain all of your subscribed-to Channel IDs in one go, use this [helper script](https://greasyfork.org/en/scripts/573430-youtube-subscription-channel-id-harvester).  If you're unfamiliar with tampermonkey that's OK, you can still use the settings or import tab to "subscribe" to individual channels one at a time.
![Import Tab](https://github.com/fartwhif/DrivePod/blob/main/screenshots/channel-id.png?raw=true)  

---

## ✨ Features

### Core Functionality
- **Smart Channel Harvesting** — Monitors multiple YouTube channels
- **Dual RSS + yt-dlp Fallback** — Ultra-reliable video discovery (live RSS + scraping Videos/Streams/Shorts tabs)
- **High-Quality Audio** — Downloads best audio → transcodes to MP3 with configurable bitrate (32–192 kbps) and optional mono
- **Cookie Support** — Handles age-restricted, private, and member-only videos (upload your `cookies.txt`)
- **Auto-Purge** — Automatically deletes content older than X days
- **Progress & Resume** — Saves listening progress and resumes exactly where you left off
- **Data Throttling** — Optimized for low-bandwidth environments (56K modem friendly) with compression and caching
- **Smart Autoplay** — 5-way autoplay modes: newest, newer, older, oldest, and off

### Frontend (Angular)
- **Queue Tab** — Clean playlist with thumbnails, publish dates, and YouTube links
- **Live Harvest Tab** — Real-time progress with concurrent channel tracking
- **Settings Tab** — Bitrate, mono toggle, harvest window, User-Agent, auto-purge, and advanced options
- **Import Tab** — Bulk import channel IDs
- **Compact Bottom Player** — Always-visible mini-player with Media Session API (phone/car integration)
- **Channel Reordering** — Drag-like priority controls (↑↑ ↑ ↓ ↓↓)
- **Low Bandwidth Mode** — Option to disable thumbnails for slow connections
- **Responsive UI** — Works on both desktop and mobile devices with optimized layout

### Backend (Node.js)
- **Background Cron** — Harvests every 5 minutes automatically
- **Concurrent Processing** — Up to 2 channels at once with rate limiting
- **Robust Cleanup** — Detects and removes corrupted downloads
- **SQLite + Prisma** — Lightweight, zero-config database
- **Media Session** — Play/pause/next from phone lockscreen or car controls
- **Scalability** — Optimized for large playlists with batched database operations
- **Consistency Checks** — Automated cleanup of DB inconsistencies and orphaned files

---

## 🛠️ Tech Stack

| Layer       | Technology                          |
|-------------|-------------------------------------|
| **Frontend** | Angular 17+ (standalone component) + Tailwind |
| **Backend**  | Node.js + Express + TypeScript     |
| **Database** | Prisma + SQLite                     |
| **Download** | yt-dlp + ffmpeg                     |
| **Parsing**  | rss-parser                          |
| **UI**       | Modern dark theme, fully responsive with media session API |
| **Deployment** | Docker + docker-compose support     |

---

## 📦 Installation

### Prerequisites
- Node.js 18+
- npm/yarn/pnpm
- yt-dlp (`sudo wget https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -O /usr/local/bin/yt-dlp && chmod a+rx /usr/local/bin/yt-dlp`)
- ffmpeg (`sudo apt install ffmpeg` or equivalent)
- Angular CLI (`npm install -g @angular/cli`)
- Nginx (for production)
- Docker and docker-compose (for containerized deployment)

---

## 🚀 Production Deployment

### 1. Prisma Database Initialization (One-time – Required for Production)
Run these commands **once** after cloning the repo (or after any schema changes):

```bash
cd /root/drivepod/backend
npm install

# === Prisma Database Setup ===
npx prisma generate      # Generates the Prisma Client
npx prisma db push       # Creates/updates the SQLite database (data/database.db)
```

> This step creates the SQLite database file at `/root/drivepod/data/database.db` and prepares the Prisma client for production use.

### 2. Backend with PM2 (24/7 operation)
```bash
cd /root/drivepod/backend

# Install ts-node (if not already installed)
npm install ts-node
```

Create `ecosystem.config.js` in the `backend` folder:
```js
module.exports = {
  apps: [{
    name: 'drivepod-backend',
    script: 'server.ts',
    interpreter: './node_modules/.bin/ts-node',
    interpreter_args: '--transpile-only',
    cwd: '.',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '500M',
    env: { NODE_ENV: 'production' }
  }]
};
```

Start the backend:
```bash
cd /root/drivepod/backend
pm2 start ecosystem.config.js
pm2 save
pm2 startup                  # Follow the printed instructions for boot autostart
```

**Useful PM2 commands:**
```bash
pm2 status
pm2 logs drivepod-backend
pm2 restart drivepod-backend
pm2 stop drivepod-backend
```

### 3. Nginx Configuration
The project includes a ready-made Nginx config file **`drivepod-ngnix`** (located in the repository root).

1. Copy it to Nginx:
   ```bash
   sudo cp /root/drivepod/drivepod-ngnix /etc/nginx/sites-available/drivepod-ngnix
   ```

2. Enable the site:
   ```bash
   sudo ln -s /etc/nginx/sites-available/drivepod-ngnix /etc/nginx/sites-enabled/
   sudo rm -f /etc/nginx/sites-enabled/default   # optional – removes default site
   ```

3. Test config and restart Nginx:
   ```bash
   sudo nginx -t
   sudo systemctl restart nginx
   ```

**What this config does:**
- Serves the Angular frontend from `/var/www/drivepod`
- Proxies `/api/` requests to the backend running on port 3000
- Serves `/cache/` (MP3s + thumbnails) directly from `/var/www/cache` with proper CORS headers

### 4. Frontend Deployment
Use the included **`deploy-frontend.sh`** script (in the repository root):

```bash
cd /root/drivepod
chmod +x deploy-frontend.sh
./deploy-frontend.sh
```

**What the script does:**
- Builds the Angular app in production mode (`ng build --configuration production`)
- Copies the output to `/var/www/drivepod/`
- Sets correct permissions for Nginx (`www-data:www-data`)
- Restarts Nginx

After deployment, open **http://hostname-or-ip-address** (or your server’s IP).

---

## 📱 Running the App (Development)

1. Start backend (PM2 or `npx ts-node server.ts`)
2. In another terminal:
   ```bash
   cd frontend
   ng serve
   ```
3. Open **http://localhost:4200**

---

## 🔧 Configuration

All settings are stored in the database and editable in the **Settings** tab:
- Harvest window (default 7 days)
- Audio bitrate (32–192 kbps)
- Mono audio toggle
- Custom User-Agent
- YouTube `cookies.txt` upload
- Auto-purge old content
- One-per-x-hours rate limiting
- Duration filtering (min/max video length)
- Alternative metadata scraping (Videos/Streams/Shorts tabs)
- 5-way autoplay modes (newest, newer, older, oldest, off)
- Low bandwidth mode (disables thumbnails)
- Smart playlist loading and auto-refresh
- Progress tracking and resume functionality

---

## 🗂️ Project Structure

```
drivepod/
├── backend/
│   ├── ... (Node.js boilerplate)
│   ├── ecosystem.config.js     ← PM2 configuration
│   ├── src/server.ts           ← Harvesting daemon and API server
│   ├── prisma/schema.prisma    ← Database schema
├── frontend/
│   └── ... (Angular source)
├── deploy-frontend.sh          ← Production frontend deploy script
├── docker-compose.yml          ← Docker configuration
├── Dockerfile                  ← Docker build file
├── drivepod-ngnix              ← Nginx config (copy to /etc/nginx/sites-available/)
├── screenshots/                ← Example screenshots for README.md
├── cache/                      ← Downloaded audio cache (automatically created)
├── data/                       ← Database and configuration data
│   └── database.db             ← SQLite database created by Prisma
└── ... (other files and folders)
```

---

## 🧪 API Endpoints (for advanced users)

| Method | Endpoint                        | Description                     |
|--------|----------------------------------|---------------------------------|
| GET    | `/api/channels`                 | Monitored channels              |
| POST   | `/api/channels`                 | Add channel                     |
| POST   | `/api/channels/import`          | Bulk import                     |
| POST   | `/api/channels/reorder`         | Update priority order           |
| GET    | `/api/harvest-status`           | Live harvest progress           |
| POST   | `/api/config`                   | Save settings                   |
| POST   | `/api/cookies`                  | Upload cookies.txt              |
| GET    | `/api/stream/:videoId`          | Stream MP3                      |
| POST   | `/api/purge-all`                | Delete all cached data          |
| DELETE | `/api/channels/:channelId`      | Delete channel                  |
| GET    | `/api/player/current`           | Get current playing video       |
| PATCH  | `/api/player/current`           | Set current playing video       |
| PATCH  | `/api/video/:videoId/progress`  | Update video progress           |
| GET    | `/api/video/:videoId/progress`  | Get video progress              |
| POST   | `/api/video/:videoId/watched`   | Mark video as watched           |
| GET    | `/api/stats`                    | System statistics               |

---

## 🔒 Privacy & Security

- Everything runs **locally** on your machine/server
- No data sent to third parties (except YouTube via yt-dlp)
- Cookies are stored in the DB and only written temporarily during harvest
- Auto-clears expired/invalid cookies
- Index files maintain cache content item data without exposing private information
- Secure handling of video metadata and progress tracking
- No persistent logging of user preferences or activity
- Media session integration with device-level controls

---

## 🚀 Potential Enhancements

### Major Features
- [ ] **PWA Support** - Progressive Web App capabilities for offline audio access and mobile installation
- [ ] **User Authentication** - Multi-user support with separate playlists and settings
- [ ] **Advanced Metadata** - Custom tagging, episode descriptions, content tags, channel tags, and content categorization
- [ ] **Smart Play** - User-behavior-based automatic content prioritization
- [ ] **Scheduled Processing** - ability to limit via user-scheduled downloading windows
- [ ] **Relaxed Processing** - Alternative "On-Demand" downloading/transcoding

### Minor Features
- [ ] **Theme Toggle** - Light/dark theme switching
- [ ] **Audio EQ** - Equalizer controls for audio customization
- [ ] **Smarter Harvesting** - metered-unmetered data connection sensitivity
- [ ] **Backup/Restore** - Database backup and restoration capabilities
- [ ] **Accessibility** - Improved screen reader and keyboard navigation support

### Completed Features
- [x] Offline play
- [x] unhardcode /root
- [x] Mobile PWA support
- [x] Docker + docker-compose
- [x] WebSocket live updates
- [x] 56K modem optimization
- [x] Enhanced metadata handling
- [x] fallback content discovery method
- [x] Auto-purge optimization
- [x] Progress bar improvements
- [x] Responsive UI design
- [x] Audio session API integration

## 📈 Project Evolution

The DrivePod project has evolved significantly since its initial commit:

### Initial Version (April 10, 2026)
- Basic YouTube-to-Audio conversion system
- Angular frontend with basic layout
- Node.js/Express backend with SQLite database
- Simple RSS feed harvesting

### Key Improvements Phase (April 11-15, 2026)
- Added Docker support and production deployment scripts
- Implemented 56K modem optimization with compression
- Introduced infinite scroll and pagination for large playlists
- Added Media Session API integration
- Enhanced UI with responsive design

### Backend Optimizations Phase (April 12-23, 2026)
- Improved metadata fetching with fallback methods
- Enhanced database performance with indexing
- Added batch processing for efficient database operations
- Implemented automatic cleanup of corrupted files
- Added rate limiting for harvesting

### Advanced Features Phase (April 23, 2026)
- Smart autoplay with 5 modes
- Enhanced error handling and logging
- Improved progress tracking
- Alternative metadata scraping methods
- Performance optimizations for large playlists

### Final Improvements (May 8, 2026)
- Index file maintenance for cache content items
- Refinement of the entire architecture
- Continuous bug fixes and stability improvements

## 🙏 Acknowledgments

- **yt-dlp** — The best YouTube downloader in existence
- **Prisma** — Amazing ORM for SQLite
- **Angular** — For the sleek UI
- **Tailwind CSS** — Rapid beautiful styling

---

## 📄 License

MIT License — feel free to fork, modify, and self-host!

---

**Made with ❤️ for road warriors, podcast addicts, and YouTube hoarders.**

Star ⭐ the repo if you love it — and share your setup!

## 📝 Contributing

We welcome contributions to enhance DrivePod. Please consider implementing some of the future enhancements listed above or suggest new ideas. Contributions can include features, bug fixes, documentation improvements, or performance optimizations.
