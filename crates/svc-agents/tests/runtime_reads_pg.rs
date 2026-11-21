//! The `runtime` slice's stored runs and reads against a real Postgres (`TEST_DATABASE_URL_AGENTS` or
//! `TEST_DATABASE_URL`, a server whose admin database name ends in `_test`), each test in its own throwaway database
//! migrated by the crate's own runner. Without a URL it skips; with `REQUIRE_POSTGRES=1` it fails.
//!
//! The TypeScript database tests ported case for case onto the Rust code (each test names its source):
//! `runs/runs.db.test.ts` (the stored run, `runRecorded`, `run.complete`/`list`/`get`/`events`, `session.events`),
//! the trace and log cases of `review/review.db.test.ts`, and the hold cases of `spend/store.test.ts`. A case that goes
//! through the TypeScript router goes through the Rust door with a signed principal; one that calls the store or the
//! runtime directly calls the Rust function. The ledger and the bus are fakes; the engine is the deterministic mock.
//!
//! Where the TypeScript swaps a `RunStore` method for one that crashes or loses a race, the Rust store is a set of
//! functions, so the same fault is planted in the database instead: a trigger on `agents.agent_runs` that fails (or
//! skips) exactly the write the TypeScript's stand-in fails, dropped again before the retry.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::too_many_lines,
    reason = "a test: a failure is the point"
)]

mod support;

use std::cell::Cell;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use postgres::{Client, IsolationLevel};

use service_kit::edge;
use service_kit::json::{self, Json};
use service_kit::money::{Amount, format_amount, parse_amount};
use service_kit::pg::Pool;
use service_kit::server::Request;
use service_kit::time::Instant;
use support::TestDb;
use svc_agents::db::{self, Store};
use svc_agents::door::{AgentsDoor, DoorConfig, ServiceAuth, system_now};
use svc_agents::gateway::Gateway;
use svc_agents::gateway::desk::GatewaySlice;
use svc_agents::gateway::providers::{
    ChatMessage, MockOptions, MockProvider, Provider, ProviderError, Role,
};
use svc_agents::gateway::readiness::ReadyInput;
use svc_agents::gateway::routing::{RoutingTable, parse_routing_table, unpriced};
use svc_agents::metering::Metering;
use svc_agents::metering::meter;
use svc_agents::metering::ports::{Bus, Ledger, LedgerError, Recipe};
use svc_agents::metering::spend;
use svc_agents::runtime::guardrails::{parse_guardrail, serialise_guardrail};
use svc_agents::runtime::holds::{self, HoldError, Reservation, ReserveInput};
use svc_agents::runtime::runs::{self, RUN_LEASE_MS, RunInput};
use svc_agents::runtime::{self as rtm, Rt, RunError, Runtime, ThinkInput};

macro_rules! db_or_skip {
    () => {
        match TestDb::new() {
            Some(db) => {
                let mut sink = Vec::new();
                svc_agents::migrate::run(&db.url, false, &mut sink).unwrap();
                db
            }
            None => {
                eprintln!("skipped: no TEST_DATABASE_URL");
                return;
            }
        }
    };
}

// ── The fakes ───────────────────────────────────────────────────────────────

/// `MemoryLedger` as far as these tests read it: each recipe booked once under its key; a fee charge moves the person's
/// available balance to the house.
#[derive(Default)]
struct Book {
    by_key: BTreeMap<String, String>,
    house: Amount,
    available: BTreeMap<String, Amount>,
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
    fn available(&self, user: &str) -> String {
        format_amount(
            self.0
                .lock()
                .unwrap()
                .available
                .get(user)
                .copied()
                .unwrap_or(0),
        )
    }
    fn house(&self) -> String {
        format_amount(self.0.lock().unwrap().house)
    }
}

impl Ledger for FakeLedger {
    fn post_recipe(&self, recipe: &Recipe) -> Result<String, LedgerError> {
        let mut b = self.0.lock().unwrap();
        let key = recipe.idempotency_key();
        if let Some(tx) = b.by_key.get(&key) {
            return Ok(tx.clone());
        }
        let Recipe::FeeCharge {
            user_id, amount, ..
        } = recipe
        else {
            panic!("only the custodial fee charge is expected here, got {recipe:?}");
        };
        let have = b.available.get(user_id).copied().unwrap_or(0);
        if have < *amount {
            return Err(LedgerError {
                code: Some("ledger.insufficient_funds".to_owned()),
                message: format!("Insufficient funds: requested {}", format_amount(*amount)),
            });
        }
        *b.available.entry(user_id.clone()).or_default() -= amount;
        b.house += amount;
        let tx = format!("tx-{}", b.by_key.len() + 1);
        b.by_key.insert(key, tx.clone());
        Ok(tx)
    }
}

/// `MemoryEventBus`.
#[derive(Default, Clone)]
struct FakeBus(Arc<Mutex<Vec<(String, String)>>>);

impl Bus for FakeBus {
    fn publish(&self, subject: &str, msg_id: &str, _: &Json) -> Result<(), String> {
        self.0
            .lock()
            .unwrap()
            .push((subject.to_owned(), msg_id.to_owned()));
        Ok(())
    }
}

// ── The world a test runs in ────────────────────────────────────────────────

const SECRET: &str = "an-agents-run-entity-db-test-secret-32";
const KEY_ID: &str = "33333333-3333-4333-8333-333333333333";
const PROMPT: &str = "TEST: summarise my plan";

/// `runs.db.test.ts`'s table: one priced `plan` route.
const RUNS_TABLE: &str = r#"{"routes":[{"task":"plan","providerId":"primary","model":"reasoning-lg","maxOutputTokens":64,"price":{"inputPerMillion":"3","outputPerMillion":"15"}}]}"#;
/// `review.db.test.ts`'s table: `plan` and `other`, both priced.
const REVIEW_TABLE: &str = r#"{"routes":[{"task":"plan","providerId":"primary","model":"reasoning-lg","maxOutputTokens":64,"price":{"inputPerMillion":"3","outputPerMillion":"15"}},{"task":"other","providerId":"primary","model":"reasoning-lg","maxOutputTokens":64,"price":{"inputPerMillion":"3","outputPerMillion":"15"}}]}"#;

fn probe(max_actions: i64) -> Json {
    json::parse(&format!(
        r#"{{"agentId":"probe","version":1,"capacityMode":"confirm_each","tools":[{{"name":"trade.quote","module":"trade","mode":"read"}}],
            "limits":{{"maxActionsPerSession":{max_actions},"maxOutputTokensPerCall":64,"maxSpendPerSession":null,
            "allowedModules":["trade"],"allowedTasks":["plan"]}}}}"#
    ))
    .unwrap()
}

fn amt(s: &str) -> Amount {
    parse_amount(s).unwrap()
}

static HOLDS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

struct World {
    db: TestDb,
    store: Store,
    ledger: FakeLedger,
    provider: Arc<MockProvider>,
    gateway: Arc<Gateway>,
    door: AgentsDoor,
    m: Metering,
    rt: Runtime,
    hold: PathBuf,
}

fn metering(ledger: &FakeLedger, bus: &FakeBus) -> Metering {
    let mut m = Metering::unwired("IFC", 60);
    m.enabled = true;
    m.ledger = Box::new(ledger.clone());
    m.bus = Box::new(bus.clone());
    m
}

/// `new AgentRuntime(sql, gateway, meter, bus, { feeAssetId: 'IFC', meteringEnabled: true })`: no spend gate.
fn runtime_settings() -> Runtime {
    let mut rt = Runtime::unwired();
    rt.spend = false;
    rt
}

impl World {
    /// The `beforeEach`: the engine, the gateway, the meter, the runtime, `probe` registered and each user funded 1000.
    fn new(db: TestDb, table: RoutingTable, max_actions: i64, users: &[&str]) -> World {
        let hold = std::env::temp_dir().join(format!(
            "runtime-reads-pg-{}-{}.hold",
            std::process::id(),
            HOLDS.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
        ));
        let provider = Arc::new(MockProvider::new(
            MockOptions {
                id: Some("primary".to_owned()),
                hold_file: Some(hold.clone()),
                ..MockOptions::default()
            },
            system_now,
        ));
        let as_provider: Arc<dyn Provider> = provider.clone();
        let gateway = Arc::new(Gateway::new(vec![as_provider], table));
        let ledger = FakeLedger::default();
        let bus = FakeBus::default();
        let env: BTreeMap<String, String> = [
            ("APP_ENV", "test"),
            ("NODE_ENV", "test"),
            ("INTAFACED_SCREENING_FAIL_CLOSED", "off"),
            ("INTAFACED_UNSIGNED_SANCTIONS_ROWS", "off"),
        ]
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect();
        let door = AgentsDoor::new(DoorConfig {
            edge_secret: SECRET.to_owned(),
            services: ServiceAuth::unwired(),
            env,
            now: system_now,
            store: db.store(),
            gateway: GatewaySlice {
                gateway: gateway.clone(),
                fee_asset_id: "IFC".to_owned(),
                metering_enabled: Some(true),
                window_minutes: 60,
            },
            ready: ReadyInput::unwired(),
            metering: metering(&ledger, &bus),
            runtime: runtime_settings(),
            ops: svc_agents::ops::Ops::unwired(),
            background: svc_agents::background::Settings::default(),
            advisors: svc_agents::advisors::Advisors::unwired(),
        })
        .unwrap();
        let g = parse_guardrail(&probe(max_actions)).unwrap();
        db.client()
            .execute(
                "INSERT INTO agents.agent_definitions (agent_id, version, guardrail, enabled) VALUES ('probe', 1, $1::text::jsonb, true)",
                &[&serialise_guardrail(&g).compact()],
            )
            .unwrap();
        for user in users {
            ledger.deposit(user, amt("1000"));
        }
        World {
            store: db.store(),
            db,
            m: metering(&ledger, &bus),
            rt: runtime_settings(),
            ledger,
            provider,
            gateway,
            door,
            hold,
        }
    }

