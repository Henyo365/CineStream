import { Ionicons } from '@expo/vector-icons';
import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { checkBackendHealth } from '../services/api';

interface SettingsModalProps {
  visible: boolean;
  currentUrl: string;
  onSave: (newUrl: string) => void;
  onClose: () => void;
}

export function SettingsModal({
  visible,
  currentUrl,
  onSave,
  onClose,
}: SettingsModalProps) {
  const [url, setUrl] = useState(currentUrl);
  const [testing, setTesting] = useState(false);
  const [status, setStatus] = useState<'idle' | 'ok' | 'fail'>('idle');

  useEffect(() => {
    if (visible) {
      setUrl(currentUrl);
      setStatus('idle');
    }
  }, [visible, currentUrl]);

  const handleTest = async () => {
    setTesting(true);
    setStatus('idle');
    const ok = await checkBackendHealth(url);
    setStatus(ok ? 'ok' : 'fail');
    setTesting(false);
  };

  const handleSave = () => {
    onSave(url.trim().replace(/\/+$/, ''));
    onClose();
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <View style={styles.header}>
            <Text style={styles.title}>Configurar Backend</Text>
            <TouchableOpacity onPress={onClose}>
              <Ionicons name="close" size={22} color="#a1a1aa" />
            </TouchableOpacity>
          </View>

          <Text style={styles.help}>
            Ingresa la IP local que muestra tu PC al iniciar el servidor backend
            (por ejemplo: http://192.168.1.50:3001).
          </Text>

          <TextInput
            style={styles.input}
            value={url}
            onChangeText={(text) => {
              setUrl(text);
              setStatus('idle');
            }}
            placeholder="http://192.168.1.50:3001"
            placeholderTextColor="#71717a"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
          />

          {status === 'ok' && (
            <Text style={styles.statusOk}>✓ Conexión exitosa con el servidor</Text>
          )}
          {status === 'fail' && (
            <Text style={styles.statusFail}>
              ✕ No se pudo conectar. Verifica que el PC y el teléfono estén en el mismo Wi-Fi.
            </Text>
          )}

          <View style={styles.actions}>
            <TouchableOpacity
              style={styles.testBtn}
              onPress={handleTest}
              disabled={testing}
            >
              {testing ? (
                <ActivityIndicator size="small" color="#e4e4e7" />
              ) : (
                <Text style={styles.testBtnText}>Probar conexión</Text>
              )}
            </TouchableOpacity>

            <TouchableOpacity style={styles.saveBtn} onPress={handleSave}>
              <Text style={styles.saveBtnText}>Guardar</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.75)',
    justifyContent: 'center',
    padding: 20,
  },
  card: {
    backgroundColor: '#18181b',
    borderRadius: 16,
    padding: 20,
    borderWidth: 1,
    borderColor: '#27272a',
    gap: 14,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  title: {
    color: '#f8fafc',
    fontSize: 18,
    fontWeight: '700',
  },
  help: {
    color: '#a1a1aa',
    fontSize: 13,
    lineHeight: 19,
  },
  input: {
    backgroundColor: '#09090b',
    borderWidth: 1,
    borderColor: '#3f3f46',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: '#f8fafc',
    fontSize: 14,
  },
  statusOk: {
    color: '#4ade80',
    fontSize: 13,
    fontWeight: '600',
  },
  statusFail: {
    color: '#f87171',
    fontSize: 13,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 10,
    marginTop: 4,
  },
  testBtn: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: '#27272a',
    minWidth: 120,
    alignItems: 'center',
  },
  testBtnText: {
    color: '#e4e4e7',
    fontSize: 14,
    fontWeight: '600',
  },
  saveBtn: {
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: '#6366f1',
  },
  saveBtnText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '700',
  },
});
