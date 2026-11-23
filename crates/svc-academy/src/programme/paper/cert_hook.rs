//! After a sealed, complete paper drill, the workbook may count as a certificate *item* (`paper/cert-progress-hook.ts`).
//! This path never grants a certificate, invents XP, maps a certificate to perk money or posts anything; a workbook no
//! certificate requires is named unbound (`academy.paper_cert_unbound`), not faked into a grant.
//!
//! `decide_item_complete` and `workbook_cert_binding` are the two pure rules of `certs/progress.ts` the hook calls,
//! kept here until the certs slice ports that file; nothing mounted reaches the hook (see the slice's report).

use service_kit::json::Json;
use service_kit::schema::js_trim;
use service_kit::time::Instant;

use super::workbook::{DrillRun, is_drill_complete};
use crate::errors::{AcademyError, Refusal};

/// `CertDefinition`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CertDefinition {
    pub id: String,
    pub title: String,
    pub required_item_slugs: Vec<String>,
}

/// `ItemCompletionRecord`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ItemCompletionRecord {
    pub user_id: String,
    pub item_slug: String,
    pub completed_at: Instant,
}

/// `PAPER_CERT_UNBOUND`.
pub const PAPER_CERT_UNBOUND: &str = "academy.paper_cert_unbound";

fn cert_invalid() -> Refusal {
    AcademyError::new("Invalid item slug", "academy.cert_invalid").into()
}

fn valid_slug(item_slug: &str) -> Result<&str, Refusal> {
    let slug = js_trim(item_slug);
    if slug.is_empty() || slug.encode_utf16().count() > 120 {
        return Err(cert_invalid());
    }
    Ok(slug)
}

/// `decideItemComplete`: the existing completion, or a new one now.
pub fn decide_item_complete(
    user_id: &str,
    item_slug: &str,
    existing: Option<&ItemCompletionRecord>,
    now: Instant,
) -> Result<(ItemCompletionRecord, bool), Refusal> {
    let slug = valid_slug(item_slug)?;
    if let Some(existing) = existing {
        return Ok((existing.clone(), true));
    }
    Ok((
        ItemCompletionRecord {
            user_id: user_id.to_owned(),
            item_slug: slug.to_owned(),
            completed_at: now,
        },
        false,
    ))
}

/// `WorkbookCertBinding`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkbookCertBinding {
    Bound { cert_id: String, item_slug: String },
    Unbound { item_slug: String },
}

/// `workbookCertBinding`: the first certificate that requires the workbook, or unbound.
pub fn workbook_cert_binding(
    item_slug: &str,
    certs: &[CertDefinition],
) -> Result<WorkbookCertBinding, Refusal> {
    let slug = valid_slug(item_slug)?;
    Ok(
        match certs
            .iter()
            .find(|c| c.required_item_slugs.iter().any(|s| s == slug))
        {
            None => WorkbookCertBinding::Unbound {
                item_slug: slug.to_owned(),
            },
            Some(cert) => WorkbookCertBinding::Bound {
                cert_id: cert.id.clone(),
                item_slug: slug.to_owned(),
            },
        },
    )
}

/// `PaperCertProgressView`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PaperCertProgressView {
    Incomplete,
    Unbound {
        item_slug: String,
    },
    Recorded {
        cert_id: String,
        item_slug: String,
        already_complete: bool,
        completed_at: Instant,
    },
}

impl PaperCertProgressView {
    /// The view as the TypeScript returns it, keys in its order (`completedAt` as `JSON.stringify` writes a Date).
    pub fn json(&self) -> Json {
        let mut fields = vec![
            ("simulated".to_owned(), Json::Bool(true)),
            ("realMoney".to_owned(), Json::Bool(false)),
        ];
        match self {
            PaperCertProgressView::Incomplete => {
                fields.push(("progress".to_owned(), Json::str("incomplete")));
            }
            PaperCertProgressView::Unbound { item_slug } => {
                fields.push(("progress".to_owned(), Json::str("unbound")));
                fields.push(("reason".to_owned(), Json::str(PAPER_CERT_UNBOUND)));
                fields.push(("itemSlug".to_owned(), Json::str(item_slug.clone())));
            }
            PaperCertProgressView::Recorded {
                cert_id,
                item_slug,
                already_complete,
                completed_at,
            } => {
                fields.push(("progress".to_owned(), Json::str("recorded")));
                fields.push(("certId".to_owned(), Json::str(cert_id.clone())));
                fields.push(("itemSlug".to_owned(), Json::str(item_slug.clone())));
                fields.push(("alreadyComplete".to_owned(), Json::Bool(*already_complete)));
                fields.push(("completedAt".to_owned(), Json::str(completed_at.iso())));
            }
        }
        fields.push(("grantCert".to_owned(), Json::Bool(false)));
        fields.push(("perkMap".to_owned(), Json::Bool(false)));
        Json::Object(fields)
    }
}

/// `recordPaperCertItemProgress`: an incomplete drill records nothing; an unbound workbook is named; a bound one is
/// decided by `decideItemComplete` and handed to `persist` when new. Nothing here can grant a certificate.
pub fn record_paper_cert_item_progress(
    user_id: &str,
    run: &DrillRun,
    certs: &[CertDefinition],
    existing: Option<&ItemCompletionRecord>,
    persist: &mut dyn FnMut(&ItemCompletionRecord),
    now: Instant,
) -> Result<PaperCertProgressView, Refusal> {
    if !is_drill_complete(run) {
        return Ok(PaperCertProgressView::Incomplete);
    }
    let (cert_id, item_slug) = match workbook_cert_binding(&run.workbook_slug, certs)? {
        WorkbookCertBinding::Unbound { item_slug } => {
            return Ok(PaperCertProgressView::Unbound { item_slug });
        }
        WorkbookCertBinding::Bound { cert_id, item_slug } => (cert_id, item_slug),
    };
    let (record, already_complete) = decide_item_complete(user_id, &item_slug, existing, now)?;
    if !already_complete {
        persist(&record);
    }
    Ok(PaperCertProgressView::Recorded {
        cert_id,
        item_slug,
        already_complete,
        completed_at: record.completed_at,
    })
}
