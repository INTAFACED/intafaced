//! The runtime slice's doors against a real Postgres (\`TEST_DATABASE_URL_AGENTS\` or \`TEST_DATABASE_URL\`, a server whose
//! admin database name ends in \`_test\`), each test in its own throwaway database migrated by the crate's own runner.
//! Without a URL it skips; with \`REQUIRE_POSTGRES=1\` it fails.
//!
//! Ported case for case from \`services/svc-agents/src/runtime.test.ts\`: "D26-P2-01h public doors — real AgentRuntime
//! metering-off", "OWNER 107 — a run starts only when it can be paid for, priced and run by the person", and the kept
//! transcript case of "operator agent log (opsLog) and kept transcripts". A case that calls the runtime directly calls
//! \`svc_agents::runtime\`; a case that goes through the router goes through the \`AgentsDoor\` with a signed principal.
//! The ledger and the bus are fakes; the engine is the crate's deterministic mock under the id \`primary\`, and its call
//! count is the TypeScript's \`counting(gateway)\`.
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
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use sha2::{Digest, Sha256};

use service_kit::edge;
use service_kit::json::{self, Json};
use service_kit::money::{Amount, format_amount, parse_amount};
use service_kit::pg::Pool;
use service_kit::s2s::CallSigner;
use service_kit::server::Request;
use service_kit::time::Instant;
use support::TestDb;
use svc_agents::db::Store;
use svc_agents::door::{AgentsDoor, DoorConfig, ServiceAuth};
use svc_agents::gateway::Gateway;
use svc_agents::gateway::desk::GatewaySlice;
use svc_agents::gateway::providers::{ChatMessage, MockOptions, MockProvider, Role};
use svc_agents::gateway::readiness::ReadyInput;
use svc_agents::gateway::routing::{RoutingTable, parse_routing_table, unpriced};
use svc_agents::metering::Metering;
use svc_agents::metering::meter;
use svc_agents::metering::ports::{Bus, Ledger, LedgerError, Recipe};
use svc_agents::metering::spend;
use svc_agents::runtime::funds::{Funds, Reading, Unread};
use svc_agents::runtime::guardrails::{parse_guardrail, serialise_guardrail};
use svc_agents::runtime::holds::{self, HoldError, ReserveInput};
use svc_agents::runtime::{self, Rt, RunError, Runtime, ThinkInput, ThinkResult};

// ── The fakes ───────────────────────────────────────────────────────────────

/// \`MemoryLedger\` as far as these tests read it: each recipe booked once under its key, the person's available
/// balance and \`houseFees('agents', 'IFC')\`.
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
    /// \`balanceOf(userId)\`.
    fn balance(&self, user: &str) -> String {
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
    /// \`houseOf()\`.
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
            other => panic!("only the custodial fee charge is posted here, got {other:?}"),
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

/// The TypeScript's \`funds: { available: async () => ... }\`: a ledger reading of what it holds, or a read that throws
/// (\`None\`).
#[derive(Clone)]
struct Balance(Arc<Mutex<Option<Amount>>>);

impl Balance {
    fn of(a: Amount) -> Balance {
        Balance(Arc::new(Mutex::new(Some(a))))
    }
    fn down() -> Balance {
        Balance(Arc::new(Mutex::new(None)))
    }
    fn set(&self, a: Amount) {
        *self.0.lock().unwrap() = Some(a);
    }
}

impl Funds for Balance {
    fn available(&self, _: &Pool, _: &str, _: &str, _: &str, _: &str) -> Result<Reading, Unread> {
        (*self.0.lock().unwrap())
            .map(Reading::Ledger)
            .ok_or_else(Unread::default)
    }
}

// ── The world a test runs in ────────────────────────────────────────────────

const USER_A: &str = "11111111-1111-4111-8111-111111111111";
const USER_B: &str = "22222222-2222-4222-8222-222222222222";
const ASSET: &str = "IFC";
const SERVICE_SECRET: &str = "an-agents-runtime-doors-service-secret-long";

fn amt(s: &str) -> Amount {
    parse_amount(s).unwrap()
}

fn now() -> Instant {
    svc_agents::door::system_now()
}

/// The test routing table (\`TABLE\`).
fn table() -> RoutingTable {
    parse_routing_table(
        r#"{"routes":[
          {"task":"plan","providerId":"primary","model":"reasoning-lg","maxOutputTokens":256,"price":{"inputPerMillion":"3","outputPerMillion":"15"}},
          {"task":"quick","providerId":"primary","model":"fast-sm","maxOutputTokens":64,"price":{"inputPerMillion":"0.25","outputPerMillion":"1.25"}},
          {"task":"vectors","providerId":"primary","model":"embed-sm","maxOutputTokens":1,"price":{"inputPerMillion":"0.1","outputPerMillion":"0"},"capability":"embed"},
          {"task":"orphan","providerId":"nowhere","model":"reasoning-lg","maxOutputTokens":16,"price":{"inputPerMillion":"1","outputPerMillion":"1"}}
        ]}"#,
    )
    .unwrap()
}

/// \`MESSAGES\`.
fn messages() -> Vec<ChatMessage> {
    vec![user_says("Where do I stake?")]
}

fn user_says(text: &str) -> ChatMessage {
    ChatMessage {
        role: Role::User,
        content: text.to_owned(),
    }
}

/// The worst case of a \`plan\` run over \`MESSAGES\`: \`usageCost({ estimateInputTokens, route.maxOutputTokens }, price)\`.
fn worst() -> Amount {
    let t = table();
    let route = t.routes.iter().find(|r| r.task == "plan").unwrap();
    runtime::usage_cost(
        runtime::estimate_input_tokens(None, &messages()),
        route.max_output_tokens,
        route.price.as_ref().unwrap(),
    )
    .unwrap()
}

