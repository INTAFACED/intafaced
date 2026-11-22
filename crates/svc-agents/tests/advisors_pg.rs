//! The Coach run on a real Postgres, the crate's runtime and meter (`services/svc-agents/src/coach/coach-run.db.test.ts`,
//! case for case): one stored answer per (person, request id), one charge per usage window on its own charge key, and a
//! posting freeze that leaves the charge unpaid on its row rather than dropping it. The ledger is a double-entry fake
//! that books each recipe once per key as `MemoryLedger` does, and refuses with `ledger.frozen` while frozen. Without
//! `TEST_DATABASE_URL_AGENTS` or `TEST_DATABASE_URL` it skips; with `REQUIRE_POSTGRES=1` it fails.
//!
//! The Coach guardrail is registered with a TEST cap so the route can carry a TEST price: the shipped guardrail caps
//! at 0, and a free route would settle nothing the ledger could refuse.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

mod support;

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use service_kit::money::{Amount, format_amount, parse_amount};
use service_kit::pg::Pool;
use service_kit::time::Instant;
use support::TestDb;
use svc_agents::advisors::coach_run::{
    Answered, COACH_RUN_LEASE_MS, Charge, CoachAsk, CoachResult, PgRunStore, RunRow, RunStore,
    coach_guardrail, run_coach_answer,
};
use svc_agents::advisors::grounding::{Grounding, Lesson};
use svc_agents::boot::{BootAgent, register_agents};
use svc_agents::db::{Store, StoreError};
use svc_agents::door::system_now;
use svc_agents::gateway::Gateway;
use svc_agents::gateway::providers::{MockOptions, MockProvider, Provider};
use svc_agents::gateway::routing::parse_routing_table;
use svc_agents::metering::Metering;
use svc_agents::metering::ports::{Bus, Ledger, LedgerError, Recipe};
use svc_agents::runtime::guardrails::serialise_guardrail;
use svc_agents::runtime::{Rt, RunError, Runtime};

const USER: &str = "66666666-6666-4666-8666-666666666666";
const FEE: &str = "IFC";
const ASK: &str = "TEST: why does position size matter more than entry?";
const TABLE: &str = r#"{"routes":[{"task":"coach.answer","providerId":"primary","model":"test-engine","maxOutputTokens":64,
  "price":{"inputPerMillion":"1000","outputPerMillion":"1000"}}]}"#;

fn spine() -> Grounding {
    let l = |slug: &str, title: &str| Lesson {
        slug: slug.to_owned(),
        title: title.to_owned(),
    };
    Grounding {
        items: vec![
            l("foundations-risk-first", "Risk first"),
            l(
                "foundations-position-sizing",
                "Position sizing without inventing numbers",
            ),
            l(
                "foundations-invalidation-first",
                "Invalidation before entry",
            ),
        ],
        licensed_library_imported: false,
    }
}

fn amt(s: &str) -> Amount {
    parse_amount(s).unwrap()
}

/// `MemoryLedger` as far as this suite reads it, with the platform-wide posting freeze svc-ledger owns.
#[derive(Default, Clone)]
struct FakeLedger {
    accounts: Arc<Mutex<BTreeMap<String, Amount>>>,
    by_key: Arc<Mutex<BTreeMap<String, String>>>,
    frozen: Arc<AtomicBool>,
}

impl FakeLedger {
    fn balance(&self, account: &str) -> String {
        format_amount(
            self.accounts
                .lock()
                .unwrap()
                .get(account)
                .copied()
                .unwrap_or(0),
        )
    }
    fn house(&self) -> String {
        self.balance(&format!("house:fees:agents:{FEE}"))
    }
    fn available(&self) -> String {
        self.balance(&format!("user:{USER}:available:{FEE}"))
    }
}

impl Ledger for FakeLedger {
    fn post_recipe(&self, recipe: &Recipe) -> Result<String, LedgerError> {
        if self.frozen.load(Ordering::SeqCst) {
            return Err(LedgerError {
                code: Some("ledger.frozen".to_owned()),
                message: "Postings are frozen".to_owned(),
            });
        }
        let key = recipe.idempotency_key();
        let mut by_key = self.by_key.lock().unwrap();
        if let Some(tx) = by_key.get(&key) {
            return Ok(tx.clone());
        }
        let Recipe::FeeCharge {
            user_id,
            module,
            asset_id,
            amount,
            ..
        } = recipe
        else {
            panic!("this suite books only the custodial fee charge");
        };
        let mut acc = self.accounts.lock().unwrap();
        let from = format!("user:{user_id}:available:{asset_id}");
        if acc.get(&from).copied().unwrap_or(0) < *amount {
            return Err(LedgerError {
                code: Some("ledger.insufficient_funds".to_owned()),
                message: "Insufficient funds".to_owned(),
            });
        }
        *acc.entry(from).or_default() -= amount;
        *acc.entry(format!("house:fees:{module}:{asset_id}"))
            .or_default() += amount;
        let tx = format!("tx-{}", by_key.len() + 1);
        by_key.insert(key, tx.clone());
        Ok(tx)
    }
}

