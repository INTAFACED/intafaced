//! The own-controls slice through the door, on a real Postgres (`TEST_DATABASE_URL_AGENTS` or `TEST_DATABASE_URL`, a server whose
//! admin database name ends in `_test`), each test in its own throwaway database migrated by the crate's own runner.
//! Without a URL it skips; with `REQUIRE_POSTGRES=1` it fails.
//!
//! Ported from the TypeScript's database tests of the slice's calls:
//! - `own/policy.test.ts` (every database case), and `own.policy.check` / `forService` on a sub-account;
//! - `own/usage-limits.test.ts`: the reads, writes and refusals, the alert recorded and published once on its business
//!   key, a bus fault caught up on the next read, and the hard limit's room;
//! - `own/payment-method.test.ts`: choosing, clearing and the refusals, and a run against the wallet (short, covered,
//!   unbilled, a node that never answers, each unread reason, and no method);
//! - `own/memory.test.ts`: `own.memory.*` and `own.privacy.*` (an item a run remembered is written here as the run writes it);
//! - `own/usage-day.test.ts`: `own.usage` and `own.usageByDay` over sealed windows, an open one left out, another person's never shown;
//! - the limits and consents the other suites set up, and `own.analytics`.
//!
//! A run of the agent (`own.run`, `own.session.*`) is the own-runs slice's: here it is the runtime's `think` on a session
//! bound by `runtime::open_own_session` to `own_guardrail`, with the agent's instructions and the person's ask, as `own.run` calls it.
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
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant as Clock};

use service_kit::edge;
use service_kit::json::{self, Json};
use service_kit::money::{Amount, format_amount, parse_amount};
use service_kit::pg::Pool;
use service_kit::s2s::CallSigner;
use service_kit::server::Request;
use support::TestDb;
use svc_agents::db::Store;
use svc_agents::door::{AgentsDoor, DoorConfig, ServiceAuth, system_now};
use svc_agents::gateway::Gateway;
use svc_agents::gateway::desk::GatewaySlice;
use svc_agents::gateway::providers::{ChatMessage, MockOptions, MockProvider, Provider, Role};
use svc_agents::gateway::readiness::ReadyInput;
use svc_agents::gateway::routing::parse_routing_table;
use svc_agents::metering::Metering;
use svc_agents::metering::ports::{Bus, Ledger, LedgerError, LedgerOnly, Recipe};
use svc_agents::navigator::onchain::ports::{Linked, LinkedWallet, LinkedWallets};
use svc_agents::own::Own;
use svc_agents::own::controls::memory::Retention;
use svc_agents::own::store;
use svc_agents::own::tool_try::own_guardrail;
use svc_agents::runtime::chain_balance::{ChainBalance, WalletBalance};
use svc_agents::runtime::funds::{Balances, Funds, PersonFunds, Reading, Unread};
use svc_agents::runtime::{
    self, Rt, RunError, Runtime, ThinkInput, ThinkResult, USAGE_ALERT_CROSSED, open_own_session,
};
use svc_agents::self_freeze::{Reading as FreezeReading, SelfFreezeRead, Unavailable};

const USER: &str = "11111111-1111-4111-8111-111111111111";
const OTHER: &str = "22222222-2222-4222-8222-222222222222";
const SECRET: &str = "an-agents-own-controls-test-secret-of-32-plus-chars";
const SERVICE_SECRET: &str = "an-agents-own-controls-service-secret-long!!";
const FEE: &str = "USDT";
const ASK: &str = "TEST question";
const INSTRUCTIONS: &str = "Answer TEST questions.";
const LINKED: &str = "0x00000000000000000000000000000000000a11ce";
const OTHER_WALLET: &str = "0x00000000000000000000000000000000000b0b00";
const AS_OF: &str = "2026-11-09T00:00:00.000Z";
const SUB: &str = "sub:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
/// Below the cost of any one run, so the first run crosses the alert.
const TINY: &str = "0.000000000000000001";
const TABLE: &str = r#"{"routes":[{"task":"own.run","providerId":"primary","model":"reasoning-md","maxOutputTokens":2048,"price":{"inputPerMillion":"1","outputPerMillion":"5"}}]}"#;

fn amt(s: &str) -> Amount {
    parse_amount(s).unwrap()
}

fn msgs() -> Vec<ChatMessage> {
    vec![ChatMessage {
        role: Role::User,
        content: ASK.to_owned(),
    }]
}

/// The worst case of one run: its instructions and the ask, at the route's output ceiling, priced 1 and 5 a million.
fn worst() -> Amount {
    let input = runtime::estimate_input_tokens(Some(INSTRUCTIONS), &msgs());
    amt("0.000001") * i128::from(input) + amt("0.000005") * 2048
}

// ── The fakes ───────────────────────────────────────────────────────────────

/// `MemorySelfFreezeRead`, frozen while set.
#[derive(Clone, Default)]
struct Freeze(Arc<AtomicBool>);
impl SelfFreezeRead for Freeze {
    fn read(&self, _: &str) -> Result<FreezeReading, Unavailable> {
        Ok(if self.0.load(Ordering::SeqCst) {
            FreezeReading::Frozen { since: None }
        } else {
            FreezeReading::Open
        })
    }
}

/// `MemoryEventBus` with the TypeScript's `busDown`: while set, the alert event fails.
#[derive(Default, Clone)]
struct FakeBus {
    sent: Arc<Mutex<Vec<(String, String, Json)>>>,
    down: Arc<AtomicBool>,
}
impl FakeBus {
    fn emitted(&self, subject: &str) -> Vec<(String, Json)> {
        self.sent
            .lock()
            .unwrap()
            .iter()
            .filter(|(s, _, _)| s == subject)
            .map(|(_, k, e)| (k.clone(), e.get("payload").unwrap().clone()))
            .collect()
    }
}
impl Bus for FakeBus {
    fn publish(&self, subject: &str, msg_id: &str, envelope: &Json) -> Result<(), String> {
        if subject == USAGE_ALERT_CROSSED && self.down.load(Ordering::SeqCst) {
            return Err("TEST bus down".to_owned());
        }
        self.sent
            .lock()
            .unwrap()
            .push((subject.to_owned(), msg_id.to_owned(), envelope.clone()));
        Ok(())
    }
}

/// A ledger that books every charge once under its key.
#[derive(Default, Clone)]
struct FakeLedger(Arc<Mutex<BTreeMap<String, String>>>);
impl Ledger for FakeLedger {
    fn post_recipe(&self, recipe: &Recipe) -> Result<String, LedgerError> {
        let mut b = self.0.lock().unwrap();
        let n = b.len() + 1;
        Ok(b.entry(recipe.idempotency_key())
            .or_insert_with(|| format!("tx-{n}"))
            .clone())
    }
}

/// The funds of the runs that are not about the wallet: ample.
struct Ample;
impl Funds for Ample {
    fn available(&self, _: &Pool, _: &str, _: &str, _: &str, _: &str) -> Result<Reading, Unread> {
        Ok(Reading::Ledger(amt("100")))
    }
}

/// Identity's answer, as the stand-in gives it; none is identity unreachable.
#[derive(Clone)]
struct Wallets {
    linked: Arc<Mutex<Option<Linked>>>,
    asks: Arc<AtomicUsize>,
}
impl Wallets {
    fn usable() -> Wallets {
        Wallets {
            linked: Arc::new(Mutex::new(Some(Linked::Usable(vec![LinkedWallet {
                address: LINKED.to_owned(),
                linked_at: AS_OF.to_owned(),
            }])))),
            asks: Arc::new(AtomicUsize::new(0)),
        }
    }
    fn set(&self, l: Option<Linked>) {
        *self.linked.lock().unwrap() = l;
    }
}
impl LinkedWallets for Wallets {
    fn read(&self, _: &str) -> Option<Linked> {
        self.asks.fetch_add(1, Ordering::SeqCst);
        self.linked.lock().unwrap().clone()
    }
}

/// The chain's answer for a wallet: its figure, or the reason the read fails; or a node that never answers.
#[derive(Clone)]
struct Chain {
    answer: Arc<Mutex<Result<Amount, &'static str>>>,
    reads: Arc<Mutex<Vec<String>>>,
    hangs: Arc<AtomicBool>,
}
impl ChainBalance for Chain {
    fn read(&self, address: &str) -> Result<WalletBalance, &'static str> {
        self.reads.lock().unwrap().push(address.to_owned());
        if self.hangs.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_secs(10));
        }
        let available = (*self.answer.lock().unwrap())?;
        Ok(WalletBalance {
            available,
            token: "TESTUSD".to_owned(),
            chain_id: 84532,
            block: "777".to_owned(),
            as_of: AS_OF.to_owned(),
        })
    }
}

