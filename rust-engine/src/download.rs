use crate::url_utils::validate_target_url;
use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use bytes::Bytes;
use futures_util::TryStreamExt;
use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use regex::Regex;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncSeekExt, BufReader};
use tokio::process::Command;
use tokio::sync::{watch, RwLock, Semaphore};
use url::Url;

const DEFAULT_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadJobSnapshot {
    pub job_id: String,
    pub status: String, // "preparing" | "ready" | "error"
    pub progress: u8,
    pub size_bytes: Option<u64>,
    pub filename: String,
    pub error: Option<String>,
}

struct DownloadJobRecord {
    snapshot: DownloadJobSnapshot,
    file_path: PathBuf,
    created_at: Instant,
    cancel_tx: Option<watch::Sender<bool>>,
}

#[derive(Clone)]
pub struct DownloadManager {
    jobs: Arc<RwLock<HashMap<String, DownloadJobRecord>>>,
    semaphore: Arc<Semaphore>,
    temp_dir: PathBuf,
    local_port: u16,
    access_pin: Arc<String>,
}

impl DownloadManager {
    pub fn new(local_port: u16, access_pin: Arc<String>) -> Self {
        let temp_dir = std::env::temp_dir().join("cinestream_downloads");
        let _ = std::fs::create_dir_all(&temp_dir);

        let manager = Self {
            jobs: Arc::new(RwLock::new(HashMap::new())),
            semaphore: Arc::new(Semaphore::new(4)),
            temp_dir,
            local_port,
            access_pin,
        };

        // Background cleanup of expired temp files (> 15 min)
        let cleanup_jobs = manager.jobs.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(120));
            loop {
                interval.tick().await;
                let mut to_remove: Vec<(String, PathBuf)> = Vec::new();
                {
                    let guard = cleanup_jobs.read().await;
                    for (id, rec) in guard.iter() {
                        if rec.created_at.elapsed() > Duration::from_secs(15 * 60) {
                            to_remove.push((id.clone(), rec.file_path.clone()));
                        }
                    }
                }
                if !to_remove.is_empty() {
                    let mut guard = cleanup_jobs.write().await;
                    for (id, path) in to_remove {
                        if let Some(rec) = guard.remove(&id) {
                            if let Some(tx) = rec.cancel_tx {
                                let _ = tx.send(true);
                            }
                        }
                        let _ = tokio::fs::remove_file(&path).await;
                    }
                }
            }
        });

        manager
    }
}

pub fn sanitize_download_filename(raw: Option<&str>) -> String {
    let base = raw.unwrap_or("video").trim();
    let mut cleaned = String::with_capacity(base.len() + 4);
    for ch in base.chars() {
        let bad = matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')
            || ch.is_control();
        if bad {
            cleaned.push(' ');
        } else {
            cleaned.push(ch);
        }
    }
    let collapsed: String = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut trimmed = collapsed
        .trim_matches(|c: char| c == '.' || c == ' ')
        .to_string();

    if trimmed.is_empty() {
        trimmed = "CineStream_Video".to_string();
    }

    // Strip existing .mp4 extension before truncating so extension is preserved
    if trimmed.to_lowercase().ends_with(".mp4") {
        let new_len = trimmed.len().saturating_sub(4);
        trimmed.truncate(new_len);
        trimmed = trimmed.trim().to_string();
    }

    // Truncate cleanly on char boundary
    if trimmed.chars().count() > 130 {
        trimmed = trimmed.chars().take(130).collect::<String>().trim().to_string();
    }

    if trimmed.is_empty() {
        trimmed = "CineStream_Video".to_string();
    }

    format!("{trimmed}.mp4")
}

pub fn build_content_disposition(filename: &str) -> String {
    let ascii_fallback: String = filename
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, ' ' | '-' | '_' | '.' | '(' | ')') {
                c
            } else {
                '_'
            }
        })
        .collect();
    let encoded_utf8 = utf8_percent_encode(filename, NON_ALPHANUMERIC).to_string();
    format!(
        r#"attachment; filename="{}"; filename*=UTF-8''{}"#,
        ascii_fallback, encoded_utf8
    )
}

