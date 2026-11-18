import { Router, type Request, type Response } from 'express';
import { extractFromHtml } from '../adapters/index.js';
import { fetchTargetPage } from '../services/fetcher.js';
import type { ExtractionResult } from '../types.js';
import { extractFilename, makeMediaId, validateTargetUrl } from '../utils/url.js';

export const extractRouter = Router();

async function handleExtract(rawUrl: unknown, res: Response): Promise<void> {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    res.status(400).json({ error: 'Falta el parámetro "url"' });
    return;
  }

  try {
    const targetUrl = validateTargetUrl(rawUrl);
    const fetched = await fetchTargetPage(targetUrl);

    if (fetched.html !== undefined) {
      const result = extractFromHtml(fetched.finalUrl, fetched.html);
      res.json(result);
      return;
    }

    // Direct media file URL (PDF, video, or image)
    const ct = fetched.contentType;
    const urlStr = fetched.finalUrl.toString();
    const filename = extractFilename(urlStr) || fetched.finalUrl.hostname;
    const baseResult: ExtractionResult = {
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
      baseResult.pdfs.push({
        id: makeMediaId(urlStr),
        type: 'pdf',
        url: urlStr,
        title: filename,
        mimeType: 'application/pdf',
        sourceTag: 'direct',
      });
    } else if (ct.startsWith('video/')) {
      baseResult.videos.push({
        id: makeMediaId(urlStr),
        type: 'video',
        url: urlStr,
        title: filename,
        mimeType: ct.split(';')[0],
        sourceTag: 'direct',
      });
    } else if (ct.startsWith('image/')) {
      baseResult.images.push({
        id: makeMediaId(urlStr),
        type: 'image',
        url: urlStr,
        title: filename,
        mimeType: ct.split(';')[0],
        sourceTag: 'direct',
      });
    }

    res.json(baseResult);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error al procesar la URL';
    res.status(422).json({ error: message });
  }
}

extractRouter.get('/', (req: Request, res: Response) => {
  void handleExtract(req.query.url, res);
});

extractRouter.post('/', (req: Request, res: Response) => {
  const bodyUrl = (req.body as { url?: unknown } | undefined)?.url;
  void handleExtract(bodyUrl, res);
});
