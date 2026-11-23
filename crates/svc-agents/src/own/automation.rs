//! Schedules and event triggers of a person's own agent (`own/automation.ts`, AG-sessions-02, J-agents-07 #1 to #4).
//!
//! A schedule runs the agent once, or again every interval the person set, never below the owner's minimum; a trigger
//! runs it when one of the person's own events arrives. Each occurrence (`agents:schedule:<schedule>:<ordinal>`) or
//! event (`agents:trigger:<trigger>:<event id>`) is one row of `own_agent_auto_runs`, unique on that business key and
//! written before anything runs. Workers wake together, so a due occurrence is claimed under its schedule's row lock:
//! one worker writes the row and runs it, every other one that woke for it only counts its wake. If this crashes after
//! the row and before the run ends, the row stays `claimed` and a later tick resumes it under the same key, whose
//! request id the meter holds, so it is never run or billed twice.
//!
//! The run itself is the agent's own run on a session of its own: admitted against the agent's switch, the owner's own
//! freeze, the schedule's cap per run (a session's spend ceiling, the lower of it and the agent's cap), the person's
//! caps for the agent and the owner's daily occurrence limit, then metered through its usage window like any run. A
//! blank cap or limit skips the occurrence `agents.schedule_blocked` with its reason, and nothing runs. No value moves
//! here; the window's charge is the existing fee charge, at settlement.

use postgres::IsolationLevel;
use service_kit::json::Json;
use service_kit::money::{Amount, format_amount, js_trim, parse_amount};
use service_kit::pg::Pool;
use service_kit::time::Instant;

use super::self_freeze::assert_not_self_frozen;
use super::store::{self, OwnAgent, is_uuid};
use super::test_runs::{caps_set, own_agent_switch};
use super::tool_try::own_guardrail_of;
use super::{OWN_RUN_TASK, OwnError, OwnRefusal};
use crate::db::{self, StoreError};
use crate::gateway::providers::{ChatMessage, Role};
use crate::runtime::{self, Rt, RunError, ThinkInput, ms};

/// `SCHEDULE_BLOCKED`.
pub const SCHEDULE_BLOCKED: &str = "agents.schedule_blocked";
/// How long a claimed run may go without a change before another tick takes it over and resumes it.
pub const AUTO_RUN_LEASE_MS: i64 = 5 * 60_000;
/// `OWN_AGENT_AUTOMATION_LIMITS`.
pub const ASK_LIMIT: usize = 2000;
pub const LIST_LIMIT: i64 = 50;
/// `OWN_AGENT_TRIGGER_SUBJECTS`: the subjects this service consumes.
pub const TRIGGER_SUBJECTS: [&str; 1] = ["trade.fill.settled"];
/// `SUBJECT_PREFIX` (`packages/events`): a bus subject is `intafaced.<subject>`.
pub const SUBJECT_PREFIX: &str = "intafaced";

/// The owner's cadence values (`AGENTS_SCHEDULE_MIN_INTERVAL_MINUTES`, `AGENTS_SCHEDULE_DAILY_LIMIT`); blank (none)
/// refuses a new schedule `agents.schedule_cadence_unset`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Cadence {
    pub min_interval_minutes: Option<i64>,
    pub daily_limit: Option<i64>,
}

impl Cadence {
    /// `ownAgentCadenceSchema`.
    pub fn to_json(self) -> Json {
        Json::obj([
            (
                "minIntervalMinutes",
                self.min_interval_minutes.map_or(Json::Null, Json::int),
            ),
            ("dailyLimit", self.daily_limit.map_or(Json::Null, Json::int)),
        ])
    }
}

/// `scheduleRunKey`.
pub fn schedule_run_key(schedule_id: &str, ordinal: i64) -> String {
    format!("agents:schedule:{schedule_id}:{ordinal}")
}

/// `triggerRunKey`.
pub fn trigger_run_key(trigger_id: &str, event_id: &str) -> String {
    format!("agents:trigger:{trigger_id}:{event_id}")
}

/// `capOf`: blank is none (kept blank, never a default); anything else a decimal at or above zero.
fn cap_of(text: &str) -> Result<Option<Amount>, OwnRefusal> {
    let value = js_trim(text);
    if value.is_empty() {
        return Ok(None);
    }
    match parse_amount(value) {
        Ok(a) if a >= Amount::ZERO => Ok(Some(a)),
        _ => Err(OwnRefusal::new("agents.own.cap_invalid")),
    }
}

/// `askOf`.
fn ask_of(text: &str) -> Result<String, OwnRefusal> {
    if text.contains('\u{0}') || text.encode_utf16().count() > ASK_LIMIT {
        return Err(OwnRefusal::new("agents.own.text_invalid"));
    }
    if js_trim(text).is_empty() {
        return Err(OwnRefusal::new("agents.schedule.ask_blank"));
    }
    Ok(text.to_owned())
}

/// A new schedule, checked (`ScheduleRequest`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScheduleRequest {
    pub repeat: String,
    pub interval_minutes: Option<i64>,
    pub per_run_cap: Option<Amount>,
    pub ask: String,
}

/// `/^[0-9]{1,6}$/`.
fn digits(text: &str) -> Option<i64> {
    (!text.is_empty() && text.len() <= 6 && text.bytes().all(|b| b.is_ascii_digit()))
        .then(|| text.parse().ok())
        .flatten()
}