pub fn parse_ffmpeg_duration_us(line: &str) -> Option<u64> {
    static DUR_RE: OnceLock<Regex> = OnceLock::new();
    let re = DUR_RE.get_or_init(|| {
        Regex::new(r"Duration:\s*(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?").unwrap()
    });
    let caps = re.captures(line)?;
    let h: u64 = caps.get(1)?.as_str().parse().ok()?;
    let m: u64 = caps.get(2)?.as_str().parse().ok()?;
    let s: u64 = caps.get(3)?.as_str().parse().ok()?;
    let frac = caps.get(4).map(|x| x.as_str()).unwrap_or("0");
    let ms: u64 = match frac.len() {
        1 => frac.parse::<u64>().unwrap_or(0) * 100,
        2 => frac.parse::<u64>().unwrap_or(0) * 10,
        _ => frac.get(..3).and_then(|x| x.parse::<u64>().ok()).unwrap_or(0),
    };
    let total_ms = ((h * 3600 + m * 60 + s) * 1000) + ms;
    Some(total_ms * 1000)
}

fn build_local_proxy_url(port: u16, target_url: &str, referer: Option<&str>, pin: &str) -> String {
    let mut ser = url::form_urlencoded::Serializer::new(String::new());
    ser.append_pair("url", target_url);
    if let Some(r) = referer.map(str::trim).filter(|s| !s.is_empty()) {
        ser.append_pair("referer", r);
    }
    if !pin.is_empty() {
        ser.append_pair("pin", pin);
    }
    format!("http://127.0.0.1:{port}/api/proxy?{}", ser.finish())
}

#[derive(Deserialize)]
pub struct DirectDownloadQuery {
    pub url: Option<String>,
    pub referer: Option<String>,
    pub filename: Option<String>,
}

/// Direct streaming download endpoint (`GET /api/download`)
/// - For progressive MP4/WebM streams: zero-copy pass-through with Content-Length & Content-Disposition
/// - For HLS `.m3u8` streams (fallback if client hits /api/download directly): live fragmented MP4 remux
pub async fn direct_download_handler(
    client: Client,
    manager: DownloadManager,
    headers: HeaderMap,
    Query(q): Query<DirectDownloadQuery>,
) -> Response {
    let raw_url = match q.url.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(u) => u,
        None => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "Falta el parámetro \"url\"" })),
            )
                .into_response();
        }
    };

    let target_url = match validate_target_url(raw_url) {
        Ok(u) => u,
        Err(msg) => {
            return (StatusCode::BAD_GATEWAY, Json(json!({ "error": msg }))).into_response();
        }
    };

    let filename = sanitize_download_filename(q.filename.as_deref());
    let disposition = build_content_disposition(&filename);
    let lower_path = target_url.path().to_lowercase();
    let is_hls_url = lower_path.ends_with(".m3u8") || lower_path.contains("/m3u8/");

    if is_hls_url {
        return stream_hls_via_ffmpeg(
            manager,
            target_url.as_str(),
            q.referer.as_deref(),
            &disposition,
        )
        .await;
    }

    let target_host = target_url.host_str().unwrap_or("").to_lowercase();
    let mut valid_referer: Option<String> = None;
    if target_host.contains("zilla-networks.com") {
        let origin = target_url.origin().ascii_serialization();
        valid_referer = Some(format!("{origin}/"));
    } else if let Some(ref_raw) = q.referer.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        if let Ok(ref_url) = validate_target_url(ref_raw) {
            valid_referer = Some(ref_url.to_string());
        }
    }

    let range_header = headers
        .get("range")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    let mut last_err: Option<String> = None;
    let mut upstream_opt: Option<reqwest::Response> = None;

    for attempt in 0..3u8 {
        if attempt > 0 {
            tokio::time::sleep(Duration::from_millis(if attempt == 1 { 300 } else { 700 })).await;
        }
        let mut req_builder = client
            .get(target_url.as_str())
            .header("User-Agent", DEFAULT_UA)
            .header("Accept", "*/*")
            .header("Accept-Encoding", "identity");

        if attempt > 0 {
            req_builder = req_builder.header("Connection", "close");
        }
        if let Some(ref ref_str) = valid_referer {
            if let Ok(ref_url) = Url::parse(ref_str) {
                let ref_origin = ref_url.origin().ascii_serialization();
                req_builder = req_builder
                    .header("Referer", ref_url.as_str())
                    .header("Origin", &ref_origin);
            }
        }
        if let Some(ref rv) = range_header {
            req_builder = req_builder.header("Range", rv.as_str());
        }

        match req_builder.send().await {
            Ok(resp) => {
                let st = resp.status().as_u16();
                if matches!(st, 429 | 500 | 502 | 503 | 504) && attempt < 2 {
                    last_err = Some(format!("HTTP {st}"));
                    continue;
                }
                upstream_opt = Some(resp);
                break;
            }
            Err(err) => {
                last_err = Some(err.to_string());
            }
        }
    }

    let upstream = match upstream_opt {
        Some(r) => r,
        None => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(json!({
                    "error": format!(
                        "No se pudo conectar para descargar: {}",
                        last_err.unwrap_or_else(|| "desconocido".to_string())
                    )
                })),
            )
                .into_response();
        }
    };

    let status = upstream.status();
    if !status.is_success() && status != StatusCode::PARTIAL_CONTENT {
        return (
            StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY),
            Json(json!({ "error": format!("Servidor de video respondió HTTP {}", status.as_u16()) })),
        )
            .into_response();
    }

    let upstream_ct = upstream
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_lowercase();

    // If upstream unexpectedly returned an HLS playlist, remux via ffmpeg!
    if upstream_ct.contains("mpegurl") {
        drop(upstream);
        return stream_hls_via_ffmpeg(
            manager,
            target_url.as_str(),
            q.referer.as_deref(),
            &disposition,
        )
        .await;
    }

    let mut resp_builder = Response::builder()
        .status(StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::OK))
        .header("content-type", "video/mp4")
        .header("content-disposition", disposition)
        .header("cache-control", "no-store");

    for h_name in ["content-length", "content-range", "accept-ranges"] {
        if let Some(val) = upstream.headers().get(h_name) {
            if let Ok(hv) = HeaderValue::from_bytes(val.as_bytes()) {
                resp_builder = resp_builder.header(h_name, hv);
            }
        }
    }

    let byte_stream = upstream
        .bytes_stream()
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e));
    resp_builder
        .body(Body::from_stream(byte_stream))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

