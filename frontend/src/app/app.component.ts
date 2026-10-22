import { Component, signal, OnInit, effect, OnDestroy, AfterViewInit, ViewChild, ElementRef, inject, NgZone } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Title } from '@angular/platform-browser';

interface Video {
  id: string;
  videoId: string;
  title: string;
  channel: { title: string };
  publishedAt: string;
  thumbnailPath: string | null;
  progress: number;
  duration?: number;
  protected: boolean;
  watched: boolean;
  ignored: boolean;
  isGrabby: boolean;
}

interface Channel {
  id: string;
  channelId: string;
  title: string;
  order: number;
  ignoreScrapeDone: boolean;
  active: boolean;
  minDuration: number | null;
  maxDuration: number | null;
  createdAt: string;
}

interface Config {
  maxHarvestDays: number;
  preferredBitrate: number;
  preferredMono: boolean;
  autoPurgeDays: number;
  userAgent: string;
  hasCookies: boolean;
  lastPlayedVideoId?: string | null;
  limitEnabled: boolean;
  limitVideos: number;
  limitHours: number;
  alternativeMetadataEnabled: boolean;
  scrapeVideosTab: boolean;
  scrapeStreamsTab: boolean;
  scrapeShortsTab: boolean;
  // NEW: DB-backed global duration filter
  durationFilterEnabled: boolean;
  minDurationMinutes: number;
  maxDurationMinutes: number;
  // NEW: GrabbyTube shufflebag mix
  grabbyMixEnabled: boolean;
  grabbyMixRatio: number;
  grabbyClusterMaxSize: number;
}

interface ImportResult {
  input: string;
  type: 'channel' | 'video';
  status: 'added' | 'skipped' | 'failed';
  title?: string;
  channelTitle?: string;
  channelId?: string;
  reason?: string;
}

interface HarvestStatus {
  isRunning: boolean;
  startTime: string | null;
  activeItems: Array<{
    channelId: string;
    channelTitle: string;
    videoId: string | null;
    videoTitle: string | null;
    action: string;
    startedAt: string;
  }>;
  processedVideos: number;
  totalVideosThisRun: number;
  channelsProcessed: number;
  totalChannels: number;
  lastUpdate: string | null;
  session?: { state: string; ts: number | null; fresh: boolean };
}

@Component({
  selector: 'app-main',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './app.component.html',
  styleUrls: []
})
export class AppComponent implements OnInit, AfterViewInit, OnDestroy {
  /** Global hotkey that consumes the current GrabbyTube track (see consumeGrabbyTrack). */
  static readonly GRABBY_DELETE_KEY = 'Delete';

  apiUrl = '/api';
  channels = signal<any[]>([]);
  playlist = signal<Video[]>([]);
  currentVideo = signal<Video | null>(null);
  audio = new Audio();
  currentTime = signal(0);
  isScrubbing = signal(false);

  // Config
  maxHarvestDays = signal(7);
  preferredBitrate = signal(128);
  preferredMono = signal(false);
  limitEnabled = signal(false);
  limitVideos = signal(2);
  limitHours = signal(6);
  autoPurgeDays = signal(30);
  userAgent = signal('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36');
  hasCookies = signal(false);
  currentVideoId = signal<string | null>(null);

  // NEW: Alternative metadata fetch method configuration (global + per-tab)
  alternativeMetadataEnabled = signal(true);
  scrapeVideosTab = signal(true);
  scrapeStreamsTab = signal(true);
  scrapeShortsTab = signal(true);

  // NEW: DB-backed global duration filter (optional, default disabled, max default = 12 hours = 720 minutes)
  durationFilterEnabled = signal(false);
  minDurationMinutes = signal(0);
  maxDurationMinutes = signal(720);

  // NEW: GrabbyTube shufflebag mix toggle
  grabbyMixEnabled = signal(true);
  grabbyMixRatio = signal(3);
  grabbyClusterMaxSize = signal(0);

  // 56K MODEM OPTIMIZATIONS
   lowBandwidthMode = signal(false);

   // 5-WAY AUTOPLAY MODE
   autoplayMode = signal<'newest' | 'newer' | 'older' | 'oldest' | 'off'>('newest');

   // SKIP MARKS WATCHED: treat skip-next as if the track finished playing
   skipMarksWatched = signal(false);

  private readonly APP_VERSION = '1.9.0';

  activeTab = signal<'queue' | 'harvest' | 'settings' | 'import' | 'protected' | 'watched'>('queue');
  protectedPlaylist = signal<Video[]>([]);
  watchedPlaylist = signal<Video[]>([]);

  importResults = signal<ImportResult[]>([]);
  isImporting = signal(false);

  harvestStatus = signal<HarvestStatus>({
    isRunning: false,
    startTime: null,
    activeItems: [],
    processedVideos: 0,
    totalVideosThisRun: 0,
    channelsProcessed: 0,
    totalChannels: 0,
    lastUpdate: null,
    session: { state: 'unknown', ts: null, fresh: false }
  });

  // Index-based client-side paging
  rawIndex = signal<Video[]>([]);
  readonly PAGE_SIZE = 20;
  isLoadingMore = signal(false);
  hasMore = signal(true);

  private queuePage = 0;

  @ViewChild('loadMoreTrigger') loadMoreTrigger!: ElementRef<HTMLDivElement>;
  private observer: IntersectionObserver | null = null;

  editingChannelId = signal<string | null>(null);
  editTitle = signal('');
  editingDurationChannelId = signal<string | null>(null);
  editDurationMin = signal<number | null>(null);
  editDurationMax = signal<number | null>(null);

  private defaultPageTitle = 'YT Drive Audio Queue';
  private lastProgressSave = 0;
  private readonly PROGRESS_SAVE_INTERVAL = 10000;

  private lastSavedVideoId: string | null = null;
  private lastSavedProgress: number = -1;

  private saveDebounceTimer: any = null;
  private harvestPollInterval: any = null;
  private playlistRefreshInterval: any = null;

  // Network resilience: operation queue with exponential-backoff retry
  private pendingVideoOps: Array<{ videoId: string; type: 'watched' | 'progress'; payload?: any }> = [];
  private retryTimer: any = null;
  private retryAttempts = 0;
  private readonly MAX_RETRY_ATTEMPTS = 10;
  private readonly BASE_RETRY_DELAY = 2000;

  // Active connectivity probe: pings backend every 3s while ops are pending
  private connectivityProbeTimer: any = null;
  private readonly PROBE_INTERVAL = 3000;

  // Index fetch reachability: track whether backend is online for index polling
  private backendOnline = true;
  private indexFetchPending = false;

  // Playback retry state (HEAD probe before play)
  private _playRetryTimer: any = null;
  private _playRetryCount = 0;
  private readonly BASE_PLAY_RETRY_DELAY = 3000;
  private readonly MAX_PLAY_RETRY_DELAY = 30000;
  private readonly PLAY_RETRY_MULTIPLIER = 1.5;

  // Bounded failure count for tracks that exist on the server (HEAD 200)
  // but the <audio> element cannot play (corrupt cache file). Without a
  // bound, error handlers reload the same file forever and jam the player
  // on one unplayable track (observed: ~200 req/s error loop).
  private _trackPlayFailures = new Map<string, number>();
  private readonly MAX_TRACK_PLAY_FAILURES = 2;

  // Always-on connectivity probe for playback recovery
  private alwaysOnProbeTimer: any = null;
  private readonly ALWAYS_ON_PROBE_INTERVAL = 5000;
  private _consecutiveProbeFails = 0;
  // Outage bookkeeping: snapshot of playback state at the moment the
  // connection was lost. Used to decide whether to auto-resume on recovery —
  // a track the user had paused must stay paused.
  private _dropInProgress = false;
  private _wasPlayingBeforeDrop = false;
  private initialAutoplayAttempted = false;

  // videoIds we marked watched client-side but whose POST may still be queued
  // for retry (network blackholes). Index refetches must keep these out of the
  // queue until the server has persisted watched=true.
  private _localWatched: Set<string> = new Set();

  // NEW: MediaSession realtime position tracking (for Ford Sync car display)
  private lastPositionUpdate = 0;
  private readonly POSITION_UPDATE_INTERVAL = 1800;

