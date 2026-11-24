//! The progress rules (`certs/progress.ts`), pure: what completes a certificate, the grant decision, an item
//! completion, a workbook's binding, and the progress report with its four-place ratio. A re-completion and a re-grant
//! are idempotent; an incomplete set never grants; nothing here moves money or maps a certificate to a perk.

use std::collections::BTreeSet;

use service_kit::json::Json;
use service_kit::schema::js_trim;
use service_kit::time::Instant;

use super::catalog::CertDefinition;
use super::honesty;
use crate::errors::{AcademyError, Refusal};

/// `CertGrantRecord`: one grant, keyed once per learner and certificate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Grant {
    pub user_id: String,
    pub cert_id: String,
    /// Epoch milliseconds.
    pub granted_at: i64,
    pub idempotency_key: String,
}

impl Grant {
    /// The grant as its JSON object (`{ userId, certId, grantedAt, idempotencyKey }`), for the honesty checks.
    pub fn json(&self) -> Json {
        Json::obj([
            ("userId", Json::str(self.user_id.clone())),
            ("certId", Json::str(self.cert_id.clone())),
            ("grantedAt", Json::str(Instant(self.granted_at).iso())),
            ("idempotencyKey", Json::str(self.idempotency_key.clone())),
        ])
    }
}

/// `CertError` as the service rethrows it (`mapCertErr`): an `AcademyError` with the same message and code.
fn cert_error(message: &str, code: &str) -> Refusal {
    AcademyError::new(message, code).into()
}

/// `certIdempotencyKey(userId, certId)`: `cert:<user>:<cert>`.
pub fn idempotency_key(user_id: &str, cert_id: &str) -> String {
    format!("cert:{user_id}:{cert_id}")
}

/// `assessmentRequirementSlug`: the slug of an `assessment:<slug>` requirement, or none for a lesson.
pub fn assessment_requirement_slug(requirement: &str) -> Option<&str> {
    let slug = requirement.strip_prefix("assessment:")?;
    (!slug.is_empty() && !slug.contains(':')).then_some(slug)
}

/// `requirementMet`: an assessment requirement counts only a pass; a lesson only its completion.
pub fn requirement_met(
    requirement: &str,
    completed: &BTreeSet<String>,
    passed: &BTreeSet<String>,
) -> bool {
    match assessment_requirement_slug(requirement) {
        Some(a) => passed.contains(a),
        None => completed.contains(requirement),
    }
}

/// `isComplete`.
pub fn is_complete(
    required: &[String],
    completed: &BTreeSet<String>,
    passed: &BTreeSet<String>,
) -> bool {
    required
        .iter()
        .all(|s| requirement_met(s, completed, passed))
}

/// `decideGrant`: the grant to write, or the one already held (`already_granted`). Refuses an unknown or empty
/// certificate and an incomplete set.
pub fn decide_grant(
    user_id: &str,
    cert: Option<&CertDefinition>,
    completed: &BTreeSet<String>,
    existing: Option<&Grant>,
    passed: &BTreeSet<String>,
    now: i64,
) -> Result<(Grant, bool), Refusal> {
    let Some(cert) = cert else {
        return Err(cert_error(
            "Unknown certification",
            "academy.cert_not_found",
        ));
    };
    if cert.required_item_slugs.is_empty() {
        return Err(cert_error(
            "Cert definition has no required items",
            "academy.cert_invalid",
        ));
    }
    if let Some(e) = existing {
        honesty::assert_grant_path_honest(&e.json())?;
        return Ok((e.clone(), true));
    }
    if !is_complete(&cert.required_item_slugs, completed, passed) {
        return Err(cert_error(
            "Required curriculum items incomplete",
            "academy.cert_incomplete",
        ));
    }
    let grant = Grant {
        user_id: user_id.to_owned(),
        cert_id: cert.id.clone(),
        granted_at: now,
        idempotency_key: idempotency_key(user_id, &cert.id),
    };
    honesty::assert_grant_path_honest(&grant.json())?;
    Ok((grant, false))
}

/// `alreadyGrantedAfterInsert`: an insert that returned no row lost the race to another writer.
pub fn already_granted_after_insert(insert_returned: bool) -> bool {
    !insert_returned
}

/// `ItemCompletionRecord`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Completion {
    pub user_id: String,
    pub item_slug: String,
    pub completed_at: i64,
}

fn item_slug_of(item_slug: &str) -> Result<&str, Refusal> {
    let slug = js_trim(item_slug);
    if slug.is_empty() || slug.encode_utf16().count() > 120 {
        return Err(cert_error("Invalid item slug", "academy.cert_invalid"));
    }
    Ok(slug)
}

/// `decideItemComplete`: a re-completion answers the stored record.
pub fn decide_item_complete(
    user_id: &str,
    item_slug: &str,
    existing: Option<&Completion>,
    now: i64,
) -> Result<(Completion, bool), Refusal> {
    let slug = item_slug_of(item_slug)?;
    if let Some(e) = existing {
        return Ok((e.clone(), true));
    }
    Ok((
        Completion {
            user_id: user_id.to_owned(),
            item_slug: slug.to_owned(),
            completed_at: now,
        },
        false,
    ))
}

