//! Slice `ramps`' off-ramp against the Rust door on a real Postgres: `ramps.offramp` and `ramps.setWithdrawDestination`.
//! Ports the checks of the TypeScript's suites that fall on those two calls, each test named after the TypeScript
//! test's words: `ramps/ramps.test.ts` (the off-ramp's refuse-closed defaults, cooling, hold then settle, the withdrawal
//! address, the sanctions list and conservation), `offramp-cooling.money.test.ts` and `offramp-cooling.test.ts`'s
//! off-ramp half, `security-lock.money.test.ts` ("a crypto withdrawal while the security lock holds" and the legacy
//! door under the lock), `ramps/fraud-list.db.test.ts`'s send and legacy-door tests, `ramps/ramp-kind-crypto.test.ts`'s
//! off-ramp half and `ramps/ramp-rejected-omits-ledger-tx.test.ts`'s off-ramp table checks. Every call enters through
//! the door, as the TypeScript drives the router.
//!
//! Not ported, with the reason: the source pins (`(source)` and `H8* money suite is not skip-green`) read TypeScript
//! files; the tests that build `RampService` with `assertOnlyWithdrawDestinations()` or a memory book of destinations
//! are ported on the Postgres book, which is what the door serves; the on-ramp halves are `ramps_onramp_db`'s. Funding
//! is a balance given to the stand-in ledger, where the TypeScript credits an on-ramp first.
//!
//! The ledger is a stand-in that books `withdrawHold` and `withdrawSettle` by their own keys, refuses an overdraft as
//! `ledger.insufficient_funds`, can fail a settle (the rail down) and can be held at the hold (two callers at once).
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

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};

use service_kit::approvals::random_uuid;
use service_kit::edge;
use service_kit::json::{self, Json};
use service_kit::money::{Amount, format_amount, parse_amount};
use service_kit::s2s_verify::BodyBind;
use service_kit::server::Request;
use service_kit::time::Instant;
use svc_bank::door::{self, BankDoor, DoorConfig, Kind, ServiceAuth};
use svc_bank::errors::Refusal;
use svc_bank::partner::refuse;
use svc_bank::partner::router::Wiring as PartnerWiring;
use svc_bank::ramps::{Settings as RampSettings, Wiring as RampsWiring};
use svc_bank::spaces::ports::{Ledger, LedgerAccount, LedgerBalance, LedgerTx, PostFailure};
use svc_bank::transfers::Wiring as TransfersWiring;
use svc_bank::transfers::ports::{LockState, SecurityLock};

use support::TestDb;

const SECRET: &str = "a-bank-ramps-offramp-db-edge-secret-long-ok";
const USER: &str = "11111111-1111-4111-8111-111111111111";
const OTHER: &str = "22222222-2222-4222-8222-222222222222";
const DEAD: &str = "0x000000000000000000000000000000000000dEaD";
const EVM: &str = "0x1111111111111111111111111111111111111111";
const EVM_OTHER: &str = "0x2222222222222222222222222222222222222222";
const SANCTIONED: &str = "0x5a7c7100000000000000000000000000000ba5ed";
const LISTED: &str = "0xbad0000000000000000000000000000000000bad";
/// The owner's list on the test stack: one LOCAL TEST address nobody here sends to, so every other is clear.
const SANCTIONS: &str = "*:0x00000000000000000000000000000000000fffff";
const WITHDRAW: &[&str] = &["trade:withdraw", "bank:read", "bank:write"];

fn uuid() -> String {
    random_uuid().unwrap()
}

fn amt(s: &str) -> Amount {
    parse_amount(s).unwrap()
}

// ---------------------------------------------------------------------------------------------------------------
// Stand-ins

#[derive(Default)]
struct BookState {
    /// Each account's balance: `(owner, asset, place)`, the place `available`, `hold:<id>` or `rail`.
    balances: BTreeMap<(String, String, String), Amount>,
    /// Each booked post: (recipe, key).
    journal: Vec<(String, String)>,
    /// The rail is down at the settle: `withdrawSettle` fails with no answer.
    settle_fails: bool,
    /// How long a hold takes to answer, so a second caller arrives while the first is inside it.
    hold_ms: u64,
}

/// svc-ledger for the off-ramp: available, the hold per off-ramp and the rail boundary, posted by recipe and key.
#[derive(Clone, Default)]
struct Book(Arc<Mutex<BookState>>);

impl Book {
    fn st(&self) -> std::sync::MutexGuard<'_, BookState> {
        self.0.lock().unwrap()
    }
    fn fund(&self, user: &str, amount: &str) {
        *self
            .st()
            .balances
            .entry((user.to_owned(), "USDT".to_owned(), "available".to_owned()))
            .or_default() += amt(amount);
    }
    fn of(&self, owner: &str, place: &str) -> String {
        format_amount(
            self.st()
                .balances
                .get(&(owner.to_owned(), "USDT".to_owned(), place.to_owned()))
                .copied()
                .unwrap_or(Amount::ZERO),
        )
    }
    fn available(&self, user: &str) -> String {
        self.of(user, "available")
    }
    fn posted(&self) -> Vec<(String, String)> {
        self.st().journal.clone()
    }
    fn posted_any(&self, recipe: &str) -> bool {
        self.posted().iter().any(|(r, _)| r == recipe)
    }
}

fn text(j: &Json, k: &str) -> String {
    match j.get(k) {
        Some(Json::String(s)) => s.clone(),
        _ => String::new(),
    }
}

