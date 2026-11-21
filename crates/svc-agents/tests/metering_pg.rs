//! The `metering` slice against a real Postgres (`TEST_DATABASE_URL_AGENTS` or `TEST_DATABASE_URL`, a server whose admin
//! database name ends in `_test`), each test in its own throwaway database migrated by the crate's own runner. Without a
//! URL it skips; with `REQUIRE_POSTGRES=1` it fails.
//!
//! The TypeScript database tests of the slice, ported case for case onto the Rust code (each test names its source):
//! `metering/partner-payment.money.test.ts`, `metering/sealed-usage-race.test.ts`, the metering cases of
//! `runtime.test.ts`, the cap cases of `spend/store.test.ts`, and the dashboard and usage cases of
//! `review/review.db.test.ts`. Usage is recorded through `meter::record`, the function the runtime's completion calls;
//! the ledger, the partner's door and the bus are fakes that book each recipe once per key, as the real ones do.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::too_many_lines,
    reason = "a test: a failure is the point"
)]

use std::collections::{BTreeMap, BTreeSet};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use postgres::{Client, NoTls};

use service_kit::edge;
use service_kit::json::{self, Json};
use service_kit::money::{Amount, format_amount, parse_amount};
use service_kit::pg::Pool;
use service_kit::s2s::CallSigner;
use service_kit::server::Request;
use service_kit::time::Instant;
use svc_agents::audit;
use svc_agents::db::{self, Store};
use svc_agents::door::{AgentsDoor, DoorConfig, ServiceAuth};
use svc_agents::errors::AgentError;
use svc_agents::metering::Metering;
use svc_agents::metering::meter::{self, MeterError, UsageInput};
use svc_agents::metering::ports::{
    Bus, Collected, HeldBy, Ledger, LedgerError, PaymentUnavailable, Recipe, UsagePayment,
};
use svc_agents::metering::pricing::{self, ModelPrice, UsageGroup, charge_key_for};
use svc_agents::metering::{settle, spend};

// ── The database ────────────────────────────────────────────────────────────

fn admin_url() -> Option<String> {
    let pick = |k: &str| {
        std::env::var(k)
            .ok()
            .map(|v| v.trim().to_owned())
            .filter(|v| !v.is_empty())
    };
    let url = pick("TEST_DATABASE_URL_AGENTS").or_else(|| pick("TEST_DATABASE_URL"));
    let required = std::env::var("REQUIRE_POSTGRES").is_ok_and(|v| v == "1");
    assert!(
        url.is_some() || !required,
        "TEST_DATABASE_URL_AGENTS or TEST_DATABASE_URL is required"
    );
    url
}

fn assert_test_database(c: &mut Client) {
    let name: String = c
        .query_one("SELECT current_database()", &[])
        .unwrap()
        .get(0);
    assert!(
        name.ends_with("_test"),
        "refusing: {name} is not a test database"
    );
}

static COUNTER: AtomicUsize = AtomicUsize::new(0);

struct TestDb {
    url: String,
    admin: String,
    name: String,
}

impl TestDb {
    fn new() -> Option<TestDb> {
        let admin = admin_url()?;
        let mut a = Client::connect(&admin, NoTls).expect("the admin database answers");
        assert_test_database(&mut a);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.subsec_nanos());
        let name = format!(
            "itf_run_agents_meter_{}_{}_{nanos:x}_test",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::SeqCst)
        );
        a.batch_execute(&format!("CREATE DATABASE \"{name}\""))
            .unwrap();
        let mut parsed = url::Url::parse(&admin).unwrap();
        parsed.set_path(&format!("/{name}"));
        let db = TestDb {
            admin,
            name,
            url: parsed.to_string(),
        };
        let mut c = db.client();
        c.batch_execute(
            "CREATE EXTENSION IF NOT EXISTS \"pgcrypto\"; CREATE EXTENSION IF NOT EXISTS \"citext\"; CREATE SCHEMA IF NOT EXISTS \"agents\"",
        )
        .unwrap();
        let mut sink = Vec::new();
        svc_agents::migrate::run(&db.url, false, &mut sink).unwrap();
        Some(db)
    }

    fn client(&self) -> Client {
        let mut c = Client::connect(&self.url, NoTls).unwrap();
        c.batch_execute("SET search_path = agents, public").unwrap();
        c
    }

    fn store(&self) -> Store {
        db::open(&self.url, "svc-agents-metering-test", 6, false).unwrap()
    }
}

impl Drop for TestDb {
    fn drop(&mut self) {
        if let Ok(mut a) = Client::connect(&self.admin, NoTls) {
            let _ = a.batch_execute(&format!(
                "DROP DATABASE IF EXISTS \"{}\" WITH (FORCE)",
                self.name
            ));
        }
    }
}

macro_rules! db_or_skip {
    () => {
        match TestDb::new() {
            Some(db) => db,
            None => {
                eprintln!("skipped: no TEST_DATABASE_URL");
                return;
            }
        }
    };
}

// ── The fakes ───────────────────────────────────────────────────────────────

/// svc-ledger's `postRecipe` as far as these tests read it: each recipe booked once under its key (a repeat answers the
/// first transaction), the four places a window's money touches, and the custodial balance a fee charge needs.
#[derive(Default)]
struct Book {
    by_key: BTreeMap<String, String>,
    journal: Vec<Recipe>,
    /// `houseFees('agents', asset)`: a fee or an earned charge.
    house: Amount,
    /// `chargeReceivable('agents', debtor, asset)`: earned is owed (negative), collected pays it back.
    receivable: BTreeMap<String, Amount>,
    /// `partnerReserve(partner, asset)`.
    reserve: BTreeMap<String, Amount>,
    /// `userAvailable(user, asset)`.
    available: BTreeMap<String, Amount>,
}

#[derive(Default, Clone)]
struct FakeLedger(Arc<Mutex<Book>>, Gate);

/// Holds each post until `n` callers have reached it (or a few seconds pass), so two settles both pass their reads.
#[derive(Default, Clone)]
struct Gate(Arc<(Mutex<(usize, usize)>, std::sync::Condvar)>);

impl Gate {
    fn hold(&self, n: usize) {
        *self.0.0.lock().unwrap() = (n, 0);
    }
    fn pass(&self) {
        let (lock, cv) = &*self.0;
        let mut g = lock.lock().unwrap();
        if g.0 == 0 {
            return;
        }
        g.1 += 1;
        cv.notify_all();
        let _ = cv
            .wait_timeout_while(g, std::time::Duration::from_secs(5), |g| g.1 < g.0)
            .unwrap();
    }
}

impl FakeLedger {
    fn deposit(&self, user: &str, amount: Amount) {
        *self
            .0
            .lock()
            .unwrap()
            .available
            .entry(user.to_owned())
            .or_default() += amount;
    }
    fn reasons(&self) -> Vec<&'static str> {
        self.0
            .lock()
            .unwrap()
            .journal
            .iter()
            .map(|r| match r {
                Recipe::FeeCharge { .. } => "agents.usage.metered",
                Recipe::ChargeEarn { .. } => "charge.earned",
                Recipe::ChargeCollect { .. } => "charge.collected",
            })
            .collect()
    }
    fn house(&self) -> Amount {
        self.0.lock().unwrap().house
    }
    fn receivable(&self, who: &str) -> Amount {
        self.0
            .lock()
            .unwrap()
            .receivable
            .get(who)
            .copied()
            .unwrap_or(0)
    }
    fn reserve(&self, partner: &str) -> Amount {
        self.0
            .lock()
            .unwrap()
            .reserve
            .get(partner)
            .copied()
            .unwrap_or(0)
    }
    fn available(&self, user: &str) -> Amount {
        self.0
            .lock()
            .unwrap()
            .available
            .get(user)
            .copied()
            .unwrap_or(0)
    }
    fn tx_of(&self, key: &str) -> Option<String> {
        self.0.lock().unwrap().by_key.get(key).cloned()
    }
}

