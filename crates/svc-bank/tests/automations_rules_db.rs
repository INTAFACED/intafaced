//! Part `rules` of slice `automations` against the Rust door on a real Postgres. Ports every check of the TypeScript's
//! `rules/scheduled-notices.db.test.ts`, each test named after the TypeScript test's words: the reminder rule (its
//! business key, replay, stale writes, the race of #8901), the money rule's refusal, the notice outbox's pass (reminders
//! inside the lead time, failure notices, drops, two passes at once, a bus that refuses or is down, no bus at all, the
//! bus's subject and key) and the customer door. A call on `ScheduledNoticeService` is the Rust function it became
//! (`rules::reminder_rule`, `set_reminder_rule`, `run`), given the dependencies the door gives it; a door call is a door
//! call. Standing orders are made and run through the transfers slice's own functions (`schedules::create`,
//! `schedules::cancel`, `schedules::run_due`), as the TypeScript drives `bank.transfers`. Two more check the job door
//! `POST /internal/jobs/run-scheduled-notices` (signed, its body, one pass), which the TypeScript suite does not reach.
//!
//! Nothing here posts money: the ledger is a stand-in that books the standing orders' `bankTransfer` and refuses too
//! little money, so a run can fail. The bus records every publish and can be down, or refuse a number of publishes.
//! Without `TEST_DATABASE_URL` each test skips; with `REQUIRE_POSTGRES=1` it fails.
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

use service_kit::approvals::random_uuid;
use service_kit::edge;
use service_kit::json::{self, Json};
use service_kit::money::{Amount, format_amount, parse_amount};
use service_kit::s2s::{self, system_seconds};
use service_kit::s2s_verify::BodyBind;
use service_kit::server::Request;
use service_kit::time::{Instant, js_date};
use svc_bank::automations::{self, rules};
use svc_bank::db::Store;
use svc_bank::door::{self, BankDoor, DoorConfig, Kind, ServiceAuth};
use svc_bank::errors::Refusal;
use svc_bank::partner::TestPartner;
use svc_bank::partner::custody::{Freeze, FreezeReading};
use svc_bank::partner::router::Wiring as PartnerWiring;
use svc_bank::spaces::ports::{
    DirError, Directory, Ledger, LedgerAccount, LedgerBalance, LedgerTx, Lookup, Lookups,
    PostFailure, TxEntry,
};
use svc_bank::spaces::shared::Terms;
use svc_bank::spaces::space::{self, NewSpace, Rules};
use svc_bank::spaces::{Tables, Wiring as SpacesWiring};
use svc_bank::transfers::calendar::{Cadence, MAX_CATCH_UP_PER_PASS};
use svc_bank::transfers::ports::{Bus, MemoryIdentity};
use svc_bank::transfers::schedules::{self, NewSchedule, Schedule};
use svc_bank::transfers::{self, Settings, Wiring as TransfersWiring};

use support::TestDb;

const SECRET: &str = "bank-rules-principal-secret-32-chars-xx";
const INTERNAL: &str = "a-bank-rules-db-internal-secret-long-enough";
const USER: &str = "71111111-1111-4111-8111-111111111111";
const OTHER: &str = "72222222-2222-4222-8222-222222222222";
const HOUR: i64 = 3_600_000;

fn now_fixed() -> Instant {
    js_date("2026-11-10T09:00:00.000Z").unwrap()
}

/// `at(hours)`: hours after the suite's fixed now.
fn at(hours: i64) -> Instant {
    at_minutes(hours * 60)
}

fn at_minutes(minutes: i64) -> Instant {
    Instant(now_fixed().0 + minutes * 60_000)
}

/// `ago(hours)`: hours before the real now (a run's attempt is stamped by the database clock).
fn ago(hours: i64) -> Instant {
    Instant(door::system_now().0 - hours * HOUR)
}

fn amt(s: &str) -> Amount {
    parse_amount(s).unwrap()
}

// ---------------------------------------------------------------------------------------------------------------
// Stand-ins

type Acct = (String, String, String, String);

/// The balances and the journal (key, transaction).
type BookState = (BTreeMap<Acct, Amount>, Vec<(String, LedgerTx)>);

#[derive(Clone, Default)]
struct Book(Arc<Mutex<BookState>>);

fn acct(a: &LedgerAccount) -> Acct {
    (
        a.owner_type.to_owned(),
        a.owner_id.clone(),
        a.asset_id.clone(),
        a.kind.to_owned(),
    )
}

fn acct_of(j: &Json) -> Acct {
    let s = |k: &str| match j.get(k) {
        Some(Json::String(v)) => v.clone(),
        other => panic!("{k}: {other:?}"),
    };
    (s("ownerType"), s("ownerId"), s("assetId"), s("kind"))
}

