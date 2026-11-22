//! LOAN-05 (`loans/loan-adjustments.ts`): interest corrections, the loan's interest rows, and the per-loan check
//! against the ledger.
//!
//! A correction is a new row in `bank.loan_adjustments`, never an edit of a past day; it moves no value and
//! `outstanding` adds it to the interest leg. Taking off more interest than is owed now is refused. The ledger check
//! rebuilds each settled draw, repayment and collateral movement's legs as its recipe books them and compares them with
//! the transaction the ledger booked under that row's id. It reads; it never repairs.

use std::collections::HashMap;

use postgres::{GenericClient, IsolationLevel};
use service_kit::json::Json;
use service_kit::money::{Amount, format_amount, parse_amount};
use service_kit::time::Instant;

use super::model::{Loan, ms, outstanding};
use super::ports::Deps;
use super::service::{
    collateral_account, draw_key, instant_f64, lock_key, release_key, repay_key, reserve_account,
};
use crate::errors::Refusal;
use crate::partner::refuse;
use crate::spaces::ports::LedgerAccount;
use crate::spaces::space::{in_tx, pg, with};

pub const ADJUST_LOAN_INTEREST_ACTION: &str = "bank.adjust_loan_interest";

/// The most accrual days the interest rows list, newest first. Older days are counted, never cut silently.
pub const INTEREST_ROWS_LISTED: i64 = 366;

fn amount_text(s: &str) -> Result<Amount, Refusal> {
    parse_amount(s).map_err(Refusal::Other)
}

/// What the founders proposed.
#[derive(Debug, Clone)]
pub struct Terms {
    pub adjustment_id: String,
    pub loan_id: String,
    /// Signed decimal string, exactly as proposed: part of the approval's hash.
    pub amount: String,
    pub reason: String,
}

/// The fields the four-eyes approval binds.
pub fn approval_fields(t: &Terms) -> Json {
    Json::obj([
        ("loanId", Json::str(t.loan_id.clone())),
        ("adjustmentId", Json::str(t.adjustment_id.clone())),
        ("amount", Json::str(t.amount.clone())),
        ("reason", Json::str(t.reason.clone())),
    ])
}

fn invalid(message: &str) -> Refusal {
    refuse("bank.correction_invalid", message)
}

/// `signedAmountString`: `^-?\d+(\.\d{1,18})?$`.
pub fn signed_amount_shaped(s: &str) -> bool {
    let body = s.strip_prefix('-').unwrap_or(s);
    let (whole, frac) = body.split_once('.').unwrap_or((body, ""));
    let digits = |x: &str| !x.is_empty() && x.bytes().all(|b| b.is_ascii_digit());
    digits(whole) && (!body.contains('.') || (digits(frac) && frac.len() <= 18))
}

/// `parseCorrection`: a signed, non-zero amount and a reason of 3 to 500 characters with no outer spaces.
pub fn parse_correction(t: &Terms) -> Result<(Amount, String), Refusal> {
    if !signed_amount_shaped(&t.amount) {
        return Err(invalid(
            "An interest correction needs a signed decimal amount",
        ));
    }
    let amount = amount_text(&t.amount)?;
    if amount == 0 {
        return Err(invalid("An interest correction of zero changes nothing"));
    }
    let reason = service_kit::money::js_trim(&t.reason).to_owned();
    // Counted in characters, as the database CHECK counts them.
    let length = reason.chars().count();
    if !(3..=500).contains(&length) {
        return Err(invalid(
            "An interest correction needs a reason of 3 to 500 characters",
        ));
    }
    if reason != t.reason {
        return Err(invalid(
            "An interest correction reason has no leading or trailing spaces",
        ));
    }
    Ok((amount, reason))
}

/// A correction row.
#[derive(Debug, Clone)]
pub struct Adjustment {
    pub id: String,
    pub loan_id: String,
    pub amount: Amount,
    pub reason: String,
    pub proposed_by: String,
    pub approved_by: String,
    pub approval_id: String,
    pub created_at: Instant,
}

impl Adjustment {
    pub fn json(&self) -> Json {
        Json::obj([
            ("id", Json::str(self.id.clone())),
            ("loanId", Json::str(self.loan_id.clone())),
            ("kind", Json::str("interest_correction")),
            ("amount", Json::str(format_amount(self.amount))),
            ("reason", Json::str(self.reason.clone())),
            ("proposedBy", Json::str(self.proposed_by.clone())),
            ("approvedBy", Json::str(self.approved_by.clone())),
            ("approvalId", Json::str(self.approval_id.clone())),
            ("createdAt", Json::str(self.created_at.iso())),
        ])
    }
}

