//! Slice `card-ops`' custodial path against the Rust door on a real Postgres: the authorisation, its hold, the capture,
//! the reversal, their recovery, cashback and the JIT conversion, each driven through `ops.cardAuthorize`,
//! `ops.cardCapture`, `ops.cardReverse`, `ops.cardResumeSettlement` and `ops.fundCashbackPot` with a founders' approval,
//! over the stand-in svc-ledger in `card_ops_kit` (the TypeScript tests' `MemoryLedger`). Every test is named after the
//! TypeScript test it ports, from `cards/cards.test.ts`' "svc-bank cards PG-hard › CardService".
//!
//! Where the TypeScript builds a second `CardService` over a ledger that fails one kind of post, the stand-in's switch
//! fails it (`Fail`); where it pauses a post mid-flight, the row it leaves (claimed, booked, still pending) is reached by
//! losing the post's reply. A "connected issuer" (`outside-issuer`, a seeded legacy row) pays cashback in the
//! TypeScript; no issuer but the simulator exists in this crate, so the paying card here is the simulator's with the
//! boot-guarded TEST switch (`BANK_CARD_SIM_CASHBACK=test`), which pays from the same pot and recipe.
//! `MemoryLedger.totalsByAsset()` reads 0 because its deposits draw on an outside account; the stand-in credits
//! balances directly, so the same invariant reads "the total is what was credited in".
//!
//! Not ported, with the reason: the issue, idempotent issue, no-issuer and reopen tests are slice `cards`' (ported in
//! `cards_core_db.rs`); "never returns one user's authorisations under another user's card id" is `cards.authorizations`,
//! slice `cards`; "hands the issuer adapter nothing it could move money with" and "keeps the hold when the issuer cannot
//! be told the answer" test an adapter object a caller hands in, and the Rust issuer port (`Issuer::respond_to_authorization`)
//! takes no argument and its answer is ignored by construction (`moves::tell_issuer`). The pure tests of the file
//! (cashback arithmetic, the simulator's flags, the conversion arithmetic, the empty rate source) are unit tests in
//! `cards::moves::{cashback, conversion}`, `cards::issuer` and `loans::prices`. Without `TEST_DATABASE_URL` each test
//! skips; with `REQUIRE_POSTGRES=1` it fails.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::too_many_lines,
    reason = "a test: a failure is the point"
)]

use crate::card_ops_kit::{
    CardAsk, Fail, HOLDER, Kit, Opts, amount_text, authorize, capture, count, fund_pot, issue, kit,
    resume, reverse, row, set_status, text,
};

use service_kit::json::Json;
use svc_bank::cards::Settings;
use svc_bank::loans::prices::MarkQuality;

fn plain() -> Option<Kit> {
    kit(Opts::default())
}

/// The simulator paying cashback (`BANK_CARD_SIM_CASHBACK=test`): the stand-in for a connected issuer.
fn paying() -> Option<Kit> {
    kit(Opts {
        settings: Settings {
            simulator_pays: true,
            ..Settings::default()
        },
        ..Opts::default()
    })
}

fn card(k: &Kit) -> String {
    issue(k, CardAsk::default())
}

fn id(a: &Json) -> String {
    text(a, "authorizationId")
}

/// The authorisation row: decision, status, hold tx, amount.
fn auth_row(k: &Kit, card: &str, reference: &str) -> Vec<Option<String>> {
    row(
        k,
        &format!(
            "SELECT decision::text, status::text, hold_ledger_tx_id, amount::text, id::text FROM bank.card_authorizations \
              WHERE card_id = '{card}' AND authorization_ref = '{reference}'"
        ),
    )
}

fn settlements(k: &Kit, auth: &str) -> Vec<(String, String, Option<String>)> {
    k.db.client()
        .query(
            &format!(
                "SELECT kind::text, status::text, ledger_tx_id FROM bank.card_settlements \
                  WHERE authorization_id = '{auth}' ORDER BY sequence"
            ),
            &[],
        )
        .unwrap()
        .iter()
        .map(|r| (r.get(0), r.get(1), r.get(2)))
        .collect()
}

fn pair(kind: &str, status: &str) -> (String, String) {
    (kind.to_owned(), status.to_owned())
}

fn kinds(rows: &[(String, String, Option<String>)]) -> Vec<(String, String)> {
    rows.iter().map(|r| (r.0.clone(), r.1.clone())).collect()
}

fn cashback_row(k: &Kit, auth: &str) -> Vec<Option<String>> {
    row(
        k,
        &format!(
            "SELECT status::text, rejection_code, amount::text, ledger_tx_id, rate_bps::text FROM bank.card_cashback \
              WHERE authorization_id = '{auth}'"
        ),
    )
}

// ── Authorise ────────────────────────────────────────────────────────────

#[test]
fn approves_against_a_real_ledger_balance_and_holds_the_funds_in_this_authorisations_own_account() {
    let Some(k) = plain() else { return };
    k.ledger.fund(HOLDER, "USDT", "500");
    let c = card(&k);
    let a = authorize(&k, &c, "auth-1", "120").ok();
    assert_eq!(text(&a, "decision"), "approved");
    assert_eq!(text(&a, "confirmOperatorId"), crate::card_ops_kit::APPROVER);
    let r = auth_row(&k, &c, "auth-1");
    assert_eq!(r[1].as_deref(), Some("settled"));
    assert!(r[2].is_some());
    assert_eq!(k.ledger.available(HOLDER, "USDT"), "380");
    assert_eq!(k.ledger.held(&id(&a), HOLDER, "USDT"), "120");
    assert_eq!(k.ledger.total("USDT"), "500");
    assert_eq!(k.desk.consumed(), 1);
}

#[test]
fn gives_every_authorisation_a_hold_account_of_its_own() {
    let Some(k) = plain() else { return };
    k.ledger.fund(HOLDER, "USDT", "500");
    let c = card(&k);
    let first = id(&authorize(&k, &c, "auth-1", "100").ok());
    let second = id(&authorize(&k, &c, "auth-2", "50").ok());
    assert_eq!(k.ledger.held(&first, HOLDER, "USDT"), "100");
    assert_eq!(k.ledger.held(&second, HOLDER, "USDT"), "50");
    assert_eq!(k.ledger.available(HOLDER, "USDT"), "350");
    capture(&k, &c, "auth-1", "100").ok();
    assert_eq!(k.ledger.held(&first, HOLDER, "USDT"), "0");
    assert_eq!(k.ledger.held(&second, HOLDER, "USDT"), "50");
}

#[test]
fn returns_the_first_decision_when_the_issuer_redelivers_and_does_not_hold_twice() {
    let Some(k) = plain() else { return };
    k.ledger.fund(HOLDER, "USDT", "500");
    let c = card(&k);
    let first = id(&authorize(&k, &c, "auth-1", "120").ok());
    let again = id(&authorize(&k, &c, "auth-1", "120").ok());
    assert_eq!(again, first);
    assert_eq!(k.ledger.available(HOLDER, "USDT"), "380");
    assert_eq!(k.ledger.held(&first, HOLDER, "USDT"), "120");
    assert_eq!(
        count(
            &k,
            &format!("SELECT count(*) FROM bank.card_authorizations WHERE card_id = '{c}'")
        ),
        1
    );
}

