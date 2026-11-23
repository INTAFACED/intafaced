//! \`merchant.runSession\`'s metered run against a real Postgres (\`TEST_DATABASE_URL_AGENTS\` or \`TEST_DATABASE_URL\`, a
//! server whose admin database name ends in \`_test\`), each test in its own throwaway database migrated by the crate's
//! own runner, with the boot's guardrail rows. Without a URL it skips; with \`REQUIRE_POSTGRES=1\` it fails.
//!
//! Ported case for case from \`services/svc-agents/src/merchant/session-run.test.ts\` and \`run-session-route.test.ts\`,
//! every case through the \`AgentsDoor\` with a signed principal, on the real runtime: \`openSession\`, \`act\` judged by
//! the merchant guardrail bound at open and written to the action log, \`settleSession\` through the meter and
//! \`closeSession\`. The TypeScript's \`FakeRuntime\` counters are read from the tables (\`agent_sessions\`,
//! \`agent_actions\`). Where an answer's exact bytes are pinned, they are the TypeScript router's own over a runtime that
//! executes each tool and settles nothing (\`ts:\` lines), the session id aside.
//!
//! Not mapped: "reports what the meter settled as decimal strings, summed in bigint" doubles \`settleSession\`'s return;
//! a merchant run never calls the engine, so the real meter has no usage to settle and the sum is only ever 0 (held by
//! "bills zero"). The guardrail's \`maxActionsPerSession = 0\` (the TypeScript mutates a parsed guardrail) is not a
//! guardrail \`parseGuardrail\` accepts, so "every point refused" binds a merchant guardrail without \`pay.metrics.read\`:
//! each call is refused (\`tool_not_declared\`) instead of over budget, with the same answer.
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
use service_kit::http::{Fetch, FetchError, HttpRequest, HttpResponse};
use service_kit::json::{self, Json};
use service_kit::s2s::{CallSigner, SERVICE_TIMESTAMP_HEADER, legacy_headers};
use service_kit::server::Request;
use support::TestDb;
use svc_agents::boot::{boot_agents, register_agents};
use svc_agents::door::{AgentsDoor, DoorConfig, ServiceAuth, system_now};
use svc_agents::factories::Factories;
use svc_agents::factories::merchant::{METRICS_PATH, PayMetrics, PayMetricsHttp};
use svc_agents::gateway::desk::GatewaySlice;
use svc_agents::gateway::readiness::ReadyInput;
use svc_agents::metering::Metering;
use svc_agents::metering::ports::Bus;
use svc_agents::runtime::Runtime;
use svc_agents::runtime::guardrails::{parse_guardrail, serialise_guardrail};

const USER: &str = "11111111-1111-4111-8111-111111111111";
const SECRET: &str = "placeholder-agents-merchant-pg-edge-secret";
const PAY_SECRET: &str = "placeholder-agents-merchant-pg-internal-secret";
const NOW: &str = "2026-11-19T00:00:00.000Z";

// ── The world ───────────────────────────────────────────────────────────────

/// \`portOf(points)\`, an empty port, or one whose \`sample\` throws.
enum Port {
    Points(Vec<Json>),
    Throws,
}

impl PayMetrics for Port {
    fn sample(&self) -> Result<Vec<Json>, String> {
        match self {
            Port::Points(p) => Ok(p.clone()),
            Port::Throws => Err("pay metrics unavailable".to_owned()),
        }
    }
}

/// The bus as an in-memory list: each event's subject.
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
    bus: FakeBus,
}

impl World {
    fn new() -> Option<World> {
        let db = TestDb::new()?;
        let mut sink = Vec::new();
        svc_agents::migrate::run(&db.url, false, &mut sink).unwrap();
        let store = db.store();
        register_agents(&store, &boot_agents().unwrap()).unwrap();
        Some(World {
            db,
            bus: FakeBus::default(),
        })
    }

