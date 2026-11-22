//! The own-controls slice's calls, answered as `own/routes.ts` and `own/usage-limits-routes.ts` answer them. The door
//! has already checked the caller, the scope, the region, the person checks (`assertPersonSetsLimits`) and the input;
//! each handler runs inside its route's `guard`.

use service_kit::json::Json;
use service_kit::money::format_amount;
use service_kit::schema::Value;
use service_kit::trpc::TrpcError;

use super::super::catalog::OWN_AGENTS_MAX;
use super::super::self_freeze::assert_not_self_frozen;
use super::super::{
    Own, OwnError, guard, no_mapping, own_session_agent_id, owner_forbidden, pool_of, store,
};
use super::{consents, limits, memory, payment, policy, usage_limits};
use crate::db::{self, Store};
use crate::door::{Ctx, Slice, not_ported};
use crate::gateway::desk::GatewaySlice;
use crate::metering::Metering;
use crate::metering::meter::{usage_by_day, windows_of};
use crate::runtime::{Rt, Runtime, publish_usage_alerts};

/// What the slice reads besides the call.
pub struct Deps<'a> {
    pub store: &'a Store,
    pub gateway: &'a GatewaySlice,
    pub m: &'a Metering,
    pub rt: &'a Runtime,
    pub own: &'a Own,
}

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

fn flag(v: &Value, key: &str) -> bool {
    matches!(v.get(key), Value::Bool(true))
}

/// The refusals each call maps itself; the rest are `guard`'s default.
fn code_of(path: &str) -> fn(&str) -> Option<&'static str> {
    match path {
        "own.policy.add" | "own.policy.require" | "own.consents.grant" => owner_forbidden,
        "own.policy.check" | "own.policy.forService" => policy::policy_refused,
        "own.memory.clear" => |c| (c == "agents.memory.not_found").then_some("NOT_FOUND"),
        "own.privacy.keepTranscripts" => {
            |c| (c == "agents.retention_unset").then_some("PRECONDITION_FAILED")
        }
        "own.paymentMethod.set" => payment::wallets_unread,
        _ => no_mapping,
    }
}

/// Answers one call of the slice.
pub fn handle(ctx: &Ctx<'_>, d: &Deps<'_>) -> Result<Option<Json>, TrpcError> {
    answer(ctx, d)
        .map(Some)
        .map_err(|e| guard(e, code_of(ctx.call.path)))
}

