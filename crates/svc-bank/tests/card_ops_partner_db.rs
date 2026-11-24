//! Slice `card-ops`' partner-held card money against the Rust door on a real Postgres: the TEST partner card holds,
//! captures, releases and refunds an authorisation once per key, and the ledger posts nothing. Driven through
//! `ops.cardAuthorize`, `ops.cardCapture`, `ops.cardReverse`, `ops.cardResumeSettlement`, `testPartner.cardRefund`,
//! `cards.partnerHeld` and `cards.replace`. Every test is named after the TypeScript test it ports, from
//! `cards/card-partner-held.money.test.ts`.
//!
//! The TypeScript wraps the partner adapter to lose a reply or to race another hold; the Rust door has one TEST partner
//! book per process and no seam to wrap it, so "a reply was lost" is reached by making the move at the partner first under
//! the same key (the reply that never came back), and the race is not ported (the short balance below is the same
//! decline from the same code). Not ported, with the reason: "if the partner's reply is lost, the row stays pending" and
//! "a redelivery after a hold the partner made (reply lost), now frozen" need a pending partner hold row, which only a
//! lost hold reply leaves (the hold key carries the authorisation id, which the test cannot know before the call); "the
//! partner's refusal to hold after our read" swaps in an adapter that refuses every hold; "with no hand-over wired" needs
//! a door without a bus (the door always wires one, as `index.ts` does); "a card programme with no partner that holds
//! authorisations" and "a stolen card whose release fails before it is claimed" build a `CardService` with no partner
//! book while the door always builds one with the TEST partner on; "a freeze that cannot be read, or none wired" is the
//! freeze read's own refusal (`partner::custody`, ported with slice `partner`); "a partner refusal is the only error that
//! rejects a claim" is the type `PartnerErr::Refused`. Without `TEST_DATABASE_URL` each test skips; with
//! `REQUIRE_POSTGRES=1` it fails.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::too_many_lines,
    reason = "a test: a failure is the point"
)]

use crate::card_ops_kit::{
    CUSTOMER, CardAsk, HOLDER, Kit, Opts, authorize, authorize_with, call, capture, count, issue,
    kit, now, partner_set, resume, reverse, row, text, tier_rates, uuid,
};

use service_kit::json::Json;
use svc_bank::cards::Settings;
use svc_bank::cards::issuer::Issuer;
use svc_bank::cards::moves::partner::key;
use svc_bank::cards::moves::partner_book::book;
use svc_bank::cards::terms::PartnerTerms;

/// The TEST partner card's answers, as the stack's profile gives them: it holds the crypto, 100 USDC each, TEST.
fn usdc_terms(mode: &str) -> PartnerTerms {
    PartnerTerms {
        custody_mode: Some(mode.to_owned()),
        spend_from: Some(vec!["USDC".to_owned()]),
        balances: Some(vec![("USDC".to_owned(), "100".to_owned())]),
        ..PartnerTerms::nothing_reported()
    }
}

fn door(
    terms: PartnerTerms,
    custody_on: bool,
    settings: Settings,
    rank: Option<&'static str>,
) -> Option<Kit> {
    kit(Opts {
        partner: true,
        custody_on,
        issuer: Issuer::sim(terms),
        settings,
        rank,
    })
}

/// Custody off for the holder: the partner holds it.
fn held() -> Option<Kit> {
    let k = door(usdc_terms("partner_holds"), true, Settings::default(), None)?;
    partner_set(&k, HOLDER, &[("custody", "off")]);
    Some(k)
}

/// J-bank-13 #7's TEST cashback: USDC rates by rank tier, the simulator's TEST stand-in on, the holder at `metal`.
fn held_with_cashback() -> Option<Kit> {
    let k = door(
        usdc_terms("partner_holds"),
        true,
        Settings {
            cashback_rates: Some(tier_rates("USDC")),
            simulator_pays: true,
            ..Settings::default()
        },
        Some("metal"),
    )?;
    partner_set(&k, HOLDER, &[("custody", "off")]);
    Some(k)
}

fn usdc(k: &Kit) -> String {
    issue(
        k,
        CardAsk {
            asset: Some("USDC"),
            ..CardAsk::default()
        },
    )
}

fn id(a: &Json) -> String {
    text(a, "authorizationId")
}

/// The authorisation row: decision, status, money book, partner hold ref, partner mode, decline code, hold tx.
fn auth_row(k: &Kit, reference: &str) -> Vec<Option<String>> {
    row(
        k,
        &format!(
            "SELECT decision::text, status::text, money_book, partner_hold_ref, partner_mode, decline_code, hold_ledger_tx_id \
               FROM bank.card_authorizations WHERE authorization_ref = '{reference}'"
        ),
    )
}

/// `cards.partnerHeld`, as the holder reads it.
fn view(k: &Kit, card: &str) -> Json {
    call(
        k,
        HOLDER,
        CUSTOMER,
        "cards.partnerHeld",
        &Json::obj([("cardId", Json::str(card)), ("limit", Json::int(10))]),
    )
    .ok()
}

/// The partner's figures for the holder's USDC: (available, held).
fn figures(k: &Kit, card: &str) -> (String, String) {
    let v = view(k, card);
    let f = v.get("figures").unwrap();
    (text(f, "available"), text(f, "held"))
}

fn pair(a: &str, b: &str) -> (String, String) {
    (a.to_owned(), b.to_owned())
}

/// The partner's record of one hold, or `None`.
fn hold_state(k: &Kit, authorization_id: &str) -> Option<Json> {
    k.door
        .cards_deps(now(), |d| {
            book(d).unwrap().hold_state(&key("hold", authorization_id))
        })
        .unwrap()
        .map(|r| r.json())
}

/// The ledger posted nothing at all.
fn ledger_untouched(k: &Kit) {
    assert_eq!(
        k.ledger.journal_len(),
        0,
        "the ledger posted on a partner-held card"
    );
}

fn refund(k: &Kit, card: &str, reference: &str, amount: &str) -> crate::card_ops_kit::Answer {
    call(
        k,
        HOLDER,
        CUSTOMER,
        "testPartner.cardRefund",
        &Json::obj([
            ("cardId", Json::str(card)),
            ("authorizationRef", Json::str(reference)),
            ("amount", Json::str(amount)),
        ]),
    )
}

fn settlements(k: &Kit, auth: &str) -> Vec<(i32, String, String, Option<String>)> {
    k.db
        .client()
        .query(
            &format!(
                "SELECT sequence, kind::text, status::text, rejection_code FROM bank.card_settlements \
                  WHERE authorization_id = '{auth}' ORDER BY sequence"
            ),
            &[],
        )
        .unwrap()
        .iter()
        .map(|r| (r.get(0), r.get(1), r.get(2), r.get(3)))
        .collect()
}

fn stop(k: &Kit, kinds: &[&str]) {
    let kinds: Vec<String> = kinds.iter().map(|s| (*s).to_owned()).collect();
    k.db.client()
        .execute(
            "INSERT INTO bank.partner_stops (partner_id, stopped_kinds, revision, reason, approved_by) \
             VALUES ('test-partner', $1, 1, 'TEST wrong card instructions seen', 'approver-2') \
             ON CONFLICT (partner_id) DO UPDATE SET stopped_kinds = EXCLUDED.stopped_kinds, \
               revision = bank.partner_stops.revision + 1, updated_at = now()",
            &[&kinds],
        )
        .unwrap();
}

// ── Custody off: the partner holds it, and the ledger posts nothing ──────

