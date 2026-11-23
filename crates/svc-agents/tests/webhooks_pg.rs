//! The run webhooks against a real Postgres (`TEST_DATABASE_URL_AGENTS` or `TEST_DATABASE_URL`, a server whose admin
//! database name ends in `_test`), each test in its own throwaway database migrated by the crate's own runner. Without a
//! URL it skips; with `REQUIRE_POSTGRES=1` it fails.
//!
//! Ported case for case from `services/svc-agents/src/webhooks/run-webhooks.db.test.ts`, through the `AgentsDoor` (J-agents-12
//! #5): a key with `agents:read` registers an endpoint; each run the person then ends in their own session (a room run
//! completed or refused, a background run) is delivered once, signed; nothing else is. The transport is a recorder, so
//! what was posted is read exactly; the ledger is a fake and the engine the crate's deterministic mock.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::too_many_lines,
    reason = "a test: a failure is the point"
)]

use crate::support;

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use service_kit::edge;
use service_kit::json::{self, Json};
use service_kit::money::{Amount, parse_amount};
use service_kit::server::Request;
use service_kit::time::Instant;
use support::TestDb;
use svc_agents::background::{self, Settings};
use svc_agents::db;
use svc_agents::door::{AgentsDoor, DoorConfig, ServiceAuth};
use svc_agents::gateway::Gateway;
use svc_agents::gateway::desk::GatewaySlice;
use svc_agents::gateway::providers::{MockOptions, MockProvider};
use svc_agents::gateway::readiness::ReadyInput;
use svc_agents::gateway::routing::{RoutingTable, parse_routing_table, unpriced};
use svc_agents::metering::Metering;
use svc_agents::metering::ports::{
    Bus, Collected, HeldBy, Ledger, LedgerError, PaymentUnavailable, Recipe, UsagePayment,
};
use svc_agents::runtime::guardrails::{parse_guardrail, serialise_guardrail};
use svc_agents::runtime::{Rt, Runtime};
use svc_agents::self_freeze::{Reading, SelfFreezeRead, Unavailable};
use svc_agents::webhooks::RunWebhooks;
use svc_agents::webhooks::pinned_post::{PinnedPost, Transport};

// ── The fakes ───────────────────────────────────────────────────────────────

/// The booked keys and the people's balances.
type Book = (BTreeMap<String, String>, BTreeMap<String, Amount>);

/// `MemoryLedger` as far as these tests read it: each recipe booked once under its key, and the people's balances.
#[derive(Default, Clone)]
struct FakeLedger(Arc<Mutex<Book>>);

impl Ledger for FakeLedger {
    fn post_recipe(&self, recipe: &Recipe) -> Result<String, LedgerError> {
        let mut b = self.0.lock().unwrap();
        let key = recipe.idempotency_key();
        if let Some(tx) = b.0.get(&key) {
            return Ok(tx.clone());
        }
        if let Recipe::FeeCharge {
            user_id, amount, ..
        } = recipe
        {
            let have = b.1.get(user_id).copied().unwrap_or(Amount::ZERO);
            if have < *amount {
                return Err(LedgerError {
                    code: Some("ledger.insufficient_funds".to_owned()),
                    message: "Insufficient funds".to_owned(),
                });
            }
            *b.1.entry(user_id.clone()).or_default() -= *amount;
        }
        let tx = format!("tx-{}", b.0.len() + 1);
        b.0.insert(key, tx.clone());
        Ok(tx)
    }
}

struct NoBus;

impl Bus for NoBus {
    fn publish(&self, _: &str, _: &str, _: &Json) -> Result<(), String> {
        Ok(())
    }
}

/// The ledger's own charge (`ledgerOnlyPayment`).
struct LedgerPays;

impl UsagePayment for LedgerPays {
    fn read(&self, _: &str, _: &str, _: Option<&str>) -> Result<HeldBy, PaymentUnavailable> {
        Ok(HeldBy::Ledger)
    }
    fn collect(
        &self,
        _: &str,
        _: &str,
        _: Amount,
        _: &str,
        _: Option<&str>,
    ) -> Result<Collected, PaymentUnavailable> {
        Ok(Collected::Refused("not_partner_held".to_owned()))
    }
}

