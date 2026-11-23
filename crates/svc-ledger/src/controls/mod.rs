//! Operator reconciliation controls (`ledger/reconciliation-controls.ts`), beside the three built-in proofs. An operator
//! defines a control over a set of accounts, moves it through its lifecycle with a two-founder approval, and runs it on
//! demand (spending an approval) or on its schedule. Nothing here posts or freezes. A run's row is committed `started`
//! before any balance is read, and finished once with its word and evidence; an outside side with no source is the word
//! `unset`, never a zero.
//!
//! - `schedule`: the periods, due instants and margins (`reconciliation-schedule.ts`).
//! - `sources`: the outside statement, the whole outside book and svc-pay's open items (`reconciliation-sources.ts`).
//! - `judge`: each asset's evidence and the run's word.

pub mod judge;
pub mod schedule;
pub mod sources;

use postgres::{GenericClient, IsolationLevel, Transaction};
use service_kit::json::{self, Json};
use service_kit::money::{Amount, parse_amount};
use service_kit::schema::{self, Outcome as Parsed, Value};
use service_kit::time::{Instant, v8_date_parse};
use sha2::{Digest, Sha256};

use crate::approval::{Approvals, Refused, consume_ledger_approval};
use crate::db::{Store, StoreError};
use crate::door;
use judge::{Drift, Evidence, Status, Threshold, Tolerance, Totals};
use schedule::{Bounds, Period, Schedule};
use sources::{OpenItem, OpenItemsRead, SnapshotRead, Sources};

pub const POLICY_UNSET: &str = "ops.control_policy_unset";
pub const MARGIN_UNSET: &str = "ops.control_margin_unset";
pub const STATE_ILLEGAL: &str = "ops.control_state_illegal";
pub const ACTOR_UNSET: &str = "ops.control_actor_unset";
pub const REASON_REQUIRED: &str = "ops.control_reason_required";
pub const ASOF_INVALID: &str = "ledger.reconcile_asof_invalid";
pub const SOURCE_UNAVAILABLE: &str = "ledger.reconcile_source_unavailable";
pub const BUILTIN_IMMUTABLE: &str = "ledger.reconcile_builtin_immutable";
pub const CONTROL_NOT_FOUND: &str = "ledger.reconcile_control_not_found";
pub const RAIL_SOURCE_UNSET: &str = "ledger.reconcile_rail_source_unset";
pub const ITEMS_NOW_ONLY: &str = "ledger.reconcile_items_now_only";
pub const ITEMS_MOVED: &str = "ledger.reconcile_items_moved";
pub const IDEMPOTENCY_CONFLICT: &str = "ledger.idempotency_conflict";

/// `RECONCILIATION_RUN_LIST_DEFAULT`: how many runs a list returns when it names no limit.
const RUN_LIST_DEFAULT: i64 = 100;
/// Scheduled runs own this operation-id prefix; an operator run may not use it.
pub const SCHEDULE_OPERATION_PREFIX: &str = "schedule:";
const SCHEDULED_ACTOR: &str = "reconciliation";
const SCHEDULED_REASON: &str = "scheduled reconciliation control";

/// Why a control call did not answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ControlError {
    /// `ReconciliationControlError`: the door answers its code (`controlHttpStatus`).
    Code(String),
    /// The approval was refused: `ActionApprovalConsumeError`, or what the client threw.
    Approval(Refused),
    /// The database refused or failed.
    Store(StoreError),
    /// Anything else thrown, by its message: a stored row its contract no longer reads.
    Thrown(String),
}

impl ControlError {
    pub fn code(code: &str) -> ControlError {
        ControlError::Code(code.to_owned())
    }
}

impl From<StoreError> for ControlError {
    fn from(e: StoreError) -> ControlError {
        ControlError::Store(e)
    }
}

impl From<postgres::Error> for ControlError {
    fn from(e: postgres::Error) -> ControlError {
        ControlError::Store(StoreError::from(&e))
    }
}

/// `controlHttpStatus(code)`.
pub fn http_status(code: &str) -> u16 {
    match code {
        IDEMPOTENCY_CONFLICT => 409,
        CONTROL_NOT_FOUND => 404,
        ASOF_INVALID | ACTOR_UNSET | REASON_REQUIRED => 400,
        SOURCE_UNAVAILABLE => 503,
        _ => 412,
    }
}

/// `ControlActor`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Actor {
    pub actor_id: String,
    pub request_id: Option<String>,
}

fn actor_of(actor_id: &str) -> Result<String, ControlError> {
    let a = schema::js_trim(actor_id);
    if a.is_empty() {
        return Err(ControlError::code(ACTOR_UNSET));
    }
    Ok(a.to_owned())
}

fn reason_of(reason: &str) -> Result<String, ControlError> {
    let t = schema::js_trim(reason);
    let n = t.encode_utf16().count();
    if !(12..=500).contains(&n) {
        return Err(ControlError::code(REASON_REQUIRED));
    }
    Ok(t.to_owned())
}

/// A recorded schema on a value: its output, or the `ZodError` `parse` throws, by its message.
fn contract(name: &str, value: &Json) -> Result<Json, ControlError> {
    match door::parse(name, Value::from_json(value)) {
        Ok(Parsed::Ok(out)) => out
            .to_json()
            .ok_or(ControlError::Thrown(format!("{name}: no output"))),
        Ok(Parsed::Issues(issues)) => Err(ControlError::Thrown(schema::message(&issues))),
        Err(thrown) => Err(ControlError::Thrown(thrown)),
    }
}

fn text(j: &Json, k: &str) -> Option<String> {
    match j.get(k) {
        Some(Json::String(s)) => Some(s.clone()),
        _ => None,
    }
}

fn iso(ms: i64) -> String {
    Instant(ms).iso()
}

fn set_or_unset(value: Option<String>) -> Json {
    match value {
        Some(v) => Json::obj([("status", Json::str("set")), ("value", Json::String(v))]),
        None => Json::obj([("status", Json::str("unset"))]),
    }
}

fn unset_view() -> Json {
    Json::obj([("status", Json::str("unset"))])
}

