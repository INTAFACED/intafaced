//! `BusinessPayoutsService` (`business/business-payouts.ts`): bulk runs, contractors and their batches, and crypto
//! payroll. Every call names the caller's seat first (`super::super::seat`); what each may do is their permissions on
//! that business.

use std::collections::BTreeSet;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use postgres::error::SqlState;
use postgres::{GenericClient, Row};
use service_kit::json::Json;
use service_kit::money::{Amount, format_amount, parse_amount};
use service_kit::time::Instant;
use sha2::{Digest, Sha256};

use super::csv::{BulkIssue, BulkLine, name_ok, parse_bulk_csv};
use super::{
    MAX_BATCH_INVOICES, MAX_BULK_FILE_BYTES, MAX_PAYROLL_MEMBERS, bulk_pay_key,
    contractor_batch_key, crypto_payroll_key, js_len, js_slice, js_trim,
};
use crate::automations::own_moves::wallet::recover_personal_sign_address;
use crate::business_team::service::{self as seat, Seat};
use crate::errors::Refusal;
use crate::partner::custody::{Held, assert_posting_enabled};
use crate::partner::router::business_account;
use crate::partner::{MoveRequest, Payee, payouts_account, refuse};
use crate::ramps::refs::{compact_upper, is_evm_address_ref, is_iban_ref};
use crate::spaces::space::{at, in_tx, pg, with};
use crate::transfers::Deps;

/// Partner refusals that say nothing moved: the run or batch is declined with the partner's reason and never sent again.
const DEFINITE_REFUSALS: [&str; 5] = [
    "bank.partner_insufficient_funds",
    "bank.partner_move_conflict",
    "bank.partner_amount_invalid",
    "bank.asset_mismatch",
    "bank.account_restricted",
];

// ---------------------------------------------------------------------------------------------------------------
// Reading rows

/// `floor(extract(epoch from <col>) * 1000)::int8`: a time column as JavaScript's `Date` reads it.
fn ms(col: &str) -> String {
    format!("floor(extract(epoch from {col}) * 1000)::int8")
}

fn s(r: &Row, i: usize) -> Result<String, Refusal> {
    r.try_get::<_, String>(i).map_err(|e| pg(&e))
}

fn o(r: &Row, i: usize) -> Result<Option<String>, Refusal> {
    r.try_get::<_, Option<String>>(i).map_err(|e| pg(&e))
}

fn n(r: &Row, i: usize) -> Result<Option<i64>, Refusal> {
    r.try_get::<_, Option<i64>>(i).map_err(|e| pg(&e))
}

fn t(r: &Row, i: usize) -> Result<Option<Instant>, Refusal> {
    Ok(n(r, i)?.map(Instant))
}

fn t0(r: &Row, i: usize) -> Result<Instant, Refusal> {
    Ok(t(r, i)?.unwrap_or(Instant(0)))
}

fn amount(raw: &str) -> Result<Amount, Refusal> {
    parse_amount(raw).map_err(Refusal::Other)
}

fn money(a: Amount) -> Json {
    Json::str(format_amount(a))
}

fn iso(t: Option<Instant>) -> Json {
    t.map_or(Json::Null, |t| Json::str(t.iso()))
}

fn opt(v: Option<&str>) -> Json {
    v.map_or(Json::Null, Json::str)
}

fn int(v: Option<i64>) -> Json {
    v.map_or(Json::Null, Json::int)
}

