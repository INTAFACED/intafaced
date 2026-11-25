//! Slice `card-ops`' product rules around a card move, against the Rust door on a real Postgres: cashback by rank card
//! tier (`cards/card-cashback-tier.money.test.ts`), a payment by the pay-from order held at the partner
//! (`cards/pay-from-holds.money.test.ts`), the doors of `cards/cards-auth-product.test.ts`, the PIN decline of
//! `cards/cards-procedures.test.ts`, a lost card's open hold given back (`cards/cards.test.ts`, "on a lost report closes
//! the card once, reverses its open hold once"), and the cashback pot's funding (`ops.fundCashbackPot`). Every test is
//! named after the TypeScript test it ports; the last two of this file are the Rust door's own checks of a branch the
//! TypeScript reaches only through the PIN programme.
//!
//! Not ported, with the reason: "refuses the stand-in at boot outside dev or test" is `terms::sim_cashback_for`'s unit
//! test; "Pay from shows the partner's own quote" is `cards.payFrom`, slice `cards` (`cards_reads_db.rs`); the
//! reconciliation (#8) and "a partner answer for another amount or an asset outside the order" are the operator desk's
//! `ops.cardPayFromReconciliation` and a swapped partner adapter; "module kill refuses issue and authorise" needs two
//! doors on one database (one with cards on to issue, one with cards off to authorise), and the kit makes one door per
//! database; the live-posture tests (`APP_ENV=production` with card-sim) need a door whose environment refuses the TEST
//! partner, which the kit's TEST stack never is. Without `TEST_DATABASE_URL` each test skips; with `REQUIRE_POSTGRES=1`
//! it fails.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::too_many_lines,
    reason = "a test: a failure is the point"
)]

use crate::card_ops_kit::{
    CUSTOMER, CardAsk, HOLDER, Kit, Opts, authorize, authorize_with, call, capture, count,
    fund_pot, issue, kit, now, partner_set, resume, row, text, uuid,
};

use service_kit::json::Json;
use svc_bank::cards::Settings;
use svc_bank::cards::issuer::Issuer;
use svc_bank::cards::moves::partner::key;
use svc_bank::cards::moves::partner_book::book;
use svc_bank::cards::terms::{PartnerTerms, parse_cashback_rates, sim_partner_for};

fn id(a: &Json) -> String {
    text(a, "authorizationId")
}

// ── Cashback by rank card tier (J-bank-13 #7) ────────────────────────────

/// `RATES`: IFC, 100 bps for `none`, 200 for `metal`.
fn tiered(simulator_pays: bool, tier: Option<&'static str>) -> Option<Kit> {
    let k = kit(Opts {
        settings: Settings {
            cashback_rates: Some(
                parse_cashback_rates(Some(
                    r#"{"assetId":"IFC","rates":{"none":100,"metal":200}}"#,
                ))
                .unwrap(),
            ),
            simulator_pays,
            ..Settings::default()
        },
        rank: tier,
        ..Opts::default()
    })?;
    k.ledger.fund(HOLDER, "IFC", "100");
    Some(k)
}

/// One IFC card, authorised and captured for `value`: (card, reference, the capture's answer).
fn spend(k: &Kit, value: &str) -> (String, String, Json) {
    let c = issue(
        k,
        CardAsk {
            asset: Some("IFC"),
            limit: Some("50"),
            ..CardAsk::default()
        },
    );
    let reference = uuid();
    authorize(k, &c, &reference, value).ok();
    let captured = capture(k, &c, &reference, value).ok();
    (c, reference, captured)
}