/// `checkScheduleRequest`: the owner's cadence first, then a repeating schedule's interval, then the ask. A blank cap
/// per run is kept blank.
pub fn check_schedule_request(
    repeat: &str,
    interval_minutes: &str,
    per_run_cap: &str,
    ask: &str,
    cadence: Cadence,
) -> Result<ScheduleRequest, OwnRefusal> {
    let (Some(minimum), Some(_)) = (cadence.min_interval_minutes, cadence.daily_limit) else {
        return Err(OwnRefusal::new("agents.schedule_cadence_unset"));
    };
    let text = js_trim(interval_minutes);
    let mut interval = None;
    if repeat == "repeat" {
        if text.is_empty() {
            return Err(OwnRefusal::new("agents.schedule.min_interval_unset"));
        }
        let Some(n) = digits(text).filter(|n| *n >= 1) else {
            return Err(OwnRefusal::new("agents.schedule.interval_invalid"));
        };
        if n < minimum {
            return Err(OwnRefusal::with(
                "agents.schedule.interval_below_minimum",
                [("minimum", minimum.to_string())],
            ));
        }
        interval = Some(n);
    } else if !text.is_empty() {
        return Err(OwnRefusal::new("agents.schedule.interval_invalid"));
    }
    let ask = ask_of(ask)?;
    Ok(ScheduleRequest {
        repeat: repeat.to_owned(),
        interval_minutes: interval,
        per_run_cap: cap_of(per_run_cap)?,
        ask,
    })
}

/// A new trigger, checked.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TriggerRequest {
    pub subject: &'static str,
    pub per_run_cap: Option<Amount>,
    pub ask: String,
}

/// `checkTriggerRequest`: a subject this service offers, a cap per run kept as typed, and an ask.
pub fn check_trigger_request(
    subject: &str,
    per_run_cap: &str,
    ask: &str,
) -> Result<TriggerRequest, OwnRefusal> {
    let Some(subject) = TRIGGER_SUBJECTS.iter().find(|s| **s == subject) else {
        return Err(OwnRefusal::new("agents.trigger_subject_invalid"));
    };
    Ok(TriggerRequest {
        subject,
        per_run_cap: cap_of(per_run_cap)?,
        ask: ask_of(ask)?,
    })
}

fn amount_text(text: Option<String>) -> Result<Json, StoreError> {
    text.map_or(Ok(Json::Null), |t| {
        parse_amount(&t)
            .map(|a| Json::str(format_amount(a)))
            .map_err(|e| StoreError::new(e, None))
    })
}

fn iso(t: Option<i64>) -> Json {
    t.map_or(Json::Null, |t| Json::str(Instant(t).iso()))
}

fn opt(s: Option<String>) -> Json {
    s.map_or(Json::Null, Json::String)
}

fn auto_run_columns() -> String {
    format!(
        "r.id::text, r.run_key, r.source_id::text, r.ordinal, r.event_id, {}, r.state, r.code, r.reason_code,
         r.session_id::text, r.cost::text, r.wakes, {}, {},
         (SELECT count(*)::int FROM agents.agent_actions a
           WHERE r.session_id IS NOT NULL AND a.session_id = r.session_id AND a.kind = 'completion'
             AND a.status = 'executed') AS runs",
        ms("r.due_at"),
        ms("r.created_at"),
        ms("r.updated_at")
    )
}

/// One row of `own_agent_auto_runs` and the source it belongs to, as `ownAgentAutoRunSchema` orders it.
fn auto_run_view(r: &postgres::Row, asset_id: &str) -> Result<(String, Json), StoreError> {
    let source: String = r.try_get(2)?;
    let view = Json::obj([
        ("id", Json::String(r.try_get(0)?)),
        ("runKey", Json::String(r.try_get(1)?)),
        (
            "ordinal",
            r.try_get::<_, Option<i32>>(3)?
                .map_or(Json::Null, |n| Json::int(i64::from(n))),
        ),
        ("eventId", opt(r.try_get(4)?)),
        ("dueAt", Json::str(Instant(r.try_get(5)?).iso())),
        ("state", Json::String(r.try_get(6)?)),
        ("code", opt(r.try_get(7)?)),
        ("reasonCode", opt(r.try_get(8)?)),
        ("sessionId", opt(r.try_get(9)?)),
        ("runs", Json::int(i64::from(r.try_get::<_, i32>(14)?))),
        ("wakes", Json::int(i64::from(r.try_get::<_, i32>(11)?))),
        ("cost", amount_text(r.try_get(10)?)?),
        ("assetId", Json::str(asset_id)),
        ("createdAt", Json::str(Instant(r.try_get(12)?).iso())),
        ("updatedAt", Json::str(Instant(r.try_get(13)?).iso())),
    ]);
    Ok((source, view))
}

/// The person's own schedules and triggers (`OwnAutomationStore`). Every read and write is bound to the owner; another's
/// reads as not found.
pub struct Automation<'a> {
    pub pool: &'a Pool,
    pub asset_id: &'a str,
}

