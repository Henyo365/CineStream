export interface SourceSection {
  label: string;
  url: string;
}

export interface FixedSource {
  id: string;
  name: string;
  url: string;
  searchUrlTemplate?: string;
  description: string;
  color: string;
  kind?: 'video' | 'manga';
  hidden?: boolean;
  sections?: SourceSection[];
  genres?: SourceSection[];
}

// Runtime XOR decoder (key 0x5A) — prevents plaintext domain, paths, or unlock code in APK bundle strings
const K = 0x5a;
function dec(bytes: readonly number[]): string {
  return String.fromCharCode(...bytes.map((b) => b ^ K));
}

const V_HOST = [46, 55, 53, 50, 63, 52, 46, 59, 51, 116, 59, 42, 42] as const;
const V_NAME = [14, 23, 21, 122, 113] as const;
const V_BIB = [117, 56, 51, 56, 54, 51, 53, 46, 63, 57, 59] as const;
const V_COMICS = [117, 57, 53, 55, 51, 57, 41] as const;
const V_Q_DOU = [101, 46, 35, 42, 63, 103, 62, 53, 47, 48, 51, 52, 41, 50, 51] as const;
const V_Q_UNC = [101, 57, 53, 52, 46, 63, 52, 46, 103, 47, 52, 57, 63, 52, 41, 53, 40, 63, 62] as const;
const V_Q_VAN = [101, 57, 53, 52, 46, 63, 52, 46, 103, 44, 59, 52, 51, 54, 54, 59] as const;
const V_Q_YUR = [101, 46, 59, 61, 103, 35, 47, 40, 51] as const;
const V_Q_YAO = [101, 46, 59, 61, 103, 35, 59, 53, 51] as const;
const V_CODE = [121, 98, 108, 108, 110, 121] as const;

export function verifyVaultCode(input: string): boolean {
  const clean = input.trim();
  if (clean.length !== V_CODE.length) return false;
  let diff = 0;
  for (let i = 0; i < V_CODE.length; i++) {
    diff |= (clean.charCodeAt(i) ^ K) ^ V_CODE[i];
  }
  return diff === 0;
}

export function isVaultUrl(rawUrl: string | undefined): boolean {
  if (!rawUrl) return false;
  const host = dec(V_HOST);
  return rawUrl.toLowerCase().includes(host);
}

export function buildVaultSource(): FixedSource {
  const host = dec(V_HOST);
  const base = `https://${host}`;
  const bib = `${base}${dec(V_BIB)}`;
  return {
    id: 'ext_comic',
    name: dec(V_NAME),
    url: `${base}/`,
    searchUrlTemplate: `${bib}?title={q}`,
    description: 'Biblioteca privada en cascada sin anuncios',
    color: '#ec4899',
    kind: 'manga',
    hidden: true,
    sections: [
      { label: 'Recientes', url: `${base}/` },
      { label: 'Biblioteca', url: bib },
      { label: 'Especiales', url: `${bib}${dec(V_Q_DOU)}` },
      { label: 'Comics', url: `${base}${dec(V_COMICS)}` },
      { label: 'Sin filtro', url: `${bib}${dec(V_Q_UNC)}` },
      { label: 'Romántico', url: `${bib}${dec(V_Q_VAN)}` },
      { label: 'GL', url: `${bib}${dec(V_Q_YUR)}` },
      { label: 'BL', url: `${bib}${dec(V_Q_YAO)}` },
    ],
  };
}

