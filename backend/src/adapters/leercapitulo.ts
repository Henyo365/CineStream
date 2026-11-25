import * as cheerio from 'cheerio';
import type { ExtractionResult, ExtractorAdapter, MediaItem, PageLink } from '../types.js';
import { makeMediaId, resolveUrl } from '../utils/url.js';
import { genericAdapter } from './generic.js';

export const leercapituloAdapter: ExtractorAdapter = {
  name: 'leercapitulo',

  canHandle(url: URL): boolean {
    const host = url.hostname.toLowerCase();
    return host === 'leercapitulo.co' || host.endsWith('.leercapitulo.co');
  },

  extract(url: URL, html: string): ExtractionResult {
    const base = genericAdapter.extract(url, html);
    const $ = cheerio.load(html);
    const path = url.pathname.toLowerCase();

    const isReader = path.startsWith('/leer/') || $('main#lcPages, main.lc-pages').length > 0;
    const isDetail =
      path.startsWith('/manga/') &&
      path.replace(/^\/+|\/+$/g, '').split('/').length >= 2 &&
      $('#chapterList, .lc-facts').length > 0;

    if (isReader) {
      const imgsMap = new Map<string, MediaItem>();
      $('#lcPages img, main.lc-pages img').each((_, el) => {
        const $img = $(el);
        const src = resolveUrl(
          $img.attr('data-src') || $img.attr('data-lazy-src') || $img.attr('src'),
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

      const $back = $('a.lc-rbtn--title[href*="/manga/"]').first();
      const infoUrl = resolveUrl($back.attr('href'), url) ?? undefined;
      const mangaName = $back.text().replace(/^‹/, '').replace(/\s+/g, ' ').trim();
      const selectedChap = $('#chapterSelect option[selected]').first().text().trim();

      const pagesMap = new Map<string, PageLink>();
      $('#chapterSelect option[value]').each((_, opt) => {
        const href = resolveUrl($(opt).attr('value'), url);
        const chapLabel = $(opt).text().replace(/\s+/g, ' ').trim();
        if (!href || !chapLabel || pagesMap.has(href)) return;
        pagesMap.set(href, {
          id: makeMediaId(href),
          url: href,
          title: chapLabel,
        });
      });

      return {
        ...base,
        adapter: this.name,
        metadata: {
          ...base.metadata,
          title:
            mangaName && selectedChap
              ? `${mangaName} - ${selectedChap}`
              : mangaName || base.metadata.title,
          infoUrl,
        },
        videos: [],
        images: Array.from(imgsMap.values()),
        pdfs: [],
        pages: Array.from(pagesMap.values()),
      };
    }

    if (isDetail) {
      const title =
        $('article h1, h1').first().text().replace(/\s+/g, ' ').trim() || base.metadata.title;
      const posterImg =
        resolveUrl(
          $('.lc-cover-lg img').first().attr('data-src') ||
            $('.lc-cover-lg img').first().attr('src'),
          url,
        ) ?? base.metadata.poster;
      const synopsis =
        $('#sinopsis p').first().text().replace(/\s+/g, ' ').trim() || base.metadata.description;

      const pagesMap = new Map<string, PageLink>();
      $('#chapterList a.lc-chapter-row[href], a[href*="/leer/"]').each((_, el) => {
        const $a = $(el);
        const href = resolveUrl($a.attr('href'), url);
        if (!href || pagesMap.has(href)) return;
        const chapTitle =
          $a.find('.n').first().text().replace(/\s+/g, ' ').trim() ||
          $a.text().replace(/\s+/g, ' ').trim();
        if (!chapTitle) return;
        const dateSub = $a.find('.d').first().text().trim() || undefined;
        pagesMap.set(href, {
          id: makeMediaId(href),
          url: href,
          title: chapTitle,
          subtitle: dateSub,
          thumbnail: posterImg,
        });
      });

      return {
        ...base,
        adapter: this.name,
        metadata: {
          ...base.metadata,
          title,
          description: synopsis,
          poster: posterImg,
        },
        videos: [],
        images: [],
        pdfs: [],
        pages: Array.from(pagesMap.values()),
      };
    }

    const pagesMap = new Map<string, PageLink>();

    $('article.lc-card').each((_, el) => {
      const $card = $(el);
      const $cover = $card.find('a.lc-card-cover[href]').first();
      const href = resolveUrl($cover.attr('href'), url);
      if (!href || pagesMap.has(href)) return;
      const thumb =
        resolveUrl($cover.find('img').attr('data-src') || $cover.find('img').attr('src'), url) ??
        undefined;
      const itemTitle = $card.find('.lc-card-name').first().text().replace(/\s+/g, ' ').trim();
      if (!itemTitle) return;
      const kind = $card.find('.lc-card-badge').first().text().trim();
      const chap = $card.find('.lc-chapter-link').first().text().trim();
      pagesMap.set(href, {
        id: makeMediaId(href),
        url: href,
        title: itemTitle,
        subtitle: [kind, chap].filter(Boolean).join(' • ') || undefined,
        thumbnail: thumb,
      });
    });

    $('.lc-slide').each((_, el) => {
      const $slide = $(el);
      const $cover = $slide.find('a.lc-slide-cover[href]').first();
      const href = resolveUrl($cover.attr('href'), url);
      if (!href || pagesMap.has(href)) return;
      const thumb = resolveUrl($cover.find('img').attr('src'), url) ?? undefined;
      const itemTitle = $slide.find('.lc-slide-name').first().text().replace(/\s+/g, ' ').trim();
      if (!itemTitle) return;
      const chap = $slide.find('.lc-slide-chapter').first().text().trim() || undefined;
      pagesMap.set(href, {
        id: makeMediaId(href),
        url: href,
        title: itemTitle,
        subtitle: chap,
        thumbnail: thumb,
        group: 'Tendencias',
      });
    });

    $('article.lc-release').each((_, el) => {
      const $rel = $(el);
      const $cover = $rel.find('a.lc-release-cover[href]').first();
      const href = resolveUrl($cover.attr('href'), url);
      if (!href || pagesMap.has(href)) return;
      const thumb = resolveUrl($cover.find('img').attr('src'), url) ?? undefined;
      const itemTitle = $rel.find('.lc-release-title').first().text().replace(/\s+/g, ' ').trim();
      if (!itemTitle) return;
      const chap = $rel.find('.lc-chapter-link').first().text().trim() || undefined;
      pagesMap.set(href, {
        id: makeMediaId(href),
        url: href,
        title: itemTitle,
        subtitle: chap,
        thumbnail: thumb,
        group: 'Últimos capítulos',
      });
    });

    const nextPageUrl =
      resolveUrl(
        $('a.page-link[rel="next"], a[rel="next"], link[rel="next"]').first().attr('href'),
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
