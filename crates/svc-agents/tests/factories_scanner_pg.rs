//! The scanner's metered run (\`scanner.runSession\`) against a real Postgres (\`TEST_DATABASE_URL_AGENTS\` or
//! \`TEST_DATABASE_URL\`, a server whose admin database name ends in \`_test\`), through the \`AgentsDoor\` with a signed
//! principal, on the real runtime: each test in its own throwaway database migrated by the crate's own runner, the
//! scanner's guardrail registered as boot registers it. Without a URL it skips; with \`REQUIRE_POSTGRES=1\` it fails.
//!
//! Ported from \`services/svc-agents/src/scanner/session-run.test.ts\` and \`run-session-route.test.ts\`, whose runtime is
//! a double enforcing the real guardrail; here the runtime is the real one, so what the double counted (opens, tool
//! calls, settles, closes) is read from the session and its action log. Two cases cannot be the real runtime's: "reports
//! what the meter settled as decimal strings" hands the double two settlements, and a scanner run, which calls no engine,
//! has no window to settle (the sum is \`settle_and_close\`'s, shared with every factory); "settles and closes even when
//! the run throws" replaces the double's \`act\` with one that throws, which the real runtime has no seam for.
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
use service_kit::server::Request;
use service_kit::time::Instant;
use support::TestDb;
use svc_agents::boot::{self, BootAgent};
use svc_agents::door::{AgentsDoor, DoorConfig, ServiceAuth};
use svc_agents::factories::Factories;
use svc_agents::factories::scanner::{SpotTickers, Ticker};
use svc_agents::gateway::desk::GatewaySlice;
use svc_agents::gateway::readiness::ReadyInput;
use svc_agents::metering::Metering;
use svc_agents::metering::ports::Bus;
use svc_agents::runtime::Runtime;
use svc_agents::runtime::eligibility::parse_tier_laws;
use svc_agents::runtime::guardrails::{parse_guardrail, serialise_guardrail};

const SECRET: &str = "placeholder-agents-factories-scanner-edge-secret";
const USER: &str = "11111111-1111-4111-8111-111111111111";

/// 2026-08-07T12:00:00Z, the TypeScript's \`NOW\`.
fn now() -> Instant {
    Instant(1_786_104_000_000)
}

const ALL_TOOLS: &str = r#"["trade.ticker","trade.markets.list","trade.book.top"]"#;

fn law(max_signals: u32, tools: &str) -> String {
    format!(
        r#"{{"scanner":{{"published":true,"matrix":{{"basic":{{"maxSignals":{max_signals},"tools":{tools}}}}}}}}}"#
    )
}

const SEALED: &str = r#"{"published":true,"p0_11":"sealed","allowedInputs":["last","volume24h","change24hBps"],"rankingRecipeId":"abs_change_x_log_volume"}"#;

/// \`ticker(marketId, overrides)\`.
fn ticker(market: &str) -> Ticker {
    Ticker {
        market_id: market.to_owned(),
        last: Some("100".to_owned()),
        volume24h: Some("1000".to_owned()),
        change24h_bps: Some(50.0),
        as_of: "2026-08-07T11:59:30.000Z".to_owned(),
        max_age_ms: 120_000.0,
    }
}

fn with(mut t: Ticker, f: impl FnOnce(&mut Ticker)) -> Ticker {
    f(&mut t);
    t
}

/// \`SpotTickersPort\`: \`sample\` answers the rows, a failure, or an \`AgentError\`'s code; it counts its calls.
struct Port {
    rows: Result<Vec<Ticker>, Option<String>>,
}

impl SpotTickers for Port {
    fn sample(&self, _limit: Option<f64>) -> Result<Vec<Ticker>, Option<String>> {
        self.rows.clone()
    }
}

fn port(rows: Vec<Ticker>) -> Factories {
    ports(Ok(rows))
}

fn ports(rows: Result<Vec<Ticker>, Option<String>>) -> Factories {
    Factories {
        spot_tickers: Some(Box::new(Port { rows })),
        ..Factories::unwired()
    }
}

