//! Marking, margin calls and the liquidation ladder (`loan-service.ts`, "Marking, margin calls, liquidation").
//!
//! The first mark over the liquidation line raises a call and nothing else; only a later mark, after grace, sells.
//! Insolvency alone waives grace, recorded on the tranche. A sale needs a stricter mark than a call. A rung whose post
//! had an unknown outcome is finished from the sale stored on it, never followed by a second sale of the same
//! collateral.

use postgres::GenericClient;
use service_kit::json::Json;
use service_kit::money::{Amount, Rounding, format_amount, mul_div, mul_ratio, parse_amount};
use service_kit::time::Instant;

use super::apply::quote_value;
use super::model::{Debt, Loan, Product, loan, loan_cols, outstanding, product};
use super::ports::{Deps, MarginCallNotice, ONE, SaleAsk, VenueQuote};
use super::prices::{QuotedMark, assert_acceptable_for_liquidation};
use super::risk::{
    LadderAction, LadderInput, LadderRung, LoanExposure, PortfolioMark, ProceedsInput, Round,
    is_margin_call_cured, mark_portfolio, plan_liquidation, split_proceeds,
};
use super::service::{
    Claim, Fail, PostErr, accepted_marks, assert_enabled, backlog, bad_debt_key,
    clear_margin_calls, close_repaid, collateral_of, driven_post, has_pending_liquidation,
    has_pending_repayment, has_settled_repayment, instant_f64, liquidate_key, marks_for,
    message_of, next_sequence, post, redrive_pending_repayments, with_money_lock,
};
use crate::errors::Refusal;
use crate::partner::refuse;
use crate::spaces::space::{pg, with};

fn amount_text(s: &str) -> Result<Amount, Refusal> {
    parse_amount(s).map_err(Refusal::Other)
}

fn get_mark(marks: &super::service::Marks, asset: &str) -> Result<QuotedMark, Refusal> {
    marks
        .get(asset)
        .cloned()
        .ok_or_else(|| Refusal::Other(format!("no mark for {asset}")))
}

fn set_status(d: &Deps<'_>, sql: &str, loan_id: &str) -> Result<(), Refusal> {
    with(d.store, |c| {
        c.execute(sql, &[&loan_id]).map(|_| ()).map_err(|e| pg(&e))
    })
}

/// `markUser`: one borrower's portfolio, marked and reported; never acts.
pub fn mark_user(d: &Deps<'_>, user_id: &str) -> Result<PortfolioMark, Refusal> {
    let loans = with(d.store, |c| {
        c.query(
            &format!(
                "SELECT {} FROM bank.loans
                  WHERE user_id = $1 AND status IN ('active', 'margin_call', 'liquidating')
                  ORDER BY opened_at DESC",
                loan_cols("")
            ),
            &[&user_id],
        )
        .map_err(|e| pg(&e))?
        .iter()
        .map(Loan::from_row)
        .collect::<Result<Vec<_>, _>>()
    })?;
    let Some(first) = loans.first() else {
        return Ok(PortfolioMark {
            debt_value: Amount::ZERO,
            collateral_value: Amount::ZERO,
            portfolio_ltv_bps: 0,
            loans: Vec::new(),
        });
    };
    let quote = first.quote_asset_id.clone();
    let mut assets: Vec<String> = Vec::new();
    for l in &loans {
        for a in [&l.collateral_asset_id, &l.debt_asset_id] {
            if !assets.contains(a) {
                assets.push(a.clone());
            }
        }
    }
    let marks = accepted_marks(d, &assets, &quote, d.now)?;
    if assets.iter().any(|a| !marks.contains_key(a)) {
        return Err(refuse(
            "bank.loan_health_price_unset",
            "Loan health is blank. The missing piece is price.",
        ));
    }
    let mut exposures = Vec::with_capacity(loans.len());
    for l in &loans {
        exposures.push(LoanExposure {
            loan_id: l.id.clone(),
            debt_asset_id: l.debt_asset_id.clone(),
            debt: with(d.store, |c| outstanding(c, &l.id))?.total,
            collateral_asset_id: l.collateral_asset_id.clone(),
            collateral: collateral_of(d, l)?,
        });
    }
    mark_portfolio(&exposures, &marks).map_err(backlog)
}

/// What one sweep did.
#[derive(Debug, Default)]
pub struct Swept {
    pub marked: i64,
    pub called: i64,
    pub liquidated: i64,
    pub cleared: i64,
    pub refused: Vec<(String, String)>,
}

impl Swept {
    pub fn json(&self) -> Json {
        Json::obj([
            ("marked", Json::int(self.marked)),
            ("called", Json::int(self.called)),
            ("liquidated", Json::int(self.liquidated)),
            ("cleared", Json::int(self.cleared)),
            (
                "refused",
                Json::Array(
                    self.refused
                        .iter()
                        .map(|(id, reason)| {
                            Json::obj([
                                ("loanId", Json::str(id.clone())),
                                ("reason", Json::str(reason.clone())),
                            ])
                        })
                        .collect(),
                ),
            ),
        ])
    }
}

/// `assertLoanRiskSweepLimit`.
pub fn sweep_limit(limit: Option<f64>) -> Result<i64, Refusal> {
    crate::earn::service::job_batch_limit(
        limit,
        "bank.loan_risk_sweep_limit_unset",
        500,
        10_000,
        "loans.runRiskSweep",
    )
}

