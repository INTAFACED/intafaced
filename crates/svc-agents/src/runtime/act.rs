//! A guarded tool call (`runtime.ts`, `AgentRuntime.act`), and the own agent's session (`openOwnSession`).
//!
//! The runtime does not own the tools: the caller hands in `execute`, called only after the session's guardrail has
//! allowed the call. A place tool with a business key is claimed before it runs (`agent_place_intents`), so the same key
//! on a conversational repeat returns the first outcome and never places again; a claim whose tool failed is released.
//! Every call writes its row of `agent_actions`: a refusal, a failure, or the executed call with its output digest.

use postgres::IsolationLevel;
use service_kit::json::{self, Json};

use super::guardrails::{Guardrail, evaluate_tool_call, is_place_tool, refuse};
use super::{
    Context, Rt, RunError, SessionRecord, append_failure, append_refusal, denied, insert_session,
    publish_completed, require_session, state_of,
};
use crate::audit::{self, Action};
use crate::db::{self, StoreError};
use crate::gateway::digest_of_text;
use crate::gateway::providers::TokenUsage;

/// `openOwnSession`: a person's own agent's guardrail bound to a new metered session; any other agent is not found.
pub fn open_own_session(
    x: &Rt<'_>,
    user_id: &str,
    guardrail: &Guardrail,
) -> Result<SessionRecord, RunError> {
    if !guardrail.agent_id.starts_with("own.") {
        return Err(RunError::Agent(denied(
            "agents.agent_not_found",
            "agents.error.route_not_found",
            format!("\"{}\" is not an own agent", guardrail.agent_id),
            vec![audit::param("task", guardrail.agent_id.clone())],
        )));
    }
    insert_session(x, user_id, guardrail, true)
}

/// `ActInput`, without its `execute`.
#[derive(Debug, Clone, Copy, Default)]
pub struct ActInput<'a> {
    pub session_id: &'a str,
    pub tool: &'a str,
    /// The person's explicit confirmation, for a tool that requires one.
    pub approved: Option<bool>,
    /// The business key of a place tool.
    pub idempotency_key: Option<&'a str>,
}

/// `ActResult`.
#[derive(Debug, Clone, PartialEq)]
pub struct ActResult {
    pub result: Json,
    pub action: Action,
    /// This call reused a prior place instead of executing again.
    pub replayed: bool,
}

/// What `act` fails with: the runtime's refusal or fault, or the tool's own error, after its failure row is written.
#[derive(Debug, Clone, PartialEq)]
pub enum ActError<E> {
    Run(RunError),
    Tool(E),
}

impl<E> From<RunError> for ActError<E> {
    fn from(e: RunError) -> Self {
        ActError::Run(e)
    }
}
impl<E> From<StoreError> for ActError<E> {
    fn from(e: StoreError) -> Self {
        ActError::Run(RunError::Store(e))
    }
}
impl<E> From<postgres::Error> for ActError<E> {
    fn from(e: postgres::Error) -> Self {
        ActError::Run(RunError::from(e))
    }
}

fn tool_call(tool: &str) -> Context<'_> {
    Context {
        kind: "tool_call",
        tool: Some(tool),
        task: None,
    }
}

/// `storedPlaceIntent`: the same tool and key with a stored result.
fn stored_place_intent(
    x: &Rt<'_>,
    session_id: &str,
    key: &str,
    tool: &str,
) -> Result<Option<(Json, Action)>, RunError> {
    let rows = db::with_client(x.pool, |c| {
        Ok(c.query(
            "SELECT action_id::text, result_json FROM agents.agent_place_intents
              WHERE session_id = $1::text::uuid AND idempotency_key = $2::text AND tool = $3::text
                AND action_id IS NOT NULL AND result_json IS NOT NULL",
            &[&session_id, &key, &tool],
        )?)
    })?;
    let Some(r) = rows.first() else {
        return Ok(None);
    };
    let (action_id, result): (String, String) = (r.try_get(0)?, r.try_get(1)?);
    let Some(action) = db::with_client(x.pool, |c| audit::by_id(c, &action_id))? else {
        return Ok(None);
    };
    let result = json::parse(&result).map_err(|e| RunError::Other(e.message))?;
    Ok(Some((result, action)))
}

enum Claim {
    Claimed,
    Conflict,
    Replay(Box<(Json, Action)>),
}

