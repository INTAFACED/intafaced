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
pub type Amount = i128;

const DECIMALS: usize = 18;
const SCALE: u128 = 1_000_000_000_000_000_000;
/// `MAX_AMOUNT`: `10n ** 38n - 1n`, what `numeric(38,18)` holds.
pub const MAX_AMOUNT: Amount = 99_999_999_999_999_999_999_999_999_999_999_999_999;

/// `formatAmount`: the shortest decimal string, no trailing zeros.
pub fn format_amount(value: Amount) -> String {
    let sign = if value < 0 { "-" } else { "" };
    let abs = value.unsigned_abs();
    let (whole, frac) = (abs / SCALE, abs % SCALE);
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

fn saturate(negative: bool, q: U256) -> Amount {
    let fits = q.0 == 0 && q.1 <= i128::MAX.unsigned_abs();
    match (fits, negative) {
        (true, false) => i128::try_from(q.1).unwrap_or(i128::MAX),
        (true, true) => 0i128.saturating_sub_unsigned(q.1),
        (false, false) => i128::MAX,
        (false, true) => i128::MIN,
    }
}

/// `a * b / d`, rounded as `divideScaled` rounds (a zero `d` gives 0; no caller divides by zero).
pub fn mul_div(a: Amount, b: Amount, d: Amount, rounding: Rounding) -> Amount {
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

/// `mul(a, b)`: two scaled amounts multiplied (half-up unless stated).
pub fn mul(a: Amount, b: Amount) -> Amount {
    mul_div(a, b, SCALE_AMOUNT, Rounding::HalfUp)
}

/// `mul(a, b, rounding)`.
pub fn mul_rounded(a: Amount, b: Amount, rounding: Rounding) -> Amount {
    mul_div(a, b, SCALE_AMOUNT, rounding)
}

const SCALE_AMOUNT: Amount = 1_000_000_000_000_000_000;

/// `total * take / qty` as bigint does it (toward zero); the whole when all is taken.
pub fn share(total: Amount, qty: Amount, take: Amount) -> Amount {
    if take == qty {
        total
    } else {
        mul_div(total, take, qty, Rounding::Trunc)
    }
}

/// Compares `a * b` with `c * d` exactly.
pub fn cmp_products(a: Amount, b: Amount, c: Amount, d: Amount) -> Ordering {
    let sign = |x: Amount, y: Amount| -> i8 {
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
    if value > MAX_AMOUNT {
        return Err(too_big());
    }
    Ok(if negative { -value } else { value })
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

    const ONE: Amount = 1_000_000_000_000_000_000;

    #[test]
    fn multiplies_past_128_bits_as_bigint_does() {
        // 10 BTC at 50,000: the raw product is 5e41, past i128.
        assert_eq!(mul(10 * ONE, 50_000 * ONE), 500_000 * ONE);
        assert_eq!(mul(1, 1), 0);
        assert_eq!(mul(ONE / 2, 1), 1); // 0.5e-18 rounds half up
        assert_eq!(mul(-(ONE / 2), 1), -1);
        assert_eq!(mul_rounded(3, ONE / 2, Rounding::Ceil), 2);
        assert_eq!(share(7, 3, 1), 2);
        assert_eq!(share(-7, 3, 1), -2);
        assert_eq!(share(5, 5, 5), 5);
        assert_eq!(
            share(123_456 * ONE, 7 * ONE, 3 * ONE),
            (123_456 * ONE) * 3 / 7
        );
    }

    #[test]
    fn formats_amounts_as_the_ledger_client_does() {
        assert_eq!(format_amount(0), "0");
        assert_eq!(format_amount(1_500_000_000_000_000_000), "1.5");
        assert_eq!(format_amount(-1), "-0.000000000000000001");
        assert_eq!(format_amount(-2 * SCALE_AMOUNT), "-2");
    }

    #[test]
    fn compares_products_exactly() {
        assert_eq!(cmp_products(i128::MAX, 3, i128::MAX, 2), Ordering::Greater);
        assert_eq!(cmp_products(-1, 5, 1, 1), Ordering::Less);
        assert_eq!(cmp_products(0, 5, 0, 1), Ordering::Equal);
    }

    #[test]
    fn parses_as_the_ledger_client_does() {
        assert_eq!(parse_amount("1.5"), Ok(ONE + ONE / 2));
        assert_eq!(parse_amount(" -2 "), Ok(-2 * ONE));
        assert_eq!(parse_amount("0.000000000000000001"), Ok(1));
        assert!(parse_amount("1e5").is_err());
        assert!(parse_amount(".5").is_err());
        assert!(parse_amount("+1").is_err());
        assert!(parse_amount("1.").is_err());
        assert!(parse_amount("0.0000000000000000001").is_err());
        assert!(parse_amount("100000000000000000000").is_err());
        assert_eq!(
            parse_amount("99999999999999999999"),
            Ok(MAX_AMOUNT / ONE * ONE)
        );
    }
}