impl Ledger for FakeLedger {
    fn post_recipe(&self, recipe: &Recipe) -> Result<String, LedgerError> {
        self.1.pass();
        let mut b = self.0.lock().unwrap();
        let key = recipe.idempotency_key();
        if let Some(tx) = b.by_key.get(&key) {
            return Ok(tx.clone());
        }
        match recipe {
            Recipe::FeeCharge {
                user_id, amount, ..
            } => {
                let have = b.available.get(user_id).copied().unwrap_or(0);
                if have < *amount {
                    return Err(LedgerError {
                        code: Some("ledger.insufficient_funds".to_owned()),
                        message: format!(
                            "Insufficient funds: requested {}",
                            format_amount(*amount)
                        ),
                    });
                }
                *b.available.entry(user_id.clone()).or_default() -= amount;
                b.house += amount;
            }
            Recipe::ChargeEarn {
                user_id, per_unit, ..
            } => {
                b.house += per_unit;
                *b.receivable.entry(user_id.clone()).or_default() -= per_unit;
            }
            Recipe::ChargeCollect {
                user_id,
                partner_id,
                amount,
                ..
            } => {
                *b.receivable.entry(user_id.clone()).or_default() += amount;
                *b.reserve.entry(partner_id.clone()).or_default() -= amount;
            }
        }
        let tx = format!("tx-{}", b.journal.len() + 1);
        b.by_key.insert(key, tx.clone());
        b.journal.push(recipe.clone());
        Ok(tx)
    }
}

/// `partnerDoor`: svc-bank's door over the TEST partner, one payment per key, with switches for its refusals.
struct DoorState {
    balance: Amount,
    held_by: HeldBy,
    refuse: Option<&'static str>,
    lose_next_reply: bool,
    read_fails: bool,
    collects: usize,
    businesses: Vec<Option<String>>,
    payments: BTreeMap<String, (String, Amount)>,
}

#[derive(Clone)]
struct PartnerDoor(Arc<Mutex<DoorState>>);

impl PartnerDoor {
    fn new(balance: Amount) -> PartnerDoor {
        PartnerDoor(Arc::new(Mutex::new(DoorState {
            balance,
            held_by: HeldBy::Partner,
            refuse: None,
            lose_next_reply: false,
            read_fails: false,
            collects: 0,
            businesses: Vec::new(),
            payments: BTreeMap::new(),
        })))
    }
    fn with<T>(&self, f: impl FnOnce(&mut DoorState) -> T) -> T {
        f(&mut self.0.lock().unwrap())
    }
}

impl UsagePayment for PartnerDoor {
    fn read(&self, _: &str, _: &str, business: Option<&str>) -> Result<HeldBy, PaymentUnavailable> {
        self.with(|s| {
            s.businesses.push(business.map(str::to_owned));
            if s.read_fails {
                return Err(PaymentUnavailable);
            }
            Ok(s.held_by.clone())
        })
    }
    fn collect(
        &self,
        _: &str,
        _: &str,
        amount: Amount,
        charge_key: &str,
        business: Option<&str>,
    ) -> Result<Collected, PaymentUnavailable> {
        self.with(|s| {
            s.collects += 1;
            s.businesses.push(business.map(str::to_owned));
            if !s.payments.contains_key(charge_key) {
                if let Some(r) = s.refuse {
                    return Ok(Collected::Refused(r.to_owned()));
                }
                if s.balance < amount {
                    return Ok(Collected::Refused("insufficient_funds".to_owned()));
                }
                s.balance -= amount;
                let id = format!("test-partner-move-{}", s.payments.len() + 1);
                s.payments.insert(charge_key.to_owned(), (id, amount));
            }
            if s.lose_next_reply {
                s.lose_next_reply = false;
                return Ok(Collected::Refused("reply_lost".to_owned()));
            }
            Ok(Collected::Paid {
                payment_id: s.payments[charge_key].0.clone(),
                partner_id: "test".to_owned(),
                label: "TEST partner bank".to_owned(),
            })
        })
    }
}

#[derive(Default, Clone)]
struct FakeBus(Arc<Mutex<Vec<(String, String, Json)>>>);

impl Bus for FakeBus {
    fn publish(&self, subject: &str, msg_id: &str, envelope: &Json) -> Result<(), String> {
        self.0
            .lock()
            .unwrap()
            .push((subject.to_owned(), msg_id.to_owned(), envelope.clone()));
        Ok(())
    }
}

/// `charge_tx_id`, `paid_by`, `payment_ref`, `payment_label`, `owed_by_business`.
type WindowRow = (
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
);

// ── The world a test runs in ────────────────────────────────────────────────

const USER: &str = "33333333-3333-4333-8333-333333333333";
const OTHER: &str = "35353535-3535-4535-8535-353535353535";
const BUSINESS: &str = "44444444-4444-4444-8444-444444444444";
const ASSET: &str = "USDT";
const SECRET: &str = "an-agents-metering-test-edge-secret-long-enough";
const SERVICE_SECRET: &str = "an-agents-metering-test-service-secret-long";

fn amt(s: &str) -> Amount {
    parse_amount(s).unwrap()
}

/// The route the TypeScript tests price at: 3 in, 15 out, per million tokens.
fn price() -> ModelPrice {
    ModelPrice {
        input_per_million: amt("3"),
        output_per_million: amt("15"),
    }
}

fn now() -> Instant {
    svc_agents::door::system_now()
}

struct World {
    db: TestDb,
    store: Store,
    m: Metering,
    ledger: FakeLedger,
    door: PartnerDoor,
    bus: FakeBus,
}

impl World {
    fn new(db: TestDb, payment: PartnerDoor, enabled: bool) -> World {
        let ledger = FakeLedger::default();
        let bus = FakeBus::default();
        let mut m = Metering::unwired(ASSET, 60);
        m.enabled = enabled;
        m.ledger = Box::new(ledger.clone());
        m.payment = Box::new(payment.clone());
        m.bus = Box::new(bus.clone());
        World {
            store: db.store(),
            db,
            m,
            ledger,
            door: payment,
            bus,
        }
    }

    fn pool(&self) -> &Pool {
        self.store.pool().unwrap()
    }

    /// A session of `user`'s, as `openSession` leaves its row.
    fn open(&self, user: &str) -> String {
        self.db
            .client()
            .query_one(
                "INSERT INTO agents.agent_sessions (user_id, agent_id, guardrail, guardrail_version)
                 VALUES ($1::text, 'probe', '{\"limits\":{}}'::jsonb, 1) RETURNING id::text",
                &[&user],
            )
            .unwrap()
            .get(0)
    }

    /// One completion's usage, recorded as the runtime records it: in a transaction, at `at`.
    fn record(
        &self,
        session: &str,
        request: &str,
        input: u64,
        output: u64,
        at: Instant,
    ) -> Result<String, MeterError> {
        db::transaction_retrying(
            self.pool(),
            postgres::IsolationLevel::ReadCommitted,
            1,
            |tx| {
                meter::record(
                    &self.m,
                    tx,
                    &UsageInput {
                        session_id: session,
                        request_id: request,
                        task: "plan",
                        provider_id: "primary",
                        model: "reasoning-lg",
                        input_tokens: input,
                        output_tokens: output,
                        price: price(),
                        at,
                    },
                )
                .map(|r| r.window_id)
                .map_err(Fail)
            },
        )
        .map_err(|f| f.0)
    }

    /// A session of `user`'s with one run: its window.
    fn ran(&self, user: &str) -> (String, String) {
        let session = self.open(user);
        let window = self.record(&session, "r-1", 1200, 300, now()).unwrap();
        (session, window)
    }

    fn settle(&self, session: &str, window: &str) -> Result<meter::Settlement, MeterError> {
        settle::settle_window(&self.m, self.pool(), session, window, now())
    }

    fn pending(&self, session: &str, window: &str) -> Amount {
        meter::pending_cost(self.pool(), session, window).unwrap()
    }

    fn window_row(&self, session: &str) -> WindowRow {
        let r = self
            .db
            .client()
            .query_one(
                "SELECT charge_tx_id, paid_by, payment_ref, payment_label, owed_by_business
                   FROM agents.usage_windows WHERE session_id = $1::text::uuid",
                &[&session],
            )
            .unwrap();
        (r.get(0), r.get(1), r.get(2), r.get(3), r.get(4))
    }

    fn count(&self, sql: &str, session: &str) -> i64 {
        self.db.client().query_one(sql, &[&session]).unwrap().get(0)
    }
}

/// `meter::record`'s refusal carried through the retrying transaction.
struct Fail(MeterError);

impl From<svc_agents::db::StoreError> for Fail {
    fn from(e: svc_agents::db::StoreError) -> Fail {
        Fail(MeterError::Store(e))
    }
}

impl svc_agents::db::Retryable for Fail {
    fn store(&self) -> Option<&svc_agents::db::StoreError> {
        match &self.0 {
            MeterError::Store(s) => Some(s),
            _ => None,
        }
    }
}

fn owed_reason(r: Result<meter::Settlement, MeterError>) -> String {
    match r {
        Err(MeterError::Agent(AgentError { code, message, .. })) => {
            assert_eq!(code, "agents.window_unpaid");
            message.rsplit(": ").next().unwrap().to_owned()
        }
        other => panic!("expected the window owed, got {other:?}"),
    }
}

