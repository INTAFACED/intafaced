//! The own-runs slice's sessions and runs against a real Postgres (`TEST_DATABASE_URL_AGENTS` or `TEST_DATABASE_URL`,
//! a server whose admin database name ends in `_test`), each test in its own throwaway database migrated by the crate's
//! own runner. Without a URL it skips; with `REQUIRE_POSTGRES=1` it fails.
//!
//! Ported case for case, through the `AgentsDoor` with signed principals:
//! - `services/svc-agents/src/own/run.test.ts`, "own agent sessions and runs" (its "own agent limits" block is
//!   `own.limits.*`, own-controls' calls, owed there).
//! - `services/svc-agents/src/own/unpaid.test.ts`, every case.
//! - `services/svc-agents/src/own/access.test.ts`, the `own.trade.draft` case.
//!
//! Each case's setup that is a later slice's call is done as that call does it: `own.limits.set` (own-controls) is its
//! store's row, written in SQL, and `own.usage` (own-controls) is `meter::windows_of`, the one read it answers from.
//! What only those calls' own answers show (`own.limits.get`'s grace) is named at its case as owed to own-controls.
//!
//! The ledger books each charge once under its key against the person's available balance, which the funds read; the
//! engine is the mock, counted as the TypeScript's `calls` counts `gateway.complete`.
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
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

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
    ChatMessage, CompletionRequest, CompletionResult, EmbedRequest, EmbedResult, Failure, Health,
    MockOptions, MockProvider, Provider, Role,
};
use svc_agents::gateway::readiness::ReadyInput;
use svc_agents::gateway::routing::{Capability, Engine, parse_routing_table};
use svc_agents::metering::Metering;
use svc_agents::metering::meter;
use svc_agents::metering::ports::{Bus, Ledger, LedgerError, Recipe};
use svc_agents::own::Own;
use svc_agents::runtime::funds::{Funds, Reading, Unread};
use svc_agents::runtime::{Runtime, estimate_input_tokens, usage_cost};
use svc_agents::self_freeze::{Reading as Freeze, SelfFreezeRead, Unavailable};

const USER: &str = "11111111-1111-4111-8111-111111111111";
const OTHER: &str = "22222222-2222-4222-8222-222222222222";
const KID: &str = "66666666-6666-4666-8666-666666666666";
const SECRET: &str = "an-agents-own-run-test-secret-of-32-plus-chars!";
const SERVICE_SECRET: &str = "an-agents-own-run-service-secret-of-32-plus!!";
const SID: &str = "55555555-5555-4555-8555-555555555555";
const PERSON: [&str; 3] = ["agents:read", "agents:execute", "identity:write"];
const FEE: &str = "USDT";
const ASK: &str = "TEST question";
const INSTRUCTIONS: &str = "Answer TEST questions.";
const TABLE: &str = r#"{"routes":[{"task":"own.run","providerId":"primary","model":"reasoning-md","maxOutputTokens":2048,"price":{"inputPerMillion":"1","outputPerMillion":"5"}}]}"#;
/// One output token a run: a window of a few runs then costs more than one run's worst case (the grace cases).
const TINY: &str = r#"{"routes":[{"task":"own.run","providerId":"primary","model":"reasoning-md","maxOutputTokens":1,"price":{"inputPerMillion":"1","outputPerMillion":"5"}}]}"#;

fn amt(s: &str) -> Amount {
    parse_amount(s).unwrap()
}

/// The worst case of one run of the agent below under `table`: its instructions and the ask, at the output ceiling.
fn worst_of(table: &str) -> Amount {
    let t = parse_routing_table(table).unwrap();
    let route = &t.routes[0];
    let messages = [ChatMessage {
        role: Role::User,
        content: ASK.to_owned(),
    }];
    usage_cost(
        estimate_input_tokens(Some(INSTRUCTIONS), &messages),
        route.max_output_tokens,
        route.price.as_ref().unwrap(),
    )
    .unwrap()
}

// ── The fakes ───────────────────────────────────────────────────────────────

/// `MemorySelfFreezeRead`: nobody frozen.
struct Open;
impl SelfFreezeRead for Open {
    fn read(&self, _: &str) -> Result<Freeze, Unavailable> {
        Ok(Freeze::Open)
    }
}

/// The mock engine, each completion counted (`calls`).
struct Counted {
    mock: MockProvider,
    calls: Arc<AtomicU64>,
}

impl Provider for Counted {
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
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.mock.complete(request)
    }
    fn embed(&self, request: &EmbedRequest) -> Option<Result<EmbedResult, Failure>> {
        self.mock.embed(request)
    }
}

/// Holds each fee charge until `n` have reached it (or a few seconds pass), so two settles of one window overlap.
#[derive(Default, Clone)]
struct Gate(Arc<(Mutex<(usize, usize)>, std::sync::Condvar)>);

impl Gate {
    fn hold(&self, n: usize) {
        *self.0.0.lock().unwrap() = (n, 0);
    }
    fn arrived(&self) -> usize {
        self.0.0.lock().unwrap().1
    }
    fn pass(&self) {
        let (lock, cv) = &*self.0;
        let mut g = lock.lock().unwrap();
        if g.0 == 0 {
            return;
        }
        g.1 += 1;
        cv.notify_all();
        let _ = cv
            .wait_timeout_while(g, std::time::Duration::from_secs(5), |g| g.1 < g.0)
            .unwrap();
    }
}

/// `MemoryLedger` as these tests read it: the person's available balance, the house's fees, each charge once under
/// its key (`fee:agents:<charge key>`), and the TypeScript's `chargeFault`.
#[derive(Default)]
struct Book {
    by_key: BTreeMap<String, String>,
    available: Amount,
    house: Amount,
    fault: bool,
}

#[derive(Default, Clone)]
struct FakeLedger(Arc<Mutex<Book>>, Gate);

