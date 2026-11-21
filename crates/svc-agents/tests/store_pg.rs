//! The `store` slice against a real Postgres (`TEST_DATABASE_URL_AGENTS` or `TEST_DATABASE_URL`, a server whose admin
//! database name ends in `_test`), each test in its own throwaway database. Without a URL it skips; with
//! `REQUIRE_POSTGRES=1` it fails.
//!
//! The binary's `migrate` up, re-run and `--down` (`scripts/migrate.ts`'s three behaviours), every table `PORT.md`
//! names, the schema check, the boot upsert of the agents' guardrails (and an operator's switch surviving a reboot),
//! each pooled connection's session settings, and `/health` and `/ready` through the kit's server routing.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use std::collections::BTreeMap;
use std::process::Command;
use std::sync::Arc;

use service_kit::json::{self, Json};
use service_kit::server::App;
use svc_agents::boot::{self, SCHEMA_MISSING};
use svc_agents::db;
use svc_agents::door::{AgentsDoor, DoorConfig, ServiceAuth, system_now};
use svc_agents::gateway::Gateway;
use svc_agents::gateway::desk::GatewaySlice;
use svc_agents::gateway::providers::{MockOptions, MockProvider, Provider};
use svc_agents::gateway::readiness::ReadyInput;
use svc_agents::gateway::routing;
use svc_agents::migrate::MIGRATIONS;

mod support;
use support::TestDb;

/// Every table `PORT.md` names, slice by slice.
const TABLES: &[&str] = &[
    "route_overrides",
    "route_change_requests",
    "route_change_audit",
    "usage_records",
    "usage_windows",
    "think_claims",
    "user_spend_limits",
    "spend_limit_requests",
    "spend_reservations",
    "agent_definitions",
    "agent_sessions",
    "agent_actions",
    "agent_transcripts",
    "agent_runs",
    "agent_run_events",
    "agent_place_intents",
    "selected_sessions",
    "session_background_runs",
    "session_background_run_steps",
    "navigator_onchain_bindings",
    "navigator_orders",
    "coach_runs",
    "agent_log_reads",
    "agent_alert_rules",
    "agent_alerts",
    "agent_alert_settings",
    "agent_policy_overrides",
    "agent_fleet_audit",
    "agent_switches",
    "agent_kind_switches",
    "agent_owner_assignments",
    "team_pools",
    "team_pool_allocations",
    "team_projects",
    "team_project_members",
    "team_role_grants",
    "team_sessions",
    "team_held_actions",
    "own_agents",
    "own_agent_versions",
    "own_agent_surfaces",
    "own_agent_rules",
    "own_agent_reviewer_settings",
    "own_agent_reviews",
    "own_agent_eval_cases",
    "own_agent_eval_runs",
    "own_agent_test_runs",
    "own_agent_session_versions",
    "own_agent_approval_requests",
    "own_agent_schedules",
    "own_agent_triggers",
    "own_agent_trigger_deliveries",
    "own_agent_auto_runs",
    "own_agent_background_runs",
    "own_agent_limits",
    "own_agent_usage_limits",
    "own_agent_usage_alerts",
    "own_agent_payment_methods",
    "own_agent_policy_rules",
    "own_agent_policy_settings",
    "own_agent_data_controls",
    "own_agent_memory",
    "own_agent_consents",
    "own_agent_account_access",
    "own_agent_co_owners",
    "own_agent_tokens",
    "self_freezes_applied",
    "run_webhook_endpoints",
    "run_webhook_deliveries",
    "__migrations",
];

#[test]
fn the_binary_applies_every_migration_once_then_skips_them_then_reverses_them() {
    let Some(db) = TestDb::new() else { return };
    let ups: Vec<&str> = MIGRATIONS.ups().into_iter().map(|(n, _)| n).collect();
    assert_eq!(ups.len(), 44);

    let (code, out) = db.binary(false);
    assert_eq!(code, 0, "{out}");
    let applied: Vec<String> = ups.iter().map(|n| format!("↑ {n}")).collect();
    assert_eq!(
        out.lines().collect::<Vec<_>>(),
        [
            applied.iter().map(String::as_str).collect::<Vec<_>>(),
            vec!["✓ migrations up to date"]
        ]
        .concat()
    );
    assert_eq!(db.count("SELECT count(*) FROM agents.__migrations"), 44);
    assert_eq!(TABLES.len(), 70);
    for table in TABLES {
        assert!(
            db.regclass(&format!("agents.{table}")).is_some(),
            "agents.{table} is missing after migrate"
        );
    }

    let (code, out) = db.binary(false);
    assert_eq!(code, 0, "{out}");
    assert_eq!(
        out.lines()
            .filter(|l| l.ends_with("(already applied)"))
            .count(),
        44
    );
    assert_eq!(db.count("SELECT count(*) FROM agents.__migrations"), 44);

    let (code, out) = db.binary(true);
    assert_eq!(code, 0, "{out}");
    assert_eq!(
        out.lines().next(),
        Some("↓ 20261121224407_run_webhooks.down.sql")
    );
    assert_eq!(out.lines().last(), Some("✓ reversed"));
    assert_eq!(db.count("SELECT count(*) FROM agents.__migrations"), 0);
    assert_eq!(
        db.count("SELECT count(*) FROM pg_tables WHERE schemaname = 'agents' AND tablename <> '__migrations'"),
        0,
        "every table the migrations made is gone"
    );
}

