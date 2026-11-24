//! Slice `loans` against Postgres, share c: the TypeScript suites
//! - `services/svc-bank/src/loans/loan-interest-corrections.db.test.ts` (LOAN-05),
//! - `services/svc-bank/src/loans/loan-reads.db.test.ts` (BK-loan-06),
//! - `services/svc-bank/src/loans/loan-apply.db.test.ts` (BK-loan-01, BK-loan-02),
//! - `services/svc-bank/src/loans/loan-urgent.test.ts` (N4, N5, N18),
//! - `services/svc-bank/src/ops/loan-products.db.test.ts` (BK-loan-02),
//! - the one loan test of `services/svc-bank/src/ops/bank-ops.db.test.ts` ("bands the loan book ...").
//!
//! Each Rust test is named after the TypeScript test's words. A `LoanService` call is the Rust function it became,
//! given the dependencies `loans_kit` builds; a router call goes through the HTTP door. The TypeScript's identity
//! stand-ins are the kit's `Desk` (an approval bound to one action and one set of fields, consumed once); the founders
//! it names are the desk's `OPERATOR` (proposer) and `APPROVER`.
//!
//! Mapped, not copied word for word:
//! - `open({ ...terms, loanId: undefined })` (loan-apply): the TypeScript service mints an id; the Rust `open` takes
//!   the id its router minted, so "no id" is a fresh id, the same new loan the line asks about.
//! - `vi.useFakeTimers({ now: NOW })` around one router call (loan-reads): the door with its clock held at `NOW`
//!   (`Kit::door_at`).
//! - The N18 suites wrap `ledger.post` to throw once before the commit: `Book::drop_next`.
//! - The N4 suites count every delivery attempt, failed ones included: a sink of this file's own (`Attempts`).
//!
//! Not ported from `ops/bank-ops.db.test.ts`, as not loans: "reads pool totals from the ledger" (earn), "counts the
//! card programme" (cards), "reports ramp health" (ramps), "lists business approvals" and "creates one business
//! account" (business). No test in this share reads TypeScript source text.
//!
//! Without `TEST_DATABASE_URL` each test skips; with `REQUIRE_POSTGRES=1` it fails.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::too_many_lines,
    reason = "a test: a failure is the point"
)]

use std::sync::Mutex;

use base64::Engine as _;
use service_kit::http::{Fetch, FetchError, HttpRequest, HttpResponse};
use service_kit::json::Json;
use service_kit::money::Amount;
use service_kit::time::Instant;
use svc_bank::door::system_now;
use svc_bank::errors::Refusal;
use svc_bank::loans::adjustments::{self, ADJUST_LOAN_INTEREST_ACTION, People, Terms};
use svc_bank::loans::model::{self, RateChange, RateChanged};
use svc_bank::loans::ports::{Deps, MarginCallNotice, MarginCalls};
use svc_bank::loans::prices::{PriceSource, TickerPriceSource};
use svc_bank::loans::risk::daily_loan_interest;
use svc_bank::loans::{reads, service, sweep};
use svc_bank::spaces::space;

use crate::loans_kit::{
    APPROVER, Answer, BORROWER, DAY, HOUR, Kit, OPERATOR, PAYER, amt, arr, at, call, code, fmt,
    obj, plus, s, send, t0, uuid,
};

const STATEMENT_SECRET: &str = "bank-loan-reads-statement-secret-32";
const TREASURY: &[&str] = &["admin:treasury"];
const CUSTOMER: &[&str] = &["bank:read", "bank:write"];

fn later() -> Instant {
    at("2026-06-11T09:00:00Z")
}

fn now_at() -> Instant {
    t0()
}

fn f(k: &str, v: &str) -> (String, String) {
    (k.to_owned(), v.to_owned())
}

fn st(v: &str) -> Json {
    Json::str(v)
}

/// The Rust error's whole text, for a message the TypeScript matches by pattern.
fn text_of(r: &Refusal) -> String {
    format!("{} {r:?}", service::message_of(r))
}

/// The loans' read settings: `payoffFee: '0'`, `payoffWindowMinutes: '15'`, a statement secret.
fn reads_kit() -> Option<Kit> {
    let mut k = Kit::new()?;
    k.settings.payoff_fee = Some("0".to_owned());
    k.settings.payoff_window_minutes = Some("15".to_owned());
    k.settings.statement_secret = Some(STATEMENT_SECRET.to_owned());
    Some(k)
}

/// The read suites' seed: a 100000 USDT reserve, 1 BTC, a 5% product with a floor of 1, a 100 USDT loan at NOW.
fn seed(k: &Kit) -> service::Opened {
    k.fund_reserve("USDT", "100000");
    k.fund(BORROWER, "BTC", "1");
    let p = k.product_with(|p| {
        p.apr_bps = 500;
        p.min_principal = Some(amt("1"));
    });
    k.open(&p.id, "1", "100").unwrap()
}

/// The corrections suite's seed: the read seed, accrued ten days.
fn seed_accrued(k: &Kit) -> String {
    let id = seed(k).loan.id;
    k.d(|d| service::accrue(d, &id, later())).unwrap();
    id
}

fn with_approval(input: &Json, approval_id: &str) -> Json {
    let Json::Object(mut fields) = input.clone() else {
        panic!("not an object");
    };
    fields.push(("approvalId".to_owned(), st(approval_id)));
    fields.push(("operationId".to_owned(), Json::str(uuid())));
    Json::Object(fields)
}

fn set(input: &Json, key: &str, value: Json) -> Json {
    let Json::Object(mut fields) = input.clone() else {
        panic!("not an object");
    };
    match fields.iter_mut().find(|(k, _)| k == key) {
        Some(slot) => slot.1 = value,
        None => fields.push((key.to_owned(), value)),
    }
    Json::Object(fields)
}

fn without(input: &Json, key: &str) -> Json {
    let Json::Object(fields) = input.clone() else {
        panic!("not an object");
    };
    Json::Object(fields.into_iter().filter(|(k, _)| k != key).collect())
}

fn query(door: &svc_bank::door::BankDoor, user: &str, scopes: &[&str], path: &str) -> Answer {
    send(door, path, "", crate::loans_kit::person(user, scopes))
}

// ---------------------------------------------------------------------------------------------------------------
// The statement file

fn body(statement: &Json) -> Vec<u8> {
    base64::engine::general_purpose::STANDARD
        .decode(s(statement, "bodyBase64"))
        .unwrap()
}

