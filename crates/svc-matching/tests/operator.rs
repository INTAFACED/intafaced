//! The `operator` slice's doors, proven with the TypeScript's own tests ported test for test (all under
//! `services/svc-matching/src/`): `operator-desk.router.test.ts`, `operator-desk.edge-public-key.test.ts`, and the
//! founder door's test in `rulebook-doors.router.test.ts` (its other tests are the `venue` slice's, in
//! `tests/venue_doors.rs`). Each test is named after the TypeScript `it` it ports, prefixed with its file's topic. Each
//! request carries an edge-signed principal, as the TypeScript signs it (`signPrincipalHeader`, or
//! `signPrincipalHeaderEd25519` over `encodeForwardedPrincipal`), and goes to one `MatchingDoor`, as `app.inject`
//! sends it to one Fastify app.
//!
//! Where the port differs from what a TypeScript file tests, and why:
//!
//! - `operator-desk.router.test.ts` issues a real bearer JWT to show the door no longer believes one. The door reads
//!   no `authorization` header at all and holds no JWT secret, so any bearer stands for it here.
//! - Its compose test pins the service's block in `docker-compose.apps.yml` (no `JWT_ACCESS_SECRET`, the
//!   `*edge-secret` anchor merged): `boot.rs` holds it.
//! - `operator-desk.edge-public-key.test.ts`'s boot refusal (a public key with no limits) is `EdgeKey::from_env`'s,
//!   which `main.rs` calls on `EDGE_PRINCIPAL_PUBLIC_KEY`; it is asserted on that call.
//!
//! Beside them, three tests the TypeScript has no file for: the live read names the halted markets and the venue
//! halt, a refused approval keeps nothing under its key, and the venue brakes ignore a market the body names.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ed25519_dalek::{Signer as _, SigningKey};
use service_kit::approvals::{ConsumeInput, Consumed};
use service_kit::edge::{self, EdgeKey, Limits};
use service_kit::json::{self, Json};
use service_kit::s2s_verify::BodyBind;
use service_kit::server::Request;
use service_kit::time::{Instant, v8_date_parse};
use svc_matching::approval::{Approvals, Refused, Stub};
use svc_matching::door::{DoorConfig, MatchingDoor, Outcome};
use svc_matching::engine::venue::{Switch, SwitchCmd};
use svc_matching::engine::{EngineParts, MatchingEngine, MemoryEventBus};
use svc_matching::journal::io::MemoryJournal;
use svc_matching::journal::replay::MemorySnapshotSink;

const SECRET: &str = "matching-operator-desk-secret-32ch";
const EDGE_SECRET: &str = "edge-principal-secret-at-least-32-characters";
const WRONG_SECRET: &str = "wrong-edge-principal-secret-32-characters-xx";
const REGION: &str = "XX";
const MARKET: &str = "BTC-USDT";
const OPERATOR: &str = "11111111-1111-4111-8111-111111111111";
const CONFIRM: &str = "44444444-4444-4444-8444-444444444444";
const LIMITS: Limits = Limits {
    max_lifetime_seconds: 120,
    clock_skew_seconds: 10,
};

fn now() -> i64 {
    v8_date_parse("2026-11-19T00:00:00.000Z").unwrap()
}

fn iso(ms: i64) -> String {
    Instant(ms).iso()
}

// ── the approval and the door ───────────────────────────────────────────

/// `counting(stubApprovalConsumer(CONFIRM, OPERATOR))`, or one that refuses every consume.
struct Counting {
    inner: Option<Stub>,
    calls: Arc<AtomicUsize>,
}

impl Approvals for Counting {
    fn consume(&self, input: &ConsumeInput<'_>) -> Result<Consumed, Refused> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        match &self.inner {
            Some(stub) => stub.consume(input),
            None => Err(Refused::Coded {
                code: "action_approval.consumed".to_owned(),
                message: "the approval was already used".to_owned(),
            }),
        }
    }
}

struct Mounted {
    door: MatchingDoor,
    calls: Arc<AtomicUsize>,
}

impl Mounted {
    fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }

    fn halted(&self, market: &str) -> bool {
        self.door.engine().flags(market).halted
    }

    fn venue_halted(&self) -> bool {
        self.door.engine().flags(MARKET).venue_halted
    }
}

struct Options {
    edge_secret: Option<&'static str>,
    edge_key: Option<EdgeKey>,
    refuse: bool,
}

const SECRET_ONLY: Options = Options {
    edge_secret: Some(EDGE_SECRET),
    edge_key: None,
    refuse: false,
};