/// `runRiskSweep`: mark every open loan and act on it; one bad mark is reported and never stops the rest.
pub fn run_risk_sweep(d: &Deps<'_>, now: Instant, limit: Option<f64>) -> Result<Swept, Refusal> {
    let batch = sweep_limit(limit)?;
    let loans = with(d.store, |c| {
        c.query(
            &format!(
                "SELECT {} FROM bank.loans WHERE status IN ('active', 'margin_call', 'liquidating')
                  ORDER BY opened_at ASC LIMIT $1",
                loan_cols("")
            ),
            &[&batch],
        )
        .map_err(|e| pg(&e))?
        .iter()
        .map(Loan::from_row)
        .collect::<Result<Vec<_>, _>>()
    })?;
    let mut out = Swept::default();
    for l in loans {
        match mark_and_act(d, &l, now) {
            Ok(outcome) => {
                out.marked += 1;
                match outcome {
                    Outcome::Called => out.called += 1,
                    Outcome::Liquidated => out.liquidated += 1,
                    Outcome::Cleared => out.cleared += 1,
                    Outcome::None => {}
                }
            }
            Err(e) => out.refused.push((l.id.clone(), message_of(&e))),
        }
    }
    Ok(out)
}

enum Outcome {
    None,
    Called,
    Liquidated,
    Cleared,
}

/// The inputs a rung is planned with.
struct Rung<'a> {
    loan: &'a Loan,
    product: &'a Product,
    ltv: i64,
    grace_waived: bool,
    collateral_to_sell: Amount,
    closes_position: bool,
    /// Collateral the rung was priced against: a sale that already moved it makes this plan stale.
    collateral_at_plan: Amount,
    collateral_mark: &'a QuotedMark,
    debt: Debt,
    now: Instant,
}

fn ladder(
    l: &Loan,
    p: &Product,
    debt: Amount,
    collateral: Amount,
    collateral_mark: &QuotedMark,
    debt_mark: &QuotedMark,
    now: Instant,
) -> Result<LadderRung, Refusal> {
    plan_liquidation(&LadderInput {
        debt,
        debt_mark: debt_mark.mark.clone(),
        collateral,
        collateral_mark: collateral_mark.mark.clone(),
        policy: p.policy,
        margin_called_at: l.margin_called_at,
        now,
    })
    .map_err(backlog)
}

