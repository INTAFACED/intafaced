//! The `ops` slice against a real Postgres (`TEST_DATABASE_URL_AGENTS` or `TEST_DATABASE_URL`, a server whose admin
//! database name ends in `_test`), each test in its own throwaway database migrated by the crate's own runner. Without a
//! URL it skips; with `REQUIRE_POSTGRES=1` it fails.
//!
//! Ported case for case from the slice's TypeScript database tests: `ops/reads.db.test.ts` (`ops.sessions`, with the
//! runtime's `session.mine` and `agent.catalogue` it checks beside them), `alerts/alerts.db.test.ts` and
//! `fleet/control.db.test.ts`. Every call goes through the `AgentsDoor` with a signed principal; a case that calls a
//! store function directly calls the Rust one. The bus is a fake that records, or refuses, every publish. The opsLog
//! cases live with the runtime's in `tests/runtime_doors_pg.rs`, where the engine runs that their history needs.
//!
//! Owed by later slices: the fleet case that stops a background run (`own-runs`) and the `own.status` read in the
//! quarantine case (`own-builder`) are checked here through `own_agent_switch`, the function both read.
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
use service_kit::json::Json;
use service_kit::server::Request;
use support::TestDb;
use svc_agents::door::{AgentsDoor, DoorConfig, ServiceAuth, system_now};
use svc_agents::gateway::desk::GatewaySlice;
use svc_agents::gateway::readiness::ReadyInput;
use svc_agents::metering::Metering;
use svc_agents::metering::ports::Bus;
use svc_agents::ops::alerts::publish_pending_agent_alerts;
use svc_agents::ops::fleet::{fleet_csv, own_agent_switch, product_kind_off, read_fleet};
use svc_agents::ops::{Ops, PolicyBaseline, parse_policy_baseline};
use svc_agents::own::gates::effective_requirement;
use svc_agents::runtime::Runtime;

const SECRET: &str = "agents-ops-backend-edge-secret-32-chars";
const SID: &str = "33333333-3333-4333-8333-333333333333";

/// A bus that records every publish, or refuses every one, as one in an outage does.
#[derive(Clone, Default)]
struct FakeBus {
    sent: Arc<Mutex<Vec<(String, String, Json)>>>,
    down: bool,
}

impl Bus for FakeBus {
    fn publish(&self, subject: &str, msg_id: &str, envelope: &Json) -> Result<(), String> {
        if self.down {
            return Err("bus down".to_owned());
        }
        self.sent
            .lock()
            .unwrap()
            .push((subject.to_owned(), msg_id.to_owned(), envelope.clone()));
        Ok(())
    }
}

impl FakeBus {
    fn alerts(&self) -> Vec<Json> {
        self.sent
            .lock()
            .unwrap()
            .iter()
            .filter(|(s, _, _)| s == "intafaced.agents.alert.triggered")
            .map(|(_, _, e)| e.get("payload").cloned().unwrap())
            .collect()
    }
}

struct World {
    db: TestDb,
    bus: FakeBus,
}

macro_rules! world_or_skip {
    () => {
        match TestDb::new() {
            Some(db) => {
                let mut sink = Vec::new();
                svc_agents::migrate::run(&db.url, false, &mut sink).unwrap();
                World {
                    db,
                    bus: FakeBus::default(),
                }
            }
            None => {
                eprintln!("skipped: no TEST_DATABASE_URL");
                return;
            }
        }
    };
}

fn metering(bus: &FakeBus) -> Metering {
    let mut m = Metering::unwired("FEE", 60);
    m.bus = Box::new(bus.clone());
    m
}

impl World {
    fn door(&self, ops: Ops) -> AgentsDoor {
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
            now: system_now,
            store: self.db.store(),
            gateway: GatewaySlice::unwired("FEE"),
            ready: ReadyInput::unwired(),
            metering: metering(&self.bus),
            runtime: Runtime::unwired(),
            ops,
            background: svc_agents::background::Settings::default(),
            advisors: svc_agents::advisors::Advisors::unwired(),
            team: svc_agents::team::Team::unwired(),
            own: svc_agents::own::Own::unwired(),
        })
        .unwrap()
    }

    fn exec(&self, sql: &str) {
        self.db.client().batch_execute(sql).unwrap();
    }

    fn count(&self, sql: &str) -> i64 {
        self.db.count(sql)
    }
}

