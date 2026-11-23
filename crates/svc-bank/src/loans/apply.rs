//! `loans/loan-apply.ts`: BK-loan-01, J-bank-09 #2 and #3, the arithmetic behind the loan application's calculator
//! and its fee line. Pure, so the quote and `open` are held to the same rounding: debt valued up, collateral valued
//! down. Every input here is non-negative where it is used (a quantity, a price, a principal); for those the
//! TypeScript's `(x + d - 1n) / d` is exactly the ceiling this takes.

use service_kit::money::{Amount, Rounding, mul_div, mul_rounded};

use super::risk::{Round, ltv_bps};

const ONE: Amount = Amount::whole(1);
/// Basis points in a whole: a count, not money.
const BPS: i128 = 10_000;

/// `quoteValue`: `quantity` at `price` in the quote asset, debt rounded up, collateral down. The one rounding `open`
/// and the quote share.
pub fn quote_value(quantity: Amount, price: Amount, rounding: Round) -> Amount {
    mul_rounded(quantity, price, rounding.kit())
}

/// Collateral `quantity` at `price` in the quote asset, rounded down: the value `open` gives a pledge.
fn collateral_value(quantity: Amount, price: Amount) -> Amount {
    quote_value(quantity, price, Round::Floor)
}

/// `minimumCollateral`: the smallest pledge whose opening LTV is within `max_ltv_bps` when the debt is worth
/// `debt_value`, by the same test `open` runs (`ltv(debt, floor(c × price)) <= cap`), searched exactly: this amount
/// opens and one unit less does not. LTV only falls as collateral rises, so the search is monotone. The error is the
/// TypeScript's `RangeError` message.
pub fn minimum_collateral(
    debt_value: Amount,
    collateral_price: Amount,
    max_ltv_bps: i64,
) -> Result<Amount, String> {
    if debt_value <= Amount::ZERO || collateral_price <= Amount::ZERO || max_ltv_bps <= 0 {
        return Err("minimumCollateral needs a positive debt value, price and LTV cap".to_owned());
    }
    let fits = |c: Amount| {
        ltv_bps(debt_value, collateral_value(c, collateral_price)).is_ok_and(|l| l <= max_ltv_bps)
    };
    // The closed-form estimate, then grown until it fits: a starting point, never the answer.
    // ceil(debt·BPS·ONE / (cap·price)) = ceil(ceil(debt·BPS·ONE / price) / cap) for positive integers.
    let per_price = mul_div(debt_value, BPS * ONE, collateral_price, Rounding::Ceil);
    // `per_price / cap`, rounded up: the cap is a count of basis points, carried here as a scaled divisor.
    let mut hi = mul_div(
        per_price,
        Amount::UNIT,
        Amount::from_scaled(i128::from(max_ltv_bps)),
        Rounding::Ceil,
    )
    .saturating_add(Amount::UNIT);
    while !fits(hi) {
        match hi.checked_times(2) {
            Some(next) => hi = next,
            // Past an i128 the pledge cannot be held anywhere; the largest is the answer the search can give.
            None => {
                hi = Amount::MAX;
                break;
            }
        }
    }
    let mut lo: Amount = Amount::from_scaled(1);
    while lo < hi {
        let mid = lo + (hi - lo) / 2;
        if fits(mid) {
            hi = mid;
        } else {
            lo = mid + Amount::from_scaled(1);
        }
    }
    Ok(lo)
}

/// `liquidationPrice`: the collateral price, in the quote asset, at which a loan worth `debt_value` against
/// `collateral` reaches `liquidation_ltv_bps`. Rounded up, so the figure shown is never below the price that would
/// start a liquidation. A zero collateral or threshold is bigint's `RangeError: Division by zero`.
pub fn liquidation_price(
    debt_value: Amount,
    collateral: Amount,
    liquidation_ltv_bps: i64,
) -> Result<Amount, String> {
    if collateral == Amount::ZERO || liquidation_ltv_bps == 0 {
        return Err("Division by zero".to_owned());
    }
    // ceil(debt·BPS·ONE / (ltv·collateral)), taken as ceil(ceil(debt·BPS·ONE / collateral) / ltv).
    let per_collateral = mul_div(debt_value, BPS * ONE, collateral, Rounding::Ceil);
    Ok(mul_div(
        per_collateral,
        Amount::UNIT,
        Amount::from_scaled(i128::from(liquidation_ltv_bps)),
        Rounding::Ceil,
    ))
}

/// `OriginationFee`: the owner's origination fee (`BANK_LOAN_ORIGINATION_FEE_BPS`), whole basis points 0 to 10000, or
/// not set.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OriginationFee {
    NotSet,
    Published { bps: i64 },
}

