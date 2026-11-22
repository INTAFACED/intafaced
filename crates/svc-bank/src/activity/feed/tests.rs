//! The TypeScript's service tests of the feed (`activity-service`, `activity-browse`, `activity-filters`,
//! `activity-notes` (its feed checks), `activity-detail-boundary` and the fault's list check of `activity-test-fault`),
//! each named after the TypeScript test's words, against the same fake ledger: opaque `v2.<seq>` cursors, newest first,
//! one row past the page for the next cursor, every request recorded.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::too_many_lines,
    clippy::too_many_arguments,
    clippy::type_complexity,
    reason = "a test: a failure is the point"
)]

use std::collections::BTreeMap;
use std::sync::Mutex;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use service_kit::money::{Amount, format_amount, parse_amount};
use service_kit::time::{Instant, js_date};

use super::cursor::{self, Body, Pos};
use super::service::*;
use super::{failure, kind};
use crate::activity::pages::{
    FailingPages, HistoryPages, Page as LedgerPage, PageEntry, PageRequest,
};
use crate::db::StoreError;
use crate::partner::{Move, MovesQuery};

const SECRET: &str = "a-bank-activity-test-cursor-secret-long-enough";
const ALICE: &str = "11111111-1111-4111-8111-111111111111";
const BOB: &str = "22222222-2222-4222-8222-222222222222";
const ALICE_SPACE: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BOB_SPACE: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

/// One posting in the fake book.
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
    at: i64,
    rail: Option<String>,
    order_id: Option<Option<String>>,
    fee: Option<Option<String>>,
    withdrawal_id: Option<String>,
    /// Sent the entry id though the ledger is not in entry-id mode (the browse and filter suites' fakes).
    entry_id: bool,
}

/// 2026-10-13T00:00:00Z: the service suite's day.
const OCT13: i64 = 1_791_849_600_000;
/// 2026-10-01T00:00:00Z.
const OCT1: i64 = 1_790_812_800_000;

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
        at: OCT13 + seq * 1000,
        rail: None,
        order_id: None,
        fee: None,
        withdrawal_id: None,
        entry_id: false,
    }
}

fn user(id: &str) -> (&'static str, &str) {
    ("user", id)
}

fn sub(id: &str) -> (&'static str, &str) {
    ("subaccount", id)
}

/// The fake svc-ledger `historyPage`.
struct Fake {
    rows: Mutex<Vec<Posted>>,
    entry_ids: bool,
    asked: Mutex<Vec<PageRequest>>,
}

fn fake(rows: Vec<Posted>, entry_ids: bool) -> Fake {
    Fake {
        rows: Mutex::new(rows),
        entry_ids,
        asked: Mutex::new(Vec::new()),
    }
}

fn b64(s: &str) -> String {
    URL_SAFE_NO_PAD.encode(s)
}

fn seq_of(cursor: &str) -> i64 {
    let text = String::from_utf8(cursor::b64url_lenient(cursor)).unwrap();
    text[3..].parse().unwrap()
}

impl HistoryPages for Fake {
    fn page(&self, r: &PageRequest) -> Result<LedgerPage, String> {
        self.asked.lock().unwrap().push(r.clone());
        let before = r.cursor.as_deref().map_or(i64::MAX, seq_of);
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
        let next = (mine.len() > r.limit).then(|| b64(&format!("v2.{}", page.last().unwrap().seq)));
        Ok(LedgerPage {
            entries: page
                .into_iter()
                .map(|p| PageEntry {
                    tx_id: p.tx_id,
                    module: p.module,
                    reason: p.reason,
                    direction: p.direction,
                    amount: parse_amount(&p.amount).unwrap(),
                    posted_at: Instant(p.at),
                    asset_id: p.asset,
                    entry_id: (self.entry_ids || p.entry_id).then(|| p.seq.to_string()),
                    rail: self.entry_ids.then(|| p.rail.clone()),
                    product: None,
                    order_id: p.order_id.flatten().filter(|o| !o.is_empty()),
                    withdrawal_id: p.withdrawal_id,
                    fee: p.fee.map(|f| f.map(|f| parse_amount(&f).unwrap())),
                })
                .collect(),
            next_cursor: next,
        })
    }
}

/// A ledger that fails every read.
struct Down;

impl HistoryPages for Down {
    fn page(&self, _: &PageRequest) -> Result<LedgerPage, String> {
        Err("connect ECONNREFUSED 10.0.0.7:4002".to_owned())
    }
}

struct SpaceList(Vec<SpaceRef>);

impl Spaces for SpaceList {
    fn all_named(
        &self,
        user_id: &str,
        _asset_id: Option<&str>,
    ) -> Result<Vec<SpaceRef>, FeedError> {
        Ok(self
            .0
            .iter()
            .filter(|s| s.user_id == user_id)
            .cloned()
            .collect())
    }
}

