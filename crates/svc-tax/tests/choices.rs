//! `services/svc-tax/src/choices.test.ts`, case for case (the memory store; the Postgres store is the I/O side's).
//! Every figure here is hand-computed TEST data.
#![allow(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

mod common;

use std::sync::Arc;

use common::fake;
use common::{amt, assert_json, assert_match, door, find, list, some, text, utc};
use svc_tax::choices::{MemoryChoiceStore, no_choices, sale_rules};
use svc_tax::inputs::{DayMethodInput, LotMethodInput, PickInput};
use svc_tax::json::Json;
use svc_tax::lot_engine::{
    LotSource, MethodSource, Movement, SaleAt, SaleRule, SaleRules, Side, run_lot_engine,
};
use svc_tax::ports::{
    ChoiceStore, CostBasisChoices, DayChoice, EngineMethod, Fill, FillLeg, Ledger, LotPick,
    TaxBalance, TradeFillReader, TradeFills,
};
use svc_tax::tax::{
    Account, Failure, HistoryEntry, Range, TAX_BASIS_STORE_UNWIRED, TAX_CHOICES_UNAVAILABLE,
    TAX_LOT_PICK_INVALID, TAX_LOT_PICK_UNUSABLE, TaxService,
};
use svc_tax::time::Instant;

const USER: &str = "11111111-1111-4111-8111-111111111111";
const OTHER: &str = "33333333-3333-4333-8333-333333333333";

fn at(day: i64) -> Instant {
    utc(2026, 10, day, 12, 0)
}

fn sale_at(tx: &str, day: i64, asset: &str) -> Movement {
    Movement {
        tx_id: tx.to_owned(),
        posted_at: at(day),
        asset_id: asset.to_owned(),
        qty: amt("1"),
        side: Side::Dispose {
            proceeds_usd: Some(amt("300")),
            moved_out: false,
        },
    }
}

