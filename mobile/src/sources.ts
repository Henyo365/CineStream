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
  genres?: SourceSection[];
}

export const FIXED_SOURCES: FixedSource[] = [
  {
    id: 'animeflv',
    name: 'AnimeFLV',
    url: 'https://animeflv.or.at/',
    searchUrlTemplate: 'https://animeflv.or.at/?s={q}',
    description: 'Catálogo de episodios, animes en emisión y servidores HD sin anuncios',
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
    description: 'Películas, series y animes en HD con géneros y recomendados',
    color: '#ef4444',
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
];
