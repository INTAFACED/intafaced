//! `pnl-over-time.test.ts`, case for case (J-portfolio-05 #4 and #5, PF-performance-03). Every
//! figure is hand-computed TEST data. The TypeScript's `pnlOverTimeSchema.parse(out)` check has no Rust counterpart:
//! the crate does not hold the contracts' output schema (named in the port's report).
#![allow(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use crate::common;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use common::fake::{self, FakeLedger};
use common::{amt, assert_json, assert_match, f, find, list, some, text, utc};
use svc_tax::inputs::PnlInput;
use svc_tax::json::Json;
use svc_tax::lot_book::{BookInput, Inflow, LotBook, Withdrawal, build_lot_book};
use svc_tax::lot_engine::LotSource;
use svc_tax::own_moves::OwnMove;
use svc_tax::pnl_over_time::{
    BookTimeline, HELD_KEY, MOVED_KEY_PREFIX, PnlInputs, SWAP_KEY_PREFIX, choose_interval,
    close_at, day_edges, pnl_over_time, samples_of,
};
use svc_tax::ports::{CloseSeries, EngineMethod, Fill, FillLeg, SeriesTimeframe};
use svc_tax::tax::{
    Amount, Failure, TAX_PNL_PRICES_UNAVAILABLE, TAX_PNL_RANGE_INVALID, TAX_PNL_RANGE_TOO_LONG,
    TaxDeps,
};
use svc_tax::time::{self, Instant};

const DAY: i64 = 86_400_000;

fn day(d: i64, hour: i64) -> Instant {
    utc(2026, 10, 1, hour, 0).plus(d - 1)
}

trait Plus {
    fn plus(self, days: i64) -> Instant;
}

impl Plus for Instant {
    fn plus(self, days: i64) -> Instant {
        Instant(self.0 + days * DAY)
    }
}

fn d(n: i64) -> Instant {
    day(n, 0)
}

fn now() -> Instant {
    day(21, 12)
}

fn leg(asset: &str, qty: &str) -> FillLeg {
    FillLeg {
        asset_id: asset.to_owned(),
        amount: amt(qty),
    }
}

/// Day 1 noon: buy 1 BTC for 100 USDT.
fn buy() -> Fill {
    Fill {
        tx_id: "b1".to_owned(),
        posted_at: day(1, 12),
        received: leg("BTC", "1"),
        paid: Some(leg("USDT", "100")),
        fee: Some(0),
        fee_asset_id: None,
    }
}

/// Day 8 noon: sell 0.5 BTC for 150 USDT after a 1.5 USDT fee (realised 100).
fn sell() -> Fill {
    Fill {
        tx_id: "s1".to_owned(),
        posted_at: day(8, 12),
        received: leg("USDT", "150"),
        paid: Some(leg("BTC", "0.5")),
        fee: Some(amt("1.5")),
        fee_asset_id: None,
    }
}

#[derive(Default)]
struct Extra {
    inflows: Vec<Inflow>,
    method: Option<EngineMethod>,
    exclude_transfers: bool,
    withdrawals: Vec<Withdrawal>,
    moves: Vec<OwnMove>,
}

fn book_with(fills: &[Fill], held: &[(&str, &str)], extra: Extra) -> LotBook {
    let held: HashMap<String, Amount> = held
        .iter()
        .map(|(k, v)| ((*k).to_owned(), amt(v)))
        .collect();
    build_lot_book(BookInput {
        fills,
        held: &held,
        method: extra.method.unwrap_or(EngineMethod::Fifo),
        rules: None,
        preview: false,
        choices: None,
        truncated: false,
        outside_inflows: &[],
        inflows: &extra.inflows,
        now: now(),
        override_price_per_unit: None,
        moves: &extra.moves,
        carried_in: &[],
        spaces: None,
        space_held: None,
        withdrawals: &extra.withdrawals,
        include_transfers: !extra.exclude_transfers,
    })
}

fn book_of(fills: &[Fill], held: &[(&str, &str)]) -> LotBook {
    book_with(fills, held, Extra::default())
}