impl Ledger for Book {
    fn balance(&self, account: &LedgerAccount) -> Result<Amount, String> {
        Ok(self
            .st()
            .balances
            .get(&(
                account.owner_id.clone(),
                account.asset_id.clone(),
                "available".to_owned(),
            ))
            .copied()
            .unwrap_or(Amount::ZERO))
    }
    fn balances(&self, _owner_type: &str, _owner_id: &str) -> Result<Vec<LedgerBalance>, String> {
        Ok(Vec::new())
    }
    fn assets(&self) -> Result<Vec<Json>, String> {
        Ok(Vec::new())
    }
    fn post_recipe(&self, recipe: &str, input: &Json, key: &str) -> Result<LedgerTx, PostFailure> {
        let user = text(input, "userId");
        let asset = text(input, "assetId");
        let id = text(input, "withdrawalId");
        let amount = amt(&text(input, "amount"));
        let hold = format!("hold:{id}");
        let (from, to, want) = match recipe {
            "withdrawHold" => {
                let ms = self.st().hold_ms;
                std::thread::sleep(std::time::Duration::from_millis(ms));
                (
                    (user.clone(), asset.clone(), "available".to_owned()),
                    (user.clone(), asset.clone(), hold),
                    format!("withdraw.hold:{id}"),
                )
            }
            "withdrawSettle" => (
                (user.clone(), asset.clone(), hold),
                (text(input, "rail"), asset.clone(), "rail".to_owned()),
                format!("withdraw.settle:{id}"),
            ),
            other => panic!("the off-ramp posts no {other}"),
        };
        assert_eq!(key, want, "the recipe's own key");
        let mut st = self.st();
        if recipe == "withdrawSettle" && st.settle_fails {
            return Err(PostFailure::Unknown("TEST rail down at settle".to_owned()));
        }
        let tx = LedgerTx {
            id: format!("tx-{key}"),
            key: key.to_owned(),
            posted_at: door::system_now(),
            entries: Vec::new(),
        };
        if st.journal.iter().any(|(_, k)| k == key) {
            return Ok(tx);
        }
        let have = st.balances.get(&from).copied().unwrap_or(Amount::ZERO);
        if have < amount {
            return Err(PostFailure::Coded {
                code: "ledger.insufficient_funds".to_owned(),
                message: format!(
                    "Insufficient {asset}: short {}",
                    format_amount(amount - have)
                ),
                attempts: 1,
            });
        }
        *st.balances.entry(from).or_default() -= amount;
        *st.balances.entry(to).or_default() += amount;
        st.journal.push((recipe.to_owned(), key.to_owned()));
        Ok(tx)
    }
}

/// `memorySecurityLock`: open unless set, per person; `failWith` makes every read refuse.
#[derive(Clone, Default)]
struct Lock(Arc<Mutex<LockBoard>>);

/// Each person's lock, and the refusal every read answers while identity is down.
type LockBoard = (HashMap<String, LockState>, Option<Refusal>);

impl Lock {
    fn set(&self, user: &str, state: LockState) {
        self.0.lock().unwrap().0.insert(user.to_owned(), state);
    }
    fn fail_with(&self, r: Refusal) {
        self.0.lock().unwrap().1 = Some(r);
    }
}

impl SecurityLock for Lock {
    fn read(&self, user_id: &str) -> Result<LockState, Refusal> {
        let st = self.0.lock().unwrap();
        if let Some(r) = &st.1 {
            return Err(r.clone());
        }
        Ok(st.0.get(user_id).cloned().unwrap_or_default())
    }
}

fn locked() -> LockState {
    LockState {
        locked: true,
        unlocks_at: Some("2099-01-01T00:00:00.000Z".to_owned()),
        self_frozen: false,
    }
}

fn self_frozen() -> LockState {
    LockState {
        locked: false,
        unlocks_at: None,
        self_frozen: true,
    }
}

// ---------------------------------------------------------------------------------------------------------------
// The door

/// The owner's values a test changes; the rest are the test stack's.
#[derive(Clone)]
struct Owner {
    mode: Option<&'static str>,
    cooling: Option<&'static str>,
    sanctions: Option<String>,
    custody: &'static str,
}

impl Default for Owner {
    fn default() -> Owner {
        Owner {
            mode: Some("crypto-ledger"),
            cooling: Some("0"),
            sanctions: Some(SANCTIONS.to_owned()),
            custody: "on",
        }
    }
}

struct Bank {
    door: BankDoor,
    db: TestDb,
    ledger: Book,
    lock: Lock,
}

fn door_for(db: &TestDb, ledger: &Book, lock: &Lock, o: &Owner) -> BankDoor {
    let env: BTreeMap<String, String> = [("APP_ENV", "test"), ("NODE_ENV", "test")]
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect();
    let mut transfers = TransfersWiring::none();
    transfers.lock = Box::new(lock.clone());
    let mut spaces = svc_bank::spaces::Wiring::none();
    spaces.ledger = Box::new(ledger.clone());
    let mut ramps = RampsWiring::none();
    ramps.settings = RampSettings {
        ramp_mode: o.mode.map(str::to_owned),
        offramp_cooling_hours: o.cooling.map(str::to_owned),
        address_book_cap: Some("20".to_owned()),
        destination_sanctions: o.sanctions.clone(),
        app_env: Some("test".to_owned()),
        node_env: Some("test".to_owned()),
        ..RampSettings::default()
    };
    BankDoor::new(DoorConfig {
        edge_secret: SECRET.to_owned(),
        services: ServiceAuth {
            secret: None,
            keys: None,
            trpc_bind: BodyBind::AcceptBoth,
        },
        env,
        now: door::system_now,
        store: db.store(),
    })
    .unwrap()
    .with_partner(PartnerWiring {
        custody_layer: o.custody.to_owned(),
        ..PartnerWiring::none()
    })
    .with_spaces(spaces)
    .with_transfers(transfers)
    .with_ramps(ramps)
}

fn bank_with(o: &Owner) -> Option<Bank> {
    let db = TestDb::new()?;
    db.migrated();
    let ledger = Book::default();
    let lock = Lock::default();
    let door = door_for(&db, &ledger, &lock, o);
    Some(Bank {
        door,
        db,
        ledger,
        lock,
    })
}

fn bank() -> Option<Bank> {
    bank_with(&Owner::default())
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
        ("content-type".to_owned(), "application/json".to_owned()),
    ]
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
    /// `rejects.toMatchObject({ code })` on the BankError: the error's cause.
    fn cause(&self) -> String {
        let data = self.1.get("error").and_then(|e| e.get("data"));
        match data
            .and_then(|d| d.get("cause"))
            .and_then(|c| c.get("code"))
        {
            Some(Json::String(c)) => c.clone(),
            _ => format!("no cause: {} {}", self.0, self.1.compact()),
        }
    }
    fn message(&self) -> String {
        match self.1.get("error").and_then(|e| e.get("message")) {
            Some(Json::String(m)) => m.clone(),
            _ => String::new(),
        }
    }
}

