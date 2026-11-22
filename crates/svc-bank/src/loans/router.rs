//! The slice's calls (`router/loans.router.ts`, `loans/loan-apply.router.ts`, `loans/loan-reads.router.ts`,
//! `loans/loan-servicing-preview.ts`; the loan calls of `router/ops.router.ts`; `ops/loan-book.ts`,
//! `ops/loan-products.ts`), each checked as the TypeScript checks it.
//!
//! An operator's money call consumes an identity-issued approval bound to its terms, and only after the terms pass
//! the checks, so a wrong form never spends the second person.

use service_kit::json::Json;
use service_kit::money::{Amount, format_amount, js_trim, parse_amount};
use service_kit::schema::Value;
use service_kit::time::{Instant, js_date};
use service_kit::trpc::Preview;

use super::adjustments::{self, People, Terms};
use super::apply::{OriginationFee, origination_fee, origination_fee_on};
use super::model::{self, NewProduct, RateChange, loan, outstanding, product};
use super::ports::Deps;
use super::risk::LiquidationPolicy;
use super::service::{self, OpenAsk};
use super::{book, reads, sweep};
use crate::earn::router::f;
use crate::errors::Refusal;
use crate::ops_approval::consume as consume_approval;
use crate::partner::refuse;
use crate::spaces::space::with;
use crate::transfers::schedules::assert_self;

const LOAN_SCHEDULE_ENGINE: &str = "bank.loan_schedule";
const LOAN_EXTERNAL_REPAY_ENGINE: &str = "bank.loan_external_repay";

fn text<'v>(v: &'v Value, key: &str) -> &'v str {
    v.get(key).as_str().unwrap_or_default()
}

fn opt_text<'v>(v: &'v Value, key: &str) -> Option<&'v str> {
    v.get(key).as_str()
}

fn int_of(v: &Value, key: &str) -> Option<i64> {
    #[allow(
        clippy::cast_possible_truncation,
        reason = "the schema held it to a whole number"
    )]
    v.get(key).as_number().map(|n| n as i64)
}

fn amount_of(s: &str) -> Result<Amount, Refusal> {
    parse_amount(s).map_err(Refusal::Other)
}

fn time_of(s: &str) -> Result<Instant, Refusal> {
    js_date(s).ok_or_else(|| Refusal::Other(format!("{s} is no date")))
}

fn amount_json(a: Amount) -> Json {
    Json::str(format_amount(a))
}

fn preview(engine: &str, action: &str) -> Refusal {
    Refusal::Trpc(Preview::new(engine, action).refuse())
}

/// `assertBorrowOpen`: every asset a new loan touches open for borrowing.
fn assert_borrow_open(d: &Deps<'_>, assets: &[&str]) -> Result<(), Refusal> {
    let mut unique: Vec<String> = Vec::new();
    for a in assets {
        if !unique.iter().any(|u| u == a) {
            unique.push((*a).to_owned());
        }
    }
    let rows = with(d.store, |c| {
        c.query(
            "SELECT asset_id, borrow_paused FROM bank.asset_pauses WHERE asset_id = ANY($1)",
            &[&unique],
        )
        .map_err(|_| {
            refuse(
                "bank.asset_pause_unreadable",
                "The asset pause state could not be read, so the operation was refused",
            )
        })
    })?;
    let mut paused: Vec<String> = rows
        .iter()
        .filter(|r| r.try_get::<_, bool>(1).unwrap_or(false))
        .filter_map(|r| r.try_get::<_, String>(0).ok())
        .collect();
    paused.sort();
    if paused.is_empty() {
        Ok(())
    } else {
        Err(refuse(
            "bank.asset_paused",
            format!("New borrowing is paused for {}", paused.join(", ")),
        ))
    }
}

fn own_loan(d: &Deps<'_>, user: &str, loan_id: &str) -> Result<model::Loan, Refusal> {
    let l = with(d.store, |c| loan(c, loan_id))?;
    assert_self(user, &l.user_id)?;
    Ok(l)
}

