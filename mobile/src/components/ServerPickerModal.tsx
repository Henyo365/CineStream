import { Ionicons } from '@expo/vector-icons';
import React, { useMemo } from 'react';
import {
  ActivityIndicator,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import type { ResolvedVideoResponse } from '../services/api';
import type { MediaItem } from '../types';

interface ServerPickerModalProps {
  visible: boolean;
  title?: string;
  loading: boolean;
  probing?: boolean;
  videos: MediaItem[];
  probeMap?: Record<string, ResolvedVideoResponse>;
  onSelect: (item: MediaItem) => void;
  onRetry?: () => void;
  onClose: () => void;
}

export function ServerPickerModal({
  visible,
  title,
  loading,
  probing = false,
  videos,
  probeMap = {},
  onSelect,
  onRetry,
  onClose,
}: ServerPickerModalProps) {
  const orderedVideos = useMemo(() => {
    const rank = (v: MediaItem): number => {
      const p = probeMap[v.url];
      if (p?.unavailableReason) return 0; // dead at bottom
      if (p && !p.isEmbed) return 3; // verified native HD at top!
      if (!v.isEmbed) return 2; // statically detected direct stream
      return 1; // web/embed fallback
    };
    return [...videos].sort((a, b) => rank(b) - rank(a));
  }, [videos, probeMap]);

  const bestNativeVideo = useMemo(() => {
    return orderedVideos.find((v) => {
      const p = probeMap[v.url];
      if (p?.unavailableReason) return false;
      return (p && !p.isEmbed) || !v.isEmbed;
    });
  }, [orderedVideos, probeMap]);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={onClose}>
        <TouchableOpacity style={styles.dialog} activeOpacity={1} onPress={() => {}}>
          <View style={styles.header}>
            <View style={styles.headerIcon}>
              <Ionicons name="play-circle" size={20} color="#818cf8" />
            </View>
            <View style={styles.headerTitleCol}>
              <Text style={styles.headerTitle} numberOfLines={1}>
                {title || 'Elegir servidor'}
              </Text>
              {!loading && videos.length > 0 && (
                <View style={styles.subRow}>
                  <Text style={styles.headerSub}>
                    {videos.length} {videos.length === 1 ? 'servidor' : 'servidores'}
                  </Text>
                  {probing && (
                    <View style={styles.probeBadge}>
                      <ActivityIndicator size="small" color="#818cf8" style={{ transform: [{ scale: 0.7 }] }} />
                      <Text style={styles.probeText}>Verificando HD...</Text>
                    </View>
                  )}
                </View>
              )}
            </View>
            <TouchableOpacity onPress={onClose} style={styles.closeBtn}>
              <Ionicons name="close" size={20} color="#94a3b8" />
            </TouchableOpacity>
          </View>

          {!loading && bestNativeVideo && (
            <TouchableOpacity
              style={styles.quickPlayBtn}
              onPress={() => onSelect(bestNativeVideo)}
              activeOpacity={0.85}
            >
              <Ionicons name="flash" size={18} color="#ffffff" />
              <Text style={styles.quickPlayText} numberOfLines={1}>
                Reproducir mejor servidor HD
              </Text>
            </TouchableOpacity>
          )}

          {loading ? (
            <View style={styles.loadingBox}>
              <ActivityIndicator size="large" color="#818cf8" />
              <Text style={styles.loadingText}>Buscando servidores...</Text>
            </View>
          ) : orderedVideos.length === 0 ? (
            <View style={styles.loadingBox}>
              <Ionicons name="videocam-off-outline" size={34} color="#71717a" />
              <Text style={styles.loadingText}>No se encontraron reproductores.</Text>
              {onRetry && (
                <TouchableOpacity style={styles.retryBtn} onPress={onRetry}>
                  <Ionicons name="refresh" size={16} color="#e0e7ff" />
                  <Text style={styles.retryText}>Reintentar</Text>
                </TouchableOpacity>
              )}
            </View>
          ) : (
            <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
              {orderedVideos.map((video, idx) => {
                const probe = probeMap[video.url];
                const isDead = Boolean(probe?.unavailableReason);
                const isNative = !isDead && ((probe && !probe.isEmbed) || !video.isEmbed);
                const hasSubs = Boolean(probe?.subtitles && probe.subtitles.length > 0);
                const cleanTitle = (video.title || `Opción ${idx + 1}`).replace(
                  /\s*★\s*Nativo/i,
                  '',
                );

                return (
                  <TouchableOpacity
                    key={video.id}
                    style={[
                      styles.serverRow,
                      isNative && styles.serverRowDirect,
                      isDead && styles.serverRowDead,
                    ]}
                    onPress={() => onSelect(video)}
                    activeOpacity={0.75}
                  >
                    <Ionicons
                      name={isDead ? 'close-circle-outline' : isNative ? 'flash' : 'play-outline'}
                      size={20}
                      color={isDead ? '#f87171' : isNative ? '#4ade80' : '#cbd5e1'}
                    />
                    <View style={styles.serverInfoCol}>
                      <Text
                        style={[styles.serverName, isDead && styles.serverNameDead]}
                        numberOfLines={1}
                      >
                        {cleanTitle}
                      </Text>
                      {hasSubs && (
                        <Text style={styles.subsHint}>Incluye subtítulos CC</Text>
                      )}
                    </View>
                    <View
                      style={[
                        styles.badge,
                        isDead
                          ? styles.badgeDead
                          : isNative
                            ? styles.badgeDirect
                            : styles.badgeEmbed,
                      ]}
                    >
                      <Text
                        style={[
                          styles.badgeText,
                          isDead
                            ? styles.badgeTextDead
                            : isNative
                              ? styles.badgeTextDirect
                              : styles.badgeTextEmbed,
                        ]}
                      >
                        {isDead ? 'Caído' : isNative ? 'HD Nativo' : 'Web'}
                      </Text>
                    </View>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          )}

          <View style={styles.footer}>
            <TouchableOpacity onPress={onClose} style={styles.cancelBtn}>
              <Text style={styles.cancelText}>Cancelar</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.75)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  dialog: {
    width: '100%',
    maxWidth: 390,
    maxHeight: '80%',
    backgroundColor: '#1d202b',
    borderRadius: 20,
    paddingTop: 16,
    paddingBottom: 12,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderColor: '#2f3447',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 12,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#2a2e3e',
  },
  headerIcon: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: 'rgba(99, 102, 241, 0.16)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitleCol: {
    flex: 1,
  },
  headerTitle: {
    color: '#f8fafc',
    fontSize: 15,
    fontWeight: '700',
  },
  subRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 2,
  },
  headerSub: {
    color: '#94a3b8',
    fontSize: 11.5,
  },
  probeBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  probeText: {
    color: '#818cf8',
    fontSize: 11,
    fontWeight: '600',
  },
  closeBtn: {
    padding: 4,
  },
  quickPlayBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#4f46e5',
    paddingVertical: 11,
    paddingHorizontal: 14,
    borderRadius: 12,
    marginBottom: 10,
  },
  quickPlayText: {
    color: '#ffffff',
    fontSize: 13.5,
    fontWeight: '700',
  },
  loadingBox: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 32,
    gap: 10,
  },
  loadingText: {
    color: '#94a3b8',
    fontSize: 13.5,
  },
  retryBtn: {
    marginTop: 6,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#363b54',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 10,
  },
  retryText: {
    color: '#e0e7ff',
    fontSize: 13,
    fontWeight: '600',
  },
  list: {
    maxHeight: 330,
  },
  listContent: {
    gap: 6,
  },
  serverRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 12,
    backgroundColor: '#252836',
  },
  serverRowDirect: {
    borderWidth: 1,
    borderColor: 'rgba(74, 222, 128, 0.35)',
    backgroundColor: 'rgba(74, 222, 128, 0.08)',
  },
  serverRowDead: {
    opacity: 0.5,
    backgroundColor: 'rgba(239, 68, 68, 0.08)',
  },
  serverInfoCol: {
    flex: 1,
  },
  serverName: {
    color: '#f1f5f9',
    fontSize: 14,
    fontWeight: '600',
  },
  serverNameDead: {
    color: '#94a3b8',
    textDecorationLine: 'line-through',
  },
  subsHint: {
    color: '#a5b4fc',
    fontSize: 11,
    marginTop: 2,
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
  },
  badgeDirect: {
    backgroundColor: 'rgba(34, 197, 94, 0.2)',
  },
  badgeEmbed: {
    backgroundColor: 'rgba(148, 163, 184, 0.16)',
  },
  badgeDead: {
    backgroundColor: 'rgba(239, 68, 68, 0.2)',
  },
  badgeText: {
    fontSize: 11,
    fontWeight: '700',
  },
  badgeTextDirect: {
    color: '#4ade80',
  },
  badgeTextEmbed: {
    color: '#94a3b8',
  },
  badgeTextDead: {
    color: '#fca5a5',
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: 10,
    paddingTop: 4,
  },
  cancelBtn: {
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  cancelText: {
    color: '#93c5fd',
    fontSize: 14,
    fontWeight: '600',
  },
});
