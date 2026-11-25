import { Platform } from 'react-native';
import type { ExtractionResult } from '../types';

const DEFAULT_TIMEOUT_MS = 22_000;
const HEALTH_TIMEOUT_MS = 7_000;
const MOBILE_CHROME_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';

// Hosts that block cloud datacenter IPs (like Railway) with HTTP 403 but allow normal residential/mobile IPs
const clientDirectHosts = new Set<string>(['jkanime.net']);

function getHostnameSafe(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function shouldPreferDeviceFetch(rawUrl: string): boolean {
  if (Platform.OS === 'web') return false;
  const host = getHostnameSafe(rawUrl);
  if (!host) return false;
  for (const h of clientDirectHosts) {
    if (host === h || host.endsWith(`.${h}`)) return true;
  }
  return false;
}

export function normalizeBackendUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('Tiempo de espera agotado. Verifica la conexión con el servidor.');
    }
    throw new Error('No se pudo conectar con el servidor. Verifica la URL y tu internet.');
  } finally {
    clearTimeout(timer);
  }
}

async function parseJsonSafe<T>(res: Response): Promise<T | null> {
  try {
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export function buildProxyUrl(
  backendUrl: string,
  targetUrl: string,
  referer?: string,
  pin?: string,
): string {
  const base = normalizeBackendUrl(backendUrl);
  const params = new URLSearchParams({ url: targetUrl });
  if (referer) {
    params.set('referer', referer);
  }
  if (pin) {
    params.set('pin', pin);
  }
  return `${base}/api/proxy?${params.toString()}`;
}

export interface BackendHealthResult {
  ok: boolean;
  engine?: string;
  requiresPin?: boolean;
  pinValid?: boolean;
  latencyMs?: number;
  version?: string;
  error?: string;
}

export async function checkBackendHealth(
  backendUrl: string,
  pin?: string,
): Promise<BackendHealthResult> {
  const start = Date.now();
  try {
    const base = normalizeBackendUrl(backendUrl);
    if (!base) {
      return { ok: false, error: 'Ingresa una URL válida.' };
    }
    const res = await fetchWithTimeout(`${base}/health`, { method: 'GET' }, HEALTH_TIMEOUT_MS);
    const latencyMs = Date.now() - start;
    if (!res.ok) {
      return { ok: false, latencyMs, error: `El servidor respondió HTTP ${res.status}` };
    }
    const data = await parseJsonSafe<{
      ok?: boolean;
      engine?: string;
      requiresPin?: boolean;
      version?: string;
    }>(res);
    if (!data?.ok) {
      return { ok: false, latencyMs, error: 'Respuesta inesperada del servidor.' };
    }

    if (data.requiresPin) {
      const headers: Record<string, string> = {};
      if (pin?.trim()) headers['x-access-pin'] = pin.trim();
      const pingRes = await fetchWithTimeout(
        `${base}/api/ping`,
        { method: 'GET', headers },
        HEALTH_TIMEOUT_MS,
      );
      return {
        ok: true,
        engine: data.engine,
        requiresPin: true,
        pinValid: pingRes.ok,
        latencyMs,
        version: data.version,
        error: pingRes.ok ? undefined : 'El servidor requiere un PIN válido.',
      };
    }

    return {
      ok: true,
      engine: data.engine,
      requiresPin: false,
      pinValid: true,
      latencyMs,
      version: data.version,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'No se pudo conectar con el servidor.',
    };
  }
}

async function extractViaDeviceFetch(
  base: string,
  targetUrl: string,
  headers: Record<string, string>,
): Promise<ExtractionResult> {
  const pageRes = await fetchWithTimeout(
    targetUrl,
    {
      method: 'GET',
      headers: {
        'User-Agent': MOBILE_CHROME_UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
      },
    },
    16_000,
  );
  if (!pageRes.ok) {
    throw new Error(`La página respondió con HTTP ${pageRes.status}`);
  }
  const html = await pageRes.text();
  const effectiveUrl = pageRes.url || targetUrl;

  const parseRes = await fetchWithTimeout(`${base}/api/extract`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ url: effectiveUrl, html }),
  });
  const parsed = await parseJsonSafe<ExtractionResult & { error?: string }>(parseRes);
  if (!parseRes.ok || !parsed) {
    throw new Error(parsed?.error || `Error procesando página (${parseRes.status})`);
  }
  return parsed;
}