impl FakeLedger {
    fn balance(&self) -> Amount {
        self.0.lock().unwrap().available
    }
    fn house(&self) -> Amount {
        self.0.lock().unwrap().house
    }
    fn set(&self, available: Amount) {
        self.0.lock().unwrap().available = available;
    }
    fn tx_of(&self, key: &str) -> Option<String> {
        self.0.lock().unwrap().by_key.get(key).cloned()
    }
}

impl Ledger for FakeLedger {
    fn post_recipe(&self, recipe: &Recipe) -> Result<String, LedgerError> {
        if self.0.lock().unwrap().fault {
            return Err(LedgerError {
                code: Some("ledger.unavailable".to_owned()),
                message: "TEST ledger down".to_owned(),
            });
        }
        self.1.pass();
        let mut b = self.0.lock().unwrap();
        let key = recipe.idempotency_key();
        if let Some(tx) = b.by_key.get(&key) {
            return Ok(tx.clone());
        }
        let Recipe::FeeCharge { amount, .. } = recipe else {
            panic!("only the custodial fee charge is booked here");
        };
        if b.available < *amount {
            return Err(LedgerError {
                code: Some("ledger.insufficient_funds".to_owned()),
                message: format!("Insufficient funds: requested {}", format_amount(*amount)),
            });
        }
        b.available -= amount;
        b.house += amount;
        let tx = format!("tx-{}", b.by_key.len() + 1);
        b.by_key.insert(key, tx.clone());
        Ok(tx)
    }
}

/// The funds a run is checked against: the ledger's available balance for the person.
struct LedgerFunds(FakeLedger);
impl Funds for LedgerFunds {
    fn available(&self, _: &Pool, _: &str, _: &str, _: &str, _: &str) -> Result<Reading, Unread> {
        Ok(Reading::Ledger(self.0.balance()))
    }
}

struct NoBus;
impl Bus for NoBus {
    fn publish(&self, _: &str, _: &str, _: &Json) -> Result<(), String> {
        Ok(())
    }
}

// ── The world ───────────────────────────────────────────────────────────────

struct World {
    db: TestDb,
    store: Store,
    ledger: FakeLedger,
    calls: Arc<AtomicU64>,
}

impl World {
    fn new() -> Option<World> {
        let db = TestDb::new()?;
        let mut sink = Vec::new();
        svc_agents::migrate::run(&db.url, false, &mut sink).unwrap();
        let ledger = FakeLedger::default();
        ledger.set(amt("100"));
        Some(World {
            store: db::open(&db.url, "svc-agents", 6, false).unwrap(),
            db,
            ledger,
            calls: Arc::new(AtomicU64::new(0)),
        })
    }

    fn pool(&self) -> &Pool {
        self.store.pool().unwrap()
    }

    fn calls(&self) -> u64 {
        self.calls.load(Ordering::SeqCst)
    }