#[test]
fn pays_the_tier_rate_in_ifc_once_from_the_reward_pot_and_value_is_conserved() {
    let Some(k) = tiered(true, Some("none")) else {
        return;
    };
    fund_pot(&k, "IFC", "1").ok();
    let (c, reference, captured) = spend(&k, "4");
    // 1% of 4, floored to the unit: exactly 0.04.
    let cb = captured.get("cashback").unwrap();
    assert_eq!(
        (text(cb, "status"), text(cb, "amount")),
        ("paid".to_owned(), "0.04".to_owned())
    );
    assert_eq!(k.ledger.available(HOLDER, "IFC"), "96.04");
    assert_eq!(k.ledger.pot("IFC"), "0.96");
    // A redelivered capture is refused and pays nothing more; the recovery pass pays nothing more either.
    assert_eq!(
        capture(&k, &c, &reference, "4").code(),
        "bank.card_authorization_closed"
    );
    resume(&k, &c, &reference).ok();
    assert_eq!(k.ledger.available(HOLDER, "IFC"), "96.04");
    assert_eq!(k.ledger.pot("IFC"), "0.96");
    let rows: Vec<(i32, String)> = k
        .db
        .client()
        .query(
            "SELECT cb.rate_bps, cb.status::text FROM bank.card_cashback cb \
               JOIN bank.card_authorizations a ON a.id = cb.authorization_id WHERE a.card_id = $1::text::uuid",
            &[&c],
        )
        .unwrap()
        .iter()
        .map(|r| (r.get(0), r.get(1)))
        .collect();
    assert_eq!(rows, vec![(100, "settled".to_owned())]);
    let summary = call(&k, HOLDER, CUSTOMER, "cards.cashback", &Json::Null).ok();
    for (field, want) in [
        ("tier", "none"),
        ("rateBps", "100"),
        ("assetId", "IFC"),
        ("paid", "0.04"),
        ("unpaid", "0"),
        ("paying", "true"),
    ] {
        assert_eq!(text(&summary, field), want, "{field}");
    }
    // The person's gain is exactly the pot's loss, and nothing was made: 100 credited in, 1 of revenue swept.
    assert_eq!(k.ledger.total("IFC"), "101");
}

#[test]
fn uses_the_persons_own_tier() {
    let Some(k) = tiered(true, Some("metal")) else {
        return;
    };
    fund_pot(&k, "IFC", "1").ok();
    let (_, _, captured) = spend(&k, "4");
    let cb = captured.get("cashback").unwrap();
    assert_eq!(
        (text(cb, "status"), text(cb, "amount")),
        ("paid".to_owned(), "0.08".to_owned())
    );
}

#[test]
fn keeps_an_unpaid_row_and_pays_nothing_when_the_pot_is_short_the_capture_stands() {
    let Some(k) = tiered(true, Some("none")) else {
        return;
    };
    let (_, _, captured) = spend(&k, "4");
    let cb = captured.get("cashback").unwrap();
    assert_eq!(
        (text(cb, "status"), text(cb, "reason")),
        (
            "refused".to_owned(),
            "bank.cashback_pot_unfunded".to_owned()
        )
    );
    assert_eq!(k.ledger.available(HOLDER, "IFC"), "96");
    let summary = call(&k, HOLDER, CUSTOMER, "cards.cashback", &Json::Null).ok();
    assert_eq!(text(&summary, "unpaid"), "0");
    assert_eq!(text(&summary, "refused"), "0.04");
}

#[test]
fn refuses_by_name_for_a_tier_with_no_published_rate_and_writes_no_row() {
    let Some(k) = tiered(true, Some("obsidian")) else {
        return;
    };
    fund_pot(&k, "IFC", "1").ok();
    let (c, _, captured) = spend(&k, "4");
    let cb = captured.get("cashback").unwrap();
    assert_eq!(
        (text(cb, "status"), text(cb, "reason")),
        ("refused".to_owned(), "bank.cashback_rate_unset".to_owned())
    );
    assert_eq!(
        count(
            &k,
            &format!(
                "SELECT count(*) FROM bank.card_cashback cb JOIN bank.card_authorizations a ON a.id = cb.authorization_id \
                  WHERE a.card_id = '{c}'"
            )
        ),
        0
    );
    let Some(unset) = kit(Opts::default()) else {
        return;
    };
    assert_eq!(
        call(&unset, HOLDER, CUSTOMER, "cards.cashback", &Json::Null).code(),
        "bank.cashback_rate_unset"
    );
}

