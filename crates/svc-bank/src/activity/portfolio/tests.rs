//! `PortfolioService` over stand-in ports: the checks of `allocation.test.ts`, `portfolio.router.test.ts`,
//! `wallet-balances.test.ts`, `balance-breakdown.test.ts`, `balance-entries.test.ts` and the service half of
//! `value-history.test.ts`, each named after the TypeScript test's words. All figures are TEST data.
//!
//! Not ported here, and why:
//! - "refuses an anonymous caller and a token without bank:read, and reads nothing" (summary and breakdown): the door's
//!   guard answers before the slice, held for every call by `tests/guard_grid.rs` and `tests/wire_replay.rs`.
//! - The smuggled-input halves ("no input can name another user", a `userId` or malformed `accountId` or `scope` in
//!   the input): the door's input check strips or refuses them (`tests/input_parity.rs`); the handler never sees them.
//! - "times out on a hung svc-trade (either call)": the timeout is the transport's (`HttpRequest.timeout_ms`, 3 s);
//!   a timed-out fetch is a failed fetch, covered by "refuses on a 5xx ... and a refused connection" in `tickers.rs`.

#![allow(clippy::unwrap_used, clippy::indexing_slicing, reason = "a test")]

use std::collections::HashMap;
use std::sync::Mutex;

use service_kit::json::Json;
use service_kit::money::{Amount, format_amount, parse_amount};
use service_kit::time::Instant;

use super::candles::{CloseSeries, CloseSource};
use super::history::tests::{DAY, daily, day, main_history, savings_history};
use super::history::{HistoryError, Holdings, HoldingsHistory};
use super::service::{EntriesInput, Fail, FeeReads, Named, Service, SpaceLister, SummaryInput};
use super::tickers::TickerSource;
use super::valuation::{PriceBook, TickerQuote};
use crate::activity::pages::{HistoryPages, Page, PageEntry, PageRequest};
use crate::errors::Refusal;
use crate::spaces::ports::{Ledger, LedgerAccount, LedgerBalance};

const ALICE: &str = "11111111-1111-4111-8111-111111111111";
const BOB: &str = "22222222-2222-4222-8222-222222222222";
const SPACE: &str = "44444444-4444-4444-8444-444444444444";
const BOBS_SPACE: &str = "55555555-5555-4555-8555-555555555555";
const CLOSED: &str = "66666666-6666-4666-8666-666666666666";

fn amt(s: &str) -> Amount {
    parse_amount(s).unwrap()
}

/// One balance row: (owner type, owner id, asset, kind, amount, purpose).
#[derive(Clone)]
struct Row(
    &'static str,
    String,
    &'static str,
    &'static str,
    Amount,
    &'static str,
);

fn user(owner: &str, asset: &'static str, kind: &'static str, amount: &str) -> Row {
    Row("user", owner.to_owned(), asset, kind, amt(amount), "")
}

fn sub(owner: &str, asset: &'static str, kind: &'static str, amount: &str) -> Row {
    Row("subaccount", owner.to_owned(), asset, kind, amt(amount), "")
}

fn with_purpose(mut r: Row, purpose: &'static str) -> Row {
    r.5 = purpose;
    r
}

/// A ledger that answers for any owner it has rows for, records who was asked, and lists `registry` as the asset
/// registry (`None`: the registry read fails).
struct FakeLedger {
    rows: Vec<Row>,
    asked: Mutex<Vec<(String, String)>>,
    registry: Option<Vec<(&'static str, &'static str)>>,
    down: bool,
}

fn ledger(rows: Vec<Row>) -> FakeLedger {
    FakeLedger {
        rows,
        asked: Mutex::new(Vec::new()),
        registry: Some(vec![
            ("BTC", "crypto"),
            ("ETH", "crypto"),
            ("IFC", "native"),
            ("XAU", "commodity"),
        ]),
        down: false,
    }
}

impl FakeLedger {
    fn asked(&self) -> Vec<(String, String)> {
        self.asked.lock().unwrap().clone()
    }
}

impl Ledger for FakeLedger {
    fn balance(&self, _: &LedgerAccount) -> Result<Amount, String> {
        Err("unused".to_owned())
    }
    fn balances(&self, owner_type: &str, owner_id: &str) -> Result<Vec<LedgerBalance>, String> {
        if self.down {
            return Err("ledger down".to_owned());
        }
        self.asked
            .lock()
            .unwrap()
            .push((owner_type.to_owned(), owner_id.to_owned()));
        Ok(self
            .rows
            .iter()
            .filter(|r| r.0 == owner_type && r.1 == owner_id)
            .map(|r| LedgerBalance {
                asset_id: r.2.to_owned(),
                kind: r.3.to_owned(),
                purpose: r.5.to_owned(),
                amount: r.4,
            })
            .collect())
    }
    fn assets(&self) -> Result<Vec<Json>, String> {
        let rows = self.registry.as_ref().ok_or("ledger down")?;
        Ok(rows
            .iter()
            .map(|(id, kind)| Json::obj([("id", Json::str(*id)), ("kind", Json::str(*kind))]))
            .collect())
    }
}

fn named(id: &str, user_id: &str) -> Named {
    Named {
        id: id.to_owned(),
        user_id: user_id.to_owned(),
        kind: "named".to_owned(),
        name: "Savings".to_owned(),
    }
}

/// A Space list: like the real one it answers only for the person asked about, unless `leaky`.
struct FakeSpaces {
    all: Vec<Named>,
    every: Option<Vec<Named>>,
    leaky: bool,
    down: bool,
}

fn spaces(all: Vec<Named>) -> FakeSpaces {
    FakeSpaces {
        all,
        every: None,
        leaky: false,
        down: false,
    }
}

impl SpaceLister for FakeSpaces {
    fn named_spaces(&self, user_id: &str) -> Result<Vec<Named>, Refusal> {
        if self.down {
            return Err(Refusal::Other("spaces down".to_owned()));
        }
        Ok(self
            .all
            .iter()
            .filter(|s| self.leaky || s.user_id == user_id)
            .cloned()
            .collect())
    }
    fn all_named_spaces(&self, user_id: &str) -> Result<Vec<Named>, Refusal> {
        match &self.every {
            Some(e) => Ok(e.clone()),
            None => self.named_spaces(user_id),
        }
    }
}

/// svc-trade's tickers: `None` is a source that fails; the number of reads is kept.
struct FakeTrade {
    book: Option<PriceBook>,
    calls: Mutex<usize>,
}

fn quote(last: Option<&str>, open: Option<&str>) -> TickerQuote {
    TickerQuote {
        last: last.map(amt),
        open: open.map(amt),
        window_start: None,
    }
}

fn trade(rows: &[(&str, TickerQuote)], extra_listed: &[&str]) -> FakeTrade {
    FakeTrade {
        book: Some(PriceBook {
            tickers: rows
                .iter()
                .map(|(k, v)| ((*k).to_owned(), v.clone()))
                .collect(),
            listed: rows
                .iter()
                .map(|(k, _)| (*k).to_owned())
                .chain(extra_listed.iter().map(|s| (*s).to_owned()))
                .collect(),
        }),
        calls: Mutex::new(0),
    }
}

/// Every market at one last price and the same open.
fn prices(rows: &[(&str, &str)]) -> FakeTrade {
    let q: Vec<(&str, TickerQuote)> = rows
        .iter()
        .map(|(k, v)| (*k, quote(Some(v), Some(v))))
        .collect();
    trade(&q, &[])
}

fn no_trade() -> FakeTrade {
    FakeTrade {
        book: None,
        calls: Mutex::new(0),
    }
}

impl TickerSource for FakeTrade {
    fn prices(&self) -> Result<PriceBook, String> {
        *self.calls.lock().unwrap() += 1;
        self.book
            .clone()
            .ok_or_else(|| "connect ECONNREFUSED 127.0.0.1:4004".to_owned())
    }
}

struct NoFees;

impl FeeReads for NoFees {
    fn fees_for(&self, _: &str, _: &[String]) -> Result<HashMap<String, String>, String> {
        Err("unwired".to_owned())
    }
}

/// History pages by "<ownerType>:<ownerId>", a page of `size`, failing from read `fail_at` on.
struct FakePages {
    history: HashMap<String, Vec<PageEntry>>,
    size: usize,
    fail_at: Option<usize>,
    calls: Mutex<usize>,
    wired: bool,
}

fn pages(history: Vec<(String, Vec<PageEntry>)>) -> FakePages {
    FakePages {
        history: history.into_iter().collect(),
        size: 200,
        fail_at: None,
        calls: Mutex::new(0),
        wired: true,
    }
}

