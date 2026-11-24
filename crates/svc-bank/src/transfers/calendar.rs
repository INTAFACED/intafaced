//! `transfers/schedule.ts`: when a standing order's occurrences fall. Occurrence `n` is defined by the order's start, its
//! cadence and `n` alone, never by a counter or a clock reading, so the claim row and the ledger key of an occurrence
//! agree by construction.

use service_kit::time::{Instant, civil_from_days, days_from_civil, days_in_month};

/// `MAX_CATCH_UP_PER_PASS`: how many occurrences one pass may post for one order.
pub const MAX_CATCH_UP_PER_PASS: i64 = 12;

const DAY_MS: i64 = 24 * 60 * 60 * 1000;

/// `ScheduleCadence`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Cadence {
    Daily,
    Weekly,
    Monthly,
    Once,
}

impl Cadence {
    pub fn parse(s: &str) -> Option<Cadence> {
        match s {
            "daily" => Some(Cadence::Daily),
            "weekly" => Some(Cadence::Weekly),
            "monthly" => Some(Cadence::Monthly),
            "once" => Some(Cadence::Once),
            _ => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Cadence::Daily => "daily",
            Cadence::Weekly => "weekly",
            Cadence::Monthly => "monthly",
            Cadence::Once => "once",
        }
    }
}

/// `occurrenceStart`: when occurrence `n` is due. A monthly order on the 31st falls on the last day of a shorter month,
/// at the start's time of day. A one-off has only occurrence 0 (`None` past it).
pub fn occurrence_start(starts_at: Instant, cadence: Cadence, n: i64) -> Option<Instant> {
    if n < 0 {
        return None;
    }
    match cadence {
        Cadence::Once => (n == 0).then_some(starts_at),
        Cadence::Daily => Some(Instant(starts_at.0 + n * DAY_MS)),
        Cadence::Weekly => Some(Instant(starts_at.0 + n * 7 * DAY_MS)),
        Cadence::Monthly => {
            let days = starts_at.0.div_euclid(DAY_MS);
            let time_of_day = starts_at.0.rem_euclid(DAY_MS);
            let (year, month, day) = civil_from_days(days);
            let month0 = month - 1 + n;
            let target_year = year + month0.div_euclid(12);
            let target_month = month0.rem_euclid(12) + 1;
            let d = day.min(days_in_month(target_year, target_month));
            Some(Instant(
                days_from_civil(target_year, target_month, d) * DAY_MS + time_of_day,
            ))
        }
    }
}

/// `occurrenceStart` where the occurrence is known to exist.
fn start(starts_at: Instant, cadence: Cadence, n: i64) -> Instant {
    occurrence_start(starts_at, cadence, n).unwrap_or(starts_at)
}

/// `dueOccurrence`: the highest occurrence due at `now`, or none before the start.
pub fn due_occurrence(starts_at: Instant, cadence: Cadence, now: Instant) -> Option<i64> {
    if now.0 < starts_at.0 {
        return None;
    }
    let elapsed = now.0 - starts_at.0;
    match cadence {
        Cadence::Once => Some(0),
        Cadence::Daily => Some(elapsed.div_euclid(DAY_MS)),
        Cadence::Weekly => Some(elapsed.div_euclid(7 * DAY_MS)),
        Cadence::Monthly => {
            let (sy, sm, _) = civil_from_days(starts_at.0.div_euclid(DAY_MS));
            let (ny, nm, _) = civil_from_days(now.0.div_euclid(DAY_MS));
            let mut n = ((ny - sy) * 12 + (nm - sm)).max(0);
            while n > 0 && start(starts_at, cadence, n).0 > now.0 {
                n -= 1;
            }
            while start(starts_at, cadence, n + 1).0 <= now.0 {
                n += 1;
            }
            Some(n)
        }
    }
}