fn mark_and_act(d: &Deps<'_>, l: &Loan, now: Instant) -> Result<Outcome, Refusal> {
    let p = with(d.store, |c| product(c, &l.product_id))?;
    let marks = marks_for(
        d,
        &l.collateral_asset_id,
        &l.debt_asset_id,
        &l.quote_asset_id,
        now,
    )?;
    let collateral_mark = get_mark(&marks, &l.collateral_asset_id)?;
    let debt_mark = get_mark(&marks, &l.debt_asset_id)?;
    // A pending repayment may already have moved the borrower's money: re-drive it before the debt is read.
    redrive_pending_repayments(d, l)?;
    cover_open_shortfalls(d, l)?;
    let debt = with(d.store, |c| outstanding(c, &l.id))?;
    let collateral = collateral_of(d, l)?;
    if debt.total <= Amount::ZERO {
        let sold = with(d.store, |c| {
            let r = c
                .query_one(
                    "SELECT COUNT(*)::int8 FROM bank.loan_liquidations WHERE loan_id = $1::text::uuid AND status = 'settled'",
                    &[&l.id],
                )
                .map_err(|e| pg(&e))?;
            r.try_get::<_, i64>(0).map_err(|e| pg(&e))
        })?;
        if sold > 0 {
            let held = collateral_of(d, l)?;
            if held > Amount::ZERO {
                release_all(d, l, held)?;
            }
            with(d.store, |c| {
                c.execute(
                    "UPDATE bank.loans
                        SET status = 'liquidated', closed_at = COALESCE(closed_at, to_timestamp($2::float8 / 1000)),
                            margin_called_at = NULL, updated_at = now()
                      WHERE id = $1::text::uuid",
                    &[&l.id, &instant_f64(now)],
                )
                .map(|_| ())
                .map_err(|e| pg(&e))
            })?;
        } else if with(d.store, |c| has_settled_repayment(c, &l.id))? {
            close_repaid(d, l, now)?;
            return Ok(Outcome::Cleared);
        } else {
            set_status(
                d,
                "UPDATE bank.loans SET margin_called_at = NULL, updated_at = now() WHERE id = $1::text::uuid",
                &l.id,
            )?;
        }
        clear_margin_calls(d, &l.id, now)?;
        return Ok(Outcome::Cleared);
    }
    let rung = ladder(
        l,
        &p,
        debt.total,
        collateral,
        &collateral_mark,
        &debt_mark,
        now,
    )?;
    // The accepted mark is the baseline the deviation breaker measures the next mark against: recorded whatever follows.
    with(d.store, |c| {
        c.execute(
            "UPDATE bank.loans
                SET last_mark_price = $2::text::numeric, last_marked_at = to_timestamp($3::float8 / 1000), updated_at = now()
              WHERE id = $1::text::uuid",
            &[
                &l.id,
                &format_amount(collateral_mark.mark.price),
                &instant_f64(now),
            ],
        )
        .map(|_| ())
        .map_err(|e| pg(&e))
    })?;
    // A rung left pending is finished from its stored sale; no other sale is planned.
    let pending = with(d.store, |c| {
        c.query(
            "SELECT ltv_bps::int8, grace_waived, collateral_sold::text FROM bank.loan_liquidations
              WHERE loan_id = $1::text::uuid AND status = 'pending' ORDER BY tranche ASC LIMIT 1",
            &[&l.id],
        )
        .map_err(|e| pg(&e))?
        .first()
        .map(|r| -> Result<(i64, bool, String), Refusal> {
            Ok((
                r.try_get(0).map_err(|e| pg(&e))?,
                r.try_get(1).map_err(|e| pg(&e))?,
                r.try_get(2).map_err(|e| pg(&e))?,
            ))
        })
        .transpose()
    })?;
    if let Some((ltv, grace_waived, sold)) = pending {
        liquidate_tranche(
            d,
            &Rung {
                loan: l,
                product: &p,
                ltv,
                grace_waived,
                collateral_to_sell: amount_text(&sold)?,
                closes_position: collateral <= Amount::ZERO,
                collateral_at_plan: collateral,
                collateral_mark: &collateral_mark,
                debt,
                now,
            },
        )?;
        return Ok(Outcome::Liquidated);
    }
    match &rung {
        LadderRung::None { .. } => {
            if is_margin_call_cured(
                LadderAction::None,
                debt.total,
                collateral,
                l.margin_called_at,
            ) {
                // Cured: clearing the call resets the grace clock, a fresh warning before anything is sold.
                set_status(
                    d,
                    "UPDATE bank.loans SET status = 'active', margin_called_at = NULL, updated_at = now() WHERE id = $1::text::uuid",
                    &l.id,
                )?;
                clear_margin_calls(d, &l.id, now)?;
                return Ok(Outcome::Cleared);
            }
            // A residual claim with no collateral left stays non-active.
            if debt.total > Amount::ZERO
                && collateral <= Amount::ZERO
                && l.status != "margin_call"
                && l.status != "liquidating"
            {
                set_status(
                    d,
                    "UPDATE bank.loans SET status = 'margin_call', updated_at = now() WHERE id = $1::text::uuid",
                    &l.id,
                )?;
            }
            Ok(Outcome::None)
        }
        LadderRung::MarginCall { ltv_bps } => {
            raise_margin_call(
                d,
                l,
                &p,
                *ltv_bps,
                debt.total,
                collateral,
                &collateral_mark,
                &debt_mark,
                now,
            )?;
            Ok(Outcome::Called)
        }
        LadderRung::Liquidate {
            ltv_bps,
            grace_waived,
            collateral_to_sell,
            closes_position,
            ..
        } => {
            assert_acceptable_for_liquidation(
                &collateral_mark,
                l.last_mark_price,
                now,
                &d.settings.mark_policy,
            )?;
            liquidate_tranche(
                d,
                &Rung {
                    loan: l,
                    product: &p,
                    ltv: *ltv_bps,
                    grace_waived: *grace_waived,
                    collateral_to_sell: *collateral_to_sell,
                    closes_position: *closes_position,
                    collateral_at_plan: collateral,
                    collateral_mark: &collateral_mark,
                    debt,
                    now,
                },
            )?;
            Ok(Outcome::Liquidated)
        }
    }
}

fn release_all(d: &Deps<'_>, l: &Loan, held: Amount) -> Result<(), Refusal> {
    super::service::release_collateral_closing(d, l, held).map(|_| ())
}

