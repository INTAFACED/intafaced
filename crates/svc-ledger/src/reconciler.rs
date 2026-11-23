//! What runs a reconciliation and acts on it: `LedgerService.reconcile` (the operator's run), the scheduled job
//! (`runScheduledReconciliation`), the two events (`ledgerReconciliationFailed`, `ledgerReconciliationRunFailed`) and
//! the hourly tick (`scheduled-reconcile-tick.ts`).
//!
//! Only a finished mismatch freezes, as `reconciliation mismatch`, and the freeze lands before any page is sent: an
//! alarm nobody receives is bad, a book still taking writes because the alarm failed is worse. An incomplete run
//! freezes nothing; the tick counts them (the larger of its own count and the durable one) and after N in a row
//! freezes as `reconcile_unproven`, backing off 0, 1, 3, 7, then 8 ticks between attempts. Staleness is reported on
//! every tick, and never changes the switch.

use service_kit::json::Json;
use service_kit::telemetry::Logger;
use service_kit::time::Instant;

use crate::controls::ScheduleFailed;
use crate::db::{Store, StoreError};
use crate::freeze::{self, Command, FREEZE_ATTRIBUTED, FreezeRelay};
use crate::reconcile::{
    self, CustodyLayer, LastVerified, Phase, RECONCILE_FREEZE_FAILED, RECONCILE_IN_PROGRESS,
    RECONCILE_INCOMPLETE, RECONCILE_MISMATCH_REASON, Report, SnapshotOptions, SnapshotRun,
};
use crate::status::{self, RECONCILE_ACTOR, RECONCILE_UNPROVEN_REASON};

/// `ledgerReconciliationFailed`'s subject and version in the event catalogue.
pub const DRIFT_SUBJECT: &str = "intafaced.ledger.reconciliation.failed";
/// `ledgerReconciliationRunFailed`'s.
pub const RUN_FAILED_SUBJECT: &str = "intafaced.ledger.reconciliation_run.failed";
const EVENT_VERSION: i64 = 1;
/// `DEFAULT_RECONCILE_MAX_CONSECUTIVE_INCOMPLETE`.
pub const DEFAULT_MAX_CONSECUTIVE_INCOMPLETE: i64 = 3;

/// The ledger's side of a run: its switch, its book, and where it tells the rest of the system.
pub struct Reconciler<'a> {
    pub store: &'a Store,
    pub relay: FreezeRelay<'a>,
    /// The switch this ledger's own posts enforce; the proof checks customer balances against the same one.
    pub custody: CustodyLayer,
    /// `LEDGER_RECONCILE_STATEMENT_TIMEOUT_MS`.
    pub statement_timeout_ms: i64,
    /// The wall clock in milliseconds.
    pub now_ms: fn() -> i64,
    /// The operator controls' outside side, for the tick's due-controls run; none runs no controls.
    pub controls: Option<&'a dyn crate::controls::sources::Sources>,
}

fn coded(message: impl Into<String>, code: &str) -> StoreError {
    StoreError::new(message, Some(code))
}

/// `/^\d+(\.\d{1,18})?$/`, with the sign `signedAmountSchema` allows.
fn decimal(s: &str, signed: bool) -> bool {
    let body = if signed {
        s.strip_prefix('-').unwrap_or(s)
    } else {
        s
    };
    let (whole, frac) = match body.split_once('.') {
        Some((w, f)) => (w, Some(f)),
        None => (body, None),
    };
    let digits = |t: &str| !t.is_empty() && t.bytes().all(|b| b.is_ascii_digit());
    digits(whole) && frac.is_none_or(|f| digits(f) && f.len() <= 18)
}

/// zod's `z.string().guid()`.
fn guid(s: &str) -> bool {
    let parts: Vec<&str> = s.split('-').collect();
    parts.len() == 5
        && parts
            .iter()
            .zip([8, 4, 4, 4, 12])
            .all(|(p, n)| p.len() == n && p.bytes().all(|b| b.is_ascii_hexdigit()))
}

