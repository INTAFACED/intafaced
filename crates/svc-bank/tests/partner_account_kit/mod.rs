//! What the partner-account suites share: the Rust door on a real Postgres with this slice's wiring handed in, a
//! ledger held in memory that applies each recipe's effect (the TypeScript suites' `MemoryLedger`), a security lock a
//! test sets, and the signed person and service a call is made as.
#![allow(
    dead_code,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test harness: each suite uses part of it, and a failure is the point"
)]

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};

use service_kit::edge;
use service_kit::json::{self, Json};
use service_kit::money::{Amount, parse_amount};
use service_kit::s2s::{self, system_seconds};
use service_kit::s2s_verify::BodyBind;
use service_kit::server::Request;
use svc_bank::door::{self, BankDoor, DoorConfig, ServiceAuth};
use svc_bank::errors::Refusal;
use svc_bank::partner::TestPartner;
use svc_bank::partner::custody::{Freeze, FreezeReading};
use svc_bank::partner::router::Wiring as PartnerWiring;
use svc_bank::partner_account::Wiring;
use svc_bank::partner_account::cash_out::ledger::{Ledger, PostError, Recipe};
use svc_bank::partner_account::cash_out::payout_sim::{self, Partner};
use svc_bank::partner_account::cash_out::security_lock::{LockState, SecurityLock};
use svc_bank::partner_account::cash_out::session_lock::Gate;
use svc_bank::partner_account::cash_out::{self, Wiring as CashOutWiring};

use crate::support::TestDb;

pub const SECRET: &str = "a-bank-partner-account-edge-secret-long-enough";
pub const INTERNAL: &str = "a-bank-partner-account-internal-secret-long";
pub const RECEIPTS: &str = "bank-cash-out-receipt-secret-long-enough";
pub const ADA: &str = "11111111-1111-4111-8111-111111111111";
pub const BOB: &str = "22222222-2222-4222-8222-222222222222";
pub const GB: &str = "GB82WEST12345698765432";
pub const DE: &str = "DE89370400440532013000";
pub const NL: &str = "NL91ABNA0417164300";
pub const STEPPED: &[&str] = &["bank:read", "bank:write", "trade:withdraw"];
pub const PLAIN: &[&str] = &["bank:read", "bank:write"];
pub const CATALOGUE: &str = r#"{"label":"TEST payout stand-in","payouts":[{"asset":"USDT","currency":"EUR","rate":"0.9","fee":"1.5"}]}"#;

pub fn amount(s: &str) -> Amount {
    parse_amount(s).unwrap()
}

/// The TEST payout stand-in (`SIM`), with its records folder when given.
pub fn sim(records: Option<&str>) -> Partner {
    payout_sim::partner_for("payout-sim", Some(CATALOGUE), Some("test"), None, records)
        .unwrap()
        .unwrap()
}

/// A fresh folder under the system's temporary one, not made yet (as `join(mkdtemp(...), 'test-rail-records')`).
pub fn records_dir() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    let base = std::env::temp_dir().join(format!(
        "bank-payout-records-{}-{nanos}",
        std::process::id()
    ));
    std::fs::create_dir_all(&base).unwrap();
    base.join("test-rail-records")
        .to_string_lossy()
        .into_owned()
}

/// The ledger in memory: balances by account, each recipe's effect applied once under its key.
#[derive(Default)]
pub struct Book {
    pub balances: HashMap<String, Amount>,
    /// Each booked transaction, in order: (idempotency key, id).
    pub journal: Vec<(String, String)>,
    /// What `available` answers instead of the balance (a read that moved since).
    pub available_says: Option<Amount>,
    /// Every post fails as the ledger being down does.
    pub down: bool,
}

#[derive(Clone, Default)]
pub struct MemLedger(pub Arc<Mutex<Book>>);

pub fn available_account(user: &str, asset: &str) -> String {
    format!("user:{user}:available:{asset}")
}
pub fn hold_account(user: &str, asset: &str, withdrawal: &str) -> String {
    format!("user:{user}:withdrawal-hold:{asset}:{withdrawal}")
}
pub fn rail_account(rail: &str, asset: &str) -> String {
    format!("rail:{rail}:{asset}")
}

