//! Copy-Intel's metered stats run (`copyIntel.runSession`) on the real runtime against a real Postgres
//! (`TEST_DATABASE_URL_AGENTS` or `TEST_DATABASE_URL`, a server whose admin database name ends in `_test`), each test in
//! its own throwaway database migrated by the crate's own runner, the factories' guardrails upserted as the boot does.
//! Without a URL it skips; with `REQUIRE_POSTGRES=1` it fails.
//!
//! The cases of `services/svc-agents/src/copy-intel/session-run.test.ts` and `run-session-route.test.ts`, each test
//! naming its source. The TypeScript runs them on a fake runtime; here they run on `svc_agents::runtime` (sessions,
//! `act` under the guardrail bound at open, the action log, the meter's settle and the close), so "no session opened"
//! is read from `agents.agent_sessions` and "the tools called" from `agents.agent_actions`. The TypeScript's injected
//! settlements are a real window here: a trigger gives each Copy-Intel session one usage record costing 1.25, which
//! the meter settles through a ledger double; its injected close failure is a trigger refusing the close. The owner's
//! live plane is handed in as the TypeScript's `process.env` holds it in each case. Past the TypeScript's cases, the
//! open plane's own paths run end to end: the ok board, the guardrail refusing reads and writes, and the build's
//! refusals inside a session.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::too_many_lines,
    reason = "a test: a failure is the point"
)]

mod support;

use std::cell::Cell;
use std::sync::{Arc, Mutex};

use service_kit::json::{self, Json};
use service_kit::time::Instant;
use support::TestDb;
use svc_agents::audit::{self, Action};
use svc_agents::boot::{BootAgent, boot_agents, register_agents};
use svc_agents::db::Store;
use svc_agents::door::system_now;
use svc_agents::factories::copy_intel::{LeaderFixtures, LivePlane, RunInput, run_session};
use svc_agents::gateway::Gateway;
use svc_agents::gateway::routing::parse_routing_table;
use svc_agents::metering::Metering;
use svc_agents::metering::ports::{Bus, Ledger, LedgerError, Recipe};
use svc_agents::runtime::guardrails::{parse_guardrail, serialise_guardrail};
use svc_agents::runtime::{Rt, RunError, Runtime};

const USER: &str = "11111111-1111-4111-8111-111111111111";
const FEE: &str = "IFC";
/// `NOW`.
const NOW: Instant = Instant(1_786_104_000_000);

/// `fixture(leaderId, overrides)`.
fn fixture(leader: &str, over: &str) -> Json {
    let base = format!(
        r#"{{"leaderId":"{leader}","realisedPnl":"12.5","closedTrades":10,"winningTrades":6,
            "windowStart":"2026-08-01T00:00:00.000Z","windowEnd":"2026-08-07T00:00:00.000Z","source":"platform-fills"}}"#
    );
    let mut row = json::parse(&base).unwrap();
    if !over.is_empty() {
        let Json::Object(extra) = json::parse(over).unwrap() else {
            panic!("an object")
        };
        let Json::Object(fields) = &mut row else {
            unreachable!()
        };
        for (k, v) in extra {
            match fields.iter_mut().find(|(f, _)| *f == k) {
                Some(slot) => slot.1 = v,
                None => fields.push((k, v)),
            }
        }
    }
    row
}

fn ids(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| (*s).to_owned()).collect()
}

/// `process.env` as each case sets it: closed, or open on `leader-a` (and any others named).
fn closed() -> LivePlane {
    LivePlane::default()
}
fn open(list: &[&str]) -> LivePlane {
    LivePlane {
        open: true,
        ids: ids(list),
    }
}

/// `{ sample: async () => rows }`, or a port that throws.
struct Rows(Result<Vec<Json>, String>);
impl LeaderFixtures for Rows {
    fn sample(&self) -> Result<Vec<Json>, String> {
        self.0.clone()
    }
}

