//! What the curriculum calls derive from the spine besides the catalogue itself: Blueprint deep-links
//! (`curriculum/deep-links.ts`), the locale fallback (`i18n-strategy.ts`), the coach's slug-and-title spine
//! (`coach-spine.ts`), and the signed-out catalogue's search and course pages (`public-catalogue.ts`, with
//! `course-enrolment.ts`'s `publishedCourse`).

use std::collections::BTreeSet;

use service_kit::json::Json;
use service_kit::schema::js_trim;

use super::spine::{self, Item, PATHS};
use crate::errors::{AcademyError, Refusal};

/// `CURRICULUM_DEEP_LINK_PREFIX`.
pub const DEEP_LINK_PREFIX: &str = "/academy/curriculum";

/// `CurriculumDeepLink`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeepLink {
    Ok {
        path: String,
        slug: Option<String>,
        href: String,
    },
    Refused {
        reason: &'static str,
        message: String,
    },
}

impl DeepLink {
    /// `curriculumDeepLinkOut`.
    pub fn json(&self) -> Json {
        match self {
            DeepLink::Ok { path, slug, href } => Json::obj([
                ("ok", Json::Bool(true)),
                ("path", Json::str(path.clone())),
                ("slug", slug.clone().map_or(Json::Null, Json::String)),
                ("href", Json::str(href.clone())),
            ]),
            DeepLink::Refused { reason, message } => Json::obj([
                ("ok", Json::Bool(false)),
                ("reason", Json::str(*reason)),
                ("message", Json::str(message.clone())),
            ]),
        }
    }
}

/// `resolveCurriculumDeepLink({ path, slug })`: a path index, or an item on that path; never an invented one.
pub fn resolve_deep_link(path: &str, slug: Option<&str>) -> DeepLink {
    if !PATHS.contains(&path) {
        return DeepLink::Refused {
            reason: "unknown_path",
            message: format!("path must be one of {}", PATHS.join("|")),
        };
    }
    let Some(slug) = slug.map(js_trim).filter(|s| !s.is_empty()) else {
        return DeepLink::Ok {
            path: path.to_owned(),
            slug: None,
            href: format!("{DEEP_LINK_PREFIX}/{path}"),
        };
    };
    let Some(item) = spine::get(slug) else {
        return DeepLink::Refused {
            reason: "unknown_slug",
            message: format!("Curriculum item \"{slug}\" is not in the catalog spine"),
        };
    };
    if item.path != path {
        return DeepLink::Refused {
            reason: "path_mismatch",
            message: format!(
                "Slug \"{slug}\" belongs to path \"{}\", not \"{path}\"",
                item.path
            ),
        };
    }
    DeepLink::Ok {
        path: path.to_owned(),
        slug: Some(slug.to_owned()),
        href: format!("{DEEP_LINK_PREFIX}/{path}/{slug}"),
    }
}

/// `deepLinkForSlug`: the item's own link, or none.
pub fn deep_link_for_slug(slug: &str) -> Option<String> {
    let item = spine::get(js_trim(slug))?;
    match resolve_deep_link(&item.path, Some(&item.slug)) {
        DeepLink::Ok { href, .. } => Some(href),
        DeepLink::Refused { .. } => None,
    }
}

/// `listCurriculumPathDeepLinks`: path, href and item count, for each path with content, in Blueprint order.
pub fn path_deep_links() -> Vec<(&'static str, String, usize)> {
    PATHS
        .iter()
        .map(|p| {
            (
                *p,
                format!("{DEEP_LINK_PREFIX}/{p}"),
                spine::list(Some(p), None).len(),
            )
        })
        .filter(|(_, _, n)| *n > 0)
        .collect()
}

/// The path deep-links as the call answers them.
pub fn path_deep_links_json() -> Json {
    Json::Array(
        path_deep_links()
            .into_iter()
            .map(|(path, href, n)| {
                Json::obj([
                    ("path", Json::str(path)),
                    ("href", Json::str(href)),
                    ("itemCount", Json::int(i64::try_from(n).unwrap_or(i64::MAX))),
                ])
            })
            .collect(),
    )
}

