import { Component, signal, OnInit, effect, OnDestroy, AfterViewInit, ViewChild, ElementRef, inject, NgZone } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  evaluateStall,
  MAX_STALL_RECOVERIES,
  PlaybackPhase,
  RESUME_DETECT_MS,
  STALL_DETECT_MS,
  STALL_PHASE_LABEL,
  stallResumeTarget,
  streamTrackId
} from './stall-guard';
import { AutoplayMode, manualNextMode, manualPrevMode, pickNextTrack } from './autoplay-order';
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
  /** Global hotkey that locks/unlocks the currently playing item (see toggleProtect). */
  static readonly LOCK_KEY = 'l';

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
   autoplayMode = signal<AutoplayMode>('newest');

   // SKIP MARKS WATCHED: treat skip-next as if the track finished playing
   skipMarksWatched = signal(false);

  private readonly APP_VERSION = '1.15.0';   // ← bumped for the restored, gated ⏮️

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

  // === Playback liveness watchdog (see stall-guard.ts for the decision) ===
  // `timeupdate` is the liveness heartbeat: a playing MP3 advances
  // `currentTime` ~4x/s, so `lastProgressAt` is wall-clock time of the last
  // audible advance. Arming also happens on every fresh load, so a load that
  // produces no progress is judged by the same budget as a stream that went
  // silent — which is what makes each attempt self-serialized (no separate
  // per-attempt clock is needed).
  private lastProgressAt = Date.now();
  private _stallRecoveries = 0;
  // True from `loadAndSeekVideo` until this track's metadata is back: the
  // heartbeat cannot restart before a load lands, so silence is not yet a
  // failed attempt.
  private _freshLoad = false;
  // Fresh load issued by the watchdog (not the normal play path): only those
  // may be retried again, so a playback blocked by the autoplay policy is
  // never reloaded forever.
  private _stallLoadOutstanding = false;
  // `navigator.mediaSession.playbackState === 'playing'` as last reported:
  // the only trustworthy progress signal while the page is hidden.
  private mediaSessionPlaying = false;
  // Shortened detect budget granted after a frozen tab comes back, and when
  // it expires. The tab's clock is stale by construction, so its own `resume`
  // event owns the decision; this only bounds the grace it is given.
  private resumeGraceUntil = 0;
  // Play intent captured when the page went hidden. A suspended tab can have
  // its media pipeline discarded at any moment, so the decision on return has
  // to come from before the suspension, not from the (paused) element after.
  private _wasPlayingAtSuspend = false;
  /** Watchdog status for the badge; `idle` renders nothing. */
  playbackPhase = signal<PlaybackPhase>('idle');

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
      // Liveness heartbeat: audible progress. `timeupdate` fires even while
      // the page is hidden or the screen is off, so it is the one progress
      // signal a frozen/suspended tab cannot fake.
      if (!this.audio.paused) this._noteAudibleProgress();
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
    this._stallLoadOutstanding = false;
    this.resumeGraceUntil = 0;
    this.playbackPhase.set('idle');

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
    } else if (event.key.toLowerCase() === AppComponent.LOCK_KEY) {
      const v = this.currentVideo();
      if (v) {
        event.preventDefault();
        this.toggleProtect(v.videoId, !v.protected);
      }
    }
  }

  /** GrabbyTube-only control: mark the track played and permanently delete it
   *  from GrabbyTube (remote catalog + files). Shared by the 🗑️ button and
   *  the Delete hotkey so behavior can never diverge. */
  consumeGrabbyTrack(videoId: string) {
    this.http.delete(`${this.apiUrl}/video/${videoId}/grabby`).subscribe({
      next: () => this.consumedGrabbyTrack(videoId),
      error: (err: HttpErrorResponse) => {
        // 404 means there was nothing left to delete: the row is also absent when
        // the track was already consumed by something else — integrity cleanup,
        // updateIndexFile's defunct filter, a delete made from the GrabbyTube UI,
        // or a second tab — while this tab's index.json copy (regenerated only on
        // a harvest) still lists it. The item is gone either way, so dropping it
        // locally and advancing is exactly what a successful delete does. Alerting
        // "Video not found" left the row in the queue and asked the user to retry
        // an id that would never come back.
        if (err.status === 404) {
          this.consumedGrabbyTrack(videoId);
          return;
        }
        alert(err.error?.error || err.message || 'Delete failed — try again');
      }
    });
  }

  /**
   * The consume landed — or the track turned out to be gone already. Drop it from
   * this tab's copy, and when it was the track playing here, stop the element and
   * advance the way the autoplay mode asks.
   *
   * Order is the whole point. `removeLocalVideo()` clears `currentVideo` (the item
   * this tab was playing is gone), and `markAsWatchedAndPlayNext()` returns on its
   * first line when `currentVideo` is null — so calling it AFTER the removal, as
   * this handler used to, advanced nothing at all: pressing Delete on the track
   * that was playing blanked the player and left the deleted file audible until it
   * ran out. The reference for the step has to be snapshotted BEFORE the removal,
   * and only a tab that was actually playing this id has playback to advance.
   *
   * No watched POST: the row is gone on the server — that IS the consume — so
   * marking it watched would only queue retries against a 404. `_localWatched`
   * loses the id with it, which is right: nothing left to pin.
   */
  private consumedGrabbyTrack(videoId: string): void {
    const playing = this.currentVideo();
    const left = playing?.videoId === videoId ? playing : undefined;

    this.removeLocalVideo(videoId);

    if (left) this.stopAndAdvance(left, this.autoplayMode());
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

  /** Update a single item's fields inside rawIndex (the one source every tab derives
   *  from), then rebuild all tab lists locally. No network — works on throttled links.
   *  The 2-minute poll reconciles against the server later as a safety net. */
  private applyLocalVideoChange(videoId: string, patch: Partial<Video>): void {
    let changed = false;
    this.rawIndex.update(items => items.map(v => {
      if (v.videoId !== videoId) return v;
      changed = true;
      return { ...v, ...patch };
    }));
    if (!changed) return;
    if (this.currentVideo()?.videoId === videoId) {
      this.currentVideo.set({ ...this.currentVideo()!, ...patch });
    }
    this.derivePlaylists();
  }

  /** Remove an item from rawIndex and rebuild every tab locally (no network). Used when
   *  a track is deleted or permanently consumed. */
  private removeLocalVideo(videoId: string): void {
    const before = this.rawIndex().length;
    this.rawIndex.update(items => items.filter(v => v.videoId !== videoId));
    if (this.rawIndex().length === before) return; // nothing removed
    this._trackPlayFailures.delete(videoId);
    this._localWatched.delete(videoId);
    if (this.currentVideo()?.videoId === videoId) this.currentVideo.set(null);
    this.derivePlaylists();
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

  /** Always-on connectivity probe + playback stall watchdog (every 5s). */
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
    // The stall watchdog hands this track to the outage machinery while
    // `_dropInProgress` is set, so a capture taken from a frozen/suspended
    // tab has to be re-armed by that tab's own `resume` event: record the
    // trust verdict at capture time instead of re-deriving it later.
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
        // Watchdog tick, after the verdict: a HEAD failure is what
        // hands recovery to the outage machinery, so it must be known
        // before the tick decides whether a reload is due.
        this._runStallCheck();
      })
      .catch(() => {
        this._consecutiveProbeFails++;
        if (this._consecutiveProbeFails === 3) {
          console.warn('Backend unreachable (3 consecutive probe failures)');
          this._snapshotPlaybackStateOnDrop();
        }
        this._runStallCheck();
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

    // A fresh load is already in flight (the watchdog's or this one) and it
    // is young: nothing to redo. The old gate (`!paused && readyState >= 2`)
    // was always true for the starved element this recovery exists for —
    // `readyState` 2 IS starvation — so it vetoled the reload that a
    // connection which went silent (or a discarded media pipeline) needed.
    if (!this._freshLoad && Date.now() - this.lastProgressAt < STALL_DETECT_MS) {
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

    // Silent starvation: a connection that dies without an RST (dead Wi-Fi,
    // NAT drop, phone out of coverage) never fires `error`, it just stops
    // delivering bytes. These events mark the attempt settled so the watchdog
    // judges it on the next tick instead of waiting behind `loadInFlight`;
    // neither one triggers a reload by itself (a buffer refill mid-song fires
    // `stalled` routinely).
    this.audio.onwaiting = () => {
      this._freshLoad = false;
    };
    this.audio.onstalled = () => {
      this._freshLoad = false;
    };

    this.audio.onseeked = () => {
      this.isScrubbing.set(false);
      clearTimeout(this.saveDebounceTimer);

      this.saveDebounceTimer = setTimeout(() => {
        this.saveProgress(this.audio.currentTime);
        this.saveDebounceTimer = null;
      }, 300);
    };

    // `onplay` is fired by the element itself when the OS resumes it, so it
    // is also the signal that a lockscreen / head-unit resume worked.
    this.audio.onplay = () => this.setMediaPlaybackState('playing');

    // Successful playback clears any recorded failures for this track.
    this.audio.onplaying = () => {
      const video = this.currentVideo();
      if (video) this._trackPlayFailures.delete(video.videoId);
    };

    window.addEventListener('beforeunload', this.handleBeforeUnload.bind(this));
    window.addEventListener('online', this.handleOnline.bind(this));
    // A frozen/suspended tab (screen off, tab backgrounded on Android) stops
    // firing `timeupdate` and, after a few seconds, discards its media
    // pipeline while the audio keeps "playing" to the OS. Only the tab's own
    // `resume`/visibility events can tell "was playing all along" from
    // "pipeline gone", and only a fresh HTTP load brings back a discarded
    // one — a reload of the same buffer is a no-op.
    document.addEventListener('visibilitychange', this.handleVisibilityChange.bind(this));
    window.addEventListener('resume', this.handleResume.bind(this));
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

  /**
   * Load `video` and resume it, and (re-)arm the liveness watchdog.
   *
   * A same-track load — the watchdog's recovery, a play() that rejected, an
   * error reload, a play-retry — resumes at the ELEMENT's own position, NOT
   * at `video.progress`: that field is what the index carried when it was
   * last fetched, and a recovery deliberately never re-fetches the index.
   * Seeking to it threw a listener whose connection died back to where the
   * item STARTED — in the e2e reproduction of the reported freeze the old
   * behaviour resumed at 0 s after 29 s had already been heard, and the
   * progress PATCHes restarted 8 → 18 → 28 → 0 → 10 → 20, which is the user
   * hearing the beginning of an item they were three minutes into.
   * `currentTime` IS where the listener stopped being heard: the element
   * keeps its playback position when its pipeline is discarded or its
   * connection dies, and the fresh request refills the buffer from there.
   *
   * Whether a load is a same-track load is therefore a question about the
   * ELEMENT, and `streamTrackId(audio.src)` is the only honest answer. The
   * previous code asked `currentVideo`, which the advance paths had ALREADY
   * overwritten with the candidate (`_tryPlay` sets it before the HEAD probe
   * resolves, and the `currentVideo -> null` effect never clears `src`
   * because it is scheduled after that set), so the finished track still sat
   * in the element while the candidate was already "current": `sameTrack`
   * read TRUE for the NEXT track and seeked it to the finished one's
   * position. That is the reported bug — a 20-minute item ending parked the
   * 40-minute item that followed at 20:00 instead of at its own saved
   * progress, and any next track longer than the position being left
   * started partway through itself. A track the element is not loaded with
   * has no live position of its own, so its saved progress from the index
   * (or 0) decides.
   */
  private loadAndSeekVideo(video: Video): void {
    // A DIFFERENT track gets a fresh attempt budget; re-loading the same one
    // keeps it, which is what bounds the watchdog's retries.
    const sameTrack = streamTrackId(this.audio.src) === video.videoId;
    if (!sameTrack) this._stallRecoveries = 0;
    this.currentVideo.set(video);
    this.updatePageTitle(video);
    // The resume target is computed BEFORE `src` is re-assigned: the load
    // algorithm wipes the playback position the moment a new source is set.
    const targetProgress = stallResumeTarget({
      currentTime: sameTrack ? this.audio.currentTime : 0,
      readyState: this.audio.readyState,
      savedProgress: video.progress || 0
    });

    const monoStr = this.preferredMono() ? '-mono' : '';
    this.audio.src = `/api/stream/${video.videoId}?bitrate=${this.preferredBitrate()}${monoStr}`;

    this.audio.onloadedmetadata = () => {
      // The response landed: the load is no longer outstanding, so any
      // silence from here on is judged by the watchdog.
      this._freshLoad = false;
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

    // Assigning `src` restarts the media pipeline (verified in the e2e
    // harness: every same-track reload emitted its own ranged request), and
    // `load()` guarantees the fetch starts even when play() below is refused
    // by the autoplay policy — a blocked play must not defer the download.
    this.audio.load();

    // A fresh HTTP load re-arms the watchdog: silence AFTER this point is a
    // failed attempt, silence before it is the load still fetching.
    this._stallLoadOutstanding = false;
    this._freshLoad = true;
    this._armStallHeartbeat();
  }

  /** Audible progress: the element demonstrably played, so BOTH the
   *  watchdog clock and its attempt budget restart. */
  private _noteAudibleProgress(): void {
    this._freshLoad = false;
    this._stallLoadOutstanding = false;
    this._stallRecoveries = 0;
    this._armStallHeartbeat();
  }

  /** Arm the liveness heartbeat: `staleMs` restarts from now. The attempt
   *  budget is deliberately NOT part of arming — a fresh load that produces
   *  no progress must still be judged as the attempt it was, or a genuinely
   *  dead track would be reloaded forever. */
  private _armStallHeartbeat(): void {
    this.lastProgressAt = Date.now();
    this.playbackPhase.set('idle');
  }

  setAutoplayMode(mode: AutoplayMode) {
    this.autoplayMode.set(mode);
    localStorage.setItem('drivepod-autoplayMode', mode);
  }

  markAsWatchedAndPlayNext() {
    if (!this.currentVideo()) return;
    const finishedVideo = this.currentVideo()!;
    const finishedVideoId = finishedVideo.videoId;

    // Remember until the server confirms persistence (survives blackhole retries)
    this._localWatched.add(finishedVideoId);

    // Immediately update UI state -- do NOT wait for the network call
    // (clear currentVideo AFTER we know the next track, see below)
    this.updatePageTitle(null);

    // Mark the finished track watched in rawIndex and re-derive ALL tabs locally (no
    // refetch): it leaves the Queue AND appears in the Watched tab instantly instead of
    // waiting for the periodic poll / page refresh. derivePlaylists() clears it out of
    // the paged queue too, so the old single-list filter is subsumed.
    this.applyLocalVideoChange(finishedVideoId, { watched: true });

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
      // 'newest' must play the freshest track that actually EXISTS, not the
      // freshest the cache happens to know: a track harvested or downloaded
      // since the last index poll is invisible to playlist(), so a head-only
      // pick is really 'newest as of two minutes ago'. Refresh before
      // choosing. The just-finished video cannot resurface from the fresh
      // fetch: mergeIndexWithLocal pins every _localWatched id (which still
      // holds it, and its watched POST may still be queued for retry) as
      // watched, so it never re-enters the new queue.
      this.currentVideo.set(null);
      this._playFreshest(finishedVideo);
      return;
    }

    // newer/older/oldest: the nearest neighbour in the chosen direction, from
    // the FULL queue (getQueueVideos, not the page slice the user is looking at).
    const candidate = pickNextTrack(this.getQueueVideos(), mode, finishedVideo);

    if (candidate) {
      this.currentVideo.set(null);
      this.playVideo(candidate);
      return;
    }

    // Nothing left in that direction locally — reload index and try again.
    // 'oldest'/'newest' can never reach here with a non-empty queue, so this
    // is the exhausted-direction case: the refresh may have a new track.
    this.currentVideo.set(null);
    this._loadIndexAndPlay(finishedVideo);
  }

  getVideoLinkUrl(video: Video): string {
    const t = Math.floor(this.audio.currentTime || 0);
    return `https://www.youtube.com/watch?v=${video.videoId}${t > 0 ? `&t=${t}s` : ''}`;
  }

  /**
   * Manual ⏭️ — the button, and `nexttrack` from a car head-unit.
   *
   * With skip-marks-watched on this IS the finish path: the left track is marked
   * watched and `markAsWatchedAndPlayNext` already honours the mode. With it off
   * the track stays in the queue unwatched, so the mode is applied here through
   * the same `pickNextTrack` autoplay uses, under `manualNextMode` — 'off' steps
   * one item older (see that function's comment). It used to play
   * `playlist[idx + 1]`, a NEIGHBOUR IN NEWEST-FIRST LIST ORDER: not what
   * 'older'/'oldest'/'newer' ask for, and with 'off' it re-picked a track the
   * user had just pressed Next away from whenever the list shifted under it.
   */
  skipNext() {
    // When skipMarksWatched is enabled, treat skip as if the track just finished
    if (this.skipMarksWatched() && this.currentVideo()) {
      this.saveProgress(this.audio.duration || this.audio.currentTime || 0);
      this.markAsWatchedAndPlayNext();
      return;
    }

    this.stopAndAdvance(this.currentVideo() ?? undefined, manualNextMode(this.autoplayMode()));
  }

  /**
   * Stop the element, clear the track playing in this tab, then advance to what
   * MODE wants next. Shared by the manual ⏭️, the manual ⏮️ and by consuming
   * the track that is playing here, so the three can never leave the player in
   * different states.
   *
   * `left` is the track being abandoned — the reference a relative step measures
   * from, excluded by id so NO mode hands it straight back. `currentVideo` is
   * read into it by the caller when the track is already gone from this tab's
   * index copy (a consume), because clearing it here would lose that reference.
   *
   * Stop and clear BEFORE probing the next track (the probe may fail offline): a
   * candidate then arrives through playVideo → _tryPlay, which re-arms the
   * watchdog. The element must be silenced even though a consume leaves its file
   * on disk: the backend deletes the row, the index entry and the bag slot, so
   * continuing to play it would play a track the library no longer has.
   */
  private stopAndAdvance(left: Video | undefined, mode: AutoplayMode): void {
    this.audio.pause();
    this.audio.src = '';
    this.setMediaPlaybackState('none');
    this.updatePageTitle(null);
    this.currentVideo.set(null);
    this.saveCurrentVideo(null);
    this.advanceToNextTrack(left, mode);
  }

  /**
   * Manual ⏮️ — the button and the `previoustrack` MediaSession handler.
   *
   * INVISIBLE and a NO-OP while `skipMarksWatched` is on, and both halves are
   * load-bearing for the same reason: with that setting on, ⏭️ does not leave
   * the track behind in the queue, it MARKS it finished (the `skipNext()` path
   * above). A finished track is not something a "back" step can undo — the row
   * is watched, out of the queue, and out of the shufflebag — so the only
   * coherent reading of "previous" in that mode is "not offered". Keeping it
   * visible but inert would invite a press that does nothing; keeping it live
   * would re-enter a finished track. The handler stays REGISTERED either way (an
   * unregistered `previoustrack` makes the OS key a rewind, and that reading
   * would then change with a Settings toggle nobody is looking at), so the key
   * is simply inert while the setting is on.
   *
   * With the setting off, ⏮️ is ⏭️ read backwards: `manualPrevMode` flips the
   * chosen autoplay mode to its opposite direction and the SAME `pickNextTrack`
   * answers it, so a Next then Previous lands back on the track the user started
   * from — nothing was marked watched in between, which is exactly what
   * `skipMarksWatched` OFF guarantees. It used to play `playlist[idx - 1]`, a
   * neighbour in newest-first LIST order, for the same reason the Next button
   * used to play `playlist[idx + 1]`.
   *
   * With nothing left in that direction the media-player convention holds: the
   * track playing here restarts from the top (`idx <= 0` did this before the mode
   * rewrite). NOT `stopAndAdvance`'s refresh-and-advance — a Previous is not an
   * advance, and an empty step here means "you are at the end of this walk", not
   * "the library may have grown a candidate".
   */
  skipPrevious() {
    if (this.skipMarksWatched()) return;

    const left = this.currentVideo() ?? undefined;
    if (!left) return;

    const mode = manualPrevMode(this.autoplayMode());
    if (pickNextTrack(this.getQueueVideos(), mode, left)) {
      this.stopAndAdvance(left, mode);
      return;
    }

    // Nothing older (or newer, under a newer-ward mode) to step to.
    this.audio.currentTime = 0;
    if (this.audio.paused) {
      this.audio.play();
      // Explicit play intent: a replay from the start should also resume
      // after a network drop, even if the track was paused before it.
      this._wasPlayingBeforeDrop = true;
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
    // No-ops itself while skipMarksWatched is on (see skipPrevious).
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
    // What the OS thinks our audio is doing: the watchdog's only progress
    // signal while the page is hidden (lockscreen / car head-unit).
    this.mediaSessionPlaying = state === 'playing';
    try {
      navigator.mediaSession.playbackState = state;
    } catch (e) {}
  }

  /** Badge text for the watchdog phase ('' when healthy). */
  get stallPhaseLabel(): string {
    const phase = this.playbackPhase();
    return phase === 'idle' ? '' : STALL_PHASE_LABEL[phase];
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

    // The saved track wins when it is still in the queue: the user left mid-
    // track, and resuming it beats any ordering. Only without one does the
    // mode choose, and pickNextTrack's no-finished rule starts a direction mode
    // at the END OF THE TIMELINE IT TRAVELS ALONG — 'older' at the oldest, so
    // walking backwards actually has somewhere to walk. Hard-coding the head
    // here is what made 'older' look ignored on a fresh page load.
    const savedId = this.currentVideoId();
    // The `|| queue[0]` covers the only undefined pickNextTrack can return with a
    // non-empty queue and no finished track: every publishedAt unparseable,
    // which is a junk index where the head is as good a start as any.
    const video: Video = (savedId && queue.find(v => v.videoId === savedId))
      || pickNextTrack(queue, mode) || queue[0];

    // The one load path: it sets the source, arms the liveness watchdog and
    // resumes at `video.progress` (fresh track: no live position to keep).
    this._loadAndPlay(video);
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
                      this.advanceToNextTrack(video);
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
                    this.advanceToNextTrack(video);
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
      // The defunct track IS the reference for the step: without it a relative
      // mode restarts at the wrong end of the timeline, and the same broken
      // region gets re-entered. It is still in rawIndex (only `playlist` was
      // filtered above), and pickNextTrack excludes it by id.
      this.advanceToNextTrack(finishedVideo);
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

  // === Playback liveness watchdog ===

  /**
   * Trust verdict for this tick: TRUE while the page is rendered OR the OS
   * media session still reports our audio as playing (lockscreen, car
   * head-unit) — in both cases a real stream keeps firing `timeupdate`, so
   * silence means something is wrong. FALSE while the tab is
   * frozen/suspended: its timers run at ~1/min so a stale heartbeat proves
   * nothing, and the audio may genuinely still be playing. Those cases are
   * decided by the tab's own `resume` event (`handleResume`).
   */
  private computeClockTrust(): boolean {
    return (typeof document === 'undefined' || document.visibilityState === 'visible')
      || this.mediaSessionPlaying;
  }

  /** One watchdog tick, run after every connectivity probe verdict. */
  private _runStallCheck(): void {
    const video = this.currentVideo();
    const now = Date.now();
    // A resumed tab runs the shortened budget (its clock is stale by
    // construction) until that grace expires; everything else the full one.
    const budget = now < this.resumeGraceUntil ? RESUME_DETECT_MS : STALL_DETECT_MS;
    const staleMs = now - this.lastProgressAt;

    const decision = evaluateStall({
      hasTrack: !!video,
      paused: this.audio.paused,
      scrubbing: this.isScrubbing(),
      staleMs,
      readyState: this.audio.readyState,
      loadInFlight: this._freshLoad,
      retryPending: !!this._playRetryTimer,
      networkDown: !this.backendOnline || this._dropInProgress,
      clockTrust: this.computeClockTrust(),
      recoveries: this._stallRecoveries,
      detectMs: budget
    });

    if (this.playbackPhase() !== decision.phase) this.playbackPhase.set(decision.phase);
    this._stallRecoveries = decision.nextRecoveries;
    this._freshLoad = decision.nextLoadInFlight;

    if (decision.recover) {
      console.warn(`Playback stalled on ${video?.videoId} (${Math.round((now - this.lastProgressAt) / 1000)}s silent, backend reachable) -- reloading`);
      this._recoverFromStall();
    } else if (decision.giveUp) {
      console.warn(`Playback never resumed on ${video?.videoId} after ${MAX_STALL_RECOVERIES} reloads -- skipping`);
      this._skipDefunctTrack(video!.videoId);
    }
  }

  /**
   * Recovery reload: same track, same playback position, but a NEW HTTP request
   * (a reload of the same buffer is a no-op for a dead connection or a
   * discarded pipeline). Uses the plain load path, NOT `_tryPlay`: the play
   * retry loop owns the not-reachable case and would take over the track.
   */
  private _recoverFromStall(): void {
    this._reloadCurrentTrack('Playback stalled (backend reachable, no progress)');
  }

  /**
   * Reload the current track where it stopped with a NEW HTTP request
   * (reusing the buffer is a no-op for a connection that went silent or for a
   * discarded media pipeline). Uses the plain load path, NOT `_tryPlay`: the
   * play-retry loop owns the not-reachable case and would take the track over.
   */
  private _reloadCurrentTrack(reason: string): void {
    const video = this.currentVideo();
    if (!video) return;
    console.warn(`${reason} -- reloading ${video.videoId}`);
    this.loadAndSeekVideo(video);
    // This particular load is watchdog-owned: only those may be retried on a
    // later tick, so a play blocked by the autoplay policy is not reloaded
    // forever.
    this._stallLoadOutstanding = true;
    this.audio.play().catch(() => {
      // Autoplay policy can block an unprompted resume: the track is loaded
      // and the user can hit play.
    });
  }

  /** Page hidden/visible. Hidden: capture play intent (this tab's media
  *   pipeline can be discarded at any moment while suspended, and the
  *   element may then pause itself without any event reaching us), arm the
  *   heartbeat so the hidden period is not read as a stall, and drop the
  *   badge because this tab's clock is no longer trustworthy. */
  private handleVisibilityChange(): void {
    if (document.visibilityState !== 'visible') {
      this._wasPlayingAtSuspend = !!this.currentVideo() && (!this.audio.paused || this.audio.error !== null);
      this._armStallHeartbeat();
      return;
    }
    this._handleResume();
  }

  /** Tab frozen → running again (`resume`, which Chrome fires when it
  *   re-activates a suspended tab) or lockscreen unlock. */
  private handleResume(): void {
    this._handleResume();
  }

  private _handleResume(): void {
    if (!this.currentVideo()) return;

    if (!this.audio.paused) {
      // Audio survived the whole hidden period via the OS audio service
      // (screen off, tab still audible): the element is live and the heartbeat
      // was armed on hide, so there is nothing to recover — and the attempt
      // budget must NOT be spent, which is what would otherwise skip a track
      // part-way through on every screen timeout.
      this._wasPlayingAtSuspend = false;
      this.resumeGraceUntil = 0;
      this._noteAudibleProgress();
      return;
    }

    if (this._wasPlayingAtSuspend) {
      this._wasPlayingAtSuspend = false;
      // The user wanted this playing and the element stopped while we were
      // away: the pipeline was discarded while suspended, and only a fresh
      // HTTP load revives it (a reload of the same buffer is a no-op). A
      // play-retry loop or an outage snapshot owns the track instead.
      if (!this._playRetryTimer && !this._dropInProgress) {
        this._reloadCurrentTrack('Tab resumed with audio paused');
      }
    }

    // Grant the shortened detect budget while this grace runs: this tab's
    // clock is stale by construction, so the normal budget would forgive a
    // discarded pipeline for as long as the tab had been frozen.
    this.resumeGraceUntil = Date.now() + RESUME_DETECT_MS;
  }
  /**
   * The freshest track still playable, or undefined when nothing is left.
   *
   * `exclude` is the track being left behind, dropped BY ID: same-timestamp
   * siblings of a grabby cluster band stay pickable, which is what the
   * timestamp-based filters could not do without stalling the queue.
   */
  private _nextLeft(exclude?: Video): Video | undefined {
    const queue = this.getQueueVideos();
    // pickNextTrack answers undefined for an empty queue, or when every
    // publishedAt is unparseable; the list's own order is the last resort.
    return pickNextTrack(queue, 'newest', exclude)
      ?? queue.find(v => !exclude || v.videoId !== exclude.videoId);
  }

  /**
   * 'newest' advance: refresh the index, then play the freshest track left.
   *
   * A head-only pick from the cached playlist plays 'newest as of the last
   * poll', not newest: a track harvested or downloaded since that poll is not
   * in the cache at all. So every advance re-fetches first — cheap, because
   * index.json 304s (byte-stable + no-cache) whenever nothing changed — and
   * plays from the merged result, where a fresh item is finally visible.
   *
   * `exclude` is the track being left — one that just ended, failed, or was
   * skipped by hand — and it is dropped by ID from the fresh queue too. A
   * manual ⏭️ with skip-marks-watched OFF leaves it UNWATCHED, so the refresh
   * still lists it and a head-only pick would hand it straight back; the
   * just-finished track is pinned watched by mergeIndexWithLocal's
   * _localWatched anyway, so passing it there is belt and braces.
   *
   * A dead backend must not hard-stop a playing queue: offline, or when the
   * refresh itself fails, play the freshest the cache still has. Deferring
   * (indexFetchPending) is reserved for the no-cache case — the existing
   * connectivity-resume path replays once the backend returns.
   */
  private _playFreshest(exclude?: Video): void {
    if (!this.backendOnline) {
      this.indexFetchPending = true;
      const offline = this._nextLeft(exclude);
      if (offline) this.playVideo(offline);
      return;
    }

    this.fetchIndexWithProgress()
      .then((data: Video[]) => {
        this.backendOnline = true;
        this.indexFetchPending = false;
        this.rawIndex.set(this.mergeIndexWithLocal(data));
        this.derivePlaylists();
        if (this.autoplayMode() !== 'newest') return; // mode flipped mid-fetch
        const freshest = this._nextLeft(exclude);
        if (freshest) this.playVideo(freshest);
      })
      .catch(() => {
        // Refresh failed: roll to the freshest the cache has rather than stopping.
        const cached = this._nextLeft(exclude);
        if (cached) this.playVideo(cached);
        else this.indexFetchPending = true;
      });
  }

  /**
   * Reload the index, then play what the MODE wants from the refreshed queue.
   *
   * `finished` is the track that just ended/failed, when there was one: the
   * relative modes need it as their reference point, and it is excluded by id,
   * so a defunct track that the refresh still lists cannot be re-played. With
   * none, the pick starts at the end of the timeline the mode travels along.
   * The mode is read AFTER the fetch on purpose — a Settings change made while
   * the request was in flight must be the one honoured.
   */
  private _loadIndexAndPlay(finished?: Video): void {
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
          const candidate = pickNextTrack(queue, mode, finished);
          if (candidate) this.playVideo(candidate);
        }
      })
      .catch(err => {
        this.backendOnline = false;
        this.indexFetchPending = true;
        console.error('Failed to load index for autoplay', err);
      });
  }

  /**
   * Advance to the next track the autoplay mode asks for.
   *
   * `finished` is the track being left behind — one that just ended, failed to
   * play, or was skipped by hand. It is the reference for a relative step: pass
   * nothing and 'older'/'newer' lose their direction and restart at the timeline
   * end, which is how a broken track used to drag the queue back to the same
   * region; pass it and NO mode can return it, 'newest'/'oldest' included.
   * @param mode the mode to advance under: the autoplay setting by default, or
   *        `manualNextMode(autoplayMode)` for the manual ⏭️.
   */
  private advanceToNextTrack(finished?: Video, mode: AutoplayMode = this.autoplayMode()): void {
    if (mode === 'off') return;

    if (mode === 'newest') {
      this._playFreshest(finished);
      return;
    }

    const candidate = pickNextTrack(this.getQueueVideos(), mode, finished);
    if (candidate) {
      this.playVideo(candidate);
    } else {
      // Nothing locally in that direction: a refresh may have a new track
      // (harvest/download since the last poll) that satisfies it.
      this._loadIndexAndPlay(finished);
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
        // Server persisted the change (and regenerated index.json). Reflect it in ALL
        // tabs locally without re-fetching — cheap even on throttled connections.
        // Unwatching clears progress so the track resumes from the start when replayed.
        this._localWatched.delete(videoId);
        this.applyLocalVideoChange(videoId, watched ? { watched: true } : { watched: false, progress: 0 });
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
        // Server persisted the lock state. Reflect it in ALL tabs locally without a
        // re-fetch: locking adds the item to the Protected tab, unlocking removes it,
        // and the queue/watched flags update too. No network cost for throttled links.
        this.applyLocalVideoChange(videoId, { protected: isProtected });
      },
      error: () => {}
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
