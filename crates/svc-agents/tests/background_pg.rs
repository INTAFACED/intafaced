//! A session's background runs against a real Postgres (`TEST_DATABASE_URL_AGENTS` or `TEST_DATABASE_URL`, a server
//! whose admin database name ends in `_test`), each test in its own throwaway database migrated by the crate's own
//! runner. Without a URL it skips; with `REQUIRE_POSTGRES=1` it fails.
//!
//! Ported case for case from `services/svc-agents/src/runs/background.db.test.ts`: through the `AgentsDoor` with a
//! signed principal, with the real runtime and meter. The ledger and the bus are fakes; the engine is the crate's
//! deterministic mock under the id `primary`, wrapped so every call it is asked is seen (the TypeScript's `calls`).
//! The ticker is called by hand with a step time of 0, so each call is one boundary: a step in flight makes its call,
//! and a running run starts its next step.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::too_many_lines,
    reason = "a test: a failure is the point"
)]

mod support;

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use service_kit::edge;
use service_kit::json::{self, Json};
use service_kit::money::{Amount, format_amount, parse_amount};
use service_kit::server::Request;
use service_kit::time::Instant;
use support::TestDb;
use svc_agents::background::{self, Settings};
use svc_agents::db;
use svc_agents::door::{AgentsDoor, DoorConfig, ServiceAuth};
use svc_agents::gateway::Gateway;
use svc_agents::gateway::desk::GatewaySlice;
use svc_agents::gateway::providers::{
    ChatMessage, CompletionRequest, CompletionResult, EmbedRequest, EmbedResult, Failure, Health,
    MockOptions, MockProvider, Provider, ProviderError, Role,
};
use svc_agents::gateway::readiness::ReadyInput;
use svc_agents::gateway::routing::{Capability, Engine, parse_routing_table};
use svc_agents::metering::Metering;
use svc_agents::metering::ports::{
    Bus, Collected, HeldBy, Ledger, LedgerError, PaymentUnavailable, Recipe, UsagePayment,
};
use svc_agents::runtime::guardrails::{parse_guardrail, serialise_guardrail};
use svc_agents::runtime::{Rt, Runtime};
use svc_agents::self_freeze::{Reading, SelfFreezeRead, Unavailable};

// ── The fakes ───────────────────────────────────────────────────────────────

/// `MemoryLedger` as far as these tests read it: each recipe booked once under its key, every person's available
/// balance, `houseFees('agents', 'IFC')` and the journal's reasons.
#[derive(Default)]
struct Book {
    by_key: BTreeMap<String, String>,
    house: Amount,
    available: BTreeMap<String, Amount>,
    journal: Vec<&'static str>,
}

#[derive(Default, Clone)]
struct FakeLedger(Arc<Mutex<Book>>);

impl FakeLedger {
    fn deposit(&self, user: &str, amount: Amount) {
        *self
            .0
            .lock()
            .unwrap()
            .available
            .entry(user.to_owned())
            .or_default() += amount;
    }
    fn balance(&self, user: &str) -> Amount {
        self.0
            .lock()
            .unwrap()
            .available
            .get(user)
            .copied()
            .unwrap_or(0)
    }
    fn house(&self) -> Amount {
        self.0.lock().unwrap().house
    }
    /// `ledger.journal().filter(t => t.reason.startsWith('charge.'))`.
    fn charges(&self) -> Vec<&'static str> {
        self.0.lock().unwrap().journal.clone()
    }
}

impl Ledger for FakeLedger {
    fn post_recipe(&self, recipe: &Recipe) -> Result<String, LedgerError> {
        let mut b = self.0.lock().unwrap();
        let key = recipe.idempotency_key();
        if let Some(tx) = b.by_key.get(&key) {
            return Ok(tx.clone());
        }
        match recipe {
            Recipe::FeeCharge {
                user_id, amount, ..
            } => {
                let have = b.available.get(user_id).copied().unwrap_or(0);
                if have < *amount {
                    return Err(LedgerError {
                        code: Some("ledger.insufficient_funds".to_owned()),
                        message: "Insufficient funds".to_owned(),
                    });
                }
                *b.available.entry(user_id.clone()).or_default() -= amount;
                b.house += amount;
            }
            Recipe::ChargeEarn { .. } => b.journal.push("charge.earned"),
            Recipe::ChargeCollect { .. } => b.journal.push("charge.collected"),
        }
        let tx = format!("tx-{}", b.by_key.len() + 1);
        b.by_key.insert(key, tx.clone());
        Ok(tx)
    }
}