#[test]
fn declines_an_insufficient_balance_without_moving_anything_and_records_why() {
    let Some(k) = plain() else { return };
    k.ledger.fund(HOLDER, "USDT", "50");
    let c = card(&k);
    let a = authorize(&k, &c, "auth-1", "120").ok();
    assert_eq!(text(&a, "decision"), "declined");
    assert_eq!(text(&a, "declineCode"), "ledger.insufficient_funds");
    assert_eq!(auth_row(&k, &c, "auth-1")[2], None);
    assert_eq!(k.ledger.available(HOLDER, "USDT"), "50");
    assert_eq!(k.ledger.total("USDT"), "50");
}

#[test]
fn declines_on_a_frozen_card_and_the_freeze_is_what_a_user_reaches_for_first() {
    let Some(k) = plain() else { return };
    k.ledger.fund(HOLDER, "USDT", "500");
    let c = card(&k);
    set_status(&k, &c, "frozen");
    let a = authorize(&k, &c, "auth-1", "10").ok();
    assert_eq!(text(&a, "decision"), "declined");
    assert_eq!(text(&a, "declineCode"), "bank.card_not_active");
    assert_eq!(k.ledger.available(HOLDER, "USDT"), "500");
}

#[test]
fn declines_above_the_per_authorisation_ceiling() {
    let Some(k) = plain() else { return };
    k.ledger.fund(HOLDER, "USDT", "5000");
    let c = issue(
        &k,
        CardAsk {
            limit: Some("200"),
            ..CardAsk::default()
        },
    );
    let over = authorize(&k, &c, "auth-1", "200.000000000000000001").ok();
    assert_eq!(text(&over, "declineCode"), "bank.card_limit_exceeded");
    let on_the_line = authorize(&k, &c, "auth-2", "200").ok();
    assert_eq!(text(&on_the_line, "decision"), "approved");
}

#[test]
fn does_not_manufacture_a_decline_when_the_ledger_itself_is_unavailable() {
    let Some(k) = plain() else { return };
    k.ledger.fund(HOLDER, "USDT", "500");
    let c = card(&k);
    k.ledger.fail_on("", Fail::Unknown);
    let a = authorize(&k, &c, "auth-1", "10");
    assert_eq!(a.0, 500, "{}", a.1.compact());
    let r = auth_row(&k, &c, "auth-1");
    assert_eq!(
        (r[0].as_deref(), r[1].as_deref(), r[2].as_deref()),
        (Some("approved"), Some("pending"), None)
    );
    k.ledger.heal();
    // Re-driven at the stored amount, not the number this delivery arrived with.
    let redriven = authorize(&k, &c, "auth-1", "80").ok();
    assert_eq!(text(&redriven, "decision"), "approved");
    assert_eq!(text(&redriven, "amount"), "10");
    let r = auth_row(&k, &c, "auth-1");
    assert_eq!(r[1].as_deref(), Some("settled"));
    assert!(r[2].is_some());
    assert_eq!(k.ledger.held(&id(&redriven), HOLDER, "USDT"), "10");
    assert_eq!(k.ledger.available(HOLDER, "USDT"), "490");
}

#[test]
fn re_drives_an_approved_pending_hold_at_the_stored_amount_and_a_second_post_does_not_move_it_again()
 {
    let Some(k) = plain() else { return };
    k.ledger.fund(HOLDER, "USDT", "500");
    let c = card(&k);
    // The post lands; the row update does not (the reply is lost).
    k.ledger.fail_on("withdraw.hold:", Fail::LoseReplyOnce);
    assert_eq!(authorize(&k, &c, "auth-1", "10").0, 500);
    let r = auth_row(&k, &c, "auth-1");
    let auth = r[4].clone().unwrap();
    assert_eq!(amount_text(r[3].clone()), "10");
    assert_eq!(r[1].as_deref(), Some("pending"));
    let posted = k.ledger.tx_id(&format!("withdraw.hold:{auth}")).unwrap();
    let journal = k.ledger.journal_len();
    let redriven = authorize(&k, &c, "auth-1", "80").ok();
    assert_eq!(id(&redriven), auth);
    assert_eq!(text(&redriven, "amount"), "10");
    let r = auth_row(&k, &c, "auth-1");
    assert_eq!(r[1].as_deref(), Some("settled"));
    assert_eq!(r[2].as_deref(), Some(posted.as_str()));
    assert_eq!(k.ledger.journal_len(), journal);
    assert_eq!(k.ledger.held(&auth, HOLDER, "USDT"), "10");
    assert_eq!(k.ledger.available(HOLDER, "USDT"), "490");
    let hold = k.ledger.input_of(&format!("withdraw.hold:{auth}")).unwrap();
    assert_eq!(text(&hold, "withdrawalId"), auth);
    assert_eq!(text(&hold, "amount"), "10");
    authorize(&k, &c, "auth-1", "80").ok();
    assert_eq!(
        auth_row(&k, &c, "auth-1")[2].as_deref(),
        Some(posted.as_str())
    );
    assert_eq!(k.ledger.journal_len(), journal);
}

#[test]
fn returns_a_declined_authorisation_on_redelivery_and_does_not_hold() {
    let Some(k) = plain() else { return };
    k.ledger.fund(HOLDER, "USDT", "50");
    let c = card(&k);
    let first = authorize(&k, &c, "auth-1", "120").ok();
    let again = authorize(&k, &c, "auth-1", "1").ok();
    assert_eq!(id(&again), id(&first));
    assert_eq!(text(&again, "decision"), "declined");
    assert_eq!(text(&again, "declineCode"), "ledger.insufficient_funds");
    assert_eq!(auth_row(&k, &c, "auth-1")[1].as_deref(), Some("rejected"));
    assert_eq!(k.ledger.available(HOLDER, "USDT"), "50");
    assert_eq!(k.ledger.booked("withdraw.hold:"), 0);
}

#[test]
fn declines_a_re_driven_hold_when_the_ledger_answers_insufficient_funds() {
    let Some(k) = plain() else { return };
    k.ledger.fund(HOLDER, "USDT", "500");
    let c = card(&k);
    k.ledger.fail_on("withdraw.hold:", Fail::Unknown);
    assert_eq!(authorize(&k, &c, "auth-1", "10").0, 500);
    k.ledger.heal();
    // The balance is gone before the re-drive. The ledger's answer is the decline.
    authorize(&k, &c, "auth-other", "500").ok();
    let redriven = authorize(&k, &c, "auth-1", "10").ok();
    assert_eq!(text(&redriven, "decision"), "declined");
    assert_eq!(text(&redriven, "declineCode"), "ledger.insufficient_funds");
    let r = auth_row(&k, &c, "auth-1");
    assert_eq!((r[1].as_deref(), r[2].as_deref()), (Some("rejected"), None));
    assert_eq!(k.ledger.available(HOLDER, "USDT"), "0");
    assert_eq!(
        k.ledger.booked(&format!("withdraw.hold:{}", id(&redriven))),
        0
    );
    assert_eq!(k.ledger.total("USDT"), "500");
}