fn reason(key: &str, state: &str, code: Option<&str>) -> Json {
    Json::obj([
        ("key", Json::str(key)),
        ("state", Json::str(state)),
        ("code", code.map_or(Json::Null, Json::str)),
    ])
}

#[allow(
    clippy::too_many_lines,
    reason = "one arm per call, as the router reads"
)]
fn customer(d: &Deps<'_>, user: &str, path: &str, input: &Value) -> Option<Result<Json, Refusal>> {
    Some(match path {
        "loans.products" => (|| {
            crate::spaces::space::owner_list_limit(
                input.get("limit").as_number(),
                "bank.loan_products_list_limit_unset",
                "loans.products",
            )?;
            let products = with(d.store, |c| {
                model::list_products(
                    c,
                    opt_text(input, "assetId"),
                    input.get("limit").as_number(),
                )
            })?;
            Ok(Json::Array(
                products
                    .iter()
                    .map(|p| {
                        Json::obj([
                            ("id", Json::str(p.id.clone())),
                            ("name", Json::str(p.name.clone())),
                            ("debtAssetId", Json::str(p.debt_asset_id.clone())),
                            (
                                "collateralAssetId",
                                Json::str(p.collateral_asset_id.clone()),
                            ),
                            ("quoteAssetId", Json::str(p.quote_asset_id.clone())),
                            ("aprBps", Json::int(p.apr_bps)),
                            ("maxLtvBps", Json::int(p.max_ltv_bps)),
                            ("marginCallLtvBps", Json::int(p.policy.margin_call_ltv_bps)),
                            ("liquidationLtvBps", Json::int(p.policy.liquidation_ltv_bps)),
                            (
                                "marginWarningLtvBps",
                                d.settings
                                    .margin_warning_ltv_bps
                                    .map_or(Json::Null, Json::int),
                            ),
                            ("minPrincipal", amount_json(p.min_principal)),
                        ])
                    })
                    .collect(),
            ))
        })(),
        "loans.open" => (|| {
            let p = with(d.store, |c| product(c, text(input, "productId")))?;
            assert_borrow_open(d, &[&p.debt_asset_id, &p.collateral_asset_id])?;
            let opened = service::open(
                d,
                &OpenAsk {
                    loan_id: text(input, "loanId"),
                    product_id: text(input, "productId"),
                    user_id: user,
                    collateral_amount: amount_of(text(input, "collateralAmount"))?,
                    principal: amount_of(text(input, "principal"))?,
                    expected_apr_bps: int_of(input, "expectedAprBps"),
                },
            )?;
            Ok(Json::obj([
                ("loanId", Json::str(opened.loan.id.clone())),
                ("status", Json::str(opened.loan.status.clone())),
                ("ltvBps", Json::int(opened.ltv_bps)),
                ("drawLedgerTxId", Json::str(opened.draw_ledger_tx_id)),
            ]))
        })(),
        "loans.list" => (|| {
            let rows = service::loans_of(d, user, input.get("limit").as_number())?;
            let mut out = Vec::with_capacity(rows.len());
            for l in &rows {
                let debt = with(d.store, |c| outstanding(c, &l.id))?;
                out.push(Json::obj([
                    ("id", Json::str(l.id.clone())),
                    ("productId", Json::str(l.product_id.clone())),
                    ("debtAssetId", Json::str(l.debt_asset_id.clone())),
                    (
                        "collateralAssetId",
                        Json::str(l.collateral_asset_id.clone()),
                    ),
                    ("principal", amount_json(l.principal)),
                    ("outstandingPrincipal", amount_json(debt.principal)),
                    ("outstandingInterest", amount_json(debt.interest)),
                    ("collateral", amount_json(service::collateral_of(d, l)?)),
                    ("aprBps", Json::int(l.apr_bps)),
                    ("status", Json::str(l.status.clone())),
                    (
                        "marginCalledAt",
                        l.margin_called_at
                            .map_or(Json::Null, |t| Json::str(t.iso())),
                    ),
                ]));
            }
            Ok(Json::Array(out))
        })(),
        "loans.health" => sweep::mark_user(d, user).map(|m| {
            Json::obj([
                ("debtValue", amount_json(m.debt_value)),
                ("collateralValue", amount_json(m.collateral_value)),
                ("portfolioLtvBps", Json::int(m.portfolio_ltv_bps)),
                (
                    "loans",
                    Json::Array(
                        m.loans
                            .iter()
                            .map(|l| {
                                Json::obj([
                                    ("loanId", Json::str(l.loan_id.clone())),
                                    ("debtValue", amount_json(l.debt_value)),
                                    ("collateralValue", amount_json(l.collateral_value)),
                                    ("ltvBps", Json::int(l.ltv_bps)),
                                ])
                            })
                            .collect(),
                    ),
                ),
            ])
        }),
        "loans.addCollateral" => (|| {
            own_loan(d, user, text(input, "loanId"))?;
            let (tx, sequence) = service::add_collateral(
                d,
                text(input, "loanId"),
                text(input, "eventId"),
                amount_of(text(input, "amount"))?,
            )?;
            Ok(Json::obj([
                ("ledgerTxId", Json::str(tx)),
                ("sequence", Json::int(sequence)),
            ]))
        })(),
        "loans.releasable" => (|| {
            let id = text(input, "loanId");
            own_loan(d, user, id)?;
            let r = service::releasable(d, id)?;
            Ok(Json::obj([
                ("loanId", Json::str(id)),
                ("held", amount_json(r.held)),
                ("releasable", amount_json(r.releasable)),
                ("maxLtvBps", Json::int(r.max_ltv_bps)),
                ("ltvBps", Json::int(r.ltv_bps)),
            ]))
        })(),
        "loans.releaseExcess" => (|| {
            own_loan(d, user, text(input, "loanId"))?;
            let (tx, sequence) = service::release_excess(
                d,
                text(input, "loanId"),
                text(input, "eventId"),
                amount_of(text(input, "amount"))?,
            )?;
            Ok(Json::obj([
                ("ledgerTxId", Json::str(tx)),
                ("sequence", Json::int(sequence)),
            ]))
        })(),
        "loans.repay" => (|| {
            own_loan(d, user, text(input, "loanId"))?;
            let r = service::repay(
                d,
                text(input, "loanId"),
                amount_of(text(input, "amount"))?,
                text(input, "eventId"),
            )?;
            Ok(Json::obj([
                ("ledgerTxId", Json::str(r.ledger_tx_id)),
                ("interestPaid", amount_json(r.interest_paid)),
                ("principalPaid", amount_json(r.principal_paid)),
                ("remainingPrincipal", amount_json(r.remaining.principal)),
                ("remainingInterest", amount_json(r.remaining.interest)),
                ("closed", Json::Bool(r.closed)),
            ]))
        })(),
        "loans.close" => (|| {
            own_loan(d, user, text(input, "loanId"))?;
            let (released, tx) = service::release_settled(d, text(input, "loanId"))?;
            Ok(Json::obj([
                ("released", amount_json(released)),
                ("ledgerTxId", tx.map_or(Json::Null, Json::str)),
            ]))
        })(),
        "loans.quote" => (|| {
            let q = service::quote(
                d,
                text(input, "productId"),
                amount_of(text(input, "principal"))?,
            )?;
            let older = q.debt_mark.mark.as_of.0.min(q.collateral_mark.mark.as_of.0);
            Ok(Json::obj([
                ("productId", Json::str(q.product.id.clone())),
                ("debtAssetId", Json::str(q.product.debt_asset_id.clone())),
                (
                    "collateralAssetId",
                    Json::str(q.product.collateral_asset_id.clone()),
                ),
                ("quoteAssetId", Json::str(q.product.quote_asset_id.clone())),
                ("principal", amount_json(q.principal)),
                ("requiredCollateral", amount_json(q.required_collateral)),
                ("startingLtvBps", Json::int(q.starting_ltv_bps)),
                ("maxLtvBps", Json::int(q.product.max_ltv_bps)),
                (
                    "liquidationLtvBps",
                    Json::int(q.product.policy.liquidation_ltv_bps),
                ),
                ("liquidationPrice", amount_json(q.liquidation_price)),
                ("debtPrice", amount_json(q.debt_mark.mark.price)),
                ("collateralPrice", amount_json(q.collateral_mark.mark.price)),
                ("pricedAt", Json::str(Instant(older).iso())),
            ]))
        })(),
        "loans.eligibility" => (|| {
            let p = with(d.store, |c| product(c, text(input, "productId")))?;
            let paused = match assert_borrow_open(d, &[&p.debt_asset_id, &p.collateral_asset_id]) {
                Ok(()) => None,
                Err(Refusal::Bank(e)) => Some(e.row.code.to_owned()),
                Err(e) => return Err(e),
            };
            let fee = service::origination_fee_refusal(d);
            let reasons = vec![
                if d.settings.module_enabled {
                    reason("lending_policy", "met", None)
                } else {
                    reason("lending_policy", "unmet", Some("bank.loans_disabled"))
                },
                if p.status == "open" {
                    reason("product_open", "met", None)
                } else {
                    reason("product_open", "unmet", Some("bank.loan_product_closed"))
                },
                match &paused {
                    None => reason("assets_open", "met", None),
                    Some(code) => reason("assets_open", "unmet", Some(code)),
                },
                match fee {
                    Some(code) => reason("origination_fee", "unmet", Some(code)),
                    None => reason("origination_fee", "met", None),
                },
                reason("jurisdiction_rules", "not_set", None),
            ];
            let eligible = d.settings.module_enabled
                && p.status == "open"
                && paused.is_none()
                && fee.is_none();
            Ok(Json::obj([
                ("productId", Json::str(p.id.clone())),
                ("eligible", Json::Bool(eligible)),
                ("reasons", Json::Array(reasons)),
            ]))
        })(),
        "loans.fees" => (|| {
            let p = with(d.store, |c| product(c, text(input, "productId")))?;
            let origination = match origination_fee(d.settings.origination_fee_bps.as_deref()) {
                OriginationFee::NotSet => Json::obj([("status", Json::str("not_set"))]),
                OriginationFee::Published { bps } => Json::obj([
                    ("status", Json::str("published")),
                    ("bps", Json::int(bps)),
                    (
                        "amount",
                        match opt_text(input, "principal").filter(|s| !s.is_empty()) {
                            Some(s) => amount_json(origination_fee_on(amount_of(s)?, bps)),
                            None => Json::Null,
                        },
                    ),
                    ("collectable", Json::Bool(bps == 0)),
                ]),
            };
            Ok(Json::obj([
                ("productId", Json::str(p.id.clone())),
                ("assetId", Json::str(p.debt_asset_id.clone())),
                ("origination", origination),
            ]))
        })(),
        "loans.terms" => (|| {
            let (l, mc, liq) = service::terms(d, text(input, "loanId"))?;
            assert_self(user, &l.user_id)?;
            Ok(Json::obj([
                ("loanId", Json::str(l.id.clone())),
                ("productId", Json::str(l.product_id.clone())),
                ("debtAssetId", Json::str(l.debt_asset_id.clone())),
                (
                    "collateralAssetId",
                    Json::str(l.collateral_asset_id.clone()),
                ),
                ("principal", amount_json(l.principal)),
                (
                    "openingCollateral",
                    l.opening_collateral.map_or(Json::Null, amount_json),
                ),
                ("aprBps", Json::int(l.apr_bps)),
                ("marginCallLtvBps", mc.map_or(Json::Null, Json::int)),
                ("liquidationLtvBps", liq.map_or(Json::Null, Json::int)),
                ("openedAt", Json::str(l.opened_at.iso())),
            ]))
        })(),
        "loans.projection" => (|| {
            own_loan(d, user, text(input, "loanId"))?;
            let extra = opt_text(input, "extraRepayment")
                .filter(|s| !s.is_empty())
                .map(amount_of)
                .transpose()?;
            reads::projection(
                d,
                text(input, "loanId"),
                input.get("days").as_number().unwrap_or_default(),
                extra,
            )
        })(),
        "loans.payoffQuote" => (|| {
            own_loan(d, user, text(input, "loanId"))?;
            reads::payoff_quote(d, text(input, "loanId"), d.now)
        })(),
        "loans.interestRows" => (|| {
            let l = own_loan(d, user, text(input, "loanId"))?;
            adjustments::interest_rows(d, &l)
        })(),
        "loans.ledgerCheck" => (|| {
            let l = own_loan(d, user, text(input, "loanId"))?;
            let check = adjustments::ledger_check(d, &l, d.now)?;
            Ok(strip_mismatches(check))
        })(),
        "loans.statement" => (|| {
            own_loan(d, user, text(input, "loanId"))?;
            reads::statement(
                d,
                text(input, "loanId"),
                text(input, "from"),
                text(input, "to"),
                d.now,
            )
        })(),
        "loans.changeRepaymentDate" => Err(preview(LOAN_SCHEDULE_ENGINE, "change_repayment_date")),
        "loans.payExtra" => Err(preview(LOAN_SCHEDULE_ENGINE, "pay_extra")),
        "loans.repayFromExternalBank" => Err(preview(
            LOAN_EXTERNAL_REPAY_ENGINE,
            "repay_from_external_bank",
        )),
        "loans.missedPaymentPolicy" => Ok(match &d.settings.missed_payment {
            Some(p) => Json::obj([
                ("status", Json::str("set")),
                ("graceDays", Json::int(p.grace_days)),
                ("catchUpDays", Json::int(p.catch_up_days)),
                ("lateFee", Json::str(p.late_fee.clone())),
            ]),
            None => Json::obj([("status", Json::str("not_set"))]),
        }),
        _ => return None,
    })
}

