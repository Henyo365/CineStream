import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import {
  ActivityIndicator,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import type { MediaItem } from '../types';

interface ServerPickerModalProps {
  visible: boolean;
  title?: string;
  loading: boolean;
  videos: MediaItem[];
  onSelect: (item: MediaItem) => void;
  onClose: () => void;
}

export function ServerPickerModal({
  visible,
  title,
  loading,
  videos,
  onSelect,
  onClose,
}: ServerPickerModalProps) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={onClose}>
        <TouchableOpacity style={styles.dialog} activeOpacity={1} onPress={() => {}}>
          <View style={styles.header}>
            <Ionicons name="chevron-back" size={18} color="#94a3b8" />
            <Text style={styles.headerTitle} numberOfLines={1}>
              {title ? `Reprod. Interno • ${title}` : 'Reprod. Interno'}
            </Text>
            <Ionicons name="chevron-forward" size={18} color="#94a3b8" />
          </View>

          {loading ? (
            <View style={styles.loadingBox}>
              <ActivityIndicator size="large" color="#818cf8" />
              <Text style={styles.loadingText}>Cargando servidores...</Text>
            </View>
          ) : videos.length === 0 ? (
            <View style={styles.loadingBox}>
              <Ionicons name="videocam-off-outline" size={32} color="#71717a" />
              <Text style={styles.loadingText}>No se encontraron reproductores.</Text>
            </View>
          ) : (
            <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
              {videos.map((video, idx) => (
                <TouchableOpacity
                  key={video.id}
                  style={styles.serverRow}
                  onPress={() => onSelect(video)}
                  activeOpacity={0.7}
                >
                  <Ionicons
                    name={video.isEmbed ? 'play-outline' : 'play-circle-outline'}
                    size={22}
                    color="#e2e8f0"
                  />
                  <Text style={styles.serverName} numberOfLines={1}>
                    {video.title || `Opción ${idx + 1}`}
                  </Text>
                </TouchableOpacity>
              ))}
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
    backgroundColor: 'rgba(0,0,0,0.72)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  dialog: {
    width: '100%',
    maxWidth: 360,
    maxHeight: '75%',
    backgroundColor: '#23262f',
    borderRadius: 22,
    paddingTop: 18,
    paddingBottom: 14,
    paddingHorizontal: 18,
    borderWidth: 1,
    borderColor: '#323644',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 14,
    paddingHorizontal: 4,
  },
  headerTitle: {
    flex: 1,
    textAlign: 'center',
    color: '#e2e8f0',
    fontSize: 15,
    fontWeight: '600',
    marginHorizontal: 8,
  },
  loadingBox: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 32,
    gap: 10,
  },
  loadingText: {
    color: '#94a3b8',
    fontSize: 13,
  },
  list: {
    maxHeight: 340,
  },
  listContent: {
    gap: 4,
  },
  serverRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    paddingVertical: 13,
    paddingHorizontal: 10,
    borderRadius: 12,
  },
  serverName: {
    flex: 1,
    color: '#f1f5f9',
    fontSize: 15,
    fontWeight: '500',
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: 10,
    paddingTop: 6,
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