    /// The merchant's row with \`limits\` and \`tools\` changed (\`fake.guardrail = ...\`).
    fn rebind(&self, max_actions: i64, tools: &str) {
        let raw = format!(
            r#"{{"agentId":"merchant","version":1,"capacityMode":"research_only","tools":{tools},
                "limits":{{"maxActionsPerSession":{max_actions},"maxOutputTokensPerCall":1024,"maxSpendPerSession":"0.25",
                           "allowedModules":["pay","agents"],"allowedTasks":["merchant.watch"]}}}}"#
        );
        let g = parse_guardrail(&json::parse(&raw).unwrap()).unwrap();
        let stored = serialise_guardrail(&g).compact();
        self.db
            .client()
            .execute(
                "UPDATE agents.agent_definitions SET guardrail = $1::text::jsonb WHERE agent_id = 'merchant'",
                &[&stored],
            )
            .unwrap();
    }

    /// The router as \`createAgentsRouter\` is built here: the real runtime and meter, fee asset IFC, and the port.
    fn door(&self, port: Option<Box<dyn PayMetrics>>) -> AgentsDoor {
        let env: BTreeMap<String, String> = [
            ("APP_ENV", "test"),
            ("NODE_ENV", "test"),
            ("INTAFACED_SCREENING_FAIL_CLOSED", "off"),
            ("INTAFACED_UNSIGNED_SANCTIONS_ROWS", "off"),
        ]
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect();
        let mut metering = Metering::unwired("IFC", 60);
        metering.enabled = true;
        metering.bus = Box::new(self.bus.clone());
        AgentsDoor::new(DoorConfig {
            edge_secret: SECRET.to_owned(),
            services: ServiceAuth::unwired(),
            env,
            now: system_now,
            store: self.db.store(),
            gateway: GatewaySlice::unwired("IFC"),
            ready: ReadyInput::unwired(),
            metering,
            runtime: Runtime::unwired(),
            advisors: svc_agents::advisors::Advisors::unwired(),
            background: svc_agents::background::Settings::default(),
            team: svc_agents::team::Team::unwired(),
            own: svc_agents::own::Own::unwired(),
            ops: svc_agents::ops::Ops::unwired(),
        })
        .unwrap()
        .with_factories(Factories {
            pay_metrics: port,
            ..Factories::unwired()
        })
    }

    fn count(&self, sql: &str) -> i64 {
        self.db.client().query_one(sql, &[]).unwrap().get(0)
    }

    /// \`openCalls\`: sessions opened.
    fn opened(&self) -> i64 {
        self.count("SELECT count(*) FROM agents.agent_sessions WHERE agent_id = 'merchant'")
    }

    /// \`closeCalls\` that closed: every merchant session is closed.
    fn all_closed(&self) -> bool {
        self.count(
            "SELECT count(*) FROM agents.agent_sessions WHERE agent_id = 'merchant' AND status <> 'closed'",
        ) == 0
    }

    /// The tool calls of the action log by status (\`fake.toolCalls\`, \`fake.refusedCalls\`).
    fn tool_calls(&self, status: &str) -> Vec<String> {
        self.db
            .client()
            .query(
                "SELECT tool FROM agents.agent_actions WHERE kind = 'tool_call' AND status::text = $1 ORDER BY sequence",
                &[&status],
            )
            .unwrap()
            .iter()
            .map(|r| r.get::<_, Option<String>>(0).unwrap_or_default())
            .collect()
    }

    fn session_id(&self) -> String {
        self.db
            .client()
            .query_one(
                "SELECT id::text FROM agents.agent_sessions WHERE agent_id = 'merchant'",
                &[],
            )
            .unwrap()
            .get(0)
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
        ("content-type".to_owned(), "application/json".to_owned()),
    ]
}