fn body_text(statement: &Json) -> String {
    String::from_utf8(body(statement)).unwrap()
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Row {
    kind: String,
    interest: String,
    principal: String,
    ledger_tx_id: String,
}

fn row(kind: &str, interest: &str, principal: &str, ledger_tx_id: &str) -> Row {
    Row {
        kind: kind.to_owned(),
        interest: interest.to_owned(),
        principal: principal.to_owned(),
        ledger_tx_id: ledger_tx_id.to_owned(),
    }
}

fn csv_cells(line: &str) -> Vec<String> {
    let chars: Vec<char> = line.chars().collect();
    let mut cells = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    let mut i = 0;
    while i < chars.len() {
        let ch = chars[i];
        if quoted {
            if ch == '"' {
                if chars.get(i + 1) == Some(&'"') {
                    current.push('"');
                    i += 1;
                } else {
                    quoted = false;
                }
            } else {
                current.push(ch);
            }
        } else if ch == '"' {
            quoted = true;
        } else if ch == ',' {
            cells.push(std::mem::take(&mut current));
        } else {
            current.push(ch);
        }
        i += 1;
    }
    cells.push(current);
    cells
}

/// `statementDebt`: opening plus draws and interest, minus repayments, sales and insured shortfall.
fn statement_debt(
    text: &str,
    opening_principal: &str,
    opening_interest: &str,
) -> (String, String, Vec<Row>) {
    let mut principal = amt(opening_principal);
    let mut interest = amt(opening_interest);
    let mut rows = Vec::new();
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let lines: Vec<&str> = text.split("\r\n").collect();
    assert_eq!(
        lines[0],
        "kind,at,amount,interest,principal,asset,ledgerTxId"
    );
    let first = csv_cells(lines.get(1).copied().unwrap_or_default());
    assert_eq!(first[0], "opening");
    assert_eq!(first[3], opening_interest);
    assert_eq!(first[4], opening_principal);
    let mut last_at = String::new();
    for line in &lines[1..] {
        if line.is_empty() {
            continue;
        }
        let cells = csv_cells(line);
        let kind = cells[0].clone();
        if kind == "opening" || kind == "closing" || kind == "closing_provisional" {
            continue;
        }
        assert!(cells[1] >= last_at, "{line} is out of order");
        last_at.clone_from(&cells[1]);
        let cell = |i: usize, d: &str| cells.get(i).cloned().unwrap_or_else(|| d.to_owned());
        let (ic, pc, tx) = (cell(3, "0"), cell(4, "0"), cell(6, ""));
        rows.push(row(&kind, &ic, &pc, &tx));
        let (lp, li) = (amt(&pc), amt(&ic));
        match kind.as_str() {
            "draw" | "interest" => {
                principal += lp;
                interest += li;
            }
            "repayment" | "liquidation" | "liquidation_shortfall" => {
                principal -= lp;
                interest -= li;
            }
            _ => assert!(
                lp == Amount::ZERO && li == Amount::ZERO,
                "statement line {kind} moves debt and is not in the sum"
            ),
        }
    }
    (fmt(principal), fmt(interest), rows)
}

/// `signStatement(SECRET, bytes)` equals the file's own.
fn assert_signed(statement: &Json) {
    let (sha, sig) = reads::sign_statement(STATEMENT_SECRET, &body(statement));
    assert_eq!(sha, s(statement, "sha256"));
    assert_eq!(sig, s(statement, "signature"));
}

// ===============================================================================================================
// loan-interest-corrections.db.test.ts: interest corrections and the per-loan ledger check (LOAN-05)

fn correction(loan_id: &str, adjustment_id: &str, amount: &str, reason: &str) -> Terms {
    Terms {
        adjustment_id: adjustment_id.to_owned(),
        loan_id: loan_id.to_owned(),
        amount: amount.to_owned(),
        reason: reason.to_owned(),
    }
}

/// `correctionApprovalFields(terms)`.
fn correction_fields(t: &Terms) -> Vec<(String, String)> {
    vec![
        f("loanId", &t.loan_id),
        f("adjustmentId", &t.adjustment_id),
        f("amount", &t.amount),
        f("reason", &t.reason),
    ]
}

fn correction_input(t: &Terms) -> Json {
    obj(&[
        ("loanId", st(&t.loan_id)),
        ("adjustmentId", st(&t.adjustment_id)),
        ("amount", st(&t.amount)),
        ("reason", st(&t.reason)),
    ])
}

/// `ids.approve(fields)` spread into the door's input.
fn approved_correction(k: &Kit, t: &Terms) -> Json {
    let id = k
        .desk
        .issue(ADJUST_LOAN_INTEREST_ACTION, &correction_fields(t));
    with_approval(&correction_input(t), &id)
}

fn adjust(door: &svc_bank::door::BankDoor, input: &Json) -> Answer {
    call(door, OPERATOR, TREASURY, "ops.adjustLoanInterest", input)
}

fn people<'a>(proposed_by: &'a str, approved_by: &'a str, approval_id: &'a str) -> People<'a> {
    People {
        proposed_by,
        approved_by,
        approval_id,
    }
}

#[test]
fn a_proposes_a_correction_and_b_approves_a_new_row_with_its_reason_the_interest_owed_falls_by_it_no_past_day_changes_and_nothing_posts()
 {
    let Some(k) = reads_kit() else { return };
    let loan_id = seed_accrued(&k);
    let l = k.loan(&loan_id);
    let before = k.d(|d| adjustments::interest_rows(d, &l)).unwrap();
    assert_eq!(arr(before.get("days").unwrap()).len(), 10);
    assert_eq!(s(&before, "owed"), s(&before, "accrued"));
    let accrued = amt(&s(&before, "accrued"));
    let posted = k.ledger.journal().len();

    let terms = correction(
        &loan_id,
        &uuid(),
        "-0.05",
        "TEST: one day was charged on the wrong basis",
    );
    let door = k.door();
    let written = adjust(&door, &approved_correction(&k, &terms)).ok();
    assert_eq!(s(&written, "adjustmentId"), terms.adjustment_id);
    assert_eq!(s(&written, "amount"), "-0.05");
    assert_eq!(s(&written, "reason"), terms.reason);
    assert_eq!(s(&written, "proposedBy"), OPERATOR);
    assert_eq!(s(&written, "approvedBy"), APPROVER);
    assert_eq!(s(&written, "replay"), "false");
    assert_eq!(s(&written, "interestOwed"), fmt(accrued - amt("0.05")));

    let after = call(
        &door,
        BORROWER,
        CUSTOMER,
        "loans.interestRows",
        &obj(&[("loanId", st(&loan_id))]),
    )
    .ok();
    assert_eq!(after.get("days"), before.get("days"));
    let corrections = arr(after.get("corrections").unwrap());
    assert_eq!(corrections.len(), 1);
    assert_eq!(s(&corrections[0], "id"), terms.adjustment_id);
    assert_eq!(s(&corrections[0], "amount"), "-0.05");
    assert_eq!(s(&corrections[0], "reason"), terms.reason);
    assert_eq!(s(&after, "corrected"), "-0.05");
    assert_eq!(
        amt(&s(&after, "owed")),
        amt(&s(&after, "accrued")) + amt(&s(&after, "corrected")) - amt(&s(&after, "paid"))
    );
    assert_eq!(k.debt(&loan_id).interest, accrued - amt("0.05"));
    assert_eq!(k.ledger.journal().len(), posted);

    // The statement carries the correction as its own line, and its lines still add up to the closing debt. The
    // correction is written now, so the statement runs from the loan's first day to tomorrow.
    let wall = system_now();
    let tomorrow = plus(wall, DAY).iso();
    let statement = k
        .at(wall, |d| {
            reads::statement(d, &loan_id, "2026-06-01T00:00:00.000Z", &tomorrow, d.now)
        })
        .unwrap();
    let text = body_text(&statement);
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text).trim();
    let lines: Vec<Vec<String>> = text.split("\r\n").skip(1).map(csv_cells).collect();
    let line = lines
        .iter()
        .find(|l| l[0] == "interest_correction")
        .unwrap();
    assert_eq!(line[2..5].to_vec(), vec!["-0.05", "-0.05", "0"]);
    let interest: Amount = lines
        .iter()
        .filter(|l| l[0] == "interest" || l[0] == "interest_correction")
        .map(|l| amt(&l[3]))
        .sum();
    assert_eq!(fmt(interest), s(&statement, "closingInterest"));
}

#[test]
fn a_retry_with_the_same_id_and_terms_returns_the_first_row_without_spending_another_approval_other_terms_conflict()
 {
    let Some(k) = reads_kit() else { return };
    let loan_id = seed_accrued(&k);
    let terms = correction(&loan_id, &uuid(), "-0.01", "TEST: retried correction");
    let input = approved_correction(&k, &terms);
    let door = k.door();
    adjust(&door, &input).ok();
    let again = adjust(&door, &input).ok();
    assert_eq!(s(&again, "replay"), "true");
    assert_eq!(k.desk.consumed(), 1);
    let other = adjust(&door, &set(&input, "amount", st("-0.02")));
    assert_eq!(other.trpc(), "CONFLICT", "{other:?}");
    assert_eq!(other.cause(), "bank.correction_conflict");
    assert_eq!(
        k.count(&format!(
            "SELECT count(*) FROM bank.loan_adjustments WHERE loan_id = '{loan_id}'"
        )),
        1
    );
}

#[test]
fn an_approval_for_other_fields_is_refused_by_identity_and_writes_nothing() {
    let Some(k) = reads_kit() else { return };
    let loan_id = seed_accrued(&k);
    let terms = correction(&loan_id, &uuid(), "-0.01", "TEST: approved amount");
    let input = set(&approved_correction(&k, &terms), "amount", st("-0.02"));
    let a = adjust(&k.door(), &input);
    assert_ne!(a.0, 200, "{a:?}");
    assert_eq!(k.count("SELECT count(*) FROM bank.loan_adjustments"), 0);
}

#[test]
fn refuses_taking_off_more_interest_than_is_owed_before_the_approval_is_spent() {
    let Some(k) = reads_kit() else { return };
    let loan_id = seed_accrued(&k);
    let owed = k.debt(&loan_id).interest;
    let terms = correction(
        &loan_id,
        &uuid(),
        &fmt(-(owed + Amount::from_scaled(1))),
        "TEST: more than owed",
    );
    let door = k.door();
    let a = adjust(&door, &approved_correction(&k, &terms));
    assert_eq!(a.trpc(), "CONFLICT", "{a:?}");
    assert_eq!(a.cause(), "bank.correction_exceeds_interest");
    assert_eq!(k.desk.consumed(), 0);
    // Exactly what is owed is allowed, and leaves no interest.
    let all = correction(&loan_id, &uuid(), &fmt(-owed), "TEST: all of it");
    adjust(&door, &approved_correction(&k, &all)).ok();
    assert_eq!(k.debt(&loan_id).interest, Amount::ZERO);
}