#[test]
fn planted_an_approved_authorisation_is_held_by_the_partner_from_the_partner_balance_and_no_ledger_tx_exists_under_its_key()
 {
    let Some(k) = held() else { return };
    // A ledger balance the custodial path COULD hold from, so a hold posted to the ledger would be seen here.
    k.ledger.fund(HOLDER, "USDC", "100");
    let c = usdc(&k);
    let a = authorize(&k, &c, "jb14-hold-1", "40").ok();
    let auth = id(&a);
    for prefix in [
        "withdraw.hold:",
        "withdraw.settle:",
        "withdraw.reverse:",
        "reward:",
    ] {
        assert_eq!(k.ledger.booked(&format!("{prefix}{auth}")), 0);
    }
    ledger_untouched(&k);
    assert_eq!(text(&a, "decision"), "approved");
    let r = auth_row(&k, "jb14-hold-1");
    assert_eq!(r[1].as_deref(), Some("settled"));
    assert_eq!(r[2].as_deref(), Some("partner"));
    assert_eq!(r[6], None);
    assert_eq!(r[4].as_deref(), Some("partner_holds"));
    assert_eq!(
        r[3].as_deref(),
        Some(format!("TEST-card-partner:{}", key("hold", &auth)).as_str())
    );
    let v = view(&k, &c);
    assert_eq!(text(&v, "heldBy"), "partner");
    let f = v.get("figures").unwrap();
    assert_eq!(text(f, "test"), "true");
    assert_eq!((text(f, "available"), text(f, "held")), pair("60", "40"));
    let Some(Json::Array(rows)) = v.get("authorizations") else {
        panic!("{}", v.compact())
    };
    assert_eq!(rows.len(), 1);
    assert_eq!(text(&rows[0], "authorizationId"), auth);
    let report = rows[0].get("report").unwrap();
    assert_eq!(
        (
            text(report, "status"),
            text(report, "amount"),
            text(report, "open")
        ),
        ("held".to_owned(), "40".to_owned(), "40".to_owned())
    );
    assert_eq!(k.ledger.available(HOLDER, "USDC"), "100");
}

#[test]
fn a_redelivery_holds_once_and_returns_the_first_decision() {
    let Some(k) = held() else { return };
    let c = usdc(&k);
    let first = authorize(&k, &c, "jb14-redeliver", "40").ok();
    let second = authorize(&k, &c, "jb14-redeliver", "40").ok();
    assert_eq!(id(&second), id(&first));
    assert_eq!(text(&second, "decision"), text(&first, "decision"));
    assert_eq!(figures(&k, &c), pair("60", "40"));
    ledger_untouched(&k);
}

#[test]
fn a_short_partner_balance_is_a_decline_the_partner_gave_naming_it_with_nothing_held() {
    let Some(k) = held() else { return };
    let c = usdc(&k);
    let a = authorize(&k, &c, "jb14-short", "100.5").ok();
    assert_eq!(text(&a, "decision"), "declined");
    assert_eq!(
        text(&a, "declineCode"),
        "bank.card_partner_insufficient_funds"
    );
    assert_eq!(auth_row(&k, "jb14-short")[2].as_deref(), Some("partner"));
    assert_eq!(figures(&k, &c), pair("100", "0"));
    ledger_untouched(&k);
}

#[test]
fn captures_at_the_partner_gives_the_rest_back_and_the_ledger_still_posts_nothing() {
    let Some(k) = held() else { return };
    let c = usdc(&k);
    let auth = id(&authorize(&k, &c, "jb14-capture", "40").ok());
    let r = capture(&k, &c, "jb14-capture", "30").ok();
    assert_eq!(text(&r, "heldBy"), "partner");
    assert_eq!(text(&r, "captured"), "30");
    assert_eq!(text(&r, "returned"), "10");
    assert_eq!(text(&r, "captureLedgerTxId"), "null");
    assert_eq!(text(&r, "reversalLedgerTxId"), "null");
    assert_eq!(text(r.get("cashback").unwrap(), "status"), "none");
    assert_eq!(text(r.get("roundUp").unwrap(), "status"), "none");
    let p = r.get("partner").unwrap();
    assert_eq!(
        text(p, "captureRef"),
        format!("TEST-card-partner:{}", key("capture", &auth))
    );
    assert_eq!(
        text(p, "releaseRef"),
        format!("TEST-card-partner:{}", key("release", &auth))
    );
    let f = p.get("figures").unwrap();
    assert_eq!((text(f, "available"), text(f, "held")), pair("70", "0"));
    ledger_untouched(&k);
    assert_eq!(
        capture(&k, &c, "jb14-capture", "30").code(),
        "bank.card_authorization_closed"
    );
    assert_eq!(figures(&k, &c), pair("70", "0"));
}

#[test]
fn planted_earned_once_at_the_rank_tier_handed_to_the_rewards_programme_once_and_the_ledger_posts_nothing()
 {
    let Some(k) = held_with_cashback() else {
        return;
    };
    let c = usdc(&k);
    let auth = id(&authorize(&k, &c, "jb13-cb", "40").ok());
    let r = capture(&k, &c, "jb13-cb", "30").ok();
    // 30 USDC at metal's 2%: 0.6 USDC, owed, handed over; the custodial reward key was never used.
    assert_eq!(
        r.get("cashback").unwrap().compact(),
        r#"{"status":"owed","amount":"0.6"}"#
    );
    ledger_untouched(&k);
    let sent = k.bus.sent();
    assert_eq!(sent.len(), 1);
    let (subject, msg_key, envelope) = &sent[0];
    let e = envelope.get("payload").unwrap();
    assert_eq!(subject, "intafaced.bank.card_cashback.earned");
    assert_eq!(msg_key, &format!("bank.card_cashback:{auth}"));
    for (field, want) in [
        ("authorizationId", auth.as_str()),
        ("cardId", c.as_str()),
        ("userId", HOLDER),
        ("spend", "30"),
        ("cashback", "0.6"),
        ("assetId", "USDC"),
        ("tier", "metal"),
        ("rateBps", "200"),
    ] {
        assert_eq!(text(e, field), want, "{field} in {}", e.compact());
    }
    let rec = row(
        &k,
        &format!(
            "SELECT paid_by, status::text, ledger_tx_id, (announced_at IS NOT NULL)::text FROM bank.card_cashback \
              WHERE authorization_id = '{auth}'"
        ),
    );
    assert_eq!(
        (
            rec[0].as_deref(),
            rec[1].as_deref(),
            rec[2].as_deref(),
            rec[3].as_deref()
        ),
        (Some("wallet"), Some("pending"), None, Some("true"))
    );
    // Never spendable here: the summary keeps it out of `paid` and names it owed to the wallet.
    let summary = call(&k, HOLDER, CUSTOMER, "cards.cashback", &Json::Null).ok();
    assert_eq!(text(&summary, "tier"), "metal");
    assert_eq!(text(&summary, "rateBps"), "200");
    assert_eq!(text(&summary, "paid"), "0");
    assert_eq!(text(&summary, "unpaid"), "0");
    assert_eq!(text(&summary, "toWallet"), "0.6");
    // A resume hands nothing over twice and posts nothing.
    resume(&k, &c, "jb13-cb").ok();
    assert_eq!(k.bus.sent().len(), 1);
    ledger_untouched(&k);
}

#[test]
fn a_hand_over_the_bus_did_not_take_waits_named_and_a_resume_sends_the_same_record_once() {
    let Some(k) = held_with_cashback() else {
        return;
    };
    let c = usdc(&k);
    let auth = id(&authorize(&k, &c, "jb13-cb-lost", "10").ok());
    k.bus.down(true);
    let r = capture(&k, &c, "jb13-cb-lost", "10").ok();
    assert_eq!(text(&r, "captured"), "10");
    assert_eq!(
        r.get("cashback").unwrap().compact(),
        r#"{"status":"owed","amount":"0.2","reason":"bank.cashback_announce_failed"}"#
    );
    k.bus.down(false);
    resume(&k, &c, "jb13-cb-lost").ok();
    resume(&k, &c, "jb13-cb-lost").ok();
    let sent = k.bus.sent();
    assert_eq!(sent.len(), 1);
    let e = sent[0].2.get("payload").unwrap();
    assert_eq!(text(e, "authorizationId"), auth);
    assert_eq!(text(e, "cashback"), "0.2");
    assert_eq!(text(e, "tier"), "metal");
    ledger_untouched(&k);
}