fn partner_world(balance: &str) -> Option<World> {
    Some(World::new(
        TestDb::new()?,
        PartnerDoor::new(amt(balance)),
        true,
    ))
}

fn custodial_world() -> Option<World> {
    let door = PartnerDoor::new(0);
    door.with(|s| s.held_by = HeldBy::Ledger);
    let w = World::new(TestDb::new()?, door, true);
    w.ledger.deposit(USER, amt("1000"));
    w.ledger.deposit(OTHER, amt("1000"));
    Some(w)
}

macro_rules! world_or_skip {
    ($w:expr) => {
        match $w {
            Some(w) => w,
            None => {
                eprintln!("skipped: no TEST_DATABASE_URL");
                return;
            }
        }
    };
}

// ── partner-payment.money.test.ts ───────────────────────────────────────────

#[test]
fn a_partner_window_earns_once_is_paid_once_and_collected_once_however_many_times_it_is_settled() {
    let w = world_or_skip!(partner_world("10"));
    let (session, window) = w.ran(USER);
    let first = w.settle(&session, &window).unwrap();
    let again = w.settle(&session, &window).unwrap();
    let amount = first.amount;
    assert!(amount > 0);
    assert!(first.settled);
    assert!(!again.settled);
    assert_eq!(again.amount, amount);
    assert_eq!(
        w.door.with(|s| (s.balance, s.payments.len())),
        (amt("10") - amount, 1)
    );
    assert_eq!(w.ledger.house(), amount);
    assert_eq!(w.ledger.receivable(USER), 0);
    assert_eq!(w.ledger.reserve("test"), -amount);
    assert_eq!(
        w.ledger.available(USER),
        0,
        "no customer balance in our book"
    );
    assert_eq!(w.ledger.reasons(), ["charge.earned", "charge.collected"]);
    let (tx, paid_by, payment_ref, label, _) = w.window_row(&session);
    assert!(tx.is_some());
    assert_eq!(
        (paid_by.as_deref(), payment_ref.as_deref(), label.as_deref()),
        (
            Some("partner"),
            Some("test-partner-move-1"),
            Some("TEST partner bank")
        )
    );
    // The receipt keys are the recipes' own: one earn for the window, one collect on the partner's payment id.
    assert!(
        w.ledger
            .tx_of(&format!("charge:earned:agents:{session}.{window}"))
            .is_some()
    );
    assert!(
        w.ledger
            .tx_of(&format!(
                "charge:collected:partner-reserve:test:{ASSET}:test-partner-move-1"
            ))
            .is_some()
    );
}

#[test]
fn a_partner_refusal_leaves_the_window_earned_and_owed_and_the_next_settle_collects_it_once() {
    let w = world_or_skip!(partner_world("10"));
    let (session, window) = w.ran(USER);
    w.door.with(|s| s.refuse = Some("partner_unavailable"));
    assert_eq!(
        owed_reason(w.settle(&session, &window)),
        "partner_unavailable"
    );
    let amount = w.pending(&session, &window);
    assert_eq!(w.ledger.receivable(USER), -amount);
    assert_eq!(w.door.with(|s| s.balance), amt("10"));
    assert_eq!(w.window_row(&session).0, None);
    w.door.with(|s| s.refuse = None);
    assert!(w.settle(&session, &window).unwrap().settled);
    assert_eq!(w.door.with(|s| s.balance), amt("10") - amount);
    assert_eq!(w.ledger.receivable(USER), 0);
    assert_eq!(w.ledger.reasons(), ["charge.earned", "charge.collected"]);
}

#[test]
fn too_little_at_the_partner_refuses_by_name_and_moves_nothing() {
    let w = world_or_skip!(partner_world("0"));
    let (session, window) = w.ran(USER);
    assert_eq!(
        owed_reason(w.settle(&session, &window)),
        "insufficient_funds"
    );
    assert_eq!(w.door.with(|s| s.payments.len()), 0);
    assert_eq!(w.ledger.reasons(), ["charge.earned"]);
}

#[test]
fn an_owed_window_is_listed_as_unpaid_until_a_settle_collects_it() {
    // The runtime's `retryUnpaidWindows` and `closeSettled` read these two; their own cases come with `runtime`.
    let w = world_or_skip!(partner_world("10"));
    let (session, window) = w.ran(USER);
    w.door.with(|s| s.refuse = Some("insufficient_funds"));
    assert!(settle::settle_session(&w.m, w.pool(), &session, now()).is_err());
    let cost = w.pending(&session, &window);
    assert_eq!(
        meter::unpaid_windows(w.pool(), USER).unwrap(),
        vec![(session.clone(), window.clone(), cost)]
    );
    assert_eq!(
        meter::open_windows(w.pool(), &session).unwrap(),
        vec![window.clone()]
    );
    w.door.with(|s| s.refuse = None);
    let done = settle::settle_session(&w.m, w.pool(), &session, now()).unwrap();
    assert_eq!(done.len(), 1);
    assert!(meter::unpaid_windows(w.pool(), USER).unwrap().is_empty());
    assert!(meter::open_windows(w.pool(), &session).unwrap().is_empty());
    assert_eq!(w.door.with(|s| s.payments.len()), 1);
}

#[test]
fn a_lost_partner_answer_is_asked_again_under_the_same_key_one_payment_one_collect() {
    let w = world_or_skip!(partner_world("10"));
    let (session, window) = w.ran(USER);
    w.door.with(|s| s.lose_next_reply = true);
    assert_eq!(owed_reason(w.settle(&session, &window)), "reply_lost");
    let done = w.settle(&session, &window).unwrap();
    assert!(done.settled);
    assert_eq!(
        w.door.with(|s| (s.payments.len(), s.balance)),
        (1, amt("10") - done.amount)
    );
    assert_eq!(w.ledger.reasons(), ["charge.earned", "charge.collected"]);
}

#[test]
fn a_crash_after_the_collect_and_before_the_record_resumes_to_the_same_posts_nothing_twice() {
    let w = world_or_skip!(partner_world("10"));
    let (session, window) = w.ran(USER);
    w.settle(&session, &window).unwrap();
    w.db.client()
        .execute(
            "UPDATE agents.usage_windows SET charge_tx_id = NULL, paid_by = NULL, payment_ref = NULL, payment_label = NULL
              WHERE session_id = $1::text::uuid",
            &[&session],
        )
        .unwrap();
    assert!(w.settle(&session, &window).unwrap().settled);
    assert_eq!(w.door.with(|s| s.payments.len()), 1);
    assert_eq!(w.ledger.reasons(), ["charge.earned", "charge.collected"]);
}

#[test]
fn with_no_payment_method_the_window_is_earned_and_owed_and_no_partner_is_asked() {
    let w = world_or_skip!(partner_world("10"));
    w.door.with(|s| s.held_by = HeldBy::None);
    let (session, window) = w.ran(USER);
    assert_eq!(
        owed_reason(w.settle(&session, &window)),
        "no_payment_method"
    );
    assert_eq!(w.door.with(|s| s.collects), 0);
    assert_eq!(w.ledger.receivable(USER), -w.pending(&session, &window));
}

#[test]
fn an_unread_payment_method_posts_nothing_and_the_window_stays_sealed_and_unpaid() {
    let w = world_or_skip!(partner_world("10"));
    let (session, window) = w.ran(USER);
    w.door.with(|s| s.read_fails = true);
    assert_eq!(
        w.settle(&session, &window),
        Err(MeterError::PaymentUnavailable)
    );
    assert!(w.ledger.reasons().is_empty());
    assert_eq!(w.window_row(&session).0, None);
    assert_eq!(
        meter::open_windows(w.pool(), &session).unwrap(),
        vec![window]
    );
}

#[test]
fn on_the_custodial_layer_the_window_is_the_ledger_fee_charge() {
    let w = world_or_skip!(custodial_world());
    let (session, window) = w.ran(USER);
    assert!(w.settle(&session, &window).unwrap().settled);
    assert_eq!(w.door.with(|s| s.collects), 0);
    assert_eq!(w.ledger.reasons(), ["agents.usage.metered"]);
    assert_eq!(w.window_row(&session).1.as_deref(), Some("ledger"));
}

fn team(w: &World) -> (String, String) {
    let session = w.open(USER);
    w.db.client()
        .execute(
            "INSERT INTO agents.team_sessions (session_id, business_id, member_user_id, own_agent_id)
             VALUES ($1::text::uuid, $2::text::uuid, $3::text, 'own-test')",
            &[&session, &BUSINESS, &USER],
        )
        .unwrap();
    let window = w.record(&session, "team-r-1", 1200, 300, now()).unwrap();
    (session, window)
}

