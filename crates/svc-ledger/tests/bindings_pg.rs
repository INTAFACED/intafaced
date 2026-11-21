//! The four binding checks of the posting door on a real Postgres, through the Rust door, each case in its own
//! throwaway database (`support`). Without a URL it skips; with `REQUIRE_POSTGRES=1` it fails.
//!
//! Case for case, the TypeScript's own database tests, which ran on the Rust binary only through `tests/conformance`
//! (project `binding-pg`) and die with the service:
//! - `campaign-lock-binding.pg.test.ts`: its 7 cases (`campaign_*`);
//! - `maker-rebate-binding.pg.test.ts`: its 8 cases (`rebate_*`);
//! - `withdraw-fee-binding.pg.test.ts`: its 10 cases (`fee_*`);
//! - `withdraw-return-binding.pg.test.ts`: its 7 cases (`return_*`).
//!
//! Each body is the TypeScript recipe's own with the test's own edits, recorded by `scripts/record-door-books.mjs`
//! (`fixtures/door-books.golden.json`). Where the TypeScript posts through `engine.post` (its setup), this posts
//! through the engine (`posting::book`); where it calls `handleS2sPost`, this signs the call and sends it to the door:
//! with no caller, under the shared secret to a door with no keys (`support::door::DIRECT`, as the conformance run sent
//! it); as a bound `svc-pay` or `svc-bank`, with that service's own key to a door in `dual` mode. The TypeScript file
//! shares one book across its cases, in order; here each case starts from the file's `beforeAll` and books what an
//! earlier case left that it names (`f1`'s rebate, `w1`'s return).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

mod support;

use service_kit::json::Json;
use service_kit::money::{Amount, parse_amount};
use service_kit::s2s::Mode;
use support::TestDb;
use support::door::{Kit, Setup, fx, fx_list, migrated};
use svc_ledger::errors::IDEMPOTENCY_CONFLICT;
use svc_ledger::posting::bindings::{
    CAMPAIGN_LOCK_UNBOUND, REBATE_UNBOUND, WITHDRAW_FEE_UNBOUND, WITHDRAW_RETURN_UNBOUND,
};

fn amt(text: &str) -> Amount {
    parse_amount(text).unwrap()
}

fn s(v: &Json, k: &str) -> String {
    match v.get(k) {
        Some(Json::String(t)) => t.clone(),
        other => panic!("{k}: {other:?} in {}", v.compact()),
    }
}

/// The call booked: its receipt.
fn booked((status, body): (u16, Json)) -> Json {
    assert_eq!(status, 200, "{}", body.compact());
    body
}

/// `rejects.toEqual(expect.objectContaining({ code }))`.
fn refused((status, body): (u16, Json), code: &str) {
    assert_ne!(status, 200, "booked, expected {code}: {}", body.compact());
    assert_eq!(
        body.get("code"),
        Some(&Json::str(code)),
        "{}",
        body.compact()
    );
}

/// `rejects.toThrow()`.
fn thrown((status, body): (u16, Json)) {
    assert_ne!(
        status,
        200,
        "booked, expected a refusal: {}",
        body.compact()
    );
}

/// A door with no keys, custody on (every post here moves a customer's money).
fn plain(db: &TestDb) -> Kit {
    Kit::new(
        db,
        &Setup {
            mode: None,
            services: &[],
            custody_on: true,
        },
    )
}

// ── campaign-lock-binding.pg.test.ts ─────────────────────────────────────────────────────────────────────────────

fn cl(name: &str) -> Json {
    fx(&["campaignLock", name])
}

/// `beforeAll`: a rewards engine funded as production funds it, then another reward's pot locked with 500.
fn campaign_book() -> Option<(TestDb, Kit)> {
    let db = migrated()?;
    let k = plain(&db);
    for p in fx_list(&["campaignLock", "setup"]) {
        k.engine(&p);
    }
    booked(k.direct(&cl("lock0")));
    Some((db, k))
}

fn cl_account(name: &str) -> Json {
    fx(&["campaignLock", "accounts", name])
}

