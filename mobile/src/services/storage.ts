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
  const next = [url, ...current].slice(0, 300);
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
): Promise<void> {
  if (!url || duration <= 0) return;
  const current = await loadPlaybackProgress();
  current[url] = { position, duration, updatedAt: Date.now() };
  await AsyncStorage.setItem(PROGRESS_KEY, JSON.stringify(current));
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
