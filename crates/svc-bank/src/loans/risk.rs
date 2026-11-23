//! `loans/risk.ts`: loan risk, pure arithmetic, no I/O, no clock, no database.
//!
//! An LTV computed in floating point is a wrong liquidation price, so prices, values and ratios are scaled integers,
//! ratios are integer basis points, and every division states its rounding. The rule is "round so the mistake lands on
//! whoever chose the risk": RISK figures round against the platform's optimism (LTV up, debt value up, collateral value
//! down); CHARGES to the borrower round down (interest, and the seizure needed to restore a target LTV).
//!
//! Products are formed in 256 bits by the kit's `mul_div`, so every quotient is the TypeScript bigint's whenever it fits
//! an i128. Where the TypeScript throws a JavaScript error rather than a `RiskError` (bigint division by zero, `mulBps`
//! on a negative rate, an invalid `Date`), this returns a `RiskError` whose code is that error's class name
//! (`MoneyError`, `RangeError`) and whose message is the TypeScript's.

use std::collections::BTreeMap;
use std::fmt;

use service_kit::money::{Amount, Rounding, mul_div, mul_rounded, parse_amount};
use service_kit::time::Instant;

/// 100% in basis points. LTV, thresholds and penalties are all integer bps.
pub const BPS: i64 = 10_000;

/// §8.1 specifies interest as a DAILY recipe. 365, matching `earn/interest.ts`.
pub const DAYS_PER_YEAR: i64 = 365;

/// `Number.MAX_SAFE_INTEGER`: the LTV of debt against no collateral.
pub const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

const SCALE: Amount = Amount::whole(1);
const DAY_MS: i64 = 86_400_000;

/// `RiskError(message, code)`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RiskError {
    pub message: String,
    pub code: String,
}

impl RiskError {
    pub fn new(message: impl Into<String>, code: impl Into<String>) -> RiskError {
        RiskError {
            message: message.into(),
            code: code.into(),
        }
    }

    /// The ledger client's `MoneyError` where the TypeScript would throw one.
    pub(crate) fn money(message: impl Into<String>) -> RiskError {
        RiskError::new(message, "MoneyError")
    }
}

impl fmt::Display for RiskError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for RiskError {}

/// The two roundings a valuation may take: collateral `Floor`, debt `Ceil`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Round {
    Floor,
    Ceil,
}

impl Round {
    pub fn kit(self) -> Rounding {
        match self {
            Round::Floor => Rounding::Floor,
            Round::Ceil => Rounding::Ceil,
        }
    }
}

// ── Valuation ────────────────────────────────────────────────────────────────

/// A mark for one asset, in the loan's quote asset. `as_of` is not optional: a price with no timestamp cannot be
/// checked for staleness, and a stale price is the cheapest way to liquidate someone who is not in trouble.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Mark {
    pub asset_id: String,
    pub price: Amount,
    pub as_of: Instant,
}