#[test]
fn earns_a_cashback_the_tier_read_missed_at_capture_once_when_the_settlement_is_resumed() {
    let Some(k) = tiered(true, None) else { return };
    fund_pot(&k, "IFC", "1").ok();
    let (c, reference, captured) = spend(&k, "4");
    let cb = captured.get("cashback").unwrap();
    assert_eq!(
        (text(cb, "status"), text(cb, "reason")),
        ("refused".to_owned(), "bank.rank_unavailable".to_owned())
    );
    assert_eq!(k.ledger.available(HOLDER, "IFC"), "96");
    k.rank.set(Some("none"));
    resume(&k, &c, &reference).ok();
    resume(&k, &c, &reference).ok();
    assert_eq!(k.ledger.available(HOLDER, "IFC"), "96.04");
    assert_eq!(k.ledger.pot("IFC"), "0.96");
    assert_eq!(k.ledger.booked("reward:"), 1);
}

#[test]
fn pays_nothing_on_the_simulator_without_its_test_stand_in_as_before() {
    let Some(k) = tiered(false, Some("none")) else {
        return;
    };
    fund_pot(&k, "IFC", "1").ok();
    let (_, _, captured) = spend(&k, "4");
    let cb = captured.get("cashback").unwrap();
    assert_eq!(
        (text(cb, "status"), text(cb, "reason")),
        ("refused".to_owned(), "bank.rewards_issuer_unset".to_owned())
    );
    assert_eq!(k.ledger.pot("IFC"), "1");
}

// ── A card payment by the pay-from order (J-bank-29 #3 to #8) ────────────

/// The stack's TEST partner card (the bank profile): 30 USDC, 0.01 BTC and 50 USD, 1 BTC quoted at 50000 USDC, 1 USD
/// at 1. The journey's card draws on USDT (an asset the partner cannot spend from) and settles in USDC.
fn pay_from() -> Option<(Kit, String)> {
    let terms: PartnerTerms = sim_partner_for(
        Some(
            r#"{"custodyMode":"partner_holds","spendFrom":["USDC","BTC","USD"],"lossLiability":null,"reserve":null,"funder":null,"balances":{"USDC":"30","BTC":"0.01","USD":"50"},"programmeFigures":null,"figuresAsOf":null,"fundingAssetId":null,"fundingOffers":null,"rates":{"in":"USDC","perUnit":{"BTC":"50000","USD":"1"}}}"#,
        ),
        Some("test"),
        Some("test"),
    )
    .unwrap();
    let k = kit(Opts {
        partner: true,
        issuer: Issuer::sim(terms),
        settings: Settings {
            spend_assets: Some(vec!["USDC".to_owned(), "BTC".to_owned(), "USD".to_owned()]),
            ..Settings::default()
        },
        ..Opts::default()
    })?;
    partner_set(&k, HOLDER, &[("custody", "off")]);
    let c = issue(
        &k,
        CardAsk {
            asset: Some("USDT"),
            settlement: Some("USDC"),
            ..CardAsk::default()
        },
    );
    call(
        &k,
        HOLDER,
        CUSTOMER,
        "cards.setPayFromOrder",
        &Json::obj([(
            "assetIds",
            Json::Array(vec![Json::str("USDC"), Json::str("BTC"), Json::str("USD")]),
        )]),
    )
    .ok();
    Some((k, c))
}

fn pay(k: &Kit, c: &str, amount: &str) -> (Json, String) {
    let reference = format!("jb29-{}", uuid());
    (authorize(k, c, &reference, amount).ok(), reference)
}

fn figures(k: &Kit, asset: &str) -> (String, String) {
    let f = k
        .door
        .cards_deps(now(), |d| book(d).unwrap().figures(HOLDER, asset))
        .unwrap()
        .json();
    (text(&f, "available"), text(&f, "held"))
}