fn post_as(door: &BankDoor, user: &str, path: &str, input: &Json) -> Answer {
    assert_eq!(door::call(path).map(|c| c.kind), Some(Kind::Mutation));
    let body = input.compact();
    let headers = person(user, WITHDRAW);
    let res = door.handle_from(
        &Request {
            method: "POST",
            url: &format!("/trpc/{path}"),
            headers: &headers,
            body: &body,
        },
        "req-ramps-offramp-db",
        "127.0.0.1",
    );
    Answer(res.status, json::parse(&res.body).unwrap())
}

/// One off-ramp of `amount` USDT under `id`, to `dest` when given (else the stored address).
fn offramp_on(
    door: &BankDoor,
    user: &str,
    id: &str,
    amount: &str,
    dest: Option<&str>,
    client_ref: &str,
) -> Answer {
    let mut f: Vec<(String, Json)> = vec![
        ("offrampId".to_owned(), Json::str(id)),
        ("assetId".to_owned(), Json::str("USDT")),
        ("amount".to_owned(), Json::str(amount)),
        ("kind".to_owned(), Json::str("crypto")),
        ("clientRef".to_owned(), Json::str(client_ref)),
    ];
    if let Some(d) = dest {
        f.push(("destinationRef".to_owned(), Json::str(d)));
    }
    post_as(door, user, "ramps.offramp", &Json::Object(f))
}

impl Bank {
    fn offramp(&self, id: &str, amount: &str, dest: Option<&str>, client_ref: &str) -> Answer {
        offramp_on(&self.door, USER, id, amount, dest, client_ref)
    }
    fn set_destination(&self, user: &str, r: &str) -> Answer {
        post_as(
            &self.door,
            user,
            "ramps.setWithdrawDestination",
            &Json::obj([("kind", Json::str("crypto")), ("ref", Json::str(r))]),
        )
    }
    fn rewired(&self, o: &Owner) -> BankDoor {
        door_for(&self.db, &self.ledger, &self.lock, o)
    }
    fn sql(&self, q: &str) {
        self.db.client().batch_execute(q).unwrap();
    }
    fn count(&self, q: &str) -> i64 {
        self.db.count(q)
    }
    fn offramp_rows(&self) -> i64 {
        self.count("SELECT count(*) FROM bank.ramp_offramps")
    }
    fn row(&self, id: &str) -> (String, Option<String>, Option<String>, Option<String>) {
        let r = self
            .db
            .client()
            .query_one(
                "SELECT status::text, rejection_code, hold_ledger_tx_id, settle_ledger_tx_id \
                 FROM bank.ramp_offramps WHERE id = $1::text::uuid",
                &[&id],
            )
            .unwrap();
        (r.get(0), r.get(1), r.get(2), r.get(3))
    }
    fn age_destination(&self, user: &str, hours: i64) {
        self.sql(&format!(
            "UPDATE bank.user_withdraw_destinations SET updated_at = now() - interval '{hours} hours' \
             WHERE user_id = '{user}' AND kind = 'crypto'"
        ));
    }
    fn list_fraud(&self, network: &str, address: &str) {
        self.sql(&format!(
            "INSERT INTO bank.destination_fraud_list (network, address_key, listed, revision, reason, approved_by) \
             VALUES ('{network}', '{}', true, 1, 'TEST: reported drainer address', 'approver')",
            address.to_ascii_lowercase()
        ));
    }
    fn stored_refs(&self, user: &str) -> Vec<String> {
        self.db
            .client()
            .query(
                "SELECT ref FROM bank.user_withdraw_destinations WHERE user_id = $1 AND kind = 'crypto' ORDER BY ref",
                &[&user],
            )
            .unwrap()
            .iter()
            .map(|r| r.get(0))
            .collect()
    }
}

fn status_of(j: &Json) -> String {
    text(j, "status")
}

// ---------------------------------------------------------------------------------------------------------------
// ramps.test.ts: refuse-closed defaults

#[test]
fn refuses_fiat_on_bank_fiat_ramp_socket_when_mode_is_none() {
    let Some(b) = bank_with(&Owner {
        mode: None,
        ..Owner::default()
    }) else {
        return;
    };
    let a = post_as(
        &b.door,
        USER,
        "ramps.offramp",
        &Json::obj([
            ("offrampId", Json::str(uuid())),
            ("assetId", Json::str("USDT")),
            ("amount", Json::str("10")),
            ("kind", Json::str("fiat")),
            ("destinationRef", Json::str("IBAN")),
            ("clientRef", Json::str("sneak-off")),
        ]),
    );
    assert_eq!(a.cause(), "bank.fiat_ramp_socket");
    assert_eq!(b.offramp_rows(), 0);
}

#[test]
fn refuses_every_money_path_when_no_programme_is_configured() {
    let Some(b) = bank_with(&Owner {
        mode: None,
        ..Owner::default()
    }) else {
        return;
    };
    b.ledger.fund(USER, "50");
    let a = b.offramp(&uuid(), "10", Some(DEAD), "none-off");
    assert_eq!(a.cause(), "bank.no_ramp_rail");
    assert_eq!(b.offramp_rows(), 0);
    assert!(b.ledger.posted().is_empty());
    // `none` spelled out is the same programme.
    let none = b.rewired(&Owner {
        mode: Some("none"),
        ..Owner::default()
    });
    let a = offramp_on(&none, USER, &uuid(), "10", Some(DEAD), "none-off-2");
    assert_eq!(a.cause(), "bank.no_ramp_rail");
}

