//! The recovery jobs' timer (`services/svc-bank/src/recovery-jobs.ts`, `startBankRecoveryJobs`): re-drives rows whose
//! ledger answer was lost, every `BANK_RECOVERY_JOBS_INTERVAL_MS` with `BANK_RECOVERY_JOBS_BATCH_LIMIT` rows a job. A
//! blank interval or batch leaves it off, with a warning.
//!
//! One session advisory lock (`pg_try_advisory_lock(hashtext('bank.recovery.jobs'), hashtext('singleton'))`) covers
//! the whole pass, so two replicas never run it together: the one that does not get it skips the pass. The lock is
//! held on its own one-connection pool (`db::open_lock`), never a slot of the request pool the job bodies borrow from.
//! Each job runs in [`JOBS`]' order; a failed one is logged and the rest of the pass still runs. A pass with a failure
//! backs off: the next is `interval × 2^failures` away (at most six doublings, never past an hour); a clean pass resets
//! it.
//!
//! Each job comes with its slice ([`JOBS`]); the binary hands the timer the ones that are ported (`main.rs`).

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use service_kit::pg::Pool;

use crate::db::StoreError;
use crate::door::Slice;
use crate::env::BankEnv;

/// `RECOVERY_LOCK_NAMESPACE` and `RECOVERY_LOCK_KEY`.
pub const LOCK_NAMESPACE: &str = "bank.recovery.jobs";
pub const LOCK_KEY: &str = "singleton";

/// `RECOVERY_INTERVAL_MAX_MS`: the longest a back-off waits.
pub const INTERVAL_MAX: Duration = Duration::from_millis(3_600_000);

/// Every recovery job, in the pass's order, with the slice that owns its work.
pub const JOBS: [(&str, Slice); 7] = [
    ("bank.recovery.resume_pending_loans", Slice::Loans),
    ("bank.recovery.recover_loan_repayments", Slice::Loans),
    ("bank.recovery.resume_pending_earn", Slice::Earn),
    ("bank.recovery.announce_posted_transfers", Slice::Transfers),
    ("bank.recovery.redrive_cash_outs", Slice::PartnerAccount),
    ("bank.recovery.sweep_received_holds", Slice::Transfers),
    ("bank.recovery.deliver_bank_api_webhooks", Slice::BankApi),
];

/// `RecoveryCounts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct RecoveryCounts {
    pub scanned: usize,
    pub resolved: usize,
    pub still_unknown: usize,
}

/// `recoveryCounts(rows)`: a row whose outcome is `failed` stayed unresolved; any other outcome finished.
pub fn recovery_counts<S: AsRef<str>>(outcomes: &[S]) -> RecoveryCounts {
    let still_unknown = outcomes.iter().filter(|o| o.as_ref() == "failed").count();
    RecoveryCounts {
        scanned: outcomes.len(),
        resolved: outcomes.len() - still_unknown,
        still_unknown,
    }
}

/// `recoveryBackoffMs(intervalMs, consecutiveFailures)`.
pub fn backoff(interval: Duration, failures: u32) -> Duration {
    if failures == 0 {
        return interval;
    }
    interval
        .saturating_mul(1 << failures.min(6))
        .min(INTERVAL_MAX)
}

/// The timer's settings, or the warning `startBankRecoveryJobs` gives when one is blank.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Config {
    pub interval: Duration,
    pub batch: u32,
}

/// `BANK_RECOVERY_JOBS_INTERVAL_MS` and `BANK_RECOVERY_JOBS_BATCH_LIMIT`, as `env.ts` read them (unset is the
/// default, blank is `null`).
pub fn config(env: &BankEnv) -> Result<Config, &'static str> {
    let Some(interval) = env
        .int("BANK_RECOVERY_JOBS_INTERVAL_MS")
        .and_then(|n| u64::try_from(n).ok())
    else {
        return Err(
            "BANK_RECOVERY_JOBS_INTERVAL_MS is blank: loan and earn recovery jobs are disabled",
        );
    };
    let Some(batch) = env
        .int("BANK_RECOVERY_JOBS_BATCH_LIMIT")
        .and_then(|n| u32::try_from(n).ok())
    else {
        return Err(
            "BANK_RECOVERY_JOBS_BATCH_LIMIT is blank: loan and earn recovery jobs are disabled",
        );
    };
    Ok(Config {
        interval: Duration::from_millis(interval),
        batch,
    })
}