    fn pool(&self) -> &Pool {
        self.store.pool().unwrap()
    }

    /// The runtime as `runtime.think` / `runtime.openSession` are called directly.
    fn rt(&self) -> Rt<'_> {
        Rt {
            rt: &self.rt,
            pool: self.pool(),
            gateway: &self.gateway,
            m: &self.m,
            now: system_now(),
        }
    }

    fn client(&self) -> Client {
        self.db.client()
    }

    fn count(&self, sql: &str) -> i64 {
        self.client().query_one(sql, &[]).unwrap().get(0)
    }

    fn usage_count(&self) -> i64 {
        self.count("SELECT count(*) FROM agents.usage_records")
    }

    fn run_count(&self) -> i64 {
        self.count("SELECT count(*) FROM agents.agent_runs")
    }

    /// `stored`: state, reply, cost (as stored, re-formatted), metered.
    fn stored(&self, run_id: &str) -> (String, Option<String>, Option<String>, Option<bool>) {
        let r = self
            .client()
            .query_one(
                "SELECT state, reply, cost::text, metered FROM agents.agent_runs WHERE id = $1::text::uuid",
                &[&run_id],
            )
            .unwrap();
        (r.get(0), r.get(1), r.get(2), r.get(3))
    }

    /// `trail`: sequence, state, code.
    fn trail(&self, run_id: &str) -> Vec<(i32, String, Option<String>)> {
        self.client()
            .query(
                "SELECT sequence, state, code FROM agents.agent_run_events WHERE run_id = $1::text::uuid ORDER BY sequence",
                &[&run_id],
            )
            .unwrap()
            .iter()
            .map(|r| (r.get(0), r.get(1), r.get(2)))
            .collect()
    }

    fn states(&self, run_id: &str) -> Vec<String> {
        self.trail(run_id).into_iter().map(|t| t.1).collect()
    }

    fn run_id_of(&self, request_id: &str) -> String {
        self.client()
            .query_one(
                "SELECT id::text FROM agents.agent_runs WHERE request_id = $1::text",
                &[&request_id],
            )
            .unwrap()
            .get(0)
    }

    /// A fault planted on `agents.agent_runs`: before an update matching `when`, raise `message` (or, with none, skip
    /// the update as though another writer had changed the row first).
    fn fault(&self, when: &str, message: Option<&str>) {
        let body = message.map_or_else(
            || "RETURN NULL;".to_owned(),
            |m| format!("RAISE EXCEPTION '{m}';"),
        );
        self.client()
            .batch_execute(&format!(
                "CREATE FUNCTION agents.test_fault() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN {body} END $f$;
                 CREATE TRIGGER test_fault BEFORE UPDATE ON agents.agent_runs FOR EACH ROW WHEN ({when})
                   EXECUTE FUNCTION agents.test_fault();"
            ))
            .unwrap();
    }

    fn heal(&self) {
        self.client()
            .batch_execute(
                "DROP TRIGGER test_fault ON agents.agent_runs; DROP FUNCTION agents.test_fault();",
            )
            .unwrap();
    }

    fn call(&self, path: &str, input: &Json, headers: &[(String, String)], post: bool) -> Answer {
        let mut headers = headers.to_vec();
        let (method, url, body) = if post {
            headers.push(("content-type".to_owned(), "application/json".to_owned()));
            ("POST", format!("/trpc/{path}"), input.compact())
        } else {
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
            ("GET", format!("/trpc/{path}?input={enc}"), String::new())
        };
        let res = self.door.handle(&Request {
            method,
            url: &url,
            headers: &headers,
            body: &body,
        });
        Answer(res.status, json::parse(&res.body).unwrap())
    }

    fn query(&self, path: &str, input: &Json, who: &[(String, String)]) -> Answer {
        self.call(path, input, who, false)
    }

    fn mutate(&self, path: &str, input: &Json, who: &[(String, String)]) -> Answer {
        self.call(path, input, who, true)
    }

    fn open(&self, who: &[(String, String)]) -> String {
        let s = self
            .mutate("session.open", &obj([("agentId", Json::str("probe"))]), who)
            .data();
        text(&s, "id")
    }

    /// `run.complete({ sessionId, requestId, task: 'plan', messages })`.
    fn complete(&self, who: &[(String, String)], session: &str, request: &str) -> Answer {
        self.complete_task(who, session, request, "plan")
    }

    fn complete_task(
        &self,
        who: &[(String, String)],
        session: &str,
        request: &str,
        task: &str,
    ) -> Answer {
        self.mutate(
            "run.complete",
            &obj([
                ("sessionId", Json::str(session)),
                ("requestId", Json::str(request)),
                ("task", Json::str(task)),
                (
                    "messages",
                    Json::Array(vec![obj([
                        ("role", Json::str("user")),
                        ("content", Json::str(PROMPT)),
                    ])]),
                ),
            ]),
            who,
        )
    }
}

impl Drop for World {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.hold);
    }
}

fn obj<const N: usize>(fields: [(&str, Json); N]) -> Json {
    Json::obj(fields)
}

fn text(v: &Json, k: &str) -> String {
    match v.get(k) {
        Some(Json::String(s)) => s.clone(),
        other => panic!("{k} is not a string: {other:?} in {}", v.compact()),
    }
}

/// A door's answer: its status and body.
struct Answer(u16, Json);

impl Answer {
    fn data(&self) -> Json {
        assert_eq!(self.0, 200, "{}", self.1.compact());
        self.1
            .get("result")
            .and_then(|r| r.get("data"))
            .cloned()
            .unwrap()
    }

    /// The refusal: its tRPC code and its message.
    fn refused(&self) -> (String, String) {
        assert_ne!(self.0, 200, "{}", self.1.compact());
        let e = self.1.get("error").unwrap();
        let code = e
            .get("data")
            .and_then(|d| d.get("code"))
            .map(|c| match c {
                Json::String(s) => s.clone(),
                _ => panic!("no code"),
            })
            .unwrap();
        (code, text(e, "message"))
    }
}

fn principal(user: &str, scopes: &[&str], kid: Option<&str>) -> Vec<(String, String)> {
    let mut fields = vec![
        ("sub", Json::str(user)),
        ("userId", Json::str(user)),
        ("sid", Json::str("34343434-3434-4434-8434-343434343434")),
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

/// A signed-in person: `agents:read` and `agents:execute`.
fn person(user: &str) -> Vec<(String, String)> {
    principal(user, &["agents:read", "agents:execute"], None)
}

/// An API key holding only the scopes given.
fn key(user: &str, scopes: &[&str]) -> Vec<(String, String)> {
    principal(user, scopes, Some(KEY_ID))
}

/// Keys sorted at every level: Postgres's `jsonb` keeps its own order, and `toEqual` reads none.
fn canonical(v: &Json) -> Json {
    match v {
        Json::Object(fields) => {
            let mut sorted: Vec<(String, Json)> = fields
                .iter()
                .map(|(k, v)| (k.clone(), canonical(v)))
                .collect();
            sorted.sort_by(|a, b| a.0.cmp(&b.0));
            Json::Object(sorted)
        }
        Json::Array(items) => Json::Array(items.iter().map(canonical).collect()),
        other => other.clone(),
    }
}

fn items(v: &Json) -> Vec<Json> {
    match v {
        Json::Array(a) => a.clone(),
        other => panic!("not a list: {}", other.compact()),
    }
}

fn num(v: &Json, k: &str) -> i64 {
    match v.get(k) {
        #[allow(clippy::cast_possible_truncation, reason = "a small whole number")]
        Some(Json::Number(n)) => *n as i64,
        other => panic!("{k} is not a number: {other:?}"),
    }
}

fn messages() -> Vec<ChatMessage> {
    vec![ChatMessage {
        role: Role::User,
        content: PROMPT.to_owned(),
    }]
}

fn think_input<'a>(session: &'a str, request: &'a str, msgs: &'a [ChatMessage]) -> ThinkInput<'a> {
    ThinkInput {
        session_id: session,
        request_id: request,
        task: "plan",
        system: None,
        messages: msgs,
        max_output_tokens: None,
        team_run: false,
    }
}

fn later() -> Instant {
    Instant(system_now().0 + RUN_LEASE_MS + 1)
}

// ── runs/runs.db.test.ts ────────────────────────────────────────────────────

const USER: &str = "31313131-3131-4131-8131-313131313131";
const OTHER: &str = "32323232-3232-4232-8232-323232323232";

fn runs_world(db: TestDb) -> World {
    World::new(db, parse_routing_table(RUNS_TABLE).unwrap(), 20, &[USER])
}

