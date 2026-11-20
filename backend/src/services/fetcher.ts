const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export interface FetchedPage {
  finalUrl: URL;
  contentType: string;
  html?: string;
}

export async function fetchTargetPage(targetUrl: URL): Promise<FetchedPage> {
  const response = await fetch(targetUrl.toString(), {
    headers: {
      'User-Agent': DEFAULT_USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    throw new Error(`La página respondió con HTTP ${response.status} ${response.statusText}`);
  }

  const finalUrl = new URL(response.url || targetUrl.toString());
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? 'text/html';

  if (
    contentType.includes('text/html') ||
    contentType.includes('application/xhtml+xml') ||
    contentType.includes('text/plain')
  ) {
    const html = await response.text();
    return { finalUrl, contentType, html };
  }

  // Cancel body stream if it's a direct binary file (pdf/video/image)
  await response.body?.cancel();
  return { finalUrl, contentType };
}