impl Automation<'_> {
    /// `recent`: each source's newest runs, at most `limit` each.
    fn recent(
        &self,
        source_ids: &[String],
        limit: usize,
    ) -> Result<Vec<(String, Vec<Json>)>, OwnError> {
        let mut out: Vec<(String, Vec<Json>)> = Vec::new();
        if source_ids.is_empty() {
            return Ok(out);
        }
        let rows = db::with_client(self.pool, |c| {
            Ok(c.query(
                &format!(
                    "SELECT {} FROM agents.own_agent_auto_runs r
                      WHERE r.source_id::text = ANY($1::text[])
                      ORDER BY r.created_at DESC, r.ordinal DESC NULLS LAST",
                    auto_run_columns()
                ),
                &[&source_ids],
            )?)
        })?;
        for row in &rows {
            let (source, view) = auto_run_view(row, self.asset_id)?;
            match out.iter_mut().find(|(s, _)| *s == source) {
                Some((_, list)) => {
                    if list.len() < limit {
                        list.push(view);
                    }
                }
                None => out.push((source, vec![view])),
            }
        }
        Ok(out)
    }

    fn recent_of(recent: &[(String, Vec<Json>)], id: &str) -> Json {
        Json::Array(
            recent
                .iter()
                .find(|(s, _)| s == id)
                .map(|(_, l)| l.clone())
                .unwrap_or_default(),
        )
    }

    /// `createSchedule`: due at once; the same create key is the same schedule.
    pub fn create_schedule(
        &self,
        owner_id: &str,
        agent: &OwnAgent,
        create_key: &str,
        request: &ScheduleRequest,
    ) -> Result<Json, OwnError> {
        let cap = request.per_run_cap.map(format_amount);
        let interval = request
            .interval_minutes
            .map(i32::try_from)
            .transpose()
            .map_err(|e| OwnError::Thrown(e.to_string()))?;
        let id: String = db::with_client(self.pool, |c| {
            Ok(c.query_one(
                "INSERT INTO agents.own_agent_schedules
                   (agent_id, owner_id, create_key, repeat, interval_minutes, per_run_cap, ask, next_due_at)
                 VALUES ($1::text::uuid, $2::text, $3::text, $4::text, $5, $6::text::numeric, $7::text, now())
                 ON CONFLICT (owner_id, create_key) DO UPDATE SET updated_at = agents.own_agent_schedules.updated_at
                 RETURNING id::text",
                &[&agent.id, &owner_id, &create_key, &request.repeat, &interval, &cap, &request.ask],
            )?
            .try_get(0)?)
        })?;
        self.schedule(owner_id, &agent.id, &id)
    }

    /// `schedule`.
    pub fn schedule(&self, owner_id: &str, agent_id: &str, id: &str) -> Result<Json, OwnError> {
        self.schedules(owner_id, agent_id, LIST_LIMIT)?
            .into_iter()
            .find(|s| matches!(s.get("id"), Some(Json::String(v)) if v == id))
            .ok_or_else(|| OwnRefusal::new("agents.schedule.not_found").into())
    }

    /// `schedules`: newest first, each with its recent occurrences.
    pub fn schedules(
        &self,
        owner_id: &str,
        agent_id: &str,
        limit: i64,
    ) -> Result<Vec<Json>, OwnError> {
        let rows = db::with_client(self.pool, |c| {
            Ok(c.query(
                &format!(
                    "SELECT id::text, agent_id::text, repeat, interval_minutes, per_run_cap::text, ask, state, {}, {}
                       FROM agents.own_agent_schedules
                      WHERE owner_id = $1::text AND agent_id::text = $2::text
                      ORDER BY created_at DESC, id
                      LIMIT $3",
                    ms("next_due_at"),
                    ms("created_at")
                ),
                &[&owner_id, &agent_id, &limit],
            )?)
        })?;
        let ids = rows
            .iter()
            .map(|r| r.try_get::<_, String>(0))
            .collect::<Result<Vec<_>, _>>()?;
        let recent = self.recent(&ids, usize::try_from(LIST_LIMIT).unwrap_or(50))?;
        rows.iter()
            .map(|r| {
                let id: String = r.try_get(0)?;
                Ok(Json::obj([
                    ("id", Json::str(id.clone())),
                    ("agentId", Json::String(r.try_get(1)?)),
                    ("repeat", Json::String(r.try_get(2)?)),
                    (
                        "intervalMinutes",
                        r.try_get::<_, Option<i32>>(3)?
                            .map_or(Json::Null, |n| Json::int(i64::from(n))),
                    ),
                    ("perRunCap", amount_text(r.try_get(4)?)?),
                    ("ask", Json::String(r.try_get(5)?)),
                    ("state", Json::String(r.try_get(6)?)),
                    ("nextDueAt", iso(r.try_get(7)?)),
                    ("createdAt", Json::str(Instant(r.try_get(8)?).iso())),
                    ("recent", Self::recent_of(&recent, &id)),
                ]))
            })
            .collect()
    }

    /// `cancelSchedule`: no next occurrence and none claimed after this; a run already running goes on. Cancelling
    /// again returns the cancelled schedule.
    pub fn cancel_schedule(
        &self,
        owner_id: &str,
        agent_id: &str,
        id: &str,
    ) -> Result<Json, OwnError> {
        if !is_uuid(id) {
            return Err(OwnRefusal::new("agents.schedule.not_found").into());
        }
        let rows = db::with_client(self.pool, |c| {
            Ok(c.query(
                "UPDATE agents.own_agent_schedules
                    SET state = CASE WHEN state = 'active' THEN 'cancelled' ELSE state END,
                        next_due_at = CASE WHEN state = 'active' THEN NULL ELSE next_due_at END,
                        updated_at = now()
                  WHERE owner_id = $1::text AND agent_id::text = $2::text AND id = $3::text::uuid
                 RETURNING id::text",
                &[&owner_id, &agent_id, &id],
            )?)
        })?;
        if rows.is_empty() {
            return Err(OwnRefusal::new("agents.schedule.not_found").into());
        }
        self.schedule(owner_id, agent_id, id)
    }

    /// `createTrigger`: the same create key is the same trigger.
    pub fn create_trigger(
        &self,
        owner_id: &str,
        agent: &OwnAgent,
        create_key: &str,
        request: &TriggerRequest,
    ) -> Result<Json, OwnError> {
        let cap = request.per_run_cap.map(format_amount);
        let id: String = db::with_client(self.pool, |c| {
            Ok(c.query_one(
                "INSERT INTO agents.own_agent_triggers (agent_id, owner_id, create_key, subject, per_run_cap, ask)
                 VALUES ($1::text::uuid, $2::text, $3::text, $4::text, $5::text::numeric, $6::text)
                 ON CONFLICT (owner_id, create_key) DO UPDATE SET updated_at = agents.own_agent_triggers.updated_at
                 RETURNING id::text",
                &[&agent.id, &owner_id, &create_key, &request.subject, &cap, &request.ask],
            )?
            .try_get(0)?)
        })?;
        self.triggers(owner_id, &agent.id, LIST_LIMIT)?
            .into_iter()
            .find(|t| matches!(t.get("id"), Some(Json::String(v)) if *v == id))
            .ok_or_else(|| OwnRefusal::new("agents.trigger.not_found").into())
    }

    /// `triggers`: newest first, each with the events delivered to it and the runs they made.
    pub fn triggers(
        &self,
        owner_id: &str,
        agent_id: &str,
        limit: i64,
    ) -> Result<Vec<Json>, OwnError> {
        let rows = db::with_client(self.pool, |c| {
            Ok(c.query(
                &format!(
                    "SELECT id::text, agent_id::text, subject, per_run_cap::text, ask, state, {}
                       FROM agents.own_agent_triggers
                      WHERE owner_id = $1::text AND agent_id::text = $2::text
                      ORDER BY created_at DESC, id
                      LIMIT $3",
                    ms("created_at")
                ),
                &[&owner_id, &agent_id, &limit],
            )?)
        })?;
        let ids = rows
            .iter()
            .map(|r| r.try_get::<_, String>(0))
            .collect::<Result<Vec<_>, _>>()?;
        let runs = self.recent(&ids, usize::try_from(LIST_LIMIT).unwrap_or(50))?;
        let deliveries = if ids.is_empty() {
            Vec::new()
        } else {
            db::with_client(self.pool, |c| {
                Ok(c.query(
                    &format!(
                        "SELECT trigger_id::text, envelope_id, event_id, redelivered, {}
                           FROM agents.own_agent_trigger_deliveries
                          WHERE trigger_id::text = ANY($1::text[])
                          ORDER BY received_at DESC, envelope_id",
                        ms("received_at")
                    ),
                    &[&ids],
                )?)
            })?
        };
        rows.iter()
            .map(|r| {
                let id: String = r.try_get(0)?;
                let mut delivered = Vec::new();
                for d in &deliveries {
                    if d.try_get::<_, String>(0)? != id
                        || delivered.len() >= usize::try_from(LIST_LIMIT).unwrap_or(50)
                    {
                        continue;
                    }
                    delivered.push(Json::obj([
                        ("eventId", Json::String(d.try_get(2)?)),
                        ("envelopeId", Json::String(d.try_get(1)?)),
                        ("redelivered", Json::Bool(d.try_get(3)?)),
                        ("receivedAt", Json::str(Instant(d.try_get(4)?).iso())),
                    ]));
                }
                Ok(Json::obj([
                    ("id", Json::str(id.clone())),
                    ("agentId", Json::String(r.try_get(1)?)),
                    ("subject", Json::String(r.try_get(2)?)),
                    ("perRunCap", amount_text(r.try_get(3)?)?),
                    ("ask", Json::String(r.try_get(4)?)),
                    ("state", Json::String(r.try_get(5)?)),
                    ("createdAt", Json::str(Instant(r.try_get(6)?).iso())),
                    ("runs", Self::recent_of(&runs, &id)),
                    ("deliveries", Json::Array(delivered)),
                ]))
            })
            .collect()
    }
}