fn acct_id(a: &Acct) -> String {
    format!("acct:{}:{}:{}:{}", a.0, a.1, a.2, a.3)
}

impl Book {
    /// `recipes.deposit` into the person's main USDT.
    fn fund(&self, user: &str, amount: &str) {
        let key = (
            "user".to_owned(),
            user.to_owned(),
            "USDT".to_owned(),
            "available".to_owned(),
        );
        *self.0.lock().unwrap().0.entry(key).or_default() += amt(amount);
    }
    /// `ledger.journal().length`.
    fn journal(&self) -> usize {
        self.0.lock().unwrap().1.len()
    }
}

impl Ledger for Book {
    fn balance(&self, a: &LedgerAccount) -> Result<Amount, String> {
        Ok(self.0.lock().unwrap().0.get(&acct(a)).copied().unwrap_or(0))
    }
    fn balances(&self, owner_type: &str, owner: &str) -> Result<Vec<LedgerBalance>, String> {
        Ok(self
            .0
            .lock()
            .unwrap()
            .0
            .iter()
            .filter(|(k, _)| k.0 == owner_type && k.1 == owner)
            .map(|(k, v)| LedgerBalance {
                asset_id: k.2.clone(),
                kind: k.3.clone(),
                purpose: String::new(),
                amount: *v,
            })
            .collect())
    }
    fn assets(&self) -> Result<Vec<Json>, String> {
        Err("no registry".to_owned())
    }
    fn account_id(&self, a: &LedgerAccount) -> Result<String, String> {
        Ok(acct_id(&acct(a)))
    }
    fn tx_by_id(&self, tx_id: &str) -> Result<Option<LedgerTx>, String> {
        Ok(self
            .0
            .lock()
            .unwrap()
            .1
            .iter()
            .find(|(_, t)| t.id == tx_id)
            .map(|(_, t)| t.clone()))
    }
    fn tx_by_key(&self, key: &str) -> Result<Option<LedgerTx>, String> {
        Ok(self
            .0
            .lock()
            .unwrap()
            .1
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, t)| t.clone()))
    }
    fn post_recipe(&self, recipe: &str, input: &Json, key: &str) -> Result<LedgerTx, PostFailure> {
        assert_eq!(recipe, "bankTransfer");
        let mut st = self.0.lock().unwrap();
        if let Some((_, t)) = st.1.iter().find(|(k, _)| k == key) {
            return Ok(t.clone());
        }
        let from = acct_of(input.get("from").unwrap());
        let to = acct_of(input.get("to").unwrap());
        let amount = match input.get("amount") {
            Some(Json::String(a)) => amt(a),
            other => panic!("amount: {other:?}"),
        };
        let held = st.0.get(&from).copied().unwrap_or(0);
        if held < amount {
            return Err(PostFailure::Coded {
                code: "ledger.insufficient_funds".to_owned(),
                message: format!("Insufficient funds: {}", format_amount(held)),
                attempts: 1,
            });
        }
        *st.0.entry(from.clone()).or_default() -= amount;
        *st.0.entry(to.clone()).or_default() += amount;
        let tx = LedgerTx {
            key: key.to_owned(),
            id: format!("tx-{}", st.1.len() + 1),
            posted_at: door::system_now(),
            entries: vec![
                TxEntry {
                    account_id: acct_id(&from),
                    asset_id: from.2.clone(),
                    direction: "credit".to_owned(),
                    amount,
                },
                TxEntry {
                    account_id: acct_id(&to),
                    asset_id: to.2.clone(),
                    direction: "debit".to_owned(),
                    amount,
                },
            ],
        };
        st.1.push((key.to_owned(), tx.clone()));
        Ok(tx)
    }
}

/// What the bus took, and how it fails: down while `down`, and the next `refuse` publishes refused.
#[derive(Default)]
struct BusState {
    sent: Vec<(String, String, Json)>,
    down: bool,
    refuse: usize,
}

/// The tests' `recordingSink`, as the bus the notices go out on.
#[derive(Clone, Default)]
struct Recorder(Arc<Mutex<BusState>>);

impl Bus for Recorder {
    fn publish(&self, subject: &str, msg_id: &str, envelope: &Json) -> Result<(), String> {
        let mut st = self.0.lock().unwrap();
        if st.down {
            return Err("bus unreachable".to_owned());
        }
        if st.refuse > 0 {
            st.refuse -= 1;
            return Err("bus unreachable".to_owned());
        }
        st.sent
            .push((subject.to_owned(), msg_id.to_owned(), envelope.clone()));
        Ok(())
    }
}

