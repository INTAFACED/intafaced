//! The `venue` slice's doors, proven with the TypeScript's own tests ported test for test (all under
//! `services/svc-matching/src/`): `action-approval-consume.test.ts`, `four-eyes-open.test.ts`, `halt.router.test.ts`,
//! `venue-kill.router.test.ts`, `prelaunch.router.test.ts`, `expire.router.test.ts`, `reduce-only-market.router.test.ts`,
//! `post-only-market.router.test.ts`, `session.router.test.ts`, `cod-fence.router.test.ts`,
//! `surveillance.router.test.ts` and `halt-stress.router.test.ts`. Each test is named after the TypeScript `it` it
//! ports, prefixed with its file's topic. Each request is signed as the TypeScript signs it
//! (`serviceAuthHeadersForBody`, the body-bound v1 signature) and sent to one `MatchingDoor`, as `app.inject` sends it
//! to one Fastify app; an approval consumer is injected the way the TypeScript passes `options.approvals`.
//!
//! Where the port differs from what a TypeScript file tests, and why:
//!
//! - `action-approval-consume.test.ts`'s founder-attestation tests call `consumeMatchingApproval`, a helper no door
//!   calls: every venue door runs `router.ts`'s own `consumeVenueKill`, which checks the approval's action and target
//!   (`action_approval.wrong_action`) and a distinct approver (`action_approval.missing`) before the founder
//!   attestation. Here each case goes through a door, so a mismatched target or action answers `wrong_action` and a
//!   same-person approver `missing`, as `router.ts` 484-501 answers them; the attestation's own refusals stay
//!   `not_founders`. The acting operator must be on `MATCHING_OPERATOR_IDS` to reach the consume at all (`router.ts`
//!   467-472), so each case lists its people.
//! - The identity client's two tests run against `svc_matching::approval::Identity` over a fake `Fetch`; the client
//!   itself is `service_kit::approvals::IdentityClient`, whose own tests (`crates/service-kit/src/approvals.rs`) hold
//!   every reply shape.
//! - `expire.router.test.ts` mounts a bare `MatchingEngine`, without the wrappers `index.ts` installs. Production
//!   installs `rulebook-refuse.ts` (`index.ts` 53), whose `delist` refuses without an owner policy, and the delist door
//!   passes none (`router.ts` 1211). The Rust engine always runs that gate, as production does, so the two delist tests
//!   that expect `accepted: true` assert the production answer: `delist_policy_missing`, nothing journalled, and
//!   submits still taken.
//! - `halt-stress.router.test.ts` calls `engine.restart(marketId)`, a method `halt-law.ts` adds that no door reaches;
//!   the port has no such call. The halt law it holds (a cold start never reopens a halted market) is asserted here
//!   through the remount itself.
//! - `surveillance.router.test.ts`'s `recordOpenSurveillanceCase(engine, ...)` journals an `open_surveillance` record;
//!   the port keeps no such call, so the record is journalled and the engine starts cold on it, as `hydrateFromJournal`
//!   reads it.
//! - Assertions that a constant is its string (`expect(MISSING_OPERATOR).toBe('missing_operator')`) are held by
//!   `svc_matching::engine::venue::MISSING_OPERATOR` and asserted where they appear.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use service_kit::approvals::{ConsumeInput, Consumed, payload_hash};
use service_kit::http::{Fetch, FetchError, HttpRequest, HttpResponse};
use service_kit::json::{self, Json};
use service_kit::money::{Amount, parse_amount};
use service_kit::s2s::{self, SERVICE_HEADER};
use service_kit::s2s_verify::BodyBind;
use service_kit::server::Request;
use sha2::{Digest, Sha256};
use svc_matching::approval::MISSING_OPERATOR;
use svc_matching::approval::{Approvals, Identity, Refused, Stub, UNWIRED, Unwired};
use svc_matching::door::{DoorConfig, MatchingDoor, Outcome};
use svc_matching::engine::{EngineParts, Flags, MatchingEngine, MemoryEventBus};
use svc_matching::env::parse_operator_ids;
use svc_matching::journal::io::{EngineJournal, FileJournal, MemoryJournal};
use svc_matching::journal::record::JournalCommand;
use svc_matching::journal::replay::MemorySnapshotSink;

const SECRET: &str = "matching-venue-doors-router-secret-32ch";
const MARKET: &str = "BTC-USDT";
const OTHER: &str = "ETH-USDT";
const O1: &str = "11111111-1111-4111-8111-111111111111";
const O2: &str = "22222222-2222-4222-8222-222222222222";
const O3: &str = "33333333-3333-4333-8333-333333333333";
const O4: &str = "44444444-4444-4444-8444-444444444444";
const O5: &str = "55555555-5555-4555-8555-555555555555";
const OA: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OB: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OC: &str = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OD: &str = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
/// 2026-08-25T16:00:00.000Z.
const NOW_SECONDS: i64 = 1_787_673_600;

fn now_ms() -> i64 {
    NOW_SECONDS * 1000
}

fn now_s() -> i64 {
    NOW_SECONDS
}

// ── engines and doors ───────────────────────────────────────────────────

fn engine_on(journal: Box<dyn EngineJournal + Send>) -> MatchingEngine {
    MatchingEngine::new(EngineParts {
        journal,
        bus: Box::new(MemoryEventBus::default()),
        clock: now_ms,
        expiry_clock: false,
        snapshot_every: 0,
        sink: Box::new(MemorySnapshotSink::default()),
        enabled: true,
    })
}

fn bare_door(engine: MatchingEngine) -> MatchingDoor {
    venue_door(engine, Box::new(Unwired), Vec::new())
}

/// The door with this approval consumer and operator list.
fn venue_door(
    engine: MatchingEngine,
    approvals: Box<dyn Approvals>,
    operator_ids: Vec<String>,
) -> MatchingDoor {
    MatchingDoor::new(
        DoorConfig {
            internal_secret: SECRET.to_owned(),
            body_bind: BodyBind::Require,
            keys: None,
            edge_secret: None,
            edge_key: None,
            clock: now_ms,
            approvals,
            operator_ids,
        },
        engine,
    )
    .unwrap()
}

/// `registerRoutes(app, engine, SECRET, { bodyBind: 'require', approvals, operatorIds })`.
fn door_with(approvals: Box<dyn Approvals>, operators: &str) -> MatchingDoor {
    venue_door(
        engine_on(Box::new(MemoryJournal::new())),
        approvals,
        parse_operator_ids(Some(operators)),
    )
}

fn stub() -> Box<dyn Approvals> {
    Box::new(Stub {
        approver_id: "ops-confirm".to_owned(),
        requester_id: "ops-1".to_owned(),
    })
}

/// The mount most files use: `stubApprovalConsumer('ops-confirm')`, `operatorIds: ['ops-1', 'ops-confirm']`.
fn mount() -> MatchingDoor {
    door_with(stub(), "ops-1, ops-confirm")
}

/// `registerRoutes(app, engine, SECRET, { bodyBind: 'require' })`: the unwired consumer and nobody an operator.
fn mount_plain() -> MatchingDoor {
    bare_door(engine_on(Box::new(MemoryJournal::new())))
}

// ── requests ────────────────────────────────────────────────────────────

struct Answer {
    status: u16,
    body: Json,
}

impl Answer {
    fn get(&self, path: &str) -> &Json {
        let mut at = &self.body;
        for k in path.split('.') {
            at = match (at, k.parse::<usize>()) {
                (Json::Array(a), Ok(i)) => &a[i],
                _ => at
                    .get(k)
                    .unwrap_or_else(|| panic!("{path} in {}", self.body.compact())),
            };
        }
        at
    }

    fn text(&self, path: &str) -> String {
        match self.get(path) {
            Json::String(s) => s.clone(),
            other => panic!("{path} is not text: {}", other.compact()),
        }
    }

    fn flag(&self, path: &str) -> bool {
        match self.get(path) {
            Json::Bool(b) => *b,
            other => panic!("{path} is not a bool: {}", other.compact()),
        }
    }

    fn has(&self, key: &str) -> bool {
        self.body.get(key).is_some()
    }

    fn code(&self) -> String {
        self.text("code")
    }

    fn rejected_code(&self) -> String {
        self.text("rejected.code")
    }

    fn array(&self, path: &str) -> &Vec<Json> {
        match self.get(path) {
            Json::Array(a) => a,
            other => panic!("{path} is not an array: {}", other.compact()),
        }
    }
}

fn send(
    door: &MatchingDoor,
    method: &str,
    url: &str,
    payload: &str,
    headers: &[(String, String)],
) -> Answer {
    match door.decide(&Request {
        method,
        url,
        headers,
        body: payload,
    }) {
        Outcome::Answer(r) => Answer {
            status: r.status,
            body: json::parse(&r.body).unwrap_or_else(|_| panic!("{} is JSON", r.body)),
        },
        Outcome::Owed(s) => panic!("{method} {url} is owed by {}", s.name()),
    }
}

fn signed(service: &str, payload: &str) -> Vec<(String, String)> {
    s2s::legacy_headers(service, SECRET, payload, NOW_SECONDS).unwrap()
}

fn post_as(door: &MatchingDoor, url: &str, body: &Json, service: &str) -> Answer {
    let payload = body.compact();
    let mut headers = vec![("content-type".to_owned(), "application/json".to_owned())];
    headers.extend(signed(service, &payload));
    send(door, "POST", url, &payload, &headers)
}

fn post(door: &MatchingDoor, url: &str, body: &Json) -> Answer {
    post_as(door, url, body, "svc-trade")
}

/// A POST with only the content type: no service, no signature.
fn post_unsigned(door: &MatchingDoor, url: &str, body: &Json) -> Answer {
    let headers = vec![("content-type".to_owned(), "application/json".to_owned())];
    send(door, "POST", url, &body.compact(), &headers)
}

fn del(door: &MatchingDoor, url: &str) -> Answer {
    send(door, "DELETE", url, "", &signed("svc-trade", ""))
}

fn get(door: &MatchingDoor, url: &str) -> Answer {
    send(door, "GET", url, "", &[])
}

fn signed_get(door: &MatchingDoor, url: &str) -> Answer {
    send(door, "GET", url, "", &signed("svc-trade", ""))
}

// ── bodies ──────────────────────────────────────────────────────────────

fn strs(items: &[&str]) -> Json {
    Json::Array(items.iter().map(|s| Json::str(*s)).collect())
}

/// `createMarketLifecycleAdmissionProof(snapshot, action)`: the snapshot in its schema's key order, hashed as parsed.
fn proof_for(market: &str, action: &str) -> Json {
    let observed = "2026-08-25T16:00:00.000Z";
    let snapshot = Json::obj([
        ("marketId", Json::str(market)),
        ("ruleVersion", Json::str("test.rules.v1")),
        ("instrumentId", Json::str(market)),
        ("instrumentVersion", Json::str("test.instrument.v1")),
        ("state", Json::str("OPEN")),
        ("reasonCategory", Json::str("NORMAL")),
        ("reasonCode", Json::str("trade.lifecycle.ready")),
        ("effectiveAt", Json::str(observed)),
        ("observedAt", Json::str(observed)),
        ("lastGoodState", Json::str("OPEN")),
        ("allowedActions", strs(&["PLACE", "PLACE_POST_ONLY"])),
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
        ("checkedAt", Json::str(observed)),
        (
            "snapshotId",
            Json::str(format!("trade.lifecycle.snapshot:{hex}")),
        ),
        ("transitionId", Json::str("test.transition")),
        ("evidenceRefs", strs(&["test.evidence"])),
        ("snapshot", snapshot),
    ])
}

/// `{ ...base, ...over }`: a key over replaces its place, a new one is appended.
fn merge(base: Json, over: Vec<(&str, Json)>) -> Json {
    let Json::Object(mut fields) = base else {
        panic!("an object")
    };
    for (k, v) in over {
        match fields.iter_mut().find(|(key, _)| key == k) {
            Some(slot) => slot.1 = v,
            None => fields.push((k.to_owned(), v)),
        }
    }
    Json::Object(fields)
}