/// `raiseMarginCall`: an open call is the call; a later sweep only re-sends a notice that never got out, on the same
/// row. A new call's cure is rounded up, and `margin_called_at` is set only if unset, so the grace clock never restarts.
#[allow(
    clippy::too_many_arguments,
    reason = "the TypeScript's own parameter list"
)]
fn raise_margin_call(
    d: &Deps<'_>,
    l: &Loan,
    p: &Product,
    ltv: i64,
    debt: Amount,
    collateral: Amount,
    collateral_mark: &QuotedMark,
    debt_mark: &QuotedMark,
    now: Instant,
) -> Result<(), Refusal> {
    let debt_value = quote_value(debt, debt_mark.mark.price, Round::Ceil);
    // Wide intermediates, as the TypeScript's bigint: `short * ONE` alone passes i128 at a few thousand units.
    let needed = mul_ratio(
        debt_value,
        10_000,
        i128::from(p.policy.target_ltv_bps),
        Rounding::Ceil,
    );
    let have = quote_value(collateral, collateral_mark.mark.price, Round::Floor);
    let short = if needed > have {
        needed - have
    } else {
        Amount::ZERO
    };
    let price = collateral_mark.mark.price;
    let cure = if short == Amount::ZERO {
        Amount::ZERO
    } else {
        mul_div(short, ONE, price, Rounding::Ceil)
    };
    let open = with(d.store, |c| {
        c.query(
            &format!(
                "SELECT sequence::int8, ltv_bps::int8, cure_collateral_amount::text, {}, {}, notified_at IS NOT NULL
                   FROM bank.loan_margin_calls WHERE loan_id = $1::text::uuid AND cleared_at IS NULL
                  ORDER BY sequence DESC LIMIT 1",
                super::model::ms("called_at"),
                super::model::ms("grace_expires_at")
            ),
            &[&l.id],
        )
        .map_err(|e| pg(&e))?
        .first()
        .map(|r| -> Result<(i64, i64, String, i64, i64, bool), Refusal> {
            Ok((
                r.try_get(0).map_err(|e| pg(&e))?,
                r.try_get(1).map_err(|e| pg(&e))?,
                r.try_get(2).map_err(|e| pg(&e))?,
                r.try_get(3).map_err(|e| pg(&e))?,
                r.try_get(4).map_err(|e| pg(&e))?,
                r.try_get(5).map_err(|e| pg(&e))?,
            ))
        })
        .transpose()
    })?;
    if let Some((sequence, call_ltv, call_cure, called_at, grace_at, notified)) = open {
        // A crash between the call row and the loan update leaves no grace clock: finish it from the call's own time.
        with(d.store, |c| {
            c.execute(
                "UPDATE bank.loans
                    SET status = 'margin_call',
                        margin_called_at = COALESCE(margin_called_at, to_timestamp($2::float8 / 1000)), updated_at = now()
                  WHERE id = $1::text::uuid AND status IN ('active', 'margin_call')",
                &[&l.id, &instant_f64(Instant(called_at))],
            )
            .map(|_| ())
            .map_err(|e| pg(&e))
        })?;
        if notified {
            return Ok(());
        }
        deliver(
            d,
            l,
            sequence,
            call_ltv,
            amount_text(&call_cure)?,
            Instant(called_at),
            Instant(grace_at),
        );
        return Ok(());
    }
    let grace_at = Instant(l.margin_called_at.unwrap_or(now).0 + p.policy.grace_seconds * 1_000);
    let sequence = with(d.store, |c| {
        next_sequence(c, "loan_margin_calls", &l.id, "sequence")
    })?;
    #[allow(clippy::cast_possible_truncation, reason = "int4 columns")]
    let (seq32, ltv32) = (sequence as i32, ltv as i32);
    with(d.store, |c| {
        c.execute(
            "INSERT INTO bank.loan_margin_calls (loan_id, sequence, ltv_bps, cure_collateral_amount, called_at, grace_expires_at)
             VALUES ($1::text::uuid, $2, $3, $4::text::numeric, to_timestamp($5::float8 / 1000), to_timestamp($6::float8 / 1000))
             ON CONFLICT (loan_id, sequence) DO NOTHING",
            &[
                &l.id,
                &seq32,
                &ltv32,
                &format_amount(cure),
                &instant_f64(now),
                &instant_f64(grace_at),
            ],
        )
        .map_err(|e| pg(&e))?;
        c.execute(
            "UPDATE bank.loans
                SET status = 'margin_call', margin_called_at = COALESCE(margin_called_at, to_timestamp($2::float8 / 1000)),
                    updated_at = now()
              WHERE id = $1::text::uuid",
            &[&l.id, &instant_f64(now)],
        )
        .map(|_| ())
        .map_err(|e| pg(&e))
    })?;
    deliver(d, l, sequence, ltv, cure, now, grace_at);
    Ok(())
}

/// `deliverMarginCall`: a failed notice is recorded on the call and never fails it.
fn deliver(
    d: &Deps<'_>,
    l: &Loan,
    sequence: i64,
    ltv: i64,
    cure: Amount,
    called_at: Instant,
    grace_at: Instant,
) {
    #[allow(clippy::cast_possible_truncation, reason = "an int4 column")]
    let seq32 = sequence as i32;
    let sent = d.margin_calls.send(&MarginCallNotice {
        loan_id: l.id.clone(),
        user_id: l.user_id.clone(),
        sequence,
        ltv_bps: ltv,
        cure_collateral_amount: cure,
        collateral_asset_id: l.collateral_asset_id.clone(),
        called_at,
        grace_expires_at: grace_at,
    });
    let _ = with(d.store, |c| {
        match &sent {
            Ok(()) => c.execute(
                "UPDATE bank.loan_margin_calls SET notified_at = now() WHERE loan_id = $1::text::uuid AND sequence = $2",
                &[&l.id, &seq32],
            ),
            Err(e) => c.execute(
                "UPDATE bank.loan_margin_calls SET notify_error = $3 WHERE loan_id = $1::text::uuid AND sequence = $2",
                &[&l.id, &seq32, e],
            ),
        }
        .map(|_| ())
        .map_err(|e| pg(&e))
    });
}

fn no_counterparty(amount: Amount, l: &Loan) -> Refusal {
    refuse(
        "bank.no_liquidation_counterparty",
        format!(
            "No counterparty for {} {} on loan {}",
            format_amount(amount),
            l.collateral_asset_id,
            l.id
        ),
    )
}

fn venue_quote(
    d: &Deps<'_>,
    l: &Loan,
    amount: Amount,
    mark_price: Amount,
) -> Result<Option<VenueQuote>, Refusal> {
    d.venue
        .quote(&SaleAsk {
            loan_id: &l.id,
            collateral_asset_id: &l.collateral_asset_id,
            collateral_amount: amount,
            debt_asset_id: &l.debt_asset_id,
            mark_price,
        })
        .map_err(Refusal::Other)
}

