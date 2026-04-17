import { Component, signal, OnInit, effect, OnDestroy, AfterViewInit, ViewChild, ElementRef } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Title } from '@angular/platform-browser';
import { forkJoin } from 'rxjs';

interface Video {
  id: string;
  videoId: string;
  title: string;
  channel: { title: string };
  publishedAt: string;
  thumbnailPath: string | null;
  progress: number;
  duration?: number;
}

interface Config {
  maxHarvestDays: number;
  preferredBitrate: number;
  preferredMono: boolean;
  autoPurgeDays: number;
  userAgent: string;
  hasCookies: boolean;
  lastPlayedVideoId?: string | null;
}

interface ImportResult {
  channelId: string;
  status: 'added' | 'skipped' | 'failed';
  title?: string;
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
}

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './app.component.html',
  styleUrls: []
})
export class AppComponent implements OnInit, AfterViewInit, OnDestroy {
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
  autoPurgeDays = signal(30);
  userAgent = signal('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36');
  hasCookies = signal(false);
  currentVideoId = signal<string | null>(null);

  // 56K MODEM OPTIMIZATIONS
  lowBandwidthMode = signal(false);

  // 5-WAY AUTOPLAY MODE
  autoplayMode = signal<'newest' | 'newer' | 'older' | 'oldest' | 'off'>('newest');

  private readonly APP_VERSION = '1.5.9-56k';

  activeTab = signal<'queue' | 'harvest' | 'settings' | 'import'>('queue');

  importResults = signal<ImportResult[]>([]);

  harvestStatus = signal<HarvestStatus>({
    isRunning: false,
    startTime: null,
    activeItems: [],
    processedVideos: 0,
    totalVideosThisRun: 0,
    channelsProcessed: 0,
    totalChannels: 0,
    lastUpdate: null
  });

  // Infinite Scroll
  readonly PAGE_SIZE = 20;
  isLoadingMore = signal(false);
  hasMore = signal(true);

  @ViewChild('loadMoreTrigger') loadMoreTrigger!: ElementRef<HTMLDivElement>;
  private observer: IntersectionObserver | null = null;

  editingChannelId = signal<string | null>(null);
  editTitle = signal('');

  private defaultPageTitle = '🎧 YT Drive Audio Queue';
  private lastProgressSave = 0;
  private readonly PROGRESS_SAVE_INTERVAL = 10000;

  private lastSavedVideoId: string | null = null;
  private lastSavedProgress: number = -1;

  private saveDebounceTimer: any = null;
  private harvestPollInterval: any = null;

  constructor(
    private http: HttpClient,
    private titleService: Title
  ) {
    effect(() => {
      this.updateMediaSession(this.currentVideo());
    });
  }

