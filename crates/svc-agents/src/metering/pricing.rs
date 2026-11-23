//! Cost, exactly (`services/svc-agents/src/metering/pricing.ts`).
//!
//! Everything here is integer arithmetic on `Amount` (scaled i128, 18 decimals, the ledger's representation). A rate is
//! "X per million tokens", so a cost is `rate × tokens ÷ 1,000,000`, rounded up once per (window, rate): token counts
//! are summed exactly first, so a chatty agent accrues no per-call rounding. `usage_records` stores counts and the
//! rate in force, never a cost; [`window_cost`] is what settlement bills.

use std::collections::BTreeMap;

use service_kit::money::Amount;
use service_kit::time::Instant;

/// `TOKENS_PER_PRICE_UNIT`: a price is per million tokens.
pub const TOKENS_PER_PRICE_UNIT: Amount = 1_000_000;

/// A rate per million tokens, input and output.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ModelPrice {
    pub input_per_million: Amount,
    pub output_per_million: Amount,
}

/// One rate's worth of a window: exact token totals and the rate they were quoted at.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UsageGroup {
    pub input_tokens: Amount,
    pub output_tokens: Amount,
    pub price: ModelPrice,
}

/// `PricingError`: a negative count or price is refused, never priced.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PricingError(pub String);

/// `tokenCost`: `tokens × pricePerMillion ÷ 1,000,000`, rounded up, once.
pub fn token_cost(tokens: Amount, price_per_million: Amount) -> Result<Amount, PricingError> {
    if tokens < 0 {
        return Err(PricingError(format!(
            "Token count must not be negative, got {tokens}"
        )));
    }
    if price_per_million < 0 {
        return Err(PricingError(format!(
            "Price must not be negative, got {}",
            service_kit::money::format_amount(price_per_million)
        )));
    }
    let numerator = tokens
        .checked_mul(price_per_million)
        .ok_or_else(|| PricingError("Token cost overflows".to_owned()))?;
    let quotient = numerator / TOKENS_PER_PRICE_UNIT;
    Ok(if numerator % TOKENS_PER_PRICE_UNIT == 0 {
        quotient
    } else {
        quotient + 1
    })
}

/// `windowCost`: groups at the same rate merged first (the bill never depends on row grouping), each rate rounded once.
pub fn window_cost(groups: &[UsageGroup]) -> Result<Amount, PricingError> {
    let mut merged: BTreeMap<(Amount, Amount), (Amount, Amount)> = BTreeMap::new();
    for g in groups {
        let e = merged
            .entry((g.price.input_per_million, g.price.output_per_million))
            .or_insert((0, 0));
        e.0 += g.input_tokens;
        e.1 += g.output_tokens;
    }
    let mut total: Amount = 0;
    for ((input_price, output_price), (input, output)) in merged {
        total += token_cost(input, input_price)?;
        total += token_cost(output, output_price)?;
    }
    Ok(total)
}

/// `windowIdFor`: the UTC window a moment belongs to, `YYYY-MM-DD#NNNN`. The length must divide a day.
pub fn window_id_for(at: Instant, window_minutes: i64) -> Result<String, PricingError> {
    if window_minutes < 1 || (24 * 60) % window_minutes != 0 {
        return Err(PricingError(format!(
            "Usage window must be a whole number of minutes dividing 1440, got {window_minutes}"
        )));
    }
    let ms_into_day = at.0.rem_euclid(86_400_000);
    let minutes_into_day = ms_into_day / 60_000;
    let slot = minutes_into_day / window_minutes;
    let day = at.iso().get(0..10).unwrap_or_default().to_owned();
    Ok(format!("{day}#{slot:04}"))
}

/// `chargeKeyFor`: the ledger charge key a window is billed under.
pub fn charge_key_for(session_id: &str, window_id: &str) -> String {
    format!("agent.usage:{session_id}:{window_id}")
}

#[cfg(test)]
mod tests {
    //! `pricing.test.ts`, case for case, with its values. Two differ by type: a fractional count cannot be written (a
    //! count is an integer), and `usageCost` (one call's cost, which the runtime reads) is a window of one group here.
    #![allow(clippy::unwrap_used, reason = "a test")]
    use super::*;
    use service_kit::money::{format_amount, parse_amount};

    fn a(s: &str) -> Amount {
        parse_amount(s).unwrap()
    }

    fn price(i: &str, o: &str) -> ModelPrice {
        ModelPrice {
            input_per_million: a(i),
            output_per_million: a(o),
        }
    }

    fn group(input_tokens: Amount, output_tokens: Amount, price: ModelPrice) -> UsageGroup {
        UsageGroup {
            input_tokens,
            output_tokens,
            price,
        }
    }

    fn at(iso: &str) -> Instant {
        service_kit::time::js_date(iso).unwrap()
    }

