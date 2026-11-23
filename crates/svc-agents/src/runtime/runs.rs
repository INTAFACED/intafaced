//! The stored run (\`runs/store.ts\`, \`runs/machine.ts\`, \`runs/record.ts\`; AG-sessions-01, ENGINE RS-1 to RS-4): the run
//! row and its first event written before anything runs, each change along RS-2 with one event, and \`runRecorded\`
//! around one engine call. Reads are the caller's own runs; someone else's reads as not found.

use postgres::IsolationLevel;

use service_kit::json::{self, Json};
use service_kit::money::{Amount, format_amount, parse_amount};
use service_kit::pg::Pool;
use service_kit::time::Instant;
use service_kit::trpc::TrpcError;

use crate::db::{self, StoreError};
use crate::runtime::{RunError, ThinkResult, denied, ms};
use crate::webhooks::{self, FinishedRun};

/// \`RUN_STATES\`.
pub const RUN_STATES: [&str; 6] = [
    "admitted",
    "running",
    "waiting_approval",
    "completed",
    "refused",
    "failed",
];

/// \`canMove\`: RS-2.
pub fn can_move(from: &str, to: &str) -> bool {
    let allowed: &[&str] = match from {
        "admitted" => &["running", "refused", "failed"],
        "running" => &["waiting_approval", "completed", "refused", "failed"],
        "waiting_approval" => &["running", "refused", "failed"],
        "refused" | "failed" => &["running"],
        _ => &[],
    };
    allowed.contains(&to)
}

/// `ENDINGS`: the states a run ends in; each ending is delivered once to the person's run webhooks (J-agents-12 #5).
const ENDINGS: [&str; 3] = ["completed", "refused", "failed"];

/// \`RUN_LEASE_MS\`: how long a running run is left to its caller before a retry may take it over.
pub const RUN_LEASE_MS: i64 = 300_000;

/// \`RunTransitionError\` as the run routes answer it (\`typed\`): a conflict by its own code.
pub fn transition_invalid() -> RunError {
    RunError::Trpc(TrpcError::caused(
        "CONFLICT",
        "agents.run_transition_invalid",
        "agents.run_transition_invalid",
    ))
}

/// \`StoredRun\`.
#[derive(Debug, Clone, PartialEq)]
pub struct StoredRun {
    pub id: String,
    pub run_key: String,
    pub user_id: String,
    pub session_id: String,
    pub request_id: String,
    pub agent_id: String,
    pub task: Option<String>,
    pub state: String,
    pub reply: Option<String>,
    pub cost: Option<String>,
    pub asset_id: Option<String>,
    pub metered: Option<bool>,
    pub action_id: Option<String>,
    pub provenance: Option<Json>,
    pub created_at: Instant,
    pub updated_at: Instant,
}

/// \`runKeyOf\`.
pub fn run_key_of(session_id: &str, request_id: &str) -> String {
    format!("agents:run:{session_id}:{request_id}")
}

fn columns() -> String {
    format!(
        "id::text, run_key, user_id, session_id::text, request_id, agent_id, task, state, reply, cost::text, asset_id, \
         metered, action_id::text, provenance::text, {}, {}",
        ms("created_at"),
        ms("updated_at")
    )
}

fn run_of(r: &postgres::Row) -> Result<StoredRun, RunError> {
    let cost: Option<String> = r.try_get(9)?;
    let provenance: Option<String> = r.try_get(13)?;
    Ok(StoredRun {
        id: r.try_get(0)?,
        run_key: r.try_get(1)?,
        user_id: r.try_get(2)?,
        session_id: r.try_get(3)?,
        request_id: r.try_get(4)?,
        agent_id: r.try_get(5)?,
        task: r.try_get(6)?,
        state: r.try_get(7)?,
        reply: r.try_get(8)?,
        cost: cost
            .as_deref()
            .map(|c| parse_amount(c).map(format_amount))
            .transpose()
            .map_err(RunError::Other)?,
        asset_id: r.try_get(10)?,
        metered: r.try_get(11)?,
        action_id: r.try_get(12)?,
        provenance: provenance
            .as_deref()
            .map(json::parse)
            .transpose()
            .map_err(|e| RunError::Other(e.message))?,
        created_at: Instant(r.try_get(14)?),
        updated_at: Instant(r.try_get(15)?),
    })
}