  ngOnInit() {
    console.log(`%c🚙📻 DrivePod Frontend v${this.APP_VERSION} (56K-optimized)`, 'font-weight: bold; color: #22c55e; font-size: 13px');

    this.titleService.setTitle(this.defaultPageTitle);
    this.activeTab.set('queue');

    this.loadChannels();

    const savedLowBW = localStorage.getItem('drivepod-lowBandwidth');
    if (savedLowBW !== null) this.lowBandwidthMode.set(savedLowBW === 'true');

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

    forkJoin({
      config: this.http.get<Config>(`${this.apiUrl}/config`)
    }).subscribe({
      next: ({ config }) => {
        this.maxHarvestDays.set(config.maxHarvestDays);
        this.preferredBitrate.set(config.preferredBitrate);
        this.preferredMono.set(config.preferredMono);
        this.autoPurgeDays.set(config.autoPurgeDays);
        this.userAgent.set(config.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36');
        this.hasCookies.set(!!config.hasCookies);
        this.currentVideoId.set(config.lastPlayedVideoId || null);

        this.loadInitialPlaylist(config.lastPlayedVideoId || null, true);
      },
      error: () => this.loadInitialPlaylist(null, true)
    });

    this.audio.ontimeupdate = () => {
      this.currentTime.set(this.audio.currentTime);
      this.throttledSaveProgress();
    };

    this.setupProgressListeners();
    this.setupMediaSessionHandlers();

    // Playlist auto-refresh every 2 minutes
    setInterval(() => this.loadInitialPlaylist(null, false), 120000);
  }

  ngAfterViewInit() {
    this.setupInfiniteScroll();
  }

  ngOnDestroy() {
    if (this.observer) this.observer.disconnect();
    this.stopHarvestPolling();
    if (this.saveDebounceTimer) clearTimeout(this.saveDebounceTimer);
    window.removeEventListener('beforeunload', this.handleBeforeUnload.bind(this));
  }

  private loadInitialPlaylist(targetVideoId: string | null = null, autoplayAfterLoad: boolean = false) {
    this.isLoadingMore.set(false);
    this.hasMore.set(true);

    const loadPage = (skip: number, accumulated: Video[] = []) => {
      this.http.get<Video[]>(`${this.apiUrl}/playlist?take=${this.PAGE_SIZE}&skip=${skip}`).subscribe({
        next: (data) => {
          const newList = [...accumulated, ...data];
          this.playlist.set(newList);
          this.hasMore.set(data.length === this.PAGE_SIZE);

          const targetFound = !targetVideoId || newList.some(v => v.videoId === targetVideoId);

          if (targetFound || data.length < this.PAGE_SIZE) {
            if (autoplayAfterLoad && !this.currentVideo()) {
              this.initializeCurrentVideo(newList);
            }
          } else if (targetVideoId) {
            loadPage(skip + this.PAGE_SIZE, newList);
          }
        },
        error: (err) => {
          console.error('Failed to load playlist', err);
          this.playlist.set(accumulated);
          this.hasMore.set(false);
        }
      });
    };

    loadPage(0);
  }

  private loadMore() {
    if (this.isLoadingMore() || !this.hasMore()) return;
    const skip = this.playlist().length;
    this.isLoadingMore.set(true);

    this.http.get<Video[]>(`${this.apiUrl}/playlist?take=${this.PAGE_SIZE}&skip=${skip}`)
      .subscribe({
        next: (newVideos) => {
          this.playlist.update(current => [...current, ...newVideos]);
          this.hasMore.set(newVideos.length === this.PAGE_SIZE);
          this.isLoadingMore.set(false);
        },
        error: () => this.isLoadingMore.set(false)
      });
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

  private setupProgressListeners(): void {
    this.audio.onpause = () => this.saveProgress(this.audio.currentTime);
    this.audio.onended = () => {
      this.saveProgress(this.audio.currentTime || this.audio.duration || 0);
      this.markAsWatchedAndPlayNext();
    };

    this.audio.onseeked = () => {
      this.isScrubbing.set(false);

      if (this.saveDebounceTimer) clearTimeout(this.saveDebounceTimer);

      this.saveDebounceTimer = setTimeout(() => {
        this.saveProgress(this.audio.currentTime);
        this.saveDebounceTimer = null;
      }, 300);
    };

    window.addEventListener('beforeunload', this.handleBeforeUnload.bind(this));
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
    }).subscribe({ error: () => {} });
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
  }