/// \`runtime.registerAgent({ ...PROBE, agentId, tools?, limits: { maxSpendPerSession } })\`.
fn register(pool: &Pool, agent_id: &str, tools: bool, max_spend: Option<&str>) {
    let tools = if tools {
        r#"[{"name":"trade.quote","module":"trade","mode":"read"},{"name":"trade.order","module":"trade","mode":"write","maxCallsPerSession":1,"requiresApproval":true}]"#
    } else {
        "[]"
    };
    let spend = max_spend.map_or("null".to_owned(), |s| format!("\"{s}\""));
    let raw = format!(
        r#"{{"agentId":"{agent_id}","version":1,"capacityMode":"confirm_each","tools":{tools},"limits":{{"maxActionsPerSession":20,"maxOutputTokensPerCall":256,"maxSpendPerSession":{spend},"allowedModules":["trade"],"allowedTasks":["plan","quick","orphan"]}}}}"#
    );
    let g = parse_guardrail(&json::parse(&raw).unwrap()).unwrap();
    let stored = serialise_guardrail(&g).compact();
    let mut conn = pool.get().unwrap();
    conn.client()
        .unwrap()
        .execute(
            "INSERT INTO agents.agent_definitions (agent_id, version, guardrail, enabled)
             VALUES ($1::text, 1, $2::text::jsonb, true)
             ON CONFLICT (agent_id) DO UPDATE SET version = EXCLUDED.version, guardrail = EXCLUDED.guardrail",
            &[&agent_id, &stored],
        )
        .unwrap();
}

/// A runtime as \`new AgentRuntime(sql, gateway, meter, bus, { spend?, funds?, transcriptRetentionDays? })\` builds it.
fn runtime_with(spend: bool, funds: Option<Balance>, retention: i64) -> Runtime {
    let mut r = Runtime::unwired();
    r.spend = spend;
    r.funds = funds.map(|f| Box::new(f) as Box<dyn Funds>);
    r.transcript_retention_days = retention;
    r
}

/// The suite's \`runtime\`: metering on, no spend gate, no funds.
fn plain() -> Runtime {
    runtime_with(false, None, 0)
}

struct World {
    db: TestDb,
    store: Store,
    ledger: FakeLedger,
    bus: FakeBus,
    provider: Arc<MockProvider>,
    gateway: Arc<Gateway>,
}

impl World {
    /// \`beforeEach\`: the mock engine, the probe and thrifty agents, and 1000 IFC for each person.
    fn new() -> Option<World> {
        let db = TestDb::new()?;
        let mut sink = Vec::new();
        svc_agents::migrate::run(&db.url, false, &mut sink).unwrap();
        let provider = Arc::new(MockProvider::new(
            MockOptions {
                id: Some("primary".to_owned()),
                ..MockOptions::default()
            },
            now,
        ));
        let gateway = Arc::new(Gateway::new(vec![provider.clone()], table()));
        let w = World {
            store: db.store(),
            db,
            ledger: FakeLedger::default(),
            bus: FakeBus::default(),
            provider,
            gateway,
        };
        register(w.pool(), "probe", true, None);
        register(w.pool(), "thrifty", true, Some("0.000000000000000001"));
        w.ledger.deposit(USER_A, amt("1000"));
        w.ledger.deposit(USER_B, amt("1000"));
        Some(w)
    }

    fn pool(&self) -> &Pool {
        self.store.pool().unwrap()
    }

    /// \`new UsageMeter(sql, ledger, { assetId: 'IFC', windowMinutes: 60 })\` with metering on or off.
    fn metering(&self, enabled: bool) -> Metering {
        let mut m = Metering::unwired(ASSET, 60);
        m.enabled = enabled;
        m.ledger = Box::new(self.ledger.clone());
        m.bus = Box::new(self.bus.clone());
        m
    }

    fn x<'a>(&'a self, rt: &'a Runtime, m: &'a Metering) -> Rt<'a> {
        self.on(rt, m, &self.gateway)
    }

    fn on<'a>(&'a self, rt: &'a Runtime, m: &'a Metering, gateway: &'a Gateway) -> Rt<'a> {
        Rt {
            rt,
            pool: self.pool(),
            gateway,
            m,
            now: now(),
        }
    }

    fn count(&self, sql: &str, arg: &str) -> i64 {
        self.db.client().query_one(sql, &[&arg]).unwrap().get(0)
    }

    fn holds_of(&self, session: &str) -> i64 {
        self.count(
            "SELECT count(*) FROM agents.spend_reservations WHERE session_id = $1::text::uuid",
            session,
        )
    }

    fn usage_of(&self, session: &str) -> i64 {
        self.count(
            "SELECT count(*) FROM agents.usage_records WHERE session_id = $1::text::uuid",
            session,
        )
    }

    fn calls(&self) -> u64 {
        self.provider.call_count()
    }

    /// A door over this world's database and ledger, with this runtime, metering on or off and this gateway.
    fn door(&self, rt: Runtime, enabled: bool, gateway: Arc<Gateway>, secret: &str) -> AgentsDoor {
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
            edge_secret: secret.to_owned(),
            services: ServiceAuth {
                secret: Some(SERVICE_SECRET.to_owned()),
                keys: None,
            },
            env,
            now,
            store: self.db.store(),
            gateway: GatewaySlice {
                gateway,
                fee_asset_id: ASSET.to_owned(),
                metering_enabled: Some(enabled),
                window_minutes: 60,
            },
            ready: ReadyInput::unwired(),
            metering: self.metering(enabled),
            runtime: rt,
            background: svc_agents::background::Settings::default(),
            advisors: svc_agents::advisors::Advisors::unwired(),
            own: svc_agents::own::Own::unwired(),
            team: svc_agents::team::Team::unwired(),
        })
        .unwrap()
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

fn think(
    x: &Rt<'_>,
    session: &str,
    request: &str,
    task: &str,
    msgs: &[ChatMessage],
) -> Result<ThinkResult, RunError> {
    runtime::think(
        x,
        &ThinkInput {
            session_id: session,
            request_id: request,
            task,
            system: None,
            messages: msgs,
            max_output_tokens: None,
            team_run: false,
        },
    )
}

/// \`refusalCode(err)\`: a \`RefusedError\`'s refusal code.
fn refusal_code(r: &Result<ThinkResult, RunError>) -> String {
    match r {
        Err(RunError::Refused { refusal, .. }) => refusal.code.clone(),
        other => panic!("expected a refusal, got {other:?}"),
    }
}