fn answer(ctx: &Ctx<'_>, d: &Deps<'_>) -> Result<Json, OwnError> {
    let input = &ctx.input;
    let user = ctx.principal.map_or("", |p| p.user_id.as_str());
    let freeze = d.rt.self_freeze.as_deref();
    let asset = d.m.fee_asset_id.as_str();
    let wallets = d.own.linked_wallets.as_deref();
    let id = text(input, "id");
    match ctx.call.path {
        "own.limits.get" => {
            let view = limits::get(pool_of(d.store)?, user, id)?;
            Ok(view.to_json(d.rt.overage_grace, asset))
        }
        "own.limits.set" => {
            let view = limits::set(
                pool_of(d.store)?,
                user,
                id,
                input.get("perCall").as_str(),
                input.get("perSession").as_str(),
                input.get("perPeriod").as_str(),
            )?;
            Ok(view.to_json(d.rt.overage_grace, asset))
        }
        "own.usageLimits.get" => {
            let pool = pool_of(d.store)?;
            // Reading also publishes any of the person's alerts a fault left unpublished; a bus fault never fails it.
            let x = rt(ctx, d, pool);
            let _ = publish_usage_alerts(&x, Some(user));
            usage_limits::get(pool, user, id, asset, ctx.now)
        }
        "own.usageLimits.set" => usage_limits::set(
            pool_of(d.store)?,
            user,
            id,
            &usage_limits::Wanted {
                alert_at: input.get("alertAt").as_str(),
                hard_limit: input.get("hardLimit").as_str(),
                email: flag(input, "email"),
            },
            asset,
            ctx.now,
        ),
        "own.paymentMethod.get" => payment::get(pool_of(d.store)?, wallets, user, id),
        "own.paymentMethod.set" => payment::set(
            pool_of(d.store)?,
            wallets,
            user,
            id,
            input.get("address").as_str(),
        ),
        "own.policy.get" => {
            let pool = pool_of(d.store)?;
            let agent = store::get(pool, user, id)?;
            Ok(policy::read(pool, user, &agent.id)?.to_json())
        }
        "own.policy.add" => {
            let pool = pool_of(d.store)?;
            let agent = store::get(pool, user, id)?;
            let effect = text(input, "effect");
            // An allow gives the agent more, so it waits for the lift of the owner's own freeze; a deny only narrows.
            if effect == "allow" {
                assert_not_self_frozen(user, freeze)?;
            }
            policy::add(
                pool,
                user,
                &agent.id,
                effect,
                text(input, "action"),
                text(input, "scope"),
            )?;
            Ok(policy::read(pool, user, &agent.id)?.to_json())
        }
        "own.policy.remove" => {
            let pool = pool_of(d.store)?;
            let agent = store::get(pool, user, id)?;
            policy::remove(pool, user, &agent.id, text(input, "ruleId"))?;
            Ok(policy::read(pool, user, &agent.id)?.to_json())
        }
        "own.policy.require" => {
            let pool = pool_of(d.store)?;
            let agent = store::get(pool, user, id)?;
            let required = flag(input, "rulesRequired");
            // Turning required rules off gives the agent more; turning them on only narrows.
            if !required {
                assert_not_self_frozen(user, freeze)?;
            }
            policy::set_rules_required(pool, user, &agent.id, required)?;
            Ok(policy::read(pool, user, &agent.id)?.to_json())
        }
        "own.policy.check" | "own.policy.forService" => {
            // svc-trade asks for the person it names; everyone else asks for themselves.
            let user = if ctx.call.path == "own.policy.forService" {
                text(input, "userId")
            } else {
                user
            };
            let pool = pool_of(d.store)?;
            let agent = store::get(pool, user, id)?;
            let account = text(input, "account");
            crate::own::access::assert_allows(pool, user, &agent.id, account, ctx.now)?;
            Ok(
                policy::assert_allows(pool, user, &agent.id, text(input, "action"), account)?
                    .to_json(),
            )
        }
        "own.consents.list" => {
            let pool = pool_of(d.store)?;
            let agent = store::get(pool, user, id)?;
            consents::list(pool, user, &agent.id)
        }
        "own.consents.grant" => {
            let pool = pool_of(d.store)?;
            let agent = store::get(pool, user, id)?;
            assert_not_self_frozen(user, freeze)?;
            consents::grant(pool, user, &agent.id, text(input, "dataClass"))
        }
        "own.consents.revoke" => {
            let pool = pool_of(d.store)?;
            let agent = store::get(pool, user, id)?;
            consents::revoke(pool, user, &agent.id, text(input, "dataClass"))
        }
        "own.memory.get" => {
            let pool = pool_of(d.store)?;
            let agent = store::get(pool, user, id)?;
            memory::get(pool, user, &agent.id, whole(input, "limit"))
        }
        "own.memory.clear" => {
            let pool = pool_of(d.store)?;
            let agent = store::get(pool, user, id)?;
            memory::clear(pool, user, &agent.id, text(input, "itemId"))?;
            memory::get(pool, user, &agent.id, 200)
        }
        "own.memory.setEnabled" => {
            let pool = pool_of(d.store)?;
            let agent = store::get(pool, user, id)?;
            memory::set_enabled(pool, user, &agent.id, flag(input, "enabled"))?;
            memory::get(pool, user, &agent.id, 200)
        }
        "own.privacy.get" => {
            let pool = pool_of(d.store)?;
            let agent = store::get(pool, user, id)?;
            memory::privacy(pool, user, &agent.id, &d.own.retention)
        }
        "own.privacy.keepTranscripts" => {
            let pool = pool_of(d.store)?;
            let agent = store::get(pool, user, id)?;
            memory::set_keep_transcripts(
                pool,
                user,
                &agent.id,
                flag(input, "keep"),
                &d.own.retention,
            )?;
            memory::privacy(pool, user, &agent.id, &d.own.retention)
        }
        "own.analytics" => {
            let pool = pool_of(d.store)?;
            let agent = store::get(pool, user, id)?;
            analytics(pool, user, &agent.id, flag(input, "includeTest"), asset)
        }
        "own.usage" => {
            let pool = pool_of(d.store)?;
            let agent = store::get(pool, user, id)?;
            let windows = windows_of(
                d.m,
                pool,
                user,
                &own_session_agent_id(&agent.id),
                whole(input, "limit"),
            )
            .map_err(meter_error)?;
            Ok(Json::Array(
                windows
                    .into_iter()
                    .map(|w| {
                        Json::obj([
                            ("sessionId", Json::str(w.session_id)),
                            ("windowId", Json::str(w.window_id)),
                            ("state", Json::str(w.state)),
                            (
                                "amount",
                                w.amount.map_or(Json::Null, |a| Json::str(format_amount(a))),
                            ),
                            ("chargeKey", w.charge_key.map_or(Json::Null, Json::str)),
                            ("assetId", Json::str(w.asset_id)),
                            ("openedAt", Json::str(w.opened_at)),
                        ])
                    })
                    .collect(),
            ))
        }
        "own.usageByDay" => {
            let pool = pool_of(d.store)?;
            let agents = store::list(pool, user, OWN_AGENTS_MAX)?;
            let names: Vec<String> = agents.iter().map(|a| own_session_agent_id(&a.id)).collect();
            let rows = usage_by_day(d.m, pool, user, &names).map_err(meter_error)?;
            rows.into_iter()
                .map(|row| {
                    let agent = agents
                        .iter()
                        .find(|a| own_session_agent_id(&a.id) == row.agent_id)
                        .ok_or_else(|| OwnError::Thrown("a usage row of no agent".to_owned()))?;
                    Ok(Json::obj([
                        ("agentId", Json::str(agent.id.clone())),
                        ("agentName", Json::str(agent.name.clone())),
                        ("day", Json::str(row.day)),
                        ("task", Json::str(row.task)),
                        ("amount", Json::str(format_amount(row.amount))),
                        ("windows", Json::int(i64::from(row.windows))),
                        ("assetId", Json::str(row.asset_id)),
                    ]))
                })
                .collect::<Result<Vec<_>, _>>()
                .map(Json::Array)
        }
        _ => Err(OwnError::Trpc(not_ported(Slice::OwnControls))),
    }
}