impl HistoryPages for FakePages {
    fn page(&self, r: &PageRequest) -> Result<Page, String> {
        let mut calls = self.calls.lock().unwrap();
        *calls += 1;
        if !self.wired || self.fail_at.is_some_and(|f| *calls >= f) {
            return Err("ledger down".to_owned());
        }
        let all: Vec<PageEntry> = self
            .history
            .get(&format!("{}:{}", r.owner_type, r.owner_id))
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter(|e| Some(&e.asset_id) == r.asset_id.as_ref())
            .collect();
        let start: usize = r.cursor.as_deref().map_or(0, |c| c.parse().unwrap());
        let entries: Vec<PageEntry> = all.iter().skip(start).take(self.size).cloned().collect();
        Ok(Page {
            entries,
            next_cursor: (start + self.size < all.len()).then(|| (start + self.size).to_string()),
        })
    }
}

/// svc-ledger's holdings history: main for the person, nothing for the closed Space, savings for any other; or one
/// failure for every read. Every read is kept.
struct FakeHistory {
    fail: Option<HistoryError>,
    asked: Mutex<Vec<(String, String, String, i64)>>,
}

impl HoldingsHistory for FakeHistory {
    fn holdings_history(
        &self,
        t: &str,
        id: &str,
        from: &str,
        bucket: i64,
    ) -> Result<Holdings, HistoryError> {
        self.asked
            .lock()
            .unwrap()
            .push((t.to_owned(), id.to_owned(), from.to_owned(), bucket));
        if let Some(f) = &self.fail {
            return Err(f.clone());
        }
        Ok(if t == "user" {
            main_history()
        } else if id == CLOSED {
            Holdings::default()
        } else {
            savings_history()
        })
    }
}

/// The daily BTC candles, or a failure.
struct FakeCloses(bool);

impl CloseSource for FakeCloses {
    fn closes(
        &self,
        _: &str,
        _: &str,
        _: Instant,
        _: Instant,
    ) -> Result<Option<CloseSeries>, String> {
        if self.0 {
            Ok(Some(daily(0)))
        } else {
            Err("timeout".to_owned())
        }
    }
}

/// 2026-10-19T08:00:00Z.
const NOW: i64 = 1_792_396_800_000;

struct World {
    ledger: FakeLedger,
    spaces: FakeSpaces,
    trade: FakeTrade,
    pages: FakePages,
    history: FakeHistory,
    closes: FakeCloses,
    now: i64,
}

fn world(ledger: FakeLedger, spaces: FakeSpaces, trade: FakeTrade) -> World {
    World {
        ledger,
        spaces,
        trade,
        pages: FakePages {
            wired: false,
            ..pages(Vec::new())
        },
        history: FakeHistory {
            fail: None,
            asked: Mutex::new(Vec::new()),
        },
        closes: FakeCloses(true),
        now: NOW,
    }
}

impl World {
    fn svc(&self) -> Service<'_> {
        Service {
            ledger: &self.ledger,
            spaces: &self.spaces,
            tickers: &self.trade,
            pages: &self.pages,
            history: &self.history,
            closes: &self.closes,
            fees: &NoFees,
            now: Instant(self.now),
        }
    }
}

fn s(j: &Json, key: &str) -> Option<String> {
    match j.get(key) {
        Some(Json::String(v)) => Some(v.clone()),
        _ => None,
    }
}

fn list<'j>(j: &'j Json, key: &str) -> &'j [Json] {
    match j.get(key) {
        Some(Json::Array(a)) => a,
        _ => &[],
    }
}

fn code(r: &Refusal) -> &str {
    match r {
        Refusal::Bank(e) => e.row.code,
        _ => "",
    }
}

// ---- allocation.test.ts ----

fn alloc_rows() -> Vec<Row> {
    vec![
        user(ALICE, "USDT", "available", "1000"),
        user(ALICE, "USDC", "available", "500"),
        user(ALICE, "USD", "available", "250"),
        user(ALICE, "BTC", "available", "0.5"),
        user(ALICE, "BTC", "hold", "0.25"),
        with_purpose(user(ALICE, "ETH", "stake", "2"), "bank:earn:p1"),
        user(ALICE, "IFC", "available", "40"),
        user(BOB, "USDT", "available", "999999"),
    ]
}

fn alloc_prices() -> FakeTrade {
    // DOGE/USDT is listed with no usable price, as the TypeScript's stand-in lists it.
    let q = [
        ("BTC/USDT", quote(Some("60000"), None)),
        ("ETH/USDT", quote(Some("3000"), None)),
        ("DOGE/USDT", quote(Some("0"), None)),
    ];
    trade(&q, &[])
}

fn classes(out: &Json) -> Vec<(String, String)> {
    list(out, "classes")
        .iter()
        .map(|c| (s(c, "class").unwrap(), s(c, "valueUsd").unwrap()))
        .collect()
}

fn types(out: &Json) -> Vec<(String, String)> {
    list(out, "types")
        .iter()
        .map(|c| (s(c, "type").unwrap(), s(c, "valueUsd").unwrap()))
        .collect()
}

fn pairs(v: &[(&str, &str)]) -> Vec<(String, String)> {
    v.iter()
        .map(|(a, b)| ((*a).to_owned(), (*b).to_owned()))
        .collect()
}

#[test]
fn groups_the_priced_holdings_by_class_and_by_available_locked_adding_up_to_the_total() {
    let w = world(ledger(alloc_rows()), spaces(vec![]), alloc_prices());
    let out = w.svc().allocation(ALICE).unwrap().json();
    assert_eq!(s(&out, "totalValueUsd").as_deref(), Some("52750"));
    assert_eq!(
        classes(&out),
        pairs(&[
            ("fiat", "250"),
            ("stablecoin", "1500"),
            ("crypto", "45000"),
            ("earn", "6000")
        ])
    );
    assert_eq!(
        list(&out, "classes")[2].get("assets").unwrap().compact(),
        r#"[{"asset":"BTC","valueUsd":"45000","share":"0.853080568720379147"}]"#
    );
    assert_eq!(
        list(&out, "classes")[3].get("assets").unwrap().compact(),
        r#"[{"asset":"ETH","valueUsd":"6000","share":"0.113744075829383886"}]"#
    );
    assert_eq!(
        out.get("types").unwrap().compact(),
        r#"[{"type":"available","valueUsd":"31750","share":"0.601895734597156398"},{"type":"locked","valueUsd":"21000","share":"0.398104265402843602"}]"#
    );
    assert_eq!(
        out.get("unpriced").unwrap().compact(),
        r#"[{"asset":"IFC","amount":"40","reason":"no_market"}]"#
    );
    assert_eq!(out.get("asOf"), Some(&Json::int(NOW)));
    let total = amt(&s(&out, "totalValueUsd").unwrap());
    let class_sum: Amount = classes(&out).iter().map(|(_, v)| amt(v)).sum();
    let type_sum: Amount = types(&out).iter().map(|(_, v)| amt(v)).sum();
    assert_eq!((class_sum, type_sum), (total, total));
}

#[test]
fn splits_one_coin_between_its_class_and_earn_by_the_stake_part_both_adding_up_to_its_value() {
    let w = world(
        ledger(vec![
            user(ALICE, "USDT", "available", "70"),
            with_purpose(user(ALICE, "USDT", "stake", "30"), "bank:earn:p2"),
            user(ALICE, "USDT", "hold", "5"),
        ]),
        spaces(vec![]),
        alloc_prices(),
    );
    let out = w.svc().allocation(ALICE).unwrap().json();
    assert_eq!(s(&out, "totalValueUsd").as_deref(), Some("105"));
    assert_eq!(
        classes(&out),
        pairs(&[("stablecoin", "75"), ("earn", "30")])
    );
    assert_eq!(types(&out), pairs(&[("available", "70"), ("locked", "35")]));
}

#[test]
fn names_a_priced_asset_the_registry_does_not_list_as_unclassified_and_still_counts_it() {
    let mut l = ledger(vec![
        user(ALICE, "USDT", "available", "100"),
        user(ALICE, "BTC", "available", "0.001"),
    ]);
    l.registry = Some(vec![("ETH", "crypto")]);
    let w = world(l, spaces(vec![]), alloc_prices());
    let out = w.svc().allocation(ALICE).unwrap().json();
    assert_eq!(s(&out, "totalValueUsd").as_deref(), Some("160"));
    assert_eq!(
        out.get("classes").unwrap().compact(),
        r#"[{"class":"stablecoin","valueUsd":"100","share":"0.625","assets":[{"asset":"USDT","valueUsd":"100","share":"0.625"}]},{"class":"unclassified","valueUsd":"60","share":"0.375","assets":[{"asset":"BTC","valueUsd":"60","share":"0.375"}]}]"#
    );
}

