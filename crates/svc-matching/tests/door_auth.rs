//! Who may call the doors, ported from the TypeScript service's `router.test.ts` (order writes and the reconciliation
//! routes require service credentials), `operator-bind.router.test.ts` (every approval-gated venue door binds its
//! approval to the venue's operators) and `service-keys.test.ts` (the doors under per-service keys). Each test drives the
//! real door over a real engine; "the engine is never called" is read off the engine's journal and its resting orders.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hmac::{Hmac, Mac};
use service_kit::approvals::{ConsumeInput, Consumed};
use service_kit::json::{self, Json};
use service_kit::s2s::{
    KeyringEntry, Mode, ServiceSigner, SignedContext, legacy_headers, system_seconds,
};
use service_kit::s2s_verify::{BodyBind, ServiceVerifier};
use service_kit::server::Request;
use sha2::{Digest, Sha256};
use svc_matching::approval::{Approvals, Refused, Stub};
use svc_matching::door::{DoorConfig, Keys, MatchingDoor, Outcome};
use svc_matching::engine::{EngineParts, MatchingEngine, MemoryEventBus};
use svc_matching::env::parse_operator_ids;
use svc_matching::journal::io::MemoryJournal;
use svc_matching::journal::replay::MemorySnapshotSink;

const SECRET: &str = "matching-internal-service-secret-32c";
const MARKET: &str = "BTC-USDT";
const ORDER: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

/// The door's clock is the real one, so the shared-secret and key-signed headers (signed now) are fresh.
fn now_ms() -> i64 {
    system_seconds() * 1000
}

fn engine() -> MatchingEngine {
    MatchingEngine::new(EngineParts {
        journal: Box::new(MemoryJournal::new()),
        bus: Box::new(MemoryEventBus::default()),
        clock: now_ms,
        expiry_clock: false,
        snapshot_every: 0,
        sink: Box::new(MemorySnapshotSink::default()),
        enabled: true,
        spread_fills: true,
    })
}

fn door_full(
    body_bind: BodyBind,
    keys: Option<Keys>,
    approvals: Box<dyn Approvals>,
    operators: &str,
) -> MatchingDoor {
    MatchingDoor::new(
        DoorConfig {
            internal_secret: SECRET.to_owned(),
            body_bind,
            keys,
            edge_secret: None,
            edge_key: None,
            clock: now_ms,
            approvals,
            operator_ids: parse_operator_ids(Some(operators)),
        },
        engine(),
    )
    .unwrap()
}

fn stub() -> Box<dyn Approvals> {
    Box::new(Stub {
        approver_id: "ops-confirm".to_owned(),
        requester_id: "ops-1".to_owned(),
    })
}

/// `registerRoutes(app, engine, SECRET, { bodyBind })`.
fn mount(body_bind: BodyBind) -> MatchingDoor {
    door_full(body_bind, None, stub(), "ops-1, ops-confirm")
}

// ── requests ────────────────────────────────────────────────────────────

struct Answer {
    status: u16,
    body: Json,
}

impl Answer {
    fn text(&self, key: &str) -> String {
        match self.body.get(key) {
            Some(Json::String(s)) => s.clone(),
            other => panic!("{key} is not text in {}: {other:?}", self.body.compact()),
        }
    }
}

type Headers = Vec<(String, String)>;

fn send(
    door: &MatchingDoor,
    method: &str,
    url: &str,
    payload: &str,
    headers: &[(String, String)],
) -> Answer {
    // A bodyless call sends no content type, as `app.inject` sends none without a payload.
    let mut all: Vec<(String, String)> = if payload.is_empty() {
        Vec::new()
    } else {
        vec![("content-type".to_owned(), "application/json".to_owned())]
    };
    all.extend_from_slice(headers);
    match door.decide(&Request {
        method,
        url,
        headers: &all,
        body: payload,
    }) {
        Outcome::Answer(r) => Answer {
            status: r.status,
            body: json::parse(&r.body).unwrap_or_else(|_| panic!("{} is JSON", r.body)),
        },
        Outcome::Owed(s) => panic!("{method} {url} is owed by {}", s.name()),
    }
}

/// `serviceAuthHeadersForBody(service, SECRET, body)`: v2, the body bound by its digest.
fn v2(service: &str, body: &str) -> Headers {
    legacy_headers(service, SECRET, body, system_seconds()).unwrap()
}