#[test]
fn refuses_a_zero_amount_a_blank_reason_a_pending_repayment_and_a_closed_loan() {
    let Some(k) = reads_kit() else { return };
    let loan_id = seed_accrued(&k);
    let base = correction(&loan_id, &uuid(), "-0.01", "TEST: refusals");
    let zero = Terms {
        amount: "0".to_owned(),
        ..base.clone()
    };
    assert_eq!(
        code(&k.d(|d| adjustments::check(d, &zero)).unwrap_err()),
        "bank.correction_invalid"
    );
    let blank = Terms {
        reason: "  ".to_owned(),
        ..base.clone()
    };
    assert_eq!(
        code(&k.d(|d| adjustments::check(d, &blank)).unwrap_err()),
        "bank.correction_invalid"
    );
    k.sql(&format!(
        "INSERT INTO bank.loan_repayments (id, loan_id, sequence, principal_amount, interest_amount, status)
         VALUES ('{}', '{loan_id}', 1, '10'::numeric, '0'::numeric, 'pending')",
        uuid()
    ));
    let e = k
        .d(|d| adjustments::write(d, &base, &people(OPERATOR, APPROVER, "appr-pending"), d.now))
        .unwrap_err();
    assert_eq!(code(&e), "bank.ledger_outcome_unknown");
    k.sql(&format!(
        "UPDATE bank.loans SET status = 'repaid' WHERE id = '{loan_id}'"
    ));
    assert_eq!(
        code(&k.d(|d| adjustments::check(d, &base)).unwrap_err()),
        "bank.loan_closed"
    );
}

#[test]
fn the_database_refuses_a_correction_approved_by_its_proposer() {
    let Some(k) = reads_kit() else { return };
    let loan_id = seed_accrued(&k);
    let t = correction(&loan_id, &uuid(), "-0.01", "TEST: one person");
    let e = k
        .d(|d| adjustments::write(d, &t, &people(OPERATOR, OPERATOR, "appr-self"), d.now))
        .unwrap_err();
    assert!(
        text_of(&e).contains("loan_adjustments_four_eyes_ck"),
        "{e:?}"
    );
}

#[test]
fn accrual_days_and_corrections_are_append_only_an_update_or_delete_raises() {
    let Some(k) = reads_kit() else { return };
    let loan_id = seed_accrued(&k);
    let t = correction(&loan_id, &uuid(), "0.01", "TEST: added interest");
    k.d(|d| adjustments::write(d, &t, &people(OPERATOR, APPROVER, "appr-add"), d.now))
        .unwrap();
    for q in [
        format!(
            "UPDATE bank.loan_interest_accruals SET interest_amount = 0 WHERE loan_id = '{loan_id}'"
        ),
        format!("DELETE FROM bank.loan_interest_accruals WHERE loan_id = '{loan_id}'"),
        format!("UPDATE bank.loan_adjustments SET amount = 1 WHERE loan_id = '{loan_id}'"),
        format!("DELETE FROM bank.loan_adjustments WHERE loan_id = '{loan_id}'"),
    ] {
        let e = k.db.client().batch_execute(&q).unwrap_err();
        let msg = e
            .as_db_error()
            .map_or_else(|| e.to_string(), |d| d.message().to_owned());
        assert!(msg.contains("append-only"), "{q}: {msg}");
    }
    assert_eq!(
        k.count(&format!(
            "SELECT count(*) FROM bank.loan_interest_accruals WHERE loan_id = '{loan_id}'"
        )),
        10
    );
}

#[test]
fn the_ledger_check_agrees_leg_by_leg_after_a_draw_a_repayment_and_a_release_and_names_a_row_settled_under_the_wrong_transaction()
 {
    let Some(k) = reads_kit() else { return };
    let loan_id = seed_accrued(&k);
    k.fund(BORROWER, "USDT", "1");
    k.at(later(), |d| service::repay(d, &loan_id, amt("30"), &uuid()))
        .unwrap();
    k.d(|d| service::release_excess(d, &loan_id, &uuid(), amt("0.1")))
        .unwrap();

    let agrees = call(
        &k.door(),
        BORROWER,
        CUSTOMER,
        "loans.ledgerCheck",
        &obj(&[("loanId", st(&loan_id))]),
    )
    .ok();
    assert_eq!(s(&agrees, "status"), "agrees", "{}", agrees.compact());
    assert_eq!(s(&agrees, "checked"), "4");
    assert_eq!(s(&agrees, "pending"), "0");
    assert_eq!(s(&agrees, "collateralHeld"), "0.9");
    assert_eq!(s(&agrees, "collateralExpected"), "0.9");
    assert_eq!(s(&agrees, "mismatches"), "[]");

    let draw = k.loan(&loan_id).draw_ledger_tx_id.unwrap();
    k.sql(&format!(
        "UPDATE bank.loan_repayments SET ledger_tx_id = '{draw}' WHERE loan_id = '{loan_id}'"
    ));
    let l = k.loan(&loan_id);
    let differs = k.d(|d| adjustments::ledger_check(d, &l, d.now)).unwrap();
    assert_eq!(s(&differs, "status"), "differs");
    let mismatches = arr(differs.get("mismatches").unwrap());
    assert_eq!(mismatches.len(), 1, "{}", differs.compact());
    assert_eq!(s(&mismatches[0], "kind"), "repayment");
    assert_eq!(s(&mismatches[0], "ref"), "0");
    assert_eq!(s(&mismatches[0], "problem"), "key");
}

#[test]
fn a_move_still_pending_reads_as_pending_never_as_a_difference() {
    let Some(k) = reads_kit() else { return };
    let loan_id = seed_accrued(&k);
    k.sql(&format!(
        "INSERT INTO bank.loan_collateral_events (id, loan_id, sequence, direction, amount, status)
         VALUES ('{}', '{loan_id}', 7, 'lock', '0.2'::numeric, 'pending')",
        uuid()
    ));
    let l = k.loan(&loan_id);
    let check = k.d(|d| adjustments::ledger_check(d, &l, d.now)).unwrap();
    assert_eq!(s(&check, "status"), "pending", "{}", check.compact());
    assert_eq!(s(&check, "pending"), "1");
    assert_eq!(s(&check, "mismatches"), "[]");
}

#[test]
fn two_requests_with_one_correction_id_race_one_row_and_the_second_answers_with_it() {
    let Some(k) = reads_kit() else { return };
    let loan_id = seed_accrued(&k);
    let terms = correction(&loan_id, &uuid(), "-0.01", "TEST: sent twice at once");
    let (a, b) = std::thread::scope(|sc| {
        let one = sc.spawn(|| {
            k.d(|d| {
                adjustments::write(d, &terms, &people(OPERATOR, APPROVER, "appr-race-1"), d.now)
            })
        });
        let two = sc.spawn(|| {
            k.d(|d| {
                adjustments::write(d, &terms, &people(OPERATOR, APPROVER, "appr-race-2"), d.now)
            })
        });
        (one.join().unwrap().unwrap(), two.join().unwrap().unwrap())
    });
    let mut replays = [a.1, b.1];
    replays.sort_unstable();
    assert_eq!(replays, [false, true]);
    assert_eq!(a.0.id, b.0.id);
    assert_eq!(
        k.count(&format!(
            "SELECT count(*) FROM bank.loan_adjustments WHERE loan_id = '{loan_id}'"
        )),
        1
    );
}

#[test]
fn counts_a_reason_in_characters_as_the_database_does() {
    let Some(k) = reads_kit() else { return };
    let loan_id = seed_accrued(&k);
    let t = correction(&loan_id, &uuid(), "-0.01", "😀😀");
    assert_eq!(
        code(&k.d(|d| adjustments::check(d, &t)).unwrap_err()),
        "bank.correction_invalid"
    );
}

#[test]
fn another_person_cannot_read_the_interest_rows_or_the_ledger_check() {
    let Some(k) = reads_kit() else { return };
    let loan_id = seed_accrued(&k);
    let door = k.door();
    let input = obj(&[("loanId", st(&loan_id))]);
    for path in ["loans.interestRows", "loans.ledgerCheck"] {
        let a = call(&door, PAYER, CUSTOMER, path, &input);
        assert_eq!(a.trpc(), "FORBIDDEN", "{path}: {a:?}");
    }
}

// ===============================================================================================================
// loan-reads.db.test.ts: loans.projection, payoffQuote, statement (BK-loan-06)

fn loan_input(loan_id: &str, extra: &[(&str, Json)]) -> Json {
    let mut fields = vec![("loanId".to_owned(), st(loan_id))];
    fields.extend(extra.iter().map(|(k, v)| ((*k).to_owned(), v.clone())));
    Json::Object(fields)
}