/// `MemorySelfFreezeRead`: nobody frozen.
struct Open;

impl SelfFreezeRead for Open {
    fn read(&self, _: &str) -> Result<Reading, Unavailable> {
        Ok(Reading::Open)
    }
}

/// The recording transport: every post kept, each answered with `answer`.
#[derive(Clone)]
struct Recorder {
    posts: Arc<Mutex<Vec<PinnedPost>>>,
    answer: Arc<Mutex<u16>>,
}

impl Transport for Recorder {
    fn post(&self, req: &PinnedPost) -> Result<u16, String> {
        self.posts.lock().unwrap().push(req.clone());
        Ok(*self.answer.lock().unwrap())
    }
}

// ── The world a test runs in ────────────────────────────────────────────────

const USER: &str = "51515151-5151-4151-8151-515151515151";
const OTHER: &str = "52525252-5252-4252-8252-525252525252";
const KEY_ID: &str = "53535353-5353-4353-8353-535353535353";
const ENDPOINT: &str = "54545454-5454-4454-8454-545454545454";
const SECRET: &str = "an-agents-run-webhooks-db-test-secret-32";
const ASK: &str = "TEST: my private prompt";
const HOOK: &str = "http://127.0.0.1:9/agents-hook";

fn now() -> Instant {
    svc_agents::door::system_now()
}

fn table() -> RoutingTable {
    parse_routing_table(
        r#"{"routes":[{"task":"plan","providerId":"primary","model":"reasoning-lg","maxOutputTokens":64,"price":{"inputPerMillion":"3","outputPerMillion":"15"}}]}"#,
    )
    .unwrap()
}

struct World {
    db: TestDb,
    ledger: FakeLedger,
    recorder: Recorder,
    door: AgentsDoor,
}

impl World {
    /// `beforeEach`: the probe agent, 1000 IFC for USER and OTHER, and the recorder answering 200.
    fn new() -> Option<World> {
        let db = TestDb::new()?;
        let mut sink = Vec::new();
        svc_agents::migrate::run(&db.url, false, &mut sink).unwrap();
        let raw = r#"{"agentId":"probe","version":1,"capacityMode":"confirm_each","tools":[{"name":"trade.quote","module":"trade","mode":"read"}],"limits":{"maxActionsPerSession":20,"maxOutputTokensPerCall":64,"maxSpendPerSession":null,"allowedModules":["trade"],"allowedTasks":["plan"]}}"#;
        let stored =
            serialise_guardrail(&parse_guardrail(&json::parse(raw).unwrap()).unwrap()).compact();
        db.client()
            .execute(
                "INSERT INTO agents.agent_definitions (agent_id, version, guardrail, enabled) VALUES ('probe', 1, $1::text::jsonb, true)",
                &[&stored],
            )
            .unwrap();
        let ledger = FakeLedger::default();
        for u in [USER, OTHER] {
            ledger
                .0
                .lock()
                .unwrap()
                .1
                .insert(u.to_owned(), parse_amount("1000").unwrap());
        }
        let recorder = Recorder {
            posts: Arc::new(Mutex::new(Vec::new())),
            answer: Arc::new(Mutex::new(200)),
        };
        let door = Self::door_of(&db, &ledger, table(), Some(&recorder));
        Some(World {
            db,
            ledger,
            recorder,
            door,
        })
    }

