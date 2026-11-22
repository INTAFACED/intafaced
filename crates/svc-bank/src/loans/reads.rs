//! BK-loan-06 (`loans/loan-reads.ts`, and the service's `projection`, `payoffQuote` and `statement`). Reads only.
//!
//! A crypto-backed loan has no instalment schedule: a projection replays the accrual job's `dailyLoanInterest` and is
//! never an obligation. A payoff quote adds only a fee the owner published, and only a published zero for now (repay
//! has no fee entry). A blank fee or validity window refuses; nothing here stores a quote or posts.

use base64::Engine as _;
use hmac::{Hmac, Mac};
use postgres::{GenericClient, IsolationLevel};
use service_kit::json::Json;
use service_kit::money::{Amount, format_amount, parse_amount};
use service_kit::time::{Instant, v8_date_parse};
use sha2::{Digest, Sha256};

use super::model::{Loan, loan, ms, outstanding};
use super::ports::Deps;
use super::risk::{accrual_day, daily_loan_interest, days_to_accrue};
use super::service::{backlog, has_open_shortfall, instant_f64};
use crate::errors::Refusal;
use crate::partner::refuse;
use crate::spaces::space::{pg, with};

const WINDOW_MAX_MINUTES: i64 = 10_080;
/// The most lines in one loan statement; a wider range is refused, never cut.
const MAX_STATEMENT_LINES: usize = 5_000;
const DAY_MS: i64 = 86_400_000;

fn amount_text(s: &str) -> Result<Amount, Refusal> {
    parse_amount(s).map_err(Refusal::Other)
}

/// `parsePayoffFee`: a published decimal, and only zero.
pub fn parse_payoff_fee(raw: Option<&str>) -> Result<Amount, Refusal> {
    let text = raw.map_or("", str::trim);
    let (whole, frac) = text.split_once('.').unwrap_or((text, ""));
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    let shaped = digits(whole) && (!text.contains('.') || (digits(frac) && frac.len() <= 18));
    if !shaped {
        return Err(refuse(
            "bank.loan_fee_unset",
            "The owner has not published the loan payoff fee, so no payoff quote is given",
        ));
    }
    let fee = amount_text(text)?;
    if fee != 0 {
        return Err(refuse(
            "bank.loan_fee_unsupported",
            "A loan payoff fee is published, but repay cannot collect a fee, so no payoff quote is given",
        ));
    }
    Ok(fee)
}

/// `parsePayoffWindowMinutes`: whole minutes, 1 to a week.
pub fn parse_payoff_window(raw: Option<&str>) -> Result<i64, Refusal> {
    let text = raw.map_or("", str::trim);
    let unset = || {
        refuse(
            "bank.loan_payoff_window_unset",
            "The owner has not published how long a loan payoff quote stays valid, so no payoff quote is given",
        )
    };
    if text.is_empty() || !text.bytes().all(|b| b.is_ascii_digit()) {
        return Err(unset());
    }
    match text.parse::<i64>() {
        Ok(m) if (1..=WINDOW_MAX_MINUTES).contains(&m) => Ok(m),
        _ => Err(unset()),
    }
}

fn assert_apr(apr_bps: i64) -> Result<(), Refusal> {
    if (0..=10_000).contains(&apr_bps) {
        Ok(())
    } else {
        Err(refuse(
            "bank.loan_terms_missing",
            "This loan has no usable rate snapshot, so it cannot be projected",
        ))
    }
}

/// `applyInterestFirst`: interest first, then principal, never more than is owed.
pub fn apply_interest_first(
    principal: Amount,
    interest: Amount,
    payment: Amount,
) -> (Amount, Amount, Amount) {
    let owed = principal + interest;
    let applied = payment.min(owed);
    let to_interest = applied.min(interest);
    (
        principal - (applied - to_interest),
        interest - to_interest,
        applied,
    )
}

fn day_ms(day: &str) -> Option<i64> {
    service_kit::time::es_date_at_midnight(day).map(|i| i.0)
}

