import type { ExtractionResult } from '../types';

export function normalizeBackendUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
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

export async function checkBackendHealth(backendUrl: string): Promise<boolean> {
  try {
    const base = normalizeBackendUrl(backendUrl);
    const res = await fetch(`${base}/health`, { method: 'GET' });
    if (!res.ok) return false;
    const data = (await res.json()) as { ok?: boolean };
    return Boolean(data.ok);
  } catch {
    return false;
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

  const res = await fetch(`${base}/api/extract`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ url: targetUrl.trim(), refresh: Boolean(opts?.refresh) }),
  });

  const data = (await res.json()) as ExtractionResult & { error?: string };
  if (!res.ok) {
    throw new Error(data.error || `Error del servidor (${res.status})`);
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

  const res = await fetch(`${base}/api/search?q=${encodeURIComponent(query.trim())}`, {
    method: 'GET',
    headers,
  });

  const data = (await res.json()) as ExtractionResult & { error?: string };
  if (!res.ok) {
    throw new Error(data.error || `Error en búsqueda (${res.status})`);
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

  const res = await fetch(
    `${base}/api/resolve?url=${encodeURIComponent(targetUrl.trim())}`,
    { method: 'GET', headers },
  );
  if (!res.ok) {
    return { streamUrl: targetUrl, isEmbed: true };
  }
  return (await res.json()) as ResolvedVideoResponse;
}