fn adjustment_cols() -> String {
    format!(
        "id::text, loan_id::text, amount::text, reason, proposed_by, approved_by, approval_id, {}",
        ms("created_at")
    )
}

fn adjustment_of(r: &postgres::Row) -> Result<Adjustment, Refusal> {
    let g = |i: usize| -> Result<String, Refusal> { r.try_get(i).map_err(|e| pg(&e)) };
    Ok(Adjustment {
        id: g(0)?,
        loan_id: g(1)?,
        amount: amount_text(&g(2)?)?,
        reason: g(3)?,
        proposed_by: g(4)?,
        approved_by: g(5)?,
        approval_id: g(6)?,
        created_at: Instant(r.try_get(7).map_err(|e| pg(&e))?),
    })
}

/// `adjustmentById`.
pub fn by_id(c: &mut impl GenericClient, id: &str) -> Result<Option<Adjustment>, Refusal> {
    c.query(
        &format!(
            "SELECT {} FROM bank.loan_adjustments WHERE id = $1::text::uuid",
            adjustment_cols()
        ),
        &[&id],
    )
    .map_err(|e| pg(&e))?
    .first()
    .map(adjustment_of)
    .transpose()
}

/// `assertSameCorrection`.
pub fn assert_same(prior: &Adjustment, t: &Terms) -> Result<(), Refusal> {
    let (amount, reason) = parse_correction(t)?;
    if prior.loan_id != t.loan_id || prior.amount != amount || prior.reason != reason {
        return Err(refuse(
            "bank.correction_conflict",
            format!("Correction {} already exists with other terms", prior.id),
        ));
    }
    Ok(())
}

/// `assertCorrectable`: every refusal a correction can meet, read on `c`.
fn assert_correctable(
    c: &mut impl GenericClient,
    loan_id: &str,
    amount: Amount,
) -> Result<(), Refusal> {
    let rows = c
        .query(
            "SELECT status::text FROM bank.loans WHERE id = $1::text::uuid",
            &[&loan_id],
        )
        .map_err(|e| pg(&e))?;
    let Some(r) = rows.first() else {
        return Err(refuse("bank.loan_not_found", format!("No loan {loan_id}")));
    };
    let status: String = r.try_get(0).map_err(|e| pg(&e))?;
    match status.as_str() {
        "repaid" | "liquidated" => {
            return Err(refuse(
                "bank.loan_closed",
                format!("Loan {loan_id} is {status}"),
            ));
        }
        "pending" => {
            return Err(refuse(
                "bank.loan_not_drawable",
                format!("Loan {loan_id} has no drawn principal"),
            ));
        }
        "liquidating" => {
            return Err(refuse(
                "bank.loan_liquidating",
                format!("Loan {loan_id} is mid-liquidation"),
            ));
        }
        _ => {}
    }
    // A repayment or sale whose outcome is unknown split its money against the interest owed before this correction.
    let r = c
        .query_one(
            "SELECT (SELECT COUNT(*) FROM bank.loan_repayments WHERE loan_id = $1::text::uuid AND status = 'pending')::int8,
                    (SELECT COUNT(*) FROM bank.loan_liquidations WHERE loan_id = $1::text::uuid AND status = 'pending')::int8,
                    (SELECT COUNT(*) FROM bank.loan_liquidations
                      WHERE loan_id = $1::text::uuid AND status = 'settled' AND shortfall > 0
                        AND bad_debt_ledger_tx_id IS NULL)::int8",
            &[&loan_id],
        )
        .map_err(|e| pg(&e))?;
    let n = |i: usize| -> Result<i64, Refusal> { r.try_get(i).map_err(|e| pg(&e)) };
    if n(0)? > 0 {
        return Err(refuse(
            "bank.ledger_outcome_unknown",
            format!("Loan {loan_id} has a repayment whose ledger outcome is not known yet"),
        ));
    }
    if n(1)? > 0 || n(2)? > 0 {
        return Err(refuse(
            "bank.loan_liquidating",
            format!("Loan {loan_id} has a sale or an uncovered shortfall still open"),
        ));
    }
    if amount < 0 {
        let debt = outstanding(c, loan_id)?;
        if -amount > debt.interest {
            return Err(refuse(
                "bank.correction_exceeds_interest",
                format!(
                    "Loan {loan_id} owes {} interest now; a correction cannot take off more",
                    format_amount(debt.interest)
                ),
            ));
        }
    }
    Ok(())
}