/// `loans.ledgerCheck` answers each mismatch's kind, ref and problem only.
fn strip_mismatches(check: Json) -> Json {
    let Json::Object(fields) = check else {
        return check;
    };
    Json::Object(
        fields
            .into_iter()
            .map(|(k, v)| match (k.as_str(), v) {
                ("mismatches", Json::Array(rows)) => (
                    k,
                    Json::Array(
                        rows.into_iter()
                            .map(|m| match m {
                                Json::Object(f) => Json::Object(
                                    f.into_iter()
                                        .filter(|(k, _)| {
                                            matches!(k.as_str(), "kind" | "ref" | "problem")
                                        })
                                        .collect(),
                                ),
                                other => other,
                            })
                            .collect(),
                    ),
                ),
                (_, v) => (k, v),
            })
            .collect(),
    )
}

fn sweep_disabled() -> Refusal {
    refuse(
        "bank.loan_risk_sweep_disabled",
        "loan risk sweep is disabled",
    )
}

fn accrual_disabled() -> Refusal {
    refuse(
        "bank.loan_accrual_disabled",
        "loan interest accrual is disabled",
    )
}

fn policy_of(input: &Value) -> LiquidationPolicy {
    let n = |k: &str| int_of(input, k).unwrap_or_default();
    LiquidationPolicy {
        margin_call_ltv_bps: n("marginCallLtvBps"),
        liquidation_ltv_bps: n("liquidationLtvBps"),
        insolvency_ltv_bps: n("insolvencyLtvBps"),
        target_ltv_bps: n("targetLtvBps"),
        penalty_bps: n("penaltyBps"),
        max_tranche_bps: n("maxTrancheBps"),
        grace_seconds: n("graceSeconds"),
    }
}

