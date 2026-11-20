# CineStream v2.0.0

Aplicación personal para ver **animes, películas y series** en HD desde Android o Web, impulsada por un **motor nativo en Rust** (`cinestream-engine`) de alto rendimiento para búsqueda inteligente, extracción paralela, verificación de servidores y proxy streaming sin anuncios.

## Novedades v2.0.0

- **Motor nativo en Rust (`rust-engine/`)**:
  - Construido con **Axum + Tokio + Reqwest (HTTP/2 + rustls) + Scraper (HTML5) + Moka Cache**.
  - **Búsqueda inteligente en paralelo (`/api/search`)**: consulta AnimeFLV y Hackstore simultáneamente, normaliza acentos y ordena los resultados por relevancia difusa (*Jaro-Winkler + coincidencia exacta/prefijo/tokens*).
  - **Verificación paralela de servidores (`/api/resolve-batch`)**: prueba hasta 6 servidores en paralelo antes de reproducir para resaltar cuáles son **HD Nativo**, cuáles incluyen subtítulos CC y cuáles están caídos, con botón de **1 toque "Reproducir mejor servidor HD"**.
  - **Proxy streaming zero-copy (`/api/proxy`)** con reescritura HLS ordenada por mayor bitrate, reenvío de `Range`, caché de imágenes y protección SSRF IPv4/IPv6.
- **AnimeFLV y Hackstore mejorados** (se eliminó la sección de mangas para enfocar la app 100% en video):
  - **AnimeFLV**: extrae puntuación (`★ Rating`), géneros, estado, sinopsis, episodios y servidores nativos.
  - **Hackstore**: nueva sección **Estrenos**, **Explorador de Géneros** (`Acción`, `Terror`, `Comedia`, `Ciencia Ficción`, `Fantasía`, `Animación`, etc.), año, duración, **backdrop HD de TMDB**, géneros clicables y carrusel de **Similares y recomendados**.
- **Nuevas funciones en la App**:
  - Botón **Sorpresa (`🎲`)** para elegir qué ver al azar del catálogo actual.
  - **Búsquedas recientes** guardadas localmente + filtros por fuente (`Todos`, `AnimeFLV`, `Hackstore`) en resultados globales.
  - Márgenes seguros corregidos para barra de navegación y barra de estado de Android, doble toque ±10s, bloqueo de pantalla y salto de intro (+85s).

## Ejecución local

### 1. Motor Rust (Backend)
```bash
pnpm dev:backend
```

### 2. App Móvil y Web
```bash
pnpm dev:mobile   # Expo Go
pnpm dev:web      # Navegador Web
```

### 3. Tests (Rust + Node)
```bash
pnpm test
```

## Despliegue en Railway (Docker multi-stage: Rust + Expo Web)

El repositorio incluye [Dockerfile](Dockerfile) y [railway.json](railway.json) listos para Railway:
1. Compila `cinestream-engine` en Rust (`--release`).
2. Exporta la app Web de Expo a `/app/public`.
3. Arranca una imagen ligera Debian con el binario de Rust sirviendo tanto la API como la app Web.

## Compilar APK Android

```bash
cd mobile
eas build -p android --profile preview
```