    /// `build()`: the router over this world's database, ledger and engine, with `table` and the owner's `grace`.
    fn build(&self, table: &str, grace: Option<Amount>, delay_ms: u64) -> People<'_> {
        let mock = MockProvider::new(
            MockOptions {
                id: Some("primary".to_owned()),
                answer_delay_ms: delay_ms,
                ..MockOptions::default()
            },
            system_now,
        );
        let provider = Arc::new(Counted {
            mock,
            calls: self.calls.clone(),
        });
        let gateway = Arc::new(Gateway::new(
            vec![provider as Arc<dyn Provider>],
            parse_routing_table(table).unwrap(),
        ));
        let mut m = Metering::unwired(FEE, 60);
        m.enabled = true;
        m.ledger = Box::new(self.ledger.clone());
        m.bus = Box::new(NoBus);
        let mut rt = Runtime::unwired();
        rt.funds = Some(Box::new(LedgerFunds(self.ledger.clone())));
        rt.overage_grace = grace;
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
        let door = AgentsDoor::new(DoorConfig {
            edge_secret: SECRET.to_owned(),
            services: ServiceAuth {
                secret: Some(SERVICE_SECRET.to_owned()),
                keys: None,
            },
            env,
            now: system_now,
            store: db::open(&self.db.url, "svc-agents", 6, false).unwrap(),
            gateway: GatewaySlice {
                gateway,
                fee_asset_id: FEE.to_owned(),
                metering_enabled: Some(true),
                window_minutes: 60,
            },
            ready: ReadyInput::unwired(),
            metering: m,
            runtime: rt,
            advisors: svc_agents::advisors::Advisors::unwired(),
            background: svc_agents::background::Settings::default(),
            own: Own::unwired(),
            team: svc_agents::team::Team::unwired(),
        })
        .unwrap();
        People { w: self, door }
    }

    fn people(&self) -> People<'_> {
        self.build(TABLE, None, 0)
    }

    fn count(&self, sql: &str, args: &[&(dyn postgres::types::ToSql + Sync)]) -> i64 {
        self.db.client().query_one(sql, args).unwrap().get(0)
    }

    /// `holds()`: the person's spend reservations' states, oldest first.
    fn holds(&self) -> Vec<String> {
        self.db
            .client()
            .query(
                "SELECT status::text FROM agents.spend_reservations WHERE user_id = $1::text ORDER BY created_at",
                &[&USER],
            )
            .unwrap()
            .iter()
            .map(|r| r.get(0))
            .collect()
    }

    /// `ownSessions()`.
    fn own_sessions(&self) -> i64 {
        self.count(
            "SELECT count(*)::bigint FROM agents.agent_sessions WHERE agent_id LIKE 'own.%'",
            &[],
        )
    }

    fn session_status(&self, id: &str) -> String {
        self.db
            .client()
            .query_one(
                "SELECT status::text FROM agents.agent_sessions WHERE id = $1::text::uuid",
                &[&id],
            )
            .unwrap()
            .get(0)
    }

    /// `own.limits.set` (own-controls), as its store writes the row once its checks pass.
    fn limits_set(&self, id: &str, per_call: &str, per_session: &str, per_period: &str) {
        let canon = |s: &str| format_amount(amt(s));
        self.db
            .client()
            .execute(
                "INSERT INTO agents.own_agent_limits (agent_id, owner_id, per_call, per_session, per_period, period)
                 VALUES ($1::text::uuid, $2::text, $3::text::numeric, $4::text::numeric, $5::text::numeric, 'month')
                 ON CONFLICT (agent_id) DO UPDATE
                    SET per_call = EXCLUDED.per_call, per_session = EXCLUDED.per_session,
                        per_period = EXCLUDED.per_period, updated_at = now()",
                &[&id, &USER, &canon(per_call), &canon(per_session), &canon(per_period)],
            )
            .unwrap();
    }

    /// `own.usage` (own-controls): this agent's sessions' windows, as `meter::windows_of` reads them.
    fn usage(&self, id: &str) -> Vec<meter::WindowView> {
        let m = Metering::unwired(FEE, 60);
        meter::windows_of(&m, self.pool(), USER, &format!("own.{id}"), 10).unwrap()
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

fn principal_headers(user: &str, scopes: &[&str], kid: Option<&str>) -> Vec<(String, String)> {
    let mut fields = vec![
        ("sub".to_owned(), Json::str(user)),
        ("userId".to_owned(), Json::str(user)),
        ("sid".to_owned(), Json::str(SID)),
        (
            "scopes".to_owned(),
            Json::Array(scopes.iter().map(|s| Json::str(*s)).collect()),
        ),
        ("tier".to_owned(), Json::str("none")),
        ("mfa".to_owned(), Json::Bool(false)),
        (
            "expiresAt".to_owned(),
            Json::str("2099-01-01T00:00:00.000Z"),
        ),
    ];
    if let Some(kid) = kid {
        fields.push(("kid".to_owned(), Json::str(kid)));
    }
    let raw = Json::Object(fields).compact();
    let sig = edge::sign(&raw, SECRET, "DE").unwrap();
    vec![
        ("x-intafaced-principal".to_owned(), raw),
        ("x-intafaced-principal-sig".to_owned(), sig),
        ("x-intafaced-region".to_owned(), "DE".to_owned()),
    ]
}

/// What a call answered: its data, or its error's tRPC code, message and cause code.
#[derive(Debug, Clone, PartialEq)]
enum Answer {
    Data(Json),
    Refused {
        code: String,
        message: String,
        body: String,
    },
}

impl Answer {
    fn data(self) -> Json {
        match self {
            Answer::Data(d) => d,
            Answer::Refused { code, message, .. } => panic!("refused {code}: {message}"),
        }
    }
    fn refused(&self) -> (String, String) {
        match self {
            Answer::Refused { code, message, .. } => (code.clone(), message.clone()),
            Answer::Data(d) => panic!("not refused: {}", d.compact()),
        }
    }
    fn message(&self) -> String {
        self.refused().1
    }
    fn code(&self) -> String {
        self.refused().0
    }
    fn is_data(&self) -> bool {
        matches!(self, Answer::Data(_))
    }
}

fn text(v: &Json, key: &str) -> String {
    match v.get(key) {
        Some(Json::String(s)) => s.clone(),
        other => panic!("{key} is not a string: {other:?}"),
    }
}

fn answer_of(status: u16, body: &str) -> Answer {
    let parsed = json::parse(body).unwrap();
    if status == 200 {
        return Answer::Data(parsed.get("result").unwrap().get("data").unwrap().clone());
    }
    let err = parsed.get("error").unwrap();
    Answer::Refused {
        code: text(err.get("data").unwrap(), "code"),
        message: text(err, "message"),
        body: body.to_owned(),
    }
}

#[derive(Clone, Copy)]
enum Who {
    Person,
    Other,
    /// The person's delegated key (`kid`).
    Key,
    /// The person with `agents:read` and `identity:write` only.
    Reader,
}

impl Who {
    fn headers(self) -> Vec<(String, String)> {
        match self {
            Who::Person => principal_headers(USER, &PERSON, None),
            Who::Other => principal_headers(OTHER, &PERSON, None),
            Who::Key => principal_headers(USER, &PERSON, Some(KID)),
            Who::Reader => principal_headers(USER, &["agents:read", "identity:write"], None),
        }
    }
}

fn enc(s: &str) -> String {
    s.bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() {
                char::from(b).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}

fn s(v: &str) -> Json {
    Json::str(v)
}

struct People<'w> {
    w: &'w World,
    door: AgentsDoor,
}

impl People<'_> {
    fn query(&self, who: Who, path: &str, input: &Json) -> Answer {
        let url = format!("/trpc/{path}?input={}", enc(&input.compact()));
        let res = self.door.handle(&Request {
            method: "GET",
            url: &url,
            headers: &who.headers(),
            body: "",
        });
        answer_of(res.status, &res.body)
    }

    fn mutate(&self, who: Who, path: &str, input: &Json) -> Answer {
        let mut headers = who.headers();
        headers.push(("content-type".to_owned(), "application/json".to_owned()));
        let body = input.compact();
        let url = format!("/trpc/{path}");
        let res = self.door.handle(&Request {
            method: "POST",
            url: &url,
            headers: &headers,
            body: &body,
        });
        answer_of(res.status, &res.body)
    }

    /// `agentWith(person, cap)`: a draft with the help search, its instructions and its own cap.
    fn agent_with(&self, cap: Option<&str>) -> String {
        let key = format!(
            "run:{}",
            svc_agents::metering::settle::random_uuid().unwrap()
        );
        let created = self
            .mutate(
                Who::Person,
                "own.create",
                &Json::obj([("template", s("service-starter")), ("createKey", s(&key))]),
            )
            .data();
        let id = text(&created, "id");
        self.save(&id, cap.map_or(Json::Null, s));
        id
    }

    fn save(&self, id: &str, cap: Json) {
        self.mutate(
            Who::Person,
            "own.save",
            &Json::obj([
                ("id", s(id)),
                ("name", s("TEST helper")),
                ("instructions", s(INSTRUCTIONS)),
                ("tools", Json::Array(vec![s("support.kb.search")])),
                ("perSessionCap", cap),
            ]),
        )
        .data();
    }

    fn open(&self, who: Who, id: &str) -> Answer {
        self.mutate(who, "own.session.open", &Json::obj([("id", s(id))]))
    }

    fn session(&self, id: &str) -> String {
        text(&self.open(Who::Person, id).data(), "sessionId")
    }

    fn close(&self, id: &str, session: &str) -> Answer {
        self.mutate(
            Who::Person,
            "own.session.close",
            &Json::obj([("id", s(id)), ("sessionId", s(session))]),
        )
    }

    fn run_as(&self, who: Who, id: &str, session: &str, request: &str) -> Answer {
        self.mutate(
            who,
            "own.run",
            &Json::obj([
                ("id", s(id)),
                ("sessionId", s(session)),
                ("requestId", s(request)),
                ("ask", s(ASK)),
            ]),
        )
    }

    fn run(&self, id: &str, session: &str, request: &str) -> Answer {
        self.run_as(Who::Person, id, session, request)
    }

    fn runs(&self, id: &str, limit: i64) -> Vec<Json> {
        match self
            .query(
                Who::Person,
                "own.runs",
                &Json::obj([("id", s(id)), ("limit", Json::int(limit))]),
            )
            .data()
        {
            Json::Array(rows) => rows,
            other => panic!("not a list: {}", other.compact()),
        }
    }
}

