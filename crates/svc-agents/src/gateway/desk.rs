//! The gateway slice's calls (`router.ts` `routes`, `gateway/route-changes.ts` `routeDeskProcedures`): `routes.list`,
//! the tasks this deployment serves with their ceilings and rates, and the founders' desk over the same table
//! (`routes.desk`, `routes.propose`, `routes.withdraw`, `routes.confirm`; J-agents-20).
//!
//! The door has already run every check before the handler: the scope, the region, a service refused for the person's
//! call, a key or a sub-account refused `agents.route_change_person_only`, and the input. The desk needs the database:
//! without one it refuses `agents.capability_unavailable`, as the TypeScript does with no route store.

use std::sync::Arc;

use service_kit::json::Json;
use service_kit::schema::Value;
use service_kit::time::Instant;
use service_kit::trpc::TrpcError;

use super::Gateway;
use super::changes::{self, ChangeInput, ChangeStore, DeskError, RouteOverride};
use super::routing::{Price, Route};
use crate::db::{Store, StoreError, with_client};
use crate::door::Ctx;

/// What the gateway slice is built from, once, at start-up.
pub struct GatewaySlice {
    pub gateway: Arc<Gateway>,
    /// `AGENTS_FEE_ASSET_ID`.
    pub fee_asset_id: String,
    /// `AGENTS_METERING_ENABLED`; `None` is treated as billed.
    pub metering_enabled: Option<bool>,
    /// `AGENTS_USAGE_WINDOW_MINUTES`: a confirmed rate starts at the next window.
    pub window_minutes: i64,
}

/// The desk's `guard`: a refusal answers its own code as the message and the cause; anything else is the database's.
fn desk_error(e: DeskError) -> TrpcError {
    match e {
        DeskError::Refused(code) => TrpcError::caused(changes::status_of(code), code, code),
        DeskError::Store(e) => store_error(e),
    }
}

/// An error thrown past every guard: tRPC answers it as an internal error with its message and its code.
fn store_error(e: StoreError) -> TrpcError {
    TrpcError {
        code: "INTERNAL_SERVER_ERROR",
        message: e.message,
        intafaced_code: None,
        cause: e.code,
        preview: None,
    }
}

fn rate_json(price: Option<&Price>) -> (Json, Json) {
    match price {
        Some(p) => (
            Json::str(service_kit::money::format_amount(p.input_per_million)),
            Json::str(service_kit::money::format_amount(p.output_per_million)),
        ),
        None => (Json::Null, Json::Null),
    }
}

impl GatewaySlice {
    /// No provider and an empty routing table, as the wire replay builds the TypeScript router's gateway.
    pub fn unwired(fee_asset_id: &str) -> GatewaySlice {
        GatewaySlice {
            gateway: Arc::new(Gateway::new(
                Vec::new(),
                super::routing::RoutingTable::default(),
            )),
            fee_asset_id: fee_asset_id.to_owned(),
            metering_enabled: None,
            window_minutes: 15,
        }
    }

    /// Reads `route_overrides` again and lays them over the configured table (`RouteTableSync.refresh`).
    pub fn refresh(&self, store: &Store) -> Result<Vec<RouteOverride>, StoreError> {
        let overrides = with_client(store.pool()?, changes::read_overrides)?;
        self.gateway.set_overrides(overrides.clone());
        Ok(overrides)
    }

    fn engine(&self, route: &Route) -> (Json, Json) {
        let (engine, metered) = self.gateway.route_engine(route, self.metering_enabled);
        (Json::str(engine.name()), Json::Bool(metered))
    }

    /// Answers one call of the slice.
    pub fn handle(&self, store: &Store, ctx: &Ctx<'_>) -> Result<Option<Json>, TrpcError> {
        let user = ctx.principal.map_or("", |p| p.user_id.as_str());
        match ctx.call.path {
            "routes.list" => Ok(Some(self.list(ctx.now))),
            "routes.desk" => self.desk(store, ctx.now).map(Some).map_err(desk_error),
            "routes.propose" => {
                let input = &ctx.input;
                let rate = |k: &str| input.get(k).as_str().map(str::to_owned);
                let change = ChangeInput {
                    task: input.get("task").as_str().unwrap_or("").to_owned(),
                    max_output_tokens: whole(input.get("maxOutputTokens")),
                    input_per_million: rate("inputPerMillion"),
                    output_per_million: rate("outputPerMillion"),
                };
                let request_id = input.get("requestId").as_str().unwrap_or("");
                self.store(store, ctx.now)
                    .and_then(|s| s.propose(user, &change, request_id))
                    .map(|v| Some(v.json()))
                    .map_err(desk_error)
            }
            "routes.withdraw" => {
                let id = ctx.input.get("changeId").as_str().unwrap_or("");
                self.store(store, ctx.now)
                    .and_then(|s| s.withdraw(user, id))
                    .map(|v| Some(v.json()))
                    .map_err(desk_error)
            }
            "routes.confirm" => {
                let id = ctx.input.get("changeId").as_str().unwrap_or("");
                let view = self
                    .store(store, ctx.now)
                    .and_then(|s| s.confirm(user, id))
                    .map_err(desk_error)?;
                self.refresh(store).map_err(store_error)?;
                Ok(Some(view.json()))
            }
            other => Err(TrpcError::plain(
                "INTERNAL_SERVER_ERROR",
                format!("svc-agents in Rust: {other} is not a gateway call"),
            )),
        }
    }