/// `checkCorrection`: the non-locking pre-check, run before the approval is spent.
pub fn check(d: &Deps<'_>, t: &Terms) -> Result<(), Refusal> {
    let (amount, _) = parse_correction(t)?;
    with(d.store, |c| assert_correctable(c, &t.loan_id, amount))
}

/// Who proposed and approved a correction.
pub struct People<'a> {
    pub proposed_by: &'a str,
    pub approved_by: &'a str,
    pub approval_id: &'a str,
}

/// `writeCorrection`: one approved correction under the loan row lock, which repay's claim also takes. The same id
/// with the same terms answers the first row and writes nothing.
pub fn write(
    d: &Deps<'_>,
    t: &Terms,
    people: &People<'_>,
    now: Instant,
) -> Result<(Adjustment, bool), Refusal> {
    let (amount, reason) = parse_correction(t)?;
    in_tx(d.store, |tx| {
        let locked = tx
            .query(
                "SELECT id FROM bank.loans WHERE id = $1::text::uuid FOR UPDATE",
                &[&t.loan_id],
            )
            .map_err(|e| pg(&e))?;
        if locked.is_empty() {
            return Err(refuse(
                "bank.loan_not_found",
                format!("No loan {}", t.loan_id),
            ));
        }
        if let Some(prior) = by_id(tx, &t.adjustment_id)? {
            assert_same(&prior, t)?;
            return Ok((prior, true));
        }
        assert_correctable(tx, &t.loan_id, amount)?;
        let rows = tx
            .query(
                &format!(
                    "INSERT INTO bank.loan_adjustments
                       (id, loan_id, kind, amount, reason, proposed_by, approved_by, approval_id, created_at)
                     VALUES ($1::text::uuid, $2::text::uuid, 'interest_correction', $3::text::numeric, $4, $5, $6, $7,
                             to_timestamp($8::float8 / 1000))
                     ON CONFLICT (id) DO NOTHING
                     RETURNING {}",
                    adjustment_cols()
                ),
                &[
                    &t.adjustment_id,
                    &t.loan_id,
                    &format_amount(amount),
                    &reason,
                    &people.proposed_by,
                    &people.approved_by,
                    &people.approval_id,
                    &instant_f64(now),
                ],
            )
            .map_err(|e| pg(&e))?;
        if let Some(r) = rows.first() {
            return Ok((adjustment_of(r)?, false));
        }
        // The same id written for another loan: the first row stands.
        let Some(other) = by_id(tx, &t.adjustment_id)? else {
            return Err(refuse(
                "bank.correction_conflict",
                format!("Correction {} could not be written", t.adjustment_id),
            ));
        };
        assert_same(&other, t)?;
        Ok((other, true))
    })
}