fn pair(a: &str, b: &str) -> (String, String) {
    (a.to_owned(), b.to_owned())
}

/// The authorisation row's pay-from order, status and money book.
fn order_row(k: &Kit, auth: &str) -> Vec<Option<String>> {
    row(
        k,
        &format!(
            "SELECT array_to_string(pay_from_order, ','), status::text, money_book FROM bank.card_authorizations \
              WHERE id = '{auth}'"
        ),
    )
}

#[test]
fn n3_a_charge_of_25_is_held_from_usdc_the_first_asset_at_the_partners_rate_and_time_usdc_available_falls_by_exactly_that()
 {
    let Some((k, c)) = pay_from() else { return };
    let (paid, _) = pay(&k, &c, "25");
    assert_eq!(text(&paid, "decision"), "approved");
    assert_eq!(text(&paid, "amount"), "25");
    let r = order_row(&k, &id(&paid));
    assert_eq!(
        (r[0].as_deref(), r[1].as_deref(), r[2].as_deref()),
        (Some("USDC,BTC,USD"), Some("settled"), Some("partner"))
    );
    let conv = paid.get("conversion").unwrap();
    // The router's conversion names no funding side; what was held, and in what, is the partner's hold below.
    for (field, want) in [
        ("settlementAssetId", "USDC"),
        ("settlementAmount", "25"),
        ("rate", "1"),
        ("rateQuality", "partner"),
    ] {
        assert_eq!(text(conv, field), want, "{field}");
    }
    assert_eq!(figures(&k, "USDC"), pair("5", "25"));
    let report = k
        .door
        .cards_deps(now(), |d| {
            book(d).unwrap().hold_state(&key("hold", &id(&paid)))
        })
        .unwrap()
        .unwrap()
        .json();
    assert_eq!(
        (text(&report, "assetId"), text(&report, "amount")),
        pair("USDC", "25")
    );
    assert_eq!(text(report.get("conversion").unwrap(), "rate"), "1");
    assert_eq!(
        text(report.get("conversion").unwrap(), "rateAsOf"),
        text(conv, "rateAsOf")
    );
    assert_eq!(k.ledger.journal_len(), 0);
}

#[test]
fn n4_a_charge_of_40_more_than_the_usdc_left_is_one_btc_hold_at_50000_usdc_is_unchanged() {
    let Some((k, c)) = pay_from() else { return };
    pay(&k, &c, "25");
    let (btc, reference) = pay(&k, &c, "40");
    assert_eq!(text(&btc, "decision"), "approved");
    let conv = btc.get("conversion").unwrap();
    assert_eq!(
        (text(conv, "rate"), text(conv, "rateQuality")),
        ("50000".to_owned(), "partner".to_owned())
    );
    assert_eq!(text(&btc, "amount"), "0.0008");
    let funding = row(
        &k,
        &format!(
            "SELECT funding_asset_id, funding_amount::text FROM bank.card_conversions WHERE authorization_id = '{}'",
            id(&btc)
        ),
    );
    assert_eq!(funding[0].as_deref(), Some("BTC"));
    assert_eq!(
        crate::card_ops_kit::amount_text(funding[1].clone()),
        "0.0008"
    );
    assert_eq!(figures(&k, "USDC"), pair("5", "25"));
    assert_eq!(figures(&k, "BTC"), pair("0.0092", "0.0008"));
    assert_eq!(figures(&k, "USD"), pair("50", "0"));
    // A redelivery returns the first decision and holds nothing more.
    let again = authorize(&k, &c, &reference, "40").ok();
    assert_eq!(id(&again), id(&btc));
    assert_eq!(figures(&k, "BTC"), pair("0.0092", "0.0008"));
}