/// A ledger that books each key once and keeps what it booked (`chargedAmounts`).
#[derive(Default, Clone)]
struct Book(Arc<Mutex<Vec<Recipe>>>);
impl Ledger for Book {
    fn post_recipe(&self, recipe: &Recipe) -> Result<String, LedgerError> {
        let mut b = self.0.lock().unwrap();
        let key = recipe.idempotency_key();
        if let Some(i) = b.iter().position(|r| r.idempotency_key() == key) {
            return Ok(format!("tx-{}", i + 1));
        }
        b.push(recipe.clone());
        Ok(format!("tx-{}", b.len()))
    }
}

#[derive(Default, Clone)]
struct Events(Arc<Mutex<Vec<String>>>);
impl Bus for Events {
    fn publish(&self, subject: &str, _msg_id: &str, _envelope: &Json) -> Result<(), String> {
        self.0.lock().unwrap().push(subject.to_owned());
        Ok(())
    }
}

struct World {
    db: TestDb,
    store: Store,
    book: Book,
    gateway: Gateway,
    m: Metering,
    rt: Runtime,
}

impl World {
    fn new() -> Option<World> {
        let db = TestDb::new()?;
        let mut sink = Vec::new();
        svc_agents::migrate::run(&db.url, false, &mut sink).unwrap();
        let store = db.store();
        register_agents(&store, &boot_agents().unwrap()).unwrap();
        let book = Book::default();
        let mut m = Metering::unwired(FEE, 60);
        m.enabled = true;
        m.ledger = Box::new(book.clone());
        m.bus = Box::new(Events::default());
        Some(World {
            db,
            store,
            book,
            gateway: Gateway::new(Vec::new(), parse_routing_table(
                r#"{"routes":[{"task":"copy_intel.stats","providerId":"primary","model":"fast-sm","maxOutputTokens":64,"price":{"inputPerMillion":"1","outputPerMillion":"0"}}]}"#,
            )
            .unwrap()),
            m,
            rt: Runtime::unwired(),
        })
    }

    fn x(&self) -> Rt<'_> {
        Rt {
            rt: &self.rt,
            pool: self.store.pool().unwrap(),
            gateway: &self.gateway,
            m: &self.m,
            now: system_now(),
        }
    }

    /// The run as the router hands it in, counting whether the runtime was asked for (`openCalls`).
    fn run(
        &self,
        input: &RunInput<'_>,
        port: Option<&dyn LeaderFixtures>,
        live: &LivePlane,
        opened: &Cell<u32>,
    ) -> Result<Json, RunError> {
        run_session(
            || {
                opened.set(opened.get() + 1);
                Ok(self.x())
            },
            USER,
            FEE,
            input,
            port,
            live,
        )
    }

    fn sessions(&self) -> i64 {
        self.db
            .count("SELECT count(*)::bigint FROM agents.agent_sessions")
    }

    fn actions(&self) -> i64 {
        self.db
            .count("SELECT count(*)::bigint FROM agents.agent_actions")
    }

    fn log(&self, session: &str) -> Vec<Action> {
        audit::for_session(self.store.pool().unwrap(), session, 500).unwrap()
    }

    /// The copy-intel guardrail with its action budget changed, upserted as `registerAgent` does.
    fn register_copy_intel(&self, edit: impl FnOnce(&mut Json)) {
        let mut spec = boot_agents()
            .unwrap()
            .into_iter()
            .find(|a| a.agent_id == "copy-intel")
            .unwrap()
            .guardrail;
        edit(&mut spec);
        let g = parse_guardrail(&spec).unwrap();
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

    /// `fake.settlements = [1.25]`: each Copy-Intel session opens with one usage record that costs 1.25.
    fn charge_each_session(&self) {
        self.db
            .client()
            .batch_execute(
                "CREATE FUNCTION agents.test_copy_intel_usage() RETURNS trigger LANGUAGE plpgsql AS $$
                 BEGIN
                   IF NEW.agent_id = 'copy-intel' THEN
                     INSERT INTO agents.usage_windows (session_id, window_id) VALUES (NEW.id, 'w1');
                     INSERT INTO agents.usage_records (session_id, window_id, request_id, task, provider_id, model,
                       input_tokens, output_tokens, input_price_per_million, output_price_per_million)
                     VALUES (NEW.id, 'w1', 'r1', 'copy_intel.stats', 'primary', 'fast-sm', 1250000, 0, 1, 0);
                   END IF;
                   RETURN NEW;
                 END $$;
                 CREATE TRIGGER test_copy_intel_usage AFTER INSERT ON agents.agent_sessions
                   FOR EACH ROW EXECUTE FUNCTION agents.test_copy_intel_usage();",
            )
            .unwrap();
    }

    /// `fake.closeThrows = new Error('close failed after charge')`.
    fn close_throws(&self) {
        self.db
            .client()
            .batch_execute(
                "CREATE FUNCTION agents.test_close_throws() RETURNS trigger LANGUAGE plpgsql AS $$
                 BEGIN RAISE EXCEPTION 'close failed after charge'; END $$;
                 CREATE TRIGGER test_close_throws BEFORE UPDATE ON agents.agent_sessions
                   FOR EACH ROW WHEN (NEW.status = 'closed') EXECUTE FUNCTION agents.test_close_throws();",
            )
            .unwrap();
    }
}