#[test]
fn leaves_the_pending_hold_and_throws_when_a_re_drive_cannot_reach_the_ledger() {
    let Some(k) = plain() else { return };
    k.ledger.fund(HOLDER, "USDT", "500");
    let c = card(&k);
    k.ledger.fail_on("withdraw.hold:", Fail::Unknown);
    assert_eq!(authorize(&k, &c, "auth-1", "10").0, 500);
    assert_eq!(authorize(&k, &c, "auth-1", "80").0, 500);
    let r = auth_row(&k, &c, "auth-1");
    assert_eq!(
        (r[0].as_deref(), r[1].as_deref(), r[2].as_deref()),
        (Some("approved"), Some("pending"), None)
    );
    assert_eq!(amount_text(r[3].clone()), "10");
    assert_eq!(k.ledger.available(HOLDER, "USDT"), "500");
    assert_eq!(k.ledger.booked("withdraw.hold:"), 0);
}

// ── Capture, reversal, and the hold that must end at zero ────────────────

#[test]
fn captures_the_full_amount_value_leaves_the_book_at_the_rail_boundary_and_the_hold_reads_zero() {
    let Some(k) = plain() else { return };
    k.ledger.fund(HOLDER, "USDT", "500");
    let c = card(&k);
    let auth = id(&authorize(&k, &c, "auth-1", "120").ok());
    let r = capture(&k, &c, "auth-1", "120").ok();
    assert_eq!(text(&r, "captured"), "120");
    assert_eq!(text(&r, "returned"), "0");
    assert_eq!(text(&r, "reversalLedgerTxId"), "null");
    assert_eq!(text(&r, "heldBy"), "ledger");
    assert_eq!(k.ledger.held(&auth, HOLDER, "USDT"), "0");
    assert_eq!(k.ledger.available(HOLDER, "USDT"), "380");
    assert_eq!(k.ledger.rail("card-sim", "USDT"), "120");
    assert_eq!(k.ledger.total("USDT"), "500");
}

#[test]
fn captures_part_of_an_authorisation_and_returns_the_remainder_in_the_same_pass() {
    let Some(k) = plain() else { return };
    k.ledger.fund(HOLDER, "USDT", "500");
    let c = card(&k);
    let auth = id(&authorize(&k, &c, "auth-1", "120").ok());
    let r = capture(&k, &c, "auth-1", "75.5").ok();
    assert_eq!(text(&r, "captured"), "75.5");
    assert_eq!(text(&r, "returned"), "44.5");
    assert_ne!(text(&r, "reversalLedgerTxId"), "null");
    assert_eq!(k.ledger.held(&auth, HOLDER, "USDT"), "0");
    assert_eq!(k.ledger.available(HOLDER, "USDT"), "424.5");
    assert_eq!(k.ledger.total("USDT"), "500");
}

#[test]
fn returns_the_whole_hold_when_an_authorisation_is_voided_or_expires() {
    let Some(k) = plain() else { return };
    k.ledger.fund(HOLDER, "USDT", "500");
    let c = card(&k);
    let auth = id(&authorize(&k, &c, "auth-1", "120").ok());
    let r = reverse(&k, &c, "auth-1").ok();
    assert_eq!(text(&r, "returned"), "120");
    assert_eq!(r.get("partner"), None);
    assert_eq!(k.ledger.held(&auth, HOLDER, "USDT"), "0");
    assert_eq!(k.ledger.available(HOLDER, "USDT"), "500");
}

#[test]
fn refuses_to_capture_an_authorisation_that_was_already_settled_and_to_settle_one_twice() {
    let Some(k) = plain() else { return };
    k.ledger.fund(HOLDER, "USDT", "500");
    let c = card(&k);
    authorize(&k, &c, "auth-1", "120").ok();
    capture(&k, &c, "auth-1", "120").ok();
    assert_eq!(
        capture(&k, &c, "auth-1", "120").code(),
        "bank.card_authorization_closed"
    );
    assert_eq!(
        reverse(&k, &c, "auth-1").code(),
        "bank.card_authorization_closed"
    );
    assert_eq!(k.ledger.available(HOLDER, "USDT"), "380");
    assert_eq!(k.ledger.total("USDT"), "500");
}

#[test]
fn re_drives_a_capture_whose_post_failed_instead_of_stranding_the_whole_hold() {
    let Some(k) = plain() else { return };
    k.ledger.fund(HOLDER, "USDT", "500");
    let c = card(&k);
    let auth = id(&authorize(&k, &c, "auth-1", "120").ok());
    k.ledger.fail_on("withdraw.settle", Fail::Unknown);
    assert_eq!(capture(&k, &c, "auth-1", "120").0, 500);
    let r = row(
        &k,
        &format!(
            "SELECT status::text, rejection_code FROM bank.card_settlements WHERE authorization_id = '{auth}' AND sequence = 0"
        ),
    );
    assert_eq!((r[0].as_deref(), r[1].as_deref()), (Some("pending"), None));
    assert_eq!(k.ledger.held(&auth, HOLDER, "USDT"), "120");
    k.ledger.heal();
    let r = capture(&k, &c, "auth-1", "120").ok();
    assert_eq!(text(&r, "captured"), "120");
    assert_eq!(k.ledger.held(&auth, HOLDER, "USDT"), "0");
    assert_eq!(k.ledger.available(HOLDER, "USDT"), "380");
}

#[test]
fn an_unknown_capture_outcome_stays_pending_refuses_a_reversal_and_a_retry_re_drives_the_same_key()
{
    let Some(k) = plain() else { return };
    k.ledger.fund(HOLDER, "USDT", "500");
    let c = card(&k);
    let auth = id(&authorize(&k, &c, "auth-1", "120").ok());
    k.ledger.fail_on("withdraw.settle", Fail::LoseReplyOnce);
    assert_eq!(capture(&k, &c, "auth-1", "120").0, 500);
    assert_eq!(
        kinds(&settlements(&k, &auth)),
        vec![pair("capture", "pending")]
    );
    assert_eq!(
        reverse(&k, &c, "auth-1").code(),
        "bank.card_settlement_kind_conflict"
    );
    let r = capture(&k, &c, "auth-1", "120").ok();
    assert_eq!(text(&r, "captured"), "120");
    let key = format!("withdraw.settle:{auth}");
    assert_eq!(
        k.ledger.asked("withdraw.settle"),
        vec![key.clone(), key.clone()]
    );
    assert_eq!(k.ledger.booked(&key), 1);
    assert_eq!(k.ledger.held(&auth, HOLDER, "USDT"), "0");
}

