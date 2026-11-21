//! The runtime slice's eighteen calls, answered as \`router.ts\`, \`runs/routes.ts\`, \`runs/session-events.ts\` and
//! \`review/routes.ts\` answer them. The door has already checked the caller, the scope, the region, the person-only
//! rules and the input; each handler here runs in the TypeScript's order, inside its \`guard\`.
//!
//! A Navigator session's \`run.complete\` is research when the ask names a market (\`crate::navigator::research\`): the
//! service reads each market before anything runs, and the answer carries its provenance.

use service_kit::json::Json;
use service_kit::pg::Pool;
use service_kit::schema::Value;
use service_kit::trpc::TrpcError;

use crate::audit;
use crate::db::Store;
use crate::door::Ctx;
use crate::gateway::desk::GatewaySlice;
use crate::gateway::providers::{ChatMessage, Role};
use crate::gateway::routing::engine_for_tasks;
use crate::metering::Metering;
use crate::navigator::research;
use crate::runtime::guardrails::tool_refusal_codes;
use crate::runtime::{self, Rt, RunError, Runtime, ThinkInput, eligibility, reads, runs, to_trpc};
use service_kit::money::format_amount;

fn number(v: &Value) -> Option<f64> {
    v.as_number()
}

fn text<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).as_str()
}

/// Answers one call of the slice.
pub fn handle(
    ctx: &Ctx<'_>,
    store: &Store,
    gateway: &GatewaySlice,
    m: &Metering,
    rt: &Runtime,
) -> Result<Option<Json>, TrpcError> {
    answer(ctx, store, gateway, m, rt)
        .map(Some)
        .map_err(to_trpc)
}

fn pool(store: &Store) -> Result<&Pool, RunError> {
    Ok(store.pool()?)
}

