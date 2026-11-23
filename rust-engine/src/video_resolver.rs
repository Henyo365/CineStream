use crate::types::{ResolvedVideo, SubtitleOption};
use crate::url_utils::validate_target_url;
use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD};
use base64::Engine;
use futures_util::future::join_all;
use moka::future::Cache;
use regex::Regex;
use reqwest::Client;
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::pin::Pin;
use std::sync::OnceLock;
use std::time::Duration;

const DEFAULT_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

fn packer_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?s)eval\(function\(p,a,c,k,e,[dr]\)\{.*?\}\('(.*?)',(\d+),(\d+),'([^']*)'\.split\('\|'\)").unwrap()
    })
}

fn word_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\b\w+\b").unwrap())
}

fn to_base(num: usize, radix: usize) -> String {
    if radix < 2 {
        return num.to_string();
    }
    let first = if num < radix {
        String::new()
    } else {
        to_base(num / radix, radix)
    };
    let rem = num % radix;
    let ch = if rem > 35 {
        char::from_u32((rem + 29) as u32).unwrap_or('?')
    } else {
        std::char::from_digit(rem as u32, 36).unwrap_or('?')
    };
    format!("{first}{ch}")
}

pub fn unpack_packer(html: &str) -> Option<String> {
    let mut results = Vec::new();
    for caps in packer_re().captures_iter(html) {
        let p = caps.get(1).map(|m| m.as_str()).unwrap_or("");
        let a: usize = caps.get(2).and_then(|m| m.as_str().parse().ok()).unwrap_or(36);
        let c: usize = caps.get(3).and_then(|m| m.as_str().parse().ok()).unwrap_or(0);
        let k: Vec<&str> = caps.get(4).map(|m| m.as_str()).unwrap_or("").split('|').collect();

        let mut dict: HashMap<String, String> = HashMap::with_capacity(c);
        for i in (0..c).rev() {
            let key = to_base(i, a);
            let val = k.get(i).copied().unwrap_or("");
            dict.insert(
                key.clone(),
                if val.is_empty() { key } else { val.to_string() },
            );
        }

        let unpacked = word_re().replace_all(p, |m: &regex::Captures| {
            let w = m.get(0).map(|x| x.as_str()).unwrap_or("");
            dict.get(w).cloned().unwrap_or_else(|| w.to_string())
        });
        results.push(unpacked.into_owned());
    }

    if results.is_empty() {
        None
    } else {
        Some(results.join("\n"))
    }
}

