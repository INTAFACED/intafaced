//! Part `work_items` of the activity slice: the bank's part of the Home work list (`home/work-items.ts`,
//! HM-dashboard-03), `workItems.list`.
//!
//! It answers the signed person's bank kinds, derived from svc-bank's own records and never stored. A row exists while
//! its record says so and is gone when the record is resolved.
//!
//! - `margin_health:<loan id>`: an open loan of theirs with an open margin call: `action` while the call stands (due when
//!   its grace ends, with the collateral to post and the loan-to-value the call was raised at), `warning` once the loan
//!   is liquidating. A loan only drifting towards its call band would need the margin warning level, an owner value
//!   that must stay blank (`readMarginWarningLevel`, held at boot by `crate::env`), so only loans already in a call are listed.
//! - `loan_payment_due`: never listed; the crypto-backed loan has no repayment schedule, and none is invented.
//! - `card_frozen:<card id>`: a frozen card of theirs: `action` when they froze it (or nobody is recorded, before
//!   migration 0040), `info` when the bank did.
//!
//! The bank sends copy keys and record values, never sentences, and links only into its own rooms (`/bank`).

use postgres::GenericClient;
use service_kit::json::Json;
use service_kit::money::{format_amount, parse_amount};
use service_kit::time::Instant;
use service_kit::trpc::TrpcError;

use super::Deps;
use crate::door::Ctx;
use crate::errors::{Refusal, to_trpc};
use crate::spaces::space::{pg, with};

/// The most items one answer carries (`items.slice(0, 100)`).
const MAX_ITEMS: usize = 100;

/// One open margin call of an open loan (`MarginRow`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MarginRow {
    pub loan_id: String,
    /// `active`, `margin_call` or `liquidating`.
    pub status: String,
    pub collateral_asset_id: String,
    pub ltv_bps: i64,
    /// `cure_collateral_amount::text`.
    pub cure_collateral_amount: String,
    pub grace_expires_at: Instant,
}

/// One frozen card (`FrozenCardRow`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FrozenCardRow {
    pub id: String,
    pub frozen_by: Option<String>,
}

/// `bpsRatio`: basis points as the contract's ratio, where 1 is 100%: 8500 is "0.85".
pub fn bps_ratio(bps: i64) -> Result<String, Refusal> {
    if bps < 0 {
        return Err(Refusal::Other(format!("Not a basis-point value: {bps}")));
    }
    let whole = bps / 10_000;
    let part = format!("{:04}", bps % 10_000);
    let part = part.trim_end_matches('0');
    Ok(if part.is_empty() {
        whole.to_string()
    } else {
        format!("{whole}.{part}")
    })
}

/// `marginItem`.
pub fn margin_item(row: &MarginRow) -> Result<Json, Refusal> {
    // A call written just before its loan's status moved is still a call: only liquidation changes what is owed.
    let calling = row.status != "liquidating";
    let cure = parse_amount(&row.cure_collateral_amount).map_err(Refusal::Other)?;
    Ok(Json::obj([
        ("id", Json::str(format!("margin_health:{}", row.loan_id))),
        ("kind", Json::str("margin_health")),
        ("source", Json::str("bank")),
        (
            "severity",
            Json::str(if calling { "action" } else { "warning" }),
        ),
        (
            "titleKey",
            Json::str(if calling {
                "bank.margin.call_open"
            } else {
                "bank.margin.liquidating"
            }),
        ),
        ("link", Json::str("/bank/loans")),
        ("dueAt", Json::str(row.grace_expires_at.iso())),
        (
            "amount",
            Json::obj([
                ("value", Json::str(format_amount(cure))),
                ("asset", Json::str(row.collateral_asset_id.clone())),
            ]),
        ),
        ("ratio", Json::str(bps_ratio(row.ltv_bps)?)),
    ]))
}

/// `frozenCardItem`.
pub fn frozen_card_item(row: &FrozenCardRow) -> Json {
    // Only a freeze the bank made is out of the owner's hands; one with no recorded actor (before 0040) is theirs to lift.
    let by = row.frozen_by.as_deref();
    let by_bank = by == Some("operator");
    let mut fields = vec![
        (
            "id".to_owned(),
            Json::str(format!("card_frozen:{}", row.id)),
        ),
        ("kind".to_owned(), Json::str("card_frozen")),
        ("source".to_owned(), Json::str("bank")),
        (
            "severity".to_owned(),
            Json::str(if by_bank { "info" } else { "action" }),
        ),
        (
            "titleKey".to_owned(),
            Json::str(match by {
                Some("operator") => "bank.card.frozen_by_bank",
                Some("owner") => "bank.card.frozen_by_you",
                _ => "bank.card.frozen",
            }),
        ),
        ("link".to_owned(), Json::str("/bank/cards")),
    ];
    if let Some(who @ ("owner" | "operator")) = by {
        fields.push((
            "reasonCode".to_owned(),
            Json::str(format!("bank.card_frozen_by_{who}")),
        ));
    }
    Json::Object(fields)
}