fn answer(
    ctx: &Ctx<'_>,
    store: &Store,
    gateway: &GatewaySlice,
    m: &Metering,
    rt: &Runtime,
) -> Result<Json, RunError> {
    let user = ctx.principal.map_or("", |p| p.user_id.as_str());
    let input = &ctx.input;
    let x = |p| Rt {
        rt,
        pool: p,
        gateway: &gateway.gateway,
        m,
        now: ctx.now,
    };
    match ctx.call.path {
        "agent.get" => {
            let Some((g, enabled)) =
                runtime::agent_definition(pool(store)?, text(input, "agentId").unwrap_or(""))?
            else {
                return Ok(Json::Null);
            };
            let table = gateway.gateway.routing_table(ctx.now);
            let (engine, metered) = engine_for_tasks(
                &g.limits.allowed_tasks,
                |task| {
                    table
                        .routes
                        .iter()
                        .find(|r| r.task == task)
                        .map(|r| gateway.gateway.route_engine(r, gateway.metering_enabled))
                },
                gateway.metering_enabled,
            );
            let tier = ctx.principal.map_or("", |p| p.tier.as_str());
            let strings =
                |l: &[String]| Json::Array(l.iter().map(|s| Json::str(s.clone())).collect());
            Ok(Json::obj([
                ("agentId", Json::str(g.agent_id.clone())),
                ("version", Json::int(g.version)),
                ("enabled", Json::Bool(enabled)),
                (
                    "tools",
                    Json::Array(
                        g.tools
                            .iter()
                            .map(|t| {
                                Json::obj([
                                    ("name", Json::str(t.name.clone())),
                                    ("module", Json::str(t.module.clone())),
                                    ("mode", Json::str(t.mode.clone())),
                                    ("requiresApproval", Json::Bool(t.requires_approval)),
                                    (
                                        "maxCallsPerSession",
                                        t.max_calls_per_session.map_or(Json::Null, Json::int),
                                    ),
                                    (
                                        "refusals",
                                        Json::Array(
                                            tool_refusal_codes(&g, t)
                                                .into_iter()
                                                .map(Json::str)
                                                .collect(),
                                        ),
                                    ),
                                ])
                            })
                            .collect(),
                    ),
                ),
                (
                    "capacityMode",
                    g.capacity_mode.clone().map_or(Json::Null, Json::str),
                ),
                (
                    "limits",
                    Json::obj([
                        (
                            "maxActionsPerSession",
                            Json::int(g.limits.max_actions_per_session),
                        ),
                        (
                            "maxOutputTokensPerCall",
                            Json::int(g.limits.max_output_tokens_per_call),
                        ),
                        (
                            "maxSpendPerSession",
                            g.limits
                                .max_spend_per_session
                                .map_or(Json::Null, |a| Json::str(format_amount(a))),
                        ),
                        ("allowedModules", strings(&g.limits.allowed_modules)),
                        ("allowedTasks", strings(&g.limits.allowed_tasks)),
                    ]),
                ),
                ("engine", Json::str(engine.name())),
                ("metered", Json::Bool(metered)),
                (
                    "eligibility",
                    eligibility::agent_eligibility(&g.agent_id, &rt.tier_laws, tier),
                ),
            ]))
        }
        "agent.catalogue" => reads::catalogue(pool(store)?),
        "session.open" => {
            let p = pool(store)?;
            Ok(
                runtime::open_session(&x(p), user, text(input, "agentId").unwrap_or(""))?
                    .to_output(),
            )
        }
        "session.close" => {
            let p = pool(store)?;
            let id = text(input, "sessionId").unwrap_or("");
            runtime::owned_session(p, id, user)?;
            Ok(runtime::close_settled(&x(p), id)?.to_output())
        }
        "session.detail" => {
            let p = pool(store)?;
            let s = runtime::owned_session(p, text(input, "sessionId").unwrap_or(""), user)?;
            reads::session_detail(p, &s, &m.fee_asset_id)
        }
        "session.selected" => reads::selected(pool(store)?, user),
        "session.select" => {
            let p = pool(store)?;
            let s = runtime::owned_session(p, text(input, "sessionId").unwrap_or(""), user)?;
            reads::select(p, user, &s)
        }
        "session.log" => {
            let p = pool(store)?;
            let id = text(input, "sessionId").unwrap_or("");
            runtime::owned_session(p, id, user)?;
            let limit = reads::page_limit(
                number(input.get("limit")),
                "agents.session_log_limit_unset",
                "Session log",
            )?;
            Ok(reads::actions(&audit::for_session(p, id, limit)?))
        }
        "session.mine" => {
            let p = pool(store)?;
            let limit = reads::page_limit(
                number(input.get("limit")),
                "agents.session_mine_limit_unset",
                "session.mine",
            )?;
            reads::list_sessions(
                p,
                &reads::ListSessions {
                    user_id: Some(user),
                    limit,
                    cursor: text(input, "cursor"),
                    fee_asset_id: &m.fee_asset_id,
                    ..reads::ListSessions::default()
                },
                false,
            )
        }
        "session.events" => {
            let cursor = text(input, "cursor");
            let after = cursor.map(|c| runs::parse_cursor(Some(c))).transpose()?;
            let p = pool(store)?;
            let s = runtime::owned_session(p, text(input, "sessionId").unwrap_or(""), user)?;
            let limit = whole(input.get("limit"));
            let list = audit::for_session_after(p, &s.id, after, limit)?;
            let cursor = match (list.last(), after) {
                (Some(last), _) => Json::str(last.sequence.to_string()),
                (None, Some(a)) => Json::str(a.to_string()),
                (None, None) => Json::Null,
            };
            Ok(Json::obj([
                ("events", reads::actions(&list)),
                ("cursor", cursor),
            ]))
        }
        "run.complete" => complete(ctx, &x(pool(store)?), user),
        "run.list" => {
            let p = pool(store)?;
            let s = runtime::owned_session(p, text(input, "sessionId").unwrap_or(""), user)?;
            let list = runs::for_session(p, &s.id, whole(input.get("limit")))?;
            Ok(Json::Array(
                list.iter()
                    .map(|r| {
                        Json::obj([
                            ("runId", Json::str(r.id.clone())),
                            ("requestId", Json::str(r.request_id.clone())),
                            ("state", Json::str(r.state.clone())),
                            ("createdAt", Json::str(r.created_at.iso())),
                        ])
                    })
                    .collect(),
            ))
        }
        "run.get" => {
            let p = pool(store)?;
            match runs::get(p, text(input, "runId").unwrap_or(""), user)? {
                Some((run, codes)) => Ok(runs::run_output(&run, &codes)),
                None => Err(run_not_found()),
            }
        }
        "run.events" => {
            let after = runs::parse_cursor(text(input, "cursor"))?;
            let p = pool(store)?;
            let run_id = text(input, "runId").unwrap_or("");
            let Some(events) = runs::events(p, run_id, user, after, whole(input.get("limit")))?
            else {
                return Err(run_not_found());
            };
            let cursor = events
                .last()
                .and_then(|e| e.get("sequence"))
                .map_or_else(|| after.to_string(), |s| s.compact());
            Ok(Json::obj([
                ("events", Json::Array(events)),
                ("cursor", Json::str(cursor)),
            ]))
        }
        "run.trace" => {
            let p = pool(store)?;
            let s = runtime::owned_session(p, text(input, "sessionId").unwrap_or(""), user)?;
            reads::run_trace(p, &s.id, text(input, "requestId").unwrap_or(""))?
                .ok_or_else(run_not_found)
        }
        "log.mine" => {
            let limit = reads::page_limit(
                number(input.get("limit")),
                "agents.log_mine_limit_unset",
                "User log",
            )?;
            let p = pool(store)?;
            Ok(reads::actions(&audit::for_user(
                p,
                user,
                limit,
                text(input, "outcome"),
            )?))
        }
        "log.count" => {
            let p = pool(store)?;
            Ok(Json::obj([(
                "total",
                Json::int(audit::count_for_user(p, user, text(input, "outcome"))?),
            )]))
        }
        "log.export" => {
            let cursor = text(input, "cursor");
            if let Some(c) = cursor {
                reads::decode_log_cursor(c)?;
            }
            // The limit is checked inside the log's read (`forUserAfter`), once the database is there.
            let limit = number(input.get("limit"));
            let p = pool(store)?;
            reads::log_export(
                p,
                user,
                text(input, "outcome"),
                cursor,
                limit,
                text(input, "requestId"),
                text(input, "format"),
            )
        }
        other => Err(RunError::Other(format!("{other} is not a runtime call"))),
    }
}

