//! Slice `global` with the TEST global-send stand-in the local stack runs, against the Rust door on a real Postgres.
//! Ports the describe "with the TEST global-send stand-in the local stack runs (global-sim.ts, the bank profile
//! catalogue)" of the TypeScript's `personal-pay/personal-pay.db.test.ts`, and `personal-pay/global-procedure-samples.test.ts`
//! (each `global.*` record's samples sent through the door), each test named after the TypeScript test's words. Every
//! TypeScript call there goes through the router, so every call here is a door call (`global.*`).
//!
//! The bank is wired as the TypeScript's `ready()` wires it: the stand-in's ports over the bank profile's catalogue
//! (`tooling/profiles/test-owner-values/bank.json`, `BANK_GLOBAL_SIM_JSON`), that profile's send-field rules and proof
//! limits, the suite's TEST payee controls and exchange allowance, and the custodial layer on so the ledger is posted to,
//! as the TypeScript's `MemoryLedger` is. The ledger is a stand-in that books `bankTransfer` as svc-ledger does (once per
//! key) and refuses too little money as `MemoryLedger` does; it can lose its answer after booking the next forward entry.
//! A blank owner value the TypeScript passes as `''` is `None` here, as `index.ts` hands it in (`global::Settings`).
//!
//! What is not ported as the TypeScript checks it, and why:
//! - `cause.blocker` (the corridor and payout refusals): the wire carries only `cause.code`. The blocker is checked on
//!   the failed send's `failureBlocker`, which is what a caller can read, and on the refusal table.
//! - The records' samples: the TypeScript mounts the global router over stub services, so each accepted sample answers
//!   200. The Rust router calls the slice's functions directly and has no service seam to stub, so an accepted sample
//!   here runs against the real slice over an empty database: it must pass the input check (never the 400 of a
//!   malformed input) and either answer 200 or refuse with a code its record lists, at the status the record gives it
//!   (the TypeScript's `PROCEDURE_REFUSALS_STRICT` check). Four accepted samples are refused by a code their record
//!   does not list; each is the TypeScript service's own refusal, so they are pinned by name (`RECORD_GAPS`) as gaps in
//!   the records, not in the port. The refused samples and the named refusals are as the TypeScript checks them.
//! - The step-up refusal of an unconfirmed `global.send`: the router reads the person's space before the step-up gate,
//!   as the TypeScript's does; its stub owns every space, so here the sample is sent from the person's own space.
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

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use base64::Engine as _;
use hmac::{Hmac, Mac};
use service_kit::edge;
use service_kit::json::{self, Json};
use service_kit::money::{Amount, format_amount, parse_amount};
use service_kit::s2s_verify::BodyBind;
use service_kit::server::Request;
use service_kit::time::js_date;
use sha2::{Digest, Sha256};
use svc_bank::db::Store;
use svc_bank::door::{self, BankDoor, DoorConfig, Kind, ServiceAuth};
use svc_bank::global::holds::SCREENING_OPERATOR;
use svc_bank::global::refusals;
use svc_bank::global::sim::{self, GLOBAL_SIM_RAIL, SimPorts};
use svc_bank::global::{Settings as GlobalSettings, Wiring as GlobalWiring};
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
use svc_bank::transfers::{Settings as TransfersSettings, Wiring as TransfersWiring};

use support::TestDb;

const SECRET: &str = "cccccccccccccccccccccccccccccccc";
const INTERNAL: &str = "a-bank-global-sim-db-internal-secret-ok";
const USER: &str = "11111111-1111-4111-8111-111111111111";
const OTHER: &str = "22222222-2222-4222-8222-222222222222";
const SID: &str = "77777777-7777-4777-8777-777777777777";
const OP_A: &str = "33333333-3333-4333-8333-333333333333";
const OP_B: &str = "44444444-4444-4444-8444-444444444444";
const READ: &[&str] = &["bank:read"];
const WRITE: &[&str] = &["bank:read", "bank:write"];
const COMPLIANCE: &[&str] = &["admin:read", "admin:compliance"];
const PAYEE_OK: &str = r#"{"blockedAccounts":[]}"#;
const ALLOWANCE_NONE: &str = r#"{"exchangeAccounts":[],"windowDays":30,"limits":[]}"#;

fn amt(s: &str) -> Amount {
    parse_amount(s).unwrap()
}