/// \`createCaller(signed(principal({ scopes }))).merchant.runSession(input)\`: the status and the body.
fn run_as(door: &AgentsDoor, input: &Json, scopes: &[&str]) -> (u16, Json) {
    let body = input.compact();
    let h = headers(scopes);
    let res = door.handle(&Request {
        method: "POST",
        url: "/trpc/merchant.runSession",
        headers: &h,
        body: &body,
    });
    (res.status, json::parse(&res.body).unwrap())
}

/// The run's data as a person with \`agents:read\` and \`agents:execute\`.
fn run(door: &AgentsDoor, input: &Json) -> Json {
    let (status, body) = run_as(door, input, &["agents:read", "agents:execute"]);
    assert_eq!(status, 200, "{}", body.compact());
    body.get("result")
        .and_then(|r| r.get("data"))
        .cloned()
        .unwrap()
}

/// A refused run's \`(code, message)\`.
fn refused(door: &AgentsDoor, input: &Json) -> (String, String) {
    let (status, body) = run_as(door, input, &["agents:read", "agents:execute"]);
    assert_ne!(status, 200, "not refused: {}", body.compact());
    let e = body.get("error").unwrap();
    let s = |v: Option<&Json>| match v {
        Some(Json::String(s)) => s.clone(),
        other => panic!("not a string: {other:?}"),
    };
    (
        s(e.get("data").and_then(|d| d.get("code"))),
        s(e.get("message")),
    )
}

/// \`point(railId, overrides)\` at the suite's clock.
fn point(rail: &str, rate: Option<&str>, attempts: Option<i64>) -> Json {
    Json::obj([
        ("railId", Json::str(rail)),
        ("approvalRate", rate.map_or(Json::Null, Json::str)),
        ("attempts", attempts.map_or(Json::Null, Json::int)),
        ("asOf", Json::str("2026-11-18T23:59:30.000Z")),
        ("maxAgeMs", Json::int(120_000)),
    ])
}

fn p(rail: &str) -> Json {
    point(rail, Some("0.70"), Some(100))
}

fn input(plane: &str, points: &[Json], extra: &[(&str, Json)]) -> Json {
    let mut f = vec![
        ("plane".to_owned(), Json::str(plane)),
        ("points".to_owned(), Json::Array(points.to_vec())),
        ("now".to_owned(), Json::str(NOW)),
    ];
    for (k, v) in extra {
        f.push(((*k).to_owned(), v.clone()));
    }
    Json::Object(f)
}

fn port_of(points: &[Json]) -> Option<Box<dyn PayMetrics>> {
    Some(Box::new(Port::Points(points.to_vec())))
}

fn get<'a>(v: &'a Json, k: &str) -> &'a Json {
    v.get(k)
        .unwrap_or_else(|| panic!("no {k} in {}", v.compact()))
}

/// The answer with its session id written as the TypeScript probe's \`S\`.
fn as_probe(mut answer: Json) -> String {
    if let Json::Object(fields) = &mut answer
        && let Some((_, Json::Object(m))) = fields.iter_mut().find(|(k, _)| k == "metering")
        && let Some((_, id)) = m.iter_mut().find(|(k, _)| k == "sessionId")
    {
        *id = Json::str("S");
    }
    answer.compact()
}