/// The platform balance a wallet run is billed to.
#[derive(Clone)]
struct Platform {
    balance: Arc<Mutex<Amount>>,
    reads: Arc<AtomicUsize>,
}
impl Balances for Platform {
    fn available(&self, _: &str, _: &str) -> Result<Amount, String> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        Ok(*self.balance.lock().unwrap())
    }
}

// ── The world ───────────────────────────────────────────────────────────────

struct World {
    db: TestDb,
    store: Store,
    gateway: Arc<Gateway>,
    bus: FakeBus,
    ledger: FakeLedger,
    freeze: Freeze,
    wallets: Wallets,
    chain: Chain,
    platform: Platform,
    m: Metering,
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

impl World {
    fn new() -> Option<World> {
        let db = TestDb::new()?;
        db.migrated();
        let provider = Arc::new(MockProvider::new(
            MockOptions {
                id: Some("primary".to_owned()),
                ..MockOptions::default()
            },
            system_now,
        ));
        let gateway = Arc::new(Gateway::new(
            vec![provider as Arc<dyn Provider>],
            parse_routing_table(TABLE).unwrap(),
        ));
        let mut w = World {
            store: db.store(),
            db,
            gateway,
            bus: FakeBus::default(),
            ledger: FakeLedger::default(),
            freeze: Freeze::default(),
            wallets: Wallets::usable(),
            chain: Chain {
                answer: Arc::new(Mutex::new(Ok(Amount::ZERO))),
                reads: Arc::new(Mutex::new(Vec::new())),
                hangs: Arc::new(AtomicBool::new(false)),
            },
            platform: Platform {
                balance: Arc::new(Mutex::new(amt("100"))),
                reads: Arc::new(AtomicUsize::new(0)),
            },
            m: Metering::unwired(FEE, 60),
        };
        w.m = w.metering();
        Some(w)
    }

    fn metering(&self) -> Metering {
        let mut m = Metering::unwired(FEE, 60);
        m.enabled = true;
        m.bus = Box::new(self.bus.clone());
        m.ledger = Box::new(self.ledger.clone());
        m
    }

    fn pool(&self) -> &Pool {
        self.store.pool().unwrap()
    }

    /// A runtime with a spend gate, the freeze read and these funds.
    fn runtime(&self, funds: Box<dyn Funds>, spend: bool) -> Runtime {
        let mut r = Runtime::unwired();
        r.spend = spend;
        r.funds = Some(funds);
        r.overage_grace = Some(amt("0"));
        r.self_freeze = Some(Box::new(self.freeze.clone()));
        r
    }

    /// `paymentMethodFunds` over the stand-ins; `chain_set = false` wires no chain reader, as a blank token does.
    fn wallet_funds(&self, chain_set: bool) -> Box<dyn Funds> {
        Box::new(PersonFunds {
            payment: Box::new(LedgerOnly),
            balances: Box::new(self.platform.clone()),
            wallets: Some(Arc::new(self.wallets.clone())),
            chain: chain_set.then(|| Arc::new(self.chain.clone()) as Arc<dyn ChainBalance>),
            deadline_ms: 200,
        })
    }

    fn door_with(&self, retention: Retention) -> AgentsDoor {
        let env: BTreeMap<String, String> = [
            ("APP_ENV", "test"),
            ("NODE_ENV", "test"),
            ("INTAFACED_SCREENING_FAIL_CLOSED", "off"),
            ("INTAFACED_UNSIGNED_SANCTIONS_ROWS", "off"),
        ]
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect();
        let mut own = Own::unwired();
        own.retention = retention;
        own.linked_wallets = Some(Arc::new(self.wallets.clone()));
        let mut rt = self.runtime(Box::new(Ample), true);
        rt.overage_grace = Some(amt("0.5"));
        AgentsDoor::new(DoorConfig {
            edge_secret: SECRET.to_owned(),
            services: ServiceAuth {
                secret: Some(SERVICE_SECRET.to_owned()),
                keys: None,
            },
            env,
            now: system_now,
            store: self.db.store(),
            gateway: GatewaySlice {
                gateway: self.gateway.clone(),
                fee_asset_id: FEE.to_owned(),
                metering_enabled: Some(true),
                window_minutes: 60,
            },
            ready: ReadyInput::unwired(),
            metering: self.metering(),
            runtime: rt,
            advisors: svc_agents::advisors::Advisors::unwired(),
            background: svc_agents::background::Settings::default(),
            own,
            team: svc_agents::team::Team::unwired(),
            ops: svc_agents::ops::Ops::unwired(),
        })
        .unwrap()
    }

    fn door(&self) -> AgentsDoor {
        self.door_with(Retention::default())
    }

    fn x<'a>(&'a self, rt: &'a Runtime) -> Rt<'a> {
        Rt {
            rt,
            pool: self.pool(),
            gateway: &self.gateway,
            m: &self.m,
            now: system_now(),
        }
    }

