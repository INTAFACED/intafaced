//! Slice `transfers`'s moves and standing orders against the Rust door on a real Postgres. Ports the checks of the
//! TypeScript's `transfers/schedule-edit.db.test.ts`, `schedule-retry-id.test.ts`, `transfer-message.db.test.ts` (the
//! note's own row), `rejected-omits-ledger-tx.db.test.ts`, and `bank-service.test.ts`'s one-off transfers, scheduled
//! transfers, pause and resume, the ownership refusals and the stranger's-space oracle, each test named after the
//! TypeScript test's words. Every call enters through the door, as the TypeScript's router tests do; a service-level
//! TypeScript call is the door call that reaches it, and the runner is `ops.runDueTransfers` signed as svc-bank (or the
//! job door). The one knob the door does not take, a pass's catch-up bound, is driven through `schedules::run_due`.
//!
//! The ledger is a stand-in that books `bankTransfer` as svc-ledger does: one credit leg on the payer, one debit leg on
//! the payee, once per key, refused `ledger.insufficient_funds` when the payer holds too little. Without
//! `TEST_DATABASE_URL` each test skips; with `REQUIRE_POSTGRES=1` it fails.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::too_many_lines,
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
use svc_bank::transfers::ports::{
    AccountOf, ExtraControls, Extras, HandleUnavailable, LockState, MemoryIdentity, PartyHandles,
    RecipientState, RecipientStatus, RecipientUnavailable, SecurityLock,
};
use svc_bank::transfers::{self, Settings, Wiring as TransfersWiring, schedules};

use support::TestDb;

