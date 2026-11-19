import { Ionicons } from '@expo/vector-icons';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { buildProxyUrl } from '../services/api';
import type { MediaItem } from '../types';

function MangaPageWebImage({
  uri,
  maxWidth,
  index,
}: {
  uri: string;
  maxWidth: number;
  index: number;
}) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [retryCount, setRetryCount] = useState(0);

  const effectiveUri = retryCount > 0 ? `${uri}${uri.includes('?') ? '&' : '?'}r=${retryCount}` : uri;

  return (
    <View style={[styles.pageWrap, { width: maxWidth, minHeight: loaded ? 0 : 220 }]}>
      {!loaded && !failed && (
        <View style={styles.pageLoader}>
          <ActivityIndicator size="small" color="#818cf8" />
          <Text style={styles.pageLoaderText}>Página {index + 1}</Text>
        </View>
      )}
      {failed ? (
        <TouchableOpacity
          style={styles.pageErrorBox}
          onPress={() => {
            setFailed(false);
            setLoaded(false);
            setRetryCount((c) => c + 1);
          }}
        >
          <Ionicons name="refresh-circle-outline" size={32} color="#818cf8" />
          <Text style={styles.pageErrorText}>
            No se pudo cargar la página {index + 1}. Toca para reintentar.
          </Text>
        </TouchableOpacity>
      ) : (
        <img
          src={effectiveUri}
          alt={`Página ${index + 1}`}
          onLoad={() => {
            setLoaded(true);
            setFailed(false);
          }}
          onError={() => setFailed(true)}
          style={{
            width: '100%',
            height: 'auto',
            display: 'block',
          }}
        />
      )}
    </View>
  );
}

function buildMobileReaderHtml(imageUrls: string[]): string {
  const imgsHtml = imageUrls
    .map(
      (u, idx) =>
        `<div class="page" data-idx="${idx + 1}">
          <img src="${u.replace(/"/g, '&quot;')}" data-orig="${u.replace(/"/g, '&quot;')}" loading="${idx < 3 ? 'eager' : 'lazy'}" decoding="async" onerror="handleImgErr(this, ${idx + 1})" />
        </div>`,
    )
    .join('\n');

  return `<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=4.0, user-scalable=yes">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { background: #000; width: 100%; overflow-x: hidden; color: #cbd5e1; font-family: system-ui, -apple-system, sans-serif; }
    .page { width: 100%; min-height: 120px; position: relative; background: #09090b; }
    img { width: 100%; height: auto; display: block; image-rendering: auto; }
    .retry-box { padding: 48px 16px; text-align: center; background: #13151d; border-bottom: 1px solid #272a38; }
    .retry-btn { margin-top: 10px; padding: 8px 16px; background: #6366f1; color: #fff; border: none; border-radius: 10px; font-weight: 700; font-size: 13px; }
  </style>
</head>
<body>
  ${imgsHtml}
  <script>
    function handleImgErr(img, pageNum) {
      var tries = parseInt(img.getAttribute('data-tries') || '0', 10);
      var orig = img.getAttribute('data-orig') || img.src;
      if (tries < 2) {
        img.setAttribute('data-tries', String(tries + 1));
        setTimeout(function() {
          img.src = orig + (orig.indexOf('?') >= 0 ? '&' : '?') + 'r=' + (tries + 1);
        }, 700 * (tries + 1));
        return;
      }
      var parent = img.parentElement;
      if (!parent) return;
      parent.innerHTML = '<div class="retry-box"><div>Error al cargar página ' + pageNum + '</div><button class="retry-btn" onclick="reloadPage(this, ' + pageNum + ', \\'' + orig.replace(/'/g, "\\\\'") + '\\')">Reintentar</button></div>';
    }
    function reloadPage(btn, pageNum, orig) {
      var parent = btn.closest('.page');
      if (!parent) return;
      parent.innerHTML = '<img src="' + orig + (orig.indexOf('?') >= 0 ? '&' : '?') + 'r=' + Date.now() + '" data-orig="' + orig + '" data-tries="0" onerror="handleImgErr(this, ' + pageNum + ')" />';
    }
    var lastTap = 0;
    document.addEventListener('click', function(e) {
      if (e.target && e.target.tagName === 'BUTTON') return;
      var now = Date.now();
      if (now - lastTap > 220) {
        lastTap = now;
        window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'tap' }));
      }
    });
    var scrollTimer = null;
    window.addEventListener('scroll', function() {
      if (scrollTimer) return;
      scrollTimer = setTimeout(function() {
        scrollTimer = null;
        var docH = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
        var pct = Math.min(100, Math.max(0, Math.round((window.scrollY / docH) * 100)));
        var pages = document.querySelectorAll('.page');
        var curPage = 1;
        var mid = window.scrollY + window.innerHeight * 0.35;
        for (var i = 0; i < pages.length; i++) {
          if (pages[i].offsetTop <= mid) curPage = i + 1;
          else break;
        }
        window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify({
          type: 'scroll',
          percent: pct,
          page: curPage,
          scrollY: window.scrollY
        }));
      }, 150);
    }, { passive: true });
  </script>
</body>
</html>`;
}

