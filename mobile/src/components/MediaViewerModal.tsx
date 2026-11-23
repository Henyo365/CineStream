import { Ionicons } from '@expo/vector-icons';
import { useEvent, useEventListener } from 'expo';
import { File, Paths } from 'expo-file-system';
import * as ScreenOrientation from 'expo-screen-orientation';
import * as Sharing from 'expo-sharing';
import { StatusBar } from 'expo-status-bar';
import {
  useVideoPlayer,
  VideoView,
  type AudioTrack,
  type SubtitleTrack,
  type VideoContentFit,
  type VideoTrack,
} from 'expo-video';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  type LayoutChangeEvent,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StatusBar as RNStatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import { buildProxyUrl, resolveVideoUrl, type SubtitleOption } from '../services/api';
import { loadPlaybackProgress, savePlaybackProgress } from '../services/storage';
import type { MediaItem } from '../types';
import { parseVttCues, type SubtitleCue } from '../utils/vtt';
import { WebCustomVideoPlayer } from './WebCustomVideoPlayer';

interface MediaViewerModalProps {
  item: MediaItem | null;
  backendUrl: string;
  accessPin?: string;
  referer?: string;
  episodeTitle?: string;
  episodeThumbnail?: string;
  serverOptions?: MediaItem[];
  onSelectServer?: (server: MediaItem) => void;
  hasPrevEpisode?: boolean;
  hasNextEpisode?: boolean;
  onPrevEpisode?: () => void;
  onNextEpisode?: () => void;
  onWatched?: (episodeUrl: string) => void;
  onClose: () => void;
}

const CHROME_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';

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

function buildHlsPlayerHtml(
  streamUrl: string,
  subtitles?: SubtitleOption[],
  proxyOrigin?: string,
  referer?: string,
  pin?: string,
): string {
  const safeUrl = JSON.stringify(streamUrl);
  const safeSubs = JSON.stringify(
    (subtitles ?? []).map((s) => ({
      label: s.label,
      url: proxyOrigin ? buildProxyUrl(proxyOrigin, s.url, referer, pin) : s.url,
    })),
  );
  return `<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">
  <style>
    * { box-sizing: border-box; }
    html, body { margin:0; padding:0; width:100%; height:100%; background:#000; font-family: system-ui, -apple-system, sans-serif; overflow:hidden; }
    .wrap { position:relative; width:100%; height:100%; display:flex; align-items:center; justify-content:center; }
    video { width:100%; height:100%; max-height:100vh; background:#000; }
    .gear-btn { position:absolute; top:14px; right:14px; z-index:20; background:rgba(20,22,30,0.85); color:#fff; border:1px solid rgba(255,255,255,0.18); border-radius:20px; padding:7px 14px; font-size:13px; font-weight:600; cursor:pointer; display:flex; gap:8px; align-items:center; }
    .menu { position:absolute; top:56px; right:14px; z-index:30; width:250px; background:#14151a; border:1px solid #2b2d38; border-radius:14px; color:#f1f5f9; box-shadow:0 12px 32px rgba(0,0,0,0.65); display:none; overflow:hidden; }
    .menu.open { display:block; }
    .tabs { display:flex; border-bottom:1px solid #2b2d38; background:#1b1d24; }
    .tab { flex:1; padding:10px 6px; text-align:center; font-size:13px; cursor:pointer; color:#94a3b8; border:none; background:transparent; font-weight:600; }
    .tab.active { color:#ef4444; border-bottom:2px solid #ef4444; }
    .list { max-height:240px; overflow-y:auto; padding:8px; display:flex; flex-direction:column; gap:4px; }
    .opt { text-align:left; padding:9px 12px; border-radius:10px; border:none; background:transparent; color:#e2e8f0; font-size:13.5px; cursor:pointer; }
    .opt:hover { background:#252834; }
    .opt.active { background:#ef4444; color:#fff; font-weight:600; }
  </style>
  <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
</head>
<body>
  <div class="wrap">
    <video id="v" controls autoplay playsinline crossorigin="anonymous"></video>
    <button class="gear-btn" id="gearBtn">⚙ Calidad • Idioma • Sub</button>
    <div class="menu" id="menu">
      <div class="tabs">
        <button class="tab active" data-tab="quality">Calidad</button>
        <button class="tab" data-tab="audio">Idioma</button>
        <button class="tab" data-tab="sub">CC</button>
        <button class="tab" data-tab="speed">Vel.</button>
      </div>
      <div class="list" id="optList"></div>
    </div>
  </div>
  <script>
    var video = document.getElementById('v');
    var src = ${safeUrl};
    var extSubs = ${safeSubs};
    var menu = document.getElementById('menu');
    var optList = document.getElementById('optList');
    var gearBtn = document.getElementById('gearBtn');
    var currentTab = 'quality';
    var hls = null;

    extSubs.forEach(function(s, idx) {
      var tr = document.createElement('track');
      tr.kind = 'subtitles';
      tr.label = s.label;
      tr.src = s.url;
      if (idx === 0) tr.default = false;
      video.appendChild(tr);
    });

    gearBtn.onclick = function(e) {
      e.stopPropagation();
      menu.classList.toggle('open');
      renderTab();
    };
    document.querySelectorAll('.tab').forEach(function(btn) {
      btn.onclick = function() {
        document.querySelectorAll('.tab').forEach(function(b) { b.classList.remove('active'); });
        btn.classList.add('active');
        currentTab = btn.getAttribute('data-tab');
        renderTab();
      };
    });

    function renderTab() {
      optList.innerHTML = '';
      if (currentTab === 'quality') {
        if (!hls || !hls.levels || hls.levels.length === 0) {
          optList.innerHTML = '<div class="opt">Calidad automática</div>';
          return;
        }
        var autoBtn = document.createElement('button');
        autoBtn.className = 'opt' + (hls.currentLevel === -1 ? ' active' : '');
        autoBtn.textContent = 'Auto (Máxima)';
        autoBtn.onclick = function() { hls.currentLevel = -1; renderTab(); };
        optList.appendChild(autoBtn);

        hls.levels.slice().sort(function(a,b){ return (b.height||0)-(a.height||0); }).forEach(function(lvl) {
          var realIdx = hls.levels.indexOf(lvl);
          var b = document.createElement('button');
          b.className = 'opt' + (hls.currentLevel === realIdx ? ' active' : '');
          b.textContent = (lvl.height ? lvl.height + 'p' : Math.round((lvl.bitrate||0)/1000) + ' kbps');
          b.onclick = function() { hls.currentLevel = realIdx; renderTab(); };
          optList.appendChild(b);
        });
      } else if (currentTab === 'audio') {
        if (!hls || !hls.audioTracks || hls.audioTracks.length === 0) {
          optList.innerHTML = '<div class="opt">Pista predeterminada</div>';
          return;
        }
        hls.audioTracks.forEach(function(tr, idx) {
          var b = document.createElement('button');
          b.className = 'opt' + (hls.audioTrack === idx ? ' active' : '');
          b.textContent = tr.name || tr.lang || ('Idioma ' + (idx + 1));
          b.onclick = function() { hls.audioTrack = idx; renderTab(); };
          optList.appendChild(b);
        });
      } else if (currentTab === 'sub') {
        var offBtn = document.createElement('button');
        var anyActive = false;
        for (var i = 0; i < video.textTracks.length; i++) {
          if (video.textTracks[i].mode === 'showing') anyActive = true;
        }
        offBtn.className = 'opt' + (!anyActive && (!hls || hls.subtitleTrack === -1) ? ' active' : '');
        offBtn.textContent = 'Desactivados';
        offBtn.onclick = function() {
          if (hls) hls.subtitleTrack = -1;
          for (var j = 0; j < video.textTracks.length; j++) video.textTracks[j].mode = 'disabled';
          renderTab();
        };
        optList.appendChild(offBtn);

        if (hls && hls.subtitleTracks) {
          hls.subtitleTracks.forEach(function(st, idx) {
            var b = document.createElement('button');
            b.className = 'opt' + (hls.subtitleTrack === idx ? ' active' : '');
            b.textContent = st.name || st.lang || ('Sub ' + (idx + 1));
            b.onclick = function() { hls.subtitleTrack = idx; renderTab(); };
            optList.appendChild(b);
          });
        }
        for (var k = 0; k < video.textTracks.length; k++) {
          (function(track) {
            var b = document.createElement('button');
            b.className = 'opt' + (track.mode === 'showing' ? ' active' : '');
            b.textContent = track.label || track.language || 'Subtítulo';
            b.onclick = function() {
              for (var j = 0; j < video.textTracks.length; j++) video.textTracks[j].mode = 'disabled';
              track.mode = 'showing';
              renderTab();
            };
            optList.appendChild(b);
          })(video.textTracks[k]);
        }
      } else if (currentTab === 'speed') {
        [0.75, 1, 1.25, 1.5, 2].forEach(function(sp) {
          var b = document.createElement('button');
          b.className = 'opt' + (video.playbackRate === sp ? ' active' : '');
          b.textContent = sp + 'x';
          b.onclick = function() { video.playbackRate = sp; renderTab(); };
          optList.appendChild(b);
        });
      }
    }

    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = src;
    } else if (window.Hls && Hls.isSupported()) {
      hls = new Hls({ startLevel: -1 });
      hls.loadSource(src);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, function(e, data) {
        if (data.levels && data.levels.length > 0) {
          // Seleccionar automáticamente la resolución más alta
          var bestIdx = 0;
          var bestH = 0;
          data.levels.forEach(function(l, i) {
            if ((l.height || 0) >= bestH) { bestH = l.height || 0; bestIdx = i; }
          });
          hls.currentLevel = bestIdx;
        }
        renderTab();
      });
      hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, renderTab);
      hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, renderTab);
    } else {
      video.src = src;
    }
  </script>
</body>
</html>`;
}

