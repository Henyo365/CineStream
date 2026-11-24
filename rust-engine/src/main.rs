mod adapters;
mod download;
mod proxy;
mod search;
mod types;
mod url_utils;
mod video_resolver;

use crate::download::DownloadManager;
use crate::types::{ExtractionResult, MediaItem, MediaType, PageMetadata, ResolvedVideo};
use crate::url_utils::{extract_filename, make_media_id, validate_target_url};
use axum::extract::{Path, Query, Request, State};
use axum::http::{HeaderValue, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use moka::future::Cache;
use reqwest::Client;
use serde::Deserialize;
use serde_json::json;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tower_http::compression::CompressionLayer;
use tower_http::cors::{Any, CorsLayer};
use tower_http::services::{ServeDir, ServeFile};

const DEFAULT_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

#[derive(Clone)]
struct AppState {
    client: Client,
    extract_cache: Cache<String, ExtractionResult>,
    resolve_cache: Cache<String, ResolvedVideo>,
    access_pin: Arc<String>,
    download_manager: DownloadManager,
}

async fn security_headers_mw(req: Request, next: Next) -> Response {
    let mut res = next.run(req).await;
    let headers = res.headers_mut();
    headers.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    headers.insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    res
}

async fn require_access_pin_mw(
    State(state): State<AppState>,
    req: Request,
    next: Next,
) -> Response {
    if state.access_pin.is_empty() {
        return next.run(req).await;
    }

    let header_pin = req
        .headers()
        .get("x-access-pin")
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());

    let query_pin = req.uri().query().and_then(|q| {
        url::form_urlencoded::parse(q.as_bytes())
            .find(|(k, _)| k == "pin")
            .map(|(_, v)| v.into_owned())
    });

    let provided = header_pin.or(query_pin).unwrap_or_default();
    if provided != *state.access_pin {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "PIN de acceso requerido o incorrecto" })),
        )
            .into_response();
    }

    next.run(req).await
}

async fn fetch_and_extract_uncached(
    client: &Client,
    raw_url: &str,
) -> Result<ExtractionResult, String> {
    let target_url = validate_target_url(raw_url)?;
    let resp = client
        .get(target_url.as_str())
        .header("User-Agent", DEFAULT_UA)
        .header(
            "Accept",
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        )
        .header("Accept-Language", "es-ES,es;q=0.9,en;q=0.8")
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| format!("Error de conexión con la página: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!(
            "La página respondió con HTTP {}",
            resp.status().as_u16()
        ));
    }

    let final_url = resp.url().clone();
    let ct = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("text/html")
        .to_lowercase();

    if ct.contains("text/html") || ct.contains("application/xhtml+xml") || ct.contains("text/plain")
    {
        let html = resp
            .text()
            .await
            .map_err(|e| format!("Error leyendo HTML: {e}"))?;
        return Ok(adapters::extract_from_html(&final_url, &html));
    }

    let url_str = final_url.to_string();
    let filename = extract_filename(&url_str)
        .unwrap_or_else(|| final_url.host_str().unwrap_or("media").to_string());

    let mut result = ExtractionResult {
        adapter: "direct-media".to_string(),
        metadata: PageMetadata {
            title: filename.clone(),
            description: None,
            site_name: final_url.host_str().map(|s| s.to_string()),
            favicon: None,
            poster: None,
            backdrop: None,
            info_url: None,
            status: None,
            rating: None,
            year: None,
            duration: None,
            genres: None,
            source_url: url_str.clone(),
        },
        videos: Vec::new(),
        images: Vec::new(),
        pdfs: Vec::new(),
        pages: Vec::new(),
        related: None,
        next_page_url: None,
    };

    if ct.contains("pdf") {
        result.pdfs.push(MediaItem {
            id: make_media_id(&url_str),
            media_type: MediaType::Pdf,
            url: url_str,
            title: Some(filename),
            thumbnail: None,
            mime_type: Some("application/pdf".to_string()),
            is_embed: None,
            source_tag: Some("direct".to_string()),
        });
    } else if ct.starts_with("video/") {
        result.videos.push(MediaItem {
            id: make_media_id(&url_str),
            media_type: MediaType::Video,
            url: url_str,
            title: Some(filename),
            thumbnail: None,
            mime_type: Some(ct.split(';').next().unwrap_or("video/mp4").to_string()),
            is_embed: Some(false),
            source_tag: Some("direct".to_string()),
        });
    } else if ct.starts_with("image/") {
        result.images.push(MediaItem {
            id: make_media_id(&url_str),
            media_type: MediaType::Image,
            url: url_str,
            title: Some(filename),
            thumbnail: None,
            mime_type: Some(ct.split(';').next().unwrap_or("image/jpeg").to_string()),
            is_embed: None,
            source_tag: Some("direct".to_string()),
        });
    }

    Ok(result)
}

