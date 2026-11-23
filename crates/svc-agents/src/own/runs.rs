//! The `own-runs` slice's calls (`README.md`), answered as `own/routes.ts` and `own/automation-routes.ts` answer them:
//! a session of the person's own agent and its runs, the runs list, the held calls and the person's decisions on them,
//! what the agent holds, the order the person asks it for, its background test runs, and its schedules and triggers.
//! The door has already checked the caller, the scope, the region, the person checks (`assertPersonSetsLimits`) and the
//! input; each handler runs inside its route's `guard`.

use service_kit::json::{self, Json};
use service_kit::money::{format_amount, is_js_whitespace, js_trim, parse_amount};
use service_kit::pg::Pool;
use service_kit::schema::Value;
use service_kit::trpc::TrpcError;

use super::approvals::{self, Request};
use super::automation::{self, Automation, LIST_LIMIT};
use super::background;
use super::catalog::own_tool;
use super::desk::draft_ticket_comment;
use super::notices::{Scope, publish_pending_approval_requests};
use super::self_freeze::assert_not_self_frozen;
use super::test_runs::{AGENT_DISABLED, caps_set, own_agent_switch};
use super::tool_try::{
    Call, approval_refused, args_of, decide_and_run, own_guardrail, owned_own_session, run_error,
};
use super::{
    OWN_RUN_TASK, OwnError, OwnRefusal, guard, no_mapping, own_session_agent_id, owner_forbidden,
    pool_of, store,
};
use crate::db::{self, StoreError};
use crate::door::{Ctx, Slice, not_ported};
use crate::gateway::providers::{ChatMessage, Role};
use crate::runtime::{self, Rt, RunError, ThinkInput, ms};
use crate::self_freeze::SelfFreezeRead;

pub use super::slice::Deps;

fn text<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).as_str().unwrap_or("")
}

/// A whole number the input check already bounded.
#[allow(
    clippy::cast_possible_truncation,
    reason = "the input check bounds it to a small whole number"
)]
fn whole(v: &Value, key: &str) -> i64 {
    v.get(key).as_number().map_or(0, |n| n as i64)
}

fn trpc(code: &'static str, message: impl Into<String>) -> OwnError {
    OwnError::Trpc(TrpcError::plain(code, message))
}

/// `guard(fn, codeOf)` around one step.
fn guarded<T, E: Into<OwnError>>(
    r: Result<T, E>,
    code_of: fn(&str) -> Option<&'static str>,
) -> Result<T, OwnError> {
    r.map_err(|e| OwnError::Trpc(guard(e.into(), code_of)))
}

/// A runtime failure outside `runError`: tRPC's 500 with its words, as an uncaught throw answers.
fn thrown(e: RunError) -> OwnError {
    match e {
        RunError::Store(s) => OwnError::Thrown(s.message),
        RunError::Agent(d) | RunError::MeteredReplay(d) => OwnError::Thrown(d.error.message),
        RunError::Trpc(t) => OwnError::Trpc(t),
        RunError::Other(m) => OwnError::Thrown(m),
        RunError::Refused { refusal, .. } => OwnError::Thrown(refusal.code),
    }
}

/// `assertOwnAgentOn`: new work of a quarantined agent, or of one whose kind is off, refuses `agents.agent.disabled`.
fn assert_own_agent_on(pool: &Pool, agent_id: &str) -> Result<(), OwnError> {
    if own_agent_switch(pool, agent_id)? == "active" {
        Ok(())
    } else {
        Err(trpc("FORBIDDEN", AGENT_DISABLED))
    }
}

fn freeze<'a>(d: &'a Deps<'_>) -> Option<&'a dyn SelfFreezeRead> {
    d.rt.self_freeze.as_deref()
}

/// `automation-routes.ts`'s own `guard`: a code ending `.not_found` is NOT_FOUND, an owner's account refusing is
/// FORBIDDEN, a blank owner cadence PRECONDITION_FAILED, anything else BAD_REQUEST.
fn automation_code(code: &str) -> Option<&'static str> {
    Some(if code.ends_with(".not_found") {
        "NOT_FOUND"
    } else if code.starts_with("agents.identity.owner_") {
        "FORBIDDEN"
    } else if code == "agents.schedule_cadence_unset" {
        "PRECONDITION_FAILED"
    } else {
        "BAD_REQUEST"
    })
}

