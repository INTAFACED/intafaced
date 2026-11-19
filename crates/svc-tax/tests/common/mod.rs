//! What the ported TypeScript tests share: amounts written as text, the TEST calendar, and figures read back as text.
#![allow(dead_code, reason = "each test file uses its own part")]
#![allow(clippy::unwrap_used, reason = "a test: a failure is the point")]

use svc_tax::money::parse_amount;
use svc_tax::tax::{Amount, format_amount};
use svc_tax::time::{Instant, days_from_civil};

/// `parseAmount`.
pub fn amt(text: &str) -> Amount {
    parse_amount(text).unwrap()
}

/// `formatAmount` of a figure that may be unknown.
pub fn s(v: Option<Amount>) -> Option<String> {
    v.map(format_amount)
}

/// `formatAmount`.
pub fn f(v: Amount) -> String {
    format_amount(v)
}

/// `Date.UTC(year, month - 1, day, hour, minute)`.
pub fn utc(year: i64, month: i64, day: i64, hour: i64, minute: i64) -> Instant {
    Instant(days_from_civil(year, month, day) * 86_400_000 + hour * 3_600_000 + minute * 60_000)
}

/// `new Date(text)` for an ISO text.
pub fn date(text: &str) -> Instant {
    svc_tax::time::js_date(text).unwrap()
}

/// A field of an answer as text: `Some(text)` for a string, `None` for null or absent; anything else is its JSON.
pub fn text(v: &svc_tax::json::Json, key: &str) -> Option<String> {
    match v.get(key) {
        None | Some(svc_tax::json::Json::Null) => None,
        Some(svc_tax::json::Json::String(s)) => Some(s.clone()),
        Some(other) => Some(other.compact()),
    }
}

/// `Some(text.to_owned())`.
pub fn some(text: &str) -> Option<String> {
    Some(text.to_owned())
}