#[test]
fn projects_30_days_with_the_accrual_rule_quotes_a_published_fee_and_posts_nothing() {
    let Some(k) = reads_kit() else { return };
    let opened = seed(&k);
    let id = opened.loan.id.clone();
    let posted = k.ledger.journal().len();
    let door = k.door();
    let input = loan_input(&id, &[("days", Json::int(30))]);
    let (first, second) = std::thread::scope(|sc| {
        let a = sc.spawn(|| call(&door, BORROWER, CUSTOMER, "loans.projection", &input).ok());
        let b = sc.spawn(|| call(&door, BORROWER, CUSTOMER, "loans.projection", &input).ok());
        (a.join().unwrap(), b.join().unwrap())
    });
    assert_eq!(second, first);
    assert_eq!(s(&first, "kind"), "projection");
    assert_eq!(s(&first, "obligation"), "false");
    let rows = arr(first.get("rows").unwrap());
    assert_eq!(rows.len(), 30);
    assert_eq!(s(&first, "openingPrincipal"), "100");
    assert_eq!(s(&first, "openingInterest"), "0");
    assert_eq!(
        s(&rows[0], "interest"),
        fmt(daily_loan_interest(amt("100"), 500, 365).unwrap())
    );
    let quote = call(
        &door,
        BORROWER,
        CUSTOMER,
        "loans.payoffQuote",
        &loan_input(&id, &[]),
    )
    .ok();
    assert_eq!(s(&quote, "principal"), "100");
    assert_eq!(s(&quote, "fee"), "0");
    assert_eq!(s(&quote, "assetId"), "USDT");
    assert!(at(&s(&quote, "validUntil")).0 > system_now().0);
    let priced = k.d(|d| reads::payoff_quote(d, &id, now_at())).unwrap();
    assert_eq!(s(&priced, "principal"), "100");
    assert_eq!(s(&priced, "interest"), "0");
    assert_eq!(s(&priced, "fee"), "0");
    assert_eq!(s(&priced, "total"), "100");
    assert_eq!(s(&priced, "interestThrough"), "2026-06-01");
    assert_eq!(s(&priced, "validUntil"), "2026-06-01T12:15:00.000Z");
    assert_eq!(k.ledger.journal().len(), posted);
}

#[test]
fn a_fee_repay_cannot_collect_a_blank_fee_or_a_blank_window_refuses_without_a_post() {
    let Some(mut k) = reads_kit() else { return };
    k.settings.payoff_fee = Some("1.25".to_owned());
    let opened = seed(&k);
    let input = loan_input(&opened.loan.id, &[]);
    let posted = k.ledger.journal().len();
    let a = call(&k.door(), BORROWER, CUSTOMER, "loans.payoffQuote", &input);
    assert_eq!(a.trpc(), "PRECONDITION_FAILED", "{a:?}");
    assert_eq!(a.cause(), "bank.loan_fee_unsupported");
    k.settings.payoff_fee = Some(String::new());
    let a = call(&k.door(), BORROWER, CUSTOMER, "loans.payoffQuote", &input);
    assert_eq!(a.cause(), "bank.loan_fee_unset");
    k.settings.payoff_fee = Some("0".to_owned());
    k.settings.payoff_window_minutes = Some(String::new());
    let a = call(&k.door(), BORROWER, CUSTOMER, "loans.payoffQuote", &input);
    assert_eq!(a.cause(), "bank.loan_payoff_window_unset");
    assert_eq!(k.ledger.journal().len(), posted);
}

#[test]
fn a_repay_after_a_quote_uses_the_books_not_the_earlier_total() {
    let Some(k) = reads_kit() else { return };
    let id = seed(&k).loan.id;
    let before = k.d(|d| reads::payoff_quote(d, &id, now_at())).unwrap();
    assert_eq!(s(&before, "total"), "100");
    k.d(|d| service::repay(d, &id, amt("40"), &uuid())).unwrap();
    let after = k.d(|d| reads::payoff_quote(d, &id, now_at())).unwrap();
    assert_eq!(s(&after, "principal"), "60");
    assert_eq!(s(&after, "fee"), "0");
    assert_eq!(s(&after, "total"), "60");
}

#[test]
fn includes_the_days_accrual_has_not_charged_yet_and_paying_the_quote_clears_the_loan() {
    let Some(mut k) = reads_kit() else { return };
    k.settings.payoff_window_minutes = Some("1440".to_owned());
    let id = seed(&k).loan.id;
    let later = at("2026-06-04T09:00:00Z");
    k.d(|d| service::accrue(d, &id, at("2026-06-02T09:00:00Z")))
        .unwrap();
    let projection = k.d(|d| reads::projection(d, &id, 2.0, None)).unwrap();
    let dates: Vec<String> = arr(projection.get("rows").unwrap())
        .iter()
        .map(|r| s(r, "date"))
        .collect();
    assert_eq!(dates, vec!["2026-06-03", "2026-06-04"]);
    let quote = k.d(|d| reads::payoff_quote(d, &id, later)).unwrap();
    assert_eq!(s(&quote, "interestThrough"), "2026-06-04");
    assert_eq!(s(&quote, "validUntil"), "2026-06-05T00:00:00.000Z");
    k.d(|d| service::accrue(d, &id, later)).unwrap();
    assert_eq!(s(&quote, "total"), fmt(k.debt(&id).total));
    k.fund(BORROWER, "USDT", "1");
    let paid = k
        .at(later, |d| {
            service::repay(d, &id, amt(&s(&quote, "total")), &uuid())
        })
        .unwrap();
    assert!(paid.closed);
}

#[test]
fn refuses_a_quote_while_a_repayment_outcome_or_a_sale_is_still_pending() {
    let Some(k) = reads_kit() else { return };
    let id = seed(&k).loan.id;
    k.sql(&format!(
        "INSERT INTO bank.loan_repayments (id, loan_id, sequence, principal_amount, interest_amount, status)
         VALUES ('{}', '{id}', 1, '10'::numeric, '0'::numeric, 'pending')",
        uuid()
    ));
    assert_eq!(
        code(&k.d(|d| reads::payoff_quote(d, &id, now_at())).unwrap_err()),
        "bank.ledger_outcome_unknown"
    );
    k.sql(&format!(
        "DELETE FROM bank.loan_repayments WHERE loan_id = '{id}'"
    ));
    k.sql(&format!(
        "INSERT INTO bank.loan_liquidations (
           loan_id, tranche, ltv_bps, mark_price, collateral_sold, proceeds,
           principal_repaid, interest_repaid, penalty, surplus_returned, shortfall, status
         ) VALUES (
           '{id}', 0, 9000, '10000'::numeric, '0.008'::numeric, '80'::numeric,
           '80'::numeric, '0'::numeric, '0'::numeric, '0'::numeric, '0'::numeric, 'pending'
         )"
    ));
    assert_eq!(
        code(&k.d(|d| reads::payoff_quote(d, &id, now_at())).unwrap_err()),
        "bank.loan_liquidating"
    );
}

#[test]
fn refuses_another_user_and_signs_a_statement_whose_empty_month_opens_and_closes_at_zero() {
    let Some(mut k) = reads_kit() else { return };
    let opened = seed(&k);
    let id = opened.loan.id.clone();
    let door = k.door();
    let a = call(
        &door,
        PAYER,
        CUSTOMER,
        "loans.projection",
        &loan_input(&id, &[("days", Json::int(30))]),
    );
    assert_eq!(a.trpc(), "FORBIDDEN", "{a:?}");
    let a = call(
        &door,
        PAYER,
        CUSTOMER,
        "loans.statement",
        &loan_input(
            &id,
            &[
                ("from", st("2026-06-01T00:00:00.000Z")),
                ("to", st("2026-07-01T00:00:00.000Z")),
            ],
        ),
    );
    assert_eq!(a.trpc(), "FORBIDDEN", "{a:?}");
    let empty = k
        .d(|d| {
            reads::statement(
                d,
                &id,
                "2026-04-01T00:00:00.000Z",
                "2026-05-01T00:00:00.000Z",
                now_at(),
            )
        })
        .unwrap();
    assert_eq!(s(&empty, "rowCount"), "0");
    assert_eq!(s(&empty, "openingPrincipal"), s(&empty, "closingPrincipal"));
    assert_eq!(s(&empty, "openingInterest"), s(&empty, "closingInterest"));
    assert_eq!(s(&empty, "openingPrincipal"), "0");
    assert_eq!(s(&empty, "provisional"), "false");
    // The router dates the statement by the clock, and the pledge is dated by the test's NOW: both take NOW, so the
    // month is in progress and holds the pledge on any date (#7080).
    k.sql(&format!(
        "UPDATE bank.loan_collateral_events SET settled_at = '{}'::timestamptz WHERE loan_id = '{id}' AND direction = 'lock'",
        now_at().iso()
    ));
    let month = call(
        &k.door_at(now_at),
        BORROWER,
        CUSTOMER,
        "loans.statement",
        &loan_input(
            &id,
            &[
                ("from", st("2026-06-01T00:00:00.000Z")),
                ("to", st("2026-11-01T00:00:00.000Z")),
            ],
        ),
    )
    .ok();
    assert_eq!(s(&month, "provisional"), "true");
    assert_eq!(s(&month, "closingPrincipal"), "100");
    assert_eq!(s(&month, "openingPrincipal"), "0");
    assert!(s(&month, "rowCount").parse::<i64>().unwrap() > 0);
    let text = body_text(&month);
    assert!(text.contains(&opened.draw_ledger_tx_id));
    assert!(text.contains("\r\ncollateral_pledge,"), "{text}");
    assert!(!text.contains("collateral_top_up"));
    assert!(text.contains("\r\nclosing_provisional,"), "{text}");
    statement_debt(
        &text,
        &s(&month, "openingPrincipal"),
        &s(&month, "openingInterest"),
    );
    assert_signed(&month);
    k.settings.statement_secret = Some(String::new());
    let e = k
        .d(|d| {
            reads::statement(
                d,
                &id,
                "2026-06-01T00:00:00.000Z",
                "2026-07-01T00:00:00.000Z",
                now_at(),
            )
        })
        .unwrap_err();
    assert_eq!(code(&e), "bank.statement_unavailable");
}