    fn count(&self, sql: &str) -> i64 {
        self.db.count(sql)
    }
}

// ── The caller ──────────────────────────────────────────────────────────────

/// `callerFor(userId, scopes, { kid })`: a signed principal.
fn caller(user: &str, scopes: &[&str], kid: Option<&str>) -> Vec<(String, String)> {
    let mut fields = vec![
        ("sub", Json::str(user)),
        ("userId", Json::str(user)),
        ("sid", Json::str("55555555-5555-4555-8555-555555555555")),
        (
            "scopes",
            Json::Array(scopes.iter().map(|s| Json::str(*s)).collect()),
        ),
        ("tier", Json::str("basic")),
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

const PERSON: [&str; 3] = ["agents:read", "agents:execute", "identity:write"];

fn person(user: &str) -> Vec<(String, String)> {
    caller(user, &PERSON, None)
}

/// The same person without identity:write: an agent's token or another app, not their own signed-in session.
fn not_session(user: &str) -> Vec<(String, String)> {
    caller(user, &["agents:read", "agents:execute"], None)
}

type Answer = (u16, Json);

fn query(
    door: &AgentsDoor,
    path: &str,
    input: Option<&Json>,
    headers: &[(String, String)],
) -> Answer {
    let url = match input {
        Some(input) => {
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
            format!("/trpc/{path}?input={enc}")
        }
        None => format!("/trpc/{path}"),
    };
    let res = door.handle(&Request {
        method: "GET",
        url: &url,
        headers,
        body: "",
    });
    (res.status, json::parse(&res.body).unwrap())
}

fn mutate(door: &AgentsDoor, path: &str, input: &Json, headers: &[(String, String)]) -> Answer {
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

fn data(a: &Answer) -> Json {
    assert_eq!(a.0, 200, "{}", a.1.compact());
    a.1.get("result").unwrap().get("data").unwrap().clone()
}

/// A refusal's tRPC code and message.
fn refused(a: &Answer) -> (String, String) {
    assert_ne!(a.0, 200, "{}", a.1.compact());
    let e = a.1.get("error").unwrap();
    (text(e.get("data").unwrap(), "code"), text(e, "message"))
}

fn text(v: &Json, key: &str) -> String {
    match v.get(key) {
        Some(Json::String(s)) => s.clone(),
        other => panic!("{key} is not a string: {other:?}"),
    }
}

fn obj(fields: &[(&str, Json)]) -> Json {
    Json::Object(
        fields
            .iter()
            .map(|(k, v)| ((*k).to_owned(), v.clone()))
            .collect(),
    )
}

fn id_of(id: &str) -> Json {
    obj(&[("id", Json::str(id))])
}

/// An own agent of the person's, with its instructions and its own cap per session.
fn own_agent(door: &AgentsDoor, user: &str, cap: Option<&str>) -> String {
    let created = data(&mutate(
        door,
        "own.create",
        &obj(&[
            ("template", Json::str("service-starter")),
            (
                "createKey",
                Json::str(format!(
                    "controls:{}",
                    svc_agents::metering::settle::random_uuid().unwrap()
                )),
            ),
        ]),
        &person(user),
    ));
    let id = text(&created, "id");
    data(&mutate(
        door,
        "own.save",
        &obj(&[
            ("id", Json::str(id.clone())),
            ("name", Json::str("TEST helper")),
            ("instructions", Json::str(INSTRUCTIONS)),
            ("tools", Json::Array(vec![Json::str("support.kb.search")])),
            ("perSessionCap", cap.map_or(Json::Null, Json::str)),
        ]),
        &person(user),
    ));
    id
}

fn set_limits(
    door: &AgentsDoor,
    user: &str,
    id: &str,
    call: &str,
    session: &str,
    period: &str,
) -> Answer {
    mutate(
        door,
        "own.limits.set",
        &obj(&[
            ("id", Json::str(id)),
            ("perCall", Json::str(call)),
            ("perSession", Json::str(session)),
            ("perPeriod", Json::str(period)),
        ]),
        &person(user),
    )
}

fn usage_limits(
    door: &AgentsDoor,
    id: &str,
    alert: Option<&str>,
    hard: Option<&str>,
    email: bool,
) -> Answer {
    mutate(
        door,
        "own.usageLimits.set",
        &obj(&[
            ("id", Json::str(id)),
            ("alertAt", alert.map_or(Json::Null, Json::str)),
            ("hardLimit", hard.map_or(Json::Null, Json::str)),
            ("email", Json::Bool(email)),
        ]),
        &person(USER),
    )
}

/// `own.session.open`: a session bound to the agent's guardrail.
fn open(w: &World, rt: &Runtime, user: &str, id: &str) -> String {
    let agent = store::get(w.pool(), user, id).unwrap();
    open_own_session(&w.x(rt), user, &own_guardrail(&agent).unwrap())
        .unwrap()
        .id
}

/// `own.run`: the agent's instructions and the person's ask, on the run task.
fn run(w: &World, rt: &Runtime, session: &str, request: &str) -> Result<ThinkResult, RunError> {
    runtime::think(
        &w.x(rt),
        &ThinkInput {
            session_id: session,
            request_id: request,
            task: "own.run",
            system: Some(INSTRUCTIONS),
            messages: &msgs(),
            max_output_tokens: None,
            team_run: false,
        },
    )
}

fn refusal_code(r: &Result<ThinkResult, RunError>) -> String {
    match r {
        Err(RunError::Refused { refusal, .. }) => refusal.code.clone(),
        other => panic!("expected a refusal, got {other:?}"),
    }
}

/// Keys in one order: the stored parameters come back from jsonb, which orders keys its own way.
fn canon(j: &Json) -> Json {
    match j {
        Json::Object(fields) => {
            let mut f: Vec<(String, Json)> =
                fields.iter().map(|(k, v)| (k.clone(), canon(v))).collect();
            f.sort_by(|a, b| a.0.cmp(&b.0));
            Json::Object(f)
        }
        Json::Array(xs) => Json::Array(xs.iter().map(canon).collect()),
        other => other.clone(),
    }
}

fn canon_str(s: &str) -> String {
    canon(&json::parse(s).unwrap()).compact()
}

/// The newest refused run's stored words' parameters, keys in one order.
fn refused_params(w: &World) -> String {
    let row =
        w.db.client()
            .query_one(
                "SELECT user_message_params::text FROM agents.agent_actions
              WHERE status = 'refused' ORDER BY occurred_at DESC, sequence DESC LIMIT 1",
                &[],
            )
            .unwrap();
    canon_str(&row.get::<_, String>(0))
}

// ── Limits ──────────────────────────────────────────────────────────────────

#[test]
fn limits_read_blank_store_all_three_and_refuse_what_could_never_apply() {
    let w = world_or_skip!();
    let door = w.door();
    let id = own_agent(&door, USER, Some("1"));
    assert_eq!(
        data(&query(
            &door,
            "own.limits.get",
            Some(&id_of(&id)),
            &person(USER)
        ))
        .compact(),
        r#"{"limits":null,"agentCap":"1","effectivePerSession":null,"overageGrace":"0.5","assetId":"USDT"}"#
    );
    let set = data(&set_limits(&door, USER, &id, "0.012", "0.5", "5"));
    assert_eq!(
        set.compact(),
        r#"{"limits":{"perCall":"0.012","perSession":"0.5","perPeriod":"5","period":"month"},"agentCap":"1","effectivePerSession":"0.5","overageGrace":"0.5","assetId":"USDT"}"#
    );
    assert_eq!(
        data(&set_limits(&door, USER, &id, "0.012", "0.5", "5")),
        set
    );
    for (call, session, period, code) in [
        ("", "0.5", "5", "agents.spend.cap_unset"),
        ("lots", "0.5", "5", "agents.own.cap_invalid"),
        ("-1", "0.5", "5", "agents.own.cap_invalid"),
        ("0.1", "2", "5", "agents.spend.above_agent_cap"),
        ("0.6", "0.5", "5", "agents.spend.per_call_above_session"),
    ] {
        assert_eq!(
            refused(&set_limits(&door, USER, &id, call, session, period)),
            ("BAD_REQUEST".to_owned(), code.to_owned()),
            "{call} {session}"
        );
    }
    assert_eq!(
        refused(&set_limits(&door, OTHER, &id, "0.1", "0.5", "5")),
        ("NOT_FOUND".to_owned(), "agents.own.not_found".to_owned())
    );
    assert_eq!(
        refused(&query(
            &door,
            "own.limits.get",
            Some(&id_of(&id)),
            &person(OTHER)
        ))
        .1,
        "agents.own.not_found"
    );
    // The stored caps stayed as they were.
    assert_eq!(
        data(&query(
            &door,
            "own.limits.get",
            Some(&id_of(&id)),
            &person(USER)
        )),
        set
    );
    // An agent with no cap of its own takes no limits until it has one.
    let uncapped = own_agent(&door, USER, None);
    assert_eq!(
        refused(&set_limits(&door, USER, &uncapped, "0.1", "0.5", "5")).1,
        "agents.spend.cap_unset"
    );
}

// ── Usage limits (own/usage-limits.test.ts) ─────────────────────────────────

fn month() -> String {
    system_now().iso().chars().take(7).collect()
}

#[test]
fn usage_limits_read_nothing_set_then_store_re_store_and_clear() {
    let w = world_or_skip!();
    let door = w.door();
    let id = own_agent(&door, USER, Some("1"));
    let blank = format!(
        r#"{{"alertAt":null,"hardLimit":null,"email":false,"month":"{}","spent":"0","alertCrossed":false,"alert":null,"hardLimitReached":false,"hardLimitRoom":null,"assetId":"USDT"}}"#,
        month()
    );
    assert_eq!(
        data(&query(
            &door,
            "own.usageLimits.get",
            Some(&id_of(&id)),
            &person(USER)
        ))
        .compact(),
        blank
    );
    let set = data(&usage_limits(&door, &id, Some("0.5"), Some("2"), true));
    assert_eq!(
        set.compact(),
        format!(
            r#"{{"alertAt":"0.5","hardLimit":"2","email":true,"month":"{}","spent":"0","alertCrossed":false,"alert":null,"hardLimitReached":false,"hardLimitRoom":"2","assetId":"USDT"}}"#,
            month()
        )
    );
    assert_eq!(
        data(&usage_limits(&door, &id, Some("0.5"), Some("2"), true)),
        set
    );
    assert_eq!(
        data(&query(
            &door,
            "own.usageLimits.get",
            Some(&id_of(&id)),
            &person(USER)
        )),
        set
    );
    assert_eq!(
        data(&usage_limits(&door, &id, Some(" "), None, false)).compact(),
        blank
    );
}

#[test]
fn usage_limits_refuse_bad_amounts_and_an_alert_at_or_above_the_limit_keeping_what_was_stored() {
    let w = world_or_skip!();
    let door = w.door();
    let id = own_agent(&door, USER, Some("1"));
    let stored = data(&usage_limits(&door, &id, Some("0.5"), Some("2"), false));
    for (alert, hard, code) in [
        ("lots", "2", "agents.usage.limit_invalid"),
        ("0", "2", "agents.usage.limit_invalid"),
        ("0.5", "-1", "agents.usage.limit_invalid"),
        ("2", "2", "agents.usage.alert_above_limit"),
        ("3", "2", "agents.usage.alert_above_limit"),
    ] {
        assert_eq!(
            refused(&usage_limits(&door, &id, Some(alert), Some(hard), true)),
            ("BAD_REQUEST".to_owned(), code.to_owned())
        );
    }
    assert_eq!(
        refused(&query(
            &door,
            "own.usageLimits.get",
            Some(&id_of(&id)),
            &person(OTHER)
        )),
        ("NOT_FOUND".to_owned(), "agents.own.not_found".to_owned())
    );
    let other = mutate(
        &door,
        "own.usageLimits.set",
        &obj(&[
            ("id", Json::str(id.clone())),
            ("alertAt", Json::Null),
            ("hardLimit", Json::Null),
            ("email", Json::Bool(false)),
        ]),
        &person(OTHER),
    );
    assert_eq!(refused(&other).0, "NOT_FOUND");
    assert_eq!(
        data(&query(
            &door,
            "own.usageLimits.get",
            Some(&id_of(&id)),
            &person(USER)
        )),
        stored
    );
}

/// The agent ready to run: its caps set and a session open.
fn ready(w: &World, door: &AgentsDoor, rt: &Runtime) -> (String, String) {
    let id = own_agent(door, USER, Some("1"));
    data(&set_limits(door, USER, &id, "0.012", "0.1", "5"));
    let session = open(w, rt, USER, &id);
    (id, session)
}

fn alert_rows(w: &World) -> Vec<(String, bool, String)> {
    w.db
        .client()
        .query(
            "SELECT alert_key, published_at IS NOT NULL, spent::text FROM agents.own_agent_usage_alerts ORDER BY created_at",
            &[],
        )
        .unwrap()
        .iter()
        .map(|r| (r.get(0), r.get(1), format_amount(amt(&r.get::<_, String>(2)))))
        .collect()
}

#[test]
fn the_alert_is_recorded_once_and_a_bus_fault_is_caught_up_on_the_next_read() {
    let w = world_or_skip!();
    let door = w.door();
    let rt = w.runtime(Box::new(Ample), true);
    let (id, session) = ready(&w, &door, &rt);
    data(&usage_limits(&door, &id, Some(TINY), None, true));
    w.bus.down.store(true, Ordering::SeqCst);
    let first = run(&w, &rt, &session, "usage-alert-1").unwrap();
    let second = run(&w, &rt, &session, "usage-alert-2").unwrap();
    assert!(first.cost > Amount::ZERO);
    let key = format!("agents.usage_alert:{id}:{}", month());
    assert_eq!(
        alert_rows(&w),
        vec![(key.clone(), false, format_amount(first.cost))]
    );
    assert!(w.bus.emitted(USAGE_ALERT_CROSSED).is_empty());
    // Still down: the read answers and the alert waits.
    let view = data(&query(
        &door,
        "own.usageLimits.get",
        Some(&id_of(&id)),
        &person(USER),
    ));
    assert_eq!(view.get("alertCrossed"), Some(&Json::Bool(true)));
    w.bus.down.store(false, Ordering::SeqCst);
    let view = data(&query(
        &door,
        "own.usageLimits.get",
        Some(&id_of(&id)),
        &person(USER),
    ));
    data(&query(
        &door,
        "own.usageLimits.get",
        Some(&id_of(&id)),
        &person(USER),
    ));
    assert!(alert_rows(&w)[0].1);
    let emitted = w.bus.emitted(USAGE_ALERT_CROSSED);
    assert_eq!(emitted.len(), 1);
    assert_eq!(emitted[0].0, key);
    assert_eq!(text(&emitted[0].1, "alertAt"), TINY);
    assert_eq!(text(&emitted[0].1, "spent"), format_amount(first.cost));
    // The one record: written by the run that crossed, never rewritten by the later run.
    assert_eq!(
        view.get("alert").unwrap().compact(),
        format!(
            r#"{{"key":"{key}","spent":"{}"}}"#,
            format_amount(first.cost)
        )
    );
    assert_eq!(amt(&text(&view, "spent")), first.cost + second.cost);
}

#[test]
fn an_alert_set_at_or_below_what_was_spent_is_reached_on_save() {
    let w = world_or_skip!();
    let door = w.door();
    let rt = w.runtime(Box::new(Ample), true);
    let (id, session) = ready(&w, &door, &rt);
    run(&w, &rt, &session, "usage-before-1").unwrap();
    assert!(alert_rows(&w).is_empty());
    let view = data(&usage_limits(&door, &id, Some(TINY), None, false));
    assert_eq!(view.get("alertCrossed"), Some(&Json::Bool(true)));
    assert_eq!(alert_rows(&w).len(), 1);
}

#[test]
fn the_hard_limit_room_counts_held_runs_and_a_run_that_does_not_fit_is_refused() {
    let w = world_or_skip!();
    let door = w.door();
    let rt = w.runtime(Box::new(Ample), true);
    let (id, session) = ready(&w, &door, &rt);
    data(&usage_limits(&door, &id, None, Some("1"), false));
    let first = run(&w, &rt, &session, "usage-hard-1").unwrap();
    let short = format_amount(first.cost + worst() - Amount::from_scaled(1));
    data(&usage_limits(&door, &id, None, Some(&short), false));
    let view = data(&query(
        &door,
        "own.usageLimits.get",
        Some(&id_of(&id)),
        &person(USER),
    ));
    assert_eq!(view.get("hardLimitReached"), Some(&Json::Bool(false)));
    assert_eq!(
        text(&view, "hardLimitRoom"),
        format_amount(worst() - Amount::from_scaled(1))
    );
    assert_eq!(text(&view, "spent"), format_amount(first.cost));
    let err = run(&w, &rt, &session, "usage-hard-2");
    assert_eq!(refusal_code(&err), "agents.usage.hard_limit_reached");
    let exact = format_amount(first.cost + worst());
    data(&usage_limits(&door, &id, None, Some(&exact), false));
    run(&w, &rt, &session, "usage-hard-3").unwrap();
    let view = data(&query(
        &door,
        "own.usageLimits.get",
        Some(&id_of(&id)),
        &person(USER),
    ));
    assert!(amt(&text(&view, "spent")) <= amt(&exact));
}

// ── The payment method (own/payment-method.test.ts) ─────────────────────────

fn pm_set(door: &AgentsDoor, user: &str, id: &str, address: Option<&str>) -> Answer {
    mutate(
        door,
        "own.paymentMethod.set",
        &obj(&[
            ("id", Json::str(id)),
            ("address", address.map_or(Json::Null, Json::str)),
        ]),
        &person(user),
    )
}

fn stored_method(w: &World) -> Vec<(String, String)> {
    w.db.client()
        .query(
            "SELECT kind, address FROM agents.own_agent_payment_methods",
            &[],
        )
        .unwrap()
        .iter()
        .map(|r| (r.get(0), r.get(1)))
        .collect()
}

#[test]
fn the_method_shows_linked_wallets_and_identity_unreachable_reads_unread() {
    let w = world_or_skip!();
    let door = w.door();
    let id = own_agent(&door, USER, Some("1"));
    assert_eq!(
        data(&query(
            &door,
            "own.paymentMethod.get",
            Some(&id_of(&id)),
            &person(USER)
        ))
        .compact(),
        format!(
            r#"{{"method":null,"linked":{{"state":"usable","wallets":[{{"address":"{LINKED}","linkedAt":"{AS_OF}"}}]}}}}"#
        )
    );
    w.wallets.set(None);
    assert_eq!(
        data(&query(
            &door,
            "own.paymentMethod.get",
            Some(&id_of(&id)),
            &person(USER)
        ))
        .compact(),
        r#"{"method":null,"linked":{"state":"unread"}}"#
    );
}

#[test]
fn choosing_a_linked_wallet_is_checked_now_and_stored_lower_case_and_clearing_removes_it() {
    let w = world_or_skip!();
    let door = w.door();
    let id = own_agent(&door, USER, Some("1"));
    let chosen = data(&pm_set(
        &door,
        USER,
        &id,
        Some(&LINKED.to_uppercase().replace("0X", "0x")),
    ));
    let method = chosen.get("method").unwrap();
    assert_eq!(text(method, "kind"), "wallet");
    assert_eq!(text(method, "address"), LINKED);
    assert!(text(method, "chosenAt").ends_with('Z'));
    assert!(w.wallets.asks.load(Ordering::SeqCst) > 0);
    assert_eq!(
        stored_method(&w),
        vec![("wallet".to_owned(), LINKED.to_owned())]
    );
    assert_eq!(
        data(&pm_set(&door, USER, &id, None)).get("method"),
        Some(&Json::Null)
    );
    assert!(stored_method(&w).is_empty());
}

#[test]
fn a_wallet_not_linked_an_inactive_account_or_identity_down_is_refused_and_nothing_stored() {
    let w = world_or_skip!();
    let door = w.door();
    let id = own_agent(&door, USER, Some("1"));
    assert_eq!(
        refused(&pm_set(&door, USER, &id, Some(OTHER_WALLET))),
        (
            "BAD_REQUEST".to_owned(),
            "agents.payment_method.wallet_not_linked".to_owned()
        )
    );
    w.wallets.set(Some(Linked::AccountInactive));
    assert_eq!(
        refused(&pm_set(&door, USER, &id, Some(LINKED))),
        (
            "BAD_REQUEST".to_owned(),
            "agents.payment_method.account_inactive".to_owned()
        )
    );
    w.wallets.set(None);
    assert_eq!(
        refused(&pm_set(&door, USER, &id, Some(LINKED))),
        (
            "SERVICE_UNAVAILABLE".to_owned(),
            "agents.payment_method.wallets_unread".to_owned()
        )
    );
    assert!(stored_method(&w).is_empty());
    assert_eq!(
        refused(&query(
            &door,
            "own.paymentMethod.get",
            Some(&id_of(&id)),
            &person(OTHER)
        ))
        .1,
        "agents.own.not_found"
    );
    assert_eq!(
        refused(&pm_set(&door, OTHER, &id, Some(LINKED))).1,
        "agents.own.not_found"
    );
}

/// An agent paying from the linked wallet, with a session open on a runtime reading it.
fn with_wallet(w: &World, door: &AgentsDoor, rt: &Runtime) -> String {
    let id = own_agent(door, USER, Some("1"));
    data(&set_limits(door, USER, &id, "0.012", "0.02", "5"));
    data(&pm_set(door, USER, &id, Some(LINKED)));
    open(w, rt, USER, &id)
}

fn holds(w: &World) -> i64 {
    w.count("SELECT count(*)::bigint FROM agents.spend_reservations")
}

fn usage_rows(w: &World) -> i64 {
    w.count("SELECT count(*)::bigint FROM agents.usage_records")
}

#[test]
fn a_wallet_below_the_worst_case_refuses_naming_the_wallet_and_its_figure_with_nothing_held() {
    for spend in [true, false] {
        let w = world_or_skip!();
        let door = w.door();
        let rt = w.runtime(w.wallet_funds(true), spend);
        *w.chain.answer.lock().unwrap() = Ok(worst() - Amount::from_scaled(1));
        let session = with_wallet(&w, &door, &rt);
        let err = run(&w, &rt, &session, "pm-poor-run");
        assert_eq!(refusal_code(&err), "agents.funds_insufficient");
        assert_eq!(*w.chain.reads.lock().unwrap(), vec![LINKED.to_owned()]);
        // The platform balance the run would be billed to is read with the wallet; the wallet is the short one.
        assert_eq!(w.platform.reads.load(Ordering::SeqCst), 1);
        assert_eq!((holds(&w), usage_rows(&w)), (0, 0));
        assert_eq!(
            refused_params(&w),
            canon_str(&format!(
                r#"{{"worstCase":"{}","asset":"USDT","method":"wallet","address":"{LINKED}","available":"{}","token":"TESTUSD","source":"chain","chainId":84532,"block":"777","asOf":"{AS_OF}"}}"#,
                format_amount(worst()),
                format_amount(worst() - Amount::from_scaled(1))
            ))
        );
    }
}

#[test]
fn a_wallet_that_covers_the_worst_case_runs_when_the_billed_balance_covers_it_too() {
    let w = world_or_skip!();
    let door = w.door();
    let rt = w.runtime(w.wallet_funds(true), true);
    *w.chain.answer.lock().unwrap() = Ok(worst());
    let session = with_wallet(&w, &door, &rt);
    let ran = run(&w, &rt, &session, "pm-ok-run").unwrap();
    assert!(!ran.text.is_empty());
    assert_eq!(w.platform.reads.load(Ordering::SeqCst), 1);
}

#[test]
fn a_covering_wallet_with_a_platform_balance_that_cannot_pay_refuses_as_today() {
    for spend in [true, false] {
        let w = world_or_skip!();
        let door = w.door();
        let rt = w.runtime(w.wallet_funds(true), spend);
        *w.chain.answer.lock().unwrap() = Ok(worst() * 10);
        *w.platform.balance.lock().unwrap() = Amount::ZERO;
        let session = with_wallet(&w, &door, &rt);
        let err = run(&w, &rt, &session, "pm-unbilled-run");
        assert_eq!(refusal_code(&err), "agents.funds_insufficient");
        assert_eq!((holds(&w), usage_rows(&w)), (0, 0));
        assert_eq!(
            refused_params(&w),
            canon_str(&format!(
                r#"{{"worstCase":"{}","asset":"USDT"}}"#,
                format_amount(worst())
            ))
        );
    }
}

#[test]
fn a_node_that_never_answers_is_unread_within_the_deadline() {
    let w = world_or_skip!();
    let door = w.door();
    let rt = w.runtime(w.wallet_funds(true), true);
    w.chain.hangs.store(true, Ordering::SeqCst);
    let session = with_wallet(&w, &door, &rt);
    let started = Clock::now();
    let err = run(&w, &rt, &session, "pm-hung-run");
    assert_eq!(refusal_code(&err), "agents.funds_unread");
    assert!(started.elapsed() < Duration::from_secs(5));
    assert_eq!(holds(&w), 0);
    assert_eq!(
        refused_params(&w),
        canon_str(&format!(
            r#"{{"worstCase":"{}","asset":"USDT","method":"wallet","address":"{LINKED}","reason":"method_unread"}}"#,
            format_amount(worst())
        ))
    );
}

#[test]
fn each_unread_wallet_says_why_and_the_run_does_not_start() {
    for reason in [
        "chain_unreachable",
        "wallet_unlinked",
        "account_inactive",
        "identity_unreachable",
        "payment_token_unset",
    ] {
        let w = world_or_skip!();
        let door = w.door();
        let rt = w.runtime(w.wallet_funds(reason != "payment_token_unset"), true);
        let session = with_wallet(&w, &door, &rt);
        match reason {
            "chain_unreachable" => *w.chain.answer.lock().unwrap() = Err("chain_unreachable"),
            "wallet_unlinked" => w.wallets.set(Some(Linked::Usable(vec![]))),
            "account_inactive" => w.wallets.set(Some(Linked::AccountInactive)),
            "identity_unreachable" => w.wallets.set(None),
            _ => {}
        }
        let err = run(&w, &rt, &session, &format!("pm-unread-{reason}"));
        assert_eq!(refusal_code(&err), "agents.funds_unread", "{reason}");
        assert_eq!(w.platform.reads.load(Ordering::SeqCst), 0, "{reason}");
        assert_eq!((holds(&w), usage_rows(&w)), (0, 0), "{reason}");
        if reason != "chain_unreachable" {
            assert!(w.chain.reads.lock().unwrap().is_empty(), "{reason}");
        }
        assert_eq!(
            refused_params(&w),
            canon_str(&format!(
                r#"{{"worstCase":"{}","asset":"USDT","method":"wallet","address":"{LINKED}","reason":"{reason}"}}"#,
                format_amount(worst())
            ))
        );
    }
}

#[test]
fn with_no_method_chosen_the_platform_balance_is_read_as_before() {
    let w = world_or_skip!();
    let door = w.door();
    let rt = w.runtime(w.wallet_funds(true), true);
    *w.platform.balance.lock().unwrap() = worst() - Amount::from_scaled(1);
    let id = own_agent(&door, USER, Some("1"));
    data(&set_limits(&door, USER, &id, "0.012", "0.02", "5"));
    let session = open(&w, &rt, USER, &id);
    let asks = w.wallets.asks.load(Ordering::SeqCst);
    let err = run(&w, &rt, &session, "pm-ledger-run");
    assert_eq!(refusal_code(&err), "agents.funds_insufficient");
    assert!(w.chain.reads.lock().unwrap().is_empty());
    assert_eq!(w.wallets.asks.load(Ordering::SeqCst), asks);
    assert_eq!(w.platform.reads.load(Ordering::SeqCst), 1);
    assert_eq!(
        refused_params(&w),
        canon_str(&format!(
            r#"{{"worstCase":"{}","asset":"USDT"}}"#,
            format_amount(worst())
        ))
    );
}

// ── Policy (own/policy.test.ts) ─────────────────────────────────────────────

fn policy_add(
    door: &AgentsDoor,
    who: &[(String, String)],
    id: &str,
    effect: &str,
    action: &str,
    scope: &str,
) -> Answer {
    mutate(
        door,
        "own.policy.add",
        &obj(&[
            ("id", Json::str(id)),
            ("effect", Json::str(effect)),
            ("action", Json::str(action)),
            ("scope", Json::str(scope)),
        ]),
        who,
    )
}

fn check(door: &AgentsDoor, id: &str, action: &str, account: &str) -> Answer {
    query(
        door,
        "own.policy.check",
        Some(&obj(&[
            ("id", Json::str(id)),
            ("action", Json::str(action)),
            ("account", Json::str(account)),
        ])),
        &person(USER),
    )
}

fn decision_of(policy: &Json, action: &str) -> Json {
    match policy.get("decisions") {
        Some(Json::Array(ds)) => ds
            .iter()
            .find(|d| text(d, "action") == action)
            .unwrap()
            .clone(),
        _ => panic!("no decisions"),
    }
}

fn rules(policy: &Json) -> Vec<Json> {
    match policy.get("rules") {
        Some(Json::Array(rs)) => rs.clone(),
        _ => panic!("no rules"),
    }
}

#[test]
fn allow_then_deny_and_deny_then_allow_both_refuse_and_the_check_refuses_with_the_code() {
    let w = world_or_skip!();
    let door = w.door();
    for order in [["allow", "deny"], ["deny", "allow"]] {
        let id = own_agent(&door, USER, Some("1"));
        let mut policy = Json::Null;
        for effect in order {
            let scope = if effect == "allow" { "all" } else { "main" };
            policy = data(&policy_add(
                &door,
                &person(USER),
                &id,
                effect,
                "place_order",
                scope,
            ));
        }
        let deny = rules(&policy)
            .into_iter()
            .find(|r| text(r, "effect") == "deny")
            .unwrap();
        assert_eq!(
            decision_of(&policy, "place_order").compact(),
            format!(
                r#"{{"action":"place_order","account":"main","outcome":"denied","ruleId":"{}"}}"#,
                text(&deny, "id")
            )
        );
        assert_eq!(
            refused(&check(&door, &id, "place_order", "main")),
            ("FORBIDDEN".to_owned(), "agents.policy_denied".to_owned())
        );
    }
}

#[test]
fn rules_required_refuses_an_action_no_rule_allows_and_off_again_leaves_it_to_the_other_gates() {
    let w = world_or_skip!();
    let door = w.door();
    let id = own_agent(&door, USER, Some("1"));
    data(&policy_add(
        &door,
        &person(USER),
        &id,
        "allow",
        "place_order",
        "all",
    ));
    assert_eq!(
        text(&data(&check(&door, &id, "cancel_order", "main")), "outcome"),
        "no_rule"
    );
    let require = |on: bool| {
        mutate(
            &door,
            "own.policy.require",
            &obj(&[
                ("id", Json::str(id.clone())),
                ("rulesRequired", Json::Bool(on)),
            ]),
            &person(USER),
        )
    };
    let required = data(&require(true));
    assert_eq!(required.get("rulesRequired"), Some(&Json::Bool(true)));
    assert_eq!(
        text(&decision_of(&required, "cancel_order"), "outcome"),
        "no_match_refused"
    );
    assert_eq!(
        refused(&check(&door, &id, "cancel_order", "main")),
        ("FORBIDDEN".to_owned(), "agents.policy_no_match".to_owned())
    );
    assert_eq!(
        text(&data(&check(&door, &id, "place_order", "main")), "outcome"),
        "allowed"
    );
    assert_eq!(
        text(
            &decision_of(&data(&require(false)), "cancel_order"),
            "outcome"
        ),
        "no_rule"
    );
}

#[test]
fn adding_a_rule_again_is_the_stored_row_and_removing_it_ends_it() {
    let w = world_or_skip!();
    let door = w.door();
    let id = own_agent(&door, USER, Some("1"));
    let first = data(&policy_add(
        &door,
        &person(USER),
        &id,
        "deny",
        "place_order",
        "main",
    ));
    let again = data(&policy_add(
        &door,
        &person(USER),
        &id,
        "deny",
        "place_order",
        "main",
    ));
    assert_eq!(rules(&again), rules(&first));
    let rule_id = text(&rules(&first)[0], "id");
    let remove = || {
        mutate(
            &door,
            "own.policy.remove",
            &obj(&[
                ("id", Json::str(id.clone())),
                ("ruleId", Json::str(rule_id.clone())),
            ]),
            &person(USER),
        )
    };
    let removed = data(&remove());
    assert!(rules(&removed).is_empty());
    assert_eq!(
        text(&decision_of(&removed, "place_order"), "outcome"),
        "no_rule"
    );
    // A repeated remove of the same rule answers the same.
    assert_eq!(data(&remove()), removed);
    let readded = data(&policy_add(
        &door,
        &person(USER),
        &id,
        "deny",
        "place_order",
        "main",
    ));
    assert_ne!(text(&rules(&readded)[0], "id"), rule_id);
    assert_eq!(
        w.count(
            "SELECT count(*)::bigint FROM agents.own_agent_policy_rules WHERE removed_at IS NULL"
        ),
        1
    );
    let unknown = mutate(
        &door,
        "own.policy.remove",
        &obj(&[
            ("id", Json::str(id.clone())),
            ("ruleId", Json::str("99999999-9999-4999-8999-999999999999")),
        ]),
        &person(USER),
    );
    assert_eq!(refused(&unknown).1, "agents.policy_rule_not_found");
}

#[test]
fn only_the_person_writes_their_rules() {
    let w = world_or_skip!();
    let door = w.door();
    let id = own_agent(&door, USER, Some("1"));
    let policy = data(&policy_add(
        &door,
        &person(USER),
        &id,
        "allow",
        "place_order",
        "all",
    ));
    assert_eq!(
        refused(&policy_add(
            &door,
            &person(OTHER),
            &id,
            "allow",
            "cancel_order",
            "all"
        ))
        .1,
        "agents.own.not_found"
    );
    let removed = mutate(
        &door,
        "own.policy.remove",
        &obj(&[
            ("id", Json::str(id.clone())),
            ("ruleId", Json::str(text(&rules(&policy)[0], "id"))),
        ]),
        &person(OTHER),
    );
    assert_eq!(refused(&removed).1, "agents.own.not_found");
    assert_ne!(
        policy_add(
            &door,
            &not_session(USER),
            &id,
            "allow",
            "cancel_order",
            "all"
        )
        .0,
        200
    );
    let require = mutate(
        &door,
        "own.policy.require",
        &obj(&[
            ("id", Json::str(id.clone())),
            ("rulesRequired", Json::Bool(true)),
        ]),
        &not_session(USER),
    );
    assert_ne!(require.0, 200);
    assert_eq!(
        rules(&data(&query(
            &door,
            "own.policy.get",
            Some(&id_of(&id)),
            &person(USER)
        )))
        .len(),
        1
    );
}

#[test]
fn an_allow_and_turning_rules_off_wait_for_the_owners_freeze_and_a_deny_does_not() {
    let w = world_or_skip!();
    let door = w.door();
    let id = own_agent(&door, USER, Some("1"));
    w.freeze.0.store(true, Ordering::SeqCst);
    assert_eq!(
        refused(&policy_add(
            &door,
            &person(USER),
            &id,
            "allow",
            "place_order",
            "all"
        )),
        (
            "FORBIDDEN".to_owned(),
            "agents.identity.owner_frozen_self".to_owned()
        )
    );
    data(&policy_add(
        &door,
        &person(USER),
        &id,
        "deny",
        "place_order",
        "main",
    ));
    let off = mutate(
        &door,
        "own.policy.require",
        &obj(&[
            ("id", Json::str(id.clone())),
            ("rulesRequired", Json::Bool(false)),
        ]),
        &person(USER),
    );
    assert_eq!(refused(&off).0, "FORBIDDEN");
}

#[test]
fn a_sub_account_with_no_live_access_is_refused_before_the_rules_and_svc_trade_asks_the_same() {
    let w = world_or_skip!();
    let door = w.door();
    let id = own_agent(&door, USER, Some("1"));
    data(&policy_add(
        &door,
        &person(USER),
        &id,
        "allow",
        "place_order",
        "all",
    ));
    assert_eq!(
        refused(&check(&door, &id, "place_order", SUB)),
        (
            "FORBIDDEN".to_owned(),
            "agents.access_account_denied".to_owned()
        )
    );
    let sub = SUB.strip_prefix("sub:").unwrap();
    let grant = |ends: &str| {
        w.db.client()
            .execute(
                &format!(
                    "INSERT INTO agents.own_agent_account_access
                       (agent_id, owner_id, grant_key, venue_id, venue_owner, sub_account, name, granted_at, ends_at)
                     VALUES ($1::text::uuid, $2::text, $3::text, 'TEST venue', $4::text, $4::text, 'TEST', now() - interval '2 days', {ends})"
                ),
                &[&id, &USER, &format!("agents:access:{id}:{ends}"), &sub],
            )
            .unwrap();
    };
    grant("now() - interval '1 day'");
    assert_eq!(
        refused(&check(&door, &id, "place_order", SUB)).1,
        "agents.access_expired"
    );
    w.db.client()
        .execute(
            "UPDATE agents.own_agent_account_access SET ended_at = now()",
            &[],
        )
        .unwrap();
    grant("now() + interval '1 day'");
    assert_eq!(
        text(&data(&check(&door, &id, "place_order", SUB)), "outcome"),
        "allowed"
    );
    // svc-trade, signed as itself, for the person it names.
    let ask = |user: &str| {
        let input = obj(&[
            ("userId", Json::str(user)),
            ("id", Json::str(id.clone())),
            ("action", Json::str("cancel_order")),
            ("account", Json::str(SUB)),
        ]);
        let body = input.compact();
        let headers = CallSigner::new("svc-trade", "svc-agents", SERVICE_SECRET, None)
            .sign(
                &body,
                "POST",
                "/trpc/own.policy.forService",
                "application/json",
            )
            .unwrap();
        mutate(&door, "own.policy.forService", &input, &headers)
    };
    assert_eq!(text(&data(&ask(USER)), "outcome"), "no_rule");
    assert_eq!(refused(&ask(OTHER)).1, "agents.own.not_found");
}

// ── Consents ────────────────────────────────────────────────────────────────

#[test]
fn consents_are_granted_withdrawn_and_granted_again_and_a_grant_waits_for_the_freeze() {
    let w = world_or_skip!();
    let door = w.door();
    let id = own_agent(&door, USER, Some("1"));
    let call = |path: &str, class: &str| {
        mutate(
            &door,
            path,
            &obj(&[
                ("id", Json::str(id.clone())),
                ("dataClass", Json::str(class)),
            ]),
            &person(USER),
        )
    };
    assert_eq!(
        refused(&call("own.consents.revoke", "own_data")),
        (
            "BAD_REQUEST".to_owned(),
            "agents.consent_not_granted".to_owned()
        )
    );
    let granted = data(&call("own.consents.grant", "own_data"));
    assert_eq!(text(&granted, "state"), "granted");
    assert_eq!(granted.get("revokedAt"), Some(&Json::Null));
    assert_eq!(data(&call("own.consents.grant", "own_data")), granted);
    let revoked = data(&call("own.consents.revoke", "own_data"));
    assert_eq!(text(&revoked, "state"), "withdrawn");
    assert_eq!(data(&call("own.consents.revoke", "own_data")), revoked);
    data(&call("own.consents.grant", "market_data"));
    let list = data(&query(
        &door,
        "own.consents.list",
        Some(&id_of(&id)),
        &person(USER),
    ));
    let classes: Vec<String> = match &list {
        Json::Array(rows) => rows.iter().map(|r| text(r, "dataClass")).collect(),
        _ => panic!(),
    };
    assert_eq!(classes, ["market_data", "own_data"]);
    w.freeze.0.store(true, Ordering::SeqCst);
    assert_eq!(
        refused(&call("own.consents.grant", "own_data")).0,
        "FORBIDDEN"
    );
    // Withdrawing only narrows: it never waits for the freeze.
    data(&call("own.consents.revoke", "market_data"));
    assert_eq!(
        refused(&query(
            &door,
            "own.consents.list",
            Some(&id_of(&id)),
            &person(OTHER)
        ))
        .1,
        "agents.own.not_found"
    );
}

// ── Memory and privacy (own/memory.test.ts) ─────────────────────────────────

/// What a run that was asked to remember writes (`OwnMemoryStore.write`).
fn remembered(w: &World, id: &str, run: &str, text: &str) -> String {
    w.db.client()
        .query_one(
            "INSERT INTO agents.own_agent_memory (agent_id, owner_id, item_key, text, source_run_id, created_at)
             VALUES ($1::text::uuid, $2::text, $3::text, $4::text, $5::text::uuid, clock_timestamp())
             RETURNING id::text",
            &[&id, &USER, &format!("agents:memory:{run}:1"), &text, &run],
        )
        .unwrap()
        .get(0)
}

fn memory_texts(m: &Json) -> Vec<String> {
    match m.get("items") {
        Some(Json::Array(items)) => items.iter().map(|i| text(i, "text")).collect(),
        _ => panic!(),
    }
}

#[test]
fn memory_lists_items_newest_first_and_clearing_one_removes_only_it() {
    let w = world_or_skip!();
    let door = w.door();
    let id = own_agent(&door, USER, Some("1"));
    let get = |who: &[(String, String)]| {
        query(
            &door,
            "own.memory.get",
            Some(&obj(&[
                ("id", Json::str(id.clone())),
                ("limit", Json::int(50)),
            ])),
            who,
        )
    };
    assert_eq!(
        data(&get(&person(USER))).compact(),
        r#"{"enabled":true,"items":[]}"#
    );
    let run1 = "aaaaaaaa-0000-4000-8000-000000000001";
    let first = remembered(&w, &id, run1, "I prefer limit orders");
    remembered(
        &w,
        &id,
        "aaaaaaaa-0000-4000-8000-000000000002",
        "I trade on Mondays",
    );
    let listed = data(&get(&person(USER)));
    assert_eq!(
        memory_texts(&listed),
        ["I trade on Mondays", "I prefer limit orders"]
    );
    match listed.get("items") {
        Some(Json::Array(items)) => {
            assert_eq!(text(&items[1], "id"), first);
            assert_eq!(text(&items[1], "sourceRunId"), run1);
        }
        _ => panic!(),
    }
    assert_eq!(refused(&get(&person(OTHER))).1, "agents.own.not_found");
    let clear = |who: &[(String, String)]| {
        mutate(
            &door,
            "own.memory.clear",
            &obj(&[
                ("id", Json::str(id.clone())),
                ("itemId", Json::str(first.clone())),
            ]),
            who,
        )
    };
    assert_eq!(refused(&clear(&person(OTHER))).1, "agents.own.not_found");
    assert_eq!(
        memory_texts(&data(&clear(&person(USER)))),
        ["I trade on Mondays"]
    );
    assert_eq!(
        refused(&clear(&person(USER))),
        ("NOT_FOUND".to_owned(), "agents.memory.not_found".to_owned())
    );
    assert_eq!(
        w.count("SELECT count(*)::bigint FROM agents.own_agent_memory"),
        1
    );
}

#[test]
fn memory_is_switched_off_and_on_only_by_the_persons_own_session() {
    let w = world_or_skip!();
    let door = w.door();
    let id = own_agent(&door, USER, Some("1"));
    let set = |on: bool, who: &[(String, String)]| {
        mutate(
            &door,
            "own.memory.setEnabled",
            &obj(&[("id", Json::str(id.clone())), ("enabled", Json::Bool(on))]),
            who,
        )
    };
    assert_ne!(set(false, &not_session(USER)).0, 200);
    assert_eq!(
        data(&set(false, &person(USER))).get("enabled"),
        Some(&Json::Bool(false))
    );
    let privacy = data(&query(
        &door,
        "own.privacy.get",
        Some(&id_of(&id)),
        &person(USER),
    ));
    assert_eq!(privacy.get("memoryEnabled"), Some(&Json::Bool(false)));
    assert_eq!(
        data(&set(true, &person(USER))).get("enabled"),
        Some(&Json::Bool(true))
    );
}

#[test]
fn with_no_retention_stored_every_period_reads_null_and_keeping_transcripts_refuses() {
    let w = world_or_skip!();
    let door = w.door();
    let id = own_agent(&door, USER, Some("1"));
    assert_eq!(
        data(&query(
            &door,
            "own.privacy.get",
            Some(&id_of(&id)),
            &person(USER)
        ))
        .compact(),
        r#"{"periods":[{"kind":"action_log","days":null},{"kind":"memory","days":null},{"kind":"transcripts","days":null},{"kind":"approvals","days":null},{"kind":"usage","days":null}],"keepTranscripts":false,"memoryEnabled":true}"#
    );
    let keep = |on: bool| {
        mutate(
            &door,
            "own.privacy.keepTranscripts",
            &obj(&[("id", Json::str(id.clone())), ("keep", Json::Bool(on))]),
            &person(USER),
        )
    };
    assert_eq!(
        refused(&keep(true)),
        (
            "PRECONDITION_FAILED".to_owned(),
            "agents.retention_unset".to_owned()
        )
    );
    assert_eq!(
        data(&query(
            &door,
            "own.privacy.get",
            Some(&id_of(&id)),
            &person(USER)
        ))
        .get("keepTranscripts"),
        Some(&Json::Bool(false))
    );
    // Tightening never needs a period.
    assert_eq!(
        data(&keep(false)).get("keepTranscripts"),
        Some(&Json::Bool(false))
    );
}

#[test]
fn with_the_transcript_period_set_keeping_transcripts_is_stored() {
    let w = world_or_skip!();
    let door = w.door_with(Retention {
        days: [None, None, Some(30), None, None],
    });
    let id = own_agent(&door, USER, Some("1"));
    let privacy = data(&mutate(
        &door,
        "own.privacy.keepTranscripts",
        &obj(&[("id", Json::str(id.clone())), ("keep", Json::Bool(true))]),
        &person(USER),
    ));
    assert_eq!(privacy.get("keepTranscripts"), Some(&Json::Bool(true)));
    assert_eq!(
        privacy.get("periods").unwrap().compact(),
        r#"[{"kind":"action_log","days":null},{"kind":"memory","days":null},{"kind":"transcripts","days":30},{"kind":"approvals","days":null},{"kind":"usage","days":null}]"#
    );
}

// ── Usage, usage by day and analytics (own/usage-day.test.ts) ───────────────

fn windows(door: &AgentsDoor, user: &str, id: &str) -> Vec<Json> {
    match data(&query(
        door,
        "own.usage",
        Some(&obj(&[("id", Json::str(id)), ("limit", Json::int(50))])),
        &person(user),
    )) {
        Json::Array(ws) => ws,
        _ => panic!(),
    }
}

fn by_day(door: &AgentsDoor, user: &str) -> Vec<Json> {
    match data(&query(door, "own.usageByDay", None, &person(user))) {
        Json::Array(rows) => rows,
        _ => panic!(),
    }
}

/// Opens a session of the agent, runs it `runs` times and, unless told not to, closes it so its window seals.
fn session(w: &World, rt: &Runtime, user: &str, id: &str, runs: usize, close: bool) {
    let s = open(w, rt, user, id);
    for n in 0..runs {
        run(w, rt, &s, &format!("{s}:run-{n}")).unwrap();
    }
    if close {
        runtime::close_settled(&w.x(rt), &s).unwrap();
    }
}

fn agent_named(w: &World, door: &AgentsDoor, user: &str, name: &str) -> String {
    let id = own_agent(door, user, Some("1"));
    data(&mutate(
        door,
        "own.save",
        &obj(&[
            ("id", Json::str(id.clone())),
            ("name", Json::str(name)),
            ("instructions", Json::str(INSTRUCTIONS)),
            ("tools", Json::Array(vec![Json::str("support.kb.search")])),
            ("perSessionCap", Json::str("1")),
        ]),
        &person(user),
    ));
    data(&set_limits(door, user, &id, "0.012", "0.5", "5"));
    let _ = w;
    id
}

#[test]
fn usage_by_day_sums_each_agents_sealed_windows_and_shows_nobody_elses() {
    let w = world_or_skip!();
    let door = w.door();
    let rt = w.runtime(Box::new(Ample), true);
    let first = agent_named(&w, &door, USER, "TEST first");
    let second = agent_named(&w, &door, USER, "TEST second");
    let theirs = agent_named(&w, &door, OTHER, "TEST theirs");
    session(&w, &rt, USER, &first, 2, true);
    session(&w, &rt, USER, &first, 1, true);
    session(&w, &rt, USER, &second, 1, true);
    session(&w, &rt, OTHER, &theirs, 1, true);
    let rows = by_day(&door, USER);
    let mut agents: Vec<String> = rows.iter().map(|r| text(r, "agentId")).collect();
    agents.sort();
    agents.dedup();
    let mut want = vec![first.clone(), second.clone()];
    want.sort();
    assert_eq!(agents, want);
    for agent in [&first, &second] {
        let ws = windows(&door, USER, agent);
        assert!(ws.iter().all(|w| text(w, "state") == "settled"));
        let mine: Vec<&Json> = rows
            .iter()
            .filter(|r| &text(r, "agentId") == agent)
            .collect();
        let sum = |xs: Vec<Amount>| xs.into_iter().sum::<Amount>();
        assert_eq!(
            sum(mine.iter().map(|r| amt(&text(r, "amount"))).collect()),
            sum(ws.iter().map(|w| amt(&text(w, "amount"))).collect())
        );
        let counted: i64 = mine
            .iter()
            .map(|r| match r.get("windows") {
                Some(Json::Number(n)) => format!("{n}").parse::<i64>().unwrap(),
                _ => panic!(),
            })
            .sum();
        assert_eq!(counted, i64::try_from(ws.len()).unwrap());
        for row in mine {
            assert_eq!(text(row, "task"), "own.run");
            assert_eq!(text(row, "assetId"), FEE);
            assert!(
                ws.iter()
                    .any(|w| text(w, "windowId").starts_with(&text(row, "day")))
            );
        }
    }
    let second_row = rows.iter().find(|r| text(r, "agentId") == second).unwrap();
    assert_eq!(text(second_row, "agentName"), "TEST second");
    assert_eq!(
        by_day(&door, OTHER)
            .iter()
            .map(|r| text(r, "agentId"))
            .collect::<Vec<_>>(),
        [theirs]
    );
}

#[test]
fn an_open_window_has_no_amount_and_is_left_out_of_usage_by_day() {
    let w = world_or_skip!();
    let door = w.door();
    let rt = w.runtime(Box::new(Ample), true);
    let id = agent_named(&w, &door, USER, "TEST open");
    session(&w, &rt, USER, &id, 1, false);
    assert!(by_day(&door, USER).is_empty());
    let ws = windows(&door, USER, &id);
    assert_eq!(text(&ws[0], "state"), "open");
    assert_eq!(ws[0].get("amount"), Some(&Json::Null));
}

#[test]
fn usage_by_day_answers_only_the_signed_in_person_never_a_key() {
    let w = world_or_skip!();
    let door = w.door();
    let key = caller(USER, &PERSON, Some("key-1"));
    assert_eq!(
        refused(&query(&door, "own.usageByDay", None, &key)).0,
        "FORBIDDEN"
    );
}

#[test]
fn analytics_counts_live_runs_by_outcome_and_test_runs_only_when_asked() {
    let w = world_or_skip!();
    let door = w.door();
    let rt = w.runtime(Box::new(Ample), true);
    let id = agent_named(&w, &door, USER, "TEST counted");
    let s = open(&w, &rt, USER, &id);
    let ran = run(&w, &rt, &s, "analytics-1").unwrap();
    data(&usage_limits(&door, &id, None, Some(TINY), false));
    assert_eq!(
        refusal_code(&run(&w, &rt, &s, "analytics-2")),
        "agents.usage.hard_limit_reached"
    );
    let ask = |include: Option<bool>| {
        let mut input = vec![("id", Json::str(id.clone()))];
        if let Some(i) = include {
            input.push(("includeTest", Json::Bool(i)));
        }
        data(&query(
            &door,
            "own.analytics",
            Some(&obj(&input)),
            &person(USER),
        ))
    };
    assert_eq!(
        ask(None).compact(),
        format!(
            r#"{{"includeTest":false,"runs":2,"liveRuns":2,"executed":1,"refused":1,"failed":0,"testRuns":null,"cost":"{}","assetId":"USDT"}}"#,
            format_amount(ran.cost)
        )
    );
    let with = ask(Some(true));
    assert_eq!(with.get("testRuns"), Some(&Json::int(0)));
    assert_eq!(
        refused(&query(
            &door,
            "own.analytics",
            Some(&id_of(&id)),
            &person(OTHER)
        ))
        .1,
        "agents.own.not_found"
    );
}
