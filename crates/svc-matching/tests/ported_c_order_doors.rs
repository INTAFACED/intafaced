//! The order-rule doors, ported from the TypeScript service's router tests: `fok.router.test.ts`,
//! `ioc.router.test.ts`, `min-qty.router.test.ts`, `min-notional.router.test.ts`, `post-only.router.test.ts`,
//! `self-trade.router.test.ts` and `collar.router.test.ts`, test for test. Each drives `POST /markets/:marketId/orders`
//! signed by svc-trade with its body bound, through the real door over a real engine, and reads what the engine holds
//! afterwards off its book (`engine.book(MARKET).toState()`). The rules themselves, on the book, are
//! `tests/order_rules.rs`'s.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

#[allow(dead_code, reason = "each test file uses its own share of the helpers")]
mod ported_c_common;

use ported_c_common::{
    Answer, Body, ORDERS, at, first_order, levels, live_ids, mount, post, proof, side_ids, state,
    text,
};
use service_kit::json::Json;
use svc_matching::door::MatchingDoor;

const ONE: &str = "11111111-1111-4111-8111-111111111111";
const TWO: &str = "22222222-2222-4222-8222-222222222222";
const THREE: &str = "33333333-3333-4333-8333-333333333333";
const FOUR: &str = "44444444-4444-4444-8444-444444444444";

fn submit(door: &MatchingDoor, body: &Body) -> Answer {
    post(door, ORDERS, &body.json())
}

/// The first fill's quantity.
fn first_fill_qty(a: &Answer) -> String {
    let fills = a.list("fills");
    assert!(!fills.is_empty(), "no fill in {}", a.body.compact());
    text(at(&fills[0], "qty"))
}

fn no_fills(a: &Answer) {
    assert!(a.list("fills").is_empty(), "{}", a.body.compact());
}

fn not_resting(a: &Answer) {
    assert_eq!(a.get("resting"), &Json::Null, "{}", a.body.compact());
}

fn refused(a: &Answer, code: &str) {
    a.ok();
    assert!(!a.accepted(), "{}", a.body.compact());
    assert_eq!(
        a.rejected_code().as_deref(),
        Some(code),
        "{}",
        a.body.compact()
    );
}

fn taken(a: &Answer) {
    a.ok();
    assert!(a.accepted(), "{}", a.body.compact());
}

// ── fok.router.test.ts: fill completely or cancel the whole ─────────────

/// `submitBody` of `fok.router.test.ts`: a FOK limit buy of 3 at 100.
fn fok() -> Body {
    Body::order().s("qty", "3").s("tif", "FOK")
}

#[test]
fn fok_fills_completely_through_the_door() {
    let door = mount();
    let ask = submit(
        &door,
        &fok()
            .s("orderId", ONE)
            .s("accountId", "mm")
            .s("side", "sell")
            .s("tif", "GTC"),
    );
    taken(&ask);

    let res = submit(&door, &fok().s("orderId", TWO));
    taken(&res);
    assert_eq!(res.list("fills").len(), 1);
    assert_eq!(first_fill_qty(&res), "3");
    not_resting(&res);
    assert!(!live_ids(&door).contains(&TWO.to_owned()));
}

#[test]
fn fok_short_book_refuses_the_whole_no_invented_fill() {
    let door = mount();
    let ask = submit(
        &door,
        &fok()
            .s("orderId", ONE)
            .s("accountId", "mm")
            .s("side", "sell")
            .s("qty", "1")
            .s("tif", "GTC"),
    );
    ask.ok();

    let res = submit(&door, &fok().s("orderId", THREE));
    refused(&res, "fok_unfillable");
    no_fills(&res);
    not_resting(&res);
    let rest = first_order(&door, "asks");
    assert_eq!(text(at(&rest, "orderId")), ONE);
    assert_eq!(text(at(&rest, "remaining")), "1");
}

#[test]
fn fok_empty_book_does_not_invent_a_fill() {
    let door = mount();
    let res = submit(&door, &fok());
    refused(&res, "fok_unfillable");
    no_fills(&res);
    assert_eq!(levels(&door, "bids"), 0);
    assert_eq!(levels(&door, "asks"), 0);
}

// ── ioc.router.test.ts: take what is there, the remainder cancels ───────

/// `submitBody` of `ioc.router.test.ts`: an IOC limit buy of 1 at 99.
fn ioc() -> Body {
    Body::order().s("price", "99").s("tif", "IOC")
}