function CustomNativePlayer({
  uri,
  isHls,
  backendUrl,
  accessPin,
  referer,
  episodeKey,
  initialPositionSec,
  title,
  progressTitle,
  posterThumbnail,
  externalSubtitles,
  hasServers,
  onOpenServers,
  hasPrev,
  hasNext,
  onPrev,
  onNext,
  onWatched,
  onRecoverStream,
  onFallback,
  onClose,
}: {
  uri: string;
  isHls: boolean;
  backendUrl: string;
  accessPin?: string;
  referer?: string;
  episodeKey?: string;
  initialPositionSec?: number;
  title: string;
  progressTitle?: string;
  posterThumbnail?: string;
  externalSubtitles?: SubtitleOption[];
  hasServers: boolean;
  onOpenServers: () => void;
  hasPrev?: boolean;
  hasNext?: boolean;
  onPrev?: () => void;
  onNext?: () => void;
  onWatched?: (url: string) => void;
  onRecoverStream?: (resumeAtSec: number) => void;
  onFallback: (errorMessage?: string, resumeAtSec?: number) => void;
  onClose: () => void;
}) {
  const videoRef = useRef<VideoView>(null);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [isLocked, setIsLocked] = useState(false);
  const [isRecovering, setIsRecovering] = useState(false);
  const [seekFeedback, setSeekFeedback] = useState<{ label: string; side: 'left' | 'right' } | null>(null);
  const [playerWidth, setPlayerWidth] = useState(360);
  const [speedIdx, setSpeedIdx] = useState(0);
  const [contentFit, setContentFit] = useState<VideoContentFit>('contain');
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [barWidth, setBarWidth] = useState(1);

  // Audio, Quality & Subtitles state
  const [tracksModalOpen, setTracksModalOpen] = useState(false);
  const [tracksTab, setTracksTab] = useState<'audio' | 'sub' | 'quality'>('audio');
  const [audioTracks, setAudioTracks] = useState<AudioTrack[]>([]);
  const [selectedAudio, setSelectedAudio] = useState<AudioTrack | null>(null);
  const [nativeSubs, setNativeSubs] = useState<SubtitleTrack[]>([]);
  const [selectedNativeSub, setSelectedNativeSub] = useState<SubtitleTrack | null>(null);
  const [selectedExtSubUrl, setSelectedExtSubUrl] = useState<string | null>(null);
  const [extCues, setExtCues] = useState<SubtitleCue[]>([]);
  const [videoTracks, setVideoTracks] = useState<VideoTrack[]>([]);
  const [nextCountdown, setNextCountdown] = useState<number | null>(null);

  const restoredRef = useRef(false);
  const watchedMarkedRef = useRef(false);
  const autoPickedAudioRef = useRef(false);
  const lastSavedSecRef = useRef(-10);
  const userPausedRef = useRef(false);
  const stallRef = useRef({ lastTime: -1, stuckTicks: 0, nudged: false });
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seekFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTapRef = useRef<{ time: number; side: 'left' | 'right' | 'center' }>({
    time: 0,
    side: 'center',
  });
  const latestPosRef = useRef({ currentTime: 0, duration: 0, status: 'idle' as string, isPlaying: false });

  // Stabilize callbacks so parent re-renders (e.g. at 80% watched mark!) never re-run player effects
  const onWatchedRef = useRef(onWatched);
  onWatchedRef.current = onWatched;
  const onFallbackRef = useRef(onFallback);
  onFallbackRef.current = onFallback;
  const onRecoverRef = useRef(onRecoverStream);
  onRecoverRef.current = onRecoverStream;

  const resetHideTimer = () => {
    if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
    if (isPlaying && !tracksModalOpen) {
      hideTimerRef.current = setTimeout(() => {
        setControlsVisible(false);
      }, 3500);
    }
  };

  // Memoize source so 1s timeUpdate renders never cause expo-video to reload!
  const videoSource = useMemo(
    () => ({
      uri,
      contentType: isHls ? ('hls' as const) : ('progressive' as const),
    }),
    [uri, isHls],
  );

  const player = useVideoPlayer(videoSource, (p) => {
    p.loop = false;
    p.timeUpdateEventInterval = 1;
    p.bufferOptions = {
      preferredForwardBufferDuration: 30,
      minBufferForPlayback: 2.5,
      maxBufferBytes: 32 * 1024 * 1024,
      prioritizeTimeOverSizeThreshold: false,
      waitsToMinimizeStalling: true,
    };
    p.play();
  });

  const { status, error } = useEvent(player, 'statusChange', {
    status: player.status,
  });
  const { isPlaying } = useEvent(player, 'playingChange', {
    isPlaying: player.playing,
  });
  const timeUpdate = useEvent(player, 'timeUpdate', {
    currentTime: player.currentTime,
    currentLiveTimestamp: null,
    currentOffsetFromLive: null,
    bufferedPosition: 0,
  });

  const currentTime = timeUpdate.currentTime ?? 0;
  const bufferedPosition = timeUpdate.bufferedPosition ?? 0;
  const duration = player.duration ?? 0;
  const progressRatio = duration > 0 ? Math.min(1, Math.max(0, currentTime / duration)) : 0;
  const bufferedRatio =
    duration > 0 ? Math.min(1, Math.max(progressRatio, bufferedPosition / duration)) : 0;

  latestPosRef.current = { currentTime, duration, status, isPlaying };

  const audioTracksEvt = useEvent(player, 'availableAudioTracksChange', {
    availableAudioTracks: player.availableAudioTracks ?? [],
  });
  const subTracksEvt = useEvent(player, 'availableSubtitleTracksChange', {
    availableSubtitleTracks: player.availableSubtitleTracks ?? [],
  });

  // Sync available audio, video & subtitle tracks
  useEffect(() => {
    const aTracks =
      audioTracksEvt.availableAudioTracks.length > 0
        ? audioTracksEvt.availableAudioTracks
        : (player.availableAudioTracks ?? []);
    const sTracks =
      subTracksEvt.availableSubtitleTracks.length > 0
        ? subTracksEvt.availableSubtitleTracks
        : (player.availableSubtitleTracks ?? []);
    const vTracks = [...(player.availableVideoTracks ?? [])].sort(
      (a, b) => (b.size?.height ?? 0) - (a.size?.height ?? 0),
    );

    setAudioTracks(aTracks);
    setNativeSubs(sTracks);
    setVideoTracks(vTracks);

    if (status === 'readyToPlay') {
      setHasLoadedOnce(true);
      if (!autoPickedAudioRef.current && aTracks.length > 0) {
        autoPickedAudioRef.current = true;
        const esTrack = aTracks.find(
          (t) =>
            t.language?.toLowerCase().startsWith('es') ||
            /espa|latin|castell/i.test(t.label || ''),
        );
        if (esTrack) {
          player.audioTrack = esTrack;
          setSelectedAudio(esTrack);
        } else {
          setSelectedAudio(player.audioTrack ?? aTracks[0]);
        }
      }
    }
  }, [status, player, audioTracksEvt, subTracksEvt]);

  // Restore saved playback position (or exact stream-recovery timestamp) once ready
  useEffect(() => {
    if (status === 'readyToPlay' && !restoredRef.current) {
      restoredRef.current = true;
      if (initialPositionSec && initialPositionSec > 3) {
        player.currentTime = initialPositionSec;
        return;
      }
      if (episodeKey) {
        void loadPlaybackProgress().then((all) => {
          const saved = all[episodeKey];
          if (saved && saved.position > 5 && saved.duration > 0 && saved.position < saved.duration - 10) {
            player.currentTime = saved.position;
          }
        });
      }
    }
  }, [status, episodeKey, initialPositionSec, player]);

  useEventListener(player, 'playToEnd', () => {
    const dur = player.duration || latestPosRef.current.duration;
    if (episodeKey && dur > 0) {
      void savePlaybackProgress(episodeKey, dur, dur, {
        title: progressTitle || title,
        thumbnail: posterThumbnail,
      });
      if (!watchedMarkedRef.current) {
        watchedMarkedRef.current = true;
        onWatchedRef.current?.(episodeKey);
      }
    }
    if (hasNext) {
      setNextCountdown(5);
    }
  });

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

  // Throttled playback progress save (every 10s) & mark watched at 80%
  useEffect(() => {
    if (!episodeKey || duration <= 0) return;
    const sec = Math.floor(currentTime);
    if (sec > 4 && Math.abs(sec - lastSavedSecRef.current) >= 10) {
      lastSavedSecRef.current = sec;
      void savePlaybackProgress(episodeKey, currentTime, duration, {
        title: progressTitle || title,
        thumbnail: posterThumbnail,
      });
    }
    if (!watchedMarkedRef.current && currentTime / duration >= 0.8) {
      watchedMarkedRef.current = true;
      onWatchedRef.current?.(episodeKey);
    }
  }, [currentTime, duration, episodeKey, progressTitle, title, posterThumbnail]);

  // Stall Watchdog: detects freezes/infinite rebuffering (e.g. after ~20m on HLS/CDN)
  // Level 1 (8s): gentle seek nudge; Level 2 (16s): seamless fresh stream reconnect at exact timestamp!
  useEffect(() => {
    if (!hasLoadedOnce) return;
    const timer = setInterval(() => {
      const { currentTime: ct, duration: dur, status: st, isPlaying: playing } = latestPosRef.current;
      if (userPausedRef.current || st === 'error') {
        stallRef.current = { lastTime: ct, stuckTicks: 0, nudged: false };
        setIsRecovering(false);
        return;
      }
      if (dur > 0 && ct >= dur - 2) {
        return;
      }
      const moved = Math.abs(ct - stallRef.current.lastTime) > 0.25;
      if (moved && st === 'readyToPlay') {
        stallRef.current = { lastTime: ct, stuckTicks: 0, nudged: false };
        setIsRecovering(false);
        return;
      }
      if (playing || st === 'loading') {
        stallRef.current.stuckTicks += 1;
        // Each tick is 2s -> 4 ticks = 8s stall, 8 ticks = 16s stall
        if (stallRef.current.stuckTicks === 4 && !stallRef.current.nudged) {
          stallRef.current.nudged = true;
          setIsRecovering(true);
          try {
            const target = dur > 0 ? Math.min(dur - 1, ct + 0.6) : ct + 0.6;
            player.currentTime = target;
            player.play();
          } catch {
            // ignore nudge errors
          }
        } else if (stallRef.current.stuckTicks >= 8) {
          stallRef.current.stuckTicks = 0;
          stallRef.current.nudged = false;
          setIsRecovering(true);
          onRecoverRef.current?.(ct);
        }
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [hasLoadedOnce, player]);

  // Save final position immediately on unmount
  useEffect(() => {
    return () => {
      const { currentTime: pos, duration: dur } = latestPosRef.current;
      if (episodeKey && dur > 0 && pos > 2) {
        void savePlaybackProgress(episodeKey, pos, dur, {
          title: progressTitle || title,
          thumbnail: posterThumbnail,
        });
      }
      if (seekFeedbackTimerRef.current) {
        clearTimeout(seekFeedbackTimerRef.current);
      }
    };
  }, [episodeKey, progressTitle, title, posterThumbnail]);

  // Load external VTT cues when selected
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

  useEffect(() => {
    if (controlsVisible && isPlaying && !tracksModalOpen) {
      resetHideTimer();
    } else if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
    return () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    };
  }, [controlsVisible, isPlaying, tracksModalOpen]);

  useEffect(() => {
    if (status === 'error') {
      const pos = latestPosRef.current.currentTime;
      onFallbackRef.current(error?.message, pos);
    }
  }, [status, error]);

  const activeCueText = useMemo(() => {
    if (extCues.length === 0) return '';
    const found = extCues.find((c) => currentTime >= c.start && currentTime <= c.end);
    return found?.text ?? '';
  }, [extCues, currentTime]);

  const handleTogglePlay = () => {
    if (isPlaying) {
      userPausedRef.current = true;
      player.pause();
      if (episodeKey && duration > 0 && currentTime > 2) {
        void savePlaybackProgress(episodeKey, currentTime, duration, {
          title: progressTitle || title,
          thumbnail: posterThumbnail,
        });
      }
    } else {
      userPausedRef.current = false;
      player.play();
    }
  };

  const triggerSeekFeedback = (label: string, side: 'left' | 'right') => {
    setSeekFeedback({ label, side });
    if (seekFeedbackTimerRef.current) clearTimeout(seekFeedbackTimerRef.current);
    seekFeedbackTimerRef.current = setTimeout(() => setSeekFeedback(null), 650);
  };

  const handleSeekBy = (delta: number) => {
    player.seekBy(delta);
    triggerSeekFeedback(delta > 0 ? `+${delta}s` : `${delta}s`, delta > 0 ? 'right' : 'left');
  };

  const handleSurfacePress = (evt: { nativeEvent: { locationX: number } }) => {
    if (isLocked) {
      setControlsVisible((v) => !v);
      return;
    }
    const x = evt.nativeEvent.locationX;
    const side: 'left' | 'right' | 'center' =
      x < playerWidth * 0.35 ? 'left' : x > playerWidth * 0.65 ? 'right' : 'center';
    const now = Date.now();
    if (side !== 'center' && lastTapRef.current.side === side && now - lastTapRef.current.time < 300) {
      lastTapRef.current = { time: 0, side: 'center' };
      handleSeekBy(side === 'left' ? -10 : 10);
      return;
    }
    lastTapRef.current = { time: now, side };
    setControlsVisible((v) => !v);
  };

  const handleCycleSpeed = () => {
    const nextIdx = (speedIdx + 1) % SPEED_OPTIONS.length;
    setSpeedIdx(nextIdx);
    player.playbackRate = SPEED_OPTIONS[nextIdx];
  };

  const handleToggleFit = () => {
    setContentFit((prev) => (prev === 'contain' ? 'cover' : 'contain'));
  };

  const handleToggleMute = () => {
    const nextMuted = !isMuted;
    setIsMuted(nextMuted);
    player.muted = nextMuted;
  };

  const handleStepVolume = (delta: number) => {
    const next = Math.min(1, Math.max(0, Math.round((volume + delta) * 10) / 10));
    setVolume(next);
    player.volume = next;
    if (next > 0 && isMuted) {
      setIsMuted(false);
      player.muted = false;
    } else if (next === 0 && !isMuted) {
      setIsMuted(true);
      player.muted = true;
    }
  };

  const handleToggleFullscreen = async () => {
    if (Platform.OS === 'web') {
      try {
        const doc = globalThis.document as unknown as {
          fullscreenElement?: unknown;
          exitFullscreen?: () => Promise<void>;
          documentElement?: { requestFullscreen?: () => Promise<void> };
        };
        if (doc?.fullscreenElement) {
          await doc.exitFullscreen?.();
          setIsFullscreen(false);
        } else {
          await doc?.documentElement?.requestFullscreen?.();
          setIsFullscreen(true);
        }
      } catch {
        setIsFullscreen((v) => !v);
      }
      return;
    }
    try {
      if (isFullscreen) {
        await ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP);
        setIsFullscreen(false);
      } else {
        await ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.LANDSCAPE);
        setIsFullscreen(true);
      }
    } catch {
      void videoRef.current?.enterFullscreen();
    }
  };

  useEffect(() => {
    return () => {
      if (Platform.OS !== 'web') {
        void ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(
          () => {},
        );
      }
    };
  }, []);

  const handleSeekBarPress = (evt: { nativeEvent: { locationX: number } }) => {
    if (duration <= 0 || barWidth <= 0) return;
    const ratio = Math.min(1, Math.max(0, evt.nativeEvent.locationX / barWidth));
    player.currentTime = ratio * duration;
  };

  const handleBarLayout = (e: LayoutChangeEvent) => {
    setBarWidth(e.nativeEvent.layout.width || 1);
  };

  const hasTrackOptions =
    audioTracks.length > 0 ||
    nativeSubs.length > 0 ||
    Boolean(externalSubtitles && externalSubtitles.length > 0);

  const insets = useSafeAreaInsets();
  const androidStatusBar = Platform.OS === 'android' ? (RNStatusBar.currentHeight ?? 32) : 0;
  const safeTop = isFullscreen
    ? Math.max(insets.top, 12) + 8
    : Math.max(insets.top, androidStatusBar, 32) + 12;
  const safeBottom = isFullscreen
    ? Math.max(insets.bottom, 16) + 12
    : Math.max(insets.bottom, Platform.OS === 'android' ? 54 : 24) + 16;
  const safeLeft = Math.max(insets.left, 16) + 4;
  const safeRight = Math.max(insets.right, 16) + 4;

  const audioButtonLabel =
    selectedAudio?.label && !/^(und|unknown)$/i.test(selectedAudio.label.trim())
      ? selectedAudio.label
      : 'Idioma';

  return (
    <View
      style={styles.videoWrapper}
      onLayout={(e) => setPlayerWidth(e.nativeEvent.layout.width || 360)}
    >
      <StatusBar hidden={isFullscreen} />
      <VideoView
        ref={videoRef}
        style={styles.video}
        player={player}
        nativeControls={false}
        contentFit={contentFit}
        surfaceType="textureView"
        fullscreenOptions={{ enable: true }}
        allowsPictureInPicture
      />

      {/* Tap layer above VideoView so Android/iOS always receives tap-to-toggle & double-tap seek */}
      <Pressable style={StyleSheet.absoluteFill} onPress={handleSurfacePress} />

      {/* Double-tap seek feedback badge */}
      {seekFeedback && (
        <View
          style={[
            styles.seekFeedbackPill,
            seekFeedback.side === 'left' ? styles.seekFeedbackLeft : styles.seekFeedbackRight,
          ]}
          pointerEvents="none"
        >
          <Ionicons
            name={seekFeedback.side === 'left' ? 'play-back' : 'play-forward'}
            size={18}
            color="#ffffff"
          />
          <Text style={styles.seekFeedbackText}>{seekFeedback.label}</Text>
        </View>
      )}

      {/* External VTT subtitle overlay */}
      {activeCueText ? (
        <View style={[styles.subtitleBox, { bottom: safeBottom + 64 }]} pointerEvents="none">
          <Text style={styles.subtitleText}>{activeCueText}</Text>
        </View>
      ) : null}

      {/* Fullscreen loading overlay only before first ready; small spinner on rebuffer */}
      {status === 'loading' && !hasLoadedOnce && (
        <View style={styles.loadingOverlay} pointerEvents="none">
          <ActivityIndicator size="large" color="#818cf8" />
          <Text style={styles.loadingText}>Cargando video...</Text>
        </View>
      )}
      {(status === 'loading' || isRecovering) && hasLoadedOnce && (
        <View
          style={[styles.rebufferBadge, { top: safeTop + 44, right: safeRight }]}
          pointerEvents="none"
        >
          <ActivityIndicator size="small" color="#ffffff" />
          {isRecovering && <Text style={styles.rebufferText}>Reconectando...</Text>}
        </View>
      )}

      {nextCountdown !== null && (
        <View style={[styles.nextUpBanner, { bottom: safeBottom + 76, right: safeRight }]}>
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

      {controlsVisible && isLocked && status !== 'error' && (
        <View
          style={[styles.lockedOverlay, { paddingTop: safeTop, paddingRight: safeRight }]}
          pointerEvents="box-none"
        >
          <TouchableOpacity
            style={styles.unlockBtn}
            onPress={() => {
              setIsLocked(false);
              setControlsVisible(true);
            }}
          >
            <Ionicons name="lock-closed" size={20} color="#ffffff" />
            <Text style={styles.playerPillText}>Desbloquear pantalla</Text>
          </TouchableOpacity>
        </View>
      )}

      {controlsVisible && !isLocked && status !== 'error' && (
        <View
          style={[
            styles.playerOverlay,
            {
              paddingTop: safeTop,
              paddingBottom: safeBottom,
              paddingLeft: safeLeft,
              paddingRight: safeRight,
            },
          ]}
          pointerEvents="box-none"
        >
          {/* Top bar */}
          <View style={styles.playerTopBar}>
            <TouchableOpacity onPress={onClose} style={styles.playerIconBtn}>
              <Ionicons name="arrow-back" size={22} color="#ffffff" />
            </TouchableOpacity>
            <Text style={styles.playerTitle} numberOfLines={1}>
              {title}
            </Text>
            <TouchableOpacity
              onPress={() => {
                setIsRecovering(true);
                onRecoverRef.current?.(latestPosRef.current.currentTime);
              }}
              style={styles.playerIconBtn}
            >
              <Ionicons name="refresh-outline" size={19} color="#ffffff" />
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => {
                setIsLocked(true);
                setControlsVisible(false);
              }}
              style={styles.playerIconBtn}
            >
              <Ionicons name="lock-open-outline" size={19} color="#ffffff" />
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => {
                setTracksTab('audio');
                setTracksModalOpen(true);
              }}
              style={styles.playerPillBtn}
            >
              <Ionicons name="headset-outline" size={14} color="#e0e7ff" />
              <Text style={styles.playerPillText}>{audioButtonLabel}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => {
                setTracksTab(
                  nativeSubs.length > 0 || (externalSubtitles?.length ?? 0) > 0
                    ? 'sub'
                    : 'quality',
                );
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
            <TouchableOpacity onPress={handleToggleFit} style={styles.playerIconBtn}>
              <Ionicons
                name={contentFit === 'contain' ? 'expand-outline' : 'contract-outline'}
                size={20}
                color="#ffffff"
              />
            </TouchableOpacity>
          </View>

          {/* Center playback controls */}
          <View style={styles.centerControls}>
            <TouchableOpacity
              onPress={() => handleSeekBy(-10)}
              style={styles.skipBtn}
            >
              <Ionicons name="play-back" size={26} color="#ffffff" />
              <Text style={styles.skipLabel}>10s</Text>
            </TouchableOpacity>

            <TouchableOpacity onPress={handleTogglePlay} style={styles.playPauseCircle}>
              <Ionicons
                name={isPlaying ? 'pause' : 'play'}
                size={34}
                color="#ffffff"
              />
            </TouchableOpacity>

            <TouchableOpacity
              onPress={() => handleSeekBy(10)}
              style={styles.skipBtn}
            >
              <Ionicons name="play-forward" size={26} color="#ffffff" />
              <Text style={styles.skipLabel}>10s</Text>
            </TouchableOpacity>
          </View>

          {/* Bottom bar */}
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
                <TouchableOpacity onPress={() => handleSeekBy(85)} style={styles.playerPillBtn}>
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

      {/* Audio, Quality & Subtitles Picker Overlay */}
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
                <Ionicons name="headset-outline" size={16} color={tracksTab === 'audio' ? '#ef4444' : '#94a3b8'} />
                <Text style={[styles.trackTabText, tracksTab === 'audio' && styles.trackTabTextActive]}>Idioma</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.trackTabBtn, tracksTab === 'sub' && styles.trackTabBtnActive]}
                onPress={() => setTracksTab('sub')}
              >
                <Ionicons name="chatbox-ellipses-outline" size={16} color={tracksTab === 'sub' ? '#ef4444' : '#94a3b8'} />
                <Text style={[styles.trackTabText, tracksTab === 'sub' && styles.trackTabTextActive]}>CC</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.trackTabBtn, tracksTab === 'quality' && styles.trackTabBtnActive]}
                onPress={() => setTracksTab('quality')}
              >
                <Ionicons name="stats-chart-outline" size={16} color={tracksTab === 'quality' ? '#ef4444' : '#94a3b8'} />
                <Text style={[styles.trackTabText, tracksTab === 'quality' && styles.trackTabTextActive]}>Calidad</Text>
              </TouchableOpacity>
            </View>

            <ScrollView style={{ maxHeight: 300 }}>
              {tracksTab === 'audio' && (
                audioTracks.length === 0 ? (
                  <Text style={styles.loadingText}>Pista de audio única</Text>
                ) : (
                  audioTracks.map((track, idx) => {
                    const active =
                      selectedAudio?.id === track.id &&
                      selectedAudio?.label === track.label;
                    return (
                      <TouchableOpacity
                        key={`${track.id || track.language || idx}`}
                        style={[
                          styles.serverOverlayRow,
                          active && styles.serverOverlayRowActive,
                        ]}
                        onPress={() => {
                          player.audioTrack = track;
                          setSelectedAudio(track);
                          setTracksModalOpen(false);
                        }}
                      >
                        <Ionicons
                          name={active ? 'checkmark-circle' : 'volume-medium-outline'}
                          size={18}
                          color={active ? '#ef4444' : '#e2e8f0'}
                        />
                        <Text style={styles.serverOverlayText}>
                          {track.label || track.name || track.language || `Audio ${idx + 1}`}
                        </Text>
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
                      !selectedNativeSub && !selectedExtSubUrl && styles.serverOverlayRowActive,
                    ]}
                    onPress={() => {
                      player.subtitleTrack = null;
                      setSelectedNativeSub(null);
                      setSelectedExtSubUrl(null);
                      setTracksModalOpen(false);
                    }}
                  >
                    <Ionicons
                      name={
                        !selectedNativeSub && !selectedExtSubUrl
                          ? 'checkmark-circle'
                          : 'close-circle-outline'
                      }
                      size={18}
                      color={!selectedNativeSub && !selectedExtSubUrl ? '#ef4444' : '#e2e8f0'}
                    />
                    <Text style={styles.serverOverlayText}>Desactivados</Text>
                  </TouchableOpacity>

                  {nativeSubs.map((sub, idx) => {
                    const active =
                      selectedNativeSub?.id === sub.id &&
                      selectedNativeSub?.label === sub.label;
                    return (
                      <TouchableOpacity
                        key={`ns-${sub.id || sub.language || idx}`}
                        style={[
                          styles.serverOverlayRow,
                          active && styles.serverOverlayRowActive,
                        ]}
                        onPress={() => {
                          setSelectedExtSubUrl(null);
                          player.subtitleTrack = sub;
                          setSelectedNativeSub(sub);
                          setTracksModalOpen(false);
                        }}
                      >
                        <Ionicons
                          name={active ? 'checkmark-circle' : 'text-outline'}
                          size={18}
                          color={active ? '#ef4444' : '#e2e8f0'}
                        />
                        <Text style={styles.serverOverlayText}>
                          {sub.label || sub.name || sub.language || `Subtítulo ${idx + 1}`}
                        </Text>
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
                          player.subtitleTrack = null;
                          setSelectedNativeSub(null);
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
                videoTracks.length === 0 ? (
                  <View style={[styles.serverOverlayRow, styles.serverOverlayRowActive]}>
                    <Ionicons name="checkmark-circle" size={18} color="#ef4444" />
                    <Text style={styles.serverOverlayText}>Máxima automática</Text>
                  </View>
                ) : (
                  videoTracks.map((vt, idx) => {
                    const isTop = idx === 0;
                    const label = vt.size?.height
                      ? `${vt.size.height}p${isTop ? ' (Máxima)' : ''}`
                      : `${Math.round((vt.peakBitrate ?? vt.averageBitrate ?? 0) / 1000)} kbps`;
                    return (
                      <View
                        key={vt.id || String(idx)}
                        style={[styles.serverOverlayRow, isTop && styles.serverOverlayRowActive]}
                      >
                        <Ionicons
                          name={isTop ? 'checkmark-circle' : 'videocam-outline'}
                          size={18}
                          color={isTop ? '#ef4444' : '#e2e8f0'}
                        />
                        <Text style={styles.serverOverlayText}>{label}</Text>
                      </View>
                    );
                  })
                )
              )}
            </ScrollView>
          </View>
        </TouchableOpacity>
      )}
    </View>
  );
}

export function MediaViewerModal({
  item,
  backendUrl,
  accessPin,
  referer,
  episodeTitle,
  episodeThumbnail,
  serverOptions,
  onSelectServer,
  hasPrevEpisode,
  hasNextEpisode,
  onPrevEpisode,
  onNextEpisode,
  onWatched,
  onClose,
}: MediaViewerModalProps) {
  const [downloading, setDownloading] = useState(false);
  const [forceWebView, setForceWebView] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [resolvedUrl, setResolvedUrl] = useState<string | null>(null);
  const [resolvedReferer, setResolvedReferer] = useState<string | undefined>(undefined);
  const [resolvedEmbed, setResolvedEmbed] = useState<boolean>(true);
  const [resolvedSubtitles, setResolvedSubtitles] = useState<SubtitleOption[] | undefined>(undefined);
  const [serverMenuOpen, setServerMenuOpen] = useState(false);
  const [nativeError, setNativeError] = useState<string | null>(null);
  const [recoveryNonce, setRecoveryNonce] = useState(0);
  const [resumeAtSec, setResumeAtSec] = useState<number | undefined>(undefined);
  const triedServerIdsRef = useRef<Set<string>>(new Set());
  const autoRecoveryCountRef = useRef(0);

  useEffect(() => {
    triedServerIdsRef.current.clear();
    autoRecoveryCountRef.current = 0;
    setRecoveryNonce(0);
    setResumeAtSec(undefined);
  }, [referer]);

  useEffect(() => {
    autoRecoveryCountRef.current = 0;
    setRecoveryNonce(0);
    setResumeAtSec(undefined);
  }, [item]);

  const handleRecoverStream = (atSec: number) => {
    if (!item || item.type !== 'video') return;
    if (atSec > 3) {
      setResumeAtSec(atSec);
    }
    setNativeError(null);
    setRecoveryNonce((n) => n + 1);
  };

  const tryNextServer = (fallbackError: string) => {
    if (serverOptions && serverOptions.length > 1 && onSelectServer && item) {
      triedServerIdsRef.current.add(item.id);
      const nextSrv = serverOptions.find((s) => !triedServerIdsRef.current.has(s.id));
      if (nextSrv) {
        onSelectServer(nextSrv);
        return;
      }
    }
    setNativeError(fallbackError);
  };

  useEffect(() => {
    setForceWebView(false);
    setServerMenuOpen(false);
    setNativeError(null);
    setResolvedSubtitles(undefined);
    if (!item || item.type !== 'video') {
      setResolvedUrl(null);
      return;
    }

    let cancelled = false;
    setResolving(true);
    setResolvedUrl(null);
    void resolveVideoUrl(backendUrl, item.url, accessPin, recoveryNonce > 0)
      .then((res) => {
        if (cancelled) return;
        if (res.unavailableReason) {
          tryNextServer(res.unavailableReason);
          return;
        }
        if (
          res.isEmbed &&
          serverOptions &&
          serverOptions.length > 1 &&
          !triedServerIdsRef.current.has(item.id)
        ) {
          const nextUntried = serverOptions.find(
            (s) => s.id !== item.id && !triedServerIdsRef.current.has(s.id),
          );
          if (nextUntried) {
            triedServerIdsRef.current.add(item.id);
            onSelectServer?.(nextUntried);
            return;
          }
        }
        setResolvedUrl(res.streamUrl);
        setResolvedReferer(res.referer ?? referer);
        setResolvedEmbed(res.isEmbed);
        setResolvedSubtitles(res.subtitles);
      })
      .catch(() => {
        if (cancelled) return;
        setResolvedUrl(item.url);
        setResolvedReferer(referer);
        setResolvedEmbed(Boolean(item.isEmbed));
      })
      .finally(() => {
        if (!cancelled) setResolving(false);
      });

    return () => {
      cancelled = true;
    };
  }, [item, backendUrl, accessPin, referer, recoveryNonce]);

  if (!item) return null;

  const activeUrl = resolvedUrl || item.url;
  const activeReferer = resolvedReferer ?? referer;
  const proxiedUrl = buildProxyUrl(backendUrl, activeUrl, activeReferer, accessPin);

  const handleDownloadAndShare = async () => {
    if (Platform.OS === 'web') {
      void Linking.openURL(proxiedUrl);
      return;
    }
    try {
      setDownloading(true);
      const ext =
        item.type === 'pdf'
          ? 'pdf'
          : item.type === 'video'
            ? 'mp4'
            : 'jpg';
      const destFile = new File(Paths.cache, `youanime_${item.id}.${ext}`);
      const downloaded = await File.downloadFileAsync(proxiedUrl, destFile, {
        idempotent: true,
      });

      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(downloaded.uri);
      } else {
        Alert.alert('Descargado', `Archivo guardado en: ${downloaded.uri}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'No se pudo descargar el archivo';
      Alert.alert('Error', msg);
    } finally {
      setDownloading(false);
    }
  };

  const handleOpenExternal = () => {
    void Linking.openURL(item.url);
  };

  const isHls =
    item.mimeType?.toLowerCase().includes('mpegurl') ||
    /\/m3u8\//i.test(activeUrl) ||
    /\.m3u8(\?|#|$)/i.test(activeUrl);

  const isUsingNativePlayer =
    item.type === 'video' && !resolving && !resolvedEmbed && !forceWebView;

  const renderContent = () => {
    if (item.type === 'video') {
      if (resolving || !resolvedUrl) {
        return (
          <View style={styles.loadingOverlay}>
            <ActivityIndicator size="large" color="#818cf8" />
            <Text style={styles.loadingText}>Preparando reproductor...</Text>
          </View>
        );
      }

      if (nativeError && !forceWebView) {
        return (
          <View style={styles.loadingOverlay}>
            <Ionicons name="alert-circle-outline" size={38} color="#f87171" />
            <Text style={styles.loadingText}>{nativeError}</Text>
            <View style={{ flexDirection: 'row', gap: 10, marginTop: 8 }}>
              {serverOptions && serverOptions.length > 1 && (
                <TouchableOpacity
                  style={styles.playerPillBtn}
                  onPress={() => setServerMenuOpen(true)}
                >
                  <Text style={styles.playerPillText}>Cambiar servidor</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity
                style={[styles.playerPillBtn, { backgroundColor: '#4f46e5' }]}
                onPress={() => {
                  setNativeError(null);
                  setForceWebView(true);
                }}
              >
                <Text style={styles.playerPillText}>Abrir en WebView</Text>
              </TouchableOpacity>
            </View>
          </View>
        );
      }

      if (resolvedEmbed || forceWebView) {
        if (Platform.OS === 'web') {
          const webIframeProps =
            isHls && (!resolvedEmbed || forceWebView)
              ? {
                  srcDoc: buildHlsPlayerHtml(
                    proxiedUrl,
                    resolvedSubtitles,
                    backendUrl,
                    activeReferer,
                    accessPin,
                  ),
                }
              : { src: activeUrl };
          return (
            <View style={styles.webview}>
              <iframe
                {...webIframeProps}
                style={{ width: '100%', height: '100%', border: 'none', backgroundColor: '#000' }}
                allowFullScreen
                allow="autoplay; fullscreen"
              />
            </View>
          );
        }

        const source =
          forceWebView && isHls
            ? {
                html: buildHlsPlayerHtml(
                  proxiedUrl,
                  resolvedSubtitles,
                  backendUrl,
                  activeReferer,
                  accessPin,
                ),
                baseUrl: backendUrl,
              }
            : {
                uri: activeUrl,
                headers: activeReferer ? { Referer: activeReferer } : undefined,
              };

        return (
          <WebView
            source={source}
            style={styles.webview}
            userAgent={CHROME_UA}
            originWhitelist={['*']}
            allowsFullscreenVideo
            allowsInlineMediaPlayback
            mediaPlaybackRequiresUserAction={false}
            mixedContentMode="always"
            javaScriptEnabled
            domStorageEnabled
            setSupportMultipleWindows={false}
            injectedJavaScript={`
              (function() {
                window.open = function() { return null; };
                function cleanAds() {
                  var selectors = ['#overlayads', 'anounce', '.ima-ad-container', '[id*="ad-"]', '[class*="popup"]', 'a[target="_top"]', 'a[href*="la.movie"]'];
                  selectors.forEach(function(sel) {
                    document.querySelectorAll(sel).forEach(function(el) { el.remove(); });
                  });
                }
                cleanAds();
                setInterval(cleanAds, 1000);
              })();
              true;
            `}
            onShouldStartLoadWithRequest={(req) => {
              var u = (req.url || '').toLowerCase();
              if (
                u.includes('doubleclick.net') ||
                u.includes('googlesyndication') ||
                u.includes('imasdk.googleapis') ||
                u.includes('popads') ||
                u.includes('adsterra') ||
                u.includes('exoclick') ||
                u.includes('cortahewt') ||
                u.includes('dirdumaigre') ||
                u.includes('sxlzbz') ||
                u.includes('la.movie')
              ) {
                return false;
              }
              return true;
            }}
          />
        );
      }

      if (Platform.OS === 'web') {
        return (
          <WebCustomVideoPlayer
            uri={proxiedUrl}
            isHls={isHls}
            backendUrl={backendUrl}
            accessPin={accessPin}
            referer={activeReferer}
            episodeKey={referer}
            title={episodeTitle || item.title || 'Reproductor'}
            posterThumbnail={episodeThumbnail || item.thumbnail}
            externalSubtitles={resolvedSubtitles}
            hasServers={Boolean(serverOptions && serverOptions.length > 1)}
            onOpenServers={() => setServerMenuOpen(true)}
            hasPrev={hasPrevEpisode}
            hasNext={hasNextEpisode}
            onPrev={onPrevEpisode}
            onNext={onNextEpisode}
            onWatched={onWatched}
            onClose={onClose}
          />
        );
      }

      return (
        <CustomNativePlayer
          key={`${item.id}-${recoveryNonce}`}
          uri={proxiedUrl}
          isHls={isHls}
          backendUrl={backendUrl}
          accessPin={accessPin}
          referer={activeReferer}
          episodeKey={referer}
          initialPositionSec={resumeAtSec}
          title={item.title || 'Reproductor'}
          progressTitle={episodeTitle || item.title}
          posterThumbnail={episodeThumbnail || item.thumbnail}
          externalSubtitles={resolvedSubtitles}
          hasServers={Boolean(serverOptions && serverOptions.length > 1)}
          onOpenServers={() => setServerMenuOpen(true)}
          hasPrev={hasPrevEpisode}
          hasNext={hasNextEpisode}
          onPrev={onPrevEpisode}
          onNext={onNextEpisode}
          onWatched={onWatched}
          onRecoverStream={(atSec) => {
            if (autoRecoveryCountRef.current < 4) {
              autoRecoveryCountRef.current += 1;
              handleRecoverStream(atSec);
            }
          }}
          onFallback={(msg, atSec) => {
            if (atSec && atSec > 15 && autoRecoveryCountRef.current < 2) {
              autoRecoveryCountRef.current += 1;
              handleRecoverStream(atSec);
              return;
            }
            tryNextServer(msg || 'No se pudo reproducir este servidor');
          }}
          onClose={onClose}
        />
      );
    }

    if (item.type === 'image') {
      return (
        <View style={styles.imageWrapper}>
          <Image
            source={{ uri: proxiedUrl }}
            style={styles.image}
            resizeMode="contain"
          />
        </View>
      );
    }

    if (Platform.OS === 'web') {
      return (
        <View style={styles.webview}>
          <iframe
            src={proxiedUrl}
            style={{ width: '100%', height: '100%', border: 'none', backgroundColor: '#fff' }}
            title={item.title || 'PDF'}
          />
        </View>
      );
    }

    const pdfSourceUri =
      Platform.OS === 'android'
        ? `https://docs.google.com/gview?embedded=true&url=${encodeURIComponent(item.url)}`
        : proxiedUrl;

    return (
      <WebView
        source={{ uri: pdfSourceUri }}
        style={styles.webview}
      />
    );
  };

  return (
    <Modal visible={Boolean(item)} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView
        style={styles.container}
        edges={isUsingNativePlayer ? [] : undefined}
      >
        {!isUsingNativePlayer && (
          <View style={styles.header}>
            <TouchableOpacity onPress={onClose} style={styles.iconBtn}>
              <Ionicons name="close" size={24} color="#f8fafc" />
            </TouchableOpacity>
            <Text style={styles.headerTitle} numberOfLines={1}>
              {item.title || item.type.toUpperCase()}
            </Text>
            <View style={styles.headerActions}>
              {item.type === 'video' && serverOptions && serverOptions.length > 1 && (
                <TouchableOpacity
                  onPress={() => setServerMenuOpen(true)}
                  style={styles.iconBtn}
                >
                  <Ionicons name="server-outline" size={20} color="#f8fafc" />
                </TouchableOpacity>
              )}
              {item.type === 'video' && (
                <TouchableOpacity
                  onPress={() => setForceWebView((v) => !v)}
                  style={styles.iconBtn}
                >
                  <Ionicons
                    name={forceWebView ? 'tv-outline' : 'globe-outline'}
                    size={21}
                    color="#f8fafc"
                  />
                </TouchableOpacity>
              )}
              <TouchableOpacity
                onPress={handleDownloadAndShare}
                style={styles.iconBtn}
                disabled={downloading}
              >
                {downloading ? (
                  <ActivityIndicator size="small" color="#f8fafc" />
                ) : (
                  <Ionicons name="download-outline" size={22} color="#f8fafc" />
                )}
              </TouchableOpacity>
              <TouchableOpacity onPress={handleOpenExternal} style={styles.iconBtn}>
                <Ionicons name="open-outline" size={22} color="#f8fafc" />
              </TouchableOpacity>
            </View>
          </View>
        )}

        <View style={styles.body}>{renderContent()}</View>

        {/* Quick Server Switcher inside Player */}
        {serverMenuOpen && serverOptions && (
          <TouchableOpacity
            style={styles.serverOverlayBackdrop}
            activeOpacity={1}
            onPress={() => setServerMenuOpen(false)}
          >
            <View style={styles.serverOverlayCard}>
              <Text style={styles.serverOverlayTitle}>Cambiar servidor</Text>
              {serverOptions.map((srv) => {
                const selected = srv.id === item.id;
                return (
                  <TouchableOpacity
                    key={srv.id}
                    style={[
                      styles.serverOverlayRow,
                      selected && styles.serverOverlayRowActive,
                    ]}
                    onPress={() => {
                      setServerMenuOpen(false);
                      onSelectServer?.(srv);
                    }}
                  >
                    <Ionicons
                      name={selected ? 'checkmark-circle' : 'play-outline'}
                      size={18}
                      color={selected ? '#818cf8' : '#e2e8f0'}
                    />
                    <Text style={styles.serverOverlayText} numberOfLines={1}>
                      {srv.title || srv.url}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </TouchableOpacity>
        )}
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000000',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#27272a',
    backgroundColor: '#18181b',
  },
  headerTitle: {
    flex: 1,
    color: '#f8fafc',
    fontSize: 15,
    fontWeight: '600',
    marginHorizontal: 10,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  iconBtn: {
    padding: 6,
    borderRadius: 8,
  },
  body: {
    flex: 1,
    justifyContent: 'center',
  },
  videoWrapper: {
    flex: 1,
    backgroundColor: '#000000',
    position: 'relative',
  },
  video: {
    flex: 1,
    width: '100%',
    height: '100%',
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
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 20,
    backgroundColor: 'rgba(15, 23, 42, 0.78)',
  },
  rebufferText: {
    color: '#e0e7ff',
    fontSize: 12,
    fontWeight: '600',
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
  playerOverlay: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(0,0,0,0.42)',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 18,
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
    gap: 14,
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
  seekFeedbackPill: {
    position: 'absolute',
    top: '45%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(15, 23, 42, 0.85)',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: 'rgba(129, 140, 248, 0.5)',
    zIndex: 20,
  },
  seekFeedbackLeft: {
    left: '14%',
  },
  seekFeedbackRight: {
    right: '14%',
  },
  seekFeedbackText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '700',
  },
  lockedOverlay: {
    ...StyleSheet.absoluteFill,
    justifyContent: 'flex-start',
    alignItems: 'flex-end',
    padding: 20,
  },
  unlockBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(15, 23, 42, 0.85)',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'rgba(129, 140, 248, 0.5)',
  },
  bottomActionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  epNavRow: {
    flex: 1,
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
  imageWrapper: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 8,
  },
  image: {
    width: '100%',
    height: '100%',
  },
  webview: {
    flex: 1,
    backgroundColor: '#09090b',
    opacity: 0.99,
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
  serverOverlayTitle: {
    color: '#f8fafc',
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 6,
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
  serverOverlayText: {
    flex: 1,
    color: '#f1f5f9',
    fontSize: 14,
  },
});