/// \`admit\`: the run written before anything runs; a repeat of the request id on the session answers the stored run.
pub fn admit(
    pool: &Pool,
    user_id: &str,
    session_id: &str,
    request_id: &str,
    agent_id: &str,
    task: Option<&str>,
) -> Result<(StoredRun, bool), RunError> {
    let key = run_key_of(session_id, request_id);
    db::transaction_retrying(pool, IsolationLevel::ReadCommitted, 1, |tx| {
        let inserted = tx.query(
            &format!(
                "INSERT INTO agents.agent_runs (run_key, user_id, session_id, request_id, agent_id, task, state)
                 VALUES ($1::text, $2::text, $3::text::uuid, $4::text, $5::text, $6::text, 'admitted')
                 ON CONFLICT (run_key) DO NOTHING
                 RETURNING {}",
                columns()
            ),
            &[&key, &user_id, &session_id, &request_id, &agent_id, &task],
        )?;
        if let Some(row) = inserted.first() {
            let run = run_of(row)?;
            tx.execute(
                "INSERT INTO agents.agent_run_events (run_id, sequence, state) VALUES ($1::text::uuid, 1, 'admitted')",
                &[&run.id],
            )?;
            return Ok((run, true));
        }
        let stored = tx.query(
            &format!(
                "SELECT {} FROM agents.agent_runs WHERE run_key = $1::text",
                columns()
            ),
            &[&key],
        )?;
        match stored.first() {
            Some(r) => Ok((run_of(r)?, false)),
            None => Err(RunError::Other(format!(
                "agents run {key} conflicted but is not stored"
            ))),
        }
    })
}

/// \`RunOutcome\`.
#[derive(Debug, Clone, Default)]
pub struct Outcome {
    pub reply: Option<String>,
    pub cost: Option<Amount>,
    pub asset_id: Option<String>,
    pub metered: Option<bool>,
    pub action_id: Option<String>,
    pub code: Option<String>,
    /// A research answer's provenance, kept only by the write that completes the run.
    pub provenance: Option<Json>,
}

