//! A control's schedule in UTC (`ledger/reconciliation-schedule.ts`): its period, the period's bounds around an instant,
//! when the control falls due in a period, and a past run's read instant (its as-of minus a margin of seconds). Weeks are
//! ISO (Monday starts the week); months are calendar months. Instants are milliseconds, as `Date` holds them.

use service_kit::json::Json;
use service_kit::money::{Amount, parse_amount};
use service_kit::time::{civil_from_days, days_from_civil, days_in_month};

use super::{ASOF_INVALID, ControlError, MARGIN_UNSET};

const HOUR_MS: i64 = 3_600_000;
const DAY_MS: i64 = 86_400_000;
/// `SCALE`: the ledger's 18 places.
const SCALE: Amount = 1_000_000_000_000_000_000;
/// `MS_DIVISOR`: one millisecond is a thousandth of the scale.
const MS_DIVISOR: Amount = SCALE / 1000;
/// `MAX_MARGIN_SECONDS`: a margin past a year is refused.
const MAX_MARGIN_SECONDS: Amount = 366 * 24 * 60 * 60;

/// `ReconciliationSchedule`, as its schema leaves it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Schedule {
    Hourly {
        minute: i64,
    },
    Daily {
        hour: i64,
        minute: i64,
    },
    Weekly {
        iso_weekday: i64,
        hour: i64,
        minute: i64,
    },
    Monthly {
        day: i64,
        hour: i64,
        minute: i64,
    },
}

/// `ReconciliationPeriod`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Period {
    Hour,
    Day,
    IsoWeek,
    Month,
}

impl Period {
    pub fn as_str(self) -> &'static str {
        match self {
            Period::Hour => "hour",
            Period::Day => "day",
            Period::IsoWeek => "iso_week",
            Period::Month => "month",
        }
    }

    /// The stored column's word; none for a word the enum does not hold.
    pub fn from_word(word: &str) -> Option<Period> {
        Some(match word {
            "hour" => Period::Hour,
            "day" => Period::Day,
            "iso_week" => Period::IsoWeek,
            "month" => Period::Month,
            _ => return None,
        })
    }
}

impl Schedule {
    /// A schedule its schema has parsed: every field a whole number in range.
    pub fn from_parsed(j: &Json) -> Option<Schedule> {
        #[expect(
            clippy::cast_possible_truncation,
            reason = "the schema holds each field to a small whole number"
        )]
        let n = |k: &str| match j.get(k) {
            Some(Json::Number(v)) => Some(*v as i64),
            _ => None,
        };
        Some(match j.get("cadence") {
            Some(Json::String(c)) if c == "hourly" => Schedule::Hourly {
                minute: n("minute")?,
            },
            Some(Json::String(c)) if c == "daily" => Schedule::Daily {
                hour: n("hour")?,
                minute: n("minute")?,
            },
            Some(Json::String(c)) if c == "weekly" => Schedule::Weekly {
                iso_weekday: n("isoWeekday")?,
                hour: n("hour")?,
                minute: n("minute")?,
            },
            Some(Json::String(c)) if c == "monthly" => Schedule::Monthly {
                day: n("day")?,
                hour: n("hour")?,
                minute: n("minute")?,
            },
            _ => return None,
        })
    }

    /// `periodForSchedule`.
    pub fn period(self) -> Period {
        match self {
            Schedule::Hourly { .. } => Period::Hour,
            Schedule::Daily { .. } => Period::Day,
            Schedule::Weekly { .. } => Period::IsoWeek,
            Schedule::Monthly { .. } => Period::Month,
        }
    }
}

/// A period's half-open bounds, in milliseconds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Bounds {
    pub start: i64,
    pub end: i64,
}

/// The UTC day number and the milliseconds into it.
fn day_of(at: i64) -> (i64, i64) {
    (at.div_euclid(DAY_MS), at.rem_euclid(DAY_MS))
}

/// `utcIsoWeekStart`: Monday 00:00 UTC of the ISO week that holds `at`.
pub fn iso_week_start(at: i64) -> i64 {
    let (days, _) = day_of(at);
    // 1970-01-01 was a Thursday: day 0 is weekday 4, Monday 1 to Sunday 7.
    let weekday = (days + 3).rem_euclid(7) + 1;
    (days - (weekday - 1)) * DAY_MS
}

/// `periodBounds(period, at)`.
pub fn period_bounds(period: Period, at: i64) -> Bounds {
    let (days, into) = day_of(at);
    match period {
        Period::Hour => {
            let start = days * DAY_MS + into.div_euclid(HOUR_MS) * HOUR_MS;
            Bounds {
                start,
                end: start + HOUR_MS,
            }
        }
        Period::Day => Bounds {
            start: days * DAY_MS,
            end: (days + 1) * DAY_MS,
        },
        Period::IsoWeek => {
            let start = iso_week_start(at);
            Bounds {
                start,
                end: start + 7 * DAY_MS,
            }
        }
        Period::Month => {
            let (year, month, _) = civil_from_days(days);
            let (next_year, next_month) = if month == 12 {
                (year + 1, 1)
            } else {
                (year, month + 1)
            };
            Bounds {
                start: days_from_civil(year, month, 1) * DAY_MS,
                end: days_from_civil(next_year, next_month, 1) * DAY_MS,
            }
        }
    }
}