    /// `createAgentsRouter(deps(overrides))`: the real runtime and meter (metering on, the ledger's own charge), the
    /// deterministic engine on `table`, and the run webhooks on the recorder (none: unwired).
    fn door_of(
        db_: &TestDb,
        ledger: &FakeLedger,
        table: RoutingTable,
        hooks: Option<&Recorder>,
    ) -> AgentsDoor {
        let mut m = Metering::unwired("IFC", 60);
        m.enabled = true;
        m.ledger = Box::new(ledger.clone());
        m.payment = Box::new(LedgerPays);
        m.bus = Box::new(NoBus);
        let mut rt = Runtime::unwired();
        rt.spend = false;
        rt.self_freeze = Some(Box::new(Open));
        let env: BTreeMap<String, String> = [
            ("APP_ENV", "test"),
            ("NODE_ENV", "test"),
            ("INTAFACED_SCREENING_FAIL_CLOSED", "off"),
            ("INTAFACED_UNSIGNED_SANCTIONS_ROWS", "off"),
        ]
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect();
        let mock = MockProvider::new(
            MockOptions {
                id: Some("primary".to_owned()),
                ..MockOptions::default()
            },
            now,
        );
        let door = AgentsDoor::new(DoorConfig {
            edge_secret: SECRET.to_owned(),
            services: ServiceAuth::unwired(),
            env,
            now,
            store: db::open(&db_.url, "svc-agents", 6, false).unwrap(),
            gateway: GatewaySlice {
                gateway: Arc::new(Gateway::new(vec![Arc::new(mock)], table)),
                fee_asset_id: "IFC".to_owned(),
                metering_enabled: Some(true),
                window_minutes: 60,
            },
            ready: ReadyInput::unwired(),
            metering: m,
            runtime: rt,
            background: Settings {
                max_steps: Some(10),
                step_ms: Some(1000),
            },
            ops: svc_agents::ops::Ops::unwired(),
            own: svc_agents::own::Own::unwired(),
            advisors: svc_agents::advisors::Advisors::unwired(),
            team: svc_agents::team::Team::unwired(),
        })
        .unwrap();
        match hooks {
            // `new RunWebhooks(sql, { allowLocalHttp: true, transport })`.
            Some(r) => door.with_webhooks(RunWebhooks::with(
                true,
                Box::new(r.clone()),
                Box::new(|_| Err("no DNS in this test".to_owned())),
            )),
            None => door,
        }
    }

    fn count(&self, sql: &str) -> i64 {
        self.db.count(sql)
    }

    /// `hooks.drain()`.
    fn drain(&self) -> i64 {
        self.door
            .webhooks()
            .unwrap()
            .drain(self.door.store().pool().unwrap(), 20)
            .unwrap()
    }

    fn posts(&self) -> Vec<PinnedPost> {
        self.recorder.posts.lock().unwrap().clone()
    }

    /// `posted()`: each post's body, parsed.
    fn posted(&self) -> Vec<Json> {
        self.posts()
            .iter()
            .map(|p| json::parse(&p.body).unwrap())
            .collect()
    }

    /// `advanceSessionRuns(sql, runtime, 0, 50, 'IFC')`.
    fn tick(&self) {
        let x = Rt {
            rt: self.door.runtime(),
            pool: self.door.store().pool().unwrap(),
            gateway: &self.door.gateway().gateway,
            m: self.door.metering(),
            now: now(),
        };
        background::advance(&x, 0, 50).unwrap();
    }
}

macro_rules! world_or_skip {
    () => {
        match World::new() {
            Some(w) => w,
            None => {
                eprintln!("skipped: no TEST_DATABASE_URL");
                return;
            }
        }
    };
}

// ── The door ────────────────────────────────────────────────────────────────

/// A signed-in person, or with `kid` an API key holding only `scopes`.
fn signed(user: &str, scopes: &[&str], kid: Option<&str>) -> Vec<(String, String)> {
    let mut fields = vec![
        ("sub", Json::str(user)),
        ("userId", Json::str(user)),
        ("sid", Json::str("55555555-5555-4555-8555-555555555555")),
        (
            "scopes",
            Json::Array(scopes.iter().map(|s| Json::str(*s)).collect()),
        ),
        ("tier", Json::str("none")),
        ("mfa", Json::Bool(false)),
        ("expiresAt", Json::str("2099-01-01T00:00:00.000Z")),
    ];
    if let Some(kid) = kid {
        fields.push(("kid", Json::str(kid)));
    }
    let raw = Json::Object(fields.into_iter().map(|(k, v)| (k.to_owned(), v)).collect()).compact();
    let sig = edge::sign(&raw, SECRET, "DE").unwrap();
    vec![
        ("x-intafaced-principal".to_owned(), raw),
        ("x-intafaced-principal-sig".to_owned(), sig),
        ("x-intafaced-region".to_owned(), "DE".to_owned()),
    ]
}

fn person(user: &str) -> Vec<(String, String)> {
    signed(user, &["agents:read", "agents:execute"], None)
}

fn key(user: &str, scopes: &[&str]) -> Vec<(String, String)> {
    signed(user, scopes, Some(KEY_ID))
}