/// `liquidateTranche`: a new sale's quote runs before the loan lock; a pending rung stays inside it.
fn liquidate_tranche(d: &Deps<'_>, r: &Rung<'_>) -> Result<(), Refusal> {
    let l = r.loan;
    if l.quote_asset_id != l.debt_asset_id || with(d.store, |c| has_pending_liquidation(c, &l.id))?
    {
        return with_money_lock(d, &l.id, || liquidate_locked(d, r, None));
    }
    let quoted = venue_quote(d, l, r.collateral_to_sell, r.collateral_mark.mark.price)?;
    let Some(q) = quoted.filter(|q| q.proceeds > Amount::ZERO) else {
        return Err(no_counterparty(r.collateral_to_sell, l));
    };
    with_money_lock(d, &l.id, || liquidate_locked(d, r, Some(q)))
}

struct StoredSale {
    tranche: i64,
    proceeds: Amount,
    collateral_sold: Amount,
    mark_price: Amount,
    principal_repaid: Amount,
    interest_repaid: Amount,
    penalty: Amount,
    surplus: Amount,
    shortfall: Amount,
    ledger_tx_id: Option<String>,
}

fn pending_sale(c: &mut impl GenericClient, loan_id: &str) -> Result<Option<StoredSale>, Refusal> {
    let rows = c
        .query(
            "SELECT tranche::int8, proceeds::text, principal_repaid::text, interest_repaid::text, penalty::text,
                    surplus_returned::text, shortfall::text, collateral_sold::text, mark_price::text, ledger_tx_id
               FROM bank.loan_liquidations WHERE loan_id = $1::text::uuid AND status = 'pending'
              ORDER BY tranche ASC LIMIT 1",
            &[&loan_id],
        )
        .map_err(|e| pg(&e))?;
    let Some(r) = rows.first() else {
        return Ok(None);
    };
    let a = |i: usize| -> Result<Amount, Refusal> {
        amount_text(&r.try_get::<_, String>(i).map_err(|e| pg(&e))?)
    };
    Ok(Some(StoredSale {
        tranche: r.try_get(0).map_err(|e| pg(&e))?,
        proceeds: a(1)?,
        principal_repaid: a(2)?,
        interest_repaid: a(3)?,
        penalty: a(4)?,
        surplus: a(5)?,
        shortfall: a(6)?,
        collateral_sold: a(7)?,
        mark_price: a(8)?,
        ledger_tx_id: r.try_get(9).map_err(|e| pg(&e))?,
    }))
}

#[allow(
    clippy::too_many_lines,
    reason = "one rung, read in the TypeScript's order"
)]
fn liquidate_locked(
    d: &Deps<'_>,
    r: &Rung<'_>,
    external: Option<VenueQuote>,
) -> Result<(), Refusal> {
    let l = r.loan;
    // The mark is in the quote asset: booking it from the debt asset's market maker would treat two units as one.
    if l.quote_asset_id != l.debt_asset_id {
        return Err(refuse(
            "bank.loan_seizure_cross_asset",
            format!(
                "Loan {} collateral is marked in {} and the debt is {} — seizure refuses rather than converting the \
                 mark into the debt asset",
                l.id, l.quote_asset_id, l.debt_asset_id
            ),
        ));
    }
    let pending = with(d.store, |c| pending_sale(c, &l.id))?;
    // A new sale needs the loan still open and both sides of the priced LTV unchanged.
    let mut open_status: Option<String> = None;
    let mut priced = r.debt;
    if pending.is_none() {
        let now_debt = with(d.store, |c| outstanding(c, &l.id))?;
        if now_debt.principal != r.debt.principal || now_debt.interest != r.debt.interest {
            return Ok(());
        }
        priced = now_debt;
        if collateral_of(d, l)? != r.collateral_at_plan {
            return Ok(());
        }
        let status = with(d.store, |c| loan(c, &l.id))?.status;
        if status != "active" && status != "margin_call" {
            return Ok(());
        }
        open_status = Some(status);
        if with(d.store, |c| has_pending_repayment(c, &l.id))? {
            return Err(refuse(
                "bank.ledger_outcome_unknown",
                format!(
                    "Loan {} has a repayment whose ledger outcome is not yet known — no sale until that repayment is \
                     re-driven",
                    l.id
                ),
            ));
        }
    }
    // A stored sale keeps its buyer only while unposted; once posted, a later quote is not a buyer for it.
    let quoted = match &pending {
        Some(p) if p.ledger_tx_id.is_some() => None,
        Some(p) => venue_quote(d, l, p.collateral_sold, p.mark_price)?,
        None => match external {
            Some(q) => Some(q),
            None => venue_quote(d, l, r.collateral_to_sell, r.collateral_mark.mark.price)?,
        },
    };
    let posted_already = pending.as_ref().is_some_and(|p| p.ledger_tx_id.is_some());
    if !posted_already && !quoted.as_ref().is_some_and(|q| q.proceeds > Amount::ZERO) {
        return Err(no_counterparty(
            pending
                .as_ref()
                .map_or(r.collateral_to_sell, |p| p.collateral_sold),
            l,
        ));
    }
    // Claim the open loan before a tranche is allocated.
    if pending.is_none() {
        let claimed = with(d.store, |c| {
            Ok(!c
                .query(
                    "UPDATE bank.loans SET status = 'liquidating', updated_at = now()
                      WHERE id = $1::text::uuid AND status IN ('active', 'margin_call') RETURNING id",
                    &[&l.id],
                )
                .map_err(|e| pg(&e))?
                .is_empty())
        })?;
        if !claimed {
            return Ok(());
        }
    }
    let out = sell(d, r, pending.as_ref(), quoted.as_ref(), priced);
    if out.is_err() && !with(d.store, |c| has_pending_liquidation(c, &l.id))? {
        // Nothing left pending: the loan goes back to its open status, so the next sweep can plan and the borrower cure.
        let back = open_status.unwrap_or_else(|| "margin_call".to_owned());
        with(d.store, |c| {
            c.execute(
                "UPDATE bank.loans SET status = $2::text::bank.loan_status, updated_at = now()
                  WHERE id = $1::text::uuid AND status = 'liquidating'",
                &[&l.id, &back],
            )
            .map(|_| ())
            .map_err(|e| pg(&e))
        })?;
    }
    out
}

