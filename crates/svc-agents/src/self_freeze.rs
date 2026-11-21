//! The owner's own freeze as svc-agents reads it (`own/self-freeze.ts`, J-wallet-13): asked before every agent action
//! and every change that gives an agent more, from svc-identity's `GET /internal/self-freeze/:userId`, signed as
//! svc-agents. Nothing is kept: each gate asks again. An unread freeze counts as frozen.
//!
//! The `selfFreezeApplied` consumer (the revokes one freeze makes) is the `own-sharing` slice's.

use std::sync::Arc;

use service_kit::http::{Fetch, HttpRequest};
use service_kit::json::{self, Json};
use service_kit::s2s::CallSigner;
use service_kit::trpc::TrpcError;

/// `OWNER_FROZEN_SELF`.
pub const OWNER_FROZEN_SELF: &str = "agents.identity.owner_frozen_self";
/// `OWNER_FREEZE_UNREAD`.
pub const OWNER_FREEZE_UNREAD: &str = "agents.identity.owner_freeze_unread";

/// `SelfFreezeReading`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Reading {
    Open,
    Frozen { since: Option<String> },
}

/// `SelfFreezeUnavailable`: identity could not be asked, refused, or answered outside its contract.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Unavailable(pub String);

/// `OwnSelfFreezeRead`.
pub trait SelfFreezeRead: Send + Sync {
    fn read(&self, user_id: &str) -> Result<Reading, Unavailable>;
}

/// `createIdentitySelfFreezeRead`: one signed GET per read, three seconds at most.
pub struct IdentitySelfFreezeRead {
    base_url: String,
    signer: CallSigner,
    fetch: Arc<dyn Fetch>,
}

/// `FETCH_MS`.
const FETCH_MS: u64 = 3_000;

impl IdentitySelfFreezeRead {
    pub fn new(
        base_url: &str,
        signer: CallSigner,
        fetch: Arc<dyn Fetch>,
    ) -> IdentitySelfFreezeRead {
        IdentitySelfFreezeRead {
            base_url: base_url.trim_end_matches('/').to_owned(),
            signer,
            fetch,
        }
    }
}

