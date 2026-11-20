use crate::url_utils::validate_target_url;
use axum::body::Body;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use futures_util::TryStreamExt;
use regex::Regex;
use reqwest::Client;
use serde::Deserialize;
use serde_json::json;
use std::sync::OnceLock;
use std::time::Duration;
use url::Url;

const DEFAULT_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

#[derive(Deserialize)]
pub struct ProxyQuery {
    pub url: Option<String>,
    pub referer: Option<String>,
    pub pin: Option<String>,
}

fn build_proxy_link(
    base_origin: &str,
    target_url: &str,
    referer: Option<&str>,
    pin: Option<&str>,
) -> String {
    let mut ser = url::form_urlencoded::Serializer::new(String::new());
    ser.append_pair("url", target_url);
    if let Some(r) = referer {
        ser.append_pair("referer", r);
    }
    if let Some(p) = pin {
        ser.append_pair("pin", p);
    }
    format!("{base_origin}/api/proxy?{}", ser.finish())
}

pub fn rewrite_hls_playlist(
    playlist: &str,
    playlist_url: &Url,
    proxy_base_origin: &str,
    referer: Option<&str>,
    pin: Option<&str>,
) -> String {
    static BW_RE: OnceLock<Regex> = OnceLock::new();
    static URI_RE: OnceLock<Regex> = OnceLock::new();
    let bw_re = BW_RE.get_or_init(|| Regex::new(r"(?i)BANDWIDTH=(\d+)").unwrap());
    let uri_re = URI_RE.get_or_init(|| Regex::new(r#"(?i)URI="([^"]+)""#).unwrap());

    let lines: Vec<&str> = playlist.lines().collect();
    let mut header_lines: Vec<&str> = Vec::new();
    let mut variants: Vec<(u64, Vec<&str>)> = Vec::new();
    let mut trailing_lines: Vec<&str> = Vec::new();

    let mut i = 0;
    while i < lines.len() {
        let trimmed = lines[i].trim();
        if trimmed.starts_with("#EXT-X-STREAM-INF:") {
            let bw = bw_re
                .captures(trimmed)
                .and_then(|c| c.get(1)?.as_str().parse::<u64>().ok())
                .unwrap_or(0);
            let mut group = vec![lines[i]];
            if i + 1 < lines.len() {
                let next_trimmed = lines[i + 1].trim();
                if !next_trimmed.is_empty() && !next_trimmed.starts_with('#') {
                    group.push(lines[i + 1]);
                    i += 2;
                } else {
                    i += 1;
                }
            } else {
                i += 1;
            }
            variants.push((bw, group));
        } else if variants.is_empty() {
            header_lines.push(lines[i]);
            i += 1;
        } else {
            trailing_lines.push(lines[i]);
            i += 1;
        }
    }

    let ordered_lines: Vec<&str> = if variants.len() > 1 {
        variants.sort_by(|a, b| b.0.cmp(&a.0));
        let mut out = header_lines;
        for (_, grp) in variants {
            out.extend(grp);
        }
        out.extend(trailing_lines);
        out
    } else {
        lines
    };

    ordered_lines
        .into_iter()
        .map(|line| {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                return line.to_string();
            }
            if trimmed.starts_with('#') {
                return uri_re
                    .replace_all(line, |caps: &regex::Captures| {
                        let raw_uri = &caps[1];
                        if let Ok(abs) = playlist_url.join(raw_uri) {
                            format!(
                                r#"URI="{}""#,
                                build_proxy_link(proxy_base_origin, abs.as_str(), referer, pin)
                            )
                        } else {
                            format!(r#"URI="{raw_uri}""#)
                        }
                    })
                    .into_owned();
            }
            if let Ok(abs) = playlist_url.join(trimmed) {
                build_proxy_link(proxy_base_origin, abs.as_str(), referer, pin)
            } else {
                line.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

pub async fn proxy_handler(
    State(client): State<Client>,
    headers: HeaderMap,
    Query(q): Query<ProxyQuery>,
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

    let raw_pin = q
        .pin
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .or_else(|| {
            headers
                .get("x-access-pin")
                .and_then(|v| v.to_str().ok())
                .map(str::trim)
                .filter(|s| !s.is_empty())
        });

    let mut req_builder = client
        .get(target_url.as_str())
        .header("User-Agent", DEFAULT_UA)
        .header("Accept", "*/*")
        .timeout(Duration::from_secs(20));

    let mut valid_referer: Option<String> = None;
    let target_host = target_url.host_str().unwrap_or("").to_lowercase();

    if target_host.contains("zilla-networks.com") {
        let origin = target_url.origin().ascii_serialization();
        let ref_str = format!("{origin}/");
        req_builder = req_builder
            .header("Referer", &ref_str)
            .header("Origin", &origin)
            .header("Sec-Fetch-Dest", "empty")
            .header("Sec-Fetch-Mode", "cors")
            .header("Sec-Fetch-Site", "same-origin");
        valid_referer = Some(ref_str);
    } else if let Some(ref_raw) = q.referer.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        if let Ok(ref_url) = validate_target_url(ref_raw) {
            let ref_origin = ref_url.origin().ascii_serialization();
            let same = ref_origin == target_url.origin().ascii_serialization();
            req_builder = req_builder
                .header("Referer", ref_url.as_str())
                .header("Origin", &ref_origin)
                .header("Sec-Fetch-Dest", "empty")
                .header("Sec-Fetch-Mode", "cors")
                .header("Sec-Fetch-Site", if same { "same-origin" } else { "cross-site" });
            valid_referer = Some(ref_url.to_string());
        }
    }

    if let Some(range_val) = headers.get("range").and_then(|v| v.to_str().ok()) {
        req_builder = req_builder.header("Range", range_val);
    }

    let upstream = match req_builder.send().await {
        Ok(r) => r,
        Err(err) => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(json!({ "error": format!("Error al conectar con el origen: {err}") })),
            )
                .into_response();
        }
    };

    let status = upstream.status();
    if !status.is_success() && status != StatusCode::PARTIAL_CONTENT {
        return (
            StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY),
            Json(json!({ "error": format!("Error del servidor origen: HTTP {}", status.as_u16()) })),
        )
            .into_response();
    }

    let upstream_ct = upstream
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_lowercase();

    let lower_path = target_url.path().to_lowercase();
    let is_hls = upstream_ct.contains("mpegurl")
        || lower_path.ends_with(".m3u8")
        || lower_path.contains("/m3u8/");

    if is_hls && status.is_success() {
        let text = match upstream.text().await {
            Ok(t) => t,
            Err(err) => {
                return (
                    StatusCode::BAD_GATEWAY,
                    Json(json!({ "error": format!("Error leyendo playlist HLS: {err}") })),
                )
                    .into_response();
            }
        };
        if text.trim_start().starts_with("#EXTM3U") {
            let proto = headers
                .get("x-forwarded-proto")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("http");
            let host = headers
                .get("host")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("");
            let proxy_origin = if host.is_empty() {
                String::new()
            } else {
                format!("{proto}://{host}")
            };
            let fallback_ref = format!("{}/", target_url.origin().ascii_serialization());
            let rewritten = rewrite_hls_playlist(
                &text,
                &target_url,
                &proxy_origin,
                valid_referer.as_deref().or(Some(&fallback_ref)),
                raw_pin,
            );
            return (
                StatusCode::OK,
                [
                    ("content-type", "application/vnd.apple.mpegurl; charset=utf-8"),
                    ("cache-control", "no-cache"),
                ],
                rewritten,
            )
                .into_response();
        }
        return (StatusCode::OK, text).into_response();
    }

    let mut resp_builder = Response::builder()
        .status(StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::OK));

    let mut has_cache_control = false;
    for h_name in [
        "content-type",
        "content-length",
        "content-range",
        "accept-ranges",
        "cache-control",
    ] {
        if let Some(val) = upstream.headers().get(h_name) {
            if h_name == "cache-control" {
                has_cache_control = true;
            }
            if h_name == "content-type" {
                if let Ok(s) = val.to_str() {
                    if s.contains("application/octet-stream") {
                        let inferred = if lower_path.ends_with(".mp4") {
                            Some("video/mp4")
                        } else if lower_path.ends_with(".webm") {
                            Some("video/webm")
                        } else if lower_path.ends_with(".pdf") {
                            Some("application/pdf")
                        } else if lower_path.ends_with(".webp") {
                            Some("image/webp")
                        } else if lower_path.ends_with(".jpg") || lower_path.ends_with(".jpeg") {
                            Some("image/jpeg")
                        } else if lower_path.ends_with(".png") {
                            Some("image/png")
                        } else {
                            None
                        };
                        if let Some(mime) = inferred {
                            resp_builder = resp_builder.header("content-type", mime);
                            continue;
                        }
                    }
                }
            }
            if let Ok(hv) = HeaderValue::from_bytes(val.as_bytes()) {
                resp_builder = resp_builder.header(h_name, hv);
            }
        }
    }

    if !has_cache_control && upstream_ct.starts_with("image/") {
        resp_builder = resp_builder.header("cache-control", "public, max-age=3600");
    }

    let byte_stream = upstream
        .bytes_stream()
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e));
    let body = Body::from_stream(byte_stream);

    resp_builder
        .body(body)
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}