#[test]
fn classes_a_commodity_and_a_fiat_currency_from_the_registry_kind() {
    let mut l = ledger(vec![
        user(ALICE, "XAU", "available", "1"),
        user(ALICE, "EUR", "available", "10"),
    ]);
    l.registry = Some(vec![("XAU", "commodity"), ("EUR", "fiat")]);
    let w = world(
        l,
        spaces(vec![]),
        prices(&[("XAU/USDT", "2400"), ("EUR/USDT", "1.1")]),
    );
    let out = w.svc().allocation(ALICE).unwrap().json();
    assert_eq!(
        classes(&out),
        pairs(&[("fiat", "11"), ("commodity", "2400")])
    );
}

#[test]
fn leaves_the_classes_out_naming_why_when_the_registry_is_not_connected_or_fails_and_still_gives_the_places()
 {
    let mut l = ledger(alloc_rows());
    l.registry = None;
    let w = world(l, spaces(vec![]), alloc_prices());
    let out = w.svc().allocation(ALICE).unwrap().json();
    assert!(list(&out, "classes").is_empty());
    assert_eq!(
        s(&out, "classesRefused").as_deref(),
        Some("bank.asset_registry_unavailable")
    );
    assert_eq!(s(&out, "totalValueUsd").as_deref(), Some("52750"));
    let type_sum: Amount = types(&out).iter().map(|(_, v)| amt(v)).sum();
    assert_eq!(type_sum, amt("52750"));
    // Cash only needs no registry.
    let mut cash = ledger(vec![user(ALICE, "USD", "available", "5")]);
    cash.registry = None;
    let w = world(cash, spaces(vec![]), no_trade());
    let out = w.svc().allocation(ALICE).unwrap().json();
    assert_eq!(classes(&out), pairs(&[("fiat", "5")]));
    assert_eq!(out.get("classesRefused"), Some(&Json::Null));
}

#[test]
fn counts_a_token_stake_in_its_coins_class_not_earn() {
    let w = world(
        ledger(vec![with_purpose(
            user(ALICE, "ETH", "stake", "1"),
            "token:stake:s1",
        )]),
        spaces(vec![]),
        alloc_prices(),
    );
    let out = w.svc().allocation(ALICE).unwrap().json();
    assert_eq!(classes(&out), pairs(&[("crypto", "3000")]));
    assert_eq!(
        types(&out),
        pairs(&[("available", "0"), ("locked", "3000")])
    );
}

#[test]
fn never_includes_another_users_money() {
    let w = world(ledger(alloc_rows()), spaces(vec![]), alloc_prices());
    let out = w.svc().allocation(BOB).unwrap().json();
    assert_eq!(s(&out, "totalValueUsd").as_deref(), Some("999999"));
    assert_eq!(classes(&out), pairs(&[("stablecoin", "999999")]));
}

#[test]
fn answers_an_empty_book_with_no_groups_and_no_invented_share() {
    let w = world(ledger(vec![]), spaces(vec![]), alloc_prices());
    let out = w.svc().allocation(ALICE).unwrap().json();
    assert_eq!(s(&out, "totalValueUsd").as_deref(), Some("0"));
    assert!(list(&out, "classes").is_empty() && list(&out, "types").is_empty());
    assert!(list(&out, "unpriced").is_empty());
}

#[test]
fn keeps_an_unpriced_coin_out_of_every_share() {
    let w = world(
        ledger(vec![user(ALICE, "IFC", "available", "40")]),
        spaces(vec![]),
        alloc_prices(),
    );
    let out = w.svc().allocation(ALICE).unwrap().json();
    assert_eq!(s(&out, "totalValueUsd").as_deref(), Some("0"));
    assert!(list(&out, "classes").is_empty());
    assert_eq!(
        out.get("unpriced").unwrap().compact(),
        r#"[{"asset":"IFC","amount":"40","reason":"no_market"}]"#
    );
}

#[test]
fn refuses_bank_prices_unavailable_when_a_priced_coin_is_held_and_there_is_no_price_source() {
    let w = world(ledger(alloc_rows()), spaces(vec![]), no_trade());
    let err = w.svc().allocation(ALICE).unwrap_err();
    assert_eq!(code(&err), "bank.prices_unavailable");
    let t = crate::errors::to_trpc(err, String::new);
    assert!(t.message.contains("Prices can't be loaded"));
}

#[test]
fn needs_no_price_source_for_cash_only() {
    let w = world(
        ledger(vec![user(ALICE, "USDT", "available", "10")]),
        spaces(vec![]),
        no_trade(),
    );
    let out = w.svc().allocation(ALICE).unwrap().json();
    assert_eq!(
        out.get("classes").unwrap().compact(),
        r#"[{"class":"stablecoin","valueUsd":"10","share":"1","assets":[{"asset":"USDT","valueUsd":"10","share":"1"}]}]"#
    );
}

// ---- portfolio.router.test.ts ----

fn summary_rows() -> Vec<Row> {
    vec![
        user(ALICE, "USDT", "available", "1000"),
        user(ALICE, "BTC", "available", "0.5"),
        user(ALICE, "BTC", "hold", "0.25"),
        user(ALICE, "IFC", "available", "40"),
        user(BOB, "USDT", "available", "999999"),
    ]
}

fn summary(w: &World, who: &str, input: &SummaryInput<'_>) -> Result<Json, Refusal> {
    w.svc().summary(who, input)
}

fn plain(w: &World, who: &str) -> Result<Json, Refusal> {
    summary(w, who, &SummaryInput::default())
}

fn to_wire(r: Refusal) -> service_kit::trpc::TrpcError {
    crate::errors::to_trpc(r, String::new)
}

#[test]
fn returns_the_signed_in_users_server_computed_total_labelled_test_data() {
    let w = world(
        ledger(summary_rows()),
        spaces(vec![]),
        trade(&[("BTC/USDT", quote(Some("60000"), Some("59000")))], &[]),
    );
    let out = plain(&w, ALICE).unwrap();
    assert_eq!(
        out.compact(),
        format!(
            r#"{{"totalUsd":"46000.00","change24hUsd":"750.00","cashUsd":"1000.00","cryptoUsd":"45000.00","priced":[{{"asset":"BTC","amount":"0.75","priceUsd":"60000","valueUsd":"45000","change24hUsd":"750","pair":"BTC/USDT"}},{{"asset":"USDT","amount":"1000","priceUsd":"1","valueUsd":"1000","change24hUsd":"0","pair":null}}],"unpriced":[{{"asset":"IFC","amount":"40","reason":"no_market"}}],"asOf":{NOW},"windowStart":null}}"#
        )
    );
    assert_eq!(
        w.ledger.asked(),
        vec![("user".to_owned(), ALICE.to_owned())]
    );
}

#[test]
fn only_ever_reads_the_callers_own_balances_bobs_money_is_never_in_alices_total() {
    let w = world(ledger(summary_rows()), spaces(vec![]), trade(&[], &[]));
    let bobs = plain(&w, BOB).unwrap();
    assert_eq!(s(&bobs, "totalUsd").as_deref(), Some("999999.00"));
    assert_eq!(w.ledger.asked(), vec![("user".to_owned(), BOB.to_owned())]);
}

#[test]
fn refuses_service_unavailable_bank_prices_unavailable_when_trade_is_down_with_no_partial_total() {
    let w = world(ledger(summary_rows()), spaces(vec![]), no_trade());
    let err = to_wire(plain(&w, ALICE).unwrap_err());
    assert_eq!(err.code, "SERVICE_UNAVAILABLE");
    assert!(err.message.contains("bank.prices_unavailable"));
    assert!(!err.message.contains("ECONNREFUSED"));
}

#[test]
fn refuses_when_no_price_source_is_wired_at_all_instead_of_valuing_at_zero() {
    let w = World {
        ..world(ledger(summary_rows()), spaces(vec![]), no_trade())
    };
    let svc = Service {
        tickers: &super::tickers::NoTickers,
        ..w.svc()
    };
    let err = to_wire(svc.summary(ALICE, &SummaryInput::default()).unwrap_err());
    assert_eq!(err.code, "SERVICE_UNAVAILABLE");
}

#[test]
fn answers_a_stablecoin_only_user_while_trade_is_down_and_never_calls_trade_for_them() {
    let w = world(
        ledger(vec![
            user(ALICE, "USDC", "available", "12.34"),
            user(ALICE, "USD", "hold", "0.66"),
        ]),
        spaces(vec![]),
        trade(&[], &[]),
    );
    let out = plain(&w, ALICE).unwrap();
    for (k, v) in [
        ("totalUsd", "13.00"),
        ("cashUsd", "13.00"),
        ("cryptoUsd", "0.00"),
        ("change24hUsd", "0.00"),
    ] {
        assert_eq!(s(&out, k).as_deref(), Some(v));
    }
    assert_eq!(*w.trade.calls.lock().unwrap(), 0);
}