#[test]
fn ioc_partial_take_cancels_the_leftover_through_the_door() {
    let door = mount();
    let ask = submit(
        &door,
        &ioc()
            .s("orderId", ONE)
            .s("accountId", "mm")
            .s("side", "sell")
            .s("price", "100")
            .s("tif", "GTC"),
    );
    taken(&ask);

    let res = submit(
        &door,
        &ioc().s("orderId", TWO).s("qty", "3").s("price", "100"),
    );
    taken(&res);
    assert_eq!(res.list("fills").len(), 1);
    assert_eq!(first_fill_qty(&res), "1");
    not_resting(&res);
    let cancels = res.list("cancellations");
    assert_eq!(cancels.len(), 1, "{}", res.body.compact());
    assert_eq!(text(at(&cancels[0], "orderId")), TWO);
    assert_eq!(text(at(&cancels[0], "remainingQty")), "2");
    assert_eq!(text(at(&cancels[0], "reason")), "ioc_remainder");
    assert!(!live_ids(&door).contains(&TWO.to_owned()));
}

#[test]
fn ioc_empty_book_does_not_invent_a_leftover_rest() {
    let door = mount();
    let res = submit(&door, &ioc());
    taken(&res);
    not_resting(&res);
    let cancels = res.list("cancellations");
    assert!(!cancels.is_empty(), "{}", res.body.compact());
    assert_eq!(text(at(&cancels[0], "reason")), "ioc_remainder");
    assert_eq!(text(at(&cancels[0], "remainingQty")), "1");
    assert_eq!(levels(&door, "bids"), 0);
}

#[test]
fn ioc_gtc_still_rests_on_an_empty_book() {
    let door = mount();
    let res = submit(&door, &ioc().s("orderId", FOUR).s("tif", "GTC"));
    taken(&res);
    let resting = res.get("resting");
    assert_eq!(text(at(resting, "kind")), "book");
    assert_eq!(text(at(resting, "remaining")), "1");
}

// ── min-qty.router.test.ts: no fill below the floor, no invented default ─

/// `submitBody` of `min-qty.router.test.ts`: a GTC limit buy of 10 at 100 with a minimum fill of 5.
fn min_qty() -> Body {
    Body::order().s("qty", "10").s("minQty", "5")
}

/// The resting ask of `mm`, with no minimum of its own (`minQty: undefined`).
fn mm_ask(qty: &str) -> Body {
    min_qty()
        .s("orderId", ONE)
        .s("accountId", "mm")
        .s("side", "sell")
        .s("qty", qty)
        .unset("minQty")
}

#[test]
fn min_qty_rests_with_min_qty_a_smaller_opposite_does_not_fill_below_the_floor() {
    let door = mount();
    taken(&submit(&door, &mm_ask("2")));

    let res = submit(&door, &min_qty());
    taken(&res);
    no_fills(&res);
    assert_eq!(text(at(res.get("resting"), "remaining")), "10");
    assert_eq!(text(at(&first_order(&door, "asks"), "remaining")), "2");
    assert_eq!(text(at(&first_order(&door, "bids"), "minQty")), "5");
}

#[test]
fn min_qty_fills_when_every_clip_meets_the_floor() {
    let door = mount();
    submit(&door, &mm_ask("10")).ok();
    let res = submit(&door, &min_qty());
    taken(&res);
    assert_eq!(res.list("fills").len(), 1);
    assert_eq!(first_fill_qty(&res), "10");
    not_resting(&res);
}

#[test]
fn min_qty_missing_is_a_normal_order_no_invented_default() {
    let door = mount();
    submit(&door, &mm_ask("2")).ok();
    let res = submit(&door, &min_qty().unset("minQty").s("qty", "10"));
    taken(&res);
    assert_eq!(first_fill_qty(&res), "2");
}

#[test]
fn min_qty_above_remaining_refuses_no_invented_fill() {
    let door = mount();
    let res = submit(&door, &min_qty().s("qty", "2").s("minQty", "5"));
    refused(&res, "min_qty_exceeds_qty");
    no_fills(&res);
    assert_eq!(levels(&door, "bids"), 0);
}

// ── min-notional.router.test.ts: the caller's floor, no invented last ───

/// `submitBody` of `min-notional.router.test.ts`: a GTC limit buy of 10 at 100.
fn notional() -> Body {
    Body::order().s("qty", "10")
}

fn mm_ask_of_two() -> Body {
    notional()
        .s("orderId", ONE)
        .s("accountId", "mm")
        .s("side", "sell")
        .s("qty", "2")
}

