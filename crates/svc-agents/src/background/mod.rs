//! A session's background runs (`runs/background.ts`; AG-sessions-04, AG-control-01; J-agents-06). A person starts a
//! run on their own open session and leaves the screen; the run goes on without the page, one step at a time. Each step
//! is one metered engine call on the session's task under the business key `bg:<run id>:<step>`, so a step called
//! again after a crash is metered once (the engine refuses the replay and the run fails on it, charging nothing twice).
//!
//! A step is in flight from its start until its call returned and its reply was stored. A running run always has its
//! next step in flight, taking `stepMs` before its call is made. Pausing starts no further step (one in flight
//! finishes); resuming goes on from the stored steps. Stopping lets a call in flight finish and stores it, starts nothing
//! more, settles the session's open usage windows once and keeps that answer, so a second stop returns the first one. No
//! step holds a spend reservation past its own call: the engine reserves and releases inside the call.
//!
//! A step's call is made under its run's row lock, held on one connection while the call uses others, as the
//! TypeScript's `sql.begin` does: the pool needs two connections at least (`DATABASE_POOL_MAX`).
//!
//! Every read and change is bounded to the caller's own runs: someone else's run id is not found.

pub mod slice;

use postgres::{Client, GenericClient};

use service_kit::json::{self, Json};
use service_kit::money::{Amount, format_amount, parse_amount};
use service_kit::pg::Pool;
use service_kit::time::Instant;
use service_kit::trpc::TrpcError;

use crate::db::StoreError;
use crate::gateway::providers::{ChatMessage, Role};
use crate::metering::meter::{self, MeterError};
use crate::metering::ports::Bus;
use crate::metering::settle;
use crate::runtime::{self, Rt, RunError, ThinkInput, denied, ms};
use crate::webhooks::{self, FinishedRun};

/// `SessionRunSettings`: the owner's values. Each `None` is blank and refuses a new run.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Settings {
    /// `AGENTS_SESSION_RUN_MAX_STEPS`: the most steps one background run may be asked to take.
    pub max_steps: Option<i64>,
    /// `AGENTS_BACKGROUND_STEP_MS`: how long one background step is in flight before its call; the ticker's period.
    pub step_ms: Option<i64>,
}

/// `agentRunCompleted`'s subject.
pub const RUN_COMPLETED: &str = "intafaced.agents.run.completed";

const ENDED: [&str; 3] = ["completed", "stopped", "failed"];

/// A run's row (`RunRow`).
#[derive(Debug, Clone, PartialEq)]
pub struct RunRow {
    pub id: String,
    pub user_id: String,
    pub session_id: String,
    pub agent_id: String,
    pub task: String,
    pub ask: String,
    pub follow_ups: Vec<String>,
    pub notice: String,
    pub steps_total: i64,
    pub state: String,
    pub failure_code: Option<String>,
    pub resumed_at: Option<Instant>,
    pub stop_result: Option<Json>,
    pub finished_at: Option<Instant>,
    pub created_at: Instant,
    pub updated_at: Instant,
}

/// A step's row (`StepRow`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StepRow {
    pub n: i64,
    pub state: String,
    pub reply: Option<String>,
    pub cost: Option<String>,
    pub started_at: Instant,
    pub finished_at: Option<Instant>,
}

fn run_columns() -> String {
    format!(
        "id::text, user_id, session_id::text, agent_id, task, ask, follow_ups::text, notice, steps_total, state, \
         failure_code, {}, stop_result::text, {}, {}, {}",
        ms("resumed_at"),
        ms("finished_at"),
        ms("created_at"),
        ms("updated_at")
    )
}

