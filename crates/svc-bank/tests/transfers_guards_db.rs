//! Slice `transfers`' guards against the Rust door on a real Postgres: holds on received funds
//! (`holds/received-holds.db.test.ts`), the step-up's use record (`step-up/step-up-store.db.test.ts`) and the safety
//! doors (`safety/safety.router.test.ts`, `region-notice.test.ts`), each test named after the TypeScript test's words.
//!
//! A send to another person is `personal`'s (`transfers.toUser`); until it is ported, a send here is what it books:
//! its reservation row with the hold decided inside it ([`holds::decide`]), the money moved in the stand-in ledger under
//! the send's own key, the row marked posted, then [`holds::place_for`]. Every answer a person gives enters through the
//! door. Without `TEST_DATABASE_URL` each test skips; with `REQUIRE_POSTGRES=1` it fails.
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
use std::sync::{Arc, Condvar, Mutex};

use service_kit::edge;
use service_kit::json::{self, Json};
use service_kit::money::{Amount, format_amount, parse_amount};
use service_kit::s2s::{self, system_seconds};
use service_kit::s2s_verify::BodyBind;
use service_kit::server::Request;
use service_kit::time::Instant;
use svc_bank::db::Store;
use svc_bank::door::{self, BankDoor, DoorConfig, Kind, ServiceAuth};
use svc_bank::partner::custody::{Freeze, FreezeReading};
use svc_bank::partner::router::Wiring as PartnerWiring;
use svc_bank::spaces::ports::{
    Ledger, LedgerAccount, LedgerBalance, LedgerTx, NoDirectory, PostFailure,
};
use svc_bank::spaces::space::in_tx;
use svc_bank::transfers::holds::{self, Decide, RELEASE_DATE_ACTOR};
use svc_bank::transfers::step_up::{
    Binding, Gate, Request as StepUpRequest, SqlUses, StepUpUse, UseStore,
};
use svc_bank::transfers::{Approvals, Deps, Settings, Wiring};

use support::TestDb;

const SECRET: &str = "a-bank-transfers-guards-edge-secret-long-enough";
const INTERNAL: &str = "a-bank-transfers-guards-internal-secret-long";
const ADA: &str = "11111111-1111-4111-8111-111111111111";
const BOB: &str = "22222222-2222-4222-8222-222222222222";
const CY: &str = "33333333-3333-4333-8333-333333333333";
const SID: &str = "44444444-4444-4444-8444-444444444444";
const DAY: i64 = 86_400_000;
const MINUTE: i64 = 60_000;

fn amt(s: &str) -> Amount {
    parse_amount(s).unwrap()
}

// ---------------------------------------------------------------------------------------------------------------
// The stand-in ledger: `MemoryLedger` with the three hold recipes, a lost post and a slow one.

/// A post held on its way to the ledger: `reached` once it is held, released by `open`.
/// An account: owner, asset, kind.
type Account = (String, String, String);

#[derive(Default)]
struct Slow {
    key: Option<String>,
    reached: bool,
    open: bool,
}

#[derive(Default)]
struct BookState {
    /// Account (owner, asset, kind) to amount.
    accounts: BTreeMap<Account, Amount>,
    /// Every booked key, in order, and its transaction.
    journal: Vec<(String, LedgerTx)>,
    fail_next: Option<String>,
}

#[derive(Clone, Default)]
struct Book {
    state: Arc<Mutex<BookState>>,
    slow: Arc<(Mutex<Slow>, Condvar)>,
}

fn available(user: &str) -> Account {
    (user.to_owned(), "USDT".to_owned(), "available".to_owned())
}

fn hold_account(user: &str, hold: &str) -> Account {
    (
        user.to_owned(),
        "USDT".to_owned(),
        format!("hold:pay:recv:{hold}"),
    )
}

impl Book {
    fn fund(&self, user: &str, amount: &str) {
        *self
            .state
            .lock()
            .unwrap()
            .accounts
            .entry(available(user))
            .or_default() += amt(amount);
    }
    fn available(&self, user: &str) -> String {
        let s = self.state.lock().unwrap();
        format_amount(s.accounts.get(&available(user)).copied().unwrap_or(0))
    }
    fn held(&self, user: &str, hold: &str) -> String {
        let s = self.state.lock().unwrap();
        format_amount(
            s.accounts
                .get(&hold_account(user, hold))
                .copied()
                .unwrap_or(0),
        )
    }
    fn posts(&self, prefix: &str) -> usize {
        let s = self.state.lock().unwrap();
        s.journal
            .iter()
            .filter(|(k, _)| k.starts_with(prefix))
            .count()
    }
    fn fail_next(&self, prefix: &str) {
        self.state.lock().unwrap().fail_next = Some(prefix.to_owned());
    }
    /// Books one move: `from` down, `to` up, refused when `from` would go below zero.
    fn book(
        &self,
        key: &str,
        moves: &[(Account, Account)],
        amount: Amount,
    ) -> Result<LedgerTx, PostFailure> {
        let mut s = self.state.lock().unwrap();
        if let Some((_, tx)) = s.journal.iter().find(|(k, _)| k == key) {
            return Ok(tx.clone());
        }
        for (from, _) in moves {
            if from.2 == "available" && s.accounts.get(from).copied().unwrap_or(0) < amount {
                return Err(PostFailure::Coded {
                    code: "ledger.insufficient_funds".to_owned(),
                    message: "Insufficient funds".to_owned(),
                    attempts: 1,
                });
            }
        }
        for (from, to) in moves {
            *s.accounts.entry(from.clone()).or_default() -= amount;
            *s.accounts.entry(to.clone()).or_default() += amount;
        }
        let tx = LedgerTx {
            id: format!("tx-{}", s.journal.len() + 1),
            posted_at: door::system_now(),
            entries: Vec::new(),
        };
        s.journal.push((key.to_owned(), tx.clone()));
        Ok(tx)
    }
}