/// Where an automatic run stops for a test to make two of them overlap (the TypeScript test wraps `sql.begin` and
/// `runtime.think` for the same). The service passes none.
pub trait Pause: Sync {
    /// A delivery's claim transaction for `event_id` has begun, before it takes the trigger's row lock.
    fn claim_begun(&self, _event_id: &str) {}
    /// A delivery's claim for `event_id` has committed.
    fn claim_committed(&self, _event_id: &str) {}
    /// The run under `request_id` is about to ask the engine.
    fn before_think(&self, _request_id: &str) {}
}

/// Where an automatic run's fault is told: a message and its detail.
pub type Log<'a> = dyn Fn(&str, &str) + Sync + 'a;

/// What running an occurrence or an event needs (`AutoRunDeps`): the runtime's view (whose freeze reader is asked before
/// each run) and the owner's cadence. The run task is [`OWN_RUN_TASK`] and the guardrail `ownGuardrail`.
pub struct AutoRuns<'a> {
    pub x: Rt<'a>,
    pub cadence: Cadence,
    /// `log`: a run that failed, or a window left unpaid.
    pub log: Option<&'a Log<'a>>,
    pub pause: Option<&'a dyn Pause>,
}

impl AutoRuns<'_> {
    fn log(&self, msg: &str, detail: &str) {
        if let Some(log) = self.log {
            log(msg, detail);
        }
    }
}

/// `settle`: a claimed run ends in its state, once.
fn settle(
    pool: &Pool,
    id: &str,
    state: &str,
    code: Option<&str>,
    reason: Option<&str>,
    cost: Option<Amount>,
) -> Result<(), OwnError> {
    let cost = cost.map(format_amount);
    db::with_client(pool, |c| {
        c.execute(
            "UPDATE agents.own_agent_auto_runs
                SET state = $2::text, code = $3::text, reason_code = $4::text, cost = $5::text::numeric,
                    updated_at = now()
              WHERE id = $1::text::uuid AND state = 'claimed'",
            &[&id, &state, &code, &reason, &cost],
        )?;
        Ok(())
    })?;
    Ok(())
}

