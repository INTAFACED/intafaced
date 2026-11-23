//! The customer security lock (`security-lock.ts`), asked of svc-identity, which owns it: `GET
//! /internal/security-lock/:userId` and `GET /internal/self-freeze/:userId`, both service-signed, on every ask. Either
//! read failing (a transport error, a timeout, a non-2xx, an unreadable body or one about another user) is
//! `bank.security_lock_unavailable`; no `IDENTITY_URL` is `bank.security_lock_unset`. The bank keeps no copy.

use service_kit::http::{Fetch, HttpRequest};
use service_kit::json::{self, Json};
use service_kit::s2s::CallSigner;
use service_kit::time::zod_datetime;

use super::super::refuse;
use crate::errors::Refusal;

/// `SecurityLockState`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct LockState {
    pub locked: bool,
    pub unlocks_at: Option<String>,
    pub self_frozen: bool,
}

/// `SecurityLockPort`.
pub trait SecurityLock: Send + Sync {
    /// The lock as identity holds it now, or `bank.security_lock_unavailable` / `bank.security_lock_unset`.
    fn read(&self, user_id: &str) -> Result<LockState, Refusal>;
}

/// `assertHoldsOpen`: `bank.account_frozen_self` first, then `bank.security_locked`.
pub fn assert_holds_open(state: &LockState, action: &str) -> Result<(), Refusal> {
    if state.self_frozen {
        return Err(refuse(
            "bank.account_frozen_self",
            format!(
                "The owner froze this account, so {action} is refused until the freeze is lifted"
            ),
        ));
    }
    if state.locked {
        let until = state
            .unlocks_at
            .as_deref()
            .filter(|u| !u.is_empty())
            .map(|u| format!(" ({u})"))
            .unwrap_or_default();
        return Err(refuse(
            "bank.security_locked",
            format!(
                "The account's security lock is on, so {action} is refused until it ends{until}"
            ),
        ));
    }
    Ok(())
}

/// `unconfiguredSecurityLock()`: every ask refuses. Never "no lock".
pub struct Unconfigured;

impl SecurityLock for Unconfigured {
    fn read(&self, _user_id: &str) -> Result<LockState, Refusal> {
        Err(refuse(
            "bank.security_lock_unset",
            "IDENTITY_URL is unset, so svc-bank cannot check the security lock",
        ))
    }
}

/// A lock that answers as set (tests and the TEST stack).
pub struct Fixed(pub LockState);

impl SecurityLock for Fixed {
    fn read(&self, _user_id: &str) -> Result<LockState, Refusal> {
        Ok(self.0.clone())
    }
}

/// `createIdentitySecurityLock`: svc-identity's two reads, signed as svc-bank, three seconds each.
pub struct Identity {
    pub base_url: String,
    pub fetch: Box<dyn Fetch>,
    pub signer: CallSigner,
}

fn unavailable(message: &str) -> Refusal {
    refuse("bank.security_lock_unavailable", message)
}

/// `encodeURIComponent`.
fn encode(s: &str) -> String {
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

fn is_guid(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => *c == b'-',
            _ => c.is_ascii_hexdigit(),
        })
}

fn datetime_or_null(j: Option<&Json>) -> bool {
    match j {
        Some(Json::Null) => true,
        Some(Json::String(s)) => zod_datetime(s, true).is_some(),
        _ => false,
    }
}

impl Identity {
    fn ask(&self, id: &str, path: &str) -> Result<Json, Refusal> {
        let base = self.base_url.trim_end_matches('/');
        let target = format!("{base}/internal/{path}/{}", encode(id));
        let signed_path = format!("/internal/{path}/{}", encode(id));
        let headers = self
            .signer
            .sign("", "GET", &signed_path, "")
            .map_err(|_| unavailable("identity did not answer the security lock check"))?;
        let res = self
            .fetch
            .fetch(&HttpRequest {
                method: "GET".to_owned(),
                url: target,
                headers,
                body: None,
                timeout_ms: Some(3_000),
                refuse_redirect: false,
            })
            .map_err(|_| unavailable("identity did not answer the security lock check"))?;
        if !res.ok() {
            return Err(unavailable(&format!(
                "identity refused the security lock check ({})",
                res.status
            )));
        }
        let body = json::parse(&res.body)
            .map_err(|_| unavailable("identity returned an unreadable security lock"))?;
        let user_ok = matches!(body.get("userId"), Some(Json::String(u)) if is_guid(u) && u.to_lowercase() == id.to_lowercase());
        let Json::Object(fields) = &body else {
            return Err(unavailable("identity returned an unreadable security lock"));
        };
        let shape_ok = if path == "security-lock" {
            fields.len() == 6
                && matches!(body.get("locked"), Some(Json::Bool(_)))
                && datetime_or_null(body.get("lockedAt"))
                && (matches!(body.get("setBy"), Some(Json::Null))
                    || matches!(body.get("setBy"), Some(Json::String(s)) if s == "self" || s == "support"))
                && datetime_or_null(body.get("unlockRequestedAt"))
                && datetime_or_null(body.get("unlocksAt"))
        } else {
            fields.len() == 3
                && matches!(body.get("frozen"), Some(Json::Bool(_)))
                && datetime_or_null(body.get("since"))
        };
        if !user_ok || !shape_ok {
            return Err(unavailable("identity returned an unreadable security lock"));
        }
        Ok(body)
    }
}

impl SecurityLock for Identity {
    fn read(&self, user_id: &str) -> Result<LockState, Refusal> {
        let id = service_kit::money::js_trim(user_id);
        if id.is_empty() {
            return Err(unavailable("a security lock check needs a user"));
        }
        let lock = self.ask(id, "security-lock")?;
        let freeze = self.ask(id, "self-freeze")?;
        Ok(LockState {
            locked: matches!(lock.get("locked"), Some(Json::Bool(true))),
            unlocks_at: match lock.get("unlocksAt") {
                Some(Json::String(s)) => Some(s.clone()),
                _ => None,
            },
            self_frozen: matches!(freeze.get("frozen"), Some(Json::Bool(true))),
        })
    }
}