/// `closedRequest`: a closed request's typed refusal, as the agent's call reads it.
fn closed_request(request: &Request) -> OwnError {
    trpc(
        "FORBIDDEN",
        request.refusal_code().unwrap_or("agents.approval.decided"),
    )
}

/// `checkEditedInput`: an edited input is the tool's declared input and nothing else, every field one the tool
/// declares, none blank; a comment within the limits its door checks. Anything else refuses
/// `agents.approval.input_invalid` and replaces nothing.
pub fn check_edited_input(tool: &str, args: &[(String, String)]) -> Result<(), OwnRefusal> {
    let invalid = || OwnRefusal::new("agents.approval.input_invalid");
    let declared: Vec<&str> = own_tool(tool)
        .and_then(|t| t.shape)
        .map(|s| s.input.iter().map(|(k, _)| *k).collect())
        .unwrap_or_default();
    let field = |name: &str| {
        args.iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    };
    let exact = !declared.is_empty()
        && args.len() == declared.len()
        && declared
            .iter()
            .all(|f| field(f).is_some_and(|v| !js_trim(v).is_empty()));
    if !exact {
        return Err(invalid());
    }
    if tool == "support.ticket.comment" {
        match draft_ticket_comment(field("ticketId"), field("body")) {
            Ok((ticket, _)) if ticket.encode_utf16().count() <= 120 => {}
            _ => return Err(invalid()),
        }
    }
    Ok(())
}

/// One order read from the person's words (`ownAgentOrderDraftSchema`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OrderDraft {
    pub side: &'static str,
    pub size: String,
    pub base: String,
    pub price: Option<String>,
}

impl OrderDraft {
    pub fn to_json(&self) -> Json {
        Json::obj([
            ("side", Json::str(self.side)),
            ("size", Json::str(self.size.clone())),
            ("base", Json::str(self.base.clone())),
            (
                "type",
                Json::str(if self.price.is_some() {
                    "limit"
                } else {
                    "market"
                }),
            ),
            ("price", self.price.clone().map_or(Json::Null, Json::String)),
            ("label", Json::str("TEST")),
        ])
    }
}

/// `[0-9]+(?:\.[0-9]+)?`.
fn is_decimal(t: &str) -> bool {
    let mut parts = t.splitn(2, '.');
    let whole = parts.next().unwrap_or("");
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    digits(whole) && parts.next().is_none_or(digits)
}

/// `draftOrder` (`own/trade-draft.ts`): the test engine reads one order from the person's words, "buy 0.0001 BTC at
/// market" or "sell 0.5 ETH at 3100", and drafts it; it sends, holds and signs nothing. Words that are not one order
/// refuse `agents.order_not_understood`: it never guesses a size, a side or an asset. The TypeScript's case-blind
/// pattern (`ORDER_WORDS`) is read by hand: its letters are ASCII, which its `i` flag folds as ASCII.
pub fn draft_order(ask: &str) -> Result<OrderDraft, OwnError> {
    let not_understood = || OwnError::from(OwnRefusal::new("agents.order_not_understood"));
    // `\s*[.!]?\s*$`: at most one stop or bang at the end, with spaces either side.
    let mut words = ask.trim_matches(is_js_whitespace);
    if let Some(rest) = words.strip_suffix(['.', '!']) {
        words = rest.trim_end_matches(is_js_whitespace);
    }
    let parts: Vec<&str> = words
        .split(is_js_whitespace)
        .filter(|w| !w.is_empty())
        .collect();
    let [side, size, base, at, price] = parts[..] else {
        return Err(not_understood());
    };
    let side = match side.to_ascii_lowercase().as_str() {
        "buy" => "buy",
        "sell" => "sell",
        _ => return Err(not_understood()),
    };
    let base_ok = base.len() >= 2
        && base.len() <= 16
        && base.bytes().next().is_some_and(|b| b.is_ascii_alphabetic())
        && base.bytes().all(|b| b.is_ascii_alphanumeric());
    let market = price.eq_ignore_ascii_case("market");
    if !is_decimal(size)
        || !base_ok
        || !at.eq_ignore_ascii_case("at")
        || !(market || is_decimal(price))
    {
        return Err(not_understood());
    }
    // `positive`: a figure at or below zero refuses; one the money type cannot read is its own fault, as there.
    let positive = |t: &str| -> Result<String, OwnError> {
        let units = parse_amount(t).map_err(OwnError::Thrown)?;
        if units <= 0 {
            return Err(not_understood());
        }
        Ok(format_amount(units))
    };
    Ok(OrderDraft {
        side,
        size: positive(size)?,
        base: base.to_ascii_uppercase(),
        price: if market { None } else { Some(positive(price)?) },
    })
}

