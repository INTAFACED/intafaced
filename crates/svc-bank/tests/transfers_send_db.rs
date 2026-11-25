//! Slice `transfers`' sends to another person and payment requests against the Rust door on a real Postgres. Ports the
//! checks of the TypeScript's `transfers/personal-pay.db.test.ts`, `transfers/send-review.db.test.ts` and the
//! `transferToUser` tests of `bank-service.test.ts`, each test named after the TypeScript test's words. A TypeScript call
//! through the router is a door call here; a call on `PersonalPayService` or `TransferService` is the Rust function it
//! became (`personal::send`, `release_held`, `reject_held`, `announce_unannounced`, `requests::*`,
//! `moves::transfer_to_user`), given the same dependencies the door gives it.
//!
//! The ledger is a stand-in that books `bankTransfer` as svc-ledger does (one credit on the payer, one debit on the
//! payee, once per key) and refuses too little money as the TypeScript's `MemoryLedger` does: with no proof of a single
//! attempt, so the refusal alone never proves nothing was booked. It can lose one answer after booking, hide a key from
//! a lookup, or refuse a key prefix `ledger.frozen`. The bus records every publish. Without `TEST_DATABASE_URL` each
//! test skips; with `REQUIRE_POSTGRES=1` it fails.
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
use service_kit::s2s_verify::BodyBind;
use service_kit::server::Request;
use service_kit::time::{Instant, js_date};
use svc_bank::db::Store;
use svc_bank::door::{self, BankDoor, DoorConfig, Kind, ServiceAuth};
use svc_bank::errors::{Refusal, to_trpc};
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
use svc_bank::transfers::personal::{self, SendInput, Sent};
use svc_bank::transfers::ports::{
    AccountOf, Bus, ExtraControls, Extras, HandleUnavailable, LockState, MemoryIdentity, NoBus,
    PartyHandles, RecipientState, RecipientStatus, RecipientUnavailable, SecurityLock,
};
use svc_bank::transfers::requests::{self, NewRequest};
use svc_bank::transfers::{self, Settings, Wiring as TransfersWiring, moves};

use support::TestDb;

const SECRET: &str = "a-bank-send-db-edge-secret-long-enough-ok";
const INTERNAL: &str = "a-bank-send-db-internal-secret-long-enough";
const ADA: &str = "11111111-1111-4111-8111-111111111111";
const BOB: &str = "22222222-2222-4222-8222-222222222222";
const CY: &str = "33333333-3333-4333-8333-333333333333";
const NO_SUCH_USER: &str = "99999999-0000-4000-8000-000000000000";
const RW: &[&str] = &["bank:read", "bank:write"];
const READ: &[&str] = &["bank:read"];
const WRITE: &[&str] = &["bank:write"];
const EXPIRES: &str = "2026-12-01T00:00:00.000Z";

fn at(iso: &str) -> Instant {
    js_date(iso).unwrap()
}

fn amt(s: &str) -> Amount {
    parse_amount(s).unwrap()
}

// ---------------------------------------------------------------------------------------------------------------
// Stand-ins: svc-ledger's book, svc-identity's reads, the bus, the directory, the freeze.

type Acct = (String, String, String, String);

