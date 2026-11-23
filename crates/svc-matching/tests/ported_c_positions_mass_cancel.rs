//! Positions and the mass cancel, ported from the TypeScript service's `close-position.router.test.ts` and
//! `mass-cancel.router.test.ts`, test for test, through the whole door over a real engine. Where the TypeScript hands
//! the door a stand-in engine to show it is never called, here the real engine's journal stays empty and it opens no
//! market.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use crate::ported_c_common;

use ported_c_common::{
    Answer, Body, ORDERS, at, first_order, get, kinds, levels, live_ids, mount, post, send, text,
};
use service_kit::json::Json;
use service_kit::money::{Amount, format_amount};
use svc_matching::door::MatchingDoor;

const CLOSE: &str = "/markets/BTC-USDT/positions/close";
const MASS_CANCEL: &str = "/markets/BTC-USDT/orders/mass-cancel";
const ONE: &str = "11111111-1111-4111-8111-111111111111";
const TWO: &str = "22222222-2222-4222-8222-222222222222";
const THREE: &str = "33333333-3333-4333-8333-333333333333";
const FOUR: &str = "44444444-4444-4444-8444-444444444444";
const FIVE: &str = "55555555-5555-4555-8555-555555555555";

fn untouched(door: &MatchingDoor) {
    assert!(
        kinds(door).is_empty(),
        "the engine was called: {:?}",
        kinds(door)
    );
    assert!(!door.engine().has_market("BTC-USDT"), "a market was opened");
}

// ── close-position.router.test.ts: POST /markets/:marketId/positions/close ─

/// `closeBody()`: close `desk`'s position.
fn close_body() -> Json {
    Body::empty()
        .s("orderId", FIVE)
        .s("accountId", "desk")
        .set("lifecycleProof", ported_c_common::place())
        .json()
}

/// `submitBody` of `close-position.router.test.ts`: a GTC limit buy of 1 at 100.
fn order(order_id: &str, account: &str, side: &str, qty: &str, price: &str) -> Body {
    Body::order()
        .s("orderId", order_id)
        .s("accountId", account)
        .s("side", side)
        .s("qty", qty)
        .s("price", price)
}

fn accepted(a: &Answer) {
    a.ok();
    assert!(a.accepted(), "{}", a.body.compact());
}

#[test]
fn close_refuses_an_unauthenticated_close_and_the_engine_is_never_called() {
    let door = mount();
    let res = send(&door, "POST", CLOSE, &close_body().compact(), &[]);
    assert_eq!(res.status, 401, "{}", res.body.compact());
    untouched(&door);
}

#[test]
fn close_returns_a_stable_403_for_an_authenticated_non_trade_close() {
    let door = mount();
    let payload = close_body().compact();
    let res = send(
        &door,
        "POST",
        CLOSE,
        &payload,
        &ported_c_common::signed("svc-execution", &payload),
    );
    assert_eq!(res.status, 403, "{}", res.body.compact());
    assert_eq!(
        res.body,
        Json::obj([
            ("code", Json::str("Forbidden")),
            ("message", Json::str("You do not have access to this.")),
        ])
    );
    assert_eq!(
        res.text("message"),
        svc_matching::errors::user_copy("error.forbidden")
    );
    untouched(&door);
}

#[test]
fn close_returns_200_present_submit_for_a_flat_account_accepted_false_position_flat() {
    let door = mount();
    let res = post(&door, CLOSE, &close_body());
    res.ok();
    assert!(!res.accepted(), "{}", res.body.compact());
    assert_eq!(res.get("sequence"), &Json::Null);
    assert_eq!(res.rejected_code().as_deref(), Some("position_flat"));
    untouched(&door);
}

#[test]
fn close_closes_a_long_through_the_http_door_and_fills_at_the_book_price() {
    let door = mount();
    accepted(&post(
        &door,
        ORDERS,
        &order(TWO, "mm", "sell", "2", "100").json(),
    ));
    accepted(&post(
        &door,
        ORDERS,
        &order(ONE, "desk", "buy", "2", "100").json(),
    ));
    accepted(&post(
        &door,
        ORDERS,
        &order(THREE, "liq", "buy", "2", "100").json(),
    ));

    let res = post(&door, CLOSE, &close_body());
    accepted(&res);
    let fills = res.list("fills");
    assert_eq!(fills.len(), 1, "{}", res.body.compact());
    assert_eq!(text(at(&fills[0], "qty")), "2");
    assert_eq!(text(at(&fills[0], "price")), "100");
    assert_eq!(text(at(&fills[0], "takerSide")), "sell");
    assert_eq!(door.engine().net_position("BTC-USDT", "desk"), Amount::ZERO);
}