impl Recorder {
    fn down(&self, down: bool) {
        self.0.lock().unwrap().down = down;
    }
    fn refuse(&self, n: usize) {
        self.0.lock().unwrap().refuse = n;
    }
    fn payloads(&self, subject: &str) -> Vec<Json> {
        self.0
            .lock()
            .unwrap()
            .sent
            .iter()
            .filter(|(s, _, _)| s == subject)
            .map(|(_, _, e)| e.get("payload").unwrap().clone())
            .collect()
    }
    /// `told.reminders`.
    fn reminders(&self) -> Vec<Json> {
        self.payloads("intafaced.bank.scheduled_reminder.triggered")
    }
    /// `told.failures`.
    fn failures(&self) -> Vec<Json> {
        self.payloads("intafaced.bank.scheduled_run.failed")
    }
}

struct NoPeople;

impl Directory for NoPeople {
    fn handles_of(&self, _ids: &[String]) -> Result<BTreeMap<String, String>, DirError> {
        Ok(BTreeMap::new())
    }
    fn find_active(&self, _q: &Lookup) -> Result<Option<(String, String)>, DirError> {
        Ok(None)
    }
}

struct Open;

impl Freeze for Open {
    fn read(&self) -> Result<FreezeReading, String> {
        Ok(FreezeReading {
            posting_enabled: true,
            cause: None,
        })
    }
}

fn partner_wiring() -> PartnerWiring {
    PartnerWiring {
        partner: Some(TestPartner::new().unwrap()),
        freeze: Box::new(Open),
        custody_layer: "off".to_owned(),
        cash_legs: None,
        pay_in: None,
    }
}

fn rules_() -> Rules {
    Rules {
        space_limit: Some("10".to_owned()),
        unlock_wait_hours: Some("24".to_owned()),
    }
}

fn spaces_wiring(ledger: &Book) -> SpacesWiring {
    SpacesWiring {
        ledger: Box::new(ledger.clone()),
        directory: Box::new(NoPeople),
        lookups: Lookups::default(),
        rules: rules_(),
        terms: Terms {
            invite_minutes: None,
            people_cap: None,
            card_programme: ("card-sim".to_owned(), true),
        },
        tables: Tables {
            account_terms: None,
            currencies: None,
            plans: None,
            fees: None,
            dormancy: None,
        },
    }
}

fn transfers_wiring(identity: &Arc<MemoryIdentity>, bus: &Recorder) -> TransfersWiring {
    #[derive(Clone)]
    struct Id(Arc<MemoryIdentity>);
    impl transfers::ports::RecipientState for Id {
        fn account_of(
            &self,
            user_id: &str,
        ) -> Result<Option<transfers::ports::AccountOf>, transfers::ports::RecipientUnavailable>
        {
            self.0.account_of(user_id)
        }
    }
    let mut w = TransfersWiring::none();
    w.recipients = Box::new(Id(identity.clone()));
    w.bus = Box::new(bus.clone());
    w.settings = Settings {
        producer: "svc-bank".to_owned(),
        batch_size: Some(10),
        ..Settings::default()
    };
    w
}

/// The slice's wiring: the notices on the bus (`eventScheduledNotices(bus)`), or none (`services()` with no sink).
fn automations_wiring(notices: bool) -> automations::Wiring {
    let mut w = automations::Wiring::none();
    if notices {
        w.rules = rules::Wiring::on_the_bus();
    }
    w
}

struct Bank {
    db: TestDb,
    store: Store,
    door: BankDoor,
    ledger: Book,
    identity: Arc<MemoryIdentity>,
    bus: Recorder,
}

fn door_for(db: &TestDb, b: &Book, identity: &Arc<MemoryIdentity>, bus: &Recorder) -> BankDoor {
    let env: BTreeMap<String, String> = [("APP_ENV", "test"), ("NODE_ENV", "test")]
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect();
    BankDoor::new(DoorConfig {
        edge_secret: SECRET.to_owned(),
        services: ServiceAuth {
            secret: Some(INTERNAL.to_owned()),
            keys: None,
            trpc_bind: BodyBind::AcceptBoth,
        },
        env,
        now: door::system_now,
        store: db.store(),
    })
    .unwrap()
    .with_partner(partner_wiring())
    .with_spaces(spaces_wiring(b))
    .with_transfers(transfers_wiring(identity, bus))
    .with_automations(automations_wiring(true))
}

fn bank() -> Option<Bank> {
    let db = TestDb::new()?;
    db.migrated();
    let ledger = Book::default();
    let identity = Arc::new(MemoryIdentity::default());
    let bus = Recorder::default();
    let door = door_for(&db, &ledger, &identity, &bus);
    let store = db.store();
    Some(Bank {
        db,
        store,
        door,
        ledger,
        identity,
        bus,
    })
}