#[test]
fn a_wallet_row_can_never_be_settled_or_name_a_ledger_transaction_the_table_refuses_it() {
    let Some(k) = held_with_cashback() else {
        return;
    };
    let c = usdc(&k);
    let auth = id(&authorize(&k, &c, "jb13-cb-ck", "10").ok());
    capture(&k, &c, "jb13-cb-ck", "10").ok();
    let err = k
        .db
        .client()
        .execute(
            "UPDATE bank.card_cashback SET status = 'settled', ledger_tx_id = 'planted' WHERE authorization_id = $1::text::uuid",
            &[&auth],
        )
        .unwrap_err();
    assert!(
        format!("{err:?}").contains("card_cashback_paid_by_ck"),
        "{err:?}"
    );
}

#[test]
fn a_capture_above_the_authorised_amount_is_refused_by_the_partner_and_one_within_it_then_captures()
{
    let Some(k) = held() else { return };
    let c = usdc(&k);
    let auth = id(&authorize(&k, &c, "jb14-over", "40").ok());
    assert_eq!(
        capture(&k, &c, "jb14-over", "40.01").code(),
        "bank.card_partner_capture_exceeds_hold"
    );
    assert_eq!(
        settlements(&k, &auth),
        vec![(
            0,
            "capture".to_owned(),
            "rejected".to_owned(),
            Some("bank.card_partner_capture_exceeds_hold".to_owned())
        )]
    );
    assert_eq!(figures(&k, &c), pair("60", "40"));
    let ok = capture(&k, &c, "jb14-over", "40").ok();
    assert_eq!(text(&ok, "captured"), "40");
    assert_eq!(text(&ok, "returned"), "0");
    assert_eq!(text(ok.get("partner").unwrap(), "releaseRef"), "null");
    ledger_untouched(&k);
}

#[test]
fn releases_on_our_instruction_once() {
    let Some(k) = held() else { return };
    let c = usdc(&k);
    authorize(&k, &c, "jb14-void", "40").ok();
    let r = reverse(&k, &c, "jb14-void").ok();
    assert_eq!(text(&r, "returned"), "40");
    assert_eq!(text(&r, "ledgerTxId"), "null");
    let p = r.get("partner").unwrap();
    assert_eq!(text(p, "by"), "instruction");
    let f = p.get("figures").unwrap();
    assert_eq!((text(f, "available"), text(f, "held")), pair("100", "0"));
    assert_eq!(
        reverse(&k, &c, "jb14-void").code(),
        "bank.card_authorization_closed"
    );
    ledger_untouched(&k);
}

#[test]
fn an_uncaptured_hold_is_given_back_by_the_partner_after_its_hold_time_as_the_partner_reports_and_recorded_once()
 {
    let Some(k) = held() else { return };
    let c = usdc(&k);
    authorize(&k, &c, "jb14-expire", "40").ok();
    partner_set(&k, HOLDER, &[("cardHold", "expired")]);
    let v = view(&k, &c);
    let Some(Json::Array(rows)) = v.get("authorizations") else {
        panic!("{}", v.compact())
    };
    let report = rows[0].get("report").unwrap();
    assert_eq!(
        (
            text(report, "status"),
            text(report, "released"),
            text(report, "open")
        ),
        ("expired".to_owned(), "40".to_owned(), "0".to_owned())
    );
    let f = v.get("figures").unwrap();
    assert_eq!((text(f, "available"), text(f, "held")), pair("100", "0"));
    // A capture after expiry is the partner's no.
    assert_eq!(
        capture(&k, &c, "jb14-expire", "1").code(),
        "bank.card_partner_hold_closed"
    );
    // Recording the expiry: the partner's answer says it was its own hold time, not our instruction.
    let recorded = reverse(&k, &c, "jb14-expire").ok();
    assert_eq!(text(&recorded, "returned"), "40");
    assert_eq!(text(&recorded, "ledgerTxId"), "null");
    assert_eq!(text(recorded.get("partner").unwrap(), "by"), "expiry");
    ledger_untouched(&k);
}

#[test]
fn a_merchant_refund_is_the_partners_once_per_authorisation_never_above_what_was_captured() {
    let Some(k) = held() else { return };
    let c = usdc(&k);
    let auth = id(&authorize(&k, &c, "jb14-refund", "40").ok());
    assert_eq!(
        refund(&k, &c, "jb14-refund", "5").code(),
        "bank.card_refund_nothing_captured"
    );
    capture(&k, &c, "jb14-refund", "40").ok();
    assert_eq!(
        refund(&k, &c, "jb14-refund", "41").code(),
        "bank.card_partner_refund_exceeds_capture"
    );
    let r = refund(&k, &c, "jb14-refund", "15").ok();
    assert_eq!(text(&r, "refunded"), "15");
    assert_eq!(
        text(&r, "partnerRef"),
        format!("TEST-card-partner:{}", key("refund", &auth))
    );
    let f = r.get("figures").unwrap();
    assert_eq!((text(f, "available"), text(f, "held")), pair("75", "0"));
    let again = refund(&k, &c, "jb14-refund", "15").ok();
    assert_eq!(text(&again, "partnerRef"), text(&r, "partnerRef"));
    assert_eq!(figures(&k, &c).0, "75");
    assert_eq!(
        refund(&k, &c, "jb14-refund", "10").code(),
        "bank.card_refund_amount_conflict"
    );
    ledger_untouched(&k);
}

#[test]
fn a_capture_whose_reply_was_lost_is_re_sent_under_the_same_key_once() {
    let Some(k) = held() else { return };
    let c = usdc(&k);
    let auth = id(&authorize(&k, &c, "jb14-resume", "40").ok());
    // The partner captured; its reply never came back.
    k.door
        .cards_deps(now(), |d| {
            book(d)
                .unwrap()
                .capture(&key("capture", &auth), &key("hold", &auth), "40")
        })
        .unwrap();
    assert_eq!(figures(&k, &c), pair("60", "0"));
    let r = capture(&k, &c, "jb14-resume", "40").ok();
    assert_eq!(text(&r, "captured"), "40");
    let resumed = resume(&k, &c, "jb14-resume").ok();
    assert_eq!(resumed.get("resumed"), Some(&Json::Array(Vec::new())));
    assert_eq!(text(&resumed, "held"), "0");
    let state = hold_state(&k, &auth).unwrap();
    assert_eq!(
        (text(&state, "status"), text(&state, "captured")),
        ("captured".to_owned(), "40".to_owned())
    );
    assert_eq!(figures(&k, &c), pair("60", "0"));
    ledger_untouched(&k);
}

#[test]
fn wallet_pull_the_card_pulls_from_the_persons_own_wallet_as_the_partner_answers_test_and_intafaced_holds_nothing()
 {
    let Some(k) = door(usdc_terms("wallet_pull"), true, Settings::default(), None) else {
        return;
    };
    partner_set(&k, HOLDER, &[("custody", "off")]);
    let c = usdc(&k);
    let a = authorize(&k, &c, "jb14-wallet", "20").ok();
    assert_eq!(text(&a, "decision"), "approved");
    let r = auth_row(&k, "jb14-wallet");
    assert_eq!(
        (r[2].as_deref(), r[4].as_deref()),
        (Some("partner"), Some("wallet_pull"))
    );
    let v = view(&k, &c);
    let f = v.get("figures").unwrap();
    assert_eq!(
        (text(f, "test"), text(f, "mode")),
        ("true".to_owned(), "wallet_pull".to_owned())
    );
    let Some(Json::Array(rows)) = v.get("authorizations") else {
        panic!("{}", v.compact())
    };
    let report = rows[0].get("report").unwrap();
    assert_eq!(
        (
            text(report, "test"),
            text(report, "mode"),
            text(report, "status")
        ),
        (
            "true".to_owned(),
            "wallet_pull".to_owned(),
            "held".to_owned()
        )
    );
    ledger_untouched(&k);
}