async fn stream_hls_via_ffmpeg(
    manager: DownloadManager,
    stream_url: &str,
    referer: Option<&str>,
    disposition: &str,
) -> Response {
    let local_url = build_local_proxy_url(
        manager.local_port,
        stream_url,
        referer,
        manager.access_pin.as_str(),
    );

    let mut cmd = Command::new("ffmpeg");
    cmd.args([
        "-hide_banner",
        "-loglevel",
        "error",
        "-reconnect",
        "1",
        "-reconnect_streamed",
        "1",
        "-reconnect_delay_max",
        "5",
        "-allowed_extensions",
        "ALL",
        "-http_persistent",
        "1",
        "-protocol_whitelist",
        "file,http,https,tcp,tls,crypto",
        "-f",
        "hls",
        "-i",
        &local_url,
        "-map",
        "0:v:0",
        "-map",
        "0:a:0?",
        "-c",
        "copy",
        "-movflags",
        "frag_keyframe+empty_moov+default_base_moof",
        "-f",
        "mp4",
        "pipe:1",
    ])
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .kill_on_drop(true);

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(err) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": format!("ffmpeg no disponible en el servidor: {err}") })),
            )
                .into_response();
        }
    };

    let mut stdout = match child.stdout.take() {
        Some(s) => s,
        None => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "No se pudo abrir salida de ffmpeg" })),
            )
                .into_response();
        }
    };

    // Wait for first bytes before committing 200 OK so failures return clean JSON errors
    let mut first_buf = vec![0u8; 65536];
    let first_n = match tokio::time::timeout(Duration::from_secs(30), stdout.read(&mut first_buf))
        .await
    {
        Ok(Ok(n)) if n > 0 => n,
        _ => {
            let mut err_msg = String::new();
            if let Some(mut stderr) = child.stderr.take() {
                let _ = stderr.read_to_string(&mut err_msg).await;
            }
            let _ = child.kill().await;
            let detail = err_msg.trim();
            return (
                StatusCode::BAD_GATEWAY,
                Json(json!({
                    "error": if detail.is_empty() {
                        "No se pudo descargar el stream HLS".to_string()
                    } else {
                        format!("Error al convertir HLS: {}", detail.chars().take(180).collect::<String>())
                    }
                })),
            )
                .into_response();
        }
    };
    first_buf.truncate(first_n);

    // Keep child alive inside the unfold state so dropping the stream kills ffmpeg cleanly!
    let stream = futures_util::stream::unfold(
        (Some(Bytes::from(first_buf)), stdout, child),
        |(first_opt, mut stdout, child)| async move {
            if let Some(first) = first_opt {
                return Some((Ok::<Bytes, std::io::Error>(first), (None, stdout, child)));
            }
            let mut buf = vec![0u8; 65536];
            match stdout.read(&mut buf).await {
                Ok(0) => None,
                Ok(n) => {
                    buf.truncate(n);
                    Some((Ok(Bytes::from(buf)), (None, stdout, child)))
                }
                Err(e) => Some((Err(e), (None, stdout, child))),
            }
        },
    );

    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "video/mp4")
        .header("content-disposition", disposition)
        .header("cache-control", "no-store")
        .body(Body::from_stream(stream))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

