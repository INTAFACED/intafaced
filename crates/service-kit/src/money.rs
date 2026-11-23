//! The ledger client's money arithmetic (`packages/ledger-client/src/money.ts`) on `Amount` (18 places in an i128).
//! Read-side only: a service formats, parses and divides amounts here; it never posts (money moves only through the
//! ledger client's recipes).
//!
//! JavaScript's bigint has no width, so a product of two amounts (a price times a quantity, a cost times a share) is exact
//! there before it is divided back down. Here every such product is formed in 256 bits and divided there, so the quotient
//! is the same as the TypeScript's whenever it fits an i128 (any amount that fits `numeric(38,18)` does). A quotient past
//! i128 saturates rather than wrapping or stopping the process.

use std::cmp::Ordering;

/// Money is a scaled integer: 18 decimal places (`packages/ledger-client/src/money.ts`).
///
/// A newtype, not an alias, so a count, a raw integer or a price at another scale is a compile error where money is
/// expected. It carries only what money does: add, subtract, negate, compare, sum, and multiply or divide by a plain
/// count. Two amounts multiply or divide only through `mul`, `mul_rounded`, `mul_div` and `share`, which hold the
/// 18-place scale. A raw scaled integer comes in through `Amount::from_scaled` and leaves through `Amount::scaled`,
/// named at the line that does it.
///
/// A count passed as money does not compile (the mistake the alias let through):
///
/// ```compile_fail
/// fn fee(_: service_kit::money::Amount) {}
/// let tokens: i128 = 1_000;
/// fee(tokens);
/// ```
///
/// Nor does a product of two amounts, which would carry 36 places, not 18:
///
/// ```compile_fail
/// use service_kit::money::Amount;
/// let _ = Amount::whole(2) * Amount::whole(3);
/// ```
///
/// Through `mul` it keeps the scale:
///
/// ```
/// use service_kit::money::{Amount, mul};
/// assert_eq!(mul(Amount::whole(2), Amount::whole(3)), Amount::whole(6));
/// ```
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default)]
pub struct Amount(i128);

impl Amount {
    /// Nothing.
    pub const ZERO: Amount = Amount(0);
    /// One whole unit: `1` at 18 places.
    pub const ONE: Amount = Amount(SCALE_I128);
    /// The smallest step: `0.000000000000000001`.
    pub const UNIT: Amount = Amount(1);
    /// The largest amount an i128 holds (a saturated result).
    pub const MAX: Amount = Amount(i128::MAX);
    /// The smallest amount an i128 holds (a saturated result).
    pub const MIN: Amount = Amount(i128::MIN);

    /// An amount from its scaled integer (`1` is `0.000000000000000001`).
    pub const fn from_scaled(scaled: i128) -> Amount {
        Amount(scaled)
    }

    /// The scaled integer (`0.000000000000000001` is `1`).
    pub const fn scaled(self) -> i128 {
        self.0
    }

    /// `whole` whole units: `Amount::whole(5)` is `5`.
    pub const fn whole(whole: i128) -> Amount {
        Amount(whole * SCALE_I128)
    }

    pub const fn is_zero(self) -> bool {
        self.0 == 0
    }

    pub const fn is_negative(self) -> bool {
        self.0 < 0
    }

    pub const fn is_positive(self) -> bool {
        self.0 > 0
    }

    pub const fn abs(self) -> Amount {
        Amount(self.0.abs())
    }

    /// `-1`, `0` or `1`.
    pub const fn signum(self) -> i128 {
        self.0.signum()
    }

    pub fn checked_add(self, other: Amount) -> Option<Amount> {
        self.0.checked_add(other.0).map(Amount)
    }

    pub fn checked_sub(self, other: Amount) -> Option<Amount> {
        self.0.checked_sub(other.0).map(Amount)
    }

    pub fn saturating_add(self, other: Amount) -> Amount {
        Amount(self.0.saturating_add(other.0))
    }

    pub fn saturating_sub(self, other: Amount) -> Amount {
        Amount(self.0.saturating_sub(other.0))
    }

    /// `|self|`, `None` for `Amount::MIN`.
    pub fn checked_abs(self) -> Option<Amount> {
        self.0.checked_abs().map(Amount)
    }