#[allow(
    clippy::too_many_lines,
    reason = "one rung, read in the TypeScript's order"
)]
fn sell(
    d: &Deps<'_>,
    r: &Rung<'_>,
    stored: Option<&StoredSale>,
    quoted: Option<&VenueQuote>,
    priced: Debt,
) -> Result<(), Refusal> {
    let l = r.loan;
    let (principal_repaid, interest_repaid, penalty, surplus, split_shortfall) = match stored {
        Some(s) => (
            s.principal_repaid,
            s.interest_repaid,
            s.penalty,
            s.surplus,
            s.shortfall,
        ),
        None => {
            let Some(q) = quoted else {
                return Err(no_counterparty(r.collateral_to_sell, l));
            };
            let s = split_proceeds(&ProceedsInput {
                proceeds: q.proceeds,
                interest_owed: priced.interest,
                principal_owed: priced.principal,
                penalty_bps: r.product.policy.penalty_bps,
                closes_position: r.closes_position,
            })
            .map_err(backlog)?;
            (
                s.principal_repaid,
                s.interest_repaid,
                s.penalty,
                s.surplus_to_borrower,
                s.shortfall,
            )
        }
    };
    let proceeds = match (stored, quoted) {
        (Some(s), _) => s.proceeds,
        (None, Some(q)) => q.proceeds,
        (None, None) => Amount::ZERO,
    };
    let sold = stored.map_or(r.collateral_to_sell, |s| s.collateral_sold);
    let mark_price = stored.map_or(r.collateral_mark.mark.price, |s| s.mark_price);
    let tranche = match stored {
        Some(s) => s.tranche,
        None => with(d.store, |c| {
            next_sequence(c, "loan_liquidations", &l.id, "tranche")
        })?,
    };
    // A stored sale's shortfall is worked out after its post: only then does "no collateral left" mean it closed.
    let debt_principal = r.debt.principal;
    let before: Option<Box<dyn Fn() -> Result<(), Refusal> + '_>> = match stored {
        Some(s) if s.shortfall > Amount::ZERO => None,
        Some(s) => {
            let repaid = s.principal_repaid;
            Some(Box::new(move || {
                let held = collateral_of(d, l)?;
                let gap = (debt_principal - repaid).max(Amount::ZERO);
                let shortfall = if held <= Amount::ZERO {
                    gap
                } else {
                    Amount::ZERO
                };
                if shortfall > Amount::ZERO {
                    cover_shortfall(d, l, tranche, shortfall)?;
                }
                Ok(())
            }))
        }
        None if split_shortfall > Amount::ZERO => Some(Box::new(move || {
            cover_shortfall(d, l, tranche, split_shortfall)
        })),
        None => None,
    };
    set_status(
        d,
        "UPDATE bank.loans SET status = 'liquidating', updated_at = now()
          WHERE id = $1::text::uuid AND status IN ('active', 'margin_call')",
        &l.id,
    )?;
    #[allow(clippy::cast_possible_truncation, reason = "int4 columns")]
    let (t32, ltv32) = (tranche as i32, r.ltv as i32);
    driven_post(
        d,
        "loan_liquidations",
        |tx| {
            let rows = tx
                .query(
                    "INSERT INTO bank.loan_liquidations (
                       loan_id, tranche, ltv_bps, mark_price, grace_waived, collateral_sold, proceeds,
                       principal_repaid, interest_repaid, penalty, surplus_returned
                     ) VALUES ($1::text::uuid, $2, $3, $4::text::numeric, $5, $6::text::numeric, $7::text::numeric,
                               $8::text::numeric, $9::text::numeric, $10::text::numeric, $11::text::numeric)
                     ON CONFLICT (loan_id, tranche) DO NOTHING
                     RETURNING id::text",
                    &[
                        &l.id,
                        &t32,
                        &ltv32,
                        &format_amount(mark_price),
                        &r.grace_waived,
                        &format_amount(sold),
                        &format_amount(proceeds),
                        &format_amount(principal_repaid),
                        &format_amount(interest_repaid),
                        &format_amount(penalty),
                        &format_amount(surplus),
                    ],
                )
                .map_err(|e| pg(&e))?;
            if let Some(row) = rows.first() {
                return Ok(Claim::Claimed {
                    id: row.try_get(0).map_err(|e| pg(&e))?,
                });
            }
            let row = tx
                .query_one(
                    "SELECT id::text, ledger_tx_id FROM bank.loan_liquidations WHERE loan_id = $1::text::uuid AND tranche = $2",
                    &[&l.id, &t32],
                )
                .map_err(|e| pg(&e))?;
            Ok(Claim::Existing {
                id: row.try_get(0).map_err(|e| pg(&e))?,
                ledger_tx: row.try_get(1).map_err(|e| pg(&e))?,
            })
        },
        || {
            let Some(q) = quoted else {
                return Err(PostErr::Refused(refuse(
                    "bank.no_liquidation_counterparty",
                    format!(
                        "Loan {} tranche {tranche} already has a ledger tx — refusing a second sale",
                        l.id
                    ),
                )));
            };
            post(
                d,
                "loanLiquidate",
                &Json::obj([
                    ("loanId", Json::str(l.id.clone())),
                    ("userId", Json::str(l.user_id.clone())),
                    ("tranche", Json::int(tranche)),
                    ("collateralAssetId", Json::str(l.collateral_asset_id.clone())),
                    ("collateralSold", Json::str(format_amount(sold))),
                    ("debtAssetId", Json::str(l.debt_asset_id.clone())),
                    ("proceeds", Json::str(format_amount(proceeds))),
                    ("principalRepaid", Json::str(format_amount(principal_repaid))),
                    ("interestRepaid", Json::str(format_amount(interest_repaid))),
                    ("penalty", Json::str(format_amount(penalty))),
                    ("surplusToBorrower", Json::str(format_amount(surplus))),
                    (
                        "buyer",
                        Json::obj([
                            ("collateralTo", q.collateral_to.json()),
                            ("proceedsFrom", q.proceeds_from.json()),
                        ]),
                    ),
                    ("markPrice", Json::str(format_amount(mark_price))),
                ]),
                &liquidate_key(&l.id, tranche),
                true,
            )
        },
        before.as_deref(),
    )
    .map_err(Fail::refusal)?;
    super::ports::tell_affiliates(
        d.affiliates,
        &super::ports::leg_after_liquidate(
            &l.id,
            &l.user_id,
            tranche,
            interest_repaid,
            penalty,
            &l.debt_asset_id,
        ),
    );
    let remaining = with(d.store, |c| outstanding(c, &l.id))?;
    let held = collateral_of(d, l)?;
    // A stored sale already moved its collateral: whether it closed the position is what is left.
    let closes = if posted(stored) {
        held <= Amount::ZERO
    } else {
        r.closes_position
    };
    if remaining.total <= Amount::ZERO || closes {
        // Surviving collateral on a cleared debt is the borrower's: the difference between a liquidation and a
        // confiscation.
        if remaining.total <= Amount::ZERO && held > Amount::ZERO {
            release_all(d, l, held)?;
        }
        let cleared = remaining.total <= Amount::ZERO;
        let status = if cleared { "liquidated" } else { "margin_call" };
        let closed_at: Option<f64> = cleared.then(|| instant_f64(r.now));
        with(d.store, |c| {
            c.execute(
                "UPDATE bank.loans
                    SET status = $2::text::bank.loan_status, closed_at = to_timestamp($3::float8 / 1000), updated_at = now()
                  WHERE id = $1::text::uuid AND status IN ('active', 'margin_call', 'liquidating')",
                &[&l.id, &status, &closed_at],
            )
            .map(|_| ())
            .map_err(|e| pg(&e))
        })?;
        if cleared {
            clear_margin_calls(d, &l.id, r.now)?;
        }
    } else {
        // More rungs to come: back to margin_call, so the next sweep re-reads the grace clock.
        set_status(
            d,
            "UPDATE bank.loans SET status = 'margin_call', updated_at = now()
              WHERE id = $1::text::uuid AND status IN ('active', 'margin_call', 'liquidating')",
            &l.id,
        )?;
    }
    Ok(())
}