#[test]
fn dates_the_draw_from_drawn_at_so_a_window_before_that_draw_does_not_include_it() {
    let Some(k) = reads_kit() else { return };
    let opened = seed(&k);
    let id = opened.loan.id.clone();
    let opened_at = at("2026-06-01T12:00:00Z");
    let drawn_at = at("2026-06-10T12:00:00Z");
    k.sql(&format!(
        "UPDATE bank.loans SET opened_at = '{}'::timestamptz, drawn_at = '{}'::timestamptz WHERE id = '{id}'",
        opened_at.iso(),
        drawn_at.iso()
    ));
    let july = at("2026-07-01T00:00:00Z");
    let earlier = k
        .d(|d| {
            reads::statement(
                d,
                &id,
                "2026-06-01T00:00:00.000Z",
                "2026-06-05T00:00:00.000Z",
                july,
            )
        })
        .unwrap();
    for key in [
        "openingPrincipal",
        "closingPrincipal",
        "openingInterest",
        "closingInterest",
    ] {
        assert_eq!(s(&earlier, key), "0", "{key}");
    }
    let earlier_text = body_text(&earlier);
    let (_, _, rows) = statement_debt(
        &earlier_text,
        &s(&earlier, "openingPrincipal"),
        &s(&earlier, "openingInterest"),
    );
    assert!(!rows.iter().any(|r| r.kind == "draw"));
    assert!(!earlier_text.contains(&opened.draw_ledger_tx_id));

    let later = k
        .d(|d| {
            reads::statement(
                d,
                &id,
                "2026-06-05T00:00:00.000Z",
                "2026-06-15T00:00:00.000Z",
                july,
            )
        })
        .unwrap();
    assert_eq!(s(&later, "openingPrincipal"), "0");
    assert_eq!(s(&later, "closingPrincipal"), "100");
    assert_eq!(s(&later, "openingInterest"), "0");
    assert_eq!(s(&later, "closingInterest"), "0");
    let later_text = body_text(&later);
    let (principal, _, rows) = statement_debt(
        &later_text,
        &s(&later, "openingPrincipal"),
        &s(&later, "openingInterest"),
    );
    assert_eq!(principal, "100");
    let draws: Vec<Row> = rows.into_iter().filter(|r| r.kind == "draw").collect();
    assert_eq!(
        draws,
        vec![row("draw", "0", "100", &opened.draw_ledger_tx_id)]
    );
    assert!(later_text.contains(&format!(
        "draw,{},100,0,100,USDT,{}",
        drawn_at.iso(),
        opened.draw_ledger_tx_id
    )));
    assert!(!later_text.contains(&opened_at.iso()));
}

#[test]
fn writes_off_an_insured_liquidation_shortfall_so_closing_debt_is_zero_and_the_lines_sum_to_it() {
    let Some(k) = reads_kit() else { return };
    let id = seed(&k).loan.id;
    k.sql(&format!(
        "INSERT INTO bank.loan_liquidations (
           loan_id, tranche, ltv_bps, mark_price, collateral_sold, proceeds,
           principal_repaid, interest_repaid, penalty, surplus_returned, shortfall,
           status, ledger_tx_id, bad_debt_ledger_tx_id, settled_at
         ) VALUES (
           '{id}', 0, 9000, '10000'::numeric, '0.008'::numeric, '80'::numeric,
           '80'::numeric, '0'::numeric, '0'::numeric, '0'::numeric, '20'::numeric,
           'settled', 'sale-tx-80', 'bad-debt-tx-20', '2026-06-15T00:00:00.000Z'::timestamptz
         )"
    ));
    let books = k.debt(&id);
    assert_eq!(fmt(books.principal), "0");
    assert_eq!(fmt(books.interest), "0");
    let file = k
        .d(|d| {
            reads::statement(
                d,
                &id,
                "2026-06-01T00:00:00.000Z",
                "2026-07-01T00:00:00.000Z",
                at("2026-07-02T00:00:00Z"),
            )
        })
        .unwrap();
    assert_eq!(s(&file, "closingPrincipal"), "0");
    assert_eq!(s(&file, "closingInterest"), "0");
    assert_eq!(s(&file, "closingPrincipal"), fmt(books.principal));
    assert_eq!(s(&file, "closingInterest"), fmt(books.interest));
    let text = body_text(&file);
    let (principal, interest, rows) = statement_debt(
        &text,
        &s(&file, "openingPrincipal"),
        &s(&file, "openingInterest"),
    );
    assert_eq!(principal, s(&file, "closingPrincipal"));
    assert_eq!(interest, s(&file, "closingInterest"));
    let sale = rows.iter().find(|r| r.kind == "liquidation").unwrap();
    let wrote_off = rows
        .iter()
        .find(|r| r.kind == "liquidation_shortfall")
        .unwrap();
    assert_eq!(
        (
            sale.principal.as_str(),
            sale.interest.as_str(),
            sale.ledger_tx_id.as_str()
        ),
        ("80", "0", "sale-tx-80")
    );
    assert_eq!(
        (
            wrote_off.principal.as_str(),
            wrote_off.interest.as_str(),
            wrote_off.ledger_tx_id.as_str()
        ),
        ("20", "0", "bad-debt-tx-20")
    );
    assert_signed(&file);
}

// ===============================================================================================================
// loan-apply.db.test.ts: the loan application on a real database

/// The suite's `product(bank)`: a 100000 USDT reserve, 2 BTC on the borrower, a 5% product with a floor of 1.
fn apply_product(k: &Kit) -> model::Product {
    k.fund_reserve("USDT", "100000");
    k.fund(BORROWER, "BTC", "2");
    k.product_with(|p| {
        p.apr_bps = 500;
        p.min_principal = Some(amt("1"));
    })
}

fn open_with(
    k: &Kit,
    loan_id: &str,
    product: &str,
    collateral: &str,
    expected_apr_bps: Option<i64>,
) -> Result<service::Opened, Refusal> {
    k.d(|d| {
        service::open(
            d,
            &service::OpenAsk {
                loan_id,
                product_id: product,
                user_id: BORROWER,
                collateral_amount: amt(collateral),
                principal: amt("100"),
                expected_apr_bps,
            },
        )
    })
}

#[test]
fn replays_a_loan_opened_under_a_zero_fee_and_refuses_only_a_new_one_once_the_fee_is_blank_or_above_zero()
 {
    let Some(mut k) = Kit::new() else { return };
    let made = apply_product(&k);
    let loan_id = uuid();
    let first = open_with(&k, &loan_id, &made.id, "1", None).unwrap();
    let posted = k.ledger.journal().len();

    // The owner publishes a fee svc-bank can't collect yet.
    k.settings.origination_fee_bps = Some("50".to_owned());
    let replay = open_with(&k, &loan_id, &made.id, "1", None).unwrap();
    assert_eq!(replay.loan.id, loan_id);
    assert_eq!(replay.draw_ledger_tx_id, first.draw_ledger_tx_id);
    assert_eq!(
        replay.collateral_ledger_tx_id,
        first.collateral_ledger_tx_id
    );
    assert_eq!(k.ledger.journal().len(), posted, "the replay moves nothing");
    for _ in 0..2 {
        let e = open_with(&k, &uuid(), &made.id, "1", None).err().unwrap();
        assert_eq!(code(&e), "bank.loan_fee_unwired");
    }

    // The fee left blank: a retry still replays, and a new loan refuses as not set.
    k.settings.origination_fee_bps = None;
    assert_eq!(
        open_with(&k, &loan_id, &made.id, "1", None)
            .unwrap()
            .loan
            .id,
        loan_id
    );
    for _ in 0..2 {
        let e = open_with(&k, &uuid(), &made.id, "1", None).err().unwrap();
        assert_eq!(code(&e), "bank.loan_fee_unset");
    }
    assert_eq!(
        k.count("SELECT count(*) FROM bank.loans"),
        1,
        "no row for a refused new loan"
    );
    assert_eq!(k.ledger.journal().len(), posted);
}

