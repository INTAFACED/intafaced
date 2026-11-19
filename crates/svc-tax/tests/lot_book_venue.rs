//! `services/svc-tax/src/lot-book.venue.test.ts`, case for case (J-cex-spot-01 #11, J-portfolio-02 #6): tax.lotBook
//! adds the caller's own venue account beside their ledger book. TEST figures; the ledger here holds nothing.
#![allow(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    clippy::too_many_arguments,
    reason = "a test: a failure is the point"
)]

mod common;

use std::sync::{Arc, Mutex};

use common::fake::{self, FakeLedger};
use common::{assert_json, assert_match, date, door, list, some, text};
use svc_tax::basis::MemoryBasisStore;
use svc_tax::inputs::{BasisSetInput, PnlInput};
use svc_tax::json::Json;
use svc_tax::ports::{
    VenueAccountActivity, VenueActivity, VenueActivitySource, VenueArrival, VenueBalance, VenueFill,
};
use svc_tax::tax::{DepositBasisPolicy, TaxDeps, TaxService};
use svc_tax::time;

const USER: &str = "11111111-1111-4111-8111-111111111111";
const OWNER: &str = "0x00000000000000000000000000000000000000a1";

struct Asked {
    answer: VenueActivity,
    asked: Arc<Mutex<Vec<String>>>,
}

impl VenueActivitySource for Asked {
    fn read(&self, user_id: &str) -> VenueActivity {
        self.asked.lock().unwrap().push(user_id.to_owned());
        self.answer.clone()
    }
}

fn balance(asset: &str, total: &str) -> VenueBalance {
    VenueBalance {
        asset: asset.to_owned(),
        total: total.to_owned(),
    }
}

fn venue_fill(
    id: &str,
    base: &str,
    buy: bool,
    price: &str,
    amount: &str,
    fee: &str,
    fee_asset: &str,
    at: &str,
) -> VenueFill {
    VenueFill {
        fill_id: id.to_owned(),
        symbol: format!("{base}-USDC"),
        base: base.to_owned(),
        quote: "USDC".to_owned(),
        buy,
        price: price.to_owned(),
        amount: amount.to_owned(),
        fee: fee.to_owned(),
        fee_asset: fee_asset.to_owned(),
        filled_at: at.to_owned(),
    }
}

fn account() -> VenueAccountActivity {
    VenueAccountActivity {
        venue_id: "test-venue".to_owned(),
        owner: OWNER.to_owned(),
        sub_account: None,
        balances: vec![balance("USDC", "400"), balance("BTC", "0.00999")],
        fills: vec![venue_fill(
            "f1",
            "BTC",
            true,
            "60000",
            "0.01",
            "0.00001",
            "BTC",
            "2026-11-10T03:00:00.000Z",
        )],
        transfers: None,
        arrivals: None,
        as_of: "2026-11-10T03:00:01.000Z".to_owned(),
    }
}

fn bought() -> VenueActivity {
    VenueActivity::Read {
        test: true,
        accounts: vec![account()],
    }
}

fn deps(answer: Option<VenueActivity>) -> (TaxDeps, Arc<Mutex<Vec<String>>>) {
    let asked = Arc::new(Mutex::new(Vec::new()));
    let ledger = Arc::new(FakeLedger {
        fills: Some(Ok(fake::fills(vec![]))),
        ..FakeLedger::default()
    });
    let mut d = fake::deps(ledger, date("2026-11-11T00:00:00.000Z"));
    d.closes = Some(fake::closes(|_, _, _, _| Ok(None)));
    if let Some(answer) = answer {
        d.venue = Some(Arc::new(Asked {
            answer,
            asked: asked.clone(),
        }));
    }
    (d, asked)
}

fn through_the_door(tax: TaxService) -> Json {
    let wire = door::serve(tax);
    door::data(&door::query(
        &wire,
        &door::signed(USER, &["tax:read"], "DE"),
        "lotBook",
        None,
    ))
}

fn has(j: &Json, code: &str) -> bool {
    list(j, "residuals").contains(&Json::str(code))
}