/// A whole number the input's schema already checked (an int from 1 to 500).
fn whole(v: &Value) -> i64 {
    #[allow(clippy::cast_possible_truncation, reason = "the schema bounds it")]
    number(v).map_or(0, |n| n as i64)
}

fn run_not_found() -> RunError {
    RunError::Trpc(TrpcError::plain("NOT_FOUND", "agents.run_not_found"))
}

/// \`run.complete\`: one metered engine call, stored as a run.
fn complete(ctx: &Ctx<'_>, x: &Rt<'_>, user: &str) -> Result<Json, RunError> {
    let input = &ctx.input;
    let session_id = text(input, "sessionId").unwrap_or("");
    let s = runtime::owned_session(x.pool, session_id, user)?;
    let messages: Vec<ChatMessage> = input
        .get("messages")
        .as_array()
        .unwrap_or_default()
        .iter()
        .map(|msg| ChatMessage {
            role: if msg.get("role").as_str() == Some("assistant") {
                Role::Assistant
            } else {
                Role::User
            },
            content: msg.get("content").as_str().unwrap_or("").to_owned(),
        })
        .collect();
    // A Navigator ask that names a market is research: each market is read before anything runs, and an answer it
    // cannot source refuses uncharged, with no run row.
    let research = if s.agent_id == "navigator" {
        let ask = messages
            .iter()
            .rev()
            .find(|m| m.role == Role::User)
            .map_or("", |m| m.content.as_str());
        let nav = &x.rt.navigator;
        research::prepare_research(ask, nav.trade_data.as_deref(), &nav.research)?
    } else {
        None
    };
    // \`[input.system, research?.system].filter(Boolean).join('\n\n')\`.
    let joined = [
        text(input, "system"),
        research.as_ref().map(|r| r.system.as_str()),
    ]
    .into_iter()
    .flatten()
    .filter(|s| !s.is_empty())
    .collect::<Vec<_>>()
    .join("\n\n");
    let system = Some(joined.as_str()).filter(|s| !s.is_empty());
    let provenance_of = |reply: &str| {
        research
            .as_ref()
            .map_or(Json::Null, |plan| research::build_provenance(plan, reply))
    };
    let request_id = text(input, "requestId").unwrap_or("");
    let task = text(input, "task").unwrap_or("");
    #[allow(
        clippy::cast_possible_truncation,
        reason = "the schema checked a whole number"
    )]
    let max_output_tokens = number(input.get("maxOutputTokens")).map(|n| n as i64);
    let fee = x.m.fee_asset_id.as_str();
    let (result, run) = runs::run_recorded(
        x.pool,
        &runs::RunInput {
            user_id: user,
            session_id: &s.id,
            agent_id: &s.agent_id,
            request_id,
            task,
            asset_id: fee,
            provenance_of: research
                .is_some()
                .then_some(&provenance_of as &dyn Fn(&str) -> Json),
        },
        x.now,
        || {
            runtime::think(
                x,
                &ThinkInput {
                    session_id,
                    request_id,
                    task,
                    system,
                    messages: &messages,
                    max_output_tokens,
                    team_run: false,
                },
            )
        },
    )?;
    let provenance = research.as_ref().map_or(Json::Null, |plan| {
        research::build_provenance(plan, &result.text)
    });
    Ok(Json::obj([
        ("runId", Json::str(run.id)),
        ("text", Json::str(result.text)),
        ("inputTokens", Json::int(result.usage.input_tokens)),
        ("outputTokens", Json::int(result.usage.output_tokens)),
        ("cost", Json::str(format_amount(result.cost))),
        ("assetId", Json::str(fee)),
        ("metered", Json::Bool(result.metered)),
        ("action", result.action.to_output()),
        ("provenance", provenance),
    ]))
}
