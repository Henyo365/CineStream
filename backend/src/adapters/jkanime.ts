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

const RESERVED_JK_PATHS = new Set([
  'directorio',
  'buscar',
  'horario',
  'top',
  'estrenos',
  'genero',
  'studio',
  'idioma',
  'usuario',
  'dash',
  'guardado',
  'historial',
  'notificaciones',
  'comunidad',
  'pedidos',
  'aplicacion',
  'salir',
  'ajax',
  'jkplayer',
]);

function isReservedJkPath(pathname: string): boolean {
  const clean = pathname.replace(/^\/+|\/+$/g, '').toLowerCase();
  if (!clean) return true;
  const first = clean.split('/')[0] ?? '';
  return RESERVED_JK_PATHS.has(first);
}

export const jkanimeAdapter: ExtractorAdapter = {
  name: 'jkanime',

  canHandle(url: URL): boolean {
    const host = url.hostname.toLowerCase();
    return host === 'jkanime.net' || host.endsWith('.jkanime.net');
  },

  extract(url: URL, html: string): ExtractionResult {
    const base = genericAdapter.extract(url, html);
    const $ = cheerio.load(html);

    const videoIframeRx = /video\[\d+\]\s*=\s*'<iframe[^>]+src="([^"]+)"/g;
    const serversRx = /var\s+servers\s*=\s*(\[\{[\s\S]*?\}\])\s*;/;
    const hasJkVideos = videoIframeRx.test(html) || serversRx.test(html);
    videoIframeRx.lastIndex = 0;

    // 1. Episode page
    if (hasJkVideos) {
      const jkDefaultMatch = html.match(/var\s+jkdefault\s*=\s*"(https?:\/\/[^"]+)"/);
      const posterImg = jkDefaultMatch?.[1] ?? base.metadata.poster ?? base.images[0]?.url;

      const animeSlug =
        $('#marcar_visto').attr('data-anime') || $('#guardar-capitulo').attr('data-anime');
      let infoUrl: string | undefined = animeSlug
        ? `https://jkanime.net/${animeSlug.replace(/^\/+|\/+$/g, '')}/`
        : undefined;
      if (!infoUrl) {
        const parts = url.pathname.replace(/^\/+|\/+$/g, '').split('/');
        if (parts.length >= 2 && !isReservedJkPath(parts[0])) {
          infoUrl = `https://jkanime.net/${parts[0]}/`;
        }
      }

      const videosMap = new Map<string, MediaItem>();
      let m: RegExpExecArray | null;
      let idx = 0;
      while ((m = videoIframeRx.exec(html)) !== null) {
        const resolved = resolveUrl(m[1], url);
        if (!resolved || videosMap.has(resolved)) continue;
        idx++;
        const label = resolved.includes('/jkplayer/umv')
          ? 'Magi ★ JKPlayer HD'
          : resolved.includes('/jkplayer/um')
            ? 'Desu ★ JKPlayer HD'
            : `JKPlayer ${idx}`;
        videosMap.set(resolved, {
          id: makeMediaId(resolved),
          type: 'video',
          url: resolved,
          title: label,
          thumbnail: posterImg,
          isEmbed: true,
          sourceTag: 'jkplayer',
        });
      }

      const srvMatch = html.match(serversRx);
      if (srvMatch?.[1]) {
        try {
          const list = JSON.parse(srvMatch[1]) as Array<{
            remote?: string;
            server?: string;
            lang?: number;
          }>;
          for (const entry of list) {
            const decoded = decodeBase64Url(entry.remote);
            if (!decoded || videosMap.has(decoded)) continue;
            const lower = decoded.toLowerCase();
            if (lower.includes('mediafire.com/file/') || lower.includes('1fichier.com')) continue;
            const srvName = entry.server?.trim() || 'Servidor';
            const langTag =
              entry.lang === 3 ? ' [Latino]' : entry.lang === 4 ? ' [Castellano]' : '';
            videosMap.set(decoded, {
              id: makeMediaId(decoded),
              type: 'video',
              url: decoded,
              title: `${srvName}${langTag}`,
              thumbnail: posterImg,
              isEmbed: !lower.includes('.m3u8') && !lower.endsWith('.mp4'),
              sourceTag: 'jk_remote',
            });
          }
        } catch {
          // ignore malformed servers json
        }
      }

      const mvTitle = $('#marcar_visto').attr('data-title');
      const mvNum = $('#marcar_visto').attr('data-numero');
      const epTitle =
        $('.breadcrumb__links span, h1').first().text().replace(/\s+/g, ' ').trim() ||
        (mvTitle && mvNum ? `${mvTitle} - Episodio ${mvNum}` : base.metadata.title);

      return {
        ...base,
        adapter: this.name,
        metadata: {
          ...base.metadata,
          title: epTitle,
          poster: posterImg,
          infoUrl,
        },
        videos: Array.from(videosMap.values()),
        pdfs: [],
        pages: [],
      };
    }

    // 2. Detail page
    if ($('.anime__details__content, .anime_info').length > 0) {
      const title =
        $('.anime_info h3, h1').first().text().replace(/\s+/g, ' ').trim() || base.metadata.title;
      const synopsis =
        $('.anime_info p.scroll, .anime_info p').first().text().replace(/\s+/g, ' ').trim() ||
        base.metadata.description;
      const posterImg =
        resolveUrl(
          $('.anime_pic img, .movpic img').first().attr('src') ||
            $('.anime_pic img, .movpic img').first().attr('data-src'),
          url,
        ) ?? base.metadata.poster;

      let status: string | undefined;
      let totalEps = 0;
      $('.anime_data li').each((_, el) => {
        const text = $(el).text().replace(/\s+/g, ' ').trim();
        const [k, ...rest] = text.split(':');
        const val = rest.join(':').trim();
        if (!k || !val) return;
        const kl = k.toLowerCase();
        if (kl.startsWith('estado') && !status) status = val;
        if (kl.startsWith('episodios') && !totalEps) {
          const parsed = parseInt(val, 10);
          if (!Number.isNaN(parsed)) totalEps = parsed;
        }
      });

      const uepHref = resolveUrl($('a#uep').attr('href'), url);
      const uepNumMatch = uepHref?.match(/\/(\d+)\/?$/);
      const uepNum = uepNumMatch ? parseInt(uepNumMatch[1], 10) : 0;
      const maxEp = Math.min(2000, Math.max(totalEps, uepNum));
      const slug = url.pathname.replace(/^\/+|\/+$/g, '').split('/')[0] ?? '';

      const pages: PageLink[] = [];
      if (maxEp > 0 && slug) {
        for (let n = maxEp; n >= 1; n--) {
          const epUrl = `https://jkanime.net/${slug}/${n}/`;
          pages.push({
            id: makeMediaId(epUrl),
            url: epUrl,
            title: `Capítulo ${n}`,
            subtitle: `EP ${n}`,
            thumbnail: posterImg,
          });
        }
      } else if (uepHref) {
        pages.push({
          id: makeMediaId(uepHref),
          url: uepHref,
          title: 'Episodio 1',
          subtitle: 'EP 1',
          thumbnail: posterImg,
        });
      }

      return {
        ...base,
        adapter: this.name,
        metadata: {
          ...base.metadata,
          title,
          description: synopsis,
          poster: posterImg,
          status,
        },
        videos: [],
        pdfs: [],
        pages,
      };
    }

    // 3. Catalog: Directory / Home / Search
    const pagesMap = new Map<string, PageLink>();
    let nextPageUrl: string | undefined;

    const dirMatch = html.match(/var\s+animes\s*=\s*(\{[\s\S]*?\})\s*;/);
    if (dirMatch?.[1]) {
      try {
        const payload = JSON.parse(dirMatch[1]) as {
          data?: Array<{
            title?: string;
            image?: string;
            url?: string;
            estado?: string;
            tipo?: string;
          }>;
          next_page_url?: string;
        };
        if (payload.next_page_url) {
          nextPageUrl = resolveUrl(payload.next_page_url, url) ?? undefined;
        }
        for (const item of payload.data ?? []) {
          const href = resolveUrl(item.url, url);
          const itemTitle = item.title?.trim();
          if (!href || !itemTitle || pagesMap.has(href)) continue;
          pagesMap.set(href, {
            id: makeMediaId(href),
            url: href,
            title: itemTitle,
            subtitle: [item.tipo, item.estado].filter(Boolean).join(' • ') || undefined,
            thumbnail: item.image,
          });
        }
      } catch {
        // ignore
      }
    }

    for (const paneSel of ['#animes .card a[href]', '#donghuas .card a[href]', '#ovas .card a[href]']) {
      $(paneSel).each((_, el) => {
        const $a = $(el);
        const href = resolveUrl($a.attr('href'), url);
        if (!href || pagesMap.has(href) || href === url.toString()) return;
        const $img = $a.find('img').first();
        const thumb =
          resolveUrl(
            $img.attr('data-animepic') || $img.attr('data-src') || $img.attr('src'),
            url,
          ) ?? undefined;
        const itemTitle =
          $a.find('.card-title, h5').first().text().replace(/\s+/g, ' ').trim() ||
          $img.attr('alt')?.trim();
        if (!itemTitle) return;
        const epBadge = $a.find('.badge-primary').first().text().trim() || undefined;
        const group = $a.find('.badge-secondary').first().text().trim() || undefined;
        pagesMap.set(href, {
          id: makeMediaId(href),
          url: href,
          title: itemTitle,
          subtitle: epBadge,
          thumbnail: thumb,
          group,
        });
      });
    }

    $('.anime__item').each((_, el) => {
      const $item = $(el);
      const href = resolveUrl($item.find('a[href]').first().attr('href'), url);
      if (!href || pagesMap.has(href) || href === url.toString()) return;
      try {
        const parsed = new URL(href);
        if (!this.canHandle(parsed) || isReservedJkPath(parsed.pathname)) return;
      } catch {
        return;
      }
      const thumb =
        resolveUrl($item.find('.anime__item__pic').attr('data-setbg'), url) ??
        resolveUrl($item.find('img').attr('src'), url) ??
        undefined;
      const itemTitle = $item
        .find('.anime__item__text h5 a, h5 a, h5')
        .first()
        .text()
        .replace(/\s+/g, ' ')
        .trim();
      if (!itemTitle) return;
      pagesMap.set(href, {
        id: makeMediaId(href),
        url: href,
        title: itemTitle,
        thumbnail: thumb,
      });
    });

    if (!nextPageUrl) {
      nextPageUrl =
        resolveUrl(
          $('a[rel="next"], a.page-link[rel="next"], a.next').first().attr('href'),
          url,
        ) ?? undefined;
    }

    return {
      ...base,
      adapter: this.name,
      videos: [],
      pdfs: [],
      pages: Array.from(pagesMap.values()),
      nextPageUrl,
    };
  },
};
