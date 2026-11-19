//! `services/svc-tax/src/year-pack.acceptance.test.ts`, case for case (TRD-0534). Worked figures are independent of
//! the implementation: second fill 50000 − 40000 = 10000; second convert 10 − 8 = 2; account 10002. Fee and maker
//! rebate stay in their own columns, so they are not in that subtraction.
#![allow(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

mod common;

use std::sync::{Arc, Mutex};

use common::{amt, date, fake, find, list, some, text};
use svc_tax::json::{self, Json};
use svc_tax::ports::{Ledger, TaxBalance};
use svc_tax::tax::{
    Account, Failure, HistoryEntry, Range, SubAccountLine, TAX_COST_BASIS_UNAVAILABLE,
    TAX_EXPORT_INCOMPLETE, TaxDeps, TaxService,
};

const USER: &str = "11111111-1111-4111-8111-111111111111";
const FIRST: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SECOND: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

#[allow(clippy::too_many_arguments, reason = "the line's own fields")]
fn line(
    id: &str,
    convert: bool,
    at: &str,
    asset: &str,
    qty: &str,
    fee: Option<&str>,
    rebate: Option<&str>,
    cost: Option<&str>,
    proceeds: Option<&str>,
) -> SubAccountLine {
    SubAccountLine {
        id: id.to_owned(),
        convert,
        posted_at: date(at),
        asset_id: asset.to_owned(),
        qty: amt(qty),
        fee: fee.map(amt),
        maker_rebate: rebate.map(amt),
        cost_basis: cost.map(amt),
        proceeds: proceeds.map(amt),
    }
}

