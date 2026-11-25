use crate::adapters::generic;
use crate::types::{ExtractionResult, GenreTag, MediaItem, MediaType, PageLink};
use crate::url_utils::{make_media_id, normalize_whitespace, resolve_url};
use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD};
use base64::Engine;
use regex::Regex;
use scraper::{Html, Selector};
use serde::Deserialize;
use std::collections::HashSet;
use std::sync::OnceLock;
use url::Url;

pub fn can_handle(url: &Url) -> bool {
    let host = url.host_str().unwrap_or("").to_lowercase();
    host == "jkanime.net" || host.ends_with(".jkanime.net")
}

fn sel(s: &str) -> Selector {
    Selector::parse(s).unwrap()
}

fn decode_b64_url(encoded: &str) -> Option<String> {
    let raw = encoded.trim();
    if raw.is_empty() {
        return None;
    }
    let bytes = STANDARD
        .decode(raw)
        .or_else(|_| STANDARD_NO_PAD.decode(raw.trim_end_matches('=')))
        .ok()?;
    let decoded = String::from_utf8(bytes).ok()?;
    let parsed = Url::parse(decoded.trim()).ok()?;
    if matches!(parsed.scheme(), "http" | "https") {
        Some(parsed.to_string())
    } else {
        None
    }
}

fn video_iframe_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"video\[\d+\]\s*=\s*'<iframe[^>]+src="([^"]+)""#).unwrap())
}

fn servers_json_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?s)var\s+servers\s*=\s*(\[\{.*?\}\])\s*;").unwrap())
}

fn jkdefault_poster_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"var\s+jkdefault\s*=\s*"(https?://[^"]+)""#).unwrap())
}

fn animes_dir_json_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?s)var\s+animes\s*=\s*(\{.*?\})\s*;").unwrap())
}

fn year_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\b((?:19|20)\d{2})\b").unwrap())
}

fn trailing_ep_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"/(\d+)/?$").unwrap())
}

#[derive(Deserialize)]
struct JkServerEntry {
    remote: Option<String>,
    server: Option<String>,
    lang: Option<u8>,
}

#[derive(Deserialize)]
struct JkDirItem {
    title: Option<String>,
    image: Option<String>,
    url: Option<String>,
    estado: Option<String>,
    tipo: Option<String>,
}

#[derive(Deserialize)]
struct JkDirPayload {
    data: Option<Vec<JkDirItem>>,
    next_page_url: Option<String>,
}

fn is_reserved_jk_path(path: &str) -> bool {
    let trimmed = path.trim_matches('/').to_lowercase();
    if trimmed.is_empty() {
        return true;
    }
    let first = trimmed.split('/').next().unwrap_or("");
    matches!(
        first,
        "directorio"
            | "buscar"
            | "horario"
            | "top"
            | "estrenos"
            | "genero"
            | "studio"
            | "idioma"
            | "usuario"
            | "dash"
            | "guardado"
            | "historial"
            | "notificaciones"
            | "comunidad"
            | "pedidos"
            | "aplicacion"
            | "salir"
            | "ajax"
            | "jkplayer"
    )
}