fn reader(user: &str) -> Vec<(String, String)> {
    key(user, &["agents:read"])
}

fn call(
    door: &AgentsDoor,
    who: &[(String, String)],
    path: &str,
    input: &Json,
    query: bool,
) -> (u16, Json) {
    let mut headers = who.to_vec();
    let res = if query {
        let enc: String = input
            .compact()
            .bytes()
            .map(|b| {
                if b.is_ascii_alphanumeric() {
                    char::from(b).to_string()
                } else {
                    format!("%{b:02X}")
                }
            })
            .collect();
        let url = format!("/trpc/{path}?input={enc}");
        door.handle(&Request {
            method: "GET",
            url: &url,
            headers: &headers,
            body: "",
        })
    } else {
        let body = input.compact();
        headers.push(("content-type".to_owned(), "application/json".to_owned()));
        let url = format!("/trpc/{path}");
        door.handle(&Request {
            method: "POST",
            url: &url,
            headers: &headers,
            body: &body,
        })
    };
    (res.status, json::parse(&res.body).unwrap())
}

fn ok(answer: (u16, Json)) -> Json {
    assert_eq!(answer.0, 200, "{}", answer.1.compact());
    answer
        .1
        .get("result")
        .and_then(|r| r.get("data"))
        .cloned()
        .unwrap()
}

/// `rejects.toMatchObject({ code, message })`.
fn refused(answer: (u16, Json)) -> (String, String) {
    assert_ne!(answer.0, 200, "not refused: {}", answer.1.compact());
    let e = answer.1.get("error").unwrap();
    (s(e.get("data").unwrap(), "code"), s(e, "message"))
}

fn s(v: &Json, k: &str) -> String {
    match v.get(k) {
        Some(Json::String(t)) => t.clone(),
        other => panic!("{k} is not a string: {other:?} in {}", v.compact()),
    }
}

fn register(door: &AgentsDoor, who: &[(String, String)], endpoint: &str, url: &str) -> (u16, Json) {
    call(
        door,
        who,
        "webhook.register",
        &Json::obj([("endpointId", Json::str(endpoint)), ("url", Json::str(url))]),
        false,
    )
}

fn list(door: &AgentsDoor, who: &[(String, String)]) -> (u16, Json) {
    call(
        door,
        who,
        "webhook.list",
        &Json::obj([("limit", Json::int(10))]),
        true,
    )
}

fn deliveries(door: &AgentsDoor, who: &[(String, String)], run_id: Option<&str>) -> Json {
    let input = match run_id {
        Some(r) => Json::obj([("runId", Json::str(r)), ("limit", Json::int(50))]),
        None => Json::obj([("limit", Json::int(50))]),
    };
    ok(call(door, who, "webhook.deliveries", &input, true))
}

fn open_session(door: &AgentsDoor, user: &str) -> String {
    s(
        &ok(call(
            door,
            &person(user),
            "session.open",
            &Json::obj([("agentId", Json::str("probe"))]),
            false,
        )),
        "id",
    )
}

/// `roomRun`: a session opened and one `run.complete` on it.
fn room_run(door: &AgentsDoor, user: &str, request_id: &str) -> (String, (u16, Json)) {
    let session = open_session(door, user);
    let ran = call(
        door,
        &person(user),
        "run.complete",
        &Json::obj([
            ("sessionId", Json::str(session.clone())),
            ("requestId", Json::str(request_id)),
            ("task", Json::str("plan")),
            (
                "messages",
                Json::Array(vec![Json::obj([
                    ("role", Json::str("user")),
                    ("content", Json::str(ASK)),
                ])]),
            ),
        ]),
        false,
    );
    (session, ran)
}

/// The fields of a delivery the TypeScript's `read.map(...)` keeps.
fn summary(d: &Json) -> (String, String, String, String, f64, Json) {
    let n = match d.get("attempts") {
        Some(Json::Number(x)) => *x,
        other => panic!("attempts: {other:?}"),
    };
    (
        s(d, "runId"),
        s(d, "kind"),
        s(d, "runState"),
        s(d, "state"),
        n,
        d.get("lastStatus").cloned().unwrap(),
    )
}