  constructor(
    private http: HttpClient,
    private titleService: Title,
    private zone: NgZone
  ) {
    effect(() => {
      this.updateMediaSession(this.currentVideo());
    });
    // Stop audio whenever player becomes visually hidden (currentVideo -> null)
    effect(() => {
      const video = this.currentVideo();
      if (!video && this.audio.src) {
        this.audio.pause();
        this.audio.src = '';
        this.setMediaPlaybackState('none');
      }
    });
  }

  ngOnInit() {
    console.log(`%c DrivePod Frontend v${this.APP_VERSION}`, 'font-weight: bold; color: #22c55e; font-size: 13px');

    this.titleService.setTitle(this.defaultPageTitle);
    this.activeTab.set('queue');
    this.protectedPlaylist.set([]);

    this.loadChannels();

    const savedLowBW = localStorage.getItem('drivepod-lowBandwidth');
     if (savedLowBW !== null) this.lowBandwidthMode.set(savedLowBW === 'true');

     // Skip marks watched
     const savedSkipWatched = localStorage.getItem('drivepod-skipMarksWatched');
     if (savedSkipWatched !== null) this.skipMarksWatched.set(savedSkipWatched === 'true');

     // Autoplay mode migration
    const savedMode = localStorage.getItem('drivepod-autoplayMode');
    let targetMode: 'newest' | 'newer' | 'older' | 'oldest' | 'off' = 'newest';
    if (savedMode === 'next') targetMode = 'older';
    else if (savedMode === 'none') targetMode = 'off';
    else if (['newest', 'newer', 'older', 'oldest', 'off'].includes(savedMode || '')) {
      targetMode = savedMode as 'newest' | 'newer' | 'older' | 'oldest' | 'off';
    }
    this.autoplayMode.set(targetMode);
    if (savedMode && savedMode !== targetMode) {
      localStorage.setItem('drivepod-autoplayMode', targetMode);
    }

    // Load the full index first
    this.loadIndex();

    // Load config in parallel
    this.http.get<Config>(`${this.apiUrl}/config`).subscribe({
      next: (config) => {
        this.maxHarvestDays.set(config.maxHarvestDays);
        this.preferredBitrate.set(config.preferredBitrate);
        this.preferredMono.set(config.preferredMono);
        this.limitEnabled.set(config.limitEnabled ?? false);
        this.limitVideos.set(config.limitVideos ?? 2);
        this.limitHours.set(config.limitHours ?? 6);
        this.autoPurgeDays.set(config.autoPurgeDays);
        this.userAgent.set(config.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36');
        this.hasCookies.set(!!config.hasCookies);
        this.currentVideoId.set(config.lastPlayedVideoId || null);

        // NEW: Load alternative metadata settings
        this.alternativeMetadataEnabled.set(config.alternativeMetadataEnabled ?? true);
        this.scrapeVideosTab.set(config.scrapeVideosTab ?? true);
        this.scrapeStreamsTab.set(config.scrapeStreamsTab ?? true);
        this.scrapeShortsTab.set(config.scrapeShortsTab ?? true);

        // NEW: Load duration filter settings
        this.durationFilterEnabled.set(config.durationFilterEnabled ?? false);
        this.minDurationMinutes.set(config.minDurationMinutes ?? 0);
        this.maxDurationMinutes.set(config.maxDurationMinutes ?? 720);

        // NEW: Load GrabbyTube shufflebag mix
        this.grabbyMixEnabled.set(config.grabbyMixEnabled ?? true);
        this.grabbyMixRatio.set(config.grabbyMixRatio ?? 3);
        this.grabbyClusterMaxSize.set(config.grabbyClusterMaxSize ?? 0);

        // Derive initial playlists from index if already loaded
        if (this.rawIndex().length > 0) {
          this.derivePlaylists();
        }
      },
      error: () => {
        // Config failed — still derive playlists from index if loaded
        if (this.rawIndex().length > 0) {
          this.derivePlaylists();
        }
      }
    });

    this.audio.ontimeupdate = () => {
      this.currentTime.set(this.audio.currentTime);
      this.throttledSaveProgress();
      this.throttledUpdateMediaPosition();
    };

    this.setupProgressListeners();
    this.setupMediaSessionHandlers();


    // Poll index.json every 2 minutes for new content
    this.playlistRefreshInterval = setInterval(() => this.loadIndex(), 120000);

    // Always-on connectivity probe for playback recovery
    this.startAlwaysOnProbe();
  }

  ngAfterViewInit() {
    this.setupInfiniteScroll();
    this.setupKeyboardShortcuts();
  }

  ngOnDestroy() {
    this.cleanup();
  }

  private cleanup() {
    // Stop audio player
    this.audio.pause();
    this.audio.src = '';
    this.audio.load();

    // Clear all intervals and timers
    if (this.observer) this.observer.disconnect();
    this.stopHarvestPolling();
    if (this.saveDebounceTimer) clearTimeout(this.saveDebounceTimer);
    if (this.playlistRefreshInterval) clearInterval(this.playlistRefreshInterval);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.connectivityProbeTimer) clearInterval(this.connectivityProbeTimer);
    this.connectivityProbeTimer = null;
    this._stopAlwaysOnProbe();
    this._clearPlayRetry();
    this.pendingVideoOps = [];
    this._dropInProgress = false;
    this._wasPlayingBeforeDrop = false;

    // Remove event listeners
    window.removeEventListener('beforeunload', this.handleBeforeUnload.bind(this));
    window.removeEventListener('keydown', this.handleKeyboardShortcut.bind(this));
    window.removeEventListener('online', this.handleOnline.bind(this));
  }

  private setupKeyboardShortcuts(): void {
    window.addEventListener('keydown', this.handleKeyboardShortcut.bind(this));
  }

  private handleKeyboardShortcut(event: KeyboardEvent) {
    // Don't hijack keys while typing in a form field (search, settings inputs, etc.)
    const t = event.target as HTMLElement;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;

    if (event.key === 'ArrowLeft') {
      if (this.audio && this.audio.duration && !isNaN(this.audio.duration)) {
        this.audio.currentTime = Math.max(0, this.audio.currentTime - 10);
        event.preventDefault();
      }
    } else if (event.key === 'ArrowRight') {
      if (this.audio && this.audio.duration && !isNaN(this.audio.duration)) {
        this.audio.currentTime = Math.min(this.audio.duration, this.audio.currentTime + 10);
        event.preventDefault();
      }
    } else if (event.key === AppComponent.GRABBY_DELETE_KEY) {
      const v = this.currentVideo();
      if (v && v.isGrabby) {
        event.preventDefault();
        this.consumeGrabbyTrack(v.videoId);
      }
    }
  }

  /** GrabbyTube-only control: mark the track played and permanently delete it
   *  from GrabbyTube (remote catalog + files). Shared by the 🗑️ button and
   *  the Delete hotkey so behavior can never diverge. */
  consumeGrabbyTrack(videoId: string) {
    this.http.delete(`${this.apiUrl}/video/${videoId}/grabby`).subscribe({
      next: () => {
        // DB record already deleted server-side; advance like track completion.
        // (The fire-and-forget POST /watched inside is a harmless no-op on the
        // deleted record — it returns 200 and triggers no retry loop.)
        this.markAsWatchedAndPlayNext();
      },
      error: (err: any) => {
        alert(err?.error?.error || err?.message || 'Delete failed — try again');
      }
    });
  }

  // === Index-based client-side paging ===

  /** Fetch the index + progress overlay from nginx and derive all playlist signals. */
  private loadIndex(): void {
    // If backend is unreachable, defer the fetch until connectivity returns
    if (!this.backendOnline) {
      this.indexFetchPending = true;
      return;
    }

    this.fetchIndexWithProgress()
      .then((data: Video[]) => {
        this.backendOnline = true;
        this.indexFetchPending = false;

        const merged = this.mergeIndexWithLocal(data);

        this.rawIndex.set(merged);
        this.derivePlaylists();

        // Trigger autoplay on first successful index load
        if (!this.initialAutoplayAttempted) {
          this.initialAutoplayAttempted = true;
          this._attemptInitialAutoplay();
        }
      })
      .catch(err => {
        this.backendOnline = false;
        this.indexFetchPending = true;
        console.error('Failed to load index.json — backend offline, deferring', err);
        this.startConnectivityProbe();
      });
  }