#[test]
fn refuses_a_fiat_off_ramp_before_a_row_or_a_ledger_post() {
    let Some(b) = bank() else { return };
    b.ledger.fund(USER, "40");
    let a = post_as(
        &b.door,
        USER,
        "ramps.offramp",
        &Json::obj([
            ("offrampId", Json::str(uuid())),
            ("assetId", Json::str("USDT")),
            ("amount", Json::str("15")),
            ("kind", Json::str("fiat")),
            ("destinationRef", Json::str("GB82WEST12345698765432")),
            ("clientRef", Json::str("fiat-out-1")),
        ]),
    );
    assert_eq!(a.cause(), "bank.fiat_ramp_socket");
    assert_eq!(b.offramp_rows(), 0);
    assert!(b.ledger.posted().is_empty());
}

#[test]
fn refuses_a_blank_or_whitespace_asset_before_any_row_or_ledger_post() {
    let Some(b) = bank() else { return };
    let a = post_as(
        &b.door,
        USER,
        "ramps.offramp",
        &Json::obj([
            ("offrampId", Json::str(uuid())),
            ("assetId", Json::str(" USDT")),
            ("amount", Json::str("10")),
            ("kind", Json::str("crypto")),
            ("destinationRef", Json::str("0xabc")),
            ("clientRef", Json::str("blank-off-1")),
        ]),
    );
    assert_eq!(a.cause(), "bank.ramp_invalid_asset");
    assert_eq!(b.offramp_rows(), 0);
}

// ---------------------------------------------------------------------------------------------------------------
// ramps.test.ts and offramp-cooling.money.test.ts: the owner's cooling window

#[test]
fn blank_unset_non_integer_negative_refuse_offramp_cooling_unset_before_any_hold() {
    let Some(b) = bank() else { return };
    b.ledger.fund(USER, "80");
    for hours in [
        Some(""),
        Some("  "),
        Some("24h"),
        Some("-1"),
        Some("1.5"),
        None,
    ] {
        let closed = b.rewired(&Owner {
            cooling: hours,
            ..Owner::default()
        });
        let a = offramp_on(
            &closed,
            USER,
            &uuid(),
            "5",
            Some(DEAD),
            &format!("cool-{}", uuid()),
        );
        assert_eq!(a.cause(), "bank.offramp_cooling_unset", "{hours:?}");
    }
    assert!(b.ledger.posted().is_empty());
    assert_eq!(b.offramp_rows(), 0);
    assert_eq!(b.ledger.available(USER), "80");
}

#[test]
fn set_owner_window_allows_hold_then_settle_once_dest_is_older_than_the_window() {
    let Some(b) = bank_with(&Owner {
        cooling: Some("48"),
        ..Owner::default()
    }) else {
        return;
    };
    b.ledger.fund(USER, "80");
    b.set_destination(USER, DEAD).ok();
    b.age_destination(USER, 49);
    let id = uuid();
    let row = b.offramp(&id, "30", None, &format!("cool-set-{id}")).ok();
    assert_eq!(status_of(&row), "settled");
    assert!(!text(&row, "holdLedgerTxId").is_empty());
    assert!(!text(&row, "settleLedgerTxId").is_empty());
    assert_eq!(b.ledger.available(USER), "50");
}

#[test]
fn dest_inside_window_refuses_offramp_cooling_active_with_zero_ledger_posts() {
    let Some(b) = bank_with(&Owner {
        cooling: Some("48"),
        ..Owner::default()
    }) else {
        return;
    };
    b.ledger.fund(USER, "80");
    b.set_destination(USER, EVM).ok();
    let a = b.offramp(&uuid(), "10", None, "h8b-active");
    assert_eq!(a.cause(), "bank.offramp_cooling_active");
    assert!(b.ledger.posted().is_empty());
    assert_eq!(b.offramp_rows(), 0);
    assert_eq!(b.ledger.available(USER), "80");
}

#[test]
fn same_ref_persist_still_bumps_updated_at_and_restarts_the_window() {
    let Some(b) = bank_with(&Owner {
        cooling: Some("48"),
        ..Owner::default()
    }) else {
        return;
    };
    b.ledger.fund(USER, "80");
    b.set_destination(USER, EVM).ok();
    b.age_destination(USER, 49);
    b.set_destination(USER, EVM).ok();
    let a = b.offramp(&uuid(), "10", None, "h8b-bump");
    assert_eq!(a.cause(), "bank.offramp_cooling_active");
    assert!(!b.ledger.posted_any("withdrawHold"));
}

#[test]
fn changing_dest_restarts_the_window() {
    let Some(b) = bank_with(&Owner {
        cooling: Some("48"),
        ..Owner::default()
    }) else {
        return;
    };
    b.ledger.fund(USER, "80");
    b.set_destination(USER, EVM).ok();
    b.age_destination(USER, 49);
    b.set_destination(USER, EVM_OTHER).ok();
    let a = b.offramp(&uuid(), "10", None, "h8b-change");
    assert_eq!(a.cause(), "bank.offramp_cooling_active");
    assert!(!b.ledger.posted_any("withdrawHold"));
}

#[test]
fn zero_hours_is_a_real_owner_choice_dest_just_changed_is_not_cooling_active() {
    let Some(b) = bank() else { return };
    b.ledger.fund(USER, "20");
    b.set_destination(USER, EVM).ok();
    let id = uuid();
    let row = b.offramp(&id, "5", None, &format!("h8b-zero-{id}")).ok();
    assert_eq!(status_of(&row), "settled");
    assert_eq!(b.ledger.available(USER), "15");
}

#[test]
fn hours_set_and_dest_missing_is_withdraw_destination_missing_not_dest_elapsed() {
    let Some(b) = bank_with(&Owner {
        cooling: Some("48"),
        ..Owner::default()
    }) else {
        return;
    };
    let a = b.offramp(&uuid(), "5", None, "no-dest");
    assert_eq!(a.cause(), "bank.withdraw_destination_missing");
    assert_eq!(b.offramp_rows(), 0);
}

// ---------------------------------------------------------------------------------------------------------------
// ramps.test.ts: crypto off-ramp — hold then settle