fn arr(v: &Json) -> Vec<Json> {
    match v {
        Json::Array(a) => a.clone(),
        other => panic!("not an array: {}", other.compact()),
    }
}

// ── The cases ───────────────────────────────────────────────────────────────

#[test]
fn a_key_with_agents_read_registers_once_and_the_secret_is_shown_on_the_register_that_made_it() {
    let w = world_or_skip!();
    let d = &w.door;
    let made = ok(register(d, &reader(USER), ENDPOINT, HOOK));
    assert_eq!(s(&made, "id"), ENDPOINT);
    assert_eq!(s(&made, "url"), HOOK);
    s(&made, "createdAt");
    let secret = s(&made, "secret");
    assert!(
        secret.len() == 70
            && secret.starts_with("whsec_")
            && secret[6..]
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()),
        "{secret}"
    );
    let without = Json::obj([
        ("id", made.get("id").cloned().unwrap()),
        ("url", made.get("url").cloned().unwrap()),
        ("createdAt", made.get("createdAt").cloned().unwrap()),
        ("secret", Json::Null),
    ]);
    // The same register again is the same endpoint, and the secret is never shown again.
    assert_eq!(ok(register(d, &reader(USER), ENDPOINT, HOOK)), without);
    assert_eq!(ok(list(d, &reader(USER))), Json::Array(vec![without]));
    // The same id for another address, or from someone else, is refused and tells nothing about the endpoint.
    assert_eq!(
        refused(register(
            d,
            &reader(USER),
            ENDPOINT,
            "http://127.0.0.1:9/other"
        )),
        (
            "CONFLICT".to_owned(),
            "agents.webhook_endpoint_conflict".to_owned()
        )
    );
    assert_eq!(
        refused(register(d, &reader(OTHER), ENDPOINT, HOOK)).1,
        "agents.webhook_endpoint_conflict"
    );
    assert_eq!(ok(list(d, &reader(OTHER))), Json::Array(Vec::new()));
    // A private or plain-http outside address is refused before anything is stored.
    for url in [
        "http://hooks.example.com/x",
        "https://10.0.0.5/x",
        "https://svc-ledger/x",
    ] {
        assert_eq!(
            refused(register(d, &reader(USER), OTHER, url)),
            (
                "BAD_REQUEST".to_owned(),
                "agents.webhook_url_invalid".to_owned()
            ),
            "{url}"
        );
    }
    assert_eq!(
        refused(register(d, &key(USER, &["trade:read"]), OTHER, HOOK)),
        (
            "FORBIDDEN".to_owned(),
            "Scope \"agents:read\" is required".to_owned()
        )
    );
    assert_eq!(refused(list(d, &key(USER, &["trade:read"]))).0, "FORBIDDEN");
    assert_eq!(
        w.count("SELECT count(*) FROM agents.run_webhook_endpoints"),
        1
    );
}

#[test]
fn a_key_cannot_start_a_run_and_nothing_is_stored() {
    let w = world_or_skip!();
    let d = &w.door;
    let session = open_session(d, USER);
    for scopes in [&["agents:read"][..], &["agents:read", "agents:execute"][..]] {
        assert_eq!(
            refused(call(
                d,
                &key(USER, scopes),
                "session.open",
                &Json::obj([("agentId", Json::str("probe"))]),
                false
            )),
            (
                "FORBIDDEN".to_owned(),
                "agents.execute_person_only".to_owned()
            )
        );
        assert_eq!(
            refused(call(
                d,
                &key(USER, scopes),
                "run.background.start",
                &Json::obj([
                    ("sessionId", Json::str(session.clone())),
                    ("requestId", Json::str("webhooks:db:by-key")),
                    ("task", Json::str("plan")),
                    ("ask", Json::str(ASK)),
                    ("steps", Json::int(1)),
                    ("notice", Json::str("inapp")),
                ]),
                false
            )),
            (
                "FORBIDDEN".to_owned(),
                "agents.execute_person_only".to_owned()
            )
        );
    }
    assert_eq!(
        w.count("SELECT count(*) FROM agents.session_background_runs"),
        0
    );
    assert_eq!(w.count("SELECT count(*) FROM agents.agent_runs"), 0);
}