/// `runs.db.test.ts`: "a person run is stored completed with its reply, metered cost and three events; the row is
/// written before the engine runs". The TypeScript reads the runs from inside a wrapped `think`; here the mock engine
/// is parked on its hold file and the runs are read while it waits, before it answers.
#[test]
fn a_person_run_is_stored_completed_with_its_reply_metered_cost_and_three_events_and_the_row_is_written_before_the_engine_runs()
 {
    let db = db_or_skip!();
    let w = runs_world(db);
    let me = person(USER);
    let session = w.open(&me);
    std::fs::write(&w.hold, "hold").unwrap();
    let held = PathBuf::from(format!("{}.held", w.hold.display()));
    let url = w.db.url.clone();
    let hold = w.hold.clone();
    let watcher = std::thread::spawn(move || {
        let until = std::time::Instant::now() + std::time::Duration::from_secs(20);
        while !held.exists() && std::time::Instant::now() < until {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        let seen: Vec<String> = Client::connect(&url, postgres::NoTls)
            .unwrap()
            .query("SELECT state FROM agents.agent_runs", &[])
            .unwrap()
            .iter()
            .map(|r| r.get(0))
            .collect();
        std::fs::remove_file(&hold).unwrap();
        seen
    });
    let ran = w.complete(&me, &session, "runs:db:complete").data();
    let seen_before_engine = watcher.join().unwrap();
    assert_eq!(seen_before_engine, ["running"]);
    let run_id = text(&ran, "runId");
    assert_eq!(ran.get("metered"), Some(&Json::Bool(true)));
    assert!(amt(&text(&ran, "cost")) > 0);
    let (state, reply, cost, metered) = w.stored(&run_id);
    assert_eq!(
        (state.as_str(), reply, metered),
        ("completed", Some(text(&ran, "text")), Some(true))
    );
    assert_eq!(format_amount(amt(&cost.unwrap())), text(&ran, "cost"));
    assert_eq!(
        w.trail(&run_id),
        [
            (1, "admitted".to_owned(), None),
            (2, "running".to_owned(), None),
            (3, "completed".to_owned(), None)
        ]
    );
    let r = w
        .client()
        .query_one(
            "SELECT run_key, session_id::text, user_id FROM agents.agent_runs WHERE id = $1::text::uuid",
            &[&run_id],
        )
        .unwrap();
    assert_eq!(
        (
            r.get::<_, String>(0),
            r.get::<_, String>(1),
            r.get::<_, String>(2)
        ),
        (
            format!("agents:run:{session}:runs:db:complete"),
            session.clone(),
            USER.to_owned()
        )
    );
}

/// `runs.db.test.ts`: "an API key with agents:read reads the person-started run: list, get and events paged by cursor;
/// no prompt text".
#[test]
fn an_api_key_with_agents_read_reads_the_person_started_run_list_get_and_events_paged_by_cursor() {
    let db = db_or_skip!();
    let w = runs_world(db);
    let me = person(USER);
    let session = w.open(&me);
    let ran = w.complete(&me, &session, "runs:db:read").data();
    let run_id = text(&ran, "runId");
    let reader = key(USER, &["agents:read"]);

    let mine = w
        .query("session.mine", &obj([("limit", Json::int(10))]), &reader)
        .data();
    let ids: Vec<String> = items(mine.get("items").unwrap())
        .iter()
        .map(|i| text(i, "id"))
        .collect();
    assert_eq!(ids, std::slice::from_ref(&session));
    let list = w
        .query(
            "run.list",
            &obj([
                ("sessionId", Json::str(session.clone())),
                ("limit", Json::int(10)),
            ]),
            &reader,
        )
        .data();
    let list = items(&list);
    assert_eq!(list.len(), 1);
    assert!(matches!(list[0].get("createdAt"), Some(Json::String(_))));
    assert_eq!(
        list[0].compact(),
        obj([
            ("runId", Json::str(run_id.clone())),
            ("requestId", Json::str("runs:db:read")),
            ("state", Json::str("completed")),
            ("createdAt", list[0].get("createdAt").cloned().unwrap()),
        ])
        .compact()
    );

    let got = w
        .query(
            "run.get",
            &obj([("runId", Json::str(run_id.clone()))]),
            &reader,
        )
        .data();
    assert!(matches!(got.get("createdAt"), Some(Json::String(_))));
    assert!(matches!(got.get("updatedAt"), Some(Json::String(_))));
    assert_eq!(
        canonical(&got),
        canonical(&obj([
            ("runId", Json::str(run_id.clone())),
            ("sessionId", Json::str(session.clone())),
            ("agentId", Json::str("probe")),
            ("requestId", Json::str("runs:db:read")),
            ("task", Json::str("plan")),
            ("state", Json::str("completed")),
            ("reply", ran.get("text").cloned().unwrap()),
            ("cost", ran.get("cost").cloned().unwrap()),
            ("assetId", Json::str("IFC")),
            ("metered", Json::Bool(true)),
            ("provenance", Json::Null),
            ("refusalCodes", Json::Array(vec![])),
            ("createdAt", got.get("createdAt").cloned().unwrap()),
            ("updatedAt", got.get("updatedAt").cloned().unwrap()),
        ]))
    );
    assert!(!got.compact().contains(PROMPT));

    let events = |cursor: Option<&str>| {
        let mut input = vec![
            ("runId".to_owned(), Json::str(run_id.clone())),
            ("limit".to_owned(), Json::int(2)),
        ];
        if let Some(c) = cursor {
            input.push(("cursor".to_owned(), Json::str(c)));
        }
        w.query("run.events", &Json::Object(input), &reader).data()
    };
    let event = |seq: i64, state: &str, page: &Json, i: usize| {
        let e = &items(page.get("events").unwrap())[i];
        assert!(matches!(e.get("occurredAt"), Some(Json::String(_))));
        assert_eq!(
            e.compact(),
            obj([
                ("id", Json::str(format!("{run_id}:{seq}"))),
                ("sequence", Json::int(seq)),
                ("state", Json::str(state)),
                ("code", Json::Null),
                ("occurredAt", e.get("occurredAt").cloned().unwrap()),
            ])
            .compact()
        );
    };
    let page1 = events(None);
    assert_eq!(items(page1.get("events").unwrap()).len(), 2);
    event(1, "admitted", &page1, 0);
    event(2, "running", &page1, 1);
    assert_eq!(text(&page1, "cursor"), "2");
    let page2 = events(Some("2"));
    assert_eq!(items(page2.get("events").unwrap()).len(), 1);
    event(3, "completed", &page2, 0);
    assert_eq!(text(&page2, "cursor"), "3");
    assert_eq!(events(Some("3")).compact(), r#"{"events":[],"cursor":"3"}"#);
}

/// `runs.db.test.ts`: "session.events from a cursor: only the session's later actions, only for the caller".
#[test]
fn session_events_from_a_cursor_are_only_the_sessions_later_actions_only_for_the_caller() {
    let db = db_or_skip!();
    let w = runs_world(db);
    let me = person(USER);
    let session = w.open(&me);
    let elsewhere = w.open(&me);
    let first = w.complete(&me, &session, "runs:db:events:1").data();
    w.complete(&me, &elsewhere, "runs:db:events:elsewhere")
        .data();
    let next = w.complete(&me, &session, "runs:db:events:2").data();
    let reader = key(USER, &["agents:read"]);
    let ask = |who: &[(String, String)], cursor: Option<&str>, limit: i64| {
        let mut input = vec![
            ("sessionId".to_owned(), Json::str(session.clone())),
            ("limit".to_owned(), Json::int(limit)),
        ];
        if let Some(c) = cursor {
            input.push(("cursor".to_owned(), Json::str(c)));
        }
        w.query("session.events", &Json::Object(input), who)
    };
    let rows = |page: &Json| -> Vec<(i64, String, String, String)> {
        items(page.get("events").unwrap())
            .iter()
            .map(|e| {
                (
                    num(e, "sequence"),
                    text(e, "kind"),
                    text(e, "status"),
                    text(e, "sessionId"),
                )
            })
            .collect()
    };
    let costs = |page: &Json| -> Vec<String> {
        items(page.get("events").unwrap())
            .iter()
            .map(|e| text(e, "cost"))
            .collect()
    };
    let ids = |page: &Json| -> Vec<String> {
        items(page.get("events").unwrap())
            .iter()
            .map(|e| text(e, "id"))
            .collect()
    };

    let page1 = ask(&reader, None, 1).data();
    assert_eq!(
        rows(&page1),
        [(
            0,
            "session_open".to_owned(),
            "executed".to_owned(),
            session.clone()
        )]
    );
    assert_eq!(text(&page1, "cursor"), "0");
    let page2 = ask(&reader, Some("0"), 10).data();
    assert_eq!(
        rows(&page2),
        [
            (
                1,
                "completion".to_owned(),
                "executed".to_owned(),
                session.clone()
            ),
            (
                2,
                "completion".to_owned(),
                "executed".to_owned(),
                session.clone()
            ),
        ]
    );
    assert_eq!(costs(&page2), [text(&first, "cost"), text(&next, "cost")]);
    assert_eq!(text(&page2, "cursor"), "2");
    assert_eq!(
        ask(&reader, Some("2"), 10).data().compact(),
        r#"{"events":[],"cursor":"2"}"#
    );

    // A later action is the only thing the saved cursor returns, and it is this session's, not the other one's.
    let later_run = w.complete(&me, &session, "runs:db:events:3").data();
    let page3 = ask(&reader, Some("2"), 10).data();
    let three: Vec<(i64, String, String)> = rows(&page3)
        .into_iter()
        .map(|(s, k, _, id)| (s, k, id))
        .collect();
    assert_eq!(three, [(3, "completion".to_owned(), session.clone())]);
    assert_eq!(costs(&page3), [text(&later_run, "cost")]);
    assert_eq!(text(&page3, "cursor"), "3");
    // The same actions as the owner's own session log, by id.
    let log = w
        .query(
            "session.log",
            &obj([
                ("sessionId", Json::str(session.clone())),
                ("limit", Json::int(50)),
            ]),
            &me,
        )
        .data();
    let log_ids: Vec<String> = items(&log).iter().map(|e| text(e, "id")).collect();
    let all: Vec<String> = [ids(&page1), ids(&page2), ids(&page3)].concat();
    assert_eq!(all, log_ids);
    assert!(!page3.compact().contains(PROMPT));

    assert_eq!(
        ask(&key(OTHER, &["agents:read"]), None, 10).refused(),
        (
            "NOT_FOUND".to_owned(),
            "agents.refused.session_closed".to_owned()
        )
    );
    assert_eq!(
        ask(&key(USER, &["trade:read"]), None, 10).refused().0,
        "FORBIDDEN"
    );
    assert_eq!(
        ask(&reader, Some("x"), 10).refused(),
        (
            "BAD_REQUEST".to_owned(),
            "agents.refused.cursor_invalid".to_owned()
        )
    );
}

/// `runs.db.test.ts`: "reads stay the owner's: another person's key gets agents.run_not_found, a key without
/// agents:read is forbidden, a bad cursor is typed".
#[test]
fn reads_stay_the_owners_and_a_key_never_starts_a_run() {
    let db = db_or_skip!();
    let w = runs_world(db);
    let me = person(USER);
    let session = w.open(&me);
    let ran = w.complete(&me, &session, "runs:db:owner").data();
    let run_id = text(&ran, "runId");
    let other = key(OTHER, &["agents:read"]);
    let not_found = ("NOT_FOUND".to_owned(), "agents.run_not_found".to_owned());

    assert_eq!(
        w.query(
            "run.get",
            &obj([("runId", Json::str(run_id.clone()))]),
            &other
        )
        .refused(),
        not_found
    );
    assert_eq!(
        w.query(
            "run.events",
            &obj([
                ("runId", Json::str(run_id.clone())),
                ("limit", Json::int(5))
            ]),
            &other
        )
        .refused(),
        not_found
    );
    assert_eq!(
        w.query(
            "run.list",
            &obj([
                ("sessionId", Json::str(session.clone())),
                ("limit", Json::int(10))
            ]),
            &other
        )
        .refused()
        .0,
        "NOT_FOUND"
    );
    assert_eq!(
        w.query(
            "run.get",
            &obj([("runId", Json::str(run_id.clone()))]),
            &key(USER, &["trade:read"])
        )
        .refused()
        .0,
        "FORBIDDEN"
    );
    for bad in ["-1", "01"] {
        assert_eq!(
            w.query(
                "run.events",
                &obj([
                    ("runId", Json::str(run_id.clone())),
                    ("cursor", Json::str(bad)),
                    ("limit", Json::int(5))
                ]),
                &key(USER, &["agents:read"])
            )
            .refused(),
            (
                "BAD_REQUEST".to_owned(),
                "agents.refused.cursor_invalid".to_owned()
            ),
            "{bad}"
        );
    }
    // A key never starts a run (owner decision 2026-10-29), and the refused start stores nothing.
    assert_eq!(
        w.complete(
            &key(USER, &["agents:read", "agents:execute"]),
            &session,
            "runs:db:by-key"
        )
        .refused()
        .0,
        "FORBIDDEN"
    );
    assert_eq!(w.run_count(), 1);
    let (state, reply, _, _) = w.stored(&run_id);
    assert_eq!(
        (state.as_str(), reply),
        ("completed", Some(text(&ran, "text")))
    );
}

/// `runs.db.test.ts`: "the same metered request id twice is one run and one usage record; the repeat is refused as a
/// replay and changes nothing".
#[test]
fn the_same_metered_request_id_twice_is_one_run_and_one_usage_record() {
    let db = db_or_skip!();
    let w = runs_world(db);
    let me = person(USER);
    let session = w.open(&me);
    let ran = w.complete(&me, &session, "runs:db:replay").data();
    let run_id = text(&ran, "runId");
    let charged = w.ledger.available(USER);

    assert_eq!(
        w.complete(&me, &session, "runs:db:replay").refused(),
        (
            "BAD_REQUEST".to_owned(),
            "agents.error.request_id_replay".to_owned()
        )
    );
    assert_eq!(w.usage_count(), 1);
    assert_eq!(w.run_count(), 1);
    assert_eq!(w.ledger.available(USER), charged);
    let (state, reply, _, _) = w.stored(&run_id);
    assert_eq!(
        (state.as_str(), reply),
        ("completed", Some(text(&ran, "text")))
    );
    assert_eq!(w.states(&run_id), ["admitted", "running", "completed"]);
}

/// `runs.db.test.ts`: "an unpriced route is refused with agents.price_unset, bills nothing, and the run reads refused
/// with that code".
#[test]
fn an_unpriced_route_is_refused_with_price_unset_bills_nothing_and_the_run_reads_refused() {
    let db = db_or_skip!();
    let w = World::new(
        db,
        unpriced(&parse_routing_table(RUNS_TABLE).unwrap()),
        20,
        &[USER],
    );
    let me = person(USER);
    let session = w.open(&me);
    assert_eq!(
        w.complete(&me, &session, "runs:db:unpriced").refused().1,
        "agents.refused.price_unset"
    );
    let run_id = w.run_id_of("runs:db:unpriced");
    let got = w
        .query(
            "run.get",
            &obj([("runId", Json::str(run_id.clone()))]),
            &key(USER, &["agents:read"]),
        )
        .data();
    assert_eq!(got.get("state"), Some(&Json::str("refused")));
    assert_eq!(got.get("reply"), Some(&Json::Null));
    assert_eq!(got.get("cost"), Some(&Json::Null));
    assert_eq!(
        got.get("refusalCodes").unwrap().compact(),
        r#"["agents.price_unset"]"#
    );
    assert_eq!(w.usage_count(), 0);
    assert_eq!(w.ledger.house(), "0");
    assert_eq!(w.ledger.available(USER), "1000");
    assert_eq!(
        w.trail(&run_id),
        [
            (1, "admitted".to_owned(), None),
            (2, "running".to_owned(), None),
            (
                3,
                "refused".to_owned(),
                Some("agents.price_unset".to_owned())
            )
        ]
    );
}

/// `runs.db.test.ts`: "an engine that does not answer leaves the run failed and unbilled; the same request id then
/// completes the same run".
#[test]
fn an_engine_that_does_not_answer_leaves_the_run_failed_and_the_same_request_id_then_completes_it()
{
    let db = db_or_skip!();
    let w = runs_world(db);
    let me = person(USER);
    let session = w.open(&me);
    w.provider.break_with(ProviderError {
        message: "upstream is down".to_owned(),
        provider_id: "primary".to_owned(),
        retryable: true,
        status: Some(503),
    });
    assert_ne!(w.complete(&me, &session, "runs:db:engine").0, 200);
    let run_id = w.run_id_of("runs:db:engine");
    assert_eq!(w.stored(&run_id), ("failed".to_owned(), None, None, None));
    assert_eq!(
        w.trail(&run_id).last().cloned().unwrap(),
        (
            3,
            "failed".to_owned(),
            Some("agents.provider_unavailable".to_owned())
        )
    );
    assert_eq!(w.usage_count(), 0);
    assert_eq!(w.ledger.available(USER), "1000");

    w.provider.repair();
    let retried = w.complete(&me, &session, "runs:db:engine").data();
    assert_eq!(text(&retried, "runId"), run_id);
    let (state, reply, _, metered) = w.stored(&run_id);
    assert_eq!(
        (state.as_str(), reply, metered),
        ("completed", Some(text(&retried, "text")), Some(true))
    );
    assert_eq!(
        w.states(&run_id),
        ["admitted", "running", "failed", "running", "completed"]
    );
    assert_eq!(w.usage_count(), 1);
    assert_eq!(w.run_count(), 1);
}

/// `runs.db.test.ts`: "a crash after the row is written and before the engine: the retry continues the same run".
/// The TypeScript's `move` that rejects is a trigger that fails every update of the run.
#[test]
fn a_crash_after_the_row_is_written_and_before_the_engine_the_retry_continues_the_same_run() {
    let db = db_or_skip!();
    let w = runs_world(db);
    let me = person(USER);
    let session = w.open(&me);
    w.fault("true", Some("crash after admit"));
    assert_eq!(
        w.complete(&me, &session, "runs:db:crash-admit").refused().0,
        "INTERNAL_SERVER_ERROR"
    );
    w.heal();
    let run_id = w.run_id_of("runs:db:crash-admit");
    assert_eq!(w.stored(&run_id).0, "admitted");
    assert_eq!(w.usage_count(), 0);

    let retried = w.complete(&me, &session, "runs:db:crash-admit").data();
    assert_eq!(text(&retried, "runId"), run_id);
    let (state, reply, _, _) = w.stored(&run_id);
    assert_eq!(
        (state.as_str(), reply),
        ("completed", Some(text(&retried, "text")))
    );
    assert_eq!(w.states(&run_id), ["admitted", "running", "completed"]);
    assert_eq!(w.usage_count(), 1);
}

fn run_input<'a>(session: &'a str, request: &'a str, task: &'a str) -> RunInput<'a> {
    RunInput {
        user_id: USER,
        session_id: session,
        agent_id: "probe",
        request_id: request,
        task,
        asset_id: "IFC",
        provenance_of: None,
    }
}