#[test]
fn n5_a_charge_no_one_asset_covers_is_the_partners_decline_bank_card_insufficient_funds_naming_the_order_nothing_held()
 {
    let Some((k, c)) = pay_from() else { return };
    pay(&k, &c, "25");
    pay(&k, &c, "40");
    let before: Vec<_> = ["USDC", "BTC", "USD"]
        .iter()
        .map(|a| figures(&k, a))
        .collect();
    let (declined, _) = pay(&k, &c, "500");
    assert_eq!(text(&declined, "decision"), "declined");
    assert_eq!(
        text(&declined, "declineCode"),
        "bank.card_insufficient_funds"
    );
    assert_eq!(declined.get("conversion"), Some(&Json::Null));
    let r = order_row(&k, &id(&declined));
    assert_eq!(
        (r[0].as_deref(), r[1].as_deref()),
        (Some("USDC,BTC,USD"), Some("rejected"))
    );
    let after: Vec<_> = ["USDC", "BTC", "USD"]
        .iter()
        .map(|a| figures(&k, a))
        .collect();
    assert_eq!(after, before);
    assert_eq!(k.ledger.journal_len(), 0);
}

#[test]
fn n6_n7_capture_22_of_25_settles_22_usdc_and_returns_3_a_refund_of_10_credits_usdc_once_and_its_repeat_changes_nothing()
 {
    let Some((k, c)) = pay_from() else { return };
    let (first, first_ref) = pay(&k, &c, "25");
    let captured = capture(&k, &c, &first_ref, "22").ok();
    assert_eq!(
        (
            text(&captured, "heldBy"),
            text(&captured, "captured"),
            text(&captured, "returned")
        ),
        ("partner".to_owned(), "22".to_owned(), "3".to_owned())
    );
    assert_eq!(figures(&k, "USDC"), pair("8", "0"));
    // Never more than it held.
    let (_, second_ref) = pay(&k, &c, "5");
    assert_eq!(
        capture(&k, &c, &second_ref, "5.01").code(),
        "bank.card_capture_exceeds_authorization"
    );
    let feed = call(
        &k,
        HOLDER,
        CUSTOMER,
        "cards.authorizations",
        &Json::obj([("cardId", Json::str(c.clone())), ("limit", Json::int(50))]),
    )
    .ok();
    let Json::Array(feed) = feed else {
        panic!("{}", feed.compact())
    };
    // The feed's pay-from line (the router's `settled` figures of `authorizationsOf`).
    let row = feed.iter().find(|r| text(r, "id") == id(&first)).unwrap();
    let paid_from = row.get("payFrom").unwrap();
    assert_eq!(
        (
            text(paid_from, "assetId"),
            text(paid_from, "captured"),
            text(paid_from, "returned")
        ),
        ("USDC".to_owned(), "22".to_owned(), "3".to_owned())
    );
    let refund = |amount: &str| {
        call(
            &k,
            HOLDER,
            CUSTOMER,
            "testPartner.cardRefund",
            &Json::obj([
                ("cardId", Json::str(c.clone())),
                ("authorizationRef", Json::str(first_ref.clone())),
                ("amount", Json::str(amount)),
            ]),
        )
        .ok()
    };
    let r = refund("10");
    assert_eq!(text(&r, "refunded"), "10");
    let repeat = refund("10");
    assert_eq!(text(&repeat, "partnerRef"), text(&r, "partnerRef"));
    // 8 after the capture, less the 5 still held for the second payment, plus the one refund of 10.
    assert_eq!(figures(&k, "USDC"), pair("13", "5"));
    assert_eq!(k.ledger.journal_len(), 0);
}

#[test]
fn a_btc_refund_credits_btc_at_the_rate_it_was_held_at_rounded_down() {
    let Some((k, c)) = pay_from() else { return };
    pay(&k, &c, "25");
    let (_, reference) = pay(&k, &c, "40");
    capture(&k, &c, &reference, "40").ok();
    let r = call(
        &k,
        HOLDER,
        CUSTOMER,
        "testPartner.cardRefund",
        &Json::obj([
            ("cardId", Json::str(c.clone())),
            ("authorizationRef", Json::str(reference)),
            ("amount", Json::str("10")),
        ]),
    )
    .ok();
    assert_eq!(text(&r, "refunded"), "0.0002");
    assert_eq!(figures(&k, "BTC").0, "0.0094");
}

