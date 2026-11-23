//! svc-identity's recovery claim doors as svc-bank asks them (`recovery/identity-recovery.ts`):
//!
//! - `GET /internal/recovery-claims/estates/:heirUserId`: the accounts this person may claim.
//! - `POST /internal/recovery-claims/verify`: whether these signatures claim this account for this heir now. A refusal is an
//!   answer, not a failure.
//!
//! A transport error, a timeout, a non-2xx or an unreadable body is `bank.recovery_unavailable`: nothing is opened or
//! swept. No `IDENTITY_URL` is the same refusal, never "claimable".

use service_kit::http::{Fetch, HttpRequest, TIMED_OUT};
use service_kit::json::{self, Json};
use service_kit::s2s::CallSigner;

use crate::errors::Refusal;
use crate::partner_account::refuse;

/// One account the heir may claim (`RecoveryEstate`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Estate {
    pub user_id: String,
    pub handle: String,
    pub notice_id: String,
    pub threshold: i64,
    pub live_keys: i64,
}

/// Identity's verdict on one claim (`RecoveryClaimVerdict`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    Ok { notice_id: String },
    Refused { code: String },
}

/// How the slice asks identity.
pub trait IdentityRecovery: Send + Sync {
    /// The accounts `heir` may claim now, or `bank.recovery_unavailable`.
    fn estates(&self, heir: &str) -> Result<Vec<Estate>, Refusal>;
    /// Identity's verdict on `request` (`{ userId, heirUserId, claimId, signatures }`), or `bank.recovery_unavailable`.
    fn verify(&self, request: &Json) -> Result<Verdict, Refusal>;
}

fn unavailable(why: &str) -> Refusal {
    refuse(
        "bank.recovery_unavailable",
        format!("Recovery claims could not be checked: {why} [bank.recovery_unavailable]"),
    )
}

/// `unconfiguredIdentityRecovery`: no `IDENTITY_URL`, so every ask refuses.
pub struct Unconfigured;

impl IdentityRecovery for Unconfigured {
    fn estates(&self, _: &str) -> Result<Vec<Estate>, Refusal> {
        Err(unavailable("IDENTITY_URL is unset"))
    }

    fn verify(&self, _: &Json) -> Result<Verdict, Refusal> {
        Err(unavailable("IDENTITY_URL is unset"))
    }
}

/// zod's `guid()`: 8-4-4-4-12 hex digits, any case.
pub fn is_guid(s: &str) -> bool {
    let parts: Vec<&str> = s.split('-').collect();
    parts.len() == 5
        && parts
            .iter()
            .zip([8, 4, 4, 4, 12])
            .all(|(p, n)| p.len() == n && p.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// zod's `number().int()` with a floor: a safe integer at least `min`.
pub fn int_at_least(v: Option<&Json>, min: i64) -> Option<i64> {
    let Some(Json::Number(n)) = v else {
        return None;
    };
    let text = json::js_number_string(*n);
    let i: i64 = text.parse().ok()?;
    (i >= min && i.unsigned_abs() <= 9_007_199_254_740_991).then_some(i)
}

/// A strict object: these keys and no other.
pub fn only_keys(v: &Json, keys: &[&str]) -> bool {
    match v {
        Json::Object(fields) => fields.iter().all(|(k, _)| keys.contains(&k.as_str())),
        _ => false,
    }
}

fn string(v: Option<&Json>) -> Option<String> {
    match v {
        Some(Json::String(s)) => Some(s.clone()),
        _ => None,
    }
}

/// `recoveryEstatesSchema`.
fn parse_estates(body: &Json) -> Option<Vec<Estate>> {
    if !only_keys(body, &["estates"]) {
        return None;
    }
    let Some(Json::Array(rows)) = body.get("estates") else {
        return None;
    };
    rows.iter()
        .map(|row| {
            if !only_keys(
                row,
                &["userId", "handle", "noticeId", "threshold", "liveKeys"],
            ) {
                return None;
            }
            let user_id = string(row.get("userId")).filter(|s| is_guid(s))?;
            let handle = string(row.get("handle"))?;
            let notice_id = string(row.get("noticeId")).filter(|s| is_guid(s))?;
            Some(Estate {
                user_id,
                handle,
                notice_id,
                threshold: int_at_least(row.get("threshold"), 1)?,
                live_keys: int_at_least(row.get("liveKeys"), 0)?,
            })
        })
        .collect()
}

/// `RECOVERY_CLAIM_REFUSALS`.
const CLAIM_REFUSALS: [&str; 10] = [
    "identity.recovery_notice_unconfirmed",
    "identity.recovery_account_changed",
    "identity.recovery_changed_after_notice",
    "identity.recovery_heir_mismatch",
    "identity.recovery_heir_inactive",
    "identity.recovery_threshold_unset",
    "identity.recovery_key_unknown",
    "identity.recovery_key_revoked",
    "identity.recovery_signature_invalid",
    "identity.recovery_signatures_short",
];

/// `recoveryClaimVerdictSchema`.
fn parse_verdict(body: &Json) -> Option<Verdict> {
    match body.get("ok") {
        Some(Json::Bool(true)) => {
            if !only_keys(body, &["ok", "noticeId", "threshold", "signerKeyIds"]) {
                return None;
            }
            let notice_id = string(body.get("noticeId")).filter(|s| is_guid(s))?;
            int_at_least(body.get("threshold"), 1)?;
            let Some(Json::Array(ids)) = body.get("signerKeyIds") else {
                return None;
            };
            ids.iter()
                .all(|id| matches!(id, Json::String(s) if is_guid(s)))
                .then_some(Verdict::Ok { notice_id })
        }
        Some(Json::Bool(false)) => {
            if !only_keys(body, &["ok", "code"]) {
                return None;
            }
            let code = string(body.get("code")).filter(|c| CLAIM_REFUSALS.contains(&c.as_str()))?;
            Some(Verdict::Refused { code })
        }
        _ => None,
    }
}

/// `encodeURIComponent`.
pub fn encode_uri_component(s: &str) -> String {
    use std::fmt::Write as _;
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(char::from(b));
        } else {
            let _ = write!(out, "%{b:02X}");
        }
    }
    out
}