impl AsRef<Mark> for Mark {
    fn as_ref(&self) -> &Mark {
        self
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Holding {
    pub asset_id: String,
    pub quantity: Amount,
}

/// `mulBps(amount, bps, rounding)`: refuses a negative rate as the ledger client does.
pub(crate) fn mul_bps(amount: Amount, bps: i64, rounding: Rounding) -> Result<Amount, RiskError> {
    if bps < 0 {
        return Err(RiskError::money(format!(
            "bps must be a non-negative integer, got {bps}"
        )));
    }
    // `amount * bps / BPS`: both are counts of basis points, carried as scaled factors.
    Ok(mul_div(
        amount,
        Amount::from_scaled(i128::from(bps)),
        Amount::from_scaled(i128::from(BPS)),
        rounding,
    ))
}

/// `div(a, b, rounding)`: `a * SCALE / b`.
pub(crate) fn div(a: Amount, b: Amount, rounding: Rounding) -> Result<Amount, RiskError> {
    if b == Amount::ZERO {
        return Err(RiskError::money("Division by zero"));
    }
    Ok(mul_div(a, SCALE, b, rounding))
}

/// `valueAt`: value holdings at marks. `rounding` is required because the caller is always valuing either collateral
/// (down) or debt (up). A missing mark is refused, never valued at zero: zero collateral reads as "liquidate".
pub fn value_at<M: AsRef<Mark>>(
    holdings: &[Holding],
    marks: &BTreeMap<String, M>,
    rounding: Round,
) -> Result<Amount, RiskError> {
    let mut total: Amount = Amount::ZERO;
    for h in holdings {
        let Some(mark) = marks.get(&h.asset_id) else {
            return Err(RiskError::new(
                format!(
                    "No mark for {} — cannot value a position with a missing price",
                    h.asset_id
                ),
                "bank.mark_missing",
            ));
        };
        total = total.saturating_add(mul_rounded(h.quantity, mark.as_ref().price, rounding.kit()));
    }
    Ok(total)
}

// ── Loan-to-value ────────────────────────────────────────────────────────────

/// `ltvBps`: the debt as a fraction of the collateral, in integer bps, rounded UP so a loan on the boundary is treated
/// as over it. Zero collateral against real debt is unsecured: `MAX_SAFE_INTEGER`, past every threshold. Deliberately
/// not `div` then a whole-bps floor, which silently undoes the ceil.
pub fn ltv_bps(debt_value: Amount, collateral_value: Amount) -> Result<i64, RiskError> {
    if debt_value < Amount::ZERO {
        return Err(RiskError::new(
            "Debt value cannot be negative",
            "bank.risk_invalid",
        ));
    }
    if collateral_value < Amount::ZERO {
        return Err(RiskError::new(
            "Collateral value cannot be negative",
            "bank.risk_invalid",
        ));
    }
    if debt_value == Amount::ZERO {
        return Ok(0);
    }
    if collateral_value == Amount::ZERO {
        return Ok(MAX_SAFE_INTEGER);
    }
    // debt / collateral in basis points: a ratio of two amounts times a count, so the quotient's scaled integer is the
    // count of basis points itself.
    let bps = mul_div(
        debt_value,
        Amount::from_scaled(i128::from(BPS)),
        collateral_value,
        Rounding::Ceil,
    )
    .scaled();
    Ok(i64::try_from(bps)
        .unwrap_or(MAX_SAFE_INTEGER)
        .min(MAX_SAFE_INTEGER))
}

/// `LoanExposure`. Collateral is locked per loan in the ledger (`loan:<id>`), so the portfolio LTV is a warning
/// signal, never authority to seize: `plan_liquidation` only ever works on one loan's own pot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoanExposure {
    pub loan_id: String,
    pub debt_asset_id: String,
    /// Principal plus capitalised interest, as at the mark.
    pub debt: Amount,
    pub collateral_asset_id: String,
    pub collateral: Amount,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoanMark {
    pub loan_id: String,
    pub debt_value: Amount,
    pub collateral_value: Amount,
    pub ltv_bps: i64,
}

/// `PortfolioMark`: the aggregate and each loan's own figure, so the two are never confused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PortfolioMark {
    pub debt_value: Amount,
    pub collateral_value: Amount,
    pub portfolio_ltv_bps: i64,
    pub loans: Vec<LoanMark>,
}

/// `markPortfolio`: debt up, collateral down, per loan and in aggregate.
pub fn mark_portfolio<M: AsRef<Mark>>(
    exposures: &[LoanExposure],
    marks: &BTreeMap<String, M>,
) -> Result<PortfolioMark, RiskError> {
    let mut loans = Vec::with_capacity(exposures.len());
    for e in exposures {
        let debt_value = value_at(
            &[Holding {
                asset_id: e.debt_asset_id.clone(),
                quantity: e.debt,
            }],
            marks,
            Round::Ceil,
        )?;
        let collateral_value = value_at(
            &[Holding {
                asset_id: e.collateral_asset_id.clone(),
                quantity: e.collateral,
            }],
            marks,
            Round::Floor,
        )?;
        loans.push(LoanMark {
            loan_id: e.loan_id.clone(),
            debt_value,
            collateral_value,
            ltv_bps: ltv_bps(debt_value, collateral_value)?,
        });
    }
    let debt_value = loans
        .iter()
        .fold(Amount::ZERO, |s: Amount, l| s.saturating_add(l.debt_value));
    let collateral_value = loans.iter().fold(Amount::ZERO, |s: Amount, l| {
        s.saturating_add(l.collateral_value)
    });
    Ok(PortfolioMark {
        debt_value,
        collateral_value,
        portfolio_ltv_bps: ltv_bps(debt_value, collateral_value)?,
        loans,
    })
}

// ── Interest ─────────────────────────────────────────────────────────────────

/// `dailyLoanInterest`: one day's interest on the outstanding debt. COMPOUNDING, unlike earn: loan interest is not
/// paid out, it capitalises, so an accrual run moves no money and writes one row (its idempotency is the (loan, day)
/// uniqueness constraint). Rounds DOWN, in the borrower's favour. The TypeScript's non-integer rate cannot be passed
/// here (`apr_bps` is whole).
pub fn daily_loan_interest(
    debt: Amount,
    apr_bps: i64,
    days_per_year: i64,
) -> Result<Amount, RiskError> {
    if debt <= Amount::ZERO {
        return Ok(Amount::ZERO);
    }
    if apr_bps < 0 {
        return Err(RiskError::new(
            format!("APR must be a non-negative integer in bps, got {apr_bps}"),
            "bank.risk_invalid",
        ));
    }
    if apr_bps == 0 {
        return Ok(Amount::ZERO);
    }
    let annual = mul_bps(debt, apr_bps, Rounding::Floor)?;
    let per_day = parse_amount(&days_per_year.to_string()).map_err(RiskError::money)?;
    div(annual, per_day, Rounding::Floor)
}

/// `accrualDay`: `YYYY-MM-DD` in UTC, the accrual day and half of the uniqueness key.
pub fn accrual_day(at: Instant) -> String {
    let iso = at.iso();
    iso.get(..10).unwrap_or(&iso).to_owned()
}

/// `daysToAccrue`: every day from `after` (exclusive) to `until` (inclusive), in UTC. Derived from the last accrued
/// day, not from today, so catching up and re-running are the same operation. Past `max_days` (400 in the
/// TypeScript's default) it refuses `bank.accrual_backlog`: a year of unattended compounding is an incident.
pub fn days_to_accrue(
    last_accrued: Option<&str>,
    opened_at: Instant,
    until: Instant,
    max_days: usize,
) -> Result<Vec<String>, RiskError> {
    let end = accrual_day(until);
    let start_from = last_accrued.map_or_else(|| accrual_day(opened_at), str::to_owned);
    let mut days = Vec::new();

    let Some(start) = service_kit::time::js_date(&format!("{start_from}T00:00:00.000Z")) else {
        return Err(RiskError::new("Invalid time value", "RangeError"));
    };
    // Past the day already accrued (or the open day: a loan drawn this afternoon has not been out for a day).
    let mut cursor = Instant(start.0.saturating_add(DAY_MS));

    while accrual_day(cursor) <= end {
        days.push(accrual_day(cursor));
        if days.len() > max_days {
            return Err(RiskError::new(
                format!(
                    "Loan has {}+ unaccrued days since {start_from} — refusing to compound that in one run; \
                     an operator needs to look at why accrual stopped",
                    days.len()
                ),
                "bank.accrual_backlog",
            ));
        }
        cursor = Instant(cursor.0.saturating_add(DAY_MS));
    }
    Ok(days)
}

// ── The liquidation ladder ───────────────────────────────────────────────────

/// `LiquidationPolicy`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LiquidationPolicy {
    /// Above this, the borrower is warned and the grace clock starts.
    pub margin_call_ltv_bps: i64,
    /// Above this, and only after grace, collateral may be sold.
    pub liquidation_ltv_bps: i64,
    /// Above this, grace is waived: the one place the design breaks "a margin call precedes liquidation", stated as a
    /// number in policy so it shows in a diff. The loss stays with the position that created it.
    pub insolvency_ltv_bps: i64,
    /// Where a liquidation stops. Not zero.
    pub target_ltv_bps: i64,
    /// The borrower's cost of the event, on the proceeds of each tranche.
    pub penalty_bps: i64,
    /// Ceiling on one rung, as a fraction of the loan's remaining collateral.
    pub max_tranche_bps: i64,
    /// How long the borrower has to cure before a liquidation may start.
    pub grace_seconds: i64,
}