impl MemLedger {
    pub fn balance(&self, account: &str) -> Amount {
        self.0
            .lock()
            .unwrap()
            .balances
            .get(account)
            .copied()
            .unwrap_or(Amount::ZERO)
    }
    pub fn available(&self, user: &str) -> Amount {
        self.balance(&available_account(user, "USDT"))
    }
    pub fn held(&self, user: &str, request: &str) -> Amount {
        self.balance(&hold_account(
            user,
            "USDT",
            &cash_out::withdrawal_id(request),
        ))
    }
    pub fn rail(&self) -> Amount {
        self.balance(&rail_account(payout_sim::RAIL, "USDT"))
    }
    pub fn posts(&self) -> usize {
        self.0.lock().unwrap().journal.len()
    }
    pub fn post_ok(&self, r: &Recipe) -> String {
        Ledger::post(self, r).unwrap()
    }
    pub fn down(&self, on: bool) {
        self.0.lock().unwrap().down = on;
    }
    pub fn available_says(&self, a: Option<Amount>) {
        self.0.lock().unwrap().available_says = a;
    }
}

impl Ledger for MemLedger {
    fn available(&self, user_id: &str, asset_id: &str) -> Result<Amount, Refusal> {
        let book = self.0.lock().unwrap();
        Ok(book.available_says.unwrap_or_else(|| {
            book.balances
                .get(&available_account(user_id, asset_id))
                .copied()
                .unwrap_or(Amount::ZERO)
        }))
    }

    fn post(&self, recipe: &Recipe) -> Result<String, PostError> {
        let mut book = self.0.lock().unwrap();
        if book.down {
            return Err(PostError::Failed(Refusal::Other(
                "TEST ledger unavailable".to_owned(),
            )));
        }
        let key = recipe.idempotency_key();
        if let Some((_, id)) = book.journal.iter().find(|(k, _)| *k == key) {
            return Ok(id.clone());
        }
        // (from, to, amount): every recipe here is one leg.
        let (from, to, amount) = match recipe {
            Recipe::WithdrawHold(w) => (
                available_account(&w.user_id, &w.asset_id),
                hold_account(&w.user_id, &w.asset_id, &w.withdrawal_id),
                w.amount,
            ),
            Recipe::WithdrawSettle(w) => (
                hold_account(&w.user_id, &w.asset_id, &w.withdrawal_id),
                rail_account(&w.rail, &w.asset_id),
                w.amount,
            ),
            Recipe::WithdrawReverse(w) => (
                hold_account(&w.user_id, &w.asset_id, &w.withdrawal_id),
                available_account(&w.user_id, &w.asset_id),
                w.amount,
            ),
            Recipe::Deposit {
                user_id,
                asset_id,
                amount,
                rail,
                ..
            } => (
                rail_account(rail, asset_id),
                available_account(user_id, asset_id),
                *amount,
            ),
        };
        let is_rail = from.starts_with("rail:");
        let has = book.balances.get(&from).copied().unwrap_or(Amount::ZERO);
        if !is_rail && has < amount {
            return Err(PostError::InsufficientFunds);
        }
        *book.balances.entry(from).or_default() -= amount;
        *book.balances.entry(to).or_default() += amount;
        let id = format!("TEST-tx-{}", book.journal.len() + 1);
        book.journal.push((key, id.clone()));
        Ok(id)
    }

    fn tx_by_key(&self, key: &str) -> Result<Option<String>, Refusal> {
        Ok(self
            .0
            .lock()
            .unwrap()
            .journal
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, id)| id.clone()))
    }
}

/// A TEST deposit into a person's available USDT (`recipes.deposit` on rail `test`).
pub fn fund(ledger: &MemLedger, user: &str, value: &str, rail_ref: &str) {
    ledger.post_ok(&Recipe::Deposit {
        user_id: user.to_owned(),
        asset_id: "USDT".to_owned(),
        amount: amount(value),
        rail: "test".to_owned(),
        rail_ref: rail_ref.to_owned(),
    });
}

