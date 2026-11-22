//! svc-pay's withdrawal to another person's platform address, settled by svc-bank as one person-to-person send
//! (W-withdraw-14), against the Rust code on a real Postgres. Ports every check of the TypeScript's
//! `transfers/internal-withdrawal.db.test.ts`, and the one test of `transfers/transfer-message.db.test.ts` the moves
//! suite does not (`transfers.toUser` with a note), each test named after the TypeScript test's words. The TypeScript
//! drives `settleWithdrawal` on the service, and the door through the router; here the service is
//! `personal::settle_withdrawal` and the door is the Rust door, signed as the calling service.
//!
//! The ledger is the moves suite's stand-in (`bankTransfer` booked once per key, `ledger.insufficient_funds` when the
//! payer holds too little), with two knobs the TypeScript gets by wrapping its memory ledger: a post whose answer is
//! lost, and a booked key a lookup does not see yet. Without `TEST_DATABASE_URL` each test skips; with
//! `REQUIRE_POSTGRES=1` it fails.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::too_many_lines,
    dead_code,
    reason = "a test: a failure is the point"
)]

use crate::support;

use std::cell::Cell;
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use service_kit::edge;
use service_kit::json::{self, Json};
use service_kit::money::{Amount, format_amount, parse_amount};
use service_kit::s2s;
use service_kit::s2s_verify::BodyBind;
use service_kit::server::Request;
use service_kit::time::{Instant, js_date};
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
use svc_bank::spaces::space::{self, Rules};
use svc_bank::spaces::{Tables, Wiring as SpacesWiring};
use svc_bank::transfers::personal::{self, Withdrawal};
use svc_bank::transfers::ports::{
    AccountOf, ExtraControls, Extras, HandleUnavailable, LockState, MemoryIdentity, NoIdentity,
    PartyHandles, RecipientState, RecipientStatus, RecipientUnavailable, SecurityLock,
};
use svc_bank::transfers::{self, Settings, Wiring as TransfersWiring};

use support::TestDb;

const SECRET: &str = "a-bank-withdrawal-db-edge-secret-long-enough";
const INTERNAL: &str = "a-bank-withdrawal-db-internal-secret-long-enough";
const USER_A: &str = "11111111-1111-4111-8111-111111111111";
const USER_B: &str = "22222222-2222-4222-8222-222222222222";
const ADA: &str = USER_A;
const BOB: &str = USER_B;
const CARA: &str = "33333333-3333-4333-8333-333333333333";
const NO_SUCH_USER: &str = "99999999-0000-4000-8000-000000000000";
const W1: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const W2: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

// ---------------------------------------------------------------------------------------------------------------
// The clock: the door's `now` is a plain function, so each test thread sets its own time.

thread_local! {
    static CLOCK: Cell<i64> = const { Cell::new(0) };
}

fn clock() -> Instant {
    let at = CLOCK.with(Cell::get);
    if at == 0 {
        door::system_now()
    } else {
        Instant(at)
    }
}

fn at(iso: &str) -> i64 {
    js_date(iso).unwrap().0
}

fn set_now(ms: i64) {
    CLOCK.with(|n| n.set(ms));
}

// ---------------------------------------------------------------------------------------------------------------
// Stand-ins: svc-ledger's book, svc-identity's reads, the directory, the freeze.

/// One account's key: owner type, owner id, asset, kind.
type Acct = (String, String, String, String);