impl Reconciler<'_> {
    fn options(&self) -> SnapshotOptions<'static> {
        SnapshotOptions {
            statement_timeout_ms: self.statement_timeout_ms,
            custody: self.custody,
            now_ms: self.now_ms,
            prove: None,
            reserve_failure: None,
        }
    }

    fn publish(&self, subject: &str, key: &str, payload: Json) -> Result<(), StoreError> {
        let env = freeze::event_envelope(
            subject,
            EVENT_VERSION,
            &self.relay.producer,
            key,
            payload,
            (self.now_ms)(),
        )
        .map_err(|e| StoreError::new(e, None))?;
        self.relay
            .bus
            .publish(subject, key, &env)
            .map_err(|e| StoreError::new(e, None))
    }

    /// `LedgerService.freeze(reason, actor)`: the switch, then every unpublished freeze intent.
    pub fn freeze(&self, reason: &str, actor: &str) -> Result<(), StoreError> {
        freeze::switch(self.store, &self.relay, Command::Freeze { reason, actor }).map(|_| ())
    }

    /// `LedgerService.reconcile()`: the operator's run. A finished mismatch freezes and pages and returns its report;
    /// another run in flight is `ledger.reconcile_in_progress`; anything unfinished is `ledger.reconcile_incomplete`
    /// and freezes nothing.
    pub fn reconcile(&self) -> Result<Report, StoreError> {
        let run = reconcile::run_snapshot(self.store, &self.options())
            .map_err(|e| StoreError::new(e, None))?;
        match run {
            SnapshotRun::Skipped => Err(coded(
                "a reconciliation is already running — try again when it has finished",
                RECONCILE_IN_PROGRESS,
            )),
            SnapshotRun::Incomplete { error_code, .. } => Err(coded(
                format!(
                    "reconciliation could not finish ({error_code}) — the book was NOT frozen and is NOT verified; see INCIDENT-MONEY-PATH-RUNBOOK \"reconcile incomplete\""
                ),
                RECONCILE_INCOMPLETE,
            )),
            SnapshotRun::Mismatch { report, .. } => {
                self.handle_mismatch(&report)?;
                Ok(report)
            }
            SnapshotRun::Ok { report, .. } => Ok(report),
        }
    }

    /// `handleReconciliationMismatch(report)`: the freeze again (for the fallback where recording failed), which also
    /// publishes the committed freeze intent, then the drift page. An operator freeze already standing stands.
    pub fn handle_mismatch(&self, report: &Report) -> Result<(), StoreError> {
        match self.freeze(RECONCILE_MISMATCH_REASON, RECONCILE_ACTOR) {
            Err(e) if e.code.as_deref() != Some(FREEZE_ATTRIBUTED) => return Err(e),
            _ => {}
        }
        self.publish_drift(report)
    }

    /// `publishReconciliationDrift`: the first drifted account, when there is one. A chain break or an unbalanced
    /// asset pages no invented zero drift.
    fn publish_drift(&self, report: &Report) -> Result<(), StoreError> {
        if report.balances.ok {
            return Ok(());
        }
        let Some(d) = report.balances.drift.first() else {
            return Ok(());
        };
        // The catalogue's check of the payload (`validatePayload`).
        let valid = guid(&d.account_id)
            && (1..=16).contains(&d.asset_id.chars().count())
            && decimal(&d.cached, false)
            && decimal(&d.replayed, false)
            && decimal(&d.difference, true);
        if !valid {
            return Err(StoreError::new(
                "ledgerReconciliationFailed payload is invalid",
                None,
            ));
        }
        let key = service_kit::approvals::random_uuid().map_err(|e| StoreError::new(e, None))?;
        self.publish(
            DRIFT_SUBJECT,
            &key,
            Json::obj([
                ("accountId", Json::str(d.account_id.clone())),
                ("assetId", Json::str(d.asset_id.clone())),
                ("snapshotBalance", Json::str(d.cached.clone())),
                ("replayBalance", Json::str(d.replayed.clone())),
                ("drift", Json::str(d.difference.clone())),
                ("module", Json::str("ledger")),
            ]),
        )
    }

    /// `runScheduledReconciliation(sql, ledger, options)`: the run, then a finished mismatch's freeze. A freeze that did
    /// not land is `ledger.reconcile_freeze_failed`, the one error the tick still tries to halt on.
    pub fn run_scheduled(&self, options: &SnapshotOptions<'_>) -> Result<SnapshotRun, StoreError> {
        let run =
            reconcile::run_snapshot(self.store, options).map_err(|e| StoreError::new(e, None))?;
        if let SnapshotRun::Mismatch { report, .. } = &run {
            self.handle_mismatch(report).map_err(|_| {
                coded(
                    "reconciliation found a mismatch but the freeze did not land",
                    RECONCILE_FREEZE_FAILED,
                )
            })?;
        }
        Ok(run)
    }

    /// The scheduled run with this ledger's own settings.
    pub fn run_scheduled_default(&self) -> Result<SnapshotRun, StoreError> {
        self.run_scheduled(&self.options())
    }
}

