//! A Navigator session's `run.complete` as research, against a real Postgres (`TEST_DATABASE_URL_AGENTS` or
//! `TEST_DATABASE_URL`, a server whose admin database name ends in `_test`), each test in its own throwaway database
//! migrated by the crate's own runner. Without a URL it skips; with `REQUIRE_POSTGRES=1` it fails.
//!
//! Ported case for case from `services/svc-agents/src/research/provenance.test.ts`, "run.complete on a Navigator
//! session", through the `AgentsDoor` with a signed principal. The TypeScript stubs the runtime and keeps runs in memory;
//! here the session is opened for real, the engine is the deterministic mock (wrapped to record the system text it is
//! handed), the runs are the stored ones, and the market reads are a fake trade plane.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

mod support;

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use service_kit::edge;
use service_kit::json::{self, Json};
use service_kit::server::Request;
use service_kit::time::Instant;
use support::TestDb;
use svc_agents::door::{AgentsDoor, DoorConfig, ServiceAuth, system_now};
use svc_agents::gateway::Gateway;
use svc_agents::gateway::desk::GatewaySlice;
use svc_agents::gateway::providers::{
    CompletionRequest, CompletionResult, EmbedRequest, EmbedResult, Failure, Health, MockOptions,
    MockProvider, Provider,
};
use svc_agents::gateway::readiness::ReadyInput;
use svc_agents::gateway::routing::{Capability, Engine, parse_routing_table};
use svc_agents::metering::Metering;
use svc_agents::metering::ports::Bus;
use svc_agents::navigator::ports::{PortError, TradeData};
use svc_agents::navigator::research::Research;
use svc_agents::navigator::tools::{Market, Quote};
use svc_agents::runtime::Runtime;
use svc_agents::runtime::guardrails::{parse_guardrail, serialise_guardrail};

const SECRET: &str = "an-agents-research-provenance-secret";
const USER: &str = "11111111-1111-4111-8111-111111111111";
const OBSERVED: &str = "2026-11-14T08:00:00.000Z";
const TABLE: &str = r#"{"routes":[{"task":"navigator.plan","providerId":"primary","model":"test-engine","maxOutputTokens":64,"price":{"inputPerMillion":"3","outputPerMillion":"15"}}]}"#;

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

/// The trade plane: each market's last price, and every read made.
#[derive(Clone, Default)]
struct Port {
    last: BTreeMap<String, String>,
    reads: Arc<Mutex<Vec<String>>>,
}

fn port(last: &[(&str, &str)]) -> Port {
    Port {
        last: last
            .iter()
            .map(|(m, p)| ((*m).to_owned(), (*p).to_owned()))
            .collect(),
        reads: Arc::default(),
    }
}

impl TradeData for Port {
    fn list_markets(&self, _limit: Option<f64>) -> Result<Vec<Market>, PortError> {
        Ok(vec![])
    }
    fn quote(&self, market_id: &str) -> Result<Option<Quote>, PortError> {
        self.reads.lock().unwrap().push(market_id.to_owned());
        let last = self
            .last
            .get(market_id)
            .ok_or_else(|| PortError::Failed("trade unreachable".to_owned()))?;
        Ok(Some(Quote {
            market_id: market_id.to_owned(),
            last: Some(last.clone()),
            as_of: OBSERVED.to_owned(),
            max_age_ms: 60_000.0,
        }))
    }
}

/// The mock engine, recording the system text of each call.
struct Recording {
    inner: MockProvider,
    systems: Arc<Mutex<Vec<Option<String>>>>,
}

impl Provider for Recording {
    fn id(&self) -> &str {
        self.inner.id()
    }
    fn capabilities(&self) -> &[Capability] {
        self.inner.capabilities()
    }
    fn engine(&self) -> Engine {
        self.inner.engine()
    }
    fn health(&self, now: Instant) -> Health {
        self.inner.health(now)
    }
    fn complete(&self, request: &CompletionRequest) -> Result<CompletionResult, Failure> {
        self.systems.lock().unwrap().push(request.system.clone());
        self.inner.complete(request)
    }
    fn embed(&self, request: &EmbedRequest) -> Option<Result<EmbedResult, Failure>> {
        self.inner.embed(request)
    }
}

struct Sink;

impl Bus for Sink {
    fn publish(&self, _subject: &str, _msg_id: &str, _envelope: &Json) -> Result<(), String> {
        Ok(())
    }
}

fn guardrail(agent_id: &str) -> Json {
    json::parse(&format!(
        r#"{{"agentId":"{agent_id}","version":1,"capacityMode":"confirm_each","tools":[],
            "limits":{{"maxActionsPerSession":20,"maxOutputTokensPerCall":256,"maxSpendPerSession":null,
            "allowedModules":["trade"],"allowedTasks":["navigator.plan"]}}}}"#
    ))
    .unwrap()
}

