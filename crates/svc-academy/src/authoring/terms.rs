//! A course's seat cap, enrolment window and visibility (`curriculum/course-terms.ts` `CourseTermsStore`): one row per
//! course, each change with who and why; a field not changed keeps its stored value.

use crate::db::Store;
use service_kit::json::Json;
use service_kit::schema::{Value, js_trim};
use service_kit::time::js_date;

use super::release::published_course;
use super::sql::{self, at, first, get, iso, ms, opt_int};
use super::{refuse, text};
use crate::errors::Refusal;

/// `COURSE_VISIBILITIES`.
pub const VISIBILITIES: [&str; 3] = ["published", "hidden", "unpublished"];

/// `CourseTerms`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Terms {
    pub seat_cap: Option<i64>,
    pub opens_at: Option<i64>,
    pub closes_at: Option<i64>,
    pub visibility: String,
}

impl Default for Terms {
    fn default() -> Terms {
        Terms {
            seat_cap: None,
            opens_at: None,
            closes_at: None,
            visibility: "published".to_owned(),
        }
    }
}

fn of(r: &postgres::Row) -> Result<Terms, Refusal> {
    Ok(Terms {
        seat_cap: opt_int(r, "seat_cap")?,
        opens_at: get(r, "opens_at")?,
        closes_at: get(r, "closes_at")?,
        visibility: get(r, "visibility")?,
    })
}

fn cols() -> String {
    format!(
        "seat_cap, {} AS opens_at, {} AS closes_at, visibility",
        ms("opens_at"),
        ms("closes_at")
    )
}

/// `CourseTermsStore.read(path)`.
pub fn read<C: postgres::GenericClient>(c: &mut C, path: &str) -> Result<Terms, Refusal> {
    first(
        c,
        &format!(
            "SELECT {} FROM academy.course_enrolment_terms WHERE path = $1::text",
            cols()
        ),
        &[&path],
    )?
    .map_or_else(|| Ok(Terms::default()), |r| of(&r))
}

/// What one write changes.
#[derive(Default)]
struct Change {
    seat_cap: Option<Option<i64>>,
    window: Option<(Option<i64>, Option<i64>)>,
    visibility: Option<String>,
}

/// `write`: the published-course check and the reason, then one upsert that keeps what it does not change.
fn write(
    pool: &Store,
    input: &Value,
    operator: &str,
    now: i64,
    change: Change,
) -> Result<Json, Refusal> {
    let slug = published_course(text(input, "slug"))?;
    let reason = js_trim(text(input, "reason"));
    if reason.is_empty() {
        return refuse("academy.reason_required", "academy.reason_required");
    }
    let stored = sql::client(pool, |c| read(c, slug))?;
    let next = Terms {
        seat_cap: change.seat_cap.unwrap_or(stored.seat_cap),
        opens_at: change.window.map_or(stored.opens_at, |w| w.0),
        closes_at: change.window.map_or(stored.closes_at, |w| w.1),
        visibility: change.visibility.clone().unwrap_or(stored.visibility),
    };
    let pick = |changed: bool, col: &str| {
        if changed {
            format!("EXCLUDED.{col}")
        } else {
            format!("academy.course_enrolment_terms.{col}")
        }
    };
    let statement = format!(
        "INSERT INTO academy.course_enrolment_terms (path, seat_cap, opens_at, closes_at, visibility, reason, set_by, set_at) \
         VALUES ($1::text, $2::int4, $3::text::timestamptz, $4::text::timestamptz, $5::text, $6::text, $7::text::uuid, $8::text::timestamptz) \
         ON CONFLICT (path) DO UPDATE SET seat_cap = {}, opens_at = {}, closes_at = {}, visibility = {}, \
           reason = EXCLUDED.reason, set_by = EXCLUDED.set_by, set_at = EXCLUDED.set_at \
         RETURNING {}",
        pick(change.seat_cap.is_some(), "seat_cap"),
        pick(change.window.is_some(), "opens_at"),
        pick(change.window.is_some(), "closes_at"),
        pick(change.visibility.is_some(), "visibility"),
        cols()
    );
    let cap = next.seat_cap.map(|n| i32::try_from(n).unwrap_or(i32::MAX));
    let opens = next.opens_at.map(at);
    let closes = next.closes_at.map(at);
    let row = sql::client(pool, |c| {
        first(
            c,
            &statement,
            &[
                &slug,
                &cap,
                &opens,
                &closes,
                &next.visibility,
                &reason,
                &operator,
                &at(now),
            ],
        )
    })?;
    let t = row.map_or_else(|| Ok(Terms::default()), |r| of(&r))?;
    let opt = |v: Option<i64>| v.map_or(Json::Null, |m| Json::String(iso(m)));
    Ok(Json::obj([
        ("slug", Json::str(slug)),
        ("seatCap", t.seat_cap.map_or(Json::Null, Json::int)),
        ("opensAt", opt(t.opens_at)),
        ("closesAt", opt(t.closes_at)),
        ("visibility", Json::String(t.visibility)),
        ("reason", Json::str(reason)),
        ("setAt", Json::String(iso(now))),
    ]))
}

/// `setSeatCap`: a whole number above zero, or `null` to take it off.
pub fn set_seat_cap(
    pool: &Store,
    input: &Value,
    operator: &str,
    now: i64,
) -> Result<Json, Refusal> {
    let cap = input.get("seatCap").as_number();
    if let Some(n) = cap
        && !(n.fract() == 0.0 && n > 0.0 && n <= 9_007_199_254_740_991.0)
    {
        return refuse(
            "academy.seat_cap_invalid: a cap is a whole number above zero",
            "academy.cert_invalid",
        );
    }
    let cap = super::opt_int(input, "seatCap");
    write(
        pool,
        input,
        operator,
        now,
        Change {
            seat_cap: Some(cap),
            ..Change::default()
        },
    )
}

/// `setWindow`: opens before closes, checked before anything else.
pub fn set_window(pool: &Store, input: &Value, operator: &str, now: i64) -> Result<Json, Refusal> {
    let date = |k: &str| super::opt_text(input, k).and_then(|s| js_date(s).map(|i| i.0));
    let (opens, closes) = (date("opensAt"), date("closesAt"));
    if let (Some(o), Some(c)) = (opens, closes)
        && o >= c
    {
        return refuse(
            "academy.window_invalid: the window opens before it closes",
            "academy.window_invalid",
        );
    }
    write(
        pool,
        input,
        operator,
        now,
        Change {
            window: Some((opens, closes)),
            ..Change::default()
        },
    )
}

/// `setVisibility`.
pub fn set_visibility(
    pool: &Store,
    input: &Value,
    operator: &str,
    now: i64,
) -> Result<Json, Refusal> {
    let v = text(input, "visibility");
    if !VISIBILITIES.contains(&v) {
        return refuse("academy.course_visibility_invalid", "academy.cert_invalid");
    }
    write(
        pool,
        input,
        operator,
        now,
        Change {
            visibility: Some(v.to_owned()),
            ..Change::default()
        },
    )
}
