//! svc-bank's own refines: the `.refine(...)` checks its TypeScript schemas carry, by the name
//! `scripts/record-door.mjs` gives each in `door/schemas.json`. Each takes the value zod hands a refine (the part's
//! parsed output) and answers as the TypeScript function does.

use service_kit::schema::{Refiner, Value};

/// Every refine the schemas name.
pub const NAMES: [&str; 7] = [
    "account_profile",
    "no_control_characters",
    "note_or_report",
    "some_nonzero_digit",
    "calendar_day",
    "at_most_eight_keys",
    "two_different_users",
];

/// The refines, for the kit's zod engine.
pub struct BankRefines;

/// `BUSINESS_PROFILE` (`account-home/profile.ts`): `business:` and a lowercase uuid.
fn business_profile(s: &str) -> bool {
    let Some(id) = s.strip_prefix("business:") else {
        return false;
    };
    let groups: Vec<&str> = id.split('-').collect();
    groups.len() == 5
        && groups.iter().zip([8, 4, 4, 4, 12]).all(|(g, n)| {
            g.len() == n
                && g.bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
}

/// `new Date(`${day}T00:00:00.000Z`)` is a date and its `toISOString().slice(0, 10)` is `day` again: `YYYY-MM-DD` of a
/// day the calendar has, years 0000 to 9999 (any other year's ISO text is not ten characters).
fn calendar_day(day: &str) -> bool {
    let b = day.as_bytes();
    if b.len() != 10 || b.get(4) != Some(&b'-') || b.get(7) != Some(&b'-') {
        return false;
    }
    let num = |r: std::ops::Range<usize>| -> Option<u32> {
        let part = day.get(r)?;
        if part.bytes().all(|c| c.is_ascii_digit()) {
            part.parse().ok()
        } else {
            None
        }
    };
    let (Some(y), Some(m), Some(d)) = (num(0..4), num(5..7), num(8..10)) else {
        return false;
    };
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    let days = match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return false,
    };
    (1..=days).contains(&d)
}

impl Refiner for BankRefines {
    fn refine(&self, id: &str, value: &Value) -> Result<bool, String> {
        match id {
            // `value === PERSONAL_PROFILE || BUSINESS_PROFILE.test(value)` (`accountDetails.list`).
            "account_profile" => {
                Ok(matches!(value, Value::String(s) if s == "personal" || business_profile(s)))
            }
            // `!/[\u0000-\u001F]/.test(value)`: no control character (a transfer's message, a saved filter's name).
            "no_control_characters" => Ok(match value {
                Value::String(s) => !s.chars().any(|c| u32::from(c) <= 0x1f),
                other => !other.js_string().chars().any(|c| u32::from(c) <= 0x1f),
            }),
            // `value.text !== undefined || value.reportDescription !== undefined` (`activity.note.set`).
            "note_or_report" => Ok(!matches!(value.get("text"), Value::Undefined)
                || !matches!(value.get("reportDescription"), Value::Undefined)),
            // `/[1-9]/.test(value)`: an amount that is not zero.
            "some_nonzero_digit" => Ok(value
                .js_string()
                .bytes()
                .any(|c| (b'1'..=b'9').contains(&c))),
            "calendar_day" => Ok(calendar_day(&value.js_string())),
            // `Object.keys(value).length <= 8`.
            "at_most_eight_keys" => Ok(match value {
                Value::Object(o) => o.len() <= 8,
                _ => true,
            }),
            // `input.fromUserId !== input.toUserId` (`transfers.settleWithdrawal`).
            "two_different_users" => Ok(value.get("fromUserId") != value.get("toUserId")),
            other => Err(format!("no refine named {other}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_calendar_day_is_a_day_the_calendar_has() {
        for (day, ok) in [
            ("2026-01-01", true),
            ("2024-02-29", true),
            ("2026-02-29", false),
            ("2026-13-01", false),
            ("2026-1-01", false),
            ("0000-01-01", true),
            ("2026-01-00", false),
        ] {
            assert_eq!(calendar_day(day), ok, "{day}");
        }
    }

    #[test]
    fn a_business_profile_names_a_lowercase_uuid() {
        assert!(business_profile(
            "business:11111111-1111-4111-8111-111111111111"
        ));
        assert!(!business_profile(
            "business:11111111-1111-4111-8111-11111111111A"
        ));
        assert!(!business_profile("personal"));
    }
}
