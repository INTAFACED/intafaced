//! Part `direct_debits` of slice `bills` against the Rust door on a real Postgres. Ports every check of the TypeScript's
//! `direct-debits/direct-debits.db.test.ts` (25 tests) and `partner/test-partner-direct-debits.test.ts` (7 tests), each
//! test named after the TypeScript test's words. A call on `DirectDebitService` is the Rust function it became
//! (`service::list`, `block`, `unblock`, `request_refund`, `ops_refunds`, `set_up_mandate`, `present`, `run_due`), given
//! the dependencies the door gives it (`BankDoor::bills_deps`) at the TypeScript's `now`; a door call is a door call. The
//! TEST partner's own book is driven through its functions (`dd_set_up`, `dd_block`, `dd_mandate`, `dd_refund`,
//! `move_raw`, `dd_report`) and the desk's view through `desk::view`, as the TypeScript drives `testPartner()` and
//! `directDebitMandatesView`. `scheme.test.ts` is ported as unit tests in `src/bills/direct_debits/scheme.rs`.
//!
//! More than the TypeScript suite, at the end: the invariants (a collection posts at most once per key when the
//! ledger's answer is lost after booking; with the custodial layer off nothing is posted; a blocked mandate's collection
//! posts nothing; a failed collection has no ledger tx) and the three job doors (signed, switch, body, work).
//!
//! Not ported, and why: none of the TypeScript tests is left. The TypeScript's `MemoryLedger` throws `InvalidEntryError`
//! from its own entry check; the Rust bank posts through svc-ledger's recipe door, so the stand-in ledger refuses with
//! svc-ledger's code `ledger.invalid_entry` instead.
//!
//! The ledger is a stand-in that books `bankTransfer`, refuses too little money, can refuse every entry as invalid, can
//! lose its answer after booking, and finds a transaction by key. Without `TEST_DATABASE_URL` each test skips; with
//! `REQUIRE_POSTGRES=1` it fails.
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
use service_kit::json::{self, Json};
use service_kit::money::{Amount, format_amount, parse_amount};
use service_kit::s2s::{self, system_seconds};
use service_kit::s2s_verify::BodyBind;
use service_kit::server::Request;
use service_kit::time::{Instant, js_date};
use svc_bank::bills::direct_debits::scheme::{Catalogue, Creditor, Scheme};
use svc_bank::bills::direct_debits::service::{
    self, CollectionView, NewMandate, RunReport, collection_partner_key, collection_transfer_id,
    rail_boundary,
};
use svc_bank::bills::direct_debits::{self as dd, desk};
use svc_bank::bills::{self, Deps};
use svc_bank::db::Store;
use svc_bank::door::{self, BankDoor, DoorConfig, Kind, ServiceAuth};
use svc_bank::errors::Refusal;
use svc_bank::partner::custody::{Freeze, FreezeReading};
use svc_bank::partner::desks::DD_BLOCKED;
use svc_bank::partner::router::Wiring as PartnerWiring;
use svc_bank::partner::{AccountRef, Funding, MoveRequest, TestPartner, payouts_account};
use svc_bank::spaces::ports::{
    DirError, Directory, Ledger, LedgerAccount, LedgerBalance, LedgerTx, Lookup, Lookups,
    PostFailure, TxEntry,
};
use svc_bank::spaces::shared::Terms;
use svc_bank::spaces::space::{self, Rules};
use svc_bank::spaces::{Tables, Wiring as SpacesWiring};
use svc_bank::transfers::ports::{MemoryIdentity, RecipientStatus, RecipientUnavailable};
use svc_bank::transfers::{self, Wiring as TransfersWiring};

use support::TestDb;

const SECRET: &str = "bank-direct-debits-principal-secret-32chars";
const INTERNAL: &str = "a-bank-direct-debits-internal-secret-long-enough";
const USER: &str = "41111111-1111-4111-8111-111111111111";
const OTHER: &str = "42222222-2222-4222-8222-222222222222";
const DAY: i64 = 86_400_000;
const CREDITOR: &str = "TEST-GYM";

fn now_fixed() -> Instant {
    js_date("2026-11-02T09:00:00.000Z").unwrap()
}

/// `at(days)`.
fn at(days: i64) -> Instant {
    Instant(now_fixed().0 + days * DAY)
}

fn amt(s: &str) -> Amount {
    parse_amount(s).unwrap()
}

/// `sim(guaranteeDays)`: the TEST stand-in over a typed catalogue.
fn sim(guarantee_days: Option<i64>) -> Scheme {
    Scheme::sim(Catalogue {
        label: "TEST direct debit stand-in".to_owned(),
        guarantee_days,
        creditors: vec![Creditor {
            id: CREDITOR.to_owned(),
            name: "TEST Gym".to_owned(),
        }],
    })
}

// ---------------------------------------------------------------------------------------------------------------
// Stand-ins

type Acct = (String, String, String, String);

#[derive(Default)]
struct BookState {
    balances: BTreeMap<Acct, Amount>,
    journal: Vec<(String, LedgerTx)>,
    /// Every post refused as an invalid entry.
    invalid: bool,
    /// The next post is booked, then its answer is lost.
    lose_next: bool,
}

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
        let key = acct(&LedgerAccount::user_available(user, "USDT"));
        *self.0.lock().unwrap().balances.entry(key).or_default() += amt(amount);
    }
    fn journal(&self) -> usize {
        self.0.lock().unwrap().journal.len()
    }
    fn held(&self, a: &LedgerAccount) -> String {
        format_amount(
            self.0
                .lock()
                .unwrap()
                .balances
                .get(&acct(a))
                .copied()
                .unwrap_or(0),
        )
    }
    /// `main()`: the person's main USDT.
    fn main(&self, user: &str) -> String {
        self.held(&LedgerAccount::user_available(user, "USDT"))
    }
    /// `atRail()`: the stand-in's rail boundary.
    fn at_rail(&self) -> String {
        self.held(&rail_boundary("dd-sim", "USDT"))
    }
    fn invalid(&self, on: bool) {
        self.0.lock().unwrap().invalid = on;
    }
    fn lose_next(&self) {
        self.0.lock().unwrap().lose_next = true;
    }
}