/// \`move\`: along RS-2 only, with its event, under the row's lock.
pub fn move_run(
    pool: &Pool,
    run_id: &str,
    to: &str,
    outcome: &Outcome,
) -> Result<StoredRun, RunError> {
    db::transaction_retrying(pool, IsolationLevel::ReadCommitted, 1, |tx| {
        let current = tx.query(
            "SELECT state FROM agents.agent_runs WHERE id = $1::text::uuid FOR UPDATE",
            &[&run_id],
        )?;
        let Some(c) = current.first() else {
            return Err(RunError::Other(format!(
                "agents run {run_id} is not stored"
            )));
        };
        let from: String = c.try_get(0)?;
        if !can_move(&from, to) {
            return Err(transition_invalid());
        }
        let completed = to == "completed";
        let reply = completed.then(|| outcome.reply.clone().unwrap_or_default());
        let rows = tx.query(
            &format!(
                "UPDATE agents.agent_runs
                    SET state = $2::text,
                        reply = $3::text,
                        cost = COALESCE($4::text::numeric, cost),
                        asset_id = COALESCE($5::text, asset_id),
                        metered = COALESCE($6::boolean, metered),
                        action_id = COALESCE($7::text::uuid, action_id),
                        provenance = CASE WHEN $2::text = 'completed' THEN $8::text::jsonb END,
                        updated_at = now()
                  WHERE id = $1::text::uuid
                 RETURNING {}",
                columns()
            ),
            &[
                &run_id,
                &to,
                &reply,
                &outcome.cost.map(format_amount),
                &outcome.asset_id,
                &outcome.metered,
                &outcome.action_id,
                &outcome.provenance.as_ref().map(Json::compact),
            ],
        )?;
        let event = tx.query_one(
            "INSERT INTO agents.agent_run_events (run_id, sequence, state, code)
             SELECT $1::text::uuid, COALESCE(MAX(sequence), 0) + 1, $2::text, $3::text
               FROM agents.agent_run_events WHERE run_id = $1::text::uuid
             RETURNING sequence",
            &[&run_id, &to, &outcome.code],
        )?;
        let run = run_of(
            rows.first()
                .ok_or_else(|| RunError::Other(format!("agents run {run_id} is not stored")))?,
        )?;
        // Each ending is delivered once to the person's run webhooks, in the transaction that ends the run.
        if ENDINGS.contains(&to) {
            let sequence = i64::from(event.try_get::<_, i32>(0)?);
            webhooks::enqueue_run_finished(
                tx,
                &FinishedRun {
                    event_id: webhooks::finished_event_id(webhooks::Kind::Run, &run.id, sequence),
                    kind: webhooks::Kind::Run,
                    user_id: &run.user_id,
                    run_id: &run.id,
                    session_id: &run.session_id,
                    agent_id: &run.agent_id,
                    state: to,
                    reply: run.reply.as_deref(),
                    cost: run.cost.clone(),
                    asset_id: run.asset_id.as_deref(),
                    refusal_codes: match (&outcome.code, to) {
                        (Some(code), "refused") => vec![code.clone()],
                        _ => Vec::new(),
                    },
                },
            )?;
        }
        Ok(run)
    })
}

/// \`takeOver\`: a running run whose lease passed, renewed; none when it is live, moved on, or taken first.
pub fn take_over(
    pool: &Pool,
    run_id: &str,
    stale_before: Instant,
) -> Result<Option<StoredRun>, RunError> {
    let rows = db::with_client(pool, |c| {
        Ok(c.query(
            &format!(
                "UPDATE agents.agent_runs SET updated_at = now()
                  WHERE id = $1::text::uuid AND state = 'running' AND updated_at < $2::text::timestamptz
                 RETURNING {}",
                columns()
            ),
            &[&run_id, &stale_before.iso()],
        )?)
    })?;
    rows.first().map(run_of).transpose()
}

/// \`get\`: one of the caller's runs, with every refusal code it met in order.
pub fn get(
    pool: &Pool,
    run_id: &str,
    user_id: &str,
) -> Result<Option<(StoredRun, Vec<String>)>, RunError> {
    let mut conn = pool.get().map_err(StoreError::from)?;
    let c = conn.client().map_err(StoreError::from)?;
    let rows = c.query(
        &format!(
            "SELECT {} FROM agents.agent_runs WHERE id = $1::text::uuid AND user_id = $2::text",
            columns()
        ),
        &[&run_id, &user_id],
    )?;
    let Some(row) = rows.first() else {
        return Ok(None);
    };
    let codes = c
        .query(
            "SELECT code FROM agents.agent_run_events
              WHERE run_id = $1::text::uuid AND state = 'refused' AND code IS NOT NULL ORDER BY sequence",
            &[&run_id],
        )?
        .iter()
        .map(|r| r.try_get::<_, String>(0))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Some((run_of(row)?, codes)))
}

