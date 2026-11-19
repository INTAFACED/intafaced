//! `services/svc-tax/src/basis-override.test.ts`, case for case (PF-cost-basis-04), over the memory basis store (the
//! Postgres store is the I/O side's).
#![allow(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

mod common;

use std::sync::Arc;

use common::fake::{self, FakeLedger};
use common::{amt, assert_json, assert_match, door, find, list, some, text, utc};
use svc_tax::basis::{
    MemoryBasisStore, TAX_BASIS_OVERRIDE_ABSENT, TAX_BASIS_PRICE_UNSET, UNKNOWN_SHARE,
};
use svc_tax::inputs::BasisSetInput;
use svc_tax::json::Json;
use svc_tax::ports::{BasisStore, Fill, FillLeg, InflowLine, TradeFills};
use svc_tax::tax::{
    DepositBasisPolicy, PORTFOLIO_BASIS_OVERRIDE_NOT_ALLOWED, TAX_BASIS_STORE_UNWIRED,
    TAX_COST_BASIS_UNAVAILABLE, TAX_CUSTOMER_BASIS_EXPORT_UNSET, TaxService,
};
use svc_tax::time::Instant;

const USER: &str = "11111111-1111-4111-8111-111111111111";
const OTHER: &str = "22222222-2222-4222-8222-222222222222";

fn at(day: i64) -> Instant {
    utc(2026, 1, day, 12, 0)
}

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

fn sell() -> Fill {
    fill("s1", 10, ("USDT", "150"), ("BTC", "1"))
}

fn buy() -> Fill {
    fill("b1", 1, ("BTC", "1"), ("USDT", "100"))
}

fn deposit() -> InflowLine {
    InflowLine {
        tx_id: "d1".to_owned(),
        posted_at: at(2),
        asset_id: "BTC".to_owned(),
        amount: amt("1"),
        reason: "deposit.credited".to_owned(),
    }
}

fn reads(fills: Vec<Fill>, inflows: Vec<InflowLine>, held: &[(&str, &str)]) -> Arc<FakeLedger> {
    let mut outside: Vec<String> = inflows.iter().map(|l| l.asset_id.clone()).collect();
    outside.dedup();
    Arc::new(FakeLedger {
        balances: fake::held(USER, held),
        fills: Some(Ok(TradeFills {
            outside_inflows: outside,
            inflows: Some(inflows),
            ..fake::fills(fills)
        })),
        ..FakeLedger::default()
    })
}

fn service_over(store: Arc<MemoryBasisStore>, book: Arc<FakeLedger>) -> TaxService {
    let mut d = fake::deps(book, at(20));
    d.map_raw = r#"["DE"]"#.to_owned();
    d.history_years = Some(10);
    d.deposit_basis = Some(DepositBasisPolicy::Customer);
    d.basis = Some(store);
    fake::service(d)
}

fn service() -> TaxService {
    service_over(
        Arc::new(MemoryBasisStore::new()),
        reads(vec![sell()], vec![deposit()], &[]),
    )
}

fn write() -> BasisSetInput {
    BasisSetInput {
        lot_id: "lot:d1:BTC".to_owned(),
        price_per_unit: "100".to_owned(),
        date: "2026-01-02T00:00:00.000Z".to_owned(),
        source_note: "TEST receipt".to_owned(),
        asset_id: None,
        qty: None,
    }
}

fn book(tax: &TaxService, user: &str) -> Json {
    tax.lot_book(user, None).unwrap().json()
}

fn first_sale(j: &Json) -> &Json {
    &list(j, "sales")[0]
}

#[test]
fn names_the_lot_then_recomputes_from_the_entered_price() {
    let store = Arc::new(MemoryBasisStore::new());
    let tax = service_over(store.clone(), reads(vec![sell()], vec![deposit()], &[]));
    assert_json(
        tax.missing_basis(USER, None).unwrap().get("items").unwrap(),
        &format!(
            r#"[{{"lotId":"lot:d1:BTC","assetId":"BTC","kind":"disposal","qty":"1","code":"{TAX_COST_BASIS_UNAVAILABLE}",
            "effect":"{UNKNOWN_SHARE}","saleTxId":"s1"}}]"#
        ),
    );
    assert_eq!(text(first_sale(&book(&tax, USER)), "realizedUsd"), None);

    let saved = tax.basis_override_set(USER, &write()).unwrap();
    assert_match(
        &saved,
        r#"{"version":1,"kind":"override","basisSource":"customer-entered"}"#,
    );
    assert_eq!(
        text(&saved, "businessKey"),
        Some(format!("basisoverride:{USER}:lot:d1:BTC:1"))
    );
    let again = tax
        .basis_override_set(
            USER,
            &BasisSetInput {
                price_per_unit: "100.0".to_owned(),
                ..write()
            },
        )
        .unwrap();
    assert_eq!(text(&again, "version"), some("1"));
    assert_eq!(text(&again, "businessKey"), text(&saved, "businessKey"));

    let after = book(&tax, USER);
    assert_match(
        first_sale(&after),
        r#"{"realizedUsd":"50","costUsd":"100","basisSource":"customer-entered"}"#,
    );
    assert_match(
        &list(first_sale(&after), "matches")[0],
        r#"{"lotId":"lot:d1:BTC","costUsd":"100","basisSource":"customer-entered"}"#,
    );
    assert_match(
        find(list(&after, "lots"), "id", "lot:d1:BTC").unwrap(),
        r#"{"costUsd":"100","basisSource":"customer-entered"}"#,
    );
    assert_json(&tax.missing_basis(USER, None).unwrap(), r#"{"items":[]}"#);

    let removed = tax.basis_override_remove(USER, "lot:d1:BTC").unwrap();
    assert_eq!(text(&removed, "kind"), some("tombstone"));
    assert_eq!(removed.get("basisSource"), Some(&Json::Null));
    let removed_again = tax.basis_override_remove(USER, "lot:d1:BTC").unwrap();
    assert_eq!(text(&removed_again, "version"), text(&removed, "version"));
    assert_eq!(text(first_sale(&book(&tax, USER)), "realizedUsd"), None);
    assert!(store.list_active(USER).unwrap().is_empty());
}