#[test]
fn asks_for_the_caller_only_and_shows_the_bought_lot_through_the_door() {
    let (d, asked) = deps(Some(bought()));
    let j = through_the_door(fake::service(d));
    assert_eq!(*asked.lock().unwrap(), vec![USER.to_owned()]);
    let lots = list(&j, "lots");
    assert_eq!(lots.len(), 1);
    assert_match(
        &lots[0],
        &format!(
            r#"{{"id":"lot:venue:test-venue:{OWNER}:f1:BTC","venueAccount":"venue:test-venue:{OWNER}","source":"trade",
            "qty":"0.00999","remaining":"0.00999","costUsd":"600","daysHeld":0}}"#
        ),
    );
    assert_match(j.get("venue").unwrap(), r#"{"status":"read","test":true}"#);
    assert_eq!(text(&j, "realizedUsd"), None);
    assert_eq!(text(&j, "indicator"), some("indicator_not_tax_advice"));
}

#[test]
fn names_the_venue_unread_and_shows_no_venue_figure() {
    let (d, _) = deps(Some(VenueActivity::Unavailable));
    let j = through_the_door(fake::service(d));
    assert_json(
        j.get("venue").unwrap(),
        r#"{"status":"unavailable","code":"tax.venue_unavailable"}"#,
    );
    assert!(has(&j, "tax.venue_unavailable"));
    assert!(list(&j, "lots").is_empty());
    assert_eq!(text(&j, "realizedUsd"), None);
}

#[test]
fn with_no_venue_to_ask_the_book_says_so() {
    let (d, _) = deps(None);
    let j = fake::service(d).lot_book(USER, None).unwrap().json();
    assert_json(
        j.get("venue").unwrap(),
        r#"{"status":"unwired","code":"tax.venue_unwired"}"#,
    );
}

#[test]
fn the_result_over_time_does_not_read_the_venue() {
    let (d, asked) = deps(Some(bought()));
    fake::service(d)
        .pnl_over_time(
            USER,
            &PnlInput {
                from: time::zod_datetime("2026-11-09T00:00:00.000Z", true).unwrap(),
                to: None,
                utc_offset_minutes: 0,
            },
        )
        .unwrap();
    assert!(asked.lock().unwrap().is_empty());
}

#[test]
fn a_coin_credited_from_outside_has_no_cost_until_the_person_enters_one() {
    let mut a = account();
    a.balances = vec![balance("ETH", "0.03")];
    a.fills = vec![venue_fill(
        "f2",
        "ETH",
        false,
        "3000",
        "0.02",
        "0.06",
        "USDC",
        "2026-11-10T04:00:00.000Z",
    )];
    a.arrivals = Some(vec![VenueArrival {
        arrival_id: "r1".to_owned(),
        kind: "deposit".to_owned(),
        asset: "ETH".to_owned(),
        amount: "0.05".to_owned(),
        arrived_at: "2026-11-10T02:00:00.000Z".to_owned(),
    }]);
    let (mut d, _) = deps(Some(VenueActivity::Read {
        test: true,
        accounts: vec![a],
    }));
    d.basis = Some(Arc::new(MemoryBasisStore::new()));
    d.deposit_basis = Some(DepositBasisPolicy::Customer);
    let tax = fake::service(d);
    let j = tax.lot_book(USER, None).unwrap().json();
    let lot_id = format!("lot:venue:test-venue:{OWNER}:arrival:r1:ETH");
    let lots = list(&j, "lots");
    assert_eq!(lots.len(), 1);
    assert_match(
        &lots[0],
        &format!(
            r#"{{"id":"{lot_id}","source":"deposit","qty":"0.05","remaining":"0.03","costUsd":null}}"#
        ),
    );
    assert_match(
        &list(&j, "sales")[0],
        r#"{"qty":"0.02","proceedsUsd":"59.94","realizedUsd":null}"#,
    );
    assert_eq!(text(&j, "realizedUsd"), None);
    assert!(!has(&j, "tax.lot_book_unreconciled"));

    tax.basis_override_set(
        USER,
        &BasisSetInput {
            lot_id: lot_id.clone(),
            price_per_unit: "2000".to_owned(),
            date: "2026-11-10".to_owned(),
            source_note: "TEST receipt".to_owned(),
            asset_id: None,
            qty: None,
        },
    )
    .unwrap();
    let priced = tax.lot_book(USER, None).unwrap().json();
    assert_match(
        &list(&priced, "lots")[0],
        &format!(r#"{{"id":"{lot_id}","costUsd":"100","basisSource":"customer-entered"}}"#),
    );
    assert_eq!(
        text(&list(&priced, "sales")[0], "realizedUsd"),
        some("19.94")
    );
    assert_eq!(text(&priced, "realizedUsd"), some("19.94"));

    tax.basis_override_remove(USER, &lot_id).unwrap();
    assert_eq!(
        text(&tax.lot_book(USER, None).unwrap().json(), "realizedUsd"),
        None
    );
}
