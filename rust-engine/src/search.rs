use crate::types::{ExtractionResult, PageLink, PageMetadata};
use crate::url_utils::fold_for_search;
use futures_util::future::join_all;
use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use std::collections::HashSet;
use strsim::jaro_winkler;

/// Computes a 0.0..=1.5 relevance score for a candidate title against a query,
/// combining exact match, prefix match, token coverage, and Jaro-Winkler fuzzy similarity.
pub fn score_title(query: &str, title: &str) -> f64 {
    let q = fold_for_search(query);
    let t = fold_for_search(title);
    if q.is_empty() || t.is_empty() {
        return 0.0;
    }

    if t == q {
        return 1.5;
    }

    let mut score = jaro_winkler(&q, &t);

    if t.starts_with(&q) {
        score += 0.35;
    } else if t.contains(&q) {
        score += 0.22;
    }

    // Token coverage bonus (great for multi-word titles like "spider man" or "tokyo revengers")
    let q_tokens: Vec<&str> = q.split_whitespace().collect();
    if !q_tokens.is_empty() {
        let matched = q_tokens
            .iter()
            .filter(|tok| t.contains(**tok))
            .count();
        let coverage = matched as f64 / q_tokens.len() as f64;
        score += coverage * 0.25;
    }

    score
}

pub async fn run_smart_search<F, Fut>(
    query: &str,
    source_filter: Option<&str>,
    extract_fn: F,
) -> ExtractionResult
where
    F: Fn(String) -> Fut,
    Fut: std::future::Future<Output = Result<ExtractionResult, String>>,
{
    let encoded = utf8_percent_encode(query.trim(), NON_ALPHANUMERIC).to_string();
    let filter = source_filter.unwrap_or("all").to_lowercase();

    let mut targets: Vec<(&'static str, String)> = Vec::new();
    if filter == "all" || filter == "animeflv" {
        targets.push((
            "AnimeFLV",
            format!("https://animeflv.or.at/?s={encoded}"),
        ));
    }
    if filter == "all" || filter == "jkanime" {
        targets.push((
            "JKAnime",
            format!("https://jkanime.net/buscar/{encoded}/"),
        ));
    }
    if filter == "all" || filter == "hackstore" {
        targets.push((
            "Hackstore",
            format!("https://www.hackstore.fo/?s={encoded}"),
        ));
    }
    if filter == "all" || filter == "leercapitulo" {
        targets.push((
            "LeerCapitulo",
            format!("https://www.leercapitulo.co/manga/?q={encoded}"),
        ));
    }
    if filter == "ext_comic" {
        let dom = crate::adapters::ext_comic::vault_domain();
        targets.push((
            "TMO",
            format!("https://{dom}/biblioteca?title={encoded}"),
        ));
    }

    let futs = targets.into_iter().map(|(src_name, url)| {
        let fut = extract_fn(url);
        async move { (src_name, fut.await) }
    });

    let results = join_all(futs).await;

    let mut combined: Vec<PageLink> = Vec::new();
    let mut seen_urls: HashSet<String> = HashSet::new();

    for (src_name, res) in results {
        if let Ok(data) = res {
            for mut p in data.pages {
                if !seen_urls.insert(p.url.clone()) {
                    continue;
                }
                let s = score_title(query, &p.title);
                p.source = Some(src_name.to_string());
                p.score = Some((s * 100.0).round() / 100.0);
                p.subtitle = Some(match p.subtitle {
                    Some(sub) if !sub.is_empty() => format!("{src_name} • {sub}"),
                    _ => src_name.to_string(),
                });
                combined.push(p);
            }
        }
    }

    // Sort descending by fuzzy relevance score so best matches always come first!
    combined.sort_by(|a, b| {
        let sb = b.score.unwrap_or(0.0);
        let sa = a.score.unwrap_or(0.0);
        sb.partial_cmp(&sa).unwrap_or(std::cmp::Ordering::Equal)
    });

    ExtractionResult {
        adapter: "global-search".to_string(),
        metadata: PageMetadata {
            title: format!("Resultados para \"{}\"", query.trim()),
            description: Some(format!(
                "{} resultados ordenados por relevancia con motor Rust",
                combined.len()
            )),
            site_name: Some("Búsqueda inteligente (Rust)".to_string()),
            favicon: None,
            poster: None,
            backdrop: None,
            info_url: None,
            status: None,
            rating: None,
            year: None,
            duration: None,
            genres: None,
            source_url: format!("search://{encoded}"),
        },
        videos: Vec::new(),
        images: Vec::new(),
        pdfs: Vec::new(),
        pages: combined,
        related: None,
        next_page_url: None,
    }
}
