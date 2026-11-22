//! The timers `index.ts` starts once the port is open, and the loop that drives each one.
//!
//! [`timers`] is the table: each timer, the slice that owns its work, its period (from the environment where
//! `index.ts` reads one; none when that value is blank, which leaves the timer off), and whether it also runs once at
//! boot. [`every`] runs one timer's job on its period until the stop flag is set, one run at a time, as each
//! `setInterval` in `index.ts` skips a tick while the last run is still going. A failed run is logged and the next tick
//! retries. A slice that ports a timer's work hands its job to the binary (`main.rs`, `jobs`).

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use crate::door::Slice;
use crate::env::AgentsEnv;

/// One timer of `index.ts`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Timer {
    pub name: &'static str,
    pub slice: Slice,
    /// `None`: the value it runs on is blank, so `index.ts` never starts it.
    pub every: Option<Duration>,
    /// Also runs once at boot, before the first period.
    pub at_boot: bool,
}

fn ms(env: &AgentsEnv, key: &str) -> Option<u64> {
    env.int(key).and_then(|n| u64::try_from(n).ok())
}

/// Every timer `index.ts` starts, in its order.
pub fn timers(env: &AgentsEnv) -> Vec<Timer> {
    let step = ms(env, "AGENTS_BACKGROUND_STEP_MS");
    let session_runs = step.filter(|_| env.int("AGENTS_SESSION_RUN_MAX_STEPS").is_some());
    vec![
        // `routeSync.start()`: the founders' confirmed route changes read again every 30 s (another replica's confirm).
        Timer {
            name: "route table sync",
            slice: Slice::Gateway,
            every: Some(Duration::from_secs(30)),
            at_boot: false,
        },
        // `purgeExpiredTranscripts`: once at boot, then hourly.
        Timer {
            name: "transcript purge",
            slice: Slice::Ops,
            every: Some(Duration::from_secs(60 * 60)),
            at_boot: true,
        },
        // `publishUsageAlerts` and `publishApprovalRequests`: once at boot, then each minute.
        Timer {
            name: "unpublished sweep",
            slice: Slice::OwnBuilder,
            every: Some(Duration::from_secs(60)),
            at_boot: true,
        },
        // `evaluateAlertRules`, then `publishAgentAlerts`: each minute.
        Timer {
            name: "alert evaluation",
            slice: Slice::Ops,
            every: Some(Duration::from_secs(60)),
            at_boot: false,
        },
        // `advanceBackgroundRuns`: an own agent's background test runs, one step per period.
        Timer {
            name: "own background test runs",
            slice: Slice::OwnRuns,
            every: step.map(Duration::from_millis),
            at_boot: false,
        },
        // `tickSchedules(autoRuns, AGENTS_SCHEDULE_WORKERS ?? 1)`: the due-run workers.
        Timer {
            name: "schedule workers",
            slice: Slice::OwnRuns,
            every: ms(env, "AGENTS_SCHEDULE_TICK_MS").map(Duration::from_millis),
            at_boot: false,
        },
        // `advanceSessionRuns`, then `publishCompletedRuns`: every `min(AGENTS_BACKGROUND_STEP_MS, 500)` ms, only while
        // `AGENTS_SESSION_RUN_MAX_STEPS` is set too.
        Timer {
            name: "background ticker",
            slice: Slice::Background,
            every: session_runs.map(|s| Duration::from_millis(s.min(500))),
            at_boot: false,
        },
        // `runWebhooks.drain()`: once a second.
        Timer {
            name: "run webhooks",
            slice: Slice::Webhooks,
            every: Some(Duration::from_secs(1)),
            at_boot: false,
        },
    ]
}

/// `AGENTS_SCHEDULE_WORKERS ?? 1`: how many due runs the schedule workers take at once.
pub fn schedule_workers(env: &AgentsEnv) -> u32 {
    env.int("AGENTS_SCHEDULE_WORKERS")
        .and_then(|n| u32::try_from(n).ok())
        .unwrap_or(1)
}

