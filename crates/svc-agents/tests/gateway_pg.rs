//! The gateway slice against a real Postgres: `services/svc-agents/src/gateway/route-changes.db.test.ts`, case for
//! case, through the Rust door with a signed principal (each test in its own throwaway database; see `support`).
//!
//! The routing table changed by two founders (J-agents-20): the desk reads each task with its provider and model alias
//! from configuration; one founder's change stays pending and the table does not move; a second founder confirms it
//! once, with one audit row naming both; a rate change waits for the next usage window; blank rates make a route
//! unpriced; and a change to no route, one rate without the other, or a change that changes nothing is refused.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

mod support;

use std::cell::Cell;
use std::collections::BTreeMap;
use std::sync::Arc;

use service_kit::edge;
use service_kit::json::{self, Json};
use service_kit::money::parse_amount;
use service_kit::server::Request;
use service_kit::time::{Instant, js_date};
use support::TestDb;
use svc_agents::door::{AgentsDoor, DoorConfig, ServiceAuth};
use svc_agents::gateway::Gateway;
use svc_agents::gateway::changes::read_overrides;
use svc_agents::gateway::desk::GatewaySlice;
use svc_agents::gateway::readiness::ReadyInput;
use svc_agents::gateway::routing::{Price, RoutingTable, parse_routing_table};

const SECRET: &str = "an-agents-route-changes-test-secret-32";
const FOUNDER_A: &str = "44444444-4444-4444-8444-444444444444";
const FOUNDER_B: &str = "66666666-6666-4666-8666-666666666666";
const CUSTOMER: &str = "11111111-1111-4111-8111-111111111111";
const FOUNDER: &[&str] = &["admin:read", "admin:write"];

thread_local! {
    /// The test's clock: each test runs on its own thread, and the door asks the clock on the thread that calls it.
    static NOW: Cell<i64> = const { Cell::new(0) };
}

fn clock() -> Instant {
    Instant(NOW.with(Cell::get))
}

fn set_now(iso: &str) {
    NOW.with(|n| n.set(js_date(iso).unwrap().0));
}

fn configured() -> RoutingTable {
    parse_routing_table(
        r#"{"routes":[
          {"task":"index.embed","providerId":"primary","model":"embed-sm","maxOutputTokens":1,"price":{"inputPerMillion":"0.1","outputPerMillion":"0"},"capability":"embed"},
          {"task":"own.run","providerId":"primary","model":"reasoning-md","maxOutputTokens":2048,"price":{"inputPerMillion":"1","outputPerMillion":"5"}}
        ]}"#,
    )
    .unwrap()
}

struct Desk {
    _db: TestDb,
    door: AgentsDoor,
    db_url: String,
    n: Cell<u32>,
}

impl Desk {
    fn new() -> Option<Desk> {
        let db = TestDb::new()?;
        db.migrated();
        set_now("2026-11-16T10:07:00.000Z");
        let env: BTreeMap<String, String> = [
            ("APP_ENV", "test"),
            ("INTAFACED_SCREENING_FAIL_CLOSED", "off"),
            ("NODE_ENV", "test"),
            ("INTAFACED_UNSIGNED_SANCTIONS_ROWS", "off"),
        ]
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect();
        let door = AgentsDoor::new(DoorConfig {
            edge_secret: SECRET.to_owned(),
            services: ServiceAuth::unwired(),
            env,
            now: clock,
            store: db.store(),
            gateway: GatewaySlice {
                gateway: Arc::new(Gateway::new(Vec::new(), configured())),
                fee_asset_id: "USDC".to_owned(),
                metering_enabled: Some(true),
                window_minutes: 15,
            },
            ready: ReadyInput::unwired(),
            metering: svc_agents::metering::Metering::unwired("USDC", 15),
            runtime: svc_agents::runtime::Runtime::unwired(),
            ops: svc_agents::ops::Ops::unwired(),
        })
        .unwrap();
        door.gateway().refresh(door.store()).unwrap();
        Some(Desk {
            db_url: db.url.clone(),
            _db: db,
            door,
            n: Cell::new(0),
        })
    }