fn sha256_hex(data: &[u8]) -> String {
    Sha256::digest(data)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

// ---------------------------------------------------------------------------------------------------------------
// Refusals

fn closed() -> Refusal {
    refuse("bank.business_closed", "This business account is closed.")
}

fn no_partner() -> Refusal {
    refuse(
        "bank.no_partner_bank",
        "This business’s money is not held at a partner bank, so nothing can be paid from it.",
    )
}

fn conflict(what: &str) -> Refusal {
    refuse(
        "bank.business_request_conflict",
        format!("This {what} id is already used on different terms."),
    )
}

fn field(message: impl Into<String>) -> Refusal {
    refuse("bank.contractor_field_invalid", message)
}

fn contractor_not_found() -> Refusal {
    refuse(
        "bank.contractor_not_found",
        "No contractor of this business has that id.",
    )
}

fn wallet_missing() -> Refusal {
    refuse(
        "bank.payroll_wallet_missing",
        "Connect the business’s own wallet first: it signs every run.",
    )
}

fn invite_invalid() -> Refusal {
    refuse(
        "bank.contractor_invite_invalid",
        "This onboarding link is not one we know.",
    )
}

/// `need`: the caller's role on this business grants `permission`.
fn need(seat: &Seat, permission: &str) -> Result<(), Refusal> {
    if seat.holds(permission) {
        return Ok(());
    }
    Err(refuse(
        "bank.business_role_forbidden",
        format!(
            "Your role on this business does not include {}, so this was refused. Nothing changed.",
            permission.replacen('_', " ", 1)
        ),
    ))
}

/// `moneyMayMove`: `bank.posting_frozen` while posting is frozen, or while the freeze cannot be read; the refusal is
/// counted.
fn money_may_move(d: &Deps<'_>) -> Result<(), Refusal> {
    assert_posting_enabled(d.custody.freeze, d.store, "bank_move", true)
}

fn seat_of(d: &Deps<'_>, account_id: &str, user_id: &str) -> Result<Seat, Refusal> {
    with(d.store, |c| seat::seat(c, account_id, user_id))
}

/// `partnerFor`: the guarded partner holding the business owner's money, none when no partner holds it.
fn partner_for<'a>(d: &'a Deps<'a>, seat: &Seat) -> Option<Held<'a>> {
    seat.owner_user_id
        .as_deref()
        .and_then(|owner| d.custody.bank_for(owner))
}

/// `accountRow`: the business account's status, name and threshold, in this service's own words.
struct AccountRow {
    name: String,
    status: String,
    spend_threshold: Amount,
}

fn account_row(c: &mut impl GenericClient, account_id: &str) -> Result<AccountRow, Refusal> {
    let rows = c
        .query(
            "SELECT name, status::text, spend_threshold::text FROM bank.business_accounts WHERE id = $1::text::uuid",
            &[&account_id],
        )
        .map_err(|e| pg(&e))?;
    let Some(r) = rows.first() else {
        return Err(refuse(
            "bank.business_not_found",
            "No business account has that id.",
        ));
    };
    Ok(AccountRow {
        name: s(r, 0)?,
        status: s(r, 1)?,
        spend_threshold: amount(&s(r, 2)?)?,
    })
}

/// What one instruction to the partner came to: made (its id, when, and how many recipients the partner took), or a
/// definite refusal (its code and words).
enum Sent {
    Made {
        id: String,
        at: Instant,
        payees: Option<i64>,
    },
    Declined {
        code: String,
        text: String,
    },
}

/// `sendOnce`: one instruction under its key, from the business's account to the partner's outbound payments. A retry
/// first asks the partner for the move under this key, so a lost answer is never sent again blind. A definite refusal
/// is `Declined`; anything else fails, and the row stays `sending` to be read back.
fn send_once(
    d: &Deps<'_>,
    partner: &Held<'_>,
    key: &str,
    account_id: &str,
    asset_id: &str,
    amount: Amount,
    payees: Vec<Payee>,
) -> Result<Sent, Refusal> {
    let made = match partner.move_by_key(key) {
        Some(m) => Ok(m),
        None => partner.move_(
            &MoveRequest {
                key: key.to_owned(),
                from: business_account(account_id, asset_id),
                to: payouts_account(asset_id),
                amount,
                payees: Some(payees),
            },
            d.now,
        ),
    };
    match made {
        Ok(m) => Ok(Sent::Made {
            id: m.id,
            at: m.moved_at,
            payees: m.payees.map(|p| i64::try_from(p.len()).unwrap_or(i64::MAX)),
        }),
        Err(Refusal::Bank(e)) if DEFINITE_REFUSALS.contains(&e.row.code) => Ok(Sent::Declined {
            code: e.row.code.to_owned(),
            text: js_slice(&e.message, 500),
        }),
        Err(e) => Err(e),
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Bulk runs

struct RunRow {
    id: String,
    account_id: String,
    asset_id: String,
    file_sha256: String,
    amount: Amount,
    status: String,
    approvals_needed: i64,
    threshold: Option<Amount>,
    confirmed_by: Option<String>,
    partner_key: String,
    partner_move_id: Option<String>,
    partner_payees: Option<i64>,
    partner_reason: Option<String>,
    partner_reason_text: Option<String>,
    created_at: Instant,
    sent_at: Option<Instant>,
}

fn run_cols() -> String {
    format!(
        "id::text, account_id::text, asset_id, file_sha256, amount::text, status, approvals_needed::int8, \
         threshold::text, confirmed_by, partner_key, partner_move_id, partner_payees::int8, partner_reason, \
         partner_reason_text, {}, {}",
        ms("created_at"),
        ms("sent_at")
    )
}

impl RunRow {
    fn from_row(r: &Row) -> Result<RunRow, Refusal> {
        Ok(RunRow {
            id: s(r, 0)?,
            account_id: s(r, 1)?,
            asset_id: s(r, 2)?,
            file_sha256: s(r, 3)?,
            amount: amount(&s(r, 4)?)?,
            status: s(r, 5)?,
            approvals_needed: n(r, 6)?.unwrap_or(0),
            threshold: o(r, 7)?.map(|v| amount(&v)).transpose()?,
            confirmed_by: o(r, 8)?,
            partner_key: s(r, 9)?,
            partner_move_id: o(r, 10)?,
            partner_payees: n(r, 11)?,
            partner_reason: o(r, 12)?,
            partner_reason_text: o(r, 13)?,
            created_at: t0(r, 14)?,
            sent_at: t(r, 15)?,
        })
    }
}

fn run_row_or_none(
    c: &mut impl GenericClient,
    run_id: &str,
    lock: bool,
) -> Result<Option<RunRow>, Refusal> {
    let rows = c
        .query(
            &format!(
                "SELECT {} FROM bank.business_bulk_runs WHERE id = $1::text::uuid{}",
                run_cols(),
                if lock { " FOR UPDATE" } else { "" }
            ),
            &[&run_id],
        )
        .map_err(|e| pg(&e))?;
    rows.first().map(RunRow::from_row).transpose()
}

fn run_row(c: &mut impl GenericClient, run_id: &str, lock: bool) -> Result<RunRow, Refusal> {
    run_row_or_none(c, run_id, lock)?.ok_or_else(|| {
        refuse(
            "bank.bulk_run_not_found",
            "No bulk payment run of this business has that id.",
        )
    })
}

fn approvals_json(rows: &[Row]) -> Result<Json, Refusal> {
    Ok(Json::Array(
        rows.iter()
            .map(|a| {
                Ok(Json::obj([
                    ("userId", Json::str(s(a, 0)?)),
                    ("approvedAt", iso(t(a, 1)?)),
                ]))
            })
            .collect::<Result<_, Refusal>>()?,
    ))
}

/// `runView` as `bulkRunView` writes it.
fn run_view(c: &mut impl GenericClient, row: &RunRow) -> Result<Json, Refusal> {
    let lines = c
        .query(
            "SELECT line::int8, name, iban, amount::text, reference FROM bank.business_bulk_lines \
              WHERE run_id = $1::text::uuid ORDER BY line",
            &[&row.id],
        )
        .map_err(|e| pg(&e))?;
    let issues = c
        .query(
            "SELECT line::int8, code, detail, raw FROM bank.business_bulk_issues \
              WHERE run_id = $1::text::uuid ORDER BY line",
            &[&row.id],
        )
        .map_err(|e| pg(&e))?;
    let approvals = c
        .query(
            &format!(
                "SELECT approver_user_id, {} FROM bank.business_bulk_approvals \
                  WHERE run_id = $1::text::uuid ORDER BY approved_at",
                ms("approved_at")
            ),
            &[&row.id],
        )
        .map_err(|e| pg(&e))?;
    let lines = lines
        .iter()
        .map(|l| {
            Ok(Json::obj([
                ("line", int(n(l, 0)?)),
                ("name", Json::str(s(l, 1)?)),
                ("iban", Json::str(s(l, 2)?)),
                ("amount", money(amount(&s(l, 3)?)?)),
                ("reference", opt(o(l, 4)?.as_deref())),
            ]))
        })
        .collect::<Result<_, Refusal>>()?;
    let issues = issues
        .iter()
        .map(|i| {
            Ok(Json::obj([
                ("line", int(n(i, 0)?)),
                ("code", Json::str(s(i, 1)?)),
                ("detail", Json::str(s(i, 2)?)),
                ("raw", Json::str(s(i, 3)?)),
            ]))
        })
        .collect::<Result<_, Refusal>>()?;
    Ok(Json::obj([
        ("id", Json::str(row.id.clone())),
        ("accountId", Json::str(row.account_id.clone())),
        ("assetId", Json::str(row.asset_id.clone())),
        ("fileSha256", Json::str(row.file_sha256.clone())),
        ("status", Json::str(row.status.clone())),
        ("total", money(row.amount)),
        ("lines", Json::Array(lines)),
        ("issues", Json::Array(issues)),
        ("threshold", row.threshold.map_or(Json::Null, money)),
        ("approvalsNeeded", Json::int(row.approvals_needed)),
        ("confirmedBy", opt(row.confirmed_by.as_deref())),
        ("approvals", approvals_json(&approvals)?),
        ("partnerKey", Json::str(row.partner_key.clone())),
        ("partnerMoveId", opt(row.partner_move_id.as_deref())),
        ("partnerPayees", int(row.partner_payees)),
        ("partnerReason", opt(row.partner_reason.as_deref())),
        ("partnerReasonText", opt(row.partner_reason_text.as_deref())),
        ("createdAt", Json::str(row.created_at.iso())),
        ("sentAt", iso(row.sent_at)),
    ]))
}

/// `run`: one run, read by a member of its business.
pub fn run(d: &Deps<'_>, run_id: &str, user_id: &str) -> Result<Json, Refusal> {
    let row = with(d.store, |c| run_row(c, run_id, false))?;
    seat_of(d, &row.account_id, user_id)?;
    with(d.store, |c| run_view(c, &row))
}

/// `runs`: the business's newest 50 runs.
pub fn runs(d: &Deps<'_>, account_id: &str, user_id: &str) -> Result<Json, Refusal> {
    seat_of(d, account_id, user_id)?;
    with(d.store, |c| {
        let rows = c
            .query(
                &format!(
                    "SELECT {} FROM bank.business_bulk_runs WHERE account_id = $1::text::uuid \
                      ORDER BY created_at DESC, id LIMIT 50",
                    run_cols()
                ),
                &[&account_id],
            )
            .map_err(|e| pg(&e))?;
        let mut out = Vec::new();
        for r in &rows {
            out.push(run_view(c, &RunRow::from_row(r)?)?);
        }
        Ok(Json::Array(out))
    })
}

/// What `importRun` asks.
pub struct ImportRun<'a> {
    pub account_id: &'a str,
    pub user_id: &'a str,
    pub run_id: &'a str,
    pub csv: &'a str,
}

/// `importRun`: a CSV as a draft run under its own id; nothing is held or sent. The same id on the same file is the same
/// run; on another file it is `bank.business_request_conflict`.
pub fn import_run(d: &Deps<'_>, ask: &ImportRun<'_>) -> Result<Json, Refusal> {
    if ask.csv.len() > MAX_BULK_FILE_BYTES {
        return Err(refuse(
            "bank.bulk_file_invalid",
            "A bulk payment file is at most 256 KiB.",
        ));
    }
    let seat = seat_of(d, ask.account_id, ask.user_id)?;
    need(&seat, "propose")?;
    if seat.status != "active" {
        return Err(closed());
    }
    let sha = sha256_hex(ask.csv.as_bytes());
    if let Some(prior) = with(d.store, |c| run_row_or_none(c, ask.run_id, false))? {
        if prior.account_id != ask.account_id || prior.file_sha256 != sha {
            return Err(conflict("run"));
        }
        return run(d, &prior.id, ask.user_id);
    }
    let (lines, issues) = parse_bulk_csv(ask.csv, &seat.asset_id)?;
    let total: Amount = lines.iter().map(|l| l.amount).sum();
    in_tx(d.store, |tx| {
        // No target: partner_key is the run id's key (business_bulk_runs_key_ck), so either key's clash is the same run.
        let made = tx
            .query(
                "INSERT INTO bank.business_bulk_runs (id, account_id, created_by, file_sha256, asset_id, amount, partner_key) \
                 VALUES ($1::text::uuid, $2::text::uuid, $3, $4, $5, $6::text::numeric, $7) \
                 ON CONFLICT DO NOTHING RETURNING id",
                &[
                    &ask.run_id,
                    &ask.account_id,
                    &ask.user_id,
                    &sha,
                    &seat.asset_id,
                    &format_amount(total),
                    &bulk_pay_key(ask.run_id),
                ],
            )
            .map_err(|e| pg(&e))?;
        if made.is_empty() {
            return Ok(());
        }
        for BulkLine {
            line,
            name,
            iban,
            amount,
            reference,
        } in &lines
        {
            tx.execute(
                "INSERT INTO bank.business_bulk_lines (run_id, line, name, iban, amount, reference) \
                 VALUES ($1::text::uuid, $2::int8, $3, $4, $5::text::numeric, $6)",
                &[&ask.run_id, line, name, iban, &format_amount(*amount), reference],
            )
            .map_err(|e| pg(&e))?;
        }
        for BulkIssue {
            line,
            code,
            detail,
            raw,
        } in &issues
        {
            tx.execute(
                "INSERT INTO bank.business_bulk_issues (run_id, line, code, detail, raw) \
                 VALUES ($1::text::uuid, $2::int8, $3, $4, $5)",
                &[&ask.run_id, line, code, detail, raw],
            )
            .map_err(|e| pg(&e))?;
        }
        Ok(())
    })?;
    let row = with(d.store, |c| run_row(c, ask.run_id, false))?;
    if row.account_id != ask.account_id || row.file_sha256 != sha {
        return Err(conflict("run"));
    }
    run(d, &row.id, ask.user_id)
}

/// `sendRun`: the run's one instruction, every line a recipient, and its answer recorded.
fn send_run(d: &Deps<'_>, row: &RunRow, partner: Option<&Held<'_>>) -> Result<(), Refusal> {
    let Some(partner) = partner else {
        return Err(no_partner());
    };
    let payees = with(d.store, |c| {
        let rows = c
            .query(
                "SELECT name, iban, amount::text, reference FROM bank.business_bulk_lines \
                  WHERE run_id = $1::text::uuid ORDER BY line",
                &[&row.id],
            )
            .map_err(|e| pg(&e))?;
        rows.iter()
            .map(|l| {
                Ok(Payee {
                    name: s(l, 0)?,
                    iban: s(l, 1)?,
                    amount: amount(&s(l, 2)?)?,
                    reference: o(l, 3)?,
                })
            })
            .collect::<Result<Vec<_>, Refusal>>()
    })?;
    let answer = send_once(
        d,
        partner,
        &row.partner_key,
        &row.account_id,
        &row.asset_id,
        row.amount,
        payees,
    )?;
    with(d.store, |c| {
        let done = match &answer {
            Sent::Declined { code, text } => c.execute(
                "UPDATE bank.business_bulk_runs SET status = 'declined', partner_reason = $2, \
                        partner_reason_text = $3, answered_at = now() \
                  WHERE id = $1::text::uuid AND status = 'sending'",
                &[&row.id, code, text],
            ),
            Sent::Made {
                id,
                at: when,
                payees,
            } => c.execute(
                &format!(
                    "UPDATE bank.business_bulk_runs SET status = 'sent', partner_move_id = $2, \
                            partner_payees = $3::int8, sent_at = {}, answered_at = now() \
                      WHERE id = $1::text::uuid AND status = 'sending'",
                    at("$4")
                ),
                &[&row.id, id, payees, &when.0],
            ),
        };
        done.map_err(|e| pg(&e))?;
        Ok(())
    })
}

/// `confirmRun`: the funding step and the confirmation. The partner's figure for the business's account must cover the
/// total, or nothing changes (`bank.bulk_run_unfunded`). At or above the business's threshold the run waits for an
/// approver; under it the one instruction goes now. A run already sending is sent again under the same key, which the
/// partner makes at most once.
pub fn confirm_run(d: &Deps<'_>, run_id: &str, user_id: &str) -> Result<Json, Refusal> {
    let prior = with(d.store, |c| run_row(c, run_id, false))?;
    let seat = seat_of(d, &prior.account_id, user_id)?;
    need(&seat, "propose")?;
    let partner = partner_for(d, &seat);
    if prior.status == "sending" {
        money_may_move(d)?;
        send_run(d, &prior, partner.as_ref())?;
        return run(d, &prior.id, user_id);
    }
    if prior.status != "draft" {
        return run(d, &prior.id, user_id);
    }
    if seat.status != "active" {
        return Err(closed());
    }
    let Some(held_by) = partner.as_ref() else {
        return Err(no_partner());
    };
    let total = prior.amount;
    if total == Amount::ZERO {
        return Err(refuse(
            "bank.bulk_run_empty",
            "No line of this file is valid, so there is nothing to send.",
        ));
    }
    money_may_move(d)?;
    let figure = held_by.balance(&business_account(&prior.account_id, &prior.asset_id), d.now);
    let held = match figure.amount {
        Some(a) if !figure.unavailable => a,
        _ => {
            return Err(refuse(
                "bank.partner_unavailable",
                format!(
                    "{} has not reported this account’s balance, so the run is not sent.",
                    held_by.label()
                ),
            ));
        }
    };
    if held < total {
        return Err(refuse(
            "bank.bulk_run_unfunded",
            format!(
                "This run needs {} {}; the account holds {} at {}. Add money, then confirm again. Nothing was sent.",
                format_amount(total),
                prior.asset_id,
                format_amount(held),
                held_by.label()
            ),
        ));
    }
    let next = in_tx(d.store, |tx| {
        let row = run_row(tx, run_id, true)?;
        if row.status != "draft" {
            return Ok(row);
        }
        let account = account_row(tx, &row.account_id)?;
        let threshold = account.spend_threshold;
        let needed: i64 = i64::from(total >= threshold);
        if needed > 0 {
            let pool = seat::approver_pool(tx, &row.account_id, user_id)?;
            if (pool.len() as i64) < needed {
                return Err(refuse(
                    "bank.business_approvers_short",
                    format!(
                        "This run is at or above the business’s threshold of {} {}, so another approver must approve it, and this business has none besides you.",
                        format_amount(threshold),
                        row.asset_id
                    ),
                ));
            }
        }
        let status = if needed > 0 {
            "awaiting_approval"
        } else {
            "sending"
        };
        let rows = tx
            .query(
                &format!(
                    "UPDATE bank.business_bulk_runs \
                        SET status = $2, approvals_needed = $3::int8, threshold = $4::text::numeric, \
                            confirmed_by = $5, confirmed_at = now() \
                      WHERE id = $1::text::uuid RETURNING {}",
                    run_cols()
                ),
                &[&row.id, &status, &needed, &format_amount(threshold), &user_id],
            )
            .map_err(|e| pg(&e))?;
        rows.first()
            .map(RunRow::from_row)
            .transpose()?
            .ok_or_else(|| Refusal::Other("the run's update returned no row".to_owned()))
    })?;
    if next.status == "sending" {
        send_run(d, &next, partner.as_ref())?;
    }
    run(d, run_id, user_id)
}

/// `approveRun`: an approver's yes, never the person who confirmed it. The last one needed sends the run.
pub fn approve_run(d: &Deps<'_>, run_id: &str, user_id: &str) -> Result<Json, Refusal> {
    let prior = with(d.store, |c| run_row(c, run_id, false))?;
    let seat = seat_of(d, &prior.account_id, user_id)?;
    if prior.confirmed_by.as_deref() == Some(user_id) {
        return Err(refuse(
            "bank.business_self_approve",
            "You confirmed this run, so you cannot approve it. Another approver must.",
        ));
    }
    need(&seat, "approve")?;
    if prior.status != "awaiting_approval" {
        return Err(refuse(
            "bank.business_approval_inactive",
            format!(
                "This run is {}; it takes no approvals.",
                prior.status.replacen('_', " ", 1)
            ),
        ));
    }
    money_may_move(d)?;
    let next = in_tx(d.store, |tx| {
        let row = run_row(tx, run_id, true)?;
        if row.status != "awaiting_approval" {
            return Ok(row);
        }
        tx.execute(
            "INSERT INTO bank.business_bulk_approvals (run_id, approver_user_id) VALUES ($1::text::uuid, $2) \
             ON CONFLICT DO NOTHING",
            &[&row.id, &user_id],
        )
        .map_err(|e| pg(&e))?;
        let count: i64 = tx
            .query_one(
                "SELECT count(*)::int8 FROM bank.business_bulk_approvals WHERE run_id = $1::text::uuid",
                &[&row.id],
            )
            .and_then(|r| r.try_get(0))
            .map_err(|e| pg(&e))?;
        if count < row.approvals_needed {
            return Ok(row);
        }
        let rows = tx
            .query(
                &format!(
                    "UPDATE bank.business_bulk_runs SET status = 'sending' WHERE id = $1::text::uuid RETURNING {}",
                    run_cols()
                ),
                &[&row.id],
            )
            .map_err(|e| pg(&e))?;
        rows.first()
            .map(RunRow::from_row)
            .transpose()?
            .ok_or_else(|| Refusal::Other("the run's update returned no row".to_owned()))
    })?;
    if next.status == "sending" {
        send_run(d, &next, partner_for(d, &seat).as_ref())?;
    }
    run(d, run_id, user_id)
}

// ---------------------------------------------------------------------------------------------------------------
// Contractors and invoices

fn contractor_cols() -> String {
    format!(
        "id::text, account_id::text, name, email, iban, wallet_address, onboarded, {}",
        ms("created_at")
    )
}

fn invoice_cols() -> String {
    format!(
        "id::text, contractor_id::text, number, asset_id, amount::text, due_date::text, status, {}",
        ms("created_at")
    )
}

/// `contractorView`: the IBAN shown by its last four characters only, with the contractor's invoices.
fn contractor_view(r: &Row, invoices: &[Row]) -> Result<Json, Refusal> {
    let id = s(r, 0)?;
    let iban = o(r, 4)?;
    let mut own = Vec::new();
    for i in invoices {
        if s(i, 1)? != id {
            continue;
        }
        own.push(Json::obj([
            ("id", Json::str(s(i, 0)?)),
            ("contractorId", Json::str(s(i, 1)?)),
            ("number", Json::str(s(i, 2)?)),
            ("assetId", Json::str(s(i, 3)?)),
            ("amount", money(amount(&s(i, 4)?)?)),
            ("dueDate", opt(o(i, 5)?.as_deref())),
            ("status", Json::str(s(i, 6)?)),
            ("createdAt", Json::str(t0(i, 7)?.iso())),
        ]));
    }
    // `iban.slice(-4)`: the IBAN is ASCII once it has passed `isIbanRef`.
    let last4 = iban.as_deref().map(|v| {
        let units: Vec<u16> = v.encode_utf16().collect();
        String::from_utf16_lossy(
            units
                .get(units.len().saturating_sub(4)..)
                .unwrap_or_default(),
        )
    });
    Ok(Json::obj([
        ("id", Json::str(id.clone())),
        ("accountId", Json::str(s(r, 1)?)),
        ("name", Json::str(s(r, 2)?)),
        ("email", opt(o(r, 3)?.as_deref())),
        ("ibanLast4", opt(last4.as_deref())),
        ("walletAddress", opt(o(r, 5)?.as_deref())),
        ("onboarded", Json::str(s(r, 6)?)),
        ("invoices", Json::Array(own)),
        ("createdAt", Json::str(t0(r, 7)?.iso())),
    ]))
}

/// `contractors`: the business's contractors, oldest first, each with its invoices.
pub fn contractors(d: &Deps<'_>, account_id: &str, user_id: &str) -> Result<Json, Refusal> {
    seat_of(d, account_id, user_id)?;
    with(d.store, |c| {
        let rows = c
            .query(
                &format!(
                    "SELECT {} FROM bank.business_contractors WHERE account_id = $1::text::uuid \
                      ORDER BY created_at, id LIMIT 200",
                    contractor_cols()
                ),
                &[&account_id],
            )
            .map_err(|e| pg(&e))?;
        let invoices = c
            .query(
                &format!(
                    "SELECT {} FROM bank.business_contractor_invoices WHERE account_id = $1::text::uuid \
                      ORDER BY created_at, id",
                    invoice_cols()
                ),
                &[&account_id],
            )
            .map_err(|e| pg(&e))?;
        Ok(Json::Array(
            rows.iter()
                .map(|r| contractor_view(r, &invoices))
                .collect::<Result<_, Refusal>>()?,
        ))
    })
}

/// `contractor`: one contractor, read by a member of its business.
pub fn contractor(d: &Deps<'_>, contractor_id: &str, user_id: &str) -> Result<Json, Refusal> {
    let row = with(d.store, |c| {
        c.query(
            &format!(
                "SELECT {} FROM bank.business_contractors WHERE id = $1::text::uuid",
                contractor_cols()
            ),
            &[&contractor_id],
        )
        .map_err(|e| pg(&e))
    })?;
    let Some(row) = row.first() else {
        return Err(contractor_not_found());
    };
    seat_of(d, &s(row, 1)?, user_id)?;
    let invoices = with(d.store, |c| {
        c.query(
            &format!(
                "SELECT {} FROM bank.business_contractor_invoices WHERE contractor_id = $1::text::uuid \
                  ORDER BY created_at, id",
                invoice_cols()
            ),
            &[&contractor_id],
        )
        .map_err(|e| pg(&e))
    })?;
    contractor_view(row, &invoices)
}

/// The fields a contractor is made of, by the business or by the contractor through a link.
pub struct ContractorFields<'a> {
    pub name: &'a str,
    pub email: Option<&'a str>,
    pub iban: Option<&'a str>,
    pub wallet_address: Option<&'a str>,
}

/// `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`: no white space, one `@` with something before it, and a dot inside what follows.
fn email_shaped(email: &str) -> bool {
    let ws = |c: char| js_trim(c.encode_utf8(&mut [0; 4])).is_empty();
    if email.chars().any(ws) {
        return false;
    }
    let Some((local, domain)) = email.split_once('@') else {
        return false;
    };
    if local.is_empty() || domain.contains('@') {
        return false;
    }
    domain
        .char_indices()
        .any(|(i, c)| c == '.' && i > 0 && i + 1 < domain.len())
}

/// `insertContractor`: the fields checked and normalised, then the row once by its id; the same id on other details is
/// `bank.business_request_conflict`.
fn insert_contractor(
    c: &mut impl GenericClient,
    account_id: &str,
    user_id: &str,
    contractor_id: &str,
    f: &ContractorFields<'_>,
    onboarded: &str,
) -> Result<(), Refusal> {
    let name = js_trim(f.name);
    let email = f.email.map(js_trim).filter(|e| !e.is_empty());
    let iban = f.iban.filter(|i| !i.is_empty()).map(compact_upper);
    let wallet = f
        .wallet_address
        .map(|w| js_trim(w).to_lowercase())
        .filter(|w| !w.is_empty());
    if !name_ok(name) {
        return Err(field("A contractor’s name is 1 to 140 characters."));
    }
    if let Some(e) = email
        && (js_len(e) > 254 || !email_shaped(e))
    {
        return Err(field("That email address does not look right."));
    }
    let has_iban = iban.as_deref().is_some_and(|i| !i.is_empty());
    if has_iban && !iban.as_deref().is_some_and(is_iban_ref) {
        return Err(field("The IBAN does not check out."));
    }
    if wallet.as_deref().is_some_and(|w| !is_evm_address_ref(w)) {
        return Err(field("A wallet address is 0x and 40 hex digits."));
    }
    if !has_iban && wallet.is_none() {
        return Err(field(
            "A contractor needs a payout IBAN or a wallet address.",
        ));
    }
    let rows = c
        .query(
            "INSERT INTO bank.business_contractors (id, account_id, name, email, iban, wallet_address, onboarded, created_by) \
             VALUES ($1::text::uuid, $2::text::uuid, $3, $4, $5, $6, $7, $8) \
             ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id \
             RETURNING account_id::text, name, iban, wallet_address",
            &[
                &contractor_id,
                &account_id,
                &name,
                &email,
                &iban,
                &wallet,
                &onboarded,
                &user_id,
            ],
        )
        .map_err(|e| pg(&e))?;
    let Some(r) = rows.first() else {
        return Err(Refusal::Other(
            "the contractor's insert returned no row".to_owned(),
        ));
    };
    if s(r, 0)? != account_id || s(r, 1)? != name || o(r, 2)? != iban || o(r, 3)? != wallet {
        return Err(conflict("contractor"));
    }
    Ok(())
}

/// `addContractor`: a contractor the business adds. The same id on the same details is the same contractor.
pub fn add_contractor(
    d: &Deps<'_>,
    account_id: &str,
    user_id: &str,
    contractor_id: &str,
    f: &ContractorFields<'_>,
) -> Result<Json, Refusal> {
    let seat = seat_of(d, account_id, user_id)?;
    need(&seat, "propose")?;
    if seat.status != "active" {
        return Err(closed());
    }
    with(d.store, |c| {
        insert_contractor(c, account_id, user_id, contractor_id, f, "business")
    })?;
    contractor(d, contractor_id, user_id)
}

/// `isDate`: `YYYY-MM-DD`, a day the calendar has.
fn is_date(raw: &str) -> bool {
    let b = raw.as_bytes();
    if b.len() != 10 || b.get(4) != Some(&b'-') || b.get(7) != Some(&b'-') {
        return false;
    }
    let num = |r: std::ops::Range<usize>| {
        raw.get(r)
            .filter(|p| p.bytes().all(|c| c.is_ascii_digit()))
            .and_then(|p| p.parse::<u32>().ok())
    };
    let (Some(y), Some(m), Some(day)) = (num(0..4), num(5..7), num(8..10)) else {
        return false;
    };
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    let days = match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return false,
    };
    (1..=days).contains(&day)
}