fn rate(product_id: &str, from: i64, to: i64, reason: &str) -> RateChange {
    RateChange {
        product_id: product_id.to_owned(),
        from_apr_bps: from,
        apr_bps: to,
        reason: reason.to_owned(),
    }
}

fn set_rate(
    k: &Kit,
    ch: &RateChange,
    approval_id: &str,
    approved_by: &str,
) -> Result<(model::Product, i64), Refusal> {
    space::in_tx(&k.store, |tx| {
        model::set_product_rate(tx, ch, approval_id, approved_by)
    })
}

#[test]
fn records_each_rate_change_with_its_reason_approval_and_approver_bound_to_the_rate_it_replaces_and_replays_by_approval()
 {
    let Some(k) = Kit::new() else { return };
    let made = apply_product(&k);
    // Two changes both read 500: the row lock lets one replace it, and the other finds the rate moved.
    let first = rate(&made.id, 500, 600, "first change");
    let second = rate(&made.id, 500, 700, "second change");
    let raced = std::thread::scope(|sc| {
        let a = sc.spawn(|| set_rate(&k, &first, "appr-1", "founder-b"));
        let b = sc.spawn(|| set_rate(&k, &second, "appr-2", "founder-c"));
        [a.join().unwrap(), b.join().unwrap()]
    });
    let done: Vec<&(model::Product, i64)> = raced.iter().filter_map(|r| r.as_ref().ok()).collect();
    let lost: Vec<&Refusal> = raced.iter().filter_map(|r| r.as_ref().err()).collect();
    assert_eq!(done.len(), 1, "{raced:?}");
    assert_eq!(done[0].1, 500);
    assert_eq!(lost.len(), 1);
    assert_eq!(code(lost[0]), "bank.loan_rate_moved");
    let rows = k.rows(&format!(
        "SELECT apr_bps::text, previous_apr_bps::text, reason, approval_id, approved_by
           FROM bank.loan_product_rate_changes WHERE product_id = '{}'",
        made.id
    ));
    assert_eq!(rows.len(), 1);
    let row_apr: i64 = rows[0][0].as_deref().unwrap().parse().unwrap();
    assert_eq!(rows[0][1].as_deref(), Some("500"));
    assert_eq!(row_apr, done[0].0.apr_bps);
    let current = space::with(&k.store, |c| model::product(c, &made.id))
        .unwrap()
        .apr_bps;
    assert_eq!(current, row_apr);

    // A retry with the approval that made it reads the same change back; the same approval for other terms refuses.
    let (reason, approval_id, approved_by) = (
        rows[0][2].clone().unwrap(),
        rows[0][3].clone().unwrap(),
        rows[0][4].clone().unwrap(),
    );
    let terms = rate(&made.id, 500, current, &reason);
    let by = |id: &str, ch: &RateChange| {
        space::with(&k.store, |c| model::rate_change_by_approval(c, id, ch))
    };
    assert_eq!(
        by(&approval_id, &terms).unwrap(),
        Some(RateChanged {
            product_id: made.id.clone(),
            apr_bps: current,
            previous_apr_bps: 500,
            approved_by,
        })
    );
    let e = by(&approval_id, &rate(&made.id, 500, 900, &reason)).unwrap_err();
    assert_eq!(code(&e), "bank.loan_rate_approval_reused");
    assert_eq!(by("appr-unused", &terms).unwrap(), None);

    // Checked before the approval is spent: a stale "from", no real change, a blank reason.
    let check = |ch: &RateChange| space::with(&k.store, |c| model::check_rate_change(c, ch));
    assert_eq!(
        code(&check(&rate(&made.id, 500, 800, &reason)).unwrap_err()),
        "bank.loan_rate_moved"
    );
    assert_eq!(
        code(&check(&rate(&made.id, current, current, &reason)).unwrap_err()),
        "bank.loan_params_invalid"
    );
    assert_eq!(
        code(&check(&rate(&made.id, current, 800, " ")).unwrap_err()),
        "bank.loan_params_invalid"
    );
    assert_eq!(
        k.count("SELECT count(*) FROM bank.loan_product_rate_changes"),
        1,
        "a refused change records nothing"
    );
    for q in [
        "UPDATE bank.loan_product_rate_changes SET reason = 'edited'",
        "DELETE FROM bank.loan_product_rate_changes",
    ] {
        let e = k.db.client().batch_execute(q).unwrap_err();
        let msg = e
            .as_db_error()
            .map_or_else(|| e.to_string(), |d| d.message().to_owned());
        assert!(msg.contains("append-only"), "{q}: {msg}");
    }
}

#[test]
fn opens_a_new_loan_only_at_the_rate_the_borrower_was_shown_a_retry_of_an_opened_loan_replays() {
    let Some(k) = Kit::new() else { return };
    let made = apply_product(&k);
    let loan_id = uuid();
    let first = open_with(&k, &loan_id, &made.id, "1", Some(500)).unwrap();
    set_rate(
        &k,
        &rate(&made.id, 500, 900, "rate up"),
        "appr-up",
        "founder-b",
    )
    .unwrap();
    let posted = k.ledger.journal().len();
    // The retry carries the rate it was shown; the loan it opened keeps 500 and replays.
    let replay = open_with(&k, &loan_id, &made.id, "1", Some(500)).unwrap();
    assert_eq!(replay.draw_ledger_tx_id, first.draw_ledger_tx_id);
    assert_eq!(replay.loan.apr_bps, 500);
    // A new loan shown 500 while the product now charges 900 refuses, with nothing written or moved.
    let e = open_with(&k, &uuid(), &made.id, "0.5", Some(500))
        .err()
        .unwrap();
    assert_eq!(code(&e), "bank.loan_rate_changed");
    assert_eq!(k.count("SELECT count(*) FROM bank.loans"), 1);
    assert_eq!(k.ledger.journal().len(), posted);
}

// ===============================================================================================================
// loan-urgent.test.ts: loan engine urgent fixes (N4, N5, N18)

/// The suite's `seedOpenLoan`: a 100000 USDT reserve, `collateral` BTC, the default product, 5000 USDT at NOW.
fn seed_open_loan(k: &Kit, collateral: &str) -> service::Opened {
    k.fund_reserve("USDT", "100000");
    k.fund(BORROWER, "BTC", collateral);
    let p = k.product();
    k.open(&p.id, collateral, "5000").unwrap()
}

/// A margin-call sink that records every attempt, failed ones too (the suite's `sent`), and fails while `failing`.
#[derive(Default)]
struct Attempts(Mutex<(Vec<i64>, bool)>);

impl Attempts {
    fn sent(&self) -> Vec<i64> {
        self.0.lock().unwrap().0.clone()
    }
    fn fail(&self, failing: bool) {
        self.0.lock().unwrap().1 = failing;
    }
}

impl MarginCalls for Attempts {
    fn send(&self, n: &MarginCallNotice) -> Result<(), String> {
        let mut st = self.0.lock().unwrap();
        st.0.push(n.sequence);
        if st.1 {
            return Err("bus down".to_owned());
        }
        Ok(())
    }
}

/// The sweeper: BTC at 6500 stamped LATER, the sweep at LATER with a limit of 100, margin calls to `sink`.
fn sweep_with(k: &Kit, sink: &Attempts, now: Instant) {
    k.prices.btc("6500");
    k.prices.stamp(now);
    let d = Deps {
        store: &k.store,
        ledger: &k.ledger,
        custody_layer: &k.custody,
        approvals: &k.desk,
        prices: &k.prices,
        venue: &k.venue,
        margin_calls: sink,
        affiliates: &k.told,
        settings: &k.settings,
        now,
    };
    sweep::run_risk_sweep(&d, now, Some(100.0)).unwrap();
}

fn urgent_later() -> Instant {
    plus(t0(), 60_000)
}

#[test]
fn a_second_sweep_on_a_loan_already_in_margin_call_sends_nothing_and_adds_no_call_row() {
    let Some(k) = Kit::new() else { return };
    let opened = seed_open_loan(&k, "1");
    let sink = Attempts::default();
    for _ in 0..3 {
        sweep_with(&k, &sink, urgent_later());
    }
    assert_eq!(sink.sent().len(), 1);
    assert_eq!(
        k.count(&format!(
            "SELECT count(*) FROM bank.loan_margin_calls WHERE loan_id = '{}'",
            opened.loan.id
        )),
        1
    );
    assert_eq!(k.status(&opened.loan.id), "margin_call");
}