#[test]
fn on_todays_svc_trade_no_24_h_stats_yet_gives_the_total_and_a_null_change_not_a_guess() {
    let w = world(
        ledger(summary_rows()),
        spaces(vec![]),
        trade(&[("BTC/USDT", quote(Some("60000"), None))], &[]),
    );
    let out = plain(&w, ALICE).unwrap();
    assert_eq!(s(&out, "totalUsd").as_deref(), Some("46000.00"));
    assert_eq!(out.get("change24hUsd"), Some(&Json::Null));
    assert_eq!(
        list(&out, "priced")[0].get("change24hUsd"),
        Some(&Json::Null)
    );
}

#[test]
fn an_empty_ledger_is_an_honest_0_00() {
    let w = world(ledger(vec![]), spaces(vec![]), trade(&[], &[]));
    let out = plain(&w, ALICE).unwrap();
    assert_eq!(s(&out, "totalUsd").as_deref(), Some("0.00"));
    assert_eq!(s(&out, "change24hUsd").as_deref(), Some("0.00"));
    assert!(list(&out, "priced").is_empty() && list(&out, "unpriced").is_empty());
}

#[test]
fn end_to_end_a_dead_svc_trade_surfaces_as_service_unavailable_with_the_user_facing_sentence() {
    struct Dead;
    impl service_kit::http::Fetch for Dead {
        fn fetch(
            &self,
            _: &service_kit::http::HttpRequest,
        ) -> Result<service_kit::http::HttpResponse, service_kit::http::FetchError> {
            Err(service_kit::http::FetchError {
                message: "fetch failed".to_owned(),
            })
        }
    }
    let dead = super::tickers::HttpTickers::new("http://trade.test", Box::new(Dead), None);
    let w = world(
        ledger(vec![user(ALICE, "BTC", "available", "1")]),
        spaces(vec![]),
        no_trade(),
    );
    let svc = Service {
        tickers: &dead,
        ..w.svc()
    };
    let err = to_wire(svc.summary(ALICE, &SummaryInput::default()).unwrap_err());
    assert_eq!(err.code, "SERVICE_UNAVAILABLE");
    assert!(
        err.message
            .contains(super::valuation::PRICES_UNAVAILABLE_COPY)
    );
    assert!(err.message.contains("bank.prices_unavailable"));
}

fn listed_rows() -> Vec<Row> {
    vec![
        user(ALICE, "USDT", "available", "100"),
        user(ALICE, "BTC", "available", "1"),
        user(ALICE, "NEW", "available", "7"),
    ]
}

#[test]
fn refuses_when_markets_are_listed_but_tickers_carries_none_of_them_svc_matching_is_down() {
    let w = world(
        ledger(listed_rows()),
        spaces(vec![]),
        trade(&[], &["BTC/USDT", "ETH/USDT", "NEW/USDT"]),
    );
    let err = to_wire(plain(&w, ALICE).unwrap_err());
    assert_eq!(err.code, "SERVICE_UNAVAILABLE");
    assert!(err.message.contains("bank.prices_unavailable"));
}

#[test]
fn serves_the_total_when_only_one_listed_market_is_missing_and_lists_that_coin_as_no_price_yet() {
    let w = world(
        ledger(listed_rows()),
        spaces(vec![]),
        trade(
            &[("BTC/USDT", quote(Some("60000"), Some("59000")))],
            &["NEW/USDT"],
        ),
    );
    let out = plain(&w, ALICE).unwrap();
    assert_eq!(s(&out, "totalUsd").as_deref(), Some("60100.00"));
    assert_eq!(s(&out, "change24hUsd").as_deref(), Some("1000.00"));
    assert_eq!(
        out.get("unpriced").unwrap().compact(),
        r#"[{"asset":"NEW","amount":"7","reason":"no_price_yet"}]"#
    );
}

#[test]
fn a_coin_whose_usdt_market_is_missing_but_usdc_market_answers_is_priced_from_usdc() {
    let w = world(
        ledger(listed_rows()),
        spaces(vec![]),
        trade(
            &[
                ("BTC/USDT", quote(Some("60000"), None)),
                ("NEW/USDC", quote(Some("2"), Some("2"))),
            ],
            &["NEW/USDT"],
        ),
    );
    let out = plain(&w, ALICE).unwrap();
    let new = list(&out, "priced")
        .iter()
        .find(|r| s(r, "asset").as_deref() == Some("NEW"))
        .unwrap();
    assert_eq!(s(new, "pair").as_deref(), Some("NEW/USDC"));
    assert_eq!(s(new, "valueUsd").as_deref(), Some("14"));
    assert!(list(&out, "unpriced").is_empty());
}

#[test]
fn a_coin_with_no_usdt_or_usdc_market_at_all_is_unpriced_with_reason_no_market() {
    let w = world(
        ledger(vec![
            user(ALICE, "USDT", "available", "100"),
            user(ALICE, "IFC", "available", "5"),
            user(ALICE, "EUR", "available", "9"),
        ]),
        spaces(vec![]),
        trade(&[("BTC/USDT", quote(Some("60000"), Some("59000")))], &[]),
    );
    let out = plain(&w, ALICE).unwrap();
    assert_eq!(s(&out, "totalUsd").as_deref(), Some("100.00"));
    assert_eq!(
        out.get("unpriced").unwrap().compact(),
        r#"[{"asset":"EUR","amount":"9","reason":"no_market"},{"asset":"IFC","amount":"5","reason":"no_market"}]"#
    );
}

#[test]
fn stable_only_users_never_need_prices_even_when_listed_markets_exist() {
    let w = world(
        ledger(vec![user(ALICE, "USDT", "available", "3")]),
        spaces(vec![]),
        trade(&[], &["BTC/USDT"]),
    );
    assert_eq!(
        s(&plain(&w, ALICE).unwrap(), "totalUsd").as_deref(),
        Some("3.00")
    );
    assert_eq!(*w.trade.calls.lock().unwrap(), 0);
}

fn space_rows() -> Vec<Row> {
    vec![
        user(ALICE, "USDT", "available", "100"),
        user(ALICE, "BTC", "available", "0.1"),
        sub("space-alice-1", "BTC", "available", "0.4"),
        sub("space-alice-1", "BTC", "hold", "0.1"),
        sub("space-alice-2", "USDT", "available", "50"),
        user(BOB, "USDT", "available", "1"),
        sub("space-bob-1", "BTC", "available", "100"),
    ]
}

fn space_list() -> FakeSpaces {
    let mut primary = named("primary-alice", ALICE);
    primary.kind = "primary".to_owned();
    spaces(vec![
        named("space-alice-1", ALICE),
        named("space-alice-2", ALICE),
        primary,
        named("space-bob-1", BOB),
    ])
}

fn btc_60000() -> FakeTrade {
    trade(&[("BTC/USDT", quote(Some("60000"), Some("59000")))], &[])
}

fn btc_amount(out: &Json) -> String {
    let btc = list(out, "priced")
        .iter()
        .find(|r| s(r, "asset").as_deref() == Some("BTC"))
        .unwrap();
    s(btc, "amount").unwrap()
}

#[test]
fn counts_a_users_space_balances_free_and_locked_with_their_main_balance() {
    let w = world(ledger(space_rows()), space_list(), btc_60000());
    let out = plain(&w, ALICE).unwrap();
    assert_eq!(s(&out, "totalUsd").as_deref(), Some("36150.00"));
    assert_eq!(s(&out, "cashUsd").as_deref(), Some("150.00"));
    assert_eq!(s(&out, "cryptoUsd").as_deref(), Some("36000.00"));
    assert_eq!(s(&out, "change24hUsd").as_deref(), Some("600.00"));
    assert_eq!(btc_amount(&out), "0.6");
    let mut asked = w.ledger.asked();
    asked.sort();
    assert_eq!(
        asked,
        vec![
            ("subaccount".to_owned(), "space-alice-1".to_owned()),
            ("subaccount".to_owned(), "space-alice-2".to_owned()),
            ("user".to_owned(), ALICE.to_owned()),
        ]
    );
}

#[test]
fn never_reads_or_counts_another_users_space() {
    let w = world(ledger(space_rows()), space_list(), btc_60000());
    let out = plain(&w, ALICE).unwrap();
    assert!(!w.ledger.asked().iter().any(|(_, id)| id == "space-bob-1"));
    assert!(!btc_amount(&out).contains("100"));
    let bobs = plain(&w, BOB).unwrap();
    assert_eq!(btc_amount(&bobs), "100");
    assert_eq!(s(&bobs, "totalUsd").as_deref(), Some("6000001.00"));
}

#[test]
fn even_a_mis_scoped_space_list_cannot_pull_in_a_space_whose_owner_is_someone_else() {
    let mut leaky = spaces(vec![
        named("space-alice-1", ALICE),
        named("space-bob-1", BOB),
    ]);
    leaky.leaky = true;
    let w = world(ledger(space_rows()), leaky, btc_60000());
    plain(&w, ALICE).unwrap();
    assert!(!w.ledger.asked().iter().any(|(_, id)| id == "space-bob-1"));
}