/// What `addInvoice` asks.
pub struct NewInvoice<'a> {
    pub contractor_id: &'a str,
    pub user_id: &'a str,
    pub invoice_id: &'a str,
    pub number: &'a str,
    pub amount: Amount,
    pub due_date: Option<&'a str>,
}

/// `addInvoice`: an invoice against a contractor, in the business account's asset. The same id on the same terms is the
/// same invoice.
pub fn add_invoice(d: &Deps<'_>, ask: &NewInvoice<'_>) -> Result<Json, Refusal> {
    let number = js_trim(ask.number);
    if number.is_empty() || js_len(number) > 64 {
        return Err(field("An invoice number is 1 to 64 characters."));
    }
    if ask.amount <= Amount::ZERO {
        return Err(field("An invoice’s amount is above zero."));
    }
    if ask.due_date.is_some_and(|due| !is_date(due)) {
        return Err(field("A due date is a calendar date."));
    }
    let owner = with(d.store, |c| {
        c.query(
            "SELECT account_id::text FROM bank.business_contractors WHERE id = $1::text::uuid",
            &[&ask.contractor_id],
        )
        .map_err(|e| pg(&e))
    })?;
    let Some(owner) = owner.first() else {
        return Err(contractor_not_found());
    };
    let account_id = s(owner, 0)?;
    let seat = seat_of(d, &account_id, ask.user_id)?;
    need(&seat, "propose")?;
    let prior = with(d.store, |c| {
        c.query(
            "SELECT contractor_id::text, number, amount::text FROM bank.business_contractor_invoices \
              WHERE id = $1::text::uuid",
            &[&ask.invoice_id],
        )
        .map_err(|e| pg(&e))
    })?;
    if let Some(p) = prior.first() {
        if s(p, 0)? != ask.contractor_id || s(p, 1)? != number || amount(&s(p, 2)?)? != ask.amount {
            return Err(conflict("invoice"));
        }
        return contractor(d, ask.contractor_id, ask.user_id);
    }
    let inserted = with(d.store, |c| {
        Ok(c.execute(
            "INSERT INTO bank.business_contractor_invoices \
               (id, contractor_id, account_id, number, asset_id, amount, due_date, created_by) \
             VALUES ($1::text::uuid, $2::text::uuid, $3::text::uuid, $4, $5, $6::text::numeric, $7::text::date, $8)",
            &[
                &ask.invoice_id,
                &ask.contractor_id,
                &account_id,
                &number,
                &seat.asset_id,
                &format_amount(ask.amount),
                &ask.due_date,
                &ask.user_id,
            ],
        ))
    })?;
    match inserted {
        Ok(_) => {}
        Err(e) if e.code() == Some(&SqlState::UNIQUE_VIOLATION) => {
            return Err(refuse(
                "bank.contractor_invoice_duplicate",
                format!("This contractor already has an invoice numbered {number}."),
            ));
        }
        Err(e) => return Err(pg(&e)),
    }
    contractor(d, ask.contractor_id, ask.user_id)
}