/// `readInterestRows`: accrual days newest first, corrections, and the totals they add up to, in one snapshot.
pub fn interest_rows(d: &Deps<'_>, l: &Loan) -> Result<Json, Refusal> {
    with(d.store, |c| {
        let mut tx = c
            .build_transaction()
            .isolation_level(IsolationLevel::RepeatableRead)
            .read_only(true)
            .start()
            .map_err(|e| pg(&e))?;
        let mut days = Vec::new();
        for r in tx
            .query(
                "SELECT accrual_date::text, rate_bps::int8, principal_basis::text, interest_amount::text
                   FROM bank.loan_interest_accruals WHERE loan_id = $1::text::uuid
                  ORDER BY accrual_date DESC LIMIT $2",
                &[&l.id, &INTEREST_ROWS_LISTED],
            )
            .map_err(|e| pg(&e))?
        {
            days.push(Json::obj([
                ("date", Json::str(r.try_get::<_, String>(0).map_err(|e| pg(&e))?)),
                ("rateBps", Json::int(r.try_get::<_, i64>(1).map_err(|e| pg(&e))?)),
                (
                    "basis",
                    Json::str(format_amount(amount_text(&r.try_get::<_, String>(2).map_err(|e| pg(&e))?)?)),
                ),
                (
                    "interest",
                    Json::str(format_amount(amount_text(&r.try_get::<_, String>(3).map_err(|e| pg(&e))?)?)),
                ),
            ]));
        }
        let totals = tx
            .query_one(
                "SELECT COUNT(*)::int8, COALESCE(SUM(interest_amount), 0)::text
                   FROM bank.loan_interest_accruals WHERE loan_id = $1::text::uuid",
                &[&l.id],
            )
            .map_err(|e| pg(&e))?;
        let mut corrected: Amount = 0;
        let mut corrections = Vec::new();
        for r in tx
            .query(
                &format!(
                    "SELECT id::text, {}, amount::text, reason FROM bank.loan_adjustments
                      WHERE loan_id = $1::text::uuid AND kind = 'interest_correction'
                      ORDER BY created_at DESC, id ASC",
                    ms("created_at")
                ),
                &[&l.id],
            )
            .map_err(|e| pg(&e))?
        {
            let amount = amount_text(&r.try_get::<_, String>(2).map_err(|e| pg(&e))?)?;
            corrected += amount;
            corrections.push(Json::obj([
                (
                    "id",
                    Json::str(r.try_get::<_, String>(0).map_err(|e| pg(&e))?),
                ),
                (
                    "at",
                    Json::str(Instant(r.try_get(1).map_err(|e| pg(&e))?).iso()),
                ),
                ("amount", Json::str(format_amount(amount))),
                (
                    "reason",
                    Json::str(r.try_get::<_, String>(3).map_err(|e| pg(&e))?),
                ),
            ]));
        }
        let paid = tx
            .query_one(
                "SELECT ((SELECT COALESCE(SUM(interest_amount), 0) FROM bank.loan_repayments
                           WHERE loan_id = $1::text::uuid AND status = 'settled')
                       + (SELECT COALESCE(SUM(interest_repaid), 0) FROM bank.loan_liquidations
                           WHERE loan_id = $1::text::uuid AND status = 'settled'))::text",
                &[&l.id],
            )
            .map_err(|e| pg(&e))?;
        let owed = outstanding(&mut tx, &l.id)?.interest;
        tx.commit().map_err(|e| pg(&e))?;
        let all: i64 = totals.try_get(0).map_err(|e| pg(&e))?;
        let listed = i64::try_from(days.len()).unwrap_or(i64::MAX);
        Ok(Json::obj([
            ("loanId", Json::str(l.id.clone())),
            ("assetId", Json::str(l.debt_asset_id.clone())),
            ("days", Json::Array(days)),
            ("earlierDays", Json::int(all - listed)),
            ("corrections", Json::Array(corrections)),
            (
                "accrued",
                Json::str(format_amount(amount_text(
                    &totals.try_get::<_, String>(1).map_err(|e| pg(&e))?,
                )?)),
            ),
            ("corrected", Json::str(format_amount(corrected))),
            (
                "paid",
                Json::str(format_amount(amount_text(
                    &paid.try_get::<_, String>(0).map_err(|e| pg(&e))?,
                )?)),
            ),
            ("owed", Json::str(format_amount(owed))),
        ]))
    })
}

// ── The ledger check ─────────────────────────────────────────────────────────────────────────────────────────────────