fn posted(stored: Option<&StoredSale>) -> bool {
    stored.is_some_and(|s| s.ledger_tx_id.is_some())
}

/// `coverShortfallTranche`: `loanBadDebt` from the insurance fund, keyed per loan; the figure and its tx are written
/// once, while the stored shortfall is still 0.
fn cover_shortfall(d: &Deps<'_>, l: &Loan, tranche: i64, shortfall: Amount) -> Result<(), Refusal> {
    let posted = post(
        d,
        "loanBadDebt",
        &Json::obj([
            ("loanId", Json::str(l.id.clone())),
            ("debtAssetId", Json::str(l.debt_asset_id.clone())),
            ("shortfall", Json::str(format_amount(shortfall))),
        ]),
        &bad_debt_key(&l.id),
        false,
    );
    let tx = match posted {
        Ok(tx) => tx,
        Err(e) if e.insufficient() => {
            return Err(refuse(
                "bank.bad_debt_uncovered",
                format!(
                    "Loan {} left {} {} of bad debt and the insurance fund cannot cover it — the lending reserve is \
                     short by that amount",
                    l.id,
                    format_amount(shortfall),
                    l.debt_asset_id
                ),
            ));
        }
        Err(e) => return Err(e.refusal()),
    };
    #[allow(clippy::cast_possible_truncation, reason = "an int4 column")]
    let t32 = tranche as i32;
    with(d.store, |c| {
        c.execute(
            "UPDATE bank.loan_liquidations SET bad_debt_ledger_tx_id = $3, shortfall = $4::text::numeric
              WHERE loan_id = $1::text::uuid AND tranche = $2 AND shortfall = 0",
            &[&l.id, &t32, &tx.id, &format_amount(shortfall)],
        )
        .map(|_| ())
        .map_err(|e| pg(&e))
    })
}