#[test]
fn lets_reverse_release_a_hold_after_a_definitely_refused_capture_rather_than_refusing_it_as_closed()
 {
    let Some(k) = plain() else { return };
    k.ledger.fund(HOLDER, "USDT", "500");
    let c = card(&k);
    let auth = id(&authorize(&k, &c, "auth-1", "120").ok());
    k.ledger.fail_on(
        "withdraw.settle",
        Fail::Coded("ledger.invalid_entry".to_owned()),
    );
    assert_eq!(capture(&k, &c, "auth-1", "120").0, 500);
    k.ledger.heal();
    let r = reverse(&k, &c, "auth-1").ok();
    assert_eq!(text(&r, "returned"), "120");
    assert_eq!(k.ledger.held(&auth, HOLDER, "USDT"), "0");
    assert_eq!(k.ledger.available(HOLDER, "USDT"), "500");
}

#[test]
fn does_not_reuse_a_rejected_full_capture_row_or_report_its_ledger_transaction_as_the_reversal() {
    let Some(k) = plain() else { return };
    k.ledger.fund(HOLDER, "USDT", "500");
    let c = card(&k);
    let auth = id(&authorize(&k, &c, "auth-1", "120").ok());
    k.ledger.fail_on(
        "withdraw.settle",
        Fail::Coded("ledger.invalid_entry".to_owned()),
    );
    assert_eq!(capture(&k, &c, "auth-1", "120").0, 500);
    k.ledger.heal();
    let capture_row = row(
        &k,
        &format!(
            "SELECT id::text, kind::text, status::text, amount::text, ledger_tx_id FROM bank.card_settlements \
              WHERE authorization_id = '{auth}' AND sequence = 0"
        ),
    );
    assert_eq!(capture_row[1].as_deref(), Some("capture"));
    assert_eq!(capture_row[2].as_deref(), Some("rejected"));
    assert_eq!(capture_row[4], None);
    assert_eq!(amount_text(capture_row[3].clone()), "120");
    // The reject left the capture's ledger transaction id on the row.
    k.db.client()
        .execute(
            "UPDATE bank.card_settlements SET ledger_tx_id = 'tx-capture-left-behind' \
              WHERE id = $1::text::uuid AND status = 'rejected'",
            &[&capture_row[0]],
        )
        .unwrap();
    let r = reverse(&k, &c, "auth-1").ok();
    let reversal = text(&r, "ledgerTxId");
    assert_ne!(reversal, "tx-capture-left-behind");
    assert_eq!(
        k.ledger
            .tx_id(&format!("withdraw.reverse:{auth}"))
            .as_deref(),
        Some(reversal.as_str())
    );
    assert_eq!(k.ledger.booked(&format!("withdraw.settle:{auth}")), 0);
    let rows = settlements(&k, &auth);
    assert_eq!(
        rows,
        vec![("reversal".to_owned(), "settled".to_owned(), Some(reversal))]
    );
    assert_eq!(
        count(
            &k,
            &format!(
                "SELECT count(*) FROM bank.card_settlements WHERE id = '{}'",
                capture_row[0].clone().unwrap()
            )
        ),
        0
    );
    assert_eq!(k.ledger.held(&auth, HOLDER, "USDT"), "0");
    assert_eq!(k.ledger.available(HOLDER, "USDT"), "500");
}

#[test]
fn recovers_the_remainder_of_a_partial_capture_whose_reversal_post_failed() {
    let Some(k) = plain() else { return };
    k.ledger.fund(HOLDER, "USDT", "500");
    let c = card(&k);
    let auth = id(&authorize(&k, &c, "auth-1", "120").ok());
    k.ledger.fail_on("withdraw.reverse", Fail::Unknown);
    assert_eq!(capture(&k, &c, "auth-1", "50").0, 500);
    k.ledger.heal();
    assert_eq!(k.ledger.held(&auth, HOLDER, "USDT"), "70");
    assert_eq!(
        capture(&k, &c, "auth-1", "50").code(),
        "bank.card_authorization_closed"
    );
    let r = resume(&k, &c, "auth-1").ok();
    let Some(Json::Array(rows)) = r.get("resumed") else {
        panic!("{}", r.compact())
    };
    assert_eq!(rows.len(), 1);
    assert_eq!(text(&rows[0], "sequence"), "1");
    assert_eq!(text(&rows[0], "kind"), "reversal");
    assert_eq!(text(&rows[0], "outcome"), "settled");
    assert_eq!(text(&r, "held"), "0");
    assert_eq!(k.ledger.available(HOLDER, "USDT"), "450");
    assert_eq!(k.ledger.total("USDT"), "500");
}

#[test]
fn refuses_a_settlement_that_disagrees_with_the_amount_its_row_was_claimed_for() {
    let Some(k) = paying() else { return };
    k.ledger.fund(HOLDER, "USDT", "500");
    let c = issue(
        &k,
        CardAsk {
            cashback_bps: Some(500),
            ..CardAsk::default()
        },
    );
    let auth = id(&authorize(&k, &c, "auth-1", "100").ok());
    k.ledger.fail_on("withdraw.settle", Fail::Unknown);
    assert_eq!(capture(&k, &c, "auth-1", "40").0, 500);
    k.ledger.heal();
    assert_eq!(
        capture(&k, &c, "auth-1", "100").code(),
        "bank.card_settlement_amount_conflict"
    );
    assert_eq!(k.ledger.held(&auth, HOLDER, "USDT"), "100");
    assert_eq!(
        count(
            &k,
            &format!("SELECT count(*) FROM bank.card_cashback WHERE authorization_id = '{auth}'")
        ),
        0
    );
    let r = capture(&k, &c, "auth-1", "40").ok();
    assert_eq!(text(&r, "captured"), "40");
    assert_eq!(text(&r, "returned"), "60");
    assert_eq!(k.ledger.held(&auth, HOLDER, "USDT"), "0");
}

