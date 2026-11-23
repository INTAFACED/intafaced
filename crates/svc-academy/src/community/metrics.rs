//! The founder console's daily activity table and completions by item (`learning/customer-store.ts` `opsMetrics`,
//! `completionsByItem`; `learning/metrics.ts`). A count the service records is a number, including zero; a day before
//! it began recording is `metric_not_recorded`, never zero. Read only.

use std::cmp::Ordering;

use service_kit::json::Json;
use service_kit::time::{Instant, civil_from_days, days_from_civil, days_in_month};

use super::Db;
use super::{academy, col, js_trim, rows};
use crate::curriculum::spine;
use crate::db::with_client;
use crate::errors::Refusal;

/// `OPS_METRICS_MAX_DAYS` (`learning/limits.ts`).
pub const MAX_DAYS: i64 = 366;
const DAY_MS: i64 = 86_400_000;

/// `parseUtcDay`: `YYYY-MM-DD` naming a real day. `Date.UTC` reads a year below 100 as 19xx, so the TypeScript's
/// round-trip check refuses those years too.
pub fn parse_utc_day(value: &str) -> Option<(i64, i64, i64)> {
    let b = value.as_bytes();
    if b.len() != 10 || b.get(4) != Some(&b'-') || b.get(7) != Some(&b'-') {
        return None;
    }
    let digits = |r: std::ops::Range<usize>| -> Option<i64> {
        let part = value.get(r)?;
        if !part.bytes().all(|c| c.is_ascii_digit()) {
            return None;
        }
        part.parse().ok()
    };
    let (y, m, d) = (digits(0..4)?, digits(5..7)?, digits(8..10)?);
    if y < 100 || !(1..=12).contains(&m) || d < 1 || d > days_in_month(y, m) {
        return None;
    }
    Some((y, m, d))
}

/// A checked UTC window: its first and last day as given and its bounds in milliseconds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Window {
    pub from: String,
    pub to: String,
    pub start: Instant,
    pub end_exclusive: Instant,
}

fn day_ms((y, m, d): (i64, i64, i64)) -> i64 {
    days_from_civil(y, m, d) * DAY_MS
}

/// `utcWindow(label, from, to)`.
pub fn utc_window(label: &str, from: &str, to: &str) -> Result<Window, Refusal> {
    let invalid = |m: String| academy("academy.metrics_range_invalid", m);
    let (Some(f), Some(t)) = (parse_utc_day(from), parse_utc_day(to)) else {
        return Err(invalid(format!(
            "{label} from and to must be UTC days YYYY-MM-DD"
        )));
    };
    let (from_ms, to_ms) = (day_ms(f), day_ms(t));
    if from_ms > to_ms {
        return Err(invalid(format!("{label} from is after to")));
    }
    let span = (to_ms - from_ms) / DAY_MS + 1;
    if span > MAX_DAYS {
        return Err(invalid(format!(
            "{label} range is {span} days; OPS_METRICS_MAX_DAYS is {MAX_DAYS}"
        )));
    }
    Ok(Window {
        from: from.to_owned(),
        to: to.to_owned(),
        start: Instant(from_ms),
        end_exclusive: Instant(to_ms + DAY_MS),
    })
}

fn day_text(ms: i64) -> String {
    let (y, m, d) = civil_from_days(ms.div_euclid(DAY_MS));
    format!("{y:04}-{m:02}-{d:02}")
}

fn cell(count: Option<i32>, recorded: bool) -> Json {
    if recorded {
        Json::obj([
            ("value", Json::int(i64::from(count.unwrap_or(0)))),
            ("reason", Json::Null),
        ])
    } else {
        Json::obj([
            ("value", Json::Null),
            ("reason", Json::str("metric_not_recorded")),
        ])
    }
}