/// `DEFAULT_LIQUIDATION_POLICY`.
pub const DEFAULT_LIQUIDATION_POLICY: LiquidationPolicy = LiquidationPolicy {
    margin_call_ltv_bps: 7_500,
    liquidation_ltv_bps: 8_500,
    insolvency_ltv_bps: 9_500,
    target_ltv_bps: 6_500,
    penalty_bps: 200,
    max_tranche_bps: 2_500,
    grace_seconds: 3_600,
};

/// `assertPolicyCoherent`.
pub fn assert_policy_coherent(
    policy: &LiquidationPolicy,
    max_ltv_bps: i64,
) -> Result<(), RiskError> {
    let ordered = max_ltv_bps < policy.margin_call_ltv_bps
        && policy.margin_call_ltv_bps < policy.liquidation_ltv_bps
        && policy.liquidation_ltv_bps <= policy.insolvency_ltv_bps;
    if !ordered {
        return Err(RiskError::new(
            format!(
                "Incoherent policy: need maxLtv ({max_ltv_bps}) < marginCall ({}) < liquidation ({}) <= insolvency ({})",
                policy.margin_call_ltv_bps, policy.liquidation_ltv_bps, policy.insolvency_ltv_bps
            ),
            "bank.policy_incoherent",
        ));
    }
    if policy.target_ltv_bps >= policy.margin_call_ltv_bps {
        // A liquidation that leaves the loan still in margin call has bought the borrower nothing.
        return Err(RiskError::new(
            format!(
                "Liquidation target ({}) must be below the margin-call threshold ({}), \
                 or a liquidation leaves the loan still in margin call",
                policy.target_ltv_bps, policy.margin_call_ltv_bps
            ),
            "bank.policy_incoherent",
        ));
    }
    if policy.max_tranche_bps <= 0 || policy.max_tranche_bps > BPS {
        return Err(RiskError::new(
            format!(
                "maxTrancheBps must be in (0, {BPS}], got {}",
                policy.max_tranche_bps
            ),
            "bank.policy_incoherent",
        ));
    }
    if policy.grace_seconds < 0 {
        return Err(RiskError::new(
            "graceSeconds cannot be negative",
            "bank.policy_incoherent",
        ));
    }
    Ok(())
}

/// `LadderRung['action']`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LadderAction {
    None,
    MarginCall,
    Liquidate,
}

impl LadderAction {
    /// The TypeScript's string: `none`, `margin-call`, `liquidate`.
    pub fn as_str(self) -> &'static str {
        match self {
            LadderAction::None => "none",
            LadderAction::MarginCall => "margin-call",
            LadderAction::Liquidate => "liquidate",
        }
    }
}