fn field(j: &Json, k: &str) -> String {
    match j.get(k) {
        Some(Json::String(s)) => s.clone(),
        other => panic!("{k}: {other:?}"),
    }
}

impl Ledger for Book {
    fn balance(&self, a: &LedgerAccount) -> Result<Amount, String> {
        let s = self.state.lock().unwrap();
        Ok(s.accounts
            .get(&(a.owner_id.clone(), a.asset_id.clone(), a.kind.to_owned()))
            .copied()
            .unwrap_or(0))
    }
    fn balances(&self, _: &str, _: &str) -> Result<Vec<LedgerBalance>, String> {
        Ok(Vec::new())
    }
    fn assets(&self) -> Result<Vec<Json>, String> {
        Ok(Vec::new())
    }
    fn tx_by_key(&self, key: &str) -> Result<Option<LedgerTx>, String> {
        let s = self.state.lock().unwrap();
        Ok(s.journal
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, t)| t.clone()))
    }
    fn post_recipe(&self, recipe: &str, input: &Json, key: &str) -> Result<LedgerTx, PostFailure> {
        {
            let mut s = self.state.lock().unwrap();
            if s.fail_next.as_deref().is_some_and(|p| key.starts_with(p)) {
                s.fail_next = None;
                return Err(PostFailure::Unknown(
                    "connection reset before the post was sent".to_owned(),
                ));
            }
        }
        {
            let (lock, cv) = &*self.slow;
            let mut slow = lock.lock().unwrap();
            if slow.key.as_deref() == Some(key) {
                slow.key = None;
                slow.reached = true;
                cv.notify_all();
                while !slow.open {
                    slow = cv.wait(slow).unwrap();
                }
            }
        }
        let hold = field(input, "holdId");
        let user = field(input, "userId");
        assert_eq!(field(input, "assetId"), "USDT");
        let amount = amt(&field(input, "amount"));
        let (want, moves) = match recipe {
            "payReceivedHold" => (
                format!("pay.recv.hold:{hold}"),
                vec![(available(&user), hold_account(&user, &hold))],
            ),
            "payReceivedRelease" => {
                assert_eq!(field(input, "heldAmount"), field(input, "amount"));
                (
                    format!("pay.recv.release:{hold}"),
                    vec![(hold_account(&user, &hold), available(&user))],
                )
            }
            "payReceivedReturn" => {
                assert_eq!(field(input, "heldAmount"), field(input, "amount"));
                let payer = field(input, "payerUserId");
                (
                    format!("pay.recv.return:{hold}"),
                    vec![(hold_account(&user, &hold), available(&payer))],
                )
            }
            other => panic!("no recipe {other} here"),
        };
        assert_eq!(key, want, "the key the recipe builds");
        self.book(key, &moves, amount)
    }
}

impl Book {
    fn slow(&self, key: &str) {
        let mut s = self.slow.0.lock().unwrap();
        *s = Slow {
            key: Some(key.to_owned()),
            reached: false,
            open: false,
        };
    }
    fn wait_reached(&self) {
        let (lock, cv) = &*self.slow;
        let mut s = lock.lock().unwrap();
        while !s.reached {
            s = cv.wait(s).unwrap();
        }
    }
    fn open(&self) {
        let (lock, cv) = &*self.slow;
        lock.lock().unwrap().open = true;
        cv.notify_all();
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
// The door, its calls, and the slice's own parts driven directly.

struct Bank {
    door: BankDoor,
    store: Store,
    book: Book,
    partner: PartnerWiring,
    spaces: svc_bank::spaces::Wiring,
    wiring: Wiring,
}

fn settings(hold_days: Option<i64>) -> Settings {
    Settings {
        stranger_hold_days: hold_days,
        producer: "svc-bank".to_owned(),
        ..Settings::default()
    }
}

fn partner() -> PartnerWiring {
    PartnerWiring {
        partner: None,
        freeze: Box::new(Open),
        custody_layer: "on".to_owned(),
        cash_legs: None,
        pay_in: None,
    }
}

fn spaces(book: &Book) -> svc_bank::spaces::Wiring {
    let mut w = svc_bank::spaces::Wiring::none();
    w.ledger = Box::new(book.clone());
    w.directory = Box::new(NoDirectory);
    w
}

fn wiring(hold_days: Option<i64>) -> Wiring {
    let mut w = Wiring::none();
    w.settings = settings(hold_days);
    w
}

fn bank(db: &TestDb, book: &Book, hold_days: Option<i64>) -> Bank {
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
        store: db.store(),
    })
    .unwrap()
    .with_partner(partner())
    .with_spaces(spaces(book))
    .with_transfers(wiring(hold_days));
    Bank {
        door,
        store: db.store(),
        book: book.clone(),
        partner: partner(),
        spaces: spaces(book),
        wiring: wiring(hold_days),
    }
}