#[test]
fn moves_value_to_the_rail_boundary_and_leaves_the_hold_at_zero() {
    let Some(b) = bank() else { return };
    b.ledger.fund(USER, "80");
    let id = uuid();
    let row = b.offramp(&id, "30", Some(DEAD), "off-1").ok();
    assert_eq!(status_of(&row), "settled");
    assert_eq!(row.get("simulated"), Some(&Json::Bool(true)));
    assert_eq!(text(&row, "id"), id);
    assert_eq!(text(&row, "amount"), "30");
    assert_eq!(text(&row, "rail"), "bank-crypto-ledger");
    assert_eq!(text(&row, "destinationRef"), DEAD);
    assert_eq!(
        text(&row, "holdLedgerTxId"),
        format!("tx-withdraw.hold:{id}")
    );
    assert_eq!(
        text(&row, "settleLedgerTxId"),
        format!("tx-withdraw.settle:{id}")
    );
    assert_eq!(b.ledger.available(USER), "50");
    assert_eq!(b.ledger.of(USER, &format!("hold:{id}")), "0");
    assert_eq!(b.ledger.of("bank-crypto-ledger", "rail"), "30");
    let (status, _, hold, settle) = b.row(&id);
    assert_eq!(status, "settled");
    assert_eq!(
        hold.as_deref(),
        Some(format!("tx-withdraw.hold:{id}").as_str())
    );
    assert_eq!(
        settle.as_deref(),
        Some(format!("tx-withdraw.settle:{id}").as_str())
    );
}

#[test]
fn refuses_insufficient_funds_by_name_and_rejects_the_row() {
    let Some(b) = bank() else { return };
    let id = uuid();
    let a = b.offramp(&id, "5", Some(DEAD), "broke");
    assert_eq!(a.0, 400);
    assert_eq!(a.cause(), "ledger.insufficient_funds");
    assert!(a.message().to_lowercase().contains("insufficient"));
    let (status, code, hold, settle) = b.row(&id);
    assert_eq!(status, "rejected");
    assert_eq!(code.as_deref(), Some("ledger.insufficient_funds"));
    assert_eq!((hold, settle), (None, None));
}

#[test]
fn a_concurrent_caller_cannot_settle_an_offramp_this_caller_rejected_for_insufficient_funds() {
    let Some(b) = bank() else { return };
    b.set_destination(USER, DEAD).ok();
    let id = uuid();
    // Both callers arrive while the balance is empty and the first is inside its hold; the session lock lets only one
    // past the claim at a time, so the second finds the row rejected. Funding the book the moment the first is refused
    // is the window a claim released before the posts would leave open.
    b.ledger.st().hold_ms = 300;
    let book = b.ledger.clone();
    let first_refused = Arc::new(Mutex::new(false));
    let door = Arc::new(b.rewired(&Owner::default()));
    let results: Vec<Answer> = std::thread::scope(|s| {
        let hs: Vec<_> = (0..2)
            .map(|_| {
                let door = Arc::clone(&door);
                let id = id.clone();
                let book = book.clone();
                let first_refused = Arc::clone(&first_refused);
                s.spawn(move || {
                    let a = offramp_on(&door, USER, &id, "10", None, &format!("race-{id}"));
                    let mut f = first_refused.lock().unwrap();
                    if !*f && a.cause() == "ledger.insufficient_funds" {
                        *f = true;
                        book.fund(USER, "10");
                    }
                    a
                })
            })
            .collect();
        hs.into_iter().map(|h| h.join().unwrap()).collect()
    });
    for a in &results {
        assert_ne!(a.0, 200, "no caller reports settled: {}", a.1.compact());
    }
    assert!(!b.ledger.posted_any("withdrawHold"));
    assert!(!b.ledger.posted_any("withdrawSettle"));
    let (status, code, _, _) = b.row(&id);
    assert_eq!(status, "rejected");
    assert_eq!(code.as_deref(), Some("ledger.insufficient_funds"));
    assert_eq!(
        b.offramp(&id, "10", None, &format!("race-{id}")).cause(),
        "bank.ramp_conflict"
    );
    // A zero amount is refused by the router's amount check.
    let zero = b.offramp(&uuid(), "0", None, &format!("zero-{id}"));
    assert_eq!(zero.cause(), "bank.ramp_invalid_amount");
}

#[test]
fn retries_on_the_same_client_ref_return_the_same_settled_offramp() {
    let Some(b) = bank() else { return };
    b.ledger.fund(USER, "40");
    let id = uuid();
    let a = b.offramp(&id, "10", Some(DEAD), "retry-me").ok();
    let again = b.offramp(&id, "10", Some(DEAD), "retry-me").ok();
    assert_eq!(text(&again, "id"), text(&a, "id"));
    assert_eq!(again, a);
    assert_eq!(b.ledger.available(USER), "30");
    // Another id under the same client ref is a conflict, not a second withdrawal.
    let other = b.offramp(&uuid(), "10", Some(DEAD), "retry-me");
    assert_eq!(other.cause(), "bank.ramp_conflict");
    assert_eq!(b.ledger.available(USER), "30");
}

#[test]
fn same_offramp_id_with_a_different_client_ref_is_ramp_conflict_not_raw_pg_23505() {
    let Some(b) = bank() else { return };
    b.ledger.fund(USER, "40");
    let id = uuid();
    b.offramp(&id, "10", Some(DEAD), "first-ref").ok();
    let a = b.offramp(&id, "10", Some(DEAD), "other-ref");
    assert_eq!(a.cause(), "bank.ramp_conflict");
    // The customer is told the code alone (`user-copy.ts`), never the id it collided on.
    assert_eq!(a.message(), "bank.ramp_conflict");
    // Another amount under the same id is the same conflict.
    assert_eq!(
        b.offramp(&id, "11", Some(DEAD), "first-ref").cause(),
        "bank.ramp_conflict"
    );
    assert_eq!(b.ledger.available(USER), "30");
}

