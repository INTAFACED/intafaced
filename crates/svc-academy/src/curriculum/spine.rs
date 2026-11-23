//! The curriculum spine (`curriculum/catalog.ts` and `content.ts`): every item the Academy teaches, embedded in the
//! binary byte for byte as `spine.json` (written from the TypeScript by `scripts/record-curriculum.mjs`), and the
//! catalogue's read surface over it. No database, no money, no progress.
//!
//! Other slices look items up here: [`get`], [`has`], [`list`], [`Item::path`]. Lengths a caller sees (`bodyChars`,
//! the depth figures) are JavaScript's `.length`, UTF-16 code units.

use std::sync::OnceLock;

use service_kit::json::{self, Json};
use service_kit::s2s::js_length;
use service_kit::schema::js_trim;

use crate::errors::{AcademyError, Refusal};

const SPINE_JSON: &str = include_str!("spine.json");

/// `CurriculumPath`, in Blueprint order (`CURRICULUM_PATHS`).
pub const PATHS: [&str; 4] = ["foundations", "markets", "builder", "sovereign"];
/// `CurriculumKind`.
pub const KINDS: [&str; 3] = ["playbook", "workbook", "lesson"];
/// `CURRICULUM_MIN_BODY_CHARS`: the body length below which an item is reported thin.
pub const MIN_BODY_CHARS: usize = 900;
/// `ACADEMY_RESERVED_TAB_SLUGS` (`packages/contracts/src/academy-articles.ts`): never an item's slug.
pub const RESERVED_TAB_SLUGS: [&str; 6] = [
    "learning",
    "certificates",
    "rooms",
    "videos",
    "programmes",
    "progress",
];

/// One glossary entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyTerm {
    pub term: String,
    pub definition: String,
}

/// One spine item: its row, its body and its teaching scaffolding, with the reading estimate derived from the body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Item {
    pub slug: String,
    pub title: String,
    pub kind: String,
    pub path: String,
    pub order: i64,
    pub summary: String,
    pub body: String,
    pub objectives: Vec<String>,
    pub key_terms: Vec<KeyTerm>,
    pub self_check: Vec<String>,
    pub estimated_minutes: i64,
}

/// The spine, in its seed order, and the slugs in title order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Spine {
    pub items: Vec<Item>,
    /// The spine as `searchPublicCurriculum` sorts it by name (`localeCompare(.., 'en')`, then slug).
    pub name_order: Vec<String>,
}

/// JavaScript's `\s`, for one character.
pub fn js_space(c: char) -> bool {
    u16::try_from(u32::from(c)).is_ok_and(service_kit::jsregex::is_js_space)
}

/// `readingMinutes`: 200 words a minute, rounded up, at least 1.
pub fn reading_minutes(body: &str) -> i64 {
    let words = js_trim(body)
        .split(js_space)
        .filter(|w| !w.is_empty())
        .count();
    let words = i64::try_from(words).unwrap_or(i64::MAX);
    (words.saturating_add(199) / 200).max(1)
}

/// `academySlugIsReserved`: trimmed and lower-cased.
pub fn slug_is_reserved(slug: &str) -> bool {
    let s = js_trim(slug).to_lowercase();
    RESERVED_TAB_SLUGS.contains(&s.as_str())
}

/// `assertSlugNotReserved`.
pub fn assert_slug_not_reserved(slug: &str) -> Result<(), Refusal> {
    if slug_is_reserved(slug) {
        return Err(AcademyError::new(
            format!("slug \"{slug}\" is a reserved academy tab"),
            "academy.slug_reserved",
        )
        .into());
    }
    Ok(())
}

/// `assertNoReservedSlugs`: the start-up check, naming the colliding slug.
pub fn assert_no_reserved_slugs<'a>(
    slugs: impl IntoIterator<Item = &'a str>,
) -> Result<(), Refusal> {
    slugs.into_iter().try_for_each(assert_slug_not_reserved)
}

fn text(v: &Json, key: &str) -> Result<String, String> {
    match v.get(key) {
        Some(Json::String(s)) => Ok(s.clone()),
        _ => Err(format!("spine.json: {key} is not a string")),
    }
}