/// `claimPlaceIntent`: the claim, inserted before the tool runs; a stored result for this tool is a replay, anything
/// else on the key a conflict that must not run.
fn claim_place_intent(
    x: &Rt<'_>,
    session_id: &str,
    key: &str,
    tool: &str,
) -> Result<Claim, RunError> {
    let inserted = db::with_client(x.pool, |c| {
        Ok(c.query(
            "INSERT INTO agents.agent_place_intents (session_id, idempotency_key, tool, action_id, result_json)
             VALUES ($1::text::uuid, $2::text, $3::text, NULL, NULL)
             ON CONFLICT (session_id, idempotency_key) DO NOTHING
             RETURNING session_id",
            &[&session_id, &key, &tool],
        )?)
    })?;
    if !inserted.is_empty() {
        return Ok(Claim::Claimed);
    }
    let rows = db::with_client(x.pool, |c| {
        Ok(c.query(
            "SELECT tool, action_id::text, result_json FROM agents.agent_place_intents
              WHERE session_id = $1::text::uuid AND idempotency_key = $2::text",
            &[&session_id, &key],
        )?)
    })?;
    if let Some(r) = rows.first() {
        let (stored_tool, action_id, result): (String, Option<String>, Option<String>) =
            (r.try_get(0)?, r.try_get(1)?, r.try_get(2)?);
        if let (true, Some(action_id), Some(result)) = (stored_tool == tool, action_id, result)
            && let Some(action) = db::with_client(x.pool, |c| audit::by_id(c, &action_id))?
        {
            let result = json::parse(&result).map_err(|e| RunError::Other(e.message))?;
            return Ok(Claim::Replay(Box::new((result, action))));
        }
    }
    Ok(Claim::Conflict)
}

/// `releasePlaceClaim`: a claim whose tool never returned is dropped; a stored place stays.
fn release_place_claim(
    x: &Rt<'_>,
    session_id: &str,
    key: &str,
    tool: &str,
) -> Result<(), RunError> {
    db::with_client(x.pool, |c| {
        c.execute(
            "DELETE FROM agents.agent_place_intents
              WHERE session_id = $1::text::uuid AND idempotency_key = $2::text AND tool = $3::text AND result_json IS NULL",
            &[&session_id, &key, &tool],
        )?;
        Ok(())
    })?;
    Ok(())
}

/// `act`: the session open, a stored place replayed, the guardrail, the place claimed, the tool run, then its row and
/// `agentActionCompleted`. A tool's error is written as a failed row (`agents.error.engine_unavailable`) and returned.
pub fn act<E>(
    x: &Rt<'_>,
    input: &ActInput<'_>,
    execute: impl FnOnce() -> Result<Json, E>,
) -> Result<ActResult, ActError<E>> {
    let session = require_session(x.pool, input.session_id)?;
    let key = input
        .idempotency_key
        .map(service_kit::schema::js_trim)
        .filter(|k| !k.is_empty());
    let place_key = key.filter(|_| is_place_tool(input.tool));

    if let Some(k) = place_key
        && let Some((result, action)) = stored_place_intent(x, &session.id, k, input.tool)?
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
        return Err(append_refusal(x, &session, refusal, tool_call(input.tool)).into());
    }

    let mut claimed = false;
    if let Some(k) = place_key {
        match claim_place_intent(x, &session.id, k, input.tool)? {
            Claim::Replay(stored) => {
                let (result, action) = *stored;
                return Ok(ActResult {
                    result,
                    action,
                    replayed: true,
                });
            }
            Claim::Conflict => {
                let refusal = refuse(
                    "agents.place_key_conflict",
                    "agents.refused.place_key_conflict",
                    vec![audit::param("tool", input.tool)],
                );
                return Err(append_refusal(x, &session, refusal, tool_call(input.tool)).into());
            }
            Claim::Claimed => claimed = true,
        }
    }

    let result = match execute() {
        Ok(r) => r,
        Err(e) => {
            if let (true, Some(k)) = (claimed, place_key) {
                release_place_claim(x, &session.id, k, input.tool)?;
            }
            let failed = append_failure(
                x,
                &session,
                tool_call(input.tool),
                None,
                RunError::Other("the tool failed".to_owned()),
            );
            // The tool's own error is the answer; a failure to write its row replaces it, as there.
            return Err(match failed {
                RunError::Store(s) => ActError::Run(RunError::Store(s)),
                _ => ActError::Tool(e),
            });
        }
    };

    let text = result.compact();
    let digest = digest_of_text(&text);
    let written = db::transaction_retrying(x.pool, IsolationLevel::ReadCommitted, 5, |tx| {
        let row = audit::append(
            tx,
            &audit::Entry {
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
            },
            x.now,
        )?;
        if let (true, Some(k)) = (claimed, place_key) {
            let updated = tx.execute(
                "UPDATE agents.agent_place_intents SET action_id = $4::text::uuid, result_json = $5::text
                  WHERE session_id = $1::text::uuid AND idempotency_key = $2::text AND tool = $3::text
                    AND result_json IS NULL",
                &[&session.id, &k, &input.tool, &row.id, &text],
            )?;
            if updated == 0 {
                return Err(StoreError::new(
                    format!("place intent for session {} was not stored", session.id),
                    None,
                ));
            }
        }
        Ok(row)
    });
    let action = match written {
        Ok(a) => a,
        Err(e) => {
            let e = RunError::Store(e);
            return Err(if claimed {
                append_failure(x, &session, tool_call(input.tool), None, e)
            } else {
                e
            }
            .into());
        }
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