/// \`MemoryEventBus\`: what was published, in order.
#[derive(Default, Clone)]
struct FakeBus(Arc<Mutex<Vec<String>>>);

impl Bus for FakeBus {
    fn publish(&self, subject: &str, _msg_id: &str, _envelope: &Json) -> Result<(), String> {
        self.0.lock().unwrap().push(subject.to_owned());
        Ok(())
    }
}

struct World {
    db: TestDb,
}

impl World {
    fn new() -> Option<World> {
        let db = TestDb::new()?;
        let mut sink = Vec::new();
        svc_agents::migrate::run(&db.url, false, &mut sink).unwrap();
        boot::register_agents(&db.store(), &boot::boot_agents().unwrap()).unwrap();
        Some(World { db })
    }

    /// The scanner's guardrail with another action budget (\`fake.guardrail.limits.maxActionsPerSession = n\`).
    fn budget(&self, actions: i64) {
        let raw = svc_agents::factories::scanner::guardrail().unwrap();
        let mut g = parse_guardrail(&serialise_guardrail(&raw)).unwrap();
        g.limits.max_actions_per_session = actions;
        g.version = 2;
        boot::register_agents(
            &self.db.store(),
            &[BootAgent {
                agent_id: g.agent_id.clone(),
                version: 2,
                guardrail: serialise_guardrail(&g),
                enabled: true,
            }],
        )
        .unwrap();
    }

    fn door(&self, laws: &str, factories: Factories) -> AgentsDoor {
        let env: BTreeMap<String, String> = [
            ("APP_ENV", "test"),
            ("NODE_ENV", "test"),
            ("INTAFACED_SCREENING_FAIL_CLOSED", "off"),
            ("INTAFACED_UNSIGNED_SANCTIONS_ROWS", "off"),
        ]
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect();
        let mut rt = Runtime::unwired();
        rt.tier_laws = parse_tier_laws(Some(laws)).unwrap();
        let mut m = Metering::unwired("IFC", 60);
        m.enabled = true;
        m.bus = Box::new(FakeBus::default());
        AgentsDoor::new(DoorConfig {
            edge_secret: SECRET.to_owned(),
            services: ServiceAuth::unwired(),
            env,
            now,
            store: self.db.store(),
            gateway: GatewaySlice::unwired("IFC"),
            ready: ReadyInput::unwired(),
            metering: m,
            runtime: rt,
            advisors: svc_agents::advisors::Advisors::unwired(),
            background: svc_agents::background::Settings::default(),
            team: svc_agents::team::Team::unwired(),
            own: svc_agents::own::Own::unwired(),
        })
        .unwrap()
        .with_factories(factories)
    }

    fn rows(&self, sql: &str) -> Vec<postgres::Row> {
        self.db.client().query(sql, &[]).unwrap()
    }

    /// Sessions opened, and how many are closed.
    fn sessions(&self) -> (i64, i64) {
        let r = &self.rows(
            "SELECT count(*)::bigint, count(*) FILTER (WHERE status = 'closed')::bigint FROM agents.agent_sessions",
        )[0];
        (r.get(0), r.get(1))
    }