fn mount(o: Options) -> Mounted {
    let engine = MatchingEngine::new(EngineParts {
        journal: Box::new(MemoryJournal::new()),
        bus: Box::new(MemoryEventBus::default()),
        clock: now,
        expiry_clock: false,
        snapshot_every: 0,
        sink: Box::new(MemorySnapshotSink::default()),
        enabled: true,
        spread_fills: true,
    });
    let calls = Arc::new(AtomicUsize::new(0));
    let door = MatchingDoor::new(
        DoorConfig {
            internal_secret: SECRET.to_owned(),
            body_bind: BodyBind::Require,
            keys: None,
            edge_secret: o.edge_secret.map(str::to_owned),
            edge_key: o.edge_key,
            clock: now,
            approvals: Box::new(Counting {
                inner: (!o.refuse).then(|| Stub {
                    approver_id: CONFIRM.to_owned(),
                    requester_id: OPERATOR.to_owned(),
                }),
                calls: calls.clone(),
            }),
            operator_ids: vec![OPERATOR.to_owned(), CONFIRM.to_owned()],
        },
        engine,
    )
    .unwrap();
    Mounted { door, calls }
}

// ── the principal ───────────────────────────────────────────────────────

/// `encodePrincipal(principalOf(scopes, mfa))`, expiring a minute from now; with `iat` when it is forwarded.
fn principal(scopes: &[&str], mfa: bool, iat: Option<i64>, lifetime_ms: i64) -> String {
    let mut fields = vec![
        ("sub".to_owned(), Json::str(OPERATOR)),
        (
            "scopes".to_owned(),
            Json::Array(scopes.iter().map(|s| Json::str(*s)).collect()),
        ),
        ("tier".to_owned(), Json::str("institutional")),
        ("mfa".to_owned(), Json::Bool(mfa)),
        (
            "sid".to_owned(),
            Json::str("22222222-2222-4222-8222-222222222222"),
        ),
        ("userId".to_owned(), Json::str(OPERATOR)),
        ("expiresAt".to_owned(), Json::str(iso(now() + lifetime_ms))),
    ];
    if let Some(iat) = iat {
        fields.push(("iat".to_owned(), Json::int(iat)));
    }
    Json::Object(fields).compact()
}

fn headers_of(raw: String, sig: String) -> Vec<(String, String)> {
    vec![
        ("x-intafaced-principal".to_owned(), raw),
        ("x-intafaced-principal-sig".to_owned(), sig),
        ("x-intafaced-region".to_owned(), REGION.to_owned()),
    ]
}

/// `edgeHeaders(scopes, mfa, secret)`: the shared-secret form.
fn edge_headers(scopes: &[&str], mfa: bool, secret: &str) -> Vec<(String, String)> {
    let raw = principal(scopes, mfa, None, 60_000);
    let sig = edge::sign(&raw, secret, REGION).unwrap();
    headers_of(raw, sig)
}

fn writer() -> Vec<(String, String)> {
    edge_headers(&["admin:write"], true, EDGE_SECRET)
}

fn reader() -> Vec<(String, String)> {
    edge_headers(&["admin:read"], false, EDGE_SECRET)
}

/// `signPrincipalHeaderEd25519(raw, privateKey, REGION)`.
fn ed25519_sign(raw: &str, key: &SigningKey) -> String {
    let sig = key.sign(format!("intafaced-principal-v2\n{raw}\nregion={REGION}").as_bytes());
    format!("ed25519:{}", URL_SAFE_NO_PAD.encode(sig.to_bytes()))
}

/// `encodeForwardedPrincipal(reader(), maxLifetimeSeconds)`, signed with this key.
fn forwarded(key: &SigningKey, lifetime_ms: i64) -> Vec<(String, String)> {
    let raw = principal(&["admin:read"], false, Some(now() / 1000), lifetime_ms);
    let sig = ed25519_sign(&raw, key);
    headers_of(raw, sig)
}

fn key_pair(seed: u8) -> (SigningKey, EdgeKey) {
    let signing = SigningKey::from_bytes(&[seed; 32]);
    let public = URL_SAFE_NO_PAD.encode(signing.verifying_key().as_bytes());
    let key = EdgeKey::from_env("svc-matching", &public, Some(120), Some(10)).unwrap();
    assert_eq!(key.limits, LIMITS);
    (signing, key)
}

// ── requests ────────────────────────────────────────────────────────────

