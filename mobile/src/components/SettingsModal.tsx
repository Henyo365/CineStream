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
import { checkBackendHealth, type BackendHealthResult } from '../services/api';
import { DEFAULT_BACKEND_URL } from '../services/storage';

interface SettingsModalProps {
  visible: boolean;
  currentUrl: string;
  currentPin?: string;
  onSave: (newUrl: string, newPin: string) => void;
  onClose: () => void;
}

function normalizeInputUrl(raw: string): string {
  const clean = raw.trim().replace(/\/+$/, '');
  if (!clean) return '';
  if (/^https?:\/\//i.test(clean)) return clean;
  // Use http:// for local LAN/IP addresses, https:// for domains (like Railway)
  const isLocal = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/i.test(clean);
  return `${isLocal ? 'http' : 'https'}://${clean}`;
}

export function SettingsModal({
  visible,
  currentUrl,
  currentPin = '',
  onSave,
  onClose,
}: SettingsModalProps) {
  const [url, setUrl] = useState(currentUrl);
  const [pin, setPin] = useState(currentPin);
  const [showPin, setShowPin] = useState(false);
  const [testing, setTesting] = useState(false);
  const [health, setHealth] = useState<BackendHealthResult | null>(null);

  useEffect(() => {
    if (visible) {
      setUrl(currentUrl);
      setPin(currentPin);
      setShowPin(false);
      setHealth(null);
    }
  }, [visible, currentUrl, currentPin]);

  const handleTest = async () => {
    const normalized = normalizeInputUrl(url);
    setUrl(normalized);
    setTesting(true);
    setHealth(null);
    const res = await checkBackendHealth(normalized, pin);
    setHealth(res);
    setTesting(false);
  };

  const handleSave = () => {
    const normalized = normalizeInputUrl(url) || DEFAULT_BACKEND_URL;
    onSave(normalized, pin.trim());
    onClose();
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <View style={styles.header}>
            <View style={styles.titleRow}>
              <Ionicons name="server-outline" size={20} color="#818cf8" />
              <Text style={styles.title}>Configurar Backend</Text>
            </View>
            <TouchableOpacity onPress={onClose} style={styles.closeBtn}>
              <Ionicons name="close" size={22} color="#a1a1aa" />
            </TouchableOpacity>
          </View>

          <Text style={styles.help}>
            Ingresa la URL de tu servidor en Railway (ej. https://cinestream.up.railway.app) o tu
            IP local (ej. http://192.168.1.50:3001).
          </Text>

          <View style={styles.inputGroup}>
            <View style={styles.labelRow}>
              <Text style={styles.label}>URL del servidor</Text>
              {url !== DEFAULT_BACKEND_URL && (
                <TouchableOpacity
                  onPress={() => {
                    setUrl(DEFAULT_BACKEND_URL);
                    setHealth(null);
                  }}
                >
                  <Text style={styles.resetLink}>Restablecer</Text>
                </TouchableOpacity>
              )}
            </View>
            <TextInput
              style={styles.input}
              value={url}
              onChangeText={(text) => {
                setUrl(text);
                setHealth(null);
              }}
              placeholder="https://tu-app.up.railway.app"
              placeholderTextColor="#71717a"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
            />
          </View>

          <View style={styles.inputGroup}>
            <Text style={styles.label}>PIN de acceso (opcional)</Text>
            <View style={styles.pinInputWrap}>
              <TextInput
                style={styles.pinInput}
                value={pin}
                onChangeText={(text) => {
                  setPin(text);
                  setHealth(null);
                }}
                placeholder="Solo si configuraste ACCESS_PIN"
                placeholderTextColor="#71717a"
                secureTextEntry={!showPin}
                autoCapitalize="none"
                autoCorrect={false}
              />
              <TouchableOpacity
                onPress={() => setShowPin((v) => !v)}
                style={styles.eyeBtn}
              >
                <Ionicons
                  name={showPin ? 'eye-off-outline' : 'eye-outline'}
                  size={19}
                  color="#94a3b8"
                />
              </TouchableOpacity>
            </View>
          </View>

          {health && (
            <View
              style={[
                styles.statusBox,
                health.ok && health.pinValid !== false
                  ? styles.statusBoxOk
                  : health.ok && health.pinValid === false
                    ? styles.statusBoxWarn
                    : styles.statusBoxFail,
              ]}
            >
              <Ionicons
                name={
                  health.ok && health.pinValid !== false
                    ? 'checkmark-circle'
                    : health.ok && health.pinValid === false
                      ? 'lock-closed'
                      : 'alert-circle'
                }
                size={18}
                color={
                  health.ok && health.pinValid !== false
                    ? '#4ade80'
                    : health.ok && health.pinValid === false
                      ? '#fbbf24'
                      : '#f87171'
                }
              />
              <Text
                style={[
                  styles.statusText,
                  health.ok && health.pinValid !== false
                    ? styles.statusOk
                    : health.ok && health.pinValid === false
                      ? styles.statusWarn
                      : styles.statusFail,
                ]}
              >
                {health.ok && health.pinValid !== false
                  ? `Conectado${health.latencyMs ? ` (${health.latencyMs} ms)` : ''}${health.requiresPin ? ' • PIN válido' : ''}`
                  : health.error || 'No se pudo conectar con el servidor.'}
              </Text>
            </View>
          )}

          <View style={styles.actions}>
            <TouchableOpacity
              style={styles.testBtn}
              onPress={() => void handleTest()}
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
    backgroundColor: 'rgba(0,0,0,0.78)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  card: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: '#181a24',
    borderRadius: 18,
    padding: 20,
    borderWidth: 1,
    borderColor: '#2c3044',
    gap: 14,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  title: {
    color: '#f8fafc',
    fontSize: 18,
    fontWeight: '700',
  },
  closeBtn: {
    padding: 4,
  },
  help: {
    color: '#94a3b8',
    fontSize: 12.5,
    lineHeight: 18,
  },
  inputGroup: {
    gap: 6,
  },
  labelRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  label: {
    color: '#cbd5e1',
    fontSize: 12.5,
    fontWeight: '600',
  },
  resetLink: {
    color: '#818cf8',
    fontSize: 12,
    fontWeight: '600',
  },
  input: {
    backgroundColor: '#0e1017',
    borderWidth: 1,
    borderColor: '#32364a',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 11,
    color: '#f8fafc',
    fontSize: 14,
  },
  pinInputWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#0e1017',
    borderWidth: 1,
    borderColor: '#32364a',
    borderRadius: 10,
    paddingLeft: 14,
    paddingRight: 8,
  },
  pinInput: {
    flex: 1,
    paddingVertical: 11,
    color: '#f8fafc',
    fontSize: 14,
  },
  eyeBtn: {
    padding: 6,
  },
  statusBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: 10,
    borderRadius: 10,
    borderWidth: 1,
  },
  statusBoxOk: {
    backgroundColor: 'rgba(34, 197, 94, 0.12)',
    borderColor: 'rgba(74, 222, 128, 0.3)',
  },
  statusBoxWarn: {
    backgroundColor: 'rgba(245, 158, 11, 0.12)',
    borderColor: 'rgba(251, 191, 36, 0.35)',
  },
  statusBoxFail: {
    backgroundColor: 'rgba(239, 68, 68, 0.12)',
    borderColor: 'rgba(248, 113, 113, 0.3)',
  },
  statusText: {
    flex: 1,
    fontSize: 12.5,
    fontWeight: '600',
    lineHeight: 17,
  },
  statusOk: {
    color: '#4ade80',
  },
  statusWarn: {
    color: '#fbbf24',
  },
  statusFail: {
    color: '#f87171',
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 10,
    marginTop: 4,
  },
  testBtn: {
    paddingHorizontal: 14,
    paddingVertical: 11,
    borderRadius: 10,
    backgroundColor: '#252938',
    minWidth: 128,
    alignItems: 'center',
  },
  testBtnText: {
    color: '#e2e8f0',
    fontSize: 13.5,
    fontWeight: '600',
  },
  saveBtn: {
    paddingHorizontal: 20,
    paddingVertical: 11,
    borderRadius: 10,
    backgroundColor: '#6366f1',
  },
  saveBtnText: {
    color: '#ffffff',
    fontSize: 13.5,
    fontWeight: '700',
  },
});