#[test]
fn a_database_that_cannot_be_reached_stops_the_runner() {
    let out = Command::new(env!("CARGO_BIN_EXE_svc-agents"))
        .arg("migrate")
        .env("DATABASE_URL", "postgres://nobody:nothing@127.0.0.1:1/none")
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(1));
}

#[test]
fn the_schema_check_refuses_before_the_migrations_and_passes_after() {
    let Some(db) = TestDb::new() else { return };
    let store = db.store();
    assert_eq!(boot::check_schema(&store), Err(SCHEMA_MISSING.to_owned()));
    db.migrated();
    assert_eq!(boot::check_schema(&store), Ok(()));
    store.end();
}

fn definitions(db: &TestDb) -> Vec<(String, i32, Json, bool)> {
    db.client()
        .query(
            "SELECT agent_id, version, guardrail::text, enabled FROM agents.agent_definitions ORDER BY agent_id",
            &[],
        )
        .unwrap()
        .iter()
        .map(|r| {
            (
                r.get(0),
                r.get(1),
                json::parse(&r.get::<_, String>(2)).unwrap(),
                r.get(3),
            )
        })
        .collect()
}

/// A JSON value with every object's keys sorted, as `jsonb` keeps them.
fn sorted(v: &Json) -> Json {
    match v {
        Json::Object(fields) => {
            let mut f: Vec<(String, Json)> =
                fields.iter().map(|(k, v)| (k.clone(), sorted(v))).collect();
            f.sort_by(|a, b| a.0.cmp(&b.0));
            Json::Object(f)
        }
        Json::Array(items) => Json::Array(items.iter().map(sorted).collect()),
        other => other.clone(),
    }
}

#[test]
fn the_boot_upserts_every_agent_and_a_reboot_keeps_an_operators_switch() {
    let Some(db) = TestDb::new() else { return };
    db.migrated();
    let store = db.store();
    let rows = boot::boot_agents().unwrap();
    let written = boot::register_agents(&store, &rows).unwrap();
    assert_eq!(written.len(), 10);

    let mut expected: Vec<(String, i32, Json, bool)> = rows
        .iter()
        .map(|r| {
            (
                r.agent_id.clone(),
                r.version,
                sorted(&r.guardrail),
                r.enabled,
            )
        })
        .collect();
    expected.sort_by(|a, b| a.0.cmp(&b.0));
    let stored: Vec<(String, i32, Json, bool)> = definitions(&db)
        .into_iter()
        .map(|(id, v, g, e)| (id, v, sorted(&g), e))
        .collect();
    assert_eq!(stored, expected);

    // An operator switches the navigator off, and an older guardrail sits on the support row: the reboot replaces the
    // guardrail and its version and keeps the switch.
    db.client()
        .batch_execute(
            "UPDATE agents.agent_definitions SET enabled = false WHERE agent_id = 'navigator';
             UPDATE agents.agent_definitions SET version = 7, guardrail = '{\"agentId\":\"support\",\"old\":true,\"limits\":{},\"tools\":[]}' WHERE agent_id = 'support';
             UPDATE agents.agent_definitions SET enabled = true WHERE agent_id = 'portfolio';",
        )
        .unwrap();
    boot::register_agents(&store, &rows).unwrap();
    let after = definitions(&db);
    let row = |id: &str| after.iter().find(|r| r.0 == id).unwrap().clone();
    assert!(
        !row("navigator").3,
        "the operator's kill survives the reboot"
    );
    assert!(
        row("portfolio").3,
        "an enabled catalogue-only row stays enabled"
    );
    let support = rows.iter().find(|r| r.agent_id == "support").unwrap();
    assert_eq!(row("support").1, support.version);
    assert_eq!(sorted(&row("support").2), sorted(&support.guardrail));
    assert_eq!(
        db.count("SELECT count(*) FROM agents.agent_definitions"),
        10
    );
    store.end();
}