    /// `|self|`, `Amount::MAX` for `Amount::MIN`.
    pub fn saturating_abs(self) -> Amount {
        Amount(self.0.saturating_abs())
    }

    /// `self * count`, `None` past i128.
    pub fn checked_times(self, count: i128) -> Option<Amount> {
        self.0.checked_mul(count).map(Amount)
    }

    /// `self * count`, saturating past i128.
    pub fn saturating_times(self, count: i128) -> Amount {
        Amount(self.0.saturating_mul(count))
    }

    /// `self / count`, `None` for a zero count.
    pub fn checked_div_count(self, count: i128) -> Option<Amount> {
        self.0.checked_div(count).map(Amount)
    }

    /// `self % count` on the scaled integer.
    pub fn rem_count(self, count: i128) -> Amount {
        Amount(self.0 % count)
    }
}

impl std::ops::Add for Amount {
    type Output = Amount;
    fn add(self, other: Amount) -> Amount {
        Amount(self.0 + other.0)
    }
}

impl std::ops::Sub for Amount {
    type Output = Amount;
    fn sub(self, other: Amount) -> Amount {
        Amount(self.0 - other.0)
    }
}

impl std::ops::Neg for Amount {
    type Output = Amount;
    fn neg(self) -> Amount {
        Amount(-self.0)
    }
}

impl std::ops::AddAssign for Amount {
    fn add_assign(&mut self, other: Amount) {
        self.0 += other.0;
    }
}

impl std::ops::SubAssign for Amount {
    fn sub_assign(&mut self, other: Amount) {
        self.0 -= other.0;
    }
}

/// An amount times a plain count (a number of units, seats, days) is still money at the same scale.
impl std::ops::Mul<i128> for Amount {
    type Output = Amount;
    fn mul(self, count: i128) -> Amount {
        Amount(self.0 * count)
    }
}

/// An amount split by a plain count, toward zero as bigint `/` is.
impl std::ops::Div<i128> for Amount {
    type Output = Amount;
    fn div(self, count: i128) -> Amount {
        Amount(self.0 / count)
    }
}

/// What is left of an amount after whole steps of another (a price off its tick).
impl std::ops::Rem for Amount {
    type Output = Amount;
    fn rem(self, step: Amount) -> Amount {
        Amount(self.0 % step.0)
    }
}

/// A plain count times an amount: `3 * price`.
impl std::ops::Mul<Amount> for i128 {
    type Output = Amount;
    fn mul(self, amount: Amount) -> Amount {
        Amount(self * amount.0)
    }
}

impl std::iter::Sum for Amount {
    fn sum<I: Iterator<Item = Amount>>(iter: I) -> Amount {
        iter.fold(Amount::ZERO, |a, b| a + b)
    }
}

impl<'a> std::iter::Sum<&'a Amount> for Amount {
    fn sum<I: Iterator<Item = &'a Amount>>(iter: I) -> Amount {
        iter.fold(Amount::ZERO, |a, b| a + *b)
    }
}

const SCALE_I128: i128 = 1_000_000_000_000_000_000;

const DECIMALS: usize = 18;
const SCALE: u128 = 1_000_000_000_000_000_000;
/// `MAX_AMOUNT`: `10n ** 38n - 1n`, what `numeric(38,18)` holds.
pub const MAX_AMOUNT: Amount = Amount(99_999_999_999_999_999_999_999_999_999_999_999_999);

/// `formatAmount`: the shortest decimal string, no trailing zeros.
pub fn format_amount(value: Amount) -> String {
    let sign = if value.0 < 0 { "-" } else { "" };
    let abs = value.0.unsigned_abs();
    let (whole, frac) = (abs / SCALE, abs % SCALE);
    if frac == 0 {
        return format!("{sign}{whole}");
    }
    let digits = format!("{frac:0DECIMALS$}");
    format!("{sign}{whole}.{}", digits.trim_end_matches('0'))
}

