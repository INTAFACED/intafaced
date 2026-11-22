//! `bankAccount.*` (`onboarding/bank-account.router.ts`, `bank-account-terms.ts`, `personal-pay/payee-controls.ts`
//! `parseProofLimits`): the person's bank account at the partner bank (J-bank-17). Onboarding, the partner's information
//! requests and periodic reviews, closing and reopening the account, and data-rights requests. Every answer is the
//! partner's, read from slice `partner`'s TEST compliance record; our ledger posts nothing for any of it.
//!
//! A person whose bank money the partner does not hold (the custodial layer, or no partner) is refused
//! `bank.no_partner_bank`. The owner's values (`BANK_ONBOARDING_REQUIREMENTS_JSON`, `BANK_INFO_REQUEST_UPLOAD_JSON`,
//! `BANK_REOPEN_WINDOW_DAYS`) have no default: each blank one reads as unset and refuses where it is needed.

use std::collections::BTreeMap;

use service_kit::json::{self, Json};
use service_kit::money::{format_amount, js_trim};
use service_kit::schema::Value;
use service_kit::server::Response;
use service_kit::time::Instant;

use super::{Deps, refuse};
use crate::door::Ctx;
use crate::errors::Refusal;
use crate::partner::TestPartner;
use crate::partner::compliance::{
    Closure, DataRequest, Destination, InfoRequest, REQUIREMENTS, Review,
};
use crate::spaces::home::personal_only;

/// `ProofLimits`: the file types (lower case) and the size cap of an uploaded answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProofLimits {
    pub allowed_types: Vec<String>,
    pub max_bytes: i64,
}

/// `BankAccountTerms`: each owner value, or `None` when it is not published.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Wiring {
    pub owner_requirements: Option<Vec<String>>,
    pub upload: Option<ProofLimits>,
    pub reopen_window_days: Option<i64>,
}

fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// `parseJson`: a blank value is none, unreadable JSON is none.
fn parse_json(raw: Option<&String>) -> Option<Json> {
    let raw = raw?;
    if js_trim(raw).is_empty() {
        return None;
    }
    json::parse(raw).ok()
}

/// A JSON number that is a whole number (zod's `int()`), as an integer.
fn whole(v: Option<&Json>) -> Option<i64> {
    let Some(Json::Number(n)) = v else {
        return None;
    };
    json::js_number_string(*n).parse().ok()
}

/// `requirementsShape`: 1 to 30 strings, each trimmed to 1 to 300 characters.
fn parse_requirements(raw: Option<&String>) -> Option<Vec<String>> {
    let Some(Json::Array(rows)) = parse_json(raw) else {
        return None;
    };
    if rows.is_empty() || rows.len() > 30 {
        return None;
    }
    rows.iter()
        .map(|r| match r {
            Json::String(s) => {
                let t = js_trim(s);
                (1..=300).contains(&utf16_len(t)).then(|| t.to_owned())
            }
            _ => None,
        })
        .collect()
}

/// A media type as `limitsShape` takes it: `/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i`.
fn media_type(s: &str) -> bool {
    let ok = |p: &str| {
        !p.is_empty()
            && p.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b".+-".contains(&b))
    };
    s.split_once('/').is_some_and(|(a, b)| ok(a) && ok(b))
}

/// `parseProofLimits`: `{ "allowedTypes": [...], "maxBytes": n }`, strict; blank or unreadable is none.
pub fn parse_proof_limits(raw: Option<&String>) -> Option<ProofLimits> {
    let v = parse_json(raw)?;
    let Json::Object(fields) = &v else {
        return None;
    };
    if fields
        .iter()
        .any(|(k, _)| k != "allowedTypes" && k != "maxBytes")
    {
        return None;
    }
    let Some(Json::Array(types)) = v.get("allowedTypes") else {
        return None;
    };
    if types.is_empty() {
        return None;
    }
    let allowed_types = types
        .iter()
        .map(|t| match t {
            Json::String(s) if media_type(js_trim(s)) => Some(js_trim(s).to_lowercase()),
            _ => None,
        })
        .collect::<Option<Vec<_>>>()?;
    let max_bytes = whole(v.get("maxBytes")).filter(|n| (1..=25_000_000).contains(n))?;
    Some(ProofLimits {
        allowed_types,
        max_bytes,
    })
}

