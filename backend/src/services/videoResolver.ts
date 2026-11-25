import { validateTargetUrl } from '../utils/url.js';

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export interface SubtitleOption {
  url: string;
  label: string;
}

export interface ResolvedVideo {
  streamUrl: string;
  referer?: string;
  mimeType?: string;
  isEmbed: boolean;
  subtitles?: SubtitleOption[];
  unavailableReason?: string;
}

/**
 * Unpacks Dean Edwards p,a,c,k,e,d JavaScript blocks without eval().
 */
export function unpackPacker(html: string): string | null {
  const all = unpackAllPackers(html);
  return all.length > 0 ? all.join('\n') : null;
}

export function unpackAllPackers(html: string): string[] {
  const results: string[] = [];
  const rx =
    /eval\(function\(p,a,c,k,e,[dr]\)\{[\s\S]*?\}\('([\s\S]*?)',(\d+),(\d+),'([^']*)'\.split\('\|'\)/g;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(html)) !== null) {
    const [, p, aStr, cStr, kStr] = m;
    const a = parseInt(aStr, 10);
    let c = parseInt(cStr, 10);
    const k = kStr.split('|');

    const toBase = (num: number, radix: number): string => {
      const first = num < radix ? '' : toBase(Math.floor(num / radix), radix);
      const rem = num % radix;
      return first + (rem > 35 ? String.fromCharCode(rem + 29) : rem.toString(36));
    };

    const dict: Record<string, string> = {};
    while (c--) {
      const key = toBase(c, a);
      dict[key] = k[c] || key;
    }

    results.push(p.replace(/\b\w+\b/g, (w) => dict[w] ?? w));
  }
  return results;
}

const RESOLVE_CACHE_TTL_MS = 2 * 60 * 1000;
const RESOLVE_CACHE_MAX = 150;
const resolveCache = new Map<string, { data: ResolvedVideo; expiresAt: number }>();
const inFlightResolves = new Map<string, Promise<ResolvedVideo>>();