/// `ownAgentHolds`: what the agent holds for the person across its sessions.
fn holds(pool: &Pool, owner_id: &str, session_agent_id: &str) -> Result<Json, OwnError> {
    let row = db::with_client(pool, |c| {
        Ok(c.query_one(
            "SELECT
               (SELECT count(*)::bigint FROM agents.agent_sessions s WHERE s.user_id = $1::text AND s.agent_id = $2::text),
               (SELECT count(*)::bigint FROM agents.spend_reservations r
                  JOIN agents.agent_sessions s ON s.id = r.session_id
                 WHERE r.user_id = $1::text AND s.user_id = $1::text AND s.agent_id = $2::text),
               (SELECT count(*)::bigint FROM agents.agent_place_intents i
                  JOIN agents.agent_sessions s ON s.id = i.session_id
                 WHERE s.user_id = $1::text AND s.agent_id = $2::text)",
            &[&owner_id, &session_agent_id],
        )?)
    })?;
    Ok(Json::obj([
        ("sessions", Json::int(row.try_get(0)?)),
        ("reservations", Json::int(row.try_get(1)?)),
        ("intents", Json::int(row.try_get(2)?)),
    ]))
}

/// `messageParamsOf`: an action row's stored words' parameters, strings and numbers only.
fn message_params_of(raw: Option<String>) -> Json {
    let fields = raw
        .and_then(|t| json::parse(&t).ok())
        .and_then(|v| match v {
            Json::Object(fields) => Some(fields),
            _ => None,
        })
        .unwrap_or_default();
    Json::Object(
        fields
            .into_iter()
            .filter(|(_, v)| matches!(v, Json::String(_) | Json::Number(_)))
            .collect(),
    )
}

/// One row of `own.runs` and what it sorts by.
struct RunRow {
    occurred_at: String,
    sequence: Option<i64>,
    view: Json,
}

/// `own.runs`: every engine call asked of the agent by the person (admitted, refused with its code, or failed), and
/// each tool call a rule holds for the person, newest first; at one instant a held call comes first.
fn runs(
    pool: &Pool,
    user: &str,
    agent_id: &str,
    asset: &str,
    limit: i64,
) -> Result<Json, OwnError> {
    let rows = db::with_client(pool, |c| {
        Ok(c.query(
            &format!(
                "SELECT a.session_id::text, a.sequence::bigint, a.status::text, a.task, a.refusal_code, a.cost::text,
                        {}, a.user_message_params::text
                   FROM agents.agent_actions a
                  WHERE a.user_id = $1::text AND a.agent_id = $2::text AND a.kind = 'completion'
                  ORDER BY a.occurred_at DESC, a.sequence DESC
                  LIMIT $3",
                ms("a.occurred_at")
            ),
            &[&user, &own_session_agent_id(agent_id), &limit],
        )?)
    })?;
    let mut out = Vec::new();
    for r in &rows {
        let status: String = r.try_get(2)?;
        let sequence: i64 = r.try_get(1)?;
        let cost: String = r.try_get(5)?;
        let occurred_at = service_kit::time::Instant(r.try_get(6)?).iso();
        let params = if status == "refused" {
            message_params_of(r.try_get(7)?)
        } else {
            Json::Object(Vec::new())
        };
        let cost = parse_amount(&cost).map_err(|e| StoreError::new(e, None))?;
        out.push(RunRow {
            occurred_at: occurred_at.clone(),
            sequence: Some(sequence),
            view: Json::obj([
                ("sessionId", Json::String(r.try_get(0)?)),
                (
                    "task",
                    r.try_get::<_, Option<String>>(3)?
                        .map_or(Json::Null, Json::String),
                ),
                (
                    "refusalCode",
                    r.try_get::<_, Option<String>>(4)?
                        .map_or(Json::Null, Json::String),
                ),
                ("cost", Json::str(format_amount(cost))),
                ("assetId", Json::str(asset)),
                ("occurredAt", Json::str(occurred_at)),
                ("messageParams", params),
                ("sequence", Json::int(sequence)),
                ("status", Json::str(status)),
                ("tool", Json::Null),
                ("requestId", Json::Null),
            ]),
        });
    }
    // The tool calls a rule holds for the person: a held call has not run, so it has no action and cost nothing.
    for request in approvals::waiting(pool, user, agent_id, limit)? {
        let occurred_at = request.created_at.iso();
        out.push(RunRow {
            occurred_at: occurred_at.clone(),
            sequence: None,
            view: Json::obj([
                ("sessionId", Json::str(request.session_id.clone())),
                ("task", Json::Null),
                ("refusalCode", Json::Null),
                ("cost", Json::str("0")),
                ("assetId", Json::str(asset)),
                ("occurredAt", Json::str(occurred_at)),
                ("messageParams", Json::Object(Vec::new())),
                ("sequence", Json::Null),
                ("status", Json::str("waiting")),
                ("tool", Json::str(request.tool.clone())),
                ("requestId", Json::str(request.id.clone())),
            ]),
        });
    }
    out.sort_by(|a, b| {
        b.occurred_at
            .cmp(&a.occurred_at)
            .then_with(|| match (a.sequence, b.sequence) {
                (None, _) => std::cmp::Ordering::Less,
                (_, None) => std::cmp::Ordering::Greater,
                (Some(x), Some(y)) => y.cmp(&x),
            })
    });
    Ok(Json::Array(
        out.into_iter()
            .take(usize::try_from(limit).unwrap_or(0))
            .map(|r| r.view)
            .collect(),
    ))
}

