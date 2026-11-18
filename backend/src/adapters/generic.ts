import * as cheerio from 'cheerio';
import type { ExtractionResult, ExtractorAdapter, MediaItem, PageMetadata } from '../types.js';
import { extractFilename, makeMediaId, pickBestFromSrcset, resolveUrl } from '../utils/url.js';

const VIDEO_EXT_RE = /\.(mp4|webm|m3u8|mov|mkv|m4v)(\?|#|$)/i;
const IMAGE_EXT_RE = /\.(jpe?g|png|webp|gif|avif)(\?|#|$)/i;
const PDF_EXT_RE = /\.pdf(\?|#|$)/i;
const VIDEO_EMBED_HOST_RE = /(youtube\.com|youtu\.be|vimeo\.com|dailymotion\.com|twitch\.tv|streamable\.com|ok\.ru|drive\.google\.com|vidyard|wistia|jwplayer|player\.|embed)/i;

function addUnique(map: Map<string, MediaItem>, item: Omit<MediaItem, 'id'>): void {
  if (!map.has(item.url)) {
    map.set(item.url, { id: makeMediaId(item.url), ...item });
  }
}

export const genericAdapter: ExtractorAdapter = {
  name: 'generic',

  canHandle(): boolean {
    return true;
  },

  extract(url: URL, html: string): ExtractionResult {
    const $ = cheerio.load(html);

    const title =
      $('meta[property="og:title"]').attr('content')?.trim() ||
      $('title').first().text().trim() ||
      url.hostname;

    const description =
      $('meta[property="og:description"]').attr('content')?.trim() ||
      $('meta[name="description"]').attr('content')?.trim();

    const siteName =
      $('meta[property="og:site_name"]').attr('content')?.trim() || url.hostname;

    const rawFavicon =
      $('link[rel="icon"]').attr('href') ||
      $('link[rel="shortcut icon"]').attr('href') ||
      '/favicon.ico';

    const metadata: PageMetadata = {
      title,
      description,
      siteName,
      favicon: resolveUrl(rawFavicon, url) ?? undefined,
      sourceUrl: url.toString(),
    };

    const videos = new Map<string, MediaItem>();
    const images = new Map<string, MediaItem>();
    const pdfs = new Map<string, MediaItem>();

    // 1. OpenGraph / Twitter video meta tags
    const videoMetaSelectors = [
      'meta[property="og:video"]',
      'meta[property="og:video:url"]',
      'meta[property="og:video:secure_url"]',
      'meta[name="twitter:player:stream"]',
    ];
    for (const sel of videoMetaSelectors) {
      $(sel).each((_, el) => {
        const resolved = resolveUrl($(el).attr('content'), url);
        if (resolved) {
          addUnique(videos, {
            type: 'video',
            url: resolved,
            title: extractFilename(resolved) || title,
            sourceTag: 'meta',
          });
        }
      });
    }

    // 2. <video> and <source> tags
    $('video').each((_, el) => {
      const $video = $(el);
      const poster = resolveUrl($video.attr('poster'), url) ?? undefined;
      const directSrc = resolveUrl($video.attr('src') || $video.attr('data-src'), url);
      if (directSrc) {
        addUnique(videos, {
          type: 'video',
          url: directSrc,
          title: $video.attr('title')?.trim() || extractFilename(directSrc) || 'Video',
          thumbnail: poster,
          sourceTag: 'video',
        });
      }

      $video.find('source').each((__, srcEl) => {
        const srcUrl = resolveUrl($(srcEl).attr('src') || $(srcEl).attr('data-src'), url);
        if (srcUrl) {
          addUnique(videos, {
            type: 'video',
            url: srcUrl,
            title: extractFilename(srcUrl) || 'Video',
            thumbnail: poster,
            mimeType: $(srcEl).attr('type')?.trim(),
            sourceTag: 'source',
          });
        }
      });
    });

    // 3. Embedded <iframe> (video players or PDFs)
    $('iframe').each((_, el) => {
      const src = resolveUrl($(el).attr('src') || $(el).attr('data-src'), url);
      if (!src) return;

      if (PDF_EXT_RE.test(src)) {
        addUnique(pdfs, {
          type: 'pdf',
          url: src,
          title: $(el).attr('title')?.trim() || extractFilename(src) || 'Documento PDF',
          mimeType: 'application/pdf',
          sourceTag: 'iframe',
        });
      } else if (VIDEO_EXT_RE.test(src) || VIDEO_EMBED_HOST_RE.test(src)) {
        addUnique(videos, {
          type: 'video',
          url: src,
          title: $(el).attr('title')?.trim() || 'Video incrustado',
          isEmbed: !VIDEO_EXT_RE.test(src),
          sourceTag: 'iframe',
        });
      }
    });

    // 4. <embed> and <object> tags (commonly used for PDFs)
    $('embed, object').each((_, el) => {
      const $el = $(el);
      const raw = $el.attr('src') || $el.attr('data');
      const resolved = resolveUrl(raw, url);
      if (!resolved) return;

      const typeAttr = $el.attr('type')?.toLowerCase() ?? '';
      if (typeAttr.includes('pdf') || PDF_EXT_RE.test(resolved)) {
        addUnique(pdfs, {
          type: 'pdf',
          url: resolved,
          title: extractFilename(resolved) || 'Documento PDF',
          mimeType: 'application/pdf',
          sourceTag: el.tagName,
        });
      }
    });

    // 5. OpenGraph / Twitter images
    $('meta[property="og:image"], meta[name="twitter:image"]').each((_, el) => {
      const resolved = resolveUrl($(el).attr('content'), url);
      if (resolved) {
        addUnique(images, {
          type: 'image',
          url: resolved,
          title: extractFilename(resolved) || 'Imagen destacada',
          sourceTag: 'meta',
        });
      }
    });

    // 6. <img> tags (with lazy-load & srcset support)
    $('img').each((_, el) => {
      const $img = $(el);
      const width = parseInt($img.attr('width') ?? '', 10);
      const height = parseInt($img.attr('height') ?? '', 10);
      if ((width > 0 && width <= 4) || (height > 0 && height <= 4)) {
        return; // skip 1x1 tracking pixels
      }

      const bestSrcset =
        pickBestFromSrcset($img.attr('srcset'), url) ||
        pickBestFromSrcset($img.attr('data-srcset'), url);

      const fallbackSrc = resolveUrl(
        $img.attr('data-original') ||
          $img.attr('data-lazy-src') ||
          $img.attr('data-src') ||
          $img.attr('src'),
        url,
      );

      const finalUrl = bestSrcset || fallbackSrc;
      if (!finalUrl) return;

      addUnique(images, {
        type: 'image',
        url: finalUrl,
        title: $img.attr('alt')?.trim() || extractFilename(finalUrl) || 'Imagen',
        sourceTag: 'img',
      });
    });

    // 7. Direct <a> links to videos, images, or PDFs
    $('a[href]').each((_, el) => {
      const $a = $(el);
      const resolved = resolveUrl($a.attr('href'), url);
      if (!resolved) return;

      const linkText = $a.text().trim();

      if (PDF_EXT_RE.test(resolved)) {
        addUnique(pdfs, {
          type: 'pdf',
          url: resolved,
          title: linkText || extractFilename(resolved) || 'Documento PDF',
          mimeType: 'application/pdf',
          sourceTag: 'a',
        });
      } else if (VIDEO_EXT_RE.test(resolved)) {
        addUnique(videos, {
          type: 'video',
          url: resolved,
          title: linkText || extractFilename(resolved) || 'Video',
          sourceTag: 'a',
        });
      } else if (IMAGE_EXT_RE.test(resolved)) {
        addUnique(images, {
          type: 'image',
          url: resolved,
          title: linkText || extractFilename(resolved) || 'Imagen',
          sourceTag: 'a',
        });
      }
    });

    const pages = new Map<string, { id: string; url: string; title: string; thumbnail?: string }>();
    $('article a[href]').each((_, el) => {
      const $a = $(el);
      const href = resolveUrl($a.attr('href'), url);
      if (!href || href === url.toString() || pages.has(href)) return;
      try {
        if (new URL(href).hostname !== url.hostname) return;
      } catch {
        return;
      }
      const $img = $a.find('img').first();
      const thumb =
        resolveUrl(
          $img.attr('data-src') || $img.attr('data-lazy-src') || $img.attr('src'),
          url,
        ) ?? undefined;
      const linkTitle =
        $a.attr('title')?.trim() ||
        $img.attr('alt')?.trim() ||
        $a.text().replace(/\s+/g, ' ').trim();
      if (!linkTitle || linkTitle.length < 3) return;
      pages.set(href, {
        id: makeMediaId(href),
        url: href,
        title: linkTitle,
        thumbnail: thumb,
      });
    });

    return {
      adapter: this.name,
      metadata,
      videos: Array.from(videos.values()),
      images: Array.from(images.values()),
      pdfs: Array.from(pdfs.values()),
      pages: Array.from(pages.values()),
    };
  },
};
