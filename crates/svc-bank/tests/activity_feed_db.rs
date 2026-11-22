//! Part `feed` of slice `activity` against the Rust door on a real Postgres. Ports `activity-records.db.test.ts`,
//! `saved-filters.db.test.ts` and the checks of `activity-service`, `activity-browse`, `activity-filters` and
//! `activity-notes` `.test.ts` that go through the router (`createBankRouter(...).createCaller`), each named after the
//! TypeScript test's words. A router call is a door call here, with a stand-in svc-ledger history (the TypeScript's
//! fake: opaque `v2.<seq>` cursors, newest first) wired into the slice and the person's spaces as rows of
//! `bank.spaces`. The service-level checks of those suites are unit tests in `src/activity/feed/tests.rs`.
//!
//! Not ported, with the reason: `canonical form ignores key order, array order and absent keys` is a unit test in
//! `src/activity/feed/saved.rs` (it needs no database); the CSV checks of `activity-notes.test.ts` (`puts the
//! description in its own CSV column...`, `does not run a formula typed into a description`) are the statements
//! part's; `still derives the activity cursor key the unfiltered pages use` and `signs with an HKDF-derived key` are
//! unit tests in `src/activity/feed/cursor.rs`; `ledger-pages.test.ts` and `activity-test-fault.test.ts`'s
//! parse checks are `pages.rs`'s. The TypeScript's router-only stand-ins (`activity.get` answering an empty item to
//! `note.set`) are replaced by a real line in the stand-in ledger.
//!
//! Without `TEST_DATABASE_URL` each test skips; with `REQUIRE_POSTGRES=1` it fails.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::too_many_lines,
    clippy::too_many_arguments,
    reason = "a test: a failure is the point"
)]

use crate::support;

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use service_kit::edge;
use service_kit::json::{self, Json};
use service_kit::money::parse_amount;
use service_kit::s2s_verify::BodyBind;
use service_kit::server::Request;
use service_kit::time::Instant;
use support::TestDb;
use svc_bank::activity::feed::records::{self, StoreFeed};
use svc_bank::activity::feed::service::Records;
use svc_bank::activity::feed::{self as feed, kind};
use svc_bank::activity::pages::{HistoryPages, Page, PageEntry, PageRequest};
use svc_bank::activity::{self, Wiring};
use svc_bank::door::{self, BankDoor, DoorConfig, Kind, ServiceAuth};
use svc_bank::transfers::moves::{self, Message};

const SECRET: &str = "a-bank-activity-feed-db-edge-secret-long-enough";
const INTERNAL: &str = "a-bank-activity-feed-db-internal-secret-long-enough";
const ALICE: &str = "11111111-1111-4111-8111-111111111111";
const BOB: &str = "22222222-2222-4222-8222-222222222222";
const ALICE_SPACE: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const STRANGER_SPACE: &str = "44444444-4444-4444-8444-444444444444";
const RW: &[&str] = &["bank:read", "bank:write"];
/// 2026-10-13T00:00:00Z.
const OCT13: i64 = 1_791_849_600_000;

/// One posting in the stand-in book.
#[derive(Clone)]
struct Posted {
    owner_type: &'static str,
    owner_id: String,
    tx_id: String,
    module: String,
    reason: String,
    direction: String,
    amount: String,
    asset: String,
    seq: i64,
    order_id: Option<String>,
}

