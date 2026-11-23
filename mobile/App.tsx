import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { StatusBar } from 'expo-status-bar';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
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
import { MediaViewerModal } from './src/components/MediaViewerModal';
import { ServerPickerModal } from './src/components/ServerPickerModal';
import { SettingsModal } from './src/components/SettingsModal';
import {
  buildProxyUrl,
  extractMediaFromUrl,
  globalSearchMedia,
  resolveVideoBatch,
  type ResolvedVideoResponse,
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
import { FIXED_SOURCES, type FixedSource } from './src/sources';
import type {
  ExtractionResult,
  HistoryEntry,
  MediaItem,
  PageLink,
} from './src/types';

type BottomTab = 'home' | 'servers' | 'favorites' | 'history';
type MediaFilterTab = 'videos' | 'images' | 'pdfs' | 'pages';

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
  const [searchSourceFilter, setSearchSourceFilter] = useState<'all' | 'animeflv' | 'hackstore'>(
    'all',
  );
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

  const requestIdRef = useRef(0);
  const probeIdRef = useRef(0);
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
      ] = await Promise.all([
        loadBackendUrl(),
        loadAccessPin(),
        loadHistory(),
        loadFavorites(),
        loadWatchedEpisodes(),
        loadCustomSources(),
        loadRecentSearches(),
      ]);
      setBackendUrl(savedUrl);
      setAccessPin(savedPin);
      setHistory(savedHistory);
      setFavorites(savedFavs);
      setWatchedUrls(savedWatched);
      setCustomSources(savedCustom);
      setRecentSearches(savedSearches);
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
    const missingFavs = favList.filter((f) => !f.thumbnail).slice(0, 6);
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

    const missingCw = cwList.filter((c) => !c.thumbnail).slice(0, 5);
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

  const handleGoBack = () => {
    if (selectedItem) {
      setSelectedItem(null);
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
    sourceOverride?: 'all' | 'animeflv' | 'hackstore',
  ) => {
    const q = (queryOverride ?? searchInput).trim();
    if (!q) return;
    const srcFilter = sourceOverride ?? searchSourceFilter;
    const reqId = ++requestIdRef.current;
    Keyboard.dismiss();
    setLoading(true);
    setError(null);
    setEpisodeFilter('');
    void addRecentSearch(q).then(setRecentSearches);
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
    if (/^https?:\/\//i.test(q)) {
      void loadUrl(q, { pushHistory: true });
    } else if (activeSource.searchUrlTemplate) {
      void addRecentSearch(q).then(setRecentSearches);
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

  // Detect whether current result is a Catalog Grid, Detail screen, or Generic Media page
  const viewMode = useMemo<'catalog' | 'detail' | 'generic'>(() => {
    if (!result) return 'catalog';
    const pages = result.pages ?? [];
    if (result.adapter === 'animeflv') {
      const path = (() => {
        try {
          return new URL(result.metadata.sourceUrl).pathname;
        } catch {
          return '';
        }
      })();
      const isDetailUrl =
        /\/anime\/[^/]+\/?$/.test(path) || (result.videos.length > 0 && pages.length > 0);
      if (isDetailUrl) return 'detail';
      if (pages.length > 0) return 'catalog';
    }
    if (result.adapter === 'hackstore') {
      const path = (() => {
        try {
          return new URL(result.metadata.sourceUrl).pathname;
        } catch {
          return '';
        }
      })();
      if (result.videos.length > 0 || /^\/series\/[^/]+\/?$/.test(path)) {
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

  const currentEpisodeIndex = useMemo(() => {
    if (!viewerReferer || !result?.pages) return -1;
    return result.pages.findIndex((p) => p.url === viewerReferer);
  }, [viewerReferer, result]);

  const hasPrevEpisode = useMemo(() => {
    if (!result?.pages || currentEpisodeIndex < 0) return false;
    return pagesDescending
      ? currentEpisodeIndex + 1 < result.pages.length
      : currentEpisodeIndex > 0;
  }, [result, currentEpisodeIndex, pagesDescending]);

  const hasNextEpisode = useMemo(() => {
    if (!result?.pages || currentEpisodeIndex < 0) return false;
    return pagesDescending
      ? currentEpisodeIndex > 0
      : currentEpisodeIndex + 1 < result.pages.length;
  }, [result, currentEpisodeIndex, pagesDescending]);

  const handleStepEpisode = async (direction: 'prev' | 'next') => {
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
    const thumbUri = item.thumbnail
      ? buildProxyUrl(backendUrl, item.thumbnail, result?.metadata.sourceUrl, accessPin)
      : undefined;
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
              <Ionicons name="film-outline" size={28} color="#52525b" />
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
    const allSources = [...FIXED_SOURCES, ...customSources];
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
                      <Ionicons name="play" size={11} color="#09090b" />
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
                        <Ionicons name="play" size={10} color="#09090b" />
                      </View>
                      <Text style={styles.sourcePillText}>{src.name}</Text>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            )}
          </View>

          <View style={styles.headerIcons}>
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
            <View style={styles.searchFilterPills}>
              {(
                [
                  { key: 'all', label: 'Todos' },
                  { key: 'animeflv', label: 'AnimeFLV' },
                  { key: 'hackstore', label: 'Hackstore' },
                ] as const
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
            </View>
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

        {continueWatching.length > 0 && navStack.length === 0 && (
          <View style={[styles.cwSection, isWide && styles.wideContainer]}>
            <Text style={styles.cwHeading}>Seguir viendo</Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.cwRow}
            >
              {continueWatching.map((cw) => {
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
                    {watchedCount} / {allPages.length} vistos
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

        {/* Quick Play if current page already has videos */}
        {result.videos.length > 0 && (
          <TouchableOpacity
            style={styles.watchNowBtn}
            onPress={() => {
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
            <Text style={styles.watchNowText}>
              Reproducir ahora ({result.videos.length} opciones)
            </Text>
          </TouchableOpacity>
        )}

        {/* Smart Continue / Start Next Episode CTA */}
        {result.videos.length === 0 && nextUnwatchedEp && (
          <TouchableOpacity
            style={styles.watchNowBtn}
            onPress={() =>
              void openServerPickerForUrl(
                nextUnwatchedEp.url,
                nextUnwatchedEp.title,
                nextUnwatchedEp.thumbnail || result.metadata.poster,
              )
            }
          >
            <Ionicons name="play-circle" size={21} color="#ffffff" />
            <Text style={styles.watchNowText} numberOfLines={1}>
              {watchedCount > 0 ? 'Continuar' : 'Ver'}: {nextUnwatchedEp.title}
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

        {/* Episodios */}
        {allPages.length > 0 && (
          <View style={styles.episodesSection}>
            <View style={styles.episodesHeaderRow}>
              <View>
                <Text style={styles.detailSectionTitle}>
                  Episodios ({sortedEpisodes.length})
                </Text>
                <Text style={styles.epHintText}>Mantén pulsado para marcar como visto</Text>
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
                return (
                  <TouchableOpacity
                    key={ep.id}
                    style={[
                      styles.episodePill,
                      isWide && styles.episodePillWide,
                      watched && styles.episodePillWatched,
                    ]}
                    onPress={() =>
                      void openServerPickerForUrl(
                        ep.url,
                        ep.title,
                        ep.thumbnail || result.metadata.poster,
                      )
                    }
                    onLongPress={() => {
                      void toggleEpisodeWatched(ep.url).then(setWatchedUrls);
                    }}
                    activeOpacity={0.75}
                  >
                    <Ionicons
                      name={watched ? 'checkmark-circle' : 'play-circle-outline'}
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
      {[...FIXED_SOURCES, ...customSources].map((src) => {
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
              <Ionicons name="tv" size={20} color="#09090b" />
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

  const renderSavedListTab = (mode: 'favorites' | 'history') => {
    const rawList = mode === 'favorites' ? favorites : history;
    const q = savedSearchQuery.trim().toLowerCase();
    const list = q
      ? rawList.filter((item) => item.title.toLowerCase().includes(q))
      : rawList;

    return (
      <View style={styles.flex1}>
        <View style={[styles.tabPageHeader, isWide && styles.wideContainer]}>
          <Text style={styles.tabPageTitle}>
            {mode === 'favorites'
              ? `Favoritos (${favorites.length})`
              : `Historial (${history.length})`}
          </Text>
          {mode === 'history' && history.length > 0 && (
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

  return (
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
      <StatusBar style="light" />

      <View style={styles.flex1}>
        {bottomTab === 'home' &&
          (viewMode === 'detail'
            ? renderDetailView()
            : viewMode === 'generic'
              ? renderGenericView()
              : renderCatalogView())}
        {bottomTab === 'servers' && renderServersTab()}
        {bottomTab === 'favorites' && renderSavedListTab('favorites')}
        {bottomTab === 'history' && renderSavedListTab('history')}
      </View>

      {/* Bottom Navigation Bar */}
      <SafeAreaView edges={['bottom']} style={styles.bottomBar}>
        {(
          [
            { key: 'home', icon: 'home', label: 'Inicio' },
            { key: 'servers', icon: 'extension-puzzle', label: 'Servers' },
            { key: 'favorites', icon: 'heart', label: 'Favoritos' },
            { key: 'history', icon: 'time', label: 'Historial' },
          ] as { key: BottomTab; icon: keyof typeof Ionicons.glyphMap; label: string }[]
        ).map((tab) => {
          const active = bottomTab === tab.key;
          return (
            <TouchableOpacity
              key={tab.key}
              style={styles.bottomTabBtn}
              onPress={() => {
                if (tab.key !== bottomTab) setSavedSearchQuery('');
                setBottomTab(tab.key);
              }}
            >
              <View style={[styles.bottomPill, active && styles.bottomPillActive]}>
                <Ionicons
                  name={active ? tab.icon : (`${tab.icon}-outline` as keyof typeof Ionicons.glyphMap)}
                  size={21}
                  color={active ? '#e0e7ff' : '#94a3b8'}
                />
              </View>
              <Text style={[styles.bottomLabel, active && styles.bottomLabelActive]}>
                {tab.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </SafeAreaView>

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
                if (actionTarget) {
                  void openServerPickerForUrl(
                    actionTarget.url,
                    actionTarget.title,
                    actionTarget.thumbnail,
                  );
                }
              }}
            >
              <Ionicons name="eye-outline" size={20} color="#f1f5f9" />
              <Text style={styles.actionText}>Ver</Text>
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
          void refreshContinueWatching();
        }}
      />

      {/* Backend IP Settings */}
      <SettingsModal
        visible={settingsVisible}
        currentUrl={backendUrl}
        currentPin={accessPin}
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
    gap: 12,
    backgroundColor: '#2a2d3a',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderRadius: 28,
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
});
