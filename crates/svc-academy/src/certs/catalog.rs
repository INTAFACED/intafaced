//! The certificate catalogue (`certs/catalog.ts`): code-seeded, no database. A requirement is a curriculum slug, or
//! `assessment:<slug>` for a published assessment's pass. Foundations is the one published certificate; Markets,
//! Builder and Sovereign have none until the owner writes their definitions here, so their progress, enrolment and
//! claims refuse `academy.certificate_unpublished`.

use std::sync::OnceLock;

use service_kit::json::Json;
use service_kit::schema::js_trim;

use crate::curriculum::spine;

/// `CertDefinition`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CertDefinition {
    /// Stable id, e.g. `foundations-v1`.
    pub id: String,
    pub title: String,
    /// The programme path it belongs to; a test fixture that is not a path certificate may have none.
    pub path: Option<String>,
    /// Curriculum slugs, or `assessment:<slug>`.
    pub required_item_slugs: Vec<String>,
}

impl CertDefinition {
    pub fn new(id: &str, title: &str, path: Option<&str>, required: &[&str]) -> CertDefinition {
        CertDefinition {
            id: id.to_owned(),
            title: title.to_owned(),
            path: path.map(str::to_owned),
            required_item_slugs: required.iter().map(|s| (*s).to_owned()).collect(),
        }
    }

    /// `certDefinitions`' row: `{ id, title, requiredItemSlugs }`.
    pub fn json(&self) -> Json {
        Json::obj([
            ("id", Json::str(self.id.clone())),
            ("title", Json::str(self.title.clone())),
            (
                "requiredItemSlugs",
                Json::Array(
                    self.required_item_slugs
                        .iter()
                        .map(|s| Json::str(s.clone()))
                        .collect(),
                ),
            ),
        ])
    }
}

/// `CERT_PATHS`: the paths a certificate may belong to, in the programmes' order.
pub const CERT_PATHS: [&str; 4] = ["foundations", "markets", "builder", "sovereign"];

/// `FOUNDATIONS_V1`: every Foundations curriculum item on tip.
pub fn foundations_v1() -> CertDefinition {
    CertDefinition::new(
        "foundations-v1",
        "Foundations",
        Some("foundations"),
        &[
            "foundations-risk-first",
            "foundations-order-types",
            "foundations-paper-workbook",
            "foundations-position-sizing",
            "foundations-journal-discipline",
            "foundations-invalidation-first",
            "foundations-fees-are-real",
        ],
    )
}

/// `CERT_CATALOG`: the owner-published certificates.
pub fn production() -> &'static [CertDefinition] {
    static CATALOG: OnceLock<Vec<CertDefinition>> = OnceLock::new();
    CATALOG.get_or_init(|| vec![foundations_v1()])
}

/// `CertCatalogError`'s message.
pub type CatalogError = String;

/// `assertCertCatalog(defs, known)`: every id unique and titled, one certificate per path, every requirement a known
/// lesson or assessment.
pub fn assert_catalog(
    defs: &[CertDefinition],
    lesson: &dyn Fn(&str) -> bool,
    assessment: &dyn Fn(&str) -> bool,
) -> Result<(), CatalogError> {
    let mut paths: Vec<&str> = Vec::new();
    let mut ids: Vec<&str> = Vec::new();
    for def in defs {
        if def.id.is_empty() || js_trim(&def.title).is_empty() || ids.contains(&def.id.as_str()) {
            let id = if def.id.is_empty() {
                "(blank)"
            } else {
                &def.id
            };
            return Err(format!("certificate {id} is blank or duplicated"));
        }
        ids.push(&def.id);
        let Some(path) = def
            .path
            .as_deref()
            .filter(|p| !p.is_empty() && CERT_PATHS.contains(p))
        else {
            return Err(format!(
                "{} has no path among foundations, markets, builder, sovereign",
                def.id
            ));
        };
        if paths.contains(&path) {
            return Err(format!("two certificates on path {path}"));
        }
        paths.push(path);
        if def.required_item_slugs.is_empty() {
            return Err(format!("{} has no requirements", def.id));
        }
        for slug in &def.required_item_slugs {
            if let Some(a) = slug.strip_prefix("assessment:") {
                if a.is_empty() || a.contains(':') || !assessment(a) {
                    return Err(format!("{} names unknown assessment {slug}", def.id));
                }
            } else if !lesson(slug) {
                return Err(format!("{} names unknown lesson {slug}", def.id));
            }
        }
    }
    Ok(())
}

/// The module-load check of `CERT_CATALOG` against the spine and the (empty) published assessment catalogue: the
/// service does not start on a broken catalogue.
pub fn check() -> Result<(), CatalogError> {
    assert_catalog(production(), &spine::has, &|_| false)
}

/// `certById`.
pub fn by_id<'a>(id: &str, catalog: &'a [CertDefinition]) -> Option<&'a CertDefinition> {
    catalog.iter().find(|c| c.id == id)
}

/// `certificateForPath`.
pub fn for_path<'a>(path: &str, catalog: &'a [CertDefinition]) -> Option<&'a CertDefinition> {
    catalog.iter().find(|c| c.path.as_deref() == Some(path))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_published_catalogue_passes_its_own_check() {
        assert_eq!(check(), Ok(()));
        assert_eq!(production().len(), 1);
    }
}