#[test]
fn a_team_run_is_owed_by_the_business_naming_the_member_and_collected_once_from_the_business() {
    let w = world_or_skip!(partner_world("10"));
    let (session, window) = team(&w);
    let first = w.settle(&session, &window).unwrap();
    let again = w.settle(&session, &window).unwrap();
    let amount = first.amount;
    assert!(amount > 0 && !again.settled);
    assert_eq!(
        w.door.with(|s| s.businesses.clone()),
        vec![Some(BUSINESS.to_owned()), Some(BUSINESS.to_owned())],
        "svc-bank is asked for the business's payment method, once, never the member's"
    );
    assert_eq!(
        w.door.with(|s| (s.payments.len(), s.balance)),
        (1, amt("10") - amount)
    );
    let journal = w.ledger.0.lock().unwrap().journal.clone();
    assert!(
        matches!(&journal[0], Recipe::ChargeEarn { user_id, member_user_id: Some(m), .. } if user_id == BUSINESS && m == USER)
    );
    assert!(
        matches!(&journal[1], Recipe::ChargeCollect { user_id, payment_id, .. } if user_id == BUSINESS && payment_id == "test-partner-move-1")
    );
    assert_eq!(journal.len(), 2);
    assert_eq!(w.ledger.house(), amount);
    assert_eq!(
        (w.ledger.receivable(BUSINESS), w.ledger.receivable(USER)),
        (0, 0)
    );
    assert_eq!(w.ledger.available(USER), 0);
    assert_eq!(w.ledger.reserve("test"), -amount);
    let row = w.window_row(&session);
    assert_eq!(
        (row.4.as_deref(), row.1.as_deref()),
        (Some(BUSINESS), Some("partner"))
    );
}

#[test]
fn a_team_window_the_business_cannot_pay_stays_owed_by_the_business_and_the_next_settle_collects_it()
 {
    let w = world_or_skip!(partner_world("10"));
    let (session, window) = team(&w);
    w.door.with(|s| s.refuse = Some("insufficient_funds"));
    assert_eq!(
        owed_reason(w.settle(&session, &window)),
        "insufficient_funds"
    );
    let amount = w.pending(&session, &window);
    assert_eq!(
        (w.ledger.receivable(BUSINESS), w.ledger.receivable(USER)),
        (-amount, 0)
    );
    assert_eq!(w.window_row(&session).4.as_deref(), Some(BUSINESS));
    assert_eq!(w.door.with(|s| s.balance), amt("10"));
    w.door.with(|s| s.refuse = None);
    assert!(w.settle(&session, &window).unwrap().settled);
    assert_eq!(w.ledger.receivable(BUSINESS), 0);
    assert_eq!(w.ledger.reasons(), ["charge.earned", "charge.collected"]);
}

#[test]
fn on_the_custodial_layer_a_team_run_is_the_members_fee_charge_and_owed_by_no_business() {
    let w = world_or_skip!(custodial_world());
    let (session, window) = team(&w);
    assert!(w.settle(&session, &window).unwrap().settled);
    assert_eq!(w.door.with(|s| s.collects), 0);
    assert_eq!(w.ledger.reasons(), ["agents.usage.metered"]);
    assert_eq!(w.window_row(&session).4, None);
}

// ── runtime.test.ts, metering ───────────────────────────────────────────────

#[test]
fn a_window_is_charged_exactly_its_priced_cost_under_its_business_key() {
    let w = world_or_skip!(custodial_world());
    let (session, window) = w.ran(USER);
    let expected = pricing::window_cost(&[UsageGroup {
        input_tokens: 1200,
        output_tokens: 300,
        price: price(),
    }])
    .unwrap();
    assert!(expected > 0);
    let s = w.settle(&session, &window).unwrap();
    assert_eq!(s.amount, expected);
    assert_eq!(s.charge_key, charge_key_for(&session, &window));
    assert_eq!(s.charge_key, format!("agent.usage:{session}:{window}"));
    assert_eq!(w.ledger.house(), expected);
    assert_eq!(w.ledger.available(USER), amt("1000") - expected);
    // The ledger's own key namespaces it under the module; its transaction is the one the window records.
    assert_eq!(
        w.ledger.tx_of(&format!("fee:agents:{}", s.charge_key)),
        s.charge_tx_id
    );
    assert_eq!(w.window_row(&session).0, s.charge_tx_id);
}

#[test]
fn token_counts_are_summed_across_calls_and_rounded_once_not_once_per_call() {
    let w = world_or_skip!(custodial_world());
    let session = w.open(USER);
    let at = now();
    let window = w.record(&session, "r-a", 7, 3, at).unwrap();
    w.record(&session, "r-b", 11, 5, at).unwrap();
    let s = w.settle(&session, &window).unwrap();
    let once = pricing::window_cost(&[UsageGroup {
        input_tokens: 18,
        output_tokens: 8,
        price: price(),
    }])
    .unwrap();
    let per_call = pricing::token_cost(7, amt("3")).unwrap()
        + pricing::token_cost(3, amt("15")).unwrap()
        + pricing::token_cost(11, amt("3")).unwrap()
        + pricing::token_cost(5, amt("15")).unwrap();
    assert_eq!(s.amount, once);
    assert!(s.amount <= per_call);
}

#[test]
fn a_retried_completion_is_counted_once() {
    let w = world_or_skip!(custodial_world());
    let session = w.open(USER);
    let at = now();
    let window = w.record(&session, "retry-me", 1200, 300, at).unwrap();
    assert_eq!(
        w.record(&session, "retry-me", 1200, 300, at).unwrap(),
        window
    );
    assert_eq!(
        w.count(
            "SELECT count(*) FROM agents.usage_records WHERE session_id = $1::text::uuid",
            &session
        ),
        1
    );
    assert!(meter::has_request(w.pool(), &session, "retry-me").unwrap());
    // The claim on a request id is the unique insert: a second claim loses, a released one can be claimed again.
    assert!(meter::claim_request(w.pool(), &session, "c-1").unwrap());
    assert!(!meter::claim_request(w.pool(), &session, "c-1").unwrap());
    meter::release_claim(w.pool(), &session, "c-1").unwrap();
    assert!(meter::claim_request(w.pool(), &session, "c-1").unwrap());
}

#[test]
fn a_window_is_settled_exactly_once_however_many_times_settlement_runs() {
    let w = world_or_skip!(custodial_world());
    let (session, window) = w.ran(USER);
    let first = w.settle(&session, &window).unwrap();
    let second = w.settle(&session, &window).unwrap();
    let third = w.settle(&session, &window).unwrap();
    assert!(first.settled && !second.settled && !third.settled);
    assert_eq!(second.amount, first.amount);
    assert_eq!(w.ledger.house(), first.amount);
    assert_eq!(w.ledger.reasons(), ["agents.usage.metered"]);
    // One settlement, one log row and one event.
    assert_eq!(
        w.count(
            "SELECT count(*) FROM agents.agent_actions WHERE session_id = $1::text::uuid AND kind = 'usage_settlement'",
            &session
        ),
        1
    );
    assert_eq!(w.bus.0.lock().unwrap().len(), 1);
}

#[test]
fn two_settles_of_one_window_at_once_post_one_charge_and_only_one_reports_it() {
    let w = world_or_skip!(custodial_world());
    let (session, window) = w.ran(USER);
    w.ledger.1.hold(2);
    let (a, b) = std::thread::scope(|s| {
        let a = s.spawn(|| w.settle(&session, &window).unwrap());
        let b = s.spawn(|| w.settle(&session, &window).unwrap());
        (a.join().unwrap(), b.join().unwrap())
    });
    assert_eq!(
        a.charge_tx_id, b.charge_tx_id,
        "the ledger key keeps one charge"
    );
    assert_eq!(
        u8::from(a.settled) + u8::from(b.settled),
        1,
        "only the one that records the id settles"
    );
    assert_eq!(w.ledger.reasons(), ["agents.usage.metered"]);
    assert_eq!(w.ledger.house(), a.amount);
    assert_eq!(
        w.count(
            "SELECT count(*) FROM agents.agent_actions WHERE session_id = $1::text::uuid AND kind = 'usage_settlement'",
            &session
        ),
        1
    );
    assert_eq!(w.bus.0.lock().unwrap().len(), 1);
}