fn add_days(day: &str, n: i64) -> Result<String, Refusal> {
    let ms = day_ms(day).ok_or_else(|| Refusal::Other(format!("Invalid day {day}")))?;
    Ok(accrual_day(Instant(ms + n * DAY_MS)))
}

/// `projectLoanDays`: the next `days` accrual days after `charged_through`, compounding as `accrue` does.
#[allow(clippy::too_many_arguments, reason = "the TypeScript's own input")]
pub fn project_days(
    loan_id: &str,
    principal: Amount,
    interest: Amount,
    apr_bps: i64,
    days: f64,
    charged_through: &str,
    days_per_year: i64,
    extra: Option<Amount>,
) -> Result<Json, Refusal> {
    assert_apr(apr_bps)?;
    if days.fract() != 0.0 || !(1.0..=366.0).contains(&days) {
        return Err(refuse(
            "bank.statement_range",
            "A loan projection covers 1 to 366 days",
        ));
    }
    #[allow(
        clippy::cast_possible_truncation,
        reason = "a whole number from 1 to 366"
    )]
    let days = days as i64;
    let applied = extra
        .filter(|e| *e > 0)
        .map(|e| apply_interest_first(principal, interest, e));
    let (mut principal, mut interest) = applied.map_or((principal, interest), |(p, i, _)| (p, i));
    let opening_principal = format_amount(principal);
    let opening_interest = format_amount(interest);
    let mut rows = Vec::new();
    for n in 1..=days {
        let basis = principal + interest;
        let charge = daily_loan_interest(basis, apr_bps, days_per_year).map_err(backlog)?;
        interest += charge;
        rows.push(Json::obj([
            ("date", Json::str(add_days(charged_through, n)?)),
            ("basis", Json::str(format_amount(basis))),
            ("interest", Json::str(format_amount(charge))),
            ("principal", Json::str(format_amount(principal))),
            ("debt", Json::str(format_amount(principal + interest))),
        ]));
    }
    let _ = &mut principal;
    Ok(Json::obj([
        ("loanId", Json::str(loan_id)),
        ("kind", Json::str("projection")),
        ("obligation", Json::Bool(false)),
        ("aprBps", Json::int(apr_bps)),
        ("days", Json::int(days)),
        ("openingPrincipal", Json::str(opening_principal)),
        ("openingInterest", Json::str(opening_interest)),
        (
            "extraApplied",
            applied.map_or(Json::Null, |(_, _, a)| Json::str(format_amount(a))),
        ),
        ("rows", Json::Array(rows)),
    ]))
}

/// What `quotePayoff` reads.
pub struct PayoffAsk<'a> {
    pub loan_id: &'a str,
    pub principal: Amount,
    pub interest: Amount,
    pub apr_bps: i64,
    pub uncharged_days: usize,
    pub days_per_year: i64,
    pub asset_id: &'a str,
    pub fee_raw: Option<&'a str>,
    pub window_raw: Option<&'a str>,
    pub now: Instant,
}

/// `quotePayoff`: what clears the loan today, valid until the owner's window or the UTC day ends.
pub fn quote_payoff(a: &PayoffAsk<'_>) -> Result<Json, Refusal> {
    if a.principal + a.interest <= 0 {
        return Err(refuse(
            "bank.loan_closed",
            format!("Loan {} has nothing outstanding", a.loan_id),
        ));
    }
    assert_apr(a.apr_bps)?;
    let fee = parse_payoff_fee(a.fee_raw)?;
    let minutes = parse_payoff_window(a.window_raw)?;
    let mut interest = a.interest;
    for _ in 0..a.uncharged_days {
        interest += daily_loan_interest(a.principal + interest, a.apr_bps, a.days_per_year)
            .map_err(backlog)?;
    }
    let total = a.principal + interest + fee;
    let today = accrual_day(a.now);
    let window_end = a.now.0 + minutes * 60_000;
    let day_end = day_ms(&add_days(&today, 1)?).unwrap_or(window_end);
    Ok(Json::obj([
        ("loanId", Json::str(a.loan_id)),
        ("principal", Json::str(format_amount(a.principal))),
        ("interest", Json::str(format_amount(interest))),
        ("fee", Json::str(format_amount(fee))),
        ("total", Json::str(format_amount(total))),
        ("assetId", Json::str(a.asset_id)),
        ("interestThrough", Json::str(today)),
        (
            "validUntil",
            Json::str(Instant(window_end.min(day_end)).iso()),
        ),
    ]))
}

