//! One call of one of the agent's tools in its open session (`own/routes.ts`, `own.tool.try`), and the approved run of
//! a held call (`decideAndRun`), as the TypeScript answers them.
//!
//! The call's gates in order: the person's own agent and its session, the owner's own freeze, a request id already held
//! (that request, whatever the rules say now), the reviewer's stored decision, then consent, the owner's baseline and
//! the person's rule. A call a rule asks about is stored as one approval request and does not run, unless the person
//! turned the reviewer on and it proceeds, which runs it once as the person's approval would. A call that may run goes
//! through the session's guardrail (`act`) to its door; a tool with no door refuses `agents.tool_not_wired`.

use service_kit::access::has_scope;
use service_kit::edge::Principal;
use service_kit::json::Json;
use service_kit::pg::Pool;
use service_kit::schema::{Value, js_trim};
use service_kit::trpc::TrpcError;

use super::approvals::{self, Hold, Request};
use super::catalog::{OWN_APPROVAL_DOORS, OWN_TOOL_DOORS, own_tools};
use super::desk::{self, CommentInput, DeskComment, SupportDesk};
use super::reviewer::{self, Review};
use super::self_freeze::{assert_not_self_frozen, assert_owner_active};
use super::{
    OWN_RUN_TASK, Own, OwnError, gates, guard, no_mapping, own_session_agent_id, owner_forbidden,
    store,
};
use crate::own::notices::{Scope, publish_pending_approval_requests};
use crate::runtime::act::{ActError, ActInput, act};
use crate::runtime::guardrails::{Guardrail, evaluate_tool_call, parse_guardrail};
use crate::runtime::{self, Rt, RunError, SessionRecord, state_of};

/// As many actions as the product agents allow a session, and the run route's own output ceiling.
const OWN_MAX_ACTIONS: i64 = 60;
const OWN_MAX_OUTPUT_TOKENS: i64 = 2048;

/// `ownGuardrail`: the agent's saved tools that move no money and have a declared shape, each in its module; a write
/// granted as a write that always needs approval at the runtime; the one run task; the agent's own cap per session.
pub fn own_guardrail(agent: &store::OwnAgent) -> Result<Guardrail, OwnError> {
    let tools: Vec<_> = own_tools()
        .into_iter()
        .filter(|t| !t.moves_money && t.shape.is_some() && agent.tools.contains(&t.name))
        .collect();
    let mut modules: Vec<String> = Vec::new();
    for t in &tools {
        if !modules.contains(&t.module) {
            modules.push(t.module.clone());
        }
    }
    let raw = Json::obj([
        ("agentId", Json::str(own_session_agent_id(&agent.id))),
        ("version", Json::int(agent.version)),
        ("capacityMode", Json::str("research_only")),
        ("scopes", Json::Array(Vec::new())),
        (
            "tools",
            Json::Array(
                tools
                    .iter()
                    .map(|t| {
                        Json::obj([
                            ("name", Json::str(t.name.clone())),
                            ("module", Json::str(t.module.clone())),
                            ("mode", Json::str(if t.writes() { "write" } else { "read" })),
                            ("requiresApproval", Json::Bool(t.writes())),
                        ])
                    })
                    .collect(),
            ),
        ),
        (
            "limits",
            Json::obj([
                ("maxActionsPerSession", Json::int(OWN_MAX_ACTIONS)),
                ("maxOutputTokensPerCall", Json::int(OWN_MAX_OUTPUT_TOKENS)),
                (
                    "maxSpendPerSession",
                    agent.per_session_cap.clone().map_or(Json::Null, Json::str),
                ),
                (
                    "allowedModules",
                    Json::Array(modules.into_iter().map(Json::String).collect()),
                ),
                ("allowedTasks", Json::Array(vec![Json::str(OWN_RUN_TASK)])),
            ]),
        ),
    ]);
    parse_guardrail(&raw).map_err(|e| OwnError::Thrown(e.0))
}

/// `runError`: a run's refusal or fault reaches the person as its code.
pub fn run_error(e: RunError) -> TrpcError {
    match e {
        RunError::Refused { refusal, .. } => {
            TrpcError::caused("FORBIDDEN", refusal.code, "agents.refused")
        }
        RunError::Agent(d) | RunError::MeteredReplay(d) => {
            let code = match d.error.code {
                "agents.session_not_found" => "NOT_FOUND",
                "agents.provider_unavailable" => "SERVICE_UNAVAILABLE",
                _ => "BAD_REQUEST",
            };
            TrpcError::caused(code, d.error.code, d.error.code)
        }
        RunError::Trpc(t) => t,
        RunError::Store(_) | RunError::Other(_) => {
            TrpcError::plain("INTERNAL_SERVER_ERROR", "agents.error.engine_unavailable")
        }
    }
}