fn cost_of(ran: &Json) -> Amount {
    amt(&text(ran, "cost"))
}

// ── run.test.ts: own agent sessions and runs ────────────────────────────────

/// "refuses a session while no cap is stored, and no session or run exists".
#[test]
fn refuses_a_session_while_no_cap_is_stored_and_no_session_or_run_exists() {
    let w = world_or_skip!();
    let p = w.people();
    let id = p.agent_with(Some("1"));
    assert_eq!(p.open(Who::Person, &id).message(), "agents.spend.cap_unset");
    let capless = p.agent_with(None);
    assert_eq!(
        p.open(Who::Person, &capless).message(),
        "agents.spend.cap_unset"
    );
    assert_eq!(w.own_sessions(), 0);
    assert!(p.runs(&id, 10).is_empty());
}

/// "opens only for the person with agents:execute, and binds the agent's tools and the run task".
#[test]
fn opens_only_for_the_person_with_agents_execute_and_binds_the_agents_tools_and_the_run_task() {
    let w = world_or_skip!();
    let p = w.people();
    let id = p.agent_with(Some("1"));
    w.limits_set(&id, "0.012", "0.02", "5");
    assert_eq!(p.open(Who::Reader, &id).code(), "FORBIDDEN");
    let opened = p.open(Who::Person, &id).data();
    assert_eq!(text(&opened, "agentId"), format!("own.{id}"));
    let row: String =
        w.db.client()
            .query_one(
                "SELECT guardrail::text FROM agents.agent_sessions WHERE id = $1::text::uuid",
                &[&text(&opened, "sessionId")],
            )
            .unwrap()
            .get(0);
    let g = json::parse(&row).unwrap();
    let Some(Json::Array(tools)) = g.get("tools") else {
        panic!("no tools");
    };
    let tools: Vec<(String, String)> = tools
        .iter()
        .map(|t| (text(t, "name"), text(t, "mode")))
        .collect();
    assert_eq!(
        tools,
        vec![("support.kb.search".to_owned(), "read".to_owned())]
    );
    let limits = g.get("limits").unwrap();
    assert_eq!(
        limits.get("allowedTasks"),
        Some(&Json::Array(vec![s("own.run")]))
    );
    assert_eq!(text(limits, "maxSpendPerSession"), "1");
}

/// "admits a run under the caps with its exact cost; the same request id twice is one run and one charge".
#[test]
fn admits_a_run_under_the_caps_with_its_exact_cost_the_same_request_id_twice_is_one_run() {
    let w = world_or_skip!();
    let p = w.people();
    let id = p.agent_with(Some("1"));
    w.limits_set(&id, "0.012", "0.02", "5");
    let session = p.session(&id);
    let ran = p.run(&id, &session, "own-run-1").data();
    assert_eq!(text(&ran, "assetId"), FEE);
    assert!(cost_of(&ran) > 0);
    assert!(cost_of(&ran) <= worst_of(TABLE));
    assert_eq!(
        p.run(&id, &session, "own-run-1").message(),
        "agents.request_id_replay"
    );
    assert_eq!(w.calls(), 1);
    assert_eq!(w.holds(), vec!["committed"]);
    let executed: Vec<Json> = p
        .runs(&id, 10)
        .into_iter()
        .filter(|r| text(r, "status") == "executed")
        .collect();
    assert_eq!(executed.len(), 1);
    assert_eq!(text(&executed[0], "cost"), text(&ran, "cost"));
}

/// "refuses a run whose worst case passes the per-call cap before the engine: bills 0, holds nothing".
#[test]
fn refuses_a_run_whose_worst_case_passes_the_per_call_cap_before_the_engine() {
    let w = world_or_skip!();
    let p = w.people();
    let id = p.agent_with(Some("1"));
    w.limits_set(&id, &format_amount(worst_of(TABLE) - 1), "0.02", "5");
    let session = p.session(&id);
    assert_eq!(
        p.run(&id, &session, "own-call").refused(),
        (
            "FORBIDDEN".to_owned(),
            "agents.spend.cap_exceeded".to_owned()
        )
    );
    assert_eq!(w.calls(), 0);
    assert!(w.holds().is_empty());
    let runs = p.runs(&id, 10);
    assert_eq!(runs.len(), 1);
    assert_eq!(text(&runs[0], "status"), "refused");
    assert_eq!(text(&runs[0], "refusalCode"), "agents.spend.cap_exceeded");
    assert_eq!(text(&runs[0], "cost"), "0");
}

