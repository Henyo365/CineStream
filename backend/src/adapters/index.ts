import type { ExtractionResult, ExtractorAdapter } from '../types.js';
import { animeflvAdapter } from './animeflv.js';
import { exampleSiteAdapter } from './exampleSite.js';
import { genericAdapter } from './generic.js';
import { hackstoreAdapter } from './hackstore.js';
import { lectortmoAdapter } from './lectortmo.js';

// Registra aquí tus adaptadores específicos antes del adaptador genérico
const adapters: ExtractorAdapter[] = [
  animeflvAdapter,
  hackstoreAdapter,
  lectortmoAdapter,
  exampleSiteAdapter,
  genericAdapter,
];

export function extractFromHtml(url: URL, html: string): ExtractionResult {
  const adapter = adapters.find((a) => a.canHandle(url)) ?? genericAdapter;
  return adapter.extract(url, html);
}

export function listAdapters(): string[] {
  return adapters.map((a) => a.name);
}
