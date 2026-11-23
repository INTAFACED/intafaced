//! The desk's ramp calls (`ops/ramp-health.ts`, `ops/ramp-metrics.ts`, `ops/onramp-quotes.ts`, and `ops.creditOnramp` in
//! `router/ops.router.ts`). Every read is read only; the credit consumes an identity-issued approval bound to every term
//! before it claims anything.

use service_kit::json::Json;
use service_kit::money::{format_amount, parse_amount};
use service_kit::schema::Value;
use service_kit::time::Instant;

use super::service::{self, CreditAsk};
use super::{Deps, Onramp, payin, rails};
use crate::earn::ms;
use crate::errors::Refusal;
use crate::partner::refuse;
use crate::spaces::space::{pg, with};

/// `ONRAMP_QUOTES_LIST_MAX`.
pub const QUOTES_LIST_MAX: i64 = 100;

fn whole(v: &Value, key: &str) -> Option<f64> {
    v.get(key).as_number()
}

/// `assertWindowHours`.
fn window_hours(v: Option<f64>) -> Result<i64, Refusal> {
    match v {
        #[allow(
            clippy::cast_possible_truncation,
            reason = "a whole number from 1 to 720"
        )]
        Some(h) if h.fract() == 0.0 && (1.0..=720.0).contains(&h) => Ok(h as i64),
        _ => Err(refuse(
            "bank.ramp_health_window_unset",
            "Ramp health needs windowHours from 1 to 720 (bank.ramp_health_window_unset)",
        )),
    }
}

/// `assertQuotesLimit`.
fn quotes_limit(v: Option<f64>) -> Result<i64, Refusal> {
    match v {
        #[allow(
            clippy::cast_possible_truncation,
            reason = "a whole number from 1 to 100"
        )]
        Some(n) if n.fract() == 0.0 && (1.0..=100.0).contains(&n) => Ok(n as i64),
        _ => Err(refuse(
            "bank.onramp_quotes_limit_unset",
            format!(
                "This fiat buy read needs a limit from 1 to {QUOTES_LIST_MAX} (bank.onramp_quotes_limit_unset)"
            ),
        )),
    }
}

/// `readRampHealth`.
fn ramp_health(d: &Deps<'_>, o: &Onramp<'_>, hours: i64) -> Result<Json, Refusal> {
    let now = d.now;
    let since = Instant(now.0.saturating_sub(hours.saturating_mul(3_600_000)));
    let rows = service::attempts_since(d, since)?;
    let rails = rails::rails(&o.programme())
        .iter()
        .map(|(id, provider)| {
            let mine: Vec<_> = rows
                .iter()
                .filter(|r| r.rail == *id && r.created_at.0 <= now.0)
                .collect();
            let failures: Vec<_> = mine.iter().filter(|r| r.status == "rejected").collect();
            let last_success = mine
                .iter()
                .filter(|r| r.status == "settled")
                .filter_map(|r| r.settled_at)
                .max_by_key(|t| t.0);
            let last_failure = failures.iter().map(|r| r.created_at).max_by_key(|t| t.0);
            let open = mine
                .iter()
                .filter(|r| {
                    matches!(
                        r.status.as_str(),
                        "pending" | "awaiting_payment" | "submitted"
                    )
                })
                .count();
            let count = |n: usize| Json::int(i64::try_from(n).unwrap_or(i64::MAX));
            Json::obj([
                ("id", Json::str(*id)),
                ("provider", Json::str(*provider)),
                (
                    "lastSuccess",
                    last_success.map_or(Json::Null, |t| Json::str(t.iso())),
                ),
                (
                    "lastFailure",
                    last_failure.map_or(Json::Null, |t| Json::str(t.iso())),
                ),
                ("openCount", count(open)),
                ("failureCount", count(failures.len())),
                ("totalCount", count(mine.len())),
                (
                    "failureRate",
                    if mine.is_empty() {
                        Json::Null
                    } else {
                        Json::str(format!("{}/{}", failures.len(), mine.len()))
                    },
                ),
                ("lastProbeAt", Json::Null),
                ("reason", Json::str("no_heartbeat")),
            ])
        })
        .collect();
    Ok(Json::obj([
        ("asOf", Json::str(now.iso())),
        ("rails", Json::Array(rails)),
    ]))
}

fn decimal(s: String) -> Result<Json, Refusal> {
    Ok(Json::str(format_amount(
        parse_amount(&s).map_err(Refusal::Other)?,
    )))
}

/// `readOnrampQuotes`.
fn onramp_quotes(d: &Deps<'_>, limit: i64) -> Result<Json, Refusal> {
    with(d.store, |c| {
        let rows = c
            .query(
                &format!(
                    "SELECT id::text, user_id, asset_id, amount::text, method, country, pay_amount::text, fee::text, \
                       rate::text, pay_currency, simulated, {}, {} \
                     FROM bank.ramp_onramp_quotes ORDER BY created_at DESC, id LIMIT $1",
                    ms("created_at"),
                    ms("expires_at")
                ),
                &[&limit],
            )
            .map_err(|e| pg(&e))?;
        let out = rows
            .iter()
            .map(|r| {
                let s = |i: usize| r.try_get::<_, String>(i).map_err(|e| pg(&e));
                let t = |i: usize| {
                    r.try_get::<_, i64>(i)
                        .map_err(|e| pg(&e))
                        .map(|v| Json::str(Instant(v).iso()))
                };
                Ok(Json::obj([
                    ("quoteId", Json::str(s(0)?)),
                    ("userId", Json::str(s(1)?)),
                    ("assetId", Json::str(s(2)?)),
                    ("amount", decimal(s(3)?)?),
                    ("method", Json::str(s(4)?)),
                    ("country", Json::str(s(5)?)),
                    ("payAmount", decimal(s(6)?)?),
                    ("fee", decimal(s(7)?)?),
                    ("rate", decimal(s(8)?)?),
                    ("payCurrency", Json::str(s(9)?)),
                    ("simulated", Json::Bool(r.try_get(10).map_err(|e| pg(&e))?)),
                    ("createdAt", t(11)?),
                    ("expiresAt", t(12)?),
                ]))
            })
            .collect::<Result<Vec<_>, Refusal>>()?;
        Ok(Json::Array(out))
    })
}