#[test]
fn refuses_a_reverse_while_a_full_capture_claim_is_still_pending_and_does_not_report_the_capture_transaction_as_the_reversal()
 {
    let Some(k) = plain() else { return };
    k.ledger.fund(HOLDER, "USDT", "500");
    let c = card(&k);
    let auth = id(&authorize(&k, &c, "auth-1", "120").ok());
    // The ledger has the capture; the row is still pending with its transaction id (the TypeScript pauses the post).
    k.ledger.fail_on("withdraw.settle", Fail::LoseReplyOnce);
    assert_eq!(capture(&k, &c, "auth-1", "120").0, 500);
    let capture_tx = k.ledger.tx_id(&format!("withdraw.settle:{auth}")).unwrap();
    k.db.client()
        .execute(
            "UPDATE bank.card_settlements SET ledger_tx_id = $2 \
              WHERE authorization_id = $1::text::uuid AND sequence = 0 AND status = 'pending'",
            &[&auth, &capture_tx],
        )
        .unwrap();
    assert_eq!(
        settlements(&k, &auth),
        vec![(
            "capture".to_owned(),
            "pending".to_owned(),
            Some(capture_tx.clone())
        )]
    );
    // While the capture claim is pending, a reverse is the wrong kind, and posts nothing.
    assert_eq!(
        reverse(&k, &c, "auth-1").code(),
        "bank.card_settlement_kind_conflict"
    );
    assert_eq!(
        settlements(&k, &auth),
        vec![(
            "capture".to_owned(),
            "pending".to_owned(),
            Some(capture_tx.clone())
        )]
    );
    assert_eq!(k.ledger.booked(&format!("withdraw.reverse:{auth}")), 0);
    // Same kind, same amount: the existing transaction, and no second movement.
    let redriven = capture(&k, &c, "auth-1", "120").ok();
    assert_eq!(text(&redriven, "captureLedgerTxId"), capture_tx);
    assert_eq!(k.ledger.booked(&format!("withdraw.settle:{auth}")), 1);
    // The claim is still the in-flight caller's to settle; a reverse is still the wrong kind.
    assert_eq!(
        settlements(&k, &auth),
        vec![(
            "capture".to_owned(),
            "pending".to_owned(),
            Some(capture_tx.clone())
        )]
    );
    assert_eq!(
        reverse(&k, &c, "auth-1").code(),
        "bank.card_settlement_kind_conflict"
    );
    assert_eq!(k.ledger.booked(&format!("withdraw.reverse:{auth}")), 0);
    // A recovery also answers with the claim's transaction and posts nothing. (The TypeScript then releases its paused
    // post, which settles the row; here the caller that made the post is gone, so the row is left as it would be.)
    resume(&k, &c, "auth-1").ok();
    assert_eq!(k.ledger.booked(&format!("withdraw.settle:{auth}")), 1);
    assert_eq!(k.ledger.held(&auth, HOLDER, "USDT"), "0");

    // The other direction: a pending reversal is not an open door for a capture.
    let voided = id(&authorize(&k, &c, "auth-2", "80").ok());
    k.ledger.fail_on("withdraw.reverse", Fail::LoseReplyOnce);
    assert_eq!(reverse(&k, &c, "auth-2").0, 500);
    assert_eq!(
        capture(&k, &c, "auth-2", "80").code(),
        "bank.card_settlement_kind_conflict"
    );
    assert_eq!(
        kinds(&settlements(&k, &voided)),
        vec![pair("reversal", "pending")]
    );
    assert_eq!(k.ledger.booked(&format!("withdraw.settle:{voided}")), 0);
    let reversed = reverse(&k, &c, "auth-2").ok();
    assert_eq!(
        Some(text(&reversed, "ledgerTxId")),
        k.ledger.tx_id(&format!("withdraw.reverse:{voided}"))
    );
    assert_eq!(k.ledger.booked(&format!("withdraw.reverse:{voided}")), 1);
    assert_eq!(k.ledger.held(&voided, HOLDER, "USDT"), "0");
    assert_eq!(k.ledger.total("USDT"), "500");
}

#[test]
fn refuses_a_capture_larger_than_what_was_authorised_and_held() {
    let Some(k) = plain() else { return };
    k.ledger.fund(HOLDER, "USDT", "500");
    let c = card(&k);
    authorize(&k, &c, "auth-1", "120").ok();
    assert_eq!(
        capture(&k, &c, "auth-1", "120.000000000000000001").code(),
        "bank.card_capture_exceeds_authorization"
    );
}

#[test]
fn refuses_to_capture_against_a_declined_authorisation_which_holds_nothing() {
    let Some(k) = plain() else { return };
    k.ledger.fund(HOLDER, "USDT", "10");
    let c = card(&k);
    assert_eq!(
        text(&authorize(&k, &c, "auth-1", "120").ok(), "decision"),
        "declined"
    );
    assert_eq!(
        capture(&k, &c, "auth-1", "120").code(),
        "bank.card_authorization_declined"
    );
}

#[test]
fn refuses_an_authorisation_reference_this_card_has_never_seen() {
    let Some(k) = plain() else { return };
    let c = card(&k);
    assert_eq!(
        capture(&k, &c, "never", "1").code(),
        "bank.card_authorization_not_found"
    );
}

// ── Cashback ─────────────────────────────────────────────────────────────

fn cashback_card(k: &Kit, bps: i64) -> String {
    issue(
        k,
        CardAsk {
            cashback_bps: Some(bps),
            ..CardAsk::default()
        },
    )
}

#[test]
fn pays_cashback_out_of_a_pot_funded_from_real_bank_revenue() {
    let Some(k) = paying() else { return };
    k.ledger.fund(HOLDER, "USDT", "500");
    let funded = fund_pot(&k, "USDT", "10").ok();
    assert_eq!(text(&funded, "capacity"), "10");
    let c = cashback_card(&k, 100);
    authorize(&k, &c, "auth-1", "200").ok();
    let r = capture(&k, &c, "auth-1", "200").ok();
    let cb = r.get("cashback").unwrap();
    assert_eq!(text(cb, "status"), "paid");
    assert_eq!(text(cb, "amount"), "2");
    assert_eq!(k.ledger.available(HOLDER, "USDT"), "302");
    assert_eq!(k.ledger.pot("USDT"), "8");
    assert_eq!(k.ledger.total("USDT"), "510");
}

#[test]
fn refuses_simulated_cashback_on_the_captured_amount_and_leaves_the_capture_standing() {
    let Some(k) = plain() else { return };
    k.ledger.fund(HOLDER, "USDT", "500");
    fund_pot(&k, "USDT", "10").ok();
    let c = cashback_card(&k, 100);
    authorize(&k, &c, "auth-1", "200").ok();
    let r = capture(&k, &c, "auth-1", "50").ok();
    let cb = r.get("cashback").unwrap();
    assert_eq!(text(cb, "status"), "refused");
    assert_eq!(text(cb, "reason"), "bank.rewards_issuer_unset");
    assert_eq!(text(cb, "amount"), "0.5");
    assert_eq!(k.ledger.available(HOLDER, "USDT"), "450");
    assert_eq!(k.ledger.pot("USDT"), "10");
}

#[test]
fn pays_nothing_at_all_on_a_reversed_authorisation() {
    let Some(k) = paying() else { return };
    k.ledger.fund(HOLDER, "USDT", "500");
    fund_pot(&k, "USDT", "10").ok();
    let c = cashback_card(&k, 100);
    let auth = id(&authorize(&k, &c, "auth-1", "200").ok());
    reverse(&k, &c, "auth-1").ok();
    assert!(cashback_row(&k, &auth).is_empty());
    assert_eq!(k.ledger.available(HOLDER, "USDT"), "500");
    assert_eq!(k.ledger.pot("USDT"), "10");
}