#[derive(Deserialize)]
pub struct StartDownloadJobBody {
    pub url: String,
    pub referer: Option<String>,
    pub filename: Option<String>,
}

/// Start an async HLS-to-MP4 (`+faststart`) remux job so the resulting MP4 has
/// exact Content-Length, full duration metadata, and instant seeking offline.
pub async fn start_download_job_handler(
    State(manager): State<DownloadManager>,
    Json(body): Json<StartDownloadJobBody>,
) -> Response {
    let target_url = match validate_target_url(body.url.trim()) {
        Ok(u) => u,
        Err(msg) => {
            return (StatusCode::BAD_REQUEST, Json(json!({ "error": msg }))).into_response();
        }
    };

    let filename = sanitize_download_filename(body.filename.as_deref());
    let now_nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let job_id = format!("dl_{:x}_{:x}", now_nanos, rand_mix(target_url.as_str()));
    let file_path = manager.temp_dir.join(format!("{job_id}.mp4"));

    let (cancel_tx, mut cancel_rx) = watch::channel(false);
    let snapshot = DownloadJobSnapshot {
        job_id: job_id.clone(),
        status: "preparing".to_string(),
        progress: 1,
        size_bytes: None,
        filename: filename.clone(),
        error: None,
    };

    {
        let mut guard = manager.jobs.write().await;
        guard.insert(
            job_id.clone(),
            DownloadJobRecord {
                snapshot: snapshot.clone(),
                file_path: file_path.clone(),
                created_at: Instant::now(),
                cancel_tx: Some(cancel_tx),
            },
        );
    }

    let mgr = manager.clone();
    let jid = job_id.clone();
    let referer = body.referer.clone();
    let target_str = target_url.to_string();

    tokio::spawn(async move {
        let _permit = match mgr.semaphore.acquire().await {
            Ok(p) => p,
            Err(_) => {
                mark_job_error(&mgr, &jid, "Cola de descargas ocupada".to_string()).await;
                return;
            }
        };

        if *cancel_rx.borrow() {
            let _ = tokio::fs::remove_file(&file_path).await;
            return;
        }

        let local_url = build_local_proxy_url(
            mgr.local_port,
            &target_str,
            referer.as_deref(),
            mgr.access_pin.as_str(),
        );

        let mut cmd = Command::new("ffmpeg");
        cmd.args([
            "-y",
            "-hide_banner",
            "-nostats",
            "-loglevel",
            "info",
            "-progress",
            "pipe:1",
            "-reconnect",
            "1",
            "-reconnect_streamed",
            "1",
            "-reconnect_delay_max",
            "5",
            "-allowed_extensions",
            "ALL",
            "-http_persistent",
            "1",
            "-protocol_whitelist",
            "file,http,https,tcp,tls,crypto",
            "-f",
            "hls",
            "-i",
            &local_url,
            "-map",
            "0:v:0",
            "-map",
            "0:a:0?",
            "-c",
            "copy",
            "-movflags",
            "+faststart",
            "-f",
            "mp4",
        ])
        .arg(&file_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(err) => {
                mark_job_error(&mgr, &jid, format!("ffmpeg no disponible: {err}")).await;
                return;
            }
        };

        let total_dur_us = Arc::new(std::sync::atomic::AtomicU64::new(0));
        let last_err_line = Arc::new(RwLock::new(String::new()));

        // Parse stderr for Duration and error messages
        let stderr_task = child.stderr.take().map(|stderr| {
            let dur_ref = total_dur_us.clone();
            let err_ref = last_err_line.clone();
            tokio::spawn(async move {
                let mut reader = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = reader.next_line().await {
                    if let Some(us) = parse_ffmpeg_duration_us(&line) {
                        dur_ref.store(us, std::sync::atomic::Ordering::Relaxed);
                    }
                    let trimmed = line.trim();
                    if !trimmed.is_empty()
                        && (trimmed.contains("Error")
                            || trimmed.contains("Invalid")
                            || trimmed.contains("HTTP error")
                            || trimmed.contains("failed"))
                    {
                        let mut w = err_ref.write().await;
                        *w = trimmed.chars().take(180).collect();
                    }
                }
            })
        });

        // Parse stdout (`-progress pipe:1`) for live out_time_us
        let stdout_task = child.stdout.take().map(|stdout| {
            let dur_ref = total_dur_us.clone();
            let mgr_p = mgr.clone();
            let jid_p = jid.clone();
            tokio::spawn(async move {
                let mut reader = BufReader::new(stdout).lines();
                let mut last_pct: u8 = 1;
                while let Ok(Some(line)) = reader.next_line().await {
                    if let Some(val) = line.strip_prefix("out_time_us=") {
                        if let Ok(cur_us) = val.trim().parse::<u64>() {
                            let total = dur_ref.load(std::sync::atomic::Ordering::Relaxed);
                            let pct = if total > 0 {
                                ((cur_us.saturating_mul(95)) / total).clamp(2, 95) as u8
                            } else {
                                // Smooth asymptotic estimate when duration header is missing
                                let secs = cur_us / 1_000_000;
                                ((secs.saturating_mul(90)) / (secs + 600)).clamp(2, 90) as u8
                            };
                            if pct > last_pct {
                                last_pct = pct;
                                let mut guard = mgr_p.jobs.write().await;
                                if let Some(rec) = guard.get_mut(&jid_p) {
                                    if rec.snapshot.status == "preparing" {
                                        rec.snapshot.progress = pct;
                                    }
                                }
                            }
                        }
                    }
                }
            })
        });

        let wait_res = tokio::select! {
            status = child.wait() => Some(status),
            _ = cancel_rx.changed() => {
                let _ = child.kill().await;
                None
            }
        };

        if let Some(t) = stdout_task {
            let _ = t.await;
        }
        if let Some(t) = stderr_task {
            let _ = t.await;
        }

        let Some(exit_res) = wait_res else {
            let _ = tokio::fs::remove_file(&file_path).await;
            return;
        };

        match exit_res {
            Ok(status) if status.success() => match tokio::fs::metadata(&file_path).await {
                Ok(meta) if meta.len() > 10_000 => {
                    let mut guard = mgr.jobs.write().await;
                    if let Some(rec) = guard.get_mut(&jid) {
                        rec.snapshot.status = "ready".to_string();
                        rec.snapshot.progress = 100;
                        rec.snapshot.size_bytes = Some(meta.len());
                        rec.created_at = Instant::now();
                    }
                }
                _ => {
                    let _ = tokio::fs::remove_file(&file_path).await;
                    mark_job_error(
                        &mgr,
                        &jid,
                        "El archivo generado quedó vacío. Prueba otro servidor.".to_string(),
                    )
                    .await;
                }
            },
            _ => {
                let _ = tokio::fs::remove_file(&file_path).await;
                let detail = last_err_line.read().await.clone();
                let msg = if detail.is_empty() {
                    "No se pudo procesar el stream HLS. Prueba otro servidor.".to_string()
                } else {
                    detail
                };
                mark_job_error(&mgr, &jid, msg).await;
            }
        }
    });

    (StatusCode::ACCEPTED, Json(snapshot)).into_response()
}

