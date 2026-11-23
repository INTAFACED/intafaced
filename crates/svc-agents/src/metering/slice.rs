//! The `metering` slice's seven calls, answered as the TypeScript answers them, each past the door's own checks.
//!
//! `usage.current`, `usage.summary`, `analytics.summary`, `usage.settle` and `usage.settleSession` answer through the
//! main router's guard (`toTRPCError`); `spend.limits.get` and `set` through the spend router's own.

use service_kit::json::Json;
use service_kit::money::format_amount;
use service_kit::pg::Pool;
use service_kit::schema::Value;
use service_kit::trpc::TrpcError;

use crate::db::Store;
use crate::door::Ctx;
use crate::errors::{Refusal, to_trpc};
use crate::metering::meter::{self, Settlement};
use crate::metering::{Metering, review, settle, spend};

/// The pool, or the engine's outage the TypeScript answers when its database is not there.
fn pool(store: &Store) -> Result<&Pool, Refusal> {
    store.pool().map_err(|e| Refusal::Other(e.message))
}

fn user_id<'a>(ctx: &'a Ctx<'_>) -> &'a str {
    ctx.principal.map_or("", |p| p.user_id.as_str())
}

fn text(input: &Value, key: &str) -> Option<String> {
    input.get(key).as_str().map(str::to_owned)
}

/// `ownedSession`: a session that is not there and one that is someone else's answer the same, so the call is no
/// oracle for other people's session ids.
fn owned_session(pool: &Pool, session_id: &str, user_id: &str) -> Result<(), Refusal> {
    match settle::session(pool, session_id).map_err(|e| Refusal::Other(e.to_string()))? {
        Some(s) if s.user_id == user_id => Ok(()),
        _ => Err(Refusal::Trpc(TrpcError::plain(
            "NOT_FOUND",
            "agents.refused.session_closed",
        ))),
    }
}

fn settlement(m: &Metering, s: &Settlement) -> Json {
    Json::obj([
        ("amount", Json::str(format_amount(s.amount))),
        ("assetId", Json::str(m.fee_asset_id.clone())),
        ("chargeKey", Json::str(s.charge_key.clone())),
        ("settled", Json::Bool(s.settled)),
    ])
}

/// The main router's calls, through `toTRPCError`.
fn main_router(ctx: &Ctx<'_>, store: &Store, m: &Metering) -> Result<Json, Refusal> {
    let input = &ctx.input;
    match ctx.call.path {
        "usage.current" => {
            let session_id = text(input, "sessionId").unwrap_or_default();
            let pool = pool(store)?;
            owned_session(pool, &session_id, user_id(ctx))?;
            let window_id = meter::window_for(m, ctx.now)?;
            let pending = meter::pending_cost(pool, &session_id, &window_id)?;
            let total = {
                let mut conn = pool.get().map_err(|e| Refusal::Other(e.0))?;
                let client = conn.client().map_err(|e| Refusal::Other(e.0))?;
                meter::session_spend(client, &session_id)?
            };
            Ok(Json::obj([
                ("windowId", Json::str(window_id)),
                ("pending", Json::str(format_amount(pending))),
                ("sessionTotal", Json::str(format_amount(total))),
                ("assetId", Json::str(m.fee_asset_id.clone())),
            ]))
        }
        "usage.settle" => {
            let session_id = text(input, "sessionId").unwrap_or_default();
            let window_id = text(input, "windowId").unwrap_or_default();
            let s = settle::settle_window(m, pool(store)?, &session_id, &window_id, ctx.now)?;
            Ok(settlement(m, &s))
        }
        "usage.settleSession" => {
            let session_id = text(input, "sessionId").unwrap_or_default();
            let all = settle::settle_session(m, pool(store)?, &session_id, ctx.now)?;
            Ok(Json::obj([
                ("assetId", Json::str(m.fee_asset_id.clone())),
                (
                    "settlements",
                    Json::Array(
                        all.iter()
                            .map(|s| {
                                Json::obj([
                                    ("windowId", Json::str(s.window_id.clone())),
                                    ("amount", Json::str(format_amount(s.amount))),
                                    ("chargeKey", Json::str(s.charge_key.clone())),
                                    ("settled", Json::Bool(s.settled)),
                                ])
                            })
                            .collect(),
                    ),
                ),
            ]))
        }
        "analytics.summary" => {
            let (from, to) =
                review::analytics_range(input.get("from").as_str(), input.get("to").as_str())?;
            let include_test = matches!(input.get("includeTest"), Value::Bool(true));
            review::analytics_summary(
                pool(store)?,
                user_id(ctx),
                &from,
                &to,
                include_test,
                &m.fee_asset_id,
            )
        }
        "usage.summary" => {
            #[expect(
                clippy::cast_possible_truncation,
                clippy::cast_sign_loss,
                reason = "zod held it to 1..=500"
            )]
            let limit = input.get("limit").as_number().unwrap_or(0.0) as usize;
            review::usage_summary(pool(store)?, user_id(ctx), limit, &m.fee_asset_id)
        }
        other => Err(Refusal::Other(format!("{other} is not a metering call"))),
    }
}

/// The spend router's calls, through its own guard.
fn spend_router(ctx: &Ctx<'_>, store: &Store) -> Result<Json, TrpcError> {
    let Ok(pool) = store.pool() else {
        return Err(spend::to_trpc(spend::database_unset()));
    };
    let input = &ctx.input;
    match ctx.call.path {
        "spend.limits.get" => {
            let limits = spend::get(pool, user_id(ctx)).map_err(spend::to_trpc)?;
            Ok(Json::obj([(
                "limits",
                limits.map_or(Json::Null, |l| l.to_json()),
            )]))
        }
        _ => {
            let set = spend::SetInput {
                asset_id: text(input, "assetId"),
                per_call: text(input, "perCall"),
                per_session: text(input, "perSession"),
                per_period: text(input, "perPeriod"),
                period: text(input, "period"),
                idempotency_key: text(input, "idempotencyKey"),
            };
            let (limits, replayed) =
                spend::set(pool, user_id(ctx), &set).map_err(spend::to_trpc)?;
            Ok(Json::obj([
                ("limits", limits.to_json()),
                ("replayed", Json::Bool(replayed)),
            ]))
        }
    }
}

/// One call of the slice.
pub fn handle(ctx: &Ctx<'_>, store: &Store, m: &Metering) -> Result<Option<Json>, TrpcError> {
    if ctx.call.path.starts_with("spend.") {
        return spend_router(ctx, store).map(Some);
    }
    main_router(ctx, store, m).map(Some).map_err(to_trpc)
}