/// `ReconcileIncompleteAlert`: what an incomplete run announces. No money figures: the proof did not finish.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IncompleteAlert {
    pub error_code: String,
    /// A run's phase, or `tick` when the runner itself threw.
    pub phase: &'static str,
    pub consecutive_incomplete: i64,
    pub run_id: Option<String>,
}

/// What the tick needs from the ledger. Each `Option` method answers `None` where the ledger does not have it (the
/// TypeScript's optional members): without `status` a failed freeze is never taken as a standing halt, without
/// `last_verified` staleness is not reported, without `consecutive_incomplete` only this process counts.
pub trait TickLedger {
    fn freeze(&self, reason: &str, actor: &str) -> Result<(), StoreError>;
    fn posting_enabled(&self) -> Option<Result<bool, StoreError>> {
        None
    }
    fn last_verified(&self) -> Option<Result<LastVerified, StoreError>> {
        None
    }
    fn alert_incomplete(&self, _alert: &IncompleteAlert) -> Option<Result<(), StoreError>> {
        None
    }
    fn consecutive_incomplete(&self) -> Option<Result<i64, StoreError>> {
        None
    }
    /// `runDueReconciliationControls`: the operator controls that have fallen due, and each one that failed.
    fn run_due_controls(&self) -> Option<Result<Vec<ScheduleFailed>, String>> {
        None
    }
}

impl TickLedger for Reconciler<'_> {
    fn freeze(&self, reason: &str, actor: &str) -> Result<(), StoreError> {
        Reconciler::freeze(self, reason, actor)
    }

    fn posting_enabled(&self) -> Option<Result<bool, StoreError>> {
        Some(status::status(self.store).map(|s| s.posting_enabled))
    }

    fn last_verified(&self) -> Option<Result<LastVerified, StoreError>> {
        Some(reconcile::read_last_verified(self.store))
    }

    /// `alertReconciliationIncomplete`: `ledgerReconciliationRunFailed`, keyed by the run.
    fn alert_incomplete(&self, alert: &IncompleteAlert) -> Option<Result<(), StoreError>> {
        let key = format!(
            "ledger.reconcile.incomplete:{}:{}:{}:{}",
            alert.phase,
            alert.run_id.as_deref().unwrap_or("unrecorded"),
            alert.consecutive_incomplete,
            alert.error_code
        );
        let valid = (1..=64).contains(&alert.error_code.chars().count())
            && alert.consecutive_incomplete >= 1;
        if !valid {
            return Some(Err(StoreError::new(
                "ledgerReconciliationRunFailed payload is invalid",
                None,
            )));
        }
        Some(self.publish(
            RUN_FAILED_SUBJECT,
            &key,
            Json::obj([
                ("errorCode", Json::str(alert.error_code.clone())),
                ("phase", Json::str(alert.phase)),
                (
                    "consecutiveIncomplete",
                    Json::int(alert.consecutive_incomplete),
                ),
                (
                    "runId",
                    alert.run_id.clone().map_or(Json::Null, Json::String),
                ),
            ]),
        ))
    }

    fn consecutive_incomplete(&self) -> Option<Result<i64, StoreError>> {
        Some(reconcile::count_consecutive_incomplete(self.store))
    }

    fn run_due_controls(&self) -> Option<Result<Vec<ScheduleFailed>, String>> {
        let sources = self.controls?;
        Some(
            crate::controls::run_due(self.store, sources)
                .map_err(|e| crate::controls::message_of(&e)),
        )
    }
}

