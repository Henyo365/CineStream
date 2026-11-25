use crate::adapters::generic;
use crate::types::{ExtractionResult, GenreTag, MediaItem, MediaType, PageLink};
use crate::url_utils::{make_media_id, normalize_whitespace, resolve_url};
use scraper::{Html, Selector};
use std::collections::HashSet;
use url::Url;

pub fn can_handle(url: &Url) -> bool {
    let host = url.host_str().unwrap_or("").to_lowercase();
    host == "leercapitulo.co" || host.ends_with(".leercapitulo.co")
}

fn sel(s: &str) -> Selector {
    Selector::parse(s).unwrap()
}

pub fn extract(url: &Url, html: &str) -> ExtractionResult {
    let mut base = generic::extract(url, html);
    let doc = Html::parse_document(html);
    let path = url.path().to_lowercase();

    let is_reader_page = path.starts_with("/leer/")
        || doc.select(&sel("main#lcPages, main.lc-pages")).next().is_some();
    let is_manga_detail = path.starts_with("/manga/")
        && path.trim_matches('/').split('/').count() >= 2
        && doc.select(&sel("#chapterList, .lc-facts")).next().is_some();

    // 1. Chapter Reader (/leer/<id>/<slug>/<chapter>/)
    if is_reader_page {
        let mut images: Vec<MediaItem> = Vec::new();
        let mut seen_imgs: HashSet<String> = HashSet::new();

        for img in doc.select(&sel("#lcPages img, main.lc-pages img")) {
            let src = match resolve_url(
                img.value()
                    .attr("data-src")
                    .or_else(|| img.value().attr("data-lazy-src"))
                    .or_else(|| img.value().attr("src")),
                url,
            ) {
                Some(s) => s,
                None => continue,
            };
            if !seen_imgs.insert(src.clone()) {
                continue;
            }
            let page_idx = images.len() + 1;
            images.push(MediaItem {
                id: make_media_id(&src),
                media_type: MediaType::Image,
                url: src,
                title: Some(format!("Página {page_idx}")),
                thumbnail: None,
                mime_type: None,
                is_embed: None,
                source_tag: Some("manga-page".to_string()),
            });
        }

        let back_el = doc.select(&sel(r#"a.lc-rbtn--title[href*="/manga/"]"#)).next();
        let info_url = back_el.and_then(|a| resolve_url(a.value().attr("href"), url));
        let manga_name = back_el
            .map(|a| {
                normalize_whitespace(&a.text().collect::<String>())
                    .trim_start_matches('‹')
                    .trim()
                    .to_string()
            })
            .filter(|s| !s.is_empty());

        let selected_chap = doc
            .select(&sel("#chapterSelect option[selected]"))
            .next()
            .map(|opt| normalize_whitespace(&opt.text().collect::<String>()))
            .filter(|s| !s.is_empty());

        // Populate chapter navigation list from #chapterSelect so Prev/Next works even when opened directly
        let mut pages: Vec<PageLink> = Vec::new();
        let mut seen_pages: HashSet<String> = HashSet::new();
        for opt in doc.select(&sel("#chapterSelect option[value]")) {
            let href = match resolve_url(opt.value().attr("value"), url) {
                Some(h) => h,
                None => continue,
            };
            if !seen_pages.insert(href.clone()) {
                continue;
            }
            let chap_label = normalize_whitespace(&opt.text().collect::<String>());
            if chap_label.is_empty() {
                continue;
            }
            pages.push(PageLink {
                id: make_media_id(&href),
                url: href,
                title: chap_label,
                subtitle: None,
                thumbnail: None,
                group: None,
                source: Some("LeerCapitulo".to_string()),
                score: None,
            });
        }

        if let (Some(m_name), Some(c_label)) = (&manga_name, &selected_chap) {
            base.metadata.title = format!("{m_name} - {c_label}");
        } else if let Some(m_name) = manga_name {
            base.metadata.title = m_name;
        }
        base.metadata.info_url = info_url;

        return ExtractionResult {
            adapter: "leercapitulo".to_string(),
            metadata: base.metadata,
            videos: Vec::new(),
            images,
            pdfs: Vec::new(),
            pages,
            related: None,
            next_page_url: None,
        };
    }

    // 2. Manga Detail (/manga/<id>/<slug>/)
    if is_manga_detail {
        let title = doc
            .select(&sel("article h1, h1"))
            .next()
            .map(|el| normalize_whitespace(&el.text().collect::<String>()))
            .filter(|s| !s.is_empty());

        let poster_img = doc
            .select(&sel(".lc-cover-lg img"))
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

        let synopsis = doc
            .select(&sel("#sinopsis p"))
            .next()
            .map(|el| normalize_whitespace(&el.text().collect::<String>()))
            .filter(|s| !s.is_empty())
            .or_else(|| base.metadata.description.clone());

        let k_sel = sel(".k");
        let mut status: Option<String> = None;
        for li in doc.select(&sel(".lc-facts li")) {
            let key = li
                .select(&k_sel)
                .next()
                .map(|el| normalize_whitespace(&el.text().collect::<String>()).to_lowercase())
                .unwrap_or_default();
            if key == "estado" {
                let full = normalize_whitespace(&li.text().collect::<String>());
                let val = full.trim_start_matches("Estado").trim().to_string();
                if !val.is_empty() {
                    status = Some(val);
                }
            }
        }

        let mut genres: Vec<GenreTag> = Vec::new();
        let mut seen_genres = HashSet::new();
        for badge in doc.select(&sel(
            r#"article a.badge[href*="/manga/?genre="], article a.badge[href*="/manga/?theme="]"#,
        )) {
            let label = normalize_whitespace(&badge.text().collect::<String>());
            if !label.is_empty() && seen_genres.insert(label.to_lowercase()) {
                let g_url = resolve_url(badge.value().attr("href"), url);
                genres.push(GenreTag { label, url: g_url });
            }
        }

        let n_sel = sel(".n");
        let d_sel = sel(".d");
        let mut pages: Vec<PageLink> = Vec::new();
        let mut seen_pages = HashSet::new();

        for row in doc.select(&sel("#chapterList a.lc-chapter-row[href], a[href*=\"/leer/\"]")) {
            let href = match resolve_url(row.value().attr("href"), url) {
                Some(h) => h,
                None => continue,
            };
            if !seen_pages.insert(href.clone()) {
                continue;
            }
            let chap_title = row
                .select(&n_sel)
                .next()
                .map(|el| normalize_whitespace(&el.text().collect::<String>()))
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| normalize_whitespace(&row.text().collect::<String>()));
            if chap_title.is_empty() {
                continue;
            }
            let date_sub = row
                .select(&d_sel)
                .next()
                .map(|el| normalize_whitespace(&el.text().collect::<String>()))
                .filter(|s| !s.is_empty());

            pages.push(PageLink {
                id: make_media_id(&href),
                url: href,
                title: chap_title,
                subtitle: date_sub,
                thumbnail: poster_img.clone(),
                group: None,
                source: Some("LeerCapitulo".to_string()),
                score: None,
            });
        }

        if let Some(t) = title {
            base.metadata.title = t;
        }
        base.metadata.description = synopsis;
        base.metadata.poster = poster_img;
        base.metadata.status = status;
        if !genres.is_empty() {
            base.metadata.genres = Some(genres);
        }

        return ExtractionResult {
            adapter: "leercapitulo".to_string(),
            metadata: base.metadata,
            videos: Vec::new(),
            images: Vec::new(),
            pdfs: Vec::new(),
            pages,
            related: None,
            next_page_url: None,
        };
    }

    // 3. Home / Catalog / Search / Genre
    let mut pages: Vec<PageLink> = Vec::new();
    let mut seen_pages: HashSet<String> = HashSet::new();
    let img_sel = sel("img");

    // 3a. Catalog & Search cards (`article.lc-card`)
    let card_cover_sel = sel("a.lc-card-cover[href]");
    let card_name_sel = sel(".lc-card-name");
    let card_badge_sel = sel(".lc-card-badge");
    let card_chap_sel = sel(".lc-chapter-link");

    for card in doc.select(&sel("article.lc-card")) {
        let cover_a = match card.select(&card_cover_sel).next() {
            Some(a) => a,
            None => continue,
        };
        let href = match resolve_url(cover_a.value().attr("href"), url) {
            Some(h) if h != url.as_str() => h,
            _ => continue,
        };
        if !seen_pages.insert(href.clone()) {
            continue;
        }
        let thumb = cover_a
            .select(&img_sel)
            .next()
            .and_then(|im| {
                resolve_url(
                    im.value()
                        .attr("data-src")
                        .or_else(|| im.value().attr("src")),
                    url,
                )
            });
        let title = card
            .select(&card_name_sel)
            .next()
            .map(|el| normalize_whitespace(&el.text().collect::<String>()))
            .filter(|s| !s.is_empty());
        let title = match title {
            Some(t) => t,
            None => continue,
        };
        let kind = card
            .select(&card_badge_sel)
            .next()
            .map(|el| normalize_whitespace(&el.text().collect::<String>()))
            .filter(|s| !s.is_empty());
        let chap = card
            .select(&card_chap_sel)
            .next()
            .map(|el| normalize_whitespace(&el.text().collect::<String>()))
            .filter(|s| !s.is_empty());
        let subtitle = match (kind, chap) {
            (Some(k), Some(c)) => Some(format!("{k} • {c}")),
            (Some(k), None) => Some(k),
            (None, Some(c)) => Some(c),
            (None, None) => None,
        };

        pages.push(PageLink {
            id: make_media_id(&href),
            url: href,
            title,
            subtitle,
            thumbnail: thumb,
            group: None,
            source: Some("LeerCapitulo".to_string()),
            score: None,
        });
    }

    // 3b. Home Trending Slider (`.lc-slide`)
    let slide_cover_sel = sel("a.lc-slide-cover[href]");
    let slide_name_sel = sel(".lc-slide-name");
    let slide_chap_sel = sel(".lc-slide-chapter");

    for slide in doc.select(&sel(".lc-slide")) {
        let cover_a = match slide.select(&slide_cover_sel).next() {
            Some(a) => a,
            None => continue,
        };
        let href = match resolve_url(cover_a.value().attr("href"), url) {
            Some(h) if h != url.as_str() => h,
            _ => continue,
        };
        if !seen_pages.insert(href.clone()) {
            continue;
        }
        let thumb = cover_a
            .select(&img_sel)
            .next()
            .and_then(|im| resolve_url(im.value().attr("src"), url));
        let title = slide
            .select(&slide_name_sel)
            .next()
            .map(|el| normalize_whitespace(&el.text().collect::<String>()))
            .filter(|s| !s.is_empty());
        let title = match title {
            Some(t) => t,
            None => continue,
        };
        let chap = slide
            .select(&slide_chap_sel)
            .next()
            .map(|el| normalize_whitespace(&el.text().collect::<String>()))
            .filter(|s| !s.is_empty());

        pages.push(PageLink {
            id: make_media_id(&href),
            url: href,
            title,
            subtitle: chap,
            thumbnail: thumb,
            group: Some("Tendencias".to_string()),
            source: Some("LeerCapitulo".to_string()),
            score: None,
        });
    }

    // 3c. Home Latest Releases (`article.lc-release`)
    let rel_cover_sel = sel("a.lc-release-cover[href]");
    let rel_title_sel = sel(".lc-release-title");

    for rel in doc.select(&sel("article.lc-release")) {
        let cover_a = match rel.select(&rel_cover_sel).next() {
            Some(a) => a,
            None => continue,
        };
        let href = match resolve_url(cover_a.value().attr("href"), url) {
            Some(h) if h != url.as_str() => h,
            _ => continue,
        };
        if !seen_pages.insert(href.clone()) {
            continue;
        }
        let thumb = cover_a
            .select(&img_sel)
            .next()
            .and_then(|im| resolve_url(im.value().attr("src"), url));
        let title = rel
            .select(&rel_title_sel)
            .next()
            .map(|el| normalize_whitespace(&el.text().collect::<String>()))
            .filter(|s| !s.is_empty());
        let title = match title {
            Some(t) => t,
            None => continue,
        };
        let latest_chap = rel
            .select(&card_chap_sel)
            .next()
            .map(|el| normalize_whitespace(&el.text().collect::<String>()))
            .filter(|s| !s.is_empty());

        pages.push(PageLink {
            id: make_media_id(&href),
            url: href,
            title,
            subtitle: latest_chap,
            thumbnail: thumb,
            group: Some("Últimos capítulos".to_string()),
            source: Some("LeerCapitulo".to_string()),
            score: None,
        });
    }

    let next_page_url = doc
        .select(&sel(r#"a.page-link[rel="next"], a[rel="next"], link[rel="next"]"#))
        .next()
        .and_then(|el| resolve_url(el.value().attr("href"), url));

    ExtractionResult {
        adapter: "leercapitulo".to_string(),
        metadata: base.metadata,
        videos: Vec::new(),
        images: Vec::new(),
        pdfs: Vec::new(),
        pages,
        related: None,
        next_page_url,
    }
}
