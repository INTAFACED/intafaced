//! The clock integrity read (`services/svc-ledger/src/ledger/clock-skew.ts`, `LedgerService.clockSkew`): the app's
//! clock against `clock_timestamp()`, held to the owner's `LEDGER_CLOCK_SKEW_BOUND_MS`.
//!
//! A blank bound is not a bound: the read answers `ledger.skew_bound_unset` and never invents 0 or unlimited. An
//! explicit 0 is real: any difference exceeds it. The app clock is taken at the midpoint of the database read, so the
//! round trip itself is not counted as skew.

use service_kit::json::Json;
use service_kit::time::Instant;

use crate::db::{Store, StoreError, with_client};

/// `SKEW_BOUND_UNSET`.
pub const SKEW_BOUND_UNSET: &str = "ledger.skew_bound_unset";
/// `WRITES_BLOCKED_CLOCK_SKEW`.
pub const WRITES_BLOCKED_CLOCK_SKEW: &str = "ledger.writes_blocked_clock_skew";

/// `ClockSkewView`. Instants are milliseconds since the epoch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct View {
    pub ok: bool,
    pub code: Option<&'static str>,
    /// None when the owner has not set a bound. Never a made-up number.
    pub bound_ms: Option<i64>,
    pub skew_ms: i128,
    pub app_now: i64,
    pub database_now: i64,
}

impl View {
    /// The body the door answers, in `assessClockSkew`'s key order.
    pub fn json(&self) -> Json {
        Json::obj([
            ("ok", Json::Bool(self.ok)),
            ("code", self.code.map_or(Json::Null, Json::str)),
            (
                "boundMs",
                self.bound_ms
                    .map_or(Json::Null, |b| Json::str(b.to_string())),
            ),
            ("skewMs", Json::str(self.skew_ms.to_string())),
            ("appNow", Json::str(Instant(self.app_now).iso())),
            ("databaseNow", Json::str(Instant(self.database_now).iso())),
        ])
    }
}

/// `assessClockSkew({ boundMs, appNow, databaseNow })`.
pub fn assess(bound_ms: Option<i64>, app_now: i64, database_now: i64) -> View {
    let skew_ms = (i128::from(app_now) - i128::from(database_now)).abs();
    let (ok, code) = match bound_ms {
        None => (false, Some(SKEW_BOUND_UNSET)),
        Some(b) if skew_ms > i128::from(b) => (false, Some(WRITES_BLOCKED_CLOCK_SKEW)),
        Some(_) => (true, None),
    };
    View {
        ok,
        code,
        bound_ms,
        skew_ms,
        app_now,
        database_now,
    }
}

/// `sampleClocks(now, readNow)`: the app clock at the midpoint of the read, and the database's.
pub fn sample(
    now: fn() -> i64,
    read_now: impl FnOnce() -> Result<i64, StoreError>,
) -> Result<(i64, i64), StoreError> {
    let before = now();
    let database_now = read_now()?;
    let after = now();
    Ok((before + (after - before).div_euclid(2), database_now))
}

/// `readDatabaseNow(sql)`: `clock_timestamp()` as a JavaScript `Date` holds it, whole milliseconds.
pub fn read_database_now(store: &Store) -> Result<i64, StoreError> {
    with_client(store.pool()?, |c| {
        Ok(c.query_one(
            "SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::int8",
            &[],
        )?
        .try_get(0)?)
    })
}

/// `LedgerService.clockSkew()`.
pub fn clock_skew(
    store: &Store,
    bound_ms: Option<i64>,
    now: fn() -> i64,
) -> Result<View, StoreError> {
    let (app_now, database_now) = sample(now, || read_database_now(store))?;
    Ok(assess(bound_ms, app_now, database_now))
}

/// The wall clock in milliseconds.
pub fn system_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test: a failure is the point")]
    use std::sync::atomic::{AtomicI64, Ordering};

    use super::*;

    // `clock-skew.test.ts`, `assessClockSkew` and `sampleClocks`, case for case.
    #[test]
    fn a_blank_bound_refuses_and_invents_none() {
        let v = assess(None, 1_000, 1_000);
        assert_eq!(
            (v.ok, v.code, v.bound_ms),
            (false, Some(SKEW_BOUND_UNSET), None)
        );
        assert_eq!(
            v.json().compact(),
            r#"{"ok":false,"code":"ledger.skew_bound_unset","boundMs":null,"skewMs":"0","appNow":"1970-01-01T00:00:01.000Z","databaseNow":"1970-01-01T00:00:01.000Z"}"#
        );
    }

    #[test]
    fn an_explicit_zero_allows_only_matching_clocks() {
        assert!(assess(Some(0), 5, 5).ok);
        let v = assess(Some(0), 6, 5);
        assert_eq!((v.ok, v.code), (false, Some(WRITES_BLOCKED_CLOCK_SKEW)));
        assert_eq!(v.skew_ms, 1);
    }

    #[test]
    fn a_difference_equal_to_the_bound_passes_and_one_past_blocks() {
        assert!(assess(Some(250), 1_000, 1_250).ok);
        assert!(assess(Some(250), 1_250, 1_000).ok);
        let v = assess(Some(250), 1_000, 1_251);
        assert_eq!((v.ok, v.code), (false, Some(WRITES_BLOCKED_CLOCK_SKEW)));
        assert_eq!(v.json().get("boundMs"), Some(&Json::str("250")));
    }

    static TICK: AtomicI64 = AtomicI64::new(0);

    fn ticking() -> i64 {
        TICK.fetch_add(100, Ordering::SeqCst)
    }

    #[test]
    fn the_round_trip_is_not_counted_as_skew() {
        TICK.store(1_000, Ordering::SeqCst);
        let (app, db) = sample(ticking, || Ok(1_050)).unwrap();
        assert_eq!((app, db), (1_050, 1_050));
        assert!(assess(Some(0), app, db).ok);
    }
}