fn sha256_hex(text: &str) -> String {
    Sha256::digest(text.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// `fingerprint(parts)`: the SHA-256 of the parts as `JSON.stringify` writes them.
fn fingerprint(control_id: &str, as_of: &str, margin: &str, reason: &str) -> String {
    sha256_hex(
        &Json::obj([
            ("controlId", Json::str(control_id)),
            ("asOf", Json::str(as_of)),
            ("margin", Json::str(margin)),
            ("reason", Json::str(reason)),
        ])
        .compact(),
    )
}

/// `sql.begin(...)` for a control call: `f` in one transaction; the replay's stubbed store refuses it by its name.
fn begin<T>(
    store: &Store,
    isolation: IsolationLevel,
    read_only: bool,
    f: impl FnOnce(&mut Transaction<'_>) -> Result<T, ControlError>,
) -> Result<T, ControlError> {
    let pool = match store {
        Store::Pool(p) => p,
        Store::Down(message) => {
            return Err(StoreError::new(format!("{message}.begin"), None).into());
        }
    };
    let mut conn = pool.get().map_err(StoreError::from)?;
    let client = conn.client().map_err(StoreError::from)?;
    let mut tx = client
        .build_transaction()
        .isolation_level(isolation)
        .read_only(read_only)
        .start()?;
    let out = f(&mut tx)?;
    tx.commit()?;
    Ok(out)
}

/// One statement outside a transaction, on a pool the TypeScript reaches with `sql.unsafe(...)`.
fn unsafe_client<T>(
    store: &Store,
    f: impl FnOnce(&mut postgres::Client) -> Result<T, ControlError>,
) -> Result<T, ControlError> {
    let pool = store.pool_unsafe()?;
    let mut conn = pool.get().map_err(StoreError::from)?;
    let client = conn.client().map_err(StoreError::from)?;
    f(client)
}

fn client<T>(
    store: &Store,
    f: impl FnOnce(&mut postgres::Client) -> Result<T, ControlError>,
) -> Result<T, ControlError> {
    let pool = store.pool()?;
    let mut conn = pool.get().map_err(StoreError::from)?;
    let client = conn.client().map_err(StoreError::from)?;
    f(client)
}

// ── The control row ───────────────────────────────────────────────────────────────────────────────────────────────

/// `ControlRow`: a stored control, its jsonb columns as the driver parses them.
#[derive(Debug, Clone, PartialEq)]
pub struct ControlRow {
    pub id: String,
    pub builtin: bool,
    pub builtin_key: Option<String>,
    pub template: String,
    pub check_kind: Option<String>,
    pub state: String,
    pub explanation: String,
    pub labels: Json,
    pub schedule: Option<Json>,
    pub severity: Option<String>,
    pub period: Option<String>,
    pub tolerance: Option<Json>,
    pub margin: Option<String>,
    pub account_set: Json,
    pub threshold: Option<Json>,
    pub version: i32,
    /// The last resume, in milliseconds: a period that fell due before it was paused time and is not caught up.
    pub resumed_at_ms: Option<i64>,
}

/// `CONTROL_COLUMNS`, each as the row reads it.
pub const CONTROL_COLUMNS: &str = "id::text, builtin, builtin_key, template, check_kind, state, explanation, labels::text,
  schedule::text, severity, period, tolerance::text, margin, account_set::text, threshold::text, version,
  floor(extract(epoch FROM resumed_at) * 1000)::bigint";

fn jsonb(r: &postgres::Row, i: usize) -> Result<Option<Json>, ControlError> {
    let t: Option<String> = r.try_get(i)?;
    t.map(|t| json::parse(&t).map_err(|e| ControlError::Thrown(format!("{e:?}"))))
        .transpose()
}

impl ControlRow {
    fn read(r: &postgres::Row) -> Result<ControlRow, ControlError> {
        Ok(ControlRow {
            id: r.try_get(0)?,
            builtin: r.try_get(1)?,
            builtin_key: r.try_get(2)?,
            template: r.try_get(3)?,
            check_kind: r.try_get(4)?,
            state: r.try_get(5)?,
            explanation: r.try_get(6)?,
            labels: jsonb(r, 7)?.unwrap_or(Json::Array(Vec::new())),
            schedule: jsonb(r, 8)?,
            severity: r.try_get(9)?,
            period: r.try_get(10)?,
            tolerance: jsonb(r, 11)?,
            margin: r.try_get(12)?,
            account_set: jsonb(r, 13)?.unwrap_or(Json::Null),
            threshold: jsonb(r, 14)?,
            version: r.try_get(15)?,
            resumed_at_ms: r.try_get(16)?,
        })
    }

    fn tolerance(&self) -> Option<Tolerance> {
        self.tolerance.as_ref().and_then(Tolerance::from_json)
    }

    fn replays(&self) -> bool {
        self.template == "ledger_invariant"
            && matches!(
                self.check_kind.as_deref(),
                Some("replay" | "replay_and_netting")
            )
    }
}

fn tolerance_ready(tolerance: Option<&Json>) -> bool {
    matches!(tolerance.and_then(|t| t.get("default")), Some(Json::String(d)) if !schema::js_trim(d).is_empty())
}

/// `policyReady(row)`: a tolerance with a default, a schedule and a severity; a threshold also names an asset bound.
fn policy_ready(
    template: &str,
    schedule: Option<&Json>,
    severity: Option<&str>,
    tolerance: Option<&Json>,
    threshold: Option<&Json>,
) -> bool {
    if !tolerance_ready(tolerance) || schedule.is_none() || severity.is_none_or(str::is_empty) {
        return false;
    }
    if template == "threshold" {
        return matches!(threshold.and_then(|t| t.get("byAsset")), Some(Json::Object(o)) if !o.is_empty());
    }
    true
}

fn row_ready(row: &ControlRow) -> bool {
    policy_ready(
        &row.template,
        row.schedule.as_ref(),
        row.severity.as_deref(),
        row.tolerance.as_ref(),
        row.threshold.as_ref(),
    )
}

fn schedule_of(j: &Json) -> Result<(Json, Schedule), ControlError> {
    let parsed = contract("controlSchedule", j)?;
    let s = Schedule::from_parsed(&parsed)
        .ok_or_else(|| ControlError::Thrown("schedule: not a schedule".to_owned()))?;
    Ok((parsed, s))
}

/// `toView(row)`: the control as the contract shows it.
pub fn view(row: &ControlRow) -> Result<Json, ControlError> {
    let schedule = row.schedule.as_ref().map(schedule_of).transpose()?;
    let period = row.period.clone().or_else(|| {
        schedule
            .as_ref()
            .map(|(_, s)| s.period().as_str().to_owned())
    });
    let threshold = row
        .threshold
        .as_ref()
        .map(|t| contract("controlThreshold", t))
        .transpose()?;
    let tolerance = match &row.tolerance {
        Some(t) if matches!(t.get("default"), Some(Json::String(_))) => Json::obj([
            ("status", Json::str("set")),
            ("default", t.get("default").cloned().unwrap_or(Json::Null)),
            (
                "byAsset",
                match t.get("byAsset") {
                    None | Some(Json::Null) => Json::Object(Vec::new()),
                    Some(b) => b.clone(),
                },
            ),
        ]),
        _ => unset_view(),
    };
    let schedule_view = match (&schedule, &period) {
        (Some((value, _)), Some(p)) => Json::obj([
            ("status", Json::str("set")),
            ("value", value.clone()),
            ("period", Json::str(p.clone())),
        ]),
        _ => unset_view(),
    };
    let threshold_view = match &threshold {
        Some(t) => Json::obj([
            ("status", Json::str("set")),
            ("bound", t.get("bound").cloned().unwrap_or(Json::Null)),
            ("byAsset", t.get("byAsset").cloned().unwrap_or(Json::Null)),
        ]),
        None => unset_view(),
    };
    contract(
        "controlView",
        &Json::obj([
            ("id", Json::str(row.id.clone())),
            ("builtin", Json::Bool(row.builtin)),
            ("template", Json::str(row.template.clone())),
            ("checkKind", set_or_unset(row.check_kind.clone())),
            ("state", Json::str(row.state.clone())),
            ("explanation", Json::str(row.explanation.clone())),
            (
                "labels",
                match &row.labels {
                    Json::Array(_) => row.labels.clone(),
                    _ => Json::Array(Vec::new()),
                },
            ),
            ("schedule", schedule_view),
            ("severity", set_or_unset(row.severity.clone())),
            ("tolerance", tolerance),
            ("margin", set_or_unset(row.margin.clone())),
            (
                "accountSet",
                contract("controlAccountSet", &row.account_set)?,
            ),
            ("threshold", threshold_view),
            ("version", Json::int(i64::from(row.version))),
        ]),
    )
}

fn audit(
    tx: &mut impl GenericClient,
    control_id: &str,
    actor: &str,
    reason: &str,
    action: &str,
    request_id: Option<&str>,
    detail: &Json,
) -> Result<(), ControlError> {
    tx.execute(
        "INSERT INTO reconciliation_control_audit (control_id, actor_id, reason, action, request_id, detail)
         VALUES ($1::text::uuid, $2, $3, $4, $5, $6::text::jsonb)",
        &[
            &control_id,
            &actor,
            &reason,
            &action,
            &request_id,
            &detail.compact(),
        ],
    )?;
    Ok(())
}

fn load_control(
    c: &mut impl GenericClient,
    id: &str,
    lock: bool,
) -> Result<ControlRow, ControlError> {
    let rows = c.query(
        &format!(
            "SELECT {CONTROL_COLUMNS} FROM reconciliation_controls WHERE id = $1::text::uuid {}",
            if lock { "FOR UPDATE" } else { "" }
        ),
        &[&id],
    )?;
    match rows.first() {
        Some(r) => ControlRow::read(r),
        None => Err(ControlError::code(CONTROL_NOT_FOUND)),
    }
}

fn one_row(rows: &[postgres::Row]) -> Result<ControlRow, ControlError> {
    match rows.first() {
        Some(r) => ControlRow::read(r),
        None => Err(ControlError::code(SOURCE_UNAVAILABLE)),
    }
}

/// An operator ledger invariant is a replay check: its account set is never the whole book, and netting to zero holds
/// only over the whole book.
fn check_kind_for(template: &str) -> Option<&'static str> {
    (template == "ledger_invariant").then_some("replay")
}

fn field<'a>(input: &'a Json, k: &str) -> Option<&'a Json> {
    match input.get(k) {
        None | Some(Json::Null) => None,
        Some(v) => Some(v),
    }
}

fn period_of_schedule(schedule: Option<&Json>) -> Result<Option<&'static str>, ControlError> {
    schedule
        .map(|s| schedule_of(s).map(|(_, s)| s.period().as_str()))
        .transpose()
}

// ── define, update and the lifecycle ──────────────────────────────────────────────────────────────────────────────

/// `defineReconciliationControl(sql, actor, input)` on an input its schema has parsed. A define with `activate` and an
/// incomplete policy is refused before anything is stored, so a retry leaves no draft behind.
pub fn define(store: &Store, actor: &Actor, input: &Json) -> Result<Json, ControlError> {
    let who = actor_of(&actor.actor_id)?;
    let reason = reason_of(&text(input, "reason").unwrap_or_default())?;
    let template = text(input, "template").unwrap_or_default();
    let schedule = field(input, "schedule");
    let period = period_of_schedule(schedule)?;
    let tolerance = field(input, "tolerance");
    let threshold = field(input, "threshold");
    let severity = text(input, "severity");
    let activate = matches!(input.get("activate"), Some(Json::Bool(true)));
    let ready = policy_ready(
        &template,
        schedule,
        severity.as_deref(),
        tolerance,
        threshold,
    );
    if activate && !ready {
        return Err(ControlError::code(POLICY_UNSET));
    }
    let compact = |j: Option<&Json>| j.map(Json::compact);
    let labels = field(input, "labels")
        .cloned()
        .unwrap_or(Json::Array(Vec::new()));
    let account_set = field(input, "accountSet").cloned().unwrap_or(Json::Null);
    begin(store, IsolationLevel::ReadCommitted, false, |tx| {
        let inserted = tx.query(
            &format!(
                "INSERT INTO reconciliation_controls (
                   builtin, template, check_kind, state, explanation, labels, schedule, severity, period, tolerance, margin,
                   account_set, threshold, defined_by, defined_reason
                 ) VALUES (
                   false, $1, $2, 'draft', $3, $4::text::jsonb, $5::text::jsonb, $6, $7, $8::text::jsonb, $9,
                   $10::text::jsonb, $11::text::jsonb, $12, $13
                 )
                 RETURNING {CONTROL_COLUMNS}"
            ),
            &[
                &template,
                &check_kind_for(&template),
                &text(input, "explanation").unwrap_or_default(),
                &labels.compact(),
                &compact(schedule),
                &severity,
                &period,
                &compact(tolerance),
                &text(input, "margin"),
                &account_set.compact(),
                &compact(threshold),
                &who,
                &reason,
            ],
        )?;
        let row = one_row(&inserted)?;
        audit(
            tx,
            &row.id,
            &who,
            &reason,
            "define",
            actor.request_id.as_deref(),
            &Json::obj([
                ("template", Json::str(template.clone())),
                ("activate", Json::Bool(activate)),
            ]),
        )?;
        if !activate {
            return view(&row);
        }
        let activated = tx.query(
            &format!(
                "UPDATE reconciliation_controls
                    SET state = 'active', version = version + 1, updated_at = clock_timestamp()
                  WHERE id = $1::text::uuid
                  RETURNING {CONTROL_COLUMNS}"
            ),
            &[&row.id],
        )?;
        let next = one_row(&activated)?;
        audit(
            tx,
            &row.id,
            &who,
            &reason,
            "update",
            actor.request_id.as_deref(),
            &Json::obj([("state", Json::str("active"))]),
        )?;
        view(&next)
    })
}

