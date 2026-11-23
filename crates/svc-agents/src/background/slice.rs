//! The background slice's six calls, answered as `runs/background-routes.ts` answers them. The door has already checked
//! the caller, the scope, the region, the person-only rules and the input; each handler runs in the TypeScript's order,
//! inside the main router's `guard`, with a run's state conflicts answered by `typed`.

use service_kit::json::Json;
use service_kit::schema::Value;
use service_kit::trpc::TrpcError;

use crate::background::{self, Settings, StartInput};
use crate::db::Store;
use crate::door::Ctx;
use crate::gateway::desk::GatewaySlice;
use crate::gateway::routing::resolve_route;
use crate::metering::Metering;
use crate::runtime::{self, Rt, RunError, Runtime, to_trpc};
use crate::self_freeze;

fn text<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).as_str().unwrap_or("")
}

/// Answers one call of the slice.
pub fn handle(
    ctx: &Ctx<'_>,
    store: &Store,
    gateway: &GatewaySlice,
    m: &Metering,
    rt: &Runtime,
    settings: Settings,
) -> Result<Option<Json>, TrpcError> {
    answer(ctx, store, gateway, m, rt, settings)
        .map(Some)
        .map_err(to_trpc)
}

fn not_found() -> RunError {
    RunError::Trpc(TrpcError::plain("NOT_FOUND", "agents.run_not_found"))
}

fn found(v: Option<Json>) -> Result<Json, RunError> {
    v.ok_or_else(not_found)
}

fn unset() -> RunError {
    RunError::Trpc(TrpcError::plain(
        "PRECONDITION_FAILED",
        "agents.session_run_unset",
    ))
}

fn answer(
    ctx: &Ctx<'_>,
    store: &Store,
    gateway: &GatewaySlice,
    m: &Metering,
    rt: &Runtime,
    settings: Settings,
) -> Result<Json, RunError> {
    let user = ctx.principal.map_or("", |p| p.user_id.as_str());
    let input = &ctx.input;
    let run_id = text(input, "runId");
    let freeze = || self_freeze::gate(user, rt.self_freeze.as_deref()).map_err(RunError::Trpc);
    match ctx.call.path {
        "run.background.start" => {
            // Blank owner values refuse by name; nothing invents how many steps a run may take or how long one is.
            let (Some(max_steps), Some(_)) = (settings.max_steps, settings.step_ms) else {
                return Err(unset());
            };
            #[allow(
                clippy::cast_possible_truncation,
                reason = "the schema checked a whole number"
            )]
            let steps = input.get("steps").as_number().map_or(0, |n| n as i64);
            if steps > max_steps {
                return Err(RunError::Trpc(TrpcError::plain(
                    "BAD_REQUEST",
                    "agents.session_run_steps_over",
                )));
            }
            let pool = store.pool()?;
            let session = runtime::owned_session(pool, text(input, "sessionId"), user)?;
            if session.status != "open" {
                return Err(RunError::Trpc(TrpcError::plain(
                    "CONFLICT",
                    "agents.refused.session_closed",
                )));
            }
            // No agent runs for the person while their own freeze is on, or cannot be read (J-wallet-13).
            freeze()?;
            let task = text(input, "task");
            resolve_route(&gateway.gateway.routing_table(ctx.now), task).map_err(|e| {
                RunError::Agent(runtime::Denied {
                    error: e,
                    params: Vec::new(),
                })
            })?;
            background::start(
                pool,
                &StartInput {
                    user_id: user,
                    session_id: &session.id,
                    agent_id: &session.agent_id,
                    request_key: text(input, "requestId"),
                    task,
                    ask: text(input, "ask"),
                    notice: text(input, "notice"),
                    steps,
                },
            )
        }
        "run.background.get" => found(background::get(store.pool()?, run_id, user)?),
        "run.background.pause" => found(background::pause(store.pool()?, run_id, user)?),
        "run.background.resume" => {
            // A run the freeze paused stays paused until the person resumes it after the lift (J-wallet-13).
            freeze()?;
            found(background::resume(store.pool()?, run_id, user)?)
        }
        "run.background.askMore" => {
            let Some(max_steps) = settings.max_steps else {
                return Err(unset());
            };
            found(background::ask_more(
                store.pool()?,
                run_id,
                user,
                text(input, "text"),
                max_steps,
            )?)
        }
        "run.background.stop" => {
            let x = Rt {
                rt,
                pool: store.pool()?,
                gateway: &gateway.gateway,
                m,
                now: ctx.now,
            };
            found(background::stop(&x, run_id, user)?)
        }
        other => Err(RunError::Other(format!("{other} is not a background call"))),
    }
}