export async function extractMediaFromUrl(
  backendUrl: string,
  targetUrl: string,
  opts?: { refresh?: boolean; pin?: string },
): Promise<ExtractionResult> {
  const base = normalizeBackendUrl(backendUrl);
  const cleanUrl = targetUrl.trim();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts?.pin) headers['x-access-pin'] = opts.pin;

  if (shouldPreferDeviceFetch(cleanUrl)) {
    try {
      return await extractViaDeviceFetch(base, cleanUrl, headers);
    } catch {
      // Fall back to backend extraction if direct fetch fails
    }
  }

  const res = await fetchWithTimeout(`${base}/api/extract`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ url: cleanUrl, refresh: Boolean(opts?.refresh) }),
  });

  const data = await parseJsonSafe<ExtractionResult & { error?: string }>(res);
  if (!res.ok || !data) {
    const errMsg = data?.error || `Error del servidor (${res.status})`;
    if (Platform.OS !== 'web' && /\b(403|503)\b/.test(errMsg)) {
      const host = getHostnameSafe(cleanUrl);
      if (host) clientDirectHosts.add(host);
      return extractViaDeviceFetch(base, cleanUrl, headers);
    }
    throw new Error(errMsg);
  }

  return data;
}

export type SearchSourceFilter =
  | 'all'
  | 'animeflv'
  | 'jkanime'
  | 'hackstore'
  | 'leercapitulo'
  | 'ext_comic';

export async function globalSearchMedia(
  backendUrl: string,
  query: string,
  pin?: string,
  source: SearchSourceFilter = 'all',
): Promise<ExtractionResult> {
  const base = normalizeBackendUrl(backendUrl);
  const headers: Record<string, string> = {};
  if (pin) headers['x-access-pin'] = pin;

  const params = new URLSearchParams({ q: query.trim() });
  if (source !== 'all') params.set('source', source);

  const shouldSupplementJk =
    Platform.OS !== 'web' && (source === 'all' || source === 'jkanime');
  const jkSearchPromise = shouldSupplementJk
    ? extractMediaFromUrl(
        backendUrl,
        `https://jkanime.net/buscar/${encodeURIComponent(query.trim())}/`,
        { pin },
      ).catch(() => null)
    : Promise.resolve(null);

  const [res, jkExtra] = await Promise.all([
    fetchWithTimeout(
      `${base}/api/search?${params.toString()}`,
      {
        method: 'GET',
        headers,
      },
      25_000,
    ),
    jkSearchPromise,
  ]);

  const data = await parseJsonSafe<ExtractionResult & { error?: string }>(res);
  if (!res.ok || !data) {
    throw new Error(data?.error || `Error en búsqueda (${res.status})`);
  }

  if (jkExtra && (jkExtra.pages?.length ?? 0) > 0) {
    const existingUrls = new Set((data.pages ?? []).map((p) => p.url));
    const extraPages = (jkExtra.pages ?? [])
      .filter((p) => !existingUrls.has(p.url))
      .map((p) => ({
        ...p,
        source: 'JKAnime',
        subtitle: p.subtitle ? `JKAnime • ${p.subtitle}` : 'JKAnime',
      }));
    if (extraPages.length > 0) {
      data.pages = [...(data.pages ?? []), ...extraPages];
    }
  }

  return data;
}

export interface SubtitleOption {
  url: string;
  label: string;
}

export interface ResolvedVideoResponse {
  streamUrl: string;
  referer?: string;
  mimeType?: string;
  isEmbed: boolean;
  directPlay?: boolean;
  subtitles?: SubtitleOption[];
  unavailableReason?: string;
}

function decodeBase64Ascii(b64: string): string | null {
  try {
    if (typeof globalThis.atob === 'function') {
      return globalThis.atob(b64);
    }
  } catch {
    // ignore
  }
  return null;
}