/// `pinSession`: the session keeps the version's instructions it opened on for its whole life.
fn pin_session(
    pool: &Pool,
    owner_id: &str,
    agent_id: &str,
    session_id: &str,
    version: i64,
    instructions: &str,
) -> Result<(), OwnError> {
    let version = i32::try_from(version).map_err(|e| OwnError::Thrown(e.to_string()))?;
    db::with_client(pool, |c| {
        c.execute(
            "INSERT INTO agents.own_agent_session_versions (session_id, agent_id, owner_id, version, instructions)
             VALUES ($1::text::uuid, $2::text::uuid, $3::text, $4, $5::text)
             ON CONFLICT (session_id) DO NOTHING",
            &[&session_id, &agent_id, &owner_id, &version, &instructions],
        )?;
        Ok(())
    })?;
    Ok(())
}

/// `sessionInstructions`: the instructions a session opened on, or none for one opened before sessions were pinned.
fn session_instructions(
    pool: &Pool,
    owner_id: &str,
    session_id: &str,
) -> Result<Option<String>, OwnError> {
    let rows = db::with_client(pool, |c| {
        Ok(c.query(
            "SELECT instructions FROM agents.own_agent_session_versions
              WHERE owner_id = $1::text AND session_id = $2::text::uuid",
            &[&owner_id, &session_id],
        )?)
    })?;
    Ok(rows.first().map(|r| r.try_get(0)).transpose()?)
}

/// Answers one call of the slice.
pub fn handle(ctx: &Ctx<'_>, d: &Deps<'_>) -> Result<Option<Json>, TrpcError> {
    answer(ctx, d).map(Some).map_err(|e| guard(e, no_mapping))
}