#[test]
fn a_user_whose_only_crypto_sits_in_a_space_is_not_told_they_hold_nothing() {
    let w = world(
        ledger(vec![sub("space-alice-1", "BTC", "available", "1")]),
        spaces(vec![named("space-alice-1", ALICE)]),
        btc_60000(),
    );
    assert_eq!(
        s(&plain(&w, ALICE).unwrap(), "totalUsd").as_deref(),
        Some("60000.00")
    );
}

fn display_world() -> World {
    world(
        ledger(vec![
            user(ALICE, "USDT", "available", "1000"),
            user(ALICE, "BTC", "available", "0.5"),
            sub("space-alice-1", "BTC", "available", "1"),
            sub("space-bob-1", "BTC", "available", "100"),
        ]),
        spaces(vec![
            named("space-alice-1", ALICE),
            named("space-bob-1", BOB),
        ]),
        trade(&[("BTC/USDT", quote(Some("60000"), Some("60000")))], &[]),
    )
}

fn shown_in(currency: &str) -> SummaryInput<'_> {
    SummaryInput {
        display_currency: Some(currency),
        ..SummaryInput::default()
    }
}

#[test]
fn shows_btc_when_the_display_currency_is_btc_from_the_same_price_book() {
    let out = summary(&display_world(), ALICE, &shown_in("btc")).unwrap();
    assert_eq!(s(&out, "totalUsd").as_deref(), Some("91000.00"));
    assert_eq!(
        out.get("btc").unwrap().compact(),
        r#"{"total":"1.51666667","priceUsd":"60000","reason":null}"#
    );
}

#[test]
fn keeps_usd_and_adds_no_btc_block_when_the_display_currency_is_usd() {
    let out = summary(&display_world(), ALICE, &shown_in("USD")).unwrap();
    assert_eq!(s(&out, "totalUsd").as_deref(), Some("91000.00"));
    assert_eq!(out.get("btc"), None);
}

#[test]
fn refuses_a_currency_with_no_rate_source_by_name_and_never_falls_back_to_a_guess() {
    let err = summary(&display_world(), ALICE, &shown_in("EUR")).unwrap_err();
    assert_eq!(to_wire(err).code, "PRECONDITION_FAILED");
}

#[test]
fn scopes_to_main_to_one_named_space_and_the_parts_add_up_to_the_combined_total() {
    let w = display_world();
    let total = |scope| {
        let input = SummaryInput {
            scope: Some(scope),
            ..SummaryInput::default()
        };
        s(&summary(&w, ALICE, &input).unwrap(), "totalUsd").unwrap()
    };
    let (main, one, all) = (total("main"), total("space-alice-1"), total("combined"));
    assert_eq!(
        (main.as_str(), one.as_str(), all.as_str()),
        ("31000.00", "60000.00", "91000.00")
    );
    assert_eq!(amt(&main) + amt(&one), amt(&all));
}

#[test]
fn refuses_a_space_that_is_not_the_callers_without_reading_it() {
    let w = display_world();
    let input = SummaryInput {
        scope: Some("space-bob-1"),
        ..SummaryInput::default()
    };
    let err = to_wire(summary(&w, ALICE, &input).unwrap_err());
    assert_eq!(err.code, "NOT_FOUND");
    assert!(!w.ledger.asked().iter().any(|(_, id)| id == "space-bob-1"));
}

// ---- wallet-balances.test.ts ----

fn wallet_rows() -> Vec<Row> {
    vec![
        user(ALICE, "USDT", "available", "30000"),
        user(ALICE, "BTC", "available", "0.5"),
        with_purpose(user(ALICE, "BTC", "hold", "0.25"), "order:o-1"),
        sub(SPACE, "USDT", "available", "10000"),
        user(BOB, "USDT", "available", "999999"),
    ]
}

fn wallet_spaces() -> FakeSpaces {
    let mut bobs = named(BOBS_SPACE, BOB);
    bobs.name = "Bobs".to_owned();
    spaces(vec![named(SPACE, ALICE), bobs])
}

fn wallet(rows: Vec<Row>, trade: FakeTrade) -> World {
    world(ledger(rows), wallet_spaces(), trade)
}

fn in_btc() -> SummaryInput<'static> {
    SummaryInput {
        value_in: Some("btc"),
        ..SummaryInput::default()
    }
}

fn btc_block(out: &Json) -> String {
    out.get("btc").unwrap().compact()
}

#[test]
fn narrows_the_total_to_one_asset_whatever_its_case_and_leaves_the_rest_out() {
    let w = wallet(wallet_rows(), prices(&[("BTC/USDT", "60000")]));
    let btc = summary(
        &w,
        ALICE,
        &SummaryInput {
            asset_id: Some("btc"),
            ..SummaryInput::default()
        },
    )
    .unwrap();
    assert_eq!(list(&btc, "priced").len(), 1);
    assert_eq!(btc_amount(&btc), "0.75");
    assert_eq!(s(&btc, "totalUsd").as_deref(), Some("45000.00"));
    let usdt = summary(
        &w,
        ALICE,
        &SummaryInput {
            asset_id: Some("USDT"),
            ..SummaryInput::default()
        },
    )
    .unwrap();
    assert_eq!(s(&usdt, "totalUsd").as_deref(), Some("40000.00"));
    assert_eq!(usdt.get("btc"), None);
}

#[test]
fn values_the_whole_holding_in_btc_from_the_published_btc_price_to_8_decimals() {
    let w = wallet(wallet_rows(), prices(&[("BTC/USDT", "60000")]));
    let out = summary(&w, ALICE, &in_btc()).unwrap();
    assert_eq!(s(&out, "totalUsd").as_deref(), Some("85000.00"));
    assert_eq!(
        btc_block(&out),
        r#"{"total":"1.41666667","priceUsd":"60000","reason":null}"#
    );
}

#[test]
fn values_a_btc_holding_at_exactly_its_amount_and_falls_back_to_btc_usdc() {
    let w = wallet(
        vec![user(ALICE, "BTC", "available", "0.12345678")],
        prices(&[("BTC/USDC", "71234.5")]),
    );
    let out = summary(&w, ALICE, &in_btc()).unwrap();
    assert_eq!(
        s(out.get("btc").unwrap(), "total").as_deref(),
        Some("0.12345678")
    );
}

#[test]
fn says_no_price_is_published_and_shows_no_number_when_there_is_no_btc_market_price() {
    let w = wallet(
        vec![user(ALICE, "USDT", "available", "100")],
        prices(&[("ETH/USDT", "3000")]),
    );
    let out = summary(&w, ALICE, &in_btc()).unwrap();
    assert_eq!(s(&out, "totalUsd").as_deref(), Some("100.00"));
    assert_eq!(
        btc_block(&out),
        r#"{"total":null,"priceUsd":null,"reason":"no_price_published"}"#
    );
}

#[test]
fn refuses_not_guesses_when_a_btc_value_is_asked_and_prices_cannot_be_had() {
    let w = wallet(vec![user(ALICE, "USDT", "available", "100")], no_trade());
    let err = to_wire(summary(&w, ALICE, &in_btc()).unwrap_err());
    assert_eq!(err.code, "SERVICE_UNAVAILABLE");
    assert_eq!(
        s(&plain(&w, ALICE).unwrap(), "totalUsd").as_deref(),
        Some("100.00")
    );
}

#[test]
fn leaves_the_btc_value_blank_not_0_when_something_is_held_and_none_of_it_can_be_priced() {
    let w = wallet(
        vec![
            user(ALICE, "EUR", "available", "500"),
            user(ALICE, "NEWCOIN", "available", "3"),
        ],
        prices(&[("BTC/USDT", "60000")]),
    );
    let out = summary(&w, ALICE, &in_btc()).unwrap();
    assert_eq!(out.get("totalUsd"), Some(&Json::Null));
    assert_eq!(
        btc_block(&out),
        r#"{"total":null,"priceUsd":null,"reason":"nothing_priced"}"#
    );
    let one = summary(
        &w,
        ALICE,
        &SummaryInput {
            asset_id: Some("NEWCOIN"),
            value_in: Some("btc"),
            ..SummaryInput::default()
        },
    )
    .unwrap();
    assert_eq!(one.get("btc").unwrap().get("total"), Some(&Json::Null));
}

#[test]
fn leaves_an_unpriced_holding_out_of_the_btc_value_as_it_is_out_of_the_usd_value() {
    let w = wallet(
        vec![
            user(ALICE, "USDT", "available", "6000"),
            user(ALICE, "EUR", "available", "500"),
        ],
        prices(&[("BTC/USDT", "60000")]),
    );
    let out = summary(&w, ALICE, &in_btc()).unwrap();
    assert_eq!(
        s(&list(&out, "unpriced")[0], "asset").as_deref(),
        Some("EUR")
    );
    assert_eq!(s(out.get("btc").unwrap(), "total").as_deref(), Some("0.1"));
}

