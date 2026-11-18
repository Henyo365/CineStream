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
  const m = html.match(
    /eval\(function\(p,a,c,k,e,[dr]\)\{[\s\S]*?\}\('([\s\S]*?)',(\d+),(\d+),'([^']*)'\.split\('\|'\)/,
  );
  if (!m) return null;
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

  return p.replace(/\b\w+\b/g, (w) => dict[w] ?? w);
}

function extractDirectStreamFromText(text: string): { url: string; mimeType: string } | null {
  const m3u8 = text.match(/https?:\/\/[^\s"'<>\\]+\.m3u8[^\s"'<>\\]*/i);
  if (m3u8?.[0]) {
    return { url: m3u8[0], mimeType: 'application/x-mpegURL' };
  }
  const mp4 = text.match(/https?:\/\/[^\s"'<>\\]+\.mp4[^\s"'<>\\]*/i);
  if (mp4?.[0] && !mp4[0].includes('Big_Buck_Bunny') && !mp4[0].includes('test-videos')) {
    return { url: mp4[0], mimeType: 'video/mp4' };
  }
  return null;
}

function extractSubtitlesFromText(text: string): SubtitleOption[] {
  const subs: SubtitleOption[] = [];
  const seen = new Set<string>();
  const trackRegex = /\{[^}]*file\s*:\s*["'](https?:\/\/[^"']+\.(?:vtt|srt)[^"']*)["'][^}]*\}/gi;
  let match: RegExpExecArray | null;
  while ((match = trackRegex.exec(text)) !== null) {
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

export async function resolveVideoStream(rawUrl: string): Promise<ResolvedVideo> {
  const target = validateTargetUrl(rawUrl);
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

  // hackstore.fo/play.php: extraer la URL real dentro de function don()
  if (host.includes('hackstore.') && target.pathname.includes('play.php')) {
    const res = await fetch(urlStr, {
      headers: {
        'User-Agent': DEFAULT_UA,
        Referer: `${target.origin}/`,
      },
      signal: AbortSignal.timeout(12000),
    });

    if (res.ok) {
      const html = await res.text();
      const match = html.match(/window\.location\.href\s*=\s*['"](https?:\/\/[^'"]+)['"]/i);
      if (match?.[1]) {
        return resolveVideoStream(match[1]);
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

  // Generic embed resolver: try extracting direct .m3u8 / .mp4 from HTML or packed JS (e.g. vimeos.net)
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
        if (/file was deleted|video not found/i.test(html)) {
          return {
            streamUrl: urlStr,
            isEmbed: true,
            unavailableReason:
              'Este servidor no tiene el video disponible. Prueba otro servidor.',
          };
        }
        const unpacked = unpackPacker(html);
        const found =
          (unpacked ? extractDirectStreamFromText(unpacked) : null) ??
          extractDirectStreamFromText(html);

        if (found) {
          const subtitles = unpacked ? extractSubtitlesFromText(unpacked) : [];
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
