//! Part `portfolio` of slice `activity` against the Rust door on a real Postgres. Every check enters through the door
//! (`/trpc/portfolio.*`) with the part's real wiring over svc-bank's own tables: the person's Spaces from `bank.spaces`
//! (made by `spaces.create` and `spaces.archive`) and a personal send's fee from `bank.personal_transfers`. svc-ledger's
//! balances, history pages and holdings history and svc-trade's prices are stand-ins. Each test is named after the
//! TypeScript test's words.
//!
//! Ported: "the balance page names each personal send's fee and state; other entries' fee stays unknown"
//! (`transfers/send-review.db.test.ts`, its `balanceEntries` half; the send is the row `transfers.toUser` writes, the
//! money the stand-in book's two legs), and the checks of `portfolio/*.test.ts` that read svc-bank's own Space table,
//! run here against the table itself. Every other `portfolio/*.test.ts` check is a unit test in
//! `src/activity/portfolio/` (its stand-ins are the TypeScript's: a Space list, not the table).
//!
//! Not ported: `portfolio/` has no `.db.test.ts` of its own; the door's guards (anonymous, no `bank:read`) and input
//! checks are held for every call by `tests/guard_grid.rs`, `tests/wire_replay.rs` and `tests/input_parity.rs`.
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

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, Mutex};

use service_kit::edge;
use service_kit::json::{self, Json};
use service_kit::money::{Amount, parse_amount};
use service_kit::s2s_verify::BodyBind;
use service_kit::server::Request;
use service_kit::time::Instant;
use svc_bank::activity;
use svc_bank::activity::pages::{HistoryPages, Page, PageEntry, PageRequest};
use svc_bank::activity::portfolio::candles::{CloseSeries, CloseSource};
use svc_bank::activity::portfolio::history::{HistoryError, Holdings, HoldingsHistory};
use svc_bank::activity::portfolio::tickers::TickerSource;
use svc_bank::activity::portfolio::valuation::{PriceBook, TickerQuote};
use svc_bank::door::{self, BankDoor, DoorConfig, Kind, ServiceAuth};
use svc_bank::spaces::ports::{Ledger, LedgerAccount, LedgerBalance, Lookups, NoDirectory};
use svc_bank::spaces::shared::Terms;
use svc_bank::spaces::space::Rules;
use svc_bank::spaces::{Tables, Wiring as SpacesWiring};

use support::TestDb;

const SECRET: &str = "a-bank-portfolio-db-edge-secret-long-enough";
const INTERNAL: &str = "a-bank-portfolio-db-internal-secret-long-enough";
const ADA: &str = "11111111-1111-4111-8111-111111111111";
const BOB: &str = "22222222-2222-4222-8222-222222222222";
const DAY: i64 = 86_400_000;

fn amt(s: &str) -> Amount {
    parse_amount(s).unwrap()
}

// ---------------------------------------------------------------------------------------------------------------
// Stand-ins: svc-ledger's book and journal, its holdings history, svc-trade's tickers and candles.