/// `spacesOf`, with the asset filter.
struct SpacesOf(Vec<(SpaceRef, &'static str)>);

impl Spaces for SpacesOf {
    fn all_named(&self, user_id: &str, asset_id: Option<&str>) -> Result<Vec<SpaceRef>, FeedError> {
        Ok(self
            .0
            .iter()
            .filter(|(s, a)| s.user_id == user_id && asset_id.is_none_or(|w| w == *a))
            .map(|(s, _)| s.clone())
            .collect())
    }
}

/// A lister that answers the same spaces whoever asks.
struct AnySpaces(Vec<SpaceRef>);

impl Spaces for AnySpaces {
    fn all_named(&self, _: &str, _: Option<&str>) -> Result<Vec<SpaceRef>, FeedError> {
        Ok(self.0.clone())
    }
}

fn space(id: &str, user_id: &str, name: &str) -> SpaceRef {
    SpaceRef {
        id: id.to_owned(),
        user_id: user_id.to_owned(),
        kind: "named".to_owned(),
        name: name.to_owned(),
    }
}

fn feed<'a>(pages: &'a dyn HistoryPages, spaces: &'a dyn Spaces) -> Feed<'a> {
    Feed {
        spaces,
        pages: Some(pages),
        secret: Some(SECRET),
        counterparties: None,
        facts: None,
        records: None,
        partner: None,
        pay: None,
    }
}

fn q() -> Query {
    Query::default()
}

fn lim(n: i64) -> Query {
    Query {
        limit: Some(n),
        ..Query::default()
    }
}

fn txs(items: &[Item]) -> Vec<String> {
    items.iter().map(|i| i.tx_id.clone()).collect()
}

fn drain(f: &Feed<'_>, user: &str, limit: i64) -> Vec<String> {
    let mut ids = Vec::new();
    let mut cursor: Option<String> = None;
    for _ in 0..100 {
        let page = f
            .list(
                user,
                &Query {
                    limit: Some(limit),
                    cursor: cursor.clone(),
                    ..Query::default()
                },
            )
            .unwrap();
        ids.extend(txs(&page.items));
        cursor = page.next_cursor;
        if cursor.is_none() {
            return ids;
        }
    }
    panic!("more than 100 pages");
}

// ── Merging several owners ──────────────────────────────────────────────────────

fn merging_rows() -> (Vec<Posted>, Vec<String>) {
    let mut rows = Vec::new();
    let mut expected = Vec::new();
    let mut seq = 0;
    let mut next = || {
        seq += 1;
        seq
    };
    for i in 1..=13 {
        let in_space = i % 2 == 0 || i == 3;
        let tx = format!("tx-{i}");
        rows.push(if in_space {
            post(
                sub(ALICE_SPACE),
                &tx,
                "bank.transfer.manual",
                "debit",
                "1",
                "USDT",
                "bank",
                next(),
            )
        } else {
            post(
                user(ALICE),
                &tx,
                "bank.transfer.manual",
                "credit",
                "1",
                "USDT",
                "bank",
                next(),
            )
        });
        expected.insert(0, tx);
        rows.push(post(
            user(BOB),
            &format!("bob-{i}"),
            "deposit.credited",
            "debit",
            "999",
            "USDT",
            "ledger",
            next(),
        ));
        rows.push(post(
            sub(BOB_SPACE),
            &format!("bobspace-{i}"),
            "deposit.credited",
            "debit",
            "999",
            "USDT",
            "ledger",
            next(),
        ));
    }
    (rows, expected)
}

fn merging_spaces() -> SpaceList {
    SpaceList(vec![
        space(ALICE_SPACE, ALICE, "Holiday"),
        space(BOB_SPACE, BOB, "Bobs"),
    ])
}

#[test]
fn paging_with_any_limit_returns_every_entry_once_newest_first_across_the_page_boundaries() {
    let (rows, expected) = merging_rows();
    for limit in [1, 2, 3, 5, 6, 13, 50] {
        let ledger = fake(rows.clone(), false);
        let spaces = merging_spaces();
        assert_eq!(
            drain(&feed(&ledger, &spaces), ALICE, limit),
            expected,
            "limit {limit}"
        );
    }
}

#[test]
fn names_the_space_on_its_rows_and_never_reads_or_returns_another_users_money() {
    let (rows, _) = merging_rows();
    let ledger = fake(rows, false);
    let spaces = merging_spaces();
    let page = feed(&ledger, &spaces).list(ALICE, &lim(200)).unwrap();
    assert_eq!(page.items.len(), 13);
    assert_eq!(page.next_cursor, None);
    let by = |tx: &str| {
        page.items
            .iter()
            .find(|i| i.tx_id == tx)
            .unwrap()
            .space_name
            .clone()
    };
    assert_eq!(by("tx-2").as_deref(), Some("Holiday"));
    assert_eq!(by("tx-1"), None);
    let text: String = page.items.iter().map(|i| i.json().compact()).collect();
    assert!(!text.contains("bob") && !text.contains(BOB));
    let mut owners: Vec<String> = ledger
        .asked
        .lock()
        .unwrap()
        .iter()
        .map(|a| format!("{}:{}", a.owner_type, a.owner_id))
        .collect();
    owners.sort();
    owners.dedup();
    assert_eq!(
        owners,
        vec![format!("subaccount:{ALICE_SPACE}"), format!("user:{ALICE}")]
    );
}

#[test]
fn never_reads_another_users_space_even_if_it_exists_in_the_book() {
    let (rows, _) = merging_rows();
    let ledger = fake(rows, false);
    let spaces = SpaceList(vec![space(BOB_SPACE, BOB, "Bobs")]);
    let page = feed(&ledger, &spaces).list(ALICE, &lim(200)).unwrap();
    assert!(page.items.iter().all(|i| i.space_name.is_none()));
    let asked: Vec<String> = ledger
        .asked
        .lock()
        .unwrap()
        .iter()
        .map(|a| a.owner_id.clone())
        .collect();
    assert_eq!(asked, vec![ALICE.to_owned()]);
}

#[test]
fn refuses_to_treat_a_space_row_that_claims_another_users_id_as_alices() {
    let (rows, _) = merging_rows();
    let ledger = fake(rows, false);
    let lister = AnySpaces(vec![space(BOB_SPACE, BOB, "Bobs")]);
    feed(&ledger, &lister).list(ALICE, &lim(10)).unwrap();
    let asked: Vec<String> = ledger
        .asked
        .lock()
        .unwrap()
        .iter()
        .map(|a| a.owner_id.clone())
        .collect();
    assert_eq!(asked, vec![ALICE.to_owned()]);
}

#[test]
fn applies_the_asset_filter_to_every_owner_and_only_reads_spaces_of_that_asset() {
    let (mut rows, _) = merging_rows();
    rows.push(post(
        user(ALICE),
        "btc-1",
        "trade.fill",
        "debit",
        "0.1",
        "BTC",
        "trade",
        100,
    ));
    let ledger = fake(rows, false);
    let coins = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    let spaces = SpacesOf(vec![
        (space(ALICE_SPACE, ALICE, "Holiday"), "USDT"),
        (space(BOB_SPACE, BOB, "Bobs"), "USDT"),
        (space(coins, ALICE, "Coins"), "BTC"),
    ]);
    let page = feed(&ledger, &spaces)
        .list(
            ALICE,
            &Query {
                limit: Some(100),
                asset_id: Some("BTC".to_owned()),
                ..q()
            },
        )
        .unwrap();
    assert_eq!(txs(&page.items), vec!["btc-1"]);
    let asked = ledger.asked.lock().unwrap();
    assert!(asked.iter().all(|a| a.asset_id.as_deref() == Some("BTC")));
    let mut owners: Vec<&str> = asked.iter().map(|a| a.owner_id.as_str()).collect();
    owners.sort_unstable();
    assert_eq!(owners, vec![ALICE, coins]);
    // The strict fields only: no cursor on a first read, no purpose, nothing else.
    assert!(asked.iter().all(|a| a.cursor.is_none()));
}

#[test]
fn keeps_both_halves_of_a_move_between_her_own_pots_on_one_page_as_space_move() {
    let rows = vec![
        post(
            user(ALICE),
            "pay-1",
            "bank.transfer.manual",
            "credit",
            "2",
            "USDT",
            "bank",
            1,
        ),
        post(
            user(ALICE),
            "mv-1",
            "bank.transfer.manual",
            "credit",
            "5",
            "USDT",
            "bank",
            2,
        ),
        post(
            sub(ALICE_SPACE),
            "mv-1",
            "bank.transfer.manual",
            "debit",
            "5",
            "USDT",
            "bank",
            3,
        ),
    ];
    let ledger = fake(rows, false);
    let spaces = SpaceList(vec![space(ALICE_SPACE, ALICE, "Holiday")]);
    let f = feed(&ledger, &spaces);
    let p1 = f.list(ALICE, &lim(1)).unwrap();
    let shape = |items: &[Item]| {
        items
            .iter()
            .map(|i| (i.tx_id.clone(), i.kind, i.direction))
            .collect::<Vec<_>>()
    };
    assert_eq!(
        shape(&p1.items),
        vec![
            ("mv-1".to_owned(), "space_move", "in"),
            ("mv-1".to_owned(), "space_move", "out")
        ]
    );
    let p2 = f
        .list(
            ALICE,
            &Query {
                limit: Some(1),
                cursor: p1.next_cursor,
                ..q()
            },
        )
        .unwrap();
    assert_eq!(
        shape(&p2.items),
        vec![("pay-1".to_owned(), "transfer_out", "out")]
    );
    assert_eq!(p2.next_cursor, None);
}

#[test]
fn types_rows_and_carries_decimal_string_amounts_and_iso_times() {
    let rows = vec![
        post(
            user(ALICE),
            "d1",
            "deposit.credited",
            "debit",
            "100.5",
            "USDT",
            "ledger",
            1,
        ),
        post(
            user(ALICE),
            "f1",
            "fee.charged",
            "credit",
            "0.25",
            "USDT",
            "trade",
            2,
        ),
        post(
            user(ALICE),
            "w1",
            "withdraw.held",
            "credit",
            "10",
            "USDT",
            "ledger",
            3,
        ),
        post(
            user(ALICE),
            "x1",
            "something.new",
            "debit",
            "1",
            "USDT",
            "newmod",
            4,
        ),
    ];
    let ledger = fake(rows, false);
    let spaces = SpaceList(vec![]);
    let items = feed(&ledger, &spaces).list(ALICE, &lim(10)).unwrap().items;
    let shape: Vec<(String, &str, &str, String)> = items
        .iter()
        .map(|i| {
            (
                i.tx_id.clone(),
                i.kind,
                i.direction,
                format_amount(i.amount),
            )
        })
        .collect();
    assert_eq!(
        shape,
        vec![
            ("x1".to_owned(), "other", "in", "1".to_owned()),
            ("w1".to_owned(), "withdrawal", "out", "10".to_owned()),
            ("f1".to_owned(), "fee", "out", "0.25".to_owned()),
            ("d1".to_owned(), "deposit", "in", "100.5".to_owned()),
        ]
    );
    let iso = items[0].posted_at.iso();
    assert!(
        iso.starts_with("2026-10-13T00:00:0") && iso.ends_with(".000Z"),
        "{iso}"
    );
}

#[test]
fn labels_a_hold_a_release_and_a_fill_end_to_end_an_unknown_posting_stays_other() {
    let rows = vec![
        post(
            user(ALICE),
            "h1",
            "order.hold",
            "credit",
            "50",
            "USDT",
            "trade",
            1,
        ),
        post(
            user(ALICE),
            "f1",
            "trade.fill",
            "debit",
            "0.001",
            "BTC",
            "trade",
            2,
        ),
        post(
            user(ALICE),
            "r1",
            "order.hold.released",
            "debit",
            "20",
            "USDT",
            "trade",
            3,
        ),
        post(
            user(ALICE),
            "x1",
            "something.new",
            "debit",
            "1",
            "USDT",
            "newmod",
            4,
        ),
    ];
    let ledger = fake(rows, false);
    let spaces = SpaceList(vec![]);
    let items = feed(&ledger, &spaces).list(ALICE, &lim(10)).unwrap().items;
    let shape: Vec<(&str, &str, &str)> = items
        .iter()
        .map(|i| (i.tx_id.as_str(), i.kind, i.direction))
        .collect();
    assert_eq!(
        shape,
        vec![
            ("x1", "other", "in"),
            ("r1", "order_release", "in"),
            ("f1", "trade", "in"),
            ("h1", "order_hold", "out")
        ]
    );
}

#[test]
fn gives_two_entries_of_one_tx_in_one_pot_distinct_ids() {
    let rows = vec![
        post(
            user(ALICE),
            "t1",
            "trade.fill",
            "debit",
            "0.1",
            "BTC",
            "trade",
            1,
        ),
        post(
            user(ALICE),
            "t1",
            "trade.fill",
            "credit",
            "6000",
            "USDT",
            "trade",
            2,
        ),
    ];
    let ledger = fake(rows, false);
    let spaces = SpaceList(vec![]);
    let items = feed(&ledger, &spaces).list(ALICE, &lim(10)).unwrap().items;
    assert_eq!(items.len(), 2);
    assert_ne!(items[0].id, items[1].id);
    assert!(items.iter().all(|i| i.kind == "trade"));
}

#[test]
fn shows_a_fills_fee_as_its_own_fee_line_summing_to_the_ledgers_net_line() {
    let with = |mut p: Posted, order: Option<&str>, fee: Option<Option<&str>>| {
        p.order_id = order.map(|o| Some(o.to_owned()));
        p.fee = fee.map(|f| f.map(str::to_owned));
        p
    };
    let rows = vec![
        with(
            post(
                user(ALICE),
                "h1",
                "order.hold",
                "credit",
                "65.1",
                "USDT",
                "trade",
                1,
            ),
            Some("o-1"),
            Some(None),
        ),
        with(
            post(
                user(ALICE),
                "f1",
                "trade.fill.mm_maker",
                "debit",
                "0.000999",
                "BTC",
                "trade",
                2,
            ),
            Some("o-1"),
            Some(Some("0.000001")),
        ),
        with(
            post(
                user(ALICE),
                "f2",
                "trade.fill",
                "debit",
                "0.002",
                "BTC",
                "trade",
                3,
            ),
            Some("o-2"),
            Some(Some("0")),
        ),
        post(
            user(ALICE),
            "f3",
            "trade.fill",
            "debit",
            "0.003",
            "BTC",
            "trade",
            4,
        ),
    ];
    let ledger = fake(rows, false);
    let spaces = SpaceList(vec![]);
    let f = feed(&ledger, &spaces);
    let items = f.list(ALICE, &lim(10)).unwrap().items;
    let shape: Vec<(&str, &str, &str, &str, String, Option<String>, bool)> = items
        .iter()
        .map(|i| {
            (
                i.tx_id.as_str(),
                i.kind,
                i.direction,
                i.asset.as_str(),
                format_amount(i.amount),
                i.order_id.clone(),
                i.purchase,
            )
        })
        .collect();
    let o = |s: &str| Some(s.to_owned());
    assert_eq!(
        shape,
        vec![
            ("f3", "trade", "in", "BTC", "0.003".to_owned(), None, true),
            (
                "f2",
                "trade",
                "in",
                "BTC",
                "0.002".to_owned(),
                o("o-2"),
                true
            ),
            (
                "f1",
                "trade",
                "in",
                "BTC",
                "0.001".to_owned(),
                o("o-1"),
                true
            ),
            (
                "f1",
                "fee",
                "out",
                "BTC",
                "0.000001".to_owned(),
                o("o-1"),
                false
            ),
            (
                "h1",
                "order_hold",
                "out",
                "USDT",
                "65.1".to_owned(),
                o("o-1"),
                false
            ),
        ]
    );
    assert_eq!(items[3].id, format!("{}:fee", items[2].id));
    let again: Vec<String> = f
        .list(ALICE, &lim(10))
        .unwrap()
        .items
        .into_iter()
        .map(|i| i.id)
        .collect();
    assert_eq!(
        again,
        items.iter().map(|i| i.id.clone()).collect::<Vec<_>>()
    );
    let btc: Amount = items
        .iter()
        .filter(|i| i.asset == "BTC")
        .map(|i| {
            if i.direction == "in" {
                i.amount
            } else {
                -i.amount
            }
        })
        .sum();
    assert_eq!(btc, parse_amount("0.005999").unwrap());
}

#[test]
fn empty_history_is_an_empty_page_with_no_cursor() {
    let ledger = fake(vec![], false);
    let spaces = SpaceList(vec![]);
    let page = feed(&ledger, &spaces).list(ALICE, &lim(20)).unwrap();
    assert_eq!(
        page,
        Page {
            items: vec![],
            next_cursor: None
        }
    );
}

#[test]
fn refuses_when_no_ledger_page_port_is_wired_instead_of_answering_empty() {
    let spaces = SpaceList(vec![]);
    let f = Feed {
        pages: None,
        ..feed(&Down, &spaces)
    };
    assert_eq!(f.list(ALICE, &lim(5)), Err(FeedError::Unavailable));
    let f = Feed {
        secret: Some(""),
        ..feed(&Down, &spaces)
    };
    assert_eq!(f.list(ALICE, &lim(5)), Err(FeedError::Unavailable));
}

#[test]
fn refuses_not_empty_when_the_ledger_fails() {
    let spaces = SpaceList(vec![]);
    assert_eq!(
        feed(&Down, &spaces).list(ALICE, &lim(5)),
        Err(FeedError::Unavailable)
    );
}

#[test]
fn with_the_fault_on_the_activity_list_refuses_as_an_unreachable_ledger_does_never_an_empty_list() {
    let spaces = SpaceList(vec![]);
    assert_eq!(
        feed(&FailingPages, &spaces).list(ALICE, &lim(5)),
        Err(FeedError::Unavailable)
    );
}

#[test]
fn ledger_down_is_service_unavailable_with_no_internals_in_the_message() {
    let spaces = SpaceList(vec![]);
    let e = failure(feed(&Down, &spaces).list(ALICE, &lim(5)).unwrap_err());
    assert_eq!(e.code, "SERVICE_UNAVAILABLE");
    assert!(!e.message.contains("ECONNREFUSED"));
}

struct Handles(Mutex<Vec<Vec<String>>>, bool);

impl Counterparties for Handles {
    fn handles_for(
        &self,
        _: &str,
        tx_ids: &[String],
    ) -> Result<BTreeMap<String, String>, FeedError> {
        self.0.lock().unwrap().push(tx_ids.to_vec());
        if self.1 {
            return Err(FeedError::Other(StoreError::new("identity down", None)));
        }
        Ok([("tr-in".to_owned(), "bob".to_owned())]
            .into_iter()
            .collect())
    }
}

#[test]
fn counterparty_null_without_a_resolver_a_handle_never_an_id_from_one_for_transfers_only() {
    let rows = vec![
        post(
            user(ALICE),
            "tr-in",
            "bank.transfer.manual",
            "debit",
            "3",
            "USDT",
            "bank",
            1,
        ),
        post(
            user(ALICE),
            "dep",
            "deposit.credited",
            "debit",
            "9",
            "USDT",
            "ledger",
            2,
        ),
    ];
    let ledger = fake(rows, false);
    let spaces = SpaceList(vec![]);
    let plain = feed(&ledger, &spaces).list(ALICE, &lim(10)).unwrap();
    assert!(plain.items.iter().all(|i| i.counterparty.is_none()));
    let resolver = Handles(Mutex::new(vec![]), false);
    let f = Feed {
        counterparties: Some(&resolver),
        ..feed(&ledger, &spaces)
    };
    let out = f.list(ALICE, &lim(10)).unwrap();
    let by = |tx: &str| {
        out.items
            .iter()
            .find(|i| i.tx_id == tx)
            .unwrap()
            .counterparty
            .clone()
    };
    assert_eq!(by("tr-in").as_deref(), Some("bob"));
    assert_eq!(by("dep"), None);
    assert_eq!(*resolver.0.lock().unwrap(), vec![vec!["tr-in".to_owned()]]);
}

#[test]
fn a_failing_handle_lookup_never_hides_the_movement() {
    let ledger = fake(
        vec![post(
            user(ALICE),
            "tr-in",
            "bank.transfer.manual",
            "debit",
            "3",
            "USDT",
            "bank",
            1,
        )],
        false,
    );
    let spaces = SpaceList(vec![]);
    let resolver = Handles(Mutex::new(vec![]), true);
    let out = Feed {
        counterparties: Some(&resolver),
        ..feed(&ledger, &spaces)
    }
    .list(ALICE, &lim(10))
    .unwrap();
    assert_eq!(out.items.len(), 1);
    assert_eq!(out.items[0].counterparty, None);
}

// ── The cursor ──────────────────────────────────────────────────────────────────

fn cursor_rows() -> Vec<Posted> {
    (1..=6)
        .map(|i| {
            post(
                user(ALICE),
                &format!("c-{i}"),
                "deposit.credited",
                "debit",
                "1",
                "USDT",
                "ledger",
                i,
            )
        })
        .collect()
}

#[test]
fn is_opaque_and_signed() {
    let ledger = fake(cursor_rows(), false);
    let spaces = SpaceList(vec![]);
    let c = feed(&ledger, &spaces)
        .list(ALICE, &lim(2))
        .unwrap()
        .next_cursor
        .unwrap();
    let (a, b) = c.split_once('.').unwrap();
    let ok = |s: &str| {
        !s.is_empty()
            && s.bytes()
                .all(|x| x.is_ascii_alphanumeric() || x == b'-' || x == b'_')
    };
    assert!(ok(a) && ok(b), "{c}");
}

#[test]
fn refuses_a_forged_or_mangled_cursor_with_no_read() {
    let ledger = fake(cursor_rows(), false);
    let spaces = SpaceList(vec![]);
    let f = feed(&ledger, &spaces);
    let other = cursor::encode(
        "another-secret-entirely-xxxxxxxxxxxxxxxxx",
        &Body {
            user_id: ALICE.to_owned(),
            owners: vec![("u".to_owned(), Pos::Start)],
            ..Body::default()
        },
    );
    for bad in ["garbage", "a.b", "", "....", other.as_str()] {
        let got = f.list(
            ALICE,
            &Query {
                limit: Some(2),
                cursor: Some(bad.to_owned()),
                ..q()
            },
        );
        assert_eq!(got, Err(FeedError::CursorInvalid), "{bad}");
    }
    assert!(ledger.asked.lock().unwrap().is_empty());
}

#[test]
fn refuses_an_edited_cursor_a_payload_re_pointed_at_another_user_keeps_the_old_signature() {
    let ledger = fake(cursor_rows(), false);
    let spaces = SpaceList(vec![]);
    let f = feed(&ledger, &spaces);
    let c = f.list(ALICE, &lim(2)).unwrap().next_cursor.unwrap();
    let (payload, mac) = c.split_once('.').unwrap();
    let text = String::from_utf8(cursor::b64url_lenient(payload))
        .unwrap()
        .replace(ALICE, BOB);
    let edited = format!("{}.{mac}", b64(&text));
    let got = f.list(
        BOB,
        &Query {
            limit: Some(2),
            cursor: Some(edited),
            ..q()
        },
    );
    assert_eq!(got, Err(FeedError::CursorInvalid));
}

#[test]
fn refuses_alices_genuine_cursor_presented_by_bob() {
    let ledger = fake(cursor_rows(), false);
    let spaces = SpaceList(vec![]);
    let f = feed(&ledger, &spaces);
    let c = f.list(ALICE, &lim(2)).unwrap().next_cursor;
    ledger.asked.lock().unwrap().clear();
    assert_eq!(
        f.list(
            BOB,
            &Query {
                limit: Some(2),
                cursor: c,
                ..q()
            }
        ),
        Err(FeedError::CursorInvalid)
    );
    assert!(ledger.asked.lock().unwrap().is_empty());
}

#[test]
fn refuses_a_cursor_used_with_a_different_asset_filter() {
    let ledger = fake(cursor_rows(), false);
    let spaces = SpaceList(vec![]);
    let f = feed(&ledger, &spaces);
    let c = f
        .list(
            ALICE,
            &Query {
                limit: Some(2),
                asset_id: Some("USDT".to_owned()),
                ..q()
            },
        )
        .unwrap()
        .next_cursor;
    let btc = Query {
        limit: Some(2),
        cursor: c.clone(),
        asset_id: Some("BTC".to_owned()),
        ..q()
    };
    assert_eq!(f.list(ALICE, &btc), Err(FeedError::CursorInvalid));
    assert_eq!(
        f.list(
            ALICE,
            &Query {
                limit: Some(2),
                cursor: c,
                ..q()
            }
        ),
        Err(FeedError::CursorInvalid)
    );
}

#[test]
fn a_validly_signed_cursor_naming_an_owner_the_session_does_not_have_reads_nothing_for_it() {
    let ledger = fake(cursor_rows(), false);
    let spaces = SpaceList(vec![]);
    let signed = cursor::encode(
        SECRET,
        &Body {
            user_id: ALICE.to_owned(),
            owners: vec![
                ("u".to_owned(), Pos::Start),
                (format!("s:{BOB_SPACE}"), Pos::Start),
            ],
            ..Body::default()
        },
    );
    feed(&ledger, &spaces)
        .list(
            ALICE,
            &Query {
                limit: Some(3),
                cursor: Some(signed.clone()),
                ..q()
            },
        )
        .unwrap();
    assert!(
        ledger
            .asked
            .lock()
            .unwrap()
            .iter()
            .all(|a| a.owner_id == ALICE)
    );
    let body = cursor::decode(SECRET, &signed, ALICE, None, None).unwrap();
    assert!(body.owner(&format!("s:{BOB_SPACE}")).is_some());
}

// ── Closed spaces, exact resume, welcome funds ──────────────────────────────────

#[test]
fn a_move_into_an_archived_space_is_a_space_move_not_a_payment_sent() {
    let archived = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    let rows = vec![
        post(
            user(ALICE),
            "to-closed",
            "bank.transfer.manual",
            "credit",
            "40",
            "USDT",
            "bank",
            1,
        ),
        post(
            sub(archived),
            "to-closed",
            "bank.transfer.manual",
            "debit",
            "40",
            "USDT",
            "bank",
            2,
        ),
    ];
    let ledger = fake(rows, false);
    let spaces = SpaceList(vec![space(archived, ALICE, "Old trip")]);
    let items = feed(&ledger, &spaces).list(ALICE, &lim(10)).unwrap().items;
    let shape: Vec<(&str, &str, Option<String>)> = items
        .iter()
        .map(|i| (i.kind, i.direction, i.space_name.clone()))
        .collect();
    assert_eq!(
        shape,
        vec![
            ("space_move", "in", Some("Old trip".to_owned())),
            ("space_move", "out", None)
        ]
    );
}

#[test]
fn a_posting_between_pages_causes_no_duplicate_and_no_gap() {
    for entry_ids in [false, true] {
        let rows: Vec<Posted> = (1..=8)
            .map(|i| {
                let tx = format!("p-{i}");
                if i % 2 == 1 {
                    post(
                        user(ALICE),
                        &tx,
                        "deposit.credited",
                        "debit",
                        "1",
                        "USDT",
                        "ledger",
                        i,
                    )
                } else {
                    post(
                        sub(ALICE_SPACE),
                        &tx,
                        "bank.transfer.manual",
                        "debit",
                        "1",
                        "USDT",
                        "bank",
                        i,
                    )
                }
            })
            .collect();
        let ledger = fake(rows, entry_ids);
        let spaces = SpaceList(vec![space(ALICE_SPACE, ALICE, "Holiday")]);
        let f = feed(&ledger, &spaces);
        let p1 = f.list(ALICE, &lim(3)).unwrap();
        ledger.rows.lock().unwrap().push(post(
            user(ALICE),
            "newer",
            "deposit.credited",
            "debit",
            "5",
            "USDT",
            "ledger",
            9,
        ));
        let mut seen = txs(&p1.items);
        let mut c = p1.next_cursor;
        while let Some(cur) = c {
            let next = f
                .list(
                    ALICE,
                    &Query {
                        limit: Some(3),
                        cursor: Some(cur),
                        ..q()
                    },
                )
                .unwrap();
            seen.extend(txs(&next.items));
            c = next.next_cursor;
        }
        assert_eq!(
            seen,
            vec!["p-8", "p-7", "p-6", "p-5", "p-4", "p-3", "p-2", "p-1"],
            "entry ids {entry_ids}"
        );
    }
}

#[test]
fn with_entry_id_resumes_exactly_with_no_re_read_without_it_falls_back_to_one_re_read_per_partly_used_owner()
 {
    let rows: Vec<Posted> = (1..=6)
        .map(|i| {
            let owner = if i % 2 == 1 {
                user(ALICE)
            } else {
                sub(ALICE_SPACE)
            };
            post(
                owner,
                &format!("r-{i}"),
                "deposit.credited",
                "debit",
                "1",
                "USDT",
                "ledger",
                i,
            )
        })
        .collect();
    let spaces = SpaceList(vec![space(ALICE_SPACE, ALICE, "Holiday")]);
    let exact = fake(rows.clone(), true);
    feed(&exact, &spaces).list(ALICE, &lim(2)).unwrap();
    assert_eq!(exact.asked.lock().unwrap().len(), 2);
    let legacy = fake(rows, false);
    feed(&legacy, &spaces).list(ALICE, &lim(2)).unwrap();
    assert!(legacy.asked.lock().unwrap().len() > 2);
}

#[test]
fn merges_equal_timestamps_across_owners_by_entry_id() {
    let a = post(
        user(ALICE),
        "tie-a",
        "deposit.credited",
        "debit",
        "1",
        "USDT",
        "ledger",
        1,
    );
    let mut b = post(
        sub(ALICE_SPACE),
        "aaa-tie-b",
        "deposit.credited",
        "debit",
        "1",
        "USDT",
        "ledger",
        2,
    );
    b.at = a.at;
    let ledger = fake(vec![a, b], true);
    let spaces = SpaceList(vec![space(ALICE_SPACE, ALICE, "Holiday")]);
    let items = feed(&ledger, &spaces).list(ALICE, &lim(10)).unwrap().items;
    assert_eq!(txs(&items), vec!["aaa-tie-b", "tie-a"]);
}

#[test]
fn local_test_deposits_are_welcome_funds_a_real_or_unknown_rail_stays_deposit() {
    let mk = |id: &str, rail: Option<&str>, seq| {
        let mut p = post(
            user(ALICE),
            id,
            "deposit.credited",
            "debit",
            "1000",
            "USDT",
            "ledger",
            seq,
        );
        p.rail = rail.map(str::to_owned);
        p
    };
    let ledger = fake(
        vec![
            mk("w", Some("local-test"), 1),
            mk("c", Some("crypto-native"), 2),
            mk("n", None, 3),
        ],
        true,
    );
    let spaces = SpaceList(vec![]);
    let items = feed(&ledger, &spaces).list(ALICE, &lim(10)).unwrap().items;
    let kinds: BTreeMap<String, &str> = items.iter().map(|i| (i.tx_id.clone(), i.kind)).collect();
    assert_eq!(kinds["w"], "welcome_funds");
    assert_eq!(kinds["c"], "deposit");
    assert_eq!(kinds["n"], "deposit");
    let old = fake(vec![mk("w2", Some("local-test"), 1)], false);
    assert_eq!(
        feed(&old, &spaces).list(ALICE, &lim(10)).unwrap().items[0].kind,
        "deposit"
    );
}

// ── orderId ─────────────────────────────────────────────────────────────────────

const TAKER: &str = "c1111111-1111-4111-8111-c11111111111";
const MAKER: &str = "c2222222-2222-4222-8222-c22222222222";

fn order_rows() -> Vec<Posted> {
    let with = |mut p: Posted, o: Option<&str>| {
        p.order_id = Some(o.map(str::to_owned));
        p
    };
    vec![
        with(
            post(
                user(ALICE),
                "tx-hold",
                "order.hold",
                "credit",
                "100",
                "USDT",
                "trade",
                1,
            ),
            Some(TAKER),
        ),
        with(
            post(
                user(ALICE),
                "tx-amend",
                "order.hold.amend",
                "credit",
                "20",
                "USDT",
                "trade",
                2,
            ),
            Some(TAKER),
        ),
        with(
            post(
                user(ALICE),
                "tx-fill",
                "trade.fill",
                "debit",
                "0.5",
                "BTC",
                "trade",
                3,
            ),
            Some(TAKER),
        ),
        with(
            post(
                user(ALICE),
                "tx-release",
                "order.hold.released",
                "debit",
                "30",
                "USDT",
                "trade",
                4,
            ),
            Some(TAKER),
        ),
        with(
            post(
                user(BOB),
                "tx-fill",
                "trade.fill",
                "debit",
                "90",
                "USDT",
                "trade",
                5,
            ),
            Some(MAKER),
        ),
        post(
            user(ALICE),
            "tx-dep",
            "deposit.credited",
            "debit",
            "5",
            "USDT",
            "ledger",
            6,
        ),
        with(
            post(
                user(ALICE),
                "tx-null",
                "trade.fill",
                "debit",
                "1",
                "BTC",
                "trade",
                7,
            ),
            None,
        ),
    ]
}

#[test]
fn a_taker_fill_leg_carries_the_taker_order_id_and_a_maker_fill_leg_carries_the_maker_order_id() {
    let ledger = fake(order_rows(), false);
    let spaces = SpaceList(vec![]);
    let f = feed(&ledger, &spaces);
    let alice = f
        .list(ALICE, &q())
        .unwrap()
        .items
        .into_iter()
        .find(|i| i.tx_id == "tx-fill")
        .unwrap();
    let bob = f
        .list(BOB, &q())
        .unwrap()
        .items
        .into_iter()
        .find(|i| i.tx_id == "tx-fill")
        .unwrap();
    assert_eq!(
        (alice.kind, alice.asset.as_str(), alice.order_id.as_deref()),
        ("trade", "BTC", Some(TAKER))
    );
    assert_eq!(
        (bob.kind, bob.asset.as_str(), bob.order_id.as_deref()),
        ("trade", "USDT", Some(MAKER))
    );
}

#[test]
fn an_order_hold_a_hold_amend_and_a_release_carry_the_order_id() {
    let ledger = fake(order_rows(), false);
    let spaces = SpaceList(vec![]);
    let items = feed(&ledger, &spaces).list(ALICE, &q()).unwrap().items;
    let by = |tx: &str| items.iter().find(|i| i.tx_id == tx).unwrap();
    assert_eq!(
        (by("tx-hold").kind, by("tx-hold").order_id.as_deref()),
        ("order_hold", Some(TAKER))
    );
    assert_eq!(
        (by("tx-amend").kind, by("tx-amend").order_id.as_deref()),
        ("order_hold", Some(TAKER))
    );
    assert_eq!(
        (by("tx-release").kind, by("tx-release").order_id.as_deref()),
        ("order_release", Some(TAKER))
    );
}

#[test]
fn a_line_the_ledger_does_not_link_to_an_order_omits_order_id_and_the_key_on_the_wire() {
    let ledger = fake(order_rows(), false);
    let spaces = SpaceList(vec![]);
    let items = feed(&ledger, &spaces).list(ALICE, &lim(50)).unwrap().items;
    for tx in ["tx-dep", "tx-null"] {
        let i = items.iter().find(|i| i.tx_id == tx).unwrap();
        assert_eq!(i.order_id, None);
        assert!(i.json().get("orderId").is_none());
    }
    let fill = items.iter().find(|i| i.tx_id == "tx-fill").unwrap();
    assert_eq!(
        fill.json().get("orderId"),
        Some(&service_kit::json::Json::str(TAKER))
    );
}

#[test]
fn leaves_the_cursor_unchanged_it_encodes_the_same_positions_with_or_without_order_ids() {
    let rows = order_rows();
    let plain: Vec<Posted> = rows
        .iter()
        .cloned()
        .map(|mut p| {
            p.order_id = None;
            p
        })
        .collect();
    let spaces = SpaceList(vec![]);
    let (l1, l2) = (fake(rows, false), fake(plain, false));
    let a = feed(&l1, &spaces).list(ALICE, &lim(2)).unwrap();
    let b = feed(&l2, &spaces).list(ALICE, &lim(2)).unwrap();
    assert_eq!(a.next_cursor, b.next_cursor);
    assert_eq!(
        a.items.iter().map(|i| &i.id).collect::<Vec<_>>(),
        b.items.iter().map(|i| &i.id).collect::<Vec<_>>()
    );
}

// ── Browse: kinds, oldest first, one account, year, address ─────────────────────

const SPACE: &str = "33333333-3333-4333-8333-333333333333";
const STRANGER_SPACE: &str = "44444444-4444-4444-8444-444444444444";

fn bpost(tx: &str, reason: &str, direction: &str, seq: i64) -> Posted {
    let mut p = post(user(ALICE), tx, reason, direction, "1", "USDT", "bank", seq);
    p.at = OCT1 + seq * 1000;
    p.entry_id = true;
    p
}

fn bmod(mut p: Posted, module: &str) -> Posted {
    p.module = module.to_owned();
    p
}

fn bowner(mut p: Posted, owner: &str) -> Posted {
    p.owner_type = "subaccount";
    p.owner_id = owner.to_owned();
    p
}

fn rent() -> AnySpaces {
    AnySpaces(vec![space(SPACE, ALICE, "Rent")])
}

#[test]
fn shows_an_earn_interest_credit_as_earn_and_an_unknown_reason_as_other_with_every_line_kept() {
    let rows = vec![
        bpost("tx-interest", "bank.earn.interest", "debit", 1),
        bmod(bpost("tx-stake", "token.stake", "credit", 2), "token"),
        bmod(
            bpost("tx-yield", "token.yield.distributed", "debit", 3),
            "token",
        ),
        bmod(
            bpost("tx-mystery", "brand.new.reason", "debit", 4),
            "brand-new",
        ),
        bmod(bpost("tx-fee", "fee.charged", "credit", 5), "ledger"),
    ];
    let n = rows.len();
    let ledger = fake(rows.clone(), false);
    let spaces = rent();
    let f = feed(&ledger, &spaces);
    let all = f.list(ALICE, &lim(50)).unwrap().items;
    let kind_of = |tx: &str| all.iter().find(|i| i.tx_id == tx).unwrap().kind;
    assert_eq!(kind_of("tx-interest"), "earn");
    assert_eq!(kind_of("tx-stake"), "staking");
    assert_eq!(kind_of("tx-yield"), "reward");
    assert_eq!(kind_of("tx-mystery"), "other");
    let counted: usize = kind::KINDS
        .iter()
        .map(|k| all.iter().filter(|i| i.kind == *k).count())
        .sum();
    assert_eq!(counted, n);
    // filters to the new kinds
    let earn = f
        .list(
            ALICE,
            &Query {
                kind: Some(vec!["earn".into(), "reward".into()]),
                ..q()
            },
        )
        .unwrap();
    let mut got = txs(&earn.items);
    got.sort();
    assert_eq!(got, vec!["tx-interest", "tx-yield"]);
}

fn seven() -> Vec<Posted> {
    (1..=7)
        .map(|i| bpost(&format!("tx-{i}"), "bank.transfer.manual", "debit", i))
        .collect()
}

fn asc(limit: i64) -> Query {
    Query {
        sort: Some("asc".into()),
        limit: Some(limit),
        ..q()
    }
}

#[test]
fn starts_at_the_oldest_line_and_pages_to_the_end_with_no_gap_or_repeat_at_the_boundary() {
    let ledger = fake(seven(), false);
    let spaces = rent();
    let f = feed(&ledger, &spaces);
    let mut seen = Vec::new();
    let mut c: Option<String> = None;
    for guard in 0..10 {
        let page = f
            .list(
                ALICE,
                &Query {
                    cursor: c.clone(),
                    ..asc(3)
                },
            )
            .unwrap();
        if guard == 0 {
            assert_eq!(page.items[0].tx_id, "tx-1");
        }
        seen.extend(txs(&page.items));
        c = page.next_cursor;
        if c.is_none() {
            break;
        }
    }
    assert_eq!(
        seen,
        vec!["tx-1", "tx-2", "tx-3", "tx-4", "tx-5", "tx-6", "tx-7"]
    );
}

#[test]
fn keeps_its_place_when_a_newer_line_posts_between_pages() {
    let ledger = fake(seven(), false);
    let spaces = rent();
    let f = feed(&ledger, &spaces);
    let first = f.list(ALICE, &asc(3)).unwrap();
    ledger
        .rows
        .lock()
        .unwrap()
        .push(bpost("tx-8", "bank.transfer.manual", "debit", 8));
    let second = f
        .list(
            ALICE,
            &Query {
                cursor: first.next_cursor,
                ..asc(3)
            },
        )
        .unwrap();
    assert_eq!(txs(&second.items), vec!["tx-4", "tx-5", "tx-6"]);
}

#[test]
fn combines_with_a_filter_and_a_cursor_from_the_other_order_is_refused() {
    let ledger = fake(seven(), false);
    let spaces = rent();
    let f = feed(&ledger, &spaces);
    let inward = |mut x: Query| {
        x.direction = Some("in".into());
        x
    };
    let a = f.list(ALICE, &inward(asc(2))).unwrap();
    let d = f.list(ALICE, &inward(lim(2))).unwrap();
    assert_eq!(txs(&a.items), vec!["tx-1", "tx-2"]);
    assert_eq!(txs(&d.items), vec!["tx-7", "tx-6"]);
    let cross = f.list(
        ALICE,
        &Query {
            cursor: d.next_cursor,
            ..inward(asc(2))
        },
    );
    assert_eq!(cross, Err(FeedError::CursorInvalid));
    let cross = f.list(
        ALICE,
        &Query {
            cursor: a.next_cursor,
            ..inward(lim(2))
        },
    );
    assert_eq!(cross, Err(FeedError::CursorInvalid));
}

#[test]
fn refuses_a_history_too_long_to_sort_instead_of_showing_a_short_list() {
    let long: Vec<Posted> = (1..=2050)
        .map(|i| bpost(&format!("tx-{i}"), "bank.transfer.manual", "debit", i))
        .collect();
    let spaces = rent();
    let ledger = fake(long.clone(), false);
    assert_eq!(
        feed(&ledger, &spaces).list(ALICE, &asc(5)),
        Err(FeedError::SortBounded)
    );
    let mut edge: Vec<Posted> = (0..50)
        .map(|i| {
            bpost(
                &format!("tx-old-{i}"),
                "bank.transfer.manual",
                "credit",
                i + 1,
            )
        })
        .collect();
    edge.extend((1..=2000).map(|i| {
        bpost(
            &format!("tx-in-{i}"),
            "bank.transfer.manual",
            "debit",
            i + 99,
        )
    }));
    let ledger = fake(edge, false);
    let exact = feed(&ledger, &spaces)
        .list(
            ALICE,
            &Query {
                direction: Some("in".into()),
                ..asc(5)
            },
        )
        .unwrap();
    assert_eq!(exact.items[0].tx_id, "tx-in-1");
    let ledger = fake(long, false);
    let from = Instant(OCT1 + 33 * 60_000).iso();
    let page = feed(&ledger, &spaces)
        .list(
            ALICE,
            &Query {
                from: Some(from),
                ..asc(5)
            },
        )
        .unwrap();
    assert_eq!(page.items[0].tx_id, "tx-1980");
}

fn account_rows() -> Vec<Posted> {
    vec![
        bpost("tx-main", "bank.transfer.manual", "debit", 1),
        bowner(
            bpost("tx-space-1", "bank.transfer.manual", "debit", 2),
            SPACE,
        ),
        bowner(
            bpost("tx-space-2", "bank.transfer.manual", "credit", 3),
            SPACE,
        ),
    ]
}

fn account(a: &str) -> Query {
    Query {
        account_id: Some(a.to_owned()),
        ..q()
    }
}

#[test]
fn reads_only_that_space_or_only_the_main_account() {
    let ledger = fake(account_rows(), false);
    let spaces = rent();
    let f = feed(&ledger, &spaces);
    assert_eq!(
        txs(&f.list(ALICE, &account(SPACE)).unwrap().items),
        vec!["tx-space-2", "tx-space-1"]
    );
    assert_eq!(
        txs(&f.list(ALICE, &account("main")).unwrap().items),
        vec!["tx-main"]
    );
    let mut all = txs(&f.list(ALICE, &q()).unwrap().items);
    all.sort();
    assert_eq!(all, vec!["tx-main", "tx-space-1", "tx-space-2"]);
}

#[test]
fn still_reads_a_move_between_two_of_the_customers_own_pots_as_a_space_move_from_either_side() {
    let mut rows = account_rows();
    rows.push(bpost("tx-move", "bank.transfer.manual", "credit", 4));
    rows.push(bowner(
        bpost("tx-move", "bank.transfer.manual", "debit", 5),
        SPACE,
    ));
    let ledger = fake(rows, false);
    let spaces = rent();
    let f = feed(&ledger, &spaces);
    let kinds = |x: &Query| -> Vec<&'static str> {
        f.list(ALICE, x)
            .unwrap()
            .items
            .iter()
            .filter(|i| i.tx_id == "tx-move")
            .map(|i| i.kind)
            .collect()
    };
    assert_eq!(kinds(&account("main")), vec!["space_move"]);
    assert_eq!(kinds(&account(SPACE)), vec!["space_move"]);
    let moves = f
        .list(
            ALICE,
            &Query {
                kind: Some(vec!["space_move".into()]),
                ..account("main")
            },
        )
        .unwrap();
    assert_eq!(txs(&moves.items), vec!["tx-move"]);
}

#[test]
fn pages_inside_one_space() {
    let ledger = fake(account_rows(), false);
    let spaces = rent();
    let f = feed(&ledger, &spaces);
    let first = f
        .list(
            ALICE,
            &Query {
                limit: Some(1),
                ..account(SPACE)
            },
        )
        .unwrap();
    assert_eq!(txs(&first.items), vec!["tx-space-2"]);
    let second = f
        .list(
            ALICE,
            &Query {
                limit: Some(1),
                cursor: first.next_cursor,
                ..account(SPACE)
            },
        )
        .unwrap();
    assert_eq!(txs(&second.items), vec!["tx-space-1"]);
    assert_eq!(second.next_cursor, None);
}

#[test]
fn refuses_a_space_that_is_not_the_customers_and_never_reads_it() {
    let ledger = fake(account_rows(), false);
    let spaces = rent();
    assert_eq!(
        feed(&ledger, &spaces).list(ALICE, &account(STRANGER_SPACE)),
        Err(FeedError::AccountUnknown)
    );
    assert!(ledger.asked.lock().unwrap().is_empty());
}

fn year_rows() -> Vec<Posted> {
    let edge = |tx: &str, iso: &str, seq| {
        let mut p = bpost(tx, "bank.transfer.manual", "debit", seq);
        p.at = js_date(iso).unwrap().0;
        p
    };
    vec![
        edge("tx-2025-last", "2025-12-31T23:59:59.999Z", 1),
        edge("tx-2026-first", "2026-01-01T00:00:00.000Z", 2),
        edge("tx-2026-mid", "2026-06-15T12:00:00.000Z", 3),
        edge("tx-2026-last", "2026-12-31T23:59:59.999Z", 4),
        edge("tx-2027-first", "2027-01-01T00:00:00.000Z", 5),
    ]
}

#[test]
fn means_the_utc_calendar_year_first_to_last_millisecond() {
    let ledger = fake(year_rows(), false);
    let spaces = rent();
    let out = feed(&ledger, &spaces)
        .list(
            ALICE,
            &Query {
                year: Some(2026),
                ..q()
            },
        )
        .unwrap();
    assert_eq!(
        txs(&out.items),
        vec!["tx-2026-last", "tx-2026-mid", "tx-2026-first"]
    );
}

#[test]
fn narrows_further_by_a_range_and_an_empty_overlap_is_a_range_error() {
    let ledger = fake(year_rows(), false);
    let spaces = rent();
    let f = feed(&ledger, &spaces);
    let from = Some("2026-06-01T00:00:00.000Z".to_owned());
    assert_eq!(
        txs(&f
            .list(
                ALICE,
                &Query {
                    year: Some(2026),
                    from,
                    ..q()
                }
            )
            .unwrap()
            .items),
        vec!["tx-2026-last", "tx-2026-mid"]
    );
    let to = Some("2025-12-31T00:00:00.000Z".to_owned());
    assert_eq!(
        f.list(
            ALICE,
            &Query {
                year: Some(2026),
                to,
                ..q()
            }
        ),
        Err(FeedError::Range)
    );
}

#[test]
fn refuses_a_tax_year_whose_start_date_is_not_set_and_guesses_nothing() {
    let ledger = fake(year_rows(), false);
    let spaces = rent();
    let f = feed(&ledger, &spaces);
    assert_eq!(
        f.list(
            ALICE,
            &Query {
                tax_year: Some(2026),
                ..q()
            }
        ),
        Err(FeedError::TaxYearUnset)
    );
    assert_eq!(
        f.list(
            ALICE,
            &Query {
                tax_year: Some(2026),
                ..asc(50)
            }
        ),
        Err(FeedError::TaxYearUnset)
    );
    let e = failure(FeedError::TaxYearUnset);
    assert_eq!(e.code, "PRECONDITION_FAILED");
    assert!(e.message.contains("portfolio.tax_year_start_unset"));
}

const ADDRESS: &str = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";

struct Recs {
    notes: BTreeMap<String, Annotation>,
    by_tx: bool,
    addresses: Option<Result<(), ()>>,
    notes_fail: bool,
}

impl Records for Recs {
    fn for_items(
        &self,
        _: &str,
        refs: &[(String, String)],
    ) -> Result<BTreeMap<String, Annotation>, FeedError> {
        if self.notes_fail {
            return Err(FeedError::Other(StoreError::new("db down", None)));
        }
        Ok(refs
            .iter()
            .filter_map(|(id, tx)| {
                let key = if self.by_tx { tx } else { id };
                self.notes.get(key).map(|a| (id.clone(), a.clone()))
            })
            .collect())
    }
    fn looks_up_addresses(&self) -> bool {
        self.addresses.is_some()
    }
    fn addresses_for(
        &self,
        _: &str,
        tx_ids: &[String],
    ) -> Result<BTreeMap<String, String>, FeedError> {
        match self.addresses {
            Some(Ok(())) => Ok(tx_ids
                .iter()
                .filter(|t| *t == "tx-wd")
                .map(|t| (t.clone(), ADDRESS.to_owned()))
                .collect()),
            _ => Err(FeedError::Other(StoreError::new("db down", None))),
        }
    }
}

fn recs() -> Recs {
    Recs {
        notes: BTreeMap::new(),
        by_tx: false,
        addresses: Some(Ok(())),
        notes_fail: false,
    }
}

fn address_rows() -> Vec<Posted> {
    vec![
        bmod(bpost("tx-wd", "withdraw.held", "credit", 1), "ledger"),
        bmod(bpost("tx-trade", "trade.fill", "debit", 2), "trade"),
        bmod(bpost("tx-wd-fiat", "withdraw.held", "credit", 3), "ledger"),
    ]
}

fn addr(a: &str) -> Query {
    Query {
        address: Some(a.to_owned()),
        ..q()
    }
}

#[test]
fn finds_a_withdrawal_by_part_of_its_address_ignoring_case_and_never_matches_a_line_with_none() {
    let ledger = fake(address_rows(), false);
    let spaces = rent();
    let r = recs();
    let f = Feed {
        records: Some(&r),
        ..feed(&ledger, &spaces)
    };
    assert_eq!(
        txs(&f.list(ALICE, &addr("0xabcdef01")).unwrap().items),
        vec!["tx-wd"]
    );
    assert!(f.list(ALICE, &addr("0xnothere")).unwrap().items.is_empty());
    let all = f.list(ALICE, &q()).unwrap().items;
    let a = |tx: &str| all.iter().find(|i| i.tx_id == tx).unwrap().address.clone();
    assert_eq!(a("tx-wd").as_deref(), Some(ADDRESS));
    assert_eq!(a("tx-trade"), None);
    assert_eq!(a("tx-wd-fiat"), None);
}

#[test]
fn fails_the_read_when_the_lookup_fails_during_an_address_filter_but_still_shows_the_lines_without_one()
 {
    let ledger = fake(address_rows(), false);
    let spaces = rent();
    let broken = Recs {
        addresses: Some(Err(())),
        ..recs()
    };
    let f = Feed {
        records: Some(&broken),
        ..feed(&ledger, &spaces)
    };
    assert_eq!(
        f.list(ALICE, &addr("0xabcdef01")),
        Err(FeedError::Unavailable)
    );
    assert_eq!(f.list(ALICE, &q()).unwrap().items.len(), 3);
}

const W: &str = "7a7a7a7a-0000-4000-8000-000000000001";
const PAID: &str = "0x1111111111111111111111111111111111111111";

struct Pay(Option<BTreeMap<String, String>>, Mutex<Vec<Vec<String>>>);

impl PayAddresses for Pay {
    fn addresses_for(&self, _: &str, ids: &[String]) -> Option<BTreeMap<String, String>> {
        self.1.lock().unwrap().push(ids.to_vec());
        self.0.clone()
    }
}

fn pay_rows() -> Vec<Posted> {
    let mut rows = address_rows();
    for (tx, reason, seq) in [
        ("tx-pay-hold", "withdraw.held", 4),
        ("tx-pay-settle", "withdraw.settled", 5),
    ] {
        let mut p = bmod(bpost(tx, reason, "credit", seq), "ledger");
        p.withdrawal_id = Some(format!("{W}:0"));
        rows.push(p);
    }
    rows
}

#[test]
fn takes_its_address_from_svc_pay_by_the_withdrawal_id_the_ledger_line_names_and_filters_by_it() {
    let ledger = fake(pay_rows(), false);
    let spaces = rent();
    let r = recs();
    let pay = Pay(
        Some([(W.to_owned(), PAID.to_owned())].into_iter().collect()),
        Mutex::new(vec![]),
    );
    let f = Feed {
        records: Some(&r),
        pay: Some(&pay),
        ..feed(&ledger, &spaces)
    };
    let mut got = txs(&f.list(ALICE, &addr("0X11111111")).unwrap().items);
    got.sort();
    assert_eq!(got, vec!["tx-pay-hold", "tx-pay-settle"]);
    assert_eq!(
        txs(&f.list(ALICE, &addr("0xabcdef01")).unwrap().items),
        vec!["tx-wd"]
    );
    assert_eq!(pay.1.lock().unwrap()[0], vec![W.to_owned()]);
    let all = f.list(ALICE, &q()).unwrap().items;
    let a = |tx: &str| all.iter().find(|i| i.tx_id == tx).unwrap().address.clone();
    assert_eq!(a("tx-pay-hold").as_deref(), Some(PAID));
    assert_eq!(a("tx-wd").as_deref(), Some(ADDRESS));
}

#[test]
fn fails_an_address_filter_when_svc_pay_cannot_answer_or_cannot_be_asked_shows_every_line_otherwise()
 {
    let ledger = fake(pay_rows(), false);
    let spaces = rent();
    let r = recs();
    let pay = Pay(None, Mutex::new(vec![]));
    let with_pay = Feed {
        records: Some(&r),
        pay: Some(&pay),
        ..feed(&ledger, &spaces)
    };
    assert_eq!(
        with_pay.list(ALICE, &addr("0x1111")),
        Err(FeedError::Unavailable)
    );
    let without = Feed {
        records: Some(&r),
        ..feed(&ledger, &spaces)
    };
    assert_eq!(
        without.list(ALICE, &addr("0x1111")),
        Err(FeedError::Unavailable)
    );
    assert_eq!(with_pay.list(ALICE, &q()).unwrap().items.len(), 5);
}

#[test]
fn refuses_an_address_filter_when_nothing_can_look_addresses_up() {
    let ledger = fake(address_rows(), false);
    let spaces = rent();
    assert_eq!(
        feed(&ledger, &spaces).list(ALICE, &addr("0xabcdef01")),
        Err(FeedError::Unavailable)
    );
}

fn purchase_lines() -> Vec<Posted> {
    let t = |tx: &str, reason: &str, seq, module: &str, asset: &str| {
        let mut p = bmod(bpost(tx, reason, "debit", seq), module);
        p.asset = asset.to_owned();
        p
    };
    vec![
        t("tx-buy", "trade.fill", 3, "trade", "BTC"),
        t("tx-sell", "trade.fill", 4, "trade", "USDT"),
        t("tx-mm", "trade.fill.mm_maker", 5, "trade", "ETH"),
        t("tx-buyback", "trade.fill.buyback", 6, "trade", "BTC"),
        t("tx-margin", "futures.margin.release", 7, "trade", "ETH"),
        t("tx-profit", "futures.profit.realized", 8, "trade", "USDT"),
        t("tx-p2p-buy", "p2p.escrow.release", 9, "p2p", "USDT"),
        t("tx-p2p-refund", "p2p.escrow.refund", 10, "p2p", "BTC"),
        bpost("tx-send", "bank.transfer.manual", "credit", 11),
    ]
}

#[test]
fn links_a_purchase_to_the_asset_history_and_a_sale_a_futures_settlement_or_a_refund_to_nothing() {
    let ledger = fake(purchase_lines(), false);
    let spaces = rent();
    let f = feed(&ledger, &spaces);
    let list = f.list(ALICE, &lim(20)).unwrap().items;
    let page_of = |tx: &str| {
        let line = list.iter().find(|i| i.tx_id == tx).unwrap();
        let found = f.get(ALICE, &line.id).unwrap();
        asset_page_of(if found.lines.is_empty() {
            std::slice::from_ref(&found.item)
        } else {
            &found.lines
        })
    };
    assert_eq!(page_of("tx-buy").as_deref(), Some("/coin/BTC"));
    assert_eq!(page_of("tx-mm").as_deref(), Some("/coin/ETH"));
    assert_eq!(page_of("tx-p2p-buy").as_deref(), Some("/coin/USDT"));
    assert_eq!(
        list.iter().find(|i| i.tx_id == "tx-buyback").unwrap().kind,
        "trade"
    );
    for tx in [
        "tx-sell",
        "tx-buyback",
        "tx-margin",
        "tx-profit",
        "tx-p2p-refund",
        "tx-send",
    ] {
        assert_eq!(page_of(tx), None, "{tx}");
    }
    let mut bought: Vec<String> = list
        .iter()
        .filter(|i| i.purchase)
        .map(|i| i.tx_id.clone())
        .collect();
    bought.sort();
    assert_eq!(bought, vec!["tx-buy", "tx-mm", "tx-p2p-buy"]);
}

#[test]
fn never_builds_a_link_from_an_asset_id_that_is_not_a_plain_code() {
    let mut odd = bmod(bpost("tx-odd", "trade.fill", "debit", 3), "trade");
    odd.asset = "..".to_owned();
    let ledger = fake(vec![odd], false);
    let spaces = rent();
    let f = feed(&ledger, &spaces);
    let line = f.list(ALICE, &q()).unwrap().items.remove(0);
    let found = f.get(ALICE, &line.id).unwrap();
    assert_eq!(asset_page_of(&found.lines), None);
}

// ── Filters and get ─────────────────────────────────────────────────────────────

fn filter_rows() -> Vec<Posted> {
    let p = |tx: &str, reason: &str, dir: &str, amount: &str, seq, module: &str| {
        let mut x = bmod(bpost(tx, reason, dir, seq), module);
        x.amount = amount.to_owned();
        x
    };
    let mut trade = p("tx-trade", "trade.fill", "debit", "2", 4, "trade");
    trade.order_id = Some(Some("ord-9".to_owned()));
    vec![
        p("tx-fee", "fee.charged", "credit", "0.10", 1, "ledger"),
        p("tx-in", "bank.transfer.manual", "debit", "10", 2, "bank"),
        p("tx-out", "bank.transfer.manual", "credit", "4.5", 3, "bank"),
        trade,
    ]
}

#[test]
fn filters_by_kind_direction_amount_and_text_comparing_decimals_exactly() {
    let ledger = fake(filter_rows(), false);
    let spaces = SpaceList(vec![]);
    let f = feed(&ledger, &spaces);
    let out = f
        .list(
            ALICE,
            &Query {
                kind: Some(vec!["transfer_out".into(), "fee".into()]),
                direction: Some("out".into()),
                min_amount: Some("0.1".into()),
                max_amount: Some("4.50".into()),
                ..q()
            },
        )
        .unwrap();
    let mut got = txs(&out.items);
    got.sort();
    assert_eq!(got, vec!["tx-fee", "tx-out"]);
    let searched = f
        .list(
            ALICE,
            &Query {
                q: Some("4.5".into()),
                ..q()
            },
        )
        .unwrap();
    assert_eq!(txs(&searched.items), vec!["tx-out"]);
}

#[test]
fn keeps_walking_until_the_date_range_is_filled() {
    let ledger = fake(filter_rows(), false);
    let spaces = SpaceList(vec![]);
    let out = feed(&ledger, &spaces)
        .list(
            ALICE,
            &Query {
                from: Some(Instant(OCT1 + 2000).iso()),
                to: Some(Instant(OCT1 + 3000).iso()),
                limit: Some(10),
                ..q()
            },
        )
        .unwrap();
    assert_eq!(txs(&out.items), vec!["tx-out", "tx-in"]);
    assert_eq!(out.next_cursor, None);
}

#[test]
fn returns_one_line_and_its_order_lines() {
    let ledger = fake(filter_rows(), false);
    let spaces = SpaceList(vec![]);
    let f = feed(&ledger, &spaces);
    let listed = f.list(ALICE, &lim(10)).unwrap().items;
    let fee = listed.iter().find(|i| i.tx_id == "tx-fee").unwrap();
    let one = f.get(ALICE, &fee.id).unwrap();
    assert_eq!(one.item.tx_id, "tx-fee");
    assert_eq!(txs(&one.lines), vec!["tx-fee"]);
    let order = f.get(ALICE, "order:ord-9").unwrap();
    assert_eq!(
        order
            .lines
            .iter()
            .map(|l| l.order_id.clone().unwrap())
            .collect::<Vec<_>>(),
        vec!["ord-9"]
    );
    assert!(order.complete);
}

#[test]
fn refuses_a_missing_id() {
    let ledger = fake(filter_rows(), false);
    let spaces = SpaceList(vec![]);
    let f = feed(&ledger, &spaces);
    assert_eq!(f.get(ALICE, "missing"), Err(FeedError::NotFound));
    assert_eq!(f.get(ALICE, "order:"), Err(FeedError::NotFound));
    assert_eq!(f.get(ALICE, "order:nope"), Err(FeedError::NotFound));
    let e = failure(FeedError::NotFound);
    assert_eq!(
        (e.code, e.cause.as_deref()),
        ("NOT_FOUND", Some("bank.activity_not_found"))
    );
}

#[test]
fn matches_a_private_note_in_search() {
    let ledger = fake(filter_rows(), false);
    let spaces = SpaceList(vec![]);
    let fee_id = feed(&ledger, &spaces)
        .list(ALICE, &lim(10))
        .unwrap()
        .items
        .into_iter()
        .find(|i| i.tx_id == "tx-fee")
        .unwrap()
        .id;
    let r = Recs {
        notes: [(
            fee_id,
            Annotation {
                private_note: Some("birthday".into()),
                ..Annotation::default()
            },
        )]
        .into_iter()
        .collect(),
        addresses: None,
        ..recs()
    };
    let f = Feed {
        records: Some(&r),
        ..feed(&ledger, &spaces)
    };
    let found = f
        .list(
            ALICE,
            &Query {
                q: Some("birthday".into()),
                ..q()
            },
        )
        .unwrap();
    assert_eq!(
        found
            .items
            .iter()
            .map(|i| i.private_note.clone().unwrap())
            .collect::<Vec<_>>(),
        vec!["birthday"]
    );
}

// ── Notes: the report description and the has-note filter ──────────────────────

/// The notes suite's ledger: three lines on the main account, one page.
struct Three;

impl HistoryPages for Three {
    fn page(&self, r: &PageRequest) -> Result<LedgerPage, String> {
        if r.cursor.is_some() || r.owner_type != "user" {
            return Ok(LedgerPage {
                entries: vec![],
                next_cursor: None,
            });
        }
        let e = |tx: &str, seq: i64| PageEntry {
            tx_id: tx.to_owned(),
            module: "bank".into(),
            reason: "bank.transfer.manual".into(),
            direction: "debit".into(),
            amount: parse_amount("1").unwrap(),
            posted_at: Instant(OCT1 + seq * 1000),
            asset_id: "USDT".into(),
            entry_id: Some(seq.to_string()),
            rail: None,
            product: None,
            order_id: None,
            withdrawal_id: None,
            fee: None,
        };
        Ok(LedgerPage {
            entries: vec![e("tx-3", 3), e("tx-2", 2), e("tx-1", 1)],
            next_cursor: None,
        })
    }
}

fn noted() -> Recs {
    Recs {
        notes: [
            (
                "tx-1".to_owned(),
                Annotation {
                    private_note: Some("rent".into()),
                    ..Annotation::default()
                },
            ),
            (
                "tx-2".to_owned(),
                Annotation {
                    report_description: Some("Office rent, October".into()),
                    ..Annotation::default()
                },
            ),
        ]
        .into_iter()
        .collect(),
        by_tx: true,
        addresses: None,
        notes_fail: false,
    }
}

#[test]
fn shows_the_description_on_its_line_only() {
    let spaces = SpaceList(vec![]);
    let r = noted();
    let all = Feed {
        records: Some(&r),
        ..feed(&Three, &spaces)
    }
    .list(ALICE, &q())
    .unwrap()
    .items;
    let d = |tx: &str| {
        all.iter()
            .find(|i| i.tx_id == tx)
            .unwrap()
            .report_description
            .clone()
    };
    assert_eq!(d("tx-2").as_deref(), Some("Office rent, October"));
    assert_eq!(d("tx-1"), None);
    assert_eq!(d("tx-3"), None);
}

#[test]
fn keeps_only_lines_with_a_note_or_a_description() {
    let spaces = SpaceList(vec![]);
    let r = noted();
    let out = Feed {
        records: Some(&r),
        ..feed(&Three, &spaces)
    }
    .list(
        ALICE,
        &Query {
            has_note: Some(true),
            ..q()
        },
    )
    .unwrap();
    let mut got = txs(&out.items);
    got.sort();
    assert_eq!(got, vec!["tx-1", "tx-2"]);
}

#[test]
fn fails_the_read_not_shows_an_empty_list_when_notes_cannot_be_read_during_the_filter() {
    let spaces = SpaceList(vec![]);
    let broken = Recs {
        notes_fail: true,
        ..noted()
    };
    let f = Feed {
        records: Some(&broken),
        ..feed(&Three, &spaces)
    };
    let has = Query {
        has_note: Some(true),
        ..q()
    };
    assert_eq!(f.list(ALICE, &has), Err(FeedError::Unavailable));
    assert_eq!(f.list(ALICE, &q()).unwrap().items.len(), 3);
    assert_eq!(
        feed(&Three, &spaces).list(ALICE, &has),
        Err(FeedError::Unavailable)
    );
}

// ── The detail lookup's page boundary ───────────────────────────────────────────

/// The boundary suite's ledger: 99 newer deposits, then a fill's two legs at one instant, paged by entry id.
struct Boundary(Vec<PageEntry>);

impl HistoryPages for Boundary {
    fn page(&self, r: &PageRequest) -> Result<LedgerPage, String> {
        let before = r.cursor.as_deref().map_or(i64::MAX, seq_of);
        let rows: Vec<PageEntry> = self
            .0
            .iter()
            .filter(|e| e.entry_id.as_deref().unwrap().parse::<i64>().unwrap() < before)
            .cloned()
            .collect();
        let entries: Vec<PageEntry> = rows.iter().take(r.limit).cloned().collect();
        let next = (rows.len() > r.limit).then(|| {
            b64(&format!(
                "v2.{}",
                entries.last().unwrap().entry_id.as_deref().unwrap()
            ))
        });
        Ok(LedgerPage {
            entries,
            next_cursor: next,
        })
    }
}

#[test]
fn opens_both_trade_legs_when_the_detail_lookup_page_ends_between_them() {
    let at = js_date("2026-10-13T00:00:00Z").unwrap().0;
    let e = |tx: String,
             id: i64,
             module: &str,
             reason: &str,
             dir: &str,
             amount: &str,
             asset: &str,
             t: i64| PageEntry {
        tx_id: tx,
        module: module.into(),
        reason: reason.into(),
        direction: dir.into(),
        amount: parse_amount(amount).unwrap(),
        posted_at: Instant(t),
        asset_id: asset.into(),
        entry_id: Some(id.to_string()),
        rail: None,
        product: None,
        order_id: None,
        withdrawal_id: None,
        fee: None,
    };
    let mut rows: Vec<PageEntry> = (0..99)
        .map(|i| {
            e(
                format!("deposit-{i}"),
                200 - i,
                "ledger",
                "deposit.credited",
                "debit",
                "1",
                "USDT",
                at + 100 - i,
            )
        })
        .collect();
    rows.push(e(
        "fill".into(),
        101,
        "trade",
        "trade.fill",
        "debit",
        "1",
        "BTC",
        at,
    ));
    rows.push(e(
        "fill".into(),
        100,
        "trade",
        "trade.fill",
        "credit",
        "100",
        "USDT",
        at,
    ));
    let ledger = Boundary(rows);
    let spaces = SpaceList(vec![]);
    let f = Feed {
        secret: Some("activity-test-secret"),
        ..feed(&ledger, &spaces)
    };
    let page = f.list(ALICE, &lim(200)).unwrap();
    let legs: Vec<&Item> = page.items.iter().filter(|l| l.tx_id == "fill").collect();
    assert_eq!(legs.len(), 2);
    for item in legs {
        let detail = f.get(ALICE, &item.id).unwrap();
        assert_eq!(detail.item.id, item.id);
        assert_eq!(
            detail
                .lines
                .iter()
                .map(|l| l.asset.as_str())
                .collect::<Vec<_>>(),
            vec!["BTC", "USDT"]
        );
        assert!(detail.complete);
    }
}

// ── The partner's record ────────────────────────────────────────────────────────

struct Book(Vec<Move>);

impl PartnerBook for Book {
    fn holds(&self, _: &str) -> bool {
        true
    }
    fn moves(&self, user_id: &str, q: &MovesQuery) -> Result<Vec<Move>, FeedError> {
        let mine: Vec<&Move> = self
            .0
            .iter()
            .rev()
            .filter(|m| m.from.user_id == user_id || m.to.user_id == user_id)
            .collect();
        let start = q.before.as_ref().map_or(0, |b| {
            mine.iter()
                .position(|m| &m.id == b)
                .map_or(mine.len(), |p| p + 1)
        });
        Ok(mine
            .into_iter()
            .skip(start)
            .take(q.limit)
            .cloned()
            .collect())
    }
}

fn mv(
    id: &str,
    from: (&str, Option<&str>),
    to: (&str, Option<&str>),
    amount: &str,
    at: i64,
) -> Move {
    let acct = |(u, s): (&str, Option<&str>)| crate::partner::AccountRef {
        user_id: u.to_owned(),
        asset_id: "EUR".to_owned(),
        space_id: s.map(str::to_owned),
    };
    Move {
        id: id.to_owned(),
        key: id.to_owned(),
        from: acct(from),
        to: acct(to),
        amount: parse_amount(amount).unwrap(),
        moved_at: Instant(OCT1 + at),
        label: crate::partner::LABEL,
        payees: None,
    }
}

#[test]
fn the_partners_history_is_its_own_record_whole_moves_per_page_and_refuses_what_it_cannot_filter() {
    let book = Book(vec![
        mv(
            "move-1",
            (crate::partner::PAY_INS_OWNER, None),
            (ALICE, None),
            "100",
            1,
        ),
        mv("move-2", (ALICE, None), (ALICE, Some(SPACE)), "40", 2),
        mv("move-3", (ALICE, None), (BOB, None), "5", 3),
    ]);
    let spaces = rent();
    let f = Feed {
        partner: Some(&book),
        ..feed(&Down, &spaces)
    };
    let page = f.list(ALICE, &q()).unwrap();
    let shape: Vec<(&str, &str, &str, Option<String>)> = page
        .items
        .iter()
        .map(|i| (i.id.as_str(), i.kind, i.direction, i.space_name.clone()))
        .collect();
    assert_eq!(
        shape,
        vec![
            ("move-3.out", "transfer_out", "out", None),
            ("move-2.out", "space_move", "out", None),
            ("move-2.in", "space_move", "in", Some("Rent".to_owned())),
            ("move-1.in", "deposit", "in", None),
        ]
    );
    assert!(
        page.items
            .iter()
            .all(|i| i.held_at.as_deref() == Some(crate::partner::LABEL))
    );
    // A page of one line still holds both lines of a move between her own spaces.
    let one = f
        .list(
            ALICE,
            &Query {
                limit: Some(2),
                ..q()
            },
        )
        .unwrap();
    assert_eq!(one.items.len(), 1);
    assert_eq!(one.next_cursor.as_deref(), Some("move-3"));
    let two = f
        .list(
            ALICE,
            &Query {
                limit: Some(1),
                cursor: one.next_cursor,
                ..q()
            },
        )
        .unwrap();
    assert_eq!(
        two.items.iter().map(|i| i.id.as_str()).collect::<Vec<_>>(),
        vec!["move-2.out", "move-2.in"]
    );
    for (x, code) in [
        (asc(5), "bank.partner_history_filter_unsupported"),
        (addr("0x12"), "bank.partner_history_filter_unsupported"),
        (
            Query {
                has_note: Some(true),
                ..q()
            },
            "bank.partner_history_filter_unsupported",
        ),
    ] {
        match f.list(ALICE, &x) {
            Err(FeedError::Bank(b)) => assert_eq!(b.row.code, code),
            other => panic!("{other:?}"),
        }
    }
    assert_eq!(
        f.list(
            ALICE,
            &Query {
                cursor: Some("not a cursor".into()),
                ..q()
            }
        ),
        Err(FeedError::CursorInvalid)
    );
    let found = f.get(ALICE, "move-2.in").unwrap();
    assert_eq!(found.item.id, "move-2.in");
    assert_eq!(found.lines.len(), 2);
    assert_eq!(f.get(ALICE, "move-9.in"), Err(FeedError::NotFound));
}

#[test]
fn collect_gathers_every_matching_line_in_the_range_newest_first() {
    let ledger = fake(seven(), false);
    let spaces = rent();
    let f = feed(&ledger, &spaces);
    let got = f
        .collect(
            ALICE,
            &CollectQuery {
                from: Instant(OCT1 + 2000).iso(),
                to: Instant(OCT1 + 6000).iso(),
                limit: 4,
                ..CollectQuery::default()
            },
        )
        .unwrap();
    assert_eq!(txs(&got), vec!["tx-6", "tx-5", "tx-4", "tx-3"]);
}

#[test]
fn the_router_answers_each_refusal_as_activity_failure_does() {
    let e = failure(FeedError::CursorInvalid);
    assert_eq!((e.code, e.cause), ("BAD_REQUEST", None));
    let e = failure(FeedError::Range);
    assert_eq!(
        (e.code, e.message.as_str(), e.cause.as_deref()),
        (
            "BAD_REQUEST",
            "The end of the range is before the start",
            Some("bank.activity_range")
        )
    );
    let e = failure(FeedError::Thrown("BAD_REQUEST"));
    assert_eq!(
        (e.code, e.message.as_str(), e.cause.as_deref()),
        (
            "INTERNAL_SERVER_ERROR",
            "Something went wrong. Please try again.",
            Some("BAD_REQUEST")
        )
    );
    let e = failure(FeedError::Other(StoreError::new("bad uuid", Some("22P02"))));
    assert_eq!(
        (e.code, e.cause.as_deref()),
        ("INTERNAL_SERVER_ERROR", Some("22P02"))
    );
    let e = failure(bank(
        "bank.activity_filter_limit_unset",
        "Saved filter page size is required; blank is not 50",
    ));
    assert_eq!(
        (e.code, e.message.as_str()),
        (
            "BAD_REQUEST",
            "Saved filter page size is required; blank is not 50 (bank.activity_filter_limit_unset)"
        )
    );
}