// ── The doors (cards-auth-product.test.ts, cards-procedures.test.ts) ─────

#[test]
fn carries_a_named_insufficient_funds_decline_through_the_public_door_and_moves_nothing() {
    let Some(k) = kit(Opts::default()) else {
        return;
    };
    k.ledger.fund(HOLDER, "USDT", "10");
    let c = issue(
        &k,
        CardAsk {
            limit: Some("250"),
            ..CardAsk::default()
        },
    );
    let declined = authorize(&k, &c, &format!("auth-{}", uuid()), "80").ok();
    assert_eq!(text(&declined, "decision"), "declined");
    assert_eq!(text(&declined, "declineCode"), "ledger.insufficient_funds");
    assert_eq!(k.ledger.available(HOLDER, "USDT"), "10");
    assert_eq!(k.ledger.total("USDT"), "10");
}

#[test]
fn refuses_user_sessions_on_the_authorisation_ops_door() {
    let Some(k) = kit(Opts::default()) else {
        return;
    };
    k.ledger.fund(HOLDER, "USDT", "500");
    let c = issue(&k, CardAsk::default());
    let a = call(
        &k,
        HOLDER,
        CUSTOMER,
        "ops.cardAuthorize",
        &Json::obj([
            ("cardId", Json::str(c)),
            ("authorizationRef", Json::str(format!("auth-{}", uuid()))),
            ("amount", Json::str("10")),
        ]),
    );
    assert_eq!(a.0, 403, "{}", a.1.compact());
    assert_eq!(
        a.1.get("error")
            .and_then(|e| e.get("data"))
            .and_then(|d| d.get("code")),
        Some(&Json::str("FORBIDDEN"))
    );
    assert_eq!(
        count(&k, "SELECT count(*) FROM bank.card_authorizations"),
        0
    );
    assert_eq!(k.ledger.available(HOLDER, "USDT"), "500");
}

#[test]
fn declines_a_typed_pin_by_name_while_the_owner_has_not_set_the_try_limit() {
    let Some(k) = kit(Opts::default()) else {
        return;
    };
    k.ledger.fund(HOLDER, "USDT", "10");
    let c = issue(&k, CardAsk::default());
    let tapped = authorize_with(&k, &c, "auth-no-limit", "1", &[("pin", Json::str("4321"))]).ok();
    assert_eq!(text(&tapped, "decision"), "declined");
    assert_eq!(
        text(&tapped, "declineCode"),
        "bank.card_pin_try_limit_unset"
    );
    assert_eq!(k.ledger.available(HOLDER, "USDT"), "10");
}

/// The Rust door's own: with the try limit set, a typed PIN on a programme with no PIN partner is declined by name.
#[test]
fn declines_a_typed_pin_by_name_when_no_partner_keeps_pins() {
    let Some(k) = kit(Opts {
        settings: Settings {
            pin_try_limit: Some(3),
            ..Settings::default()
        },
        ..Opts::default()
    }) else {
        return;
    };
    k.ledger.fund(HOLDER, "USDT", "10");
    let c = issue(&k, CardAsk::default());
    let tapped = authorize_with(&k, &c, "auth-no-pins", "1", &[("pin", Json::str("4321"))]).ok();
    assert_eq!(text(&tapped, "declineCode"), "bank.card_pin_issuer_unset");
    assert_eq!(k.ledger.available(HOLDER, "USDT"), "10");
}