/// `ReconcileTickState`: one per process, for the life of the timer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TickState {
    pub consecutive_incomplete: i64,
    /// Ticks still to skip before the next attempt. Backoff lives across ticks, never inside one.
    pub skip_ticks: i64,
    pub booted_at_ms: i64,
}

impl TickState {
    pub fn new(now_ms: i64) -> TickState {
        TickState {
            consecutive_incomplete: 0,
            skip_ticks: 0,
            booted_at_ms: now_ms,
        }
    }
}

/// `ReconcileTickOptions`.
pub struct TickOptions {
    /// Report staleness past this many hours since the last ok run; none: no threshold.
    pub max_stale_hours: Option<i64>,
    /// Freeze as `reconcile_unproven` once this many incomplete runs landed in a row.
    pub max_consecutive_incomplete: i64,
    pub now_ms: fn() -> i64,
}

const FROZEN_LOG: &str =
    "LEDGER RECONCILIATION FAILED — posting frozen, operator attention required";
const INCOMPLETE_LOG: &str = "LEDGER RECONCILIATION INCOMPLETE — the book was NOT verified and NOT frozen, operator attention required";
const UNPROVEN_LOG: &str = "LEDGER RECONCILIATION UNPROVEN — posting frozen after consecutive incomplete runs, operator attention required";
const STALE_LOG: &str = "LEDGER RECONCILIATION STALE — the book is NOT verified, posting unchanged, operator attention required";
const ALERT_FAILED_LOG: &str =
    "LEDGER RECONCILIATION ALERT FAILED — the incomplete run was not announced";
const STREAK_UNREADABLE_LOG: &str =
    "LEDGER RECONCILIATION STREAK UNREADABLE — using the in-memory incomplete count";

/// `backoffTicks(n)`: after the n-th incomplete run in a row skip 0, 1, 3, 7, then 8 ticks.
pub fn backoff_ticks(consecutive_incomplete: i64) -> i64 {
    if consecutive_incomplete <= 1 {
        return 0;
    }
    let exp = u32::try_from((consecutive_incomplete - 1).min(8)).unwrap_or(8);
    (2_i64.pow(exp) - 1).min(8)
}

fn err_json(e: &StoreError) -> Json {
    let mut o = vec![("message".to_owned(), Json::str(e.message.clone()))];
    if let Some(c) = &e.code {
        o.push(("code".to_owned(), Json::str(c.clone())));
    }
    Json::Object(o)
}

/// `freezeAsReconciliation`: freeze under `reconciliation`, taking an operator freeze already standing, or a halt that
/// committed before its publish failed, as the halt. Anything else did not freeze the book.
fn freeze_as_reconciliation(ledger: &dyn TickLedger, reason: &str) -> Result<(), StoreError> {
    match ledger.freeze(reason, RECONCILE_ACTOR) {
        Ok(()) => Ok(()),
        Err(e) if e.code.as_deref() == Some(FREEZE_ATTRIBUTED) => Ok(()),
        Err(e) => match ledger.posting_enabled() {
            Some(Ok(false)) => Ok(()),
            _ => Err(e),
        },
    }
}

