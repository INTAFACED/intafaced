//! Part `sorter` of slice `automations` against the Rust door on a real Postgres. Ports the checks of the TypeScript's
//! `sorter/income-sorter.db.test.ts`, each test named after the TypeScript test's words. A call through the router is a
//! door call here (`sorter.*`, `transfers.toUser`, `transfers.create`); `bank.sorter.sweep(limit, now)` is the Rust
//! function it became (`sorter::Sorter::sweep`), given the dependencies the door gives it. Bob's payments to Ada go
//! through the door's own send, so every test also holds the hand-off from a posted send to the recipient's sorter
//! (`onCreditPosted`), which the transfers port left to this slice. Two more check the job door
//! `POST /internal/jobs/run-income-sorter`, which the TypeScript suite does not reach.
//!
//! The ledger is a stand-in that books `bankTransfer` as svc-ledger does (once per key) and refuses too little money
//! with a single attempt stamped, as the TypeScript's proxy stamps it. For a sorter split (a key holding `:sorter:`) it
//! can lose the reply after booking, drop the post before the book (`socket hang up`), or fail it on its one attempt
//! with a given failure (`ledger.frozen`, or unreachable), as the TypeScript's flaky proxy does.
//!
//! Left: "a hanging ledger never holds the payer: the send answers within its bound". The TypeScript bounds the
//! hand-off with a 5 s timeout and lets the hung promise run on; the Rust door is synchronous and a call cannot be
//! abandoned mid-flight, so the hand-off waits as long as the ledger post's own budget (`POST_BUDGET`: 10 s an attempt,
//! two retries, 25 s in all) and no test makes a post hang.
//!
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
use service_kit::time::Instant;
use svc_bank::automations::{self, sorter};
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
use svc_bank::transfers::ports::{
    AccountOf, ExtraControls, Extras, HandleUnavailable, LockState, MemoryIdentity, PartyHandles,
    RecipientState, RecipientUnavailable, SecurityLock,
};
use svc_bank::transfers::{self, Settings, Wiring as TransfersWiring};

use support::TestDb;

const SECRET: &str = "a-bank-sorter-db-edge-secret-long-enough";
const INTERNAL: &str = "a-bank-sorter-db-internal-secret-long-enough";
const ADA: &str = "11111111-1111-4111-8111-111111111111";
const BOB: &str = "22222222-2222-4222-8222-222222222222";

fn amt(s: &str) -> Amount {
    parse_amount(s).unwrap()
}

// ---------------------------------------------------------------------------------------------------------------
// Stand-ins

type Acct = (String, String, String, String);

