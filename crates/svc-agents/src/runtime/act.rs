//! \`act\`: a tool run inside the session's guardrail (\`AgentRuntime.act\` in \`runtime.ts\`).
//!
//! A stored place for the same session, key and tool answers that outcome without spending the call budget. Any other
//! call is judged by the guardrail first; a refusal writes its row and is the answer. A place that passes is claimed in
//! \`agent_place_intents\` before the tool runs, and the loser of that insert does not run it. A tool that fails drops
//! its claim and writes a failed row; one that returns writes its executed row (with the digest of its answer) and,
//! for a place, stores the answer on the claim, in one transaction. The runtime does not own the tools: the caller
//! hands in what runs.

use postgres::IsolationLevel;

use service_kit::json::{self, Json};
use service_kit::money::js_trim;

use crate::audit::{self, Action};
use crate::db::{self, StoreError};
use crate::gateway::digest_of_text;
use crate::gateway::providers::TokenUsage;

use super::guardrails::{Refusal, evaluate_tool_call, is_place_tool, refuse};
use super::{Context, Rt, RunError, append_failure, append_refusal, publish_completed};
use super::{require_session, state_of};

/// \`ActInput\` without its \`execute\`, which \`act\` takes on its own.
#[derive(Debug, Clone, Copy, Default)]
pub struct ActInput<'a> {
    pub session_id: &'a str,
    pub tool: &'a str,
    pub approved: Option<bool>,
    pub idempotency_key: Option<&'a str>,
}

/// \`ActResult\`: the tool's answer and its row; \`replayed\` when a stored place answered.
#[derive(Debug, Clone, PartialEq)]
pub struct ActResult {
    pub result: Json,
    pub action: Action,
    pub replayed: bool,
}

fn tool_call(tool: &str) -> Context<'_> {
    Context {
        kind: "tool_call",
        tool: Some(tool),
        task: None,
    }
}

/// \`act\`.
pub fn act(
    x: &Rt<'_>,
    input: &ActInput<'_>,
    execute: impl FnOnce() -> Result<Json, RunError>,
) -> Result<ActResult, RunError> {
    let session = require_session(x.pool, input.session_id)?;
    let key = input.idempotency_key.map(js_trim).filter(|k| !k.is_empty());
    let place_key = key.filter(|_| is_place_tool(input.tool));

    if let Some(k) = place_key
        && let Some((result, action)) = stored_place(x, &session.id, k, input.tool)?
    {
        return Ok(ActResult {
            result,
            action,
            replayed: true,
        });
    }

    let state = state_of(x.pool, &session)?;
    if let Err(refusal) =
        evaluate_tool_call(&session.guardrail, &state, input.tool, input.approved, key)
    {
        return Err(append_refusal(x, &session, refusal, tool_call(input.tool)));
    }

    let mut claimed = false;
    if let Some(k) = place_key {
        match claim_place(x, &session.id, k, input.tool)? {
            Claim::Claimed => claimed = true,
            Claim::Replay(result, action) => {
                return Ok(ActResult {
                    result,
                    action: *action,
                    replayed: true,
                });
            }
            Claim::Conflict => {
                return Err(append_refusal(
                    x,
                    &session,
                    place_key_conflict(input.tool),
                    tool_call(input.tool),
                ));
            }
        }
    }

    let result = match execute() {
        Ok(r) => r,
        Err(e) => {
            if let Some(k) = place_key.filter(|_| claimed) {
                release_claim(x, &session.id, k, input.tool)?;
            }
            return Err(append_failure(x, &session, tool_call(input.tool), None, e));
        }
    };

    let stored = result.compact();
    let digest = digest_of_text(&stored);
    let entry = audit::Entry {
        session_id: &session.id,
        user_id: &session.user_id,
        agent_id: &session.agent_id,
        kind: "tool_call",
        status: "executed",
        tool: Some(input.tool),
        user_message_key: "agents.action.executed",
        user_message_params: vec![audit::param("tool", input.tool)],
        output_digest: Some(&digest),
        ..audit::Entry::default()
    };
    let written = db::transaction_retrying(x.pool, IsolationLevel::ReadCommitted, 5, |tx| {
        let row = audit::append(tx, &entry, x.now)?;
        if let Some(k) = place_key.filter(|_| claimed) {
            let updated = tx.query(
                "UPDATE agents.agent_place_intents
                    SET action_id = $4::text::uuid, result_json = $5::text
                  WHERE session_id = $1::text::uuid AND idempotency_key = $2::text AND tool = $3::text
                    AND result_json IS NULL
                 RETURNING session_id",
                &[&session.id, &k, &input.tool, &row.id, &stored],
            )?;
            if updated.is_empty() {
                return Err(RunError::Other(format!(
                    "place intent for session {} was not stored",
                    session.id
                )));
            }
        }
        Ok::<_, RunError>(row)
    });
    let action = match written {
        Ok(a) => a,
        Err(e) if claimed => {
            return Err(append_failure(x, &session, tool_call(input.tool), None, e));
        }
        Err(e) => return Err(e),
    };

    publish_completed(
        x,
        &action,
        TokenUsage {
            input_tokens: 0,
            output_tokens: 0,
        },
    )?;
    Ok(ActResult {
        result,
        action,
        replayed: false,
    })
}