#[test]
fn min_notional_missing_is_a_normal_order_no_invented_floor() {
    let door = mount();
    submit(&door, &mm_ask_of_two()).ok();
    let res = submit(&door, &notional().s("qty", "10"));
    taken(&res);
    assert_eq!(first_fill_qty(&res), "2");
}

#[test]
fn min_notional_without_a_price_refuses_last_on_the_book_is_not_a_notional() {
    let door = mount();
    submit(&door, &mm_ask_of_two().s("price", "100")).ok();
    submit(
        &door,
        &notional().s("orderId", TWO).s("qty", "1").s("price", "100"),
    )
    .ok();
    let res = submit(
        &door,
        &notional()
            .s("type", "market")
            .set("price", Json::Null)
            .s("tif", "IOC")
            .s("minNotional", "1000"),
    );
    refused(&res, "missing_notional");
    no_fills(&res);
    not_resting(&res);
    assert_eq!(levels(&door, "asks"), 1);
    assert_eq!(text(at(&state(&door), "lastTradePrice")), "100");
}

#[test]
fn min_notional_submit_below_the_caller_floor_refuses() {
    let door = mount();
    let res = submit(
        &door,
        &notional()
            .s("minNotional", "1000")
            .s("qty", "9")
            .s("price", "100"),
    );
    refused(&res, "below_min_notional");
    no_fills(&res);
    assert_eq!(levels(&door, "bids"), 0);
}

#[test]
fn min_notional_submit_at_the_caller_floor_takes() {
    let door = mount();
    submit(&door, &mm_ask_of_two().s("price", "100")).ok();
    let res = submit(&door, &notional().s("minNotional", "1000").s("qty", "10"));
    taken(&res);
    assert_eq!(first_fill_qty(&res), "2");
}

// ── post-only.router.test.ts: rest if it would not take, refuse if it would ─

fn proof_for(action: &str) -> Json {
    proof(action, &["PLACE", "PLACE_POST_ONLY"])
}

/// `submitBody` of `post-only.router.test.ts`: a post-only limit buy of 1 at 99, its proof `PLACE_POST_ONLY`.
fn post_only() -> Body {
    Body::order()
        .s("price", "99")
        .s("tif", "PO")
        .set("lifecycleProof", proof_for("PLACE_POST_ONLY"))
}

/// `mm`'s GTC ask at 100, placed with a `PLACE` proof.
fn mm_ask_at_100() -> Body {
    post_only()
        .s("orderId", ONE)
        .s("accountId", "mm")
        .s("side", "sell")
        .s("price", "100")
        .s("tif", "GTC")
        .set("lifecycleProof", proof_for("PLACE"))
}

#[test]
fn post_only_rests_a_post_only_behind_the_spread_through_the_door() {
    let door = mount();
    taken(&submit(&door, &mm_ask_at_100()));

    let res = submit(&door, &post_only());
    taken(&res);
    no_fills(&res);
    let resting = res.get("resting");
    assert_eq!(text(at(resting, "kind")), "book");
    assert_eq!(text(at(resting, "price")), "99");
    assert_eq!(
        at(&first_order(&door, "bids"), "postOnly"),
        &Json::Bool(true)
    );
}

#[test]
fn post_only_refuses_a_post_only_that_would_take() {
    let door = mount();
    submit(&door, &mm_ask_at_100()).ok();
    let res = submit(&door, &post_only().s("price", "100").s("orderId", TWO));
    refused(&res, "post_only_would_cross");
    no_fills(&res);
}

#[test]
fn post_only_refuses_a_post_only_market_the_engine_does_not_invent_a_price() {
    let door = mount();
    let res = submit(
        &door,
        &post_only()
            .s("type", "market")
            .set("price", Json::Null)
            .s("tif", "PO"),
    );
    refused(&res, "invalid_tif");
}

#[test]
fn post_only_post_only_true_on_gtc_rests_as_post_only() {
    let door = mount();
    submit(&door, &mm_ask_at_100()).ok();
    let res = submit(
        &door,
        &post_only()
            .s("tif", "GTC")
            .set("postOnly", Json::Bool(true))
            .set("lifecycleProof", proof_for("PLACE_POST_ONLY")),
    );
    taken(&res);
    assert_eq!(
        at(&first_order(&door, "bids"), "postOnly"),
        &Json::Bool(true)
    );
}

// ── self-trade.router.test.ts: expire the rest, the taker continues ─────

/// `submitBody` of `self-trade.router.test.ts` (and `collar.router.test.ts`): a GTC limit buy of 10 at 100.
fn ten() -> Body {
    Body::order().s("qty", "10")
}