#[derive(Default)]
struct BookState {
    balances: BTreeMap<Acct, Amount>,
    journal: Vec<(String, LedgerTx)>,
    /// `loseSorterReplies`: a sorter split is booked and its answer lost.
    lose: bool,
    /// `dropSorterPosts`, `failSorterPosts`: a sorter split fails with this, and nothing reaches the book.
    fail: Option<PostFailure>,
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

fn sorter_key(key: &str) -> bool {
    key.contains(":sorter:")
}

impl Book {
    fn fund(&self, user: &str, amount: &str) {
        let key = (
            "user".to_owned(),
            user.to_owned(),
            "USDT".to_owned(),
            "available".to_owned(),
        );
        *self.0.lock().unwrap().balances.entry(key).or_default() += amt(amount);
    }
    fn of(&self, a: &LedgerAccount) -> String {
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
    /// `balanceOf(spaceId)`.
    fn pot(&self, space: &str) -> String {
        self.of(&LedgerAccount::sub_account_available(space, "USDT"))
    }
    /// `mainOf(userId)`.
    fn main(&self, user: &str) -> String {
        self.of(&LedgerAccount::user_available(user, "USDT"))
    }
    /// `sorterMoves()`.
    fn sorter_moves(&self) -> usize {
        self.0
            .lock()
            .unwrap()
            .journal
            .iter()
            .filter(|(k, _)| sorter_key(k))
            .count()
    }
    fn lose(&self, on: bool) {
        self.0.lock().unwrap().lose = on;
    }
    fn fail(&self, f: Option<PostFailure>) {
        self.0.lock().unwrap().fail = f;
    }
    fn book(&self, key: &str, from: &LedgerAccount, to: &LedgerAccount, amount: &str) {
        let input = Json::obj([
            ("from", from.json()),
            ("to", to.json()),
            ("amount", Json::str(amount)),
        ]);
        // The test's own `ledger.post(...)`: past the flaky proxy.
        let (lose, fail) = {
            let mut st = self.0.lock().unwrap();
            (std::mem::take(&mut st.lose), st.fail.take())
        };
        self.post_recipe("bankTransfer", &input, key).unwrap();
        let mut st = self.0.lock().unwrap();
        st.lose = lose;
        st.fail = fail;
    }
}

fn socket_hang_up() -> PostFailure {
    PostFailure::Unknown("socket hang up".to_owned())
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
        if sorter_key(key)
            && let Some(f) = st.fail.clone()
        {
            return Err(f);
        }
        if let Some((_, t)) = st.journal.iter().find(|(k, _)| k == key) {
            return Ok(t.clone());
        }
        let from = acct_of(input.get("from").unwrap());
        let to = acct_of(input.get("to").unwrap());
        let amount = match input.get("amount") {
            Some(Json::String(a)) => amt(a),
            other => panic!("amount: {other:?}"),
        };
        let held = st.balances.get(&from).copied().unwrap_or(0);
        if held < amount {
            // As the shared HTTP client does: one attempt, its count stamped on the error it gives up with.
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
            key: key.to_owned(),
            id: format!("tx-{}", st.journal.len() + 1),
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
        st.journal.push((key.to_owned(), tx.clone()));
        if st.lose && sorter_key(key) {
            return Err(socket_hang_up());
        }
        Ok(tx)
    }
}

#[derive(Clone, Default)]
struct Identity(Arc<MemoryIdentity>);

impl RecipientState for Identity {
    fn account_of(&self, user_id: &str) -> Result<Option<AccountOf>, RecipientUnavailable> {
        self.0.account_of(user_id)
    }
}
impl SecurityLock for Identity {
    fn read(&self, user_id: &str) -> Result<LockState, Refusal> {
        SecurityLock::read(&*self.0, user_id)
    }
}
impl PartyHandles for Identity {
    fn handle_of(&self, user_id: &str) -> Result<Option<String>, HandleUnavailable> {
        self.0.handle_of(user_id)
    }
}
impl ExtraControls for Identity {
    fn read(&self, user_id: &str) -> Result<Extras, Refusal> {
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

fn partner_wiring() -> PartnerWiring {
    PartnerWiring {
        partner: Some(TestPartner::new().unwrap()),
        freeze: Box::new(Open),
        custody_layer: "off".to_owned(),
        cash_legs: None,
        pay_in: None,
    }
}

/// `spaceLimit: '5'`.
fn rules_() -> Rules {
    Rules {
        space_limit: Some("5".to_owned()),
        unlock_wait_hours: None,
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

/// The transfers slice handed the sorter (`onCreditPosted: (credit) => made.sorter.sortCredit(credit)`).
fn transfers_wiring(identity: &Identity, min: Option<&str>) -> TransfersWiring {
    let mut w = TransfersWiring::none();
    w.recipients = Box::new(identity.clone());
    w.lock = Box::new(identity.clone());
    w.extras = Box::new(identity.clone());
    w.handles = Some(Box::new(identity.clone()));
    w.settings = Settings {
        producer: "svc-bank".to_owned(),
        ..Settings::default()
    };
    w.credit_posted = Some(Box::new(sorter_wiring(min).hand_off()));
    w
}

fn sorter_wiring(min: Option<&str>) -> sorter::Wiring {
    sorter::Wiring {
        min_credit: min.map(str::to_owned),
    }
}

fn door_for(db: &TestDb, b: &Book, identity: &Identity, min: Option<&str>) -> BankDoor {
    let env: BTreeMap<String, String> = [("APP_ENV", "test"), ("NODE_ENV", "test")]
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect();
    let mut auto = automations::Wiring::none();
    auto.sorter = sorter_wiring(min);
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
    .with_transfers(transfers_wiring(identity, min))
    .with_automations(auto)
}

struct Bank {
    db: TestDb,
    store: Store,
    door: BankDoor,
    ledger: Book,
    identity: Identity,
    /// `options.incomeSorterMinCredit`.
    min: Option<&'static str>,
}

fn bank() -> Option<Bank> {
    let db = TestDb::new()?;
    db.migrated();
    db.client()
        .batch_execute(
            "INSERT INTO bank.personal_transfer_terms (asset_id, per_transfer_limit, daily_limit, fee) \
             VALUES ('USDT', 1000, 10000, 0)",
        )
        .unwrap();
    let ledger = Book::default();
    let identity = Identity::default();
    // `memoryPartyHandles({ [ADA]: 'ada', [BOB]: 'bob' })`.
    identity.0.set_handle(ADA, "ada");
    identity.0.set_handle(BOB, "bob");
    let min = Some("1");
    let door = door_for(&db, &ledger, &identity, min);
    let store = db.store();
    Some(Bank {
        db,
        store,
        door,
        ledger,
        identity,
        min,
    })
}

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
    /// `rejects.toMatchObject({ cause: { code } })`.
    fn refused(&self, code: &str) {
        let cause = self
            .1
            .get("error")
            .and_then(|e| e.get("data"))
            .and_then(|d| d.get("cause"))
            .and_then(|c| c.get("code"));
        assert_eq!(cause, Some(&Json::str(code)), "{}", self.1.compact());
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

fn send(
    door: &BankDoor,
    url: &str,
    method: &str,
    body: &str,
    mut headers: Vec<(String, String)>,
) -> Answer {
    headers.push(("content-type".to_owned(), "application/json".to_owned()));
    let res = door.handle_from(
        &Request {
            method,
            url,
            headers: &headers,
            body,
        },
        "req-sorter-db",
        "127.0.0.1",
    );
    Answer(res.status, json::parse(&res.body).unwrap())
}

fn s(j: &Json, k: &str) -> String {
    match j.get(k) {
        Some(Json::String(v)) => v.clone(),
        Some(Json::Null) | None => "null".to_owned(),
        Some(other) => other.compact(),
    }
}

fn arr(j: &Json) -> Vec<Json> {
    match j {
        Json::Array(a) => a.clone(),
        other => panic!("not a list: {}", other.compact()),
    }
}

fn uuid() -> String {
    random_uuid().unwrap()
}

/// A moment past the sweep's one-minute hands-off window.
fn later() -> Instant {
    Instant(door::system_now().0 + 120_000)
}

impl Bank {
    /// `caller(user).<path>(input)`.
    fn call(&self, user: &str, path: &str, input: &str) -> Answer {
        match door::call(path).map(|c| c.kind) {
            Some(Kind::Query) if input.is_empty() => send(
                &self.door,
                &format!("/trpc/{path}"),
                "GET",
                "",
                person(user),
            ),
            Some(Kind::Query) => send(
                &self.door,
                &format!("/trpc/{path}?input={}", encode(input)),
                "GET",
                "",
                person(user),
            ),
            _ => send(
                &self.door,
                &format!("/trpc/{path}"),
                "POST",
                input,
                person(user),
            ),
        }
    }
    /// `options.incomeSorterMinCredit = min`: the door, the send's hand-off and the sweep read it from here on.
    fn set_min(&mut self, min: Option<&'static str>) {
        self.min = min;
        self.door = door_for(&self.db, &self.ledger, &self.identity, min);
    }
    fn sql(&self, q: &str) {
        self.db.client().batch_execute(q).unwrap();
    }
    /// `bank.sorter.sweep(10, now)`.
    fn sweep(&self, now: Instant) -> (i64, i64, i64) {
        let partner = partner_wiring();
        let spaces = spaces_wiring(&self.ledger);
        let w = transfers_wiring(&self.identity, self.min);
        let custody = partner.custody(&self.store);
        let t = transfers::Deps {
            store: &self.store,
            ledger: &self.ledger,
            custody: &custody,
            partner: &partner,
            spaces: &spaces,
            w: &w,
            now: door::system_now(),
        };
        let r = sorter::Sorter {
            t: &t,
            min_credit: self.min,
        }
        .sweep(10, now)
        .unwrap();
        (r.credits_recorded, r.runs_driven, r.legs_still_pending)
    }
    fn primary(&self, user: &str) -> space::Space {
        space::with(&self.store, |c| space::ensure_primary(c, user, "USDT")).unwrap()
    }
    /// `bank.spaces.create({ userId, assetId, name, lockedUntil: null })`.
    fn pot(&self, name: &str, user: &str, asset: &str) -> space::Space {
        space::create_within_limit(
            &self.store,
            &rules_(),
            &NewSpace {
                user_id: user,
                asset_id: asset,
                name,
                goal_target: None,
                locked_until: None,
            },
        )
        .unwrap()
    }
    fn archive(&self, space_id: &str) {
        space::archive(&self.store, space_id).unwrap();
    }
    /// `bobPays(amount, transferId)`: Bob pays Ada from his account, as the customer door does.
    fn bob_pays_as(&self, amount: &str, transfer_id: &str) -> Json {
        let from = self.primary(BOB);
        self.ledger.fund(BOB, amount);
        self.primary(ADA);
        self.call(
            BOB,
            "transfers.toUser",
            &format!(
                r#"{{"transferId":"{transfer_id}","fromSpaceId":"{}","toUserId":"{ADA}","amount":"{amount}"}}"#,
                from.id
            ),
        )
        .ok()
    }
    fn bob_pays(&self, amount: &str) -> Json {
        self.bob_pays_as(amount, &format!("pay-{}", uuid()))
    }
    /// A move between two of Ada's own spaces (`transfers.create`).
    fn own_move(&self, from: &str, to: &str, amount: &str) {
        self.call(
            ADA,
            "transfers.create",
            &format!(
                r#"{{"transferId":"own-{}","fromSpaceId":"{from}","toSpaceId":"{to}","amount":"{amount}"}}"#,
                uuid()
            ),
        )
        .ok();
    }
    fn make(&self, sorter_id: &str, legs: &[(&str, i64)]) -> Answer {
        let legs: Vec<String> = legs
            .iter()
            .map(|(space, bp)| format!(r#"{{"spaceId":"{space}","shareBp":{bp}}}"#))
            .collect();
        self.call(
            ADA,
            "sorter.create",
            &format!(
                r#"{{"sorterId":"{sorter_id}","assetId":"USDT","legs":[{}]}}"#,
                legs.join(",")
            ),
        )
    }
    /// `sixtyForty()`: TEST bills 60%, TEST savings 40%.
    fn sixty_forty(&self) -> (space::Space, space::Space, String) {
        let bills = self.pot("TEST bills", ADA, "USDT");
        let savings = self.pot("TEST savings", ADA, "USDT");
        let made = self
            .make(&uuid(), &[(&bills.id, 6000), (&savings.id, 4000)])
            .ok();
        (bills, savings, s(&made, "id"))
    }
    fn runs(&self, user: &str, sorter_id: &str) -> Answer {
        self.call(
            user,
            "sorter.runs",
            &format!(r#"{{"sorterId":"{sorter_id}","limit":10}}"#),
        )
    }
    /// The first run's legs, `(status, rejectionCode)` each.
    fn legs(&self, sorter_id: &str) -> Vec<(String, String)> {
        let runs = arr(&self.runs(ADA, sorter_id).ok());
        arr(runs[0].get("legs").unwrap())
            .iter()
            .map(|l| (s(l, "status"), s(l, "rejectionCode")))
            .collect()
    }
    fn list(&self, user: &str) -> Json {
        self.call(user, "sorter.list", "").ok()
    }
    /// `backdate(sorterId)`: the sorter as if made before every payment so far.
    fn backdate(&self, sorter_id: &str) {
        self.sql(&format!(
            "UPDATE bank.income_sorters SET created_at = created_at - interval '1 hour' WHERE id = '{sorter_id}'"
        ));
    }
    /// Every split's attempt eight minutes older: past the post in-flight bound.
    fn age_attempts(&self) {
        self.sql("UPDATE bank.income_sorter_run_legs SET attempted_at = attempted_at - interval '8 minutes'");
    }
}

fn settled() -> (String, String) {
    ("settled".to_owned(), "null".to_owned())
}
fn pending() -> (String, String) {
    ("pending".to_owned(), "null".to_owned())
}
fn rejected(code: &str) -> (String, String) {
    ("rejected".to_owned(), code.to_owned())
}

// ---------------------------------------------------------------------------------------------------------------

#[test]
fn says_when_the_owner_has_published_no_terms_and_then_makes_no_sorter_and_sorts_nothing() {
    let Some(mut b) = bank() else { return };
    b.set_min(None);
    let bills = b.pot("TEST bills", ADA, "USDT");
    assert_eq!(
        b.list(ADA).compact(),
        r#"{"terms":{"state":"not_set","code":"bank.sorter_terms_unset"},"sorters":[]}"#
    );
    b.make(&uuid(), &[(&bills.id, 5000)])
        .refused("bank.sorter_terms_unset");
    b.bob_pays("100");
    assert_eq!(b.ledger.sorter_moves(), 0);
    assert_eq!(b.ledger.main(ADA), "100");
}

#[test]
fn refuses_a_sorter_over_100_and_every_target_that_is_not_the_persons_own_live_named_space() {
    let Some(b) = bank() else { return };
    let bills = b.pot("TEST bills", ADA, "USDT");
    let savings = b.pot("TEST savings", ADA, "USDT");
    let main = b.primary(ADA);
    let bobs = b.pot("TEST bob", BOB, "USDT");
    let old = b.pot("TEST old", ADA, "USDT");
    b.archive(&old.id);
    let eurc = b.pot("TEST eurc", ADA, "EURC");

    b.make(&uuid(), &[(&bills.id, 6000), (&savings.id, 4001)])
        .refused("bank.sorter_invalid");
    b.make(&uuid(), &[(&bills.id, 0)])
        .refused("bank.sorter_invalid");
    b.make(&uuid(), &[(&bills.id, 10001)])
        .refused("bank.sorter_invalid");
    b.make(&uuid(), &[(&bills.id, 10), (&bills.id, 10)])
        .refused("bank.sorter_invalid");
    b.make(&uuid(), &[(&main.id, 5000)])
        .refused("bank.sorter_invalid");
    b.make(&uuid(), &[(&bobs.id, 5000)])
        .refused("bank.space_not_found");
    b.make(&uuid(), &[(&old.id, 5000)])
        .refused("bank.space_archived");
    b.make(&uuid(), &[(&eurc.id, 5000)])
        .refused("bank.asset_mismatch");
    assert_eq!(b.list(ADA).get("sorters"), Some(&Json::Array(vec![])));

    // Exactly 100% is a sorter; the same id sent again is the same sorter; a second live one for the asset is refused.
    let id = uuid();
    let legs = [(bills.id.as_str(), 6000), (savings.id.as_str(), 4000)];
    let made = b.make(&id, &legs).ok();
    assert_eq!(s(&made, "id"), id);
    assert_eq!(s(&made, "assetId"), "USDT");
    assert_eq!(s(&made, "status"), "active");
    assert_eq!(
        made.get("legs").unwrap().compact(),
        format!(
            r#"[{{"spaceId":"{}","shareBp":6000}},{{"spaceId":"{}","shareBp":4000}}]"#,
            bills.id, savings.id
        )
    );
    assert_eq!(b.make(&id, &legs).ok(), made);
    b.make(&id, &[(&bills.id, 5000)])
        .refused("bank.sorter_conflict");
    b.make(&uuid(), &[(&bills.id, 5000)])
        .refused("bank.sorter_exists");
    let listed = arr(b.list(ADA).get("sorters").unwrap());
    assert_eq!(listed.len(), 1);
    assert_eq!(
        listed[0].compact(),
        format!(
            r#"{{"id":"{id}","assetId":"USDT","status":"active","legs":[{{"spaceId":"{}","shareBp":6000,"spaceName":"TEST bills","archived":false}},{{"spaceId":"{}","shareBp":4000,"spaceName":"TEST savings","archived":false}}],"createdAt":"{}","cancelledAt":null}}"#,
            bills.id,
            savings.id,
            s(&made, "createdAt")
        )
    );
    assert_eq!(b.list(BOB).get("sorters"), Some(&Json::Array(vec![])));
    b.call(BOB, "sorter.cancel", &format!(r#"{{"sorterId":"{id}"}}"#))
        .refused("bank.sorter_not_found");
    b.runs(BOB, &id).refused("bank.sorter_not_found");
}

#[test]
fn splits_a_test_100_payment_60_and_40_once_however_often_the_send_or_the_sweep_runs() {
    let Some(b) = bank() else { return };
    let (bills, savings, sorter_id) = b.sixty_forty();
    let transfer_id = format!("pay-{}", uuid());
    let paid = b.bob_pays_as("100", &transfer_id);
    assert_eq!(b.ledger.pot(&bills.id), "60");
    assert_eq!(b.ledger.pot(&savings.id), "40");
    assert_eq!(b.ledger.main(ADA), "0");

    // Bob's retry of the same send, and two sweeps, move nothing more.
    let again = b.bob_pays_as("100", &transfer_id);
    assert_eq!(s(&again, "ledgerTxId"), s(&paid, "ledgerTxId"));
    assert_eq!(b.sweep(later()), (0, 0, 0));
    assert_eq!(b.sweep(later()), (0, 0, 0));
    assert_eq!(b.ledger.sorter_moves(), 2);
    assert_eq!(b.ledger.pot(&bills.id), "60");
    assert_eq!(b.ledger.pot(&savings.id), "40");

    let runs = arr(&b.runs(ADA, &sorter_id).ok());
    assert_eq!(runs.len(), 1);
    assert_eq!(s(&runs[0], "creditTransferId"), transfer_id);
    assert_eq!(s(&runs[0], "creditTxId"), s(&paid, "ledgerTxId"));
    assert_eq!(s(&runs[0], "creditAmount"), "100");
    let legs: Vec<(String, String, String)> = arr(runs[0].get("legs").unwrap())
        .iter()
        .map(|l| (s(l, "spaceId"), s(l, "amount"), s(l, "status")))
        .collect();
    assert_eq!(
        legs,
        vec![
            (bills.id.clone(), "60".to_owned(), "settled".to_owned()),
            (savings.id.clone(), "40".to_owned(), "settled".to_owned()),
        ]
    );
    // Bob sees nothing of how Ada sorts.
    b.runs(BOB, &sorter_id).refused("bank.sorter_not_found");
}

#[test]
fn rounds_each_share_down_and_leaves_the_rest_in_the_account_a_payment_under_the_minimum_is_recorded_and_not_split()
 {
    let Some(b) = bank() else { return };
    let bills = b.pot("TEST bills", ADA, "USDT");
    b.bob_pays("50");
    let id = s(&b.make(&uuid(), &[(&bills.id, 3333)]).ok(), "id");
    // A payment from before the sorter is never sorted, by the send or the sweep.
    assert_eq!(b.sweep(later()), (0, 0, 0));
    b.bob_pays("0.5");
    assert_eq!(b.ledger.pot(&bills.id), "0");
    b.bob_pays("10.01");
    let share = sorter::leg_share(amt("10.01"), 3333);
    assert_eq!(format_amount(share), "3.336333");
    assert_eq!(b.ledger.pot(&bills.id), "3.336333");
    assert_eq!(b.ledger.main(ADA), format_amount(amt("60.51") - share));
    let runs: Vec<(String, String, usize)> = arr(&b.runs(ADA, &id).ok())
        .iter()
        .map(|r| {
            (
                s(r, "creditAmount"),
                s(r, "skippedReason"),
                arr(r.get("legs").unwrap()).len(),
            )
        })
        .collect();
    assert_eq!(
        runs,
        vec![
            ("10.01".to_owned(), "null".to_owned(), 1),
            ("0.5".to_owned(), "below_minimum".to_owned(), 0),
        ]
    );
    // Recorded once, the small payment is never weighed again, so it cannot hold the sweep back.
    assert_eq!(b.sweep(later()), (0, 0, 0));
}

#[test]
fn while_the_bank_has_no_terms_a_payment_is_recorded_unsorted_and_publishing_terms_later_never_splits_it()
 {
    let Some(mut b) = bank() else { return };
    let (bills, savings, sorter_id) = b.sixty_forty();
    b.set_min(None);
    b.bob_pays("100");
    b.set_min(Some("1"));
    assert_eq!(b.sweep(later()), (0, 0, 0));
    assert_eq!(b.ledger.main(ADA), "100");
    assert_eq!(b.ledger.pot(&bills.id), "0");
    assert_eq!(b.ledger.pot(&savings.id), "0");
    let runs = arr(&b.runs(ADA, &sorter_id).ok());
    assert_eq!(s(&runs[0], "creditAmount"), "100");
    assert_eq!(s(&runs[0], "skippedReason"), "terms_unset");
    assert_eq!(runs[0].get("legs"), Some(&Json::Array(vec![])));
}

#[test]
fn a_payment_whose_send_never_sorted_it_a_crash_after_the_post_is_sorted_by_the_sweep_once() {
    let Some(b) = bank() else { return };
    b.bob_pays("100");
    let (bills, savings, sorter_id) = b.sixty_forty();
    b.backdate(&sorter_id);
    assert_eq!(b.sweep(later()), (1, 0, 0));
    assert_eq!(b.sweep(later()), (0, 0, 0));
    assert_eq!(b.ledger.pot(&bills.id), "60");
    assert_eq!(b.ledger.pot(&savings.id), "40");
    assert_eq!(b.ledger.sorter_moves(), 2);
}

#[test]
fn a_split_whose_reply_was_lost_stays_pending_and_the_sweep_settles_it_under_the_same_key_without_moving_twice()
 {
    let Some(b) = bank() else { return };
    let (bills, savings, sorter_id) = b.sixty_forty();
    b.ledger.lose(true);
    b.bob_pays("100");
    assert_eq!(b.legs(&sorter_id), vec![pending(), pending()]);
    // A run younger than a minute is the send's; the sweep leaves it alone.
    assert_eq!(b.sweep(door::system_now()), (0, 0, 0));
    b.ledger.lose(false);
    assert_eq!(b.sweep(later()), (0, 1, 0));
    assert_eq!(b.sweep(later()), (0, 0, 0));
    assert_eq!(b.ledger.sorter_moves(), 2);
    assert_eq!(b.ledger.pot(&bills.id), "60");
    assert_eq!(b.ledger.pot(&savings.id), "40");
    assert_eq!(b.legs(&sorter_id), vec![settled(), settled()]);
}

#[test]
fn a_split_that_moved_before_its_space_was_archived_settles_on_its_booking_never_not_moved() {
    let Some(b) = bank() else { return };
    let (_, savings, sorter_id) = b.sixty_forty();
    b.ledger.lose(true);
    b.bob_pays("100");
    b.ledger.lose(false);
    b.own_move(&savings.id, &b.primary(ADA).id, "40");
    b.archive(&savings.id);
    assert_eq!(b.sweep(later()), (0, 1, 0));
    assert_eq!(b.legs(&sorter_id), vec![settled(), settled()]);
    assert_eq!(b.ledger.sorter_moves(), 2);
}

#[test]
fn a_refused_split_moves_nothing_and_is_recorded_with_its_code_the_other_split_still_lands() {
    let Some(b) = bank() else { return };
    let (bills, savings, sorter_id) = b.sixty_forty();
    b.archive(&savings.id);
    b.bob_pays("100");
    assert_eq!(b.ledger.pot(&bills.id), "60");
    assert_eq!(b.ledger.main(ADA), "40");
    assert_eq!(
        b.legs(&sorter_id),
        vec![settled(), rejected("bank.space_archived")]
    );
    // The sorter still names the archived space and says so: its share stays in the account until the person changes it.
    let listed = arr(b.list(ADA).get("sorters").unwrap());
    let legs: Vec<(String, String)> = arr(listed[0].get("legs").unwrap())
        .iter()
        .map(|l| (s(l, "spaceName"), s(l, "archived")))
        .collect();
    assert_eq!(
        legs,
        vec![
            ("TEST bills".to_owned(), "false".to_owned()),
            ("TEST savings".to_owned(), "true".to_owned())
        ]
    );
    // A refused split is final: the sweep does not move it later.
    assert_eq!(b.sweep(later()), (0, 0, 0));
    assert_eq!(b.ledger.main(ADA), "40");
}

#[test]
fn an_account_emptied_before_the_sweep_refuses_each_split_by_the_ledgers_code_and_moves_nothing() {
    let Some(b) = bank() else { return };
    b.bob_pays("100");
    let main = b.primary(ADA);
    let elsewhere = b.pot("TEST elsewhere", ADA, "USDT");
    b.own_move(&main.id, &elsewhere.id, "100");
    let (bills, savings, sorter_id) = b.sixty_forty();
    b.backdate(&sorter_id);
    assert_eq!(b.sweep(later()).0, 1);
    let legs = b.legs(&sorter_id);
    assert_eq!(
        legs,
        vec![
            rejected("ledger.insufficient_funds"),
            rejected("ledger.insufficient_funds")
        ]
    );
    assert_eq!(b.ledger.pot(&bills.id), "0");
    assert_eq!(b.ledger.pot(&savings.id), "0");
    assert_eq!(b.ledger.sorter_moves(), 0);
}

#[test]
fn an_absent_key_is_no_proof_while_an_earlier_post_may_still_land_the_split_waits_out_the_in_flight_bound()
 {
    let Some(b) = bank() else { return };
    let (bills, savings, sorter_id) = b.sixty_forty();
    b.ledger.fail(Some(socket_hang_up()));
    let paid = b.bob_pays("100");
    b.ledger.fail(None);
    // The account empties while both posts are still in flight: nothing under the keys, and nothing may be refused yet.
    let main = b.primary(ADA);
    let elsewhere = b.pot("TEST elsewhere", ADA, "USDT");
    b.own_move(&main.id, &elsewhere.id, "100");
    assert_eq!(b.sweep(later()), (0, 1, 2));
    assert_eq!(b.legs(&sorter_id), vec![pending(), pending()]);
    assert_eq!(b.ledger.sorter_moves(), 0);

    // The first split's post lands late; the next sweep finds it under its key and settles it.
    b.own_move(&elsewhere.id, &main.id, "60");
    b.ledger.book(
        &format!(
            "bank.transfer.own:{}:0",
            sorter::sorter_transfer_id(&sorter_id, &s(&paid, "ledgerTxId"))
        ),
        &main.ledger_account(),
        &bills.ledger_account(),
        "60",
    );
    assert_eq!(b.sweep(later()), (0, 1, 1));

    // Past the bound with nothing under its key, the second post is dead: the split posts again, and the empty account
    // refuses it by the ledger's code.
    b.age_attempts();
    assert_eq!(b.sweep(later()), (0, 1, 0));
    assert_eq!(
        b.legs(&sorter_id),
        vec![settled(), rejected("ledger.insufficient_funds")]
    );
    assert_eq!(b.ledger.pot(&bills.id), "60");
    assert_eq!(b.ledger.pot(&savings.id), "0");
    assert_eq!(b.ledger.sorter_moves(), 1);
}

#[test]
fn a_space_archived_while_its_split_may_still_land_waits_out_the_bound_before_the_split_is_refused()
{
    let Some(b) = bank() else { return };
    let (_, savings, sorter_id) = b.sixty_forty();
    b.ledger.fail(Some(socket_hang_up()));
    b.bob_pays("100");
    b.ledger.fail(None);
    b.archive(&savings.id);
    let first = b.sweep(later());
    assert_eq!((first.1, first.2), (1, 2));
    b.age_attempts();
    let second = b.sweep(later());
    assert_eq!((second.1, second.2), (1, 0));
    assert_eq!(
        b.legs(&sorter_id),
        vec![settled(), rejected("bank.space_archived")]
    );
}

#[test]
fn a_frozen_or_unreachable_ledger_never_makes_a_split_final_it_stays_pending_and_lands_once_the_ledger_answers()
 {
    let Some(b) = bank() else { return };
    let (bills, savings, sorter_id) = b.sixty_forty();
    let frozen = PostFailure::Coded {
        code: "ledger.frozen".to_owned(),
        message: "postings are frozen".to_owned(),
        attempts: 1,
    };
    let unreachable = PostFailure::Unknown("fetch failed".to_owned());
    for (i, failure) in [frozen, unreachable].into_iter().enumerate() {
        b.ledger.fail(Some(failure));
        b.age_attempts();
        if i == 1 {
            let swept = b.sweep(later());
            assert_eq!((swept.1, swept.2), (1, 2));
        } else {
            b.bob_pays("100");
        }
        assert_eq!(b.legs(&sorter_id), vec![pending(), pending()]);
    }
    b.ledger.fail(None);
    // Inside the bound the splits wait; past it they post and land, once.
    let waiting = b.sweep(later());
    assert_eq!((waiting.1, waiting.2), (1, 2));
    b.age_attempts();
    assert_eq!(b.sweep(later()), (0, 1, 0));
    assert_eq!(b.ledger.pot(&bills.id), "60");
    assert_eq!(b.ledger.pot(&savings.id), "40");
    assert_eq!(b.ledger.sorter_moves(), 2);
}

#[test]
fn a_cancelled_sorter_sorts_nothing_new_what_it_sorted_stays() {
    let Some(b) = bank() else { return };
    let (bills, _, sorter_id) = b.sixty_forty();
    b.bob_pays("100");
    let cancelled = b
        .call(
            ADA,
            "sorter.cancel",
            &format!(r#"{{"sorterId":"{sorter_id}"}}"#),
        )
        .ok();
    assert_eq!(s(&cancelled, "status"), "cancelled");
    assert!(s(&cancelled, "cancelledAt") != "null");
    assert_eq!(b.list(ADA).get("sorters"), Some(&Json::Array(vec![])));
    b.bob_pays("100");
    assert_eq!(b.sweep(later()).0, 0);
    assert_eq!(b.ledger.pot(&bills.id), "60");
    assert_eq!(b.ledger.main(ADA), "100");
}

// ---------------------------------------------------------------------------------------------------------------
// the job door (not in the TypeScript suite)

fn job(b: &Bank, body: &str, signed: bool) -> Answer {
    let headers = if signed {
        s2s::legacy_headers("svc-bank", INTERNAL, body, system_seconds()).unwrap()
    } else {
        Vec::new()
    };
    send(&b.door, sorter::RUN_INCOME_SORTER, "POST", body, headers)
}

#[test]
fn the_sweep_job_door_refuses_an_unsigned_caller_and_a_body_not_in_shape() {
    let Some(b) = bank() else { return };
    assert_eq!(job(&b, r#"{"limit":10}"#, false).0, 401);
    let bad = job(&b, r#"{"limit":1001}"#, true);
    assert_eq!(bad.0, 400);
    assert_eq!(s(&bad.1, "code"), "bank.validation_failed");
    assert_eq!(job(&b, r#"{"limit":10,"extra":true}"#, true).0, 400);
}

#[test]
fn the_sweep_job_door_sorts_a_payment_its_send_never_sorted_and_answers_the_report() {
    let Some(b) = bank() else { return };
    b.bob_pays("100");
    let (bills, savings, sorter_id) = b.sixty_forty();
    b.backdate(&sorter_id);
    let ran = job(&b, r#"{"limit":10}"#, true);
    assert_eq!(ran.0, 200, "{}", ran.1.compact());
    assert_eq!(
        ran.1.compact(),
        r#"{"creditsRecorded":1,"runsDriven":0,"legsStillPending":0}"#
    );
    assert_eq!(b.ledger.pot(&bills.id), "60");
    assert_eq!(b.ledger.pot(&savings.id), "40");
}