/// \`RunEvent\` as the call answers it, with its id.
pub fn events(
    pool: &Pool,
    run_id: &str,
    user_id: &str,
    after: i64,
    limit: i64,
) -> Result<Option<Vec<Json>>, RunError> {
    let mut conn = pool.get().map_err(StoreError::from)?;
    let c = conn.client().map_err(StoreError::from)?;
    let owned = c.query(
        "SELECT id FROM agents.agent_runs WHERE id = $1::text::uuid AND user_id = $2::text",
        &[&run_id, &user_id],
    )?;
    if owned.is_empty() {
        return Ok(None);
    }
    let rows = c.query(
        &format!(
            "SELECT sequence, state, code, {} FROM agents.agent_run_events
              WHERE run_id = $1::text::uuid AND sequence > $2::text::int
              ORDER BY sequence LIMIT $3::text::bigint",
            ms("occurred_at")
        ),
        &[&run_id, &after.to_string(), &limit.to_string()],
    )?;
    rows.iter()
        .map(|r| {
            let sequence = i64::from(r.try_get::<_, i32>(0)?);
            Ok(Json::obj([
                ("id", Json::str(format!("{run_id}:{sequence}"))),
                ("sequence", Json::int(sequence)),
                ("state", Json::str(r.try_get::<_, String>(1)?)),
                (
                    "code",
                    r.try_get::<_, Option<String>>(2)?
                        .map_or(Json::Null, Json::str),
                ),
                ("occurredAt", Json::str(Instant(r.try_get(3)?).iso())),
            ]))
        })
        .collect::<Result<Vec<_>, RunError>>()
        .map(Some)
}

/// \`forSession\`: one session's first \`limit\` runs, oldest first.
pub fn for_session(pool: &Pool, session_id: &str, limit: i64) -> Result<Vec<StoredRun>, RunError> {
    let rows = db::with_client(pool, |c| {
        Ok(c.query(
            &format!(
                "SELECT {} FROM agents.agent_runs WHERE session_id = $1::text::uuid
                  ORDER BY created_at, id LIMIT $2::text::bigint",
                columns()
            ),
            &[&session_id, &limit.to_string()],
        )?)
    })?;
    rows.iter().map(run_of).collect()
}

/// \`parseCursor\`: the last sequence read, as a decimal string; none reads from the start.
pub fn parse_cursor(cursor: Option<&str>) -> Result<i64, RunError> {
    let Some(c) = cursor else {
        return Ok(0);
    };
    let ok = c == "0"
        || (!c.starts_with('0')
            && (1..=9).contains(&c.len())
            && c.bytes().all(|b| b.is_ascii_digit()));
    if !ok {
        return Err(RunError::Agent(denied(
            "agents.cursor_invalid",
            "agents.refused.cursor_invalid",
            "run events cursor is not valid".to_owned(),
            vec![],
        )));
    }
    c.parse()
        .map_err(|e: std::num::ParseIntError| RunError::Other(e.to_string()))
}

/// What a run records (\`runRecorded\`'s input).
pub struct RunInput<'a> {
    pub user_id: &'a str,
    pub session_id: &'a str,
    pub agent_id: &'a str,
    pub request_id: &'a str,
    pub task: &'a str,
    pub asset_id: &'a str,
    /// `provenanceOf`: a research answer's provenance from its reply, stored in the same write as the reply.
    pub provenance_of: Option<&'a dyn Fn(&str) -> Json>,
}

const ENGINE_FAILURES: [&str; 2] = ["agents.provider_unavailable", "agents.provider_failed"];

