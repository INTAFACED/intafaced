//! A test run of a person's own agent that goes on in the background, one step at a time (`own/background.ts`,
//! AG-control-02). Before each step the run re-reads the agent's switches: a quarantine or a kind kill set while it runs
//! stops it at that step, as `stopped` with `agents.agent.quarantined` (or `agents.agent.disabled_by_kind`), and it
//! never takes another. It runs on the test engine: mode test, cost 0, labelled TEST, with no session, reservation,
//! usage row or ledger call.

use postgres::IsolationLevel;
use service_kit::json::Json;
use service_kit::pg::Pool;
use service_kit::time::Instant;

use super::OwnError;
use crate::db::{self, StoreError};
use crate::runtime::ms;

/// The owner's values for background test runs. Each none is blank and refuses a new run.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Settings {
    /// `AGENTS_BACKGROUND_TEST_STEPS`: how many steps one background test run takes.
    pub steps: Option<i64>,
    /// `AGENTS_BACKGROUND_STEP_MS`: how long one step takes; the ticker's period.
    pub step_ms: Option<i64>,
}

/// `STOP_CODE`.
fn stop_code(switch: &str) -> &'static str {
    if switch == "quarantined" {
        "agents.agent.quarantined"
    } else {
        "agents.agent.disabled_by_kind"
    }
}

fn columns() -> String {
    format!(
        "id::text, ask, state, steps_done, steps_total, stop_code, {}, {}",
        ms("started_at"),
        ms("updated_at")
    )
}

/// `ownBackgroundRunSchema`, in its order.
fn view(r: &postgres::Row) -> Result<Json, StoreError> {
    Ok(Json::obj([
        ("id", Json::String(r.try_get(0)?)),
        ("ask", Json::String(r.try_get(1)?)),
        ("state", Json::String(r.try_get(2)?)),
        ("stepsDone", Json::int(i64::from(r.try_get::<_, i32>(3)?))),
        ("stepsTotal", Json::int(i64::from(r.try_get::<_, i32>(4)?))),
        (
            "stopCode",
            r.try_get::<_, Option<String>>(5)?
                .map_or(Json::Null, Json::String),
        ),
        ("mode", Json::str("test")),
        ("cost", Json::str("0")),
        ("label", Json::str("TEST")),
        ("startedAt", Json::str(Instant(r.try_get(6)?).iso())),
        ("updatedAt", Json::str(Instant(r.try_get(7)?).iso())),
    ]))
}

/// `start`: one run; the same request key again is that run. The caller has already checked the agent is switched on.
pub fn start(
    pool: &Pool,
    owner_id: &str,
    agent_id: &str,
    request_key: &str,
    ask: &str,
    steps: i64,
) -> Result<Json, OwnError> {
    let steps = i32::try_from(steps).map_err(|e| OwnError::Thrown(e.to_string()))?;
    let rows = db::with_client(pool, |c| {
        Ok(c.query(
            &format!(
                "INSERT INTO agents.own_agent_background_runs (owner_id, agent_id, request_key, ask, steps_total)
                 VALUES ($1::text, $2::text::uuid, $3::text, $4::text, $5)
                 ON CONFLICT (owner_id, request_key) DO NOTHING
                 RETURNING {}",
                columns()
            ),
            &[&owner_id, &agent_id, &request_key, &ask, &steps],
        )?)
    })?;
    if let Some(r) = rows.first() {
        return Ok(view(r)?);
    }
    let existing = db::with_client(pool, |c| {
        Ok(c.query(
            &format!(
                "SELECT {} FROM agents.own_agent_background_runs
                  WHERE owner_id = $1::text AND request_key = $2::text AND agent_id = $3::text::uuid",
                columns()
            ),
            &[&owner_id, &request_key, &agent_id],
        )?)
    })?;
    match existing.first() {
        Some(r) => Ok(view(r)?),
        None => Err(OwnError::Thrown("agents.request_id_replay".to_owned())),
    }
}

/// `list`: the agent's background runs, newest first.
pub fn list(pool: &Pool, owner_id: &str, agent_id: &str, limit: i64) -> Result<Json, OwnError> {
    let rows = db::with_client(pool, |c| {
        Ok(c.query(
            &format!(
                "SELECT {} FROM agents.own_agent_background_runs
                  WHERE owner_id = $1::text AND agent_id = $2::text::uuid
                  ORDER BY started_at DESC, id
                  LIMIT $3",
                columns()
            ),
            &[&owner_id, &agent_id, &limit],
        )?)
    })?;
    Ok(Json::Array(
        rows.iter().map(view).collect::<Result<_, _>>()?,
    ))
}

/// `advanceBackgroundRuns`: one boundary for every running run: each re-reads its agent's switches, then either stops
/// there or takes one step. A run another ticker holds is skipped, so two instances never take the same step twice.
/// Returns how many it touched.
pub fn advance(pool: &Pool, batch: i64) -> Result<usize, StoreError> {
    db::transaction(pool, IsolationLevel::ReadCommitted, |tx| {
        let running = tx.query(
            "SELECT id::text, agent_id::text, steps_done, steps_total FROM agents.own_agent_background_runs
              WHERE state = 'running'
              ORDER BY updated_at
              LIMIT $1
              FOR UPDATE SKIP LOCKED",
            &[&batch],
        )?;
        for run in &running {
            let (id, agent_id): (String, String) = (run.try_get(0)?, run.try_get(1)?);
            let (done, total): (i32, i32) = (run.try_get(2)?, run.try_get(3)?);
            let on = crate::ops::fleet::own_agent_switch(tx, &agent_id)?;
            if on != "active" {
                tx.execute(
                    "UPDATE agents.own_agent_background_runs SET state = 'stopped', stop_code = $2::text,
                            updated_at = now()
                      WHERE id = $1::text::uuid",
                    &[&id, &stop_code(on)],
                )?;
                continue;
            }
            let done = done + 1;
            let state = if done >= total { "done" } else { "running" };
            tx.execute(
                "UPDATE agents.own_agent_background_runs SET steps_done = $2, state = $3::text, updated_at = now()
                  WHERE id = $1::text::uuid",
                &[&id, &done, &state],
            )?;
        }
        Ok(running.len())
    })
}
