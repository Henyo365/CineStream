import { Router, type Request, type Response } from 'express';
import { extractFromHtml } from '../adapters/index.js';
import { fetchTargetPage } from '../services/fetcher.js';
import type { ExtractionResult } from '../types.js';
import { extractFilename, makeMediaId, validateTargetUrl } from '../utils/url.js';

export const extractRouter = Router();

const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 200;
const extractCache = new Map<string, { data: ExtractionResult; expiresAt: number }>();
const inFlightExtractions = new Map<string, Promise<ExtractionResult>>();

function pruneExpiredCache(): void {
  const now = Date.now();
  for (const [k, v] of extractCache.entries()) {
    if (v.expiresAt <= now) {
      extractCache.delete(k);
    }
  }
}

export async function extractUrl(
  rawUrl: string,
  bypassCache = false,
): Promise<ExtractionResult> {
  const targetUrl = validateTargetUrl(rawUrl);
  const cacheKey = targetUrl.toString();

  if (!bypassCache) {
    const cached = extractCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.data;
    }
    const existingFlight = inFlightExtractions.get(cacheKey);
    if (existingFlight) {
      return existingFlight;
    }
  }

  const run = (async (): Promise<ExtractionResult> => {
    const fetched = await fetchTargetPage(targetUrl);
    let result: ExtractionResult;

    if (fetched.html !== undefined) {
      result = extractFromHtml(fetched.finalUrl, fetched.html);
    } else {
      const ct = fetched.contentType;
      const urlStr = fetched.finalUrl.toString();
      const filename = extractFilename(urlStr) || fetched.finalUrl.hostname;
      result = {
        adapter: 'direct-media',
        metadata: {
          title: filename,
          siteName: fetched.finalUrl.hostname,
          sourceUrl: urlStr,
        },
        videos: [],
        images: [],
        pdfs: [],
        pages: [],
      };

      if (ct.includes('pdf')) {
        result.pdfs.push({
          id: makeMediaId(urlStr),
          type: 'pdf',
          url: urlStr,
          title: filename,
          mimeType: 'application/pdf',
          sourceTag: 'direct',
        });
      } else if (ct.startsWith('video/')) {
        result.videos.push({
          id: makeMediaId(urlStr),
          type: 'video',
          url: urlStr,
          title: filename,
          mimeType: ct.split(';')[0],
          sourceTag: 'direct',
        });
      } else if (ct.startsWith('image/')) {
        result.images.push({
          id: makeMediaId(urlStr),
          type: 'image',
          url: urlStr,
          title: filename,
          mimeType: ct.split(';')[0],
          sourceTag: 'direct',
        });
      }
    }

    if (extractCache.size >= MAX_CACHE_ENTRIES) {
      pruneExpiredCache();
      if (extractCache.size >= MAX_CACHE_ENTRIES) {
        const firstKey = extractCache.keys().next().value;
        if (firstKey) extractCache.delete(firstKey);
      }
    }
    extractCache.set(cacheKey, {
      data: result,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });

    return result;
  })();

  if (!bypassCache) {
    inFlightExtractions.set(cacheKey, run);
  }
  try {
    return await run;
  } finally {
    if (!bypassCache) {
      inFlightExtractions.delete(cacheKey);
    }
  }
}

async function handleExtract(
  rawUrl: unknown,
  bypassCache: boolean,
  res: Response,
): Promise<void> {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    res.status(400).json({ error: 'Falta el parámetro "url"' });
    return;
  }

  try {
    const result = await extractUrl(rawUrl, bypassCache);
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error al procesar la URL';
    res.status(422).json({ error: message });
  }
}

extractRouter.get('/', (req: Request, res: Response) => {
  const refresh = req.query.refresh === 'true' || req.query.refresh === '1';
  void handleExtract(req.query.url, refresh, res);
});

extractRouter.post('/', (req: Request, res: Response) => {
  const body = req.body as { url?: unknown; html?: unknown; refresh?: unknown } | undefined;
  if (
    typeof body?.url === 'string' &&
    body.url.trim() &&
    typeof body?.html === 'string' &&
    body.html.trim()
  ) {
    try {
      const targetUrl = validateTargetUrl(body.url);
      const parsed = extractFromHtml(targetUrl, body.html);
      extractCache.set(targetUrl.toString(), {
        data: parsed,
        expiresAt: Date.now() + CACHE_TTL_MS,
      });
      res.json(parsed);
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Error al procesar HTML';
      res.status(422).json({ error: message });
      return;
    }
  }
  const refresh = Boolean(body?.refresh);
  void handleExtract(body?.url, refresh, res);
});
