//! The operator's loan book (`ops/loan-book.ts`): counts, principal per asset, and bands at the thresholds stored on
//! each loan at open, not the live product row. A loan whose asset has no usable mark is `unpriced`, never healthy.
//! It reads; it never seizes.

use std::collections::BTreeMap;

use service_kit::json::Json;
use service_kit::money::{Amount, format_amount};
use service_kit::time::Instant;

use super::model::{loan, ms, outstanding};
use super::ports::Deps;
use super::risk::{Holding, Round, value_at};
use super::service::{accepted_marks, backlog, collateral_of, ltv_bps};
use crate::errors::Refusal;
use crate::spaces::space::{pg, with};

/// `bandAtOpeningThresholds`: the cut `planLiquidation` uses, without the grace demotion; a boundary is the higher band.
pub fn band(ltv: i64, margin_call: i64, liquidation: i64) -> &'static str {
    if ltv < margin_call {
        "healthy"
    } else if ltv < liquidation {
        "marginCall"
    } else {
        "liquidation"
    }
}

struct Row {
    id: String,
    status: String,
    opened_at: i64,
    margin_call: Option<i64>,
    liquidation: Option<i64>,
}

/// `readLoanBook`.
pub fn read(d: &Deps<'_>, now: Instant) -> Result<Json, Refusal> {
    let rows = with(d.store, |c| {
        c.query(
            &format!(
                "SELECT id::text, status::text, {}, margin_call_ltv_bps::int8, liquidation_ltv_bps::int8
                   FROM bank.loans ORDER BY opened_at ASC, id ASC",
                ms("opened_at")
            ),
            &[],
        )
        .map_err(|e| pg(&e))?
        .iter()
        .map(|r| -> Result<Row, Refusal> {
            Ok(Row {
                id: r.try_get(0).map_err(|e| pg(&e))?,
                status: r.try_get(1).map_err(|e| pg(&e))?,
                opened_at: r.try_get(2).map_err(|e| pg(&e))?,
                margin_call: r.try_get(3).map_err(|e| pg(&e))?,
                liquidation: r.try_get(4).map_err(|e| pg(&e))?,
            })
        })
        .collect::<Result<Vec<_>, _>>()
    })?;
    let open: Vec<&Row> = rows
        .iter()
        .filter(|r| matches!(r.status.as_str(), "active" | "margin_call" | "liquidating"))
        .collect();
    let mut loans = Vec::with_capacity(open.len());
    for r in &open {
        loans.push(with(d.store, |c| loan(c, &r.id))?);
    }
    // Marks per quote asset, each asked once with every asset its loans name (insertion order, as a JS Set keeps it).
    let mut quotes: Vec<(String, Vec<String>)> = Vec::new();
    for l in &loans {
        if !quotes.iter().any(|(q, _)| *q == l.quote_asset_id) {
            quotes.push((l.quote_asset_id.clone(), Vec::new()));
        }
        if let Some((_, assets)) = quotes.iter_mut().find(|(q, _)| *q == l.quote_asset_id) {
            for a in [&l.debt_asset_id, &l.collateral_asset_id] {
                if !assets.contains(a) {
                    assets.push(a.clone());
                }
            }
        }
    }
    let mut marks_by_quote = BTreeMap::new();
    for (quote, assets) in &quotes {
        marks_by_quote.insert(quote.clone(), accepted_marks(d, assets, quote, now)?);
    }
    let (mut healthy, mut margin_call, mut liquidation, mut unpriced_n) =
        (0_i64, 0_i64, 0_i64, 0_i64);
    let mut unpriced = Vec::new();
    let mut principal: BTreeMap<String, Amount> = BTreeMap::new();
    for (row, l) in open.iter().zip(&loans) {
        let debt = with(d.store, |c| outstanding(c, &l.id))?;
        *principal
            .entry(l.debt_asset_id.clone())
            .or_insert(Amount::ZERO) += debt.principal;
        let (Some(mc), Some(liq)) = (row.margin_call, row.liquidation) else {
            unpriced_n += 1;
            unpriced.push(Json::obj([
                ("loanId", Json::str(l.id.clone())),
                ("reason", Json::str("bank.loan_opening_thresholds_unset")),
            ]));
            continue;
        };
        let empty = BTreeMap::new();
        let marks = marks_by_quote.get(&l.quote_asset_id).unwrap_or(&empty);
        if !marks.contains_key(&l.debt_asset_id) || !marks.contains_key(&l.collateral_asset_id) {
            unpriced_n += 1;
            unpriced.push(Json::obj([
                ("loanId", Json::str(l.id.clone())),
                ("reason", Json::str("bank.loan_health_price_unset")),
            ]));
            continue;
        }
        let collateral = collateral_of(d, l)?;
        let debt_value = value_at(
            &[Holding {
                asset_id: l.debt_asset_id.clone(),
                quantity: debt.total,
            }],
            marks,
            Round::Ceil,
        )
        .map_err(backlog)?;
        let collateral_value = value_at(
            &[Holding {
                asset_id: l.collateral_asset_id.clone(),
                quantity: collateral,
            }],
            marks,
            Round::Floor,
        )
        .map_err(backlog)?;
        match band(ltv_bps(debt_value, collateral_value)?, mc, liq) {
            "healthy" => healthy += 1,
            "marginCall" => margin_call += 1,
            _ => liquidation += 1,
        }
    }
    let oldest = rows.iter().find(|r| r.status == "pending");
    Ok(Json::obj([
        ("asOf", Json::str(now.iso())),
        (
            "openCount",
            Json::int(i64::try_from(open.len()).unwrap_or(i64::MAX)),
        ),
        (
            "outstandingPrincipal",
            Json::Array(
                principal
                    .into_iter()
                    .map(|(asset, amount)| {
                        Json::obj([
                            ("assetId", Json::str(asset)),
                            ("amount", Json::str(format_amount(amount))),
                        ])
                    })
                    .collect(),
            ),
        ),
        (
            "bands",
            Json::obj([
                ("healthy", Json::int(healthy)),
                ("marginCall", Json::int(margin_call)),
                ("liquidation", Json::int(liquidation)),
                ("unpriced", Json::int(unpriced_n)),
            ]),
        ),
        ("unpriced", Json::Array(unpriced)),
        (
            "oldestPending",
            oldest.map_or(Json::Null, |o| {
                Json::obj([
                    ("id", Json::str(o.id.clone())),
                    (
                        "ageSeconds",
                        Json::int(((now.0 - o.opened_at) / 1000).max(0)),
                    ),
                ])
            }),
        ),
    ]))
}
