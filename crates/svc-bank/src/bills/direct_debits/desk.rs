//! Direct debit mandates for the finance desk, as the partner reports them (`ops/direct-debit-mandates.ts`, J-bank-28
//! #4, BK-xfer-11).
//!
//! When the partner bank holds people's money it is the bank the scheme collects from, so the desk reads the partner's
//! own report: each mandate it knows with its state and block, each refund it made, and each collection it refused,
//! counted by its reason code. svc-bank adds only what the scheme told it of each mandate (whose it is, the creditor, the
//! reference and the asset); a mandate svc-bank never heard of, or one the partner names for another person, shows those
//! as null. With no partner answering the answer is `{ partner: null }`. Every read writes one structured log line with
//! the operator before anything is read, and refuses if it can't.

use std::collections::BTreeMap;

use service_kit::json::Json;
use service_kit::money::format_amount;

use super::super::Deps;
use super::service::{Mandate, ops_mandate_details};
use crate::errors::Refusal;
use crate::partner::desks::DebitReport;
use crate::partner::refuse;

/// `writeMandatesReadAudit`.
pub fn audit(actor: &str) -> Result<(), Refusal> {
    use std::io::Write;
    let line = Json::obj([
        ("level", Json::str("info")),
        ("service", Json::str("svc-bank")),
        ("event", Json::str("bank.ops.dd_mandates_read")),
        ("actorUserId", Json::str(actor)),
    ]);
    writeln!(std::io::stdout(), "{}", line.compact()).map_err(|_| {
        refuse(
            "bank.ops_audit_unavailable",
            "The read could not be recorded, so nothing was read",
        )
    })
}

/// `directDebitMandatesView`: the partner's report with what svc-bank knows of each mandate.
pub fn view(report: Option<&DebitReport>, details: &BTreeMap<String, Mandate>) -> Json {
    let Some(report) = report else {
        return Json::obj([("partner", Json::Null)]);
    };
    let mut by_reason: Vec<(String, i64)> = Vec::new();
    for (_, _, _, code) in &report.failures {
        match by_reason.iter_mut().find(|(c, _)| c == code) {
            Some((_, n)) => *n += 1,
            None => by_reason.push((code.clone(), 1)),
        }
    }
    by_reason.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    let iso = |t: Option<service_kit::time::Instant>| t.map_or(Json::Null, |t| Json::str(t.iso()));
    let mandates = report
        .mandates
        .iter()
        .map(|(user, mandate, blocked_at, known_at)| {
            let ours = details.get(mandate).filter(|m| &m.user_id == user);
            let known =
                |f: fn(&Mandate) -> &String| ours.map_or(Json::Null, |m| Json::str(f(m).clone()));
            let refunds = report
                .refunds
                .iter()
                .filter(|r| &r.user_id == user && &r.mandate_id == mandate)
                .map(|r| {
                    Json::obj([
                        ("collectionId", Json::str(r.collection_id.clone())),
                        ("assetId", Json::str(r.asset_id.clone())),
                        ("amount", Json::str(format_amount(r.amount))),
                        ("moveId", Json::str(r.move_id.clone())),
                        ("refundedAt", Json::str(r.refunded_at.iso())),
                    ])
                })
                .collect();
            let failures = report
                .failures
                .iter()
                .zip(report.failed_at.iter())
                .filter(|((u, m, _, _), _)| u == user && m == mandate)
                .map(|((_, _, collection, code), at)| {
                    Json::obj([
                        ("collectionId", Json::str(collection.clone())),
                        ("code", Json::str(code.clone())),
                        ("at", Json::str(at.iso())),
                    ])
                })
                .collect();
            Json::obj([
                ("mandateId", Json::str(mandate.clone())),
                ("userId", Json::str(user.clone())),
                (
                    "state",
                    Json::str(if blocked_at.is_some() {
                        "blocked"
                    } else {
                        "active"
                    }),
                ),
                ("blockedAt", iso(*blocked_at)),
                ("knownAt", Json::str(known_at.iso())),
                ("creditorName", known(|m| &m.creditor_name)),
                ("reference", known(|m| &m.reference)),
                ("assetId", known(|m| &m.asset_id)),
                ("refunds", Json::Array(refunds)),
                ("failures", Json::Array(failures)),
            ])
        })
        .collect();
    Json::obj([(
        "partner",
        Json::obj([
            ("label", Json::str(crate::partner::LABEL)),
            ("asOf", Json::str(report.as_of.iso())),
            ("mandates", Json::Array(mandates)),
            (
                "failuresByReason",
                Json::Array(
                    by_reason
                        .into_iter()
                        .map(|(code, count)| {
                            Json::obj([("code", Json::str(code)), ("count", Json::int(count))])
                        })
                        .collect(),
                ),
            ),
            (
                "refundCount",
                Json::int(i64::try_from(report.refunds.len()).unwrap_or(i64::MAX)),
            ),
        ]),
    )])
}

/// `ops.directDebitMandates`: the audit line first, then the TEST partner's report when it is on, else no data.
pub fn read(d: &Deps<'_>, actor: &str) -> Result<Json, Refusal> {
    audit(actor)?;
    let Some(partner) = d.t.custody.partner else {
        return Ok(view(None, &BTreeMap::new()));
    };
    let report = partner.lock().dd_report(d.now());
    let mut ids: Vec<String> = report.mandates.iter().map(|m| m.1.clone()).collect();
    ids.sort();
    ids.dedup();
    let details = ops_mandate_details(d, &ids)?
        .into_iter()
        .map(|m| (m.id.clone(), m))
        .collect();
    Ok(view(Some(&report), &details))
}