#[test]
fn a_held_send_resumes_and_settles_once_under_the_same_id() {
    let Some(b) = bank() else { return };
    b.ledger.fund(USER, "20");
    b.ledger.st().settle_fails = true;
    let id = uuid();
    let a = b.offramp(&id, "8", Some(DEAD), "held-once");
    assert_eq!(a.0, 500, "{}", a.1.compact());
    let (status, _, hold, settle) = b.row(&id);
    assert_eq!(status, "pending");
    assert!(hold.is_some());
    assert!(settle.is_none());
    assert_eq!(b.ledger.available(USER), "12");
    b.ledger.st().settle_fails = false;
    let row = b.offramp(&id, "8", Some(DEAD), "held-once").ok();
    assert_eq!(status_of(&row), "settled");
    assert_eq!(b.ledger.available(USER), "12");
    let holds = b
        .ledger
        .posted()
        .iter()
        .filter(|(r, _)| r == "withdrawHold")
        .count();
    assert_eq!(holds, 1);
}

#[test]
fn with_the_custodial_layer_off_nothing_is_held_and_the_claim_holds_nothing() {
    let Some(b) = bank_with(&Owner {
        custody: "off",
        ..Owner::default()
    }) else {
        return;
    };
    b.ledger.fund(USER, "20");
    let id = uuid();
    let a = b.offramp(&id, "8", Some(DEAD), "custody-off");
    assert_eq!(a.cause(), "bank.no_partner_bank");
    assert!(b.ledger.posted().is_empty());
    assert_eq!(b.ledger.available(USER), "20");
    let (status, _, hold, _) = b.row(&id);
    assert_eq!((status.as_str(), hold), ("pending", None));
}

// ---------------------------------------------------------------------------------------------------------------
// ramps.test.ts: user withdraw destination persist before withdrawHold

#[test]
fn refuses_a_gibberish_dest_before_any_hold_is_posted() {
    let Some(b) = bank() else { return };
    b.ledger.fund(USER, "20");
    let a = b.offramp(&uuid(), "5", Some("0xdead"), "garbage-dest");
    assert_eq!(a.cause(), "bank.ramp_invalid_destination");
    assert_eq!(b.ledger.available(USER), "20");
    assert_eq!(b.offramp_rows(), 0);
}

#[test]
fn refuses_a_later_withdraw_when_no_dest_was_persisted() {
    let Some(b) = bank() else { return };
    b.ledger.fund(USER, "20");
    let a = b.offramp(&uuid(), "5", None, "missing-dest");
    assert_eq!(a.cause(), "bank.withdraw_destination_missing");
    assert_eq!(b.ledger.available(USER), "20");
}

#[test]
fn loads_a_persisted_dest_so_a_later_withdraw_has_a_real_ref() {
    let Some(b) = bank() else { return };
    let saved = b.set_destination(USER, DEAD).ok();
    assert_eq!(
        saved,
        Json::obj([("kind", Json::str("crypto")), ("ref", Json::str(DEAD))])
    );
    b.ledger.fund(USER, "20");
    let row = b.offramp(&uuid(), "8", None, "from-store").ok();
    assert_eq!(text(&row, "destinationRef"), DEAD);
    assert_eq!(status_of(&row), "settled");
    assert_eq!(b.ledger.available(USER), "12");
}

// ---------------------------------------------------------------------------------------------------------------
// ramps.test.ts: destination sanctions list (J-wallet-05 #2)

fn sanctioned_owner(list: &str) -> Owner {
    Owner {
        sanctions: Some(list.to_owned()),
        ..Owner::default()
    }
}

#[test]
fn starts_no_send_to_a_listed_address_offered_or_stored_and_holds_nothing() {
    let Some(b) = bank_with(&sanctioned_owner(&format!("*:{SANCTIONED}"))) else {
        return;
    };
    b.ledger.fund(USER, "20");
    let upper = format!("0x{}", SANCTIONED[2..].to_ascii_uppercase());
    let a = b.offramp(&uuid(), "8", Some(&upper), "sanctioned-off-1");
    assert_eq!(a.cause(), "bank.destination_sanctions_listed");
    assert!(b.stored_refs(USER).is_empty());
    // Stored before it was listed: still no send.
    let open = b.rewired(&Owner::default());
    post_as(
        &open,
        USER,
        "ramps.setWithdrawDestination",
        &Json::obj([
            ("kind", Json::str("crypto")),
            ("ref", Json::str(SANCTIONED)),
        ]),
    )
    .ok();
    let a = b.offramp(&uuid(), "8", None, "sanctioned-off-2");
    assert_eq!(a.cause(), "bank.destination_sanctions_listed");
    assert_eq!(b.ledger.available(USER), "20");
    assert_eq!(b.offramp_rows(), 0);
}

#[test]
fn a_send_held_before_its_address_was_listed_or_the_list_went_blank_refuses_and_stays_held() {
    for after in ["listed", "blank"] {
        let Some(b) = bank() else { return };
        b.ledger.fund(USER, "20");
        b.ledger.st().settle_fails = true;
        let id = uuid();
        let a = b.offramp(&id, "8", Some(SANCTIONED), &format!("held-off-{after}"));
        assert_eq!(a.0, 500, "{}", a.1.compact());
        assert_eq!(b.ledger.available(USER), "12");
        // Listed (or the list blanked) while it is held; the rail is back. The resume refuses and nothing settles.
        let later = if after == "listed" {
            sanctioned_owner(&format!("*:{SANCTIONED}"))
        } else {
            Owner {
                sanctions: None,
                ..Owner::default()
            }
        };
        b.ledger.st().settle_fails = false;
        let door = b.rewired(&later);
        let a = offramp_on(
            &door,
            USER,
            &id,
            "8",
            Some(SANCTIONED),
            &format!("held-off-{after}"),
        );
        let want = if after == "listed" {
            "bank.destination_sanctions_listed"
        } else {
            "bank.destination_sanctions_unset"
        };
        assert_eq!(a.cause(), want);
        let (status, _, hold, settle) = b.row(&id);
        assert_eq!(status, "pending");
        assert!(hold.is_some());
        assert!(settle.is_none());
        assert_eq!(b.ledger.available(USER), "12");
        assert!(!b.ledger.posted_any("withdrawSettle"));
    }
}