/// One job's work: given the batch, each row's outcome (`completed`, `open`, `failed`, ...), or why it failed.
pub type Job<'a> = Box<dyn Fn(u32) -> Result<Vec<String>, String> + Sync + 'a>;

/// What the timer tells its log.
pub trait Hooks: Sync {
    fn result(&self, job: &str, counts: RecoveryCounts);
    fn error(&self, job: &str, err: &str);
    fn skip(&self, message: &str);
}

/// Whoever holds the pass's lock.
pub trait Lock: Sync {
    /// Runs `body` while holding the lock; `Ok(false)` when another session holds it, without running `body`.
    fn try_with(&self, body: &mut dyn FnMut()) -> Result<bool, String>;
}

/// The session advisory lock on the timer's own connection (`trySessionAdvisoryLock`): unlocked on the same
/// connection after the body, whatever it did.
pub struct AdvisoryLock(pub Pool);

impl Lock for AdvisoryLock {
    fn try_with(&self, body: &mut dyn FnMut()) -> Result<bool, String> {
        let mut conn = self.0.get().map_err(|e| e.0)?;
        let client = conn.client().map_err(|e| e.0)?;
        let locked: bool = client
            .query_one(
                "SELECT pg_try_advisory_lock(hashtext($1), hashtext($2)) AS locked",
                &[&LOCK_NAMESPACE, &LOCK_KEY],
            )
            .and_then(|r| r.try_get(0))
            .map_err(|e| StoreError::from(e).to_string())?;
        if !locked {
            return Ok(false);
        }
        body();
        client
            .execute(
                "SELECT pg_advisory_unlock(hashtext($1), hashtext($2))",
                &[&LOCK_NAMESPACE, &LOCK_KEY],
            )
            .map_err(|e| StoreError::from(e).to_string())?;
        Ok(true)
    }
}

/// A pass that failed: a job failed or the lock could not be asked. The next pass backs off.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PassFailed;