#[test]
fn a_notice_that_failed_is_re_sent_on_the_same_call_row_then_stops() {
    let Some(k) = Kit::new() else { return };
    let opened = seed_open_loan(&k, "1");
    let sink = Attempts::default();
    sink.fail(true);
    sweep_with(&k, &sink, urgent_later());
    sink.fail(false);
    sweep_with(&k, &sink, urgent_later());
    sweep_with(&k, &sink, urgent_later());
    let rows = k.rows(&format!(
        "SELECT sequence::text, notified_at::text FROM bank.loan_margin_calls WHERE loan_id = '{}'",
        opened.loan.id
    ));
    assert_eq!(rows.len(), 1);
    assert!(rows[0][1].is_some());
    let seq: i64 = rows[0][0].as_deref().unwrap().parse().unwrap();
    assert_eq!(sink.sent(), vec![seq, seq]);
}

#[test]
fn sets_margin_called_at_from_the_open_call_row_without_re_sending_a_delivered_notice() {
    let Some(k) = Kit::new() else { return };
    let opened = seed_open_loan(&k, "1");
    let id = &opened.loan.id;
    // The state after a crash: the call row is written (and delivered), the loan row is not updated.
    k.sql(&format!(
        "INSERT INTO bank.loan_margin_calls (loan_id, sequence, ltv_bps, cure_collateral_amount, called_at, grace_expires_at, notified_at)
         VALUES ('{id}', 0, 7700, 0.1, '{now}'::timestamptz, '{grace}'::timestamptz, '{now}'::timestamptz)",
        now = t0().iso(),
        grace = plus(t0(), HOUR).iso()
    ));
    assert_eq!(k.loan(id).margin_called_at, None);
    let sink = Attempts::default();
    sweep_with(&k, &sink, urgent_later());
    let l = k.loan(id);
    assert_eq!(l.status, "margin_call");
    assert_eq!(l.margin_called_at.map(|t| t.0), Some(t0().0));
    assert_eq!(sink.sent().len(), 0);
    assert_eq!(
        k.count(&format!(
            "SELECT count(*) FROM bank.loan_margin_calls WHERE loan_id = '{id}'"
        )),
        1
    );
}

/// A ticker that answers one body to every request.
struct Ticker(String);

impl Fetch for Ticker {
    fn fetch(&self, _req: &HttpRequest) -> Result<HttpResponse, FetchError> {
        Ok(HttpResponse {
            status: 200,
            body: self.0.clone(),
        })
    }
}

fn ticker(body: &str) -> TickerPriceSource {
    TickerPriceSource::new(
        "http://trade.test",
        Box::new(Ticker(body.to_owned())),
        None,
        Box::new(system_now),
    )
}

#[test]
fn omits_the_mark_instead_of_stamping_it_with_the_current_time() {
    let marks =
        ticker(r#"{"bid":"9990","ask":"10010","last":"10000"}"#).marks(&["BTC".to_owned()], "USDT");
    assert!(!marks.contains_key("BTC"));
}

#[test]
fn still_returns_a_mark_when_the_ticker_states_its_own_time() {
    let stamp = t0().0;
    let marks = ticker(&format!(
        r#"{{"bid":"9990","ask":"10010","last":"10000","timestamp":{stamp}}}"#
    ))
    .marks(&["BTC".to_owned()], "USDT");
    assert_eq!(marks.get("BTC").map(|m| m.mark.as_of.0), Some(stamp));
}

fn releases(k: &Kit) -> usize {
    k.ledger.posts("loanCollateralRelease").len()
}

/// The release post dropped once before the ledger commits: the call fails naming the dropped connection.
fn drop_first_release(k: &Kit, loan_id: &str, event_id: &str) {
    k.ledger.drop_next(
        "bank.loan.collateral.release:",
        "connection reset before the ledger committed",
    );
    let e = k
        .d(|d| service::release_excess(d, loan_id, event_id, amt("2")))
        .unwrap_err();
    assert!(text_of(&e).contains("connection reset"), "{e:?}");
}

#[test]
fn refuses_the_re_drive_after_the_price_fell_and_posts_nothing() {
    let Some(k) = Kit::new() else { return };
    // 3 BTC at 10000, debt 5000, cap 50%: releasing 2 BTC leaves exactly the cap.
    let opened = seed_open_loan(&k, "3");
    let event_id = uuid();
    drop_first_release(&k, &opened.loan.id, &event_id);
    assert_eq!(releases(&k), 0);

    // The price falls. Releasing 2 BTC now would leave 1 BTC at 6000 against 5000 of debt.
    k.prices.btc("6000");
    k.prices.stamp(urgent_later());
    let e = k
        .at(urgent_later(), |d| {
            service::release_excess(d, &opened.loan.id, &event_id, amt("2"))
        })
        .unwrap_err();
    assert_eq!(code(&e), "bank.ltv_exceeded");
    assert_eq!(releases(&k), 0);
}

#[test]
fn still_re_drives_the_same_release_when_the_cap_still_holds() {
    let Some(k) = Kit::new() else { return };
    let opened = seed_open_loan(&k, "3");
    let event_id = uuid();
    drop_first_release(&k, &opened.loan.id, &event_id);
    let (tx, _) = k
        .d(|d| service::release_excess(d, &opened.loan.id, &event_id, amt("2")))
        .unwrap();
    assert!(!tx.is_empty());
    assert_eq!(releases(&k), 1);
}

// ===============================================================================================================
// ops/loan-products.db.test.ts: ops.createLoanProduct (BK-loan-02)

const CREATE_PRODUCT: &str = "bank.ops.createLoanProduct";
const OWNER: &str = BORROWER;

/// `terms(over)`: TEST terms only, not an owner value.
fn product_terms(over: &[(&str, Json)]) -> Json {
    let mut t = obj(&[
        ("productId", Json::str(uuid())),
        ("name", st("TEST BTC-backed USDT")),
        ("debtAssetId", st("USDT")),
        ("collateralAssetId", st("BTC")),
        ("quoteAssetId", st("USDT")),
        ("aprBps", Json::int(900)),
        ("maxLtvBps", Json::int(5_000)),
        ("minPrincipal", st("0")),
        ("marginCallLtvBps", Json::int(7_000)),
        ("liquidationLtvBps", Json::int(8_000)),
        ("insolvencyLtvBps", Json::int(9_000)),
        ("targetLtvBps", Json::int(6_000)),
        ("penaltyBps", Json::int(500)),
        ("maxTrancheBps", Json::int(5_000)),
        ("graceSeconds", Json::int(3_600)),
    ]);
    for (k, v) in over {
        t = set(&t, k, v.clone());
    }
    t
}

/// `createLoanProductFields(input)`.
fn product_fields(t: &Json) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for k in [
        "productId",
        "name",
        "debtAssetId",
        "collateralAssetId",
        "quoteAssetId",
        "aprBps",
        "maxLtvBps",
    ] {
        out.push(f(k, &s(t, k)));
    }
    out.push(f("minPrincipal", &fmt(amt(&s(t, "minPrincipal")))));
    for k in [
        "marginCallLtvBps",
        "liquidationLtvBps",
        "insolvencyLtvBps",
        "targetLtvBps",
        "penaltyBps",
        "maxTrancheBps",
        "graceSeconds",
    ] {
        out.push(f(k, &s(t, k)));
    }
    out
}

/// `{ ...input, ...approvals.issue(bound) }`.
fn issued(k: &Kit, input: &Json, bound: &Json) -> Json {
    with_approval(input, &k.desk.issue(CREATE_PRODUCT, &product_fields(bound)))
}

fn create(k: &Kit, input: &Json) -> Answer {
    call(
        &k.door(),
        OPERATOR,
        TREASURY,
        "ops.createLoanProduct",
        input,
    )
}

fn products(k: &Kit) -> i64 {
    k.count("SELECT count(*) FROM bank.loan_products")
}

#[test]
fn creates_the_product_with_every_term_names_the_approver_and_lists_it_to_customers() {
    let Some(k) = Kit::new() else { return };
    let input = product_terms(&[]);
    let created = create(&k, &issued(&k, &input, &input)).ok();
    assert_eq!(
        created,
        obj(&[
            ("productId", st(&s(&input, "productId"))),
            ("status", st("open")),
            ("aprBps", Json::int(900)),
            ("maxLtvBps", Json::int(5_000)),
            ("minPrincipal", st("0")),
            ("replayed", Json::Bool(false)),
            ("approvedBy", st(APPROVER)),
        ])
    );
    let stored = space::with(&k.store, |c| model::product(c, &s(&input, "productId"))).unwrap();
    let p = stored.policy;
    assert_eq!(
        (
            p.margin_call_ltv_bps,
            p.liquidation_ltv_bps,
            p.insolvency_ltv_bps,
            p.target_ltv_bps,
            p.penalty_bps,
            p.max_tranche_bps,
            p.grace_seconds
        ),
        (7_000, 8_000, 9_000, 6_000, 500, 5_000, 3_600)
    );
}