impl Wiring {
    /// `parseBankAccountTerms` over the environment.
    pub fn from_env(env: &BTreeMap<String, String>) -> Result<Wiring, String> {
        let days = env
            .get("BANK_REOPEN_WINDOW_DAYS")
            .map(|d| js_trim(d))
            .filter(|d| (1..=4).contains(&d.len()) && d.bytes().all(|b| b.is_ascii_digit()))
            .and_then(|d| d.parse::<i64>().ok())
            .filter(|d| (1..=3650).contains(d));
        Ok(Wiring {
            owner_requirements: parse_requirements(env.get("BANK_ONBOARDING_REQUIREMENTS_JSON")),
            upload: parse_proof_limits(env.get("BANK_INFO_REQUEST_UPLOAD_JSON")),
            reopen_window_days: days,
        })
    }
}

const DAY_MS: i64 = 86_400_000;

fn opt_iso(at: Option<Instant>) -> Json {
    at.map_or(Json::Null, |a| Json::str(a.iso()))
}

fn unset(code: &str) -> Json {
    Json::obj([("state", Json::str("unset")), ("code", Json::str(code))])
}

fn count(n: usize) -> Json {
    Json::int(i64::try_from(n).unwrap_or(i64::MAX))
}

fn request_wire(r: &InfoRequest) -> Json {
    Json::obj([
        ("id", Json::str(r.id.clone())),
        ("title", Json::str(r.title)),
        ("detail", Json::str(r.detail)),
        ("openedAt", Json::str(r.opened_at.iso())),
        ("dueAt", Json::str(r.due_at.iso())),
        ("status", Json::str(r.status)),
        ("answeredAt", opt_iso(r.answered_at)),
        (
            "file",
            r.file.as_ref().map_or(Json::Null, |f| {
                Json::obj([
                    ("name", Json::str(f.name.clone())),
                    ("type", Json::str(f.kind.clone())),
                    ("size", count(f.size)),
                    ("sha256", Json::str(f.sha256.clone())),
                ])
            }),
        ),
        ("label", Json::str(r.label)),
    ])
}

fn review_wire(r: &Review) -> Json {
    Json::obj([
        ("id", Json::str(r.id.clone())),
        ("title", Json::str(r.title)),
        ("dueAt", Json::str(r.due_at.iso())),
        ("missedEffect", Json::str(r.missed_effect)),
        ("status", Json::str(r.status)),
        ("answeredAt", opt_iso(r.answered_at)),
        ("label", Json::str(r.label)),
    ])
}

fn closure_wire(c: &Closure) -> Json {
    Json::obj([
        ("id", Json::str(c.id.clone())),
        ("state", Json::str(c.state)),
        ("requestedAt", Json::str(c.requested_at.iso())),
        (
            "balances",
            Json::Array(
                c.balances
                    .iter()
                    .map(|b| {
                        Json::obj([
                            ("assetId", Json::str(b.asset_id.clone())),
                            (
                                "spaceId",
                                b.space_id
                                    .as_ref()
                                    .map_or(Json::Null, |s| Json::str(s.clone())),
                            ),
                            ("amount", Json::str(format_amount(b.amount))),
                        ])
                    })
                    .collect(),
            ),
        ),
        (
            "destination",
            c.destination.as_ref().map_or(Json::Null, |d| {
                Json::obj([
                    ("name", Json::str(d.name.clone())),
                    ("accountRef", Json::str(d.account_ref.clone())),
                ])
            }),
        ),
        (
            "payoutMoveIds",
            Json::Array(c.payout_move_ids.iter().map(Json::str).collect()),
        ),
        ("paidOutAt", opt_iso(c.paid_out_at)),
        ("closedAt", opt_iso(c.closed_at)),
        ("reopenedAt", opt_iso(c.reopened_at)),
        ("label", Json::str(c.label)),
    ])
}

