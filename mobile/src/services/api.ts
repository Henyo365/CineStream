import type { ExtractionResult } from '../types';

export function normalizeBackendUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}

export function buildProxyUrl(backendUrl: string, targetUrl: string, referer?: string): string {
  const base = normalizeBackendUrl(backendUrl);
  const params = new URLSearchParams({ url: targetUrl });
  if (referer) {
    params.set('referer', referer);
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
): Promise<ExtractionResult> {
  const base = normalizeBackendUrl(backendUrl);
  const res = await fetch(`${base}/api/extract`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: targetUrl.trim() }),
  });

  const data = (await res.json()) as ExtractionResult & { error?: string };
  if (!res.ok) {
    throw new Error(data.error || `Error del servidor (${res.status})`);
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
): Promise<ResolvedVideoResponse> {
  const base = normalizeBackendUrl(backendUrl);
  const res = await fetch(
    `${base}/api/resolve?url=${encodeURIComponent(targetUrl.trim())}`,
    { method: 'GET' },
  );
  if (!res.ok) {
    return { streamUrl: targetUrl, isEmbed: true };
  }
  return (await res.json()) as ResolvedVideoResponse;
}