impl Ledger for Book {
    fn balance(&self, a: &LedgerAccount) -> Result<Amount, String> {
        Ok(self
            .0
            .lock()
            .unwrap()
            .balances
            .get(&acct(a))
            .copied()
            .unwrap_or(0))
    }
    fn balances(&self, owner_type: &str, owner: &str) -> Result<Vec<LedgerBalance>, String> {
        Ok(self
            .0
            .lock()
            .unwrap()
            .balances
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
    fn tx_by_key(&self, key: &str) -> Result<Option<LedgerTx>, String> {
        Ok(self
            .0
            .lock()
            .unwrap()
            .journal
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, t)| t.clone()))
    }
    fn post_recipe(&self, recipe: &str, input: &Json, key: &str) -> Result<LedgerTx, PostFailure> {
        assert_eq!(recipe, "bankTransfer");
        let mut st = self.0.lock().unwrap();
        if let Some((_, t)) = st.journal.iter().find(|(k, _)| k == key) {
            return Ok(t.clone());
        }
        if st.invalid {
            return Err(PostFailure::Coded {
                code: "ledger.invalid_entry".to_owned(),
                message: "TEST: the ledger holds no such asset".to_owned(),
                attempts: 1,
            });
        }
        let from = acct_of(input.get("from").unwrap());
        let to = acct_of(input.get("to").unwrap());
        let amount = match input.get("amount") {
            Some(Json::String(a)) => amt(a),
            other => panic!("amount: {other:?}"),
        };
        let held = st.balances.get(&from).copied().unwrap_or(0);
        if held < amount {
            return Err(PostFailure::Coded {
                code: "ledger.insufficient_funds".to_owned(),
                message: format!("Insufficient funds: {}", format_amount(held)),
                attempts: 1,
            });
        }
        *st.balances.entry(from.clone()).or_default() -= amount;
        *st.balances.entry(to.clone()).or_default() += amount;
        let tx = LedgerTx {
            key: key.to_owned(),
            id: format!("tx-{}", st.journal.len() + 1),
            posted_at: door::system_now(),
            entries: vec![
                TxEntry {
                    account_id: acct_id(&from),
                    asset_id: from.2.clone(),
                    direction: "debit".to_owned(),
                    amount,
                },
                TxEntry {
                    account_id: acct_id(&to),
                    asset_id: to.2.clone(),
                    direction: "credit".to_owned(),
                    amount,
                },
            ],
        };
        st.journal.push((key.to_owned(), tx.clone()));
        if st.lose_next {
            st.lose_next = false;
            return Err(PostFailure::Unknown(
                "TEST: the answer was lost after booking".to_owned(),
            ));
        }
        Ok(tx)
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

/// The ledger's stacks: no partner, the custodial layer on (as `createBankServices` posts in the TypeScript suite). The
/// partner's stacks (`held()`): the TEST partner on, and the layer off.
fn partner_wiring(held: bool, layer: &str) -> PartnerWiring {
    PartnerWiring {
        partner: held.then(|| TestPartner::new().unwrap()),
        freeze: Box::new(Open),
        custody_layer: layer.to_owned(),
        cash_legs: None,
        pay_in: None,
    }
}

fn spaces_wiring(ledger: &Book) -> SpacesWiring {
    SpacesWiring {
        ledger: Box::new(ledger.clone()),
        directory: Box::new(NoPeople),
        lookups: Lookups::default(),
        rules: Rules {
            space_limit: Some("10".to_owned()),
            unlock_wait_hours: Some("24".to_owned()),
        },
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

#[derive(Clone)]
struct Id(Arc<MemoryIdentity>);

impl transfers::ports::RecipientState for Id {
    fn account_of(
        &self,
        user_id: &str,
    ) -> Result<Option<transfers::ports::AccountOf>, RecipientUnavailable> {
        self.0.account_of(user_id)
    }
}

fn transfers_wiring(identity: &Arc<MemoryIdentity>) -> TransfersWiring {
    let mut w = TransfersWiring::none();
    w.recipients = Box::new(Id(identity.clone()));
    w
}

fn bills_wiring(scheme: Scheme, enabled: bool) -> bills::Wiring {
    let mut w = bills::Wiring::none();
    w.direct_debits = dd::Wiring {
        scheme,
        collections_enabled: enabled,
    };
    w
}

struct Stack {
    db: TestDb,
    store: Store,
    ledger: Book,
    identity: Arc<MemoryIdentity>,
}

fn stack() -> Option<Stack> {
    let db = TestDb::new()?;
    db.migrated();
    let store = db.store();
    Some(Stack {
        db,
        store,
        ledger: Book::default(),
        identity: Arc::new(MemoryIdentity::default()),
    })
}

/// One door over the stack: the scheme, the run's switch and whose book holds the money.
struct Bank {
    door: BankDoor,
}

impl Stack {
    fn door(&self, scheme: Scheme, enabled: bool, held: bool, layer: &str) -> Bank {
        let env: BTreeMap<String, String> = [("APP_ENV", "test"), ("NODE_ENV", "test")]
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect();
        let door = BankDoor::new(DoorConfig {
            edge_secret: SECRET.to_owned(),
            services: ServiceAuth {
                secret: Some(INTERNAL.to_owned()),
                keys: None,
                trpc_bind: BodyBind::AcceptBoth,
            },
            env,
            now: door::system_now,
            store: self.db.store(),
        })
        .unwrap()
        .with_partner(partner_wiring(held, layer))
        .with_spaces(spaces_wiring(&self.ledger))
        .with_transfers(transfers_wiring(&self.identity))
        .with_bills(bills_wiring(scheme, enabled));
        Bank { door }
    }
    /// `services(scheme)`: the ledger holds the money.
    fn bank(&self, scheme: Scheme) -> Bank {
        self.door(scheme, true, false, "on")
    }
    /// `held(scheme)`: the TEST partner holds the person's money (`partner.set(USER, { custody: 'off' })`).
    fn held(&self) -> Bank {
        let b = self.door(sim(Some(30)), true, true, "off");
        b.switch(USER, |s| "off".clone_into(&mut s.custody));
        b
    }
    fn sql(&self, q: &str) -> Result<u64, postgres::Error> {
        self.db.client().execute(q, &[])
    }
    /// The status and failure code of one collection, by the scheme's id.
    fn status(&self, collection_id: &str) -> (String, Option<String>) {
        let r = self
            .db
            .client()
            .query_one(
                "SELECT status, failure_code FROM bank.dd_collections WHERE collection_id = $1",
                &[&collection_id],
            )
            .unwrap();
        (r.get(0), r.get(1))
    }
}

fn code<T: std::fmt::Debug>(r: Result<T, Refusal>) -> String {
    match r {
        Err(Refusal::Bank(e)) => e.row.code.to_owned(),
        other => panic!("not a BankError: {other:?}"),
    }
}

impl Bank {
    fn d<T>(&self, now: Instant, f: impl FnOnce(&Deps<'_>) -> T) -> T {
        self.door.bills_deps(now, f)
    }
    fn partner(&self) -> &TestPartner {
        self.door.partner().partner.as_ref().unwrap()
    }
    fn switch(&self, user: &str, f: impl FnOnce(&mut svc_bank::partner::switches::Switches)) {
        let mut st = self.partner().lock();
        let mut sw = st.board.read(user, Clone::clone);
        f(&mut sw);
        st.board.set(user, sw);
    }
    fn partner_fund(&self, fund_id: &str, amount: &str) {
        self.partner()
            .lock()
            .fund(
                USER,
                &Funding {
                    fund_id: fund_id.to_owned(),
                    asset_id: "USDT".to_owned(),
                    amount: amt(amount),
                },
                now_fixed(),
            )
            .unwrap();
    }
    /// `atPartner()`: the person's main balance at the partner.
    fn at_partner(&self) -> String {
        format_amount(
            self.partner()
                .lock()
                .book
                .amount(&AccountRef::main(USER, "USDT")),
        )
    }
    /// `paidOut()`: the partner's outbound-payments account.
    fn paid_out(&self) -> String {
        format_amount(self.partner().lock().book.amount(&payouts_account("USDT")))
    }
    /// `mandate(bank, id, userId)`.
    fn mandate_for(&self, id: &str, user: &str) -> Result<service::Mandate, Refusal> {
        self.d(now_fixed(), |d| {
            service::set_up_mandate(
                d,
                &NewMandate {
                    mandate_id: id.to_owned(),
                    user_id: user.to_owned(),
                    creditor_id: CREDITOR.to_owned(),
                    reference: "TEST membership 0042".to_owned(),
                    asset_id: "USDT".to_owned(),
                },
            )
        })
    }
    fn mandate(&self) -> service::Mandate {
        self.mandate_for("MD-1", USER).unwrap()
    }
    /// `present({ mandateId: 'MD-1', collectionId, amount, dueAt })`.
    fn present(
        &self,
        collection_id: &str,
        amount: &str,
        due: Instant,
    ) -> Result<CollectionView, Refusal> {
        self.d(now_fixed(), |d| {
            service::present(d, "MD-1", collection_id, amount, &due.iso())
        })
    }
    fn run(&self, now: Instant) -> RunReport {
        self.d(now, |d| service::run_due(d, 10)).unwrap()
    }
    fn list(&self, user: &str, now: Instant) -> Json {
        self.d(now, |d| service::list(d, user)).unwrap()
    }
    fn collections(&self, user: &str, now: Instant) -> Vec<Json> {
        match self.list(user, now).get("collections") {
            Some(Json::Array(a)) => a.clone(),
            other => panic!("{other:?}"),
        }
    }
    fn block(&self, user: &str, now: Instant) -> Result<Json, Refusal> {
        self.d(now, |d| service::block(d, user, "MD-1"))
    }
    fn unblock(&self, user: &str) -> Result<Json, Refusal> {
        self.d(now_fixed(), |d| service::unblock(d, user, "MD-1"))
    }
    fn refund(
        &self,
        user: &str,
        row: &str,
        reason: &str,
        now: Instant,
    ) -> Result<(CollectionView, bool), Refusal> {
        self.d(now, |d| service::request_refund(d, user, row, reason))
    }
}

fn report(r: &RunReport) -> (i64, i64, i64, i64) {
    (r.considered, r.collected, r.failed, r.rejected)
}

fn s(j: &Json, k: &str) -> String {
    match j.get(k) {
        Some(Json::String(v)) => v.clone(),
        Some(Json::Null) | None => "null".to_owned(),
        Some(other) => other.compact(),
    }
}

fn refund_json(c: &Json) -> String {
    c.get("refund").unwrap().compact()
}

// ---------------------------------------------------------------------------------------------------------------
// no scheme wired

#[test]
fn lists_nothing_with_rail_bank_and_every_control_and_scheme_door_refuses_rail_bank() {
    let Some(st) = stack() else { return };
    let b = st.bank(Scheme::unset());
    assert_eq!(
        b.list(USER, now_fixed()).compact(),
        r#"{"scheme":{"status":"unset","standIn":null,"guaranteeDays":null,"blocker":"rail.bank"},"mandates":[],"collections":[]}"#
    );
    assert_eq!(code(b.block(USER, now_fixed())), "rail.bank");
    assert_eq!(code(b.unblock(USER)), "rail.bank");
    assert_eq!(
        code(b.refund(
            USER,
            "00000000-0000-4000-8000-000000000000",
            "x",
            now_fixed()
        )),
        "rail.bank"
    );
    assert_eq!(code(b.mandate_for("MD-1", USER)), "rail.bank");
    assert_eq!(code(b.present("C-1", "1", now_fixed())), "rail.bank");
    assert_eq!(
        code(b.d(now_fixed(), |d| service::run_due(d, 10))),
        "rail.bank"
    );
    assert_eq!(st.ledger.journal(), 0);
}

// ---------------------------------------------------------------------------------------------------------------
// setting up a mandate (the scheme speaking)

#[test]
fn answers_a_replay_with_the_same_mandate_and_refuses_other_terms_an_unknown_creditor_and_a_frozen_account()
 {
    let Some(st) = stack() else { return };
    let b = st.bank(sim(Some(30)));
    let first = b.mandate();
    assert_eq!(
        (
            first.id.as_str(),
            first.creditor_name.as_str(),
            first.status.as_str(),
            first.user_id.as_str()
        ),
        ("MD-1", "TEST Gym", "active", USER)
    );
    let again = b.mandate();
    assert_eq!(
        (again.id.as_str(), again.created_at),
        ("MD-1", first.created_at)
    );
    assert_eq!(
        code(b.mandate_for("MD-1", OTHER)),
        "bank.dd_mandate_conflict"
    );
    let unknown = b.d(now_fixed(), |d| {
        service::set_up_mandate(
            d,
            &NewMandate {
                mandate_id: "MD-2".to_owned(),
                user_id: USER.to_owned(),
                creditor_id: "NOBODY".to_owned(),
                reference: "r".to_owned(),
                asset_id: "USDT".to_owned(),
            },
        )
    });
    assert_eq!(code(unknown), "bank.dd_creditor_unknown");
    st.identity.set_status(OTHER, RecipientStatus::Frozen);
    assert_eq!(
        code(b.mandate_for("MD-3", OTHER)),
        "bank.recipient_cannot_receive"
    );
}

// ---------------------------------------------------------------------------------------------------------------
// the collection run

#[test]
fn collects_a_due_debit_once_to_the_scheme_boundary_and_a_replayed_presentment_or_a_second_run_posts_nothing()
 {
    let Some(st) = stack() else { return };
    let b = st.bank(sim(Some(30)));
    st.ledger.fund(USER, "50");
    b.mandate();
    let presented = b.present("C-1", "10", at(1)).unwrap();
    assert_eq!(
        (
            presented.status.as_str(),
            format_amount(presented.amount),
            presented.user_id.as_str()
        ),
        ("upcoming", "10".to_owned(), USER)
    );

    assert_eq!(report(&b.run(now_fixed())), (0, 0, 0, 0));
    assert_eq!(st.ledger.main(USER), "50");

    assert_eq!(report(&b.run(at(1))), (1, 1, 0, 0));
    assert_eq!(st.ledger.main(USER), "40");
    assert_eq!(st.ledger.at_rail(), "10");
    let key = format!(
        "bank.transfer.rail:{}:0",
        collection_transfer_id("MD-1", "C-1")
    );
    assert!(st.ledger.tx_by_key(&key).unwrap().is_some());

    let again = b.present("C-1", "10", at(1)).unwrap();
    assert_eq!(
        (again.id.as_str(), again.status.as_str()),
        (presented.id.as_str(), "collected")
    );
    assert_eq!(
        code(b.present("C-1", "11", at(1))),
        "bank.dd_collection_conflict"
    );
    let posts = st.ledger.journal();
    assert_eq!(b.run(at(5)).considered, 0);
    assert_eq!(st.ledger.journal(), posts);
}

#[test]
fn fails_a_collection_of_10_against_a_balance_of_4_with_bank_insufficient_funds_posts_nothing_and_shows_the_fee_as_not_set()
 {
    let Some(st) = stack() else { return };
    let b = st.bank(sim(Some(30)));
    st.ledger.fund(USER, "4");
    b.mandate();
    let presented = b.present("C-10", "10", now_fixed()).unwrap();
    assert_eq!(report(&b.run(now_fixed())), (1, 0, 1, 0));
    assert_eq!(st.ledger.main(USER), "4");
    assert_eq!(st.ledger.at_rail(), "0");
    let rows = b.collections(USER, now_fixed());
    assert_eq!(rows.len(), 1);
    let c = &rows[0];
    assert_eq!(s(c, "id"), presented.id);
    assert_eq!(s(c, "status"), "failed");
    assert_eq!(s(c, "failureCode"), "bank.insufficient_funds");
    assert_eq!(s(c, "ledgerTxId"), "null");
    assert_eq!(s(c, "failureFee"), "null");
    assert_eq!(s(c, "failureFeeBlocker"), "bank.dd_failure_fee_unset");
    assert_eq!(
        refund_json(c),
        r#"{"state":"none","endsAt":null,"requestedAt":null}"#
    );
    // The failure is recorded once: a later run does not retry or record it again.
    assert_eq!(b.run(at(1)).considered, 0);
    assert_eq!(
        code(b.refund(USER, &presented.id, "nothing was taken", now_fixed())),
        "bank.dd_refund_not_collected"
    );
}

#[test]
fn records_an_entry_that_posted_before_a_crash_instead_of_posting_it_again() {
    let Some(st) = stack() else { return };
    let b = st.bank(sim(Some(30)));
    st.ledger.fund(USER, "30");
    b.mandate();
    let presented = b.present("C-9", "7", now_fixed()).unwrap();
    // The run claimed it, posted, and stopped before marking the row.
    st.sql(&format!(
        "UPDATE bank.dd_collections SET status = 'processing' WHERE id = '{}'",
        presented.id
    ))
    .unwrap();
    let transfer_id = collection_transfer_id("MD-1", "C-9");
    let posted = st
        .ledger
        .post_recipe(
            "bankTransfer",
            &Json::obj([
                ("from", LedgerAccount::user_available(USER, "USDT").json()),
                ("to", rail_boundary("dd-sim", "USDT").json()),
                ("amount", Json::str("7")),
            ]),
            &format!("bank.transfer.rail:{transfer_id}:0"),
        )
        .unwrap();
    assert_eq!(b.run(now_fixed()).collected, 1);
    assert_eq!(st.ledger.main(USER), "23");
    let c = &b.collections(USER, now_fixed())[0];
    assert_eq!(
        (s(c, "status"), s(c, "ledgerTxId")),
        ("collected".to_owned(), posted.id)
    );
}

#[test]
fn rejects_a_collection_on_a_frozen_account_without_posting() {
    let Some(st) = stack() else { return };
    let b = st.bank(sim(Some(30)));
    st.ledger.fund(USER, "30");
    b.mandate();
    b.present("C-F", "5", now_fixed()).unwrap();
    st.identity.set_status(USER, RecipientStatus::Frozen);
    assert_eq!(b.run(now_fixed()).rejected, 1);
    assert_eq!(st.ledger.main(USER), "30");
    let c = &b.collections(USER, now_fixed())[0];
    assert_eq!(
        (s(c, "status"), s(c, "failureCode")),
        (
            "rejected".to_owned(),
            "bank.dd_account_unavailable".to_owned()
        )
    );
}

// ---------------------------------------------------------------------------------------------------------------
// the collection run when things go wrong

#[test]
fn refuses_a_colon_in_a_scheme_id_so_two_collections_never_share_one_ledger_key() {
    let Some(st) = stack() else { return };
    let mandate = |id: &str| {
        json::parse(&format!(
            r#"{{"mandateId":"{id}","userId":"{USER}","creditorId":"{CREDITOR}","reference":"r","assetId":"USDT"}}"#
        ))
        .unwrap()
    };
    let value = |j: &Json| service_kit::schema::Value::from_json(j);
    assert!(dd::mandate_body(&value(&mandate("X:Y"))).is_none());
    assert!(dd::mandate_body(&value(&mandate("X.Y-1_2"))).is_some());
    let collection = json::parse(&format!(
        r#"{{"mandateId":"X","collectionId":"Y:Z","amount":"1","dueAt":"{}"}}"#,
        now_fixed().iso()
    ))
    .unwrap();
    assert!(dd::collection_body(&value(&collection)).is_none());
    // And the table refuses one too, whoever writes it.
    let b = st.bank(sim(Some(30)));
    assert!(b.mandate_for("X:Y", USER).is_err());
}

#[test]
fn two_overlapping_runs_debit_a_collection_once_and_the_books_agree_with_the_rows() {
    let Some(st) = stack() else { return };
    let b = st.bank(sim(Some(30)));
    st.ledger.fund(USER, "50");
    b.mandate();
    for id in ["C-A", "C-B", "C-C"] {
        b.present(id, "4", now_fixed()).unwrap();
    }
    std::thread::scope(|sc| {
        let one = sc.spawn(|| b.run(now_fixed()));
        let two = sc.spawn(|| b.run(now_fixed()));
        one.join().unwrap();
        two.join().unwrap();
    });
    // Invariant: what left the person, what reached the scheme's boundary and the collected rows are the same 12.
    assert_eq!(st.ledger.main(USER), "38");
    assert_eq!(st.ledger.at_rail(), "12");
    let total: String = st
        .db
        .client()
        .query_one(
            "SELECT coalesce(sum(amount), 0)::text FROM bank.dd_collections WHERE status = 'collected'",
            &[],
        )
        .unwrap()
        .get(0);
    assert_eq!(format_amount(amt(&total)), "12");
    assert_eq!(st.ledger.journal(), 3);
}

#[test]
fn a_block_racing_the_run_never_errors_each_collection_ends_collected_or_refused_never_both() {
    let Some(st) = stack() else { return };
    let b = st.bank(sim(Some(30)));
    st.ledger.fund(USER, "100");
    b.mandate();
    for i in 0..8 {
        b.present(&format!("C-R{i}"), "1", now_fixed()).unwrap();
    }
    let blocked = std::thread::scope(|sc| {
        let block = sc.spawn(|| b.block(USER, now_fixed()));
        let run = sc.spawn(|| b.run(now_fixed()));
        run.join().unwrap();
        block.join().unwrap().unwrap()
    });
    let statuses: Vec<String> = st
        .db
        .client()
        .query("SELECT status FROM bank.dd_collections", &[])
        .unwrap()
        .iter()
        .map(|r| r.get(0))
        .collect();
    let collected = statuses.iter().filter(|s| *s == "collected").count();
    assert!(
        statuses.iter().all(|s| s == "collected" || s == "rejected"),
        "{statuses:?}"
    );
    let Some(Json::Array(rejected)) = blocked.get("rejected") else {
        panic!()
    };
    assert!(rejected.len() <= 8 - collected);
    assert_eq!(
        st.ledger.main(USER),
        format_amount(amt("100") - amt(&collected.to_string()))
    );
    // Invariant: a blocked mandate's collection posts nothing: one ledger post per collected row, no more.
    assert_eq!(st.ledger.journal(), collected);
}

#[test]
fn a_main_balance_that_cannot_be_debited_fails_by_its_reason_and_posts_nothing() {
    let Some(st) = stack() else { return };
    let b = st.bank(sim(Some(30)));
    st.ledger.fund(USER, "50");
    b.mandate();
    let primary = space::with(&st.store, |c| space::ensure_primary(c, USER, "USDT")).unwrap();
    st.sql(&format!(
        "UPDATE bank.spaces SET locked_until = '{}' WHERE id = '{}'",
        at(5).iso(),
        primary.id
    ))
    .unwrap();
    b.present("C-L", "5", now_fixed()).unwrap();
    assert_eq!(b.run(now_fixed()).failed, 1);
    assert_eq!(
        st.status("C-L"),
        ("failed".to_owned(), Some("bank.space_locked".to_owned()))
    );
    assert_eq!(st.ledger.main(USER), "50");
}

#[test]
fn an_identity_outage_leaves_the_collection_processing_and_the_next_run_collects_it_once() {
    let Some(st) = stack() else { return };
    let b = st.bank(sim(Some(30)));
    st.ledger.fund(USER, "50");
    b.mandate();
    b.present("C-O", "5", now_fixed()).unwrap();
    *st.identity.recipient_failure.lock().unwrap() = Some(RecipientUnavailable {
        message: "identity is down".to_owned(),
        unset: false,
    });
    let r = b.run(now_fixed());
    assert_eq!((r.collected, r.failed, r.rejected), (0, 0, 0));
    assert_eq!(r.failures.len(), 1);
    assert_eq!(st.status("C-O"), ("processing".to_owned(), None));
    assert_eq!(st.ledger.main(USER), "50");
    *st.identity.recipient_failure.lock().unwrap() = None;
    assert_eq!(b.run(now_fixed()).collected, 1);
    assert_eq!(st.ledger.main(USER), "45");
}

#[test]
fn an_entry_the_ledger_refuses_as_invalid_fails_by_name_instead_of_staying_processing() {
    let Some(st) = stack() else { return };
    let b = st.bank(sim(Some(30)));
    st.ledger.invalid(true);
    st.ledger.fund(USER, "50");
    b.mandate();
    b.present("C-I", "5", now_fixed()).unwrap();
    assert_eq!(b.run(now_fixed()).failed, 1);
    assert_eq!(
        st.status("C-I"),
        (
            "failed".to_owned(),
            Some("bank.dd_collection_invalid".to_owned())
        )
    );
    assert_eq!(st.ledger.main(USER), "50");
}

// ---------------------------------------------------------------------------------------------------------------
// blocking a mandate

#[test]
fn rejects_its_upcoming_and_new_collections_with_the_reason_lists_it_blocked_and_unblocking_collects_again()
 {
    let Some(st) = stack() else { return };
    let b = st.bank(sim(Some(30)));
    st.ledger.fund(USER, "50");
    b.mandate();
    b.present("C-1", "10", at(3)).unwrap();

    let blocked = b.block(USER, now_fixed()).unwrap();
    let m = blocked.get("mandate").unwrap();
    assert_eq!(
        (s(m, "status"), s(m, "blockedAt")),
        ("blocked".to_owned(), now_fixed().iso())
    );
    assert_eq!(s(&blocked, "rejected"), r#"["C-1"]"#);
    assert_eq!(s(&blocked, "tooLate"), "[]");
    // Blocking again changes nothing.
    let again = b.block(USER, at(1)).unwrap();
    assert_eq!(
        s(again.get("mandate").unwrap(), "blockedAt"),
        now_fixed().iso()
    );
    assert_eq!(s(&again, "rejected"), "[]");

    let next = b.present("C-2", "10", at(4)).unwrap();
    assert_eq!(
        (next.status.as_str(), next.failure_code.as_deref()),
        ("rejected", Some("bank.dd_mandate_blocked"))
    );
    assert_eq!(b.run(at(10)).considered, 0);
    assert_eq!(st.ledger.main(USER), "50");
    let view = b.list(USER, now_fixed());
    let Some(Json::Array(mandates)) = view.get("mandates") else {
        panic!()
    };
    assert_eq!(mandates.len(), 1);
    assert_eq!(
        (
            s(&mandates[0], "id"),
            s(&mandates[0], "status"),
            s(&mandates[0], "upcoming")
        ),
        ("MD-1".to_owned(), "blocked".to_owned(), "[]".to_owned())
    );
    let rows: Vec<(String, String, String)> = b
        .collections(USER, now_fixed())
        .iter()
        .map(|c| (s(c, "collectionId"), s(c, "status"), s(c, "failureCode")))
        .collect();
    let row = |c: &str| {
        (
            c.to_owned(),
            "rejected".to_owned(),
            "bank.dd_mandate_blocked".to_owned(),
        )
    };
    assert_eq!(rows, vec![row("C-2"), row("C-1")]);

    let un = b.unblock(USER).unwrap();
    let m = un.get("mandate").unwrap();
    assert_eq!(
        (s(m, "status"), s(m, "blockedAt")),
        ("active".to_owned(), "null".to_owned())
    );
    b.present("C-3", "10", at(5)).unwrap();
    assert_eq!(b.run(at(5)).collected, 1);
    assert_eq!(st.ledger.main(USER), "40");
}

#[test]
fn names_a_collection_a_run_already_claimed_as_too_late_and_that_one_still_settles() {
    let Some(st) = stack() else { return };
    let b = st.bank(sim(Some(30)));
    st.ledger.fund(USER, "20");
    b.mandate();
    let claimed = b.present("C-L", "5", now_fixed()).unwrap();
    st.sql(&format!(
        "UPDATE bank.dd_collections SET status = 'processing' WHERE id = '{}'",
        claimed.id
    ))
    .unwrap();
    let blocked = b.block(USER, now_fixed()).unwrap();
    assert_eq!(
        s(&blocked, "tooLate"),
        r#"[{"collectionId":"C-L","code":"bank.dd_too_late"}]"#
    );
    assert_eq!(b.run(now_fixed()).collected, 1);
    assert_eq!(st.ledger.main(USER), "15");
}

#[test]
fn reads_another_persons_mandate_as_missing() {
    let Some(st) = stack() else { return };
    let b = st.bank(sim(Some(30)));
    b.mandate();
    assert_eq!(
        code(b.block(OTHER, now_fixed())),
        "bank.dd_mandate_not_found"
    );
    assert_eq!(code(b.unblock(OTHER)), "bank.dd_mandate_not_found");
    assert_eq!(s(&b.list(OTHER, now_fixed()), "mandates"), "[]");
}

#[test]
fn shows_the_next_month_of_upcoming_collections_on_the_mandate_soonest_first() {
    let Some(st) = stack() else { return };
    let b = st.bank(sim(Some(30)));
    b.mandate();
    for (id, days) in [("C-40", 40), ("C-20", 20), ("C-5", 5)] {
        b.present(id, "1", at(days)).unwrap();
    }
    let view = b.list(USER, now_fixed());
    let Some(Json::Array(mandates)) = view.get("mandates") else {
        panic!()
    };
    let Some(Json::Array(upcoming)) = mandates[0].get("upcoming") else {
        panic!()
    };
    let ids: Vec<String> = upcoming.iter().map(|c| s(c, "collectionId")).collect();
    assert_eq!(ids, ["C-5", "C-20"]);
    assert_eq!(s(&view, "collections"), "[]");
}

// ---------------------------------------------------------------------------------------------------------------
// a refund request

/// `collected(bank)`: a debit of 12 collected now; its row id.
fn collected(st: &Stack, b: &Bank) -> String {
    st.ledger.fund(USER, "50");
    b.mandate();
    let row = b.present("C-R", "12", now_fixed()).unwrap();
    b.run(now_fixed());
    row.id
}

#[test]
fn is_created_once_inside_the_guarantee_period_and_support_sees_it() {
    let Some(st) = stack() else { return };
    let b = st.bank(sim(Some(30)));
    let id = collected(&st, &b);
    let before = &b.collections(USER, now_fixed())[0];
    assert_eq!(
        refund_json(before),
        format!(
            r#"{{"state":"available","endsAt":"{}","requestedAt":null}}"#,
            at(30).iso()
        )
    );

    let (first, created) = b
        .refund(USER, &id, "I cancelled this membership", at(2))
        .unwrap();
    assert!(created);
    assert_eq!(
        (first.refund.state, first.refund.requested_at),
        ("requested", Some(at(2)))
    );
    let (second, created) = b.refund(USER, &id, "again", at(3)).unwrap();
    assert!(!created);
    assert_eq!(second.refund.requested_at, Some(at(2)));

    let queue = b.d(at(3), |d| service::ops_refunds(d, None)).unwrap();
    assert_eq!(queue.len(), 1);
    let line = queue[0].json_for_support();
    assert_eq!(
        (
            s(&line, "id"),
            s(&line, "userId"),
            s(&line, "reason"),
            s(&line, "amount"),
            s(&line, "creditorName")
        ),
        (
            id.clone(),
            USER.to_owned(),
            "I cancelled this membership".to_owned(),
            "12".to_owned(),
            "TEST Gym".to_owned()
        )
    );
    // A request moves no money: the credit back is the scheme's answer.
    assert_eq!(st.ledger.main(USER), "38");
    assert_eq!(
        code(b.refund(OTHER, &id, "not mine", at(2))),
        "bank.dd_collection_not_found"
    );
}

#[test]
fn is_refused_after_the_period_with_its_end_date_keeps_the_window_fixed_when_collected_and_is_refused_with_no_period()
 {
    let Some(st) = stack() else { return };
    let b = st.bank(sim(Some(30)));
    let id = collected(&st, &b);
    match b.refund(USER, &id, "late", at(31)) {
        Err(Refusal::Bank(e)) => {
            assert_eq!(e.row.code, "bank.dd_refund_window_closed");
            assert!(e.message.contains(&at(30).iso()), "{}", e.message);
        }
        other => panic!("{other:?}"),
    }
    // The period changes later (here to 8 days): the window this debit was collected with does not move.
    let shorter = st.bank(sim(Some(8)));
    assert_eq!(
        refund_json(&shorter.collections(USER, at(10))[0]),
        format!(
            r#"{{"state":"available","endsAt":"{}","requestedAt":null}}"#,
            at(30).iso()
        )
    );

    // Collected while no period was set: no refund window, and a request is refused by name.
    let unset = st.bank(sim(None));
    unset.present("C-U", "1", now_fixed()).unwrap();
    unset.run(now_fixed());
    let without = unset
        .collections(USER, now_fixed())
        .into_iter()
        .find(|c| s(c, "collectionId") == "C-U")
        .unwrap();
    assert_eq!(
        refund_json(&without),
        r#"{"state":"unset","endsAt":null,"requestedAt":null}"#
    );
    assert_eq!(
        code(unset.refund(USER, &s(&without, "id"), "x", now_fixed())),
        "bank.dd_guarantee_unset"
    );
}

// ---------------------------------------------------------------------------------------------------------------
// the customer doors

fn person(user: &str) -> Vec<(String, String)> {
    let raw = Json::obj([
        ("sub", Json::str(user)),
        (
            "scopes",
            Json::Array(vec![Json::str("bank:read"), Json::str("bank:write")]),
        ),
        ("tier", Json::str("full")),
        ("mfa", Json::Bool(true)),
        ("sid", Json::str("33333333-3333-4333-8333-333333333333")),
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
        "req-dd-db",
        "127.0.0.1",
    );
    (res.status, json::parse(&res.body).unwrap())
}

fn call(door: &BankDoor, user: &str, path: &str, input: &str) -> (u16, Json) {
    match door::call(path).map(|c| c.kind) {
        Some(Kind::Query) if input.is_empty() => {
            send(door, &format!("/trpc/{path}"), "GET", "", person(user))
        }
        Some(Kind::Query) => send(
            door,
            &format!("/trpc/{path}?input={}", encode(input)),
            "GET",
            "",
            person(user),
        ),
        _ => send(door, &format!("/trpc/{path}"), "POST", input, person(user)),
    }
}

fn data(a: &(u16, Json)) -> Json {
    assert_eq!(a.0, 200, "{}", a.1.compact());
    a.1.get("result").unwrap().get("data").unwrap().clone()
}

#[test]
fn lists_blocks_and_refuses_a_stranger_and_the_support_queue_over_http_with_no_scheme_a_block_is_rail_bank()
 {
    let Some(st) = stack() else { return };
    let b = st.bank(sim(Some(30)));
    b.mandate();
    let list = data(&call(&b.door, USER, "directDebits.list", ""));
    let Some(Json::Array(mandates)) = list.get("mandates") else {
        panic!()
    };
    assert_eq!(
        (s(&mandates[0], "id"), s(&mandates[0], "status")),
        ("MD-1".to_owned(), "active".to_owned())
    );
    let block = |user: &str| {
        call(
            &b.door,
            user,
            "directDebits.block",
            r#"{"mandateId":"MD-1"}"#,
        )
    };
    assert_eq!(block(OTHER).0, 404);
    let mine = data(&block(USER));
    assert_eq!(s(mine.get("mandate").unwrap(), "status"), "blocked");
    assert_eq!(call(&b.door, USER, "directDebits.ops.refunds", "{}").0, 403);

    let off = st.bank(Scheme::unset());
    let refused = call(
        &off.door,
        USER,
        "directDebits.block",
        r#"{"mandateId":"MD-1"}"#,
    );
    assert_eq!(refused.0, 412);
    let cause = refused
        .1
        .get("error")
        .unwrap()
        .get("data")
        .unwrap()
        .get("cause")
        .unwrap();
    assert_eq!(s(cause, "code"), "rail.bank");
}

// ---------------------------------------------------------------------------------------------------------------
// when the partner bank holds the money (OWNER 226)

#[test]
fn collects_a_due_debit_as_one_partner_move_under_its_key_posts_nothing_on_the_ledger_and_a_second_run_moves_nothing()
 {
    let Some(st) = stack() else { return };
    let b = st.held();
    b.partner_fund("dd-held-1", "50");
    b.mandate();
    b.present("C-1", "5", now_fixed()).unwrap();
    assert_eq!(report(&b.run(now_fixed())), (1, 1, 0, 0));
    assert_eq!(b.at_partner(), "45");
    assert_eq!(b.paid_out(), "5");
    let moved = b
        .partner()
        .lock()
        .book
        .by_key(&collection_partner_key("MD-1", "C-1"))
        .cloned()
        .unwrap();
    assert_eq!(moved.amount, amt("5"));
    assert_eq!(moved.from, AccountRef::main(USER, "USDT"));
    assert_eq!(moved.to, payouts_account("USDT"));
    let row = &b.collections(USER, now_fixed())[0];
    assert_eq!(
        (
            s(row, "status"),
            s(row, "ledgerTxId"),
            s(row, "partnerMoveId")
        ),
        ("collected".to_owned(), "null".to_owned(), moved.id.clone())
    );
    assert_eq!(s(row.get("refund").unwrap(), "state"), "available");
    assert_eq!(b.run(at(1)).considered, 0);
    assert_eq!(b.at_partner(), "45");
    assert_eq!(st.ledger.journal(), 0);
    // Inside the guarantee period the collected debit can be asked back.
    let (c, created) = b
        .refund(USER, &s(row, "id"), "TEST cancelled", now_fixed())
        .unwrap();
    assert!(created);
    assert_eq!(c.refund.state, "requested");
}

#[test]
fn fails_a_collection_of_10_against_a_partner_balance_of_4_with_the_partners_reason_moving_nothing()
{
    let Some(st) = stack() else { return };
    let b = st.held();
    b.partner_fund("dd-held-4", "4");
    b.mandate();
    let presented = b.present("C-10", "10", now_fixed()).unwrap();
    assert_eq!(report(&b.run(now_fixed())), (1, 0, 1, 0));
    assert_eq!(b.at_partner(), "4");
    assert_eq!(b.paid_out(), "0");
    assert!(
        b.partner()
            .lock()
            .book
            .by_key(&collection_partner_key("MD-1", "C-10"))
            .is_none()
    );
    let row = &b.collections(USER, now_fixed())[0];
    assert_eq!(s(row, "id"), presented.id);
    assert_eq!(s(row, "status"), "failed");
    assert_eq!(s(row, "failureCode"), "bank.partner_insufficient_funds");
    assert_eq!(s(row, "ledgerTxId"), "null");
    assert_eq!(s(row, "partnerMoveId"), "null");
    assert_eq!(s(row, "failureFeeBlocker"), "bank.dd_failure_fee_unset");
    assert_eq!(st.ledger.journal(), 0);
}

#[test]
fn sends_the_block_to_the_partner_first_upcoming_and_new_collections_are_rejected_with_the_partners_reason()
 {
    let Some(st) = stack() else { return };
    let b = st.held();
    b.partner_fund("dd-held-block", "50");
    b.mandate();
    b.present("C-1", "10", at(3)).unwrap();

    // The partner is not answering: nothing is blocked there, and so nothing is recorded here.
    b.switch(USER, |s| s.down = true);
    assert_eq!(code(b.block(USER, now_fixed())), "bank.partner_unavailable");
    let view = b.list(USER, now_fixed());
    let Some(Json::Array(mandates)) = view.get("mandates") else {
        panic!()
    };
    assert_eq!(s(&mandates[0], "status"), "active");
    b.switch(USER, |s| s.down = false);

    let blocked = b.block(USER, now_fixed()).unwrap();
    assert_eq!(s(blocked.get("mandate").unwrap(), "status"), "blocked");
    assert_eq!(s(&blocked, "rejected"), r#"["C-1"]"#);
    assert_eq!(s(&blocked, "sentTo"), "TEST partner bank");
    let at_partner = b
        .partner()
        .lock()
        .dd_mandate(USER, "MD-1", None, now_fixed())
        .unwrap();
    assert!(at_partner.blocked_at.is_some());
    let next = b.present("C-2", "3", at(1)).unwrap();
    assert_eq!(
        (
            next.status.as_str(),
            next.failure_code.as_deref(),
            next.ledger_tx_id.as_deref(),
            next.partner_move_id.as_deref()
        ),
        ("rejected", Some(DD_BLOCKED), None, None)
    );
    let codes: Vec<(String, String)> = b
        .collections(USER, now_fixed())
        .iter()
        .map(|c| (s(c, "collectionId"), s(c, "failureCode")))
        .collect();
    assert_eq!(
        codes,
        vec![
            ("C-1".to_owned(), DD_BLOCKED.to_owned()),
            ("C-2".to_owned(), DD_BLOCKED.to_owned())
        ]
    );

    // Unblocked at the partner too: the mandate collects again.
    b.unblock(USER).unwrap();
    let at_partner = b
        .partner()
        .lock()
        .dd_mandate(USER, "MD-1", None, now_fixed())
        .unwrap();
    assert!(at_partner.blocked_at.is_none());
    b.present("C-3", "10", now_fixed()).unwrap();
    assert_eq!(b.run(now_fixed()).collected, 1);
    assert_eq!(b.at_partner(), "40");
    assert_eq!(st.ledger.journal(), 0);
}

#[test]
fn a_collection_the_partner_reports_blocked_at_run_time_is_rejected_with_its_reason_and_nothing_moves()
 {
    let Some(st) = stack() else { return };
    let b = st.held();
    b.partner_fund("dd-held-late", "50");
    b.mandate();
    b.present("C-1", "10", now_fixed()).unwrap();
    // Blocked at the partner before the block was recorded here (a crash in between).
    b.partner()
        .lock()
        .dd_block(USER, "MD-1", now_fixed())
        .unwrap();
    let r = b.run(now_fixed());
    assert_eq!((r.rejected, r.collected), (1, 0));
    assert_eq!(
        s(&b.collections(USER, now_fixed())[0], "failureCode"),
        DD_BLOCKED
    );
    assert_eq!(b.at_partner(), "50");
}

#[test]
fn records_a_partner_move_made_before_a_crash_instead_of_moving_again_and_an_outage_leaves_it_for_the_next_run()
 {
    let Some(st) = stack() else { return };
    let b = st.held();
    b.partner_fund("dd-held-crash", "30");
    b.mandate();
    let presented = b.present("C-9", "7", now_fixed()).unwrap();
    b.switch(USER, |s| "lost".clone_into(&mut s.next_reply));
    let lost = b.run(now_fixed());
    assert_eq!(lost.collected, 0);
    assert_eq!(
        lost.failures
            .iter()
            .map(|f| f.2.clone())
            .collect::<Vec<_>>(),
        vec![Some("bank.partner_reply_lost".to_owned())]
    );
    let row = &b.collections(USER, now_fixed())[0];
    assert_eq!(
        (s(row, "id"), s(row, "status")),
        (presented.id, "processing".to_owned())
    );
    assert_eq!(b.run(now_fixed()).collected, 1);
    assert_eq!(b.at_partner(), "23");
    assert_eq!(st.ledger.journal(), 0);
}

#[test]
fn a_collected_row_names_exactly_one_movement_the_database_refuses_both_a_ledger_and_a_partner_reference()
 {
    let Some(st) = stack() else { return };
    let b = st.held();
    b.mandate();
    let presented = b.present("C-x", "1", now_fixed()).unwrap();
    let both = st
        .sql(&format!(
            "UPDATE bank.dd_collections SET status = 'collected', settled_at = now(), ledger_tx_id = 'tx', \
             partner_move_id = 'mv' WHERE id = '{}'",
            presented.id
        ))
        .unwrap_err();
    assert!(
        format!("{both:?}").contains("dd_collections_posted_ck"),
        "{both:?}"
    );
    let one = st
        .sql(&format!(
            "UPDATE bank.dd_collections SET partner_move_id = 'mv' WHERE id = '{}'",
            presented.id
        ))
        .unwrap_err();
    assert!(
        format!("{one:?}").contains("dd_collections_posted_ck"),
        "{one:?}"
    );
}

// ---------------------------------------------------------------------------------------------------------------
// the TEST partner's direct debit book (J-bank-28 #4): `test-partner-direct-debits.test.ts`

const ADA: &str = "11111111-1111-4111-8111-111111111111";

fn ada_partner(fund: Option<&str>) -> TestPartner {
    let p = TestPartner::new().unwrap();
    if let Some(amount) = fund {
        p.lock()
            .fund(
                ADA,
                &Funding {
                    fund_id: "f1".to_owned(),
                    asset_id: "USDT".to_owned(),
                    amount: amt(amount),
                },
                now_fixed(),
            )
            .unwrap();
    }
    p
}

fn collect(p: &TestPartner, mandate: &str, collection: &str, amount: &str) -> Result<(), Refusal> {
    p.lock()
        .move_raw(
            &MoveRequest {
                key: format!("bank.dd.collection:{mandate}:{collection}"),
                from: AccountRef::main(ADA, "USDT"),
                to: payouts_account("USDT"),
                amount: amt(amount),
                payees: None,
            },
            now_fixed(),
        )
        .map(|_| ())
}

fn ada_held(p: &TestPartner) -> String {
    format_amount(p.lock().book.amount(&AccountRef::main(ADA, "USDT")))
}

#[test]
fn knows_a_mandate_from_its_setup_and_reports_its_block() {
    let p = ada_partner(None);
    p.lock().dd_set_up(ADA, "MD-1", now_fixed()).unwrap();
    p.lock().dd_block(ADA, "MD-2", now_fixed()).unwrap();
    let r = p.lock().dd_report(now_fixed());
    let states: Vec<(String, bool)> = r
        .mandates
        .iter()
        .map(|m| (m.1.clone(), m.2.is_some()))
        .collect();
    assert_eq!(
        states,
        vec![("MD-1".to_owned(), false), ("MD-2".to_owned(), true)]
    );
}

#[test]
fn records_a_refusal_only_when_asked_for_a_collection_on_a_blocked_mandate_once_per_collection() {
    let p = ada_partner(None);
    p.lock().dd_block(ADA, "MD-1", now_fixed()).unwrap();
    p.lock().dd_mandate(ADA, "MD-1", None, now_fixed()).unwrap();
    assert!(p.lock().dd_report(now_fixed()).failures.is_empty());
    p.lock()
        .dd_mandate(ADA, "MD-1", Some("C-1"), now_fixed())
        .unwrap();
    p.lock()
        .dd_mandate(ADA, "MD-1", Some("C-1"), now_fixed())
        .unwrap();
    let failures: Vec<(String, String)> = p
        .lock()
        .dd_report(now_fixed())
        .failures
        .iter()
        .map(|f| (f.2.clone(), f.3.clone()))
        .collect();
    assert_eq!(failures, vec![("C-1".to_owned(), DD_BLOCKED.to_owned())]);
}

#[test]
fn records_a_collection_it_refuses_for_want_of_money_and_nothing_moves() {
    let p = ada_partner(Some("4"));
    assert_eq!(
        code(collect(&p, "MD-1", "C-9", "10")),
        "bank.partner_insufficient_funds"
    );
    assert_eq!(ada_held(&p), "4");
    let failures: Vec<(String, String, String)> = p
        .lock()
        .dd_report(now_fixed())
        .failures
        .iter()
        .map(|f| (f.1.clone(), f.2.clone(), f.3.clone()))
        .collect();
    assert_eq!(
        failures,
        vec![(
            "MD-1".to_owned(),
            "C-9".to_owned(),
            "bank.partner_insufficient_funds".to_owned()
        )]
    );
}

#[test]
fn refunds_a_collected_debit_once_the_balance_rises_by_the_collection_exactly_and_asking_again_changes_nothing()
 {
    let p = ada_partner(Some("20"));
    collect(&p, "MD-1", "C-1", "5").unwrap();
    assert_eq!(ada_held(&p), "15");
    let first = p.lock().dd_refund(ADA, "MD-1", "C-1", now_fixed()).unwrap();
    assert_eq!(ada_held(&p), "20");
    let again = p.lock().dd_refund(ADA, "MD-1", "C-1", now_fixed()).unwrap();
    assert_eq!(again, first);
    assert_eq!(ada_held(&p), "20");
    assert_eq!((first.amount, first.asset_id.as_str()), (amt("5"), "USDT"));
    // The partner's book: one collection out and one refund back, nothing else.
    let keys: Vec<String> = p
        .lock()
        .record(ADA)
        .moves
        .iter()
        .map(|m| m.key.clone())
        .filter(|k| k.starts_with("bank.dd."))
        .collect();
    assert_eq!(
        keys,
        ["bank.dd.collection:MD-1:C-1", "bank.dd.refund:MD-1:C-1"]
    );
    assert_eq!(p.lock().dd_report(now_fixed()).refunds.len(), 1);
}

#[test]
fn refuses_a_refund_of_a_debit_it_never_collected_or_of_someone_elses_and_nothing_moves() {
    let p = ada_partner(Some("20"));
    assert_eq!(
        code(p.lock().dd_refund(ADA, "MD-1", "C-404", now_fixed())),
        "bank.dd_refund_not_collected"
    );
    assert_eq!(ada_held(&p), "20");
    assert!(p.lock().dd_report(now_fixed()).refunds.is_empty());
}

fn detail(user: &str, creditor: &str, reference: &str) -> service::Mandate {
    service::Mandate {
        id: String::new(),
        user_id: user.to_owned(),
        scheme: "dd-sim".to_owned(),
        creditor_id: CREDITOR.to_owned(),
        creditor_name: creditor.to_owned(),
        reference: reference.to_owned(),
        asset_id: "USDT".to_owned(),
        status: "active".to_owned(),
        blocked_at: None,
        created_at: now_fixed(),
    }
}

#[test]
fn the_desk_view_mandates_with_their_refunds_and_failures_failures_counted_by_reason_details_only_for_the_right_person()
 {
    let p = ada_partner(Some("20"));
    p.lock().dd_set_up(ADA, "MD-1", now_fixed()).unwrap();
    collect(&p, "MD-1", "C-1", "5").unwrap();
    p.lock().dd_refund(ADA, "MD-1", "C-1", now_fixed()).unwrap();
    p.lock().dd_block(ADA, "MD-2", now_fixed()).unwrap();
    p.lock()
        .dd_mandate(ADA, "MD-2", Some("C-2"), now_fixed())
        .unwrap();
    assert!(collect(&p, "MD-3", "C-3", "100").is_err());
    let details: BTreeMap<String, service::Mandate> = [
        ("MD-1".to_owned(), detail(ADA, "TEST Gym", "GYM 1")),
        ("MD-2".to_owned(), detail("someone-else", "Not theirs", "X")),
    ]
    .into_iter()
    .collect();
    let report = p.lock().dd_report(now_fixed());
    let view = desk::view(Some(&report), &details);
    let partner = view.get("partner").unwrap();
    let Some(Json::Array(mandates)) = partner.get("mandates") else {
        panic!()
    };
    let by = |id: &str| {
        mandates
            .iter()
            .find(|m| s(m, "mandateId") == id)
            .unwrap()
            .clone()
    };
    let one = by("MD-1");
    assert_eq!(
        (s(&one, "state"), s(&one, "creditorName")),
        ("active".to_owned(), "TEST Gym".to_owned())
    );
    let refunds = one.get("refunds").unwrap();
    let Json::Array(refunds) = refunds else {
        panic!()
    };
    assert_eq!(
        (s(&refunds[0], "collectionId"), s(&refunds[0], "amount")),
        ("C-1".to_owned(), "5".to_owned())
    );
    let two = by("MD-2");
    assert_eq!(
        (s(&two, "state"), s(&two, "creditorName")),
        ("blocked".to_owned(), "null".to_owned())
    );
    let Some(Json::Array(failures)) = two.get("failures") else {
        panic!()
    };
    assert_eq!(
        (s(&failures[0], "collectionId"), s(&failures[0], "code")),
        ("C-2".to_owned(), DD_BLOCKED.to_owned())
    );
    let Some(Json::Array(failures)) = by("MD-3").get("failures").cloned() else {
        panic!()
    };
    assert_eq!(failures.len(), 1);
    assert_eq!(s(&failures[0], "code"), "bank.partner_insufficient_funds");
    assert_eq!(
        s(partner, "failuresByReason"),
        format!(
            r#"[{{"code":"bank.partner_insufficient_funds","count":1}},{{"code":"{DD_BLOCKED}","count":1}}]"#
        )
    );
    assert_eq!(s(partner, "refundCount"), "1");
}

#[test]
fn with_no_partner_the_desk_view_is_no_data() {
    assert_eq!(
        desk::view(None, &BTreeMap::new()).compact(),
        r#"{"partner":null}"#
    );
}

// ---------------------------------------------------------------------------------------------------------------
// the invariants and the job doors (not in the TypeScript suites)

#[test]
fn a_collection_whose_ledger_answer_is_lost_after_booking_stays_processing_and_the_next_run_records_it_without_posting_again()
 {
    let Some(st) = stack() else { return };
    let b = st.bank(sim(Some(30)));
    st.ledger.fund(USER, "30");
    b.mandate();
    b.present("C-LOST", "7", now_fixed()).unwrap();
    st.ledger.lose_next();
    let lost = b.run(now_fixed());
    assert_eq!((lost.collected, lost.failures.len()), (0, 1));
    assert_eq!(st.status("C-LOST"), ("processing".to_owned(), None));
    assert_eq!(st.ledger.journal(), 1);
    assert_eq!(b.run(now_fixed()).collected, 1);
    // Posted once under its key: one journal entry, 7 out, 7 at the rail.
    assert_eq!(st.ledger.journal(), 1);
    assert_eq!(st.ledger.main(USER), "23");
    assert_eq!(st.ledger.at_rail(), "7");
    let c = &b.collections(USER, now_fixed())[0];
    assert_eq!(s(c, "ledgerTxId"), "tx-1");
}

#[test]
fn with_the_custodial_layer_off_a_collection_posts_nothing_and_stays_processing_with_no_partner_bank()
 {
    let Some(st) = stack() else { return };
    let b = st.door(sim(Some(30)), true, false, "off");
    st.ledger.fund(USER, "30");
    b.mandate();
    b.present("C-OFF", "7", now_fixed()).unwrap();
    let r = b.run(now_fixed());
    assert_eq!(
        r.failures.iter().map(|f| f.2.clone()).collect::<Vec<_>>(),
        vec![Some("bank.no_partner_bank".to_owned())]
    );
    assert_eq!(st.status("C-OFF"), ("processing".to_owned(), None));
    assert_eq!(st.ledger.journal(), 0);
    assert_eq!(st.ledger.main(USER), "30");
}

#[test]
fn a_failed_or_rejected_collection_has_no_ledger_tx() {
    let Some(st) = stack() else { return };
    let b = st.bank(sim(Some(30)));
    st.ledger.fund(USER, "4");
    b.mandate();
    b.present("C-SHORT", "10", now_fixed()).unwrap();
    b.run(now_fixed());
    b.block(USER, now_fixed()).unwrap();
    b.present("C-BLOCKED", "1", now_fixed()).unwrap();
    b.run(now_fixed());
    assert_eq!(
        st.db.count(
            "SELECT count(*) FROM bank.dd_collections WHERE status IN ('failed', 'rejected') \
             AND (ledger_tx_id IS NOT NULL OR partner_move_id IS NOT NULL)"
        ),
        0
    );
    assert_eq!(
        st.db.count(
            "SELECT count(*) FROM bank.dd_collections WHERE status IN ('failed', 'rejected')"
        ),
        2
    );
    assert_eq!(st.ledger.journal(), 0);
}

fn job(door: &BankDoor, path: &str, body: &str, signed: bool) -> (u16, Json) {
    let headers = if signed {
        s2s::legacy_headers("svc-bank", INTERNAL, body, system_seconds()).unwrap()
    } else {
        Vec::new()
    };
    send(door, path, "POST", body, headers)
}

#[test]
fn the_scheme_doors_refuse_an_unsigned_caller_and_a_body_not_in_shape_set_up_present_and_the_run_collects()
 {
    let Some(st) = stack() else { return };
    let b = st.bank(sim(Some(30)));
    st.ledger.fund(USER, "50");
    let mandate = format!(
        r#"{{"mandateId":"MD-1","userId":"{USER}","creditorId":"{CREDITOR}","reference":"  TEST membership  ","assetId":"USDT"}}"#
    );
    assert_eq!(job(&b.door, dd::DD_SIM_MANDATE, &mandate, false).0, 401);
    let bad = job(&b.door, dd::DD_SIM_MANDATE, r#"{"mandateId":"MD-1"}"#, true);
    assert_eq!(
        (bad.0, s(&bad.1, "code")),
        (400, "bank.validation_failed".to_owned())
    );
    let made = job(&b.door, dd::DD_SIM_MANDATE, &mandate, true);
    assert_eq!(made.0, 200, "{}", made.1.compact());
    assert_eq!(
        (s(&made.1, "reference"), s(&made.1, "userId")),
        ("TEST membership".to_owned(), USER.to_owned())
    );
    let collection = format!(
        r#"{{"mandateId":"MD-1","collectionId":"C-1","amount":"10","dueAt":"{}"}}"#,
        door::system_now().iso()
    );
    let presented = job(&b.door, dd::DD_SIM_COLLECTION, &collection, true);
    assert_eq!(presented.0, 200, "{}", presented.1.compact());
    assert_eq!(s(&presented.1, "status"), "upcoming");
    let unknown = job(
        &b.door,
        dd::DD_SIM_COLLECTION,
        &collection.replace("MD-1", "MD-404"),
        true,
    );
    assert_eq!(
        (unknown.0, s(&unknown.1, "code")),
        (400, "bank.dd_mandate_not_found".to_owned())
    );
    assert_eq!(job(&b.door, dd::RUN_DUE_DIRECT_DEBITS, "{}", true).0, 400);
    let ran = job(&b.door, dd::RUN_DUE_DIRECT_DEBITS, r#"{"limit":10}"#, true);
    assert_eq!(ran.0, 200, "{}", ran.1.compact());
    assert_eq!(
        ran.1.compact(),
        r#"{"considered":1,"collected":1,"failed":0,"rejected":0,"failures":[]}"#
    );
    assert_eq!(st.ledger.main(USER), "40");
}

#[test]
fn the_run_door_answers_503_when_the_owner_stopped_it_and_the_scheme_doors_refuse_rail_bank_with_no_scheme()
 {
    let Some(st) = stack() else { return };
    let stopped = st.door(sim(Some(30)), false, false, "on");
    assert_eq!(
        job(
            &stopped.door,
            dd::RUN_DUE_DIRECT_DEBITS,
            r#"{"limit":10}"#,
            false
        )
        .0,
        401
    );
    let res = job(&stopped.door, dd::RUN_DUE_DIRECT_DEBITS, "{}", true);
    assert_eq!(
        (res.0, s(&res.1, "code")),
        (503, "bank.dd_collections_disabled".to_owned())
    );
    let off = st.bank(Scheme::unset());
    let mandate = format!(
        r#"{{"mandateId":"MD-1","userId":"{USER}","creditorId":"{CREDITOR}","reference":"r","assetId":"USDT"}}"#
    );
    let refused = job(&off.door, dd::DD_SIM_MANDATE, &mandate, true);
    assert_eq!(
        (refused.0, s(&refused.1, "code")),
        (400, "rail.bank".to_owned())
    );
}

#[test]
fn an_upcoming_collection_whose_mandate_was_blocked_under_it_is_rejected_by_the_run_and_posts_nothing()
 {
    let Some(st) = stack() else { return };
    let b = st.bank(sim(Some(30)));
    st.ledger.fund(USER, "30");
    b.mandate();
    b.present("C-UNDER", "5", now_fixed()).unwrap();
    // A block that landed after the presentment and left the row upcoming (a crash between the two writes).
    st.sql("UPDATE bank.dd_mandates SET status = 'blocked', blocked_at = now() WHERE id = 'MD-1'")
        .unwrap();
    assert_eq!(report(&b.run(now_fixed())), (1, 0, 0, 1));
    assert_eq!(
        st.status("C-UNDER"),
        (
            "rejected".to_owned(),
            Some("bank.dd_mandate_blocked".to_owned())
        )
    );
    assert_eq!(st.ledger.journal(), 0);
    assert_eq!(st.ledger.main(USER), "30");
}