fn store_error(e: RunError) -> OwnError {
    match e {
        RunError::Store(s) => OwnError::Thrown(s.message),
        RunError::Agent(d) | RunError::MeteredReplay(d) => OwnError::Thrown(d.error.message),
        RunError::Trpc(t) => OwnError::Trpc(t),
        RunError::Other(m) => OwnError::Thrown(m),
        RunError::Refused { refusal, .. } => OwnError::Thrown(refusal.code),
    }
}

/// `executeAutoRun`: one claimed occurrence or event, once: admission, then the agent's own run on a session of its
/// own under the run key as its request id, then the session's close, which bills its window. Ends `ran`, `skipped`
/// (with `agents.schedule_blocked` and its reason), `refused` (with the run's own refusal code) or `failed`.
#[allow(
    clippy::too_many_lines,
    reason = "one run's admission, session, engine call and close, in the TypeScript's order"
)]
pub fn execute_auto_run(deps: &AutoRuns<'_>, run_id: &str) -> Result<(), OwnError> {
    let x = &deps.x;
    let pool = x.pool;
    let rows = db::with_client(pool, |c| {
        Ok(c.query(
            "SELECT r.id::text, r.run_key, r.agent_id::text, r.owner_id, r.source_id::text, r.session_id::text, r.state,
                    COALESCE(s.per_run_cap, t.per_run_cap)::text, COALESCE(s.ask, t.ask)
               FROM agents.own_agent_auto_runs r
               LEFT JOIN agents.own_agent_schedules s ON r.source = 'schedule' AND s.id = r.source_id
               LEFT JOIN agents.own_agent_triggers t ON r.source = 'trigger' AND t.id = r.source_id
              WHERE r.id = $1::text::uuid",
            &[&run_id],
        )?)
    })?;
    let Some(row) = rows.first() else {
        return Ok(());
    };
    let id: String = row.try_get(0)?;
    let run_key: String = row.try_get(1)?;
    let agent_id: String = row.try_get(2)?;
    let owner_id: String = row.try_get(3)?;
    let source_id: String = row.try_get(4)?;
    let bound: Option<String> = row.try_get(5)?;
    let state: String = row.try_get(6)?;
    let per_run_cap: Option<String> = row.try_get(7)?;
    let ask: String = row.try_get::<_, Option<String>>(8)?.unwrap_or_default();
    if state != "claimed" {
        return Ok(());
    }
    let skip = |reason: &str| {
        settle(
            pool,
            &id,
            "skipped",
            Some(SCHEDULE_BLOCKED),
            Some(reason),
            None,
        )
    };

    let agent = match store::get(pool, &owner_id, &agent_id) {
        Ok(a) => a,
        Err(OwnError::Refusal(r)) => return skip(&r.code),
        Err(e) => return Err(e),
    };
    // Admission, as for the person's own run: nothing runs on a guess.
    if own_agent_switch(pool, &agent.id)? != "active" {
        return skip("agents.agent.disabled");
    }
    // The owner's own freeze, read at each run (J-wallet-13): frozen or unreadable, the occurrence is skipped by its code.
    if let Err(r) = assert_not_self_frozen(&owner_id, x.rt.self_freeze.as_deref()) {
        return skip(&r.code);
    }
    let Some(per_run_cap) = per_run_cap else {
        return skip("agents.schedule.cap_per_run_unset");
    };
    if !caps_set(pool, &owner_id, &agent.id)? {
        return skip("agents.spend.cap_unset");
    }
    let Some(daily_limit) = deps.cadence.daily_limit else {
        return skip("agents.schedule_cadence_unset");
    };
    // Today's runs of this schedule or trigger: those that ran, and those claimed before this one and still running,
    // so runs claimed together (two fills at once) cannot each pass the limit before either settles.
    let today: i32 = db::with_client(pool, |c| {
        Ok(c.query_one(
            "SELECT count(*)::int FROM agents.own_agent_auto_runs
              WHERE source_id = $1::text::uuid AND id <> $2::text::uuid AND created_at >= date_trunc('day', now())
                AND (state = 'ran'
                     OR (state = 'claimed' AND (created_at, id) <
                         (SELECT created_at, id FROM agents.own_agent_auto_runs WHERE id = $2::text::uuid)))",
            &[&source_id, &id],
        )?
        .try_get(0)?)
    })?;
    if i64::from(today) >= daily_limit {
        return skip("agents.schedule.daily_limit_reached");
    }

    // The session of this run, opened once: a resumed run keeps the session its first attempt opened.
    let session_id = match bound {
        Some(s) => s,
        None => {
            let amount = |t: &str| parse_amount(t).map_err(OwnError::Thrown);
            let agent_cap = amount(agent.per_session_cap.as_deref().unwrap_or_default())?;
            let cap = format_amount(agent_cap.min(amount(&per_run_cap)?));
            let guardrail = own_guardrail_of(&agent.id, agent.version, &agent.tools, Some(&cap))
                .map_err(OwnError::Thrown)?;
            let session =
                runtime::open_own_session(x, &owner_id, &guardrail).map_err(store_error)?;
            let kept: String = db::with_client(pool, |c| {
                Ok(c.query_one(
                    "UPDATE agents.own_agent_auto_runs SET session_id = COALESCE(session_id, $2::text::uuid),
                            updated_at = now()
                      WHERE id = $1::text::uuid RETURNING session_id::text",
                    &[&id, &session.id],
                )?
                .try_get(0)?)
            })?;
            if kept != session.id {
                let _ = runtime::close_session(x, &session.id);
            }
            kept
        }
    };

    if let Some(p) = deps.pause {
        p.before_think(&run_key);
    }
    // The ask is the person's own, stored with the schedule or trigger. An event's payload never reaches the agent: it
    // is untrusted and can choose no tool, destination or amount.
    let messages = [ChatMessage {
        role: Role::User,
        content: ask,
    }];
    let instructions = agent.instructions.clone();
    let thought = runtime::think(
        x,
        &ThinkInput {
            session_id: &session_id,
            request_id: &run_key,
            task: OWN_RUN_TASK,
            system: (!js_trim(&instructions).is_empty()).then_some(instructions.as_str()),
            messages: &messages,
            max_output_tokens: None,
            team_run: false,
        },
    );
    let cost = match thought {
        Ok(result) => Some(result.cost),
        Err(RunError::MeteredReplay(_)) => {
            // A resumed run whose engine call was already metered: it ran, once. Its cost is what the meter holds.
            let metered: Option<String> = db::with_client(pool, |c| {
                Ok(c.query_one(
                    "SELECT sum(cost)::text FROM agents.agent_actions
                      WHERE session_id = $1::text::uuid AND kind = 'completion' AND status = 'executed'",
                    &[&session_id],
                )?
                .try_get(0)?)
            })?;
            metered
                .filter(|t| !t.is_empty())
                .map(|t| parse_amount(&t).map_err(OwnError::Thrown))
                .transpose()?
        }
        Err(RunError::Refused { refusal, .. }) => {
            let _ = runtime::close_settled(x, &session_id);
            return settle(pool, &id, "refused", Some(&refusal.code), None, None);
        }
        Err(e) => {
            let code = match &e {
                RunError::Agent(d) => d.error.code,
                _ => "agents.error.engine_unavailable",
            };
            settle(pool, &id, "failed", Some(code), None, None)?;
            deps.log(
                "own agent automatic run failed",
                &format!("{run_key}: {e:?}"),
            );
            return Ok(());
        }
    };
    // Closing bills the session's window on its own charge key. A window the ledger refuses stays unpaid and is
    // retried before the person's next run (the runtime's unpaid-window rule); the run itself happened once.
    if let Err(e) = runtime::close_settled(x, &session_id) {
        deps.log(
            "own agent automatic run window unpaid",
            &format!("{run_key}: {e:?}"),
        );
    }
    settle(pool, &id, "ran", None, None, cost)
}

