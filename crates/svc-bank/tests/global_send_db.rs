//! Slice `global`'s international sends against the Rust door on a real Postgres. Ports the global-send tests of the
//! TypeScript's `personal-pay/personal-pay.db.test.ts` (from "refuses corridors, quotes and sends while those ports are
//! blank" through the describe "when the payout rail refuses or its answer is lost"), each test named after the
//! TypeScript test's words. A call through the TypeScript router is a door call here (tRPC path `global.*`); the one
//! direct call on the module (`reverseFromRail`) is the Rust function it became, given the same dependencies the door
//! gives it.
//!
//! As in the TypeScript, one test's banks share its database (each `mount` is a fresh door, book and set of ports over
//! the same tables), and the caller takes a rate lock for a send that names none, once per idempotency key, as the Pay
//! card does (`caller` in the TypeScript).
//!
//! The ledger is a stand-in that books `bankTransfer` as svc-ledger does (one credit on the payer, one debit on the
//! payee, once per key) and refuses too little money as the TypeScript's `MemoryLedger` does. A test may hook each post
//! before it is booked (a ledger that is away) and after (a lost answer, or something that lands while it posts), as the
//! TypeScript wraps `ledger.post`. The custodial layer is on (`custody_layer`), so the sends post, as they do on the
//! TypeScript's memory ledger. Without `TEST_DATABASE_URL` each test skips; with `REQUIRE_POSTGRES=1` it fails.
//!
//! Not ported as written:
//! - `cause.blocker` on a refusal: the Rust door's wire carries only `cause.code` (`service_kit::trpc`), so the blocker
//!   is checked in the refusal's message (which the TypeScript also checks) and in the code's row
//!   (`refusals::blocker`).
//! - `cause.message` on `bank.reference_too_long`: the wire's `error.message` is that sentence, and is checked instead.
//! - `seededOther()`: a second bank over the same tables is a second door over the same database here.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::too_many_lines,
    reason = "a test: a failure is the point"
)]

use crate::support;

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use postgres::{Client, NoTls};
use service_kit::edge;
use service_kit::json::{self, Json};
use service_kit::money::{Amount, format_amount, parse_amount};
use service_kit::s2s_verify::BodyBind;
use service_kit::server::Request;
use svc_bank::door::{self, BankDoor, DoorConfig, Kind, ServiceAuth};
use svc_bank::global::ports::{
    BicHit, Corridor, EmptyPorts, FxQuote, GlobalPorts, Live, Payout, PayoutAnswer,
    TravelRuleDecision,
};
use svc_bank::global::refusals;
use svc_bank::global::send::{self as gsend, forward_key, reverse_key};
use svc_bank::global::{Deps as GlobalDeps, Settings as GlobalSettings, Wiring as GlobalWiring};
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

use support::TestDb;

const SECRET: &str = "a-bank-global-send-db-edge-secret-long-ok";
const INTERNAL: &str = "a-bank-global-send-db-internal-secret-ok";
const USER: &str = "11111111-1111-4111-8111-111111111111";
const OTHER: &str = "22222222-2222-4222-8222-222222222222";
const SID: &str = "77777777-7777-4777-8777-777777777777";
const OP_A: &str = "33333333-3333-4333-8333-333333333333";
const OP_B: &str = "44444444-4444-4444-8444-444444444444";
const WRITE: &[&str] = &["bank:read", "bank:write"];
const COMPLIANCE: &[&str] = &["admin:read", "admin:compliance"];
const FOUNDER: &[&str] = &["admin:read"];

const RULES: &str = r#"{"reference":[{"deliveryMethod":"bank","maxLength":18},{"deliveryMethod":"bank","country":"DE","maxLength":12}],"purposeRequired":["INR"],"sourceOfFunds":[{"asset":"USDT","threshold":"50"}]}"#;
const PAYEE_OK: &str = r#"{"blockedAccounts":[]}"#;
const ALLOWANCE_NONE: &str = r#"{"exchangeAccounts":[],"windowDays":30,"limits":[]}"#;
const PROOF_LIMITS: &str = r#"{"allowedTypes":["application/pdf"],"maxBytes":64}"#;
const PSP: &str = "socket.psp-partners";

fn amt(s: &str) -> Amount {
    parse_amount(s).unwrap()
}

// ---------------------------------------------------------------------------------------------------------------
// The ledger stand-in

type Acct = (String, String, String, String);

/// A hook on each post: its number (from 1), its key, and whether it is already booked. An error is the ledger's.
type Hook = Arc<dyn Fn(u32, &str, bool) -> Result<(), PostFailure> + Send + Sync>;

#[derive(Default)]
struct BookState {
    balances: BTreeMap<Acct, Amount>,
    journal: Vec<(String, LedgerTx)>,
    calls: u32,
}

#[derive(Clone, Default)]
struct Book {
    st: Arc<Mutex<BookState>>,
    hook: Arc<Mutex<Option<Hook>>>,
}

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
    /// `recipes.deposit` of `amount` USDT to the person.
    fn fund(&self, user: &str, amount: &str) {
        let key = (
            "user".to_owned(),
            user.to_owned(),
            "USDT".to_owned(),
            "available".to_owned(),
        );
        *self.st.lock().unwrap().balances.entry(key).or_default() += amt(amount);
    }
    /// `ledger.balance(userAvailable(user, 'USDT')).amount`.
    fn available(&self, user: &str) -> String {
        let key = (
            "user".to_owned(),
            user.to_owned(),
            "USDT".to_owned(),
            "available".to_owned(),
        );
        format_amount(
            self.st
                .lock()
                .unwrap()
                .balances
                .get(&key)
                .copied()
                .unwrap_or(0),
        )
    }
    /// `transfers(ledger)`: the rail posts (`reason === 'bank.transfer.manual'` on the memory ledger), by key.
    fn rail(&self) -> Vec<String> {
        self.st
            .lock()
            .unwrap()
            .journal
            .iter()
            .map(|(k, _)| k.clone())
            .filter(|k| k.starts_with("bank.transfer.rail:"))
            .collect()
    }
    fn set_hook(&self, hook: Option<Hook>) {
        *self.hook.lock().unwrap() = hook;
    }
}

