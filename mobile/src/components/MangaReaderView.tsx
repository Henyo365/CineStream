import { Ionicons } from '@expo/vector-icons';
import React, { useMemo, useState } from 'react';
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
import { WebView } from 'react-native-webview';
import { buildProxyUrl } from '../services/api';
import type { MediaItem } from '../types';

function MangaPageWebImage({ uri, maxWidth }: { uri: string; maxWidth: number }) {
  const [loaded, setLoaded] = useState(false);

  return (
    <View style={[styles.pageWrap, { width: maxWidth, minHeight: loaded ? 0 : 180 }]}>
      {!loaded && (
        <View style={styles.pageLoader}>
          <ActivityIndicator size="small" color="#818cf8" />
        </View>
      )}
      <img
        src={uri}
        alt=""
        onLoad={() => setLoaded(true)}
        style={{
          width: '100%',
          height: 'auto',
          display: 'block',
        }}
      />
    </View>
  );
}

function buildMobileReaderHtml(imageUrls: string[]): string {
  const imgsHtml = imageUrls
    .map(
      (u) =>
        `<img src="${u.replace(/"/g, '&quot;')}" loading="lazy" decoding="async" />`,
    )
    .join('\n');

  return `<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=4.0, user-scalable=yes">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { background: #000; width: 100%; overflow-x: hidden; }
    img { width: 100%; height: auto; display: block; image-rendering: auto; }
  </style>
</head>
<body>
  ${imgsHtml}
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
  const [widthIdx, setWidthIdx] = useState(1);
  const readerWidth =
    Platform.OS === 'web'
      ? Math.min(width, WIDTH_PRESETS[widthIdx])
      : width;

  const proxiedUrls = useMemo(
    () => images.map((img) => buildProxyUrl(backendUrl, img.url, referer, accessPin)),
    [images, backendUrl, referer, accessPin],
  );

  const mobileHtml = useMemo(
    () => (Platform.OS === 'web' ? '' : buildMobileReaderHtml(proxiedUrls)),
    [proxiedUrls],
  );

  return (
    <View style={styles.container}>
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
        <Text style={styles.countText}>{images.length} págs</Text>
      </View>

      {Platform.OS === 'web' ? (
        <FlatList
          data={proxiedUrls}
          keyExtractor={(uri, idx) => `${idx}-${uri}`}
          contentContainerStyle={styles.listContent}
          renderItem={({ item: uri }) => (
            <MangaPageWebImage uri={uri} maxWidth={readerWidth} />
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
            source={{ html: mobileHtml, baseUrl: backendUrl }}
            style={styles.mobileWebView}
            originWhitelist={['*']}
            scalesPageToFit
            bounces={false}
          />
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
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#09090b',
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
    fontWeight: '600',
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
  },
  mobileReaderBody: {
    flex: 1,
    backgroundColor: '#000',
  },
  mobileWebView: {
    flex: 1,
    backgroundColor: '#000',
    opacity: 0.99,
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
});