/// `LadderRung`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LadderRung {
    None {
        ltv_bps: i64,
    },
    MarginCall {
        ltv_bps: i64,
    },
    Liquidate {
        ltv_bps: i64,
        /// Waived grace: the insolvency branch, recorded so the decision is auditable.
        grace_waived: bool,
        /// Collateral units to sell on THIS rung.
        collateral_to_sell: Amount,
        /// Debt-asset value that should realise, at the mark.
        expected_proceeds: Amount,
        /// True when this rung exhausts the loan's collateral.
        closes_position: bool,
    },
}

impl LadderRung {
    pub fn action(&self) -> LadderAction {
        match self {
            LadderRung::None { .. } => LadderAction::None,
            LadderRung::MarginCall { .. } => LadderAction::MarginCall,
            LadderRung::Liquidate { .. } => LadderAction::Liquidate,
        }
    }

    pub fn ltv_bps(&self) -> i64 {
        match self {
            LadderRung::None { ltv_bps }
            | LadderRung::MarginCall { ltv_bps }
            | LadderRung::Liquidate { ltv_bps, .. } => *ltv_bps,
        }
    }
}

/// `LadderInput`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LadderInput {
    pub debt: Amount,
    pub debt_mark: Mark,
    pub collateral: Amount,
    pub collateral_mark: Mark,
    pub policy: LiquidationPolicy,
    /// When the margin call started, or `None` if the loan is not in one.
    pub margin_called_at: Option<Instant>,
    pub now: Instant,
}

/// `planLiquidation`: what to do about one loan, right now. A ladder, not a close-out: selling a whole position into
/// a thin book manufactures the bad debt the liquidation was meant to prevent, so sell only what restores
/// `target_ltv_bps`, and never more than `max_tranche_bps` of the remaining collateral on one rung.
///
/// Selling `s` at `p` gives `(D − s·p) / ((C − s)·p) = t`, so the value to retire is `v = (D − t·C·p) / (1 − t)`,
/// rounded DOWN: under-selling asks for another rung; over-selling has no posting that gives it back.
pub fn plan_liquidation(input: &LadderInput) -> Result<LadderRung, RiskError> {
    let policy = &input.policy;
    let (debt, collateral) = (input.debt, input.collateral);

    if input.collateral_mark.price <= Amount::ZERO || input.debt_mark.price <= Amount::ZERO {
        // A zero or negative mark is a broken feed, not a cheap asset. `prices.rs` refuses these at the source; this
        // is the second door.
        return Err(RiskError::new(
            format!(
                "Non-positive mark ({}={}, {}={}) — refusing to plan a liquidation against it",
                input.collateral_mark.asset_id,
                service_kit::money::format_amount(input.collateral_mark.price),
                input.debt_mark.asset_id,
                service_kit::money::format_amount(input.debt_mark.price)
            ),
            "bank.mark_invalid",
        ));
    }

    let debt_value = mul_rounded(debt, input.debt_mark.price, Rounding::Ceil);
    let collateral_value = mul_rounded(collateral, input.collateral_mark.price, Rounding::Floor);
    let ltv = ltv_bps(debt_value, collateral_value)?;

    if ltv < policy.margin_call_ltv_bps {
        return Ok(LadderRung::None { ltv_bps: ltv });
    }
    if ltv < policy.liquidation_ltv_bps {
        return Ok(LadderRung::MarginCall { ltv_bps: ltv });
    }

    // THE ORDERING GUARANTEE: past the liquidation threshold, a margin call must already be raised AND its grace
    // expired, or the borrower's first notice of the loan would be its liquidation receipt.
    let grace_waived = ltv >= policy.insolvency_ltv_bps;
    if !grace_waived {
        let Some(called_at) = input.margin_called_at else {
            return Ok(LadderRung::MarginCall { ltv_bps: ltv });
        };
        let grace_ends = called_at
            .0
            .saturating_add(policy.grace_seconds.saturating_mul(1_000));
        if input.now.0 < grace_ends {
            return Ok(LadderRung::MarginCall { ltv_bps: ltv });
        }
    }

    if collateral <= Amount::ZERO {
        // Nothing left to sell: the shortfall is bad debt (`loanBadDebt`). The same `none` as a healthy loan but with
        // an unsecured LTV; it is NOT a cure (`is_margin_call_cured`).
        return Ok(LadderRung::None { ltv_bps: ltv });
    }

    let target_scaled = parse_amount(&policy.target_ltv_bps.to_string())
        .map_err(RiskError::money)?
        / i128::from(BPS);
    let one = SCALE;

    let numerator =
        debt_value.saturating_sub(mul_rounded(collateral_value, target_scaled, Rounding::Ceil));
    let denominator = one - target_scaled;

    let mut value_to_retire = if numerator <= Amount::ZERO {
        Amount::ZERO
    } else {
        div(numerator, denominator, Rounding::Floor)?
    };
    // A position already worth less than its debt asks for more than exists: cap at the whole pot and let the caller
    // book the shortfall.
    if value_to_retire > collateral_value {
        value_to_retire = collateral_value;
    }

    let mut collateral_to_sell = div(
        value_to_retire,
        input.collateral_mark.price,
        Rounding::Floor,
    )?;
    let tranche_cap = mul_bps(collateral, policy.max_tranche_bps, Rounding::Floor)?;
    if collateral_to_sell > tranche_cap {
        collateral_to_sell = tranche_cap;
    }
    if collateral_to_sell > collateral {
        collateral_to_sell = collateral;
    }

    if collateral_to_sell <= Amount::ZERO {
        // A rung that sells nothing is not a rung (a dust position's cap floors to zero): a margin call, so it stays
        // visible instead of looping on a liquidation that never moves.
        return Ok(LadderRung::MarginCall { ltv_bps: ltv });
    }

    Ok(LadderRung::Liquidate {
        ltv_bps: ltv,
        grace_waived,
        collateral_to_sell,
        expected_proceeds: mul_rounded(
            collateral_to_sell,
            input.collateral_mark.price,
            Rounding::Floor,
        ),
        closes_position: collateral_to_sell >= collateral,
    })
}