struct World {
    db: TestDb,
    door: AgentsDoor,
    systems: Arc<Mutex<Vec<Option<String>>>>,
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
    fn message(&self) -> String {
        assert_ne!(self.0, 200, "{}", self.1.compact());
        match self.1.get("error").and_then(|e| e.get("message")) {
            Some(Json::String(m)) => m.clone(),
            other => panic!("no message: {other:?}"),
        }
    }
}

fn who() -> Vec<(String, String)> {
    let raw = Json::Object(
        [
            ("sub", Json::str(USER)),
            ("userId", Json::str(USER)),
            ("sid", Json::str("22222222-2222-4222-8222-222222222222")),
            (
                "scopes",
                Json::Array(vec![Json::str("agents:read"), Json::str("agents:execute")]),
            ),
            ("tier", Json::str("basic")),
            ("mfa", Json::Bool(false)),
            ("expiresAt", Json::str("2099-01-01T00:00:00.000Z")),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_owned(), v))
        .collect(),
    )
    .compact();
    let sig = edge::sign(&raw, SECRET, "DE").unwrap();
    vec![
        ("x-intafaced-principal".to_owned(), raw),
        ("x-intafaced-principal-sig".to_owned(), sig),
        ("x-intafaced-region".to_owned(), "DE".to_owned()),
    ]
}

impl World {
    fn new(db: TestDb, trade: Option<Port>, scale: Option<&[&str]>) -> World {
        let systems = Arc::default();
        let engine: Arc<dyn Provider> = Arc::new(Recording {
            inner: MockProvider::new(
                MockOptions {
                    id: Some("primary".to_owned()),
                    ..MockOptions::default()
                },
                system_now,
            ),
            systems: Arc::clone(&systems),
        });
        let gateway = Arc::new(Gateway::new(
            vec![engine],
            parse_routing_table(TABLE).unwrap(),
        ));
        let mut runtime = Runtime::unwired();
        runtime.spend = false;
        runtime.navigator.trade_data = trade.map(|p| Box::new(p) as Box<dyn TradeData>);
        runtime.navigator.research = Research {
            scale: scale.map(|s| s.iter().map(|l| (*l).to_owned()).collect()),
            environment: "TEST".to_owned(),
        };
        let mut metering = Metering::unwired("USDT", 60);
        metering.bus = Box::new(Sink);
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
                gateway,
                fee_asset_id: "USDT".to_owned(),
                metering_enabled: Some(false),
                window_minutes: 60,
            },
            ready: ReadyInput::unwired(),
            metering,
            runtime,
            advisors: svc_agents::advisors::Advisors::unwired(),
            own: svc_agents::own::Own::unwired(),
            team: svc_agents::team::Team::unwired(),
            background: svc_agents::background::Settings::default(),
            team: svc_agents::team::Team::unwired(),
        })
        .unwrap();
        for agent in ["navigator", "probe"] {
            let g = parse_guardrail(&guardrail(agent)).unwrap();
            db.client()
                .execute(
                    "INSERT INTO agents.agent_definitions (agent_id, version, guardrail, enabled) VALUES ($1, 1, $2::text::jsonb, true)",
                    &[&agent, &serialise_guardrail(&g).compact()],
                )
                .unwrap();
        }
        World { db, door, systems }
    }

    fn call(&self, path: &str, input: &Json, post: bool) -> Answer {
        let mut headers = who();
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

    fn open(&self, agent: &str) -> String {
        match self
            .call(
                "session.open",
                &Json::obj([("agentId", Json::str(agent))]),
                true,
            )
            .data()
            .get("id")
        {
            Some(Json::String(id)) => id.clone(),
            other => panic!("no session id: {other:?}"),
        }
    }

    /// `ASK(content)`.
    fn ask(&self, session: &str, content: &str) -> Answer {
        self.call(
            "run.complete",
            &Json::obj([
                ("sessionId", Json::str(session)),
                ("requestId", Json::str("research-request-0001")),
                ("task", Json::str("navigator.plan")),
                (
                    "messages",
                    Json::Array(vec![Json::obj([
                        ("role", Json::str("user")),
                        ("content", Json::str(content)),
                    ])]),
                ),
            ]),
            true,
        )
    }

    fn runs(&self) -> i64 {
        self.db
            .client()
            .query_one("SELECT count(*) FROM agents.agent_runs", &[])
            .unwrap()
            .get(0)
    }

    fn stored_provenance(&self) -> Option<String> {
        self.db
            .client()
            .query_one("SELECT provenance::text FROM agents.agent_runs", &[])
            .unwrap()
            .get(0)
    }
}

const SCALE: &[&str] = &["TEST low", "TEST medium", "TEST high"];

fn s(v: &str) -> Json {
    Json::str(v)
}