fn send(
    m: &Mounted,
    method: &str,
    url: &str,
    headers: Vec<(String, String)>,
    body: Option<&Json>,
) -> (u16, Json) {
    let payload = body.map(Json::compact).unwrap_or_default();
    let mut headers = headers;
    if body.is_some() {
        headers.push(("content-type".to_owned(), "application/json".to_owned()));
    }
    match m.door.decide(&Request {
        method,
        url,
        headers: &headers,
        body: &payload,
    }) {
        Outcome::Answer(r) => (r.status, json::parse(&r.body).unwrap()),
        Outcome::Owed(slice) => panic!("{method} {url} is owed by {}", slice.name()),
    }
}

fn post(m: &Mounted, url: &str, headers: Vec<(String, String)>, body: &Json) -> (u16, Json) {
    send(m, "POST", url, headers, Some(body))
}

fn in_flight(m: &Mounted, headers: Vec<(String, String)>) -> (u16, Json) {
    send(m, "GET", "/operator/in-flight", headers, None)
}

/// `haltBody(over)`.
fn halt_body(over: &[(&str, Json)]) -> Json {
    let mut fields: Vec<(String, Json)> = vec![
        ("marketId".to_owned(), Json::str(MARKET)),
        ("approvalId".to_owned(), Json::str("appr-1")),
        ("operationId".to_owned(), Json::str("op-1")),
        ("idempotencyKey".to_owned(), Json::str("halt-key-01")),
    ];
    for (k, v) in over {
        match fields.iter_mut().find(|(f, _)| f == k) {
            Some(slot) => slot.1 = v.clone(),
            None => fields.push(((*k).to_owned(), v.clone())),
        }
    }
    Json::Object(fields)
}

fn s<'a>(j: &'a Json, k: &str) -> &'a Json {
    j.get(k).unwrap_or(&Json::Null)
}

// ── operator-desk.router.test.ts ────────────────────────────────────────

#[test]
fn desk_refuses_when_the_edge_principal_secret_is_unset_and_does_not_publish_a_book_count() {
    let m = mount(Options {
        edge_secret: None,
        edge_key: None,
        refuse: false,
    });
    let (status, body) = in_flight(&m, Vec::new());
    assert_eq!(status, 503);
    assert_eq!(
        s(&body, "code"),
        &Json::str("matching.operator_auth_unconfigured")
    );
    assert!(!body.compact().contains("restingOrders"));
}

#[test]
fn desk_refuses_a_bearer_jwt_with_admin_write_and_mfa_when_no_edge_principal_is_sent() {
    let m = mount(SECRET_ONLY);
    let (status, body) = post(
        &m,
        "/operator/halt",
        vec![(
            "authorization".to_owned(),
            "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzY29wZXMiOlsiYWRtaW46d3JpdGUiXSwibWZhIjp0cnVlfQ.sig"
                .to_owned(),
        )],
        &halt_body(&[]),
    );
    assert_eq!(status, 401);
    assert_eq!(s(&body, "code"), &Json::str("token.invalid"));
    assert_eq!(m.calls(), 0);
    assert!(!m.halted(MARKET));
}

#[test]
fn desk_reads_the_live_engine_for_an_edge_signed_admin_read_principal() {
    let m = mount(SECRET_ONLY);
    assert!(!m.venue_halted());
    assert_eq!(m.door.engine().resting_order_count(), 0);
    let (status, body) = in_flight(&m, reader());
    assert_eq!(status, 200);
    assert_eq!(s(&body, "venueHalted"), &Json::Bool(false));
    assert_eq!(s(&body, "restingOrders"), &Json::int(0));
    assert_eq!(s(&body, "markets"), &Json::Array(Vec::new()));
}

#[test]
fn desk_refuses_halt_without_admin_write_and_admin_write_without_mfa() {
    let m = mount(SECRET_ONLY);
    let (status, body) = post(
        &m,
        "/operator/halt",
        edge_headers(&["admin:read"], true, EDGE_SECRET),
        &halt_body(&[]),
    );
    assert_eq!(status, 403);
    assert_eq!(s(&body, "code"), &Json::str("scope.denied"));
    let (status, body) = post(
        &m,
        "/operator/halt",
        edge_headers(&["admin:write"], false, EDGE_SECRET),
        &halt_body(&[]),
    );
    assert_eq!(status, 401);
    assert_eq!(s(&body, "code"), &Json::str("mfa.required"));
    assert_eq!(m.calls(), 0);
}