#[test]
fn resume_settlements_does_not_re_send_a_capture_the_partner_refused() {
    let Some(k) = held() else { return };
    let c = usdc(&k);
    authorize(&k, &c, "jb14-noresend", "40").ok();
    assert_eq!(
        capture(&k, &c, "jb14-noresend", "41").code(),
        "bank.card_partner_capture_exceeds_hold"
    );
    let r = resume(&k, &c, "jb14-noresend").ok();
    assert_eq!(r.get("resumed"), Some(&Json::Array(Vec::new())));
    assert_eq!(text(&r, "held"), "40");
}

#[test]
fn on_a_converted_card_the_merchants_own_ceiling_is_kept_before_the_partner_is_asked() {
    let terms = PartnerTerms {
        balances: Some(vec![
            ("USDC".to_owned(), "100".to_owned()),
            ("BTC".to_owned(), "1".to_owned()),
        ]),
        ..usdc_terms("partner_holds")
    };
    let Some(k) = door(terms, true, Settings::default(), None) else {
        return;
    };
    partner_set(&k, HOLDER, &[("custody", "off")]);
    k.rates
        .set("50000", 0, svc_bank::loans::prices::MarkQuality::Mid);
    let c = issue(
        &k,
        CardAsk {
            asset: Some("BTC"),
            settlement: Some("USDT"),
            limit: Some("1"),
            ..CardAsk::default()
        },
    );
    let a = authorize(&k, &c, "jb14-fx", "100").ok();
    assert_eq!(text(&a, "decision"), "approved");
    assert_eq!(auth_row(&k, "jb14-fx")[2].as_deref(), Some("partner"));
    let auth = id(&a);
    assert_eq!(
        capture(&k, &c, "jb14-fx", "100.000001").code(),
        "bank.card_capture_exceeds_authorization"
    );
    assert_eq!(
        count(
            &k,
            &format!(
                "SELECT count(*) FROM bank.card_settlements WHERE authorization_id = '{auth}'"
            )
        ),
        0
    );
    let done = capture(&k, &c, "jb14-fx", "100").ok();
    assert_eq!(text(&done, "heldBy"), "partner");
    assert_eq!(text(&done, "captured"), text(&a, "amount"));
    assert_eq!(text(&done, "returned"), "0");
    ledger_untouched(&k);
}

#[test]
fn a_stolen_card_is_closed_and_replaced_and_its_open_partner_hold_released() {
    let Some(k) = held() else { return };
    let c = usdc(&k);
    let auth = id(&authorize(&k, &c, "jb14-stolen", "10").ok());
    let replacement = uuid();
    let r = call(
        &k,
        HOLDER,
        CUSTOMER,
        "cards.replace",
        &Json::obj([
            ("cardId", Json::str(c.clone())),
            ("replacementId", Json::str(replacement)),
            ("reason", Json::str("stolen")),
        ]),
    );
    assert_eq!(r.0, 200, "{}", r.1.compact());
    assert_eq!(
        row(
            &k,
            &format!("SELECT status::text FROM bank.cards WHERE id = '{c}'")
        )[0]
        .as_deref(),
        Some("closed")
    );
    assert_eq!(
        settlements(&k, &auth),
        vec![(0, "reversal".to_owned(), "settled".to_owned(), None)]
    );
    assert_eq!(figures_of_user(&k), pair("100", "0"));
    ledger_untouched(&k);
}

/// The partner's figures for the holder's USDC, read from its book (a closed card has no view of its own).
fn figures_of_user(k: &Kit) -> (String, String) {
    let f = k
        .door
        .cards_deps(now(), |d| book(d).unwrap().figures(HOLDER, "USDC"))
        .unwrap()
        .json();
    (text(&f, "available"), text(&f, "held"))
}

#[test]
fn a_refund_replayed_returns_the_partners_reference_and_no_figures_it_did_not_read() {
    let Some(k) = held() else { return };
    let c = usdc(&k);
    authorize(&k, &c, "jb14-replay", "10").ok();
    capture(&k, &c, "jb14-replay", "10").ok();
    let first = refund(&k, &c, "jb14-replay", "4").ok();
    assert_eq!(text(first.get("figures").unwrap(), "available"), "94");
    let replay = refund(&k, &c, "jb14-replay", "4").ok();
    assert_eq!(text(&replay, "partnerRef"), text(&first, "partnerRef"));
    assert_eq!(replay.get("figures"), Some(&Json::Null));
}

#[test]
fn the_down_migration_refuses_changing_nothing_while_a_partner_held_row_exists() {
    let Some(k) = held() else { return };
    let c = usdc(&k);
    authorize(&k, &c, "jb14-down", "10").ok();
    let down = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/migrations/20261108231000_card_partner_held.down.sql"
    ))
    .unwrap();
    let err = k.db.client().batch_execute(&down).unwrap_err();
    assert!(
        format!("{err:?}").contains("partner-held card rows exist"),
        "{err:?}"
    );
    assert_eq!(auth_row(&k, "jb14-down")[2].as_deref(), Some("partner"));
}

#[test]
fn a_partner_that_has_not_said_its_mode_or_reports_no_balance_refuses_before_anything_is_written() {
    let terms = PartnerTerms {
        custody_mode: None,
        ..usdc_terms("partner_holds")
    };
    let Some(k) = door(terms, true, Settings::default(), None) else {
        return;
    };
    partner_set(&k, HOLDER, &[("custody", "off")]);
    let c = usdc(&k);
    assert_eq!(
        authorize(&k, &c, "jb14-mode", "1").code(),
        "bank.card_partner_mode_not_known"
    );
    let Some(k) = held() else { return };
    let btc = issue(
        &k,
        CardAsk {
            asset: Some("BTC"),
            ..CardAsk::default()
        },
    );
    let a = authorize(&k, &btc, "jb14-btc", "1");
    assert_eq!(a.code(), "bank.card_partner_balance_not_known");
    assert_eq!(
        a.message(),
        "The card partner reports no BTC balance, so nothing can be held. It spends from USDC; a card in one of those can be held. Nothing was decided."
    );
    assert_eq!(
        count(&k, "SELECT count(*) FROM bank.card_authorizations"),
        0
    );
}

// ── Custody switch unset: the custodial layer, exactly as before ─────────

#[test]
fn holds_captures_and_reverses_in_the_ledger_under_the_custodial_keys() {
    let Some(k) = door(usdc_terms("partner_holds"), true, Settings::default(), None) else {
        return;
    };
    k.ledger.fund(HOLDER, "USDC", "100");
    let c = usdc(&k);
    let auth = id(&authorize(&k, &c, "later-1", "40").ok());
    let r = auth_row(&k, "later-1");
    assert_eq!(
        (r[2].as_deref(), r[3].as_deref(), r[4].as_deref()),
        (Some("ledger"), None, None)
    );
    assert_eq!(r[6], k.ledger.tx_id(&format!("withdraw.hold:{auth}")));
    let cap = capture(&k, &c, "later-1", "30").ok();
    assert_eq!(text(&cap, "heldBy"), "ledger");
    assert_eq!(cap.get("partner"), Some(&Json::Null));
    assert_eq!(
        Some(text(&cap, "captureLedgerTxId")),
        k.ledger.tx_id(&format!("withdraw.settle:{auth}"))
    );
    assert_eq!(k.ledger.available(HOLDER, "USDC"), "70");
    // The partner was never asked.
    assert_eq!(hold_state(&k, &auth), None);
    assert_eq!(figures_of_user(&k), pair("100", "0"));
}