    fn rid(&self) -> String {
        self.n.set(self.n.get() + 1);
        format!("test-route-change-{}", self.n.get())
    }

    /// One call as `user` with `scopes` (a key when `kid` is set); the status and the parsed answer.
    fn call_as(
        &self,
        user: &str,
        scopes: &[&str],
        kid: Option<&str>,
        path: &str,
        input: Option<&Json>,
    ) -> (u16, Json) {
        let mut fields = vec![
            ("sub", Json::str(user)),
            ("userId", Json::str(user)),
            ("sid", Json::str("55555555-5555-4555-8555-555555555555")),
            (
                "scopes",
                Json::Array(scopes.iter().map(|s| Json::str(*s)).collect()),
            ),
            ("tier", Json::str("none")),
            ("mfa", Json::Bool(true)),
            ("expiresAt", Json::str("2099-01-01T00:00:00.000Z")),
        ];
        if let Some(kid) = kid {
            fields.push(("kid", Json::str(kid)));
        }
        let raw =
            Json::Object(fields.into_iter().map(|(k, v)| (k.to_owned(), v)).collect()).compact();
        let mut headers = vec![
            (
                "x-intafaced-principal-sig".to_owned(),
                edge::sign(&raw, SECRET, "DE").unwrap(),
            ),
            ("x-intafaced-principal".to_owned(), raw),
            ("x-intafaced-region".to_owned(), "DE".to_owned()),
        ];
        let query = path == "routes.desk" || path == "routes.list";
        let (method, url, body) = if query {
            ("GET", format!("/trpc/{path}"), String::new())
        } else {
            headers.push(("content-type".to_owned(), "application/json".to_owned()));
            (
                "POST",
                format!("/trpc/{path}"),
                input.map_or(String::new(), Json::compact),
            )
        };
        let res = self.door.handle(&Request {
            method,
            url: &url,
            headers: &headers,
            body: &body,
        });
        (res.status, json::parse(&res.body).unwrap())
    }

    /// A founder's call: its data, or a panic naming the refusal.
    fn ok(&self, user: &str, path: &str, input: Option<&Json>) -> Json {
        let (status, body) = self.call_as(user, FOUNDER, None, path, input);
        assert_eq!(status, 200, "{path}: {}", body.compact());
        body.get("result")
            .and_then(|r| r.get("data"))
            .unwrap()
            .clone()
    }

    /// A founder's call refused: its status and message.
    fn refused(&self, user: &str, path: &str, input: &Json) -> (u16, String) {
        let (status, body) = self.call_as(user, FOUNDER, None, path, Some(input));
        assert_ne!(status, 200, "{path} was not refused");
        let message = body.get("error").and_then(|e| e.get("message")).unwrap();
        let Json::String(m) = message else {
            panic!("no message")
        };
        (status, m.clone())
    }

    fn propose(
        &self,
        user: &str,
        task: &str,
        ceiling: i64,
        i: Option<&str>,
        o: Option<&str>,
        rid: &str,
    ) -> Json {
        let input = proposal(task, ceiling, i, o, rid);
        self.ok(user, "routes.propose", Some(&input))
    }

    fn row(&self, task: &str) -> Json {
        let desk = self.ok(FOUNDER_A, "routes.desk", None);
        let Some(Json::Array(routes)) = desk.get("routes") else {
            panic!("no routes")
        };
        routes
            .iter()
            .find(|r| r.get("task") == Some(&Json::str(task)))
            .unwrap()
            .clone()
    }

    fn table_route(&self, task: &str) -> svc_agents::gateway::routing::Route {
        self.door
            .gateway()
            .gateway
            .routing_table(clock())
            .routes
            .into_iter()
            .find(|r| r.task == task)
            .unwrap()
    }

    fn client(&self) -> postgres::Client {
        postgres::Client::connect(&self.db_url, postgres::NoTls).unwrap()
    }
}

fn proposal(task: &str, ceiling: i64, i: Option<&str>, o: Option<&str>, rid: &str) -> Json {
    let rate = |v: Option<&str>| v.map_or(Json::Null, Json::str);
    Json::obj([
        ("task", Json::str(task)),
        ("maxOutputTokens", Json::int(ceiling)),
        ("inputPerMillion", rate(i)),
        ("outputPerMillion", rate(o)),
        ("requestId", Json::str(rid)),
    ])
}

