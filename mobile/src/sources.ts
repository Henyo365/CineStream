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
  sections?: SourceSection[];
}

export const FIXED_SOURCES: FixedSource[] = [
  {
    id: 'animeflv',
    name: 'AnimeFLV',
    url: 'https://animeflv.or.at/',
    searchUrlTemplate: 'https://animeflv.or.at/?s={q}',
    description: 'Catálogo de episodios, series y reproductores sin anuncios',
    color: '#38bdf8',
    sections: [
      { label: 'Últimos', url: 'https://animeflv.or.at/' },
      { label: 'Directorio', url: 'https://animeflv.or.at/anime/' },
    ],
  },
  {
    id: 'hackstore',
    name: 'Hackstore',
    url: 'https://www.hackstore.fo/',
    searchUrlTemplate: 'https://www.hackstore.fo/?s={q}',
    description: 'Películas, series y animes en HD con reproductor directo',
    color: '#ef4444',
    sections: [
      { label: 'Inicio', url: 'https://www.hackstore.fo/' },
      { label: 'Películas', url: 'https://www.hackstore.fo/peliculas/' },
      { label: 'Series', url: 'https://www.hackstore.fo/series/' },
      { label: 'Animes', url: 'https://www.hackstore.fo/animes/' },
    ],
  },
  {
    id: 'lectortmo',
    name: 'LectorTMO',
    url: 'https://lectortmo.vip/',
    searchUrlTemplate: 'https://lectortmo.vip/manga/?s={q}',
    description: 'Lector de mangas, manhwas y cómics en cascada vertical',
    color: '#a855f7',
    sections: [
      { label: 'Inicio', url: 'https://lectortmo.vip/' },
      { label: 'Biblioteca', url: 'https://lectortmo.vip/manga/' },
    ],
  },
];