fn input<'a>(plane: &'a str, fixtures: Vec<Json>, allowlist: Option<&'a [String]>) -> RunInput<'a> {
    RunInput {
        plane,
        fixtures,
        allowlist,
        now: NOW,
        rank_by: None,
    }
}

fn s(v: &Json, k: &str) -> Json {
    v.get(k).cloned().unwrap_or(Json::Null)
}

fn unmetered() -> Json {
    json::parse(r#"{"sessionId":null,"billedAmount":"0","assetId":"IFC","sessionClosed":false,"settlements":[]}"#)
        .unwrap()
}

fn tools_of(log: &[Action]) -> Vec<(String, String)> {
    log.iter()
        .filter(|a| a.kind == "tool_call")
        .map(|a| (a.tool.clone().unwrap_or_default(), a.status.clone()))
        .collect()
}

fn pair(tool: &str, status: &str) -> (String, String) {
    (tool.to_owned(), status.to_owned())
}

// ── session-run.test.ts ─────────────────────────────────────────────────────

/// "refuses live leader plane before opening a session — no invent stats"
#[test]
fn refuses_the_live_plane_before_opening_a_session() {
    let Some(w) = World::new() else { return };
    let opened = Cell::new(0);
    let list = ids(&["leader-a", "leader-b"]);
    let out = w
        .run(
            &input(
                "live",
                vec![
                    fixture("leader-a", ""),
                    fixture("leader-b", r#"{"realisedPnl":"3.0","winningTrades":2}"#),
                ],
                Some(&list),
            ),
            None,
            &closed(),
            &opened,
        )
        .unwrap();
    assert_eq!(s(&out, "status"), Json::str("refuse"));
    assert_eq!(s(&out, "reason"), Json::str("no_live_leaders"));
    assert_eq!(
        s(&out, "userMessageKey"),
        Json::str("agents.copy_intel.unavailable")
    );
    assert_eq!(opened.get(), 0);
    assert_eq!(w.sessions(), 0);
    assert_eq!(w.actions(), 0);
    assert_eq!(s(&out, "metering"), unmetered());
}

/// "bills zero when live plane is refused — no invent fee share charge" and "does not settle invented windows while
/// the live plane is closed"
#[test]
fn bills_and_settles_nothing_while_the_live_plane_is_closed() {
    let Some(w) = World::new() else { return };
    w.charge_each_session();
    let opened = Cell::new(0);
    let out = w
        .run(
            &input("live", vec![fixture("leader-a", "")], None),
            None,
            &closed(),
            &opened,
        )
        .unwrap();
    assert_eq!(s(&out, "status"), Json::str("refuse"));
    assert_eq!(s(&out, "reason"), Json::str("no_live_leaders"));
    assert_eq!(s(&out, "metering"), unmetered());
    assert_eq!(opened.get(), 0);
    assert_eq!(w.sessions(), 0);
    assert!(w.book.0.lock().unwrap().is_empty());
}

/// "refuses a dark copy plane before opening a metered session"
#[test]
fn refuses_a_dark_plane_before_opening_a_session() {
    let Some(w) = World::new() else { return };
    let opened = Cell::new(0);
    let port = Rows(Ok(vec![fixture("leader-a", "")]));
    let list = ids(&["leader-a"]);
    let out = w
        .run(
            &input("dark", vec![fixture("leader-a", "")], Some(&list)),
            Some(&port),
            &open(&["leader-a"]),
            &opened,
        )
        .unwrap();
    assert_eq!(
        out,
        json::parse(
            r#"{"status":"refuse","reason":"copy_plane_dark","userMessageKey":"agents.copy_intel.unavailable",
                "fixturesRefusedByGuardrail":0,"writesRefusedByGuardrail":0,
                "metering":{"sessionId":null,"billedAmount":"0","assetId":"IFC","sessionClosed":false,"settlements":[]}}"#
        )
        .unwrap()
    );
    assert_eq!(opened.get(), 0);
    assert_eq!(w.sessions(), 0);
}

/// "D26-P1-A5: refuses returns-ranked board before opening a session"
#[test]
fn refuses_a_returns_ranked_board_before_opening_a_session() {
    let Some(w) = World::new() else { return };
    let opened = Cell::new(0);
    let mut run = input("live", vec![fixture("leader-a", "")], None);
    run.rank_by = Some("realisedPnl");
    let err = w.run(&run, None, &closed(), &opened).unwrap_err();
    let RunError::Agent(d) = err else {
        panic!("an AgentError: {err:?}")
    };
    assert_eq!(d.error.code, "agents.refused");
    assert_eq!(d.error.user_key, "agents.copy_intel.unavailable");
    assert_eq!(
        Json::Object(d.params),
        json::parse(r#"{"reason":"returns_ranked_board_forbidden","rankBy":"realisedPnl"}"#)
            .unwrap()
    );
    assert_eq!(opened.get(), 0);
    assert_eq!(w.sessions(), 0);
    // A sort that ranks nothing is no refusal.
    run.rank_by = Some("leaderId");
    assert!(w.run(&run, None, &closed(), &opened).is_ok());
}

/// "refuses live plane when port is unset and no fixtures are supplied"
#[test]
fn refuses_the_live_plane_with_no_port_and_no_fixtures() {
    let Some(w) = World::new() else { return };
    let opened = Cell::new(0);
    let out = w
        .run(&input("live", Vec::new(), None), None, &closed(), &opened)
        .unwrap();
    assert_eq!(s(&out, "reason"), Json::str("no_live_leaders"));
    assert_eq!(opened.get(), 0);
    assert_eq!(w.sessions(), 0);
}

/// "does not open a session to discover a missing live allowlist — even with a write budget", "does not call tools
/// when live leaders are not allowlisted" and "never reaches trade.order or fee-share invent paths while live plane
/// is closed": the live rows are there, the plane is open, but the caller's allowlist is missing or not sealed.
#[test]
fn does_not_open_a_session_or_call_a_tool_without_a_sealed_allowlist() {
    let Some(w) = World::new() else { return };
    w.register_copy_intel(|g| {
        let Json::Object(f) = g else { unreachable!() };
        let limits = &mut f.iter_mut().find(|(k, _)| k == "limits").unwrap().1;
        let Json::Object(l) = limits else {
            unreachable!()
        };
        l.iter_mut()
            .find(|(k, _)| k == "maxActionsPerSession")
            .unwrap()
            .1 = Json::int(2);
    });
    let opened = Cell::new(0);
    let port = Rows(Ok(vec![
        fixture("solo", ""),
        fixture("a", ""),
        fixture("b", ""),
    ]));
    let fake = ids(&["solo", "fake"]);
    for (live, list) in [
        (closed(), None),
        (closed(), Some(fake.as_slice())),
        (open(&["solo"]), None),
        (open(&["solo"]), Some(fake.as_slice())),
        (open(&[]), Some(&fake[..1])),
    ] {
        let out = w
            .run(
                &input("live", vec![fixture("solo", "")], list),
                Some(&port),
                &live,
                &opened,
            )
            .unwrap();
        assert_eq!(
            s(&out, "reason"),
            Json::str("no_live_leaders"),
            "{live:?} {list:?}"
        );
        assert_eq!(s(&out, "fixturesRefusedByGuardrail"), Json::int(0));
        assert_eq!(s(&out, "writesRefusedByGuardrail"), Json::int(0));
    }
    assert_eq!(opened.get(), 0);
    assert_eq!(w.sessions(), 0);
    assert_eq!(w.actions(), 0);
    assert!(w.book.0.lock().unwrap().is_empty());
}

/// "does not settle again when close throws after the charge": the window is charged once, the close's failure is the
/// answer, and nothing settles or closes it a second time.
#[test]
fn does_not_settle_again_when_close_throws_after_the_charge() {
    let Some(w) = World::new() else { return };
    w.charge_each_session();
    w.close_throws();
    let opened = Cell::new(0);
    let port = Rows(Ok(vec![fixture("leader-a", "")]));
    let list = ids(&["leader-a"]);
    let err = w
        .run(
            &input("live", vec![fixture("leader-a", "")], Some(&list)),
            Some(&port),
            &open(&["leader-a"]),
            &opened,
        )
        .unwrap_err();
    assert!(
        format!("{err:?}").contains("close failed after charge"),
        "{err:?}"
    );
    assert_eq!(opened.get(), 1);
    let booked = w.book.0.lock().unwrap().clone();
    assert_eq!(booked.len(), 1, "charged once");
    let charged: String =
        w.db.client()
            .query_one(
                "SELECT charged_amount::text FROM agents.usage_windows WHERE sealed_at IS NOT NULL",
                &[],
            )
            .unwrap()
            .get(0);
    assert_eq!(charged, "1.250000000000000000");
    let status: String =
        w.db.client()
            .query_one("SELECT status::text FROM agents.agent_sessions", &[])
            .unwrap()
            .get(0);
    assert_eq!(status, "open", "the close failed and was not retried");
}

// ── run-session-route.test.ts (the run as the router shapes it) ──────────────

/// "refuses a dark copy plane without touching the runtime, and says it billed nothing", "is empty when no fixtures
/// were supplied" and "refuses live plane with fixtures until leaders are allowlisted — no invent board"
#[test]
fn the_route_refuses_without_touching_the_runtime() {
    let Some(w) = World::new() else { return };
    let opened = Cell::new(0);
    let list = ids(&["leader-a"]);
    for (plane, fixtures, allowlist, reason) in [
        (
            "dark",
            vec![fixture("leader-a", "")],
            None,
            "copy_plane_dark",
        ),
        ("live", Vec::new(), None, "no_live_leaders"),
        (
            "live",
            vec![fixture("leader-a", "")],
            Some(list.as_slice()),
            "no_live_leaders",
        ),
    ] {
        let out = w
            .run(&input(plane, fixtures, allowlist), None, &closed(), &opened)
            .unwrap();
        assert_eq!(s(&out, "status"), Json::str("refuse"));
        assert_eq!(s(&out, "reason"), Json::str(reason));
        assert_eq!(s(&out, "metering"), unmetered());
    }
    assert_eq!(opened.get(), 0);
    assert_eq!(w.sessions(), 0);
}

// ── The open plane, end to end ───────────────────────────────────────────────

/// The sealed plane open and the caller inside it: each live row read through `trade.copy.leaders.read`, each stat
/// written through `trade.copy.stats.write`, a directory in `leaderId` order, settled and closed.
#[test]
fn an_open_plane_reads_writes_and_settles_the_board() {
    let Some(w) = World::new() else { return };
    w.charge_each_session();
    let opened = Cell::new(0);
    let port = Rows(Ok(vec![
        fixture("leader-b", r#"{"realisedPnl":"3.0","winningTrades":2}"#),
        fixture("leader-a", ""),
        fixture("leader-x", ""),
        fixture("leader-c", r#"{"realisedPnl":null}"#),
    ]));
    let list = ids(&["leader-a", "leader-b", "leader-c"]);
    let out = w
        .run(
            &input("live", vec![fixture("ignored", "")], Some(&list)),
            Some(&port),
            &open(&["leader-a", "leader-b", "leader-c"]),
            &opened,
        )
        .unwrap();
    let session = match s(&s(&out, "metering"), "sessionId") {
        Json::String(id) => id,
        other => panic!("a session: {other:?}"),
    };
    let stat = |id: &str, pnl: &str, rate: &str| {
        format!(
            r#"{{"leaderId":"{id}","realisedPnl":"{pnl}","closedTrades":10,"winRate":"{rate}",
                "windowStart":"2026-08-01T00:00:00.000Z","windowEnd":"2026-08-07T00:00:00.000Z"}}"#
        )
    };
    let audit = |n: u8, id: &str, pnl: &str, rate: &str| {
        format!(
            r#"{{"id":"ci-{n}","writtenAt":"2026-08-07T12:00:00.000Z","source":"platform-fills","leaderId":"{id}",
                "stat":{},"provenance":{{"fixture":true,"source":"platform-fills",
                "windowStart":"2026-08-01T00:00:00.000Z","windowEnd":"2026-08-07T00:00:00.000Z"}}}}"#,
            stat(id, pnl, rate)
        )
    };
    let charge_key = match out.get("metering").and_then(|m| m.get("settlements")) {
        Some(Json::Array(a)) => a[0].get("chargeKey").cloned().unwrap(),
        other => panic!("settlements: {other:?}"),
    };
    let want = format!(
        r#"{{"status":"ok","stats":[{},{}],"audit":[{},{}],"skippedIncomplete":2,"fixturesAccepted":4,
            "fixturesRefusedByGuardrail":0,"writesRefusedByGuardrail":0,
            "presentation":{{"kind":"directory","rankedByReturns":false,"sortKey":"leaderId"}},
            "metering":{{"sessionId":"{session}","billedAmount":"1.25","assetId":"IFC","sessionClosed":true,
              "settlements":[{{"windowId":"w1","amount":"1.25","chargeKey":{},"settled":true}}]}}}}"#,
        stat("leader-a", "12.5", "0.6000"),
        stat("leader-b", "3.0", "0.2000"),
        audit(2, "leader-a", "12.5", "0.6000"),
        audit(1, "leader-b", "3.0", "0.2000"),
        charge_key.compact(),
    );
    assert_eq!(out, json::parse(&want).unwrap());
    assert_eq!(opened.get(), 1);
    let log = w.log(&session);
    assert_eq!(
        tools_of(&log),
        [
            pair("trade.copy.leaders.read", "executed"),
            pair("trade.copy.leaders.read", "executed"),
            pair("trade.copy.leaders.read", "executed"),
            pair("trade.copy.leaders.read", "executed"),
            pair("trade.copy.stats.write", "executed"),
            pair("trade.copy.stats.write", "executed"),
        ]
    );
    assert!(
        log.iter()
            .all(|a| a.agent_id == "copy-intel" && a.user_id == USER)
    );
    assert!(!log.iter().any(|a| {
        a.tool
            .as_deref()
            .is_some_and(|t| t == "trade.order" || t == "ledger.post" || t.contains("fee"))
    }));
    assert_eq!(w.book.0.lock().unwrap().len(), 1);
}