/// `claimDue`: one worker's claim of the occurrences it woke for. Under the schedule's row lock: still active and still
/// on that ordinal, the worker writes the occurrence row and moves the schedule on; already taken, it counts its wake
/// on the row the other worker wrote. Returns the ids this worker claimed.
fn claim_due(pool: &Pool, due: &[(String, i64)]) -> Result<Vec<String>, OwnError> {
    let mut claimed = Vec::new();
    for (id, ordinal) in due {
        let key = schedule_run_key(id, *ordinal);
        let run = db::transaction(pool, IsolationLevel::ReadCommitted, |tx| {
            let rows = tx.query(
                "SELECT agent_id::text, owner_id, state, next_ordinal, next_due_at IS NOT NULL
                   FROM agents.own_agent_schedules WHERE id = $1::text::uuid FOR UPDATE",
                &[&id],
            )?;
            let Some(s) = rows.first() else {
                return Ok(None);
            };
            let (agent_id, owner_id, state): (String, String, String) =
                (s.try_get(0)?, s.try_get(1)?, s.try_get(2)?);
            let (next_ordinal, due): (i32, bool) = (s.try_get(3)?, s.try_get(4)?);
            if state != "active" || i64::from(next_ordinal) != *ordinal || !due {
                tx.execute(
                    "UPDATE agents.own_agent_auto_runs SET wakes = wakes + 1 WHERE run_key = $1::text",
                    &[&key],
                )?;
                return Ok(None);
            }
            // created_at is the claim time under this row lock, after the schedule's newest run: never now(), the
            // transaction's start, which a worker that began first but took the lock second would carry (#8326).
            let inserted = tx.query(
                "INSERT INTO agents.own_agent_auto_runs (run_key, agent_id, owner_id, source, source_id, ordinal, due_at, created_at)
                 VALUES ($1::text, $2::text::uuid, $3::text, 'schedule', $4::text::uuid, $5,
                         (SELECT next_due_at FROM agents.own_agent_schedules WHERE id = $4::text::uuid),
                         (SELECT GREATEST(clock_timestamp(), max(created_at) + interval '1 microsecond')
                            FROM agents.own_agent_auto_runs WHERE source_id = $4::text::uuid))
                 ON CONFLICT (run_key) DO UPDATE SET wakes = agents.own_agent_auto_runs.wakes + 1
                 RETURNING id::text, (xmax = 0)",
                &[&key, &agent_id, &owner_id, &id, &next_ordinal],
            )?;
            tx.execute(
                "UPDATE agents.own_agent_schedules
                    SET next_ordinal = next_ordinal + 1,
                        state = CASE WHEN repeat = 'once' THEN 'completed' ELSE state END,
                        next_due_at = CASE WHEN repeat = 'once' THEN NULL
                                           ELSE GREATEST(next_due_at + make_interval(mins => interval_minutes), now()) END,
                        updated_at = now()
                  WHERE id = $1::text::uuid",
                &[&id],
            )?;
            match inserted.first() {
                Some(r) if r.try_get::<_, bool>(1)? => Ok(Some(r.try_get::<_, String>(0)?)),
                _ => Ok(None),
            }
        })?;
        if let Some(run) = run {
            claimed.push(run);
        }
    }
    Ok(claimed)
}