async fn mark_job_error(mgr: &DownloadManager, jid: &str, msg: String) {
    let mut guard = mgr.jobs.write().await;
    if let Some(rec) = guard.get_mut(jid) {
        rec.snapshot.status = "error".to_string();
        rec.snapshot.error = Some(msg);
    }
}

fn rand_mix(seed: &str) -> u32 {
    let mut h: u32 = 2166136261;
    for b in seed.as_bytes() {
        h ^= *b as u32;
        h = h.wrapping_mul(16777619);
    }
    h
}

pub async fn download_job_status_handler(
    State(manager): State<DownloadManager>,
    Path(job_id): Path<String>,
) -> Response {
    let guard = manager.jobs.read().await;
    match guard.get(&job_id) {
        Some(rec) => Json(rec.snapshot.clone()).into_response(),
        None => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "Descarga no encontrada o expirada" })),
        )
            .into_response(),
    }
}

pub async fn cancel_download_job_handler(
    State(manager): State<DownloadManager>,
    Path(job_id): Path<String>,
) -> Response {
    let removed = {
        let mut guard = manager.jobs.write().await;
        guard.remove(&job_id)
    };
    if let Some(rec) = removed {
        if let Some(tx) = rec.cancel_tx {
            let _ = tx.send(true);
        }
        let _ = tokio::fs::remove_file(&rec.file_path).await;
    }
    Json(json!({ "ok": true })).into_response()
}