#[test]
fn campaign_unlocks_the_whole_lock_to_its_customer_once_and_the_other_outcome_is_then_refused() {
    let Some((_db, k)) = campaign_book() else {
        return;
    };
    booked(k.direct(&cl("lock1")));
    let first = booked(k.direct(&cl("unlock1")));
    let again = booked(k.direct(&cl("unlock1")));
    assert_eq!(s(&again, "txId"), s(&first, "txId"));
    assert_eq!(k.bal(&cl_account("customer")), "100");
    assert_eq!(k.bal(&cl_account("pot1")), "0");
    thrown(k.direct(&cl("forfeit1")));
    assert!(
        k.tx(&s(&fx(&["campaignLock", "keys"]), "forfeit1"))
            .is_none()
    );
}

#[test]
fn campaign_forfeits_the_whole_lock_back_to_the_rewards_engine_once() {
    let Some((_db, k)) = campaign_book() else {
        return;
    };
    booked(k.direct(&cl("lock2")));
    let before = k.bal(&cl_account("engine"));
    booked(k.direct(&cl("forfeit2")));
    assert_eq!(
        amt(&k.bal(&cl_account("engine"))) - amt(&before),
        amt("100")
    );
    thrown(k.direct(&cl("unlock2")));
}

#[test]
fn campaign_refuses_an_outcome_for_a_reward_that_was_never_locked_although_another_pot_could_pay_it()
 {
    let Some((_db, k)) = campaign_book() else {
        return;
    };
    refused(k.direct(&cl("unlock3")), CAMPAIGN_LOCK_UNBOUND);
    refused(k.direct(&cl("unlock3FromOtherPot")), CAMPAIGN_LOCK_UNBOUND);
    assert_eq!(k.bal(&cl_account("pot0")), "500");
}

#[test]
fn campaign_refuses_a_partial_unlock_and_a_partial_forfeit_so_no_remainder_is_left_for_the_other_outcome()
 {
    let Some((_db, k)) = campaign_book() else {
        return;
    };
    booked(k.direct(&cl("lock4")));
    refused(k.direct(&cl("unlock4Part")), CAMPAIGN_LOCK_UNBOUND);
    refused(k.direct(&cl("forfeit4Part")), CAMPAIGN_LOCK_UNBOUND);
    assert_eq!(k.bal(&cl_account("pot4")), "300");
}

#[test]
fn campaign_refuses_an_unlock_to_anyone_but_the_customer_the_lock_names() {
    let Some((_db, k)) = campaign_book() else {
        return;
    };
    booked(k.direct(&cl("lock5")));
    refused(k.direct(&cl("unlock5ToOther")), CAMPAIGN_LOCK_UNBOUND);
    refused(k.direct(&cl("unlock5ToOtherLeg")), CAMPAIGN_LOCK_UNBOUND);
    assert_eq!(k.bal(&cl_account("other")), "0");
}

#[test]
fn campaign_refuses_a_key_or_a_meta_that_names_another_reward() {
    let Some((_db, k)) = campaign_book() else {
        return;
    };
    booked(k.direct(&cl("lock6")));
    refused(k.direct(&cl("forfeit6KeyOf0")), CAMPAIGN_LOCK_UNBOUND);
    refused(k.direct(&cl("forfeit6MetaOf0")), CAMPAIGN_LOCK_UNBOUND);
    refused(k.direct(&cl("lock7KeyOf8")), CAMPAIGN_LOCK_UNBOUND);
}

#[test]
fn campaign_refuses_to_lock_a_reward_reward_pay_already_paid() {
    let Some((_db, k)) = campaign_book() else {
        return;
    };
    booked(k.direct(&cl("rewardPay9")));
    refused(k.direct(&cl("lock9")), CAMPAIGN_LOCK_UNBOUND);
    assert!(k.tx(&s(&fx(&["campaignLock", "keys"]), "lock9")).is_none());
}

// ── maker-rebate-binding.pg.test.ts ──────────────────────────────────────────────────────────────────────────────

fn mr(name: &str) -> Json {
    fx(&["makerRebate", name])
}

fn mr_account(name: &str) -> Json {
    fx(&["makerRebate", "accounts", name])
}

/// `beforeAll`: other fills' fees already in house trade fees, 1 BTC.
fn rebate_book() -> Option<(TestDb, Kit)> {
    let db = migrated()?;
    let k = plain(&db);
    for p in fx_list(&["makerRebate", "setup"]) {
        k.engine(&p);
    }
    Some((db, k))
}

/// `postFill(input)`.
fn post_fill(k: &Kit, name: &str) {
    for p in fx_list(&["makerRebate", name]) {
        k.engine(&p);
    }
}