async fn extract_url_cached(
    state: &AppState,
    raw_url: &str,
    bypass_cache: bool,
) -> Result<ExtractionResult, String> {
    let target = validate_target_url(raw_url)?;
    let key = target.to_string();

    if bypass_cache {
        let data = fetch_and_extract_uncached(&state.client, &key).await?;
        state.extract_cache.insert(key, data.clone()).await;
        return Ok(data);
    }

    let client = state.client.clone();
    let key_clone = key.clone();
    state
        .extract_cache
        .try_get_with(key, async move {
            fetch_and_extract_uncached(&client, &key_clone).await
        })
        .await
        .map_err(|arc_err| (*arc_err).clone())
}

async fn health_handler(State(state): State<AppState>) -> impl IntoResponse {
    Json(json!({
        "ok": true,
        "engine": "rust",
        "version": env!("CARGO_PKG_VERSION"),
        "requiresPin": !state.access_pin.is_empty(),
        "adapters": adapters::list_adapters(),
    }))
}

async fn ping_handler() -> impl IntoResponse {
    Json(json!({ "ok": true, "engine": "rust" }))
}

#[derive(Deserialize)]
struct ExtractQuery {
    url: Option<String>,
    refresh: Option<String>,
}

#[derive(Deserialize)]
struct ExtractBody {
    url: Option<String>,
    refresh: Option<bool>,
}

async fn extract_get_handler(
    State(state): State<AppState>,
    Query(q): Query<ExtractQuery>,
) -> Response {
    let raw = match q.url.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(u) => u,
        None => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "Falta el parámetro \"url\"" })),
            )
                .into_response();
        }
    };
    let refresh = matches!(q.refresh.as_deref(), Some("true") | Some("1"));
    match extract_url_cached(&state, raw, refresh).await {
        Ok(res) => Json(res).into_response(),
        Err(msg) => (StatusCode::UNPROCESSABLE_ENTITY, Json(json!({ "error": msg }))).into_response(),
    }
}

async fn extract_post_handler(
    State(state): State<AppState>,
    Json(body): Json<ExtractBody>,
) -> Response {
    let raw = match body.url.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(u) => u,
        None => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "Falta el parámetro \"url\"" })),
            )
                .into_response();
        }
    };
    let refresh = body.refresh.unwrap_or(false);
    match extract_url_cached(&state, raw, refresh).await {
        Ok(res) => Json(res).into_response(),
        Err(msg) => (StatusCode::UNPROCESSABLE_ENTITY, Json(json!({ "error": msg }))).into_response(),
    }
}

#[derive(Deserialize)]
struct ResolveQuery {
    url: Option<String>,
    refresh: Option<String>,
}

async fn resolve_handler(
    State(state): State<AppState>,
    Query(q): Query<ResolveQuery>,
) -> Response {
    let raw = match q.url.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(u) => u,
        None => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "Falta el parámetro \"url\"" })),
            )
                .into_response();
        }
    };
    let refresh = matches!(q.refresh.as_deref(), Some("true") | Some("1"));
    match video_resolver::resolve_video_stream_opts(
        &state.client,
        &state.resolve_cache,
        raw.to_string(),
        0,
        refresh,
    )
    .await
    {
        Ok(resolved) => Json(resolved).into_response(),
        Err(msg) => (StatusCode::UNPROCESSABLE_ENTITY, Json(json!({ "error": msg }))).into_response(),
    }
}