/// `guard(fn, codeOf)` around one step: its refusal answered now with its code.
fn guarded<T, E: Into<OwnError>>(
    r: Result<T, E>,
    code_of: fn(&str) -> Option<&'static str>,
) -> Result<T, OwnError> {
    r.map_err(|e| OwnError::Trpc(guard(e.into(), code_of)))
}

/// A step outside any `guard`: a refusal there is a plain fault, as tRPC answers an unknown error.
fn unguarded<T>(r: Result<T, OwnError>) -> Result<T, OwnError> {
    r.map_err(|e| match e {
        OwnError::Refusal(r) => OwnError::Thrown(r.code),
        other => other,
    })
}

fn trpc(code: &'static str, message: impl Into<String>) -> OwnError {
    OwnError::Trpc(TrpcError::plain(code, message))
}

/// `approvalRefused`.
pub fn approval_refused(code: &str) -> Option<&'static str> {
    match code {
        "agents.approval.not_found" => Some("NOT_FOUND"),
        "agents.approval.ttl_unset" => Some("PRECONDITION_FAILED"),
        c if c.starts_with("agents.approval.") && c != "agents.approval.input_invalid" => {
            Some("FORBIDDEN")
        }
        c => owner_forbidden(c),
    }
}

/// `isPersonSession`: the person's own signed-in session, never a key, a sub-account or one without
/// `identity:write`.
pub fn is_person_session(p: &Principal) -> bool {
    p.kid.is_none() && p.sub_account.is_none() && has_scope(&p.scopes, "identity:write")
}

/// `ownedOwnSession`: the person's own agent and a session of it; not theirs, or not this agent's, is one answer.
pub fn owned_own_session(
    pool: &Pool,
    user: &str,
    agent_id: &str,
    session_id: &str,
) -> Result<(store::OwnAgent, SessionRecord), OwnError> {
    let agent = guarded(store::get(pool, user, agent_id), no_mapping)?;
    let session = runtime::session(pool, session_id).map_err(|e| OwnError::Trpc(run_error(e)))?;
    match session {
        Some(s) if s.user_id == user && s.agent_id == own_session_agent_id(&agent.id) => {
            Ok((agent, s))
        }
        _ => Err(trpc("NOT_FOUND", "agents.session_not_found")),
    }
}

/// What a call and its run read besides the input.
pub struct Call<'a> {
    pub x: Rt<'a>,
    pub own: &'a Own,
    pub principal: &'a Principal,
    /// `forwardedPrincipalHeaders(ctx)`.
    pub forwarded: &'a [(String, String)],
}

impl Call<'_> {
    fn desk(&self) -> Option<&dyn SupportDesk> {
        self.own.support_desk.as_deref()
    }
    fn user(&self) -> &str {
        &self.principal.user_id
    }
    /// `runtime.publishApprovalRequests({ ownerId, requestId })`, whose fault never fails the call.
    fn announce(&self, request_id: &str) {
        let _ = publish_pending_approval_requests(
            self.x.pool,
            self.x.m,
            self.x.now,
            &Scope {
                owner_id: Some(self.user()),
                request_id: Some(request_id),
                on_error: None,
            },
        );
    }
}

/// A tool's door answered with its own refusal reason; nothing was read or written.
#[derive(Debug, Clone, PartialEq, Eq)]
struct DoorRefusal(String);

/// A door refusal that answers the same however often it is retried: the request ends failed with it.
const PERMANENT_DOOR_REFUSALS: [&str; 2] = ["ticket_missing", "desk_refused"];

fn input_field<'a>(args: &'a [(String, String)], key: &str) -> Option<&'a str> {
    args.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
}