/// `createInvite`: a one-use onboarding link. Only its hash is kept; the token is shown once.
pub fn create_invite(d: &Deps<'_>, account_id: &str, user_id: &str) -> Result<Json, Refusal> {
    let seat = seat_of(d, account_id, user_id)?;
    need(&seat, "manage_team")?;
    if seat.status != "active" {
        return Err(closed());
    }
    let mut bytes = [0u8; 24];
    getrandom::fill(&mut bytes)
        .map_err(|e| Refusal::Other(format!("no randomness for an invite: {e}")))?;
    let token = URL_SAFE_NO_PAD.encode(bytes);
    let invite_id = service_kit::approvals::random_uuid().map_err(Refusal::Other)?;
    with(d.store, |c| {
        c.execute(
            "INSERT INTO bank.business_contractor_invites (id, account_id, token_sha256, created_by) \
             VALUES ($1::text::uuid, $2::text::uuid, $3, $4)",
            &[&invite_id, &account_id, &sha256_hex(token.as_bytes()), &user_id],
        )
        .map_err(|e| pg(&e))
    })?;
    Ok(Json::obj([
        ("inviteId", Json::str(invite_id)),
        ("token", Json::str(token)),
    ]))
}

/// `inviteInfo`: the business's name, and whether the link is still open.
pub fn invite_info(d: &Deps<'_>, token: &str) -> Result<Json, Refusal> {
    let rows = with(d.store, |c| {
        c.query(
            "SELECT a.name, i.used_at IS NULL, a.status::text FROM bank.business_contractor_invites i \
               JOIN bank.business_accounts a ON a.id = i.account_id WHERE i.token_sha256 = $1",
            &[&sha256_hex(token.as_bytes())],
        )
        .map_err(|e| pg(&e))
    })?;
    let Some(r) = rows.first() else {
        return Err(invite_invalid());
    };
    let unused: bool = r.try_get(1).map_err(|e| pg(&e))?;
    Ok(Json::obj([
        ("businessName", Json::str(s(r, 0)?)),
        ("open", Json::Bool(unused && s(r, 2)? == "active")),
    ]))
}

/// `joinAsContractor`: the contractor adds themselves through the link, once, with their own payout IBAN and wallet.
/// The same person again gets their contractor back.
pub fn join_as_contractor(
    d: &Deps<'_>,
    token: &str,
    user_id: &str,
    f: &ContractorFields<'_>,
) -> Result<Json, Refusal> {
    in_tx(d.store, |tx| {
        let rows = tx
            .query(
                "SELECT id::text, account_id::text, used_at IS NOT NULL, contractor_id::text, joined_by \
                   FROM bank.business_contractor_invites WHERE token_sha256 = $1 FOR UPDATE",
                &[&sha256_hex(token.as_bytes())],
            )
            .map_err(|e| pg(&e))?;
        let Some(invite) = rows.first() else {
            return Err(invite_invalid());
        };
        let invite_id = s(invite, 0)?;
        let account_id = s(invite, 1)?;
        let used: bool = invite.try_get(2).map_err(|e| pg(&e))?;
        let account = account_row(tx, &account_id)?;
        if used {
            let joined = o(invite, 3)?;
            if o(invite, 4)?.as_deref() == Some(user_id)
                && let Some(contractor_id) = joined
            {
                return Ok(Json::obj([
                    ("contractorId", Json::str(contractor_id)),
                    ("businessName", Json::str(account.name)),
                ]));
            }
            return Err(refuse(
                "bank.contractor_invite_used",
                "This onboarding link was already used.",
            ));
        }
        if account.status != "active" {
            return Err(closed());
        }
        let contractor_id = service_kit::approvals::random_uuid().map_err(Refusal::Other)?;
        insert_contractor(tx, &account_id, user_id, &contractor_id, f, "self")?;
        tx.execute(
            "UPDATE bank.business_contractor_invites SET joined_by = $2, contractor_id = $3::text::uuid, used_at = now() \
              WHERE id = $1::text::uuid",
            &[&invite_id, &user_id, &contractor_id],
        )
        .map_err(|e| pg(&e))?;
        Ok(Json::obj([
            ("contractorId", Json::str(contractor_id)),
            ("businessName", Json::str(account.name)),
        ]))
    })
}

// ---------------------------------------------------------------------------------------------------------------
// Contractor batches

struct BatchRow {
    id: String,
    account_id: String,
    created_by: String,
    asset_id: String,
    amount: Amount,
    status: String,
    approvals_needed: i64,
    rule_id: Option<String>,
    partner_key: String,
    partner_move_id: Option<String>,
    partner_payees: Option<i64>,
    refusal_code: Option<String>,
    partner_reason_text: Option<String>,
    created_at: Instant,
    sent_at: Option<Instant>,
}