/// "two runs at once whose worst cases together pass the per-session cap: exactly one is admitted, the other bills 0".
#[test]
fn two_runs_at_once_whose_worst_cases_together_pass_the_per_session_cap_admit_exactly_one() {
    let w = world_or_skip!();
    let p = w.build(TABLE, None, 300);
    let worst = worst_of(TABLE);
    let id = p.agent_with(Some("1"));
    w.limits_set(&id, "0.012", &format_amount(worst + worst / 2), "5");
    let session = p.session(&id);
    let (a, b) = std::thread::scope(|scope| {
        let a = scope.spawn(|| p.run(&id, &session, "own-pair-a"));
        let b = scope.spawn(|| p.run(&id, &session, "own-pair-b"));
        (a.join().unwrap(), b.join().unwrap())
    });
    let results = [a, b];
    assert_eq!(results.iter().filter(|r| r.is_data()).count(), 1);
    let refused = results.iter().find(|r| !r.is_data()).unwrap();
    assert_eq!(refused.message(), "agents.spend.cap_exceeded");
    assert_eq!(w.calls(), 1);
    assert_eq!(w.holds(), vec!["committed"]);
    let runs = p.runs(&id, 10);
    let mut statuses: Vec<String> = runs.iter().map(|r| text(r, "status")).collect();
    statuses.sort();
    assert_eq!(statuses, vec!["executed", "refused"]);
    let refused = runs
        .iter()
        .find(|r| text(r, "status") == "refused")
        .unwrap();
    assert_eq!(text(refused, "refusalCode"), "agents.spend.cap_exceeded");
    assert_eq!(text(refused, "cost"), "0");
}

/// "counts every session of the agent this month against the per-month cap".
#[test]
fn counts_every_session_of_the_agent_this_month_against_the_per_month_cap() {
    let w = world_or_skip!();
    let p = w.people();
    let worst = worst_of(TABLE);
    let id = p.agent_with(Some("1"));
    w.limits_set(&id, "0.012", "0.02", "5");
    let first = p.session(&id);
    p.run(&id, &first, "own-month-1").data();
    let spent: String = w
        .db
        .client()
        .query_one(
            "SELECT committed_amount::text FROM agents.spend_reservations WHERE reservation_key = 'own-month-1'",
            &[],
        )
        .unwrap()
        .get(0);
    let used = amt(&spent);
    assert!(used > 0);
    // A fresh session has spent nothing, so one worst case fits the month only if the first session is not counted.
    let second = p.session(&id);
    w.limits_set(&id, "0.012", "0.02", &format_amount(used + worst - 1));
    assert_eq!(
        p.run(&id, &second, "own-month-2").message(),
        "agents.spend.cap_exceeded"
    );
    assert_eq!(w.calls(), 1);
    assert_eq!(w.holds(), vec!["committed"]);
    w.limits_set(&id, "0.012", "0.02", &format_amount(used + worst));
    p.run(&id, &second, "own-month-3").data();
    assert_eq!(w.calls(), 2);
}

/// "applies the agent's cap as it stands at run time, below the person's per-session value".
#[test]
fn applies_the_agents_cap_as_it_stands_at_run_time_below_the_persons_per_session_value() {
    let w = world_or_skip!();
    let p = w.people();
    let id = p.agent_with(Some("1"));
    w.limits_set(&id, "0.012", "0.02", "5");
    let session = p.session(&id);
    p.save(&id, s(&format_amount(worst_of(TABLE) - 1)));
    assert_eq!(
        p.run(&id, &session, "own-live-cap").message(),
        "agents.spend.cap_exceeded"
    );
    assert_eq!(w.calls(), 0);
    assert!(w.holds().is_empty());
}

/// "refuses a delegated key: it cannot set limits, open a session or run". Setting limits is `own.limits.set`,
/// own-controls' call, owed there; the session and the run are refused here.
#[test]
fn refuses_a_delegated_key_it_cannot_open_a_session_or_run() {
    let w = world_or_skip!();
    let p = w.people();
    let id = p.agent_with(Some("1"));
    w.limits_set(&id, "0.012", "0.02", "5");
    let opened = p.open(Who::Key, &id);
    assert_eq!(opened.code(), "FORBIDDEN");
    let Answer::Refused { body, .. } = &opened else {
        unreachable!()
    };
    assert!(body.contains("scope.interactive_only"), "{body}");
    assert_eq!(w.own_sessions(), 0);
    let session = p.session(&id);
    let ran = p.run_as(Who::Key, &id, &session, "own-key");
    assert_eq!(ran.code(), "FORBIDDEN");
    let Answer::Refused { body, .. } = &ran else {
        unreachable!()
    };
    assert!(body.contains("scope.interactive_only"), "{body}");
    assert_eq!(w.calls(), 0);
    assert!(w.holds().is_empty());
}

/// "refuses a run the available balance cannot cover: funds insufficient, the engine never called, nothing billed or
/// held".
#[test]
fn refuses_a_run_the_available_balance_cannot_cover() {
    let w = world_or_skip!();
    w.ledger.set(worst_of(TABLE) - 1);
    let p = w.people();
    let id = p.agent_with(Some("1"));
    w.limits_set(&id, "0.012", "0.02", "5");
    let session = p.session(&id);
    assert_eq!(
        p.run(&id, &session, "own-poor").message(),
        "agents.funds_insufficient"
    );
    assert_eq!(w.calls(), 0);
    assert!(w.holds().is_empty());
    let runs = p.runs(&id, 10);
    assert_eq!(runs.len(), 1);
    assert_eq!(text(&runs[0], "status"), "refused");
    assert_eq!(text(&runs[0], "refusalCode"), "agents.funds_insufficient");
    assert_eq!(text(&runs[0], "cost"), "0");
}