/// The owner's security lock as a test sets it.
#[derive(Clone, Default)]
pub struct Lock(pub Arc<Mutex<LockState>>);

impl Lock {
    pub fn set(&self, s: LockState) {
        *self.0.lock().unwrap() = s;
    }
}

impl SecurityLock for Lock {
    fn read(&self, _user_id: &str) -> Result<LockState, Refusal> {
        Ok(self.0.lock().unwrap().clone())
    }
}

pub const OPEN: LockState = LockState {
    locked: false,
    unlocks_at: None,
    self_frozen: false,
};
pub const LOCKED: LockState = LockState {
    locked: true,
    unlocks_at: None,
    self_frozen: false,
};
pub const SELF_FROZEN: LockState = LockState {
    locked: false,
    unlocks_at: None,
    self_frozen: true,
};

/// svc-ledger's posting freeze, open.
struct Enabled;

impl Freeze for Enabled {
    fn read(&self) -> Result<FreezeReading, String> {
        Ok(FreezeReading {
            posting_enabled: true,
            cause: None,
        })
    }
}

/// What one door is built with.
pub struct Setup {
    pub cap: Option<&'static str>,
    pub cooling: Option<&'static str>,
    pub partner: Option<Partner>,
    /// The TEST partner bank (partner-held cases); none elsewhere, so every other case is the ledger path.
    pub partner_bank: bool,
    /// The pool's size and its session-lock gate's (`DATABASE_POOL_MAX`).
    pub pool_max: usize,
    /// The owner's security lock in place of the test's `Lock`.
    pub security_lock: Option<Box<dyn SecurityLock>>,
}

impl Default for Setup {
    fn default() -> Setup {
        Setup {
            cap: Some("10"),
            cooling: Some("24"),
            partner: None,
            partner_bank: false,
            pool_max: 2,
            security_lock: None,
        }
    }
}

pub fn door(db: &TestDb, ledger: &MemLedger, lock: &Lock, s: Setup) -> BankDoor {
    let mut env: BTreeMap<String, String> = [("APP_ENV", "test"), ("NODE_ENV", "test")]
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect();
    if let Some(cap) = s.cap {
        env.insert("BANK_ADDRESS_BOOK_CAP".to_owned(), cap.to_owned());
    }
    if let Some(c) = s.cooling {
        env.insert("BANK_OFFRAMP_COOLING_HOURS".to_owned(), c.to_owned());
    }
    let mut wiring = Wiring::from_env(&env).unwrap();
    wiring.cash_out = CashOutWiring {
        partner: s.partner,
        receipt_secret: Some(RECEIPTS.to_owned()),
        security_lock: s.security_lock.unwrap_or_else(|| Box::new(lock.clone())),
        ledger: Box::new(ledger.clone()),
        gate: Gate::new(s.pool_max),
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
        store: svc_bank::db::open(&db.url, "svc-bank", s.pool_max, false).unwrap(),
    })
    .unwrap()
    .with_partner(PartnerWiring {
        partner: s.partner_bank.then(|| TestPartner::new().unwrap()),
        freeze: Box::new(Enabled),
        custody_layer: "off".to_owned(),
        cash_legs: None,
        pay_in: None,
    })
    .with_partner_account(wiring)
}

