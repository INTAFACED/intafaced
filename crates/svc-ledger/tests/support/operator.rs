//! The operator doors' test kit, shared by the slices' Postgres suites: an approval consumer that approves whatever it
//! is asked (`stubApprovalConsumer`), an access token (`issueAccessToken`), and one request to the door.
#![allow(
    dead_code,
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "a test helper: each test file uses part of it, and a failure is the point"
)]

use std::sync::{Arc, Mutex};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hmac::{Hmac, Mac};
use service_kit::approvals::{ConsumeInput, Consumed};
use service_kit::json::{self, Json};
use service_kit::s2s::system_seconds;
use service_kit::s2s_verify::BodyBind;
use service_kit::server::{Door, Request};
use service_kit::telemetry::Logger;
use service_kit::tokens::TokenConfig;
use sha2::Sha256;
use svc_ledger::approval::{Approvals, Refused};
use svc_ledger::clock::system_ms;
use svc_ledger::door::{DoorConfig, LedgerDoor};
use svc_ledger::freeze::MemoryBus;
use svc_ledger::reconcile::{CustodyLayer, DEFAULT_STATEMENT_TIMEOUT_MS};

use super::TestDb;

pub const OPERATOR: &str = "11111111-1111-4111-8111-111111111111";
pub const TOKEN_SECRET: &str = "placeholder-ledger-freeze-test-token-secret";

/// The door as `index.ts` mounts it on this database, with these approvals; a suite sets the rest it needs.
pub fn door_config(db: &TestDb, bus: Arc<MemoryBus>, approvals: Box<dyn Approvals>) -> DoorConfig {
    DoorConfig {
        internal_secret: "placeholder-operator-test-internal-secret".to_owned(),
        body_bind: BodyBind::Require,
        keys: None,
        tokens: TokenConfig {
            secret: TOKEN_SECRET.to_owned(),
            issuer: "intafaced".to_owned(),
            audience: "intafaced.api".to_owned(),
            key_id: None,
            verify_only: Vec::new(),
        },
        clock: system_seconds,
        store: db.store(),
        service_name: "svc-ledger".to_owned(),
        bus,
        approvals,
        clock_skew_bound_ms: None,
        now_ms: system_ms,
        log: Logger::new("info", Box::new(std::io::sink())),
        indexer_url: None,
        fetch: Arc::new(service_kit::http::UreqFetch::new()),
        custody: CustodyLayer::On,
        reconcile_statement_timeout_ms: DEFAULT_STATEMENT_TIMEOUT_MS,
        posting: super::idle_posting(),
    }
}

/// What a consume asked for: approval, operation, payload hash, target and version.
pub type Asked = (String, String, String, String, String);

/// `stubApprovalConsumer`: consumes whatever it is asked, as `approver`, recording each request.
pub struct Stub {
    pub approver: Option<&'static str>,
    pub requester: &'static str,
    pub founders: Option<bool>,
    pub seen: Mutex<Vec<Asked>>,
}

impl Approvals for Stub {
    fn consume(&self, input: &ConsumeInput<'_>) -> Result<Consumed, Refused> {
        self.seen.lock().unwrap().push((
            input.approval_id.to_owned(),
            input.operation_id.to_owned(),
            input.payload_hash.to_owned(),
            input.target_id.to_owned(),
            input.expected_version.to_owned(),
        ));
        let verb = input
            .target_id
            .strip_prefix("posting_")
            .unwrap_or(input.target_id);
        Ok(Consumed {
            action_type: format!("ledger.{verb}"),
            target_service: input.target_service.to_owned(),
            target_id: input.target_id.to_owned(),
            status: "CONSUMED".to_owned(),
            requester_id: self.requester.to_owned(),
            approver_id: self.approver.map(str::to_owned),
            approver_is_founder: self.founders,
            requester_is_founder: self.founders,
        })
    }
}

pub fn stub(approver: Option<&'static str>, founders: Option<bool>) -> Arc<Stub> {
    Arc::new(Stub {
        approver,
        requester: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        founders,
        seen: Mutex::new(Vec::new()),
    })
}

pub struct Shared(pub Arc<Stub>);

impl Approvals for Shared {
    fn consume(&self, input: &ConsumeInput<'_>) -> Result<Consumed, Refused> {
        self.0.consume(input)
    }
}

/// `issueAccessToken` for the operator, with these scopes and second factor.
pub fn bearer(scopes: &[&str], mfa: bool) -> String {
    let now = system_seconds();
    let b64 = |j: Json| URL_SAFE_NO_PAD.encode(j.compact());
    let header = b64(Json::obj([
        ("alg", Json::str("HS256")),
        ("typ", Json::str("JWT")),
    ]));
    let claims = b64(Json::obj([
        (
            "scopes",
            Json::Array(scopes.iter().map(|s| Json::str(*s)).collect()),
        ),
        ("tier", Json::str("basic")),
        ("mfa", Json::Bool(mfa)),
        ("sid", Json::str("33333333-3333-4333-8333-333333333333")),
        ("sub", Json::str(OPERATOR)),
        ("iss", Json::str("intafaced")),
        ("aud", Json::str("intafaced.api")),
        ("iat", Json::int(now)),
        ("exp", Json::int(now + 900)),
        ("jti", Json::str("44444444-4444-4444-8444-444444444444")),
    ]));
    let mut mac = Hmac::<Sha256>::new_from_slice(TOKEN_SECRET.as_bytes()).unwrap();
    mac.update(format!("{header}.{claims}").as_bytes());
    let sig = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
    format!("Bearer {header}.{claims}.{sig}")
}

pub fn treasury() -> Option<String> {
    Some(bearer(&["admin:treasury"], true))
}

/// One request to the door: its status and parsed body.
pub fn call(
    door: &LedgerDoor,
    method: &str,
    path: &str,
    auth: Option<String>,
    body: &str,
) -> (u16, Json) {
    let mut headers = Vec::new();
    if let Some(a) = auth {
        headers.push(("authorization".to_owned(), a));
    }
    if !body.is_empty() {
        headers.push(("content-type".to_owned(), "application/json".to_owned()));
    }
    let r = door.handle_as(
        &Request {
            method,
            url: path,
            headers: &headers,
            body,
        },
        "req-1",
    );
    (r.status, json::parse(&r.body).unwrap())
}

pub fn code(body: &Json) -> Option<&str> {
    match body.get("code") {
        Some(Json::String(c)) => Some(c),
        _ => None,
    }
}