#[test]
fn a_retry_with_the_same_id_and_terms_replays_the_same_id_with_other_terms_conflicts() {
    let Some(k) = Kit::new() else { return };
    let input = product_terms(&[]);
    create(&k, &issued(&k, &input, &input)).ok();
    let again = create(&k, &issued(&k, &input, &input)).ok();
    assert_eq!(s(&again, "replayed"), "true");
    let changed = set(&input, "aprBps", Json::int(1_000));
    let a = create(&k, &issued(&k, &changed, &changed));
    assert_eq!(a.trpc(), "CONFLICT", "{a:?}");
    assert_eq!(products(&k), 1);
}

#[test]
fn refuses_with_no_approval_or_an_approval_bound_to_other_terms_and_writes_nothing() {
    let Some(k) = Kit::new() else { return };
    let input = product_terms(&[]);
    let a = create(&k, &input);
    assert_ne!(a.0, 200, "{a:?}");
    let other = set(&input, "aprBps", Json::int(0));
    let a = create(&k, &issued(&k, &input, &other));
    assert_ne!(a.0, 200, "{a:?}");
    assert_eq!(products(&k), 0);
}

#[test]
fn refuses_each_bad_term_with_bank_loan_params_invalid_before_consuming_an_approval() {
    let cases: [(&str, (&str, Json)); 11] = [
        ("LTV out of order", ("marginCallLtvBps", Json::int(4_000))),
        (
            "target at or above margin call",
            ("targetLtvBps", Json::int(7_000)),
        ),
        (
            "same debt and collateral asset",
            ("collateralAssetId", st("USDT")),
        ),
        ("blank name", ("name", st("   "))),
        ("negative apr", ("aprBps", Json::int(-1))),
        ("apr above 100%", ("aprBps", Json::int(10_001))),
        ("zero max LTV", ("maxLtvBps", Json::int(0))),
        ("penalty of 100% or more", ("penaltyBps", Json::int(10_000))),
        (
            "insolvency above 100%",
            ("insolvencyLtvBps", Json::int(10_001)),
        ),
        ("zero tranche", ("maxTrancheBps", Json::int(0))),
        ("negative grace", ("graceSeconds", Json::int(-1))),
    ];
    let Some(k) = Kit::new() else { return };
    for (label, (key, value)) in cases {
        let input = product_terms(&[(key, value)]);
        let a = create(&k, &issued(&k, &input, &input));
        assert_eq!(a.trpc(), "BAD_REQUEST", "{label}: {a:?}");
        assert!(
            a.message().contains("Loan product terms are invalid"),
            "{label}: {a:?}"
        );
        assert_eq!(k.desk.consumed(), 0, "{label}");
        assert_eq!(products(&k), 0, "{label}");
    }
}

#[test]
fn a_blank_minimum_principal_is_refused_not_defaulted() {
    let Some(k) = Kit::new() else { return };
    let input = product_terms(&[]);
    let a = create(&k, &issued(&k, &without(&input, "minPrincipal"), &input));
    assert_eq!(a.trpc(), "BAD_REQUEST", "{a:?}");
    let a = create(
        &k,
        &issued(&k, &set(&input, "minPrincipal", st("")), &input),
    );
    assert_eq!(a.trpc(), "BAD_REQUEST", "{a:?}");
}

#[test]
fn a_read_only_operator_and_a_customer_cannot_create_a_product() {
    let Some(k) = Kit::new() else { return };
    let input = product_terms(&[]);
    let door = k.door();
    let a = call(
        &door,
        OPERATOR,
        &["admin:read"],
        "ops.createLoanProduct",
        &issued(&k, &input, &input),
    );
    assert_eq!(a.trpc(), "FORBIDDEN", "{a:?}");
    let a = call(
        &door,
        OWNER,
        CUSTOMER,
        "ops.createLoanProduct",
        &issued(&k, &input, &input),
    );
    assert_eq!(a.trpc(), "FORBIDDEN", "{a:?}");
}

#[test]
fn ops_reconcile_loan_reserve_answers_a_reserve_that_holds_more_than_was_recorded_as_funded_drift_is_signed_never_a_500()
 {
    let Some(k) = Kit::new() else { return };
    // Value reaches the reserve without the bank's funding row (as a ledger-only post does): funded 0, reserve 5.
    k.fund(OWNER, "USDC", "5");
    k.ledger
        .post(
            "loanReserveFund",
            &obj(&[
                ("fundingId", Json::str(format!("f:{}", uuid()))),
                ("debtAssetId", st("USDC")),
                ("amount", st("5")),
                (
                    "from",
                    obj(&[
                        ("ownerType", st("user")),
                        ("ownerId", st(OWNER)),
                        ("assetId", st("USDC")),
                        ("kind", st("available")),
                    ]),
                ),
            ]),
        )
        .unwrap();
    let read = call(
        &k.door(),
        OPERATOR,
        TREASURY,
        "ops.reconcileLoanReserve",
        &obj(&[("debtAssetId", st("USDC"))]),
    )
    .ok();
    assert_eq!(s(&read, "reserveBalance"), "5");
    assert_eq!(s(&read, "funded"), "0");
    assert_eq!(s(&read, "outstandingPrincipal"), "0");
    assert_eq!(s(&read, "drift"), "-5");
}

// ===============================================================================================================
// ops/bank-ops.db.test.ts: the loan test

#[test]
fn bands_the_loan_book_at_the_opening_thresholds_and_refuses_a_customer() {
    let Some(k) = Kit::new() else { return };
    k.prices.set(&[("BTC", "1", None)]);
    let product = k.product();
    let borrower = OWNER;
    k.fund(borrower, "BTC", "30");
    let wall = system_now();
    // (id, debt asset, principal, collateral, status, opened at)
    let rows: Vec<(String, &str, &str, &str, &str, Instant)> = vec![
        (uuid(), "USDT", "1", "2", "active", wall),
        (uuid(), "USDT", "3", "4", "active", wall),
        (uuid(), "USDT", "17", "20", "active", wall),
        (uuid(), "USDC", "5", "1", "active", wall),
        (uuid(), "USDT", "7", "1", "pending", plus(wall, -HOUR)),
        (uuid(), "USDT", "8", "1", "pending", plus(wall, -60_000)),
    ];
    for (id, debt, principal, collateral, status, opened) in &rows {
        k.sql(&format!(
            "INSERT INTO bank.loans (
               id, product_id, user_id, debt_asset_id, collateral_asset_id, quote_asset_id, apr_bps, principal, status,
               opened_at, margin_call_ltv_bps, liquidation_ltv_bps
             ) VALUES (
               '{id}', '{}', '{borrower}', '{debt}', 'BTC', 'USDT', 1000, '{principal}'::numeric,
               '{status}'::bank.loan_status, '{}'::timestamptz, 7500, 8500
             )",
            product.id,
            opened.iso()
        ));
        if *status == "active" {
            k.ledger
                .post(
                    "loanCollateralLock",
                    &obj(&[
                        ("loanId", st(id)),
                        ("userId", st(borrower)),
                        ("collateralAssetId", st("BTC")),
                        ("amount", st(collateral)),
                        ("sequence", Json::int(0)),
                    ]),
                )
                .unwrap();
        }
    }
    k.sql(&format!(
        "UPDATE bank.loan_products SET margin_call_ltv_bps = 8000, liquidation_ltv_bps = 9000 WHERE id = '{}'",
        product.id
    ));
    // `fixedPriceSource({ BTC: { price: '1' } })` stamps its marks with the wall clock.
    k.prices.stamp(system_now());

    let door = k.door();
    let book = query(&door, OPERATOR, &["admin:read"], "ops.loanBook").ok();
    assert_eq!(s(&book, "openCount"), "4", "{}", book.compact());
    assert_eq!(
        book.get("bands"),
        Some(&obj(&[
            ("healthy", Json::int(1)),
            ("marginCall", Json::int(1)),
            ("liquidation", Json::int(1)),
            ("unpriced", Json::int(1)),
        ]))
    );
    assert_eq!(
        book.get("unpriced"),
        Some(&Json::Array(vec![obj(&[
            ("loanId", st(&rows[3].0)),
            ("reason", st("bank.loan_health_price_unset")),
        ])]))
    );
    assert_eq!(
        book.get("outstandingPrincipal"),
        Some(&Json::Array(vec![
            obj(&[("assetId", st("USDC")), ("amount", st("5"))]),
            obj(&[("assetId", st("USDT")), ("amount", st("21"))]),
        ]))
    );
    let oldest = book.get("oldestPending").unwrap();
    assert_eq!(s(oldest, "id"), rows[4].0);
    let age: f64 = s(oldest, "ageSeconds").parse().unwrap();
    assert!((3_590.0..3_700.0).contains(&age), "{age}");
    assert!(!book.compact().contains(borrower));
    assert_eq!(fmt(amt("1") + amt("3") + amt("17")), "21");

    let a = query(&door, OWNER, &["bank:read"], "ops.loanBook");
    assert_eq!(a.trpc(), "FORBIDDEN", "{a:?}");
}
