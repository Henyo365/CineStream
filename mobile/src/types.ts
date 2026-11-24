export type MediaType = 'video' | 'image' | 'pdf';

export interface MediaItem {
  id: string;
  type: MediaType;
  url: string;
  title?: string;
  thumbnail?: string;
  mimeType?: string;
  isEmbed?: boolean;
  sourceTag?: string;
}

export interface GenreTag {
  label: string;
  url?: string;
}

export interface PageMetadata {
  title: string;
  description?: string;
  siteName?: string;
  favicon?: string;
  poster?: string;
  backdrop?: string;
  infoUrl?: string;
  status?: string;
  rating?: string;
  year?: string;
  duration?: string;
  genres?: GenreTag[];
  sourceUrl: string;
}

export interface PageLink {
  id: string;
  url: string;
  title: string;
  subtitle?: string;
  thumbnail?: string;
  group?: string;
  source?: string;
  score?: number;
}

export interface ExtractionResult {
  adapter: string;
  metadata: PageMetadata;
  videos: MediaItem[];
  images: MediaItem[];
  pdfs: MediaItem[];
  pages?: PageLink[];
  related?: PageLink[];
  nextPageUrl?: string;
}

export interface HistoryEntry {
  url: string;
  title: string;
  thumbnail?: string;
  savedAt: number;
  counts: {
    videos: number;
    images: number;
    pdfs: number;
  };
}

export interface DownloadedEpisode {
  id: string;
  episodeUrl: string;
  episodeTitle: string;
  episodeNumber: number | null;
  animeKey: string;
  animeTitle: string;
  animeThumbnail?: string;
  localThumbnailUri?: string;
  fileUri: string;
  fileName: string;
  sizeBytes: number;
  downloadedAt: number;
}

export interface DownloadedAnimeGroup {
  animeKey: string;
  animeTitle: string;
  thumbnailUri?: string;
  remoteThumbnail?: string;
  episodes: DownloadedEpisode[];
  totalSizeBytes: number;
  latestDownloadedAt: number;
}

export interface ActiveDownloadState {
  episodeUrl: string;
  animeTitle: string;
  episodeTitle: string;
  phase: 'resolving' | 'preparing' | 'downloading';
  progress: number;
  bytesWritten?: number;
  totalBytes?: number;
}