#[test]
fn refuses_a_lot_with_a_cost_a_blank_price_and_a_missing_store() {
    let tax = service_over(
        Arc::new(MemoryBasisStore::new()),
        reads(vec![buy()], vec![], &[("BTC", "1")]),
    );
    let e = fake::refused(tax.basis_override_set(
        USER,
        &BasisSetInput {
            lot_id: "lot:b1:BTC".to_owned(),
            ..write()
        },
    ));
    assert_eq!(e.code, PORTFOLIO_BASIS_OVERRIDE_NOT_ALLOWED);
    let e = fake::refused(tax.basis_override_set(
        USER,
        &BasisSetInput {
            price_per_unit: "  ".to_owned(),
            ..write()
        },
    ));
    assert_eq!(e.code, TAX_BASIS_PRICE_UNSET);
    let e = fake::refused(tax.basis_override_remove(USER, "lot:missing"));
    assert_eq!(e.code, TAX_BASIS_OVERRIDE_ABSENT);
    let bare = fake::service(fake::deps(reads(vec![], vec![], &[]), at(20)));
    assert_eq!(
        fake::refused(bare.basis_override_set(USER, &write())).code,
        TAX_BASIS_STORE_UNWIRED
    );
}

#[test]
fn keeps_a_manual_position_out_of_the_holding_totals() {
    let tax = service_over(
        Arc::new(MemoryBasisStore::new()),
        reads(vec![buy()], vec![], &[("BTC", "1")]),
    );
    tax.basis_override_set(
        USER,
        &BasisSetInput {
            lot_id: format!("manual:{USER}:desk"),
            price_per_unit: "10".to_owned(),
            date: "2026-01-01T00:00:00.000Z".to_owned(),
            source_note: "TEST desk".to_owned(),
            asset_id: Some("ETH".to_owned()),
            qty: Some("2".to_owned()),
        },
    )
    .unwrap();
    let j = book(&tax, USER);
    assert_json(
        j.get("manualPositions").unwrap(),
        &format!(
            r#"[{{"id":"manual:{USER}:desk","assetId":"ETH","acquiredAt":"2026-01-01T00:00:00.000Z","qty":"2","costUsd":"20",
            "pricePerUnit":"10","sourceNote":"TEST desk","basisSource":"customer-entered","heldApart":true}}]"#
        ),
    );
    assert!(find(list(&j, "assets"), "assetId", "ETH").is_none());
    assert_match(
        find(list(&j, "assets"), "assetId", "BTC").unwrap(),
        r#"{"openQty":"1","held":"1","openCostUsd":"100"}"#,
    );
    assert!(find(list(&j, "lots"), "assetId", "ETH").is_none());
}

#[test]
fn one_customers_price_is_not_on_anothers_book_and_the_pack_is_marked() {
    let tax = service();
    tax.basis_override_set(USER, &write()).unwrap();
    let theirs = book(&tax, OTHER);
    assert_eq!(
        find(list(&theirs, "lots"), "id", "lot:d1:BTC")
            .unwrap()
            .get("basisSource"),
        None
    );
    assert_eq!(text(first_sale(&theirs), "realizedUsd"), None);
    let residual = |t: &TaxService| {
        list(
            &t.export(USER, "DE", "FIFO", None).unwrap().preview(),
            "residuals",
        )
        .contains(&Json::str(TAX_CUSTOMER_BASIS_EXPORT_UNSET))
    };
    assert!(residual(&tax));
    assert!(!residual(&service()));
}

#[test]
fn the_write_refuses_a_read_scope_and_accepts_tax_write() {
    let wire = door::serve(service());
    let body = r#"{"lotId":"lot:d1:BTC","pricePerUnit":"100","date":"2026-01-02T00:00:00.000Z","sourceNote":"TEST receipt"}"#;
    let reader = door::signed(USER, &["tax:read"], "DE");
    assert_eq!(
        door::error(&door::mutate(&wire, &reader, "basisOverride.set", body)).1,
        "FORBIDDEN"
    );
    let writer = door::signed(USER, &["tax:read", "tax:write"], "DE");
    let saved = door::data(&door::mutate(&wire, &writer, "basisOverride.set", body));
    assert_eq!(text(&saved, "version"), some("1"));
    assert_eq!(text(&saved, "lotId"), some("lot:d1:BTC"));
}
