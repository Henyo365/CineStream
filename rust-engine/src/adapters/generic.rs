use crate::types::{ExtractionResult, MediaItem, MediaType, PageLink, PageMetadata};
use crate::url_utils::{
    extract_filename, make_media_id, normalize_whitespace, pick_best_from_srcset, resolve_url,
};
use regex::Regex;
use scraper::{Html, Selector};
use std::collections::HashSet;
use std::sync::OnceLock;
use url::Url;

fn video_ext_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)\.(mp4|webm|m3u8|mov|mkv|m4v)(\?|#|$)").unwrap())
}

fn image_ext_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)\.(jpe?g|png|webp|gif|avif)(\?|#|$)").unwrap())
}

fn pdf_ext_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)\.pdf(\?|#|$)").unwrap())
}

fn video_embed_host_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)(youtube\.com|youtu\.be|vimeo\.com|dailymotion\.com|twitch\.tv|streamable\.com|ok\.ru|drive\.google\.com|vidyard|wistia|jwplayer|player\.|embed)").unwrap()
    })
}

fn sel(s: &str) -> Selector {
    Selector::parse(s).unwrap()
}

fn push_unique(list: &mut Vec<MediaItem>, seen: &mut HashSet<String>, item: MediaItem) {
    if seen.insert(item.url.clone()) {
        list.push(item);
    }
}