fn unmetered() -> Json {
    json::parse(r#"{"sessionId":null,"billedAmount":"0","assetId":"IFC","sessionClosed":false,"settlements":[]}"#)
        .unwrap()
}

// ── session-run.test.ts ─────────────────────────────────────────────────────

#[test]
fn watches_through_the_runtime_then_settles_and_closes_the_session() {
    let w = world_or_skip!();
    let points = [
        point("card-visa", Some("0.70"), Some(100)),
        point("card-mc", Some("0.90"), Some(100)),
    ];
    let door = w.door(port_of(&points));
    let r = run(
        &door,
        &input("live", &points, &[("threshold", Json::str("0.85"))]),
    );
    // ts: board
    assert_eq!(
        as_probe(r.clone()),
        r#"{"status":"ok","watchedAt":"2026-11-19T00:00:00.000Z","considered":2,"skippedStale":0,"skippedIncomplete":0,"skippedLowSample":0,"alerts":[{"railId":"card-visa","approvalRate":"0.70","attempts":100,"threshold":"0.85","kind":"below_threshold"}],"pointsAccepted":2,"pointsRefusedByGuardrail":0,"metering":{"sessionId":"S","billedAmount":"0","assetId":"IFC","sessionClosed":true,"settlements":[]}}"#
    );
    assert_eq!(
        w.tool_calls("executed"),
        ["pay.metrics.read", "pay.metrics.read"]
    );
    assert_eq!(w.opened(), 1);
    assert!(w.all_closed());
    // `runtime.act` publishes each executed tool call.
    assert_eq!(
        *w.bus.0.lock().unwrap(),
        [
            "intafaced.agents.action.completed",
            "intafaced.agents.action.completed"
        ]
    );
    assert_eq!(
        get(get(&r, "metering"), "sessionId"),
        &Json::str(w.session_id())
    );
}

#[test]
fn bills_zero_for_a_run_that_never_called_the_engine() {
    let w = world_or_skip!();
    let door = w.door(port_of(&[p("card-visa")]));
    let r = run(&door, &input("live", &[p("card-visa")], &[]));
    let m = get(&r, "metering");
    assert_eq!(get(m, "billedAmount"), &Json::str("0"));
    assert_eq!(get(m, "settlements"), &Json::Array(Vec::new()));
    assert_eq!(get(m, "sessionClosed"), &Json::Bool(true));
    assert_eq!(
        w.count("SELECT count(*) FROM agents.usage_records"),
        0,
        "no usage metered"
    );
}

#[test]
fn refuses_a_dark_pay_plane_before_opening_a_metered_session() {
    let w = world_or_skip!();
    let door = w.door(port_of(&[p("card-visa")]));
    let r = run(&door, &input("dark", &[p("card-visa")], &[]));
    assert_eq!(get(&r, "status"), &Json::str("refuse"));
    assert_eq!(get(&r, "reason"), &Json::str("pay_plane_dark"));
    assert_eq!(
        get(&r, "userMessageKey"),
        &Json::str("agents.merchant.unavailable")
    );
    assert_eq!(get(&r, "metering"), &unmetered());
    assert_eq!(w.opened(), 0);
}

#[test]
fn mixed_missing_metrics_refuse_after_the_session_without_partial_alerts() {
    let w = world_or_skip!();
    let points = [
        point("card-visa", Some("0.70"), Some(100)),
        point("card-mc", None, None),
    ];
    let door = w.door(port_of(&points));
    let r = run(&door, &input("live", &points, &[]));
    assert_eq!(
        as_probe(r),
        r#"{"status":"unavailable","userMessageKey":"agents.merchant.unavailable","reason":"no_metrics","metering":{"sessionId":"S","billedAmount":"0","assetId":"IFC","sessionClosed":true,"settlements":[]}}"#
    );
    assert_eq!(w.opened(), 1);
    assert!(w.all_closed());
}

#[test]
fn live_without_a_metrics_port_refuses_no_live_metrics() {
    let w = world_or_skip!();
    let door = w.door(None);
    let r = run(
        &door,
        &input(
            "live",
            &[point("card-visa", Some("0.99"), Some(10_000))],
            &[],
        ),
    );
    assert_eq!(get(&r, "reason"), &Json::str("no_live_metrics"));
    assert_eq!(get(&r, "metering"), &unmetered());
    assert_eq!(w.opened(), 0);
}

#[test]
fn live_empty_port_refuses_no_live_metrics() {
    let w = world_or_skip!();
    let door = w.door(port_of(&[]));
    let r = run(&door, &input("live", &[p("card-visa")], &[]));
    assert_eq!(get(&r, "status"), &Json::str("refuse"));
    assert_eq!(get(&r, "reason"), &Json::str("no_live_metrics"));
    assert_eq!(w.opened(), 0);
}

#[test]
fn live_throwing_port_refuses_no_live_metrics_before_a_session() {
    let w = world_or_skip!();
    let door = w.door(Some(Box::new(Port::Throws)));
    let r = run(&door, &input("live", &[p("card-visa")], &[]));
    assert_eq!(get(&r, "reason"), &Json::str("no_live_metrics"));
    assert_eq!(get(&r, "metering"), &unmetered());
    assert_eq!(w.opened(), 0);
}

#[test]
fn live_watch_uses_port_samples_and_ignores_request_body_points() {
    let w = world_or_skip!();
    let door = w.door(port_of(&[point("card-mc", Some("0.90"), Some(100))]));
    let r = run(
        &door,
        &input(
            "live",
            &[point("invented-visa", Some("0.01"), Some(10_000))],
            &[("threshold", Json::str("0.85"))],
        ),
    );
    assert_eq!(get(&r, "status"), &Json::str("ok"));
    assert_eq!(get(&r, "alerts"), &Json::Array(Vec::new()));
    assert_eq!(get(&r, "pointsAccepted"), &Json::int(1));
}

#[test]
fn a_partial_guardrail_drop_refuses_rather_than_watch_the_subset() {
    let w = world_or_skip!();
    w.rebind(
        1,
        r#"[{"name":"pay.metrics.read","module":"pay","mode":"read"},{"name":"pay.rails.list","module":"pay","mode":"read"}]"#,
    );
    let points = [p("a"), p("b"), p("c")];
    let door = w.door(port_of(&points));
    let r = run(&door, &input("live", &points, &[]));
    assert_eq!(
        as_probe(r),
        r#"{"status":"unavailable","userMessageKey":"agents.merchant.unavailable","reason":"no_metrics","metering":{"sessionId":"S","billedAmount":"0","assetId":"IFC","sessionClosed":true,"settlements":[]}}"#
    );
    assert_eq!(w.tool_calls("executed"), ["pay.metrics.read"]);
    assert_eq!(
        w.tool_calls("refused"),
        ["pay.metrics.read", "pay.metrics.read"]
    );
    assert!(w.all_closed());
}

#[test]
fn refuses_the_whole_run_when_every_point_was_refused_by_the_guardrail() {
    let w = world_or_skip!();
    w.rebind(
        40,
        r#"[{"name":"pay.rails.list","module":"pay","mode":"read"}]"#,
    );
    let points = [p("a"), p("b")];
    let door = w.door(port_of(&points));
    let r = run(&door, &input("live", &points, &[]));
    assert_eq!(
        as_probe(r),
        r#"{"status":"refuse","reason":"no_live_metrics","userMessageKey":"agents.merchant.unavailable","pointsRefusedByGuardrail":2,"metering":{"sessionId":"S","billedAmount":"0","assetId":"IFC","sessionClosed":true,"settlements":[]}}"#
    );
    assert_eq!(w.opened(), 1);
    assert!(w.tool_calls("executed").is_empty());
    assert_eq!(w.tool_calls("refused").len(), 2);
    assert!(w.all_closed());
}

#[test]
fn settles_and_closes_even_when_the_run_throws() {
    let w = world_or_skip!();
    // A null sample reaches the watcher, whose `p.railId` throws a TypeError (ts: nullPoint).
    let door = w.door(port_of(&[Json::Null]));
    assert_eq!(
        refused(&door, &input("live", &[p("card-visa")], &[])),
        (
            "INTERNAL_SERVER_ERROR".to_owned(),
            "agents.error.engine_unavailable".to_owned()
        )
    );
    assert_eq!(w.opened(), 1);
    assert!(w.all_closed());
}

#[test]
fn only_ever_asks_for_the_declared_read_tool() {
    let w = world_or_skip!();
    let points = [p("a"), p("b")];
    let door = w.door(port_of(&points));
    run(&door, &input("live", &points, &[]));
    let tools: Vec<String> =
        w.db.client()
            .query(
                "SELECT DISTINCT tool FROM agents.agent_actions WHERE tool IS NOT NULL",
                &[],
            )
            .unwrap()
            .iter()
            .map(|r| r.get(0))
            .collect();
    assert_eq!(tools, ["pay.metrics.read"]);
}

#[test]
fn fat_fixture_rates_on_a_dark_plane_still_refuse() {
    let w = world_or_skip!();
    let points = [
        point("card-visa", Some("0.99"), Some(10_000)),
        point("card-mc", Some("0.98"), Some(10_000)),
    ];
    let door = w.door(port_of(&points));
    let r = run(
        &door,
        &input("dark", &points, &[("threshold", Json::str("0.85"))]),
    );
    assert_eq!(get(&r, "reason"), &Json::str("pay_plane_dark"));
    assert_eq!(get(get(&r, "metering"), "billedAmount"), &Json::str("0"));
    assert_eq!(w.opened(), 0);
}

// ── run-session-route.test.ts ───────────────────────────────────────────────

#[test]
fn the_route_refuses_dark_and_says_it_billed_nothing() {
    let w = world_or_skip!();
    let door = w.door(None);
    for i in [
        input("dark", &[p("card-visa")], &[]),
        input("live", &[p("card-visa")], &[]),
    ] {
        let r = run(&door, &i);
        assert_eq!(get(&r, "status"), &Json::str("refuse"));
        assert_eq!(get(&r, "metering"), &unmetered());
    }
    assert_eq!(w.opened(), 0);
}

#[test]
fn the_route_requires_agents_execute() {
    let w = world_or_skip!();
    let door = w.door(port_of(&[p("card-visa")]));
    let (status, body) = run_as(
        &door,
        &input("dark", &[p("card-visa")], &[]),
        &["agents:read"],
    );
    assert_eq!(status, 403, "{}", body.compact());
    assert_eq!(w.opened(), 0);
}

// ── svc-pay's samples as JavaScript reads them ──────────────────────────────

#[test]
fn an_alert_whose_rail_or_rate_is_not_a_string_fails_the_output_after_the_run_closes() {
    // ts: numericRate, numericRail, coerced: the watch alerts, then `.output()` refuses the answer.
    let coerced = json::parse(
        r#"{"railId":"a","approvalRate":["0.5"],"attempts":100,"asOf":["2026-11-18T23:59:30.000Z"],"maxAgeMs":"120000"}"#,
    )
    .unwrap();
    let numeric_rate = json::parse(
        r#"{"railId":"a","approvalRate":0.5,"attempts":100,"asOf":"2026-11-18T23:59:30.000Z","maxAgeMs":120000}"#,
    )
    .unwrap();
    let numeric_rail = json::parse(
        r#"{"railId":7,"approvalRate":"0.5","attempts":100,"asOf":"2026-11-18T23:59:30.000Z","maxAgeMs":120000}"#,
    )
    .unwrap();
    for sample in [numeric_rate, numeric_rail, coerced] {
        let w = world_or_skip!();
        let door = w.door(port_of(std::slice::from_ref(&sample)));
        assert_eq!(
            refused(&door, &input("live", &[], &[])),
            (
                "INTERNAL_SERVER_ERROR".to_owned(),
                "Output validation failed".to_owned()
            ),
            "{}",
            sample.compact()
        );
        assert_eq!(w.opened(), 1);
        assert!(w.all_closed());
    }
}

#[test]
fn samples_the_typescript_reads_without_failing() {
    let w = world_or_skip!();
    // ts: numericRateNoAlert
    let door = w.door(port_of(&[json::parse(
        r#"{"railId":"a","approvalRate":0.9,"attempts":100,"asOf":"2026-11-18T23:59:30.000Z","maxAgeMs":120000}"#,
    )
    .unwrap()]));
    assert_eq!(
        as_probe(run(&door, &input("live", &[], &[]))),
        r#"{"status":"ok","watchedAt":"2026-11-19T00:00:00.000Z","considered":1,"skippedStale":0,"skippedIncomplete":0,"skippedLowSample":0,"alerts":[],"pointsAccepted":1,"pointsRefusedByGuardrail":0,"metering":{"sessionId":"S","billedAmount":"0","assetId":"IFC","sessionClosed":true,"settlements":[]}}"#
    );
    // ts: numberPoint
    let door = w.door(port_of(&[Json::Number(5.0)]));
    assert_eq!(
        as_probe(run(&door, &input("live", &[], &[]))),
        r#"{"status":"unavailable","userMessageKey":"agents.merchant.unavailable","reason":"no_metrics","metering":{"sessionId":"S","billedAmount":"0","assetId":"IFC","sessionClosed":true,"settlements":[]}}"#
    );
    // ts: extraKeys: a field the point does not declare is carried and dropped by the output.
    let door = w.door(port_of(&[json::parse(
        r#"{"railId":"a","approvalRate":"0.5","attempts":100,"asOf":"2026-11-18T23:59:30.000Z","maxAgeMs":120000,"secretField":"x"}"#,
    )
    .unwrap()]));
    assert_eq!(
        as_probe(run(&door, &input("live", &[], &[]))),
        r#"{"status":"ok","watchedAt":"2026-11-19T00:00:00.000Z","considered":1,"skippedStale":0,"skippedIncomplete":0,"skippedLowSample":0,"alerts":[{"railId":"a","approvalRate":"0.5","attempts":100,"threshold":"0.85","kind":"below_threshold"}],"pointsAccepted":1,"pointsRefusedByGuardrail":0,"metering":{"sessionId":"S","billedAmount":"0","assetId":"IFC","sessionClosed":true,"settlements":[]}}"#
    );
    assert!(w.all_closed());
}

// ── The HTTP port, end to end ───────────────────────────────────────────────

/// A fetch that keeps the request and answers svc-pay's body.
struct PayFetch {
    body: String,
    sent: Mutex<Vec<HttpRequest>>,
}

impl Fetch for PayFetch {
    fn fetch(&self, req: &HttpRequest) -> Result<HttpResponse, FetchError> {
        self.sent.lock().unwrap().push(req.clone());
        Ok(HttpResponse {
            status: 200,
            body: self.body.clone(),
        })
    }
}

#[test]
fn the_http_port_is_signed_for_svc_pay_and_its_points_are_watched() {
    let w = world_or_skip!();
    let body = Json::obj([
        ("ok", Json::Bool(true)),
        ("points", Json::Array(vec![p("card")])),
    ])
    .compact();
    let fetch = Arc::new(PayFetch {
        body,
        sent: Mutex::new(Vec::new()),
    });
    let port = PayMetricsHttp::new(
        "http://pay.test/",
        CallSigner::new("svc-agents", "svc-pay", PAY_SECRET, None),
        fetch.clone(),
    );
    let door = w.door(Some(Box::new(port)));
    let r = run(&door, &input("live", &[], &[]));
    assert_eq!(get(&r, "status"), &Json::str("ok"));
    assert_eq!(get(&r, "pointsAccepted"), &Json::int(1));

    let sent = fetch.sent.lock().unwrap();
    assert_eq!(sent.len(), 1);
    let req = &sent[0];
    assert_eq!(req.method, "GET");
    assert_eq!(req.url, format!("http://pay.test{METRICS_PATH}"));
    assert_eq!(req.body, None);
    let ts: i64 = req
        .headers
        .iter()
        .find(|(k, _)| k == SERVICE_TIMESTAMP_HEADER)
        .map(|(_, v)| v.parse().unwrap())
        .unwrap_or_else(|| panic!("no timestamp in {:?}", req.headers));
    let mut want = vec![("accept".to_owned(), "application/json".to_owned())];
    want.extend(legacy_headers("svc-agents", PAY_SECRET, "", ts).unwrap());
    assert_eq!(req.headers, want);
}