#[derive(Deserialize)]
struct ResolveBatchBody {
    urls: Vec<String>,
}

async fn resolve_batch_handler(
    State(state): State<AppState>,
    Json(body): Json<ResolveBatchBody>,
) -> impl IntoResponse {
    let results =
        video_resolver::resolve_batch(&state.client, &state.resolve_cache, body.urls).await;
    Json(json!({ "results": results }))
}

#[derive(Deserialize)]
struct SearchQuery {
    q: Option<String>,
    source: Option<String>,
}

async fn search_handler(
    State(state): State<AppState>,
    Query(q): Query<SearchQuery>,
) -> Response {
    let query = match q.q.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(v) => v,
        None => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "Falta el parámetro \"q\"" })),
            )
                .into_response();
        }
    };

    let state_clone = state.clone();
    let res = search::run_smart_search(query, q.source.as_deref(), move |url| {
        let st = state_clone.clone();
        async move { extract_url_cached(&st, &url, false).await }
    })
    .await;

    Json(res).into_response()
}

async fn proxy_route_handler(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    query: Query<proxy::ProxyQuery>,
) -> Response {
    proxy::proxy_handler(State(state.client), headers, query).await
}

async fn direct_download_route_handler(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    query: Query<download::DirectDownloadQuery>,
) -> Response {
    download::direct_download_handler(state.client, state.download_manager, headers, query).await
}

async fn start_download_job_route_handler(
    State(state): State<AppState>,
    body: Json<download::StartDownloadJobBody>,
) -> Response {
    download::start_download_job_handler(State(state.download_manager), body).await
}

async fn download_job_status_route_handler(
    State(state): State<AppState>,
    path: Path<String>,
) -> Response {
    download::download_job_status_handler(State(state.download_manager), path).await
}

async fn cancel_download_job_route_handler(
    State(state): State<AppState>,
    path: Path<String>,
) -> Response {
    download::cancel_download_job_handler(State(state.download_manager), path).await
}

async fn download_job_file_route_handler(
    State(state): State<AppState>,
    path: Path<String>,
    headers: axum::http::HeaderMap,
    query: Query<download::JobFileQuery>,
) -> Response {
    download::download_job_file_handler(State(state.download_manager), path, headers, query).await
}

fn find_public_dir() -> Option<PathBuf> {
    if let Ok(env_dir) = std::env::var("PUBLIC_DIR") {
        let p = PathBuf::from(env_dir);
        if p.exists() {
            return Some(p);
        }
    }
    for candidate in ["./public", "../backend/public", "./backend/public"] {
        let p = PathBuf::from(candidate);
        if p.exists() {
            return Some(p);
        }
    }
    None
}