#[derive(Deserialize)]
pub struct JobFileQuery {
    pub filename: Option<String>,
}

pub async fn download_job_file_handler(
    State(manager): State<DownloadManager>,
    Path(job_id): Path<String>,
    headers: HeaderMap,
    Query(q): Query<JobFileQuery>,
) -> Response {
    let (file_path, default_name) = {
        let guard = manager.jobs.read().await;
        match guard.get(&job_id) {
            Some(rec) if rec.snapshot.status == "ready" => {
                (rec.file_path.clone(), rec.snapshot.filename.clone())
            }
            Some(rec) if rec.snapshot.status == "preparing" => {
                return (
                    StatusCode::CONFLICT,
                    Json(json!({ "error": "El archivo todavía se está preparando" })),
                )
                    .into_response();
            }
            _ => {
                return (
                    StatusCode::NOT_FOUND,
                    Json(json!({ "error": "Archivo descargable no encontrado o expirado" })),
                )
                    .into_response();
            }
        }
    };

    let mut file = match tokio::fs::File::open(&file_path).await {
        Ok(f) => f,
        Err(_) => {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({ "error": "Archivo temporal no disponible" })),
            )
                .into_response();
        }
    };

    let total_size = match file.metadata().await {
        Ok(m) => m.len(),
        Err(_) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "Error leyendo archivo" })),
            )
                .into_response();
        }
    };

    let filename = q
        .filename
        .as_deref()
        .map(|f| sanitize_download_filename(Some(f)))
        .unwrap_or(default_name);
    let disposition = build_content_disposition(&filename);

    // Optional single-range support (helps mobile download managers resume cleanly)
    let range = headers
        .get("range")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| parse_byte_range(s, total_size));

    let (status, start, remaining) = match range {
        Some((s, e)) => {
            if file.seek(std::io::SeekFrom::Start(s)).await.is_err() {
                return (StatusCode::RANGE_NOT_SATISFIABLE, "Invalid range").into_response();
            }
            (StatusCode::PARTIAL_CONTENT, s, e - s + 1)
        }
        None => (StatusCode::OK, 0, total_size),
    };

    let stream = futures_util::stream::unfold(
        (file, remaining),
        |(mut file, mut rem)| async move {
            if rem == 0 {
                return None;
            }
            let chunk_size = rem.min(65536) as usize;
            let mut buf = vec![0u8; chunk_size];
            match file.read(&mut buf).await {
                Ok(0) => None,
                Ok(n) => {
                    buf.truncate(n);
                    rem = rem.saturating_sub(n as u64);
                    Some((Ok::<Bytes, std::io::Error>(Bytes::from(buf)), (file, rem)))
                }
                Err(e) => Some((Err(e), (file, 0))),
            }
        },
    );

    let mut builder = Response::builder()
        .status(status)
        .header("content-type", "video/mp4")
        .header("content-disposition", disposition)
        .header("accept-ranges", "bytes")
        .header("content-length", remaining.to_string())
        .header("cache-control", "no-store");

    if status == StatusCode::PARTIAL_CONTENT {
        let end = start + remaining - 1;
        builder = builder.header(
            "content-range",
            format!("bytes {start}-{end}/{total_size}"),
        );
    }

    builder
        .body(Body::from_stream(stream))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

fn parse_byte_range(header: &str, total: u64) -> Option<(u64, u64)> {
    if total == 0 {
        return None;
    }
    let spec = header.trim().strip_prefix("bytes=")?;
    let first = spec.split(',').next()?.trim();
    let (s_str, e_str) = first.split_once('-')?;
    let start: u64 = s_str.trim().parse().ok()?;
    if start >= total {
        return None;
    }
    let end: u64 = if e_str.trim().is_empty() {
        total - 1
    } else {
        e_str.trim().parse::<u64>().ok()?.min(total - 1)
    };
    if end < start {
        return None;
    }
    Some((start, end))
}