#[derive(Default)]
struct BookState {
    balances: BTreeMap<Acct, Amount>,
    /// Every post, in order: its key and the transaction it booked.
    journal: Vec<(String, LedgerTx)>,
    /// Keys starting with this refuse `ledger.frozen`, as a frozen ledger would.
    poison: Option<String>,
    /// The next post books, and its answer is lost (a timeout): the post landed and nobody heard.
    lose_next_answer: bool,
    /// A booked key is not seen yet by a lookup (the post is still landing).
    hidden: bool,
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

fn acct_id(a: &Acct) -> String {
    format!("acct:{}:{}:{}:{}", a.0, a.1, a.2, a.3)
}

fn acct_of(j: &Json) -> Acct {
    let s = |k: &str| match j.get(k) {
        Some(Json::String(v)) => v.clone(),
        other => panic!("{k}: {other:?}"),
    };
    (s("ownerType"), s("ownerId"), s("assetId"), s("kind"))
}

impl Book {
    /// `recipes.deposit`: money in to the person's main balance.
    fn fund(&self, user: &str, asset: &str, amount: &str) {
        let key = (
            "user".to_owned(),
            user.to_owned(),
            asset.to_owned(),
            "available".to_owned(),
        );
        *self.0.lock().unwrap().balances.entry(key).or_default() += amt(amount);
    }
    fn of(&self, owner_type: &str, owner: &str, asset: &str) -> String {
        let key = (
            owner_type.to_owned(),
            owner.to_owned(),
            asset.to_owned(),
            "available".to_owned(),
        );
        format_amount(
            self.0
                .lock()
                .unwrap()
                .balances
                .get(&key)
                .copied()
                .unwrap_or(0),
        )
    }
    /// A person's main balance.
    fn available(&self, user: &str) -> String {
        self.of("user", user, "USDT")
    }
    /// A named space's balance.
    fn pot(&self, space: &str) -> String {
        self.of("subaccount", space, "USDT")
    }
    fn posts(&self) -> usize {
        self.0.lock().unwrap().journal.len()
    }
    fn keys(&self) -> Vec<String> {
        self.0
            .lock()
            .unwrap()
            .journal
            .iter()
            .map(|(k, _)| k.clone())
            .collect()
    }
    fn poison(&self, prefix: &str) {
        self.0.lock().unwrap().poison = Some(prefix.to_owned());
    }
    /// The books close: every asset's balances sum to what was deposited, as no transfer makes or destroys money.
    fn total(&self) -> String {
        format_amount(self.0.lock().unwrap().balances.values().sum())
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
    fn tx_by_id(&self, tx_id: &str) -> Result<Option<LedgerTx>, String> {
        Ok(self
            .0
            .lock()
            .unwrap()
            .journal
            .iter()
            .find(|(_, t)| t.id == tx_id)
            .map(|(_, t)| t.clone()))
    }
    fn tx_by_key(&self, key: &str) -> Result<Option<LedgerTx>, String> {
        if self.0.lock().unwrap().hidden {
            return Ok(None);
        }
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
        assert_eq!(
            recipe, "bankTransfer",
            "the bank posts only bankTransfer here"
        );
        let mut st = self.0.lock().unwrap();
        if st.poison.as_deref().is_some_and(|p| key.starts_with(p)) {
            return Err(PostFailure::Coded {
                code: "ledger.frozen".to_owned(),
                message: "Ledger posting is frozen: isolation residual test".to_owned(),
                attempts: 1,
            });
        }
        if let Some((_, t)) = st.journal.iter().find(|(k, _)| k == key) {
            let t = t.clone();
            if st.lose_next_answer {
                st.lose_next_answer = false;
                return Err(PostFailure::Unknown("timeout".to_owned()));
            }
            return Ok(t);
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
                message: format!(
                    "Insufficient funds: {} < {}",
                    format_amount(held),
                    format_amount(amount)
                ),
                attempts: 1,
            });
        }
        *st.balances.entry(from.clone()).or_default() -= amount;
        *st.balances.entry(to.clone()).or_default() += amount;
        let tx = LedgerTx {
            id: format!("tx-{}", st.journal.len() + 1),
            posted_at: clock(),
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
        st.journal.push((key.to_owned(), tx.clone()));
        if st.lose_next_answer {
            st.lose_next_answer = false;
            return Err(PostFailure::Unknown("timeout".to_owned()));
        }
        Ok(tx)
    }
}

/// svc-identity's reads, shared between the test and the door.
#[derive(Clone, Default)]
struct Identity(Arc<MemoryIdentity>);

impl RecipientState for Identity {
    fn account_of(&self, user_id: &str) -> Result<Option<AccountOf>, RecipientUnavailable> {
        self.0.account_of(user_id)
    }
}
impl SecurityLock for Identity {
    fn read(&self, user_id: &str) -> Result<LockState, svc_bank::errors::Refusal> {
        SecurityLock::read(&*self.0, user_id)
    }
}
impl PartyHandles for Identity {
    fn handle_of(&self, user_id: &str) -> Result<Option<String>, HandleUnavailable> {
        self.0.handle_of(user_id)
    }
}
impl ExtraControls for Identity {
    fn read(&self, user_id: &str) -> Result<Extras, svc_bank::errors::Refusal> {
        ExtraControls::read(&*self.0, user_id)
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

fn amt(s: &str) -> Amount {
    parse_amount(s).unwrap()
}

// ---------------------------------------------------------------------------------------------------------------
// The door and its calls

/// The owner values one test runs under.
#[derive(Clone)]
struct Owner {
    cutoff: Option<&'static str>,
    scheduled: bool,
    batch: Option<i64>,
}

impl Default for Owner {
    fn default() -> Owner {
        Owner {
            cutoff: Some("60"),
            scheduled: true,
            batch: Some(200),
        }
    }
}

struct Bank {
    door: BankDoor,
    db: TestDb,
    ledger: Book,
    identity: Identity,
    owner: Owner,
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

fn spaces_wiring(ledger: &Book) -> SpacesWiring {
    SpacesWiring {
        ledger: Box::new(ledger.clone()),
        directory: Box::new(NoPeople),
        lookups: Lookups::default(),
        rules: Rules {
            space_limit: Some("20".to_owned()),
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

fn transfers_wiring(identity: &Identity, o: &Owner) -> TransfersWiring {
    let mut w = TransfersWiring::none();
    w.recipients = Box::new(identity.clone());
    w.lock = Box::new(identity.clone());
    w.extras = Box::new(identity.clone());
    w.handles = Some(Box::new(identity.clone()));
    w.settings = Settings {
        schedule_edit_cutoff: o.cutoff.map(str::to_owned),
        scheduled_transfers: o.scheduled,
        batch_size: o.batch,
        ..Settings::default()
    };
    w
}

fn door_for(db: &TestDb, ledger: &Book, identity: &Identity, o: &Owner) -> BankDoor {
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
        now: clock,
        store: db.store(),
    })
    .unwrap()
    .with_partner(partner_wiring())
    .with_spaces(spaces_wiring(ledger))
    .with_transfers(transfers_wiring(identity, o))
}

fn bank_with(o: Owner) -> Option<Bank> {
    let db = TestDb::new()?;
    db.migrated();
    let ledger = Book::default();
    let identity = Identity::default();
    identity
        .0
        .set_status(NO_SUCH_USER, RecipientStatus::NotFound);
    let door = door_for(&db, &ledger, &identity, &o);
    Some(Bank {
        door,
        db,
        ledger,
        identity,
        owner: o,
    })
}

fn bank() -> Option<Bank> {
    bank_with(Owner::default())
}

impl Bank {
    /// The same bank under other owner values: one database, one book.
    fn reopened(&self, o: Owner) -> BankDoor {
        door_for(&self.db, &self.ledger, &self.identity, &o)
    }
    fn store(&self) -> Store {
        self.db.store()
    }
    fn sql(&self, q: &str) -> Result<u64, String> {
        self.db.client().execute(q, &[]).map_err(|e| {
            e.as_db_error()
                .and_then(|d| d.constraint().map(str::to_owned))
                .unwrap_or_else(|| e.to_string())
        })
    }
    fn status(&self, schedule: &str) -> String {
        self.db
            .client()
            .query_one(
                "SELECT status::text FROM bank.scheduled_transfers WHERE id = $1::text::uuid",
                &[&schedule],
            )
            .unwrap()
            .get(0)
    }
    fn count(&self, sql: &str) -> i64 {
        self.db.count(sql)
    }
}

fn person(user: &str) -> Vec<(String, String)> {
    let raw = Json::obj([
        ("sub", Json::str(user)),
        (
            "scopes",
            Json::Array(vec![Json::str("bank:read"), Json::str("bank:write")]),
        ),
        ("tier", Json::str("full")),
        ("mfa", Json::Bool(true)),
        ("sid", Json::str("99999999-9999-4999-8999-999999999999")),
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

/// One answer: the status, and the data or the error.
#[derive(Debug, Clone)]
struct Answer(u16, Json);

impl Answer {
    fn ok(&self) -> Json {
        assert_eq!(self.0, 200, "{}", self.1.compact());
        self.1
            .get("result")
            .and_then(|r| r.get("data"))
            .cloned()
            .unwrap_or(Json::Null)
    }
    /// The refusal's own code (`cause.code`), or `ok`.
    fn code(&self) -> String {
        let cause = self
            .1
            .get("error")
            .and_then(|e| e.get("data"))
            .and_then(|d| d.get("cause"))
            .and_then(|c| c.get("code"));
        match (self.0, cause) {
            (200, _) => "ok".to_owned(),
            (_, Some(Json::String(c))) => c.clone(),
            (status, _) => panic!("no refusal code: {status} {}", self.1.compact()),
        }
    }
    /// tRPC's code (`FORBIDDEN`, `BAD_REQUEST`, ...).
    fn trpc(&self) -> String {
        match self
            .1
            .get("error")
            .and_then(|e| e.get("data"))
            .and_then(|d| d.get("code"))
        {
            Some(Json::String(c)) => c.clone(),
            _ => "ok".to_owned(),
        }
    }
    fn message(&self) -> String {
        match self.1.get("error").and_then(|e| e.get("message")) {
            Some(Json::String(m)) => m.clone(),
            _ => String::new(),
        }
    }
    /// Everything a client can see of a refusal but the request's own reference: the status, the codes, the words.
    fn wire_shape(&self) -> String {
        format!(
            "{} {} {} {}",
            self.0,
            self.trpc(),
            self.1
                .get("error")
                .and_then(|e| e.get("data"))
                .and_then(|d| d.get("cause"))
                .map_or("none".to_owned(), Json::compact),
            self.message()
        )
    }
}

fn send(
    door: &BankDoor,
    path: &str,
    input: Option<&str>,
    mut headers: Vec<(String, String)>,
) -> Answer {
    let kind = door::call(path).map(|c| c.kind);
    let (method, url, body) = match kind {
        Some(Kind::Query) => (
            "GET",
            match input {
                Some(i) => format!("/trpc/{path}?input={}", encode(i)),
                None => format!("/trpc/{path}"),
            },
            String::new(),
        ),
        _ => (
            "POST",
            format!("/trpc/{path}"),
            input.unwrap_or("").to_owned(),
        ),
    };
    if !body.is_empty() {
        headers.push(("content-type".to_owned(), "application/json".to_owned()));
    }
    let res = door.handle_from(
        &Request {
            method,
            url: &url,
            headers: &headers,
            body: &body,
        },
        "req-transfers-db",
        "127.0.0.1",
    );
    Answer(res.status, json::parse(&res.body).unwrap())
}

/// A call as the person.
fn call(b: &Bank, user: &str, path: &str, input: &str) -> Answer {
    call_on(&b.door, user, path, input)
}

fn call_on(door: &BankDoor, user: &str, path: &str, input: &str) -> Answer {
    send(
        door,
        path,
        (!input.is_empty()).then_some(input),
        person(user),
    )
}

fn signed(service: &str, body: &str) -> Vec<(String, String)> {
    s2s::legacy_headers(service, INTERNAL, body, clock().0.div_euclid(1000)).unwrap()
}

fn text(j: &Json, key: &str) -> String {
    match j.get(key) {
        Some(Json::String(s)) => s.clone(),
        Some(Json::Null) | None => "null".to_owned(),
        Some(other) => other.compact(),
    }
}

/// `spaces.ensurePrimary`.
fn primary(b: &Bank, user: &str, asset: &str) -> String {
    space::with(&b.store(), |c| space::ensure_primary(c, user, asset))
        .unwrap()
        .id
}

// ---------------------------------------------------------------------------------------------------------------
// The withdrawal

/// The bank as `beforeEach` sets it up: Ada holds 100 USDT, both handles are known, the USDT terms are 50 a send and
/// 1000 a day with no fee, and the security lock reads open.
fn withdrawals() -> Option<Bank> {
    let b = bank()?;
    b.ledger.fund(ADA, "USDT", "100");
    b.identity.0.set_handle(ADA, "ada");
    b.identity.0.set_handle(BOB, "bob");
    b.sql(
        "INSERT INTO bank.personal_transfer_terms (asset_id, per_transfer_limit, daily_limit, fee) \
         VALUES ('USDT', 50, 1000, 0)",
    )
    .unwrap();
    Some(b)
}

fn key_of(withdrawal: &str) -> String {
    format!("withdraw:{withdrawal}")
}

/// `settleWithdrawal` on the service, under the given wiring.
fn settle_on(
    b: &Bank,
    w: &TransfersWiring,
    withdrawal: &str,
    amount: &str,
) -> Result<Json, Refusal> {
    let partner = partner_wiring();
    let spaces = spaces_wiring(&b.ledger);
    let store = b.store();
    let custody = partner.custody(&store);
    let d = transfers::Deps {
        store: &store,
        ledger: &b.ledger,
        custody: &custody,
        partner: &partner,
        spaces: &spaces,
        w,
        now: clock(),
    };
    let id = key_of(withdrawal);
    personal::settle_withdrawal(
        &d,
        &Withdrawal {
            transfer_id: &id,
            from_user_id: ADA,
            to_user_id: BOB,
            asset_id: "USDT",
            amount: amt(amount),
        },
    )
}

/// `settleWithdrawal` on the bank's own wiring.
fn settle(b: &Bank, withdrawal: &str, amount: &str) -> Result<Json, Refusal> {
    settle_on(
        b,
        &transfers_wiring(&b.identity, &b.owner),
        withdrawal,
        amount,
    )
}

/// A thrown refusal's code.
fn code(r: &Refusal) -> String {
    match r {
        Refusal::Bank(e) => e.row.code.to_owned(),
        Refusal::Trpc(e) => e.cause.clone().unwrap_or_else(|| e.code.to_owned()),
        Refusal::Other(m) => format!("other: {m}"),
    }
}

fn refused(code: &str) -> Json {
    Json::obj([("state", Json::str("refused")), ("code", Json::str(code))])
}

/// The withdrawals' sends on the book.
fn sends(b: &Bank) -> Vec<String> {
    b.ledger
        .keys()
        .into_iter()
        .filter(|k| k.starts_with("bank.transfer.p2p:withdraw:"))
        .collect()
}

fn tx_of(b: &Bank, key: &str) -> String {
    b.ledger.tx_by_key(key).unwrap().unwrap().id
}

#[test]
fn moves_the_amount_from_the_main_account_to_the_receiver_once_and_the_receiver_sees_who_sent_it() {
    let Some(b) = withdrawals() else { return };
    // Ada has a balance and no main-account row yet: the row is made, the money comes from her own ledger account.
    let first = settle(&b, W1, "20").unwrap();
    assert_eq!(text(&first, "state"), "posted");
    assert_eq!(text(&first, "transferId"), key_of(W1));
    let again = settle(&b, W1, "20").unwrap();
    assert_eq!(again, first);
    assert_eq!(sends(&b).len(), 1);
    assert_eq!(b.ledger.available(ADA), "80");
    assert_eq!(b.ledger.available(BOB), "20");
    let row = b
        .db
        .client()
        .query_one(
            "SELECT status, from_handle, to_handle FROM bank.personal_transfers WHERE transfer_id = $1",
            &[&key_of(W1)],
        )
        .unwrap();
    let got: (String, String, String) = (row.get(0), row.get(1), row.get(2));
    assert_eq!(
        got,
        ("posted".to_owned(), "ada".to_owned(), "bob".to_owned())
    );
}

#[test]
fn refuses_a_frozen_receiver_before_anything_is_reserved_or_posted() {
    let Some(b) = withdrawals() else { return };
    b.identity.0.set_status(BOB, RecipientStatus::Frozen);
    assert_eq!(
        settle(&b, W1, "20").unwrap(),
        refused("bank.recipient_cannot_receive")
    );
    assert!(sends(&b).is_empty());
    assert_eq!(b.count("SELECT count(*) FROM bank.personal_transfers"), 0);
    assert_eq!(b.ledger.available(ADA), "100");
}

#[test]
fn refuses_a_frozen_sender_before_anything_is_reserved_or_posted() {
    let Some(b) = withdrawals() else { return };
    b.identity.0.set_status(ADA, RecipientStatus::Frozen);
    assert_eq!(
        settle(&b, W1, "20").unwrap(),
        refused("bank.sender_cannot_send")
    );
    assert!(sends(&b).is_empty());
    assert_eq!(b.count("SELECT count(*) FROM bank.personal_transfers"), 0);
    assert_eq!(
        b.count(&format!(
            "SELECT count(*) FROM bank.spaces WHERE user_id = '{ADA}'"
        )),
        0
    );
}

#[test]
fn a_refusal_while_an_earlier_ask_under_the_key_may_still_post_is_not_a_refusal_it_throws_and_after_the_bound_it_is()
 {
    let Some(b) = withdrawals() else { return };
    let start = at("2026-10-24T12:00:00.000Z");
    let from = primary(&b, ADA, "USDT");
    // An earlier ask reserved the send and its post never answered.
    let earlier = format!(
        "INSERT INTO bank.personal_transfers (transfer_id, from_user_id, from_space_id, to_user_id, asset_id, amount, \
         status, created_at) VALUES ('{}', '{ADA}', '{from}', '{BOB}', 'USDT', 20, 'reserved', \
         '2026-10-24T12:00:00.000Z') ON CONFLICT DO NOTHING",
        key_of(W1)
    );
    b.sql(&earlier).unwrap();
    b.identity.0.set_status(BOB, RecipientStatus::Frozen);
    set_now(start + 60_000);
    let thrown = settle(&b, W1, "20").unwrap_err();
    assert_eq!(code(&thrown), "bank.recipient_cannot_receive");
    assert!(sends(&b).is_empty());
    // The send's refusal path dropped the reservation, so recreate it as the earlier ask left it, past the bound.
    b.sql(&earlier).unwrap();
    set_now(start + 8 * 60_000);
    assert_eq!(
        settle(&b, W1, "20").unwrap(),
        refused("bank.recipient_cannot_receive")
    );
    set_now(0);
}

#[test]
fn a_key_already_filed_for_a_different_send_is_never_a_refusal() {
    let Some(b) = withdrawals() else { return };
    settle(&b, W1, "20").unwrap();
    let thrown = settle(&b, W1, "25").unwrap_err();
    assert_eq!(code(&thrown), "bank.personal_transfer_conflict");
    assert_eq!(sends(&b).len(), 1);
}

#[test]
fn refuses_while_the_sender_security_lock_holds_before_anything_is_written_a_send_that_posted_before_answers_as_it_did()
 {
    let Some(b) = withdrawals() else { return };
    let first = settle(&b, W1, "20").unwrap();
    b.identity.0.set_lock(
        ADA,
        LockState {
            locked: true,
            unlocks_at: None,
            self_frozen: false,
        },
    );
    assert_eq!(settle(&b, W1, "20").unwrap(), first);
    assert_eq!(
        settle(&b, W2, "10").unwrap(),
        refused("bank.security_locked")
    );
    assert_eq!(sends(&b).len(), 1);
    assert_eq!(
        b.count(&format!(
            "SELECT count(*) FROM bank.personal_transfers WHERE transfer_id = '{}'",
            key_of(W2)
        )),
        0
    );
}

#[test]
fn with_no_security_lock_wired_every_withdrawal_is_refused_never_no_lock() {
    let Some(b) = withdrawals() else { return };
    let mut unwired = transfers_wiring(&b.identity, &b.owner);
    unwired.lock = Box::new(NoIdentity);
    assert_eq!(
        settle_on(&b, &unwired, W1, "20").unwrap(),
        refused("bank.security_lock_unset")
    );
    assert!(sends(&b).is_empty());
}

#[test]
fn keeps_the_person_to_person_limits_above_the_per_transfer_limit_is_refused_and_nothing_posts() {
    let Some(b) = withdrawals() else { return };
    assert_eq!(
        settle(&b, W1, "60").unwrap(),
        refused("bank.personal_transfer_limit_exceeded")
    );
    assert!(sends(&b).is_empty());
}

#[test]
fn refuses_more_than_the_sender_holds_and_posts_nothing() {
    let Some(b) = withdrawals() else { return };
    b.sql("UPDATE bank.personal_transfer_terms SET per_transfer_limit = 1000")
        .unwrap();
    assert_eq!(
        settle(&b, W1, "150").unwrap(),
        refused("ledger.insufficient_funds")
    );
    assert!(sends(&b).is_empty());
    assert_eq!(b.ledger.available(ADA), "100");
    // Nothing was kept, so the same key can still post once the money is there.
    assert_eq!(text(&settle(&b, W1, "50").unwrap(), "state"), "posted");
}

#[test]
fn a_lost_answer_throws_never_a_refusal_and_the_retry_with_the_same_key_posts_once() {
    let Some(b) = withdrawals() else { return };
    {
        let mut st = b.ledger.0.lock().unwrap();
        st.lose_next_answer = true;
        // Before the send, and in the first read-back after the lost answer, the post is not seen yet (it is still
        // landing).
        st.hidden = true;
    }
    let thrown = settle(&b, W2, "30").unwrap_err();
    assert_eq!(code(&thrown), "other: svc-ledger post failed: timeout");
    assert_eq!(sends(&b).len(), 1);
    b.ledger.0.lock().unwrap().hidden = false;
    let again = settle(&b, W2, "30").unwrap();
    let key = format!("bank.transfer.p2p:{}:0", key_of(W2));
    assert_eq!(
        again,
        Json::obj([
            ("state", Json::str("posted")),
            ("transferId", Json::str(key_of(W2))),
            ("ledgerTxId", Json::str(tx_of(&b, &key))),
        ])
    );
    assert_eq!(sends(&b).len(), 1);
    assert_eq!(b.ledger.available(BOB), "30");
}

#[test]
fn a_refusal_whose_key_already_holds_this_very_send_answers_that_send_never_refused() {
    let Some(b) = withdrawals() else { return };
    let first = settle(&b, W1, "20").unwrap();
    b.sql("DELETE FROM bank.personal_transfers").unwrap();
    // The move is now refused, and the refusal proves nothing was booked by it (a frozen ledger on the only attempt).
    b.ledger.poison("bank.transfer.p2p:withdraw:");
    assert_eq!(settle(&b, W1, "20").unwrap(), first);
    assert_eq!(sends(&b).len(), 1);
}

#[test]
fn serves_svc_pay_only_another_service_is_forbidden_and_no_service_is_unauthorized() {
    let Some(b) = withdrawals() else { return };
    let body = format!(
        r#"{{"transferId":"{}","fromUserId":"{ADA}","toUserId":"{BOB}","assetId":"USDT","amount":"20"}}"#,
        key_of(W1)
    );
    let as_service = |service: Option<&str>| {
        send(
            &b.door,
            "transfers.settleWithdrawal",
            Some(&body),
            service.map_or_else(Vec::new, |s| signed(s, &body)),
        )
    };
    assert_eq!(as_service(Some("svc-trade")).trpc(), "FORBIDDEN");
    assert_eq!(as_service(None).trpc(), "UNAUTHORIZED");
    assert!(sends(&b).is_empty());
    let posted = as_service(Some("svc-pay")).ok();
    assert_eq!(text(&posted, "state"), "posted");
    assert_eq!(text(&posted, "transferId"), key_of(W1));
    assert_eq!(b.ledger.available(BOB), "20");
}

#[test]
fn invariant_every_posted_send_is_one_ledger_transaction_under_its_key_and_the_books_still_balance()
{
    let Some(b) = withdrawals() else { return };
    settle(&b, W1, "20").unwrap();
    settle(&b, W1, "20").unwrap();
    settle(&b, W2, "10").unwrap();
    let rows = b
        .db
        .client()
        .query(
            "SELECT transfer_id, ledger_tx_id FROM bank.personal_transfers WHERE status = 'posted' ORDER BY transfer_id",
            &[],
        )
        .unwrap();
    assert_eq!(rows.len(), 2);
    for r in &rows {
        let id: String = r.get(0);
        let tx: String = r.get(1);
        assert_eq!(tx_of(&b, &format!("bank.transfer.p2p:{id}:0")), tx);
    }
    assert_eq!(
        amt(&b.ledger.available(ADA)) + amt(&b.ledger.available(BOB)),
        amt("100")
    );
}

// ---------------------------------------------------------------------------------------------------------------
// transfer-message.db.test.ts

/// `transfers.toUser with a note writes no bank.transfer_messages row`. Its last two checks read the note back from each
/// party's `activity.list`, slice `activity`'s call, which the Rust door does not serve yet: they move with that slice.
#[test]
fn transfers_to_user_with_a_note_writes_no_bank_transfer_messages_row() {
    let Some(b) = bank() else { return };
    b.ledger.fund(ADA, "USDT", "100");
    let from = primary(&b, ADA, "USDT");
    primary(&b, BOB, "USDT");
    primary(&b, CARA, "USDT");
    b.sql(
        "INSERT INTO bank.personal_transfer_terms (asset_id, per_transfer_limit, daily_limit, fee) \
         VALUES ('USDT', 1000, 10000, 0) ON CONFLICT DO NOTHING",
    )
    .unwrap();
    let sent = call(
        &b,
        ADA,
        "transfers.toUser",
        &format!(
            r#"{{"transferId":"touser-note-01","fromSpaceId":"{from}","toUserId":"{BOB}","amount":"4","note":"personal hello","reference":"INV-1"}}"#
        ),
    )
    .ok();
    assert_eq!(text(&sent, "note"), "personal hello");
    assert_eq!(text(&sent, "reference"), "INV-1");
    assert_eq!(b.count("SELECT count(*) FROM bank.transfer_messages"), 0);
    let rows = b
        .db
        .client()
        .query(
            "SELECT note, reference FROM bank.personal_transfers WHERE transfer_id = 'touser-note-01'",
            &[],
        )
        .unwrap();
    let stored: Vec<(Option<String>, Option<String>)> =
        rows.iter().map(|r| (r.get(0), r.get(1))).collect();
    assert_eq!(
        stored,
        vec![(Some("personal hello".to_owned()), Some("INV-1".to_owned()))]
    );
}