#[test]
fn a_sealed_but_unbilled_window_is_recovered_by_settle_session() {
    let w = world_or_skip!(custodial_world());
    let (session, window) = w.ran(USER);
    let expected = w.pending(&session, &window);
    w.db.client()
        .execute(
            "UPDATE agents.usage_windows SET sealed_at = now(), charged_amount = $2::text::numeric,
                    charge_key = $3::text, charge_tx_id = NULL
              WHERE session_id = $1::text::uuid",
            &[
                &session,
                &format_amount(expected),
                &charge_key_for(&session, &window),
            ],
        )
        .unwrap();
    assert_eq!(
        meter::open_windows(w.pool(), &session).unwrap(),
        vec![window.clone()]
    );
    let s = settle::settle_session(&w.m, w.pool(), &session, now()).unwrap();
    assert_eq!(s.len(), 1);
    assert_eq!(
        (s[0].window_id.as_str(), s[0].amount, s[0].settled),
        (window.as_str(), expected, true)
    );
    assert!(s[0].charge_tx_id.is_some());
    assert!(meter::open_windows(w.pool(), &session).unwrap().is_empty());
    assert!(
        settle::settle_session(&w.m, w.pool(), &session, now())
            .unwrap()
            .is_empty()
    );
    assert_eq!(w.ledger.house(), expected);
}

#[test]
fn a_sealed_window_refuses_further_usage() {
    let w = world_or_skip!(custodial_world());
    let session = w.open(USER);
    let at = now();
    let window = w.record(&session, "r-a", 1200, 300, at).unwrap();
    let s = w.settle(&session, &window).unwrap();
    match w.record(&session, "r-late", 10, 10, at) {
        Err(MeterError::Agent(a)) => assert_eq!(
            (a.code, a.user_key.as_str()),
            ("agents.window_sealed", "agents.error.window_sealed")
        ),
        other => panic!("expected window_sealed, got {other:?}"),
    }
    assert!(meter::is_sealed(w.pool(), &session, &window).unwrap());
    assert_eq!(w.settle(&session, &window).unwrap().amount, s.amount);
    assert_eq!(w.ledger.house(), s.amount);
}

#[test]
fn metering_off_settle_posts_nothing_for_windows_left_from_metering_on() {
    let mut w = world_or_skip!(custodial_world());
    let (session, window) = w.ran(USER);
    w.m.enabled = false;
    let attempt = w.settle(&session, &window).unwrap();
    assert!(!attempt.settled);
    assert_eq!((attempt.amount, attempt.charge_tx_id), (0, None));
    assert_eq!(attempt.charge_key, charge_key_for(&session, &window));
    assert_eq!(w.ledger.available(USER), amt("1000"));
    assert_eq!(w.ledger.house(), 0);
    assert_eq!(
        meter::open_windows(w.pool(), &session).unwrap(),
        vec![window.clone()]
    );
    assert!(!meter::is_sealed(w.pool(), &session, &window).unwrap());
    let all = settle::settle_session(&w.m, w.pool(), &session, now()).unwrap();
    assert!(!all.is_empty());
    assert!(
        all.iter()
            .all(|r| !r.settled && r.amount == 0 && r.charge_tx_id.is_none())
    );
    assert_eq!(w.ledger.house(), 0);
    assert!(w.bus.0.lock().unwrap().is_empty());
}

#[test]
fn each_users_meter_is_their_own() {
    let w = world_or_skip!(custodial_world());
    let (a, wa) = w.ran(USER);
    w.ran(OTHER);
    w.settle(&a, &wa).unwrap();
    assert_eq!(w.ledger.available(OTHER), amt("1000"));
    assert_eq!(meter::unpaid_windows(w.pool(), OTHER).unwrap(), vec![]);
}

#[test]
fn a_settlement_appends_one_chained_log_row_and_publishes_the_settled_window() {
    let w = world_or_skip!(custodial_world());
    let (session, window) = w.ran(USER);
    let s = w.settle(&session, &window).unwrap();
    let row = w
        .db
        .client()
        .query_one(
            "SELECT user_id, agent_id, sequence, kind::text, status::text, cost::text, user_message_key,
                    user_message_params::text, prev_hash, hash,
                    to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')
               FROM agents.agent_actions WHERE session_id = $1::text::uuid",
            &[&session],
        )
        .unwrap();
    let (kind, status, key): (String, String, String) = (row.get(3), row.get(4), row.get(6));
    assert_eq!(
        (kind.as_str(), status.as_str(), key.as_str()),
        ("usage_settlement", "executed", "agents.usage.settled")
    );
    assert_eq!(parse_amount(&row.get::<_, String>(5)).unwrap(), s.amount);
    let params = json::parse(&row.get::<_, String>(7)).unwrap();
    assert_eq!(
        params.get("amount"),
        Some(&Json::str(format_amount(s.amount)))
    );
    assert_eq!(params.get("asset"), Some(&Json::str(ASSET)));
    // The hash is the chain's: recomputed from the stored row it matches.
    let occurred = service_kit::time::js_date(&row.get::<_, String>(10)).unwrap();
    let (user, agent): (String, String) = (row.get(0), row.get(1));
    let recomputed = audit::hash_action(
        &audit::Hashable {
            session_id: &session,
            user_id: &user,
            agent_id: &agent,
            sequence: i64::from(row.get::<_, i32>(2)),
            kind: &kind,
            status: &status,
            tool: None,
            task: None,
            provider_id: None,
            model: None,
            input_tokens: 0,
            output_tokens: 0,
            cost: s.amount,
            refusal_code: None,
            user_message_key: &key,
            params: &[
                audit::param("amount", format_amount(s.amount)),
                audit::param("asset", ASSET),
            ],
            input_digest: None,
            output_digest: None,
            occurred_at: occurred,
        },
        row.get::<_, Option<String>>(8).as_deref(),
    );
    assert_eq!(recomputed, row.get::<_, String>(9));
    let published = w.bus.0.lock().unwrap().clone();
    assert_eq!(published.len(), 1);
    let (subject, msg_id, env) = &published[0];
    assert_eq!(
        (subject.as_str(), msg_id.as_str()),
        ("intafaced.agents.usage.settled", s.charge_key.as_str())
    );
    let payload = env.get("payload").unwrap();
    assert_eq!(payload.get("sessionId"), Some(&Json::str(session.clone())));
    assert_eq!(payload.get("userId"), Some(&Json::str(USER)));
    assert_eq!(
        payload.get("amount"),
        Some(&Json::str(format_amount(s.amount)))
    );
    assert_eq!(
        payload.get("chargeKey"),
        Some(&Json::str(s.charge_key.clone()))
    );
    assert_eq!(
        env.get("idempotencyKey"),
        Some(&Json::str(s.charge_key.clone()))
    );
}

#[test]
fn a_free_window_seals_with_no_charge_logs_it_free_and_publishes_nothing() {
    let w = world_or_skip!(custodial_world());
    let session = w.open(USER);
    let window = w.record(&session, "r-0", 0, 0, now()).unwrap();
    let s = w.settle(&session, &window).unwrap();
    assert!(s.settled);
    assert_eq!((s.amount, s.charge_tx_id), (0, None));
    assert!(w.ledger.reasons().is_empty());
    assert!(meter::open_windows(w.pool(), &session).unwrap().is_empty());
    assert_eq!(
        w.count(
            "SELECT count(*) FROM agents.agent_actions WHERE session_id = $1::text::uuid AND user_message_key = 'agents.usage.free'",
            &session
        ),
        1
    );
    assert!(w.bus.0.lock().unwrap().is_empty());
}

#[test]
fn a_window_the_ledger_refuses_stays_sealed_and_unpaid_on_its_key_and_is_charged_once_when_funded()
{
    let w = world_or_skip!(custodial_world());
    let session = w.open(USER);
    let window = w
        .record(&session, "r-big", 400_000_000_000, 0, now())
        .unwrap();
    match w.settle(&session, &window) {
        Err(MeterError::Ledger(l)) => {
            assert_eq!(l.code.as_deref(), Some("ledger.insufficient_funds"))
        }
        other => panic!("expected the ledger's refusal, got {other:?}"),
    }
    let cost = w.pending(&session, &window);
    assert!(meter::is_sealed(w.pool(), &session, &window).unwrap());
    assert_eq!(
        meter::unpaid_windows(w.pool(), USER).unwrap(),
        vec![(session.clone(), window.clone(), cost)]
    );
    w.ledger.deposit(USER, cost);
    let s = w.settle(&session, &window).unwrap();
    assert!(s.settled);
    assert_eq!(w.ledger.reasons(), ["agents.usage.metered"]);
    assert!(meter::unpaid_windows(w.pool(), USER).unwrap().is_empty());
}

