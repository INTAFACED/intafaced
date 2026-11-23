//! The per-address window of `certVerify` (`certs/verify-rate.ts`). The limit and the window are the owner's
//! (`ACADEMY_CERT_VERIFY_RATE_MAX`, `ACADEMY_CERT_VERIFY_RATE_WINDOW_SECONDS`); either blank and the call refuses
//! `academy.verify_rate_unset` without asking this limiter. No default count, no default window.

use std::collections::HashMap;
use std::sync::Mutex;

use service_kit::json::Json;

/// `VerifyRate`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rate {
    pub max: i64,
    pub window_seconds: i64,
}

impl Rate {
    /// Both owner values, or none (`index.ts`).
    pub fn from_settings(settings: &Json) -> Option<Rate> {
        let int = |k: &str| match settings.get(k) {
            Some(Json::Number(n)) =>
            {
                #[allow(
                    clippy::cast_possible_truncation,
                    reason = "env validation admits only whole numbers in a small range"
                )]
                Some(*n as i64)
            }
            _ => None,
        };
        Some(Rate {
            max: int("ACADEMY_CERT_VERIFY_RATE_MAX")?,
            window_seconds: int("ACADEMY_CERT_VERIFY_RATE_WINDOW_SECONDS")?,
        })
    }
}

/// `VerifyRateLimiter`: one process's hits by address, in epoch milliseconds.
pub struct Limiter {
    hits: Mutex<HashMap<String, Vec<i64>>>,
    now: fn() -> i64,
}

/// Whether the call is let through.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Take {
    Ok,
    Limited,
}

fn wall_ms() -> i64 {
    crate::door::system_now().0
}

impl Default for Limiter {
    fn default() -> Limiter {
        Limiter::new(wall_ms)
    }
}

impl Limiter {
    pub fn new(now: fn() -> i64) -> Limiter {
        Limiter {
            hits: Mutex::new(HashMap::new()),
            now,
        }
    }

    /// `take(address, rate)`: `Ok` records the call; `Limited` adds no hit past the cap.
    pub fn take(&self, address: &str, rate: Rate) -> Take {
        let window_ms = rate.window_seconds.saturating_mul(1000);
        let at = (self.now)();
        let mut hits = match self.hits.lock() {
            Ok(h) => h,
            Err(poisoned) => poisoned.into_inner(),
        };
        let kept: Vec<i64> = hits
            .get(address)
            .map(|v| v.iter().copied().filter(|ts| at - ts < window_ms).collect())
            .unwrap_or_default();
        let limited = i64::try_from(kept.len()).unwrap_or(i64::MAX) >= rate.max;
        let mut kept = kept;
        if !limited {
            kept.push(at);
        }
        hits.insert(address.to_owned(), kept);
        if limited { Take::Limited } else { Take::Ok }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_window_lets_max_calls_through_then_limits() {
        let l = Limiter::new(|| 1_000);
        let rate = Rate {
            max: 2,
            window_seconds: 60,
        };
        assert_eq!(l.take("a", rate), Take::Ok);
        assert_eq!(l.take("a", rate), Take::Ok);
        assert_eq!(l.take("a", rate), Take::Limited);
        assert_eq!(l.take("b", rate), Take::Ok);
    }
}
