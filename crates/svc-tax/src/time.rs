//! UTC time as JavaScript's `Date` holds it: whole milliseconds since 1970-01-01T00:00:00Z.

/// A moment, in milliseconds since the Unix epoch (UTC), as `Date#getTime()` gives it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct Instant(pub i64);

const DAY_MS: i64 = 86_400_000;

/// Days from 1970-01-01 to a proleptic Gregorian date (Howard Hinnant's `days_from_civil`).
pub fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// The date of a day number from 1970-01-01: (year, month 1-12, day 1-31).
pub fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

pub fn is_leap(year: i64) -> bool {
    year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
}

pub fn days_in_month(year: i64, month: i64) -> i64 {
    match month {
        2 if is_leap(year) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

impl Instant {
    /// `Date.UTC(year, monthIndex0, 1)` for January: the first moment of a year.
    pub fn start_of_year(year: i64) -> Instant {
        Instant(days_from_civil(year, 1, 1) * DAY_MS)
    }

    /// The UTC calendar year.
    pub fn year(self) -> i64 {
        civil_from_days(self.0.div_euclid(DAY_MS)).0
    }

    /// `Date#toISOString()`: `YYYY-MM-DDTHH:mm:ss.sssZ`, with a signed six-digit year outside 0000-9999.
    pub fn iso(self) -> String {
        let days = self.0.div_euclid(DAY_MS);
        let ms = self.0.rem_euclid(DAY_MS);
        let (y, m, d) = civil_from_days(days);
        let year = if (0..=9999).contains(&y) {
            format!("{y:04}")
        } else if y < 0 {
            format!("-{:06}", -y)
        } else {
            format!("+{y:06}")
        };
        format!(
            "{year}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z",
            ms / 3_600_000,
            ms / 60_000 % 60,
            ms / 1000 % 60,
            ms % 1000
        )
    }
}

fn two(b: &[u8], at: usize) -> Option<i64> {
    match (b.get(at), b.get(at + 1)) {
        (Some(x @ b'0'..=b'9'), Some(y @ b'0'..=b'9')) => {
            Some(i64::from(x - b'0') * 10 + i64::from(y - b'0'))
        }
        _ => None,
    }
}

fn digits(b: &[u8]) -> Option<i64> {
    if b.is_empty() || !b.iter().all(u8::is_ascii_digit) {
        return None;
    }
    b.iter().try_fold(0i64, |n, d| {
        n.checked_mul(10)?.checked_add(i64::from(d - b'0'))
    })
}

/// What zod's `z.string().datetime({ offset })` accepts (zod 4, no precision set): a real calendar date with a four-digit
/// year, `T`, `HH:mm:ss`, an optional fraction of any length, then `Z` or, with `offset`, `±HH:mm`. Returns the moment,
/// as `new Date(text)` reads it (the fraction cut to milliseconds).
pub fn zod_datetime(text: &str, offset: bool) -> Option<Instant> {
    let b = text.as_bytes();
    if b.len() < 20
        || b.get(4) != Some(&b'-')
        || b.get(7) != Some(&b'-')
        || b.get(10) != Some(&b'T')
    {
        return None;
    }
    let year = digits(b.get(0..4)?)?;
    let (month, day) = (two(b, 5)?, two(b, 8)?);
    if !(1..=12).contains(&month) || day < 1 || day > days_in_month(year, month) {
        return None;
    }
    if b.get(13) != Some(&b':') || b.get(16) != Some(&b':') {
        return None;
    }
    let (h, mi, s) = (two(b, 11)?, two(b, 14)?, two(b, 17)?);
    if h > 23 || mi > 59 || s > 59 {
        return None;
    }
    let mut i = 19;
    let mut ms = 0i64;
    if b.get(i) == Some(&b'.') {
        let start = i + 1;
        i = start;
        while b.get(i).is_some_and(u8::is_ascii_digit) {
            i += 1;
        }
        if i == start {
            return None;
        }
        let frac = b.get(start..i)?;
        for k in 0..3 {
            ms = ms * 10 + frac.get(k).map_or(0, |d| i64::from(d - b'0'));
        }
    }
    let shift = match b.get(i..)? {
        b"Z" => 0,
        [sign @ (b'+' | b'-'), _, _, b':', _, _] if offset => {
            let (oh, om) = (two(b, i + 1)?, two(b, i + 4)?);
            if oh > 23 || om > 59 {
                return None;
            }
            let minutes = oh * 60 + om;
            if *sign == b'+' { minutes } else { -minutes }
        }
        _ => return None,
    };
    let day_ms = days_from_civil(year, month, day) * DAY_MS;
    Some(Instant(
        day_ms + ((h * 60 + mi - shift) * 60 + s) * 1000 + ms,
    ))
}

/// `Date.parse(`${day}T00:00:00Z`)` for the forms ECMAScript's date-time string format gives a meaning (`YYYY`,
/// `YYYY-MM`, `YYYY-MM-DD`, with a `±YYYYYY` expanded year), or `None` where it is NaN. V8 falls back to a legacy parser
/// for other text; the one place this is read (`tax.setDayMethod`'s day check) only passes a day whose ISO form starts
/// with the text, which no legacy-only form does.
pub fn es_date_at_midnight(day: &str) -> Option<Instant> {
    let b = day.as_bytes();
    let (year, rest) = match b.first()? {
        b'+' | b'-' => {
            let y = digits(b.get(1..7)?)?;
            if b.first() == Some(&b'-') && y == 0 {
                return None; // -000000 is not a year
            }
            (if b.first() == Some(&b'-') { -y } else { y }, b.get(7..)?)
        }
        _ => (digits(b.get(0..4)?)?, b.get(4..)?),
    };
    let (month, day_of_month) = match rest {
        [] => (1, 1),
        [b'-', ..] if rest.len() == 3 => (two(rest, 1)?, 1),
        [b'-', _, _, b'-', _, _] => (two(rest, 1)?, two(rest, 4)?),
        _ => return None,
    };
    // V8 checks each field's range on its own (any month may reach day 31); MakeDay then rolls a day past the month's end
    // into the next month, which the caller's ISO comparison catches.
    if !(1..=12).contains(&month) || !(1..=31).contains(&day_of_month) {
        return None;
    }
    let first = days_from_civil(year, month, 1);
    let ms = (first + day_of_month - 1) * DAY_MS;
    // ECMAScript's time range: ±8.64e15 ms.
    (ms.abs() <= 8_640_000_000_000_000).then_some(Instant(ms))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_iso_as_javascript_does() {
        assert_eq!(Instant(0).iso(), "1970-01-01T00:00:00.000Z");
        assert_eq!(Instant(1_795_046_400_000).iso(), "2026-11-19T00:00:00.000Z");
        assert_eq!(
            Instant(-62_198_755_200_000).iso(),
            "-000001-01-01T00:00:00.000Z"
        );
        assert_eq!(
            Instant::start_of_year(2016).iso(),
            "2016-01-01T00:00:00.000Z"
        );
    }

    #[test]
    fn reads_zod_datetimes() {
        assert_eq!(
            zod_datetime("2026-01-01T00:00:00Z", true),
            Some(Instant(1_767_225_600_000))
        );
        assert_eq!(
            zod_datetime("2026-01-01T08:00:00.1239+08:00", true),
            Some(Instant(1_767_225_600_123))
        );
        assert_eq!(zod_datetime("2026-01-01T00:00:00+08:00", false), None);
        assert_eq!(zod_datetime("2026-02-29T00:00:00Z", true), None);
        assert_eq!(zod_datetime("2026-01-01T00:00Z", true), None);
        assert_eq!(zod_datetime("2026-01-01t00:00:00Z", true), None);
    }
}
