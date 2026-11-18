import * as cheerio from 'cheerio';
import type { ExtractionResult, ExtractorAdapter, MediaItem, PageLink } from '../types.js';
import { makeMediaId, resolveUrl } from '../utils/url.js';
import { genericAdapter } from './generic.js';

export const lectortmoAdapter: ExtractorAdapter = {
  name: 'lectortmo',

  canHandle(url: URL): boolean {
    const host = url.hostname.toLowerCase();
    return host === 'lectortmo.vip' || host.endsWith('.lectortmo.vip');
  },

  extract(url: URL, html: string): ExtractionResult {
    const base = genericAdapter.extract(url, html);
    const $ = cheerio.load(html);

    const path = url.pathname.toLowerCase();
    const isChapterPage = path.includes('/manga-chapter/');
    const isMangaDetail = /^\/manga\/[^/]+\/?$/.test(path);

    const h1Title = $('h1').first().text().replace(/\s+/g, ' ').trim();

    const $posterEl = $(
      '.summary_image img, .manga-poster img, img[src*="wp-content/uploads"]',
    ).first();
    const posterImg =
      resolveUrl(
        $posterEl.attr('data-src') ||
          $posterEl.attr('data-lazy-src') ||
          $posterEl.attr('src'),
        url,
      ) ?? base.images[0]?.url;

    const synopsis =
      $('.description-summary p, .sinopsis p, p')
        .filter((_, el) => $(el).text().trim().length > 60)
        .first()
        .text()
        .replace(/\s+/g, ' ')
        .trim() || base.metadata.description;

    // 1. Si estamos en un capítulo (/manga-chapter/...), extraer las imágenes del lector
    if (isChapterPage) {
      const imgsMap = new Map<string, MediaItem>();
      $(
        '.reading-content img, .chapter-content img, img.wp-manga-chapter-img, main img',
      ).each((idx, el) => {
        const $img = $(el);
        const src = resolveUrl(
          $img.attr('data-src') || $img.attr('data-lazy-src') || $img.attr('src'),
          url,
        );
        if (!src || imgsMap.has(src)) return;
        if (/avatar|logo|icon|favicon/i.test(src)) return;
        imgsMap.set(src, {
          id: makeMediaId(src),
          type: 'image',
          url: src,
          title: `Página ${imgsMap.size + 1}`,
          sourceTag: 'manga-page',
        });
      });

      const parentMangaHref = resolveUrl(
        $('a[href*="/manga/"]').not('[href$="/manga/"]').first().attr('href'),
        url,
      );

      return {
        ...base,
        adapter: this.name,
        metadata: {
          ...base.metadata,
          title: h1Title || base.metadata.title,
          poster: posterImg,
          infoUrl: parentMangaHref ?? undefined,
        },
        videos: [],
        images: Array.from(imgsMap.values()),
        pdfs: [],
        pages: [],
      };
    }

    // 2. Si estamos en la ficha de un manga (/manga/<slug>/), extraer capítulos
    const pagesMap = new Map<string, PageLink>();
    if (isMangaDetail) {
      $('a[href*="/manga-chapter/"]').each((_, el) => {
        const $a = $(el);
        const href = resolveUrl($a.attr('href'), url);
        if (!href || pagesMap.has(href)) return;

        const $clone = $a.clone();
        $clone.find('style, script, svg, .material-icons, .material-symbols-outlined').remove();
        let rawText = $clone.text().replace(/menu_book/gi, '').replace(/\s+/g, ' ').trim();
        const capMatch = rawText.match(/Cap[ií]tulo\s+[\d.]+/i);
        const slugMatch = href.match(/capitulo-([\d-]+)\/?$/i);
        const title =
          capMatch?.[0] ||
          (slugMatch ? `Capítulo ${slugMatch[1].replace(/-/g, '.')}` : rawText) ||
          'Capítulo';

        pagesMap.set(href, {
          id: makeMediaId(href),
          url: href,
          title,
          thumbnail: posterImg,
        });
      });

      return {
        ...base,
        adapter: this.name,
        metadata: {
          ...base.metadata,
          title: h1Title || base.metadata.title,
          description: synopsis,
          poster: posterImg,
        },
        videos: [],
        images: posterImg ? [{ id: makeMediaId(posterImg), type: 'image', url: posterImg, title: h1Title }] : [],
        pdfs: [],
        pages: Array.from(pagesMap.values()),
      };
    }

    // 3. Portada, Biblioteca o Búsqueda: extraer tarjetas de mangas
    $('.manga-card a[href*="/manga/"], a[href*="/manga/"]').each((_, el) => {
      const $a = $(el);
      const href = resolveUrl($a.attr('href'), url);
      if (!href || pagesMap.has(href)) return;
      try {
        const p = new URL(href).pathname;
        if (p === '/manga/' || p === '/manga' || !/^\/manga\/[^/]+\/?$/.test(p)) {
          return;
        }
      } catch {
        return;
      }

      const $card = $a.closest('.manga-card, .manga-card-wrapper, article, div');
      const $img = $a.find('img').first().length
        ? $a.find('img').first()
        : $card.find('img').first();

      const thumb =
        resolveUrl(
          $img.attr('data-src') || $img.attr('data-lazy-src') || $img.attr('src'),
          url,
        ) ?? undefined;

      const $clone = $a.clone();
      $clone.find('style, script, svg').remove();
      const rawText = $clone.text().replace(/menu_book|LEER AHORA/gi, '').replace(/\s+/g, ' ').trim();
      const title =
        $a.attr('title')?.trim() ||
        $img.attr('alt')?.trim() ||
        rawText;

      if (!title || title.length < 2) return;

      pagesMap.set(href, {
        id: makeMediaId(href),
        url: href,
        title,
        thumbnail: thumb,
      });
    });

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
        description: synopsis,
        poster: posterImg,
      },
      videos: [],
      pages: Array.from(pagesMap.values()),
      nextPageUrl,
    };
  },
};