#[test]
fn an_authorisation_held_in_the_ledger_stays_in_the_ledger_when_the_switch_is_flipped_later() {
    let Some(k) = door(usdc_terms("partner_holds"), true, Settings::default(), None) else {
        return;
    };
    k.ledger.fund(HOLDER, "USDC", "100");
    let c = usdc(&k);
    let auth = id(&authorize(&k, &c, "later-flip", "40").ok());
    partner_set(&k, HOLDER, &[("custody", "off")]);
    let released = reverse(&k, &c, "later-flip").ok();
    assert_eq!(
        Some(text(&released, "ledgerTxId")),
        k.ledger.tx_id(&format!("withdraw.reverse:{auth}"))
    );
    assert_eq!(hold_state(&k, &auth), None);
}

#[test]
fn a_refund_on_a_ledger_held_card_is_not_built_and_says_so() {
    let Some(k) = door(usdc_terms("partner_holds"), true, Settings::default(), None) else {
        return;
    };
    k.ledger.fund(HOLDER, "USDC", "100");
    let c = usdc(&k);
    authorize(&k, &c, "later-refund", "40").ok();
    capture(&k, &c, "later-refund", "40").ok();
    assert_eq!(
        refund(&k, &c, "later-refund", "1").code(),
        "bank.card_refund_not_built"
    );
}

// ── The custodial layer off and no partner set ───────────────────────────

#[test]
fn refuses_bank_partner_unset_before_anything_is_written_rather_than_meeting_the_ledgers_raw_refusal()
 {
    let Some(k) = door(
        usdc_terms("partner_holds"),
        false,
        Settings::default(),
        None,
    ) else {
        return;
    };
    let c = usdc(&k);
    assert_eq!(
        authorize(&k, &c, "no-partner", "1").code(),
        "bank.partner_unset"
    );
    assert_eq!(
        count(&k, "SELECT count(*) FROM bank.card_authorizations"),
        0
    );
    ledger_untouched(&k);
}

#[test]
fn a_person_with_the_test_switch_off_is_still_partner_held_with_the_layer_off() {
    let Some(k) = door(
        usdc_terms("partner_holds"),
        false,
        Settings::default(),
        None,
    ) else {
        return;
    };
    partner_set(&k, HOLDER, &[("custody", "off")]);
    let c = usdc(&k);
    let a = authorize(&k, &c, "off-partner", "5").ok();
    assert_eq!(text(&a, "decision"), "approved");
    assert_eq!(auth_row(&k, "off-partner")[2].as_deref(), Some("partner"));
    ledger_untouched(&k);
}

// ── svc-ledger's posting freeze on partner card money ────────────────────

#[test]
fn planted_frozen_a_hold_is_a_decline_naming_the_freeze_and_the_partner_holds_nothing() {
    let Some(k) = held() else { return };
    let c = usdc(&k);
    k.posting.freeze(true);
    let a = authorize(&k, &c, "freeze-hold", "40").ok();
    assert_eq!(text(&a, "decision"), "declined");
    assert_eq!(text(&a, "declineCode"), "bank.posting_frozen");
    let r = auth_row(&k, "freeze-hold");
    assert_eq!(
        (r[1].as_deref(), r[2].as_deref()),
        (Some("rejected"), Some("partner"))
    );
    assert_eq!(hold_state(&k, &id(&a)), None);
    assert_eq!(figures(&k, &c), pair("100", "0"));
    ledger_untouched(&k);
}

#[test]
fn frozen_a_capture_and_its_release_stay_pending_never_rejected_and_resume_settlements_re_sends_them_under_the_same_keys_once_posting_is_back()
 {
    let Some(k) = held() else { return };
    let c = usdc(&k);
    let auth = id(&authorize(&k, &c, "freeze-capture", "40").ok());
    k.posting.freeze(true);
    assert_eq!(
        capture(&k, &c, "freeze-capture", "30").code(),
        "bank.posting_frozen"
    );
    assert_eq!(
        settlements(&k, &auth),
        vec![(0, "capture".to_owned(), "pending".to_owned(), None)]
    );
    let state = hold_state(&k, &auth).unwrap();
    assert_eq!(
        (text(&state, "status"), text(&state, "open")),
        ("held".to_owned(), "40".to_owned())
    );
    // Still frozen: the re-send is refused again, and the claim is still pending.
    let still = resume(&k, &c, "freeze-capture").ok();
    let Some(Json::Array(rows)) = still.get("resumed") else {
        panic!("{}", still.compact())
    };
    assert_eq!(
        (text(&rows[0], "sequence"), text(&rows[0], "outcome")),
        ("0".to_owned(), "failed".to_owned())
    );
    assert_eq!(
        settlements(&k, &auth),
        vec![(0, "capture".to_owned(), "pending".to_owned(), None)]
    );
    k.posting.freeze(false);
    let resumed = resume(&k, &c, "freeze-capture").ok();
    let Some(Json::Array(rows)) = resumed.get("resumed") else {
        panic!("{}", resumed.compact())
    };
    assert_eq!(
        (
            text(&rows[0], "sequence"),
            text(&rows[0], "kind"),
            text(&rows[0], "outcome")
        ),
        ("0".to_owned(), "capture".to_owned(), "settled".to_owned())
    );
    let state = hold_state(&k, &auth).unwrap();
    assert_eq!(
        (text(&state, "status"), text(&state, "captured")),
        ("captured".to_owned(), "30".to_owned())
    );
    ledger_untouched(&k);
}

#[test]
fn frozen_a_release_stays_pending_and_is_re_sent_under_the_same_key_once() {
    let Some(k) = held() else { return };
    let c = usdc(&k);
    let auth = id(&authorize(&k, &c, "freeze-release", "40").ok());
    k.posting.freeze(true);
    assert_eq!(
        reverse(&k, &c, "freeze-release").code(),
        "bank.posting_frozen"
    );
    assert_eq!(
        settlements(&k, &auth),
        vec![(0, "reversal".to_owned(), "pending".to_owned(), None)]
    );
    k.posting.freeze(false);
    reverse(&k, &c, "freeze-release").ok();
    assert_eq!(
        settlements(&k, &auth),
        vec![(0, "reversal".to_owned(), "settled".to_owned(), None)]
    );
    assert_eq!(figures(&k, &c), pair("100", "0"));
}

#[test]
fn frozen_a_merchant_refund_stays_pending_not_rejected_and_the_same_ask_refunds_once_posting_is_back()
 {
    let Some(k) = held() else { return };
    let c = usdc(&k);
    let auth = id(&authorize(&k, &c, "freeze-refund", "40").ok());
    capture(&k, &c, "freeze-refund", "40").ok();
    k.posting.freeze(true);
    assert_eq!(
        refund(&k, &c, "freeze-refund", "10").code(),
        "bank.posting_frozen"
    );
    let refunds = row(
        &k,
        &format!(
            "SELECT status::text, rejection_code FROM bank.card_partner_refunds WHERE authorization_id = '{auth}'"
        ),
    );
    assert_eq!(
        (refunds[0].as_deref(), refunds[1].as_deref()),
        (Some("pending"), None)
    );
    // A different amount while the first is pending is a conflict, not a fresh ask.
    k.posting.freeze(false);
    assert_eq!(
        refund(&k, &c, "freeze-refund", "5").code(),
        "bank.card_refund_amount_conflict"
    );
    let r = refund(&k, &c, "freeze-refund", "10").ok();
    assert_eq!(text(&r, "refunded"), "10");
    assert_eq!(figures(&k, &c).0, "70");
    ledger_untouched(&k);
}

