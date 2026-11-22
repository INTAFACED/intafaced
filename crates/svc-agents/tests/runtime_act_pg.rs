//! The runtime's `act` (the guarded tool call the navigator slice ported) against a real Postgres
//! (`TEST_DATABASE_URL_AGENTS` or `TEST_DATABASE_URL`, a server whose admin database name ends in `_test`), each test in its own
//! throwaway database migrated by the crate's own runner. Without a URL it skips; with `REQUIRE_POSTGRES=1` it fails.
//!
//! Ported case for case from `services/svc-agents/src/runtime.test.ts`, "guardrails — refused before execution, and logged
//! as refused": every case there that calls `runtime.act`. A tool that throws is an `execute` that returns an error.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::too_many_lines,
    reason = "a test: a failure is the point"
)]

use crate::support;

use std::sync::{Arc, Mutex, mpsc};

use service_kit::json::{self, Json};
use service_kit::pg::Pool;
use support::TestDb;
use svc_agents::audit::{self, Action};
use svc_agents::boot::{BootAgent, register_agents};
use svc_agents::db::Store;
use svc_agents::door::system_now;
use svc_agents::gateway::Gateway;
use svc_agents::gateway::routing::RoutingTable;
use svc_agents::metering::Metering;
use svc_agents::metering::ports::Bus;
use svc_agents::runtime::guardrails::{parse_guardrail, serialise_guardrail};
use svc_agents::runtime::{
    self, ACTION_COMPLETED, ACTION_REJECTED, ActInput, ActResult, Rt, RunError, Runtime,
    SessionRecord,
};

const USER_A: &str = "11111111-1111-4111-8111-111111111111";

const QUOTE: &str = r#"{"name":"trade.quote","module":"trade","mode":"read"}"#;
const ORDER: &str = r#"{"name":"trade.order","module":"trade","mode":"write","maxCallsPerSession":1,"requiresApproval":true}"#;
const PLACE: &str = r#"{"name":"trade.place","module":"trade","mode":"write","maxCallsPerSession":1,"requiresApproval":true}"#;
const CLOSE: &str = r#"{"name":"trade.close","module":"trade","mode":"write"}"#;
const WITHDRAW: &str =
    r#"{"name":"bank.withdraw","module":"bank","mode":"write","requiresApproval":true}"#;

/// `PROBE` with its agent id, version, capacity mode (none: the key left out), tools and modules.
fn guardrail(
    agent_id: &str,
    version: i64,
    mode: Option<&str>,
    tools: &[&str],
    modules: &str,
) -> Json {
    let mode = mode.map_or_else(String::new, |m| format!(r#""capacityMode":"{m}","#));
    json::parse(&format!(
        r#"{{"agentId":"{agent_id}","version":{version},{mode}"tools":[{}],
            "limits":{{"maxActionsPerSession":20,"maxOutputTokensPerCall":256,"maxSpendPerSession":null,
                       "allowedModules":{modules},"allowedTasks":["plan","quick","orphan"]}}}}"#,
        tools.join(",")
    ))
    .unwrap()
}

fn probe() -> Json {
    guardrail(
        "probe",
        1,
        Some("confirm_each"),
        &[QUOTE, ORDER],
        r#"["trade"]"#,
    )
}

/// `MemoryEventBus`: what was published, in order.
#[derive(Default, Clone)]
struct FakeBus(Arc<Mutex<Vec<(String, Json)>>>);

impl FakeBus {
    fn emitted(&self, subject: &str) -> Vec<Json> {
        self.0
            .lock()
            .unwrap()
            .iter()
            .filter(|(s, _)| s == subject)
            .map(|(_, e)| e.get("payload").unwrap().clone())
            .collect()
    }
}

impl Bus for FakeBus {
    fn publish(&self, subject: &str, _msg_id: &str, envelope: &Json) -> Result<(), String> {
        self.0
            .lock()
            .unwrap()
            .push((subject.to_owned(), envelope.clone()));
        Ok(())
    }
}

struct World {
    db: TestDb,
    bus: FakeBus,
    store: Store,
    gateway: Gateway,
    m: Metering,
    rt: Runtime,
}