/// "refuses a run once the caps are cleared from under an open session".
#[test]
fn refuses_a_run_once_the_caps_are_cleared_from_under_an_open_session() {
    let w = world_or_skip!();
    let p = w.people();
    let id = p.agent_with(Some("1"));
    w.limits_set(&id, "0.012", "0.02", "5");
    let session = p.session(&id);
    w.db.client()
        .execute(
            "DELETE FROM agents.own_agent_limits WHERE agent_id = $1::text::uuid",
            &[&id],
        )
        .unwrap();
    assert_eq!(
        p.run(&id, &session, "own-cleared").message(),
        "agents.spend.cap_unset"
    );
    assert_eq!(w.calls(), 0);
    assert!(w.holds().is_empty());
}

/// "refuses another person's session, a session of another agent, and a closed session".
#[test]
fn refuses_another_persons_session_a_session_of_another_agent_and_a_closed_session() {
    let w = world_or_skip!();
    let p = w.people();
    let id = p.agent_with(Some("1"));
    let other_agent = p.agent_with(Some("1"));
    w.limits_set(&id, "0.012", "0.02", "5");
    let session = p.session(&id);
    assert_eq!(
        p.run_as(Who::Other, &id, &session, "own-theirs").code(),
        "NOT_FOUND"
    );
    assert_eq!(
        p.run(&other_agent, &session, "own-mixed").refused(),
        (
            "NOT_FOUND".to_owned(),
            "agents.session_not_found".to_owned()
        )
    );
    w.db.client()
        .execute(
            "UPDATE agents.agent_sessions SET status = 'closed', closed_at = now() WHERE id = $1::text::uuid",
            &[&session],
        )
        .unwrap();
    assert_eq!(
        p.run(&id, &session, "own-closed").message(),
        "agents.session_closed"
    );
    assert_eq!(w.calls(), 0);
    assert!(w.holds().is_empty());
}

// ── unpaid.test.ts: a usage window the ledger could not charge ─────────────

/// `ranOnce(fundWith)`: the person funded, their agent with caps, a session open and one run. Starts the balance at
/// `fund` (the TypeScript deposits into a fresh ledger).
fn ran_once<'w>(w: &'w World, p: &People<'w>, fund: &str) -> (String, String, Amount) {
    w.ledger.set(amt(fund));
    let id = p.agent_with(Some("1"));
    w.limits_set(&id, "0.012", "0.5", "5");
    let session = p.session(&id);
    let ran = p.run(&id, &session, "unpaid-run-1").data();
    (id, session, cost_of(&ran))
}

/// `withdrawAllBut(leave)`: all but `leave` of the person's balance held away; returns what gives it back.
fn withdraw_all_but(w: &World, leave: Amount) -> impl Fn() + '_ {
    let held = w.ledger.balance() - leave;
    w.ledger.set(leave);
    move || {
        let now = w.ledger.balance();
        w.ledger.set(now + held);
    }
}

/// `closeUnpaid`: the session closed while the person cannot pay its window: refused, and the window stays unpaid.
fn close_unpaid<'w>(
    w: &'w World,
    p: &People<'_>,
    id: &str,
    session: &str,
    cost: Amount,
) -> impl Fn() + 'w {
    let give_back = withdraw_all_but(w, cost - 1);
    assert_eq!(
        p.close(id, session).refused(),
        ("BAD_REQUEST".to_owned(), "agents.window_unpaid".to_owned())
    );
    give_back
}

fn refused_params(w: &World, session: &str) -> Json {
    let raw: String =
        w.db.client()
            .query_one(
                "SELECT user_message_params::text FROM agents.agent_actions
              WHERE session_id = $1::text::uuid AND status = 'refused'",
                &[&session],
            )
            .unwrap()
            .get(0);
    // `toEqual` reads an object whatever its keys' order; jsonb keeps its own.
    match json::parse(&raw).unwrap() {
        Json::Object(mut fields) => {
            fields.sort_by(|a, b| a.0.cmp(&b.0));
            Json::Object(fields)
        }
        other => other,
    }
}

/// An object with its keys sorted, as `refused_params` reads one.
fn sorted<const N: usize>(fields: [(&str, Json); N]) -> Json {
    let mut fields: Vec<(String, Json)> =
        fields.into_iter().map(|(k, v)| (k.to_owned(), v)).collect();
    fields.sort_by(|a, b| a.0.cmp(&b.0));
    Json::Object(fields)
}

/// "keeps the session open and the window unpaid on its charge key; nothing moves".
#[test]
fn keeps_the_session_open_and_the_window_unpaid_on_its_charge_key_nothing_moves() {
    let w = world_or_skip!();
    let p = w.people();
    let (id, session, cost) = ran_once(&w, &p, "1");
    close_unpaid(&w, &p, &id, &session, cost);
    assert_eq!(w.session_status(&session), "open");
    let windows = w.usage(&id);
    let window = &windows[0];
    assert_eq!(window.session_id, session);
    assert_eq!(window.state, "unpaid");
    assert_eq!(window.amount, Some(cost));
    assert_eq!(window.asset_id, FEE);
    let key = window.charge_key.clone().unwrap();
    assert_eq!(key, format!("agent.usage:{session}:{}", window.window_id));
    assert_eq!(w.ledger.tx_of(&format!("fee:agents:{key}")), None);
    assert_eq!(w.ledger.balance(), cost - 1);
    assert_eq!(w.ledger.house(), 0);
}