/// `runs.db.test.ts`: "a crash after the engine answered: inside the lease the retry changes nothing; past it the
/// retry adopts the run as completed and metered, billed once". The `move` to completed that rejects is a trigger.
#[test]
fn a_crash_after_the_engine_answered_inside_the_lease_changes_nothing_past_it_the_run_is_adopted_billed_once()
 {
    let db = db_or_skip!();
    let w = runs_world(db);
    let session = rtm::open_session(&w.rt(), USER, "probe").unwrap().id;
    let msgs = messages();
    let request = "runs:db:crash-engine";
    let input = run_input(&session, request, "plan");
    let think = || rtm::think(&w.rt(), &think_input(&session, request, &msgs));
    w.fault(
        "NEW.state = 'completed'",
        Some("crash before the run was marked"),
    );
    let (_, first) = runs::run_recorded(w.pool(), &input, system_now(), think).unwrap();
    w.heal();
    assert_eq!(first.state, "running");
    assert_eq!(w.usage_count(), 1);
    assert!(meter::has_request(w.pool(), &session, request).unwrap());
    // The usage sits in its open window; it is charged once when the window settles, never by the run.
    let charged = w.ledger.available(USER);

    // Inside the lease the running run may be live: the runtime refuses the replay and the run is left alone.
    assert_eq!(
        w.complete(&person(USER), &session, request).refused(),
        (
            "BAD_REQUEST".to_owned(),
            "agents.error.request_id_replay".to_owned()
        )
    );
    let (state, reply, _, _) = w.stored(&first.id);
    assert_eq!((state.as_str(), reply), ("running", None));
    assert_eq!(w.trail(&first.id).len(), 2);

    let replay = runs::run_recorded(w.pool(), &input, later(), think).unwrap_err();
    assert_eq!(replay.code(), Some("agents.request_id_replay"));
    // The call was charged once into the window, so the run is that charged call, never a refusal that billed nothing.
    assert_eq!(
        w.stored(&first.id),
        (
            "completed".to_owned(),
            Some(String::new()),
            None,
            Some(true)
        )
    );
    assert_eq!(
        w.trail(&first.id).last().cloned().unwrap(),
        (
            3,
            "completed".to_owned(),
            Some("agents.request_id_replay".to_owned())
        )
    );
    assert_eq!(w.usage_count(), 1);
    assert_eq!(w.ledger.available(USER), charged);
    let got = w
        .query(
            "run.get",
            &obj([("runId", Json::str(first.id.clone()))]),
            &key(USER, &["agents:read"]),
        )
        .data();
    assert_eq!(got.get("refusalCodes").unwrap().compact(), "[]");
    // Completed is final: a later retry is refused and the run stays as it is.
    let again = runs::run_recorded(w.pool(), &input, later(), think).unwrap_err();
    assert_eq!(again.code(), Some("agents.request_id_replay"));
    assert_eq!(w.trail(&first.id).len(), 3);
    assert_eq!(w.usage_count(), 1);
}

