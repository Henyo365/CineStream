import * as cheerio from 'cheerio';
import type { ExtractionResult, ExtractorAdapter, MediaItem, PageLink } from '../types.js';
import { makeMediaId, resolveUrl } from '../utils/url.js';
import { genericAdapter } from './generic.js';

export const hackstoreAdapter: ExtractorAdapter = {
  name: 'hackstore',

  canHandle(url: URL): boolean {
    const host = url.hostname.toLowerCase();
    return host === 'hackstore.fo' || host.endsWith('.hackstore.fo') || host.includes('hackstore.');
  },

  extract(url: URL, html: string): ExtractionResult {
    const base = genericAdapter.extract(url, html);
    const $ = cheerio.load(html);

    const h1Title = $('h1').first().text().trim();
    const $posterEl = $('.poster img, .movie-poster img, .wp-post-image, img.imghacks, .movie-back img').first();
    const posterImg =
      resolveUrl(
        $posterEl.attr('data-src') ||
          $posterEl.attr('data-lazy-src') ||
          $posterEl.attr('src'),
        url,
      ) ?? base.images[0]?.url;

    const synopsis =
      $('.sinopsis p, .synopsis p, .entry-content p, .description p')
        .filter((_, el) => $(el).text().trim().length > 40)
        .first()
        .text()
        .trim() || base.metadata.description;

    // 1. Videos (Servidores a.playr[data-player-src] + iframe principal #intesx + Tráiler)
    const videosMap = new Map<string, MediaItem>();

    $('a.playr[data-player-src], [data-player-src]').each((idx, el) => {
      const $el = $(el);
      const src = resolveUrl($el.attr('data-player-src'), url);
      if (!src || videosMap.has(src)) return;
      const label = $el.text().replace(/\s+/g, ' ').trim();
      videosMap.set(src, {
        id: makeMediaId(src),
        type: 'video',
        url: src,
        title: label || `Servidor ${idx + 1}`,
        thumbnail: posterImg,
        isEmbed: true,
        sourceTag: 'playr',
      });
    });

    // Priorizar el iframe principal (#intesx / .video iframe)
    $('iframe#intesx, .video iframe, .playrn iframe').each((idx, el) => {
      const src = resolveUrl($(el).attr('src') || $(el).attr('data-src'), url);
      if (!src || videosMap.has(src)) return;
      videosMap.set(src, {
        id: makeMediaId(src),
        type: 'video',
        url: src,
        title: videosMap.size === 0 && idx === 0 ? 'Reproductor Principal' : `Reproductor ${videosMap.size + 1}`,
        thumbnail: posterImg,
        isEmbed: true,
        sourceTag: 'iframe',
      });
    });

    for (const v of base.videos) {
      if (v.url.includes('facebook.com/')) continue;
      if (!videosMap.has(v.url)) {
        const isYt = v.url.includes('youtube.com') || v.url.includes('youtu.be');
        videosMap.set(v.url, {
          ...v,
          title: isYt ? 'Tráiler (YouTube)' : v.title,
        });
      }
    }

    // 2. Episodios dentro de una ficha de serie (/episodio/...)
    const pagesMap = new Map<string, PageLink>();

    $('a[href*="/episodio/"]').each((_, el) => {
      const $a = $(el);
      const href = resolveUrl($a.attr('href'), url);
      if (!href || pagesMap.has(href) || href === url.toString()) return;

      const $img = $a.find('img').first();
      const thumb =
        resolveUrl(
          $img.attr('data-src') || $img.attr('data-lazy-src') || $img.attr('src'),
          url,
        ) ?? posterImg;

      const epMatch = href.match(/(\d+x\d+|\d+)\/?$/i);
      let title = '';
      if (epMatch) {
        title = `Episodio ${epMatch[1]}`;
      } else {
        const $clone = $a.clone();
        $clone.find('style, script, svg').remove();
        title =
          $clone.text().replace(/\s+/g, ' ').trim() ||
          $a.attr('title')?.trim() ||
          $img.attr('alt')?.trim() ||
          'Episodio';
      }

      pagesMap.set(href, {
        id: makeMediaId(href),
        url: href,
        title,
        thumbnail: thumb,
      });
    });

    // 3. Tarjetas de películas / series en portada, categorías o búsqueda (.poster y .movie-back)
    $('.poster, .poster-pad').each((_, el) => {
      const $poster = $(el);
      const $a = $poster.find('a[href]').first();
      const href = resolveUrl($a.attr('href'), url);
      if (!href || pagesMap.has(href) || href === url.toString()) return;

      const $img = $poster.find('img').first();
      const thumb =
        resolveUrl(
          $img.attr('data-src') || $img.attr('data-lazy-src') || $img.attr('src'),
          url,
        ) ?? undefined;

      // Buscar título en .movie-title2 / .movie-title hermano o en alt
      const $card = $poster.parent();
      const title =
        $card.find('.movie-title2, .movie-title, .title, h2, h3').first().text().trim() ||
        $img.attr('alt')?.trim() ||
        $a.attr('title')?.trim();

      if (!title) return;

      const quality = $card.find('.calidad, .quality, .year').first().text().trim();

      pagesMap.set(href, {
        id: makeMediaId(href),
        url: href,
        title: title.replace(/\s+/g, ' ').trim(),
        subtitle: quality || undefined,
        thumbnail: thumb,
      });
    });

    // Fallback para enlaces de películas/series si no están en .poster
    if (pagesMap.size === 0) {
      $('a.movie-title2[href], article a[href]').each((_, el) => {
        const $a = $(el);
        const href = resolveUrl($a.attr('href'), url);
        if (!href || pagesMap.has(href) || href === url.toString()) return;
        const title = $a.text().trim() || $a.attr('title')?.trim();
        if (!title || title.length < 2) return;
        const $img = $a.find('img').first();
        const thumb =
          resolveUrl($img.attr('data-src') || $img.attr('src'), url) ?? undefined;
        pagesMap.set(href, {
          id: makeMediaId(href),
          url: href,
          title: title.replace(/\s+/g, ' ').trim(),
          thumbnail: thumb,
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
        description: synopsis,
        poster: posterImg,
      },
      videos: Array.from(videosMap.values()),
      pages: Array.from(pagesMap.values()),
      nextPageUrl,
    };
  },
};