#[test]
fn refuses_cashback_by_name_when_the_pot_is_unfunded_and_leaves_the_capture_standing() {
    let Some(k) = paying() else { return };
    k.ledger.fund(HOLDER, "USDT", "500");
    let c = cashback_card(&k, 100);
    authorize(&k, &c, "auth-1", "200").ok();
    let r = capture(&k, &c, "auth-1", "200").ok();
    let cb = r.get("cashback").unwrap();
    assert_eq!(text(cb, "status"), "refused");
    assert_eq!(text(cb, "reason"), "bank.cashback_pot_unfunded");
    assert_eq!(text(cb, "amount"), "2");
    assert_eq!(k.ledger.available(HOLDER, "USDT"), "300");
    assert_eq!(k.ledger.rail("card-sim", "USDT"), "200");
    let auth = text(&r, "authorizationId");
    let auth = if auth == "null" {
        auth_row(&k, &c, "auth-1")[4].clone().unwrap()
    } else {
        auth
    };
    let rec = cashback_row(&k, &auth);
    assert_eq!(
        (rec[0].as_deref(), rec[1].as_deref()),
        (Some("rejected"), Some("bank.cashback_pot_unfunded"))
    );
    // A rejected empty pot is not a retry.
    let posts = k.ledger.journal_len();
    let resumed = resume(&k, &c, "auth-1").ok();
    assert_eq!(resumed.get("resumed"), Some(&Json::Array(Vec::new())));
    let rec = cashback_row(&k, &auth);
    assert_eq!(rec[0].as_deref(), Some("rejected"));
    assert_eq!(k.ledger.journal_len(), posts);
    assert_eq!(k.ledger.booked("reward:"), 0);
}

#[test]
fn leaves_an_unknown_cashback_post_unsettled_and_retries_it_without_a_second_reward() {
    let Some(k) = paying() else { return };
    k.ledger.fund(HOLDER, "USDT", "500");
    fund_pot(&k, "USDT", "10").ok();
    let c = cashback_card(&k, 100);
    let landed = id(&authorize(&k, &c, "auth-landed", "200").ok());
    let missed = id(&authorize(&k, &c, "auth-missed", "200").ok());
    let key = |a: &str| format!("reward:bank.card.cashback:{a}");

    k.ledger.fail_on(
        &key(&landed),
        Fail::LandThenRefuse("ledger.unavailable".to_owned()),
    );
    let l = capture(&k, &c, "auth-landed", "80").ok();
    let cb = l.get("cashback").unwrap();
    assert_eq!(
        (text(cb, "status"), text(cb, "reason")),
        ("refused".to_owned(), "ledger.unavailable".to_owned())
    );
    assert_eq!(text(cb, "amount"), "0.8");
    assert_eq!(k.ledger.booked(&key(&landed)), 1);

    k.ledger.fail_on(&key(&missed), Fail::Unknown);
    let m = capture(&k, &c, "auth-missed", "80").ok();
    let cb = m.get("cashback").unwrap();
    assert_eq!(
        (text(cb, "status"), text(cb, "reason")),
        ("refused".to_owned(), "bank.post_failed".to_owned())
    );
    assert_eq!(text(cb, "amount"), "0.8");
    assert_eq!(k.ledger.booked(&key(&missed)), 0);
    k.ledger.heal();

    for (auth, reference) in [(&landed, "auth-landed"), (&missed, "auth-missed")] {
        let rec = cashback_row(&k, auth);
        assert_eq!(
            (rec[0].as_deref(), rec[1].as_deref()),
            (Some("pending"), None)
        );
        assert_eq!(amount_text(rec[2].clone()), "0.8");
        assert_eq!(
            kinds(&settlements(&k, auth)),
            vec![pair("capture", "settled"), pair("reversal", "settled")]
        );
        assert_eq!(
            capture(&k, &c, reference, "80").code(),
            "bank.card_authorization_closed"
        );
    }
    assert_eq!(k.ledger.available(HOLDER, "USDT"), "340.8");

    let landed_tx = k.ledger.tx_id(&key(&landed)).unwrap();
    let r = resume(&k, &c, "auth-landed").ok();
    assert_eq!(r.get("resumed"), Some(&Json::Array(Vec::new())));
    assert_eq!(k.ledger.booked(&key(&landed)), 1);
    let rec = cashback_row(&k, &landed);
    assert_eq!(
        (rec[0].as_deref(), rec[3].as_deref(), rec[1].as_deref()),
        (Some("settled"), Some(landed_tx.as_str()), None)
    );
    resume(&k, &c, "auth-missed").ok();
    assert_eq!(k.ledger.booked(&key(&missed)), 1);
    let rec = cashback_row(&k, &missed);
    assert_eq!(rec[0].as_deref(), Some("settled"));
    assert_eq!(rec[3], k.ledger.tx_id(&key(&missed)));
    resume(&k, &c, "auth-landed").ok();
    resume(&k, &c, "auth-missed").ok();
    assert_eq!(k.ledger.booked(&key(&landed)), 1);
    assert_eq!(k.ledger.booked(&key(&missed)), 1);
    assert_eq!(
        count(
            &k,
            &format!(
                "SELECT count(*) FROM bank.card_settlements WHERE authorization_id IN ('{landed}', '{missed}')"
            )
        ),
        4
    );
    assert_eq!(k.ledger.available(HOLDER, "USDT"), "341.6");
    assert_eq!(k.ledger.pot("USDT"), "8.4");
    assert_eq!(k.ledger.total("USDT"), "510");
}

#[test]
fn pays_nothing_and_records_nothing_when_the_card_earns_no_cashback() {
    let Some(k) = plain() else { return };
    k.ledger.fund(HOLDER, "USDT", "500");
    let c = card(&k);
    let auth = id(&authorize(&k, &c, "auth-1", "200").ok());
    let r = capture(&k, &c, "auth-1", "200").ok();
    assert_eq!(
        r.get("cashback").unwrap().compact(),
        r#"{"status":"none","amount":"0"}"#
    );
    assert!(cashback_row(&k, &auth).is_empty());
}

#[test]
fn pays_one_cashback_per_authorisation_however_many_times_a_capture_is_re_driven() {
    let Some(k) = paying() else { return };
    k.ledger.fund(HOLDER, "USDT", "500");
    fund_pot(&k, "USDT", "10").ok();
    let c = cashback_card(&k, 100);
    authorize(&k, &c, "auth-1", "200").ok();
    capture(&k, &c, "auth-1", "200").ok();
    assert_eq!(
        capture(&k, &c, "auth-1", "200").code(),
        "bank.card_authorization_closed"
    );
    assert_eq!(count(&k, "SELECT count(*) FROM bank.card_cashback"), 1);
    assert_eq!(k.ledger.available(HOLDER, "USDT"), "302");
}

#[test]
fn snapshots_the_rate_so_re_rating_the_card_later_cannot_rewrite_what_was_promised() {
    let Some(k) = paying() else { return };
    k.ledger.fund(HOLDER, "USDT", "500");
    fund_pot(&k, "USDT", "10").ok();
    let c = cashback_card(&k, 100);
    let auth = id(&authorize(&k, &c, "auth-1", "200").ok());
    capture(&k, &c, "auth-1", "200").ok();
    k.db.client()
        .execute(
            "UPDATE bank.cards SET cashback_bps = 500 WHERE id = $1::text::uuid",
            &[&c],
        )
        .unwrap();
    assert_eq!(cashback_row(&k, &auth)[4].as_deref(), Some("100"));
}

// ── Conservation, over everything at once ────────────────────────────────