/// `runs.db.test.ts`: "a crash after the claim and before the meter: past the lease the replay ends the run refused,
/// billed nothing". The store that dies on every move but the one to running is a trigger.
#[test]
fn a_crash_after_the_claim_and_before_the_meter_past_the_lease_ends_the_run_refused_billed_nothing()
{
    let db = db_or_skip!();
    let w = runs_world(db);
    let session = rtm::open_session(&w.rt(), USER, "probe").unwrap().id;
    let request = "runs:db:crash-claim";
    let input = run_input(&session, request, "plan");
    let before = w.ledger.available(USER);
    // The process died inside the call: the claim committed, the engine never returned, nothing was metered.
    w.fault("NEW.state <> 'running'", Some("died"));
    let died = runs::run_recorded(w.pool(), &input, system_now(), || {
        meter::claim_request(w.pool(), &session, request).unwrap();
        Err(RunError::Other("died inside the engine call".to_owned()))
    })
    .unwrap_err();
    w.heal();
    assert_eq!(
        died,
        RunError::Other("died inside the engine call".to_owned())
    );
    let msgs = messages();
    let think = || rtm::think(&w.rt(), &think_input(&session, request, &msgs));
    let replay = runs::run_recorded(w.pool(), &input, later(), think).unwrap_err();
    assert_eq!(replay.code(), Some("agents.request_id_replay"));
    let run_id = w.run_id_of(request);
    assert_eq!(w.stored(&run_id), ("refused".to_owned(), None, None, None));
    assert_eq!(
        w.trail(&run_id).last().cloned().unwrap(),
        (
            3,
            "refused".to_owned(),
            Some("agents.request_id_replay".to_owned())
        )
    );
    assert_eq!(w.usage_count(), 0);
    assert_eq!(w.ledger.available(USER), before);
}

fn transition_invalid(e: &RunError) -> bool {
    matches!(e, RunError::Trpc(t) if t.code == "CONFLICT" && t.message == "agents.run_transition_invalid")
}