const SECRET: &str = "a-bank-transfers-db-edge-secret-long-enough";
const INTERNAL: &str = "a-bank-transfers-db-internal-secret-long-enough";
const USER_A: &str = "11111111-1111-4111-8111-111111111111";
const USER_B: &str = "22222222-2222-4222-8222-222222222222";
const CARA: &str = "33333333-3333-4333-8333-333333333333";
const NO_SUCH_USER: &str = "99999999-0000-4000-8000-000000000000";
const DAY: i64 = 24 * 3_600_000;

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
                .unwrap_or(Amount::ZERO),
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
        let mut st = self.0.lock().unwrap();
        if st.poison.as_deref().is_some_and(|p| key.starts_with(p)) {
            return Err(PostFailure::Coded {
                code: "ledger.frozen".to_owned(),
                message: "Ledger posting is frozen: isolation residual test".to_owned(),
                attempts: 1,
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
            key: String::new(),
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

/// `runDueTransfers({ now, limit })`: one pass at `now`, as svc-bank's own job calls it.
fn run_at(b: &Bank, now: &str, limit: i64) -> Json {
    set_now(at(now));
    let input = format!(r#"{{"limit":{limit}}}"#);
    send(
        &b.door,
        "ops.runDueTransfers",
        Some(&input),
        signed("svc-bank", &input),
    )
    .ok()
}

/// `runDueTransfers({ now, limit, maxCatchUp })`: the bound the door does not take.
fn run_bounded(b: &Bank, now: &str, limit: f64, max_catch_up: i64) -> schedules::RunReport {
    let partner = partner_wiring();
    let spaces = spaces_wiring(&b.ledger);
    let w = transfers_wiring(&b.identity, &b.owner);
    let store = b.store();
    let custody = partner.custody(&store);
    let d = transfers::Deps {
        store: &store,
        ledger: &b.ledger,
        custody: &custody,
        partner: &partner,
        spaces: &spaces,
        w: &w,
        now: Instant(at(now)),
    };
    schedules::run_due(&d, Some(limit), max_catch_up).unwrap()
}

fn n(j: &Json, key: &str) -> i64 {
    match j.get(key) {
        Some(Json::Number(v)) => {
            #[allow(clippy::cast_possible_truncation, reason = "a count")]
            let i = *v as i64;
            i
        }
        other => panic!("{key}: {other:?} in {}", j.compact()),
    }
}

fn text(j: &Json, key: &str) -> String {
    match j.get(key) {
        Some(Json::String(s)) => s.clone(),
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
    service_kit::approvals::random_uuid().unwrap()
}

/// `spaces.ensurePrimary`.
fn primary(b: &Bank, user: &str, asset: &str) -> String {
    space::with(&b.store(), |c| space::ensure_primary(c, user, asset))
        .unwrap()
        .id
}

fn find_primary(b: &Bank, user: &str) -> i64 {
    b.count(&format!(
        "SELECT count(*) FROM bank.spaces WHERE user_id = '{user}' AND kind = 'primary'"
    ))
}

/// `spaces.create`.
fn pot(b: &Bank, user: &str, asset: &str, name: &str) -> String {
    text(
        &call(
            b,
            user,
            "spaces.create",
            &format!(r#"{{"assetId":"{asset}","name":"{name}"}}"#),
        )
        .ok(),
        "id",
    )
}

fn lock_until(b: &Bank, space: &str, until: &str) {
    b.sql(&format!(
        "UPDATE bank.spaces SET locked_until = '{until}'::timestamptz WHERE id = '{space}'"
    ))
    .unwrap();
}

fn archive(b: &Bank, user: &str, space: &str) {
    call(
        b,
        user,
        "spaces.archive",
        &format!(r#"{{"spaceId":"{space}"}}"#),
    )
    .ok();
}

/// `transfers.create`.
fn transfer(b: &Bank, user: &str, id: &str, from: &str, to: &str, amount: &str) -> Answer {
    call(
        b,
        user,
        "transfers.create",
        &format!(
            r#"{{"transferId":"{id}","fromSpaceId":"{from}","toSpaceId":"{to}","amount":"{amount}"}}"#
        ),
    )
}

/// A standing order between two spaces, as the person.
struct Order<'a> {
    id: String,
    from: &'a str,
    to: &'a str,
    amount: &'a str,
    cadence: &'a str,
    starts: &'a str,
    ends: Option<&'a str>,
}

impl Order<'_> {
    fn input(&self) -> String {
        let ends = self
            .ends
            .map_or(String::new(), |e| format!(r#","endsAt":"{e}""#));
        format!(
            r#"{{"scheduleId":"{}","fromSpaceId":"{}","toSpaceId":"{}","amount":"{}","cadence":"{}","startsAt":"{}"{ends}}}"#,
            self.id, self.from, self.to, self.amount, self.cadence, self.starts
        )
    }
}

fn order<'a>(
    from: &'a str,
    to: &'a str,
    amount: &'a str,
    cadence: &'a str,
    starts: &'a str,
) -> Order<'a> {
    Order {
        id: uuid(),
        from,
        to,
        amount,
        cadence,
        starts,
        ends: None,
    }
}

fn schedule(b: &Bank, user: &str, o: &Order<'_>) -> Answer {
    call(b, user, "transfers.schedule", &o.input())
}

fn executions(b: &Bank, user: &str, schedule: &str) -> Vec<Json> {
    arr(&call(
        b,
        user,
        "transfers.executions",
        &format!(r#"{{"scheduleId":"{schedule}","limit":50}}"#),
    )
    .ok())
}

fn occurrences(b: &Bank, user: &str, schedule: &str) -> Vec<i64> {
    executions(b, user, schedule)
        .iter()
        .map(|e| n(e, "occurrence"))
        .collect()
}

fn by_id(id: &str) -> String {
    format!(r#"{{"scheduleId":"{id}"}}"#)
}

fn pause(b: &Bank, user: &str, id: &str) -> Answer {
    call(b, user, "transfers.pause", &by_id(id))
}

fn resume_at(b: &Bank, user: &str, id: &str, now: &str) -> Answer {
    set_now(at(now));
    call(b, user, "transfers.resume", &by_id(id))
}

fn cancel(b: &Bank, user: &str, id: &str) -> Answer {
    call(b, user, "transfers.cancel", &by_id(id))
}

fn skipped(a: &Answer) -> Vec<i64> {
    arr(a.ok().get("skipped").unwrap())
        .iter()
        .map(|v| match v {
            Json::Number(x) => {
                #[allow(clippy::cast_possible_truncation, reason = "an occurrence")]
                let i = *x as i64;
                i
            }
            other => panic!("{other:?}"),
        })
        .collect()
}

fn update(
    b: &Bank,
    user: &str,
    id: &str,
    revision: i64,
    amount: &str,
    ends: Option<&str>,
) -> Answer {
    let ends = ends.map_or("null".to_owned(), |e| format!(r#""{e}""#));
    call(
        b,
        user,
        "transfers.updateSchedule",
        &format!(
            r#"{{"scheduleId":"{id}","revision":{revision},"amount":"{amount}","endsAt":{ends}}}"#
        ),
    )
}

fn listed(b: &Bank, user: &str, id: &str) -> Json {
    arr(&call(b, user, "transfers.listSchedules", r#"{"limit":50}"#).ok())
        .into_iter()
        .find(|s| text(s, "id") == id)
        .expect("the order is listed")
}

// ---------------------------------------------------------------------------------------------------------------
// `bank-service.test.ts`: one-off transfers

#[test]
fn moves_value_between_two_spaces_and_the_books_still_close() {
    let Some(b) = bank() else { return };
    let main = primary(&b, USER_A, "USDT");
    let rent = pot(&b, USER_A, "USDT", "Rent");
    b.ledger.fund(USER_A, "USDT", "1000");
    let moved = transfer(&b, USER_A, "transfer-rent-1", &main, &rent, "250").ok();
    assert_eq!(text(&moved, "amount"), "250");
    assert_eq!(text(&moved, "partnerMove"), "null");
    assert_eq!(b.ledger.available(USER_A), "750");
    assert_eq!(b.ledger.pot(&rent), "250");
    assert_eq!(b.ledger.total(), "1000");
}

#[test]
fn is_idempotent_on_the_transfer_id_a_retried_request_moves_value_once() {
    let Some(b) = bank() else { return };
    let main = primary(&b, USER_A, "USDT");
    let rent = pot(&b, USER_A, "USDT", "Rent");
    b.ledger.fund(USER_A, "USDT", "1000");
    let first = transfer(&b, USER_A, "transfer-retry-1", &main, &rent, "250").ok();
    let second = transfer(&b, USER_A, "transfer-retry-1", &main, &rent, "250").ok();
    assert_eq!(text(&second, "ledgerTxId"), text(&first, "ledgerTxId"));
    assert_eq!(b.ledger.available(USER_A), "750");
}

#[test]
fn rejects_a_transfer_with_insufficient_funds_and_moves_nothing() {
    let Some(b) = bank() else { return };
    let main = primary(&b, USER_A, "USDT");
    let rent = pot(&b, USER_A, "USDT", "Rent");
    b.ledger.fund(USER_A, "USDT", "100");
    let broke = transfer(&b, USER_A, "transfer-broke-1", &main, &rent, "101");
    assert_eq!(broke.trpc(), "BAD_REQUEST");
    assert!(
        broke.message().contains("Insufficient USDT"),
        "{}",
        broke.message()
    );
    assert_eq!(b.ledger.available(USER_A), "100");
    assert_eq!(b.ledger.pot(&rent), "0");
    assert_eq!(b.ledger.posts(), 0);
}

#[test]
fn refuses_to_change_asset_mid_transfer() {
    let Some(b) = bank() else { return };
    let usdt = primary(&b, USER_A, "USDT");
    let eur = primary(&b, USER_A, "EUR");
    b.ledger.fund(USER_A, "USDT", "100");
    let fx = transfer(&b, USER_A, "transfer-fx-1", &usdt, &eur, "10");
    assert_eq!(fx.code(), "bank.asset_mismatch");
    assert_eq!(
        fx.message(),
        "Cannot transfer USDT into a EUR space — convert first"
    );
    assert_eq!(b.ledger.available(USER_A), "100");
}

#[test]
fn refuses_to_debit_a_space_the_user_has_locked_and_moves_nothing() {
    let Some(b) = bank() else { return };
    set_now(at("2026-11-02T09:00:00Z"));
    let main = primary(&b, USER_A, "USDT");
    let locked = pot(&b, USER_A, "USDT", "Locked away");
    b.ledger.fund(USER_A, "USDT", "500");
    transfer(&b, USER_A, "seed-locked-1", &main, &locked, "200").ok();
    lock_until(&b, &locked, "2026-12-02T09:00:00Z");
    let broke = transfer(&b, USER_A, "break-lock-1", &locked, &main, "50");
    assert_eq!(broke.code(), "bank.space_locked");
    assert_eq!(b.ledger.pot(&locked), "200");
    assert_eq!(b.ledger.available(USER_A), "300");
}

#[test]
fn moves_value_between_two_different_users_spaces() {
    let Some(b) = bank() else { return };
    let a = primary(&b, USER_A, "USDT");
    let bb = primary(&b, USER_B, "USDT");
    b.ledger.fund(USER_A, "USDT", "80");
    transfer(&b, USER_A, "peer-transfer-1", &a, &bb, "80").ok();
    assert_eq!(b.ledger.available(USER_A), "0");
    assert_eq!(b.ledger.available(USER_B), "80");
    assert_eq!(b.ledger.total(), "80");
}

// ---------------------------------------------------------------------------------------------------------------
// `transfer-message.db.test.ts`: the note's own row

#[test]
fn keeps_one_note_for_transfers_create_and_refuses_another_note_or_a_late_one_on_the_same_transfer()
{
    let Some(b) = bank() else { return };
    let from = primary(&b, USER_A, "USDT");
    let to = primary(&b, USER_B, "USDT");
    primary(&b, CARA, "USDT");
    b.ledger.fund(USER_A, "USDT", "100");
    let with_note = |id: &str, amount: &str, note: Option<&str>| {
        let note = note.map_or(String::new(), |n| format!(r#","note":"{n}""#));
        call(
            &b,
            USER_A,
            "transfers.create",
            &format!(
                r#"{{"transferId":"{id}","fromSpaceId":"{from}","toSpaceId":"{to}","amount":"{amount}"{note}}}"#
            ),
        )
    };
    let posted = with_note("create-note-0001", "10", Some("for lunch")).ok();
    let other = with_note("create-note-0001", "10", Some("a different note"));
    assert_eq!(
        (other.trpc().as_str(), other.code().as_str()),
        ("CONFLICT", "bank.transfer_message_conflict")
    );
    let bare = with_note("create-none-0001", "1", None).ok();
    let late = with_note("create-none-0001", "1", Some("too late"));
    assert_eq!(
        (late.trpc().as_str(), late.code().as_str()),
        ("CONFLICT", "bank.transfer_message_conflict")
    );
    assert_ne!(text(&bare, "ledgerTxId"), text(&posted, "ledgerTxId"));
    // The custodial path: a ledger transaction, and no partner move.
    assert_eq!(text(&posted, "partnerMove"), "null");
    assert_eq!(
        b.count("SELECT count(*) FROM bank.transfer_messages WHERE note = 'for lunch'"),
        1
    );
    assert_eq!(b.ledger.available(USER_B), "11");
}

// ---------------------------------------------------------------------------------------------------------------
// `bank-service.test.ts`: scheduled transfers

/// A standing order from USER_A's main space into a new pot.
fn standing_order(b: &Bank, value: &str, cadence: &str, starts: &str) -> (String, String, String) {
    let main = primary(b, USER_A, "USDT");
    let rent = pot(b, USER_A, "USDT", "Rent");
    let o = order(&main, &rent, value, cadence, starts);
    let id = text(&schedule(b, USER_A, &o).ok(), "id");
    (main, rent, id)
}

#[test]
fn refuses_standing_order_to_a_dest_user_with_no_primary_no_row_nothing_posted() {
    let Some(b) = bank() else { return };
    let a = primary(&b, USER_A, "USDT");
    b.ledger.fund(USER_A, "USDT", "50");
    let refused = call(
        &b,
        USER_A,
        "transfers.scheduleToUser",
        &format!(
            r#"{{"scheduleId":"{}","fromSpaceId":"{a}","toUserId":"{NO_SUCH_USER}","amount":"10","cadence":"monthly","startsAt":"2026-01-01T09:00:00Z"}}"#,
            uuid()
        ),
    );
    assert_eq!(refused.code(), "bank.recipient_cannot_receive");
    assert_eq!(b.count("SELECT count(*) FROM bank.scheduled_transfers"), 0);
    assert_eq!(b.ledger.posts(), 0);
    assert_eq!(b.ledger.available(USER_A), "50");
}

#[test]
fn schedules_to_a_member_who_has_never_held_the_asset_the_run_pays_the_account_the_schedule_opened()
{
    let Some(b) = bank() else { return };
    let a = primary(&b, USER_A, "USDT");
    b.ledger.fund(USER_A, "USDT", "100");
    assert_eq!(find_primary(&b, USER_B), 0);
    let made = call(
        &b,
        USER_A,
        "transfers.scheduleToUser",
        &format!(
            r#"{{"scheduleId":"{}","fromSpaceId":"{a}","toUserId":"{USER_B}","amount":"25","cadence":"monthly","startsAt":"2026-01-01T09:00:00Z"}}"#,
            uuid()
        ),
    )
    .ok();
    assert_eq!(find_primary(&b, USER_B), 1);
    let id = text(&made, "id");
    assert_eq!(n(&run_at(&b, "2026-01-01T10:00:00Z", 200), "settled"), 1);
    assert_eq!(n(&run_at(&b, "2026-01-01T10:00:00Z", 200), "settled"), 0);
    assert_eq!(b.ledger.available(USER_A), "75");
    assert_eq!(b.ledger.available(USER_B), "25");
    assert!(b.ledger.keys().iter().any(|k| k.contains(&id)));
    // The order pays another person: the list names no destination of the caller's own.
    assert_eq!(text(&listed(&b, USER_A, &id), "toSpaceId"), "null");
}

#[test]
fn fires_once_even_when_the_job_runs_twice() {
    let Some(b) = bank() else { return };
    let (_, rent, id) = standing_order(&b, "100", "monthly", "2026-01-01T09:00:00Z");
    b.ledger.fund(USER_A, "USDT", "1000");
    let first = run_at(&b, "2026-01-01T10:00:00Z", 200);
    let second = run_at(&b, "2026-01-01T10:00:00Z", 200);
    assert_eq!((n(&first, "settled"), n(&second, "settled")), (1, 0));
    assert_eq!(b.ledger.pot(&rent), "100");
    assert_eq!(b.ledger.available(USER_A), "900");
    let ex = executions(&b, USER_A, &id);
    assert_eq!(ex.len(), 1);
    assert_eq!(
        (n(&ex[0], "occurrence"), text(&ex[0], "status")),
        (0, "settled".to_owned())
    );
}

#[test]
fn fires_once_even_when_eight_runs_race_each_other() {
    let Some(b) = bank() else { return };
    let (_, rent, _) = standing_order(&b, "100", "monthly", "2026-01-01T09:00:00Z");
    b.ledger.fund(USER_A, "USDT", "1000");
    std::thread::scope(|s| {
        for _ in 0..8 {
            s.spawn(|| {
                set_now(at("2026-01-01T10:00:00Z"));
                let input = r#"{"limit":200}"#;
                send(
                    &b.door,
                    "ops.runDueTransfers",
                    Some(input),
                    signed("svc-bank", input),
                );
            });
        }
    });
    assert_eq!(b.ledger.pot(&rent), "100");
    assert_eq!(b.ledger.posts(), 1);
}

#[test]
fn one_schedule_that_throws_mid_drive_does_not_stop_every_other_standing_order_on_the_pass() {
    let Some(b) = bank() else { return };
    let main_a = primary(&b, USER_A, "USDT");
    let rent_a = pot(&b, USER_A, "USDT", "Rent A");
    let main_b = primary(&b, USER_B, "USDT");
    let rent_b = pot(&b, USER_B, "USDT", "Rent B");
    b.ledger.fund(USER_A, "USDT", "500");
    b.ledger.fund(USER_B, "USDT", "500");
    let a = text(
        &schedule(
            &b,
            USER_A,
            &order(&main_a, &rent_a, "100", "monthly", "2026-01-01T09:00:00Z"),
        )
        .ok(),
        "id",
    );
    schedule(
        &b,
        USER_B,
        &order(&main_b, &rent_b, "100", "monthly", "2026-01-01T09:00:00Z"),
    )
    .ok();
    b.ledger.poison(&format!("bank.transfer.sched:{a}:"));
    let report = run_at(&b, "2026-01-01T10:00:00Z", 200);
    let failures = arr(report.get("failures").unwrap());
    assert!(
        failures
            .iter()
            .any(|f| text(f, "scheduleId") == a && text(f, "code") == "ledger.frozen"),
        "{}",
        report.compact()
    );
    assert_eq!(n(&report, "settled"), 1);
    assert_eq!(b.ledger.pot(&rent_b), "100");
    // A: the occurrence is not consumed; the claim rolled back.
    assert!(executions(&b, USER_A, &a).is_empty());
    assert_eq!(b.ledger.available(USER_A), "500");
}

#[test]
fn permanently_failing_schedules_cannot_starve_healthy_ones_under_the_batch_limit() {
    let Some(b) = bank() else { return };
    let main_a = primary(&b, USER_A, "USDT");
    let rent_a = pot(&b, USER_A, "USDT", "Poison rent");
    let main_b = primary(&b, USER_B, "USDT");
    let rent_b = pot(&b, USER_B, "USDT", "Healthy rent");
    b.ledger.fund(USER_A, "USDT", "500");
    b.ledger.fund(USER_B, "USDT", "500");
    let poison = text(
        &schedule(
            &b,
            USER_A,
            &order(&main_a, &rent_a, "100", "monthly", "2026-01-01T08:00:00Z"),
        )
        .ok(),
        "id",
    );
    let healthy = text(
        &schedule(
            &b,
            USER_B,
            &order(&main_b, &rent_b, "100", "monthly", "2026-01-01T09:00:00Z"),
        )
        .ok(),
        "id",
    );
    b.ledger.poison(&format!("bank.transfer.sched:{poison}:"));
    let first = run_at(&b, "2026-01-01T10:00:00Z", 1);
    assert!(
        arr(first.get("failures").unwrap())
            .iter()
            .any(|f| text(f, "scheduleId") == poison && text(f, "code") == "ledger.frozen")
    );
    assert_eq!(n(&first, "settled"), 0);
    let second = run_at(&b, "2026-01-01T10:00:00Z", 1);
    assert_eq!(n(&second, "settled"), 1);
    assert_eq!(b.ledger.pot(&rent_b), "100");
    assert_eq!(executions(&b, USER_B, &healthy).len(), 1);
    assert!(executions(&b, USER_A, &poison).is_empty());
}

#[test]
fn records_a_rejection_and_moves_nothing_when_the_space_is_empty() {
    let Some(b) = bank() else { return };
    let (_, rent, id) = standing_order(&b, "100", "monthly", "2026-01-01T09:00:00Z");
    let report = run_at(&b, "2026-01-01T10:00:00Z", 200);
    assert_eq!((n(&report, "rejected"), n(&report, "settled")), (1, 0));
    assert_eq!(b.ledger.pot(&rent), "0");
    assert_eq!(b.ledger.available(USER_A), "0");
    let ex = executions(&b, USER_A, &id);
    assert_eq!(
        (
            n(&ex[0], "occurrence"),
            text(&ex[0], "status"),
            text(&ex[0], "rejectionCode"),
            text(&ex[0], "ledgerTxId")
        ),
        (
            0,
            "rejected".to_owned(),
            "ledger.insufficient_funds".to_owned(),
            "null".to_owned()
        )
    );
}

#[test]
fn refuses_a_standing_debit_from_a_locked_space_same_gate_as_a_one_off_no_silent_drain() {
    let Some(b) = bank() else { return };
    let main = primary(&b, USER_A, "USDT");
    let locked = pot(&b, USER_A, "USDT", "Locked rent pot");
    let rent = pot(&b, USER_A, "USDT", "Rent due");
    b.ledger.fund(USER_A, "USDT", "500");
    transfer(&b, USER_A, "seed-locked-so-1", &main, &locked, "200").ok();
    lock_until(&b, &locked, "2027-01-01T00:00:00Z");
    let id = text(
        &schedule(
            &b,
            USER_A,
            &order(&locked, &rent, "50", "monthly", "2026-01-01T09:00:00Z"),
        )
        .ok(),
        "id",
    );
    let report = run_at(&b, "2026-01-01T10:00:00Z", 200);
    assert_eq!((n(&report, "rejected"), n(&report, "settled")), (1, 0));
    assert_eq!(b.ledger.pot(&locked), "200");
    assert_eq!(b.ledger.pot(&rent), "0");
    let ex = executions(&b, USER_A, &id);
    assert_eq!(text(&ex[0], "rejectionCode"), "bank.space_locked");
    // The occurrence is consumed: a later run with the lock still on does not retry it.
    run_at(&b, "2026-01-15T10:00:00Z", 200);
    assert_eq!(executions(&b, USER_A, &id).len(), 1);
}

#[test]
fn recovers_a_post_then_lock_crash_as_settled_never_rejected_with_money_moved() {
    let Some(b) = bank() else { return };
    let main = primary(&b, USER_A, "USDT");
    let rent = pot(&b, USER_A, "USDT", "Rent due");
    b.ledger.fund(USER_A, "USDT", "500");
    let id = text(
        &schedule(
            &b,
            USER_A,
            &order(&main, &rent, "50", "monthly", "2026-01-01T09:00:00Z"),
        )
        .ok(),
        "id",
    );
    // The ledger booked occurrence 0 and the process died before its claim committed.
    let account = |owner_type: &'static str, owner: &str| LedgerAccount {
        owner_type,
        owner_id: owner.to_owned(),
        asset_id: "USDT".to_owned(),
        kind: "available",
        purpose: None,
    };
    b.ledger
        .post_recipe(
            "bankTransfer",
            &Json::obj([
                ("transferId", Json::str(id.clone())),
                ("occurrence", Json::int(0)),
                ("from", account("user", USER_A).json()),
                ("to", account("subaccount", &rent).json()),
                ("amount", Json::str("50")),
                ("kind", Json::str("scheduled")),
                ("keySpace", Json::str("sched")),
            ]),
            &format!("bank.transfer.sched:{id}:0"),
        )
        .unwrap();
    assert_eq!(b.ledger.pot(&rent), "50");
    lock_until(&b, &main, "2027-01-01T00:00:00Z");
    let report = run_at(&b, "2026-01-01T10:00:00Z", 200);
    assert_eq!((n(&report, "settled"), n(&report, "rejected")), (1, 0));
    assert_eq!(b.ledger.pot(&rent), "50");
    assert_eq!(b.ledger.available(USER_A), "450");
    assert_eq!(text(&executions(&b, USER_A, &id)[0], "status"), "settled");
}

#[test]
fn refuses_a_standing_credit_into_an_archived_space_and_moves_nothing() {
    let Some(b) = bank() else { return };
    let main = primary(&b, USER_A, "USDT");
    let jar = pot(&b, USER_A, "USDT", "Old jar");
    b.ledger.fund(USER_A, "USDT", "300");
    let id = text(
        &schedule(
            &b,
            USER_A,
            &order(&main, &jar, "40", "monthly", "2026-01-01T09:00:00Z"),
        )
        .ok(),
        "id",
    );
    archive(&b, USER_A, &jar);
    let report = run_at(&b, "2026-01-01T10:00:00Z", 200);
    assert_eq!((n(&report, "rejected"), n(&report, "settled")), (1, 0));
    assert_eq!(b.ledger.available(USER_A), "300");
    assert_eq!(
        text(&executions(&b, USER_A, &id)[0], "rejectionCode"),
        "bank.space_archived"
    );
}

#[test]
fn does_not_retry_an_occurrence_that_was_rejected_a_missed_march_is_not_made_up_in_april() {
    let Some(b) = bank() else { return };
    let (_, rent, id) = standing_order(&b, "100", "monthly", "2026-01-01T00:00:00Z");
    run_at(&b, "2026-01-01T10:00:00Z", 200);
    b.ledger.fund(USER_A, "USDT", "1000");
    run_at(&b, "2026-01-15T10:00:00Z", 200);
    assert_eq!(b.ledger.pot(&rent), "0");
    let january = executions(&b, USER_A, &id);
    assert_eq!(january.len(), 1);
    assert_eq!(
        (text(&january[0], "status"), text(&january[0], "amount")),
        ("rejected".to_owned(), "100".to_owned())
    );
    let february = run_at(&b, "2026-02-01T00:00:00Z", 200);
    assert_eq!((n(&february, "settled"), n(&february, "rejected")), (1, 0));
    assert_eq!(b.ledger.pot(&rent), "100");
    let ex = executions(&b, USER_A, &id);
    assert_eq!(ex.len(), 2);
    assert_eq!(
        (n(&ex[1], "occurrence"), text(&ex[1], "status")),
        (1, "settled".to_owned())
    );
}

#[test]
fn fires_every_occurrence_exactly_once_across_a_catch_up_run() {
    let Some(b) = bank() else { return };
    let (_, rent, id) = standing_order(&b, "10", "daily", "2026-01-01T00:00:00Z");
    b.ledger.fund(USER_A, "USDT", "1000");
    run_at(&b, "2026-01-06T00:00:00Z", 200);
    run_at(&b, "2026-01-06T00:00:00Z", 200);
    assert_eq!(occurrences(&b, USER_A, &id), [0, 1, 2, 3, 4, 5]);
    assert_eq!(b.ledger.pot(&rent), "60");
}

#[test]
fn bounds_a_catch_up_pass_so_an_old_schedule_does_not_fire_a_wall_of_transfers() {
    let Some(b) = bank() else { return };
    let (_, _, id) = standing_order(&b, "1", "daily", "2026-01-01T00:00:00Z");
    b.ledger.fund(USER_A, "USDT", "1000");
    run_bounded(&b, "2026-06-01T00:00:00Z", 200.0, 3);
    assert_eq!(executions(&b, USER_A, &id).len(), 3);
}

#[test]
fn re_drives_a_claim_that_was_left_pending_by_a_crashed_run_without_paying_twice() {
    let Some(b) = bank() else { return };
    let (_, rent, id) = standing_order(&b, "100", "monthly", "2026-01-01T09:00:00Z");
    b.ledger.fund(USER_A, "USDT", "1000");
    b.sql(&format!(
        "INSERT INTO bank.transfer_executions (schedule_id, occurrence, amount, status) VALUES ('{id}', 0, 100, 'pending')"
    ))
    .unwrap();
    run_at(&b, "2026-01-01T10:00:00Z", 200);
    run_at(&b, "2026-01-01T10:00:00Z", 200);
    assert_eq!(b.ledger.pot(&rent), "100");
    let ex = executions(&b, USER_A, &id);
    assert_eq!(ex.len(), 1);
    assert_eq!(text(&ex[0], "status"), "settled");
}

#[test]
fn stops_at_the_end_of_the_schedule_window() {
    let Some(b) = bank() else { return };
    let main = primary(&b, USER_A, "USDT");
    let rent = pot(&b, USER_A, "USDT", "Rent");
    b.ledger.fund(USER_A, "USDT", "1000");
    let mut o = order(&main, &rent, "10", "daily", "2026-01-01T00:00:00Z");
    o.ends = Some("2026-01-04T00:00:00Z");
    let id = text(&schedule(&b, USER_A, &o).ok(), "id");
    run_at(&b, "2026-02-01T00:00:00Z", 200);
    // Occurrences 0, 1 and 2 fall inside [starts, ends); occurrence 3 is at the boundary and must not fire.
    assert_eq!(occurrences(&b, USER_A, &id), [0, 1, 2]);
    assert_eq!(b.status(&id), "completed");
}

#[test]
fn does_not_fire_before_the_schedule_starts() {
    let Some(b) = bank() else { return };
    let (_, _, id) = standing_order(&b, "100", "monthly", "2026-06-01T00:00:00Z");
    b.ledger.fund(USER_A, "USDT", "1000");
    let report = run_at(&b, "2026-01-01T00:00:00Z", 200);
    assert_eq!(n(&report, "schedulesConsidered"), 0);
    assert!(executions(&b, USER_A, &id).is_empty());
}

#[test]
fn stops_firing_once_cancelled() {
    let Some(b) = bank() else { return };
    let (_, rent, id) = standing_order(&b, "10", "daily", "2026-01-01T00:00:00Z");
    b.ledger.fund(USER_A, "USDT", "1000");
    run_at(&b, "2026-01-01T01:00:00Z", 200);
    assert_eq!(
        cancel(&b, USER_A, &id).ok().compact(),
        r#"{"cancelled":true}"#
    );
    run_at(&b, "2026-01-10T01:00:00Z", 200);
    assert_eq!(b.ledger.pot(&rent), "10");
}

// ---------------------------------------------------------------------------------------------------------------
// `bank-service.test.ts`: a paused standing order does not fire, and resuming does not settle up

/// 10 a day from 1 Jan, occurrence 0 already fired, then paused.
fn paused_after_first_firing(b: &Bank) -> (String, String) {
    let main = primary(b, USER_A, "USDT");
    let rent = pot(b, USER_A, "USDT", "Rent");
    b.ledger.fund(USER_A, "USDT", "10000");
    let id = text(
        &schedule(
            b,
            USER_A,
            &order(&main, &rent, "10", "daily", "2026-01-01T00:00:00Z"),
        )
        .ok(),
        "id",
    );
    run_at(b, "2026-01-01T01:00:00Z", 200);
    assert_eq!(text(&pause(b, USER_A, &id).ok(), "status"), "paused");
    (rent, id)
}

fn pending(b: &Bank, id: &str, occurrence: i64) {
    b.sql(&format!(
        "INSERT INTO bank.transfer_executions (schedule_id, occurrence, amount, status) VALUES ('{id}', {occurrence}, 10, 'pending')"
    ))
    .unwrap();
}

#[test]
fn fires_nothing_at_all_while_paused_however_long_the_runner_keeps_looking() {
    let Some(b) = bank() else { return };
    let (rent, id) = paused_after_first_firing(&b);
    run_at(&b, "2026-01-10T01:00:00Z", 200);
    run_at(&b, "2026-03-01T01:00:00Z", 200);
    assert_eq!(b.ledger.pot(&rent), "10");
    assert_eq!(executions(&b, USER_A, &id).len(), 1);
}

#[test]
fn does_not_fire_the_occurrences_that_came_due_while_it_was_paused() {
    let Some(b) = bank() else { return };
    let (rent, id) = paused_after_first_firing(&b);
    resume_at(&b, USER_A, &id, "2026-01-10T00:00:00Z").ok();
    run_at(&b, "2026-01-10T00:00:00Z", 200);
    run_at(&b, "2026-01-10T23:00:00Z", 200);
    assert_eq!(b.ledger.pot(&rent), "10");
    // And it is resumed, not quietly dead: the next occurrence fires.
    run_at(&b, "2026-01-11T00:00:00Z", 200);
    assert_eq!(b.ledger.pot(&rent), "20");
}

#[test]
fn moves_no_value_itself_pausing_and_resuming_post_nothing_to_the_ledger() {
    let Some(b) = bank() else { return };
    let (_, id) = paused_after_first_firing(&b);
    let before = b.ledger.posts();
    resume_at(&b, USER_A, &id, "2026-02-01T00:00:00Z").ok();
    pause(&b, USER_A, &id).ok();
    resume_at(&b, USER_A, &id, "2026-03-01T00:00:00Z").ok();
    assert_eq!(b.ledger.posts(), before);
}

#[test]
fn records_every_skipped_occurrence_with_a_reason_not_as_an_absence() {
    let Some(b) = bank() else { return };
    let (_, id) = paused_after_first_firing(&b);
    let resumed = resume_at(&b, USER_A, &id, "2026-01-10T00:00:00Z");
    assert_eq!(skipped(&resumed), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    let ex = executions(&b, USER_A, &id);
    assert_eq!(ex.len(), 10);
    assert_eq!(text(&ex[0], "status"), "settled");
    for e in &ex[1..] {
        assert_eq!(text(e, "status"), "skipped");
        assert_eq!(text(e, "rejectionCode"), schedules::PAUSED_SKIP_REASON);
        assert_eq!(text(e, "ledgerTxId"), "null");
    }
}

#[test]
fn cannot_record_a_skipped_occurrence_that_claims_value_moved() {
    let Some(b) = bank() else { return };
    let (_, id) = paused_after_first_firing(&b);
    let insert = |values: &str, columns: &str| {
        b.sql(&format!(
            "INSERT INTO bank.transfer_executions (schedule_id, occurrence, amount, status{columns}) VALUES ('{id}', {values})"
        ))
    };
    assert!(
        insert(
            "41, 10, 'skipped', 'bank.schedule_paused', 'some-ledger-tx'",
            ", rejection_code, ledger_tx_id"
        )
        .is_err()
    );
    assert!(
        insert(
            "42, 10, 'skipped', 'bank.schedule_paused', now()",
            ", rejection_code, settled_at"
        )
        .is_err()
    );
    assert!(insert("43, 10, 'skipped'", "").is_err());
    insert(
        "44, 10, 'skipped', 'bank.schedule_paused'",
        ", rejection_code",
    )
    .unwrap();
}

#[test]
fn never_overwrites_an_occurrence_that_already_settled() {
    let Some(b) = bank() else { return };
    let (_, id) = paused_after_first_firing(&b);
    let settled = executions(&b, USER_A, &id)[0].clone();
    resume_at(&b, USER_A, &id, "2026-01-10T00:00:00Z").ok();
    let after = executions(&b, USER_A, &id)[0].clone();
    assert_eq!(after.compact(), settled.compact());
    assert_ne!(text(&after, "ledgerTxId"), "null");
}

#[test]
fn leaves_an_occurrence_claimed_before_the_pause_alive_for_the_stranded_sweep() {
    let Some(b) = bank() else { return };
    let (rent, id) = paused_after_first_firing(&b);
    pending(&b, &id, 1);
    let resumed = resume_at(&b, USER_A, &id, "2026-01-10T00:00:00Z");
    assert_eq!(skipped(&resumed), [2, 3, 4, 5, 6, 7, 8, 9]);
    let status_of_1 = |b: &Bank| {
        executions(b, USER_A, &id)
            .into_iter()
            .find(|e| n(e, "occurrence") == 1)
            .map(|e| text(&e, "status"))
            .unwrap()
    };
    assert_eq!(status_of_1(&b), "pending");
    run_at(&b, "2026-01-10T00:00:00Z", 200);
    assert_eq!(status_of_1(&b), "settled");
    assert_eq!(b.ledger.pot(&rent), "20");
}

#[test]
fn finishes_a_claim_stranded_before_the_pause_even_if_the_order_is_never_resumed() {
    let Some(b) = bank() else { return };
    let (rent, id) = paused_after_first_firing(&b);
    pending(&b, &id, 1);
    let report = run_at(&b, "2026-06-01T00:00:00Z", 200);
    assert_eq!((n(&report, "strandedSwept"), n(&report, "settled")), (1, 1));
    assert_eq!(b.status(&id), "paused");
    let ex = executions(&b, USER_A, &id);
    assert_eq!(ex.len(), 2);
    assert_eq!(text(&ex[1], "status"), "settled");
    assert_ne!(text(&ex[1], "ledgerTxId"), "null");
    assert_eq!(b.ledger.pot(&rent), "20");
}

#[test]
fn sweeps_idempotently_three_passes_over_one_stranded_claim_move_value_once() {
    let Some(b) = bank() else { return };
    let (rent, id) = paused_after_first_firing(&b);
    pending(&b, &id, 1);
    let first = run_at(&b, "2026-06-01T00:00:00Z", 200);
    let second = run_at(&b, "2026-06-01T00:00:00Z", 200);
    let third = run_at(&b, "2026-06-02T00:00:00Z", 200);
    assert_eq!(n(&first, "settled"), 1);
    assert_eq!((n(&second, "strandedSwept"), n(&second, "settled")), (0, 0));
    assert_eq!(n(&third, "settled"), 0);
    assert_eq!(b.ledger.pot(&rent), "20");
    assert_eq!(executions(&b, USER_A, &id).len(), 2);
}

#[test]
fn finishes_a_claim_stranded_on_a_cancelled_order() {
    let Some(b) = bank() else { return };
    let (rent, id) = paused_after_first_firing(&b);
    pending(&b, &id, 1);
    cancel(&b, USER_A, &id).ok();
    let report = run_at(&b, "2026-06-01T00:00:00Z", 200);
    assert_eq!(n(&report, "settled"), 1);
    assert_eq!(b.ledger.pot(&rent), "20");
    assert_eq!(b.status(&id), "cancelled");
    assert_eq!(executions(&b, USER_A, &id).len(), 2);
}

#[test]
fn does_not_consider_a_schedule_twice_when_it_is_both_due_and_stranded() {
    let Some(b) = bank() else { return };
    let main = primary(&b, USER_A, "USDT");
    let rent = pot(&b, USER_A, "USDT", "Rent");
    b.ledger.fund(USER_A, "USDT", "10000");
    let id = text(
        &schedule(
            &b,
            USER_A,
            &order(&main, &rent, "10", "daily", "2026-01-01T00:00:00Z"),
        )
        .ok(),
        "id",
    );
    pending(&b, &id, 0);
    let report = run_at(&b, "2026-01-02T00:00:00Z", 200);
    assert_eq!(n(&report, "schedulesConsidered"), 1);
    assert_eq!(n(&report, "strandedSwept"), 0);
    assert_eq!(n(&report, "settled"), 2);
    assert_eq!(b.ledger.pot(&rent), "20");
}

#[test]
fn is_safe_to_call_twice_at_once_one_resume_wins_and_the_record_is_written_once() {
    let Some(b) = bank() else { return };
    let (_, id) = paused_after_first_firing(&b);
    let wins = std::thread::scope(|s| {
        let racers: Vec<_> = (0..6)
            .map(|_| s.spawn(|| resume_at(&b, USER_A, &id, "2026-01-10T00:00:00Z").0 == 200))
            .collect();
        racers
            .into_iter()
            .filter_map(|r| r.join().ok())
            .filter(|won| *won)
            .count()
    });
    assert_eq!(wins, 1);
    assert_eq!(executions(&b, USER_A, &id).len(), 10);
    assert_eq!(b.status(&id), "active");
}

#[test]
fn refuses_a_second_resume_because_the_first_one_already_ran() {
    let Some(b) = bank() else { return };
    let (_, id) = paused_after_first_firing(&b);
    resume_at(&b, USER_A, &id, "2026-01-10T00:00:00Z").ok();
    let again = resume_at(&b, USER_A, &id, "2026-01-10T00:00:00Z");
    assert_eq!(again.code(), "bank.schedule_inactive");
}

#[test]
fn refuses_to_pause_an_order_that_is_not_running() {
    let Some(b) = bank() else { return };
    let (_, id) = paused_after_first_firing(&b);
    assert_eq!(pause(&b, USER_A, &id).code(), "bank.schedule_inactive");
    cancel(&b, USER_A, &id).ok();
    assert_eq!(pause(&b, USER_A, &id).code(), "bank.schedule_inactive");
}

#[test]
fn distinguishes_a_schedule_that_is_not_paused_from_one_that_does_not_exist() {
    let Some(b) = bank() else { return };
    let missing = resume_at(
        &b,
        USER_A,
        "00000000-0000-4000-8000-000000000000",
        "2026-01-10T00:00:00Z",
    );
    assert_eq!(missing.code(), "bank.schedule_not_found");
}

#[test]
fn can_be_given_up_on_while_paused() {
    let Some(b) = bank() else { return };
    let (rent, id) = paused_after_first_firing(&b);
    cancel(&b, USER_A, &id).ok();
    assert_eq!(b.status(&id), "cancelled");
    run_at(&b, "2026-03-01T00:00:00Z", 200);
    assert_eq!(b.ledger.pot(&rent), "10");
}

#[test]
fn completes_rather_than_reactivates_when_the_schedule_window_has_already_closed() {
    let Some(b) = bank() else { return };
    let main = primary(&b, USER_A, "USDT");
    let rent = pot(&b, USER_A, "USDT", "Rent");
    b.ledger.fund(USER_A, "USDT", "10000");
    let mut o = order(&main, &rent, "10", "daily", "2026-01-01T00:00:00Z");
    o.ends = Some("2026-01-04T00:00:00Z");
    let id = text(&schedule(&b, USER_A, &o).ok(), "id");
    run_at(&b, "2026-01-01T01:00:00Z", 200);
    pause(&b, USER_A, &id).ok();
    let resumed = resume_at(&b, USER_A, &id, "2026-06-01T00:00:00Z");
    assert_eq!(skipped(&resumed), [1, 2]);
    assert_eq!(text(&resumed.ok(), "status"), "completed");
    run_at(&b, "2026-06-01T00:00:00Z", 200);
    assert_eq!(b.ledger.pot(&rent), "10");
}

#[test]
fn reports_nothing_skipped_when_the_pause_was_shorter_than_one_period() {
    let Some(b) = bank() else { return };
    let (_, id) = paused_after_first_firing(&b);
    let resumed = resume_at(&b, USER_A, &id, "2026-01-01T12:00:00Z");
    assert!(skipped(&resumed).is_empty());
    assert_eq!(text(&resumed.ok(), "status"), "active");
    assert_eq!(executions(&b, USER_A, &id).len(), 1);
}

#[test]
fn can_be_paused_before_it_has_ever_fired_and_starts_cleanly_from_the_next_occurrence() {
    let Some(b) = bank() else { return };
    let main = primary(&b, USER_A, "USDT");
    let rent = pot(&b, USER_A, "USDT", "Rent");
    b.ledger.fund(USER_A, "USDT", "10000");
    let id = text(
        &schedule(
            &b,
            USER_A,
            &order(&main, &rent, "10", "daily", "2026-06-01T00:00:00Z"),
        )
        .ok(),
        "id",
    );
    pause(&b, USER_A, &id).ok();
    let resumed = resume_at(&b, USER_A, &id, "2026-01-01T00:00:00Z");
    assert!(skipped(&resumed).is_empty());
    assert_eq!(text(&resumed.ok(), "nextRunAt"), "2026-06-01T00:00:00.000Z");
    assert_eq!(b.ledger.pot(&rent), "0");
}

// ---------------------------------------------------------------------------------------------------------------
// `bank-service.test.ts`: the ownership refusals

/// A standing order owned by `user`, with one occurrence already fired.
fn fired_standing_order(b: &Bank, user: &str) -> String {
    let main = primary(b, user, "USDT");
    let rent = pot(b, user, "USDT", "Rent");
    b.ledger.fund(user, "USDT", "1000");
    let id = text(
        &schedule(
            b,
            user,
            &order(&main, &rent, "100", "monthly", "2026-01-01T09:00:00Z"),
        )
        .ok(),
        "id",
    );
    run_at(b, "2026-01-01T10:00:00Z", 200);
    id
}

#[test]
fn refuses_user_b_the_firing_history_of_user_as_standing_order() {
    let Some(b) = bank() else { return };
    let id = fired_standing_order(&b, USER_A);
    let read = call(
        &b,
        USER_B,
        "transfers.executions",
        &format!(r#"{{"scheduleId":"{id}","limit":50}}"#),
    );
    assert_eq!(read.trpc(), "FORBIDDEN");
}

#[test]
fn still_serves_the_history_to_the_user_who_owns_the_schedule() {
    let Some(b) = bank() else { return };
    let id = fired_standing_order(&b, USER_A);
    let ex = executions(&b, USER_A, &id);
    assert_eq!(ex.len(), 1);
    assert_eq!(
        (
            n(&ex[0], "occurrence"),
            text(&ex[0], "status"),
            text(&ex[0], "amount")
        ),
        (0, "settled".to_owned(), "100".to_owned())
    );
}

#[test]
fn refuses_user_b_and_leaves_user_as_standing_order_active() {
    let Some(b) = bank() else { return };
    let id = fired_standing_order(&b, USER_A);
    assert_eq!(cancel(&b, USER_B, &id).trpc(), "FORBIDDEN");
    assert_eq!(b.status(&id), "active");
    assert_eq!(pause(&b, USER_B, &id).trpc(), "FORBIDDEN");
    assert_eq!(b.status(&id), "active");
}

#[test]
fn still_lets_the_user_who_owns_the_schedule_cancel_it() {
    let Some(b) = bank() else { return };
    let id = fired_standing_order(&b, USER_A);
    assert_eq!(
        cancel(&b, USER_A, &id).ok().compact(),
        r#"{"cancelled":true}"#
    );
    assert_eq!(b.status(&id), "cancelled");
}

#[test]
fn refuses_user_b_a_resume_and_writes_no_skip_rows_on_the_way_to_refusing() {
    let Some(b) = bank() else { return };
    let id = fired_standing_order(&b, USER_A);
    pause(&b, USER_A, &id).ok();
    let before = executions(&b, USER_A, &id);
    assert_eq!(
        resume_at(&b, USER_B, &id, "2026-06-01T00:00:00Z").trpc(),
        "FORBIDDEN"
    );
    assert_eq!(b.status(&id), "paused");
    assert_eq!(
        Json::Array(executions(&b, USER_A, &id)).compact(),
        Json::Array(before).compact()
    );
}

#[test]
fn lets_the_owner_pause_and_resume_and_tells_them_what_will_never_be_made_up() {
    let Some(b) = bank() else { return };
    let id = fired_standing_order(&b, USER_A);
    assert_eq!(text(&pause(&b, USER_A, &id).ok(), "status"), "paused");
    let resumed = resume_at(&b, USER_A, &id, "2026-04-15T00:00:00Z");
    assert_eq!(text(&resumed.ok(), "status"), "active");
    assert_eq!(skipped(&resumed), [1, 2, 3]);
}

// ---------------------------------------------------------------------------------------------------------------
// `bank-service.test.ts`: a failed transfer into a stranger's space describes nothing

#[test]
fn answers_an_archived_space_of_another_user_exactly_as_it_answers_a_uuid_that_does_not_exist() {
    let Some(b) = bank() else { return };
    let mine = primary(&b, USER_B, "USDT");
    b.ledger.fund(USER_B, "USDT", "10");
    let theirs = pot(&b, USER_A, "USDT", "Holiday fund");
    archive(&b, USER_A, &theirs);
    let not_yours = transfer(
        &b,
        USER_B,
        "probe-0001",
        &mine,
        &theirs,
        "0.000000000000000001",
    );
    let absent = transfer(
        &b,
        USER_B,
        "probe-0002",
        &mine,
        "5f2b7c1e-0000-4000-8000-000000000000",
        "0.000000000000000001",
    );
    assert_eq!(not_yours.wire_shape(), absent.wire_shape());
    assert_eq!(not_yours.trpc(), "NOT_FOUND");
    assert_eq!(not_yours.message(), "No such space");
    assert!(!not_yours.1.compact().contains(&theirs));
}

#[test]
fn answers_a_foreign_asset_space_of_another_user_the_same_way_the_asset_does_not_leak_either() {
    let Some(b) = bank() else { return };
    let mine = primary(&b, USER_B, "USDT");
    b.ledger.fund(USER_B, "USDT", "10");
    let theirs = pot(&b, USER_A, "EUR", "Holiday fund");
    let not_yours = transfer(&b, USER_B, "probe-0003", &mine, &theirs, "1");
    let absent = transfer(
        &b,
        USER_B,
        "probe-0004",
        &mine,
        "5f2b7c1e-0000-4000-8000-000000000001",
        "1",
    );
    assert_eq!(not_yours.wire_shape(), absent.wire_shape());
    assert!(!not_yours.message().contains("EUR"));
    assert!(!not_yours.message().contains("Holiday fund"));
}

#[test]
fn still_gives_the_owner_the_full_actionable_message_including_the_name() {
    let Some(b) = bank() else { return };
    let main = primary(&b, USER_A, "USDT");
    b.ledger.fund(USER_A, "USDT", "100");
    let mine = pot(&b, USER_A, "USDT", "Holiday fund");
    archive(&b, USER_A, &mine);
    let err = transfer(&b, USER_A, "owner-0001", &main, &mine, "1");
    assert_eq!(err.message(), "Space \"Holiday fund\" is archived");
    assert_eq!(err.trpc(), "CONFLICT");
    let eur = pot(&b, USER_A, "EUR", "Trip");
    let mismatch = transfer(&b, USER_A, "owner-0002", &main, &eur, "1");
    assert_eq!(
        mismatch.message(),
        "Cannot transfer USDT into a EUR space — convert first"
    );
}

#[test]
fn still_lets_a_transfer_to_another_user_succeed_this_is_product_not_a_leak() {
    let Some(b) = bank() else { return };
    let mine = primary(&b, USER_B, "USDT");
    let theirs = primary(&b, USER_A, "USDT");
    b.ledger.fund(USER_B, "USDT", "80");
    let sent = transfer(&b, USER_B, "peer-0001", &mine, &theirs, "80").ok();
    assert_eq!(text(&sent, "amount"), "80");
    assert_eq!(b.ledger.available(USER_A), "80");
    assert_eq!(b.ledger.available(USER_B), "0");
}

#[test]
fn reports_the_callers_own_empty_balance_honestly_even_paying_a_stranger() {
    let Some(b) = bank() else { return };
    let mine = primary(&b, USER_B, "USDT");
    let theirs = primary(&b, USER_A, "USDT");
    b.ledger.fund(USER_B, "USDT", "1");
    let err = transfer(&b, USER_B, "broke-0001", &mine, &theirs, "500");
    assert_eq!(err.trpc(), "BAD_REQUEST");
    assert!(
        err.message().contains("Insufficient USDT"),
        "{}",
        err.message()
    );
}

#[test]
fn closes_the_same_oracle_on_the_standing_order_surface() {
    let Some(b) = bank() else { return };
    let mine = primary(&b, USER_B, "USDT");
    let theirs = pot(&b, USER_A, "EUR", "Holiday fund");
    let not_yours = schedule(
        &b,
        USER_B,
        &order(&mine, &theirs, "10", "monthly", "2026-01-01T09:00:00Z"),
    );
    let absent = schedule(
        &b,
        USER_B,
        &order(
            &mine,
            "5f2b7c1e-0000-4000-8000-000000000003",
            "10",
            "monthly",
            "2026-01-01T09:00:00Z",
        ),
    );
    assert_eq!(not_yours.wire_shape(), absent.wire_shape());
    assert_eq!(not_yours.trpc(), "NOT_FOUND");
    assert_eq!(
        b.count(&format!(
            "SELECT count(*) FROM bank.scheduled_transfers WHERE from_space_id = '{mine}'"
        )),
        0
    );
}

// ---------------------------------------------------------------------------------------------------------------
// `schedule-edit.db.test.ts`

const NOW: &str = "2026-11-02T09:00:00.000Z";
const TOMORROW: &str = "2026-11-03T09:00:00.000Z";

fn tomorrow_plus(ms: i64) -> String {
    Instant(at(TOMORROW) + ms).iso()
}

#[test]
fn posts_nothing_today_posts_once_on_its_date_ends_and_a_second_pass_posts_nothing() {
    let Some(b) = bank() else { return };
    set_now(at(NOW));
    let main = primary(&b, USER_A, "USDT");
    let rent = pot(&b, USER_A, "USDT", "Rent");
    b.ledger.fund(USER_A, "USDT", "100");
    let id = text(
        &schedule(&b, USER_A, &order(&main, &rent, "25", "once", TOMORROW)).ok(),
        "id",
    );
    let row = listed(&b, USER_A, &id);
    assert_eq!(
        (
            text(&row, "cadence"),
            text(&row, "status"),
            text(&row, "nextRunAt"),
            n(&row, "revision")
        ),
        (
            "once".to_owned(),
            "active".to_owned(),
            TOMORROW.to_owned(),
            1
        )
    );
    assert_eq!(n(&run_at(&b, NOW, 10), "settled"), 0);
    assert_eq!(b.ledger.pot(&rent), "0");
    assert_eq!(n(&run_at(&b, &tomorrow_plus(60_000), 10), "settled"), 1);
    assert_eq!(b.ledger.pot(&rent), "25");
    assert_eq!(b.ledger.available(USER_A), "75");
    assert_eq!(b.status(&id), "completed");
    let posts = b.ledger.posts();
    let later = run_at(&b, &tomorrow_plus(40 * DAY), 10);
    assert_eq!(
        (n(&later, "settled"), n(&later, "schedulesConsidered")),
        (0, 0)
    );
    assert_eq!(b.ledger.posts(), posts);
    let ex = executions(&b, USER_A, &id);
    assert_eq!(ex.len(), 1);
    assert_eq!(
        (
            n(&ex[0], "occurrence"),
            text(&ex[0], "amount"),
            text(&ex[0], "status"),
            text(&ex[0], "rejectionCode")
        ),
        (0, "25".to_owned(), "settled".to_owned(), "null".to_owned())
    );
}

#[test]
fn has_a_date_and_no_end_date_an_end_is_refused_by_the_service_and_by_the_table() {
    let Some(b) = bank() else { return };
    let main = primary(&b, USER_A, "USDT");
    let rent = pot(&b, USER_A, "USDT", "Rent");
    let ends = tomorrow_plus(DAY);
    let mut o = order(&main, &rent, "5", "once", TOMORROW);
    o.ends = Some(&ends);
    assert_eq!(schedule(&b, USER_A, &o).code(), "bank.validation_failed");
    let refused = b.sql(&format!(
        "INSERT INTO bank.scheduled_transfers (id, user_id, asset_id, from_space_id, to_space_id, amount, cadence, starts_at, ends_at, next_run_at) \
         VALUES ('{}', '{USER_A}', 'USDT', '{main}', '{rent}', 5, 'once', '{TOMORROW}', '{ends}', '{TOMORROW}')",
        uuid()
    ));
    assert_eq!(
        refused,
        Err("scheduled_transfers_once_no_end_ck".to_owned())
    );
}

/// A monthly order of 10 from tomorrow.
fn monthly(b: &Bank) -> (String, String, String) {
    let main = primary(b, USER_A, "USDT");
    let rent = pot(b, USER_A, "USDT", "Rent");
    let id = text(
        &schedule(b, USER_A, &order(&main, &rent, "10", "monthly", TOMORROW)).ok(),
        "id",
    );
    (main, rent, id)
}

fn revisions(b: &Bank, id: &str) -> Vec<(i64, String, Option<i64>)> {
    b.db
        .client()
        .query(
            "SELECT revision, amount::text, floor(extract(epoch from ends_at) * 1000)::int8 FROM bank.schedule_revisions \
             WHERE schedule_id = $1::text::uuid ORDER BY revision DESC",
            &[&id],
        )
        .unwrap()
        .iter()
        .map(|r| {
            (
                i64::from(r.get::<_, i32>(0)),
                format_amount(amt(&r.get::<_, String>(1))),
                r.get(2),
            )
        })
        .collect()
}

#[test]
fn lands_once_per_revision_keeps_what_it_replaced_and_the_next_run_posts_the_new_amount() {
    let Some(b) = bank() else { return };
    set_now(at(NOW));
    let (_, rent, id) = monthly(&b);
    b.ledger.fund(USER_A, "USDT", "100");
    let edited = update(&b, USER_A, &id, 1, "15", None).ok();
    assert_eq!(
        (n(&edited, "revision"), text(&edited, "amount")),
        (2, "15".to_owned())
    );
    // A second, different edit sent at the same revision changes nothing.
    let stale = update(&b, USER_A, &id, 1, "99", None);
    assert_eq!(stale.code(), "bank.schedule_revision_conflict");
    assert_eq!(stale.0, 409);
    assert!(stale.message().contains("revision 2"));
    let row = listed(&b, USER_A, &id);
    assert_eq!(
        (n(&row, "revision"), text(&row, "amount")),
        (2, "15".to_owned())
    );
    // The same edit sent again (a retry of the one that landed) is answered with the revision it made.
    assert_eq!(
        n(&update(&b, USER_A, &id, 1, "15", None).ok(), "revision"),
        2
    );
    assert_eq!(revisions(&b, &id), [(1, "10".to_owned(), None)]);
    run_at(&b, &tomorrow_plus(60_000), 10);
    assert_eq!(b.ledger.pot(&rent), "15");
    let ex = executions(&b, USER_A, &id);
    assert_eq!(
        (
            n(&ex[0], "occurrence"),
            text(&ex[0], "amount"),
            text(&ex[0], "status")
        ),
        (0, "15".to_owned(), "settled".to_owned())
    );
}

#[test]
fn an_end_date_closes_the_window_the_order_completes_after_its_last_run() {
    let Some(b) = bank() else { return };
    set_now(at(NOW));
    let (_, rent, id) = monthly(&b);
    b.ledger.fund(USER_A, "USDT", "100");
    let end = tomorrow_plus(10 * DAY);
    let edited = update(&b, USER_A, &id, 1, "10", Some(&end)).ok();
    assert_eq!((n(&edited, "revision"), text(&edited, "endsAt")), (2, end));
    run_at(&b, &tomorrow_plus(60 * DAY), 10);
    assert_eq!(b.ledger.pot(&rent), "10");
    assert_eq!(b.status(&id), "completed");
}

#[test]
fn an_end_at_or_before_the_next_run_completes_the_order_at_the_edit() {
    let Some(b) = bank() else { return };
    set_now(at(NOW));
    let (_, rent, id) = monthly(&b);
    b.ledger.fund(USER_A, "USDT", "100");
    run_at(&b, &tomorrow_plus(60_000), 10);
    assert_eq!(b.ledger.pot(&rent), "10");
    set_now(at(TOMORROW) + 2 * DAY);
    update(&b, USER_A, &id, 1, "10", Some(&tomorrow_plus(10 * DAY))).ok();
    assert_eq!(b.status(&id), "completed");
    assert_eq!(
        n(
            &run_at(&b, &tomorrow_plus(90 * DAY), 10),
            "schedulesConsidered"
        ),
        0
    );
    assert_eq!(b.ledger.pot(&rent), "10");
}

#[test]
fn a_paused_order_has_no_run_coming_so_the_cutoff_does_not_stop_its_edit() {
    let Some(b) = bank() else { return };
    set_now(at(NOW));
    let (_, _, id) = monthly(&b);
    pause(&b, USER_A, &id).ok();
    set_now(at(TOMORROW) - 59 * 60_000);
    let edited = update(&b, USER_A, &id, 1, "11", None).ok();
    assert_eq!(
        (n(&edited, "revision"), text(&edited, "amount")),
        (2, "11".to_owned())
    );
    assert_eq!(b.status(&id), "paused");
}

#[test]
fn a_retry_of_the_create_after_an_edit_is_the_same_order_compared_on_the_terms_it_was_created_with()
{
    let Some(b) = bank() else { return };
    set_now(at(NOW));
    let main = primary(&b, USER_A, "USDT");
    let rent = pot(&b, USER_A, "USDT", "Rent");
    let o = order(&main, &rent, "10", "monthly", TOMORROW);
    schedule(&b, USER_A, &o).ok();
    update(&b, USER_A, &o.id, 1, "15", None).ok();
    assert_eq!(text(&schedule(&b, USER_A, &o).ok(), "id"), o.id);
    let row = listed(&b, USER_A, &o.id);
    assert_eq!(
        (n(&row, "revision"), text(&row, "amount")),
        (2, "15".to_owned())
    );
    let changed = Order {
        amount: "15",
        ..order(&main, &rent, "15", "monthly", TOMORROW)
    };
    let changed = Order {
        id: o.id.clone(),
        ..changed
    };
    assert_eq!(
        schedule(&b, USER_A, &changed).code(),
        "bank.schedule_conflict"
    );
}

#[test]
fn refuses_while_the_cutoff_is_unpublished_inside_the_cutoff_when_finished_and_for_another_person()
{
    let Some(b) = bank() else { return };
    set_now(at(NOW));
    let (_, _, id) = monthly(&b);
    let with_cutoff = |cutoff: Option<&'static str>| {
        b.reopened(Owner {
            cutoff,
            ..Owner::default()
        })
    };
    let edit = |door: &BankDoor, user: &str| {
        call_on(
            door,
            user,
            "transfers.updateSchedule",
            &format!(r#"{{"scheduleId":"{id}","revision":1,"amount":"12","endsAt":null}}"#),
        )
    };
    for cutoff in [None, Some(" "), Some("sixty")] {
        assert_eq!(
            edit(&with_cutoff(cutoff), USER_A).code(),
            "bank.schedule_edit_cutoff_unset"
        );
    }
    // 59 minutes before the run, with a 60-minute cutoff.
    set_now(at(TOMORROW) - 59 * 60_000);
    assert_eq!(edit(&b.door, USER_A).code(), "bank.schedule_cutoff");
    set_now(at(NOW));
    assert_eq!(edit(&b.door, USER_B).trpc(), "FORBIDDEN");
    let past = Instant(at(NOW) - DAY).iso();
    assert_eq!(
        update(&b, USER_A, &id, 1, "12", Some(&past)).code(),
        "bank.validation_failed"
    );
    assert!(revisions(&b, &id).is_empty());
    cancel(&b, USER_A, &id).ok();
    assert_eq!(edit(&b.door, USER_A).code(), "bank.schedule_inactive");
    let row = listed(&b, USER_A, &id);
    assert_eq!(
        (n(&row, "revision"), text(&row, "amount")),
        (1, "10".to_owned())
    );
}

#[test]
fn is_recorded_as_failed_with_insufficient_funds_posts_nothing_is_not_made_up_and_the_next_run_happens()
 {
    let Some(b) = bank() else { return };
    set_now(at(NOW));
    let main = primary(&b, USER_A, "USDT");
    let rent = pot(&b, USER_A, "USDT", "Rent");
    b.ledger.fund(USER_A, "USDT", "4");
    let id = text(
        &schedule(&b, USER_A, &order(&main, &rent, "10", "weekly", TOMORROW)).ok(),
        "id",
    );
    let posts = b.ledger.posts();
    let first = run_at(&b, &tomorrow_plus(60_000), 10);
    assert_eq!((n(&first, "rejected"), n(&first, "settled")), (1, 0));
    assert_eq!(b.ledger.posts(), posts);
    assert_eq!(b.ledger.available(USER_A), "4");
    b.ledger.fund(USER_A, "USDT", "20");
    assert_eq!(
        n(&run_at(&b, &tomorrow_plus(7 * DAY + 60_000), 10), "settled"),
        1
    );
    assert_eq!(b.ledger.pot(&rent), "10");
    let ex = executions(&b, USER_A, &id);
    assert_eq!(ex.len(), 2);
    assert_eq!(
        (
            text(&ex[0], "status"),
            text(&ex[0], "ledgerTxId"),
            text(&ex[0], "rejectionCode")
        ),
        (
            "rejected".to_owned(),
            "null".to_owned(),
            "ledger.insufficient_funds".to_owned()
        )
    );
    assert_eq!(
        (n(&ex[1], "occurrence"), text(&ex[1], "status")),
        (1, "settled".to_owned())
    );
}

#[test]
fn lists_the_revision_edits_at_it_refuses_the_same_revision_twice_and_refuses_another_person() {
    let Some(b) = bank() else { return };
    set_now(at(NOW));
    let main = primary(&b, USER_A, "USDT");
    let rent = pot(&b, USER_A, "USDT", "Rent");
    let starts = Instant(at(NOW) + 30 * DAY).iso();
    let id = text(
        &schedule(&b, USER_A, &order(&main, &rent, "10", "monthly", &starts)).ok(),
        "id",
    );
    let first =
        arr(&call(&b, USER_A, "transfers.listSchedules", r#"{"limit":10}"#).ok())[0].clone();
    assert_eq!(
        (
            text(&first, "id"),
            n(&first, "revision"),
            text(&first, "endsAt"),
            text(&first, "cadence")
        ),
        (id.clone(), 1, "null".to_owned(), "monthly".to_owned())
    );
    let made = update(&b, USER_A, &id, 1, "12.5", None).ok();
    assert_eq!(
        (
            n(&made, "revision"),
            text(&made, "amount"),
            text(&made, "endsAt")
        ),
        (2, "12.5".to_owned(), "null".to_owned())
    );
    let second = update(&b, USER_A, &id, 1, "13", None);
    assert_eq!(second.0, 409);
    assert!(second.message().contains("revision 2"));
    assert_eq!(update(&b, USER_B, &id, 2, "1", None).0, 403);
    // endsAt is required, so leaving it out never clears an end by accident.
    let missing = call(
        &b,
        USER_A,
        "transfers.updateSchedule",
        &format!(r#"{{"scheduleId":"{id}","revision":2,"amount":"1"}}"#),
    );
    assert_eq!(missing.0, 400);
    let row = listed(&b, USER_A, &id);
    assert_eq!(
        (n(&row, "revision"), text(&row, "amount")),
        (2, "12.5".to_owned())
    );
}

// ---------------------------------------------------------------------------------------------------------------
// `schedule-retry-id.test.ts`

#[test]
fn http_without_schedule_id_is_400() {
    let Some(b) = bank() else { return };
    let main = primary(&b, USER_A, "USDT");
    let rent = pot(&b, USER_A, "USDT", "Rent");
    let res = call(
        &b,
        USER_A,
        "transfers.schedule",
        &format!(
            r#"{{"fromSpaceId":"{main}","toSpaceId":"{rent}","amount":"100","cadence":"monthly","startsAt":"2026-01-01T09:00:00.000Z"}}"#
        ),
    );
    assert_eq!(res.0, 400);
    assert_eq!(b.count("SELECT count(*) FROM bank.scheduled_transfers"), 0);
}

#[test]
fn two_schedule_calls_with_the_same_schedule_id_one_row() {
    let Some(b) = bank() else { return };
    let main = primary(&b, USER_A, "USDT");
    let rent = pot(&b, USER_A, "USDT", "Rent");
    let o = order(&main, &rent, "100", "monthly", "2026-01-01T09:00:00.000Z");
    let first = schedule(&b, USER_A, &o).ok();
    let retry = schedule(&b, USER_A, &o).ok();
    assert_eq!(text(&first, "id"), o.id);
    assert_eq!(text(&retry, "id"), o.id);
    assert_eq!(b.count("SELECT count(*) FROM bank.scheduled_transfers"), 1);
}

#[test]
fn same_schedule_id_with_different_amount_refuses_bank_schedule_conflict() {
    let Some(b) = bank() else { return };
    let main = primary(&b, USER_A, "USDT");
    let rent = pot(&b, USER_A, "USDT", "Rent");
    let o = order(&main, &rent, "100", "monthly", "2026-01-01T09:00:00.000Z");
    schedule(&b, USER_A, &o).ok();
    let more = Order {
        amount: "200",
        id: o.id.clone(),
        ..order(&main, &rent, "200", "monthly", "2026-01-01T09:00:00.000Z")
    };
    assert_eq!(schedule(&b, USER_A, &more).code(), "bank.schedule_conflict");
}

#[test]
fn same_schedule_id_with_the_same_window_returns_the_stored_schedule_and_posts_nothing() {
    let Some(b) = bank() else { return };
    let main = primary(&b, USER_A, "USDT");
    let rent = pot(&b, USER_A, "USDT", "Rent");
    b.ledger.fund(USER_A, "USDT", "50");
    let mut o = order(&main, &rent, "10", "monthly", "2026-01-01T09:00:00.000Z");
    o.ends = Some("2026-06-01T09:00:00.000Z");
    let first = schedule(&b, USER_A, &o).ok();
    let posts = b.ledger.posts();
    // The same instants written another way.
    let mut again = Order {
        id: o.id.clone(),
        ..order(&main, &rent, "10", "monthly", "2026-01-01T09:00:00Z")
    };
    again.ends = Some("2026-06-01T09:00:00Z");
    let retry = schedule(&b, USER_A, &again).ok();
    assert_eq!(text(&retry, "id"), text(&first, "id"));
    let row = listed(&b, USER_A, &o.id);
    assert_eq!(
        (text(&row, "startsAt"), text(&row, "endsAt")),
        (
            "2026-01-01T09:00:00.000Z".to_owned(),
            "2026-06-01T09:00:00.000Z".to_owned()
        )
    );
    assert_eq!(b.ledger.posts(), posts);
    assert_eq!(b.ledger.available(USER_A), "50");
    assert_eq!(b.count("SELECT count(*) FROM bank.scheduled_transfers"), 1);
    assert_eq!(b.count("SELECT count(*) FROM bank.transfer_executions"), 0);
}

#[test]
fn refuses_a_same_id_retry_that_changes_starts_at_and_keeps_the_stored_window_firing() {
    let Some(b) = bank() else { return };
    let main = primary(&b, USER_A, "USDT");
    let rent = pot(&b, USER_A, "USDT", "Rent");
    let o = order(&main, &rent, "10", "daily", "2026-01-01T00:00:00.000Z");
    schedule(&b, USER_A, &o).ok();
    b.ledger.fund(USER_A, "USDT", "100");
    let moved = Order {
        id: o.id.clone(),
        ..order(&main, &rent, "10", "daily", "2026-02-01T00:00:00.000Z")
    };
    assert_eq!(
        schedule(&b, USER_A, &moved).code(),
        "bank.schedule_conflict"
    );
    assert_eq!(b.ledger.posts(), 0);
    let row = listed(&b, USER_A, &o.id);
    assert_eq!(
        (text(&row, "startsAt"), text(&row, "endsAt")),
        ("2026-01-01T00:00:00.000Z".to_owned(), "null".to_owned())
    );
    assert_eq!(
        n(&run_at(&b, "2026-01-01T10:00:00.000Z", 200), "settled"),
        1
    );
    assert_eq!(b.ledger.pot(&rent), "10");
    assert_eq!(b.ledger.available(USER_A), "90");
}

#[test]
fn refuses_a_same_id_retry_that_changes_ends_at_and_keeps_firing_past_that_end() {
    let Some(b) = bank() else { return };
    let main = primary(&b, USER_A, "USDT");
    let rent = pot(&b, USER_A, "USDT", "Rent");
    let o = order(&main, &rent, "10", "daily", "2026-01-01T00:00:00.000Z");
    schedule(&b, USER_A, &o).ok();
    b.ledger.fund(USER_A, "USDT", "100");
    let mut ended = Order {
        id: o.id.clone(),
        ..order(&main, &rent, "10", "daily", "2026-01-01T00:00:00.000Z")
    };
    ended.ends = Some("2026-01-02T00:00:00.000Z");
    assert_eq!(
        schedule(&b, USER_A, &ended).code(),
        "bank.schedule_conflict"
    );
    run_at(&b, "2026-01-03T10:00:00.000Z", 200);
    assert_eq!(occurrences(&b, USER_A, &o.id), [0, 1, 2]);
    assert_eq!(b.ledger.pot(&rent), "30");
}

#[test]
fn two_caller_schedule_ids_still_create_two_rows() {
    let Some(b) = bank() else { return };
    let main = primary(&b, USER_A, "USDT");
    let rent = pot(&b, USER_A, "USDT", "Rent");
    let one = order(&main, &rent, "10", "monthly", "2026-01-01T09:00:00.000Z");
    let two = order(&main, &rent, "10", "monthly", "2026-01-01T09:00:00.000Z");
    assert_ne!(
        text(&schedule(&b, USER_A, &one).ok(), "id"),
        text(&schedule(&b, USER_A, &two).ok(), "id")
    );
    assert_eq!(b.count("SELECT count(*) FROM bank.scheduled_transfers"), 2);
}

// ---------------------------------------------------------------------------------------------------------------
// `rejected-omits-ledger-tx.db.test.ts`

/// Two named spaces and an order between them, written straight to the tables.
fn seed_schedule(b: &Bank) -> String {
    let mut c = b.db.client();
    let spaces = c
        .query(
            "INSERT INTO bank.spaces (user_id, asset_id, kind, name) VALUES ($1, 'USDT', 'named', $2), ($1, 'USDT', 'named', $3) RETURNING id::text",
            &[&USER_A, &format!("From {}", uuid()), &format!("To {}", uuid())],
        )
        .unwrap();
    let (from, to): (String, String) = (spaces[0].get(0), spaces[1].get(0));
    c.query_one(
        "INSERT INTO bank.scheduled_transfers (user_id, asset_id, from_space_id, to_space_id, amount, cadence, starts_at, next_run_at) \
         VALUES ($1, 'USDT', $2::text::uuid, $3::text::uuid, '1'::numeric, 'monthly', now(), now()) RETURNING id::text",
        &[&USER_A, &from, &to],
    )
    .unwrap()
    .get(0)
}

const OMITTED_LEDGER_TX: &str = "transfer_executions_rejected_omits_ledger_tx_ck";
const REJECTED_HAS_CODE: &str = "transfer_executions_rejected_has_code_ck";
const SETTLED_HAS_TX: &str = "transfer_executions_settled_has_tx_ck";

fn firing(b: &Bank, id: &str, occurrence: i64, columns: &str, values: &str) -> Result<u64, String> {
    b.sql(&format!(
        "INSERT INTO bank.transfer_executions (schedule_id, occurrence, amount, status{columns}) \
         SELECT id, {occurrence}, amount, {values} FROM bank.scheduled_transfers WHERE id = '{id}'"
    ))
}

#[test]
fn refuses_a_rejected_firing_that_points_at_a_ledger_posting() {
    let Some(b) = bank() else { return };
    let id = seed_schedule(&b);
    assert_eq!(
        firing(
            &b,
            &id,
            0,
            ", rejection_code, ledger_tx_id",
            "'rejected', 'ledger.insufficient_funds', id::text"
        ),
        Err(OMITTED_LEDGER_TX.to_owned())
    );
}

#[test]
fn stores_a_rejected_firing_that_has_a_code_and_a_null_ledger_tx() {
    let Some(b) = bank() else { return };
    let id = seed_schedule(&b);
    assert_eq!(
        firing(
            &b,
            &id,
            0,
            ", rejection_code",
            "'rejected', 'ledger.insufficient_funds'"
        ),
        Ok(1)
    );
    assert_eq!(
        b.count(&format!(
            "SELECT count(*) FROM bank.transfer_executions WHERE schedule_id = '{id}' AND ledger_tx_id IS NULL AND amount = '1'::numeric"
        )),
        1
    );
}

#[test]
fn still_refuses_a_rejected_firing_with_no_rejection_code() {
    let Some(b) = bank() else { return };
    let id = seed_schedule(&b);
    assert_eq!(
        firing(&b, &id, 0, "", "'rejected'"),
        Err(REJECTED_HAS_CODE.to_owned())
    );
}

#[test]
fn still_refuses_a_settled_firing_with_no_ledger_id() {
    let Some(b) = bank() else { return };
    let id = seed_schedule(&b);
    assert_eq!(
        firing(&b, &id, 0, ", settled_at", "'settled', now()"),
        Err(SETTLED_HAS_TX.to_owned())
    );
}

#[test]
fn still_refuses_a_settled_firing_with_a_ledger_id_and_no_settled_at() {
    let Some(b) = bank() else { return };
    let id = seed_schedule(&b);
    assert_eq!(
        firing(&b, &id, 0, ", ledger_tx_id", "'settled', id::text"),
        Err(SETTLED_HAS_TX.to_owned())
    );
}

#[test]
fn stores_a_settled_firing_that_has_a_ledger_id_and_settled_at() {
    let Some(b) = bank() else { return };
    let id = seed_schedule(&b);
    assert_eq!(
        firing(
            &b,
            &id,
            0,
            ", ledger_tx_id, settled_at",
            "'settled', id::text, now()"
        ),
        Ok(1)
    );
}

#[test]
fn down_drops_only_the_new_constraint() {
    let Some(b) = bank() else { return };
    b.db.client()
        .batch_execute(include_str!(
            "../migrations/0018_transfer_rejected_omits_ledger_tx.down.sql"
        ))
        .unwrap();
    let names: Vec<String> =
        b.db.client()
            .query(
                "SELECT c.conname::text FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid \
             JOIN pg_namespace n ON n.oid = t.relnamespace \
             WHERE n.nspname = 'bank' AND t.relname = 'transfer_executions' AND c.contype = 'c'",
                &[],
            )
            .unwrap()
            .iter()
            .map(|r| r.get(0))
            .collect();
    assert!(!names.iter().any(|n| n == OMITTED_LEDGER_TX));
    for kept in [
        REJECTED_HAS_CODE,
        SETTLED_HAS_TX,
        "transfer_executions_skipped_moved_nothing_ck",
        "transfer_executions_amount_positive_ck",
        "transfer_executions_occurrence_non_negative_ck",
    ] {
        assert!(names.iter().any(|n| n == kept), "{kept} in {names:?}");
    }
    let id = seed_schedule(&b);
    assert_eq!(
        firing(
            &b,
            &id,
            0,
            ", rejection_code, ledger_tx_id",
            "'rejected', 'ledger.insufficient_funds', id::text"
        ),
        Ok(1)
    );
    assert_eq!(
        firing(&b, &id, 1, "", "'rejected'"),
        Err(REJECTED_HAS_CODE.to_owned())
    );
    assert_eq!(
        firing(&b, &id, 2, ", settled_at", "'settled', now()"),
        Err(SETTLED_HAS_TX.to_owned())
    );
}

// ---------------------------------------------------------------------------------------------------------------
// The doors that start a pass: `ops.runDueTransfers` and `POST /internal/jobs/run-due-transfers` (`index.ts`)

fn job(door: &BankDoor, signed_as: Option<&str>) -> (u16, String) {
    let headers = signed_as.map_or_else(Vec::new, |s| signed(s, ""));
    let res = door.handle_from(
        &Request {
            method: "POST",
            url: "/internal/jobs/run-due-transfers",
            headers: &headers,
            body: "",
        },
        "req-transfers-job",
        "127.0.0.1",
    );
    (res.status, res.body)
}

#[test]
fn the_job_door_refuses_unsigned_then_a_switched_off_flag_then_runs_the_owners_batch() {
    let Some(b) = bank() else { return };
    let (_, rent, _) = standing_order(&b, "10", "monthly", "2026-01-01T09:00:00Z");
    b.ledger.fund(USER_A, "USDT", "100");
    set_now(at("2026-01-01T10:00:00Z"));
    let off = b.reopened(Owner {
        scheduled: false,
        ..Owner::default()
    });
    assert_eq!(
        job(&off, None),
        (
            401,
            r#"{"error":"service credentials required","code":"bank.unauthenticated"}"#.to_owned()
        )
    );
    assert_eq!(
        job(&off, Some("svc-bank")),
        (
            503,
            r#"{"error":"scheduled transfers are disabled","code":"bank.transfers_disabled"}"#
                .to_owned()
        )
    );
    let unset = b.reopened(Owner {
        batch: None,
        ..Owner::default()
    });
    let (status, body) = job(&unset, Some("svc-bank"));
    assert_eq!(status, 400);
    assert!(body.contains("bank.transfer_due_limit_unset"), "{body}");
    assert_eq!(b.ledger.posts(), 0);
    assert_eq!(
        job(&b.door, Some("svc-bank")),
        (
            200,
            r#"{"schedulesConsidered":1,"settled":1,"rejected":0,"alreadyFired":0,"strandedSwept":0,"failures":[]}"#
                .to_owned()
        )
    );
    assert_eq!(b.ledger.pot(&rent), "10");
}

#[test]
fn ops_run_due_transfers_refuses_a_blank_limit_and_the_switched_off_flag_before_it() {
    let Some(b) = bank() else { return };
    set_now(at("2026-01-01T10:00:00Z"));
    let blank = send(
        &b.door,
        "ops.runDueTransfers",
        Some("{}"),
        signed("svc-bank", "{}"),
    );
    assert_eq!(
        (blank.0, blank.code()),
        (400, "bank.transfer_due_limit_unset".to_owned())
    );
    let off = b.reopened(Owner {
        scheduled: false,
        ..Owner::default()
    });
    let input = r#"{"limit":10}"#;
    let refused = send(
        &off,
        "ops.runDueTransfers",
        Some(input),
        signed("svc-bank", input),
    );
    assert_eq!(refused.code(), "bank.transfers_disabled");
    let list = call(&b, USER_A, "transfers.listSchedules", "{}");
    assert_eq!(
        (list.0, list.code()),
        (400, "bank.schedules_list_limit_unset".to_owned())
    );
}
