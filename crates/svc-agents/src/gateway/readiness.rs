//! Honest readiness (`services/svc-agents/src/readiness.ts`, `/ready` in `index.ts`): process ready stays true once
//! boot succeeded, and the body says what an operator must not misread: the mock is not production inference,
//! `usefulPath.available` is whether a completion can leave the process now, metering off is audit-only, and a fleet
//! URL pinned is not an upstream store live. No vendor is named.

use std::collections::BTreeMap;

use service_kit::json::Json;
use service_kit::time::Instant;

use super::Gateway;
use super::providers::{is_usable, supports};
use super::routing::{Capability, default_table};
use crate::boot::BootAgent;

/// `FLEET_PRODUCT_AGENTS` (`fleet/matrix.ts`): the five product agents with a guardrail factory, each with a metered
/// `runSession` mounted and registered at boot.
pub const FLEET_PRODUCT_AGENTS: [&str; 5] =
    ["navigator", "support", "scanner", "merchant", "copy-intel"];

/// `fleetMatrixBoardCard`: the product agents, their mounts, and the tasks their guardrails allow that the default
/// routing table has no route for.
pub fn fleet_card(boot: &[BootAgent]) -> Json {
    let routes = default_table();
    let mut allowed: Vec<String> = boot
        .iter()
        .filter(|a| FLEET_PRODUCT_AGENTS.contains(&a.agent_id.as_str()))
        .flat_map(|a| {
            match a
                .guardrail
                .get("limits")
                .and_then(|l| l.get("allowedTasks"))
            {
                Some(Json::Array(tasks)) => tasks
                    .iter()
                    .filter_map(|t| match t {
                        Json::String(s) => Some(s.clone()),
                        _ => None,
                    })
                    .collect(),
                _ => Vec::new(),
            }
        })
        .collect();
    allowed.sort_unstable();
    allowed.dedup();
    let missing = allowed
        .iter()
        .filter(|t| !routes.routes.iter().any(|r| &r.task == *t))
        .count();
    let n = i64::try_from(FLEET_PRODUCT_AGENTS.len()).unwrap_or(0);
    Json::obj([
        ("agents", Json::int(n)),
        ("withRunSession", Json::int(n)),
        ("bootRegistered", Json::int(n)),
        (
            "tasksMissingRoute",
            Json::int(i64::try_from(missing).unwrap_or(0)),
        ),
    ])
}

/// How many product agents the boot wrote (`bootAgents.count`): the fleet's, not the Coach or the catalogue's.
pub fn product_agents_registered(registered: &[String]) -> i64 {
    let n = registered
        .iter()
        .filter(|id| FLEET_PRODUCT_AGENTS.contains(&id.as_str()))
        .count();
    i64::try_from(n).unwrap_or(0)
}

fn configured(env: &BTreeMap<String, String>, key: &str) -> bool {
    env.get(key)
        .is_some_and(|v| !service_kit::money::js_trim(v).is_empty())
}

/// `describeAgentsLivePlanes(process.env)`.
pub fn live_planes(env: &BTreeMap<String, String>) -> Json {
    let trimmed = |k: &str| {
        env.get(k)
            .map(|v| service_kit::money::js_trim(v).to_owned())
    };
    let leaders = trimmed("LIVE_TRADE_COPY_LEADER_IDS")
        .filter(|v| !v.is_empty())
        .map_or(0, |raw| {
            raw.split(',')
                .filter(|id| !service_kit::money::js_trim(id).is_empty())
                .count()
        });
    Json::obj([
        (
            "tradeUrlConfigured",
            Json::Bool(configured(env, "TRADE_URL")),
        ),
        ("payUrlConfigured", Json::Bool(configured(env, "PAY_URL"))),
        (
            "supportUrlConfigured",
            Json::Bool(configured(env, "SUPPORT_URL")),
        ),
        (
            "identityUrlConfigured",
            Json::Bool(configured(env, "IDENTITY_URL")),
        ),
        (
            "academyUrlConfigured",
            Json::Bool(configured(env, "ACADEMY_URL")),
        ),
        (
            "copyLeaderPlaneOpenConfigured",
            Json::Bool(trimmed("LIVE_TRADE_COPY_LEADER_PLANE_OPEN").as_deref() == Some("true")),
        ),
        (
            "copyLeaderAllowlistCount",
            Json::int(i64::try_from(leaders).unwrap_or(0)),
        ),
        ("storesMayStillRefuse", Json::Bool(true)),
    ])
}

