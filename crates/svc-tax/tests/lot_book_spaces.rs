//! `lot-book.spaces.test.ts` (J-portfolio-04 #2, LB-6), at the port: the TypeScript drives the real
//! HTTP ledger reader over a fake svc-ledger; here the fake ledger answers with what that reader makes of the same
//! lines (the reader itself is the I/O side's, tested there). TEST data, hand-computed: buy 1 BTC for 100 USDT on
//! 1 Oct, then move it from the main account to the customer's space "TEST cold" on 5 Oct.
#![allow(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

mod common;

use std::sync::Arc;

use common::fake::{self, FakeLedger};
use common::{amt, assert_json, assert_match, date, list};
use svc_tax::json::Json;
use svc_tax::ports::{AccountLine, Fill, FillLeg, OwnSpaces, SpaceHistory, SpaceLine, TradeFills};
use svc_tax::tax::{TAX_LOT_BOOK_UNRECONCILED, TAX_OWN_SPACES_UNAVAILABLE};

const USER: &str = "11111111-1111-4111-8111-111111111111";
const SPACE: &str = "33333333-3333-4333-8333-333333333333";

fn line(tx: &str, at: &str, debit: bool) -> AccountLine {
    AccountLine {
        tx_id: tx.to_owned(),
        posted_at: date(at),
        asset_id: "BTC".to_owned(),
        amount: amt("1"),
        reason: "bank.transfer.manual".to_owned(),
        debit,
    }
}

fn ledger(sent_on: bool) -> Arc<FakeLedger> {
    let moved_at = "2026-10-05T00:00:00.000Z";
    let mut space_lines = Vec::new();
    if sent_on {
        space_lines.push(SpaceLine {
            space_id: SPACE.to_owned(),
            line: line("gift", "2026-10-07T00:00:00.000Z", false),
        });
    }
    space_lines.push(SpaceLine {
        space_id: SPACE.to_owned(),
        line: line("mv", moved_at, true),
    });
    Arc::new(FakeLedger {
        fills: Some(Ok(TradeFills {
            fills: vec![Fill {
                tx_id: "buy".to_owned(),
                posted_at: date("2026-10-01T00:00:00.000Z"),
                received: FillLeg {
                    asset_id: "BTC".to_owned(),
                    amount: amt("1"),
                },
                paid: Some(FillLeg {
                    asset_id: "USDT".to_owned(),
                    amount: amt("100"),
                }),
                fee: None,
                fee_asset_id: None,
            }],
            truncated: false,
            outside_inflows: vec![],
            inflows: Some(vec![]),
            outflows: Some(vec![line("mv", moved_at, false)]),
            withdrawal_holds: Some(vec![]),
        })),
        space: Some(Ok(SpaceHistory {
            lines: space_lines,
            truncated: false,
        })),
        ..FakeLedger::default()
    })
}

fn read() -> Arc<dyn OwnSpaces> {
    fake::spaces(Some(vec![fake::space(SPACE, "BTC", "TEST cold")]))
}

fn book(ledger: Arc<FakeLedger>, spaces: Option<Arc<dyn OwnSpaces>>) -> Json {
    let mut deps = fake::deps(ledger, date("2026-10-11T00:00:00.000Z"));
    deps.spaces = spaces;
    fake::service(deps).lot_book(USER, None).unwrap().json()
}

fn in_space(j: &Json) -> Vec<&Json> {
    list(j, "lots")
        .iter()
        .filter(|l| l.get("spaceId") == Some(&Json::str(SPACE)))
        .collect()
}

#[test]
fn the_carried_lot_keeps_its_date_and_basis_and_the_main_account_reconciles() {
    let l = ledger(false);
    let j = book(l.clone(), Some(read()));
    assert_json(
        j.get("spaces").unwrap(),
        &format!(
            r#"{{"status":"read","list":[{{"spaceId":"{SPACE}","assetId":"BTC","name":"TEST cold","archived":false}}]}}"#
        ),
    );
    let lots = in_space(&j);
    assert_eq!(lots.len(), 1);
    assert_json(
        lots[0],
        &format!(
            r#"{{"id":"lot:buy:BTC>mv","assetId":"BTC","acquiredAt":"2026-10-01T00:00:00.000Z","source":"trade","qty":"1",
            "remaining":"1","costUsd":"100","remainingCostUsd":"100","valuedAt":null,"daysHeld":10,"termClass":null,
            "spaceId":"{SPACE}","carriedFrom":{{"lotId":"lot:buy:BTC","txId":"mv","movedAt":"2026-10-05T00:00:00.000Z"}},
            "counted":true}}"#
        ),
    );
    let main = list(&j, "lots")
        .iter()
        .find(|x| x.get("id") == Some(&Json::str("lot:buy:BTC")))
        .unwrap();
    assert_match(main, r#"{"remaining":"0","remainingCostUsd":"0"}"#);
    assert!(list(&j, "sales").is_empty());
    assert!(list(&j, "residuals").is_empty());
    assert_eq!(*l.space_asks.lock().unwrap(), vec![vec![SPACE.to_owned()]]);
}

#[test]
fn coins_sent_on_from_the_space_leave_its_lots_unreconciled() {
    let j = book(ledger(true), Some(read()));
    let lot = in_space(&j)[0];
    assert_match(
        lot,
        r#"{"remaining":"1","remainingCostUsd":null,"costUsd":"100"}"#,
    );
    assert!(list(&j, "residuals").contains(&Json::str(TAX_LOT_BOOK_UNRECONCILED)));
}

#[test]
fn with_no_answer_from_the_bank_the_move_is_not_followed() {
    let j = book(ledger(false), Some(fake::spaces(None)));
    assert_json(
        j.get("spaces").unwrap(),
        &format!(r#"{{"status":"unavailable","code":"{TAX_OWN_SPACES_UNAVAILABLE}"}}"#),
    );
    let residuals = list(&j, "residuals");
    assert!(residuals.contains(&Json::str(TAX_OWN_SPACES_UNAVAILABLE)));
    assert!(residuals.contains(&Json::str(TAX_LOT_BOOK_UNRECONCILED)));
    assert!(list(&j, "lots").iter().all(|l| l.get("spaceId").is_none()));
}

#[test]
fn with_no_bank_configured_the_book_names_it() {
    let j = book(ledger(false), None);
    assert_json(
        j.get("spaces").unwrap(),
        r#"{"status":"unwired","code":"tax.own_spaces_unwired"}"#,
    );
}