/// `decideAndRun`: approves a held request and runs it once, as the person's approval or the reviewer's proceed (`by`).
/// The door and its input first, the owner's account, the session, the call's gates and the session's guardrail as
/// they stand now; then one runner at a time on the request's own key. Returns the request and whether it had run.
pub fn decide_and_run(
    c: &Call<'_>,
    stored: &Request,
    by: &str,
) -> Result<(Request, bool), OwnError> {
    let pool = c.x.pool;
    let owner = c.user();
    let desk = c.desk().filter(|d| d.comments());
    let Some(desk) = desk.filter(|_| OWN_APPROVAL_DOORS.contains(&stored.tool.as_str())) else {
        return Err(trpc("BAD_REQUEST", "agents.tool_not_wired"));
    };
    let (ticket_id, body) = desk::draft_ticket_comment(
        input_field(&stored.input, "ticketId"),
        input_field(&stored.input, "body"),
    )
    .map_err(|reason| trpc("BAD_REQUEST", format!("agents.tool_refused.{reason}")))?;
    // Fails closed: the owner's account must read active from identity before anything is approved or run.
    guarded(
        assert_owner_active(owner, c.desk(), c.x.rt.self_freeze.as_deref()),
        approval_refused,
    )?;
    let (agent, session) = owned_own_session(pool, owner, &stored.agent_id, &stored.session_id)?;
    guarded(
        gates::gate_tool_call(
            pool,
            &c.own.baseline,
            owner,
            &agent.id,
            &agent.tools,
            &stored.tool,
        ),
        no_mapping,
    )?;
    let state = state_of(pool, &session).map_err(|e| OwnError::Trpc(run_error(e)))?;
    if let Err(r) = evaluate_tool_call(&session.guardrail, &state, &stored.tool, Some(true), None) {
        return Err(trpc("FORBIDDEN", r.code));
    }
    let (call, already) = guarded(
        approvals::approve(pool, owner, &stored.id, by),
        approval_refused,
    )?;
    if already && call.ran_at.is_some() {
        return Ok((call, true));
    }
    // One runner: a second approve while the first is running is refused, never a second run.
    if !approvals::claim_run(pool, owner, &call.id)? {
        return Err(trpc("CONFLICT", "agents.approval.running"));
    }
    let comment = CommentInput {
        ticket_id,
        body,
        client_request_id: format!("agents:approve:{}", call.id),
    };
    let ran = act(
        &c.x,
        &ActInput {
            session_id: &session.id,
            tool: &call.tool,
            approved: Some(true),
            idempotency_key: None,
        },
        || match desk.comment_ticket(&comment, c.forwarded) {
            DeskComment::Missing => Err(DoorRefusal("ticket_missing".to_owned())),
            DeskComment::Refused(code) => Err(DoorRefusal(code)),
            DeskComment::Unreachable => Err(DoorRefusal("desk_unreachable".to_owned())),
            DeskComment::Ok { id, ticket_id } => Ok(Json::obj([
                ("tool", Json::str(call.tool.clone())),
                ("ticketId", Json::str(ticket_id)),
                ("commentId", Json::str(id)),
                ("commented", Json::str("yes")),
            ])),
        },
    )
    .map_err(|e| match e {
        ActError::Tool(d) => Err(d),
        ActError::Run(r) => Ok(r),
    })
    .and_then(|acted| {
        approvals::record_result(pool, owner, &call.id, &acted.result)
            .map_err(|e| Ok(RunError::Other(format!("{e:?}"))))
    });
    match ran {
        Ok(request) => Ok((request, false)),
        Err(failure) => {
            match &failure {
                Err(DoorRefusal(reason)) if PERMANENT_DOOR_REFUSALS.contains(&reason.as_str()) => {
                    // Refused for good: the request ends failed with the door's code, which the agent's call reads.
                    approvals::fail(
                        pool,
                        owner,
                        &call.id,
                        &format!("agents.tool_refused.{reason}"),
                    )?;
                }
                // Not reached, or the runtime refused: the request keeps its approval and approving again retries it.
                _ => approvals::release_run(pool, owner, &call.id)?,
            }
            Err(match failure {
                Err(DoorRefusal(reason)) => {
                    trpc("BAD_REQUEST", format!("agents.tool_refused.{reason}"))
                }
                Ok(run) => OwnError::Trpc(run_error(run)),
            })
        }
    }
}

/// The call's input as the record holds it: each field and its text, in its order.
pub fn args_of(v: &Value) -> Vec<(String, String)> {
    match v {
        Value::Object(fields) => fields
            .iter()
            .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_owned())))
            .collect(),
        _ => Vec::new(),
    }
}

/// `wholeNumber`: a whole number as the person typed it, or none so the door refuses it as unset.
fn whole_number(text: Option<&str>) -> Option<i64> {
    let value = js_trim(text.unwrap_or(""));
    (!value.is_empty() && value.len() <= 6 && value.bytes().all(|b| b.is_ascii_digit()))
        .then(|| value.parse().ok())
        .flatten()
}