/// Daily BTC/USDT candles: the one opening on day d closes at 100 + 10d.
fn daily_from(first: i64, last: i64) -> CloseSeries {
    CloseSeries {
        market: "BTC/USDT".to_owned(),
        candles: (first..=last)
            .map(|n| (d(n).0, amt(&(100 + 10 * n).to_string())))
            .collect(),
    }
}

struct Run {
    book: LotBook,
    from: Instant,
    to: Instant,
    interval: SeriesTimeframe,
    offset: i64,
    closes: HashMap<String, Option<CloseSeries>>,
}

fn base() -> Run {
    Run {
        book: book_of(&[buy(), sell()], &[("BTC", "0.5"), ("USDT", "150")]),
        from: d(2),
        to: d(20),
        interval: SeriesTimeframe::D1,
        offset: 0,
        closes: HashMap::from([("BTC".to_owned(), Some(daily_from(0, 21)))]),
    }
}

fn run_result(r: &Run) -> Result<Json, Failure> {
    pnl_over_time(&PnlInputs {
        book: &r.book,
        from: r.from,
        to: r.to,
        now: now(),
        interval: r.interval,
        utc_offset_minutes: r.offset,
        closes: &r.closes,
        timeline: None,
    })
}

fn run(r: Run) -> Json {
    run_result(&r).unwrap()
}

fn point(out: &Json, at: Instant) -> &Json {
    find(list(out, "points"), "at", &at.iso()).unwrap()
}

fn sum(rows: &[Json]) -> Amount {
    rows.iter().map(|r| amt(&text(r, "usd").unwrap())).sum()
}

fn by_day(out: &Json) -> &[Json] {
    list(out, "byDay")
}

// the cumulative result at each moment

#[test]
fn is_what_the_indicator_said_then() {
    let out = run(base());
    assert_match(
        point(&out, d(2)),
        r#"{"totalUsd":"10","realizedUsd":"0","unrealizedUsd":"10","missing":[]}"#,
    );
    assert_match(
        point(&out, d(9)),
        r#"{"totalUsd":"140","realizedUsd":"100","unrealizedUsd":"40"}"#,
    );
    assert_match(
        point(&out, d(20)),
        r#"{"totalUsd":"195","realizedUsd":"100","unrealizedUsd":"95"}"#,
    );
    assert_eq!(list(&out, "points").len(), 19);
}

#[test]
fn uses_the_open_candle_only_at_a_live_end() {
    let live = run(Run {
        to: now(),
        ..base()
    });
    let last = list(&live, "points").last().unwrap();
    assert_eq!(text(last, "at"), Some(now().iso()));
    assert_eq!(
        text(last, "unrealizedUsd"),
        Some(f(amt("0.5") * 310 - amt("50")))
    );
    let series = daily_from(0, 21);
    assert_eq!(
        close_at(&series, SeriesTimeframe::D1, day(10, 12), false),
        Some(amt("190"))
    );
    assert_eq!(
        close_at(&series, SeriesTimeframe::D1, day(10, 12), true),
        Some(amt("200"))
    );
}

#[test]
fn reads_a_moment_with_no_price_as_missing_never_zero() {
    let out = run(Run {
        closes: HashMap::from([("BTC".to_owned(), Some(daily_from(6, 21)))]),
        ..base()
    });
    let before: Vec<_> = list(&out, "points")
        .iter()
        .filter(|p| time::js_date(&text(p, "at").unwrap()).unwrap() <= d(6))
        .collect();
    assert!(!before.is_empty());
    for p in before {
        assert_match(
            p,
            r#"{"totalUsd":null,"unrealizedUsd":null,"missing":[{"assetId":"BTC","reason":"no_price"}]}"#,
        );
    }
    assert_eq!(
        text(point(&out, d(8)), "totalUsd"),
        Some(f(amt("170") - amt("100")))
    );
    assert_eq!(out.get("periodUsd"), Some(&Json::Null));
    assert_eq!(
        find(by_day(&out), "key", "2026-10-03").unwrap().get("usd"),
        Some(&Json::Null)
    );
    let no_market = run(Run {
        closes: HashMap::from([("BTC".to_owned(), None)]),
        ..base()
    });
    assert!(
        list(&no_market, "points")
            .iter()
            .all(|p| p.get("totalUsd") == Some(&Json::Null))
    );
}

