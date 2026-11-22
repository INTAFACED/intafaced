//! Native amend priority, ported from the TypeScript service's `amend-priority.router.test.ts` (through the whole door,
//! `PATCH /markets/:marketId/orders/:orderId` signed by svc-trade) and `engine/amend-priority.test.ts` (on the book).
//!
//! Of `engine/amend-priority.test.ts`:
//! - `queuePriority` is a helper `book.ts` never calls: the book decides retained or lost inline, as
//!   `OrderBook::amend` does here. Its four rules are held on the book: qty-down at the same price retains
//!   (`tests/book.rs` `qty_down_at_the_same_price_retains_queue_sequence_and_bumps_version`), qty-up loses
//!   (`qty_up_loses_priority`), a price change loses (`price_change_loses_priority_and_receives_a_new_sequence`), and
//!   an execution-affecting change loses (here: a TIF that forces re-execution, and a stop's trigger or TIF).
//! - `OrderBook.amend`'s qty-down and qty-up tests are `tests/book.rs`'s two named above, the same orders, the same
//!   amend and the same taker.
//! - `unsupportedAmendField` and "refuses replace on a rest" test a wrapper with nothing to refuse here: an amend is
//!   `EngineAmend`, a struct with only the native fields (and an option's strike and expiry), so no `replace` or
//!   `mark` can reach the book. No door reached it in the TypeScript either: `amendBodySchema` drops unknown keys and
//!   `toEngineAmend` copies only the native ones. What a caller can send is tested here at the door: a `replace` or a
//!   `mark` on a PATCH is no cancel/replace.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

#[allow(dead_code, reason = "each test file uses its own share of the helpers")]
mod ported_c_common;

use ported_c_common::{Body, ORDERS, at, live_ids, mount, patch, post, proof, text};
use service_kit::json::Json;
use service_kit::money::{Amount, parse_amount};
use svc_matching::book::OrderBook;
use svc_matching::book::types::{EngineAmend, EngineOrder, OrderType, Priority, Side, Tif};

const FIRST: &str = "11111111-1111-4111-8111-111111111111";
const SECOND: &str = "22222222-2222-4222-8222-222222222222";

/// `proof(action)`: the market allows `PLACE`, `PLACE_POST_ONLY` and `AMEND`.
fn proof_of(action: &str) -> Json {
    proof(action, &["PLACE", "PLACE_POST_ONLY", "AMEND"])
}

/// `submitBody` of `amend-priority.router.test.ts`: a GTC limit buy of 2 at 100 by `desk`.
fn rest(order_id: &str, account: &str, qty: &str) -> Json {
    Body::order()
        .s("orderId", order_id)
        .s("accountId", account)
        .s("qty", qty)
        .set("lifecycleProof", proof_of("PLACE"))
        .json()
}

fn amend_to(qty: &str) -> Body {
    Body::empty()
        .set("expectedVersion", Json::int(1))
        .s("qty", qty)
        .set("lifecycleProof", proof_of("AMEND"))
}

fn sequence(a: &Json) -> f64 {
    match at(a, "sequence") {
        Json::Number(n) => *n,
        other => panic!("sequence is {}", other.compact()),
    }
}

// ── amend-priority.router.test.ts ───────────────────────────────────────

#[test]
fn router_qty_down_at_the_same_price_returns_priority_retained() {
    let door = mount();
    post(&door, ORDERS, &rest(FIRST, "desk", "2")).ok();
    post(&door, ORDERS, &rest(SECOND, "other", "1")).ok();

    let res = patch(&door, FIRST, &amend_to("1").json());
    res.ok();
    assert!(res.accepted(), "{}", res.body.compact());
    assert_eq!(res.text("priority"), "retained");
    assert_eq!(res.get("sequence"), &Json::int(1));
    assert_eq!(res.get("version"), &Json::int(2));
    assert_eq!(text(at(res.get("resting"), "remaining")), "1");
}

#[test]
fn router_qty_up_returns_priority_lost() {
    let door = mount();
    post(&door, ORDERS, &rest(FIRST, "desk", "1")).ok();
    post(&door, ORDERS, &rest(SECOND, "other", "1")).ok();

    let res = patch(&door, FIRST, &amend_to("2").json());
    res.ok();
    assert!(res.accepted(), "{}", res.body.compact());
    assert_eq!(res.text("priority"), "lost");
    assert_ne!(sequence(&res.body), 1.0);
}