fn texts(v: &Json, key: &str) -> Result<Vec<String>, String> {
    match v.get(key) {
        Some(Json::Array(a)) => a
            .iter()
            .map(|s| match s {
                Json::String(s) => Ok(s.clone()),
                _ => Err(format!("spine.json: {key} holds a non-string")),
            })
            .collect(),
        _ => Err(format!("spine.json: {key} is not a list")),
    }
}

fn parse_spine(source: &str) -> Result<Spine, String> {
    let doc = json::parse(source).map_err(|e| format!("spine.json: {e:?}"))?;
    let Some(Json::Array(rows)) = doc.get("items") else {
        return Err("spine.json: no items".to_owned());
    };
    let mut items = Vec::new();
    for row in rows {
        let slug = text(row, "slug")?;
        let order = match row.get("order") {
            Some(Json::Number(n)) => format!("{n}")
                .parse::<i64>()
                .map_err(|_| format!("spine.json: {slug}: order is not an integer"))?,
            _ => return Err(format!("spine.json: {slug}: no order")),
        };
        let key_terms = match row.get("keyTerms") {
            Some(Json::Array(a)) => a
                .iter()
                .map(|t| {
                    Ok(KeyTerm {
                        term: text(t, "term")?,
                        definition: text(t, "definition")?,
                    })
                })
                .collect::<Result<Vec<_>, String>>()?,
            _ => return Err(format!("spine.json: {slug}: no keyTerms")),
        };
        let body = text(row, "body")?;
        let kind = text(row, "kind")?;
        let path = text(row, "path")?;
        if !KINDS.contains(&kind.as_str()) || !PATHS.contains(&path.as_str()) {
            return Err(format!(
                "spine.json: {slug}: kind {kind} or path {path} is unknown"
            ));
        }
        items.push(Item {
            estimated_minutes: reading_minutes(&body),
            title: text(row, "title")?,
            summary: text(row, "summary")?,
            objectives: texts(row, "objectives")?,
            self_check: texts(row, "selfCheck")?,
            slug,
            kind,
            path,
            order,
            body,
            key_terms,
        });
    }
    let name_order = texts(&doc, "nameOrder")?;
    let mut sorted: Vec<&str> = name_order.iter().map(String::as_str).collect();
    sorted.sort_unstable();
    let mut slugs: Vec<&str> = items.iter().map(|i| i.slug.as_str()).collect();
    slugs.sort_unstable();
    if sorted != slugs {
        return Err("spine.json: nameOrder is not the spine's slugs".to_owned());
    }
    if slugs.windows(2).any(|w| w.first() == w.get(1)) {
        return Err("spine.json: a slug appears twice".to_owned());
    }
    // AC-articles-02: a shipped slug equal to a reserved tab slug stops the service at load, naming the slug.
    assert_no_reserved_slugs(items.iter().map(|i| i.slug.as_str())).map_err(|r| match r {
        Refusal::Academy(e) => e.message,
        other => format!("{other:?}"),
    })?;
    Ok(Spine { items, name_order })
}

static SPINE: OnceLock<Result<Spine, String>> = OnceLock::new();
static EMPTY: Spine = Spine {
    items: Vec::new(),
    name_order: Vec::new(),
};

/// Whether the embedded spine loads: the process refuses to start without it, as the TypeScript module throws at load.
pub fn check() -> Result<(), String> {
    SPINE
        .get_or_init(|| parse_spine(SPINE_JSON))
        .as_ref()
        .map(|_| ())
        .map_err(Clone::clone)
}

/// The spine. A spine that does not load is refused at start-up ([`check`]); served here it is empty.
pub fn spine() -> &'static Spine {
    SPINE
        .get_or_init(|| parse_spine(SPINE_JSON))
        .as_ref()
        .unwrap_or(&EMPTY)
}

/// `getCurriculumItem`: no trim.
pub fn get(slug: &str) -> Option<&'static Item> {
    spine().items.iter().find(|i| i.slug == slug)
}