#[test]
fn conserves_value_across_issue_authorise_decline_partial_capture_reversal_and_cashback() {
    let Some(k) = paying() else { return };
    k.ledger.fund(HOLDER, "USDT", "1000");
    fund_pot(&k, "USDT", "25").ok();
    let c = cashback_card(&k, 250);
    authorize(&k, &c, "auth-1", "300").ok();
    capture(&k, &c, "auth-1", "180").ok();
    authorize(&k, &c, "auth-2", "90").ok();
    reverse(&k, &c, "auth-2").ok();
    let declined = authorize(&k, &c, "auth-3", "5000").ok();
    assert_eq!(text(&declined, "decision"), "declined");
    assert_eq!(k.ledger.total("USDT"), "1025");
    assert_eq!(k.ledger.available(HOLDER, "USDT"), "824.5");
    assert_eq!(k.ledger.rail("card-sim", "USDT"), "180");
    assert_eq!(k.ledger.pot("USDT"), "20.5");
    assert_eq!(k.ledger.all_holds("USDT"), "0");
}

#[test]
fn leaves_no_value_in_any_hold_account_once_every_authorisation_is_settled() {
    let Some(k) = plain() else { return };
    k.ledger.fund(HOLDER, "USDT", "1000");
    let c = card(&k);
    let a = id(&authorize(&k, &c, "auth-1", "100").ok());
    let b = id(&authorize(&k, &c, "auth-2", "200").ok());
    let d = id(&authorize(&k, &c, "auth-3", "300").ok());
    capture(&k, &c, "auth-1", "100").ok();
    capture(&k, &c, "auth-2", "50").ok();
    reverse(&k, &c, "auth-3").ok();
    for auth in [a, b, d] {
        assert_eq!(k.ledger.held(&auth, HOLDER, "USDT"), "0");
    }
    assert_eq!(k.ledger.available(HOLDER, "USDT"), "850");
    assert_eq!(k.ledger.total("USDT"), "1000");
}

// ── JIT conversion (§18): a card charged in USDT and funded in BTC ───────

fn converting(k: &Kit, limit: &'static str) -> String {
    issue(
        k,
        CardAsk {
            asset: Some("BTC"),
            settlement: Some("USDT"),
            limit: Some(limit),
            ..CardAsk::default()
        },
    )
}

#[test]
fn refuses_by_name_when_no_rate_can_be_got_and_records_no_decision_at_all() {
    let Some(k) = plain() else { return };
    k.ledger.fund(HOLDER, "BTC", "1");
    let c = converting(&k, "1");
    assert_eq!(
        authorize(&k, &c, "auth-1", "100").code(),
        "bank.mark_missing"
    );
    assert_eq!(
        count(
            &k,
            &format!("SELECT count(*) FROM bank.card_authorizations WHERE card_id = '{c}'")
        ),
        0
    );
    assert_eq!(count(&k, "SELECT count(*) FROM bank.card_conversions"), 0);
    assert_eq!(k.ledger.available(HOLDER, "BTC"), "1");
}

#[test]
fn refuses_a_stale_rate_rather_than_spending_on_a_memory() {
    let Some(k) = plain() else { return };
    k.ledger.fund(HOLDER, "BTC", "1");
    k.rates.set("50000", 120_000, MarkQuality::Mid);
    let c = converting(&k, "1");
    assert_eq!(
        authorize(&k, &c, "auth-1", "100").code(),
        "bank.mark_unusable"
    );
    assert_eq!(k.ledger.available(HOLDER, "BTC"), "1");
}

#[test]
fn holds_the_converted_amount_in_the_funding_asset_and_nothing_in_the_settlement_asset() {
    let Some(k) = plain() else { return };
    k.ledger.fund(HOLDER, "BTC", "1");
    k.rates.set("50000", 0, MarkQuality::Mid);
    let c = converting(&k, "1");
    let a = authorize(&k, &c, "auth-1", "100").ok();
    assert_eq!(text(&a, "decision"), "approved");
    assert_eq!(text(&a, "amount"), "0.002");
    assert_eq!(k.ledger.held(&id(&a), HOLDER, "BTC"), "0.002");
    assert_eq!(k.ledger.available(HOLDER, "BTC"), "0.998");
    let conv = a.get("conversion").unwrap();
    assert_eq!(text(conv, "settlementAssetId"), "USDT");
    assert_eq!(text(conv, "rateQuality"), "mid");
    assert_eq!(text(conv, "settlementAmount"), "100");
    assert_eq!(text(conv, "rate"), "50000");
    assert_eq!(k.ledger.total("BTC"), "1");
    assert_eq!(k.ledger.total("USDT"), "0");
}

#[test]
fn captures_at_the_rate_the_authorisation_was_decided_on_not_the_rate_at_capture_time() {
    let Some(k) = plain() else { return };
    k.ledger.fund(HOLDER, "BTC", "1");
    k.rates.set("50000", 0, MarkQuality::Mid);
    let c = converting(&k, "1");
    let auth = id(&authorize(&k, &c, "auth-1", "100").ok());
    k.rates.set("30000", 0, MarkQuality::Mid);
    let asked = k.rates.asked();
    let r = capture(&k, &c, "auth-1", "100").ok();
    assert_eq!(k.rates.asked(), asked);
    assert_eq!(text(&r, "captured"), "0.002");
    assert_eq!(text(&r, "returned"), "0");
    let settlement = r.get("settlement").unwrap();
    assert_eq!(text(settlement, "assetId"), "USDT");
    assert_eq!(text(settlement, "rate"), "50000");
    assert_eq!(k.ledger.held(&auth, HOLDER, "BTC"), "0");
}

#[test]
fn splits_a_partial_capture_at_the_frozen_rate_and_the_hold_still_ends_at_zero() {
    let Some(k) = plain() else { return };
    k.ledger.fund(HOLDER, "BTC", "1");
    k.rates.set("50000", 0, MarkQuality::Mid);
    let c = converting(&k, "1");
    let auth = id(&authorize(&k, &c, "auth-1", "100").ok());
    k.rates.set("10", 0, MarkQuality::Mid);
    let r = capture(&k, &c, "auth-1", "40").ok();
    assert_eq!(text(&r, "captured"), "0.0008");
    assert_eq!(text(&r, "returned"), "0.0012");
    assert_eq!(k.ledger.held(&auth, HOLDER, "BTC"), "0");
    assert_eq!(k.ledger.available(HOLDER, "BTC"), "0.9992");
}

#[test]
fn refuses_a_capture_larger_than_the_merchant_authorised_in_the_merchants_own_currency() {
    let Some(k) = plain() else { return };
    k.ledger.fund(HOLDER, "BTC", "1");
    k.rates.set("50000", 0, MarkQuality::Mid);
    let c = converting(&k, "1");
    authorize(&k, &c, "auth-1", "100").ok();
    assert_eq!(
        capture(&k, &c, "auth-1", "100.01").code(),
        "bank.card_capture_exceeds_authorization"
    );
}

