//! The timers `index.ts` starts besides the recovery jobs (`recovery`), and the loop that drives each one.
//!
//! [`timers`] is the table: each timer, the slice that owns its work, and its period (none when the value it runs on
//! is blank, which leaves it off). [`every`] runs one timer's job on its period until the stop flag is set, one run at
//! a time, as each timer in `index.ts` never overlaps its last run. A failed run is logged and the next tick retries.
//! A slice that ports a timer's work hands its job to the binary (`main.rs`, `jobs`).

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use crate::door::Slice;
use crate::env::BankEnv;

/// One timer of `index.ts`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Timer {
    pub name: &'static str,
    pub slice: Slice,
    /// `None`: the value it runs on is blank, so `index.ts` never starts it.
    pub every: Option<Duration>,
}

fn ms(env: &BankEnv, key: &str) -> Option<u64> {
    env.int(key).and_then(|n| u64::try_from(n).ok())
}

/// Every timer `index.ts` starts besides the recovery jobs, in its order.
pub fn timers(env: &BankEnv) -> Vec<Timer> {
    vec![
        // The TEST partner watches its TEST pay-in addresses on the TEST chain each second (J-bank-31); whether its rail
        // is wired (`testPayInRailFor`) is the partner slice's to read.
        Timer {
            name: "TEST pay-in chain poll",
            slice: Slice::Partner,
            every: Some(Duration::from_secs(1)),
        },
        // `startStatementJobWorker`: off while the interval or the lease is blank.
        Timer {
            name: "statement export worker",
            slice: Slice::Activity,
            every: ms(env, "BANK_STATEMENT_JOBS_INTERVAL_MS")
                .filter(|_| env.int("BANK_STATEMENT_JOBS_LEASE_MS").is_some())
                .map(Duration::from_millis),
        },
    ]
}

/// Runs `job` every `period` until `stop` is set, the first run a period after the start. Runs never overlap.
/// `failed` gets each failed run's error.
pub fn every(
    period: Duration,
    stop: &AtomicBool,
    job: &dyn Fn() -> Result<(), String>,
    failed: &dyn Fn(&str),
) {
    let step = Duration::from_millis(50);
    loop {
        let started = Instant::now();
        while started.elapsed() < period {
            if stop.load(Ordering::SeqCst) {
                return;
            }
            std::thread::sleep(step.min(period.saturating_sub(started.elapsed())));
        }
        if stop.load(Ordering::SeqCst) {
            return;
        }
        if let Err(e) = job() {
            failed(&e);
        }
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test: a failure is the point")]
    use super::*;
    use std::sync::Mutex;
    use std::sync::atomic::AtomicUsize;

    fn env(extra: &[(&str, &str)]) -> BankEnv {
        crate::env::test_env(extra)
    }

    fn period(t: &[Timer], name: &str) -> Option<Duration> {
        t.iter().find(|t| t.name == name).unwrap().every
    }

    #[test]
    fn the_statement_worker_needs_both_its_interval_and_its_lease() {
        assert_eq!(period(&timers(&env(&[])), "statement export worker"), None);
        let interval_only = env(&[("BANK_STATEMENT_JOBS_INTERVAL_MS", "2000")]);
        assert_eq!(
            period(&timers(&interval_only), "statement export worker"),
            None
        );
        let both = env(&[
            ("BANK_STATEMENT_JOBS_INTERVAL_MS", "2000"),
            ("BANK_STATEMENT_JOBS_LEASE_MS", "30000"),
        ]);
        assert_eq!(
            period(&timers(&both), "statement export worker"),
            Some(Duration::from_millis(2000))
        );
    }

    #[test]
    fn a_timer_runs_on_its_period_and_a_failure_does_not_stop_it() {
        let stop = AtomicBool::new(false);
        let runs = AtomicUsize::new(0);
        let errors = Mutex::new(Vec::new());
        std::thread::scope(|s| {
            s.spawn(|| {
                every(
                    Duration::from_millis(40),
                    &stop,
                    &|| {
                        let n = runs.fetch_add(1, Ordering::SeqCst);
                        if n == 0 {
                            Err("tick failed".to_owned())
                        } else {
                            Ok(())
                        }
                    },
                    &|e| errors.lock().unwrap().push(e.to_owned()),
                );
            });
            while runs.load(Ordering::SeqCst) < 3 {
                std::thread::sleep(Duration::from_millis(10));
            }
            stop.store(true, Ordering::SeqCst);
        });
        assert_eq!(errors.lock().unwrap().as_slice(), ["tick failed"]);
    }
}