#[test]
fn frozen_reads_stay_open_figures_and_the_partner_held_view() {
    let Some(k) = held() else { return };
    let c = usdc(&k);
    authorize(&k, &c, "freeze-read", "40").ok();
    k.posting.freeze(true);
    let v = view(&k, &c);
    assert_eq!(text(&v, "heldBy"), "partner");
    let f = v.get("figures").unwrap();
    assert_eq!((text(f, "available"), text(f, "held")), pair("60", "40"));
    let Some(Json::Array(rows)) = v.get("authorizations") else {
        panic!("{}", v.compact())
    };
    assert_eq!(text(rows[0].get("report").unwrap(), "status"), "held");
}

// ── The operator's partner stop on partner card money ────────────────────

#[test]
fn planted_with_posting_enabled_a_stopped_hold_is_a_decline_naming_the_stop_and_the_partner_holds_nothing()
 {
    let Some(k) = held() else { return };
    let c = usdc(&k);
    stop(&k, &["card_hold"]);
    let a = authorize(&k, &c, "stop-hold", "40").ok();
    assert_eq!(text(&a, "decision"), "declined");
    assert_eq!(text(&a, "declineCode"), "bank.partner_stopped");
    let r = auth_row(&k, "stop-hold");
    assert_eq!(
        (r[1].as_deref(), r[2].as_deref()),
        (Some("rejected"), Some("partner"))
    );
    assert_eq!(hold_state(&k, &id(&a)), None);
    assert_eq!(figures(&k, &c), pair("100", "0"));
    ledger_untouched(&k);
}

#[test]
fn a_stopped_capture_stays_pending_never_rejected_while_holds_stay_open_lifted_resume_settlements_captures_once()
 {
    let Some(k) = held() else { return };
    let c = usdc(&k);
    let auth = id(&authorize(&k, &c, "stop-capture", "40").ok());
    stop(&k, &["card_capture"]);
    assert_eq!(
        capture(&k, &c, "stop-capture", "30").code(),
        "bank.partner_stopped"
    );
    assert_eq!(
        settlements(&k, &auth),
        vec![(0, "capture".to_owned(), "pending".to_owned(), None)]
    );
    // Only the capture is stopped: a new hold is still made.
    let other = authorize(&k, &c, "stop-capture-other", "10").ok();
    assert_eq!(text(&other, "decision"), "approved");
    stop(&k, &[]);
    let resumed = resume(&k, &c, "stop-capture").ok();
    let Some(Json::Array(rows)) = resumed.get("resumed") else {
        panic!("{}", resumed.compact())
    };
    assert_eq!(
        (text(&rows[0], "kind"), text(&rows[0], "outcome")),
        ("capture".to_owned(), "settled".to_owned())
    );
    let state = hold_state(&k, &auth).unwrap();
    assert_eq!(
        (text(&state, "status"), text(&state, "captured")),
        ("captured".to_owned(), "30".to_owned())
    );
    ledger_untouched(&k);
}

#[test]
fn a_stopped_release_or_refund_stays_pending_under_its_key_and_is_made_once_after_the_stop_is_lifted()
 {
    let Some(k) = held() else { return };
    let c = usdc(&k);
    authorize(&k, &c, "stop-release", "20").ok();
    let refund_auth = id(&authorize(&k, &c, "stop-refund", "40").ok());
    capture(&k, &c, "stop-refund", "40").ok();
    stop(&k, &["card_release", "card_refund"]);
    assert_eq!(
        reverse(&k, &c, "stop-release").code(),
        "bank.partner_stopped"
    );
    assert_eq!(
        refund(&k, &c, "stop-refund", "10").code(),
        "bank.partner_stopped"
    );
    assert_eq!(
        row(
            &k,
            &format!(
                "SELECT status::text FROM bank.card_partner_refunds WHERE authorization_id = '{refund_auth}'"
            )
        )[0]
        .as_deref(),
        Some("pending")
    );
    stop(&k, &[]);
    reverse(&k, &c, "stop-release").ok();
    assert_eq!(
        text(&refund(&k, &c, "stop-refund", "10").ok(), "refunded"),
        "10"
    );
    assert_eq!(figures(&k, &c), pair("70", "0"));
}

#[test]
fn the_desk_counts_card_authorisations_and_card_instructions_refused_by_what_refused_them_and_why()
{
    let Some(k) = held() else { return };
    let c = usdc(&k);
    let a = authorize(&k, &c, "count-capture", "40").ok();
    k.posting.freeze(true);
    authorize(&k, &c, "count-frozen-hold", "10").ok();
    k.posting.freeze(false);
    stop(&k, &["card_capture"]);
    capture(&k, &c, "count-capture", "30");
    let counts: Vec<(String, String, String, i64)> = k
        .db
        .client()
        .query(
            "SELECT refused_by, cause, kind, count FROM bank.partner_refusal_counts ORDER BY refused_by, kind",
            &[],
        )
        .unwrap()
        .iter()
        .map(|r| (r.get(0), r.get(1), r.get(2), r.get(3)))
        .collect();
    assert_eq!(
        counts,
        vec![
            (
                "partner_stop".to_owned(),
                "stopped".to_owned(),
                "card_capture".to_owned(),
                1
            ),
            (
                "posting_freeze".to_owned(),
                "person".to_owned(),
                "card_hold".to_owned(),
                1
            ),
        ]
    );
    assert_eq!(text(&a, "decision"), "approved");
}

#[test]
fn a_stop_state_that_cannot_be_read_declines_a_hold_before_the_partner_is_asked() {
    let Some(k) = held() else { return };
    let c = usdc(&k);
    k.db.client()
        .batch_execute("ALTER TABLE bank.partner_stops RENAME TO partner_stops_moved")
        .unwrap();
    let a = authorize(&k, &c, "stop-unreadable", "10");
    k.db.client()
        .batch_execute("ALTER TABLE bank.partner_stops_moved RENAME TO partner_stops")
        .unwrap();
    let a = a.ok();
    assert_eq!(text(&a, "decision"), "declined");
    assert_eq!(text(&a, "declineCode"), "bank.partner_stop_unreadable");
    assert_eq!(figures(&k, &c), pair("100", "0"));
}

// ── The doors a journey uses ─────────────────────────────────────────────

#[test]
fn test_partner_set_takes_custody_and_card_hold_partner_held_and_the_test_merchant_refund_read_and_move_only_at_the_partner()
 {
    let Some(k) = door(usdc_terms("partner_holds"), true, Settings::default(), None) else {
        return;
    };
    let set = call(
        &k,
        HOLDER,
        CUSTOMER,
        "testPartner.set",
        &Json::obj([("custody", Json::str("off"))]),
    )
    .ok();
    assert_eq!(
        (text(&set, "custody"), text(&set, "cardHold")),
        ("off".to_owned(), "live".to_owned())
    );
    let c = usdc(&k);
    let auth = id(&authorize(&k, &c, "door-1", "40").ok());
    capture(&k, &c, "door-1", "40").ok();
    let v = view(&k, &c);
    assert_eq!(text(&v, "heldBy"), "partner");
    let f = v.get("figures").unwrap();
    assert_eq!(
        (
            text(f, "test"),
            text(f, "assetId"),
            text(f, "available"),
            text(f, "held")
        ),
        (
            "true".to_owned(),
            "USDC".to_owned(),
            "60".to_owned(),
            "0".to_owned()
        )
    );
    let Some(Json::Array(rows)) = v.get("authorizations") else {
        panic!("{}", v.compact())
    };
    assert_eq!(text(&rows[0], "authorizationId"), auth);
    assert_eq!(text(&rows[0], "amount"), "40");
    let report = rows[0].get("report").unwrap();
    assert_eq!(
        (text(report, "status"), text(report, "captured")),
        ("captured".to_owned(), "40".to_owned())
    );
    let refunded = refund(&k, &c, "door-1", "10").ok();
    assert_eq!(text(&refunded, "refunded"), "10");
    assert_eq!(text(refunded.get("figures").unwrap(), "available"), "70");
    let listed = call(
        &k,
        HOLDER,
        CUSTOMER,
        "cards.authorizations",
        &Json::obj([("cardId", Json::str(c.clone())), ("limit", Json::int(10))]),
    )
    .ok();
    let Json::Array(listed) = listed else {
        panic!("{}", listed.compact())
    };
    assert_eq!(
        (text(&listed[0], "heldBy"), text(&listed[0], "decision")),
        ("partner".to_owned(), "approved".to_owned())
    );
    ledger_untouched(&k);
}