/// `assertProjectable`.
pub fn assert_projectable(l: &Loan) -> Result<(), Refusal> {
    match l.status.as_str() {
        "pending" => Err(refuse(
            "bank.loan_not_drawable",
            format!("Loan {} has no drawn principal", l.id),
        )),
        "liquidating" => Err(refuse(
            "bank.loan_liquidating",
            format!("Loan {} is mid-liquidation", l.id),
        )),
        "repaid" | "liquidated" => Err(refuse(
            "bank.loan_closed",
            format!("Loan {} is {}", l.id, l.status),
        )),
        _ => Ok(()),
    }
}

/// `chargedThrough`: the last day `accrue` charged, or the open day.
pub fn charged_through(c: &mut impl GenericClient, l: &Loan) -> Result<String, Refusal> {
    Ok(super::service::last_accrued(c, &l.id)?.unwrap_or_else(|| accrual_day(l.opened_at)))
}

/// `projection`.
pub fn projection(
    d: &Deps<'_>,
    loan_id: &str,
    days: f64,
    extra: Option<Amount>,
) -> Result<Json, Refusal> {
    let l = with(d.store, |c| loan(c, loan_id))?;
    assert_projectable(&l)?;
    let (debt, through) = with(d.store, |c| {
        Ok((outstanding(c, &l.id)?, charged_through(c, &l)?))
    })?;
    project_days(
        &l.id,
        debt.principal,
        debt.interest,
        l.apr_bps,
        days,
        &through,
        d.settings.days_per_year,
        extra,
    )
}

/// `payoffQuote`: refused, as repay would refuse, while a repayment or sale is pending or a shortfall is uncovered.
pub fn payoff_quote(d: &Deps<'_>, loan_id: &str, now: Instant) -> Result<Json, Refusal> {
    let l = with(d.store, |c| loan(c, loan_id))?;
    assert_projectable(&l)?;
    let (debt, through, repayments, sales, shortfall) = with(d.store, |c| {
        let r = c
            .query_one(
                "SELECT (SELECT COUNT(*) FROM bank.loan_repayments WHERE loan_id = $1::text::uuid AND status = 'pending')::int8,
                        (SELECT COUNT(*) FROM bank.loan_liquidations WHERE loan_id = $1::text::uuid AND status = 'pending')::int8",
                &[&l.id],
            )
            .map_err(|e| pg(&e))?;
        Ok((
            outstanding(c, &l.id)?,
            charged_through(c, &l)?,
            r.try_get::<_, i64>(0).map_err(|e| pg(&e))?,
            r.try_get::<_, i64>(1).map_err(|e| pg(&e))?,
            has_open_shortfall(c, &l.id)?,
        ))
    })?;
    if repayments > 0 {
        return Err(refuse(
            "bank.ledger_outcome_unknown",
            format!(
                "Loan {} has a repayment whose ledger outcome is not known yet, so no payoff quote is given",
                l.id
            ),
        ));
    }
    if sales > 0 || shortfall {
        return Err(refuse(
            "bank.loan_liquidating",
            format!(
                "Loan {} has a sale or an uncovered shortfall still open, so no payoff quote is given",
                l.id
            ),
        ));
    }
    let uncharged = days_to_accrue(Some(&through), l.opened_at, now, 400).map_err(backlog)?;
    quote_payoff(&PayoffAsk {
        loan_id: &l.id,
        principal: debt.principal,
        interest: debt.interest,
        apr_bps: l.apr_bps,
        uncharged_days: uncharged.len(),
        days_per_year: d.settings.days_per_year,
        asset_id: &l.debt_asset_id,
        fee_raw: d.settings.payoff_fee.as_deref(),
        window_raw: d.settings.payoff_window_minutes.as_deref(),
        now,
    })
}

