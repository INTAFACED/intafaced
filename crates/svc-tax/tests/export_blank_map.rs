//! `services/svc-tax/src/export-blank-map.public.test.ts`, case for case, through the door. A blank tax map is not
//! an export: the slot stays empty, no figure, no balance on this service. The TypeScript counts posts on a memory
//! ledger; the Rust ledger port has no write at all, so the service cannot post, and the fake counts reads instead.
//! The screening refusal's `decision` detail is in-process only (tRPC sends `cause.code`), so the wire's code is checked.
#![allow(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

mod common;

use std::sync::{Arc, Mutex};

use common::{amt, date, door, fake};
use svc_tax::json::{self, Json};
use svc_tax::ports::{Ledger, TaxBalance};
use svc_tax::tax::{Account, Failure, HistoryEntry, Range, TAX_JURISDICTION_UNMAPPED, TaxDeps};
use svc_tax::wire::Response;

const USER: &str = "11111111-1111-4111-8111-111111111111";
/// A ledger quantity the export must not reprint as a tax figure.
const LEDGER_QTY: &str = "4.25";
const BLANK_MAPS: [&str; 4] = ["", "   ", "{}", "[]"];
/// This file proves the blank-list refusal: the owner's unsigned rows stay out (OWNER 258 (1)).
const NO_UNSIGNED: (&str, &str) = ("INTAFACED_UNSIGNED_SANCTIONS_ROWS", "off");

/// Holds the user's deposit of 4.25 BTC; counts every read.
#[derive(Default)]
struct Trap {
    reads: Mutex<usize>,
}

impl Ledger for Trap {
    fn balances(&self, _: &str, owner: &str) -> Result<Vec<TaxBalance>, Failure> {
        *self.reads.lock().unwrap() += 1;
        Ok(if owner == USER {
            vec![fake::balance(USER, "BTC", LEDGER_QTY)]
        } else {
            vec![]
        })
    }
    fn history(&self, _: &Account, _: Range) -> Result<Vec<HistoryEntry>, Failure> {
        *self.reads.lock().unwrap() += 1;
        Ok(vec![HistoryEntry {
            tx_id: "tx-ledger-only".to_owned(),
            reason: "deposit.credited".to_owned(),
            debit: true,
            amount: amt(LEDGER_QTY),
            posted_at: date("2024-01-01T00:00:00.000Z"),
        }])
    }
}

fn call(ledger: Arc<Trap>, map: &str, env: &[(&str, &str)], door_name: &str) -> Response {
    let wire = door::serve_with(
        fake::service(TaxDeps::new(
            map,
            ledger,
            None,
            Box::new(|| date("2026-01-02T00:00:00.000Z")),
        )),
        env,
    );
    let headers = door::signed(USER, &["tax:read"], "DE");
    let input = r#"{"lotMethod":"FIFO"}"#;
    if door_name == "exportPack" {
        door::mutate(&wire, &headers, door_name, input)
    } else {
        door::query(&wire, &headers, door_name, Some(input))
    }
}

fn cause(r: &Response) -> Option<String> {
    let body = json::parse(&r.body).unwrap();
    match body.get("error")?.get("data")?.get("cause")?.get("code")? {
        Json::String(s) => Some(s.clone()),
        _ => None,
    }
}

#[test]
fn strict_screening_refuses_before_tax_or_ledger_work() {
    let ledger = Arc::new(Trap::default());
    for name in ["exportPack", "exportPreview"] {
        let r = call(
            ledger.clone(),
            "",
            &[
                NO_UNSIGNED,
                ("INTAFACED_SCREENING_FAIL_CLOSED", "on"),
                ("INTAFACED_SANCTIONS_REGIONS", ""),
                ("INTAFACED_SANCTIONS_LIST_SOURCE", ""),
            ],
            name,
        );
        assert_eq!(door::error(&r).1, "FORBIDDEN", "{name}");
        assert_eq!(cause(&r).as_deref(), Some("denied.screening_unconfigured"));
    }
    assert_eq!(*ledger.reads.lock().unwrap(), 0);
}

#[test]
fn returns_unmapped_and_an_empty_slot() {
    for name in ["exportPack", "exportPreview"] {
        let r = call(Arc::new(Trap::default()), "", &[NO_UNSIGNED], name);
        let (_, code, message) = door::error(&r);
        assert_eq!(code, "PRECONDITION_FAILED", "{name}");
        assert!(message.contains(TAX_JURISDICTION_UNMAPPED));
        assert!(!r.body.contains(r#""result""#));
    }
}

#[test]
fn does_not_invent_a_tax_figure() {
    for map in BLANK_MAPS {
        for name in ["exportPack", "exportPreview"] {
            let r = call(Arc::new(Trap::default()), map, &[NO_UNSIGNED], name);
            let (_, _, message) = door::error(&r);
            assert!(
                message.contains(TAX_JURISDICTION_UNMAPPED),
                "{map:?} {name}"
            );
            assert!(!message.contains(LEDGER_QTY));
            assert!(!message.chars().any(|c| c.is_ascii_digit()), "{message}");
            assert!(!r.body.contains(r#""result""#));
        }
    }
}

#[test]
fn keeps_no_balance_of_its_own() {
    let ledger = Arc::new(Trap::default());
    for name in ["exportPack", "exportPreview"] {
        let (_, code, message) = door::error(&call(ledger.clone(), "", &[NO_UNSIGNED], name));
        assert_eq!(code, "PRECONDITION_FAILED");
        assert!(message.contains(TAX_JURISDICTION_UNMAPPED));
    }
    // The user's ledger still holds the deposit, and neither svc-tax nor a house account holds anything.
    let held = ledger.balances("user", USER).unwrap();
    assert_eq!(
        held.iter().map(|b| b.amount).collect::<Vec<_>>(),
        vec![amt(LEDGER_QTY)]
    );
    assert!(ledger.balances("module", "svc-tax").unwrap().is_empty());
    assert!(ledger.balances("house", "tax").unwrap().is_empty());
}