/// `updateReconciliationControl(sql, actor, input, approvals)` on an input its schema has parsed: a lifecycle move, or
/// an edit under the row lock. A built-in control is never changed; a retired one is final; a paused one takes edits and
/// stays paused.
pub fn update(
    store: &Store,
    actor: &Actor,
    input: &Json,
    approvals: &dyn Approvals,
) -> Result<Json, ControlError> {
    let who = actor_of(&actor.actor_id)?;
    let reason = reason_of(&text(input, "reason").unwrap_or_default())?;
    let control_id = text(input, "controlId").unwrap_or_default();
    begin(store, IsolationLevel::ReadCommitted, false, |tx| {
        let current = load_control(tx, &control_id, true)?;
        if current.builtin {
            return Err(ControlError::code(BUILTIN_IMMUTABLE));
        }
        if let Some(lifecycle) = text(input, "lifecycle") {
            let ids = (
                text(input, "approvalId").unwrap_or_default(),
                text(input, "operationId").unwrap_or_default(),
            );
            return move_lifecycle(
                tx,
                approvals,
                (&ids.0, &ids.1),
                &current,
                &lifecycle,
                &who,
                &reason,
                actor.request_id.as_deref(),
            );
        }
        let activate = matches!(input.get("activate"), Some(Json::Bool(true)));
        if current.state == "retired" || (current.state == "paused" && activate) {
            return Err(ControlError::code(STATE_ILLEGAL));
        }
        let schedule = field(input, "schedule")
            .or(current.schedule.as_ref())
            .cloned();
        let severity = text(input, "severity").or_else(|| current.severity.clone());
        let tolerance = field(input, "tolerance")
            .or(current.tolerance.as_ref())
            .cloned();
        let threshold = field(input, "threshold")
            .or(current.threshold.as_ref())
            .cloned();
        let margin = text(input, "margin").or_else(|| current.margin.clone());
        let account_set = field(input, "accountSet")
            .unwrap_or(&current.account_set)
            .clone();
        let explanation = text(input, "explanation").unwrap_or_else(|| current.explanation.clone());
        let labels = field(input, "labels").unwrap_or(&current.labels).clone();
        let period = period_of_schedule(schedule.as_ref())?;
        let next_state = if activate {
            "active"
        } else {
            current.state.as_str()
        };
        if (activate || current.state == "active")
            && !policy_ready(
                &current.template,
                schedule.as_ref(),
                severity.as_deref(),
                tolerance.as_ref(),
                threshold.as_ref(),
            )
        {
            return Err(ControlError::code(POLICY_UNSET));
        }
        let tolerance = tolerance
            .map(|t| contract("controlTolerance", &t))
            .transpose()?;
        let account_set = contract("controlAccountSet", &account_set)?;
        let threshold = threshold
            .map(|t| contract("controlThreshold", &t))
            .transpose()?;
        let compact = |j: Option<&Json>| j.map(Json::compact);
        let updated = tx.query(
            &format!(
                "UPDATE reconciliation_controls
                    SET explanation = $2,
                        labels = $3::text::jsonb,
                        schedule = $4::text::jsonb,
                        severity = $5,
                        period = $6,
                        tolerance = $7::text::jsonb,
                        margin = $8,
                        account_set = $9::text::jsonb,
                        threshold = $10::text::jsonb,
                        state = $11,
                        version = version + 1,
                        updated_at = clock_timestamp()
                  WHERE id = $1::text::uuid
                  RETURNING {CONTROL_COLUMNS}"
            ),
            &[
                &current.id,
                &explanation,
                &labels.compact(),
                &compact(schedule.as_ref()),
                &severity,
                &period,
                &compact(tolerance.as_ref()),
                &margin,
                &account_set.compact(),
                &compact(threshold.as_ref()),
                &next_state,
            ],
        )?;
        let row = one_row(&updated)?;
        audit(
            tx,
            &row.id,
            &who,
            &reason,
            "update",
            actor.request_id.as_deref(),
            &Json::obj([
                ("state", Json::str(row.state.clone())),
                ("version", Json::int(i64::from(row.version))),
            ]),
        )?;
        view(&row)
    })
}

/// `RECONCILIATION_LIFECYCLE_MOVES`: the states each move leaves from, and where it lands.
fn lifecycle_move(name: &str) -> Option<(&'static [&'static str], &'static str)> {
    Some(match name {
        "pause" => (&["active"], "paused"),
        "resume" => (&["paused"], "active"),
        "retire" => (&["draft", "active", "paused"], "retired"),
        _ => return None,
    })
}

/// `moveLifecycle`: the state is checked before the approval is consumed, so an illegal move spends none. One two-founder
/// approval bound to the control, the move and the reason at the version read under the row lock, one version, one audit
/// row. One-shot (no replay key): a lost reply needs a fresh approval.
#[expect(
    clippy::too_many_arguments,
    reason = "the TypeScript's own arguments, one each"
)]
fn move_lifecycle(
    tx: &mut Transaction<'_>,
    approvals: &dyn Approvals,
    ids: (&str, &str),
    current: &ControlRow,
    lifecycle: &str,
    who: &str,
    reason: &str,
    request_id: Option<&str>,
) -> Result<Json, ControlError> {
    let Some((from, to)) = lifecycle_move(lifecycle) else {
        return Err(ControlError::code(STATE_ILLEGAL));
    };
    if !from.contains(&current.state.as_str()) {
        return Err(ControlError::code(STATE_ILLEGAL));
    }
    if lifecycle == "resume" && !row_ready(current) {
        return Err(ControlError::code(POLICY_UNSET));
    }
    consume_ledger_approval(
        approvals,
        ids,
        "ledger.reconciliation_control.lifecycle",
        "posting_reconciliation_control.lifecycle",
        &current.version.to_string(),
        &[
            ("controlId", &current.id),
            ("lifecycle", lifecycle),
            ("reason", reason),
        ],
        None,
    )
    .map_err(ControlError::Approval)?;
    let resumed = if lifecycle == "resume" {
        "clock_timestamp()"
    } else {
        "resumed_at"
    };
    let updated = tx.query(
        &format!(
            "UPDATE reconciliation_controls
                SET state = $2, version = version + 1, updated_at = clock_timestamp(), resumed_at = {resumed}
              WHERE id = $1::text::uuid
              RETURNING {CONTROL_COLUMNS}"
        ),
        &[&current.id, &to],
    )?;
    let row = one_row(&updated)?;
    audit(
        tx,
        &row.id,
        who,
        reason,
        "update",
        request_id,
        &Json::obj([
            ("lifecycle", Json::str(lifecycle)),
            ("from", Json::str(current.state.clone())),
            ("state", Json::str(row.state.clone())),
            ("version", Json::int(i64::from(row.version))),
        ]),
    )?;
    view(&row)
}

// ── the lists ─────────────────────────────────────────────────────────────────────────────────────────────────────

/// `listReconciliationControls(sql)`: built-ins first, by key, then the operators' by id.
pub fn list(store: &Store) -> Result<Json, ControlError> {
    let rows = unsafe_client(store, |c| {
        Ok(c.query(
            &format!(
                "SELECT {CONTROL_COLUMNS} FROM reconciliation_controls
                  ORDER BY builtin DESC, builtin_key ASC NULLS LAST, id ASC"
            ),
            &[],
        )?)
    })?;
    let controls = rows
        .iter()
        .map(|r| ControlRow::read(r).and_then(|row| view(&row)))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Json::obj([("controls", Json::Array(controls))]))
}

/// A run's columns, each as `toRun` reads it; `prefix` is a join's alias (`r.`). Instants are milliseconds, UTC.
pub fn run_columns(prefix: &str) -> String {
    let at = |c: &str| {
        format!("to_char({prefix}{c} AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')")
    };
    format!(
        "{prefix}id::text, {prefix}control_id::text, {prefix}status, {prefix}phase, {prefix}error_code, {}, {}, {prefix}margin,
         {prefix}sources::text, {prefix}evidence::text, {prefix}outside_side, {}, {}",
        at("as_of"),
        at("read_at"),
        at("period_start"),
        at("period_end"),
    )
}

/// The thirteen columns [`run_columns`] names.
pub const RUN_COLUMN_COUNT: usize = 13;

/// `RunRow`: a stored run.
#[derive(Debug, Clone, PartialEq)]
pub struct RunRow {
    pub id: String,
    pub control_id: String,
    pub status: String,
    pub phase: String,
    pub error_code: String,
    pub as_of: String,
    pub read_at: String,
    pub margin: String,
    pub sources: Json,
    pub evidence: Json,
    pub outside_side: String,
    pub period_start: String,
    pub period_end: String,
}