/// A `replace` or a `mark` on a PATCH is dropped at the door, as `amendBodySchema` drops it: the order is amended in
/// place (the same order, its queue place kept), never cancelled and replaced.
#[test]
fn router_a_replace_or_mark_field_is_no_cancel_replace() {
    let door = mount();
    post(&door, ORDERS, &rest(FIRST, "desk", "2")).ok();
    post(&door, ORDERS, &rest(SECOND, "other", "1")).ok();

    let res = patch(
        &door,
        FIRST,
        &amend_to("1")
            .set("replace", Json::Bool(true))
            .s("mark", "50")
            .json(),
    );
    res.ok();
    assert!(res.accepted(), "{}", res.body.compact());
    assert_eq!(res.text("orderId"), FIRST);
    assert_eq!(res.text("priority"), "retained");
    assert_eq!(res.get("sequence"), &Json::int(1));
    assert!(
        res.list("cancellations").is_empty(),
        "{}",
        res.body.compact()
    );
    assert_eq!(live_ids(&door), vec![FIRST.to_owned(), SECOND.to_owned()]);
}

// ── engine/amend-priority.test.ts: an execution-affecting change loses ──

fn a(s: &str) -> Amount {
    parse_amount(s).unwrap()
}

/// `rest(id, qty, price)`: a GTC limit buy by `desk`.
fn limit(id: &str, account: &str, side: Side, qty: &str, price: &str) -> EngineOrder {
    EngineOrder::new(
        id.to_owned(),
        account,
        OrderType::Limit,
        side,
        a(qty),
        Some(a(price)),
        Tif::Gtc,
    )
}

fn amend(order_id: &str) -> EngineAmend {
    EngineAmend {
        order_id: order_id.to_owned(),
        expected_version: 1,
        ..EngineAmend::default()
    }
}

#[test]
fn queue_priority_loses_when_an_ioc_tif_forces_re_execution_at_the_same_price_and_qty() {
    let mut book = OrderBook::new("BTC/USDT");
    assert!(
        book.submit(&limit("first", "desk", Side::Buy, "1", "100"), None)
            .accepted
    );
    assert!(
        book.submit(&limit("second", "other", Side::Buy, "1", "100"), None)
            .accepted
    );
    let result = book.amend(
        &EngineAmend {
            tif: Some(Tif::Ioc),
            ..amend("first")
        },
        None,
    );
    assert!(result.accepted, "{:?}", result.rejected);
    assert_eq!(result.priority, Some(Priority::Lost));
    assert_ne!(result.sequence, Some(1));
}

#[test]
fn queue_priority_loses_when_a_stop_changes_its_trigger_or_its_tif_at_the_same_qty() {
    let stop = |id: &str| {
        let mut o = EngineOrder::new(
            id.to_owned(),
            "desk",
            OrderType::StopLimit,
            Side::Buy,
            a("1"),
            Some(a("110")),
            Tif::Gtc,
        );
        o.stop_price = Some(a("105"));
        o
    };
    let mut book = OrderBook::new("BTC/USDT");
    assert!(book.submit(&stop("stop"), None).accepted);

    let same = OrderBook::from_state(&book.to_state()).unwrap().amend(
        &EngineAmend {
            qty: Some(a("1")),
            ..amend("stop")
        },
        None,
    );
    assert_eq!(same.priority, Some(Priority::Retained));

    let trigger = OrderBook::from_state(&book.to_state()).unwrap().amend(
        &EngineAmend {
            stop_price: Some(a("106")),
            ..amend("stop")
        },
        None,
    );
    assert!(trigger.accepted, "{:?}", trigger.rejected);
    assert_eq!(trigger.priority, Some(Priority::Lost));

    let tif = OrderBook::from_state(&book.to_state()).unwrap().amend(
        &EngineAmend {
            tif: Some(Tif::Po),
            ..amend("stop")
        },
        None,
    );
    assert!(tif.accepted, "{:?}", tif.rejected);
    assert_eq!(tif.priority, Some(Priority::Lost));
}