/// `submitBody(marketId, over)`: a GTC limit sell of 1 at 100 for `desk`.
fn submit_body(market: &str, over: Vec<(&str, Json)>) -> Json {
    merge(
        Json::obj([
            ("orderId", Json::str(OA)),
            ("accountId", Json::str("desk")),
            ("type", Json::str("limit")),
            ("side", Json::str("sell")),
            ("qty", Json::str("1")),
            ("price", Json::str("100")),
            ("tif", Json::str("GTC")),
            ("lifecycleProof", proof_for(market, "PLACE")),
        ]),
        over,
    )
}

fn as_str(j: &Json) -> Option<&str> {
    match j {
        Json::String(s) => Some(s),
        _ => None,
    }
}

fn s(v: &str) -> Json {
    Json::str(v)
}

fn order(door: &MatchingDoor, market: &str, over: Vec<(&str, Json)>) -> Answer {
    post(
        door,
        &format!("/markets/{market}/orders"),
        &submit_body(market, over),
    )
}

/// The operator body with an approval: `{ operatorId, confirmOperatorId, approvalId, operationId }`.
fn approved(operator: &str, confirm: &str) -> Json {
    Json::obj([
        ("operatorId", s(operator)),
        ("confirmOperatorId", s(confirm)),
        ("approvalId", s("appr-1")),
        ("operationId", s("op-1")),
    ])
}

fn kill() -> Json {
    approved("ops-1", "ops-2")
}

fn resume_body() -> Json {
    approved("ops-1", "ops-confirm")
}

fn typed(operator: &str, confirm: Option<&str>) -> Json {
    match confirm {
        Some(c) => Json::obj([("operatorId", s(operator)), ("confirmOperatorId", s(c))]),
        None => Json::obj([("operatorId", s(operator))]),
    }
}

fn empty() -> Json {
    Json::Object(Vec::new())
}

fn market_url(market: &str, door: &str) -> String {
    format!("/markets/{market}/{door}")
}

fn flags(door: &MatchingDoor, market: &str) -> Flags {
    door.engine().flags(market)
}

fn kinds(door: &MatchingDoor) -> Vec<String> {
    door.engine()
        .journal()
        .read()
        .iter()
        .map(|r| r.kind().unwrap_or("").to_owned())
        .collect()
}

fn last_record(door: &MatchingDoor) -> Json {
    door.engine().journal().read().last().unwrap().0.clone()
}

/// A refusal before the engine: 400 with the code and nothing journalled.
fn refused_400(door: &MatchingDoor, a: &Answer, code: &str) {
    assert_eq!(a.status, 400, "{}", a.body.compact());
    assert_eq!(a.code(), code);
    assert!(
        !kinds(door)
            .iter()
            .any(|k| k != "submit" && k != "cancel" && k != "in_flight"),
        "a refused door journals no switch: {:?}",
        kinds(door)
    );
}

// ── approval consumers ──────────────────────────────────────────────────

/// What a consumer was asked, owned.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Asked {
    approval_id: String,
    operation_id: String,
    payload_hash: String,
    target_service: String,
    target_id: String,
    expected_version: String,
    replay: bool,
}

type Seen = Arc<Mutex<Vec<Asked>>>;

/// `echoingApproval(actionType, mutate)`: echoes the request, names `requester` and `approver`, attests both founders
/// unless told otherwise, and records each request.
struct Echo {
    action: String,
    requester: String,
    approver: Option<String>,
    founders: (Option<bool>, Option<bool>),
    target: Option<String>,
    seen: Seen,
}

impl Echo {
    fn new(action: &str) -> Echo {
        Echo {
            action: action.to_owned(),
            requester: "founder-a".to_owned(),
            approver: Some("founder-b".to_owned()),
            founders: (Some(true), Some(true)),
            target: None,
            seen: Arc::default(),
        }
    }
}

impl Approvals for Echo {
    fn consume(&self, input: &ConsumeInput<'_>) -> Result<Consumed, Refused> {
        self.seen.lock().unwrap().push(Asked {
            approval_id: input.approval_id.to_owned(),
            operation_id: input.operation_id.to_owned(),
            payload_hash: input.payload_hash.to_owned(),
            target_service: input.target_service.to_owned(),
            target_id: input.target_id.to_owned(),
            expected_version: input.expected_version.to_owned(),
            replay: input.replay.is_some(),
        });
        Ok(Consumed {
            action_type: self.action.clone(),
            target_service: input.target_service.to_owned(),
            target_id: self
                .target
                .clone()
                .unwrap_or_else(|| input.target_id.to_owned()),
            status: "CONSUMED".to_owned(),
            requester_id: self.requester.clone(),
            approver_id: self.approver.clone(),
            approver_is_founder: self.founders.0,
            requester_is_founder: self.founders.1,
        })
    }
}

/// `sha256:` of `JSON.stringify({ actionType, ...fields })`, computed here rather than by the kit.
fn expected_hash(payload: &str) -> String {
    let hex: String = Sha256::digest(payload.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    format!("sha256:{hex}")
}

const FOUNDERS: &str = "founder-a, founder-b";

// ── action-approval-consume.test.ts ─────────────────────────────────────

#[test]
fn approval_payload_hash_is_stable_for_the_same_halt_market() {
    let halt = payload_hash("matching.halt", &[("marketId", MARKET)]);
    assert!(halt.starts_with("sha256:"));
    let hex = &halt["sha256:".len()..];
    assert_eq!(hex.len(), 64);
    assert!(
        hex.chars()
            .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c))
    );
    assert_eq!(halt, payload_hash("matching.halt", &[("marketId", MARKET)]));
    assert_ne!(halt, payload_hash("matching.halt", &[("marketId", OTHER)]));
    assert_ne!(
        payload_hash("matching.halt_all", &[]),
        payload_hash("matching.resume_all", &[])
    );
    assert_eq!(
        halt,
        expected_hash(r#"{"actionType":"matching.halt","marketId":"BTC-USDT"}"#)
    );
}