impl RunRow {
    pub fn read(r: &postgres::Row) -> Result<RunRow, ControlError> {
        let j = |i| -> Result<Json, ControlError> { Ok(jsonb(r, i)?.unwrap_or(Json::Null)) };
        Ok(RunRow {
            id: r.try_get(0)?,
            control_id: r.try_get(1)?,
            status: r.try_get(2)?,
            phase: r.try_get(3)?,
            error_code: r.try_get(4)?,
            as_of: r.try_get(5)?,
            read_at: r.try_get(6)?,
            margin: r.try_get(7)?,
            sources: j(8)?,
            evidence: j(9)?,
            outside_side: r.try_get(10)?,
            period_start: r.try_get(11)?,
            period_end: r.try_get(12)?,
        })
    }

    fn read_at_ms(&self) -> Result<i64, ControlError> {
        v8_date_parse(&self.read_at).ok_or_else(|| ControlError::Thrown("read_at".to_owned()))
    }
}

fn compared_json(assets: &[Json]) -> usize {
    let unset = |a: &Json, k| matches!(a.get(k), Some(Json::String(s)) if s == "unset");
    assets
        .iter()
        .filter(|a| a.get("missing").is_none() && !unset(a, "expected") && !unset(a, "difference"))
        .count()
}

/// `toRun(row)` before its contract check: the run with its account list.
pub fn run_fields(row: &RunRow) -> Json {
    let list = |k| match row.evidence.get(k) {
        Some(Json::Null) | None => Json::Array(Vec::new()),
        Some(v) => v.clone(),
    };
    let assets = list("assets");
    let compared = match row.evidence.get("compared") {
        Some(Json::Null) | None => Json::int(match &assets {
            Json::Array(a) => i64::try_from(compared_json(a)).unwrap_or(i64::MAX),
            _ => 0,
        }),
        Some(v) => v.clone(),
    };
    let nonblank = |s: &str| Some(s.to_owned()).filter(|s| !s.is_empty());
    let mut run = vec![
        ("id".to_owned(), Json::str(row.id.clone())),
        ("controlId".to_owned(), Json::str(row.control_id.clone())),
        ("status".to_owned(), Json::str(row.status.clone())),
        ("phase".to_owned(), set_or_unset(nonblank(&row.phase))),
        (
            "errorCode".to_owned(),
            set_or_unset(nonblank(&row.error_code)),
        ),
        ("asOf".to_owned(), Json::str(row.as_of.clone())),
        ("readAt".to_owned(), Json::str(row.read_at.clone())),
        (
            "margin".to_owned(),
            set_or_unset(Some(row.margin.clone()).filter(|m| m != "unset")),
        ),
        ("sources".to_owned(), row.sources.clone()),
        (
            "outsideSide".to_owned(),
            Json::str(row.outside_side.clone()),
        ),
        (
            "periodStart".to_owned(),
            Json::str(row.period_start.clone()),
        ),
        ("periodEnd".to_owned(), Json::str(row.period_end.clone())),
        ("accounts".to_owned(), list("accounts")),
        ("assets".to_owned(), assets),
        ("compared".to_owned(), compared),
    ];
    match row.evidence.get("reconcilingItems") {
        None | Some(Json::Null | Json::Bool(false)) => {}
        Some(Json::Number(n)) if *n == 0.0 => {}
        Some(Json::String(s)) if s.is_empty() => {}
        Some(items) => run.push(("reconcilingItems".to_owned(), items.clone())),
    }
    Json::Object(run)
}

/// `toRun(row)`: the run as the contract shows it.
pub fn to_run(row: &RunRow) -> Result<Json, ControlError> {
    contract("controlRun", &run_fields(row))
}

/// `listReconciliationControlRuns(sql, input)` on an input its schema has parsed: a control's evaluations, newest
/// first by when each started, with the count of all of them, from one snapshot. Any state, retired included.
pub fn list_runs(store: &Store, input: &Json) -> Result<Json, ControlError> {
    let control_id = text(input, "controlId").unwrap_or_default();
    let control = unsafe_client(store, |c| load_control(c, &control_id, false))?;
    #[expect(
        clippy::cast_possible_truncation,
        reason = "the schema holds the limit to a whole number from 1 to 500"
    )]
    let limit = match input.get("limit") {
        Some(Json::Number(n)) => *n as i64,
        _ => RUN_LIST_DEFAULT,
    };
    let (total, rows) = begin(store, IsolationLevel::RepeatableRead, false, |tx| {
        let total: String = tx
            .query_one(
                "SELECT count(*)::text FROM reconciliation_control_runs WHERE control_id = $1::text::uuid",
                &[&control.id],
            )?
            .get(0);
        let page = tx.query(
            &format!(
                "SELECT {} FROM reconciliation_control_runs
                  WHERE control_id = $1::text::uuid
                  ORDER BY started_at DESC, id DESC
                  LIMIT $2",
                run_columns("")
            ),
            &[&control.id, &limit],
        )?;
        Ok((total, page))
    })?;
    let runs = rows
        .iter()
        .map(|r| RunRow::read(r).and_then(|run| to_run(&run)))
        .collect::<Result<Vec<_>, _>>()?;
    contract(
        "controlRunList",
        &Json::obj([
            ("controlId", Json::str(control.id)),
            ("total", Json::int(total.parse::<i64>().unwrap_or(0))),
            ("runs", Json::Array(runs)),
        ]),
    )
}

// ── the book a run reads ──────────────────────────────────────────────────────────────────────────────────────────

/// `existedAt(sql, readAt)`: in the set at the instant bound as `$<param>` (ISO text): created by then on the database
/// clock, or holding an entry posted by then on the posting clock. The posted side is one uncorrelated `IN`, which
/// Postgres hashes once, never a per-account `EXISTS` (issue #8044).
pub fn existed_at(param: usize) -> String {
    format!(
        "(created_at <= ${param}::text::timestamptz OR id IN (
           SELECT e.account_id FROM ledger_entries e JOIN ledger_tx t ON t.id = e.tx_id
            WHERE t.posted_at <= ${param}::text::timestamptz
         ))"
    )
}

/// `likePrefix(prefix)`: a `LIKE` pattern matching the prefix literally.
fn like_prefix(prefix: &str) -> String {
    let mut out = String::new();
    for c in prefix.chars() {
        if matches!(c, '\\' | '%' | '_') {
            out.push('\\');
        }
        out.push(c);
    }
    out.push('%');
    out
}

/// `accountsInSet(sql, accountSet, readAt)`: each account's id and asset.
fn accounts_in_set(
    c: &mut impl GenericClient,
    set: &Json,
    read_at: &str,
) -> Result<Vec<(String, String)>, postgres::Error> {
    let head = format!(
        "SELECT id::text, asset_id FROM accounts WHERE {}",
        existed_at(1)
    );
    let rows = match text(set, "mode").as_deref() {
        Some("explicit") => {
            let ids: Vec<String> = match set.get("accountIds") {
                Some(Json::Array(a)) => a
                    .iter()
                    .filter_map(|v| match v {
                        Json::String(s) => Some(s.clone()),
                        _ => None,
                    })
                    .collect(),
                _ => Vec::new(),
            };
            c.query(
                &format!("{head} AND id = ANY($2::text[]::uuid[])"),
                &[&read_at, &ids],
            )?
        }
        Some("all") => c.query(&head, &[&read_at])?,
        _ => {
            let mut sql = head;
            let mut params: Vec<String> = vec![read_at.to_owned()];
            let mut bind = |sql: &mut String, clause: &str, value: String| {
                params.push(value);
                sql.push_str(&clause.replace("$?", &format!("${}", params.len())));
            };
            if let Some(rail) = text(set, "rail") {
                bind(
                    &mut sql,
                    " AND owner_type = 'treasury'::owner_type AND owner_id = $?",
                    format!("rail:{rail}"),
                );
            }
            if let Some(owner_type) = text(set, "ownerType") {
                bind(
                    &mut sql,
                    " AND owner_type = $?::text::owner_type",
                    owner_type,
                );
            }
            if let Some(prefix) = text(set, "ownerIdPrefix").filter(|p| !p.is_empty()) {
                bind(
                    &mut sql,
                    " AND owner_id LIKE $? ESCAPE '\\'",
                    like_prefix(&prefix),
                );
            }
            if let Some(kind) = text(set, "kind").filter(|k| !k.is_empty()) {
                bind(&mut sql, " AND kind = $?::text::account_kind", kind);
            }
            if let Some(purpose) = text(set, "purpose") {
                bind(&mut sql, " AND purpose = $?", purpose);
            }
            if let Some(asset) = text(set, "assetId").filter(|a| !a.is_empty()) {
                bind(&mut sql, " AND asset_id = $?", asset);
            }
            let refs: Vec<&(dyn postgres::types::ToSql + Sync)> = params
                .iter()
                .map(|p| p as &(dyn postgres::types::ToSql + Sync))
                .collect();
            c.query(&sql, &refs)?
        }
    };
    rows.iter()
        .map(|r| Ok((r.try_get(0)?, r.try_get(1)?)))
        .collect()
}

type Amounts = Vec<(String, Amount)>;