impl Bank {
    fn count(&self, sql: &str) -> i64 {
        self.db.count(sql)
    }
    fn sql(&self, q: &str) {
        self.db.client().batch_execute(q).unwrap();
    }
    /// The transfers slice's dependencies at `now`, as the door builds them.
    fn t<T>(&self, now: Instant, f: impl FnOnce(&transfers::Deps<'_>) -> T) -> T {
        let partner = partner_wiring();
        let spaces = spaces_wiring(&self.ledger);
        let w = transfers_wiring(&self.identity, &self.bus);
        let custody = partner.custody(&self.store);
        f(&transfers::Deps {
            store: &self.store,
            ledger: &self.ledger,
            custody: &custody,
            partner: &partner,
            spaces: &spaces,
            w: &w,
            now,
        })
    }
    /// `bank.scheduledNotices`, with the sink wired or not, at `now`.
    fn notices<T>(
        &self,
        wired: bool,
        now: Instant,
        f: impl FnOnce(&automations::Deps<'_>) -> T,
    ) -> T {
        let w = automations_wiring(wired);
        self.t(now, |t| f(&automations::Deps { t, w: &w }))
    }
    /// `scheduledNotices.run({ limit, now })` with the sink wired.
    fn run(&self, limit: i64, now: Instant) -> rules::Pass {
        self.notices(true, now, |d| rules::run(d, limit, now))
            .unwrap()
    }
    /// `setReminderRule`.
    fn set(
        &self,
        user: &str,
        lead: Option<i64>,
        rev: i64,
        id: &str,
    ) -> Result<rules::ReminderRule, Refusal> {
        self.notices(true, door::system_now(), |d| {
            rules::set_reminder_rule(
                d,
                &rules::SetReminder {
                    user_id: user,
                    lead_hours: lead,
                    expected_revision: rev,
                    client_request_id: id,
                },
            )
        })
    }
    fn rule(&self, user: &str) -> Option<rules::ReminderRule> {
        self.notices(true, door::system_now(), |d| rules::reminder_rule(d, user))
            .unwrap()
    }
    /// `standingOrder(bank, startsAt, amount, userId)`: a weekly order from the main space into "Rent".
    fn standing_order(&self, starts_at: Instant, amount: &str, user: &str) -> Schedule {
        let from = space::with(&self.store, |c| space::ensure_primary(c, user, "USDT"))
            .unwrap()
            .id;
        let existing = space::with(&self.store, |c| {
            let rows = c
                .query(
                    "SELECT id::text FROM bank.spaces WHERE user_id = $1 AND name = 'Rent'",
                    &[&user],
                )
                .unwrap();
            Ok(rows.first().map(|r| r.get::<_, String>(0)))
        })
        .unwrap();
        let to = existing.unwrap_or_else(|| {
            space::create_within_limit(
                &self.store,
                &rules_(),
                &NewSpace {
                    user_id: user,
                    asset_id: "USDT",
                    name: "Rent",
                    goal_target: None,
                    locked_until: None,
                },
            )
            .unwrap()
            .id
        });
        let id = random_uuid().unwrap();
        self.t(starts_at, |d| {
            schedules::create(
                d,
                &NewSchedule {
                    user_id: user,
                    from_space_id: &from,
                    to_space_id: &to,
                    amount: amt(amount),
                    cadence: Cadence::Weekly,
                    starts_at,
                    ends_at: None,
                    schedule_id: &id,
                },
            )
        })
        .unwrap()
    }
    /// `transfers.runDueTransfers({ now, limit: 10 })`.
    fn run_due(&self, now: Instant) -> schedules::RunReport {
        self.t(now, |d| {
            schedules::run_due(d, Some(10.0), MAX_CATCH_UP_PER_PASS)
        })
        .unwrap()
    }
}

fn pass(reminders: i64, failures: i64, announced: i64, dropped: i64, owed: i64) -> rules::Pass {
    rules::Pass {
        reminders,
        failures,
        announced,
        dropped,
        owed,
    }
}

fn code(r: Result<rules::ReminderRule, Refusal>) -> String {
    match r {
        Err(Refusal::Bank(e)) => e.row.code.to_owned(),
        other => panic!("not a BankError: {other:?}"),
    }
}

fn s(j: &Json, k: &str) -> String {
    match j.get(k) {
        Some(Json::String(v)) => v.clone(),
        Some(Json::Null) | None => "null".to_owned(),
        Some(other) => other.compact(),
    }
}

// ---------------------------------------------------------------------------------------------------------------
// the reminder rule

#[test]
fn is_saved_under_its_business_key_read_back_on_a_replay_and_a_stale_write_is_refused() {
    let Some(b) = bank() else { return };
    assert_eq!(b.rule(USER), None);

    let first = b.set(USER, Some(24), 0, "r-1").unwrap();
    assert_eq!(first.rule_key, format!("reminder:{USER}"));
    assert_eq!((first.lead_hours, first.revision), (Some(24), 1));
    // The same request again is the same row, not a second rule.
    assert_eq!(b.set(USER, Some(24), 0, "r-1").unwrap(), first);
    // Another write that read no rule is stale now.
    assert_eq!(
        code(b.set(USER, Some(72), 0, "r-2")),
        "bank.reminder_revision_conflict"
    );

    let off = b.set(USER, None, 1, "r-3").unwrap();
    assert_eq!(off.rule_key, format!("reminder:{USER}"));
    assert_eq!((off.lead_hours, off.revision), (None, 2));
    assert_eq!(
        code(b.set(USER, Some(168), 1, "r-4")),
        "bank.reminder_revision_conflict"
    );
    assert_eq!(
        code(b.set(USER, Some(5), 2, "r-5")),
        "bank.reminder_lead_invalid"
    );
    // The same request id with another choice is another write, not a replay of the one that landed.
    assert_eq!(
        code(b.set(USER, Some(48), 1, "r-3")),
        "bank.reminder_revision_conflict"
    );

    assert_eq!(b.rule(USER), Some(off));
    assert_eq!(b.rule(OTHER), None);
    assert_eq!(b.count("SELECT count(*) FROM bank.reminder_rules"), 1);
}

#[test]
fn a_first_write_racing_its_own_retry_replays_the_one_row_another_first_write_racing_it_is_refused_stale_8901()
 {
    let Some(b) = bank() else { return };
    for round in 0..20 {
        b.sql("TRUNCATE bank.reminder_rules");
        let id = format!("same-{round}");
        let same: Vec<_> = std::thread::scope(|sc| {
            let hs: Vec<_> = (0..6)
                .map(|_| sc.spawn(|| b.set(USER, Some(48), 0, &id)))
                .collect();
            hs.into_iter().map(|h| h.join().unwrap()).collect()
        });
        let rules: Vec<_> = same
            .into_iter()
            .map(|r| r.expect("a replay, never refused"))
            .collect();
        for r in &rules {
            assert_eq!(r, &rules[0]);
        }
        assert_eq!((rules[0].lead_hours, rules[0].revision), (Some(48), 1));
        assert_eq!(b.count("SELECT count(*) FROM bank.reminder_rules"), 1);
    }

    for round in 0..20 {
        b.sql("TRUNCATE bank.reminder_rules");
        let rivals: Vec<_> = std::thread::scope(|sc| {
            let hs: Vec<_> = (0..6)
                .map(|i| {
                    let b = &b;
                    sc.spawn(move || b.set(USER, Some(24), 0, &format!("rival-{round}-{i}")))
                })
                .collect();
            hs.into_iter().map(|h| h.join().unwrap()).collect()
        });
        assert_eq!(rivals.iter().filter(|r| r.is_ok()).count(), 1);
        for r in rivals.into_iter().filter(Result::is_err) {
            assert_eq!(code(r), "bank.reminder_revision_conflict");
        }
        assert_eq!(b.count("SELECT count(*) FROM bank.reminder_rules"), 1);
    }
}

#[test]
fn refuses_a_rule_that_moves_money_while_the_owner_has_published_no_terms_and_stores_nothing() {
    let Refusal::Bank(e) = rules::create_money_rule() else {
        panic!("not a BankError")
    };
    assert_eq!(e.row.code, "bank.rule_terms_unset");
}

// ---------------------------------------------------------------------------------------------------------------
// reminders before a run

#[test]
fn owes_one_reminder_for_a_run_inside_the_lead_time_and_a_second_pass_tells_nobody_again() {
    let Some(b) = bank() else { return };
    let soon = b.standing_order(at(10), "20", USER);
    b.standing_order(at(50), "20", USER); // outside a day's lead
    b.standing_order(at(5), "9", OTHER); // its owner has no rule
    b.set(USER, Some(24), 0, "r-1").unwrap();

    let posts = b.ledger.journal();
    assert_eq!(b.run(10, now_fixed()), pass(1, 0, 1, 0, 0));
    let told = b.bus.reminders();
    assert_eq!(told.len(), 1);
    let r = &told[0];
    assert!(service_kit::tokens::is_guid(&s(r, "noticeId")));
    assert_eq!(s(r, "userId"), USER);
    assert_eq!(s(r, "scheduleId"), soon.id);
    assert_eq!(s(r, "occurrence"), "0");
    assert_eq!(s(r, "dueAt"), at(10).iso());
    assert_eq!(s(r, "amount"), "20");
    assert_eq!(s(r, "assetId"), "USDT");
    assert_eq!(s(r, "leadHours"), "24");
    assert_eq!(b.run(10, at(1)), pass(0, 0, 0, 0, 0));
    assert_eq!(b.bus.reminders().len(), 1);
    // A reminder is about a run, not a movement: nothing was posted.
    assert_eq!(b.ledger.journal(), posts);
}

#[test]
fn reminds_of_the_next_week_once_the_first_run_is_done_and_sends_none_while_reminders_are_off() {
    let Some(b) = bank() else { return };
    b.ledger.fund(USER, "100");
    let weekly = b.standing_order(at(2), "20", USER);
    b.set(USER, Some(168), 0, "r-1").unwrap();
    b.run(10, now_fixed());
    b.run_due(at(3));
    b.run(10, at(3));
    let told: Vec<(String, String)> = b
        .bus
        .reminders()
        .iter()
        .map(|r| (s(r, "scheduleId"), s(r, "occurrence")))
        .collect();
    assert_eq!(
        told,
        vec![
            (weekly.id.clone(), "0".to_owned()),
            (weekly.id.clone(), "1".to_owned())
        ]
    );

    b.set(USER, None, 1, "r-2").unwrap();
    b.run_due(at(2 + 7 * 24 + 1));
    assert_eq!(b.run(10, at(2 + 7 * 24 + 1)).reminders, 0);
    assert_eq!(b.bus.reminders().len(), 2);
}

// ---------------------------------------------------------------------------------------------------------------
// reminders that no longer hold

#[test]
fn drops_an_owed_reminder_when_its_order_is_cancelled_before_the_bus_took_it_and_sends_nothing_for_it()
 {
    let Some(b) = bank() else { return };
    let order = b.standing_order(at(10), "20", USER);
    b.set(USER, Some(24), 0, "r-1").unwrap();
    b.bus.down(true);
    let first = b.run(10, now_fixed());
    assert_eq!((first.reminders, first.announced, first.owed), (1, 0, 1));
    b.t(now_fixed(), |d| schedules::cancel(d, &order.id))
        .unwrap();
    b.bus.down(false);
    assert_eq!(b.run(10, at(1)), pass(0, 0, 0, 1, 0));
    assert!(b.bus.reminders().is_empty());
}

#[test]
fn drops_a_reminder_the_bus_never_took_before_the_run_rather_than_reminding_after_it() {
    let Some(b) = bank() else { return };
    b.standing_order(at(10), "20", USER);
    b.set(USER, Some(24), 0, "r-1").unwrap();
    b.bus.down(true);
    b.run(10, now_fixed());
    b.bus.down(false);
    let later = b.run(10, at(11));
    assert_eq!((later.announced, later.dropped, later.owed), (0, 1, 0));
    assert!(b.bus.reminders().is_empty());
}

// ---------------------------------------------------------------------------------------------------------------
// two passes at once

#[test]
fn send_each_owed_notice_once_a_row_one_pass_holds_is_skipped_by_the_other() {
    let Some(b) = bank() else { return };
    for hours in [2, 3, 4, 5] {
        b.standing_order(at(hours), "20", USER);
    }
    b.set(USER, Some(24), 0, "r-1").unwrap();
    let (a, c) = std::thread::scope(|sc| {
        let one = sc.spawn(|| b.run(10, now_fixed()));
        let two = sc.spawn(|| b.run(10, now_fixed()));
        (one.join().unwrap(), two.join().unwrap())
    });
    assert_eq!(a.announced + c.announced, 4);
    let told = b.bus.reminders();
    assert_eq!(told.len(), 4);
    let mut ids: Vec<String> = told.iter().map(|r| s(r, "scheduleId")).collect();
    ids.sort();
    ids.dedup();
    assert_eq!(ids.len(), 4);
}

#[test]
fn stops_at_the_first_publish_the_bus_refuses_and_sends_that_row_after_the_others_next_time() {
    let Some(b) = bank() else { return };
    let first = b.standing_order(at(2), "20", USER);
    let second = b.standing_order(at(3), "20", USER);
    b.set(USER, Some(24), 0, "r-1").unwrap();
    b.bus.refuse(1);
    let one = b.run(10, now_fixed());
    assert_eq!((one.reminders, one.announced, one.owed), (2, 0, 2));
    let two = b.run(10, at_minutes(30));
    assert_eq!((two.announced, two.owed), (2, 0));
    let order: Vec<String> = b
        .bus
        .reminders()
        .iter()
        .map(|r| s(r, "scheduleId"))
        .collect();
    assert_eq!(order, vec![second.id, first.id]);
}

// ---------------------------------------------------------------------------------------------------------------
// failure notices

#[test]
fn tells_the_owner_once_of_a_run_refused_for_too_little_money_with_what_it_tried_to_move_and_why() {
    let Some(b) = bank() else { return };
    let empty = b.standing_order(ago(1), "25", USER);
    let run = b.run_due(door::system_now());
    assert_eq!(run.rejected, 1);

    assert_eq!(b.run(10, door::system_now()), pass(0, 1, 1, 0, 0));
    let told = b.bus.failures();
    assert_eq!(told.len(), 1);
    let f = &told[0];
    assert!(service_kit::tokens::is_guid(&s(f, "noticeId")));
    assert_eq!(s(f, "userId"), USER);
    assert_eq!(s(f, "scheduleId"), empty.id);
    assert_eq!(s(f, "occurrence"), "0");
    assert_eq!(s(f, "amount"), "25");
    assert_eq!(s(f, "assetId"), "USDT");
    assert_eq!(s(f, "reasonCode"), "ledger.insufficient_funds");
    assert!(js_date(&s(f, "failedAt")).is_some());
    assert_eq!(b.run(10, door::system_now()).failures, 0);
    assert_eq!(b.bus.failures().len(), 1);
}

#[test]
fn keeps_a_notice_owed_while_the_bus_is_down_and_sends_it_on_the_next_pass_with_no_bus_it_says_so()
{
    let Some(b) = bank() else { return };
    b.standing_order(ago(1), "20", USER);
    b.run_due(door::system_now());

    b.bus.down(true);
    assert_eq!(b.run(10, door::system_now()), pass(0, 1, 0, 0, 1));
    b.bus.down(false);
    assert_eq!(b.run(10, door::system_now()), pass(0, 0, 1, 0, 0));
    assert_eq!(b.bus.failures().len(), 1);

    b.standing_order(ago(1), "30", OTHER);
    b.run_due(door::system_now());
    let now = door::system_now();
    let Err(Refusal::Bank(e)) = b.notices(false, now, |d| rules::run(d, 10, now)) else {
        panic!("an unwired run must refuse")
    };
    assert_eq!(e.row.code, "bank.scheduled_notify_unwired");
    assert_eq!(
        b.count(&format!(
            "SELECT count(*) FROM bank.scheduled_notices WHERE user_id = '{OTHER}' AND announced_at IS NULL"
        )),
        1
    );
}

#[test]
fn publishes_each_notice_on_the_bus_under_its_schedule_occurrence_and_kind() {
    let Some(b) = bank() else { return };
    let empty = b.standing_order(ago(1), "20", USER);
    b.run_due(door::system_now());
    b.run(10, door::system_now());
    let sent: Vec<(String, String, Json)> = b
        .bus
        .0
        .lock()
        .unwrap()
        .sent
        .iter()
        .filter(|(subject, _, _)| subject == "intafaced.bank.scheduled_run.failed")
        .cloned()
        .collect();
    assert_eq!(sent.len(), 1);
    let (_, msg_id, envelope) = &sent[0];
    let key = format!("bank.scheduled_failed:{}:0", empty.id);
    assert_eq!(msg_id, &key);
    assert_eq!(
        s(envelope, "subject"),
        "intafaced.bank.scheduled_run.failed"
    );
    assert_eq!(s(envelope, "idempotencyKey"), key);
    let payload = envelope.get("payload").unwrap();
    assert_eq!(s(payload, "scheduleId"), empty.id);
    assert_eq!(s(payload, "reasonCode"), "ledger.insufficient_funds");
}

// ---------------------------------------------------------------------------------------------------------------
// the customer door

fn person(user: &str) -> Vec<(String, String)> {
    let raw = Json::obj([
        ("sub", Json::str(user)),
        (
            "scopes",
            Json::Array(vec![Json::str("bank:read"), Json::str("bank:write")]),
        ),
        ("tier", Json::str("full")),
        ("mfa", Json::Bool(true)),
        ("sid", Json::str("73333333-3333-4333-8333-333333333333")),
        ("userId", Json::str(user)),
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

fn encode(s: &str) -> String {
    s.bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
                char::from(b).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}

fn send(
    door: &BankDoor,
    url: &str,
    method: &str,
    body: &str,
    mut headers: Vec<(String, String)>,
) -> (u16, Json) {
    headers.push(("content-type".to_owned(), "application/json".to_owned()));
    let res = door.handle_from(
        &Request {
            method,
            url,
            headers: &headers,
            body,
        },
        "req-rules-db",
        "127.0.0.1",
    );
    (res.status, json::parse(&res.body).unwrap())
}

fn call(b: &Bank, user: &str, path: &str, input: &str) -> (u16, Json) {
    match door::call(path).map(|c| c.kind) {
        Some(Kind::Query) if input.is_empty() => {
            send(&b.door, &format!("/trpc/{path}"), "GET", "", person(user))
        }
        Some(Kind::Query) => send(
            &b.door,
            &format!("/trpc/{path}?input={}", encode(input)),
            "GET",
            "",
            person(user),
        ),
        _ => send(
            &b.door,
            &format!("/trpc/{path}"),
            "POST",
            input,
            person(user),
        ),
    }
}

fn data(a: &(u16, Json)) -> Json {
    assert_eq!(a.0, 200, "{}", a.1.compact());
    a.1.get("result").unwrap().get("data").unwrap().clone()
}

#[test]
fn saves_the_signed_persons_own_rule_and_refuses_a_money_rule_with_the_missing_terms() {
    let Some(b) = bank() else { return };
    assert_eq!(
        data(&call(&b, USER, "rules.get", "")).compact(),
        r#"{"reminder":null,"leadChoices":[24,48,72,168],"moneyRules":{"state":"not_set","code":"bank.rule_terms_unset"}}"#
    );
    let saved = call(
        &b,
        USER,
        "rules.setReminder",
        r#"{"leadHours":48,"expectedRevision":0,"clientRequestId":"web-1"}"#,
    );
    let saved = data(&saved);
    assert_eq!(s(&saved, "ruleKey"), format!("reminder:{USER}"));
    assert_eq!(s(&saved, "leadHours"), "48");
    assert_eq!(s(&saved, "revision"), "1");
    let read = data(&call(&b, USER, "rules.get", ""));
    let reminder = read.get("reminder").unwrap();
    assert_eq!(s(reminder, "ruleKey"), format!("reminder:{USER}"));
    assert_eq!(s(reminder, "leadHours"), "48");
    assert_eq!(
        data(&call(&b, OTHER, "rules.get", "")).get("reminder"),
        Some(&Json::Null)
    );
    // A lead time that is not offered, and a body naming someone else, are refused by shape.
    assert_eq!(
        call(
            &b,
            USER,
            "rules.setReminder",
            r#"{"leadHours":5,"expectedRevision":1,"clientRequestId":"web-2"}"#
        )
        .0,
        400
    );
    assert_eq!(
        call(
            &b,
            USER,
            "rules.setReminder",
            &format!(r#"{{"leadHours":24,"expectedRevision":1,"clientRequestId":"web-3","userId":"{OTHER}"}}"#)
        )
        .0,
        400
    );
    assert_eq!(
        call(
            &b,
            USER,
            "rules.setReminder",
            r#"{"leadHours":24,"expectedRevision":0,"clientRequestId":"web-4"}"#
        )
        .0,
        409
    );

    let money = call(
        &b,
        USER,
        "rules.createMoneyRule",
        &format!(
            r#"{{"name":"Sweep TEST","fromSpaceId":"{}","toSpaceId":"{}","trigger":{{"kind":"balance","above":"500"}},"amount":"100","clientRequestId":"web-5"}}"#,
            random_uuid().unwrap(),
            random_uuid().unwrap()
        ),
    );
    assert_eq!(money.0, 412);
    assert!(money.1.compact().contains("bank.rule_terms_unset"));
}

// ---------------------------------------------------------------------------------------------------------------
// the job door (not in the TypeScript suite)

fn job(b: &Bank, body: &str, signed: bool) -> (u16, Json) {
    let headers = if signed {
        s2s::legacy_headers("svc-bank", INTERNAL, body, system_seconds()).unwrap()
    } else {
        Vec::new()
    };
    send(&b.door, rules::RUN_SCHEDULED_NOTICES, "POST", body, headers)
}

#[test]
fn the_job_door_refuses_an_unsigned_caller_and_a_body_not_in_shape_and_runs_one_pass() {
    let Some(b) = bank() else { return };
    assert_eq!(job(&b, r#"{"limit":10}"#, false).0, 401);
    let bad = job(&b, r#"{"limit":0}"#, true);
    assert_eq!(bad.0, 400);
    assert_eq!(s(&bad.1, "code"), "bank.validation_failed");
    assert_eq!(job(&b, "{}", true).0, 400);

    b.standing_order(ago(1), "20", USER);
    b.run_due(door::system_now());
    let ran = job(&b, r#"{"limit":10}"#, true);
    assert_eq!(ran.0, 200, "{}", ran.1.compact());
    assert_eq!(
        ran.1.compact(),
        r#"{"reminders":0,"failures":1,"announced":1,"dropped":0,"owed":0}"#
    );
    assert_eq!(b.bus.failures().len(), 1);
}

#[test]
fn the_job_door_answers_a_bus_that_is_not_wired_with_its_code_as_400() {
    let Some(b) = bank() else { return };
    b.standing_order(ago(1), "20", USER);
    b.run_due(door::system_now());
    let door =
        door_for(&b.db, &b.ledger, &b.identity, &b.bus).with_automations(automations_wiring(false));
    let body = r#"{"limit":10}"#;
    let headers = s2s::legacy_headers("svc-bank", INTERNAL, body, system_seconds()).unwrap();
    let res = send(&door, rules::RUN_SCHEDULED_NOTICES, "POST", body, headers);
    assert_eq!(res.0, 400, "{}", res.1.compact());
    assert_eq!(s(&res.1, "code"), "bank.scheduled_notify_unwired");
}