pub fn person(user: &str, scopes: &[&str]) -> Vec<(String, String)> {
    let raw = Json::obj([
        ("sub", Json::str(user)),
        (
            "scopes",
            Json::Array(scopes.iter().map(|s| Json::str(*s)).collect()),
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

pub fn send(
    d: &BankDoor,
    method: &str,
    url: &str,
    body: &str,
    mut headers: Vec<(String, String)>,
) -> (u16, Json) {
    if !body.is_empty() {
        headers.push(("content-type".to_owned(), "application/json".to_owned()));
    }
    let res = d.handle_from(
        &Request {
            method,
            url,
            headers: &headers,
            body,
        },
        "req-partner-account-db",
        "127.0.0.1",
    );
    (res.status, json::parse(&res.body).unwrap())
}

/// A tRPC mutation as `user` with `scopes`: its `result.data`, or the refusal.
pub fn mutate(d: &BankDoor, user: &str, scopes: &[&str], path: &str, input: &str) -> Answer {
    Answer::of(send(
        d,
        "POST",
        &format!("/trpc/{path}"),
        input,
        person(user, scopes),
    ))
}

/// A tRPC query (`?input=`).
pub fn query(d: &BankDoor, user: &str, scopes: &[&str], path: &str, input: Option<&str>) -> Answer {
    let url = match input {
        Some(i) => format!(
            "/trpc/{path}?input={}",
            url::form_urlencoded::byte_serialize(i.as_bytes()).collect::<String>()
        ),
        None => format!("/trpc/{path}"),
    };
    Answer::of(send(d, "GET", &url, "", person(user, scopes)))
}

/// A job door, signed as a service.
pub fn job(d: &BankDoor, path: &str, body: &str) -> (u16, Json) {
    let h = s2s::legacy_headers("local-test-stack", INTERNAL, body, system_seconds()).unwrap();
    send(d, "POST", path, body, h)
}

/// One call's answer: the data, or its refusal's tRPC code and own code.
#[derive(Debug, Clone, PartialEq)]
pub enum Answer {
    Ok(Json),
    Refused { trpc: String, bank: Option<String> },
}

impl Answer {
    fn of((status, body): (u16, Json)) -> Answer {
        if status == 200 {
            return Answer::Ok(
                body.get("result")
                    .and_then(|r| r.get("data"))
                    .cloned()
                    .unwrap_or(Json::Null),
            );
        }
        let data = body.get("error").and_then(|e| e.get("data"));
        let s = |j: Option<&Json>| match j {
            Some(Json::String(v)) => Some(v.clone()),
            _ => None,
        };
        Answer::Refused {
            trpc: s(data.and_then(|d| d.get("code")))
                .unwrap_or_else(|| panic!("{status} {}", body.compact())),
            bank: s(data
                .and_then(|d| d.get("cause"))
                .and_then(|c| c.get("code"))),
        }
    }

    pub fn ok(self) -> Json {
        match self {
            Answer::Ok(j) => j,
            other => panic!("expected an answer, got {other:?}"),
        }
    }

    /// The refusal's own code (`cause.code`), else its tRPC code.
    pub fn refused(self) -> String {
        match self {
            Answer::Refused { bank: Some(b), .. } => b,
            Answer::Refused { trpc, .. } => trpc,
            Answer::Ok(j) => panic!("expected a refusal, got {}", j.compact()),
        }
    }

    pub fn both(self) -> (String, String) {
        match self {
            Answer::Refused { trpc, bank } => (trpc, bank.unwrap_or_default()),
            Answer::Ok(j) => panic!("expected a refusal, got {}", j.compact()),
        }
    }
}

/// A job door's answer: its JSON, or the refusal's code (`{"error","code"}`).
pub fn job_ok(answer: (u16, Json)) -> Json {
    assert_eq!(answer.0, 200, "{}", answer.1.compact());
    answer.1
}

pub fn job_refused(answer: (u16, Json)) -> String {
    assert_eq!(answer.0, 400, "{}", answer.1.compact());
    match answer.1.get("code") {
        Some(Json::String(c)) => c.clone(),
        _ => panic!("{}", answer.1.compact()),
    }
}

/// A field as text: a string as it is, anything else as JSON (`null` for a null or missing one).
pub fn f(j: &Json, key: &str) -> String {
    match j.get(key) {
        Some(Json::String(s)) => s.clone(),
        Some(v) => v.compact(),
        None => "null".to_owned(),
    }
}

/// Every `(key, value)` holds in `j` (`toMatchObject`), values as [`f`] reads them.
pub fn matches(j: &Json, want: &[(&str, &str)]) {
    for (k, v) in want {
        assert_eq!(&f(j, k), v, "{k} in {}", j.compact());
    }
}

pub fn db() -> Option<TestDb> {
    let db = TestDb::new()?;
    db.migrated();
    Some(db)
}

pub fn uuid() -> String {
    service_kit::approvals::random_uuid().unwrap()
}
