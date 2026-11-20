use percent_encoding::percent_decode_str;
use sha1::{Digest, Sha1};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use url::Url;

fn is_private_ipv4(ip: Ipv4Addr) -> bool {
    let o = ip.octets();
    ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_unspecified()
        || o[0] == 0
        // Carrier-grade NAT 100.64.0.0/10
        || (o[0] == 100 && (64..=127).contains(&o[1]))
}

fn is_private_ipv6(ip: Ipv6Addr) -> bool {
    if ip.is_loopback() || ip.is_unspecified() {
        return true;
    }
    let segs = ip.segments();
    // Unique local fc00::/7
    if (segs[0] & 0xfe00) == 0xfc00 {
        return true;
    }
    // Link-local fe80::/10
    if (segs[0] & 0xffc0) == 0xfe80 {
        return true;
    }
    if let Some(v4) = ip.to_ipv4_mapped() {
        return is_private_ipv4(v4);
    }
    false
}

/// Validates that a URL is http(s) and does not target local/private IP addresses
/// unless ALLOW_PRIVATE_NETWORKS=true is set.
pub fn validate_target_url(raw: &str) -> Result<Url, String> {
    let parsed = Url::parse(raw.trim())
        .map_err(|_| "URL inválida. Asegúrate de incluir http:// o https://".to_string())?;

    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("Solo se permiten URLs http:// o https://".to_string());
    }

    let allow_private = std::env::var("ALLOW_PRIVATE_NETWORKS")
        .map(|v| v == "true")
        .unwrap_or(false);

    if !allow_private {
        let host = parsed
            .host_str()
            .ok_or_else(|| "URL sin host válido".to_string())?
            .to_lowercase();
        let unbracketed = host.trim_start_matches('[').trim_end_matches(']');

        if unbracketed == "localhost"
            || unbracketed.ends_with(".local")
            || unbracketed.ends_with(".internal")
        {
            return Err("No se permiten direcciones locales o privadas".to_string());
        }

        if let Ok(ip) = unbracketed.parse::<IpAddr>() {
            let blocked = match ip {
                IpAddr::V4(v4) => is_private_ipv4(v4),
                IpAddr::V6(v6) => is_private_ipv6(v6),
            };
            if blocked {
                return Err("No se permiten direcciones locales o privadas".to_string());
            }
        }
    }

    Ok(parsed)
}

pub fn resolve_url(raw: Option<&str>, base: &Url) -> Option<String> {
    let trimmed = raw?.trim();
    if trimmed.is_empty()
        || trimmed.starts_with("javascript:")
        || trimmed.starts_with("mailto:")
        || trimmed.starts_with("tel:")
        || trimmed.starts_with("data:image/svg+xml")
    {
        return None;
    }
    if trimmed.starts_with("data:") && trimmed.len() < 256 {
        return None;
    }
    base.join(trimmed).ok().map(|u| u.to_string())
}

pub fn pick_best_from_srcset(srcset: Option<&str>, base: &Url) -> Option<String> {
    let srcset = srcset?;
    let mut best: Option<(String, f64)> = None;

    for entry in srcset.split(',') {
        let mut parts = entry.trim().split_whitespace();
        let raw_url = match parts.next() {
            Some(u) => u,
            None => continue,
        };
        let resolved = match resolve_url(Some(raw_url), base) {
            Some(u) => u,
            None => continue,
        };
        let desc = parts.next().unwrap_or("");
        let weight = if let Some(w) = desc.strip_suffix('w') {
            w.parse::<f64>().unwrap_or(0.0)
        } else if let Some(x) = desc.strip_suffix('x') {
            x.parse::<f64>().unwrap_or(1.0) * 1000.0
        } else {
            0.0
        };

        if best.as_ref().map(|(_, bw)| weight > *bw).unwrap_or(true) {
            best = Some((resolved, weight));
        }
    }

    best.map(|(u, _)| u)
}

pub fn make_media_id(url: &str) -> String {
    let mut hasher = Sha1::new();
    hasher.update(url.as_bytes());
    let digest = hex::encode(hasher.finalize());
    digest.chars().take(12).collect()
}

pub fn extract_filename(url_str: &str) -> Option<String> {
    let parsed = Url::parse(url_str).ok()?;
    let last = parsed.path().split('/').filter(|s| !s.is_empty()).last()?;
    let decoded = percent_decode_str(last).decode_utf8_lossy().to_string();
    if decoded.is_empty() {
        None
    } else {
        Some(decoded)
    }
}

pub fn normalize_whitespace(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Folds Spanish accents & punctuation for fast fuzzy matching.
pub fn fold_for_search(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.chars().flat_map(|c| c.to_lowercase()) {
        let mapped = match ch {
            'á' | 'à' | 'ä' | 'â' => 'a',
            'é' | 'è' | 'ë' | 'ê' => 'e',
            'í' | 'ì' | 'ï' | 'î' => 'i',
            'ó' | 'ò' | 'ö' | 'ô' => 'o',
            'ú' | 'ù' | 'ü' | 'û' => 'u',
            'ñ' => 'n',
            c if c.is_ascii_alphanumeric() => c,
            _ => ' ',
        };
        out.push(mapped);
    }
    normalize_whitespace(&out)
}