  playVideo(video: Video) {
    this.loadAndSeekVideo(video);
    this.audio.play().catch(() => {});
    this.saveCurrentVideo(video.videoId);
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
          console.log(`✅ Resumed ${video.videoId} from ${targetProgress.toFixed(1)}s`);
        }
      }
      this.audio.onloadedmetadata = null;
    };

    this.audio.load();
  }

  setAutoplayMode(mode: 'newest' | 'newer' | 'older' | 'oldest' | 'off') {
    this.autoplayMode.set(mode);
    localStorage.setItem('drivepod-autoplayMode', mode);
  }

  private getCandidate(playlist: Video[], mode: 'newer' | 'older', finishedTime: number): Video | undefined {
    if (mode === 'older') {
      return playlist.find(v => new Date(v.publishedAt).getTime() < finishedTime);
    }
    if (mode === 'newer') {
      const newerOnes = playlist.filter(v => new Date(v.publishedAt).getTime() > finishedTime);
      if (newerOnes.length > 0) return newerOnes[newerOnes.length - 1];
    }
    return undefined;
  }

  // === UPDATED: oldest now loads EVERY page until absolute oldest video is reached ===
  markAsWatchedAndPlayNext() {
    if (!this.currentVideo()) return;
    const finishedVideo = this.currentVideo()!;
    const finishedVideoId = finishedVideo.videoId;
    const finishedPublishedAt = new Date(finishedVideo.publishedAt).getTime();

    this.saveCurrentVideo(null);

    this.http.post(`${this.apiUrl}/video/${finishedVideoId}/watched`, {})
      .subscribe(() => {
        this.currentVideo.set(null);
        this.updatePageTitle(null);

        this.playlist.update(current => current.filter(v => v.videoId !== finishedVideoId));

        const mode = this.autoplayMode();

        if (mode === 'off') {
          this.loadInitialPlaylist(null, false);
          return;
        }

        if (mode === 'newest') {
          this.loadInitialPlaylist(null, true);
          return;
        }

        this.loadPlaylistForAutoplay(mode, finishedPublishedAt);
      });
  }

  private loadPlaylistForAutoplay(mode: 'newer' | 'older' | 'oldest', finishedTime: number) {
    const playlist = this.playlist();
    const isFullyLoaded = !this.hasMore();

    let candidate: Video | undefined;

    if (mode === 'oldest') {
      // For absolute oldest we ONLY pick the final video AFTER the entire playlist is loaded
      if (isFullyLoaded && playlist.length > 0) {
        candidate = playlist[playlist.length - 1];
      }
    } else {
      candidate = this.getCandidate(playlist, mode, finishedTime);
    }

    if (candidate) {
      this.playVideo(candidate);
      return;
    }

    if (isFullyLoaded) {
      // Nothing found even after full load → safe fallback
      if (playlist.length > 0) this.playVideo(playlist[0]);
      else this.loadInitialPlaylist(null, false);
      return;
    }

    // Load next page and continue (this is what makes "oldest" fetch every page)
    this.isLoadingMore.set(true);
    const skip = playlist.length;

    this.http.get<Video[]>(`${this.apiUrl}/playlist?take=${this.PAGE_SIZE}&skip=${skip}`).subscribe({
      next: (newVideos) => {
        this.playlist.update(current => [...current, ...newVideos]);
        this.hasMore.set(newVideos.length === this.PAGE_SIZE);
        this.isLoadingMore.set(false);

        // Recurse – for "oldest" this will keep going until the end
        this.loadPlaylistForAutoplay(mode, finishedTime);
      },
      error: () => {
        this.isLoadingMore.set(false);
        this.loadInitialPlaylist(null, false);
      }
    });
  }

  skipNext() {
    const idx = this.playlist().findIndex(v => v.videoId === this.currentVideo()?.videoId);
    if (idx < this.playlist().length - 1) {
      this.playVideo(this.playlist()[idx + 1]);
    } else {
      this.currentVideo.set(null);
      this.updatePageTitle(null);
      this.saveCurrentVideo(null);
      this.loadInitialPlaylist(null, false);
    }
  }

  skipPrevious() {
    if (!this.currentVideo()) return;
    
    const currentId = this.currentVideo()!.videoId;
    const playlist = this.playlist();
    const idx = playlist.findIndex(v => v.videoId === currentId);
    
    if (idx > 0) {
      this.playVideo(playlist[idx - 1]);
    } else {
      this.audio.currentTime = 0;
      if (this.audio.paused) this.audio.play();
    }
  }

  loadChannels() {
    this.http.get(`${this.apiUrl}/channels`).subscribe(data => this.channels.set(data as any[]));
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

    navigator.mediaSession.setActionHandler('play', () => this.audio.play());
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
      album: 'DrivePod Queue',
      artwork: video.thumbnailPath ? [{ src: video.thumbnailPath, sizes: '320x180', type: 'image/jpeg' }] : []
    });
  }

  setTab(tab: 'queue' | 'harvest' | 'settings' | 'import') {
    this.activeTab.set(tab);
    if (tab !== 'import') this.importResults.set([]);

    if (tab === 'harvest') {
      this.startHarvestPolling();
    } else {
      this.stopHarvestPolling();
    }

    if (tab === 'queue') {
      this.loadInitialPlaylist(null, false);
      setTimeout(() => this.setupInfiniteScroll(), 300);
    }
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
      autoPurgeDays: this.autoPurgeDays(),
      userAgent: this.userAgent()
    }).subscribe();
  }

  toggleLowBandwidth() {
    const newValue = !this.lowBandwidthMode();
    this.lowBandwidthMode.set(newValue);
    localStorage.setItem('drivepod-lowBandwidth', String(newValue));
  }

  onBitrateChange() { this.saveConfig(); }
  onMonoChange() { this.saveConfig(); }

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
      // H:MM:SS (no leading zero on hours)
      return `${hours}:${minutes < 10 ? '0' : ''}${minutes}:${secs < 10 ? '0' : ''}${secs}`;
    } else {
      // MM:SS
      return `${minutes}:${secs < 10 ? '0' : ''}${secs}`;
    }
  }

  purgeAll() {
    if (!confirm('Delete ALL cached videos and clear the playlist?')) return;
    this.http.post(`${this.apiUrl}/purge-all`, {}).subscribe(() => this.loadInitialPlaylist(null, false));
  }

  addChannel(channelId: string, title: string) {
    this.http.post(`${this.apiUrl}/channels`, { channelId, title }).subscribe(() => this.loadChannels());
  }

  deleteChannel(channelId: string) {
    this.http.delete(`${this.apiUrl}/channels/${channelId}`).subscribe(() => this.loadChannels());
  }

  importChannels(rawText: string) {
    const lines = rawText.trim().split('\n').map(l => l.trim()).filter(l => l.length > 0);
    if (lines.length === 0) return;

    this.http.post<{ success: boolean; results: ImportResult[] }>(`${this.apiUrl}/channels/import`, {
      channelIds: lines
    }).subscribe({
      next: (res) => {
        this.importResults.set(res.results);
        this.loadChannels();
      },
      error: () => this.importResults.set([{ channelId: 'Error', status: 'failed', reason: 'Server error' }])
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