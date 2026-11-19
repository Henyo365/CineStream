import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import type { FixedSource } from '../sources';
import type { HistoryEntry } from '../types';

const BACKEND_URL_KEY = '@youanime/backend_url';
const HISTORY_KEY = '@youanime/history';
const FAVORITES_KEY = '@youanime/favorites';
const WATCHED_KEY = '@youanime/watched';
const PROGRESS_KEY = '@youanime/progress';
const CUSTOM_SOURCES_KEY = '@youanime/custom_sources';
const ACCESS_PIN_KEY = '@youanime/access_pin';

function resolveDefaultBackendUrl(): string {
  if (Platform.OS === 'web') {
    if (typeof globalThis.window !== 'undefined') {
      const { protocol, hostname, port, origin } = globalThis.window.location;
      if (hostname === 'localhost' || hostname === '127.0.0.1') {
        return `${protocol}//${hostname}:3001`;
      }
      if (origin && port !== '8081') {
        return origin;
      }
    }
    return 'http://localhost:3001';
  }
  return 'http://192.168.1.100:3001';
}

export const DEFAULT_BACKEND_URL = resolveDefaultBackendUrl();

export interface WatchProgress {
  position: number;
  duration: number;
  updatedAt: number;
  title?: string;
  thumbnail?: string;
}

export async function loadBackendUrl(): Promise<string> {
  const saved = await AsyncStorage.getItem(BACKEND_URL_KEY);
  return saved || DEFAULT_BACKEND_URL;
}

export async function saveBackendUrl(url: string): Promise<void> {
  await AsyncStorage.setItem(BACKEND_URL_KEY, url.trim().replace(/\/+$/, ''));
}

export async function loadHistory(): Promise<HistoryEntry[]> {
  const raw = await AsyncStorage.getItem(HISTORY_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as HistoryEntry[];
  } catch {
    return [];
  }
}

export async function addHistoryEntry(entry: HistoryEntry): Promise<HistoryEntry[]> {
  const current = await loadHistory();
  const filtered = current.filter((item) => item.url !== entry.url);
  const next = [entry, ...filtered].slice(0, 30);
  await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(next));
  return next;
}

export async function clearHistory(): Promise<void> {
  await AsyncStorage.removeItem(HISTORY_KEY);
}

export async function removeHistoryEntry(url: string): Promise<HistoryEntry[]> {
  const current = await loadHistory();
  const next = current.filter((item) => item.url !== url);
  await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(next));
  return next;
}

export async function loadFavorites(): Promise<HistoryEntry[]> {
  const raw = await AsyncStorage.getItem(FAVORITES_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as HistoryEntry[];
  } catch {
    return [];
  }
}

export async function toggleFavorite(entry: HistoryEntry): Promise<HistoryEntry[]> {
  const current = await loadFavorites();
  const exists = current.some((item) => item.url === entry.url);
  const next = exists
    ? current.filter((item) => item.url !== entry.url)
    : [entry, ...current];
  await AsyncStorage.setItem(FAVORITES_KEY, JSON.stringify(next));
  return next;
}

export async function saveFavoritesList(list: HistoryEntry[]): Promise<void> {
  await AsyncStorage.setItem(FAVORITES_KEY, JSON.stringify(list));
}

export async function loadWatchedEpisodes(): Promise<string[]> {
  const raw = await AsyncStorage.getItem(WATCHED_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as string[];
  } catch {
    return [];
  }
}

export async function markEpisodeWatched(url: string): Promise<string[]> {
  const current = await loadWatchedEpisodes();
  if (current.includes(url)) return current;
  const next = [url, ...current].slice(0, 500);
  await AsyncStorage.setItem(WATCHED_KEY, JSON.stringify(next));
  return next;
}

export async function toggleEpisodeWatched(url: string): Promise<string[]> {
  const current = await loadWatchedEpisodes();
  const next = current.includes(url)
    ? current.filter((u) => u !== url)
    : [url, ...current].slice(0, 500);
  await AsyncStorage.setItem(WATCHED_KEY, JSON.stringify(next));
  return next;
}

export async function loadPlaybackProgress(): Promise<Record<string, WatchProgress>> {
  const raw = await AsyncStorage.getItem(PROGRESS_KEY);
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, WatchProgress>;
  } catch {
    return {};
  }
}

export async function savePlaybackProgress(
  url: string,
  position: number,
  duration: number,
  meta?: { title?: string; thumbnail?: string },
): Promise<void> {
  if (!url || duration <= 0) return;
  const current = await loadPlaybackProgress();
  const prev = current[url];
  current[url] = {
    position,
    duration,
    updatedAt: Date.now(),
    title: meta?.title ?? prev?.title,
    thumbnail: meta?.thumbnail ?? prev?.thumbnail,
  };
  // Keep only the 100 most recently updated items
  const entries = Object.entries(current);
  if (entries.length > 100) {
    entries.sort((a, b) => b[1].updatedAt - a[1].updatedAt);
    const trimmed = Object.fromEntries(entries.slice(0, 100));
    await AsyncStorage.setItem(PROGRESS_KEY, JSON.stringify(trimmed));
    return;
  }
  await AsyncStorage.setItem(PROGRESS_KEY, JSON.stringify(current));
}

export async function removePlaybackProgress(url: string): Promise<void> {
  const current = await loadPlaybackProgress();
  if (!(url in current)) return;
  delete current[url];
  await AsyncStorage.setItem(PROGRESS_KEY, JSON.stringify(current));
}

export async function loadAccessPin(): Promise<string> {
  return (await AsyncStorage.getItem(ACCESS_PIN_KEY)) || '';
}

export async function saveAccessPin(pin: string): Promise<void> {
  await AsyncStorage.setItem(ACCESS_PIN_KEY, pin.trim());
}

export async function loadCustomSources(): Promise<FixedSource[]> {
  const raw = await AsyncStorage.getItem(CUSTOM_SOURCES_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as FixedSource[];
  } catch {
    return [];
  }
}

export async function saveCustomSources(sources: FixedSource[]): Promise<void> {
  await AsyncStorage.setItem(CUSTOM_SOURCES_KEY, JSON.stringify(sources));
}
