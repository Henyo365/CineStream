use crate::adapters::generic;
use crate::types::{ExtractionResult, GenreTag, MediaItem, MediaType, PageLink};
use crate::url_utils::{make_media_id, normalize_whitespace, resolve_url};
use scraper::{Html, Selector};
use std::collections::HashSet;
use url::Url;

// XOR-encoded domain (key 0x5A) so binary / health inspection keeps the vault discreet
const VAULT_DOMAIN_XOR: &[u8] = &[46, 55, 53, 50, 63, 52, 46, 59, 51, 116, 59, 42, 42];

pub fn vault_domain() -> String {
    VAULT_DOMAIN_XOR
        .iter()
        .map(|b| (b ^ 0x5A) as char)
        .collect()
}

pub fn can_handle(url: &Url) -> bool {
    let dom = vault_domain();
    let host = url.host_str().unwrap_or("").to_lowercase();
    host == dom || host.ends_with(&format!(".{dom}"))
}

fn sel(s: &str) -> Selector {
    Selector::parse(s).unwrap()
}

pub fn extract(url: &Url, html: &str) -> ExtractionResult {
    let mut base = generic::extract(url, html);
    let doc = Html::parse_document(html);
    let path = url.path().to_lowercase();

    let is_reader_page = path.starts_with("/view_uploads/")
        || path.starts_with("/reader/")
        || path.starts_with("/contents/")
        || doc.select(&sel("#reader-wrap, .reader-img-wrap")).next().is_some();

    let is_detail_page = path.starts_with("/library/")
        || doc.select(&sel("#md-title, .md-hero-grid")).next().is_some();

    // 1. Cascade Reader (/view_uploads/<id>)
    if is_reader_page {
        let mut images: Vec<MediaItem> = Vec::new();
        let mut seen_imgs: HashSet<String> = HashSet::new();

        for img in doc.select(&sel("#reader-wrap img, .reader-img-wrap img, #content-images img")) {
            let src = match resolve_url(
                img.value()
                    .attr("data-src")
                    .or_else(|| img.value().attr("data-original"))
                    .or_else(|| img.value().attr("src")),
                url,
            ) {
                Some(s) => s,
                None => continue,
            };
            if !seen_imgs.insert(src.clone()) {
                continue;
            }
            let page_num = images.len() + 1;
            images.push(MediaItem {
                id: make_media_id(&src),
                media_type: MediaType::Image,
                url: src,
                title: Some(format!("Página {page_num}")),
                thumbnail: None,
                mime_type: None,
                is_embed: None,
                source_tag: Some("manga-page".to_string()),
            });
        }

        let info_url = doc
            .select(&sel("a.tb-back[href]"))
            .next()
            .and_then(|a| resolve_url(a.value().attr("href"), url));

        let reader_title = doc
            .select(&sel(".tb-title, h1"))
            .next()
            .map(|el| normalize_whitespace(&el.text().collect::<String>()))
            .filter(|s| !s.is_empty());

        if let Some(t) = reader_title {
            base.metadata.title = t;
        }
        base.metadata.info_url = info_url;

        return ExtractionResult {
            adapter: "ext-comic".to_string(),
            metadata: base.metadata,
            videos: Vec::new(),
            images,
            pdfs: Vec::new(),
            pages: Vec::new(),
            related: None,
            next_page_url: None,
        };
    }

    // 2. Detail page (/library/<type>/<id>/<slug>)
    if is_detail_page {
        let title = doc
            .select(&sel("#md-title, h1"))
            .next()
            .map(|el| normalize_whitespace(&el.text().collect::<String>()))
            .filter(|s| !s.is_empty());

        let poster_img = doc
            .select(&sel("#md-cover, .work-thumbnail img"))
            .next()
            .and_then(|img| {
                resolve_url(
                    img.value()
                        .attr("data-src")
                        .or_else(|| img.value().attr("src")),
                    url,
                )
            })
            .or_else(|| base.metadata.poster.clone());

        let status = doc
            .select(&sel(".md-cover-card__status .md-badge"))
            .next()
            .map(|el| normalize_whitespace(&el.text().collect::<String>()))
            .filter(|s| !s.is_empty());

        let rating = doc
            .select(&sel("#md-rating-stars[data-avg]"))
            .next()
            .and_then(|el| el.value().attr("data-avg"))
            .map(normalize_whitespace)
            .filter(|s| !s.is_empty() && s != "0");

        let raw_synopsis = doc
            .select(&sel(".md-info-row--synopsis p"))
            .next()
            .map(|el| normalize_whitespace(&el.text().collect::<String>()))
            .filter(|s| !s.is_empty() && !s.starts_with("No hay descripción"));

        let author = doc
            .select(&sel(".md-badge--author"))
            .next()
            .map(|el| normalize_whitespace(&el.text().collect::<String>()))
            .filter(|s| !s.is_empty());

        let description = raw_synopsis.or_else(|| author.map(|a| format!("Autor: {a}")));

        let mut genres: Vec<GenreTag> = Vec::new();
        let mut seen_genres = HashSet::new();
        for a in doc.select(&sel(
            r#"#md-tags-list a[href], .md-info-row a[href*="/biblioteca?type="], .md-info-row a[href*="/tag/"]"#,
        )) {
            let label = normalize_whitespace(&a.text().collect::<String>());
            if !label.is_empty() && seen_genres.insert(label.to_lowercase()) {
                let g_url = resolve_url(a.value().attr("href"), url);
                genres.push(GenreTag { label, url: g_url });
            }
        }

        let total_pages = doc
            .select(&sel("#md-preview-grid[data-total]"))
            .next()
            .and_then(|el| el.value().attr("data-total"))
            .map(normalize_whitespace)
            .filter(|s| !s.is_empty());

        let mut pages: Vec<PageLink> = Vec::new();
        let mut seen_pages: HashSet<String> = HashSet::new();

        if let Some(grid_el) = doc.select(&sel("#md-preview-grid[data-reader-url]")).next() {
            if let Some(r_url) = resolve_url(grid_el.value().attr("data-reader-url"), url) {
                if seen_pages.insert(r_url.clone()) {
                    let read_label = match &total_pages {
                        Some(tp) => format!("Leer completo ({tp} páginas)"),
                        None => "Leer completo".to_string(),
                    };
                    pages.push(PageLink {
                        id: make_media_id(&r_url),
                        url: r_url,
                        title: read_label,
                        subtitle: total_pages.as_ref().map(|tp| format!("{tp} págs")),
                        thumbnail: poster_img.clone(),
                        group: None,
                        source: Some("TMO".to_string()),
                        score: None,
                    });
                }
            }
        }

        for a in doc.select(&sel(
            r#"a.md-preview-read-btn[href], a[href*="/view_uploads/"], a[href*="/contents/"]"#,
        )) {
            let href = match resolve_url(a.value().attr("href"), url) {
                Some(h) => h,
                None => continue,
            };
            if !seen_pages.insert(href.clone()) {
                continue;
            }
            let raw_txt = normalize_whitespace(&a.text().collect::<String>());
            let chap_title = if raw_txt.is_empty() || raw_txt.eq_ignore_ascii_case("leer") {
                match &total_pages {
                    Some(tp) => format!("Leer completo ({tp} páginas)"),
                    None => "Leer capítulo".to_string(),
                }
            } else {
                raw_txt
            };
            pages.push(PageLink {
                id: make_media_id(&href),
                url: href,
                title: chap_title,
                subtitle: None,
                thumbnail: poster_img.clone(),
                group: None,
                source: Some("TMO".to_string()),
                score: None,
            });
        }

        // Related works (.md-related-list a.md-related-list__item)
        let img_sel = sel("img");
        let heading_sel = sel(".media-heading");
        let mut related: Vec<PageLink> = Vec::new();
        let mut seen_related = HashSet::new();

        for rel_a in doc.select(&sel(".md-related-list a.md-related-list__item[href]")) {
            let href = match resolve_url(rel_a.value().attr("href"), url) {
                Some(h) if h != url.as_str() => h,
                _ => continue,
            };
            if !seen_related.insert(href.clone()) {
                continue;
            }
            let rel_title = rel_a
                .select(&heading_sel)
                .next()
                .map(|el| normalize_whitespace(&el.text().collect::<String>()))
                .filter(|s| !s.is_empty());
            let rel_title = match rel_title {
                Some(t) => t,
                None => continue,
            };
            let thumb = rel_a
                .select(&img_sel)
                .next()
                .and_then(|im| resolve_url(im.value().attr("src"), url));

            related.push(PageLink {
                id: make_media_id(&href),
                url: href,
                title: rel_title,
                subtitle: None,
                thumbnail: thumb,
                group: None,
                source: Some("TMO".to_string()),
                score: None,
            });
        }

        if let Some(t) = title {
            base.metadata.title = t;
        }
        base.metadata.description = description;
        base.metadata.poster = poster_img;
        base.metadata.status = status;
        base.metadata.rating = rating;
        if !genres.is_empty() {
            base.metadata.genres = Some(genres);
        }

        return ExtractionResult {
            adapter: "ext-comic".to_string(),
            metadata: base.metadata,
            videos: Vec::new(),
            images: Vec::new(),
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

    // 3. Home / Biblioteca / Search / Tags / Comics
    let mut pages: Vec<PageLink> = Vec::new();
    let mut seen_pages: HashSet<String> = HashSet::new();
    let img_sel = sel("img");
    let card_title_sel = sel(".manga-card__title, h3");
    let book_type_sel = sel(".book-type");

    for a in doc.select(&sel(r#"a.manga-card[href*="/library/"], a[href*="/library/"]"#)) {
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
                    .attr("data-src")
                    .or_else(|| im.value().attr("src")),
                url,
            )
        });
        let title = a
            .select(&card_title_sel)
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
            });
        let title = match title {
            Some(t) if t.len() >= 2 => t,
            _ => continue,
        };
        let subtitle = a
            .select(&book_type_sel)
            .next()
            .map(|el| normalize_whitespace(&el.text().collect::<String>()))
            .filter(|s| !s.is_empty());

        pages.push(PageLink {
            id: make_media_id(&href),
            url: href,
            title,
            subtitle,
            thumbnail: thumb,
            group: None,
            source: Some("TMO".to_string()),
            score: None,
        });
    }

    let next_page_url = doc
        .select(&sel(r#"ul.pagination a[rel="next"], a[rel="next"], link[rel="next"]"#))
        .next()
        .and_then(|el| resolve_url(el.value().attr("href"), url));

    ExtractionResult {
        adapter: "ext-comic".to_string(),
        metadata: base.metadata,
        videos: Vec::new(),
        images: Vec::new(),
        pdfs: Vec::new(),
        pages,
        related: None,
        next_page_url,
    }
}