/// `runs.db.test.ts`: "a move RS-2 does not allow is agents.run_transition_invalid and leaves the run as it was". The
/// TypeScript's stale `admit` (a retry that read the run before another finished it) is a real race here: the run
/// reads `failed` to every reader while a second connection holds its row; the door's retry reads it stale and waits
/// on the row in its move, the holder writes it back to `completed` and commits, and the retry is refused.
#[test]
fn a_move_rs2_does_not_allow_is_run_transition_invalid_and_leaves_the_run_as_it_was() {
    let db = db_or_skip!();
    let w = runs_world(db);
    let me = person(USER);
    let session = w.open(&me);
    let ran = w.complete(&me, &session, "runs:db:final").data();
    let run_id = text(&ran, "runId");
    let reply = text(&ran, "text");

    let e = runs::move_run(w.pool(), &run_id, "running", &runs::Outcome::default()).unwrap_err();
    assert!(transition_invalid(&e), "{e:?}");
    let e = runs::move_run(w.pool(), &run_id, "admitted", &runs::Outcome::default()).unwrap_err();
    assert!(transition_invalid(&e), "{e:?}");
    let (state, stored_reply, _, _) = w.stored(&run_id);
    assert_eq!(
        (state.as_str(), stored_reply),
        ("completed", Some(reply.clone()))
    );
    assert_eq!(w.trail(&run_id).len(), 3);

    // Two retries racing for one resumable run: the one that read it stale is refused before the engine runs.
    w.client()
        .execute(
            "UPDATE agents.agent_runs SET state = 'failed', reply = NULL WHERE id = $1::text::uuid",
            &[&run_id],
        )
        .unwrap();
    let mut winner = w.client();
    winner.batch_execute("BEGIN").unwrap();
    winner
        .execute(
            "SELECT 1 FROM agents.agent_runs WHERE id = $1::text::uuid FOR UPDATE",
            &[&run_id],
        )
        .unwrap();
    let url = w.db.url.clone();
    let (finished_id, finished_reply) = (run_id.clone(), reply.clone());
    let releaser = std::thread::spawn(move || {
        let mut watch = Client::connect(&url, postgres::NoTls).unwrap();
        let until = std::time::Instant::now() + std::time::Duration::from_secs(20);
        loop {
            let waiting: i64 = watch
                .query_one(
                    "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
                    &[],
                )
                .unwrap()
                .get(0);
            if waiting > 0 || std::time::Instant::now() > until {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        winner
            .execute(
                "UPDATE agents.agent_runs SET state = 'completed', reply = $2::text WHERE id = $1::text::uuid",
                &[&finished_id, &finished_reply],
            )
            .unwrap();
        winner.batch_execute("COMMIT").unwrap();
    });
    let calls = w.provider.call_count();
    assert_eq!(
        w.complete(&me, &session, "runs:db:final").refused(),
        (
            "CONFLICT".to_owned(),
            "agents.run_transition_invalid".to_owned()
        )
    );
    releaser.join().unwrap();
    assert_eq!(w.provider.call_count(), calls);
    assert_eq!(w.usage_count(), 1);
    let (state, stored_reply, _, _) = w.stored(&run_id);
    assert_eq!((state.as_str(), stored_reply), ("completed", Some(reply)));
    assert_eq!(w.trail(&run_id).len(), 3);
}

/// `runs.db.test.ts`: "a research answer keeps its provenance in the write that completes it; no other state holds
/// one (J-agents-10 #4)".
#[test]
fn a_research_answer_keeps_its_provenance_in_the_write_that_completes_it_and_no_other_state_holds_one()
 {
    let db = db_or_skip!();
    let w = runs_world(db);
    let session = w.open(&person(USER));
    let provenance = json::parse(
        r#"{"sources":[{"id":"S1","market":"BTC/USDT","measure":"last_price","value":"64000.5","observedAt":"2026-11-14T08:00:00.000Z"}],
            "observedAt":"2026-11-14T08:00:00.000Z","environment":"TEST",
            "assumptions":["last_trade_at_observation","named_markets_only"],
            "uncertainty":{"level":"TEST high","scale":["TEST low","TEST high"],"unsupportedCount":1,"claimCount":1},
            "unsupported":["mock reply"],"notAdvice":true}"#,
    )
    .unwrap();
    let (run, _) = runs::admit(
        w.pool(),
        USER,
        &session,
        "runs:db:provenance",
        "probe",
        Some("plan"),
    )
    .unwrap();
    // A run that is not completed holds none, even when one is offered.
    let running = runs::move_run(
        w.pool(),
        &run.id,
        "running",
        &runs::Outcome {
            provenance: Some(provenance.clone()),
            ..runs::Outcome::default()
        },
    )
    .unwrap();
    assert_eq!(running.provenance, None);
    let done = runs::move_run(
        w.pool(),
        &run.id,
        "completed",
        &runs::Outcome {
            reply: Some("mock reply".to_owned()),
            provenance: Some(provenance.clone()),
            ..runs::Outcome::default()
        },
    )
    .unwrap();
    let want = canonical(&provenance);
    assert_eq!(done.provenance.as_ref().map(canonical), Some(want.clone()));
    assert_eq!(
        runs::get(w.pool(), &run.id, USER)
            .unwrap()
            .unwrap()
            .0
            .provenance
            .as_ref()
            .map(canonical),
        Some(want.clone())
    );
    let listed = runs::for_session(w.pool(), &session, 10).unwrap();
    assert_eq!(
        listed
            .iter()
            .find(|r| r.id == run.id)
            .unwrap()
            .provenance
            .as_ref()
            .map(canonical),
        Some(want)
    );
    // The table itself refuses provenance on a run that is not completed.
    let (other, _) = runs::admit(
        w.pool(),
        USER,
        &session,
        "runs:db:provenance-2",
        "probe",
        Some("plan"),
    )
    .unwrap();
    let refused = w
        .client()
        .execute(
            "UPDATE agents.agent_runs SET provenance = $1::text::jsonb WHERE id = $2::text::uuid",
            &[&provenance.compact(), &other.id],
        )
        .unwrap_err();
    assert!(
        format!("{refused:?}").contains("agent_runs_provenance_completed_ck"),
        "{refused:?}"
    );
}

/// `runs.db.test.ts`: "one request id names one request: a retry asking another task is agents.request_id_replay and
/// runs nothing". The store whose every `move` crashes is a trigger.
#[test]
fn one_request_id_names_one_request_a_retry_asking_another_task_is_a_replay_and_runs_nothing() {
    let db = db_or_skip!();
    let w = runs_world(db);
    let session = rtm::open_session(&w.rt(), USER, "probe").unwrap().id;
    let request = "runs:db:other-task";
    let msgs = messages();
    let calls = Cell::new(0);
    let think = || {
        calls.set(calls.get() + 1);
        rtm::think(&w.rt(), &think_input(&session, request, &msgs))
    };
    w.fault("true", Some("crash after admit"));
    let crashed = runs::run_recorded(
        w.pool(),
        &run_input(&session, request, "plan"),
        system_now(),
        think,
    )
    .unwrap_err();
    w.heal();
    assert!(
        format!("{crashed:?}").contains("crash after admit"),
        "{crashed:?}"
    );
    let run_id = w.run_id_of(request);

    let replay = runs::run_recorded(
        w.pool(),
        &run_input(&session, request, "summary"),
        system_now(),
        think,
    )
    .unwrap_err();
    match &replay {
        RunError::Agent(d) => {
            assert_eq!(d.error.code, "agents.request_id_replay");
            assert_eq!(d.error.user_key, "agents.error.request_id_replay");
        }
        other => panic!("expected the replay, got {other:?}"),
    }
    assert_eq!(calls.get(), 0);
    let (state, reply, _, _) = w.stored(&run_id);
    assert_eq!((state.as_str(), reply), ("admitted", None));
    assert_eq!(w.trail(&run_id), [(1, "admitted".to_owned(), None)]);
    assert_eq!(w.usage_count(), 0);
}

/// `runs.db.test.ts`: "two retries racing for a running run past its lease: the one that loses the take-over is
/// refused before the engine runs". The store that crashes mid-run is a trigger failing every move but the one to
/// running; the `takeOver` that answers null is a trigger that skips the lease renewal, as a writer that took it first.
#[test]
fn two_retries_racing_for_a_running_run_past_its_lease_the_loser_is_refused_before_the_engine_runs()
{
    let db = db_or_skip!();
    let w = runs_world(db);
    let session = rtm::open_session(&w.rt(), USER, "probe").unwrap().id;
    let request = "runs:db:lost-race";
    let input = run_input(&session, request, "plan");
    w.fault("NEW.state <> 'running'", Some("crash mid-run"));
    let crashed = runs::run_recorded(w.pool(), &input, system_now(), || {
        Err(RunError::Other("crash mid-run".to_owned()))
    })
    .unwrap_err();
    w.heal();
    assert_eq!(crashed, RunError::Other("crash mid-run".to_owned()));
    let run_id = w.run_id_of(request);
    assert_eq!(w.stored(&run_id).0, "running");

    let calls = Cell::new(0);
    let msgs = messages();
    let think = || {
        calls.set(calls.get() + 1);
        rtm::think(&w.rt(), &think_input(&session, request, &msgs))
    };
    w.fault("OLD.state = 'running' AND NEW.state = 'running'", None);
    let lost = runs::run_recorded(w.pool(), &input, later(), think).unwrap_err();
    w.heal();
    assert!(transition_invalid(&lost), "{lost:?}");
    assert_eq!(calls.get(), 0);
    let (state, reply, _, _) = w.stored(&run_id);
    assert_eq!((state.as_str(), reply), ("running", None));
    assert_eq!(w.trail(&run_id).len(), 2);
    assert_eq!(w.usage_count(), 0);
}

// ── review/review.db.test.ts: the trace and the log ─────────────────────────

const R_USER: &str = "41414141-4141-4141-8141-414141414141";
const R_OTHER: &str = "42424242-4242-4242-8242-424242424242";

fn review_world(db: TestDb) -> World {
    World::new(
        db,
        parse_routing_table(REVIEW_TABLE).unwrap(),
        1000,
        &[R_USER, R_OTHER],
    )
}

/// `ranSession`: a session with one completed run and `refusals` refused requests, closed so its window is sealed and
/// settled.
fn ran_session(w: &World, user: &str, refusals: usize) -> (String, Json) {
    let me = person(user);
    let session = w.open(&me);
    let ran = w
        .complete(&me, &session, &format!("review:{session}:ok"))
        .data();
    for n in 0..refusals {
        let refused = w.complete_task(&me, &session, &format!("review:{session}:no:{n}"), "other");
        assert!(
            refused
                .refused()
                .1
                .contains("agents.refused.task_not_allowed"),
            "{}",
            refused.1.compact()
        );
    }
    w.mutate(
        "session.close",
        &obj([("sessionId", Json::str(session.clone()))]),
        &me,
    )
    .data();
    (session, ran)
}

fn stored_counts(w: &World, user: &str) -> BTreeMap<String, i64> {
    w.client()
        .query(
            "SELECT status::text, count(*) FROM agents.agent_actions WHERE user_id = $1::text GROUP BY status",
            &[&user],
        )
        .unwrap()
        .iter()
        .map(|r| (r.get(0), r.get(1)))
        .collect()
}

/// `review.db.test.ts`: "a run trace is the run's timed events and its engine call with tokens and cost; another
/// person's session is not found".
#[test]
fn a_run_trace_is_the_runs_timed_events_and_its_engine_call_and_another_persons_session_is_not_found()
 {
    let db = db_or_skip!();
    let w = review_world(db);
    let (session, ran) = ran_session(&w, R_USER, 2);
    let input = obj([
        ("sessionId", Json::str(session.clone())),
        ("requestId", Json::str(format!("review:{session}:ok"))),
    ]);
    let trace = w.query("run.trace", &input, &person(R_USER)).data();
    let plan = items(trace.get("plan").unwrap());
    let states: Vec<String> = plan.iter().map(|s| text(s, "state")).collect();
    assert_eq!(states, ["admitted", "running", "completed"]);
    assert_eq!(plan.last().unwrap().get("tookMs"), Some(&Json::Null));
    let at = |s: &Json| service_kit::time::js_date(&text(s, "startedAt")).unwrap().0;
    for (i, step) in plan[..plan.len() - 1].iter().enumerate() {
        assert_eq!(num(step, "tookMs"), at(&plan[i + 1]) - at(step));
    }
    let calls = items(trace.get("calls").unwrap());
    assert_eq!(calls.len(), 1);
    assert_eq!(text(&calls[0], "kind"), "completion");
    assert_eq!(text(&calls[0], "status"), "executed");
    assert_eq!(text(&calls[0], "task"), "plan");
    assert_eq!(text(&calls[0], "cost"), text(&ran, "cost"));
    assert!(num(&calls[0], "tookMs") >= 0);
    assert_eq!(text(&trace, "cost"), text(&ran, "cost"));
    assert_ne!(w.query("run.trace", &input, &person(R_OTHER)).0, 200);
    let none = obj([
        ("sessionId", Json::str(session)),
        ("requestId", Json::str("review:none")),
    ]);
    assert!(
        w.query("run.trace", &none, &person(R_USER))
            .refused()
            .1
            .contains("agents.run_not_found")
    );
}

/// `review.db.test.ts`: "the log filters by outcome, counts every row, and exports the whole filtered log past one
/// page".
#[test]
fn the_log_filters_by_outcome_counts_every_row_and_exports_the_whole_filtered_log_past_one_page() {
    let db = db_or_skip!();
    let w = review_world(db);
    ran_session(&w, R_USER, 7);
    ran_session(&w, R_OTHER, 2);
    let me = person(R_USER);
    let counts = stored_counts(&w, R_USER);
    let n = |k: &str| counts.get(k).copied().unwrap_or(0);
    let all = n("executed") + n("refused") + n("failed");
    assert_eq!(
        num(&w.query("log.count", &obj([]), &me).data(), "total"),
        all
    );
    assert_eq!(
        num(
            &w.query("log.count", &obj([("outcome", Json::str("refused"))]), &me)
                .data(),
            "total"
        ),
        7
    );
    let refused = items(
        &w.query(
            "log.mine",
            &obj([("limit", Json::int(500)), ("outcome", Json::str("refused"))]),
            &me,
        )
        .data(),
    );
    assert_eq!(refused.len(), 7);
    assert!(refused.iter().all(|row| text(row, "status") == "refused"
        && row.get("refusalCode") == Some(&Json::str("agents.task_not_allowed"))));

    // Pages of 3: every row once, newest first, the same filter, and a null cursor at the end.
    let read = |outcome: Option<&str>| {
        let mut rows = Vec::new();
        let mut cursor: Option<String> = None;
        loop {
            let mut input = vec![("limit".to_owned(), Json::int(3))];
            if let Some(o) = outcome {
                input.push(("outcome".to_owned(), Json::str(o)));
            }
            if let Some(c) = &cursor {
                input.push(("cursor".to_owned(), Json::str(c.clone())));
            }
            let page = w.query("log.export", &Json::Object(input), &me).data();
            rows.extend(items(page.get("rows").unwrap()));
            match page.get("nextCursor") {
                Some(Json::String(c)) if !c.is_empty() => cursor = Some(c.clone()),
                _ => break,
            }
        }
        rows
    };
    let exported = read(None);
    assert_eq!(i64::try_from(exported.len()).unwrap(), all);
    let ids: std::collections::BTreeSet<String> = exported.iter().map(|r| text(r, "id")).collect();
    assert_eq!(i64::try_from(ids.len()).unwrap(), all);
    assert!(exported.iter().all(|r| text(r, "agentId") == "probe"));
    let mut exported_refused: Vec<String> = read(Some("refused"))
        .iter()
        .map(|r| text(r, "id"))
        .collect();
    exported_refused.sort();
    let mut refused_ids: Vec<String> = refused.iter().map(|r| text(r, "id")).collect();
    refused_ids.sort();
    assert_eq!(exported_refused, refused_ids);
    // The export's last page writes its one audit row; the same request id again writes no second.
    let audit = |request: &str| -> Vec<(String, i32, Json)> {
        w.client()
            .query(
                "SELECT kind, row_count, filter::text FROM agents.agent_log_reads WHERE business_key = $1::text",
                &[&format!("agents:logexport:{R_USER}:{request}")],
            )
            .unwrap()
            .iter()
            .map(|r| {
                (
                    r.get(0),
                    r.get(1),
                    canonical(&json::parse(&r.get::<_, String>(2)).unwrap()),
                )
            })
            .collect()
    };
    for _ in 0..2 {
        w.query(
            "log.export",
            &obj([
                ("limit", Json::int(500)),
                ("outcome", Json::str("refused")),
                ("requestId", Json::str("review-export-1")),
                ("format", Json::str("json")),
            ]),
            &me,
        )
        .data();
    }
    assert_eq!(
        audit("review-export-1"),
        [(
            "export".to_owned(),
            7,
            canonical(&obj([
                ("outcome", Json::str("refused")),
                ("format", Json::str("json"))
            ]))
        )]
    );
    w.query(
        "log.export",
        &obj([
            ("limit", Json::int(3)),
            ("requestId", Json::str("review-export-2")),
        ]),
        &me,
    )
    .data();
    assert!(audit("review-export-2").is_empty());
    assert!(
        w.query("log.export", &obj([]), &me)
            .refused()
            .1
            .contains("agents.refused.log_mine_limit_unset")
    );
    assert!(
        w.query(
            "log.export",
            &obj([
                ("limit", Json::int(3)),
                ("cursor", Json::str("not-a-cursor"))
            ]),
            &me
        )
        .refused()
        .1
        .contains("agents.refused.cursor_invalid")
    );
}

/// `review.db.test.ts`: "an export page boundary inside one millisecond skips no row, and its audit row counts the
/// rows it returned".
#[test]
fn an_export_page_boundary_inside_one_millisecond_skips_no_row_and_its_audit_row_counts_the_rows() {
    let db = db_or_skip!();
    let w = review_world(db);
    // Rows that share a millisecond but not a microsecond: a cursor kept at milliseconds would skip the ones between.
    let mut c = w.client();
    let session: String = c
        .query_one(
            "INSERT INTO agents.agent_sessions (user_id, agent_id, guardrail, guardrail_version)
             VALUES ($1::text, 'probe', '{\"limits\":{},\"tools\":[]}'::jsonb, 1) RETURNING id::text",
            &[&R_USER],
        )
        .unwrap()
        .get(0);
    let times = [
        "2026-11-07T09:00:00.123456Z",
        "2026-11-07T09:00:00.123300Z",
        "2026-11-07T09:00:00.123100Z",
        "2026-11-07T09:00:00.122900Z",
    ];
    for (sequence, at) in times.iter().enumerate() {
        let sequence = i32::try_from(sequence).unwrap();
        c.execute(
            "INSERT INTO agents.agent_actions (session_id, user_id, agent_id, sequence, kind, status, user_message_key, hash, occurred_at)
             VALUES ($1::text::uuid, $2::text, 'probe', $3, 'tool_call', 'executed', 'agents.ok', $4::text, $5::text::timestamptz)",
            &[&session, &R_USER, &sequence, &format!("test-hash-{sequence}"), at],
        )
        .unwrap();
    }
    let me = person(R_USER);
    let mut ids: Vec<String> = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let mut input = vec![
            ("limit".to_owned(), Json::int(1)),
            ("requestId".to_owned(), Json::str("review-export-ms")),
        ];
        if let Some(cur) = &cursor {
            input.push(("cursor".to_owned(), Json::str(cur.clone())));
        }
        let page = w.query("log.export", &Json::Object(input), &me).data();
        ids.extend(
            items(page.get("rows").unwrap())
                .iter()
                .map(|r| text(r, "id")),
        );
        match page.get("nextCursor") {
            Some(Json::String(cur)) if !cur.is_empty() => cursor = Some(cur.clone()),
            _ => break,
        }
    }
    assert_eq!(ids.len(), times.len());
    assert_eq!(
        ids.iter().collect::<std::collections::BTreeSet<_>>().len(),
        times.len()
    );
    let audit: Vec<i32> = c
        .query(
            "SELECT row_count FROM agents.agent_log_reads WHERE business_key = $1::text",
            &[&format!("agents:logexport:{R_USER}:review-export-ms")],
        )
        .unwrap()
        .iter()
        .map(|r| r.get(0))
        .collect();
    assert_eq!(audit, [i32::try_from(times.len()).unwrap()]);
}