/// \`placeKeyConflict\`.
fn place_key_conflict(tool: &str) -> Refusal {
    refuse(
        "agents.place_key_conflict",
        "agents.refused.place_key_conflict",
        vec![audit::param("tool", tool)],
    )
}

fn parsed(text: &str) -> Result<Json, RunError> {
    json::parse(text).map_err(|e| RunError::Other(e.message))
}

/// \`storedPlaceIntent\`: same tool, same key, with a stored answer. A different tool is not a replay.
fn stored_place(
    x: &Rt<'_>,
    session_id: &str,
    key: &str,
    tool: &str,
) -> Result<Option<(Json, Action)>, RunError> {
    let found = db::with_client(x.pool, |c| {
        let rows = c.query(
            "SELECT action_id::text, result_json FROM agents.agent_place_intents
              WHERE session_id = $1::text::uuid AND idempotency_key = $2::text AND tool = $3::text
                AND action_id IS NOT NULL AND result_json IS NOT NULL",
            &[&session_id, &key, &tool],
        )?;
        let Some(row) = rows.first() else {
            return Ok(None);
        };
        let action_id: String = row.try_get(0)?;
        let text: String = row.try_get(1)?;
        Ok(audit::by_id(c, &action_id)?.map(|a| (text, a)))
    })?;
    found.map(|(text, a)| Ok((parsed(&text)?, a))).transpose()
}

enum Claim {
    Claimed,
    Conflict,
    Replay(Json, Box<Action>),
}

/// \`claimPlaceIntent\`: the claim inserted before the tool runs. A row already holding the key is a replay when it is
/// this tool's with a stored answer, and a conflict otherwise; neither runs the tool.
fn claim_place(x: &Rt<'_>, session_id: &str, key: &str, tool: &str) -> Result<Claim, RunError> {
    let found = db::with_client(x.pool, |c| {
        let inserted = c.query(
            "INSERT INTO agents.agent_place_intents (session_id, idempotency_key, tool, action_id, result_json)
             VALUES ($1::text::uuid, $2::text, $3::text, NULL, NULL)
             ON CONFLICT (session_id, idempotency_key) DO NOTHING
             RETURNING session_id",
            &[&session_id, &key, &tool],
        )?;
        if !inserted.is_empty() {
            return Ok(None);
        }
        let rows = c.query(
            "SELECT tool, action_id::text, result_json FROM agents.agent_place_intents
              WHERE session_id = $1::text::uuid AND idempotency_key = $2::text",
            &[&session_id, &key],
        )?;
        let Some(row) = rows.first() else {
            return Ok(Some(None));
        };
        let held: String = row.try_get(0)?;
        let action_id: Option<String> = row.try_get(1)?;
        let text: Option<String> = row.try_get(2)?;
        if let (true, Some(id), Some(text)) = (held == tool, action_id, text)
            && let Some(a) = audit::by_id(c, &id)?
        {
            return Ok(Some(Some((text, Box::new(a)))));
        }
        Ok::<_, StoreError>(Some(None))
    })?;
    match found {
        None => Ok(Claim::Claimed),
        Some(None) => Ok(Claim::Conflict),
        Some(Some((text, a))) => Ok(Claim::Replay(parsed(&text)?, a)),
    }
}

/// \`releasePlaceClaim\`: drops a claim whose tool never returned. A stored place stays.
fn release_claim(x: &Rt<'_>, session_id: &str, key: &str, tool: &str) -> Result<(), RunError> {
    db::with_client(x.pool, |c| {
        c.execute(
            "DELETE FROM agents.agent_place_intents
              WHERE session_id = $1::text::uuid AND idempotency_key = $2::text AND tool = $3::text
                AND result_json IS NULL",
            &[&session_id, &key, &tool],
        )?;
        Ok(())
    })?;
    Ok(())
}