    /// `ready()`: the desk's store, or `agents.capability_unavailable` without a database.
    fn store<'a>(&'a self, store: &'a Store, now: Instant) -> Result<ChangeStore<'a>, DeskError> {
        let pool = store
            .pool()
            .map_err(|_| DeskError::Refused("agents.capability_unavailable"))?;
        Ok(ChangeStore {
            pool,
            base: self.gateway.base(),
            window_minutes: self.window_minutes,
            now,
        })
    }

    /// `routes.list`.
    pub fn list(&self, now: Instant) -> Json {
        let table = self.gateway.routing_table(now);
        Json::Array(
            table
                .routes
                .iter()
                .map(|route| {
                    let (i, o) = rate_json(route.price.as_ref());
                    let (engine, metered) = self.engine(route);
                    Json::obj([
                        ("task", Json::str(route.task.clone())),
                        ("maxOutputTokens", Json::int(route.max_output_tokens)),
                        ("capability", Json::str(route.capability.name())),
                        ("inputPerMillion", i),
                        ("outputPerMillion", o),
                        ("assetId", Json::str(self.fee_asset_id.clone())),
                        ("engine", engine),
                        ("metered", metered),
                    ])
                })
                .collect(),
        )
    }

    /// `routes.desk`: each task with its provider and model alias (configuration's), its ceiling and rates in force now,
    /// a rate that takes effect at the next window, the change waiting for a second founder, the last change two
    /// founders made, and the newest audit rows. Read fresh, so the desk never shows a table this replica has not caught
    /// up with.
    fn desk(&self, store: &Store, now: Instant) -> Result<Json, DeskError> {
        let pool = self.store(store, now)?.pool;
        let overrides = self.refresh(store)?;
        let desk = with_client(pool, changes::read_desk)?;
        let table = self.gateway.routing_table(now);
        let routes = table
            .routes
            .iter()
            .map(|route| {
                let next = overrides
                    .iter()
                    .find(|o| o.task == route.task && o.price_from.0 > now.0);
                let (i, o) = rate_json(route.price.as_ref());
                let (engine, metered) = self.engine(route);
                let next_rate = next.map_or(Json::Null, |n| {
                    let (ni, no) = rate_json(n.price.as_ref());
                    Json::obj([
                        ("inputPerMillion", ni),
                        ("outputPerMillion", no),
                        ("from", Json::str(n.price_from.iso())),
                    ])
                });
                let of = |list: &[changes::ChangeView]| {
                    list.iter()
                        .find(|c| c.task == route.task)
                        .map_or(Json::Null, changes::ChangeView::json)
                };
                Json::obj([
                    ("task", Json::str(route.task.clone())),
                    ("capability", Json::str(route.capability.name())),
                    ("providerId", Json::str(route.provider_id.clone())),
                    ("model", Json::str(route.model.clone())),
                    ("providerSource", Json::str("configuration")),
                    ("maxOutputTokens", Json::int(route.max_output_tokens)),
                    ("inputPerMillion", i),
                    ("outputPerMillion", o),
                    ("nextRate", next_rate),
                    ("assetId", Json::str(self.fee_asset_id.clone())),
                    ("engine", engine),
                    ("metered", metered),
                    ("pending", of(&desk.pending)),
                    ("lastChange", of(&desk.applied)),
                ])
            })
            .collect();
        Ok(Json::obj([
            ("routes", Json::Array(routes)),
            (
                "audit",
                Json::Array(desk.audit.iter().map(changes::AuditView::json).collect()),
            ),
        ]))
    }
}

/// `z.number().int()` has passed: the value is a whole number.
fn whole(v: &Value) -> i64 {
    match v.as_number() {
        #[expect(
            clippy::cast_possible_truncation,
            reason = "zod's int check passed: a whole number; one past i64 saturates and is refused as out of range"
        )]
        Some(n) => n as i64,
        None => 0,
    }
}