pub fn extract(url: &Url, html: &str) -> ExtractionResult {
    let mut base = generic::extract(url, html);
    let doc = Html::parse_document(html);

    let has_jk_videos = video_iframe_re().is_match(html) || servers_json_re().is_match(html);
    let is_detail_dom = doc
        .select(&sel(".anime__details__content, .anime_info"))
        .next()
        .is_some();

    // 1. Episode page (has var video[...] or var servers = [...])
    if has_jk_videos {
        let poster_img = jkdefault_poster_re()
            .captures(html)
            .and_then(|c| c.get(1).map(|m| m.as_str().to_string()))
            .or_else(|| base.metadata.poster.clone())
            .or_else(|| base.images.first().map(|i| i.url.clone()));

        let mut info_url: Option<String> = doc
            .select(&sel("#marcar_visto[data-anime], #guardar-capitulo[data-anime]"))
            .next()
            .and_then(|el| el.value().attr("data-anime"))
            .map(|slug| format!("https://jkanime.net/{}/", slug.trim_matches('/')));

        if info_url.is_none() {
            let parts: Vec<&str> = url.path().trim_matches('/').split('/').collect();
            if parts.len() >= 2 && !is_reserved_jk_path(parts[0]) {
                info_url = Some(format!("https://jkanime.net/{}/", parts[0]));
            }
        }

        let ep_title = doc
            .select(&sel(".breadcrumb__links span, h1"))
            .next()
            .map(|el| normalize_whitespace(&el.text().collect::<String>()))
            .filter(|s| !s.is_empty())
            .or_else(|| {
                let el = doc.select(&sel("#marcar_visto")).next()?;
                let t = el.value().attr("data-title")?;
                let n = el.value().attr("data-numero")?;
                Some(format!("{t} - Episodio {n}"))
            });

        let mut videos: Vec<MediaItem> = Vec::new();
        let mut seen_videos: HashSet<String> = HashSet::new();

        let mut jk_iframes: Vec<String> = video_iframe_re()
            .captures_iter(html)
            .filter_map(|caps| resolve_url(caps.get(1).map(|m| m.as_str()), url))
            .collect();
        // Prefer lightweight direct VideoJS HLS (jkplayer/umv "Magi") before P2P (um "Desu")
        jk_iframes.sort_by_key(|u| {
            if u.contains("/jkplayer/umv") {
                0
            } else if u.contains("/jkplayer/um") {
                1
            } else {
                2
            }
        });

        for (idx, resolved) in jk_iframes.into_iter().enumerate() {
            if !seen_videos.insert(resolved.clone()) {
                continue;
            }
            let server_label = if resolved.contains("/jkplayer/umv") {
                "Magi ★ JKPlayer HD".to_string()
            } else if resolved.contains("/jkplayer/um") {
                "Desu ★ JKPlayer HD".to_string()
            } else {
                format!("JKPlayer {}", idx + 1)
            };
            videos.push(MediaItem {
                id: make_media_id(&resolved),
                media_type: MediaType::Video,
                url: resolved,
                title: Some(server_label),
                thumbnail: poster_img.clone(),
                mime_type: None,
                is_embed: Some(true),
                source_tag: Some("jkplayer".to_string()),
            });
        }

        if let Some(caps) = servers_json_re().captures(html) {
            if let Ok(mut entries) = serde_json::from_str::<Vec<JkServerEntry>>(&caps[1]) {
                // Prioritize servers that resolve to direct native MP4/HLS streams over embed-only Mega
                entries.sort_by_key(|e| {
                    let s = e.server.as_deref().unwrap_or("").to_lowercase();
                    if s.contains("voe") || s.contains("mp4upload") || s.contains("mixdrop") {
                        0
                    } else if s.contains("streamwish")
                        || s.contains("vidhide")
                        || s.contains("filemoon")
                    {
                        1
                    } else if s.contains("mega") {
                        3
                    } else {
                        2
                    }
                });
                for entry in entries {
                    let remote_b64 = match entry.remote.as_deref() {
                        Some(r) => r,
                        None => continue,
                    };
                    let decoded = match decode_b64_url(remote_b64) {
                        Some(u) => u,
                        None => continue,
                    };
                    let lower = decoded.to_lowercase();
                    // Skip raw file-hosting download pages that are not stream/embed players
                    if lower.contains("mediafire.com/file/") || lower.contains("1fichier.com") {
                        continue;
                    }
                    if !seen_videos.insert(decoded.clone()) {
                        continue;
                    }
                    let srv_name = entry
                        .server
                        .map(|s| normalize_whitespace(&s))
                        .filter(|s| !s.is_empty())
                        .unwrap_or_else(|| "Servidor".to_string());
                    let lang_tag = match entry.lang {
                        Some(2) => " [Inglés]",
                        Some(3) => " [Latino]",
                        Some(4) => " [Castellano]",
                        _ => "",
                    };
                    let is_direct_m3u8 = lower.contains(".m3u8");
                    let is_direct_mp4 = lower.ends_with(".mp4");
                    let is_direct = is_direct_m3u8 || is_direct_mp4;

                    videos.push(MediaItem {
                        id: make_media_id(&decoded),
                        media_type: MediaType::Video,
                        url: decoded,
                        title: Some(format!(
                            "{srv_name}{lang_tag}{}",
                            if is_direct { " ★ Nativo" } else { "" }
                        )),
                        thumbnail: poster_img.clone(),
                        mime_type: if is_direct_m3u8 {
                            Some("application/x-mpegURL".to_string())
                        } else {
                            None
                        },
                        is_embed: Some(!is_direct),
                        source_tag: Some("jk_remote".to_string()),
                    });
                }
            }
        }

        if let Some(t) = ep_title {
            base.metadata.title = t;
        }
        base.metadata.poster = poster_img;
        base.metadata.info_url = info_url;

        return ExtractionResult {
            adapter: "jkanime".to_string(),
            metadata: base.metadata,
            videos,
            images: base.images,
            pdfs: Vec::new(),
            pages: Vec::new(),
            related: None,
            next_page_url: None,
        };
    }

    // 2. Anime Detail page (/.anime__details__content)
    if is_detail_dom {
        let title = doc
            .select(&sel(".anime_info h3, h1"))
            .next()
            .map(|el| normalize_whitespace(&el.text().collect::<String>()))
            .filter(|s| !s.is_empty());

        let synopsis = doc
            .select(&sel(".anime_info p.scroll, .anime_info p"))
            .next()
            .map(|el| normalize_whitespace(&el.text().collect::<String>()))
            .filter(|s| !s.is_empty());

        let poster_img = doc
            .select(&sel(".anime_pic img, .movpic img"))
            .next()
            .and_then(|img| {
                resolve_url(
                    img.value()
                        .attr("src")
                        .or_else(|| img.value().attr("data-src")),
                    url,
                )
            })
            .or_else(|| base.metadata.poster.clone());

        let mut status: Option<String> = None;
        let mut rating: Option<String> = None;
        let mut duration: Option<String> = None;
        let mut year: Option<String> = None;
        let mut total_episodes: usize = 0;

        let span_sel = sel("span");
        for li in doc.select(&sel(".anime_data li")) {
            let label = li
                .select(&span_sel)
                .next()
                .map(|s| normalize_whitespace(&s.text().collect::<String>()).to_lowercase())
                .unwrap_or_default();
            let full_text = normalize_whitespace(&li.text().collect::<String>());
            let val = full_text
                .split_once(':')
                .map(|(_, rest)| rest.trim().to_string())
                .unwrap_or_default();
            if val.is_empty() {
                continue;
            }
            if label.starts_with("estado") && status.is_none() {
                status = Some(val);
            } else if (label.starts_with("puntuac") || label.starts_with("rating"))
                && rating.is_none()
            {
                rating = Some(val);
            } else if label.starts_with("durac") && duration.is_none() {
                duration = Some(val);
            } else if label.starts_with("emitido") && year.is_none() {
                year = year_re()
                    .captures(&val)
                    .and_then(|c| c.get(1).map(|m| m.as_str().to_string()));
            } else if label.starts_with("episodios") && total_episodes == 0 {
                if let Ok(n) = val.parse::<usize>() {
                    total_episodes = n;
                }
            }
        }

        let mut genres: Vec<GenreTag> = Vec::new();
        let mut seen_genres = HashSet::new();
        for a in doc.select(&sel(r#".anime_data a[href*="/genero/"]"#)) {
            let label = normalize_whitespace(&a.text().collect::<String>());
            if !label.is_empty() && seen_genres.insert(label.to_lowercase()) {
                let g_url = resolve_url(a.value().attr("href"), url);
                genres.push(GenreTag { label, url: g_url });
            }
        }

        // Determine episode list from #uep (latest episode) and/or Episodios count
        let slug = url.path().trim_matches('/').split('/').next().unwrap_or("");
        let mut uep_href: Option<String> = None;
        let mut uep_num: usize = 0;

        if let Some(uep_el) = doc.select(&sel("a#uep[href]")).next() {
            if let Some(resolved) = resolve_url(uep_el.value().attr("href"), url) {
                if let Some(caps) = trailing_ep_re().captures(&resolved) {
                    if let Ok(n) = caps[1].parse::<usize>() {
                        uep_num = n;
                    }
                }
                uep_href = Some(resolved);
            }
        }

        let max_ep = total_episodes.max(uep_num).min(2000);
        let mut pages: Vec<PageLink> = Vec::new();
        let mut seen_pages: HashSet<String> = HashSet::new();

        if max_ep > 0 && !slug.is_empty() {
            for ep_num in (1..=max_ep).rev() {
                let ep_url = format!("https://jkanime.net/{slug}/{ep_num}/");
                if seen_pages.insert(ep_url.clone()) {
                    pages.push(PageLink {
                        id: make_media_id(&ep_url),
                        url: ep_url,
                        title: format!("Capítulo {ep_num}"),
                        subtitle: Some(format!("EP {ep_num}")),
                        thumbnail: poster_img.clone(),
                        group: None,
                        source: Some("JKAnime".to_string()),
                        score: None,
                    });
                }
            }
        } else if let Some(special_href) = uep_href {
            if seen_pages.insert(special_href.clone()) {
                pages.push(PageLink {
                    id: make_media_id(&special_href),
                    url: special_href,
                    title: "Episodio 1".to_string(),
                    subtitle: Some("EP 1".to_string()),
                    thumbnail: poster_img.clone(),
                    group: None,
                    source: Some("JKAnime".to_string()),
                    score: None,
                });
            }
        } else if !slug.is_empty() {
            let fallback_ep = format!("https://jkanime.net/{slug}/1/");
            pages.push(PageLink {
                id: make_media_id(&fallback_ep),
                url: fallback_ep,
                title: "Capítulo 1".to_string(),
                subtitle: Some("EP 1".to_string()),
                thumbnail: poster_img.clone(),
                group: None,
                source: Some("JKAnime".to_string()),
                score: None,
            });
        }

        // Related seasons / prequels / sequels
        let mut related: Vec<PageLink> = Vec::new();
        let mut seen_related = HashSet::new();
        for a in doc.select(&sel(".temporadas_tab a[href]")) {
            let href = match resolve_url(a.value().attr("href"), url) {
                Some(h) if h != url.as_str() => h,
                _ => continue,
            };
            let parsed = match Url::parse(&href) {
                Ok(p) => p,
                Err(_) => continue,
            };
            if !can_handle(&parsed) || is_reserved_jk_path(parsed.path()) {
                continue;
            }
            if !seen_related.insert(href.clone()) {
                continue;
            }
            let rel_title = normalize_whitespace(&a.text().collect::<String>());
            if rel_title.len() < 2 {
                continue;
            }
            let rel_slug = parsed.path().trim_matches('/');
            let inferred_thumb = if !rel_slug.contains('/') {
                Some(format!(
                    "https://cdn.jkdesa.com/assets/images/animes/image/{rel_slug}.jpg"
                ))
            } else {
                None
            };
            related.push(PageLink {
                id: make_media_id(&href),
                url: href,
                title: rel_title,
                subtitle: None,
                thumbnail: inferred_thumb,
                group: None,
                source: Some("JKAnime".to_string()),
                score: None,
            });
        }

        if let Some(t) = title {
            base.metadata.title = t;
        }
        if let Some(s) = synopsis {
            base.metadata.description = Some(s);
        }
        base.metadata.poster = poster_img;
        base.metadata.status = status;
        base.metadata.rating = rating;
        base.metadata.duration = duration;
        base.metadata.year = year;
        if !genres.is_empty() {
            base.metadata.genres = Some(genres);
        }

        return ExtractionResult {
            adapter: "jkanime".to_string(),
            metadata: base.metadata,
            videos: Vec::new(),
            images: base.images,
            pdfs: Vec::new(),
            pages,
            related: if related.is_empty() {
                None
            } else {
                Some(related)
            },
            next_page_url: None,
        };
    }

    // 3. Catalog: Home, Directory, Search, Genres, Top
    let mut pages: Vec<PageLink> = Vec::new();
    let mut seen_pages: HashSet<String> = HashSet::new();
    let mut next_page_url: Option<String> = None;

    // 3a. Directory JSON (`var animes = {...};`)
    if let Some(caps) = animes_dir_json_re().captures(html) {
        if let Ok(payload) = serde_json::from_str::<JkDirPayload>(&caps[1]) {
            if let Some(np) = payload.next_page_url {
                next_page_url = resolve_url(Some(&np), url);
            }
            for item in payload.data.unwrap_or_default() {
                let href = match resolve_url(item.url.as_deref(), url) {
                    Some(h) => h,
                    None => continue,
                };
                if !seen_pages.insert(href.clone()) {
                    continue;
                }
                let title = match item.title.map(|t| normalize_whitespace(&t)) {
                    Some(t) if !t.is_empty() => t,
                    _ => continue,
                };
                let subtitle = match (item.tipo, item.estado) {
                    (Some(tp), Some(st)) if !tp.is_empty() && !st.is_empty() => {
                        Some(format!("{tp} • {st}"))
                    }
                    (Some(tp), _) if !tp.is_empty() => Some(tp),
                    (_, Some(st)) if !st.is_empty() => Some(st),
                    _ => None,
                };
                pages.push(PageLink {
                    id: make_media_id(&href),
                    url: href,
                    title,
                    subtitle,
                    thumbnail: item.image,
                    group: None,
                    source: Some("JKAnime".to_string()),
                    score: None,
                });
            }
        }
    }

    // 3b. Homepage programming cards (#animes, #donghuas, #ovas — deliberately skip #hentai tab!)
    let card_a_sel = sel(".card a[href]");
    let img_sel = sel("img");
    let title_h5_sel = sel(".card-title, h5");
    let ep_badge_sel = sel(".badge-primary");
    let day_badge_sel = sel(".badge-secondary");

    for pane_selector in ["#animes", "#donghuas", "#ovas"] {
        for pane in doc.select(&sel(pane_selector)) {
            for a in pane.select(&card_a_sel) {
                let href = match resolve_url(a.value().attr("href"), url) {
                    Some(h) if h != url.as_str() => h,
                    _ => continue,
                };
                if !seen_pages.insert(href.clone()) {
                    continue;
                }
                let img = a.select(&img_sel).next();
                let thumb = img.and_then(|im| {
                    resolve_url(
                        im.value()
                            .attr("data-animepic")
                            .or_else(|| im.value().attr("data-src"))
                            .or_else(|| im.value().attr("src")),
                        url,
                    )
                });
                let title = a
                    .select(&title_h5_sel)
                    .next()
                    .map(|el| normalize_whitespace(&el.text().collect::<String>()))
                    .filter(|s| !s.is_empty())
                    .or_else(|| {
                        img.and_then(|im| im.value().attr("alt"))
                            .map(normalize_whitespace)
                            .filter(|s| !s.is_empty())
                    });
                let title = match title {
                    Some(t) => t,
                    None => continue,
                };
                let ep_badge = a
                    .select(&ep_badge_sel)
                    .next()
                    .map(|el| normalize_whitespace(&el.text().collect::<String>()))
                    .filter(|s| !s.is_empty());
                let group = a
                    .select(&day_badge_sel)
                    .next()
                    .map(|el| normalize_whitespace(&el.text().collect::<String>()))
                    .filter(|s| !s.is_empty());

                pages.push(PageLink {
                    id: make_media_id(&href),
                    url: href,
                    title,
                    subtitle: ep_badge,
                    thumbnail: thumb,
                    group,
                    source: Some("JKAnime".to_string()),
                    score: None,
                });
            }
        }
    }

    // 3c. Search / Genre / Top cards (.anime__item)
    let item_link_sel = sel("a[href]");
    let pic_sel = sel(".anime__item__pic");
    let item_title_sel = sel(".anime__item__text h5 a, h5 a, h5");
    let li_sel = sel(".anime__item__text ul li");

    for item_el in doc.select(&sel(".anime__item")) {
        let a = match item_el.select(&item_link_sel).next() {
            Some(el) => el,
            None => continue,
        };
        let href = match resolve_url(a.value().attr("href"), url) {
            Some(h) if h != url.as_str() => h,
            _ => continue,
        };
        let parsed = match Url::parse(&href) {
            Ok(p) => p,
            Err(_) => continue,
        };
        if !can_handle(&parsed) || is_reserved_jk_path(parsed.path()) {
            continue;
        }
        if !seen_pages.insert(href.clone()) {
            continue;
        }
        let thumb = item_el
            .select(&pic_sel)
            .next()
            .and_then(|p| resolve_url(p.value().attr("data-setbg"), url))
            .or_else(|| {
                item_el
                    .select(&img_sel)
                    .next()
                    .and_then(|im| resolve_url(im.value().attr("src"), url))
            });

        let title = item_el
            .select(&item_title_sel)
            .next()
            .map(|el| normalize_whitespace(&el.text().collect::<String>()))
            .filter(|s| !s.is_empty());
        let title = match title {
            Some(t) => t,
            None => continue,
        };

        let badges: Vec<String> = item_el
            .select(&li_sel)
            .map(|li| normalize_whitespace(&li.text().collect::<String>()))
            .filter(|s| !s.is_empty())
            .collect();
        let subtitle = if badges.is_empty() {
            None
        } else {
            Some(badges.join(" • "))
        };

        pages.push(PageLink {
            id: make_media_id(&href),
            url: href,
            title,
            subtitle,
            thumbnail: thumb,
            group: None,
            source: Some("JKAnime".to_string()),
            score: None,
        });
    }

    if next_page_url.is_none() {
        next_page_url = doc
            .select(&sel(r#"a[rel="next"], a.page-link[rel="next"], a.next"#))
            .next()
            .and_then(|el| resolve_url(el.value().attr("href"), url));
    }

    ExtractionResult {
        adapter: "jkanime".to_string(),
        metadata: base.metadata,
        videos: Vec::new(),
        images: base.images,
        pdfs: Vec::new(),
        pages,
        related: None,
        next_page_url,
    }
}
