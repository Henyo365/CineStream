import * as cheerio from 'cheerio';
import type { ExtractionResult, ExtractorAdapter } from '../types.js';
import { genericAdapter } from './generic.js';
import { makeMediaId, resolveUrl } from '../utils/url.js';

/**
 * Ejemplo de adaptador específico para una página web concreta.
 * Puedes duplicar este archivo y registrarlo en `src/adapters/index.ts`
 * para soportar sitios donde los videos/imágenes/PDFs están en atributos personalizados
 * o bloques JSON específicos.
 */
export const exampleSiteAdapter: ExtractorAdapter = {
  name: 'example-site',

  canHandle(url: URL): boolean {
    return url.hostname === 'example.com' || url.hostname.endsWith('.example.com');
  },

  extract(url: URL, html: string): ExtractionResult {
    // Reutilizamos el extractor genérico como base
    const base = genericAdapter.extract(url, html);
    const $ = cheerio.load(html);

    // Ejemplo: buscar atributos personalizados tipo data-video-url
    $('[data-video-url]').each((_, el) => {
      const videoUrl = resolveUrl($(el).attr('data-video-url'), url);
      if (videoUrl && !base.videos.some((v) => v.url === videoUrl)) {
        base.videos.push({
          id: makeMediaId(videoUrl),
          type: 'video',
          url: videoUrl,
          title: $(el).attr('data-title')?.trim() || 'Video personalizado',
          sourceTag: 'custom-attr',
        });
      }
    });

    return {
      ...base,
      adapter: this.name,
    };
  },
};