/// Two sub-accounts, always listed; their lines as given, whatever the range asked (the service keeps the window).
struct Books {
    lines: Vec<(&'static str, Vec<SubAccountLine>)>,
    calls: Mutex<usize>,
    range: Mutex<Option<Range>>,
}

impl Ledger for Books {
    fn balances(&self, _: &str, _: &str) -> Result<Vec<TaxBalance>, Failure> {
        Ok(vec![])
    }
    fn history(&self, _: &Account, _: Range) -> Result<Vec<HistoryEntry>, Failure> {
        Ok(vec![])
    }
    fn sub_account_ids(&self, _: &str) -> Option<Result<Vec<String>, Failure>> {
        Some(Ok(vec![FIRST.to_owned(), SECOND.to_owned()]))
    }
    fn sub_account_activity(
        &self,
        id: &str,
        range: Range,
    ) -> Option<Result<Vec<SubAccountLine>, Failure>> {
        *self.calls.lock().unwrap() += 1;
        *self.range.lock().unwrap() = Some(range);
        Some(Ok(self
            .lines
            .iter()
            .find(|(k, _)| *k == id)
            .map(|(_, l)| l.clone())
            .unwrap_or_default()))
    }
}

fn two_books() -> Arc<Books> {
    Arc::new(Books {
        lines: vec![
            (
                FIRST,
                vec![
                    line(
                        "fill-a",
                        false,
                        "2025-03-01T00:00:00.000Z",
                        "BTC",
                        "1",
                        Some("0.1"),
                        None,
                        None,
                        Some("50000"),
                    ),
                    line(
                        "convert-a",
                        true,
                        "2025-04-01T00:00:00.000Z",
                        "ETH",
                        "2",
                        None,
                        None,
                        None,
                        Some("10"),
                    ),
                ],
            ),
            (
                SECOND,
                vec![
                    line(
                        "fill-b",
                        false,
                        "2025-03-02T00:00:00.000Z",
                        "BTC",
                        "1",
                        Some("1.5"),
                        Some("0.25"),
                        Some("40000"),
                        Some("50000"),
                    ),
                    line(
                        "convert-b",
                        true,
                        "2025-04-02T00:00:00.000Z",
                        "ETH",
                        "3",
                        Some("0.01"),
                        None,
                        Some("8"),
                        Some("10"),
                    ),
                ],
            ),
        ],
        calls: Mutex::new(0),
        range: Mutex::new(None),
    })
}

fn service(ledger: Arc<Books>, years: i64) -> TaxService {
    fake::service(TaxDeps::new(
        r#"["DE"]"#,
        ledger,
        Some(years),
        Box::new(|| date("2026-06-15T12:00:00.000Z")),
    ))
}

fn download(tax: &TaxService) -> Json {
    json::parse(&tax.export(USER, "DE", "FIFO", None).unwrap().body).unwrap()
}

fn column(account: &Json, key: &str) -> Vec<Option<String>> {
    list(account, "lines")
        .iter()
        .map(|r| text(r, key))
        .collect()
}

fn has(j: &Json, code: &str) -> bool {
    list(j, "residuals").contains(&Json::str(code))
}

#[test]
fn the_first_sub_accounts_unknown_basis_stays_its_own() {
    let body = download(&service(two_books(), 10));
    let first = &list(&body, "subAccounts")[0];
    let second = &list(&body, "subAccounts")[1];
    assert_eq!(text(first, "subAccountId"), some(FIRST));
    assert_eq!(text(second, "subAccountId"), some(SECOND));
    assert_eq!(first.get("realized"), Some(&Json::Null));
    assert_eq!(column(first, "costBasis"), vec![None, None]);
    assert_eq!(column(first, "realized"), vec![None, None]);
    assert_eq!(column(second, "costBasis"), vec![some("40000"), some("8")]);
    assert_eq!(column(second, "realized"), vec![some("10000"), some("2")]);
    assert_eq!(text(second, "realized"), some("10002"));
    assert_eq!(body.get("realized"), Some(&Json::Null));
    let fees = |a: &Json| -> Vec<[Option<String>; 3]> {
        list(a, "lines")
            .iter()
            .map(|r| [text(r, "kind"), text(r, "fee"), text(r, "makerRebate")])
            .collect()
    };
    assert_eq!(
        fees(first),
        vec![
            [some("fill"), some("0.1"), None],
            [some("convert"), None, None]
        ]
    );
    assert_eq!(
        fees(second),
        vec![
            [some("fill"), some("1.5"), some("0.25")],
            [some("convert"), some("0.01"), None]
        ]
    );
}

#[test]
fn keeps_a_null_basis_as_a_residual_never_zero() {
    let body = download(&service(two_books(), 10));
    let first = &list(&body, "subAccounts")[0];
    let second = &list(&body, "subAccounts")[1];
    assert!(has(first, TAX_COST_BASIS_UNAVAILABLE));
    assert!(!has(second, TAX_COST_BASIS_UNAVAILABLE));
    assert!(has(&body, TAX_COST_BASIS_UNAVAILABLE));
    let raw = first.compact();
    for zero in [
        r#""costBasis": "0""#,
        r#""realized": "0""#,
        r#""makerRebate": "0""#,
    ] {
        assert!(!raw.contains(zero), "{zero}");
    }
}

#[test]
fn refuses_complete_and_reads_no_sub_account_book() {
    let books = two_books();
    let tax = service(books.clone(), 10);
    let e = fake::refused(
        tax.export(USER, "DE", "FIFO", Some(true))
            .map(|x| x.preview()),
    );
    assert_eq!(e.code, TAX_EXPORT_INCOMPLETE);
    assert_eq!(*books.calls.lock().unwrap(), 0);
}

#[test]
fn exports_the_years_inside_the_published_window() {
    let books = Arc::new(Books {
        lines: vec![
            (FIRST, vec![]),
            (
                SECOND,
                vec![
                    line(
                        "before-window",
                        false,
                        "2023-12-31T23:59:59.999Z",
                        "BTC",
                        "1",
                        Some("1"),
                        None,
                        None,
                        Some("9"),
                    ),
                    line(
                        "inside-window",
                        false,
                        "2024-01-01T00:00:00.000Z",
                        "BTC",
                        "1",
                        Some("1.5"),
                        Some("0.25"),
                        Some("40000"),
                        Some("50000"),
                    ),
                    line(
                        "after-window",
                        true,
                        "2026-06-15T12:00:00.001Z",
                        "ETH",
                        "1",
                        None,
                        None,
                        None,
                        Some("3"),
                    ),
                ],
            ),
        ],
        calls: Mutex::new(0),
        range: Mutex::new(None),
    });
    let body = download(&service(books.clone(), 2));
    let range = books.range.lock().unwrap().unwrap();
    assert_eq!(range.from.iso(), "2024-01-01T00:00:00.000Z");
    assert_eq!(range.to.iso(), "2026-06-15T12:00:00.000Z");
    assert_eq!(body.get("complete"), Some(&Json::Bool(false)));
    assert_eq!(text(&body, "subAccountBooks"), some("read"));
    let second = find(list(&body, "subAccounts"), "subAccountId", SECOND).unwrap();
    assert_eq!(
        column(second, "postedAt"),
        vec![some("2024-01-01T00:00:00.000Z")]
    );
    assert_eq!(text(second, "realized"), some("10000"));
    assert!(!has(second, TAX_COST_BASIS_UNAVAILABLE));
    assert!(!has(&body, TAX_COST_BASIS_UNAVAILABLE));
}