/// The guardrail's action budget: two reads pass, the third read and every write past the budget are refused, and the
/// answer holds only the stats that were written.
#[test]
fn the_guardrail_refuses_reads_and_writes_past_the_budget() {
    let Some(w) = World::new() else { return };
    w.register_copy_intel(|g| {
        let Json::Object(f) = g else { unreachable!() };
        let limits = &mut f.iter_mut().find(|(k, _)| k == "limits").unwrap().1;
        let Json::Object(l) = limits else {
            unreachable!()
        };
        l.iter_mut()
            .find(|(k, _)| k == "maxActionsPerSession")
            .unwrap()
            .1 = Json::int(3);
    });
    let opened = Cell::new(0);
    let port = Rows(Ok(vec![
        fixture("a", ""),
        fixture("b", ""),
        fixture("c", ""),
    ]));
    let list = ids(&["a", "b", "c"]);
    let live = open(&["a", "b", "c"]);
    let out = w
        .run(
            &input("live", Vec::new(), Some(&list)),
            Some(&port),
            &live,
            &opened,
        )
        .unwrap();
    // Three reads exhaust the budget of three: both writes refused.
    assert_eq!(s(&out, "status"), Json::str("refuse"));
    assert_eq!(s(&out, "reason"), Json::str("writes_refused"));
    assert_eq!(s(&out, "fixturesRefusedByGuardrail"), Json::int(0));
    assert_eq!(s(&out, "writesRefusedByGuardrail"), Json::int(3));
    assert_eq!(s(&s(&out, "metering"), "sessionClosed"), Json::Bool(true));

    let two = Rows(Ok(vec![fixture("b", ""), fixture("a", "")]));
    let out = w
        .run(
            &input("live", Vec::new(), Some(&list)),
            Some(&two),
            &live,
            &opened,
        )
        .unwrap();
    // Two reads, one write; the second write is refused and its leader left out.
    assert_eq!(s(&out, "status"), Json::str("ok"));
    assert_eq!(s(&out, "fixturesAccepted"), Json::int(2));
    assert_eq!(s(&out, "writesRefusedByGuardrail"), Json::int(1));
    let leaders = |k: &str| match out.get(k) {
        Some(Json::Array(rows)) => rows.iter().map(|r| s(r, "leaderId")).collect::<Vec<_>>(),
        _ => panic!("{k}"),
    };
    assert_eq!(leaders("stats"), [Json::str("b")]);
    assert_eq!(leaders("audit"), [Json::str("b")]);

    let four = Rows(Ok(vec![
        fixture("a", ""),
        fixture("b", ""),
        fixture("c", ""),
        fixture("a", ""),
    ]));
    let out = w
        .run(
            &input("live", Vec::new(), Some(&list)),
            Some(&four),
            &live,
            &opened,
        )
        .unwrap();
    // The fourth read is past the budget; every write is too.
    assert_eq!(s(&out, "reason"), Json::str("writes_refused"));
    assert_eq!(s(&out, "fixturesRefusedByGuardrail"), Json::int(1));
    assert_eq!(s(&out, "writesRefusedByGuardrail"), Json::int(3));
    let session = match s(&s(&out, "metering"), "sessionId") {
        Json::String(id) => id,
        other => panic!("{other:?}"),
    };
    let statuses: Vec<String> = tools_of(&w.log(&session))
        .into_iter()
        .map(|(_, st)| st)
        .collect();
    assert_eq!(
        statuses,
        [
            "executed", "executed", "executed", "refused", "refused", "refused", "refused"
        ]
    );
}