/// `isMarginCallCured`: whether a margin call may be CLEARED to healthy `active`. `plan_liquidation`'s `none` also
/// means "collateral gone, residual debt remains"; treating that as a cure reports an unsecured position as healthy.
/// The loan stays non-active until the residual is repaid.
pub fn is_margin_call_cured(
    ladder_action: LadderAction,
    debt: Amount,
    collateral: Amount,
    margin_called_at: Option<Instant>,
) -> bool {
    if ladder_action != LadderAction::None {
        return false;
    }
    if margin_called_at.is_none() {
        return false;
    }
    // Exhausted collateral with residual debt is NOT a cure.
    if debt > Amount::ZERO && collateral <= Amount::ZERO {
        return false;
    }
    true
}

/// `ProceedsSplit`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProceedsSplit {
    pub principal_repaid: Amount,
    pub interest_repaid: Amount,
    pub penalty: Amount,
    pub surplus_to_borrower: Amount,
    /// Principal the proceeds could not cover. Bad debt if the position is closed.
    pub shortfall: Amount,
}

/// `splitProceeds`' input.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProceedsInput {
    pub proceeds: Amount,
    pub interest_owed: Amount,
    pub principal_owed: Amount,
    pub penalty_bps: i64,
    /// True when this tranche exhausts the collateral: the last chance to recover.
    pub closes_position: bool,
}

/// `splitProceeds`: the waterfall is penalty, interest, principal, then surplus to the borrower. Penalty first is
/// deliberate (it is what makes liquidation dearer than deleveraging), but it is capped at what is left after the debt,
/// so it is never taken out of the reserve's recovery. Surplus goes back to the borrower unconditionally.
pub fn split_proceeds(input: &ProceedsInput) -> Result<ProceedsSplit, RiskError> {
    if input.proceeds <= Amount::ZERO {
        return Err(RiskError::new(
            "Cannot split zero proceeds",
            "bank.risk_invalid",
        ));
    }
    let owed = input.interest_owed.saturating_add(input.principal_owed);

    let wanted = mul_bps(input.proceeds, input.penalty_bps, Rounding::Floor)?;
    let headroom = if input.proceeds > owed {
        input.proceeds - owed
    } else {
        Amount::ZERO
    };
    let penalty = wanted.min(headroom);

    let mut left = input.proceeds - penalty;
    let interest_repaid = left.min(input.interest_owed);
    left -= interest_repaid;
    let principal_repaid = left.min(input.principal_owed);
    left -= principal_repaid;
    let shortfall = input.principal_owed - principal_repaid;

    Ok(ProceedsSplit {
        principal_repaid,
        interest_repaid,
        penalty,
        surplus_to_borrower: left,
        // A shortfall on a tranche that leaves collateral behind is not a loss yet: only a closing tranche
        // crystallises it.
        shortfall: if input.closes_position {
            shortfall
        } else {
            Amount::ZERO
        },
    })
}

/// `describeLtv`: for error messages and audit rows, never for arithmetic. `(bps / 100).toFixed(2)`, written in
/// integers (the same text for every LTV below 2^46 bps).
pub fn describe_ltv(bps: i64) -> String {
    if bps == MAX_SAFE_INTEGER {
        return "unsecured".to_owned();
    }
    let sign = if bps < 0 { "-" } else { "" };
    let abs = bps.unsigned_abs();
    format!("{sign}{}.{:02}%", abs / 100, abs % 100)
}

#[cfg(test)]
mod tests {
    //! `loans.test.ts` §1 and §2 (the arithmetic and the ladder), `loan-reads.test.ts`' use of `dailyLoanInterest`.
    use super::*;
    use service_kit::money::format_amount;

    fn amt(s: &str) -> Amount {
        parse_amount(s).unwrap()
    }

    fn at(iso: &str) -> Instant {
        service_kit::time::js_date(iso).unwrap()
    }