fn announced_streak(state: &TickState, ledger: &dyn TickLedger, log: &Logger) -> i64 {
    match ledger.consecutive_incomplete() {
        None => state.consecutive_incomplete,
        Some(Ok(durable)) if durable >= 0 => state.consecutive_incomplete.max(durable),
        Some(Ok(durable)) => {
            log.log(
                "fatal",
                vec![("durable", Json::int(durable))],
                STREAK_UNREADABLE_LOG,
            );
            state.consecutive_incomplete
        }
        Some(Err(e)) => {
            log.log("fatal", vec![("err", err_json(&e))], STREAK_UNREADABLE_LOG);
            state.consecutive_incomplete
        }
    }
}

fn note_incomplete(
    state: &mut TickState,
    ledger: &dyn TickLedger,
    log: &Logger,
    alert: IncompleteAlert,
    max_consecutive_incomplete: i64,
) -> Result<(), StoreError> {
    state.consecutive_incomplete += 1;
    let streak = announced_streak(state, ledger, log);
    let announced = IncompleteAlert {
        consecutive_incomplete: streak,
        ..alert
    };
    if let Some(Err(e)) = ledger.alert_incomplete(&announced) {
        log.log("fatal", vec![("err", err_json(&e))], ALERT_FAILED_LOG);
    }
    let fields = |skip: i64| {
        vec![
            ("outcome", Json::str("incomplete")),
            ("errorCode", Json::str(announced.error_code.clone())),
            ("phase", Json::str(announced.phase)),
            (
                "consecutiveIncomplete",
                Json::int(announced.consecutive_incomplete),
            ),
            (
                "runId",
                announced.run_id.clone().map_or(Json::Null, Json::String),
            ),
            ("skipNextTicks", Json::int(skip)),
        ]
    };
    if streak >= max_consecutive_incomplete {
        if let Err(e) = freeze_as_reconciliation(ledger, RECONCILE_UNPROVEN_REASON) {
            // Never back off away from a halt that did not land: the next tick retries.
            state.skip_ticks = 0;
            return Err(e);
        }
        // Backoff stays on the in-memory count; the alert carries the larger streak.
        state.skip_ticks = backoff_ticks(state.consecutive_incomplete);
        let mut f = fields(state.skip_ticks);
        f.push(("frozenReason", Json::str(RECONCILE_UNPROVEN_REASON)));
        log.log("fatal", f, UNPROVEN_LOG);
        return Ok(());
    }
    state.skip_ticks = backoff_ticks(state.consecutive_incomplete);
    log.log("fatal", fields(state.skip_ticks), INCOMPLETE_LOG);
    Ok(())
}