/// `readOnrampFeesNotKnown`.
fn fees_not_known(d: &Deps<'_>, limit: i64) -> Result<Json, Refusal> {
    let rows = with(d.store, |c| {
        let rows = c
            .query(
                &format!(
                    "SELECT id::text, user_id, asset_id, amount::text, method, country, {} \
                     FROM bank.add_money_requests \
                     WHERE status = 'refused' AND refusal_code = 'bank.onramp_fee_not_known' AND quote_id IS NULL \
                     ORDER BY created_at DESC, id LIMIT $1",
                    ms("created_at")
                ),
                &[&limit],
            )
            .map_err(|e| pg(&e))?;
        rows.iter()
            .map(|r| {
                let s = |i: usize| r.try_get::<_, String>(i).map_err(|e| pg(&e));
                Ok(Json::obj([
                    ("requestId", Json::str(s(0)?)),
                    ("userId", Json::str(s(1)?)),
                    ("assetId", Json::str(s(2)?)),
                    ("amount", decimal(s(3)?)?),
                    ("method", Json::str(s(4)?)),
                    ("country", Json::str(s(5)?)),
                    ("refusalCode", Json::str("bank.onramp_fee_not_known")),
                    (
                        "createdAt",
                        Json::str(Instant(r.try_get(6).map_err(|e| pg(&e))?).iso()),
                    ),
                ]))
            })
            .collect::<Result<Vec<_>, Refusal>>()
    })?;
    let label = d
        .partner
        .partner
        .as_ref()
        .map_or(Json::Null, |_| Json::str(crate::partner::LABEL));
    Ok(Json::obj([
        ("testPartner", label),
        ("rows", Json::Array(rows)),
    ]))
}

fn text<'v>(v: &'v Value, key: &str) -> &'v str {
    v.get(key).as_str().unwrap_or_default()
}

/// `ops.creditOnramp`: the operator's credit, after the second person's approval bound to every term.
fn credit_onramp(
    d: &Deps<'_>,
    o: &Onramp<'_>,
    operator: &str,
    input: &Value,
) -> Result<Json, Refusal> {
    let kind = input.get("kind").as_str().unwrap_or("crypto");
    let f = |k: &str, v: &str| (k.to_owned(), v.to_owned());
    let fields = [
        f("userId", text(input, "userId")),
        f("assetId", text(input, "assetId")),
        f("amount", text(input, "amount")),
        f("kind", kind),
        f("railRef", text(input, "railRef")),
    ];
    let approved = crate::ops_approval::consume(
        d.transfers.approvals.as_ref(),
        input,
        "bank.credit_onramp",
        &fields,
    )?;
    let amount = parse_amount(text(input, "amount")).map_err(Refusal::Other)?;
    let row = service::credit_onramp(
        d,
        o,
        &CreditAsk {
            user_id: text(input, "userId"),
            asset_id: text(input, "assetId"),
            amount,
            kind,
            rail_ref: text(input, "railRef"),
            credited_by: operator,
        },
    )?;
    Ok(Json::obj([
        ("id", Json::str(row.id)),
        ("userId", Json::str(row.user_id)),
        ("assetId", Json::str(row.asset_id)),
        ("amount", Json::str(format_amount(row.amount))),
        ("kind", Json::str(row.kind)),
        ("rail", Json::str(row.rail)),
        ("railRef", Json::str(row.rail_ref)),
        ("simulated", Json::Bool(row.simulated)),
        ("status", Json::str(row.status)),
        ("ledgerTxId", row.ledger_tx_id.map_or(Json::Null, Json::str)),
        ("confirmOperatorId", Json::str(approved.approver_id)),
    ]))
}

/// The desk's ramp calls; `None` for any other path.
pub fn answer(
    d: &Deps<'_>,
    o: &Onramp<'_>,
    operator: &str,
    path: &str,
    input: &Value,
) -> Option<Result<Json, Refusal>> {
    Some(match path {
        "ops.creditOnramp" => credit_onramp(d, o, operator, input),
        "ops.rampHealth" => {
            window_hours(whole(input, "windowHours")).and_then(|h| ramp_health(d, o, h))
        }
        "ops.rampMetrics" => Ok(Json::obj([(
            "partner",
            o.w.partner.as_ref().map_or(Json::Null, |p| {
                let report = p.book().report(p.label(), d.now);
                payin::metrics_view(Some(&report))
            }),
        )])),
        "ops.onrampQuotes" => quotes_limit(whole(input, "limit")).and_then(|n| onramp_quotes(d, n)),
        "ops.onrampFeesNotKnown" => {
            quotes_limit(whole(input, "limit")).and_then(|n| fees_not_known(d, n))
        }
        _ => return None,
    })
}