fn amounts(rows: &[postgres::Row], ids: &[String]) -> Result<Amounts, String> {
    let mut out: Amounts = ids.iter().map(|id| (id.clone(), Amount::ZERO)).collect();
    for r in rows {
        let id: String = r.try_get(0).map_err(|e| e.to_string())?;
        let v: String = r.try_get(1).map_err(|e| e.to_string())?;
        let v = parse_amount(&v)?;
        match out.iter_mut().find(|(k, _)| *k == id) {
            Some((_, slot)) => *slot = v,
            None => out.push((id, v)),
        }
    }
    Ok(out)
}

/// `balancesAt`: each account's last `balance_after` at the instant.
fn balances_at(
    c: &mut impl GenericClient,
    ids: &[String],
    read_at: &str,
) -> Result<Amounts, String> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let rows = c
        .query(
            "SELECT DISTINCT ON (e.account_id) e.account_id::text, e.balance_after::text
               FROM ledger_entries e
               JOIN ledger_tx t ON t.id = e.tx_id
              WHERE e.account_id = ANY($1::text[]::uuid[]) AND t.posted_at <= $2::text::timestamptz
              ORDER BY e.account_id, e.id DESC",
            &[&ids, &read_at],
        )
        .map_err(|e| e.to_string())?;
    amounts(&rows, ids)
}

/// `cachedBalances`: the cached column, read for a run at the current instant only (it has no history).
fn cached_balances(c: &mut impl GenericClient, ids: &[String]) -> Result<Amounts, String> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let rows = c
        .query(
            "SELECT id::text, balance::text FROM accounts WHERE id = ANY($1::text[]::uuid[])",
            &[&ids],
        )
        .map_err(|e| e.to_string())?;
    amounts(&rows, ids)
}

/// `replayedAt`: each account's entries summed up to the instant, or every entry the snapshot shows with none.
fn replayed_at(
    c: &mut impl GenericClient,
    ids: &[String],
    read_at: Option<&str>,
) -> Result<Amounts, String> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let rows = c
        .query(
            "SELECT e.account_id::text,
                    COALESCE(SUM(CASE WHEN e.direction = 'debit' THEN e.amount ELSE -e.amount END), 0)::text
               FROM ledger_entries e
               JOIN ledger_tx t ON t.id = e.tx_id
              WHERE e.account_id = ANY($1::text[]::uuid[])
                AND ($2::text IS NULL OR t.posted_at <= $2::text::timestamptz)
              GROUP BY e.account_id",
            &[&ids, &read_at],
        )
        .map_err(|e| e.to_string())?;
    amounts(&rows, ids)
}

/// What a run read (`Book`).
struct Book {
    accounts: Vec<(String, String)>,
    account_ids: Vec<String>,
    balances: Amounts,
    replayed: Amounts,
    drift: Option<Drift>,
}

/// `BookReadError`: where the read failed, and the accounts it had found by then.
struct BookReadError {
    phase: &'static str,
    account_ids: Vec<String>,
}

fn read_book_on(
    c: &mut impl GenericClient,
    set: &Json,
    read_at: &str,
    past: bool,
    with_balances: bool,
    replays: bool,
) -> Result<Book, BookReadError> {
    let accounts = accounts_in_set(c, set, read_at).map_err(|_| BookReadError {
        phase: "accounts",
        account_ids: Vec::new(),
    })?;
    let mut account_ids: Vec<String> = accounts.iter().map(|(id, _)| id.clone()).collect();
    account_ids.sort();
    if !with_balances {
        return Ok(Book {
            accounts,
            account_ids,
            balances: Vec::new(),
            replayed: Vec::new(),
            drift: None,
        });
    }
    let ledger = |ids: &[String]| BookReadError {
        phase: "ledger",
        account_ids: ids.to_vec(),
    };
    let balances = balances_at(c, &account_ids, read_at).map_err(|_| ledger(&account_ids))?;
    let replayed = if replays {
        replayed_at(c, &account_ids, Some(read_at)).map_err(|_| ledger(&account_ids))?
    } else {
        Vec::new()
    };
    let drift = if past || !replays {
        None
    } else {
        Some(Drift {
            cached: cached_balances(c, &account_ids).map_err(|_| ledger(&account_ids))?,
            replayed: replayed_at(c, &account_ids, None).map_err(|_| ledger(&account_ids))?,
        })
    };
    Ok(Book {
        accounts,
        account_ids,
        balances,
        replayed,
        drift,
    })
}

/// `readBook`: the account set, the ledger side and the replay side at the instant, from one repeatable-read snapshot,
/// so an account created and funded after it is in no side and never one leg without the other. A chain check reads
/// the set only, outside a transaction.
fn read_book(
    store: &Store,
    set: &Json,
    read_at: &str,
    past: bool,
    with_balances: bool,
    replays: bool,
) -> Result<Book, BookReadError> {
    let opened = || BookReadError {
        phase: "ledger",
        account_ids: Vec::new(),
    };
    if !with_balances {
        let pool = store.pool().map_err(|_| BookReadError {
            phase: "accounts",
            account_ids: Vec::new(),
        })?;
        let mut conn = pool.get().map_err(|_| BookReadError {
            phase: "accounts",
            account_ids: Vec::new(),
        })?;
        let c = conn.client().map_err(|_| BookReadError {
            phase: "accounts",
            account_ids: Vec::new(),
        })?;
        return read_book_on(c, set, read_at, past, false, replays);
    }
    let pool = store.pool().map_err(|_| opened())?;
    let mut conn = pool.get().map_err(|_| opened())?;
    let c = conn.client().map_err(|_| opened())?;
    let mut tx = c
        .build_transaction()
        .isolation_level(IsolationLevel::RepeatableRead)
        .read_only(true)
        .start()
        .map_err(|_| opened())?;
    let book = read_book_on(&mut tx, set, read_at, past, true, replays)?;
    tx.commit().map_err(|_| opened())?;
    Ok(book)
}

// ── judging a run ─────────────────────────────────────────────────────────────────────────────────────────────────

/// `Verdict`.
#[derive(Debug, Clone, PartialEq)]
pub struct Verdict {
    pub status: Status,
    /// Records compared; none counts them from the asset rows. A chain check counts transactions.
    pub compared: Option<i64>,
    pub phase: String,
    pub error_code: String,
    pub assets: Vec<Evidence>,
    pub outside_side: &'static str,
    pub sources: Json,
    pub reconciling_items: Option<Vec<Json>>,
}

fn sources_json(ledger: &str, outside: &str, parity: &str) -> Json {
    let side = |at: &str| Json::obj([("asOf", Json::str(at))]);
    Json::obj([
        ("ledger", side(ledger)),
        ("outside", side(outside)),
        ("parity", side(parity)),
    ])
}

fn verdict(
    status: Status,
    phase: &str,
    error_code: &str,
    assets: Vec<Evidence>,
    outside_side: &'static str,
    sources: Json,
) -> Verdict {
    Verdict {
        status,
        compared: None,
        phase: phase.to_owned(),
        error_code: error_code.to_owned(),
        assets,
        outside_side,
        sources,
        reconciling_items: None,
    }
}

/// `unavailableVerdict(phase, readAt)`.
fn unavailable(phase: &str, read_at: &str) -> Verdict {
    verdict(
        Status::Error,
        phase,
        SOURCE_UNAVAILABLE,
        Vec::new(),
        "not_applicable",
        sources_json(read_at, "unset", "unset"),
    )
}

/// `itemsRailOf`: the rail of an outside-balance control over one rail with an open-items source.
fn items_rail_of(row: &ControlRow, set: &Json, sources: &dyn Sources) -> Option<String> {
    if row.template != "outside_balance" || text(set, "mode").as_deref() != Some("query") {
        return None;
    }
    text(set, "rail").filter(|r| sources.has_open_items(r))
}

/// `heldBy(read, statementAt)`: the items a statement as of that instant can hold.
fn held_by(items: &[OpenItem], statement_at: Option<i64>) -> Vec<&OpenItem> {
    items
        .iter()
        .filter(|i| matches!((i.seen_at, statement_at), (Some(seen), Some(at)) if seen <= at))
        .collect()
}

/// `itemsKey(items)`: the items as one comparable key.
fn items_key(items: &[&OpenItem]) -> Vec<String> {
    let mut keys: Vec<String> = items
        .iter()
        .map(|i| {
            Json::Array(vec![
                Json::str(i.id.clone()),
                Json::str(i.kind.clone()),
                Json::str(i.asset_id.clone()),
                i.item.get("amount").cloned().unwrap_or(Json::Null),
            ])
            .compact()
        })
        .collect();
    // `Array#sort()` on arrays compares their `toString()`: the fields joined by commas.
    let joined = |k: &String| match json::parse(k) {
        Ok(Json::Array(a)) => a
            .iter()
            .map(|v| match v {
                Json::String(s) => s.clone(),
                other => other.compact(),
            })
            .collect::<Vec<_>>()
            .join(","),
        _ => k.clone(),
    };
    keys.sort_by_key(joined);
    keys
}

/// `evaluate(sql, row, readAt, sources, past)`: read the book once and judge it; the accounts are the evidence.
fn evaluate(
    store: &Store,
    row: &ControlRow,
    read_at_ms: i64,
    sources: &dyn Sources,
    past: bool,
) -> Result<(Verdict, Vec<String>), String> {
    let read_at = iso(read_at_ms);
    let set =
        contract("controlAccountSet", &row.account_set).map_err(|_| "account set".to_owned())?;
    let items_rail = items_rail_of(row, &set, sources);
    let before = match &items_rail {
        Some(rail) if !past => Some(sources.open_items(rail)),
        _ => None,
    };
    let with_balances = row.check_kind.as_deref() != Some("chain");
    let book = match read_book(store, &set, &read_at, past, with_balances, row.replays()) {
        Ok(b) => b,
        Err(e) => return Ok((unavailable(e.phase, &read_at), e.account_ids)),
    };
    let v = judge(
        store,
        row,
        &set,
        &book,
        read_at_ms,
        sources,
        past,
        before.as_ref(),
        items_rail.as_deref(),
    )?;
    Ok((v, book.account_ids))
}

