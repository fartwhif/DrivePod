import { Component, signal, OnInit, effect, OnDestroy } from '@angular/core';
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
}

interface Config {
  maxHarvestDays: number;
  preferredBitrate: number;
  preferredMono: boolean;
  autoPurgeDays: number;
  userAgent: string;
  cookies: string;
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
export class AppComponent implements OnInit, OnDestroy {
  apiUrl = 'http://192.168.0.42:3000/api';
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
  cookies = signal('');                     // display status only

  // Tabs
  activeTab = signal<'queue' | 'harvest' | 'settings' | 'import'>('queue');

  // Import
  importResults = signal<ImportResult[]>([]);

  // Live Harvest Status
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

  // Channel renaming
  editingChannelId = signal<string | null>(null);
  editTitle = signal('');

  private defaultPageTitle = '🎧 YT Drive Audio Queue';
  private progressInterval: any = null;
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
    this.titleService.setTitle(this.defaultPageTitle);
    this.loadConfig();
    this.loadChannels();
    this.loadPlaylist();
    this.activeTab.set('queue');
    this.audio.ontimeupdate = () => this.currentTime.set(this.audio.currentTime);
    this.audio.onended = () => this.markAsWatchedAndPlayNext();
    setInterval(() => this.loadPlaylist(), 30000);
    this.setupMediaSessionHandlers();
  }

  ngOnDestroy() {
    this.stopHarvestPolling();
    if (this.progressInterval) clearInterval(this.progressInterval);
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
  }

  private updatePageTitle(video: Video | null) {
    if (video) this.titleService.setTitle(`${video.channel.title} - ${video.title}`);
    else this.titleService.setTitle(this.defaultPageTitle);
  }

  private loadAndSeekVideo(video: Video) {
    this.currentVideo.set(video);
    this.updatePageTitle(video);
    const monoStr = this.preferredMono() ? '-mono' : '';
    this.audio.src = `http://192.168.0.42:3000/api/stream/${video.videoId}?bitrate=${this.preferredBitrate()}${monoStr}`;
    this.audio.load();
    this.audio.currentTime = video.progress || 0;
  }

  playVideo(video: Video) {
    this.loadAndSeekVideo(video);
    this.audio.play();
    this.startProgressSaving(video.videoId);
  }

  private tryResumeFromProgress(videos: Video[]) {
    if (this.currentVideo() || videos.length === 0) return;
    const videoToResume = videos.find(v => v.progress > 0);
    if (videoToResume) this.loadAndSeekVideo(videoToResume);
  }

  markAsWatchedAndPlayNext() {
    if (!this.currentVideo()) return;
    const videoId = this.currentVideo()!.videoId;
    this.stopProgressSaving();
    this.http.post(`${this.apiUrl}/video/${videoId}/watched`, {})
      .subscribe(() => {
        this.currentVideo.set(null);
        this.updatePageTitle(null);
        this.http.get<Video[]>(`${this.apiUrl}/playlist`).subscribe(data => {
          this.playlist.set(data);
          if (data.length > 0) this.playVideo(data[0]);
        });
      });
  }

  skipNext() {
    this.stopProgressSaving();
    const idx = this.playlist().findIndex(v => v.videoId === this.currentVideo()?.videoId);
    if (idx < this.playlist().length - 1) {
      this.playVideo(this.playlist()[idx + 1]);
    } else {
      this.currentVideo.set(null);
      this.updatePageTitle(null);
      this.loadPlaylist();
    }
  }

  loadPlaylist() {
    this.http.get<Video[]>(`${this.apiUrl}/playlist`).subscribe(data => {
      this.playlist.set(data);
      if (!this.currentVideo()) this.tryResumeFromProgress(data);
    });
  }

  loadConfig() {
    this.http.get<Config>(`${this.apiUrl}/config`).subscribe(config => {
      this.maxHarvestDays.set(config.maxHarvestDays);
      this.preferredBitrate.set(config.preferredBitrate);
      this.preferredMono.set(config.preferredMono);
      this.autoPurgeDays.set(config.autoPurgeDays);
      this.userAgent.set(config.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36');
      this.cookies.set(config.cookies || '');
    });
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

  // === Channel Renaming ===
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

  // === Cookie upload ===
  uploadCookies(event: Event) {
    const input = event.target as HTMLInputElement;
    if (!input.files?.length) return;
    const file = input.files[0];
    const formData = new FormData();
    formData.append('cookies', file);

    this.http.post(`${this.apiUrl}/cookies`, formData).subscribe({
      next: () => {
        alert('cookies.txt uploaded successfully');
        this.loadConfig();
      },
      error: () => alert('Failed to upload cookies.txt')
    });
  }

  // === Clear Cookies ===
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

  loadChannels() {
    this.http.get(`${this.apiUrl}/channels`).subscribe(data => this.channels.set(data as any[]));
  }

  scrubTo(value: string | number) {
    this.audio.currentTime = Number(value);
  }

  private startProgressSaving(videoId: string) {
    if (this.progressInterval) clearInterval(this.progressInterval);
    this.progressInterval = setInterval(() => {
      const progress = this.audio.currentTime;
      if (progress > 0 && !this.audio.paused) {
        this.http.patch(`${this.apiUrl}/video/${videoId}/progress`, { progress }).subscribe({ error: () => {} });
      }
    }, 8000);
  }

  private stopProgressSaving() {
    if (this.progressInterval) {
      clearInterval(this.progressInterval);
      this.progressInterval = null;
    }
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
    this.http.post(`${this.apiUrl}/purge-all`, {}).subscribe(() => this.loadPlaylist());
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

  // Channel Reordering
  moveToTop(channelId: string) {
    const list = [...this.channels()];
    const idx = list.findIndex(c => c.channelId === channelId);
    if (idx <= 0) return;
    const [item] = list.splice(idx, 1);
    list.unshift(item);
    this.channels.set(list);
    this.saveChannelOrder();
  }

  moveToBottom(channelId: string) {
    const list = [...this.channels()];
    const idx = list.findIndex(c => c.channelId === channelId);
    if (idx === -1 || idx === list.length - 1) return;
    const [item] = list.splice(idx, 1);
    list.push(item);
    this.channels.set(list);
    this.saveChannelOrder();
  }

  moveUp(channelId: string) {
    const list = [...this.channels()];
    const idx = list.findIndex(c => c.channelId === channelId);
    if (idx <= 0) return;
    [list[idx], list[idx - 1]] = [list[idx - 1], list[idx]];
    this.channels.set(list);
    this.saveChannelOrder();
  }

  moveDown(channelId: string) {
    const list = [...this.channels()];
    const idx = list.findIndex(c => c.channelId === channelId);
    if (idx === -1 || idx >= list.length - 1) return;
    [list[idx], list[idx + 1]] = [list[idx + 1], list[idx]];
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