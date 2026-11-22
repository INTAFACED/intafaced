//! What slice `transfers` asks of svc-identity and hands to the bus, each as the TypeScript does:
//!
//! - [`RecipientState`] (`recipient-state.ts`): whether a person may receive, `GET /internal/account/:id`.
//! - [`SecurityLock`] (`security-lock.ts`): the owner's security lock and self-freeze, `GET /internal/security-lock/:id`
//!   and `GET /internal/self-freeze/:id`.
//! - [`PartyHandles`] (`transfers/party-handles.ts`): a person's handle, `GET /internal/handle/:id`.
//! - [`ExtraControls`] (`safety/extra-controls.ts`): the person's own extra checks, `GET /internal/extra-controls/:id`.
//! - [`Bus`]: the publish side of `JetStreamEventBus` for the slice's notices.
//!
//! Each identity read is signed as svc-bank for svc-identity, 3 s, with no retry. With no `IDENTITY_URL` each refuses as
//! unset ([`NoIdentity`]). [`MemoryIdentity`] and [`MemoryBus`] are the TypeScript's memory ports, for the tests.

use std::collections::BTreeMap;
use std::sync::Mutex;

use service_kit::http::{Fetch, HttpRequest};
use service_kit::json::{self, Json};
use service_kit::s2s::CallSigner;
use service_kit::tokens::is_guid;

use crate::errors::Refusal;
use crate::partner::refuse;

const FETCH_MS: u64 = 3_000;

fn log(event: &str, user_id: &str, reason: &str, status: Option<u16>) {
    let mut f = vec![
        ("level".to_owned(), Json::str("error")),
        ("service".to_owned(), Json::str("svc-bank")),
        ("event".to_owned(), Json::str(event)),
        ("userId".to_owned(), Json::str(user_id)),
        ("reason".to_owned(), Json::str(reason)),
    ];
    if let Some(s) = status {
        f.push(("httpStatus".to_owned(), Json::int(i64::from(s))));
    }
    eprintln!("{}", Json::Object(f).compact());
}

/// `RecipientStatus`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecipientStatus {
    Active,
    Frozen,
    Closed,
    NotFound,
}

impl RecipientStatus {
    pub fn name(self) -> &'static str {
        match self {
            RecipientStatus::Active => "active",
            RecipientStatus::Frozen => "frozen",
            RecipientStatus::Closed => "closed",
            RecipientStatus::NotFound => "not_found",
        }
    }
}

/// `accountOf`'s answer: the status and KYC tier, or none for a person identity does not know.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountOf {
    pub status: RecipientStatus,
    pub kyc_tier: String,
}

/// `RecipientStateUnavailableError`: `unset` when no identity is wired, else `unavailable`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecipientUnavailable {
    pub message: String,
    pub unset: bool,
}

/// `RecipientStatePort`.
pub trait RecipientState: Send + Sync {
    /// `accountOf`: `None` is `not_found`.
    fn account_of(&self, user_id: &str) -> Result<Option<AccountOf>, RecipientUnavailable>;
    /// `statusOf`.
    fn status_of(&self, user_id: &str) -> Result<RecipientStatus, RecipientUnavailable> {
        Ok(self
            .account_of(user_id)?
            .map_or(RecipientStatus::NotFound, |a| a.status))
    }
}

/// `SecurityLockState`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct LockState {
    pub locked: bool,
    pub unlocks_at: Option<String>,
    pub self_frozen: bool,
}

/// `assertHoldsOpen`.
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
            .as_ref()
            .map_or(String::new(), |u| format!(" ({u})"));
        return Err(refuse(
            "bank.security_locked",
            format!(
                "The account's security lock is on, so {action} is refused until it ends{until}"
            ),
        ));
    }
    Ok(())
}

/// `SecurityLockPort`.
pub trait SecurityLock: Send + Sync {
    fn read(&self, user_id: &str) -> Result<LockState, Refusal>;
}

/// `assertSecurityLockOpen`.
pub fn assert_security_lock_open(
    port: &dyn SecurityLock,
    user_id: &str,
    action: &str,
) -> Result<LockState, Refusal> {
    let lock = port.read(user_id)?;
    assert_holds_open(&lock, action)?;
    Ok(lock)
}