#[test]
fn rebate_pays_the_posted_fill_maker_once_and_the_house_keeps_the_rest_of_that_fill_fee() {
    let Some((_db, k)) = rebate_book() else {
        return;
    };
    post_fill(&k, "fillF1");
    let maker_before = k.bal(&mr_account("makerBtc"));
    let house_before = k.bal(&mr_account("houseBtc"));
    let first = booked(k.direct(&mr("rebateF1")));
    let again = booked(k.direct(&mr("rebateF1")));
    assert_eq!(s(&again, "txId"), s(&first, "txId"));
    assert_eq!(
        amt(&k.bal(&mr_account("makerBtc"))) - amt(&maker_before),
        amt("0.0005")
    );
    assert_eq!(
        amt(&k.bal(&mr_account("houseBtc"))) - amt(&house_before),
        -amt("0.0005")
    );
}

#[test]
fn rebate_refuses_a_rebate_for_a_fill_that_never_posted_although_house_fees_could_pay_it() {
    let Some((_db, k)) = rebate_book() else {
        return;
    };
    refused(k.direct(&mr("rebateNone")), REBATE_UNBOUND);
    assert!(k.tx("trade.fill.rebate:f-none").is_none());
}

#[test]
fn rebate_refuses_a_larger_amount_than_the_rate_on_what_the_maker_paid() {
    let Some((_db, k)) = rebate_book() else {
        return;
    };
    post_fill(&k, "fillF2");
    refused(k.direct(&mr("rebateF2Larger")), REBATE_UNBOUND);
    assert!(k.tx("trade.fill.rebate:f2").is_none());
}

#[test]
fn rebate_refuses_a_rebate_to_someone_other_than_the_fill_maker() {
    let Some((_db, k)) = rebate_book() else {
        return;
    };
    post_fill(&k, "fillF3");
    refused(k.direct(&mr("rebateF3ToOther")), REBATE_UNBOUND);
}

#[test]
fn rebate_refuses_a_rate_that_is_not_below_the_fill_taker_rate() {
    let Some((_db, k)) = rebate_book() else {
        return;
    };
    post_fill(&k, "fillF4");
    refused(k.direct(&mr("rebateF4Rate")), REBATE_UNBOUND);
}

#[test]
fn rebate_refuses_a_rebate_on_a_fill_where_the_maker_paid_a_fee() {
    let Some((_db, k)) = rebate_book() else {
        return;
    };
    post_fill(&k, "fillF5");
    refused(k.direct(&mr("rebateF5")), REBATE_UNBOUND);
}

#[test]
fn rebate_refuses_a_key_that_names_another_fill_or_another_maker_order() {
    let Some((_db, k)) = rebate_book() else {
        return;
    };
    // What the TypeScript's first case left on its book: f1 filled and its rebate paid.
    post_fill(&k, "fillF1");
    booked(k.direct(&mr("rebateF1")));
    post_fill(&k, "fillF6");
    refused(k.direct(&mr("rebateF6KeyF1")), REBATE_UNBOUND);
    refused(k.direct(&mr("rebateF6OrderF1")), REBATE_UNBOUND);
}

#[test]
fn rebate_a_taker_selling_the_rebate_is_in_the_usdt_the_maker_paid() {
    let Some((_db, k)) = rebate_book() else {
        return;
    };
    post_fill(&k, "fillF7");
    let before = k.bal(&mr_account("makerUsdt"));
    booked(k.direct(&mr("rebateF7")));
    assert_eq!(
        amt(&k.bal(&mr_account("makerUsdt"))) - amt(&before),
        amt("0.45")
    );
}

// ── withdraw-fee-binding.pg.test.ts ──────────────────────────────────────────────────────────────────────────────

fn wf(name: &str) -> Json {
    fx(&["withdrawFee", name])
}

fn hold_of(k: &Kit, withdrawal: &str) -> String {
    k.bal(&fx(&["withdrawFee", "accounts", withdrawal]))
}

/// The TypeScript's `pay` (`{ kind: 'bound', service: 'svc-pay' }`) and its `svc-bank`: each signs with its own key, to
/// a door in `dual` mode (the conformance run's keyed door).
fn fee_book() -> Option<(TestDb, Kit)> {
    let db = migrated()?;
    let k = Kit::new(
        &db,
        &Setup {
            mode: Some(Mode::Dual),
            services: &["svc-pay", "svc-bank"],
            custody_on: true,
        },
    );
    Some((db, k))
}