/// `formatAmount(a - b)`, exact: two amounts inside `numeric(38,18)` differ by at most twice its largest,
/// which `i128` may not hold but `u128` does, so the difference is never clamped.
pub fn format_difference(a: Amount, b: Amount) -> String {
    if let Some(d) = a.checked_sub(b) {
        return format_amount(d);
    }
    // Only opposite signs overflow, so the magnitude is the two magnitudes summed.
    let magnitude = a.0.unsigned_abs() + b.0.unsigned_abs();
    let sign = if a < b { "-" } else { "" };
    let (whole, frac) = (magnitude / SCALE, magnitude % SCALE);
    if frac == 0 {
        return format!("{sign}{whole}");
    }
    let digits = format!("{frac:0DECIMALS$}");
    format!("{sign}{whole}.{}", digits.trim_end_matches('0'))
}

/// How a division that does not come out even is rounded (`Rounding`). `Trunc` is bigint `/`: toward zero.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Rounding {
    Trunc,
    HalfUp,
    Ceil,
    Floor,
}

/// An unsigned 256-bit number as (high, low) halves.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct U256(u128, u128);

fn mul_wide(a: u128, b: u128) -> U256 {
    const MASK: u128 = u64::MAX as u128;
    let (a1, a0) = (a >> 64, a & MASK);
    let (b1, b0) = (b >> 64, b & MASK);
    let p00 = a0 * b0;
    let p01 = a0 * b1;
    let p10 = a1 * b0;
    let p11 = a1 * b1;
    let mid = (p00 >> 64) + (p01 & MASK) + (p10 & MASK);
    let lo = (p00 & MASK) | (mid << 64);
    let hi = p11 + (p01 >> 64) + (p10 >> 64) + (mid >> 64);
    U256(hi, lo)
}

/// Long division of a 256-bit number by a nonzero u128: (quotient, remainder).
fn div_wide(n: U256, d: u128) -> (U256, u128) {
    if n.0 == 0 {
        return (U256(0, n.1 / d), n.1 % d);
    }
    let mut q = U256(0, 0);
    let mut r: u128 = 0;
    for i in (0..256).rev() {
        let bit = if i >= 128 {
            (n.0 >> (i - 128)) & 1
        } else {
            (n.1 >> i) & 1
        };
        // r = r * 2 + bit, kept below d (r < d <= u128::MAX, so a carry out means r >= d).
        let carry = r >> 127;
        r = (r << 1) | bit;
        if carry == 1 || r >= d {
            r = r.wrapping_sub(d);
            if i >= 128 {
                q.0 |= 1 << (i - 128);
            } else {
                q.1 |= 1 << i;
            }
        }
    }
    (q, r)
}

fn saturate(negative: bool, q: U256) -> i128 {
    let fits = q.0 == 0 && q.1 <= i128::MAX.unsigned_abs();
    match (fits, negative) {
        (true, false) => i128::try_from(q.1).unwrap_or(i128::MAX),
        (true, true) => 0i128.saturating_sub_unsigned(q.1),
        (false, false) => i128::MAX,
        (false, true) => i128::MIN,
    }
}

/// `a * b / d` on raw integers, formed in 256 bits and rounded as `divideScaled` rounds; 0 for a zero `d`.
fn wide_mul_div(a: i128, b: i128, d: i128, rounding: Rounding) -> i128 {
    if d == 0 {
        return 0;
    }
    let negative = ((a < 0) != (b < 0)) != (d < 0) && a != 0 && b != 0;
    let n = mul_wide(a.unsigned_abs(), b.unsigned_abs());
    let (mut q, r) = div_wide(n, d.unsigned_abs());
    if r != 0 {
        let up = match rounding {
            Rounding::Trunc => false,
            Rounding::Ceil => !negative,
            Rounding::Floor => negative,
            // r * 2 >= d, without overflow.
            Rounding::HalfUp => r >= d.unsigned_abs() - r,
        };
        if up {
            let (lo, carry) = q.1.overflowing_add(1);
            q = U256(q.0.saturating_add(u128::from(carry)), lo);
        }
    }
    saturate(negative, q)
}

/// `a * b / d` on three amounts, rounded as `divideScaled` rounds (a zero `d` gives 0; no caller divides by zero).
/// A plain count in any place takes `mul_ratio`, `ratio_of` or `mul_div_count`, never an amount made with
/// `from_scaled` (`crates/service-kit/tests/counts_as_money.rs`).
pub fn mul_div(a: Amount, b: Amount, d: Amount, rounding: Rounding) -> Amount {
    Amount(wide_mul_div(a.0, b.0, d.0, rounding))
}