#[test]
fn the_boot_upsert_refuses_on_a_database_without_the_schema() {
    let Some(db) = TestDb::new() else { return };
    let store = db.store();
    let err = boot::register_agents(&store, &boot::boot_agents().unwrap()).unwrap_err();
    assert_eq!(err.code.as_deref(), Some("42P01"), "{err}");
    store.end();
}

#[test]
fn every_pooled_connection_reads_the_agents_schema_first_under_the_services_name() {
    let Some(db) = TestDb::new() else { return };
    db.migrated();
    let store = db.store();
    let pool = store.pool().unwrap();
    let (path, name, table): (String, String, Option<String>) = db::with_client(pool, |c| {
        let r = c.query_one(
            "SELECT current_setting('search_path'), current_setting('application_name'), to_regclass('agent_definitions')::text",
            &[],
        )?;
        Ok((r.get(0), r.get(1), r.get(2)))
    })
    .unwrap();
    assert_eq!(path, "agents,public");
    assert_eq!(name, "svc-agents");
    assert_eq!(table.as_deref(), Some("agent_definitions"));

    // The transaction helper commits on success and rolls back on failure.
    db::transaction(pool, postgres::IsolationLevel::ReadCommitted, |tx| {
        tx.execute(
            "INSERT INTO agent_definitions (agent_id, guardrail) VALUES ('committed', '{\"limits\":{},\"tools\":[]}')",
            &[],
        )?;
        Ok(())
    })
    .unwrap();
    let refused = db::transaction(pool, postgres::IsolationLevel::ReadCommitted, |tx| {
        tx.execute(
            "INSERT INTO agent_definitions (agent_id, guardrail) VALUES ('rolled-back', '{\"limits\":{},\"tools\":[]}')",
            &[],
        )?;
        tx.execute("SELECT 1/0", &[])?;
        Ok(())
    });
    assert_eq!(refused.unwrap_err().code.as_deref(), Some("22012"));
    assert_eq!(
        db.count("SELECT count(*) FROM agents.agent_definitions WHERE agent_id IN ('committed', 'rolled-back')"),
        1
    );
    store.end();
}

#[test]
fn health_answers_as_index_ts_and_ready_reports_the_gateway() {
    let Some(db) = TestDb::new() else { return };
    db.migrated();
    let mock: Arc<dyn Provider> = Arc::new(MockProvider::new(
        MockOptions {
            id: Some("primary".to_owned()),
            ..MockOptions::default()
        },
        system_now,
    ));
    let door = AgentsDoor::new(DoorConfig {
        edge_secret: "placeholder-agents-store-edge-secret-0000".to_owned(),
        services: ServiceAuth::unwired(),
        env: BTreeMap::new(),
        now: system_now,
        store: db.store(),
        gateway: GatewaySlice {
            gateway: Arc::new(Gateway::new(
                vec![mock],
                routing::unpriced(&routing::default_table()),
            )),
            fee_asset_id: "USDC".to_owned(),
            metering_enabled: Some(true),
            window_minutes: 15,
        },
        ready: ReadyInput {
            provider_mode: "mock".to_owned(),
            metering_enabled: true,
            product_agents_registered: 5,
            fleet: Json::Null,
            live_planes: Json::Null,
        },
        metering: svc_agents::metering::Metering::unwired("USDC", 60),
        runtime: svc_agents::runtime::Runtime::unwired(),
        background: svc_agents::background::Settings::default(),
        advisors: svc_agents::advisors::Advisors::unwired(),
        own: svc_agents::own::Own::unwired(),
        team: svc_agents::team::Team::unwired(),
    })
    .unwrap();
    let app = App {
        wire: door,
        service_name: "svc-agents".to_owned(),
        ready_body: String::new(),
    };
    let health = app.route("GET", "/health", &[], "", "req-1");
    assert_eq!(
        (health.status, health.body.as_str()),
        (200, r#"{"ok":true,"service":"svc-agents"}"#)
    );
    let ready = app.route("GET", "/ready", &[], "", "req-2");
    assert_eq!(ready.status, 200);
    let body = json::parse(&ready.body).unwrap();
    assert_eq!(body.get("ready"), Some(&Json::Bool(true)));
    assert_eq!(
        body.get("usefulPath").and_then(|u| u.get("task")),
        Some(&Json::str("navigator.plan"))
    );
    assert!(boot::check_schema(app.wire.store()).is_ok());
    app.wire.end();
}