/// `funded(withdrawalId)`: 100 USDT deposited by the engine.
fn funded(k: &Kit, withdrawal: &str) {
    k.engine(&fx(&["withdrawFee", "funded", withdrawal]));
}

fn pay(k: &Kit, body: &Json) -> (u16, Json) {
    k.keyed("svc-pay", "/trpc/post", body)
}

#[test]
fn fee_settles_a_fee_carrying_hold_whole_25_to_the_rail_1_5_to_house_fees_pay_and_the_hold_empties()
{
    let Some((_db, k)) = fee_book() else { return };
    funded(&k, "f1:0");
    let fees = amt(&k.bal(&fx(&["withdrawFee", "accounts", "fees"])));
    booked(pay(&k, &wf("holdF1")));
    booked(pay(&k, &wf("settleF1")));
    assert_eq!(hold_of(&k, "f1:0"), "0");
    assert_eq!(
        amt(&k.bal(&fx(&["withdrawFee", "accounts", "fees"]))) - fees,
        amt("1.5")
    );
}

#[test]
fn fee_refuses_a_settle_or_reverse_without_the_fee_its_hold_carried_or_with_another_fee_and_posts_nothing()
 {
    let Some((_db, k)) = fee_book() else { return };
    funded(&k, "f2:0");
    booked(pay(&k, &wf("holdF2")));
    for pair in fx_list(&["withdrawFee", "wrongF2"]) {
        let Json::Array(pair) = pair else {
            panic!("a [settle, reverse] pair")
        };
        refused(pay(&k, &pair[0]), WITHDRAW_FEE_UNBOUND);
        refused(pay(&k, &pair[1]), WITHDRAW_FEE_UNBOUND);
    }
    assert!(k.tx("withdraw.settle:f2:0").is_none());
    assert!(k.tx("withdraw.reverse:f2:0").is_none());
    assert_eq!(hold_of(&k, "f2:0"), "26.5");
    // The right fee reverses it whole: everything goes back.
    booked(pay(&k, &wf("reverseF2")));
    assert_eq!(hold_of(&k, "f2:0"), "0");
}

#[test]
fn fee_refuses_a_fee_on_a_settle_whose_hold_carried_none_and_a_part_settle_of_a_fee_carrying_hold()
{
    let Some((_db, k)) = fee_book() else { return };
    funded(&k, "f3:0");
    booked(pay(&k, &wf("holdF3NoFee")));
    refused(pay(&k, &wf("settleF3Fee")), WITHDRAW_FEE_UNBOUND);
    assert_eq!(hold_of(&k, "f3:0"), "25");

    funded(&k, "f4:0");
    booked(pay(&k, &wf("holdF4")));
    refused(pay(&k, &wf("settleF4Part")), WITHDRAW_FEE_UNBOUND);
    assert_eq!(hold_of(&k, "f4:0"), "26.5");
}

#[test]
fn fee_refuses_a_fee_leg_that_is_not_the_fee_the_post_names() {
    let Some((_db, k)) = fee_book() else { return };
    funded(&k, "f5:0");
    booked(pay(&k, &wf("holdF5")));
    refused(pay(&k, &wf("settleF5Skewed")), WITHDRAW_FEE_UNBOUND);
    assert!(k.tx("withdraw.settle:f5:0").is_none());
}

#[test]
fn fee_is_svc_pays_alone_another_verified_service_is_refused_a_fee_carrying_hold() {
    let Some((_db, k)) = fee_book() else { return };
    funded(&k, "f6:0");
    refused(
        k.keyed("svc-bank", "/trpc/post", &wf("holdF6")),
        WITHDRAW_FEE_UNBOUND,
    );
    assert!(k.tx("withdraw.hold:f6:0").is_none());
}

#[test]
fn fee_refuses_a_fee_carrying_post_whose_key_or_hold_is_another_withdrawal_than_the_one_it_names() {
    let Some((_db, k)) = fee_book() else { return };
    funded(&k, "f8:0");
    funded(&k, "f9:0");
    booked(pay(&k, &wf("holdF8")));
    booked(pay(&k, &wf("holdF9")));
    // Names f8 (and its fee) but draws f9's hold.
    refused(pay(&k, &wf("settleF8DrawsF9")), WITHDRAW_FEE_UNBOUND);
    refused(pay(&k, &wf("settleF8KeyF9")), WITHDRAW_FEE_UNBOUND);
    assert_eq!(hold_of(&k, "f8:0"), "26.5");
    assert_eq!(hold_of(&k, "f9:0"), "26.5");
}