fn refusal_key(r: &Result<ThinkResult, RunError>) -> String {
    match r {
        Err(RunError::Refused { refusal, .. }) => refusal.user_message_key.clone(),
        other => panic!("expected a refusal, got {other:?}"),
    }
}

/// \`log.at(-1)\` of \`rt.sessionLog(session, 50)\`: its status and refusal code.
fn last_log(pool: &Pool, session: &str) -> (String, Option<String>) {
    let log = svc_agents::audit::for_session(pool, session, 50).unwrap();
    let last = log.last().unwrap();
    (last.status.clone(), last.refusal_code.clone())
}

fn hold_code(r: Result<holds::Reservation, HoldError>) -> &'static str {
    match r {
        Err(HoldError::Denied(d)) => d.error.code,
        other => panic!("expected a refused hold, got {other:?}"),
    }
}

// ── The door ────────────────────────────────────────────────────────────────

/// A signed principal: \`kid\` and \`sub_account\` make it a delegated token.
fn principal(
    secret: &str,
    user: &str,
    sid: &str,
    scopes: &[&str],
    kid: Option<&str>,
    sub_account: Option<&str>,
) -> Vec<(String, String)> {
    let mut fields = vec![
        ("sub", Json::str(user)),
        ("userId", Json::str(user)),
        ("sid", Json::str(sid)),
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
    if let Some(s) = sub_account {
        fields.push(("sub_account", Json::str(s)));
    }
    let raw = Json::Object(fields.into_iter().map(|(k, v)| (k.to_owned(), v)).collect()).compact();
    let sig = edge::sign(&raw, secret, "DE").unwrap();
    vec![
        ("x-intafaced-principal".to_owned(), raw),
        ("x-intafaced-principal-sig".to_owned(), sig),
        ("x-intafaced-region".to_owned(), "DE".to_owned()),
    ]
}

/// The person's request with a service's signature on it too (\`{ ...signed(), service }\`).
fn with_service(
    mut headers: Vec<(String, String)>,
    service: &str,
    path: &str,
    input: &Json,
) -> Vec<(String, String)> {
    headers.extend(
        CallSigner::new(service, "svc-agents", SERVICE_SECRET, None)
            .sign(
                &input.compact(),
                "POST",
                &format!("/trpc/{path}"),
                "application/json",
            )
            .unwrap(),
    );
    headers
}

fn query(door: &AgentsDoor, path: &str, input: &Json, headers: &[(String, String)]) -> (u16, Json) {
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
    let res = door.handle(&Request {
        method: "GET",
        url: &url,
        headers,
        body: "",
    });
    (res.status, json::parse(&res.body).unwrap())
}

fn mutate(
    door: &AgentsDoor,
    path: &str,
    input: &Json,
    headers: &[(String, String)],
) -> (u16, Json) {
    let body = input.compact();
    let mut headers = headers.to_vec();
    headers.push(("content-type".to_owned(), "application/json".to_owned()));
    let url = format!("/trpc/{path}");
    let res = door.handle(&Request {
        method: "POST",
        url: &url,
        headers: &headers,
        body: &body,
    });
    (res.status, json::parse(&res.body).unwrap())
}

fn data(answer: &(u16, Json)) -> Json {
    assert_eq!(answer.0, 200, "{}", answer.1.compact());
    answer
        .1
        .get("result")
        .and_then(|r| r.get("data"))
        .cloned()
        .unwrap()
}

/// The tRPC code of a refused call (\`rejects.toMatchObject({ code })\`).
fn trpc_code(answer: &(u16, Json)) -> String {
    assert_ne!(answer.0, 200, "not refused: {}", answer.1.compact());
    match answer
        .1
        .get("error")
        .and_then(|e| e.get("data"))
        .and_then(|d| d.get("code"))
    {
        Some(Json::String(c)) => c.clone(),
        _ => panic!("no code: {}", answer.1.compact()),
    }
}

fn text_of(v: &Json, key: &str) -> String {
    match v.get(key) {
        Some(Json::String(s)) => s.clone(),
        other => panic!("{key} is not a string: {other:?}"),
    }
}

fn messages_json() -> Json {
    Json::Array(vec![Json::obj([
        ("role", Json::str("user")),
        ("content", Json::str("Where do I stake?")),
    ])])
}

fn complete_input(session: &str, request: &str) -> Json {
    Json::obj([
        ("sessionId", Json::str(session)),
        ("requestId", Json::str(request)),
        ("task", Json::str("plan")),
        ("messages", messages_json()),
    ])
}

fn session_input(session: &str) -> Json {
    Json::obj([("sessionId", Json::str(session))])
}

fn open_input() -> Json {
    Json::obj([("agentId", Json::str("probe"))])
}

fn selected(session: &str, agent: &str) -> String {
    Json::obj([
        ("sessionId", Json::str(session)),
        ("agentId", Json::str(agent)),
    ])
    .compact()
}

// ── D26-P2-01h public doors — real AgentRuntime metering-off ────────────────

const DOORS_SECRET: &str = "an-agents-runtime-metering-doors-secret";
const DOORS_SID: &str = "22222222-2222-4222-8222-222222222222";

fn doors_principal() -> Vec<(String, String)> {
    principal(
        DOORS_SECRET,
        USER_A,
        DOORS_SID,
        &["agents:read", "agents:execute", "admin:write"],
        None,
        None,
    )
}

/// runtime.test.ts, "D26-P2-01h public doors — real AgentRuntime metering-off": "run.complete through createCaller never
/// bills / never feeCharges".
#[test]
fn d26_run_complete_through_the_door_never_bills_never_fee_charges() {
    let w = world_or_skip!();
    let m = w.metering(false);
    let rt = plain();
    let session = runtime::open_session(&w.x(&rt, &m), USER_A, "probe").unwrap();
    let door = w.door(plain(), false, w.gateway.clone(), DOORS_SECRET);
    let result = data(&mutate(
        &door,
        "run.complete",
        &complete_input(&session.id, "doors-off-complete-1"),
        &doors_principal(),
    ));
    assert_eq!(result.get("metered"), Some(&Json::Bool(false)));
    assert_eq!(text_of(&result, "cost"), "0");
    assert_eq!(w.ledger.balance(USER_A), "1000");
    assert_eq!(w.ledger.house(), "0");
    assert_eq!(w.usage_of(&session.id), 0);
}

/// runtime.test.ts, "D26-P2-01h public doors — real AgentRuntime metering-off": "run.complete same requestId twice
/// through createCaller never invents a charge or request_id_replay".
#[test]
fn d26_the_same_request_id_twice_through_the_door_never_invents_a_charge_or_a_replay() {
    let w = world_or_skip!();
    let m = w.metering(false);
    let rt = plain();
    let session = runtime::open_session(&w.x(&rt, &m), USER_A, "probe").unwrap();
    let door = w.door(plain(), false, w.gateway.clone(), DOORS_SECRET);
    let input = complete_input(&session.id, "doors-off-replay");
    let first = data(&mutate(&door, "run.complete", &input, &doors_principal()));
    let second = data(&mutate(&door, "run.complete", &input, &doors_principal()));
    assert_eq!(first.get("metered"), Some(&Json::Bool(false)));
    assert_eq!(second.get("metered"), Some(&Json::Bool(false)));
    assert_eq!(text_of(&first, "cost"), "0");
    assert_eq!(text_of(&second, "cost"), "0");
    assert_eq!(w.ledger.balance(USER_A), "1000");
    assert_eq!(w.ledger.house(), "0");
    assert_eq!(w.usage_of(&session.id), 0);
}

/// runtime.test.ts, "D26-P2-01h public doors — real AgentRuntime metering-off": "usage.settle / settleSession /
/// session.close refuse leftover windows without feeCharge".
#[test]
fn d26_settle_settle_session_and_close_leave_leftover_windows_without_a_fee_charge() {
    let w = world_or_skip!();
    let on = w.metering(true);
    let rt = plain();
    let x = w.x(&rt, &on);
    let session = runtime::open_session(&x, USER_A, "probe").unwrap();
    let call = think(&x, &session.id, "doors-then-off", "plan", &messages()).unwrap();
    assert!(call.metered);
    let window = call.window_id.clone().unwrap();

    let door = w.door(plain(), false, w.gateway.clone(), DOORS_SECRET);
    let settle_in = Json::obj([
        ("sessionId", Json::str(session.id.clone())),
        ("windowId", Json::str(window.clone())),
    ]);
    let settle = data(&mutate(
        &door,
        "usage.settle",
        &settle_in,
        &with_service(doors_principal(), "svc-agents", "usage.settle", &settle_in),
    ));
    assert_eq!(text_of(&settle, "amount"), "0");
    assert_eq!(settle.get("settled"), Some(&Json::Bool(false)));
    assert_eq!(text_of(&settle, "assetId"), "IFC");

    let whole = session_input(&session.id);
    let all = data(&mutate(
        &door,
        "usage.settleSession",
        &whole,
        &with_service(
            doors_principal(),
            "svc-agents",
            "usage.settleSession",
            &whole,
        ),
    ));
    let Some(Json::Array(settlements)) = all.get("settlements") else {
        panic!("no settlements: {}", all.compact())
    };
    assert!(
        settlements
            .iter()
            .all(|s| s.get("settled") == Some(&Json::Bool(false)) && text_of(s, "amount") == "0")
    );

    let closed = data(&mutate(&door, "session.close", &whole, &doors_principal()));
    assert_eq!(text_of(&closed, "status"), "closed");

    assert_eq!(w.ledger.balance(USER_A), "1000");
    assert_eq!(w.ledger.house(), "0");
    assert!(
        meter::open_windows(w.pool(), &session.id)
            .unwrap()
            .contains(&window)
    );
}

// ── OWNER 107 — a run starts only when it can be paid for, priced and run by the person ──

/// runtime.test.ts, "OWNER 107 …": "refuses a task with no published rate before the engine, and logs the refusal".
#[test]
fn owner107_a_task_with_no_published_rate_is_refused_before_the_engine_and_logged() {
    let w = world_or_skip!();
    let blank = Gateway::new(vec![w.provider.clone()], unpriced(&table()));
    let m = w.metering(true);
    let rt = plain();
    let x = w.on(&rt, &m, &blank);
    let session = runtime::open_session(&x, USER_A, "probe").unwrap();
    let err = think(&x, &session.id, "blank-rate", "plan", &messages());
    assert_eq!(refusal_code(&err), "agents.price_unset");
    assert_eq!(w.calls(), 0);
    assert_eq!(
        last_log(w.pool(), &session.id),
        ("refused".to_owned(), Some("agents.price_unset".to_owned()))
    );
    assert_eq!(w.ledger.balance(USER_A), "1000");
}

/// runtime.test.ts, "OWNER 107 …": "refuses a Copy-Intel request for a returns ranking before the price, the hold and
/// the engine, and logs it".
#[test]
fn owner107_copy_intel_refuses_a_returns_ranking_before_the_price_the_hold_and_the_engine() {
    let w = world_or_skip!();
    let m = w.metering(true);
    let rt = plain();
    let x = w.x(&rt, &m);
    register(w.pool(), "copy-intel", false, None);
    let session = runtime::open_session(&x, USER_A, "copy-intel").unwrap();
    let ask = vec![user_says("TEST: rank the leaders by returns")];
    let err = think(&x, &session.id, "board", "plan", &ask);
    assert_eq!(
        refusal_code(&err),
        "agents.copy_intel.returns_board_refused"
    );
    assert_eq!(
        refusal_key(&err),
        "agents.refused.copy_intel.returns_board_refused"
    );
    assert_eq!(w.calls(), 0);
    assert!(!meter::has_request(w.pool(), &session.id, "board").unwrap());
    assert_eq!(
        last_log(w.pool(), &session.id),
        (
            "refused".to_owned(),
            Some("agents.copy_intel.returns_board_refused".to_owned())
        )
    );
    assert_eq!(w.ledger.balance(USER_A), "1000");

    // A disclosed-stats question ranks nothing and runs; the same words on another agent are not this refusal.
    think(
        &x,
        &session.id,
        "stats",
        "plan",
        &[user_says("TEST: show leader L1 stats")],
    )
    .unwrap();
    assert_eq!(w.calls(), 1);
    let other = runtime::open_session(&x, USER_A, "probe").unwrap();
    think(&x, &other.id, "other", "plan", &ask).unwrap();
    assert_eq!(w.calls(), 2);
}

/// runtime.test.ts, "OWNER 107 …": "refuses a run whose worst case the available balance cannot cover, before the hold
/// and the engine".
#[test]
fn owner107_a_worst_case_the_balance_cannot_cover_is_refused_before_the_hold_and_the_engine() {
    let w = world_or_skip!();
    let worst = worst();
    let m = w.metering(true);
    let rt = runtime_with(true, Some(Balance::of(worst - 1)), 0);
    let x = w.x(&rt, &m);
    register(w.pool(), "capped", true, Some("1"));
    let session = runtime::open_session(&x, USER_A, "capped").unwrap();
    let err = think(&x, &session.id, "poor-1", "plan", &messages());
    assert_eq!(refusal_code(&err), "agents.funds_insufficient");
    assert_eq!(w.calls(), 0);
    assert_eq!(w.holds_of(&session.id), 0);
    assert_eq!(w.usage_of(&session.id), 0);

    // Exactly the worst case is enough.
    let enough = runtime_with(true, Some(Balance::of(worst)), 0);
    let ok = think(
        &w.x(&enough, &m),
        &session.id,
        "poor-2",
        "plan",
        &messages(),
    )
    .unwrap();
    assert!(ok.metered);
    assert_eq!(w.calls(), 1);
}

/// runtime.test.ts, "OWNER 107 …": "with a spend gate, a balance that cannot be read refuses as unread before the hold
/// and the engine, and bills 0".
#[test]
fn owner107_with_a_spend_gate_an_unread_balance_refuses_as_unread_and_bills_nothing() {
    let w = world_or_skip!();
    let m = w.metering(true);
    let rt = runtime_with(true, Some(Balance::down()), 0);
    let x = w.x(&rt, &m);
    register(w.pool(), "unread-gate", true, Some("1"));
    let session = runtime::open_session(&x, USER_A, "unread-gate").unwrap();
    let err = think(&x, &session.id, "unread-gate-1", "plan", &messages());
    assert_eq!(refusal_code(&err), "agents.funds_unread");
    assert_eq!(refusal_key(&err), "agents.refused.funds_unread");
    assert_eq!(w.calls(), 0);
    assert_eq!(w.holds_of(&session.id), 0);
    assert_eq!(w.usage_of(&session.id), 0);
    assert_eq!(
        last_log(w.pool(), &session.id),
        ("refused".to_owned(), Some("agents.funds_unread".to_owned()))
    );
    assert_eq!(w.ledger.balance(USER_A), "1000");
}

/// runtime.test.ts, "OWNER 107 …": "refuses when the balance cannot be read: an unknown balance is not a covered one".
#[test]
fn owner107_without_a_spend_gate_an_unread_balance_is_not_a_covered_one() {
    let w = world_or_skip!();
    let m = w.metering(true);
    let rt = runtime_with(false, Some(Balance::down()), 0);
    let x = w.x(&rt, &m);
    let session = runtime::open_session(&x, USER_A, "probe").unwrap();
    let err = think(&x, &session.id, "unread", "plan", &messages());
    assert_eq!(refusal_code(&err), "agents.funds_unread");
    assert_eq!(refusal_key(&err), "agents.refused.funds_unread");
    assert_eq!(w.calls(), 0);
}

fn reserve(
    w: &World,
    user: &str,
    session: &str,
    key: &str,
    amount: Amount,
    cap: Option<Amount>,
) -> Result<holds::Reservation, HoldError> {
    holds::reserve(
        w.pool(),
        &ReserveInput {
            user_id: user,
            session_id: session,
            reservation_key: key,
            asset_id: ASSET,
            amount,
            now: now(),
            agent_cap: cap,
            funds: None,
            overage_grace: None,
            team_run: false,
        },
    )
}

/// runtime.test.ts, "OWNER 107 …": "a person with no limits of their own runs under the agent’s cap, held across runs at
/// once".
#[test]
fn owner107_a_person_with_no_limits_runs_under_the_agents_cap_held_across_runs() {
    let w = world_or_skip!();
    let worst = worst();
    // A cap that one worst case fits under and two do not.
    let cap = worst + worst / 2;
    register(w.pool(), "pair", true, Some(&format_amount(cap)));
    let m = w.metering(true);
    let rt = plain();
    let session = runtime::open_session(&w.x(&rt, &m), USER_A, "pair").unwrap();
    let first = reserve(&w, USER_A, &session.id, "pair-1", worst, Some(cap)).unwrap();
    assert_eq!(first.status, "held");
    assert_eq!(
        hold_code(reserve(&w, USER_A, &session.id, "pair-2", worst, Some(cap))),
        "agents.spend_limit"
    );
    // Without the agent's cap, a person with no limits is refused as before.
    assert_eq!(
        hold_code(reserve(
            &w,
            USER_A,
            &session.id,
            "pair-3",
            amt("0.000001"),
            None
        )),
        "agents.spend_limit_unset"
    );

    let gated = runtime_with(true, None, 0);
    let x = w.x(&gated, &m);
    let fresh = runtime::open_session(&x, USER_B, "pair").unwrap();
    let ran = think(&x, &fresh.id, "pair-run", "plan", &messages()).unwrap();
    assert!(ran.metered);
}

/// runtime.test.ts, "OWNER 107 …": "counts usage not yet charged against the balance: a run the balance covers only
/// before that debt does not start".
#[test]
fn owner107_usage_not_yet_charged_counts_against_the_balance() {
    let w = world_or_skip!();
    let worst = worst();
    let available = Balance::of(worst * 10);
    let m = w.metering(true);
    let rt = runtime_with(true, Some(available.clone()), 0);
    let x = w.x(&rt, &m);
    register(w.pool(), "owed", true, Some("1000"));
    let session = runtime::open_session(&x, USER_A, "owed").unwrap();
    think(&x, &session.id, "owed-1", "plan", &messages()).unwrap();
    let spent = || meter::session_spend(&mut w.db.client(), &session.id).unwrap();
    let owed = spent();
    assert!(owed > 0);

    // The ledger still shows the whole balance: the window is open, nothing is charged yet.
    available.set(worst + owed - 1);
    let err = think(&x, &session.id, "owed-2", "plan", &messages());
    assert_eq!(refusal_code(&err), "agents.funds_insufficient");
    assert_eq!(w.calls(), 1);
    assert_eq!(
        w.count(
            "SELECT count(*) FROM agents.spend_reservations WHERE session_id = $1::text::uuid AND reservation_key = 'owed-2'",
            &session.id
        ),
        0
    );
    assert_eq!(spent(), owed);

    available.set(worst + owed);
    think(&x, &session.id, "owed-3", "plan", &messages()).unwrap();
    assert_eq!(w.calls(), 2);
}

/// runtime.test.ts, "OWNER 107 …": "two runs at once whose worst cases together exceed the balance: exactly one starts,
/// the other bills 0 and holds nothing".
#[test]
fn owner107_two_runs_at_once_over_the_balance_exactly_one_starts() {
    let w = world_or_skip!();
    let worst = worst();
    let m = w.metering(true);
    let rt = runtime_with(true, Some(Balance::of(worst + worst / 2)), 0);
    register(w.pool(), "twin", true, Some("1000"));
    // Two sessions, so the agent's per-session cap is not what decides.
    let one = runtime::open_session(&w.x(&rt, &m), USER_A, "twin").unwrap();
    let two = runtime::open_session(&w.x(&rt, &m), USER_A, "twin").unwrap();
    let (r1, r2) = std::thread::scope(|s| {
        let a = s.spawn(|| think(&w.x(&rt, &m), &one.id, "twin-1", "plan", &messages()));
        let b = s.spawn(|| think(&w.x(&rt, &m), &two.id, "twin-2", "plan", &messages()));
        (a.join().unwrap(), b.join().unwrap())
    });
    let admitted = [&r1, &r2].iter().filter(|r| r.is_ok()).count();
    assert_eq!(admitted, 1);
    let (refused, refused_session) = if r1.is_err() {
        (&r1, &one.id)
    } else {
        (&r2, &two.id)
    };
    assert_eq!(refusal_code(refused), "agents.funds_insufficient");
    assert_eq!(w.calls(), 1);
    assert_eq!(w.holds_of(refused_session), 0);
    assert_eq!(w.usage_of(refused_session), 0);
    assert_eq!(
        w.count(
            "SELECT count(*) FROM agents.spend_reservations WHERE status = $1::text",
            "held"
        ),
        0
    );
    assert_eq!(w.ledger.balance(USER_A), "1000");
}

/// runtime.test.ts, "OWNER 107 …": "the agent’s cap applies even when the person’s own limit is higher: the lower of the
/// two wins".
#[test]
fn owner107_the_agents_cap_applies_under_a_higher_own_limit_the_lower_wins() {
    let w = world_or_skip!();
    let worst = worst();
    let some = |s: &str| Some(s.to_owned());
    spend::set(
        w.pool(),
        USER_A,
        &spend::SetInput {
            asset_id: some("IFC"),
            per_call: some("100"),
            per_session: some("100"),
            per_period: some("100"),
            period: some("month"),
            idempotency_key: some("own-high"),
        },
    )
    .unwrap();
    let cap = worst + worst / 2;
    register(w.pool(), "lower", true, Some(&format_amount(cap)));
    let m = w.metering(true);
    let rt = plain();
    let session = runtime::open_session(&w.x(&rt, &m), USER_A, "lower").unwrap();
    assert_eq!(
        reserve(&w, USER_A, &session.id, "lower-1", worst, Some(cap))
            .unwrap()
            .status,
        "held"
    );
    assert_eq!(
        hold_code(reserve(
            &w,
            USER_A,
            &session.id,
            "lower-2",
            worst,
            Some(cap)
        )),
        "agents.spend_limit"
    );
    let keys: Vec<String> = w
        .db
        .client()
        .query(
            "SELECT reservation_key FROM agents.spend_reservations WHERE session_id = $1::text::uuid",
            &[&session.id],
        )
        .unwrap()
        .iter()
        .map(|r| r.get(0))
        .collect();
    assert_eq!(keys, ["lower-1"]);
}

/// runtime.test.ts, "OWNER 107 …": "a replayed request id reads as a replay even when the balance is now short, and the
/// engine is not called again".
#[test]
fn owner107_a_replayed_request_id_reads_as_a_replay_even_when_the_balance_is_short() {
    let w = world_or_skip!();
    let available = Balance::of(amt("1000"));
    let m = w.metering(true);
    let rt = runtime_with(true, Some(available.clone()), 0);
    let x = w.x(&rt, &m);
    register(w.pool(), "again", true, Some("1000"));
    let session = runtime::open_session(&x, USER_A, "again").unwrap();
    think(&x, &session.id, "again-1", "plan", &messages()).unwrap();
    available.set(0);
    let again = think(&x, &session.id, "again-1", "plan", &messages());
    assert_eq!(
        again.as_ref().err().and_then(RunError::code),
        Some("agents.request_id_replay"),
        "{again:?}"
    );
    assert_eq!(w.calls(), 1);
}

/// runtime.test.ts, "OWNER 107 …": "session.detail shows each usage window: open while running, settled once with its
/// charge after close; never another person’s".
#[test]
fn owner107_session_detail_shows_each_window_open_then_settled_and_never_another_persons() {
    let w = world_or_skip!();
    const SECRET: &str = "an-agents-owner-107-session-detail-secret";
    let sid = "44444444-4444-4444-8444-444444444444";
    let as_ = |user: &str| {
        principal(
            SECRET,
            user,
            sid,
            &["agents:read", "agents:execute"],
            None,
            None,
        )
    };
    let door = w.door(plain(), true, w.gateway.clone(), SECRET);
    let me = as_(USER_A);
    let session = data(&mutate(&door, "session.open", &open_input(), &me));
    let id = text_of(&session, "id");
    let ran = data(&mutate(
        &door,
        "run.complete",
        &complete_input(&id, "detail-1"),
        &me,
    ));
    let before = data(&query(&door, "session.detail", &session_input(&id), &me));
    let Some(Json::Array(windows)) = before.get("windows") else {
        panic!("no windows")
    };
    assert_eq!(windows.len(), 1);
    assert_eq!(text_of(&windows[0], "state"), "open");
    assert_eq!(windows[0].get("amount"), Some(&Json::Null));
    assert_eq!(windows[0].get("chargeKey"), Some(&Json::Null));

    data(&mutate(&door, "session.close", &session_input(&id), &me));
    let after = data(&query(&door, "session.detail", &session_input(&id), &me));
    assert_eq!(text_of(after.get("session").unwrap(), "status"), "closed");
    let Some(Json::Array(windows)) = after.get("windows") else {
        panic!("no windows")
    };
    assert_eq!(windows.len(), 1);
    assert_eq!(text_of(&windows[0], "state"), "settled");
    let cost = text_of(&ran, "cost");
    assert_eq!(text_of(&windows[0], "amount"), cost);
    assert!(text_of(&windows[0], "chargeKey").starts_with("agent.usage:"));
    assert_eq!(
        w.ledger.balance(USER_A),
        format_amount(amt("1000") - amt(&cost))
    );

    assert_eq!(
        trpc_code(&query(
            &door,
            "session.detail",
            &session_input(&id),
            &as_(USER_B)
        )),
        "NOT_FOUND"
    );
}

/// runtime.test.ts, "OWNER 107 …": "session.detail lists a run as running while the engine has not answered, then
/// completed; a replay is still one run".
#[test]
fn owner107_session_detail_lists_a_run_running_then_completed_and_a_replay_is_one_run() {
    let w = world_or_skip!();
    const SECRET: &str = "an-agents-session-detail-runs-secret";
    let me = principal(
        SECRET,
        USER_A,
        "44444444-4444-4444-8444-444444444445",
        &["agents:read", "agents:execute"],
        None,
        None,
    );
    let dir: PathBuf =
        std::env::temp_dir().join(format!("agents-hold-{}-{}", std::process::id(), now().0));
    std::fs::create_dir_all(&dir).unwrap();
    let hold = dir.join("engine.hold");
    let held = Arc::new(MockProvider::new(
        MockOptions {
            id: Some("primary".to_owned()),
            hold_file: Some(hold.clone()),
            ..MockOptions::default()
        },
        now,
    ));
    let gateway = Arc::new(Gateway::new(vec![held.clone()], table()));
    let door = w.door(plain(), true, gateway, SECRET);
    let id = text_of(
        &data(&mutate(&door, "session.open", &open_input(), &me)),
        "id",
    );
    let marker = PathBuf::from(format!("{}.held", hold.display()));
    std::fs::write(&hold, "held").unwrap();
    let during = std::thread::scope(|s| {
        let running = s.spawn(|| {
            mutate(
                &door,
                "run.complete",
                &complete_input(&id, "detail-runs-1"),
                &me,
            )
        });
        let until = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while !marker.exists() {
            assert!(
                !running.is_finished(),
                "the run ended before the engine parked"
            );
            assert!(std::time::Instant::now() < until, "the engine never parked");
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        // The engine is parked at its door and has not answered: the run is already on record, and nothing is used yet.
        assert_eq!(held.call_count(), 1);
        let during = data(&query(&door, "session.detail", &session_input(&id), &me));
        assert!(!meter::has_request(w.pool(), &id, "detail-runs-1").unwrap());
        std::fs::remove_file(&hold).unwrap();
        data(&running.join().unwrap());
        during
    });
    let _ = std::fs::remove_dir_all(&dir);
    let runs = |v: &Json| -> Vec<(String, String)> {
        let Some(Json::Array(list)) = v.get("runs") else {
            panic!("no runs")
        };
        list.iter()
            .map(|r| {
                assert!(matches!(r.get("startedAt"), Some(Json::String(_))));
                let Json::Object(fields) = r else {
                    panic!("a run is an object")
                };
                assert_eq!(fields.len(), 3);
                (text_of(r, "requestId"), text_of(r, "state"))
            })
            .collect()
    };
    assert_eq!(
        runs(&during),
        [("detail-runs-1".to_owned(), "running".to_owned())]
    );
    let after = data(&query(&door, "session.detail", &session_input(&id), &me));
    assert_eq!(
        runs(&after),
        [("detail-runs-1".to_owned(), "completed".to_owned())]
    );
    assert_eq!(
        trpc_code(&mutate(
            &door,
            "run.complete",
            &complete_input(&id, "detail-runs-1"),
            &me
        )),
        "BAD_REQUEST"
    );
    let again = data(&query(&door, "session.detail", &session_input(&id), &me));
    assert_eq!(again.get("runs"), after.get("runs"));
    assert_eq!(held.call_count(), 1);
}

/// runtime.test.ts, "OWNER 107 …": "session.select keeps the selected session for the person on any device; another
/// person’s session is not found and changes nothing".
#[test]
fn owner107_session_select_keeps_the_selection_on_any_device_and_another_persons_is_not_found() {
    let w = world_or_skip!();
    const SECRET: &str = "an-agents-selected-session-secret";
    let as_ = |user: &str, sid: &str| {
        principal(
            SECRET,
            user,
            sid,
            &["agents:read", "agents:execute"],
            None,
            None,
        )
    };
    let door = w.door(plain(), true, w.gateway.clone(), SECRET);
    // Two sign-ins of the same person: two devices.
    let phone = as_(USER_A, "55555555-5555-4555-8555-555555555555");
    let laptop = as_(USER_A, "66666666-6666-4666-8666-666666666666");
    assert_eq!(
        data(&query(&door, "session.selected", &Json::Null, &laptop)),
        Json::Null
    );
    let older = text_of(
        &data(&mutate(&door, "session.open", &open_input(), &phone)),
        "id",
    );
    data(&mutate(&door, "session.open", &open_input(), &phone));
    assert_eq!(
        data(&mutate(
            &door,
            "session.select",
            &session_input(&older),
            &phone
        ))
        .compact(),
        selected(&older, "probe")
    );
    assert_eq!(
        data(&query(&door, "session.selected", &Json::Null, &laptop)).compact(),
        selected(&older, "probe")
    );

    let other = as_(USER_B, "77777777-7777-4777-8777-777777777777");
    let theirs = text_of(
        &data(&mutate(&door, "session.open", &open_input(), &other)),
        "id",
    );
    assert_eq!(
        trpc_code(&mutate(
            &door,
            "session.select",
            &session_input(&theirs),
            &phone
        )),
        "NOT_FOUND"
    );
    assert_eq!(
        data(&query(&door, "session.selected", &Json::Null, &laptop)).compact(),
        selected(&older, "probe")
    );
    assert_eq!(
        data(&query(&door, "session.selected", &Json::Null, &other)),
        Json::Null
    );
}

const PERSON_SID: &str = "33333333-3333-4333-8333-333333333333";

/// The three requests a run door refuses: a key, a sub-account and a service on the person's request.
fn delegated(secret: &str, path: &str, input: &Json) -> [Vec<(String, String)>; 3] {
    let scopes = &["agents:read", "agents:execute"];
    [
        principal(
            secret,
            USER_A,
            PERSON_SID,
            scopes,
            Some("66666666-6666-4666-8666-666666666666"),
            None,
        ),
        principal(
            secret,
            USER_A,
            PERSON_SID,
            scopes,
            None,
            Some("77777777-7777-4777-8777-777777777777"),
        ),
        with_service(
            principal(secret, USER_A, PERSON_SID, scopes, None, None),
            "svc-trade",
            path,
            input,
        ),
    ]
}

/// runtime.test.ts, "OWNER 107 …": "the run doors take only the person: a delegated token or a service on the request
/// is refused".
#[test]
fn owner107_the_run_doors_take_only_the_person() {
    let w = world_or_skip!();
    const SECRET: &str = "an-agents-owner-107-person-doors-secret";
    let door = w.door(plain(), true, w.gateway.clone(), SECRET);
    let person = principal(
        SECRET,
        USER_A,
        PERSON_SID,
        &["agents:read", "agents:execute"],
        None,
        None,
    );
    assert_eq!(
        text_of(
            &data(&mutate(&door, "session.open", &open_input(), &person)),
            "status"
        ),
        "open"
    );
    for headers in delegated(SECRET, "session.open", &open_input()) {
        assert_eq!(
            trpc_code(&mutate(&door, "session.open", &open_input(), &headers)),
            "FORBIDDEN"
        );
    }
}

/// runtime.test.ts, "OWNER 107 …": "only the person selects which session their history shows: a key, a sub-account or
/// a service is refused and changes nothing".
#[test]
fn owner107_only_the_person_selects_which_session_their_history_shows() {
    let w = world_or_skip!();
    const SECRET: &str = "an-agents-select-person-only-secret";
    let door = w.door(plain(), true, w.gateway.clone(), SECRET);
    let person = principal(
        SECRET,
        USER_A,
        PERSON_SID,
        &["agents:read", "agents:execute"],
        None,
        None,
    );
    let first = text_of(
        &data(&mutate(&door, "session.open", &open_input(), &person)),
        "id",
    );
    let second = text_of(
        &data(&mutate(&door, "session.open", &open_input(), &person)),
        "id",
    );
    assert_eq!(
        data(&mutate(
            &door,
            "session.select",
            &session_input(&first),
            &person
        ))
        .compact(),
        selected(&first, "probe")
    );
    for headers in delegated(SECRET, "session.select", &session_input(&second)) {
        assert_eq!(
            trpc_code(&mutate(
                &door,
                "session.select",
                &session_input(&second),
                &headers
            )),
            "FORBIDDEN"
        );
    }
    assert_eq!(
        data(&query(&door, "session.selected", &Json::Null, &person)).compact(),
        selected(&first, "probe")
    );
}

// ── operator agent log (opsLog) and kept transcripts ────────────────────────

/// runtime.test.ts, "operator agent log (opsLog) and kept transcripts": "keeps an engine call’s prompt text while
/// retention is on, its sha256 the row’s input digest; with retention 0 keeps none".
#[test]
fn a_kept_transcript_holds_the_prompt_while_retention_is_on_and_none_at_zero() {
    let w = world_or_skip!();
    let m = w.metering(true);
    // \`history()\`: one executed engine call and one refused task, run with retention on.
    let kept = runtime_with(false, None, 1);
    let x = w.x(&kept, &m);
    let session = runtime::open_session(&x, USER_A, "probe").unwrap();
    let ran = think(&x, &session.id, "ops-log-ran", "plan", &messages()).unwrap();
    let refused = think(&x, &session.id, "ops-log-refused", "vectors", &messages());
    assert!(
        matches!(refused, Err(RunError::Refused { .. })),
        "{refused:?}"
    );

    let mut c = w.db.client();
    let row = c
        .query_one(
            "SELECT text, user_id, extract(epoch FROM expires_at - stored_at)::int / 86400 AS days
               FROM agents.agent_transcripts WHERE action_id = $1::text::uuid",
            &[&ran.action.id],
        )
        .unwrap();
    let (text, user, days): (String, String, i32) = (row.get(0), row.get(1), row.get(2));
    let digest: String = c
        .query_one(
            "SELECT input_digest FROM agents.agent_actions WHERE id = $1::text::uuid",
            &[&ran.action.id],
        )
        .unwrap()
        .get(0);
    assert_eq!((user.as_str(), days), (USER_A, 1));
    assert!(text.contains("Where do I stake?"));
    let sha: String = Sha256::digest(text.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    assert_eq!(sha, digest);
    // The refused call ran nothing and keeps nothing.
    let all: i64 = c
        .query_one("SELECT count(*) FROM agents.agent_transcripts", &[])
        .unwrap()
        .get(0);
    assert_eq!(all, 1);

    let rt = plain();
    let x = w.x(&rt, &m);
    let session = runtime::open_session(&x, USER_A, "probe").unwrap();
    let unkept = think(&x, &session.id, "ops-log-unkept", "plan", &messages()).unwrap();
    assert_eq!(
        w.count(
            "SELECT count(*) FROM agents.agent_transcripts WHERE action_id = $1::text::uuid",
            &unkept.action.id
        ),
        0
    );
}