pub fn extract(url: &Url, html: &str) -> ExtractionResult {
    let doc = Html::parse_document(html);

    let meta_content = |selector_str: &str| -> Option<String> {
        let s = sel(selector_str);
        doc.select(&s)
            .next()
            .and_then(|el| el.value().attr("content"))
            .map(|c| c.trim().to_string())
            .filter(|c| !c.is_empty())
    };

    let title = meta_content(r#"meta[property="og:title"]"#)
        .or_else(|| {
            doc.select(&sel("title"))
                .next()
                .map(|el| normalize_whitespace(&el.text().collect::<String>()))
                .filter(|t| !t.is_empty())
        })
        .unwrap_or_else(|| url.host_str().unwrap_or("Web").to_string());

    let description = meta_content(r#"meta[property="og:description"]"#)
        .or_else(|| meta_content(r#"meta[name="description"]"#));

    let site_name = meta_content(r#"meta[property="og:site_name"]"#)
        .or_else(|| url.host_str().map(|s| s.to_string()));

    let raw_favicon = doc
        .select(&sel(r#"link[rel="icon"], link[rel="shortcut icon"]"#))
        .next()
        .and_then(|el| el.value().attr("href"))
        .unwrap_or("/favicon.ico");

    let metadata = PageMetadata {
        title: title.clone(),
        description,
        site_name,
        favicon: resolve_url(Some(raw_favicon), url),
        poster: None,
        backdrop: None,
        info_url: None,
        status: None,
        rating: None,
        year: None,
        duration: None,
        genres: None,
        source_url: url.to_string(),
    };

    let mut videos = Vec::new();
    let mut seen_videos = HashSet::new();
    let mut images = Vec::new();
    let mut seen_images = HashSet::new();
    let mut pdfs = Vec::new();
    let mut seen_pdfs = HashSet::new();

    // 1. OpenGraph / Twitter video meta tags
    let video_meta_sel = sel(
        r#"meta[property="og:video"], meta[property="og:video:url"], meta[property="og:video:secure_url"], meta[name="twitter:player:stream"]"#,
    );
    for el in doc.select(&video_meta_sel) {
        if let Some(resolved) = resolve_url(el.value().attr("content"), url) {
            push_unique(
                &mut videos,
                &mut seen_videos,
                MediaItem {
                    id: make_media_id(&resolved),
                    media_type: MediaType::Video,
                    title: Some(extract_filename(&resolved).unwrap_or_else(|| title.clone())),
                    url: resolved,
                    thumbnail: None,
                    mime_type: None,
                    is_embed: None,
                    source_tag: Some("meta".to_string()),
                },
            );
        }
    }

    // 2. <video> and <source>
    let source_sel = sel("source");
    for video_el in doc.select(&sel("video")) {
        let poster = resolve_url(video_el.value().attr("poster"), url);
        let direct_src = resolve_url(
            video_el
                .value()
                .attr("src")
                .or_else(|| video_el.value().attr("data-src")),
            url,
        );
        if let Some(src) = direct_src {
            let v_title = video_el
                .value()
                .attr("title")
                .map(|t| t.trim().to_string())
                .filter(|t| !t.is_empty())
                .or_else(|| extract_filename(&src))
                .unwrap_or_else(|| "Video".to_string());
            push_unique(
                &mut videos,
                &mut seen_videos,
                MediaItem {
                    id: make_media_id(&src),
                    media_type: MediaType::Video,
                    url: src,
                    title: Some(v_title),
                    thumbnail: poster.clone(),
                    mime_type: None,
                    is_embed: None,
                    source_tag: Some("video".to_string()),
                },
            );
        }
        for src_el in video_el.select(&source_sel) {
            let src_url = resolve_url(
                src_el
                    .value()
                    .attr("src")
                    .or_else(|| src_el.value().attr("data-src")),
                url,
            );
            if let Some(src) = src_url {
                push_unique(
                    &mut videos,
                    &mut seen_videos,
                    MediaItem {
                        id: make_media_id(&src),
                        media_type: MediaType::Video,
                        title: Some(extract_filename(&src).unwrap_or_else(|| "Video".to_string())),
                        url: src,
                        thumbnail: poster.clone(),
                        mime_type: src_el.value().attr("type").map(|t| t.trim().to_string()),
                        is_embed: None,
                        source_tag: Some("source".to_string()),
                    },
                );
            }
        }
    }

    // 3. Embedded <iframe>
    for iframe in doc.select(&sel("iframe")) {
        let src = match resolve_url(
            iframe
                .value()
                .attr("src")
                .or_else(|| iframe.value().attr("data-src")),
            url,
        ) {
            Some(s) => s,
            None => continue,
        };
        let frame_title = iframe
            .value()
            .attr("title")
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty());

        if pdf_ext_re().is_match(&src) {
            push_unique(
                &mut pdfs,
                &mut seen_pdfs,
                MediaItem {
                    id: make_media_id(&src),
                    media_type: MediaType::Pdf,
                    title: Some(
                        frame_title
                            .or_else(|| extract_filename(&src))
                            .unwrap_or_else(|| "Documento PDF".to_string()),
                    ),
                    url: src,
                    thumbnail: None,
                    mime_type: Some("application/pdf".to_string()),
                    is_embed: None,
                    source_tag: Some("iframe".to_string()),
                },
            );
        } else if video_ext_re().is_match(&src) || video_embed_host_re().is_match(&src) {
            let is_direct = video_ext_re().is_match(&src);
            push_unique(
                &mut videos,
                &mut seen_videos,
                MediaItem {
                    id: make_media_id(&src),
                    media_type: MediaType::Video,
                    url: src,
                    title: Some(frame_title.unwrap_or_else(|| "Video incrustado".to_string())),
                    thumbnail: None,
                    mime_type: None,
                    is_embed: Some(!is_direct),
                    source_tag: Some("iframe".to_string()),
                },
            );
        }
    }

    // 4. <embed> and <object> PDFs
    for el in doc.select(&sel("embed, object")) {
        let raw = el
            .value()
            .attr("src")
            .or_else(|| el.value().attr("data"));
        let resolved = match resolve_url(raw, url) {
            Some(r) => r,
            None => continue,
        };
        let type_attr = el.value().attr("type").unwrap_or("").to_lowercase();
        if type_attr.contains("pdf") || pdf_ext_re().is_match(&resolved) {
            push_unique(
                &mut pdfs,
                &mut seen_pdfs,
                MediaItem {
                    id: make_media_id(&resolved),
                    media_type: MediaType::Pdf,
                    title: Some(
                        extract_filename(&resolved).unwrap_or_else(|| "Documento PDF".to_string()),
                    ),
                    url: resolved,
                    thumbnail: None,
                    mime_type: Some("application/pdf".to_string()),
                    is_embed: None,
                    source_tag: Some(el.value().name().to_string()),
                },
            );
        }
    }

    // 5. OpenGraph / Twitter images
    for el in doc.select(&sel(
        r#"meta[property="og:image"], meta[name="twitter:image"]"#,
    )) {
        if let Some(resolved) = resolve_url(el.value().attr("content"), url) {
            push_unique(
                &mut images,
                &mut seen_images,
                MediaItem {
                    id: make_media_id(&resolved),
                    media_type: MediaType::Image,
                    title: Some(
                        extract_filename(&resolved)
                            .unwrap_or_else(|| "Imagen destacada".to_string()),
                    ),
                    url: resolved,
                    thumbnail: None,
                    mime_type: None,
                    is_embed: None,
                    source_tag: Some("meta".to_string()),
                },
            );
        }
    }

    // 6. <img> tags
    for img in doc.select(&sel("img")) {
        let w = img
            .value()
            .attr("width")
            .and_then(|v| v.parse::<i32>().ok())
            .unwrap_or(0);
        let h = img
            .value()
            .attr("height")
            .and_then(|v| v.parse::<i32>().ok())
            .unwrap_or(0);
        if (w > 0 && w <= 4) || (h > 0 && h <= 4) {
            continue;
        }

        let best = pick_best_from_srcset(img.value().attr("srcset"), url)
            .or_else(|| pick_best_from_srcset(img.value().attr("data-srcset"), url))
            .or_else(|| {
                resolve_url(
                    img.value()
                        .attr("data-original")
                        .or_else(|| img.value().attr("data-lazy-src"))
                        .or_else(|| img.value().attr("data-src"))
                        .or_else(|| img.value().attr("src")),
                    url,
                )
            });

        if let Some(final_url) = best {
            let alt = img
                .value()
                .attr("alt")
                .map(|a| a.trim().to_string())
                .filter(|a| !a.is_empty());
            push_unique(
                &mut images,
                &mut seen_images,
                MediaItem {
                    id: make_media_id(&final_url),
                    media_type: MediaType::Image,
                    title: Some(
                        alt.or_else(|| extract_filename(&final_url))
                            .unwrap_or_else(|| "Imagen".to_string()),
                    ),
                    url: final_url,
                    thumbnail: None,
                    mime_type: None,
                    is_embed: None,
                    source_tag: Some("img".to_string()),
                },
            );
        }
    }

    // 7. Direct <a> links to PDF/video/image
    for a in doc.select(&sel("a[href]")) {
        let resolved = match resolve_url(a.value().attr("href"), url) {
            Some(r) => r,
            None => continue,
        };
        let link_text = normalize_whitespace(&a.text().collect::<String>());
        let opt_text = if link_text.is_empty() {
            None
        } else {
            Some(link_text)
        };

        if pdf_ext_re().is_match(&resolved) {
            push_unique(
                &mut pdfs,
                &mut seen_pdfs,
                MediaItem {
                    id: make_media_id(&resolved),
                    media_type: MediaType::Pdf,
                    title: Some(
                        opt_text
                            .or_else(|| extract_filename(&resolved))
                            .unwrap_or_else(|| "Documento PDF".to_string()),
                    ),
                    url: resolved,
                    thumbnail: None,
                    mime_type: Some("application/pdf".to_string()),
                    is_embed: None,
                    source_tag: Some("a".to_string()),
                },
            );
        } else if video_ext_re().is_match(&resolved) {
            push_unique(
                &mut videos,
                &mut seen_videos,
                MediaItem {
                    id: make_media_id(&resolved),
                    media_type: MediaType::Video,
                    title: Some(
                        opt_text
                            .or_else(|| extract_filename(&resolved))
                            .unwrap_or_else(|| "Video".to_string()),
                    ),
                    url: resolved,
                    thumbnail: None,
                    mime_type: None,
                    is_embed: None,
                    source_tag: Some("a".to_string()),
                },
            );
        } else if image_ext_re().is_match(&resolved) {
            push_unique(
                &mut images,
                &mut seen_images,
                MediaItem {
                    id: make_media_id(&resolved),
                    media_type: MediaType::Image,
                    title: Some(
                        opt_text
                            .or_else(|| extract_filename(&resolved))
                            .unwrap_or_else(|| "Imagen".to_string()),
                    ),
                    url: resolved,
                    thumbnail: None,
                    mime_type: None,
                    is_embed: None,
                    source_tag: Some("a".to_string()),
                },
            );
        }
    }

    // 8. Article page links
    let mut pages = Vec::new();
    let mut seen_pages = HashSet::new();
    let img_sel = sel("img");
    for a in doc.select(&sel("article a[href]")) {
        let href = match resolve_url(a.value().attr("href"), url) {
            Some(h) if h != url.as_str() => h,
            _ => continue,
        };
        if let Ok(parsed) = Url::parse(&href) {
            if parsed.host_str() != url.host_str() {
                continue;
            }
        } else {
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
        let link_title = a
            .value()
            .attr("title")
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .or_else(|| {
                img.and_then(|im| im.value().attr("alt"))
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
            })
            .unwrap_or_else(|| normalize_whitespace(&a.text().collect::<String>()));

        if link_title.len() < 3 {
            continue;
        }

        pages.push(PageLink {
            id: make_media_id(&href),
            url: href,
            title: link_title,
            subtitle: None,
            thumbnail: thumb,
            group: None,
            source: None,
            score: None,
        });
    }

    ExtractionResult {
        adapter: "generic".to_string(),
        metadata,
        videos,
        images,
        pdfs,
        pages,
        related: None,
        next_page_url: None,
    }
}