fn batch_cols() -> String {
    format!(
        "id::text, account_id::text, created_by, asset_id, amount::text, status, approvals_needed::int8, \
         rule_id::text, partner_key, partner_move_id, partner_payees::int8, refusal_code, partner_reason_text, {}, {}",
        ms("created_at"),
        ms("sent_at")
    )
}

impl BatchRow {
    fn from_row(r: &Row) -> Result<BatchRow, Refusal> {
        Ok(BatchRow {
            id: s(r, 0)?,
            account_id: s(r, 1)?,
            created_by: s(r, 2)?,
            asset_id: s(r, 3)?,
            amount: amount(&s(r, 4)?)?,
            status: s(r, 5)?,
            approvals_needed: n(r, 6)?.unwrap_or(0),
            rule_id: o(r, 7)?,
            partner_key: s(r, 8)?,
            partner_move_id: o(r, 9)?,
            partner_payees: n(r, 10)?,
            refusal_code: o(r, 11)?,
            partner_reason_text: o(r, 12)?,
            created_at: t0(r, 13)?,
            sent_at: t(r, 14)?,
        })
    }
}

fn batch_row_or_none(
    c: &mut impl GenericClient,
    batch_id: &str,
    lock: bool,
) -> Result<Option<BatchRow>, Refusal> {
    let rows = c
        .query(
            &format!(
                "SELECT {} FROM bank.business_contractor_batches WHERE id = $1::text::uuid{}",
                batch_cols(),
                if lock { " FOR UPDATE" } else { "" }
            ),
            &[&batch_id],
        )
        .map_err(|e| pg(&e))?;
    rows.first().map(BatchRow::from_row).transpose()
}

fn batch_row(c: &mut impl GenericClient, batch_id: &str, lock: bool) -> Result<BatchRow, Refusal> {
    batch_row_or_none(c, batch_id, lock)?.ok_or_else(|| {
        refuse(
            "bank.contractor_not_found",
            "No contractor batch of this business has that id.",
        )
    })
}

fn first_batch(rows: &[Row]) -> Result<BatchRow, Refusal> {
    rows.first()
        .map(BatchRow::from_row)
        .transpose()?
        .ok_or_else(|| Refusal::Other("the batch's write returned no row".to_owned()))
}

/// `batchView` as `batchView` in the router writes it.
fn batch_view(c: &mut impl GenericClient, row: &BatchRow) -> Result<Json, Refusal> {
    let lines = c
        .query(
            "SELECT l.invoice_id::text, c.name, i.number, l.amount::text FROM bank.business_contractor_batch_lines l \
               JOIN bank.business_contractor_invoices i ON i.id = l.invoice_id \
               JOIN bank.business_contractors c ON c.id = i.contractor_id \
              WHERE l.batch_id = $1::text::uuid ORDER BY c.name, i.number",
            &[&row.id],
        )
        .map_err(|e| pg(&e))?;
    let approvals = c
        .query(
            &format!(
                "SELECT approver_user_id, {} FROM bank.business_contractor_batch_approvals \
                  WHERE batch_id = $1::text::uuid ORDER BY approved_at",
                ms("approved_at")
            ),
            &[&row.id],
        )
        .map_err(|e| pg(&e))?;
    let lines = lines
        .iter()
        .map(|l| {
            Ok(Json::obj([
                ("invoiceId", Json::str(s(l, 0)?)),
                ("contractorName", Json::str(s(l, 1)?)),
                ("number", Json::str(s(l, 2)?)),
                ("amount", money(amount(&s(l, 3)?)?)),
            ]))
        })
        .collect::<Result<_, Refusal>>()?;
    Ok(Json::obj([
        ("id", Json::str(row.id.clone())),
        ("accountId", Json::str(row.account_id.clone())),
        ("assetId", Json::str(row.asset_id.clone())),
        ("total", money(row.amount)),
        ("status", Json::str(row.status.clone())),
        ("approvalsNeeded", Json::int(row.approvals_needed)),
        ("ruleId", opt(row.rule_id.as_deref())),
        ("createdBy", Json::str(row.created_by.clone())),
        ("approvals", approvals_json(&approvals)?),
        ("lines", Json::Array(lines)),
        ("partnerKey", Json::str(row.partner_key.clone())),
        ("partnerMoveId", opt(row.partner_move_id.as_deref())),
        ("partnerPayees", int(row.partner_payees)),
        ("refusalCode", opt(row.refusal_code.as_deref())),
        ("partnerReasonText", opt(row.partner_reason_text.as_deref())),
        ("createdAt", Json::str(row.created_at.iso())),
        ("sentAt", iso(row.sent_at)),
    ]))
}

/// `batch`: one batch, read by a member of its business.
pub fn batch(d: &Deps<'_>, batch_id: &str, user_id: &str) -> Result<Json, Refusal> {
    let row = with(d.store, |c| batch_row(c, batch_id, false))?;
    seat_of(d, &row.account_id, user_id)?;
    with(d.store, |c| batch_view(c, &row))
}

/// `batches`: the business's newest 50 batches.
pub fn batches(d: &Deps<'_>, account_id: &str, user_id: &str) -> Result<Json, Refusal> {
    seat_of(d, account_id, user_id)?;
    with(d.store, |c| {
        let rows = c
            .query(
                &format!(
                    "SELECT {} FROM bank.business_contractor_batches WHERE account_id = $1::text::uuid \
                      ORDER BY created_at DESC, id LIMIT 50",
                    batch_cols()
                ),
                &[&account_id],
            )
            .map_err(|e| pg(&e))?;
        let mut out = Vec::new();
        for r in &rows {
            out.push(batch_view(c, &BatchRow::from_row(r)?)?);
        }
        Ok(Json::Array(out))
    })
}

const REOPEN_LINES: &str = "UPDATE bank.business_contractor_invoices SET status = $2 WHERE id IN \
     (SELECT invoice_id FROM bank.business_contractor_batch_lines WHERE batch_id = $1::text::uuid)";

/// `sendBatch`: the batch's one instruction to the payout rail, and its answer recorded with its invoices.
fn send_batch(d: &Deps<'_>, row: &BatchRow, partner: Option<&Held<'_>>) -> Result<(), Refusal> {
    let Some(partner) = partner else {
        return Err(no_partner());
    };
    let payees = with(d.store, |c| {
        let rows = c
            .query(
                "SELECT c.name, c.iban, l.amount::text, i.number FROM bank.business_contractor_batch_lines l \
                   JOIN bank.business_contractor_invoices i ON i.id = l.invoice_id \
                   JOIN bank.business_contractors c ON c.id = i.contractor_id \
                  WHERE l.batch_id = $1::text::uuid ORDER BY i.id",
                &[&row.id],
            )
            .map_err(|e| pg(&e))?;
        rows.iter()
            .map(|l| {
                Ok(Payee {
                    name: s(l, 0)?,
                    iban: o(l, 1)?.unwrap_or_default(),
                    amount: amount(&s(l, 2)?)?,
                    reference: Some(s(l, 3)?),
                })
            })
            .collect::<Result<Vec<_>, Refusal>>()
    })?;
    let answer = send_once(
        d,
        partner,
        &row.partner_key,
        &row.account_id,
        &row.asset_id,
        row.amount,
        payees,
    )?;
    in_tx(d.store, |tx| {
        let (done, invoices) = match &answer {
            Sent::Declined { code, text } => (
                tx.query(
                    "UPDATE bank.business_contractor_batches SET status = 'declined', refusal_code = $2, \
                            partner_reason_text = $3, answered_at = now() \
                      WHERE id = $1::text::uuid AND status = 'sending' RETURNING id",
                    &[&row.id, code, text],
                ),
                "open",
            ),
            Sent::Made { id, at: when, payees } => (
                tx.query(
                    &format!(
                        "UPDATE bank.business_contractor_batches SET status = 'sent', partner_move_id = $2, \
                                partner_payees = $3::int8, sent_at = {}, answered_at = now() \
                          WHERE id = $1::text::uuid AND status = 'sending' RETURNING id",
                        at("$4")
                    ),
                    &[&row.id, id, payees, &when.0],
                ),
                "paid",
            ),
        };
        if !done.map_err(|e| pg(&e))?.is_empty() {
            tx.execute(REOPEN_LINES, &[&row.id, &invoices])
                .map_err(|e| pg(&e))?;
        }
        Ok(())
    })
}

/// What `payBatch` asks.
pub struct PayBatch<'a> {
    pub account_id: &'a str,
    pub user_id: &'a str,
    pub batch_id: &'a str,
    pub invoice_ids: Vec<String>,
}