/// `PartyHandleUnavailableError`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HandleUnavailable(pub String);

/// `PartyHandlePort`.
pub trait PartyHandles: Send + Sync {
    fn handle_of(&self, user_id: &str) -> Result<Option<String>, HandleUnavailable>;
}

/// `ExtraControlsFor` without its user id.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Extras {
    pub controls: Vec<String>,
    /// `(amount, assetId)`.
    pub allowance: Option<(String, String)>,
}

/// `ExtraControlsPort`.
pub trait ExtraControls: Send + Sync {
    fn read(&self, user_id: &str) -> Result<Extras, Refusal>;
}

/// The bus's publish side.
pub trait Bus: Send + Sync {
    /// Publishes one event envelope, deduplicated by `msg_id`; the broker's acknowledgement or why it failed.
    fn publish(&self, subject: &str, msg_id: &str, envelope: &Json) -> Result<(), String>;
}

/// No bus: every publish is reported undelivered.
pub struct NoBus;

impl Bus for NoBus {
    fn publish(&self, _subject: &str, _msg_id: &str, _envelope: &Json) -> Result<(), String> {
        Err("no event bus is wired".to_owned())
    }
}

/// The bus over NATS JetStream, into the bank's own stream.
pub struct JetStreamBus(pub service_kit::nats::JetStream);

impl Bus for JetStreamBus {
    fn publish(&self, subject: &str, msg_id: &str, envelope: &Json) -> Result<(), String> {
        self.0
            .publish(subject, msg_id, envelope.compact().as_bytes())
            .map(|_| ())
            .map_err(|e| e.0)
    }
}

/// A bus that keeps what it was given, and fails while told to (the tests' `failWith`).
#[derive(Default)]
pub struct MemoryBus {
    pub sent: Mutex<Vec<(String, String, Json)>>,
    pub failing: Mutex<Option<String>>,
}

impl Bus for MemoryBus {
    fn publish(&self, subject: &str, msg_id: &str, envelope: &Json) -> Result<(), String> {
        if let Some(e) = self.failing.lock().map_err(|e| e.to_string())?.clone() {
            return Err(e);
        }
        let mut sent = self.sent.lock().map_err(|e| e.to_string())?;
        // JetStream's duplicate window: one message per id.
        if !sent.iter().any(|(_, id, _)| id == msg_id) {
            sent.push((subject.to_owned(), msg_id.to_owned(), envelope.clone()));
        }
        Ok(())
    }
}

/// svc-identity over HTTP, signed as svc-bank.
pub struct IdentityHttp {
    base: String,
    signer: CallSigner,
    fetch: Box<dyn Fetch>,
}

/// Why a GET failed: no answer, or the status it answered.
enum GetFailure {
    Request,
    Status(u16),
    Body,
}

impl IdentityHttp {
    pub fn new(base: &str, signer: CallSigner, fetch: Box<dyn Fetch>) -> IdentityHttp {
        IdentityHttp {
            base: base.trim_end_matches('/').to_owned(),
            signer,
            fetch,
        }
    }

    /// One signed GET of `/internal/<path>/<id>`: `Ok(None)` on 404, the parsed body on a 2xx.
    fn get(&self, path: &str, id: &str) -> Result<Option<Json>, GetFailure> {
        let route = format!("/internal/{path}/{}", encode(id));
        let headers = self
            .signer
            .sign("", "GET", &route, "")
            .map_err(|_| GetFailure::Request)?;
        let res = self
            .fetch
            .fetch(&HttpRequest {
                method: "GET".to_owned(),
                url: format!("{}{route}", self.base),
                headers,
                body: None,
                timeout_ms: Some(FETCH_MS),
                refuse_redirect: false,
            })
            .map_err(|_| GetFailure::Request)?;
        if res.status == 404 {
            return Ok(None);
        }
        if !res.ok() {
            return Err(GetFailure::Status(res.status));
        }
        json::parse(&res.body)
            .map(Some)
            .map_err(|_| GetFailure::Body)
    }
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

fn keys_are(j: &Json, allowed: &[&str]) -> bool {
    matches!(j, Json::Object(f) if f.iter().all(|(k, _)| allowed.contains(&k.as_str())))
}

fn str_of<'j>(j: &'j Json, key: &str) -> Option<&'j str> {
    match j.get(key) {
        Some(Json::String(s)) => Some(s),
        _ => None,
    }
}