#[test]
fn falls_back_to_btc_usdc_when_btc_usdt_has_no_last_price_and_refuses_when_listed_markets_answer_nothing()
 {
    let no_last = trade(
        &[
            ("BTC/USDT", quote(None, None)),
            ("BTC/USDC", quote(Some("50000"), None)),
        ],
        &[],
    );
    let w = wallet(vec![user(ALICE, "USDT", "available", "5000")], no_last);
    assert_eq!(
        btc_block(&summary(&w, ALICE, &in_btc()).unwrap()),
        r#"{"total":"0.1","priceUsd":"50000","reason":null}"#
    );
    let dead = wallet(
        vec![user(ALICE, "USDT", "available", "5000")],
        trade(&[], &["BTC/USDT"]),
    );
    let err = to_wire(summary(&dead, ALICE, &in_btc()).unwrap_err());
    assert_eq!(err.code, "SERVICE_UNAVAILABLE");
}

#[test]
fn rounds_once_half_up_to_8_decimals() {
    let one = wallet(
        vec![user(ALICE, "USDT", "available", "1")],
        prices(&[("BTC/USDT", "3")]),
    );
    assert_eq!(
        s(
            summary(&one, ALICE, &in_btc()).unwrap().get("btc").unwrap(),
            "total"
        )
        .as_deref(),
        Some("0.33333333")
    );
    let two = wallet(
        vec![user(ALICE, "USDT", "available", "2")],
        prices(&[("BTC/USDT", "3")]),
    );
    assert_eq!(
        s(
            summary(&two, ALICE, &in_btc()).unwrap().get("btc").unwrap(),
            "total"
        )
        .as_deref(),
        Some("0.66666667")
    );
}

#[test]
fn values_nothing_held_as_0_btc_with_no_price_needed() {
    let w = wallet(vec![], no_trade());
    assert_eq!(
        btc_block(&summary(&w, ALICE, &in_btc()).unwrap()),
        r#"{"total":"0","priceUsd":null,"reason":null}"#
    );
}

fn totals(out: &Json) -> Vec<(String, String)> {
    list(out, "assets")
        .iter()
        .map(|a| (s(a, "assetId").unwrap(), s(a, "total").unwrap()))
        .collect()
}

#[test]
fn lists_the_wallet_selector_the_main_account_then_each_named_space_and_no_one_else() {
    let w = wallet(wallet_rows(), no_trade());
    assert_eq!(
        w.svc().accounts(ALICE).unwrap().compact(),
        format!(
            r#"{{"accounts":[{{"accountId":"main","walletType":"main","name":null}},{{"accountId":"{SPACE}","walletType":"space","name":"Savings"}}]}}"#
        )
    );
}

#[test]
fn reads_only_the_account_asked_for_and_each_account_adds_up_to_the_whole() {
    let w = wallet(wallet_rows(), no_trade());
    let svc = w.svc();
    let main = svc
        .balance_breakdown(ALICE, "all", Some("main"), None)
        .unwrap();
    let in_space = svc
        .balance_breakdown(ALICE, "all", Some(SPACE), None)
        .unwrap();
    let all = svc.balance_breakdown(ALICE, "all", None, None).unwrap();
    assert_eq!(totals(&main), pairs(&[("BTC", "0.75"), ("USDT", "30000")]));
    assert_eq!(totals(&in_space), pairs(&[("USDT", "10000")]));
    let usdt = |o: &Json| amt(&totals(o).into_iter().find(|(a, _)| a == "USDT").unwrap().1);
    assert_eq!(usdt(&main) + usdt(&in_space), usdt(&all));
    assert!(!w.ledger.asked().iter().any(|(_, id)| id == BOB));
}

#[test]
fn refuses_a_space_that_is_not_the_callers_without_reading_it_and_a_malformed_account_id() {
    let w = wallet(wallet_rows(), no_trade());
    let err = to_wire(
        w.svc()
            .balance_breakdown(ALICE, "all", Some(BOBS_SPACE), None)
            .unwrap_err(),
    );
    assert_eq!(err.code, "NOT_FOUND");
    assert!(w.ledger.asked().is_empty());
}

#[test]
fn takes_the_account_id_in_any_letter_case_and_lets_accountid_win_over_scope_and_combine_with_assetid()
 {
    let w = wallet(wallet_rows(), no_trade());
    let svc = w.svc();
    let upper = svc
        .balance_breakdown(ALICE, "all", Some(&SPACE.to_uppercase()), None)
        .unwrap();
    assert_eq!(totals(&upper), pairs(&[("USDT", "10000")]));
    let both = svc
        .balance_breakdown(ALICE, "main", Some(SPACE), Some("usdt"))
        .unwrap();
    assert_eq!(totals(&both), pairs(&[("USDT", "10000")]));
    assert!(
        totals(
            &svc.balance_breakdown(ALICE, "all", Some(SPACE), Some("BTC"))
                .unwrap()
        )
        .is_empty()
    );
}

#[test]
fn reads_no_space_list_for_the_main_account_so_the_main_figure_does_not_wait_on_it() {
    let mut broken = wallet_spaces();
    broken.down = true;
    let w = world(ledger(wallet_rows()), broken, no_trade());
    let out = w
        .svc()
        .balance_breakdown(ALICE, "main", None, None)
        .unwrap();
    let ids: Vec<String> = totals(&out).into_iter().map(|(a, _)| a).collect();
    assert_eq!(ids, vec!["BTC", "USDT"]);
    assert!(w.svc().balance_breakdown(ALICE, "all", None, None).is_err());
}

#[test]
fn narrows_to_one_asset_and_keeps_its_locks_apart() {
    let w = wallet(wallet_rows(), no_trade());
    let out = w
        .svc()
        .balance_breakdown(ALICE, "all", None, Some("btc"))
        .unwrap();
    assert_eq!(
        out.compact(),
        r#"{"assets":[{"assetId":"BTC","total":"0.75","available":"0.5","locked":[{"kind":"hold","amount":"0.25","claims":[{"purpose":"order:o-1","amount":"0.25"}]}]}]}"#
    );
}

// ---- balance-breakdown.test.ts ----

#[test]
fn splits_available_from_every_lock_kind_names_each_claim_and_the_parts_add_up_to_the_total_exactly()
 {
    let w = world(
        ledger(vec![
            user(ALICE, "USDT", "available", "700.25"),
            with_purpose(user(ALICE, "USDT", "hold", "100"), "order:o-1"),
            with_purpose(user(ALICE, "USDT", "hold", "50.5"), "order:o-2"),
            with_purpose(user(ALICE, "USDT", "escrow", "20"), "p2p:t-9"),
            with_purpose(user(ALICE, "USDT", "stake", "30"), "token:stake:s-1"),
            with_purpose(user(ALICE, "USDT", "collateral", "99.25"), "loan:l-1"),
            user(ALICE, "BTC", "available", "0.5"),
        ]),
        spaces(vec![]),
        no_trade(),
    );
    let out = w.svc().balance_breakdown(ALICE, "all", None, None).unwrap();
    assert_eq!(
        out.compact(),
        r#"{"assets":[{"assetId":"BTC","total":"0.5","available":"0.5","locked":[]},{"assetId":"USDT","total":"1000","available":"700.25","locked":[{"kind":"hold","amount":"150.5","claims":[{"purpose":"order:o-1","amount":"100"},{"purpose":"order:o-2","amount":"50.5"}]},{"kind":"escrow","amount":"20","claims":[{"purpose":"p2p:t-9","amount":"20"}]},{"kind":"stake","amount":"30","claims":[{"purpose":"token:stake:s-1","amount":"30"}]},{"kind":"collateral","amount":"99.25","claims":[{"purpose":"loan:l-1","amount":"99.25"}]}]}]}"#
    );
    for asset in list(&out, "assets") {
        let locks = list(asset, "locked");
        let sum: Amount = amt(&s(asset, "available").unwrap())
            + locks
                .iter()
                .map(|l| amt(&s(l, "amount").unwrap()))
                .sum::<Amount>();
        assert_eq!(sum, amt(&s(asset, "total").unwrap()));
        for lock in locks {
            let claims: Amount = list(lock, "claims")
                .iter()
                .map(|c| amt(&s(c, "amount").unwrap()))
                .sum();
            assert_eq!(claims, amt(&s(lock, "amount").unwrap()));
        }
    }
}