/// `lastOccurrenceBefore`: the last occurrence strictly before the end; none when there is no end (or it is not after
/// the start). A one-off's is 0.
pub fn last_occurrence_before(
    starts_at: Instant,
    cadence: Cadence,
    ends_at: Option<Instant>,
) -> Option<i64> {
    if cadence == Cadence::Once {
        return Some(0);
    }
    let end = ends_at?;
    if end.0 <= starts_at.0 {
        return None;
    }
    due_occurrence(starts_at, cadence, Instant(end.0 - 1))
}

/// `DuePlan`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DuePlan {
    pub occurrences: Vec<i64>,
    pub next_run_at: Instant,
    pub completed: bool,
}

/// `planDue`: which occurrences a pass fires (at most `max_catch_up`), where the hint goes next, and whether the order is
/// done.
pub fn plan_due(
    starts_at: Instant,
    cadence: Cadence,
    ends_at: Option<Instant>,
    last_fired: Option<i64>,
    now: Instant,
    max_catch_up: i64,
) -> DuePlan {
    let window_end = last_occurrence_before(starts_at, cadence, ends_at);
    let Some(due) = due_occurrence(starts_at, cadence, now) else {
        return DuePlan {
            occurrences: Vec::new(),
            next_run_at: start(starts_at, cadence, 0),
            completed: false,
        };
    };
    let ceiling = window_end.map_or(due, |w| due.min(w));
    let from = last_fired.map_or(0, |l| l + 1);
    if from > ceiling {
        let completed = window_end.is_some_and(|w| from > w);
        return DuePlan {
            occurrences: Vec::new(),
            next_run_at: start(starts_at, cadence, if completed { ceiling } else { from }),
            completed,
        };
    }
    let up_to = ceiling.min(from + max_catch_up - 1);
    let next = up_to + 1;
    let completed = window_end.is_some_and(|w| next > w);
    DuePlan {
        occurrences: (from..=up_to).collect(),
        next_run_at: start(starts_at, cadence, if completed { up_to } else { next }),
        completed,
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test")]
    use super::*;
    use service_kit::time::js_date;

    fn at(s: &str) -> Instant {
        js_date(s).unwrap()
    }

    #[test]
    fn a_monthly_order_on_the_31st_falls_on_the_last_day_of_a_shorter_month() {
        let s = at("2026-01-31T09:00:00.000Z");
        assert_eq!(
            occurrence_start(s, Cadence::Monthly, 1).unwrap().iso(),
            "2026-02-28T09:00:00.000Z"
        );
        assert_eq!(
            occurrence_start(s, Cadence::Monthly, 13).unwrap().iso(),
            "2027-02-28T09:00:00.000Z"
        );
        assert_eq!(
            due_occurrence(s, Cadence::Monthly, at("2026-03-30T00:00:00.000Z")),
            Some(1)
        );
        assert_eq!(
            due_occurrence(s, Cadence::Monthly, at("2026-03-31T09:00:00.000Z")),
            Some(2)
        );
    }

    #[test]
    fn a_plan_stops_at_the_end_and_at_the_catch_up_bound() {
        let s = at("2026-01-01T00:00:00.000Z");
        let p = plan_due(
            s,
            Cadence::Daily,
            Some(at("2026-01-04T00:00:00.000Z")),
            None,
            at("2026-02-01T00:00:00.000Z"),
            12,
        );
        assert_eq!(p.occurrences, vec![0, 1, 2]);
        assert!(p.completed);
        assert_eq!(p.next_run_at.iso(), "2026-01-03T00:00:00.000Z");
        let p = plan_due(
            s,
            Cadence::Daily,
            None,
            Some(1),
            at("2026-02-01T00:00:00.000Z"),
            12,
        );
        assert_eq!(p.occurrences, (2..=13).collect::<Vec<_>>());
        assert!(!p.completed);
        let once = plan_due(
            s,
            Cadence::Once,
            None,
            Some(0),
            at("2026-02-01T00:00:00.000Z"),
            12,
        );
        assert!(once.completed && once.occurrences.is_empty());
    }
}