/// `hasCurriculumSlug`: trimmed.
pub fn has(slug: &str) -> bool {
    get(js_trim(slug)).is_some()
}

/// `listCurriculum(filter)`: by path (alphabetical), then order; summaries only.
pub fn list(path: Option<&str>, kind: Option<&str>) -> Vec<&'static Item> {
    let mut out: Vec<&Item> = spine()
        .items
        .iter()
        .filter(|i| path.is_none_or(|p| i.path == p) && kind.is_none_or(|k| i.kind == k))
        .collect();
    out.sort_by(|a, b| a.path.cmp(&b.path).then(a.order.cmp(&b.order)));
    out
}

/// `itemType`: a published quiz makes an item a quiz; a workbook is an assignment; anything else a lesson.
pub fn item_type(kind: &str, has_quiz: bool) -> &'static str {
    if has_quiz {
        "quiz"
    } else if kind == "workbook" {
        "assignment"
    } else {
        "lesson"
    }
}

/// `inventoryCurriculum`: counts by path and kind, in `PATHS` and `KINDS` order.
pub fn inventory() -> (usize, [usize; 4], [usize; 3]) {
    let mut by_path = [0usize; 4];
    let mut by_kind = [0usize; 3];
    for item in &spine().items {
        if let Some(n) = PATHS
            .iter()
            .position(|p| *p == item.path)
            .and_then(|i| by_path.get_mut(i))
        {
            *n += 1;
        }
        if let Some(n) = KINDS
            .iter()
            .position(|k| *k == item.kind)
            .and_then(|i| by_kind.get_mut(i))
        {
            *n += 1;
        }
    }
    (spine().items.len(), by_path, by_kind)
}

/// `listCurriculumSlugs`: sorted.
pub fn slugs() -> Vec<&'static str> {
    let mut out: Vec<&str> = spine().items.iter().map(|i| i.slug.as_str()).collect();
    out.sort_unstable();
    out
}

fn limit_unset() -> Refusal {
    AcademyError::new(
        "Curriculum list limit is unset — pass limit (never invent all.length)",
        "academy.curriculum_list_limit_unset",
    )
    .into()
}

/// `assertCurriculumPageLimit`: the owner-published page size. Absent or below 1 after `Math.floor` refuses; at most
/// 200.
pub fn page_limit(limit: Option<f64>) -> Result<usize, Refusal> {
    let Some(n) = limit.filter(|n| n.is_finite()).map(f64::floor) else {
        return Err(limit_unset());
    };
    if n < 1.0 {
        return Err(limit_unset());
    }
    if n >= 200.0 {
        return Ok(200);
    }
    #[expect(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "n is a whole number in [1, 200)"
    )]
    Ok(n as usize)
}

fn strings(v: &[String]) -> Json {
    Json::Array(v.iter().map(|s| Json::str(s.clone())).collect())
}

fn key_terms(v: &[KeyTerm]) -> Json {
    Json::Array(
        v.iter()
            .map(|t| {
                Json::obj([
                    ("term", Json::str(t.term.clone())),
                    ("definition", Json::str(t.definition.clone())),
                ])
            })
            .collect(),
    )
}

fn int(n: usize) -> Json {
    Json::int(i64::try_from(n).unwrap_or(i64::MAX))
}

impl Item {
    /// `curriculumSummaryOut`.
    pub fn summary_json(&self) -> Json {
        Json::obj([
            ("slug", Json::str(self.slug.clone())),
            ("title", Json::str(self.title.clone())),
            ("kind", Json::str(self.kind.clone())),
            ("path", Json::str(self.path.clone())),
            ("order", Json::int(self.order)),
            ("summary", Json::str(self.summary.clone())),
            ("estimatedMinutes", Json::int(self.estimated_minutes)),
        ])
    }

    /// `curriculumItemOut`: the summary, the body and the teaching scaffolding.
    pub fn item_fields(&self) -> Vec<(String, Json)> {
        let Json::Object(mut fields) = self.summary_json() else {
            return Vec::new();
        };
        fields.extend([
            ("body".to_owned(), Json::str(self.body.clone())),
            ("objectives".to_owned(), strings(&self.objectives)),
            ("keyTerms".to_owned(), key_terms(&self.key_terms)),
            ("selfCheck".to_owned(), strings(&self.self_check)),
        ]);
        fields
    }