/// "with the grace blank, the next run refuses agents.overage_grace_unset before the engine: no claim, no hold, bills
/// 0". That the Limits page reads the grace as blank is `own.limits.get`'s, own-controls' call, owed there.
#[test]
fn with_the_grace_blank_the_next_run_refuses_overage_grace_unset_before_the_engine() {
    let w = world_or_skip!();
    let p = w.people();
    let (id, session, cost) = ran_once(&w, &p, "1");
    close_unpaid(&w, &p, &id, &session, cost);
    let before = w.holds();
    let next = p.session(&id);
    assert_eq!(
        p.run(&id, &next, "unpaid-run-2").refused(),
        (
            "FORBIDDEN".to_owned(),
            "agents.overage_grace_unset".to_owned()
        )
    );
    assert_eq!(w.calls(), 1);
    assert_eq!(w.holds(), before);
    assert_eq!(
        w.count(
            "SELECT count(*)::bigint FROM agents.think_claims WHERE session_id = $1::text::uuid",
            &[&next]
        ),
        0
    );
    let refused = &p.runs(&id, 1)[0];
    assert_eq!(text(refused, "sessionId"), next);
    assert_eq!(text(refused, "status"), "refused");
    assert_eq!(text(refused, "refusalCode"), "agents.overage_grace_unset");
    assert_eq!(text(refused, "cost"), "0");
    // The refusal names what is owed; the retry it made was refused for funds, so nothing moved.
    assert_eq!(
        refused_params(&w, &next),
        sorted([("owed", s(&format_amount(cost))), ("asset", s(FEE))])
    );
    assert_eq!(w.ledger.balance(), cost - 1);
    assert_eq!(w.ledger.house(), 0);
}

/// "with funds back, the next run retries the window on its same charge key first, charges it once, then runs".
#[test]
fn with_funds_back_the_next_run_retries_the_window_on_its_same_charge_key_first() {
    let w = world_or_skip!();
    let p = w.people();
    let (id, session, cost) = ran_once(&w, &p, "1");
    let give_back = close_unpaid(&w, &p, &id, &session, cost);
    let unpaid = w.usage(&id).remove(0);
    give_back();
    let funded = w.ledger.balance();
    let next = p.session(&id);
    let ran = p.run(&id, &next, "unpaid-run-2").data();
    assert_eq!(w.calls(), 2);
    let key = unpaid.charge_key.clone().unwrap();
    assert!(w.ledger.tx_of(&format!("fee:agents:{key}")).is_some());
    assert_eq!(w.ledger.balance(), funded - cost);
    assert_eq!(w.ledger.house(), cost);
    let first = w
        .usage(&id)
        .into_iter()
        .find(|v| v.session_id == session)
        .unwrap();
    assert_eq!(first.state, "settled");
    assert_eq!(first.charge_key, Some(key));
    // Closing both sessions charges the new run's window, and nothing of the first again.
    p.close(&id, &session).data();
    p.close(&id, &next).data();
    assert_eq!(w.ledger.balance(), funded - cost - cost_of(&ran));
    assert_eq!(w.ledger.house(), cost + cost_of(&ran));
    assert_eq!(w.session_status(&session), "closed");
}

/// "with funds back, closing again retries on the same charge key and closes; a third close charges nothing more".
#[test]
fn with_funds_back_closing_again_retries_on_the_same_charge_key_and_closes() {
    let w = world_or_skip!();
    let p = w.people();
    let (id, session, cost) = ran_once(&w, &p, "1");
    let give_back = close_unpaid(&w, &p, &id, &session, cost);
    give_back();
    let funded = w.ledger.balance();
    let closed = p.close(&id, &session).data();
    assert_eq!(text(&closed, "sessionId"), session);
    assert_eq!(text(&closed, "status"), "closed");
    assert_eq!(w.ledger.balance(), funded - cost);
    assert_eq!(text(&p.close(&id, &session).data(), "status"), "closed");
    assert_eq!(w.ledger.balance(), funded - cost);
    assert_eq!(w.ledger.house(), cost);
}

/// "with a grace that covers what is owed, a run whose own worst case the balance covers starts; the window stays
/// unpaid".
#[test]
fn with_a_grace_that_covers_what_is_owed_a_run_the_balance_covers_starts_the_window_stays_unpaid() {
    let w = world_or_skip!();
    let p = w.build(TINY, None, 0);
    let (id, session, first) = ran_once(&w, &p, "1");
    let mut owed = first;
    for request in ["unpaid-run-1b", "unpaid-run-1c"] {
        owed += cost_of(&p.run(&id, &session, request).data());
    }
    // A balance that covers one run's worst case but not the window: the ledger refuses the window for funds.
    assert!(owed - 1 >= worst_of(TINY));
    close_unpaid(&w, &p, &id, &session, owed);
    assert_eq!(w.ledger.balance(), owed - 1);
    let graced = w.build(TINY, Some(owed), 0);
    let next = graced.session(&id);
    let ran = graced.run(&id, &next, "unpaid-run-2").data();
    assert_eq!(text(&ran, "assetId"), FEE);
    assert_eq!(w.calls(), 4);
    let old = w
        .usage(&id)
        .into_iter()
        .find(|v| v.session_id == session)
        .unwrap();
    assert_eq!(old.state, "unpaid");
    assert_eq!(old.amount, Some(owed));
    assert_eq!(w.ledger.house(), 0);
}

/// "a grace never covers the run itself: a balance below its worst case refuses agents.funds_insufficient".
#[test]
fn a_grace_never_covers_the_run_itself() {
    let w = world_or_skip!();
    let p = w.build(TINY, None, 0);
    let (id, session, cost) = ran_once(&w, &p, "1");
    close_unpaid(&w, &p, &id, &session, cost);
    // What is left is below the next run's worst case, whatever the grace forgives of the old window.
    assert_eq!(w.ledger.balance(), cost - 1);
    assert!(cost - 1 < worst_of(TINY));
    let graced = w.build(TINY, Some(cost), 0);
    let next = graced.session(&id);
    assert_eq!(
        graced.run(&id, &next, "unpaid-run-2").refused(),
        (
            "FORBIDDEN".to_owned(),
            "agents.funds_insufficient".to_owned()
        )
    );
    assert_eq!(w.calls(), 1);
    assert_eq!(w.ledger.house(), 0);
}

