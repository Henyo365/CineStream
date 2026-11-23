import { Ionicons } from '@expo/vector-icons';
import Hls from 'hls.js';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  type LayoutChangeEvent,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { buildProxyUrl, type SubtitleOption } from '../services/api';
import { loadPlaybackProgress, savePlaybackProgress } from '../services/storage';
import { parseVttCues, type SubtitleCue } from '../utils/vtt';

const SPEED_OPTIONS = [1, 1.25, 1.5, 2, 0.75];

function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '00:00';
  const total = Math.floor(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

interface WebAudioOption {
  id: number;
  name: string;
  lang?: string;
}

interface WebQualityOption {
  id: number;
  label: string;
  height: number;
}

interface WebSubOption {
  id: number;
  name: string;
}

interface WebCustomVideoPlayerProps {
  uri: string;
  isHls: boolean;
  backendUrl: string;
  accessPin?: string;
  referer?: string;
  episodeKey?: string;
  title: string;
  posterThumbnail?: string;
  externalSubtitles?: SubtitleOption[];
  hasServers: boolean;
  onOpenServers: () => void;
  hasPrev?: boolean;
  hasNext?: boolean;
  onPrev?: () => void;
  onNext?: () => void;
  onWatched?: (url: string) => void;
  onClose: () => void;
}

export function WebCustomVideoPlayer({
  uri,
  isHls,
  backendUrl,
  accessPin,
  referer,
  episodeKey,
  title,
  posterThumbnail,
  externalSubtitles,
  hasServers,
  onOpenServers,
  hasPrev,
  hasNext,
  onPrev,
  onNext,
  onWatched,
  onClose,
}: WebCustomVideoPlayerProps) {
  const videoElRef = useRef<HTMLVideoElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const [controlsVisible, setControlsVisible] = useState(true);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isBuffering, setIsBuffering] = useState(true);
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [bufferedTime, setBufferedTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [speedIdx, setSpeedIdx] = useState(0);
  const [contentFit, setContentFit] = useState<'contain' | 'cover'>('contain');
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [barWidth, setBarWidth] = useState(1);

  const [tracksModalOpen, setTracksModalOpen] = useState(false);
  const [tracksTab, setTracksTab] = useState<'audio' | 'sub' | 'quality'>('audio');
  const [audioTracks, setAudioTracks] = useState<WebAudioOption[]>([]);
  const [selectedAudioId, setSelectedAudioId] = useState<number>(0);
  const [qualityLevels, setQualityLevels] = useState<WebQualityOption[]>([]);
  const [selectedLevelId, setSelectedLevelId] = useState<number>(-1);
  const [hlsSubs, setHlsSubs] = useState<WebSubOption[]>([]);
  const [selectedHlsSubId, setSelectedHlsSubId] = useState<number>(-1);
  const [selectedExtSubUrl, setSelectedExtSubUrl] = useState<string | null>(null);
  const [extCues, setExtCues] = useState<SubtitleCue[]>([]);
  const [nextCountdown, setNextCountdown] = useState<number | null>(null);

  const restoredRef = useRef(false);
  const watchedMarkedRef = useRef(false);
  const lastSavedSecRef = useRef(-10);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Stabilize callbacks so parent re-renders NEVER destroy & recreate the HLS instance!
  const onWatchedRef = useRef(onWatched);
  onWatchedRef.current = onWatched;
  const hasNextRef = useRef(hasNext);
  hasNextRef.current = hasNext;
  const metaRef = useRef({ title, posterThumbnail });
  metaRef.current = { title, posterThumbnail };

  useEffect(() => {
    if (controlsVisible && isPlaying && !tracksModalOpen) {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      hideTimerRef.current = setTimeout(() => setControlsVisible(false), 3500);
    } else if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
    return () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    };
  }, [controlsVisible, isPlaying, tracksModalOpen]);

  useEffect(() => {
    const video = videoElRef.current;
    if (!video) return;

    restoredRef.current = false;
    watchedMarkedRef.current = false;
    lastSavedSecRef.current = -10;
    setIsBuffering(true);
    setHasLoadedOnce(false);

    let hls: Hls | null = null;
    let mediaRecoveryAttempts = 0;

    const syncTracks = (instance: Hls) => {
      const aList = (instance.audioTracks ?? []).map((t, idx) => ({
        id: idx,
        name: t.name || t.lang || `Idioma ${idx + 1}`,
        lang: t.lang,
      }));
      setAudioTracks(aList);
      setSelectedAudioId(instance.audioTrack ?? 0);

      const qList = (instance.levels ?? [])
        .map((lvl, idx) => ({
          id: idx,
          height: lvl.height || 0,
          label: lvl.height ? `${lvl.height}p` : `${Math.round((lvl.bitrate || 0) / 1000)} kbps`,
        }))
        .sort((a, b) => b.height - a.height);
      setQualityLevels(qList);

      const sList = (instance.subtitleTracks ?? []).map((st, idx) => ({
        id: idx,
        name: st.name || st.lang || `Subtítulo ${idx + 1}`,
      }));
      setHlsSubs(sList);
      setSelectedHlsSubId(instance.subtitleTrack ?? -1);
    };

    if (isHls && Hls.isSupported()) {
      hls = new Hls({
        startLevel: -1,
        maxBufferLength: 35,
        maxMaxBufferLength: 60,
        backBufferLength: 20,
        fragLoadingTimeOut: 25000,
        fragLoadingMaxRetry: 8,
        fragLoadingRetryDelay: 600,
      });
      hlsRef.current = hls;
      hls.loadSource(uri);
      hls.attachMedia(video);

      hls.on(Hls.Events.MANIFEST_PARSED, (_e, data) => {
        if (hls && data.levels && data.levels.length > 0) {
          let bestIdx = 0;
          let bestH = 0;
          data.levels.forEach((l, i) => {
            if ((l.height || 0) >= bestH) {
              bestH = l.height || 0;
              bestIdx = i;
            }
          });
          // Start at highest resolution while keeping Auto ABR (-1) so playback doesn't stall
          hls.startLevel = bestIdx;
          hls.currentLevel = -1;
          setSelectedLevelId(-1);
        }
        if (hls) syncTracks(hls);
        void video.play().catch(() => {});
      });

      hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, () => {
        if (hls) syncTracks(hls);
      });
      hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, () => {
        if (hls) syncTracks(hls);
      });
      hls.on(Hls.Events.AUDIO_TRACK_SWITCHED, (_e, data) => {
        setSelectedAudioId(data.id);
      });
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (!data.fatal || !hls) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          hls.startLoad();
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRecoveryAttempts < 3) {
          mediaRecoveryAttempts += 1;
          hls.recoverMediaError();
        }
      });
    } else {
      video.src = uri;
      void video.play().catch(() => {});
    }

    const persistProgressNow = (pos?: number, dur?: number) => {
      const ct = pos ?? (video.currentTime || 0);
      const d = dur ?? (video.duration || 0);
      if (episodeKey && d > 0 && ct > 2) {
        void savePlaybackProgress(episodeKey, ct, d, {
          title: metaRef.current.title,
          thumbnail: metaRef.current.posterThumbnail,
        });
      }
    };

    const onPlay = () => setIsPlaying(true);
    const onPause = () => {
      setIsPlaying(false);
      persistProgressNow();
    };
    const onWaiting = () => setIsBuffering(true);
    const onEnded = () => {
      if (episodeKey && video.duration > 0) {
        persistProgressNow(video.duration, video.duration);
        if (!watchedMarkedRef.current) {
          watchedMarkedRef.current = true;
          onWatchedRef.current?.(episodeKey);
        }
      }
      if (hasNextRef.current) {
        setNextCountdown(5);
      }
    };
    const onCanPlay = () => {
      setIsBuffering(false);
      setHasLoadedOnce(true);
      if (episodeKey && !restoredRef.current) {
        restoredRef.current = true;
        void loadPlaybackProgress().then((all) => {
          const saved = all[episodeKey];
          if (
            saved &&
            saved.position > 5 &&
            saved.duration > 0 &&
            saved.position < saved.duration - 10
          ) {
            video.currentTime = saved.position;
          }
        });
      }
    };
    const onTimeUpdate = () => {
      const ct = video.currentTime || 0;
      const dur = video.duration || 0;
      setCurrentTime(ct);
      setDuration(dur);
      if (video.buffered && video.buffered.length > 0) {
        try {
          setBufferedTime(video.buffered.end(video.buffered.length - 1));
        } catch {
          // ignore
        }
      }
      setIsBuffering(false);
      setHasLoadedOnce(true);
      if (episodeKey && dur > 0) {
        const sec = Math.floor(ct);
        if (sec > 4 && Math.abs(sec - lastSavedSecRef.current) >= 10) {
          lastSavedSecRef.current = sec;
          void savePlaybackProgress(episodeKey, ct, dur, {
            title: metaRef.current.title,
            thumbnail: metaRef.current.posterThumbnail,
          });
        }
        if (!watchedMarkedRef.current && ct / dur >= 0.8) {
          watchedMarkedRef.current = true;
          onWatchedRef.current?.(episodeKey);
        }
      }
    };

    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('waiting', onWaiting);
    video.addEventListener('ended', onEnded);
    video.addEventListener('canplay', onCanPlay);
    video.addEventListener('playing', onCanPlay);
    video.addEventListener('timeupdate', onTimeUpdate);

    return () => {
      persistProgressNow();
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('waiting', onWaiting);
      video.removeEventListener('ended', onEnded);
      video.removeEventListener('canplay', onCanPlay);
      video.removeEventListener('playing', onCanPlay);
      video.removeEventListener('timeupdate', onTimeUpdate);
      if (hls) {
        hls.destroy();
        hlsRef.current = null;
      }
    };
  }, [uri, isHls, episodeKey]);

  useEffect(() => {
    if (nextCountdown === null) return;
    if (nextCountdown <= 0) {
      setNextCountdown(null);
      onNext?.();
      return;
    }
    const t = setTimeout(() => setNextCountdown((c) => (c !== null ? c - 1 : null)), 1000);
    return () => clearTimeout(t);
  }, [nextCountdown, onNext]);

  const keyHandlerRef = useRef<(ev: KeyboardEvent) => void>(() => {});
  keyHandlerRef.current = (ev: KeyboardEvent) => {
    const tag = (ev.target as HTMLElement | null)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (ev.code === 'Space' || ev.key === 'k' || ev.key === 'K') {
      ev.preventDefault();
      handleTogglePlay();
    } else if (ev.key === 'ArrowLeft') {
      ev.preventDefault();
      handleSeekBy(-10);
    } else if (ev.key === 'ArrowRight') {
      ev.preventDefault();
      handleSeekBy(10);
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      handleStepVolume(0.1);
    } else if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      handleStepVolume(-0.1);
    } else if (ev.key === 'm' || ev.key === 'M') {
      ev.preventDefault();
      handleToggleMute();
    } else if (ev.key === 'f' || ev.key === 'F') {
      ev.preventDefault();
      void handleToggleFullscreen();
    }
  };

  // Web keyboard shortcuts (Space, Arrows, F, M) — attached once!
  useEffect(() => {
    if (typeof globalThis.window === 'undefined') return;
    const listener = (ev: KeyboardEvent) => keyHandlerRef.current(ev);
    globalThis.window.addEventListener('keydown', listener);
    return () => globalThis.window.removeEventListener('keydown', listener);
  }, []);

  useEffect(() => {
    if (!selectedExtSubUrl) {
      setExtCues([]);
      return;
    }
    let cancelled = false;
    const proxiedSub = buildProxyUrl(backendUrl, selectedExtSubUrl, referer, accessPin);
    void fetch(proxiedSub)
      .then((r) => r.text())
      .then((txt) => {
        if (!cancelled) setExtCues(parseVttCues(txt));
      })
      .catch(() => {
        if (!cancelled) setExtCues([]);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedExtSubUrl, backendUrl, referer, accessPin]);

  const activeCueText = useMemo(() => {
    if (extCues.length === 0) return '';
    const found = extCues.find((c) => currentTime >= c.start && currentTime <= c.end);
    return found?.text ?? '';
  }, [extCues, currentTime]);

  const progressRatio = duration > 0 ? Math.min(1, Math.max(0, currentTime / duration)) : 0;
  const bufferedRatio = duration > 0 ? Math.min(1, Math.max(progressRatio, bufferedTime / duration)) : 0;

  const handleTogglePlay = () => {
    const v = videoElRef.current;
    if (!v) return;
    if (v.paused) {
      void v.play();
    } else {
      v.pause();
    }
  };

  const handleSeekBy = (delta: number) => {
    const v = videoElRef.current;
    if (!v) return;
    v.currentTime = Math.max(0, Math.min(v.duration || 0, (v.currentTime || 0) + delta));
  };

  const handleCycleSpeed = () => {
    const nextIdx = (speedIdx + 1) % SPEED_OPTIONS.length;
    setSpeedIdx(nextIdx);
    if (videoElRef.current) {
      videoElRef.current.playbackRate = SPEED_OPTIONS[nextIdx];
    }
  };

  const handleToggleMute = () => {
    const nextMuted = !isMuted;
    setIsMuted(nextMuted);
    if (videoElRef.current) {
      videoElRef.current.muted = nextMuted;
    }
  };

  const handleStepVolume = (delta: number) => {
    const next = Math.min(1, Math.max(0, Math.round((volume + delta) * 10) / 10));
    setVolume(next);
    if (videoElRef.current) {
      videoElRef.current.volume = next;
      if (next > 0 && isMuted) {
        setIsMuted(false);
        videoElRef.current.muted = false;
      } else if (next === 0 && !isMuted) {
        setIsMuted(true);
        videoElRef.current.muted = true;
      }
    }
  };

  const handleSeekBarPress = (evt: { nativeEvent: { locationX: number } }) => {
    const v = videoElRef.current;
    if (!v || duration <= 0 || barWidth <= 0) return;
    const ratio = Math.min(1, Math.max(0, evt.nativeEvent.locationX / barWidth));
    v.currentTime = ratio * duration;
  };

  const handleBarLayout = (e: LayoutChangeEvent) => {
    setBarWidth(e.nativeEvent.layout.width || 1);
  };

  const handleToggleFullscreen = async () => {
    try {
      const doc = globalThis.document as unknown as {
        fullscreenElement?: unknown;
        exitFullscreen?: () => Promise<void>;
      };
      if (doc?.fullscreenElement) {
        await doc.exitFullscreen?.();
        setIsFullscreen(false);
      } else {
        await containerRef.current?.requestFullscreen?.();
        setIsFullscreen(true);
      }
    } catch {
      setIsFullscreen((v) => !v);
    }
  };

  const currentAudioLabel =
    audioTracks.find((a) => a.id === selectedAudioId)?.name || 'Idioma';

  return (
    <div
      ref={containerRef}
      style={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        height: '100%',
        backgroundColor: '#000',
        overflow: 'hidden',
      }}
    >
      <Pressable
        style={[styles.videoWrapper, { width: '100%', height: '100%' }]}
        onPress={() => setControlsVisible((v) => !v)}
      >
        <video
          ref={videoElRef}
          playsInline
          crossOrigin="anonymous"
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            height: '100%',
            display: 'block',
            objectFit: contentFit,
            backgroundColor: '#000',
          }}
        />

        {activeCueText ? (
          <View style={styles.subtitleBox} pointerEvents="none">
            <Text style={styles.subtitleText}>{activeCueText}</Text>
          </View>
        ) : null}

        {isBuffering && !hasLoadedOnce && (
          <View style={styles.loadingOverlay} pointerEvents="none">
            <ActivityIndicator size="large" color="#818cf8" />
            <Text style={styles.loadingText}>Cargando video...</Text>
          </View>
        )}
        {isBuffering && hasLoadedOnce && (
          <View style={styles.rebufferBadge} pointerEvents="none">
            <ActivityIndicator size="small" color="#ffffff" />
          </View>
        )}

        {nextCountdown !== null && (
          <View style={styles.nextUpBanner}>
            <Text style={styles.nextUpText}>
              Siguiente episodio en {nextCountdown}s...
            </Text>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <TouchableOpacity
                style={styles.playerPillBtn}
                onPress={() => setNextCountdown(null)}
              >
                <Text style={styles.playerPillText}>Cancelar</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.playerPillBtn, { backgroundColor: '#4f46e5' }]}
                onPress={() => {
                  setNextCountdown(null);
                  onNext?.();
                }}
              >
                <Text style={styles.playerPillText}>Ver ahora</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {controlsVisible && (
          <View style={styles.playerOverlay} pointerEvents="box-none">
            <View style={styles.playerTopBar}>
              <TouchableOpacity onPress={onClose} style={styles.playerIconBtn}>
                <Ionicons name="arrow-back" size={22} color="#ffffff" />
              </TouchableOpacity>
              <Text style={styles.playerTitle} numberOfLines={1}>
                {title}
              </Text>
              <TouchableOpacity
                onPress={() => {
                  setTracksTab('audio');
                  setTracksModalOpen(true);
                }}
                style={styles.playerPillBtn}
              >
                <Ionicons name="headset-outline" size={14} color="#e0e7ff" />
                <Text style={styles.playerPillText}>{currentAudioLabel}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => {
                  setTracksTab('quality');
                  setTracksModalOpen(true);
                }}
                style={styles.playerPillBtn}
              >
                <Ionicons name="settings-outline" size={14} color="#e0e7ff" />
                <Text style={styles.playerPillText}>Calidad / CC</Text>
              </TouchableOpacity>
              {hasServers && (
                <TouchableOpacity onPress={onOpenServers} style={styles.playerPillBtn}>
                  <Ionicons name="server-outline" size={14} color="#e0e7ff" />
                  <Text style={styles.playerPillText}>Servidores</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity onPress={handleCycleSpeed} style={styles.playerPillBtn}>
                <Text style={styles.playerPillText}>{SPEED_OPTIONS[speedIdx]}x</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => setContentFit((f) => (f === 'contain' ? 'cover' : 'contain'))}
                style={styles.playerIconBtn}
              >
                <Ionicons
                  name={contentFit === 'contain' ? 'expand-outline' : 'contract-outline'}
                  size={20}
                  color="#ffffff"
                />
              </TouchableOpacity>
            </View>

            <View style={styles.centerControls}>
              <TouchableOpacity onPress={() => handleSeekBy(-10)} style={styles.skipBtn}>
                <Ionicons name="play-back" size={26} color="#ffffff" />
                <Text style={styles.skipLabel}>10s</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={handleTogglePlay} style={styles.playPauseCircle}>
                <Ionicons name={isPlaying ? 'pause' : 'play'} size={34} color="#ffffff" />
              </TouchableOpacity>
              <TouchableOpacity onPress={() => handleSeekBy(10)} style={styles.skipBtn}>
                <Ionicons name="play-forward" size={26} color="#ffffff" />
                <Text style={styles.skipLabel}>10s</Text>
              </TouchableOpacity>
            </View>

            <View style={styles.playerBottomBar}>
              <View style={styles.timeRow}>
                <Text style={styles.timeText}>{formatTime(currentTime)}</Text>
                <Pressable
                  style={styles.seekTrack}
                  onLayout={handleBarLayout}
                  onPress={handleSeekBarPress}
                >
                  <View style={[styles.seekBuffered, { width: `${bufferedRatio * 100}%` }]} />
                  <View style={[styles.seekFill, { width: `${progressRatio * 100}%` }]} />
                </Pressable>
                <Text style={styles.timeText}>{formatTime(duration)}</Text>
              </View>

              <View style={styles.bottomActionsRow}>
                <View style={styles.epNavRow}>
                  <TouchableOpacity
                    onPress={() => handleSeekBy(85)}
                    style={styles.playerPillBtn}
                  >
                    <Ionicons name="play-forward-outline" size={14} color="#e0e7ff" />
                    <Text style={styles.playerPillText}>+85s Intro</Text>
                  </TouchableOpacity>
                  {hasPrev && (
                    <TouchableOpacity onPress={onPrev} style={styles.playerPillBtn}>
                      <Ionicons name="play-skip-back" size={14} color="#e0e7ff" />
                      <Text style={styles.playerPillText}>Anterior</Text>
                    </TouchableOpacity>
                  )}
                  {hasNext && (
                    <TouchableOpacity onPress={onNext} style={styles.playerPillBtn}>
                      <Text style={styles.playerPillText}>Siguiente</Text>
                      <Ionicons name="play-skip-forward" size={14} color="#e0e7ff" />
                    </TouchableOpacity>
                  )}
                  <View style={styles.volumeGroup}>
                    <TouchableOpacity onPress={handleToggleMute} style={styles.volBtn}>
                      <Ionicons
                        name={isMuted || volume === 0 ? 'volume-mute' : volume < 0.5 ? 'volume-low' : 'volume-high'}
                        size={17}
                        color="#e0e7ff"
                      />
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => handleStepVolume(-0.2)} style={styles.volBtn}>
                      <Ionicons name="remove" size={15} color="#e0e7ff" />
                    </TouchableOpacity>
                    <Text style={styles.volText}>{isMuted ? '0%' : `${Math.round(volume * 100)}%`}</Text>
                    <TouchableOpacity onPress={() => handleStepVolume(0.2)} style={styles.volBtn}>
                      <Ionicons name="add" size={15} color="#e0e7ff" />
                    </TouchableOpacity>
                  </View>
                </View>

                <TouchableOpacity
                  onPress={() => void handleToggleFullscreen()}
                  style={styles.playerIconBtn}
                >
                  <Ionicons
                    name={isFullscreen ? 'contract-outline' : 'scan-outline'}
                    size={21}
                    color="#ffffff"
                  />
                </TouchableOpacity>
              </View>
            </View>
          </View>
        )}

        {tracksModalOpen && (
          <TouchableOpacity
            style={styles.serverOverlayBackdrop}
            activeOpacity={1}
            onPress={() => setTracksModalOpen(false)}
          >
            <View style={styles.serverOverlayCard}>
              <View style={styles.trackTabsRow}>
                <TouchableOpacity
                  style={[styles.trackTabBtn, tracksTab === 'audio' && styles.trackTabBtnActive]}
                  onPress={() => setTracksTab('audio')}
                >
                  <Ionicons
                    name="headset-outline"
                    size={16}
                    color={tracksTab === 'audio' ? '#ef4444' : '#94a3b8'}
                  />
                  <Text
                    style={[
                      styles.trackTabText,
                      tracksTab === 'audio' && styles.trackTabTextActive,
                    ]}
                  >
                    Idioma
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.trackTabBtn, tracksTab === 'sub' && styles.trackTabBtnActive]}
                  onPress={() => setTracksTab('sub')}
                >
                  <Ionicons
                    name="chatbox-ellipses-outline"
                    size={16}
                    color={tracksTab === 'sub' ? '#ef4444' : '#94a3b8'}
                  />
                  <Text
                    style={[
                      styles.trackTabText,
                      tracksTab === 'sub' && styles.trackTabTextActive,
                    ]}
                  >
                    CC
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.trackTabBtn, tracksTab === 'quality' && styles.trackTabBtnActive]}
                  onPress={() => setTracksTab('quality')}
                >
                  <Ionicons
                    name="stats-chart-outline"
                    size={16}
                    color={tracksTab === 'quality' ? '#ef4444' : '#94a3b8'}
                  />
                  <Text
                    style={[
                      styles.trackTabText,
                      tracksTab === 'quality' && styles.trackTabTextActive,
                    ]}
                  >
                    Calidad
                  </Text>
                </TouchableOpacity>
              </View>

              <ScrollView style={{ maxHeight: 300 }}>
                {tracksTab === 'audio' && (
                  audioTracks.length === 0 ? (
                    <Text style={styles.loadingText}>Pista de audio única</Text>
                  ) : (
                    audioTracks.map((tr) => {
                      const active = selectedAudioId === tr.id;
                      return (
                        <TouchableOpacity
                          key={tr.id}
                          style={[
                            styles.serverOverlayRow,
                            active && styles.serverOverlayRowActive,
                          ]}
                          onPress={() => {
                            if (hlsRef.current) {
                              hlsRef.current.audioTrack = tr.id;
                            }
                            setSelectedAudioId(tr.id);
                            setTracksModalOpen(false);
                          }}
                        >
                          <Ionicons
                            name={active ? 'checkmark-circle' : 'volume-medium-outline'}
                            size={18}
                            color={active ? '#ef4444' : '#e2e8f0'}
                          />
                          <Text style={styles.serverOverlayText}>{tr.name}</Text>
                        </TouchableOpacity>
                      );
                    })
                  )
                )}

                {tracksTab === 'sub' && (
                  <>
                    <TouchableOpacity
                      style={[
                        styles.serverOverlayRow,
                        selectedHlsSubId === -1 &&
                          !selectedExtSubUrl &&
                          styles.serverOverlayRowActive,
                      ]}
                      onPress={() => {
                        if (hlsRef.current) hlsRef.current.subtitleTrack = -1;
                        setSelectedHlsSubId(-1);
                        setSelectedExtSubUrl(null);
                        setTracksModalOpen(false);
                      }}
                    >
                      <Ionicons
                        name={
                          selectedHlsSubId === -1 && !selectedExtSubUrl
                            ? 'checkmark-circle'
                            : 'close-circle-outline'
                        }
                        size={18}
                        color={
                          selectedHlsSubId === -1 && !selectedExtSubUrl
                            ? '#ef4444'
                            : '#e2e8f0'
                        }
                      />
                      <Text style={styles.serverOverlayText}>Desactivados</Text>
                    </TouchableOpacity>

                    {hlsSubs.map((sub) => {
                      const active = selectedHlsSubId === sub.id;
                      return (
                        <TouchableOpacity
                          key={`hs-${sub.id}`}
                          style={[
                            styles.serverOverlayRow,
                            active && styles.serverOverlayRowActive,
                          ]}
                          onPress={() => {
                            setSelectedExtSubUrl(null);
                            if (hlsRef.current) hlsRef.current.subtitleTrack = sub.id;
                            setSelectedHlsSubId(sub.id);
                            setTracksModalOpen(false);
                          }}
                        >
                          <Ionicons
                            name={active ? 'checkmark-circle' : 'text-outline'}
                            size={18}
                            color={active ? '#ef4444' : '#e2e8f0'}
                          />
                          <Text style={styles.serverOverlayText}>{sub.name}</Text>
                        </TouchableOpacity>
                      );
                    })}

                    {externalSubtitles?.map((sub, idx) => {
                      const active = selectedExtSubUrl === sub.url;
                      return (
                        <TouchableOpacity
                          key={`es-${idx}`}
                          style={[
                            styles.serverOverlayRow,
                            active && styles.serverOverlayRowActive,
                          ]}
                          onPress={() => {
                            if (hlsRef.current) hlsRef.current.subtitleTrack = -1;
                            setSelectedHlsSubId(-1);
                            setSelectedExtSubUrl(sub.url);
                            setTracksModalOpen(false);
                          }}
                        >
                          <Ionicons
                            name={active ? 'checkmark-circle' : 'text-outline'}
                            size={18}
                            color={active ? '#ef4444' : '#e2e8f0'}
                          />
                          <Text style={styles.serverOverlayText}>{sub.label}</Text>
                        </TouchableOpacity>
                      );
                    })}
                  </>
                )}

                {tracksTab === 'quality' && (
                  <>
                    <TouchableOpacity
                      style={[
                        styles.serverOverlayRow,
                        selectedLevelId === -1 && styles.serverOverlayRowActive,
                      ]}
                      onPress={() => {
                        if (hlsRef.current) hlsRef.current.currentLevel = -1;
                        setSelectedLevelId(-1);
                        setTracksModalOpen(false);
                      }}
                    >
                      <Ionicons
                        name={selectedLevelId === -1 ? 'checkmark-circle' : 'videocam-outline'}
                        size={18}
                        color={selectedLevelId === -1 ? '#ef4444' : '#e2e8f0'}
                      />
                      <Text style={styles.serverOverlayText}>Auto (Máxima)</Text>
                    </TouchableOpacity>
                    {qualityLevels.map((ql) => {
                      const active = selectedLevelId === ql.id;
                      return (
                        <TouchableOpacity
                          key={ql.id}
                          style={[
                            styles.serverOverlayRow,
                            active && styles.serverOverlayRowActive,
                          ]}
                          onPress={() => {
                            if (hlsRef.current) hlsRef.current.currentLevel = ql.id;
                            setSelectedLevelId(ql.id);
                            setTracksModalOpen(false);
                          }}
                        >
                          <Ionicons
                            name={active ? 'checkmark-circle' : 'videocam-outline'}
                            size={18}
                            color={active ? '#ef4444' : '#e2e8f0'}
                          />
                          <Text style={styles.serverOverlayText}>{ql.label}</Text>
                        </TouchableOpacity>
                      );
                    })}
                  </>
                )}
              </ScrollView>
            </View>
          </TouchableOpacity>
        )}
      </Pressable>
    </div>
  );
}