#[test]
fn an_answer_about_a_market_returns_its_provenance_hands_the_engine_the_sources_and_stores_both_with_the_reply()
 {
    let trade = port(&[("btc-usdt", "64000")]);
    let w = World::new(db_or_skip!(), Some(trade.clone()), Some(SCALE));
    let session = w.open("navigator");
    let result = w.ask(&session, "TEST: what moved BTC/USDT today?").data();

    let systems = w.systems.lock().unwrap().clone();
    assert_eq!(systems.len(), 1);
    assert!(
        systems[0]
            .as_deref()
            .unwrap()
            .contains("[S1] BTC/USDT last traded price 64000")
    );
    assert_eq!(*trade.reads.lock().unwrap(), ["btc-usdt"]);

    let reply = result.get("text").cloned().unwrap();
    let p = result.get("provenance").unwrap();
    let source = &match p.get("sources") {
        Some(Json::Array(a)) => a.clone(),
        other => panic!("{other:?}"),
    }[0];
    for (k, v) in [
        ("id", "S1"),
        ("market", "BTC/USDT"),
        ("measure", "last_price"),
        ("value", "64000"),
        ("observedAt", OBSERVED),
    ] {
        assert_eq!(source.get(k), Some(&s(v)), "{k}");
    }
    assert_eq!(p.get("observedAt"), Some(&s(OBSERVED)));
    assert_eq!(p.get("environment"), Some(&s("TEST")));
    // The mock engine cites nothing: its one sentence is unsupported, the highest level.
    assert_eq!(
        p.get("unsupported"),
        Some(&Json::Array(vec![reply.clone()]))
    );
    let u = p.get("uncertainty").unwrap();
    assert_eq!(u.get("level"), Some(&s("TEST high")));
    assert_eq!(u.get("unsupportedCount"), Some(&Json::Number(1.0)));
    assert_eq!(u.get("claimCount"), Some(&Json::Number(1.0)));
    assert_eq!(p.get("notAdvice"), Some(&Json::Bool(true)));

    // Stored in the same write as the reply: a later read of the run returns the same provenance.
    let run_id = result.get("runId").cloned().unwrap();
    let read = w
        .call("run.get", &Json::obj([("runId", run_id)]), false)
        .data();
    assert_eq!(read.get("state"), Some(&s("completed")));
    assert_eq!(read.get("reply"), Some(&reply));
    assert_eq!(canon(read.get("provenance").unwrap()), canon(p));
    assert_eq!(
        canon(&json::parse(&w.stored_provenance().unwrap()).unwrap()),
        canon(p)
    );
}

/// Keys sorted at every level: Postgres's `jsonb` keeps its own order.
fn canon(v: &Json) -> Json {
    match v {
        Json::Object(fields) => {
            let mut sorted: Vec<(String, Json)> =
                fields.iter().map(|(k, v)| (k.clone(), canon(v))).collect();
            sorted.sort_by(|a, b| a.0.cmp(&b.0));
            Json::Object(sorted.into_iter().collect())
        }
        Json::Array(a) => Json::Array(a.iter().map(canon).collect()),
        other => other.clone(),
    }
}

#[test]
fn an_ask_that_names_no_market_runs_as_before_with_no_provenance_and_no_market_read() {
    let trade = port(&[("btc-usdt", "64000")]);
    let w = World::new(db_or_skip!(), Some(trade.clone()), Some(SCALE));
    let session = w.open("navigator");
    let result = w.ask(&session, "Where do I place a limit order?").data();
    assert_eq!(result.get("provenance"), Some(&Json::Null));
    assert!(trade.reads.lock().unwrap().is_empty());
    assert_eq!(*w.systems.lock().unwrap(), [None]);
    assert_eq!(w.stored_provenance(), None);
}

#[test]
fn another_agent_naming_a_market_is_not_a_navigator_research_answer() {
    let trade = port(&[("btc-usdt", "64000")]);
    let w = World::new(db_or_skip!(), Some(trade.clone()), Some(SCALE));
    let session = w.open("probe");
    let result = w.ask(&session, "BTC/USDT?").data();
    assert_eq!(result.get("provenance"), Some(&Json::Null));
    assert!(trade.reads.lock().unwrap().is_empty());
}

#[test]
fn a_market_it_cannot_read_refuses_provenance_missing_with_no_run_row_and_no_engine_call() {
    let w = World::new(db_or_skip!(), Some(port(&[])), Some(SCALE));
    let session = w.open("navigator");
    assert_eq!(
        w.ask(&session, "TEST: what moved BTC/USDT today?")
            .message(),
        "agents.refused.provenance_missing"
    );
    assert!(w.systems.lock().unwrap().is_empty());
    assert_eq!(w.runs(), 0);
}

#[test]
fn a_blank_uncertainty_scale_refuses_uncertainty_scale_unset_with_no_run_row_and_no_engine_call() {
    let trade = port(&[("btc-usdt", "1")]);
    let w = World::new(db_or_skip!(), Some(trade.clone()), None);
    let session = w.open("navigator");
    assert_eq!(
        w.ask(&session, "BTC/USDT").message(),
        "agents.refused.uncertainty_scale_unset"
    );
    assert!(trade.reads.lock().unwrap().is_empty());
    assert!(w.systems.lock().unwrap().is_empty());
    assert_eq!(w.runs(), 0);
}