async function resolveJkPlayerOnDevice(
  backendUrl: string,
  targetUrl: string,
  pin?: string,
): Promise<ResolvedVideoResponse | null> {
  if (Platform.OS === 'web') return null;
  const lower = targetUrl.toLowerCase();
  if (!lower.includes('jkanime.net/jkplayer/')) return null;

  try {
    const res = await fetchWithTimeout(
      targetUrl,
      {
        method: 'GET',
        headers: {
          'User-Agent': MOBILE_CHROME_UA,
          Referer: 'https://jkanime.net/',
          Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
        },
      },
      12_000,
    );
    if (!res.ok) return null;
    const html = (await res.text()).replace(/\\\//g, '/');

    const m3u8Match = html.match(/https?:\/\/[^\s"'<>\\]+\.m3u8[^\s"'<>\\]*/i);
    if (m3u8Match?.[0]) {
      return {
        streamUrl: m3u8Match[0],
        referer: 'https://jkanime.net/',
        mimeType: 'application/x-mpegURL',
        isEmbed: false,
        directPlay: true,
      };
    }

    const atobMatch = html.match(/atob\(\s*['"]([A-Za-z0-9+/=]{24,})['"]\s*\)/i);
    if (atobMatch?.[1]) {
      const decoded = decodeBase64Ascii(atobMatch[1]);
      const innerM3u8 = decoded?.match(/https?:\/\/[^\s"'<>\\]+\.m3u8[^\s"'<>\\]*/i);
      if (innerM3u8?.[0]) {
        return {
          streamUrl: innerM3u8[0],
          referer: 'https://jkanime.net/',
          mimeType: 'application/x-mpegURL',
          isEmbed: false,
          directPlay: true,
        };
      }
    }

    const mp4Match = html.match(/https?:\/\/[^\s"'<>\\]+\.mp4[^\s"'<>\\]*/i);
    if (mp4Match?.[0]) {
      return {
        streamUrl: mp4Match[0],
        referer: 'https://jkanime.net/',
        mimeType: 'video/mp4',
        isEmbed: false,
        directPlay: true,
      };
    }

    const nestedIframe = html.match(/<iframe[^>]+src=["'](https?:\/\/[^"']+)["']/i);
    if (nestedIframe?.[1] && nestedIframe[1] !== targetUrl) {
      return resolveVideoUrl(backendUrl, nestedIframe[1], pin);
    }
  } catch {
    // ignore and fall back
  }
  return null;
}

export async function resolveVideoUrl(
  backendUrl: string,
  targetUrl: string,
  pin?: string,
  refresh = false,
): Promise<ResolvedVideoResponse> {
  const cleanTarget = targetUrl.trim();
  const deviceJk = await resolveJkPlayerOnDevice(backendUrl, cleanTarget, pin);
  if (deviceJk) return deviceJk;

  const base = normalizeBackendUrl(backendUrl);
  const headers: Record<string, string> = {};
  if (pin) headers['x-access-pin'] = pin;

  try {
    const params = new URLSearchParams({ url: targetUrl.trim() });
    if (refresh) params.set('refresh', '1');
    const res = await fetchWithTimeout(
      `${base}/api/resolve?${params.toString()}`,
      { method: 'GET', headers },
      18_000,
    );
    if (!res.ok) {
      return { streamUrl: targetUrl, isEmbed: true };
    }
    const data = await parseJsonSafe<ResolvedVideoResponse>(res);
    return data ?? { streamUrl: targetUrl, isEmbed: true };
  } catch {
    return { streamUrl: targetUrl, isEmbed: true };
  }
}

export async function resolveVideoBatch(
  backendUrl: string,
  urls: string[],
  pin?: string,
): Promise<Record<string, ResolvedVideoResponse>> {
  if (urls.length === 0) return {};
  const limited = urls.slice(0, 10);
  const jkUrls =
    Platform.OS !== 'web'
      ? limited.filter((u) => u.toLowerCase().includes('jkanime.net/jkplayer/'))
      : [];
  const backendUrls =
    jkUrls.length > 0 ? limited.filter((u) => !jkUrls.includes(u)) : limited;

  const base = normalizeBackendUrl(backendUrl);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (pin) headers['x-access-pin'] = pin;

  const backendPromise = (async (): Promise<Record<string, ResolvedVideoResponse>> => {
    if (backendUrls.length === 0) return {};
    try {
      const res = await fetchWithTimeout(
        `${base}/api/resolve-batch`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ urls: backendUrls }),
        },
        12_000,
      );
      if (!res.ok) return {};
      const data = await parseJsonSafe<{ results?: Record<string, ResolvedVideoResponse> }>(res);
      return data?.results ?? {};
    } catch {
      return {};
    }
  })();

  const jkPromise = Promise.all(
    jkUrls.map(async (u) => {
      const resolved = await resolveJkPlayerOnDevice(backendUrl, u, pin);
      return [u, resolved ?? { streamUrl: u, isEmbed: true }] as const;
    }),
  );

  const [backendMap, jkEntries] = await Promise.all([backendPromise, jkPromise]);
  return {
    ...backendMap,
    ...Object.fromEntries(jkEntries),
  };
}

export interface DownloadJobStatus {
  jobId: string;
  status: 'preparing' | 'ready' | 'error';
  progress: number;
  sizeBytes?: number;
  filename: string;
  error?: string;
}

export function buildDirectDownloadUrl(
  backendUrl: string,
  streamUrl: string,
  filename: string,
  referer?: string,
  pin?: string,
): string {
  const base = normalizeBackendUrl(backendUrl);
  const params = new URLSearchParams({
    url: streamUrl,
    filename,
  });
  if (referer) params.set('referer', referer);
  if (pin) params.set('pin', pin);
  return `${base}/api/download?${params.toString()}`;
}

export async function startDownloadJob(
  backendUrl: string,
  streamUrl: string,
  filename: string,
  referer?: string,
  pin?: string,
): Promise<DownloadJobStatus> {
  const base = normalizeBackendUrl(backendUrl);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (pin) headers['x-access-pin'] = pin;

  const res = await fetchWithTimeout(
    `${base}/api/download-job`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ url: streamUrl, referer, filename }),
    },
    20_000,
  );
  const data = await parseJsonSafe<DownloadJobStatus & { error?: string }>(res);
  if (!res.ok || !data?.jobId) {
    throw new Error(data?.error || `No se pudo iniciar la preparación (${res.status})`);
  }
  return data;
}

export async function getDownloadJobStatus(
  backendUrl: string,
  jobId: string,
  pin?: string,
): Promise<DownloadJobStatus> {
  const base = normalizeBackendUrl(backendUrl);
  const headers: Record<string, string> = {};
  if (pin) headers['x-access-pin'] = pin;

  const res = await fetchWithTimeout(
    `${base}/api/download-job/${encodeURIComponent(jobId)}/status`,
    { method: 'GET', headers },
    15_000,
  );
  const data = await parseJsonSafe<DownloadJobStatus & { error?: string }>(res);
  if (!res.ok || !data) {
    throw new Error(data?.error || `Error consultando progreso (${res.status})`);
  }
  return data;
}

export async function cancelDownloadJob(
  backendUrl: string,
  jobId: string,
  pin?: string,
): Promise<void> {
  const base = normalizeBackendUrl(backendUrl);
  const headers: Record<string, string> = {};
  if (pin) headers['x-access-pin'] = pin;
  try {
    await fetchWithTimeout(
      `${base}/api/download-job/${encodeURIComponent(jobId)}`,
      { method: 'DELETE', headers },
      8_000,
    );
  } catch {
    // ignore cleanup errors
  }
}

export function buildDownloadJobFileUrl(
  backendUrl: string,
  jobId: string,
  filename: string,
  pin?: string,
): string {
  const base = normalizeBackendUrl(backendUrl);
  const params = new URLSearchParams({ filename });
  if (pin) params.set('pin', pin);
  return `${base}/api/download-job/${encodeURIComponent(jobId)}/file?${params.toString()}`;
}