    /// Every action row's \`kind:status:tool\`, in order.
    fn log(&self) -> Vec<String> {
        self.rows("SELECT kind::text, status::text, coalesce(tool, '') FROM agents.agent_actions ORDER BY occurred_at, sequence")
            .iter()
            .map(|r| {
                format!(
                    "{}:{}:{}",
                    r.get::<_, String>(0),
                    r.get::<_, String>(1),
                    r.get::<_, String>(2)
                )
            })
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

fn headers(scopes: &[&str]) -> Vec<(String, String)> {
    let raw = Json::obj([
        ("sub", Json::str(USER)),
        ("userId", Json::str(USER)),
        ("sid", Json::str("22222222-2222-4222-8222-222222222222")),
        (
            "scopes",
            Json::Array(scopes.iter().map(|s| Json::str(*s)).collect()),
        ),
        ("tier", Json::str("basic")),
        ("mfa", Json::Bool(false)),
        ("expiresAt", Json::str("2099-01-01T00:00:00.000Z")),
    ])
    .compact();
    let sig = edge::sign(&raw, SECRET, "DE").unwrap();
    vec![
        ("x-intafaced-principal".to_owned(), raw),
        ("x-intafaced-principal-sig".to_owned(), sig),
        ("x-intafaced-region".to_owned(), "DE".to_owned()),
        ("content-type".to_owned(), "application/json".to_owned()),
    ]
}

fn ticker_json(t: &Ticker) -> Json {
    let opt = |v: &Option<String>| v.as_ref().map_or(Json::Null, |s| Json::str(s.clone()));
    Json::obj([
        ("marketId", Json::str(t.market_id.clone())),
        ("last", opt(&t.last)),
        ("volume24h", opt(&t.volume24h)),
        (
            "change24hBps",
            t.change24h_bps.map_or(Json::Null, Json::Number),
        ),
        ("asOf", Json::str(t.as_of.clone())),
        ("maxAgeMs", Json::Number(t.max_age_ms)),
    ])
}

/// \`scanner.runSession\` as a person who may execute: the answer's data, or its HTTP status and error message.
fn run_as(
    door: &AgentsDoor,
    scopes: &[&str],
    body: &[Ticker],
    extra: &str,
) -> Result<Json, (u16, String)> {
    let tickers = Json::Array(body.iter().map(ticker_json).collect()).compact();
    let base = json::parse(&format!(
        r#"{{"plane":"live","signalInputsLaw":{SEALED},"tickers":{tickers},"now":"2026-08-07T12:00:00.000Z"}}"#
    ))
    .unwrap();
    // The extra fields replace the base's or are added, in place.
    let over = json::parse(&format!("{{{}}}", extra.trim_start_matches(','))).unwrap();
    let (Json::Object(mut fields), Json::Object(extra)) = (base, over) else {
        panic!("objects")
    };
    for (k, v) in extra {
        match fields.iter_mut().find(|(f, _)| *f == k) {
            Some(slot) => slot.1 = v,
            None => fields.push((k, v)),
        }
    }
    let input = Json::Object(fields).compact();
    let res = door.handle(&Request {
        method: "POST",
        url: "/trpc/scanner.runSession",
        headers: &headers(scopes),
        body: &input,
    });
    let parsed = json::parse(&res.body).unwrap();
    if res.status == 200 {
        return Ok(parsed.get("result").unwrap().get("data").unwrap().clone());
    }
    let message = match parsed.get("error").and_then(|e| e.get("message")) {
        Some(Json::String(m)) => m.clone(),
        _ => String::new(),
    };
    Err((res.status, message))
}

const PERSON: [&str; 3] = ["agents:read", "agents:execute", "identity:write"];

fn run(door: &AgentsDoor, body: &[Ticker]) -> Json {
    run_as(door, &PERSON, body, "").unwrap()
}

fn field<'a>(v: &'a Json, k: &str) -> &'a Json {
    v.get(k)
        .unwrap_or_else(|| panic!("no {k} in {}", v.compact()))
}

fn text(v: &Json, k: &str) -> String {
    match field(v, k) {
        Json::String(s) => s.clone(),
        other => panic!("{k} is {}", other.compact()),
    }
}

fn num(v: &Json, k: &str) -> f64 {
    match field(v, k) {
        Json::Number(n) => *n,
        other => panic!("{k} is {}", other.compact()),
    }
}

fn markets(v: &Json) -> Vec<String> {
    let Json::Array(signals) = field(v, "signals") else {
        panic!("signals")
    };
    signals.iter().map(|s| text(s, "marketId")).collect()
}