#[tokio::main]
async fn main() {
    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(3001);
    let host = std::env::var("HOST").unwrap_or_else(|_| "0.0.0.0".to_string());
    let access_pin = std::env::var("ACCESS_PIN")
        .unwrap_or_default()
        .trim()
        .to_string();

    let client = Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .read_timeout(Duration::from_secs(25))
        .pool_max_idle_per_host(12)
        .pool_idle_timeout(Duration::from_secs(30))
        .tcp_keepalive(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::limited(8))
        .build()
        .expect("failed to build HTTP client");

    let extract_cache = Cache::builder()
        .max_capacity(300)
        .time_to_live(Duration::from_secs(5 * 60))
        .build();

    let resolve_cache = Cache::builder()
        .max_capacity(200)
        .time_to_live(Duration::from_secs(2 * 60))
        .build();

    let access_pin_arc = Arc::new(access_pin);
    let download_manager = DownloadManager::new(port, access_pin_arc.clone());

    let state = AppState {
        client,
        extract_cache,
        resolve_cache,
        access_pin: access_pin_arc,
        download_manager,
    };

    // JSON API routes WITH gzip compression
    let protected_json_api = Router::new()
        .route("/ping", get(ping_handler))
        .route("/extract", get(extract_get_handler).post(extract_post_handler))
        .route("/search", get(search_handler))
        .route("/resolve", get(resolve_handler))
        .route("/resolve-batch", post(resolve_batch_handler))
        .route("/download-job", post(start_download_job_route_handler))
        .route(
            "/download-job/{id}/status",
            get(download_job_status_route_handler),
        )
        .route("/download-job/{id}", delete(cancel_download_job_route_handler))
        .layer(CompressionLayer::new())
        .layer(middleware::from_fn_with_state(
            state.clone(),
            require_access_pin_mw,
        ));

    // Streaming proxy & download routes WITHOUT CompressionLayer (zero-copy raw binary video/HLS/images!)
    let protected_proxy = Router::new()
        .route("/proxy", get(proxy_route_handler))
        .route("/download", get(direct_download_route_handler))
        .route(
            "/download-job/{id}/file",
            get(download_job_file_route_handler),
        )
        .layer(middleware::from_fn_with_state(
            state.clone(),
            require_access_pin_mw,
        ));

    let mut app = Router::new()
        .route("/health", get(health_handler).layer(CompressionLayer::new()))
        .nest("/api", protected_json_api.merge(protected_proxy))
        .with_state(state);

    if let Some(public_dir) = find_public_dir() {
        let index_file = public_dir.join("index.html");
        println!("Sirviendo Expo Web estático desde {}", public_dir.display());
        app = app.fallback_service(
            ServeDir::new(public_dir).not_found_service(ServeFile::new(index_file)),
        );
    }

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = app
        .layer(cors)
        .layer(middleware::from_fn(security_headers_mw));

    let addr: SocketAddr = format!("{host}:{port}")
        .parse()
        .expect("invalid bind address");

    println!("CineStream Rust Engine v{} escuchando en http://{}", env!("CARGO_PKG_VERSION"), addr);

    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("failed to bind TCP listener");
    axum::serve(listener, app).await.expect("server crashed");
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine;
    use url::Url;

    #[test]
    fn test_ssrf_validation_ipv4_and_ipv6() {
        assert!(validate_target_url("ftp://example.com/a.pdf").is_err());
        assert!(validate_target_url("http://localhost:3001/").is_err());
        assert!(validate_target_url("http://192.168.1.50/").is_err());
        assert!(validate_target_url("http://[::1]:3001/").is_err());
        assert!(validate_target_url("http://[fc00::1]/").is_err());
        assert!(validate_target_url("http://[fe80::1]/").is_err());
        assert!(validate_target_url("http://[::ffff:127.0.0.1]/").is_err());
        assert!(validate_target_url("https://animeflv.or.at/").is_ok());
    }

    #[test]
    fn test_animeflv_adapter_extracts_rating_genres_servers_and_episodes() {
        let encoded = STANDARD.encode("https://player.zilla-networks.com/m3u8/abc123");
        let url = Url::parse("https://animeflv.or.at/anime/test-anime/").unwrap();
        let html = format!(
            r#"<html><body>
                <h1>Test Anime</h1>
                <span class="rating-score">8.95</span>
                <div class="anime-genres"><span class="genre-tag">Acción</span><span class="genre-tag">Shounen</span></div>
                <div class="anime-synopsis"><p>Sinopsis de prueba para AnimeFLV en Rust.</p></div>
                <button class="iframe_btn" data-src="{encoded}">OPCIÓN 1</button>
                <script class="animeflv-episodes-data">[{{"permalink":"https://animeflv.or.at/2026/11/20/test-ep-1/","number":1}}]</script>
            </body></html>"#
        );
        let res = adapters::extract_from_html(&url, &html);
        assert_eq!(res.adapter, "animeflv");
        assert_eq!(res.metadata.title, "Test Anime");
        assert_eq!(res.metadata.rating.as_deref(), Some("8.95"));
        assert_eq!(res.metadata.genres.as_ref().unwrap().len(), 2);
        assert_eq!(res.videos.len(), 1);
        assert_eq!(res.videos[0].is_embed, Some(false));
        assert_eq!(res.pages.len(), 1);
        assert_eq!(res.pages[0].title, "Capítulo 1");
    }

    #[test]
    fn test_hackstore_adapter_extracts_year_duration_genres_and_related() {
        let url = Url::parse("https://www.hackstore.fo/peliculas/demo-2026/").unwrap();
        let html = r#"<html><body>
            <h1>Demo Movie (2026)</h1>
            <div>Año: 2026 | Duración: 2horas 10minutos</div>
            <a href="/genero/accion/">Acción</a>
            <a href="/genero/fantasia/">Fantasía</a>
            <iframe id="intesx" src="/play.php?u=123"></iframe>
            <div class="yarpp-related">
                <a href="/peliculas/otra-2025/" title="Otra Película (2025)">
                    <img src="https://image.tmdb.org/t/p/w300/xyz.jpg" />
                </a>
            </div>
        </body></html>"#;
        let res = adapters::extract_from_html(&url, html);
        assert_eq!(res.adapter, "hackstore");
        assert_eq!(res.metadata.year.as_deref(), Some("2026"));
        assert_eq!(res.metadata.duration.as_deref(), Some("2horas 10minutos"));
        assert_eq!(res.metadata.genres.as_ref().unwrap().len(), 2);
        assert_eq!(res.videos.len(), 1);
        assert_eq!(res.related.as_ref().unwrap().len(), 1);
        assert_eq!(res.related.as_ref().unwrap()[0].title, "Otra Película (2025)");
    }

    #[test]
    fn test_hls_rewrite_preserves_pin_and_sorts_bandwidth() {
        let playlist = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=3500000\nhigh.m3u8";
        let base = Url::parse("https://cdn.example.com/v/master.m3u8").unwrap();
        let out = proxy::rewrite_hls_playlist(playlist, &base, "https://api.app", Some("https://ref/"), Some("9999"));
        let lines: Vec<&str> = out.lines().collect();
        assert!(lines[1].contains("BANDWIDTH=3500000"));
        assert!(lines[2].contains("high.m3u8"));
        assert!(lines[2].contains("pin=9999"));
    }

    #[test]
    fn test_packer_and_escaped_json_extraction() {
        let packed = r#"eval(function(p,a,c,k,e,d){while(c--)if(k[c])p=p.replace(new RegExp('\\b'+c.toString(a)+'\\b','g'),k[c]);return p}('2 1="3://0.4/5.6";',7,7,'cdn|url|var|https|example|master|m3u8'.split('|'),0,{}))"#;
        let unpacked = video_resolver::unpack_packer(packed).unwrap();
        assert_eq!(unpacked, r#"var url="https://cdn.example/master.m3u8";"#);

        let escaped = r#"{"sources":[{"file":"https:\/\/cdn.video.io\/hls\/master.m3u8?t=1"}]}"#;
        let (u, mime) = video_resolver::extract_direct_stream_from_text(escaped).unwrap();
        assert_eq!(u, "https://cdn.video.io/hls/master.m3u8?t=1");
        assert_eq!(mime, "application/x-mpegURL");
    }

    #[test]
    fn test_smart_search_fuzzy_ranking() {
        let s_exact = search::score_title("acción spider man", "Accion Spider-Man");
        let s_partial = search::score_title("acción spider man", "El hombre araña");
        assert!(s_exact > s_partial);
    }

    #[test]
    fn test_download_filename_and_ffmpeg_duration_parsing() {
        let clean = download::sanitize_download_filename(Some("Jujutsu Kaisen: S2 / Capítulo 21?"));
        assert_eq!(clean, "Jujutsu Kaisen S2 Capítulo 21.mp4");

        let disp = download::build_content_disposition(&clean);
        assert!(disp.contains("attachment;"));
        assert!(disp.contains("filename*=UTF-8''"));

        let dur = download::parse_ffmpeg_duration_us("  Duration: 00:24:10.50, start: 0.000000");
        assert_eq!(dur, Some(1_450_500_000));
    }
}