/// `dueSchedules`: the active schedules due now, with the ordinal each is on.
fn due_schedules(pool: &Pool, limit: i64) -> Result<Vec<(String, i64)>, OwnError> {
    let rows = db::with_client(pool, |c| {
        Ok(c.query(
            "SELECT id::text, next_ordinal FROM agents.own_agent_schedules
              WHERE state = 'active' AND next_due_at <= now()
              ORDER BY next_due_at, id
              LIMIT $1",
            &[&limit],
        )?)
    })?;
    Ok(rows
        .iter()
        .map(|r| Ok((r.try_get(0)?, i64::from(r.try_get::<_, i32>(1)?))))
        .collect::<Result<_, postgres::Error>>()?)
}

/// What one tick did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Tick {
    pub claimed: usize,
    pub resumed: usize,
}

/// `tickSchedules`: one tick of the due-run workers. Every worker wakes and reads what is due before any of them
/// claims, as workers on separate machines would; each then claims under the schedule's lock and runs what it claimed,
/// the workers side by side. Claimed runs a crash left behind past their lease are taken over and resumed first.
pub fn tick_schedules(deps: &AutoRuns<'_>, workers: u32) -> Result<Tick, OwnError> {
    let pool = deps.x.pool;
    let stale = db::with_client(pool, |c| {
        Ok(c.query(
            "UPDATE agents.own_agent_auto_runs SET updated_at = now()
              WHERE state = 'claimed' AND updated_at < to_timestamp($1::bigint / 1000.0)
             RETURNING id::text",
            &[&(deps.x.now.0 - AUTO_RUN_LEASE_MS)],
        )?)
    })?;
    let stale: Vec<String> = stale
        .iter()
        .map(|r| r.try_get(0))
        .collect::<Result<_, _>>()?;
    for id in &stale {
        execute_auto_run(deps, id)?;
    }
    let woke = (0..workers.max(1))
        .map(|_| due_schedules(pool, 20))
        .collect::<Result<Vec<_>, _>>()?;
    let claimed = std::thread::scope(|scope| {
        let handles: Vec<_> = woke
            .iter()
            .map(|due| {
                scope.spawn(move || -> Result<usize, OwnError> {
                    let ids = claim_due(pool, due)?;
                    for id in &ids {
                        execute_auto_run(deps, id)?;
                    }
                    Ok(ids.len())
                })
            })
            .collect();
        handles
            .into_iter()
            .map(|h| {
                h.join().unwrap_or_else(|_| {
                    Err(OwnError::Thrown("a schedule worker stopped".to_owned()))
                })
            })
            .collect::<Result<Vec<_>, _>>()
    })?;
    Ok(Tick {
        claimed: claimed.iter().sum(),
        resumed: stale.len(),
    })
}

/// One event of the person's, as the bus delivers it (`deliverTriggerEvent`'s input).
pub struct TriggerEvent<'a> {
    /// The bus subject as the envelope carries it (`intafaced.trade.fill.settled`).
    pub subject: &'a str,
    pub user_id: &'a str,
    pub event_id: &'a str,
    pub envelope_id: &'a str,
    /// The event's own time, ISO.
    pub occurred_at: &'a str,
}

