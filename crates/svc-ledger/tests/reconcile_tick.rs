//! The hourly tick with no book: `scheduled-reconcile-tick.test.ts`'s "returned result" and "staleness reporting"
//! cases and its fake-ledger real-book cases, case for case, against a ledger that records what it is asked.
#![allow(
    clippy::unwrap_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use std::cell::{Cell, RefCell};
use std::io::Write;
use std::sync::{Arc, Mutex};

use service_kit::json::{self, Json};
use service_kit::telemetry::Logger;
use service_kit::time::Instant;
use svc_ledger::db::StoreError;
use svc_ledger::reconcile::{
    Balances, Chain, LastVerified, Phase, ProofError, ProofWord, Report, SnapshotRun, Tip,
};
use svc_ledger::reconciler::{IncompleteAlert, TickLedger, TickOptions, TickState, tick};

const FROZEN_LOG: &str =
    "LEDGER RECONCILIATION FAILED — posting frozen, operator attention required";
const INCOMPLETE_LOG: &str = "LEDGER RECONCILIATION INCOMPLETE — the book was NOT verified and NOT frozen, operator attention required";
const UNPROVEN_LOG: &str = "LEDGER RECONCILIATION UNPROVEN — posting frozen after consecutive incomplete runs, operator attention required";
const STALE_LOG: &str = "LEDGER RECONCILIATION STALE — the book is NOT verified, posting unchanged, operator attention required";
const HOUR: i64 = 3_600_000;
/// 2026-10-14T12:00:00.000Z.
const NOW: i64 = 1_791_979_200_000;

fn now() -> i64 {
    NOW
}

#[derive(Clone, Default)]
struct Sink(Arc<Mutex<Vec<u8>>>);