fn bool_of(j: &Json, key: &str) -> Option<bool> {
    match j.get(key) {
        Some(Json::Bool(b)) => Some(*b),
        _ => None,
    }
}

fn nullable_str(j: &Json, key: &str) -> Option<Option<String>> {
    match j.get(key) {
        Some(Json::Null) => Some(None),
        Some(Json::String(s)) => Some(Some(s.clone())),
        _ => None,
    }
}

/// `accountStateSchema`.
fn account_state(body: &Json) -> Option<(String, AccountOf)> {
    let user = str_of(body, "userId").filter(|u| is_guid(u))?;
    let status = match str_of(body, "status")? {
        "active" => RecipientStatus::Active,
        "frozen" => RecipientStatus::Frozen,
        "closed" => RecipientStatus::Closed,
        _ => return None,
    };
    let tier = str_of(body, "kycTier")
        .filter(|t| ["none", "basic", "full", "institutional"].contains(t))?;
    if body
        .get("archived")
        .is_some_and(|a| !matches!(a, Json::Bool(_)))
    {
        return None;
    }
    Some((
        user.to_owned(),
        AccountOf {
            status,
            kyc_tier: tier.to_owned(),
        },
    ))
}

impl RecipientState for IdentityHttp {
    fn account_of(&self, user_id: &str) -> Result<Option<AccountOf>, RecipientUnavailable> {
        let id = user_id.trim();
        if id.is_empty() {
            return Ok(None);
        }
        let event = "bank.recipient_check_failed";
        let unavailable = |m: &str| RecipientUnavailable {
            message: m.to_owned(),
            unset: false,
        };
        match self.get("account", id) {
            Ok(None) => Ok(None),
            Ok(Some(body)) => match account_state(&body) {
                Some((uid, state)) if uid == id => Ok(Some(state)),
                parsed => {
                    let why = if parsed.is_some() {
                        "identity answered about a different user"
                    } else {
                        "identity body failed the account state schema"
                    };
                    log(event, id, why, Some(200));
                    Err(unavailable(
                        "identity returned an unreadable recipient status",
                    ))
                }
            },
            Err(GetFailure::Request) => {
                log(event, id, "identity request failed: Error", None);
                Err(unavailable(
                    "identity did not answer the recipient status check",
                ))
            }
            Err(GetFailure::Status(s)) => {
                log(event, id, "identity answered non-2xx", Some(s));
                Err(unavailable(&format!(
                    "identity refused the recipient status check ({s})"
                )))
            }
            Err(GetFailure::Body) => {
                log(event, id, "identity body was not JSON", Some(200));
                Err(unavailable(
                    "identity returned an unreadable recipient status",
                ))
            }
        }
    }
}

fn lock_unavailable(message: impl Into<String>) -> Refusal {
    refuse("bank.security_lock_unavailable", message)
}

impl IdentityHttp {
    /// `ask`: one of the two lock reads; a 404 is a refusal like any non-2xx.
    fn lock_part(&self, id: &str, path: &str) -> Result<Json, Refusal> {
        let event = "bank.security_lock_check_failed";
        match self.get(path, id) {
            Ok(Some(body)) => Ok(body),
            Ok(None) => {
                log(
                    event,
                    id,
                    &format!("identity {path} answered non-2xx"),
                    Some(404),
                );
                Err(lock_unavailable(
                    "identity refused the security lock check (404)",
                ))
            }
            Err(GetFailure::Request) => {
                log(
                    event,
                    id,
                    &format!("identity {path} request failed: Error"),
                    None,
                );
                Err(lock_unavailable(
                    "identity did not answer the security lock check",
                ))
            }
            Err(GetFailure::Status(s)) => {
                log(
                    event,
                    id,
                    &format!("identity {path} answered non-2xx"),
                    Some(s),
                );
                Err(lock_unavailable(format!(
                    "identity refused the security lock check ({s})"
                )))
            }
            Err(GetFailure::Body) => {
                log(
                    event,
                    id,
                    &format!("identity {path} body was not JSON"),
                    Some(200),
                );
                Err(lock_unavailable(
                    "identity returned an unreadable security lock",
                ))
            }
        }
    }
}