// ── spend/store.test.ts: the holds ──────────────────────────────────────────

const S_USER: &str = "11111111-1111-4111-8111-111111111111";
const S_OTHER: &str = "22222222-2222-4222-8222-222222222222";
const SESSION: &str = "33333333-3333-4333-8333-333333333333";
const OTHER_SESSION: &str = "44444444-4444-4444-8444-444444444444";

/// The `beforeEach`: one session of each person's.
fn spend_db(db: &TestDb) -> Store {
    db.client()
        .execute(
            "INSERT INTO agents.agent_sessions (id, user_id, agent_id, guardrail, guardrail_version)
             VALUES ($1::text::uuid, $2::text, 'probe', '{\"limits\":{\"maxSpendPerSession\":null}}'::jsonb, 1),
                    ($3::text::uuid, $4::text, 'probe', '{\"limits\":{}}'::jsonb, 1)",
            &[&SESSION, &S_USER, &OTHER_SESSION, &S_OTHER],
        )
        .unwrap();
    db.store()
}

/// `caps`, with the parts each case changes.
fn set_caps(pool: &Pool, call: &str, session: &str, period: &str) {
    let some = |s: &str| Some(s.to_owned());
    spend::set(
        pool,
        S_USER,
        &spend::SetInput {
            asset_id: some("IFC"),
            per_call: some(call),
            per_session: some(session),
            per_period: some(period),
            period: some("week"),
            idempotency_key: some("set-caps"),
        },
    )
    .unwrap();
}

fn at(iso: &str) -> Instant {
    service_kit::time::js_date(iso).unwrap()
}

fn hold_of<'a>(
    session: &'a str,
    key: &'a str,
    asset: &'a str,
    amount: &str,
    now: Instant,
) -> ReserveInput<'a> {
    ReserveInput {
        user_id: S_USER,
        session_id: session,
        reservation_key: key,
        asset_id: asset,
        amount: amt(amount),
        now,
        agent_cap: None,
        funds: None,
        overage_grace: None,
        team_run: false,
    }
}

fn reserve(pool: &Pool, key: &str, amount: &str, now: Instant) -> Result<Reservation, HoldError> {
    holds::reserve(pool, &hold_of(SESSION, key, "IFC", amount, now))
}

fn denied(r: Result<Reservation, HoldError>) -> svc_agents::runtime::Denied {
    match r {
        Err(HoldError::Denied(d)) => d,
        other => panic!("expected a refusal, got {other:?}"),
    }
}

fn commit(pool: &Pool, key: &str, amount: &str) -> Result<Reservation, HoldError> {
    db::transaction_retrying(pool, IsolationLevel::ReadCommitted, 1, |tx| {
        holds::commit_in(tx, S_USER, key, amt(amount))
    })
}

fn reservations(db: &TestDb) -> Vec<(String, String)> {
    db.client()
        .query(
            "SELECT reservation_key, status FROM agents.spend_reservations WHERE user_id = $1::text ORDER BY reservation_key",
            &[&S_USER],
        )
        .unwrap()
        .iter()
        .map(|r| (r.get(0), r.get(1)))
        .collect()
}

fn pairs(list: &[(&str, &str)]) -> Vec<(String, String)> {
    list.iter()
        .map(|(a, b)| ((*a).to_owned(), (*b).to_owned()))
        .collect()
}

/// `spend/store.test.ts`: "refuses a reservation above the per-call cap and writes nothing".
#[test]
fn refuses_a_reservation_above_the_per_call_cap_and_writes_nothing() {
    let db = db_or_skip!();
    let store = spend_db(&db);
    let pool = store.pool().unwrap();
    set_caps(pool, "2", "3", "4");
    let d = denied(reserve(pool, "too-big", "2.01", at("2026-10-23T12:00:00Z")));
    assert_eq!(d.error.code, "agents.spend_limit");
    assert_eq!(
        db.count("SELECT count(*) FROM agents.spend_reservations"),
        0
    );
}

/// `spend/store.test.ts`: "refuses another user session and a different asset without converting".
#[test]
fn refuses_another_users_session_and_a_different_asset_without_converting() {
    let db = db_or_skip!();
    let store = spend_db(&db);
    let pool = store.pool().unwrap();
    set_caps(pool, "2", "3", "4");
    let d = denied(holds::reserve(
        pool,
        &hold_of(OTHER_SESSION, "k", "IFC", "1", system_now()),
    ));
    assert_eq!(d.error.code, "agents.session_not_found");
    let d = denied(holds::reserve(
        pool,
        &hold_of(SESSION, "k", "OTHER", "1", system_now()),
    ));
    assert_eq!(d.error.code, "agents.spend_limit_invalid");
}