#[test]
fn each_run_the_person_ends_after_registering_is_delivered_once_signed_with_no_prompt() {
    let w = world_or_skip!();
    let d = &w.door;
    let _ = ok(room_run(d, USER, "webhooks:db:before").1);
    let secret = s(&ok(register(d, &reader(USER), ENDPOINT, HOOK)), "secret");
    let (session, ran) = room_run(d, USER, "webhooks:db:after");
    let ran = ok(ran);
    let _ = ok(room_run(d, OTHER, "webhooks:db:other").1);
    // A refused run (the route has no rate) ends too, and is delivered with its code.
    let unpriced_door = World::door_of(&w.db, &w.ledger, unpriced(&table()), None);
    assert_eq!(
        refused(room_run(&unpriced_door, USER, "webhooks:db:refused").1).1,
        "agents.refused.price_unset"
    );
    let r = w
        .db
        .client()
        .query_one(
            "SELECT id::text, session_id::text FROM agents.agent_runs WHERE request_id = 'webhooks:db:refused'",
            &[],
        )
        .unwrap();
    let (refused_id, refused_session): (String, String) = (r.get(0), r.get(1));

    assert_eq!(w.drain(), 2);
    assert_eq!(w.drain(), 0);
    let run_id = s(&ran, "runId");
    let got = w.posted();
    assert_eq!(
        got.iter().map(sorted).collect::<Vec<_>>(),
        vec![
            sorted(&Json::obj([
                ("id", Json::str(format!("agents.run.finished:{run_id}:3"))),
                ("type", Json::str("agents.run.finished")),
                ("kind", Json::str("run")),
                ("runId", Json::str(run_id.clone())),
                ("sessionId", Json::str(session)),
                ("agentId", Json::str("probe")),
                ("state", Json::str("completed")),
                ("reply", ran.get("text").cloned().unwrap()),
                ("cost", ran.get("cost").cloned().unwrap()),
                ("assetId", Json::str("IFC")),
                ("refusalCodes", Json::Array(Vec::new())),
            ])),
            sorted(&Json::obj([
                (
                    "id",
                    Json::str(format!("agents.run.finished:{refused_id}:3"))
                ),
                ("type", Json::str("agents.run.finished")),
                ("kind", Json::str("run")),
                ("runId", Json::str(refused_id.clone())),
                ("sessionId", Json::str(refused_session)),
                ("agentId", Json::str("probe")),
                ("state", Json::str("refused")),
                ("reply", Json::Null),
                ("cost", Json::Null),
                ("assetId", Json::Null),
                (
                    "refusalCodes",
                    Json::Array(vec![Json::str("agents.price_unset")])
                ),
            ])),
        ]
    );
    for post in w.posts() {
        assert_eq!(post.url.as_str(), HOOK);
        assert!(!post.body.contains(ASK));
        let header = |k: &str| {
            post.headers
                .iter()
                .find(|(h, _)| h == k)
                .map(|(_, v)| v.clone())
                .unwrap()
        };
        let event = s(&json::parse(&post.body).unwrap(), "id");
        assert_eq!(header("x-intafaced-event-id"), event);
        assert_eq!(header("idempotency-key"), event);
        let signature = svc_agents::webhooks::sign(
            &secret,
            &format!("{}.{}", header("x-intafaced-timestamp"), post.body),
        );
        assert_eq!(header("x-intafaced-signature"), format!("v1={signature}"));
    }
    let read = arr(&deliveries(d, &reader(USER), None));
    assert_eq!(
        read.iter().map(summary).collect::<Vec<_>>(),
        vec![
            (
                run_id.clone(),
                "run".into(),
                "completed".into(),
                "delivered".into(),
                1.0,
                Json::int(200)
            ),
            (
                refused_id,
                "run".into(),
                "refused".into(),
                "delivered".into(),
                1.0,
                Json::int(200)
            ),
        ]
    );
    assert_eq!(
        deliveries(d, &reader(USER), Some(&run_id)),
        Json::Array(vec![read[0].clone()])
    );
    assert_eq!(deliveries(d, &reader(OTHER), None), Json::Array(Vec::new()));
}