/// What `/ready` is built from, besides the gateway.
#[derive(Debug, Clone, PartialEq)]
pub struct ReadyInput {
    /// `AGENTS_PROVIDER`: `mock` or `upstream`.
    pub provider_mode: String,
    pub metering_enabled: bool,
    pub product_agents_registered: i64,
    pub fleet: Json,
    pub live_planes: Json,
}

impl ReadyInput {
    /// The mock, metering off, no product agents and no fleet or live-plane cards.
    pub fn unwired() -> ReadyInput {
        ReadyInput {
            provider_mode: "mock".to_owned(),
            metering_enabled: false,
            product_agents_registered: 0,
            fleet: Json::Null,
            live_planes: Json::Null,
        }
    }
}

/// `agentsReadiness`.
pub fn readiness(gateway: &Gateway, input: &ReadyInput, now: Instant) -> Json {
    let providers = gateway
        .providers()
        .iter()
        .map(|p| {
            let health = p.health(now);
            Json::obj([
                ("id", Json::str(p.id())),
                ("usable", Json::Bool(is_usable(p.as_ref(), now))),
                ("healthy", Json::Bool(health.healthy)),
                ("reason", health.reason.map_or(Json::Null, Json::String)),
                (
                    "capabilities",
                    Json::Array(
                        p.capabilities()
                            .iter()
                            .map(|c| Json::str(c.name()))
                            .collect(),
                    ),
                ),
            ])
        })
        .collect();
    let table = gateway.routing_table(now);
    let mut useful: Option<String> = None;
    let mut residual: Option<String> = None;
    for route in table
        .routes
        .iter()
        .filter(|r| r.capability == Capability::Complete)
    {
        let Some(provider) = gateway.registered(&route.provider_id) else {
            residual.get_or_insert_with(|| {
                format!(
                    "route \"{}\" names provider \"{}\", which is not registered",
                    route.task, route.provider_id
                )
            });
            continue;
        };
        if !supports(provider.as_ref(), Capability::Complete) {
            residual.get_or_insert_with(|| {
                format!(
                    "provider \"{}\" does not declare complete for task \"{}\"",
                    provider.id(),
                    route.task
                )
            });
            continue;
        }
        if !is_usable(provider.as_ref(), now) {
            residual.get_or_insert_with(|| {
                format!(
                    "provider \"{}\" is not usable: {}",
                    provider.id(),
                    provider
                        .health(now)
                        .reason
                        .unwrap_or_else(|| "unhealthy or stale".to_owned())
                )
            });
            continue;
        }
        useful = Some(route.task.clone());
        break;
    }
    if useful.is_none() && residual.is_none() {
        residual = Some(if table.routes.is_empty() {
            "no routes configured".to_owned()
        } else {
            "no completion route is currently servable".to_owned()
        });
    }
    if useful.is_some() {
        residual = (input.provider_mode == "mock").then(|| {
            if input.product_agents_registered > 0 {
                format!(
                    "engine is the deterministic mock — not production inference; {} product agent(s) registered at boot",
                    input.product_agents_registered
                )
            } else {
                "engine is the deterministic mock — not production inference; product agents are not registered by this service".to_owned()
            }
        });
    }
    let metering = input.metering_enabled;
    Json::obj([
        ("ready", Json::Bool(true)),
        ("providerMode", Json::str(input.provider_mode.clone())),
        ("providers", Json::Array(providers)),
        ("meteringEnabled", Json::Bool(metering)),
        (
            "meteringMode",
            Json::str(if metering { "billed" } else { "audit_only" }),
        ),
        ("meteringAllowsFeeCharge", Json::Bool(metering)),
        (
            "tasks",
            Json::Array(
                table
                    .routes
                    .iter()
                    .map(|r| Json::str(r.task.clone()))
                    .collect(),
            ),
        ),
        (
            "productAgentsRegistered",
            Json::int(input.product_agents_registered),
        ),
        ("fleet", input.fleet.clone()),
        ("livePlanes", input.live_planes.clone()),
        (
            "usefulPath",
            Json::obj([
                ("available", Json::Bool(useful.is_some())),
                ("task", useful.map_or(Json::Null, Json::String)),
                ("residual", residual.map_or(Json::Null, Json::String)),
            ]),
        ),
    ])
}
