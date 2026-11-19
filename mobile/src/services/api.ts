import type { ExtractionResult } from '../types';

const DEFAULT_TIMEOUT_MS = 22_000;
const HEALTH_TIMEOUT_MS = 7_000;

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
        requiresPin: true,
        pinValid: pingRes.ok,
        latencyMs,
        version: data.version,
        error: pingRes.ok ? undefined : 'El servidor requiere un PIN válido.',
      };
    }

    return {
      ok: true,
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

export async function extractMediaFromUrl(
  backendUrl: string,
  targetUrl: string,
  opts?: { refresh?: boolean; pin?: string },
): Promise<ExtractionResult> {
  const base = normalizeBackendUrl(backendUrl);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts?.pin) headers['x-access-pin'] = opts.pin;

  const res = await fetchWithTimeout(`${base}/api/extract`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ url: targetUrl.trim(), refresh: Boolean(opts?.refresh) }),
  });

  const data = await parseJsonSafe<ExtractionResult & { error?: string }>(res);
  if (!res.ok || !data) {
    throw new Error(data?.error || `Error del servidor (${res.status})`);
  }

  return data;
}

export async function globalSearchMedia(
  backendUrl: string,
  query: string,
  pin?: string,
): Promise<ExtractionResult> {
  const base = normalizeBackendUrl(backendUrl);
  const headers: Record<string, string> = {};
  if (pin) headers['x-access-pin'] = pin;

  const res = await fetchWithTimeout(
    `${base}/api/search?q=${encodeURIComponent(query.trim())}`,
    {
      method: 'GET',
      headers,
    },
    25_000,
  );

  const data = await parseJsonSafe<ExtractionResult & { error?: string }>(res);
  if (!res.ok || !data) {
    throw new Error(data?.error || `Error en búsqueda (${res.status})`);
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
  subtitles?: SubtitleOption[];
  unavailableReason?: string;
}

export async function resolveVideoUrl(
  backendUrl: string,
  targetUrl: string,
  pin?: string,
): Promise<ResolvedVideoResponse> {
  const base = normalizeBackendUrl(backendUrl);
  const headers: Record<string, string> = {};
  if (pin) headers['x-access-pin'] = pin;

  try {
    const res = await fetchWithTimeout(
      `${base}/api/resolve?url=${encodeURIComponent(targetUrl.trim())}`,
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