fn amount_of(list: &Amounts) -> impl Fn(&str) -> Amount + '_ {
    move |id| {
        list.iter()
            .find(|(k, _)| k == id)
            .map_or(Amount::ZERO, |(_, v)| *v)
    }
}

fn zeros(totals: &Totals) -> Totals {
    totals
        .iter()
        .map(|(a, _)| (a.clone(), Amount::ZERO))
        .collect()
}

#[expect(
    clippy::too_many_arguments,
    reason = "the TypeScript's own arguments, one each"
)]
#[expect(
    clippy::too_many_lines,
    reason = "one template a branch, in the TypeScript's order"
)]
fn judge(
    store: &Store,
    row: &ControlRow,
    set: &Json,
    book: &Book,
    read_at_ms: i64,
    sources: &dyn Sources,
    past: bool,
    before: Option<&OpenItemsRead>,
    items_rail: Option<&str>,
) -> Result<Verdict, String> {
    let read_at = iso(read_at_ms);
    let empty = || sources_json(&read_at, "unset", "unset");
    let tolerance = row.tolerance();
    let tolerance = tolerance.as_ref();

    if row.check_kind.as_deref() == Some("chain") {
        let chain = store.pool().map_err(|e| e.message).and_then(|p| {
            let mut conn = p.get().map_err(|e| e.0)?;
            let c = conn.client().map_err(|e| e.0)?;
            crate::reconcile::verify_chain(c, 1000, past.then_some(read_at.as_str()))
                .map_err(|e| e.message())
        });
        return Ok(match chain {
            // An empty chain verified nothing: NOTHING_TO_COMPARE, never PASS.
            Ok(chain) => Verdict {
                compared: Some(chain.length()),
                ..verdict(
                    match (chain.ok(), chain.length()) {
                        (false, _) => Status::Fail,
                        (true, 0) => Status::NothingToCompare,
                        (true, _) => Status::Pass,
                    },
                    if chain.ok() { "" } else { "chain" },
                    "",
                    Vec::new(),
                    "not_applicable",
                    empty(),
                )
            },
            Err(_) => verdict(
                Status::Error,
                "chain",
                SOURCE_UNAVAILABLE,
                Vec::new(),
                "not_applicable",
                empty(),
            ),
        });
    }

    let ledger_totals = judge::sum_by_asset(&book.accounts, &amount_of(&book.balances))?;

    if row.replays() {
        // Each account's last balance_after against its entries at the instant; at the current instant the cached column
        // is also checked against the snapshot's entries account by account.
        let replay_rows = judge::with_drift(
            judge::equal_assets(
                &ledger_totals,
                &judge::sum_by_asset(&book.accounts, &amount_of(&book.replayed))?,
                tolerance,
                true,
                true,
            )?,
            &book.accounts,
            book.drift.as_ref(),
            tolerance,
        )?;
        let mut assets = replay_rows;
        if row.check_kind.as_deref() == Some("replay_and_netting")
            && text(set, "mode").as_deref() == Some("all")
        {
            let net_rows = judge::equal_assets(
                &ledger_totals,
                &zeros(&ledger_totals),
                tolerance,
                true,
                true,
            )?;
            let replayed = judge::fold_assets(&assets, false)?;
            if matches!(replayed, Status::Pass | Status::NothingToCompare) {
                assets = net_rows;
            }
        }
        let status = judge::fold_assets(&assets, false)?;
        return Ok(verdict(
            status,
            match status {
                Status::Error => "tolerance",
                Status::Fail => "invariant",
                _ => "",
            },
            if status == Status::Error {
                POLICY_UNSET
            } else {
                ""
            },
            assets,
            "not_applicable",
            empty(),
        ));
    }

    if row.check_kind.as_deref() == Some("netting") {
        let assets = judge::equal_assets(
            &ledger_totals,
            &zeros(&ledger_totals),
            tolerance,
            true,
            true,
        )?;
        let status = judge::fold_assets(&assets, false)?;
        return Ok(verdict(
            status,
            match status {
                Status::Fail => "netting",
                Status::Error => "tolerance",
                _ => "",
            },
            if status == Status::Error {
                POLICY_UNSET
            } else {
                ""
            },
            assets,
            "not_applicable",
            empty(),
        ));
    }

    if row.template == "threshold" {
        let parsed = row
            .threshold
            .as_ref()
            .and_then(|t| contract("controlThreshold", t).ok());
        let Some(parsed) = parsed else {
            return Ok(verdict(
                Status::Error,
                "threshold",
                POLICY_UNSET,
                Vec::new(),
                "not_applicable",
                empty(),
            ));
        };
        let threshold = Threshold {
            min: text(&parsed, "bound").as_deref() == Some("min"),
            by_asset: match parsed.get("byAsset") {
                Some(Json::Object(o)) => o
                    .iter()
                    .map(|(k, v)| {
                        (
                            k.clone(),
                            match v {
                                Json::String(s) => s.clone(),
                                _ => "0".to_owned(),
                            },
                        )
                    })
                    .collect(),
                _ => Vec::new(),
            },
        };
        let assets = judge::threshold_assets(&ledger_totals, &threshold, tolerance)?;
        let missing = assets.iter().any(|a| a.missing.is_some());
        let status = judge::fold_threshold(&assets)?;
        return Ok(verdict(
            status,
            if missing {
                "missing"
            } else {
                match status {
                    Status::Fail => "threshold",
                    Status::Error => "tolerance",
                    _ => "",
                }
            },
            if status == Status::Error {
                POLICY_UNSET
            } else {
                ""
            },
            assets,
            "not_applicable",
            empty(),
        ));
    }

    let outside_template = row.template == "outside_balance";
    // A control over one rail's boundary reads that rail's statement only.
    let rail = if text(set, "mode").as_deref() == Some("query") {
        text(set, "rail")
    } else {
        None
    };
    let read = if !outside_template {
        sources.parity(read_at_ms)
    } else if let Some(r) = &rail {
        sources.rail_statement(read_at_ms, r)
    } else {
        sources.outside_balance(read_at_ms)
    };
    let side = if outside_template {
        "outside"
    } else {
        "parity"
    };
    let (as_of, balances) = match read {
        SnapshotRead::Unavailable => {
            return Ok(verdict(
                Status::Error,
                side,
                SOURCE_UNAVAILABLE,
                Vec::new(),
                if outside_template {
                    "unavailable"
                } else {
                    "not_applicable"
                },
                empty(),
            ));
        }
        SnapshotRead::Unset => {
            let mut sorted: Vec<&(String, Amount)> = ledger_totals.iter().collect();
            sorted.sort_by(|a, b| judge::locale_compare(&a.0, &b.0));
            let assets = sorted
                .into_iter()
                .map(|(asset, amount)| {
                    Ok(Evidence {
                        asset_id: asset.clone(),
                        observed: Some(*amount),
                        expected: None,
                        difference: None,
                        tolerance: Tolerance::for_asset(tolerance, asset)?,
                        reconciling_items: None,
                        residual: None,
                        missing: None,
                    })
                })
                .collect::<Result<Vec<_>, String>>()?;
            return Ok(verdict(
                Status::Unset,
                side,
                if outside_template && rail.is_some() {
                    RAIL_SOURCE_UNSET
                } else {
                    ""
                },
                assets,
                if outside_template {
                    "unset"
                } else {
                    "not_applicable"
                },
                empty(),
            ));
        }
        SnapshotRead::Snapshot { as_of, balances } => (as_of, balances),
    };
    // A control scoped to one asset judges that asset alone.
    let only_asset = if text(set, "mode").as_deref() == Some("query") {
        text(set, "assetId")
    } else {
        None
    };
    let mut expected: Totals = Vec::new();
    for (asset, amount) in &balances {
        if only_asset.as_ref().is_none_or(|o| o == asset) {
            let v = parse_amount(amount)?;
            match expected.iter_mut().find(|(a, _)| a == asset) {
                Some((_, slot)) => *slot = v,
                None => expected.push((asset.clone(), v)),
            }
        }
    }
    // A snapshot that names no as-of stays unset: its age is unknown, and the ledger's time is not its time.
    let source_as_of = as_of.clone().unwrap_or_else(|| "unset".to_owned());
    let next_sources = if outside_template {
        sources_json(&read_at, &source_as_of, "unset")
    } else {
        sources_json(&read_at, "unset", &source_as_of)
    };
    if items_rail.is_some() && past {
        // svc-pay lists what is open now, never what was open at a past instant: a past run cannot take items out.
        return Ok(verdict(
            Status::Unset,
            "items",
            ITEMS_NOW_ONLY,
            judge::equal_assets(&ledger_totals, &expected, tolerance, false, false)?,
            "snapshot",
            next_sources,
        ));
    }
    let mut named: Option<Vec<&OpenItem>> = None;
    let mut items_fault: Option<&str> = None;
    let after;
    if let Some(r) = items_rail {
        after = sources.open_items(r);
        match (before, &after) {
            (Some(OpenItemsRead::Items(was)), OpenItemsRead::Items(now)) => {
                // An item svc-pay saw after the statement's as-of is in neither read: left out, not netted.
                let statement_at = match &as_of {
                    Some(a) => v8_date_parse(a),
                    None => Some(read_at_ms),
                };
                let was = held_by(was, statement_at);
                let now = held_by(now, statement_at);
                if items_key(&was) == items_key(&now) {
                    named = Some(
                        now.into_iter()
                            .filter(|i| only_asset.as_ref().is_none_or(|o| *o == i.asset_id))
                            .collect(),
                    );
                } else {
                    items_fault = Some(ITEMS_MOVED);
                }
            }
            _ => items_fault = Some(SOURCE_UNAVAILABLE),
        }
    }
    // With the items read, a rail asset the ledger holds no account for is a ledger side of 0 (a held first deposit
    // posts nothing), so it is judged, not left UNSET where it could hide another asset's FAIL.
    let compared = judge::equal_assets(
        &ledger_totals,
        &expected,
        tolerance,
        !outside_template,
        named.is_some(),
    )?;
    if let Some(fault) = items_fault {
        return Ok(verdict(
            Status::Error,
            "items",
            fault,
            compared,
            "snapshot",
            next_sources,
        ));
    }
    let assets = match &named {
        None => compared,
        Some(items) => judge::with_items(compared, items, tolerance)?,
    };
    let unset_source = outside_template && assets.iter().any(|a| a.expected.is_none());
    let status = match &named {
        None => judge::fold_assets(&assets, unset_source)?,
        Some(_) => judge::fold_residuals(&assets, unset_source),
    };
    Ok(Verdict {
        reconciling_items: named.map(|items| items.iter().map(|i| i.item.clone()).collect()),
        ..verdict(
            status,
            match status {
                Status::Fail => side,
                Status::Error => "tolerance",
                _ => "",
            },
            if status == Status::Error {
                POLICY_UNSET
            } else {
                ""
            },
            assets,
            if outside_template {
                "snapshot"
            } else {
                "not_applicable"
            },
            next_sources,
        )
    })
}

