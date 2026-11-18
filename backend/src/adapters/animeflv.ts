import * as cheerio from 'cheerio';
import type { ExtractionResult, ExtractorAdapter, MediaItem, PageLink } from '../types.js';
import { makeMediaId, resolveUrl } from '../utils/url.js';
import { genericAdapter } from './generic.js';

function decodeBase64Url(encoded: string | undefined): string | null {
  if (!encoded) return null;
  try {
    const decoded = Buffer.from(encoded.trim(), 'base64').toString('utf8').trim();
    const parsed = new URL(decoded);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.toString();
    }
    return null;
  } catch {
    return null;
  }
}

function formatDayGroupFromUrl(href: string): string | undefined {
  const m = href.match(/\/(\d{4})\/(\d{2})\/(\d{2})\//);
  if (!m) return undefined;
  const year = parseInt(m[1], 10);
  const month = parseInt(m[2], 10) - 1;
  const day = parseInt(m[3], 10);
  const itemDate = new Date(year, month, day);
  if (Number.isNaN(itemDate.getTime())) return undefined;

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diffDays = Math.round((today.getTime() - itemDate.getTime()) / (24 * 60 * 60 * 1000));

  if (diffDays === 0) return 'Hoy';
  if (diffDays === 1) return 'Ayer';

  const weekdays = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
  const months = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
  return `${weekdays[itemDate.getDay()]} ${day} ${months[month]}`;
}

export const animeflvAdapter: ExtractorAdapter = {
  name: 'animeflv',

  canHandle(url: URL): boolean {
    const host = url.hostname.toLowerCase();
    return host === 'animeflv.or.at' || host.endsWith('.animeflv.or.at');
  },

  extract(url: URL, html: string): ExtractionResult {
    const base = genericAdapter.extract(url, html);
    const $ = cheerio.load(html);

    // Mejorar metadata para vista tipo ficha de anime
    const h1Title = $('h1').first().text().trim();
    const synopsis = $('.anime-synopsis p').first().text().trim();
    const posterImg =
      resolveUrl(
        $('img.poster-image').first().attr('src') ||
          $('img.poster-image').first().attr('data-src') ||
          $('#iframePoster img').first().attr('src') ||
          $('#iframePoster img').first().attr('data-src'),
        url,
      ) ?? base.images[0]?.url;

    const statusText =
      $('.anime-status, .status, .Estado').first().text().trim() || undefined;

    // Enlace a la ficha principal del anime (/anime/<slug>/) si estamos en un episodio
    let infoUrl: string | undefined;
    $('a[href*="/anime/"]').each((_, el) => {
      if (infoUrl) return;
      const href = resolveUrl($(el).attr('href'), url);
      if (!href) return;
      try {
        const pathname = new URL(href).pathname;
        if (/^\/anime\/[^/]+\/?$/.test(pathname)) {
          infoUrl = href;
        }
      } catch {
        // ignore
      }
    });

    // 1. Decodificar opciones de video ocultas en base64 (button.iframe_btn[data-src])
    const videosMap = new Map<string, MediaItem>(base.videos.map((v) => [v.url, v]));

    $('button.iframe_btn[data-src], .server_btn[data-src]').each((idx, el) => {
      const $btn = $(el);
      const decodedUrl = decodeBase64Url($btn.attr('data-src'));
      if (!decodedUrl || videosMap.has(decodedUrl)) return;

      const label = $btn.text().trim() || `OPCIÓN ${idx + 1}`;
      let hostLabel = '';
      try {
        hostLabel = ` (${new URL(decodedUrl).hostname.replace(/^www\./, '')})`;
      } catch {
        // ignore
      }

      const isDirectM3u8 =
        /\/m3u8\//i.test(decodedUrl) || /\.m3u8(\?|#|$)/i.test(decodedUrl);
      const isDirectMp4 = /\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(decodedUrl);
      const isDirectStream = isDirectM3u8 || isDirectMp4;

      videosMap.set(decodedUrl, {
        id: makeMediaId(decodedUrl),
        type: 'video',
        url: decodedUrl,
        title: `${label}${hostLabel}${isDirectStream ? ' ★ Nativo' : ''}`,
        thumbnail: posterImg,
        mimeType: isDirectM3u8 ? 'application/x-mpegURL' : undefined,
        isEmbed: !isDirectStream,
        sourceTag: 'iframe_btn',
      });
    });

    // 2. Extraer "Lista de Episodios" desde <script class="animeflv-episodes-data">
    const pagesMap = new Map<string, PageLink>();
    $('script.animeflv-episodes-data').each((_, el) => {
      const rawJson = $(el).html()?.trim();
      if (!rawJson) return;
      try {
        const items = JSON.parse(rawJson) as Array<{
          permalink?: string;
          number?: number | string;
        }>;
        if (!Array.isArray(items)) return;
        for (const ep of items) {
          const href = resolveUrl(ep.permalink, url);
          if (!href || pagesMap.has(href)) continue;
          const numLabel = ep.number !== undefined ? `Capítulo ${ep.number}` : 'Episodio';
          pagesMap.set(href, {
            id: makeMediaId(href),
            url: href,
            title: numLabel,
            subtitle: ep.number !== undefined ? `EP ${ep.number}` : undefined,
            thumbnail: posterImg,
          });
        }
      } catch {
        // Ignore malformed JSON
      }
    });

    // 3. Extraer tarjetas de episodios / animes / búsqueda para navegar dentro de la app
    const cardSelectors = [
      '.search-series-card a[href]',
      '.Episode a[href]',
      '.Anime a[href]',
      '.List-Episodes a[href]',
      '.List-Animes a[href]',
      'article a[href]',
    ];

    for (const sel of cardSelectors) {
      $(sel).each((_, el) => {
        const $a = $(el);
        const href = resolveUrl($a.attr('href'), url);
        if (!href || pagesMap.has(href)) return;
        if (href === url.toString()) return;

        // Solo enlaces del mismo sitio (evitar publicidad externa)
        try {
          const parsed = new URL(href);
          if (!parsed.hostname.endsWith('animeflv.or.at')) return;
        } catch {
          return;
        }

        const $img = $a.find('img').first();
        const thumb =
          resolveUrl(
            $img.attr('data-src') || $img.attr('data-lazy-src') || $img.attr('src'),
            url,
          ) ?? undefined;

        const epBadge = $a.find('.Capi, .episode').first().text().trim();
        const rawTitle =
          $a.find('.Title, h2, h3').first().text().trim() ||
          $a.attr('title')?.trim() ||
          $img.attr('alt')?.trim() ||
          $a.text().trim();

        let cleanTitle = rawTitle.replace(/\s+/g, ' ').trim();
        if (epBadge && cleanTitle.endsWith(epBadge)) {
          cleanTitle = cleanTitle.slice(0, -epBadge.length).trim();
        }
        if (!cleanTitle) return;

        pagesMap.set(href, {
          id: makeMediaId(href),
          url: href,
          title: cleanTitle,
          subtitle: epBadge || undefined,
          thumbnail: thumb,
          group: formatDayGroupFromUrl(href),
        });
      });
    }

    const nextPageUrl =
      resolveUrl(
        $('a.next.page-numbers').first().attr('href') ||
          $('link[rel="next"]').first().attr('href'),
        url,
      ) ?? undefined;

    return {
      ...base,
      adapter: this.name,
      metadata: {
        ...base.metadata,
        title: h1Title || base.metadata.title,
        description: synopsis || base.metadata.description,
        poster: posterImg,
        infoUrl,
        status: statusText,
      },
      videos: Array.from(videosMap.values()),
      pages: Array.from(pagesMap.values()),
      nextPageUrl,
    };
  },
};