    #[test]
    fn ltv_is_exact_integer_bps() {
        assert_eq!(ltv_bps(amt("5000"), amt("10000")).unwrap(), 5_000);
        assert_eq!(ltv_bps(amt("7500"), amt("10000")).unwrap(), 7_500);
        assert_eq!(ltv_bps(amt("1"), amt("3")).unwrap(), 3_334);
    }

    #[test]
    fn ltv_rounds_up_so_a_position_fractionally_over_is_over() {
        let collateral = amt("10000");
        assert_eq!(
            ltv_bps(amt("7500") + Amount::from_scaled(1), collateral).unwrap(),
            7_501
        );
        assert_eq!(ltv_bps(amt("7500"), collateral).unwrap(), 7_500);
    }

    #[test]
    fn zero_collateral_against_debt_is_unsecured() {
        assert_eq!(ltv_bps(amt("100"), Amount::ZERO).unwrap(), MAX_SAFE_INTEGER);
        assert_eq!(ltv_bps(Amount::ZERO, Amount::ZERO).unwrap(), 0);
        assert_eq!(ltv_bps(amt("0.1") + amt("0.2"), amt("1")).unwrap(), 3_000);
        assert_eq!(
            ltv_bps(-Amount::from_scaled(1), Amount::from_scaled(1))
                .unwrap_err()
                .code,
            "bank.risk_invalid"
        );
        assert_eq!(
            ltv_bps(Amount::from_scaled(1), -Amount::from_scaled(1))
                .unwrap_err()
                .code,
            "bank.risk_invalid"
        );
    }

    #[test]
    fn daily_interest_rounds_down_and_compounds() {
        let daily = daily_loan_interest(amt("1000"), 1_000, DAYS_PER_YEAR).unwrap();
        assert_eq!(format_amount(daily), "0.273972602739726027");
        assert_eq!(
            daily_loan_interest(amt("1000"), 0, DAYS_PER_YEAR).unwrap(),
            Amount::ZERO
        );
        assert_eq!(
            daily_loan_interest(Amount::ZERO, 1_000, DAYS_PER_YEAR).unwrap(),
            Amount::ZERO
        );
        let err = daily_loan_interest(amt("1000"), -1, DAYS_PER_YEAR).unwrap_err();
        assert_eq!(err.code, "bank.risk_invalid");
        assert_eq!(
            err.message,
            "APR must be a non-negative integer in bps, got -1"
        );

        let mut debt = amt("1000");
        let mut charges = Vec::new();
        for _ in 0..3 {
            let c = daily_loan_interest(debt, 3_650, DAYS_PER_YEAR).unwrap();
            charges.push(c);
            debt += c;
        }
        assert_eq!(format_amount(charges[0]), "1");
        assert!(charges[1] > charges[0]);
        assert!(charges[2] > charges[1]);
    }

    #[test]
    fn accrual_days_charge_each_day_once() {
        let opened = at("2026-01-01T12:00:00Z");
        let none: Vec<String> = Vec::new();
        assert_eq!(
            days_to_accrue(None, opened, at("2026-01-01T23:59:00Z"), 400).unwrap(),
            none
        );
        assert_eq!(
            days_to_accrue(None, opened, at("2026-01-02T00:00:01Z"), 400).unwrap(),
            vec!["2026-01-02"]
        );
        assert_eq!(
            days_to_accrue(Some("2026-01-02"), opened, at("2026-01-05T06:00:00Z"), 400).unwrap(),
            vec!["2026-01-03", "2026-01-04", "2026-01-05"]
        );
        assert_eq!(
            days_to_accrue(Some("2026-01-05"), opened, at("2026-01-05T23:00:00Z"), 400).unwrap(),
            none
        );
        let err = days_to_accrue(Some("2026-01-01"), opened, at("2027-06-01T00:00:00Z"), 400)
            .unwrap_err();
        assert_eq!(err.code, "bank.accrual_backlog");
        assert!(err.message.contains("refusing to compound"));
        assert!(
            err.message
                .starts_with("Loan has 401+ unaccrued days since 2026-01-01")
        );
        assert_eq!(accrual_day(at("2026-03-01T23:30:00Z")), "2026-03-01");
    }

    #[test]
    fn policy_coherence() {
        assert!(assert_policy_coherent(&DEFAULT_LIQUIDATION_POLICY, 6_000).is_ok());
        let p = LiquidationPolicy {
            liquidation_ltv_bps: 7_000,
            margin_call_ltv_bps: 7_500,
            ..DEFAULT_LIQUIDATION_POLICY
        };
        let e = assert_policy_coherent(&p, 6_000).unwrap_err();
        assert!(e.message.contains("Incoherent policy"));
        assert_eq!(e.code, "bank.policy_incoherent");
        let p = LiquidationPolicy {
            target_ltv_bps: 7_600,
            ..DEFAULT_LIQUIDATION_POLICY
        };
        assert!(
            assert_policy_coherent(&p, 6_000)
                .unwrap_err()
                .message
                .contains("still in margin call")
        );
        assert!(
            assert_policy_coherent(&DEFAULT_LIQUIDATION_POLICY, 7_500)
                .unwrap_err()
                .message
                .contains("Incoherent policy")
        );
    }