#[allow(
    clippy::too_many_lines,
    reason = "one arm per call, each in its route's order"
)]
fn answer(ctx: &Ctx<'_>, d: &Deps<'_>) -> Result<Json, OwnError> {
    let input = &ctx.input;
    let user = ctx.principal.map_or("", |p| p.user_id.as_str());
    let asset = d.m.fee_asset_id.as_str();
    let rt = |pool| Rt {
        rt: d.rt,
        pool,
        gateway: &d.gateway.gateway,
        m: d.m,
        now: ctx.now,
    };
    match ctx.call.path {
        "own.session.open" => {
            let pool = guarded(pool_of(d.store), owner_forbidden)?;
            let agent = guarded(store::get(pool, user, text(input, "id")), owner_forbidden)?;
            assert_own_agent_on(pool, &agent.id)?;
            guarded(assert_not_self_frozen(user, freeze(d)), owner_forbidden)?;
            if !caps_set(pool, user, &agent.id)? {
                return Err(OwnRefusal::new("agents.spend.cap_unset").into());
            }
            let session = runtime::open_own_session(&rt(pool), user, &own_guardrail(&agent)?)
                .map_err(thrown)?;
            // The session keeps this version's instructions for its whole life; its tools and cap are in its
            // guardrail already.
            pin_session(
                pool,
                user,
                &agent.id,
                &session.id,
                session.guardrail_version,
                &agent.instructions,
            )?;
            Ok(Json::obj([
                ("sessionId", Json::str(session.id)),
                ("agentId", Json::str(session.agent_id)),
                ("version", Json::int(session.guardrail_version)),
            ]))
        }
        "own.session.close" => {
            let pool = pool_of(d.store)?;
            let (_, session) =
                owned_own_session(pool, user, text(input, "id"), text(input, "sessionId"))?;
            let closed = runtime::close_settled(&rt(pool), &session.id)
                .map_err(|e| OwnError::Trpc(run_error(e)))?;
            Ok(Json::obj([
                ("sessionId", Json::str(closed.id)),
                ("status", Json::str("closed")),
                (
                    "closedAt",
                    Json::str(closed.closed_at.unwrap_or(ctx.now).iso()),
                ),
            ]))
        }
        "own.run" => {
            let pool = pool_of(d.store)?;
            let (agent, session) =
                owned_own_session(pool, user, text(input, "id"), text(input, "sessionId"))?;
            // While the owner's own freeze is on (or cannot be read) the agent does nothing for them.
            guarded(assert_not_self_frozen(user, freeze(d)), owner_forbidden)?;
            // A session keeps the instructions it opened on, whatever was edited or published since; one opened before
            // sessions were pinned reads the agent as it stands.
            let instructions =
                session_instructions(pool, user, &session.id)?.unwrap_or(agent.instructions);
            let messages = [ChatMessage {
                role: Role::User,
                content: text(input, "ask").to_owned(),
            }];
            let result = runtime::think(
                &rt(pool),
                &ThinkInput {
                    session_id: &session.id,
                    request_id: text(input, "requestId"),
                    task: OWN_RUN_TASK,
                    system: (!js_trim(&instructions).is_empty()).then_some(instructions.as_str()),
                    messages: &messages,
                    max_output_tokens: None,
                    team_run: false,
                },
            )
            .map_err(|e| OwnError::Trpc(run_error(e)))?;
            Ok(Json::obj([
                ("text", Json::str(result.text)),
                ("cost", Json::str(format_amount(result.cost))),
                ("assetId", Json::str(asset)),
                ("inputTokens", Json::int(result.usage.input_tokens)),
                ("outputTokens", Json::int(result.usage.output_tokens)),
            ]))
        }
        "own.runs" => {
            let pool = pool_of(d.store)?;
            let agent = store::get(pool, user, text(input, "id"))?;
            runs(pool, user, &agent.id, asset, whole(input, "limit"))
        }
        "own.holds" => {
            let pool = pool_of(d.store)?;
            let agent = store::get(pool, user, text(input, "id"))?;
            holds(pool, user, &own_session_agent_id(&agent.id))
        }
        "own.trade.draft" => {
            let pool = pool_of(d.store)?;
            store::get(pool, user, text(input, "id"))?;
            Ok(draft_order(text(input, "ask"))?.to_json())
        }
        "own.inbox" => {
            let pool = pool_of(d.store)?;
            Ok(Json::Array(
                approvals::inbox(pool, user, whole(input, "limit"))?
                    .into_iter()
                    .map(|(request, name)| {
                        let Json::Object(mut fields) = request.to_json() else {
                            return Json::Null;
                        };
                        fields.push(("agentId".to_owned(), Json::str(request.agent_id.clone())));
                        fields.push(("agentName".to_owned(), Json::str(name)));
                        Json::Object(fields)
                    })
                    .collect(),
            ))
        }
        "own.approvals" => {
            let pool = pool_of(d.store)?;
            let agent = store::get(pool, user, text(input, "id"))?;
            Ok(Json::Array(
                approvals::list(pool, user, &agent.id, whole(input, "limit"))?
                    .iter()
                    .map(Request::to_json)
                    .collect(),
            ))
        }
        "own.approval.approve" => {
            let pool = pool_of(d.store)?;
            let stored = guarded(
                approvals::get(pool, user, text(input, "requestId")),
                approval_refused,
            )?;
            let answer = |request: &Request, repeated: bool| {
                Json::obj([
                    ("request", request.to_json()),
                    ("repeated", Json::Bool(repeated)),
                ])
            };
            if stored.status == "approved" && stored.ran_at.is_some() {
                return Ok(answer(&stored, true));
            }
            if stored.refusal_code().is_some() {
                return Err(closed_request(&stored));
            }
            let Some(principal) = ctx.principal else {
                return Err(OwnError::Thrown("no principal".to_owned()));
            };
            let call = Call {
                x: rt(pool),
                own: d.own,
                principal,
                forwarded: &ctx.forwarded,
            };
            let (request, repeated) = decide_and_run(&call, &stored, "person")?;
            Ok(answer(&request, repeated))
        }
        "own.approval.edit" => {
            let pool = guarded(pool_of(d.store), approval_refused)?;
            let edited = (|| -> Result<(Request, Request), OwnError> {
                let stored = approvals::get(pool, user, text(input, "requestId"))?;
                let args = args_of(input.get("input"));
                check_edited_input(&stored.tool, &args)?;
                let ttl = approvals::approval_ttl(d.own.approval_ttl_seconds)?;
                approvals::edit(pool, user, &stored.id, &args, ttl)
            })();
            let (replaced, request) = guarded(edited, approval_refused)?;
            // The new request is announced after its commit; a bus fault here never fails the edit (the sweep sends it).
            let _ = publish_pending_approval_requests(
                pool,
                d.m,
                ctx.now,
                &Scope {
                    owner_id: Some(user),
                    request_id: Some(&request.id),
                    on_error: None,
                },
            );
            Ok(Json::obj([
                ("replaced", replaced.to_json()),
                ("request", request.to_json()),
            ]))
        }
        "own.approval.reject" => {
            let pool = guarded(pool_of(d.store), approval_refused)?;
            Ok(guarded(
                approvals::reject(pool, user, text(input, "requestId")),
                approval_refused,
            )?
            .to_json())
        }
        "own.backgroundRun" => {
            let settings = d.own.background;
            let (Some(steps), Some(_)) = (settings.steps, settings.step_ms) else {
                return Err(trpc("PRECONDITION_FAILED", "agents.background_unset"));
            };
            let pool = guarded(pool_of(d.store), owner_forbidden)?;
            let agent = guarded(store::get(pool, user, text(input, "id")), owner_forbidden)?;
            assert_own_agent_on(pool, &agent.id)?;
            guarded(assert_not_self_frozen(user, freeze(d)), owner_forbidden)?;
            background::start(
                pool,
                user,
                &agent.id,
                text(input, "requestId"),
                text(input, "ask"),
                steps,
            )
        }
        "own.backgroundRuns" => {
            let pool = pool_of(d.store)?;
            let agent = store::get(pool, user, text(input, "id"))?;
            background::list(pool, user, &agent.id, whole(input, "limit"))
        }
        "own.schedules.list"
        | "own.schedules.create"
        | "own.schedules.cancel"
        | "own.triggers.list"
        | "own.triggers.create" => guarded(automation_call(ctx, d, user), automation_code),
        _ => Err(OwnError::Trpc(not_ported(Slice::OwnRuns))),
    }
}