fn post(
    owner: (&'static str, &str),
    tx: &str,
    reason: &str,
    direction: &str,
    amount: &str,
    asset: &str,
    module: &str,
    seq: i64,
) -> Posted {
    Posted {
        owner_type: owner.0,
        owner_id: owner.1.to_owned(),
        tx_id: tx.to_owned(),
        module: module.to_owned(),
        reason: reason.to_owned(),
        direction: direction.to_owned(),
        amount: amount.to_owned(),
        asset: asset.to_owned(),
        seq,
        order_id: None,
    }
}

/// svc-ledger's `historyPage` as the TypeScript suites fake it; `down` fails every read.
#[derive(Clone, Default)]
struct Ledger {
    rows: Arc<Mutex<Vec<Posted>>>,
    asked: Arc<Mutex<Vec<PageRequest>>>,
    down: bool,
}

impl HistoryPages for Ledger {
    fn page(&self, r: &PageRequest) -> Result<Page, String> {
        self.asked.lock().unwrap().push(r.clone());
        if self.down {
            return Err("connect ECONNREFUSED 10.0.0.7:4002".to_owned());
        }
        let before = r.cursor.as_deref().map_or(i64::MAX, |c| {
            let text = String::from_utf8(URL_SAFE_NO_PAD.decode(c).unwrap()).unwrap();
            text[3..].parse().unwrap()
        });
        let mut mine: Vec<Posted> = self
            .rows
            .lock()
            .unwrap()
            .iter()
            .filter(|p| p.owner_type == r.owner_type && p.owner_id == r.owner_id && p.seq < before)
            .filter(|p| r.asset_id.as_ref().is_none_or(|a| *a == p.asset))
            .cloned()
            .collect();
        mine.sort_by_key(|p| std::cmp::Reverse(p.seq));
        let page: Vec<Posted> = mine.iter().take(r.limit).cloned().collect();
        let next = (mine.len() > r.limit)
            .then(|| URL_SAFE_NO_PAD.encode(format!("v2.{}", page.last().unwrap().seq)));
        Ok(Page {
            entries: page
                .into_iter()
                .map(|p| PageEntry {
                    tx_id: p.tx_id,
                    module: p.module,
                    reason: p.reason,
                    direction: p.direction,
                    amount: parse_amount(&p.amount).unwrap(),
                    posted_at: Instant(OCT13 + p.seq * 1000),
                    asset_id: p.asset,
                    entry_id: Some(p.seq.to_string()),
                    rail: None,
                    product: None,
                    order_id: p.order_id,
                    withdrawal_id: None,
                    fee: None,
                })
                .collect(),
            next_cursor: next,
        })
    }
}

fn db() -> Option<TestDb> {
    let db = TestDb::new()?;
    db.migrated();
    Some(db)
}

struct Bank {
    door: BankDoor,
    ledger: Ledger,
}

fn bank_with(db: &TestDb, ledger: Ledger, tax: Option<kind::TaxEffects>) -> Bank {
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
    .with_activity(Wiring {
        pages: Box::new(ledger.clone()),
        cursor_secret: Some(INTERNAL.to_owned()),
        feed: feed::Wiring {
            tax_effects: tax,
            pay: None,
        },
        ..Wiring::none()
    });
    Bank { door, ledger }
}

fn bank(db: &TestDb, rows: Vec<Posted>) -> Bank {
    bank_with(
        db,
        Ledger {
            rows: Arc::new(Mutex::new(rows)),
            ..Ledger::default()
        },
        None,
    )
}

fn named_space(db: &TestDb, id: &str, user: &str, name: &str) {
    db.client()
        .execute(
            "INSERT INTO bank.spaces (id, user_id, asset_id, kind, name) VALUES ($1::text::uuid, $2, 'USDT', 'named', $3)",
            &[&id, &user, &name],
        )
        .unwrap();
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
    fn cause(&self) -> Option<String> {
        match self
            .1
            .get("error")
            .and_then(|e| e.get("data"))
            .and_then(|d| d.get("cause"))
            .and_then(|c| c.get("code"))
        {
            Some(Json::String(c)) => Some(c.clone()),
            _ => None,
        }
    }
}

fn send(b: &Bank, path: &str, input: &str, headers: Vec<(String, String)>) -> Answer {
    let mut headers = headers;
    let (method, url, body) = match door::call(path).map(|c| c.kind) {
        Some(Kind::Query) => (
            "GET",
            format!("/trpc/{path}?input={}", encode(input)),
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
        "req-activity-feed-db",
        "127.0.0.1",
    );
    Answer(res.status, json::parse(&res.body).unwrap())
}

fn call(b: &Bank, user: &str, path: &str, input: &str) -> Answer {
    send(b, path, input, person(user, RW))
}

fn items(page: &Json) -> Vec<Json> {
    match page.get("items") {
        Some(Json::Array(a)) => a.clone(),
        other => panic!("no items: {other:?}"),
    }
}

fn s(j: &Json, key: &str) -> String {
    match j.get(key) {
        Some(Json::String(v)) => v.clone(),
        Some(Json::Null) | None => "null".to_owned(),
        Some(other) => other.compact(),
    }
}

fn txs(page: &Json) -> Vec<String> {
    items(page).iter().map(|i| s(i, "txId")).collect()
}

// ── activity.list through the door (activity-service.test.ts) ───────────────────

fn feed_rows() -> Vec<Posted> {
    vec![
        post(
            ("user", ALICE),
            "a-dep",
            "deposit.credited",
            "debit",
            "100",
            "USDT",
            "ledger",
            1,
        ),
        post(
            ("subaccount", ALICE_SPACE),
            "a-sp",
            "bank.transfer.manual",
            "debit",
            "7",
            "USDT",
            "bank",
            2,
        ),
        post(
            ("user", BOB),
            "b-dep",
            "deposit.credited",
            "debit",
            "999999",
            "USDT",
            "ledger",
            3,
        ),
    ]
}

#[test]
fn returns_the_signed_in_users_feed_test_data_shaped_as_the_contract_says() {
    let Some(db) = db() else { return };
    named_space(&db, ALICE_SPACE, ALICE, "Holiday");
    let b = bank(&db, feed_rows());
    let out = call(&b, ALICE, "activity.list", r#"{"limit":10}"#).ok();
    assert_eq!(s(&out, "nextCursor"), "null");
    let shape: Vec<Vec<String>> = items(&out)
        .iter()
        .map(|i| {
            [
                "txId",
                "kind",
                "direction",
                "amount",
                "asset",
                "spaceName",
                "counterparty",
            ]
            .iter()
            .map(|k| s(i, k))
            .collect()
        })
        .collect();
    assert_eq!(
        shape,
        vec![
            vec!["a-sp", "transfer_in", "in", "7", "USDT", "Holiday", "null"],
            vec!["a-dep", "deposit", "in", "100", "USDT", "null", "null"],
        ]
    );
    assert_eq!(
        items(&out)[1].compact(),
        r#"{"id":"a-dep:u:USDT:in","kind":"deposit","direction":"in","asset":"USDT","amount":"100","postedAt":"2026-10-13T00:00:01.000Z","txId":"a-dep","counterparty":null,"spaceName":null}"#
    );
}

#[test]
fn is_self_only_bob_sees_his_own_and_no_input_can_name_another_user_or_owner() {
    let Some(db) = db() else { return };
    named_space(&db, ALICE_SPACE, ALICE, "Holiday");
    let b = bank(&db, feed_rows());
    assert_eq!(
        txs(&call(&b, BOB, "activity.list", r#"{"limit":10}"#).ok()),
        vec!["b-dep"]
    );
    let asked: Vec<String> = b
        .ledger
        .asked
        .lock()
        .unwrap()
        .iter()
        .map(|a| a.owner_id.clone())
        .collect();
    assert_eq!(asked, vec![BOB.to_owned()]);
    let smuggled = call(
        &b,
        ALICE,
        "activity.list",
        &format!(r#"{{"limit":10,"userId":"{BOB}"}}"#),
    );
    assert_eq!(smuggled.trpc(), "BAD_REQUEST");
    let owner = call(
        &b,
        ALICE,
        "activity.list",
        &format!(r#"{{"limit":10,"ownerId":"{ALICE_SPACE}","ownerType":"subaccount"}}"#),
    );
    assert_eq!(owner.trpc(), "BAD_REQUEST");
}

#[test]
fn refuses_an_anonymous_caller_and_a_token_without_bank_read_and_reads_nothing() {
    let Some(db) = db() else { return };
    let b = bank(&db, feed_rows());
    let anon = send(
        &b,
        "activity.list",
        r#"{"limit":5}"#,
        vec![("x-intafaced-region".to_owned(), "DE".to_owned())],
    );
    assert_eq!(anon.trpc(), "UNAUTHORIZED");
    let scoped = send(
        &b,
        "activity.list",
        r#"{"limit":5}"#,
        person(ALICE, &["trade:read"]),
    );
    assert_eq!(scoped.trpc(), "FORBIDDEN");
    assert!(b.ledger.asked.lock().unwrap().is_empty());
}

#[test]
fn a_forged_cursor_is_bad_request_another_users_real_cursor_is_too() {
    let Some(db) = db() else { return };
    named_space(&db, ALICE_SPACE, ALICE, "Holiday");
    let b = bank(&db, feed_rows());
    let forged = call(
        &b,
        ALICE,
        "activity.list",
        r#"{"limit":1,"cursor":"forged.value"}"#,
    );
    assert_eq!(forged.trpc(), "BAD_REQUEST");
    assert_eq!(
        forged.message(),
        "Activity cursor is not valid, start again without a cursor"
    );
    let first = call(&b, ALICE, "activity.list", r#"{"limit":1}"#).ok();
    let cursor = s(&first, "nextCursor");
    assert_ne!(cursor, "null");
    let theirs = call(
        &b,
        BOB,
        "activity.list",
        &format!(r#"{{"limit":1,"cursor":"{cursor}"}}"#),
    );
    assert_eq!(theirs.trpc(), "BAD_REQUEST");
}

#[test]
fn limit_is_1_to_200() {
    let Some(db) = db() else { return };
    let b = bank(&db, feed_rows());
    assert_eq!(
        call(&b, ALICE, "activity.list", r#"{"limit":0}"#).trpc(),
        "BAD_REQUEST"
    );
    assert_eq!(
        call(&b, ALICE, "activity.list", r#"{"limit":201}"#).trpc(),
        "BAD_REQUEST"
    );
}

#[test]
fn empty_history_is_an_empty_feed() {
    let Some(db) = db() else { return };
    let b = bank(&db, vec![]);
    assert_eq!(
        call(&b, ALICE, "activity.list", r#"{"limit":10}"#)
            .ok()
            .compact(),
        r#"{"items":[],"nextCursor":null}"#
    );
}

#[test]
fn ledger_down_is_service_unavailable_with_no_internals_in_the_message() {
    let Some(db) = db() else { return };
    let b = bank_with(
        &db,
        Ledger {
            down: true,
            ..Ledger::default()
        },
        None,
    );
    let a = call(&b, ALICE, "activity.list", r#"{"limit":5}"#);
    assert_eq!((a.0, a.trpc().as_str()), (503, "SERVICE_UNAVAILABLE"));
    assert!(!a.message().contains("ECONNREFUSED"));
}

#[test]
fn is_optional_on_the_wire_the_router_returns_order_id_when_present_and_omits_the_key_when_not() {
    let Some(db) = db() else { return };
    let mut fill = post(
        ("user", ALICE),
        "tx-fill",
        "trade.fill",
        "debit",
        "0.5",
        "BTC",
        "trade",
        1,
    );
    fill.order_id = Some("c1111111-1111-4111-8111-c11111111111".to_owned());
    let dep = post(
        ("user", ALICE),
        "tx-dep",
        "deposit.credited",
        "debit",
        "5",
        "USDT",
        "ledger",
        2,
    );
    let b = bank(&db, vec![fill, dep]);
    let out = call(&b, ALICE, "activity.list", r#"{"limit":50}"#).ok();
    let by = |tx: &str| {
        items(&out)
            .into_iter()
            .find(|i| s(i, "txId") == tx)
            .unwrap()
    };
    assert_eq!(
        s(&by("tx-fill"), "orderId"),
        "c1111111-1111-4111-8111-c11111111111"
    );
    assert!(by("tx-dep").get("orderId").is_none());
}

// ── Browse, filters and notes over the router ───────────────────────────────────

#[test]
fn names_the_typed_code_when_a_tax_year_is_asked_for() {
    let Some(db) = db() else { return };
    let b = bank(&db, feed_rows());
    let a = call(&b, ALICE, "activity.list", r#"{"taxYear":2026}"#);
    assert_eq!(a.trpc(), "PRECONDITION_FAILED");
    assert!(a.message().contains("portfolio.tax_year_start_unset"));
    assert_eq!(a.cause().as_deref(), Some("portfolio.tax_year_start_unset"));
}

#[test]
fn serves_sort_account_and_year_and_rejects_an_account_that_is_neither_main_nor_an_id() {
    let Some(db) = db() else { return };
    let rows = vec![
        post(
            ("user", ALICE),
            "tx-1",
            "bank.earn.interest",
            "debit",
            "1",
            "USDT",
            "bank",
            1,
        ),
        post(
            ("user", ALICE),
            "tx-2",
            "bank.transfer.manual",
            "debit",
            "1",
            "USDT",
            "bank",
            2,
        ),
    ];
    let b = bank(&db, rows);
    assert_eq!(
        txs(&call(&b, ALICE, "activity.list", r#"{"sort":"asc"}"#).ok()),
        vec!["tx-1", "tx-2"]
    );
    assert_eq!(
        items(
            &call(
                &b,
                ALICE,
                "activity.list",
                r#"{"accountId":"main","year":2026}"#
            )
            .ok()
        )
        .len(),
        2
    );
    let earn = call(&b, ALICE, "activity.list", r#"{"kind":["earn"]}"#).ok();
    assert_eq!(
        items(&earn)
            .iter()
            .map(|i| s(i, "kind"))
            .collect::<Vec<_>>(),
        vec!["earn"]
    );
    assert_eq!(
        call(
            &b,
            ALICE,
            "activity.list",
            r#"{"accountId":"someone-elses"}"#
        )
        .trpc(),
        "BAD_REQUEST"
    );
    let stranger = call(
        &b,
        ALICE,
        "activity.list",
        &format!(r#"{{"accountId":"{STRANGER_SPACE}"}}"#),
    );
    assert_eq!(
        (stranger.trpc().as_str(), stranger.cause().as_deref()),
        ("NOT_FOUND", Some("bank.activity_account_unknown"))
    );
}

#[test]
fn links_a_purchase_to_the_asset_history_and_a_sale_to_nothing() {
    let Some(db) = db() else { return };
    let rows = vec![
        post(
            ("user", ALICE),
            "tx-buy",
            "trade.fill",
            "debit",
            "1",
            "BTC",
            "trade",
            3,
        ),
        post(
            ("user", ALICE),
            "tx-sell",
            "trade.fill",
            "debit",
            "1",
            "USDT",
            "trade",
            4,
        ),
        post(
            ("user", ALICE),
            "tx-odd",
            "trade.fill",
            "debit",
            "1",
            "..",
            "trade",
            5,
        ),
    ];
    let b = bank(&db, rows);
    let list = call(&b, ALICE, "activity.list", r#"{"limit":20}"#).ok();
    let page_of = |tx: &str| {
        let line = items(&list)
            .into_iter()
            .find(|i| s(i, "txId") == tx)
            .unwrap();
        s(
            &call(
                &b,
                ALICE,
                "activity.get",
                &format!(r#"{{"id":"{}"}}"#, s(&line, "id")),
            )
            .ok(),
            "assetPage",
        )
    };
    assert_eq!(page_of("tx-buy"), "/coin/BTC");
    assert_eq!(page_of("tx-sell"), "null");
    // never builds a link from an asset id that is not a plain code
    assert_eq!(page_of("tx-odd"), "null");
}

#[test]
fn refuses_a_missing_id_and_serves_get_through_the_router() {
    let Some(db) = db() else { return };
    let mut trade = post(
        ("user", ALICE),
        "tx-trade",
        "trade.fill",
        "debit",
        "2",
        "USDT",
        "trade",
        4,
    );
    trade.order_id = Some("ord-9".to_owned());
    let rows = vec![
        post(
            ("user", ALICE),
            "tx-fee",
            "fee.charged",
            "credit",
            "0.10",
            "USDT",
            "ledger",
            1,
        ),
        post(
            ("user", ALICE),
            "tx-in",
            "bank.transfer.manual",
            "debit",
            "10",
            "USDT",
            "bank",
            2,
        ),
        trade,
    ];
    let b = bank(&db, rows);
    let missing = call(&b, ALICE, "activity.get", r#"{"id":"missing"}"#);
    assert_eq!(missing.trpc(), "NOT_FOUND");
    assert_eq!(
        missing.message(),
        "That transaction is not in your activity (bank.activity_not_found)"
    );
    let listed = call(
        &b,
        ALICE,
        "activity.list",
        r#"{"limit":10,"kind":["trade"]}"#,
    )
    .ok();
    assert_eq!(items(&listed).len(), 1);
    let detail = call(
        &b,
        ALICE,
        "activity.get",
        &format!(r#"{{"id":"{}"}}"#, s(&items(&listed)[0], "id")),
    )
    .ok();
    assert_eq!(s(detail.get("item").unwrap(), "kind"), "trade");
    assert_eq!(
        detail.get("lines").map(|l| match l {
            Json::Array(a) => a.len(),
            _ => 0,
        }),
        Some(1)
    );
    assert_eq!(s(&detail, "complete"), "true");
    let order = call(&b, ALICE, "activity.get", r#"{"id":"order:ord-9"}"#).ok();
    assert_eq!(s(order.get("item").unwrap(), "orderId"), "ord-9");
}

#[test]
fn refuses_the_tax_effect_view_while_the_owner_has_not_set_the_effect_of_each_kind() {
    let Some(db) = db() else { return };
    let b = bank(&db, vec![]);
    let a = call(&b, ALICE, "activity.taxEffects", "{}");
    assert_eq!(a.trpc(), "PRECONDITION_FAILED");
    assert_eq!(
        a.message(),
        "The tax effect of each kind of line is not set (portfolio.tax_effect_map_unset)"
    );
}

#[test]
fn answers_the_test_map_labelled_test_when_the_test_stack_chose_it() {
    let Some(db) = db() else { return };
    let tax = kind::tax_effects_for("test", Some("test"), None, &kind::OWNER_TAX_EFFECTS).unwrap();
    let b = bank_with(&db, Ledger::default(), tax);
    let out = call(&b, ALICE, "activity.taxEffects", "{}").ok();
    assert_eq!(s(&out, "label"), "TEST");
    let effects = out.get("effects").unwrap();
    assert_eq!(s(effects, "trade"), "disposal");
    assert_eq!(s(effects, "earn"), "income");
    assert!(
        out.compact()
            .starts_with(r#"{"effects":{"deposit":"neutral","welcome_funds":"income","#)
    );
}

#[test]
fn takes_a_description_alone_and_refuses_a_write_with_neither_a_note_nor_a_description() {
    let Some(db) = db() else { return };
    let b = bank(
        &db,
        vec![post(
            ("user", ALICE),
            "tx-1",
            "bank.transfer.manual",
            "credit",
            "1",
            "USDT",
            "bank",
            1,
        )],
    );
    let line = "tx-1:u:USDT:out";
    let out = call(
        &b,
        ALICE,
        "activity.note.set",
        &format!(
            r#"{{"id":"{line}","reportDescription":"Office rent","commandId":"cmd-00000001"}}"#
        ),
    )
    .ok();
    assert_eq!(s(&out, "text"), "null");
    assert_eq!(s(&out, "reportDescription"), "Office rent");
    assert_eq!(s(&out, "activityId"), line);
    let neither = call(
        &b,
        ALICE,
        "activity.note.set",
        &format!(r#"{{"id":"{line}","commandId":"cmd-00000002"}}"#),
    );
    assert_eq!(neither.trpc(), "BAD_REQUEST");
    assert_eq!(
        db.count("SELECT count(*) FROM bank.activity_note_commands"),
        1
    );
    // The line now carries it in the feed.
    let listed = call(&b, ALICE, "activity.list", "{}").ok();
    assert_eq!(s(&items(&listed)[0], "reportDescription"), "Office rent");
    // A line that is not in the person's activity takes no note.
    let stranger = call(
        &b,
        ALICE,
        "activity.note.set",
        r#"{"id":"tx-9:u:USDT:out","text":"x","commandId":"cmd-00000003"}"#,
    );
    assert_eq!(stranger.trpc(), "NOT_FOUND");
}

#[test]
fn a_note_or_a_dispute_on_an_order_id_answers_as_activity_failure_answers_a_thrown_trpc_error() {
    let Some(db) = db() else { return };
    let b = bank(&db, vec![]);
    let note = call(
        &b,
        ALICE,
        "activity.note.set",
        r#"{"id":"order:o-1","text":"x","commandId":"cmd-00000001"}"#,
    );
    assert_eq!(
        (note.0, note.message().as_str(), note.cause().as_deref()),
        (
            500,
            "Something went wrong. Please try again.",
            Some("BAD_REQUEST")
        )
    );
    let dispute = call(
        &b,
        ALICE,
        "activity.dispute.open",
        r#"{"id":"order:o-1","reason":"x","disputeId":"44444444-4444-4444-8444-444444444444"}"#,
    );
    assert_eq!(
        (dispute.0, dispute.cause().as_deref()),
        (500, Some("BAD_REQUEST"))
    );
    assert!(b.ledger.asked.lock().unwrap().is_empty());
}

#[test]
fn opens_one_dispute_on_a_line_through_the_router_and_shows_it_on_the_line() {
    let Some(db) = db() else { return };
    let b = bank(
        &db,
        vec![post(
            ("user", ALICE),
            "tx-1",
            "bank.transfer.manual",
            "credit",
            "1",
            "USDT",
            "bank",
            1,
        )],
    );
    let id = "44444444-4444-4444-8444-444444444444";
    let input =
        format!(r#"{{"id":"tx-1:u:USDT:out","reason":"I did not send this","disputeId":"{id}"}}"#);
    let opened = call(&b, ALICE, "activity.dispute.open", &input).ok();
    assert_eq!(s(&opened, "status"), "open");
    assert_eq!(s(&opened, "disputeId"), id);
    assert_eq!(
        call(&b, ALICE, "activity.dispute.open", &input).ok(),
        opened
    );
    let line = &items(&call(&b, ALICE, "activity.list", "{}").ok())[0];
    assert_eq!(
        line.get("dispute").unwrap().compact(),
        format!(r#"{{"id":"{id}","status":"open","reason":"I did not send this"}}"#)
    );
}

// ── activity-records.db.test.ts ─────────────────────────────────────────────────

fn code(e: feed::FeedError) -> String {
    match e {
        feed::FeedError::Bank(b) => b.row.code.to_owned(),
        other => format!("{other:?}"),
    }
}

#[test]
fn stores_a_report_description_beside_the_note_keeps_what_a_write_leaves_out_and_replays_one_press_once()
 {
    let Some(db) = db() else { return };
    let store = db.store();
    let line = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb:u:USDT:out";
    let tx = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    assert_eq!(
        code(records::set_note(&store, ALICE, line, None, None, "desc-cmd-0000").unwrap_err()),
        "bank.activity_note_empty"
    );
    let first = records::set_note(
        &store,
        ALICE,
        line,
        None,
        Some("Office rent"),
        "desc-cmd-0001",
    )
    .unwrap();
    assert_eq!(
        (first.text.as_deref(), first.report_description.as_deref()),
        (None, Some("Office rent"))
    );
    let replay = records::set_note(
        &store,
        ALICE,
        line,
        None,
        Some("Office rent"),
        "desc-cmd-0001",
    )
    .unwrap();
    assert_eq!(replay.updated_at, first.updated_at);
    assert_eq!(
        code(
            records::set_note(
                &store,
                ALICE,
                line,
                None,
                Some("Different"),
                "desc-cmd-0001"
            )
            .unwrap_err()
        ),
        "bank.activity_note_conflict"
    );
    let both = records::set_note(&store, ALICE, line, Some("rent"), None, "desc-cmd-0002").unwrap();
    assert_eq!(
        (both.text.as_deref(), both.report_description.as_deref()),
        (Some("rent"), Some("Office rent"))
    );
    let refs = [(line.to_owned(), tx.to_owned())];
    let read = StoreFeed(&store).for_items(ALICE, &refs).unwrap();
    let a = &read[line];
    assert_eq!(
        (a.private_note.as_deref(), a.report_description.as_deref()),
        (Some("rent"), Some("Office rent"))
    );
    assert!(
        !StoreFeed(&store)
            .for_items(BOB, &refs)
            .unwrap()
            .contains_key(line)
    );
}

#[test]
fn replays_a_note_keeps_one_open_dispute_and_shows_a_transfer_note_to_both_parties() {
    let Some(db) = db() else { return };
    let store = db.store();
    let line = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:u:USDT:out";
    let note = records::set_note(&store, ALICE, line, Some("rent"), None, "note-cmd-0001").unwrap();
    assert_eq!(note.text.as_deref(), Some("rent"));
    assert_eq!(
        records::set_note(&store, ALICE, line, Some("rent"), None, "note-cmd-0001")
            .unwrap()
            .updated_at,
        note.updated_at
    );
    assert_eq!(
        code(
            records::set_note(&store, ALICE, line, Some("other"), None, "note-cmd-0001")
                .unwrap_err()
        ),
        "bank.activity_note_conflict"
    );

    let dispute = "44444444-4444-4444-8444-444444444444";
    let opened =
        records::open_dispute(&store, ALICE, line, "I did not send this", dispute).unwrap();
    assert_eq!(opened.dispute_id, dispute);
    assert_eq!(
        records::open_dispute(&store, ALICE, line, "I did not send this", dispute)
            .unwrap()
            .created_at,
        opened.created_at
    );
    assert_eq!(
        code(
            records::open_dispute(
                &store,
                ALICE,
                line,
                "different",
                "55555555-5555-4555-8555-555555555555"
            )
            .unwrap_err()
        ),
        "bank.activity_dispute_exists"
    );
    assert_eq!(
        code(records::open_dispute(&store, ALICE, line, "another reason", dispute).unwrap_err()),
        "bank.activity_dispute_conflict"
    );

    let b = bank(&db, vec![]);
    let message = |note: &'static str| Message {
        transfer_id: "transfer-0001",
        key_space: "manual",
        from_user_id: ALICE,
        to_user_id: BOB,
        note: Some(note),
        reference: Some("LUNCH"),
    };
    b.door
        .transfers_deps(|d| moves::bind_message(d, &message("for lunch"), &|_| Ok(false)))
        .unwrap();
    b.door
        .transfers_deps(|d| moves::attach_message_tx(d, "transfer-0001", "tx-lunch"))
        .unwrap();
    let changed = b
        .door
        .transfers_deps(|d| moves::bind_message(d, &message("changed"), &|_| Ok(true)));
    assert!(
        matches!(changed, Err(svc_bank::errors::Refusal::Bank(e)) if e.row.code == "bank.transfer_message_conflict")
    );

    let alice = StoreFeed(&store)
        .for_items(ALICE, &[(line.to_owned(), "tx-lunch".to_owned())])
        .unwrap();
    let bob = StoreFeed(&store)
        .for_items(BOB, &[("other-line".to_owned(), "tx-lunch".to_owned())])
        .unwrap();
    assert_eq!(alice[line].note.as_deref(), Some("for lunch"));
    assert_eq!(alice[line].private_note.as_deref(), Some("rent"));
    assert_eq!(bob["other-line"].note.as_deref(), Some("for lunch"));
    assert_eq!(bob["other-line"].private_note, None);
    assert_eq!(bob["other-line"].dispute, None);
}

#[test]
fn names_the_crypto_address_of_a_withdrawal_by_each_of_its_ledger_transactions_for_its_owner_only()
{
    let Some(db) = db() else { return };
    let store = db.store();
    let address = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";
    db.client()
        .execute(
            "INSERT INTO bank.ramp_offramps (user_id, asset_id, amount, kind, rail, destination_ref, client_ref, status, hold_ledger_tx_id, settle_ledger_tx_id) \
             VALUES ($1, 'USDT', 5, 'crypto', 'test', $2, 'wd-address-1', 'settled', 'tx-hold-1', 'tx-settle-1')",
            &[&ALICE, &address],
        )
        .unwrap();
    let ids = |v: &[&str]| v.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>();
    let found = StoreFeed(&store)
        .addresses_for(ALICE, &ids(&["tx-hold-1", "tx-settle-1", "tx-other"]))
        .unwrap();
    assert_eq!(
        found.into_iter().collect::<Vec<_>>(),
        vec![
            ("tx-hold-1".to_owned(), address.to_owned()),
            ("tx-settle-1".to_owned(), address.to_owned())
        ]
    );
    assert!(
        StoreFeed(&store)
            .addresses_for(BOB, &ids(&["tx-hold-1"]))
            .unwrap()
            .is_empty()
    );
    assert!(
        StoreFeed(&store)
            .addresses_for(ALICE, &[])
            .unwrap()
            .is_empty()
    );
}

// ── saved-filters.db.test.ts ────────────────────────────────────────────────────

const FILTER: &str = r#"{"kind":["deposit"],"direction":"in","minAmount":"10"}"#;
const OWNER: &str = ALICE;
const OTHER: &str = BOB;

fn save(b: &Bank, user: &str, scopes: &[&str], name: &str, filter: &str) -> Answer {
    send(
        b,
        "activity.savedFilters.save",
        &format!(r#"{{"name":"{name}","filter":{filter}}}"#),
        person(user, scopes),
    )
}

#[test]
fn saves_lists_and_removes_a_filter_and_the_list_is_self_only() {
    let Some(db) = db() else { return };
    let b = bank(&db, vec![]);
    let saved = save(&b, OWNER, RW, "TEST big deposits", FILTER).ok();
    assert_eq!(s(&saved, "name"), "TEST big deposits");
    assert_eq!(saved.get("filter").unwrap().compact(), FILTER);
    assert_eq!(s(&saved, "replayed"), "false");
    let keys: Vec<&str> = match &saved {
        Json::Object(f) => f.iter().map(|(k, _)| k.as_str()).collect(),
        _ => vec![],
    };
    assert_eq!(keys, vec!["name", "filter", "createdAt", "replayed"]);
    let mine = call(&b, OWNER, "activity.savedFilters.list", r#"{"limit":10}"#).ok();
    match &mine {
        Json::Array(rows) => {
            assert_eq!(rows.len(), 1);
            assert_eq!(s(&rows[0], "name"), "TEST big deposits");
            assert_eq!(rows[0].get("filter").unwrap().compact(), FILTER);
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(
        call(&b, OTHER, "activity.savedFilters.list", r#"{"limit":10}"#)
            .ok()
            .compact(),
        "[]"
    );
    save(&b, OTHER, RW, "TEST big deposits", r#"{"direction":"out"}"#).ok();
    let gone = call(
        &b,
        OTHER,
        "activity.savedFilters.remove",
        r#"{"name":"TEST big deposits"}"#,
    )
    .ok();
    assert_eq!(gone.compact(), r#"{"deleted":true}"#);
    match call(&b, OWNER, "activity.savedFilters.list", r#"{"limit":10}"#).ok() {
        Json::Array(rows) => assert_eq!(rows.len(), 1),
        other => panic!("{other:?}"),
    }
    assert_eq!(
        call(
            &b,
            OWNER,
            "activity.savedFilters.remove",
            r#"{"name":"TEST big deposits"}"#
        )
        .ok()
        .compact(),
        r#"{"deleted":true}"#
    );
    assert_eq!(
        call(
            &b,
            OWNER,
            "activity.savedFilters.remove",
            r#"{"name":"TEST big deposits"}"#
        )
        .ok()
        .compact(),
        r#"{"deleted":false}"#
    );
}

#[test]
fn the_same_name_and_filter_replays_the_same_name_with_another_filter_conflicts() {
    let Some(db) = db() else { return };
    let b = bank(&db, vec![]);
    save(&b, OWNER, RW, "TEST mine", FILTER).ok();
    let again = save(
        &b,
        OWNER,
        RW,
        "TEST mine",
        r#"{"minAmount":"10","direction":"in","kind":["deposit"]}"#,
    )
    .ok();
    assert_eq!(s(&again, "replayed"), "true");
    let conflict = save(&b, OWNER, RW, "TEST mine", r#"{"direction":"out"}"#);
    assert_eq!(conflict.trpc(), "CONFLICT");
    assert_eq!(
        conflict.message(),
        "A saved filter with that name already holds a different filter (bank.activity_filter_conflict)"
    );
    assert_eq!(
        db.count("SELECT count(*) FROM bank.activity_saved_filters"),
        1
    );
}

#[test]
fn refuses_a_blank_name_an_empty_filter_an_unknown_filter_key_and_a_missing_page_size() {
    let Some(db) = db() else { return };
    let b = bank(&db, vec![]);
    assert_eq!(save(&b, OWNER, RW, "   ", FILTER).trpc(), "BAD_REQUEST");
    let empty = save(&b, OWNER, RW, "TEST empty", "{}");
    assert_eq!(
        (empty.trpc().as_str(), empty.cause().as_deref()),
        ("BAD_REQUEST", Some("bank.activity_filter_empty"))
    );
    let smuggled = save(
        &b,
        OWNER,
        RW,
        "TEST smuggle",
        &format!(r#"{{"kind":["deposit"],"direction":"in","minAmount":"10","userId":"{OTHER}"}}"#),
    );
    assert_eq!(smuggled.trpc(), "BAD_REQUEST");
    assert_eq!(
        save(&b, OWNER, RW, &"x".repeat(61), FILTER).trpc(),
        "BAD_REQUEST"
    );
    let unset = call(&b, OWNER, "activity.savedFilters.list", "{}");
    assert_eq!(
        (unset.trpc().as_str(), unset.message().as_str()),
        (
            "BAD_REQUEST",
            "Saved filter page size is required; blank is not 50 (bank.activity_filter_limit_unset)"
        )
    );
    assert_eq!(
        db.count("SELECT count(*) FROM bank.activity_saved_filters"),
        0
    );
}

#[test]
fn a_read_only_principal_cannot_save_or_remove() {
    let Some(db) = db() else { return };
    let b = bank(&db, vec![]);
    assert_eq!(
        save(&b, OWNER, &["bank:read"], "TEST ro", FILTER).trpc(),
        "FORBIDDEN"
    );
    let remove = send(
        &b,
        "activity.savedFilters.remove",
        r#"{"name":"TEST ro"}"#,
        person(OWNER, &["bank:read"]),
    );
    assert_eq!(remove.trpc(), "FORBIDDEN");
}

#[test]
fn the_statements_collect_reads_the_range_through_the_doors_own_wiring() {
    let Some(db) = db() else { return };
    let rows: Vec<Posted> = (1..=5)
        .map(|i| {
            post(
                ("user", ALICE),
                &format!("tx-{i}"),
                "deposit.credited",
                "debit",
                "1",
                "USDT",
                "ledger",
                i,
            )
        })
        .collect();
    let b = bank(&db, rows);
    let got = b
        .door
        .activity_deps(Instant(OCT13), |d| {
            feed::collect(
                d,
                ALICE,
                feed::CollectQuery {
                    from: Instant(OCT13 + 2000).iso(),
                    to: Instant(OCT13 + 4000).iso(),
                    limit: 10,
                    ..feed::CollectQuery::default()
                },
            )
        })
        .unwrap();
    assert_eq!(
        got.iter().map(|i| i.tx_id.as_str()).collect::<Vec<_>>(),
        vec!["tx-4", "tx-3", "tx-2"]
    );
    let _ = activity::Wiring::none();
}