/// `payBatch`: pays a batch of open invoices. The intent row is written first, with its key and the business's
/// approval rule fixed then. With approvals needed it waits for them; otherwise it goes to the partner's payout rail
/// now, as one instruction; with no partner it is kept refused `rail.bank`.
#[allow(
    clippy::too_many_lines,
    reason = "one step after another, as the TypeScript's one method takes them"
)]
pub fn pay_batch(d: &Deps<'_>, ask: &PayBatch<'_>) -> Result<Json, Refusal> {
    let ids: Vec<String> = ask
        .invoice_ids
        .iter()
        .map(|i| i.to_lowercase())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    if ids.is_empty() || ids.len() > MAX_BATCH_INVOICES {
        return Err(field(format!(
            "A batch pays 1 to {MAX_BATCH_INVOICES} invoices."
        )));
    }
    let seat = seat_of(d, ask.account_id, ask.user_id)?;
    need(&seat, "propose")?;
    let partner = partner_for(d, &seat);
    if let Some(prior) = with(d.store, |c| batch_row_or_none(c, ask.batch_id, false))? {
        let lines: Vec<String> = with(d.store, |c| {
            c.query(
                "SELECT invoice_id::text FROM bank.business_contractor_batch_lines \
                  WHERE batch_id = $1::text::uuid ORDER BY invoice_id",
                &[&prior.id],
            )
            .map_err(|e| pg(&e))?
            .iter()
            .map(|r| s(r, 0))
            .collect()
        })?;
        if prior.account_id != ask.account_id || lines != ids {
            return Err(conflict("batch"));
        }
        if prior.status == "sending" {
            money_may_move(d)?;
            send_batch(d, &prior, partner.as_ref())?;
        }
        return batch(d, &prior.id, ask.user_id);
    }
    if seat.status != "active" {
        return Err(closed());
    }
    if partner.is_some() {
        money_may_move(d)?;
    }
    let rules = with(d.store, |c| seat::rule_list(c, ask.account_id))?;
    let created = in_tx(d.store, |tx| {
        let invoices = tx
            .query(
                "SELECT i.id::text, i.account_id::text, i.status, i.amount::text, i.asset_id, c.iban \
                   FROM bank.business_contractor_invoices i \
                   JOIN bank.business_contractors c ON c.id = i.contractor_id \
                  WHERE i.id = ANY($1::text[]::uuid[]) ORDER BY i.id FOR UPDATE OF i",
                &[&ids],
            )
            .map_err(|e| pg(&e))?;
        let mut total = Amount::ZERO;
        let mut foreign = invoices.len() != ids.len();
        let (mut taken, mut no_iban, mut other_asset) = (false, false, false);
        for i in &invoices {
            foreign |= s(i, 1)? != ask.account_id;
            taken |= s(i, 2)? != "open";
            no_iban |= o(i, 5)?.is_none_or(|v| v.is_empty());
            other_asset |= s(i, 4)? != seat.asset_id;
            total += amount(&s(i, 3)?)?;
        }
        if foreign {
            return Err(refuse(
                "bank.contractor_not_found",
                "Every invoice in a batch is this business’s.",
            ));
        }
        if taken {
            return Err(refuse(
                "bank.contractor_invoice_not_open",
                "An invoice in this batch is already being paid or paid.",
            ));
        }
        if no_iban {
            return Err(field(
                "A contractor in this batch has no payout IBAN, so the payout rail cannot pay them.",
            ));
        }
        if other_asset {
            return Err(refuse(
                "bank.asset_mismatch",
                format!(
                    "Every invoice is in {}, the account’s asset.",
                    seat.asset_id
                ),
            ));
        }
        let plain: Vec<seat::Rule> = rules.iter().map(|(_, r)| r.clone()).collect();
        let rule = seat::pick_rule(&plain, total, "", "payroll").and_then(|i| rules.get(i));
        let needed = rule.map_or(0, |(_, r)| r.approvals);
        if needed > 0 {
            let pool = seat::approver_pool(tx, ask.account_id, ask.user_id)?;
            if (pool.len() as i64) < needed {
                return Err(refuse(
                    "bank.business_approvers_short",
                    format!(
                        "This batch needs {needed} approver(s) other than you under the business’s rules, and this business has {}.",
                        pool.len()
                    ),
                ));
            }
        }
        let status = if needed > 0 {
            "awaiting_approval"
        } else if partner.is_some() {
            "sending"
        } else {
            "refused"
        };
        let refused = status == "refused";
        // The intent row, before anything reaches the partner.
        let rows = tx
            .query(
                &format!(
                    "INSERT INTO bank.business_contractor_batches \
                       (id, account_id, created_by, asset_id, amount, status, approvals_needed, rule_id, partner_key, \
                        refusal_code, answered_at) \
                     VALUES ($1::text::uuid, $2::text::uuid, $3, $4, $5::text::numeric, $6, $7::int8, $8::text::uuid, $9, \
                             $10, CASE WHEN $11::bool THEN {} END) \
                     RETURNING {}",
                    at("$12"),
                    batch_cols()
                ),
                &[
                    &ask.batch_id,
                    &ask.account_id,
                    &ask.user_id,
                    &seat.asset_id,
                    &format_amount(total),
                    &status,
                    &needed,
                    &rule.map(|(id, _)| id.as_str()),
                    &contractor_batch_key(ask.batch_id),
                    &refused.then_some("rail.bank"),
                    &refused,
                    &d.now.0,
                ],
            )
            .map_err(|e| pg(&e))?;
        for i in &invoices {
            tx.execute(
                "INSERT INTO bank.business_contractor_batch_lines (batch_id, invoice_id, amount) \
                 VALUES ($1::text::uuid, $2::text::uuid, $3::text::numeric)",
                &[&ask.batch_id, &s(i, 0)?, &s(i, 3)?],
            )
            .map_err(|e| pg(&e))?;
        }
        if !refused {
            tx.execute(
                "UPDATE bank.business_contractor_invoices SET status = 'in_batch' WHERE id = ANY($1::text[]::uuid[])",
                &[&ids],
            )
            .map_err(|e| pg(&e))?;
        }
        first_batch(&rows)
    })?;
    if created.status == "sending" {
        send_batch(d, &created, partner.as_ref())?;
    }
    batch(d, ask.batch_id, ask.user_id)
}

/// `approveBatch`: one distinct approver's yes, never the person who made the batch. The last one needed sends it to
/// the payout rail; with no partner it is refused `rail.bank` and its invoices are open again.
pub fn approve_batch(d: &Deps<'_>, batch_id: &str, user_id: &str) -> Result<Json, Refusal> {
    let prior = with(d.store, |c| batch_row(c, batch_id, false))?;
    let seat = seat_of(d, &prior.account_id, user_id)?;
    if prior.created_by == user_id {
        return Err(refuse(
            "bank.business_self_approve",
            "You made this batch, so you cannot approve it. Another approver must.",
        ));
    }
    need(&seat, "approve")?;
    if prior.status != "awaiting_approval" {
        return Err(refuse(
            "bank.business_approval_inactive",
            format!(
                "This batch is {}; it takes no approvals.",
                prior.status.replacen('_', " ", 1)
            ),
        ));
    }
    let partner = partner_for(d, &seat);
    if partner.is_some() {
        money_may_move(d)?;
    }
    let next = in_tx(d.store, |tx| {
        let row = batch_row(tx, batch_id, true)?;
        if row.status != "awaiting_approval" {
            return Ok(row);
        }
        let added = tx
            .query(
                "INSERT INTO bank.business_contractor_batch_approvals (batch_id, approver_user_id) \
                 VALUES ($1::text::uuid, $2) ON CONFLICT DO NOTHING RETURNING batch_id",
                &[&row.id, &user_id],
            )
            .map_err(|e| pg(&e))?;
        if added.is_empty() {
            return Err(refuse(
                "bank.business_already_approved",
                "You have already approved this batch. A different approver must give the next approval.",
            ));
        }
        let count: i64 = tx
            .query_one(
                "SELECT count(*)::int8 FROM bank.business_contractor_batch_approvals WHERE batch_id = $1::text::uuid",
                &[&row.id],
            )
            .and_then(|r| r.try_get(0))
            .map_err(|e| pg(&e))?;
        if count < row.approvals_needed {
            return Ok(row);
        }
        if partner.is_none() {
            tx.execute(REOPEN_LINES, &[&row.id, &"open"])
                .map_err(|e| pg(&e))?;
            let rows = tx
                .query(
                    &format!(
                        "UPDATE bank.business_contractor_batches SET status = 'refused', refusal_code = 'rail.bank', \
                                answered_at = now() WHERE id = $1::text::uuid RETURNING {}",
                        batch_cols()
                    ),
                    &[&row.id],
                )
                .map_err(|e| pg(&e))?;
            return first_batch(&rows);
        }
        let rows = tx
            .query(
                &format!(
                    "UPDATE bank.business_contractor_batches SET status = 'sending' WHERE id = $1::text::uuid RETURNING {}",
                    batch_cols()
                ),
                &[&row.id],
            )
            .map_err(|e| pg(&e))?;
        first_batch(&rows)
    })?;
    if next.status == "sending" {
        send_batch(d, &next, partner.as_ref())?;
    }
    batch(d, batch_id, user_id)
}

// ---------------------------------------------------------------------------------------------------------------
// Crypto payroll

/// `walletConnectMessage`: the exact text the business's wallet signs to connect it. It moves nothing.
pub fn wallet_connect_message(account_id: &str, address: &str, offer_id: &str) -> String {
    [
        "INTAFACED business payroll wallet".to_owned(),
        format!("Business: {account_id}"),
        format!("Address: {address}"),
        format!("Offer: {offer_id}"),
        "Signing this connects your own wallet to this business’s crypto payroll. It moves no funds.".to_owned(),
    ]
    .join("\n")
}

/// One payslip a run's message names.
pub struct Slip<'a> {
    pub wallet_address: &'a str,
    pub amount: Amount,
}

/// What `payrollRunMessage` names.
pub struct RunMessage<'a> {
    pub run_key: &'a str,
    pub business: &'a str,
    pub wallet: &'a str,
    pub asset_id: &'a str,
    pub period: &'a str,
    pub payslips: &'a [Slip<'a>],
    pub total: Amount,
}

/// `payrollRunMessage`: the exact text the business's wallet signs for one month's run: its key, every payee and
/// amount, and the total.
pub fn payroll_run_message(m: &RunMessage<'_>) -> String {
    let mut out = vec![
        "INTAFACED crypto payroll run".to_owned(),
        format!("Run: {}", m.run_key),
        format!("Business: {}", m.business),
        format!("From your wallet: {}", m.wallet),
        format!("Period: {}", m.period),
    ];
    out.extend(m.payslips.iter().map(|p| {
        format!(
            "Pay {} {} to {}",
            format_amount(p.amount),
            m.asset_id,
            p.wallet_address
        )
    }));
    out.push(format!("Total: {} {}", format_amount(m.total), m.asset_id));
    out.push(
        "Signed by your own wallet. INTAFACED holds no key and no vault for this payroll."
            .to_owned(),
    );
    out.join("\n")
}

/// `walletOf`: the business's connected wallet and when, none before one is.
fn wallet_of(d: &Deps<'_>, account_id: &str) -> Result<Option<(String, Instant)>, Refusal> {
    let rows = with(d.store, |c| {
        c.query(
            &format!(
                "SELECT address, {} FROM bank.business_payroll_wallets WHERE account_id = $1::text::uuid",
                ms("connected_at")
            ),
            &[&account_id],
        )
        .map_err(|e| pg(&e))
    })?;
    rows.first().map(|r| Ok((s(r, 0)?, t0(r, 1)?))).transpose()
}

fn wallet_view((address, connected_at): (String, Instant)) -> Json {
    Json::obj([
        ("address", Json::str(address)),
        ("connectedAt", Json::str(connected_at.iso())),
    ])
}

/// `wallet`: the business's own wallet, or null.
pub fn wallet(d: &Deps<'_>, account_id: &str, user_id: &str) -> Result<Json, Refusal> {
    seat_of(d, account_id, user_id)?;
    Ok(wallet_of(d, account_id)?.map_or(Json::Null, wallet_view))
}

