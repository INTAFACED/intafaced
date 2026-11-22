//! `earn/interest.ts`: pure arithmetic, no I/O. Every rounding is down, in the reserve's favour: a unit invented by
//! rounding up would have to come out of a pool reserve funded for a smaller number.

use std::collections::BTreeMap;

use service_kit::money::{Amount, Rounding, mul_div};
use service_kit::time::Instant;

/// `DAYS_PER_YEAR`: simple daily accrual.
pub const DAYS_PER_YEAR: i64 = 365;

const SCALE: Amount = 1_000_000_000_000_000_000;

/// One UTC day in milliseconds.
pub const DAY_MS: i64 = 24 * 60 * 60 * 1000;

/// `dailyInterest(principal, aprBps, daysPerYear)`: one day of simple interest, `mulBps(.., 'floor')` then
/// `div(.., parseAmount(daysPerYear), 'floor')`. `None` is the TypeScript's `RangeError` for a rate that is not a
/// non-negative whole number.
pub fn daily_interest(principal: Amount, apr_bps: i64, days_per_year: i64) -> Option<Amount> {
    if principal <= 0 {
        return Some(0);
    }
    if apr_bps < 0 {
        return None;
    }
    if apr_bps == 0 {
        return Some(0);
    }
    let annual = mul_div(principal, Amount::from(apr_bps), 10_000, Rounding::Floor);
    Some(mul_div(
        annual,
        SCALE,
        Amount::from(days_per_year) * SCALE,
        Rounding::Floor,
    ))
}

/// `AccruingPosition`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Accruing {
    pub position_id: String,
    pub user_id: String,
    pub principal: Amount,
}

/// One payout of a day's plan: one per person, never per saving.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Payout {
    pub user_id: String,
    pub amount: Amount,
}

/// `AccrualPlan`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plan {
    pub payouts: Vec<Payout>,
    pub total: Amount,
    /// Savings whose day rounded to nothing: counted, not dropped silently.
    pub dust: usize,
}

/// `planAccrual`: interest per person, in user id order (JavaScript's string order: UTF-16 code units), dust skipped.
pub fn plan_accrual(positions: &[Accruing], apr_bps: i64, days_per_year: i64) -> Option<Plan> {
    let mut per_user: BTreeMap<Vec<u16>, (String, Amount)> = BTreeMap::new();
    let mut dust = 0;
    for p in positions {
        let interest = daily_interest(p.principal, apr_bps, days_per_year)?;
        if interest <= 0 {
            dust += 1;
            continue;
        }
        let slot = per_user
            .entry(p.user_id.encode_utf16().collect())
            .or_insert_with(|| (p.user_id.clone(), 0));
        slot.1 += interest;
    }
    let payouts: Vec<Payout> = per_user
        .into_values()
        .map(|(user_id, amount)| Payout { user_id, amount })
        .collect();
    let total = payouts.iter().map(|p| p.amount).sum();
    Some(Plan {
        payouts,
        total,
        dust,
    })
}

/// `accrualDate`: `YYYY-MM-DD` in UTC, the accrual day and half of its key.
pub fn accrual_date(at: Instant) -> String {
    at.iso()[..10].to_owned()
}

/// `accrualBoundary`: the start of the UTC accrual day.
pub fn accrual_boundary(at: Instant) -> Instant {
    Instant(at.0.div_euclid(DAY_MS) * DAY_MS)
}

/// `Date.parse('<day>T00:00:00Z')` for a `YYYY-MM-DD` day.
pub fn day_start(day: &str) -> Option<Instant> {
    service_kit::time::js_date(&format!("{day}T00:00:00Z"))
}

#[cfg(test)]
mod tests {
    //! `interest.test.ts`'s arithmetic.
    #![allow(clippy::unwrap_used, reason = "a test")]
    use super::*;
    use service_kit::money::parse_amount;

    fn a(s: &str) -> Amount {
        parse_amount(s).unwrap()
    }

    #[test]
    fn a_day_of_interest_rounds_down_in_the_reserves_favour() {
        // 1000 at 5% a year: 50 a year, 0.136986301369863013 a day (floored).
        assert_eq!(
            daily_interest(a("1000"), 500, DAYS_PER_YEAR),
            Some(a("0.136986301369863013"))
        );
        assert_eq!(daily_interest(a("1000"), 0, DAYS_PER_YEAR), Some(0));
        assert_eq!(daily_interest(0, 500, DAYS_PER_YEAR), Some(0));
        assert_eq!(daily_interest(a("1000"), -1, DAYS_PER_YEAR), None);
        // The smallest unit at a small rate earns nothing.
        assert_eq!(daily_interest(1, 1, DAYS_PER_YEAR), Some(0));
    }

    #[test]
    fn a_plan_pays_each_person_once_in_id_order_and_counts_dust() {
        let p = |id: &str, user: &str, amount: &str| Accruing {
            position_id: id.to_owned(),
            user_id: user.to_owned(),
            principal: a(amount),
        };
        let plan = plan_accrual(
            &[
                p("1", "u-b", "365"),
                p("2", "u-a", "365"),
                p("3", "u-b", "365"),
                p("4", "u-c", "0.000000000000000001"),
            ],
            10_000,
            DAYS_PER_YEAR,
        )
        .unwrap();
        assert_eq!(
            plan.payouts,
            vec![
                Payout {
                    user_id: "u-a".to_owned(),
                    amount: a("1")
                },
                Payout {
                    user_id: "u-b".to_owned(),
                    amount: a("2")
                },
            ]
        );
        assert_eq!((plan.total, plan.dust), (a("3"), 1));
    }

    #[test]
    fn the_day_and_its_boundary_are_utc() {
        let at = service_kit::time::js_date("2026-03-04T23:59:59.999Z").unwrap();
        assert_eq!(accrual_date(at), "2026-03-04");
        assert_eq!(accrual_boundary(at).iso(), "2026-03-04T00:00:00.000Z");
        assert_eq!(day_start("2026-03-04"), Some(accrual_boundary(at)));
    }
}