#[test]
fn answers_a_send_settled_before_its_address_was_listed_as_before_and_posts_nothing_more() {
    let Some(b) = bank() else { return };
    b.ledger.fund(USER, "20");
    let id = uuid();
    let first = b
        .offramp(&id, "8", Some(SANCTIONED), "settled-before-off")
        .ok();
    assert_eq!(status_of(&first), "settled");
    let posted = b.ledger.posted().len();
    let listed = b.rewired(&sanctioned_owner(&format!("*:{SANCTIONED}")));
    let again = offramp_on(
        &listed,
        USER,
        &id,
        "8",
        Some(SANCTIONED),
        "settled-before-off",
    )
    .ok();
    assert_eq!(text(&again, "id"), id);
    assert_eq!(status_of(&again), "settled");
    assert_eq!(b.ledger.posted().len(), posted);
}

#[test]
fn starts_no_send_while_the_list_is_unset_and_stores_no_withdrawal_address() {
    let Some(b) = bank_with(&Owner {
        sanctions: None,
        ..Owner::default()
    }) else {
        return;
    };
    b.ledger.fund(USER, "20");
    let a = b.offramp(&uuid(), "8", Some(DEAD), "unset-off");
    assert_eq!(a.cause(), "bank.destination_sanctions_unset");
    let a = b.set_destination(USER, DEAD);
    assert_eq!(a.cause(), "bank.destination_sanctions_unset");
    assert!(b.stored_refs(USER).is_empty());
    assert_eq!(b.ledger.available(USER), "20");
}

// ---------------------------------------------------------------------------------------------------------------
// ramps.test.ts: conservation

#[test]
fn closes_the_books_after_on_ramp_then_off_ramp() {
    let Some(b) = bank() else { return };
    b.ledger.fund(USER, "25");
    b.offramp(&uuid(), "25", Some(DEAD), "cons-off").ok();
    assert_eq!(b.ledger.available(USER), "0");
    assert_eq!(b.ledger.of("bank-crypto-ledger", "rail"), "25");
    let total: Amount = b.ledger.st().balances.values().sum();
    assert_eq!(
        format_amount(total),
        "25",
        "nothing made or lost: the funding is all there is"
    );
}

// ---------------------------------------------------------------------------------------------------------------
// security-lock.money.test.ts: a crypto withdrawal while the security lock holds (money)

fn locked_bank() -> Option<Bank> {
    let b = bank()?;
    b.ledger.fund(USER, "80");
    b.set_destination(USER, EVM).ok();
    Some(b)
}

fn send(b: &Bank, id: &str) -> Answer {
    b.offramp(id, "10", None, &format!("lock-send-{id}"))
}

fn nothing_moved(b: &Bank) {
    assert!(b.ledger.posted().is_empty());
    assert_eq!(b.offramp_rows(), 0);
    assert_eq!(b.ledger.available(USER), "80");
}

#[test]
fn refuses_security_locked_before_any_row_or_hold_and_the_balance_stays_whole() {
    let Some(b) = locked_bank() else { return };
    b.lock.set(USER, locked());
    let a = send(&b, &uuid());
    assert_eq!(a.cause(), "bank.security_locked");
    assert_eq!(
        a.message(),
        "The account's security lock is on, so a withdrawal is refused until it ends (2099-01-01T00:00:00.000Z)"
    );
    nothing_moved(&b);
}

#[test]
fn refuses_account_frozen_self_while_the_owner_froze_the_account_before_any_row_or_hold() {
    let Some(b) = locked_bank() else { return };
    b.lock.set(USER, self_frozen());
    assert_eq!(send(&b, &uuid()).cause(), "bank.account_frozen_self");
    nothing_moved(&b);
}

#[test]
fn refuses_when_identity_cannot_say_and_nothing_moves() {
    let Some(b) = locked_bank() else { return };
    b.lock
        .fail_with(refuse("bank.security_lock_unavailable", "identity is down"));
    assert_eq!(send(&b, &uuid()).cause(), "bank.security_lock_unavailable");
    nothing_moved(&b);
}

#[test]
fn answers_a_replay_of_a_send_settled_before_the_lock_as_before_and_posts_nothing_more() {
    let Some(b) = locked_bank() else { return };
    let id = uuid();
    let first = send(&b, &id).ok();
    assert_eq!(status_of(&first), "settled");
    let posted = b.ledger.posted().len();
    b.lock.set(USER, locked());
    let again = send(&b, &id).ok();
    assert_eq!(text(&again, "id"), text(&first, "id"));
    assert_eq!(status_of(&again), "settled");
    assert_eq!(b.ledger.posted().len(), posted);
    assert_eq!(send(&b, &uuid()).cause(), "bank.security_locked");
    assert_eq!(b.ledger.posted().len(), posted);
}

#[test]
fn refuses_even_a_replay_of_a_send_claimed_before_the_owner_froze_the_account() {
    let Some(b) = locked_bank() else { return };
    let id = uuid();
    assert_eq!(status_of(&send(&b, &id).ok()), "settled");
    let posted = b.ledger.posted().len();
    b.lock.set(USER, self_frozen());
    assert_eq!(send(&b, &id).cause(), "bank.account_frozen_self");
    assert_eq!(b.ledger.posted().len(), posted);
}

#[test]
fn refuses_a_replay_that_names_another_address_while_locked_and_the_withdrawal_address_stays() {
    let Some(b) = locked_bank() else { return };
    let id = uuid();
    let first = send(&b, &id).ok();
    b.lock.set(USER, locked());
    let attacker = "0x0000000000000000000000000000000000000001";
    let a = b.offramp(&id, "10", Some(attacker), &format!("lock-send-{id}"));
    assert_eq!(a.cause(), "bank.security_locked");
    assert_eq!(b.stored_refs(USER), vec![EVM.to_owned()]);
    let again = b
        .offramp(
            &id,
            "10",
            Some(&text(&first, "destinationRef")),
            &format!("lock-send-{id}"),
        )
        .ok();
    assert_eq!(status_of(&again), "settled");
}