export function extractDirectStreamFromText(text: string): { url: string; mimeType: string } | null {
  // Unescape JSON-escaped forward slashes (https:\/\/cdn...\/master.m3u8)
  const normalized = text.replace(/\\\//g, '/');

  // Mixdrop MDCore.wurl = "//..."
  const mdCore = normalized.match(/MDCore\.wurl\s*=\s*["']((?:https?:)?\/\/[^"']+)["']/i);
  if (mdCore?.[1]) {
    const url = mdCore[1].startsWith('//') ? `https:${mdCore[1]}` : mdCore[1];
    return { url, mimeType: 'video/mp4' };
  }

  // Prefer explicit HLS sources (file/src/hls2/hls4/etc.)
  const hlsKey = normalized.match(
    /(?:file|src|source|hls\d?)\s*[:=]\s*["'](https?:\/\/[^"'\\s<>]+\.m3u8[^"'\\s<>]*)["']/i,
  );
  if (hlsKey?.[1]) {
    return { url: hlsKey[1], mimeType: 'application/x-mpegURL' };
  }

  const m3u8 = normalized.match(/https?:\/\/[^\s"'<>\\]+\.m3u8[^\s"'<>\\]*/i);
  if (m3u8?.[0]) {
    return { url: m3u8[0], mimeType: 'application/x-mpegURL' };
  }

  // YourUpload / generic og:video mp4
  const ogVideo = normalized.match(
    /<meta[^>]+property=["']og:video(?::secure_url)?["'][^>]+content=["'](https?:\/\/[^"']+\.mp4[^"']*)["']/i,
  );
  if (ogVideo?.[1]) {
    return { url: ogVideo[1], mimeType: 'video/mp4' };
  }

  const mp4 = normalized.match(/https?:\/\/[^\s"'<>\\]+\.mp4[^\s"'<>\\]*/i);
  if (mp4?.[0] && !mp4[0].includes('Big_Buck_Bunny') && !mp4[0].includes('test-videos')) {
    return { url: mp4[0], mimeType: 'video/mp4' };
  }
  return null;
}

function extractSubtitlesFromText(text: string): SubtitleOption[] {
  const normalized = text.replace(/\\\//g, '/');
  const subs: SubtitleOption[] = [];
  const seen = new Set<string>();
  const trackRegex = /\{[^}]*file\s*:\s*["'](https?:\/\/[^"']+\.(?:vtt|srt)[^"']*)["'][^}]*\}/gi;
  let match: RegExpExecArray | null;
  while ((match = trackRegex.exec(normalized)) !== null) {
    const block = match[0];
    const url = match[1];
    if (!url || seen.has(url) || /thumbnails/i.test(block)) continue;
    seen.add(url);
    const labelMatch = block.match(/label\s*:\s*["']([^"']+)["']/i);
    subs.push({
      url,
      label: labelMatch?.[1] || `Subtítulo ${subs.length + 1}`,
    });
  }
  return subs;
}

/**
 * Decodes VOE's obfuscated <script type="application/json">["..."]</script> payload.
 */
export function decodeVoePayload(
  html: string,
): { streamUrl: string; mimeType: string; subtitles?: SubtitleOption[] } | null {
  const m = html.match(
    /<script[^>]*type=["']application\/json["'][^>]*>\s*\["([^"]+)"\]\s*<\/script>/i,
  );
  if (!m?.[1]) return null;
  try {
    let s = m[1];
    // 1. ROT13
    s = s.replace(/[a-zA-Z]/g, (c) =>
      String.fromCharCode(
        (c <= 'Z' ? 90 : 122) >= c.charCodeAt(0) + 13
          ? c.charCodeAt(0) + 13
          : c.charCodeAt(0) - 13,
      ),
    );
    // 2. Strip junk markers
    s = s.replace(/(@\$|\^\^|~@|#&|!!|%\?|\*~)/g, '');
    // 3. Base64 decode
    s = Buffer.from(s, 'base64').toString('latin1');
    // 4. Shift -3
    s = Array.from(s, (ch) => String.fromCharCode(ch.charCodeAt(0) - 3)).join('');
    // 5. Reverse + Base64 decode
    s = Buffer.from(s.split('').reverse().join(''), 'base64').toString('utf8');

    const obj = JSON.parse(s) as {
      source?: string;
      direct_access_url?: string;
      captions?: Array<{ file?: string; label?: string }>;
    };
    const streamUrl = obj.source || obj.direct_access_url;
    if (!streamUrl) return null;

    const mimeType = streamUrl.includes('.m3u8') ? 'application/x-mpegURL' : 'video/mp4';
    const subtitles = (obj.captions ?? [])
      .filter((c): c is { file: string; label?: string } => Boolean(c.file))
      .map((c, idx) => ({
        url: c.file,
        label: c.label || `Subtítulo ${idx + 1}`,
      }));

    return {
      streamUrl,
      mimeType,
      subtitles: subtitles.length > 0 ? subtitles : undefined,
    };
  } catch {
    return null;
  }
}

export async function resolveVideoStream(rawUrl: string, depth = 0): Promise<ResolvedVideo> {
  const target = validateTargetUrl(rawUrl);
  const urlStr = target.toString();

  if (depth === 0) {
    const cached = resolveCache.get(urlStr);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.data;
    }
    const existing = inFlightResolves.get(urlStr);
    if (existing) {
      return existing;
    }
  }

  const promise = resolveVideoStreamUncached(target, depth).then((res) => {
    if (depth === 0 && !res.isEmbed && !res.unavailableReason) {
      if (resolveCache.size >= RESOLVE_CACHE_MAX) {
        const now = Date.now();
        for (const [k, v] of resolveCache.entries()) {
          if (v.expiresAt <= now) resolveCache.delete(k);
        }
        if (resolveCache.size >= RESOLVE_CACHE_MAX) {
          const firstKey = resolveCache.keys().next().value;
          if (firstKey) resolveCache.delete(firstKey);
        }
      }
      resolveCache.set(urlStr, {
        data: res,
        expiresAt: Date.now() + RESOLVE_CACHE_TTL_MS,
      });
    }
    return res;
  });

  if (depth === 0) {
    inFlightResolves.set(urlStr, promise);
  }
  try {
    return await promise;
  } finally {
    if (depth === 0) {
      inFlightResolves.delete(urlStr);
    }
  }
}

async function resolveVideoStreamUncached(target: URL, depth = 0): Promise<ResolvedVideo> {
  const urlStr = target.toString();
  const host = target.hostname.toLowerCase();

  // Direct HLS stream (e.g. player.zilla-networks.com/m3u8/...)
  if (/\/m3u8\//i.test(target.pathname) || /\.m3u8(\?|#|$)/i.test(urlStr)) {
    return {
      streamUrl: urlStr,
      referer: `${target.origin}/`,
      mimeType: 'application/x-mpegURL',
      isEmbed: false,
    };
  }

  // Direct MP4 / WebM
  if (/\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(urlStr)) {
    return {
      streamUrl: urlStr,
      referer: `${target.origin}/`,
      mimeType: 'video/mp4',
      isEmbed: false,
    };
  }

  // jkanime.net/jkplayer/*: extraer stream HLS directo o seguir iframe anidado
  if (host.includes('jkanime.net') && target.pathname.includes('/jkplayer/') && depth < 2) {
    const res = await fetch(urlStr, {
      headers: {
        'User-Agent': DEFAULT_UA,
        Referer: 'https://jkanime.net/',
      },
      signal: AbortSignal.timeout(12000),
    });

    if (res.ok) {
      const html = await res.text();
      const foundDirect = extractDirectStreamFromText(html);
      if (foundDirect) {
        return {
          streamUrl: foundDirect.url,
          referer: 'https://jkanime.net/',
          mimeType: foundDirect.mimeType,
          isEmbed: false,
        };
      }
      const nestedIframe = html.match(/<iframe[^>]+src=["'](https?:\/\/[^"']+)["']/i);
      if (nestedIframe?.[1] && nestedIframe[1] !== urlStr) {
        return resolveVideoStream(nestedIframe[1], depth + 1);
      }
    }
  }

  // hackstore.fo/play.php: extraer la URL real dentro de function don()
  if (host.includes('hackstore.') && target.pathname.includes('play.php') && depth < 2) {
    const res = await fetch(urlStr, {
      headers: {
        'User-Agent': DEFAULT_UA,
        Referer: `${target.origin}/`,
      },
      signal: AbortSignal.timeout(12000),
    });

    if (res.ok) {
      const html = await res.text();
      const match = html.match(
        /window\.location(?:\.href\s*=|\.replace\()\s*['"](https?:\/\/[^'"]+)['"]/i,
      );
      if (match?.[1]) {
        return resolveVideoStream(match[1], depth + 1);
      }
    }
  }

  // mp4upload.com: extraer el enlace directo .mp4 del script de videojs
  if (host.includes('mp4upload.com')) {
    const res = await fetch(urlStr, {
      headers: {
        'User-Agent': DEFAULT_UA,
        Referer: 'https://animeflv.or.at/',
      },
      signal: AbortSignal.timeout(12000),
    });

    if (res.ok) {
      const html = await res.text();
      const match = html.match(/src\s*:\s*["'](https?:\/\/[^"']+\.mp4[^"']*)["']/i);
      if (match?.[1]) {
        return {
          streamUrl: match[1],
          referer: 'https://www.mp4upload.com/',
          mimeType: 'video/mp4',
          isEmbed: false,
        };
      }
    }
  }

  // Generic embed resolver: vimeos, streamwish, filemoon, vidhide, mixdrop, voe redirect
  if (!host.includes('youtube.com') && !host.includes('youtu.be')) {
    try {
      const res = await fetch(urlStr, {
        headers: {
          'User-Agent': DEFAULT_UA,
          Referer: `${target.origin}/`,
        },
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) {
        const html = await res.text();
        if (/file was deleted|video not found|file is no longer available/i.test(html)) {
          return {
            streamUrl: urlStr,
            isEmbed: true,
            unavailableReason:
              'Este servidor no tiene el video disponible. Prueba otro servidor.',
          };
        }

        // Follow single JS redirect (e.g. voe.sx -> mirror domain)
        if (depth < 2 && html.length < 5000) {
          const jsRedirect = html.match(
            /window\.location(?:\.href\s*=|\.replace\()\s*['"](https?:\/\/[^'"]+)['"]/i,
          );
          if (jsRedirect?.[1] && jsRedirect[1] !== urlStr) {
            return resolveVideoStream(jsRedirect[1], depth + 1);
          }
        }

        const voe = decodeVoePayload(html);
        if (voe) {
          return {
            streamUrl: voe.streamUrl,
            referer: `${target.origin}/`,
            mimeType: voe.mimeType,
            isEmbed: false,
            subtitles: voe.subtitles,
          };
        }

        const unpacked = unpackPacker(html);
        const found =
          (unpacked ? extractDirectStreamFromText(unpacked) : null) ??
          extractDirectStreamFromText(html);

        if (found) {
          const subtitles = [
            ...(unpacked ? extractSubtitlesFromText(unpacked) : []),
            ...extractSubtitlesFromText(html),
          ].filter((s, idx, arr) => arr.findIndex((x) => x.url === s.url) === idx);
          return {
            streamUrl: found.url,
            referer: `${target.origin}/`,
            mimeType: found.mimeType,
            isEmbed: false,
            subtitles: subtitles.length > 0 ? subtitles : undefined,
          };
        }
      }
    } catch {
      // Fall back to embed WebView
    }
  }

  return {
    streamUrl: urlStr,
    isEmbed: true,
  };
}