/// `walletOffer`: the message the business's own wallet signs to connect it. Each offer is new; nothing is connected
/// until it is signed.
pub fn wallet_offer(
    d: &Deps<'_>,
    account_id: &str,
    user_id: &str,
    address: &str,
) -> Result<Json, Refusal> {
    let address = js_trim(address).to_lowercase();
    if !is_evm_address_ref(&address) {
        return Err(refuse(
            "bank.payroll_wallet_invalid",
            "A wallet address is 0x and 40 hex digits.",
        ));
    }
    let seat = seat_of(d, account_id, user_id)?;
    need(&seat, "manage_team")?;
    let offer_id = service_kit::approvals::random_uuid().map_err(Refusal::Other)?;
    let message = wallet_connect_message(account_id, &address, &offer_id);
    with(d.store, |c| {
        c.execute(
            "INSERT INTO bank.business_payroll_wallet_offers (id, account_id, address, message, created_by) \
             VALUES ($1::text::uuid, $2::text::uuid, $3, $4, $5)",
            &[&offer_id, &account_id, &address, &message, &user_id],
        )
        .map_err(|e| pg(&e))
    })?;
    Ok(Json::obj([
        ("offerId", Json::str(offer_id)),
        ("message", Json::str(message)),
    ]))
}

/// `connectWallet`: connects the wallet that signed the offer; another signer is refused and nothing changes.
pub fn connect_wallet(
    d: &Deps<'_>,
    offer_id: &str,
    user_id: &str,
    signature: &str,
) -> Result<Json, Refusal> {
    let rows = with(d.store, |c| {
        c.query(
            "SELECT account_id::text, address, message FROM bank.business_payroll_wallet_offers WHERE id = $1::text::uuid",
            &[&offer_id],
        )
        .map_err(|e| pg(&e))
    })?;
    let Some(offer) = rows.first() else {
        return Err(refuse(
            "bank.payroll_wallet_invalid",
            "No wallet offer of this business has that id.",
        ));
    };
    let (account_id, address, message) = (s(offer, 0)?, s(offer, 1)?, s(offer, 2)?);
    let seat = seat_of(d, &account_id, user_id)?;
    need(&seat, "manage_team")?;
    if recover_personal_sign_address(&message, signature).as_deref() != Some(address.as_str()) {
        return Err(refuse(
            "bank.payroll_signature_invalid",
            "That signature is not from the wallet named. Nothing was connected.",
        ));
    }
    in_tx(d.store, |tx| {
        tx.execute(
            "UPDATE bank.business_payroll_wallet_offers SET used_at = now() WHERE id = $1::text::uuid AND used_at IS NULL",
            &[&offer_id],
        )
        .map_err(|e| pg(&e))?;
        tx.execute(
            "INSERT INTO bank.business_payroll_wallets (account_id, address, offer_id, signature, connected_by) \
             VALUES ($1::text::uuid, $2, $3::text::uuid, $4, $5) \
             ON CONFLICT (account_id) DO UPDATE \
               SET address = EXCLUDED.address, offer_id = EXCLUDED.offer_id, signature = EXCLUDED.signature, \
                   connected_by = EXCLUDED.connected_by, connected_at = now()",
            &[&account_id, &address, &offer_id, &js_trim(signature), &user_id],
        )
        .map_err(|e| pg(&e))?;
        Ok(())
    })?;
    wallet_of(d, &account_id)?
        .map(wallet_view)
        .ok_or_else(|| Refusal::Other("the wallet just connected is not there".to_owned()))
}

fn payroll_not_found() -> Refusal {
    refuse(
        "bank.contractor_not_found",
        "No payroll of this business has that id.",
    )
}

/// `payrollView` as `payrollView` in the router writes it: the members, and the newest 24 runs with their payslips.
fn payroll_view(d: &Deps<'_>, payroll_id: &str) -> Result<Json, Refusal> {
    with(d.store, |c| {
        let p = c
            .query(
                &format!(
                    "SELECT id::text, account_id::text, name, asset_id, day_of_month::int8, {} \
                       FROM bank.business_crypto_payrolls WHERE id = $1::text::uuid",
                    ms("created_at")
                ),
                &[&payroll_id],
            )
            .map_err(|e| pg(&e))?;
        let Some(p) = p.first() else {
            return Err(payroll_not_found());
        };
        let members = c
            .query(
                "SELECT m.contractor_id::text, c.name, c.wallet_address, m.amount::text \
                   FROM bank.business_crypto_payroll_members m \
                   JOIN bank.business_contractors c ON c.id = m.contractor_id \
                  WHERE m.payroll_id = $1::text::uuid ORDER BY c.created_at, c.id",
                &[&payroll_id],
            )
            .map_err(|e| pg(&e))?;
        let runs = c
            .query(
                &format!(
                    "SELECT id::text, payroll_id::text, period, run_key, wallet_address, message, amount::text, status, \
                            signature, {}, {} \
                       FROM bank.business_crypto_payroll_runs WHERE payroll_id = $1::text::uuid \
                      ORDER BY period DESC LIMIT 24",
                    ms("signed_at"),
                    ms("created_at")
                ),
                &[&payroll_id],
            )
            .map_err(|e| pg(&e))?;
        let run_ids = runs
            .iter()
            .map(|r| s(r, 0))
            .collect::<Result<Vec<_>, _>>()?;
        let slips = if run_ids.is_empty() {
            Vec::new()
        } else {
            c.query(
                "SELECT run_id::text, contractor_id::text, name, wallet_address, asset_id, amount::text \
                   FROM bank.business_crypto_payslips WHERE run_id = ANY($1::text[]::uuid[]) \
                  ORDER BY name, contractor_id",
                &[&run_ids],
            )
            .map_err(|e| pg(&e))?
        };
        let members = members
            .iter()
            .map(|m| {
                Ok(Json::obj([
                    ("contractorId", Json::str(s(m, 0)?)),
                    ("name", Json::str(s(m, 1)?)),
                    ("walletAddress", opt(o(m, 2)?.as_deref())),
                    ("amount", money(amount(&s(m, 3)?)?)),
                ]))
            })
            .collect::<Result<_, Refusal>>()?;
        let mut run_views = Vec::new();
        for r in &runs {
            let id = s(r, 0)?;
            let mut payslips = Vec::new();
            for sl in &slips {
                if s(sl, 0)? != id {
                    continue;
                }
                payslips.push(Json::obj([
                    ("contractorId", Json::str(s(sl, 1)?)),
                    ("name", Json::str(s(sl, 2)?)),
                    ("walletAddress", Json::str(s(sl, 3)?)),
                    ("assetId", Json::str(s(sl, 4)?)),
                    ("amount", money(amount(&s(sl, 5)?)?)),
                ]));
            }
            run_views.push(Json::obj([
                ("id", Json::str(id)),
                ("payrollId", Json::str(s(r, 1)?)),
                ("period", Json::str(s(r, 2)?)),
                ("runKey", Json::str(s(r, 3)?)),
                ("walletAddress", Json::str(s(r, 4)?)),
                ("message", Json::str(s(r, 5)?)),
                ("total", money(amount(&s(r, 6)?)?)),
                ("status", Json::str(s(r, 7)?)),
                ("signature", opt(o(r, 8)?.as_deref())),
                ("signedAt", iso(t(r, 9)?)),
                ("payslips", Json::Array(payslips)),
                ("createdAt", Json::str(t0(r, 10)?.iso())),
            ]));
        }
        Ok(Json::obj([
            ("id", Json::str(s(p, 0)?)),
            ("accountId", Json::str(s(p, 1)?)),
            ("name", Json::str(s(p, 2)?)),
            ("assetId", Json::str(s(p, 3)?)),
            ("dayOfMonth", int(n(p, 4)?)),
            ("members", Json::Array(members)),
            ("runs", Json::Array(run_views)),
            ("createdAt", Json::str(t0(p, 5)?.iso())),
        ]))
    })
}

/// `payrolls`: the business's payrolls, oldest first.
pub fn payrolls(d: &Deps<'_>, account_id: &str, user_id: &str) -> Result<Json, Refusal> {
    seat_of(d, account_id, user_id)?;
    let ids = with(d.store, |c| {
        c.query(
            "SELECT id::text FROM bank.business_crypto_payrolls WHERE account_id = $1::text::uuid \
              ORDER BY created_at, id LIMIT 50",
            &[&account_id],
        )
        .map_err(|e| pg(&e))?
        .iter()
        .map(|r| s(r, 0))
        .collect::<Result<Vec<_>, _>>()
    })?;
    Ok(Json::Array(
        ids.iter()
            .map(|id| payroll_view(d, id))
            .collect::<Result<_, Refusal>>()?,
    ))
}

/// What `createPayroll` asks.
pub struct NewPayroll<'a> {
    pub account_id: &'a str,
    pub user_id: &'a str,
    pub payroll_id: &'a str,
    pub name: &'a str,
    pub day_of_month: f64,
    pub members: Vec<(String, Amount)>,
}

