//! `tax-service.test.ts`, case for case. `requirePublishedHistoryYears` is not a function of its
//! own in Rust: the window check sits in `export`, so it is asked through the service; a NaN from the environment
//! is the I/O side's to parse (named in the port's report).
#![allow(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

mod common;

use std::sync::{Arc, Mutex};

use common::fake::{self, FakeLedger};
use common::{amt, assert_json, date, list, some, text};
use svc_tax::json::{self, Json};
use svc_tax::ports::{Ledger, TaxBalance};
use svc_tax::tax::{
    Account, Failure, HistoryEntry, LakeStatus, Range, TAX_EXPORT_INCOMPLETE,
    TAX_HISTORY_YEARS_UNSET, TAX_JURISDICTION_UNMAPPED, TAX_LOT_METHOD_REQUIRED, TaxDeps,
    TaxService,
};

const OWNER_HISTORY_YEARS: i64 = 10;
const USER: &str = "11111111-1111-4111-8111-111111111111";

fn entry(tx: &str, reason: &str, debit: bool, at: &str) -> HistoryEntry {
    HistoryEntry {
        tx_id: tx.to_owned(),
        reason: reason.to_owned(),
        debit,
        amount: amt("1"),
        posted_at: date(at),
    }
}

fn btc(amount: &str) -> Vec<TaxBalance> {
    let mut b = fake::balance(USER, "BTC", amount);
    b.account_id = "acc-btc".to_owned();
    vec![b]
}

fn empty() -> Arc<FakeLedger> {
    Arc::new(FakeLedger::default())
}

fn books() -> Arc<FakeLedger> {
    Arc::new(FakeLedger {
        balances: btc("1"),
        history: vec![(
            "BTC".to_owned(),
            vec![entry(
                "tx-1",
                "deposit.credited",
                true,
                "2024-01-01T00:00:00.000Z",
            )],
        )],
        ..FakeLedger::default()
    })
}

fn tax(map: &str, ledger: Arc<dyn Ledger>, years: Option<i64>) -> TaxService {
    fake::service(TaxDeps::new(
        map,
        ledger,
        years,
        Box::new(|| date("2026-01-02T00:00:00.000Z")),
    ))
}

fn preview(t: &TaxService, method: &str) -> Result<Json, Failure> {
    t.export(USER, "DE", method, None).map(|x| x.preview())
}

fn pack(t: &TaxService, method: &str) -> Json {
    t.export(USER, "DE", method, None).unwrap().pack()
}

fn body(t: &TaxService) -> (Json, String) {
    let text = t.export(USER, "DE", "FIFO", None).unwrap().body;
    (json::parse(&text).unwrap(), text)
}

#[test]
fn a_blank_owner_map_refuses_unmapped() {
    let t = tax("", empty(), None);
    assert_eq!(
        fake::refused(preview(&t, "FIFO")).code,
        TAX_JURISDICTION_UNMAPPED
    );
}