#[test]
fn self_trade_crossing_own_rest_expires_the_rest_taker_continues_no_self_fill() {
    let door = mount();
    let own = ONE;
    let take = THREE;
    submit(
        &door,
        &ten()
            .s("orderId", own)
            .s("accountId", "same")
            .s("side", "sell")
            .s("qty", "1"),
    )
    .ok();

    let res = submit(
        &door,
        &ten()
            .s("orderId", take)
            .s("accountId", "same")
            .s("side", "buy")
            .s("qty", "1"),
    );
    taken(&res);
    assert_eq!(res.get("rejected"), &Json::Null);
    no_fills(&res);
    let cancels = res.list("cancellations");
    assert_eq!(cancels.len(), 1, "{}", res.body.compact());
    assert_eq!(text(at(&cancels[0], "orderId")), own);
    assert_eq!(text(at(&cancels[0], "reason")), "self_trade_prevention");
    assert_eq!(text(at(res.get("resting"), "orderId")), take);
    let s = state(&door);
    assert_eq!(side_ids(&s, "bids"), vec![vec![take.to_owned()]]);
    assert!(side_ids(&s, "asks").is_empty());
}

#[test]
fn self_trade_crossing_a_different_account_still_fills() {
    let door = mount();
    submit(
        &door,
        &ten()
            .s("orderId", ONE)
            .s("accountId", "mm")
            .s("side", "sell")
            .s("qty", "1"),
    )
    .ok();
    let res = submit(
        &door,
        &ten()
            .s("orderId", THREE)
            .s("accountId", "desk")
            .s("side", "buy")
            .s("qty", "1"),
    );
    taken(&res);
    let fill = &res.list("fills")[0];
    assert_eq!(text(at(fill, "makerAccountId")), "mm");
    assert_eq!(text(at(fill, "takerAccountId")), "desk");
    assert_eq!(text(at(fill, "qty")), "1");
}

// ── collar.router.test.ts: the caller's band, no invented last or mid ───

#[test]
fn collar_missing_flags_are_a_normal_order_no_invented_band() {
    let door = mount();
    submit(
        &door,
        &ten()
            .s("orderId", ONE)
            .s("accountId", "mm")
            .s("side", "sell")
            .s("qty", "2"),
    )
    .ok();
    let res = submit(&door, &ten());
    taken(&res);
    assert_eq!(first_fill_qty(&res), "2");
}

#[test]
fn collar_true_without_min_max_refuses_last_and_mid_on_the_book_are_not_a_band() {
    let door = mount();
    submit(
        &door,
        &ten()
            .s("orderId", ONE)
            .s("accountId", "mm")
            .s("side", "buy")
            .s("qty", "1")
            .s("price", "99"),
    )
    .ok();
    submit(
        &door,
        &ten()
            .s("orderId", TWO)
            .s("accountId", "mm")
            .s("side", "sell")
            .s("qty", "1")
            .s("price", "101"),
    )
    .ok();
    let res = submit(&door, &ten().set("collar", Json::Bool(true)));
    refused(&res, "missing_collar");
    no_fills(&res);
    not_resting(&res);
    assert_eq!(levels(&door, "bids"), 1);
    assert_eq!(levels(&door, "asks"), 1);
}

#[test]
fn collar_submit_below_min_refuses() {
    let door = mount();
    let res = submit(
        &door,
        &ten()
            .set("collar", Json::Bool(true))
            .s("min", "90")
            .s("max", "110")
            .s("price", "80"),
    );
    refused(&res, "outside_collar");
    no_fills(&res);
    assert_eq!(levels(&door, "bids"), 0);
}

#[test]
fn collar_submit_above_max_refuses() {
    let door = mount();
    let res = submit(
        &door,
        &ten()
            .set("collar", Json::Bool(true))
            .s("min", "90")
            .s("max", "110")
            .s("price", "120")
            .s("side", "sell"),
    );
    refused(&res, "outside_collar");
    assert_eq!(levels(&door, "asks"), 0);
}

#[test]
fn collar_true_with_min_max_inside_the_band_takes() {
    let door = mount();
    submit(
        &door,
        &ten()
            .s("orderId", ONE)
            .s("accountId", "mm")
            .s("side", "sell")
            .s("qty", "2")
            .s("price", "100"),
    )
    .ok();
    let res = submit(
        &door,
        &ten()
            .set("collar", Json::Bool(true))
            .s("min", "90")
            .s("max", "110")
            .s("qty", "10"),
    );
    taken(&res);
    assert_eq!(first_fill_qty(&res), "2");
}