/// Runs `job` every `period` until `stop` is set; `at_boot` runs it once first. Runs never overlap. `failed` gets each
/// failed run's error.
pub fn every(
    period: Duration,
    at_boot: bool,
    stop: &AtomicBool,
    job: &dyn Fn() -> Result<(), String>,
    failed: &dyn Fn(&str),
) {
    let run = || {
        if let Err(e) = job() {
            failed(&e);
        }
    };
    if at_boot && !stop.load(Ordering::SeqCst) {
        run();
    }
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
        run();
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test: a failure is the point")]
    use super::*;
    use std::collections::BTreeMap;
    use std::sync::Mutex;
    use std::sync::atomic::AtomicUsize;

    fn env(extra: &[(&str, &str)]) -> AgentsEnv {
        let mut source: BTreeMap<String, String> = [
            (
                "EDGE_PRINCIPAL_SECRET",
                "placeholder-agents-timers-edge-secret-0000",
            ),
            (
                "INTERNAL_SERVICE_SECRET",
                "placeholder-agents-timers-internal-secret",
            ),
            ("APP_ENV", "test"),
            (
                "DATABASE_URL",
                "postgres://agents:agents@localhost:5432/agents_test",
            ),
            ("DATABASE_POOL_MAX", "4"),
            ("LEDGER_URL", "http://localhost:4001"),
            ("AGENTS_FEE_ASSET_ID", "IFC"),
            ("AGENTS_USAGE_WINDOW_MINUTES", "60"),
            ("AGENTS_METERING_ENABLED", "true"),
        ]
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect();
        for (k, v) in extra {
            source.insert((*k).to_owned(), (*v).to_owned());
        }
        crate::env::load(&source).map_err(|e| e.message).unwrap()
    }

    fn period(timers: &[Timer], name: &str) -> Option<Duration> {
        timers.iter().find(|t| t.name == name).unwrap().every
    }

    #[test]
    fn blank_values_leave_their_timers_off_and_the_fixed_ones_run() {
        let t = timers(&env(&[]));
        assert_eq!(
            period(&t, "transcript purge"),
            Some(Duration::from_secs(3600))
        );
        assert_eq!(
            period(&t, "unpublished sweep"),
            Some(Duration::from_secs(60))
        );
        assert_eq!(
            period(&t, "alert evaluation"),
            Some(Duration::from_secs(60))
        );
        assert_eq!(period(&t, "own background test runs"), None);
        assert_eq!(period(&t, "schedule workers"), None);
        assert_eq!(period(&t, "background ticker"), None);
        assert_eq!(schedule_workers(&env(&[])), 1);
    }

    #[test]
    fn the_session_runs_need_both_values_and_take_at_most_half_a_second() {
        let step_only = timers(&env(&[("AGENTS_BACKGROUND_STEP_MS", "2000")]));
        assert_eq!(period(&step_only, "background ticker"), None);
        assert_eq!(
            period(&step_only, "own background test runs"),
            Some(Duration::from_millis(2000))
        );
        let both = timers(&env(&[
            ("AGENTS_BACKGROUND_STEP_MS", "2000"),
            ("AGENTS_SESSION_RUN_MAX_STEPS", "5"),
            ("AGENTS_SCHEDULE_TICK_MS", "1000"),
            ("AGENTS_SCHEDULE_WORKERS", "3"),
        ]));
        assert_eq!(
            period(&both, "background ticker"),
            Some(Duration::from_millis(500))
        );
        assert_eq!(
            period(&both, "schedule workers"),
            Some(Duration::from_millis(1000))
        );
        let fast = timers(&env(&[
            ("AGENTS_BACKGROUND_STEP_MS", "300"),
            ("AGENTS_SESSION_RUN_MAX_STEPS", "5"),
        ]));
        assert_eq!(
            period(&fast, "background ticker"),
            Some(Duration::from_millis(300))
        );
    }

    #[test]
    fn a_timer_runs_at_boot_then_on_its_period_and_a_failure_does_not_stop_it() {
        let stop = AtomicBool::new(false);
        let runs = AtomicUsize::new(0);
        let errors = Mutex::new(Vec::new());
        std::thread::scope(|s| {
            s.spawn(|| {
                every(
                    Duration::from_millis(60),
                    true,
                    &stop,
                    &|| {
                        let n = runs.fetch_add(1, Ordering::SeqCst);
                        if n == 1 {
                            Err("tick failed".to_owned())
                        } else {
                            Ok(())
                        }
                    },
                    &|e| errors.lock().unwrap().push(e.to_owned()),
                );
            });
            // The boot run happens at once; the period's runs follow.
            while runs.load(Ordering::SeqCst) < 3 {
                std::thread::sleep(Duration::from_millis(10));
            }
            stop.store(true, Ordering::SeqCst);
        });
        assert!(runs.load(Ordering::SeqCst) >= 3);
        assert_eq!(errors.lock().unwrap().as_slice(), ["tick failed"]);
    }

    #[test]
    fn a_timer_without_a_boot_run_waits_a_period_and_stops_when_asked() {
        let stop = AtomicBool::new(false);
        let runs = AtomicUsize::new(0);
        let started = Instant::now();
        std::thread::scope(|s| {
            s.spawn(|| {
                every(
                    Duration::from_millis(200),
                    false,
                    &stop,
                    &|| {
                        runs.fetch_add(1, Ordering::SeqCst);
                        Ok(())
                    },
                    &|_| {},
                );
            });
            std::thread::sleep(Duration::from_millis(80));
            stop.store(true, Ordering::SeqCst);
        });
        assert_eq!(runs.load(Ordering::SeqCst), 0);
        assert!(started.elapsed() < Duration::from_millis(200));
    }
}