/// The free refusal: nothing opened, nothing billed.
fn unmetered(w: &World, v: &Json) {
    let m = field(v, "metering");
    assert_eq!(field(m, "sessionId"), &Json::Null);
    assert_eq!(text(m, "billedAmount"), "0");
    assert_eq!(w.sessions(), (0, 0), "no session was opened");
}

const TICK: &str = "tool_call:executed:trade.ticker";

// ── session-run.test.ts ─────────────────────────────────────────────────────

/// "ranks through the runtime, then settles and closes the session".
#[test]
fn ranks_through_the_runtime_then_settles_and_closes_the_session() {
    let w = world_or_skip!();
    let door = w.door(
        &law(5, ALL_TOOLS),
        port(vec![
            with(ticker("btc-usdt"), |t| {
                t.volume24h = Some("100".to_owned());
                t.change24h_bps = Some(10.0);
            }),
            with(ticker("eth-usdt"), |t| {
                t.volume24h = Some("5000".to_owned());
                t.change24h_bps = Some(200.0);
            }),
        ]),
    );
    let r = run(&door, &[]);
    assert_eq!(text(&r, "status"), "ok");
    assert_eq!(markets(&r)[0], "eth-usdt");
    assert!((num(&r, "tickersAccepted") - 2.0).abs() < f64::EPSILON);
    assert!(num(&r, "tickersRefusedByTool").abs() < f64::EPSILON);
    assert!(num(&r, "tickersRefusedByGuardrail").abs() < f64::EPSILON);
    // One audited tool call per ticker, inside one session opened and closed.
    assert_eq!(
        w.log(),
        [
            "session_open:executed:",
            TICK,
            TICK,
            "session_close:executed:"
        ]
    );
    assert_eq!(w.sessions(), (1, 1));
    let m = field(&r, "metering");
    let id: String = w.rows("SELECT id::text FROM agents.agent_sessions")[0].get(0);
    assert_eq!(text(m, "sessionId"), id);
    assert_eq!(field(m, "sessionClosed"), &Json::Bool(true));
}

/// "bills zero for a run that never called the engine, and does not invent a charge".
#[test]
fn bills_zero_for_a_run_that_never_called_the_engine() {
    let w = world_or_skip!();
    let door = w.door(&law(5, ALL_TOOLS), port(vec![ticker("btc-usdt")]));
    let r = run(&door, &[]);
    let m = field(&r, "metering");
    assert_eq!(text(m, "billedAmount"), "0");
    assert_eq!(field(m, "settlements"), &Json::Array(Vec::new()));
    assert_eq!(text(m, "assetId"), "IFC");
    let windows: i64 = w.rows("SELECT count(*)::bigint FROM agents.usage_windows")[0].get(0);
    assert_eq!(windows, 0, "no usage window was opened");
}

