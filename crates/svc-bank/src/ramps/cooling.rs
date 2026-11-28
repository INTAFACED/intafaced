//! The owner's cooling-off window on a new withdrawal address (`offramp-cooling.ts`): `BANK_OFFRAMP_COOLING_HOURS`,
//! never defaulted. Zero is no wait.

use service_kit::time::Instant;

use crate::errors::Refusal;
use crate::partner::refuse;

use super::refs::js_trim;

const MS_PER_HOUR: i64 = 60 * 60 * 1000;

fn digits(raw: Option<&str>) -> Option<&str> {
    let t = js_trim(raw.unwrap_or_default());
    (!t.is_empty() && t.bytes().all(|b| b.is_ascii_digit())).then_some(t)
}

/// `Number.parseInt` of a digit string: beyond `i64` it is a period no date reaches, held as `i64::MAX`.
fn hours_of(t: &str) -> i64 {
    t.parse::<i64>().unwrap_or(i64::MAX)
}

/// `requireOfframpCoolingHours`: blank or not a whole number refuses `bank.offramp_cooling_unset`.
pub fn require_hours(raw: Option<&str>) -> Result<i64, Refusal> {
    let t = js_trim(raw.unwrap_or_default());
    if t.is_empty() {
        return Err(refuse(
            "bank.offramp_cooling_unset",
            "BANK_OFFRAMP_COOLING_HOURS is unset — offramp refuses rather than inventing cooling hours",
        ));
    }
    digits(Some(t)).map(hours_of).ok_or_else(|| {
        refuse(
            "bank.offramp_cooling_unset",
            format!(
                "BANK_OFFRAMP_COOLING_HOURS must be a non-negative integer hour count, got '{t}'"
            ),
        )
    })
}

/// `readOfframpCoolingHours`: the window, or `None` when it is not a whole number.
pub fn read_hours(raw: Option<&str>) -> Option<i64> {
    digits(raw).map(hours_of)
}

/// `coolingOffEndsAt`: `None` when the end is past any date JavaScript can hold (an invalid `Date`).
pub fn ends_at(hours: i64, updated_at: Instant) -> Option<Instant> {
    const MAX_DATE_MS: i64 = 8_640_000_000_000_000;
    let end = hours
        .checked_mul(MS_PER_HOUR)
        .and_then(|w| updated_at.0.checked_add(w))?;
    (end.abs() <= MAX_DATE_MS).then_some(Instant(end))
}

/// `assertOfframpDestCoolingElapsed`: inside the window refuses `bank.offramp_cooling_active`.
pub fn assert_elapsed(hours: i64, updated_at: Instant, now: Instant) -> Result<(), Refusal> {
    if hours == 0 {
        return Ok(());
    }
    let elapsed = now.0.saturating_sub(updated_at.0);
    let window = hours.saturating_mul(MS_PER_HOUR);
    if elapsed < window {
        return Err(refuse(
            "bank.offramp_cooling_active",
            format!("Withdraw destination last changed within the owner cooling window ({hours}h)"),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_window_is_read_as_the_typescript_reads_it() {
        assert!(require_hours(None).is_err());
        assert!(require_hours(Some(" -1 ")).is_err());
        assert_eq!(require_hours(Some(" 24 ")).ok(), Some(24));
        assert_eq!(read_hours(Some("1.5")), None);
        assert_eq!(ends_at(1, Instant(0)), Some(Instant(MS_PER_HOUR)));
        assert_eq!(ends_at(i64::MAX, Instant(0)), None);
        assert!(assert_elapsed(0, Instant(10), Instant(0)).is_ok());
        assert!(assert_elapsed(1, Instant(0), Instant(MS_PER_HOUR - 1)).is_err());
        assert!(assert_elapsed(1, Instant(0), Instant(MS_PER_HOUR)).is_ok());
    }
}