/// The daily activity table. A day before the service began recording has `metric_not_recorded` in every cell.
pub fn ops_metrics(pool: &Db<'_>, from: &str, to: &str) -> Result<Json, Refusal> {
    let window = utc_window("opsMetrics", from, to)?;
    let (start, end) = (window.start.iso(), window.end_exclusive.iso());
    with_client(pool.get()?, |db| {
        let since = rows(
            db,
            "SELECT to_char(LEAST(
               (SELECT since FROM academy.metrics_recording WHERE id = 1),
               (SELECT min(touched_at) FROM academy.learning_touches),
               (SELECT min(completed_at) FROM academy.cert_item_completions),
               (SELECT min(granted_at) FROM academy.cert_grants),
               now()
             ) AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day",
            &[],
        )?;
        let mut counts: Vec<Vec<(String, i32)>> = Vec::new();
        for (column, table) in [
            ("touched_at", "academy.learning_touches"),
            ("completed_at", "academy.cert_item_completions"),
            ("granted_at", "academy.cert_grants"),
        ] {
            let found = rows(
                db,
                &format!(
                    "SELECT to_char({column} AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, COUNT(*)::int AS n
                       FROM {table}
                      WHERE {column} >= $1::text::timestamptz AND {column} < $2::text::timestamptz
                      GROUP BY 1"
                ),
                &[&start, &end],
            )?;
            let mut list = Vec::new();
            for r in &found {
                list.push((col::<String>(r, 0)?, col::<i32>(r, 1)?));
            }
            counts.push(list);
        }
        let recording_since: String = match since.first() {
            Some(r) => col(r, 0)?,
            None => {
                return Err(Refusal::Internal {
                    message: "Cannot read properties of undefined (reading 'day')".to_owned(),
                    code: None,
                });
            }
        };
        let get = |i: usize, day: &str| {
            counts
                .get(i)
                .and_then(|list| list.iter().find(|(d, _)| d == day))
                .map(|(_, n)| *n)
        };
        let mut days = Vec::new();
        let mut t = window.start.0;
        while t < window.end_exclusive.0 {
            let date = day_text(t);
            let recorded = date.as_str() >= recording_since.as_str();
            let (lessons, completions, grants) = (
                cell(get(0, &date), recorded),
                cell(get(1, &date), recorded),
                cell(get(2, &date), recorded),
            );
            days.push(Json::obj([
                ("date", Json::str(date)),
                ("lessonsRead", lessons),
                ("completions", completions),
                ("grants", grants),
            ]));
            t += DAY_MS;
        }
        Ok(Json::obj([
            ("from", Json::str(window.from.clone())),
            ("to", Json::str(window.to.clone())),
            ("recordingSince", Json::str(recording_since)),
            ("days", Json::Array(days)),
        ]))
    })
}

/// The ICU root collation's primary weight class of one ASCII character, as `localeCompare` orders the strings this
/// table sorts (item and path slugs): whitespace, then punctuation and symbols in CLDR's order, then digits, then
/// letters case-blind. Anything else sorts after, by code point.
fn weight(c: char) -> (u8, u32) {
    const PUNCT: &str = "_-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$";
    if c.is_ascii_whitespace() {
        return (0, u32::from(c));
    }
    if let Some(i) = PUNCT.find(c) {
        return (1, u32::try_from(i).unwrap_or(u32::MAX));
    }
    if c.is_ascii_digit() {
        return (2, u32::from(c));
    }
    if c.is_ascii_alphabetic() {
        return (3, u32::from(c.to_ascii_lowercase()));
    }
    (4, u32::from(c))
}

/// `a.localeCompare(b)` for slugs: primary weights first; on a tie, lower case before upper case.
pub fn locale_cmp(a: &str, b: &str) -> Ordering {
    let primary = a.chars().map(weight).cmp(b.chars().map(weight));
    primary.then_with(|| {
        a.chars()
            .map(|c| c.is_ascii_uppercase())
            .cmp(b.chars().map(|c| c.is_ascii_uppercase()))
    })
}