/// "refuses a dark plane before opening a metered session" (and the route's "says it billed nothing").
#[test]
fn refuses_a_dark_plane_before_opening_a_metered_session() {
    let w = world_or_skip!();
    let door = w.door(&law(5, ALL_TOOLS), port(vec![ticker("btc-usdt")]));
    let r = run_as(&door, &PERSON, &[ticker("btc-usdt")], r#","plane":"dark""#).unwrap();
    assert_eq!(text(&r, "reason"), "market_plane_dark");
    assert_eq!(text(&r, "userMessageKey"), "agents.scanner.unavailable");
    unmetered(&w, &r);
}

/// "D26-P1-A3: refuses blank P0-11 signal-inputs law before opening a session".
#[test]
fn refuses_blank_p0_11_before_opening_a_session() {
    let w = world_or_skip!();
    let door = w.door(&law(5, ALL_TOOLS), port(vec![ticker("btc-usdt")]));
    let r = run_as(&door, &PERSON, &[], r#","signalInputsLaw":null"#).unwrap();
    assert_eq!(text(&r, "reason"), "signal_inputs_law_blank");
    assert_eq!(
        text(&r, "residual"),
        svc_agents::factories::scanner::RESIDUAL
    );
    unmetered(&w, &r);
}

/// "refuses an unpublished tier law before opening a metered session", and "when the tier does not grant the ticker
/// tool".
#[test]
fn refuses_a_closed_tier_before_opening_a_metered_session() {
    let w = world_or_skip!();
    let blank = w.door(
        r#"{"scanner":{"published":false}}"#,
        port(vec![ticker("btc-usdt")]),
    );
    let r = run(&blank, &[]);
    assert_eq!(text(&r, "reason"), "tier_law_blank");
    unmetered(&w, &r);
    let narrow = w.door(
        &law(3, r#"["trade.markets.list"]"#),
        port(vec![ticker("btc-usdt")]),
    );
    let r = run(&narrow, &[]);
    assert_eq!(text(&r, "reason"), "tier_not_granted");
    assert_eq!(text(&r, "userMessageKey"), "agents.scanner.tier_closed");
    unmetered(&w, &r);
}

/// "live HTTP tickers without published limit refuses tickers_limit_unset", "live without a tickers port", "live
/// empty port" and "live throwing port": each refuses before a session.
#[test]
fn a_live_read_that_fails_refuses_before_a_session() {
    let w = world_or_skip!();
    let invented = with(ticker("btc-usdt"), |t| {
        t.last = Some("999999".to_owned());
        t.change24h_bps = Some(9999.0);
    });
    for (factories, reason) in [
        (
            ports(Err(Some("agents.tickers_limit_unset".to_owned()))),
            "tickers_limit_unset",
        ),
        (Factories::unwired(), "no_live_tickers"),
        (port(Vec::new()), "no_live_tickers"),
        (ports(Err(None)), "no_live_tickers"),
    ] {
        let door = w.door(&law(5, ALL_TOOLS), factories);
        let r = run(&door, std::slice::from_ref(&invented));
        assert_eq!(text(&r, "reason"), reason);
        unmetered(&w, &r);
        // Body tickers are not live truth: with no port they are not ranked either.
        let r = run(&door, &[]);
        assert_eq!(text(&r, "reason"), reason);
    }
}

/// "live rank uses port samples and ignores invented request-body tickers".
#[test]
fn live_rank_uses_port_samples_and_ignores_invented_body_tickers() {
    let w = world_or_skip!();
    let door = w.door(
        &law(5, ALL_TOOLS),
        port(vec![with(ticker("eth-usdt"), |t| {
            t.volume24h = Some("5000".to_owned());
            t.change24h_bps = Some(200.0);
        })]),
    );
    let r = run(&door, &[ticker("invented-usdt")]);
    assert_eq!(markets(&r), ["eth-usdt"]);
}

/// "drops a ticker the data tool refuses instead of filling it in".
#[test]
fn drops_a_ticker_the_data_tool_refuses_instead_of_filling_it_in() {
    let w = world_or_skip!();
    let door = w.door(
        &law(5, ALL_TOOLS),
        port(vec![
            ticker("btc-usdt"),
            with(ticker("ghost-usdt"), |t| t.last = None),
            with(ticker("stale-usdt"), |t| {
                t.as_of = "2026-08-07T00:00:00.000Z".to_owned();
            }),
        ]),
    );
    let r = run(&door, &[]);
    assert_eq!(text(&r, "status"), "ok");
    assert!((num(&r, "tickersAccepted") - 1.0).abs() < f64::EPSILON);
    // The stale row is the only one the tool saw and refused; the null last never reached it.
    assert!((num(&r, "tickersRefusedByTool") - 1.0).abs() < f64::EPSILON);
    assert_eq!(markets(&r), ["btc-usdt"]);
    assert_eq!(w.log().iter().filter(|l| *l == TICK).count(), 2);
}

/// "refuses the whole run when every ticker was refused — no invented list".
#[test]
fn refuses_the_whole_run_when_every_ticker_was_refused() {
    let w = world_or_skip!();
    let door = w.door(
        &law(5, ALL_TOOLS),
        port(vec![
            with(ticker("a-usdt"), |t| t.last = None),
            with(ticker("b-usdt"), |t| t.volume24h = None),
        ]),
    );
    let r = run(&door, &[]);
    assert_eq!(text(&r, "status"), "refuse");
    assert_eq!(text(&r, "reason"), "no_live_tickers");
    assert!((num(&r, "tickersRefusedByTool") - 1.0).abs() < f64::EPSILON);
    // The session it opened is still settled and closed.
    assert_eq!(w.sessions(), (1, 1));
}

/// "counts a guardrail refusal instead of ranking around it".
#[test]
fn counts_a_guardrail_refusal_instead_of_ranking_around_it() {
    let w = world_or_skip!();
    w.budget(1);
    let door = w.door(
        &law(5, ALL_TOOLS),
        port(vec![
            ticker("btc-usdt"),
            ticker("eth-usdt"),
            ticker("sol-usdt"),
        ]),
    );
    let r = run(&door, &[]);
    assert_eq!(text(&r, "status"), "ok");
    assert!((num(&r, "tickersAccepted") - 1.0).abs() < f64::EPSILON);
    assert!((num(&r, "tickersRefusedByGuardrail") - 2.0).abs() < f64::EPSILON);
    let log = w.log();
    assert_eq!(
        log.iter()
            .filter(|l| *l == "tool_call:refused:trade.ticker")
            .count(),
        2
    );
    assert_eq!(w.sessions(), (1, 1));
}

/// "honours the tier depth cap rather than the caller".
#[test]
fn honours_the_tier_depth_cap_rather_than_the_caller() {
    let w = world_or_skip!();
    let door = w.door(
        &law(1, ALL_TOOLS),
        port(vec![
            with(ticker("btc-usdt"), |t| {
                t.volume24h = Some("100".to_owned());
                t.change24h_bps = Some(10.0);
            }),
            with(ticker("eth-usdt"), |t| {
                t.volume24h = Some("5000".to_owned());
                t.change24h_bps = Some(200.0);
            }),
        ]),
    );
    let r = run(&door, &[]);
    assert!((num(&r, "maxSignals") - 1.0).abs() < f64::EPSILON);
    assert_eq!(markets(&r).len(), 1);
}

/// "only ever asks for the declared read tool — never a money-write one".
#[test]
fn only_ever_asks_for_the_declared_read_tool() {
    let w = world_or_skip!();
    let door = w.door(
        &law(5, ALL_TOOLS),
        port(vec![ticker("btc-usdt"), ticker("eth-usdt")]),
    );
    run(&door, &[]);
    let tools: Vec<String> = w
        .rows("SELECT DISTINCT tool FROM agents.agent_actions WHERE tool IS NOT NULL")
        .iter()
        .map(|r| r.get(0))
        .collect();
    assert_eq!(tools, ["trade.ticker"]);
}

// ── run-session-route.test.ts ───────────────────────────────────────────────

/// "requires agents:execute — a read-only principal cannot run a metered scan", and "AG-sessions-01: a body naming
/// its own tier or law is rejected before the gate".
#[test]
fn a_read_only_principal_or_a_body_naming_its_tier_is_refused() {
    let w = world_or_skip!();
    let door = w.door(&law(5, ALL_TOOLS), port(vec![ticker("btc-usdt")]));
    let (status, message) = run_as(&door, &["agents:read"], &[], "").unwrap_err();
    assert_eq!(status, 403);
    assert_eq!(message, "Scope \"agents:execute\" is required");
    let (status, _) = run_as(&door, &PERSON, &[], r#","userTier":"basic""#).unwrap_err();
    assert_eq!(status, 400);
    let (status, _) = run_as(
        &door,
        &PERSON,
        &[],
        r#","tierLaw":{"published":true,"matrix":{}}"#,
    )
    .unwrap_err();
    assert_eq!(status, 400);
    assert_eq!(w.sessions(), (0, 0));
}
