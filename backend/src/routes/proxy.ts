import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { Router, type Request, type Response } from 'express';
import { validateTargetUrl } from '../utils/url.js';

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export const proxyRouter = Router();

function buildProxyLink(baseOrigin: string, targetUrl: string, referer?: string): string {
  const params = new URLSearchParams({ url: targetUrl });
  if (referer) params.set('referer', referer);
  return `${baseOrigin}/api/proxy?${params.toString()}`;
}

function rewriteHlsPlaylist(
  playlist: string,
  playlistUrl: URL,
  proxyBaseOrigin: string,
  referer?: string,
): string {
  const lines = playlist.split(/\r?\n/);

  // Sort #EXT-X-STREAM-INF variants by highest bandwidth/resolution first
  // so players auto-select the highest quality by default.
  const headerLines: string[] = [];
  const variants: { bandwidth: number; lines: string[] }[] = [];
  const trailingLines: string[] = [];

  let i = 0;
  while (i < lines.length) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('#EXT-X-STREAM-INF:')) {
      const bwMatch = trimmed.match(/BANDWIDTH=(\d+)/i);
      const bandwidth = bwMatch ? parseInt(bwMatch[1], 10) : 0;
      const group = [lines[i]];
      if (i + 1 < lines.length && lines[i + 1].trim() && !lines[i + 1].trim().startsWith('#')) {
        group.push(lines[i + 1]);
        i += 2;
      } else {
        i += 1;
      }
      variants.push({ bandwidth, lines: group });
    } else if (variants.length === 0) {
      headerLines.push(lines[i]);
      i += 1;
    } else {
      trailingLines.push(lines[i]);
      i += 1;
    }
  }

  const orderedLines =
    variants.length > 1
      ? [
          ...headerLines,
          ...variants.sort((a, b) => b.bandwidth - a.bandwidth).flatMap((v) => v.lines),
          ...trailingLines,
        ]
      : lines;

  return orderedLines
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;

      // Rewrite URI="..." inside tags like #EXT-X-MAP or #EXT-X-KEY or #EXT-X-MEDIA
      if (trimmed.startsWith('#')) {
        return line.replace(/URI="([^"]+)"/gi, (_, rawUri: string) => {
          try {
            const abs = new URL(rawUri, playlistUrl).toString();
            return `URI="${buildProxyLink(proxyBaseOrigin, abs, referer)}"`;
          } catch {
            return `URI="${rawUri}"`;
          }
        });
      }

      // Rewrite segment or sub-playlist URL line
      try {
        const abs = new URL(trimmed, playlistUrl).toString();
        return buildProxyLink(proxyBaseOrigin, abs, referer);
      } catch {
        return line;
      }
    })
    .join('\n');
}

proxyRouter.get('/', async (req: Request, res: Response) => {
  const rawUrl = req.query.url;
  const rawReferer = req.query.referer;

  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    res.status(400).json({ error: 'Falta el parámetro "url"' });
    return;
  }

  try {
    const targetUrl = validateTargetUrl(rawUrl);
    const headers: Record<string, string> = {
      'User-Agent': DEFAULT_USER_AGENT,
      Accept: '*/*',
    };

    let validReferer: string | undefined;
    if (targetUrl.hostname.toLowerCase().includes('zilla-networks.com')) {
      validReferer = `${targetUrl.origin}/`;
      headers.Referer = validReferer;
      headers.Origin = targetUrl.origin;
      headers['Sec-Fetch-Dest'] = 'empty';
      headers['Sec-Fetch-Mode'] = 'cors';
      headers['Sec-Fetch-Site'] = 'same-origin';
    } else if (typeof rawReferer === 'string' && rawReferer.trim()) {
      try {
        const refUrl = validateTargetUrl(rawReferer);
        validReferer = refUrl.toString();
        headers.Referer = validReferer;
        headers.Origin = refUrl.origin;
        headers['Sec-Fetch-Dest'] = 'empty';
        headers['Sec-Fetch-Mode'] = 'cors';
        headers['Sec-Fetch-Site'] =
          refUrl.origin === targetUrl.origin ? 'same-origin' : 'cross-site';
      } catch {
        // Ignore invalid referer
      }
    }

    if (typeof req.headers.range === 'string') {
      headers.Range = req.headers.range;
    }

    const connectController = new AbortController();
    const connectTimer = setTimeout(() => connectController.abort(), 20000);
    let upstream: globalThis.Response;
    try {
      upstream = await fetch(targetUrl.toString(), {
        headers,
        redirect: 'follow',
        signal: connectController.signal,
      });
    } finally {
      clearTimeout(connectTimer);
    }

    if (!upstream.ok && upstream.status !== 206) {
      res.status(upstream.status).json({
        error: `Error del servidor origen: HTTP ${upstream.status}`,
      });
      return;
    }

    const upstreamCt = upstream.headers.get('content-type')?.toLowerCase() ?? '';
    const isHlsPlaylist =
      upstreamCt.includes('mpegurl') ||
      targetUrl.pathname.toLowerCase().endsWith('.m3u8') ||
      targetUrl.pathname.toLowerCase().includes('/m3u8/');

    // Rewrite HLS playlists so segments also route through /api/proxy with Referer/Origin
    if (isHlsPlaylist && upstream.ok) {
      const text = await upstream.text();
      if (text.trimStart().startsWith('#EXTM3U')) {
        const host = req.get('host');
        const proxyOrigin = host ? `${req.protocol}://${host}` : '';
        const rewritten = rewriteHlsPlaylist(
          text,
          targetUrl,
          proxyOrigin,
          validReferer || `${targetUrl.origin}/`,
        );
        res.status(200);
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.send(rewritten);
        return;
      }
      res.status(upstream.status).send(text);
      return;
    }

    res.status(upstream.status);

    const forwardHeaders = [
      'content-type',
      'content-length',
      'content-range',
      'accept-ranges',
      'cache-control',
    ];
    for (const h of forwardHeaders) {
      const value = upstream.headers.get(h);
      if (value) {
        if (h === 'content-type' && value.includes('application/octet-stream')) {
          const lowerPath = targetUrl.pathname.toLowerCase();
          if (lowerPath.endsWith('.mp4')) {
            res.setHeader(h, 'video/mp4');
            continue;
          }
          if (lowerPath.endsWith('.webm')) {
            res.setHeader(h, 'video/webm');
            continue;
          }
          if (lowerPath.endsWith('.pdf')) {
            res.setHeader(h, 'application/pdf');
            continue;
          }
        }
        res.setHeader(h, value);
      }
    }

    if (!upstream.body) {
      res.end();
      return;
    }

    const nodeStream = Readable.fromWeb(upstream.body as NodeReadableStream<Uint8Array>);
    nodeStream.on('error', () => {
      if (!res.headersSent) {
        res.status(502).end();
      } else {
        res.destroy();
      }
    });

    res.on('close', () => {
      nodeStream.destroy();
    });

    nodeStream.pipe(res);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error al proxificar el recurso';
    if (!res.headersSent) {
      res.status(502).json({ error: message });
    }
  }
});