/// `MemoryEventBus`: takes every event.
struct MemoryBus;

impl Bus for MemoryBus {
    fn publish(&self, _: &str, _: &str, _: &service_kit::json::Json) -> Result<(), String> {
        Ok(())
    }
}

/// `beforeEach`: a fresh database, the Coach registered with a TEST cap, 100 IFC deposited.
struct World {
    _db: TestDb,
    store: Store,
    ledger: FakeLedger,
    gateway: Gateway,
    m: Metering,
    rt: Runtime,
}

impl World {
    fn new() -> Option<World> {
        let db = TestDb::new()?;
        svc_agents::migrate::run(&db.url, false, &mut Vec::new()).unwrap();
        let store = db.store();
        let g = coach_guardrail("10").unwrap();
        register_agents(
            &store,
            &[BootAgent {
                agent_id: g.agent_id.clone(),
                version: i32::try_from(g.version).unwrap(),
                guardrail: serialise_guardrail(&g),
                enabled: true,
            }],
        )
        .unwrap();
        let ledger = FakeLedger::default();
        ledger
            .accounts
            .lock()
            .unwrap()
            .insert(format!("user:{USER}:available:{FEE}"), amt("100"));
        let mut m = Metering::unwired(FEE, 60);
        m.enabled = true;
        m.ledger = Box::new(ledger.clone());
        m.bus = Box::new(MemoryBus);
        let provider: Arc<dyn Provider> = Arc::new(MockProvider::new(
            MockOptions {
                id: Some("primary".to_owned()),
                ..MockOptions::default()
            },
            system_now,
        ));
        let mut rt = Runtime::unwired();
        rt.spend = false;
        Some(World {
            gateway: Gateway::new(vec![provider], parse_routing_table(TABLE).unwrap()),
            store,
            _db: db,
            ledger,
            m,
            rt,
        })
    }

    fn pool(&self) -> &Pool {
        self.store.pool().unwrap()
    }

    fn ask_with(&self, store: &dyn RunStore, lease_now: Instant) -> Result<CoachResult, RunError> {
        let x = Rt {
            rt: &self.rt,
            pool: self.pool(),
            gateway: &self.gateway,
            m: &self.m,
            now: system_now(),
        };
        run_coach_answer(
            &x,
            store,
            &spine(),
            &CoachAsk {
                user_id: USER,
                request_id: "coach:db:0001",
                question: ASK,
                lesson_slug: Some("foundations-risk-first"),
            },
            lease_now,
        )
    }

    fn ask(&self) -> CoachResult {
        self.ask_with(&PgRunStore(self.pool()), system_now())
            .unwrap()
    }

    fn later(&self) -> CoachResult {
        self.ask_with(
            &PgRunStore(self.pool()),
            Instant(system_now().0 + COACH_RUN_LEASE_MS + 1),
        )
        .unwrap()
    }

    /// `(charge_key, charged_amount, charge_tx_id)` of every window, oldest first.
    fn windows(&self) -> Vec<(Option<String>, Option<String>, Option<String>)> {
        self._db
            .client()
            .query(
                "SELECT charge_key, charged_amount::text, charge_tx_id FROM agents.usage_windows ORDER BY opened_at",
                &[],
            )
            .unwrap()
            .iter()
            .map(|r| (r.get(0), r.get(1), r.get(2)))
            .collect()
    }

    fn row(&self) -> Vec<(String, String, Option<String>)> {
        self._db
            .client()
            .query(
                "SELECT run_key, status, billed_amount::text FROM agents.coach_runs WHERE user_id = $1",
                &[&USER],
            )
            .unwrap()
            .iter()
            .map(|r| (r.get(0), r.get(1), r.get(2)))
            .collect()
    }
}

fn billed(r: &CoachResult) -> String {
    match r {
        CoachResult::Answered {
            charge: Charge::Settled(b),
            ..
        } => b.clone(),
        other => panic!("not a settled answer: {other:?}"),
    }
}