#[test]
fn adds_the_named_spaces_to_the_same_asset_as_the_headline_total_does_and_reads_only_this_caller() {
    let w = world(
        ledger(vec![
            user(ALICE, "USDT", "available", "100"),
            sub(SPACE, "USDT", "available", "40"),
            with_purpose(sub(SPACE, "USDT", "hold", "10"), "order:o-3"),
            user(BOB, "USDT", "available", "999999"),
        ]),
        spaces(vec![named(SPACE, ALICE)]),
        no_trade(),
    );
    let out = w.svc().balance_breakdown(ALICE, "all", None, None).unwrap();
    assert_eq!(
        out.compact(),
        r#"{"assets":[{"assetId":"USDT","total":"150","available":"140","locked":[{"kind":"hold","amount":"10","claims":[{"purpose":"order:o-3","amount":"10"}]}]}]}"#
    );
    let asked = w.ledger.asked();
    assert!(asked.contains(&("user".to_owned(), ALICE.to_owned())));
    assert!(asked.contains(&("subaccount".to_owned(), SPACE.to_owned())));
    assert!(!asked.iter().any(|(_, id)| id == BOB));
}

#[test]
fn with_scope_main_leaves_the_named_spaces_out_and_never_asks_for_them() {
    let w = world(
        ledger(vec![
            user(ALICE, "USDT", "available", "100"),
            sub(SPACE, "USDT", "available", "40"),
        ]),
        spaces(vec![named(SPACE, ALICE)]),
        no_trade(),
    );
    let out = w
        .svc()
        .balance_breakdown(ALICE, "main", None, None)
        .unwrap();
    assert_eq!(
        out.compact(),
        r#"{"assets":[{"assetId":"USDT","total":"100","available":"100","locked":[]}]}"#
    );
    assert_eq!(
        w.ledger.asked(),
        vec![("user".to_owned(), ALICE.to_owned())]
    );
}

#[test]
fn shows_an_asset_that_holds_nothing_as_absent_not_as_a_zero_row_and_an_empty_account_as_an_empty_list()
 {
    let w = world(
        ledger(vec![
            user(ALICE, "ETH", "available", "0"),
            with_purpose(user(ALICE, "ETH", "hold", "0"), "order:o-4"),
        ]),
        spaces(vec![]),
        no_trade(),
    );
    assert_eq!(
        w.svc()
            .balance_breakdown(ALICE, "all", None, None)
            .unwrap()
            .compact(),
        r#"{"assets":[]}"#
    );
}

#[test]
fn keeps_a_negative_lock_visible_rather_than_hiding_it_so_a_broken_book_is_seen_and_not_netted_away()
 {
    let w = world(
        ledger(vec![
            user(ALICE, "USDT", "available", "10"),
            with_purpose(user(ALICE, "USDT", "hold", "-3"), "order:o-5"),
        ]),
        spaces(vec![]),
        no_trade(),
    );
    assert_eq!(
        w.svc()
            .balance_breakdown(ALICE, "all", None, None)
            .unwrap()
            .compact(),
        r#"{"assets":[{"assetId":"USDT","total":"7","available":"10","locked":[{"kind":"hold","amount":"-3","claims":[{"purpose":"order:o-5","amount":"-3"}]}]}]}"#
    );
}

#[test]
fn answers_a_ledger_failure_as_a_typed_refusal_never_as_an_empty_list() {
    let mut l = ledger(vec![]);
    l.down = true;
    let w = world(l, spaces(vec![]), no_trade());
    let err = to_wire(
        w.svc()
            .balance_breakdown(ALICE, "all", None, None)
            .unwrap_err(),
    );
    assert_eq!(err.code, "INTERNAL_SERVER_ERROR");
}

// ---- balance-entries.test.ts ----

fn entry(seq: usize, asset: &str, direction: &str, amount: &str, at: &str) -> PageEntry {
    PageEntry {
        tx_id: format!("tx-{seq}"),
        module: "bank".to_owned(),
        reason: "test".to_owned(),
        direction: direction.to_owned(),
        amount: amt(amount),
        posted_at: service_kit::time::js_date(at).unwrap(),
        asset_id: asset.to_owned(),
        entry_id: Some(seq.to_string()),
        rail: None,
        product: None,
        order_id: None,
        withdrawal_id: None,
        fee: None,
    }
}

fn entries_world(
    rows: Vec<Row>,
    history: Vec<(String, Vec<PageEntry>)>,
    named_spaces: Vec<Named>,
) -> World {
    World {
        pages: pages(history),
        ..world(ledger(rows), spaces(named_spaces), no_trade())
    }
}

fn entries(
    w: &World,
    asset: &str,
    account: Option<&str>,
    cursor: Option<&str>,
    limit: usize,
) -> Result<Json, Fail> {
    w.svc().balance_entries(
        ALICE,
        &EntriesInput {
            asset_id: asset,
            account_id: account,
            cursor,
            limit,
        },
    )
}

fn fail_wire(f: Fail) -> service_kit::trpc::TrpcError {
    super::activity_failure(f)
}

#[test]
fn lists_the_entries_newest_first_and_says_they_sum_to_the_balance() {
    let w = entries_world(
        vec![
            user(ALICE, "USDT", "available", "70"),
            user(ALICE, "USDT", "hold", "30"),
        ],
        vec![(
            format!("user:{ALICE}"),
            vec![
                entry(1, "USDT", "debit", "100", "2026-10-01T00:00:00Z"),
                entry(2, "USDT", "credit", "30", "2026-10-02T00:00:00Z"),
            ],
        )],
        vec![],
    );
    let out = entries(&w, "usdt", None, None, 50).unwrap();
    let amounts: Vec<String> = list(&out, "entries")
        .iter()
        .map(|e| s(e, "amount").unwrap())
        .collect();
    assert_eq!(amounts, vec!["30", "100"]);
    assert_eq!(
        out.get("sumCheck").unwrap().compact(),
        r#"{"ok":true,"entriesSum":"70","balance":"70","entryCount":2}"#
    );
}

#[test]
fn refuses_with_the_gap_when_one_unit_is_missing_and_shows_no_list() {
    let w = entries_world(
        vec![user(ALICE, "USDT", "available", "71")],
        vec![(
            format!("user:{ALICE}"),
            vec![entry(1, "USDT", "debit", "70", "2026-10-01T00:00:00Z")],
        )],
        vec![],
    );
    let err = fail_wire(entries(&w, "USDT", None, None, 50).unwrap_err());
    assert_eq!(err.code, "PRECONDITION_FAILED");
    assert!(err.message.contains("portfolio.entries_do_not_sum"));
    assert!(err.message.contains("gap of -1"));
}

#[test]
fn sums_main_and_a_space_for_all_accounts_and_each_alone() {
    let mut space = named(SPACE, ALICE);
    space.name = "Holiday".to_owned();
    let w = entries_world(
        vec![
            user(ALICE, "BTC", "available", "2"),
            sub(SPACE, "BTC", "available", "3"),
        ],
        vec![
            (
                format!("user:{ALICE}"),
                vec![entry(1, "BTC", "debit", "2", "2026-10-01T00:00:00Z")],
            ),
            (
                format!("subaccount:{SPACE}"),
                vec![entry(2, "BTC", "debit", "3", "2026-10-03T00:00:00Z")],
            ),
        ],
        vec![space],
    );
    let all = entries(&w, "BTC", None, None, 50).unwrap();
    assert_eq!(
        s(all.get("sumCheck").unwrap(), "balance").as_deref(),
        Some("5")
    );
    let accounts: Vec<String> = list(&all, "entries")
        .iter()
        .map(|e| s(e, "accountId").unwrap())
        .collect();
    assert_eq!(accounts, vec![SPACE.to_owned(), "main".to_owned()]);
    let main = entries(&w, "BTC", Some("main"), None, 50).unwrap();
    assert_eq!(
        s(main.get("sumCheck").unwrap(), "balance").as_deref(),
        Some("2")
    );
    let one = entries(&w, "BTC", Some(SPACE), None, 50).unwrap();
    assert_eq!(
        s(one.get("sumCheck").unwrap(), "balance").as_deref(),
        Some("3")
    );
}

#[test]
fn pages_by_offset_and_checks_the_whole_history_not_just_the_page() {
    let rows: Vec<PageEntry> = (1..=5)
        .map(|i| entry(i, "ETH", "debit", "1", &format!("2026-10-0{i}T00:00:00Z")))
        .collect();
    let mut w = entries_world(
        vec![user(ALICE, "ETH", "available", "5")],
        vec![(format!("user:{ALICE}"), rows)],
        vec![],
    );
    w.pages.size = 2;
    let first = entries(&w, "ETH", None, None, 2).unwrap();
    assert_eq!(list(&first, "entries").len(), 2);
    assert_eq!(
        first.get("sumCheck").unwrap().get("entryCount"),
        Some(&Json::int(5))
    );
    let next = s(&first, "nextCursor").unwrap();
    let last = entries(&w, "ETH", None, Some(&next), 2).unwrap();
    let next = s(&last, "nextCursor").unwrap();
    let end = entries(&w, "ETH", None, Some(&next), 2).unwrap();
    assert_eq!(end.get("nextCursor"), Some(&Json::Null));
    let mut seen: Vec<String> = [&first, &last, &end]
        .iter()
        .flat_map(|p| list(p, "entries").iter().map(|e| s(e, "txId").unwrap()))
        .collect();
    seen.dedup();
    assert_eq!(seen.len(), 5);
}