#[test]
fn fee_refuses_a_post_whose_meta_names_another_withdrawal_than_its_key_and_hold_fee_or_no_fee() {
    let Some((_db, k)) = fee_book() else { return };
    funded(&k, "f10:0");
    booked(pay(&k, &wf("holdF10")));
    // A fee-less settle of f10 pointing its meta at another withdrawal would skip f10's fee and strand it in the hold.
    refused(pay(&k, &wf("settleF10MetaF11")), WITHDRAW_FEE_UNBOUND);
    assert_eq!(hold_of(&k, "f10:0"), "26.5");
}

#[test]
fn fee_a_fee_carrying_reverse_goes_back_to_the_hold_owner_only_and_a_settle_only_on_the_hold_rail()
{
    let Some((_db, k)) = fee_book() else { return };
    funded(&k, "f12:0");
    booked(pay(&k, &wf("holdF12")));
    refused(pay(&k, &wf("reverseF12ToOther")), WITHDRAW_FEE_UNBOUND);
    refused(pay(&k, &wf("settleF12Sepa")), WITHDRAW_FEE_UNBOUND);
    assert_eq!(hold_of(&k, "f12:0"), "26.5");
}

#[test]
fn fee_refuses_a_hold_retried_with_another_fee_or_rail_than_the_posted_one_at_once_or_in_turn_and_replays_the_same_hold()
 {
    let Some((_db, k)) = fee_book() else { return };
    funded(&k, "f13:0");
    booked(pay(&k, &wf("holdF13Plain")));
    refused(pay(&k, &wf("holdF13Fee")), IDEMPOTENCY_CONFLICT);
    refused(pay(&k, &wf("holdF13Sepa")), IDEMPOTENCY_CONFLICT);
    let (_, meta) = k.tx("withdraw.hold:f13:0").unwrap();
    assert!(meta.get("fee").is_none(), "{}", meta.compact());

    // Two first holds at the same moment, the same total either way: one books, the other is refused, never a silent
    // replay.
    funded(&k, "f14:0");
    let (fee, plain) = (wf("holdF14Fee"), wf("holdF14Plain"));
    let results = std::thread::scope(|scope| {
        let a = scope.spawn(|| pay(&k, &fee));
        let b = scope.spawn(|| pay(&k, &plain));
        [a.join().unwrap(), b.join().unwrap()]
    });
    assert_eq!(
        results.iter().filter(|r| r.0 == 200).count(),
        1,
        "{results:?}"
    );
    let rejected = results.iter().find(|r| r.0 != 200).unwrap().clone();
    refused(rejected, IDEMPOTENCY_CONFLICT);
    assert_eq!(hold_of(&k, "f14:0"), "26.5");
    let (_, kept) = k.tx("withdraw.hold:f14:0").unwrap();
    // The same hold as the one that booked replays.
    booked(pay(
        &k,
        if kept.get("fee").is_some() {
            &fee
        } else {
            &plain
        },
    ));
    assert_eq!(k.tx("withdraw.hold:f14:0").unwrap().1, kept);
    assert_eq!(hold_of(&k, "f14:0"), "26.5");
}

#[test]
fn fee_leaves_a_fee_less_withdrawal_exactly_as_before_part_settle_and_reverse_included() {
    let Some((_db, k)) = fee_book() else { return };
    funded(&k, "f7:0");
    let bank = |name: &str| k.keyed("svc-bank", "/trpc/post", &wf(name));
    booked(bank("holdF7"));
    booked(bank("settleF7Part"));
    booked(bank("reverseF7Part"));
    assert_eq!(hold_of(&k, "f7:0"), "0");
}

// ── withdraw-return-binding.pg.test.ts ───────────────────────────────────────────────────────────────────────────

fn wr(name: &str) -> Json {
    fx(&["withdrawReturn", name])
}

fn wr_account(name: &str) -> Json {
    fx(&["withdrawReturn", "accounts", name])
}

/// `beforeAll`: someone else's 1000 USDT already came in on the same rail.
fn return_book() -> Option<(TestDb, Kit)> {
    let db = migrated()?;
    let k = plain(&db);
    for p in fx_list(&["withdrawReturn", "setup"]) {
        k.engine(&p);
    }
    Some((db, k))
}