/// Completions per spine item in the window (and per slug the spine does not know, when no course is named), by
/// course then slug.
pub fn completions_by_item(
    pool: &Db<'_>,
    from: &str,
    to: &str,
    path_slug: Option<&str>,
) -> Result<Json, Refusal> {
    let window = utc_window("completionsByItem", from, to)?;
    let requested = path_slug
        .map(|p| js_trim(p).to_lowercase())
        .unwrap_or_default();
    let path = if requested.is_empty() {
        None
    } else if spine::PATHS.contains(&requested.as_str()) {
        Some(requested)
    } else {
        return Err(academy(
            "academy.path_not_found",
            format!("Path {requested} is not in the curriculum catalogue"),
        ));
    };
    let found = with_client(pool.get()?, |db| {
        rows(
            db,
            "SELECT item_slug, COUNT(*)::int AS n
               FROM academy.cert_item_completions
              WHERE completed_at >= $1::text::timestamptz AND completed_at < $2::text::timestamptz
              GROUP BY item_slug",
            &[&window.start.iso(), &window.end_exclusive.iso()],
        )
    })?;
    let mut counts: Vec<(String, i32)> = Vec::new();
    for r in &found {
        counts.push((col(r, 0)?, col(r, 1)?));
    }
    let catalogue = spine::list(path.as_deref(), None);
    let mut items: Vec<(String, Option<String>, i32)> = catalogue
        .iter()
        .map(|i| {
            let n = counts
                .iter()
                .find(|(s, _)| *s == i.slug)
                .map_or(0, |(_, n)| *n);
            (i.slug.clone(), Some(i.path.clone()), n)
        })
        .collect();
    if path.is_none() {
        for (slug, n) in &counts {
            if !catalogue.iter().any(|i| i.slug == *slug) {
                items.push((slug.clone(), None, *n));
            }
        }
    }
    let last = "\u{ffff}";
    items.sort_by(|a, b| {
        locale_cmp(
            a.1.as_deref().unwrap_or(last),
            b.1.as_deref().unwrap_or(last),
        )
        .then_with(|| locale_cmp(&a.0, &b.0))
    });
    Ok(Json::obj([
        ("from", Json::str(window.from)),
        ("to", Json::str(window.to)),
        ("pathSlug", path.map_or(Json::Null, Json::str)),
        (
            "items",
            Json::Array(
                items
                    .into_iter()
                    .map(|(slug, p, n)| {
                        Json::obj([
                            ("itemSlug", Json::str(slug)),
                            ("pathSlug", p.map_or(Json::Null, Json::str)),
                            ("count", Json::int(i64::from(n))),
                        ])
                    })
                    .collect(),
            ),
        ),
    ]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_utc_day_is_a_real_day_from_year_100() {
        assert_eq!(parse_utc_day("2026-02-28"), Some((2026, 2, 28)));
        assert_eq!(parse_utc_day("2024-02-29"), Some((2024, 2, 29)));
        assert_eq!(parse_utc_day("2026-02-29"), None);
        assert_eq!(parse_utc_day("2026-13-01"), None);
        assert_eq!(parse_utc_day("0099-01-01"), None);
        assert_eq!(parse_utc_day("0100-01-01"), Some((100, 1, 1)));
        assert_eq!(parse_utc_day("2026-1-01"), None);
        assert_eq!(parse_utc_day("2026-01-01T"), None);
    }

    #[test]
    fn a_window_refuses_as_the_typescript_words_it() {
        let msg = |r: Result<Window, Refusal>| match r {
            Err(Refusal::Academy(e)) => e.message,
            _ => String::new(),
        };
        assert_eq!(
            msg(utc_window("opsMetrics", "x", "2026-01-01")),
            "opsMetrics from and to must be UTC days YYYY-MM-DD"
        );
        assert_eq!(
            msg(utc_window("opsMetrics", "2026-01-02", "2026-01-01")),
            "opsMetrics from is after to"
        );
        assert_eq!(
            msg(utc_window("opsMetrics", "2025-01-01", "2026-01-02")),
            "opsMetrics range is 367 days; OPS_METRICS_MAX_DAYS is 366"
        );
        let ok = utc_window("opsMetrics", "2024-01-01", "2024-12-31");
        assert!(ok.is_ok(), "366 days is inside the bound");
    }

    #[test]
    fn slugs_sort_as_locale_compare_does() {
        let mut v = vec!["b", "a-c", "ab", "a1", "A", "a"];
        v.sort_by(|a, b| locale_cmp(a, b));
        assert_eq!(v, ["a", "A", "a-c", "a1", "ab", "b"]);
        assert_eq!(locale_cmp("sovereign", "\u{ffff}"), Ordering::Less);
    }
}