#[test]
fn gives_no_partial_check_when_a_history_page_fails_midway() {
    let rows: Vec<PageEntry> = (1..=4)
        .map(|i| entry(i, "ETH", "debit", "1", &format!("2026-10-0{i}T00:00:00Z")))
        .collect();
    let mut w = entries_world(
        vec![user(ALICE, "ETH", "available", "4")],
        vec![(format!("user:{ALICE}"), rows)],
        vec![],
    );
    w.pages.size = 2;
    w.pages.fail_at = Some(2);
    let err = fail_wire(entries(&w, "ETH", None, None, 50).unwrap_err());
    assert_eq!(err.code, "SERVICE_UNAVAILABLE");
}

#[test]
fn refuses_a_space_that_is_not_the_callers_and_never_reads_another_user() {
    let w = entries_world(vec![], vec![], vec![named(SPACE, BOB)]);
    let err = fail_wire(entries(&w, "BTC", Some(SPACE), None, 50).unwrap_err());
    assert_eq!(err.code, "BAD_REQUEST");
    assert!(err.message.ends_with("(bank.space_not_found)"));
    assert!(w.ledger.asked().is_empty());
}

#[test]
fn refuses_when_no_history_source_is_wired() {
    let w = world(ledger(vec![]), spaces(vec![]), no_trade());
    let err = fail_wire(entries(&w, "BTC", None, None, 50).unwrap_err());
    assert_eq!(err.code, "SERVICE_UNAVAILABLE");
}

#[test]
fn refuses_a_page_marker_that_is_not_one_to_nine_digits() {
    let w = world(ledger(vec![]), spaces(vec![]), no_trade());
    let err = fail_wire(entries(&w, "BTC", None, Some("1234567890"), 50).unwrap_err());
    assert_eq!(
        (err.code, err.message.as_str()),
        (
            "BAD_REQUEST",
            "That page marker is not valid (bank.activity_range)"
        )
    );
}

// ---- value-history.test.ts (the service) ----

fn value_world(fail: Option<HistoryError>, closes: FakeCloses) -> World {
    let mut closed = named(CLOSED, ALICE);
    closed.name = "Closed".to_owned();
    let mut sp = spaces(vec![named(SPACE, ALICE), named(BOBS_SPACE, BOB)]);
    sp.every = Some(vec![named(SPACE, ALICE), closed, named(BOBS_SPACE, BOB)]);
    World {
        history: FakeHistory {
            fail,
            asked: Mutex::new(Vec::new()),
        },
        closes,
        now: day(5, 12),
        ..world(ledger(vec![]), sp, no_trade())
    }
}

fn iso(t: i64) -> String {
    Instant(t).iso()
}

#[test]
fn reads_the_callers_main_account_and_own_named_spaces_only_archived_ones_too_from_the_start_of_the_grid_in_the_bucket_the_range_needs()
 {
    let w = value_world(None, FakeCloses(true));
    let out = w
        .svc()
        .value_over_time(ALICE, &iso(day(1, 7)), Some(&iso(day(5, 0))))
        .unwrap();
    let from = iso(day(1, 7));
    // The reads run at once, so they are compared as a set.
    let mut asked = w.history.asked.lock().unwrap().clone();
    asked.sort();
    let mut want = vec![
        ("user".to_owned(), ALICE.to_owned(), from.clone(), 3_600),
        (
            "subaccount".to_owned(),
            SPACE.to_owned(),
            from.clone(),
            3_600,
        ),
        ("subaccount".to_owned(), CLOSED.to_owned(), from, 3_600),
    ];
    want.sort();
    assert_eq!(asked, want);
    assert_eq!(out.interval, "1h");
    assert_eq!(out.points[0].at, day(1, 7));
    assert_eq!(out.points[0].value.map(format_amount).as_deref(), Some("0"));
    let at3 = out.points.iter().find(|p| p.at == day(3, 0)).unwrap();
    assert_eq!(at3.value.map(format_amount).as_deref(), Some("1000"));
    let last = out.points.last().unwrap();
    assert_eq!(
        (last.at, last.value.map(format_amount)),
        (day(5, 0), Some("800".to_owned()))
    );
}

#[test]
fn refuses_a_range_that_is_empty_in_the_future_or_too_long_ago_by_name() {
    let w = value_world(None, FakeCloses(true));
    let svc = w.svc();
    assert_eq!(
        code(
            &svc.value_over_time(ALICE, &iso(day(5, 0)), Some(&iso(day(4, 0))))
                .unwrap_err()
        ),
        "bank.value_range_invalid"
    );
    assert_eq!(
        code(
            &svc.value_over_time(ALICE, &iso(day(6, 0)), None)
                .unwrap_err()
        ),
        "bank.value_range_invalid"
    );
    assert_eq!(
        code(
            &svc.value_over_time(ALICE, &iso(day(5, 0) - 20 * 365 * DAY), None)
                .unwrap_err()
        ),
        "bank.value_range_too_long"
    );
}

#[test]
fn names_a_ledger_answer_too_large_and_refuses_rather_than_guesses_when_the_ledger_or_the_prices_cannot_be_read()
 {
    let from = iso(day(1, 0));
    let too_big = value_world(Some(HistoryError::TooLarge), FakeCloses(true));
    assert_eq!(
        code(
            &too_big
                .svc()
                .value_over_time(ALICE, &from, None)
                .unwrap_err()
        ),
        "bank.value_history_too_large"
    );
    let down = value_world(
        Some(HistoryError::Other("connection reset".to_owned())),
        FakeCloses(true),
    );
    assert_eq!(
        code(&down.svc().value_over_time(ALICE, &from, None).unwrap_err()),
        "bank.value_history_unavailable"
    );
    let prices_down = value_world(None, FakeCloses(false));
    assert_eq!(
        code(
            &prices_down
                .svc()
                .value_over_time(ALICE, &from, None)
                .unwrap_err()
        ),
        "bank.prices_unavailable"
    );
    let unwired = value_world(None, FakeCloses(true));
    let svc = Service {
        history: &super::history::NoHistory,
        ..unwired.svc()
    };
    assert_eq!(
        code(&svc.value_over_time(ALICE, &from, None).unwrap_err()),
        "bank.value_history_unavailable"
    );
}

#[test]
fn gives_the_two_ends_for_the_caller_only_with_the_same_range_refusals_as_the_value_over_time() {
    let w = value_world(None, FakeCloses(true));
    let out = w
        .svc()
        .holdings_change(ALICE, &iso(day(1, 7)), Some(&iso(day(5, 0))))
        .unwrap();
    let got: Vec<(String, String, String)> = out
        .rows
        .iter()
        .map(|r| {
            (
                r.asset_id.clone(),
                format_amount(r.start),
                format_amount(r.end),
            )
        })
        .collect();
    assert_eq!(
        got,
        vec![
            ("BTC".to_owned(), "0".to_owned(), "1".to_owned()),
            ("USDT".to_owned(), "0".to_owned(), "400".to_owned()),
        ]
    );
    assert_eq!(
        code(
            &w.svc()
                .holdings_change(ALICE, &iso(day(6, 0)), None)
                .unwrap_err()
        ),
        "bank.value_range_invalid"
    );
    let too_big = value_world(Some(HistoryError::TooLarge), FakeCloses(true));
    assert_eq!(
        code(
            &too_big
                .svc()
                .holdings_change(ALICE, &iso(day(1, 0)), None)
                .unwrap_err()
        ),
        "bank.value_history_too_large"
    );
    let down = value_world(
        Some(HistoryError::Other("connection reset".to_owned())),
        FakeCloses(true),
    );
    assert_eq!(
        code(
            &down
                .svc()
                .holdings_change(ALICE, &iso(day(1, 0)), None)
                .unwrap_err()
        ),
        "bank.value_history_unavailable"
    );
}

#[test]
fn still_answers_the_amounts_when_the_prices_cannot_be_read_those_coins_are_not_priced_never_zero()
{
    let w = value_world(None, FakeCloses(false));
    let out = w
        .svc()
        .holdings_change(ALICE, &iso(day(1, 7)), Some(&iso(day(5, 0))))
        .unwrap();
    let btc = out.rows.iter().find(|r| r.asset_id == "BTC").unwrap();
    assert_eq!(
        (format_amount(btc.end), btc.end_price),
        ("1".to_owned(), None)
    );
    let usdt = out.rows.iter().find(|r| r.asset_id == "USDT").unwrap();
    assert_eq!(usdt.end_price.map(format_amount).as_deref(), Some("1"));
    assert!(
        out.json()
            .get("rows")
            .unwrap()
            .compact()
            .contains(r#""endValueUsd":"400""#)
    );
}
