//! The few shape checks the stand-ins' catalogues and the pay-in partner's job bodies need, each as the TypeScript's
//! zod schema reads it.

use service_kit::json::Json;

/// A strict object's fields: `None` when `j` is no object or names a key outside `allowed`.
pub fn strict<'j>(j: &'j Json, allowed: &[&str]) -> Option<&'j [(String, Json)]> {
    match j {
        Json::Object(fields) if fields.iter().all(|(k, _)| allowed.contains(&k.as_str())) => {
            Some(fields)
        }
        _ => None,
    }
}

/// The last value under `key`, as `JSON.parse` keeps it.
pub fn field<'j>(fields: &'j [(String, Json)], key: &str) -> Option<&'j Json> {
    fields.iter().rev().find(|(k, _)| k == key).map(|(_, v)| v)
}

pub fn string<'j>(fields: &'j [(String, Json)], key: &str) -> Option<&'j str> {
    match field(fields, key) {
        Some(Json::String(s)) => Some(s),
        _ => None,
    }
}

/// `z.number().int().min(lo).max(hi)`.
pub fn int_in(fields: &[(String, Json)], key: &str, lo: i64, hi: i64) -> Option<i64> {
    match field(fields, key) {
        #[allow(
            clippy::cast_possible_truncation,
            clippy::cast_precision_loss,
            reason = "a whole number inside the bounds"
        )]
        Some(Json::Number(n)) if n.fract() == 0.0 && *n >= lo as f64 && *n <= hi as f64 => {
            Some(*n as i64)
        }
        _ => None,
    }
}

fn all(s: &str, ok: impl Fn(u8) -> bool) -> bool {
    s.bytes().all(ok)
}

/// `/^[A-Z]{lo,hi}$/` (or with digits when `digits`).
pub fn upper(s: &str, lo: usize, hi: usize, digits: bool) -> bool {
    (lo..=hi).contains(&s.len())
        && all(s, |b| {
            b.is_ascii_uppercase() || (digits && b.is_ascii_digit())
        })
}

/// `/^\d+(\.\d{1,18})?$/`.
pub fn decimal(s: &str) -> bool {
    let (whole, frac) = match s.split_once('.') {
        Some((w, f)) => (w, Some(f)),
        None => (s, None),
    };
    !whole.is_empty()
        && all(whole, |b| b.is_ascii_digit())
        && frac.is_none_or(|f| (1..=18).contains(&f.len()) && all(f, |b| b.is_ascii_digit()))
}

/// `/^TEST\b/`: `TEST` then the end or a character that is not a word character.
pub fn test_label(s: &str) -> bool {
    s.strip_prefix("TEST").is_some_and(|rest| {
        rest.bytes()
            .next()
            .is_none_or(|b| !(b.is_ascii_alphanumeric() || b == b'_'))
    })
}

/// zod 4's `uuid()`: versions 1 to 8 and the RFC variant, or the nil and max ids.
pub fn uuid(s: &str) -> bool {
    if s == "00000000-0000-0000-0000-000000000000" || s == "ffffffff-ffff-ffff-ffff-ffffffffffff" {
        return true;
    }
    let b = s.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => *c == b'-',
            14 => (b'1'..=b'8').contains(c),
            19 => matches!(c, b'8' | b'9' | b'a' | b'b' | b'A' | b'B'),
            _ => c.is_ascii_hexdigit(),
        })
}

/// `/^0x[0-9a-fA-F]{n}$/`.
pub fn hex0x(s: &str, n: usize) -> bool {
    s.strip_prefix("0x")
        .is_some_and(|h| h.len() == n && all(h, |b| b.is_ascii_hexdigit()))
}

/// `String.prototype.trim` and JavaScript's length (UTF-16 units).
pub fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}