/// `serviceAuthHeaders(service, SECRET)`: v1, which binds no body.
fn v1(service: &str) -> Headers {
    let ts = system_seconds().to_string();
    let mut mac = Hmac::<Sha256>::new_from_slice(SECRET.as_bytes()).unwrap();
    mac.update(format!("{service}\n{ts}").as_bytes());
    let sig: String = mac
        .finalize()
        .into_bytes()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    vec![
        ("x-intafaced-service".to_owned(), service.to_owned()),
        ("x-intafaced-service-ts".to_owned(), ts),
        ("x-intafaced-service-sig".to_owned(), sig),
    ]
}

fn strs(items: &[&str]) -> Json {
    Json::Array(items.iter().map(|s| Json::str(*s)).collect())
}

/// `createMarketLifecycleAdmissionProof(snapshot, action)` with these allowed actions.
fn proof(action: &str, allowed: &[&str], transition: &str) -> Json {
    let at = "2026-08-24T16:00:00.000Z";
    let snapshot = Json::obj([
        ("marketId", Json::str(MARKET)),
        ("ruleVersion", Json::str("test.rules.v1")),
        ("instrumentId", Json::str(MARKET)),
        ("instrumentVersion", Json::str("test.instrument.v1")),
        ("state", Json::str("OPEN")),
        ("reasonCategory", Json::str("NORMAL")),
        ("reasonCode", Json::str("trade.lifecycle.ready")),
        ("effectiveAt", Json::str(at)),
        ("observedAt", Json::str(at)),
        ("lastGoodState", Json::str("OPEN")),
        ("allowedActions", strs(allowed)),
        ("transitionId", Json::str("test.transition")),
        ("evidenceRefs", strs(&["test.evidence"])),
    ]);
    let hex: String = Sha256::digest(snapshot.compact().as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    Json::obj([
        ("action", Json::str(action)),
        ("decision", Json::str("ELIGIBLE")),
        ("checkedAt", Json::str(at)),
        (
            "snapshotId",
            Json::str(format!("trade.lifecycle.snapshot:{hex}")),
        ),
        ("transitionId", Json::str(transition)),
        ("evidenceRefs", strs(&["test.evidence"])),
        ("snapshot", snapshot),
    ])
}

/// `validSubmit`: a GTC limit buy of 1.5 at 30000.
fn submit_body(qty: &str, transition: &str) -> String {
    Json::obj([
        ("orderId", Json::str(ORDER)),
        ("accountId", Json::str("acct-1")),
        ("type", Json::str("limit")),
        ("side", Json::str("buy")),
        ("qty", Json::str(qty)),
        ("price", Json::str("30000")),
        ("tif", Json::str("GTC")),
        (
            "lifecycleProof",
            proof("PLACE", &["PLACE", "PLACE_POST_ONLY"], transition),
        ),
    ])
    .compact()
}

fn valid_submit() -> String {
    submit_body("1.5", "test.transition")
}

/// `validAmend`.
fn amend_body() -> String {
    Json::obj([
        ("expectedVersion", Json::int(1)),
        ("qty", Json::str("1")),
        (
            "lifecycleProof",
            proof(
                "AMEND",
                &["PLACE", "PLACE_POST_ONLY", "AMEND"],
                "test.transition",
            ),
        ),
    ])
    .compact()
}

const ORDERS: &str = "/markets/BTC-USDT/orders";

fn order_url() -> String {
    format!("{ORDERS}/{ORDER}")
}

fn submit(door: &MatchingDoor, headers: &[(String, String)], payload: &str) -> Answer {
    send(door, "POST", ORDERS, payload, headers)
}

fn cancel(door: &MatchingDoor, headers: &[(String, String)]) -> Answer {
    send(door, "DELETE", &order_url(), "", headers)
}

fn amend(door: &MatchingDoor, headers: &[(String, String)], payload: &str) -> Answer {
    send(door, "PATCH", &order_url(), payload, headers)
}

/// The journal's record kinds: what the engine was asked to do.
fn kinds(door: &MatchingDoor) -> Vec<String> {
    door.engine()
        .journal()
        .read()
        .iter()
        .map(|r| r.kind().unwrap_or("").to_owned())
        .collect()
}

fn resting(door: &MatchingDoor) -> usize {
    door.engine().resting_order_count()
}

/// The engine was never asked to do anything.
fn untouched(door: &MatchingDoor) {
    assert!(
        kinds(door).is_empty(),
        "the engine was called: {:?}",
        kinds(door)
    );
}

/// A door with ORDER resting on the book, placed by a signed svc-trade.
fn with_resting(body_bind: BodyBind) -> MatchingDoor {
    let door = mount(body_bind);
    let p = valid_submit();
    let a = submit(&door, &v2("svc-trade", &p), &p);
    assert_eq!(a.status, 200, "{}", a.body.compact());
    assert_eq!(resting(&door), 1);
    door
}

fn forbidden(a: &Answer) {
    assert_eq!(a.status, 403, "{}", a.body.compact());
    assert_eq!(a.text("code"), "Forbidden");
    assert!(!a.text("message").is_empty());
}

fn unauthenticated(a: &Answer, rejected: Option<&str>) {
    assert_eq!(a.status, 401, "{}", a.body.compact());
    assert!(!a.text("message").is_empty());
    if let Some(why) = rejected {
        assert_eq!(a.text("rejected"), why, "{}", a.body.compact());
    }
}

// ── router.test.ts: order writes require service credentials ────────────

#[test]
fn writes_refuse_an_unauthenticated_submit_and_the_engine_is_never_called() {
    let door = mount(BodyBind::Require);
    unauthenticated(&submit(&door, &[], &valid_submit()), None);
    untouched(&door);
}

#[test]
fn writes_refuse_an_unauthenticated_cancel_and_the_order_still_rests() {
    let door = with_resting(BodyBind::Require);
    let before = kinds(&door);
    unauthenticated(&cancel(&door, &[]), None);
    assert_eq!(kinds(&door), before);
    assert_eq!(resting(&door), 1);
}

#[test]
fn writes_refuse_an_unauthenticated_amend_and_the_engine_is_never_called() {
    let door = with_resting(BodyBind::Require);
    let before = kinds(&door);
    let p = amend_body();
    unauthenticated(&amend(&door, &[], &p), None);
    assert_eq!(kinds(&door), before);
}

#[test]
fn writes_accept_a_properly_signed_amend_that_binds_its_body() {
    let door = with_resting(BodyBind::Require);
    let p = amend_body();
    let a = amend(&door, &v2("svc-trade", &p), &p);
    assert_eq!(a.status, 200, "{}", a.body.compact());
    assert_eq!(a.body.get("accepted"), Some(&Json::Bool(true)));
    assert_eq!(kinds(&door).last().map(String::as_str), Some("amend"));
}

#[test]
fn writes_answer_a_stable_403_for_an_authenticated_unmapped_submit_and_cancel() {
    let door = mount(BodyBind::Require);
    let p = valid_submit();
    forbidden(&submit(&door, &v2("svc-pay", &p), &p));
    untouched(&door);
    let door = with_resting(BodyBind::Require);
    forbidden(&cancel(&door, &v2("svc-pay", "")));
    assert_eq!(resting(&door), 1);
}

#[test]
fn writes_accept_signed_submits_and_cancels_from_svc_execution_svc_fix_and_svc_trade() {
    for caller in ["svc-execution", "svc-fix", "svc-trade"] {
        let door = mount(BodyBind::Require);
        let p = valid_submit();
        let a = submit(&door, &v2(caller, &p), &p);
        assert_eq!(a.status, 200, "{caller}: {}", a.body.compact());
        assert_eq!(resting(&door), 1, "{caller}");
        // A bodyless request still binds, as the digest of the empty body.
        let a = cancel(&door, &v2(caller, ""));
        assert_eq!(a.status, 200, "{caller}: {}", a.body.compact());
        assert_eq!(resting(&door), 0, "{caller}");
    }
}

#[test]
fn writes_refuse_an_unsigned_svc_fix_submit_as_401_the_hmac_is_not_dropped() {
    let door = mount(BodyBind::Require);
    let only_name = vec![("x-intafaced-service".to_owned(), "svc-fix".to_owned())];
    unauthenticated(&submit(&door, &only_name, &valid_submit()), None);
    untouched(&door);
}

#[test]
fn writes_refuse_a_forged_signature() {
    let door = with_resting(BodyBind::Require);
    let forged = vec![
        ("x-intafaced-service".to_owned(), "svc-trade".to_owned()),
        (
            "x-intafaced-service-ts".to_owned(),
            system_seconds().to_string(),
        ),
        ("x-intafaced-service-sig".to_owned(), "a".repeat(64)),
    ];
    unauthenticated(&cancel(&door, &forged), None);
    assert_eq!(resting(&door), 1);
}

/// The replay the body bind closes: credentials captured on one funded order, replayed over a different one, would match
/// an order svc-trade holds nothing for.
#[test]
fn writes_refuse_captured_credentials_replayed_over_a_mutated_order_and_the_engine_is_never_called()
{
    let door = mount(BodyBind::Require);
    let headers = v2("svc-trade", &valid_submit());
    unauthenticated(
        &submit(&door, &headers, &submit_body("1500", "test.transition")),
        Some("body-mismatch"),
    );
    untouched(&door);
}

#[test]
fn writes_refuse_captured_credentials_replayed_over_a_mutated_lifecycle_proof() {
    let door = mount(BodyBind::Require);
    let headers = v2("svc-trade", &valid_submit());
    unauthenticated(
        &submit(
            &door,
            &headers,
            &submit_body("1.5", "tampered-after-signing"),
        ),
        Some("body-mismatch"),
    );
    untouched(&door);
}

#[test]
fn writes_refuse_cancel_credentials_lifted_onto_a_submit() {
    let door = mount(BodyBind::Require);
    unauthenticated(
        &submit(&door, &v2("svc-trade", ""), &valid_submit()),
        Some("body-mismatch"),
    );
    untouched(&door);
}

#[test]
fn writes_accept_both_admits_a_legacy_v1_submit_and_an_empty_body_cancel() {
    let door = mount(BodyBind::AcceptBoth);
    let a = submit(&door, &v1("svc-trade"), &valid_submit());
    assert_eq!(a.status, 200, "{}", a.body.compact());
    assert_eq!(resting(&door), 1);
    let a = cancel(&door, &v1("svc-trade"));
    assert_eq!(a.status, 200, "{}", a.body.compact());
}

#[test]
fn writes_require_refuses_that_same_legacy_caller_naming_why() {
    let door = with_resting(BodyBind::Require);
    unauthenticated(
        &cancel(&door, &v1("svc-trade")),
        Some("missing-body-digest"),
    );
    assert_eq!(resting(&door), 1);
}

#[test]
fn writes_require_refuses_a_v1_unmapped_caller_as_401_not_403() {
    let door = mount(BodyBind::Require);
    unauthenticated(
        &submit(&door, &v1("svc-pay"), &valid_submit()),
        Some("missing-body-digest"),
    );
    untouched(&door);
}

#[test]
fn writes_leave_market_data_readable_without_credentials() {
    let door = mount(BodyBind::Require);
    let markets = send(&door, "GET", "/markets", "", &[]);
    assert_eq!(markets.status, 200);
    assert_eq!(markets.body.get("markets"), Some(&strs(&[])));
    let door = with_resting(BodyBind::Require);
    let depth = send(&door, "GET", "/markets/BTC-USDT/depth?limit=50", "", &[]);
    assert_eq!(depth.status, 200, "{}", depth.body.compact());
    let markets = send(&door, "GET", "/markets", "", &[]);
    assert_eq!(markets.body.get("markets"), Some(&strs(&[MARKET])));
}

// ── router.test.ts: the reconciliation routes ───────────────────────────

#[test]
fn reconcile_the_liveness_read_refuses_an_unauthenticated_and_a_non_trade_caller() {
    let door = with_resting(BodyBind::Require);
    unauthenticated(&send(&door, "GET", ORDERS, "", &[]), None);
    forbidden(&send(&door, "GET", ORDERS, "", &v2("svc-execution", "")));
    let read = send(
        &door,
        "GET",
        &format!("{ORDERS}?limit=2"),
        "",
        &v2("svc-trade", ""),
    );
    assert_eq!(read.status, 200, "{}", read.body.compact());
    let Some(Json::Array(orders)) = read.body.get("orders") else {
        panic!("{}", read.body.compact())
    };
    assert_eq!(orders.len(), 1);
    assert_eq!(resting(&door), 1, "a read cancels nothing");
}

#[test]
fn reconcile_refuses_an_unauthenticated_and_a_non_trade_caller_and_moves_nothing() {
    let door = with_resting(BodyBind::Require);
    let before = kinds(&door);
    let empty = r#"{"orders":[]}"#;
    unauthenticated(&send(&door, "POST", "/reconcile", empty, &[]), None);
    forbidden(&send(
        &door,
        "POST",
        "/reconcile",
        empty,
        &v2("svc-execution", empty),
    ));
    let body = Json::obj([(
        "orders",
        Json::Array(vec![Json::obj([
            ("orderId", Json::str(ORDER)),
            ("marketId", Json::str(MARKET)),
            ("state", Json::str("open")),
            ("remaining", Json::str("1.5")),
            ("funded", Json::Bool(true)),
        ])]),
    )])
    .compact();
    let clean = send(&door, "POST", "/reconcile", &body, &v2("svc-trade", &body));
    assert_eq!(clean.status, 200, "{}", clean.body.compact());
    assert_eq!(
        clean.body.get("ok"),
        Some(&Json::Bool(true)),
        "{}",
        clean.body.compact()
    );
    let orphaned = send(&door, "POST", "/reconcile", empty, &v2("svc-trade", empty));
    assert_eq!(
        orphaned.body.get("ok"),
        Some(&Json::Bool(false)),
        "{}",
        orphaned.body.compact()
    );
    assert_eq!(kinds(&door), before, "reconcile writes nothing");
    assert_eq!(resting(&door), 1, "reconcile cancels nothing");
}

// ── operator-bind.router.test.ts ────────────────────────────────────────

const USER_A: &str = "aaaaaaaa-0000-4000-8000-00000000000a";
const USER_B: &str = "bbbbbbbb-0000-4000-8000-00000000000b";
const OP_A: &str = "cccccccc-0000-4000-8000-00000000000c";
const OP_B: &str = "dddddddd-0000-4000-8000-00000000000d";

fn operators() -> String {
    format!("{OP_A}, {}", OP_B.to_uppercase())
}

/// `identityApproval(requester, approver, over)`: what identity returns for an approved approval, honest unless `over`
/// changes it, counting each consume. Until `ready` is set it answers the set-up's own prelaunch as the venue's two
/// operators would, uncounted.
#[derive(Clone, Default)]
struct Over {
    action: Option<String>,
    target: Option<String>,
    service: Option<String>,
    status: Option<String>,
    founders: Option<bool>,
}

struct Ident {
    requester: String,
    approver: Option<String>,
    over: Over,
    consumed: Arc<AtomicUsize>,
    ready: Arc<AtomicBool>,
}

struct Handles {
    consumed: Arc<AtomicUsize>,
    ready: Arc<AtomicBool>,
}

fn ident(requester: &str, approver: Option<&str>, over: Over) -> (Box<dyn Approvals>, Handles) {
    let consumed = Arc::new(AtomicUsize::new(0));
    let ready = Arc::new(AtomicBool::new(true));
    (
        Box::new(Ident {
            requester: requester.to_owned(),
            approver: approver.map(str::to_owned),
            over,
            consumed: consumed.clone(),
            ready: ready.clone(),
        }),
        Handles { consumed, ready },
    )
}

impl Approvals for Ident {
    fn consume(&self, input: &ConsumeInput<'_>) -> Result<Consumed, Refused> {
        let ready = self.ready.load(Ordering::SeqCst);
        let (requester, approver, over) = if ready {
            self.consumed.fetch_add(1, Ordering::SeqCst);
            (
                self.requester.clone(),
                self.approver.clone(),
                self.over.clone(),
            )
        } else {
            (OP_A.to_owned(), Some(OP_B.to_owned()), Over::default())
        };
        let head = input.target_id.split(':').next().unwrap_or("");
        Ok(Consumed {
            action_type: over.action.unwrap_or_else(|| format!("matching.{head}")),
            target_service: over
                .service
                .unwrap_or_else(|| input.target_service.to_owned()),
            target_id: over.target.unwrap_or_else(|| input.target_id.to_owned()),
            status: over.status.unwrap_or_else(|| "CONSUMED".to_owned()),
            requester_id: requester,
            approver_id: approver,
            approver_is_founder: Some(over.founders.unwrap_or(true)),
            requester_is_founder: Some(over.founders.unwrap_or(true)),
        })
    }
}

fn bind_door(approvals: Box<dyn Approvals>, operator_ids: &str) -> MatchingDoor {
    door_full(BodyBind::Require, None, approvals, operator_ids)
}

fn ask(operator: &str) -> String {
    Json::obj([
        ("operatorId", Json::str(operator)),
        ("approvalId", Json::str("appr-1")),
        ("operationId", Json::str("op-1")),
    ])
    .compact()
}

fn post(door: &MatchingDoor, url: &str, body: &str) -> Answer {
    send(door, "POST", url, body, &v2("svc-trade", body))
}

fn listed(door: &MatchingDoor) -> bool {
    let a = send(door, "GET", "/markets", "", &[]);
    matches!(a.body.get("markets"), Some(Json::Array(m)) if m.contains(&Json::str(MARKET)))
}

/// `prelaunched(approvals, operatorIds)`: the market prelaunched by the venue's operators, then the door under test.
fn prelaunched(
    requester: &str,
    approver: Option<&str>,
    over: Over,
    operator_ids: &str,
) -> (MatchingDoor, Arc<AtomicUsize>) {
    let (approvals, h) = ident(requester, approver, over);
    if operator_ids != operators() {
        // A door with another operator list cannot prelaunch through its own doors; it is mounted fresh, and the test
        // reads that the market is not listed.
        return (bind_door(approvals, operator_ids), h.consumed);
    }
    let door = bind_door(approvals, operator_ids);
    h.ready.store(false, Ordering::SeqCst);
    let a = post(&door, &format!("/markets/{MARKET}/prelaunch"), &ask(OP_A));
    assert_eq!(a.status, 200, "set-up prelaunch: {}", a.body.compact());
    assert!(door.engine().flags(MARKET).prelaunch);
    h.ready.store(true, Ordering::SeqCst);
    (door, h.consumed)
}

fn refused(a: &Answer, code: &str) {
    assert_eq!(a.status, 400, "{}", a.body.compact());
    assert_eq!(a.text("code"), code, "{}", a.body.compact());
}

fn open_url() -> String {
    format!("/markets/{MARKET}/open")
}

#[test]
fn bind_open_refuses_two_ordinary_users_who_propose_and_approve_between_themselves() {
    let (door, _) = prelaunched(USER_A, Some(USER_B), Over::default(), &operators());
    let body = Json::obj([
        ("operatorId", Json::str(USER_A)),
        ("confirmOperatorId", Json::str(USER_B)),
        ("approvalId", Json::str("appr-1")),
        ("operationId", Json::str("op-1")),
    ])
    .compact();
    refused(
        &post(&door, &open_url(), &body),
        "action_approval.not_operator",
    );
    assert!(door.engine().flags(MARKET).prelaunch);
    assert!(!listed(&door));
}

#[test]
fn bind_open_opens_for_a_real_operator_pair_and_reports_the_people_identity_recorded() {
    let (door, _) = prelaunched(OP_A, Some(OP_B), Over::default(), &operators());
    let body = Json::obj([
        ("operatorId", Json::str(OP_A)),
        ("confirmOperatorId", Json::str("someone-else")),
        ("approvalId", Json::str("appr-1")),
        ("operationId", Json::str("op-1")),
    ])
    .compact();
    let a = post(&door, &open_url(), &body);
    assert_eq!(a.status, 200, "{}", a.body.compact());
    assert_eq!(a.text("operatorId"), OP_A);
    // A typed confirmOperatorId is ignored: the approver comes from identity.
    assert_eq!(a.text("confirmOperatorId"), OP_B);
    assert!(!door.engine().flags(MARKET).prelaunch);
}

#[test]
fn bind_open_refuses_an_operator_id_that_is_not_the_approval_requester() {
    let (door, _) = prelaunched(USER_A, Some(USER_B), Over::default(), &operators());
    refused(
        &post(&door, &open_url(), &ask(OP_A)),
        "action_approval.operator_not_requester",
    );
    assert!(door.engine().flags(MARKET).prelaunch);
    // Both operators and founders, the body naming the approver instead of the requester.
    let (door, _) = prelaunched(OP_B, Some(OP_A), Over::default(), &operators());
    refused(
        &post(&door, &open_url(), &ask(OP_A)),
        "action_approval.operator_not_requester",
    );
    assert!(door.engine().flags(MARKET).prelaunch);
}

#[test]
fn bind_open_refuses_when_identity_did_not_attest_a_founder_pair() {
    let over = Over {
        founders: Some(false),
        ..Over::default()
    };
    let (door, _) = prelaunched(OP_A, Some(OP_B), over, &operators());
    refused(
        &post(&door, &open_url(), &ask(OP_A)),
        "action_approval.not_founders",
    );
    assert!(door.engine().flags(MARKET).prelaunch);
}

#[test]
fn bind_open_refuses_an_operator_with_an_ordinary_approver_and_an_ordinary_user_with_an_operator_approver()
 {
    let (door, _) = prelaunched(OP_A, Some(USER_B), Over::default(), &operators());
    refused(
        &post(&door, &open_url(), &ask(OP_A)),
        "action_approval.not_operator",
    );
    assert!(door.engine().flags(MARKET).prelaunch);
    let (door, _) = prelaunched(USER_A, Some(OP_B), Over::default(), &operators());
    refused(
        &post(&door, &open_url(), &ask(USER_A)),
        "action_approval.not_operator",
    );
}

#[test]
fn bind_open_refuses_before_spending_the_approval_when_the_typed_requester_is_not_an_operator() {
    let (door, consumed) = prelaunched(OP_A, Some(OP_B), Over::default(), &operators());
    let before = consumed.load(Ordering::SeqCst);
    refused(
        &post(&door, &open_url(), &ask(USER_A)),
        "action_approval.not_operator",
    );
    assert_eq!(
        consumed.load(Ordering::SeqCst),
        before,
        "the approval was spent"
    );
}

#[test]
fn bind_open_refuses_everyone_when_no_operator_list_is_published() {
    let (door, _) = prelaunched(OP_A, Some(OP_B), Over::default(), "");
    refused(
        &post(&door, &open_url(), &ask(OP_A)),
        "action_approval.operators_unset",
    );
    assert!(!listed(&door));
}

#[test]
fn bind_open_refuses_an_approval_with_no_distinct_approver() {
    let (door, _) = prelaunched(OP_A, None, Over::default(), &operators());
    refused(
        &post(&door, &open_url(), &ask(OP_A)),
        "action_approval.missing",
    );
    let (approvals, _h) = ident(OP_A, Some(&OP_A.to_uppercase()), Over::default());
    let door = bind_door(approvals, &operators());
    refused(
        &post(&door, &open_url(), &ask(OP_A)),
        "action_approval.missing",
    );
}

#[test]
fn bind_halt_binds_the_requester_too() {
    let (approvals, _h) = ident(USER_A, Some(USER_B), Over::default());
    let door = bind_door(approvals, &operators());
    refused(
        &post(&door, &format!("/markets/{MARKET}/halt"), &ask(OP_A)),
        "action_approval.operator_not_requester",
    );
    assert!(!door.engine().flags(MARKET).halted);
}

/// Every approval-gated door: its route and the action it consumes.
const DOORS: [(&str, &str); 12] = [
    ("/markets/BTC-USDT/halt", "matching.halt"),
    ("/markets/BTC-USDT/resume", "matching.resume"),
    ("/halt-all", "matching.halt_all"),
    ("/resume-all", "matching.resume_all"),
    ("/markets/BTC-USDT/reduce-only", "matching.reduce_only"),
    (
        "/markets/BTC-USDT/reduce-only/resume",
        "matching.reduce_only_resume",
    ),
    ("/markets/BTC-USDT/post-only", "matching.post_only"),
    (
        "/markets/BTC-USDT/post-only/resume",
        "matching.post_only_resume",
    ),
    ("/markets/BTC-USDT/prelaunch", "matching.prelaunch"),
    ("/markets/BTC-USDT/open", "matching.open"),
    ("/markets/BTC-USDT/expire", "matching.expire"),
    ("/markets/BTC-USDT/delist", "matching.delist"),
];

fn at_door(
    route: &str,
    requester: &str,
    approver: &str,
    over: Over,
    operator_ids: &str,
    body_operator: &str,
) -> Answer {
    let (approvals, _h) = ident(requester, Some(approver), over);
    let door = bind_door(approvals, operator_ids);
    post(&door, route, &ask(body_operator))
}

#[test]
fn bind_every_approval_door_refuses_ordinary_users_an_ordinary_approver_and_an_unpublished_list() {
    for (route, action) in DOORS {
        let a = at_door(route, USER_A, USER_B, Over::default(), &operators(), USER_A);
        assert_eq!(a.status, 400, "{action}: {}", a.body.compact());
        assert_eq!(a.text("code"), "action_approval.not_operator", "{action}");
        let a = at_door(route, OP_A, USER_B, Over::default(), &operators(), OP_A);
        assert_eq!(a.text("code"), "action_approval.not_operator", "{action}");
        let a = at_door(route, OP_A, OP_B, Over::default(), "", OP_A);
        assert_eq!(
            a.text("code"),
            "action_approval.operators_unset",
            "{action}"
        );
    }
}

#[test]
fn bind_every_approval_door_refuses_an_approval_for_another_action_target_service_or_status() {
    for (route, action) in DOORS {
        let other = if action == "matching.halt" {
            "matching.resume"
        } else {
            "matching.halt"
        };
        let cases = [
            Over {
                action: Some(other.to_owned()),
                ..Over::default()
            },
            Over {
                target: Some("halt:BTC-USDT:other".to_owned()),
                ..Over::default()
            },
            Over {
                service: Some("svc-trade".to_owned()),
                ..Over::default()
            },
            Over {
                status: Some("APPROVED".to_owned()),
                ..Over::default()
            },
        ];
        for (i, over) in cases.into_iter().enumerate() {
            let a = at_door(route, OP_A, OP_B, over, &operators(), OP_A);
            assert_eq!(a.status, 400, "{action} case {i}: {}", a.body.compact());
            assert_eq!(
                a.text("code"),
                "action_approval.wrong_action",
                "{action} case {i}"
            );
        }
    }
}

#[test]
fn bind_every_approval_door_lets_a_real_operator_pair_through_with_an_honest_approval() {
    for (route, action) in DOORS {
        let a = at_door(route, OP_A, OP_B, Over::default(), &operators(), OP_A);
        assert_eq!(a.status, 200, "{action}: {}", a.body.compact());
        assert_eq!(a.text("operatorId"), OP_A, "{action}");
        assert_eq!(a.text("confirmOperatorId"), OP_B, "{action}");
    }
}

#[test]
fn bind_parse_operator_ids_lowercases_trims_and_drops_blanks() {
    assert_eq!(parse_operator_ids(Some(" A-1 , ,b-2,")), vec!["a-1", "b-2"]);
    assert_eq!(parse_operator_ids(Some("x ,\t y\n,z")), vec!["x", "y", "z"]);
    assert!(parse_operator_ids(None).is_empty());
    assert!(parse_operator_ids(Some("")).is_empty());
}

// ── service-keys.test.ts ────────────────────────────────────────────────

const KEYED_URL: &str = "/surveillance/cases?limit=2";

fn pkcs8(seed: &[u8; 32]) -> String {
    let mut der = vec![
        0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04,
        0x20,
    ];
    der.extend_from_slice(seed);
    URL_SAFE_NO_PAD.encode(der)
}

/// svc-trade's and svc-pay's keys, generated per run, and the keyring that publishes them.
struct Fleet {
    keyring: Vec<KeyringEntry>,
    trade: ServiceSigner,
    pay: ServiceSigner,
}

fn fleet() -> Fleet {
    let mut seeds = [[0u8; 32]; 2];
    for s in &mut seeds {
        getrandom::fill(s).unwrap();
    }
    let services = ["svc-trade", "svc-pay"];
    let keyring: Vec<KeyringEntry> = services
        .iter()
        .zip(&seeds)
        .map(|(svc, seed)| KeyringEntry {
            kid: format!("{svc}.a"),
            svc: (*svc).to_owned(),
            use_: "s2s".to_owned(),
            x: URL_SAFE_NO_PAD.encode(
                ed25519_dalek::SigningKey::from_bytes(seed)
                    .verifying_key()
                    .as_bytes(),
            ),
        })
        .collect();
    let signer = |i: usize| {
        ServiceSigner::new(
            services[i],
            &format!("{}.a", services[i]),
            &pkcs8(&seeds[i]),
            &keyring,
        )
        .unwrap()
    };
    Fleet {
        trade: signer(0),
        pay: signer(1),
        keyring: keyring.clone(),
    }
}

fn keyed_door(f: &Fleet, mode: Option<Mode>) -> MatchingDoor {
    let keys = mode.map(|mode| Keys {
        verifier: ServiceVerifier::new("svc-matching", &f.keyring, system_seconds).unwrap(),
        mode,
    });
    door_full(BodyBind::Require, keys, stub(), "ops-1, ops-confirm")
}

fn keyed(signer: &ServiceSigner, audience: &str) -> Headers {
    signer
        .headers(audience, "GET", KEYED_URL, "", &SignedContext::default())
        .unwrap()
}

fn keyed_get(door: &MatchingDoor, headers: &[(String, String)]) -> u16 {
    send(door, "GET", KEYED_URL, "", headers).status
}

#[test]
fn keys_without_s2s_a_key_signed_call_is_not_a_service_call_and_the_shared_secret_works() {
    let f = fleet();
    let door = keyed_door(&f, None);
    assert_eq!(keyed_get(&door, &keyed(&f.trade, "svc-matching")), 401);
    assert_eq!(keyed_get(&door, &v2("svc-trade", "")), 200);
}

#[test]
fn keys_dual_accepts_the_key_and_the_shared_secret() {
    let f = fleet();
    let door = keyed_door(&f, Some(Mode::Dual));
    assert_eq!(keyed_get(&door, &keyed(&f.trade, "svc-matching")), 200);
    assert_eq!(keyed_get(&door, &v2("svc-trade", "")), 200);
}

#[test]
fn keys_keypair_accepts_the_key_and_refuses_the_shared_secret() {
    let f = fleet();
    let door = keyed_door(&f, Some(Mode::Keypair));
    assert_eq!(keyed_get(&door, &keyed(&f.trade, "svc-matching")), 200);
    assert_eq!(keyed_get(&door, &v2("svc-trade", "")), 401);
}

#[test]
fn keys_a_service_key_outside_the_allowed_callers_is_403() {
    let f = fleet();
    let door = keyed_door(&f, Some(Mode::Keypair));
    assert_eq!(keyed_get(&door, &keyed(&f.pay, "svc-matching")), 403);
}

#[test]
fn keys_refuse_a_key_signed_call_meant_for_another_service_and_a_replayed_one() {
    let f = fleet();
    let door = keyed_door(&f, Some(Mode::Keypair));
    assert_eq!(keyed_get(&door, &keyed(&f.trade, "svc-ledger")), 401);
    let once = keyed(&f.trade, "svc-matching");
    assert_eq!(keyed_get(&door, &once), 200);
    assert_eq!(keyed_get(&door, &once), 401);
}