pub fn extract_direct_stream_from_text(text: &str) -> Option<(String, String)> {
    let normalized = text.replace(r"\/", "/");

    // Mixdrop MDCore.wurl = "//..."
    static MDCORE_RE: OnceLock<Regex> = OnceLock::new();
    let md_re = MDCORE_RE.get_or_init(|| {
        Regex::new(r#"(?i)MDCore\.wurl\s*=\s*["']((?:https?:)?//[^"']+)["']"#).unwrap()
    });
    if let Some(caps) = md_re.captures(&normalized) {
        let raw = &caps[1];
        let url = if raw.starts_with("//") {
            format!("https:{raw}")
        } else {
            raw.to_string()
        };
        return Some((url, "video/mp4".to_string()));
    }

    // Explicit HLS key (file/src/source/hls2/hls4)
    static HLS_KEY_RE: OnceLock<Regex> = OnceLock::new();
    let hls_key = HLS_KEY_RE.get_or_init(|| {
        Regex::new(r#"(?i)(?:file|src|source|hls\d?)\s*[:=]\s*["'](https?://[^"'\s<>\\]+\.m3u8[^"'\s<>\\]*)["']"#).unwrap()
    });
    if let Some(caps) = hls_key.captures(&normalized) {
        return Some((caps[1].to_string(), "application/x-mpegURL".to_string()));
    }

    static M3U8_RE: OnceLock<Regex> = OnceLock::new();
    let m3u8 = M3U8_RE
        .get_or_init(|| Regex::new(r#"(?i)https?://[^\s"'<>\\]+\.m3u8[^\s"'<>\\]*"#).unwrap());
    if let Some(m) = m3u8.find(&normalized) {
        return Some((m.as_str().to_string(), "application/x-mpegURL".to_string()));
    }

    static OG_VIDEO_RE: OnceLock<Regex> = OnceLock::new();
    let og_v = OG_VIDEO_RE.get_or_init(|| {
        Regex::new(r#"(?i)<meta[^>]+property=["']og:video(?::secure_url)?["'][^>]+content=["'](https?://[^"']+\.mp4[^"']*)["']"#).unwrap()
    });
    if let Some(caps) = og_v.captures(&normalized) {
        return Some((caps[1].to_string(), "video/mp4".to_string()));
    }

    static MP4_RE: OnceLock<Regex> = OnceLock::new();
    let mp4 = MP4_RE
        .get_or_init(|| Regex::new(r#"(?i)https?://[^\s"'<>\\]+\.mp4[^\s"'<>\\]*"#).unwrap());
    if let Some(m) = mp4.find(&normalized) {
        let u = m.as_str();
        if !u.contains("Big_Buck_Bunny") && !u.contains("test-videos") {
            return Some((u.to_string(), "video/mp4".to_string()));
        }
    }

    None
}

fn extract_subtitles_from_text(text: &str) -> Vec<SubtitleOption> {
    let normalized = text.replace(r"\/", "/");
    static TRACK_RE: OnceLock<Regex> = OnceLock::new();
    static LABEL_RE: OnceLock<Regex> = OnceLock::new();
    let track_re = TRACK_RE.get_or_init(|| {
        Regex::new(r#"(?i)\{[^}]*file\s*:\s*["'](https?://[^"']+\.(?:vtt|srt)[^"']*)["'][^}]*\}"#)
            .unwrap()
    });
    let label_re = LABEL_RE
        .get_or_init(|| Regex::new(r#"(?i)label\s*:\s*["']([^"']+)["']"#).unwrap());

    let mut subs = Vec::new();
    let mut seen = HashSet::new();
    for caps in track_re.captures_iter(&normalized) {
        let block = &caps[0];
        let url = caps[1].to_string();
        if block.to_lowercase().contains("thumbnails") || !seen.insert(url.clone()) {
            continue;
        }
        let label = label_re
            .captures(block)
            .map(|c| c[1].to_string())
            .unwrap_or_else(|| format!("Subtítulo {}", subs.len() + 1));
        subs.push(SubtitleOption { url, label });
    }
    subs
}

#[derive(Deserialize)]
struct VoeCaption {
    file: Option<String>,
    label: Option<String>,
}

#[derive(Deserialize)]
struct VoePayload {
    source: Option<String>,
    direct_access_url: Option<String>,
    captions: Option<Vec<VoeCaption>>,
}

fn decode_b64_flexible(s: &str) -> Option<Vec<u8>> {
    STANDARD
        .decode(s)
        .or_else(|_| STANDARD_NO_PAD.decode(s.trim_end_matches('=')))
        .ok()
}

pub fn decode_voe_payload(html: &str) -> Option<(String, String, Option<Vec<SubtitleOption>>)> {
    static VOE_RE: OnceLock<Regex> = OnceLock::new();
    static JUNK_RE: OnceLock<Regex> = OnceLock::new();
    let voe_re = VOE_RE.get_or_init(|| {
        Regex::new(r#"(?i)<script[^>]*type=["']application/json["'][^>]*>\s*\["([^"]+)"\]\s*</script>"#).unwrap()
    });
    let junk_re = JUNK_RE.get_or_init(|| Regex::new(r"(@\$|\^\^|~@|#&|!!|%\?|\*~)").unwrap());

    let raw = voe_re.captures(html)?.get(1)?.as_str();

    // 1. ROT13
    let rot13: String = raw
        .chars()
        .map(|c| match c {
            'a'..='m' | 'A'..='M' => ((c as u8) + 13) as char,
            'n'..='z' | 'N'..='Z' => ((c as u8) - 13) as char,
            _ => c,
        })
        .collect();

    // 2. Strip junk markers
    let cleaned = junk_re.replace_all(&rot13, "");

    // 3. Base64 decode (latin1 bytes)
    let bytes1 = decode_b64_flexible(&cleaned)?;

    // 4. Shift -3 and reverse
    let shifted_rev: String = bytes1
        .into_iter()
        .map(|b| b.wrapping_sub(3) as char)
        .rev()
        .collect();

    // 5. Base64 decode UTF-8 JSON
    let json_bytes = decode_b64_flexible(&shifted_rev)?;
    let obj: VoePayload = serde_json::from_slice(&json_bytes).ok()?;
    let stream_url = obj.source.or(obj.direct_access_url)?;
    let mime = if stream_url.contains(".m3u8") {
        "application/x-mpegURL"
    } else {
        "video/mp4"
    }
    .to_string();

    let subs: Vec<SubtitleOption> = obj
        .captions
        .unwrap_or_default()
        .into_iter()
        .enumerate()
        .filter_map(|(idx, c)| {
            let file = c.file?;
            Some(SubtitleOption {
                url: file,
                label: c.label.unwrap_or_else(|| format!("Subtítulo {}", idx + 1)),
            })
        })
        .collect();

    Some((
        stream_url,
        mime,
        if subs.is_empty() { None } else { Some(subs) },
    ))
}

pub fn resolve_video_stream<'a>(
    client: &'a Client,
    cache: &'a Cache<String, ResolvedVideo>,
    raw_url: String,
    depth: u8,
) -> Pin<Box<dyn Future<Output = Result<ResolvedVideo, String>> + Send + 'a>> {
    resolve_video_stream_opts(client, cache, raw_url, depth, false)
}

pub fn resolve_video_stream_opts<'a>(
    client: &'a Client,
    cache: &'a Cache<String, ResolvedVideo>,
    raw_url: String,
    depth: u8,
    bypass_cache: bool,
) -> Pin<Box<dyn Future<Output = Result<ResolvedVideo, String>> + Send + 'a>> {
    Box::pin(async move {
        let target = validate_target_url(&raw_url)?;
        let url_str = target.to_string();

        if depth == 0 && !bypass_cache {
            if let Some(hit) = cache.get(&url_str).await {
                return Ok(hit);
            }
        }

        let res = resolve_uncached(client, cache, &target, depth).await?;
        if depth == 0 && !res.is_embed && res.unavailable_reason.is_none() {
            cache.insert(url_str, res.clone()).await;
        }
        Ok(res)
    })
}

async fn resolve_uncached(
    client: &Client,
    cache: &Cache<String, ResolvedVideo>,
    target: &url::Url,
    depth: u8,
) -> Result<ResolvedVideo, String> {
    let url_str = target.to_string();
    let host = target.host_str().unwrap_or("").to_lowercase();
    let origin_ref = format!("{}/", target.origin().ascii_serialization());

    // Direct HLS
    static M3U8_PATH_RE: OnceLock<Regex> = OnceLock::new();
    let m3u8_path =
        M3U8_PATH_RE.get_or_init(|| Regex::new(r"(?i)(/m3u8/|\.m3u8(\?|#|$))").unwrap());
    if m3u8_path.is_match(target.path()) || m3u8_path.is_match(&url_str) {
        return Ok(ResolvedVideo {
            stream_url: url_str,
            referer: Some(origin_ref),
            mime_type: Some("application/x-mpegURL".to_string()),
            is_embed: false,
            subtitles: None,
            unavailable_reason: None,
        });
    }

    // Direct MP4 / WebM
    static MP4_PATH_RE: OnceLock<Regex> = OnceLock::new();
    let mp4_path =
        MP4_PATH_RE.get_or_init(|| Regex::new(r"(?i)\.(mp4|webm|mov|m4v)(\?|#|$)").unwrap());
    if mp4_path.is_match(&url_str) {
        return Ok(ResolvedVideo {
            stream_url: url_str,
            referer: Some(origin_ref),
            mime_type: Some("video/mp4".to_string()),
            is_embed: false,
            subtitles: None,
            unavailable_reason: None,
        });
    }

    static JS_REDIRECT_RE: OnceLock<Regex> = OnceLock::new();
    let js_redirect_re = JS_REDIRECT_RE.get_or_init(|| {
        Regex::new(r#"(?i)window\.location(?:\.href\s*=|\.replace\()\s*['"](https?://[^'"]+)['"]"#)
            .unwrap()
    });

    // hackstore.fo/play.php
    if host.contains("hackstore.") && target.path().contains("play.php") && depth < 2 {
        if let Ok(resp) = client
            .get(&url_str)
            .header("User-Agent", DEFAULT_UA)
            .header("Referer", &origin_ref)
            .timeout(Duration::from_secs(12))
            .send()
            .await
        {
            if resp.status().is_success() {
                if let Ok(html) = resp.text().await {
                    if let Some(caps) = js_redirect_re.captures(&html) {
                        return resolve_video_stream(client, cache, caps[1].to_string(), depth + 1)
                            .await;
                    }
                }
            }
        }
    }

    // mp4upload.com
    if host.contains("mp4upload.com") {
        static MP4UPLOAD_RE: OnceLock<Regex> = OnceLock::new();
        let mp4u = MP4UPLOAD_RE
            .get_or_init(|| Regex::new(r#"(?i)src\s*:\s*["'](https?://[^"']+\.mp4[^"']*)["']"#).unwrap());
        if let Ok(resp) = client
            .get(&url_str)
            .header("User-Agent", DEFAULT_UA)
            .header("Referer", "https://animeflv.or.at/")
            .timeout(Duration::from_secs(12))
            .send()
            .await
        {
            if resp.status().is_success() {
                if let Ok(html) = resp.text().await {
                    if let Some(caps) = mp4u.captures(&html) {
                        return Ok(ResolvedVideo {
                            stream_url: caps[1].to_string(),
                            referer: Some("https://www.mp4upload.com/".to_string()),
                            mime_type: Some("video/mp4".to_string()),
                            is_embed: false,
                            subtitles: None,
                            unavailable_reason: None,
                        });
                    }
                }
            }
        }
    }

    // Generic embed resolver
    if !host.contains("youtube.com") && !host.contains("youtu.be") {
        if let Ok(resp) = client
            .get(&url_str)
            .header("User-Agent", DEFAULT_UA)
            .header("Referer", &origin_ref)
            .timeout(Duration::from_secs(10))
            .send()
            .await
        {
            if resp.status().is_success() {
                if let Ok(html) = resp.text().await {
                    static DEAD_RE: OnceLock<Regex> = OnceLock::new();
                    let dead_re = DEAD_RE.get_or_init(|| {
                        Regex::new(r"(?i)file was deleted|video not found|file is no longer available").unwrap()
                    });
                    if dead_re.is_match(&html) {
                        return Ok(ResolvedVideo {
                            stream_url: url_str,
                            referer: None,
                            mime_type: None,
                            is_embed: true,
                            subtitles: None,
                            unavailable_reason: Some(
                                "Este servidor no tiene el video disponible. Prueba otro servidor."
                                    .to_string(),
                            ),
                        });
                    }

                    // Follow single JS redirect (e.g. voe.sx -> mirror)
                    if depth < 2 && html.len() < 5000 {
                        if let Some(caps) = js_redirect_re.captures(&html) {
                            let next = caps[1].to_string();
                            if next != url_str {
                                return resolve_video_stream(client, cache, next, depth + 1).await;
                            }
                        }
                    }

                    if let Some((stream_url, mime_type, subtitles)) = decode_voe_payload(&html) {
                        return Ok(ResolvedVideo {
                            stream_url,
                            referer: Some(origin_ref),
                            mime_type: Some(mime_type),
                            is_embed: false,
                            subtitles,
                            unavailable_reason: None,
                        });
                    }

                    let unpacked = unpack_packer(&html);
                    let found = unpacked
                        .as_deref()
                        .and_then(extract_direct_stream_from_text)
                        .or_else(|| extract_direct_stream_from_text(&html));

                    if let Some((stream_url, mime_type)) = found {
                        let mut subs = unpacked
                            .as_deref()
                            .map(extract_subtitles_from_text)
                            .unwrap_or_default();
                        let html_subs = extract_subtitles_from_text(&html);
                        let mut seen: HashSet<String> = subs.iter().map(|s| s.url.clone()).collect();
                        for s in html_subs {
                            if seen.insert(s.url.clone()) {
                                subs.push(s);
                            }
                        }
                        return Ok(ResolvedVideo {
                            stream_url,
                            referer: Some(origin_ref),
                            mime_type: Some(mime_type),
                            is_embed: false,
                            subtitles: if subs.is_empty() { None } else { Some(subs) },
                            unavailable_reason: None,
                        });
                    }
                }
            }
        }
    }

    Ok(ResolvedVideo {
        stream_url: url_str,
        referer: None,
        mime_type: None,
        is_embed: true,
        subtitles: None,
        unavailable_reason: None,
    })
}

/// Resolves up to 6 video server URLs concurrently so the app instantly knows which servers
/// are native HD streams vs dead/deleted vs embed fallback!
pub async fn resolve_batch(
    client: &Client,
    cache: &Cache<String, ResolvedVideo>,
    urls: Vec<String>,
) -> HashMap<String, ResolvedVideo> {
    let limited: Vec<String> = urls.into_iter().take(6).collect();
    let futs = limited.into_iter().map(|u| async move {
        let resolved = tokio::time::timeout(
            Duration::from_secs(9),
            resolve_video_stream(client, cache, u.clone(), 0),
        )
        .await;
        let result = match resolved {
            Ok(Ok(r)) => r,
            _ => ResolvedVideo {
                stream_url: u.clone(),
                referer: None,
                mime_type: None,
                is_embed: true,
                subtitles: None,
                unavailable_reason: None,
            },
        };
        (u, result)
    });

    join_all(futs).await.into_iter().collect()
}