/// The Rust door's own: the TEST PIN partner with no PIN set on the card declines by name and holds nothing.
#[test]
fn declines_a_typed_pin_by_name_on_a_card_with_no_pin_set() {
    let Some(k) = kit(Opts {
        issuer: Issuer::sim(PartnerTerms {
            test_secrets: true,
            ..PartnerTerms::nothing_reported()
        }),
        settings: Settings {
            pin_try_limit: Some(3),
            ..Settings::default()
        },
        ..Opts::default()
    }) else {
        return;
    };
    k.ledger.fund(HOLDER, "USDT", "10");
    let c = issue(&k, CardAsk::default());
    let tapped = authorize_with(&k, &c, "auth-no-pin", "1", &[("pin", Json::str("4321"))]).ok();
    assert_eq!(text(&tapped, "declineCode"), "bank.card_pin_not_set");
    assert_eq!(k.ledger.available(HOLDER, "USDT"), "10");
}

// ── A lost card's open hold, and the pot ─────────────────────────────────

#[test]
fn on_a_lost_report_closes_the_card_once_reverses_its_open_hold_once() {
    let Some(k) = kit(Opts::default()) else {
        return;
    };
    k.ledger.fund(HOLDER, "USDT", "100");
    let c = issue(&k, CardAsk::default());
    let auth = id(&authorize(&k, &c, "lost-1", "30").ok());
    assert_eq!(k.ledger.available(HOLDER, "USDT"), "70");
    let replacement = uuid();
    let report = || {
        call(
            &k,
            HOLDER,
            CUSTOMER,
            "cards.replace",
            &Json::obj([
                ("cardId", Json::str(c.clone())),
                ("replacementId", Json::str(replacement.clone())),
                ("reason", Json::str("lost")),
            ]),
        )
    };
    let first = report();
    assert_eq!(first.0, 200, "{}", first.1.compact());
    let again = report();
    assert_eq!(again.0, 200, "{}", again.1.compact());
    assert_eq!(
        row(
            &k,
            &format!("SELECT status::text FROM bank.cards WHERE id = '{c}'")
        )[0]
        .as_deref(),
        Some("closed")
    );
    assert_eq!(k.ledger.booked(&format!("withdraw.reverse:{auth}")), 1);
    assert_eq!(k.ledger.held(&auth, HOLDER, "USDT"), "0");
    assert_eq!(k.ledger.available(HOLDER, "USDT"), "100");
    assert_eq!(
        count(
            &k,
            &format!(
                "SELECT count(*) FROM bank.card_settlements WHERE authorization_id = '{auth}' AND kind = 'reversal' AND status = 'settled'"
            )
        ),
        1
    );
}

/// `ops.fundCashbackPot`: the pot is funded only from revenue the bank earned, once per window, and its capacity read.
#[test]
fn funds_the_cashback_pot_from_bank_revenue_once_per_window_and_refuses_more_than_was_earned() {
    let Some(k) = kit(Opts::default()) else {
        return;
    };
    k.ledger.fees("USDT", "5");
    let window = format!("w-{}", uuid());
    let sweep = |amount: &str| {
        crate::card_ops_kit::op(
            &k,
            "ops.fundCashbackPot",
            &[
                ("windowId", Json::str(window.clone())),
                ("assetId", Json::str("USDT")),
                ("amount", Json::str(amount)),
            ],
        )
    };
    let funded = sweep("3").ok();
    assert_eq!(text(&funded, "capacity"), "3");
    assert_eq!(k.ledger.pot("USDT"), "3");
    // The same window again is the same sweep: nothing more moves.
    sweep("3").ok();
    assert_eq!(k.ledger.pot("USDT"), "3");
    assert_eq!(k.ledger.booked("token.fee.sweep:"), 1);
    // More than the revenue left is the ledger's refusal, and the pot is unchanged.
    let over = crate::card_ops_kit::op(
        &k,
        "ops.fundCashbackPot",
        &[
            ("windowId", Json::str(format!("w-{}", uuid()))),
            ("assetId", Json::str("USDT")),
            ("amount", Json::str("3")),
        ],
    );
    assert_eq!(over.code(), "ledger.insufficient_funds");
    assert_eq!(k.ledger.pot("USDT"), "3");
    assert_eq!(k.ledger.total("USDT"), "5");
}