fn same_user(body: &Json, id: &str) -> Option<bool> {
    let u = str_of(body, "userId").filter(|u| is_guid(u))?;
    Some(u.to_lowercase() == id.to_lowercase())
}

fn datetime_or_null(j: &Json, key: &str) -> Option<Option<String>> {
    let v = nullable_str(j, key)?;
    match v {
        Some(s) if service_kit::time::js_date(&s).is_none() => None,
        other => Some(other),
    }
}

impl SecurityLock for IdentityHttp {
    fn read(&self, user_id: &str) -> Result<LockState, Refusal> {
        let id = user_id.trim();
        if id.is_empty() {
            return Err(lock_unavailable("a security lock check needs a user"));
        }
        let event = "bank.security_lock_check_failed";
        let lock = self.lock_part(id, "security-lock")?;
        let freeze = self.lock_part(id, "self-freeze")?;
        let lock_ok = keys_are(
            &lock,
            &[
                "userId",
                "locked",
                "lockedAt",
                "setBy",
                "unlockRequestedAt",
                "unlocksAt",
            ],
        ) && bool_of(&lock, "locked").is_some()
            && datetime_or_null(&lock, "lockedAt").is_some()
            && match nullable_str(&lock, "setBy") {
                Some(None) => true,
                Some(Some(s)) => s == "self" || s == "support",
                None => false,
            }
            && datetime_or_null(&lock, "unlockRequestedAt").is_some()
            && datetime_or_null(&lock, "unlocksAt").is_some();
        let freeze_ok = keys_are(&freeze, &["userId", "frozen", "since"])
            && bool_of(&freeze, "frozen").is_some()
            && datetime_or_null(&freeze, "since").is_some();
        for (path, body, ok) in [
            ("security-lock", &lock, lock_ok),
            ("self-freeze", &freeze, freeze_ok),
        ] {
            match same_user(body, id) {
                Some(true) if ok => {}
                Some(false) if ok => {
                    log(
                        event,
                        id,
                        &format!("identity {path} answered about a different user"),
                        Some(200),
                    );
                    return Err(lock_unavailable(
                        "identity returned an unreadable security lock",
                    ));
                }
                _ => {
                    log(
                        event,
                        id,
                        &format!("identity {path} body failed its schema"),
                        Some(200),
                    );
                    return Err(lock_unavailable(
                        "identity returned an unreadable security lock",
                    ));
                }
            }
        }
        Ok(LockState {
            locked: bool_of(&lock, "locked").unwrap_or(false),
            unlocks_at: datetime_or_null(&lock, "unlocksAt").flatten(),
            self_frozen: bool_of(&freeze, "frozen").unwrap_or(false),
        })
    }
}

impl PartyHandles for IdentityHttp {
    fn handle_of(&self, user_id: &str) -> Result<Option<String>, HandleUnavailable> {
        let id = user_id.trim();
        if id.is_empty() {
            return Ok(None);
        }
        let unreadable = || HandleUnavailable("identity returned an unreadable handle".to_owned());
        match self.get("handle", id) {
            Ok(None) => Ok(None),
            Ok(Some(body)) => {
                let handle = str_of(&body, "handle").filter(|h| !h.is_empty());
                match (str_of(&body, "userId"), handle) {
                    (Some(u), Some(h)) if u == id => Ok(Some(h.to_owned())),
                    _ => Err(unreadable()),
                }
            }
            Err(GetFailure::Request) => Err(HandleUnavailable(
                "identity did not answer a handle lookup".to_owned(),
            )),
            Err(GetFailure::Status(s)) => Err(HandleUnavailable(format!(
                "identity refused the handle lookup ({s})"
            ))),
            Err(GetFailure::Body) => Err(unreadable()),
        }
    }
}

const EXTRAS_UNAVAILABLE: &str =
    "Your extra checks could not be read right now. Nothing was sent. Try again shortly.";

/// The allowance amount `extraControlsAllowanceSchema` accepts (trimmed).
fn allowance_amount(raw: &str) -> Option<String> {
    let v = raw.trim();
    let (int, frac) = v.split_once('.').map_or((v, None), |(i, f)| (i, Some(f)));
    let int_ok = int == "0"
        || (!int.is_empty()
            && int.len() <= 18
            && !int.starts_with('0')
            && int.bytes().all(|b| b.is_ascii_digit()));
    let frac_ok =
        frac.is_none_or(|f| !f.is_empty() && f.len() <= 8 && f.bytes().all(|b| b.is_ascii_digit()));
    (int_ok && frac_ok && v.bytes().any(|b| (b'1'..=b'9').contains(&b))).then(|| v.to_owned())
}