// ── close-position.router.test.ts: GET /markets/:marketId/positions/:accountId ─

const DESK: &str = "/markets/BTC-USDT/positions/desk";

fn position(door: &MatchingDoor, account: &str) -> String {
    let a = get(
        door,
        &format!("/markets/BTC-USDT/positions/{account}"),
        "svc-trade",
    );
    a.ok();
    a.text("qty")
}

#[test]
fn positions_refuse_an_unauthenticated_or_non_trade_read() {
    let door = mount();
    let anon = send(&door, "GET", DESK, "", &[]);
    assert_eq!(anon.status, 401, "{}", anon.body.compact());
    let other = get(&door, DESK, "svc-execution");
    assert_eq!(other.status, 403, "{}", other.body.compact());
    untouched(&door);
}

#[test]
fn positions_read_flat_for_a_book_that_does_not_exist_then_the_signed_net_of_each_side_and_a_reduce_only_order_for_the_net_closes_it()
 {
    let door = mount();

    let none = get(&door, DESK, "svc-trade");
    none.ok();
    assert_eq!(
        none.body,
        Json::obj([
            ("marketId", Json::str("BTC-USDT")),
            ("accountId", Json::str("desk")),
            ("qty", Json::str("0")),
        ])
    );
    untouched(&door);

    post(&door, ORDERS, &order(TWO, "mm", "sell", "2", "100").json()).ok();
    post(&door, ORDERS, &order(ONE, "desk", "buy", "2", "100").json()).ok();
    assert_eq!(position(&door, "desk"), "2");
    assert_eq!(position(&door, "mm"), "-2");

    post(
        &door,
        ORDERS,
        &order(THREE, "liq", "buy", "2", "100").json(),
    )
    .ok();
    // More than the position is refused by the reduce-only check, so a close sized from a stale read cannot open a short.
    let reduce = |id: &str, qty: &str| {
        order(id, "desk", "sell", qty, "98")
            .s("tif", "IOC")
            .set("reduceOnly", Json::Bool(true))
            .json()
    };
    let too_much = post(&door, ORDERS, &reduce(FOUR, "3"));
    too_much.ok();
    assert!(!too_much.accepted(), "{}", too_much.body.compact());
    assert_eq!(
        too_much.rejected_code().as_deref(),
        Some("would_increase_position")
    );
    // The close svc-trade now sends: a reduce-only IOC limit for the net at its protection floor.
    let close = post(&door, ORDERS, &reduce(FIVE, "2"));
    accepted(&close);
    let fill = &close.list("fills")[0];
    assert_eq!(text(at(fill, "qty")), "2");
    assert_eq!(text(at(fill, "price")), "100");
    assert_eq!(text(at(fill, "takerSide")), "sell");
    assert_eq!(position(&door, "desk"), "0");
    assert_eq!(
        format_amount(door.engine().net_position("BTC-USDT", "desk")),
        "0"
    );
}

// ── mass-cancel.router.test.ts: POST /markets/:marketId/orders/mass-cancel ─

/// `submitBody` of `mass-cancel.router.test.ts`: `desk`'s GTC limit sell of 1 at 100.
fn rest(order_id: &str, side: &str, price: &str) -> Json {
    Body::order()
        .s("orderId", order_id)
        .s("side", side)
        .s("price", price)
        .json()
}

fn mass_cancel(door: &MatchingDoor, body: Body) -> Answer {
    post(door, MASS_CANCEL, &body.json())
}

fn desk() -> Body {
    Body::empty().s("accountId", "desk")
}

fn cancelled_ids(a: &Answer) -> Vec<String> {
    a.list("cancellations")
        .iter()
        .map(|c| text(at(c, "orderId")))
        .collect()
}