#[test]
fn approval_the_door_asks_identity_for_exactly_this_action_target_and_version() {
    let echo = Echo::new("matching.halt");
    let seen = echo.seen.clone();
    let door = door_with(Box::new(echo), FOUNDERS);
    let a = post(
        &door,
        &market_url(MARKET, "halt"),
        &approved("founder-a", "ops-2"),
    );
    assert_eq!(a.status, 200, "{}", a.body.compact());
    assert_eq!(
        *seen.lock().unwrap(),
        vec![Asked {
            approval_id: "appr-1".to_owned(),
            operation_id: "op-1".to_owned(),
            payload_hash: expected_hash(r#"{"actionType":"matching.halt","marketId":"BTC-USDT"}"#),
            target_service: "svc-matching".to_owned(),
            target_id: "halt:BTC-USDT".to_owned(),
            expected_version: "1".to_owned(),
            replay: false,
        }]
    );
    let echo = Echo::new("matching.halt_all");
    let seen = echo.seen.clone();
    let door = door_with(Box::new(echo), FOUNDERS);
    let a = post(&door, "/halt-all", &approved("founder-a", "ops-2"));
    assert_eq!(a.status, 200, "{}", a.body.compact());
    let asked = seen.lock().unwrap();
    assert_eq!(asked.len(), 1);
    assert_eq!(asked[0].target_id, "halt_all");
    assert_eq!(
        asked[0].payload_hash,
        expected_hash(r#"{"actionType":"matching.halt_all"}"#)
    );
}

#[test]
fn approval_blank_identity_url_consumer_refuses_instead_of_inventing_a_second_person() {
    let got = Unwired.consume(&ConsumeInput {
        approval_id: "appr-1",
        operation_id: "op-1",
        payload_hash: "sha256:abc",
        target_service: "svc-matching",
        target_id: "halt:BTC-USDT",
        expected_version: "1",
        replay: None,
    });
    match got {
        Err(Refused::Coded { code, .. }) => assert_eq!(code, UNWIRED),
        other => panic!("{other:?}"),
    }
}

#[test]
fn approval_typed_in_names_without_approval_ids_refuse() {
    let echo = Echo::new("matching.halt");
    let seen = echo.seen.clone();
    let door = door_with(Box::new(echo), FOUNDERS);
    let nulls = Json::obj([
        ("operatorId", s("founder-a")),
        ("approvalId", Json::Null),
        ("operationId", Json::Null),
    ]);
    let a = post(&door, &market_url(MARKET, "halt"), &nulls);
    refused_400(&door, &a, "action_approval.missing");
    let blank = Json::obj([
        ("operatorId", s("founder-a")),
        ("approvalId", s("appr-1")),
        ("operationId", s("")),
    ]);
    let a = post(&door, &market_url(MARKET, "halt"), &blank);
    refused_400(&door, &a, "action_approval.missing");
    assert!(a.text("message").contains("typed-in second name"));
    assert!(seen.lock().unwrap().is_empty(), "nothing is consumed");
    assert!(!flags(&door, MARKET).halted);
}

/// A fake identity: one reply, and every request it was sent.
struct FakeIdentity {
    reply: String,
    seen: Mutex<Vec<HttpRequest>>,
}

impl Fetch for FakeIdentity {
    fn fetch(&self, req: &HttpRequest) -> Result<HttpResponse, FetchError> {
        self.seen.lock().unwrap().push(req.clone());
        Ok(HttpResponse {
            status: 200,
            body: self.reply.clone(),
        })
    }
}

fn halt_request(hash: &str) -> ConsumeInput<'_> {
    ConsumeInput {
        approval_id: "appr-1",
        operation_id: "op-1",
        payload_hash: hash,
        target_service: "svc-matching",
        target_id: "halt:BTC-USDT",
        expected_version: "1",
        replay: None,
    }
}

/// The consumed row identity answers, `over` laid on it, wrapped as tRPC's superjson reply.
fn identity_reply(hash: &str, action: &str, over: Vec<(&str, Json)>) -> String {
    let row = merge(
        Json::obj([
            ("approvalId", s("appr-1")),
            ("operationId", s("op-1")),
            ("payloadHash", s(hash)),
            ("targetService", s("svc-matching")),
            ("targetId", s("halt:BTC-USDT")),
            ("expectedVersion", s("1")),
            ("actionType", s(action)),
            ("requesterId", s("requester")),
            ("approverId", s("ops-confirm")),
            ("policyVersion", s("v1")),
            ("createdAt", s("2026-09-09T12:00:00.000Z")),
            ("expiresAt", s("2026-09-09T12:10:00.000Z")),
            ("status", s("CONSUMED")),
        ]),
        over,
    );
    Json::obj([("result", Json::obj([("data", Json::obj([("json", row)]))]))]).compact()
}

fn identity(reply: String) -> (Identity, Arc<FakeIdentity>) {
    let fake = Arc::new(FakeIdentity {
        reply,
        seen: Mutex::new(Vec::new()),
    });
    let client = Identity::new("http://identity.test", &"s".repeat(32), fake.clone(), now_s);
    (client, fake)
}

#[test]
fn approval_the_identity_client_rejects_a_reply_that_is_not_consumed_or_does_not_echo_the_request()
{
    let hash = payload_hash("matching.halt", &[("marketId", MARKET)]);
    for over in [
        vec![("status", s("APPROVED"))],
        vec![("targetId", s("halt:ETH-USDT"))],
        vec![("payloadHash", s("sha256:other"))],
        vec![("approvalId", s("appr-2"))],
    ] {
        let shown = Json::Object(
            over.iter()
                .map(|(k, v)| ((*k).to_owned(), v.clone()))
                .collect(),
        )
        .compact();
        let (client, _) = identity(identity_reply(&hash, "matching.halt", over));
        match client.consume(&halt_request(&hash)) {
            Err(Refused::Coded { code, .. }) => {
                assert_eq!(code, "action_approval.consume_failed", "{shown}");
            }
            other => panic!("{shown}: {other:?}"),
        }
    }
}

#[test]
fn approval_hmac_consume_posts_to_identity_action_approval_consume_as_svc_matching() {
    let hash = payload_hash("matching.halt", &[("marketId", MARKET)]);
    let (client, fake) = identity(identity_reply(&hash, "halt:BTC-USDT", Vec::new()));
    let consumed = client.consume(&halt_request(&hash)).unwrap();
    assert_eq!(consumed.approver_id.as_deref(), Some("ops-confirm"));
    let seen = fake.seen.lock().unwrap();
    assert_eq!(seen.len(), 1);
    assert_eq!(
        seen[0].url,
        "http://identity.test/trpc/actionApproval.consume"
    );
    let service: Vec<&str> = seen[0]
        .headers
        .iter()
        .filter(|(k, _)| k == SERVICE_HEADER)
        .map(|(_, v)| v.as_str())
        .collect();
    assert_eq!(service, vec!["svc-matching"]);
}

#[test]
fn approval_refuses_opening_a_market_when_identity_sends_no_attestation() {
    let mut echo = Echo::new("matching.open");
    echo.founders = (None, None);
    let door = door_with(Box::new(echo), FOUNDERS);
    let a = post(
        &door,
        &market_url(MARKET, "open"),
        &approved("founder-a", "x"),
    );
    refused_400(&door, &a, "action_approval.not_founders");
    assert_eq!(
        a.text("message"),
        "a founder-audience action needs identity to attest that the proposer and the approver are both founders"
    );
    assert!(!door.engine().is_listed(MARKET));
}

#[test]
fn approval_refuses_a_forged_or_mismatched_founder_attestation() {
    let resume = |echo: Echo, operator: &str, operators: &str, code: &str| {
        let door = door_with(Box::new(echo), operators);
        let a = post(
            &door,
            &market_url(MARKET, "resume"),
            &approved(operator, "x"),
        );
        refused_400(&door, &a, code);
        a
    };
    // The approver attested not a founder.
    let mut e = Echo::new("matching.resume");
    e.founders = (Some(false), Some(true));
    let a = resume(e, "founder-a", FOUNDERS, "action_approval.not_founders");
    assert_eq!(
        a.text("message"),
        "the founder attestation does not match a distinct founder pair for this action"
    );
    // The approver is the requester: the door refuses a same-person approval before the attestation.
    let mut e = Echo::new("matching.resume");
    e.requester = "requester".to_owned();
    e.approver = Some(" REQUESTER ".to_owned());
    let a = resume(e, "requester", "requester", "action_approval.missing");
    assert_eq!(a.text("message"), "the approval has no distinct approver");
    // Another target, another action: the door refuses an approval not for itself before the attestation.
    let mut e = Echo::new("matching.resume");
    e.target = Some("halt:BTC-USDT".to_owned());
    let a = resume(e, "founder-a", FOUNDERS, "action_approval.wrong_action");
    assert_eq!(
        a.text("message"),
        "the approval is not for matching.resume on resume:BTC-USDT"
    );
    resume(
        Echo::new("matching.halt"),
        "founder-a",
        FOUNDERS,
        "action_approval.wrong_action",
    );
    // A halt approval bound to the open target.
    let mut e = Echo::new("matching.halt");
    e.founders = (None, None);
    e.target = Some("open:BTC-USDT".to_owned());
    let door = door_with(Box::new(e), FOUNDERS);
    let a = post(
        &door,
        &market_url(MARKET, "halt"),
        &approved("founder-a", "x"),
    );
    refused_400(&door, &a, "action_approval.wrong_action");
    assert!(!flags(&door, MARKET).halted);
}

#[test]
fn approval_accepts_a_distinct_founder_pair_for_opening_a_market() {
    let door = door_with(Box::new(Echo::new("matching.open")), FOUNDERS);
    let a = post(
        &door,
        &market_url(MARKET, "open"),
        &approved("founder-a", "typed"),
    );
    assert_eq!(a.status, 200, "{}", a.body.compact());
    assert_eq!(
        a.body.compact(),
        r#"{"accepted":true,"marketId":"BTC-USDT","prelaunch":false,"operatorId":"founder-a","confirmOperatorId":"founder-b","rejected":null}"#
    );
    assert!(door.engine().is_listed(MARKET));
    let record = last_record(&door);
    assert_eq!(record.get("kind"), Some(&s("open")));
    assert_eq!(record.get("operatorId"), Some(&s("founder-a")));
    assert_eq!(record.get("confirmOperatorId"), Some(&s("founder-b")));
}

#[test]
fn approval_refuses_an_approval_another_person_proposed_the_acting_operator_must_be_the_recorded_requester()
 {
    let operators = "founder-a, founder-b, founder-x";
    let door = door_with(Box::new(Echo::new("matching.open")), operators);
    let a = post(
        &door,
        &market_url(MARKET, "open"),
        &approved("founder-x", "x"),
    );
    refused_400(&door, &a, "action_approval.operator_not_requester");
    assert!(!door.engine().is_listed(MARKET));
    // Case and spacing are not a different person.
    let a = post(
        &door,
        &market_url(MARKET, "open"),
        &approved(" FOUNDER-A ", "x"),
    );
    assert_eq!(a.status, 200, "{}", a.body.compact());
    assert!(a.flag("accepted"));
    assert_eq!(a.text("operatorId"), "founder-a");
    assert_eq!(last_record(&door).get("operatorId"), Some(&s("founder-a")));
}

#[test]
fn approval_leaves_halt_halt_all_reduce_only_and_post_only_working_without_an_attestation() {
    for (action, url, field) in [
        ("matching.halt", market_url(MARKET, "halt"), "halted"),
        ("matching.halt_all", "/halt-all".to_owned(), "halted"),
        (
            "matching.reduce_only",
            market_url(MARKET, "reduce-only"),
            "reduceOnly",
        ),
        (
            "matching.post_only",
            market_url(MARKET, "post-only"),
            "postOnly",
        ),
    ] {
        let mut e = Echo::new(action);
        e.founders = (None, None);
        let door = door_with(Box::new(e), FOUNDERS);
        let a = post(&door, &url, &approved("founder-a", "x"));
        assert_eq!(a.status, 200, "{action}: {}", a.body.compact());
        assert!(a.flag("accepted"), "{action}");
        assert!(a.flag(field), "{action}");
        assert_eq!(a.text("confirmOperatorId"), "founder-b", "{action}");
    }
}

// ── four-eyes-open.test.ts ──────────────────────────────────────────────

fn four_eyes() -> MatchingDoor {
    door_with(stub(), "ops-1, ops-confirm")
}

#[test]
fn four_eyes_refuses_halt_when_two_different_names_are_typed_and_no_approval_id_is_present() {
    let door = four_eyes();
    let a = post(
        &door,
        &market_url(MARKET, "halt"),
        &typed("ops-1", Some("ops-2")),
    );
    refused_400(&door, &a, "action_approval.missing");
    assert!(!flags(&door, MARKET).halted);
}

#[test]
fn four_eyes_refuses_open_when_two_different_names_are_typed_and_no_approval_id_is_present() {
    let door = four_eyes();
    let a = post(
        &door,
        &market_url(MARKET, "open"),
        &typed("ops-1", Some("ops-2")),
    );
    refused_400(&door, &a, "action_approval.missing");
    assert!(!door.engine().is_listed(MARKET));
}

#[test]
fn four_eyes_refuses_open_when_the_consumed_approval_is_the_same_person_who_proposed_it() {
    let mut same = Echo::new("matching.open");
    same.requester = "ops-1".to_owned();
    same.approver = Some("ops-1".to_owned());
    let door = door_with(Box::new(same), "ops-1, ops-confirm");
    let a = post(&door, &market_url(MARKET, "open"), &kill());
    // The distinct-approver check runs before the founder attestation.
    refused_400(&door, &a, "action_approval.missing");
    assert!(!door.engine().is_listed(MARKET));
}

#[test]
fn four_eyes_opens_the_book_when_a_different_person_approved_it() {
    let door = four_eyes();
    let a = post(&door, &market_url(MARKET, "open"), &kill());
    assert_eq!(a.status, 200);
    assert_eq!(
        a.body.compact(),
        r#"{"accepted":true,"marketId":"BTC-USDT","prelaunch":false,"operatorId":"ops-1","confirmOperatorId":"ops-confirm","rejected":null}"#
    );
    assert!(door.engine().is_listed(MARKET));
}

// ── halt.router.test.ts ─────────────────────────────────────────────────

#[test]
fn halt_http_halt_without_confirm_refuses_no_invented_second_operator() {
    let door = mount();
    let rest = order(&door, MARKET, vec![("orderId", s(O1))]);
    assert_eq!(rest.status, 200);
    assert!(rest.flag("accepted"));
    let a = post(&door, &market_url(MARKET, "halt"), &typed("ops-1", None));
    refused_400(&door, &a, "action_approval.missing");
    assert!(!flags(&door, MARKET).halted);
    let still = order(&door, MARKET, vec![("orderId", s(O2))]);
    assert_eq!(still.status, 200);
    assert!(still.flag("accepted"));
}

#[test]
fn halt_same_operator_confirm_refuses_no_invented_second_caller() {
    let door = mount();
    let a = post(
        &door,
        &market_url(MARKET, "halt"),
        &typed("ops-1", Some("ops-1")),
    );
    refused_400(&door, &a, "action_approval.missing");
    assert!(!flags(&door, MARKET).halted);
}

#[test]
fn halt_halts_one_market_so_new_submits_refuse_and_another_market_still_takes() {
    let door = mount();
    assert!(order(&door, MARKET, vec![("orderId", s(O1))]).flag("accepted"));
    let a = post(&door, &market_url(MARKET, "halt"), &kill());
    assert_eq!(a.status, 200);
    assert_eq!(
        a.body.compact(),
        r#"{"accepted":true,"marketId":"BTC-USDT","halted":true,"operatorId":"ops-1","confirmOperatorId":"ops-confirm","rejected":null}"#
    );
    assert!(!a.has("duration") && !a.has("slo"));
    let record = last_record(&door);
    assert_eq!(
        record.compact(),
        Json::obj([
            ("kind", s("halt")),
            ("marketId", s(MARKET)),
            ("at", s("2026-08-25T16:00:00.000Z")),
            ("operatorId", s("ops-1")),
            ("confirmOperatorId", s("ops-confirm")),
        ])
        .with_seq_of(&record)
        .compact()
    );
    let refused = order(&door, MARKET, vec![("orderId", s(O2))]);
    assert_eq!(refused.status, 200);
    assert!(!refused.flag("accepted"));
    assert_eq!(refused.rejected_code(), "market_halted");
    let other = order(&door, OTHER, vec![("orderId", s(O3))]);
    assert_eq!(other.status, 200);
    assert!(other.flag("accepted"));
}

/// The journal stamps each record with its `seq`; a test's expected record takes the one the journal gave.
trait WithSeq {
    fn with_seq_of(self, record: &Json) -> Json;
}

impl WithSeq for Json {
    fn with_seq_of(self, record: &Json) -> Json {
        match record.get("seq") {
            Some(seq) => merge(self, vec![("seq", seq.clone())]),
            None => self,
        }
    }
}

#[test]
fn halt_still_cancels_on_a_halted_market() {
    let door = mount();
    order(&door, MARKET, vec![("orderId", s(O1))]);
    assert!(post(&door, &market_url(MARKET, "halt"), &kill()).flag("accepted"));
    let c = del(&door, &format!("/markets/{MARKET}/orders/{O1}"));
    assert_eq!(c.status, 200);
    assert!(c.flag("cancelled"));
}

#[test]
fn halt_get_depth_and_get_markets_name_halt_so_a_public_ladder_cannot_look_tradable() {
    let door = mount();
    order(&door, MARKET, vec![("orderId", s(O1))]);
    post(&door, &market_url(MARKET, "halt"), &kill());
    let depth = get(&door, &format!("/markets/{MARKET}/depth?limit=50"));
    assert_eq!(depth.status, 200);
    assert_eq!(depth.text("marketId"), MARKET);
    assert!(depth.flag("halted"));
    for f in ["prelaunch", "expired", "delisted", "venueHalted"] {
        assert!(!depth.flag(f), "{f}");
    }
    let listed = get(&door, "/markets");
    assert!(!listed.flag("venueHalted"));
    assert_eq!(listed.get("halted"), &strs(&[MARKET]));
    for f in ["prelaunch", "expired", "delisted"] {
        assert_eq!(listed.get(f), &strs(&[]), "{f}");
    }
}

#[test]
fn halt_get_depth_and_get_markets_name_reduce_only_and_post_only_and_leave_a_market_in_neither_mode_off_both()
 {
    let door = mount();
    let open = "SOL-USDT";
    order(&door, MARKET, vec![("orderId", s(O1))]);
    order(&door, OTHER, vec![("orderId", s(O2))]);
    order(&door, open, vec![("orderId", s(O3))]);
    let reduce = post(&door, &market_url(MARKET, "reduce-only"), &kill());
    assert_eq!(reduce.status, 200);
    assert!(reduce.flag("accepted"));
    let po = post(
        &door,
        &market_url(OTHER, "post-only"),
        &Json::obj([
            ("operatorId", s("ops-1")),
            ("confirmOperatorId", s("ops-2")),
            ("approvalId", s("appr-2")),
            ("operationId", s("op-2")),
        ]),
    );
    assert_eq!(po.status, 200);
    assert!(po.flag("accepted"));

    let d = get(&door, &format!("/markets/{MARKET}/depth?limit=50"));
    assert_eq!(d.status, 200);
    assert_eq!(d.text("marketId"), MARKET);
    assert!(d.flag("reduceOnly"));
    for f in [
        "postOnly",
        "halted",
        "prelaunch",
        "expired",
        "delisted",
        "venueHalted",
    ] {
        assert!(!d.flag(f), "{f}");
    }
    let l3 = get(&door, &format!("/markets/{MARKET}/depth/l3?limit=50"));
    assert_eq!(l3.status, 200);
    assert_eq!(l3.text("marketId"), MARKET);
    assert!(l3.flag("reduceOnly") && !l3.flag("postOnly"));

    let d = get(&door, &format!("/markets/{OTHER}/depth?limit=50"));
    assert_eq!(d.status, 200);
    assert_eq!(d.text("marketId"), OTHER);
    assert!(
        !d.flag("reduceOnly") && d.flag("postOnly") && !d.flag("halted") && !d.flag("venueHalted")
    );
    let l3 = get(&door, &format!("/markets/{OTHER}/depth/l3?limit=50"));
    assert_eq!(l3.status, 200);
    assert!(!l3.flag("reduceOnly") && l3.flag("postOnly"));

    let d = get(&door, &format!("/markets/{open}/depth?limit=50"));
    assert_eq!(d.status, 200);
    assert_eq!(d.text("marketId"), open);
    assert!(!d.flag("reduceOnly") && !d.flag("postOnly"));
    let l3 = get(&door, &format!("/markets/{open}/depth/l3?limit=50"));
    assert_eq!(l3.status, 200);
    assert!(!l3.flag("reduceOnly") && !l3.flag("postOnly"));

    let listed = get(&door, "/markets");
    assert_eq!(listed.status, 200);
    assert!(!listed.flag("venueHalted"));
    for f in ["halted", "prelaunch", "expired", "delisted"] {
        assert_eq!(listed.get(f), &strs(&[]), "{f}");
    }
    assert_eq!(listed.get("reduceOnly"), &strs(&[MARKET]));
    assert_eq!(listed.get("postOnly"), &strs(&[OTHER]));
    let markets: BTreeSet<String> = listed
        .array("markets")
        .iter()
        .map(|m| as_str(m).unwrap().to_owned())
        .collect();
    for m in [MARKET, OTHER, open] {
        assert!(markets.contains(m), "{m}");
    }
}

#[test]
fn halt_missing_operator_is_400_no_invented_caller() {
    let door = mount();
    let a = post(&door, &market_url(MARKET, "halt"), &empty());
    refused_400(&door, &a, "BadRequest");
    assert!(!flags(&door, MARKET).halted);
}

#[test]
fn halt_unsigned_caller_is_401() {
    let door = mount();
    let a = post_unsigned(&door, &market_url(MARKET, "halt"), &typed("ops-1", None));
    assert_eq!(a.status, 401);
}

#[test]
fn halt_ids_without_identity_consume_refuse_unwired_no_invented_second_person() {
    let door = door_with(Box::new(Unwired), "ops-1");
    let a = post(
        &door,
        &market_url(MARKET, "halt"),
        &Json::obj([
            ("operatorId", s("ops-1")),
            ("approvalId", s("appr-1")),
            ("operationId", s("op-1")),
        ]),
    );
    refused_400(&door, &a, "action_approval.identity_unwired");
    assert_eq!(
        a.text("message"),
        "IDENTITY_URL is unpublished; matching halt does not invent a second person"
    );
    assert!(!flags(&door, MARKET).halted);
}

#[test]
fn halt_resume_reopens_submits_only_after_the_explicit_resume_door() {
    let door = mount();
    post(&door, &market_url(MARKET, "halt"), &kill());
    assert!(!order(&door, MARKET, vec![("orderId", s(O1))]).flag("accepted"));
    let a = post(&door, &market_url(MARKET, "resume"), &resume_body());
    assert_eq!(a.status, 200);
    assert_eq!(
        a.body.compact(),
        r#"{"accepted":true,"marketId":"BTC-USDT","halted":false,"operatorId":"ops-1","confirmOperatorId":"ops-confirm","rejected":null}"#
    );
    assert_eq!(kinds(&door), vec!["halt", "resume"]);
    let open = order(&door, MARKET, vec![("orderId", s(O2))]);
    assert_eq!(open.status, 200);
    assert!(open.flag("accepted"));
}

#[test]
fn halt_resume_http_resume_without_confirm_refuses_and_leaves_the_halt() {
    let door = mount();
    post(&door, &market_url(MARKET, "halt"), &kill());
    let a = post(&door, &market_url(MARKET, "resume"), &typed("ops-2", None));
    assert_eq!(a.status, 400);
    assert_eq!(a.code(), "action_approval.missing");
    assert!(flags(&door, MARKET).halted);
    assert_eq!(kinds(&door), vec!["halt"]);
}

#[test]
fn halt_resume_missing_operator_on_resume_is_400_and_leaves_the_halt() {
    let door = mount();
    post(&door, &market_url(MARKET, "halt"), &kill());
    let a = post(&door, &market_url(MARKET, "resume"), &empty());
    assert_eq!(a.status, 400);
    assert_eq!(a.code(), "BadRequest");
    assert!(flags(&door, MARKET).halted);
    assert_eq!(MISSING_OPERATOR, "missing_operator");
}

// ── venue-kill.router.test.ts ───────────────────────────────────────────

#[test]
fn venue_kill_http_halt_all_without_confirm_refuses_no_invented_second_operator() {
    let door = mount();
    let rest = order(&door, MARKET, vec![("orderId", s(O1))]);
    assert_eq!(rest.status, 200);
    assert!(rest.flag("accepted"));
    let a = post(&door, "/halt-all", &typed("ops-1", None));
    refused_400(&door, &a, "action_approval.missing");
    assert!(!flags(&door, MARKET).venue_halted);
    assert!(!a.has("duration") && !a.has("slo") && !a.has("marketId"));
    let still = order(&door, MARKET, vec![("orderId", s(O2))]);
    assert_eq!(still.status, 200);
    assert!(still.flag("accepted"));
}

#[test]
fn venue_kill_http_halt_all_with_two_operators_is_cancel_only_place_refuses_rest_stays_cancel_works()
 {
    let door = mount();
    assert!(order(&door, MARKET, vec![("orderId", s(O1))]).flag("accepted"));
    let a = post(&door, "/halt-all", &kill());
    assert_eq!(a.status, 200);
    assert_eq!(
        a.body.compact(),
        r#"{"accepted":true,"halted":true,"operatorId":"ops-1","confirmOperatorId":"ops-confirm","rejected":null}"#
    );
    assert!(flags(&door, MARKET).venue_halted);
    let record = last_record(&door);
    assert_eq!(record.get("kind"), Some(&s("halt_all")));
    assert_eq!(record.get("marketId"), None);
    assert_eq!(record.get("confirmOperatorId"), Some(&s("ops-confirm")));
    let refused = order(&door, OTHER, vec![("orderId", s(O3))]);
    assert_eq!(refused.status, 200);
    assert!(!refused.flag("accepted"));
    assert_eq!(refused.rejected_code(), "venue_halted");
    let live = door.engine().existing_book(MARKET).unwrap().to_state();
    let first = live.get("asks").and_then(|a| match a {
        Json::Array(levels) => levels.first(),
        _ => None,
    });
    let first_order = first
        .and_then(|l| l.get("orders"))
        .and_then(|o| match o {
            Json::Array(os) => os.first(),
            _ => None,
        })
        .and_then(|o| o.get("orderId"));
    assert_eq!(first_order, Some(&s(O1)));
    let c = del(&door, &format!("/markets/{MARKET}/orders/{O1}"));
    assert_eq!(c.status, 200);
    assert!(c.flag("cancelled"));
}

#[test]
fn venue_kill_same_operator_confirm_refuses_no_invented_second_caller() {
    let door = mount();
    let a = post(&door, "/halt-all", &typed("ops-1", Some("ops-1")));
    refused_400(&door, &a, "action_approval.missing");
    assert!(!flags(&door, MARKET).venue_halted);
}

#[test]
fn venue_kill_still_cancels_on_a_venue_halted_market() {
    let door = mount();
    order(&door, MARKET, vec![("orderId", s(O1))]);
    assert!(post(&door, "/halt-all", &kill()).flag("accepted"));
    let c = del(&door, &format!("/markets/{MARKET}/orders/{O1}"));
    assert_eq!(c.status, 200);
    assert!(c.flag("cancelled"));
}

#[test]
fn venue_kill_missing_operator_is_400_no_invented_caller() {
    let door = mount();
    let a = post(&door, "/halt-all", &empty());
    refused_400(&door, &a, "BadRequest");
    assert!(!flags(&door, MARKET).venue_halted);
}

#[test]
fn venue_kill_unsigned_caller_is_401() {
    let door = mount();
    assert_eq!(
        post_unsigned(&door, "/halt-all", &typed("ops-1", None)).status,
        401
    );
}

#[test]
fn venue_kill_http_resume_all_without_confirm_refuses_and_leaves_the_halt() {
    let door = mount();
    assert!(post(&door, "/halt-all", &kill()).flag("accepted"));
    let blocked = order(&door, MARKET, vec![("orderId", s(O1))]);
    assert!(!blocked.flag("accepted"));
    assert_eq!(blocked.rejected_code(), "venue_halted");
    let a = post(&door, "/resume-all", &typed("ops-2", None));
    assert_eq!(a.status, 400);
    assert_eq!(a.code(), "action_approval.missing");
    assert!(flags(&door, MARKET).venue_halted);
}

#[test]
fn venue_kill_http_resume_all_with_two_operators_reopens_submits() {
    let door = mount();
    assert!(post(&door, "/halt-all", &kill()).flag("accepted"));
    let a = post(&door, "/resume-all", &resume_body());
    assert_eq!(a.status, 200);
    assert_eq!(
        a.body.compact(),
        r#"{"accepted":true,"halted":false,"operatorId":"ops-1","confirmOperatorId":"ops-confirm","rejected":null}"#
    );
    assert_eq!(kinds(&door), vec!["halt_all", "resume_all"]);
    let open = order(&door, MARKET, vec![("orderId", s(O2))]);
    assert_eq!(open.status, 200);
    assert!(open.flag("accepted"));
}

#[test]
fn venue_kill_does_not_clear_one_market_halt() {
    let door = mount();
    post(&door, &market_url(MARKET, "halt"), &kill());
    assert!(post(&door, "/halt-all", &kill()).flag("accepted"));
    assert!(post(&door, "/resume-all", &resume_body()).flag("accepted"));
    let f = flags(&door, MARKET);
    assert!(!f.venue_halted);
    assert!(f.halted);
    let blocked = order(&door, MARKET, vec![("orderId", s(O1))]);
    assert_eq!(blocked.rejected_code(), "market_halted");
    assert!(order(&door, OTHER, vec![("orderId", s(O3))]).flag("accepted"));
}

#[test]
fn venue_kill_missing_operator_on_resume_all_is_400_and_leaves_the_halt() {
    let door = mount();
    assert!(post(&door, "/halt-all", &kill()).flag("accepted"));
    let a = post(&door, "/resume-all", &empty());
    assert_eq!(a.status, 400);
    assert!(flags(&door, MARKET).venue_halted);
    assert_eq!(MISSING_OPERATOR, "missing_operator");
}

// ── prelaunch.router.test.ts ────────────────────────────────────────────

#[test]
fn prelaunch_prelaunches_one_market_so_public_submits_refuse_and_another_market_still_takes() {
    let door = mount();
    let a = post(&door, &market_url(MARKET, "prelaunch"), &kill());
    assert_eq!(a.status, 200);
    assert_eq!(
        a.body.compact(),
        r#"{"accepted":true,"marketId":"BTC-USDT","prelaunch":true,"operatorId":"ops-1","confirmOperatorId":"ops-confirm","rejected":null}"#
    );
    assert!(!a.has("duration") && !a.has("slo"));
    let refused = order(&door, MARKET, vec![("orderId", s(O2))]);
    assert_eq!(refused.status, 200);
    assert!(!refused.flag("accepted"));
    assert_eq!(refused.rejected_code(), "market_prelaunch");
    let other = order(&door, OTHER, vec![("orderId", s(O3))]);
    assert_eq!(other.status, 200);
    assert!(other.flag("accepted"));
}

#[test]
fn prelaunch_cancel_of_nothing_is_404_and_does_not_list_the_market() {
    let door = mount();
    post(&door, &market_url(MARKET, "prelaunch"), &kill());
    let c = del(&door, &format!("/markets/{MARKET}/orders/{O1}"));
    assert_eq!(c.status, 404);
    let listed = get(&door, "/markets");
    assert!(!listed.array("markets").contains(&s(MARKET)));
}

#[test]
fn prelaunch_is_not_halt_halt_still_refuses_as_market_halted_after_open() {
    let door = mount();
    order(&door, MARKET, vec![("orderId", s(O1))]);
    post(&door, &market_url(MARKET, "halt"), &kill());
    post(&door, &market_url(MARKET, "prelaunch"), &kill());
    post(&door, &market_url(MARKET, "open"), &resume_body());
    let refused = order(&door, MARKET, vec![("orderId", s(O2))]);
    assert_eq!(refused.status, 200);
    assert!(!refused.flag("accepted"));
    assert_eq!(refused.rejected_code(), "market_halted");
}

#[test]
fn prelaunch_missing_operator_is_400_no_invented_caller() {
    let door = mount();
    let a = post(&door, &market_url(MARKET, "prelaunch"), &empty());
    refused_400(&door, &a, "BadRequest");
    assert!(!flags(&door, MARKET).prelaunch);
}

#[test]
fn prelaunch_unsigned_caller_is_401() {
    let door = mount();
    assert_eq!(
        post_unsigned(&door, &market_url(MARKET, "prelaunch"), &kill()).status,
        401
    );
}

#[test]
fn prelaunch_open_accepts_public_submits_only_after_the_explicit_open_door() {
    let door = mount();
    post(&door, &market_url(MARKET, "prelaunch"), &kill());
    assert!(!order(&door, MARKET, vec![("orderId", s(O1))]).flag("accepted"));
    let a = post(&door, &market_url(MARKET, "open"), &resume_body());
    assert_eq!(a.status, 200);
    assert_eq!(
        a.body.compact(),
        r#"{"accepted":true,"marketId":"BTC-USDT","prelaunch":false,"operatorId":"ops-1","confirmOperatorId":"ops-confirm","rejected":null}"#
    );
    let live = order(&door, MARKET, vec![("orderId", s(O2))]);
    assert_eq!(live.status, 200);
    assert!(live.flag("accepted"));
}

#[test]
fn prelaunch_open_an_approved_open_lists_the_empty_market_in_get_markets_an_unapproved_open_does_not()
 {
    let door = mount();
    let refused = post(
        &door,
        &market_url(MARKET, "open"),
        &typed("ops-2", Some("ops-2")),
    );
    assert_eq!(refused.status, 400);
    assert!(!get(&door, "/markets").array("markets").contains(&s(MARKET)));
    assert!(post(&door, &market_url(MARKET, "open"), &resume_body()).flag("accepted"));
    let board = get(&door, "/markets");
    assert_eq!(board.get("markets"), &strs(&[MARKET]));
    assert_eq!(board.get("prelaunch"), &strs(&[]));
}

#[test]
fn prelaunch_open_missing_operator_on_open_is_400_and_leaves_prelaunch() {
    let door = mount();
    post(&door, &market_url(MARKET, "prelaunch"), &kill());
    let a = post(&door, &market_url(MARKET, "open"), &empty());
    assert_eq!(a.status, 400);
    assert!(flags(&door, MARKET).prelaunch);
    assert_eq!(MISSING_OPERATOR, "missing_operator");
}

#[test]
fn prelaunch_http_prelaunch_without_confirm_refuses_no_invented_second_operator() {
    let door = mount();
    let a = post(
        &door,
        &market_url(MARKET, "prelaunch"),
        &typed("ops-1", None),
    );
    refused_400(&door, &a, "action_approval.missing");
    assert!(!flags(&door, MARKET).prelaunch);
}

#[test]
fn prelaunch_same_operator_confirm_refuses_prelaunch_and_open() {
    let door = mount();
    let a = post(
        &door,
        &market_url(MARKET, "prelaunch"),
        &typed("ops-1", Some("ops-1")),
    );
    refused_400(&door, &a, "action_approval.missing");
    assert!(!flags(&door, MARKET).prelaunch);
    post(&door, &market_url(MARKET, "prelaunch"), &kill());
    let a = post(
        &door,
        &market_url(MARKET, "open"),
        &typed("ops-2", Some("ops-2")),
    );
    assert_eq!(a.status, 400);
    assert_eq!(a.code(), "action_approval.missing");
    assert!(flags(&door, MARKET).prelaunch);
}

// ── expire.router.test.ts ───────────────────────────────────────────────

#[test]
fn expire_expires_one_market_so_new_submits_refuse_and_another_market_still_takes() {
    let door = mount();
    let rest = order(&door, MARKET, vec![("orderId", s(O1))]);
    assert_eq!(rest.status, 200);
    assert!(rest.flag("accepted"));
    let a = post(&door, &market_url(MARKET, "expire"), &kill());
    assert_eq!(a.status, 200);
    assert_eq!(
        a.body.compact(),
        r#"{"accepted":true,"marketId":"BTC-USDT","expired":true,"operatorId":"ops-1","confirmOperatorId":"ops-confirm","rejected":null}"#
    );
    for k in ["notice", "noticePeriod", "duration", "slo"] {
        assert!(!a.has(k), "{k}");
    }
    let refused = order(&door, MARKET, vec![("orderId", s(O2))]);
    assert_eq!(refused.status, 200);
    assert!(!refused.flag("accepted"));
    assert_eq!(refused.rejected_code(), "market_expired");
    let other = order(&door, OTHER, vec![("orderId", s(O3))]);
    assert_eq!(other.status, 200);
    assert!(other.flag("accepted"));
}

#[test]
fn expire_still_cancels_on_an_expired_market() {
    let door = mount();
    order(&door, MARKET, vec![("orderId", s(O1))]);
    post(&door, &market_url(MARKET, "expire"), &kill());
    let c = del(&door, &format!("/markets/{MARKET}/orders/{O1}"));
    assert_eq!(c.status, 200);
    assert!(c.flag("cancelled"));
}

#[test]
fn expire_is_not_halt_resume_still_refuses_as_market_expired() {
    let door = mount();
    order(&door, MARKET, vec![("orderId", s(O1))]);
    post(&door, &market_url(MARKET, "halt"), &kill());
    post(&door, &market_url(MARKET, "expire"), &kill());
    post(&door, &market_url(MARKET, "resume"), &resume_body());
    let refused = order(&door, MARKET, vec![("orderId", s(O2))]);
    assert!(!refused.flag("accepted"));
    assert_eq!(refused.rejected_code(), "market_expired");
}

#[test]
fn expire_is_not_prelaunch_open_still_refuses_as_market_expired() {
    let door = mount();
    post(&door, &market_url(MARKET, "prelaunch"), &kill());
    post(&door, &market_url(MARKET, "expire"), &kill());
    post(&door, &market_url(MARKET, "open"), &resume_body());
    let refused = order(&door, MARKET, vec![("orderId", s(O2))]);
    assert!(!refused.flag("accepted"));
    assert_eq!(refused.rejected_code(), "market_expired");
}

#[test]
fn expire_missing_operator_is_400_no_invented_caller() {
    let door = mount();
    let a = post(&door, &market_url(MARKET, "expire"), &empty());
    refused_400(&door, &a, "BadRequest");
    assert!(!flags(&door, MARKET).expired);
}

#[test]
fn expire_unsigned_caller_is_401() {
    let door = mount();
    assert_eq!(
        post_unsigned(&door, &market_url(MARKET, "expire"), &kill()).status,
        401
    );
}

/// The delisting as production answers it: `rulebook-refuse.ts` (installed by `index.ts`) refuses a delisting with no
/// owner policy, and the door passes none. The TypeScript test mounts the bare engine and expects `accepted: true`.
fn delist_refused(door: &MatchingDoor) {
    let journalled = kinds(door);
    let a = post(door, &market_url(MARKET, "delist"), &kill());
    assert_eq!(a.status, 200);
    assert_eq!(
        a.body.compact(),
        r#"{"accepted":false,"marketId":"BTC-USDT","delisted":false,"operatorId":"ops-1","confirmOperatorId":"ops-confirm","rejected":{"code":"delist_policy_missing","message":"delist requires an owner policy; the engine does not invent a corporate action"}}"#
    );
    for k in ["notice", "noticePeriod", "duration"] {
        assert!(!a.has(k), "{k}");
    }
    assert_eq!(
        kinds(door),
        journalled,
        "a refused delisting journals nothing"
    );
    assert!(!flags(door, MARKET).delisted);
}

#[test]
fn expire_delists_one_market_so_new_submits_refuse_and_another_market_still_takes() {
    let door = mount();
    assert!(order(&door, MARKET, vec![("orderId", s(O1))]).flag("accepted"));
    delist_refused(&door);
    // Not delisted, so the market still takes; the other market takes as the TypeScript's does.
    let next = order(&door, MARKET, vec![("orderId", s(O2))]);
    assert!(next.flag("accepted"), "{}", next.body.compact());
    assert!(order(&door, OTHER, vec![("orderId", s(O3))]).flag("accepted"));
}

#[test]
fn expire_still_cancels_on_a_delisted_market() {
    let door = mount();
    order(&door, MARKET, vec![("orderId", s(O1))]);
    delist_refused(&door);
    let c = del(&door, &format!("/markets/{MARKET}/orders/{O1}"));
    assert_eq!(c.status, 200);
    assert!(c.flag("cancelled"));
}

#[test]
fn expire_is_not_expire_expire_still_refuses_as_market_expired() {
    let door = mount();
    post(&door, &market_url(MARKET, "expire"), &kill());
    let refused = order(&door, MARKET, vec![("orderId", s(O2))]);
    assert_eq!(refused.rejected_code(), "market_expired");
    assert_ne!(refused.rejected_code(), "market_delisted");
}

#[test]
fn expire_delist_missing_operator_is_400_no_invented_caller() {
    let door = mount();
    let a = post(&door, &market_url(MARKET, "delist"), &empty());
    refused_400(&door, &a, "BadRequest");
    assert!(!flags(&door, MARKET).delisted);
    assert_eq!(MISSING_OPERATOR, "missing_operator");
}

#[test]
fn expire_delist_unsigned_caller_is_401() {
    let door = mount();
    assert_eq!(
        post_unsigned(&door, &market_url(MARKET, "delist"), &kill()).status,
        401
    );
}

#[test]
fn expire_http_expire_without_confirm_refuses_no_invented_second_operator() {
    let door = mount();
    let a = post(&door, &market_url(MARKET, "expire"), &typed("ops-1", None));
    refused_400(&door, &a, "action_approval.missing");
    assert!(!flags(&door, MARKET).expired);
}

#[test]
fn expire_same_operator_confirm_refuses_expire_and_delist() {
    let door = mount();
    let a = post(
        &door,
        &market_url(MARKET, "expire"),
        &typed("ops-1", Some("ops-1")),
    );
    refused_400(&door, &a, "action_approval.missing");
    assert!(!flags(&door, MARKET).expired);
    let a = post(
        &door,
        &market_url(MARKET, "delist"),
        &typed("ops-1", Some("ops-1")),
    );
    refused_400(&door, &a, "action_approval.missing");
    assert!(!flags(&door, MARKET).delisted);
}

// ── reduce-only-market.router.test.ts ───────────────────────────────────

fn reduce_only_book(door: &MatchingDoor) {
    let liq = order(
        door,
        MARKET,
        vec![
            ("orderId", s(O1)),
            ("accountId", s("mm")),
            ("side", s("sell")),
            ("qty", s("2")),
        ],
    );
    assert_eq!(liq.status, 200);
    let open = order(
        door,
        MARKET,
        vec![("orderId", s(O2)), ("side", s("buy")), ("qty", s("2"))],
    );
    assert!(open.flag("accepted"));
}

#[test]
fn reduce_only_makes_one_market_reduce_only_so_opens_refuse_and_another_market_still_takes() {
    let door = mount();
    reduce_only_book(&door);
    let a = post(&door, &market_url(MARKET, "reduce-only"), &kill());
    assert_eq!(a.status, 200);
    assert_eq!(
        a.body.compact(),
        r#"{"accepted":true,"marketId":"BTC-USDT","reduceOnly":true,"operatorId":"ops-1","confirmOperatorId":"ops-confirm","rejected":null}"#
    );
    assert!(!a.has("duration") && !a.has("slo"));
    let refused = order(&door, MARKET, vec![("orderId", s(O3)), ("side", s("buy"))]);
    assert_eq!(refused.status, 200);
    assert!(!refused.flag("accepted"));
    assert_eq!(refused.rejected_code(), "market_reduce_only");
    let reducing = order(
        &door,
        MARKET,
        vec![
            ("orderId", s(O4)),
            ("price", s("101")),
            ("reduceOnly", Json::Bool(true)),
        ],
    );
    assert_eq!(reducing.status, 200);
    assert!(reducing.flag("accepted"), "{}", reducing.body.compact());
    let other = order(&door, OTHER, vec![("orderId", s(O5))]);
    assert_eq!(other.status, 200);
    assert!(other.flag("accepted"));
}

#[test]
fn reduce_only_still_cancels_on_a_reduce_only_market() {
    let door = mount();
    reduce_only_book(&door);
    post(&door, &market_url(MARKET, "reduce-only"), &kill());
    order(
        &door,
        MARKET,
        vec![
            ("orderId", s(O4)),
            ("price", s("101")),
            ("reduceOnly", Json::Bool(true)),
        ],
    );
    let c = del(&door, &format!("/markets/{MARKET}/orders/{O4}"));
    assert_eq!(c.status, 200);
    assert!(c.flag("cancelled"));
}

#[test]
fn reduce_only_still_closes_a_position_on_a_reduce_only_market() {
    let door = mount();
    reduce_only_book(&door);
    order(
        &door,
        MARKET,
        vec![
            ("orderId", s(O3)),
            ("accountId", s("liq")),
            ("side", s("buy")),
            ("qty", s("2")),
        ],
    );
    post(&door, &market_url(MARKET, "reduce-only"), &kill());
    let closed = post(
        &door,
        &market_url(MARKET, "positions/close"),
        &Json::obj([
            ("orderId", s("77777777-7777-4777-8777-777777777777")),
            ("accountId", s("desk")),
            ("lifecycleProof", proof_for(MARKET, "PLACE")),
        ]),
    );
    assert_eq!(closed.status, 200);
    assert!(closed.flag("accepted"), "{}", closed.body.compact());
}

#[test]
fn reduce_only_missing_operator_is_400_no_invented_caller() {
    let door = mount();
    let a = post(&door, &market_url(MARKET, "reduce-only"), &empty());
    refused_400(&door, &a, "BadRequest");
    assert!(!flags(&door, MARKET).reduce_only);
}

#[test]
fn reduce_only_unsigned_caller_is_401() {
    let door = mount();
    assert_eq!(
        post_unsigned(&door, &market_url(MARKET, "reduce-only"), &kill()).status,
        401
    );
}

#[test]
fn reduce_only_resume_reopens_opens_only_after_the_explicit_resume_door() {
    let door = mount();
    post(&door, &market_url(MARKET, "reduce-only"), &kill());
    assert!(!order(&door, MARKET, vec![("orderId", s(O1))]).flag("accepted"));
    let a = post(
        &door,
        &market_url(MARKET, "reduce-only/resume"),
        &resume_body(),
    );
    assert_eq!(a.status, 200);
    assert_eq!(
        a.body.compact(),
        r#"{"accepted":true,"marketId":"BTC-USDT","reduceOnly":false,"operatorId":"ops-1","confirmOperatorId":"ops-confirm","rejected":null}"#
    );
    assert_eq!(kinds(&door), vec!["reduce_only", "resume_reduce_only"]);
    let open = order(&door, MARKET, vec![("orderId", s(O2))]);
    assert_eq!(open.status, 200);
    assert!(open.flag("accepted"));
}

#[test]
fn reduce_only_resume_missing_operator_on_resume_is_400_and_leaves_reduce_only() {
    let door = mount();
    post(&door, &market_url(MARKET, "reduce-only"), &kill());
    let a = post(&door, &market_url(MARKET, "reduce-only/resume"), &empty());
    assert_eq!(a.status, 400);
    assert!(flags(&door, MARKET).reduce_only);
    assert_eq!(MISSING_OPERATOR, "missing_operator");
}

#[test]
fn reduce_only_http_reduce_only_without_confirm_refuses_no_invented_second_operator() {
    let door = mount();
    let a = post(
        &door,
        &market_url(MARKET, "reduce-only"),
        &typed("ops-1", None),
    );
    refused_400(&door, &a, "action_approval.missing");
    assert!(!flags(&door, MARKET).reduce_only);
}

#[test]
fn reduce_only_same_operator_confirm_refuses_reduce_only_and_resume() {
    let door = mount();
    let a = post(
        &door,
        &market_url(MARKET, "reduce-only"),
        &typed("ops-1", Some("ops-1")),
    );
    refused_400(&door, &a, "action_approval.missing");
    assert!(!flags(&door, MARKET).reduce_only);
    post(&door, &market_url(MARKET, "reduce-only"), &kill());
    let a = post(
        &door,
        &market_url(MARKET, "reduce-only/resume"),
        &typed("ops-2", Some("ops-2")),
    );
    assert_eq!(a.status, 400);
    assert_eq!(a.code(), "action_approval.missing");
    assert!(flags(&door, MARKET).reduce_only);
}

// ── post-only-market.router.test.ts ─────────────────────────────────────

fn post_only_order(door: &MatchingDoor, id: &str, price: &str) -> Answer {
    order(
        door,
        MARKET,
        vec![
            ("orderId", s(id)),
            ("side", s("buy")),
            ("price", s(price)),
            ("tif", s("PO")),
            ("lifecycleProof", proof_for(MARKET, "PLACE_POST_ONLY")),
        ],
    )
}

#[test]
fn post_only_makes_one_market_post_only_so_gtc_refuses_po_rests_and_another_market_still_takes() {
    let door = mount();
    let ask = order(
        &door,
        MARKET,
        vec![("orderId", s(O1)), ("accountId", s("mm"))],
    );
    assert_eq!(ask.status, 200);
    assert!(ask.flag("accepted"));
    let a = post(&door, &market_url(MARKET, "post-only"), &kill());
    assert_eq!(a.status, 200);
    assert_eq!(
        a.body.compact(),
        r#"{"accepted":true,"marketId":"BTC-USDT","postOnly":true,"operatorId":"ops-1","confirmOperatorId":"ops-confirm","rejected":null}"#
    );
    assert!(!a.has("duration") && !a.has("slo"));
    let refused = order(
        &door,
        MARKET,
        vec![("orderId", s(O2)), ("side", s("buy")), ("price", s("99"))],
    );
    assert_eq!(refused.status, 200);
    assert!(!refused.flag("accepted"));
    assert_eq!(refused.rejected_code(), "market_post_only");
    let resting = post_only_order(&door, O3, "99");
    assert_eq!(resting.status, 200);
    assert!(resting.flag("accepted"), "{}", resting.body.compact());
    let crossed = post_only_order(&door, O4, "100");
    assert_eq!(crossed.status, 200);
    assert!(!crossed.flag("accepted"));
    assert_eq!(crossed.rejected_code(), "post_only_would_cross");
    let other = order(&door, OTHER, vec![("orderId", s(O5))]);
    assert_eq!(other.status, 200);
    assert!(other.flag("accepted"));
}

#[test]
fn post_only_still_cancels_on_a_post_only_market() {
    let door = mount();
    order(
        &door,
        MARKET,
        vec![("orderId", s(O1)), ("accountId", s("mm"))],
    );
    post(&door, &market_url(MARKET, "post-only"), &kill());
    post_only_order(&door, O3, "99");
    let c = del(&door, &format!("/markets/{MARKET}/orders/{O3}"));
    assert_eq!(c.status, 200);
    assert!(c.flag("cancelled"));
}

#[test]
fn post_only_missing_operator_is_400_no_invented_caller() {
    let door = mount();
    let a = post(&door, &market_url(MARKET, "post-only"), &empty());
    refused_400(&door, &a, "BadRequest");
    assert!(!flags(&door, MARKET).post_only);
}

#[test]
fn post_only_unsigned_caller_is_401() {
    let door = mount();
    assert_eq!(
        post_unsigned(&door, &market_url(MARKET, "post-only"), &kill()).status,
        401
    );
}

#[test]
fn post_only_resume_reopens_non_post_only_submits_only_after_the_explicit_resume_door() {
    let door = mount();
    post(&door, &market_url(MARKET, "post-only"), &kill());
    assert!(!order(&door, MARKET, vec![("orderId", s(O1))]).flag("accepted"));
    let a = post(
        &door,
        &market_url(MARKET, "post-only/resume"),
        &resume_body(),
    );
    assert_eq!(a.status, 200);
    assert_eq!(
        a.body.compact(),
        r#"{"accepted":true,"marketId":"BTC-USDT","postOnly":false,"operatorId":"ops-1","confirmOperatorId":"ops-confirm","rejected":null}"#
    );
    assert_eq!(kinds(&door), vec!["post_only", "resume_post_only"]);
    let open = order(&door, MARKET, vec![("orderId", s(O2))]);
    assert_eq!(open.status, 200);
    assert!(open.flag("accepted"));
}

#[test]
fn post_only_resume_missing_operator_on_resume_is_400_and_leaves_post_only() {
    let door = mount();
    post(&door, &market_url(MARKET, "post-only"), &kill());
    let a = post(&door, &market_url(MARKET, "post-only/resume"), &empty());
    assert_eq!(a.status, 400);
    assert!(flags(&door, MARKET).post_only);
    assert_eq!(MISSING_OPERATOR, "missing_operator");
}

#[test]
fn post_only_http_post_only_without_confirm_refuses_no_invented_second_operator() {
    let door = mount();
    let a = post(
        &door,
        &market_url(MARKET, "post-only"),
        &typed("ops-1", None),
    );
    refused_400(&door, &a, "action_approval.missing");
    assert!(!flags(&door, MARKET).post_only);
}

#[test]
fn post_only_same_operator_confirm_refuses_post_only_and_resume() {
    let door = mount();
    let a = post(
        &door,
        &market_url(MARKET, "post-only"),
        &typed("ops-1", Some("ops-1")),
    );
    refused_400(&door, &a, "action_approval.missing");
    assert!(!flags(&door, MARKET).post_only);
    post(&door, &market_url(MARKET, "post-only"), &kill());
    let a = post(
        &door,
        &market_url(MARKET, "post-only/resume"),
        &typed("ops-2", Some("ops-2")),
    );
    assert_eq!(a.status, 400);
    assert_eq!(a.code(), "action_approval.missing");
    assert!(flags(&door, MARKET).post_only);
}

// ── session.router.test.ts ──────────────────────────────────────────────

fn cancellations(a: &Answer) -> Vec<(String, String)> {
    a.array("cancellations")
        .iter()
        .map(|c| {
            (
                c.get("orderId").and_then(as_str).unwrap().to_owned(),
                c.get("reason").and_then(as_str).unwrap().to_owned(),
            )
        })
        .collect()
}

fn pairs(items: &[(&str, &str)]) -> Vec<(String, String)> {
    items
        .iter()
        .map(|(a, b)| ((*a).to_owned(), (*b).to_owned()))
        .collect()
}

fn session(id: &str) -> Json {
    Json::obj([("sessionId", s(id))])
}

#[test]
fn session_cancels_tagged_rests_and_refuses_a_later_tagged_submit() {
    let door = mount_plain();
    let rest = order(&door, MARKET, vec![("sessionId", s("sess-1"))]);
    assert_eq!(rest.status, 200);
    assert!(rest.flag("accepted"));
    let other = order(
        &door,
        OTHER,
        vec![
            ("orderId", s(OB)),
            ("sessionId", s("sess-1")),
            ("price", s("200")),
        ],
    );
    assert!(other.flag("accepted"));
    let keep = order(
        &door,
        MARKET,
        vec![
            ("orderId", s(OC)),
            ("accountId", s("mm")),
            ("sessionId", s("sess-2")),
            ("price", s("101")),
        ],
    );
    assert!(keep.flag("accepted"));
    let dead = post(&door, "/session/dead", &session("sess-1"));
    assert_eq!(dead.status, 200);
    assert!(dead.flag("accepted"));
    assert_eq!(dead.text("sessionId"), "sess-1");
    assert_eq!(
        cancellations(&dead),
        pairs(&[(OA, "session_dead"), (OB, "session_dead")])
    );
    let record = door
        .engine()
        .journal()
        .read()
        .iter()
        .find(|r| r.kind() == Some("session_dead"))
        .map(|r| r.field("sessionId").cloned());
    assert_eq!(record, Some(Some(s("sess-1"))));
    let later = order(
        &door,
        MARKET,
        vec![
            ("orderId", s(OD)),
            ("sessionId", s("sess-1")),
            ("side", s("buy")),
            ("price", s("100")),
        ],
    );
    assert_eq!(later.status, 200);
    assert!(!later.flag("accepted"));
    assert_eq!(later.rejected_code(), "session_gone");
    assert_eq!(later.get("fills"), &Json::Array(Vec::new()));
}

#[test]
fn session_missing_session_is_400_the_engine_does_not_invent_one() {
    let door = mount_plain();
    let a = post(&door, "/session/dead", &empty());
    assert_eq!(a.status, 400);
    assert_eq!(a.code(), "BadRequest");
    assert!(kinds(&door).is_empty());
}

#[test]
fn session_svc_execution_may_tag_cod_session_id_on_submit_and_fire_session_dead() {
    let door = mount_plain();
    let rest = post_as(
        &door,
        &format!("/markets/{MARKET}/orders"),
        &submit_body(
            MARKET,
            vec![
                ("sessionId", s("sess-exec")),
                ("qty", s("1.25")),
                ("price", s("100.50")),
            ],
        ),
        "svc-execution",
    );
    assert_eq!(rest.status, 200);
    assert!(rest.flag("accepted"));
    assert_eq!(rest.text("resting.remaining"), "1.25");
    let unmapped = post_as(&door, "/session/dead", &session("sess-exec"), "svc-pay");
    assert_eq!(unmapped.status, 403);
    let dead = post_as(
        &door,
        "/session/dead",
        &session("sess-exec"),
        "svc-execution",
    );
    assert_eq!(dead.status, 200);
    assert!(dead.flag("accepted"));
    assert_eq!(dead.text("sessionId"), "sess-exec");
    assert_eq!(cancellations(&dead), pairs(&[(OA, "session_dead")]));
}

/// A POST naming a service but carrying no signature.
fn post_named_unsigned(door: &MatchingDoor, url: &str, body: &Json, service: &str) -> Answer {
    let headers = vec![
        ("content-type".to_owned(), "application/json".to_owned()),
        (SERVICE_HEADER.to_owned(), service.to_owned()),
    ];
    send(door, "POST", url, &body.compact(), &headers)
}

#[test]
fn session_svc_fix_may_tag_cod_session_id_on_submit_and_fire_session_dead() {
    let door = mount_plain();
    let rest = post_as(
        &door,
        &format!("/markets/{MARKET}/orders"),
        &submit_body(
            MARKET,
            vec![
                ("sessionId", s("sess-fix")),
                ("qty", s("1.25")),
                ("price", s("100.50")),
            ],
        ),
        "svc-fix",
    );
    assert_eq!(rest.status, 200);
    assert!(rest.flag("accepted"));
    let unsigned = post_named_unsigned(&door, "/session/dead", &session("sess-fix"), "svc-fix");
    assert_eq!(unsigned.status, 401);
    let dead = post_as(&door, "/session/dead", &session("sess-fix"), "svc-fix");
    assert_eq!(dead.status, 200);
    assert!(dead.flag("accepted"));
    assert_eq!(dead.text("sessionId"), "sess-fix");
    assert_eq!(cancellations(&dead), pairs(&[(OA, "session_dead")]));
}

#[test]
fn session_untagged_rest_stays_when_a_session_dies() {
    let door = mount_plain();
    order(&door, MARKET, Vec::new());
    let dead = post(&door, "/session/dead", &session("sess-1"));
    assert!(dead.flag("accepted"));
    assert_eq!(dead.get("cancellations"), &Json::Array(Vec::new()));
    let depth = get(&door, &format!("/markets/{MARKET}/depth?limit=50"));
    assert_eq!(depth.text("asks.0.1"), "1");
}

// ── cod-fence.router.test.ts ────────────────────────────────────────────

fn cod_body(over: Vec<(&str, Json)>) -> Json {
    let mut all = vec![("qty", s("1.25")), ("price", s("100.50"))];
    all.extend(over);
    submit_body(MARKET, all)
}

#[test]
fn cod_fence_signed_session_dead_cancels_the_tagged_rest_and_later_tagged_submit_is_session_gone() {
    let door = mount();
    let url = format!("/markets/{MARKET}/orders");
    let rest = post_as(
        &door,
        &url,
        &cod_body(vec![("sessionId", s("sess-cod"))]),
        "svc-fix",
    );
    assert_eq!(rest.status, 200);
    assert!(rest.flag("accepted"));
    assert_eq!(rest.text("resting.remaining"), "1.25");
    let dead = post_as(&door, "/session/dead", &session("sess-cod"), "svc-fix");
    assert_eq!(dead.status, 200);
    assert!(dead.flag("accepted"));
    assert_eq!(dead.text("sessionId"), "sess-cod");
    assert_eq!(cancellations(&dead), pairs(&[(OA, "session_dead")]));
    let later = post_as(
        &door,
        &url,
        &cod_body(vec![
            ("orderId", s(OB)),
            ("sessionId", s("sess-cod")),
            ("side", s("buy")),
        ]),
        "svc-fix",
    );
    assert_eq!(later.status, 200);
    assert!(!later.flag("accepted"));
    assert_eq!(later.rejected_code(), "session_gone");
    assert_eq!(later.get("fills"), &Json::Array(Vec::new()));
}

#[test]
fn cod_fence_unsigned_cod_session_dead_is_401_unmapped_svc_pay_is_403() {
    let door = mount();
    post_as(
        &door,
        &format!("/markets/{MARKET}/orders"),
        &cod_body(vec![("sessionId", s("sess-cod"))]),
        "svc-fix",
    );
    let unsigned = post_named_unsigned(&door, "/session/dead", &session("sess-cod"), "svc-fix");
    assert_eq!(unsigned.status, 401);
    let unmapped = post_as(&door, "/session/dead", &session("sess-cod"), "svc-pay");
    assert_eq!(unmapped.status, 403);
    assert!(!kinds(&door).contains(&"session_dead".to_owned()));
}

#[test]
fn cod_fence_http_halt_all_without_confirm_hits_the_fence_refuse_no_invented_second_operator() {
    let door = mount();
    let a = post(&door, "/halt-all", &typed("ops-1", None));
    refused_400(&door, &a, "action_approval.missing");
    assert!(!flags(&door, MARKET).venue_halted);
}

#[test]
fn cod_fence_http_halt_all_with_two_operators_applies_fence_does_not_invent_a_second_caller() {
    let door = mount();
    let a = post(&door, "/halt-all", &kill());
    assert_eq!(a.status, 200);
    assert!(a.flag("accepted"));
    assert_eq!(a.text("confirmOperatorId"), "ops-confirm");
    assert!(flags(&door, MARKET).venue_halted);
}

#[test]
fn cod_fence_http_one_market_halt_without_confirm_hits_the_fence_refuse_no_invented_second_operator()
 {
    let door = mount();
    let a = post(&door, &market_url(MARKET, "halt"), &typed("ops-1", None));
    refused_400(&door, &a, "action_approval.missing");
    assert!(!flags(&door, MARKET).halted);
}

#[test]
fn cod_fence_http_one_market_halt_with_two_operators_applies_fence_does_not_invent_a_second_caller()
{
    let door = mount();
    let a = post(&door, &market_url(MARKET, "halt"), &kill());
    assert_eq!(a.status, 200);
    assert!(a.flag("accepted"));
    assert_eq!(a.text("confirmOperatorId"), "ops-confirm");
    assert!(flags(&door, MARKET).halted);
}

// ── surveillance.router.test.ts ─────────────────────────────────────────

/// `recordOpenSurveillanceCase(engine, case)` for each, then the door over an engine started cold on that journal.
fn mount_with_cases(cases: &[(&str, &str, &str)]) -> MatchingDoor {
    let mut journal = MemoryJournal::new();
    for (account, market, reason) in cases {
        journal
            .append(&JournalCommand(Json::obj([
                ("kind", s("open_surveillance")),
                ("marketId", s(market)),
                ("at", s("2026-08-25T16:00:00.000Z")),
                ("accountId", s(account)),
                ("reason", s(reason)),
            ])))
            .unwrap();
    }
    let mut engine = engine_on(Box::new(journal));
    engine.recover().unwrap();
    bare_door(engine)
}

fn case(account: &str, reason: &str) -> Json {
    Json::obj([
        ("accountId", s(account)),
        ("marketId", s(MARKET)),
        ("reason", s(reason)),
        ("status", s("open")),
    ])
}

#[test]
fn surveillance_lists_named_spoofing_layering_as_open_evidence_and_names_detector_gap() {
    let door = mount_with_cases(&[("desk", MARKET, "spoofing"), ("desk", MARKET, "layering")]);
    let a = signed_get(&door, "/surveillance/cases?limit=2");
    assert_eq!(a.status, 200);
    assert_eq!(
        a.get("cases"),
        &Json::Array(vec![case("desk", "layering"), case("desk", "spoofing")])
    );
    assert!(!a.body.compact().contains("fine"));
    for d in ["spoofing", "layering"] {
        assert_eq!(
            a.get(&format!("detectors.{d}")).compact(),
            format!(r#"{{"enabled":false,"gap":"detector_gap","reason":"{d}","threshold":null}}"#)
        );
    }
}

#[test]
fn surveillance_lists_self_trade_opened_on_the_matching_door() {
    let door = mount_plain();
    let first = order(
        &door,
        MARKET,
        vec![("orderId", s(O1)), ("accountId", s("same"))],
    );
    assert_eq!(first.status, 200);
    let second = order(
        &door,
        MARKET,
        vec![
            ("orderId", s(O2)),
            ("accountId", s("same")),
            ("side", s("buy")),
        ],
    );
    assert_eq!(second.status, 200);
    let a = signed_get(&door, "/surveillance/cases?limit=2");
    assert_eq!(a.status, 200);
    assert_eq!(
        a.get("cases"),
        &Json::Array(vec![case("same", "self_trade")])
    );
    let journalled: Vec<Json> = door
        .engine()
        .journal()
        .read()
        .iter()
        .filter(|r| r.kind() == Some("open_surveillance"))
        .map(|r| r.0.clone())
        .collect();
    assert_eq!(journalled.len(), 1, "the case is journalled once");
    assert_eq!(journalled[0].get("accountId"), Some(&s("same")));
    assert_eq!(journalled[0].get("reason"), Some(&s("self_trade")));
}

#[test]
fn surveillance_unauthenticated_list_is_401_cases_carry_account_ids() {
    let door = mount_plain();
    assert_eq!(get(&door, "/surveillance/cases").status, 401);
}

#[test]
fn surveillance_post_adjudicate_refuses_auto_adjudicate_forbidden_and_leaves_cases_open() {
    let door = mount_with_cases(&[("desk", MARKET, "spoofing")]);
    let before = door.engine().journal().len();
    let a = post(
        &door,
        "/surveillance/adjudicate",
        &Json::obj([("reason", s("spoofing"))]),
    );
    assert_eq!(a.status, 200);
    assert!(!a.flag("ok"));
    assert_eq!(a.code(), "auto_adjudicate_forbidden");
    assert_eq!(a.get("cases"), &Json::Array(vec![case("desk", "spoofing")]));
    let open = door.engine().open_surveillance_cases();
    assert_eq!(open[0].to_json().get("status"), Some(&s("open")));
    assert_eq!(door.engine().journal().len(), before);
}

#[test]
fn surveillance_post_fine_refuses_invented_sanction_and_posts_no_amount() {
    let door = mount_plain();
    let a = post(
        &door,
        "/surveillance/fine",
        &Json::obj([("reason", s("spoofing")), ("amount", s("100"))]),
    );
    assert_eq!(a.status, 200);
    assert!(!a.flag("ok"));
    assert_eq!(a.code(), "invented_sanction");
    assert_eq!(a.get("amount"), &Json::Null);
    assert_ne!(a.code(), "auto_close_forbidden");
    assert!(kinds(&door).is_empty());
}

// ── halt-stress.router.test.ts ──────────────────────────────────────────

const STORM_N: usize = 24;
const CLIP: &str = "0.25";
const H_PLACE: &str = O2;
const H_AFTER: &str = O4;
const H_TAKE: &str = O5;

fn oid(n: usize) -> String {
    format!("aaaaaaaa-aaaa-4aaa-8aaa-{n:012x}")
}

fn stress_body(over: Vec<(&str, Json)>) -> Json {
    let mut all = vec![("orderId", s(O1)), ("qty", s("1.25"))];
    all.extend(over);
    submit_body(MARKET, all)
}

fn stress_order(door: &MatchingDoor, over: Vec<(&str, Json)>) -> Answer {
    post(
        door,
        &format!("/markets/{MARKET}/orders"),
        &stress_body(over),
    )
}

fn live_ids(door: &MatchingDoor) -> Vec<String> {
    let a = signed_get(door, &format!("/markets/{MARKET}/orders?limit=50"));
    assert_eq!(a.status, 200, "{}", a.body.compact());
    let mut ids: Vec<String> = a
        .array("orders")
        .iter()
        .map(|o| o.get("orderId").and_then(as_str).unwrap().to_owned())
        .collect();
    ids.sort();
    ids
}

#[test]
fn halt_stress_halt_refuses_place_and_still_cancels_the_rest() {
    let door = mount();
    let rest = stress_order(&door, Vec::new());
    assert_eq!(rest.status, 200);
    assert!(rest.flag("accepted"));
    assert_eq!(rest.text("resting.remaining"), "1.25");
    let halt = post(&door, &market_url(MARKET, "halt"), &kill());
    assert_eq!(halt.status, 200);
    assert!(halt.flag("accepted") && halt.flag("halted"));
    assert_eq!(halt.text("operatorId"), "ops-1");
    assert_eq!(halt.text("confirmOperatorId"), "ops-confirm");
    for k in ["duration", "slo", "capacity"] {
        assert!(!halt.has(k), "{k}");
    }
    assert_eq!(live_ids(&door), vec![O1]);
    let refused = stress_order(
        &door,
        vec![
            ("orderId", s(H_PLACE)),
            ("accountId", s("taker")),
            ("side", s("buy")),
        ],
    );
    assert_eq!(refused.status, 200);
    assert!(!refused.flag("accepted"));
    assert_eq!(refused.rejected_code(), "market_halted");
    assert_eq!(refused.get("fills"), &Json::Array(Vec::new()));
    assert_eq!(refused.get("resting"), &Json::Null);
    let c = del(&door, &format!("/markets/{MARKET}/orders/{O1}"));
    assert_eq!(c.status, 200);
    assert!(c.flag("cancelled"));
    assert!(live_ids(&door).is_empty());
}

fn temp_journal() -> PathBuf {
    let mut bytes = [0u8; 8];
    getrandom::fill(&mut bytes).unwrap();
    let name: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    let dir = std::env::temp_dir().join(format!("matching-h-stress-halt-{name}"));
    std::fs::create_dir_all(&dir).unwrap();
    dir.join("engine.ndjson")
}

fn file_door(path: &PathBuf) -> MatchingDoor {
    let mut engine = engine_on(Box::new(FileJournal::open(path).unwrap()));
    engine.recover().unwrap();
    venue_door(
        engine,
        stub(),
        parse_operator_ids(Some("ops-1, ops-confirm")),
    )
}

#[test]
fn halt_stress_process_remount_and_engine_restart_stay_halted_do_not_invent_open() {
    let path = temp_journal();
    let live = file_door(&path);
    assert!(stress_order(&live, Vec::new()).flag("accepted"));
    assert!(post(&live, &market_url(MARKET, "halt"), &kill()).flag("accepted"));
    drop(live);

    let remounted = file_door(&path);
    let depth = get(&remounted, &format!("/markets/{MARKET}/depth?limit=50"));
    assert_eq!(depth.status, 200);
    assert_eq!(depth.text("marketId"), MARKET);
    assert!(depth.flag("halted"));
    let blocked = stress_order(
        &remounted,
        vec![
            ("orderId", s(H_PLACE)),
            ("accountId", s("taker")),
            ("side", s("buy")),
        ],
    );
    assert!(!blocked.flag("accepted"));
    assert_eq!(blocked.rejected_code(), "market_halted");
    assert_eq!(blocked.get("fills"), &Json::Array(Vec::new()));
    // `engine.restart` has no Rust call; the cold start above is the restart, and it left the market halted.
    assert!(flags(&remounted, MARKET).halted);
    let still = stress_order(
        &remounted,
        vec![
            ("orderId", s(H_AFTER)),
            ("accountId", s("taker")),
            ("side", s("buy")),
        ],
    );
    assert!(!still.flag("accepted"));
    assert_eq!(still.rejected_code(), "market_halted");
    let listed = signed_get(&remounted, &format!("/markets/{MARKET}/orders?limit=50"));
    assert_eq!(live_ids(&remounted), vec![O1]);
    assert_eq!(listed.text("orders.0.remaining"), "1.25");
    let c = del(&remounted, &format!("/markets/{MARKET}/orders/{O1}"));
    assert!(c.flag("cancelled"));
    let resume = post(&remounted, &market_url(MARKET, "resume"), &resume_body());
    assert!(resume.flag("accepted"));
    assert!(!resume.flag("halted"));
    let open = stress_order(
        &remounted,
        vec![
            ("orderId", s(H_AFTER)),
            ("accountId", s("mm")),
            ("qty", s("0.5")),
            ("price", s("99")),
        ],
    );
    assert!(open.flag("accepted"), "{}", open.body.compact());
    assert_eq!(open.get("fills"), &Json::Array(Vec::new()));
    drop(remounted);
    std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
}

#[test]
fn halt_stress_cancel_storm_of_n_rests_leaves_none_live_and_invents_no_fill() {
    let door = mount();
    let ids: Vec<String> = (1..=STORM_N).map(oid).collect();
    for (i, id) in ids.iter().enumerate() {
        let placed = stress_order(
            &door,
            vec![
                ("orderId", s(id)),
                ("accountId", s(&format!("mm-{i}"))),
                ("qty", s(CLIP)),
                ("price", s("101")),
            ],
        );
        assert_eq!(placed.status, 200);
        assert!(placed.flag("accepted"));
        assert_eq!(placed.get("fills"), &Json::Array(Vec::new()));
        assert_eq!(placed.text("resting.remaining"), CLIP);
    }
    let mut sorted = ids.clone();
    sorted.sort();
    let listed = live_ids(&door);
    assert_eq!(listed, sorted);
    assert_eq!(listed.iter().collect::<BTreeSet<_>>().len(), STORM_N);
    for id in &ids {
        assert!(del(&door, &format!("/markets/{MARKET}/orders/{id}")).flag("cancelled"));
    }
    assert!(live_ids(&door).is_empty());
    let take = stress_order(
        &door,
        vec![
            ("orderId", s(H_TAKE)),
            ("accountId", s("taker")),
            ("side", s("buy")),
            ("qty", s("6")),
            ("price", s("101")),
        ],
    );
    assert_eq!(take.status, 200);
    assert!(take.flag("accepted"));
    assert_eq!(take.get("fills"), &Json::Array(Vec::new()));
    assert_eq!(take.text("resting.orderId"), H_TAKE);
    assert_eq!(take.text("resting.remaining"), "6");
    assert_eq!(take.text("resting.price"), "101");
    assert_eq!(live_ids(&door), vec![H_TAKE]);
}

#[test]
fn halt_stress_burst_of_n_clips_fills_the_taker_once_each_no_double_live_no_invented_qty() {
    let door = mount();
    let ids: Vec<String> = (1..=STORM_N).map(oid).collect();
    for (i, id) in ids.iter().enumerate() {
        let placed = stress_order(
            &door,
            vec![
                ("orderId", s(id)),
                ("accountId", s(&format!("mm-{i}"))),
                ("qty", s(CLIP)),
                ("price", s("100")),
            ],
        );
        assert!(placed.flag("accepted"));
        assert_eq!(placed.get("fills"), &Json::Array(Vec::new()));
    }
    let take = stress_order(
        &door,
        vec![
            ("orderId", s(H_TAKE)),
            ("accountId", s("taker")),
            ("side", s("buy")),
            ("qty", s("6")),
            ("price", s("100")),
        ],
    );
    assert_eq!(take.status, 200);
    assert!(take.flag("accepted"));
    assert_eq!(take.get("resting"), &Json::Null);
    let fills = take.array("fills");
    assert_eq!(fills.len(), STORM_N);
    let field = |f: &Json, k: &str| f.get(k).and_then(as_str).unwrap().to_owned();
    let mut total = Amount::default();
    let mut makers = Vec::new();
    for f in fills {
        assert_eq!(field(f, "takerOrderId"), H_TAKE);
        assert_eq!(field(f, "qty"), CLIP);
        assert_eq!(field(f, "price"), "100");
        total += parse_amount(&field(f, "qty")).unwrap();
        makers.push(field(f, "makerOrderId"));
    }
    assert_eq!(total, parse_amount("6").unwrap());
    assert_eq!(makers.iter().collect::<BTreeSet<_>>().len(), STORM_N);
    makers.sort();
    let mut sorted = ids.clone();
    sorted.sort();
    assert_eq!(makers, sorted);
    assert!(live_ids(&door).is_empty());
}

// ── added beyond the TypeScript ─────────────────────────────────────────

/// `consumeVenueKill` checks both people identity recorded against the operator list: an approver without an operator
/// seat refuses, whoever typed the request. No TypeScript test holds this line (`router.ts`'s
/// `!isOperator(consumed.requesterId) || !isOperator(approverId)`).
#[test]
fn approval_an_approver_off_the_operator_list_refuses_and_nothing_switches() {
    let door = door_with(stub(), "ops-1");
    let a = post(&door, &market_url(MARKET, "halt"), &kill());
    refused_400(&door, &a, "action_approval.not_operator");
    assert_eq!(
        a.text("message"),
        "both the proposer and the approver must be operators of this venue"
    );
    assert!(!flags(&door, MARKET).halted);
}