fn id_of(change: &Json) -> Json {
    Json::obj([("changeId", change.get("id").unwrap().clone())])
}

fn field<'a>(v: &'a Json, k: &str) -> &'a Json {
    v.get(k).unwrap_or(&Json::Null)
}

fn price(i: &str, o: &str) -> Option<Price> {
    Some(Price {
        input_per_million: parse_amount(i).unwrap(),
        output_per_million: parse_amount(o).unwrap(),
    })
}

#[test]
fn n1_the_desk_reads_each_task_with_its_provider_and_model_alias_from_configuration_and_its_rates()
{
    let Some(d) = Desk::new() else { return };
    let desk = d.ok(FOUNDER_A, "routes.desk", None);
    let Some(Json::Array(routes)) = desk.get("routes") else {
        panic!()
    };
    let rows: Vec<Vec<Json>> = routes
        .iter()
        .map(|r| {
            [
                "task",
                "providerId",
                "model",
                "providerSource",
                "inputPerMillion",
                "outputPerMillion",
            ]
            .iter()
            .map(|k| field(r, k).clone())
            .collect()
        })
        .collect();
    let s = Json::str;
    assert_eq!(
        rows,
        vec![
            vec![
                s("index.embed"),
                s("primary"),
                s("embed-sm"),
                s("configuration"),
                s("0.1"),
                s("0")
            ],
            vec![
                s("own.run"),
                s("primary"),
                s("reasoning-md"),
                s("configuration"),
                s("1"),
                s("5")
            ],
        ]
    );
    assert_eq!(desk.get("audit"), Some(&Json::Array(Vec::new())));
}

#[test]
fn the_desk_refuses_a_customer_session_and_a_key() {
    let Some(d) = Desk::new() else { return };
    let (status, _) = d.call_as(CUSTOMER, &["agents:read"], None, "routes.desk", None);
    assert_eq!(status, 403);
    // A key is refused before the desk's own check: `admin:read` is for an interactive session only.
    let (status, body) = d.call_as(FOUNDER_A, FOUNDER, Some("key-1"), "routes.desk", None);
    assert_eq!(status, 403);
    assert_eq!(
        body.get("error")
            .and_then(|e| e.get("data"))
            .and_then(|e| e.get("intafacedCode")),
        Some(&Json::str("scope.interactive_only"))
    );
}

#[test]
fn n2_one_founders_change_stays_pending_and_the_table_does_not_move_they_may_withdraw_it() {
    let Some(d) = Desk::new() else { return };
    let change = d.propose(
        FOUNDER_A,
        "index.embed",
        2,
        Some("0.1"),
        Some("0"),
        &d.rid(),
    );
    assert_eq!(field(&change, "status"), &Json::str("pending"));
    let r = d.row("index.embed");
    assert_eq!(field(&r, "maxOutputTokens"), &Json::int(1));
    let pending = field(&r, "pending");
    assert_eq!(field(pending, "id"), field(&change, "id"));
    assert_eq!(field(pending, "proposedBy"), &Json::str(FOUNDER_A));
    assert_eq!(field(pending, "maxOutputTokens"), &Json::int(2));
    assert_eq!(d.table_route("index.embed").max_output_tokens, 1);
    // A second change of the same task waits for the first to be decided.
    let second = proposal("index.embed", 3, Some("0.1"), Some("0"), &d.rid());
    assert_eq!(
        d.refused(FOUNDER_B, "routes.propose", &second),
        (409, "agents.route_change_pending".to_owned())
    );
    // The same founder cannot confirm their own change; another founder cannot withdraw it.
    assert_eq!(
        d.refused(FOUNDER_A, "routes.confirm", &id_of(&change)),
        (403, "agents.route_change_same_founder".to_owned())
    );
    assert_eq!(
        d.refused(FOUNDER_B, "routes.withdraw", &id_of(&change)),
        (403, "agents.route_change_not_yours".to_owned())
    );
    let withdrawn = d.ok(FOUNDER_A, "routes.withdraw", Some(&id_of(&change)));
    assert_eq!(field(&withdrawn, "status"), &Json::str("withdrawn"));
    assert_eq!(field(&d.row("index.embed"), "pending"), &Json::Null);
    assert_eq!(
        d.refused(FOUNDER_B, "routes.confirm", &id_of(&change)),
        (409, "agents.route_change_not_pending".to_owned())
    );
    assert_eq!(read_overrides(&mut d.client()).unwrap(), Vec::new());
}