export const FIXED_SOURCES: FixedSource[] = [
  {
    id: 'animeflv',
    name: 'AnimeFLV',
    url: 'https://animeflv.or.at/',
    searchUrlTemplate: 'https://animeflv.or.at/?s={q}',
    description: 'Catálogo de episodios, animes en emisión y servidores HD sin anuncios',
    color: '#38bdf8',
    kind: 'video',
    sections: [
      { label: 'Últimos', url: 'https://animeflv.or.at/' },
      { label: 'Directorio', url: 'https://animeflv.or.at/anime/' },
    ],
  },
  {
    id: 'jkanime',
    name: 'JKAnime',
    url: 'https://jkanime.net/',
    searchUrlTemplate: 'https://jkanime.net/buscar/{q}/',
    description: 'Animes, donghuas, películas y servidores JKPlayer HD sin anuncios',
    color: '#10b981',
    kind: 'video',
    sections: [
      { label: 'Últimos', url: 'https://jkanime.net/' },
      { label: 'Directorio', url: 'https://jkanime.net/directorio' },
      { label: 'En Emisión', url: 'https://jkanime.net/directorio?estado=emision' },
      { label: 'Películas', url: 'https://jkanime.net/directorio?tipo=peliculas' },
      { label: 'Top', url: 'https://jkanime.net/top' },
    ],
    genres: [
      { label: 'Acción', url: 'https://jkanime.net/genero/accion/' },
      { label: 'Aventura', url: 'https://jkanime.net/genero/aventura/' },
      { label: 'Comedia', url: 'https://jkanime.net/genero/comedia/' },
      { label: 'Drama', url: 'https://jkanime.net/genero/drama/' },
      { label: 'Fantasía', url: 'https://jkanime.net/genero/fantasia/' },
      { label: 'Romance', url: 'https://jkanime.net/genero/romance/' },
      { label: 'Ciencia Ficción', url: 'https://jkanime.net/genero/ciencia-ficcion/' },
      { label: 'Shounen', url: 'https://jkanime.net/genero/shounen/' },
      { label: 'Seinen', url: 'https://jkanime.net/genero/seinen/' },
    ],
  },
  {
    id: 'hackstore',
    name: 'Hackstore',
    url: 'https://www.hackstore.fo/',
    searchUrlTemplate: 'https://www.hackstore.fo/?s={q}',
    description: 'Películas, series y animes en HD con géneros y recomendados',
    color: '#ef4444',
    kind: 'video',
    sections: [
      { label: 'Inicio', url: 'https://www.hackstore.fo/' },
      { label: 'Películas', url: 'https://www.hackstore.fo/peliculas/' },
      { label: 'Series', url: 'https://www.hackstore.fo/series/' },
      { label: 'Animes', url: 'https://www.hackstore.fo/animes/' },
      { label: 'Estrenos', url: 'https://www.hackstore.fo/proximos-estrenos-peliculas/' },
    ],
    genres: [
      { label: 'Acción', url: 'https://www.hackstore.fo/genero/accion/' },
      { label: 'Aventura', url: 'https://www.hackstore.fo/genero/aventura/' },
      { label: 'Comedia', url: 'https://www.hackstore.fo/genero/comedia/' },
      { label: 'Drama', url: 'https://www.hackstore.fo/genero/drama/' },
      { label: 'Terror', url: 'https://www.hackstore.fo/genero/terror/' },
      { label: 'Ciencia Ficción', url: 'https://www.hackstore.fo/genero/ciencia-ficcion/' },
      { label: 'Fantasía', url: 'https://www.hackstore.fo/genero/fantasia/' },
      { label: 'Animación', url: 'https://www.hackstore.fo/genero/animacion/' },
      { label: 'Suspenso', url: 'https://www.hackstore.fo/genero/suspenso/' },
    ],
  },
  {
    id: 'leercapitulo',
    name: 'LeerCapitulo',
    url: 'https://www.leercapitulo.co/',
    searchUrlTemplate: 'https://www.leercapitulo.co/manga/?q={q}',
    description: 'Mangas, manhwas y manhuas en español en cascada vertical sin anuncios',
    color: '#f59e0b',
    kind: 'manga',
    sections: [
      { label: 'Inicio', url: 'https://www.leercapitulo.co/' },
      { label: 'Catálogo', url: 'https://www.leercapitulo.co/manga/' },
      { label: 'Manhwa', url: 'https://www.leercapitulo.co/manga/?type=manhwa' },
      { label: 'Manga', url: 'https://www.leercapitulo.co/manga/?type=manga' },
      { label: 'Manhua', url: 'https://www.leercapitulo.co/manga/?type=manhua' },
      { label: 'En Emisión', url: 'https://www.leercapitulo.co/manga/?status=ongoing' },
    ],
    genres: [
      { label: 'Acción', url: 'https://www.leercapitulo.co/manga/?genre=action' },
      { label: 'Aventura', url: 'https://www.leercapitulo.co/manga/?genre=adventure' },
      { label: 'Fantasía', url: 'https://www.leercapitulo.co/manga/?genre=fantasy' },
      { label: 'Romance', url: 'https://www.leercapitulo.co/manga/?genre=romance' },
      { label: 'Comedia', url: 'https://www.leercapitulo.co/manga/?genre=comedy' },
      { label: 'Isekai', url: 'https://www.leercapitulo.co/manga/?genre=isekai' },
      { label: 'Artes Marciales', url: 'https://www.leercapitulo.co/manga/?genre=artes-marciales' },
      { label: 'Shounen', url: 'https://www.leercapitulo.co/manga/?genre=shounen' },
      { label: 'Seinen', url: 'https://www.leercapitulo.co/manga/?genre=seinen' },
      { label: 'Sobrenatural', url: 'https://www.leercapitulo.co/manga/?genre=sobrenatural' },
    ],
  },
];
