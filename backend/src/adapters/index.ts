import type { ExtractionResult, ExtractorAdapter } from '../types.js';
import { animeflvAdapter } from './animeflv.js';
import { exampleSiteAdapter } from './exampleSite.js';
import { extComicAdapter } from './extComic.js';
import { genericAdapter } from './generic.js';
import { hackstoreAdapter } from './hackstore.js';
import { jkanimeAdapter } from './jkanime.js';
import { leercapituloAdapter } from './leercapitulo.js';

// Registra aquí tus adaptadores específicos antes del adaptador genérico
const adapters: ExtractorAdapter[] = [
  animeflvAdapter,
  jkanimeAdapter,
  hackstoreAdapter,
  leercapituloAdapter,
  extComicAdapter,
  exampleSiteAdapter,
  genericAdapter,
];

export function extractFromHtml(url: URL, html: string): ExtractionResult {
  const adapter = adapters.find((a) => a.canHandle(url)) ?? genericAdapter;
  return adapter.extract(url, html);
}

export function listAdapters(): string[] {
  return adapters.filter((a) => a.name !== 'ext-comic').map((a) => a.name);
}