// ── The statement ────────────────────────────────────────────────────────────────────────────────────────────────────

/// `csvCell`: a free-text cell a spreadsheet would run as a formula is prefixed with `'`.
pub fn csv_cell(value: &str, text: bool) -> String {
    let risky = text && value.starts_with(['=', '+', '-', '@', '\t', '\r']);
    let safe = if risky {
        format!("'{value}")
    } else {
        value.to_owned()
    };
    if safe.contains(['"', ',', '\r', '\n']) {
        format!("\"{}\"", safe.replace('"', "\"\""))
    } else {
        safe
    }
}

type HmacSha256 = Hmac<Sha256>;

fn hmac(key: &[u8], bytes: &[u8]) -> Vec<u8> {
    #[allow(clippy::expect_used, reason = "HMAC takes a key of any length")]
    let mut m = HmacSha256::new_from_slice(key).expect("hmac key");
    m.update(bytes);
    m.finalize().into_bytes().to_vec()
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    bytes.iter().fold(String::new(), |mut s, b| {
        let _ = write!(s, "{b:02x}");
        s
    })
}

/// `statementKey`: HKDF-SHA256(secret, empty salt, `bank.statement.file.v1`, 32 bytes), RFC 5869.
pub fn statement_key(secret: &str) -> Vec<u8> {
    // An empty salt is HashLen zeros; 32 bytes is one block of the expansion.
    let prk = hmac(&[0_u8; 32], secret.as_bytes());
    let mut info = b"bank.statement.file.v1".to_vec();
    info.push(1);
    hmac(&prk, &info)
}

/// `signStatement`: the file's sha256 and its HMAC under the statement key, both hex.
pub fn sign_statement(secret: &str, bytes: &[u8]) -> (String, String) {
    (
        hex(&Sha256::digest(bytes)),
        hex(&hmac(&statement_key(secret), bytes)),
    )
}

struct Line {
    kind: &'static str,
    at: i64,
    amount: Amount,
    interest: Amount,
    principal: Amount,
    asset: String,
    ledger_tx_id: String,
}