fn data_wire(r: &DataRequest) -> Json {
    Json::obj([
        ("id", Json::str(r.id.clone())),
        ("kind", Json::str(r.kind.clone())),
        ("requestedAt", Json::str(r.requested_at.iso())),
        ("status", Json::str("received")),
        ("partnerRef", Json::str(r.partner_ref.clone())),
        ("label", Json::str(r.label)),
    ])
}

/// `partnerFor`: the partner's record for the person, once the profile in view is proved theirs and personal.
fn partner_for<'a>(
    d: &'a Deps<'_>,
    user: &str,
    profile: Option<&str>,
) -> Result<&'a TestPartner, Refusal> {
    personal_only(d.store, user, profile)?;
    let custody = d.partner.custody(d.store);
    match d.partner.partner.as_ref() {
        Some(p) if custody.bank_for(user).is_some() => Ok(p),
        _ => Err(refuse(
            "bank.no_partner_bank",
            "The partner bank does not hold a bank account for you, so there is nothing to onboard, review or close.",
        )),
    }
}

/// `Buffer.from(text, 'base64')` for a text already held to `/^[A-Za-z0-9+/]+={0,2}$/` and a length a multiple of four.
fn base64(text: &str) -> Vec<u8> {
    let value = |c: u8| match c {
        b'A'..=b'Z' => Some(c - b'A'),
        b'a'..=b'z' => Some(c - b'a' + 26),
        b'0'..=b'9' => Some(c - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    };
    let mut out = Vec::new();
    let mut acc: u32 = 0;
    let mut bits = 0u32;
    for v in text.bytes().filter_map(value) {
        acc = (acc << 6) | u32::from(v);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(u8::try_from((acc >> bits) & 0xff).unwrap_or(0));
        }
    }
    out
}

fn is_base64(text: &str) -> bool {
    let body = text.trim_end_matches('=');
    let pad = text.len() - body.len();
    !body.is_empty()
        && pad <= 2
        && body
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/')
        && text.len().is_multiple_of(4)
}