/// `listBankWorkItems`: the person's bank items, margin calls soonest due first, then frozen cards.
pub fn list(c: &mut impl GenericClient, user_id: &str) -> Result<Json, Refusal> {
    // The newest open call of each open loan. A cured call has `cleared_at`; a repaid or liquidated loan is closed.
    let margins = c
        .query(
            "SELECT DISTINCT ON (l.id) \
                    l.id::text AS loan_id, l.status::text, l.collateral_asset_id, c.ltv_bps, c.cure_collateral_amount::text, \
                    floor(extract(epoch from c.grace_expires_at) * 1000)::int8 \
               FROM bank.loans l \
               JOIN bank.loan_margin_calls c ON c.loan_id = l.id AND c.cleared_at IS NULL \
              WHERE l.user_id = $1 AND l.status IN ('active', 'margin_call', 'liquidating') \
              ORDER BY l.id, c.sequence DESC",
            &[&user_id],
        )
        .map_err(|e| pg(&e))?
        .iter()
        .map(|r| {
            Ok(MarginRow {
                loan_id: r.try_get(0).map_err(|e| pg(&e))?,
                status: r.try_get(1).map_err(|e| pg(&e))?,
                collateral_asset_id: r.try_get(2).map_err(|e| pg(&e))?,
                ltv_bps: i64::from(r.try_get::<_, i32>(3).map_err(|e| pg(&e))?),
                cure_collateral_amount: r.try_get(4).map_err(|e| pg(&e))?,
                grace_expires_at: Instant(r.try_get(5).map_err(|e| pg(&e))?),
            })
        })
        .collect::<Result<Vec<MarginRow>, Refusal>>()?;
    let cards = c
        .query(
            "SELECT id::text, frozen_by FROM bank.cards WHERE user_id = $1 AND status = 'frozen' ORDER BY created_at, id",
            &[&user_id],
        )
        .map_err(|e| pg(&e))?
        .iter()
        .map(|r| {
            Ok(FrozenCardRow {
                id: r.try_get(0).map_err(|e| pg(&e))?,
                frozen_by: r.try_get(1).map_err(|e| pg(&e))?,
            })
        })
        .collect::<Result<Vec<FrozenCardRow>, Refusal>>()?;
    items(margins, &cards)
}

/// The answer from the rows: margin calls by when their grace ends (a stable sort, as `Array.prototype.sort`), then the
/// frozen cards in their own order, at most [`MAX_ITEMS`].
pub fn items(mut margins: Vec<MarginRow>, cards: &[FrozenCardRow]) -> Result<Json, Refusal> {
    margins.sort_by_key(|m| m.grace_expires_at.0);
    let mut out = margins
        .iter()
        .map(margin_item)
        .collect::<Result<Vec<Json>, Refusal>>()?;
    out.extend(cards.iter().map(frozen_card_item));
    out.truncate(MAX_ITEMS);
    Ok(Json::obj([("items", Json::Array(out))]))
}

/// This part's answer to one of its calls (`createWorkItemsRouter`).
pub fn answer(d: &Deps<'_>, ctx: &Ctx<'_>) -> Option<Result<Json, TrpcError>> {
    if ctx.call.path != "workItems.list" {
        return None;
    }
    let p = ctx.principal?;
    // An API key or a sub-account has no Home of its own, as identity's answer says too. Refused before the guard.
    let set = |v: &Option<String>| v.as_deref().is_some_and(|s| !s.is_empty());
    if set(&p.kid) || set(&p.sub_account) {
        return Some(Err(TrpcError::plain(
            "FORBIDDEN",
            "Sign in on this device to see what needs you [bank.work_items_delegated]",
        )));
    }
    Some(with(d.store(), |c| list(c, &p.user_id)).map_err(|r| {
        to_trpc(r, || {
            service_kit::approvals::random_uuid().unwrap_or_default()
        })
    }))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test")]

    use super::*;

    #[test]
    fn basis_points_read_as_the_contracts_ratio() {
        assert_eq!(
            [0, 1, 7500, 7812, 10_000, 12_345]
                .map(|b| bps_ratio(b).unwrap())
                .to_vec(),
            ["0", "0.0001", "0.75", "0.7812", "1", "1.2345"]
        );
        assert!(bps_ratio(-1).is_err());
    }
}