/// `runScheduledReconciliationTick(run, ledger, log, options)`. An error is a freeze that was due and did not land;
/// the caller logs it and the next tick tries again.
pub fn tick(
    run: &dyn Fn() -> Result<SnapshotRun, StoreError>,
    ledger: &dyn TickLedger,
    log: &Logger,
    state: &mut TickState,
    options: &TickOptions,
) -> Result<(), StoreError> {
    if state.skip_ticks > 0 {
        state.skip_ticks -= 1;
        log.info(
            vec![
                ("skipTicksLeft", Json::int(state.skip_ticks)),
                (
                    "consecutiveIncomplete",
                    Json::int(state.consecutive_incomplete),
                ),
            ],
            "reconciliation tick skipped: backing off",
        );
    } else {
        match run() {
            Err(e) if e.code.as_deref() == Some(RECONCILE_FREEZE_FAILED) => {
                // A mismatch was found and its freeze did not land: the one throw that still tries to halt posting.
                freeze_as_reconciliation(ledger, RECONCILE_MISMATCH_REASON)?;
                log.log("fatal", vec![("err", err_json(&e))], FROZEN_LOG);
            }
            Err(e) => note_incomplete(
                state,
                ledger,
                log,
                IncompleteAlert {
                    error_code: reconcile::ProofError::Failed(e).code(),
                    phase: "tick",
                    consecutive_incomplete: 0,
                    run_id: None,
                },
                options.max_consecutive_incomplete,
            )?,
            Ok(SnapshotRun::Ok { .. }) => state.consecutive_incomplete = 0,
            // Already frozen by the run. The page is this line.
            Ok(SnapshotRun::Mismatch { report, .. }) => log.log(
                "fatal",
                vec![
                    ("report", report.json()),
                    ("snapshotted", Json::Bool(false)),
                ],
                FROZEN_LOG,
            ),
            Ok(SnapshotRun::Incomplete {
                phase,
                error_code,
                run_id,
                ..
            }) => note_incomplete(
                state,
                ledger,
                log,
                IncompleteAlert {
                    error_code,
                    phase: phase_name(phase),
                    consecutive_incomplete: 0,
                    run_id,
                },
                options.max_consecutive_incomplete,
            )?,
            // Another replica or the operator is proving the book: say nothing, change nothing.
            Ok(SnapshotRun::Skipped) => {}
        }
    }
    report_when_stale(ledger, log, state, options);
    match ledger.run_due_controls() {
        None => {}
        // One control that failed leaves its period unrun; the next tick retries it.
        Some(Ok(failed)) => {
            for f in failed {
                eprintln!("{}", f.line());
            }
        }
        Some(Err(e)) => log.log(
            "fatal",
            vec![("err", Json::str(e))],
            "LEDGER RECONCILIATION CONTROLS TICK FAILED — posting unchanged",
        ),
    }
    Ok(())
}

fn phase_name(p: Phase) -> &'static str {
    p.as_str()
}

/// `reportWhenStale`: on every tick, backed-off ones included, so backoff can never hide stale evidence.
fn report_when_stale(
    ledger: &dyn TickLedger,
    log: &Logger,
    state: &TickState,
    options: &TickOptions,
) {
    let last = match ledger.last_verified() {
        None => return,
        Some(Ok(last)) => last,
        Some(Err(e)) => {
            log.log(
                "fatal",
                vec![("err", err_json(&e))],
                "LEDGER RECONCILIATION STALENESS CHECK FAILED — last verified time unreadable",
            );
            return;
        }
    };
    let at = || {
        last.at_ms
            .map_or(Json::Null, |ms| Json::str(Instant(ms).iso()))
    };
    let seq = || last.seq.clone().map_or(Json::Null, Json::String);
    log.info(
        vec![("lastVerifiedAt", at()), ("lastVerifiedSeq", seq())],
        "reconciliation last verified",
    );
    let Some(max) = options.max_stale_hours else {
        return;
    };
    // Never verified: from the first recorded attempt, else from this process's boot.
    let since = last
        .at_ms
        .or(last.first_attempt_ms)
        .unwrap_or(state.booted_at_ms);
    if (options.now_ms)() - since <= max * 3_600_000 {
        return;
    }
    log.log(
        "fatal",
        vec![
            ("lastVerifiedAt", at()),
            ("lastVerifiedSeq", seq()),
            ("staleSince", Json::str(Instant(since).iso())),
            ("maxStaleHours", Json::int(max)),
        ],
        STALE_LOG,
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_is_0_1_3_7_then_8() {
        let skips: Vec<i64> = (1..=7).map(backoff_ticks).collect();
        assert_eq!(skips, [0, 1, 3, 7, 8, 8, 8]);
        assert_eq!(backoff_ticks(0), 0);
        assert_eq!(backoff_ticks(1_000), 8);
    }

    #[test]
    fn the_drift_page_takes_only_catalogue_shaped_amounts() {
        assert!(decimal("10", false));
        assert!(decimal("0.000000000000000001", false));
        assert!(!decimal("-1", false));
        assert!(decimal("-1", true));
        assert!(!decimal("1.", false));
        assert!(!decimal("1.0000000000000000001", true));
        assert!(guid("55555555-5555-4555-8555-555555555555"));
        assert!(!guid("55555555-5555-4555-8555-55555555555"));
    }
}
