//! The curriculum summaries a room's pinned lessons show: `listCurriculum()` in its order, and the spine's size the
//! pin read pages by. Written from the TypeScript catalogue by `scripts/record-lobbies.mjs` (`spine.json`, checked
//! for staleness there); the curriculum slice owns the full spine.

use std::sync::OnceLock;

use service_kit::json::{self, Json};

const SPINE_JSON: &str = include_str!("spine.json");

/// `CurriculumItemSummary`, as `curriculumSummaryOut` sends it.
#[derive(Debug, Clone, PartialEq)]
pub struct Summary {
    pub slug: String,
    pub title: String,
    pub kind: String,
    pub path: String,
    pub order: Json,
    pub summary: String,
    pub estimated_minutes: Json,
}

impl Summary {
    /// The summary in `curriculumSummaryOut`'s key order.
    pub fn json(&self) -> Json {
        Json::obj([
            ("slug", Json::str(self.slug.clone())),
            ("title", Json::str(self.title.clone())),
            ("kind", Json::str(self.kind.clone())),
            ("path", Json::str(self.path.clone())),
            ("order", self.order.clone()),
            ("summary", Json::str(self.summary.clone())),
            ("estimatedMinutes", self.estimated_minutes.clone()),
        ])
    }
}

struct Spine {
    size: usize,
    items: Vec<Summary>,
}

fn load() -> Spine {
    let doc = json::parse(SPINE_JSON).unwrap_or(Json::Null);
    let text = |item: &Json, k: &str| match item.get(k) {
        Some(Json::String(s)) => s.clone(),
        _ => String::new(),
    };
    let items = match doc.get("items") {
        Some(Json::Array(items)) => items
            .iter()
            .map(|item| Summary {
                slug: text(item, "slug"),
                title: text(item, "title"),
                kind: text(item, "kind"),
                path: text(item, "path"),
                order: item.get("order").cloned().unwrap_or(Json::Null),
                summary: text(item, "summary"),
                estimated_minutes: item.get("estimatedMinutes").cloned().unwrap_or(Json::Null),
            })
            .collect(),
        _ => Vec::new(),
    };
    let size = match doc.get("size") {
        Some(Json::Number(n)) => format!("{n}").parse().unwrap_or(0),
        _ => 0,
    };
    Spine { size, items }
}

fn spine() -> &'static Spine {
    static SPINE: OnceLock<Spine> = OnceLock::new();
    SPINE.get_or_init(load)
}

/// `listCurriculum()`.
pub fn list() -> &'static [Summary] {
    &spine().items
}

/// `curriculumSpineSize()`.
pub fn size() -> usize {
    spine().size
}

/// `hasCurriculumSlug(slug)`: the slug after JavaScript's trim.
pub fn has_slug(slug: &str) -> bool {
    let slug = service_kit::schema::js_trim(slug);
    list().iter().any(|i| i.slug == slug)
}

/// The summary a pin names, by its exact slug.
pub fn summary(slug: &str) -> Option<&'static Summary> {
    list().iter().find(|i| i.slug == slug)
}
