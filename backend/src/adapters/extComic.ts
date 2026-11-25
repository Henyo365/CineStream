import * as cheerio from 'cheerio';
import type { ExtractionResult, ExtractorAdapter, MediaItem, PageLink } from '../types.js';
import { makeMediaId, resolveUrl } from '../utils/url.js';
import { genericAdapter } from './generic.js';

const VAULT_DOMAIN_XOR = [46, 55, 53, 50, 63, 52, 46, 59, 51, 116, 59, 42, 42];
export const VAULT_DOMAIN = String.fromCharCode(...VAULT_DOMAIN_XOR.map((b) => b ^ 0x5a));

export const extComicAdapter: ExtractorAdapter = {
  name: 'ext-comic',

  canHandle(url: URL): boolean {
    const host = url.hostname.toLowerCase();
    return host === VAULT_DOMAIN || host.endsWith(`.${VAULT_DOMAIN}`);
  },

  extract(url: URL, html: string): ExtractionResult {
    const base = genericAdapter.extract(url, html);
    const $ = cheerio.load(html);
    const path = url.pathname.toLowerCase();

    const isReader =
      path.startsWith('/view_uploads/') ||
      path.startsWith('/reader/') ||
      path.startsWith('/contents/') ||
      $('#reader-wrap, .reader-img-wrap').length > 0;

    const isDetail = path.startsWith('/library/') || $('#md-title, .md-hero-grid').length > 0;

    if (isReader) {
      const imgsMap = new Map<string, MediaItem>();
      $('#reader-wrap img, .reader-img-wrap img, #content-images img').each((_, el) => {
        const $img = $(el);
        const src = resolveUrl(
          $img.attr('data-src') || $img.attr('data-original') || $img.attr('src'),
          url,
        );
        if (!src || imgsMap.has(src)) return;
        imgsMap.set(src, {
          id: makeMediaId(src),
          type: 'image',
          url: src,
          title: `Página ${imgsMap.size + 1}`,
          sourceTag: 'manga-page',
        });
      });

      const infoUrl = resolveUrl($('a.tb-back[href]').first().attr('href'), url) ?? undefined;
      const title =
        $('.tb-title, h1').first().text().replace(/\s+/g, ' ').trim() || base.metadata.title;

      return {
        ...base,
        adapter: this.name,
        metadata: {
          ...base.metadata,
          title,
          infoUrl,
        },
        videos: [],
        images: Array.from(imgsMap.values()),
        pdfs: [],
        pages: [],
      };
    }

    if (isDetail) {
      const title =
        $('#md-title, h1').first().text().replace(/\s+/g, ' ').trim() || base.metadata.title;
      const posterImg =
        resolveUrl(
          $('#md-cover, .work-thumbnail img').first().attr('data-src') ||
            $('#md-cover, .work-thumbnail img').first().attr('src'),
          url,
        ) ?? base.metadata.poster;
      const status = $('.md-cover-card__status .md-badge').first().text().trim() || undefined;
      const rawSynopsis = $('.md-info-row--synopsis p').first().text().replace(/\s+/g, ' ').trim();
      const description =
        rawSynopsis && !rawSynopsis.startsWith('No hay descripción')
          ? rawSynopsis
          : base.metadata.description;

      const totalPages = $('#md-preview-grid').attr('data-total')?.trim();
      const pagesMap = new Map<string, PageLink>();

      const gridReaderUrl = resolveUrl($('#md-preview-grid').attr('data-reader-url'), url);
      if (gridReaderUrl) {
        pagesMap.set(gridReaderUrl, {
          id: makeMediaId(gridReaderUrl),
          url: gridReaderUrl,
          title: totalPages ? `Leer completo (${totalPages} páginas)` : 'Leer completo',
          subtitle: totalPages ? `${totalPages} págs` : undefined,
          thumbnail: posterImg,
        });
      }

      $('a.md-preview-read-btn[href], a[href*="/view_uploads/"], a[href*="/contents/"]').each(
        (_, el) => {
          const $a = $(el);
          const href = resolveUrl($a.attr('href'), url);
          if (!href || pagesMap.has(href)) return;
          const rawTxt = $a.text().replace(/\s+/g, ' ').trim();
          pagesMap.set(href, {
            id: makeMediaId(href),
            url: href,
            title:
              !rawTxt || rawTxt.toLowerCase() === 'leer'
                ? totalPages
                  ? `Leer completo (${totalPages} páginas)`
                  : 'Leer capítulo'
                : rawTxt,
            thumbnail: posterImg,
          });
        },
      );

      return {
        ...base,
        adapter: this.name,
        metadata: {
          ...base.metadata,
          title,
          description,
          poster: posterImg,
          status,
        },
        videos: [],
        images: [],
        pdfs: [],
        pages: Array.from(pagesMap.values()),
      };
    }

    const pagesMap = new Map<string, PageLink>();
    $('a.manga-card[href*="/library/"], a[href*="/library/"]').each((_, el) => {
      const $a = $(el);
      const href = resolveUrl($a.attr('href'), url);
      if (!href || pagesMap.has(href) || href === url.toString()) return;
      const $img = $a.find('img').first();
      const thumb = resolveUrl($img.attr('data-src') || $img.attr('src'), url) ?? undefined;
      const itemTitle =
        $a.find('.manga-card__title, h3').first().text().replace(/\s+/g, ' ').trim() ||
        $a.attr('title')?.trim() ||
        $img.attr('alt')?.trim();
      if (!itemTitle || itemTitle.length < 2) return;
      const subtitle = $a.find('.book-type').first().text().trim() || undefined;
      pagesMap.set(href, {
        id: makeMediaId(href),
        url: href,
        title: itemTitle,
        subtitle,
        thumbnail: thumb,
      });
    });

    const nextPageUrl =
      resolveUrl(
        $('ul.pagination a[rel="next"], a[rel="next"], link[rel="next"]').first().attr('href'),
        url,
      ) ?? undefined;

    return {
      ...base,
      adapter: this.name,
      videos: [],
      images: [],
      pdfs: [],
      pages: Array.from(pagesMap.values()),
      nextPageUrl,
    };
  },
};