/// `deliverTriggerEvent`: one delivery of a person's own event to their triggers on its subject. Under each trigger's
/// row lock: the delivery is recorded (a redelivery of an event id already seen is marked so), and the event's run row
/// is written once; only the delivery that wrote it runs it. The run row is the seen-set, in Postgres, so a restart
/// never runs an event twice. An event that happened before a trigger was added never runs it. Returns how many runs
/// it made.
pub fn deliver_trigger_event(
    deps: &AutoRuns<'_>,
    event: &TriggerEvent<'_>,
) -> Result<usize, OwnError> {
    let prefix = format!("{SUBJECT_PREFIX}.");
    let Some(subject) = event.subject.strip_prefix(&prefix) else {
        return Err(OwnError::Thrown(format!(
            "deliverTriggerEvent takes a bus subject ({prefix}…), not {}",
            event.subject
        )));
    };
    let pool = deps.x.pool;
    let triggers = db::with_client(pool, |c| {
        Ok(c.query(
            "SELECT id::text FROM agents.own_agent_triggers
              WHERE subject = $1::text AND owner_id = $2::text AND state = 'active'
                AND created_at <= $3::text::timestamptz",
            &[&subject, &event.user_id, &event.occurred_at],
        )?)
    })?;
    let triggers: Vec<String> = triggers
        .iter()
        .map(|r| r.try_get(0))
        .collect::<Result<_, _>>()?;
    let mut ran = 0;
    for trigger in &triggers {
        let run = db::transaction(pool, IsolationLevel::ReadCommitted, |tx| {
            if let Some(p) = deps.pause {
                // The transaction has begun once it has asked something: as `sql.begin` has by the time its body runs.
                tx.query_one("SELECT 1", &[])?;
                p.claim_begun(event.event_id);
            }
            let rows = tx.query(
                "SELECT agent_id::text, owner_id, state FROM agents.own_agent_triggers
                  WHERE id = $1::text::uuid FOR UPDATE",
                &[&trigger],
            )?;
            let Some(locked) = rows.first() else {
                return Ok(None);
            };
            let (agent_id, owner_id, state): (String, String, String) =
                (locked.try_get(0)?, locked.try_get(1)?, locked.try_get(2)?);
            if state != "active" {
                return Ok(None);
            }
            let seen: i32 = tx
                .query_one(
                    "SELECT count(*)::int FROM agents.own_agent_trigger_deliveries
                      WHERE trigger_id = $1::text::uuid AND event_id = $2::text",
                    &[&trigger, &event.event_id],
                )?
                .try_get(0)?;
            tx.execute(
                "INSERT INTO agents.own_agent_trigger_deliveries (trigger_id, agent_id, envelope_id, event_id, redelivered)
                 VALUES ($1::text::uuid, $2::text::uuid, $3::text, $4::text, $5)
                 ON CONFLICT (trigger_id, envelope_id) DO NOTHING",
                &[&trigger, &agent_id, &event.envelope_id, &event.event_id, &(seen > 0)],
            )?;
            // created_at is the claim time under this row lock, after the trigger's newest run (see claimDue; #8326).
            let inserted = tx.query(
                "INSERT INTO agents.own_agent_auto_runs (run_key, agent_id, owner_id, source, source_id, event_id, due_at, created_at)
                 VALUES ($1::text, $2::text::uuid, $3::text, 'trigger', $4::text::uuid, $5::text, now(),
                         (SELECT GREATEST(clock_timestamp(), max(created_at) + interval '1 microsecond')
                            FROM agents.own_agent_auto_runs WHERE source_id = $4::text::uuid))
                 ON CONFLICT (run_key) DO NOTHING
                 RETURNING id::text",
                &[
                    &trigger_run_key(trigger, event.event_id),
                    &agent_id,
                    &owner_id,
                    &trigger,
                    &event.event_id,
                ],
            )?;
            Ok(inserted
                .first()
                .map(|r| r.try_get::<_, String>(0))
                .transpose()?)
        })?;
        if let Some(p) = deps.pause {
            p.claim_committed(event.event_id);
        }
        if let Some(run) = run {
            execute_auto_run(deps, &run)?;
            ran += 1;
        }
    }
    Ok(ran)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test: a failure is the point")]
    use super::*;

    const CADENCE: Cadence = Cadence {
        min_interval_minutes: Some(1),
        daily_limit: Some(100),
    };

    fn code(r: Result<ScheduleRequest, OwnRefusal>) -> String {
        r.unwrap_err().code
    }

    /// `automation.test.ts`: "refuses a blank owner cadence first, then a repeating schedule with its interval blank,
    /// by name".
    #[test]
    fn refuses_a_blank_owner_cadence_first_then_a_repeating_schedule_with_its_interval_blank_by_name()
     {
        let typed = |interval: &str, cap: &str, ask: &str, cadence: Cadence| {
            check_schedule_request("repeat", interval, cap, ask, cadence)
        };
        let blank_minimum = Cadence {
            min_interval_minutes: None,
            daily_limit: Some(100),
        };
        let blank_limit = Cadence {
            min_interval_minutes: Some(1),
            daily_limit: None,
        };
        assert_eq!(
            code(typed("5", "0.1", "TEST check", blank_minimum)),
            "agents.schedule_cadence_unset"
        );
        assert_eq!(
            code(typed("5", "0.1", "TEST check", blank_limit)),
            "agents.schedule_cadence_unset"
        );
        assert_eq!(
            code(typed("", "0.1", "TEST check", CADENCE)),
            "agents.schedule.min_interval_unset"
        );
        assert_eq!(
            code(typed("  ", "0.1", "TEST check", CADENCE)),
            "agents.schedule.min_interval_unset"
        );
        for interval in ["0", "1.5", "-1", "hourly"] {
            assert_eq!(
                code(typed(interval, "0.1", "TEST check", CADENCE)),
                "agents.schedule.interval_invalid"
            );
        }
        let five = Cadence {
            min_interval_minutes: Some(5),
            daily_limit: Some(1),
        };
        let below = typed("4", "0.1", "TEST check", five).unwrap_err();
        assert_eq!(below.code, "agents.schedule.interval_below_minimum");
        assert_eq!(below.params, vec![("minimum".to_owned(), "5".to_owned())]);
        assert_eq!(
            code(typed("5", "0.1", " ", CADENCE)),
            "agents.schedule.ask_blank"
        );
        assert_eq!(
            code(typed("5", "-1", "TEST check", CADENCE)),
            "agents.own.cap_invalid"
        );
    }

    /// "keeps a blank cap per run blank, never a default, and a once schedule takes no interval".
    #[test]
    fn keeps_a_blank_cap_per_run_blank_and_a_once_schedule_takes_no_interval() {
        let blank = check_schedule_request("repeat", "5", "", "TEST check", CADENCE).unwrap();
        assert_eq!((blank.per_run_cap, blank.interval_minutes), (None, Some(5)));
        let once = check_schedule_request("once", "", "0.1", "TEST check", CADENCE).unwrap();
        assert_eq!(once.interval_minutes, None);
        assert_eq!(
            code(check_schedule_request(
                "once",
                "5",
                "0.1",
                "TEST check",
                CADENCE
            )),
            "agents.schedule.interval_invalid"
        );
    }

    /// "offers only subjects it consumes".
    #[test]
    fn offers_only_subjects_it_consumes() {
        assert_eq!(
            check_trigger_request("trade.fill.settled", "0.1", "TEST")
                .unwrap()
                .subject,
            "trade.fill.settled"
        );
        assert_eq!(
            check_trigger_request("identity.kyc.approved", "0.1", "TEST")
                .unwrap_err()
                .code,
            "agents.trigger_subject_invalid"
        );
    }

    #[test]
    fn an_ask_past_its_limit_or_with_a_nul_is_invalid_text() {
        let long = "a".repeat(ASK_LIMIT + 1);
        assert_eq!(ask_of(&long).unwrap_err().code, "agents.own.text_invalid");
        assert_eq!(
            ask_of("a\u{0}b").unwrap_err().code,
            "agents.own.text_invalid"
        );
        assert_eq!(ask_of(&"a".repeat(ASK_LIMIT)).unwrap().len(), ASK_LIMIT);
    }
}