/// The first ask is still ONE.
fn ask_stays(door: &MatchingDoor) {
    assert_eq!(text(at(&first_order(door, "asks"), "orderId")), ONE);
}

#[test]
fn mass_cancel_pulls_the_owner_and_leaves_a_different_owner() {
    let door = mount();
    accepted(&post(&door, ORDERS, &rest(ONE, "sell", "100")));
    post(
        &door,
        ORDERS,
        &Body::order()
            .s("orderId", TWO)
            .s("accountId", "mm")
            .s("side", "sell")
            .s("price", "101")
            .json(),
    )
    .ok();

    let res = mass_cancel(&door, desk());
    accepted(&res);
    assert_eq!(res.get("rejected"), &Json::Null);
    assert_eq!(cancelled_ids(&res), vec![ONE.to_owned()]);
    assert_eq!(
        text(at(&res.list("cancellations")[0], "reason")),
        "requested"
    );
    assert_eq!(live_ids(&door), vec![TWO.to_owned()]);
}

#[test]
fn mass_cancel_missing_account_refuses_no_invented_owner() {
    let door = mount();
    post(&door, ORDERS, &rest(ONE, "sell", "100")).ok();
    let res = mass_cancel(&door, Body::empty());
    assert_eq!(res.status, 400, "{}", res.body.compact());
    assert_eq!(res.text("code"), "BadRequest");
    ask_stays(&door);
}

#[test]
fn mass_cancel_session_id_refuses_the_engine_does_not_invent_a_session() {
    let door = mount();
    post(&door, ORDERS, &rest(ONE, "sell", "100")).ok();
    let res = mass_cancel(&door, desk().s("sessionId", "sess-1"));
    res.ok();
    assert!(!res.accepted(), "{}", res.body.compact());
    assert_eq!(res.rejected_code().as_deref(), Some("session_unsupported"));
    assert!(res.list("cancellations").is_empty());
    ask_stays(&door);
}

#[test]
fn mass_cancel_empty_book_is_an_accepted_no_op() {
    let door = mount();
    let res = mass_cancel(&door, desk());
    accepted(&res);
    assert!(res.list("cancellations").is_empty());
}

#[test]
fn mass_cancel_buy_only_leaves_the_sell_rest() {
    let door = mount();
    post(&door, ORDERS, &rest(ONE, "sell", "101")).ok();
    post(&door, ORDERS, &rest(THREE, "buy", "99")).ok();

    let res = mass_cancel(&door, desk().s("side", "buy"));
    accepted(&res);
    assert_eq!(cancelled_ids(&res), vec![THREE.to_owned()]);
    assert_eq!(live_ids(&door), vec![ONE.to_owned()]);
}

#[test]
fn mass_cancel_missing_side_still_cancels_both() {
    let door = mount();
    post(&door, ORDERS, &rest(ONE, "sell", "101")).ok();
    post(&door, ORDERS, &rest(THREE, "buy", "99")).ok();
    let res = mass_cancel(&door, desk());
    res.ok();
    assert_eq!(res.list("cancellations").len(), 2, "{}", res.body.compact());
    assert_eq!(levels(&door, "bids"), 0);
    assert_eq!(levels(&door, "asks"), 0);
}

#[test]
fn mass_cancel_session_id_with_a_side_still_refuses() {
    let door = mount();
    post(&door, ORDERS, &rest(ONE, "sell", "100")).ok();
    let res = mass_cancel(&door, desk().s("side", "sell").s("sessionId", "sess-1"));
    res.ok();
    assert!(!res.accepted(), "{}", res.body.compact());
    assert_eq!(res.rejected_code().as_deref(), Some("session_unsupported"));
    assert!(res.list("cancellations").is_empty());
    ask_stays(&door);
}

#[test]
fn mass_cancel_unknown_side_is_400_the_engine_does_not_invent_a_side() {
    let door = mount();
    post(&door, ORDERS, &rest(ONE, "sell", "100")).ok();
    let res = mass_cancel(&door, desk().s("side", "bid"));
    assert_eq!(res.status, 400, "{}", res.body.compact());
    assert_eq!(res.text("code"), "BadRequest");
    ask_stays(&door);
}