fn signed(user: &str, scopes: &[&str]) -> Vec<(String, String)> {
    let raw = Json::obj([
        ("sub", Json::str(user)),
        ("userId", Json::str(user)),
        ("sid", Json::str(SID)),
        (
            "scopes",
            Json::Array(scopes.iter().map(|s| Json::str(*s)).collect()),
        ),
        ("tier", Json::str("none")),
        ("mfa", Json::Bool(true)),
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

/// One call: a query by GET, a mutation by POST, as the door's record of the call says.
fn call(door: &AgentsDoor, path: &str, input: &Json, who: &[(String, String)]) -> (u16, Json) {
    let query = svc_agents::door::call(path).unwrap().kind == svc_agents::door::Kind::Query;
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
        let url = if matches!(input, Json::Null) {
            format!("/trpc/{path}")
        } else {
            format!("/trpc/{path}?input={enc}")
        };
        door.handle(&Request {
            method: "GET",
            url: &url,
            headers: &headers,
            body: "",
        })
    } else {
        headers.push(("content-type".to_owned(), "application/json".to_owned()));
        let body = input.compact();
        let url = format!("/trpc/{path}");
        door.handle(&Request {
            method: "POST",
            url: &url,
            headers: &headers,
            body: &body,
        })
    };
    (
        res.status,
        service_kit::json::parse(&res.body).unwrap_or(Json::Null),
    )
}

fn data(answer: &(u16, Json)) -> Json {
    assert_eq!(answer.0, 200, "{}", answer.1.compact());
    answer
        .1
        .get("result")
        .and_then(|r| r.get("data"))
        .cloned()
        .unwrap_or(Json::Null)
}

/// A refusal's message and tRPC code.
fn refused(answer: &(u16, Json)) -> (String, String) {
    assert_ne!(answer.0, 200, "not refused: {}", answer.1.compact());
    let e = answer.1.get("error").unwrap();
    let s = |v: Option<&Json>| match v {
        Some(Json::String(s)) => s.clone(),
        other => panic!("not a string: {other:?}"),
    };
    (
        s(e.get("message")),
        s(e.get("data").and_then(|d| d.get("code"))),
    )
}

fn text(v: &Json, key: &str) -> String {
    match v.get(key) {
        Some(Json::String(s)) => s.clone(),
        other => panic!("{key} is not a string in {}: {other:?}", v.compact()),
    }
}

fn int(v: &Json, key: &str) -> i64 {
    match v.get(key) {
        #[allow(clippy::cast_possible_truncation, reason = "a count")]
        Some(Json::Number(n)) => *n as i64,
        other => panic!("{key} is not a number in {}: {other:?}", v.compact()),
    }
}

fn list(v: &Json, key: &str) -> Vec<Json> {
    match v.get(key) {
        Some(Json::Array(a)) => a.clone(),
        other => panic!("{key} is not a list in {}: {other:?}", v.compact()),
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

fn s(v: &str) -> Json {
    Json::str(v)
}

fn n(v: i64) -> Json {
    Json::int(v)
}

// ── ops/reads.db.test.ts ─────────────────────────────────────────────────────

const USER_A: &str = "11111111-1111-4111-8111-111111111111";
const USER_B: &str = "22222222-2222-4222-8222-222222222222";
const GUARDRAIL: &str = r#"{"limits":{"maxActionsPerSession":1},"tools":[]}"#;

/// `insertSession`: one session opened at `opened_at`, closed then when closed, with `actions` executed actions.
fn insert_session(
    w: &World,
    user: &str,
    agent: &str,
    status: &str,
    opened_at: &str,
    actions: i32,
) -> String {
    let mut c = w.db.client();
    let id: String = c
        .query_one(
            "INSERT INTO agents.agent_sessions (user_id, agent_id, guardrail, guardrail_version, status, opened_at, closed_at)
             VALUES ($1::text, $2::text, $3::text::jsonb, 1, $4::text::agents.session_status, $5::text::timestamptz,
                     CASE WHEN $4::text = 'closed' THEN $5::text::timestamptz END)
             RETURNING id::text",
            &[&user, &agent, &GUARDRAIL, &status, &opened_at],
        )
        .unwrap()
        .get(0);
    for sequence in 1..=actions {
        c.execute(
            "INSERT INTO agents.agent_actions (session_id, user_id, agent_id, sequence, kind, status, user_message_key, hash)
             VALUES ($1::text::uuid, $2::text, $3::text, $4::int, 'tool_call'::agents.action_kind,
                     'executed'::agents.action_status, 'agents.action.executed', $5::text)",
            &[&id, &user, &agent, &sequence, &format!("hash-{id}-{sequence}")],
        )
        .unwrap();
    }
    id
}

fn ids(page: &Json) -> Vec<String> {
    list(page, "items").iter().map(|i| text(i, "id")).collect()
}

fn ops_sessions(door: &AgentsDoor, input: &Json) -> (u16, Json) {
    call(
        door,
        "ops.sessions",
        input,
        &signed(USER_A, &["admin:read"]),
    )
}

fn mine(door: &AgentsDoor, user: &str, input: &Json) -> (u16, Json) {
    call(door, "session.mine", input, &signed(user, &["agents:read"]))
}

/// reads.db.test.ts: "lists two users with exact per-asset spend, nulls an unsettled session, and pages".
#[test]
fn ops_sessions_lists_two_users_with_exact_per_asset_spend_nulls_an_unsettled_one_and_pages() {
    let w = world_or_skip!();
    let door = w.door(Ops::unwired());
    let settled = insert_session(
        &w,
        USER_A,
        "navigator",
        "closed",
        "2026-01-03T00:00:00.000Z",
        2,
    );
    w.exec(&format!(
        "INSERT INTO agents.usage_windows (session_id, window_id, sealed_at, charged_amount, charged_asset, charge_key) VALUES
           ('{settled}', 'w1', now(), 1.25, 'BBB', 'k1'),
           ('{settled}', 'w2', now(), 2.5, 'AAA', 'k2'),
           ('{settled}', 'w3', now(), 0.25, 'AAA', 'k3')"
    ));
    let unsettled = insert_session(&w, USER_B, "support", "open", "2026-01-02T00:00:00.000Z", 1);
    w.exec(&format!(
        "INSERT INTO agents.usage_windows (session_id, window_id) VALUES ('{unsettled}', 'open-1')"
    ));
    let older = insert_session(&w, USER_A, "scanner", "open", "2026-01-01T00:00:00.000Z", 0);

    let first = data(&ops_sessions(&door, &obj(&[("limit", n(2))])));
    assert_eq!(ids(&first), vec![settled.clone(), unsettled.clone()]);
    let a = &list(&first, "items")[0];
    assert_eq!(
        (text(a, "agentId"), text(a, "userId"), int(a, "actionCount")),
        ("navigator".to_owned(), USER_A.to_owned(), 2)
    );
    assert_eq!(
        a.get("spend").unwrap().compact(),
        r#"[{"assetId":"AAA","amount":"2.75"},{"assetId":"BBB","amount":"1.25"}]"#
    );
    assert_eq!(a.get("spendReason"), Some(&Json::Null));
    let e = w
        .db
        .client()
        .execute(
            "UPDATE agents.usage_windows SET charged_asset = 'ZZZ' WHERE session_id = $1::text::uuid",
            &[&settled],
        )
        .unwrap_err();
    assert!(format!("{e:?}").contains("already settled"), "{e:?}");
    let b = &list(&first, "items")[1];
    assert_eq!(
        (
            text(b, "userId"),
            b.get("spend"),
            text(b, "spendReason"),
            int(b, "actionCount")
        ),
        (
            USER_B.to_owned(),
            Some(&Json::Null),
            "no_settled_window".to_owned(),
            1
        )
    );
    let cursor = text(&first, "nextCursor");

    let second = data(&ops_sessions(
        &door,
        &obj(&[("limit", n(2)), ("cursor", s(&cursor))]),
    ));
    assert_eq!(ids(&second), vec![older.clone()]);
    assert_eq!(second.get("nextCursor"), Some(&Json::Null));

    let only_a = data(&ops_sessions(
        &door,
        &obj(&[("limit", n(10)), ("userId", s(USER_A))]),
    ));
    assert_eq!(ids(&only_a).len(), 2);
    assert!(
        list(&only_a, "items")
            .iter()
            .all(|r| text(r, "userId") == USER_A)
    );

    let support = data(&ops_sessions(
        &door,
        &obj(&[
            ("limit", n(10)),
            ("agentId", s("support")),
            ("status", s("open")),
        ]),
    ));
    assert_eq!(ids(&support), vec![unsettled.clone()]);

    let day = data(&ops_sessions(
        &door,
        &obj(&[
            ("limit", n(10)),
            ("from", s("2026-01-02T00:00:00.000Z")),
            ("to", s("2026-01-02T00:00:00.000Z")),
        ]),
    ));
    assert_eq!(ids(&day), vec![unsettled.clone()]);

    assert_eq!(
        refused(&ops_sessions(&door, &obj(&[]))).0,
        "agents.refused.log_mine_limit_unset"
    );
    assert_eq!(
        refused(&call(
            &door,
            "ops.sessions",
            &obj(&[("limit", n(10))]),
            &signed(USER_A, &["agents:read"])
        ))
        .1,
        "FORBIDDEN"
    );

    let mine_a = data(&mine(&door, USER_A, &obj(&[("limit", n(10))])));
    let mut got = ids(&mine_a);
    got.sort();
    let mut want = vec![settled.clone(), older];
    want.sort();
    assert_eq!(got, want);
    let row = list(&mine_a, "items")
        .into_iter()
        .find(|r| text(r, "id") == settled)
        .unwrap();
    assert_eq!(
        row.get("spend").unwrap().compact(),
        r#"[{"assetId":"AAA","amount":"2.75"},{"assetId":"BBB","amount":"1.25"}]"#
    );
    let mine_b = data(&mine(&door, USER_B, &obj(&[("limit", n(10))])));
    assert_eq!(ids(&mine_b), vec![unsettled]);
    let b = &list(&mine_b, "items")[0];
    assert_eq!(
        (b.get("spend"), text(b, "spendReason")),
        (Some(&Json::Null), "no_settled_window".to_owned())
    );
}

/// reads.db.test.ts: "pages a caller past 500 of their own sessions and hides the other user".
#[test]
fn a_caller_pages_past_500_of_their_own_sessions_and_never_sees_another_users() {
    let w = world_or_skip!();
    let door = w.door(Ops::unwired());
    w.exec(&format!(
        "INSERT INTO agents.agent_sessions (user_id, agent_id, guardrail, guardrail_version, status, opened_at)
         SELECT '{USER_A}', 'navigator', '{GUARDRAIL}'::jsonb, 1, 'open'::agents.session_status,
                timestamptz '2026-06-01T00:00:00.000Z' - (g || ' seconds')::interval
           FROM generate_series(1, 501) AS g"
    ));
    let foreign = insert_session(
        &w,
        USER_B,
        "navigator",
        "open",
        "2026-07-01T00:00:00.000Z",
        0,
    );
    let first = data(&mine(&door, USER_A, &obj(&[("limit", n(500))])));
    assert_eq!(ids(&first).len(), 500);
    assert!(!ids(&first).contains(&foreign));
    let cursor = text(&first, "nextCursor");
    let second = data(&mine(
        &door,
        USER_A,
        &obj(&[("limit", n(500)), ("cursor", s(&cursor))]),
    ));
    assert_eq!(ids(&second).len(), 1);
    assert_ne!(ids(&second)[0], foreign);
    assert_eq!(second.get("nextCursor"), Some(&Json::Null));
    let page = data(&ops_sessions(
        &door,
        &obj(&[("limit", n(10)), ("userId", s(USER_A))]),
    ));
    assert!(
        list(&page, "items")
            .iter()
            .all(|r| text(r, "userId") != USER_B)
    );
}

/// reads.db.test.ts: "returns every session that shares a millisecond, once, in opened_at DESC, id DESC order".
#[test]
fn sessions_sharing_a_millisecond_are_each_listed_once_newest_first_then_by_id() {
    let w = world_or_skip!();
    let door = w.door(Ops::unwired());
    let later = insert_session(
        &w,
        USER_A,
        "navigator",
        "open",
        "2026-01-02T00:00:00.123700Z",
        0,
    );
    let tie_a = insert_session(
        &w,
        USER_A,
        "navigator",
        "open",
        "2026-01-02T00:00:00.123456Z",
        0,
    );
    let tie_b = insert_session(
        &w,
        USER_A,
        "navigator",
        "open",
        "2026-01-02T00:00:00.123456Z",
        0,
    );
    let earlier = insert_session(
        &w,
        USER_A,
        "navigator",
        "open",
        "2026-01-02T00:00:00.123400Z",
        0,
    );
    let (hi, lo): (String, String) = {
        let r = w
            .db
            .client()
            .query_one(
                "SELECT (array_agg(id::text ORDER BY id DESC))[1], (array_agg(id::text ORDER BY id DESC))[2]
                   FROM (VALUES ($1::text::uuid), ($2::text::uuid)) AS t(id)",
                &[&tie_a, &tie_b],
            )
            .unwrap();
        (r.get(0), r.get(1))
    };
    let expected = vec![later, hi, lo, earlier];
    let page_all = |path: &str, user_scope: &str| {
        let mut got = Vec::new();
        let mut cursor: Option<String> = None;
        for _ in 0..8 {
            let mut input = vec![("limit", n(1))];
            if let Some(c) = &cursor {
                input.push(("cursor", s(c)));
            }
            let page = data(&call(
                &door,
                path,
                &obj(&input),
                &signed(USER_A, &[user_scope]),
            ));
            got.extend(ids(&page));
            match page.get("nextCursor") {
                Some(Json::String(c)) => cursor = Some(c.clone()),
                _ => {
                    cursor = None;
                    break;
                }
            }
        }
        assert!(cursor.is_none());
        got
    };
    assert_eq!(page_all("session.mine", "agents:read"), expected);
    assert_eq!(page_all("ops.sessions", "admin:read"), expected);
}

/// reads.db.test.ts: "lists stored fields, keeps a null purpose null, and refuses a session without agents:read".
#[test]
fn the_catalogue_lists_stored_fields_keeps_a_null_purpose_and_needs_agents_read() {
    let w = world_or_skip!();
    let door = w.door(Ops::unwired());
    w.exec(&format!(
        "INSERT INTO agents.agent_definitions (agent_id, version, guardrail, enabled, name, purpose) VALUES
           ('alpha', 2, '{GUARDRAIL}'::jsonb, true, 'Alpha', 'Reads markets'),
           ('beta', 4, '{GUARDRAIL}'::jsonb, false, 'Beta', NULL)"
    ));
    let rows = data(&call(
        &door,
        "agent.catalogue",
        &Json::Null,
        &signed(USER_A, &["agents:read"]),
    ));
    assert_eq!(
        rows.compact(),
        r#"[{"agentId":"alpha","name":"Alpha","purpose":"Reads markets","enabled":true,"version":2},{"agentId":"beta","name":"Beta","purpose":null,"enabled":false,"version":4}]"#
    );
    assert_eq!(
        refused(&call(
            &door,
            "agent.catalogue",
            &Json::Null,
            &signed(USER_A, &["admin:read"])
        ))
        .1,
        "FORBIDDEN"
    );
}

// ── alerts/alerts.db.test.ts ─────────────────────────────────────────────────

const ALERT_OPERATOR: &str = "51515151-5151-4151-8151-515151515151";

fn alert_ops() -> Ops {
    Ops {
        baseline: parse_policy_baseline(Some(
            r#"{"own_data":"act_on_request","market_data":"act_on_request","draft_write":"ask_before","live_write":"act_on_request"}"#,
        ))
        .unwrap(),
        ..Ops::unwired()
    }
}

fn desk(door: &AgentsDoor, path: &str, input: &Json) -> (u16, Json) {
    call(
        door,
        &format!("opsAlerts.{path}"),
        input,
        &signed(ALERT_OPERATOR, &["admin:read", "admin:write"]),
    )
}

/// `actions(agentId, status, n, cost)`: `n` actions of `status` in a session of their own, now.
fn actions(w: &World, agent: &str, status: &str, count: i32, cost: &str) {
    let mut c = w.db.client();
    let session: String = c
        .query_one(
            "INSERT INTO agents.agent_sessions (user_id, agent_id, guardrail, guardrail_version)
             VALUES ($1::text, $2::text, '{\"limits\":{},\"tools\":[]}'::jsonb, 1) RETURNING id::text",
            &[&ALERT_OPERATOR, &agent],
        )
        .unwrap()
        .get(0);
    let refused = status == "refused";
    for i in 0..count {
        c.execute(
            "INSERT INTO agents.agent_actions
               (session_id, user_id, agent_id, sequence, kind, status, task, refusal_code, cost, user_message_key, hash)
             VALUES ($1::text::uuid, $2::text, $3::text, $4::int, 'completion', $5::text::agents.action_status, 'plan',
                     $6::text, $7::text::numeric, 'agents.test', $8::text)",
            &[
                &session,
                &ALERT_OPERATOR,
                &agent,
                &i,
                &status,
                &refused.then_some("agents.refused.task_not_allowed"),
                &(if refused { "0" } else { cost }),
                &format!("h:{session}:{i}"),
            ],
        )
        .unwrap();
    }
}

fn rule(
    name: &str,
    measure: &str,
    threshold: Option<&str>,
    minutes: i64,
    agent: Option<&str>,
) -> Json {
    let mut f = vec![("name", s(name)), ("measure", s(measure))];
    if let Some(t) = threshold {
        f.push(("threshold", s(t)));
    }
    f.push(("windowMinutes", n(minutes)));
    if let Some(a) = agent {
        f.push(("agentId", s(a)));
    }
    obj(&f)
}

/// alerts.db.test.ts #1: "a blank threshold stores nothing; a threshold of 0 is stored as 0".
#[test]
fn alerts_a_blank_threshold_stores_nothing_and_zero_is_stored_as_zero() {
    let w = world_or_skip!();
    let door = w.door(alert_ops());
    assert_eq!(
        refused(&desk(
            &door,
            "createRule",
            &rule("TEST refusals", "refusal_rate", None, 60, None)
        ))
        .0,
        "agents.alert_threshold_required"
    );
    assert!(list(&data(&desk(&door, "desk", &Json::Null)), "rules").is_empty());
    let r = data(&desk(
        &door,
        "createRule",
        &rule("TEST refusals", "refusal_rate", Some("0"), 60, None),
    ));
    assert_eq!(text(&r, "threshold"), "0");
    let rules = list(&data(&desk(&door, "desk", &Json::Null)), "rules");
    assert_eq!(
        rules
            .iter()
            .map(|r| (text(r, "name"), text(r, "threshold")))
            .collect::<Vec<_>>(),
        vec![("TEST refusals".to_owned(), "0".to_owned())]
    );
    assert_eq!(
        refused(&desk(
            &door,
            "createRule",
            &rule("TEST refusals", "cost", Some("1"), 5, None)
        )),
        (
            "agents.alert_rule_name_taken".to_owned(),
            "CONFLICT".to_owned()
        )
    );
}

/// alerts.db.test.ts #2: "two evaluations of a breached window keep one alert, handed to notifications once; an empty
/// window fires nothing and has no rate".
#[test]
fn alerts_two_evaluations_keep_one_alert_handed_over_once_and_an_empty_window_has_no_rate() {
    let w = world_or_skip!();
    let door = w.door(alert_ops());
    actions(&w, "probe", "executed", 3, "0");
    actions(&w, "probe", "refused", 1, "0");
    let breached = data(&desk(
        &door,
        "createRule",
        &rule("TEST refusals", "refusal_rate", Some("0"), 60, None),
    ));
    let quiet = data(&desk(
        &door,
        "createRule",
        &rule(
            "TEST quiet",
            "refusal_rate",
            Some("0"),
            60,
            Some("TEST-no-actions"),
        ),
    ));
    let first = data(&desk(&door, "evaluate", &Json::Null));
    let second = data(&desk(&door, "evaluate", &Json::Null));
    let current = |run: &Json, rule: &Json| {
        let w = list(run, "windows")
            .into_iter()
            .find(|x| text(x, "ruleId") == text(rule, "id"))
            .unwrap();
        (
            int(&w, "actionRows"),
            w.get("value").unwrap().compact(),
            w.get("breached").cloned(),
            w.get("alertWritten").cloned(),
        )
    };
    let t = Some(Json::Bool(true));
    let f = Some(Json::Bool(false));
    assert_eq!(
        current(&first, &breached),
        (4, "\"25\"".to_owned(), t.clone(), t.clone())
    );
    assert_eq!(
        current(&second, &breached),
        (4, "\"25\"".to_owned(), t, f.clone())
    );
    assert_eq!(
        current(&first, &quiet),
        (0, "null".to_owned(), f.clone(), f)
    );
    let alerts = list(&data(&desk(&door, "desk", &Json::Null)), "alerts");
    assert_eq!(
        alerts
            .iter()
            .map(|a| (
                text(a, "ruleName"),
                int(a, "actionRows"),
                text(a, "value"),
                text(a, "threshold"),
                text(a, "delivery")
            ))
            .collect::<Vec<_>>(),
        vec![(
            "TEST refusals".to_owned(),
            4,
            "25".to_owned(),
            "0".to_owned(),
            "handed_off".to_owned()
        )]
    );
    let sent = w.bus.alerts();
    assert_eq!(
        sent.iter()
            .map(|e| (
                text(e, "userId"),
                text(e, "ruleName"),
                text(e, "value"),
                text(e, "threshold")
            ))
            .collect::<Vec<_>>(),
        vec![(
            ALERT_OPERATOR.to_owned(),
            "TEST refusals".to_owned(),
            "25".to_owned(),
            "0".to_owned()
        )]
    );
    assert_eq!(
        text(&sent[0], "alertKey"),
        format!(
            "agents.alert:{}:{}",
            text(&breached, "id"),
            text(&alerts[0], "windowStart")
        )
    );
    assert_eq!(w.count("SELECT count(*) FROM agents.agent_alerts"), 1);
}

/// alerts.db.test.ts #3: "with notifications down an alert is kept pending and nothing is sent; back on, it is handed
/// over".
#[test]
fn alerts_with_notifications_down_an_alert_stays_pending_and_back_on_it_is_handed_over() {
    let w = world_or_skip!();
    let door = w.door(alert_ops());
    assert_eq!(
        data(&desk(&door, "desk", &Json::Null))
            .get("notifications")
            .unwrap()
            .compact(),
        r#"{"state":"on","setBy":null,"setAt":null}"#
    );
    assert_eq!(
        text(
            &data(&desk(
                &door,
                "setNotifications",
                &obj(&[("state", s("down"))])
            )),
            "state"
        ),
        "down"
    );
    actions(&w, "probe", "refused", 1, "0");
    data(&desk(
        &door,
        "createRule",
        &rule("TEST while down", "refusal_rate", Some("0"), 60, None),
    ));
    data(&desk(&door, "evaluate", &Json::Null));
    let alerts = list(&data(&desk(&door, "desk", &Json::Null)), "alerts");
    assert_eq!(
        alerts
            .iter()
            .map(|a| (
                text(a, "ruleName"),
                text(a, "delivery"),
                a.get("handedOffAt").cloned()
            ))
            .collect::<Vec<_>>(),
        vec![(
            "TEST while down".to_owned(),
            "pending".to_owned(),
            Some(Json::Null)
        )]
    );
    assert!(w.bus.alerts().is_empty());
    // A publish that fails leaves it pending too.
    let broken = FakeBus {
        down: true,
        ..FakeBus::default()
    };
    w.exec("UPDATE agents.agent_alert_settings SET notifications = 'on'");
    let store = w.db.store();
    assert_eq!(
        publish_pending_agent_alerts(store.pool().unwrap(), &metering(&broken), system_now())
            .unwrap(),
        0
    );
    w.exec("UPDATE agents.agent_alert_settings SET notifications = 'down'");
    assert_eq!(
        text(
            &list(&data(&desk(&door, "desk", &Json::Null)), "alerts")[0],
            "delivery"
        ),
        "pending"
    );
    data(&desk(
        &door,
        "setNotifications",
        &obj(&[("state", s("on"))]),
    ));
    let kept = list(&data(&desk(&door, "desk", &Json::Null)), "alerts")[0].clone();
    assert_eq!(text(&kept, "delivery"), "handed_off");
    assert_ne!(kept.get("handedOffAt"), Some(&Json::Null));
    assert_eq!(w.bus.alerts().len(), 1);
}

/// alerts.db.test.ts: "failure rate and cost read their own columns; a value at the threshold is not above it".
#[test]
fn alerts_failure_rate_and_cost_read_their_own_columns_and_a_value_at_the_threshold_is_not_above_it()
 {
    let w = world_or_skip!();
    let door = w.door(alert_ops());
    actions(&w, "probe", "failed", 1, "0");
    actions(&w, "probe", "executed", 1, "0.75");
    for (name, measure, t) in [
        ("TEST failures at 50", "failure_rate", "50"),
        ("TEST failures over 49.5", "failure_rate", "49.5"),
        ("TEST cost at 0.75", "cost", "0.75"),
        ("TEST cost over 0.5", "cost", "0.5"),
    ] {
        data(&desk(
            &door,
            "createRule",
            &rule(name, measure, Some(t), 30, None),
        ));
    }
    data(&desk(&door, "evaluate", &Json::Null));
    let mut got: Vec<(String, String)> = list(&data(&desk(&door, "desk", &Json::Null)), "alerts")
        .iter()
        .map(|a| (text(a, "ruleName"), text(a, "value")))
        .collect();
    got.sort();
    assert_eq!(
        got,
        vec![
            ("TEST cost over 0.5".to_owned(), "0.75".to_owned()),
            ("TEST failures over 49.5".to_owned(), "50".to_owned())
        ]
    );
}

/// alerts.db.test.ts #4: "the baseline is shown; an override looser than it is refused and not stored; a narrower one
/// narrows the gate".
#[test]
fn alerts_an_override_looser_than_the_baseline_is_refused_and_a_narrower_one_narrows_the_gate() {
    let w = world_or_skip!();
    let ops = alert_ops();
    let door = w.door(ops.clone());
    let store = w.db.store();
    let pool = store.pool().unwrap();
    let class = |policy: &Json, dc: &str| {
        list(policy, "classes")
            .into_iter()
            .find(|c| text(c, "dataClass") == dc)
            .unwrap()
    };
    let before = class(&data(&desk(&door, "policy", &Json::Null)), "own_data");
    assert_eq!(
        (text(&before, "baseline"), before.get("override")),
        ("act_on_request".to_owned(), Some(&Json::Null))
    );
    let set = |choice: &str| {
        desk(
            &door,
            "setOverride",
            &obj(&[("dataClass", s("own_data")), ("choice", s(choice))]),
        )
    };
    assert_eq!(
        refused(&set("act_without_asking")).0,
        "agents.baseline_loosen_refused"
    );
    assert!(
        list(&data(&desk(&door, "policy", &Json::Null)), "classes")
            .iter()
            .all(|c| c.get("override") == Some(&Json::Null))
    );
    assert_eq!(
        effective_requirement(pool, &ops.baseline, "own_data")
            .unwrap()
            .as_deref(),
        Some("act_on_request")
    );
    let after = class(&data(&set("ask_before")), "own_data");
    assert_eq!(
        (
            text(&after, "baseline"),
            text(&after, "override"),
            text(&after, "effective"),
            text(&after, "overrideSetBy")
        ),
        (
            "act_on_request".to_owned(),
            "ask_before".to_owned(),
            "ask_before".to_owned(),
            ALERT_OPERATOR.to_owned()
        )
    );
    assert_eq!(
        effective_requirement(pool, &ops.baseline, "own_data")
            .unwrap()
            .as_deref(),
        Some("ask_before")
    );
    // A blank baseline stays blank whatever the override says.
    assert_eq!(
        effective_requirement(pool, &PolicyBaseline::default(), "own_data").unwrap(),
        None
    );
}

/// alerts.db.test.ts #5: "a rule that loosens the baseline is refused; a write needs admin:write".
#[test]
fn alerts_a_rule_that_loosens_the_baseline_is_refused_and_a_write_needs_admin_write() {
    let w = world_or_skip!();
    let door = w.door(alert_ops());
    let check = |choice: &str| {
        desk(
            &door,
            "checkRule",
            &obj(&[("dataClass", s("own_data")), ("choice", s(choice))]),
        )
    };
    assert_eq!(
        refused(&check("act_without_asking")).0,
        "agents.baseline_loosen_refused"
    );
    assert_eq!(
        data(&check("ask_before")).compact(),
        r#"{"verdict":"allowed","effective":"act_on_request"}"#
    );
    let reader = signed(ALERT_OPERATOR, &["admin:read"]);
    assert_ne!(
        call(
            &door,
            "opsAlerts.createRule",
            &rule("TEST", "cost", Some("1"), 5, None),
            &reader
        )
        .0,
        200
    );
    assert_ne!(
        call(
            &door,
            "opsAlerts.setOverride",
            &obj(&[("dataClass", s("own_data")), ("choice", s("ask_before"))]),
            &reader
        )
        .0,
        200
    );
    assert_eq!(w.count("SELECT count(*) FROM agents.agent_alert_rules"), 0);
    assert_eq!(
        w.count("SELECT count(*) FROM agents.agent_policy_overrides"),
        0
    );
}

// ── fleet/control.db.test.ts ─────────────────────────────────────────────────

const FOUNDER_A: &str = "44444444-4444-4444-8444-444444444444";
const FOUNDER_B: &str = "66666666-6666-4666-8666-666666666666";
const CUSTOMER: &str = "11111111-1111-4111-8111-111111111111";
const OWN: &str = "77777777-7777-4777-8777-777777777777";

/// The suite's `beforeEach`: two product agents (navigator reads with a cap; support writes with none) and one
/// person's agent.
fn fleet_world(w: &World) {
    let guardrail = |tools: &str, cap: &str| {
        format!(
            r#"{{"agentId":"x","version":1,"tools":{tools},"limits":{{"maxActionsPerSession":5,"maxOutputTokensPerCall":100,"maxSpendPerSession":{cap},"allowedModules":[],"allowedTasks":[]}}}}"#
        )
    };
    let nav = guardrail(
        r#"[{"name":"a","module":"trade","mode":"read","requiresApproval":false}]"#,
        "\"5\"",
    );
    let sup = guardrail(
        r#"[{"name":"b","module":"support","mode":"write","requiresApproval":true}]"#,
        "null",
    );
    let mut c = w.db.client();
    c.execute(
        "INSERT INTO agents.agent_definitions (agent_id, guardrail, name, enabled) VALUES
           ('navigator', $1::text::jsonb, 'Navigator', true), ('support', $2::text::jsonb, 'Support', true)",
        &[&nav, &sup],
    )
    .unwrap();
    c.execute(
        "INSERT INTO agents.own_agents (id, owner_id, template, name, create_key, per_session_cap)
         VALUES ($1::text::uuid, $2::text, 'service-starter', 'TEST helper', 'k1', 1)",
        &[&OWN, &CUSTOMER],
    )
    .unwrap();
}

fn fleet_ops(limit: Option<i64>) -> Ops {
    Ops {
        registry_limit: limit,
        ..Ops::unwired()
    }
}

fn founder(door: &AgentsDoor, who: &str, path: &str, input: &Json) -> (u16, Json) {
    call(
        door,
        &format!("fleet.{path}"),
        input,
        &signed(who, &["admin:read", "admin:write"]),
    )
}

/// `audits(action)`: each row's operator, reason and row count, oldest first.
fn audits(w: &World, action: &str) -> Vec<(String, Option<String>, Option<i32>)> {
    w.db.client()
        .query(
            "SELECT operator_id, reason, row_count FROM agents.agent_fleet_audit WHERE action = $1::text ORDER BY at",
            &[&action],
        )
        .unwrap()
        .iter()
        .map(|r| (r.get(0), r.get(1), r.get(2)))
        .collect()
}

fn row_of(read: &Json, reference: &str) -> Json {
    list(read, "rows")
        .into_iter()
        .find(|r| text(r, "ref") == reference)
        .unwrap()
}

fn switch_of(w: &World) -> &'static str {
    own_agent_switch(&mut w.db.client(), OWN).unwrap()
}

/// control.db.test.ts: "lists every agent with owner, publisher, channels and risk signals, and counts total, ownerless
/// and unmanaged".
#[test]
fn fleet_lists_every_agent_with_its_signals_and_counts_and_a_filter_narrows_only_the_rows() {
    let w = world_or_skip!();
    fleet_world(&w);
    let door = w.door(fleet_ops(Some(50)));
    let read = data(&founder(&door, FOUNDER_A, "registry", &obj(&[])));
    assert_eq!(
        read.get("counts").unwrap().compact(),
        r#"{"total":3,"ownerless":2,"unmanaged":0,"disabled":0,"quarantined":0}"#
    );
    let own = row_of(&read, &format!("own:{OWN}"));
    assert_eq!(
        (
            text(&own, "kind"),
            text(&own, "ownerId"),
            own.get("publisherId"),
            own.get("channels"),
            text(&own, "status")
        ),
        (
            "customer_built".to_owned(),
            CUSTOMER.to_owned(),
            Some(&Json::Null),
            Some(&Json::Null),
            "active".to_owned()
        )
    );
    assert_eq!(
        own.get("riskSignals").unwrap().compact(),
        r#"["never_run"]"#
    );
    let support = row_of(&read, "product:support");
    assert_eq!(
        (
            text(&support, "kind"),
            support.get("ownerId"),
            support.get("publisherId")
        ),
        ("product".to_owned(), Some(&Json::Null), Some(&Json::Null))
    );
    assert_eq!(
        support.get("riskSignals").unwrap().compact(),
        r#"["no_owner","write_tool","no_spend_cap","never_run"]"#
    );
    let writers = data(&founder(
        &door,
        FOUNDER_A,
        "registry",
        &obj(&[("riskSignal", s("write_tool"))]),
    ));
    assert_eq!(
        list(&writers, "rows")
            .iter()
            .map(|r| text(r, "ref"))
            .collect::<Vec<_>>(),
        vec!["product:support".to_owned()]
    );
    assert_eq!(int(&writers, "filtered"), 1);
    assert_eq!(int(writers.get("counts").unwrap(), "total"), 3);
}

/// control.db.test.ts: "refuses a blank page size by its code, and a customer by scope".
#[test]
fn fleet_refuses_a_blank_page_size_by_its_code_and_a_customer_by_scope() {
    let w = world_or_skip!();
    fleet_world(&w);
    let blank = w.door(fleet_ops(None));
    assert_eq!(
        refused(&founder(&blank, FOUNDER_A, "registry", &obj(&[]))).0,
        "agents.registry_list_limit_unset"
    );
    let door = w.door(fleet_ops(Some(50)));
    let customer = signed(CUSTOMER, &["agents:read", "agents:write"]);
    assert_eq!(
        refused(&call(&door, "fleet.registry", &obj(&[]), &customer)).1,
        "FORBIDDEN"
    );
    let q = obj(&[
        ("ref", s(&format!("own:{OWN}"))),
        ("reason", s("x")),
        ("requestId", s("req-fleet-c1")),
    ]);
    assert_eq!(
        refused(&call(&door, "fleet.quarantine", &q, &customer)).1,
        "FORBIDDEN"
    );
}

/// control.db.test.ts: "exports the filtered registry over the full range, not the page, with one audit row per request
/// id".
#[test]
fn fleet_exports_the_filtered_registry_over_the_full_range_with_one_audit_row_per_request_id() {
    let w = world_or_skip!();
    fleet_world(&w);
    let paged = w.door(fleet_ops(Some(1)));
    let input = |signal: &str| {
        obj(&[
            ("riskSignal", s(signal)),
            ("requestId", s("req-fleet-export-1")),
        ])
    };
    let out = data(&founder(&paged, FOUNDER_A, "export", &input("never_run")));
    assert_eq!(int(&out, "rows"), 3);
    let csv = text(&out, "csv");
    assert_eq!(csv.trim().split('\n').count(), 4);
    assert!(csv.contains("not set"));
    assert_eq!(int(&out, "auditRows"), 1);
    let again = data(&founder(&paged, FOUNDER_A, "export", &input("never_run")));
    assert_eq!(int(&again, "auditRows"), 1);
    assert_eq!(
        audits(&w, "export"),
        vec![(FOUNDER_A.to_owned(), None, Some(3))]
    );
    assert_eq!(
        refused(&founder(&paged, FOUNDER_A, "export", &input("write_tool"))).0,
        "agents.fleet_request_reused"
    );
    // A value with a comma or a line break stays one cell on one line.
    let store = w.db.store();
    let mut first = read_fleet(store.pool().unwrap()).unwrap()[0].clone();
    first.name = Some("a,b\nc".to_owned());
    assert_eq!(fleet_csv(&[first]).trim().split('\n').count(), 2);
}

/// control.db.test.ts: "reads the audit log back: one row per export and per switch, naming the operator, the filter,
/// the count and the request".
#[test]
fn fleet_reads_the_audit_log_back_newest_first_within_the_page_size() {
    let w = world_or_skip!();
    fleet_world(&w);
    let door = w.door(fleet_ops(Some(50)));
    let export = obj(&[
        ("riskSignal", s("no_owner")),
        ("requestId", s("agents-fleet:export:a1")),
    ]);
    data(&founder(&door, FOUNDER_A, "export", &export));
    data(&founder(&door, FOUNDER_A, "export", &export));
    data(&founder(
        &door,
        FOUNDER_B,
        "quarantine",
        &obj(&[
            ("ref", s(&format!("own:{OWN}"))),
            ("reason", s("TEST quarantine")),
            ("requestId", s("agents-fleet:quarantine:b1")),
        ]),
    ));
    let audit = data(&founder(&door, FOUNDER_A, "audit", &Json::Null));
    assert_eq!(int(&audit, "limit"), 50);
    let rest: Vec<String> = list(&audit, "rows")
        .into_iter()
        .map(|r| match r {
            Json::Object(f) => Json::Object(
                f.into_iter()
                    .filter(|(k, _)| k != "id" && k != "at")
                    .collect(),
            )
            .compact(),
            _ => panic!(),
        })
        .collect();
    assert_eq!(
        rest,
        vec![
            format!(
                r#"{{"operatorId":"{FOUNDER_B}","action":"quarantine","agentRef":"own:{OWN}","kind":null,"reason":"TEST quarantine","filter":{{}},"rowCount":null,"requestId":"agents-fleet:quarantine:b1"}}"#
            ),
            format!(
                r#"{{"operatorId":"{FOUNDER_A}","action":"export","agentRef":null,"kind":null,"reason":null,"filter":{{"riskSignal":"no_owner"}},"rowCount":2,"requestId":"agents-fleet:export:a1"}}"#
            ),
        ]
    );
    let one = w.door(fleet_ops(Some(1)));
    assert_eq!(
        list(
            &data(&founder(&one, FOUNDER_A, "audit", &Json::Null)),
            "rows"
        )
        .iter()
        .map(|r| text(r, "action"))
        .collect::<Vec<_>>(),
        vec!["quarantine".to_owned()]
    );
    let blank = w.door(fleet_ops(None));
    assert_eq!(
        refused(&founder(&blank, FOUNDER_A, "audit", &Json::Null)).0,
        "agents.registry_list_limit_unset"
    );
    assert_eq!(
        refused(&call(
            &door,
            "fleet.audit",
            &Json::Null,
            &signed(CUSTOMER, &["agents:read"])
        ))
        .1,
        "FORBIDDEN"
    );
}

/// control.db.test.ts: "quarantines with a reason, refuses new work as disabled, and restores only with two distinct
/// founders". The person's own `own.status` read is `own_agent_switch`, which own-builder's door answers with.
#[test]
fn fleet_quarantines_with_a_reason_and_restores_only_with_two_distinct_founders() {
    let w = world_or_skip!();
    fleet_world(&w);
    let door = w.door(fleet_ops(Some(50)));
    let reference = format!("own:{OWN}");
    let q = |reason: &str, request: &str| {
        founder(
            &door,
            FOUNDER_A,
            "quarantine",
            &obj(&[
                ("ref", s(&reference)),
                ("reason", s(reason)),
                ("requestId", s(request)),
            ]),
        )
    };
    assert_eq!(
        refused(&q("  ", "req-fleet-q0")).0,
        "agents.reason_required"
    );
    data(&q("TEST quarantine", "req-fleet-q1"));
    data(&q("TEST quarantine", "req-fleet-q1"));
    assert_eq!(
        audits(&w, "quarantine"),
        vec![(
            FOUNDER_A.to_owned(),
            Some("TEST quarantine".to_owned()),
            None
        )]
    );
    assert_eq!(switch_of(&w), "quarantined");
    let store = w.db.store();
    let row = read_fleet(store.pool().unwrap())
        .unwrap()
        .into_iter()
        .find(|r| r.reference == reference)
        .unwrap()
        .json();
    assert_eq!(text(&row, "status"), "quarantined");
    let qs = row.get("quarantine").unwrap();
    assert_eq!(
        (text(qs, "setBy"), text(qs, "reason")),
        (FOUNDER_A.to_owned(), "TEST quarantine".to_owned())
    );

    let restore = |who: &str, request: &str| {
        founder(
            &door,
            who,
            "restore",
            &obj(&[("ref", s(&reference)), ("requestId", s(request))]),
        )
    };
    let waiting = r#"{"outcome":"waiting_second_founder"}"#;
    let restored = r#"{"outcome":"restored"}"#;
    assert_eq!(data(&restore(FOUNDER_A, "req-fleet-r1")).compact(), waiting);
    assert_eq!(data(&restore(FOUNDER_A, "req-fleet-r2")).compact(), waiting);
    assert_eq!(switch_of(&w), "quarantined");
    assert_eq!(
        data(&restore(FOUNDER_B, "req-fleet-r3")).compact(),
        restored
    );
    assert_eq!(switch_of(&w), "active");
    // The second founder's same request again answers the same; a fresh one on an active agent is refused by name.
    assert_eq!(
        data(&restore(FOUNDER_B, "req-fleet-r3")).compact(),
        restored
    );
    assert_eq!(
        refused(&restore(FOUNDER_B, "req-fleet-r4")).0,
        "agents.fleet_not_quarantined"
    );
    assert_eq!(
        audits(&w, "restore")
            .into_iter()
            .map(|a| a.0)
            .collect::<Vec<_>>(),
        vec![FOUNDER_B.to_owned()]
    );
}

/// control.db.test.ts: "quarantines a product agent through its own switch, which a boot re-register keeps".
#[test]
fn fleet_quarantines_a_product_agent_through_its_own_switch() {
    let w = world_or_skip!();
    fleet_world(&w);
    let door = w.door(fleet_ops(Some(50)));
    let q = |reference: &str, request: &str| {
        founder(
            &door,
            FOUNDER_A,
            "quarantine",
            &obj(&[
                ("ref", s(reference)),
                ("reason", s("TEST")),
                ("requestId", s(request)),
            ]),
        )
    };
    data(&q("product:navigator", "req-fleet-q2"));
    assert_eq!(
        w.count("SELECT count(*) FROM agents.agent_definitions WHERE agent_id = 'navigator' AND NOT enabled"),
        1
    );
    assert_eq!(
        refused(&q("product:nobody", "req-fleet-q3")).0,
        "agents.agent_not_found"
    );
}

/// control.db.test.ts: "kills a whole kind in one audited action that a restart keeps, and restores it with two
/// founders".
#[test]
fn fleet_kills_a_whole_kind_in_one_audited_action_and_restores_it_with_two_founders() {
    let w = world_or_skip!();
    fleet_world(&w);
    let door = w.door(fleet_ops(Some(50)));
    let out = data(&founder(
        &door,
        FOUNDER_A,
        "killKind",
        &obj(&[
            ("kind", s("customer_built")),
            ("reason", s("TEST kind kill")),
            ("requestId", s("req-fleet-k1")),
        ]),
    ));
    assert_eq!(int(&out, "agents"), 1);
    assert_eq!(
        audits(&w, "kill_kind"),
        vec![(
            FOUNDER_A.to_owned(),
            Some("TEST kind kill".to_owned()),
            Some(1)
        )]
    );
    // A fresh read, as after a restart, still reads it off.
    let store = w.db.store();
    let pool = store.pool().unwrap();
    let status = read_fleet(pool)
        .unwrap()
        .into_iter()
        .find(|r| r.reference == format!("own:{OWN}"))
        .unwrap()
        .status;
    assert_eq!(status, "disabled_by_kind");
    assert_eq!(switch_of(&w), "disabled_by_kind");
    assert!(!product_kind_off(pool).unwrap());
    let restore = |who: &str, request: &str| {
        founder(
            &door,
            who,
            "restoreKind",
            &obj(&[("kind", s("customer_built")), ("requestId", s(request))]),
        )
    };
    assert_eq!(
        data(&restore(FOUNDER_A, "req-fleet-k2")).compact(),
        r#"{"outcome":"waiting_second_founder"}"#
    );
    assert_eq!(
        data(&restore(FOUNDER_B, "req-fleet-k3")).compact(),
        r#"{"outcome":"restored"}"#
    );
    assert_eq!(switch_of(&w), "active");
}

/// control.db.test.ts: "gives an ownerless agent an owner, and never takes an agent from its owner".
#[test]
fn fleet_gives_an_ownerless_agent_an_owner_and_never_takes_one_from_its_owner() {
    let w = world_or_skip!();
    fleet_world(&w);
    let door = w.door(fleet_ops(Some(50)));
    let reassign = |reference: &str, owner: &str, request: &str| {
        founder(
            &door,
            FOUNDER_A,
            "reassign",
            &obj(&[
                ("ref", s(reference)),
                ("ownerId", s(owner)),
                ("requestId", s(request)),
            ]),
        )
    };
    data(&reassign("product:support", CUSTOMER, "req-fleet-o1"));
    let read = data(&founder(&door, FOUNDER_A, "registry", &obj(&[])));
    assert_eq!(int(read.get("counts").unwrap(), "ownerless"), 1);
    assert_eq!(text(&row_of(&read, "product:support"), "ownerId"), CUSTOMER);
    assert_eq!(
        refused(&reassign("product:support", FOUNDER_B, "req-fleet-o2")).0,
        "agents.fleet_owner_present"
    );
    assert_eq!(
        refused(&reassign(&format!("own:{OWN}"), FOUNDER_B, "req-fleet-o3")).0,
        "agents.fleet_owner_present"
    );
}