#[test]
fn j_bank_14_6_the_feed_lists_the_refund_on_its_payment_recurring_payments_group_by_merchant_and_an_unlisted_partner_code_is_kept_raw_the_ledger_posts_nothing()
 {
    let Some(k) = held() else { return };
    let c = usdc(&k);
    let pay = |reference: &str, amount: &str, merchant: Option<&str>, recurring: bool| {
        let mut extra = vec![("recurring", Json::Bool(recurring))];
        if let Some(m) = merchant {
            extra.push(("merchant", Json::str(m)));
        }
        authorize_with(&k, &c, reference, amount, &extra).ok()
    };
    pay("six-sub-1", "5", Some("TEST Stream"), true);
    pay("six-sub-2", "6", Some("TEST Stream"), true);
    pay("six-gym", "7", Some("TEST Gym"), true);
    pay("six-shop", "8", Some("TEST Stream"), false);
    // A redelivery of a recurring payment is the same decision, never a second payment in the group.
    pay("six-sub-2", "6", Some("TEST Stream"), true);
    let recurring = call(
        &k,
        HOLDER,
        CUSTOMER,
        "cards.recurring",
        &Json::obj([("cardId", Json::str(c.clone())), ("limit", Json::int(10))]),
    )
    .ok();
    let Json::Array(recurring) = recurring else {
        panic!("{}", recurring.compact())
    };
    let groups: Vec<(String, String, String)> = recurring
        .iter()
        .map(|r| {
            (
                text(r, "merchant"),
                text(r, "payments"),
                text(r, "lastAmount"),
            )
        })
        .collect();
    assert_eq!(
        groups,
        vec![
            ("TEST Gym".to_owned(), "1".to_owned(), "7".to_owned()),
            ("TEST Stream".to_owned(), "2".to_owned(), "6".to_owned()),
        ]
    );
    capture(&k, &c, "six-shop", "8").ok();
    refund(&k, &c, "six-shop", "3").ok();
    let feed = || {
        let f = call(
            &k,
            HOLDER,
            CUSTOMER,
            "cards.authorizations",
            &Json::obj([("cardId", Json::str(c.clone())), ("limit", Json::int(10))]),
        )
        .ok();
        let Json::Array(f) = f else {
            panic!("{}", f.compact())
        };
        f
    };
    let rows = feed();
    let find = |rows: &[Json], reference: &str| {
        rows.iter()
            .find(|r| text(r, "authorizationRef") == reference)
            .cloned()
            .unwrap()
    };
    let shop = find(&rows, "six-shop");
    assert_eq!(text(&shop, "recurring"), "false");
    let refund_row = shop.get("refund").unwrap();
    assert_eq!(
        (text(refund_row, "amount"), text(refund_row, "status")),
        ("3".to_owned(), "settled".to_owned())
    );
    let sub = find(&rows, "six-sub-1");
    assert_eq!(text(&sub, "recurring"), "true");
    assert_eq!(sub.get("refund"), Some(&Json::Null));

    partner_set(&k, HOLDER, &[("cardDecline", "unlisted")]);
    let declined = pay("six-unlisted", "1", None, false);
    assert_eq!(text(&declined, "decision"), "declined");
    assert_eq!(
        text(&declined, "declineCode"),
        "test_partner.unlisted_reason"
    );
    assert_eq!(auth_row(&k, "six-unlisted")[3], None);
    let unlisted = find(&feed(), "six-unlisted");
    assert_eq!(
        (text(&unlisted, "decision"), text(&unlisted, "declineCode")),
        (
            "declined".to_owned(),
            "test_partner.unlisted_reason".to_owned()
        )
    );
    ledger_untouched(&k);
}

#[test]
fn the_test_merchant_refund_refuses_off_the_test_stack() {
    let Some(k) = kit(Opts::default()) else {
        return;
    };
    let a = refund(&k, &uuid(), "door-2", "1");
    assert_eq!(a.code(), "bank.test_partner_off");
}

#[test]
fn currencies_remove_refuses_while_the_card_partner_holds_an_open_authorisation_in_that_asset() {
    let Some(k) = held() else { return };
    k.db.client()
        .execute(
            "INSERT INTO bank.spaces (user_id, asset_id, kind, name) VALUES ($1, 'USDC', 'primary', 'USDC')",
            &[&HOLDER],
        )
        .unwrap();
    let c = usdc(&k);
    let a = authorize(&k, &c, "jb01-card-hold-1", "40").ok();
    assert_eq!(text(&a, "decision"), "approved");
    assert_eq!(figures(&k, &c), pair("60", "40"));

    let removed = call(
        &k,
        HOLDER,
        CUSTOMER,
        "currencies.remove",
        &Json::obj([("assetId", Json::str("USDC"))]),
    );
    assert_eq!(removed.code(), "bank.currency_in_use");
}

// ── The TEST card draws on the person's own partner account (#10227, #10544) ──────
// partner-card-holds.test.ts, "the TEST card draws on the person's own partner account (#10227)".

/// The TEST partner's own main USDC account for the holder, or `None` when it holds none.
fn partner_main(k: &Kit) -> Option<String> {
    k.door
        .partner()
        .partner
        .as_ref()
        .unwrap()
        .lock()
        .card_available(HOLDER, "USDC")
        .map(service_kit::money::format_amount)
}

/// TEST money paid into the holder's main USDC account at the TEST partner, once per id.
fn fund_partner(k: &Kit, id: &str, amount: &str) {
    k.door
        .partner()
        .partner
        .as_ref()
        .unwrap()
        .lock()
        .fund(
            HOLDER,
            &svc_bank::partner::Funding {
                fund_id: id.to_owned(),
                asset_id: "USDC".to_owned(),
                amount: service_kit::money::parse_amount(amount).unwrap(),
            },
            now(),
        )
        .unwrap();
}

/// The holder's moves on the TEST partner's own record whose key starts with `card.partner.`: (key, from owner, to owner,
/// amount).
fn card_moves(k: &Kit) -> Vec<(String, String, String, String)> {
    k.door
        .partner()
        .partner
        .as_ref()
        .unwrap()
        .lock()
        .record(HOLDER)
        .moves
        .iter()
        .filter(|m| m.key.starts_with("card.partner."))
        .map(|m| {
            (
                m.key.clone(),
                m.from.user_id.clone(),
                m.to.user_id.clone(),
                service_kit::money::format_amount(m.amount),
            )
        })
        .collect()
}

fn quad(key: &str, from: &str, to: &str, amount: &str) -> (String, String, String, String) {
    (
        key.to_owned(),
        from.to_owned(),
        to.to_owned(),
        amount.to_owned(),
    )
}