/// A metering read's failure, thrown as the TypeScript's would be.
fn meter_error(e: crate::metering::meter::MeterError) -> OwnError {
    match e {
        crate::metering::meter::MeterError::Store(s) => OwnError::from(s),
        other => OwnError::Thrown(format!("{other:?}")),
    }
}

fn rt<'a>(ctx: &Ctx<'_>, d: &'a Deps<'_>, pool: &'a service_kit::pg::Pool) -> Rt<'a> {
    Rt {
        rt: d.rt,
        pool,
        gateway: &d.gateway.gateway,
        m: d.m,
        now: ctx.now,
    }
}

/// `ownAgentAnalytics`: the agent's live runs by outcome and their cost, and its test runs when the person includes them.
fn analytics(
    pool: &service_kit::pg::Pool,
    owner_id: &str,
    agent_id: &str,
    include_test: bool,
    asset_id: &str,
) -> Result<Json, OwnError> {
    let session_agent = own_session_agent_id(agent_id);
    let (executed, refused, failed, cost, tests) = db::with_client(pool, |c| {
        let r = c.query_one(
            "SELECT count(*) FILTER (WHERE a.status = 'executed')::bigint,
                    count(*) FILTER (WHERE a.status = 'refused')::bigint,
                    count(*) FILTER (WHERE a.status = 'failed')::bigint,
                    coalesce(sum(a.cost), 0)::text
               FROM agents.agent_actions a
              WHERE a.user_id = $1::text AND a.agent_id = $2::text AND a.kind = 'completion'",
            &[&owner_id, &session_agent],
        )?;
        let tests: Option<i64> = if include_test {
            Some(
                c.query_one(
                    "SELECT count(*)::bigint FROM agents.own_agent_test_runs
                      WHERE owner_id = $1::text AND agent_id = $2::text::uuid",
                    &[&owner_id, &agent_id],
                )?
                .try_get(0)?,
            )
        } else {
            None
        };
        Ok((
            r.try_get::<_, i64>(0)?,
            r.try_get::<_, i64>(1)?,
            r.try_get::<_, i64>(2)?,
            r.try_get::<_, String>(3)?,
            tests,
        ))
    })?;
    let cost = service_kit::money::parse_amount(&cost).map_err(OwnError::Thrown)?;
    let live = executed + refused + failed;
    Ok(Json::obj([
        ("includeTest", Json::Bool(include_test)),
        ("runs", Json::int(live + tests.unwrap_or(0))),
        ("liveRuns", Json::int(live)),
        ("executed", Json::int(executed)),
        ("refused", Json::int(refused)),
        ("failed", Json::int(failed)),
        ("testRuns", tests.map_or(Json::Null, Json::int)),
        ("cost", Json::str(format_amount(cost))),
        ("assetId", Json::str(asset_id)),
    ]))
}