fn rule_of(rules: &dyn Fn(SaleAt<'_>) -> SaleRule, m: &Movement) -> SaleRule {
    rules(SaleAt {
        tx_id: &m.tx_id,
        posted_at: m.posted_at,
        asset_id: &m.asset_id,
    })
}

fn saved() -> CostBasisChoices {
    CostBasisChoices {
        account_method: Some(EngineMethod::Lifo),
        asset_methods: vec![("ETH".to_owned(), EngineMethod::Hifo)],
        days: vec![
            DayChoice {
                day: "2026-10-05".to_owned(),
                asset_id: Some("BTC".to_owned()),
                method: EngineMethod::Average,
            },
            DayChoice {
                day: "2026-10-05".to_owned(),
                asset_id: None,
                method: EngineMethod::Fifo,
            },
            DayChoice {
                day: "2026-10-06".to_owned(),
                asset_id: None,
                method: EngineMethod::Hifo,
            },
        ],
        picks: vec![LotPick {
            sale_tx_id: "s9".to_owned(),
            asset_id: "BTC".to_owned(),
            lot_id: "lot:b1:BTC".to_owned(),
        }],
        include_transfers: None,
    }
}

// which method a sale uses

#[test]
fn most_specific_first() {
    let rule = sale_rules(&saved(), EngineMethod::Fifo, None);
    let r = |tx: &str, day: i64, asset: &str| {
        let x = rule_of(&rule, &sale_at(tx, day, asset));
        (x.method, x.source)
    };
    assert_eq!(
        r("s1", 5, "BTC"),
        (EngineMethod::Average, MethodSource::Day)
    );
    assert_eq!(r("s2", 5, "ETH"), (EngineMethod::Fifo, MethodSource::Day));
    assert_eq!(r("s3", 6, "ETH"), (EngineMethod::Hifo, MethodSource::Day));
    assert_eq!(r("s4", 7, "ETH"), (EngineMethod::Hifo, MethodSource::Asset));
    assert_eq!(
        r("s5", 7, "BTC"),
        (EngineMethod::Lifo, MethodSource::Account)
    );
    let none = sale_rules(&no_choices(), EngineMethod::Fifo, None);
    let x = rule_of(&none, &sale_at("s6", 7, "BTC"));
    assert_eq!(
        (x.method, x.source),
        (EngineMethod::Fifo, MethodSource::Default)
    );
}

#[test]
fn a_pick_rides_along_and_a_preview_applies_one_method_and_no_pick() {
    let rule = sale_rules(&saved(), EngineMethod::Fifo, None);
    let x = rule_of(&rule, &sale_at("s9", 7, "BTC"));
    assert_eq!(
        (x.method, x.lot_id.as_deref()),
        (EngineMethod::Lifo, Some("lot:b1:BTC"))
    );
    let preview = sale_rules(&saved(), EngineMethod::Fifo, Some(EngineMethod::Hifo));
    assert_eq!(
        rule_of(&preview, &sale_at("s9", 5, "BTC")),
        SaleRule {
            method: EngineMethod::Hifo,
            lot_id: None,
            source: MethodSource::Preview,
        }
    );
}

// a picked lot in the engine

fn buy(tx: &str, day: i64, cost: &str) -> Movement {
    Movement {
        tx_id: tx.to_owned(),
        posted_at: at(day),
        asset_id: "BTC".to_owned(),
        qty: amt("1"),
        side: Side::Acquire {
            cost_usd: Some(amt(cost)),
            source: LotSource::Trade,
            reason: "trade.fill".to_owned(),
            valued_at: None,
            space: None,
            carried: None,
        },
    }
}

fn history() -> Vec<Movement> {
    vec![
        buy("b1", 1, "100"),
        buy("b2", 2, "200"),
        buy("b3", 3, "150"),
        sale_at("s1", 4, "BTC"),
    ]
}

fn account_rule(method: EngineMethod, lot: Option<&str>) -> SaleRule {
    SaleRule {
        method,
        lot_id: lot.map(str::to_owned),
        source: MethodSource::Account,
    }
}

#[test]
fn a_picked_lot_is_drawn_first_and_other_sales_keep_their_method() {
    let mut h = history();
    h.push(sale_at("s2", 5, "BTC"));
    let by = |s: SaleAt<'_>| {
        if s.tx_id == "s1" {
            account_rule(EngineMethod::Fifo, Some("lot:b2:BTC"))
        } else {
            account_rule(EngineMethod::Fifo, None)
        }
    };
    let run = run_lot_engine(&h, &SaleRules::By(&by), None, None);
    let first = run.sales.iter().find(|s| s.tx_id == "s1").unwrap();
    let later = run.sales.iter().find(|s| s.tx_id == "s2").unwrap();
    assert_eq!(run.sales[0].tx_id, "s2", "newest first");
    assert_eq!(
        (first.picked_lot_id.as_deref(), first.realized_usd),
        (Some("lot:b2:BTC"), Some(amt("100")))
    );
    assert_eq!(
        (later.picked_lot_id.as_deref(), later.realized_usd),
        (None, Some(amt("200")))
    );
}

#[test]
fn a_pick_bigger_than_its_lot_takes_the_lot_then_the_method() {
    let mut h: Vec<Movement> = history().into_iter().take(3).collect();
    let mut two = sale_at("s1", 4, "BTC");
    two.qty = amt("2");
    two.side = Side::Dispose {
        proceeds_usd: Some(amt("600")),
        moved_out: false,
    };
    h.push(two);
    let by = |_: SaleAt<'_>| account_rule(EngineMethod::Lifo, Some("lot:b1:BTC"));
    let run = run_lot_engine(&h, &SaleRules::By(&by), None, None);
    let ids: Vec<_> = run.sales[0]
        .matches
        .iter()
        .map(|m| m.lot_id.as_str())
        .collect();
    assert_eq!(ids, vec!["lot:b1:BTC", "lot:b3:BTC"]);
    assert_eq!(run.sales[0].cost_usd, Some(amt("250")));
}