const FETCH_MS: u64 = 3_000;

/// `createIdentityRecovery(IDENTITY_URL, ...)`, signed as svc-bank for svc-identity.
pub struct HttpIdentity {
    pub base: String,
    pub signer: CallSigner,
    pub fetch: Box<dyn Fetch>,
}

impl HttpIdentity {
    fn target(&self, path: &str) -> String {
        format!("{}{path}", self.base.trim_end_matches('/'))
    }

    /// `ask`: the reply's body as JSON, or why identity is unavailable.
    fn ask(&self, req: &HttpRequest) -> Result<Json, Refusal> {
        let res = self.fetch.fetch(req).map_err(|e| {
            // `err.name`: the timeout's DOMException, or undici's TypeError.
            let name = if e.message == TIMED_OUT {
                "TimeoutError"
            } else {
                "TypeError"
            };
            unavailable(&format!("identity did not answer ({name})"))
        })?;
        if !res.ok() {
            return Err(unavailable(&format!("identity answered {}", res.status)));
        }
        json::parse(&res.body).map_err(|_| unavailable("identity answered with no readable body"))
    }

    fn signed_path(target: &str) -> Result<String, Refusal> {
        let parsed =
            url::Url::parse(target).map_err(|_| Refusal::Other("Invalid URL".to_owned()))?;
        Ok(match parsed.query() {
            Some(q) => format!("{}?{q}", parsed.path()),
            None => parsed.path().to_owned(),
        })
    }
}

impl IdentityRecovery for HttpIdentity {
    fn estates(&self, heir: &str) -> Result<Vec<Estate>, Refusal> {
        let target = self.target(&format!(
            "/internal/recovery-claims/estates/{}",
            encode_uri_component(heir)
        ));
        let path = Self::signed_path(&target)?;
        let headers = self
            .signer
            .sign("", "GET", &path, "")
            .map_err(Refusal::Other)?;
        let body = self.ask(&HttpRequest {
            method: "GET".to_owned(),
            url: target,
            headers,
            body: None,
            timeout_ms: Some(FETCH_MS),
            refuse_redirect: true,
        })?;
        parse_estates(&body)
            .ok_or_else(|| unavailable("identity answered outside the estates schema"))
    }

