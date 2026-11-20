use crate::adapters::generic;
use crate::types::{ExtractionResult, GenreTag, MediaItem, MediaType, PageLink};
use crate::url_utils::{make_media_id, normalize_whitespace, resolve_url};
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use chrono::{Datelike, Local, NaiveDate};
use regex::Regex;
use scraper::{Html, Selector};
use serde::Deserialize;
use std::collections::HashSet;
use std::sync::OnceLock;
use url::Url;

pub fn can_handle(url: &Url) -> bool {
    let host = url.host_str().unwrap_or("").to_lowercase();
    host == "animeflv.or.at" || host.ends_with(".animeflv.or.at")
}

fn sel(s: &str) -> Selector {
    Selector::parse(s).unwrap()
}

fn decode_base64_url(encoded: Option<&str>) -> Option<String> {
    let raw = encoded?.trim();
    if raw.is_empty() {
        return None;
    }
    let decoded_bytes = STANDARD.decode(raw).ok()?;
    let decoded = String::from_utf8(decoded_bytes).ok()?;
    let parsed = Url::parse(decoded.trim()).ok()?;
    if parsed.scheme() == "http" || parsed.scheme() == "https" {
        Some(parsed.to_string())
    } else {
        None
    }
}

fn date_in_url_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"/(\d{4})/(\d{2})/(\d{2})/").unwrap())
}

fn format_day_group_from_url(href: &str) -> Option<String> {
    let caps = date_in_url_re().captures(href)?;
    let year: i32 = caps.get(1)?.as_str().parse().ok()?;
    let month: u32 = caps.get(2)?.as_str().parse().ok()?;
    let day: u32 = caps.get(3)?.as_str().parse().ok()?;
    let item_date = NaiveDate::from_ymd_opt(year, month, day)?;

    let today = Local::now().date_naive();
    let diff = (today - item_date).num_days();
    if diff == 0 {
        return Some("Hoy".to_string());
    }
    if diff == 1 {
        return Some("Ayer".to_string());
    }

    let weekday = match item_date.weekday() {
        chrono::Weekday::Sun => "Domingo",
        chrono::Weekday::Mon => "Lunes",
        chrono::Weekday::Tue => "Martes",
        chrono::Weekday::Wed => "Miércoles",
        chrono::Weekday::Thu => "Jueves",
        chrono::Weekday::Fri => "Viernes",
        chrono::Weekday::Sat => "Sábado",
    };
    let months = [
        "Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic",
    ];
    let month_str = months.get((month - 1) as usize).copied().unwrap_or("");
    Some(format!("{weekday} {day} {month_str}"))
}

fn direct_m3u8_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)(/m3u8/|\.m3u8(\?|#|$))").unwrap())
}

fn direct_mp4_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)\.(mp4|webm|mov|m4v)(\?|#|$)").unwrap())
}

fn anime_detail_path_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^/anime/[^/]+/?$").unwrap())
}

#[derive(Deserialize)]
struct AnimeFlvEpisodeJson {
    permalink: Option<String>,
    number: Option<serde_json::Value>,
}

