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
  cookies: string;
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

  // Config
  maxHarvestDays = signal(7);
  preferredBitrate = signal(128);
  preferredMono = signal(false);
  autoPurgeDays = signal(30);
  userAgent = signal('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36');
  cookies = signal('');
  currentVideoId = signal<string | null>(null);

  private readonly APP_VERSION = '1.5.4';

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
  readonly PAGE_SIZE = 40;
  isLoadingMore = signal(false);
  hasMore = signal(true);

  @ViewChild('loadMoreTrigger') loadMoreTrigger!: ElementRef<HTMLDivElement>;
  private observer: IntersectionObserver | null = null;

  editingChannelId = signal<string | null>(null);
  editTitle = signal('');

  private defaultPageTitle = '🎧 YT Drive Audio Queue';
  private lastProgressSave = 0;
  private readonly PROGRESS_SAVE_INTERVAL = 10000;

  private hasInitialized = false;
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
    console.log(`%c🚙📻 DrivePod Frontend v${this.APP_VERSION} initializing`, 'font-weight: bold; color: #22c55e; font-size: 13px');

    this.titleService.setTitle(this.defaultPageTitle);
    this.activeTab.set('queue');

    this.loadChannels();

    forkJoin({
      config: this.http.get<Config>(`${this.apiUrl}/config`)
    }).subscribe({
      next: ({ config }) => {
        this.maxHarvestDays.set(config.maxHarvestDays);
        this.preferredBitrate.set(config.preferredBitrate);
        this.preferredMono.set(config.preferredMono);
        this.autoPurgeDays.set(config.autoPurgeDays);
        this.userAgent.set(config.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36');
        this.cookies.set(config.cookies || '');
        this.currentVideoId.set(config.lastPlayedVideoId || null);

        this.loadInitialPlaylist();

        if (!this.currentVideo()) {
          this.hasInitialized = true;
        }
      },
      error: () => this.loadInitialPlaylist()
    });

    this.audio.ontimeupdate = () => {
      this.currentTime.set(this.audio.currentTime);
      this.throttledSaveProgress();
    };

    this.setupProgressListeners();
    this.setupMediaSessionHandlers();

    // Refresh playlist every 30 seconds (newest videos appear at top)
    setInterval(() => this.loadInitialPlaylist(), 30000);
  }

  ngAfterViewInit() {
    this.setupInfiniteScroll();
  }

  ngOnDestroy() {
    if (this.observer) this.observer.disconnect();
    this.stopHarvestPolling();
    window.removeEventListener('beforeunload', this.handleBeforeUnload.bind(this));
  }

  private loadInitialPlaylist() {
    this.isLoadingMore.set(false);
    this.hasMore.set(true);
    this.http.get<Video[]>(`${this.apiUrl}/playlist?take=${this.PAGE_SIZE}&skip=0`).subscribe({
      next: (data) => {
        this.playlist.set(data);
        this.hasMore.set(data.length === this.PAGE_SIZE);
      },
      error: (err) => console.error('Failed to load playlist', err)
    });
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
    this.audio.onseeked = () => this.saveProgress(this.audio.currentTime);

    window.addEventListener('beforeunload', this.handleBeforeUnload.bind(this));
  }

  private handleBeforeUnload(): void {
    if (this.currentVideo()) this.saveProgress(this.audio.currentTime);
  }

  private throttledSaveProgress(): void {
    if (!this.currentVideo()) return;
    const now = Date.now();
    if (now - this.lastProgressSave < this.PROGRESS_SAVE_INTERVAL) return;
    this.lastProgressSave = now;
    this.saveProgress(this.audio.currentTime);
  }

  private saveProgress(progress: number): void {
    const video = this.currentVideo();
    if (!video?.videoId) return;
    this.http.patch(`${this.apiUrl}/video/${video.videoId}/progress`, {
      progress: Math.floor(progress)
    }).subscribe({ error: () => {} });
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
    this.audio.load();
    this.audio.currentTime = video.progress || 0;
  }

  markAsWatchedAndPlayNext() {
    if (!this.currentVideo()) return;
    const videoId = this.currentVideo()!.videoId;

    this.saveCurrentVideo(null);

    this.http.post(`${this.apiUrl}/video/${videoId}/watched`, {})
      .subscribe(() => {
        this.currentVideo.set(null);
        this.updatePageTitle(null);
        this.loadInitialPlaylist();   // refresh after marking watched
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
      this.loadInitialPlaylist();
    }
  }

  loadChannels() {
    this.http.get(`${this.apiUrl}/channels`).subscribe(data => this.channels.set(data as any[]));
  }

  private refreshConfig() {
    this.http.get<Config>(`${this.apiUrl}/config`).subscribe(config => {
      this.cookies.set(config.cookies || '');
    });
  }

  private startHarvestPolling() {
    if (this.harvestPollInterval) return;
    this.harvestPollInterval = setInterval(() => {
      this.http.get<HarvestStatus>(`${this.apiUrl}/harvest-status`)
        .subscribe(status => this.harvestStatus.set(status));
    }, 1000);
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
      this.loadInitialPlaylist();
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
        this.cookies.set('');
        alert('Cookies have been cleared');
      },
      error: () => alert('Failed to clear cookies')
    });
  }

  scrubTo(value: string | number) {
    this.audio.currentTime = Number(value);
  }

  onImageError(event: Event) {
    const img = event.target as HTMLImageElement;
    img.src = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iODAiIGhlaWdodD0iODAiIHZpZXdCb3g9IjAgMCA4MCA4MCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHJlY3Qgd2lkdGg9IjgwIiBoZWlnaHQ9IjgwIiByeD0iMTIiIGZpbGw9IiMyMjIiLz4KPHRleHQgeD0iNDAiIHk9IjQ1IiB0ZXh0LWFuY2hvcj0ibWlkZGxlIiBmaWxsPSIjYWFhIiBmb250LWZhbWlseT0ic3lzdGVtLXVpLC1hcHBsZS1zeXN0ZW0sU2Vnb2UgVUkiIGZvbnQtc2l6ZT0iMTIiIGZvbnQtd2VpZ2h0PSI1MDAiPk5vIFRodW1iPC90ZXh0Pgo8L3N2Zz4=';
  }

  formatDuration(seconds?: number): string {
    if (!seconds) return '--:--';
    const min = Math.floor(seconds / 60);
    const sec = Math.floor(seconds % 60);
    return `${min}:${sec < 10 ? '0' : ''}${sec}`;
  }

  purgeAll() {
    if (!confirm('Delete ALL cached videos and clear the playlist?')) return;
    this.http.post(`${this.apiUrl}/purge-all`, {}).subscribe(() => this.loadInitialPlaylist());
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