impl Write for Sink {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl Sink {
    fn logger(&self) -> Logger {
        Logger::new("info", Box::new(self.clone()))
    }
    fn lines(&self, level: i64) -> Vec<Json> {
        String::from_utf8(self.0.lock().unwrap().clone())
            .unwrap()
            .lines()
            .map(|l| json::parse(l).unwrap())
            .filter(|j| j.get("level") == Some(&Json::int(level)))
            .collect()
    }
    fn fatal(&self) -> Vec<Json> {
        self.lines(60)
    }
    fn messages(&self) -> Vec<String> {
        self.fatal()
            .iter()
            .map(|j| match j.get("msg") {
                Some(Json::String(m)) => m.clone(),
                _ => String::new(),
            })
            .collect()
    }
}

/// A ledger that records every freeze and alert it is asked for.
#[derive(Default)]
struct Recording {
    froze: RefCell<Vec<(String, String)>>,
    alerted: RefCell<Vec<IncompleteAlert>>,
    last: Option<Result<LastVerified, StoreError>>,
    durable: Option<Cell<Result<i64, ()>>>,
    freeze_fails: Option<StoreError>,
    halted: Option<bool>,
    /// A due-controls hook that throws, and whether it was called; none without one.
    controls_throw: bool,
    controls_called: Cell<bool>,
}

impl TickLedger for Recording {
    fn freeze(&self, reason: &str, actor: &str) -> Result<(), StoreError> {
        if let Some(e) = &self.freeze_fails {
            return Err(e.clone());
        }
        self.froze
            .borrow_mut()
            .push((reason.to_owned(), actor.to_owned()));
        Ok(())
    }
    fn posting_enabled(&self) -> Option<Result<bool, StoreError>> {
        self.halted.map(|h| Ok(!h))
    }
    fn last_verified(&self) -> Option<Result<LastVerified, StoreError>> {
        self.last.clone()
    }
    fn alert_incomplete(&self, alert: &IncompleteAlert) -> Option<Result<(), StoreError>> {
        self.alerted.borrow_mut().push(alert.clone());
        Some(Ok(()))
    }
    fn consecutive_incomplete(&self) -> Option<Result<i64, StoreError>> {
        self.durable.as_ref().map(|d| {
            d.get()
                .map_err(|()| StoreError::new("streak read failed", None))
        })
    }
    fn run_due_controls(
        &self,
    ) -> Option<Result<Vec<svc_ledger::controls::ScheduleFailed>, String>> {
        if !self.controls_throw {
            return None;
        }
        self.controls_called.set(true);
        Some(Err("control store down".to_owned()))
    }
}

fn verified(hours_ago: Option<i64>, seq: Option<&str>, first: Option<i64>) -> LastVerified {
    LastVerified {
        at_ms: hours_ago.map(|h| NOW - h * HOUR),
        seq: seq.map(str::to_owned),
        first_attempt_ms: first.map(|h| NOW - h * HOUR),
    }
}

fn report(ok: bool) -> Report {
    Report {
        ok,
        ran_at_ms: NOW,
        balances: Balances {
            ok: true,
            drift: Vec::new(),
            accounts_checked: 0,
        },
        chain: if ok {
            Chain::Ok { length: 0 }
        } else {
            Chain::Broken {
                broken_at: "chain_tip".to_owned(),
                length: 0,
            }
        },
        totals: Vec::new(),
        unbalanced_assets: Vec::new(),
        result: if ok {
            ProofWord::NothingToCompare
        } else {
            ProofWord::Mismatch
        },
        customer_balances: None,
        incomplete_checks: Vec::new(),
        corrupt_amount_fields: Vec::new(),
    }
}

fn mismatch() -> Result<SnapshotRun, StoreError> {
    Ok(SnapshotRun::Mismatch {
        report: report(false),
        tip: None,
        run_id: Some("1".to_owned()),
        record_error: None,
    })
}

fn green() -> Result<SnapshotRun, StoreError> {
    Ok(SnapshotRun::Ok {
        report: report(true),
        tip: Tip {
            seq: "0".to_owned(),
            hash: None,
            through_entry_id: None,
            snapshot_at_ms: NOW,
        },
        run_id: "1".to_owned(),
    })
}

fn incomplete_with(code: &str) -> Result<SnapshotRun, StoreError> {
    Ok(SnapshotRun::Incomplete {
        phase: Phase::Proof,
        error: ProofError::Failed(StoreError::new(
            "canceling statement due to statement timeout",
            Some(code),
        )),
        error_code: code.to_owned(),
        run_id: Some("7".to_owned()),
        record_error: None,
    })
}

fn incomplete() -> Result<SnapshotRun, StoreError> {
    incomplete_with("57014")
}

fn options(max_stale_hours: Option<i64>, max: i64) -> TickOptions {
    TickOptions {
        max_stale_hours,
        max_consecutive_incomplete: max,
        now_ms: now,
    }
}

fn alert(code: &str, phase: &'static str, n: i64, run: Option<&str>) -> IncompleteAlert {
    IncompleteAlert {
        error_code: code.to_owned(),
        phase,
        consecutive_incomplete: n,
        run_id: run.map(str::to_owned),
    }
}

fn once(
    run: &dyn Fn() -> Result<SnapshotRun, StoreError>,
    ledger: &Recording,
    sink: &Sink,
) -> Result<(), StoreError> {
    tick(
        run,
        ledger,
        &sink.logger(),
        &mut TickState::new(NOW),
        &options(None, 3),
    )
}

#[test]
fn a_returned_mismatch_pages_and_does_not_freeze_again() {
    let (sink, ledger) = (Sink::default(), Recording::default());
    once(&mismatch, &ledger, &sink).unwrap();
    assert!(ledger.froze.borrow().is_empty());
    assert_eq!(sink.messages(), [FROZEN_LOG]);
    let line = &sink.fatal()[0];
    assert_eq!(
        line.get("report").unwrap().get("ok"),
        Some(&Json::Bool(false))
    );
    assert_eq!(line.get("snapshotted"), Some(&Json::Bool(false)));
}

#[test]
fn a_green_run_or_a_skipped_one_stays_quiet_and_changes_nothing() {
    let (sink, ledger) = (Sink::default(), Recording::default());
    once(&green, &ledger, &sink).unwrap();
    let mut state = TickState::new(NOW);
    tick(
        &|| Ok(SnapshotRun::Skipped),
        &ledger,
        &sink.logger(),
        &mut state,
        &options(None, 3),
    )
    .unwrap();
    assert!(ledger.froze.borrow().is_empty());
    assert!(sink.fatal().is_empty());
    assert_eq!((state.consecutive_incomplete, state.skip_ticks), (0, 0));
}

#[test]
fn an_incomplete_run_pages_alerts_and_freezes_nothing() {
    let (sink, ledger) = (Sink::default(), Recording::default());
    once(&incomplete, &ledger, &sink).unwrap();
    assert!(ledger.froze.borrow().is_empty());
    assert_eq!(
        *ledger.alerted.borrow(),
        [alert("57014", "proof", 1, Some("7"))]
    );
    assert_eq!(sink.messages(), [INCOMPLETE_LOG]);
    let line = &sink.fatal()[0];
    for (k, v) in [
        ("outcome", Json::str("incomplete")),
        ("errorCode", Json::str("57014")),
        ("phase", Json::str("proof")),
        ("runId", Json::str("7")),
        ("consecutiveIncomplete", Json::int(1)),
    ] {
        assert_eq!(line.get(k), Some(&v), "{k}");
    }
}

#[test]
fn a_thrown_run_is_incomplete_below_n_with_its_code_or_unknown() {
    for (code, want) in [
        (None, "unknown"),
        (Some("CONNECTION_CLOSED"), "CONNECTION_CLOSED"),
        (Some("57014"), "57014"),
    ] {
        let (sink, ledger) = (Sink::default(), Recording::default());
        let run = || Err(StoreError::new("scheduled reconciliation threw", code));
        once(&run, &ledger, &sink).unwrap();
        assert!(ledger.froze.borrow().is_empty());
        assert_eq!(*ledger.alerted.borrow(), [alert(want, "tick", 1, None)]);
        assert_eq!(sink.messages(), [INCOMPLETE_LOG]);
    }
}

#[test]
fn the_durable_streak_ahead_of_this_process_freezes_and_backoff_follows_the_in_memory_count() {
    let sink = Sink::default();
    let ledger = Recording {
        durable: Some(Cell::new(Ok(2))),
        ..Recording::default()
    };
    let mut state = TickState::new(NOW);
    let run = || incomplete_with("unknown");
    tick(&run, &ledger, &sink.logger(), &mut state, &options(None, 3)).unwrap();
    assert!(ledger.froze.borrow().is_empty());
    assert_eq!(state.consecutive_incomplete, 1);
    assert_eq!(state.skip_ticks, 0);
    ledger.durable.as_ref().unwrap().set(Ok(3));
    tick(&run, &ledger, &sink.logger(), &mut state, &options(None, 3)).unwrap();
    assert_eq!(
        *ledger.froze.borrow(),
        [("reconcile_unproven".to_owned(), "reconciliation".to_owned())]
    );
    let streak: Vec<i64> = ledger
        .alerted
        .borrow()
        .iter()
        .map(|a| a.consecutive_incomplete)
        .collect();
    assert_eq!(streak, [2, 3]);
    assert_eq!((state.consecutive_incomplete, state.skip_ticks), (2, 1));
    assert_eq!(sink.messages(), [INCOMPLETE_LOG, UNPROVEN_LOG]);
}

#[test]
fn an_unreadable_durable_streak_falls_back_to_the_in_memory_count() {
    let sink = Sink::default();
    let ledger = Recording {
        durable: Some(Cell::new(Err(()))),
        ..Recording::default()
    };
    once(&incomplete, &ledger, &sink).unwrap();
    assert!(ledger.froze.borrow().is_empty());
    assert_eq!(
        *ledger.alerted.borrow(),
        [alert("57014", "proof", 1, Some("7"))]
    );
    assert_eq!(
        sink.messages(),
        [
            "LEDGER RECONCILIATION STREAK UNREADABLE — using the in-memory incomplete count",
            INCOMPLETE_LOG
        ]
    );
}

#[test]
fn the_nth_incomplete_run_in_a_row_freezes_as_unproven_and_every_one_alerts() {
    let (sink, ledger) = (Sink::default(), Recording::default());
    let mut state = TickState::new(NOW);
    let mut go = || {
        tick(
            &incomplete,
            &ledger,
            &sink.logger(),
            &mut state,
            &options(None, 3),
        )
        .unwrap();
    };
    go();
    go();
    assert!(ledger.froze.borrow().is_empty());
    go(); // backed off
    assert_eq!(ledger.alerted.borrow().len(), 2);
    go();
    assert_eq!(
        *ledger.froze.borrow(),
        [("reconcile_unproven".to_owned(), "reconciliation".to_owned())]
    );
    let streak: Vec<i64> = ledger
        .alerted
        .borrow()
        .iter()
        .map(|a| a.consecutive_incomplete)
        .collect();
    assert_eq!(streak, [1, 2, 3]);
    assert_eq!(
        sink.messages(),
        [INCOMPLETE_LOG, INCOMPLETE_LOG, UNPROVEN_LOG]
    );
}

#[test]
fn backoff_spans_ticks_and_one_ok_run_resets_it() {
    let (sink, ledger) = (Sink::default(), Recording::default());
    let mut state = TickState::new(NOW);
    let runs = Cell::new(0);
    let mut go = |result: fn() -> Result<SnapshotRun, StoreError>| {
        let run = || {
            runs.set(runs.get() + 1);
            result()
        };
        tick(
            &run,
            &ledger,
            &sink.logger(),
            &mut state,
            &options(None, 100),
        )
        .unwrap();
    };
    go(incomplete); // run 1, skip 0
    go(incomplete); // run 2, skip 1
    assert_eq!(runs.get(), 2);
    go(green); // skipped
    assert_eq!(runs.get(), 2);
    go(incomplete); // run 3, skip 3
    assert_eq!(runs.get(), 3);
    go(green);
    go(green);
    go(green);
    assert_eq!(runs.get(), 3);
    go(green); // run 4: ok resets
    assert_eq!(runs.get(), 4);
    assert_eq!((state.consecutive_incomplete, state.skip_ticks), (0, 0));
}

fn freeze_failed() -> Result<SnapshotRun, StoreError> {
    Err(StoreError::new(
        "found a mismatch, the freeze did not land",
        Some("ledger.reconcile_freeze_failed"),
    ))
}

#[test]
fn a_mismatch_whose_freeze_did_not_land_tries_the_freeze_once_more() {
    let (sink, ledger) = (Sink::default(), Recording::default());
    once(&freeze_failed, &ledger, &sink).unwrap();
    assert_eq!(
        *ledger.froze.borrow(),
        [(
            "reconciliation mismatch".to_owned(),
            "reconciliation".to_owned()
        )]
    );
    assert_eq!(sink.messages(), [FROZEN_LOG]);
}

#[test]
fn a_freeze_that_throws_after_posting_halted_still_pages_as_frozen() {
    let sink = Sink::default();
    let ledger = Recording {
        freeze_fails: Some(StoreError::new("bus down after the switch committed", None)),
        halted: Some(true),
        ..Recording::default()
    };
    once(&freeze_failed, &ledger, &sink).unwrap();
    assert_eq!(sink.messages(), [FROZEN_LOG]);
    assert_eq!(
        sink.fatal()[0].get("err").unwrap().get("code"),
        Some(&Json::str("ledger.reconcile_freeze_failed"))
    );
}

#[test]
fn a_freeze_write_that_fails_is_returned_and_never_claimed_as_frozen() {
    let sink = Sink::default();
    let ledger = Recording {
        freeze_fails: Some(StoreError::new("posting_freeze write failed", None)),
        ..Recording::default()
    };
    let e = once(&freeze_failed, &ledger, &sink).unwrap_err();
    assert_eq!(e.message, "posting_freeze write failed");
    assert!(sink.fatal().is_empty());
}

// ── staleness reporting ─────────────────────────────────────────────────────────────────────────────────────────────

fn with_last(last: LastVerified) -> Recording {
    Recording {
        last: Some(Ok(last)),
        ..Recording::default()
    }
}

#[test]
fn an_ok_run_older_than_the_limit_is_reported_without_freezing() {
    let sink = Sink::default();
    let ledger = with_last(verified(Some(25), Some("41"), None));
    tick(
        &incomplete,
        &ledger,
        &sink.logger(),
        &mut TickState::new(NOW),
        &options(Some(24), 3),
    )
    .unwrap();
    assert!(ledger.froze.borrow().is_empty());
    assert_eq!(sink.messages(), [INCOMPLETE_LOG, STALE_LOG]);
    let line = &sink.fatal()[1];
    assert_eq!(line.get("lastVerifiedSeq"), Some(&Json::str("41")));
    assert_eq!(line.get("maxStaleHours"), Some(&Json::int(24)));
}

#[test]
fn an_ok_run_inside_the_limit_is_logged_and_freezes_nothing() {
    let sink = Sink::default();
    let ledger = with_last(verified(Some(23), Some("41"), None));
    tick(
        &incomplete,
        &ledger,
        &sink.logger(),
        &mut TickState::new(NOW),
        &options(Some(24), 3),
    )
    .unwrap();
    assert!(ledger.froze.borrow().is_empty());
    assert_eq!(sink.messages(), [INCOMPLETE_LOG]);
    let info = sink
        .lines(30)
        .into_iter()
        .find(|j| j.get("msg") == Some(&Json::str("reconciliation last verified")))
        .unwrap();
    assert_eq!(
        info.get("lastVerifiedAt"),
        Some(&Json::str(Instant(NOW - 23 * HOUR).iso()))
    );
    assert_eq!(info.get("lastVerifiedSeq"), Some(&Json::str("41")));
}

#[test]
fn staleness_is_checked_on_a_backed_off_tick_too() {
    let sink = Sink::default();
    let ledger = with_last(verified(Some(30), Some("41"), None));
    let mut state = TickState::new(NOW);
    state.skip_ticks = 3;
    let ran = Cell::new(false);
    let run = || {
        ran.set(true);
        green()
    };
    tick(
        &run,
        &ledger,
        &sink.logger(),
        &mut state,
        &options(Some(24), 3),
    )
    .unwrap();
    assert!(!ran.get());
    assert!(ledger.froze.borrow().is_empty());
    assert_eq!(sink.messages(), [STALE_LOG]);
}

#[test]
fn never_verified_is_measured_from_the_first_attempt_else_from_boot() {
    let sink = Sink::default();
    let first = with_last(verified(None, None, Some(30)));
    tick(
        &incomplete,
        &first,
        &sink.logger(),
        &mut TickState::new(NOW),
        &options(Some(24), 3),
    )
    .unwrap();
    assert!(first.froze.borrow().is_empty());
    assert_eq!(sink.messages(), [INCOMPLETE_LOG, STALE_LOG]);

    let fresh_sink = Sink::default();
    let fresh = with_last(verified(None, None, None));
    tick(
        &incomplete,
        &fresh,
        &fresh_sink.logger(),
        &mut TickState::new(NOW - HOUR),
        &options(Some(24), 3),
    )
    .unwrap();
    assert!(fresh.froze.borrow().is_empty());
    assert_eq!(fresh_sink.messages(), [INCOMPLETE_LOG]);
}

#[test]
fn with_no_limit_staleness_is_off_and_an_unreadable_time_pages_but_freezes_nothing() {
    let sink = Sink::default();
    let off = with_last(verified(Some(500), Some("1"), None));
    once(&green, &off, &sink).unwrap();
    assert!(off.froze.borrow().is_empty());
    assert!(sink.fatal().is_empty());

    let unreadable = Recording {
        last: Some(Err(StoreError::new("reconcile_runs unreadable", None))),
        ..Recording::default()
    };
    tick(
        &green,
        &unreadable,
        &sink.logger(),
        &mut TickState::new(NOW),
        &options(Some(24), 3),
    )
    .unwrap();
    assert!(unreadable.froze.borrow().is_empty());
    assert_eq!(
        sink.messages(),
        ["LEDGER RECONCILIATION STALENESS CHECK FAILED — last verified time unreadable"]
    );
}

#[test]
fn an_operator_freeze_already_standing_is_left_and_the_stale_page_still_goes_out() {
    let sink = Sink::default();
    let ledger = Recording {
        freeze_fails: Some(StoreError::new(
            "already frozen by an operator",
            Some("ledger.freeze_attributed"),
        )),
        last: Some(Ok(verified(Some(48), Some("9"), None))),
        ..Recording::default()
    };
    tick(
        &green,
        &ledger,
        &sink.logger(),
        &mut TickState::new(NOW),
        &options(Some(24), 3),
    )
    .unwrap();
    assert_eq!(sink.messages(), [STALE_LOG]);
}

/// `runs due controls from the tick and does not freeze when that hook throws` (`reconciliation-controls.test.ts`).
#[test]
fn runs_due_controls_from_the_tick_and_does_not_freeze_when_that_hook_throws() {
    let sink = Sink::default();
    let ledger = Recording {
        controls_throw: true,
        ..Recording::default()
    };
    tick(
        &|| Ok(SnapshotRun::Skipped),
        &ledger,
        &sink.logger(),
        &mut TickState::new(NOW),
        &options(None, 3),
    )
    .unwrap();
    assert!(ledger.controls_called.get());
    assert!(ledger.froze.borrow().is_empty());
}