#[derive(Default, Clone)]
struct FakeBus(Arc<Mutex<Vec<(String, String, Json)>>>);

impl Bus for FakeBus {
    fn publish(&self, subject: &str, msg_id: &str, envelope: &Json) -> Result<(), String> {
        self.0
            .lock()
            .unwrap()
            .push((subject.to_owned(), msg_id.to_owned(), envelope.clone()));
        Ok(())
    }
}

/// The person's partner holds their money and refuses every collect (`insufficient_funds`), counting each ask.
#[derive(Default, Clone)]
struct RefusingPartner(Arc<Mutex<u32>>);

impl UsagePayment for RefusingPartner {
    fn read(&self, _: &str, _: &str, _: Option<&str>) -> Result<HeldBy, PaymentUnavailable> {
        Ok(HeldBy::Partner)
    }
    fn read_available(
        &self,
        _: &str,
        _: &str,
        _: Option<&str>,
    ) -> Result<(HeldBy, Option<String>), PaymentUnavailable> {
        Ok((HeldBy::Partner, Some("100".to_owned())))
    }
    fn collect(
        &self,
        _: &str,
        _: &str,
        _: Amount,
        _: &str,
        _: Option<&str>,
    ) -> Result<Collected, PaymentUnavailable> {
        *self.0.lock().unwrap() += 1;
        Ok(Collected::Refused("insufficient_funds".to_owned()))
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

/// `MemorySelfFreezeRead`: the people frozen, by the freeze's start.
#[derive(Default, Clone)]
struct Freezes(Arc<Mutex<BTreeMap<String, String>>>);

impl SelfFreezeRead for Freezes {
    fn read(&self, user_id: &str) -> Result<Reading, Unavailable> {
        Ok(match self.0.lock().unwrap().get(user_id) {
            Some(since) => Reading::Frozen {
                since: Some(since.clone()),
            },
            None => Reading::Open,
        })
    }
}

/// The mock engine, with every request it is asked recorded (the TypeScript's `calls`).
struct Seen {
    mock: MockProvider,
    asked: Mutex<Vec<Vec<ChatMessage>>>,
}

impl Provider for Seen {
    fn id(&self) -> &str {
        self.mock.id()
    }
    fn capabilities(&self) -> &[Capability] {
        self.mock.capabilities()
    }
    fn engine(&self) -> Engine {
        self.mock.engine()
    }
    fn health(&self, now: Instant) -> Health {
        self.mock.health(now)
    }
    fn complete(&self, request: &CompletionRequest) -> Result<CompletionResult, Failure> {
        self.asked.lock().unwrap().push(request.messages.clone());
        self.mock.complete(request)
    }
    fn embed(&self, request: &EmbedRequest) -> Option<Result<EmbedResult, Failure>> {
        self.mock.embed(request)
    }
}

// ── The world a test runs in ────────────────────────────────────────────────

const USER: &str = "41414141-4141-4141-8141-414141414141";
const OTHER: &str = "42424242-4242-4242-8242-424242424242";
/// A person with no funds, so a stop's settlement is refused by the ledger.
const UNFUNDED: &str = "44444444-4444-4444-8444-444444444444";
const SECRET: &str = "an-agents-background-run-db-test-secret";
const ASK: &str = "TEST: check each market";

fn amt(s: &str) -> Amount {
    parse_amount(s).unwrap()
}

fn now() -> Instant {
    svc_agents::door::system_now()
}

/// `SETTINGS`.
fn settings() -> Settings {
    Settings {
        max_steps: Some(10),
        step_ms: Some(1000),
    }
}

struct World {
    db: TestDb,
    ledger: FakeLedger,
    seen: Arc<Seen>,
    freezes: Freezes,
}

impl World {
    /// `beforeEach`: the mock engine, the probe agent, and 1000 IFC for USER and OTHER.
    fn new() -> Option<World> {
        let db = TestDb::new()?;
        let mut sink = Vec::new();
        svc_agents::migrate::run(&db.url, false, &mut sink).unwrap();
        let w = World {
            db,
            ledger: FakeLedger::default(),
            seen: Arc::new(Seen {
                mock: MockProvider::new(
                    MockOptions {
                        id: Some("primary".to_owned()),
                        ..MockOptions::default()
                    },
                    now,
                ),
                asked: Mutex::new(Vec::new()),
            }),
            freezes: Freezes::default(),
        };
        // `runtime.registerAgent(PROBE)`.
        let raw = r#"{"agentId":"probe","version":1,"capacityMode":"confirm_each","tools":[{"name":"trade.quote","module":"trade","mode":"read"}],"limits":{"maxActionsPerSession":50,"maxOutputTokensPerCall":64,"maxSpendPerSession":null,"allowedModules":["trade"],"allowedTasks":["plan"]}}"#;
        let stored =
            serialise_guardrail(&parse_guardrail(&json::parse(raw).unwrap()).unwrap()).compact();
        w.db.client()
            .execute(
                "INSERT INTO agents.agent_definitions (agent_id, version, guardrail, enabled) VALUES ('probe', 1, $1::text::jsonb, true)",
                &[&stored],
            )
            .unwrap();
        w.ledger.deposit(USER, amt("1000"));
        w.ledger.deposit(OTHER, amt("1000"));
        Some(w)
    }

    /// `createAgentsRouter(deps(overrides))`: the real runtime and meter (metering on, the ledger's own charge unless
    /// `payment` says otherwise), the deterministic engine, and the settings given.
    fn door(&self, settings: Settings, payment: Box<dyn UsagePayment>) -> AgentsDoor {
        let table = parse_routing_table(
            r#"{"routes":[{"task":"plan","providerId":"primary","model":"reasoning-lg","maxOutputTokens":64,"price":{"inputPerMillion":"3","outputPerMillion":"15"}}]}"#,
        )
        .unwrap();
        let mut m = Metering::unwired("IFC", 60);
        m.enabled = true;
        m.ledger = Box::new(self.ledger.clone());
        m.payment = payment;
        m.bus = Box::new(FakeBus::default());
        let mut rt = Runtime::unwired();
        rt.spend = false;
        rt.self_freeze = Some(Box::new(self.freezes.clone()));
        let env: BTreeMap<String, String> = [
            ("APP_ENV", "test"),
            ("NODE_ENV", "test"),
            ("INTAFACED_SCREENING_FAIL_CLOSED", "off"),
            ("INTAFACED_UNSIGNED_SANCTIONS_ROWS", "off"),
        ]
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect();
        AgentsDoor::new(DoorConfig {
            edge_secret: SECRET.to_owned(),
            services: ServiceAuth::unwired(),
            env,
            now,
            // The TypeScript suite's pool (`max: 6`): a stop holds its run's lock on one connection while the step's
            // call uses others.
            store: db::open(&self.db.url, "svc-agents", 6, false).unwrap(),
            gateway: GatewaySlice {
                gateway: Arc::new(Gateway::new(vec![self.seen.clone()], table)),
                fee_asset_id: "IFC".to_owned(),
                metering_enabled: Some(true),
                window_minutes: 60,
            },
            ready: ReadyInput::unwired(),
            metering: m,
            runtime: rt,
            background: settings,
            advisors: svc_agents::advisors::Advisors::unwired(),
            team: svc_agents::team::Team::unwired(),
        })
        .unwrap()
    }

    fn plain(&self) -> AgentsDoor {
        self.door(settings(), Box::new(LedgerPays))
    }

    /// `calls`: every engine call made, by its messages.
    fn calls(&self) -> Vec<Vec<ChatMessage>> {
        self.seen.asked.lock().unwrap().clone()
    }

    fn usage(&self) -> i64 {
        self.db.count("SELECT count(*) FROM agents.usage_records")
    }

    /// The business key each metered call was made under, in order.
    fn metered_keys(&self) -> Vec<String> {
        self.db
            .client()
            .query(
                "SELECT request_id FROM agents.usage_records ORDER BY request_id",
                &[],
            )
            .unwrap()
            .iter()
            .map(|r| r.get(0))
            .collect()
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

/// `advanceSessionRuns(sql, runtime, 0)`.
fn tick(door: &AgentsDoor) {
    let x = Rt {
        rt: door.runtime(),
        pool: door.store().pool().unwrap(),
        gateway: &door.gateway().gateway,
        m: door.metering(),
        now: now(),
    };
    background::advance(&x, 0, 50).unwrap();
}

// ── The door ────────────────────────────────────────────────────────────────

fn signed(user: &str) -> Vec<(String, String)> {
    let raw = Json::obj([
        ("sub", Json::str(user)),
        ("userId", Json::str(user)),
        ("sid", Json::str("43434343-4343-4343-8343-434343434343")),
        (
            "scopes",
            Json::Array(vec![Json::str("agents:read"), Json::str("agents:execute")]),
        ),
        ("tier", Json::str("none")),
        ("mfa", Json::Bool(false)),
        ("expiresAt", Json::str("2099-01-01T00:00:00.000Z")),
    ])
    .compact();
    let sig = edge::sign(&raw, SECRET, "DE").unwrap();
    vec![
        ("x-intafaced-principal".to_owned(), raw),
        ("x-intafaced-principal-sig".to_owned(), sig),
        ("x-intafaced-region".to_owned(), "DE".to_owned()),
    ]
}

fn call(door: &AgentsDoor, user: &str, path: &str, input: &Json, query: bool) -> (u16, Json) {
    let headers = signed(user);
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
        let mut headers = headers;
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
    let s = |v: Option<&Json>| match v {
        Some(Json::String(c)) => c.clone(),
        _ => panic!("no string: {}", answer.1.compact()),
    };
    (
        s(e.get("data").and_then(|d| d.get("code"))),
        s(e.get("message")),
    )
}

fn s(v: &Json, key: &str) -> String {
    match v.get(key) {
        Some(Json::String(t)) => t.clone(),
        other => panic!("{key} is not a string: {other:?}"),
    }
}

fn n(v: &Json, key: &str) -> f64 {
    match v.get(key) {
        Some(Json::Number(x)) => *x,
        other => panic!("{key} is not a number: {other:?}"),
    }
}

fn arr<'a>(v: &'a Json, key: &str) -> &'a [Json] {
    match v.get(key) {
        Some(Json::Array(a)) => a,
        other => panic!("{key} is not an array: {other:?}"),
    }
}

fn step_states(run: &Json) -> Vec<String> {
    arr(run, "steps").iter().map(|st| s(st, "state")).collect()
}

fn open_session(door: &AgentsDoor, user: &str) -> String {
    s(
        &ok(call(
            door,
            user,
            "session.open",
            &Json::obj([("agentId", Json::str("probe"))]),
            false,
        )),
        "id",
    )
}

fn start_input(session: &str, request_id: &str, steps: i64, notice: &str) -> Json {
    Json::obj([
        ("sessionId", Json::str(session)),
        ("requestId", Json::str(request_id)),
        ("task", Json::str("plan")),
        ("ask", Json::str(ASK)),
        ("steps", Json::int(steps)),
        ("notice", Json::str(notice)),
    ])
}

/// `begin(steps, requestId, notice)`: USER opens a session and starts a run on it.
fn begin(door: &AgentsDoor, steps: i64, request_id: &str, notice: &str) -> Json {
    let session = open_session(door, USER);
    ok(call(
        door,
        USER,
        "run.background.start",
        &start_input(&session, request_id, steps, notice),
        false,
    ))
}

fn by_id(run_id: &str) -> Json {
    Json::obj([("runId", Json::str(run_id))])
}

fn get(door: &AgentsDoor, user: &str, run_id: &str) -> Json {
    ok(call(door, user, "run.background.get", &by_id(run_id), true))
}

fn user_says(text: &str) -> ChatMessage {
    ChatMessage {
        role: Role::User,
        content: text.to_owned(),
    }
}

fn assistant(text: &str) -> ChatMessage {
    ChatMessage {
        role: Role::Assistant,
        content: text.to_owned(),
    }
}

// ── The cases ───────────────────────────────────────────────────────────────

#[test]
fn a_background_run_goes_on_without_the_caller_one_metered_call_per_step_completes_and_is_announced_once()
 {
    let w = world_or_skip!();
    let door = w.plain();
    let run = begin(&door, 2, "background:db:run", "email");
    assert_eq!(
        (
            s(&run, "state").as_str(),
            n(&run, "stepsTotal"),
            s(&run, "notice").as_str()
        ),
        ("queued", 2.0, "email")
    );
    assert!(arr(&run, "steps").is_empty());
    let run_id = s(&run, "runId");

    // The same request id again is that run; nothing new is made.
    let again = ok(call(
        &door,
        USER,
        "run.background.start",
        &Json::obj([
            ("sessionId", Json::str(s(&run, "sessionId"))),
            ("requestId", Json::str("background:db:run")),
            ("task", Json::str("plan")),
            ("ask", Json::str("TEST: other")),
            ("steps", Json::int(2)),
            ("notice", Json::str("inapp")),
        ]),
        false,
    ));
    assert_eq!(s(&again, "runId"), run_id);

    tick(&door);
    assert_eq!(s(&get(&door, USER, &run_id), "state"), "running");
    tick(&door);
    tick(&door);
    tick(&door);
    let done = get(&door, USER, &run_id);
    assert_eq!(s(&done, "state"), "completed");
    assert_eq!(step_states(&done), ["done", "done"]);
    let second = s(&arr(&done, "steps")[1], "reply");
    assert_eq!(s(&done, "reply"), second);
    // One call per step, each under its own business key, each metered once.
    assert_eq!(
        w.metered_keys(),
        [format!("bg:{run_id}:1"), format!("bg:{run_id}:2")]
    );
    assert_eq!(w.usage(), 2);
    // The second step goes on from the first one's stored reply.
    let calls = w.calls();
    assert_eq!(calls.len(), 2);
    let first = s(&arr(&done, "steps")[0], "reply");
    assert_eq!(
        calls[1],
        [
            user_says(ASK),
            assistant(&first),
            user_says("Go on with step 2 of 2.")
        ]
    );

    let bus = FakeBus::default();
    let pool = door.store().pool().unwrap();
    assert_eq!(
        background::publish_completed(pool, &bus, "svc-agents", now(), 100).unwrap(),
        1
    );
    assert_eq!(
        background::publish_completed(pool, &bus, "svc-agents", now(), 100).unwrap(),
        0
    );
    let published = bus.0.lock().unwrap().clone();
    assert_eq!(published.len(), 1);
    let (subject, key, envelope) = &published[0];
    assert_eq!(subject, background::RUN_COMPLETED);
    assert_eq!(key, &format!("agents.run.completed:{run_id}"));
    let payload = envelope.get("payload").unwrap();
    assert_eq!(
        (
            s(payload, "runId"),
            s(payload, "userId"),
            s(payload, "notice"),
            s(payload, "agentId")
        ),
        (
            run_id,
            USER.to_owned(),
            "email".to_owned(),
            "probe".to_owned()
        )
    );
}

#[test]
fn a_paused_run_starts_no_further_step_and_refuses_a_new_request_resumed_it_goes_on_from_the_stored_steps()
 {
    let w = world_or_skip!();
    let door = w.plain();
    let run_id = s(&begin(&door, 5, "background:db:run", "email"), "runId");
    tick(&door); // step 1 in flight
    ok(call(
        &door,
        USER,
        "run.background.pause",
        &by_id(&run_id),
        false,
    ));
    tick(&door); // step 1's call finishes; no step 2
    tick(&door);
    tick(&door);
    let paused = get(&door, USER, &run_id);
    assert_eq!(s(&paused, "state"), "paused");
    assert_eq!(step_states(&paused), ["done"]);
    assert_eq!(w.calls().len(), 1);
    let more = Json::obj([
        ("runId", Json::str(run_id.clone())),
        ("text", Json::str("TEST: and the next one")),
    ]);
    assert_eq!(
        refused(call(&door, USER, "run.background.askMore", &more, false)),
        ("CONFLICT".to_owned(), "agents.run.paused".to_owned())
    );

    let resumed = ok(call(
        &door,
        USER,
        "run.background.resume",
        &by_id(&run_id),
        false,
    ));
    assert_eq!(s(&resumed, "state"), "running");
    assert!(matches!(resumed.get("resumedAt"), Some(Json::String(_))));
    tick(&door); // step 2 in flight
    tick(&door); // step 2 done, step 3 in flight
    let after = get(&door, USER, &run_id);
    assert_eq!(step_states(&after), ["done", "done", "in_flight"]);
    // Step 1 is never called again: step 2 is built on its stored reply.
    assert_eq!(
        w.metered_keys(),
        [format!("bg:{run_id}:1"), format!("bg:{run_id}:2")]
    );
    let calls = w.calls();
    assert_eq!(calls.len(), 2);
    assert_eq!(
        calls[1][1],
        assistant(&s(&arr(&paused, "steps")[0], "reply"))
    );

    // Running, a follow-up is one more step whose messages carry it.
    let grown = ok(call(&door, USER, "run.background.askMore", &more, false));
    assert_eq!(n(&grown, "stepsTotal"), 6.0);
    assert_eq!(
        arr(&grown, "followUps"),
        [Json::str("TEST: and the next one")]
    );
}

#[test]
fn stop_lets_the_call_in_flight_finish_runs_nothing_more_settles_once_and_a_second_stop_returns_the_first_result()
 {
    let w = world_or_skip!();
    let door = w.plain();
    let run_id = s(&begin(&door, 5, "background:db:run", "email"), "runId");
    tick(&door); // step 1 in flight
    tick(&door); // step 1 done, step 2 in flight
    let before = w.ledger.balance(USER);

    let stopped = ok(call(
        &door,
        USER,
        "run.background.stop",
        &by_id(&run_id),
        false,
    ));
    assert_eq!(stopped.get("repeated"), Some(&Json::Bool(false)));
    let run = stopped.get("run").unwrap();
    assert_eq!(s(run, "state"), "stopped");
    assert_eq!(step_states(run), ["done", "done_after_stop"]);
    assert!(matches!(
        arr(run, "steps")[1].get("reply"),
        Some(Json::String(_))
    ));
    assert_eq!(w.calls().len(), 2);
    let result = run.get("stop").unwrap().clone();
    assert_eq!(result.get("unpaid"), Some(&Json::Null));
    let settlements = arr(&result, "settlements");
    assert_eq!(settlements.len(), 1);
    assert_eq!(settlements[0].get("settled"), Some(&Json::Bool(true)));
    // The money invariant: what the person paid is what the house received, and it equals the stop's billed total,
    // which covers the two steps.
    let billed = amt(&s(&result, "billed"));
    assert!(billed > 0);
    assert_eq!(before - w.ledger.balance(USER), billed);
    assert_eq!(w.ledger.house(), billed);

    // Pressed again: the first result, nothing settled or charged again, nothing called.
    let twice = ok(call(
        &door,
        USER,
        "run.background.stop",
        &by_id(&run_id),
        false,
    ));
    assert_eq!(twice.get("repeated"), Some(&Json::Bool(true)));
    assert_eq!(twice.get("run").unwrap().get("stop"), Some(&result));
    assert_eq!(
        format_amount(w.ledger.balance(USER)),
        format_amount(before - billed)
    );
    assert_eq!(w.ledger.house(), billed);

    // Nothing further runs, and every metered call is one stored step.
    tick(&door);
    tick(&door);
    assert_eq!(w.calls().len(), 2);
    assert_eq!(w.usage(), 2);
    assert_eq!(arr(&get(&door, USER, &run_id), "steps").len(), 2);
    // A stopped run takes no more changes.
    assert_eq!(
        refused(call(
            &door,
            USER,
            "run.background.resume",
            &by_id(&run_id),
            false
        )),
        ("CONFLICT".to_owned(), "agents.run.ended".to_owned())
    );
}

/// `toMatchObject({ unpaid: 'agents.window_unpaid', billed: '0', settlements: [] })`.
fn assert_unpaid(stop: &Json) {
    assert_eq!(s(stop, "unpaid"), "agents.window_unpaid");
    assert_eq!(s(stop, "billed"), "0");
    assert!(arr(stop, "settlements").is_empty());
}

#[test]
fn a_stop_whose_window_the_ledger_refuses_for_funds_names_it_unpaid_charges_nothing_and_a_second_stop_returns_the_same()
 {
    let w = world_or_skip!();
    let door = w.plain();
    let session = open_session(&door, UNFUNDED);
    let run = ok(call(
        &door,
        UNFUNDED,
        "run.background.start",
        &start_input(&session, "background:db:unpaid", 3, "inapp"),
        false,
    ));
    let run_id = s(&run, "runId");
    tick(&door); // step 1 in flight
    tick(&door); // step 1 done, step 2 in flight
    let stopped = ok(call(
        &door,
        UNFUNDED,
        "run.background.stop",
        &by_id(&run_id),
        false,
    ));
    let run = stopped.get("run").unwrap();
    assert_eq!(s(run, "state"), "stopped");
    assert_eq!(step_states(run), ["done", "done_after_stop"]);
    let stop = run.get("stop").unwrap().clone();
    assert_unpaid(&stop);
    assert_eq!(w.ledger.house(), 0);
    let twice = ok(call(
        &door,
        UNFUNDED,
        "run.background.stop",
        &by_id(&run_id),
        false,
    ));
    assert_eq!(twice.get("repeated"), Some(&Json::Bool(true)));
    assert_eq!(twice.get("run").unwrap().get("stop"), Some(&stop));
    assert_eq!(w.ledger.house(), 0);
}

#[test]
fn a_stop_whose_window_the_persons_partner_does_not_pay_names_it_unpaid_collects_nothing_and_a_second_stop_returns_the_same()
 {
    let w = world_or_skip!();
    let partner = RefusingPartner::default();
    let door = w.door(settings(), Box::new(partner.clone()));
    let session = open_session(&door, USER);
    let run = ok(call(
        &door,
        USER,
        "run.background.start",
        &start_input(&session, "background:db:partner-unpaid", 3, "inapp"),
        false,
    ));
    let run_id = s(&run, "runId");
    tick(&door);
    tick(&door);
    let stopped = ok(call(
        &door,
        USER,
        "run.background.stop",
        &by_id(&run_id),
        false,
    ));
    let run = stopped.get("run").unwrap();
    assert_eq!(s(run, "state"), "stopped");
    let stop = run.get("stop").unwrap().clone();
    assert_unpaid(&stop);
    assert_eq!(*partner.0.lock().unwrap(), 1);
    // Earned in our book as owed, nothing collected: only the earn is posted for this window.
    assert_eq!(w.ledger.charges(), ["charge.earned"]);
    let twice = ok(call(
        &door,
        USER,
        "run.background.stop",
        &by_id(&run_id),
        false,
    ));
    assert_eq!(twice.get("repeated"), Some(&Json::Bool(true)));
    assert_eq!(twice.get("run").unwrap().get("stop"), Some(&stop));
    assert_eq!(w.ledger.charges(), ["charge.earned"]);
}

#[test]
fn a_follow_up_never_grows_a_run_past_the_most_steps_allowed() {
    let w = world_or_skip!();
    let door = w.plain();
    let run_id = s(&begin(&door, 10, "background:db:cap", "email"), "runId");
    let more = Json::obj([
        ("runId", Json::str(run_id.clone())),
        ("text", Json::str("TEST: one more")),
    ]);
    assert_eq!(
        refused(call(&door, USER, "run.background.askMore", &more, false)),
        (
            "CONFLICT".to_owned(),
            "agents.session_run_steps_over".to_owned()
        )
    );
    assert_eq!(n(&get(&door, USER, &run_id), "stepsTotal"), 10.0);
}

#[test]
fn another_persons_run_id_is_not_found_for_every_read_and_change() {
    let w = world_or_skip!();
    let door = w.plain();
    let run = begin(&door, 3, "background:db:run", "email");
    let run_id = s(&run, "runId");
    let not_found = ("NOT_FOUND".to_owned(), "agents.run_not_found".to_owned());
    assert_eq!(
        refused(call(
            &door,
            OTHER,
            "run.background.get",
            &by_id(&run_id),
            true
        )),
        not_found
    );
    for path in [
        "run.background.stop",
        "run.background.pause",
        "run.background.resume",
    ] {
        assert_eq!(
            refused(call(&door, OTHER, path, &by_id(&run_id), false)),
            not_found,
            "{path}"
        );
    }
    let more = Json::obj([
        ("runId", Json::str(run_id.clone())),
        ("text", Json::str("TEST")),
    ]);
    assert_eq!(
        refused(call(&door, OTHER, "run.background.askMore", &more, false)),
        not_found
    );
    // Starting on someone else's session is refused as not found too.
    let mut theirs = start_input(&s(&run, "sessionId"), "background:db:theirs", 1, "inapp");
    if let Json::Object(fields) = &mut theirs {
        for (k, v) in fields.iter_mut() {
            if k == "ask" {
                *v = Json::str("TEST");
            }
        }
    }
    assert_eq!(
        refused(call(&door, OTHER, "run.background.start", &theirs, false)).0,
        "NOT_FOUND"
    );
    let row = w
        .db
        .client()
        .query_one(
            "SELECT state, stop_result IS NULL FROM agents.session_background_runs WHERE id = $1::text::uuid",
            &[&run_id],
        )
        .unwrap();
    assert_eq!(
        (row.get::<_, String>(0), row.get::<_, bool>(1)),
        ("queued".to_owned(), true)
    );
}

#[test]
fn a_refused_call_stores_the_step_as_refused_and_fails_the_run_on_its_code_nothing_is_metered_for_it()
 {
    let w = world_or_skip!();
    let door = w.plain();
    let run_id = s(&begin(&door, 3, "background:db:run", "email"), "runId");
    tick(&door); // step 1 in flight
    w.seen.mock.break_with(ProviderError {
        message: "upstream is down".to_owned(),
        provider_id: "primary".to_owned(),
        retryable: true,
        status: Some(503),
    });
    tick(&door);
    let failed = get(&door, USER, &run_id);
    assert_eq!(s(&failed, "state"), "failed");
    assert!(
        s(&failed, "failureCode").starts_with("agents."),
        "{}",
        failed.compact()
    );
    assert_eq!(step_states(&failed), ["refused"]);
    assert_eq!(w.usage(), 0);
    // The engine refused (an outage reaches no engine at all here: the gateway knows it is down); nothing is called
    // again and no further step starts.
    let asked = w.calls().len();
    tick(&door);
    assert_eq!(w.calls().len(), asked);
    assert_eq!(step_states(&get(&door, USER, &run_id)), ["refused"]);
}

#[test]
fn blank_owner_values_refuse_a_new_run_by_name_and_a_run_longer_than_the_most_steps_is_refused() {
    let w = world_or_skip!();
    let blank = w.door(
        Settings {
            max_steps: None,
            step_ms: Some(1000),
        },
        Box::new(LedgerPays),
    );
    let session = open_session(&blank, USER);
    let mut input = start_input(&session, "background:db:blank", 1, "inapp");
    if let Json::Object(fields) = &mut input {
        for (k, v) in fields.iter_mut() {
            if k == "ask" {
                *v = Json::str("TEST");
            }
        }
    }
    assert_eq!(
        refused(call(&blank, USER, "run.background.start", &input, false)),
        (
            "PRECONDITION_FAILED".to_owned(),
            "agents.session_run_unset".to_owned()
        )
    );
    let mut long = input.clone();
    if let Json::Object(fields) = &mut long {
        for (k, v) in fields.iter_mut() {
            if k == "steps" {
                *v = Json::int(11);
            }
        }
    }
    assert_eq!(
        refused(call(&w.plain(), USER, "run.background.start", &long, false)),
        (
            "BAD_REQUEST".to_owned(),
            "agents.session_run_steps_over".to_owned()
        )
    );
    assert_eq!(
        w.db.count("SELECT count(*) FROM agents.session_background_runs"),
        0
    );
}

/// J-wallet-13: no agent runs for the person while their own freeze is on; a run they had stays paused until they
/// resume it after the lift.
#[test]
fn the_persons_own_freeze_refuses_a_new_run_and_a_resume_until_it_is_lifted() {
    let w = world_or_skip!();
    let door = w.plain();
    let run_id = s(&begin(&door, 3, "background:db:run", "email"), "runId");
    ok(call(
        &door,
        USER,
        "run.background.pause",
        &by_id(&run_id),
        false,
    ));
    w.freezes
        .0
        .lock()
        .unwrap()
        .insert(USER.to_owned(), "2026-11-20T10:00:00.000Z".to_owned());
    let frozen = (
        "FORBIDDEN".to_owned(),
        "agents.identity.owner_frozen_self".to_owned(),
    );
    assert_eq!(
        refused(call(
            &door,
            USER,
            "run.background.resume",
            &by_id(&run_id),
            false
        )),
        frozen
    );
    let session = open_session(&door, USER);
    assert_eq!(
        refused(call(
            &door,
            USER,
            "run.background.start",
            &start_input(&session, "background:db:frozen", 1, "inapp"),
            false
        )),
        frozen
    );
    w.freezes.0.lock().unwrap().clear();
    assert_eq!(
        s(
            &ok(call(
                &door,
                USER,
                "run.background.resume",
                &by_id(&run_id),
                false
            )),
            "state"
        ),
        "running"
    );
}