#[test]
fn starts_from_zero_before_the_first_trade() {
    let out = run(Run {
        from: d(1),
        to: d(3),
        closes: HashMap::from([("BTC".to_owned(), Some(daily_from(2, 21)))]),
        ..base()
    });
    assert_match(
        &list(&out, "points")[0],
        &format!(r#"{{"at":"{}","totalUsd":"0","missing":[]}}"#, d(1).iso()),
    );
}

fn no_cost(tx: &str, n: i64, qty: &str) -> Inflow {
    Inflow {
        tx_id: tx.to_owned(),
        posted_at: day(n, 12),
        asset_id: "BTC".to_owned(),
        amount: amt(qty),
        reason: "deposit.credited".to_owned(),
        source: LotSource::Deposit,
        cost_usd: None,
        valued_at: None,
        space_id: None,
    }
}

#[test]
fn names_an_unknown_cost_while_the_deposit_is_held() {
    let held = [("BTC", "0.75"), ("USDT", "150")];
    let out = run(Run {
        book: book_with(
            &[buy(), sell()],
            &held,
            Extra {
                inflows: vec![no_cost("d1", 4, "0.25")],
                ..Extra::default()
            },
        ),
        ..base()
    });
    assert_eq!(text(point(&out, d(4)), "totalUsd"), some("30"));
    assert_match(
        point(&out, d(5)),
        r#"{"totalUsd":null,"missing":[{"assetId":"BTC","reason":"cost_unknown"}]}"#,
    );
    let apart = run(Run {
        book: book_with(
            &[buy(), sell()],
            &held,
            Extra {
                inflows: vec![no_cost("d1", 4, "0.25")],
                exclude_transfers: true,
                ..Extra::default()
            },
        ),
        ..base()
    });
    assert_eq!(text(point(&apart, d(5)), "totalUsd"), some("40"));
    assert_eq!(apart.get("includeTransfers"), Some(&Json::Bool(false)));
}

// review cases

#[test]
fn a_lot_with_no_cost_leaves_the_position_unknown_only_while_open() {
    let mut s6 = sell();
    s6.tx_id = "s6".to_owned();
    s6.posted_at = day(6, 12);
    s6.received = leg("USDT", "80");
    s6.fee = Some(0);
    let out = run(Run {
        book: book_with(
            &[buy(), s6],
            &[("BTC", "1"), ("USDT", "80")],
            Extra {
                inflows: vec![no_cost("d4", 4, "0.5")],
                method: Some(EngineMethod::Lifo),
                ..Extra::default()
            },
        ),
        from: d(2),
        to: d(10),
        ..base()
    });
    assert_json(
        point(&out, d(5)).get("missing").unwrap(),
        r#"[{"assetId":"BTC","reason":"cost_unknown"}]"#,
    );
    assert_eq!(text(point(&out, d(7)), "unrealizedUsd"), some("60"));
}

#[test]
fn an_older_unknown_sale_leaves_the_line_unknown_but_the_change_known() {
    let mut s2 = sell();
    s2.tx_id = "s2".to_owned();
    s2.posted_at = day(2, 12);
    s2.received = leg("USDT", "60");
    s2.fee = Some(0);
    let mut b = buy();
    b.posted_at = day(3, 12);
    let out = run(Run {
        book: book_with(
            &[s2, b],
            &[("BTC", "1"), ("USDT", "60")],
            Extra {
                inflows: vec![no_cost("d0", 0, "0.5")],
                ..Extra::default()
            },
        ),
        from: d(5),
        to: d(9),
        ..base()
    });
    assert!(
        list(&out, "points")
            .iter()
            .all(|p| p.get("totalUsd") == Some(&Json::Null))
    );
    assert_eq!(text(&out, "periodUsd"), some("40"));
    assert_json(out.get("byAsset").unwrap(), r#"[{"key":"BTC","usd":"40"}]"#);
    assert_json(
        out.get("byMarket").unwrap(),
        &format!(r#"[{{"key":"{HELD_KEY}","usd":"40"}}]"#),
    );
    assert_eq!(sum(by_day(&out)), amt("40"));
}

#[test]
fn a_day_with_no_price_is_a_row_not_known_and_nothing_is_refused() {
    let series = daily_from(0, 21);
    let mut gap = series.clone();
    gap.candles
        .retain(|(open, _)| *open < d(9).0 || *open >= d(14).0);
    let mut missing_days = series.clone();
    missing_days
        .candles
        .retain(|(open, _)| *open != d(1).0 && *open != d(0).0);
    assert!(
        run_result(&Run {
            closes: HashMap::from([("BTC".to_owned(), Some(gap))]),
            ..base()
        })
        .is_ok()
    );
    let out = run(Run {
        from: d(1),
        to: d(4),
        closes: HashMap::from([("BTC".to_owned(), Some(missing_days))]),
        ..base()
    });
    assert_eq!(
        find(by_day(&out), "key", "2026-10-01").unwrap().get("usd"),
        Some(&Json::Null)
    );
    assert_ne!(out.get("periodUsd"), Some(&Json::Null));
}

#[test]
fn names_a_coin_for_coin_swap_by_no_market() {
    let swap = Fill {
        tx_id: "x9".to_owned(),
        posted_at: day(9, 12),
        received: leg("ETH", "2"),
        paid: Some(leg("BTC", "0.25")),
        fee: Some(0),
        fee_asset_id: None,
    };
    let book = book_of(
        &[buy(), sell(), swap],
        &[("BTC", "0.25"), ("ETH", "2"), ("USDT", "150")],
    );
    let j = book.json();
    assert_eq!(
        find(list(&j, "sales"), "txId", "x9").unwrap().get("market"),
        None
    );
    let out = run(Run {
        book,
        closes: HashMap::from([
            ("BTC".to_owned(), Some(daily_from(0, 21))),
            ("ETH".to_owned(), None),
        ]),
        ..base()
    });
    let keys: Vec<_> = list(&out, "byMarket")
        .iter()
        .map(|r| text(r, "key"))
        .collect();
    assert!(keys.contains(&Some(format!("{SWAP_KEY_PREFIX}BTC"))));
}

// the breakdown adds up to the change over the range

#[test]
fn by_coin_by_market_and_by_day() {
    let out = run(base());
    assert_eq!(text(&out, "periodUsd"), some("185"));
    assert_json(
        out.get("byAsset").unwrap(),
        r#"[{"key":"BTC","usd":"185"}]"#,
    );
    assert_json(
        out.get("byMarket").unwrap(),
        &format!(r#"[{{"key":"BTC/USDT","usd":"100"}},{{"key":"{HELD_KEY}","usd":"85"}}]"#),
    );
    assert_eq!(by_day(&out).len(), 18);
    assert_json(&by_day(&out)[0], r#"{"key":"2026-10-02","usd":"10"}"#);
    for key in ["byAsset", "byMarket", "byDay"] {
        assert_eq!(sum(list(&out, key)), amt("185"), "{key}");
    }
    assert_eq!(text(&out, "feesUsd"), some("1.5"));
}

#[test]
fn lists_a_withdrawal_counted_as_a_sale_under_moved() {
    let out = run(Run {
        book: book_with(
            &[buy(), sell()],
            &[("BTC", "0.25"), ("USDT", "150")],
            Extra {
                withdrawals: vec![Withdrawal {
                    tx_id: "w1".to_owned(),
                    posted_at: day(10, 12),
                    asset_id: "BTC".to_owned(),
                    amount: amt("0.25"),
                    value_usd: Some(amt("200")),
                }],
                ..Extra::default()
            },
        ),
        ..base()
    });
    assert_json(
        find(
            list(&out, "byMarket"),
            "key",
            &format!("{MOVED_KEY_PREFIX}BTC"),
        )
        .unwrap(),
        r#"{"key":"moved:BTC","usd":"175"}"#,
    );
    assert_eq!(
        sum(list(&out, "byMarket")),
        amt(&text(&out, "periodUsd").unwrap())
    );
}

#[test]
fn cuts_the_days_at_the_customer_midnight() {
    let out = run(Run {
        offset: 5 * 60 + 30,
        ..base()
    });
    assert_eq!(text(&by_day(&out)[0], "key"), some("2026-10-02"));
    assert_eq!(
        day_edges(d(2), d(4), 330)[0],
        Instant(d(2).0 + DAY - 330 * 60_000)
    );
    assert_eq!(sum(by_day(&out)), amt(&text(&out, "periodUsd").unwrap()));
}

#[test]
fn leaves_the_days_out_of_a_range_longer_than_the_breakdown_lists() {
    let long = run(Run {
        book: book_of(&[], &[]),
        from: Instant(now().0 - 500 * DAY),
        to: now(),
        interval: SeriesTimeframe::W1,
        offset: 0,
        closes: HashMap::new(),
    });
    assert_eq!(long.get("byDay"), Some(&Json::Null));
    assert_eq!(text(&long, "periodUsd"), some("0"));
}

#[test]
fn refuses_a_range_that_ends_before_it_starts() {
    let e = fake::refused(run_result(&Run {
        from: d(5),
        to: d(5),
        ..base()
    }));
    assert_eq!(e.code, TAX_PNL_RANGE_INVALID);
}

// BookTimeline

#[test]
fn lands_on_the_book_own_open_lots_whatever_the_method() {
    let mut b2 = buy();
    b2.tx_id = "b2".to_owned();
    b2.posted_at = day(3, 12);
    b2.paid = Some(leg("USDT", "300"));
    let mut s2 = sell();
    s2.tx_id = "s2".to_owned();
    s2.posted_at = day(6, 12);
    s2.paid = Some(leg("BTC", "0.7"));
    s2.received = leg("USDT", "140");
    let fills = [buy(), b2, s2, sell()];
    for method in [
        EngineMethod::Fifo,
        EngineMethod::Lifo,
        EngineMethod::Hifo,
        EngineMethod::Average,
    ] {
        let book = book_with(
            &fills,
            &[("BTC", "0.8"), ("USDT", "290")],
            Extra {
                method: Some(method),
                ..Extra::default()
            },
        );
        let at = BookTimeline::new(&book).positions_at(now())["BTC"];
        let j = book.json();
        let asset = find(list(&j, "assets"), "assetId", "BTC").unwrap();
        assert_eq!(Some(f(at.qty)), text(asset, "openQty"), "{method:?}");
        assert_eq!(at.cost.map(f), text(asset, "openCostUsd"), "{method:?}");
    }
}

#[test]
fn follows_coins_moved_to_a_space_and_back() {
    let mv = |tx: &str, n: i64, from: Option<&str>, to: Option<&str>| OwnMove {
        tx_id: tx.to_owned(),
        posted_at: d(n),
        asset_id: "BTC".to_owned(),
        amount: amt("0.2"),
        from: from.map(str::to_owned),
        to: to.map(str::to_owned),
    };
    let book = book_with(
        &[buy(), sell()],
        &[("BTC", "0.5"), ("USDT", "150")],
        Extra {
            moves: vec![
                mv("m1", 10, None, Some("space-1")),
                mv("m2", 12, Some("space-1"), None),
            ],
            ..Extra::default()
        },
    );
    let timeline = BookTimeline::new(&book);
    let qty = |n: i64| f(timeline.positions_at(d(n))["BTC"].qty);
    assert_eq!(qty(9), "0.5");
    assert_eq!(qty(11), "0.3");
    assert_eq!(qty(13), "0.5");
    assert_eq!(timeline.positions_at(d(13))["BTC"].cost.map(f), some("50"));
}

// chooseInterval and samplesOf

#[test]
fn picks_the_finest_candle_that_fits() {
    let back = |days: i64| Instant(now().0 - days * DAY);
    let pick = |from: Instant, to: Instant| choose_interval(from, to, now()).map(|t| t.name());
    assert_eq!(pick(back(1), now()), Some("5m"));
    assert_eq!(pick(back(7), now()), Some("1h"));
    assert_eq!(pick(back(30), now()), Some("4h"));
    assert_eq!(pick(back(365), now()), Some("1d"));
    assert_eq!(pick(back(90), back(89)), Some("4h"));
    assert_eq!(pick(back(20 * 365), now()), None);
}

#[test]
fn draws_the_start_every_candle_edge_inside_and_the_end() {
    let points: Vec<_> = samples_of(day(2, 6), day(4, 6), SeriesTimeframe::D1)
        .into_iter()
        .map(Instant::iso)
        .collect();
    let want: Vec<_> = [day(2, 6), d(3), d(4), day(4, 6)]
        .into_iter()
        .map(Instant::iso)
        .collect();
    assert_eq!(points, want);
}

// TaxService.pnlOverTime

const USER: &str = "u-over-time";

type Asked = Arc<Mutex<Vec<(String, &'static str, String, String)>>>;

fn service_deps() -> (TaxDeps, Asked) {
    let ledger = Arc::new(FakeLedger {
        balances: fake::held(USER, &[("BTC", "0.5"), ("USDT", "150")]),
        fills: Some(Ok(fake::fills(vec![buy(), sell()]))),
        ..FakeLedger::default()
    });
    let asked: Asked = Arc::new(Mutex::new(Vec::new()));
    let seen = asked.clone();
    let mut deps = fake::deps(ledger, now());
    deps.closes = Some(fake::closes(move |asset, timeframe, from, to| {
        seen.lock()
            .unwrap()
            .push((asset.to_owned(), timeframe.name(), from.iso(), to.iso()));
        Ok(Some(daily_from(0, 21)))
    }));
    (deps, asked)
}

fn ask(from: Instant, to: Option<Instant>) -> PnlInput {
    PnlInput {
        from,
        to,
        utc_offset_minutes: 0,
    }
}

#[test]
fn reads_each_coin_once_and_ends_a_future_range_now() {
    let (deps, asked) = service_deps();
    let out = fake::service(deps)
        .pnl_over_time(USER, &ask(d(1), Some(d(30))))
        .unwrap();
    assert_eq!(text(&out, "to"), Some(now().iso()));
    assert_eq!(text(&out, "interval"), some("4h"));
    assert_eq!(
        *asked.lock().unwrap(),
        vec![("BTC".to_owned(), "4h", d(1).iso(), now().iso())]
    );
}

#[test]
fn refuses_an_empty_future_or_too_old_range() {
    let tax = fake::service(service_deps().0);
    assert_eq!(
        fake::refused(tax.pnl_over_time(USER, &ask(d(22), None))).code,
        TAX_PNL_RANGE_INVALID
    );
    assert_eq!(
        fake::refused(tax.pnl_over_time(USER, &ask(Instant(now().0 - 20 * 365 * DAY), None))).code,
        TAX_PNL_RANGE_TOO_LONG
    );
}

#[test]
fn draws_nothing_from_part_of_the_market_data() {
    let (mut deps, _) = service_deps();
    deps.closes = None;
    assert_eq!(
        fake::refused(fake::service(deps).pnl_over_time(USER, &ask(d(10), None))).code,
        TAX_PNL_PRICES_UNAVAILABLE
    );
    let (mut deps, _) = service_deps();
    deps.closes = Some(fake::closes(|_, _, _, _| Err(fake::internal("down"))));
    assert_eq!(
        fake::refused(fake::service(deps).pnl_over_time(USER, &ask(d(10), None))).code,
        TAX_PNL_PRICES_UNAVAILABLE
    );
}