/// `PAPER_CERT_UNBOUND`.
pub const PAPER_CERT_UNBOUND: &str = "academy.paper_cert_unbound";

/// `WorkbookCertBinding`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Binding {
    Bound { cert_id: String, item_slug: String },
    Unbound { item_slug: String },
}

/// `workbookCertBinding`: the certificate that lists a workbook as required, or an honest unbound.
pub fn workbook_cert_binding(
    item_slug: &str,
    certs: &[CertDefinition],
) -> Result<Binding, Refusal> {
    let slug = item_slug_of(item_slug)?;
    Ok(
        match certs
            .iter()
            .find(|c| c.required_item_slugs.iter().any(|s| s == slug))
        {
            Some(c) => Binding::Bound {
                cert_id: c.id.clone(),
                item_slug: slug.to_owned(),
            },
            None => Binding::Unbound {
                item_slug: slug.to_owned(),
            },
        },
    )
}

/// `ProgressReport`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Report {
    pub user_id: String,
    pub cert_id: String,
    pub title: String,
    pub required_count: usize,
    pub completed_count: usize,
    /// `(completed / required).toFixed(4)`.
    pub ratio: String,
    pub missing_item_slugs: Vec<String>,
    pub complete: bool,
    pub granted: bool,
    pub grant_idempotency_key: Option<String>,
}

/// `Number.prototype.toFixed(4)` of `completed / required` as a double, digit for digit: the double's exact value is
/// rounded to four places, a tie going up.
pub fn ratio_fixed4(completed: u32, required: u32) -> String {
    #[expect(
        clippy::float_arithmetic,
        reason = "the ratio is JavaScript's double division, then its exact toFixed; a progress key, not money"
    )]
    let x = f64::from(completed) / f64::from(required);
    let bits = x.to_bits();
    let exp = i64::try_from((bits >> 52) & 0x7ff).unwrap_or(0);
    let frac = u128::from(bits & ((1u64 << 52) - 1));
    // x = mantissa * 2^-shift.
    let (mantissa, shift) = if exp == 0 {
        (frac, 1074i64)
    } else {
        (frac | (1u128 << 52), 1075 - exp)
    };
    let scaled = mantissa * 10_000;
    let n: u128 = if shift <= 0 {
        scaled << u32::try_from(-shift).unwrap_or(0)
    } else if shift >= 127 {
        0
    } else {
        let s = u32::try_from(shift).unwrap_or(0);
        let whole = scaled >> s;
        let rem = scaled & ((1u128 << s) - 1);
        if rem << 1 >= 1u128 << s {
            whole + 1
        } else {
            whole
        }
    };
    format!("{}.{:04}", n / 10_000, n % 10_000)
}

/// `progressReport`.
pub fn report(
    user_id: &str,
    cert: Option<&CertDefinition>,
    completed: &BTreeSet<String>,
    existing: Option<&Grant>,
    passed: &BTreeSet<String>,
) -> Result<Report, Refusal> {
    let Some(cert) = cert else {
        return Err(cert_error(
            "Unknown certification",
            "academy.cert_not_found",
        ));
    };
    if cert.required_item_slugs.is_empty() {
        return Err(cert_error(
            "Cert definition has no required items",
            "academy.cert_invalid",
        ));
    }
    let required = &cert.required_item_slugs;
    let missing: Vec<String> = required
        .iter()
        .filter(|s| !requirement_met(s, completed, passed))
        .cloned()
        .collect();
    let completed_count = required.len() - missing.len();
    let as_u32 = |n: usize| u32::try_from(n).unwrap_or(u32::MAX);
    Ok(Report {
        user_id: user_id.to_owned(),
        cert_id: cert.id.clone(),
        title: cert.title.clone(),
        required_count: required.len(),
        completed_count,
        ratio: ratio_fixed4(as_u32(completed_count), as_u32(required.len())),
        complete: missing.is_empty(),
        missing_item_slugs: missing,
        granted: existing.is_some(),
        grant_idempotency_key: existing.map(|g| g.idempotency_key.clone()),
    })
}

/// `isGrantReady`: complete and not yet granted.
pub fn is_grant_ready(r: &Report) -> bool {
    r.complete && !r.granted
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_ratio_is_javascripts_to_fixed() {
        // node -e "for (const [a,b] of [[1,32],[1,3],[2,3],[0,7],[7,7],[1,160],[3,7]]) console.log((a/b).toFixed(4))"
        let cases = [
            (1, 32, "0.0313"),
            (1, 3, "0.3333"),
            (2, 3, "0.6667"),
            (0, 7, "0.0000"),
            (7, 7, "1.0000"),
            (1, 160, "0.0063"),
            (3, 7, "0.4286"),
        ];
        for (a, b, want) in cases {
            assert_eq!(ratio_fixed4(a, b), want, "{a}/{b}");
        }
    }
}