/// `amount * num / den`, where `num` and `den` are plain counts: a rate in basis points over 10,000, or one over a
/// cap in basis points. Still money at the same scale; a zero `den` gives 0.
pub fn mul_ratio(amount: Amount, num: i128, den: i128, rounding: Rounding) -> Amount {
    Amount(wide_mul_div(amount.0, num, den, rounding))
}

/// `a / b` as a plain count of `1/per` steps: `ratio_of(debt, collateral, 10_000, Ceil)` is the loan-to-value in
/// basis points. Saturates past i128; a zero `b` gives 0.
pub fn ratio_of(a: Amount, b: Amount, per: i128, rounding: Rounding) -> i128 {
    wide_mul_div(a.0, per, b.0, rounding)
}

/// `a * b / d` on plain integers (counts, or fractions at a scale that is not money), formed in 256 bits so the
/// product never overflows; saturates past i128, and a zero `d` gives 0.
pub fn mul_div_count(a: i128, b: i128, d: i128, rounding: Rounding) -> i128 {
    wide_mul_div(a, b, d, rounding)
}

/// `mul(a, b)`: two scaled amounts multiplied (half-up unless stated).
pub fn mul(a: Amount, b: Amount) -> Amount {
    mul_div(a, b, SCALE_AMOUNT, Rounding::HalfUp)
}

/// `mul(a, b, rounding)`.
pub fn mul_rounded(a: Amount, b: Amount, rounding: Rounding) -> Amount {
    mul_div(a, b, SCALE_AMOUNT, rounding)
}

const SCALE_AMOUNT: Amount = Amount::ONE;

/// `total * take / qty` as bigint does it (toward zero); the whole when all is taken.
pub fn share(total: Amount, qty: Amount, take: Amount) -> Amount {
    if take == qty {
        total
    } else {
        mul_div(total, take, qty, Rounding::Trunc)
    }
}

/// Compares `a * b` with `c * d` exactly, on raw integers.
fn wide_cmp(a: i128, b: i128, c: i128, d: i128) -> Ordering {
    let sign = |x: i128, y: i128| -> i8 {
        if x == 0 || y == 0 {
            0
        } else if (x < 0) == (y < 0) {
            1
        } else {
            -1
        }
    };
    let (s1, s2) = (sign(a, b), sign(c, d));
    if s1 != s2 {
        return s1.cmp(&s2);
    }
    let left = mul_wide(a.unsigned_abs(), b.unsigned_abs());
    let right = mul_wide(c.unsigned_abs(), d.unsigned_abs());
    if s1 >= 0 {
        left.cmp(&right)
    } else {
        right.cmp(&left)
    }
}

/// Compares `a * b` with `c * d` exactly, four amounts. With plain counts in it, it is `cmp_times`.
pub fn cmp_products(a: Amount, b: Amount, c: Amount, d: Amount) -> Ordering {
    wide_cmp(a.0, b.0, c.0, d.0)
}

/// Compares `a * m` with `c * n` exactly, where `m` and `n` are plain counts (a rate in basis points, 10,000).
pub fn cmp_times(a: Amount, m: i128, c: Amount, n: i128) -> Ordering {
    wide_cmp(a.0, m, c.0, n)
}

/// `parseAmount`: an optionally signed decimal string, at most 18 places, inside `numeric(38,18)`. The error is
/// `MoneyError`'s message.
pub fn parse_amount(input: &str) -> Result<Amount, String> {
    let malformed =
        || format!("Malformed amount \"{input}\" — expected an optionally signed decimal string");
    let t = js_trim(input);
    let (negative, body) = match t.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, t),
    };
    let (whole, frac) = match body.split_once('.') {
        Some((w, f)) => (w, Some(f)),
        None => (body, None),
    };
    let all_digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    if !all_digits(whole) || frac.is_some_and(|f| !all_digits(f)) {
        return Err(malformed());
    }
    let frac = frac.unwrap_or("");
    if frac.len() > DECIMALS {
        return Err(format!(
            "Amount \"{input}\" has {} decimal places; the ledger carries {DECIMALS}",
            frac.len()
        ));
    }
    let too_big = || "Amount does not fit numeric(38,18)".to_owned();
    let whole_value = whole
        .bytes()
        .try_fold(0u128, |n, d| {
            n.checked_mul(10)?.checked_add(u128::from(d - b'0'))
        })
        .ok_or_else(too_big)?;
    let mut frac_value: u128 = 0;
    for k in 0..DECIMALS {
        let digit = frac.as_bytes().get(k).map_or(0, |d| u128::from(d - b'0'));
        frac_value = frac_value * 10 + digit;
    }
    let value = whole_value
        .checked_mul(SCALE)
        .and_then(|v| v.checked_add(frac_value))
        .ok_or_else(too_big)?;
    let value = i128::try_from(value).map_err(|_| too_big())?;
    if value > MAX_AMOUNT.0 {
        return Err(too_big());
    }
    Ok(Amount(if negative { -value } else { value }))
}

