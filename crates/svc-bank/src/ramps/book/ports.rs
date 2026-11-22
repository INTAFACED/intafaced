//! What the address book asks of svc-identity, each signed as svc-bank for svc-identity:
//!
//! - [`ApprovalMail`] (`address-approval.ts`, `createIdentityApprovalMail`): `POST /internal/mail`, purpose
//!   `withdraw-address-approval`, 5 s. Identity holds the customer's address; its acceptance means queued, not delivered.
//! - [`TrustedDevices`] (`trusted-devices.ts`): `GET /internal/trusted-devices/:userId/:deviceId`, 3 s.
//!
//! With no `IDENTITY_URL` each refuses ([`NoIdentity`]): no link is shown as sent and no device is taken as trusted.

use service_kit::http::{Fetch, FetchError, HttpRequest, TIMED_OUT};
use service_kit::json::{self, Json};
use service_kit::s2s::CallSigner;

use crate::errors::Refusal;
use crate::partner::refuse;

use super::store::is_guid;

/// `ServiceMailRequest`, in the order `requestApprovalMail` writes it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MailRequest {
    pub key: String,
    pub user_id: String,
    pub token: String,
    pub detail: String,
    pub expires_at: String,
}

impl MailRequest {
    /// `JSON.stringify(request)`.
    pub fn body(&self) -> String {
        Json::obj([
            ("key", Json::str(self.key.clone())),
            ("userId", Json::str(self.user_id.clone())),
            ("purpose", Json::str("withdraw-address-approval")),
            ("token", Json::str(self.token.clone())),
            ("detail", Json::str(self.detail.clone())),
            ("expiresAt", Json::str(self.expires_at.clone())),
        ])
        .compact()
    }
}

/// `ApprovalMailPort`: the mail's id, or a refusal the customer can be told about.
pub trait ApprovalMail: Send + Sync {
    fn send(&self, request: &MailRequest) -> Result<String, Refusal>;
}

/// `TrustedDeviceState`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceState {
    pub live: bool,
    /// `sign-up`, `sign-in` or `approval`.
    pub trusted_by: Option<String>,
    /// `on` or `off`.
    pub new_device_check: String,
}

/// `deviceMayApprove`: live, proved (made on sign-up, or approved by a mailed code or a proved device), and the owner's
/// new-device check on now.
pub fn device_may_approve(s: &DeviceState) -> bool {
    s.live
        && s.new_device_check == "on"
        && matches!(s.trusted_by.as_deref(), Some("sign-up" | "approval"))
}

/// `TrustedDevicePort`.
pub trait TrustedDevices: Send + Sync {
    fn read(&self, user_id: &str, device_id: &str) -> Result<DeviceState, Refusal>;
}

fn mail_unavailable(why: &str) -> Refusal {
    refuse(
        "bank.address_approval_mail_unavailable",
        format!("The approval mail could not be asked for: {why}"),
    )
}

fn device_unavailable(why: &str) -> Refusal {
    refuse(
        "bank.address_approval_device_unavailable",
        format!("Whether this device can approve could not be checked: {why}"),
    )
}

/// No `IDENTITY_URL`: every mail and every device read refuses.
pub struct NoIdentity;

impl ApprovalMail for NoIdentity {
    fn send(&self, _request: &MailRequest) -> Result<String, Refusal> {
        Err(refuse(
            "bank.address_approval_mail_unavailable",
            "IDENTITY_URL is unset, so svc-bank cannot ask for an approval mail",
        ))
    }
}

impl TrustedDevices for NoIdentity {
    fn read(&self, _user_id: &str, _device_id: &str) -> Result<DeviceState, Refusal> {
        Err(device_unavailable("IDENTITY_URL is unset"))
    }
}

/// svc-identity over HTTP, signed as svc-bank.
pub struct IdentityHttp {
    base: String,
    signer: CallSigner,
    fetch: Box<dyn Fetch>,
}

impl IdentityHttp {
    pub fn new(base: &str, signer: CallSigner, fetch: Box<dyn Fetch>) -> IdentityHttp {
        IdentityHttp {
            base: base.trim_end_matches('/').to_owned(),
            signer,
            fetch,
        }
    }
}

