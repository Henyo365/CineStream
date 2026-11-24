import AsyncStorage from '@react-native-async-storage/async-storage';
import { Directory, File, Paths } from 'expo-file-system';
import { Platform } from 'react-native';
import type {
  ActiveDownloadState,
  DownloadedAnimeGroup,
  DownloadedEpisode,
  MediaItem,
} from '../types';
import {
  buildDirectDownloadUrl,
  buildDownloadJobFileUrl,
  buildProxyUrl,
  cancelDownloadJob,
  extractMediaFromUrl,
  getDownloadJobStatus,
  resolveVideoBatch,
  resolveVideoUrl,
  startDownloadJob,
  type ResolvedVideoResponse,
} from './api';

const DOWNLOADS_KEY = '@youanime/downloads_v1';

function sanitizePart(input: string): string {
  return input
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function slugifySafe(input: string, maxLen = 48): string {
  const ascii = input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return (ascii || 'anime').slice(0, maxLen);
}

function shortHash(input: string): string {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function buildEpisodeDownloadFilename(animeTitle: string, episodeTitle?: string): string {
  const cleanAnime = sanitizePart(animeTitle || 'CineStream');
  const cleanEp = sanitizePart(episodeTitle || '');

  let base = cleanAnime;
  if (cleanEp && cleanEp.toLowerCase() !== cleanAnime.toLowerCase()) {
    const lowerAnime = cleanAnime.toLowerCase();
    const lowerEp = cleanEp.toLowerCase();
    if (lowerEp.startsWith(lowerAnime)) {
      const rest = cleanEp.slice(cleanAnime.length).replace(/^[\s\-–—:|]+/, '').trim();
      base = rest ? `${cleanAnime} - ${rest}` : cleanAnime;
    } else {
      base = `${cleanAnime} - ${cleanEp}`;
    }
  }

  if (base.length > 130) {
    base = base.slice(0, 130).trim();
  }
  return `${base || 'CineStream_Video'}.mp4`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  const kb = 1024;
  const mb = kb * 1024;
  const gb = mb * 1024;
  if (bytes >= gb) return `${(bytes / gb).toFixed(2)} GB`;
  if (bytes >= mb) return `${(bytes / mb).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / kb))} KB`;
}

export function normalizeAnimeKey(animeUrl?: string, animeTitle?: string): string {
  if (animeUrl && animeUrl.trim()) {
    return animeUrl.trim().replace(/\/+$/, '').toLowerCase();
  }
  return `title:${slugifySafe(animeTitle || 'anime', 80)}`;
}

export async function loadDownloadedEpisodes(): Promise<DownloadedEpisode[]> {
  const raw = await AsyncStorage.getItem(DOWNLOADS_KEY);
  if (!raw) return [];
  let parsed: DownloadedEpisode[];
  try {
    parsed = JSON.parse(raw) as DownloadedEpisode[];
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  if (Platform.OS === 'web') {
    return parsed;
  }

  // Verify files still exist on device storage
  const valid: DownloadedEpisode[] = [];
  let changed = false;
  for (const item of parsed) {
    try {
      const f = new File(item.fileUri);
      if (f.exists && f.size > 0) {
        valid.push(item);
      } else {
        changed = true;
      }
    } catch {
      changed = true;
    }
  }

  if (changed) {
    await AsyncStorage.setItem(DOWNLOADS_KEY, JSON.stringify(valid));
  }
  return valid;
}

async function saveDownloadedEpisodes(list: DownloadedEpisode[]): Promise<void> {
  await AsyncStorage.setItem(DOWNLOADS_KEY, JSON.stringify(list));
}

export async function upsertDownloadedEpisode(
  entry: DownloadedEpisode,
): Promise<DownloadedEpisode[]> {
  const current = await loadDownloadedEpisodes();
  const filtered = current.filter((d) => d.episodeUrl !== entry.episodeUrl);
  const next = [entry, ...filtered];
  await saveDownloadedEpisodes(next);
  return next;
}

export async function deleteDownloadedEpisode(episodeUrl: string): Promise<DownloadedEpisode[]> {
  const current = await loadDownloadedEpisodes();
  const target = current.find((d) => d.episodeUrl === episodeUrl);
  if (target && Platform.OS !== 'web') {
    try {
      const f = new File(target.fileUri);
      if (f.exists) f.delete();
    } catch {
      // ignore fs delete error
    }
  }
  const next = current.filter((d) => d.episodeUrl !== episodeUrl);
  await saveDownloadedEpisodes(next);
  return next;
}

export async function deleteDownloadedAnime(animeKey: string): Promise<DownloadedEpisode[]> {
  const current = await loadDownloadedEpisodes();
  const toDelete = current.filter((d) => d.animeKey === animeKey);
  if (Platform.OS !== 'web') {
    for (const ep of toDelete) {
      try {
        const f = new File(ep.fileUri);
        if (f.exists) f.delete();
      } catch {
        // ignore
      }
      if (ep.localThumbnailUri) {
        try {
          const thumb = new File(ep.localThumbnailUri);
          if (thumb.exists) thumb.delete();
        } catch {
          // ignore
        }
      }
    }
  }
  const next = current.filter((d) => d.animeKey !== animeKey);
  await saveDownloadedEpisodes(next);
  return next;
}

export function groupDownloadsByAnime(downloads: DownloadedEpisode[]): DownloadedAnimeGroup[] {
  const map = new Map<string, DownloadedAnimeGroup>();

  for (const ep of downloads) {
    const existing = map.get(ep.animeKey);
    if (!existing) {
      map.set(ep.animeKey, {
        animeKey: ep.animeKey,
        animeTitle: ep.animeTitle,
        thumbnailUri: ep.localThumbnailUri,
        remoteThumbnail: ep.animeThumbnail,
        episodes: [ep],
        totalSizeBytes: ep.sizeBytes,
        latestDownloadedAt: ep.downloadedAt,
      });
    } else {
      existing.episodes.push(ep);
      existing.totalSizeBytes += ep.sizeBytes;
      if (ep.downloadedAt > existing.latestDownloadedAt) {
        existing.latestDownloadedAt = ep.downloadedAt;
      }
      if (!existing.thumbnailUri && ep.localThumbnailUri) {
        existing.thumbnailUri = ep.localThumbnailUri;
      }
      if (!existing.remoteThumbnail && ep.animeThumbnail) {
        existing.remoteThumbnail = ep.animeThumbnail;
      }
    }
  }

  const groups = Array.from(map.values());
  for (const g of groups) {
    g.episodes.sort((a, b) => {
      if (a.episodeNumber !== null && b.episodeNumber !== null && a.episodeNumber !== b.episodeNumber) {
        return a.episodeNumber - b.episodeNumber;
      }
      return a.episodeTitle.localeCompare(b.episodeTitle, undefined, { numeric: true });
    });
  }
  groups.sort((a, b) => b.latestDownloadedAt - a.latestDownloadedAt);
  return groups;
}

function isHlsStream(res: ResolvedVideoResponse): boolean {
  const mime = (res.mimeType || '').toLowerCase();
  const u = res.streamUrl.toLowerCase();
  return mime.includes('mpegurl') || /\/m3u8\//.test(u) || /\.m3u8(\?|#|$)/.test(u);
}

function triggerWebFileDownload(url: string, fileName: string): void {
  if (typeof globalThis.document === 'undefined') return;
  const a = globalThis.document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener noreferrer';
  a.style.display = 'none';
  globalThis.document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    try {
      globalThis.document.body.removeChild(a);
    } catch {
      // ignore
    }
  }, 1500);
}

async function sleepMs(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Descarga cancelada'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('Descarga cancelada'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export interface StartEpisodeDownloadParams {
  backendUrl: string;
  accessPin?: string;
  animeUrl?: string;
  animeTitle: string;
  animeThumbnail?: string;
  episodeUrl: string;
  episodeTitle: string;
  episodeNumber: number | null;
  preloadedVideos?: MediaItem[];
  signal?: AbortSignal;
  onProgress: (state: ActiveDownloadState) => void;
}

export interface EpisodeDownloadOutcome {
  platform: 'web' | 'native';
  fileName: string;
  savedEpisode?: DownloadedEpisode;
  updatedList?: DownloadedEpisode[];
}

export async function downloadEpisodeMedia(
  params: StartEpisodeDownloadParams,
): Promise<EpisodeDownloadOutcome> {
  const {
    backendUrl,
    accessPin,
    animeUrl,
    animeTitle,
    animeThumbnail,
    episodeUrl,
    episodeTitle,
    episodeNumber,
    preloadedVideos,
    signal,
    onProgress,
  } = params;

  const fileName = buildEpisodeDownloadFilename(animeTitle, episodeTitle);
  const report = (
    phase: ActiveDownloadState['phase'],
    progress: number,
    bytesWritten?: number,
    totalBytes?: number,
  ) => {
    onProgress({
      episodeUrl,
      animeTitle,
      episodeTitle,
      phase,
      progress,
      bytesWritten,
      totalBytes,
    });
  };

  report('resolving', 0);

  // 1. Get episode video servers
  let videos: MediaItem[] = preloadedVideos ?? [];
  if (videos.length === 0) {
    const extracted = await extractMediaFromUrl(backendUrl, episodeUrl, { pin: accessPin });
    videos = extracted.videos;
  }
  if (signal?.aborted) throw new Error('Descarga cancelada');

  const videoItems = videos.filter((v) => v.type === 'video');
  if (videoItems.length === 0) {
    throw new Error('No se encontraron servidores de video para descargar este episodio.');
  }

  // 2. Resolve servers in parallel and prefer direct MP4 first, then HLS
  const resolvedMap = await resolveVideoBatch(
    backendUrl,
    videoItems.map((v) => v.url),
    accessPin,
  );
  if (signal?.aborted) throw new Error('Descarga cancelada');

  const directCandidates: ResolvedVideoResponse[] = [];
  const hlsCandidates: ResolvedVideoResponse[] = [];

  for (const item of videoItems) {
    let res = resolvedMap[item.url];
    if (!res) {
      res = await resolveVideoUrl(backendUrl, item.url, accessPin);
    }
    if (!res || res.isEmbed || res.unavailableReason || !res.streamUrl) continue;
    if (isHlsStream(res)) {
      hlsCandidates.push(res);
    } else {
      directCandidates.push(res);
    }
  }

  const orderedCandidates = [...directCandidates, ...hlsCandidates];
  if (orderedCandidates.length === 0) {
    throw new Error('Ningún servidor disponible permite descarga directa para este episodio.');
  }

  let lastError = 'No se pudo completar la descarga.';

  for (const cand of orderedCandidates) {
    if (signal?.aborted) throw new Error('Descarga cancelada');
    let activeJobId: string | null = null;

    try {
      let finalDownloadUrl: string;
      const hls = isHlsStream(cand);

      if (!hls) {
        finalDownloadUrl = buildDirectDownloadUrl(
          backendUrl,
          cand.streamUrl,
          fileName,
          cand.referer || episodeUrl,
          accessPin,
        );
      } else {
        // Prepare a clean +faststart MP4 on the Rust backend with live progress
        report('preparing', 2);
        const started = await startDownloadJob(
          backendUrl,
          cand.streamUrl,
          fileName,
          cand.referer || episodeUrl,
          accessPin,
        );
        activeJobId = started.jobId;

        let jobStatus = started;
        while (jobStatus.status === 'preparing') {
          if (signal?.aborted) {
            await cancelDownloadJob(backendUrl, activeJobId, accessPin);
            throw new Error('Descarga cancelada');
          }
          report('preparing', Math.max(2, Math.min(99, jobStatus.progress)));
          await sleepMs(900, signal);
          jobStatus = await getDownloadJobStatus(backendUrl, activeJobId, accessPin);
        }

        if (jobStatus.status !== 'ready') {
          throw new Error(jobStatus.error || 'Error preparando el video HLS.');
        }

        finalDownloadUrl = buildDownloadJobFileUrl(backendUrl, activeJobId, fileName, accessPin);
      }

      if (signal?.aborted) {
        if (activeJobId) await cancelDownloadJob(backendUrl, activeJobId, accessPin);
        throw new Error('Descarga cancelada');
      }

      // 3A. PC / Web: hand off to the browser's native download manager with exact filename
      if (Platform.OS === 'web') {
        report('downloading', 100);
        triggerWebFileDownload(finalDownloadUrl, fileName);
        return { platform: 'web', fileName };
      }

      // 3B. Mobile (Android / iOS): save permanently in Paths.document/downloads/<animeSlug>/
      report('downloading', 1);
      const animeKey = normalizeAnimeKey(animeUrl, animeTitle);
      const animeSlug = `${slugifySafe(animeTitle, 40)}_${shortHash(animeKey)}`;
      const animeDir = new Directory(Paths.document, 'downloads', animeSlug);
      if (!animeDir.exists) {
        animeDir.create({ intermediates: true, idempotent: true });
      }

      const localFileName = `${slugifySafe(fileName.replace(/\.mp4$/i, ''), 64)}_${shortHash(episodeUrl)}.mp4`;
      const destFile = new File(animeDir, localFileName);

      const downloadedFile = await File.downloadFileAsync(finalDownloadUrl, destFile, {
        idempotent: true,
        signal,
        onProgress: ({ bytesWritten, totalBytes }) => {
          const pct =
            totalBytes > 0
              ? Math.min(99, Math.max(1, Math.round((bytesWritten / totalBytes) * 100)))
              : Math.min(95, Math.max(1, Math.round(bytesWritten / (2 * 1024 * 1024))));
          report('downloading', pct, bytesWritten, totalBytes > 0 ? totalBytes : undefined);
        },
      });

      if (!downloadedFile.exists || downloadedFile.size < 10_000) {
        try {
          if (downloadedFile.exists) downloadedFile.delete();
        } catch {
          // ignore
        }
        throw new Error('El archivo descargado está incompleto.');
      }

      // Best-effort offline poster caching inside the anime's folder
      let localThumbUri: string | undefined;
      const thumbFile = new File(animeDir, 'poster.jpg');
      if (thumbFile.exists && thumbFile.size > 500) {
        localThumbUri = thumbFile.uri;
      } else if (animeThumbnail) {
        try {
          const proxiedPoster = buildProxyUrl(
            backendUrl,
            animeThumbnail,
            animeUrl || episodeUrl,
            accessPin,
          );
          const savedThumb = await File.downloadFileAsync(proxiedPoster, thumbFile, {
            idempotent: true,
          });
          if (savedThumb.exists && savedThumb.size > 500) {
            localThumbUri = savedThumb.uri;
          }
        } catch {
          // optional poster cache
        }
      }

      const record: DownloadedEpisode = {
        id: episodeUrl,
        episodeUrl,
        episodeTitle,
        episodeNumber,
        animeKey,
        animeTitle,
        animeThumbnail,
        localThumbnailUri: localThumbUri,
        fileUri: downloadedFile.uri,
        fileName,
        sizeBytes: downloadedFile.size,
        downloadedAt: Date.now(),
      };

      const updatedList = await upsertDownloadedEpisode(record);
      return {
        platform: 'native',
        fileName,
        savedEpisode: record,
        updatedList,
      };
    } catch (err) {
      if (activeJobId && signal?.aborted) {
        await cancelDownloadJob(backendUrl, activeJobId, accessPin);
      }
      if (signal?.aborted) {
        throw new Error('Descarga cancelada');
      }
      lastError = err instanceof Error ? err.message : 'Error descargando desde este servidor';
    }
  }

  throw new Error(lastError);
}