#[test]
fn the_usage_page_reads_open_unpaid_and_settled_windows_and_sums_sealed_days() {
    let w = world_or_skip!(partner_world("10"));
    let (paid_session, paid_window) = w.ran(USER);
    w.settle(&paid_session, &paid_window).unwrap();
    let (owed_session, owed_window) = w.ran(USER);
    w.door.with(|s| s.refuse = Some("insufficient_funds"));
    let _ = w.settle(&owed_session, &owed_window);
    let (open_session, _) = w.ran(USER);
    let views = meter::windows_of(&w.m, w.pool(), USER, "probe", 10).unwrap();
    let state_of = |s: &str| views.iter().find(|v| v.session_id == s).unwrap().state;
    assert_eq!(
        (
            state_of(&paid_session),
            state_of(&owed_session),
            state_of(&open_session)
        ),
        ("settled", "unpaid", "open")
    );
    assert!(
        views
            .iter()
            .find(|v| v.session_id == open_session)
            .unwrap()
            .amount
            .is_none()
    );
    let days = meter::usage_by_day(&w.m, w.pool(), USER, &["probe".to_owned()]).unwrap();
    assert_eq!(days.len(), 1);
    assert_eq!(days[0].windows, 2);
    assert_eq!(
        days[0].amount,
        w.pending(&paid_session, &paid_window) + w.pending(&owed_session, &owed_window)
    );
    assert!(
        meter::usage_by_day(&w.m, w.pool(), USER, &[])
            .unwrap()
            .is_empty()
    );
}

// ── sealed-usage-race.test.ts ───────────────────────────────────────────────

#[test]
fn usage_still_waiting_when_the_window_seals_is_refused_as_sealed() {
    let w = world_or_skip!(custodial_world());
    let session = w.open(USER);
    let at = now();
    let window = w.record(&session, "r-a", 1000, 500, at).unwrap();
    let mut seal = w.db.client();
    let mut tx = seal.transaction().unwrap();
    tx.query(
        "SELECT sealed_at FROM agents.usage_windows WHERE session_id = $1::text::uuid AND window_id = $2::text FOR UPDATE",
        &[&session, &window],
    )
    .unwrap();
    std::thread::scope(|scope| {
        let late = scope.spawn(|| w.record(&session, "req-overlaps-seal", 1000, 500, at));
        // The usage insert waits on the window row's lock.
        let mut probe = w.db.client();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            let waiting: i64 = probe
                .query_one(
                    "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()
                       AND application_name = 'svc-agents-metering-test' AND wait_event_type = 'Lock'",
                    &[],
                )
                .unwrap()
                .get(0);
            if waiting > 0 {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "the usage insert never waited on the seal's lock"
            );
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        tx.execute(
            "UPDATE agents.usage_windows SET sealed_at = now(), charged_amount = 1.25, charge_key = 'k'
              WHERE session_id = $1::text::uuid AND window_id = $2::text",
            &[&session, &window],
        )
        .unwrap();
        tx.commit().unwrap();
        match late.join().unwrap() {
            Err(MeterError::Agent(a)) => assert_eq!(a.code, "agents.window_sealed"),
            other => panic!("expected window_sealed, got {other:?}"),
        }
    });
    assert_eq!(
        w.count(
            "SELECT count(*) FROM agents.usage_records WHERE session_id = $1::text::uuid AND request_id = 'req-overlaps-seal'",
            &session
        ),
        0
    );
}

// ── spend/store.test.ts, the caps ───────────────────────────────────────────

fn caps(call: &str, session: &str, period_cap: &str, key: &str) -> spend::SetInput {
    let some = |s: &str| Some(s.to_owned());
    spend::SetInput {
        asset_id: some("IFC"),
        per_call: some(call),
        per_session: some(session),
        per_period: some(period_cap),
        period: some("week"),
        idempotency_key: some(key),
    }
}

#[test]
fn an_unset_cap_reads_as_none_never_zero() {
    let db = db_or_skip!();
    let store = db.store();
    assert_eq!(spend::get(store.pool().unwrap(), USER).unwrap(), None);
}

#[test]
fn an_explicit_zero_is_stored_and_the_same_request_replays_as_one_write() {
    let db = db_or_skip!();
    let store = db.store();
    let pool = store.pool().unwrap();
    let (first, replayed) = spend::set(pool, USER, &caps("0", "0.0", "0", "set-caps")).unwrap();
    assert!(!replayed);
    assert_eq!(
        first.to_json().compact(),
        r#"{"assetId":"IFC","perCall":"0","perSession":"0","perPeriod":"0","period":"week"}"#
    );
    let (again, replayed) = spend::set(pool, USER, &caps("0.00", "0", "0.0", "set-caps")).unwrap();
    assert!(replayed);
    assert_eq!(again.per_call, 0);
    let mut c = db.client();
    let n = |c: &mut Client, sql: &str| -> i64 { c.query_one(sql, &[&USER]).unwrap().get(0) };
    assert_eq!(
        n(
            &mut c,
            "SELECT count(*) FROM agents.user_spend_limits WHERE user_id = $1::text"
        ),
        1
    );
    assert_eq!(
        n(
            &mut c,
            "SELECT count(*) FROM agents.spend_limit_requests WHERE user_id = $1::text"
        ),
        1
    );
}

#[test]
fn the_same_key_with_another_body_is_refused_and_the_stored_cap_stays() {
    let db = db_or_skip!();
    let store = db.store();
    let pool = store.pool().unwrap();
    spend::set(pool, USER, &caps("2", "3", "4", "set-caps")).unwrap();
    match spend::set(pool, USER, &caps("9", "3", "4", "set-caps")) {
        Err(spend::SpendError::Agent(a)) => assert_eq!(a.code, "agents.spend_idempotency_conflict"),
        other => panic!("expected a conflict, got {other:?}"),
    }
    assert_eq!(spend::get(pool, USER).unwrap().unwrap().per_call, amt("2"));
}

#[test]
fn two_identical_concurrent_sets_leave_one_row() {
    let db = db_or_skip!();
    let store = db.store();
    let pool = store.pool().unwrap();
    let (a, b) = std::thread::scope(|s| {
        let a = s.spawn(|| {
            spend::set(pool, USER, &caps("2", "3", "4", "set-caps"))
                .unwrap()
                .1
        });
        let b = s.spawn(|| {
            spend::set(pool, USER, &caps("2", "3", "4", "set-caps"))
                .unwrap()
                .1
        });
        (a.join().unwrap(), b.join().unwrap())
    });
    let mut both = [a, b];
    both.sort_unstable();
    assert_eq!(both, [false, true]);
    let n: i64 = db
        .client()
        .query_one("SELECT count(*) FROM agents.user_spend_limits", &[])
        .unwrap()
        .get(0);
    assert_eq!(n, 1);
}

// ── Through the door ────────────────────────────────────────────────────────

struct Caller<'a> {
    user: &'a str,
    scopes: &'a [&'a str],
    kid: Option<&'a str>,
}

fn person(user: &str) -> Caller<'_> {
    Caller {
        user,
        scopes: &["agents:read", "agents:execute", "identity:write"],
        kid: None,
    }
}