impl Bank {
    /// The slice's parts as the door hands them over, at `now`.
    fn with<T>(&self, now: i64, f: impl FnOnce(&Deps<'_>) -> T) -> T {
        let custody = self.partner.custody(&self.store);
        f(&Deps {
            store: &self.store,
            ledger: &self.book,
            custody: &custody,
            partner: &self.partner,
            spaces: &self.spaces,
            w: &self.wiring,
            now: Instant(now),
        })
    }

    fn sweep(&self, at: i64) -> Vec<Result<(), String>> {
        self.with(at, |d| holds::sweep(d, 10))
    }

    fn place_for(&self, transfer_id: &str, at: i64) -> bool {
        self.with(at, |d| holds::place_for(d, transfer_id, Instant(at)))
            .unwrap()
    }

    /// What `transfers.toUser` books for a send from `from` to `to`, its own request when `request` is set: the
    /// reservation with the hold decided in it, the money moved under the send's key, the row posted, then the hold
    /// set aside.
    fn pay(&self, from: &str, to: &str, transfer_id: &str, amount: &str, request: Option<&str>) {
        let now = now();
        let days = self.wiring.settings.stranger_hold_days;
        in_tx(&self.store, |tx| {
            tx.execute(
                "INSERT INTO bank.personal_transfers \
                   (transfer_id, from_user_id, from_space_id, to_user_id, asset_id, amount, status) \
                 VALUES ($1, $2, gen_random_uuid(), $3, 'USDT', $4::text::numeric, 'reserved')",
                &[&transfer_id, &from, &to, &amount],
            )
            .unwrap();
            holds::decide(
                tx,
                days,
                &Decide {
                    transfer_id,
                    payer_user_id: from,
                    recipient_user_id: to,
                    asset_id: "USDT",
                    amount: amt(amount),
                    request_id: request,
                    now: Instant(now),
                },
            )
        })
        .unwrap();
        let tx = self
            .book
            .book(
                &format!("bank.transfer.p2p:{transfer_id}:0"),
                &[(available(from), available(to))],
                amt(amount),
            )
            .unwrap();
        let mut c = self.store.pool().unwrap().get().unwrap();
        c.client()
            .unwrap()
            .execute(
                "UPDATE bank.personal_transfers SET status = 'posted', ledger_tx_id = $1, posted_at = now() \
                  WHERE transfer_id = $2",
                &[&tx.id, &transfer_id],
            )
            .unwrap();
        drop(c);
        self.place_for(transfer_id, now);
    }

    fn sql(&self, q: &str) -> Vec<postgres::Row> {
        let mut c = self.store.pool().unwrap().get().unwrap();
        c.client().unwrap().query(q, &[]).unwrap()
    }
}

fn person(user: &str, scopes: &[&str], region: &str) -> Vec<(String, String)> {
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
    let sig = edge::sign(&raw, SECRET, region).unwrap();
    vec![
        ("x-intafaced-principal".to_owned(), raw),
        ("x-intafaced-principal-sig".to_owned(), sig),
        ("x-intafaced-region".to_owned(), region.to_owned()),
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
}

fn send(b: &Bank, path: &str, input: Option<&str>, mut headers: Vec<(String, String)>) -> Answer {
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
    let res = b.door.handle_from(
        &Request {
            method,
            url: &url,
            headers: &headers,
            body: &body,
        },
        "req-transfers-guards",
        "127.0.0.1",
    );
    Answer(res.status, json::parse(&res.body).unwrap())
}

fn call(b: &Bank, user: &str, path: &str, input: &str) -> Answer {
    send(
        b,
        path,
        (!input.is_empty()).then_some(input),
        person(user, &["bank:read", "bank:write"], "DE"),
    )
}

fn as_service(b: &Bank, service: Option<&str>, path: &str, input: &str) -> Answer {
    let headers = match service {
        Some(s) => s2s::legacy_headers(s, INTERNAL, input, system_seconds()).unwrap(),
        None => Vec::new(),
    };
    send(b, path, Some(input), headers)
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

fn now() -> i64 {
    door::system_now().0
}

fn db() -> Option<TestDb> {
    let db = TestDb::new()?;
    db.migrated();
    Some(db)
}

/// `build(30)`: Ada and Cy hold 100 USDT; Bob nothing; holds wait 30 days (a LOCAL TEST release period).
fn setup(db: &TestDb, hold_days: Option<i64>) -> Bank {
    let book = Book::default();
    book.fund(ADA, "100");
    book.fund(CY, "100");
    bank(db, &book, hold_days)
}

fn set_hold(b: &Bank, user: &str) {
    let r = call(b, user, "holds.setRule", r#"{"strangers":"hold"}"#).ok();
    assert_eq!(text(&r, "strangers"), "hold");
}

fn state_of(b: &Bank, transfer_id: &str) -> String {
    let rows = b.sql(&format!(
        "SELECT state FROM bank.received_holds WHERE transfer_id = '{transfer_id}'"
    ));
    rows.first()
        .map_or_else(|| "none".to_owned(), |r| r.get::<_, String>(0))
}

fn completed(n: usize) -> Vec<Result<(), String>> {
    vec![Ok(()); n]
}

// ---------------------------------------------------------------------------------------------------------------
// holds/received-holds.db.test.ts

#[test]
fn pays_a_stranger_in_by_default_with_hold_the_payment_is_set_aside_listed_with_its_reason_and_date_and_accept_releases_it_once()
 {
    let Some(db) = db() else { return };
    let b = setup(&db, Some(30));
    let rule = call(&b, BOB, "holds.rule", "").ok();
    assert_eq!(rule.compact(), r#"{"strangers":"pay_in","holdDays":30}"#);
    b.pay(ADA, BOB, "recv-default-1", "5", None);
    assert_eq!(b.book.available(BOB), "5");
    assert_eq!(b.book.posts("pay.recv.hold:"), 0);

    let set = call(&b, BOB, "holds.setRule", r#"{"strangers":"hold"}"#).ok();
    assert_eq!(set.compact(), r#"{"strangers":"hold","holdDays":30}"#);
    assert_eq!(
        call(&b, BOB, "holds.rule", "").ok().compact(),
        r#"{"strangers":"hold","holdDays":30}"#
    );
    let before = now();
    b.pay(CY, BOB, "recv-held-1", "7", None);
    assert_eq!(b.book.available(CY), "93");
    assert_eq!(b.book.available(BOB), "5");
    assert_eq!(b.book.held(BOB, "recv-held-1"), "7");
    // The view names the sender's handle from the send's own row.
    b.sql("UPDATE bank.personal_transfers SET from_handle = 'cy' WHERE transfer_id = 'recv-held-1' RETURNING 1");
    let waiting = arr(&call(&b, BOB, "holds.waiting", "").ok());
    assert_eq!(waiting.len(), 1);
    let w = &waiting[0];
    assert_eq!(text(w, "transferId"), "recv-held-1");
    assert_eq!(text(w, "state"), "held");
    assert_eq!(text(w, "reasonClass"), "stranger");
    assert_eq!(text(w, "amount"), "7");
    assert_eq!(text(w, "assetId"), "USDT");
    assert_eq!(text(w, "fromHandle"), "cy");
    let release = service_kit::time::js_date(&text(w, "releaseAt")).unwrap().0;
    assert!(release >= before + 30 * DAY - 1000 && release <= now() + 30 * DAY);

    let accepted = call(&b, BOB, "holds.accept", r#"{"transferId":"recv-held-1"}"#).ok();
    assert_eq!(text(&accepted, "state"), "released");
    assert_eq!(text(&accepted, "amount"), "7");
    assert_eq!(b.book.available(BOB), "12");
    assert_eq!(b.book.held(BOB, "recv-held-1"), "0");
    // The same answer again is the same outcome, never a second post; the other answer is refused.
    let again = call(&b, BOB, "holds.accept", r#"{"transferId":"recv-held-1"}"#).ok();
    assert_eq!(text(&again, "state"), "released");
    let deny = call(&b, BOB, "holds.deny", r#"{"transferId":"recv-held-1"}"#);
    assert_eq!(
        (deny.trpc(), deny.code()),
        (
            "CONFLICT".to_owned(),
            "bank.received_hold_decided".to_owned()
        )
    );
    assert_eq!(b.book.posts("pay.recv.hold:"), 1);
    assert_eq!(b.book.posts("pay.recv.release:"), 1);
    assert_eq!(b.book.posts("pay.recv.return:"), 0);
    assert_eq!(call(&b, BOB, "holds.waiting", "").ok().compact(), "[]");
    assert_eq!(b.book.available(CY), "93");
}

#[test]
fn deny_returns_the_whole_payment_to_the_sender_once_accept_after_it_is_refused() {
    let Some(db) = db() else { return };
    let b = setup(&db, Some(30));
    set_hold(&b, BOB);
    b.pay(CY, BOB, "recv-deny-1", "4", None);
    let denied = call(&b, BOB, "holds.deny", r#"{"transferId":"recv-deny-1"}"#).ok();
    assert_eq!(text(&denied, "state"), "returned");
    assert_eq!(text(&denied, "amount"), "4");
    assert_eq!(b.book.available(CY), "100");
    assert_eq!(b.book.available(BOB), "0");
    assert_eq!(b.book.held(BOB, "recv-deny-1"), "0");
    let again = call(&b, BOB, "holds.deny", r#"{"transferId":"recv-deny-1"}"#).ok();
    assert_eq!(text(&again, "state"), "returned");
    let accept = call(&b, BOB, "holds.accept", r#"{"transferId":"recv-deny-1"}"#);
    assert_eq!(accept.trpc(), "CONFLICT");
    assert_eq!(b.book.posts("pay.recv.return:"), 1);
    assert_eq!(b.book.posts("pay.recv.release:"), 0);
}

#[test]
fn holds_only_strangers_someone_the_recipient_has_paid_and_a_payment_of_their_own_request_go_straight_in()
 {
    let Some(db) = db() else { return };
    let b = setup(&db, Some(30));
    set_hold(&b, BOB);
    b.pay(ADA, BOB, "recv-known-0", "10", None);
    call(&b, BOB, "holds.accept", r#"{"transferId":"recv-known-0"}"#).ok();
    b.pay(BOB, ADA, "recv-known-1", "1", None);
    b.pay(ADA, BOB, "recv-known-2", "3", None);
    assert_eq!(b.book.available(BOB), "12");
    assert_eq!(b.book.posts("pay.recv.hold:"), 1);
    // Cy pays Bob's request: Bob asked, so it is not a stranger's payment. (The request itself is `requests`'; the
    // send names it, which is all the hold reads.)
    b.sql(
        "INSERT INTO bank.personal_requests (id, payee_user_id, payer_user_id, asset_id, amount, status, expires_at, \
           idempotency_key) VALUES ('77777777-7777-4777-8777-777777777777', '22222222-2222-4222-8222-222222222222', \
           '33333333-3333-4333-8333-333333333333', 'USDT', 2, 'open', now() + interval '1 day', 'recv-request-ask-1') \
         RETURNING 1",
    );
    b.pay(
        CY,
        BOB,
        "recv-request-1",
        "2",
        Some("77777777-7777-4777-8777-777777777777"),
    );
    assert_eq!(b.book.available(BOB), "14");
    assert_eq!(b.book.posts("pay.recv.hold:"), 1);
}

#[test]
fn only_the_recipient_sees_and_answers_a_hold_anyone_else_reads_the_same_not_found_as_a_missing_id()
{
    let Some(db) = db() else { return };
    let b = setup(&db, Some(30));
    set_hold(&b, BOB);
    b.pay(CY, BOB, "recv-own-1", "2", None);
    for who in [ADA, CY] {
        assert_eq!(call(&b, who, "holds.waiting", "").ok().compact(), "[]");
        for answer in ["holds.accept", "holds.deny"] {
            let a = call(&b, who, answer, r#"{"transferId":"recv-own-1"}"#);
            assert_eq!(
                (a.trpc(), a.code()),
                (
                    "NOT_FOUND".to_owned(),
                    "bank.received_hold_not_found".to_owned()
                )
            );
        }
    }
    let missing = call(&b, BOB, "holds.accept", r#"{"transferId":"no-such-hold"}"#);
    assert_eq!(missing.trpc(), "NOT_FOUND");
    let read_only = send(
        &b,
        "holds.accept",
        Some(r#"{"transferId":"recv-own-1"}"#),
        person(BOB, &["bank:read"], "DE"),
    );
    assert_eq!(read_only.trpc(), "FORBIDDEN");
    assert_eq!(b.book.held(BOB, "recv-own-1"), "2");
}

#[test]
fn a_blank_release_period_refuses_hold_by_its_code_and_a_payment_under_an_older_choice_is_paid_in_never_held_without_a_date()
 {
    let Some(db) = db() else { return };
    let first = setup(&db, Some(30));
    set_hold(&first, BOB);
    let b = bank(&db, &first.book, None);
    assert_eq!(
        call(&b, BOB, "holds.rule", "").ok().compact(),
        r#"{"strangers":"hold","holdDays":null}"#
    );
    let refused = call(&b, BOB, "holds.setRule", r#"{"strangers":"hold"}"#);
    assert_eq!(
        (refused.trpc(), refused.code()),
        (
            "PRECONDITION_FAILED".to_owned(),
            "bank.stranger_hold_period_unset".to_owned()
        )
    );
    b.pay(CY, BOB, "recv-blank-1", "3", None);
    assert_eq!(b.book.available(BOB), "3");
    assert_eq!(b.book.posts("pay.recv.hold:"), 0);
    assert_eq!(
        call(&b, BOB, "holds.setRule", r#"{"strangers":"pay_in"}"#)
            .ok()
            .compact(),
        r#"{"strangers":"pay_in","holdDays":null}"#
    );
}

#[test]
fn a_hold_nobody_answers_goes_back_to_the_sender_at_its_release_date_once_by_the_recovery_timer() {
    let Some(db) = db() else { return };
    let b = setup(&db, Some(30));
    set_hold(&b, BOB);
    b.pay(CY, BOB, "recv-expire-1", "6", None);
    assert!(b.sweep(now() + 29 * DAY).is_empty());
    assert_eq!(b.book.held(BOB, "recv-expire-1"), "6");
    let later = now() + 31 * DAY;
    assert_eq!(b.sweep(later), completed(1));
    assert!(b.sweep(later).is_empty());
    assert_eq!(b.book.available(CY), "100");
    assert_eq!(b.book.held(BOB, "recv-expire-1"), "0");
    let rows = b.sql(
        "SELECT state, decided_by FROM bank.received_holds WHERE transfer_id = 'recv-expire-1'",
    );
    assert_eq!(rows[0].get::<_, String>(0), "returned");
    assert_eq!(rows[0].get::<_, String>(1), RELEASE_DATE_ACTOR);
    assert_eq!(b.book.posts("pay.recv.return:"), 1);
}

#[test]
fn a_hold_post_lost_after_the_send_posted_is_finished_by_the_recovery_timer_the_sends_answer_stands_and_nothing_is_lost()
 {
    let Some(db) = db() else { return };
    let b = setup(&db, Some(30));
    set_hold(&b, BOB);
    b.book.fail_next("pay.recv.hold:");
    b.pay(CY, BOB, "recv-lost-1", "5", None);
    assert_eq!(b.book.available(CY), "95");
    assert_eq!(state_of(&b, "recv-lost-1"), "placing");
    let early = call(&b, BOB, "holds.accept", r#"{"transferId":"recv-lost-1"}"#);
    assert_eq!(early.code(), "bank.received_hold_not_ready");
    assert_eq!(b.sweep(now()), completed(1));
    assert_eq!(b.book.held(BOB, "recv-lost-1"), "5");
    assert_eq!(b.book.available(BOB), "0");
    let states: Vec<String> = arr(&call(&b, BOB, "holds.waiting", "").ok())
        .iter()
        .map(|h| text(h, "state"))
        .collect();
    assert_eq!(states, ["held"]);
    assert_eq!(b.book.posts("pay.recv.hold:"), 1);
}

#[test]
fn a_send_left_reserved_after_its_post_landed_is_still_set_aside_by_the_recovery_timer_from_the_ledger()
 {
    let Some(db) = db() else { return };
    let b = setup(&db, Some(30));
    set_hold(&b, BOB);
    b.book.fail_next("pay.recv.hold:");
    b.pay(CY, BOB, "recv-stuck-1", "5", None);
    b.sql(
        "UPDATE bank.personal_transfers SET status = 'reserved', ledger_tx_id = NULL, posted_at = NULL \
          WHERE transfer_id = 'recv-stuck-1' RETURNING 1",
    );
    assert_eq!(b.sweep(now()), completed(1));
    assert_eq!(b.book.held(BOB, "recv-stuck-1"), "5");
    assert_eq!(b.book.available(BOB), "0");
    let waiting: Vec<(String, String)> = arr(&call(&b, BOB, "holds.waiting", "").ok())
        .iter()
        .map(|h| (text(h, "transferId"), text(h, "state")))
        .collect();
    assert_eq!(waiting, [("recv-stuck-1".to_owned(), "held".to_owned())]);
}

#[test]
fn a_payment_spent_before_it_could_be_set_aside_lapses_only_after_the_refusal_stood_for_the_in_flight_bound()
 {
    let Some(db) = db() else { return };
    let b = setup(&db, Some(30));
    set_hold(&b, BOB);
    b.book.fail_next("pay.recv.hold:");
    b.pay(CY, BOB, "recv-spent-1", "5", None);
    b.pay(BOB, ADA, "recv-spent-out", "5", None);
    assert_eq!(b.book.available(BOB), "0");
    let first = b.sweep(now());
    assert_eq!(first.len(), 1);
    assert!(first[0].is_err());
    // Retried inside the bound, it is still owed: an earlier attempt could yet land.
    assert_eq!(b.sweep(now() + MINUTE).len(), 1);
    assert_eq!(state_of(&b, "recv-spent-1"), "placing");
    assert_eq!(b.sweep(now() + 8 * MINUTE), completed(1));
    let rows = b.sql(
        "SELECT state, lapse_reason FROM bank.received_holds WHERE transfer_id = 'recv-spent-1'",
    );
    assert_eq!(rows[0].get::<_, String>(0), "lapsed");
    assert_eq!(
        rows[0].get::<_, String>(1),
        "the payment was spent before it could be set aside"
    );
    assert_eq!(call(&b, BOB, "holds.waiting", "").ok().compact(), "[]");
    assert_eq!(b.book.posts("pay.recv.hold:"), 0);
    assert!(b.sweep(now() + 9 * MINUTE).is_empty());
}

/// ReceivedHold.tla, NeverStranded: the setup of the two races. Each payment's hold post is lost, Bob spends the money,
/// and the timer's attempt is refused for funds.
fn strand_setup(b: &Bank, ids: &[&str]) {
    set_hold(b, BOB);
    for id in ids {
        b.book.fail_next("pay.recv.hold:");
        b.pay(CY, BOB, id, "5", None);
    }
    let total = format_amount(amt("5") * i128::try_from(ids.len()).unwrap());
    b.pay(BOB, ADA, "strand-spent", &total, None);
    assert_eq!(b.book.available(BOB), "0");
    b.sweep(now());
    let rows = b.sql("SELECT refused_at IS NOT NULL FROM bank.received_holds ORDER BY created_at");
    assert!(rows.iter().all(|r| r.get::<_, bool>(0)));
}

fn reachable(b: &Bank, id: &str) {
    let pair = (state_of(b, id), b.book.held(BOB, id));
    assert!(
        pair == ("held".to_owned(), "5".to_owned())
            || pair == ("lapsed".to_owned(), "0".to_owned()),
        "{pair:?}"
    );
}

#[test]
fn a_hold_request_still_on_its_way_from_a_later_attempt_never_lands_in_a_hold_the_timer_has_lapsed()
{
    let Some(db) = db() else { return };
    let b = setup(&db, Some(30));
    strand_setup(&b, &["strand-a"]);
    let later = now() + 8 * MINUTE;
    b.book.slow("pay.recv.hold:strand-a");
    std::thread::scope(|s| {
        let first = s.spawn(|| b.place_for("strand-a", later));
        b.book.wait_reached();
        b.sweep(later);
        b.pay(ADA, BOB, "strand-a-in", "5", None);
        b.book.open();
        first.join().unwrap();
    });
    b.sweep(now() + 9 * MINUTE);
    reachable(&b, "strand-a");
}

#[test]
fn a_placer_that_read_the_row_before_the_timer_lapsed_it_never_posts_the_hold_after() {
    let Some(db) = db() else { return };
    let b = setup(&db, Some(30));
    strand_setup(&b, &["strand-b0", "strand-b"]);
    let later = now() + 8 * MINUTE;
    b.book.slow("pay.recv.hold:strand-b0");
    std::thread::scope(|s| {
        let pass = s.spawn(|| b.sweep(later));
        b.book.wait_reached();
        b.place_for("strand-b", later);
        assert_eq!(state_of(&b, "strand-b"), "lapsed");
        b.pay(ADA, BOB, "strand-b-in", "10", None);
        b.book.open();
        pass.join().unwrap();
    });
    reachable(&b, "strand-b");
}

#[test]
fn an_accept_whose_ledger_post_fails_is_still_recorded_answers_as_accepted_and_the_recovery_timer_finishes_it_once()
 {
    let Some(db) = db() else { return };
    let b = setup(&db, Some(30));
    set_hold(&b, BOB);
    b.pay(CY, BOB, "recv-slow-1", "3", None);
    b.book.fail_next("pay.recv.release:");
    let a = call(&b, BOB, "holds.accept", r#"{"transferId":"recv-slow-1"}"#).ok();
    assert_eq!(text(&a, "state"), "releasing");
    let deny = call(&b, BOB, "holds.deny", r#"{"transferId":"recv-slow-1"}"#);
    assert_eq!(deny.trpc(), "CONFLICT");
    let states: Vec<String> = arr(&call(&b, BOB, "holds.waiting", "").ok())
        .iter()
        .map(|h| text(h, "state"))
        .collect();
    assert_eq!(states, ["releasing"]);
    assert_eq!(b.sweep(now()), completed(1));
    assert_eq!(b.book.available(BOB), "3");
    assert_eq!(call(&b, BOB, "holds.waiting", "").ok().compact(), "[]");
    assert_eq!(b.book.posts("pay.recv.release:"), 1);
}

#[test]
fn invariant_across_every_outcome_the_recipients_available_plus_held_equals_what_they_were_paid_and_the_senders_books_balance()
 {
    let Some(db) = db() else { return };
    let b = setup(&db, Some(30));
    set_hold(&b, BOB);
    b.pay(CY, BOB, "recv-inv-1", "1", None);
    b.pay(CY, BOB, "recv-inv-2", "2", None);
    b.pay(CY, BOB, "recv-inv-3", "3", None);
    call(&b, BOB, "holds.accept", r#"{"transferId":"recv-inv-1"}"#).ok();
    call(&b, BOB, "holds.deny", r#"{"transferId":"recv-inv-2"}"#).ok();
    let bob_total = amt(&b.book.available(BOB))
        + amt(&b.book.held(BOB, "recv-inv-1"))
        + amt(&b.book.held(BOB, "recv-inv-2"))
        + amt(&b.book.held(BOB, "recv-inv-3"));
    assert_eq!(format_amount(bob_total), "4");
    assert_eq!(b.book.available(CY), "96");
    assert_eq!(format_amount(amt(&b.book.available(CY)) + bob_total), "100");
}

// ---------------------------------------------------------------------------------------------------------------
// step-up/step-up-store.db.test.ts

const EXPIRES: &str = "2026-10-14T12:05:00.000Z";

fn use_(approval: &str, session: &str, hash: &str, op: &str) -> StepUpUse {
    StepUpUse {
        approval_id: approval.to_owned(),
        user_id: "u1".to_owned(),
        session_id: session.to_owned(),
        action_type: "bank.step_up.transfers.toUser".to_owned(),
        payload_hash: hash.to_owned(),
        operation_key: op.to_owned(),
        expires_at: service_kit::time::js_date(EXPIRES).unwrap(),
    }
}

#[test]
fn stores_once_and_hands_a_racing_writer_the_first_row() {
    let Some(db) = db() else { return };
    let store = db.store();
    let uses = SqlUses(&store);
    let first = uses
        .record(&use_("ap-1", "s1", "sha256:aaa", "transfer-0001"))
        .unwrap();
    assert_eq!(first.operation_key, "transfer-0001");
    let second = uses
        .record(&use_("ap-1", "s1", "sha256:bbb", "transfer-0002"))
        .unwrap();
    assert_eq!(second.operation_key, "transfer-0001");
    let got = uses.get("ap-1").unwrap().unwrap();
    assert_eq!(got.user_id, "u1");
    assert_eq!(got.session_id, "s1");
    assert_eq!(got.expires_at.iso(), EXPIRES);
    assert!(uses.get("missing").unwrap().is_none());
}

#[test]
fn rejects_blank_ids_at_the_database() {
    let Some(db) = db() else { return };
    let store = db.store();
    let uses = SqlUses(&store);
    assert!(uses.record(&use_(" ", "s1", "sha256:aaa", "t-1")).is_err());
    assert!(uses.record(&use_("ap-x", "s1", "sha256:aaa", "")).is_err());
    assert!(uses.record(&use_("ap-y", "", "sha256:aaa", "t-1")).is_err());
}

/// An identity that consumes every approval once for `u9`, as the TypeScript's stand-in does.
struct Consumes(Mutex<usize>);

impl Approvals for Consumes {
    fn consume(
        &self,
        input: &service_kit::approvals::ConsumeInput<'_>,
        _principal: Option<service_kit::approvals::PrincipalBinding<'_>>,
    ) -> Result<
        (
            service_kit::approvals::Consumed,
            service_kit::approvals::Facts,
        ),
        service_kit::approvals::ConsumeError,
    > {
        *self.0.lock().unwrap() += 1;
        Ok((
            service_kit::approvals::Consumed {
                action_type: input.target_id.to_owned(),
                target_service: input.target_service.to_owned(),
                target_id: input.target_id.to_owned(),
                status: "CONSUMED".to_owned(),
                requester_id: "u9".to_owned(),
                approver_id: Some("u9".to_owned()),
                approver_is_founder: None,
                requester_is_founder: None,
            },
            service_kit::approvals::Facts {
                kind: Some("same_person".to_owned()),
                expires_at: EXPIRES.to_owned(),
            },
        ))
    }
}

#[test]
fn the_gate_replays_the_same_operation_from_postgres_and_refuses_another() {
    let Some(db) = db() else { return };
    let store = db.store();
    let uses = SqlUses(&store);
    let identity = Consumes(Mutex::new(0));
    let gate = Gate {
        required: true,
        approvals: &identity,
        store: &uses,
        now: service_kit::time::js_date("2026-10-14T12:00:00.000Z").unwrap(),
    };
    let binding = |t: &str| Binding {
        action_type: "bank.step_up.transfers.toUser",
        fields: vec![
            ("transferId".to_owned(), t.to_owned()),
            ("amount".to_owned(), "5".to_owned()),
        ],
        operation_key: t.to_owned(),
    };
    let one = binding("t-1");
    let two = binding("t-2");
    let req = |b: &'static str, session: &'static str, binding, replay| StepUpRequest {
        user_id: b,
        session_id: session,
        binding,
        approval_id: Some("ap-gate"),
        replay,
    };
    gate.require(&req("u9", "s9", &one, true)).unwrap();
    gate.require(&req("u9", "s9", &one, true)).unwrap();
    assert_eq!(*identity.0.lock().unwrap(), 1);
    let code = |r: Result<(), svc_bank::errors::Refusal>| match r {
        Err(svc_bank::errors::Refusal::Bank(e)) => e.row.code,
        other => panic!("{other:?}"),
    };
    assert_eq!(
        code(gate.require(&req("u9", "s9", &two, true))),
        "bank.step_up_mismatch"
    );
    assert_eq!(
        code(gate.require(&req("u9", "s9", &one, false))),
        "bank.step_up_used"
    );
    assert_eq!(
        code(gate.require(&req("u9", "s-other", &one, true))),
        "bank.step_up_required"
    );
}

// ---------------------------------------------------------------------------------------------------------------
// safety/safety.router.test.ts, region-notice.test.ts

const SENT: &str = "tr-ann-00000001";

#[test]
fn answers_svc_support_with_one_boolean_sent_for_the_sender_not_sent_for_anyone_or_anything_else() {
    let Some(db) = db() else { return };
    let b = setup(&db, None);
    b.pay(ADA, BOB, SENT, "1", None);
    let ask = |user: &str, transfer: &str| {
        as_service(
            &b,
            Some("svc-support"),
            "safety.transferSent",
            &format!(r#"{{"userId":"{user}","transferId":"{transfer}"}}"#),
        )
        .ok()
        .compact()
    };
    assert_eq!(ask(ADA, SENT), r#"{"sent":true}"#);
    assert_eq!(ask(BOB, SENT), r#"{"sent":false}"#);
    assert_eq!(ask(ADA, "tr-nobody-0001"), r#"{"sent":false}"#);
}

#[test]
fn serves_svc_support_only_another_service_is_forbidden_no_service_is_unauthorized() {
    let Some(db) = db() else { return };
    let b = setup(&db, None);
    let input = format!(r#"{{"userId":"{ADA}","transferId":"{SENT}"}}"#);
    assert_eq!(
        as_service(&b, Some("svc-pay"), "safety.transferSent", &input).trpc(),
        "FORBIDDEN"
    );
    assert_eq!(
        as_service(&b, None, "safety.transferSent", &input).trpc(),
        "UNAUTHORIZED"
    );
    let extra = format!(r#"{{"userId":"{ADA}","transferId":"{SENT}","amount":"5"}}"#);
    assert_eq!(
        as_service(&b, Some("svc-support"), "safety.transferSent", &extra).trpc(),
        "BAD_REQUEST"
    );
}

#[test]
fn the_region_notice_names_a_blocked_region_its_authority_and_the_owners_wording_and_nothing_for_an_open_one()
 {
    let Some(db) = db() else { return };
    let book = Book::default();
    let mut b = bank(&db, &book, None);
    let mut w = wiring(None);
    w.settings.blocked_region_notice = Some("  We do not serve your region yet.  ".to_owned());
    b.door = b.door.with_transfers(w);
    let open = send(
        &b,
        "safety.regionNotice",
        None,
        person(ADA, &["bank:read"], "DE"),
    )
    .ok();
    assert_eq!(
        open.compact(),
        r#"{"region":"DE","blocked":false,"code":null,"restriction":null,"blockedBy":null,"wording":null}"#
    );
    let us = send(
        &b,
        "safety.regionNotice",
        None,
        person(ADA, &["bank:read"], "US"),
    )
    .ok();
    assert_eq!(
        us.compact(),
        r#"{"region":"US","blocked":true,"code":"denied.region_blocked","restriction":"The United States is not served at launch.","blockedBy":"business","wording":"We do not serve your region yet."}"#
    );
    let anon = send(&b, "safety.regionNotice", None, Vec::new()).ok();
    assert_eq!(text(&anon, "blocked"), "false");
}