#[test]
fn sends_once_the_lock_has_ended_the_same_request_id_then_goes_through_hold_and_settle_once() {
    let Some(b) = locked_bank() else { return };
    let id = uuid();
    b.lock.set(USER, locked());
    assert_eq!(send(&b, &id).cause(), "bank.security_locked");
    b.lock.set(USER, LockState::default());
    assert_eq!(status_of(&send(&b, &id).ok()), "settled");
    let holds = b
        .ledger
        .posted()
        .iter()
        .filter(|(r, _)| r == "withdrawHold")
        .count();
    assert_eq!(holds, 1);
    assert_eq!(b.ledger.available(USER), "70");
}

#[test]
fn the_legacy_withdrawal_address_door_refuses_while_the_lock_holds_and_the_book_is_unchanged() {
    let Some(b) = bank() else { return };
    b.lock.set(USER, locked());
    assert_eq!(b.set_destination(USER, EVM).cause(), "bank.security_locked");
    b.lock.set(USER, self_frozen());
    assert_eq!(
        b.set_destination(USER, EVM).cause(),
        "bank.account_frozen_self"
    );
    assert!(b.stored_refs(USER).is_empty());
    // Another person's lock is theirs alone.
    b.set_destination(OTHER, EVM).ok();
    assert_eq!(b.stored_refs(OTHER), vec![EVM.to_owned()]);
}

// ---------------------------------------------------------------------------------------------------------------
// fraud-list.db.test.ts: the send and the legacy door

#[test]
fn a_send_to_a_listed_address_is_refused_before_anything_is_claimed_or_held() {
    let Some(b) = bank() else { return };
    b.ledger.fund(USER, "20");
    b.list_fraud("ethereum", LISTED);
    let a = b.offramp(&uuid(), "1", Some(LISTED), "TEST-fraud-send");
    assert_eq!(a.cause(), "bank.destination_fraud_listed");
    assert_eq!(b.offramp_rows(), 0);
    assert!(b.stored_refs(USER).is_empty());
}

#[test]
fn a_reused_send_id_naming_a_listed_address_it_was_not_claimed_with_is_refused_before_the_address_is_stored()
 {
    let Some(b) = bank() else { return };
    b.list_fraud("*", LISTED);
    let claimed = uuid();
    b.sql(&format!(
        "INSERT INTO bank.ramp_offramps (id, user_id, asset_id, amount, kind, rail, destination_ref, client_ref) \
         VALUES ('{claimed}', '{USER}', 'USDT', 1, 'crypto', 'crypto-ledger', '{EVM}', 'TEST-claimed-send')"
    ));
    let a = b.offramp(&claimed, "1", Some(LISTED), "TEST-claimed-send");
    assert_eq!(a.cause(), "bank.destination_fraud_listed");
    assert!(b.stored_refs(USER).is_empty());
    assert_eq!(
        b.count(&format!(
            "SELECT count(*) FROM bank.ramp_offramps WHERE id = '{claimed}' AND destination_ref = '{EVM}'"
        )),
        1
    );
}

#[test]
fn the_legacy_withdrawal_address_door_refuses_a_listed_address_in_any_case_and_stores_nothing() {
    let Some(b) = bank() else { return };
    b.list_fraud("ethereum", LISTED);
    let upper = format!("0x{}", LISTED[2..].to_ascii_uppercase());
    for r in [LISTED, upper.as_str()] {
        assert_eq!(
            b.set_destination(USER, r).cause(),
            "bank.destination_fraud_listed"
        );
    }
    assert!(b.stored_refs(USER).is_empty());
    assert_eq!(text(&b.set_destination(USER, EVM).ok(), "ref"), EVM);
}

// ---------------------------------------------------------------------------------------------------------------
// ramp-rejected-omits-ledger-tx.test.ts and ramp-kind-crypto.test.ts: the off-ramp table

#[test]
fn the_offramp_table_refuses_fiat_and_a_rejected_row_naming_its_postings() {
    let Some(b) = bank() else { return };
    let mut c = b.db.client();
    let insert = |c: &mut postgres::Client, extra_cols: &str, extra_vals: &str, kind: &str| {
        c.batch_execute(&format!(
            "INSERT INTO bank.ramp_offramps (id, user_id, asset_id, amount, kind, rail, destination_ref, client_ref{extra_cols}) \
             VALUES ('{}', '{USER}', 'USDT', 1, '{kind}', 'bank-crypto-ledger', '{EVM}', '{}'{extra_vals})",
            uuid(),
            uuid()
        ))
    };
    assert!(
        insert(&mut c, "", "", "fiat").is_err(),
        "kind fiat is refused"
    );
    assert!(insert(&mut c, "", "", "crypto").is_ok());
    assert!(
        insert(
            &mut c,
            ", status, rejection_code, hold_ledger_tx_id",
            ", 'rejected', 'ledger.insufficient_funds', 'tx-hold'",
            "crypto"
        )
        .is_err(),
        "a rejected off-ramp names no hold"
    );
    assert!(
        insert(
            &mut c,
            ", status, rejection_code, release_ledger_tx_id",
            ", 'rejected', 'ledger.insufficient_funds', 'tx-release'",
            "crypto"
        )
        .is_ok(),
        "a release id only on a rejected off-ramp"
    );
    assert!(
        insert(
            &mut c,
            ", status, release_ledger_tx_id",
            ", 'pending', 'tx-release'",
            "crypto"
        )
        .is_err(),
        "a pending off-ramp names no release"
    );
    assert!(
        insert(
            &mut c,
            ", status, hold_ledger_tx_id",
            ", 'settled', 'tx-hold'",
            "crypto"
        )
        .is_err(),
        "a settled off-ramp names both postings"
    );
}

#[test]
fn a_settled_row_reads_back_with_its_created_time() {
    let Some(b) = bank() else { return };
    b.ledger.fund(USER, "5");
    let before = door::system_now().0;
    let row = b.offramp(&uuid(), "5", Some(DEAD), "created").ok();
    let created = service_kit::time::zod_datetime(&text(&row, "createdAt"), false).unwrap();
    assert!(created.0 >= before - 1000 && created.0 <= door::system_now().0 + 1000);
    let _ = Instant(created.0);
}