#[test]
fn re_drives_a_pending_converted_hold_at_the_stored_funding_amount_not_a_fresh_quote() {
    let Some(k) = plain() else { return };
    k.ledger.fund(HOLDER, "BTC", "1");
    k.rates.set("50000", 0, MarkQuality::Mid);
    let c = converting(&k, "1");
    k.ledger.fail_on("withdraw.hold:", Fail::Unknown);
    assert_eq!(authorize(&k, &c, "auth-1", "100").0, 500);
    k.ledger.heal();
    let asked = k.rates.asked();
    k.rates.set("45000", 0, MarkQuality::Mid);
    let redriven = authorize(&k, &c, "auth-1", "100").ok();
    assert_eq!(k.rates.asked(), asked);
    assert_eq!(text(&redriven, "decision"), "approved");
    assert_eq!(text(&redriven, "amount"), "0.002");
    assert_eq!(text(redriven.get("conversion").unwrap(), "rate"), "50000");
    assert_eq!(k.ledger.held(&id(&redriven), HOLDER, "BTC"), "0.002");
    assert_eq!(k.ledger.available(HOLDER, "BTC"), "0.998");
    let hold = auth_row(&k, &c, "auth-1")[2].clone();
    authorize(&k, &c, "auth-1", "100").ok();
    assert_eq!(auth_row(&k, &c, "auth-1")[2], hold);
    assert_eq!(k.rates.asked(), asked);
}

#[test]
fn re_quotes_nothing_on_a_redelivered_authorisation_and_holds_exactly_once() {
    let Some(k) = plain() else { return };
    k.ledger.fund(HOLDER, "BTC", "1");
    k.rates.set("50000", 0, MarkQuality::Mid);
    let c = converting(&k, "1");
    let first = authorize(&k, &c, "auth-1", "100").ok();
    k.rates.set("1000", 0, MarkQuality::Mid);
    let second = authorize(&k, &c, "auth-1", "100").ok();
    assert_eq!(id(&second), id(&first));
    assert_eq!(text(&second, "amount"), "0.002");
    assert_eq!(text(second.get("conversion").unwrap(), "rate"), "50000");
    assert_eq!(k.ledger.held(&id(&first), HOLDER, "BTC"), "0.002");
    assert_eq!(k.ledger.available(HOLDER, "BTC"), "0.998");
    assert_eq!(count(&k, "SELECT count(*) FROM bank.card_conversions"), 1);
}

#[test]
fn declines_on_the_converted_amount_when_it_breaches_the_funding_asset_ceiling() {
    let Some(k) = plain() else { return };
    k.ledger.fund(HOLDER, "BTC", "1");
    k.rates.set("50000", 0, MarkQuality::Mid);
    let c = converting(&k, "0.001");
    let a = authorize(&k, &c, "auth-1", "100").ok();
    assert_eq!(text(&a, "decision"), "declined");
    assert_eq!(text(&a, "declineCode"), "bank.card_limit_exceeded");
    assert_eq!(text(a.get("conversion").unwrap(), "rate"), "50000");
    assert_eq!(k.ledger.available(HOLDER, "BTC"), "1");
}

#[test]
fn consults_no_rate_source_for_a_card_charged_in_the_asset_it_draws_on() {
    let Some(k) = plain() else { return };
    k.ledger.fund(HOLDER, "USDT", "500");
    let c = card(&k);
    let a = authorize(&k, &c, "auth-1", "100").ok();
    assert_eq!(text(&a, "decision"), "approved");
    assert_eq!(a.get("conversion"), Some(&Json::Null));
    assert_eq!(k.ledger.held(&id(&a), HOLDER, "USDT"), "100");
    let r = capture(&k, &c, "auth-1", "100").ok();
    assert_eq!(r.get("settlement"), Some(&Json::Null));
    assert_eq!(k.rates.asked(), 0);
    assert_eq!(k.ledger.held(&id(&a), HOLDER, "USDT"), "0");
}

#[test]
fn moves_value_only_through_the_ledger_and_holds_no_conversion_balance_anywhere() {
    let Some(k) = plain() else { return };
    k.ledger.fund(HOLDER, "BTC", "1");
    k.rates.set("50000", 0, MarkQuality::Mid);
    let c = converting(&k, "1");
    let auth = id(&authorize(&k, &c, "auth-1", "100").ok());
    capture(&k, &c, "auth-1", "100").ok();
    assert_eq!(k.ledger.total("BTC"), "1");
    assert_eq!(k.ledger.held(&auth, HOLDER, "BTC"), "0");
    assert_eq!(k.ledger.available(HOLDER, "BTC"), "0.998");
    let names: Vec<String> =
        k.db.client()
            .query(
                "SELECT column_name::text FROM information_schema.columns \
              WHERE table_schema = 'bank' AND table_name = 'card_conversions'",
                &[],
            )
            .unwrap()
            .iter()
            .map(|r| r.get(0))
            .collect();
    let money_shaped = [
        "balance",
        "available",
        "held",
        "outstanding",
        "running",
        "total",
    ];
    assert!(
        names
            .iter()
            .all(|n| !money_shaped.iter().any(|m| n.to_lowercase().contains(m)))
    );
    assert!(!names.contains(&"updated_at".to_owned()));
}

// ── The approval ─────────────────────────────────────────────────────────

/// `ops.router.ts`: every card move consumes the second founder's approval bound to its fields before it moves
/// anything; none, or one for other fields, refuses with nothing held.
#[test]
fn a_card_move_without_its_founders_approval_moves_nothing() {
    let Some(k) = plain() else { return };
    k.ledger.fund(HOLDER, "USDT", "500");
    let c = card(&k);
    let bare = crate::card_ops_kit::call(
        &k,
        crate::card_ops_kit::OPERATOR,
        crate::card_ops_kit::DESK,
        "ops.cardAuthorize",
        &Json::obj([
            ("cardId", Json::str(c.clone())),
            ("authorizationRef", Json::str("auth-1")),
            ("amount", Json::str("10")),
        ]),
    );
    assert_eq!(bare.code(), "action_approval.missing");
    // An approval for 10 does not authorise 11.
    let wrong = k.desk.issue(
        "bank.card_authorize",
        &[
            ("cardId".to_owned(), c.clone()),
            ("authorizationRef".to_owned(), "auth-1".to_owned()),
            ("amount".to_owned(), "10".to_owned()),
        ],
    );
    let mut fields = vec![
        ("cardId".to_owned(), Json::str(c.clone())),
        ("authorizationRef".to_owned(), Json::str("auth-1")),
        ("amount".to_owned(), Json::str("11")),
    ];
    fields.extend(wrong.into_iter().map(|(k2, v)| (k2.to_owned(), v)));
    let refused = crate::card_ops_kit::call(
        &k,
        crate::card_ops_kit::OPERATOR,
        crate::card_ops_kit::DESK,
        "ops.cardAuthorize",
        &Json::Object(fields),
    );
    assert_eq!(refused.code(), "action_approval.consume_failed");
    assert_eq!(
        count(&k, "SELECT count(*) FROM bank.card_authorizations"),
        0
    );
    assert_eq!(k.ledger.available(HOLDER, "USDT"), "500");
}