/// `debtBefore`: principal and interest owed just before `cutoff`.
fn debt_before(
    c: &mut impl GenericClient,
    loan_id: &str,
    cutoff: i64,
    drawn_principal: Amount,
    drawn_at: Option<i64>,
) -> Result<(Amount, Amount), Refusal> {
    let day = accrual_day(Instant(cutoff));
    let drawn = if drawn_at.is_some_and(|t| t < cutoff) {
        drawn_principal
    } else {
        0
    };
    let cut = instant_f64(Instant(cutoff));
    let r = c
        .query_one(
            "SELECT
               (SELECT COALESCE(SUM(interest_amount), 0) FROM bank.loan_interest_accruals
                 WHERE loan_id = $1::text::uuid AND accrual_date < $2::text::date)::text,
               (SELECT COALESCE(SUM(amount), 0) FROM bank.loan_adjustments
                 WHERE loan_id = $1::text::uuid AND kind = 'interest_correction'
                   AND created_at < to_timestamp($3::float8 / 1000))::text,
               (SELECT COALESCE(SUM(principal_amount), 0) FROM bank.loan_repayments
                 WHERE loan_id = $1::text::uuid AND status = 'settled'
                   AND COALESCE(settled_at, created_at) < to_timestamp($3::float8 / 1000))::text,
               (SELECT COALESCE(SUM(interest_amount), 0) FROM bank.loan_repayments
                 WHERE loan_id = $1::text::uuid AND status = 'settled'
                   AND COALESCE(settled_at, created_at) < to_timestamp($3::float8 / 1000))::text,
               (SELECT COALESCE(SUM(principal_repaid), 0) FROM bank.loan_liquidations
                 WHERE loan_id = $1::text::uuid AND status = 'settled'
                   AND COALESCE(settled_at, created_at) < to_timestamp($3::float8 / 1000))::text,
               (SELECT COALESCE(SUM(interest_repaid), 0) FROM bank.loan_liquidations
                 WHERE loan_id = $1::text::uuid AND status = 'settled'
                   AND COALESCE(settled_at, created_at) < to_timestamp($3::float8 / 1000))::text,
               (SELECT COALESCE(SUM(CASE WHEN shortfall > 0 AND bad_debt_ledger_tx_id IS NOT NULL THEN shortfall ELSE 0 END), 0)
                  FROM bank.loan_liquidations
                 WHERE loan_id = $1::text::uuid AND status = 'settled'
                   AND COALESCE(settled_at, created_at) < to_timestamp($3::float8 / 1000))::text",
            &[&loan_id, &day, &cut],
        )
        .map_err(|e| pg(&e))?;
    let v = |i: usize| -> Result<Amount, Refusal> {
        amount_text(&r.try_get::<_, String>(i).map_err(|e| pg(&e))?)
    };
    let (accrued, adjusted, repaid_p, repaid_i, seized_p, seized_i, seized_s) =
        (v(0)?, v(1)?, v(2)?, v(3)?, v(4)?, v(5)?, v(6)?);
    // Insured shortfall is principal the books wrote off, counted once its bad-debt tx is set, as `outstanding` does.
    let principal = drawn - repaid_p - seized_p - seized_s;
    let interest = accrued + adjusted - repaid_i - seized_i;
    Ok((principal.max(0), interest.max(0)))
}

fn assert_range(from: &str, to: &str) -> Result<(i64, i64), Refusal> {
    let (Some(f), Some(t)) = (v8_date_parse(from), v8_date_parse(to)) else {
        return Err(refuse(
            "bank.statement_range",
            "The statement end is not after the start",
        ));
    };
    if f >= t {
        return Err(refuse(
            "bank.statement_range",
            "The statement end is not after the start",
        ));
    }
    if t - f > 366 * DAY_MS {
        return Err(refuse(
            "bank.statement_range",
            "A statement covers at most 366 days",
        ));
    }
    Ok((f, t))
}