/// `stackValue(name)`: the bank profile's TEST value.
fn stack_value(name: &str) -> String {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../tooling/profiles/test-owner-values/bank.json");
    let profile = json::parse(&std::fs::read_to_string(path).unwrap()).unwrap();
    match profile
        .get("values")
        .and_then(|v| v.get(name))
        .and_then(|v| v.get("value"))
    {
        Some(Json::String(v)) => v.clone(),
        other => panic!("{name}: {other:?}"),
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Stand-ins: svc-ledger's book, the directory, the freeze.

type Acct = (String, String, String, String);

#[derive(Default)]
struct BookState {
    balances: BTreeMap<Acct, Amount>,
    journal: Vec<(String, LedgerTx)>,
    /// The next forward entry is booked and its answer lost (a timeout after the ledger took it).
    lose_next_forward: bool,
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
    /// `ledger.post(recipes.deposit({ userId, assetId: 'USDT', amount }))`.
    fn fund(&self, user: &str, amount: &str) {
        *self
            .0
            .lock()
            .unwrap()
            .balances
            .entry(acct(&LedgerAccount::user_available(user, "USDT")))
            .or_default() += amt(amount);
    }
    fn of(&self, a: &LedgerAccount) -> String {
        format_amount(
            self.0
                .lock()
                .unwrap()
                .balances
                .get(&acct(a))
                .copied()
                .unwrap_or(Amount::ZERO),
        )
    }
    /// `userAvailable(USER, 'USDT')`.
    fn balance(&self) -> String {
        self.of(&LedgerAccount::user_available(USER, "USDT"))
    }
    /// `railBoundary(GLOBAL_SIM_RAIL, 'USDT')`.
    fn rail(&self) -> String {
        self.of(&LedgerAccount {
            owner_type: "treasury",
            owner_id: format!("rail:{GLOBAL_SIM_RAIL}"),
            asset_id: "USDT".to_owned(),
            kind: "available",
            purpose: None,
        })
    }
    /// `transfers(ledger)`: the `bank.transfer.manual` entries, as (key, tx id), in order.
    fn transfers(&self) -> Vec<(String, String)> {
        self.0
            .lock()
            .unwrap()
            .journal
            .iter()
            .filter(|(k, _)| k.starts_with("bank.transfer.rail:"))
            .map(|(k, t)| (k.clone(), t.id.clone()))
            .collect()
    }
    /// `loseNextForwardAnswer(ledger)`.
    fn lose_next_forward_answer(&self) {
        self.0.lock().unwrap().lose_next_forward = true;
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
        assert_eq!(
            input.get("kind"),
            Some(&Json::str("manual")),
            "a rail entry is a manual transfer"
        );
        let mut st = self.0.lock().unwrap();
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
            // `MemoryLedger`'s refusal: no single-attempt stamp, so it proves nothing on its own.
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
        if st.lose_next_forward && key.ends_with(":0") {
            st.lose_next_forward = false;
            return Err(PostFailure::Unknown("answer lost".to_owned()));
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

// ---------------------------------------------------------------------------------------------------------------
// The door and its wiring

/// The owner values one `mount` passes; `None` is blank.
#[derive(Clone, Default)]
struct Mount {
    /// `globalSimPorts(catalogue)`: the catalogue's text, or none for the unset ports.
    catalogue: Option<String>,
    send_field_rules: Option<String>,
    proof_limits: Option<String>,
    hold_cancel_hours: Option<String>,
    receipt_secret: Option<String>,
    refund_fee: Option<String>,
    /// `transfers` step-up enforced (the samples' stub gate).
    step_up: bool,
}

fn blank(v: &str) -> Option<String> {
    (!v.trim().is_empty()).then(|| v.to_owned())
}

fn partner_wiring() -> PartnerWiring {
    PartnerWiring {
        partner: Some(TestPartner::new().unwrap()),
        freeze: Box::new(Open),
        // The custodial layer on: the send's entries reach the ledger, as `MemoryLedger` takes them in the TypeScript.
        custody_layer: "on".to_owned(),
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

/// `createBankServices(sql, ledger, ..., options)` and `createBankRouter(bank)`: the door over one database and ledger.
fn mount(db: &TestDb, ledger: &Book, m: &Mount) -> BankDoor {
    let env: BTreeMap<String, String> = [("APP_ENV", "test"), ("NODE_ENV", "test")]
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect();
    let ports: Box<dyn svc_bank::global::ports::GlobalPorts> = match &m.catalogue {
        Some(text) => Box::new(SimPorts::new(
            sim::parse(Some(text)).expect("the bank profile catalogue parses"),
            door::system_now,
        )),
        None => GlobalWiring::none().ports,
    };
    let mut transfers = TransfersWiring::none();
    transfers.settings = TransfersSettings {
        step_up_required: m.step_up,
        producer: "svc-bank".to_owned(),
        ..TransfersSettings::default()
    };
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
    .with_spaces(spaces_wiring(ledger))
    .with_transfers(transfers)
    .with_global(GlobalWiring {
        ports,
        settings: GlobalSettings {
            send_field_rules: m.send_field_rules.clone(),
            payee_controls: Some(PAYEE_OK.to_owned()),
            exchange_allowance: Some(ALLOWANCE_NONE.to_owned()),
            proof_limits: m.proof_limits.clone(),
            hold_cancel_hours: m.hold_cancel_hours.clone(),
            refund_fee: m.refund_fee.clone(),
            receipt_secret: m.receipt_secret.clone(),
        },
    })
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
    /// `cause.code`, or `ok` for an answer that is not a refusal.
    fn cause(&self) -> String {
        match self
            .1
            .get("error")
            .and_then(|e| e.get("data"))
            .and_then(|d| d.get("cause"))
            .and_then(|c| c.get("code"))
        {
            Some(Json::String(c)) => c.clone(),
            _ if self.0 == 200 => "ok".to_owned(),
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
        assert_ne!(self.0, 200, "{}", self.1.compact());
        assert_eq!(self.cause(), code, "{}", self.1.compact());
    }
}

/// One call through the door, as `user` with `scopes`; `None` sends no input.
fn call_raw(
    door: &BankDoor,
    user: &str,
    scopes: &[&str],
    path: &str,
    input: Option<&str>,
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
            input.unwrap_or_default().to_owned(),
        ),
    };
    let mut headers = person(user, scopes);
    headers.push(("content-type".to_owned(), "application/json".to_owned()));
    let res = door.handle_from(
        &Request {
            method,
            url: &url,
            headers: &headers,
            body: &body,
        },
        "req-global-sim-db",
        "127.0.0.1",
    );
    Answer(res.status, json::parse(&res.body).unwrap())
}

fn call(door: &BankDoor, user: &str, scopes: &[&str], path: &str, input: &Json) -> Answer {
    call_raw(door, user, scopes, path, Some(&input.compact()))
}

fn with_field(j: &Json, k: &str, v: Json) -> Json {
    let Json::Object(mut f) = j.clone() else {
        panic!()
    };
    match f.iter_mut().find(|(key, _)| key == k) {
        Some(slot) => slot.1 = v,
        None => f.push((k.to_owned(), v)),
    }
    Json::Object(f)
}

fn without(j: &Json, k: &str) -> Json {
    let Json::Object(mut f) = j.clone() else {
        panic!()
    };
    f.retain(|(key, _)| key != k);
    Json::Object(f)
}

/// A field as text: `null` for null or absent, a number or object as its JSON.
fn s(j: &Json, key: &str) -> String {
    match j.get(key) {
        Some(Json::String(v)) => v.clone(),
        Some(Json::Null) | None => "null".to_owned(),
        Some(other) => other.compact(),
    }
}

/// `toMatchObject` over flat fields: each `(key, want)` as [`s`] reads it.
fn matches(j: &Json, want: &[(&str, &str)]) {
    for (k, v) in want {
        assert_eq!(s(j, k), *v, "{k} in {}", j.compact());
    }
}

/// `expect.any(String)`.
fn is_text(j: &Json, key: &str) {
    assert!(
        matches!(j.get(key), Some(Json::String(_))),
        "{key} in {}",
        j.compact()
    );
}

fn items(j: &Json) -> Vec<Json> {
    match j {
        Json::Array(a) => a.clone(),
        other => match other.get("items") {
            Some(Json::Array(a)) => a.clone(),
            x => panic!("no items: {x:?}"),
        },
    }
}

fn uuid() -> String {
    service_kit::approvals::random_uuid().unwrap()
}

// ---------------------------------------------------------------------------------------------------------------
// `caller`: global sends confirmed on a rate lock, as the Pay card does.

/// `caller(bank, userId, scopes)`: a send that names no `quoteId` takes one quote for its amount and currency, once per
/// idempotency key, so a replay carries the same lock; while the rate source refuses, the send goes without one.
struct Caller<'a> {
    door: &'a BankDoor,
    store: &'a Store,
    user: &'static str,
    scopes: &'static [&'static str],
    locks: RefCell<BTreeMap<String, Option<String>>>,
}

impl<'a> Caller<'a> {
    fn new(r: &'a Ready, user: &'static str, scopes: &'static [&'static str]) -> Caller<'a> {
        Caller::on(&r.door, &r.store, user, scopes)
    }
    fn on(
        door: &'a BankDoor,
        store: &'a Store,
        user: &'static str,
        scopes: &'static [&'static str],
    ) -> Caller<'a> {
        Caller {
            door,
            store,
            user,
            scopes,
            locks: RefCell::new(BTreeMap::new()),
        }
    }
    fn call(&self, path: &str, input: &Json) -> Answer {
        call(self.door, self.user, self.scopes, path, input)
    }
    fn get(&self, path: &str, input: &Json) -> Json {
        self.call(path, input).ok()
    }
    /// `me.global.quote(...)`.
    fn quote(&self, asset: &str, amount: &str, to: &str) -> Answer {
        self.call(
            "global.quote",
            &Json::obj([
                ("asset", Json::str(asset)),
                ("amount", Json::str(amount)),
                ("toCurrency", Json::str(to)),
            ]),
        )
    }
    /// `me.global.send(input)`.
    fn send(&self, input: &Json) -> Answer {
        if input.get("quoteId").is_some() {
            return self.call("global.send", input);
        }
        let key = s(input, "idempotencyKey");
        if !self.locks.borrow().contains_key(&key) {
            let asset = space::with(self.store, |c| space::get(c, &s(input, "fromSpaceId")))
                .map_or_else(|_| "USDT".to_owned(), |sp| sp.asset_id);
            let q = self.quote(&asset, &s(input, "amount"), &s(input, "toCurrency"));
            let lock = (q.0 == 200).then(|| s(&q.ok(), "quoteId"));
            self.locks.borrow_mut().insert(key.clone(), lock);
        }
        match self.locks.borrow().get(&key).cloned().flatten() {
            Some(q) => self.call("global.send", &with_field(input, "quoteId", Json::str(q))),
            None => self.call("global.send", input),
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------
// `ready()`

struct Ready {
    door: BankDoor,
    store: Store,
    ledger: Book,
    /// The send body: 40 USDT to Ada in DE, by SEPA, under a fresh key.
    body: Json,
}

/// The owner values `ready(extra)` mounts: the stand-in over the profile's catalogue, its send-field rules and proof
/// limits, and `extra`.
fn stand_in(extra: Mount) -> Mount {
    Mount {
        catalogue: Some(stack_value("BANK_GLOBAL_SIM_JSON")),
        send_field_rules: Some(stack_value("BANK_SEND_FIELD_RULES_JSON")),
        proof_limits: Some(stack_value("BANK_PROOF_LIMITS_JSON")),
        ..extra
    }
}

/// `ready(extra)`: a fresh bank and ledger over the database, the person's main USDT space funded 100, Ada saved as a
/// recipient, and the send body.
fn ready(db: &TestDb, extra: Mount) -> Ready {
    let ledger = Book::default();
    let door = mount(db, &ledger, &stand_in(extra));
    let store = db.store();
    ledger.fund(USER, "100");
    let space = space::with(&store, |c| space::ensure_primary(c, USER, "USDT"))
        .unwrap()
        .id;
    let saved = call(
        &door,
        USER,
        WRITE,
        "global.recipients.add",
        &Json::obj([
            ("idempotencyKey", Json::str(format!("recip-{}", uuid()))),
            ("name", Json::str("Ada")),
            ("account", Json::str("DE89370400440532013000")),
            ("country", Json::str("DE")),
        ]),
    )
    .ok();
    let body = Json::obj([
        ("fromSpaceId", Json::str(space)),
        ("amount", Json::str("40")),
        ("toCurrency", Json::str("EUR")),
        ("recipientId", Json::str(s(&saved, "id"))),
        ("country", Json::str("DE")),
        ("deliveryMethod", Json::str("sepa")),
        ("idempotencyKey", Json::str(format!("send-{}", uuid()))),
    ]);
    Ready {
        door,
        store,
        ledger,
        body,
    }
}

fn db() -> Option<TestDb> {
    let db = TestDb::new()?;
    db.migrated();
    Some(db)
}

fn sql(db: &TestDb, q: &str) {
    db.client().execute(q, &[]).unwrap();
}

/// `{ ...body, idempotencyKey: 'send-<fresh>' }`.
fn fresh(body: &Json) -> Json {
    with_field(
        body,
        "idempotencyKey",
        Json::str(format!("send-{}", uuid())),
    )
}

fn quote_id(q: &str) -> Json {
    Json::str(q)
}

/// The send's row as stored: (status, ledger_tx_id).
fn stored(db: &TestDb, key: &str) -> (String, Option<String>) {
    let row = db
        .client()
        .query_one(
            "SELECT status, ledger_tx_id FROM bank.global_sends WHERE user_id::text = $1 AND idempotency_key = $2",
            &[&USER, &key],
        )
        .unwrap();
    (row.get(0), row.get(1))
}

/// `held(ledger, me, body)`: a 500 USDT send, screened and held with nothing posted.
fn held(r: &Ready, me: &Caller<'_>) -> (Json, Json) {
    r.ledger.fund(USER, "500");
    let big = with_field(&fresh(&r.body), "amount", Json::str("500"));
    let waiting = me.send(&big).ok();
    matches(&waiting, &[("status", "held"), ("ledgerTxId", "null")]);
    (big, waiting)
}

fn by_id(list: &[Json], id: &str) -> Option<Json> {
    list.iter().find(|one| s(one, "id") == id).cloned()
}

fn id_of(id: &str) -> Json {
    Json::obj([("id", Json::str(id))])
}

fn send_id_of(id: &str) -> Json {
    Json::obj([("sendId", Json::str(id))])
}

fn limit(n: i64) -> Json {
    Json::obj([("limit", Json::int(n))])
}

// ---------------------------------------------------------------------------------------------------------------
// The describe: "with the TEST global-send stand-in the local stack runs (global-sim.ts, the bank profile catalogue)"

#[test]
fn posts_the_send_once_to_the_stand_in_rail_boundary_keeps_its_test_quote_and_a_retry_posts_nothing()
 {
    let Some(db) = db() else { return };
    let r = ready(&db, Mount::default());
    let me = Caller::new(&r, USER, WRITE);
    let sent = me.send(&r.body).ok();
    matches(
        &sent,
        &[
            ("status", "sent"),
            ("quoteRate", "2"),
            ("quoteFee", "0"),
            ("quoteReceive", "80"),
        ],
    );
    is_text(&sent, "ledgerTxId");
    let id = s(&sent, "id");
    assert_eq!(s(&sent, "providerRef"), format!("TEST-{id}"));
    // One forward entry, keyed by the send.
    assert_eq!(
        r.ledger.transfers(),
        vec![(format!("bank.transfer.rail:{id}:0"), s(&sent, "ledgerTxId"))]
    );
    assert_eq!(r.ledger.balance(), "60");
    // Exactly the amount reached the stand-in's rail boundary: one leg in, nothing else.
    assert_eq!(r.ledger.rail(), "40");
    // The same request again is the same send: nothing more leaves the account.
    matches(&me.send(&r.body).ok(), &[("id", &id), ("status", "sent")]);
    assert_eq!(r.ledger.transfers().len(), 1);
    assert_eq!(r.ledger.balance(), "60");
    // The stand-in's own record of what it paid out (not in this TypeScript test: the brief's check).
    let paid = call(
        &r.door,
        OP_A,
        COMPLIANCE,
        "global.ops.standInPayout",
        &send_id_of(&id),
    )
    .ok();
    matches(
        &paid,
        &[
            ("sendId", &id),
            ("quoteId", &s(&sent, "quoteId")),
            ("assetId", "USDT"),
            ("amount", "40"),
            ("toCurrency", "EUR"),
            ("rate", "2"),
            ("receiveAmount", "80"),
            ("conversions", "1"),
            ("calls", "1"),
        ],
    );
}

#[test]
fn a_quote_is_a_rate_lock_the_send_confirmed_on_it_is_paid_at_its_figures_once_and_the_lock_pays_one_send_only()
 {
    let Some(db) = db() else { return };
    let r = ready(&db, Mount::default());
    let me = Caller::new(&r, USER, WRITE);
    let lock = me.quote("USDT", "40", "EUR").ok();
    is_text(&lock, "quoteId");
    matches(
        &lock,
        &[
            ("rate", "2"),
            ("fee", "0"),
            ("feeAsset", "USDT"),
            ("receiveAmount", "80"),
        ],
    );
    let q = s(&lock, "quoteId");
    let sent = me.send(&with_field(&r.body, "quoteId", quote_id(&q))).ok();
    matches(
        &sent,
        &[
            ("status", "sent"),
            ("quoteId", &q),
            ("quoteRate", &s(&lock, "rate")),
            ("quoteFee", &s(&lock, "fee")),
            ("quoteReceive", &s(&lock, "receiveAmount")),
            ("quoteValidUntil", &s(&lock, "validUntil")),
            ("quoteEta", &s(&lock, "eta")),
        ],
    );
    // Confirming again (the same key) is the same send: one posting of exactly the amount, nothing more.
    matches(
        &me.send(&with_field(&r.body, "quoteId", quote_id(&q))).ok(),
        &[("id", &s(&sent, "id")), ("status", "sent")],
    );
    assert_eq!(r.ledger.transfers().len(), 1);
    assert_eq!(r.ledger.balance(), "60");
    assert_eq!(r.ledger.rail(), "40");
    // A second send on the same lock is refused and nothing is recorded or posted for it.
    me.send(&with_field(&fresh(&r.body), "quoteId", quote_id(&q)))
        .refused("bank.global_quote_used");
    // A lock for other figures, or someone else's lock, pays nothing.
    let other = s(&me.quote("USDT", "41", "EUR").ok(), "quoteId");
    me.send(&with_field(&fresh(&r.body), "quoteId", quote_id(&other)))
        .refused("bank.global_quote_mismatch");
    let gbp = s(&me.quote("USDT", "40", "GBP").ok(), "quoteId");
    me.send(&with_field(&fresh(&r.body), "quoteId", quote_id(&gbp)))
        .refused("bank.global_quote_mismatch");
    let theirs = s(
        &Caller::new(&r, OTHER, WRITE)
            .quote("USDT", "40", "EUR")
            .ok(),
        "quoteId",
    );
    me.send(&with_field(&fresh(&r.body), "quoteId", quote_id(&theirs)))
        .refused("bank.global_quote_not_found");
    me.send(&with_field(
        &fresh(&r.body),
        "quoteId",
        quote_id("99999999-9999-4999-8999-999999999999"),
    ))
    .refused("bank.global_quote_not_found");
    assert_eq!(r.ledger.transfers().len(), 1);
    assert_eq!(items(&me.get("global.list", &limit(10))).len(), 1);
    // Taking a quote is a write the customer's session makes: a read-only session cannot lock a rate.
    assert_ne!(
        Caller::new(&r, USER, READ).quote("USDT", "40", "EUR").0,
        200
    );
}

#[test]
fn a_send_confirmed_after_its_lock_ran_out_or_on_none_is_refused_with_nothing_posted_and_the_intent_row_kept_with_why()
 {
    let Some(db) = db() else { return };
    let r = ready(&db, Mount::default());
    let me = Caller::new(&r, USER, WRITE);
    let q = s(&me.quote("USDT", "40", "EUR").ok(), "quoteId");
    sql(
        &db,
        &format!(
            "UPDATE bank.global_quotes SET valid_until = now() - interval '1 second' WHERE id = '{q}'"
        ),
    );
    me.send(&with_field(&r.body, "quoteId", quote_id(&q)))
        .refused("bank.global_quote_expired");
    // The same confirmation again gives the same answer; a new quote is the only way on.
    me.send(&with_field(&r.body, "quoteId", quote_id(&q)))
        .refused("bank.global_quote_expired");
    let unlocked = fresh(&r.body);
    // `rawCaller`: no lock taken for it.
    call(&r.door, USER, WRITE, "global.send", &unlocked).refused("bank.global_quote_required");
    assert_eq!(r.ledger.transfers().len(), 0);
    assert_eq!(r.ledger.balance(), "100");
    let mut rows: Vec<(String, String, String)> = items(&me.get("global.list", &limit(10)))
        .iter()
        .map(|row| {
            (
                s(row, "status"),
                s(row, "failureCode"),
                s(row, "ledgerTxId"),
            )
        })
        .collect();
    rows.sort();
    assert_eq!(
        rows,
        vec![
            (
                "failed".to_owned(),
                "bank.global_quote_expired".to_owned(),
                "null".to_owned()
            ),
            (
                "failed".to_owned(),
                "bank.global_quote_required".to_owned(),
                "null".to_owned()
            ),
        ]
    );
    let again = me.send(&fresh(&r.body)).ok();
    matches(
        &again,
        &[
            ("status", "sent"),
            ("quoteRate", "2"),
            ("quoteReceive", "80"),
        ],
    );
    assert_eq!(r.ledger.balance(), "60");
}

#[test]
fn a_send_recorded_inside_its_lock_but_never_driven_is_not_paid_at_that_lock_once_it_has_run_out_a_lock_id_in_capitals_is_the_same_lock()
 {
    let Some(db) = db() else { return };
    let r = ready(&db, Mount::default());
    let me = Caller::new(&r, USER, WRITE);
    let q = s(&me.quote("USDT", "40", "EUR").ok(), "quoteId");
    // Stranded: the instruction was recorded while the lock lasted, and nothing drove it (a stop between the two).
    let id = uuid();
    sql(
        &db,
        &format!(
            "INSERT INTO bank.global_sends (id, user_id, idempotency_key, from_space_id, asset_id, amount, to_currency, \
             recipient_id, country, delivery_method, quote_id, status) \
             VALUES ('{id}', '{USER}', '{}', '{}', 'USDT', '40', 'EUR', '{}', 'DE', 'sepa', '{q}', 'submitted')",
            s(&r.body, "idempotencyKey"),
            s(&r.body, "fromSpaceId"),
            s(&r.body, "recipientId"),
        ),
    );
    sql(
        &db,
        &format!(
            "UPDATE bank.global_quotes SET valid_until = now() - interval '1 second' WHERE id = '{q}'"
        ),
    );
    me.send(&with_field(&r.body, "quoteId", quote_id(&q.to_uppercase())))
        .refused("bank.global_quote_expired");
    assert_eq!(r.ledger.transfers().len(), 0);
    assert_eq!(r.ledger.balance(), "100");
    // Inside a lock, capitals change nothing: the send is recorded on the lock as written and paid at it.
    let next = s(&me.quote("USDT", "40", "EUR").ok(), "quoteId");
    let again = fresh(&r.body);
    let sent = me
        .send(&with_field(
            &again,
            "quoteId",
            quote_id(&next.to_uppercase()),
        ))
        .ok();
    matches(
        &sent,
        &[
            ("status", "sent"),
            ("quoteId", &next),
            ("quoteReceive", "80"),
        ],
    );
    matches(
        &me.send(&with_field(&again, "quoteId", quote_id(&next)))
            .ok(),
        &[("id", &s(&sent, "id")), ("status", "sent")],
    );
    assert_eq!(r.ledger.transfers().len(), 1);
}

#[test]
fn a_forward_entry_the_ledger_accepted_but_whose_answer_was_lost_is_paid_at_the_lock_on_the_retry_even_after_the_lock_ran_out()
 {
    let Some(db) = db() else { return };
    let r = ready(&db, Mount::default());
    let me = Caller::new(&r, USER, WRITE);
    let q = s(&me.quote("USDT", "40", "EUR").ok(), "quoteId");
    r.ledger.lose_next_forward_answer();
    assert_ne!(
        me.send(&with_field(&r.body, "quoteId", quote_id(&q))).0,
        200
    );
    assert_eq!(r.ledger.transfers().len(), 1);
    assert_eq!(r.ledger.balance(), "60");
    let key = s(&r.body, "idempotencyKey");
    assert_eq!(stored(&db, &key), ("submitted".to_owned(), None));
    // The customer retries after the lock ran out (it was confirmed inside it): the posted send is paid at its lock, not
    // failed with the debit stranded.
    sql(
        &db,
        &format!(
            "UPDATE bank.global_quotes \
             SET valid_until = (SELECT created_at FROM bank.global_sends WHERE quote_id = '{q}') + interval '1 millisecond' \
             WHERE id = '{q}'"
        ),
    );
    let sent = me.send(&with_field(&r.body, "quoteId", quote_id(&q))).ok();
    matches(
        &sent,
        &[
            ("status", "sent"),
            ("quoteId", &q),
            ("quoteRate", "2"),
            ("quoteReceive", "80"),
        ],
    );
    assert_eq!(s(&sent, "ledgerTxId"), r.ledger.transfers()[0].1);
    assert_eq!(r.ledger.transfers().len(), 1);
    assert_eq!(r.ledger.balance(), "60");
}

#[test]
fn a_posted_but_unrecorded_send_whose_corridor_went_away_before_the_retry_is_left_open_as_unknown_never_failed_with_the_debit_stranded()
 {
    let Some(db) = db() else { return };
    let r = ready(&db, Mount::default());
    let me = Caller::new(&r, USER, WRITE);
    let q = s(&me.quote("USDT", "40", "EUR").ok(), "quoteId");
    r.ledger.lose_next_forward_answer();
    assert_ne!(
        me.send(&with_field(&r.body, "quoteId", quote_id(&q))).0,
        200
    );
    // The partner's catalogue drops the corridor before the retry: a refusal now would strand the posted debit.
    let Json::Object(mut catalogue) = json::parse(&stack_value("BANK_GLOBAL_SIM_JSON")).unwrap()
    else {
        panic!()
    };
    for (k, v) in &mut catalogue {
        if k == "corridors"
            && let Json::Array(rows) = v
        {
            rows.retain(|row| s(row, "country") != "DE");
        }
    }
    let later = mount(
        &db,
        &r.ledger,
        &Mount {
            catalogue: Some(Json::Object(catalogue).compact()),
            send_field_rules: Some(stack_value("BANK_SEND_FIELD_RULES_JSON")),
            proof_limits: Some(stack_value("BANK_PROOF_LIMITS_JSON")),
            ..Mount::default()
        },
    );
    let store = db.store();
    Caller::on(&later, &store, USER, WRITE)
        .send(&with_field(&r.body, "quoteId", quote_id(&q)))
        .refused("bank.global_outcome_unknown");
    let key = s(&r.body, "idempotencyKey");
    assert_eq!(
        stored(&db, &key),
        (
            "submitted".to_owned(),
            Some(r.ledger.transfers()[0].1.clone())
        )
    );
    assert_eq!(r.ledger.transfers().len(), 1);
    assert_eq!(r.ledger.balance(), "60");
}

#[test]
fn a_send_held_for_review_is_paid_at_the_lock_it_was_confirmed_on_even_when_released_after_the_lock_ran_out()
 {
    let Some(db) = db() else { return };
    let r = ready(&db, Mount::default());
    let me = Caller::new(&r, USER, WRITE);
    r.ledger.fund(USER, "500");
    let q = s(&me.quote("USDT", "500", "EUR").ok(), "quoteId");
    let waiting = me
        .send(&with_field(
            &with_field(&r.body, "amount", Json::str("500")),
            "quoteId",
            quote_id(&q),
        ))
        .ok();
    matches(
        &waiting,
        &[("status", "held"), ("ledgerTxId", "null"), ("quoteId", &q)],
    );
    let id = s(&waiting, "id");
    // The lock runs out while the send waits, after the customer confirmed inside it.
    sql(
        &db,
        &format!(
            "UPDATE bank.global_quotes SET valid_until = (SELECT created_at FROM bank.global_sends WHERE id = '{id}') \
             + interval '1 millisecond' WHERE id = '{q}'"
        ),
    );
    let released = call(
        &r.door,
        OP_B,
        COMPLIANCE,
        "global.ops.release",
        &send_id_of(&id),
    )
    .ok();
    matches(
        &released,
        &[
            ("id", &id),
            ("status", "sent"),
            ("quoteRate", "2"),
            ("quoteReceive", "1000"),
            ("quoteId", &q),
        ],
    );
    assert_eq!(r.ledger.transfers().len(), 1);
    assert_eq!(r.ledger.balance(), "100");
}

#[test]
fn a_usdt_send_at_or_over_its_test_review_amount_is_put_on_hold_with_nothing_posted_asked_for_a_file_released_it_posts_once()
 {
    let Some(db) = db() else { return };
    let r = ready(&db, Mount::default());
    let me = Caller::new(&r, USER, WRITE);
    // The profile's TEST review amount is 500 USDT; the TEST deposit is 100, so fund the rest.
    r.ledger.fund(USER, "500");
    let big = with_field(&fresh(&r.body), "amount", Json::str("500"));
    let waiting = me.send(&big).ok();
    matches(&waiting, &[("status", "held"), ("ledgerTxId", "null")]);
    let id = s(&waiting, "id");
    assert_eq!(r.ledger.transfers().len(), 0);
    // It waits in the compliance queue, placed by the screening, and the customer sees the hold with nothing asked yet.
    let ops = Caller::new(&r, OP_A, COMPLIANCE);
    let queue = items(&ops.get("global.ops.holds", &limit(10)));
    let mine = queue
        .iter()
        .find(|one| s(one, "sendId") == id)
        .expect("in the queue");
    matches(
        mine,
        &[("heldBy", SCREENING_OPERATOR), ("infoRequest", "null")],
    );
    matches(
        &me.get("global.hold.get", &id_of(&id)),
        &[("state", "requested"), ("infoRequest", "null")],
    );
    // The same request again is the same held send: nothing is posted.
    matches(
        &me.send(&big).ok(),
        &[("id", &id), ("status", "held"), ("ledgerTxId", "null")],
    );
    assert_eq!(r.ledger.balance(), "600");
    // A smaller send is not screened.
    matches(&me.send(&r.body).ok(), &[("status", "sent")]);
    assert_eq!(r.ledger.rail(), "40");
    // Compliance asks for a document; the customer uploads once; an operator releases it and it posts, once.
    ops.get(
        "global.ops.requestInfo",
        &Json::obj([
            ("sendId", Json::str(&id)),
            ("infoRequest", Json::str("TEST: a bank statement")),
        ]),
    );
    matches(
        &me.get("global.hold.get", &id_of(&id)),
        &[
            ("state", "requested"),
            ("infoRequest", "TEST: a bank statement"),
        ],
    );
    let file = base64::engine::general_purpose::STANDARD.encode(b"%PDF-1.4 TEST");
    matches(
        &me.get(
            "global.hold.uploadProof",
            &Json::obj([
                ("id", Json::str(&id)),
                ("name", Json::str("statement.pdf")),
                ("type", Json::str("application/pdf")),
                ("contentBase64", Json::str(file)),
            ]),
        ),
        &[("state", "under_review"), ("proofUploaded", "true")],
    );
    assert_eq!(r.ledger.transfers().len(), 1);
    let released = Caller::new(&r, OP_B, COMPLIANCE).get("global.ops.release", &send_id_of(&id));
    matches(&released, &[("status", "sent")]);
    is_text(&released, "ledgerTxId");
    assert_eq!(r.ledger.transfers().len(), 2);
    assert!(r.ledger.transfers().iter().any(
        |(k, t)| *k == format!("bank.transfer.rail:{id}:0") && *t == s(&released, "ledgerTxId")
    ));
    assert_eq!(r.ledger.rail(), "540");
    assert_eq!(r.ledger.balance(), "60");
    // Screened once: a replay after the release is the same sent send, never a second hold or posting.
    matches(&me.send(&big).ok(), &[("id", &id), ("status", "sent")]);
    assert_eq!(r.ledger.transfers().len(), 2);
}

#[test]
fn a_screened_send_whose_balance_was_spent_while_it_waited_fails_on_release_with_nothing_posted() {
    let Some(db) = db() else { return };
    let r = ready(&db, Mount::default());
    let me = Caller::new(&r, USER, WRITE);
    r.ledger.fund(USER, "500");
    let waiting = me
        .send(&with_field(&fresh(&r.body), "amount", Json::str("500")))
        .ok();
    matches(&waiting, &[("status", "held")]);
    let id = s(&waiting, "id");
    // Nothing is reserved while it waits, as for any hold: the customer spends 200 of the 600 elsewhere.
    matches(
        &me.send(&with_field(&fresh(&r.body), "amount", Json::str("200")))
            .ok(),
        &[("status", "sent")],
    );
    call(
        &r.door,
        OP_A,
        COMPLIANCE,
        "global.ops.release",
        &send_id_of(&id),
    )
    .refused("bank.global_insufficient_funds");
    matches(
        &me.get("global.get", &id_of(&id)),
        &[("status", "failed"), ("ledgerTxId", "null")],
    );
    assert_eq!(r.ledger.rail(), "200");
    assert_eq!(r.ledger.balance(), "400");
    assert_eq!(r.ledger.transfers().len(), 1);
}

#[test]
fn the_customer_cancels_a_send_on_hold_once_nothing_posts_it_leaves_the_queue_and_neither_a_release_nor_a_replay_moves_it()
 {
    let Some(db) = db() else { return };
    let r = ready(
        &db,
        Mount {
            hold_cancel_hours: Some("72".to_owned()),
            ..Mount::default()
        },
    );
    let me = Caller::new(&r, USER, WRITE);
    let (big, waiting) = held(&r, &me);
    let id = s(&waiting, "id");
    let hold = me.get("global.hold.get", &id_of(&id));
    let auto = hold.get("autoCancel").unwrap();
    matches(auto, &[("state", "published"), ("hours", "72")]);
    let at = js_date(&s(auto, "at")).unwrap().0;
    let created = js_date(&s(&waiting, "createdAt")).unwrap().0;
    assert!(at - created >= 72 * 3_600_000 - 60_000, "{at} - {created}");
    // A send that left cannot be cancelled; someone else's send is not found.
    let sent = me.send(&r.body).ok();
    me.call("global.cancel", &id_of(&s(&sent, "id")))
        .refused("bank.global_send_not_cancellable");
    Caller::new(&r, OTHER, WRITE)
        .call("global.cancel", &id_of(&id))
        .refused("bank.global_not_found");
    let cancelled = me.get("global.cancel", &id_of(&id));
    matches(
        &cancelled,
        &[
            ("id", &id),
            ("status", "cancelled"),
            ("cancelledBy", "customer"),
            ("ledgerTxId", "null"),
        ],
    );
    matches(
        &me.get("global.cancel", &id_of(&id)),
        &[("status", "cancelled"), ("cancelledBy", "customer")],
    );
    let queue = items(&Caller::new(&r, OP_A, COMPLIANCE).get("global.ops.holds", &limit(50)));
    assert!(!queue.iter().any(|one| s(one, "sendId") == id));
    call(
        &r.door,
        OP_B,
        COMPLIANCE,
        "global.ops.release",
        &send_id_of(&id),
    )
    .refused("bank.hold_not_found");
    matches(&me.send(&big).ok(), &[("id", &id), ("status", "cancelled")]);
    assert_eq!(r.ledger.transfers().len(), 1);
    assert_eq!(r.ledger.balance(), "560");
}

#[test]
fn the_owner_window_cancels_a_send_still_on_hold_that_long_on_read_or_at_release_blank_nothing_is_cancelled_and_the_rule_says_so()
 {
    let Some(db) = db() else { return };
    let r = ready(
        &db,
        Mount {
            hold_cancel_hours: Some("72".to_owned()),
            ..Mount::default()
        },
    );
    let me = Caller::new(&r, USER, WRITE);
    let age = |id: &str| {
        sql(
            &db,
            &format!(
                "UPDATE bank.global_send_holds SET created_at = now() - interval '73 hours' WHERE send_id = '{id}'"
            ),
        );
    };
    let first = s(&held(&r, &me).1, "id");
    age(&first);
    // Reading the sends applies the window.
    let listed = items(&me.get("global.list", &limit(10)));
    matches(
        &by_id(&listed, &first).unwrap(),
        &[("status", "cancelled"), ("cancelledBy", "auto")],
    );
    let hold = me.get("global.hold.get", &id_of(&first));
    matches(&hold, &[("state", "cancelled")]);
    matches(hold.get("autoCancel").unwrap(), &[("at", "null")]);
    // A release of a send past the window cancels it instead of posting.
    r.ledger.fund(USER, "500");
    let second = s(
        &me.send(&with_field(&fresh(&r.body), "amount", Json::str("500")))
            .ok(),
        "id",
    );
    age(&second);
    call(
        &r.door,
        OP_B,
        COMPLIANCE,
        "global.ops.release",
        &send_id_of(&second),
    )
    .refused("bank.global_send_cancelled");
    matches(
        &me.get("global.get", &id_of(&second)),
        &[
            ("status", "cancelled"),
            ("cancelledBy", "auto"),
            ("ledgerTxId", "null"),
        ],
    );
    assert_eq!(r.ledger.transfers().len(), 0);
    assert_eq!(r.ledger.balance(), "1100");

    // Blank window: the rule reads unset, and an old hold stays on hold.
    let blank = ready(&db, Mount::default());
    let blank_me = Caller::new(&blank, USER, WRITE);
    assert_eq!(
        blank_me.get("global.autoCancelRule", &Json::Null).compact(),
        r#"{"state":"unset","hours":null}"#
    );
    let third = s(&held(&blank, &blank_me).1, "id");
    age(&third);
    matches(
        &blank_me.get("global.get", &id_of(&third)),
        &[("status", "held")],
    );
    assert_eq!(
        blank_me
            .get("global.hold.get", &id_of(&third))
            .get("autoCancel")
            .unwrap()
            .compact(),
        r#"{"state":"unset","hours":null,"at":null}"#
    );
}

#[test]
fn a_send_that_left_is_asked_back_once_the_rail_return_shows_bounced_back_another_operator_refunds_it_crediting_once()
 {
    let Some(db) = db() else { return };
    let r = ready(
        &db,
        Mount {
            refund_fee: blank(&stack_value("BANK_GLOBAL_REFUND_FEE")),
            ..Mount::default()
        },
    );
    let me = Caller::new(&r, USER, WRITE);
    let sent = me.send(&r.body).ok();
    matches(
        &sent,
        &[
            ("status", "sent"),
            ("recallReason", "null"),
            ("returnRef", "null"),
        ],
    );
    let id = s(&sent, "id");
    assert_eq!(r.ledger.balance(), "60");
    // The customer asks for it back: kept on the send, nothing moves; asking again is the same request.
    let recall = |reason: &str, who: &Caller<'_>, send: &str| {
        who.call(
            "global.recall",
            &Json::obj([("id", Json::str(send)), ("reason", Json::str(reason))]),
        )
    };
    let asked = recall("Wrong account number", &me, &id).ok();
    matches(
        &asked,
        &[("status", "sent"), ("recallReason", "Wrong account number")],
    );
    is_text(&asked, "recallRequestedAt");
    matches(
        &recall("Another reason", &me, &id).ok(),
        &[("recallReason", "Wrong account number")],
    );
    recall("mine", &Caller::new(&r, OTHER, WRITE), &id).refused("bank.global_not_found");
    let ops_a = Caller::new(&r, OP_A, COMPLIANCE);
    let ops_b = Caller::new(&r, OP_B, COMPLIANCE);
    assert!(
        items(&ops_a.get("global.ops.recalls", &limit(100)))
            .iter()
            .any(|one| s(one, "id") == id)
    );
    assert_eq!(r.ledger.transfers().len(), 1);
    // Nothing to refund before the rail sends it back.
    ops_b
        .call("global.ops.refundReturn", &send_id_of(&id))
        .refused("bank.global_not_returned");
    // The rail returns it: bounced back, recorded with the rail's reference; nothing posts yet.
    let reference = format!("TEST-RETURN-{}", uuid());
    let record = |who: &Caller<'_>, send: &str, rref: &str| {
        who.call(
            "global.ops.recordReturn",
            &Json::obj([("sendId", Json::str(send)), ("returnRef", Json::str(rref))]),
        )
    };
    let returned = record(&ops_a, &id, &reference).ok();
    matches(
        &returned,
        &[
            ("status", "returned"),
            ("returnRef", &reference),
            ("refundedAt", "null"),
        ],
    );
    is_text(&returned, "returnedAt");
    matches(
        &record(&ops_a, &id, &reference).ok(),
        &[("status", "returned")],
    );
    record(&ops_a, &id, &format!("{reference}-2")).refused("bank.global_return_conflict");
    let other = s(&me.send(&fresh(&r.body)).ok(), "id");
    record(&ops_a, &other, &reference).refused("bank.global_return_conflict");
    matches(
        &me.get("global.get", &id_of(&id)),
        &[("status", "returned")],
    );
    assert_eq!(r.ledger.balance(), "20");
    // Four-eyes: the operator who recorded the return cannot refund it.
    ops_a
        .call("global.ops.refundReturn", &send_id_of(&id))
        .refused("bank.refund_same_operator");
    let refunded = ops_b.get("global.ops.refundReturn", &send_id_of(&id));
    matches(&refunded, &[("status", "refunded")]);
    is_text(&refunded, "refundedAt");
    assert_eq!(r.ledger.transfers().len(), 3);
    // The entry back is the send's occurrence 1.
    assert!(
        r.ledger
            .transfers()
            .iter()
            .any(|(k, _)| *k == format!("bank.transfer.rail:{id}:1"))
    );
    assert_eq!(r.ledger.balance(), "60");
    assert_eq!(r.ledger.rail(), "40");
    // Credits once: a retry, by either operator, posts nothing more.
    matches(
        &ops_b.get("global.ops.refundReturn", &send_id_of(&id)),
        &[("status", "refunded")],
    );
    matches(
        &ops_a.get("global.ops.refundReturn", &send_id_of(&id)),
        &[("status", "refunded")],
    );
    assert_eq!(r.ledger.transfers().len(), 3);
    assert_eq!(r.ledger.balance(), "60");
    // Refunded, it leaves the recall queue; it cannot be asked back again, but the request stays on it.
    assert!(
        !items(&ops_a.get("global.ops.recalls", &limit(100)))
            .iter()
            .any(|one| s(one, "id") == id)
    );
    matches(
        &recall("again", &me, &id).ok(),
        &[
            ("status", "refunded"),
            ("recallReason", "Wrong account number"),
        ],
    );
    record(&ops_a, &id, &format!("{reference}-3")).refused("bank.global_return_conflict");
    // A send returned with no request cannot be asked back after it came back.
    record(&ops_a, &other, &format!("{reference}-other")).ok();
    recall("late", &me, &other).refused("bank.global_not_recallable");
}

#[test]
fn refuses_to_refund_a_return_while_the_refund_fee_is_blank_or_not_zero_and_a_send_that_never_left_cannot_be_returned()
 {
    let Some(db) = db() else { return };
    for (refund_fee, code) in [
        ("", "bank.refund_fee_unset"),
        ("0.5", "bank.refund_fee_unsupported"),
    ] {
        let r = ready(
            &db,
            Mount {
                refund_fee: blank(refund_fee),
                ..Mount::default()
            },
        );
        let me = Caller::new(&r, USER, WRITE);
        let sent = s(&me.send(&r.body).ok(), "id");
        call(
            &r.door,
            OP_A,
            COMPLIANCE,
            "global.ops.recordReturn",
            &Json::obj([
                ("sendId", Json::str(&sent)),
                ("returnRef", Json::str(format!("TEST-RETURN-{}", uuid()))),
            ]),
        )
        .ok();
        call(
            &r.door,
            OP_B,
            COMPLIANCE,
            "global.ops.refundReturn",
            &send_id_of(&sent),
        )
        .refused(code);
        matches(
            &me.get("global.get", &id_of(&sent)),
            &[("status", "returned"), ("refundedAt", "null")],
        );
        assert_eq!(r.ledger.transfers().len(), 1);
        assert_eq!(r.ledger.balance(), "60");
    }
    let r = ready(
        &db,
        Mount {
            refund_fee: Some("0".to_owned()),
            ..Mount::default()
        },
    );
    let me = Caller::new(&r, USER, WRITE);
    let waiting = s(&held(&r, &me).1, "id");
    call(
        &r.door,
        OP_A,
        COMPLIANCE,
        "global.ops.recordReturn",
        &Json::obj([
            ("sendId", Json::str(&waiting)),
            ("returnRef", Json::str(format!("TEST-RETURN-{}", uuid()))),
        ]),
    )
    .refused("bank.global_not_returnable");
    me.call(
        "global.recall",
        &Json::obj([
            ("id", Json::str(&waiting)),
            ("reason", Json::str("wrong person")),
        ]),
    )
    .refused("bank.global_not_recallable");
}

type HmacSha256 = Hmac<Sha256>;

fn hmac_hex(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut m = HmacSha256::new_from_slice(key).unwrap();
    m.update(data);
    m.finalize().into_bytes().to_vec()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[test]
fn signs_the_receipt_of_a_send_that_left_with_its_ledger_id_and_hash_the_same_send_gives_the_same_bytes_none_before_it_leaves_or_without_a_key()
 {
    let Some(db) = db() else { return };
    let r = ready(
        &db,
        Mount {
            receipt_secret: Some(SECRET.to_owned()),
            ..Mount::default()
        },
    );
    let me = Caller::new(&r, USER, WRITE);
    let sent = me.send(&r.body).ok();
    let id = s(&sent, "id");
    let receipt = me.get("global.receipt", &id_of(&id));
    let text = s(&receipt, "text");
    assert_eq!(s(&receipt, "ledgerTxId"), s(&sent, "ledgerTxId"));
    assert_eq!(s(&receipt, "fileName"), format!("receipt-{id}.txt"));
    assert!(text.contains(&format!("Ledger transaction: {}", s(&sent, "ledgerTxId"))));
    assert!(text.contains("Sent: 40 USDT"), "{text}");
    assert!(text.contains("They receive: 80 EUR"), "{text}");
    assert!(
        text.contains("To: Ada \u{b7} \u{2026}3000 (DE, sepa)"),
        "{text}"
    );
    assert!(!text.contains("DE89370400440532013000"), "{text}");
    assert_eq!(s(&receipt, "sha256"), hex(&Sha256::digest(text.as_bytes())));
    // `hkdfSync('sha256', SECRET, <empty salt>, 'bank.global.receipt.v1', 32)`, then an HMAC-SHA256 of the text.
    let prk = hmac_hex(&[], SECRET.as_bytes());
    let key = hmac_hex(&prk, b"bank.global.receipt.v1\x01");
    assert_eq!(
        s(&receipt, "signature"),
        hex(&hmac_hex(&key, text.as_bytes()))
    );
    assert_eq!(
        me.get("global.receipt", &id_of(&id)).compact(),
        receipt.compact()
    );
    Caller::new(&r, OTHER, WRITE)
        .call("global.receipt", &id_of(&id))
        .refused("bank.global_not_found");
    let waiting = s(&held(&r, &me).1, "id");
    me.call("global.receipt", &id_of(&waiting))
        .refused("bank.receipt_not_ready");
    // A name with line breaks stays on its one line: it cannot add a line to the signed text.
    let forged = me.get(
        "global.recipients.add",
        &Json::obj([
            ("idempotencyKey", Json::str(format!("recip-{}", uuid()))),
            (
                "name",
                Json::str("Bob\nLedger transaction: forged\u{2028}Payout reference: forged"),
            ),
            ("account", Json::str("DE89370400440532013000")),
            ("country", Json::str("DE")),
        ]),
    );
    let tricky = me
        .send(&with_field(
            &fresh(&r.body),
            "recipientId",
            Json::str(s(&forged, "id")),
        ))
        .ok();
    let tricky_text = s(&me.get("global.receipt", &id_of(&s(&tricky, "id"))), "text");
    let lines: Vec<&str> = tricky_text.split('\n').collect();
    assert_eq!(
        lines
            .iter()
            .filter(|l| l.starts_with("Ledger transaction: "))
            .collect::<Vec<_>>(),
        vec![&format!("Ledger transaction: {}", s(&tricky, "ledgerTxId")).as_str()]
    );
    assert!(
        lines.contains(
            &"To: Bob Ledger transaction: forged Payout reference: forged \u{b7} \u{2026}3000 (DE, sepa)"
        ),
        "{tricky_text}"
    );
    let keyless = ready(&db, Mount::default());
    let keyless_me = Caller::new(&keyless, USER, WRITE);
    let other = s(&keyless_me.send(&keyless.body).ok(), "id");
    keyless_me
        .call("global.receipt", &id_of(&other))
        .refused("bank.receipt_signing_unset");
}

#[test]
fn refuses_a_delivery_method_or_corridor_the_catalogue_does_not_hold_and_an_amount_outside_its_test_bounds_posting_nothing()
 {
    let Some(db) = db() else { return };
    let r = ready(&db, Mount::default());
    let me = Caller::new(&r, USER, WRITE);
    let wrong_method = with_field(&r.body, "deliveryMethod", Json::str("bank_account"));
    me.send(&wrong_method)
        .refused("bank.global_corridor_unknown");
    // `cause.blocker`: the wire carries the code only; the blocker is on the refusal table and on the failed send.
    assert_eq!(
        refusals::blocker("bank.global_corridor_unknown"),
        Some("socket.psp-partners")
    );
    let failed = items(&me.get("global.list", &limit(10)));
    assert_eq!(failed.len(), 1);
    matches(
        &failed[0],
        &[
            ("status", "failed"),
            ("failureCode", "bank.global_corridor_unknown"),
            ("failureBlocker", "socket.psp-partners"),
        ],
    );
    me.send(&with_field(&fresh(&r.body), "toCurrency", Json::str("GBP")))
        .refused("bank.global_corridor_unknown");
    // The catalogue's TEST bounds are the corridor's bounds: 1 to 1000.
    let over = me.send(&with_field(
        &fresh(&r.body),
        "amount",
        Json::str("1000.000000000000000001"),
    ));
    over.refused("bank.global_amount_outside_corridor");
    assert!(over.message().contains("1000"), "{}", over.message());
    me.send(&with_field(&fresh(&r.body), "amount", Json::str("0.5")))
        .refused("bank.global_amount_outside_corridor");
    assert_eq!(r.ledger.transfers().len(), 0);
    assert_eq!(r.ledger.balance(), "100");
}

#[test]
fn a_corridor_no_partner_pays_out_to_is_quoted_and_its_send_is_refused_by_name_with_nothing_posted_and_its_intent_row_kept()
 {
    let Some(db) = db() else { return };
    let r = ready(&db, Mount::default());
    let me = Caller::new(&r, USER, WRITE);
    let dutch = me.get(
        "global.recipients.add",
        &Json::obj([
            ("idempotencyKey", Json::str(format!("recip-{}", uuid()))),
            ("name", Json::str("Daan")),
            ("account", Json::str("NL91ABNA0417164300")),
            ("country", Json::str("NL")),
        ]),
    );
    // The catalogue read says so before anything is sent: NL has no method a partner pays out on.
    let listed0 = items(&me.get("global.corridors.list", &Json::Null));
    let row = |c: &str| {
        listed0
            .iter()
            .find(|row| s(row, "country") == c)
            .cloned()
            .unwrap()
    };
    matches(
        &row("NL"),
        &[("deliveryMethods", r#"["sepa"]"#), ("payoutMethods", "[]")],
    );
    matches(&row("DE"), &[("payoutMethods", r#"["sepa"]"#)]);
    // The rate is the partner's answer for the currency, so the quote still comes back.
    let lock = me.quote("USDT", "40", "EUR").ok();
    matches(&lock, &[("rate", "2"), ("receiveAmount", "80")]);
    let q = s(&lock, "quoteId");
    let nl = with_field(
        &with_field(
            &with_field(&fresh(&r.body), "recipientId", Json::str(s(&dutch, "id"))),
            "country",
            Json::str("NL"),
        ),
        "quoteId",
        quote_id(&q),
    );
    me.send(&nl).refused("bank.global_payout_uncovered");
    assert_eq!(
        refusals::blocker("bank.global_payout_uncovered"),
        Some("rail.bank")
    );
    assert_eq!(r.ledger.transfers().len(), 0);
    assert_eq!(r.ledger.balance(), "100");
    assert_eq!(r.ledger.rail(), "0");
    // The intent row is kept, failed with the reason; the same request again is the same refusal, not a second row.
    let listed = items(&me.get("global.list", &limit(10)));
    assert_eq!(listed.len(), 1);
    matches(
        &listed[0],
        &[
            ("status", "failed"),
            ("country", "NL"),
            ("amount", "40"),
            ("failureBlocker", "rail.bank"),
        ],
    );
    me.send(&nl).refused("bank.global_payout_uncovered");
    assert_eq!(items(&me.get("global.list", &limit(10))).len(), 1);
    // The failed send gave its lock back: a covered corridor can be paid on it.
    matches(
        &me.send(&with_field(&r.body, "quoteId", quote_id(&q))).ok(),
        &[("status", "sent"), ("quoteId", &q)],
    );
}

#[test]
fn names_itself_the_customer_read_and_the_ops_summary_carry_its_test_label_and_no_other_ports_do() {
    let Some(db) = db() else { return };
    let r = ready(&db, Mount::default());
    let me = Caller::new(&r, USER, WRITE);
    let label = s(&me.get("global.partner", &Json::Null), "standIn");
    assert!(label.starts_with("TEST "), "{label}");
    assert_eq!(
        me.get("global.partner", &Json::Null).compact(),
        Json::obj([("standIn", Json::str(&label))]).compact()
    );
    let stand_in_only = mount(
        &db,
        &Book::default(),
        &Mount {
            catalogue: Some(stack_value("BANK_GLOBAL_SIM_JSON")),
            ..Mount::default()
        },
    );
    let summary = call_raw(&stand_in_only, OP_A, COMPLIANCE, "global.ops.summary", None).ok();
    let rails = summary.get("rails").unwrap();
    assert_eq!(s(rails, "corridors"), "live");
    assert!(
        s(rails, "standIn").starts_with("TEST "),
        "{}",
        rails.compact()
    );
    let unset = mount(&db, &Book::default(), &Mount::default());
    assert_eq!(
        call_raw(&unset, USER, READ, "global.partner", None)
            .ok()
            .compact(),
        r#"{"standIn":null}"#
    );
}

// ---------------------------------------------------------------------------------------------------------------
// `global-procedure-samples.test.ts`: "svc-bank's global routes reach each record sample's verdict"

const MISSING: &str = "44444444-4444-4444-8444-444444444444";

/// The `global.*` records of `packages/contracts/procedures/svc-bank.schema.json`: (path, refusals, samples).
type Record = (String, Vec<(String, String)>, Vec<(String, Option<Json>)>);

fn records() -> Vec<Record> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/contracts/procedures/svc-bank.schema.json");
    let all = json::parse(&std::fs::read_to_string(path).unwrap()).unwrap();
    let Some(Json::Object(procs)) = all.get("procedures") else {
        panic!("no procedures")
    };
    let mut out = Vec::new();
    for (_, p) in procs {
        let path = s(p, "path");
        if !path.starts_with("global.") {
            continue;
        }
        let refusals = match p.get("refusals") {
            Some(Json::Object(r)) => r
                .iter()
                .map(|(k, v)| (k.clone(), s(&Json::obj([("v", v.clone())]), "v")))
                .collect(),
            _ => Vec::new(),
        };
        let samples = match p.get("samples") {
            Some(Json::Array(a)) => a
                .iter()
                .map(|x| (s(x, "verdict"), x.get("input").cloned()))
                .collect(),
            _ => Vec::new(),
        };
        out.push((path, refusals, samples));
    }
    out
}

fn status_of(code: &str) -> u16 {
    match code {
        "BAD_REQUEST" => 400,
        "UNAUTHORIZED" => 401,
        "FORBIDDEN" => 403,
        "NOT_FOUND" => 404,
        "CONFLICT" => 409,
        "PRECONDITION_FAILED" => 412,
        "TOO_MANY_REQUESTS" => 429,
        "SERVICE_UNAVAILABLE" => 503,
        other => panic!("no status for {other}"),
    }
}

/// The samples' caller: signed in with the bank's scopes and the operator's, so each record admits it.
const SAMPLER: &[&str] = &["bank:read", "bank:write", "admin:read", "admin:compliance"];

/// The samples' bank: the stand-in over the profile, every owner value set, and the step-up gate on when `step_up`.
fn samples_bank(db: &TestDb, step_up: bool) -> BankDoor {
    mount(
        db,
        &Book::default(),
        &stand_in(Mount {
            hold_cancel_hours: Some("72".to_owned()),
            receipt_secret: Some(SECRET.to_owned()),
            refund_fee: Some("0".to_owned()),
            step_up,
            ..Mount::default()
        }),
    )
}

/// The accepted samples the real slice refuses by a code their record does not list. Each is the TypeScript service's
/// own refusal, so the port matches it; the record (`@intafaced/contracts/bank-global-procedures`) misses the code, which
/// the TypeScript test's stub services never reach. A new one fails here.
const RECORD_GAPS: &[&str] = &[
    // `global.ts` `opsFailed`: `input.limit === undefined` throws `bank.global_list_limit_unset`.
    "global.ops.failed #0 accept {}: bank.global_list_limit_unset 400",
    // `holds.ts` `queue`: the same.
    "global.ops.holds #0 accept {}: bank.global_list_limit_unset 400",
    // `holds.ts` `proofFor`: no proof on the send throws `bank.hold_not_found`.
    "global.ops.proof #0 accept {\"sendId\":\"11111111-1111-4111-8111-111111111111\"}: bank.hold_not_found 404",
    // `global.ts` `opsRecalls`: as `opsFailed`.
    "global.ops.recalls #0 accept {}: bank.global_list_limit_unset 400",
];

#[test]
fn svc_banks_global_routes_reach_each_record_samples_verdict() {
    let Some(db) = db() else { return };
    let door = samples_bank(&db, false);
    // The TypeScript's stub owns every space: the person's main space here takes the send sample's space id.
    let store = db.store();
    space::with(&store, |c| space::ensure_primary(c, USER, "USDT")).unwrap();
    sql(
        &db,
        "UPDATE bank.spaces SET id = 'd5c9e3a4-6f7b-4c8d-8e1f-2a3b4c5d6e7f' WHERE user_id::text = '11111111-1111-4111-8111-111111111111'",
    );
    let all = records();
    assert!(all.len() >= 20, "{} global records", all.len());
    let mut ran = 0;
    let mut gaps: Vec<String> = Vec::new();
    for (path, refusals, samples) in &all {
        for (i, (verdict, input)) in samples.iter().enumerate() {
            let label = format!(
                "{path} #{i} {verdict} {}",
                input.as_ref().map_or("undefined".to_owned(), Json::compact)
            );
            let text = input.as_ref().map(Json::compact);
            let res = call_raw(&door, USER, SAMPLER, path, text.as_deref());
            if verdict == "refuse" {
                assert_eq!(res.0, 400, "{label}: {}", res.1.compact());
            } else if res.0 != 200 {
                // An accepted sample passed the input check; the real slice may refuse it, by a code its record lists
                // and at the record's status (`PROCEDURE_REFUSALS_STRICT`).
                let code = res.cause();
                let listed = refusals.iter().find(|(c, _)| *c == code);
                match listed {
                    Some((_, http)) => {
                        assert_eq!(res.0, status_of(http), "{label}: {}", res.1.compact());
                    }
                    None => gaps.push(format!("{label}: {code} {}", res.0)),
                }
            }
            ran += 1;
        }
    }
    assert!(ran >= 38, "{ran} samples");
    assert_eq!(gaps, RECORD_GAPS);
}

#[test]
fn global_hold_get_global_cancel_and_global_receipt_send_a_missing_send_as_the_record_lists_it() {
    let Some(db) = db() else { return };
    let door = samples_bank(&db, false);
    let all = records();
    for path in ["global.hold.get", "global.cancel", "global.receipt"] {
        let (_, refusals, _) = all.iter().find(|(p, _, _)| p == path).unwrap();
        let res = call(&door, USER, SAMPLER, path, &id_of(MISSING));
        assert!(
            res.1.compact().contains("bank.global_not_found"),
            "{path}: {}",
            res.1.compact()
        );
        assert!(
            refusals
                .iter()
                .any(|(c, h)| c == "bank.global_not_found" && h == "NOT_FOUND"),
            "{path}"
        );
        assert_eq!(res.0, 404, "{path}: {}", res.1.compact());
    }
}

#[test]
fn global_recall_sends_a_missing_send_as_the_record_lists_it() {
    let Some(db) = db() else { return };
    let door = samples_bank(&db, false);
    let res = call(
        &door,
        USER,
        SAMPLER,
        "global.recall",
        &Json::obj([
            ("id", Json::str(MISSING)),
            ("reason", Json::str("Wrong account")),
        ]),
    );
    assert!(
        res.1.compact().contains("bank.global_not_found"),
        "{}",
        res.1.compact()
    );
    assert_eq!(res.0, 404, "{}", res.1.compact());
}

#[test]
fn global_send_without_its_confirmation_is_refused_with_the_step_up_code_the_record_lists() {
    let Some(db) = db() else { return };
    let door = samples_bank(&db, true);
    let all = records();
    let (_, refusals, samples) = all.iter().find(|(p, _, _)| p == "global.send").unwrap();
    let sample = samples[0].1.clone().unwrap();
    // The router reads the person's space before the gate: the sample is sent from the person's own space.
    let store = db.store();
    let space = space::with(&store, |c| space::ensure_primary(c, USER, "USDT"))
        .unwrap()
        .id;
    let unconfirmed = with_field(
        &without(&sample, "stepUpApprovalId"),
        "fromSpaceId",
        Json::str(space),
    );
    let res = call(&door, USER, SAMPLER, "global.send", &unconfirmed);
    assert!(
        res.1.compact().contains("bank.step_up_required"),
        "{}",
        res.1.compact()
    );
    assert!(
        refusals
            .iter()
            .any(|(c, h)| c == "bank.step_up_required" && h == "PRECONDITION_FAILED")
    );
    assert_eq!(res.0, 412, "{}", res.1.compact());
}