/// The answer of one of this part's calls, by its path; `None` for a path outside it.
pub fn answer(d: &Deps<'_>, ctx: &Ctx<'_>) -> Option<Result<Json, Refusal>> {
    let path = ctx.call.path.strip_prefix("bankAccount.")?;
    let principal = ctx.principal?;
    let user = principal.user_id.as_str();
    let input = &ctx.input;
    let text = |key: &str| input.get(key).as_str().unwrap_or_default().to_owned();
    let profile = input.get("profile").as_str();
    let terms = &d.wiring.bank_account;
    let now = ctx.now;
    Some((|| match path {
        "onboarding" => {
            let p = partner_for(d, user, profile)?;
            let state = p.lock();
            let o = state.onboarding(user, &principal.tier);
            let requests = state.compliance.requests(user);
            let reviews = state.compliance.reviews(user);
            drop(state);
            Ok(Json::obj([
                ("label", Json::str(crate::partner::LABEL)),
                (
                    "steps",
                    Json::Array(
                        o.steps
                            .iter()
                            .map(|s| {
                                Json::obj([
                                    ("id", Json::str(s.id)),
                                    ("title", Json::str(s.title)),
                                    ("status", Json::str(if s.done { "done" } else { "open" })),
                                    (
                                        "doneWith",
                                        if s.done_with_case {
                                            Json::str("identity_case")
                                        } else {
                                            Json::Null
                                        },
                                    ),
                                ])
                            })
                            .collect(),
                    ),
                ),
                (
                    "requirements",
                    Json::Array(REQUIREMENTS.iter().map(|r| Json::str(*r)).collect()),
                ),
                (
                    "ownerRequirements",
                    terms.owner_requirements.as_ref().map_or_else(
                        || unset("bank.onboarding_requirements_unset"),
                        |r| {
                            Json::obj([
                                ("state", Json::str("published")),
                                (
                                    "requirements",
                                    Json::Array(r.iter().map(Json::str).collect()),
                                ),
                            ])
                        },
                    ),
                ),
                (
                    "identityCase",
                    Json::obj([
                        ("tier", Json::str(o.tier.clone())),
                        ("accepted", Json::Bool(o.accepted)),
                    ]),
                ),
                ("complete", Json::Bool(o.complete)),
                (
                    "openRequests",
                    count(requests.iter().filter(|r| r.status == "open").count()),
                ),
                (
                    "openReviews",
                    count(reviews.iter().filter(|r| r.status == "open").count()),
                ),
            ]))
        }
        "requests" => {
            let p = partner_for(d, user, profile)?;
            let rows = p.lock().compliance.requests(user);
            Ok(Json::obj([
                (
                    "requests",
                    Json::Array(rows.iter().map(request_wire).collect()),
                ),
                (
                    "upload",
                    terms.upload.as_ref().map_or_else(
                        || unset("bank.info_request_upload_unset"),
                        |u| {
                            Json::obj([
                                ("state", Json::str("published")),
                                (
                                    "allowedTypes",
                                    Json::Array(u.allowed_types.iter().map(Json::str).collect()),
                                ),
                                ("maxBytes", Json::int(u.max_bytes)),
                            ])
                        },
                    ),
                ),
            ]))
        }
        "answerRequest" => {
            let p = partner_for(d, user, profile)?;
            let Some(limits) = terms.upload.as_ref() else {
                return Err(refuse(
                    "bank.info_request_upload_unset",
                    "The size cap and file types for an answer are not published, so nothing was sent.",
                ));
            };
            let kind = text("type").to_lowercase();
            if !limits.allowed_types.contains(&kind) {
                return Err(refuse(
                    "bank.info_request_type_not_allowed",
                    format!("A {kind} file is not one the bank takes for an answer."),
                ));
            }
            let content = text("contentBase64");
            if !is_base64(&content) {
                return Err(refuse(
                    "bank.info_request_file_invalid",
                    "The file could not be read.",
                ));
            }
            let bytes = base64(&content);
            if bytes.is_empty() {
                return Err(refuse(
                    "bank.info_request_file_invalid",
                    "The file is empty.",
                ));
            }
            if i64::try_from(bytes.len()).unwrap_or(i64::MAX) > limits.max_bytes {
                return Err(refuse(
                    "bank.info_request_too_large",
                    format!(
                        "The file is over the {}-byte cap, so nothing was sent.",
                        limits.max_bytes
                    ),
                ));
            }
            let row = p.lock().compliance.answer_request(
                user,
                &text("requestId"),
                (&text("name"), &kind, &bytes),
                now,
            )?;
            Ok(request_wire(&row))
        }
        "reviews" => {
            let p = partner_for(d, user, profile)?;
            let rows = p.lock().compliance.reviews(user);
            Ok(Json::obj([(
                "reviews",
                Json::Array(rows.iter().map(review_wire).collect()),
            )]))
        }
        "answerReview" => {
            let p = partner_for(d, user, profile)?;
            let row = p
                .lock()
                .compliance
                .answer_review(user, &text("reviewId"), now)?;
            Ok(review_wire(&row))
        }
        "closure" => {
            let p = partner_for(d, user, profile)?;
            let state = p.lock();
            let now_state = state.compliance.state_of(user);
            let closures = state.compliance.closures(user);
            drop(state);
            let closed_at = if now_state == "closed" {
                closures.first().and_then(|c| c.closed_at)
            } else {
                None
            };
            Ok(Json::obj([
                ("state", Json::str(now_state)),
                (
                    "closures",
                    Json::Array(closures.iter().map(closure_wire).collect()),
                ),
                (
                    "reopenWindow",
                    terms.reopen_window_days.map_or_else(
                        || unset("bank.reopen_window_unset"),
                        |days| {
                            Json::obj([
                                ("state", Json::str("published")),
                                ("days", Json::int(days)),
                                (
                                    "until",
                                    opt_iso(closed_at.map(|at| {
                                        Instant(at.0.saturating_add(days.saturating_mul(DAY_MS)))
                                    })),
                                ),
                            ])
                        },
                    ),
                ),
            ]))
        }
        "requestClosure" => {
            let p = partner_for(d, user, profile)?;
            let destination = match input.get("destination") {
                Value::Object(_) => Some(Destination {
                    name: input
                        .get("destination")
                        .get("name")
                        .as_str()
                        .unwrap_or_default()
                        .to_owned(),
                    account_ref: input
                        .get("destination")
                        .get("accountRef")
                        .as_str()
                        .unwrap_or_default()
                        .chars()
                        .filter(|c| !service_kit::money::is_js_whitespace(*c))
                        .collect::<String>()
                        .to_uppercase(),
                }),
                _ => None,
            };
            let closure_id = format!("{user}:{}", text("closureId"));
            let row = p
                .lock()
                .request_closure(user, &closure_id, destination, now)?;
            Ok(closure_wire(&row))
        }
        "reopen" => {
            let p = partner_for(d, user, profile)?;
            let Some(days) = terms.reopen_window_days else {
                return Err(refuse(
                    "bank.reopen_window_unset",
                    "How long a closed account may be reopened is not published, so it cannot be reopened here.",
                ));
            };
            let row = p.lock().reopen(user, days, now)?;
            Ok(closure_wire(&row))
        }
        "dataRequests" => {
            let p = partner_for(d, user, profile)?;
            let rows = p.lock().compliance.data_requests(user);
            Ok(Json::obj([(
                "requests",
                Json::Array(rows.iter().map(data_wire).collect()),
            )]))
        }
        "requestData" => {
            let p = partner_for(d, user, profile)?;
            let id = format!("{user}:{}", text("requestId"));
            let row = p
                .lock()
                .compliance
                .request_data(user, &id, &text("kind"), now)?;
            Ok(data_wire(&row))
        }
        other => Err(Refusal::Other(format!(
            "svc-bank in Rust: bankAccount.{other} is in no ported call"
        ))),
    })())
}