/// `createLoanProductFields`.
fn product_fields(input: &Value) -> Result<Vec<(String, String)>, Refusal> {
    let n = |k: &str| int_of(input, k).unwrap_or_default().to_string();
    Ok(vec![
        f("productId", text(input, "productId")),
        f("name", text(input, "name")),
        f("debtAssetId", text(input, "debtAssetId")),
        f("collateralAssetId", text(input, "collateralAssetId")),
        f("quoteAssetId", text(input, "quoteAssetId")),
        f("aprBps", n("aprBps")),
        f("maxLtvBps", n("maxLtvBps")),
        f(
            "minPrincipal",
            format_amount(amount_of(text(input, "minPrincipal"))?),
        ),
        f("marginCallLtvBps", n("marginCallLtvBps")),
        f("liquidationLtvBps", n("liquidationLtvBps")),
        f("insolvencyLtvBps", n("insolvencyLtvBps")),
        f("targetLtvBps", n("targetLtvBps")),
        f("penaltyBps", n("penaltyBps")),
        f("maxTrancheBps", n("maxTrancheBps")),
        f("graceSeconds", n("graceSeconds")),
    ])
}

#[allow(
    clippy::too_many_lines,
    reason = "one arm per call, as the router reads"
)]
fn ops(d: &Deps<'_>, path: &str, input: &Value) -> Option<Result<Json, Refusal>> {
    let consume = |action: &str, fields: &[(String, String)]| {
        consume_approval(d.approvals, input, action, fields)
    };
    Some(match path {
        "ops.fundLoanReserve" => (|| {
            let asset = text(input, "debtAssetId");
            let funding = text(input, "fundingId");
            let amount = text(input, "amount");
            let approved = consume(
                "bank.fund_loan_reserve",
                &[
                    f("debtAssetId", asset),
                    f("fundingId", funding),
                    f("amount", amount),
                ],
            )?;
            let tx = service::fund_reserve(d, asset, funding, amount_of(amount)?, None)?;
            Ok(Json::obj([
                ("ledgerTxId", Json::str(tx)),
                ("confirmOperatorId", Json::str(approved.approver_id)),
            ]))
        })(),
        "ops.adjustLoanInterest" => (|| {
            let terms = Terms {
                adjustment_id: text(input, "adjustmentId").to_owned(),
                loan_id: text(input, "loanId").to_owned(),
                amount: text(input, "amount").to_owned(),
                reason: text(input, "reason").to_owned(),
            };
            let prior = with(d.store, |c| adjustments::by_id(c, &terms.adjustment_id))?;
            let (a, replay) = if let Some(prior) = prior {
                adjustments::assert_same(&prior, &terms)?;
                (prior, true)
            } else {
                adjustments::check(d, &terms)?;
                let fields = [
                    f("loanId", terms.loan_id.clone()),
                    f("adjustmentId", terms.adjustment_id.clone()),
                    f("amount", terms.amount.clone()),
                    f("reason", terms.reason.clone()),
                ];
                let pair = consume(adjustments::ADJUST_LOAN_INTEREST_ACTION, &fields)?;
                adjustments::write(
                    d,
                    &terms,
                    &People {
                        proposed_by: &pair.requester_id,
                        approved_by: &pair.approver_id,
                        approval_id: &pair.approval_id,
                    },
                    d.now,
                )?
            };
            let debt = with(d.store, |c| outstanding(c, &terms.loan_id))?;
            Ok(Json::obj([
                ("adjustmentId", Json::str(a.id.clone())),
                ("loanId", Json::str(a.loan_id.clone())),
                ("amount", amount_json(a.amount)),
                ("reason", Json::str(a.reason.clone())),
                ("proposedBy", Json::str(a.proposed_by.clone())),
                ("approvedBy", Json::str(a.approved_by.clone())),
                ("createdAt", Json::str(a.created_at.iso())),
                ("replay", Json::Bool(replay)),
                ("interestOwed", amount_json(debt.interest)),
            ]))
        })(),
        "ops.accrueLoanInterest" => (|| {
            if !d.settings.accrual_enabled {
                return Err(accrual_disabled());
            }
            let at = match opt_text(input, "at") {
                Some(a) => time_of(a)?,
                None => d.now,
            };
            if let Some(id) = opt_text(input, "loanId") {
                let one = service::accrue(d, id, at)?;
                return Ok(Json::obj([
                    (
                        "results",
                        Json::Array(vec![Json::obj([
                            ("loanId", Json::str(one.loan_id)),
                            ("charged", amount_json(one.charged)),
                            (
                                "days",
                                Json::int(i64::try_from(one.days.len()).unwrap_or(i64::MAX)),
                            ),
                        ])]),
                    ),
                    ("failures", Json::Array(Vec::new())),
                ]));
            }
            Ok(accrue_report(&service::accrue_all(
                d,
                at,
                input.get("limit").as_number(),
            )?))
        })(),
        "ops.runRiskSweep" => {
            if d.settings.risk_sweep_enabled {
                sweep::run_risk_sweep(d, d.now, input.get("limit").as_number()).map(|s| s.json())
            } else {
                Err(sweep_disabled())
            }
        }
        "ops.seizeLoan" => (|| {
            let id = text(input, "loanId");
            let approved = consume("bank.seize_loan", &[f("loanId", id)])?;
            if !d.settings.risk_sweep_enabled {
                return Err(sweep_disabled());
            }
            let s = sweep::seize(d, id, d.now)?;
            Ok(Json::obj([
                ("ledgerTxId", Json::str(s.ledger_tx_id)),
                ("collateralSold", amount_json(s.collateral_sold)),
                ("proceeds", amount_json(s.proceeds)),
                ("principalRepaid", amount_json(s.principal_repaid)),
                ("interestRepaid", amount_json(s.interest_repaid)),
                ("closed", Json::Bool(s.closed)),
                ("confirmOperatorId", Json::str(approved.approver_id)),
            ]))
        })(),
        "ops.resumePendingLoans" => service::resume_pending(d, input.get("limit").as_number())
            .map(|rows| Json::Array(rows.iter().map(service::Resumed::json).collect())),
        "ops.abandonPendingLoan" => (|| {
            let id = text(input, "loanId");
            let approved = consume("bank.abandon_pending_loan", &[f("loanId", id)])?;
            let a = service::abandon_pending(d, id)?;
            Ok(Json::obj([
                ("released", amount_json(a.released)),
                ("ledgerTxId", a.ledger_tx_id.map_or(Json::Null, Json::str)),
                ("adopted", Json::Bool(a.adopted)),
                (
                    "drawLedgerTxId",
                    a.draw_ledger_tx_id.map_or(Json::Null, Json::str),
                ),
                ("confirmOperatorId", Json::str(approved.approver_id)),
            ]))
        })(),
        "ops.reconcileLoanReserve" => (|| {
            let asset = text(input, "debtAssetId");
            let r = service::reconcile_reserve(d, asset)?;
            Ok(Json::obj([
                ("reserveBalance", amount_json(r.reserve_balance)),
                ("outstandingPrincipal", amount_json(r.outstanding_principal)),
                ("badDebt", amount_json(r.bad_debt)),
                ("funded", amount_json(r.funded)),
                ("drift", amount_json(r.drift)),
                ("independent", Json::Bool(r.independent)),
                (
                    "insuranceCapacity",
                    amount_json(service::insurance_capacity(d, asset)?),
                ),
            ]))
        })(),
        "ops.loanBook" => book::read(d, d.now),
        "ops.createLoanProduct" => (|| {
            let product_id = text(input, "productId");
            let terms = NewProduct {
                name: js_trim(text(input, "name")).to_owned(),
                debt_asset_id: text(input, "debtAssetId").to_owned(),
                collateral_asset_id: text(input, "collateralAssetId").to_owned(),
                quote_asset_id: text(input, "quoteAssetId").to_owned(),
                apr_bps: int_of(input, "aprBps").unwrap_or_default(),
                max_ltv_bps: int_of(input, "maxLtvBps").unwrap_or_default(),
                min_principal: Some(amount_of(text(input, "minPrincipal"))?),
                policy: policy_of(input),
            };
            model::assert_loan_params(&terms)?;
            let approved = consume("bank.ops.createLoanProduct", &product_fields(input)?)?;
            let (p, replayed) = with(d.store, |c| {
                model::create_product_once(c, product_id, &terms)
            })?;
            Ok(Json::obj([
                ("productId", Json::str(p.id.clone())),
                ("status", Json::str(p.status.clone())),
                ("aprBps", Json::int(p.apr_bps)),
                ("maxLtvBps", Json::int(p.max_ltv_bps)),
                ("minPrincipal", amount_json(p.min_principal)),
                ("replayed", Json::Bool(replayed)),
                ("approvedBy", Json::str(approved.approver_id)),
            ]))
        })(),
        "ops.setLoanProductRate" => (|| {
            let change = RateChange {
                product_id: text(input, "productId").to_owned(),
                from_apr_bps: int_of(input, "fromAprBps").unwrap_or_default(),
                apr_bps: int_of(input, "aprBps").unwrap_or_default(),
                reason: text(input, "reason").to_owned(),
            };
            let approval_id = opt_text(input, "approvalId").unwrap_or_default();
            let rate_json = |product_id: String, apr: i64, previous: i64, by: String| {
                Json::obj([
                    ("productId", Json::str(product_id)),
                    ("aprBps", Json::int(apr)),
                    ("previousAprBps", Json::int(previous)),
                    ("approvedBy", Json::str(by)),
                ])
            };
            if !approval_id.is_empty()
                && let Some(r) = with(d.store, |c| {
                    model::rate_change_by_approval(c, approval_id, &change)
                })?
            {
                return Ok(rate_json(
                    r.product_id,
                    r.apr_bps,
                    r.previous_apr_bps,
                    r.approved_by,
                ));
            }
            model::check_rate_terms(&change)?;
            with(d.store, |c| model::check_rate_change(c, &change))?;
            let fields = [
                f("productId", change.product_id.clone()),
                f("fromAprBps", change.from_apr_bps.to_string()),
                f("aprBps", change.apr_bps.to_string()),
                f("reason", js_trim(&change.reason)),
            ];
            let approved = consume("bank.ops.setLoanProductRate", &fields)?;
            let (p, previous) = crate::spaces::space::in_tx(d.store, |tx| {
                model::set_product_rate(tx, &change, approval_id, &approved.approver_id)
            })?;
            Ok(rate_json(
                p.id.clone(),
                p.apr_bps,
                previous,
                approved.approver_id,
            ))
        })(),
        _ => return None,
    })
}

