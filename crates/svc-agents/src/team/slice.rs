//! The team slice's eleven calls (`team/routes.ts`). The door has already checked the caller, the scope, the region,
//! `executeProcedure`'s person-only rule, the input and the team's `assertPerson`; each handler here runs inside the
//! team router's `guard`, building the store or the runs as `storeOf` and `runsOf` do.

use service_kit::json::Json;
use service_kit::schema::{Value, js_trim};
use service_kit::trpc::TrpcError;

use super::runs::TeamRuns;
use super::store::{GrantInput, PoolInput, ProjectInput, TeamStore};
use super::{Team, TeamFail, guard, team_error};
use crate::db::Store;
use crate::door::Ctx;
use crate::gateway::desk::GatewaySlice;
use crate::metering::Metering;
use crate::runtime::{Rt, Runtime};

/// What the slice reads besides the call.
pub struct Deps<'a> {
    pub store: &'a Store,
    pub gateway: &'a GatewaySlice,
    pub m: &'a Metering,
    pub rt: &'a Runtime,
    pub team: &'a Team,
}

fn text<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).as_str()
}

fn whole(v: &Value, key: &str) -> i64 {
    // The input is a checked integer within its bounds.
    #[allow(clippy::cast_possible_truncation, reason = "a checked integer")]
    v.get(key).as_number().map_or(0, |n| n as i64)
}

fn strs<'a>(v: &'a Value, key: &str) -> Vec<&'a str> {
    v.get(key)
        .as_array()
        .map(|items| items.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default()
}

/// The database: a door built without one answers as `deps.sql` absent does.
fn database(store: &Store) -> Result<&service_kit::pg::Pool, TeamFail> {
    match store {
        Store::Pool(p) => Ok(p),
        Store::Down(_) => {
            Err(team_error("agents.capability_unavailable", "Agents database is unset").into())
        }
    }
}

/// `storeOf`.
fn store_of<'a>(d: &'a Deps<'a>) -> Result<TeamStore<'a>, TeamFail> {
    let pool = database(d.store)?;
    let Some(membership) = d.team.membership.as_deref() else {
        return Err(team_error(
            "agents.membership_unavailable",
            "svc-bank team read is unset",
        )
        .into());
    };
    Ok(TeamStore {
        pool,
        membership,
        fee_asset_id: Some(d.m.fee_asset_id.as_str()),
    })
}

/// `runsOf`.
fn runs_of<'a>(ctx: &Ctx<'_>, d: &'a Deps<'a>) -> Result<TeamRuns<'a>, TeamFail> {
    let pool = database(d.store).map_err(|_| {
        TeamFail::from(team_error(
            "agents.capability_unavailable",
            "Agents runtime is unset",
        ))
    })?;
    let Some(membership) = d.team.membership.as_deref() else {
        return Err(team_error(
            "agents.membership_unavailable",
            "svc-bank team read is unset",
        )
        .into());
    };
    let fee = js_trim(&d.m.fee_asset_id);
    if fee.is_empty() {
        return Err(team_error("agents.fee_asset_unset", "Agents fee asset is unset").into());
    }
    Ok(TeamRuns {
        x: Rt {
            rt: d.rt,
            pool,
            gateway: &d.gateway.gateway,
            m: d.m,
            now: ctx.now,
        },
        membership,
        fee_asset_id: fee,
    })
}

/// Answers one call of the slice.
pub fn handle(ctx: &Ctx<'_>, d: &Deps<'_>) -> Result<Option<Json>, TrpcError> {
    answer(ctx, d).map(Some).map_err(guard)
}

fn answer(ctx: &Ctx<'_>, d: &Deps<'_>) -> Result<Json, TeamFail> {
    let user = ctx.principal.map_or("", |p| p.user_id.as_str());
    let input = &ctx.input;
    let business = text(input, "businessId").unwrap_or_default();
    match ctx.call.path {
        "team.view" => store_of(d)?.view(user, business),
        "team.grants.set" => store_of(d)?.set_grant(&GrantInput {
            actor_user_id: user,
            business_id: business,
            member_user_id: text(input, "memberUserId").unwrap_or_default(),
            role: text(input, "role").unwrap_or_default(),
            allow: matches!(input.get("allow"), Value::Bool(true)),
            deny: matches!(input.get("deny"), Value::Bool(true)),
            revision: whole(input, "revision"),
        }),
        "team.pool.set" => store_of(d)?.set_pool(&PoolInput {
            actor_user_id: user,
            business_id: business,
            limit: text(input, "limit"),
            allocations: input
                .get("allocations")
                .as_array()
                .unwrap_or_default()
                .iter()
                .map(|a| {
                    (
                        text(a, "memberUserId").unwrap_or_default(),
                        text(a, "amount"),
                    )
                })
                .collect(),
            revision: whole(input, "revision"),
        }),
        "team.projects.create" => store_of(d)?.create_project(&ProjectInput {
            actor_user_id: user,
            business_id: business,
            name: text(input, "name"),
            limit: text(input, "limit"),
            member_user_ids: strs(input, "memberUserIds"),
            seq: whole(input, "seq"),
        }),
        "team.runs.open" => {
            runs_of(ctx, d)?.open(user, business, text(input, "agentId").unwrap_or_default())
        }
        "team.runs.run" => runs_of(ctx, d)?.run(
            user,
            business,
            text(input, "sessionId").unwrap_or_default(),
            text(input, "requestId").unwrap_or_default(),
            text(input, "ask").unwrap_or_default(),
        ),
        "team.runs.close" => {
            runs_of(ctx, d)?.close(user, text(input, "sessionId").unwrap_or_default())
        }
        "team.actions.list" => runs_of(ctx, d)?.actions(user, business, whole(input, "limit")),
        "team.actions.hold" => runs_of(ctx, d)?.hold(
            user,
            business,
            text(input, "agentId").unwrap_or_default(),
            text(input, "tool").unwrap_or_default(),
            whole(input, "seq"),
        ),
        "team.actions.approve" => {
            runs_of(ctx, d)?.approve(user, business, text(input, "actionId").unwrap_or_default())
        }
        "team.usage" => runs_of(ctx, d)?.usage(user, business),
        other => Err(TeamFail::Thrown(format!(
            "svc-agents in Rust: {other} is not a team call"
        ))),
    }
}