    const NOW: &str = "2026-06-01T12:00:00Z";

    fn mark(price: &str, asset_id: &str) -> Mark {
        Mark {
            asset_id: asset_id.to_owned(),
            price: amt(price),
            as_of: at(NOW),
        }
    }

    fn ladder(debt: &str, collateral: Amount, called_ms_ago: Option<i64>) -> LadderInput {
        let now = at(NOW);
        LadderInput {
            debt: amt(debt),
            debt_mark: mark("1", "USDT"),
            collateral,
            collateral_mark: mark("10000", "BTC"),
            policy: DEFAULT_LIQUIDATION_POLICY,
            margin_called_at: called_ms_ago.map(|ms| Instant(now.0 - ms)),
            now,
        }
    }

    const TWO_HOURS: i64 = 2 * 3_600_000;

    #[test]
    fn the_ladder_calls_before_it_liquidates() {
        let rung = plan_liquidation(&ladder("5000", amt("1"), None)).unwrap();
        assert_eq!(rung, LadderRung::None { ltv_bps: 5_000 });
        let rung = plan_liquidation(&ladder("8000", amt("1"), None)).unwrap();
        assert_eq!(rung, LadderRung::MarginCall { ltv_bps: 8_000 });
        // Never called: called, not liquidated, however bad the LTV.
        let rung = plan_liquidation(&ladder("9000", amt("1"), None)).unwrap();
        assert_eq!(rung.action(), LadderAction::MarginCall);
        // Grace still running.
        let rung = plan_liquidation(&ladder("9000", amt("1"), Some(60_000))).unwrap();
        assert_eq!(rung.action(), LadderAction::MarginCall);
        // Called and grace expired.
        let rung = plan_liquidation(&ladder("9000", amt("1"), Some(TWO_HOURS))).unwrap();
        let LadderRung::Liquidate {
            grace_waived,
            collateral_to_sell,
            closes_position,
            ..
        } = rung
        else {
            panic!("expected a liquidation, got {rung:?}");
        };
        assert!(!grace_waived);
        assert!(collateral_to_sell < amt("1"));
        assert!(!closes_position);
    }

    #[test]
    fn grace_is_waived_past_insolvency_and_says_so() {
        let rung = plan_liquidation(&ladder("9600", amt("1"), None)).unwrap();
        assert!(matches!(
            rung,
            LadderRung::Liquidate {
                grace_waived: true,
                ..
            }
        ));
    }

    #[test]
    fn one_rung_is_capped_at_max_tranche() {
        let mut input = ladder("9900", amt("1"), Some(TWO_HOURS));
        input.policy.max_tranche_bps = 2_500;
        let rung = plan_liquidation(&input).unwrap();
        let LadderRung::Liquidate {
            collateral_to_sell, ..
        } = rung
        else {
            panic!("expected a liquidation, got {rung:?}");
        };
        assert_eq!(collateral_to_sell, amt("0.25"));
    }

    #[test]
    fn the_sale_rounds_down_and_never_overshoots_the_target() {
        let rung = plan_liquidation(&ladder("8600", amt("1"), Some(TWO_HOURS))).unwrap();
        let LadderRung::Liquidate {
            collateral_to_sell, ..
        } = rung
        else {
            panic!("expected a liquidation, got {rung:?}");
        };
        let proceeds = mul_rounded(collateral_to_sell, amt("10000"), Rounding::Floor);
        let debt_after = amt("8600") - proceeds;
        let collateral_after = amt("1") - collateral_to_sell;
        let ltv_after = ltv_bps(
            debt_after,
            mul_rounded(collateral_after, amt("10000"), Rounding::Floor),
        )
        .unwrap();
        assert!(ltv_after >= DEFAULT_LIQUIDATION_POLICY.target_ltv_bps);
    }

    #[test]
    fn a_non_positive_mark_is_refused() {
        let mut input = ladder("9000", amt("1"), Some(TWO_HOURS));
        input.collateral_mark.price = Amount::ZERO;
        let e = plan_liquidation(&input).unwrap_err();
        assert_eq!(e.code, "bank.mark_invalid");
        assert_eq!(
            e.message,
            "Non-positive mark (BTC=0, USDT=1) — refusing to plan a liquidation against it"
        );
    }

    #[test]
    fn no_ladder_once_the_collateral_is_gone() {
        let rung = plan_liquidation(&ladder("1000", Amount::ZERO, Some(TWO_HOURS))).unwrap();
        assert_eq!(rung.action(), LadderAction::None);
        assert_eq!(rung.ltv_bps(), MAX_SAFE_INTEGER);
    }

