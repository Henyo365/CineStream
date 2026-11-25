pub mod animeflv;
pub mod ext_comic;
pub mod generic;
pub mod hackstore;
pub mod jkanime;
pub mod leercapitulo;

use crate::types::ExtractionResult;
use url::Url;

pub fn extract_from_html(url: &Url, html: &str) -> ExtractionResult {
    if animeflv::can_handle(url) {
        return animeflv::extract(url, html);
    }
    if jkanime::can_handle(url) {
        return jkanime::extract(url, html);
    }
    if hackstore::can_handle(url) {
        return hackstore::extract(url, html);
    }
    if leercapitulo::can_handle(url) {
        return leercapitulo::extract(url, html);
    }
    if ext_comic::can_handle(url) {
        return ext_comic::extract(url, html);
    }
    generic::extract(url, html)
}

pub fn list_adapters() -> Vec<&'static str> {
    vec!["animeflv", "jkanime", "hackstore", "leercapitulo", "generic"]
}