  /**
   * Fetch the playlist index and the small live-progress overlay in parallel.
   *
   * index.json is the authoritative track list with `progress` zeroed, so it
   * stays byte-stable and 304s while a track plays; progress.json carries
   * only the in-queue items with 0 < progress < duration (a few hundred
   * bytes). Both use stable URL + no-cache (revalidate): nginx sends an ETag
   * per file state, so an unchanged file is a free 304 (~0 bytes) and any
   * regenerated file changes the ETag so the new version is always
   * downloaded. A 304 revalidation surfaces to fetch() as a 200 with the
   * cached body.
   *
   * progress.json is best-effort: a 404 (first boot) or a failed fetch just
   * means resume positions read 0 until the next poll.
   */
  private fetchIndexWithProgress(): Promise<Video[]> {
    return Promise.all([
      fetch(`/cache/index.json`, { cache: 'no-cache' })
        .then(res => {
          if (!res.ok) throw new Error(`index.json ${res.status}`);
          return res.json() as Promise<Video[]>;
        }),
      fetch(`/cache/progress.json`, { cache: 'no-cache' })
        .then(res =>
          res.ok
            ? (res.json() as Promise<{ videoId: string; progress: number }[]>)
            : Promise.resolve([] as { videoId: string; progress: number }[]))
        .catch(() => [] as { videoId: string; progress: number }[])
    ]).then(([data, progress]) => {
      if (progress.length) {
        const byId: Record<string, number> = {};
        for (const p of progress) byId[p.videoId] = p.progress;
        for (const v of data) {
          const p = byId[v.videoId];
          if (p != null) v.progress = p;
        }
      }
      return data;
    });
  }

  /**
   * Merge locally-known state into a freshly fetched index.
   *
   * Watched: the server index is authoritative, EXCEPT for videos we just marked
   * watched client-side whose POST is still queued for retry (network blackhole).
   * Without the _localWatched guard, a refresh between the local mark and the
   * persisted server write re-surfaces the video in the queue.
   *
   * Progress: local (the last known position on this device) wins when
   * non-zero — for the track playing here the live audio position is the
   * freshest; otherwise the server value (index + progress.json overlay)
   * applies.
   */
  private mergeIndexWithLocal(data: Video[]): Video[] {
    const oldQueue = this.playlist();
    const oldProtected = this.protectedPlaylist();
    const oldWatched = this.watchedPlaylist();
    const oldMap = new Map<string, Partial<Video>>();
    for (const v of [...oldQueue, ...oldProtected, ...oldWatched]) {
      oldMap.set(v.videoId, { progress: v.progress, watched: v.watched });
    }

    return data.map(v => {
      const local = oldMap.get(v.videoId);
      const pendingWatched = this._localWatched.has(v.videoId);
      const progress = local?.progress || v.progress || 0;
      const watched = pendingWatched || (local ? local.watched : false) || v.watched;
      return { ...v, progress, watched };
    });
  }

