import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import * as Sharing from 'expo-sharing';
import { StatusBar } from 'expo-status-bar';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  BackHandler,
  FlatList,
  Image,
  Keyboard,
  Modal,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { MangaReaderView } from './src/components/MangaReaderView';
import { MediaViewerModal } from './src/components/MediaViewerModal';
import { ServerPickerModal } from './src/components/ServerPickerModal';
import { SettingsModal } from './src/components/SettingsModal';
import {
  buildProxyUrl,
  extractMediaFromUrl,
  globalSearchMedia,
  resolveVideoBatch,
  type ResolvedVideoResponse,
  type SearchSourceFilter,
} from './src/services/api';
import {
  addHistoryEntry,
  addRecentSearch,
  clearHistory,
  clearRecentSearches,
  DEFAULT_BACKEND_URL,
  loadAccessPin,
  loadBackendUrl,
  loadCustomSources,
  loadFavorites,
  loadHistory,
  loadPlaybackProgress,
  loadRecentSearches,
  loadWatchedEpisodes,
  markEpisodeWatched,
  removeHistoryEntry,
  removePlaybackProgress,
  saveAccessPin,
  saveBackendUrl,
  saveCustomSources,
  saveFavoritesList,
  savePlaybackProgress,
  toggleEpisodeWatched,
  toggleFavorite,
  type WatchProgress,
} from './src/services/storage';
import {
  deleteDownloadedAnime,
  deleteDownloadedEpisode,
  downloadEpisodeMedia,
  formatBytes,
  groupDownloadsByAnime,
  loadDownloadedEpisodes,
} from './src/services/downloads';
import {
  buildVaultSource,
  FIXED_SOURCES,
  isVaultUrl,
  verifyVaultCode,
  type FixedSource,
} from './src/sources';
import type {
  ActiveDownloadState,
  DownloadedEpisode,
  ExtractionResult,
  HistoryEntry,
  MediaItem,
  PageLink,
} from './src/types';

type BottomTab = 'home' | 'servers' | 'downloads' | 'favorites' | 'history';
type MediaFilterTab = 'videos' | 'images' | 'pdfs' | 'pages';

function isMangaContext(url?: string, adapter?: string): boolean {
  if (adapter === 'leercapitulo' || adapter === 'ext-comic') return true;
  if (!url) return false;
  const lower = url.toLowerCase();
  return (
    lower.includes('leercapitulo.') ||
    lower.includes('/leer/') ||
    lower.includes('/view_uploads/') ||
    lower.includes('/library/') ||
    isVaultUrl(lower)
  );
}

function extractNumericOrder(page: PageLink): number | null {
  const source = `${page.title} ${page.subtitle ?? ''} ${page.url}`;
  const seasonEp = source.match(/(\d+)\s*[xX]\s*(\d+)/);
  if (seasonEp) {
    return parseInt(seasonEp[1], 10) * 10000 + parseInt(seasonEp[2], 10);
  }
  const cap = source.match(/(?:cap[ií]tulo|episodio|ep\.?)\s*(\d+(?:\.\d+)?)/i);
  if (cap) return parseFloat(cap[1]);
  const trailing = page.url.match(/(\d+(?:-\d+)?)\/?$/);
  if (trailing) return parseFloat(trailing[1].replace('-', '.'));
  return null;
}

function detectPagesDescending(pages: PageLink[]): boolean {
  if (pages.length < 2) return true;
  const first = extractNumericOrder(pages[0]);
  const last = extractNumericOrder(pages[pages.length - 1]);
  if (first !== null && last !== null && first !== last) {
    return first > last;
  }
  return true;
}

function formatRemainingTime(position: number, duration: number): string {
  const rem = Math.max(0, Math.round((duration - position) / 60));
  if (rem <= 1) return '<1m rest.';
  if (rem >= 60) {
    const h = Math.floor(rem / 60);
    const m = rem % 60;
    return `${h}h ${m}m rest.`;
  }
  return `${rem}m rest.`;
}