/// `originationFee`: blank, unset or not a whole number in range is not set; nothing is assumed, and no fee line is
/// drawn.
pub fn origination_fee(raw: Option<&str>) -> OriginationFee {
    let text = service_kit::money::js_trim(raw.unwrap_or(""));
    if text.is_empty() || text.len() > 5 || !text.bytes().all(|b| b.is_ascii_digit()) {
        return OriginationFee::NotSet;
    }
    match text.parse::<i64>() {
        Ok(bps) if bps <= 10_000 => OriginationFee::Published { bps },
        _ => OriginationFee::NotSet,
    }
}

/// `originationFeeOn`: the fee on `principal` at `bps`, rounded up in the debt asset.
pub fn origination_fee_on(principal: Amount, bps: i64) -> Amount {
    // `principal * bps / BPS`: both factors past the principal are counts of basis points.
    mul_div(
        principal,
        Amount::from_scaled(i128::from(bps)),
        Amount::from_scaled(BPS),
        Rounding::Ceil,
    )
}

#[cfg(test)]
mod tests {
    //! `loan-apply.test.ts`' arithmetic.
    use super::*;
    use crate::loans::risk::DEFAULT_LIQUIDATION_POLICY;
    use service_kit::money::parse_amount;

    fn amt(s: &str) -> Amount {
        parse_amount(s).unwrap()
    }

    fn opens_at(debt_value: Amount, collateral: Amount, price: Amount, cap: i64) -> bool {
        ltv_bps(debt_value, mul_rounded(collateral, price, Rounding::Floor)).unwrap() <= cap
    }

    #[test]
    fn minimum_collateral_is_the_smallest_pledge_the_opening_check_accepts() {
        for (debt, price, cap) in [
            ("1000", "60000", 5_000),
            ("1000", "60000", 3_333),
            ("0.000001", "61234.56789", 5_000),
            ("250000", "0.0001", 9_000),
            ("7", "3", 1),
        ] {
            let (d, p) = (amt(debt), amt(price));
            let c = minimum_collateral(d, p, cap).unwrap();
            assert!(opens_at(d, c, p, cap), "{debt} {price} {cap}");
            assert!(
                !opens_at(d, c - Amount::from_scaled(1), p, cap),
                "{debt} {price} {cap}"
            );
        }
    }

    #[test]
    fn minimum_collateral_refuses_a_zero_debt_price_or_cap() {
        let msg = "minimumCollateral needs a positive debt value, price and LTV cap";
        assert_eq!(
            minimum_collateral(Amount::ZERO, ONE, 5_000).unwrap_err(),
            msg
        );
        assert_eq!(
            minimum_collateral(ONE, Amount::ZERO, 5_000).unwrap_err(),
            msg
        );
        assert_eq!(minimum_collateral(ONE, ONE, 0).unwrap_err(), msg);
    }

    #[test]
    fn the_quote_for_1000_usdt_against_btc_at_60000() {
        // `loans.quote`'s figures: the exact pledge, its LTV and the liquidation price.
        let debt_value = quote_value(amt("1000"), ONE, Round::Ceil);
        let required = minimum_collateral(debt_value, amt("60000"), 5_000).unwrap();
        assert_eq!(required, Amount::from_scaled(33_333_333_333_333_334));
        assert_eq!(
            ltv_bps(
                debt_value,
                quote_value(required, amt("60000"), Round::Floor)
            )
            .unwrap(),
            5_000
        );
        assert_eq!(
            liquidation_price(
                amt("1000"),
                required,
                DEFAULT_LIQUIDATION_POLICY.liquidation_ltv_bps
            )
            .unwrap(),
            Amount::from_scaled(35_294_117_647_058_822_823_530)
        );
        assert_eq!(
            liquidation_price(Amount::from_scaled(1), Amount::ZERO, 8_500).unwrap_err(),
            "Division by zero"
        );
    }

    #[test]
    fn the_origination_fee() {
        for raw in [
            None,
            Some(""),
            Some("   "),
            Some("abc"),
            Some("1.5"),
            Some("-1"),
            Some("10001"),
        ] {
            assert_eq!(origination_fee(raw), OriginationFee::NotSet, "{raw:?}");
        }
        assert_eq!(
            origination_fee(Some("0")),
            OriginationFee::Published { bps: 0 }
        );
        assert_eq!(
            origination_fee(Some(" 50 ")),
            OriginationFee::Published { bps: 50 }
        );
        assert_eq!(origination_fee_on(amt("1000"), 50), amt("5"));
        assert_eq!(
            origination_fee_on(Amount::from_scaled(1), 1),
            Amount::from_scaled(1)
        );
    }
}