#[test]
fn answers_once_charges_its_window_once_and_a_retry_returns_the_stored_answer() {
    let Some(w) = World::new() else { return };
    let first = w.ask();
    let paid = billed(&first);
    let CoachResult::Answered {
        session_id,
        replayed,
        ..
    } = &first
    else {
        panic!("answered");
    };
    assert!(!replayed);
    assert!(amt(&paid) > 0);
    assert_eq!(w.ledger.house(), paid);
    assert_eq!(w.ledger.available(), format_amount(amt("100") - amt(&paid)));

    let again = w.ask();
    let mut expected = first.clone();
    if let CoachResult::Answered { replayed, .. } = &mut expected {
        *replayed = true;
    }
    assert_eq!(again, expected);
    assert_eq!(w.ledger.house(), paid);
    let rows = w.windows();
    assert_eq!(rows.len(), 1);
    assert_eq!(format_amount(amt(rows[0].1.as_deref().unwrap())), paid);

    let stored = w.row();
    assert_eq!(stored.len(), 1);
    assert_eq!(
        stored[0].0,
        format!("agents:run:{session_id}:coach:db:0001")
    );
    assert_eq!(stored[0].1, "answered");
    assert_eq!(format_amount(amt(stored[0].2.as_deref().unwrap())), paid);
}

/// The store, crashing where the answer would be stored.
struct Crashing<'a>(PgRunStore<'a>);

impl RunStore for Crashing<'_> {
    fn find(&self, u: &str, r: &str) -> Result<Option<RunRow>, StoreError> {
        self.0.find(u, r)
    }
    fn claim(&self, u: &str, r: &str, s: &str, k: &str, d: &str) -> Result<bool, StoreError> {
        self.0.claim(u, r, s, k, d)
    }
    fn answer(&self, _: &str, _: &str, _: &Answered<'_>) -> Result<bool, StoreError> {
        Err(StoreError::new("crash before the answer was stored", None))
    }
    fn charged(&self, s: &str) -> Result<Amount, StoreError> {
        self.0.charged(s)
    }
    fn settled(&self, u: &str, r: &str, b: &str) -> Result<(), StoreError> {
        self.0.settled(u, r, b)
    }
    fn lost(&self, u: &str, r: &str) -> Result<(), StoreError> {
        self.0.lost(u, r)
    }
    fn drop_running(&self, u: &str, r: &str) -> Result<(), StoreError> {
        self.0.drop_running(u, r)
    }
}

#[test]
fn a_crash_after_the_engine_ran_neither_double_bills_nor_drops_the_charge() {
    let Some(w) = World::new() else { return };
    let crashed = w.ask_with(&Crashing(PgRunStore(w.pool())), system_now());
    match crashed {
        Err(RunError::Store(e)) => assert_eq!(e.message, "crash before the answer was stored"),
        other => panic!("expected the crash, got {other:?}"),
    }
    assert_eq!(w.ledger.house(), "0");

    // Inside the lease the running row may be a live run: the retry touches nothing.
    assert_eq!(w.ask(), CoachResult::Refused("agents.run_in_progress"));
    assert_eq!(w.ledger.house(), "0");

    assert_eq!(w.later(), CoachResult::Refused("agents.request_id_replay"));
    let charged = w.ledger.house();
    assert!(amt(&charged) > 0);
    assert_eq!(w.later(), CoachResult::Refused("agents.request_id_replay"));
    assert_eq!(w.ledger.house(), charged);

    let rows = w.windows();
    assert_eq!(rows.len(), 1);
    assert!(rows[0].2.is_some());
    let usage: i64 = w
        ._db
        .client()
        .query_one("SELECT count(*)::bigint FROM agents.usage_records", &[])
        .unwrap()
        .get(0);
    assert_eq!(usage, 1);
}

#[test]
fn during_a_posting_freeze_the_charge_keeps_its_row_and_settles_once_after() {
    let Some(w) = World::new() else { return };
    w.ledger.frozen.store(true, Ordering::SeqCst);
    let first = w.ask();
    let CoachResult::Answered { charge, .. } = &first else {
        panic!("answered");
    };
    assert_eq!(*charge, Charge::Unpaid("ledger.frozen".to_owned()));
    assert_eq!(w.ledger.house(), "0");
    let held = w.windows();
    assert_eq!(held.len(), 1);
    assert!(held[0].2.is_none());
    let row = w.row();
    assert_eq!((row[0].1.as_str(), row[0].2.as_deref()), ("answered", None));

    w.ledger.frozen.store(false, Ordering::SeqCst);
    let again = w.ask();
    let charged = w.ledger.house();
    assert!(amt(&charged) > 0);
    assert_eq!(billed(&again), charged);
    w.ask();
    assert_eq!(w.ledger.house(), charged);
    assert!(w.windows()[0].2.is_some());
}
