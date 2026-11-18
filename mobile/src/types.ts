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

export interface PageMetadata {
  title: string;
  description?: string;
  siteName?: string;
  favicon?: string;
  poster?: string;
  infoUrl?: string;
  status?: string;
  sourceUrl: string;
}

export interface PageLink {
  id: string;
  url: string;
  title: string;
  subtitle?: string;
  thumbnail?: string;
  group?: string;
}

export interface ExtractionResult {
  adapter: string;
  metadata: PageMetadata;
  videos: MediaItem[];
  images: MediaItem[];
  pdfs: MediaItem[];
  pages?: PageLink[];
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