fn accrue_report(r: &service::AccrueReport) -> Json {
    Json::obj([
        (
            "results",
            Json::Array(
                r.results
                    .iter()
                    .map(|l| {
                        Json::obj([
                            ("loanId", Json::str(l.loan_id.clone())),
                            ("charged", amount_json(l.charged)),
                            ("days", Json::int(i64::try_from(l.days).unwrap_or(i64::MAX))),
                        ])
                    })
                    .collect(),
            ),
        ),
        (
            "failures",
            Json::Array(
                r.failures
                    .iter()
                    .map(|x| {
                        let mut fields = vec![
                            ("loanId".to_owned(), Json::str(x.loan_id.clone())),
                            ("reason".to_owned(), Json::str(x.reason.clone())),
                        ];
                        if let Some(code) = &x.code {
                            fields.push(("code".to_owned(), Json::str(code.clone())));
                        }
                        Json::Object(fields)
                    })
                    .collect(),
            ),
        ),
    ])
}

/// The answer of one of the slice's calls, by its path; `None` for a path outside it.
pub fn answer(
    d: &Deps<'_>,
    user: &str,
    path: &str,
    input: &Value,
) -> Option<Result<Json, Refusal>> {
    customer(d, user, path, input).or_else(|| ops(d, path, input))
}

// ── Job doors ────────────────────────────────────────────────────────────────────────────────────────────────────────

/// `POST /internal/jobs/accrue-loan-interest`: every open loan through now.
pub fn job_accrue(d: &Deps<'_>) -> Result<Json, Refusal> {
    if !d.settings.accrual_enabled {
        return Err(accrual_disabled());
    }
    Ok(accrue_report(&service::accrue_all(
        d,
        d.now,
        Some(1_000.0),
    )?))
}

/// `POST /internal/jobs/run-risk-sweep`: one sweep of `LOAN_SWEEP_BATCH_SIZE`.
pub fn job_sweep(d: &Deps<'_>) -> Result<Json, Refusal> {
    if !d.settings.risk_sweep_enabled {
        return Err(sweep_disabled());
    }
    sweep::run_risk_sweep(d, d.now, d.settings.sweep_batch).map(|s| s.json())
}