/// This part has no job door.
pub fn job(_d: &Deps<'_>, _path: &str, _body: &Value) -> Option<Response> {
    None
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test")]
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect()
    }

    #[test]
    fn every_owner_value_is_blank_until_published_and_read_as_written() {
        assert_eq!(Wiring::from_env(&env(&[])).unwrap(), Wiring::default());
        let w = Wiring::from_env(&env(&[
            (
                "BANK_ONBOARDING_REQUIREMENTS_JSON",
                r#"["  TEST: proof of address "]"#,
            ),
            (
                "BANK_INFO_REQUEST_UPLOAD_JSON",
                r#"{"allowedTypes":[" Application/PDF "],"maxBytes":1024}"#,
            ),
            ("BANK_REOPEN_WINDOW_DAYS", " 30 "),
        ]))
        .unwrap();
        assert_eq!(
            w.owner_requirements,
            Some(vec!["TEST: proof of address".to_owned()])
        );
        assert_eq!(
            w.upload,
            Some(ProofLimits {
                allowed_types: vec!["application/pdf".to_owned()],
                max_bytes: 1024
            })
        );
        assert_eq!(w.reopen_window_days, Some(30));
        for bad in ["0", "3651", "12345", "1.5", "-1"] {
            let w = Wiring::from_env(&env(&[("BANK_REOPEN_WINDOW_DAYS", bad)])).unwrap();
            assert_eq!(w.reopen_window_days, None, "{bad}");
        }
        for bad in ["[]", r#"[""]"#, "nope", r#"{"a":1}"#] {
            assert_eq!(parse_requirements(Some(&bad.to_owned())), None, "{bad}");
        }
        for bad in [
            r#"{"allowedTypes":[],"maxBytes":1}"#,
            r#"{"allowedTypes":["pdf"],"maxBytes":1}"#,
            r#"{"allowedTypes":["a/b"],"maxBytes":0}"#,
            r#"{"allowedTypes":["a/b"],"maxBytes":1.5}"#,
            r#"{"allowedTypes":["a/b"],"maxBytes":1,"x":1}"#,
        ] {
            assert_eq!(parse_proof_limits(Some(&bad.to_owned())), None, "{bad}");
        }
    }

    #[test]
    fn base64_reads_as_buffer_does() {
        assert_eq!(base64("aGVsbG8="), b"hello");
        assert_eq!(base64("AAAA"), [0, 0, 0]);
        assert!(is_base64("aGk="));
        assert!(!is_base64("aGk"));
        assert!(!is_base64("a=Gk"));
        assert!(!is_base64("===="));
    }
}