/// A recipe's expected legs: account, side and amount, as `packages/ledger-client`'s loan recipes book them.
type Legs = Vec<(LedgerAccount, &'static str, Amount)>;

fn collateral_legs(l: &Loan, amount: Amount, release: bool) -> Legs {
    let user = LedgerAccount::user_available(&l.user_id, &l.collateral_asset_id);
    let pot = collateral_account(&l.user_id, &l.collateral_asset_id, &l.id);
    if release {
        vec![(pot, "credit", amount), (user, "debit", amount)]
    } else {
        vec![(user, "credit", amount), (pot, "debit", amount)]
    }
}

fn draw_legs(l: &Loan) -> Legs {
    vec![
        (reserve_account(&l.debt_asset_id), "credit", l.principal),
        (
            LedgerAccount::user_available(&l.user_id, &l.debt_asset_id),
            "debit",
            l.principal,
        ),
    ]
}

fn repay_legs(l: &Loan, principal: Amount, interest: Amount) -> Legs {
    let mut legs = vec![(
        LedgerAccount::user_available(&l.user_id, &l.debt_asset_id),
        "credit",
        principal + interest,
    )];
    if principal > 0 {
        legs.push((reserve_account(&l.debt_asset_id), "debit", principal));
    }
    if interest > 0 {
        legs.push((
            super::service::house_fees(&l.debt_asset_id),
            "debit",
            interest,
        ));
    }
    legs
}

struct Check {
    kind: &'static str,
    reference: String,
    tx_id: Option<String>,
    key: String,
    legs: Option<Legs>,
}

fn mismatch(kind: &str, reference: &str, problem: &str, expected: &str, found: &str) -> Json {
    Json::obj([
        ("kind", Json::str(kind)),
        ("ref", Json::str(reference)),
        ("problem", Json::str(problem)),
        ("expected", Json::str(expected)),
        ("found", Json::str(found)),
    ])
}

/// `checkLoanLedger`: each settled row against the transaction booked under its id, leg by leg (a sale and its bad
/// debt by key only), and the collateral pot against the settled locks, releases and sales. While any move is pending,
/// or the pot moved while the check read it, the pot is not compared and the answer is `pending`.
#[allow(
    clippy::too_many_lines,
    reason = "one check, read in the TypeScript's order"
)]
pub fn ledger_check(d: &Deps<'_>, l: &Loan, now: Instant) -> Result<Json, Refusal> {
    let pot = collateral_account(&l.user_id, &l.collateral_asset_id, &l.id);
    let held = d.ledger.balance(&pot).map_err(Refusal::Other)?;
    let mut checks: Vec<Check> = Vec::new();
    if let Some(tx) = &l.draw_ledger_tx_id {
        checks.push(Check {
            kind: "draw",
            reference: l.id.clone(),
            tx_id: Some(tx.clone()),
            key: draw_key(&l.id),
            legs: Some(draw_legs(l)),
        });
    }
    let (locked, released, sold, pending) = with(d.store, |c| {
        let mut tx = c
            .build_transaction()
            .isolation_level(IsolationLevel::RepeatableRead)
            .read_only(true)
            .start()
            .map_err(|e| pg(&e))?;
        for r in tx
            .query(
                "SELECT sequence::int8, interest_amount::text, principal_amount::text, ledger_tx_id
                   FROM bank.loan_repayments WHERE loan_id = $1::text::uuid AND status = 'settled' ORDER BY sequence",
                &[&l.id],
            )
            .map_err(|e| pg(&e))?
        {
            let seq: i64 = r.try_get(0).map_err(|e| pg(&e))?;
            let interest = amount_text(&r.try_get::<_, String>(1).map_err(|e| pg(&e))?)?;
            let principal = amount_text(&r.try_get::<_, String>(2).map_err(|e| pg(&e))?)?;
            checks.push(Check {
                kind: "repayment",
                reference: seq.to_string(),
                tx_id: r.try_get(3).map_err(|e| pg(&e))?,
                key: repay_key(&l.id, seq),
                legs: Some(repay_legs(l, principal, interest)),
            });
        }
        let (mut locked, mut released, mut sold): (Amount, Amount, Amount) = (0, 0, 0);
        for r in tx
            .query(
                "SELECT sequence::int8, direction::text, amount::text, ledger_tx_id
                   FROM bank.loan_collateral_events WHERE loan_id = $1::text::uuid AND status = 'settled' ORDER BY sequence",
                &[&l.id],
            )
            .map_err(|e| pg(&e))?
        {
            let seq: i64 = r.try_get(0).map_err(|e| pg(&e))?;
            let release = r.try_get::<_, String>(1).map_err(|e| pg(&e))? == "release";
            let amount = amount_text(&r.try_get::<_, String>(2).map_err(|e| pg(&e))?)?;
            if release {
                released += amount;
            } else {
                locked += amount;
            }
            checks.push(Check {
                kind: if release {
                    "collateral_release"
                } else {
                    "collateral_lock"
                },
                reference: seq.to_string(),
                tx_id: r.try_get(3).map_err(|e| pg(&e))?,
                key: if release {
                    release_key(&l.id, seq)
                } else {
                    lock_key(&l.id, seq)
                },
                legs: Some(collateral_legs(l, amount, release)),
            });
        }
        for r in tx
            .query(
                "SELECT tranche::int8, collateral_sold::text, ledger_tx_id, bad_debt_ledger_tx_id
                   FROM bank.loan_liquidations WHERE loan_id = $1::text::uuid AND status = 'settled' ORDER BY tranche",
                &[&l.id],
            )
            .map_err(|e| pg(&e))?
        {
            let tranche: i64 = r.try_get(0).map_err(|e| pg(&e))?;
            sold += amount_text(&r.try_get::<_, String>(1).map_err(|e| pg(&e))?)?;
            checks.push(Check {
                kind: "liquidation",
                reference: tranche.to_string(),
                tx_id: r.try_get(2).map_err(|e| pg(&e))?,
                key: super::service::liquidate_key(&l.id, tranche),
                legs: None,
            });
            if let Some(bad) = r.try_get::<_, Option<String>>(3).map_err(|e| pg(&e))? {
                checks.push(Check {
                    kind: "bad_debt",
                    reference: tranche.to_string(),
                    tx_id: Some(bad),
                    key: super::service::bad_debt_key(&l.id),
                    legs: None,
                });
            }
        }
        let pending: i64 = tx
            .query_one(
                "SELECT ((SELECT COUNT(*) FROM bank.loan_repayments WHERE loan_id = $1::text::uuid AND status = 'pending')
                       + (SELECT COUNT(*) FROM bank.loan_collateral_events WHERE loan_id = $1::text::uuid AND status = 'pending')
                       + (SELECT COUNT(*) FROM bank.loan_liquidations WHERE loan_id = $1::text::uuid AND status = 'pending'))::int8",
                &[&l.id],
            )
            .map_err(|e| pg(&e))?
            .try_get(0)
            .map_err(|e| pg(&e))?;
        tx.commit().map_err(|e| pg(&e))?;
        Ok((locked, released, sold, pending))
    })?;
    // Read again: a move that settled between the first read and the snapshot is in flight, never a difference.
    let moved = d.ledger.balance(&pot).map_err(Refusal::Other)? != held;
    let mut ids: HashMap<String, String> = HashMap::new();
    let mut mismatches = Vec::new();
    for c in &checks {
        let tx = match &c.tx_id {
            Some(id) => d.ledger.tx_by_id(id).map_err(Refusal::Other)?,
            None => None,
        };
        let Some(tx) = tx else {
            mismatches.push(mismatch(
                c.kind,
                &c.reference,
                "missing",
                &c.key,
                c.tx_id.as_deref().unwrap_or(""),
            ));
            continue;
        };
        if tx.key != c.key {
            mismatches.push(mismatch(c.kind, &c.reference, "key", &c.key, &tx.key));
            continue;
        }
        let Some(legs) = &c.legs else {
            continue;
        };
        let mut want = Vec::new();
        for (account, side, amount) in legs {
            let key = account.json().compact();
            let id = match ids.get(&key) {
                Some(id) => id.clone(),
                None => {
                    let id = d.ledger.account_id(account).map_err(Refusal::Other)?;
                    ids.insert(key, id.clone());
                    id
                }
            };
            want.push(format!("{id} {side} {}", format_amount(*amount)));
        }
        want.sort();
        let mut got: Vec<String> = tx
            .entries
            .iter()
            .map(|e| {
                format!(
                    "{} {} {}",
                    e.account_id,
                    e.direction,
                    format_amount(e.amount)
                )
            })
            .collect();
        got.sort();
        if want != got {
            mismatches.push(mismatch(
                c.kind,
                &c.reference,
                "entries",
                &want.join("; "),
                &got.join("; "),
            ));
        }
    }
    let expected = locked - released - sold;
    let in_flight = pending > 0 || moved;
    if !in_flight && held != expected {
        mismatches.push(mismatch(
            "collateral_balance",
            &l.id,
            "balance",
            &format_amount(expected),
            &format_amount(held),
        ));
    }
    let status = if !mismatches.is_empty() {
        "differs"
    } else if in_flight {
        "pending"
    } else {
        "agrees"
    };
    Ok(Json::obj([
        ("loanId", Json::str(l.id.clone())),
        ("status", Json::str(status)),
        (
            "checked",
            Json::int(i64::try_from(checks.len()).unwrap_or(i64::MAX)),
        ),
        ("pending", Json::int(pending)),
        ("collateralHeld", Json::str(format_amount(held))),
        ("collateralExpected", Json::str(format_amount(expected))),
        ("mismatches", Json::Array(mismatches)),
        ("checkedAt", Json::str(now.iso())),
    ]))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn terms(amount: &str, reason: &str) -> Terms {
        Terms {
            adjustment_id: "a".to_owned(),
            loan_id: "l".to_owned(),
            amount: amount.to_owned(),
            reason: reason.to_owned(),
        }
    }

    #[test]
    fn a_correction_is_signed_non_zero_and_explained() {
        assert!(parse_correction(&terms("-1.5", "fix day")).is_ok());
        assert!(parse_correction(&terms("0", "fix day")).is_err());
        assert!(parse_correction(&terms("+1", "fix day")).is_err());
        assert!(parse_correction(&terms("1", "ab")).is_err());
        assert!(parse_correction(&terms("1", " fix day")).is_err());
        assert!(parse_correction(&terms("1.0000000000000000001", "fix day")).is_err());
    }
}