/// One pass: under the lock, each job in order. `Err` when a job failed or the lock could not be asked, which backs
/// the next pass off.
pub fn pass(
    lock: &dyn Lock,
    jobs: &[(&str, Job<'_>)],
    batch: u32,
    hooks: &dyn Hooks,
) -> Result<(), PassFailed> {
    let mut failed = false;
    let mut body = || {
        for (name, job) in jobs {
            match job(batch) {
                Ok(outcomes) => hooks.result(name, recovery_counts(&outcomes)),
                Err(e) => {
                    failed = true;
                    hooks.error(name, &e);
                }
            }
        }
    };
    match lock.try_with(&mut body) {
        Ok(true) if failed => Err(PassFailed),
        Ok(true) => Ok(()),
        Ok(false) => {
            hooks.skip("bank recovery jobs skipped: another replica holds the lock");
            Ok(())
        }
        Err(e) => {
            hooks.error("bank.recovery.jobs", &e);
            Err(PassFailed)
        }
    }
}

/// The timer: a pass every interval (backed off after a failed one) until `stop` is set. None runs at boot.
pub fn run(
    config: Config,
    stop: &AtomicBool,
    lock: &dyn Lock,
    jobs: &[(&str, Job<'_>)],
    hooks: &dyn Hooks,
) {
    let mut failures: u32 = 0;
    let step = Duration::from_millis(50);
    loop {
        let wait = backoff(config.interval, failures);
        let started = Instant::now();
        while started.elapsed() < wait {
            if stop.load(Ordering::SeqCst) {
                return;
            }
            std::thread::sleep(step.min(wait.saturating_sub(started.elapsed())));
        }
        if stop.load(Ordering::SeqCst) {
            return;
        }
        failures = match pass(lock, jobs, config.batch, hooks) {
            Ok(()) => 0,
            Err(PassFailed) => failures.saturating_add(1),
        };
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test: a failure is the point")]
    use super::*;
    use std::sync::Mutex;

    #[derive(Default)]
    struct Log(Mutex<Vec<String>>);

    impl Hooks for Log {
        fn result(&self, job: &str, c: RecoveryCounts) {
            self.0.lock().unwrap().push(format!(
                "{job} {}/{}/{}",
                c.scanned, c.resolved, c.still_unknown
            ));
        }
        fn error(&self, job: &str, err: &str) {
            self.0.lock().unwrap().push(format!("{job} failed: {err}"));
        }
        fn skip(&self, message: &str) {
            self.0.lock().unwrap().push(message.to_owned());
        }
    }

    struct Held(bool);

    impl Lock for Held {
        fn try_with(&self, body: &mut dyn FnMut()) -> Result<bool, String> {
            if self.0 {
                return Ok(false);
            }
            body();
            Ok(true)
        }
    }

    struct Broken;

    impl Lock for Broken {
        fn try_with(&self, _body: &mut dyn FnMut()) -> Result<bool, String> {
            Err("connection refused".to_owned())
        }
    }

    #[test]
    fn a_failed_row_is_still_unknown_and_every_other_outcome_resolved() {
        assert_eq!(
            recovery_counts(&["completed", "failed", "open"]),
            RecoveryCounts {
                scanned: 3,
                resolved: 2,
                still_unknown: 1
            }
        );
        assert_eq!(recovery_counts::<&str>(&[]), RecoveryCounts::default());
    }

    #[test]
    fn a_failure_doubles_the_wait_six_times_at_most_and_never_past_an_hour() {
        let i = Duration::from_millis(60_000);
        assert_eq!(backoff(i, 0), i);
        assert_eq!(backoff(i, 1), Duration::from_millis(120_000));
        assert_eq!(backoff(i, 5), Duration::from_millis(1_920_000));
        assert_eq!(backoff(i, 6), INTERVAL_MAX);
        assert_eq!(
            backoff(Duration::from_millis(5_000), 6),
            Duration::from_millis(320_000)
        );
        assert_eq!(
            backoff(Duration::from_millis(5_000), 40),
            Duration::from_millis(320_000)
        );
    }

    #[test]
    fn a_failed_job_does_not_stop_the_pass_and_fails_it() {
        let log = Log::default();
        let jobs: Vec<(&str, Job<'_>)> = vec![
            ("a", Box::new(|_| Err("ledger down".to_owned()))),
            (
                "b",
                Box::new(|n| Ok(vec!["completed".to_owned(); n as usize])),
            ),
        ];
        assert_eq!(pass(&Held(false), &jobs, 2, &log), Err(PassFailed));
        assert_eq!(*log.0.lock().unwrap(), ["a failed: ledger down", "b 2/2/0"]);
    }

    #[test]
    fn a_replica_without_the_lock_skips_the_pass_and_a_lock_that_cannot_be_asked_fails_it() {
        let log = Log::default();
        let ran = AtomicBool::new(false);
        let jobs: Vec<(&str, Job<'_>)> = vec![(
            "a",
            Box::new(|_| {
                ran.store(true, Ordering::SeqCst);
                Ok(Vec::new())
            }),
        )];
        assert_eq!(pass(&Held(true), &jobs, 1, &log), Ok(()));
        assert_eq!(pass(&Broken, &jobs, 1, &log), Err(PassFailed));
        assert!(!ran.load(Ordering::SeqCst));
        assert_eq!(
            *log.0.lock().unwrap(),
            [
                "bank recovery jobs skipped: another replica holds the lock",
                "bank.recovery.jobs failed: connection refused"
            ]
        );
    }

    #[test]
    fn the_timer_waits_an_interval_before_its_first_pass_and_stops_when_asked() {
        let log = Log::default();
        let stop = AtomicBool::new(false);
        let passes = std::sync::atomic::AtomicUsize::new(0);
        let jobs: Vec<(&str, Job<'_>)> = vec![(
            "a",
            Box::new(|_| {
                passes.fetch_add(1, Ordering::SeqCst);
                Ok(Vec::new())
            }),
        )];
        let config = Config {
            interval: Duration::from_millis(60),
            batch: 1,
        };
        let started = Instant::now();
        std::thread::scope(|s| {
            s.spawn(|| run(config, &stop, &Held(false), &jobs, &log));
            while passes.load(Ordering::SeqCst) < 2 {
                std::thread::sleep(Duration::from_millis(10));
            }
            stop.store(true, Ordering::SeqCst);
        });
        assert!(started.elapsed() >= Duration::from_millis(120));
    }
}