/// `buildLoanStatement` (`statement`): a signed CSV of one loan's range, every read in one snapshot.
#[allow(
    clippy::too_many_lines,
    reason = "one file, read in the TypeScript's order"
)]
pub fn statement(
    d: &Deps<'_>,
    loan_id: &str,
    from: &str,
    to: &str,
    now: Instant,
) -> Result<Json, Refusal> {
    let l = with(d.store, |c| loan(c, loan_id))?;
    let secret = d
        .settings
        .statement_secret
        .as_deref()
        .map_or("", str::trim)
        .to_owned();
    if secret.is_empty() {
        return Err(refuse(
            "bank.statement_unavailable",
            "Statements are not available until the service secret is set",
        ));
    }
    let (from_ms, to_ms) = assert_range(from, to)?;
    let cap = i64::try_from(MAX_STATEMENT_LINES + 1).unwrap_or(i64::MAX);
    let (from_f, to_f) = (instant_f64(Instant(from_ms)), instant_f64(Instant(to_ms)));
    let (from_day, to_day) = (accrual_day(Instant(from_ms)), accrual_day(Instant(to_ms)));
    let mut lines: Vec<Line> = Vec::new();
    let (drawn_at, opening, closing) = with(d.store, |c| {
        let mut tx = c
            .build_transaction()
            .isolation_level(IsolationLevel::RepeatableRead)
            .read_only(true)
            .start()
            .map_err(|e| pg(&e))?;
        let drawn_at: Option<i64> = tx
            .query_one(
                &format!(
                    "SELECT {} FROM bank.loans WHERE id = $1::text::uuid",
                    ms("drawn_at")
                ),
                &[&l.id],
            )
            .map_err(|e| pg(&e))?
            .try_get(0)
            .map_err(|e| pg(&e))?;
        let opening = debt_before(&mut tx, &l.id, from_ms, l.principal, drawn_at)?;
        let closing = debt_before(&mut tx, &l.id, to_ms, l.principal, drawn_at)?;
        if let Some(at) = drawn_at.filter(|t| *t >= from_ms && *t < to_ms) {
            lines.push(Line {
                kind: "draw",
                at,
                amount: l.principal,
                interest: 0,
                principal: l.principal,
                asset: l.debt_asset_id.clone(),
                ledger_tx_id: l.draw_ledger_tx_id.clone().unwrap_or_default(),
            });
        }
        for r in tx
            .query(
                "SELECT accrual_date::text, interest_amount::text FROM bank.loan_interest_accruals
                  WHERE loan_id = $1::text::uuid AND accrual_date >= $2::text::date AND accrual_date < $3::text::date
                  ORDER BY accrual_date ASC LIMIT $4",
                &[&l.id, &from_day, &to_day, &cap],
            )
            .map_err(|e| pg(&e))?
        {
            let day: String = r.try_get(0).map_err(|e| pg(&e))?;
            let interest = amount_text(&r.try_get::<_, String>(1).map_err(|e| pg(&e))?)?;
            lines.push(Line {
                kind: "interest",
                at: day_ms(&day).unwrap_or(0),
                amount: interest,
                interest,
                principal: 0,
                asset: l.debt_asset_id.clone(),
                ledger_tx_id: String::new(),
            });
        }
        // An approved correction (LOAN-05), signed. It moves no value.
        for r in tx
            .query(
                &format!(
                    "SELECT {}, amount::text FROM bank.loan_adjustments
                      WHERE loan_id = $1::text::uuid AND kind = 'interest_correction'
                        AND created_at >= to_timestamp($2::float8 / 1000) AND created_at < to_timestamp($3::float8 / 1000)
                      ORDER BY created_at ASC, id ASC LIMIT $4",
                    ms("created_at")
                ),
                &[&l.id, &from_f, &to_f, &cap],
            )
            .map_err(|e| pg(&e))?
        {
            let interest = amount_text(&r.try_get::<_, String>(1).map_err(|e| pg(&e))?)?;
            lines.push(Line {
                kind: "interest_correction",
                at: r.try_get(0).map_err(|e| pg(&e))?,
                amount: interest,
                interest,
                principal: 0,
                asset: l.debt_asset_id.clone(),
                ledger_tx_id: String::new(),
            });
        }
        for r in tx
            .query(
                &format!(
                    "SELECT {}, interest_amount::text, principal_amount::text, ledger_tx_id FROM bank.loan_repayments
                      WHERE loan_id = $1::text::uuid AND status = 'settled'
                        AND COALESCE(settled_at, created_at) >= to_timestamp($2::float8 / 1000)
                        AND COALESCE(settled_at, created_at) < to_timestamp($3::float8 / 1000)
                      ORDER BY COALESCE(settled_at, created_at) ASC, sequence ASC LIMIT $4",
                    ms("COALESCE(settled_at, created_at)")
                ),
                &[&l.id, &from_f, &to_f, &cap],
            )
            .map_err(|e| pg(&e))?
        {
            let interest = amount_text(&r.try_get::<_, String>(1).map_err(|e| pg(&e))?)?;
            let principal = amount_text(&r.try_get::<_, String>(2).map_err(|e| pg(&e))?)?;
            lines.push(Line {
                kind: "repayment",
                at: r.try_get(0).map_err(|e| pg(&e))?,
                amount: interest + principal,
                interest,
                principal,
                asset: l.debt_asset_id.clone(),
                ledger_tx_id: r.try_get::<_, Option<String>>(3).map_err(|e| pg(&e))?.unwrap_or_default(),
            });
        }
        for r in tx
            .query(
                &format!(
                    "SELECT {}, direction::text, sequence::int8, amount::text, ledger_tx_id FROM bank.loan_collateral_events
                      WHERE loan_id = $1::text::uuid AND status = 'settled'
                        AND COALESCE(settled_at, created_at) >= to_timestamp($2::float8 / 1000)
                        AND COALESCE(settled_at, created_at) < to_timestamp($3::float8 / 1000)
                      ORDER BY COALESCE(settled_at, created_at) ASC, sequence ASC LIMIT $4",
                    ms("COALESCE(settled_at, created_at)")
                ),
                &[&l.id, &from_f, &to_f, &cap],
            )
            .map_err(|e| pg(&e))?
        {
            let direction: String = r.try_get(1).map_err(|e| pg(&e))?;
            let sequence: i64 = r.try_get(2).map_err(|e| pg(&e))?;
            // Sequence 0 is the pledge made at open; later locks are top-ups.
            let kind = if direction == "release" {
                "collateral_release"
            } else if sequence == 0 {
                "collateral_pledge"
            } else {
                "collateral_top_up"
            };
            lines.push(Line {
                kind,
                at: r.try_get(0).map_err(|e| pg(&e))?,
                amount: amount_text(&r.try_get::<_, String>(3).map_err(|e| pg(&e))?)?,
                interest: 0,
                principal: 0,
                asset: l.collateral_asset_id.clone(),
                ledger_tx_id: r.try_get::<_, Option<String>>(4).map_err(|e| pg(&e))?.unwrap_or_default(),
            });
        }
        for r in tx
            .query(
                &format!(
                    "SELECT {}, interest_repaid::text, principal_repaid::text, shortfall::text, ledger_tx_id,
                            bad_debt_ledger_tx_id
                       FROM bank.loan_liquidations
                      WHERE loan_id = $1::text::uuid AND status = 'settled'
                        AND COALESCE(settled_at, created_at) >= to_timestamp($2::float8 / 1000)
                        AND COALESCE(settled_at, created_at) < to_timestamp($3::float8 / 1000)
                      ORDER BY COALESCE(settled_at, created_at) ASC, tranche ASC LIMIT $4",
                    ms("COALESCE(settled_at, created_at)")
                ),
                &[&l.id, &from_f, &to_f, &cap],
            )
            .map_err(|e| pg(&e))?
        {
            let at: i64 = r.try_get(0).map_err(|e| pg(&e))?;
            let interest = amount_text(&r.try_get::<_, String>(1).map_err(|e| pg(&e))?)?;
            let principal = amount_text(&r.try_get::<_, String>(2).map_err(|e| pg(&e))?)?;
            lines.push(Line {
                kind: "liquidation",
                at,
                amount: interest + principal,
                interest,
                principal,
                asset: l.debt_asset_id.clone(),
                ledger_tx_id: r.try_get::<_, Option<String>>(4).map_err(|e| pg(&e))?.unwrap_or_default(),
            });
            let shortfall = amount_text(&r.try_get::<_, String>(3).map_err(|e| pg(&e))?)?;
            let bad: Option<String> = r.try_get(5).map_err(|e| pg(&e))?;
            if let Some(bad) = bad.filter(|_| shortfall > 0) {
                lines.push(Line {
                    kind: "liquidation_shortfall",
                    at,
                    amount: shortfall,
                    interest: 0,
                    principal: shortfall,
                    asset: l.debt_asset_id.clone(),
                    ledger_tx_id: bad,
                });
            }
        }
        tx.commit().map_err(|e| pg(&e))?;
        Ok((drawn_at, opening, closing))
    })?;
    let _ = drawn_at;
    if lines.len() > MAX_STATEMENT_LINES {
        return Err(refuse(
            "bank.statement_too_large",
            format!(
                "A loan statement holds at most {MAX_STATEMENT_LINES} lines. Narrow the dates."
            ),
        ));
    }
    // Time order; stable, so lines at the same instant keep the order above (the TypeScript compares ISO text).
    lines.sort_by_key(|line| line.at);
    let provisional = to_ms > now.0;
    let row = |kind: &str,
               at: i64,
               amount: Amount,
               interest: Amount,
               principal: Amount,
               asset: &str,
               tx: &str| {
        [
            csv_cell(kind, true),
            csv_cell(&Instant(at).iso(), false),
            csv_cell(&format_amount(amount), false),
            csv_cell(&format_amount(interest), false),
            csv_cell(&format_amount(principal), false),
            csv_cell(asset, true),
            csv_cell(tx, true),
        ]
        .join(",")
    };
    let mut text = vec![
        "kind,at,amount,interest,principal,asset,ledgerTxId".to_owned(),
        row(
            "opening",
            from_ms,
            opening.0 + opening.1,
            opening.1,
            opening.0,
            &l.debt_asset_id,
            "",
        ),
    ];
    for line in &lines {
        text.push(row(
            line.kind,
            line.at,
            line.amount,
            line.interest,
            line.principal,
            &line.asset,
            &line.ledger_tx_id,
        ));
    }
    text.push(row(
        if provisional {
            "closing_provisional"
        } else {
            "closing"
        },
        to_ms,
        closing.0 + closing.1,
        closing.1,
        closing.0,
        &l.debt_asset_id,
        "",
    ));
    let body = format!("\u{FEFF}{}\r\n", text.join("\r\n"));
    let bytes = body.as_bytes();
    let (sha256, signature) = sign_statement(&secret, bytes);
    let prefix: String = from.chars().take(10).collect();
    Ok(Json::obj([
        ("format", Json::str("csv")),
        (
            "filename",
            Json::str(format!("intafaced-loan-{}-{prefix}.csv", l.id)),
        ),
        ("contentType", Json::str("text/csv; charset=utf-8")),
        (
            "bodyBase64",
            Json::str(base64::engine::general_purpose::STANDARD.encode(bytes)),
        ),
        ("sha256", Json::str(sha256)),
        ("signature", Json::str(signature)),
        (
            "rowCount",
            Json::int(i64::try_from(lines.len()).unwrap_or(i64::MAX)),
        ),
        ("provisional", Json::Bool(provisional)),
        ("openingPrincipal", Json::str(format_amount(opening.0))),
        ("openingInterest", Json::str(format_amount(opening.1))),
        ("closingPrincipal", Json::str(format_amount(closing.0))),
        ("closingInterest", Json::str(format_amount(closing.1))),
        ("generatedAt", Json::str(now.iso())),
    ]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn statement_key_matches_node_hkdf() {
        // node -e "const c=require('crypto');console.log(Buffer.from(c.hkdfSync('sha256','s',Buffer.alloc(0),'bank.statement.file.v1',32)).toString('hex'))"
        assert_eq!(
            hex(&statement_key("s")),
            "27955493f38bd2b757c2cf1c37e7b11b56f847ac0123fccd7e1a804352ce5b61"
        );
    }

    #[test]
    fn csv_cell_quotes_and_defuses() {
        assert_eq!(csv_cell("=1", true), "'=1");
        assert_eq!(csv_cell("=1", false), "=1");
        assert_eq!(csv_cell("a,b", false), "\"a,b\"");
        assert_eq!(csv_cell("a\"b", false), "\"a\"\"b\"");
    }

    #[test]
    fn payoff_fee_and_window() {
        assert!(parse_payoff_fee(Some("0")).is_ok());
        assert!(parse_payoff_fee(Some("0.00")).is_ok());
        assert!(parse_payoff_fee(Some("")).is_err());
        assert!(parse_payoff_fee(Some("1")).is_err());
        assert!(parse_payoff_fee(Some(".5")).is_err());
        assert_eq!(parse_payoff_window(Some(" 15 ")).ok(), Some(15));
        assert!(parse_payoff_window(Some("0")).is_err());
        assert!(parse_payoff_window(Some("10081")).is_err());
    }
}