// ── a run's row ───────────────────────────────────────────────────────────────────────────────────────────────────

/// `finishRun`: a started row is the only one a later pass may finish; a terminal row is returned as stored.
fn finish_run(
    store: &Store,
    run_id: &str,
    v: &Verdict,
    account_ids: &[String],
) -> Result<RunRow, ControlError> {
    let assets: Vec<Json> = v.assets.iter().map(Evidence::json).collect();
    let compared = v
        .compared
        .unwrap_or_else(|| i64::try_from(judge::compared_of(&v.assets)).unwrap_or(i64::MAX));
    let mut evidence = vec![
        (
            "accounts".to_owned(),
            Json::Array(account_ids.iter().map(|a| Json::str(a.clone())).collect()),
        ),
        ("assets".to_owned(), Json::Array(assets)),
        ("compared".to_owned(), Json::int(compared)),
    ];
    if let Some(items) = &v.reconciling_items {
        evidence.push(("reconcilingItems".to_owned(), Json::Array(items.clone())));
    }
    let evidence = Json::Object(evidence).compact();
    client(store, |c| {
        let rows = c.query(
            &format!(
                "UPDATE reconciliation_control_runs
                    SET status = $2, phase = $3, error_code = $4, sources = $5::text::jsonb,
                        evidence = $6::text::jsonb, outside_side = $7, finished_at = clock_timestamp()
                  WHERE id = $1::text::uuid AND status = 'started'
                  RETURNING {}",
                run_columns("")
            ),
            &[
                &run_id,
                &v.status.as_str(),
                &v.phase,
                &v.error_code,
                &v.sources.compact(),
                &evidence,
                &v.outside_side,
            ],
        )?;
        if let Some(r) = rows.first() {
            return RunRow::read(r);
        }
        let current = c.query(
            &format!(
                "SELECT {} FROM reconciliation_control_runs WHERE id = $1::text::uuid",
                run_columns("")
            ),
            &[&run_id],
        )?;
        match current.first().map(RunRow::read).transpose()? {
            Some(row) if row.status != "started" => Ok(row),
            _ => Err(ControlError::code(SOURCE_UNAVAILABLE)),
        }
    })
}

/// `resumeRun`: finish a started row. A failed read or evaluation is stored as ERROR with its phase, so the same
/// operation id never stays `started`.
fn resume_run(
    store: &Store,
    row: &ControlRow,
    opened: &RunRow,
    sources: &dyn Sources,
    past: bool,
) -> Result<Json, ControlError> {
    let read_at_ms = opened.read_at_ms()?;
    let attempt = || -> Result<RunRow, (&'static str, ControlError)> {
        contract("controlAccountSet", &row.account_set).map_err(|e| ("accounts", e))?;
        let (v, ids) = evaluate(store, row, read_at_ms, sources, past)
            .map_err(|e| ("evaluate", ControlError::Thrown(e)))?;
        finish_run(store, &opened.id, &v, &ids).map_err(|e| ("evaluate", e))
    };
    let finished = match attempt() {
        Ok(r) => r,
        Err((phase, _)) => finish_run(
            store,
            &opened.id,
            &unavailable(phase, &iso(read_at_ms)),
            &[],
        )?,
    };
    to_run(&finished)
}

/// What opens a run's row.
struct Opening<'a> {
    actor: &'a Actor,
    reason: &'a str,
    operation_id: &'a str,
    fingerprint: &'a str,
    as_of: i64,
    read_at: i64,
    margin: &'a str,
    period: Bounds,
}

/// `openRun`: a pause or retire that committed after the caller read the control wins, and `FOR SHARE` holds off a
/// lifecycle move until this row is in.
fn open_run(store: &Store, row: &ControlRow, o: &Opening<'_>) -> Result<RunRow, ControlError> {
    let who = actor_of(&o.actor.actor_id)?;
    begin(store, IsolationLevel::ReadCommitted, false, |tx| {
        let live = tx.query(
            "SELECT state FROM reconciliation_controls WHERE id = $1::text::uuid FOR SHARE",
            &[&row.id],
        )?;
        let state: Option<String> = live.first().map(|r| r.try_get(0)).transpose()?;
        if state.as_deref() != Some("active") {
            return Err(ControlError::code(STATE_ILLEGAL));
        }
        let inserted = tx.query(
            &format!(
                "INSERT INTO reconciliation_control_runs (
                   control_id, operation_id, fingerprint, status, phase, error_code, as_of, read_at, margin, sources,
                   evidence, outside_side, period_start, period_end, actor_id, reason
                 ) VALUES (
                   $1::text::uuid, $2, $3, 'started', '', '', $4::text::timestamptz, $5::text::timestamptz, $6,
                   $7::text::jsonb, '{{\"accounts\":[],\"assets\":[]}}'::jsonb, 'not_applicable',
                   $8::text::timestamptz, $9::text::timestamptz, $10, $11
                 )
                 RETURNING {}",
                run_columns("")
            ),
            &[
                &row.id,
                &o.operation_id,
                &o.fingerprint,
                &iso(o.as_of),
                &iso(o.read_at),
                &o.margin,
                &sources_json(&iso(o.read_at), "unset", "unset").compact(),
                &iso(o.period.start),
                &iso(o.period.end),
                &who,
                &o.reason,
            ],
        )?;
        let run = match inserted.first() {
            Some(r) => RunRow::read(r)?,
            None => return Err(ControlError::code(SOURCE_UNAVAILABLE)),
        };
        audit(
            tx,
            &row.id,
            &who,
            o.reason,
            "run",
            o.actor.request_id.as_deref(),
            &Json::obj([
                ("runId", Json::str(run.id.clone())),
                ("operationId", Json::str(o.operation_id)),
            ]),
        )?;
        Ok(run)
    })
}

/// A stored run and its fingerprint, by operation id.
fn existing_run(
    store: &Store,
    operation_id: &str,
) -> Result<Option<(RunRow, String)>, ControlError> {
    client(store, |c| {
        let rows = c.query(
            &format!(
                "SELECT {}, fingerprint FROM reconciliation_control_runs WHERE operation_id = $1",
                run_columns("")
            ),
            &[&operation_id],
        )?;
        rows.first()
            .map(|r| Ok((RunRow::read(r)?, r.try_get(RUN_COLUMN_COUNT)?)))
            .transpose()
    })
}

/// The database's clock, in milliseconds as the driver hands a `Date`.
fn db_now(store: &Store) -> Result<i64, ControlError> {
    client(store, |c| {
        Ok(c.query_one(
            "SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint",
            &[],
        )?
        .get(0))
    })
}

