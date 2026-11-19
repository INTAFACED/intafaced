//! The edges the replay never sends: each bound in svc-tax's logic, tested on both sides of the line, with the refusal
//! codes written out as the wire carries them (not through the crate's constants, so a renamed code fails here).
//! Ported from the TypeScript unit tests: `pnl-over-time.test.ts` (the range checks and `chooseInterval`'s limits) and
//! `year-pack.acceptance.test.ts` (the published window), plus `requirePublishedHistoryYears`' 1 to 100.
#![allow(
    clippy::unwrap_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use std::sync::{Arc, Mutex};

use svc_tax::inputs::PnlInput;
use svc_tax::json::Json;
use svc_tax::tax::{
    Account, Balance, Failure, HistoryEntry, LakeStatus, LedgerReads, Range, SubAccountLine,
    SubAccountReads, TaxDeps, TaxService,
};
use svc_tax::time::{self, Instant};

const NOW: &str = "2026-06-15T12:00:00.000Z";
const DAY: i64 = 86_400_000;
const WEEK: i64 = 7 * DAY;

fn at(text: &str) -> Instant {
    time::zod_datetime(text, false).unwrap()
}

/// A ledger with no balances and one sub-account whose lines are the ones given; it records the window it was asked.
struct Ledger {
    lines: Vec<SubAccountLine>,
    asked: Arc<Mutex<Option<Range>>>,
}

impl LedgerReads for Ledger {
    fn balances(&self, _user_id: &str) -> Result<Vec<Balance>, Failure> {
        Ok(Vec::new())
    }
    fn history(&self, _account: &Account, _range: Range) -> Result<Vec<HistoryEntry>, Failure> {
        Ok(Vec::new())
    }
    fn sub_accounts(&self) -> Option<&dyn SubAccountReads> {
        Some(self)
    }
}

impl SubAccountReads for Ledger {
    fn ids(&self, _user_id: &str) -> Result<Vec<String>, Failure> {
        Ok(vec!["sub-1".to_owned()])
    }
    fn activity(&self, _id: &str, range: Range) -> Result<Vec<SubAccountLine>, Failure> {
        *self.asked.lock().unwrap() = Some(range);
        Ok(self.lines.clone())
    }
}

fn line(id: &str, posted_at: Instant) -> SubAccountLine {
    SubAccountLine {
        id: id.to_owned(),
        convert: false,
        posted_at,
        asset_id: "BTC".to_owned(),
        qty: 1,
        fee: None,
        maker_rebate: None,
        cost_basis: Some(1),
        proceeds: Some(2),
    }
}

fn service(
    history_years: Option<i64>,
    lines: Vec<SubAccountLine>,
) -> (TaxService, Arc<Mutex<Option<Range>>>) {
    let asked = Arc::new(Mutex::new(None));
    let tax = TaxService::new(TaxDeps {
        map_raw: r#"["DE"]"#.to_owned(),
        reads: Box::new(Ledger {
            lines,
            asked: Arc::clone(&asked),
        }),
        lake: LakeStatus::lake(None),
        indexer: LakeStatus::indexer(None),
        history_years,
        now: Box::new(|| at(NOW)),
    })
    .unwrap();
    (tax, asked)
}

fn code<T>(r: Result<T, Failure>) -> &'static str {
    match r {
        Err(Failure::Refused(e)) => e.code,
        Err(Failure::Internal(m)) => panic!("internal: {m}"),
        Ok(_) => panic!("answered, not refused"),
    }
}

fn posted(export: Json) -> Vec<String> {
    let Some(Json::Array(accounts)) = export.get("subAccounts") else {
        panic!("subAccounts")
    };
    let Some(Json::Array(lines)) = accounts[0].get("lines") else {
        panic!("lines")
    };
    lines
        .iter()
        .map(|l| match l.get("postedAt") {
            Some(Json::String(s)) => s.clone(),
            other => panic!("postedAt: {other:?}"),
        })
        .collect()
}

#[test]
fn the_export_window_runs_from_the_first_of_the_year_history_years_back_to_now_both_ends_kept() {
    let now = at(NOW);
    let (tax, asked) = service(
        Some(2),
        vec![
            line("before-window", at("2023-12-31T23:59:59.999Z")),
            line("first-instant", at("2024-01-01T00:00:00.000Z")),
            line("at-now", now),
            line("after-now", Instant(now.0 + 1)),
        ],
    );
    let export = tax.export("u", "DE", "FIFO", None).unwrap().preview();
    let range = asked.lock().unwrap().unwrap();
    assert_eq!(range.from.iso(), "2024-01-01T00:00:00.000Z");
    assert_eq!(range.to.iso(), NOW);
    assert_eq!(
        posted(export),
        vec!["2024-01-01T00:00:00.000Z".to_owned(), NOW.to_owned()]
    );
}

#[test]
fn history_years_is_published_only_from_1_to_100() {
    for years in [1, 100] {
        let (tax, _) = service(Some(years), Vec::new());
        assert!(tax.export("u", "DE", "FIFO", None).is_ok(), "{years} years");
    }
    for years in [None, Some(0), Some(101), Some(-1)] {
        let (tax, _) = service(years, Vec::new());
        assert_eq!(
            code(tax.export("u", "DE", "FIFO", None)),
            "tax.history_years_unset",
            "{years:?}"
        );
    }
}

fn pnl(tax: &TaxService, from: i64, to: Option<i64>) -> &'static str {
    code(tax.pnl_over_time(
        "u",
        &PnlInput {
            from: Instant(from),
            to: to.map(Instant),
            utc_offset_minutes: 0,
        },
    ))
}

#[test]
fn the_pnl_range_must_start_before_it_ends_and_before_now() {
    let (tax, _) = service(None, Vec::new());
    let now = at(NOW).0;
    let from = now - 5 * DAY;
    assert_eq!(pnl(&tax, from, Some(from)), "tax.pnl_range_invalid");
    assert_eq!(pnl(&tax, from, Some(from - 1)), "tax.pnl_range_invalid");
    assert_eq!(pnl(&tax, now, None), "tax.pnl_range_invalid");
    assert_eq!(
        pnl(&tax, now + DAY, Some(now + 2 * DAY)),
        "tax.pnl_range_invalid"
    );
    // Past the range checks, the book is read, and its reader is not here yet.
    assert_eq!(pnl(&tax, from, Some(from + 1)), "tax.ledger_unwired");
}

#[test]
fn the_pnl_range_may_start_at_most_718_weekly_candles_back() {
    let (tax, _) = service(None, Vec::new());
    let now = at(NOW).0;
    let edge = now - 718 * WEEK;
    assert_eq!(pnl(&tax, edge, Some(edge + DAY)), "tax.ledger_unwired");
    assert_eq!(
        pnl(&tax, edge - 1, Some(edge + DAY)),
        "tax.pnl_range_too_long"
    );
    // A whole range of 400 weekly candles fits a chart; one more millisecond does not.
    let from = now - 400 * WEEK;
    assert_eq!(pnl(&tax, from, None), "tax.ledger_unwired");
    assert_eq!(pnl(&tax, from - 1, None), "tax.pnl_range_too_long");
    assert_eq!(
        pnl(&tax, now - 20 * 365 * DAY, None),
        "tax.pnl_range_too_long"
    );
}