/// `encodeURIComponent`.
fn encode_component(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(char::from(b));
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// `selfFreezeStateSchema` (strict): `userId`, `frozen`, `since` and nothing else.
fn parse_state(body: &str, user_id: &str) -> Option<Reading> {
    let Ok(Json::Object(fields)) = json::parse(body) else {
        return None;
    };
    if fields
        .iter()
        .any(|(k, _)| !["userId", "frozen", "since"].contains(&k.as_str()))
    {
        return None;
    }
    let get = |k: &str| fields.iter().find(|(f, _)| f == k).map(|(_, v)| v);
    let (Some(Json::String(id)), Some(Json::Bool(frozen))) = (get("userId"), get("frozen")) else {
        return None;
    };
    if !crate::runtime::funds::is_uuid(id) || id.to_lowercase() != user_id.to_lowercase() {
        return None;
    }
    let since = match get("since") {
        Some(Json::Null) => None,
        Some(Json::String(s)) if is_offset_datetime(s) => Some(s.clone()),
        _ => return None,
    };
    Some(if *frozen {
        Reading::Frozen { since }
    } else {
        Reading::Open
    })
}

/// zod's `datetime({ offset: true })`: `YYYY-MM-DDTHH:MM[:SS[.fff…]]` then `Z` or `±HH[:]MM`/`±HH`.
fn is_offset_datetime(s: &str) -> bool {
    let b = s.as_bytes();
    let digits =
        |r: std::ops::Range<usize>| b.get(r).is_some_and(|d| d.iter().all(u8::is_ascii_digit));
    if !(digits(0..4)
        && b.get(4) == Some(&b'-')
        && digits(5..7)
        && b.get(7) == Some(&b'-')
        && digits(8..10)
        && b.get(10) == Some(&b'T')
        && digits(11..13)
        && b.get(13) == Some(&b':')
        && digits(14..16))
    {
        return false;
    }
    let mut i = 16;
    if b.get(i) == Some(&b':') {
        if !digits(i + 1..i + 3) {
            return false;
        }
        i += 3;
        if b.get(i) == Some(&b'.') {
            let start = i + 1;
            i = start;
            while b.get(i).is_some_and(u8::is_ascii_digit) {
                i += 1;
            }
            if i == start {
                return false;
            }
        }
    }
    match b.get(i) {
        Some(b'Z') => i + 1 == b.len(),
        Some(b'+' | b'-') => {
            let rest = b.get(i + 1..).unwrap_or_default();
            let all = |r: &[u8]| r.iter().all(u8::is_ascii_digit);
            match rest.len() {
                2 | 4 => all(rest),
                5 => {
                    rest.get(2) == Some(&b':')
                        && all(rest.get(0..2).unwrap_or_default())
                        && all(rest.get(3..5).unwrap_or_default())
                }
                _ => false,
            }
        }
        _ => false,
    }
}

impl SelfFreezeRead for IdentitySelfFreezeRead {
    fn read(&self, user_id: &str) -> Result<Reading, Unavailable> {
        let path = format!("/internal/self-freeze/{}", encode_component(user_id));
        let headers = self
            .signer
            .sign("", "GET", &path, "")
            .map_err(Unavailable)?;
        let res = self
            .fetch
            .fetch(&HttpRequest {
                method: "GET".to_owned(),
                url: format!("{}{path}", self.base_url),
                headers,
                body: None,
                timeout_ms: Some(FETCH_MS),
                refuse_redirect: false,
            })
            .map_err(|_| Unavailable("identity did not answer the freeze read".to_owned()))?;
        if !res.ok() {
            return Err(Unavailable(format!(
                "identity refused the freeze read ({})",
                res.status
            )));
        }
        parse_state(&res.body, user_id).ok_or_else(|| {
            Unavailable("identity answered the freeze read outside its contract".to_owned())
        })
    }
}

/// `selfFreezeGate`: FORBIDDEN with the code as its message while the person's own freeze is on, and when it cannot be
/// read (no reader wired, identity down, an answer off-contract).
pub fn gate(user_id: &str, freeze: Option<&dyn SelfFreezeRead>) -> Result<(), TrpcError> {
    let refuse = |code: &str| TrpcError::caused("FORBIDDEN", code, code);
    let Some(freeze) = freeze else {
        return Err(refuse(OWNER_FREEZE_UNREAD));
    };
    match freeze.read(user_id) {
        Err(_) => Err(refuse(OWNER_FREEZE_UNREAD)),
        Ok(Reading::Frozen { .. }) => Err(refuse(OWNER_FROZEN_SELF)),
        Ok(Reading::Open) => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test: a failure is the point")]
    use super::*;

    const USER: &str = "41414141-4141-4141-8141-414141414141";

    #[test]
    fn only_the_contract_s_answer_for_the_person_asked_is_read() {
        assert_eq!(
            parse_state(
                &format!(r#"{{"userId":"{USER}","frozen":false,"since":null}}"#),
                USER
            ),
            Some(Reading::Open)
        );
        assert_eq!(
            parse_state(
                &format!(
                    r#"{{"userId":"{USER}","frozen":true,"since":"2026-11-20T10:00:00.000Z"}}"#
                ),
                USER
            ),
            Some(Reading::Frozen {
                since: Some("2026-11-20T10:00:00.000Z".to_owned())
            })
        );
        // Another person's answer, an extra key, a bad time or no answer at all is off-contract.
        let other = "42424242-4242-4242-8242-424242424242";
        assert_eq!(
            parse_state(
                &format!(r#"{{"userId":"{other}","frozen":false,"since":null}}"#),
                USER
            ),
            None
        );
        assert_eq!(
            parse_state(
                &format!(r#"{{"userId":"{USER}","frozen":false,"since":null,"x":1}}"#),
                USER
            ),
            None
        );
        assert_eq!(
            parse_state(
                &format!(r#"{{"userId":"{USER}","frozen":true,"since":"yesterday"}}"#),
                USER
            ),
            None
        );
        assert_eq!(parse_state("null", USER), None);
    }

    #[test]
    fn an_unread_freeze_counts_as_frozen() {
        struct Down;
        impl SelfFreezeRead for Down {
            fn read(&self, _: &str) -> Result<Reading, Unavailable> {
                Err(Unavailable("TEST: identity down".to_owned()))
            }
        }
        for freeze in [None, Some(&Down as &dyn SelfFreezeRead)] {
            let e = gate(USER, freeze).unwrap_err();
            assert_eq!(
                (e.code, e.message.as_str()),
                ("FORBIDDEN", OWNER_FREEZE_UNREAD)
            );
        }
    }

    #[test]
    fn the_user_id_is_encoded_as_encode_uri_component_does() {
        assert_eq!(encode_component("a b/c?é"), "a%20b%2Fc%3F%C3%A9");
        assert_eq!(encode_component(USER), USER);
    }
}