/// `err.name` of what `fetch` threw: the timeout's `TimeoutError`, else undici's `TypeError`.
fn thrown_name(e: &FetchError) -> &'static str {
    if e.message == TIMED_OUT {
        "TimeoutError"
    } else {
        "TypeError"
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

/// `IDENTITY_REFUSALS`: identity's refusals in the bank's words.
fn identity_refusal(code: &str) -> Option<Refusal> {
    let (bank, message) = match code {
        "identity.email_unproved" => (
            "bank.address_approval_email_unproved",
            "Your account has no confirmed email address, so no approval link can be mailed",
        ),
        "identity.account_not_active" => (
            "bank.address_approval_email_unproved",
            "Your account cannot receive an approval link now",
        ),
        "identity.mail_unwired" => (
            "bank.address_approval_mail_unavailable",
            "No mail service is connected, so no approval link can be sent. Approve the address from another signed-in device",
        ),
        _ => return None,
    };
    Some(refuse(bank, message))
}

impl ApprovalMail for IdentityHttp {
    fn send(&self, request: &MailRequest) -> Result<String, Refusal> {
        let route = "/internal/mail";
        let body = request.body();
        let mut headers = self
            .signer
            .sign(&body, "POST", route, "application/json")
            .map_err(|_| mail_unavailable("identity did not answer (Error)"))?;
        headers.push(("content-type".to_owned(), "application/json".to_owned()));
        let res = self
            .fetch
            .fetch(&HttpRequest {
                method: "POST".to_owned(),
                url: format!("{}{route}", self.base),
                headers,
                body: Some(body),
                timeout_ms: Some(5_000),
                refuse_redirect: true,
            })
            .map_err(|e| {
                mail_unavailable(&format!("identity did not answer ({})", thrown_name(&e)))
            })?;
        let Ok(answer) = json::parse(&res.body) else {
            return Err(mail_unavailable(&format!(
                "identity answered {} with no readable body",
                res.status
            )));
        };
        if !res.ok() {
            let code = match answer.get("code") {
                Some(Json::String(c)) => Some(c.as_str()),
                _ => None,
            };
            if let Some(known) = code.and_then(identity_refusal) {
                return Err(known);
            }
            let named = code.map(|c| format!(" {c}")).unwrap_or_default();
            return Err(mail_unavailable(&format!(
                "identity refused ({}{named})",
                res.status
            )));
        }
        // `serviceMailAcceptedSchema`: exactly `{ accepted: true, mailId }`.
        let accepted = match &answer {
            Json::Object(fields) => {
                fields.iter().all(|(k, _)| k == "accepted" || k == "mailId")
                    && matches!(answer.get("accepted"), Some(Json::Bool(true)))
            }
            _ => false,
        };
        match answer.get("mailId") {
            Some(Json::String(id)) if accepted && is_guid(id) => Ok(id.clone()),
            _ => Err(mail_unavailable("identity answered without a mail id")),
        }
    }
}

impl TrustedDevices for IdentityHttp {
    fn read(&self, user_id: &str, device_id: &str) -> Result<DeviceState, Refusal> {
        let route = format!(
            "/internal/trusted-devices/{}/{}",
            encode(user_id),
            encode(device_id)
        );
        let headers = self
            .signer
            .sign("", "GET", &route, "")
            .map_err(|_| device_unavailable("identity did not answer (Error)"))?;
        let res = self
            .fetch
            .fetch(&HttpRequest {
                method: "GET".to_owned(),
                url: format!("{}{route}", self.base),
                headers,
                body: None,
                timeout_ms: Some(3_000),
                refuse_redirect: true,
            })
            .map_err(|e| {
                device_unavailable(&format!("identity did not answer ({})", thrown_name(&e)))
            })?;
        if !res.ok() {
            return Err(device_unavailable(&format!(
                "identity answered {}",
                res.status
            )));
        }
        let Ok(body) = json::parse(&res.body) else {
            return Err(device_unavailable(
                "identity answered with no readable body",
            ));
        };
        device_state(&body).ok_or_else(|| {
            device_unavailable("identity answered outside the trusted-device schema")
        })
    }
}

/// `trustedDeviceStateSchema` (strict).
fn device_state(body: &Json) -> Option<DeviceState> {
    let Json::Object(fields) = body else {
        return None;
    };
    if !fields
        .iter()
        .all(|(k, _)| ["live", "trustedBy", "newDeviceCheck"].contains(&k.as_str()))
    {
        return None;
    }
    let live = match body.get("live") {
        Some(Json::Bool(b)) => *b,
        _ => return None,
    };
    let trusted_by = match body.get("trustedBy") {
        Some(Json::Null) => None,
        Some(Json::String(s)) if ["sign-up", "sign-in", "approval"].contains(&s.as_str()) => {
            Some(s.clone())
        }
        _ => return None,
    };
    let new_device_check = match body.get("newDeviceCheck") {
        Some(Json::String(s)) if s == "on" || s == "off" => s.clone(),
        _ => return None,
    };
    Some(DeviceState {
        live,
        trusted_by,
        new_device_check,
    })
}