const styles = StyleSheet.create({
  videoWrapper: {
    flex: 1,
    backgroundColor: '#000000',
    position: 'relative',
  },
  subtitleBox: {
    position: 'absolute',
    bottom: 66,
    left: 20,
    right: 20,
    alignItems: 'center',
  },
  subtitleText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
    textAlign: 'center',
    backgroundColor: 'rgba(0,0,0,0.7)',
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 6,
  },
  rebufferBadge: {
    position: 'absolute',
    top: 56,
    right: 16,
    padding: 8,
    borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
  nextUpBanner: {
    position: 'absolute',
    bottom: 84,
    right: 20,
    backgroundColor: 'rgba(20, 22, 32, 0.92)',
    borderRadius: 14,
    padding: 14,
    gap: 10,
    borderWidth: 1,
    borderColor: '#4f46e5',
    zIndex: 25,
  },
  nextUpText: {
    color: '#f8fafc',
    fontSize: 13.5,
    fontWeight: '600',
  },
  loadingOverlay: {
    ...StyleSheet.absoluteFill,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#09090b',
    gap: 12,
  },
  loadingText: {
    color: '#a1a1aa',
    fontSize: 14,
    textAlign: 'center',
    paddingHorizontal: 24,
  },
  playerOverlay: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(0,0,0,0.42)',
    justifyContent: 'space-between',
    padding: 14,
  },
  playerTopBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
  },
  playerTitle: {
    flex: 1,
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '600',
  },
  playerIconBtn: {
    padding: 7,
    borderRadius: 20,
    backgroundColor: 'rgba(15, 23, 42, 0.55)',
  },
  playerPillBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: 'rgba(15, 23, 42, 0.65)',
  },
  playerPillText: {
    color: '#e0e7ff',
    fontSize: 12,
    fontWeight: '600',
  },
  centerControls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 36,
  },
  skipBtn: {
    alignItems: 'center',
    padding: 10,
  },
  skipLabel: {
    color: '#e2e8f0',
    fontSize: 11,
    fontWeight: '600',
    marginTop: 2,
  },
  playPauseCircle: {
    width: 68,
    height: 68,
    borderRadius: 34,
    backgroundColor: 'rgba(99, 102, 241, 0.85)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  playerBottomBar: {
    gap: 10,
  },
  timeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  timeText: {
    color: '#f1f5f9',
    fontSize: 12,
    fontVariant: ['tabular-nums'],
  },
  seekTrack: {
    flex: 1,
    height: 12,
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.2)',
    borderRadius: 6,
    overflow: 'hidden',
    position: 'relative',
  },
  seekBuffered: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    backgroundColor: 'rgba(255,255,255,0.32)',
    borderRadius: 6,
  },
  seekFill: {
    height: '100%',
    backgroundColor: '#818cf8',
    borderRadius: 6,
  },
  bottomActionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  epNavRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
  },
  volumeGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(15, 23, 42, 0.65)',
    borderRadius: 16,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  volBtn: {
    padding: 3,
  },
  volText: {
    color: '#e0e7ff',
    fontSize: 11.5,
    fontWeight: '600',
    minWidth: 34,
    textAlign: 'center',
  },
  serverOverlayBackdrop: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  serverOverlayCard: {
    width: '100%',
    maxWidth: 340,
    backgroundColor: '#1e212d',
    borderRadius: 16,
    padding: 16,
    gap: 6,
    borderWidth: 1,
    borderColor: '#323644',
  },
  serverOverlayRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 11,
    paddingHorizontal: 10,
    borderRadius: 10,
  },
  serverOverlayRowActive: {
    backgroundColor: 'rgba(239, 68, 68, 0.2)',
  },
  serverOverlayText: {
    flex: 1,
    color: '#f1f5f9',
    fontSize: 14,
  },
  trackTabsRow: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: '#2d3142',
    marginBottom: 8,
  },
  trackTabBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    paddingVertical: 10,
  },
  trackTabBtnActive: {
    borderBottomWidth: 2,
    borderBottomColor: '#ef4444',
  },
  trackTabText: {
    color: '#94a3b8',
    fontSize: 12.5,
    fontWeight: '600',
  },
  trackTabTextActive: {
    color: '#ef4444',
  },
});