/// `dueInstant(schedule, periodStart)`: when the control falls due in the period that starts here; none when a monthly
/// day does not exist that month (31 February), which is no run and no zero.
pub fn due_instant(schedule: Schedule, period_start: i64) -> Option<i64> {
    let minutes = |m: i64| m * 60_000;
    match schedule {
        Schedule::Hourly { minute } => Some(period_start + minutes(minute)),
        Schedule::Daily { hour, minute } => Some(period_start + hour * HOUR_MS + minutes(minute)),
        Schedule::Weekly {
            iso_weekday,
            hour,
            minute,
        } => Some(period_start + (iso_weekday - 1) * DAY_MS + hour * HOUR_MS + minutes(minute)),
        Schedule::Monthly { day, hour, minute } => {
            let (year, month, _) = civil_from_days(period_start.div_euclid(DAY_MS));
            if day > days_in_month(year, month) {
                return None;
            }
            Some(days_from_civil(year, month, day) * DAY_MS + hour * HOUR_MS + minutes(minute))
        }
    }
}

/// `marginMillis(margin)`: a decimal number of seconds as milliseconds, below one truncated. A blank, a non-number, a
/// negative or more than a year is `ops.control_margin_unset`.
pub fn margin_millis(margin: &str) -> Result<i64, ControlError> {
    let unset = || ControlError::code(MARGIN_UNSET);
    let t = service_kit::schema::js_trim(margin);
    if t.is_empty() {
        return Err(unset());
    }
    let scaled = parse_amount(t).map_err(|_| unset())?;
    if scaled < 0 || scaled / SCALE > MAX_MARGIN_SECONDS {
        return Err(unset());
    }
    i64::try_from(scaled / MS_DIVISOR).map_err(|_| unset())
}

/// `readInstant(asOf, margin)`: the as-of less the margin.
pub fn read_instant(as_of: i64, margin: &str) -> Result<i64, ControlError> {
    Ok(as_of - margin_millis(margin)?)
}

/// `assertNotFuture(asOf, now)`.
pub fn assert_not_future(as_of: i64, now: i64) -> Result<(), ControlError> {
    if as_of > now {
        return Err(ControlError::code(ASOF_INVALID));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test: a failure is the point")]
    use super::*;
    use service_kit::time::{Instant, js_date};

    fn at(s: &str) -> i64 {
        js_date(s).unwrap().0
    }

    fn iso(ms: i64) -> String {
        Instant(ms).iso()
    }

    #[test]
    fn periods_are_utc_hours_days_iso_weeks_and_calendar_months() {
        let t = at("2026-03-04T05:06:07.008Z"); // a Wednesday
        let b = period_bounds(Period::Hour, t);
        assert_eq!(
            (iso(b.start), iso(b.end)),
            (
                "2026-03-04T05:00:00.000Z".to_owned(),
                "2026-03-04T06:00:00.000Z".to_owned()
            )
        );
        let b = period_bounds(Period::IsoWeek, t);
        assert_eq!(iso(b.start), "2026-03-02T00:00:00.000Z");
        assert_eq!(iso(b.end), "2026-03-09T00:00:00.000Z");
        // A Sunday belongs to the week that began the Monday before.
        assert_eq!(
            iso(iso_week_start(at("2026-03-08T23:59:59.999Z"))),
            "2026-03-02T00:00:00.000Z"
        );
        let b = period_bounds(Period::Month, at("2026-12-31T23:00:00Z"));
        assert_eq!(iso(b.start), "2026-12-01T00:00:00.000Z");
        assert_eq!(iso(b.end), "2027-01-01T00:00:00.000Z");
    }

    #[test]
    fn a_monthly_day_the_month_lacks_is_never_due() {
        let feb = at("2026-02-01T00:00:00Z");
        let s = Schedule::Monthly {
            day: 31,
            hour: 0,
            minute: 0,
        };
        assert_eq!(due_instant(s, feb), None);
        let s = Schedule::Monthly {
            day: 28,
            hour: 23,
            minute: 59,
        };
        assert_eq!(
            iso(due_instant(s, feb).unwrap()),
            "2026-02-28T23:59:00.000Z"
        );
        let w = Schedule::Weekly {
            iso_weekday: 7,
            hour: 1,
            minute: 2,
        };
        assert_eq!(
            iso(due_instant(w, at("2026-03-02T00:00:00Z")).unwrap()),
            "2026-03-08T01:02:00.000Z"
        );
    }

    #[test]
    fn a_margin_is_seconds_truncated_below_a_millisecond_and_refused_blank_negative_or_past_a_year()
    {
        assert_eq!(margin_millis("0").unwrap(), 0);
        assert_eq!(margin_millis(" 20 ").unwrap(), 20_000);
        assert_eq!(margin_millis("0.0019").unwrap(), 1);
        assert_eq!(margin_millis("31622400").unwrap(), 31_622_400_000);
        for bad in ["", "  ", "x", "-1", "31622401", "99999999"] {
            assert_eq!(
                margin_millis(bad).unwrap_err(),
                ControlError::code(MARGIN_UNSET),
                "{bad}"
            );
        }
    }
}