#[test]
fn desk_halts_from_the_principal_user_ignores_a_typed_operator_id_and_replays_without_a_second_consume()
 {
    let m = mount(SECRET_ONLY);
    let (status, first) = post(
        &m,
        "/operator/halt",
        writer(),
        &halt_body(&[("operatorId", Json::str("stranger"))]),
    );
    assert_eq!(status, 200);
    assert_eq!(s(&first, "accepted"), &Json::Bool(true));
    assert_eq!(s(&first, "halted"), &Json::Bool(true));
    assert_eq!(s(&first, "marketId"), &Json::str(MARKET));
    assert_eq!(s(&first, "operatorId"), &Json::str(OPERATOR));
    assert!(m.halted(MARKET));
    let (status, replay) = post(&m, "/operator/halt", writer(), &halt_body(&[]));
    assert_eq!(status, 200);
    assert_eq!(replay, first);
    assert_eq!(m.calls(), 1);
    let (status, conflict) = post(
        &m,
        "/operator/halt",
        writer(),
        &halt_body(&[("marketId", Json::str("ETH-USDT"))]),
    );
    assert_eq!(status, 409);
    assert_eq!(
        s(&conflict, "code"),
        &Json::str("matching.idempotency_conflict")
    );
    assert_eq!(m.calls(), 1);
}

#[test]
fn desk_refuses_a_principal_signed_with_the_wrong_secret_and_does_not_halt() {
    let m = mount(SECRET_ONLY);
    let mut headers = edge_headers(&["admin:write"], true, WRONG_SECRET);
    headers.push(("authorization".to_owned(), "Bearer anything".to_owned()));
    let (status, body) = post(&m, "/operator/halt", headers, &halt_body(&[]));
    assert_eq!(status, 401);
    assert_eq!(s(&body, "code"), &Json::str("token.invalid"));
    assert_eq!(s(&body, "rejected"), &Json::str("bad-signature"));
    assert_eq!(m.calls(), 0);
    assert!(!m.halted(MARKET));
}

// ── operator-desk.edge-public-key.test.ts ───────────────────────────────

fn status_with(
    edge_secret: Option<&'static str>,
    edge_key: Option<EdgeKey>,
    headers: Vec<(String, String)>,
) -> u16 {
    let m = mount(Options {
        edge_secret,
        edge_key,
        refuse: false,
    });
    in_flight(&m, headers).0
}

#[test]
fn edge_key_accepts_an_ed25519_signed_principal_when_the_public_key_and_limits_are_set_with_no_shared_secret()
 {
    let (signing, key) = key_pair(7);
    assert_eq!(
        status_with(None, Some(key), forwarded(&signing, 120_000)),
        200
    );
}

#[test]
fn edge_key_refuses_the_same_header_when_the_public_key_is_unset() {
    let (signing, _) = key_pair(7);
    assert_eq!(
        status_with(Some(EDGE_SECRET), None, forwarded(&signing, 120_000)),
        401
    );
}

#[test]
fn edge_key_refuses_a_header_signed_by_another_key() {
    let (_, key) = key_pair(7);
    let (other, _) = key_pair(9);
    assert_eq!(
        status_with(None, Some(key), forwarded(&other, 120_000)),
        401
    );
}

#[test]
fn edge_key_refuses_a_validly_signed_principal_that_lives_longer_than_the_maximum_lifetime() {
    let (signing, key) = key_pair(7);
    assert_eq!(
        status_with(None, Some(key), forwarded(&signing, 3_600_000)),
        401
    );
}

#[test]
fn edge_key_still_accepts_the_shared_secret_form_with_the_public_key_set() {
    let (_, key) = key_pair(7);
    assert_eq!(status_with(Some(EDGE_SECRET), Some(key), reader()), 200);
}

#[test]
fn edge_key_refuses_to_boot_with_a_public_key_and_no_limits() {
    let (signing, _) = key_pair(7);
    let public = URL_SAFE_NO_PAD.encode(signing.verifying_key().as_bytes());
    let refused = EdgeKey::from_env("svc-matching", &public, None, None).unwrap_err();
    assert!(refused.contains("maxLifetimeSeconds and clockSkewSeconds are required"));
}

// ── rulebook-doors.router.test.ts ───────────────────────────────────────