interface MangaReaderViewProps {
  title: string;
  images: MediaItem[];
  backendUrl: string;
  accessPin?: string;
  referer?: string;
  hasPrev?: boolean;
  hasNext?: boolean;
  onPrev?: () => void;
  onNext?: () => void;
  onBack: () => void;
}

const WIDTH_PRESETS = [680, 900, 1140];

export function MangaReaderView({
  title,
  images,
  backendUrl,
  accessPin,
  referer,
  hasPrev,
  hasNext,
  onPrev,
  onNext,
  onBack,
}: MangaReaderViewProps) {
  const { width } = useWindowDimensions();
  const webViewRef = useRef<React.ComponentRef<typeof WebView> | null>(null);
  const flatListRef = useRef<FlatList<string>>(null);
  const [widthIdx, setWidthIdx] = useState(1);
  const [chromeVisible, setChromeVisible] = useState(true);
  const [currentPage, setCurrentPage] = useState(1);
  const [scrollPercent, setScrollPercent] = useState(0);

  const readerWidth =
    Platform.OS === 'web' ? Math.min(width, WIDTH_PRESETS[widthIdx]) : width;

  useEffect(() => {
    setCurrentPage(1);
    setScrollPercent(0);
    setChromeVisible(true);
  }, [title, images]);

  const proxiedUrls = useMemo(
    () => images.map((img) => buildProxyUrl(backendUrl, img.url, referer, accessPin)),
    [images, backendUrl, referer, accessPin],
  );

  const mobileHtml = useMemo(
    () => (Platform.OS === 'web' ? '' : buildMobileReaderHtml(proxiedUrls)),
    [proxiedUrls],
  );

  const handleWebViewMessage = (event: WebViewMessageEvent) => {
    try {
      const msg = JSON.parse(event.nativeEvent.data) as {
        type?: string;
        percent?: number;
        page?: number;
      };
      if (msg.type === 'tap') {
        setChromeVisible((v) => !v);
      } else if (msg.type === 'scroll') {
        if (typeof msg.percent === 'number') setScrollPercent(msg.percent);
        if (typeof msg.page === 'number') setCurrentPage(msg.page);
      }
    } catch {
      // ignore malformed message
    }
  };

  const handleScrollToTop = () => {
    if (Platform.OS === 'web') {
      flatListRef.current?.scrollToOffset({ offset: 0, animated: true });
    } else {
      webViewRef.current?.injectJavaScript('window.scrollTo({ top: 0, behavior: "smooth" }); true;');
    }
  };

  return (
    <View style={styles.container}>
      {chromeVisible && (
        <View style={styles.topBar}>
          <TouchableOpacity onPress={onBack} style={styles.backBtn}>
            <Ionicons name="arrow-back" size={22} color="#f8fafc" />
          </TouchableOpacity>
          <Text style={styles.title} numberOfLines={1}>
            {title}
          </Text>
          {Platform.OS === 'web' && (
            <View style={styles.zoomGroup}>
              <TouchableOpacity
                onPress={() => setWidthIdx((i) => Math.max(0, i - 1))}
                style={styles.zoomBtn}
              >
                <Ionicons name="remove" size={16} color="#e2e8f0" />
              </TouchableOpacity>
              <Text style={styles.zoomText}>Zoom</Text>
              <TouchableOpacity
                onPress={() =>
                  setWidthIdx((i) => Math.min(WIDTH_PRESETS.length - 1, i + 1))
                }
                style={styles.zoomBtn}
              >
                <Ionicons name="add" size={16} color="#e2e8f0" />
              </TouchableOpacity>
            </View>
          )}
          <Text style={styles.countText}>
            {currentPage}/{images.length}
          </Text>
        </View>
      )}

      {/* Slim reading progress bar */}
      <View style={styles.progressTrack}>
        <View style={[styles.progressFill, { width: `${Math.max(2, scrollPercent)}%` }]} />
      </View>

      {Platform.OS === 'web' ? (
        <FlatList
          ref={flatListRef}
          data={proxiedUrls}
          keyExtractor={(uri, idx) => `${idx}-${uri}`}
          contentContainerStyle={styles.listContent}
          onScroll={(e) => {
            const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
            const maxScroll = Math.max(1, contentSize.height - layoutMeasurement.height);
            const pct = Math.min(100, Math.max(0, Math.round((contentOffset.y / maxScroll) * 100)));
            setScrollPercent(pct);
            const approxPage = Math.min(
              images.length,
              Math.max(1, Math.round((pct / 100) * Math.max(1, images.length - 1)) + 1),
            );
            setCurrentPage(approxPage);
          }}
          scrollEventThrottle={150}
          renderItem={({ item: uri, index }) => (
            <MangaPageWebImage uri={uri} maxWidth={readerWidth} index={index} />
          )}
          ListFooterComponent={
            <View style={[styles.footerNav, { width: readerWidth }]}>
              <TouchableOpacity
                style={[styles.navBtn, !hasPrev && styles.navBtnDisabled]}
                disabled={!hasPrev}
                onPress={onPrev}
              >
                <Ionicons name="chevron-back" size={18} color="#f8fafc" />
                <Text style={styles.navBtnText}>Anterior</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.navBtn,
                  styles.navBtnPrimary,
                  !hasNext && styles.navBtnDisabled,
                ]}
                disabled={!hasNext}
                onPress={onNext}
              >
                <Text style={styles.navBtnText}>Siguiente</Text>
                <Ionicons name="chevron-forward" size={18} color="#f8fafc" />
              </TouchableOpacity>
            </View>
          }
        />
      ) : (
        <View style={styles.mobileReaderBody}>
          <WebView
            ref={webViewRef}
            source={{ html: mobileHtml, baseUrl: backendUrl }}
            style={styles.mobileWebView}
            originWhitelist={['*']}
            scalesPageToFit
            bounces={false}
            onMessage={handleWebViewMessage}
          />
          {!chromeVisible && (
            <View style={styles.floatingPagePill} pointerEvents="none">
              <Text style={styles.floatingPageText}>
                {currentPage} / {images.length} • {scrollPercent}%
              </Text>
            </View>
          )}
          {chromeVisible && (
            <View style={styles.mobileFooterBar}>
              <TouchableOpacity
                style={[styles.navBtn, !hasPrev && styles.navBtnDisabled]}
                disabled={!hasPrev}
                onPress={onPrev}
              >
                <Ionicons name="chevron-back" size={18} color="#f8fafc" />
                <Text style={styles.navBtnText}>Anterior</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.navBtn,
                  styles.navBtnPrimary,
                  !hasNext && styles.navBtnDisabled,
                ]}
                disabled={!hasNext}
                onPress={onNext}
              >
                <Text style={styles.navBtnText}>Siguiente</Text>
                <Ionicons name="chevron-forward" size={18} color="#f8fafc" />
              </TouchableOpacity>
            </View>
          )}
        </View>
      )}

      {scrollPercent > 20 && chromeVisible && (
        <TouchableOpacity
          style={styles.scrollTopFab}
          onPress={handleScrollToTop}
          activeOpacity={0.85}
        >
          <Ionicons name="arrow-up" size={20} color="#ffffff" />
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#09090b',
    position: 'relative',
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: '#13151d',
    borderBottomWidth: 1,
    borderBottomColor: '#272a38',
  },
  backBtn: {
    padding: 6,
  },
  title: {
    flex: 1,
    color: '#f8fafc',
    fontSize: 15,
    fontWeight: '700',
  },
  zoomGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#1e212d',
    borderRadius: 16,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: '#2d3142',
  },
  zoomBtn: {
    padding: 3,
  },
  zoomText: {
    color: '#cbd5e1',
    fontSize: 11.5,
    fontWeight: '600',
  },
  countText: {
    color: '#94a3b8',
    fontSize: 12.5,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  progressTrack: {
    height: 2.5,
    backgroundColor: '#1e212d',
    width: '100%',
  },
  progressFill: {
    height: '100%',
    backgroundColor: '#818cf8',
  },
  listContent: {
    alignItems: 'center',
    paddingBottom: 32,
  },
  pageWrap: {
    position: 'relative',
    backgroundColor: '#000',
    justifyContent: 'center',
    alignItems: 'center',
  },
  pageLoader: {
    position: 'absolute',
    zIndex: 1,
    alignItems: 'center',
    gap: 6,
  },
  pageLoaderText: {
    color: '#94a3b8',
    fontSize: 12,
  },
  pageErrorBox: {
    width: '100%',
    paddingVertical: 48,
    paddingHorizontal: 20,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#13151d',
    borderBottomWidth: 1,
    borderBottomColor: '#272a38',
  },
  pageErrorText: {
    color: '#cbd5e1',
    fontSize: 13,
    textAlign: 'center',
  },
  mobileReaderBody: {
    flex: 1,
    backgroundColor: '#000',
    position: 'relative',
  },
  mobileWebView: {
    flex: 1,
    backgroundColor: '#000',
    opacity: 0.99,
  },
  floatingPagePill: {
    position: 'absolute',
    bottom: 14,
    right: 14,
    backgroundColor: 'rgba(15, 23, 42, 0.72)',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
  },
  floatingPageText: {
    color: '#e2e8f0',
    fontSize: 11.5,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  mobileFooterBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: '#13151d',
    borderTopWidth: 1,
    borderTopColor: '#272a38',
  },
  footerNav: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
    padding: 16,
  },
  navBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: '#232634',
    paddingVertical: 13,
    borderRadius: 12,
  },
  navBtnPrimary: {
    backgroundColor: '#6366f1',
  },
  navBtnDisabled: {
    opacity: 0.35,
  },
  navBtnText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '700',
  },
  scrollTopFab: {
    position: 'absolute',
    right: 16,
    bottom: 76,
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: 'rgba(99, 102, 241, 0.9)',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 6,
    elevation: 5,
  },
});