    const DUST: &str = "0.000000000000000001";

    #[test]
    fn prices_a_round_million_exactly() {
        assert_eq!(format_amount(token_cost(1_000_000, a("3")).unwrap()), "3");
        assert_eq!(format_amount(token_cost(2_500_000, a("3")).unwrap()), "7.5");
    }

    #[test]
    fn prices_a_fraction_of_a_million_without_touching_a_float() {
        assert_eq!(format_amount(token_cost(1234, a("3")).unwrap()), "0.003702");
    }

    #[test]
    fn is_free_when_the_rate_is_zero() {
        assert_eq!(token_cost(999_999, a("0")).unwrap(), 0);
    }

    #[test]
    fn is_free_when_nothing_was_used() {
        assert_eq!(token_cost(0, a("15")).unwrap(), 0);
    }

    #[test]
    fn rounds_up_so_a_non_zero_usage_is_never_free() {
        assert_eq!(token_cost(1, a(DUST)).unwrap(), 1);
        assert_eq!(format_amount(token_cost(1, a(DUST)).unwrap()), DUST);
    }

    #[test]
    fn accepts_counts_past_a_double() {
        assert_eq!(
            format_amount(token_cost(10_000_000_000, a("1")).unwrap()),
            "10000"
        );
    }

    #[test]
    fn refuses_a_negative_count_or_rate_rather_than_pricing_it() {
        assert!(token_cost(-1, a("1")).is_err());
        assert!(token_cost(1, -1).is_err());
    }

    #[test]
    fn charges_input_and_output_at_their_own_rates() {
        let cost = window_cost(&[group(1_000_000, 1_000_000, price("3", "15"))]).unwrap();
        assert_eq!(format_amount(cost), "18");
    }

    #[test]
    fn charges_nothing_for_a_call_that_produced_nothing() {
        assert_eq!(window_cost(&[group(0, 0, price("3", "15"))]).unwrap(), 0);
    }

    #[test]
    fn sums_exact_token_counts_and_rounds_once_not_once_per_call() {
        let dust = price(DUST, "0");
        let per_call = window_cost(&[group(1, 0, dust)]).unwrap() * 3;
        let per_window = window_cost(&[group(3, 0, dust)]).unwrap();
        assert_eq!(format_amount(per_call), "0.000000000000000003");
        assert_eq!(format_amount(per_window), DUST);
        assert!(per_window < per_call);
    }

    #[test]
    fn merges_groups_at_the_same_rate_so_the_bill_does_not_depend_on_row_grouping() {
        let rate = price(DUST, "0");
        let split =
            window_cost(&[group(1, 0, rate), group(1, 0, rate), group(1, 0, rate)]).unwrap();
        let whole = window_cost(&[group(3, 0, rate)]).unwrap();
        assert_eq!(split, whole);
    }

    #[test]
    fn keeps_different_rates_apart() {
        let cost = window_cost(&[
            group(1_000_000, 0, price("3", "15")),
            group(1_000_000, 0, price("1", "5")),
        ])
        .unwrap();
        assert_eq!(format_amount(cost), "4");
    }

    #[test]
    fn is_zero_for_a_window_with_no_usage() {
        assert_eq!(window_cost(&[]).unwrap(), 0);
    }

    #[test]
    fn is_deterministic_and_utc() {
        assert_eq!(
            window_id_for(at("2026-07-27T13:45:00.000Z"), 60).unwrap(),
            "2026-07-27#0013"
        );
        assert_eq!(
            window_id_for(at("2026-07-27T13:45:00.000Z"), 60).unwrap(),
            window_id_for(at("2026-07-27T13:45:59.000Z"), 60).unwrap()
        );
    }

    #[test]
    fn starts_a_new_window_at_the_boundary() {
        assert_eq!(
            window_id_for(at("2026-07-27T13:59:59.999Z"), 60).unwrap(),
            "2026-07-27#0013"
        );
        assert_eq!(
            window_id_for(at("2026-07-27T14:00:00.000Z"), 60).unwrap(),
            "2026-07-27#0014"
        );
    }

    #[test]
    fn never_straddles_midnight() {
        assert_eq!(
            window_id_for(at("2026-07-27T23:59:59.999Z"), 15).unwrap(),
            "2026-07-27#0095"
        );
        assert_eq!(
            window_id_for(at("2026-07-28T00:00:00.000Z"), 15).unwrap(),
            "2026-07-28#0000"
        );
    }

    #[test]
    fn refuses_a_window_length_that_does_not_divide_a_day() {
        assert!(window_id_for(at("2026-07-28T00:00:00.000Z"), 7).is_err());
        assert!(window_id_for(at("2026-07-28T00:00:00.000Z"), 0).is_err());
    }
}