#[test]
fn rulebook_doors_the_founder_operator_door_halts_too() {
    let m = mount(SECRET_ONLY);
    let (status, body) = post(
        &m,
        "/operator/halt",
        writer(),
        &halt_body(&[
            ("approvalId", Json::str("appr-6")),
            ("operationId", Json::str("op-6")),
            ("idempotencyKey", Json::str("halt-key-06")),
        ]),
    );
    assert_eq!(status, 200);
    assert_eq!(s(&body, "accepted"), &Json::Bool(true));
    assert_eq!(s(&body, "halted"), &Json::Bool(true));
    assert_eq!(s(&body, "rejected"), &Json::Null);
    assert!(m.halted(MARKET));
}

// ── beside them ─────────────────────────────────────────────────────────

#[test]
fn the_live_read_names_each_halted_market_and_the_venue_halt_and_the_brakes_release_them() {
    let m = mount(SECRET_ONLY);
    // `matchingInFlightRead` lists halted markets among the engine's markets: open one so it has a market to list.
    let two = SwitchCmd {
        operator_id: Some(OPERATOR.to_owned()),
        confirm_operator_id: Some(CONFIRM.to_owned()),
        ..SwitchCmd::default()
    };
    for switch in [Switch::Prelaunch, Switch::Open] {
        let opened = m.door.engine().switch(switch, MARKET, &two).unwrap();
        assert!(opened.accepted, "{switch:?}: {:?}", opened.rejected);
    }
    assert_eq!(m.door.engine().markets(), vec![MARKET.to_owned()]);
    let (_, halted) = post(&m, "/operator/halt", writer(), &halt_body(&[]));
    assert_eq!(s(&halted, "accepted"), &Json::Bool(true));
    let (status, read) = in_flight(&m, reader());
    assert_eq!(status, 200);
    assert_eq!(s(&read, "asOf"), &Json::str(iso(now())));
    assert_eq!(s(&read, "halted"), &Json::Array(vec![Json::str(MARKET)]));
    assert_eq!(s(&read, "venueHalted"), &Json::Bool(false));
    for code in ["venueHaltedCode", "marketsCode", "restingOrdersCode"] {
        assert_eq!(s(&read, code), &Json::Null, "{code}");
    }
    let venue = |key: &str, url: &str| {
        let body = Json::obj([
            ("approvalId", Json::str(format!("appr-{key}"))),
            ("operationId", Json::str(format!("op-{key}"))),
            ("idempotencyKey", Json::str(format!("venue-key-{key}"))),
        ]);
        post(&m, url, writer(), &body)
    };
    let (_, all) = venue("2", "/operator/halt-all");
    assert_eq!(
        all.compact(),
        format!(
            r#"{{"accepted":true,"halted":true,"operatorId":"{OPERATOR}","confirmOperatorId":"{CONFIRM}","rejected":null}}"#
        )
    );
    assert_eq!(
        s(&in_flight(&m, reader()).1, "venueHalted"),
        &Json::Bool(true)
    );
    let (_, resumed) = venue("3", "/operator/resume-all");
    assert_eq!(s(&resumed, "halted"), &Json::Bool(false));
    assert!(!m.venue_halted());
    let (_, resumed) = post(
        &m,
        "/operator/resume",
        writer(),
        &halt_body(&[("idempotencyKey", Json::str("resume-key-04"))]),
    );
    assert_eq!(s(&resumed, "halted"), &Json::Bool(false));
    assert_eq!(
        s(&in_flight(&m, reader()).1, "halted"),
        &Json::Array(Vec::new())
    );
}

#[test]
fn a_refused_approval_keeps_nothing_under_its_key_so_a_retry_spends_a_fresh_one() {
    let m = mount(Options {
        refuse: true,
        ..SECRET_ONLY
    });
    for _ in 0..2 {
        let (status, body) = post(&m, "/operator/halt", writer(), &halt_body(&[]));
        assert_eq!(status, 400);
        assert_eq!(s(&body, "code"), &Json::str("action_approval.consumed"));
    }
    assert_eq!(m.calls(), 2);
    assert!(!m.halted(MARKET));
}

#[test]
fn a_venue_brake_ignores_a_market_the_body_names_but_keys_the_request_with_it() {
    let m = mount(SECRET_ONLY);
    let (status, first) = post(&m, "/operator/halt-all", writer(), &halt_body(&[]));
    assert_eq!(status, 200);
    assert!(s(&first, "marketId") == &Json::Null && first.get("marketId").is_none());
    assert!(m.venue_halted());
    assert!(!m.halted(MARKET));
    let (status, _) = post(
        &m,
        "/operator/halt-all",
        writer(),
        &halt_body(&[("marketId", Json::str("ETH-USDT"))]),
    );
    assert_eq!(status, 409);
    assert_eq!(m.calls(), 1);
}
