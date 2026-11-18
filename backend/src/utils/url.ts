import crypto from 'node:crypto';
import net from 'node:net';

const PRIVATE_IPV4_PREFIXES = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
  /^172\.(1[6-9]|2\d|3[0-1])\./,
];

/**
 * Validates that a URL is http(s) and not targeting private/loopback addresses
 * unless ALLOW_PRIVATE_NETWORKS=true is set.
 */
export function validateTargetUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new Error('URL inválida. Asegúrate de incluir http:// o https://');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Solo se permiten URLs http:// o https://');
  }

  const allowPrivate = process.env.ALLOW_PRIVATE_NETWORKS === 'true';
  if (!allowPrivate) {
    const hostname = parsed.hostname.toLowerCase();
    if (
      hostname === 'localhost' ||
      hostname === '::1' ||
      hostname.endsWith('.local') ||
      (net.isIPv4(hostname) && PRIVATE_IPV4_PREFIXES.some((rx) => rx.test(hostname)))
    ) {
      throw new Error('No se permiten direcciones locales o privadas');
    }
  }

  return parsed;
}

/**
 * Resolves a potentially relative URL against a base URL.
 * Returns null if the input is empty, a javascript: URI, or invalid.
 */
export function resolveUrl(raw: string | undefined | null, base: URL): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (
    !trimmed ||
    trimmed.startsWith('javascript:') ||
    trimmed.startsWith('mailto:') ||
    trimmed.startsWith('tel:') ||
    trimmed.startsWith('data:image/svg+xml')
  ) {
    return null;
  }

  // Skip tiny inline data URIs (often 1x1 tracking pixels or placeholders)
  if (trimmed.startsWith('data:') && trimmed.length < 256) {
    return null;
  }

  try {
    return new URL(trimmed, base).toString();
  } catch {
    return null;
  }
}

/**
 * Extracts the highest-resolution URL from an HTML srcset attribute.
 */
export function pickBestFromSrcset(srcset: string | undefined, base: URL): string | null {
  if (!srcset) return null;
  const candidates = srcset
    .split(',')
    .map((entry) => {
      const parts = entry.trim().split(/\s+/);
      const url = resolveUrl(parts[0], base);
      const descriptor = parts[1] ?? '';
      const weight = descriptor.endsWith('w')
        ? parseInt(descriptor, 10) || 0
        : descriptor.endsWith('x')
          ? (parseFloat(descriptor) || 1) * 1000
          : 0;
      return { url, weight };
    })
    .filter((c): c is { url: string; weight: number } => Boolean(c.url));

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.weight - a.weight);
  return candidates[0].url;
}

export function makeMediaId(url: string): string {
  return crypto.createHash('sha1').update(url).digest('hex').slice(0, 12);
}

export function extractFilename(urlStr: string): string | undefined {
  try {
    const pathname = new URL(urlStr).pathname;
    const last = pathname.split('/').filter(Boolean).pop();
    return last ? decodeURIComponent(last) : undefined;
  } catch {
    return undefined;
  }
}