/// `String.prototype.trim`'s whitespace: ECMAScript WhiteSpace and LineTerminator.
pub fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\u{9}' | '\u{a}' | '\u{b}' | '\u{c}' | '\u{d}' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

/// `String.prototype.trim`.
pub fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_whitespace)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ONE: Amount = Amount::whole(1);

    #[test]
    fn formats_the_exact_difference_where_i128_would_overflow() {
        let ninety = Amount::whole(90_000_000_000_000_000_000);
        assert_eq!(format_difference(ninety, -ninety), "180000000000000000000");
        assert_eq!(format_difference(-ninety, ninety), "-180000000000000000000");
        let half = Amount::from_scaled(500_000_000_000_000_000);
        assert_eq!(
            format_difference(ninety + half, -ninety),
            "180000000000000000000.5"
        );
        assert_eq!(
            format_difference(Amount::MAX, Amount::MIN),
            "340282366920938463463.374607431768211455"
        );
        assert_eq!(format_difference(10 * ONE, 3 * ONE), "7");
        assert_eq!(format_difference(3 * ONE, 10 * ONE), "-7");
    }

    #[test]
    fn multiplies_past_128_bits_as_bigint_does() {
        // 10 BTC at 50,000: the raw product is 5e41, past i128.
        assert_eq!(mul(10 * ONE, 50_000 * ONE), 500_000 * ONE);
        assert_eq!(
            mul(Amount::from_scaled(1), Amount::from_scaled(1)),
            Amount::ZERO
        );
        assert_eq!(mul(ONE / 2, Amount::from_scaled(1)), Amount::from_scaled(1)); // 0.5e-18 rounds half up
        assert_eq!(
            mul(-(ONE / 2), Amount::from_scaled(1)),
            -Amount::from_scaled(1)
        );
        assert_eq!(
            mul_rounded(Amount::from_scaled(3), ONE / 2, Rounding::Ceil),
            Amount::from_scaled(2)
        );
        assert_eq!(
            share(
                Amount::from_scaled(7),
                Amount::from_scaled(3),
                Amount::from_scaled(1)
            ),
            Amount::from_scaled(2)
        );
        assert_eq!(
            share(
                -Amount::from_scaled(7),
                Amount::from_scaled(3),
                Amount::from_scaled(1)
            ),
            -Amount::from_scaled(2)
        );
        assert_eq!(
            share(
                Amount::from_scaled(5),
                Amount::from_scaled(5),
                Amount::from_scaled(5)
            ),
            Amount::from_scaled(5)
        );
        assert_eq!(
            share(123_456 * ONE, 7 * ONE, 3 * ONE),
            (123_456 * ONE) * 3 / 7
        );
    }

    #[test]
    fn adds_sums_and_counts_at_one_scale() {
        let two = Amount::whole(2);
        assert_eq!(two + ONE, Amount::whole(3));
        assert_eq!(two - Amount::whole(5), -Amount::whole(3));
        assert_eq!(two * 3, Amount::whole(6));
        assert_eq!(3 * two, Amount::whole(6));
        assert_eq!(
            Amount::whole(7) / 2,
            Amount::from_scaled(3_500_000_000_000_000_000)
        );
        assert_eq!(
            Amount::from_scaled(7) % Amount::from_scaled(3),
            Amount::UNIT
        );
        assert_eq!([ONE, two].iter().sum::<Amount>(), Amount::whole(3));
        assert_eq!([ONE, two].into_iter().sum::<Amount>(), Amount::whole(3));
        assert_eq!(Amount::MIN.checked_abs(), None);
        assert_eq!(Amount::MIN.saturating_abs(), Amount::MAX);
        assert_eq!(Amount::from_scaled(-5).scaled(), -5);
        assert!(Amount::ZERO.is_zero() && two.is_positive() && (-two).is_negative());
    }

    #[test]
    fn formats_amounts_as_the_ledger_client_does() {
        assert_eq!(format_amount(Amount::ZERO), "0");
        assert_eq!(
            format_amount(Amount::from_scaled(1_500_000_000_000_000_000)),
            "1.5"
        );
        assert_eq!(
            format_amount(-Amount::from_scaled(1)),
            "-0.000000000000000001"
        );
        assert_eq!(format_amount(-2 * SCALE_AMOUNT), "-2");
    }

    #[test]
    fn compares_products_exactly() {
        assert_eq!(
            cmp_products(
                Amount::MAX,
                Amount::from_scaled(3),
                Amount::MAX,
                Amount::from_scaled(2)
            ),
            Ordering::Greater
        );
        assert_eq!(
            cmp_products(
                -Amount::from_scaled(1),
                Amount::from_scaled(5),
                Amount::from_scaled(1),
                Amount::from_scaled(1)
            ),
            Ordering::Less
        );
        assert_eq!(
            cmp_products(
                Amount::ZERO,
                Amount::from_scaled(5),
                Amount::ZERO,
                Amount::from_scaled(1)
            ),
            Ordering::Equal
        );
    }

    #[test]
    fn multiplies_and_divides_by_plain_counts() {
        // 1 at 150 bps, floored: 0.015.
        assert_eq!(
            mul_ratio(ONE, 150, 10_000, Rounding::Floor),
            Amount::from_scaled(15_000_000_000_000_000)
        );
        assert_eq!(mul_ratio(Amount::UNIT, 1, 3, Rounding::Ceil), Amount::UNIT);
        assert_eq!(mul_ratio(Amount::UNIT, 1, 3, Rounding::Floor), Amount::ZERO);
        assert_eq!(mul_ratio(Amount::MAX, 2, 1, Rounding::Trunc), Amount::MAX);
        assert_eq!(mul_ratio(ONE, 1, 0, Rounding::Ceil), Amount::ZERO);
        // 75.000000000000000001 over 100 is 7,501 bps rounded up.
        assert_eq!(
            ratio_of(75 * ONE + Amount::UNIT, 100 * ONE, 10_000, Rounding::Ceil),
            7_501
        );
        assert_eq!(ratio_of(75 * ONE, 100 * ONE, 10_000, Rounding::Ceil), 7_500);
        assert_eq!(ratio_of(ONE, Amount::ZERO, 10_000, Rounding::Ceil), 0);
        assert_eq!(mul_div_count(i128::MAX, 3, 3, Rounding::Trunc), i128::MAX);
        assert_eq!(mul_div_count(-7, 1, 2, Rounding::Floor), -4);
        assert_eq!(cmp_times(Amount::MAX, 3, Amount::MAX, 2), Ordering::Greater);
        assert_eq!(cmp_times(-Amount::UNIT, 5, Amount::UNIT, 1), Ordering::Less);
        assert_eq!(cmp_times(Amount::ZERO, 5, Amount::ZERO, 1), Ordering::Equal);
    }

    #[test]
    fn parses_as_the_ledger_client_does() {
        assert_eq!(parse_amount("1.5"), Ok(ONE + ONE / 2));
        assert_eq!(parse_amount(" -2 "), Ok(-2 * ONE));
        assert_eq!(parse_amount("0.000000000000000001"), Ok(Amount::UNIT));
        assert!(parse_amount("1e5").is_err());
        assert!(parse_amount(".5").is_err());
        assert!(parse_amount("+1").is_err());
        assert!(parse_amount("1.").is_err());
        assert!(parse_amount("0.0000000000000000001").is_err());
        assert!(parse_amount("100000000000000000000").is_err());
        assert_eq!(
            parse_amount("99999999999999999999"),
            Ok(Amount::whole(MAX_AMOUNT.scaled() / ONE.scaled()))
        );
    }
}