/// `runReconciliationControl(sql, approvals, actor, input, sources, now)` on an input its schema has parsed. A stored
/// run for the operation is answered (or finished) as it is, after a pause too; a new run needs an active control and
/// spends one approval, the operation id its replay key.
pub fn run(
    store: &Store,
    approvals: &dyn Approvals,
    actor: &Actor,
    input: &Json,
    sources: &dyn Sources,
    now: Option<i64>,
) -> Result<Json, ControlError> {
    let operation_id = text(input, "operationId").unwrap_or_default();
    if operation_id.starts_with(SCHEDULE_OPERATION_PREFIX) {
        return Err(ControlError::code(IDEMPOTENCY_CONFLICT));
    }
    let who = actor_of(&actor.actor_id)?;
    let reason = reason_of(&text(input, "reason").unwrap_or_default())?;
    let control_id = text(input, "controlId").unwrap_or_default();
    let row = unsafe_client(store, |c| load_control(c, &control_id, false))?;
    let now = match now {
        Some(n) => n,
        None => db_now(store)?,
    };
    let asked = text(input, "asOf");
    let past = asked.is_some();
    let as_of = match &asked {
        Some(a) => v8_date_parse(a).ok_or_else(|| ControlError::code(ASOF_INVALID))?,
        None => now,
    };
    schedule::assert_not_future(as_of, now)?;
    let mut margin = "unset".to_owned();
    let mut read_at = as_of;
    if past {
        let chosen = text(input, "margin").or_else(|| row.margin.clone());
        let chosen = chosen
            .filter(|m| !schema::js_trim(m).is_empty())
            .ok_or_else(|| ControlError::code(MARGIN_UNSET))?;
        margin = schema::js_trim(&chosen).to_owned();
        read_at = schedule::read_instant(as_of, &margin)?;
    }
    let as_of_word = if past { iso(as_of) } else { "now".to_owned() };
    let fp = fingerprint(&row.id, &as_of_word, &margin, &reason);
    if let Some((prior, prior_fp)) = existing_run(store, &operation_id)? {
        if prior_fp != fp {
            return Err(ControlError::code(IDEMPOTENCY_CONFLICT));
        }
        if prior.status != "started" {
            return to_run(&prior);
        }
        // A run that already opened finishes even if the control was paused or retired since.
        return resume_run(store, &row, &prior, sources, past);
    }
    if row.state != "active" {
        return Err(ControlError::code(STATE_ILLEGAL));
    }
    consume_ledger_approval(
        approvals,
        (
            &text(input, "approvalId").unwrap_or_default(),
            &operation_id,
        ),
        "ledger.reconciliation_control.run",
        "posting_reconciliation_control.run",
        &row.version.to_string(),
        &[
            ("controlId", &row.id),
            ("asOf", &as_of_word),
            ("margin", &margin),
            ("reason", &reason),
        ],
        Some((&operation_id, &who)),
    )
    .map_err(ControlError::Approval)?;
    let actor = Actor {
        actor_id: who,
        request_id: actor.request_id.clone(),
    };
    let adopt = |found: (RunRow, String)| -> Result<Json, ControlError> {
        if found.1 != fp {
            return Err(ControlError::code(IDEMPOTENCY_CONFLICT));
        }
        if found.0.status != "started" {
            return to_run(&found.0);
        }
        resume_run(store, &row, &found.0, sources, past)
    };
    if let Some(found) = existing_run(store, &operation_id)? {
        return adopt(found);
    }
    let period = row
        .period
        .as_deref()
        .and_then(Period::from_word)
        .map(Ok)
        .or_else(|| {
            row.schedule
                .as_ref()
                .map(|s| schedule_of(s).map(|(_, s)| s.period()))
        })
        .transpose()?
        .ok_or_else(|| ControlError::code(POLICY_UNSET))?;
    let opening = Opening {
        actor: &actor,
        reason: &reason,
        operation_id: &operation_id,
        fingerprint: &fp,
        as_of,
        read_at,
        margin: &margin,
        period: schedule::period_bounds(period, read_at),
    };
    match open_run(store, &row, &opening) {
        Ok(opened) => resume_run(store, &row, &opened, sources, past),
        Err(ControlError::Store(e)) if e.code.as_deref() == Some("23505") => {
            match existing_run(store, &operation_id)? {
                Some(raced) => adopt(raced),
                None => Err(ControlError::Store(e)),
            }
        }
        Err(e) => Err(e),
    }
}

// ── the schedule ──────────────────────────────────────────────────────────────────────────────────────────────────

/// One scheduled control that failed this tick: its period stays unrun and the next tick retries it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScheduleFailed {
    pub control_id: String,
    pub message: String,
}

impl ScheduleFailed {
    /// The line `runDueControls` writes to standard error.
    pub fn line(&self) -> String {
        Json::obj([
            ("level", Json::str("error")),
            ("service", Json::str("svc-ledger")),
            (
                "event",
                Json::str("ledger.reconciliation_control.schedule_failed"),
            ),
            ("controlId", Json::str(self.control_id.clone())),
            ("message", Json::str(self.message.clone())),
        ])
        .compact()
    }
}

/// An error's message as `err.message` gives it.
pub fn message_of(e: &ControlError) -> String {
    match e {
        ControlError::Code(c) => c.clone(),
        ControlError::Approval(Refused::Coded { message, .. } | Refused::Thrown(message))
        | ControlError::Thrown(message) => message.clone(),
        ControlError::Store(s) => s.message.clone(),
    }
}

/// `runDueReconciliationControls(sql, sources)`: every active operator control whose period has fallen due, this period
/// and the one before it (so a due instant no tick landed after is caught up). One control that fails does not stop the
/// others; each failure is returned. An error is a tick that could not start: the clock or the control list.
pub fn run_due(store: &Store, sources: &dyn Sources) -> Result<Vec<ScheduleFailed>, ControlError> {
    let at = db_now(store)?;
    let rows = unsafe_client(store, |c| {
        let rows = c.query(
            &format!(
                "SELECT {CONTROL_COLUMNS} FROM reconciliation_controls
                  WHERE builtin = false AND state = 'active' AND schedule IS NOT NULL"
            ),
            &[],
        )?;
        rows.iter()
            .map(ControlRow::read)
            .collect::<Result<Vec<_>, _>>()
    })?;
    let mut failed = Vec::new();
    for row in &rows {
        let once = || -> Result<(), ControlError> {
            let (_, schedule) = schedule_of(row.schedule.as_ref().unwrap_or(&Json::Null))?;
            let period = row
                .period
                .as_deref()
                .and_then(Period::from_word)
                .unwrap_or_else(|| schedule.period());
            let current = schedule::period_bounds(period, at);
            let previous = schedule::period_bounds(period, current.start - 1);
            for bounds in [previous, current] {
                run_scheduled_period(store, row, schedule, bounds, at, sources)?;
            }
            Ok(())
        };
        if let Err(e) = once() {
            failed.push(ScheduleFailed {
                control_id: row.id.clone(),
                message: message_of(&e),
            });
        }
    }
    Ok(failed)
}

fn margin_error(read_at: &str) -> Verdict {
    verdict(
        Status::Error,
        "margin",
        MARGIN_UNSET,
        Vec::new(),
        "not_applicable",
        sources_json(read_at, "unset", "unset"),
    )
}

fn run_scheduled_period(
    store: &Store,
    row: &ControlRow,
    schedule: Schedule,
    bounds: Bounds,
    at: i64,
    sources: &dyn Sources,
) -> Result<(), ControlError> {
    let Some(due) = schedule::due_instant(schedule, bounds.start) else {
        return Ok(());
    };
    if at < due {
        return Ok(());
    }
    // A period that fell due while the control was paused is not caught up on resume.
    if row.resumed_at_ms.is_some_and(|r| due < r) {
        return Ok(());
    }
    let operation_id = format!(
        "{SCHEDULE_OPERATION_PREFIX}{}:{}",
        row.id,
        iso(bounds.start)
    );
    if let Some((existing, _)) = existing_run(store, &operation_id)? {
        // A terminal row is done; a started one is a crash between open and finish: resume it.
        if existing.status == "started" {
            resume_scheduled(store, row, &existing, sources)?;
        }
        return Ok(());
    }
    let actor = Actor {
        actor_id: SCHEDULED_ACTOR.to_owned(),
        request_id: None,
    };
    let margin = row
        .margin
        .as_deref()
        .filter(|m| !schema::js_trim(m).is_empty());
    let Some(margin) = margin else {
        let fp = fingerprint(&row.id, &iso(due), "unset", SCHEDULED_REASON);
        let opened = open_run(
            store,
            row,
            &Opening {
                actor: &actor,
                reason: SCHEDULED_REASON,
                operation_id: &operation_id,
                fingerprint: &fp,
                as_of: due,
                read_at: due,
                margin: "unset",
                period: bounds,
            },
        )?;
        finish_run(store, &opened.id, &margin_error(&iso(due)), &[])?;
        return Ok(());
    };
    // A rail that takes out open items is read at this tick's instant: svc-pay lists items as they are now only.
    let items_rail = contract("controlAccountSet", &row.account_set)
        .ok()
        .and_then(|set| items_rail_of(row, &set, sources));
    let read_at = if items_rail.is_some() {
        at
    } else {
        schedule::read_instant(due, margin)?
    };
    let fp = fingerprint(&row.id, &iso(due), margin, SCHEDULED_REASON);
    let opened = open_run(
        store,
        row,
        &Opening {
            actor: &actor,
            reason: SCHEDULED_REASON,
            operation_id: &operation_id,
            fingerprint: &fp,
            as_of: due,
            read_at,
            margin,
            period: bounds,
        },
    )?;
    resume_run(store, row, &opened, sources, items_rail.is_none())?;
    Ok(())
}

fn resume_scheduled(
    store: &Store,
    row: &ControlRow,
    existing: &RunRow,
    sources: &dyn Sources,
) -> Result<(), ControlError> {
    let blank = row
        .margin
        .as_deref()
        .is_none_or(|m| schema::js_trim(m).is_empty());
    if blank && existing.margin == "unset" {
        finish_run(store, &existing.id, &margin_error(&existing.read_at), &[])?;
        return Ok(());
    }
    resume_run(store, row, existing, sources, true)?;
    Ok(())
}