function MainScreen() {
  const { width: windowWidth } = useWindowDimensions();
  const isWide = windowWidth >= 900;
  const gridColumns = windowWidth >= 1080 ? 6 : windowWidth >= 680 ? 4 : 3;

  const [backendUrl, setBackendUrl] = useState(DEFAULT_BACKEND_URL);
  const [accessPin, setAccessPin] = useState('');
  const [activeSource, setActiveSource] = useState<FixedSource>(FIXED_SOURCES[0]);
  const [bottomTab, setBottomTab] = useState<BottomTab>('home');

  const [searchOpen, setSearchOpen] = useState(false);
  const [searchInput, setSearchInput] = useState('');
  const [recentSearches, setRecentSearches] = useState<string[]>([]);
  const [searchSourceFilter, setSearchSourceFilter] = useState<SearchSourceFilter>('all');
  const [vaultUnlocked, setVaultUnlocked] = useState(false);
  const vaultSource = useMemo(() => buildVaultSource(), []);
  const [genresOpen, setGenresOpen] = useState(false);
  const [customUrlInput, setCustomUrlInput] = useState('');

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ExtractionResult | null>(null);
  const [navStack, setNavStack] = useState<ExtractionResult[]>([]);
  const [returnTab, setReturnTab] = useState<BottomTab | null>(null);

  // Detail screen state
  const [synopsisExpanded, setSynopsisExpanded] = useState(false);
  const [episodesAsc, setEpisodesAsc] = useState(false);
  const [episodeFilter, setEpisodeFilter] = useState('');
  const [genericTab, setGenericTab] = useState<MediaFilterTab>('videos');
  const [loadingMore, setLoadingMore] = useState(false);

  // Card action menu ("Ver" / "Información")
  const [actionTarget, setActionTarget] = useState<PageLink | null>(null);

  // Server picker modal ("Elegir servidor")
  const [pickerVisible, setPickerVisible] = useState(false);
  const [pickerLoading, setPickerLoading] = useState(false);
  const [pickerProbing, setPickerProbing] = useState(false);
  const [pickerProbeMap, setPickerProbeMap] = useState<Record<string, ResolvedVideoResponse>>({});
  const [pickerTitle, setPickerTitle] = useState<string | undefined>(undefined);
  const [pickerThumb, setPickerThumb] = useState<string | undefined>(undefined);
  const [pickerVideos, setPickerVideos] = useState<MediaItem[]>([]);
  const [pickerReferer, setPickerReferer] = useState<string | undefined>(undefined);

  // Media player/viewer modal
  const [selectedItem, setSelectedItem] = useState<MediaItem | null>(null);
  const [viewerReferer, setViewerReferer] = useState<string | undefined>(undefined);

  // Settings & local lists
  const [settingsVisible, setSettingsVisible] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [favorites, setFavorites] = useState<HistoryEntry[]>([]);
  const [savedSearchQuery, setSavedSearchQuery] = useState('');
  const [watchedUrls, setWatchedUrls] = useState<string[]>([]);
  const [continueWatching, setContinueWatching] = useState<
    Array<WatchProgress & { url: string }>
  >([]);
  const [customSources, setCustomSources] = useState<FixedSource[]>([]);

  // Offline downloads (mobile) & active download progress (mobile + web)
  const [downloads, setDownloads] = useState<DownloadedEpisode[]>([]);
  const [activeDownloads, setActiveDownloads] = useState<Record<string, ActiveDownloadState>>({});
  const [selectedDownloadAnimeKey, setSelectedDownloadAnimeKey] = useState<string | null>(null);
  const [offlineQueue, setOfflineQueue] = useState<DownloadedEpisode[]>([]);
  const [downloadToast, setDownloadToast] = useState<string | null>(null);

  const requestIdRef = useRef(0);
  const probeIdRef = useRef(0);
  const downloadControllersRef = useRef<Record<string, AbortController>>({});
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastPickerRequestRef = useRef<{ url: string; title?: string; thumbnail?: string } | null>(
    null,
  );

  const triggerServerProbe = (videos: MediaItem[]) => {
    const pid = ++probeIdRef.current;
    setPickerProbeMap({});
    const urls = videos.filter((v) => v.type === 'video').map((v) => v.url);
    if (urls.length === 0) {
      setPickerProbing(false);
      return;
    }
    setPickerProbing(true);
    void resolveVideoBatch(backendUrl, urls, accessPin)
      .then((map) => {
        if (pid === probeIdRef.current) {
          setPickerProbeMap(map);
        }
      })
      .finally(() => {
        if (pid === probeIdRef.current) {
          setPickerProbing(false);
        }
      });
  };

  const refreshContinueWatching = async (): Promise<
    Array<WatchProgress & { url: string }>
  > => {
    const all = await loadPlaybackProgress();
    const list = Object.entries(all)
      .map(([url, p]) => ({ url, ...p }))
      .filter((p) => p.duration > 0 && p.position > 5 && p.position / p.duration < 0.9)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 10);
    setContinueWatching(list);
    return list;
  };

  useEffect(() => {
    void (async () => {
      const [
        savedUrl,
        savedPin,
        savedHistory,
        savedFavs,
        savedWatched,
        savedCustom,
        savedSearches,
        savedDownloads,
      ] = await Promise.all([
        loadBackendUrl(),
        loadAccessPin(),
        loadHistory(),
        loadFavorites(),
        loadWatchedEpisodes(),
        loadCustomSources(),
        loadRecentSearches(),
        loadDownloadedEpisodes(),
      ]);
      setBackendUrl(savedUrl);
      setAccessPin(savedPin);
      setHistory(savedHistory);
      setFavorites(savedFavs);
      setWatchedUrls(savedWatched);
      setCustomSources(savedCustom);
      setRecentSearches(savedSearches);
      setDownloads(savedDownloads);
      const cwList = await refreshContinueWatching();
      await loadUrl(FIXED_SOURCES[0].url, {
        backendOverride: savedUrl,
        pinOverride: savedPin,
        silentHistory: true,
      });
      void backfillMissingThumbnails(savedFavs, cwList, savedUrl, savedPin);
    })();
  }, []);

  const backfillMissingThumbnails = async (
    favList: HistoryEntry[],
    cwList: Array<WatchProgress & { url: string }>,
    bUrl: string,
    pinVal: string,
  ) => {
    const missingFavs = favList
      .filter((f) => !f.thumbnail && !isVaultUrl(f.url))
      .slice(0, 6);
    if (missingFavs.length > 0) {
      const updatedFavs = [...favList];
      let changed = false;
      await Promise.allSettled(
        missingFavs.map(async (fav) => {
          const data = await extractMediaFromUrl(bUrl, fav.url, { pin: pinVal });
          const thumb = data.metadata.poster || data.images[0]?.url;
          if (thumb) {
            const idx = updatedFavs.findIndex((x) => x.url === fav.url);
            if (idx >= 0) {
              updatedFavs[idx] = { ...updatedFavs[idx], thumbnail: thumb };
              changed = true;
            }
          }
        }),
      );
      if (changed) {
        setFavorites(updatedFavs);
        await saveFavoritesList(updatedFavs);
      }
    }

    const missingCw = cwList
      .filter((c) => !c.thumbnail && !isVaultUrl(c.url))
      .slice(0, 5);
    if (missingCw.length > 0) {
      await Promise.allSettled(
        missingCw.map(async (cw) => {
          const data = await extractMediaFromUrl(bUrl, cw.url, { pin: pinVal });
          const thumb = data.metadata.poster || data.images[0]?.url;
          const title = data.metadata.title;
          if (thumb || title) {
            await savePlaybackProgress(cw.url, cw.position, cw.duration, {
              title: title || cw.title,
              thumbnail: thumb || cw.thumbnail,
            });
          }
        }),
      );
      const refreshed = await loadPlaybackProgress();
      setContinueWatching(
        Object.entries(refreshed)
          .map(([url, p]) => ({ url, ...p }))
          .filter((p) => p.duration > 0 && p.position > 5 && p.position / p.duration < 0.9)
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .slice(0, 10),
      );
    }
  };

  const handleSaveBackendUrl = async (newUrl: string, newPin: string) => {
    setBackendUrl(newUrl);
    setAccessPin(newPin);
    await Promise.all([saveBackendUrl(newUrl), saveAccessPin(newPin)]);
    void loadUrl(activeSource.url, {
      backendOverride: newUrl,
      pinOverride: newPin,
      silentHistory: true,
    });
  };

  const handleToggleVault = (unlock: boolean) => {
    if (unlock) {
      setVaultUnlocked(true);
      setActiveSource(vaultSource);
      setGenresOpen(false);
      setBottomTab('home');
      void loadUrl(vaultSource.url, { silentHistory: true });
      return;
    }
    setVaultUnlocked(false);
    if (searchSourceFilter === 'ext_comic') {
      setSearchSourceFilter('all');
    }
    setNavStack((prev) => prev.filter((r) => !isVaultUrl(r.metadata.sourceUrl)));
    if (activeSource.hidden || isVaultUrl(result?.metadata.sourceUrl)) {
      const fallback = FIXED_SOURCES[0];
      setActiveSource(fallback);
      setGenresOpen(false);
      void loadUrl(fallback.url, { silentHistory: true });
    }
  };

  const loadUrl = async (
    targetUrl: string,
    opts?: {
      pushHistory?: boolean;
      preserveStack?: boolean;
      backendOverride?: string;
      pinOverride?: string;
      silentHistory?: boolean;
      refresh?: boolean;
    },
  ) => {
    const clean = targetUrl.trim();
    if (!clean) return;

    const reqId = ++requestIdRef.current;
    Keyboard.dismiss();
    setLoading(true);
    setError(null);
    setSynopsisExpanded(false);
    setEpisodeFilter('');

    try {
      const data = await extractMediaFromUrl(opts?.backendOverride ?? backendUrl, clean, {
        refresh: opts?.refresh,
        pin: opts?.pinOverride ?? accessPin,
      });
      if (reqId !== requestIdRef.current) return;

      if (opts?.pushHistory && result) {
        setNavStack((prev) => [...prev, result]);
        if (Platform.OS === 'web' && typeof globalThis.window !== 'undefined') {
          globalThis.window.history.pushState({ youanimeStep: true }, '');
        }
      } else if (!opts?.pushHistory && !opts?.preserveStack) {
        setNavStack([]);
      }
      setResult(data);
      setBottomTab('home');

      if (data.videos.length > 0) setGenericTab('videos');
      else if (data.pdfs.length > 0) setGenericTab('pdfs');
      else if (data.images.length > 0) setGenericTab('images');
      else setGenericTab('pages');

      if (!opts?.silentHistory) {
        const updated = await addHistoryEntry({
          url: data.metadata.sourceUrl,
          title: data.metadata.title,
          thumbnail: data.metadata.poster || data.images[0]?.url,
          savedAt: Date.now(),
          counts: {
            videos: data.videos.length,
            images: data.images.length,
            pdfs: data.pdfs.length,
          },
        });
        setHistory(updated);
      }
    } catch (err) {
      if (reqId !== requestIdRef.current) return;
      const msg = err instanceof Error ? err.message : 'No se pudo conectar con el servidor';
      setError(msg);
    } finally {
      if (reqId === requestIdRef.current) {
        setLoading(false);
      }
    }
  };

  const toggleVaultRef = useRef(handleToggleVault);
  toggleVaultRef.current = handleToggleVault;

  // Auto-hide vault if app stays in background > 90s on mobile
  useEffect(() => {
    if (Platform.OS === 'web' || !vaultUnlocked) return;
    let bgSince: number | null = null;
    const sub = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'background') {
        bgSince = Date.now();
      } else if (nextState === 'active' && bgSince !== null) {
        if (Date.now() - bgSince > 90_000) {
          toggleVaultRef.current(false);
        }
        bgSince = null;
      }
    });
    return () => sub.remove();
  }, [vaultUnlocked]);

  const openServerPickerForUrl = async (
    episodeUrl: string,
    title?: string,
    thumbnail?: string,
    refresh = false,
  ) => {
    lastPickerRequestRef.current = { url: episodeUrl, title, thumbnail };
    setActionTarget(null);
    setPickerTitle(title);
    setPickerThumb(thumbnail);
    setPickerVideos([]);
    setPickerReferer(episodeUrl);
    setPickerLoading(true);
    setPickerVisible(true);

    try {
      const data = await extractMediaFromUrl(backendUrl, episodeUrl, {
        pin: accessPin,
        refresh,
      });
      const resolvedThumb = thumbnail || data.metadata.poster || data.images[0]?.url;
      if (resolvedThumb) setPickerThumb(resolvedThumb);
      if (data.videos.length === 0 && (data.pages?.length ?? 0) > 0) {
        setPickerVisible(false);
        if (result) setNavStack((prev) => [...prev, result]);
        setResult(data);
        setSynopsisExpanded(false);
        setEpisodeFilter('');
        return;
      }
      setPickerVideos(data.videos);
      triggerServerProbe(data.videos);
      const updated = await addHistoryEntry({
        url: data.metadata.sourceUrl,
        title: data.metadata.title,
        thumbnail: resolvedThumb,
        savedAt: Date.now(),
        counts: {
          videos: data.videos.length,
          images: data.images.length,
          pdfs: data.pdfs.length,
        },
      });
      setHistory(updated);
    } catch (err) {
      setPickerVisible(false);
      Alert.alert(
        'Error',
        err instanceof Error ? err.message : 'No se pudieron cargar los servidores',
      );
    } finally {
      setPickerLoading(false);
    }
  };

  const openMangaForLink = async (link: PageLink) => {
    const reqId = ++requestIdRef.current;
    setActionTarget(null);
    setLoading(true);
    setError(null);
    setEpisodeFilter('');
    try {
      const firstData = await extractMediaFromUrl(backendUrl, link.url, { pin: accessPin });
      if (reqId !== requestIdRef.current) return;

      if (firstData.images.some((img) => img.sourceTag === 'manga-page')) {
        if (result) {
          setNavStack((prev) => [...prev, result]);
          if (Platform.OS === 'web' && typeof globalThis.window !== 'undefined') {
            globalThis.window.history.pushState({ youanimeStep: true }, '');
          }
        }
        setResult(firstData);
        setBottomTab('home');
        return;
      }

      const chapPages = firstData.pages ?? [];
      if (chapPages.length > 0) {
        const desc = detectPagesDescending(chapPages);
        const chrono = desc ? [...chapPages].reverse() : chapPages;
        const targetChap = chrono.find((c) => !watchedUrls.includes(c.url)) ?? chrono[0];
        if (targetChap) {
          const readerData = await extractMediaFromUrl(backendUrl, targetChap.url, {
            pin: accessPin,
          });
          if (reqId !== requestIdRef.current) return;
          setNavStack((prev) => [...prev, ...(result ? [result] : []), firstData]);
          if (Platform.OS === 'web' && typeof globalThis.window !== 'undefined') {
            globalThis.window.history.pushState({ youanimeStep: true }, '');
          }
          setResult(readerData);
          setBottomTab('home');
          return;
        }
      }

      if (result) {
        setNavStack((prev) => [...prev, result]);
      }
      setResult(firstData);
      setSynopsisExpanded(false);
    } catch (err) {
      if (reqId !== requestIdRef.current) return;
      setError(err instanceof Error ? err.message : 'No se pudo abrir el capítulo');
    } finally {
      if (reqId === requestIdRef.current) {
        setLoading(false);
      }
    }
  };

  const openInfoForLink = async (link: PageLink) => {
    const reqId = ++requestIdRef.current;
    setActionTarget(null);
    setLoading(true);
    setError(null);
    setEpisodeFilter('');
    try {
      const firstData = await extractMediaFromUrl(backendUrl, link.url, { pin: accessPin });
      if (reqId !== requestIdRef.current) return;

      if (firstData.metadata.infoUrl) {
        const detailData = await extractMediaFromUrl(backendUrl, firstData.metadata.infoUrl, {
          pin: accessPin,
        });
        if (reqId !== requestIdRef.current) return;
        if (result) {
          setNavStack((prev) => [...prev, result]);
          if (Platform.OS === 'web' && typeof globalThis.window !== 'undefined') {
            globalThis.window.history.pushState({ youanimeStep: true }, '');
          }
        }
        setResult(detailData);
        setSynopsisExpanded(false);
      } else {
        if (result) {
          setNavStack((prev) => [...prev, result]);
          if (Platform.OS === 'web' && typeof globalThis.window !== 'undefined') {
            globalThis.window.history.pushState({ youanimeStep: true }, '');
          }
        }
        setResult(firstData);
        setSynopsisExpanded(false);
      }
    } catch (err) {
      if (reqId !== requestIdRef.current) return;
      setError(err instanceof Error ? err.message : 'No se pudo cargar la información');
    } finally {
      if (reqId === requestIdRef.current) {
        setLoading(false);
      }
    }
  };

  const showDownloadToast = (msg: string) => {
    setDownloadToast(msg);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => {
      setDownloadToast(null);
      toastTimerRef.current = null;
    }, 3600);
  };

  const downloadsByUrl = useMemo(() => {
    const map: Record<string, DownloadedEpisode> = {};
    for (const d of downloads) {
      map[d.episodeUrl] = d;
    }
    return map;
  }, [downloads]);

  const groupedDownloads = useMemo(() => groupDownloadsByAnime(downloads), [downloads]);

  const activeDownloadsList = useMemo(
    () => Object.values(activeDownloads),
    [activeDownloads],
  );

  const playOfflineEpisode = (ep: DownloadedEpisode, groupEpisodes?: DownloadedEpisode[]) => {
    setOfflineQueue(groupEpisodes && groupEpisodes.length > 0 ? groupEpisodes : [ep]);
    setPickerVideos([]);
    setPickerTitle(`${ep.animeTitle} • ${ep.episodeTitle}`);
    setPickerThumb(ep.localThumbnailUri || ep.animeThumbnail);
    setViewerReferer(ep.episodeUrl);
    setSelectedItem({
      id: `offline_${ep.id}`,
      type: 'video',
      url: ep.fileUri,
      title: `${ep.animeTitle} - ${ep.episodeTitle}`,
      thumbnail: ep.localThumbnailUri || ep.animeThumbnail,
      mimeType: 'video/mp4',
      isEmbed: false,
      sourceTag: 'offline',
    });
  };

  const handleCancelDownload = (episodeUrl: string) => {
    const ctrl = downloadControllersRef.current[episodeUrl];
    if (ctrl) {
      ctrl.abort();
      delete downloadControllersRef.current[episodeUrl];
    }
    setActiveDownloads((prev) => {
      if (!(episodeUrl in prev)) return prev;
      const next = { ...prev };
      delete next[episodeUrl];
      return next;
    });
  };

  const handleStartDownload = async (opts: {
    episodeUrl: string;
    episodeTitle: string;
    episodeNumber: number | null;
    animeUrl?: string;
    animeTitle: string;
    animeThumbnail?: string;
    preloadedVideos?: MediaItem[];
  }) => {
    if (activeDownloads[opts.episodeUrl]) {
      handleCancelDownload(opts.episodeUrl);
      showDownloadToast('Descarga cancelada');
      return;
    }

    const existing = downloadsByUrl[opts.episodeUrl];
    if (existing && Platform.OS !== 'web') {
      const grp = groupedDownloads.find((g) => g.animeKey === existing.animeKey);
      playOfflineEpisode(existing, grp?.episodes);
      return;
    }

    const controller = new AbortController();
    downloadControllersRef.current[opts.episodeUrl] = controller;

    setActiveDownloads((prev) => ({
      ...prev,
      [opts.episodeUrl]: {
        episodeUrl: opts.episodeUrl,
        animeTitle: opts.animeTitle,
        episodeTitle: opts.episodeTitle,
        phase: 'resolving',
        progress: 0,
      },
    }));

    try {
      const outcome = await downloadEpisodeMedia({
        backendUrl,
        accessPin,
        animeUrl: opts.animeUrl,
        animeTitle: opts.animeTitle,
        animeThumbnail: opts.animeThumbnail,
        episodeUrl: opts.episodeUrl,
        episodeTitle: opts.episodeTitle,
        episodeNumber: opts.episodeNumber,
        preloadedVideos: opts.preloadedVideos,
        signal: controller.signal,
        onProgress: (st) => {
          setActiveDownloads((prev) => ({
            ...prev,
            [opts.episodeUrl]: st,
          }));
        },
      });

      if (outcome.platform === 'native' && outcome.updatedList) {
        setDownloads(outcome.updatedList);
        showDownloadToast(`Descargado: ${opts.episodeTitle}`);
      } else {
        showDownloadToast(`Descargando: ${outcome.fileName}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'No se pudo descargar el episodio.';
      if (!controller.signal.aborted) {
        if (Platform.OS === 'web') {
          showDownloadToast(`Error: ${msg}`);
        } else {
          Alert.alert('Error al descargar', msg);
        }
      }
    } finally {
      delete downloadControllersRef.current[opts.episodeUrl];
      setActiveDownloads((prev) => {
        if (!(opts.episodeUrl in prev)) return prev;
        const next = { ...prev };
        delete next[opts.episodeUrl];
        return next;
      });
    }
  };

  const handleDeleteDownloadedEpisode = (ep: DownloadedEpisode) => {
    Alert.alert(
      'Eliminar descarga',
      `¿Borrar "${ep.episodeTitle}" del almacenamiento?`,
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Eliminar',
          style: 'destructive',
          onPress: () => {
            void deleteDownloadedEpisode(ep.episodeUrl).then((next) => {
              setDownloads(next);
              const stillHasAnime = next.some((d) => d.animeKey === ep.animeKey);
              if (!stillHasAnime && selectedDownloadAnimeKey === ep.animeKey) {
                setSelectedDownloadAnimeKey(null);
              }
            });
          },
        },
      ],
    );
  };

  const handleDeleteDownloadedAnime = (animeKey: string, animeTitle: string) => {
    Alert.alert(
      'Eliminar anime descargado',
      `¿Borrar todos los episodios descargados de "${animeTitle}"?`,
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Eliminar todo',
          style: 'destructive',
          onPress: () => {
            void deleteDownloadedAnime(animeKey).then((next) => {
              setDownloads(next);
              if (selectedDownloadAnimeKey === animeKey) {
                setSelectedDownloadAnimeKey(null);
              }
            });
          },
        },
      ],
    );
  };

  const handleShareDownloadedEpisode = async (ep: DownloadedEpisode) => {
    try {
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(ep.fileUri, {
          mimeType: 'video/mp4',
          dialogTitle: ep.fileName,
        });
      } else {
        Alert.alert('Archivo guardado', ep.fileUri);
      }
    } catch (err) {
      Alert.alert(
        'Error',
        err instanceof Error ? err.message : 'No se pudo compartir el archivo.',
      );
    }
  };

  const handleGoBack = () => {
    if (selectedItem) {
      setSelectedItem(null);
      setOfflineQueue([]);
      return true;
    }
    if (pickerVisible) {
      setPickerVisible(false);
      return true;
    }
    if (actionTarget) {
      setActionTarget(null);
      return true;
    }
    if (bottomTab === 'downloads' && selectedDownloadAnimeKey) {
      setSelectedDownloadAnimeKey(null);
      return true;
    }
    if (bottomTab !== 'home') {
      setBottomTab('home');
      return true;
    }
    if (navStack.length > 0) {
      const prev = navStack[navStack.length - 1];
      setNavStack((s) => s.slice(0, -1));
      setResult(prev);
      setSynopsisExpanded(false);
      setEpisodeFilter('');
      return true;
    }
    if (returnTab) {
      setBottomTab(returnTab);
      setReturnTab(null);
      return true;
    }
    if (viewMode !== 'catalog') {
      void loadUrl(activeSource.url, { silentHistory: true });
      return true;
    }
    return false;
  };

  const goBackRef = useRef(handleGoBack);
  goBackRef.current = handleGoBack;

  const canPopWebRef = useRef(false);
  canPopWebRef.current =
    navStack.length > 0 ||
    Boolean(selectedItem) ||
    pickerVisible ||
    Boolean(actionTarget) ||
    bottomTab !== 'home';

  // Handle Android hardware back button (registered once)
  useEffect(() => {
    if (Platform.OS === 'web') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => goBackRef.current());
    return () => sub.remove();
  }, []);

  // Handle Web browser back button (popstate — registered once)
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof globalThis.window === 'undefined') return;
    const onPopState = () => {
      if (canPopWebRef.current) {
        goBackRef.current();
      }
    };
    globalThis.window.addEventListener('popstate', onPopState);
    return () => globalThis.window.removeEventListener('popstate', onPopState);
  }, []);

  const handleGlobalSearch = async (
    queryOverride?: string,
    sourceOverride?: SearchSourceFilter,
  ) => {
    const q = (queryOverride ?? searchInput).trim();
    if (!q) return;
    if (verifyVaultCode(q)) {
      setSearchInput('');
      Keyboard.dismiss();
      handleToggleVault(!vaultUnlocked);
      return;
    }
    const srcFilter = sourceOverride ?? searchSourceFilter;
    const reqId = ++requestIdRef.current;
    Keyboard.dismiss();
    setLoading(true);
    setError(null);
    setEpisodeFilter('');
    if (!activeSource.hidden && srcFilter !== 'ext_comic') {
      void addRecentSearch(q).then(setRecentSearches);
    }
    try {
      const data = await globalSearchMedia(backendUrl, q, accessPin, srcFilter);
      if (reqId !== requestIdRef.current) return;
      if (result && result.adapter !== 'global-search') {
        setNavStack((prev) => [...prev, result]);
        if (Platform.OS === 'web' && typeof globalThis.window !== 'undefined') {
          globalThis.window.history.pushState({ youanimeStep: true }, '');
        }
      }
      setResult(data);
      setBottomTab('home');
    } catch (err) {
      if (reqId !== requestIdRef.current) return;
      setError(err instanceof Error ? err.message : 'Error en búsqueda global');
    } finally {
      if (reqId === requestIdRef.current) {
        setLoading(false);
      }
    }
  };

  const handleSearchSubmit = (queryOverride?: string) => {
    const q = (queryOverride ?? searchInput).trim();
    if (!q) return;
    if (verifyVaultCode(q)) {
      setSearchInput('');
      Keyboard.dismiss();
      handleToggleVault(!vaultUnlocked);
      return;
    }
    if (/^https?:\/\//i.test(q)) {
      void loadUrl(q, { pushHistory: true });
    } else if (activeSource.searchUrlTemplate) {
      if (!activeSource.hidden) {
        void addRecentSearch(q).then(setRecentSearches);
      }
      const searchUrl = activeSource.searchUrlTemplate.replace('{q}', encodeURIComponent(q));
      void loadUrl(searchUrl, { pushHistory: true });
    } else {
      void loadUrl(`https://${q}`, { pushHistory: true });
    }
  };

  const handleSurprisePick = () => {
    const list = result?.pages ?? [];
    if (list.length === 0) return;
    const randomItem = list[Math.floor(Math.random() * list.length)];
    if (randomItem) {
      void openInfoForLink(randomItem);
    }
  };

  const handlePasteCustomUrl = async () => {
    const text = await Clipboard.getStringAsync();
    if (text) setCustomUrlInput(text.trim());
  };

  const isFavorite = useMemo(() => {
    if (!result) return false;
    return favorites.some((f) => f.url === result.metadata.sourceUrl);
  }, [favorites, result]);

  const handleToggleFavorite = async () => {
    if (!result) return;
    const next = await toggleFavorite({
      url: result.metadata.sourceUrl,
      title: result.metadata.title,
      thumbnail: result.metadata.poster || result.images[0]?.url,
      savedAt: Date.now(),
      counts: {
        videos: result.videos.length,
        images: result.images.length,
        pdfs: result.pdfs.length,
      },
    });
    setFavorites(next);
  };

  const visibleSources = useMemo(
    () => [
      ...FIXED_SOURCES,
      ...(vaultUnlocked ? [vaultSource] : []),
      ...customSources.filter((s) => vaultUnlocked || !isVaultUrl(s.url)),
    ],
    [vaultUnlocked, vaultSource, customSources],
  );

  const visibleFavorites = useMemo(
    () => (vaultUnlocked ? favorites : favorites.filter((f) => !isVaultUrl(f.url))),
    [favorites, vaultUnlocked],
  );

  const visibleHistory = useMemo(
    () => (vaultUnlocked ? history : history.filter((h) => !isVaultUrl(h.url))),
    [history, vaultUnlocked],
  );

  const visibleContinueWatching = useMemo(
    () =>
      vaultUnlocked
        ? continueWatching
        : continueWatching.filter((c) => !isVaultUrl(c.url)),
    [continueWatching, vaultUnlocked],
  );

  // Detect whether current result is a Catalog Grid, Detail screen, Manga Reader, or Generic Media page
  const viewMode = useMemo<'catalog' | 'detail' | 'reader' | 'generic'>(() => {
    if (!result) return 'catalog';
    if (result.images.some((img) => img.sourceTag === 'manga-page')) {
      return 'reader';
    }
    const pages = result.pages ?? [];
    const path = (() => {
      try {
        return new URL(result.metadata.sourceUrl).pathname;
      } catch {
        return '';
      }
    })();

    if (result.adapter === 'animeflv') {
      const isDetailUrl =
        /\/anime\/[^/]+\/?$/.test(path) || (result.videos.length > 0 && pages.length > 0);
      if (isDetailUrl) return 'detail';
      if (pages.length > 0) return 'catalog';
    }
    if (result.adapter === 'jkanime') {
      const cleanPath = path.replace(/^\/+|\/+$/g, '');
      const isJkDetail =
        result.videos.length > 0 ||
        (pages.length > 0 &&
          Boolean(cleanPath) &&
          !cleanPath.includes('/') &&
          !/^(directorio|buscar|horario|top|estrenos)$/i.test(cleanPath));
      if (isJkDetail) return 'detail';
      if (pages.length > 0) return 'catalog';
    }
    if (result.adapter === 'hackstore') {
      if (result.videos.length > 0 || /^\/series\/[^/]+\/?$/.test(path)) {
        return 'detail';
      }
      if (pages.length > 0) return 'catalog';
    }
    if (result.adapter === 'leercapitulo') {
      const segs = path.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
      if (path.startsWith('/manga/') && segs.length >= 2) {
        return 'detail';
      }
      if (pages.length > 0) return 'catalog';
    }
    if (result.adapter === 'ext-comic') {
      if (path.startsWith('/library/')) {
        return 'detail';
      }
      if (pages.length > 0) return 'catalog';
    }
    if (pages.length > 0 && result.videos.length === 0 && result.pdfs.length === 0) {
      return 'catalog';
    }
    return 'generic';
  }, [result]);

  const pagesDescending = useMemo(
    () => detectPagesDescending(result?.pages ?? []),
    [result],
  );

  const sortedEpisodes = useMemo(() => {
    const list = result?.pages ?? [];
    const ordered = episodesAsc ? [...list].reverse() : list;
    const q = episodeFilter.trim().toLowerCase();
    if (!q) return ordered;
    return ordered.filter(
      (ep) =>
        ep.title.toLowerCase().includes(q) ||
        (ep.subtitle && ep.subtitle.toLowerCase().includes(q)),
    );
  }, [result, episodesAsc, episodeFilter]);

  const currentOfflineIndex = useMemo(() => {
    if (offlineQueue.length === 0 || !viewerReferer) return -1;
    return offlineQueue.findIndex((e) => e.episodeUrl === viewerReferer);
  }, [offlineQueue, viewerReferer]);

  const currentEpisodeIndex = useMemo(() => {
    if (!viewerReferer || !result?.pages) return -1;
    return result.pages.findIndex((p) => p.url === viewerReferer);
  }, [viewerReferer, result]);

  const hasPrevEpisode = useMemo(() => {
    if (offlineQueue.length > 0 && currentOfflineIndex >= 0) {
      return currentOfflineIndex > 0;
    }
    if (!result?.pages || currentEpisodeIndex < 0) return false;
    return pagesDescending
      ? currentEpisodeIndex + 1 < result.pages.length
      : currentEpisodeIndex > 0;
  }, [offlineQueue, currentOfflineIndex, result, currentEpisodeIndex, pagesDescending]);

  const hasNextEpisode = useMemo(() => {
    if (offlineQueue.length > 0 && currentOfflineIndex >= 0) {
      return currentOfflineIndex + 1 < offlineQueue.length;
    }
    if (!result?.pages || currentEpisodeIndex < 0) return false;
    return pagesDescending
      ? currentEpisodeIndex > 0
      : currentEpisodeIndex + 1 < result.pages.length;
  }, [offlineQueue, currentOfflineIndex, result, currentEpisodeIndex, pagesDescending]);

  const handleStepEpisode = async (direction: 'prev' | 'next') => {
    if (offlineQueue.length > 0 && currentOfflineIndex >= 0) {
      const target =
        offlineQueue[currentOfflineIndex + (direction === 'next' ? 1 : -1)];
      if (target) {
        playOfflineEpisode(target, offlineQueue);
      }
      return;
    }
    if (!result?.pages || currentEpisodeIndex < 0) return;
    const delta =
      direction === 'next'
        ? pagesDescending
          ? -1
          : 1
        : pagesDescending
          ? 1
          : -1;
    const targetEp = result.pages[currentEpisodeIndex + delta];
    if (!targetEp) return;
    setSelectedItem(null);
    await openServerPickerForUrl(
      targetEp.url,
      targetEp.title,
      targetEp.thumbnail || result.metadata.poster,
    );
  };

  const handleLoadMore = async () => {
    if (!result?.nextPageUrl || loadingMore) return;
    setLoadingMore(true);
    try {
      const more = await extractMediaFromUrl(backendUrl, result.nextPageUrl, {
        pin: accessPin,
      });
      const existingIds = new Set((result.pages ?? []).map((p) => p.id));
      const newPages = (more.pages ?? []).filter((p) => !existingIds.has(p.id));
      setResult({
        ...result,
        pages: [...(result.pages ?? []), ...newPages],
        nextPageUrl: more.nextPageUrl,
      });
    } catch {
      // ignore pagination errors
    } finally {
      setLoadingMore(false);
    }
  };

  const handlePinCustomSource = async () => {
    const clean = customUrlInput.trim();
    if (!clean) return;
    const normalized = /^https?:\/\//i.test(clean) ? clean : `https://${clean}`;
    let name = normalized;
    try {
      name = new URL(normalized).hostname.replace(/^www\./, '');
    } catch {
      return;
    }
    if (customSources.some((s) => s.url === normalized)) return;
    const next: FixedSource[] = [
      ...customSources,
      {
        id: `custom-${Date.now()}`,
        name,
        url: normalized,
        description: 'Página fijada por ti',
        color: '#a855f7',
      },
    ];
    setCustomSources(next);
    await saveCustomSources(next);
  };

  const handleRemoveCustomSource = async (id: string) => {
    const next = customSources.filter((s) => s.id !== id);
    setCustomSources(next);
    await saveCustomSources(next);
  };

  const groupedCatalogSections = useMemo(() => {
    const pages = result?.pages ?? [];
    const hasGroups = pages.some((p) => Boolean(p.group));
    if (!hasGroups) return null;
    const groups: { title: string; items: PageLink[] }[] = [];
    for (const p of pages) {
      const label = p.group || 'Otros';
      const existing = groups.find((g) => g.title === label);
      if (existing) existing.items.push(p);
      else groups.push({ title: label, items: [p] });
    }
    return groups;
  }, [result]);

  const handleDismissContinueWatching = async (url: string) => {
    await removePlaybackProgress(url);
    setContinueWatching((prev) => prev.filter((c) => c.url !== url));
  };

  const renderSkeletonGrid = () => {
    const count = gridColumns * 3;
    const items = Array.from({ length: count });
    const rows: number[][] = [];
    for (let i = 0; i < items.length; i += gridColumns) {
      rows.push(
        Array.from({ length: Math.min(gridColumns, items.length - i) }, (_, idx) => i + idx),
      );
    }
    return (
      <ScrollView
        style={styles.flex1}
        contentContainerStyle={[styles.gridContainer, isWide && styles.wideContainer]}
      >
        <View style={styles.skeletonStatusRow}>
          <ActivityIndicator size="small" color="#818cf8" />
          <Text style={styles.mutedText}>Cargando {activeSource.name}...</Text>
        </View>
        {rows.map((row, rIdx) => (
          <View key={`sk-row-${rIdx}`} style={styles.dayGridRow}>
            {row.map((idx) => (
              <View key={`sk-${idx}`} style={[styles.posterCard, { flex: 1 / gridColumns }]}>
                <View style={[styles.posterImg, styles.skeletonBlock]} />
                <View style={styles.skeletonLine} />
                <View style={[styles.skeletonLine, { width: '62%' }]} />
              </View>
            ))}
          </View>
        ))}
      </ScrollView>
    );
  };

  const renderPosterCard = (item: PageLink) => {
    const refererForThumb = result?.metadata.sourceUrl?.startsWith('search://')
      ? item.url
      : result?.metadata.sourceUrl;
    const thumbUri = item.thumbnail
      ? buildProxyUrl(backendUrl, item.thumbnail, refererForThumb, accessPin)
      : undefined;
    const mangaCard = isMangaContext(item.url, result?.adapter);
    return (
      <TouchableOpacity
        key={item.id}
        style={[styles.posterCard, { flex: 1 / gridColumns }]}
        onPress={() => setActionTarget(item)}
        activeOpacity={0.85}
      >
        <View style={styles.posterMediaWrap}>
          {thumbUri ? (
            <Image source={{ uri: thumbUri }} style={styles.posterImg} resizeMode="cover" />
          ) : (
            <View style={[styles.posterImg, styles.posterPlaceholder]}>
              <Ionicons
                name={mangaCard ? 'book-outline' : 'film-outline'}
                size={28}
                color="#52525b"
              />
            </View>
          )}
          {item.subtitle ? (
            <View style={styles.posterBadge}>
              <Text style={styles.posterBadgeText} numberOfLines={1}>
                {item.subtitle}
              </Text>
            </View>
          ) : null}
        </View>
        <Text style={styles.posterTitle} numberOfLines={2}>
          {item.title}
        </Text>
      </TouchableOpacity>
    );
  };

  const renderCatalogView = () => {
    const pages = result?.pages ?? [];
    const allSources = visibleSources;
    const isGlobalSearch = result?.adapter === 'global-search';

    return (
      <View style={styles.flex1}>
        {/* Top Source Bar */}
        <View style={[styles.catalogHeader, isWide && styles.wideContainer]}>
          <View style={styles.sourceSwitchRow}>
            {navStack.length > 0 && (
              <TouchableOpacity
                style={styles.backPillBtn}
                onPress={() => handleGoBack()}
                activeOpacity={0.8}
              >
                <Ionicons name="arrow-back" size={18} color="#f1f5f9" />
                <Text style={styles.backPillText}>Atrás</Text>
              </TouchableOpacity>
            )}
            {isWide ? (
              allSources.map((src) => {
                const selected = activeSource.id === src.id;
                return (
                  <TouchableOpacity
                    key={src.id}
                    style={[styles.sourcePill, selected && styles.sourcePillSelected]}
                    onPress={() => {
                      setActiveSource(src);
                      setGenresOpen(false);
                      void loadUrl(src.url, { silentHistory: true });
                    }}
                    activeOpacity={0.8}
                  >
                    <View style={[styles.sourceDot, { backgroundColor: src.color }]}>
                      <Ionicons
                        name={src.kind === 'manga' ? 'book' : 'play'}
                        size={11}
                        color="#09090b"
                      />
                    </View>
                    <Text style={styles.sourcePillText}>{src.name}</Text>
                  </TouchableOpacity>
                );
              })
            ) : (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.mobileSourceStrip}
                style={styles.mobileSourceScroll}
              >
                {allSources.map((src) => {
                  const selected = activeSource.id === src.id;
                  return (
                    <TouchableOpacity
                      key={src.id}
                      style={[styles.sourcePill, selected && styles.sourcePillSelected]}
                      onPress={() => {
                        setActiveSource(src);
                        setGenresOpen(false);
                        void loadUrl(src.url, { silentHistory: true });
                      }}
                      activeOpacity={0.8}
                    >
                      <View style={[styles.sourceDot, { backgroundColor: src.color }]}>
                        <Ionicons
                          name={src.kind === 'manga' ? 'book' : 'play'}
                          size={10}
                          color="#09090b"
                        />
                      </View>
                      <Text style={styles.sourcePillText}>{src.name}</Text>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            )}
          </View>

          <View style={styles.headerIcons}>
            {vaultUnlocked && (
              <TouchableOpacity
                style={styles.headerIconBtn}
                onPress={() => handleToggleVault(false)}
              >
                <Ionicons name="eye-off-outline" size={20} color="#f472b6" />
              </TouchableOpacity>
            )}
            {pages.length > 2 && (
              <TouchableOpacity
                style={styles.headerIconBtn}
                onPress={handleSurprisePick}
              >
                <Ionicons name="dice-outline" size={21} color="#c4b5fd" />
              </TouchableOpacity>
            )}
            <TouchableOpacity
              style={[styles.headerIconBtn, searchOpen && styles.headerIconBtnActive]}
              onPress={() => setSearchOpen((v) => !v)}
            >
              <Ionicons name="search" size={21} color={searchOpen ? '#818cf8' : '#e2e8f0'} />
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.headerIconBtn}
              onPress={() =>
                void loadUrl(result?.metadata.sourceUrl || activeSource.url, {
                  silentHistory: true,
                  refresh: true,
                })
              }
            >
              <Ionicons name="refresh" size={20} color="#e2e8f0" />
            </TouchableOpacity>
          </View>
        </View>

        {!isGlobalSearch && activeSource.sections && activeSource.sections.length > 0 && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.sectionsScroll}
            contentContainerStyle={[
              styles.sectionsContainer,
              isWide && styles.wideContainer,
            ]}
          >
            {activeSource.sections.map((sec) => {
              const isCurrent = result?.metadata.sourceUrl === sec.url;
              return (
                <TouchableOpacity
                  key={sec.url}
                  style={[styles.sectionChip, isCurrent && styles.sectionChipActive]}
                  onPress={() =>
                    void loadUrl(sec.url, { pushHistory: true, silentHistory: true })
                  }
                >
                  <Text
                    style={[
                      styles.sectionChipText,
                      isCurrent && styles.sectionChipTextActive,
                    ]}
                  >
                    {sec.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
            {activeSource.genres && activeSource.genres.length > 0 && (
              <TouchableOpacity
                style={[styles.sectionChip, genresOpen && styles.sectionChipActive]}
                onPress={() => setGenresOpen((v) => !v)}
              >
                <View style={styles.chipIconRow}>
                  <Ionicons
                    name="pricetag-outline"
                    size={13}
                    color={genresOpen ? '#ffffff' : '#c4b5fd'}
                  />
                  <Text
                    style={[
                      styles.sectionChipText,
                      genresOpen && styles.sectionChipTextActive,
                    ]}
                  >
                    Géneros
                  </Text>
                </View>
              </TouchableOpacity>
            )}
          </ScrollView>
        )}

        {!isGlobalSearch && genresOpen && activeSource.genres && activeSource.genres.length > 0 && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.sectionsScroll}
            contentContainerStyle={[
              styles.sectionsContainer,
              isWide && styles.wideContainer,
            ]}
          >
            {activeSource.genres.map((g) => {
              const isCurrent = result?.metadata.sourceUrl === g.url;
              return (
                <TouchableOpacity
                  key={g.url}
                  style={[styles.genreExploreChip, isCurrent && styles.sectionChipActive]}
                  onPress={() => {
                    setGenresOpen(false);
                    void loadUrl(g.url, { pushHistory: true, silentHistory: true });
                  }}
                >
                  <Text
                    style={[
                      styles.genreExploreText,
                      isCurrent && styles.sectionChipTextActive,
                    ]}
                  >
                    {g.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        )}

        {isGlobalSearch && (
          <View style={[styles.searchFilterBar, isWide && styles.wideContainer]}>
            <Text style={styles.searchResultBanner} numberOfLines={1}>
              {result?.metadata.title} ({pages.length})
            </Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.searchFilterPills}
            >
              {(
                [
                  { key: 'all', label: 'Todos' },
                  { key: 'animeflv', label: 'AnimeFLV' },
                  { key: 'jkanime', label: 'JKAnime' },
                  { key: 'hackstore', label: 'Hackstore' },
                  { key: 'leercapitulo', label: 'LeerCapitulo' },
                  ...(vaultUnlocked
                    ? ([{ key: 'ext_comic', label: vaultSource.name }] as const)
                    : []),
                ] as { key: SearchSourceFilter; label: string }[]
              ).map((opt) => {
                const active = searchSourceFilter === opt.key;
                return (
                  <TouchableOpacity
                    key={opt.key}
                    style={[styles.sectionChip, active && styles.sectionChipActive]}
                    onPress={() => {
                      setSearchSourceFilter(opt.key);
                      void handleGlobalSearch(undefined, opt.key);
                    }}
                  >
                    <Text
                      style={[styles.sectionChipText, active && styles.sectionChipTextActive]}
                    >
                      {opt.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </View>
        )}

        {(searchOpen || isWide) && (
          <View style={[styles.searchContainer, isWide && styles.wideContainer]}>
            <View style={styles.searchBarRow}>
              <View style={styles.searchInputWrap}>
                <TextInput
                  style={styles.searchInput}
                  value={searchInput}
                  onChangeText={setSearchInput}
                  placeholder={`Buscar en ${activeSource.name} o pegar URL...`}
                  placeholderTextColor="#71717a"
                  autoCapitalize="none"
                  autoCorrect={false}
                  returnKeyType="search"
                  onSubmitEditing={() => handleSearchSubmit()}
                />
                {searchInput.length > 0 && (
                  <TouchableOpacity
                    onPress={() => setSearchInput('')}
                    style={styles.clearInputBtn}
                  >
                    <Ionicons name="close-circle" size={17} color="#71717a" />
                  </TouchableOpacity>
                )}
              </View>
              <TouchableOpacity
                style={styles.searchGoBtn}
                onPress={() => handleSearchSubmit()}
              >
                <Ionicons name="arrow-forward" size={18} color="#ffffff" />
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.globalSearchBtn}
                onPress={() => void handleGlobalSearch()}
              >
                <Ionicons name="sparkles-outline" size={15} color="#e0e7ff" />
                <Text style={styles.globalSearchText}>Todas</Text>
              </TouchableOpacity>
            </View>

            {recentSearches.length > 0 && (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.recentRow}
              >
                {recentSearches.map((term) => (
                  <TouchableOpacity
                    key={term}
                    style={styles.recentChip}
                    onPress={() => {
                      setSearchInput(term);
                      void handleGlobalSearch(term);
                    }}
                  >
                    <Ionicons name="time-outline" size={12} color="#94a3b8" />
                    <Text style={styles.recentChipText}>{term}</Text>
                  </TouchableOpacity>
                ))}
                <TouchableOpacity
                  style={styles.recentClearBtn}
                  onPress={() => {
                    void clearRecentSearches();
                    setRecentSearches([]);
                  }}
                >
                  <Text style={styles.recentClearText}>Limpiar</Text>
                </TouchableOpacity>
              </ScrollView>
            )}
          </View>
        )}

        {visibleContinueWatching.length > 0 && navStack.length === 0 && (
          <View style={[styles.cwSection, isWide && styles.wideContainer]}>
            <Text style={styles.cwHeading}>Seguir viendo</Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.cwRow}
            >
              {visibleContinueWatching.map((cw) => {
                const ratio = Math.min(1, Math.max(0.05, cw.position / cw.duration));
                const thumbUri = cw.thumbnail
                  ? buildProxyUrl(backendUrl, cw.thumbnail, cw.url, accessPin)
                  : undefined;
                return (
                  <TouchableOpacity
                    key={cw.url}
                    style={styles.cwCard}
                    onPress={() =>
                      void openServerPickerForUrl(
                        cw.url,
                        cw.title || 'Continuar',
                        cw.thumbnail,
                      )
                    }
                    activeOpacity={0.85}
                  >
                    <View style={styles.cwThumbWrap}>
                      {thumbUri ? (
                        <Image
                          source={{ uri: thumbUri }}
                          style={styles.cwImg}
                          resizeMode="cover"
                        />
                      ) : (
                        <View style={[styles.cwImg, styles.posterPlaceholder]}>
                          <Ionicons name="play-circle" size={28} color="#818cf8" />
                        </View>
                      )}
                      <View style={styles.cwRemBadge}>
                        <Text style={styles.cwRemText}>
                          {formatRemainingTime(cw.position, cw.duration)}
                        </Text>
                      </View>
                      <TouchableOpacity
                        style={styles.cwDismissBtn}
                        onPress={() => void handleDismissContinueWatching(cw.url)}
                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                      >
                        <Ionicons name="close" size={13} color="#f8fafc" />
                      </TouchableOpacity>
                    </View>
                    <View style={styles.cwBarTrack}>
                      <View style={[styles.cwBarFill, { width: `${ratio * 100}%` }]} />
                    </View>
                    <Text style={styles.cwTitle} numberOfLines={1}>
                      {cw.title || cw.url}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </View>
        )}

        {error && (
          <View style={styles.errorBox}>
            <Ionicons name="alert-circle-outline" size={18} color="#fca5a5" />
            <Text style={styles.errorText}>{error}</Text>
            <TouchableOpacity onPress={() => setSettingsVisible(true)}>
              <Text style={styles.errorAction}>Configurar</Text>
            </TouchableOpacity>
          </View>
        )}

        {loading && pages.length === 0 ? (
          renderSkeletonGrid()
        ) : groupedCatalogSections ? (
          <ScrollView
            style={styles.flex1}
            contentContainerStyle={[
              styles.gridContainer,
              isWide && styles.wideContainer,
            ]}
            refreshControl={
              <RefreshControl
                refreshing={loading}
                tintColor="#818cf8"
                onRefresh={() =>
                  void loadUrl(result?.metadata.sourceUrl || activeSource.url, {
                    silentHistory: true,
                    refresh: true,
                  })
                }
              />
            }
          >
            {groupedCatalogSections.map((sec) => {
              const rows: PageLink[][] = [];
              for (let i = 0; i < sec.items.length; i += gridColumns) {
                rows.push(sec.items.slice(i, i + gridColumns));
              }
              return (
                <View key={sec.title} style={styles.dayGroupSection}>
                  <View style={styles.dayGroupHeader}>
                    <Ionicons name="calendar-outline" size={16} color="#818cf8" />
                    <Text style={styles.dayGroupTitle}>{sec.title}</Text>
                    <Text style={styles.dayGroupCount}>({sec.items.length})</Text>
                  </View>
                  {rows.map((row, rIdx) => (
                    <View key={`${sec.title}-${rIdx}`} style={styles.dayGridRow}>
                      {row.map((item) => renderPosterCard(item))}
                      {row.length < gridColumns &&
                        Array.from({ length: gridColumns - row.length }).map((_, padIdx) => (
                          <View
                            key={`pad-${padIdx}`}
                            style={[styles.posterCard, { flex: 1 / gridColumns }]}
                          />
                        ))}
                    </View>
                  ))}
                </View>
              );
            })}
            {result?.nextPageUrl && (
              <TouchableOpacity
                style={styles.loadMoreBtn}
                onPress={() => void handleLoadMore()}
                disabled={loadingMore}
              >
                {loadingMore ? (
                  <ActivityIndicator size="small" color="#e0e7ff" />
                ) : (
                  <Text style={styles.loadMoreText}>Cargar más</Text>
                )}
              </TouchableOpacity>
            )}
          </ScrollView>
        ) : (
          <FlatList
            key={`grid-${gridColumns}`}
            data={pages}
            keyExtractor={(item) => item.id}
            numColumns={gridColumns}
            columnWrapperStyle={styles.gridRow}
            contentContainerStyle={[
              styles.gridContainer,
              isWide && styles.wideContainer,
            ]}
            refreshing={loading}
            onRefresh={() =>
              void loadUrl(result?.metadata.sourceUrl || activeSource.url, {
                silentHistory: true,
                refresh: true,
              })
            }
            renderItem={({ item }) => renderPosterCard(item)}
            ListFooterComponent={
              result?.nextPageUrl ? (
                <TouchableOpacity
                  style={styles.loadMoreBtn}
                  onPress={() => void handleLoadMore()}
                  disabled={loadingMore}
                >
                  {loadingMore ? (
                    <ActivityIndicator size="small" color="#e0e7ff" />
                  ) : (
                    <Text style={styles.loadMoreText}>Cargar más</Text>
                  )}
                </TouchableOpacity>
              ) : undefined
            }
            ListEmptyComponent={
              <View style={styles.centerBox}>
                <Ionicons name="cloud-offline-outline" size={42} color="#52525b" />
                <Text style={styles.mutedText}>
                  Sin resultados. Verifica que el backend esté corriendo en {backendUrl}.
                </Text>
                <TouchableOpacity
                  style={styles.primaryPillBtn}
                  onPress={() => setSettingsVisible(true)}
                >
                  <Text style={styles.primaryPillBtnText}>Configurar Servidor</Text>
                </TouchableOpacity>
              </View>
            }
          />
        )}
      </View>
    );
  };

  const renderDetailView = () => {
    if (!result) return null;
    const posterRaw = result.metadata.poster || result.images[0]?.url;
    const posterUri = posterRaw
      ? buildProxyUrl(backendUrl, posterRaw, result.metadata.sourceUrl, accessPin)
      : undefined;
    const backdropRaw = result.metadata.backdrop || posterRaw;
    const backdropUri = backdropRaw
      ? buildProxyUrl(backendUrl, backdropRaw, result.metadata.sourceUrl, accessPin)
      : undefined;

    const allPages = result.pages ?? [];
    const relatedList = result.related ?? [];
    const genresList = result.metadata.genres ?? [];
    const isMangaDetail = isMangaContext(result.metadata.sourceUrl, result.adapter);
    const watchedCount = allPages.filter((p) => watchedUrls.includes(p.url)).length;
    const chronologicalPages = pagesDescending ? [...allPages].reverse() : allPages;
    const nextUnwatchedEp =
      chronologicalPages.find((ep) => !watchedUrls.includes(ep.url)) ??
      chronologicalPages[0];

    return (
      <ScrollView
        style={styles.flex1}
        contentContainerStyle={[styles.detailScroll, isWide && styles.wideContainer]}
      >
        {/* Blurred Backdrop Hero */}
        <View style={styles.heroContainer}>
          {backdropUri ? (
            <Image
              source={{ uri: backdropUri }}
              style={styles.heroBackdrop}
              blurRadius={result.metadata.backdrop ? 6 : 16}
              resizeMode="cover"
            />
          ) : (
            <View style={[styles.heroBackdrop, { backgroundColor: '#1e1b4b' }]} />
          )}
          <View style={styles.heroOverlay} />

          <View style={styles.heroTopActions}>
            <TouchableOpacity onPress={() => handleGoBack()} style={styles.circleIconBtn}>
              <Ionicons name="arrow-back" size={22} color="#f8fafc" />
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => void handleToggleFavorite()}
              style={styles.circleIconBtn}
            >
              <Ionicons
                name={isFavorite ? 'heart' : 'heart-outline'}
                size={22}
                color={isFavorite ? '#f43f5e' : '#f8fafc'}
              />
            </TouchableOpacity>
          </View>

          <View style={styles.heroInfoRow}>
            {posterUri ? (
              <Image
                source={{ uri: posterUri }}
                style={styles.detailPoster}
                resizeMode="cover"
              />
            ) : (
              <View style={[styles.detailPoster, styles.posterPlaceholder]}>
                <Ionicons name="tv-outline" size={32} color="#71717a" />
              </View>
            )}
            <View style={styles.heroTitleBlock}>
              <Text style={styles.detailTitle} numberOfLines={3}>
                {result.metadata.title}
              </Text>
              <View style={styles.metaBadgesRow}>
                {result.metadata.rating ? (
                  <View style={styles.ratingBadge}>
                    <Ionicons name="star" size={12} color="#fbbf24" />
                    <Text style={styles.ratingBadgeText}>{result.metadata.rating}</Text>
                  </View>
                ) : null}
                {result.metadata.year ? (
                  <View style={styles.metaBadge}>
                    <Text style={styles.metaBadgeText}>{result.metadata.year}</Text>
                  </View>
                ) : null}
                {result.metadata.duration ? (
                  <View style={styles.metaBadge}>
                    <Text style={styles.metaBadgeText}>{result.metadata.duration}</Text>
                  </View>
                ) : null}
                {result.metadata.status ? (
                  <View style={styles.metaBadge}>
                    <Text style={styles.metaBadgeText}>{result.metadata.status}</Text>
                  </View>
                ) : null}
              </View>
              {allPages.length > 0 && (
                <View style={styles.progressSummaryWrap}>
                  <Text style={styles.progressSummaryText}>
                    {watchedCount} / {allPages.length} {isMangaDetail ? 'leídos' : 'vistos'}
                  </Text>
                  <View style={styles.progressSummaryTrack}>
                    <View
                      style={[
                        styles.progressSummaryFill,
                        { width: `${Math.round((watchedCount / allPages.length) * 100)}%` },
                      ]}
                    />
                  </View>
                </View>
              )}
            </View>
          </View>
        </View>

        {/* Genre Chips */}
        {genresList.length > 0 && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.detailGenresRow}
          >
            {genresList.map((g) => (
              <TouchableOpacity
                key={g.label}
                style={styles.detailGenreChip}
                disabled={!g.url}
                onPress={() => {
                  if (g.url) void loadUrl(g.url, { pushHistory: true, silentHistory: true });
                }}
              >
                <Text style={styles.detailGenreText}>{g.label}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        )}

        {/* Quick Play + Download if current page already has videos (e.g. movies) */}
        {result.videos.length > 0 && (() => {
          const movieDl = activeDownloads[result.metadata.sourceUrl];
          const movieSaved =
            Platform.OS !== 'web' ? downloadsByUrl[result.metadata.sourceUrl] : undefined;
          return (
            <View style={styles.detailActionRow}>
              <TouchableOpacity
                style={[styles.watchNowBtn, styles.watchNowFlex]}
                onPress={() => {
                  setOfflineQueue([]);
                  setPickerTitle(result.metadata.title);
                  setPickerThumb(result.metadata.poster || result.images[0]?.url);
                  setPickerVideos(result.videos);
                  setPickerReferer(result.metadata.sourceUrl);
                  setPickerLoading(false);
                  setPickerVisible(true);
                  triggerServerProbe(result.videos);
                }}
              >
                <Ionicons name="play-circle" size={22} color="#ffffff" />
                <Text style={styles.watchNowText} numberOfLines={1}>
                  Reproducir ({result.videos.length})
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.downloadMovieBtn,
                  movieSaved && styles.downloadMovieBtnDone,
                ]}
                onPress={() =>
                  void handleStartDownload({
                    episodeUrl: result.metadata.sourceUrl,
                    episodeTitle: result.metadata.title,
                    episodeNumber: 1,
                    animeUrl: result.metadata.sourceUrl,
                    animeTitle: result.metadata.title,
                    animeThumbnail: result.metadata.poster || result.images[0]?.url,
                    preloadedVideos: result.videos,
                  })
                }
              >
                {movieDl ? (
                  <>
                    <ActivityIndicator size="small" color="#c7d2fe" />
                    <Text style={styles.downloadMovieBtnText}>
                      {movieDl.phase === 'resolving'
                        ? '...'
                        : movieDl.phase === 'preparing'
                          ? `Prep ${movieDl.progress}%`
                          : `${movieDl.progress}%`}
                    </Text>
                  </>
                ) : movieSaved ? (
                  <>
                    <Ionicons name="cloud-done" size={20} color="#34d399" />
                    <Text style={[styles.downloadMovieBtnText, { color: '#34d399' }]}>
                      Offline
                    </Text>
                  </>
                ) : (
                  <>
                    <Ionicons name="download-outline" size={20} color="#e0e7ff" />
                    <Text style={styles.downloadMovieBtnText}>Descargar</Text>
                  </>
                )}
              </TouchableOpacity>
            </View>
          );
        })()}

        {/* Smart Continue / Start Next Episode or Chapter CTA */}
        {result.videos.length === 0 && nextUnwatchedEp && (
          <TouchableOpacity
            style={styles.watchNowBtn}
            onPress={() => {
              if (isMangaDetail) {
                void loadUrl(nextUnwatchedEp.url, { pushHistory: true });
                return;
              }
              void openServerPickerForUrl(
                nextUnwatchedEp.url,
                nextUnwatchedEp.title,
                nextUnwatchedEp.thumbnail || result.metadata.poster,
              );
            }}
          >
            <Ionicons
              name={isMangaDetail ? 'book' : 'play-circle'}
              size={21}
              color="#ffffff"
            />
            <Text style={styles.watchNowText} numberOfLines={1}>
              {watchedCount > 0 ? 'Continuar' : isMangaDetail ? 'Leer' : 'Ver'}:{' '}
              {nextUnwatchedEp.title}
            </Text>
          </TouchableOpacity>
        )}

        {/* Sinopsis */}
        {result.metadata.description ? (
          <View style={styles.synopsisSection}>
            <Text style={styles.detailSectionTitle}>Sinopsis</Text>
            <Text
              style={styles.synopsisText}
              numberOfLines={synopsisExpanded ? undefined : 3}
            >
              {result.metadata.description}
            </Text>
            <TouchableOpacity onPress={() => setSynopsisExpanded((v) => !v)}>
              <Text style={styles.seeMoreLink}>
                {synopsisExpanded ? 'Ver menos' : '... Ver más'}
              </Text>
            </TouchableOpacity>
          </View>
        ) : null}

        {/* Episodios / Capítulos */}
        {allPages.length > 0 && (
          <View style={styles.episodesSection}>
            <View style={styles.episodesHeaderRow}>
              <View>
                <Text style={styles.detailSectionTitle}>
                  {isMangaDetail ? 'Capítulos' : 'Episodios'} ({sortedEpisodes.length})
                </Text>
                <Text style={styles.epHintText}>
                  Mantén pulsado para marcar como {isMangaDetail ? 'leído' : 'visto'}
                </Text>
              </View>
              <View style={styles.episodesControlsRow}>
                <TextInput
                  style={styles.epFilterInput}
                  value={episodeFilter}
                  onChangeText={setEpisodeFilter}
                  placeholder="Buscar"
                  placeholderTextColor="#71717a"
                  keyboardType="default"
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                <TouchableOpacity
                  onPress={() => setEpisodesAsc((v) => !v)}
                  style={styles.sortBtn}
                >
                  <Ionicons
                    name={episodesAsc ? 'arrow-down' : 'arrow-up'}
                    size={20}
                    color="#e2e8f0"
                  />
                </TouchableOpacity>
              </View>
            </View>

            <View style={[styles.episodesList, isWide && styles.episodesListWide]}>
              {sortedEpisodes.map((ep) => {
                const watched = watchedUrls.includes(ep.url);
                const activeDl = activeDownloads[ep.url];
                const savedDl = Platform.OS !== 'web' ? downloadsByUrl[ep.url] : undefined;
                return (
                  <View
                    key={ep.id}
                    style={[
                      styles.episodePill,
                      isWide && styles.episodePillWide,
                      watched && styles.episodePillWatched,
                    ]}
                  >
                    <TouchableOpacity
                      style={styles.episodeMainTap}
                      onPress={() => {
                        if (isMangaDetail) {
                          void loadUrl(ep.url, { pushHistory: true });
                          return;
                        }
                        setOfflineQueue([]);
                        void openServerPickerForUrl(
                          ep.url,
                          `${result.metadata.title} - ${ep.title}`,
                          ep.thumbnail || result.metadata.poster,
                        );
                      }}
                      onLongPress={() => {
                        void toggleEpisodeWatched(ep.url).then(setWatchedUrls);
                      }}
                      activeOpacity={0.75}
                    >
                      <Ionicons
                        name={
                          watched
                            ? 'checkmark-circle'
                            : isMangaDetail
                              ? 'book-outline'
                              : 'play-circle-outline'
                        }
                        size={22}
                        color={watched ? '#4ade80' : '#cbd5e1'}
                      />
                      <Text
                        style={[
                          styles.episodePillText,
                          watched && styles.episodePillTextWatched,
                        ]}
                        numberOfLines={1}
                      >
                        {ep.title}
                      </Text>
                    </TouchableOpacity>

                    {!isMangaDetail && (
                      <TouchableOpacity
                        style={[
                          styles.episodeDownloadBtn,
                          activeDl && styles.episodeDownloadBtnActive,
                          savedDl && styles.episodeDownloadBtnDone,
                        ]}
                        onPress={() =>
                          void handleStartDownload({
                            episodeUrl: ep.url,
                            episodeTitle: ep.title,
                            episodeNumber: extractNumericOrder(ep),
                            animeUrl: result.metadata.sourceUrl,
                            animeTitle: result.metadata.title,
                            animeThumbnail: result.metadata.poster || ep.thumbnail,
                          })
                        }
                        hitSlop={{ top: 8, bottom: 8, left: 6, right: 8 }}
                        activeOpacity={0.75}
                      >
                        {activeDl ? (
                          <View style={styles.epDlProgressRow}>
                            <ActivityIndicator size="small" color="#c7d2fe" />
                            <Text style={styles.epDlProgressText}>
                              {activeDl.phase === 'resolving'
                                ? '...'
                                : activeDl.phase === 'preparing'
                                  ? `${activeDl.progress}%`
                                  : `${activeDl.progress}%`}
                            </Text>
                          </View>
                        ) : savedDl ? (
                          <Ionicons name="cloud-done" size={19} color="#34d399" />
                        ) : (
                          <Ionicons name="download-outline" size={19} color="#cbd5e1" />
                        )}
                      </TouchableOpacity>
                    )}
                  </View>
                );
              })}
            </View>
          </View>
        )}

        {/* Related Movies / Series Carousel */}
        {relatedList.length > 0 && (
          <View style={styles.relatedSection}>
            <Text style={[styles.detailSectionTitle, { paddingHorizontal: 16 }]}>
              Similares y recomendados
            </Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.relatedRow}
            >
              {relatedList.map((rel) => {
                const relThumb = rel.thumbnail
                  ? buildProxyUrl(backendUrl, rel.thumbnail, result.metadata.sourceUrl, accessPin)
                  : undefined;
                return (
                  <TouchableOpacity
                    key={rel.id}
                    style={styles.relatedCard}
                    onPress={() => void openInfoForLink(rel)}
                    activeOpacity={0.85}
                  >
                    {relThumb ? (
                      <Image
                        source={{ uri: relThumb }}
                        style={styles.relatedPoster}
                        resizeMode="cover"
                      />
                    ) : (
                      <View style={[styles.relatedPoster, styles.posterPlaceholder]}>
                        <Ionicons name="film-outline" size={24} color="#52525b" />
                      </View>
                    )}
                    <Text style={styles.relatedTitle} numberOfLines={2}>
                      {rel.title}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </View>
        )}
      </ScrollView>
    );
  };

  const renderReaderView = () => {
    if (!result) return null;
    const parentManga = navStack.length > 0 ? navStack[navStack.length - 1] : null;
    const chapters =
      result.pages && result.pages.length > 0 ? result.pages : (parentManga?.pages ?? []);
    const curIdx = chapters.findIndex((c) => c.url === result.metadata.sourceUrl);
    const chaptersDesc = detectPagesDescending(chapters);
    const prevIdx = chaptersDesc ? curIdx + 1 : curIdx - 1;
    const nextIdx = chaptersDesc ? curIdx - 1 : curIdx + 1;
    const hasPrev = curIdx >= 0 && prevIdx >= 0 && prevIdx < chapters.length;
    const hasNext = curIdx >= 0 && nextIdx >= 0 && nextIdx < chapters.length;

    return (
      <MangaReaderView
        title={result.metadata.title}
        images={result.images}
        backendUrl={backendUrl}
        accessPin={accessPin}
        referer={result.metadata.sourceUrl}
        infoUrl={result.metadata.infoUrl}
        chapters={chapters}
        currentChapterUrl={result.metadata.sourceUrl}
        hasPrev={hasPrev}
        hasNext={hasNext}
        onPrev={() => {
          const prevChap = chapters[prevIdx];
          if (prevChap) void loadUrl(prevChap.url, { preserveStack: true });
        }}
        onNext={() => {
          const nextChap = chapters[nextIdx];
          if (nextChap) void loadUrl(nextChap.url, { preserveStack: true });
        }}
        onSelectChapter={(chap) => {
          void loadUrl(chap.url, { preserveStack: true });
        }}
        onOpenInfo={() => {
          if (result.metadata.infoUrl) {
            void loadUrl(result.metadata.infoUrl, { pushHistory: true });
          }
        }}
        onMarkRead={() => {
          void markEpisodeWatched(result.metadata.sourceUrl).then(setWatchedUrls);
        }}
        onBack={() => handleGoBack()}
      />
    );
  };

  const renderGenericView = () => {
    if (!result) return null;
    const listMap: Record<MediaFilterTab, MediaItem[]> = {
      videos: result.videos,
      images: result.images,
      pdfs: result.pdfs,
      pages: [],
    };
    const items = listMap[genericTab];

    return (
      <View style={styles.flex1}>
        <View style={styles.catalogHeader}>
          <TouchableOpacity onPress={handleGoBack} style={styles.headerIconBtn}>
            <Ionicons name="arrow-back" size={22} color="#e2e8f0" />
          </TouchableOpacity>
          <Text style={styles.genericTitle} numberOfLines={1}>
            {result.metadata.title}
          </Text>
          <TouchableOpacity onPress={() => void handleToggleFavorite()} style={styles.headerIconBtn}>
            <Ionicons
              name={isFavorite ? 'heart' : 'heart-outline'}
              size={22}
              color={isFavorite ? '#f43f5e' : '#e2e8f0'}
            />
          </TouchableOpacity>
        </View>

        <View style={styles.tabsRow}>
          {(
            [
              { key: 'videos', label: `Videos (${result.videos.length})` },
              { key: 'images', label: `Imágenes (${result.images.length})` },
              { key: 'pdfs', label: `PDFs (${result.pdfs.length})` },
            ] as { key: MediaFilterTab; label: string }[]
          ).map((tab) => {
            const active = genericTab === tab.key;
            return (
              <TouchableOpacity
                key={tab.key}
                style={[styles.tabPill, active && styles.tabPillActive]}
                onPress={() => setGenericTab(tab.key)}
              >
                <Text style={[styles.tabText, active && styles.tabTextActive]}>
                  {tab.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        <FlatList
          data={items}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.genericList}
          renderItem={({ item }) => (
            <TouchableOpacity
              style={styles.genericCard}
              onPress={() => {
                setViewerReferer(result.metadata.sourceUrl);
                setSelectedItem(item);
              }}
            >
              {item.type === 'image' ? (
                <Image
                  source={{
                    uri: buildProxyUrl(backendUrl, item.url, result.metadata.sourceUrl, accessPin),
                  }}
                  style={styles.genericThumb}
                />
              ) : (
                <View style={styles.genericIconBox}>
                  <Ionicons
                    name={item.type === 'video' ? 'play-circle' : 'document-text'}
                    size={28}
                    color={item.type === 'video' ? '#a855f7' : '#f97316'}
                  />
                </View>
              )}
              <View style={styles.flex1}>
                <Text style={styles.posterTitle} numberOfLines={2}>
                  {item.title || item.type.toUpperCase()}
                </Text>
                <Text style={styles.posterSub} numberOfLines={1}>
                  {item.url}
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color="#71717a" />
            </TouchableOpacity>
          )}
        />
      </View>
    );
  };

  const renderServersTab = () => (
    <ScrollView
      style={styles.flex1}
      contentContainerStyle={[styles.tabPageContent, isWide && styles.wideContainer]}
    >
      <View style={styles.tabPageHeader}>
        <Text style={styles.tabPageTitle}>Páginas fijas y URLs</Text>
        <TouchableOpacity
          style={styles.headerIconBtn}
          onPress={() => setSettingsVisible(true)}
        >
          <Ionicons name="settings-outline" size={22} color="#e2e8f0" />
        </TouchableOpacity>
      </View>

      <Text style={styles.tabSectionLabel}>FUENTES FIJAS</Text>
      {visibleSources.map((src) => {
        const isCurrent = activeSource.id === src.id;
        const isCustom = src.id.startsWith('custom-');
        return (
          <TouchableOpacity
            key={src.id}
            style={[styles.fixedSourceCard, isCurrent && styles.fixedSourceCardActive]}
            onPress={() => {
              setActiveSource(src);
              void loadUrl(src.url, { silentHistory: true });
            }}
          >
            <View style={[styles.fixedSourceIcon, { backgroundColor: src.color }]}>
              <Ionicons name={src.kind === 'manga' ? 'book' : 'tv'} size={20} color="#09090b" />
            </View>
            <View style={styles.flex1}>
              <Text style={styles.fixedSourceName}>{src.name}</Text>
              <Text style={styles.fixedSourceDesc} numberOfLines={1}>
                {src.description}
              </Text>
            </View>
            {isCustom && (
              <TouchableOpacity
                onPress={() => void handleRemoveCustomSource(src.id)}
                style={styles.pasteBtn}
              >
                <Ionicons name="trash-outline" size={18} color="#f87171" />
              </TouchableOpacity>
            )}
            <Ionicons name="chevron-forward" size={20} color="#94a3b8" />
          </TouchableOpacity>
        );
      })}

      <Text style={[styles.tabSectionLabel, { marginTop: 18 }]}>
        ABRIR CUALQUIER OTRA PÁGINA (VIDEOS / IMÁGENES / PDF)
      </Text>
      <View style={styles.customUrlBox}>
        <TextInput
          style={styles.customUrlInput}
          value={customUrlInput}
          onChangeText={setCustomUrlInput}
          placeholder="https://..."
          placeholderTextColor="#71717a"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
        />
        <TouchableOpacity onPress={() => void handlePasteCustomUrl()} style={styles.pasteBtn}>
          <Ionicons name="clipboard-outline" size={20} color="#cbd5e1" />
        </TouchableOpacity>
      </View>
      <View style={styles.customActionsRow}>
        <TouchableOpacity
          style={[styles.primaryPillBtn, { flex: 1 }]}
          onPress={() => void loadUrl(customUrlInput)}
        >
          <Text style={styles.primaryPillBtnText}>Extraer contenido</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.pinBtn}
          onPress={() => void handlePinCustomSource()}
        >
          <Ionicons name="pin-outline" size={18} color="#e2e8f0" />
          <Text style={styles.pinBtnText}>Fijar</Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );

  const renderDownloadsTab = () => {
    const selectedGroup = selectedDownloadAnimeKey
      ? groupedDownloads.find((g) => g.animeKey === selectedDownloadAnimeKey) ?? null
      : null;

    if (selectedGroup) {
      const posterUri = selectedGroup.thumbnailUri
        ? selectedGroup.thumbnailUri
        : selectedGroup.remoteThumbnail
          ? buildProxyUrl(backendUrl, selectedGroup.remoteThumbnail, undefined, accessPin)
          : undefined;
      const nextToPlay =
        selectedGroup.episodes.find((ep) => !watchedUrls.includes(ep.episodeUrl)) ??
        selectedGroup.episodes[0];

      return (
        <ScrollView
          style={styles.flex1}
          contentContainerStyle={[styles.tabPageContent, isWide && styles.wideContainer]}
        >
          <View style={styles.dlFolderTopBar}>
            <TouchableOpacity
              onPress={() => setSelectedDownloadAnimeKey(null)}
              style={styles.backPillBtn}
            >
              <Ionicons name="arrow-back" size={18} color="#f1f5f9" />
              <Text style={styles.backPillText}>Descargas</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.dlDeleteAllBtn}
              onPress={() =>
                handleDeleteDownloadedAnime(selectedGroup.animeKey, selectedGroup.animeTitle)
              }
            >
              <Ionicons name="trash-outline" size={16} color="#fca5a5" />
              <Text style={styles.dlDeleteAllText}>Borrar todo</Text>
            </TouchableOpacity>
          </View>

          <View style={styles.dlAnimeBanner}>
            {posterUri ? (
              <Image source={{ uri: posterUri }} style={styles.dlBannerPoster} resizeMode="cover" />
            ) : (
              <View style={[styles.dlBannerPoster, styles.posterPlaceholder]}>
                <Ionicons name="film-outline" size={28} color="#71717a" />
              </View>
            )}
            <View style={styles.dlBannerInfo}>
              <Text style={styles.dlBannerTitle} numberOfLines={2}>
                {selectedGroup.animeTitle}
              </Text>
              <Text style={styles.dlBannerMeta}>
                {selectedGroup.episodes.length}{' '}
                {selectedGroup.episodes.length === 1 ? 'episodio' : 'episodios'} •{' '}
                {formatBytes(selectedGroup.totalSizeBytes)}
              </Text>
              {nextToPlay && (
                <TouchableOpacity
                  style={styles.dlQuickPlayBtn}
                  onPress={() => playOfflineEpisode(nextToPlay, selectedGroup.episodes)}
                >
                  <Ionicons name="play" size={15} color="#ffffff" />
                  <Text style={styles.dlQuickPlayText} numberOfLines={1}>
                    Reproducir {nextToPlay.episodeTitle}
                  </Text>
                </TouchableOpacity>
              )}
            </View>
          </View>

          <Text style={styles.tabSectionLabel}>EPISODIOS DESCARGADOS (OFFLINE)</Text>
          <View style={styles.episodesList}>
            {selectedGroup.episodes.map((ep) => {
              const watched = watchedUrls.includes(ep.episodeUrl);
              return (
                <View
                  key={ep.id}
                  style={[styles.episodePill, watched && styles.episodePillWatched]}
                >
                  <TouchableOpacity
                    style={styles.episodeMainTap}
                    onPress={() => playOfflineEpisode(ep, selectedGroup.episodes)}
                    activeOpacity={0.75}
                  >
                    <Ionicons
                      name={watched ? 'checkmark-circle' : 'play-circle'}
                      size={23}
                      color={watched ? '#4ade80' : '#818cf8'}
                    />
                    <View style={styles.flex1}>
                      <Text
                        style={[
                          styles.episodePillText,
                          watched && styles.episodePillTextWatched,
                        ]}
                        numberOfLines={1}
                      >
                        {ep.episodeTitle}
                      </Text>
                      <Text style={styles.dlEpisodeSubMeta}>
                        {formatBytes(ep.sizeBytes)} • Listo sin internet
                      </Text>
                    </View>
                  </TouchableOpacity>

                  <View style={styles.dlEpisodeActions}>
                    <TouchableOpacity
                      style={styles.dlMiniIconBtn}
                      onPress={() => void handleShareDownloadedEpisode(ep)}
                      hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
                    >
                      <Ionicons name="share-outline" size={18} color="#cbd5e1" />
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={styles.dlMiniIconBtn}
                      onPress={() => handleDeleteDownloadedEpisode(ep)}
                      hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
                    >
                      <Ionicons name="trash-outline" size={18} color="#f87171" />
                    </TouchableOpacity>
                  </View>
                </View>
              );
            })}
          </View>
        </ScrollView>
      );
    }

    const totalSize = downloads.reduce((acc, d) => acc + d.sizeBytes, 0);

    return (
      <ScrollView
        style={styles.flex1}
        contentContainerStyle={[styles.tabPageContent, isWide && styles.wideContainer]}
      >
        <View style={styles.tabPageHeader}>
          <Text style={styles.tabPageTitle}>Descargas</Text>
          {downloads.length > 0 && (
            <View style={styles.dlStorageBadge}>
              <Ionicons name="folder-outline" size={13} color="#a5b4fc" />
              <Text style={styles.dlStorageBadgeText}>
                {downloads.length} {downloads.length === 1 ? 'ep.' : 'eps.'} • {formatBytes(totalSize)}
              </Text>
            </View>
          )}
        </View>

        {activeDownloadsList.length > 0 && (
          <View style={styles.dlActiveSection}>
            <Text style={styles.tabSectionLabel}>DESCARGANDO AHORA</Text>
            {activeDownloadsList.map((act) => {
              const phaseLabel =
                act.phase === 'resolving'
                  ? 'Buscando servidor...'
                  : act.phase === 'preparing'
                    ? `Preparando MP4 (${act.progress}%)...`
                    : act.totalBytes
                      ? `Descargando ${act.progress}% (${formatBytes(act.bytesWritten ?? 0)} / ${formatBytes(act.totalBytes)})`
                      : `Descargando ${act.progress}%...`;
              return (
                <View key={act.episodeUrl} style={styles.dlActiveCard}>
                  <View style={styles.dlActiveHeader}>
                    <View style={styles.flex1}>
                      <Text style={styles.dlActiveAnime} numberOfLines={1}>
                        {act.animeTitle}
                      </Text>
                      <Text style={styles.dlActiveEp} numberOfLines={1}>
                        {act.episodeTitle} • {phaseLabel}
                      </Text>
                    </View>
                    <TouchableOpacity
                      style={styles.dlCancelBtn}
                      onPress={() => handleCancelDownload(act.episodeUrl)}
                    >
                      <Ionicons name="close" size={18} color="#fca5a5" />
                    </TouchableOpacity>
                  </View>
                  <View style={styles.dlProgressTrack}>
                    <View
                      style={[
                        styles.dlProgressFill,
                        { width: `${Math.max(4, Math.min(100, act.progress))}%` },
                      ]}
                    />
                  </View>
                </View>
              );
            })}
          </View>
        )}

        {groupedDownloads.length === 0 ? (
          <View style={styles.centerBox}>
            <Ionicons name="cloud-download-outline" size={46} color="#52525b" />
            <Text style={styles.mutedText}>
              Todavía no tienes episodios descargados.{'\n'}Pulsa el botón de descarga a la derecha
              de cualquier capítulo para guardarlo organizado por anime y verlo sin internet.
            </Text>
          </View>
        ) : (
          <View style={{ gap: 10 }}>
            <Text style={styles.tabSectionLabel}>
              CLASIFICADOS POR ANIME ({groupedDownloads.length})
            </Text>
            {groupedDownloads.map((group) => {
              const posterUri = group.thumbnailUri
                ? group.thumbnailUri
                : group.remoteThumbnail
                  ? buildProxyUrl(backendUrl, group.remoteThumbnail, undefined, accessPin)
                  : undefined;
              return (
                <TouchableOpacity
                  key={group.animeKey}
                  style={styles.dlAnimeCard}
                  onPress={() => setSelectedDownloadAnimeKey(group.animeKey)}
                  activeOpacity={0.82}
                >
                  {posterUri ? (
                    <Image
                      source={{ uri: posterUri }}
                      style={styles.dlAnimePoster}
                      resizeMode="cover"
                    />
                  ) : (
                    <View style={[styles.dlAnimePoster, styles.posterPlaceholder]}>
                      <Ionicons name="folder" size={26} color="#818cf8" />
                    </View>
                  )}
                  <View style={styles.flex1}>
                    <Text style={styles.dlAnimeTitle} numberOfLines={2}>
                      {group.animeTitle}
                    </Text>
                    <View style={styles.dlAnimeMetaRow}>
                      <View style={styles.dlCountPill}>
                        <Ionicons name="film-outline" size={12} color="#c7d2fe" />
                        <Text style={styles.dlCountPillText}>
                          {group.episodes.length}{' '}
                          {group.episodes.length === 1 ? 'episodio' : 'episodios'}
                        </Text>
                      </View>
                      <Text style={styles.dlAnimeSize}>{formatBytes(group.totalSizeBytes)}</Text>
                    </View>
                  </View>
                  <TouchableOpacity
                    style={styles.dlMiniIconBtn}
                    onPress={() => handleDeleteDownloadedAnime(group.animeKey, group.animeTitle)}
                    hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
                  >
                    <Ionicons name="trash-outline" size={18} color="#f87171" />
                  </TouchableOpacity>
                  <Ionicons name="chevron-forward" size={20} color="#94a3b8" />
                </TouchableOpacity>
              );
            })}
          </View>
        )}
      </ScrollView>
    );
  };

  const renderSavedListTab = (mode: 'favorites' | 'history') => {
    const rawList = mode === 'favorites' ? visibleFavorites : visibleHistory;
    const q = savedSearchQuery.trim().toLowerCase();
    const list = q
      ? rawList.filter((item) => item.title.toLowerCase().includes(q))
      : rawList;

    return (
      <View style={styles.flex1}>
        <View style={[styles.tabPageHeader, isWide && styles.wideContainer]}>
          <Text style={styles.tabPageTitle}>
            {mode === 'favorites'
              ? `Favoritos (${visibleFavorites.length})`
              : `Historial (${visibleHistory.length})`}
          </Text>
          {mode === 'history' && visibleHistory.length > 0 && (
            <TouchableOpacity
              onPress={() => {
                void clearHistory();
                setHistory([]);
              }}
            >
              <Text style={styles.seeMoreLink}>Limpiar</Text>
            </TouchableOpacity>
          )}
        </View>

        {rawList.length > 3 && (
          <View style={[styles.searchBarRow, isWide && styles.wideContainer]}>
            <View style={styles.searchInputWrap}>
              <TextInput
                style={styles.searchInput}
                value={savedSearchQuery}
                onChangeText={setSavedSearchQuery}
                placeholder={`Filtrar ${mode === 'favorites' ? 'favoritos' : 'historial'}...`}
                placeholderTextColor="#71717a"
                autoCapitalize="none"
                autoCorrect={false}
              />
              {savedSearchQuery.length > 0 && (
                <TouchableOpacity
                  onPress={() => setSavedSearchQuery('')}
                  style={styles.clearInputBtn}
                >
                  <Ionicons name="close-circle" size={17} color="#71717a" />
                </TouchableOpacity>
              )}
            </View>
          </View>
        )}

        <FlatList
          key={`saved-${mode}-${gridColumns}`}
          data={list}
          keyExtractor={(item) => item.url}
          numColumns={gridColumns}
          columnWrapperStyle={styles.gridRow}
          contentContainerStyle={[styles.gridContainer, isWide && styles.wideContainer]}
          renderItem={({ item }) => {
            const thumbUri = item.thumbnail
              ? buildProxyUrl(backendUrl, item.thumbnail, item.url, accessPin)
              : undefined;
            return (
              <TouchableOpacity
                style={[styles.posterCard, { flex: 1 / gridColumns }]}
                onPress={() => {
                  setReturnTab(mode);
                  if (Platform.OS === 'web' && typeof globalThis.window !== 'undefined') {
                    globalThis.window.history.pushState({ youanimeStep: true }, '');
                  }
                  void loadUrl(item.url);
                }}
                activeOpacity={0.85}
              >
                <View style={styles.posterMediaWrap}>
                  {thumbUri ? (
                    <Image
                      source={{ uri: thumbUri }}
                      style={styles.posterImg}
                      resizeMode="cover"
                    />
                  ) : (
                    <View style={[styles.posterImg, styles.posterPlaceholder]}>
                      <Ionicons
                        name={mode === 'favorites' ? 'heart' : 'time-outline'}
                        size={30}
                        color={mode === 'favorites' ? '#f43f5e' : '#818cf8'}
                      />
                    </View>
                  )}
                  <TouchableOpacity
                    style={styles.savedRemoveBtn}
                    onPress={() => {
                      if (mode === 'favorites') {
                        void toggleFavorite(item).then(setFavorites);
                      } else {
                        void removeHistoryEntry(item.url).then(setHistory);
                      }
                    }}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  >
                    <Ionicons name="close" size={13} color="#f8fafc" />
                  </TouchableOpacity>
                </View>
                <Text style={styles.posterTitle} numberOfLines={2}>
                  {item.title}
                </Text>
              </TouchableOpacity>
            );
          }}
          ListEmptyComponent={
            <View style={styles.centerBox}>
              <Ionicons
                name={mode === 'favorites' ? 'heart-outline' : 'time-outline'}
                size={40}
                color="#52525b"
              />
              <Text style={styles.mutedText}>
                {q
                  ? `Sin coincidencias para "${savedSearchQuery}".`
                  : mode === 'favorites'
                    ? 'Todavía no tienes favoritos guardados.'
                    : 'Tu historial está vacío.'}
              </Text>
            </View>
          }
        />
      </View>
    );
  };

  const isActionTargetFav = useMemo(() => {
    if (!actionTarget) return false;
    return favorites.some((f) => f.url === actionTarget.url);
  }, [actionTarget, favorites]);

  const isActionTargetManga = useMemo(
    () => (actionTarget ? isMangaContext(actionTarget.url, result?.adapter) : false),
    [actionTarget, result],
  );

  return (
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
      <StatusBar style="light" />

      <View style={styles.flex1}>
        {bottomTab === 'home' &&
          (viewMode === 'reader'
            ? renderReaderView()
            : viewMode === 'detail'
              ? renderDetailView()
              : viewMode === 'generic'
                ? renderGenericView()
                : renderCatalogView())}
        {bottomTab === 'servers' && renderServersTab()}
        {bottomTab === 'downloads' && renderDownloadsTab()}
        {bottomTab === 'favorites' && renderSavedListTab('favorites')}
        {bottomTab === 'history' && renderSavedListTab('history')}

        {downloadToast && (
          <View style={styles.toastBanner} pointerEvents="none">
            <Ionicons name="download-outline" size={16} color="#a5b4fc" />
            <Text style={styles.toastBannerText} numberOfLines={2}>
              {downloadToast}
            </Text>
          </View>
        )}
      </View>

      {/* Bottom Navigation Bar (hidden during fullscreen manga reading) */}
      {!(bottomTab === 'home' && viewMode === 'reader') && (
      <SafeAreaView edges={['bottom']} style={styles.bottomBar}>
        {(
          (Platform.OS === 'web'
            ? [
                { key: 'home', icon: 'home', label: 'Inicio' },
                { key: 'servers', icon: 'extension-puzzle', label: 'Servers' },
                { key: 'favorites', icon: 'heart', label: 'Favoritos' },
                { key: 'history', icon: 'time', label: 'Historial' },
              ]
            : [
                { key: 'home', icon: 'home', label: 'Inicio' },
                { key: 'servers', icon: 'extension-puzzle', label: 'Servers' },
                { key: 'downloads', icon: 'download', label: 'Descargas' },
                { key: 'favorites', icon: 'heart', label: 'Favoritos' },
                { key: 'history', icon: 'time', label: 'Historial' },
              ]) as { key: BottomTab; icon: keyof typeof Ionicons.glyphMap; label: string }[]
        ).map((tab) => {
          const active = bottomTab === tab.key;
          const showActiveBadge = tab.key === 'downloads' && activeDownloadsList.length > 0;
          return (
            <TouchableOpacity
              key={tab.key}
              style={styles.bottomTabBtn}
              onPress={() => {
                if (tab.key !== bottomTab) setSavedSearchQuery('');
                if (tab.key === 'downloads' && bottomTab === 'downloads') {
                  setSelectedDownloadAnimeKey(null);
                }
                setBottomTab(tab.key);
              }}
            >
              <View style={[styles.bottomPill, active && styles.bottomPillActive]}>
                <Ionicons
                  name={active ? tab.icon : (`${tab.icon}-outline` as keyof typeof Ionicons.glyphMap)}
                  size={21}
                  color={active ? '#e0e7ff' : '#94a3b8'}
                />
                {showActiveBadge && (
                  <View style={styles.bottomBadgeDot}>
                    <Text style={styles.bottomBadgeText}>{activeDownloadsList.length}</Text>
                  </View>
                )}
              </View>
              <Text style={[styles.bottomLabel, active && styles.bottomLabelActive]}>
                {tab.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </SafeAreaView>
      )}

      {/* Quick Action Menu ("Ver" / "Información" / "Favoritos") */}
      <Modal
        visible={Boolean(actionTarget)}
        transparent
        animationType="fade"
        onRequestClose={() => setActionTarget(null)}
      >
        <TouchableOpacity
          style={styles.actionBackdrop}
          activeOpacity={1}
          onPress={() => setActionTarget(null)}
        >
          <View style={styles.actionMenu}>
            <Text style={styles.actionHeader} numberOfLines={2}>
              {actionTarget?.title}
            </Text>
            <TouchableOpacity
              style={styles.actionRow}
              onPress={() => {
                if (!actionTarget) return;
                if (isActionTargetManga) {
                  void openMangaForLink(actionTarget);
                  return;
                }
                void openServerPickerForUrl(
                  actionTarget.url,
                  actionTarget.title,
                  actionTarget.thumbnail,
                );
              }}
            >
              <Ionicons
                name={isActionTargetManga ? 'book-outline' : 'eye-outline'}
                size={20}
                color="#f1f5f9"
              />
              <Text style={styles.actionText}>{isActionTargetManga ? 'Leer' : 'Ver'}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.actionRow}
              onPress={() => {
                if (actionTarget) {
                  void openInfoForLink(actionTarget);
                }
              }}
            >
              <Ionicons name="information-circle-outline" size={20} color="#f1f5f9" />
              <Text style={styles.actionText}>Información</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.actionRow}
              onPress={() => {
                if (actionTarget) {
                  const target = actionTarget;
                  setActionTarget(null);
                  void toggleFavorite({
                    url: target.url,
                    title: target.title,
                    thumbnail: target.thumbnail,
                    savedAt: Date.now(),
                    counts: { videos: 0, images: 0, pdfs: 0 },
                  }).then(setFavorites);
                }
              }}
            >
              <Ionicons
                name={isActionTargetFav ? 'heart' : 'heart-outline'}
                size={20}
                color={isActionTargetFav ? '#f43f5e' : '#f1f5f9'}
              />
              <Text style={styles.actionText}>
                {isActionTargetFav ? 'Quitar de Favoritos' : 'Añadir a Favoritos'}
              </Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* Server Picker Modal */}
      <ServerPickerModal
        visible={pickerVisible}
        title={pickerTitle}
        loading={pickerLoading}
        probing={pickerProbing}
        videos={pickerVideos}
        probeMap={pickerProbeMap}
        onSelect={(video) => {
          setPickerVisible(false);
          setViewerReferer(pickerReferer);
          setSelectedItem(video);
        }}
        onRetry={() => {
          const last = lastPickerRequestRef.current;
          if (last) {
            void openServerPickerForUrl(last.url, last.title, last.thumbnail, true);
          }
        }}
        onClose={() => setPickerVisible(false)}
      />

      {/* Video / Image / PDF Viewer */}
      <MediaViewerModal
        item={selectedItem}
        backendUrl={backendUrl}
        accessPin={accessPin}
        referer={viewerReferer}
        episodeTitle={pickerTitle || result?.metadata.title}
        episodeThumbnail={pickerThumb || result?.metadata.poster || result?.images[0]?.url}
        serverOptions={pickerVideos}
        onSelectServer={(srv) => setSelectedItem(srv)}
        hasPrevEpisode={hasPrevEpisode}
        hasNextEpisode={hasNextEpisode}
        onPrevEpisode={() => void handleStepEpisode('prev')}
        onNextEpisode={() => void handleStepEpisode('next')}
        onWatched={(epUrl) => {
          void markEpisodeWatched(epUrl).then((next) => {
            setWatchedUrls((prev) =>
              prev.length === next.length && prev[0] === next[0] ? prev : next,
            );
          });
        }}
        onClose={() => {
          setSelectedItem(null);
          setOfflineQueue([]);
          void refreshContinueWatching();
        }}
      />

      {/* Backend IP Settings */}
      <SettingsModal
        visible={settingsVisible}
        currentUrl={backendUrl}
        currentPin={accessPin}
        vaultUnlocked={vaultUnlocked}
        onToggleVault={handleToggleVault}
        onSave={(newUrl, newPin) => void handleSaveBackendUrl(newUrl, newPin)}
        onClose={() => setSettingsVisible(false)}
      />
    </SafeAreaView>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <MainScreen />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  flex1: { flex: 1 },
  wideContainer: {
    width: '100%',
    maxWidth: 1180,
    alignSelf: 'center',
  },
  sourceSwitchRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'nowrap',
    overflow: 'hidden',
  },
  mobileSourceScroll: {
    flex: 1,
  },
  mobileSourceStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingRight: 6,
  },
  sourcePillSelected: {
    backgroundColor: '#363b54',
    borderWidth: 1,
    borderColor: '#6366f1',
  },
  backPillBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: '#232634',
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#363b54',
  },
  backPillText: {
    color: '#f1f5f9',
    fontSize: 13.5,
    fontWeight: '600',
  },
  episodesListWide: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  episodePillWide: {
    width: '32%',
  },
  container: {
    flex: 1,
    backgroundColor: '#13151d',
  },
  catalogHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  sourcePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#232634',
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 20,
  },
  sourceDot: {
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sourcePillText: {
    color: '#f1f5f9',
    fontSize: 15,
    fontWeight: '700',
  },
  headerIcons: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  sectionsScroll: {
    flexGrow: 0,
  },
  sectionsContainer: {
    flexDirection: 'row',
    paddingHorizontal: 14,
    paddingBottom: 10,
    gap: 8,
  },
  sectionChip: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 18,
    backgroundColor: '#1e212d',
    borderWidth: 1,
    borderColor: '#2d3142',
  },
  sectionChipActive: {
    backgroundColor: '#4f46e5',
    borderColor: '#6366f1',
  },
  sectionChipText: {
    color: '#cbd5e1',
    fontSize: 12.5,
    fontWeight: '600',
  },
  sectionChipTextActive: {
    color: '#ffffff',
  },
  headerIconBtn: {
    padding: 8,
    borderRadius: 12,
  },
  headerIconBtnActive: {
    backgroundColor: 'rgba(99, 102, 241, 0.2)',
  },
  searchBarRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingBottom: 10,
  },
  searchInputWrap: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1e212d',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#2d3142',
    paddingRight: 6,
  },
  searchInput: {
    flex: 1,
    paddingHorizontal: 14,
    paddingVertical: 10,
    color: '#f8fafc',
    fontSize: 14,
  },
  clearInputBtn: {
    padding: 4,
  },
  searchGoBtn: {
    backgroundColor: '#6366f1',
    padding: 11,
    borderRadius: 12,
  },
  globalSearchBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: '#232634',
    paddingHorizontal: 11,
    paddingVertical: 11,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#363b54',
  },
  globalSearchText: {
    color: '#e0e7ff',
    fontSize: 12.5,
    fontWeight: '600',
  },
  cwSection: {
    marginBottom: 10,
  },
  cwHeading: {
    color: '#e2e8f0',
    fontSize: 14,
    fontWeight: '700',
    paddingHorizontal: 14,
    marginBottom: 8,
  },
  cwRow: {
    paddingHorizontal: 14,
    gap: 10,
  },
  cwCard: {
    width: 132,
  },
  cwImg: {
    width: 132,
    height: 78,
    borderRadius: 8,
    backgroundColor: '#1e212d',
  },
  cwBarTrack: {
    height: 3,
    backgroundColor: '#2d3142',
    borderRadius: 2,
    marginTop: 4,
    overflow: 'hidden',
  },
  cwBarFill: {
    height: '100%',
    backgroundColor: '#818cf8',
  },
  cwTitle: {
    color: '#cbd5e1',
    fontSize: 11.5,
    fontWeight: '600',
    marginTop: 4,
  },
  dayGroupSection: {
    marginBottom: 14,
  },
  dayGroupHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    marginBottom: 10,
    paddingHorizontal: 4,
  },
  dayGroupTitle: {
    color: '#f1f5f9',
    fontSize: 15,
    fontWeight: '700',
  },
  dayGroupCount: {
    color: '#94a3b8',
    fontSize: 12.5,
    fontWeight: '600',
  },
  dayGridRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 8,
  },
  gridContainer: {
    paddingHorizontal: 10,
    paddingBottom: 20,
    gap: 14,
  },
  gridRow: {
    gap: 8,
  },
  posterCard: {
    flex: 1 / 3,
    marginBottom: 4,
  },
  posterImg: {
    width: '100%',
    aspectRatio: 0.72,
    borderRadius: 10,
    backgroundColor: '#1e212d',
    marginBottom: 6,
  },
  posterPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  posterTitle: {
    color: '#e2e8f0',
    fontSize: 12.5,
    fontWeight: '600',
    lineHeight: 16,
  },
  posterSub: {
    color: '#94a3b8',
    fontSize: 11,
    marginTop: 2,
  },
  centerBox: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
    gap: 12,
  },
  mutedText: {
    color: '#94a3b8',
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 19,
  },
  errorBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 14,
    marginBottom: 8,
    padding: 10,
    backgroundColor: '#450a0a',
    borderRadius: 10,
  },
  errorText: {
    flex: 1,
    color: '#fecaca',
    fontSize: 12,
  },
  errorAction: {
    color: '#93c5fd',
    fontSize: 12,
    fontWeight: '700',
  },
  // Detail View (Screenshot 4)
  detailScroll: {
    paddingBottom: 32,
  },
  heroContainer: {
    position: 'relative',
    paddingTop: 10,
    paddingBottom: 18,
    paddingHorizontal: 16,
    overflow: 'hidden',
  },
  heroBackdrop: {
    ...StyleSheet.absoluteFill,
    opacity: 0.5,
  },
  heroOverlay: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(19, 21, 29, 0.55)',
  },
  heroTopActions: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 22,
  },
  circleIconBtn: {
    padding: 8,
    borderRadius: 20,
    backgroundColor: 'rgba(15, 23, 42, 0.45)',
  },
  heroInfoRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 14,
  },
  detailPoster: {
    width: 108,
    height: 152,
    borderRadius: 10,
    backgroundColor: '#1e212d',
  },
  heroTitleBlock: {
    flex: 1,
    gap: 6,
    paddingBottom: 6,
  },
  detailTitle: {
    color: '#f8fafc',
    fontSize: 19,
    fontWeight: '700',
    lineHeight: 24,
  },
  detailSub: {
    color: '#cbd5e1',
    fontSize: 13,
  },
  watchNowBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginHorizontal: 16,
    marginTop: 14,
    backgroundColor: '#4f46e5',
    paddingVertical: 12,
    borderRadius: 14,
  },
  watchNowText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '700',
  },
  synopsisSection: {
    paddingHorizontal: 16,
    paddingTop: 18,
    gap: 6,
  },
  detailSectionTitle: {
    color: '#f8fafc',
    fontSize: 18,
    fontWeight: '700',
  },
  synopsisText: {
    color: '#cbd5e1',
    fontSize: 13.5,
    lineHeight: 20,
  },
  seeMoreLink: {
    color: '#60a5fa',
    fontSize: 13,
    fontWeight: '600',
  },
  episodesSection: {
    paddingHorizontal: 16,
    paddingTop: 18,
    gap: 12,
  },
  episodesHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  sortBtn: {
    padding: 6,
  },
  episodesList: {
    gap: 10,
  },
  episodePill: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    backgroundColor: '#2a2d3a',
    paddingLeft: 16,
    paddingRight: 10,
    paddingVertical: 8,
    borderRadius: 28,
  },
  episodeMainTap: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 6,
  },
  episodeDownloadBtn: {
    minWidth: 38,
    height: 36,
    paddingHorizontal: 9,
    borderRadius: 18,
    backgroundColor: 'rgba(15, 23, 42, 0.45)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  episodeDownloadBtnActive: {
    backgroundColor: 'rgba(99, 102, 241, 0.28)',
    borderWidth: 1,
    borderColor: 'rgba(129, 140, 248, 0.55)',
  },
  episodeDownloadBtnDone: {
    backgroundColor: 'rgba(16, 185, 129, 0.16)',
    borderWidth: 1,
    borderColor: 'rgba(52, 211, 153, 0.35)',
  },
  epDlProgressRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  epDlProgressText: {
    color: '#e0e7ff',
    fontSize: 11,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  episodePillText: {
    flex: 1,
    color: '#e2e8f0',
    fontSize: 14.5,
    fontWeight: '500',
  },
  // Action Menu (Screenshot 2)
  actionBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
  },
  actionMenu: {
    width: '100%',
    maxWidth: 280,
    backgroundColor: '#23262f',
    borderRadius: 16,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: '#323644',
  },
  actionHeader: {
    color: '#94a3b8',
    fontSize: 12,
    fontWeight: '600',
    paddingHorizontal: 18,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#2e3240',
  },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: 18,
    paddingVertical: 14,
  },
  actionText: {
    color: '#f1f5f9',
    fontSize: 15,
    fontWeight: '500',
  },
  // Bottom Nav (Screenshot 1)
  bottomBar: {
    flexDirection: 'row',
    backgroundColor: '#1b1d27',
    borderTopWidth: 1,
    borderTopColor: '#272a38',
    paddingTop: 8,
    paddingBottom: 8,
    minHeight: 60,
  },
  bottomTabBtn: {
    flex: 1,
    alignItems: 'center',
    gap: 3,
  },
  bottomPill: {
    paddingHorizontal: 16,
    paddingVertical: 4,
    borderRadius: 16,
  },
  bottomPillActive: {
    backgroundColor: '#363b54',
  },
  bottomLabel: {
    color: '#94a3b8',
    fontSize: 11,
    fontWeight: '600',
  },
  bottomLabelActive: {
    color: '#e2e8f0',
  },
  // Servers / Saved / Generic
  tabPageContent: {
    padding: 16,
    gap: 12,
  },
  tabPageHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  tabPageTitle: {
    color: '#f8fafc',
    fontSize: 20,
    fontWeight: '700',
  },
  tabSectionLabel: {
    color: '#94a3b8',
    fontSize: 11.5,
    fontWeight: '700',
    letterSpacing: 0.6,
  },
  fixedSourceCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: '#1e212d',
    padding: 14,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#2d3142',
  },
  fixedSourceCardActive: {
    borderColor: '#6366f1',
  },
  fixedSourceIcon: {
    width: 42,
    height: 42,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fixedSourceName: {
    color: '#f8fafc',
    fontSize: 16,
    fontWeight: '700',
  },
  fixedSourceDesc: {
    color: '#94a3b8',
    fontSize: 12,
    marginTop: 2,
  },
  customUrlBox: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1e212d',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#2d3142',
    paddingHorizontal: 12,
  },
  customUrlInput: {
    flex: 1,
    color: '#f8fafc',
    fontSize: 14,
    paddingVertical: 12,
  },
  pasteBtn: {
    padding: 6,
  },
  primaryPillBtn: {
    backgroundColor: '#6366f1',
    borderRadius: 12,
    paddingVertical: 13,
    paddingHorizontal: 20,
    alignItems: 'center',
  },
  primaryPillBtnText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '700',
  },
  genericTitle: {
    flex: 1,
    color: '#f8fafc',
    fontSize: 16,
    fontWeight: '700',
    marginHorizontal: 8,
  },
  tabsRow: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    gap: 8,
    marginBottom: 10,
  },
  tabPill: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
    backgroundColor: '#1e212d',
  },
  tabPillActive: {
    backgroundColor: '#6366f1',
  },
  tabText: {
    color: '#94a3b8',
    fontSize: 12,
    fontWeight: '600',
  },
  tabTextActive: {
    color: '#ffffff',
  },
  genericList: {
    paddingHorizontal: 16,
    paddingBottom: 24,
    gap: 10,
  },
  genericCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: '#1e212d',
    padding: 12,
    borderRadius: 12,
  },
  genericThumb: {
    width: 56,
    height: 56,
    borderRadius: 8,
    backgroundColor: '#2d3142',
  },
  genericIconBox: {
    width: 56,
    height: 56,
    borderRadius: 8,
    backgroundColor: '#13151d',
    alignItems: 'center',
    justifyContent: 'center',
  },
  loadMoreBtn: {
    marginTop: 10,
    backgroundColor: '#232634',
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: 'center',
  },
  loadMoreText: {
    color: '#e0e7ff',
    fontSize: 13.5,
    fontWeight: '700',
  },
  episodesControlsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  epFilterInput: {
    width: 68,
    backgroundColor: '#1e212d',
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 5,
    color: '#f8fafc',
    fontSize: 13,
    textAlign: 'center',
    borderWidth: 1,
    borderColor: '#2d3142',
  },
  episodePillWatched: {
    opacity: 0.65,
  },
  episodePillTextWatched: {
    color: '#94a3b8',
  },
  customActionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  pinBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#232634',
    paddingHorizontal: 16,
    paddingVertical: 13,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#323644',
  },
  pinBtnText: {
    color: '#e2e8f0',
    fontSize: 14,
    fontWeight: '600',
  },
  cwThumbWrap: {
    position: 'relative',
    width: 132,
    height: 78,
  },
  cwRemBadge: {
    position: 'absolute',
    left: 5,
    bottom: 5,
    backgroundColor: 'rgba(9, 9, 11, 0.8)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
  },
  cwRemText: {
    color: '#e2e8f0',
    fontSize: 10,
    fontWeight: '700',
  },
  cwDismissBtn: {
    position: 'absolute',
    top: 4,
    right: 4,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: 'rgba(9, 9, 11, 0.78)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  skeletonStatusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 6,
  },
  skeletonBlock: {
    backgroundColor: '#1f2332',
    borderWidth: 1,
    borderColor: '#282d3f',
  },
  skeletonLine: {
    height: 11,
    borderRadius: 5,
    backgroundColor: '#1f2332',
    marginBottom: 5,
    width: '90%',
  },
  posterMediaWrap: {
    position: 'relative',
  },
  posterBadge: {
    position: 'absolute',
    left: 5,
    bottom: 11,
    maxWidth: '88%',
    backgroundColor: 'rgba(15, 23, 42, 0.86)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: 'rgba(129, 140, 248, 0.35)',
  },
  posterBadgeText: {
    color: '#e0e7ff',
    fontSize: 10,
    fontWeight: '700',
  },
  savedRemoveBtn: {
    position: 'absolute',
    top: 5,
    right: 5,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: 'rgba(15, 23, 42, 0.82)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  progressSummaryWrap: {
    marginTop: 4,
    gap: 4,
  },
  progressSummaryText: {
    color: '#cbd5e1',
    fontSize: 11.5,
    fontWeight: '600',
  },
  progressSummaryTrack: {
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.18)',
    overflow: 'hidden',
  },
  progressSummaryFill: {
    height: '100%',
    backgroundColor: '#4ade80',
    borderRadius: 2,
  },
  epHintText: {
    color: '#64748b',
    fontSize: 11,
    marginTop: 1,
  },
  chipIconRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  genreExploreChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: 'rgba(139, 92, 246, 0.14)',
    borderWidth: 1,
    borderColor: 'rgba(139, 92, 246, 0.35)',
  },
  genreExploreText: {
    color: '#ddd6fe',
    fontSize: 12,
    fontWeight: '600',
  },
  searchContainer: {
    width: '100%',
  },
  recentRow: {
    paddingHorizontal: 14,
    paddingBottom: 10,
    gap: 7,
    alignItems: 'center',
  },
  recentChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: '#1e212d',
    paddingHorizontal: 11,
    paddingVertical: 6,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#2d3142',
  },
  recentChipText: {
    color: '#cbd5e1',
    fontSize: 12,
    fontWeight: '500',
  },
  recentClearBtn: {
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  recentClearText: {
    color: '#f87171',
    fontSize: 12,
    fontWeight: '600',
  },
  searchFilterBar: {
    paddingHorizontal: 14,
    paddingBottom: 10,
    gap: 8,
  },
  searchResultBanner: {
    color: '#e2e8f0',
    fontSize: 14,
    fontWeight: '700',
  },
  searchFilterPills: {
    flexDirection: 'row',
    gap: 8,
  },
  metaBadgesRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 2,
  },
  ratingBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(251, 191, 36, 0.18)',
    borderWidth: 1,
    borderColor: 'rgba(251, 191, 36, 0.45)',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
  },
  ratingBadgeText: {
    color: '#fde68a',
    fontSize: 12,
    fontWeight: '700',
  },
  metaBadge: {
    backgroundColor: 'rgba(30, 33, 45, 0.85)',
    borderWidth: 1,
    borderColor: '#363b54',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
  },
  metaBadgeText: {
    color: '#cbd5e1',
    fontSize: 11.5,
    fontWeight: '600',
  },
  detailGenresRow: {
    paddingHorizontal: 16,
    paddingTop: 12,
    gap: 8,
  },
  detailGenreChip: {
    backgroundColor: '#232634',
    borderWidth: 1,
    borderColor: '#363b54',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
  },
  detailGenreText: {
    color: '#c7d2fe',
    fontSize: 12,
    fontWeight: '600',
  },
  relatedSection: {
    paddingTop: 22,
    gap: 12,
  },
  relatedRow: {
    paddingHorizontal: 16,
    gap: 10,
  },
  relatedCard: {
    width: 112,
  },
  relatedPoster: {
    width: 112,
    height: 158,
    borderRadius: 10,
    backgroundColor: '#1e212d',
    marginBottom: 6,
  },
  relatedTitle: {
    color: '#cbd5e1',
    fontSize: 12,
    fontWeight: '600',
    lineHeight: 15,
  },
  detailActionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginHorizontal: 16,
    marginTop: 14,
  },
  watchNowFlex: {
    flex: 1,
    marginHorizontal: 0,
    marginTop: 0,
  },
  downloadMovieBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: '#232634',
    borderWidth: 1,
    borderColor: '#3b405a',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 14,
  },
  downloadMovieBtnDone: {
    backgroundColor: 'rgba(16, 185, 129, 0.14)',
    borderColor: 'rgba(52, 211, 153, 0.45)',
  },
  downloadMovieBtnText: {
    color: '#e0e7ff',
    fontSize: 13.5,
    fontWeight: '700',
  },
  dlStorageBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: '#1e212d',
    borderWidth: 1,
    borderColor: '#2d3142',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 14,
  },
  dlStorageBadgeText: {
    color: '#c7d2fe',
    fontSize: 12,
    fontWeight: '600',
  },
  dlActiveSection: {
    gap: 8,
    marginBottom: 14,
  },
  dlActiveCard: {
    backgroundColor: '#1e212d',
    borderRadius: 14,
    padding: 12,
    borderWidth: 1,
    borderColor: 'rgba(99, 102, 241, 0.4)',
    gap: 8,
  },
  dlActiveHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  dlActiveAnime: {
    color: '#f8fafc',
    fontSize: 14,
    fontWeight: '700',
  },
  dlActiveEp: {
    color: '#94a3b8',
    fontSize: 12,
    marginTop: 2,
  },
  dlCancelBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: 'rgba(239, 68, 68, 0.16)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  dlProgressTrack: {
    height: 5,
    borderRadius: 3,
    backgroundColor: 'rgba(255,255,255,0.12)',
    overflow: 'hidden',
  },
  dlProgressFill: {
    height: '100%',
    borderRadius: 3,
    backgroundColor: '#818cf8',
  },
  dlAnimeCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: '#1e212d',
    borderRadius: 16,
    padding: 10,
    borderWidth: 1,
    borderColor: '#2d3142',
  },
  dlAnimePoster: {
    width: 58,
    height: 82,
    borderRadius: 10,
    backgroundColor: '#252938',
  },
  dlAnimeTitle: {
    color: '#f8fafc',
    fontSize: 15,
    fontWeight: '700',
    lineHeight: 20,
  },
  dlAnimeMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 6,
  },
  dlCountPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(99, 102, 241, 0.2)',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
  },
  dlCountPillText: {
    color: '#c7d2fe',
    fontSize: 11.5,
    fontWeight: '700',
  },
  dlAnimeSize: {
    color: '#94a3b8',
    fontSize: 12,
    fontWeight: '600',
  },
  dlFolderTopBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  dlDeleteAllBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 11,
    paddingVertical: 7,
    borderRadius: 14,
    backgroundColor: 'rgba(239, 68, 68, 0.14)',
    borderWidth: 1,
    borderColor: 'rgba(248, 113, 113, 0.35)',
  },
  dlDeleteAllText: {
    color: '#fca5a5',
    fontSize: 12.5,
    fontWeight: '600',
  },
  dlAnimeBanner: {
    flexDirection: 'row',
    gap: 14,
    backgroundColor: '#1e212d',
    borderRadius: 16,
    padding: 12,
    borderWidth: 1,
    borderColor: '#2d3142',
    marginBottom: 18,
  },
  dlBannerPoster: {
    width: 74,
    height: 106,
    borderRadius: 10,
    backgroundColor: '#252938',
  },
  dlBannerInfo: {
    flex: 1,
    justifyContent: 'center',
    gap: 6,
  },
  dlBannerTitle: {
    color: '#f8fafc',
    fontSize: 16.5,
    fontWeight: '700',
    lineHeight: 21,
  },
  dlBannerMeta: {
    color: '#94a3b8',
    fontSize: 12.5,
    fontWeight: '600',
  },
  dlQuickPlayBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 6,
    backgroundColor: '#4f46e5',
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 12,
    marginTop: 2,
  },
  dlQuickPlayText: {
    color: '#ffffff',
    fontSize: 12.5,
    fontWeight: '700',
  },
  dlEpisodeSubMeta: {
    color: '#94a3b8',
    fontSize: 11.5,
    marginTop: 2,
  },
  dlEpisodeActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  dlMiniIconBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: 'rgba(15, 23, 42, 0.45)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  bottomBadgeDot: {
    position: 'absolute',
    top: -3,
    right: -4,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: '#4f46e5',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 3,
  },
  bottomBadgeText: {
    color: '#ffffff',
    fontSize: 10,
    fontWeight: '800',
  },
  toastBanner: {
    position: 'absolute',
    left: 16,
    right: 16,
    bottom: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(20, 23, 36, 0.96)',
    borderWidth: 1,
    borderColor: '#4f46e5',
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 11,
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 10,
    elevation: 8,
  },
  toastBannerText: {
    flex: 1,
    color: '#f1f5f9',
    fontSize: 13,
    fontWeight: '600',
  },
});