/// An object with its keys in byte order, all the way down (`toEqual` reads no key order).
fn sorted(v: &Json) -> Json {
    match v {
        Json::Object(f) => {
            let mut f: Vec<(String, Json)> =
                f.iter().map(|(k, x)| (k.clone(), sorted(x))).collect();
            f.sort_by(|a, b| a.0.cmp(&b.0));
            Json::Object(f)
        }
        Json::Array(a) => Json::Array(a.iter().map(sorted).collect()),
        other => other.clone(),
    }
}

#[test]
fn a_background_run_is_delivered_once_when_it_completes_with_its_last_reply_and_summed_cost() {
    let w = world_or_skip!();
    let d = &w.door;
    let _ = ok(register(d, &reader(USER), ENDPOINT, HOOK));
    let session = open_session(d, USER);
    let run = ok(call(
        d,
        &person(USER),
        "run.background.start",
        &Json::obj([
            ("sessionId", Json::str(session.clone())),
            ("requestId", Json::str("webhooks:db:bg")),
            ("task", Json::str("plan")),
            ("ask", Json::str(ASK)),
            ("steps", Json::int(2)),
            ("notice", Json::str("inapp")),
        ]),
        false,
    ));
    let run_id = s(&run, "runId");
    for _ in 0..6 {
        w.tick();
    }
    let done = ok(call(
        d,
        &person(USER),
        "run.background.get",
        &Json::obj([("runId", Json::str(run_id.clone()))]),
        true,
    ));
    assert_eq!(s(&done, "state"), "completed");
    assert_eq!(w.drain(), 1);
    let sum: Amount = arr(done.get("steps").unwrap())
        .iter()
        .map(|st| parse_amount(&s(st, "cost")).unwrap())
        .sum();
    let posted = w.posted();
    assert_eq!(posted.len(), 1);
    let cost = s(&posted[0], "cost");
    assert_eq!(
        sorted(&posted[0]),
        sorted(&Json::obj([
            (
                "id",
                Json::str(format!("agents.background_run.finished:{run_id}:1"))
            ),
            ("type", Json::str("agents.run.finished")),
            ("kind", Json::str("background")),
            ("runId", Json::str(run_id.clone())),
            ("sessionId", Json::str(session)),
            ("agentId", Json::str("probe")),
            ("state", Json::str("completed")),
            ("reply", done.get("reply").cloned().unwrap()),
            ("cost", Json::str(cost.clone())),
            ("assetId", Json::str("IFC")),
            ("refusalCodes", Json::Array(Vec::new())),
        ]))
    );
    assert_eq!(parse_amount(&cost).unwrap(), sum);
    assert!(!w.posts()[0].body.contains(ASK));
    // More ticks end nothing again.
    w.tick();
    assert_eq!(w.drain(), 0);
}

#[test]
fn an_endpoint_that_does_not_take_the_post_is_marked_failed_once_and_the_run_is_unchanged() {
    let w = world_or_skip!();
    let d = &w.door;
    let _ = ok(register(d, &reader(USER), ENDPOINT, HOOK));
    *w.recorder.answer.lock().unwrap() = 500;
    let ran = ok(room_run(d, USER, "webhooks:db:fails").1);
    let run_id = s(&ran, "runId");
    assert_eq!(w.drain(), 1);
    assert_eq!(w.drain(), 0);
    let read = arr(&deliveries(d, &reader(USER), None));
    assert_eq!(read.len(), 1);
    assert_eq!(s(&read[0], "runId"), run_id);
    assert_eq!(s(&read[0], "state"), "failed");
    assert_eq!(read[0].get("attempts"), Some(&Json::int(1)));
    assert_eq!(read[0].get("lastStatus"), Some(&Json::int(500)));
    let got = ok(call(
        d,
        &reader(USER),
        "run.get",
        &Json::obj([("runId", Json::str(run_id))]),
        true,
    ));
    assert_eq!(s(&got, "state"), "completed");
}

#[test]
fn with_no_webhooks_wired_every_webhook_call_refuses_by_name() {
    let w = world_or_skip!();
    let bare = World::door_of(&w.db, &w.ledger, table(), None);
    assert_eq!(
        refused(list(&bare, &reader(USER))),
        (
            "PRECONDITION_FAILED".to_owned(),
            "agents.webhooks_unwired".to_owned()
        )
    );
}