/// A guardrail that does not declare the read: every row is refused, the run says so and still settles and closes.
#[test]
fn every_read_refused_is_no_live_leaders_settled_and_closed() {
    let Some(w) = World::new() else { return };
    w.register_copy_intel(|g| {
        let Json::Object(f) = g else { unreachable!() };
        let Json::Array(tools) = &mut f.iter_mut().find(|(k, _)| k == "tools").unwrap().1 else {
            unreachable!()
        };
        tools.retain(|t| t.get("name") != Some(&Json::str("trade.copy.leaders.read")));
    });
    let opened = Cell::new(0);
    let port = Rows(Ok(vec![fixture("a", ""), fixture("b", "")]));
    let list = ids(&["a"]);
    let out = w
        .run(
            &input("live", Vec::new(), Some(&list)),
            Some(&port),
            &open(&["a"]),
            &opened,
        )
        .unwrap();
    assert_eq!(s(&out, "reason"), Json::str("no_live_leaders"));
    assert_eq!(s(&out, "fixturesRefusedByGuardrail"), Json::int(2));
    assert_eq!(s(&out, "writesRefusedByGuardrail"), Json::int(0));
    let metering = s(&out, "metering");
    assert!(matches!(metering.get("sessionId"), Some(Json::String(_))));
    assert_eq!(s(&metering, "billedAmount"), Json::str("0"));
    assert_eq!(s(&metering, "sessionClosed"), Json::Bool(true));
}