#[test]
fn a_lot_no_longer_open_is_named_and_the_method_decides() {
    let by = |_: SaleAt<'_>| account_rule(EngineMethod::Hifo, Some("lot:gone:BTC"));
    let run = run_lot_engine(&history(), &SaleRules::By(&by), None, None);
    assert_eq!(
        (
            run.sales[0].picked_lot_id.as_deref(),
            run.sales[0].realized_usd
        ),
        (None, Some(amt("100")))
    );
    assert!(run.residuals.contains(&TAX_LOT_PICK_UNUSABLE));
}

// the lot book applies what the customer saved

fn fill(tx: &str, day: i64, received: (&str, &str), paid: (&str, &str)) -> Fill {
    Fill {
        tx_id: tx.to_owned(),
        posted_at: at(day),
        received: FillLeg {
            asset_id: received.0.to_owned(),
            amount: amt(received.1),
        },
        paid: Some(FillLeg {
            asset_id: paid.0.to_owned(),
            amount: amt(paid.1),
        }),
        fee: None,
        fee_asset_id: None,
    }
}

/// TEST fills: buy 1 BTC at 100 (day 1), buy 1 at 200 (day 2), sell 1 for 300 (day 3). The caller holds 1.
fn fills() -> Vec<Fill> {
    vec![
        fill("b1", 1, ("BTC", "1"), ("USDT", "100")),
        fill("b2", 2, ("BTC", "1"), ("USDT", "200")),
        fill("s1", 3, ("USDT", "300"), ("BTC", "1")),
    ]
}

/// The ledger by user: each user named holds 1 BTC and has these fills.
struct ByUser(Vec<(String, Vec<Fill>)>);

impl Ledger for ByUser {
    fn balances(&self, _owner_type: &str, user: &str) -> Result<Vec<TaxBalance>, Failure> {
        Ok(if self.0.iter().any(|(u, _)| u == user) {
            vec![TaxBalance {
                account: Account {
                    owner_type: "user".to_owned(),
                    owner_id: user.to_owned(),
                    asset_id: "BTC".to_owned(),
                    kind: "available".to_owned(),
                },
                purpose: None,
                account_id: "a".to_owned(),
                amount: amt("1"),
            }]
        } else {
            vec![]
        })
    }
    fn history(&self, _account: &Account, _range: Range) -> Result<Vec<HistoryEntry>, Failure> {
        Ok(vec![])
    }
    fn trade_fills(&self) -> Option<&dyn TradeFillReader> {
        Some(self)
    }
}

impl TradeFillReader for ByUser {
    fn trade_fills(&self, user: &str) -> Result<TradeFills, Failure> {
        let mut t = fake::fills(
            self.0
                .iter()
                .find(|(u, _)| u == user)
                .map(|(_, f)| f.clone())
                .unwrap_or_default(),
        );
        t.inflows = Some(vec![]);
        Ok(t)
    }
}

fn reads(by_user: &[(&str, Vec<Fill>)]) -> Arc<ByUser> {
    Arc::new(ByUser(
        by_user
            .iter()
            .map(|(u, f)| ((*u).to_owned(), f.clone()))
            .collect(),
    ))
}

fn service_over(choices: Option<Arc<dyn ChoiceStore>>, r: Arc<ByUser>) -> TaxService {
    let mut d = svc_tax::tax::TaxDeps::new("", r, None, Box::new(|| at(21)));
    d.choices = choices;
    fake::service(d)
}

fn service() -> TaxService {
    service_over(
        Some(Arc::new(MemoryChoiceStore::new())),
        reads(&[(USER, fills())]),
    )
}

fn book(tax: &TaxService, user: &str, method: Option<&str>) -> Json {
    tax.lot_book(user, method).unwrap().json()
}

fn set_method(
    tax: &TaxService,
    asset: Option<&str>,
    method: Option<&str>,
) -> Result<Json, Failure> {
    tax.set_lot_method(
        USER,
        &LotMethodInput {
            asset_id: asset.map(str::to_owned),
            method: method.map(str::to_owned),
        },
    )
}

