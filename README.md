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

---

## ✨ Features

### Core Functionality
- **Smart Channel Harvesting** — Monitors multiple YouTube channels with **priority ordering** (top = highest priority)
- **Dual RSS + yt-dlp Fallback** — Ultra-reliable video discovery (live RSS + scraping Videos/Streams/Shorts tabs)
- **High-Quality Audio** — Downloads best audio → transcodes to MP3 with configurable bitrate (32–192 kbps) and optional mono
- **Cookie Support** — Handles age-restricted, private, and member-only videos (upload your `cookies.txt`)
- **Auto-Purge** — Automatically deletes content older than X days
- **Progress & Resume** — Saves listening progress and resumes exactly where you left off

### Frontend (Angular)
- **Queue Tab** — Clean playlist with thumbnails, publish dates, and YouTube links
- **Live Harvest Tab** — Real-time progress with concurrent channel tracking
- **Settings Tab** — Bitrate, mono toggle, harvest window, User-Agent, auto-purge
- **Import Tab** — Bulk import channel IDs
- **Compact Bottom Player** — Always-visible mini-player with Media Session API (phone/car integration)
- **Channel Reordering** — Drag-like priority controls (↑↑ ↑ ↓ ↓↓)

### Backend (Node.js)
- **Background Cron** — Harvests every 5 minutes automatically
- **Concurrent Processing** — Up to 3 channels at once
- **Robust Cleanup** — Detects and removes corrupted downloads
- **SQLite + Prisma** — Lightweight, zero-config database
- **Media Session** — Play/pause/next from phone lockscreen or car controls

---

## 🛠️ Tech Stack

| Layer       | Technology                          |
|-------------|-------------------------------------|
| **Frontend** | Angular (standalone component) + Tailwind |
| **Backend**  | Node.js + Express + TypeScript     |
| **Database** | Prisma + SQLite                     |
| **Download** | yt-dlp + ffmpeg                     |
| **Parsing**  | rss-parser                          |
| **UI**       | Modern dark theme, fully responsive |

---

## 📦 Installation

### Prerequisites
- Node.js 18+
- npm/yarn/pnpm
- yt-dlp (`sudo wget https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -O /usr/local/bin/yt-dlp && chmod a+rx /usr/local/bin/yt-dlp`)
- ffmpeg (`sudo apt install ffmpeg` or equivalent)
- Angular CLI (`npm install -g @angular/cli`)
- Nginx (for production)

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
├── LICENSE                     ← MIT license
├── README.md                   ← This file
├── drivepod-ngnix              ← Nginx config (copy to /etc/nginx/sites-available/)
├── screenshots/                ← Example screenshots for README.md
└── data/
    └── database.db             ← Created by `npx prisma db push`
```

---

## 🧪 API Endpoints (for advanced users)

| Method | Endpoint                        | Description                     |
|--------|---------------------------------|---------------------------------|
| GET    | `/api/playlist`                | Current unwatched videos       |
| GET    | `/api/channels`                | Monitored channels             |
| POST   | `/api/channels`                | Add channel                    |
| POST   | `/api/channels/import`         | Bulk import                    |
| POST   | `/api/channels/reorder`        | Update priority order          |
| GET    | `/api/harvest-status`          | Live harvest progress          |
| POST   | `/api/config`                  | Save settings                  |
| POST   | `/api/cookies`                 | Upload cookies.txt             |
| GET    | `/api/stream/:videoId`         | Stream MP3                     |

---

## 🔒 Privacy & Security

- Everything runs **locally** on your machine/server
- No data sent to third parties (except YouTube via yt-dlp)
- Cookies are stored in the DB and only written temporarily during harvest
- Auto-clears expired/invalid cookies

---

## 🚀 Roadmap

- [ ] Offline play
- [ ] unhardcode /root
- [ ] Mobile PWA support
- [ ] Docker + docker-compose
- [ ] WebSocket live updates
- [ ] Search within queue

---

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