fn extras_of(body: &Json) -> Option<(String, Extras)> {
    if !keys_are(body, &["userId", "controls", "allowance"]) {
        return None;
    }
    let user = str_of(body, "userId").filter(|u| is_guid(u))?;
    let Some(Json::Array(cs)) = body.get("controls") else {
        return None;
    };
    let mut controls = Vec::new();
    for c in cs {
        match c {
            Json::String(s)
                if [
                    "known_locations",
                    "trusted_contacts",
                    "secret_qr",
                    "video_fallback",
                ]
                .contains(&s.as_str()) =>
            {
                controls.push(s.clone());
            }
            _ => return None,
        }
    }
    let allowance = match body.get("allowance") {
        Some(Json::Null) => None,
        Some(a @ Json::Object(_)) => {
            if !keys_are(a, &["amount", "assetId"]) {
                return None;
            }
            let amount = allowance_amount(str_of(a, "amount")?)?;
            let asset = str_of(a, "assetId").filter(|x| *x == "USDT" || *x == "USDC")?;
            Some((amount, asset.to_owned()))
        }
        _ => return None,
    };
    Some((
        user.to_owned(),
        Extras {
            controls,
            allowance,
        },
    ))
}

impl ExtraControls for IdentityHttp {
    fn read(&self, user_id: &str) -> Result<Extras, Refusal> {
        let id = user_id.trim();
        let event = "bank.extra_controls_check_failed";
        let unavailable = || refuse("bank.extra_controls_unavailable", EXTRAS_UNAVAILABLE);
        let body = match self.get("extra-controls", id) {
            Ok(Some(b)) => b,
            Ok(None) => {
                log(event, id, "non-2xx", Some(404));
                return Err(unavailable());
            }
            Err(GetFailure::Status(s)) => {
                log(event, id, "non-2xx", Some(s));
                return Err(unavailable());
            }
            Err(GetFailure::Request) => {
                log(event, id, "request failed: Error", None);
                return Err(unavailable());
            }
            Err(GetFailure::Body) => {
                log(event, id, "body was not JSON", None);
                return Err(unavailable());
            }
        };
        match extras_of(&body) {
            Some((u, e)) if u.to_lowercase() == id.to_lowercase() => Ok(e),
            Some(_) => {
                log(event, id, "answered about a different user", None);
                Err(unavailable())
            }
            None => {
                log(event, id, "body failed its schema", None);
                Err(unavailable())
            }
        }
    }
}

/// No `IDENTITY_URL`: every read refuses as unset, as the TypeScript's `unconfigured*` ports do.
pub struct NoIdentity;

impl RecipientState for NoIdentity {
    fn account_of(&self, _user_id: &str) -> Result<Option<AccountOf>, RecipientUnavailable> {
        Err(RecipientUnavailable {
            message: "IDENTITY_URL is unset, so svc-bank cannot check whether a recipient is frozen or closed".to_owned(),
            unset: true,
        })
    }
}

impl SecurityLock for NoIdentity {
    fn read(&self, _user_id: &str) -> Result<LockState, Refusal> {
        Err(refuse(
            "bank.security_lock_unset",
            "IDENTITY_URL is unset, so svc-bank cannot check the security lock",
        ))
    }
}

impl ExtraControls for NoIdentity {
    fn read(&self, _user_id: &str) -> Result<Extras, Refusal> {
        Err(refuse(
            "bank.extra_controls_unset",
            "IDENTITY_URL is unset, so svc-bank cannot check the extra checks on a send",
        ))
    }
}