/// `settled(w)`: deposited, held and settled by the engine.
fn settled(k: &Kit, name: &str) {
    for p in fx_list(&["withdrawReturn", name]) {
        k.engine(&p);
    }
}

#[test]
fn return_puts_what_the_settle_sent_back_in_the_person_available_balance_once() {
    let Some((_db, k)) = return_book() else {
        return;
    };
    settled(&k, "settledW1");
    let before = k.bal(&wr_account("user"));
    let first = booked(k.direct(&wr("returnW1")));
    let again = booked(k.direct(&wr("returnW1")));
    assert_eq!(s(&again, "txId"), s(&first, "txId"));
    assert_eq!(amt(&k.bal(&wr_account("user"))) - amt(&before), amt("40"));
}

#[test]
fn return_takes_a_part_back_and_refuses_more_than_the_settle_sent() {
    let Some((_db, k)) = return_book() else {
        return;
    };
    settled(&k, "settledW2");
    refused(k.direct(&wr("returnW2More")), WITHDRAW_RETURN_UNBOUND);
    assert!(k.tx("withdraw.returned:w2:0").is_none());
    let before = k.bal(&wr_account("user"));
    booked(k.direct(&wr("returnW2Part")));
    assert_eq!(amt(&k.bal(&wr_account("user"))) - amt(&before), amt("15"));
}

#[test]
fn return_a_settle_with_a_fee_leg_takes_back_at_most_what_went_to_the_rail_never_the_fee() {
    let Some((_db, k)) = return_book() else {
        return;
    };
    settled(&k, "settledFee");
    refused(k.direct(&wr("returnFeeWhole")), WITHDRAW_RETURN_UNBOUND);
    assert!(k.tx("withdraw.returned:w-fee:0").is_none());
    let before = k.bal(&wr_account("user"));
    booked(k.direct(&wr("returnFeeRail")));
    assert_eq!(amt(&k.bal(&wr_account("user"))) - amt(&before), amt("25"));
}

#[test]
fn return_refuses_a_return_for_a_withdrawal_that_never_settled_held_reversed_or_never_made() {
    let Some((_db, k)) = return_book() else {
        return;
    };
    k.engine(&wr("w3Deposit"));
    k.engine(&wr("w3Hold"));
    refused(k.direct(&wr("returnW3")), WITHDRAW_RETURN_UNBOUND);
    k.engine(&wr("w3Reverse"));
    refused(k.direct(&wr("returnW3")), WITHDRAW_RETURN_UNBOUND);
    refused(k.direct(&wr("returnNone")), WITHDRAW_RETURN_UNBOUND);
    assert!(k.tx("withdraw.returned:w3:0").is_none());
}

#[test]
fn return_refuses_a_return_to_someone_other_than_the_person_who_sent_it() {
    let Some((_db, k)) = return_book() else {
        return;
    };
    settled(&k, "settledW4");
    refused(k.direct(&wr("returnW4ToOther")), WITHDRAW_RETURN_UNBOUND);
    assert_eq!(k.bal(&wr_account("other")), "1000");
}

#[test]
fn return_refuses_another_asset_or_another_rail_than_the_settle() {
    let Some((_db, k)) = return_book() else {
        return;
    };
    settled(&k, "settledW5");
    k.engine(&wr("otherUsdc"));
    refused(k.direct(&wr("returnW5Usdc")), WITHDRAW_RETURN_UNBOUND);
    refused(k.direct(&wr("returnW5Card")), WITHDRAW_RETURN_UNBOUND);
    // The meta names the settle's rail while the boundary leg is another rail's.
    refused(k.direct(&wr("returnW5Boundary")), WITHDRAW_RETURN_UNBOUND);
}

#[test]
fn return_refuses_a_key_that_names_another_withdrawal_than_its_meta() {
    let Some((_db, k)) = return_book() else {
        return;
    };
    // What the TypeScript's first case left on its book: w1 settled and returned.
    settled(&k, "settledW1");
    booked(k.direct(&wr("returnW1")));
    settled(&k, "settledW6");
    refused(k.direct(&wr("returnW6KeyW1")), WITHDRAW_RETURN_UNBOUND);
    refused(k.direct(&wr("returnW6MetaW1")), WITHDRAW_RETURN_UNBOUND);
}
