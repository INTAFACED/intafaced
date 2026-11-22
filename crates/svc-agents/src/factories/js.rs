//! The few JavaScript built-ins the factories' answers depend on, as V8 computes them: \`Number#toFixed\`,
//! \`String#localeCompare\`, \`Date.parse\` and \`Math.round\`.

use std::cmp::Ordering;

use service_kit::json::js_number_string;
use service_kit::time::v8_date_parse;

/// \`x.toFixed(digits)\`: the exact value rounded half up (ties away from zero, as ECMAScript's \`toFixed\` picks the
/// larger \`n\`); at or past 1e21 it is \`String(x)\`.
pub fn to_fixed(x: f64, digits: usize) -> String {
    if !x.is_finite() || x.abs() >= 1e21 {
        return js_number_string(x);
    }
    let negative = x < 0.0;
    // A double's exact decimal expansion has at most 1074 fractional digits.
    let exact = format!("{:.1100}", x.abs());
    let (whole, frac) = exact.split_once('.').unwrap_or((exact.as_str(), ""));
    let mut kept: Vec<u8> = whole.bytes().chain(frac.bytes().take(digits)).collect();
    if frac.as_bytes().get(digits).is_some_and(|d| *d >= b'5') {
        let mut i = kept.len();
        loop {
            if i == 0 {
                kept.insert(0, b'1');
                break;
            }
            i -= 1;
            match kept.get_mut(i) {
                Some(d) if *d == b'9' => *d = b'0',
                Some(d) => {
                    *d += 1;
                    break;
                }
                None => break,
            }
        }
    }
    let split = kept.len() - digits;
    let text = String::from_utf8(kept).unwrap_or_default();
    let body = if digits == 0 {
        text
    } else {
        format!("{}.{}", &text[..split], &text[split..])
    };
    // \`(-0.0000001).toFixed(2)\` is "-0.00": the sign is the number's.
    if negative { format!("-{body}") } else { body }
}

/// \`a.localeCompare(b)\` as ICU's root collation orders printable ASCII: each character by its primary weight (white
/// space, then punctuation and symbols in ICU's order, then digits, then letters without case), and on a tie lower case
/// before upper case. Outside printable ASCII a character sorts after every ASCII one, by code point.
pub fn locale_compare(a: &str, b: &str) -> Ordering {
    const ORDER: &str = " _-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$0123456789aAbBcCdDeEfFgGhHiIjJkKlLmMnNoOpPqQrRsStTuUvVwWxXyYzZ";
    fn primary(c: char) -> (usize, char) {
        let folded = c.to_ascii_lowercase();
        match ORDER.find(folded) {
            Some(at) if c.is_ascii() => (at, '\0'),
            _ => (ORDER.len(), c),
        }
    }
    a.chars()
        .map(primary)
        .cmp(b.chars().map(primary))
        .then_with(|| {
            a.chars()
                .map(|c| !c.is_ascii_lowercase())
                .cmp(b.chars().map(|c| !c.is_ascii_lowercase()))
        })
}

/// \`Date.parse(text)\`: milliseconds, or none for an invalid date (\`NaN\`).
pub fn date_parse(text: &str) -> Option<i64> {
    v8_date_parse(text)
}

/// \`isFresh(asOf, maxAgeMs, nowMs)\`: parsed, not in the future and no older than \`maxAgeMs\`.
#[expect(
    clippy::cast_precision_loss,
    reason = "the TypeScript subtracts doubles; times within ±8.64e15 are exact"
)]
pub fn is_fresh(as_of: &str, max_age_ms: f64, now_ms: i64) -> bool {
    let Some(t) = date_parse(as_of) else {
        return false;
    };
    let age = (now_ms - t) as f64;
    age <= max_age_ms && age >= 0.0
}

/// \`Math.round(n)\`: the nearest integer, a half toward +∞.
#[expect(
    clippy::float_arithmetic,
    reason = "a whole number from a double, as JavaScript rounds it; never money"
)]
pub fn math_round(n: f64) -> f64 {
    let f = n.floor();
    if n - f >= 0.5 { f + 1.0 } else { f }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn to_fixed_rounds_the_exact_value_as_v8_does() {
        assert_eq!(to_fixed(1.005, 2), "1.00");
        assert_eq!(to_fixed(0.5, 0), "1");
        assert_eq!(to_fixed(2.5, 0), "3");
        assert_eq!(to_fixed(0.0, 6), "0.000000");
        assert_eq!(to_fixed(123.456_789_5, 6), "123.456789");
        assert_eq!(to_fixed(-1.5, 0), "-2");
        assert_eq!(to_fixed(1e21, 2), "1e+21");
    }

    #[test]
    fn locale_compare_puts_digits_before_letters_and_lower_case_first() {
        assert_eq!(locale_compare("btc-usdt", "eth-usdt"), Ordering::Less);
        assert_eq!(locale_compare("a", "A"), Ordering::Less);
        assert_eq!(locale_compare("1", "a"), Ordering::Less);
        assert_eq!(locale_compare("a-b", "ab"), Ordering::Less);
        assert_eq!(locale_compare("x", "x"), Ordering::Equal);
    }

    #[test]
    fn math_round_takes_a_half_up() {
        assert!((math_round(2.5) - 3.0).abs() < f64::EPSILON);
        assert!((math_round(-2.5) + 2.0).abs() < f64::EPSILON);
        assert!((math_round(-2.6) + 3.0).abs() < f64::EPSILON);
    }
}