#[test]
fn the_caller_must_select_a_lot_method() {
    let t = tax(r#"["DE"]"#, empty(), None);
    assert_eq!(
        fake::refused(t.export(USER, "DE", "", None).map(|x| x.preview())).code,
        TAX_LOT_METHOD_REQUIRED
    );
}

#[test]
fn unset_history_years_refuses_never_ten() {
    let t = tax(r#"["DE"]"#, empty(), None);
    assert_eq!(
        fake::refused(preview(&t, "FIFO")).code,
        TAX_HISTORY_YEARS_UNSET
    );
}

struct Captures {
    range: Mutex<Option<Range>>,
}

impl Ledger for Captures {
    fn balances(&self, _: &str, _: &str) -> Result<Vec<TaxBalance>, Failure> {
        Ok(btc("1"))
    }
    fn history(&self, _: &Account, range: Range) -> Result<Vec<HistoryEntry>, Failure> {
        *self.range.lock().unwrap() = Some(range);
        Ok(vec![])
    }
}

#[test]
fn the_owner_published_ten_is_the_window() {
    let reads = Arc::new(Captures {
        range: Mutex::new(None),
    });
    let t = tax(r#"["DE"]"#, reads.clone(), Some(OWNER_HISTORY_YEARS));
    pack(&t, "FIFO");
    let range = reads.range.lock().unwrap().unwrap();
    assert_eq!(range.from.iso(), "2016-01-01T00:00:00.000Z");
    assert_eq!(range.to.iso(), "2026-01-02T00:00:00.000Z");
}

#[test]
fn empty_books_return_an_empty_pack_and_name_the_missing_lake() {
    let t = tax(r#"{"DE":{}}"#, empty(), Some(OWNER_HISTORY_YEARS));
    let p = pack(&t, "FIFO");
    assert_eq!(p.get("empty"), Some(&Json::Bool(true)));
    assert_eq!(p.get("realized"), Some(&Json::Null));
    assert_eq!(p.get("unrealized"), Some(&Json::Null));
    assert_eq!(text(&p, "lotCount"), some("0"));
    assert_json(
        p.get("lake").unwrap(),
        r#"{"status":"absent","code":"tax.data_lake_unavailable"}"#,
    );
    assert_json(
        p.get("indexer").unwrap(),
        r#"{"status":"absent","code":"tax.indexer_unavailable"}"#,
    );
    assert_eq!(text(&p, "mime"), some("application/json"));
    let (b, raw) = body(&t);
    assert_eq!(b.get("realized"), Some(&Json::Null));
    assert!(text(&b, "note").unwrap().contains("empty book"));
    assert!(!raw.contains(r#""realized": "0""#));
}

#[test]
fn ledger_history_without_basis_does_not_invent_a_closed_lot() {
    let reads = Arc::new(FakeLedger {
        balances: btc("0"),
        history: vec![(
            "BTC".to_owned(),
            vec![
                entry("a1", "deposit.credited", true, "2024-01-01T00:00:00.000Z"),
                entry("d1", "trade.fill", false, "2024-02-01T00:00:00.000Z"),
            ],
        )],
        ..FakeLedger::default()
    });
    let t = tax(r#"["DE"]"#, reads, Some(OWNER_HISTORY_YEARS));
    let (b, raw) = body(&t);
    assert!(list(&b, "lotsClosed").is_empty());
    assert!(
        list(&b, "lotsOpen")
            .iter()
            .all(|l| l.get("costBasis") == Some(&Json::Null))
    );
    assert_eq!(b.get("realized"), Some(&Json::Null));
    assert!(!raw.contains(r#""costBasis": "0""#));
    assert!(list(&b, "residuals").contains(&Json::str("tax.cost_basis_unavailable")));
}

#[test]
fn a_mapped_region_and_fifo_return_amounts_as_strings() {
    let t = tax(r#"["DE"]"#, books(), Some(OWNER_HISTORY_YEARS));
    let p = preview(&t, "FIFO").unwrap();
    assert_eq!(p.get("empty"), Some(&Json::Bool(false)));
    assert_eq!(p.get("lotCount"), Some(&Json::Number(1.0)));
    assert_eq!(text(&p, "jurisdiction"), some("DE"));
    assert_eq!(p.get("realized"), Some(&Json::Null));
    assert_eq!(p.get("complete"), Some(&Json::Bool(false)));
    assert!(list(&p, "residuals").contains(&Json::str(TAX_EXPORT_INCOMPLETE)));
}

#[test]
fn the_export_door_never_claims_complete() {
    let t = fake::service(TaxDeps {
        lake: LakeStatus::lake(Some("http://lake.example/tsdb")),
        indexer: LakeStatus::indexer(Some("http://indexer.example")),
        ..TaxDeps::new(
            r#"["DE"]"#,
            books(),
            Some(OWNER_HISTORY_YEARS),
            Box::new(|| date("2026-01-02T00:00:00.000Z")),
        )
    });
    assert_eq!(
        fake::refused(
            t.export(USER, "DE", "FIFO", Some(true))
                .map(|x| x.preview())
        )
        .code,
        TAX_EXPORT_INCOMPLETE
    );
    assert_eq!(
        preview(&t, "FIFO").unwrap().get("complete"),
        Some(&Json::Bool(false))
    );
    let p = pack(&t, "FIFO");
    assert_eq!(p.get("complete"), Some(&Json::Bool(false)));
    let (b, raw) = body(&t);
    assert_eq!(b.get("complete"), Some(&Json::Bool(false)));
    assert_eq!(text(&b, "jurisdiction"), some("DE"));
    assert!(!raw.contains(r#""complete": true"#));
    assert_json(
        p.get("lake").unwrap(),
        r#"{"status":"configured","code":"tax.data_lake_unprobed"}"#,
    );
    assert_json(
        p.get("indexer").unwrap(),
        r#"{"status":"configured","code":"tax.indexer_unprobed"}"#,
    );
    assert!(!raw.contains(r#""status":"ok""#));
}

// Q-tax: an env URL is not a live lake or indexer

#[test]
fn a_blank_url_is_absent_not_ok() {
    for url in [None, Some(""), Some("   ")] {
        assert_eq!(LakeStatus::lake(url), LakeStatus::DataLakeAbsent);
    }
    assert_eq!(LakeStatus::indexer(None), LakeStatus::IndexerAbsent);
}

#[test]
fn a_set_url_is_configured_and_unprobed_never_ok() {
    assert_eq!(
        LakeStatus::lake(Some("http://lake.example/tsdb")),
        LakeStatus::DataLakeConfigured
    );
    assert_eq!(
        LakeStatus::indexer(Some("http://indexer.example")),
        LakeStatus::IndexerConfigured
    );
    // What each status says on the wire is checked above, through the pack.
}

// requirePublishedHistoryYears

#[test]
fn unset_zero_or_past_a_hundred_refuse_by_name() {
    for years in [None, Some(0), Some(101)] {
        let t = tax(r#"["DE"]"#, empty(), years);
        assert_eq!(
            fake::refused(preview(&t, "FIFO")).code,
            TAX_HISTORY_YEARS_UNSET,
            "{years:?}"
        );
    }
}

#[test]
fn an_explicit_owner_pin_of_ten_is_accepted() {
    assert!(preview(&tax(r#"["DE"]"#, empty(), Some(10)), "FIFO").is_ok());
}