    /// `body.length`.
    pub fn body_chars(&self) -> usize {
        js_length(&self.body)
    }

    /// `curriculumStudyGuideOut`.
    pub fn study_guide_json(&self) -> Json {
        Json::obj([
            ("slug", Json::str(self.slug.clone())),
            ("title", Json::str(self.title.clone())),
            ("kind", Json::str(self.kind.clone())),
            ("path", Json::str(self.path.clone())),
            ("estimatedMinutes", Json::int(self.estimated_minutes)),
            ("objectives", strings(&self.objectives)),
            ("keyTerms", key_terms(&self.key_terms)),
            ("selfCheck", strings(&self.self_check)),
            ("bodyChars", int(self.body_chars())),
        ])
    }
}

/// `curriculumStudyGuide`: trimmed; unknown is none.
pub fn study_guide(slug: &str) -> Option<&'static Item> {
    get(js_trim(slug))
}

/// `listCurriculumStudyGuides(path)`: in the path's display order.
pub fn study_guides(path: Option<&str>) -> Vec<&'static Item> {
    list(path, None)
}

/// `CurriculumDepthReport`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Depth {
    pub total: usize,
    pub deep: usize,
    pub thin: usize,
    pub thin_slugs: Vec<String>,
    pub shortest_body_chars: usize,
    pub total_body_chars: usize,
}

/// `curriculumDepthReport`.
pub fn depth() -> Depth {
    let items = &spine().items;
    let mut thin_slugs: Vec<String> = items
        .iter()
        .filter(|i| i.body_chars() < MIN_BODY_CHARS)
        .map(|i| i.slug.clone())
        .collect();
    thin_slugs.sort_unstable();
    let lengths: Vec<usize> = items.iter().map(Item::body_chars).collect();
    Depth {
        total: items.len(),
        deep: items.len().saturating_sub(thin_slugs.len()),
        thin: thin_slugs.len(),
        thin_slugs,
        shortest_body_chars: lengths.iter().copied().min().unwrap_or(0),
        total_body_chars: lengths.iter().sum(),
    }
}

impl Depth {
    /// `curriculumDepthOut`.
    pub fn json(&self) -> Json {
        Json::obj([
            ("total", int(self.total)),
            ("deep", int(self.deep)),
            ("thin", int(self.thin)),
            ("thinSlugs", strings(&self.thin_slugs)),
            ("minBodyChars", int(MIN_BODY_CHARS)),
            ("shortestBodyChars", int(self.shortest_body_chars)),
            ("totalBodyChars", int(self.total_body_chars)),
            ("allDeep", Json::Bool(self.thin_slugs.is_empty())),
        ])
    }

    /// `curriculumDepthLine`.
    pub fn line(&self) -> String {
        format!(
            "total={} deep={} thin={} floor={MIN_BODY_CHARS} shortest={}",
            self.total, self.deep, self.thin, self.shortest_body_chars
        )
    }
}

/// `relatedItems(slug, limit)`: same path, shipped order, without the item itself. No trim.
pub fn related(slug: &str, limit: usize) -> Result<Vec<&'static Item>, Refusal> {
    let Some(item) = get(slug) else {
        return Err(not_in_spine(slug));
    };
    Ok(list(Some(&item.path), None)
        .into_iter()
        .filter(|i| i.slug != slug)
        .take(limit)
        .collect())
}

/// `Curriculum item "<slug>" is not in the day-one spine`.
pub fn not_in_spine(slug: &str) -> Refusal {
    AcademyError::new(
        format!("Curriculum item \"{slug}\" is not in the day-one spine"),
        "academy.curriculum_not_found",
    )
    .into()
}

/// `curriculumItemView(slug)`: trimmed; the item with its body, or not found.
pub fn item_view(slug: &str) -> Result<&'static Item, Refusal> {
    get(js_trim(slug)).ok_or_else(|| not_in_spine(slug))
}