  /** Get all queue (unwatched, non-ignored) videos from index, sorted newest first. */
  private getQueueVideos(): Video[] {
    return this.rawIndex()
      .filter(v => !v.watched && !v.ignored)
      .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());
  }

  /** Get protected videos from index. */
  private getProtectedVideos(): Video[] {
    return this.rawIndex()
      .filter(v => v.protected && !v.ignored)
      .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());
  }

  /** Get watched videos from index. */
  private getWatchedVideos(): Video[] {
    return this.rawIndex()
      .filter(v => v.watched && !v.ignored)
      .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());
  }

  /** Derive all playlist signals from rawIndex. */
  private derivePlaylists(): void {
    this.queuePage = 0; // Reset on fresh index load to avoid stale page state
    const queue = this.getQueueVideos();
    this.updatePage(this.queuePage, queue, this.PAGE_SIZE, (page) => this.playlist.set(page));

    const protectedVids = this.getProtectedVideos();
    this.protectedPlaylist.set(protectedVids);

    const watchedVids = this.getWatchedVideos();
    this.watchedPlaylist.set(watchedVids);
  }

  /** Paginate a full list into a page. */
  private updatePage(page: number, items: Video[], pageSize: number, setter: (videos: Video[]) => void): void {
    const start = page * pageSize;
    const pageItems = items.slice(start, start + pageSize);
    setter(pageItems);
    this.hasMore.set(start + pageSize < items.length);
  }

  /** Load the next page of the queue playlist. */
  private loadMore(): void {
    if (this.isLoadingMore() || !this.hasMore()) return;
    const queue = this.getQueueVideos();
    if (queue.length === 0) return; // Guard: data not loaded yet (race with loadIndex)
    this.isLoadingMore.set(true);
    this.queuePage++;
    this.updatePage(this.queuePage, queue, this.PAGE_SIZE, (page) => {
      this.playlist.update(current => [...current, ...page]);
    });
    this.isLoadingMore.set(false);
  }

  /** Reset to first page of queue. */
  private resetQueuePage(): void {
    this.queuePage = 0;
    this.hasMore.set(true);
    const queue = this.getQueueVideos();
    this.updatePage(0, queue, this.PAGE_SIZE, (page) => this.playlist.set(page));
  }

  private setupInfiniteScroll() {
    if (this.observer) this.observer.disconnect();
    this.observer = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting && this.hasMore() && !this.isLoadingMore()) {
        this.loadMore();
      }
    }, { rootMargin: '400px' });

    if (this.loadMoreTrigger?.nativeElement) {
      this.observer.observe(this.loadMoreTrigger.nativeElement);
    }
  }

  private initializeCurrentVideo(videos: Video[]) {
    if (videos.length === 0) return;

    const savedId = this.currentVideoId();
    if (savedId) {
      const savedVideo = videos.find(v => v.videoId === savedId);
      if (savedVideo) {
        this.playVideo(savedVideo);
        return;
      }
    }

    this.playVideo(videos[0]);
  }

  private saveCurrentVideo(videoId: string | null) {
    this.currentVideoId.set(videoId);
    this.http.patch(`${this.apiUrl}/player/current`, { videoId }).subscribe({ error: () => {} });
  }

  // === Network resilience: operation queue with retry ===

  private queueOperation(op: { videoId: string; type: 'watched' | 'progress'; payload?: any }): void {
    // For progress, keep only the latest per videoId (dedup)
    if (op.type === 'progress') {
      this.pendingVideoOps = this.pendingVideoOps.filter(
        existing => existing.videoId !== op.videoId || existing.type !== 'progress'
      );
    }
    // For watched, skip if already queued
    if (op.type === 'watched' && this.pendingVideoOps.some(e => e.videoId === op.videoId && e.type === 'watched')) {
      return;
    }
    this.pendingVideoOps.push(op);
    this.startConnectivityProbe();
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    const delay = Math.min(this.BASE_RETRY_DELAY * Math.pow(2, this.retryAttempts), 60000);
    this.retryTimer = setTimeout(() => this.flushPendingOps(), delay);
  }

  private flushPendingOps(): void {
    if (this.pendingVideoOps.length === 0) {
      this.retryAttempts = 0;
      this.stopConnectivityProbe();
      return;
    }

    const op = this.pendingVideoOps[0];
    this.pendingVideoOps.shift();

    let req: any;
    if (op.type === 'watched') {
      req = this.http.post(`${this.apiUrl}/video/${op.videoId}/watched`, {});
    } else {
      req = this.http.patch(`${this.apiUrl}/video/${op.videoId}/progress`, op.payload || {});
    }

    req.subscribe({
      next: () => {
        this.retryAttempts = 0;
        this.flushPendingOps();
      },
      error: () => {
        this.retryAttempts++;
        if (this.retryAttempts >= this.MAX_RETRY_ATTEMPTS) {
          console.error(`Gave up on ${op.type} for ${op.videoId} after ${this.MAX_RETRY_ATTEMPTS} attempts`);
          this.flushPendingOps();
        } else {
          this.pendingVideoOps.unshift(op);
          // Probe handles retries now; don't re-schedule here
        }
      }
    });
  }

  // Active connectivity probe: polls backend every PROBE_INTERVAL while ops are pending
  // This is far more reliable than window.online which only fires once per NIC state change
  private startConnectivityProbe(): void {
    if (this.connectivityProbeTimer) return;
    this.connectivityProbeTimer = setInterval(() => {
      this.probeBackend();
    }, this.PROBE_INTERVAL);
  }

  /** Always-on connectivity probe for playback recovery (runs every 5s). */
  private startAlwaysOnProbe(): void {
    if (this.alwaysOnProbeTimer) return;
    this.alwaysOnProbeTimer = setInterval(() => {
      this._doConnectivityProbe();
    }, this.ALWAYS_ON_PROBE_INTERVAL);
  }

  private _stopAlwaysOnProbe(): void {
    if (this.alwaysOnProbeTimer) {
      clearInterval(this.alwaysOnProbeTimer);
      this.alwaysOnProbeTimer = null;
    }
  }

  /** Snapshot playback state the moment the connection is lost. */
  private _snapshotPlaybackStateOnDrop(): void {
    this._dropInProgress = true;
    // audio.error !== null means the element was mid-playback and got
    // interrupted by the drop (a paused element never enters an error state).
    this._wasPlayingBeforeDrop = !!this.currentVideo() && (!this.audio.paused || this.audio.error !== null);
  }

  /** Lightweight HEAD probe to check if backend is reachable. */
  private _doConnectivityProbe(): void {
    const probeHeaders: Record<string, string> = {};
    fetch(`${this.apiUrl}/config`, { method: 'HEAD', headers: probeHeaders })
      .then(res => {
        if (res.ok || res.status === 401) {
          if (this._consecutiveProbeFails > 0) {
            console.log(`Backend reachable again after ${this._consecutiveProbeFails} failures`);
            // Consume the outage snapshot before recovering so a second
            // spurious recovery path (window.online) can't double-trigger.
            const resumeAudio = this._dropInProgress && this._wasPlayingBeforeDrop;
            this._consecutiveProbeFails = 0;
            this._dropInProgress = false;
            this._wasPlayingBeforeDrop = false;
            this._resumePlaybackRetry();
            if (resumeAudio) this.recoverAudioPlayback();
          }
          if (this.pendingVideoOps.length > 0) {
            this.retryAttempts = 0;
            this.flushPendingOps();
          }
          if (this.indexFetchPending) {
            this.backendOnline = true;
            this.indexFetchPending = false;
            this.loadIndex();
          }
        } else {
          this._consecutiveProbeFails++;
          if (this._consecutiveProbeFails === 3) this._snapshotPlaybackStateOnDrop();
        }
      })
      .catch(() => {
        this._consecutiveProbeFails++;
        if (this._consecutiveProbeFails === 3) {
          console.warn('Backend unreachable (3 consecutive probe failures)');
          this._snapshotPlaybackStateOnDrop();
        }
      });
  }

  private stopConnectivityProbe(): void {
    if (this.connectivityProbeTimer) {
      clearInterval(this.connectivityProbeTimer);
      this.connectivityProbeTimer = null;
    }
  }

  private probeBackend(): void {
    if (this.pendingVideoOps.length === 0 && !this.indexFetchPending) {
      this.stopConnectivityProbe();
      return;
    }

    // Use fetch for a lightweight HEAD request -- include token so it doesn't 401
    const probeHeaders: Record<string, string> = {};
    fetch(`${this.apiUrl}/config`, { method: 'HEAD', headers: probeHeaders })
      .then(res => {
        if (res.ok) {
          console.log('Connection restored via probe -- flushing pending operations');
          const resumeAudio = this._dropInProgress && this._wasPlayingBeforeDrop;
          this.retryAttempts = 0;
          this._consecutiveProbeFails = 0;
          this._dropInProgress = false;
          this._wasPlayingBeforeDrop = false;
          this.flushPendingOps();
          // Restore audio if it was interrupted
          this._resumePlaybackRetry();
          if (resumeAudio) this.recoverAudioPlayback();
          // Flush deferred index fetch
          if (this.indexFetchPending) {
            this.backendOnline = true;
            this.indexFetchPending = false;
            this.loadIndex();
          }
        }
      })
      .catch(() => {
        // Still offline, probe will retry in PROBE_INTERVAL
      });
  }

  private handleOnline(): void {
    // window.online is unreliable -- it fires when the NIC comes up, not when internet works
    // The active probe handles real connectivity detection
    console.log('OS reports network online -- probing backend');
    // If the track was paused when the connection dropped, it must stay paused.
    const resumeAudio = this._dropInProgress && this._wasPlayingBeforeDrop;
    this.retryAttempts = 0;
    this._dropInProgress = false;
    this._wasPlayingBeforeDrop = false;
    this.probeBackend();
    // Restore audio playback if the current track was playing when the loss hit
    if (resumeAudio) this.recoverAudioPlayback();
    // Try fetching index if it was deferred
    if (this.indexFetchPending) {
      this.backendOnline = true;
      this.indexFetchPending = false;
      this.loadIndex();
    }
  }

  /**
   * After network loss, the <Audio> element can be in a terminal error state.
   * Re-load the current track so the element resets and can play again.
   */
  private recoverAudioPlayback(): void {
    const video = this.currentVideo();
    if (!video) return;

    // If audio is not in an error-like state (playing or fine), nothing to recover
    if (!this.audio.paused && this.audio.readyState >= 2) {
      return;
    }

    console.log('Network restored -- reloading audio for', video.videoId);
    // Re-load the same track. loadAndSeekVideo sets src + calls .load(),
    // and the onloadedmetadata handler seeks to the right position.
    this.loadAndSeekVideo(video);
    this.audio.play().catch(() => {});
  }

  private setupProgressListeners(): void {
    this.audio.onpause = () => {
      this.saveProgress(this.audio.currentTime);
      this.setMediaPlaybackState('paused');
    };

    this.audio.onended = () => {
      this.saveProgress(this.audio.currentTime || this.audio.duration || 0);
      this.markAsWatchedAndPlayNext();
      this.setMediaPlaybackState('paused');
    };

    this.audio.onerror = () => {
      // The error belongs to the src currently on the element — which may
      // differ from currentVideo if we already advanced past the failing
      // track. Stale errors for an abandoned track must be ignored.
      const m = /\/api\/stream\/([A-Za-z0-9_-]+)/.exec(this.audio.src);
      const videoId = m ? m[1] : (this.currentVideo()?.videoId ?? null);
      if (videoId) {
        console.warn('Audio playback error for', videoId, '-- probing');
        this._handleAudioError(videoId);
      } else {
        console.warn('Audio playback error (no current video)');
        this.setMediaPlaybackState('none');
      }
    };

    this.audio.onseeked = () => {
      this.isScrubbing.set(false);
      if (this.saveDebounceTimer) clearTimeout(this.saveDebounceTimer);

      this.saveDebounceTimer = setTimeout(() => {
        this.saveProgress(this.audio.currentTime);
        this.saveDebounceTimer = null;
      }, 300);
    };

    this.audio.onplay = () => this.setMediaPlaybackState('playing');

    // Successful playback clears any recorded failures for this track.
    this.audio.onplaying = () => {
      const video = this.currentVideo();
      if (video) this._trackPlayFailures.delete(video.videoId);
    };

    window.addEventListener('beforeunload', this.handleBeforeUnload.bind(this));
    window.addEventListener('online', this.handleOnline.bind(this));
  }

  private handleBeforeUnload(): void {
    if (this.currentVideo()) this.saveProgress(this.audio.currentTime);
  }

  private throttledSaveProgress(): void {
    if (!this.currentVideo() || this.isScrubbing()) return;
    const now = Date.now();
    if (now - this.lastProgressSave < this.PROGRESS_SAVE_INTERVAL) return;
    this.lastProgressSave = now;
    this.saveProgress(this.audio.currentTime);
  }

  private saveProgress(progress: number): void {
    const video = this.currentVideo();
    if (!video?.videoId) return;

    const progressInt = Math.floor(progress);

    if (video.videoId === this.lastSavedVideoId && progressInt === this.lastSavedProgress) {
      return;
    }

    this.lastSavedVideoId = video.videoId;
    this.lastSavedProgress = progressInt;

    this.http.patch(`${this.apiUrl}/video/${video.videoId}/progress`, {
      progress: progressInt
    }).subscribe({
      error: () => {
        // Queue for retry if offline
        this.queueOperation({ videoId: video.videoId, type: 'progress', payload: { progress: progressInt } });
      }
    });
  }

  onRangeInput(value: string | number) {
    this.isScrubbing.set(true);
    const time = Number(value);
    this.audio.currentTime = time;
    this.currentTime.set(time);
  }

  onRangeChange(value: string | number) {
    this.isScrubbing.set(false);
    const time = Number(value);
    this.audio.currentTime = time;
    this.currentTime.set(time);
    this.saveProgress(time);
    this.lastProgressSave = Date.now();
    this.updateMediaPositionState();
  }

  /**
   * Toggle play/pause with network-recovery fallback.
   * If the <Audio> element is stuck in a network error state, reload the track.
   */
  togglePlay() {
    // If player is visually hidden (no current video), stop audio
    if (!this.currentVideo()) {
      this.audio.pause();
      this.audio.src = '';
      this.setMediaPlaybackState('none');
      return;
    }
    if (this.audio.paused) {
      const promise = this.audio.play();
      // play() returns a rejected Promise silently when the element is in a network error
      if (promise !== undefined) {
        promise.catch(() => {
          // Audio element is likely stuck from a network drop — reload and retry
          const video = this.currentVideo();
          if (video) {
            console.log('Play failed — reloading audio for', video.videoId);
            this.loadAndSeekVideo(video);
            this.audio.play().catch(() => {});
          }
        });
      }
    } else {
      this.audio.pause();
    }
  }

  playVideo(video: Video) {
    this._tryPlay(video);
  }

  private loadAndSeekVideo(video: Video) {
    this.currentVideo.set(video);
    this.updatePageTitle(video);

    const monoStr = this.preferredMono() ? '-mono' : '';
    this.audio.src = `/api/stream/${video.videoId}?bitrate=${this.preferredBitrate()}${monoStr}`;

    const targetProgress = video.progress || 0;

    this.audio.onloadedmetadata = () => {
      if (targetProgress > 0) {
        if (targetProgress < (this.audio.duration || Infinity) * 0.98) {
          this.audio.currentTime = targetProgress;
          console.log(`Resumed ${video.videoId} from ${targetProgress.toFixed(1)}s`);
        }
      }
      this.updateMediaPositionState();
      this.setMediaPlaybackState('playing');
      this.audio.onloadedmetadata = null;
    };

    this.audio.load();
  }

  setAutoplayMode(mode: 'newest' | 'newer' | 'older' | 'oldest' | 'off') {
    this.autoplayMode.set(mode);
    localStorage.setItem('drivepod-autoplayMode', mode);
  }

  /**
   * Pick the next track for 'older'/'newer' autoplay. The finished track is
   * still in the list (rawIndex only changes on the next index load), so it
   * is excluded by videoId — which also allows <=/>= so same-timestamp
   * siblings (batched imports, grabby cluster bands) are not silently
   * skipped: with strict </> they could never be picked by autoplay.
   */
  private getCandidate(playlist: Video[], mode: 'newer' | 'older', finishedTime: number, finishedId: string): Video | undefined {
    if (mode === 'older') {
      return playlist.find(v => v.videoId !== finishedId && new Date(v.publishedAt).getTime() <= finishedTime);
    }
    if (mode === 'newer') {
      const newerOnes = playlist.filter(v => v.videoId !== finishedId && new Date(v.publishedAt).getTime() >= finishedTime);
      if (newerOnes.length > 0) return newerOnes[newerOnes.length - 1];
    }
    return undefined;
  }

  markAsWatchedAndPlayNext() {
    if (!this.currentVideo()) return;
    const finishedVideo = this.currentVideo()!;
    const finishedVideoId = finishedVideo.videoId;
    const finishedPublishedAt = new Date(finishedVideo.publishedAt).getTime();

    // Remember until the server confirms persistence (survives blackhole retries)
    this._localWatched.add(finishedVideoId);

    // Immediately update UI state -- do NOT wait for the network call
    // (clear currentVideo AFTER we know the next track, see below)
    this.updatePageTitle(null);

    // Remove finished video from playlist locally
    this.playlist.update(current => current.filter(v => v.videoId !== finishedVideoId));

    // Queue the watched mark for retry if needed
    this.queueOperation({ videoId: finishedVideoId, type: 'watched' });

    // Also try immediately (fire-and-forget -- retry handles the rest)
    this.http.post(`${this.apiUrl}/video/${finishedVideoId}/watched`, {})
      .subscribe({
        error: () => {
          // Already queued, no need to re-queue
        }
      });

    // Advance to next track regardless of network state
    const mode = this.autoplayMode();

    if (mode === 'off') {
      // Offline-safe: don't reload from server, just stop
      this.currentVideo.set(null);
      this.audio.pause();
      this.audio.src = '';
      this.setMediaPlaybackState('none');
      return;
    }

    if (mode === 'newest') {
      // Try to play from local cache first, fall back to server reload
      const localCandidate = this.playlist().length > 0 ? this.playlist()[0] : null;
      if (localCandidate) {
        this.currentVideo.set(null);
        this.playVideo(localCandidate);
        return;
      }
      // No local cache -- reload index and play when ready
      this.currentVideo.set(null);
      this._loadIndexAndPlay();
      return;
    }

    // newer/older/oldest modes
    const queue = this.getQueueVideos();
    let candidate: Video | undefined;

    if (mode === 'oldest') {
      if (queue.length > 0) {
        candidate = queue[queue.length - 1];
      }
    } else {
      candidate = this.getCandidate(queue, mode, finishedPublishedAt, finishedVideoId);
    }

    if (candidate) {
      this.currentVideo.set(null);
      this.playVideo(candidate);
      return;
    }

    // No local candidates — reload index and play when ready
    this.currentVideo.set(null);
    this._loadIndexAndPlay();
  }

  getVideoLinkUrl(video: Video): string {
    const t = Math.floor(this.audio.currentTime || 0);
    return `https://www.youtube.com/watch?v=${video.videoId}${t > 0 ? `&t=${t}s` : ''}`;
  }

  skipNext() {
     // When skipMarksWatched is enabled, treat skip as if the track just finished
     if (this.skipMarksWatched() && this.currentVideo()) {
       this.saveProgress(this.audio.duration || this.audio.currentTime || 0);
       this.markAsWatchedAndPlayNext();
       return;
     }

     const idx = this.playlist().findIndex(v => v.videoId === this.currentVideo()?.videoId);
     if (idx < this.playlist().length - 1) {
       // Stop current audio before probing next track (probe may fail offline)
       this.audio.pause();
       this.audio.src = '';
       this.playVideo(this.playlist()[idx + 1]);
     } else {
       this.currentVideo.set(null);
       this.updatePageTitle(null);
       this.saveCurrentVideo(null);
       this.resetQueuePage();
       // Stop audio when player is visually hidden
       this.audio.pause();
       this.audio.src = '';
       this.setMediaPlaybackState('none');
     }
   }

  skipPrevious() {
    if (!this.currentVideo()) return;

    const currentId = this.currentVideo()!.videoId;
    const playlist = this.playlist();
    const idx = playlist.findIndex(v => v.videoId === currentId);

    if (idx > 0) {
      // Stop current audio before probing previous track (probe may fail offline)
      this.audio.pause();
      this.audio.src = '';
      this.playVideo(playlist[idx - 1]);
    } else {
      this.audio.currentTime = 0;
      if (this.audio.paused) {
        this.audio.play();
        // Explicit play intent: a replay from the start should also resume
        // after a network drop, even if the track was paused before it.
        this._wasPlayingBeforeDrop = true;
      }
    }
  }

  loadChannels() {
    this.http.get<Channel[]>(`${this.apiUrl}/channels`).subscribe(data => {
      const list: Channel[] = Array.isArray(data) ? data : [];
      // GrabbyTube per-artist placeholder channels (UCGrabbyTube*) are not
      // harvest channels — hide them from Settings.
      this.channels.set(list.filter(c => !c.channelId.startsWith('UCGrabbyTube')));
    });
  }

  private refreshConfig() {
    this.http.get<Config>(`${this.apiUrl}/config`).subscribe(config => {
      this.hasCookies.set(!!config.hasCookies);
    });
  }

  private startHarvestPolling() {
    if (this.harvestPollInterval) return;
    this.harvestPollInterval = setInterval(() => {
      this.http.get<HarvestStatus>(`${this.apiUrl}/harvest-status`)
        .subscribe(status => this.harvestStatus.set(status));
    }, 4000);
  }

  private stopHarvestPolling() {
    if (this.harvestPollInterval) {
      clearInterval(this.harvestPollInterval);
      this.harvestPollInterval = null;
    }
  }

  private setupMediaSessionHandlers() {
    if (!('mediaSession' in navigator)) return;

    navigator.mediaSession.setActionHandler('play', () => {
      // Car head-unit play button is an explicit play intent —
      // mark it so a later network drop/resume restores playback.
      this._wasPlayingBeforeDrop = true;
      this.audio.play();
    });
    navigator.mediaSession.setActionHandler('pause', () => this.audio.pause());
    navigator.mediaSession.setActionHandler('nexttrack', () => this.skipNext());
    navigator.mediaSession.setActionHandler('previoustrack', () => this.skipPrevious());
  }

  private updateMediaSession(video: Video | null) {
    if (!('mediaSession' in navigator)) return;
    if (!video) {
      navigator.mediaSession.metadata = null;
      return;
    }
    navigator.mediaSession.metadata = new MediaMetadata({
      title: video.title,
      artist: video.channel.title,
      album: '',
      artwork: video.thumbnailPath ? [{ src: video.thumbnailPath, sizes: '320x180', type: 'image/jpeg' }] : []
    });

    setTimeout(() => this.updateMediaPositionState(), 100);
  }

  private updateMediaPositionState(): void {
    if (!('mediaSession' in navigator) || !this.audio) return;

    const video = this.currentVideo();
    let duration = this.audio.duration && isFinite(this.audio.duration) && !isNaN(this.audio.duration)
      ? this.audio.duration
      : (video ? video.duration : 0) || 0;

    duration = Math.floor(duration);

    if (duration <= 0) return;

    const rawPosition = Math.floor(this.audio.currentTime || 0);
    const position = Math.min(Math.max(0, rawPosition), duration);

    try {
      navigator.mediaSession.setPositionState({
        duration: duration,
        position: position,
        playbackRate: this.audio.playbackRate || 1.0
      });
    } catch (e) {
      console.debug('MediaSession setPositionState skipped', e);
    }
  }

  private throttledUpdateMediaPosition(): void {
    const now = Date.now();
    if (now - this.lastPositionUpdate < this.POSITION_UPDATE_INTERVAL) return;
    this.lastPositionUpdate = now;
    this.updateMediaPositionState();
  }

  private setMediaPlaybackState(state: 'playing' | 'paused' | 'none' = 'none'): void {
    if (!('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.playbackState = state;
    } catch (e) {}
  }


  // === Initial autoplay on page load ===

  /**
   * Attempt autoplay on page load. Handles browser autoplay policy gracefully.
   * Audio is loaded and ready; play() may be blocked until user gesture.
   */
  private _attemptInitialAutoplay(): void {
    const mode = this.autoplayMode();
    if (mode === 'off') return;

    const queue = this.getQueueVideos();
    if (queue.length === 0) return;

    let video: Video;
    const savedId = this.currentVideoId();

    if (savedId) {
      video = queue.find(v => v.videoId === savedId) || queue[0];
    } else if (mode === 'oldest') {
      video = queue[queue.length - 1];
    } else {
      video = queue[0];
    }

    // Set up the video in the audio element
    this.currentVideo.set(video);
    this.updatePageTitle(video);
    this.saveCurrentVideo(video.videoId);

    const monoStr = this.preferredMono() ? '-mono' : '';
    this.audio.src = `/api/stream/${video.videoId}?bitrate=${this.preferredBitrate()}${monoStr}`;

    const targetProgress = video.progress || 0;
    this.audio.onloadedmetadata = () => {
      if (targetProgress > 0 && targetProgress < (this.audio.duration || Infinity) * 0.98) {
        this.audio.currentTime = targetProgress;
      }
      this.updateMediaPositionState();
      this.setMediaPlaybackState('playing');
      this.audio.onloadedmetadata = null;
    };
    this.audio.load();

    // Attempt play — may be blocked by autoplay policy, which is fine
    const playPromise = this.audio.play();
    if (playPromise !== undefined) {
      playPromise.catch(err => {
        console.log('Autoplay blocked by browser policy — ready for user gesture', err.name);
        this.setMediaPlaybackState('paused');
      });
    }
  }

  // === Playback retry: HEAD probe before play ===

  /**
   * Probe the track before loading. If defunct (404), skip immediately.
   * If unreachable, enter indefinite retry loop. If OK, load and play.
   */
  private _tryPlay(video: Video): void {
    this._clearPlayRetry();
    // Set currentVideo before probing so _skipDefunctTrack can match it
    this.currentVideo.set(video);
    this.updatePageTitle(video);
    const headers: Record<string, string> = {};

    fetch(`/api/stream/${video.videoId}`, { method: 'HEAD', headers })
      .then(res => {
        if (res.ok) {
          this._loadAndPlay(video);
        } else if (res.status === 404) {
          console.warn(`Track ${video.videoId} is defunct (404) -- skipping`);
          this._skipDefunctTrack(video.videoId);
        } else {
          this._probeAndPlay(video);
        }
      })
      .catch(() => {
        this._probeAndPlay(video);
      });
  }

  /** Indefinite retry loop with exponential backoff. */
  private _probeAndPlay(video: Video): void {
    const headers: Record<string, string> = {};

    const delay = Math.min(
      this.BASE_PLAY_RETRY_DELAY * Math.pow(this.PLAY_RETRY_MULTIPLIER, this._playRetryCount),
      this.MAX_PLAY_RETRY_DELAY
    );

    this._playRetryTimer = setTimeout(() => {
      this._playRetryCount++;
      console.log(`Playback retry #${this._playRetryCount} for ${video.videoId} (delay ${delay}ms)`);

      fetch(`/api/stream/${video.videoId}`, { method: 'HEAD', headers })
        .then(res => {
          if (res.ok) {
            this._clearPlayRetry();
            this._loadAndPlay(video);
          } else if (res.status === 404) {
            this._clearPlayRetry();
            console.warn(`Track ${video.videoId} is defunct (404) -- skipping`);
            this._skipDefunctTrack(video.videoId);
          } else {
            this._probeAndPlay(video);
          }
        })
        .catch(() => {
          this._probeAndPlay(video);
        });
    }, delay);
  }

  /** Load the audio element and attempt to play. */
  private _loadAndPlay(video: Video): void {
    this.loadAndSeekVideo(video);
    this.saveCurrentVideo(video.videoId);

    const playPromise = this.audio.play();
    if (playPromise !== undefined) {
      playPromise.catch(err => {
        if (err.name === 'NotAllowedError') {
          console.log('Play blocked by autoplay policy for', video.videoId);
          this.setMediaPlaybackState('paused');
          return;
        }
        // Real error -- probe to decide
        const headers: Record<string, string> = {};

        fetch(`/api/stream/${video.videoId}`, { method: 'HEAD', headers })
          .then(res => {
            if (res.status === 404) {
              console.warn(`Track ${video.videoId} defunct after play reject -- skipping`);
              this._skipDefunctTrack(video.videoId);
            } else {
              console.log(`Play rejected for ${video.videoId} -- reloading audio`);
              this.loadAndSeekVideo(video);
              this.audio.play().catch(() => {
                fetch(`/api/stream/${video.videoId}`, { method: 'HEAD', headers })
                  .then(res2 => {
                    if (res2.status === 404 || res2.status >= 500) {
                      console.warn(`Track ${video.videoId} still failing -- stopping`);
                      this.currentVideo.set(null);
                      this.updatePageTitle(null);
                      this.audio.pause();
                      this.audio.src = '';
                      this.setMediaPlaybackState('none');
                      this.advanceToNextTrack();
                    } else if (res2.ok) {
                      // Bounded: the failure counter skips a track that keeps
                      // failing to load; otherwise one more reload attempt.
                      this._registerTrackPlayFailure(video.videoId);
                      const current = this.currentVideo();
                      if (current && current.videoId === video.videoId) {
                        this.loadAndSeekVideo(video);
                        this.audio.play().catch(() => {});
                      }
                    }
                  })
                  .catch(() => {
                    // Final probe failed -- stop and advance
                    console.warn(`Track ${video.videoId} probe failed -- stopping`);
                    this.currentVideo.set(null);
                    this.updatePageTitle(null);
                    this.audio.pause();
                    this.audio.src = '';
                    this.setMediaPlaybackState('none');
                    this.advanceToNextTrack();
                  });
              });
            }
          })
          .catch(() => {});
      });
    }
  }

  /** Called from audio.onerror. Probe to decide: skip (defunct) or retry (transient). */
  private _handleAudioError(videoId: string): void {
    if (this.currentVideo()?.videoId !== videoId) return;

    const headers: Record<string, string> = {};

    fetch(`/api/stream/${videoId}`, { method: 'HEAD', headers })
      .then(res => {
        if (res.status === 404) {
          console.warn(`Audio error: track ${videoId} is defunct -- skipping`);
          this._skipDefunctTrack(videoId);
        } else if (res.ok) {
          this._registerTrackPlayFailure(videoId);
          const video = this.currentVideo();
          // The register call may have already skipped the track (and
          // advanced) — only reload if this track is still current.
          if (video && video.videoId === videoId) {
            console.log(`Audio error: reloading ${videoId}`);
            this.loadAndSeekVideo(video);
            this.audio.play().catch(() => {});
          }
        }
      })
      .catch(() => {});
  }

  /**
   * Count a playback failure for a track the server says exists but the
   * <audio> element cannot play (corrupt cache file). After
   * MAX_TRACK_PLAY_FAILURES, treat it as broken: mark watched and advance
   * instead of reloading the same unplayable file forever.
   */
  private _registerTrackPlayFailure(videoId: string): void {
    const n = (this._trackPlayFailures.get(videoId) || 0) + 1;
    this._trackPlayFailures.set(videoId, n);
    if (n >= this.MAX_TRACK_PLAY_FAILURES) {
      this._trackPlayFailures.delete(videoId);
      console.warn(`Track ${videoId} failed to play ${n} times despite existing on the server -- skipping as broken`);
      this._skipDefunctTrack(videoId);
    }
  }

  /** Skip a defunct track: mark watched locally, remove from playlist, advance. */
  private _skipDefunctTrack(videoId: string): void {
    const finishedVideo = this.currentVideo();
    if (!finishedVideo || finishedVideo.videoId !== videoId) return;

    this._localWatched.add(videoId);

    this.currentVideo.set(null);
    this.updatePageTitle(null);
    this.playlist.update(current => current.filter(v => v.videoId !== videoId));

    this.queueOperation({ videoId, type: 'watched' });
    this.http.post(`${this.apiUrl}/video/${videoId}/watched`, {})
      .subscribe({ error: () => {} });

    const mode = this.autoplayMode();
    if (mode !== 'off') {
      this.advanceToNextTrack();
    }
  }

  /** Clear playback retry timer and reset counter. */
  private _clearPlayRetry(): void {
    if (this._playRetryTimer) {
      clearTimeout(this._playRetryTimer);
      this._playRetryTimer = null;
    }
    this._playRetryCount = 0;
  }

  /** Immediately fire a pending playback retry. */
  private _resumePlaybackRetry(): void {
    if (this._playRetryTimer) {
      clearTimeout(this._playRetryTimer);
      this._playRetryTimer = null;
      const video = this.currentVideo();
      if (video) {
        console.log('Connectivity restored -- immediate playback retry for', video.videoId);
        this._tryPlay(video);
      }
    }
  }

  /** Reload index and automatically play the first available track when ready. */
  private _loadIndexAndPlay(): void {
    if (!this.backendOnline) {
      this.indexFetchPending = true;
      return;
    }

    this.fetchIndexWithProgress()
      .then((data: Video[]) => {
        this.backendOnline = true;
        this.indexFetchPending = false;

        const merged = this.mergeIndexWithLocal(data);

        this.rawIndex.set(merged);
        this.derivePlaylists();

        const mode = this.autoplayMode();
        if (mode !== 'off') {
          const queue = this.getQueueVideos();
          if (queue.length > 0) {
            if (mode === 'oldest') {
              this.playVideo(queue[queue.length - 1]);
            } else {
              this.playVideo(queue[0]);
            }
          }
        }
      })
      .catch(err => {
        this.backendOnline = false;
        this.indexFetchPending = true;
        console.error('Failed to load index for autoplay', err);
      });
  }

  /** Advance to next track based on autoplay mode. */
  private advanceToNextTrack(): void {
    const mode = this.autoplayMode();
    if (mode === 'off') return;

    if (mode === 'newest') {
      const localCandidate = this.playlist().length > 0 ? this.playlist()[0] : null;
      if (localCandidate) {
        this.playVideo(localCandidate);
        return;
      }
      this._loadIndexAndPlay();
      return;
    }

    const queue = this.getQueueVideos();
    if (queue.length > 0) {
      if (mode === 'oldest') {
        this.playVideo(queue[queue.length - 1]);
      } else {
        this.playVideo(queue[0]);
      }
    } else {
      this._loadIndexAndPlay();
    }
}

  setTab(tab: 'queue' | 'harvest' | 'settings' | 'import' | 'protected' | 'watched') {
    this.activeTab.set(tab);
    if (tab !== 'import') this.importResults.set([]);

    if (tab === 'harvest') {
      this.startHarvestPolling();
    } else {
      this.stopHarvestPolling();
    }

    if (tab === 'queue') {
      this.resetQueuePage();
      setTimeout(() => this.setupInfiniteScroll(), 300);
    }

    if (tab === 'protected') {
      this.derivePlaylists();
    }

    if (tab === 'watched') {
      this.derivePlaylists();
    }
  }

  toggleWatched(videoId: string, watched: boolean) {
    this.http.patch(`${this.apiUrl}/video/${videoId}/watched`, { watched }).subscribe({
      next: () => {
        // Server persisted the change (and regenerated index.json) — the index
        // is authoritative again; drop any pending local-watched hold.
        this._localWatched.delete(videoId);
        if (!watched) {
          this.watchedPlaylist.update(current => current.filter(v => v.videoId !== videoId));
        }
      },
      error: (err) => console.error('Failed to toggle watched', err)
    });
  }

  private updatePageTitle(video: Video | null) {
    if (video) this.titleService.setTitle(`${video.channel.title} - ${video.title}`);
    else this.titleService.setTitle(this.defaultPageTitle);
  }

  saveConfig() {
    this.http.post(`${this.apiUrl}/config`, {
      maxHarvestDays: this.maxHarvestDays(),
      preferredBitrate: this.preferredBitrate(),
      preferredMono: this.preferredMono(),
      limitEnabled: this.limitEnabled(),
      limitVideos: this.limitVideos(),
      limitHours: this.limitHours(),
      autoPurgeDays: this.autoPurgeDays(),
      userAgent: this.userAgent(),
      alternativeMetadataEnabled: this.alternativeMetadataEnabled(),
      scrapeVideosTab: this.scrapeVideosTab(),
      scrapeStreamsTab: this.scrapeStreamsTab(),
      scrapeShortsTab: this.scrapeShortsTab(),
      // NEW duration filter
      durationFilterEnabled: this.durationFilterEnabled(),
      minDurationMinutes: this.minDurationMinutes(),
      maxDurationMinutes: this.maxDurationMinutes(),
      // NEW GrabbyTube shufflebag mix
      grabbyMixEnabled: this.grabbyMixEnabled(),
      grabbyMixRatio: this.grabbyMixRatio(),
      grabbyClusterMaxSize: this.grabbyClusterMaxSize()
    }).subscribe();
  }

  toggleLowBandwidth() {
      const newValue = !this.lowBandwidthMode();
      this.lowBandwidthMode.set(newValue);
      localStorage.setItem('drivepod-lowBandwidth', String(newValue));
    }

    toggleSkipMarksWatched() {
      const newValue = !this.skipMarksWatched();
      this.skipMarksWatched.set(newValue);
      localStorage.setItem('drivepod-skipMarksWatched', String(newValue));
    }

  onBitrateChange() { this.saveConfig(); }
  onMonoChange() { this.saveConfig(); }
  setGrabbyRatio(val: number) { this.grabbyMixRatio.set(Math.min(20, Math.max(1, val))); this.saveConfig(); }
  setGrabbyClusterMaxSize(val: number) { this.grabbyClusterMaxSize.set(Math.max(0, Math.floor(val))); this.saveConfig(); }

  startEditing(channelId: string, currentTitle: string) {
    this.editingChannelId.set(channelId);
    this.editTitle.set(currentTitle);
  }

  cancelEditing() {
    this.editingChannelId.set(null);
    this.editTitle.set('');
  }

  saveRename() {
    const channelId = this.editingChannelId();
    const newTitle = this.editTitle().trim();
    if (!channelId || !newTitle) {
      this.cancelEditing();
      return;
    }

    this.http.post(`${this.apiUrl}/channels`, { channelId, title: newTitle })
      .subscribe(() => {
        this.loadChannels();
        this.cancelEditing();
      });
  }

  uploadCookies(event: Event) {
    const input = event.target as HTMLInputElement;
    if (!input.files?.length) return;
    const file = input.files[0];
    const formData = new FormData();
    formData.append('cookies', file);

    this.http.post(`${this.apiUrl}/cookies`, formData).subscribe({
      next: () => {
        alert('cookies.txt uploaded successfully');
        this.refreshConfig();
      },
      error: () => alert('Failed to upload cookies.txt')
    });
  }

  clearCookies() {
    if (!confirm('Remove all saved YouTube cookies?')) return;
    this.http.post(`${this.apiUrl}/config`, { cookies: '' }).subscribe({
      next: () => {
        this.hasCookies.set(false);
        alert('Cookies have been cleared');
      },
      error: () => alert('Failed to clear cookies')
    });
  }

  onImageError(event: Event) {
    const img = event.target as HTMLImageElement;
    img.src = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iODAiIGhlaWdodD0iODAiIHZpZXdCb3g9IjAgMCA4MCA4MCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHJlY3Qgd2lkdGg9IjgwIiBoZWlnaHQ9IjgwIiByeD0iMTIiIGZpbGw9IiMyMjIiLz4KPHRleHQgeD0iNDAiIHk9IjQ1IiB0ZXh0LWFuY2hvcj0ibWlkZGxlIiBmaWxsPSIjYWFhIiBmb250LWZhbWlseT0ic3lzdGVtLXVpLC1hcHBsZS1zeXN0ZW0sU2Vnb2UgVUkiIGZvbnQtc2l6ZT0iMTIiIGZvbnQtd2VpZ2h0PSI1MDAiPk5vIFRodW1iPC90ZXh0Pgo8L3N2Zz4=';
  }

  formatDuration(seconds?: number): string {
    if (!seconds) return '--:--';
    const totalSeconds = Math.floor(seconds);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const secs = totalSeconds % 60;

    if (hours > 0) {
      return `${hours}:${minutes < 10 ? '0' : ''}${minutes}:${secs < 10 ? '0' : ''}${secs}`;
    } else {
      return `${minutes}:${secs < 10 ? '0' : ''}${secs}`;
    }
  }

  purgeAll() {
    if (!confirm('Delete ALL cached videos and clear the playlist?')) return;
    this.http.post(`${this.apiUrl}/purge-all`, {}).subscribe(() => this.loadIndex());
  }

  toggleProtect(videoId: string, isProtected: boolean) {
    this.http.patch(`${this.apiUrl}/video/${videoId}/protect`, { protected: isProtected }).subscribe({
      next: () => {
        const playlist = [...this.playlist()];
        const idx = playlist.findIndex(v => v.videoId === videoId);
        if (idx !== -1) {
          playlist[idx] = { ...playlist[idx], protected: isProtected };
          this.playlist.set(playlist);
        }
        if (this.currentVideo()?.videoId === videoId) {
          this.currentVideo.set({ ...this.currentVideo()!, protected: isProtected });
        }
        if (isProtected) {
          const protectedList = [...this.protectedPlaylist()];
          const pIdx = protectedList.findIndex(v => v.videoId === videoId);
          if (pIdx !== -1) {
            protectedList[pIdx] = { ...protectedList[pIdx], protected: true };
            this.protectedPlaylist.set(protectedList);
          }
        } else {
          this.protectedPlaylist.set(this.protectedPlaylist().filter(v => v.videoId !== videoId));
        }
        const watchedList = [...this.watchedPlaylist()];
        const wIdx = watchedList.findIndex(v => v.videoId === videoId);
        if (wIdx !== -1) {
          watchedList[wIdx] = { ...watchedList[wIdx], protected: isProtected };
          this.watchedPlaylist.set(watchedList);
        }
      }
    });
  }


  addChannel(channelId: string, title: string) {
    this.http.post(`${this.apiUrl}/channels`, { channelId, title }).subscribe(() => this.loadChannels());
  }

  deleteChannel(channelId: string) {
    this.http.delete(`${this.apiUrl}/channels/${channelId}`).subscribe(() => this.loadChannels());
  }

  toggleChannelActive(channelId: string, active: boolean) {
    this.http.patch(`${this.apiUrl}/channels/${channelId}/active`, { active }).subscribe(() => this.loadChannels());
  }

  setChannelDuration(channelId: string, minDuration: number | null, maxDuration: number | null) {
    this.http.patch(`${this.apiUrl}/channels/${channelId}/duration`, { minDuration, maxDuration }).subscribe(() => this.loadChannels());
  }

  startEditingDuration(channelId: string, minDuration: number | null, maxDuration: number | null) {
    this.editingDurationChannelId.set(channelId);
    this.editDurationMin.set(minDuration);
    this.editDurationMax.set(maxDuration);
  }

  cancelEditingDuration() {
    this.editingDurationChannelId.set(null);
    this.editDurationMin.set(null);
    this.editDurationMax.set(null);
  }

  saveChannelDuration() {
    const channelId = this.editingDurationChannelId();
    if (!channelId) return;
    // If both null, that means "use global" — send nulls to clear overrides
    const minVal = this.editDurationMin();
    const maxVal = this.editDurationMax();
    this.setChannelDuration(channelId, minVal, maxVal);
    this.cancelEditingDuration();
  }

  importChannels(rawText: string) {
    const lines = rawText.trim().split('\\n').map(l => l.trim()).filter(l => l.length > 0);
    if (lines.length === 0) return;

    this.isImporting.set(true);
    this.importResults.set([]);

    this.http.post<{ success: boolean; results: ImportResult[] }>(`${this.apiUrl}/import`, {
      items: lines
    }, {
      timeout: 600000
    }).subscribe({
      next: (res) => {
        this.importResults.set(res.results);
        this.isImporting.set(false);
        this.loadChannels();
        const hasVideoAdds = res.results.some(r => r.status === 'added' && r.type === 'video');
        if (hasVideoAdds) {
          this.loadIndex();
        }
      },
      error: (err) => {
        this.isImporting.set(false);
        const reason = err.status === 409
          ? 'Harvest or import already running -- try again later'
          : err.status === 0
            ? 'Request timed out -- import may still be processing'
            : `Server error (${err.status || 'unknown'})`;
        this.importResults.set([{
          input: 'Error',
          type: 'channel',
          status: 'failed',
          reason
        }]);
      }
    });
  }

  moveToTop(channelId: string) {
    const list = [...this.channels()];
    const index = list.findIndex(c => c.channelId === channelId);
    if (index <= 0) return;
    const [item] = list.splice(index, 1);
    list.unshift(item);
    this.channels.set(list);
    this.saveChannelOrder();
  }

  moveToBottom(channelId: string) {
    const list = [...this.channels()];
    const index = list.findIndex(c => c.channelId === channelId);
    if (index === -1 || index === list.length - 1) return;
    const [item] = list.splice(index, 1);
    list.push(item);
    this.channels.set(list);
    this.saveChannelOrder();
  }

  moveUp(channelId: string) {
    const list = [...this.channels()];
    const index = list.findIndex(c => c.channelId === channelId);
    if (index <= 0) return;
    [list[index], list[index - 1]] = [list[index - 1], list[index]];
    this.channels.set(list);
    this.saveChannelOrder();
  }

  moveDown(channelId: string) {
    const list = [...this.channels()];
    const index = list.findIndex(c => c.channelId === channelId);
    if (index === -1 || index >= list.length - 1) return;
    [list[index], list[index + 1]] = [list[index + 1], list[index]];
    this.channels.set(list);
    this.saveChannelOrder();
  }

  private saveChannelOrder() {
    const orderedIds = this.channels().map(c => c.channelId);
    this.http.post(`${this.apiUrl}/channels/reorder`, { channelIds: orderedIds })
      .subscribe({ error: () => this.loadChannels() });
  }

  getTimeAgo(publishedAt: string | Date): string {
    const now = Date.now();
    const then = new Date(publishedAt).getTime();
    const diffMs = Math.abs(now - then);

    const minutes = Math.floor(diffMs / (1000 * 60));
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    const weeks = Math.floor(days / 7);
    const years = Math.floor(days / 365);

    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes} minute${minutes > 1 ? 's' : ''} ago`;
    if (hours < 24) return `${hours} hour${hours > 1 ? 's' : ''} ago`;
    if (days < 7) return `${days} day${days > 1 ? 's' : ''} ago`;
    if (weeks < 52) return `${weeks} week${weeks > 1 ? 's' : ''} ago`;
    return `${years} year${years > 1 ? 's' : ''} ago`;
  }
}