/// The memory ports (`memoryRecipientState`, `memorySecurityLock`, `memoryPartyHandles`, `memoryExtraControls`).
#[derive(Default)]
pub struct MemoryIdentity {
    pub statuses: Mutex<BTreeMap<String, RecipientStatus>>,
    pub tiers: Mutex<BTreeMap<String, String>>,
    /// `strict`: a person not in the table is not found, else active.
    pub strict: bool,
    pub recipient_failure: Mutex<Option<RecipientUnavailable>>,
    pub locks: Mutex<BTreeMap<String, LockState>>,
    pub lock_failure: Mutex<Option<Refusal>>,
    pub handles: Mutex<BTreeMap<String, String>>,
    pub extras: Mutex<BTreeMap<String, Extras>>,
    pub extras_failure: Mutex<Option<Refusal>>,
    pub asked: Mutex<Vec<String>>,
}

fn locked<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

impl MemoryIdentity {
    pub fn set_status(&self, user_id: &str, status: RecipientStatus) {
        locked(&self.statuses).insert(user_id.to_owned(), status);
    }
    pub fn set_lock(&self, user_id: &str, state: LockState) {
        locked(&self.locks).insert(user_id.to_owned(), state);
    }
    pub fn set_handle(&self, user_id: &str, handle: &str) {
        locked(&self.handles).insert(user_id.to_owned(), handle.to_owned());
    }
    pub fn set_extras(&self, user_id: &str, extras: Extras) {
        locked(&self.extras).insert(user_id.to_owned(), extras);
    }
    pub fn asked(&self) -> Vec<String> {
        locked(&self.asked).clone()
    }
}

impl RecipientState for MemoryIdentity {
    fn account_of(&self, user_id: &str) -> Result<Option<AccountOf>, RecipientUnavailable> {
        locked(&self.asked).push(user_id.to_owned());
        if let Some(f) = locked(&self.recipient_failure).clone() {
            return Err(f);
        }
        let status = locked(&self.statuses)
            .get(user_id)
            .copied()
            .unwrap_or(if self.strict {
                RecipientStatus::NotFound
            } else {
                RecipientStatus::Active
            });
        if status == RecipientStatus::NotFound {
            return Ok(None);
        }
        Ok(Some(AccountOf {
            status,
            kyc_tier: locked(&self.tiers)
                .get(user_id)
                .cloned()
                .unwrap_or_else(|| "full".to_owned()),
        }))
    }
}

impl SecurityLock for MemoryIdentity {
    fn read(&self, user_id: &str) -> Result<LockState, Refusal> {
        locked(&self.asked).push(user_id.to_owned());
        if let Some(f) = locked(&self.lock_failure).clone() {
            return Err(f);
        }
        Ok(locked(&self.locks)
            .get(user_id)
            .cloned()
            .unwrap_or_default())
    }
}

impl PartyHandles for MemoryIdentity {
    fn handle_of(&self, user_id: &str) -> Result<Option<String>, HandleUnavailable> {
        Ok(locked(&self.handles).get(user_id).cloned())
    }
}

impl ExtraControls for MemoryIdentity {
    fn read(&self, user_id: &str) -> Result<Extras, Refusal> {
        if let Some(f) = locked(&self.extras_failure).clone() {
            return Err(f);
        }
        Ok(locked(&self.extras)
            .get(user_id)
            .cloned()
            .unwrap_or_default())
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test")]
    use super::*;

    #[test]
    fn an_allowance_is_a_positive_decimal_of_at_most_eight_places() {
        assert_eq!(allowance_amount(" 25.5 ").as_deref(), Some("25.5"));
        assert_eq!(allowance_amount("0"), None);
        assert_eq!(
            allowance_amount("0.00000001").as_deref(),
            Some("0.00000001")
        );
        assert_eq!(allowance_amount("01"), None);
        assert_eq!(allowance_amount("1.123456789"), None);
    }

    #[test]
    fn a_lock_or_a_self_freeze_refuses_by_name() {
        let frozen = LockState {
            self_frozen: true,
            ..LockState::default()
        };
        let Err(Refusal::Bank(e)) = assert_holds_open(&frozen, "a send") else {
            panic!()
        };
        assert_eq!(e.row.code, "bank.account_frozen_self");
        let locked = LockState {
            locked: true,
            unlocks_at: Some("2026-01-01T00:00:00.000Z".to_owned()),
            self_frozen: false,
        };
        let Err(Refusal::Bank(e)) = assert_holds_open(&locked, "a send") else {
            panic!()
        };
        assert!(e.message.ends_with("(2026-01-01T00:00:00.000Z)"));
    }
}