/// "two settles of one unpaid window at once charge it once and log one settlement".
#[test]
fn two_settles_of_one_unpaid_window_at_once_charge_it_once_and_log_one_settlement() {
    let w = world_or_skip!();
    let p = w.people();
    let (id, session, cost) = ran_once(&w, &p, "1");
    let give_back = close_unpaid(&w, &p, &id, &session, cost);
    give_back();
    let next = p.session(&id);
    w.ledger.1.hold(2);
    std::thread::scope(|scope| {
        let a = scope.spawn(|| p.close(&id, &session));
        let b = scope.spawn(|| p.run(&id, &next, "unpaid-run-2"));
        a.join().unwrap().data();
        b.join().unwrap().data();
    });
    assert_eq!(w.ledger.1.arrived(), 2);
    assert_eq!(w.ledger.house(), cost);
    assert_eq!(
        w.count(
            "SELECT count(*)::bigint FROM agents.agent_actions
              WHERE session_id = $1::text::uuid AND kind = 'usage_settlement' AND status = 'executed'",
            &[&session]
        ),
        1
    );
}

/// "with a grace below what is owed, the next run refuses agents.overage_grace_exceeded naming what is owed and the
/// grace". The Limits page's grace (`own.limits.get`) is own-controls' call, owed there.
#[test]
fn with_a_grace_below_what_is_owed_the_next_run_refuses_overage_grace_exceeded() {
    let w = world_or_skip!();
    let p = w.people();
    let (id, session, cost) = ran_once(&w, &p, "1");
    close_unpaid(&w, &p, &id, &session, cost);
    let graced = w.build(TABLE, Some(cost - 1), 0);
    let next = graced.session(&id);
    assert_eq!(
        graced.run(&id, &next, "unpaid-run-2").refused(),
        (
            "FORBIDDEN".to_owned(),
            "agents.overage_grace_exceeded".to_owned()
        )
    );
    assert_eq!(w.calls(), 1);
    assert_eq!(
        refused_params(&w, &next),
        sorted([
            ("owed", s(&format_amount(cost))),
            ("grace", s(&format_amount(cost - 1))),
            ("asset", s(FEE)),
        ])
    );
}

/// "a ledger fault other than funds on the retry counts the window as owed: the run refuses with its code and its log
/// row".
#[test]
fn a_ledger_fault_other_than_funds_on_the_retry_counts_the_window_as_owed() {
    let w = world_or_skip!();
    let p = w.people();
    let (id, session, cost) = ran_once(&w, &p, "1");
    let give_back = close_unpaid(&w, &p, &id, &session, cost);
    give_back();
    w.ledger.0.lock().unwrap().fault = true;
    let faulty = w.people();
    let next = faulty.session(&id);
    assert_eq!(
        faulty.run(&id, &next, "unpaid-run-2").refused(),
        (
            "FORBIDDEN".to_owned(),
            "agents.overage_grace_unset".to_owned()
        )
    );
    assert_eq!(w.calls(), 1);
    let refused = &faulty.runs(&id, 1)[0];
    assert_eq!(text(refused, "sessionId"), next);
    assert_eq!(text(refused, "status"), "refused");
    assert_eq!(text(refused, "refusalCode"), "agents.overage_grace_unset");
    assert_eq!(text(refused, "cost"), "0");
    let old = w
        .usage(&id)
        .into_iter()
        .find(|v| v.session_id == session)
        .unwrap();
    assert_eq!(old.state, "unpaid");
    assert_eq!(w.ledger.house(), 0);
}

/// "a run in a session whose current window is sealed refuses agents.window_sealed before the engine".
#[test]
fn a_run_in_a_session_whose_current_window_is_sealed_refuses_window_sealed() {
    let w = world_or_skip!();
    let p = w.people();
    let (id, session, cost) = ran_once(&w, &p, "1");
    close_unpaid(&w, &p, &id, &session, cost);
    let graced = w.build(TABLE, Some(cost), 0);
    assert_eq!(
        graced.run(&id, &session, "unpaid-run-2").refused(),
        ("FORBIDDEN".to_owned(), "agents.window_sealed".to_owned())
    );
    assert_eq!(w.calls(), 1);
    assert_eq!(
        w.count(
            "SELECT count(*)::bigint FROM agents.think_claims
              WHERE session_id = $1::text::uuid AND request_id = 'unpaid-run-2'",
            &[&session]
        ),
        0
    );
}

// ── access.test.ts: the order the person asks the agent for ────────────────

/// "the agent drafts one order from the words: side, size, asset and type; anything else is not understood".
#[test]
fn the_agent_drafts_one_order_from_the_words_anything_else_is_not_understood() {
    let w = world_or_skip!();
    let p = w.people();
    let id = p.agent_with(Some("1"));
    let draft = |who: Who, ask: &str| {
        p.mutate(
            who,
            "own.trade.draft",
            &Json::obj([("id", s(&id)), ("ask", s(ask))]),
        )
    };
    assert_eq!(
        draft(Who::Person, "Buy 0.0001 BTC at market").data(),
        Json::obj([
            ("side", s("buy")),
            ("size", s("0.0001")),
            ("base", s("BTC")),
            ("type", s("market")),
            ("price", Json::Null),
            ("label", s("TEST")),
        ])
    );
    let limit = draft(Who::Person, "sell 0.5 eth at 3100").data();
    assert_eq!(
        (
            text(&limit, "side"),
            text(&limit, "base"),
            text(&limit, "type"),
            text(&limit, "price")
        ),
        (
            "sell".to_owned(),
            "ETH".to_owned(),
            "limit".to_owned(),
            "3100".to_owned()
        )
    );
    for ask in [
        "buy some BTC",
        "Buy 0 BTC at market",
        "send 1 USDT to my savings",
        "Buy 0.0001 BTC at market and sell it",
    ] {
        assert_eq!(
            draft(Who::Person, ask).message(),
            "agents.order_not_understood",
            "{ask}"
        );
    }
    assert_eq!(
        draft(Who::Other, "Buy 0.0001 BTC at market").message(),
        "agents.own.not_found"
    );
}