fn set_day(tax: &TaxService, day: &str, method: Option<&str>) -> Result<Json, Failure> {
    tax.set_day_method(
        USER,
        &DayMethodInput {
            day: day.to_owned(),
            asset_id: None,
            method: method.map(str::to_owned),
        },
    )
}

fn pick(
    tax: &TaxService,
    user: &str,
    sale: &str,
    asset: &str,
    lot: Option<&str>,
) -> Result<Json, Failure> {
    tax.pick_sale_lot(
        user,
        &PickInput {
            sale_tx_id: sale.to_owned(),
            asset_id: asset.to_owned(),
            lot_id: lot.map(str::to_owned),
        },
    )
}

fn first_sale(j: &Json) -> &Json {
    &list(j, "sales")[0]
}

#[test]
fn the_account_method_changes_the_result_and_a_coin_method_overrides_it() {
    let tax = service();
    assert_eq!(text(&book(&tax, USER, None), "realizedUsd"), some("200"));
    set_method(&tax, None, Some("LIFO")).unwrap();
    let lifo = book(&tax, USER, None);
    assert_match(
        &lifo,
        r#"{"method":"LIFO","preview":false,"realizedUsd":"100"}"#,
    );
    assert_match(
        first_sale(&lifo),
        r#"{"method":"LIFO","methodSource":"account"}"#,
    );
    assert_eq!(
        text(
            find(list(&lifo, "assets"), "assetId", "BTC").unwrap(),
            "openCostUsd"
        ),
        some("100")
    );
    set_method(&tax, Some("BTC"), Some("AVERAGE")).unwrap();
    let avg = book(&tax, USER, None);
    assert_match(&avg, r#"{"method":"LIFO","realizedUsd":"150"}"#);
    assert_match(
        first_sale(&avg),
        r#"{"method":"AVERAGE","methodSource":"asset"}"#,
    );
    assert_json(
        avg.get("choices").unwrap(),
        r#"{"status":"saved","accountMethod":"LIFO","assetMethods":[{"assetId":"BTC","method":"AVERAGE"}],"days":[],"picks":[],"includeTransfers":null}"#,
    );
    let preview = book(&tax, USER, Some("HIFO"));
    assert_match(
        &preview,
        r#"{"method":"HIFO","preview":true,"realizedUsd":"100"}"#,
    );
    assert_match(first_sale(&preview), r#"{"methodSource":"preview"}"#);
    assert_eq!(text(&book(&tax, USER, None), "realizedUsd"), some("150"));
    set_method(&tax, Some("BTC"), None).unwrap();
    set_method(&tax, None, None).unwrap();
    assert_match(
        &book(&tax, USER, None),
        r#"{"method":"FIFO","realizedUsd":"200"}"#,
    );
}

#[test]
fn a_day_method_applies_to_that_day_only() {
    let tax = service();
    set_day(&tax, "2026-10-03", Some("HIFO")).unwrap();
    assert_match(
        first_sale(&book(&tax, USER, None)),
        r#"{"method":"HIFO","methodSource":"day","realizedUsd":"100"}"#,
    );
    set_day(&tax, "2026-10-04", Some("HIFO")).unwrap();
    set_day(&tax, "2026-10-03", None).unwrap();
    assert_match(
        first_sale(&book(&tax, USER, None)),
        r#"{"method":"FIFO","methodSource":"default"}"#,
    );
}

#[test]
fn a_pick_uses_that_lot_and_is_checked_against_the_callers_own_book() {
    let tax = service_over(
        Some(Arc::new(MemoryChoiceStore::new())),
        reads(&[(USER, fills()), (OTHER, fills())]),
    );
    pick(&tax, USER, "s1", "BTC", Some("lot:b2:BTC")).unwrap();
    assert_match(
        first_sale(&book(&tax, USER, None)),
        r#"{"pickedLotId":"lot:b2:BTC","realizedUsd":"100","method":"FIFO"}"#,
    );
    assert_match(
        first_sale(&book(&tax, OTHER, None)),
        r#"{"pickedLotId":null,"realizedUsd":"200"}"#,
    );
    for (sale, asset, lot) in [
        ("nope", "BTC", "lot:b1:BTC"),
        ("s1", "BTC", "lot:zz:BTC"),
        ("s1", "ETH", "lot:b1:BTC"),
    ] {
        let e = fake::refused(pick(&tax, USER, sale, asset, Some(lot)));
        assert_eq!(e.code, TAX_LOT_PICK_INVALID, "{sale} {asset} {lot}");
    }
    let loner = service();
    let e = fake::refused(pick(&loner, OTHER, "s1", "BTC", Some("lot:b1:BTC")));
    assert_eq!(e.code, TAX_LOT_PICK_INVALID);
    pick(&tax, USER, "s1", "BTC", None).unwrap();
    assert_match(
        first_sale(&book(&tax, USER, None)),
        r#"{"pickedLotId":null,"realizedUsd":"200"}"#,
    );
}

#[test]
fn a_sale_at_the_average_cost_takes_no_pick() {
    let tax = service();
    set_method(&tax, Some("BTC"), Some("AVERAGE")).unwrap();
    let e = fake::refused(pick(&tax, USER, "s1", "BTC", Some("lot:b2:BTC")));
    assert_eq!(e.code, TAX_LOT_PICK_INVALID);
    assert_match(
        book(&tax, USER, None).get("choices").unwrap(),
        r#"{"picks":[]}"#,
    );
}

#[test]
fn a_lot_that_arrived_after_the_sale_cannot_be_picked() {
    let mut f = fills();
    let mut late = f[1].clone();
    late.tx_id = "b9".to_owned();
    late.posted_at = at(9);
    f.push(late);
    let tax = service_over(
        Some(Arc::new(MemoryChoiceStore::new())),
        reads(&[(USER, f)]),
    );
    let e = fake::refused(pick(&tax, USER, "s1", "BTC", Some("lot:b9:BTC")));
    assert_eq!(e.code, TAX_LOT_PICK_INVALID);
}

#[test]
fn a_lot_used_up_by_an_earlier_sale_cannot_be_picked_for_a_later_one() {
    let mut more = fills();
    more.push(fill("s2", 5, ("USDT", "250"), ("BTC", "1")));
    more.push(fill("b3", 4, ("BTC", "1"), ("USDT", "150")));
    let tax = service_over(
        Some(Arc::new(MemoryChoiceStore::new())),
        reads(&[(USER, more)]),
    );
    let e = fake::refused(pick(&tax, USER, "s2", "BTC", Some("lot:b1:BTC")));
    assert_eq!(e.code, TAX_LOT_PICK_INVALID);
    pick(&tax, USER, "s2", "BTC", Some("lot:b3:BTC")).unwrap();
    assert_match(
        find(list(&book(&tax, USER, None), "sales"), "txId", "s2").unwrap(),
        r#"{"pickedLotId":"lot:b3:BTC","realizedUsd":"100"}"#,
    );
}

/// The memory store whose read fails.
struct Broken(MemoryChoiceStore);

impl ChoiceStore for Broken {
    fn read(&self, _user_id: &str) -> Result<CostBasisChoices, Failure> {
        Err(Failure::Internal("connection refused".to_owned()))
    }
    fn set_method(&self, u: &str, a: Option<&str>, m: Option<EngineMethod>) -> Result<(), Failure> {
        self.0.set_method(u, a, m)
    }
    fn set_day_method(
        &self,
        u: &str,
        d: &str,
        a: Option<&str>,
        m: Option<EngineMethod>,
    ) -> Result<(), Failure> {
        self.0.set_day_method(u, d, a, m)
    }
    fn set_pick(&self, u: &str, t: &str, a: &str, l: Option<&str>) -> Result<(), Failure> {
        self.0.set_pick(u, t, a, l)
    }
    fn set_include_transfers(&self, u: &str, i: Option<bool>) -> Result<(), Failure> {
        self.0.set_include_transfers(u, i)
    }
}

#[test]
fn when_the_saved_choices_cannot_be_read_the_book_answers_with_the_default() {
    let tax = service_over(
        Some(Arc::new(Broken(MemoryChoiceStore::new()))),
        reads(&[(USER, fills())]),
    );
    assert_match(
        &book(&tax, USER, None),
        &format!(
            r#"{{"method":"FIFO","realizedUsd":"200","choices":{{"status":"unavailable","code":"{TAX_CHOICES_UNAVAILABLE}"}}}}"#
        ),
    );
}

#[test]
fn with_no_settings_store_the_book_says_so_and_a_save_is_refused_by_name() {
    let tax = service_over(None, reads(&[(USER, fills())]));
    assert_match(
        &book(&tax, USER, None),
        &format!(
            r#"{{"method":"FIFO","choices":{{"status":"unwired","code":"{TAX_BASIS_STORE_UNWIRED}"}}}}"#
        ),
    );
    assert_eq!(
        fake::refused(set_method(&tax, None, Some("LIFO"))).code,
        TAX_BASIS_STORE_UNWIRED
    );
    assert_eq!(
        fake::refused(set_day(&tax, "2026-10-03", Some("HIFO"))).code,
        TAX_BASIS_STORE_UNWIRED
    );
    assert_eq!(
        fake::refused(pick(&tax, USER, "s1", "BTC", Some("lot:b1:BTC"))).code,
        TAX_BASIS_STORE_UNWIRED
    );
}

// the settings doors

#[test]
fn the_doors_need_tax_write_and_save_the_callers_own_choice() {
    let wire = door::serve(service());
    let reader = door::signed(USER, &["tax:read"], "DE");
    let r = door::mutate(
        &wire,
        &reader,
        "setLotMethod",
        r#"{"assetId":null,"method":"LIFO"}"#,
    );
    assert_eq!(door::error(&r).1, "FORBIDDEN");
    let writer = door::signed(USER, &["tax:read", "tax:write"], "DE");
    for (path, input) in [
        ("setLotMethod", r#"{"assetId":"BTC","method":"LIFO"}"#),
        (
            "setDayMethod",
            r#"{"day":"2026-10-03","assetId":null,"method":"HIFO"}"#,
        ),
        (
            "pickSaleLot",
            r#"{"saleTxId":"s1","assetId":"BTC","lotId":"lot:b2:BTC"}"#,
        ),
    ] {
        assert_json(
            &door::data(&door::mutate(&wire, &writer, path, input)),
            r#"{"saved":true}"#,
        );
    }
    let j = door::data(&door::query(&wire, &writer, "lotBook", None));
    assert_match(
        j.get("choices").unwrap(),
        r#"{"status":"saved","assetMethods":[{"assetId":"BTC","method":"LIFO"}]}"#,
    );
    assert_match(
        first_sale(&j),
        r#"{"method":"HIFO","methodSource":"day","pickedLotId":"lot:b2:BTC"}"#,
    );
}

#[test]
fn the_doors_refuse_a_malformed_coin_day_or_method() {
    let wire = door::serve(service());
    let writer = door::signed(USER, &["tax:write"], "DE");
    for (path, input) in [
        ("setLotMethod", r#"{"assetId":"btc;","method":"LIFO"}"#),
        (
            "setDayMethod",
            r#"{"day":"2026-02-30","assetId":null,"method":"LIFO"}"#,
        ),
        ("setLotMethod", r#"{"assetId":null,"method":"LOFO"}"#),
    ] {
        assert_eq!(
            door::error(&door::mutate(&wire, &writer, path, input)).1,
            "BAD_REQUEST",
            "{input}"
        );
    }
}