/// `curriculumDeepLinksVerified`: every path with content resolves to its own index link.
pub fn deep_links_verified() -> bool {
    let links = path_deep_links();
    !links.is_empty()
        && links.iter().all(|(path, href, _)| {
            matches!(resolve_deep_link(path, None), DeepLink::Ok { href: h, .. } if h == *href)
        })
}

/// `CURRICULUM_DEFAULT_LOCALE`, and `CURRICULUM_LOCALES_WITH_BODIES`.
pub const DEFAULT_LOCALE: &str = "en";
pub const LOCALES_WITH_BODIES: [&str; 1] = [DEFAULT_LOCALE];

/// `CurriculumLocaleResolution`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocaleResolution {
    pub requested: Option<String>,
    pub locale: &'static str,
    pub fell_back: bool,
}

/// `LOCALE_RE`: `^[a-z]{2}(?:-[A-Z]{2})?$`.
fn locale_shape(raw: &str) -> bool {
    let b = raw.as_bytes();
    let lang = |s: &[u8]| s.len() == 2 && s.iter().all(u8::is_ascii_lowercase);
    match b.len() {
        2 => lang(b),
        5 => {
            lang(b.get(..2).unwrap_or(&[]))
                && b.get(2) == Some(&b'-')
                && b.get(3..)
                    .is_some_and(|r| r.iter().all(u8::is_ascii_uppercase))
        }
        _ => false,
    }
}

/// `resolveCurriculumLocale(requested)`: a shipped locale, or the default with `fellBack`.
pub fn resolve_locale(requested: Option<&str>) -> LocaleResolution {
    let raw = requested.map_or("", js_trim);
    if raw.is_empty() {
        return LocaleResolution {
            requested: None,
            locale: DEFAULT_LOCALE,
            fell_back: true,
        };
    }
    let shipped = locale_shape(raw)
        .then(|| LOCALES_WITH_BODIES.iter().find(|l| **l == raw))
        .flatten();
    LocaleResolution {
        requested: Some(raw.to_owned()),
        locale: shipped.copied().unwrap_or(DEFAULT_LOCALE),
        fell_back: shipped.is_none(),
    }
}

/// `curriculumI18nStrategyLine`.
pub fn i18n_strategy_line() -> String {
    format!(
        "default={DEFAULT_LOCALE} withBodies={} fallback=default neverInvent=1",
        LOCALES_WITH_BODIES.join("|")
    )
}

/// `curriculumI18nStrategyHonest`.
pub fn i18n_strategy_honest() -> bool {
    let line = i18n_strategy_line();
    line.contains(&format!("default={DEFAULT_LOCALE}"))
        && line.contains("neverInvent=1")
        && LOCALES_WITH_BODIES.contains(&DEFAULT_LOCALE)
}

/// `LICENSED_LIBRARY_IMPORTED`: the licensed library is not in this repository.
pub const LICENSED_LIBRARY_IMPORTED: bool = false;

/// `resolveLicensedLibraryImported(flag)`: whatever the flag, false.
pub fn resolve_licensed_library_imported(_flag: Option<bool>) -> bool {
    LICENSED_LIBRARY_IMPORTED
}

/// `coachSpinePayload()` as `ACADEMY_INTERNAL_CURRICULUM.output` writes it: slug and title only, never a body.
pub fn coach_spine_json() -> Json {
    Json::obj([
        (
            "items",
            Json::Array(
                spine::list(None, None)
                    .into_iter()
                    .map(|i| {
                        Json::obj([
                            ("slug", Json::str(i.slug.clone())),
                            ("title", Json::str(i.title.clone())),
                        ])
                    })
                    .collect(),
            ),
        ),
        (
            "licensedLibraryImported",
            Json::Bool(resolve_licensed_library_imported(None)),
        ),
        ("source", Json::str("platform-spine")),
    ])
}

/// `PublicCatalogueSort`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Sort {
    Recommended,
    NameAsc,
    NameDesc,
}