/// \`runRecorded\`: one engine call as a stored run (RS-1 to RS-4), in record.ts's order.
pub fn run_recorded(
    pool: &Pool,
    input: &RunInput<'_>,
    now: Instant,
    call: impl FnOnce() -> Result<ThinkResult, RunError>,
) -> Result<(ThinkResult, StoredRun), RunError> {
    let (run, admitted) = admit(
        pool,
        input.user_id,
        input.session_id,
        input.request_id,
        input.agent_id,
        Some(input.task),
    )?;
    if !admitted && (run.agent_id != input.agent_id || run.task.as_deref() != Some(input.task)) {
        return Err(RunError::Agent(denied(
            "agents.request_id_replay",
            "agents.error.request_id_replay",
            format!(
                "Request id \"{}\" already names another request on session {}",
                input.request_id, input.session_id
            ),
            vec![crate::audit::param("requestId", input.request_id)],
        )));
    }
    let mut took_over = false;
    let running = match run.state.as_str() {
        "admitted" | "failed" | "refused" => {
            Some(move_run(pool, &run.id, "running", &Outcome::default())?)
        }
        "running" if now.0 - run.updated_at.0 > RUN_LEASE_MS => {
            let Some(r) = take_over(pool, &run.id, Instant(now.0 - RUN_LEASE_MS))? else {
                return Err(transition_invalid());
            };
            took_over = true;
            Some(r)
        }
        _ => None,
    };
    let Some(running) = running else {
        return Ok((call()?, run));
    };
    let result = match call() {
        Ok(r) => r,
        Err(e) => {
            let code = e.code().map(str::to_owned);
            let charged = took_over && matches!(e, RunError::MeteredReplay(_));
            let failed = code.as_deref().is_none_or(|c| ENGINE_FAILURES.contains(&c));
            let to = if charged {
                "completed"
            } else if failed {
                "failed"
            } else {
                "refused"
            };
            let _ = move_run(
                pool,
                &running.id,
                to,
                &Outcome {
                    code,
                    metered: charged.then_some(true),
                    ..Outcome::default()
                },
            );
            return Err(e);
        }
    };
    let completed = move_run(
        pool,
        &running.id,
        "completed",
        &Outcome {
            reply: Some(result.text.clone()),
            cost: Some(result.cost),
            asset_id: Some(input.asset_id.to_owned()),
            metered: Some(result.metered),
            action_id: Some(result.action.id.clone()),
            code: None,
            provenance: input.provenance_of.map(|of| of(&result.text)),
        },
    )
    .unwrap_or(running);
    Ok((result, completed))
}

/// \`toRunOutput\`.
pub fn run_output(run: &StoredRun, refusal_codes: &[String]) -> Json {
    let opt = |v: &Option<String>| v.clone().map_or(Json::Null, Json::str);
    Json::obj([
        ("runId", Json::str(run.id.clone())),
        ("sessionId", Json::str(run.session_id.clone())),
        ("agentId", Json::str(run.agent_id.clone())),
        ("requestId", Json::str(run.request_id.clone())),
        ("task", opt(&run.task)),
        ("state", Json::str(run.state.clone())),
        ("reply", opt(&run.reply)),
        ("cost", opt(&run.cost)),
        ("assetId", opt(&run.asset_id)),
        ("metered", run.metered.map_or(Json::Null, Json::Bool)),
        ("provenance", run.provenance.clone().unwrap_or(Json::Null)),
        (
            "refusalCodes",
            Json::Array(refusal_codes.iter().map(|c| Json::str(c.clone())).collect()),
        ),
        ("createdAt", Json::str(run.created_at.iso())),
        ("updatedAt", Json::str(run.updated_at.iso())),
    ])
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test")]
    use super::*;

    /// \`runs/machine.test.ts\`: RS-2, every pair.
    #[test]
    fn a_run_moves_only_along_rs2() {
        let allowed = [
            ("admitted", "running"),
            ("admitted", "refused"),
            ("admitted", "failed"),
            ("running", "waiting_approval"),
            ("running", "completed"),
            ("running", "refused"),
            ("running", "failed"),
            ("waiting_approval", "running"),
            ("waiting_approval", "refused"),
            ("waiting_approval", "failed"),
            ("refused", "running"),
            ("failed", "running"),
        ];
        for from in RUN_STATES {
            for to in RUN_STATES {
                assert_eq!(
                    can_move(from, to),
                    allowed.contains(&(from, to)),
                    "{from} -> {to}"
                );
            }
        }
    }

    #[test]
    fn a_cursor_is_a_plain_decimal_sequence() {
        assert_eq!(parse_cursor(None).unwrap(), 0);
        assert_eq!(parse_cursor(Some("0")).unwrap(), 0);
        assert_eq!(parse_cursor(Some("123456789")).unwrap(), 123_456_789);
        for bad in ["01", "-1", "1234567890", "", "1.0", " 1"] {
            assert_eq!(
                parse_cursor(Some(bad)).unwrap_err().code(),
                Some("agents.cursor_invalid"),
                "{bad}"
            );
        }
    }
}