/// `spend/store.test.ts`: "counts a previous week against the session cap but not the new week".
#[test]
fn counts_a_previous_week_against_the_session_cap_but_not_the_new_week() {
    let db = db_or_skip!();
    let store = spend_db(&db);
    let pool = store.pool().unwrap();
    set_caps(pool, "5", "5", "5");
    let last_week = reserve(pool, "last", "5", at("2026-10-18T12:00:00Z")).unwrap();
    assert_eq!(last_week.status, "held");
    let d = denied(reserve(pool, "this", "1", at("2026-10-23T12:00:00Z")));
    assert_eq!(d.error.code, "agents.spend_limit");
    assert!(
        d.params
            .contains(&("scope".to_owned(), Json::str("session"))),
        "{:?}",
        d.params
    );
    holds::release(pool, S_USER, "last").unwrap();
    let again = reserve(pool, "this", "5", at("2026-10-23T12:00:00Z")).unwrap();
    assert_eq!(again.status, "held");
    assert!(!again.replayed);
}

/// `spend/store.test.ts`: "commits once, replays the same amount, and refuses a higher actual".
#[test]
fn commits_once_replays_the_same_amount_and_refuses_another_actual() {
    let db = db_or_skip!();
    let store = spend_db(&db);
    let pool = store.pool().unwrap();
    set_caps(pool, "2", "3", "4");
    reserve(pool, "hold", "2", system_now()).unwrap();
    let committed = commit(pool, "hold", "1.25").unwrap();
    assert_eq!(
        (
            committed.status.as_str(),
            committed.committed_amount,
            committed.amount,
            committed.replayed
        ),
        ("committed", Some(amt("1.25")), amt("2"), false)
    );
    let replay = commit(pool, "hold", "1.250").unwrap();
    assert!(replay.replayed);
    assert_eq!(
        replay.committed_amount.map(format_amount).as_deref(),
        Some("1.25")
    );
    let d = denied(commit(pool, "hold", "1"));
    assert_eq!(d.error.code, "agents.spend_reservation_conflict");
    let d = denied(holds::release(pool, S_USER, "hold"));
    assert_eq!(d.error.code, "agents.spend_reservation_closed");
}

/// `spend/store.test.ts`: "two identical concurrent reservations leave one hold".
#[test]
fn two_identical_concurrent_reservations_leave_one_hold() {
    let db = db_or_skip!();
    let store = spend_db(&db);
    let pool = store.pool().unwrap();
    set_caps(pool, "2", "3", "4");
    let now = at("2026-10-23T12:00:00Z");
    let (a, b) = std::thread::scope(|s| {
        let a = s.spawn(|| reserve(pool, "same", "1", now).unwrap().replayed);
        let b = s.spawn(|| reserve(pool, "same", "1", now).unwrap().replayed);
        (a.join().unwrap(), b.join().unwrap())
    });
    let mut both = [a, b];
    both.sort_unstable();
    assert_eq!(both, [false, true]);
    assert_eq!(
        db.count("SELECT count(*) FROM agents.spend_reservations"),
        1
    );
}

/// `spend/store.test.ts`: "a blank reservation amount refuses and does not insert". The Rust `reserve` takes an
/// `Amount`, so a blank cannot reach it; the blank is refused by the parse `reserve` runs first
/// (`parse_spend_amount(.., "reservation")`), as the TypeScript's `reserve` refuses it, and nothing is inserted.
#[test]
fn a_blank_reservation_amount_refuses_and_does_not_insert() {
    let db = db_or_skip!();
    let store = spend_db(&db);
    let pool = store.pool().unwrap();
    set_caps(pool, "2", "3", "4");
    match spend::parse_spend_amount(Some(" "), "reservation") {
        Err(spend::SpendError::Agent(a)) => assert_eq!(a.code, "agents.spend_limit_unset"),
        other => panic!("expected a refusal, got {other:?}"),
    }
    assert_eq!(
        db.count("SELECT count(*) FROM agents.spend_reservations"),
        0
    );
}

/// `spend/store.test.ts`: "a blank hold age releases nothing".
#[test]
fn a_blank_hold_age_releases_nothing() {
    let db = db_or_skip!();
    let store = spend_db(&db);
    let pool = store.pool().unwrap();
    set_caps(pool, "2", "3", "4");
    let now = at("2026-10-23T12:00:00Z");
    reserve(pool, "stay-blank", "1", at("2020-01-01T00:00:00Z")).unwrap();
    for max_age in [Some(""), Some("   "), None] {
        match holds::release_stale_holds(pool, max_age, now) {
            Err(HoldError::Denied(d)) => {
                assert_eq!(d.error.code, "agents.spend_hold_max_age_unset");
                assert_eq!(d.error.user_key, "agents.refused.spend_hold_max_age_unset");
            }
            other => panic!("expected a refusal for {max_age:?}, got {other:?}"),
        }
    }
    for bad in ["-1", "nope"] {
        match holds::release_stale_holds(pool, Some(bad), now) {
            Err(HoldError::Denied(d)) => assert_eq!(d.error.code, "agents.spend_limit_invalid"),
            other => panic!("expected a refusal for {bad}, got {other:?}"),
        }
    }
    assert_eq!(reservations(&db), pairs(&[("stay-blank", "held")]));
}

/// `spend/store.test.ts`: "releases an old hold with no usage and leaves a younger hold".
#[test]
fn releases_an_old_hold_with_no_usage_and_leaves_a_younger_hold() {
    let db = db_or_skip!();
    let store = spend_db(&db);
    let pool = store.pool().unwrap();
    set_caps(pool, "2", "3", "4");
    let now = at("2026-10-23T12:00:00Z");
    reserve(pool, "old-free", "1", at("2026-10-23T10:00:00Z")).unwrap();
    reserve(pool, "young", "1", at("2026-10-23T11:59:30Z")).unwrap();
    assert_eq!(
        holds::release_stale_holds(pool, Some("3600"), now).unwrap(),
        1
    );
    assert_eq!(
        reservations(&db),
        pairs(&[("old-free", "released"), ("young", "held")])
    );
    assert_eq!(
        holds::release_stale_holds(pool, Some("3600"), now).unwrap(),
        0
    );
}

/// `spend/store.test.ts`: "leaves an old hold when a usage record matches the reservation key".
#[test]
fn leaves_an_old_hold_when_a_usage_record_matches_the_reservation_key() {
    let db = db_or_skip!();
    let store = spend_db(&db);
    let pool = store.pool().unwrap();
    set_caps(pool, "2", "3", "4");
    let now = at("2026-10-23T12:00:00Z");
    reserve(pool, "used-key", "1", at("2026-10-23T10:00:00Z")).unwrap();
    db.client()
        .batch_execute(&format!(
            "INSERT INTO agents.usage_windows (session_id, window_id) VALUES ('{SESSION}', 'w-stale');
             INSERT INTO agents.usage_records (session_id, window_id, request_id, task, provider_id, model,
               input_tokens, output_tokens, input_price_per_million, output_price_per_million)
             VALUES ('{SESSION}', 'w-stale', 'used-key', 'plan', 'primary', 'reasoning-lg', 1, 1, 1, 1);
             INSERT INTO agents.think_claims (session_id, request_id) VALUES ('{SESSION}', 'used-key');"
        ))
        .unwrap();
    assert_eq!(
        holds::release_stale_holds(pool, Some("60"), now).unwrap(),
        0
    );
    assert_eq!(reservations(&db), pairs(&[("used-key", "held")]));
    assert_eq!(
        db.count(&format!(
            "SELECT count(*) FROM agents.think_claims WHERE session_id = '{SESSION}' AND request_id = 'used-key'"
        )),
        1
    );
}

/// `spend/store.test.ts`: "releases an old hold and deletes its think claim in the same transaction".
#[test]
fn releases_an_old_hold_and_deletes_its_think_claim_in_the_same_transaction() {
    let db = db_or_skip!();
    let store = spend_db(&db);
    let pool = store.pool().unwrap();
    set_caps(pool, "2", "3", "4");
    let now = at("2026-10-23T12:00:00Z");
    reserve(pool, "crashed", "1", at("2026-10-23T10:00:00Z")).unwrap();
    reserve(pool, "fresh", "1", now).unwrap();
    db.client()
        .batch_execute(&format!(
            "INSERT INTO agents.think_claims (session_id, request_id) VALUES ('{SESSION}', 'crashed'), ('{SESSION}', 'fresh')"
        ))
        .unwrap();
    assert_eq!(
        holds::release_stale_holds(pool, Some("60"), now).unwrap(),
        1
    );
    assert_eq!(
        reservations(&db),
        pairs(&[("crashed", "released"), ("fresh", "held")])
    );
    let claims: Vec<String> = db
        .client()
        .query(
            "SELECT request_id FROM agents.think_claims WHERE session_id = $1::text::uuid ORDER BY request_id",
            &[&SESSION],
        )
        .unwrap()
        .iter()
        .map(|r| r.get(0))
        .collect();
    assert_eq!(claims, ["fresh"]);
}

/// `spend/store.test.ts`: "treats a zero max age as a real age and keeps a row that is not strictly older".
#[test]
fn treats_a_zero_max_age_as_a_real_age_and_keeps_a_row_that_is_not_strictly_older() {
    let db = db_or_skip!();
    let store = spend_db(&db);
    let pool = store.pool().unwrap();
    set_caps(pool, "2", "3", "4");
    let now = at("2026-10-23T12:00:00.000Z");
    reserve(pool, "exact", "1", now).unwrap();
    reserve(pool, "older", "1", Instant(now.0 - 1)).unwrap();
    assert_eq!(holds::release_stale_holds(pool, Some("0"), now).unwrap(), 1);
    assert_eq!(
        reservations(&db),
        pairs(&[("exact", "held"), ("older", "released")])
    );
}
