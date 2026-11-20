pub mod animeflv;
pub mod generic;
pub mod hackstore;

use crate::types::ExtractionResult;
use url::Url;

pub fn extract_from_html(url: &Url, html: &str) -> ExtractionResult {
    if animeflv::can_handle(url) {
        return animeflv::extract(url, html);
    }
    if hackstore::can_handle(url) {
        return hackstore::extract(url, html);
    }
    generic::extract(url, html)
}

pub fn list_adapters() -> Vec<&'static str> {
    vec!["animeflv", "hackstore", "generic"]
}