    fn verify(&self, request: &Json) -> Result<Verdict, Refusal> {
        let target = self.target("/internal/recovery-claims/verify");
        let path = Self::signed_path(&target)?;
        let payload = request.compact();
        let mut headers = self
            .signer
            .sign(&payload, "POST", &path, "application/json")
            .map_err(Refusal::Other)?;
        headers.push(("content-type".to_owned(), "application/json".to_owned()));
        let body = self.ask(&HttpRequest {
            method: "POST".to_owned(),
            url: target,
            headers,
            body: Some(payload),
            timeout_ms: Some(FETCH_MS),
            refuse_redirect: true,
        })?;
        parse_verdict(&body)
            .ok_or_else(|| unavailable("identity answered outside the verdict schema"))
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::indexing_slicing, reason = "a test")]
    use super::*;
    use service_kit::http::{FETCH_FAILED, FetchError, HttpResponse};
    use std::sync::{Arc, Mutex};

    #[derive(Clone)]
    struct Answer(
        Arc<Mutex<Vec<HttpRequest>>>,
        Result<(u16, &'static str), &'static str>,
    );

    impl Fetch for Answer {
        fn fetch(&self, req: &HttpRequest) -> Result<HttpResponse, FetchError> {
            self.0.lock().unwrap().push(req.clone());
            self.1
                .map(|(status, body)| HttpResponse {
                    status,
                    body: body.to_owned(),
                })
                .map_err(|m| FetchError {
                    message: m.to_owned(),
                })
        }
    }

    fn identity(a: Result<(u16, &'static str), &'static str>) -> (HttpIdentity, Answer) {
        let seen = Answer(Arc::new(Mutex::new(Vec::new())), a);
        (
            HttpIdentity {
                base: "http://identity:4002/".to_owned(),
                signer: CallSigner::new(
                    "svc-bank",
                    "svc-identity",
                    "an-identity-test-secret-long-enough-000",
                    None,
                ),
                fetch: Box::new(seen.clone()),
            },
            seen,
        )
    }

    fn message(r: Refusal) -> String {
        match r {
            Refusal::Bank(e) => format!("{} {}", e.row.code, e.message),
            other => format!("{other:?}"),
        }
    }

    const ESTATE: &str = r#"{"estates":[{"userId":"11111111-1111-4111-8111-111111111111","handle":"ada","noticeId":"22222222-2222-4222-8222-222222222222","threshold":2,"liveKeys":3}]}"#;

    #[test]
    fn estates_is_a_signed_get_of_the_heirs_own_id() {
        let (i, seen) = identity(Ok((200, ESTATE)));
        let rows = i.estates("a b/c").unwrap();
        assert_eq!(rows[0].handle, "ada");
        assert_eq!(rows[0].threshold, 2);
        let seen = seen.0.lock().unwrap();
        assert_eq!(
            seen[0].url,
            "http://identity:4002/internal/recovery-claims/estates/a%20b%2Fc"
        );
        assert_eq!(seen[0].timeout_ms, Some(3_000));
        assert!(seen[0].refuse_redirect);
    }

    #[test]
    fn anything_but_an_answer_in_the_schema_is_unavailable() {
        type Case = (Result<(u16, &'static str), &'static str>, &'static str);
        let cases: [Case; 5] = [
            (Err(FETCH_FAILED), "identity did not answer (TypeError)"),
            (Err(TIMED_OUT), "identity did not answer (TimeoutError)"),
            (Ok((502, "")), "identity answered 502"),
            (Ok((200, "nope")), "identity answered with no readable body"),
            (
                Ok((200, r#"{"estates":[{"userId":"x"}]}"#)),
                "identity answered outside the estates schema",
            ),
        ];
        for (answer, why) in cases {
            let (i, _) = identity(answer);
            assert_eq!(
                message(i.estates("h").unwrap_err()),
                format!(
                    "bank.recovery_unavailable Recovery claims could not be checked: {why} [bank.recovery_unavailable]"
                )
            );
        }
        assert!(message(Unconfigured.estates("h").unwrap_err()).contains("IDENTITY_URL is unset"));
    }

    #[test]
    fn a_verdict_is_read_as_identity_gives_it() {
        let (i, seen) = identity(Ok((
            200,
            r#"{"ok":false,"code":"identity.recovery_signatures_short"}"#,
        )));
        let req = Json::obj([("userId", Json::str("u"))]);
        assert_eq!(
            i.verify(&req).unwrap(),
            Verdict::Refused {
                code: "identity.recovery_signatures_short".to_owned()
            }
        );
        let seen = seen.0.lock().unwrap();
        assert_eq!(seen[0].body.as_deref(), Some(r#"{"userId":"u"}"#));
        assert_eq!(seen[0].headers.last().unwrap().0, "content-type");
        let (i, _) = identity(Ok((200, r#"{"ok":false,"code":"identity.made_up"}"#)));
        assert!(i.verify(&req).is_err());
    }
}