#[test]
fn a_retried_proposal_lands_on_the_same_row_and_the_same_request_id_for_another_change_is_refused()
{
    let Some(d) = Desk::new() else { return };
    let rid = d.rid();
    let first = d.propose(FOUNDER_A, "index.embed", 2, Some("0.1"), Some("0"), &rid);
    let again = d.propose(FOUNDER_A, "index.embed", 2, Some("0.1"), Some("0"), &rid);
    assert_eq!(field(&again, "id"), field(&first, "id"));
    assert_eq!(
        d.refused(
            FOUNDER_A,
            "routes.propose",
            &proposal("index.embed", 9, Some("0.1"), Some("0"), &rid)
        ),
        (409, "agents.route_change_request_reused".to_owned())
    );
    let n: i64 = d
        .client()
        .query_one(
            "SELECT count(*) FROM agents.route_change_audit WHERE action = 'propose'",
            &[],
        )
        .unwrap()
        .get(0);
    assert_eq!(n, 1);
}

#[test]
fn n3_a_second_founder_confirms_the_table_changes_once_with_one_audit_row_naming_both() {
    let Some(d) = Desk::new() else { return };
    let change = d.propose(
        FOUNDER_A,
        "index.embed",
        2,
        Some("0.1"),
        Some("0"),
        &d.rid(),
    );
    let applied = d.ok(FOUNDER_B, "routes.confirm", Some(&id_of(&change)));
    assert_eq!(field(&applied, "status"), &Json::str("applied"));
    assert_eq!(field(&applied, "proposedBy"), &Json::str(FOUNDER_A));
    assert_eq!(field(&applied, "confirmedBy"), &Json::str(FOUNDER_B));
    // Pressed again, it answers what was applied and changes nothing.
    let again = d.ok(FOUNDER_B, "routes.confirm", Some(&id_of(&change)));
    assert_eq!(field(&again, "status"), &Json::str("applied"));
    assert_eq!(d.table_route("index.embed").max_output_tokens, 2);
    let r = d.row("index.embed");
    assert_eq!(field(&r, "maxOutputTokens"), &Json::int(2));
    let last = field(&r, "lastChange");
    assert_eq!(field(last, "proposedBy"), &Json::str(FOUNDER_A));
    assert_eq!(field(last, "confirmedBy"), &Json::str(FOUNDER_B));
    let confirms = d
        .client()
        .query(
            "SELECT operator_id, proposed_by, before::text, after::text FROM agents.route_change_audit WHERE action = 'confirm'",
            &[],
        )
        .unwrap();
    assert_eq!(confirms.len(), 1);
    let c = &confirms[0];
    assert_eq!(
        (c.get::<_, String>(0), c.get::<_, String>(1)),
        (FOUNDER_B.to_owned(), FOUNDER_A.to_owned())
    );
    let snap = |text: String| {
        let v = json::parse(&text).unwrap();
        (
            field(&v, "maxOutputTokens").clone(),
            field(&v, "inputPerMillion").clone(),
            field(&v, "outputPerMillion").clone(),
        )
    };
    assert_eq!(
        snap(c.get(2)),
        (Json::int(1), Json::str("0.1"), Json::str("0"))
    );
    assert_eq!(
        snap(c.get(3)),
        (Json::int(2), Json::str("0.1"), Json::str("0"))
    );
    // The desk's audit answers both rows, newest first, each in the contract's key order.
    let desk = d.ok(FOUNDER_A, "routes.desk", None);
    let Some(Json::Array(audit)) = desk.get("audit") else {
        panic!()
    };
    assert_eq!(audit.len(), 2);
    assert_eq!(field(&audit[0], "action"), &Json::str("confirm"));
    assert_eq!(
        field(&audit[0], "before").compact(),
        r#"{"maxOutputTokens":1,"inputPerMillion":"0.1","outputPerMillion":"0"}"#
    );
    // A restart reads the change again over the configured table.
    let restarted = GatewaySlice {
        gateway: Arc::new(Gateway::new(Vec::new(), configured())),
        fee_asset_id: "USDC".to_owned(),
        metering_enabled: Some(true),
        window_minutes: 15,
    };
    restarted.refresh(d.door.store()).unwrap();
    let route = restarted
        .gateway
        .routing_table(clock())
        .routes
        .into_iter()
        .find(|r| r.task == "index.embed")
        .unwrap();
    assert_eq!(route.max_output_tokens, 2);
}