/// `createPayroll`: a recurring payroll of contractors with a wallet, paid monthly on a day from the business's own
/// wallet. The same id on the same name is the same payroll.
pub fn create_payroll(d: &Deps<'_>, ask: &NewPayroll<'_>) -> Result<Json, Refusal> {
    let name = js_trim(ask.name);
    if name.is_empty() || js_len(name) > 128 {
        return Err(field("A payroll’s name is 1 to 128 characters."));
    }
    if ask.day_of_month.fract() != 0.0 || !(1.0..=28.0).contains(&ask.day_of_month) {
        return Err(field("A payroll runs on day 1 to 28 of the month."));
    }
    if ask.members.is_empty() || ask.members.len() > MAX_PAYROLL_MEMBERS {
        return Err(field(format!(
            "A payroll pays 1 to {MAX_PAYROLL_MEMBERS} people."
        )));
    }
    let seat = seat_of(d, ask.account_id, ask.user_id)?;
    need(&seat, "manage_team")?;
    if seat.status != "active" {
        return Err(closed());
    }
    if wallet_of(d, ask.account_id)?.is_none() {
        return Err(wallet_missing());
    }
    let prior = with(d.store, |c| {
        c.query(
            "SELECT account_id::text, name FROM bank.business_crypto_payrolls WHERE id = $1::text::uuid",
            &[&ask.payroll_id],
        )
        .map_err(|e| pg(&e))
    })?;
    if let Some(p) = prior.first() {
        if s(p, 0)? != ask.account_id || s(p, 1)? != name {
            return Err(conflict("payroll"));
        }
        return payroll_view(d, ask.payroll_id);
    }
    #[allow(
        clippy::cast_possible_truncation,
        reason = "a whole day of 1 to 28, checked above"
    )]
    let day = ask.day_of_month as i64;
    in_tx(d.store, |tx| {
        let ids: Vec<String> = ask
            .members
            .iter()
            .map(|(id, _)| id.to_lowercase())
            .collect();
        if ids.iter().collect::<BTreeSet<_>>().len() != ids.len() {
            return Err(field("A person is in a payroll once."));
        }
        let people = tx
            .query(
                "SELECT id::text, account_id::text, wallet_address FROM bank.business_contractors \
                  WHERE id = ANY($1::text[]::uuid[])",
                &[&ids],
            )
            .map_err(|e| pg(&e))?;
        let mut foreign = people.len() != ids.len();
        let mut walletless = false;
        for p in &people {
            foreign |= s(p, 1)? != ask.account_id;
            walletless |= o(p, 2)?.is_none_or(|w| w.is_empty());
        }
        if foreign {
            return Err(refuse(
                "bank.contractor_not_found",
                "Every member is a contractor of this business.",
            ));
        }
        if walletless {
            return Err(refuse(
                "bank.contractor_wallet_missing",
                "Every member needs a wallet address to be paid in crypto.",
            ));
        }
        if ask.members.iter().any(|(_, a)| *a <= Amount::ZERO) {
            return Err(field("Each member’s amount is above zero."));
        }
        tx.execute(
            "INSERT INTO bank.business_crypto_payrolls (id, account_id, name, asset_id, day_of_month, created_by) \
             VALUES ($1::text::uuid, $2::text::uuid, $3, $4, $5::int8, $6)",
            &[
                &ask.payroll_id,
                &ask.account_id,
                &name,
                &seat.asset_id,
                &day,
                &ask.user_id,
            ],
        )
        .map_err(|e| pg(&e))?;
        for (contractor_id, a) in &ask.members {
            tx.execute(
                "INSERT INTO bank.business_crypto_payroll_members (payroll_id, contractor_id, amount) \
                 VALUES ($1::text::uuid, $2::text::uuid, $3::text::numeric)",
                &[&ask.payroll_id, contractor_id, &format_amount(*a)],
            )
            .map_err(|e| pg(&e))?;
        }
        Ok(())
    })?;
    payroll_view(d, ask.payroll_id)
}

/// `/^\d{4}-(0[1-9]|1[0-2])$/`.
fn is_period(p: &str) -> bool {
    let b = p.as_bytes();
    b.len() == 7
        && b.iter().take(4).all(u8::is_ascii_digit)
        && b.get(4) == Some(&b'-')
        && matches!(
            (b.get(5), b.get(6)),
            (Some(b'0'), Some(b'1'..=b'9')) | (Some(b'1'), Some(b'0'..=b'2'))
        )
}

/// `prepareRun`: one month's run, its payslips and the message the business's own wallet signs, under the run key. The
/// same month again is the same run; nothing is sent, held or posted.
pub fn prepare_run(
    d: &Deps<'_>,
    payroll_id: &str,
    user_id: &str,
    period: &str,
) -> Result<Json, Refusal> {
    if !is_period(period) {
        return Err(field("A period is a month, YYYY-MM."));
    }
    let rows = with(d.store, |c| {
        c.query(
            "SELECT account_id::text, asset_id FROM bank.business_crypto_payrolls WHERE id = $1::text::uuid",
            &[&payroll_id],
        )
        .map_err(|e| pg(&e))
    })?;
    let Some(p) = rows.first() else {
        return Err(payroll_not_found());
    };
    let (account_id, asset_id) = (s(p, 0)?, s(p, 1)?);
    let seat = seat_of(d, &account_id, user_id)?;
    need(&seat, "propose")?;
    let Some((wallet, _)) = wallet_of(d, &account_id)? else {
        return Err(wallet_missing());
    };
    let run_key = crypto_payroll_key(payroll_id, period);
    in_tx(d.store, |tx| {
        if !tx
            .query(
                "SELECT 1 FROM bank.business_crypto_payroll_runs WHERE run_key = $1",
                &[&run_key],
            )
            .map_err(|e| pg(&e))?
            .is_empty()
        {
            return Ok(());
        }
        let members = tx
            .query(
                "SELECT m.contractor_id::text, c.name, c.wallet_address, m.amount::text \
                   FROM bank.business_crypto_payroll_members m \
                   JOIN bank.business_contractors c ON c.id = m.contractor_id \
                  WHERE m.payroll_id = $1::text::uuid ORDER BY c.created_at, c.id",
                &[&payroll_id],
            )
            .map_err(|e| pg(&e))?;
        let mut slips: Vec<(String, String, String, Amount)> = Vec::new();
        for m in &members {
            slips.push((
                s(m, 0)?,
                s(m, 1)?,
                o(m, 2)?.unwrap_or_default(),
                amount(&s(m, 3)?)?,
            ));
        }
        let total: Amount = slips.iter().map(|sl| sl.3).sum();
        let named: Vec<Slip<'_>> = slips
            .iter()
            .map(|(_, _, w, a)| Slip {
                wallet_address: w,
                amount: *a,
            })
            .collect();
        let message = payroll_run_message(&RunMessage {
            run_key: &run_key,
            business: &seat.name,
            wallet: &wallet,
            asset_id: &asset_id,
            period,
            payslips: &named,
            total,
        });
        let run_id = service_kit::approvals::random_uuid().map_err(Refusal::Other)?;
        // No conflict target: run_key and (payroll_id, period) name the same run (business_crypto_payroll_runs_key_ck),
        // so a racing loser on either key gets nothing back here instead of 23505, whatever the isolation level.
        let made = tx
            .query(
                "INSERT INTO bank.business_crypto_payroll_runs \
                   (id, payroll_id, period, run_key, wallet_address, message, amount, created_by) \
                 VALUES ($1::text::uuid, $2::text::uuid, $3, $4, $5, $6, $7::text::numeric, $8) \
                 ON CONFLICT DO NOTHING RETURNING id",
                &[
                    &run_id,
                    &payroll_id,
                    &period,
                    &run_key,
                    &wallet,
                    &message,
                    &format_amount(total),
                    &user_id,
                ],
            )
            .map_err(|e| pg(&e))?;
        if made.is_empty() {
            return Ok(());
        }
        for (contractor_id, name, w, a) in &slips {
            tx.execute(
                "INSERT INTO bank.business_crypto_payslips (run_id, contractor_id, name, wallet_address, asset_id, amount) \
                 VALUES ($1::text::uuid, $2::text::uuid, $3, $4, $5, $6::text::numeric)",
                &[&run_id, contractor_id, name, w, &asset_id, &format_amount(*a)],
            )
            .map_err(|e| pg(&e))?;
        }
        Ok(())
    })?;
    payroll_view(d, payroll_id)
}

/// `signRun`: the business's own wallet, as connected now, signs the run. Any other signer is refused and the run stays
/// unsigned.
pub fn sign_run(
    d: &Deps<'_>,
    run_id: &str,
    user_id: &str,
    signature: &str,
) -> Result<Json, Refusal> {
    let rows = with(d.store, |c| {
        c.query(
            "SELECT r.id::text, r.payroll_id::text, r.wallet_address, r.message, r.status, p.account_id::text \
               FROM bank.business_crypto_payroll_runs r JOIN bank.business_crypto_payrolls p ON p.id = r.payroll_id \
              WHERE r.id = $1::text::uuid",
            &[&run_id],
        )
        .map_err(|e| pg(&e))
    })?;
    let Some(r) = rows.first() else {
        return Err(refuse(
            "bank.contractor_not_found",
            "No payroll run of this business has that id.",
        ));
    };
    let (id, payroll_id, wallet, message, status, account_id) =
        (s(r, 0)?, s(r, 1)?, s(r, 2)?, s(r, 3)?, s(r, 4)?, s(r, 5)?);
    let seat = seat_of(d, &account_id, user_id)?;
    need(&seat, "propose")?;
    if status == "signed" {
        return payroll_view(d, &payroll_id);
    }
    // Signed by the business's own wallet as it is now: a run prepared for a wallet since replaced is not signed by it.
    if wallet_of(d, &account_id)?.is_none_or(|(now, _)| now != wallet) {
        return Err(refuse(
            "bank.payroll_wallet_missing",
            "The business’s wallet changed since this run was prepared. Prepare a new run for the wallet connected now.",
        ));
    }
    if recover_personal_sign_address(&message, signature).as_deref() != Some(wallet.as_str()) {
        return Err(refuse(
            "bank.payroll_signature_invalid",
            "That signature is not from the business’s own wallet. The run stays unsigned.",
        ));
    }
    with(d.store, |c| {
        c.execute(
            "UPDATE bank.business_crypto_payroll_runs SET status = 'signed', signature = $2, signed_at = now() \
              WHERE id = $1::text::uuid AND status = 'awaiting_signature'",
            &[&id, &js_trim(signature)],
        )
        .map_err(|e| pg(&e))
    })?;
    payroll_view(d, &payroll_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates_periods_and_emails_as_the_typescript_reads_them() {
        assert!(
            is_date("2024-02-29")
                && !is_date("2023-02-29")
                && !is_date("2024-13-01")
                && !is_date("2024-1-01")
        );
        assert!(
            is_period("2026-12")
                && !is_period("2026-13")
                && !is_period("2026-00")
                && !is_period("26-12")
        );
        assert!(
            email_shaped("a@b.co")
                && !email_shaped("a@b.")
                && !email_shaped("a@.b")
                && !email_shaped("a b@c.d")
        );
        assert!(!email_shaped("a@b@c.d") && !email_shaped("@b.c"));
    }

    #[test]
    fn the_run_message_names_every_payee_and_the_total() {
        let slips = [Slip {
            wallet_address: "0xabc",
            amount: parse_amount("250").unwrap_or(Amount::ZERO),
        }];
        let m = payroll_run_message(&RunMessage {
            run_key: "k",
            business: "TEST Ltd",
            wallet: "0xw",
            asset_id: "USDT",
            period: "2026-12",
            payslips: &slips,
            total: parse_amount("250").unwrap_or(Amount::ZERO),
        });
        assert_eq!(
            m,
            "INTAFACED crypto payroll run\nRun: k\nBusiness: TEST Ltd\nFrom your wallet: 0xw\nPeriod: 2026-12\n\
             Pay 250 USDT to 0xabc\nTotal: 250 USDT\nSigned by your own wallet. INTAFACED holds no key and no vault for this payroll."
        );
    }
}
