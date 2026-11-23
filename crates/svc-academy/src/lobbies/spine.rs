//! The curriculum summaries a room's pinned lessons show, read from the curriculum slice's spine
//! ([`crate::curriculum::spine`]): `listCurriculum()` in its order, and the spine's size the pin read pages by.

use crate::curriculum::spine::{self, Item};

/// `CurriculumItemSummary`: a spine item, sent as `curriculumSummaryOut` ([`Item::summary_json`]).
pub type Summary = Item;

/// `listCurriculum()`.
pub fn list() -> Vec<&'static Summary> {
    spine::list(None, None)
}

/// `curriculumSpineSize()`.
pub fn size() -> usize {
    spine::spine().items.len()
}

/// `hasCurriculumSlug(slug)`: the slug after JavaScript's trim.
pub fn has_slug(slug: &str) -> bool {
    spine::has(slug)
}

/// The summary a pin names, by its exact slug.
pub fn summary(slug: &str) -> Option<&'static Summary> {
    spine::get(slug)
}