/// `coverOpenShortfalls`: settled sales whose shortfall never reached the insurance fund.
fn cover_open_shortfalls(d: &Deps<'_>, l: &Loan) -> Result<(), Refusal> {
    let rows = with(d.store, |c| {
        c.query(
            "SELECT tranche::int8, shortfall::text FROM bank.loan_liquidations
              WHERE loan_id = $1::text::uuid AND status = 'settled' AND shortfall > 0 AND bad_debt_ledger_tx_id IS NULL
              ORDER BY tranche ASC",
            &[&l.id],
        )
        .map_err(|e| pg(&e))?
        .iter()
        .map(|r| -> Result<(i64, String), Refusal> {
            Ok((
                r.try_get(0).map_err(|e| pg(&e))?,
                r.try_get(1).map_err(|e| pg(&e))?,
            ))
        })
        .collect::<Result<Vec<_>, _>>()
    })?;
    for (tranche, shortfall) in rows {
        cover_shortfall(d, l, tranche, amount_text(&shortfall)?)?;
    }
    Ok(())
}

/// What `seize` answers.
pub struct Seized {
    pub ledger_tx_id: String,
    pub collateral_sold: Amount,
    pub proceeds: Amount,
    pub principal_repaid: Amount,
    pub interest_repaid: Amount,
    pub closed: bool,
}

/// `seize`: an operator's liquidation of a loan the ladder would sell now, on the stricter mark.
pub fn seize(d: &Deps<'_>, loan_id: &str, now: Instant) -> Result<Seized, Refusal> {
    assert_enabled(d)?;
    let l = with(d.store, |c| loan(c, loan_id))?;
    if l.closed() {
        return Err(refuse(
            "bank.loan_closed",
            format!("Loan {} is {}", l.id, l.status),
        ));
    }
    if l.status == "pending" {
        return Err(refuse(
            "bank.loan_not_drawable",
            format!("Loan {} has no drawn principal to seize", l.id),
        ));
    }
    let p = with(d.store, |c| product(c, &l.product_id))?;
    let marks = marks_for(
        d,
        &l.collateral_asset_id,
        &l.debt_asset_id,
        &l.quote_asset_id,
        now,
    )?;
    let collateral_mark = get_mark(&marks, &l.collateral_asset_id)?;
    let debt_mark = get_mark(&marks, &l.debt_asset_id)?;
    let debt = with(d.store, |c| outstanding(c, &l.id))?;
    let collateral = collateral_of(d, &l)?;
    if debt.total <= Amount::ZERO {
        return Err(refuse(
            "bank.loan_closed",
            format!(
                "Loan {} has nothing outstanding — release its collateral instead",
                l.id
            ),
        ));
    }
    let rung = ladder(
        &l,
        &p,
        debt.total,
        collateral,
        &collateral_mark,
        &debt_mark,
        now,
    )?;
    let LadderRung::Liquidate {
        ltv_bps,
        grace_waived,
        collateral_to_sell,
        closes_position,
        ..
    } = rung
    else {
        return Err(refuse(
            "bank.margin_call_required",
            format!(
                "Loan {} is not seizable at this mark (LTV {} bps)",
                l.id,
                rung.ltv_bps()
            ),
        ));
    };
    assert_acceptable_for_liquidation(
        &collateral_mark,
        l.last_mark_price,
        now,
        &d.settings.mark_policy,
    )?;
    liquidate_tranche(
        d,
        &Rung {
            loan: &l,
            product: &p,
            ltv: ltv_bps,
            grace_waived,
            collateral_to_sell,
            closes_position,
            collateral_at_plan: collateral,
            collateral_mark: &collateral_mark,
            debt,
            now,
        },
    )?;
    let row = with(d.store, |c| {
        c.query(
            "SELECT ledger_tx_id, collateral_sold::text, proceeds::text, principal_repaid::text, interest_repaid::text
               FROM bank.loan_liquidations WHERE loan_id = $1::text::uuid AND status = 'settled'
              ORDER BY tranche DESC LIMIT 1",
            &[&l.id],
        )
        .map_err(|e| pg(&e))?
        .first()
        .map(|r| -> Result<(Option<String>, Vec<String>), Refusal> {
            Ok((
                r.try_get(0).map_err(|e| pg(&e))?,
                (1..5)
                    .map(|i| r.try_get(i).map_err(|e| pg(&e)))
                    .collect::<Result<Vec<String>, _>>()?,
            ))
        })
        .transpose()
    })?;
    let Some((Some(tx), figures)) = row else {
        return Err(refuse(
            "bank.no_liquidation_counterparty",
            format!("Loan {} seize posted no liquidation", l.id),
        ));
    };
    let [sold, proceeds, principal, interest] = figures.as_slice() else {
        return Err(Refusal::Other(
            "the seize read answered no figures".to_owned(),
        ));
    };
    let closed = with(d.store, |c| loan(c, &l.id))?.status == "liquidated";
    Ok(Seized {
        ledger_tx_id: tx,
        collateral_sold: amount_text(sold)?,
        proceeds: amount_text(proceeds)?,
        principal_repaid: amount_text(principal)?,
        interest_repaid: amount_text(interest)?,
        closed,
    })
}
