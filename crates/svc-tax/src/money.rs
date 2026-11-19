//! `parseAmount` (`packages/ledger-client/src/money.ts`): a decimal string from the wire into the scaled integer, refusing
//! anything lossy, with the same error texts (`MoneyError`).

use crate::tax::Amount;

const DECIMALS: usize = 18;
const SCALE: Amount = 1_000_000_000_000_000_000;
/// `MAX_AMOUNT`: the largest magnitude `numeric(38,18)` stores, `10^38 - 1` scaled units.
const MAX_AMOUNT: Amount = 99_999_999_999_999_999_999_999_999_999_999_999_999;

/// `parseAmount(input)` for a string: the trimmed text must be `-?\d+(\.\d+)?` with at most 18 decimals and fit the
/// column. The error is `MoneyError`'s message.
pub fn parse_amount(input: &str) -> Result<Amount, String> {
    let trimmed = input.trim_matches(is_js_whitespace);
    let malformed =
        || format!("Malformed amount \"{input}\" — expected an optionally signed decimal string");
    let (negative, body) = match trimmed.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, trimmed),
    };
    let (whole, frac) = match body.split_once('.') {
        Some((w, f)) => (w, Some(f)),
        None => (body, None),
    };
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    if !digits(whole) || frac.is_some_and(|f| !digits(f)) {
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
    // A whole part this long cannot fit; refusing here keeps the arithmetic below in range.
    let whole = whole.trim_start_matches('0');
    if whole.len() > 21 {
        return Err(too_big());
    }
    let whole: Amount = if whole.is_empty() {
        0
    } else {
        whole.parse().map_err(|_| too_big())?
    };
    let padded = format!("{frac:0<DECIMALS$}");
    let frac: Amount = padded.parse().map_err(|_| malformed())?;
    let value = whole
        .checked_mul(SCALE)
        .and_then(|w| w.checked_add(frac))
        .ok_or_else(too_big)?;
    let signed = if negative { -value } else { value };
    if !(-MAX_AMOUNT..=MAX_AMOUNT).contains(&signed) {
        return Err(too_big());
    }
    Ok(signed)
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

    #[test]
    fn parses_as_parse_amount_does() {
        assert_eq!(parse_amount("1.5"), Ok(1_500_000_000_000_000_000));
        assert_eq!(parse_amount(" -2 "), Ok(-2 * SCALE));
        assert_eq!(parse_amount("0.000000000000000001"), Ok(1));
        assert_eq!(
            parse_amount("1e3"),
            Err(
                "Malformed amount \"1e3\" — expected an optionally signed decimal string"
                    .to_owned()
            )
        );
        assert!(parse_amount(".5").is_err());
        assert!(parse_amount("5.").is_err());
        assert!(parse_amount("+5").is_err());
        assert_eq!(
            parse_amount("0.0000000000000000001"),
            Err(
                "Amount \"0.0000000000000000001\" has 19 decimal places; the ledger carries 18"
                    .to_owned()
            )
        );
        assert_eq!(
            parse_amount("99999999999999999999.999999999999999999"),
            Ok(MAX_AMOUNT)
        );
        assert_eq!(
            parse_amount("100000000000000000000"),
            Err("Amount does not fit numeric(38,18)".to_owned())
        );
    }
}