/// One leg: tx id, owner type, owner id, asset, direction, amount, posted at.
type Leg = (String, String, String, String, &'static str, Amount, i64);
/// An account: owner type, owner id, asset, kind.
type Account = (String, String, String, String);

#[derive(Clone, Default)]
struct Book {
    /// (owner type, owner id, asset, kind) to amount.
    balances: Arc<Mutex<BTreeMap<Account, Amount>>>,
    journal: Arc<Mutex<Vec<Leg>>>,
}

impl Book {
    /// One leg on an owner's available account: a debit adds, a credit takes away (the book's convention).
    fn leg(
        &self,
        tx: &str,
        (owner_type, owner): (&str, &str),
        asset: &str,
        direction: &'static str,
        amount: &str,
        at: i64,
    ) {
        let a = amt(amount);
        let key = (
            owner_type.to_owned(),
            owner.to_owned(),
            asset.to_owned(),
            "available".to_owned(),
        );
        *self.balances.lock().unwrap().entry(key).or_default() +=
            if direction == "debit" { a } else { -a };
        self.journal.lock().unwrap().push((
            tx.to_owned(),
            owner_type.to_owned(),
            owner.to_owned(),
            asset.to_owned(),
            direction,
            a,
            at,
        ));
    }
    /// `recipes.deposit` into the person's main balance.
    fn deposit(&self, tx: &str, user: &str, asset: &str, amount: &str, at: i64) {
        self.leg(tx, ("user", user), asset, "debit", amount, at);
    }
    /// `bankTransfer`: one credit on the payer, one debit on the payee, under one transaction.
    fn transfer(
        &self,
        tx: &str,
        from: (&str, &str),
        to: (&str, &str),
        asset: &str,
        amount: &str,
        at: i64,
    ) {
        self.leg(tx, from, asset, "credit", amount, at);
        self.leg(tx, to, asset, "debit", amount, at);
    }
}

impl Ledger for Book {
    fn balance(&self, a: &LedgerAccount) -> Result<Amount, String> {
        Ok(self
            .balances
            .lock()
            .unwrap()
            .get(&(
                a.owner_type.to_owned(),
                a.owner_id.clone(),
                a.asset_id.clone(),
                a.kind.to_owned(),
            ))
            .copied()
            .unwrap_or(Amount::ZERO))
    }
    fn balances(&self, owner_type: &str, owner: &str) -> Result<Vec<LedgerBalance>, String> {
        Ok(self
            .balances
            .lock()
            .unwrap()
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
}

/// `historyPage` over the book's journal, newest first, one page.
impl HistoryPages for Book {
    fn page(&self, r: &PageRequest) -> Result<Page, String> {
        let mut entries: Vec<PageEntry> = self
            .journal
            .lock()
            .unwrap()
            .iter()
            .filter(|l| {
                l.1 == r.owner_type
                    && l.2 == r.owner_id
                    && r.asset_id.as_ref().is_none_or(|a| *a == l.3)
            })
            .map(|l| PageEntry {
                tx_id: l.0.clone(),
                module: "bank".to_owned(),
                reason: "bank.transfer.manual".to_owned(),
                direction: l.4.to_owned(),
                amount: l.5,
                posted_at: Instant(l.6),
                asset_id: l.3.clone(),
                entry_id: None,
                rail: None,
                product: None,
                order_id: None,
                withdrawal_id: None,
                fee: None,
            })
            .collect();
        entries.sort_by_key(|e| std::cmp::Reverse(e.posted_at.0));
        entries.truncate(r.limit);
        Ok(Page {
            entries,
            next_cursor: None,
        })
    }
}

/// svc-ledger's holdings history: nothing held, nothing moved; every read is kept.
#[derive(Clone, Default)]
struct History(Arc<Mutex<Vec<(String, String)>>>);

impl HoldingsHistory for History {
    fn holdings_history(
        &self,
        t: &str,
        id: &str,
        _: &str,
        _: i64,
    ) -> Result<Holdings, HistoryError> {
        self.0.lock().unwrap().push((t.to_owned(), id.to_owned()));
        Ok(Holdings::default())
    }
}

/// svc-trade at one BTC price.
struct Trade;

impl TickerSource for Trade {
    fn prices(&self) -> Result<PriceBook, String> {
        let q = TickerQuote {
            last: Some(amt("60000")),
            open: Some(amt("59000")),
            window_start: None,
        };
        Ok(PriceBook {
            tickers: HashMap::from([("BTC/USDT".to_owned(), q)]),
            listed: HashSet::from(["BTC/USDT".to_owned()]),
        })
    }
}

struct NoCandles;

impl CloseSource for NoCandles {
    fn closes(
        &self,
        _: &str,
        _: &str,
        _: Instant,
        _: Instant,
    ) -> Result<Option<CloseSeries>, String> {
        Ok(None)
    }
}

// ---------------------------------------------------------------------------------------------------------------
// The door and its calls

struct Bank {
    door: BankDoor,
    db: TestDb,
}

fn bank(db: TestDb, book: &Book, history: &History) -> Bank {
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
    .with_spaces(SpacesWiring {
        ledger: Box::new(book.clone()),
        directory: Box::new(NoDirectory),
        lookups: Lookups::default(),
        rules: Rules {
            space_limit: Some("10".to_owned()),
            unlock_wait_hours: None,
        },
        terms: Terms {
            invite_minutes: None,
            people_cap: None,
            card_programme: ("card-sim".to_owned(), true),
        },
        tables: Tables::default(),
    })
    .with_activity(activity::Wiring {
        entry_pages: Box::new(book.clone()),
        portfolio: activity::portfolio::Wiring {
            tickers: Box::new(Trade),
            history: Box::new(history.clone()),
            closes: Box::new(NoCandles),
        },
        ..activity::Wiring::none()
    });
    Bank { door, db }
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

/// One answer: the status and the body.
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
}

/// A call as the person.
fn call(b: &Bank, user: &str, path: &str, input: &str) -> Answer {
    let kind = door::call(path).map(|c| c.kind);
    let mut headers = person(user);
    let (method, url, body) = match kind {
        Some(Kind::Query) => (
            "GET",
            if input.is_empty() {
                format!("/trpc/{path}")
            } else {
                format!("/trpc/{path}?input={}", encode(input))
            },
            String::new(),
        ),
        _ => ("POST", format!("/trpc/{path}"), input.to_owned()),
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
        "req-portfolio-db",
        "127.0.0.1",
    );
    Answer(res.status, json::parse(&res.body).unwrap())
}

fn text(j: &Json, key: &str) -> String {
    match j.get(key) {
        Some(Json::String(s)) => s.clone(),
        Some(Json::Null) | None => "null".to_owned(),
        Some(other) => other.compact(),
    }
}

fn arr<'j>(j: &'j Json, key: &str) -> &'j [Json] {
    match j.get(key) {
        Some(Json::Array(a)) => a,
        other => panic!("{key} is not a list: {other:?}"),
    }
}

fn setup() -> Option<(Bank, Book, History)> {
    let db = TestDb::new()?;
    db.migrated();
    let book = Book::default();
    let history = History::default();
    Some((bank(db, &book, &history), book, history))
}

/// `spaces.create` as the person: the new Space's id.
fn create(b: &Bank, user: &str, asset: &str, name: &str) -> String {
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

fn now() -> i64 {
    door::system_now().0
}

// ---------------------------------------------------------------------------------------------------------------
// transfers/send-review.db.test.ts

#[test]
fn the_balance_page_names_each_personal_sends_fee_and_state_other_entries_fee_stays_unknown() {
    let Some((b, book, _)) = setup() else { return };
    let t = now();
    book.deposit("tx-deposit", ADA, "USDT", "100", t - 2 * DAY);
    book.transfer(
        "tx-send",
        ("user", ADA),
        ("user", BOB),
        "USDT",
        "20",
        t - DAY,
    );
    // The row `transfers.toUser` writes once the send is posted.
    b.db.client()
        .execute(
            "INSERT INTO bank.personal_transfers \
             (transfer_id, ledger_tx_id, from_user_id, from_space_id, to_user_id, asset_id, amount, status, posted_at) \
             VALUES ('fee-send-1', 'tx-send', $1, gen_random_uuid(), $2, 'USDT', 20, 'posted', now())",
            &[&ADA, &BOB],
        )
        .unwrap();

    let page = call(&b, ADA, "portfolio.balanceEntries", r#"{"assetId":"USDT"}"#).ok();
    let entries = arr(&page, "entries");
    let send = entries
        .iter()
        .find(|e| text(e, "txId") == "tx-send")
        .unwrap();
    let deposit = entries
        .iter()
        .find(|e| text(e, "txId") != "tx-send")
        .unwrap();
    assert_eq!(
        (text(send, "state"), text(send, "fee")),
        ("completed".to_owned(), "0".to_owned())
    );
    assert_eq!(
        (text(deposit, "state"), text(deposit, "fee")),
        ("completed".to_owned(), "null".to_owned())
    );
    assert_eq!(text(page.get("sumCheck").unwrap(), "balance"), "80");

    let bobs = call(&b, BOB, "portfolio.balanceEntries", r#"{"assetId":"USDT"}"#).ok();
    let entries = arr(&bobs, "entries");
    assert_eq!(entries.len(), 1);
    assert_eq!(
        (
            text(&entries[0], "txId"),
            text(&entries[0], "state"),
            text(&entries[0], "fee")
        ),
        ("tx-send".to_owned(), "completed".to_owned(), "0".to_owned())
    );
}

// ---------------------------------------------------------------------------------------------------------------
// portfolio/*.test.ts, against svc-bank's own Space table

#[test]
fn lists_the_wallet_selector_the_main_account_then_each_named_space_and_no_one_else() {
    let Some((b, _, _)) = setup() else { return };
    let savings = create(&b, ADA, "USDT", "Savings");
    create(&b, BOB, "USDT", "Bobs");
    let out = call(&b, ADA, "portfolio.balanceAccounts", "").ok();
    assert_eq!(
        out.compact(),
        format!(
            r#"{{"accounts":[{{"accountId":"main","walletType":"main","name":null}},{{"accountId":"{savings}","walletType":"space","name":"Savings"}}]}}"#
        )
    );
}

#[test]
fn counts_a_users_space_balances_free_and_locked_with_their_main_balance() {
    let Some((b, book, _)) = setup() else { return };
    let t = now();
    let holiday = create(&b, ADA, "BTC", "Holiday");
    let bobs = create(&b, BOB, "BTC", "Bobs");
    book.deposit("tx-1", ADA, "USDT", "100", t);
    book.deposit("tx-2", ADA, "BTC", "0.5", t);
    book.transfer(
        "tx-3",
        ("user", ADA),
        ("subaccount", &holiday),
        "BTC",
        "0.4",
        t,
    );
    book.deposit("tx-4", BOB, "BTC", "100", t);
    book.transfer(
        "tx-5",
        ("user", BOB),
        ("subaccount", &bobs),
        "BTC",
        "100",
        t,
    );
    let out = call(&b, ADA, "portfolio.summary", "").ok();
    // BTC 0.1 main + 0.4 in the Space = 0.5 at 60000; 100 USDT.
    assert_eq!(text(&out, "totalUsd"), "30100.00");
    assert_eq!(text(&out, "change24hUsd"), "500.00");
    let only_space = call(
        &b,
        ADA,
        "portfolio.summary",
        &format!(r#"{{"scope":"{holiday}"}}"#),
    )
    .ok();
    assert_eq!(text(&only_space, "totalUsd"), "24000.00");
}

#[test]
fn refuses_a_space_that_is_not_the_callers_without_reading_it() {
    let Some((b, _, _)) = setup() else { return };
    let bobs = create(&b, BOB, "USDT", "Bobs");
    let summary = call(
        &b,
        ADA,
        "portfolio.summary",
        &format!(r#"{{"scope":"{bobs}"}}"#),
    );
    assert_eq!(summary.trpc(), "NOT_FOUND");
    let breakdown = call(
        &b,
        ADA,
        "portfolio.balanceBreakdown",
        &format!(r#"{{"accountId":"{bobs}"}}"#),
    );
    assert_eq!(breakdown.trpc(), "NOT_FOUND");
    let entries = call(
        &b,
        ADA,
        "portfolio.balanceEntries",
        &format!(r#"{{"assetId":"USDT","accountId":"{bobs}"}}"#),
    );
    assert_eq!(entries.trpc(), "BAD_REQUEST");
}

#[test]
fn reads_the_callers_main_account_and_own_named_spaces_only_archived_ones_too() {
    let Some((b, _, history)) = setup() else {
        return;
    };
    let live = create(&b, ADA, "USDT", "Live");
    let closed = create(&b, ADA, "USDT", "Closed");
    call(
        &b,
        ADA,
        "spaces.archive",
        &format!(r#"{{"spaceId":"{closed}"}}"#),
    )
    .ok();
    let bobs = create(&b, BOB, "USDT", "Bobs");
    let from = Instant(now() - 2 * DAY).iso();
    let out = call(
        &b,
        ADA,
        "portfolio.valueOverTime",
        &format!(r#"{{"from":"{from}"}}"#),
    )
    .ok();
    // Two days is 576 five-minute points, over the 400 a series draws: hourly.
    assert_eq!(text(&out, "interval"), "1h");
    let mut asked = history.0.lock().unwrap().clone();
    asked.sort();
    let mut want = vec![
        ("subaccount".to_owned(), closed),
        ("subaccount".to_owned(), live),
        ("user".to_owned(), ADA.to_owned()),
    ];
    want.sort();
    assert_eq!(asked, want);
    assert!(!asked.iter().any(|(_, id)| *id == bobs));
    // The archived Space is left out of the wallet selector: it holds nothing.
    let accounts = call(&b, ADA, "portfolio.balanceAccounts", "").ok();
    assert_eq!(arr(&accounts, "accounts").len(), 2);
}