fn ran(tool: &str, data_class: &str, result: Json) -> Json {
    Json::obj([
        ("outcome", Json::str("ran")),
        ("tool", Json::str(tool)),
        ("dataClass", Json::str(data_class)),
        ("result", result),
    ])
}

fn waiting(tool: &str, data_class: &str, request: &Request) -> Json {
    Json::obj([
        ("outcome", Json::str("waiting")),
        ("tool", Json::str(tool)),
        ("dataClass", Json::str(data_class)),
        ("request", request.to_json()),
    ])
}

/// What `own.tool.try` is asked.
pub struct TryInput<'a> {
    pub id: &'a str,
    pub session_id: &'a str,
    pub request_id: &'a str,
    pub tool: &'a str,
    pub args: Vec<(String, String)>,
}

/// `own.tool.try`.
pub fn tool_try(c: &Call<'_>, input: &TryInput<'_>) -> Result<Json, OwnError> {
    let pool = c.x.pool;
    let owner = c.user();
    let (tool, args) = (input.tool, &input.args[..]);
    let (agent, session) = owned_own_session(pool, owner, input.id, input.session_id)?;
    guarded(
        assert_not_self_frozen(owner, c.x.rt.self_freeze.as_deref()),
        owner_forbidden,
    )?;
    // A request id already held for the person is that request, whatever the rules say now: never a second call.
    let held = guarded(
        approvals::find(pool, owner, &session.id, input.request_id, tool, args),
        no_mapping,
    )?;
    if let Some((held, data_class)) = held {
        let latest = unguarded(approvals::latest(pool, owner, held))?;
        if let Some(code) = latest.refusal_code() {
            return Err(trpc("FORBIDDEN", code));
        }
        if latest.status == "approved" && latest.ran_at.is_some() {
            return Ok(ran(tool, data_class, latest.result));
        }
        // A call the reviewer approved whose run did not finish is run again on the request's own key.
        if latest.status == "approved"
            && latest.decided_by.as_deref() == Some("reviewer")
            && is_person_session(c.principal)
        {
            let stored = Request {
                agent_id: agent.id.clone(),
                ..latest
            };
            let (request, _) = decide_and_run(c, &stored, "reviewer")?;
            return Ok(ran(tool, data_class, request.result));
        }
        return Ok(waiting(tool, data_class, &latest));
    }
    // The reviewer's stored decision stands whatever the gates say now: a refused call stays refused on every retry.
    let stored_review = guarded(
        reviewer::find(pool, owner, &session.id, input.request_id, tool, args),
        no_mapping,
    )?;
    if stored_review
        .as_ref()
        .is_some_and(|r| r.decision == "refuse")
    {
        return Err(trpc("FORBIDDEN", "agents.review_refused"));
    }
    let gate = guarded(
        gates::gate_tool_call(pool, &c.own.baseline, owner, &agent.id, &agent.tools, tool),
        no_mapping,
    )?;
    let data_class = gate.data_class();
    if let gates::Gate::Ask { rule_id, .. } = &gate {
        // The session's own guardrail first, the approval itself left out: that is what this request asks.
        let state = state_of(pool, &session).map_err(|e| OwnError::Trpc(run_error(e)))?;
        if let Err(r) = evaluate_tool_call(&session.guardrail, &state, tool, Some(true), None) {
            return Err(trpc("FORBIDDEN", r.code));
        }
        let ttl = guarded(
            approvals::approval_ttl(c.own.approval_ttl_seconds),
            approval_refused,
        )?;
        let engine = reviewer::reviewer_engine(c.own.reviewer_model.as_deref());
        let review = guarded(
            (|| -> Result<Option<reviewer::ReviewRow>, OwnError> {
                if let Some(r) = stored_review {
                    return Ok(Some(r));
                }
                if !reviewer::setting(pool, owner, &agent.id)?.0 {
                    return Ok(None);
                }
                let mut decided = reviewer::review_call(engine, tool, args);
                // A proceed runs the call only where it can run as the person's approval would.
                let door =
                    OWN_APPROVAL_DOORS.contains(&tool) && c.desk().is_some_and(|d| d.comments());
                if decided.decision == "proceed" && !is_person_session(c.principal) {
                    decided = Review {
                        decision: "needs_person".to_owned(),
                        reason_code: "agents.review.not_person_session".to_owned(),
                        ..decided
                    };
                } else if decided.decision == "proceed" && !door {
                    decided = Review {
                        decision: "needs_person".to_owned(),
                        reason_code: "agents.review.door_not_wired".to_owned(),
                        ..decided
                    };
                }
                reviewer::record(
                    pool,
                    &reviewer::Record {
                        owner_id: owner,
                        agent_id: &agent.id,
                        session_id: &session.id,
                        request_id: input.request_id,
                        tool,
                        args,
                        review: &decided,
                        engine,
                    },
                )
                .map(Some)
            })(),
            no_mapping,
        )?;
        // Refused: the step ends with the reviewer's typed refusal, no request is made and nothing runs.
        if review.as_ref().is_some_and(|r| r.decision == "refuse") {
            return Err(trpc("FORBIDDEN", "agents.review_refused"));
        }
        let proceed = review.as_ref().is_some_and(|r| r.decision == "proceed");
        let request = guarded(
            approvals::hold(
                pool,
                &Hold {
                    owner_id: owner,
                    agent_id: &agent.id,
                    session_id: &session.id,
                    request_id: input.request_id,
                    tool,
                    args,
                    rule_id: rule_id.as_deref(),
                    ttl_seconds: ttl,
                    notify_person: !proceed,
                },
            ),
            no_mapping,
        )?;
        if let Some(r) = &review {
            reviewer::link(pool, owner, &r.id, &request.id)?;
        }
        if proceed {
            // The reviewer's proceed runs the call once, exactly as the person's approval would, on the request's key.
            return match decide_and_run(c, &request, "reviewer") {
                Ok((done, _)) => Ok(ran(tool, data_class, done.result)),
                Err(err) => {
                    // Refused before it was approved: the call goes to the person after all, and they are told.
                    let now = unguarded(approvals::get(pool, owner, &request.id))?;
                    if now.status != "waiting" {
                        return Err(err);
                    }
                    approvals::announce_again(pool, owner, &request.id)?;
                    c.announce(&request.id);
                    Ok(waiting(tool, data_class, &now))
                }
            };
        }
        // The person is told after the request's commit; a bus fault never fails the call (the sweep sends it).
        c.announce(&request.id);
        return Ok(waiting(tool, data_class, &request));
    }
    // A tool with no door runs nothing; the catalogue names this refusal for every such tool.
    if !OWN_TOOL_DOORS.contains(&tool) {
        return Err(trpc("BAD_REQUEST", "agents.tool_not_wired"));
    }
    let law = c.x.rt.tier_laws.support.as_ref();
    // A retried read runs the read again and is recorded again: it moves nothing and holds nothing.
    let acted = act(
        &c.x,
        &ActInput {
            session_id: &session.id,
            tool,
            approved: None,
            idempotency_key: None,
        },
        || {
            desk::kb_search(
                c.desk(),
                law,
                owner,
                &c.principal.tier,
                input_field(args, "kbQuery").unwrap_or(""),
                whole_number(input_field(args, "limit")),
            )
            .map(|articles| desk::kb_result_json(&articles))
            .map_err(|reason| DoorRefusal(reason.to_owned()))
        },
    );
    match acted {
        Ok(a) => Ok(ran(tool, data_class, a.result)),
        Err(ActError::Tool(DoorRefusal(reason))) => {
            Err(trpc("BAD_REQUEST", format!("agents.tool_refused.{reason}")))
        }
        Err(ActError::Run(e)) => Err(OwnError::Trpc(run_error(e))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_whole_number_is_digits_only_never_guessed() {
        assert_eq!(whole_number(Some(" 5 ")), Some(5));
        assert_eq!(whole_number(Some("999999")), Some(999_999));
        assert_eq!(whole_number(Some("1000000")), None);
        assert_eq!(whole_number(Some("5.0")), None);
        assert_eq!(whole_number(None), None);
    }

    #[test]
    fn an_approval_refusal_maps_to_its_code() {
        assert_eq!(
            approval_refused("agents.approval.not_found"),
            Some("NOT_FOUND")
        );
        assert_eq!(
            approval_refused("agents.approval.ttl_unset"),
            Some("PRECONDITION_FAILED")
        );
        assert_eq!(
            approval_refused("agents.approval.expired"),
            Some("FORBIDDEN")
        );
        assert_eq!(approval_refused("agents.approval.input_invalid"), None);
        assert_eq!(
            approval_refused("agents.identity.owner_unread"),
            Some("FORBIDDEN")
        );
    }
}