impl Ledger for Book {
    fn balance(&self, a: &LedgerAccount) -> Result<Amount, String> {
        Ok(self
            .st
            .lock()
            .unwrap()
            .balances
            .get(&acct(a))
            .copied()
            .unwrap_or(0))
    }
    fn balances(&self, owner_type: &str, owner: &str) -> Result<Vec<LedgerBalance>, String> {
        Ok(self
            .st
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
            .st
            .lock()
            .unwrap()
            .journal
            .iter()
            .find(|(_, t)| t.id == tx_id)
            .map(|(_, t)| t.clone()))
    }
    fn tx_by_key(&self, key: &str) -> Result<Option<LedgerTx>, String> {
        Ok(self
            .st
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
        let n = {
            let mut st = self.st.lock().unwrap();
            st.calls += 1;
            st.calls
        };
        let hook = self.hook.lock().unwrap().clone();
        if let Some(h) = &hook {
            h(n, key, false)?;
        }
        let tx = {
            let mut st = self.st.lock().unwrap();
            if let Some((_, t)) = st.journal.iter().find(|(k, _)| k == key) {
                t.clone()
            } else {
                let from = acct_of(input.get("from").unwrap());
                let to = acct_of(input.get("to").unwrap());
                let amount = match input.get("amount") {
                    Some(Json::String(a)) => amt(a),
                    other => panic!("amount: {other:?}"),
                };
                let held = st.balances.get(&from).copied().unwrap_or(0);
                // A boundary account may go negative, as svc-ledger's treasury accounts may; a person's may not.
                if from.0 == "user" && held < amount {
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
                tx
            }
        };
        if let Some(h) = &hook {
            h(n, key, true)?;
        }
        Ok(tx)
    }
}

fn away() -> PostFailure {
    PostFailure::Unknown("ledger away".to_owned())
}

// ---------------------------------------------------------------------------------------------------------------
// The ports stand-in (`liveGlobal` and its variants)

#[derive(Clone)]
enum Reply {
    Answer(PayoutAnswer),
    Lost,
}

#[derive(Clone)]
struct Ports {
    fx_live: bool,
    payout_live: bool,
    travel_rule: bool,
    /// The provider's rate now; its receive amount is `71.41` at `7.25`, else `89.10`.
    rate: Arc<Mutex<String>>,
    rail: Arc<Mutex<String>>,
    /// `scriptedPayout`: each payout takes the next answer, and none left is a lost reply. `None`: every payout is `fixed`.
    script: Arc<Mutex<Option<VecDeque<Reply>>>>,
    fixed: PayoutAnswer,
    /// Every payout asked for, in order.
    seen: Arc<Mutex<Vec<Payout>>>,
}

fn accepted(provider_ref: &str, status: &str) -> PayoutAnswer {
    PayoutAnswer::Accepted {
        provider_ref: provider_ref.to_owned(),
        status: status.to_owned(),
    }
}

/// `liveGlobal()`.
fn live_global() -> Ports {
    Ports {
        fx_live: true,
        payout_live: true,
        travel_rule: true,
        rate: Arc::new(Mutex::new("7.25".to_owned())),
        rail: Arc::new(Mutex::new("test-payout-rail".to_owned())),
        script: Arc::new(Mutex::new(None)),
        fixed: accepted("payout-1", "sent"),
        seen: Arc::new(Mutex::new(Vec::new())),
    }
}

impl Ports {
    fn paying(mut self, provider_ref: &str) -> Ports {
        self.fixed = accepted(provider_ref, "sent");
        self
    }
    fn scripted(self, replies: Vec<Reply>) -> Ports {
        *self.script.lock().unwrap() = Some(replies.into());
        self
    }
    /// `payout: { status: () => 'unset', railId: () => '', submit: async () => ({ ok: false }) }`.
    fn payout_unset(mut self) -> Ports {
        self.payout_live = false;
        self
    }
    fn calls(&self) -> usize {
        self.seen.lock().unwrap().len()
    }
}

fn corridor(currency: &str) -> Corridor {
    Corridor {
        country: "DE".to_owned(),
        currency: currency.to_owned(),
        delivery_methods: vec!["bank".to_owned()],
        min_amount: Some("1.00".to_owned()),
        max_amount: None,
        cut_off_time: Some("16:00 Europe/Berlin".to_owned()),
        swift_charges: None,
    }
}

impl GlobalPorts for Ports {
    fn corridors_live(&self) -> Live {
        true
    }
    fn corridors(&self) -> Result<Vec<Corridor>, String> {
        // TEST corridor INR so the purpose rule can be reached for a currency the owner's table names.
        Ok(vec![corridor("EUR"), corridor("INR")])
    }
    fn bic_live(&self) -> Live {
        true
    }
    fn bic_lookup(&self, bic: &str) -> Result<Option<BicHit>, String> {
        Ok((bic == "DEUTDEFF").then(|| BicHit {
            bic: bic.to_owned(),
            bank_name: "TEST BANK".to_owned(),
        }))
    }
    fn fx_live(&self) -> Live {
        self.fx_live
    }
    fn fx_quote(&self, _: &str, _: &str, _: &str) -> Result<FxQuote, String> {
        let rate = self.rate.lock().unwrap().clone();
        let receive = if rate == "7.25" { "71.41" } else { "89.10" };
        Ok(FxQuote {
            rate,
            fee: "1.10".to_owned(),
            fee_asset: "USDT".to_owned(),
            receive_amount: receive.to_owned(),
            valid_until: "2099-01-01T00:00:00.000Z".to_owned(),
            eta: "2099-01-02T00:00:00.000Z".to_owned(),
        })
    }
    fn payout_live(&self) -> Live {
        self.payout_live
    }
    fn payout_rail_id(&self) -> Result<String, String> {
        Ok(if self.payout_live {
            self.rail.lock().unwrap().clone()
        } else {
            String::new()
        })
    }
    fn payout_submit(&self, payout: &Payout) -> Result<PayoutAnswer, String> {
        self.seen.lock().unwrap().push(payout.clone());
        if !self.payout_live {
            return Ok(PayoutAnswer::Refused);
        }
        match self.script.lock().unwrap().as_mut() {
            None => Ok(self.fixed.clone()),
            Some(replies) => match replies.pop_front() {
                Some(Reply::Answer(a)) => Ok(a),
                Some(Reply::Lost) | None => Err("payout reply lost".to_owned()),
            },
        }
    }
    fn travel_rule(&self) -> Option<TravelRuleDecision> {
        self.travel_rule.then(|| TravelRuleDecision {
            decided_by: "test-fixture".to_owned(),
            required_fields: vec!["originatorName".to_owned()],
        })
    }
}

// ---------------------------------------------------------------------------------------------------------------
// The other stand-ins the door needs

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
// `mount`: one bank over the test's tables

/// `mount(options)`: the owner values and ports; payee controls and the exchange allowance default to published and
/// empty, as the TypeScript's do (`null` there is `None` here).
struct Mount {
    global: Option<Ports>,
    send_field_rules: Option<String>,
    payee_controls: Option<String>,
    exchange_allowance: Option<String>,
    proof_limits: Option<String>,
    refund_fee: Option<String>,
}

impl Default for Mount {
    fn default() -> Mount {
        Mount {
            global: None,
            send_field_rules: None,
            payee_controls: Some(PAYEE_OK.to_owned()),
            exchange_allowance: Some(ALLOWANCE_NONE.to_owned()),
            proof_limits: None,
            refund_fee: None,
        }
    }
}

/// `{ sendFieldRules: RULES, global }`.
fn ruled(ports: Ports) -> Mount {
    Mount {
        global: Some(ports),
        send_field_rules: Some(RULES.to_owned()),
        ..Mount::default()
    }
}

struct Bank {
    door: Arc<BankDoor>,
    ledger: Book,
    url: String,
    /// The caller's rate locks, by idempotency key (`caller`'s `locks`).
    locks: Arc<Mutex<HashMap<String, Option<String>>>>,
}

fn env() -> Option<TestDb> {
    let db = TestDb::new()?;
    db.migrated();
    Some(db)
}

fn mount(db: &TestDb, m: Mount) -> Bank {
    let ledger = Book::default();
    let env: BTreeMap<String, String> = [("APP_ENV", "test"), ("NODE_ENV", "test")]
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect();
    let ports: Box<dyn GlobalPorts> = match m.global {
        Some(p) => Box::new(p),
        None => Box::new(EmptyPorts),
    };
    let door = BankDoor::new(DoorConfig {
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
    .with_partner(PartnerWiring {
        partner: Some(TestPartner::new().unwrap()),
        freeze: Box::new(Open),
        custody_layer: "on".to_owned(),
        cash_legs: None,
        pay_in: None,
    })
    .with_spaces(SpacesWiring {
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
    })
    .with_global(GlobalWiring {
        ports,
        settings: GlobalSettings {
            send_field_rules: m.send_field_rules,
            payee_controls: m.payee_controls,
            exchange_allowance: m.exchange_allowance,
            proof_limits: m.proof_limits,
            hold_cancel_hours: None,
            refund_fee: m.refund_fee,
            receipt_secret: None,
        },
    });
    Bank {
        door: Arc::new(door),
        ledger,
        url: db.url.clone(),
        locks: Arc::default(),
    }
}

impl Bank {
    fn sql(&self) -> Client {
        Client::connect(&self.url, NoTls).unwrap()
    }
    /// `funded`: 100 USDT deposited, and the person's main space.
    fn funded(&self, user: &str) -> String {
        self.ledger.fund(user, "100");
        space::with(self.door.store(), |c| {
            space::ensure_primary(c, user, "USDT")
        })
        .unwrap()
        .id
    }
    fn balance(&self) -> String {
        self.ledger.available(USER)
    }
    fn ids(&self) -> Vec<String> {
        self.sql()
            .query("SELECT id::text FROM bank.global_sends", &[])
            .unwrap()
            .iter()
            .map(|r| r.get(0))
            .collect()
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Calls through the door

fn person(user: &str, scopes: &[&str]) -> Vec<(String, String)> {
    let raw = Json::obj([
        ("sub", Json::str(user)),
        (
            "scopes",
            Json::Array(scopes.iter().map(|s| Json::str(*s)).collect()),
        ),
        ("tier", Json::str("full")),
        ("mfa", Json::Bool(true)),
        ("sid", Json::str(SID)),
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
    /// The refusal's own code (`cause.code`), `ok`, or `none` for a refusal with no code.
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
            _ => "none".to_owned(),
        }
    }
    fn message(&self) -> String {
        match self.1.get("error").and_then(|e| e.get("message")) {
            Some(Json::String(m)) => m.clone(),
            _ => String::new(),
        }
    }
    /// `rejects.toMatchObject({ cause: { code } })`.
    fn refused(&self, code: &str) {
        assert_eq!(self.code(), code, "{}", self.1.compact());
    }
    /// `rejects.toBeTruthy()`.
    fn rejected(&self) {
        assert_ne!(self.0, 200, "{}", self.1.compact());
    }
}

fn call(b: &Bank, user: &str, scopes: &[&str], path: &str, input: &Json) -> Answer {
    call_door(&b.door, user, scopes, path, input)
}

fn call_door(d: &BankDoor, user: &str, scopes: &[&str], path: &str, input: &Json) -> Answer {
    let input = input.compact();
    let kind = door::call(path).map(|c| c.kind);
    let (method, url, body) = match kind {
        Some(Kind::Query) => (
            "GET",
            format!("/trpc/{path}?input={}", encode(&input)),
            String::new(),
        ),
        _ => ("POST", format!("/trpc/{path}"), input),
    };
    let mut headers = person(user, scopes);
    headers.push(("content-type".to_owned(), "application/json".to_owned()));
    let res = d.handle_from(
        &Request {
            method,
            url: &url,
            headers: &headers,
            body: &body,
        },
        "req-global-send-db",
        "127.0.0.1",
    );
    Answer(res.status, json::parse(&res.body).unwrap())
}

fn j(text: &str) -> Json {
    json::parse(text).unwrap()
}

fn with_field(v: &Json, k: &str, x: Json) -> Json {
    let Json::Object(mut f) = v.clone() else {
        panic!("not an object: {}", v.compact())
    };
    f.retain(|(key, _)| key != k);
    f.push((k.to_owned(), x));
    Json::Object(f)
}

fn s(v: &Json, key: &str) -> String {
    match v.get(key) {
        Some(Json::String(x)) => x.clone(),
        Some(Json::Null) | None => "null".to_owned(),
        Some(other) => other.compact(),
    }
}

/// `toMatchObject`: every field `expected` names, with the same value (objects recursively, arrays item by item).
fn subset(actual: &Json, expected: &Json) -> bool {
    match (actual, expected) {
        (Json::Object(_), Json::Object(want)) => want
            .iter()
            .all(|(k, w)| actual.get(k).is_some_and(|a| subset(a, w))),
        (Json::Array(a), Json::Array(w)) => {
            a.len() == w.len() && a.iter().zip(w).all(|(x, y)| subset(x, y))
        }
        (a, w) => a == w,
    }
}

fn has(actual: &Json, expected: &str) {
    assert!(
        subset(actual, &j(expected)),
        "{} does not match {expected}",
        actual.compact()
    );
}

/// `toEqual`: the same fields and values, in any key order.
fn same(actual: &Json, expected: &str) {
    let e = j(expected);
    assert!(
        subset(actual, &e) && subset(&e, actual),
        "{} is not {expected}",
        actual.compact()
    );
}

/// `caller(...).global.send`: a send that names no `quoteId` takes one quote for its amount and currency, once per
/// idempotency key, so a replay carries the same lock; while the rate source refuses, it goes without one.
fn send(b: &Bank, user: &str, body: &Json) -> Answer {
    if body.get("quoteId").is_some() {
        return call(b, user, WRITE, "global.send", body);
    }
    let key = s(body, "idempotencyKey");
    let known = b.locks.lock().unwrap().get(&key).cloned();
    let lock = match known {
        Some(lock) => lock,
        None => {
            let asset = space::with(b.door.store(), |c| space::get(c, &s(body, "fromSpaceId")))
                .map_or_else(|_| "USDT".to_owned(), |sp| sp.asset_id);
            let quote = call(
                b,
                user,
                WRITE,
                "global.quote",
                &Json::obj([
                    ("asset", Json::str(asset)),
                    ("amount", body.get("amount").unwrap().clone()),
                    ("toCurrency", body.get("toCurrency").unwrap().clone()),
                ]),
            );
            let lock = (quote.0 == 200).then(|| s(&quote.ok(), "quoteId"));
            b.locks.lock().unwrap().insert(key, lock.clone());
            lock
        }
    };
    let body = match lock {
        Some(q) => with_field(body, "quoteId", Json::str(q)),
        None => body.clone(),
    };
    call(b, user, WRITE, "global.send", &body)
}

/// `global.recipients.add` as the person.
fn add(b: &Bank, user: &str, key: &str, name: &str, account: &str) -> Json {
    call(
        b,
        user,
        WRITE,
        "global.recipients.add",
        &Json::obj([
            ("idempotencyKey", Json::str(key)),
            ("name", Json::str(name)),
            ("account", Json::str(account)),
            ("country", Json::str("DE")),
        ]),
    )
    .ok()
}

/// `{ ...sendBody, idempotencyKey, amount, fromSpaceId, recipientId }`.
fn send_body(key: &str, amount: &str, space: &str, recipient: &str) -> Json {
    Json::obj([
        ("toCurrency", Json::str("EUR")),
        ("country", Json::str("DE")),
        ("deliveryMethod", Json::str("bank")),
        ("compliance", j(r#"{"originatorName":"Ada"}"#)),
        ("idempotencyKey", Json::str(key)),
        ("amount", Json::str(amount)),
        ("fromSpaceId", Json::str(space)),
        ("recipientId", Json::str(recipient)),
    ])
}

fn uuid() -> String {
    service_kit::approvals::random_uuid().unwrap()
}

fn id_of(v: &Json) -> String {
    s(v, "id")
}

fn with_id(id: &str) -> Json {
    Json::obj([("id", Json::str(id))])
}

fn with_send(id: &str) -> Json {
    Json::obj([("sendId", Json::str(id))])
}

// ---------------------------------------------------------------------------------------------------------------
// Blank ports, the owner's tables, and one send

#[test]
fn refuses_corridors_quotes_and_sends_while_those_ports_are_blank() {
    let Some(db) = env() else { return };
    let b = mount(&db, Mount::default());
    let space = b.funded(USER);
    let corridors = call(&b, USER, WRITE, "global.corridors.list", &Json::Null);
    corridors.refused("bank.global_corridors_unset");
    assert!(corridors.message().contains(PSP), "{}", corridors.message());
    assert_eq!(refusals::blocker("bank.global_corridors_unset"), Some(PSP));
    let quote = call(
        &b,
        USER,
        WRITE,
        "global.quote",
        &j(r#"{"asset":"USDT","amount":"10","toCurrency":"EUR"}"#),
    );
    quote.refused("bank.global_fx_unset");
    // `message: expect.not.stringMatching(/\d+\.\d+/)`: no figure is made up.
    let m = quote.message();
    let b2 = m.as_bytes();
    assert!(
        !(1..b2.len().saturating_sub(1))
            .any(|i| b2[i] == b'.' && b2[i - 1].is_ascii_digit() && b2[i + 1].is_ascii_digit()),
        "{m}"
    );
    let checked = call(
        &b,
        USER,
        WRITE,
        "global.recipients.validate",
        &j(r#"{"account":"GB82WEST12345698765432","bic":"DEUTDEFF"}"#),
    )
    .ok();
    has(
        &checked,
        r#"{"format":"valid","formatKind":"iban","bicLookup":{"status":"refused","code":"bank.global_bic_directory_unset","blocker":"socket.psp-partners"}}"#,
    );
    assert!(!checked.compact().contains("TEST BANK"));
    let saved = call(
        &b,
        USER,
        WRITE,
        "global.recipients.add",
        &j(
            r#"{"idempotencyKey":"recip-key-1","name":"Ada","account":"GB82 WEST 1234 5698 7654 32","country":"GB","bic":"DEUTDEFF"}"#,
        ),
    )
    .ok();
    assert_eq!(s(&saved, "accountKind"), "iban");
    let listed = call(
        &b,
        USER,
        WRITE,
        "global.recipients.list",
        &j(r#"{"limit":10}"#),
    )
    .ok();
    assert!(
        matches!(&listed, Json::Array(a) if a.len() == 1),
        "{}",
        listed.compact()
    );
    call(
        &b,
        USER,
        WRITE,
        "global.recipients.add",
        &j(r#"{"idempotencyKey":"recip-key-2","name":"No","account":"not-an-account","country":"GB"}"#),
    )
    .refused("bank.global_account_format_invalid");
    let body = with_field(
        &Json::obj([
            ("idempotencyKey", Json::str("send-key-01")),
            ("fromSpaceId", Json::str(&space)),
            ("amount", Json::str("10")),
            ("toCurrency", Json::str("EUR")),
            ("recipientId", Json::str(id_of(&saved))),
            ("country", Json::str("DE")),
        ]),
        "deliveryMethod",
        Json::str("bank"),
    );
    send(&b, USER, &body).refused("bank.global_corridors_unset");
    assert!(b.ledger.rail().is_empty());
    let rm = |key: &str| {
        Json::obj([
            ("recipientId", Json::str(id_of(&saved))),
            ("idempotencyKey", Json::str(key)),
        ])
    };
    call(
        &b,
        OTHER,
        WRITE,
        "global.recipients.remove",
        &rm("recip-rm-01"),
    )
    .refused("bank.global_recipient_not_found");
    same(
        &call(
            &b,
            USER,
            WRITE,
            "global.recipients.remove",
            &rm("recip-rm-02"),
        )
        .ok(),
        r#"{"removed":true}"#,
    );
}

#[test]
fn names_the_next_blank_port_then_posts_one_send_with_the_provider_quote_unchanged() {
    let Some(db) = env() else { return };
    let send_with =
        |space: &str, recipient: &str, key: &str| send_body(key, "10", space, recipient);
    // Corridors live; the rate source, the payout rail and the travel-rule decision blank.
    let mut fx_only = live_global().payout_unset();
    fx_only.fx_live = false;
    fx_only.travel_rule = false;
    let b1 = mount(
        &db,
        Mount {
            global: Some(fx_only),
            ..Mount::default()
        },
    );
    let space = b1.funded(USER);
    let saved = add(&b1, USER, "recip-key-3", "Ada", "123456789");
    send(&b1, USER, &send_with(&space, &id_of(&saved), "send-key-02"))
        .refused("bank.global_fx_unset");
    assert!(b1.ledger.rail().is_empty());

    let b2 = mount(
        &db,
        Mount {
            global: Some(live_global().payout_unset()),
            ..Mount::default()
        },
    );
    let space2 = b2.funded(USER);
    let saved2 = add(&b2, USER, "recip-key-4", "Ada", "123456789");
    let quote = call(
        &b2,
        USER,
        WRITE,
        "global.quote",
        &j(r#"{"asset":"USDT","amount":"10","toCurrency":"EUR"}"#),
    )
    .ok();
    assert!(matches!(quote.get("quoteId"), Some(Json::String(_))));
    assert!(matches!(quote.get("lockedAt"), Some(Json::String(_))));
    let rest = with_field(
        &with_field(&quote, "quoteId", Json::Null),
        "lockedAt",
        Json::Null,
    );
    same(
        &rest,
        r#"{"rate":"7.25","fee":"1.10","feeAsset":"USDT","receiveAmount":"71.41","validUntil":"2099-01-01T00:00:00.000Z","eta":"2099-01-02T00:00:00.000Z","quoteId":null,"lockedAt":null}"#,
    );
    assert_eq!(s(&quote, "receiveAmount"), "71.41");
    send(
        &b2,
        USER,
        &send_with(&space2, &id_of(&saved2), "send-key-03"),
    )
    .refused("bank.global_payout_unset");

    let mut undecided = live_global();
    undecided.travel_rule = false;
    let b3 = mount(
        &db,
        Mount {
            global: Some(undecided),
            ..Mount::default()
        },
    );
    let space3 = b3.funded(USER);
    let saved3 = add(&b3, USER, "recip-key-5", "Ada", "123456789");
    send(
        &b3,
        USER,
        &send_with(&space3, &id_of(&saved3), "send-key-04"),
    )
    .refused("bank.global_travel_rule_undecided");
    assert!(b3.ledger.rail().is_empty());

    let ports = live_global();
    let b4 = mount(&db, ruled(ports.clone()));
    let space4 = b4.funded(USER);
    let saved4 = add(&b4, USER, "recip-key-6", "Ada", "123456789");
    let body = send_with(&space4, &id_of(&saved4), "send-key-05");
    let sent = send(&b4, USER, &body).ok();
    let again = send(&b4, USER, &body).ok();
    has(
        &again,
        &format!(
            r#"{{"id":"{}","status":"sent","providerRef":"payout-1","quoteRate":"7.25","quoteFee":"1.10","quoteReceive":"71.41","ledgerTxId":"{}"}}"#,
            id_of(&sent),
            s(&sent, "ledgerTxId")
        ),
    );
    assert_eq!(ports.calls(), 1);
    assert_eq!(b4.ledger.rail(), vec![forward_key(&id_of(&sent))]);
    assert_eq!(b4.balance(), "90");
    let listed = call(&b4, USER, WRITE, "global.list", &j(r#"{"limit":1}"#)).ok();
    let Some(Json::Array(first)) = listed.get("items") else {
        panic!("{}", listed.compact())
    };
    assert_eq!(first.len(), 1);
    let Some(Json::String(cursor)) = listed.get("nextCursor") else {
        panic!("{}", listed.compact())
    };
    let rest = call(
        &b4,
        USER,
        WRITE,
        "global.list",
        &Json::obj([("limit", Json::int(10)), ("cursor", Json::str(cursor))]),
    )
    .ok();
    let Some(Json::Array(more)) = rest.get("items") else {
        panic!("{}", rest.compact())
    };
    assert!(!more.is_empty());
    assert!(
        first
            .iter()
            .chain(more)
            .any(|item| id_of(item) == id_of(&sent) && s(item, "status") == "sent")
    );
    let founder = call(&b4, USER, FOUNDER, "global.ops.summary", &Json::Null).ok();
    has(
        &founder,
        r#"{"counts":{"sent":1},"rails":{"travelRule":"recorded","blocker":"socket.psp-partners"}}"#,
    );
    let named = call(
        &b4,
        USER,
        WRITE,
        "global.recipients.validate",
        &j(r#"{"account":"123456789","bic":"DEUTDEFF"}"#),
    )
    .ok();
    same(
        named.get("bicLookup").unwrap(),
        r#"{"status":"matched","bic":"DEUTDEFF","bankName":"TEST BANK"}"#,
    );
}

#[test]
fn holds_a_send_to_the_owner_table_for_reference_purpose_and_source_of_funds_and_posts_nothing_when_it_refuses()
 {
    let Some(db) = env() else { return };
    // The refusal's code and message, or `sent`, and how many rail posts were made.
    let attempt = |rules: Option<&str>,
                   amount: &str,
                   currency: &str,
                   extra: &[(&str, &str)],
                   key: &str|
     -> (String, String, usize) {
        let b = mount(
            &db,
            Mount {
                global: Some(live_global()),
                send_field_rules: rules.map(str::to_owned),
                ..Mount::default()
            },
        );
        let space = b.funded(USER);
        let saved = add(&b, USER, &format!("recip-{key}"), "Ada", "123456789");
        let mut compliance = vec![("originatorName".to_owned(), Json::str("Ada"))];
        compliance.extend(extra.iter().map(|(k, v)| ((*k).to_owned(), Json::str(*v))));
        let body = with_field(
            &with_field(
                &send_body(key, amount, &space, &id_of(&saved)),
                "toCurrency",
                Json::str(currency),
            ),
            "compliance",
            Json::Object(compliance),
        );
        let a = send(&b, USER, &body);
        let result = if a.0 == 200 {
            "sent".to_owned()
        } else {
            a.code()
        };
        (result, a.message(), b.ledger.rail().len())
    };
    let code_posted = |r: (String, String, usize)| (r.0, r.2);

    // The table was never published: refused, nothing posted.
    assert_eq!(
        code_posted(attempt(None, "10", "EUR", &[], "fields-01")),
        ("bank.send_field_rules_unset".to_owned(), 0)
    );
    assert_eq!(
        code_posted(attempt(
            Some(r#"{"reference": "x"}"#),
            "10",
            "EUR",
            &[],
            "fields-02"
        )),
        ("bank.send_field_rules_unset".to_owned(), 0)
    );
    // A reference on a rail the table has no rule for.
    assert_eq!(
        code_posted(attempt(
            Some(
                r#"{"reference":[{"deliveryMethod":"wire","maxLength":10}],"purposeRequired":[],"sourceOfFunds":[]}"#
            ),
            "10",
            "EUR",
            &[("reference", "INV1")],
            "fields-03"
        )),
        ("bank.reference_rules_unset".to_owned(), 0)
    );
    // The country rule wins over the rail rule, and the limit is named.
    let long = "x".repeat(13);
    let (code, message, posted) = attempt(
        Some(RULES),
        "10",
        "EUR",
        &[("reference", &long)],
        "fields-04",
    );
    assert_eq!(
        (code.as_str(), posted),
        ("bank.reference_too_long", 0),
        "{message}"
    );
    assert!(message.contains("12"), "{message}");
    // Purpose is needed for the owner's currencies, not for others.
    assert_eq!(
        code_posted(attempt(Some(RULES), "10", "INR", &[], "fields-05")),
        ("bank.send_purpose_required".to_owned(), 0)
    );
    // Source of funds is needed above the threshold, not at it.
    assert_eq!(
        code_posted(attempt(
            Some(RULES),
            "50.000000000000000001",
            "EUR",
            &[],
            "fields-06"
        )),
        ("bank.source_of_funds_required".to_owned(), 0)
    );
    let twelve = "x".repeat(12);
    assert_eq!(
        code_posted(attempt(
            Some(RULES),
            "50",
            "EUR",
            &[("reference", &twelve)],
            "fields-07"
        )),
        ("sent".to_owned(), 1)
    );
    assert_eq!(
        code_posted(attempt(
            Some(RULES),
            "60",
            "INR",
            &[("purpose", "family"), ("sourceOfFunds", "salary")],
            "fields-08"
        )),
        ("sent".to_owned(), 1)
    );
}

#[test]
fn refuses_every_send_while_the_payee_controls_are_unset_and_a_blocked_payee_without_naming_the_list()
 {
    let Some(db) = env() else { return };
    let unset = mount(
        &db,
        Mount {
            payee_controls: None,
            ..ruled(live_global())
        },
    );
    let space = unset.funded(USER);
    let saved = add(&unset, USER, "recip-pc-01", "Ada", "123456789");
    send(
        &unset,
        USER,
        &send_body("send-pc-01", "10", &space, &id_of(&saved)),
    )
    .refused("bank.payee_controls_unset");
    assert!(unset.ledger.rail().is_empty());
    let desk = call(&unset, OP_A, COMPLIANCE, "global.ops.controls", &Json::Null).ok();
    same(
        desk.get("payeeControls").unwrap(),
        r#"{"state":"unset","blockedCount":0}"#,
    );

    let blocked = mount(
        &db,
        Mount {
            payee_controls: Some(r#"{"blockedAccounts":["1234 56789"]}"#.to_owned()),
            ..ruled(live_global())
        },
    );
    let space2 = blocked.funded(USER);
    let saved2 = add(&blocked, USER, "recip-pc-02", "Ada", "123456789");
    let refused = send(
        &blocked,
        USER,
        &send_body("send-pc-02", "10", &space2, &id_of(&saved2)),
    );
    refused.refused("bank.payee_blocked");
    let m = refused.message();
    assert!(
        !(m.contains("123456789") || m.contains("1234 56789") || m.contains("blockedAccounts")),
        "{m}"
    );
    assert!(blocked.ledger.rail().is_empty());
    let desk2 = call(
        &blocked,
        OP_A,
        COMPLIANCE,
        "global.ops.controls",
        &Json::Null,
    )
    .ok();
    same(
        desk2.get("payeeControls").unwrap(),
        r#"{"state":"published","blockedCount":1}"#,
    );

    // A published empty list blocks nothing.
    let open = mount(
        &db,
        Mount {
            payee_controls: Some(r#"{"blockedAccounts":[]}"#.to_owned()),
            ..ruled(live_global())
        },
    );
    let space3 = open.funded(USER);
    let saved3 = add(&open, USER, "recip-pc-03", "Ada", "123456789");
    has(
        &send(
            &open,
            USER,
            &send_body("send-pc-03", "10", &space3, &id_of(&saved3)),
        )
        .ok(),
        r#"{"status":"sent"}"#,
    );
}

// ---------------------------------------------------------------------------------------------------------------
// Holds

/// `seeded`: a send that has been taken in, on its rate lock, but has not left: the only kind a hold can catch.
struct Seeded {
    b: Bank,
    id: String,
}

fn seeded(db: &TestDb, m: Mount) -> Seeded {
    let b = mount(db, m);
    let space = b.funded(USER);
    let saved = add(&b, USER, &format!("recip-{}", uuid()), "Ada", "123456789");
    let id = uuid();
    let quote = call(
        &b,
        USER,
        WRITE,
        "global.quote",
        &j(r#"{"asset":"USDT","amount":"10","toCurrency":"EUR"}"#),
    )
    .ok();
    b.sql()
        .execute(
            "INSERT INTO bank.global_sends (id, user_id, idempotency_key, from_space_id, asset_id, amount, to_currency, \
             recipient_id, country, delivery_method, compliance, quote_id, status) \
             VALUES ($1::text::uuid, $2, $3, $4::text::uuid, 'USDT', '10', 'EUR', $5::text::uuid, 'DE', 'bank', \
             '{\"originatorName\":\"Ada\"}', $6::text::uuid, 'submitted')",
            &[
                &id,
                &USER,
                &format!("seed-{id}"),
                &space,
                &id_of(&saved),
                &s(&quote, "quoteId"),
            ],
        )
        .unwrap();
    Seeded { b, id }
}

fn seeded_ruled(db: &TestDb) -> Seeded {
    seeded(db, ruled(live_global()))
}

fn hold(b: &Bank, op: &str, id: &str, key: &str, reason: &str, info: Option<&str>) -> Answer {
    let mut input = Json::obj([
        ("sendId", Json::str(id)),
        ("holdKey", Json::str(key)),
        ("reason", Json::str(reason)),
    ]);
    if let Some(i) = info {
        input = with_field(&input, "infoRequest", Json::str(i));
    }
    call(b, op, COMPLIANCE, "global.ops.hold", &input)
}

fn upload(b: &Bank, id: &str, name: &str, kind: &str, content: &str) -> Answer {
    call(
        b,
        USER,
        WRITE,
        "global.hold.uploadProof",
        &Json::obj([
            ("id", Json::str(id)),
            ("name", Json::str(name)),
            ("type", Json::str(kind)),
            ("contentBase64", Json::str(content)),
        ]),
    )
}

fn status_of(b: &Bank, id: &str) -> String {
    s(
        &call(b, USER, WRITE, "global.get", &with_id(id)).ok(),
        "status",
    )
}

#[test]
fn holds_a_send_that_has_not_left_shows_the_customer_only_the_request_and_moves_it_to_review_once_on_upload()
 {
    let Some(db) = env() else { return };
    let Seeded { b, id } = seeded(
        &db,
        Mount {
            proof_limits: Some(PROOF_LIMITS.to_owned()),
            ..ruled(live_global())
        },
    );
    let ask = Some("Please send your payslip.");
    let held = hold(&b, OP_A, &id, "hold-key-01", "screening hit 7", ask).ok();
    has(
        &held,
        &format!(r#"{{"state":"requested","heldBy":"{OP_A}","reason":"screening hit 7"}}"#),
    );
    let again = hold(&b, OP_A, &id, "hold-key-01", "screening hit 7", ask).ok();
    assert_eq!(id_of(&again), id_of(&held));
    hold(&b, OP_A, &id, "hold-key-01", "another", None).refused("bank.hold_conflict");
    assert_eq!(status_of(&b, &id), "held");
    let queue = call(
        &b,
        OP_A,
        COMPLIANCE,
        "global.ops.holds",
        &j(r#"{"limit":10}"#),
    )
    .ok();
    let Json::Array(rows) = &queue else {
        panic!("{}", queue.compact())
    };
    assert_eq!(
        rows.iter().map(|r| s(r, "sendId")).collect::<Vec<_>>(),
        vec![id.clone()]
    );

    let mine = call(&b, USER, WRITE, "global.hold.get", &with_id(&id)).ok();
    same(
        &mine,
        r#"{"state":"requested","infoRequest":"Please send your payslip.","proofUploaded":false,"proofLimits":{"allowedTypes":["application/pdf"],"maxBytes":64},"autoCancel":{"state":"unset","hours":null,"at":null}}"#,
    );
    let shown = mine.compact();
    assert!(
        !(shown.contains("screening") || shown.contains("heldBy") || shown.contains("reason")),
        "{shown}"
    );
    // `seededOther()`: another bank over the same tables, as someone else.
    let other = mount(&db, ruled(live_global()));
    call(&other, OTHER, WRITE, "global.hold.get", &with_id(&id)).rejected();

    let file = STANDARD.encode("%PDF-1.4 payslip");
    upload(&b, &id, "p.png", "image/png", &file).refused("bank.proof_type_not_allowed");
    upload(
        &b,
        &id,
        "p.pdf",
        "application/pdf",
        &STANDARD.encode([1u8; 65]),
    )
    .refused("bank.proof_too_large");
    has(
        &upload(&b, &id, "p.pdf", "application/pdf", &file).ok(),
        r#"{"state":"under_review","proofUploaded":true}"#,
    );
    // The same file again is the same answer; a different one is refused.
    has(
        &upload(&b, &id, "p.pdf", "application/pdf", &file).ok(),
        r#"{"state":"under_review"}"#,
    );
    upload(
        &b,
        &id,
        "q.pdf",
        "application/pdf",
        &STANDARD.encode("%PDF other"),
    )
    .refused("bank.proof_already_uploaded");
    let stored = call(&b, OP_A, COMPLIANCE, "global.ops.proof", &with_send(&id)).ok();
    assert_eq!(
        STANDARD.decode(s(&stored, "contentBase64")).unwrap(),
        b"%PDF-1.4 payslip"
    );
    assert!(b.ledger.rail().is_empty());
}

#[test]
fn refuses_an_upload_while_no_limits_are_published_and_while_nothing_was_asked_for() {
    let Some(db) = env() else { return };
    let Seeded { b, id } = seeded_ruled(&db);
    hold(&b, OP_A, &id, "hold-key-02", "review", None).ok();
    upload(&b, &id, "p.pdf", "application/pdf", "AAAA").refused("bank.proof_limits_unset");
    let w = seeded(
        &db,
        Mount {
            proof_limits: Some(PROOF_LIMITS.to_owned()),
            ..ruled(live_global())
        },
    );
    hold(&w.b, OP_A, &w.id, "hold-key-03", "review", None).ok();
    upload(&w.b, &w.id, "p.pdf", "application/pdf", "AAAA").refused("bank.proof_not_requested");
    call(
        &w.b,
        OP_A,
        COMPLIANCE,
        "global.ops.requestInfo",
        &Json::obj([
            ("sendId", Json::str(&w.id)),
            ("infoRequest", Json::str("Source of funds, please.")),
        ]),
    )
    .ok();
    has(
        &upload(&w.b, &w.id, "p.pdf", "application/pdf", "AAAA").ok(),
        r#"{"state":"under_review"}"#,
    );
}

#[test]
fn releases_only_by_a_different_person_then_sends_once_a_settled_send_cannot_be_held() {
    let Some(db) = env() else { return };
    let Seeded { b, id } = seeded_ruled(&db);
    hold(&b, OP_A, &id, "hold-key-04", "review", None).ok();
    call(&b, OP_A, COMPLIANCE, "global.ops.release", &with_send(&id))
        .refused("bank.release_same_operator");
    assert_eq!(status_of(&b, &id), "held");
    assert!(b.ledger.rail().is_empty());
    let released = call(&b, OP_B, COMPLIANCE, "global.ops.release", &with_send(&id)).ok();
    has(
        &released,
        &format!(r#"{{"id":"{id}","status":"sent","providerRef":"payout-1"}}"#),
    );
    assert_eq!(b.ledger.rail(), vec![forward_key(&id)]);
    call(&b, OP_B, COMPLIANCE, "global.ops.release", &with_send(&id))
        .refused("bank.hold_not_found");
    assert_eq!(b.ledger.rail().len(), 1);
    hold(&b, OP_A, &id, "hold-key-05", "late", None).refused("bank.transfer_settled");
    assert_eq!(
        s(
            &call(&b, USER, WRITE, "global.hold.get", &with_id(&id)).ok(),
            "state"
        ),
        "released"
    );
}

#[test]
fn links_an_incoming_reference_to_a_held_send_resumes_it_and_logs_the_link_once() {
    let Some(db) = env() else { return };
    let Seeded { b, id } = seeded_ruled(&db);
    let link = |b: &Bank, op: &str, id: &str, reference: &str| {
        call(
            b,
            op,
            COMPLIANCE,
            "global.ops.linkReference",
            &Json::obj([
                ("sendId", Json::str(id)),
                ("reference", Json::str(reference)),
            ]),
        )
    };
    hold(&b, OP_A, &id, "hold-key-06", "unreferenced credit", None).ok();
    link(&b, OP_A, &id, "PAY-12345").refused("bank.release_same_operator");
    let linked = link(&b, OP_B, &id, "pay-12345").ok();
    has(
        &linked,
        &format!(r#"{{"linked":true,"send":{{"id":"{id}","status":"sent"}}}}"#),
    );
    assert_eq!(b.ledger.rail().len(), 1);
    let rows: Vec<(String, String)> = b
        .sql()
        .query(
            "SELECT reference, linked_by::text FROM bank.global_incoming_links",
            &[],
        )
        .unwrap()
        .iter()
        .map(|r| (r.get(0), r.get(1)))
        .collect();
    assert_eq!(rows, vec![("PAY-12345".to_owned(), OP_B.to_owned())]);
    has(&link(&b, OP_B, &id, "PAY-12345").ok(), r#"{"linked":true}"#);
    assert_eq!(b.ledger.rail().len(), 1);
    // The same reference cannot be tied to a second send, and that send stays held.
    let second = seeded_ruled(&db);
    hold(
        &second.b,
        OP_A,
        &second.id,
        "hold-key-08",
        "unreferenced credit",
        None,
    )
    .ok();
    link(&second.b, OP_B, &second.id, "PAY-12345").refused("bank.link_reference_conflict");
    assert_eq!(status_of(&second.b, &second.id), "held");
    assert!(second.b.ledger.rail().is_empty());
}

#[test]
fn keeps_hold_and_release_to_the_compliance_scope() {
    let Some(db) = env() else { return };
    let Seeded { b, id } = seeded_ruled(&db);
    call(
        &b,
        USER,
        WRITE,
        "global.ops.hold",
        &Json::obj([
            ("sendId", Json::str(&id)),
            ("holdKey", Json::str("hold-key-07")),
            ("reason", Json::str("x")),
        ]),
    )
    .rejected();
    call(&b, USER, WRITE, "global.ops.holds", &j(r#"{"limit":5}"#)).rejected();
}

#[test]
fn a_hold_that_lands_while_the_forward_entry_is_posted_stops_the_payout_and_release_pays_out_once_without_posting_again()
 {
    let Some(db) = env() else { return };
    let ports = live_global().paying("payout-9");
    let b = mount(&db, ruled(ports.clone()));
    let space = b.funded(USER);
    let saved = add(&b, USER, "recip-race-01", "Ada", "123456789");
    let placed = Arc::new(AtomicBool::new(false));
    let held: Arc<Mutex<Option<Answer>>> = Arc::default();
    {
        let (door, url, placed, held) =
            (b.door.clone(), b.url.clone(), placed.clone(), held.clone());
        b.ledger.set_hook(Some(Arc::new(move |_, _, booked| {
            if booked && !placed.swap(true, Ordering::SeqCst) {
                let mut c = Client::connect(&url, NoTls).unwrap();
                let id: String = c
                    .query_one("SELECT id::text FROM bank.global_sends", &[])
                    .unwrap()
                    .get(0);
                let a = call_door(
                    &door,
                    OP_A,
                    COMPLIANCE,
                    "global.ops.hold",
                    &Json::obj([
                        ("sendId", Json::str(id)),
                        ("holdKey", Json::str("hold-race-01")),
                        ("reason", Json::str("late screening")),
                    ]),
                );
                *held.lock().unwrap() = Some(a);
            }
            Ok(())
        })));
    }
    let view = send(
        &b,
        USER,
        &send_body("send-race-01", "10", &space, &id_of(&saved)),
    )
    .ok();
    b.ledger.set_hook(None);
    held.lock()
        .unwrap()
        .take()
        .expect("the hold was placed")
        .ok();
    assert_eq!(s(&view, "status"), "held");
    assert_eq!(ports.calls(), 0);
    assert_eq!(b.ledger.rail().len(), 1);
    let released = call(
        &b,
        OP_B,
        COMPLIANCE,
        "global.ops.release",
        &with_send(&id_of(&view)),
    )
    .ok();
    has(&released, r#"{"status":"sent","providerRef":"payout-9"}"#);
    assert_eq!(ports.calls(), 1);
    assert_eq!(b.ledger.rail(), vec![forward_key(&id_of(&view))]);
}

#[test]
fn a_send_held_and_cancelled_while_its_forward_entry_posts_is_turned_back_once_by_a_later_read_when_the_first_reversal_fails()
 {
    let Some(db) = env() else { return };
    let b = mount(&db, ruled(live_global()));
    let space = b.funded(USER);
    let saved = add(&b, USER, "recip-race-02", "Ada", "123456789");
    let cancelled: Arc<Mutex<Option<Answer>>> = Arc::default();
    {
        let (door, url, cancelled) = (b.door.clone(), b.url.clone(), cancelled.clone());
        b.ledger.set_hook(Some(Arc::new(move |n, _, booked| {
            // Both reversals tried at once (by the cancel's own read, then by the send) fail, as if the ledger were
            // briefly away.
            if !booked && (n == 2 || n == 3) {
                return Err(away());
            }
            if booked && n == 1 {
                let mut c = Client::connect(&url, NoTls).unwrap();
                let id: String = c
                    .query_one("SELECT id::text FROM bank.global_sends", &[])
                    .unwrap()
                    .get(0);
                call_door(
                    &door,
                    OP_A,
                    COMPLIANCE,
                    "global.ops.hold",
                    &Json::obj([
                        ("sendId", Json::str(&id)),
                        ("holdKey", Json::str("hold-race-02")),
                        ("reason", Json::str("late screening")),
                    ]),
                )
                .ok();
                let a = call_door(&door, USER, WRITE, "global.cancel", &with_id(&id));
                *cancelled.lock().unwrap() = Some(a);
            }
            Ok(())
        })));
    }
    let body = send_body("send-race-02", "10", &space, &id_of(&saved));
    send(&b, USER, &body).refused("bank.global_outcome_unknown");
    let cancel = cancelled
        .lock()
        .unwrap()
        .take()
        .expect("the cancel ran")
        .ok();
    has(&cancel, r#"{"status":"cancelled","ledgerTxId":null}"#);
    assert_eq!(b.ledger.rail().len(), 1);
    assert_eq!(b.balance(), "90");
    // The next read finds the forward entry by its key and turns it back; later reads and a replay credit nothing more.
    let id = b.ids()[0].clone();
    has(
        &call(&b, USER, WRITE, "global.get", &with_id(&id)).ok(),
        r#"{"status":"cancelled","cancelledBy":"customer","ledgerTxId":null}"#,
    );
    assert_eq!(b.ledger.rail(), vec![forward_key(&id), reverse_key(&id)]);
    assert_eq!(b.balance(), "100");
    let listed = call(&b, USER, WRITE, "global.list", &j(r#"{"limit":10}"#)).ok();
    let Some(Json::Array(items)) = listed.get("items") else {
        panic!("{}", listed.compact())
    };
    has(
        &items[0],
        &format!(r#"{{"id":"{id}","status":"cancelled"}}"#),
    );
    has(
        &send(&b, USER, &body).ok(),
        &format!(r#"{{"id":"{id}","status":"cancelled"}}"#),
    );
    has(
        &call(&b, USER, WRITE, "global.cancel", &with_id(&id)).ok(),
        &format!(r#"{{"id":"{id}","status":"cancelled"}}"#),
    );
    assert_eq!(b.ledger.rail().len(), 2);
    assert_eq!(b.balance(), "100");
    b.ledger.set_hook(None);
}

#[test]
fn a_refund_the_ledger_refuses_stays_returned_and_credits_once_on_retry_one_already_posted_is_only_recorded_an_earlier_reversal_or_another_rail_refunds_nothing()
 {
    let Some(db) = env() else { return };
    let ports = live_global().paying("payout-r");
    let b = mount(
        &db,
        Mount {
            refund_fee: Some("0".to_owned()),
            ..ruled(ports.clone())
        },
    );
    let space = b.funded(USER);
    let saved = add(&b, USER, "recip-refund-01", "Ada", "123456789");
    let send_one = |key: &str| send(&b, USER, &send_body(key, "10", &space, &id_of(&saved))).ok();
    let record = |id: &str, r: &str| {
        call(
            &b,
            OP_A,
            COMPLIANCE,
            "global.ops.recordReturn",
            &Json::obj([("sendId", Json::str(id)), ("returnRef", Json::str(r))]),
        )
        .ok()
    };
    let refund = |id: &str| {
        call(
            &b,
            OP_B,
            COMPLIANCE,
            "global.ops.refundReturn",
            &with_send(id),
        )
    };
    let ops_get = |id: &str| call(&b, OP_B, COMPLIANCE, "global.ops.get", &with_id(id)).ok();
    // `reverseFromRail(ledger, id, userAvailable(USER, 'USDT'), 'test-payout-rail', 10)`.
    let turn_back = |id: &str| {
        let w = GlobalWiring::none();
        let d = GlobalDeps {
            store: b.door.store(),
            ledger: &b.ledger,
            custody_layer: "on",
            w: &w,
            now: door::system_now(),
        };
        gsend::reverse_from_rail(
            &d,
            id,
            &LedgerAccount::user_available(USER, "USDT"),
            "test-payout-rail",
            amt("10"),
        )
        .unwrap();
    };

    // The ledger is away as the refund posts: the send stays returned and nothing is credited; the retry credits once.
    let first = id_of(&send_one("send-refund-01"));
    record(&first, "TEST-RET-R1");
    let gone = Arc::new(AtomicBool::new(true));
    {
        let gone = gone.clone();
        b.ledger.set_hook(Some(Arc::new(move |_, _, booked| {
            if !booked && gone.swap(false, Ordering::SeqCst) {
                return Err(away());
            }
            Ok(())
        })));
    }
    refund(&first).refused("bank.global_outcome_unknown");
    has(
        &ops_get(&first),
        r#"{"status":"returned","refundedAt":null}"#,
    );
    assert_eq!(b.balance(), "90");
    has(&refund(&first).ok(), r#"{"status":"refunded"}"#);
    assert_eq!(b.balance(), "100");
    assert_eq!(
        b.ledger.rail(),
        vec![forward_key(&first), reverse_key(&first)]
    );

    // Stopped after the refund posted and before it was recorded (the ledger's answer is lost): the retry records it
    // and credits nothing more.
    let second = id_of(&send_one("send-refund-02"));
    record(&second, "TEST-RET-R2");
    let lose = Arc::new(AtomicBool::new(true));
    {
        let lose = lose.clone();
        b.ledger.set_hook(Some(Arc::new(move |_, _, booked| {
            if booked && lose.swap(false, Ordering::SeqCst) {
                return Err(PostFailure::Unknown("answer lost".to_owned()));
            }
            Ok(())
        })));
    }
    refund(&second).refused("bank.global_outcome_unknown");
    b.ledger.set_hook(None);
    has(
        &ops_get(&second),
        r#"{"status":"returned","refundedAt":null}"#,
    );
    assert_eq!(b.balance(), "100");
    has(&refund(&second).ok(), r#"{"status":"refunded"}"#);
    assert_eq!(b.balance(), "100");
    assert_eq!(b.ledger.rail().len(), 4);

    // The send's value was already turned back before the rail returned it: the refund is not posted or recorded.
    let third = id_of(&send_one("send-refund-03"));
    turn_back(&third);
    record(&third, "TEST-RET-R3");
    refund(&third).refused("bank.refund_already_reversed");
    has(&ops_get(&third), r#"{"status":"returned"}"#);
    assert_eq!(b.balance(), "100");
    assert_eq!(b.ledger.rail().len(), 6);

    // The connected rail is another one now: nothing is taken from a boundary that never received the send.
    let fourth = id_of(&send_one("send-refund-04"));
    record(&fourth, "TEST-RET-R4");
    *ports.rail.lock().unwrap() = "another-test-rail".to_owned();
    refund(&fourth).refused("bank.refund_rail_changed");
    assert_eq!(b.balance(), "90");
    assert_eq!(b.ledger.rail().len(), 7);
}

#[test]
fn holds_sends_to_an_exchange_to_the_owner_allowance_in_a_rolling_window_and_refuses_while_it_is_unset()
 {
    let Some(db) = env() else { return };
    let unset = mount(
        &db,
        Mount {
            exchange_allowance: None,
            ..ruled(live_global())
        },
    );
    let space0 = unset.funded(USER);
    let saved0 = add(&unset, USER, "recip-ex-00", "Ada", "123456789");
    send(
        &unset,
        USER,
        &send_body("send-ex-00", "10", &space0, &id_of(&saved0)),
    )
    .refused("bank.exchange_allowance_unset");
    assert!(unset.ledger.rail().is_empty());
    same(
        call(&unset, OP_A, COMPLIANCE, "global.ops.controls", &Json::Null)
            .ok()
            .get("exchangeAllowance")
            .unwrap(),
        r#"{"state":"unset","windowDays":null,"exchangeCount":0}"#,
    );

    let allowance = r#"{"exchangeAccounts":["9999 99999"],"windowDays":30,"limits":[{"asset":"USDT","maxAmount":"30"}]}"#;
    let b = mount(
        &db,
        Mount {
            exchange_allowance: Some(allowance.to_owned()),
            ..ruled(live_global())
        },
    );
    let space = b.funded(USER);
    let exchange = id_of(&add(&b, USER, "recip-ex-01", "Exchange", "999999999"));
    let friend = id_of(&add(&b, USER, "recip-ex-02", "Ada", "123456789"));
    let to = |recipient: &str, key: &str, amount: &str| {
        send(&b, USER, &send_body(key, amount, &space, recipient))
    };
    has(
        &to(&exchange, "send-ex-01", "20").ok(),
        r#"{"status":"sent"}"#,
    );
    // 20 already sent in the window: 11 more is over 30; nothing is posted for it.
    to(&exchange, "send-ex-02", "11").refused("bank.exchange_allowance_exceeded");
    assert_eq!(b.ledger.rail().len(), 1);
    // A refused send does not use up the room; exactly the rest fits.
    has(
        &to(&exchange, "send-ex-03", "10").ok(),
        r#"{"status":"sent"}"#,
    );
    // A recipient that is not an exchange is not counted.
    has(
        &to(&friend, "send-ex-04", "40").ok(),
        r#"{"status":"sent"}"#,
    );
    // The replay of a refused send is the same refusal.
    to(&exchange, "send-ex-02", "11").refused("bank.exchange_allowance_exceeded");
    assert_eq!(b.ledger.rail().len(), 3);
    same(
        call(&b, OP_A, COMPLIANCE, "global.ops.controls", &Json::Null)
            .ok()
            .get("exchangeAllowance")
            .unwrap(),
        r#"{"state":"published","windowDays":30,"exchangeCount":1}"#,
    );

    // A limit too large for the ledger to read makes the setting unreadable: refused as unset, nothing thrown.
    let huge = mount(
        &db,
        Mount {
            exchange_allowance: Some(format!(
                r#"{{"exchangeAccounts":[],"windowDays":30,"limits":[{{"asset":"USDT","maxAmount":"{}"}}]}}"#,
                "9".repeat(40)
            )),
            ..ruled(live_global())
        },
    );
    let space_h = huge.funded(USER);
    let ex_h = id_of(&add(&huge, USER, "recip-ex-04", "Ada", "123456789"));
    send(&huge, USER, &send_body("send-ex-06", "1", &space_h, &ex_h))
        .refused("bank.exchange_allowance_unset");

    // An exchange with no limit for the asset is refused as unset, never allowed.
    let bare = mount(
        &db,
        Mount {
            exchange_allowance: Some(
                r#"{"exchangeAccounts":["999999999"],"windowDays":30,"limits":[]}"#.to_owned(),
            ),
            ..ruled(live_global())
        },
    );
    let space_b = bare.funded(USER);
    let ex_b = id_of(&add(&bare, USER, "recip-ex-03", "Exchange", "999999999"));
    send(&bare, USER, &send_body("send-ex-05", "1", &space_b, &ex_b))
        .refused("bank.exchange_allowance_unset");
}

// ---------------------------------------------------------------------------------------------------------------
// When the payout rail refuses or its answer is lost (global.ts payout step)

/// `ready(payout)`: a bank on the test's tables whose payout is `ports`, a funded space, a recipient and one send body.
struct Ready {
    b: Bank,
    body: Json,
}

/// The send's own row: status, failure code, ledger entry and provider reference.
type SendRowView = (String, Option<String>, Option<String>, Option<String>);

impl Ready {
    fn row(&self) -> SendRowView {
        let r = self
            .b
            .sql()
            .query_one(
                "SELECT status, failure_code, ledger_tx_id, provider_ref FROM bank.global_sends WHERE idempotency_key = $1",
                &[&s(&self.body, "idempotencyKey")],
            )
            .unwrap();
        (r.get(0), r.get(1), r.get(2), r.get(3))
    }
    fn send(&self) -> Answer {
        send(&self.b, USER, &self.body)
    }
}

fn ready(db: &TestDb, ports: Ports) -> Ready {
    let b = mount(db, ruled(ports));
    let space = b.funded(USER);
    let saved = add(&b, USER, &format!("recip-{}", uuid()), "Ada", "123456789");
    let body = send_body(&format!("send-{}", uuid()), "10", &space, &id_of(&saved));
    Ready { b, body }
}

#[test]
fn a_refused_send_gives_its_lock_back_for_the_corrected_send_the_same_send_twice_at_once_is_one_send_old_unused_locks_go()
 {
    let Some(db) = env() else { return };
    let b = mount(&db, ruled(live_global()));
    let space = b.funded(USER);
    let saved = add(&b, USER, &format!("recip-{}", uuid()), "Ada", "123456789");
    let quote = |amount: &str| {
        call(
            &b,
            USER,
            WRITE,
            "global.quote",
            &Json::obj([
                ("asset", Json::str("USDT")),
                ("amount", Json::str(amount)),
                ("toCurrency", Json::str("EUR")),
            ]),
        )
        .ok()
    };
    let lock = s(&quote("60"), "quoteId");
    let base = with_field(
        &send_body("", "60", &space, &id_of(&saved)),
        "quoteId",
        Json::str(&lock),
    );
    let keyed = |b: &Json, compliance: &str| {
        with_field(
            &with_field(b, "compliance", j(compliance)),
            "idempotencyKey",
            Json::str(format!("send-{}", uuid())),
        )
    };
    // Over the TEST source-of-funds threshold with none given: refused, nothing posted, the lock not spent.
    send(&b, USER, &keyed(&base, r#"{"originatorName":"Ada"}"#))
        .refused("bank.source_of_funds_required");
    let corrected = keyed(
        &base,
        r#"{"originatorName":"Ada","sourceOfFunds":"salary"}"#,
    );
    // The corrected send, sent twice at once (a double press): one send, paid once, at the lock.
    let (a, c) = std::thread::scope(|t| {
        let one = t.spawn(|| send(&b, USER, &corrected));
        let two = t.spawn(|| send(&b, USER, &corrected));
        (one.join().unwrap().ok(), two.join().unwrap().ok())
    });
    assert_eq!(id_of(&a), id_of(&c));
    has(
        &a,
        &format!(r#"{{"status":"sent","quoteId":"{lock}","quoteRate":"7.25"}}"#),
    );
    assert_eq!(b.ledger.rail().len(), 1);
    // Now the lock is spent.
    send(
        &b,
        USER,
        &with_field(
            &corrected,
            "idempotencyKey",
            Json::str(format!("send-{}", uuid())),
        ),
    )
    .refused("bank.global_quote_used");
    // A lock no send used, an hour past its end, is gone at the customer's next quote; a used one stays.
    let unused = s(&quote("5"), "quoteId");
    b.sql()
        .execute(
            "UPDATE bank.global_quotes SET valid_until = now() - interval '2 hours' \
             WHERE id IN ($1::text::uuid, $2::text::uuid)",
            &[&unused, &lock],
        )
        .unwrap();
    quote("5");
    let left: Vec<String> = b
        .sql()
        .query(
            "SELECT id::text FROM bank.global_quotes WHERE id IN ($1::text::uuid, $2::text::uuid)",
            &[&unused, &lock],
        )
        .unwrap()
        .iter()
        .map(|r| r.get(0))
        .collect();
    assert_eq!(left, vec![lock]);
}

#[test]
fn pays_at_the_locked_figures_when_the_provider_rate_has_moved_since_and_hands_the_payout_rail_exactly_that_lock()
 {
    let Some(db) = env() else { return };
    let ports = live_global().paying("payout-lock");
    let b = mount(&db, ruled(ports.clone()));
    let space = b.funded(USER);
    let saved = add(&b, USER, &format!("recip-{}", uuid()), "Ada", "123456789");
    let lock = s(
        &call(
            &b,
            USER,
            WRITE,
            "global.quote",
            &j(r#"{"asset":"USDT","amount":"10","toCurrency":"EUR"}"#),
        )
        .ok(),
        "quoteId",
    );
    *ports.rate.lock().unwrap() = "9".to_owned();
    let sent = send(
        &b,
        USER,
        &with_field(
            &send_body(&format!("send-{}", uuid()), "10", &space, &id_of(&saved)),
            "quoteId",
            Json::str(&lock),
        ),
    )
    .ok();
    has(
        &sent,
        &format!(
            r#"{{"status":"sent","quoteRate":"7.25","quoteReceive":"71.41","quoteId":"{lock}"}}"#
        ),
    );
    let seen = ports.seen.lock().unwrap().clone();
    assert_eq!(seen.len(), 1);
    assert_eq!(
        (
            seen[0].send_id.as_str(),
            seen[0].quote_id.as_str(),
            seen[0].rate.as_str(),
            seen[0].receive_amount.as_str()
        ),
        (id_of(&sent).as_str(), lock.as_str(), "7.25", "71.41")
    );
    assert_eq!(b.ledger.rail().len(), 1);
}

#[test]
fn a_refused_payout_returns_the_money_in_the_same_step_once_and_the_send_is_failed_with_the_reason()
{
    let Some(db) = env() else { return };
    let ports = live_global().scripted(vec![Reply::Answer(PayoutAnswer::Refused)]);
    let r = ready(&db, ports.clone());
    r.send().refused("bank.global_payout_refused");
    let id = r.b.ids()[0].clone();
    // Out to the rail, and back.
    assert_eq!(r.b.ledger.rail(), vec![forward_key(&id), reverse_key(&id)]);
    assert_eq!(r.b.balance(), "100");
    let (status, failure, tx, _) = r.row();
    assert_eq!(
        (status.as_str(), failure.as_deref(), tx),
        ("failed", Some("bank.global_payout_refused"), None)
    );

    // The same request again: the rail is not asked again and nothing more is posted.
    r.send().refused("bank.global_payout_refused");
    assert_eq!(ports.calls(), 1);
    assert_eq!(r.b.ledger.rail().len(), 2);
    assert_eq!(r.b.balance(), "100");
}

#[test]
fn a_lost_payout_reply_keeps_the_debit_and_says_the_outcome_is_unknown_the_retry_asks_the_rail_again_and_never_posts_twice()
 {
    let Some(db) = env() else { return };
    let ports = live_global().scripted(vec![
        Reply::Lost,
        Reply::Answer(accepted("payout-7", "sent")),
    ]);
    let r = ready(&db, ports.clone());
    r.send().refused("bank.global_outcome_unknown");
    // The rail may have paid: the money stays out, the send stays open with its ledger entry, nothing is refunded.
    assert_eq!(r.b.ledger.rail().len(), 1);
    assert_eq!(r.b.balance(), "90");
    let (status, failure, tx, provider) = r.row();
    assert_eq!(
        (status.as_str(), failure, provider),
        ("submitted", None, None)
    );
    let tx = tx.expect("the send keeps its ledger entry");

    let settled = r.send().ok();
    has(
        &settled,
        &format!(r#"{{"status":"sent","providerRef":"payout-7","ledgerTxId":"{tx}"}}"#),
    );
    assert_eq!(ports.calls(), 2);
    assert_eq!(r.b.ledger.rail().len(), 1);
    assert_eq!(r.b.balance(), "90");
}

#[test]
fn a_refused_payout_whose_return_cannot_be_posted_stays_open_as_unknown_and_the_retry_returns_the_money_once()
 {
    let Some(db) = env() else { return };
    let ports = live_global().scripted(vec![
        Reply::Answer(PayoutAnswer::Refused),
        Reply::Answer(PayoutAnswer::Refused),
    ]);
    let r = ready(&db, ports);
    let fail_return = Arc::new(AtomicBool::new(true));
    {
        let (book, fail_return) = (r.b.ledger.clone(), fail_return.clone());
        r.b.ledger.set_hook(Some(Arc::new(move |_, key, booked| {
            // The forward entry is the first rail posting; the return is any rail posting after it.
            if !booked
                && fail_return.load(Ordering::SeqCst)
                && key.starts_with("bank.transfer.rail:")
                && book.rail().len() == 1
            {
                return Err(PostFailure::Unknown("ledger down".to_owned()));
            }
            Ok(())
        })));
    }
    r.send().refused("bank.global_outcome_unknown");
    assert_eq!(r.b.ledger.rail().len(), 1);
    assert_eq!(r.b.balance(), "90");
    let (status, failure, _, _) = r.row();
    assert_eq!((status.as_str(), failure), ("submitted", None));

    fail_return.store(false, Ordering::SeqCst);
    r.send().refused("bank.global_payout_refused");
    assert_eq!(r.b.ledger.rail().len(), 2);
    assert_eq!(r.b.balance(), "100");
    let (status, failure, tx, _) = r.row();
    assert_eq!(
        (status.as_str(), failure.as_deref(), tx),
        ("failed", Some("bank.global_payout_refused"), None)
    );
    r.b.ledger.set_hook(None);
}

#[test]
fn an_accepted_payout_with_no_usable_reference_or_status_is_unknown_not_sent_the_debit_stays_and_nothing_is_marked_paid()
 {
    let Some(db) = env() else { return };
    for answer in [
        accepted("   ", "sent"),
        accepted(&"x".repeat(129), "sent"),
        accepted("payout-8", "delivered-maybe"),
    ] {
        let r = ready(&db, live_global().scripted(vec![Reply::Answer(answer)]));
        r.send().refused("bank.global_outcome_unknown");
        assert_eq!(r.b.ledger.rail().len(), 1);
        assert_eq!(r.b.balance(), "90");
        let (status, _, _, provider) = r.row();
        assert_eq!((status.as_str(), provider), ("submitted", None));
    }
}