fn run_of(r: &postgres::Row) -> Result<RunRow, RunError> {
    let follow: String = r.try_get(6)?;
    let follow_ups = match json::parse(&follow).map_err(|e| RunError::Other(e.message))? {
        Json::Array(items) => items
            .into_iter()
            .filter_map(|v| match v {
                Json::String(s) => Some(s),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    };
    let stop_result = r
        .try_get::<_, Option<String>>(12)?
        .map(|t| json::parse(&t).map_err(|e| RunError::Other(e.message)))
        .transpose()?;
    Ok(RunRow {
        id: r.try_get(0)?,
        user_id: r.try_get(1)?,
        session_id: r.try_get(2)?,
        agent_id: r.try_get(3)?,
        task: r.try_get(4)?,
        ask: r.try_get(5)?,
        follow_ups,
        notice: r.try_get(7)?,
        steps_total: i64::from(r.try_get::<_, i32>(8)?),
        state: r.try_get(9)?,
        failure_code: r.try_get(10)?,
        resumed_at: r.try_get::<_, Option<i64>>(11)?.map(Instant),
        stop_result,
        finished_at: r.try_get::<_, Option<i64>>(13)?.map(Instant),
        created_at: Instant(r.try_get(14)?),
        updated_at: Instant(r.try_get(15)?),
    })
}

fn opt_str(v: Option<&str>) -> Json {
    v.map_or(Json::Null, Json::str)
}

fn opt_iso(v: Option<Instant>) -> Json {
    v.map_or(Json::Null, |i| Json::str(i.iso()))
}

/// `stopResultSchema`'s shape, in its key order, from the stored answer.
fn stop_output(stored: &Json) -> Json {
    let field = |k: &str| stored.get(k).cloned().unwrap_or(Json::Null);
    let settlements = match stored.get("settlements") {
        Some(Json::Array(items)) => items
            .iter()
            .map(|s| {
                let f = |k: &str| s.get(k).cloned().unwrap_or(Json::Null);
                Json::obj([
                    ("windowId", f("windowId")),
                    ("amount", f("amount")),
                    ("chargeKey", f("chargeKey")),
                    ("settled", f("settled")),
                ])
            })
            .collect(),
        _ => Vec::new(),
    };
    Json::obj([
        ("stoppedAt", field("stoppedAt")),
        ("billed", field("billed")),
        ("assetId", field("assetId")),
        ("settlements", Json::Array(settlements)),
        ("unpaid", field("unpaid")),
    ])
}

/// `view(run, steps)`: `sessionRunSchema`, in its key order.
pub fn view(run: &RunRow, steps: &[StepRow]) -> Json {
    let reply = steps.iter().rev().find_map(|s| s.reply.as_deref());
    Json::obj([
        ("runId", Json::str(run.id.clone())),
        ("sessionId", Json::str(run.session_id.clone())),
        ("agentId", Json::str(run.agent_id.clone())),
        ("task", Json::str(run.task.clone())),
        ("ask", Json::str(run.ask.clone())),
        (
            "followUps",
            Json::Array(run.follow_ups.iter().cloned().map(Json::String).collect()),
        ),
        ("notice", Json::str(run.notice.clone())),
        ("state", Json::str(run.state.clone())),
        ("stepsTotal", Json::int(run.steps_total)),
        ("failureCode", opt_str(run.failure_code.as_deref())),
        ("resumedAt", opt_iso(run.resumed_at)),
        ("finishedAt", opt_iso(run.finished_at)),
        ("reply", opt_str(reply)),
        (
            "steps",
            Json::Array(
                steps
                    .iter()
                    .map(|s| {
                        Json::obj([
                            ("n", Json::int(s.n)),
                            ("state", Json::str(s.state.clone())),
                            ("reply", opt_str(s.reply.as_deref())),
                            ("cost", opt_str(s.cost.as_deref())),
                            ("startedAt", Json::str(s.started_at.iso())),
                            ("finishedAt", opt_iso(s.finished_at)),
                        ])
                    })
                    .collect(),
            ),
        ),
        (
            "stop",
            run.stop_result.as_ref().map_or(Json::Null, stop_output),
        ),
        ("createdAt", Json::str(run.created_at.iso())),
        ("updatedAt", Json::str(run.updated_at.iso())),
    ])
}

/// `SessionRunConflict`: a change the run's state does not allow, by its own typed code (`typed` in the routes).
pub fn conflict(code: &str) -> RunError {
    RunError::Trpc(TrpcError::caused("CONFLICT", code, code))
}

/// `stepRequestId`: the business key of one step's engine call.
pub fn step_request_id(run_id: &str, n: i64) -> String {
    format!("bg:{run_id}:{n}")
}

/// `stepMessages`: the ask and every follow-up, then each stored reply in turn with the step that comes next.
pub fn step_messages(
    ask: &str,
    follow_ups: &[String],
    steps_total: i64,
    done: &[StepRow],
) -> Vec<ChatMessage> {
    let mut first = vec![ask.to_owned()];
    first.extend(follow_ups.iter().cloned());
    let mut messages = vec![ChatMessage {
        role: Role::User,
        content: first.join("\n\n"),
    }];
    for (i, step) in done.iter().enumerate() {
        let Some(reply) = &step.reply else { continue };
        messages.push(ChatMessage {
            role: Role::Assistant,
            content: reply.clone(),
        });
        messages.push(ChatMessage {
            role: Role::User,
            content: format!("Go on with step {} of {steps_total}.", i + 2),
        });
    }
    messages
}

fn lock_run(
    tx: &mut impl GenericClient,
    run_id: &str,
    user_id: Option<&str>,
    skip_locked: bool,
) -> Result<Option<RunRow>, RunError> {
    let sql = format!(
        "SELECT {} FROM agents.session_background_runs WHERE id = $1::text::uuid {} FOR UPDATE {}",
        run_columns(),
        if user_id.is_some() {
            "AND user_id = $2::text"
        } else {
            ""
        },
        if skip_locked { "SKIP LOCKED" } else { "" }
    );
    let rows = match user_id {
        Some(u) => tx.query(&sql, &[&run_id, &u])?,
        None => tx.query(&sql, &[&run_id])?,
    };
    rows.first().map(run_of).transpose()
}

fn steps_of(c: &mut impl GenericClient, run_id: &str) -> Result<Vec<StepRow>, RunError> {
    let rows = c.query(
        &format!(
            "SELECT n, state, reply, cost, {}, {} FROM agents.session_background_run_steps \
             WHERE run_id = $1::text::uuid ORDER BY n",
            ms("started_at"),
            ms("finished_at")
        ),
        &[&run_id],
    )?;
    rows.iter()
        .map(|r| {
            Ok(StepRow {
                n: i64::from(r.try_get::<_, i32>(0)?),
                state: r.try_get(1)?,
                reply: r.try_get(2)?,
                cost: r.try_get(3)?,
                started_at: Instant(r.try_get(4)?),
                finished_at: r.try_get::<_, Option<i64>>(5)?.map(Instant),
            })
        })
        .collect()
}

/// `deliverEnded`: the ended run's webhook delivery (J-agents-12 #5), in the transaction that ended it: its state, the
/// last reply, the steps' summed cost and the failure code. A background run ends once, so its event is sequence 1.
fn deliver_ended(
    tx: &mut impl GenericClient,
    run_id: &str,
    fee_asset_id: &str,
) -> Result<(), RunError> {
    let rows = tx.query(
        "SELECT user_id, session_id::text, agent_id, state, failure_code \
           FROM agents.session_background_runs WHERE id = $1::text::uuid",
        &[&run_id],
    )?;
    let Some(r) = rows.first() else {
        return Ok(());
    };
    let (user_id, session_id, agent_id, state): (String, String, String, String) =
        (r.try_get(0)?, r.try_get(1)?, r.try_get(2)?, r.try_get(3)?);
    let failure: Option<String> = r.try_get(4)?;
    let steps = steps_of(tx, run_id)?;
    let costs = steps
        .iter()
        .filter_map(|st| st.cost.as_deref())
        .map(parse_amount)
        .collect::<Result<Vec<Amount>, String>>()
        .map_err(RunError::Other)?;
    let reply = steps.iter().rev().find_map(|st| st.reply.as_deref());
    webhooks::enqueue_run_finished(
        tx,
        &FinishedRun {
            event_id: webhooks::finished_event_id(webhooks::Kind::Background, run_id, 1),
            kind: webhooks::Kind::Background,
            user_id: &user_id,
            run_id,
            session_id: &session_id,
            agent_id: &agent_id,
            state: &state,
            reply,
            cost: (!costs.is_empty()).then(|| format_amount(costs.iter().sum())),
            asset_id: (!costs.is_empty()).then_some(fee_asset_id),
            refusal_codes: failure.into_iter().collect(),
        },
    )?;
    Ok(())
}

/// `err instanceof AgentError ? err.code : 'agents.provider_failed'`: a guardrail's refusal is `agents.refused`.
fn failure_code(e: &RunError) -> String {
    match e {
        RunError::Refused { .. } => "agents.refused".to_owned(),
        RunError::Agent(d) | RunError::MeteredReplay(d) => d.error.code.to_owned(),
        _ => "agents.provider_failed".to_owned(),
    }
}

/// `finishStep`: makes the in-flight step's call and stores what it returned, as `done` (or `done_after_stop`). A
/// refused call stores the step as `refused` and, unless stopped, fails the run on its code. Under the run's row lock.
fn finish_step(
    tx: &mut impl GenericClient,
    x: &Rt<'_>,
    run: &RunRow,
    steps: &[StepRow],
    after_stop: bool,
) -> Result<bool, RunError> {
    let Some((step, before)) = steps.split_last() else {
        return Ok(true);
    };
    let messages = step_messages(&run.ask, &run.follow_ups, run.steps_total, before);
    let request_id = step_request_id(&run.id, step.n);
    let n = i32::try_from(step.n).map_err(|e| RunError::Other(e.to_string()))?;
    let result = runtime::think(
        x,
        &ThinkInput {
            session_id: &run.session_id,
            request_id: &request_id,
            task: &run.task,
            system: None,
            messages: &messages,
            max_output_tokens: None,
            team_run: false,
        },
    );
    match result {
        Ok(r) => {
            let state = if after_stop {
                "done_after_stop"
            } else {
                "done"
            };
            tx.execute(
                "UPDATE agents.session_background_run_steps SET state = $3::text, reply = $4::text, cost = $5::text, \
                 finished_at = now() WHERE run_id = $1::text::uuid AND n = $2",
                &[&run.id, &n, &state, &r.text, &format_amount(r.cost)],
            )?;
            Ok(true)
        }
        Err(e) => {
            let code = failure_code(&e);
            tx.execute(
                "UPDATE agents.session_background_run_steps SET state = 'refused', finished_at = now() \
                 WHERE run_id = $1::text::uuid AND n = $2",
                &[&run.id, &n],
            )?;
            if !after_stop {
                tx.execute(
                    "UPDATE agents.session_background_runs SET state = 'failed', failure_code = $2::text, \
                     finished_at = now(), updated_at = now() WHERE id = $1::text::uuid",
                    &[&run.id, &code],
                )?;
                deliver_ended(tx, &run.id, &x.m.fee_asset_id)?;
            }
            Ok(false)
        }
    }
}

/// One transaction on one connection of the pool: committed when `f` succeeds, rolled back when it fails.
fn begin<T>(
    pool: &Pool,
    f: impl FnOnce(&mut postgres::Transaction<'_>) -> Result<T, RunError>,
) -> Result<T, RunError> {
    let mut conn = pool.get().map_err(StoreError::from)?;
    let client: &mut Client = conn.client().map_err(StoreError::from)?;
    let mut tx = client.transaction()?;
    let out = f(&mut tx)?;
    tx.commit()?;
    Ok(out)
}

fn with_client<T>(
    pool: &Pool,
    f: impl FnOnce(&mut Client) -> Result<T, RunError>,
) -> Result<T, RunError> {
    let mut conn = pool.get().map_err(StoreError::from)?;
    let client: &mut Client = conn.client().map_err(StoreError::from)?;
    f(client)
}

/// What `start` stores.
pub struct StartInput<'a> {
    pub user_id: &'a str,
    pub session_id: &'a str,
    pub agent_id: &'a str,
    pub request_key: &'a str,
    pub task: &'a str,
    pub ask: &'a str,
    pub notice: &'a str,
    pub steps: i64,
}

/// `start`: one run on the caller's session; the same request key again is that run. The same key on another session
/// is another request reusing it: refused, never answered with the first run.
pub fn start(pool: &Pool, input: &StartInput<'_>) -> Result<Json, RunError> {
    let steps = i32::try_from(input.steps).map_err(|e| RunError::Other(e.to_string()))?;
    let id = with_client(pool, |c| {
        let inserted = c.query(
            "INSERT INTO agents.session_background_runs (user_id, session_id, agent_id, request_key, task, ask, notice, steps_total)
             VALUES ($1::text, $2::text::uuid, $3::text, $4::text, $5::text, $6::text, $7::text, $8)
             ON CONFLICT (user_id, request_key) DO NOTHING
             RETURNING id::text",
            &[
                &input.user_id,
                &input.session_id,
                &input.agent_id,
                &input.request_key,
                &input.task,
                &input.ask,
                &input.notice,
                &steps,
            ],
        )?;
        if let Some(r) = inserted.first() {
            return Ok(Some(r.try_get::<_, String>(0)?));
        }
        let found = c.query(
            "SELECT id::text FROM agents.session_background_runs
              WHERE user_id = $1::text AND request_key = $2::text AND session_id = $3::text::uuid",
            &[&input.user_id, &input.request_key, &input.session_id],
        )?;
        Ok(found
            .first()
            .map(|r| r.try_get::<_, String>(0))
            .transpose()?)
    })?;
    let Some(id) = id else {
        return Err(RunError::Agent(denied(
            "agents.request_id_replay",
            "agents.error.request_id_replay",
            "background run request key reused".to_owned(),
            vec![],
        )));
    };
    get(pool, &id, input.user_id)?
        .ok_or_else(|| RunError::Other("the run just stored is gone".to_owned()))
}

/// `get`: one of the caller's runs with its steps, or none for a run that is not theirs.
pub fn get(pool: &Pool, run_id: &str, user_id: &str) -> Result<Option<Json>, RunError> {
    with_client(pool, |c| {
        let rows = c.query(
            &format!(
                "SELECT {} FROM agents.session_background_runs WHERE id = $1::text::uuid AND user_id = $2::text",
                run_columns()
            ),
            &[&run_id, &user_id],
        )?;
        let Some(run) = rows.first().map(run_of).transpose()? else {
            return Ok(None);
        };
        let steps = steps_of(c, run_id)?;
        Ok(Some(view(&run, &steps)))
    })
}

/// `change`: under the run's lock, refused once it ended; none for a run that is not the caller's.
fn change(
    pool: &Pool,
    run_id: &str,
    user_id: &str,
    f: impl FnOnce(&mut postgres::Transaction<'_>, &RunRow) -> Result<(), RunError>,
) -> Result<Option<Json>, RunError> {
    let found = begin(pool, |tx| {
        let Some(run) = lock_run(tx, run_id, Some(user_id), false)? else {
            return Ok(false);
        };
        if ENDED.contains(&run.state.as_str()) {
            return Err(conflict("agents.run.ended"));
        }
        f(tx, &run)?;
        Ok(true)
    })?;
    if found {
        get(pool, run_id, user_id)
    } else {
        Ok(None)
    }
}

/// `pause`: takes no further step; a step in flight finishes. Pausing a paused run is that run.
pub fn pause(pool: &Pool, run_id: &str, user_id: &str) -> Result<Option<Json>, RunError> {
    change(pool, run_id, user_id, |tx, run| {
        if run.state != "paused" {
            tx.execute(
                "UPDATE agents.session_background_runs SET state = 'paused', updated_at = now() WHERE id = $1::text::uuid",
                &[&run.id],
            )?;
        }
        Ok(())
    })
}

/// `resume`: goes on from the stored steps. Resuming a running run is that run.
pub fn resume(pool: &Pool, run_id: &str, user_id: &str) -> Result<Option<Json>, RunError> {
    change(pool, run_id, user_id, |tx, run| {
        if run.state == "paused" {
            tx.execute(
                "UPDATE agents.session_background_runs SET state = 'running', resumed_at = now(), updated_at = now() \
                 WHERE id = $1::text::uuid",
                &[&run.id],
            )?;
        }
        Ok(())
    })
}

/// `askMore`: one more request to a running run, one more step with the follow-up in its messages. Refused while
/// paused, and past the most steps allowed.
pub fn ask_more(
    pool: &Pool,
    run_id: &str,
    user_id: &str,
    text: &str,
    max_steps: i64,
) -> Result<Option<Json>, RunError> {
    change(pool, run_id, user_id, |tx, run| {
        if run.state == "paused" {
            return Err(conflict("agents.run.paused"));
        }
        if run.steps_total + 1 > max_steps {
            return Err(conflict("agents.session_run_steps_over"));
        }
        let more = Json::Array(vec![Json::str(text)]).compact();
        tx.execute(
            "UPDATE agents.session_background_runs
                SET follow_ups = follow_ups || $2::text::jsonb, steps_total = steps_total + 1, updated_at = now()
              WHERE id = $1::text::uuid",
            &[&run.id, &more],
        )?;
        Ok(())
    })
}

/// `stop`: a call in flight finishes and is stored, nothing further runs, and the session's open windows are settled
/// once. The answer is kept: a second stop returns it and settles nothing again (`repeated`).
pub fn stop(x: &Rt<'_>, run_id: &str, user_id: &str) -> Result<Option<Json>, RunError> {
    let outcome = begin(x.pool, |tx| {
        let Some(run) = lock_run(tx, run_id, Some(user_id), false)? else {
            return Ok(None);
        };
        if run.stop_result.is_some() {
            return Ok(Some(true));
        }
        if ENDED.contains(&run.state.as_str()) {
            return Err(conflict("agents.run.ended"));
        }
        tx.execute(
            "UPDATE agents.session_background_runs SET state = 'stopped', updated_at = now() WHERE id = $1::text::uuid",
            &[&run.id],
        )?;
        let steps = steps_of(tx, &run.id)?;
        if steps.last().is_some_and(|s| s.state == "in_flight") {
            finish_step(tx, x, &run, &steps, true)?;
        }
        let result = settle_session(x, &run.session_id)?;
        tx.execute(
            "UPDATE agents.session_background_runs SET stop_result = $2::text::jsonb, finished_at = now(), updated_at = now() \
             WHERE id = $1::text::uuid",
            &[&run.id, &result.compact()],
        )?;
        deliver_ended(tx, &run.id, &x.m.fee_asset_id)?;
        Ok(Some(false))
    })?;
    let Some(repeated) = outcome else {
        return Ok(None);
    };
    let run = get(x.pool, run_id, user_id)?
        .ok_or_else(|| RunError::Other("the stopped run is gone".to_owned()))?;
    Ok(Some(Json::obj([
        ("run", run),
        ("repeated", Json::Bool(repeated)),
    ])))
}

/// `settle`: the session's open windows one by one. A window the ledger refuses for funds, or the person's partner does
/// not pay, stays sealed and unpaid and is named; the windows paid before it are kept, so what was billed is never
/// under-reported.
fn settle_session(x: &Rt<'_>, session_id: &str) -> Result<Json, RunError> {
    let stopped_at = x.now.iso();
    let mut settlements = Vec::new();
    let mut billed: Amount = 0;
    let mut unpaid = Json::Null;
    for window_id in meter::open_windows(x.pool, session_id)? {
        match settle::settle_window(x.m, x.pool, session_id, &window_id, x.now) {
            Ok(r) => {
                billed += r.amount;
                settlements.push(Json::obj([
                    ("windowId", Json::str(r.window_id.clone())),
                    ("amount", Json::str(format_amount(r.amount))),
                    ("chargeKey", Json::str(r.charge_key.clone())),
                    ("settled", Json::Bool(r.settled)),
                ]));
            }
            // A window the person's partner did not pay is owed the same way (launch money model, J-agents-01).
            Err(MeterError::Ledger(l))
                if l.code.as_deref() == Some("ledger.insufficient_funds") =>
            {
                unpaid = Json::str("agents.window_unpaid");
                break;
            }
            Err(MeterError::Agent(a)) if a.code == "agents.window_unpaid" => {
                unpaid = Json::str("agents.window_unpaid");
                break;
            }
            Err(e) => return Err(e.into()),
        }
    }
    Ok(Json::obj([
        ("stoppedAt", Json::str(stopped_at)),
        ("billed", Json::str(format_amount(billed))),
        ("assetId", Json::str(x.m.fee_asset_id.clone())),
        ("settlements", Json::Array(settlements)),
        ("unpaid", unpaid),
    ]))
}

/// `advanceSessionRuns`: one pass over every live run. A step in flight whose time is up makes its call and is stored;
/// a running run then starts its next step, or completes after its last. A paused run starts nothing. A run another
/// ticker holds is skipped, so two instances never make the same call. Returns how many runs it touched.
pub fn advance(x: &Rt<'_>, step_ms: i64, batch: i64) -> Result<i64, RunError> {
    let live: Vec<String> = with_client(x.pool, |c| {
        c.query(
            "SELECT id::text FROM agents.session_background_runs
              WHERE state IN ('queued', 'running', 'paused') ORDER BY updated_at LIMIT $1",
            &[&batch],
        )?
        .iter()
        .map(|r| Ok(r.try_get::<_, String>(0)?))
        .collect()
    })?;
    let mut touched = 0;
    for id in live {
        let moved = begin(x.pool, |tx| {
            let Some(run) = lock_run(tx, &id, None, true)? else {
                return Ok(false);
            };
            if ENDED.contains(&run.state.as_str()) {
                return Ok(false);
            }
            let steps = steps_of(tx, &id)?;
            let last_in_flight = steps.last().is_some_and(|s| s.state == "in_flight");
            if let Some(last) = steps.last().filter(|_| last_in_flight) {
                if x.now.0 - last.started_at.0 < step_ms {
                    return Ok(false);
                }
                if !finish_step(tx, x, &run, &steps, false)? {
                    return Ok(true);
                }
            }
            if run.state == "paused" {
                return Ok(last_in_flight);
            }
            let taken = steps.last().map_or(0, |s| s.n);
            if taken >= run.steps_total {
                tx.execute(
                    "UPDATE agents.session_background_runs SET state = 'completed', finished_at = now(), updated_at = now() \
                     WHERE id = $1::text::uuid",
                    &[&id],
                )?;
                deliver_ended(tx, &id, &x.m.fee_asset_id)?;
                return Ok(true);
            }
            let next = i32::try_from(taken + 1).map_err(|e| RunError::Other(e.to_string()))?;
            tx.execute(
                "INSERT INTO agents.session_background_run_steps (run_id, n) VALUES ($1::text::uuid, $2)",
                &[&id, &next],
            )?;
            tx.execute(
                "UPDATE agents.session_background_runs SET state = 'running', updated_at = now() WHERE id = $1::text::uuid",
                &[&id],
            )?;
            Ok(true)
        })?;
        if moved {
            touched += 1;
        }
    }
    Ok(touched)
}

/// `publishCompletedRuns`: the finish notice of every completed run not yet announced, on the run id, then marked. A
/// crash between the publish and the mark publishes it again on the next pass under the same key; svc-notify writes one
/// row per key.
pub fn publish_completed(
    pool: &Pool,
    bus: &dyn Bus,
    producer: &str,
    now: Instant,
    batch: i64,
) -> Result<i64, RunError> {
    let rows = with_client(pool, |c| {
        Ok(c.query(
            &format!(
                "SELECT id::text, user_id, session_id::text, agent_id, notice, {}
                   FROM agents.session_background_runs
                  WHERE state = 'completed' AND notice_published_at IS NULL
                  ORDER BY finished_at LIMIT $1",
                ms("finished_at")
            ),
            &[&batch],
        )?)
    })?;
    let mut published = 0;
    for r in &rows {
        let id: String = r.try_get(0)?;
        let finished: Option<i64> = r.try_get(5)?;
        let key = format!("agents.run.completed:{id}");
        let payload = Json::obj([
            ("runId", Json::str(id.clone())),
            ("userId", Json::str(r.try_get::<_, String>(1)?)),
            ("sessionId", Json::str(r.try_get::<_, String>(2)?)),
            ("agentId", Json::str(r.try_get::<_, String>(3)?)),
            ("notice", Json::str(r.try_get::<_, String>(4)?)),
            ("finishedAt", opt_iso(finished.map(Instant))),
        ]);
        let envelope = Json::obj([
            (
                "id",
                Json::str(settle::random_uuid().map_err(RunError::Other)?),
            ),
            ("subject", Json::str(RUN_COMPLETED)),
            ("version", Json::int(1)),
            ("occurredAt", Json::str(now.iso())),
            ("producer", Json::str(producer)),
            ("idempotencyKey", Json::str(key.clone())),
            ("payload", payload),
        ]);
        bus.publish(RUN_COMPLETED, &key, &envelope)
            .map_err(RunError::Other)?;
        with_client(pool, |c| {
            c.execute(
                "UPDATE agents.session_background_runs SET notice_published_at = now() WHERE id = $1::text::uuid",
                &[&id],
            )?;
            Ok(())
        })?;
        published += 1;
    }
    Ok(published)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn step(n: i64, reply: Option<&str>) -> StepRow {
        StepRow {
            n,
            state: if reply.is_some() { "done" } else { "refused" }.to_owned(),
            reply: reply.map(str::to_owned),
            cost: None,
            started_at: Instant(0),
            finished_at: None,
        }
    }

    #[test]
    fn a_step_goes_on_from_every_stored_reply() {
        let m = step_messages(
            "ask",
            &["more".to_owned()],
            3,
            &[step(1, Some("one")), step(2, None), step(3, Some("three"))],
        );
        let pairs: Vec<(bool, &str)> = m
            .iter()
            .map(|c| (c.role == Role::User, c.content.as_str()))
            .collect();
        assert_eq!(
            pairs,
            vec![
                (true, "ask\n\nmore"),
                (false, "one"),
                (true, "Go on with step 2 of 3."),
                (false, "three"),
                (true, "Go on with step 4 of 3."),
            ]
        );
        assert_eq!(step_request_id("r", 2), "bg:r:2");
    }

    #[test]
    fn a_guardrail_refusal_fails_the_run_as_agents_refused_and_an_outage_as_provider_failed() {
        assert_eq!(
            failure_code(&RunError::Other("down".to_owned())),
            "agents.provider_failed"
        );
        let d = denied("agents.window_unpaid", "k", "m".to_owned(), vec![]);
        assert_eq!(failure_code(&RunError::Agent(d)), "agents.window_unpaid");
    }
}