fn principal(c: &Caller<'_>) -> Vec<(String, String)> {
    let mut fields = vec![
        ("sub", Json::str(c.user)),
        ("userId", Json::str(c.user)),
        ("sid", Json::str("22222222-2222-4222-8222-222222222222")),
        (
            "scopes",
            Json::Array(c.scopes.iter().map(|s| Json::str(*s)).collect()),
        ),
        ("tier", Json::str("full")),
        ("mfa", Json::Bool(false)),
        ("expiresAt", Json::str("2099-01-01T00:00:00.000Z")),
    ];
    if let Some(kid) = c.kid {
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

fn door_of(w: World) -> (AgentsDoor, FakeLedger, TestDb) {
    let env: BTreeMap<String, String> = [
        ("APP_ENV", "test"),
        ("NODE_ENV", "test"),
        ("INTAFACED_SCREENING_FAIL_CLOSED", "off"),
        ("INTAFACED_UNSIGNED_SANCTIONS_ROWS", "off"),
    ]
    .iter()
    .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
    .collect();
    let World {
        db,
        store,
        m,
        ledger,
        ..
    } = w;
    let door = AgentsDoor::new(DoorConfig {
        edge_secret: SECRET.to_owned(),
        services: ServiceAuth {
            secret: Some(SERVICE_SECRET.to_owned()),
            keys: None,
        },
        env,
        now,
        store,
        gateway: svc_agents::gateway::desk::GatewaySlice::unwired("USDC"),
        ready: svc_agents::gateway::readiness::ReadyInput::unwired(),
        metering: m,
        runtime: svc_agents::runtime::Runtime::unwired(),
        ops: svc_agents::ops::Ops::unwired(),
        background: svc_agents::background::Settings::default(),
        advisors: svc_agents::advisors::Advisors::unwired(),
        team: svc_agents::team::Team::unwired(),
    })
    .unwrap();
    (door, ledger, db)
}

fn query(door: &AgentsDoor, path: &str, input: &Json, headers: &[(String, String)]) -> (u16, Json) {
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
    let url = format!("/trpc/{path}?input={enc}");
    let res = door.handle(&Request {
        method: "GET",
        url: &url,
        headers,
        body: "",
    });
    (res.status, json::parse(&res.body).unwrap())
}

fn mutate(
    door: &AgentsDoor,
    path: &str,
    input: &Json,
    mut headers: Vec<(String, String)>,
) -> (u16, Json) {
    let body = input.compact();
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

fn data(answer: &(u16, Json)) -> Json {
    assert_eq!(answer.0, 200, "{}", answer.1.compact());
    answer
        .1
        .get("result")
        .and_then(|r| r.get("data"))
        .cloned()
        .unwrap()
}

fn error_of(answer: &(u16, Json)) -> (u16, String, Option<String>) {
    let e = answer.1.get("error").unwrap();
    let message = match e.get("message") {
        Some(Json::String(m)) => m.clone(),
        _ => String::new(),
    };
    let cause = match e
        .get("data")
        .and_then(|d| d.get("cause"))
        .and_then(|c| c.get("code"))
    {
        Some(Json::String(c)) => Some(c.clone()),
        _ => None,
    };
    (answer.0, message, cause)
}

#[test]
fn the_door_refuses_a_blank_cap_and_reads_only_the_callers_own() {
    let db = db_or_skip!();
    let (door, _, db) = door_of(World::new(db, PartnerDoor::new(0), true));
    let me = principal(&person(USER));
    let set = |key: &str, call: &str| {
        Json::obj([
            ("idempotencyKey", Json::str(key)),
            ("assetId", Json::str("IFC")),
            ("perCall", Json::str(call)),
            ("perSession", Json::str("1")),
            ("perPeriod", Json::str("1")),
            ("period", Json::str("day")),
        ])
    };
    assert_eq!(
        error_of(&mutate(
            &door,
            "spend.limits.set",
            &set("door", ""),
            me.clone()
        )),
        (
            403,
            "agents.refused.spend_limit_unset".to_owned(),
            Some("agents.spend_limit_unset".to_owned())
        )
    );
    assert_eq!(
        data(&query(&door, "spend.limits.get", &Json::Null, &me)).compact(),
        r#"{"limits":null}"#
    );
    let set_ok = data(&mutate(
        &door,
        "spend.limits.set",
        &set("door-2", "1"),
        me.clone(),
    ));
    assert_eq!(set_ok.get("replayed"), Some(&Json::Bool(false)));
    assert_eq!(
        data(&query(&door, "spend.limits.get", &Json::Null, &me)).compact(),
        r#"{"limits":{"assetId":"IFC","perCall":"1","perSession":"1","perPeriod":"1","period":"day"}}"#
    );
    assert_eq!(
        spend::get(door.store().pool().unwrap(), OTHER).unwrap(),
        None
    );
    drop(db);
}

#[test]
fn only_the_person_sets_a_cap_and_no_hold_is_a_public_call() {
    let db = db_or_skip!();
    let (door, _, _db) = door_of(World::new(db, PartnerDoor::new(0), true));
    let raise = Json::obj([
        ("idempotencyKey", Json::str("agent-raise")),
        ("assetId", Json::str("IFC")),
        ("perCall", Json::str("9")),
        ("perSession", Json::str("9")),
        ("perPeriod", Json::str("9")),
        ("period", Json::str("day")),
    ]);
    let refused = |c: Caller<'_>| mutate(&door, "spend.limits.set", &raise, principal(&c)).0;
    assert_eq!(
        refused(Caller {
            user: USER,
            scopes: &["agents:execute"],
            kid: None
        }),
        403
    );
    assert_eq!(
        refused(Caller {
            user: USER,
            scopes: &["agents:execute", "agents:read"],
            kid: None
        }),
        403
    );
    assert_eq!(
        refused(Caller {
            user: USER,
            scopes: &["agents:read", "identity:write", "agents:execute"],
            kid: Some("66666666-6666-4666-8666-666666666666"),
        }),
        403
    );
    assert_eq!(
        spend::get(door.store().pool().unwrap(), USER).unwrap(),
        None
    );
    for hold in [
        "spend.reserve",
        "spend.commit",
        "spend.release",
        "spend.limits.release",
    ] {
        assert!(
            svc_agents::door::call(hold).is_none(),
            "{hold} is not a call"
        );
    }
}

#[test]
fn usage_current_reads_the_callers_own_session_and_nobody_elses() {
    let w = world_or_skip!(custodial_world());
    let session = w.open(USER);
    let window = w.record(&session, "r-1", 1200, 300, now()).unwrap();
    let pending = w.pending(&session, &window);
    let (door, _, _db) = door_of(w);
    let input = Json::obj([("sessionId", Json::str(session.clone()))]);
    let answer = data(&query(
        &door,
        "usage.current",
        &input,
        &principal(&person(USER)),
    ));
    assert_eq!(answer.get("windowId"), Some(&Json::str(window)));
    assert_eq!(
        answer.get("pending"),
        Some(&Json::str(format_amount(pending)))
    );
    assert_eq!(
        answer.get("sessionTotal"),
        Some(&Json::str(format_amount(pending)))
    );
    assert_eq!(answer.get("assetId"), Some(&Json::str(ASSET)));
    assert_eq!(
        error_of(&query(
            &door,
            "usage.current",
            &input,
            &principal(&person(OTHER))
        )),
        (404, "agents.refused.session_closed".to_owned(), None)
    );
    let unknown = Json::obj([(
        "sessionId",
        Json::str("99999999-9999-4999-8999-999999999999"),
    )]);
    assert_eq!(
        error_of(&query(
            &door,
            "usage.current",
            &unknown,
            &principal(&person(USER))
        ))
        .0,
        404
    );
}

fn signed_as(service: &str, path: &str, body: &str) -> Vec<(String, String)> {
    CallSigner::new(service, "svc-agents", SERVICE_SECRET, None)
        .sign(body, "POST", &format!("/trpc/{path}"), "application/json")
        .unwrap()
}

#[test]
fn usage_settle_is_svc_agents_own_sweep_and_charges_once() {
    let w = world_or_skip!(custodial_world());
    let (session, window) = w.ran(USER);
    let expected = w.pending(&session, &window);
    let (door, ledger, _db) = door_of(w);
    let input = Json::obj([
        ("sessionId", Json::str(session.clone())),
        ("windowId", Json::str(window.clone())),
    ]);
    let body = input.compact();
    // svc-trade's own signature is refused, and nothing is charged.
    let trade = mutate(
        &door,
        "usage.settle",
        &input,
        signed_as("svc-trade", "usage.settle", &body),
    );
    assert_eq!(trade.0, 403);
    assert_eq!(ledger.house(), 0);
    let first = data(&mutate(
        &door,
        "usage.settle",
        &input,
        signed_as("svc-agents", "usage.settle", &body),
    ));
    assert_eq!(
        first.compact(),
        Json::obj([
            ("amount", Json::str(format_amount(expected))),
            ("assetId", Json::str(ASSET)),
            ("chargeKey", Json::str(charge_key_for(&session, &window))),
            ("settled", Json::Bool(true)),
        ])
        .compact()
    );
    let again = data(&mutate(
        &door,
        "usage.settle",
        &input,
        signed_as("svc-agents", "usage.settle", &body),
    ));
    assert_eq!(again.get("settled"), Some(&Json::Bool(false)));
    assert_eq!(ledger.house(), expected);
    let whole = Json::obj([("sessionId", Json::str(session.clone()))]);
    let all = data(&mutate(
        &door,
        "usage.settleSession",
        &whole,
        signed_as("svc-agents", "usage.settleSession", &whole.compact()),
    ));
    assert_eq!(
        all.compact(),
        format!(r#"{{"assetId":"{ASSET}","settlements":[]}}"#)
    );
    // A window that is not there is the domain's refusal, by its code.
    let missing = Json::obj([
        ("sessionId", Json::str(session)),
        ("windowId", Json::str("2020-01-01#0000")),
    ]);
    assert_eq!(
        error_of(&mutate(
            &door,
            "usage.settle",
            &missing,
            signed_as("svc-agents", "usage.settle", &missing.compact())
        )),
        (
            400,
            "agents.error.window_sealed".to_owned(),
            Some("agents.window_not_found".to_owned())
        )
    );
}

// ── review.db.test.ts, the dashboard and the usage summary ──────────────────

fn today() -> String {
    now().iso()[0..10].to_owned()
}

/// A session with one executed action and `refusals` refused ones, its window sealed and settled.
fn reviewed_session(w: &World, user: &str, refusals: usize) -> String {
    let (session, window) = w.ran(user);
    let mut c = w.db.client();
    for n in 0..=refusals {
        let (status, code) = if n == 0 {
            ("executed", None)
        } else {
            ("refused", Some("agents.refused.task_not_allowed"))
        };
        c.execute(
            "INSERT INTO agents.agent_actions (session_id, user_id, agent_id, sequence, kind, status, refusal_code,
                                               user_message_key, hash)
             VALUES ($1::text::uuid, $2::text, 'probe', $3::text::int, 'completion', $4::text::agents.action_status,
                     $5::text, 'agents.test', md5($1::text || $3::text))",
            &[&session, &user, &(n + 100).to_string(), &status, &code],
        )
        .unwrap();
    }
    w.settle(&session, &window).unwrap();
    session
}

fn sealed_sum(w: &World, user: &str) -> Amount {
    let t: String = w
        .db
        .client()
        .query_one(
            "SELECT coalesce(sum(w.charged_amount), 0)::text FROM agents.usage_windows w
               JOIN agents.agent_sessions s ON s.id = w.session_id WHERE s.user_id = $1::text AND w.sealed_at IS NOT NULL",
            &[&user],
        )
        .unwrap()
        .get(0);
    amt(&t)
}

#[test]
fn the_dashboard_equals_the_stored_rows_and_test_runs_stay_out_unless_asked_for() {
    let w = world_or_skip!(custodial_world());
    reviewed_session(&w, USER, 3);
    reviewed_session(&w, USER, 1);
    reviewed_session(&w, OTHER, 5);
    let mut c = w.db.client();
    let agent: String = c
        .query_one(
            "INSERT INTO agents.own_agents (owner_id, template, name, create_key) VALUES ($1::text, 'blank', 'TEST helper', 'review:me')
             RETURNING id::text",
            &[&USER],
        )
        .unwrap()
        .get(0);
    c.execute(
        "INSERT INTO agents.own_agent_test_runs (agent_id, owner_id, request_id, request_key, kind, tool, input_json, checks_json, effect_json)
         VALUES ($1::text::uuid, $2::text, 'r1', 'agents:test-run:r1', 'dry_run', 'trade.quote', '{}', '[]', '{}')",
        &[&agent, &USER],
    )
    .unwrap();
    let counts: BTreeMap<String, i64> = c
        .query("SELECT status::text, count(*) FROM agents.agent_actions WHERE user_id = $1::text GROUP BY 1", &[&USER])
        .unwrap()
        .iter()
        .map(|r| (r.get(0), r.get(1)))
        .collect();
    let sealed = sealed_sum(&w, USER);
    let (door, _, _db) = door_of(w);
    let me = principal(&person(USER));
    let range = |test: bool| {
        let mut f = vec![("from", Json::str(today())), ("to", Json::str(today()))];
        if test {
            f.push(("includeTest", Json::Bool(true)));
        }
        Json::Object(f.into_iter().map(|(k, v)| (k.to_owned(), v)).collect())
    };
    let live = data(&query(&door, "analytics.summary", &range(false), &me));
    let totals = live.get("totals").unwrap();
    let n = |k: &str| counts.get(k).copied().unwrap_or(0);
    assert_eq!(live.get("includesTest"), Some(&Json::Bool(false)));
    assert_eq!(totals.get("sessions"), Some(&Json::int(2)));
    assert_eq!(
        totals.get("actions"),
        Some(&Json::int(n("executed") + n("refused") + n("failed")))
    );
    assert_eq!(totals.get("executed"), Some(&Json::int(n("executed"))));
    assert_eq!(totals.get("refused"), Some(&Json::int(4)));
    assert_eq!(totals.get("testRuns"), Some(&Json::Null));
    let days = match live.get("days") {
        Some(Json::Array(d)) => d.clone(),
        _ => panic!(),
    };
    assert_eq!(days.len(), 1);
    assert_eq!(days[0].get("day"), Some(&Json::str(today())));
    let spend = match totals.get("spend") {
        Some(Json::Array(s)) => s.clone(),
        _ => panic!(),
    };
    assert_eq!(spend.len(), 1);
    let spent = match spend[0].get("amount") {
        Some(Json::String(a)) => amt(a),
        _ => panic!(),
    };
    assert_eq!(spent, sealed);
    assert!(spent > 0);
    let with_test = data(&query(&door, "analytics.summary", &range(true), &me));
    assert_eq!(
        with_test.get("totals").unwrap().get("testRuns"),
        Some(&Json::int(1))
    );
}

#[test]
fn a_blank_or_bad_range_refuses_by_name_and_an_empty_range_is_empty() {
    let w = world_or_skip!(custodial_world());
    reviewed_session(&w, USER, 0);
    let (door, _, _db) = door_of(w);
    let me = principal(&person(USER));
    let ask = |from: Option<&str>, to: &str| {
        let mut f = Vec::new();
        if let Some(from) = from {
            f.push(("from".to_owned(), Json::str(from)));
        }
        f.push(("to".to_owned(), Json::str(to)));
        query(&door, "analytics.summary", &Json::Object(f), &me)
    };
    assert_eq!(
        error_of(&ask(None, &today())).1,
        "agents.refused.analytics_from_unset"
    );
    assert_eq!(
        error_of(&ask(Some(&today()), " ")).1,
        "agents.refused.analytics_to_unset"
    );
    assert_eq!(
        error_of(&ask(Some("2026-02-30"), &today())).1,
        "agents.refused.analytics_range_invalid"
    );
    assert_eq!(
        error_of(&ask(Some(&today()), "2020-01-01")).1,
        "agents.refused.analytics_range_invalid"
    );
    let empty = data(&ask(Some("2020-01-01"), "2020-01-02"));
    assert_eq!(empty.get("days"), Some(&Json::Array(Vec::new())));
    assert_eq!(
        empty.get("totals").unwrap().compact(),
        r#"{"sessions":0,"actions":0,"executed":0,"refused":0,"failed":0,"testRuns":null,"spend":[]}"#
    );
}

#[test]
fn usage_by_agent_user_and_task_each_add_up_to_the_sealed_windows() {
    let w = world_or_skip!(custodial_world());
    reviewed_session(&w, USER, 0);
    reviewed_session(&w, USER, 0);
    reviewed_session(&w, OTHER, 0);
    let total = sealed_sum(&w, USER);
    let (door, _, _db) = door_of(w);
    let me = principal(&person(USER));
    let usage = data(&query(
        &door,
        "usage.summary",
        &Json::obj([("limit", Json::int(500))]),
        &me,
    ));
    let rows = |k: &str| match usage.get(k) {
        Some(Json::Array(a)) => a.clone(),
        _ => panic!("{k}"),
    };
    let add = |rs: &[Json]| -> Amount {
        rs.iter()
            .map(|r| match r.get("amount") {
                Some(Json::String(a)) => amt(a),
                _ => panic!(),
            })
            .sum()
    };
    assert_eq!(usage.get("windowCount"), Some(&Json::int(2)));
    assert_eq!(add(&rows("windows")), total);
    assert_eq!(add(&rows("total")), total);
    assert_eq!(rows("total").len(), 1);
    for k in ["byAgent", "byUser", "byTask"] {
        assert_eq!(add(&rows(k)), total, "{k}");
    }
    assert_eq!(rows("byUser")[0].get("key"), Some(&Json::str(USER)));
    assert_eq!(rows("byUser")[0].get("windows"), Some(&Json::int(2)));
    assert_eq!(rows("byTask")[0].get("key"), Some(&Json::str("plan")));
    assert!(
        rows("windows")
            .iter()
            .all(|r| r.get("state") == Some(&Json::str("settled")))
    );
    let page = data(&query(
        &door,
        "usage.summary",
        &Json::obj([("limit", Json::int(1))]),
        &me,
    ));
    assert_eq!(
        match page.get("windows") {
            Some(Json::Array(a)) => a.len(),
            _ => 0,
        },
        1
    );
    assert_eq!(page.get("total"), usage.get("total"));
}

#[test]
fn every_seeded_set_is_distinct() {
    // A guard on the fixtures above: two runs of one person land in one window, each in its own session.
    let w = world_or_skip!(custodial_world());
    let a = w.ran(USER);
    let b = w.ran(USER);
    assert_ne!(a.0, b.0);
    assert_eq!(a.1, b.1);
    let set: BTreeSet<_> = [a.0, b.0].into_iter().collect();
    assert_eq!(set.len(), 2);
}