#[test]
fn drawn_a_card_payment_lowers_the_partner_balance_the_person_reads_once_per_key_and_the_statement_counts_it()
 {
    let Some(k) = held() else { return };
    fund_partner(&k, "f-400", "400");
    let c = usdc(&k);
    // The card reads the partner account, never the TEST figure of 100.
    assert_eq!(figures(&k, &c), pair("400", "0"));
    let auth = id(&authorize(&k, &c, "drawn-1", "20").ok());
    assert_eq!(figures(&k, &c), pair("380", "20"));
    assert_eq!(partner_main(&k).as_deref(), Some("380"));
    // The same authorisation again moves nothing more at the partner.
    authorize(&k, &c, "drawn-1", "20").ok();
    assert_eq!(partner_main(&k).as_deref(), Some("380"));

    let r = capture(&k, &c, "drawn-1", "20").ok();
    assert_eq!(text(&r, "captured"), "20");
    assert_eq!(figures(&k, &c), pair("380", "0"));
    assert_eq!(partner_main(&k).as_deref(), Some("380"));

    refund(&k, &c, "drawn-1", "5").ok();
    refund(&k, &c, "drawn-1", "5").ok();
    assert_eq!(partner_main(&k).as_deref(), Some("385"));
    assert_eq!(figures(&k, &c), pair("385", "0"));

    // Each step the person's account takes part in is one move on their record at the partner, under the instruction's
    // key (J-derivatives-26 #8); the capture is between the partner's own two card accounts, so it is on neither.
    assert_eq!(
        card_moves(&k),
        vec![
            quad(&key("hold", &auth), HOLDER, "partner:card-holds", "20"),
            quad(&key("refund", &auth), "partner:card-network", HOLDER, "5"),
        ]
    );
    let partner = k.door.partner().partner.as_ref().unwrap().lock();
    let captured = partner.book.by_key(&key("capture", &auth)).unwrap();
    assert_eq!(
        (captured.from.user_id.as_str(), captured.to.user_id.as_str()),
        ("partner:card-holds", "partner:card-network")
    );
    // The card's own list is where a payment is read: no card move is a bank move, and none counts as a send.
    let q = svc_bank::partner::MovesQuery {
        limit: 50,
        before: None,
        asset_id: None,
        pay_ins: false,
    };
    assert!(partner.moves(HOLDER, &q).is_empty());
    assert_eq!(
        partner.limits(HOLDER, "USDC", now()).unwrap().used_today,
        service_kit::money::Amount::ZERO
    );
    let main = svc_bank::partner::AccountRef::main(HOLDER, "USDC");
    let st = partner
        .statement(
            &main,
            service_kit::time::Instant(0),
            service_kit::time::Instant(now().0 + 60_000),
            now(),
        )
        .unwrap();
    assert_eq!(
        (st.opening, service_kit::money::format_amount(st.closing)),
        (service_kit::money::Amount::ZERO, "385".to_owned())
    );
    drop(partner);
    ledger_untouched(&k);
}

#[test]
fn drawn_a_released_hold_and_a_hold_whose_time_ran_out_each_come_back_to_the_account_once() {
    let Some(k) = held() else { return };
    fund_partner(&k, "f-50", "50");
    let c = usdc(&k);
    let auth = id(&authorize(&k, &c, "drawn-release", "30").ok());
    assert_eq!(partner_main(&k).as_deref(), Some("20"));
    reverse(&k, &c, "drawn-release").ok();
    assert_eq!(partner_main(&k).as_deref(), Some("50"));
    // The release instruction again, under its key: the partner's first answer, and nothing more moves.
    let replay = k
        .door
        .cards_deps(now(), |d| {
            book(d)
                .unwrap()
                .release(&key("release", &auth), &key("hold", &auth))
        })
        .unwrap();
    assert_eq!(replay.amount, "30");
    assert_eq!(partner_main(&k).as_deref(), Some("50"));
    assert_eq!(figures(&k, &c), pair("50", "0"));
    assert_eq!(
        card_moves(&k),
        vec![
            quad(&key("hold", &auth), HOLDER, "partner:card-holds", "30"),
            quad(&key("release", &auth), "partner:card-holds", HOLDER, "30"),
        ]
    );

    let Some(k) = held() else { return };
    partner_set(&k, HOLDER, &[("cardHold", "expired")]);
    fund_partner(&k, "f-50", "50");
    let c = usdc(&k);
    let auth = id(&authorize(&k, &c, "drawn-expire", "30").ok());
    assert_eq!(figures(&k, &c), pair("50", "0"));
    assert_eq!(figures(&k, &c), pair("50", "0"));
    assert_eq!(text(&hold_state(&k, &auth).unwrap(), "status"), "expired");
    assert_eq!(partner_main(&k).as_deref(), Some("50"));
    let partner = k.door.partner().partner.as_ref().unwrap().lock();
    let back = partner
        .book
        .by_key(&format!("TEST-card-partner:{}:expired", key("hold", &auth)))
        .unwrap();
    assert_eq!(
        (
            back.from.user_id.as_str(),
            back.to.user_id.as_str(),
            service_kit::money::format_amount(back.amount)
        ),
        ("partner:card-holds", HOLDER, "30".to_owned())
    );
}

#[test]
fn drawn_above_what_the_account_holds_the_partner_declines_and_nothing_moves_an_empty_account_declines_too()
 {
    let Some(k) = held() else { return };
    k.door
        .partner()
        .partner
        .as_ref()
        .unwrap()
        .lock()
        .open_currency(HOLDER, "USDC", now())
        .unwrap();
    let c = usdc(&k);
    let a = authorize(&k, &c, "drawn-empty", "5").ok();
    assert_eq!(text(&a, "decision"), "declined");
    assert_eq!(
        text(&a, "declineCode"),
        "bank.card_partner_insufficient_funds"
    );
    assert_eq!(figures(&k, &c), pair("0", "0"));
    fund_partner(&k, "f-10", "10");
    let a = authorize(&k, &c, "drawn-short", "10.01").ok();
    assert_eq!(text(&a, "decision"), "declined");
    assert_eq!(partner_main(&k).as_deref(), Some("10"));
    assert!(card_moves(&k).is_empty());
}

#[test]
fn drawn_a_hold_by_the_persons_pay_from_order_draws_on_the_account_too() {
    let terms = PartnerTerms {
        rates: Some(svc_bank::cards::terms::PartnerRates {
            in_asset: "USDC".to_owned(),
            per_unit: Vec::new(),
        }),
        ..usdc_terms("partner_holds")
    };
    let Some(k) = door(terms, true, Settings::default(), None) else {
        return;
    };
    partner_set(&k, HOLDER, &[("custody", "off")]);
    fund_partner(&k, "f-100", "100");
    let answer = k
        .door
        .cards_deps(now(), |d| {
            book(d).unwrap().hold_in_order(
                "card.partner.hold:order-1",
                HOLDER,
                &["USDC".to_owned()],
                "USDC",
                "12.5",
            )
        })
        .unwrap();
    let svc_bank::cards::moves::partner_book::HoldAnswer::Approved { figures, .. } = answer else {
        panic!("declined: {answer:?}")
    };
    assert_eq!(
        (figures.available.as_deref(), figures.held.as_deref()),
        (Some("87.5"), Some("12.5"))
    );
    assert_eq!(partner_main(&k).as_deref(), Some("87.5"));
}

#[test]
fn drawn_with_no_account_at_the_partner_the_card_holds_from_the_test_figure_and_an_open_hold_goes_back_where_it_came_from()
 {
    let Some(k) = held() else { return };
    let c = usdc(&k);
    assert_eq!(figures(&k, &c), pair("100", "0"));
    authorize(&k, &c, "drawn-figure", "10").ok();
    // The account opens while the TEST figure's hold is open: the book keeps to the figure until it holds nothing.
    fund_partner(&k, "f-40", "40");
    assert_eq!(figures(&k, &c), pair("90", "10"));
    reverse(&k, &c, "drawn-figure").ok();
    assert_eq!(partner_main(&k).as_deref(), Some("40"));
    assert_eq!(figures(&k, &c), pair("40", "0"));
    assert!(card_moves(&k).is_empty());
}