    #[test]
    fn a_full_sale_does_not_false_cure() {
        let called = Some(at("2026-06-01T11:00:00Z"));
        assert!(is_margin_call_cured(
            LadderAction::None,
            amt("5000"),
            amt("1"),
            called
        ));
        assert!(!is_margin_call_cured(
            LadderAction::None,
            amt("40"),
            Amount::ZERO,
            called
        ));
        assert!(!is_margin_call_cured(
            LadderAction::MarginCall,
            amt("5000"),
            amt("1"),
            called
        ));
        assert!(!is_margin_call_cured(
            LadderAction::None,
            amt("5000"),
            amt("1"),
            None
        ));
    }

    fn split(proceeds: &str, interest: &str, principal: &str, closes: bool) -> ProceedsSplit {
        split_proceeds(&ProceedsInput {
            proceeds: amt(proceeds),
            interest_owed: amt(interest),
            principal_owed: amt(principal),
            penalty_bps: 200,
            closes_position: closes,
        })
        .unwrap()
    }

    #[test]
    fn the_waterfall_pays_penalty_interest_principal_then_borrower() {
        let s = split("1000", "50", "500", true);
        assert_eq!(format_amount(s.penalty), "20");
        assert_eq!(format_amount(s.interest_repaid), "50");
        assert_eq!(format_amount(s.principal_repaid), "500");
        assert_eq!(format_amount(s.surplus_to_borrower), "430");
        assert_eq!(s.shortfall, Amount::ZERO);
        assert_eq!(
            s.penalty + s.interest_repaid + s.principal_repaid + s.surplus_to_borrower,
            amt("1000")
        );

        assert!(split("10000", "0", "1000", true).surplus_to_borrower > amt("8000"));

        let s = split("400", "50", "1000", true);
        assert_eq!(s.penalty, Amount::ZERO);
        assert_eq!(format_amount(s.interest_repaid), "50");
        assert_eq!(format_amount(s.principal_repaid), "350");
        assert_eq!(format_amount(s.shortfall), "650");
        assert_eq!(s.surplus_to_borrower, Amount::ZERO);

        let s = split("100", "0", "1000", false);
        assert_eq!(s.shortfall, Amount::ZERO);
        assert_eq!(format_amount(s.principal_repaid), "100");

        let s = split("10", "50", "1000", true);
        assert_eq!(format_amount(s.interest_repaid), "10");
        assert_eq!(s.principal_repaid, Amount::ZERO);
        assert_eq!(format_amount(s.shortfall), "1000");
        assert_eq!(
            s.interest_repaid + s.principal_repaid + s.penalty + s.surplus_to_borrower,
            amt("10")
        );

        let e = split_proceeds(&ProceedsInput {
            proceeds: Amount::ZERO,
            interest_owed: Amount::ZERO,
            principal_owed: Amount::ZERO,
            penalty_bps: 200,
            closes_position: true,
        })
        .unwrap_err();
        assert_eq!(e.code, "bank.risk_invalid");
    }

    #[test]
    fn valuation_refuses_a_missing_mark_and_rounds_as_asked() {
        let mut marks = BTreeMap::new();
        marks.insert("BTC".to_owned(), mark("3", "BTC"));
        let h = |q: Amount| {
            vec![Holding {
                asset_id: "BTC".to_owned(),
                quantity: q,
            }]
        };
        assert_eq!(
            value_at(&h(Amount::from_scaled(1)), &marks, Round::Floor).unwrap(),
            Amount::from_scaled(3)
        );
        let third = Amount::from_scaled(1);
        let mut thin = BTreeMap::new();
        thin.insert("BTC".to_owned(), mark("0.5", "BTC"));
        assert_eq!(
            value_at(&h(third), &thin, Round::Floor).unwrap(),
            Amount::ZERO
        );
        assert_eq!(
            value_at(&h(third), &thin, Round::Ceil).unwrap(),
            Amount::from_scaled(1)
        );
        let missing = vec![Holding {
            asset_id: "ETH".to_owned(),
            quantity: Amount::from_scaled(1),
        }];
        let e = value_at(&missing, &marks, Round::Floor).unwrap_err();
        assert_eq!(e.code, "bank.mark_missing");
        assert_eq!(
            e.message,
            "No mark for ETH — cannot value a position with a missing price"
        );

        let p = mark_portfolio(
            &[LoanExposure {
                loan_id: "a".to_owned(),
                debt_asset_id: "USDT".to_owned(),
                debt: amt("5000"),
                collateral_asset_id: "BTC".to_owned(),
                collateral: amt("1"),
            }],
            &{
                let mut m = BTreeMap::new();
                m.insert("USDT".to_owned(), mark("1", "USDT"));
                m.insert("BTC".to_owned(), mark("10000", "BTC"));
                m
            },
        )
        .unwrap();
        assert_eq!(p.portfolio_ltv_bps, 5_000);
        assert_eq!(p.loans[0].ltv_bps, 5_000);
    }

    #[test]
    fn describe_ltv_reads_as_the_typescript_does() {
        assert_eq!(describe_ltv(MAX_SAFE_INTEGER), "unsecured");
        assert_eq!(describe_ltv(7_501), "75.01%");
        assert_eq!(describe_ltv(5), "0.05%");
        assert_eq!(describe_ltv(0), "0.00%");
    }
}