#[test]
fn a_rate_change_affects_only_future_windows_the_open_window_keeps_the_rate_in_force_when_it_was_confirmed()
 {
    let Some(d) = Desk::new() else { return };
    let change = d.propose(FOUNDER_A, "own.run", 2048, Some("2"), Some("6"), &d.rid());
    d.ok(FOUNDER_B, "routes.confirm", Some(&id_of(&change)));
    assert_eq!(d.table_route("own.run").price, price("1", "5"));
    let r = d.row("own.run");
    assert_eq!(field(&r, "inputPerMillion"), &Json::str("1"));
    assert_eq!(
        field(&r, "nextRate").compact(),
        r#"{"inputPerMillion":"2","outputPerMillion":"6","from":"2026-11-16T10:15:00.000Z"}"#
    );
    set_now("2026-11-16T10:15:00.000Z");
    d.door.gateway().refresh(d.door.store()).unwrap();
    assert_eq!(d.table_route("own.run").price, price("2", "6"));
    assert_eq!(field(&d.row("own.run"), "nextRate"), &Json::Null);
}

#[test]
fn blank_rates_make_the_route_unpriced() {
    let Some(d) = Desk::new() else { return };
    let change = d.propose(FOUNDER_A, "own.run", 2048, None, None, &d.rid());
    d.ok(FOUNDER_B, "routes.confirm", Some(&id_of(&change)));
    set_now("2026-11-16T10:15:00.000Z");
    d.door.gateway().refresh(d.door.store()).unwrap();
    assert_eq!(d.table_route("own.run").price, None);
    assert_eq!(field(&d.row("own.run"), "inputPerMillion"), &Json::Null);
    // `routes.list` says the same: no rate, so its metered runs refuse.
    let (status, list) = d.call_as(CUSTOMER, &["agents:read"], None, "routes.list", None);
    assert_eq!(status, 200);
    let list = list
        .get("result")
        .and_then(|r| r.get("data"))
        .unwrap()
        .clone();
    let Json::Array(rows) = list else { panic!() };
    let own = rows
        .iter()
        .find(|r| field(r, "task") == &Json::str("own.run"))
        .unwrap();
    assert_eq!(field(own, "outputPerMillion"), &Json::Null);
    assert_eq!(field(own, "metered"), &Json::Bool(false));
}

#[test]
fn refuses_a_change_to_no_route_one_rate_without_the_other_and_a_change_that_changes_nothing() {
    let Some(d) = Desk::new() else { return };
    assert_eq!(
        d.refused(
            FOUNDER_A,
            "routes.propose",
            &proposal("no.route", 2, Some("0.1"), Some("0"), &d.rid())
        ),
        (404, "agents.route_not_found".to_owned())
    );
    assert_eq!(
        d.refused(
            FOUNDER_A,
            "routes.propose",
            &proposal("index.embed", 2, Some("0.1"), None, &d.rid())
        ),
        (400, "agents.route_change_invalid".to_owned())
    );
    assert_eq!(
        d.refused(
            FOUNDER_A,
            "routes.propose",
            &proposal("index.embed", 1, Some("0.10"), Some("0"), &d.rid())
        ),
        (409, "agents.route_change_unchanged".to_owned())
    );
    // Nothing was written by any of them.
    let n: i64 = d
        .client()
        .query_one("SELECT count(*) FROM agents.route_change_requests", &[])
        .unwrap()
        .get(0);
    assert_eq!(n, 0);
}