impl Sort {
    pub fn parse(s: &str) -> Option<Sort> {
        match s {
            "recommended" => Some(Sort::Recommended),
            "name_asc" => Some(Sort::NameAsc),
            "name_desc" => Some(Sort::NameDesc),
            _ => None,
        }
    }
}

/// `searchPublicCurriculum`: the published spine filtered by path and kind, the query matched in title or summary
/// case-folded, sorted, then cut to the page size.
pub fn search_public(
    q: Option<&str>,
    path: Option<&str>,
    kind: Option<&str>,
    sort: Option<Sort>,
    limit: usize,
) -> Vec<&'static Item> {
    let needle = js_trim(q.unwrap_or("")).to_lowercase();
    let mut rows: Vec<&Item> = spine::list(path, kind)
        .into_iter()
        .filter(|row| {
            needle.is_empty()
                || row.title.to_lowercase().contains(&needle)
                || row.summary.to_lowercase().contains(&needle)
        })
        .collect();
    let sort = sort.unwrap_or(Sort::Recommended);
    if sort != Sort::Recommended {
        let rank = |slug: &str| {
            spine::spine()
                .name_order
                .iter()
                .position(|s| s == slug)
                .unwrap_or(usize::MAX)
        };
        rows.sort_by_key(|r| rank(&r.slug));
        if sort == Sort::NameDesc {
            rows.reverse();
        }
    }
    rows.truncate(limit);
    rows
}

/// `publishedCourse(slug)`: a path with published items, or `academy.course_not_found`.
pub fn published_course(slug: &str) -> Result<&'static str, Refusal> {
    let trimmed = js_trim(slug);
    match PATHS.iter().find(|p| **p == trimmed) {
        Some(path) if !spine::list(Some(path), None).is_empty() => Ok(path),
        _ => Err(AcademyError::new(
            format!("Course \"{slug}\" is not published"),
            "academy.course_not_found",
        )
        .into()),
    }
}

/// `listPublicCourses`: one card per path with published items, with its item count and reading minutes.
pub fn public_courses() -> Vec<(&'static str, usize, i64)> {
    PATHS
        .iter()
        .map(|p| (*p, spine::list(Some(p), None)))
        .filter(|(_, rows)| !rows.is_empty())
        .map(|(p, rows)| {
            (
                p,
                rows.len(),
                rows.iter().map(|r| r.estimated_minutes).sum(),
            )
        })
        .collect()
}

/// `publicCourse(slug, certificateTitle, opensSignedOut, quizzes)`: the course page. Outcomes are the objectives of
/// the items a visitor can open, once each, in syllabus order; every item stays in the syllabus with its type.
pub fn public_course(
    slug: &str,
    certificate_title: impl Fn(&str) -> Option<String>,
    opens_signed_out: impl Fn(&str) -> Result<bool, Refusal>,
    quizzes: &BTreeSet<String>,
) -> Result<Json, Refusal> {
    let path = published_course(slug)?;
    let syllabus = spine::list(Some(path), None);
    let open = syllabus
        .iter()
        .map(|row| opens_signed_out(&row.slug))
        .collect::<Result<Vec<bool>, Refusal>>()?;
    let mut seen = BTreeSet::new();
    let mut outcomes = Vec::new();
    for (row, open) in syllabus.iter().zip(&open) {
        if !open {
            continue;
        }
        for objective in &row.objectives {
            if seen.insert(objective.as_str()) {
                outcomes.push(Json::str(objective.clone()));
            }
        }
    }
    let typed = syllabus
        .iter()
        .map(|row| {
            let Json::Object(mut fields) = row.summary_json() else {
                return Json::Null;
            };
            fields.push((
                "type".to_owned(),
                Json::str(spine::item_type(&row.kind, quizzes.contains(&row.slug))),
            ));
            Json::Object(fields)
        })
        .collect();
    Ok(Json::obj([
        ("slug", Json::str(path)),
        ("summary", Json::Null),
        ("instructor", Json::Null),
        ("outcomes", Json::Array(outcomes)),
        ("syllabus", Json::Array(typed)),
        (
            "certificate",
            certificate_title(path).map_or(Json::Null, Json::String),
        ),
    ]))
}