/// The schedules and triggers (`ownAutomationRouter`), inside its own `guard`.
fn automation_call(ctx: &Ctx<'_>, d: &Deps<'_>, user: &str) -> Result<Json, OwnError> {
    let input = &ctx.input;
    let asset = d.m.fee_asset_id.as_str();
    // `stores()`: without a database or a fee asset every call is unavailable.
    let pool = pool_of(d.store)?;
    if asset.is_empty() {
        return Err(trpc("SERVICE_UNAVAILABLE", "agents.capability_unavailable"));
    }
    let store_of = Automation {
        pool,
        asset_id: asset,
    };
    let agent = store::get(pool, user, text(input, "id"))?;
    let cadence = d.own.cadence;
    match ctx.call.path {
        "own.schedules.list" => Ok(Json::obj([
            ("cadence", cadence.to_json()),
            (
                "schedules",
                Json::Array(store_of.schedules(user, &agent.id, LIST_LIMIT)?),
            ),
        ])),
        "own.schedules.create" => {
            assert_own_agent_on(pool, &agent.id)?;
            assert_not_self_frozen(user, freeze(d))?;
            let request = automation::check_schedule_request(
                text(input, "repeat"),
                text(input, "intervalMinutes"),
                text(input, "perRunCap"),
                text(input, "ask"),
                cadence,
            )?;
            store_of.create_schedule(user, &agent, text(input, "createKey"), &request)
        }
        "own.schedules.cancel" => {
            store_of.cancel_schedule(user, &agent.id, text(input, "scheduleId"))
        }
        "own.triggers.list" => Ok(Json::Array(store_of.triggers(user, &agent.id, LIST_LIMIT)?)),
        _ => {
            assert_own_agent_on(pool, &agent.id)?;
            assert_not_self_frozen(user, freeze(d))?;
            let request = automation::check_trigger_request(
                text(input, "subject"),
                text(input, "perRunCap"),
                text(input, "ask"),
            )?;
            store_of.create_trigger(user, &agent, text(input, "createKey"), &request)
        }
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test: a failure is the point")]
    use super::*;

    fn draft(ask: &str) -> Result<OrderDraft, String> {
        draft_order(ask).map_err(|e| match e {
            OwnError::Refusal(r) => r.code,
            other => format!("{other:?}"),
        })
    }

    #[test]
    fn an_order_in_the_persons_words_is_drafted_and_anything_else_refuses() {
        assert_eq!(
            draft("buy 0.0001 BTC at market").unwrap(),
            OrderDraft {
                side: "buy",
                size: "0.0001".to_owned(),
                base: "BTC".to_owned(),
                price: None,
            }
        );
        assert_eq!(
            draft("  SELL 0.50 eth AT 3100.  ").unwrap(),
            OrderDraft {
                side: "sell",
                size: "0.5".to_owned(),
                base: "ETH".to_owned(),
                price: Some("3100".to_owned()),
            }
        );
        assert_eq!(draft("buy 1 BTC at market !").unwrap().price, None);
        for words in [
            "buy BTC",
            "buy 0 BTC at market",
            "buy 1 BTC at 0",
            "buy 1 B at market",
            "buy 1 1BTC at market",
            "buy 1 BTC at market..",
            "buy 1. BTC at market",
            "purchase 1 BTC at market",
            "buy 1 BTC for market",
            "buy 1 BTC at market now",
        ] {
            assert_eq!(
                draft(words).unwrap_err(),
                "agents.order_not_understood",
                "{words}"
            );
        }
        assert_eq!(
            draft("sell 2 ABCDEFGHIJKLMNOP at 1").unwrap().base,
            "ABCDEFGHIJKLMNOP"
        );
        assert!(draft("sell 2 ABCDEFGHIJKLMNOPQ at 1").is_err());
    }

    #[test]
    fn an_edited_input_is_exactly_the_tools_declared_fields_none_blank() {
        let args = |pairs: &[(&str, &str)]| -> Vec<(String, String)> {
            pairs
                .iter()
                .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
                .collect()
        };
        let ok = args(&[("ticketId", "T-1"), ("body", "Thanks, looking now.")]);
        assert!(check_edited_input("support.ticket.comment", &ok).is_ok());
        for bad in [
            args(&[("ticketId", "T-1")]),
            args(&[("ticketId", "T-1"), ("body", "  ")]),
            args(&[("ticketId", "T-1"), ("body", "x"), ("extra", "y")]),
            args(&[("ticketId", &"T".repeat(121)), ("body", "x")]),
        ] {
            assert_eq!(
                check_edited_input("support.ticket.comment", &bad)
                    .unwrap_err()
                    .code,
                "agents.approval.input_invalid"
            );
        }
        assert!(check_edited_input("no.such.tool", &ok).is_err());
    }

    #[test]
    fn the_automation_guard_maps_its_codes() {
        assert_eq!(
            automation_code("agents.schedule.not_found"),
            Some("NOT_FOUND")
        );
        assert_eq!(automation_code("agents.own.not_found"), Some("NOT_FOUND"));
        assert_eq!(
            automation_code("agents.identity.owner_frozen_self"),
            Some("FORBIDDEN")
        );
        assert_eq!(
            automation_code("agents.schedule_cadence_unset"),
            Some("PRECONDITION_FAILED")
        );
        assert_eq!(
            automation_code("agents.schedule.ask_blank"),
            Some("BAD_REQUEST")
        );
    }
}