/// The build's own refusals inside the session: a bad window, nothing complete, nothing allowlisted; each settled and
/// closed with its metering. A port that throws or answers nothing refuses before any session.
#[test]
fn the_builds_refusals_inside_the_session_are_metered() {
    let Some(w) = World::new() else { return };
    let opened = Cell::new(0);
    let list = ids(&["a"]);
    let live = open(&["a"]);
    for (rows, want) in [
        (
            vec![fixture("a", r#"{"windowEnd":"2026-07-01T00:00:00.000Z"}"#)],
            r#"{"status":"unavailable","userMessageKey":"agents.copy_intel.unavailable","reason":"invalid_window"}"#,
        ),
        (
            vec![fixture("a", r#"{"closedTrades":2,"winningTrades":3}"#)],
            r#"{"status":"unavailable","userMessageKey":"agents.copy_intel.unavailable","reason":"no_data"}"#,
        ),
        (
            vec![fixture("z", "")],
            r#"{"status":"empty","userMessageKey":"agents.copy_intel.empty"}"#,
        ),
    ] {
        let port = Rows(Ok(rows));
        let mut out = w
            .run(
                &input("live", Vec::new(), Some(&list)),
                Some(&port),
                &live,
                &opened,
            )
            .unwrap();
        let Json::Object(fields) = &mut out else {
            panic!()
        };
        let (k, metering) = fields.pop().unwrap();
        assert_eq!(k, "metering");
        assert_eq!(s(&metering, "sessionClosed"), Json::Bool(true));
        assert_eq!(out, json::parse(want).unwrap());
    }
    assert_eq!(opened.get(), 3);
    assert_eq!(
        w.db.count("SELECT count(*)::bigint FROM agents.agent_sessions WHERE status = 'closed'"),
        3
    );
    let before = w.sessions();
    for port in [Rows(Err("trade down".to_owned())), Rows(Ok(Vec::new()))] {
        let out = w
            .run(
                &input("live", Vec::new(), Some(&list)),
                Some(&port),
                &live,
                &opened,
            )
            .unwrap();
        assert_eq!(s(&out, "reason"), Json::str("no_live_leaders"));
        assert_eq!(s(&out, "metering"), unmetered());
    }
    assert_eq!(w.sessions(), before);
}

/// A live row of other types (svc-trade's answer is not checked, as in the TypeScript): a number for a window passes
/// the build as `Date.parse(String(n))` and fails the output check after the session settled and closed.
#[test]
fn a_live_row_of_other_types_fails_the_output_check_after_settling() {
    let Some(w) = World::new() else { return };
    let opened = Cell::new(0);
    let list = ids(&["a"]);
    let port = Rows(Ok(vec![fixture("a", r#"{"windowStart":2026}"#)]));
    let err = w
        .run(
            &input("live", Vec::new(), Some(&list)),
            Some(&port),
            &open(&["a"]),
            &opened,
        )
        .unwrap_err();
    assert!(
        format!("{err:?}").contains("Output validation failed"),
        "{err:?}"
    );
    assert_eq!(
        w.db.count("SELECT count(*)::bigint FROM agents.agent_sessions WHERE status = 'closed'"),
        1
    );
}