impl World {
    fn new() -> Option<World> {
        let db = TestDb::new()?;
        let mut sink = Vec::new();
        svc_agents::migrate::run(&db.url, false, &mut sink).unwrap();
        let bus = FakeBus::default();
        let w = World {
            store: db.store(),
            db,
            bus: bus.clone(),
            gateway: Gateway::new(vec![], RoutingTable::default()),
            m: {
                let mut m = Metering::unwired("IFC", 60);
                m.bus = Box::new(bus);
                m
            },
            rt: Runtime::unwired(),
        };
        w.register(&probe());
        Some(w)
    }

    fn pool(&self) -> &Pool {
        self.store.pool().unwrap()
    }

    /// `runtime.registerAgent`.
    fn register(&self, raw: &Json) {
        let g = parse_guardrail(raw).unwrap();
        register_agents(
            &self.store,
            &[BootAgent {
                agent_id: g.agent_id.clone(),
                version: i32::try_from(g.version).unwrap(),
                guardrail: serialise_guardrail(&g),
                enabled: true,
            }],
        )
        .unwrap();
    }

    fn x(&self) -> Rt<'_> {
        Rt {
            rt: &self.rt,
            pool: self.pool(),
            gateway: &self.gateway,
            m: &self.m,
            now: system_now(),
        }
    }

    fn open_as(&self, agent: &str) -> SessionRecord {
        runtime::open_session(&self.x(), USER_A, agent).unwrap()
    }

    fn open(&self) -> SessionRecord {
        self.open_as("probe")
    }

    fn last(&self, session: &str) -> Action {
        audit::for_session(self.pool(), session, 500)
            .unwrap()
            .pop()
            .unwrap()
    }

    fn act(
        &self,
        session: &str,
        tool: &str,
        approved: bool,
        key: Option<&str>,
        execute: impl FnOnce() -> Result<Json, RunError>,
    ) -> Result<ActResult, RunError> {
        runtime::act(
            &self.x(),
            &ActInput {
                session_id: session,
                tool,
                approved: approved.then_some(true),
                idempotency_key: key,
            },
            execute,
        )
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

/// `rejects.toMatchObject({ refusal: { code } })`.
fn refusal(r: Result<ActResult, RunError>) -> String {
    match r {
        Err(RunError::Refused { refusal, .. }) => refusal.code,
        other => panic!("expected a refusal, got {other:?}"),
    }
}

fn ok(v: &str) -> Result<Json, RunError> {
    Ok(Json::str(v))
}

#[test]
fn never_reaches_a_tool_that_is_not_in_the_declared_toolset() {
    let w = world_or_skip!();
    let session = w.open();
    let mut ran = false;
    let r = w.act(&session.id, "bank.withdraw", false, None, || {
        ran = true;
        ok("moved the money")
    });
    assert!(matches!(r, Err(RunError::Refused { .. })), "{r:?}");
    // THE point of a guardrail: the tool did not run.
    assert!(!ran);
    let last = w.last(&session.id);
    assert_eq!(
        (
            last.kind.as_str(),
            last.status.as_str(),
            last.tool.as_deref(),
            last.refusal_code.as_deref()
        ),
        (
            "tool_call",
            "refused",
            Some("bank.withdraw"),
            Some("agents.tool_not_declared")
        )
    );
    // And it is explained.
    assert_eq!(last.user_message_key, "agents.refused.tool_not_declared");
    assert_eq!(
        last.user_message_params.get("tool"),
        Some(&Json::str("bank.withdraw"))
    );
}

#[test]
fn runs_a_declared_tool_and_logs_it() {
    let w = world_or_skip!();
    let session = w.open();
    let price = Json::obj([("price", Json::str("42"))]);
    let r = w
        .act(
            &session.id,
            "trade.quote",
            false,
            None,
            || Ok(price.clone()),
        )
        .unwrap();
    assert_eq!(r.result, price);
    assert_eq!(
        (
            r.action.kind.as_str(),
            r.action.status.as_str(),
            r.action.tool.as_deref()
        ),
        ("tool_call", "executed", Some("trade.quote"))
    );
}

#[test]
fn holds_a_tool_that_needs_approval_then_runs_it_once_the_user_confirms() {
    let w = world_or_skip!();
    let session = w.open();
    assert_eq!(
        refusal(w.act(&session.id, "trade.order", false, None, || ok("placed"))),
        "agents.approval_required"
    );
    let approved = w
        .act(&session.id, "trade.order", true, Some("place-1"), || {
            ok("placed")
        })
        .unwrap();
    assert_eq!(approved.result, Json::str("placed"));
    // A conversational repeat with the same intent key must not place again.
    let mut second = 0;
    let replay = w
        .act(&session.id, "trade.order", true, Some("place-1"), || {
            second += 1;
            ok("placed again")
        })
        .unwrap();
    assert!(replay.replayed);
    assert_eq!(replay.result, Json::str("placed"));
    assert_eq!(second, 0);
    // A new intent still hits the per-session budget of one.
    assert_eq!(
        refusal(
            w.act(&session.id, "trade.order", true, Some("place-2"), || ok(
                "placed again"
            ))
        ),
        "agents.tool_call_limit"
    );
}

#[test]
fn overlapping_places_with_the_same_key_execute_once_and_a_later_retry_returns_that_result() {
    let w = world_or_skip!();
    let session = w.open();
    let (ready_tx, ready_rx) = mpsc::channel();
    let (hold_tx, hold_rx) = mpsc::channel::<()>();
    let mut entered_second = 0;
    let winner = std::thread::scope(|sc| {
        let first = sc.spawn(|| {
            w.act(
                &session.id,
                "trade.order",
                true,
                Some("overlap-place"),
                move || {
                    ready_tx.send(()).unwrap();
                    hold_rx.recv().unwrap();
                    ok("first-place")
                },
            )
        });
        ready_rx
            .recv_timeout(std::time::Duration::from_secs(30))
            .unwrap();
        let second = w.act(
            &session.id,
            "trade.order",
            true,
            Some("overlap-place"),
            || {
                entered_second += 1;
                ok("second-place")
            },
        );
        assert_eq!(refusal(second), "agents.place_key_conflict");
        hold_tx.send(()).unwrap();
        first.join().unwrap().unwrap()
    });
    assert_eq!(entered_second, 0);
    assert_eq!(winner.result, Json::str("first-place"));
    assert!(!winner.replayed);
    let mut third = 0;
    let replay = w
        .act(
            &session.id,
            "trade.order",
            true,
            Some("overlap-place"),
            || {
                third += 1;
                ok("placed again")
            },
        )
        .unwrap();
    assert!(replay.replayed);
    assert_eq!(replay.result, Json::str("first-place"));
    assert_eq!(third, 0);
}

#[test]
fn a_different_place_tool_reusing_the_key_is_refused_by_the_guardrail_and_does_not_receive_the_first_result()
 {
    let w = world_or_skip!();
    let session = w.open();
    w.act(&session.id, "trade.order", true, Some("shared-key"), || {
        ok("order-result")
    })
    .unwrap();
    let mut ran = false;
    let r = w.act(&session.id, "trade.place", true, Some("shared-key"), || {
        ran = true;
        ok("place-result")
    });
    assert_eq!(refusal(r), "agents.tool_not_declared");
    assert!(!ran);
}

#[test]
fn a_different_place_tool_the_guardrail_would_allow_still_does_not_place() {
    let w = world_or_skip!();
    w.register(&guardrail(
        "both-place",
        1,
        Some("confirm_each"),
        &[ORDER, PLACE],
        r#"["trade"]"#,
    ));
    let session = w.open_as("both-place");
    w.act(&session.id, "trade.order", true, Some("shared-key"), || {
        ok("order-result")
    })
    .unwrap();
    let mut unapproved = false;
    let r = w.act(
        &session.id,
        "trade.place",
        false,
        Some("shared-key"),
        || {
            unapproved = true;
            ok("place-result")
        },
    );
    assert_eq!(refusal(r), "agents.approval_required");
    assert!(!unapproved);
    let mut ran = false;
    let r = w.act(&session.id, "trade.place", true, Some("shared-key"), || {
        ran = true;
        ok("place-result")
    });
    assert_eq!(refusal(r), "agents.place_key_conflict");
    assert!(!ran);
}

#[test]
fn a_failed_place_releases_the_key_so_one_later_retry_can_place() {
    let w = world_or_skip!();
    let session = w.open();
    let mut calls = 0;
    let failed = w.act(
        &session.id,
        "trade.order",
        true,
        Some("retry-place"),
        || {
            calls += 1;
            Err(RunError::Other("venue rejected".to_owned()))
        },
    );
    assert!(
        matches!(&failed, Err(RunError::Other(m)) if m == "venue rejected"),
        "{failed:?}"
    );
    let placed = w
        .act(
            &session.id,
            "trade.order",
            true,
            Some("retry-place"),
            || {
                calls += 1;
                ok("placed-after-failure")
            },
        )
        .unwrap();
    assert_eq!(placed.result, Json::str("placed-after-failure"));
    assert!(!placed.replayed);
    assert_eq!(calls, 2);
    let mut again = 0;
    let replay = w
        .act(
            &session.id,
            "trade.order",
            true,
            Some("retry-place"),
            || {
                again += 1;
                ok("placed twice")
            },
        )
        .unwrap();
    assert!(replay.replayed);
    assert_eq!(replay.result, Json::str("placed-after-failure"));
    assert_eq!(again, 0);
}

#[test]
fn research_only_never_reaches_place_even_when_the_tool_is_granted_and_approved() {
    let w = world_or_skip!();
    w.register(&guardrail(
        "research",
        1,
        Some("research_only"),
        &[QUOTE, ORDER],
        r#"["trade"]"#,
    ));
    let session = w.open_as("research");
    let mut ran = false;
    let r = w.act(
        &session.id,
        "trade.order",
        true,
        Some("chat-repeat"),
        || {
            ran = true;
            ok("placed")
        },
    );
    assert_eq!(refusal(r), "agents.mode_forbids_write");
    assert!(!ran);
}

#[test]
fn an_unknown_capacity_mode_refuses_live_writes_rather_than_defaulting_to_live() {
    let w = world_or_skip!();
    w.register(&guardrail(
        "no-mode",
        1,
        None,
        &[QUOTE, ORDER],
        r#"["trade"]"#,
    ));
    let session = w.open_as("no-mode");
    let mut ran = false;
    let r = w.act(&session.id, "trade.order", true, Some("k"), || {
        ran = true;
        ok("placed")
    });
    assert_eq!(refusal(r), "agents.mode_unknown");
    assert!(!ran);
}

#[test]
fn refuses_bank_withdraw_without_a_separate_withdraw_scope_even_when_granted() {
    let w = world_or_skip!();
    w.register(&guardrail(
        "cashier",
        1,
        Some("confirm_each"),
        &[QUOTE, ORDER, WITHDRAW],
        r#"["trade","bank"]"#,
    ));
    let session = w.open_as("cashier");
    let mut ran = false;
    let r = w.act(&session.id, "bank.withdraw", true, None, || {
        ran = true;
        ok("sent")
    });
    assert_eq!(refusal(r), "agents.withdraw_scope_required");
    assert!(!ran);
}

#[test]
fn binds_the_guardrail_at_session_open_widening_it_later_does_not_reach_a_running_session() {
    let w = world_or_skip!();
    let session = w.open();
    // The agent gains a tool while the session is in flight.
    w.register(&guardrail(
        "probe",
        2,
        Some("confirm_each"),
        &[QUOTE, ORDER, CLOSE],
        r#"["trade"]"#,
    ));
    assert_eq!(
        refusal(w.act(&session.id, "trade.close", false, None, || ok("closed"))),
        "agents.tool_not_declared"
    );
    // A NEW session picks the widened guardrail up.
    let next = w.open();
    assert_eq!(next.guardrail_version, 2);
    assert!(
        w.act(&next.id, "trade.close", false, None, || ok("closed"))
            .is_ok()
    );
}

#[test]
fn logs_a_tool_that_threw_as_failed_not_as_refused() {
    let w = world_or_skip!();
    let session = w.open();
    let r = w.act(&session.id, "trade.quote", false, None, || {
        Err(RunError::Other("venue unreachable".to_owned()))
    });
    assert!(
        matches!(&r, Err(RunError::Other(m)) if m == "venue unreachable"),
        "{r:?}"
    );
    let last = w.last(&session.id);
    assert_eq!(
        (
            last.kind.as_str(),
            last.status.as_str(),
            last.refusal_code.as_deref()
        ),
        ("tool_call", "failed", None)
    );
}

// ── agent_actions — the Agentic Law (§8.2), and the events: the cases that run `act` ─────────────────────────────

fn kinds(w: &World, session: &str) -> Vec<String> {
    audit::for_session(w.pool(), session, 500)
        .unwrap()
        .iter()
        .map(|a| format!("{}:{}", a.kind, a.status))
        .collect()
}

/// runtime.test.ts, "agent_actions": "records every action, including the ones that were refused". This world has no
/// engine, so the TypeScript's opening completion is left out (`runtime_think_pg.rs` proves it); every other row is
/// the TypeScript's.
#[test]
fn records_every_action_including_the_ones_that_were_refused() {
    let w = world_or_skip!();
    let session = w.open();
    w.act(&session.id, "trade.quote", false, None, || ok("ok"))
        .unwrap();
    let _ = w
        .act(&session.id, "bank.withdraw", false, None, || ok("ok"))
        .unwrap_err();
    runtime::close_session(&w.x(), &session.id).unwrap();
    assert_eq!(
        kinds(&w, &session.id),
        [
            "session_open:executed",
            "tool_call:executed",
            "tool_call:refused",
            "session_close:executed"
        ]
    );
    // Dense sequence: a gap would mean an action went unrecorded.
    let log = audit::for_session(w.pool(), &session.id, 500).unwrap();
    assert_eq!(
        log.iter().map(|a| a.sequence).collect::<Vec<_>>(),
        [0, 1, 2, 3]
    );
}

fn append_only(w: &World, sql: &str, session: &str) {
    let e = w.db.client().execute(sql, &[&session]).unwrap_err();
    let text = e
        .as_db_error()
        .map_or_else(|| e.to_string(), |d| d.message().to_owned());
    assert!(text.contains("append-only"), "{text}");
}

/// runtime.test.ts, "agent_actions": "is append-only — an UPDATE is rejected by the database".
#[test]
fn is_append_only_an_update_of_a_tool_call_is_rejected_by_the_database() {
    let w = world_or_skip!();
    let session = w.open();
    w.act(&session.id, "trade.quote", false, None, || ok("ok"))
        .unwrap();
    append_only(
        &w,
        "UPDATE agents.agent_actions SET status = 'executed' WHERE session_id = $1::text::uuid",
        &session.id,
    );
}

/// runtime.test.ts, "agent_actions": "is append-only — a DELETE is rejected by the database".
#[test]
fn is_append_only_a_delete_of_a_refused_tool_call_is_rejected_by_the_database() {
    let w = world_or_skip!();
    let session = w.open();
    let _ = w
        .act(&session.id, "bank.withdraw", false, None, || ok("ok"))
        .unwrap_err();
    // The row a bad actor would most want gone.
    append_only(
        &w,
        "DELETE FROM agents.agent_actions WHERE session_id = $1::text::uuid AND status = 'refused'",
        &session.id,
    );
    assert!(
        audit::for_session(w.pool(), &session.id, 500)
            .unwrap()
            .iter()
            .any(|a| a.status == "refused")
    );
}

/// runtime.test.ts, "events (§10)": "publishes a completed action, a rejected action, and a settled window": its
/// completed and rejected actions, with the rejected one an `act` on an undeclared tool as there. The settled window
/// needs an engine: `runtime_think_pg.rs` proves it.
#[test]
fn publishes_a_completed_tool_call_and_a_rejected_one_naming_the_tool() {
    let w = world_or_skip!();
    let session = w.open();
    w.act(&session.id, "trade.quote", false, None, || ok("ok"))
        .unwrap();
    let _ = w
        .act(&session.id, "bank.withdraw", false, None, || ok("ok"))
        .unwrap_err();
    assert!(!w.bus.emitted(ACTION_COMPLETED).is_empty());
    let rejected = &w.bus.emitted(ACTION_REJECTED)[0];
    assert_eq!(
        rejected.get("refusalCode"),
        Some(&Json::str("agents.tool_not_declared"))
    );
    assert_eq!(rejected.get("tool"), Some(&Json::str("bank.withdraw")));
}