pub fn extract(url: &Url, html: &str) -> ExtractionResult {
    let mut base = generic::extract(url, html);
    let doc = Html::parse_document(html);

    let h1_title = doc
        .select(&sel("h1"))
        .next()
        .map(|el| normalize_whitespace(&el.text().collect::<String>()))
        .filter(|s| !s.is_empty());

    let synopsis = doc
        .select(&sel(".anime-synopsis p"))
        .next()
        .map(|el| normalize_whitespace(&el.text().collect::<String>()))
        .filter(|s| !s.is_empty());

    let poster_img = doc
        .select(&sel("img.poster-image, #iframePoster img"))
        .next()
        .and_then(|img| {
            resolve_url(
                img.value()
                    .attr("src")
                    .or_else(|| img.value().attr("data-src")),
                url,
            )
        })
        .or_else(|| base.images.first().map(|i| i.url.clone()));

    let status_text = doc
        .select(&sel(".anime-status, .status, .Estado"))
        .next()
        .map(|el| normalize_whitespace(&el.text().collect::<String>()))
        .filter(|s| !s.is_empty());

    let rating_text = doc
        .select(&sel(".rating-score, .anime-rating .score"))
        .next()
        .map(|el| normalize_whitespace(&el.text().collect::<String>()))
        .filter(|s| !s.is_empty());

    let mut genres: Vec<GenreTag> = Vec::new();
    let mut seen_genres = HashSet::new();
    for g_el in doc.select(&sel(".anime-genres .genre-tag, .genre-tag, .anime-genres a")) {
        let label = normalize_whitespace(&g_el.text().collect::<String>());
        if !label.is_empty() && seen_genres.insert(label.to_lowercase()) {
            let g_url = resolve_url(g_el.value().attr("href"), url);
            genres.push(GenreTag { label, url: g_url });
        }
    }

    // Link to anime detail page (/anime/<slug>/) when currently on an episode page
    let mut info_url: Option<String> = None;
    for a in doc.select(&sel(r#"a[href*="/anime/"]"#)) {
        if let Some(href) = resolve_url(a.value().attr("href"), url) {
            if let Ok(parsed) = Url::parse(&href) {
                if anime_detail_path_re().is_match(parsed.path()) {
                    info_url = Some(href);
                    break;
                }
            }
        }
    }

    // 1. Base64 video servers
    let mut videos = base.videos;
    let mut seen_videos: HashSet<String> = videos.iter().map(|v| v.url.clone()).collect();

    for (idx, btn) in doc
        .select(&sel("button.iframe_btn[data-src], .server_btn[data-src]"))
        .enumerate()
    {
        let decoded = match decode_base64_url(btn.value().attr("data-src")) {
            Some(u) => u,
            None => continue,
        };
        if !seen_videos.insert(decoded.clone()) {
            continue;
        }
        let label_raw = normalize_whitespace(&btn.text().collect::<String>());
        let label = if label_raw.is_empty() {
            format!("OPCIÓN {}", idx + 1)
        } else {
            label_raw
        };
        let host_label = Url::parse(&decoded)
            .ok()
            .and_then(|u| u.host_str().map(|h| format!(" ({})", h.trim_start_matches("www."))))
            .unwrap_or_default();

        let is_m3u8 = direct_m3u8_re().is_match(&decoded);
        let is_mp4 = direct_mp4_re().is_match(&decoded);
        let is_direct = is_m3u8 || is_mp4;

        videos.push(MediaItem {
            id: make_media_id(&decoded),
            media_type: MediaType::Video,
            url: decoded,
            title: Some(format!(
                "{label}{host_label}{}",
                if is_direct { " ★ Nativo" } else { "" }
            )),
            thumbnail: poster_img.clone(),
            mime_type: if is_m3u8 {
                Some("application/x-mpegURL".to_string())
            } else {
                None
            },
            is_embed: Some(!is_direct),
            source_tag: Some("iframe_btn".to_string()),
        });
    }

    // 2. Episode list JSON (<script class="animeflv-episodes-data">)
    let mut pages = Vec::new();
    let mut seen_pages = HashSet::new();

    for script in doc.select(&sel("script.animeflv-episodes-data")) {
        let raw_json = script.text().collect::<String>();
        let trimmed = raw_json.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Ok(items) = serde_json::from_str::<Vec<AnimeFlvEpisodeJson>>(trimmed) {
            for ep in items {
                let href = match resolve_url(ep.permalink.as_deref(), url) {
                    Some(h) => h,
                    None => continue,
                };
                if !seen_pages.insert(href.clone()) {
                    continue;
                }
                let num_str = ep.number.and_then(|v| match v {
                    serde_json::Value::Number(n) => Some(n.to_string()),
                    serde_json::Value::String(s) if !s.trim().is_empty() => {
                        Some(s.trim().to_string())
                    }
                    _ => None,
                });
                let title = match &num_str {
                    Some(n) => format!("Capítulo {n}"),
                    None => "Episodio".to_string(),
                };
                let subtitle = num_str.map(|n| format!("EP {n}"));
                pages.push(PageLink {
                    id: make_media_id(&href),
                    url: href,
                    title,
                    subtitle,
                    thumbnail: poster_img.clone(),
                    group: None,
                    source: Some("AnimeFLV".to_string()),
                    score: None,
                });
            }
        }
    }

    // 3. Episode / anime / search cards
    let card_selectors = [
        ".search-series-card a[href]",
        ".Episode a[href]",
        ".Anime a[href]",
        ".List-Episodes a[href]",
        ".List-Animes a[href]",
        "article a[href]",
    ];
    let img_sel = sel("img");
    let badge_sel = sel(".Capi, .episode");
    let title_sel = sel(".Title, h2, h3");

    for selector_str in card_selectors {
        for a in doc.select(&sel(selector_str)) {
            let href = match resolve_url(a.value().attr("href"), url) {
                Some(h) if h != url.as_str() => h,
                _ => continue,
            };
            let parsed = match Url::parse(&href) {
                Ok(p) => p,
                Err(_) => continue,
            };
            if !parsed
                .host_str()
                .unwrap_or("")
                .to_lowercase()
                .ends_with("animeflv.or.at")
            {
                continue;
            }
            if !seen_pages.insert(href.clone()) {
                continue;
            }

            let img = a.select(&img_sel).next();
            let thumb = img.and_then(|im| {
                resolve_url(
                    im.value()
                        .attr("data-src")
                        .or_else(|| im.value().attr("data-lazy-src"))
                        .or_else(|| im.value().attr("src")),
                    url,
                )
            });

            let ep_badge = a
                .select(&badge_sel)
                .next()
                .map(|el| normalize_whitespace(&el.text().collect::<String>()))
                .filter(|s| !s.is_empty());

            let raw_title = a
                .select(&title_sel)
                .next()
                .map(|el| normalize_whitespace(&el.text().collect::<String>()))
                .filter(|s| !s.is_empty())
                .or_else(|| {
                    a.value()
                        .attr("title")
                        .map(normalize_whitespace)
                        .filter(|s| !s.is_empty())
                })
                .or_else(|| {
                    img.and_then(|im| im.value().attr("alt"))
                        .map(normalize_whitespace)
                        .filter(|s| !s.is_empty())
                })
                .unwrap_or_else(|| normalize_whitespace(&a.text().collect::<String>()));

            let mut clean_title = raw_title;
            if let Some(ref badge) = ep_badge {
                if clean_title.ends_with(badge.as_str()) {
                    clean_title = clean_title[..clean_title.len() - badge.len()]
                        .trim()
                        .to_string();
                }
            }
            if clean_title.is_empty() {
                continue;
            }

            let group = format_day_group_from_url(&href);
            pages.push(PageLink {
                id: make_media_id(&href),
                url: href,
                title: clean_title,
                subtitle: ep_badge,
                thumbnail: thumb,
                group,
                source: Some("AnimeFLV".to_string()),
                score: None,
            });
        }
    }

    let next_page_url = doc
        .select(&sel(r#"a.next.page-numbers, link[rel="next"]"#))
        .next()
        .and_then(|el| resolve_url(el.value().attr("href"), url));

    if let Some(t) = h1_title {
        base.metadata.title = t;
    }
    if let Some(s) = synopsis {
        base.metadata.description = Some(s);
    }
    base.metadata.poster = poster_img;
    base.metadata.info_url = info_url;
    base.metadata.status = status_text;
    base.metadata.rating = rating_text;
    if !genres.is_empty() {
        base.metadata.genres = Some(genres);
    }

    ExtractionResult {
        adapter: "animeflv".to_string(),
        metadata: base.metadata,
        videos,
        images: base.images,
        pdfs: base.pdfs,
        pages,
        related: None,
        next_page_url,
    }
}