#[derive(Default)]
struct BookState {
    balances: BTreeMap<Acct, Amount>,
    journal: Vec<(String, LedgerTx)>,
    /// Keys starting with this refuse `ledger.frozen` after this many attempts (1 proves nothing was booked).
    poison: Option<(String, u32)>,
    /// A key starting with this is booked, and its answer lost once (a timeout after the commit).
    lose_reply: Option<String>,
    /// A lookup of a key starting with this finds nothing, while set.
    hide: Option<String>,
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
    /// `recipes.deposit`.
    fn fund(&self, user: &str, amount: &str) {
        let key = (
            "user".to_owned(),
            user.to_owned(),
            "USDT".to_owned(),
            "available".to_owned(),
        );
        *self.0.lock().unwrap().balances.entry(key).or_default() += amt(amount);
    }
    fn of(&self, owner_type: &str, owner: &str) -> String {
        let key = (
            owner_type.to_owned(),
            owner.to_owned(),
            "USDT".to_owned(),
            "available".to_owned(),
        );
        format_amount(
            self.0
                .lock()
                .unwrap()
                .balances
                .get(&key)
                .copied()
                .unwrap_or(Amount::ZERO),
        )
    }
    /// `userAvailable(user, 'USDT')`.
    fn available(&self, user: &str) -> String {
        self.of("user", user)
    }
    /// `subAccountAvailable(space, 'USDT')`.
    fn pot(&self, space: &str) -> String {
        self.of("subaccount", space)
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
    /// The person-to-person posts (`reason === 'bank.transfer.manual'` on the memory ledger).
    fn p2p(&self) -> Vec<String> {
        self.keys()
            .into_iter()
            .filter(|k| k.starts_with("bank.transfer.p2p:"))
            .collect()
    }
    fn tx(&self, key: &str) -> Option<LedgerTx> {
        self.0
            .lock()
            .unwrap()
            .journal
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, t)| t.clone())
    }
    fn poison(&self, prefix: Option<(&str, u32)>) {
        self.0.lock().unwrap().poison = prefix.map(|(p, n)| (p.to_owned(), n));
    }
    fn lose_reply(&self, prefix: &str) {
        self.0.lock().unwrap().lose_reply = Some(prefix.to_owned());
    }
    fn hide(&self, prefix: Option<&str>) {
        self.0.lock().unwrap().hide = prefix.map(str::to_owned);
    }
    /// The books close: what was deposited is all there is.
    fn total(&self) -> String {
        format_amount(self.0.lock().unwrap().balances.values().sum())
    }
    /// Something else booked under a key, as the test's own `ledger.post(recipes.bankTransfer(...))`.
    fn book(&self, key: &str, from: &LedgerAccount, to: &LedgerAccount, amount: &str) -> LedgerTx {
        let input = Json::obj([
            ("from", from.json()),
            ("to", to.json()),
            ("amount", Json::str(amount)),
        ]);
        self.post_recipe("bankTransfer", &input, key).unwrap()
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
            .unwrap_or(Amount::ZERO))
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
        let st = self.0.lock().unwrap();
        if st.hide.as_deref().is_some_and(|p| key.starts_with(p)) {
            return Ok(None);
        }
        Ok(st
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
        if let Some((p, attempts)) = &st.poison
            && key.starts_with(p.as_str())
        {
            return Err(PostFailure::Coded {
                code: "ledger.frozen".to_owned(),
                message: "Ledger posting is frozen: LOCAL TEST".to_owned(),
                attempts: *attempts,
            });
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
        let held = st.balances.get(&from).copied().unwrap_or(Amount::ZERO);
        if held < amount {
            // The memory ledger's refusal carries no single-attempt stamp: it proves nothing on its own.
            return Err(PostFailure::Coded {
                code: "ledger.insufficient_funds".to_owned(),
                message: format!(
                    "Insufficient funds: {} < {}",
                    format_amount(held),
                    format_amount(amount)
                ),
                attempts: 2,
            });
        }
        *st.balances.entry(from.clone()).or_default() -= amount;
        *st.balances.entry(to.clone()).or_default() += amount;
        let tx = LedgerTx {
            key: String::new(),
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
        if st.lose_reply.as_deref().is_some_and(|p| key.starts_with(p)) {
            st.lose_reply = None;
            return Err(PostFailure::Unknown("timeout".to_owned()));
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

/// The bus: every publish, in order (the tests' `postedNotices` and `created`), and down while `failing`.
#[derive(Clone, Default)]
struct Recorder(Arc<Mutex<Published>>);

/// Every publish (subject, payload), and whether the bus is down.
type Published = (Vec<(String, Json)>, bool);

impl Bus for Recorder {
    fn publish(&self, subject: &str, _msg_id: &str, envelope: &Json) -> Result<(), String> {
        let mut st = self.0.lock().unwrap();
        if st.1 {
            return Err("bus down".to_owned());
        }
        st.0.push((subject.to_owned(), envelope.get("payload").unwrap().clone()));
        Ok(())
    }
}

impl Recorder {
    fn fail(&self, down: bool) {
        self.0.lock().unwrap().1 = down;
    }
    fn of(&self, subject: &str) -> Vec<Json> {
        self.0
            .lock()
            .unwrap()
            .0
            .iter()
            .filter(|(s, _)| s == subject)
            .map(|(_, p)| p.clone())
            .collect()
    }
    /// `postedNotices`.
    fn posted(&self) -> Vec<Json> {
        self.of("intafaced.bank.personal_transfer.posted")
    }
    /// `created`.
    fn created(&self) -> Vec<Json> {
        self.of("intafaced.bank.personal_request.created")
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

// ---------------------------------------------------------------------------------------------------------------
// The door, its wiring, and the service-level calls

/// The owner values and wiring one suite runs under.
#[derive(Clone)]
struct Owner {
    /// `BANK_PERSONAL_SEND_REVIEW_JSON`.
    review: Option<&'static str>,
    /// `BANK_REQUEST_REMIND_POLICY_JSON`.
    remind: Option<&'static str>,
    /// Notices wired to the recorder; none is `NoBus`.
    bus: bool,
    /// The TEST partner's stated send fee; none is its own `SEND_FEE`.
    partner_send_fee: Option<&'static str>,
}

/// `personal-pay.db.test.ts`'s bank: the TEST reminder rule, two in any 24 hours.
fn pay_owner() -> Owner {
    Owner {
        review: None,
        remind: Some(r#"{"cap":2,"windowSeconds":86400}"#),
        bus: true,
        partner_send_fee: None,
    }
}

/// `send-review.db.test.ts`'s bank: the LOCAL TEST review line, a USDT send above 50 waits.
fn review_owner() -> Owner {
    Owner {
        review: Some(r#"{"USDT":"50"}"#),
        remind: None,
        bus: true,
        partner_send_fee: None,
    }
}

struct Bank {
    door: BankDoor,
    db: TestDb,
    ledger: Book,
    identity: Identity,
    bus: Recorder,
    owner: Owner,
}

fn partner_wiring(o: &Owner) -> PartnerWiring {
    let partner = TestPartner::new().unwrap();
    PartnerWiring {
        partner: Some(match o.partner_send_fee {
            Some(fee) => partner.with_send_fee(amt(fee)),
            None => partner,
        }),
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

fn transfers_wiring(identity: &Identity, bus: &Recorder, o: &Owner) -> TransfersWiring {
    let mut w = TransfersWiring::none();
    w.recipients = Box::new(identity.clone());
    w.lock = Box::new(identity.clone());
    w.extras = Box::new(identity.clone());
    w.handles = Some(Box::new(identity.clone()));
    w.bus = if o.bus {
        Box::new(bus.clone())
    } else {
        Box::new(NoBus)
    };
    w.settings = Settings {
        send_review: o.review.map(str::to_owned),
        remind_policy: o.remind.map(str::to_owned),
        producer: "svc-bank".to_owned(),
        ..Settings::default()
    };
    w
}

fn door_for(db: &TestDb, b: &Book, identity: &Identity, bus: &Recorder, o: &Owner) -> BankDoor {
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
    .with_partner(partner_wiring(o))
    .with_spaces(spaces_wiring(b))
    .with_transfers(transfers_wiring(identity, bus, o))
}

fn bank_with(o: Owner) -> Option<Bank> {
    let db = TestDb::new()?;
    db.migrated();
    let ledger = Book::default();
    let identity = Identity::default();
    identity
        .0
        .set_status(NO_SUCH_USER, RecipientStatus::NotFound);
    // `memoryPartyHandles({ [ADA]: 'ada', [BOB]: 'bob' })`.
    identity.0.set_handle(ADA, "ada");
    identity.0.set_handle(BOB, "bob");
    let bus = Recorder::default();
    let door = door_for(&db, &ledger, &identity, &bus, &o);
    Some(Bank {
        door,
        db,
        ledger,
        identity,
        bus,
        owner: o,
    })
}

impl Bank {
    fn store(&self) -> Store {
        self.db.store()
    }
    fn sql(&self, q: &str) {
        self.db.client().execute(q, &[]).unwrap();
    }
    fn count(&self, sql: &str) -> i64 {
        self.db.count(sql)
    }
    fn rows(&self, sql: &str) -> Vec<Vec<Option<String>>> {
        self.db
            .client()
            .query(sql, &[])
            .unwrap()
            .iter()
            .map(|r| {
                (0..r.len())
                    .map(|i| r.get::<_, Option<String>>(i))
                    .collect()
            })
            .collect()
    }
    /// The slice's dependencies, as the door builds them, under `o` and at `now` (the system clock when none).
    fn with<T>(
        &self,
        o: &Owner,
        now: Option<Instant>,
        f: impl FnOnce(&transfers::Deps<'_>) -> T,
    ) -> T {
        let partner = partner_wiring(o);
        let spaces = spaces_wiring(&self.ledger);
        let w = transfers_wiring(&self.identity, &self.bus, o);
        let store = self.store();
        let custody = partner.custody(&store);
        f(&transfers::Deps {
            store: &store,
            ledger: &self.ledger,
            custody: &custody,
            partner: &partner,
            spaces: &spaces,
            w: &w,
            now: now.unwrap_or_else(door::system_now),
        })
    }
    /// `bank.personalPay` / `bank.transfers`: the suite's own wiring.
    fn svc<T>(&self, f: impl FnOnce(&transfers::Deps<'_>) -> T) -> T {
        self.with(&self.owner.clone(), None, f)
    }
    /// `ready()`: both main spaces, Ada funded 100, and TEST limits for USDT unless a test is about blank terms.
    fn ready(&self, terms: bool) -> String {
        let from = primary(self, ADA);
        primary(self, BOB);
        self.ledger.fund(ADA, "100");
        if terms {
            self.sql(
                "INSERT INTO bank.personal_transfer_terms (asset_id, per_transfer_limit, daily_limit, fee) \
                 VALUES ('USDT', 1000, 10000, 0)",
            );
        }
        from
    }
    /// `owed()`: posted sends the bus has not taken a notice for yet.
    fn owed(&self) -> Vec<String> {
        self.rows(
            "SELECT transfer_id FROM bank.personal_transfers WHERE status = 'posted' AND announced_at IS NULL \
             ORDER BY transfer_id",
        )
        .into_iter()
        .map(|r| r[0].clone().unwrap())
        .collect()
    }
}

fn person(user: &str, scopes: &[&str]) -> Vec<(String, String)> {
    let raw = Json::obj([
        ("sub", Json::str(user)),
        (
            "scopes",
            Json::Array(scopes.iter().map(|s| Json::str(*s)).collect()),
        ),
        ("tier", Json::str("full")),
        ("mfa", Json::Bool(true)),
        ("sid", Json::str("44444444-4444-4444-8444-444444444444")),
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
    /// `rejects.toMatchObject({ code, message: stringContaining(words) })`.
    fn refused(&self, code: &str, words: &str) {
        assert_eq!(self.trpc(), code, "{}", self.1.compact());
        assert!(
            self.message().contains(words),
            "{words} not in {}",
            self.1.compact()
        );
    }
}

fn call(b: &Bank, user: &str, scopes: &[&str], path: &str, input: &str) -> Answer {
    let kind = door::call(path).map(|c| c.kind);
    let (method, url, body) = match kind {
        Some(Kind::Query) => (
            "GET",
            format!("/trpc/{path}?input={}", encode(input)),
            String::new(),
        ),
        _ => ("POST", format!("/trpc/{path}"), input.to_owned()),
    };
    let mut headers = person(user, scopes);
    headers.push(("content-type".to_owned(), "application/json".to_owned()));
    let res = b.door.handle_from(
        &Request {
            method,
            url: &url,
            headers: &headers,
            body: &body,
        },
        "req-send-db",
        "127.0.0.1",
    );
    Answer(res.status, json::parse(&res.body).unwrap())
}

/// `transfers.toUser` as `user`.
fn to_user(b: &Bank, user: &str, input: &Json) -> Answer {
    call(b, user, RW, "transfers.toUser", &input.compact())
}

fn send_of(id: &str, from: &str, to: &str, amount: &str) -> Json {
    Json::obj([
        ("transferId", Json::str(id)),
        ("fromSpaceId", Json::str(from)),
        ("toUserId", Json::str(to)),
        ("amount", Json::str(amount)),
    ])
}

fn with_field(j: &Json, k: &str, v: Json) -> Json {
    let Json::Object(mut f) = j.clone() else {
        panic!()
    };
    f.retain(|(key, _)| key != k);
    f.push((k.to_owned(), v));
    Json::Object(f)
}

fn s(j: &Json, key: &str) -> String {
    match j.get(key) {
        Some(Json::String(v)) => v.clone(),
        Some(Json::Null) | None => "null".to_owned(),
        Some(other) => other.compact(),
    }
}

fn primary(b: &Bank, user: &str) -> String {
    space::with(&b.store(), |c| space::ensure_primary(c, user, "USDT"))
        .unwrap()
        .id
}

fn space_of(b: &Bank, id: &str) -> space::Space {
    space::with(&b.store(), |c| space::get(c, id)).unwrap()
}

/// `spaces.create`.
fn pot(b: &Bank, user: &str, name: &str) -> String {
    s(
        &call(
            b,
            user,
            RW,
            "spaces.create",
            &format!(r#"{{"assetId":"USDT","name":"{name}"}}"#),
        )
        .ok(),
        "id",
    )
}

/// `bank.transfers.transfer`: a move between two of the person's own spaces.
fn own_move(b: &Bank, user: &str, id: &str, from: &str, to: &str, amount: &str) -> Json {
    call(
        b,
        user,
        RW,
        "transfers.create",
        &format!(r#"{{"transferId":"{id}","fromSpaceId":"{from}","toSpaceId":"{to}","amount":"{amount}"}}"#),
    )
    .ok()
}

/// `personalRequest.create` as the payee.
fn ask(b: &Bank, payee: &str, payer: &str, amount: &str, note: Option<&str>, key: &str) -> Answer {
    let mut f = vec![
        ("payerUserId", Json::str(payer)),
        ("assetId", Json::str("USDT")),
        ("amount", Json::str(amount)),
    ];
    if let Some(n) = note {
        f.push(("note", Json::str(n)));
    }
    f.push(("expiresAt", Json::str(EXPIRES)));
    f.push(("idempotencyKey", Json::str(key)));
    let body = Json::Object(f.into_iter().map(|(k, v)| (k.to_owned(), v)).collect());
    call(b, payee, RW, "personalRequest.create", &body.compact())
}

fn request_get(b: &Bank, user: &str, id: &str) -> Json {
    call(
        b,
        user,
        RW,
        "personalRequest.get",
        &format!(r#"{{"requestId":"{id}"}}"#),
    )
    .ok()
}

/// A service-level send (`personal.send(...)`).
fn service_send(
    d: &transfers::Deps<'_>,
    actor: &str,
    id: &str,
    from: &str,
    to: &str,
    amount: &str,
    request: Option<&str>,
) -> Result<Sent, Box<personal::SendFailed>> {
    personal::send(
        d,
        &SendInput {
            actor_user_id: actor,
            transfer_id: id,
            from_space_id: from,
            to_user_id: to,
            amount: amt(amount),
            note: None,
            reference: None,
            request_id: request,
            reviewed: false,
        },
    )
}

fn posted_tx(sent: &Sent) -> String {
    match sent {
        Sent::Posted(v) => v.ledger_tx_id.clone().unwrap(),
        Sent::Held(h) => panic!("held: {h:?}"),
    }
}

fn code_of(r: &Refusal) -> String {
    match r {
        Refusal::Bank(e) => e.row.code.to_owned(),
        Refusal::Trpc(e) => e.cause.clone().unwrap_or_else(|| e.code.to_owned()),
        Refusal::Other(m) => format!("other: {m}"),
    }
}

fn req_id(j: &Json) -> String {
    s(j, "requestId")
}

// ===============================================================================================================
// personal-pay.db.test.ts

#[test]
fn records_a_note_both_handles_and_one_ledger_posting() {
    let Some(b) = bank_with(pay_owner()) else {
        return;
    };
    let from = b.ready(true);
    let send = with_field(
        &send_of("send-note-1", &from, BOB, "20"),
        "note",
        Json::str("  rent share  "),
    );
    let sent = to_user(&b, ADA, &send).ok();
    assert_eq!(s(&sent, "note"), "rent share");
    assert_eq!(s(&sent, "amount"), "20");
    assert_eq!(s(&sent, "requestId"), "null");

    let again = to_user(&b, ADA, &with_field(&send, "note", Json::str("rent share"))).ok();
    assert_eq!(s(&again, "ledgerTxId"), s(&sent, "ledgerTxId"));
    assert_eq!(b.ledger.p2p().len(), 1);
    assert_eq!(b.ledger.available(ADA), "80");
    assert_eq!(b.ledger.available(BOB), "20");

    let tx_id = s(&sent, "ledgerTxId");
    assert_ne!(
        tx_id, "null",
        "a send on the custodial layer names its ledger transaction"
    );
    assert_eq!(s(&sent, "partnerMove"), "null");
    let tx = b.ledger.tx_by_id(&tx_id).unwrap().unwrap();
    let receipt = call(
        &b,
        BOB,
        RW,
        "transfers.get",
        &format!(r#"{{"ledgerTxId":"{tx_id}"}}"#),
    )
    .ok();
    for (k, v) in [
        ("ledgerTxId", tx_id.as_str()),
        ("partnerMove", "null"),
        ("transferId", "send-note-1"),
        ("createdAt", tx.posted_at.iso().as_str()),
        ("fromHandle", "ada"),
        ("toHandle", "bob"),
        ("handlesBlocker", "null"),
        ("fee", "null"),
        ("status", "posted"),
        ("amount", "20"),
        ("assetId", "USDT"),
        ("note", "rent share"),
    ] {
        assert_eq!(s(&receipt, k), v, "{k}");
    }
    // The TypeScript then reads Bob's activity feed (`activity.list`): slice `activity`'s, not ported here.

    to_user(&b, ADA, &with_field(&send, "note", Json::str("different")))
        .refused("CONFLICT", "bank.personal_transfer_conflict");
    assert_eq!(b.ledger.p2p().len(), 1);

    call(
        &b,
        CY,
        READ,
        "transfers.get",
        &format!(r#"{{"ledgerTxId":"{tx_id}"}}"#),
    )
    .refused("NOT_FOUND", "bank.personal_transfer_not_found");
}

#[test]
fn tells_both_people_a_send_posted_with_the_facts_of_the_posting_and_a_lost_publish_never_fails_the_send()
 {
    let Some(b) = bank_with(pay_owner()) else {
        return;
    };
    let from = b.ready(true);
    let sent = to_user(&b, ADA, &send_of("send-notice-1", &from, BOB, "12.50")).ok();
    let notices = b.bus.posted();
    assert_eq!(notices.len(), 1);
    let n = &notices[0];
    for (k, v) in [
        ("transferId", "send-notice-1"),
        ("senderUserId", ADA),
        ("recipientUserId", BOB),
        ("amount", "12.5"),
        ("assetId", "USDT"),
        ("ledgerTxId", s(&sent, "ledgerTxId").as_str()),
        ("partnerMoveId", "null"),
    ] {
        assert_eq!(s(n, k), v, "{k}");
    }
    assert!(js_date(&s(n, "postedAt")).is_some());

    // A refused send announces nothing.
    assert_ne!(
        to_user(&b, ADA, &send_of("send-notice-2", &from, BOB, "1000")).0,
        200
    );
    assert_eq!(b.bus.posted().len(), 1);

    // The bus is down: the money still moves and the send still answers.
    b.bus.fail(true);
    let quiet = to_user(&b, ADA, &send_of("send-notice-3", &from, BOB, "1")).ok();
    assert!(matches!(quiet.get("ledgerTxId"), Some(Json::String(_))));
    assert_eq!(b.ledger.available(BOB), "13.5");
    assert_eq!(b.bus.posted().len(), 1);
    assert_eq!(b.owed(), ["send-notice-3"]);
}

#[test]
fn a_retried_send_whose_notice_was_lost_announces_it_then_and_once_announced_never_again() {
    let Some(b) = bank_with(pay_owner()) else {
        return;
    };
    let from = b.ready(true);
    let send = send_of("send-notice-retry", &from, BOB, "5");
    b.bus.fail(true);
    let first = to_user(&b, ADA, &send).ok();
    assert_eq!(b.owed(), ["send-notice-retry"]);

    b.bus.fail(false);
    let again = to_user(&b, ADA, &send).ok();
    assert_eq!(s(&again, "ledgerTxId"), s(&first, "ledgerTxId"));
    let notices: Vec<(String, String)> = b
        .bus
        .posted()
        .iter()
        .map(|n| (s(n, "transferId"), s(n, "ledgerTxId")))
        .collect();
    assert_eq!(
        notices,
        [("send-notice-retry".to_owned(), s(&first, "ledgerTxId"))]
    );
    assert!(b.owed().is_empty());
    assert_eq!(b.ledger.available(BOB), "5");

    to_user(&b, ADA, &send).ok();
    assert_eq!(b.bus.posted().len(), 1);
}

#[test]
fn the_recovery_pass_announces_owed_sends_older_than_the_grace_keeps_failures_owed_and_leaves_young_ones_alone()
 {
    let Some(b) = bank_with(pay_owner()) else {
        return;
    };
    let from = b.ready(true);
    b.bus.fail(true);
    for id in ["send-owed-old", "send-owed-young"] {
        to_user(&b, ADA, &send_of(id, &from, BOB, "2")).ok();
    }
    b.sql(
        "UPDATE bank.personal_transfers SET posted_at = now() - interval '5 minutes' \
         WHERE transfer_id = 'send-owed-old'",
    );
    let posted_at = b.rows(
        "SELECT to_char(posted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') \
         FROM bank.personal_transfers WHERE transfer_id = 'send-owed-old'",
    )[0][0]
        .clone()
        .unwrap();
    let pass = |b: &Bank| {
        b.svc(|d| personal::announce_unannounced(d, 50))
            .unwrap()
            .into_iter()
            .collect::<Vec<_>>()
    };

    // Still down: the pass says so and the row stays owed.
    assert_eq!(pass(&b), [Err("bank.transfer_notice_failed".to_owned())]);
    assert_eq!(b.owed(), ["send-owed-old", "send-owed-young"]);

    b.bus.fail(false);
    assert_eq!(pass(&b), [Ok(())]);
    let notices = b.bus.posted();
    assert_eq!(
        notices
            .iter()
            .map(|n| s(n, "transferId"))
            .collect::<Vec<_>>(),
        ["send-owed-old"]
    );
    // The notice carries when the money moved, not when the pass ran.
    assert_eq!(s(&notices[0], "postedAt"), posted_at);
    assert_eq!(b.owed(), ["send-owed-young"]);
    assert!(pass(&b).is_empty());
    assert_eq!(b.bus.posted().len(), 1);
}

#[test]
fn a_posted_send_records_its_own_fee_and_the_network_fee_its_book_stated() {
    let Some(b) = bank_with(pay_owner()) else {
        return;
    };
    let from = b.ready(true);
    b.svc(|d| service_send(d, ADA, "send-fees-own-book", &from, BOB, "4", None))
        .unwrap();
    // Our published fee (free here) and, on our own book, which crosses no network, a network fee of "0": recorded with
    // the send, so the activity row shows what this payment cost, not today's terms.
    assert_eq!(
        b.rows(
            "SELECT fee::text, network_fee::text FROM bank.personal_transfers \
              WHERE transfer_id = 'send-fees-own-book'"
        ),
        [[
            Some("0.000000000000000000".to_owned()),
            Some("0.000000000000000000".to_owned())
        ]]
    );
}

#[test]
fn with_no_notices_wired_a_send_still_posts_and_its_notice_stays_owed() {
    let Some(b) = bank_with(pay_owner()) else {
        return;
    };
    let from = b.ready(true);
    let unwired = Owner {
        bus: false,
        ..pay_owner()
    };
    b.with(&unwired, None, |d| {
        service_send(d, ADA, "send-notice-unwired", &from, BOB, "4", None)
    })
    .unwrap();
    assert_eq!(b.ledger.available(BOB), "4");
    assert_eq!(b.owed(), ["send-notice-unwired"]);
    b.sql("UPDATE bank.personal_transfers SET posted_at = now() - interval '5 minutes'");
    assert_eq!(
        b.with(&unwired, None, |d| personal::announce_unannounced(d, 50))
            .unwrap(),
        [Err("bank.transfer_notice_failed".to_owned())]
    );
}

#[test]
fn refuses_a_control_character_note_and_posts_nothing() {
    let Some(b) = bank_with(pay_owner()) else {
        return;
    };
    let from = b.ready(true);
    call(
        &b,
        ADA,
        WRITE,
        "transfers.toUser",
        &with_field(
            &send_of("send-bad-note", &from, BOB, "1"),
            "note",
            Json::str("hi\nthere"),
        )
        .compact(),
    )
    .refused("BAD_REQUEST", "bank.personal_note_invalid");
    assert!(b.ledger.p2p().is_empty());
}

#[test]
fn refuses_a_send_when_no_limits_are_published_nothing_reserved_nothing_posted() {
    let Some(b) = bank_with(pay_owner()) else {
        return;
    };
    let from = b.ready(false);
    for _ in 0..2 {
        let a = to_user(&b, ADA, &send_of("send-blank-terms-1", &from, BOB, "10"));
        assert!(
            a.message().contains("bank.personal_transfer_terms_unset"),
            "{}",
            a.1.compact()
        );
    }
    assert_eq!(b.count("SELECT count(*) FROM bank.personal_transfers"), 0);
    assert!(b.ledger.p2p().is_empty());
    assert_eq!(b.ledger.available(ADA), "100");
    assert_eq!(b.ledger.available(BOB), "0");
}

#[test]
fn a_quote_names_the_network_fee_the_partner_holding_the_money_reports_and_null_when_it_says_none()
{
    // A TEST partner that states a send fee our own book never gives, so the quote shows whose figure it answered.
    let Some(b) = bank_with(Owner {
        partner_send_fee: Some("0.5"),
        ..pay_owner()
    }) else {
        return;
    };
    b.sql(
        "INSERT INTO bank.personal_transfer_terms (asset_id, per_transfer_limit, daily_limit, fee) \
         VALUES ('EUR', 1000, 5000, 0)",
    );
    let quote = |b: &Bank| {
        call(
            b,
            ADA,
            RW,
            "transfers.quote",
            r#"{"assetId":"EUR","amount":"25"}"#,
        )
        .ok()
    };
    let set = |input: &str| call(&b, ADA, RW, "testPartner.set", input).ok();
    set(r#"{"custody":"off"}"#);
    let held = quote(&b);
    // The partner's own stated send fee, as its figure: not our own book's "0", and not the null of a fee it does not
    // give.
    assert_eq!(
        held.get("networkFee"),
        Some(&Json::str("0.5")),
        "{}",
        held.compact()
    );
    assert_eq!(held.get("withinPerTransfer"), Some(&Json::Bool(true)));
    set(r#"{"fee":"unknown"}"#);
    let unknown = quote(&b);
    assert_eq!(
        unknown.get("networkFee"),
        Some(&Json::Null),
        "{}",
        unknown.compact()
    );
    assert!(b.ledger.p2p().is_empty());
}

#[test]
fn quotes_only_a_published_zero_fee_and_refuses_an_unpublished_or_unwired_fee() {
    let Some(b) = bank_with(pay_owner()) else {
        return;
    };
    let from = b.ready(false);
    let quote = |b: &Bank, amount: &str| {
        call(
            b,
            ADA,
            RW,
            "transfers.quote",
            &format!(r#"{{"assetId":"USDT","amount":"{amount}"}}"#),
        )
    };
    quote(&b, "10").refused("PRECONDITION_FAILED", "bank.personal_transfer_terms_unset");

    b.sql(
        "INSERT INTO bank.personal_transfer_terms (asset_id, per_transfer_limit, daily_limit, fee) \
         VALUES ('USDT', 25.5, 100, 0)",
    );
    assert_eq!(
        quote(&b, "10").ok().compact(),
        Json::obj([
            ("assetId", Json::str("USDT")),
            ("amount", Json::str("10")),
            ("perTransferLimit", Json::str("25.5")),
            ("dailyLimit", Json::str("100")),
            ("spentToday", Json::str("0")),
            ("remainingToday", Json::str("100")),
            ("fee", Json::str("0")),
            ("feeBlocker", Json::Null),
            // On our own book a send crosses no network.
            ("networkFee", Json::str("0")),
            ("withinPerTransfer", Json::Bool(true)),
            ("withinDaily", Json::Bool(true)),
        ])
        .compact()
    );

    to_user(&b, ADA, &send_of("send-over-cap", &from, BOB, "26"))
        .refused("BAD_REQUEST", "bank.personal_transfer_limit_exceeded");
    assert!(b.ledger.p2p().is_empty());

    to_user(&b, ADA, &send_of("send-under-cap", &from, BOB, "20")).ok();
    let q = quote(&b, "10").ok();
    assert_eq!(
        (
            s(&q, "spentToday"),
            s(&q, "remainingToday"),
            s(&q, "withinDaily")
        ),
        ("20".to_owned(), "80".to_owned(), "true".to_owned())
    );

    // A reservation still in flight counts; one old enough for the next send to release it does not.
    b.sql(&format!(
        "INSERT INTO bank.personal_transfers (transfer_id, from_user_id, from_space_id, to_user_id, asset_id, amount, status, created_at) \
         VALUES ('send-in-flight', '{ADA}', '{from}', '{BOB}', 'USDT', 5, 'reserved', now()), \
                ('send-stale', '{ADA}', '{from}', '{BOB}', 'USDT', 70, 'reserved', now() - interval '16 minutes')"
    ));
    let q = quote(&b, "10").ok();
    assert_eq!(
        (
            s(&q, "spentToday"),
            s(&q, "remainingToday"),
            s(&q, "withinDaily")
        ),
        ("25".to_owned(), "75".to_owned(), "true".to_owned())
    );
    b.sql(
        "DELETE FROM bank.personal_transfers WHERE transfer_id IN ('send-in-flight', 'send-stale')",
    );

    b.sql("UPDATE bank.personal_transfer_terms SET fee = 1.5 WHERE asset_id = 'USDT'");
    let q = quote(&b, "1").ok();
    assert_eq!(
        (s(&q, "fee"), s(&q, "feeBlocker")),
        (
            "1.5".to_owned(),
            "bank.personal_transfer_fee_unwired".to_owned()
        )
    );
    let before = b.ledger.keys().len();
    to_user(&b, ADA, &send_of("send-fee-blocked", &from, BOB, "1"))
        .refused("PRECONDITION_FAILED", "bank.personal_transfer_fee_unwired");
    assert_eq!(b.ledger.keys().len(), before);
}

#[test]
fn opens_lists_cancels_declines_reminds_and_settles_one_request_exactly_once() {
    let Some(b) = bank_with(pay_owner()) else {
        return;
    };
    b.ready(true);
    let opened = ask(&b, ADA, BOB, "12.5", Some("lunch"), "request-key-1").ok();
    for (k, v) in [
        ("payeeUserId", ADA),
        ("payerUserId", BOB),
        ("payeeHandle", "ada"),
        ("payerHandle", "bob"),
        ("amount", "12.5"),
        ("note", "lunch"),
        ("status", "open"),
        ("ledgerTxId", "null"),
    ] {
        assert_eq!(s(&opened, k), v, "{k}");
    }
    assert_eq!(
        opened.get("notice").unwrap().compact(),
        r#"{"delivered":true,"blocker":null}"#
    );
    let seqs = |b: &Bank| {
        b.bus
            .created()
            .iter()
            .map(|n| s(n, "sequence"))
            .collect::<Vec<_>>()
    };
    assert_eq!(seqs(&b), ["1"]);

    let replay = ask(&b, ADA, BOB, "12.5", Some("lunch"), "request-key-1").ok();
    assert_eq!(req_id(&replay), req_id(&opened));

    let list =
        |user: &str, input: &str| match call(&b, user, RW, "personalRequest.list", input).ok() {
            Json::Array(a) => a.len(),
            other => panic!("{}", other.compact()),
        };
    assert_eq!(
        list(
            BOB,
            r#"{"direction":"incoming","status":"open","limit":20}"#
        ),
        1
    );
    assert_eq!(list(ADA, r#"{"direction":"outgoing","limit":20}"#), 1);
    assert_eq!(s(&request_get(&b, BOB, &req_id(&opened)), "status"), "open");

    let to_cancel = ask(&b, ADA, BOB, "1", None, "request-key-cancel").ok();
    let cancel = |user: &str| {
        call(
            &b,
            user,
            RW,
            "personalRequest.cancel",
            &format!(r#"{{"requestId":"{}"}}"#, req_id(&to_cancel)),
        )
    };
    cancel(BOB).refused("FORBIDDEN", "bank.personal_request_not_payee");
    assert_eq!(s(&cancel(ADA).ok(), "status"), "cancelled");

    let to_decline = ask(&b, ADA, BOB, "1", None, "request-key-decline").ok();
    let declined = call(
        &b,
        BOB,
        RW,
        "personalRequest.decline",
        &format!(r#"{{"requestId":"{}"}}"#, req_id(&to_decline)),
    )
    .ok();
    assert_eq!(s(&declined, "status"), "declined");

    let reminded = call(
        &b,
        ADA,
        RW,
        "personalRequest.remind",
        &format!(
            r#"{{"requestId":"{}","idempotencyKey":"remind-key-1"}}"#,
            req_id(&opened)
        ),
    )
    .ok();
    assert_eq!(s(&reminded, "status"), "open");
    assert_eq!(seqs(&b), ["1", "1", "1", "2"]);

    let from = primary(&b, BOB);
    b.ledger.fund(BOB, "30");
    let pay = |id: &str| {
        to_user(
            &b,
            BOB,
            &with_field(
                &send_of(id, &from, ADA, "12.5"),
                "requestId",
                Json::str(req_id(&opened)),
            ),
        )
    };
    let paid = pay("pay-request-1").ok();
    let got = request_get(&b, ADA, &req_id(&opened));
    assert_eq!(s(&got, "status"), "paid");
    assert_eq!(s(&got, "ledgerTxId"), s(&paid, "ledgerTxId"));

    assert_eq!(pay("pay-request-2").trpc(), "CONFLICT");
    assert_eq!(
        b.ledger
            .keys()
            .iter()
            .filter(|k| k.starts_with("bank.transfer.p2p:pay-request-"))
            .count(),
        1
    );
}

#[test]
fn refuses_to_mark_a_request_paid_when_the_transfer_pays_the_payer_or_a_third_user() {
    let Some(b) = bank_with(pay_owner()) else {
        return;
    };
    b.ready(true);
    let opened = ask(&b, ADA, BOB, "12.5", None, "request-payee-mismatch").ok();
    b.ledger.fund(BOB, "40");
    let main = primary(&b, BOB);
    let named = pot(&b, BOB, "Spending");
    own_move(&b, BOB, "fund-bob-named-space", &main, &named, "20");
    let pots = |b: &Bank| (b.ledger.available(BOB), b.ledger.pot(&named));
    let before = pots(&b);

    for (id, to) in [("pay-request-to-self", BOB), ("pay-request-to-third", CY)] {
        if to == CY {
            primary(&b, CY);
        }
        to_user(
            &b,
            BOB,
            &with_field(
                &send_of(id, &named, to, "12.5"),
                "requestId",
                Json::str(req_id(&opened)),
            ),
        )
        .refused("CONFLICT", "bank.personal_request_payee_mismatch");
        let after = request_get(&b, ADA, &req_id(&opened));
        assert_eq!(s(&after, "status"), "open");
        assert_eq!(s(&after, "ledgerTxId"), "null");
        assert!(
            !b.ledger
                .keys()
                .contains(&format!("bank.transfer.p2p:{id}:0"))
        );
        assert_eq!(pots(&b), before);
    }
    assert_eq!(b.ledger.available(CY), "0");
}

#[test]
fn an_own_space_transfer_that_reuses_the_id_of_a_request_payment_books_separately_and_pays_the_request_itself()
 {
    let Some(b) = bank_with(pay_owner()) else {
        return;
    };
    b.ready(true);
    let opened = ask(&b, ADA, BOB, "12.5", None, "request-key-reuse").ok();
    b.ledger.fund(BOB, "40");
    let main = primary(&b, BOB);
    let named = pot(&b, BOB, "Spending");
    let own = own_move(&b, BOB, "own-space-key", &main, &named, "12.5");

    let paid = to_user(
        &b,
        BOB,
        &with_field(
            &send_of("own-space-key", &main, ADA, "12.5"),
            "requestId",
            Json::str(req_id(&opened)),
        ),
    )
    .ok();
    assert_ne!(s(&paid, "ledgerTxId"), s(&own, "ledgerTxId"));

    let request = request_get(&b, ADA, &req_id(&opened));
    assert_eq!(s(&request, "status"), "paid");
    assert_eq!(s(&request, "ledgerTxId"), s(&paid, "ledgerTxId"));
    let keys = b.ledger.keys();
    assert!(keys.contains(&"bank.transfer.own:own-space-key:0".to_owned()));
    assert!(keys.contains(&"bank.transfer.p2p:own-space-key:0".to_owned()));
    // `ledger.reconcile()`: nothing made or lost.
    assert_eq!(b.ledger.total(), "140");
}

#[test]
fn refuses_to_mark_a_request_paid_when_its_key_already_holds_a_different_movement() {
    let Some(b) = bank_with(pay_owner()) else {
        return;
    };
    b.ready(true);
    let opened = ask(&b, ADA, BOB, "12.5", None, "request-key-foreign").ok();
    b.ledger.fund(BOB, "40");
    let main = primary(&b, BOB);
    let named = pot(&b, BOB, "Spending");
    // Something else is booked under the very key this payment will use: an own-space move, in the p2p key space.
    let foreign = b.ledger.book(
        "bank.transfer.p2p:foreign-key-01:0",
        &space_of(&b, &main).ledger_account(),
        &space_of(&b, &named).ledger_account(),
        "12.5",
    );

    let refused = to_user(
        &b,
        BOB,
        &with_field(
            &send_of("foreign-key-01", &main, ADA, "12.5"),
            "requestId",
            Json::str(req_id(&opened)),
        ),
    );
    assert_ne!(refused.0, 200);
    assert!(
        refused
            .message()
            .contains("bank.personal_transfer_conflict")
            || refused.message().contains("idempotency_conflict"),
        "{}",
        refused.1.compact()
    );

    let request = request_get(&b, ADA, &req_id(&opened));
    assert_eq!(s(&request, "status"), "open");
    assert_eq!(s(&request, "ledgerTxId"), "null");
    assert_eq!(
        b.count("SELECT count(*) FROM bank.personal_transfers WHERE transfer_id = 'foreign-key-01' AND status = 'posted'"),
        0
    );
    // The key holds a movement that is not this send, so this send's outcome is unknown: the reservation stays.
    assert_eq!(
        b.count("SELECT count(*) FROM bank.personal_transfers WHERE transfer_id = 'foreign-key-01' AND status = 'reserved'"),
        1
    );
    call(
        &b,
        ADA,
        RW,
        "transfers.get",
        &format!(r#"{{"ledgerTxId":"{}"}}"#, foreign.id),
    )
    .refused("NOT_FOUND", "bank.personal_transfer_not_found");
}

#[test]
fn keeps_the_request_claim_when_the_ledger_reply_is_lost_and_resumes_the_same_transfer() {
    let Some(b) = bank_with(pay_owner()) else {
        return;
    };
    b.ready(true);
    let opened = ask(&b, ADA, BOB, "12.5", None, "request-lost-reply").ok();
    let rid = req_id(&opened);
    b.ledger.fund(BOB, "40");
    let main = primary(&b, BOB);
    let id = "lost-reply-send";
    // The post books and its answer is lost; the first lookup finds nothing yet.
    b.ledger.lose_reply(&format!("bank.transfer.p2p:{id}:"));
    b.ledger.hide(Some(&format!("bank.transfer.p2p:{id}:")));

    let err = b
        .svc(|d| service_send(d, BOB, id, &main, ADA, "12.5", Some(&rid)))
        .unwrap_err();
    assert!(!err.definite);
    assert!(
        matches!(&err.refusal, Refusal::Other(m) if m.contains("timeout")),
        "{:?}",
        err.refusal
    );

    assert_eq!(
        b.rows(&format!(
            "SELECT status FROM bank.personal_transfers WHERE transfer_id = '{id}'"
        )),
        [[Some("reserved".to_owned())]]
    );
    assert_eq!(
        b.rows(&format!(
            "SELECT claim_transfer_id, status, ledger_tx_id FROM bank.personal_requests WHERE id = '{rid}'"
        )),
        [[Some(id.to_owned()), Some("open".to_owned()), None]]
    );

    to_user(
        &b,
        BOB,
        &with_field(
            &send_of("lost-reply-new1", &main, ADA, "12.5"),
            "requestId",
            Json::str(rid.clone()),
        ),
    )
    .refused("CONFLICT", "bank.personal_request_claim_held");

    b.ledger.hide(None);
    let booked = b.ledger.tx(&format!("bank.transfer.p2p:{id}:0")).unwrap();
    let again = b
        .svc(|d| service_send(d, BOB, id, &main, ADA, "12.5", Some(&rid)))
        .unwrap();
    assert_eq!(posted_tx(&again), booked.id);
    let paid = request_get(&b, ADA, &rid);
    assert_eq!(s(&paid, "status"), "paid");
    assert_eq!(s(&paid, "ledgerTxId"), booked.id);
    assert_eq!(b.ledger.p2p().len(), 1);
}

#[test]
fn j_identity_14_2_the_posting_freeze_proved_not_posted_refuses_as_ledger_frozen_nothing_reserved_nothing_moved_and_a_send_after_the_freeze_posts_once()
 {
    let Some(b) = bank_with(pay_owner()) else {
        return;
    };
    let main = b.ready(true);
    let id = "frozen-send";
    // What the ledger answers under the freeze: one attempt, refused before anything is booked.
    b.ledger.poison(Some(("bank.transfer.p2p:frozen-", 1)));
    let before = b.ledger.available(ADA);

    let refused = b
        .svc(|d| service_send(d, ADA, id, &main, BOB, "5", None))
        .unwrap_err();
    assert!(refused.definite);
    assert_eq!(refused.code.as_deref(), Some("ledger.frozen"));
    // On the wire: a definite 412 with the ledger's code, never an unknown outcome or the book's internals.
    let wire = to_trpc(refused.refusal, String::new);
    assert_eq!(
        (wire.code, wire.message.as_str()),
        ("PRECONDITION_FAILED", "ledger.frozen")
    );
    assert_eq!(
        b.count(&format!(
            "SELECT count(*) FROM bank.personal_transfers WHERE transfer_id = '{id}'"
        )),
        0
    );
    assert_eq!(b.ledger.available(ADA), before);
    assert!(b.ledger.p2p().is_empty());

    // A freeze refusal that proves nothing (no single attempt) stays an unknown: the reservation is kept.
    b.ledger.poison(Some(("bank.transfer.p2p:frozen-", 2)));
    let unknown = b
        .svc(|d| service_send(d, ADA, "frozen-unproved", &main, BOB, "5", None))
        .unwrap_err();
    assert!(!unknown.definite);
    assert_eq!(
        to_trpc(unknown.refusal, String::new).code,
        "INTERNAL_SERVER_ERROR"
    );
    assert_eq!(
        b.rows("SELECT status FROM bank.personal_transfers WHERE transfer_id = 'frozen-unproved'"),
        [[Some("reserved".to_owned())]]
    );

    // The freeze lifts: the same send posts once.
    b.ledger.poison(None);
    let sent = b
        .svc(|d| service_send(d, ADA, id, &main, BOB, "5", None))
        .unwrap();
    assert!(matches!(sent, Sent::Posted(_)));
    assert_eq!(
        b.ledger
            .keys()
            .iter()
            .filter(|k| *k == &format!("bank.transfer.p2p:{id}:0"))
            .count(),
        1
    );
}

#[test]
fn refuses_a_session_that_lacks_the_procedure_scope() {
    let Some(b) = bank_with(pay_owner()) else {
        return;
    };
    let forbidden = |a: Answer| assert_eq!(a.trpc(), "FORBIDDEN", "{}", a.1.compact());
    forbidden(call(
        &b,
        ADA,
        READ,
        "transfers.toUser",
        &send_of(
            "send-no-scope",
            "55555555-5555-4555-8555-555555555555",
            BOB,
            "1",
        )
        .compact(),
    ));
    forbidden(call(
        &b,
        ADA,
        READ,
        "personalRequest.create",
        &format!(
            r#"{{"payerUserId":"{BOB}","assetId":"USDT","amount":"1","expiresAt":"{EXPIRES}","idempotencyKey":"request-no-scope"}}"#
        ),
    ));
    forbidden(call(
        &b,
        ADA,
        WRITE,
        "transfers.quote",
        r#"{"assetId":"USDT","amount":"1"}"#,
    ));
    forbidden(call(
        &b,
        ADA,
        WRITE,
        "transfers.get",
        r#"{"ledgerTxId":"missing"}"#,
    ));
}

#[test]
fn reminders_stop_at_the_owner_cap_in_the_window_name_the_next_allowed_time_and_a_retried_reminder_is_not_counted_twice()
 {
    let Some(b) = bank_with(pay_owner()) else {
        return;
    };
    b.ready(true);
    let opened = ask(&b, ADA, BOB, "3", None, "request-remind-cap").ok();
    let rid = req_id(&opened);
    let remind = |key: &str, when: &str| {
        b.with(&pay_owner(), Some(at(when)), |d| {
            requests::remind(d, ADA, &rid, key)
        })
    };
    let t0 = "2026-11-06T10:00:00.000Z";
    let t1 = "2026-11-06T11:00:00.000Z";
    let first = remind("remind-cap-1", t0).unwrap();
    assert_eq!(
        first.get("reminder").unwrap().compact(),
        r#"{"sentInWindow":1,"cap":2,"windowSeconds":86400,"nextAllowedAt":null}"#
    );
    // The same reminder asked again (a lost reply): the same one, not a second.
    let again = remind("remind-cap-1", t1).unwrap();
    assert_eq!(s(again.get("reminder").unwrap(), "sentInWindow"), "1");
    let second = remind("remind-cap-2", t1).unwrap();
    assert_eq!(
        second.get("reminder").unwrap().compact(),
        r#"{"sentInWindow":2,"cap":2,"windowSeconds":86400,"nextAllowedAt":"2026-11-07T10:00:00.000Z"}"#
    );
    let capped = remind("remind-cap-3", t1).unwrap_err();
    assert_eq!(code_of(&capped), "bank.personal_request_remind_capped");
    assert!(format!("{capped:?}").contains("2026-11-07T10:00:00.000Z"));
    let seqs: Vec<String> = b
        .bus
        .created()
        .iter()
        .filter(|n| s(n, "requestId") == rid)
        .map(|n| s(n, "sequence"))
        .collect();
    assert_eq!(seqs, ["1", "2", "3"]);
    // Once the first reminder leaves the window, one more may go.
    let later = remind("remind-cap-3", "2026-11-07T10:00:01.000Z").unwrap();
    assert_eq!(s(later.get("reminder").unwrap(), "sentInWindow"), "2");
    // Only the asker reads the count.
    let a = call(
        &b,
        BOB,
        RW,
        "personalRequest.reminders",
        &format!(r#"{{"requestId":"{rid}"}}"#),
    );
    assert!(
        a.message().contains("bank.personal_request_not_payee"),
        "{}",
        a.1.compact()
    );
}

#[test]
fn with_no_reminder_rule_published_a_reminder_refuses_bank_reminder_policy_unset_and_nothing_is_sent()
 {
    let Some(b) = bank_with(pay_owner()) else {
        return;
    };
    b.ready(true);
    let opened = ask(&b, ADA, BOB, "3", None, "request-remind-unset").ok();
    let rid = req_id(&opened);
    let unset = Owner {
        remind: None,
        ..pay_owner()
    };
    let refused = b
        .with(&unset, None, |d| {
            requests::remind(d, ADA, &rid, "remind-unset-1")
        })
        .unwrap_err();
    assert_eq!(code_of(&refused), "bank.reminder_policy_unset");
    assert_eq!(
        b.count(&format!(
            "SELECT count(*) FROM bank.personal_request_reminds WHERE request_id = '{rid}'"
        )),
        0
    );
}

#[test]
fn report_and_block_declined_one_case_the_block_active_the_asker_sees_only_declined_and_cannot_ask_again()
 {
    let Some(b) = bank_with(pay_owner()) else {
        return;
    };
    b.ready(true);
    let opened = ask(&b, ADA, BOB, "9", None, "request-report-1").ok();
    let rid = req_id(&opened);
    let report = || {
        call(
            &b,
            BOB,
            RW,
            "personalRequest.report",
            &format!(r#"{{"requestId":"{rid}","reason":"scam","block":true}}"#),
        )
        .ok()
    };
    let reported = report();
    assert_eq!(s(reported.get("request").unwrap(), "status"), "declined");
    let safety = reported.get("safety").unwrap();
    for (k, v) in [("reason", "scam"), ("state", "open"), ("blocked", "true")] {
        assert_eq!(s(safety, k), v, "{k}");
    }
    // A retried report is the same case.
    let again = report();
    assert_eq!(
        s(again.get("safety").unwrap(), "caseId"),
        s(safety, "caseId")
    );
    assert_eq!(
        b.rows(&format!(
            "SELECT key FROM bank.personal_request_reports WHERE request_id = '{rid}'"
        )),
        [[Some(format!("report:{rid}"))]]
    );
    assert_eq!(
        b.rows(&format!(
            "SELECT key FROM bank.personal_request_blocks WHERE user_id = '{BOB}'"
        )),
        [[Some(format!("block:{BOB}:{ADA}"))]]
    );
    let safety_of = |user: &str| {
        call(
            &b,
            user,
            RW,
            "personalRequest.safety",
            &format!(r#"{{"requestId":"{rid}"}}"#),
        )
    };
    assert_eq!(safety_of(BOB).ok().compact(), safety.compact());

    // The asker: Declined, and no word of a report or block.
    let seen = request_get(&b, ADA, &rid);
    assert_eq!(s(&seen, "status"), "declined");
    let Json::Object(fields) = &seen else {
        panic!()
    };
    let mut keys: Vec<&str> = fields.iter().map(|(k, _)| k.as_str()).collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        [
            "amount",
            "assetId",
            "createdAt",
            "expiresAt",
            "ledgerTxId",
            "note",
            "notice",
            "payeeHandle",
            "payeeUserId",
            "payerHandle",
            "payerUserId",
            "requestId",
            "status",
        ]
    );
    assert_eq!(
        seen.get("notice").unwrap().compact(),
        r#"{"delivered":true,"blocker":null}"#
    );
    let a = safety_of(ADA);
    assert!(
        a.message().contains("bank.personal_request_not_found"),
        "{}",
        a.1.compact()
    );
    let a = ask(&b, ADA, BOB, "1", None, "request-report-2");
    assert!(
        a.message().contains("bank.personal_request_unavailable"),
        "{}",
        a.1.compact()
    );
    assert!(b.ledger.p2p().is_empty());
}

#[test]
fn a_report_without_a_block_declines_and_files_the_case_the_asker_may_still_ask() {
    let Some(b) = bank_with(pay_owner()) else {
        return;
    };
    b.ready(true);
    let opened = ask(&b, ADA, BOB, "9", None, "request-report-noblock").ok();
    let reported = call(
        &b,
        BOB,
        RW,
        "personalRequest.report",
        &format!(
            r#"{{"requestId":"{}","reason":"spam","block":false}}"#,
            req_id(&opened)
        ),
    )
    .ok();
    assert_eq!(s(reported.get("request").unwrap(), "status"), "declined");
    assert_eq!(s(reported.get("safety").unwrap(), "blocked"), "false");
    let next = ask(&b, ADA, BOB, "1", None, "request-report-noblock-2").ok();
    assert_eq!(s(&next, "status"), "open");
    // The asker cannot report their own request.
    let a = call(
        &b,
        ADA,
        RW,
        "personalRequest.report",
        &format!(
            r#"{{"requestId":"{}","reason":"spam","block":false}}"#,
            req_id(&next)
        ),
    );
    assert!(
        a.message().contains("bank.personal_request_not_payer"),
        "{}",
        a.1.compact()
    );
}

#[test]
fn a_request_paid_under_its_own_key_twice_posts_once_and_answers_the_first_receipt() {
    let Some(b) = bank_with(pay_owner()) else {
        return;
    };
    b.ready(true);
    let opened = ask(&b, ADA, BOB, "12", None, "request-own-key").ok();
    let rid = req_id(&opened);
    let from = primary(&b, BOB);
    b.ledger.fund(BOB, "30");
    let pay = || {
        to_user(
            &b,
            BOB,
            &with_field(
                &send_of(&format!("request:{rid}"), &from, ADA, "12"),
                "requestId",
                Json::str(rid.clone()),
            ),
        )
        .ok()
    };
    let first = pay();
    let second = pay();
    assert_eq!(s(&second, "ledgerTxId"), s(&first, "ledgerTxId"));
    assert_eq!(
        b.ledger
            .keys()
            .iter()
            .filter(|k| **k == format!("bank.transfer.p2p:request:{rid}:0"))
            .count(),
        1
    );
    assert_eq!(b.ledger.available(BOB), "18");
    assert_eq!(s(&request_get(&b, ADA, &rid), "status"), "paid");
}

#[test]
fn a_blocked_asker_cannot_remind_about_another_open_request_and_an_expired_request_can_still_be_reported_and_blocked()
 {
    let Some(b) = bank_with(pay_owner()) else {
        return;
    };
    b.ready(true);
    let t0 = at("2026-11-06T10:00:00.000Z");
    let noon = at("2026-11-06T12:00:00.000Z");
    let create = |amount: &str, expires: &str, key: &str| {
        b.with(&pay_owner(), Some(t0), |d| {
            requests::create(
                d,
                &NewRequest {
                    payee_user_id: ADA,
                    payer_user_id: BOB,
                    asset_id: "USDT",
                    amount: amt(amount),
                    note: None,
                    expires_at: at(expires),
                    idempotency_key: key,
                },
            )
        })
        .unwrap()
    };
    let other = create("2", EXPIRES, "request-block-other");
    let short = create("3", "2026-11-06T11:00:00.000Z", "request-block-short");
    // Expired: reported as it stands, not declined, with the case and the block written.
    let reported = b
        .with(&pay_owner(), Some(noon), |d| {
            requests::report(d, BOB, &req_id(&short), "harassment", true)
        })
        .unwrap();
    assert_eq!(s(reported.get("request").unwrap(), "status"), "expired");
    let safety = reported.get("safety").unwrap();
    assert_eq!(
        (s(safety, "reason"), s(safety, "blocked")),
        ("harassment".to_owned(), "true".to_owned())
    );
    let refused = b
        .with(&pay_owner(), Some(noon), |d| {
            requests::remind(d, ADA, &req_id(&other), "remind-after-block")
        })
        .unwrap_err();
    assert_eq!(code_of(&refused), "bank.personal_request_unavailable");
    assert_eq!(
        b.count(&format!(
            "SELECT count(*) FROM bank.personal_request_reminds WHERE request_id = '{}'",
            req_id(&other)
        )),
        0
    );
    assert_eq!(s(&request_get(&b, BOB, &req_id(&other)), "status"), "open");
}

#[test]
fn a_reminder_whose_notice_could_not_go_out_does_not_use_up_the_window() {
    let Some(b) = bank_with(pay_owner()) else {
        return;
    };
    b.ready(true);
    let opened = ask(&b, ADA, BOB, "3", None, "request-remind-lost").ok();
    let rid = req_id(&opened);
    let when = at("2026-11-06T10:00:00.000Z");
    // A bank whose request notices fail, under a cap of one.
    let failing = Owner {
        remind: Some(r#"{"cap":1,"windowSeconds":86400}"#),
        ..pay_owner()
    };
    b.bus.fail(true);
    let lost = b
        .with(&failing, Some(when), |d| {
            requests::remind(d, ADA, &rid, "remind-lost-1")
        })
        .unwrap();
    b.bus.fail(false);
    assert_eq!(s(lost.get("notice").unwrap(), "delivered"), "false");
    assert_eq!(s(lost.get("reminder").unwrap(), "sentInWindow"), "0");
    let sent = b
        .with(&pay_owner(), Some(when), |d| {
            requests::remind(d, ADA, &rid, "remind-lost-2")
        })
        .unwrap();
    assert_eq!(s(sent.get("notice").unwrap(), "delivered"), "true");
    assert_eq!(s(sent.get("reminder").unwrap(), "sentInWindow"), "1");
}

// ===============================================================================================================
// send-review.db.test.ts

/// `held(id)`: the typed refusal that names the review.
fn held(a: &Answer, id: &str) {
    a.refused("PRECONDITION_FAILED", &format!("Payment {id} is in review"));
}

#[test]
fn holds_a_send_above_the_line_in_review_with_its_reason_class_nothing_taken_and_a_retry_answers_the_same()
 {
    let Some(b) = bank_with(review_owner()) else {
        return;
    };
    let from = b.ready(true);
    let send = with_field(
        &send_of("held-send-1", &from, BOB, "60"),
        "note",
        Json::str("Rent, TEST"),
    );
    held(&to_user(&b, ADA, &send), "held-send-1");
    held(&to_user(&b, ADA, &send), "held-send-1");
    let view = call(
        &b,
        ADA,
        RW,
        "transfers.held",
        r#"{"transferId":"held-send-1"}"#,
    )
    .ok();
    for (k, v) in [
        ("transferId", "held-send-1"),
        ("status", "in_review"),
        ("reasonClass", "amount_over_review_line"),
        ("amount", "60"),
        ("assetId", "USDT"),
        ("note", "Rent, TEST"),
        ("toHandle", "bob"),
        ("ledgerTxId", "null"),
        ("decidedAt", "null"),
    ] {
        assert_eq!(s(&view, k), v, "{k}");
    }
    // Invariant: a held send is an instruction, not money.
    assert!(b.ledger.p2p().is_empty());
    assert_eq!(b.ledger.available(ADA), "100");
    assert_eq!(b.ledger.available(BOB), "0");
    assert_eq!(b.count("SELECT count(*) FROM bank.personal_transfers"), 0);
    // The same id on different terms is a conflict, never a second held send.
    to_user(&b, ADA, &with_field(&send, "amount", Json::str("61")))
        .refused("CONFLICT", "bank.personal_transfer_conflict");
    // At or under the line goes now.
    to_user(&b, ADA, &send_of("small-send-1", &from, BOB, "50")).ok();
    assert_eq!(b.ledger.p2p().len(), 1);
    assert_eq!(b.ledger.available(BOB), "50");
}

/// J-pay-01 #6: a send whose partner answer was lost reads Confirming while the partner does not answer, and Completed
/// under the partner's one move once it does; the read never moves money, and the send's own retry answers that move.
#[test]
fn a_send_whose_partner_answer_was_lost_reads_confirming_until_the_partner_answers_then_completed_under_its_one_move()
 {
    let Some(b) = bank_with(pay_owner()) else {
        return;
    };
    let set = |user: &str, input: &str| call(&b, user, RW, "testPartner.set", input).ok();
    set(ADA, r#"{"custody":"off"}"#);
    set(BOB, r#"{"custody":"off"}"#);
    let from = primary(&b, ADA);
    primary(&b, BOB);
    b.sql(
        "INSERT INTO bank.personal_transfer_terms (asset_id, per_transfer_limit, daily_limit, fee) \
         VALUES ('USDT', 1000, 10000, 0)",
    );
    call(
        &b,
        ADA,
        RW,
        "testPartner.fund",
        r#"{"fundId":"fund-confirming-1","assetId":"USDT","amount":"100"}"#,
    )
    .ok();
    let send = with_field(
        &send_of("confirming-send-1", &from, BOB, "2"),
        "note",
        Json::str("Coffee, TEST"),
    );
    // The partner makes the move and its answer is lost: the bank keeps the send reserved.
    set(ADA, r#"{"nextReply":"lost"}"#);
    to_user(&b, ADA, &send).refused("SERVICE_UNAVAILABLE", "did not answer");
    let key = "bank.transfer.p2p:confirming-send-1:0";
    let partner = b.door.partner().partner.as_ref().unwrap();
    let made = partner.lock().book.by_key(key).cloned().unwrap();
    let read = |user: &str| {
        call(
            &b,
            user,
            READ,
            "transfers.sent",
            r#"{"transferId":"confirming-send-1"}"#,
        )
    };
    // While the partner does not answer, the bank cannot know: Confirming, with no reference and nothing posted.
    set(ADA, r#"{"down":true}"#);
    let confirming = read(ADA).ok();
    for (k, v) in [
        ("transferId", "confirming-send-1"),
        ("status", "confirming"),
        ("amount", "2"),
        ("assetId", "USDT"),
        ("note", "Coffee, TEST"),
        ("toHandle", "bob"),
        ("partnerMove", "null"),
        ("ledgerTxId", "null"),
        ("postedAt", "null"),
    ] {
        assert_eq!(s(&confirming, k), v, "{k}");
    }
    assert_eq!(
        b.count("SELECT count(*) FROM bank.personal_transfers WHERE status = 'reserved'"),
        1
    );
    // Only the sender reads it: the recipient and a stranger get the same not-found as a missing id.
    for who in [BOB, CY] {
        read(who).refused("NOT_FOUND", "bank.personal_transfer_not_found");
    }
    // The partner answers: the read adopts its one move under the send's key, and the send reads Completed.
    set(ADA, r#"{"down":false}"#);
    let completed = read(ADA).ok();
    assert_eq!(s(&completed, "status"), "completed");
    assert_eq!(
        completed.get("partnerMove").map(|m| s(m, "id")),
        Some(made.id.clone())
    );
    assert_ne!(s(&completed, "postedAt"), "null");
    assert_eq!(read(ADA).ok(), completed);
    // The send's own retry answers that move; the partner made exactly one, and the ledger posted nothing.
    let retried = to_user(&b, ADA, &send).ok();
    assert_eq!(
        retried.get("partnerMove").map(|m| s(m, "id")),
        Some(made.id.clone())
    );
    let moves = partner.lock().moves(
        ADA,
        &svc_bank::partner::MovesQuery {
            limit: 100,
            before: None,
            asset_id: None,
            pay_ins: false,
        },
    );
    assert_eq!(moves.iter().filter(|m| m.key == key).count(), 1);
    assert_eq!(
        b.count("SELECT count(*) FROM bank.personal_transfers WHERE status = 'posted'"),
        1
    );
    assert!(b.ledger.p2p().is_empty());
}

#[test]
fn only_the_sender_reads_a_held_send_anyone_else_gets_the_same_not_found_as_a_missing_id() {
    let Some(b) = bank_with(review_owner()) else {
        return;
    };
    let from = b.ready(true);
    held(
        &to_user(&b, ADA, &send_of("held-send-2", &from, BOB, "70")),
        "held-send-2",
    );
    for who in [BOB, CY] {
        call(
            &b,
            who,
            READ,
            "transfers.held",
            r#"{"transferId":"held-send-2"}"#,
        )
        .refused("NOT_FOUND", "bank.held_send_not_found");
    }
    assert_eq!(
        call(
            &b,
            ADA,
            RW,
            "transfers.held",
            r#"{"transferId":"no-such-send"}"#
        )
        .trpc(),
        "NOT_FOUND"
    );
}

#[test]
fn over_the_limits_is_refused_at_once_never_held() {
    let Some(b) = bank_with(review_owner()) else {
        return;
    };
    let from = b.ready(true);
    b.sql(
        "UPDATE bank.personal_transfer_terms SET per_transfer_limit = 55 WHERE asset_id = 'USDT'",
    );
    let a = to_user(&b, ADA, &send_of("held-send-3", &from, BOB, "60"));
    assert_ne!(a.0, 200);
    assert!(
        !a.message().contains("Payment held-send-3 is in review"),
        "{}",
        a.1.compact()
    );
    assert_eq!(
        b.count("SELECT count(*) FROM bank.personal_send_reviews"),
        0
    );
}

#[test]
fn an_operator_release_posts_it_once_under_its_own_id_a_repeat_changes_nothing_the_sender_then_reads_it_posted()
 {
    let Some(b) = bank_with(review_owner()) else {
        return;
    };
    let from = b.ready(true);
    let send = send_of("held-send-4", &from, BOB, "60");
    held(&to_user(&b, ADA, &send), "held-send-4");
    let released = b
        .svc(|d| personal::release_held(d, "held-send-4", "operator-1"))
        .unwrap();
    assert_eq!(released.status, "released");
    let tx = released.ledger_tx_id.clone().unwrap();
    let repeat = b
        .svc(|d| personal::release_held(d, "held-send-4", "operator-1"))
        .unwrap();
    assert_eq!(repeat.ledger_tx_id.as_deref(), Some(tx.as_str()));
    assert_eq!(b.ledger.p2p().len(), 1);
    assert_eq!(b.ledger.available(ADA), "40");
    assert_eq!(b.ledger.available(BOB), "60");
    // The sender's retry now answers the posted send, not a hold.
    assert_eq!(s(&to_user(&b, ADA, &send).ok(), "ledgerTxId"), tx);
    let refused = b
        .svc(|d| personal::reject_held(d, "held-send-4", "operator-1"))
        .unwrap_err();
    assert_eq!(code_of(&refused), "bank.held_send_decided");
}

#[test]
fn a_release_the_bank_refuses_goes_back_to_review_and_a_rejection_then_moves_nothing_and_answers_the_sender()
 {
    let Some(b) = bank_with(review_owner()) else {
        return;
    };
    let from = b.ready(true);
    let send = send_of("held-send-5", &from, BOB, "60");
    held(&to_user(&b, ADA, &send), "held-send-5");
    // Meanwhile the owner lowers the per-payment limit below it: the release is refused by the bank's own terms, a
    // refusal that proves nothing posted, so the held send goes back to review.
    b.sql(
        "UPDATE bank.personal_transfer_terms SET per_transfer_limit = 55 WHERE asset_id = 'USDT'",
    );
    let refused = b
        .svc(|d| personal::release_held(d, "held-send-5", "operator-1"))
        .unwrap_err();
    assert!(
        code_of(&refused).contains("bank.personal_transfer"),
        "{refused:?}"
    );
    assert_eq!(
        b.rows("SELECT status, decided_by FROM bank.personal_send_reviews WHERE transfer_id = 'held-send-5'"),
        [[Some("in_review".to_owned()), None]]
    );
    assert_eq!(
        s(
            &call(
                &b,
                ADA,
                RW,
                "transfers.held",
                r#"{"transferId":"held-send-5"}"#
            )
            .ok(),
            "status"
        ),
        "in_review"
    );
    assert_eq!(b.ledger.available(ADA), "100");

    let rejected = b
        .svc(|d| personal::reject_held(d, "held-send-5", "operator-1"))
        .unwrap();
    assert_eq!(rejected.status, "rejected");
    assert_eq!(rejected.ledger_tx_id, None);
    assert!(rejected.decided_at.is_some());
    assert_eq!(
        b.svc(|d| personal::reject_held(d, "held-send-5", "operator-1"))
            .unwrap()
            .status,
        "rejected"
    );
    to_user(&b, ADA, &send).refused("PRECONDITION_FAILED", "bank.personal_send_rejected");
    assert!(b.ledger.p2p().is_empty());
    assert_eq!(b.ledger.available(ADA), "100");
    assert_eq!(b.ledger.available(BOB), "0");
}

#[test]
fn a_release_whose_outcome_is_not_proven_stays_releasing_and_a_reject_never_lands_on_it() {
    let Some(b) = bank_with(review_owner()) else {
        return;
    };
    let from = b.ready(true);
    held(
        &to_user(&b, ADA, &send_of("held-send-6", &from, BOB, "60")),
        "held-send-6",
    );
    // Ada spends most of it on a send under the line. The test ledger's refusal carries no proof that the post did not
    // commit, so the release's outcome is unknown: it stays releasing.
    to_user(&b, ADA, &send_of("small-send-6", &from, CY, "45")).ok();
    assert!(
        b.svc(|d| personal::release_held(d, "held-send-6", "operator-1"))
            .is_err()
    );
    assert_eq!(
        b.rows("SELECT status FROM bank.personal_send_reviews WHERE transfer_id = 'held-send-6'"),
        [[Some("releasing".to_owned())]]
    );
    assert_eq!(
        s(
            &call(
                &b,
                ADA,
                RW,
                "transfers.held",
                r#"{"transferId":"held-send-6"}"#
            )
            .ok(),
            "status"
        ),
        "in_review"
    );
    let refused = b
        .svc(|d| personal::reject_held(d, "held-send-6", "operator-1"))
        .unwrap_err();
    assert_eq!(code_of(&refused), "bank.held_send_decided");
    assert_eq!(b.ledger.p2p().len(), 1);
    assert_eq!(b.ledger.available(ADA), "55");
    assert_eq!(b.ledger.available(BOB), "0");
}

#[test]
fn no_other_door_pays_another_person_above_the_line_a_transfer_to_their_space_and_a_scheduled_send_refuse_nothing_moves()
 {
    let Some(b) = bank_with(review_owner()) else {
        return;
    };
    let from = b.ready(true);
    let bobs = primary(&b, BOB);
    let starts = service_kit::time::Instant(door::system_now().0 + 60_000).iso();
    let create = |id: &str, to: &str| {
        call(
            &b,
            ADA,
            RW,
            "transfers.create",
            &format!(
                r#"{{"transferId":"{id}","fromSpaceId":"{from}","toSpaceId":"{to}","amount":"60"}}"#
            ),
        )
    };
    let schedule = |id: &str, amount: &str| {
        call(
            &b,
            ADA,
            RW,
            "transfers.scheduleToUser",
            &format!(
                r#"{{"scheduleId":"{id}","fromSpaceId":"{from}","toUserId":"{BOB}","amount":"{amount}","cadence":"once","startsAt":"{starts}"}}"#
            ),
        )
    };
    let door_refusal = "bank.personal_send_review_door";
    create("door-create-1", &bobs).refused("PRECONDITION_FAILED", door_refusal);
    schedule("55555555-5555-4555-8555-555555555555", "60")
        .refused("PRECONDITION_FAILED", door_refusal);
    // An unknown destination counts as another person's.
    create("door-create-2", "66666666-6666-4666-8666-666666666666")
        .refused("PRECONDITION_FAILED", door_refusal);
    assert_eq!(b.ledger.available(ADA), "100");
    assert_eq!(b.ledger.available(BOB), "0");
    // At the line, the same doors are open as before.
    schedule("77777777-7777-4777-8777-777777777777", "50").ok();
}

// ===============================================================================================================
// bank-service.test.ts: transferToUser

#[test]
fn refuses_user_to_user_transfer_when_dest_user_is_missing_nothing_posted() {
    let Some(b) = bank_with(pay_owner()) else {
        return;
    };
    let a = primary(&b, ADA);
    b.ledger.fund(ADA, "50");
    let before = b.ledger.keys();
    let refused = b
        .svc(|d| moves::transfer_to_user(d, "user-transfer-missing", &a, NO_SUCH_USER, amt("10")))
        .unwrap_err();
    assert_eq!(code_of(&refused), "bank.recipient_cannot_receive");
    assert_eq!(b.ledger.keys(), before);
    assert_eq!(b.ledger.available(ADA), "50");
    assert_eq!(
        b.count(&format!(
            "SELECT count(*) FROM bank.spaces WHERE user_id = '{NO_SUCH_USER}'"
        )),
        0
    );
}

#[test]
fn pays_a_member_who_has_never_held_the_asset_their_main_account_opens_on_the_first_credit_once() {
    let Some(b) = bank_with(pay_owner()) else {
        return;
    };
    let a = primary(&b, ADA);
    b.ledger.fund(ADA, "50");
    assert_eq!(
        b.count(&format!(
            "SELECT count(*) FROM bank.spaces WHERE user_id = '{BOB}' AND kind = 'primary'"
        )),
        0
    );
    let send = |b: &Bank| {
        b.svc(|d| moves::transfer_to_user(d, "user-transfer-first-credit", &a, BOB, amt("20")))
            .unwrap()
    };
    let first = send(&b);
    let again = send(&b);
    assert_eq!(again.ledger_tx_id(), first.ledger_tx_id());
    assert_eq!(b.ledger.available(ADA), "30");
    assert_eq!(b.ledger.available(BOB), "20");
    assert_eq!(
        b.count(&format!(
            "SELECT count(*) FROM bank.spaces WHERE user_id = '{BOB}' AND kind = 'primary'"
        )),
        1
    );
    assert_eq!(b.ledger.total(), "50");
}

#[test]
fn transfers_to_the_dest_user_through_ledger_client() {
    let Some(b) = bank_with(pay_owner()) else {
        return;
    };
    let a = primary(&b, ADA);
    primary(&b, BOB);
    b.ledger.fund(ADA, "25");
    let moved = b
        .svc(|d| moves::transfer_to_user(d, "user-transfer-stored", &a, BOB, amt("25")))
        .unwrap();
    assert_eq!(format_amount(moved.amount), "25");
    assert!(moved.ledger_tx_id().is_some_and(|t| !t.is_empty()));
    assert!(
        b.ledger
            .keys()
            .iter()
            .any(|k| k.contains("user-transfer-stored"))
    );
    assert_eq!(b.ledger.available(ADA), "0");
    assert_eq!(b.ledger.available(BOB), "25");
    assert_eq!(b.ledger.total(), "25");
}
