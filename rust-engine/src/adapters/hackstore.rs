use crate::adapters::generic;
use crate::types::{ExtractionResult, GenreTag, MediaItem, MediaType, PageLink};
use crate::url_utils::{make_media_id, normalize_whitespace, resolve_url};
use regex::Regex;
use scraper::{Html, Selector};
use std::collections::HashSet;
use std::sync::OnceLock;
use url::Url;

pub fn can_handle(url: &Url) -> bool {
    let host = url.host_str().unwrap_or("").to_lowercase();
    host == "hackstore.fo" || host.ends_with(".hackstore.fo") || host.contains("hackstore.")
}

fn sel(s: &str) -> Selector {
    Selector::parse(s).unwrap()
}

fn ep_num_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)(\d+x\d+|\d+)/?$").unwrap())
}

fn year_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?:A[ñn]o:\s*|\()((?:19|20)\d{2})").unwrap())
}

fn duration_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)Duraci[óo]n:\s*([^<\n|]{2,32})").unwrap())
}

fn backdrop_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r#"https?://image\.tmdb\.org/t/p/(?:original|w1280|w780)/[A-Za-z0-9_]+\.(?:jpg|webp|png)"#).unwrap()
    })
}

pub fn extract(url: &Url, html: &str) -> ExtractionResult {
    let mut base = generic::extract(url, html);
    let doc = Html::parse_document(html);

    let h1_title = doc
        .select(&sel("h1"))
        .next()
        .map(|el| normalize_whitespace(&el.text().collect::<String>()))
        .filter(|s| !s.is_empty());

    let poster_img = doc
        .select(&sel(
            ".poster img, .movie-poster img, .wp-post-image, img.imghacks, .movie-back img",
        ))
        .next()
        .and_then(|img| {
            resolve_url(
                img.value()
                    .attr("data-src")
                    .or_else(|| img.value().attr("data-lazy-src"))
                    .or_else(|| img.value().attr("src")),
                url,
            )
        })
        .or_else(|| base.images.first().map(|i| i.url.clone()));

    let backdrop_img = backdrop_re().find(html).map(|m| m.as_str().to_string());

    let synopsis = doc
        .select(&sel(".sinopsis p, .synopsis p, .entry-content p, .description p"))
        .map(|p| normalize_whitespace(&p.text().collect::<String>()))
        .find(|t| t.len() > 40)
        .or_else(|| base.metadata.description.clone());

    let year = year_re()
        .captures(html)
        .and_then(|c| c.get(1).map(|m| m.as_str().to_string()));

    let duration = duration_re()
        .captures(html)
        .and_then(|c| c.get(1).map(|m| normalize_whitespace(m.as_str())))
        .filter(|s| !s.is_empty());

    // Extract clickable genres (/genero/...)
    let mut genres: Vec<GenreTag> = Vec::new();
    let mut seen_genres = HashSet::new();
    for a in doc.select(&sel(r#"a[href*="/genero/"]"#)) {
        let label = normalize_whitespace(&a.text().collect::<String>());
        if label.is_empty() || label.len() > 32 {
            continue;
        }
        if seen_genres.insert(label.to_lowercase()) {
            let g_url = resolve_url(a.value().attr("href"), url);
            genres.push(GenreTag { label, url: g_url });
        }
    }

    // 1. Video servers (a.playr[data-player-src] + #intesx + trailer)
    let mut videos = Vec::new();
    let mut seen_videos = HashSet::new();

    for (idx, el) in doc
        .select(&sel("a.playr[data-player-src], [data-player-src]"))
        .enumerate()
    {
        let src = match resolve_url(el.value().attr("data-player-src"), url) {
            Some(s) => s,
            None => continue,
        };
        if !seen_videos.insert(src.clone()) {
            continue;
        }
        let label = normalize_whitespace(&el.text().collect::<String>());
        videos.push(MediaItem {
            id: make_media_id(&src),
            media_type: MediaType::Video,
            url: src,
            title: Some(if label.is_empty() {
                format!("Servidor {}", idx + 1)
            } else {
                label
            }),
            thumbnail: poster_img.clone(),
            mime_type: None,
            is_embed: Some(true),
            source_tag: Some("playr".to_string()),
        });
    }

    for (idx, el) in doc
        .select(&sel("iframe#intesx, .video iframe, .playrn iframe"))
        .enumerate()
    {
        let src = match resolve_url(
            el.value().attr("src").or_else(|| el.value().attr("data-src")),
            url,
        ) {
            Some(s) => s,
            None => continue,
        };
        if !seen_videos.insert(src.clone()) {
            continue;
        }
        let title = if videos.is_empty() && idx == 0 {
            "Reproductor Principal".to_string()
        } else {
            format!("Reproductor {}", videos.len() + 1)
        };
        videos.push(MediaItem {
            id: make_media_id(&src),
            media_type: MediaType::Video,
            url: src,
            title: Some(title),
            thumbnail: poster_img.clone(),
            mime_type: None,
            is_embed: Some(true),
            source_tag: Some("iframe".to_string()),
        });
    }

    for v in base.videos {
        if v.url.contains("facebook.com/") {
            continue;
        }
        if seen_videos.insert(v.url.clone()) {
            let is_yt = v.url.contains("youtube.com") || v.url.contains("youtu.be");
            videos.push(MediaItem {
                title: if is_yt {
                    Some("Tráiler (YouTube)".to_string())
                } else {
                    v.title
                },
                ..v
            });
        }
    }

    // 2. Series episodes (/episodio/...)
    let mut pages = Vec::new();
    let mut seen_pages = HashSet::new();
    let img_sel = sel("img");

    for a in doc.select(&sel(r#"a[href*="/episodio/"]"#)) {
        let href = match resolve_url(a.value().attr("href"), url) {
            Some(h) if h != url.as_str() => h,
            _ => continue,
        };
        if !seen_pages.insert(href.clone()) {
            continue;
        }
        let thumb = a
            .select(&img_sel)
            .next()
            .and_then(|im| {
                resolve_url(
                    im.value()
                        .attr("data-src")
                        .or_else(|| im.value().attr("data-lazy-src"))
                        .or_else(|| im.value().attr("src")),
                    url,
                )
            })
            .or_else(|| poster_img.clone());

        let title = if let Some(caps) = ep_num_re().captures(&href) {
            format!("Episodio {}", &caps[1])
        } else {
            a.value()
                .attr("title")
                .map(normalize_whitespace)
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "Episodio".to_string())
        };

        pages.push(PageLink {
            id: make_media_id(&href),
            url: href,
            title,
            subtitle: None,
            thumbnail: thumb,
            group: None,
            source: Some("Hackstore".to_string()),
            score: None,
        });
    }

    // 3. Related movies / series (.yarpp-related) — keep separate so detail screen renders a carousel!
    let mut related = Vec::new();
    let mut seen_related = HashSet::new();
    for rel_a in doc.select(&sel(".yarpp-related a[href]")) {
        let href = match resolve_url(rel_a.value().attr("href"), url) {
            Some(h) if h != url.as_str() => h,
            _ => continue,
        };
        if !seen_related.insert(href.clone()) {
            continue;
        }
        let img = rel_a.select(&img_sel).next();
        let thumb = img.and_then(|im| {
            resolve_url(
                im.value()
                    .attr("data-src")
                    .or_else(|| im.value().attr("data-lazy-src"))
                    .or_else(|| im.value().attr("src")),
                url,
            )
        });
        let title = rel_a
            .value()
            .attr("title")
            .map(normalize_whitespace)
            .filter(|s| !s.is_empty())
            .or_else(|| {
                img.and_then(|im| im.value().attr("alt"))
                    .map(normalize_whitespace)
                    .filter(|s| !s.is_empty())
            })
            .unwrap_or_else(|| normalize_whitespace(&rel_a.text().collect::<String>()));
        if title.len() < 2 {
            continue;
        }
        related.push(PageLink {
            id: make_media_id(&href),
            url: href,
            title,
            subtitle: None,
            thumbnail: thumb,
            group: None,
            source: Some("Hackstore".to_string()),
            score: None,
        });
    }

    // 4. Catalog cards (.poster / .poster-pad) — skip items already inside .yarpp-related on detail pages
    let link_sel = sel("a[href]");
    let title_sel = sel(".movie-title2, .movie-title, .title, h2, h3");
    let qual_sel = sel(".calidad, .quality, .year");

    if videos.is_empty() && pages.is_empty() {
        for poster in doc.select(&sel(".poster, .poster-pad")) {
            let a = match poster.select(&link_sel).next() {
                Some(a) => a,
                None => continue,
            };
            let href = match resolve_url(a.value().attr("href"), url) {
                Some(h) if h != url.as_str() => h,
                _ => continue,
            };
            if seen_related.contains(&href) || !seen_pages.insert(href.clone()) {
                continue;
            }
            let img = poster.select(&img_sel).next();
            let thumb = img.and_then(|im| {
                resolve_url(
                    im.value()
                        .attr("data-src")
                        .or_else(|| im.value().attr("data-lazy-src"))
                        .or_else(|| im.value().attr("src")),
                    url,
                )
            });

            let parent = poster.parent().and_then(scraper::ElementRef::wrap);
            let title = parent
                .and_then(|p| {
                    p.select(&title_sel)
                        .next()
                        .map(|t| normalize_whitespace(&t.text().collect::<String>()))
                        .filter(|s| !s.is_empty())
                })
                .or_else(|| {
                    img.and_then(|im| im.value().attr("alt"))
                        .map(normalize_whitespace)
                        .filter(|s| !s.is_empty())
                })
                .or_else(|| {
                    a.value()
                        .attr("title")
                        .map(normalize_whitespace)
                        .filter(|s| !s.is_empty())
                });

            let title = match title {
                Some(t) if !t.is_empty() => t,
                _ => continue,
            };

            let quality = parent.and_then(|p| {
                p.select(&qual_sel)
                    .next()
                    .map(|q| normalize_whitespace(&q.text().collect::<String>()))
                    .filter(|s| !s.is_empty())
            });

            pages.push(PageLink {
                id: make_media_id(&href),
                url: href,
                title,
                subtitle: quality,
                thumbnail: thumb,
                group: None,
                source: Some("Hackstore".to_string()),
                score: None,
            });
        }

        // Fallback if cards weren't in .poster
        if pages.is_empty() {
            for a in doc.select(&sel("a.movie-title2[href], article a[href]")) {
                let href = match resolve_url(a.value().attr("href"), url) {
                    Some(h) if h != url.as_str() => h,
                    _ => continue,
                };
                if seen_related.contains(&href) || !seen_pages.insert(href.clone()) {
                    continue;
                }
                let title = normalize_whitespace(&a.text().collect::<String>());
                let title = if title.len() >= 2 {
                    title
                } else {
                    match a
                        .value()
                        .attr("title")
                        .map(normalize_whitespace)
                        .filter(|s| s.len() >= 2)
                    {
                        Some(t) => t,
                        None => continue,
                    }
                };
                let thumb = a.select(&img_sel).next().and_then(|im| {
                    resolve_url(
                        im.value().attr("data-src").or_else(|| im.value().attr("src")),
                        url,
                    )
                });
                pages.push(PageLink {
                    id: make_media_id(&href),
                    url: href,
                    title,
                    subtitle: None,
                    thumbnail: thumb,
                    group: None,
                    source: Some("Hackstore".to_string()),
                    score: None,
                });
            }
        }
    }

    let next_page_url = doc
        .select(&sel(r#"a.next.page-numbers, link[rel="next"]"#))
        .next()
        .and_then(|el| resolve_url(el.value().attr("href"), url));

    if let Some(t) = h1_title {
        base.metadata.title = t;
    }
    base.metadata.description = synopsis;
    base.metadata.poster = poster_img;
    base.metadata.backdrop = backdrop_img;
    base.metadata.year = year;
    base.metadata.duration = duration;
    if !genres.is_empty() {
        base.metadata.genres = Some(genres);
    }

    ExtractionResult {
        adapter: "hackstore".to_string(),
        metadata: base.metadata,
        videos,
        images: base.images,
        pdfs: base.pdfs,
        pages,
        related: if related.is_empty() { None } else { Some(related) },
        next_page_url,
    }
}
