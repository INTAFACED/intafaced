//! The model gateway (`services/svc-agents/src/gateway/`, `providers/`, `readiness.ts`): a task in, its route
//! resolved, its provider found, capability and health checked, the provider called. It does not meter, audit or know
//! what an agent is; the runtime composes those on top.
//!
//! The gateway is the one owner of the routing table: the configured table (`AGENTS_ROUTING_TABLE`, or the default
//! with every rate blank) and the founders' confirmed changes over it (`changes`), read from `route_overrides` at boot,
//! after each confirm, on the desk's read and every 30 s. The table in force is computed at the moment it is asked
//! for, so a rate confirmed for the next usage window takes effect at that window's first instant.

pub mod changes;
pub mod desk;
pub mod providers;
pub mod readiness;
pub mod routing;

use std::sync::{Arc, RwLock};

use sha2::{Digest, Sha256};

use service_kit::json::Json;
use service_kit::time::Instant;

use crate::errors::AgentError;
use changes::{RouteOverride, with_overrides};
use providers::{
    ChatMessage, CompletionRequest, CompletionResult, EmbedRequest, EmbedResult, Failure, Provider,
    UNPROBED, is_usable, supports,
};
use routing::{Engine, Route, RoutingTable, resolve_route, route_is_metered};

/// What a caller asks a task for; the model and the ceiling come from the route.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct TaskRequest {
    pub system: Option<String>,
    pub messages: Vec<ChatMessage>,
    /// Can only tighten the route's ceiling, never loosen it.
    pub max_output_tokens: Option<i64>,
    pub temperature: Option<f64>,
    pub stop_sequences: Option<Vec<String>>,
}

/// One completion and the route it ran on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GatewayCompletion {
    pub route: Route,
    pub result: CompletionResult,
}

#[derive(Debug, Clone, PartialEq)]
pub struct GatewayEmbedding {
    pub route: Route,
    pub result: EmbedResult,
}

/// `ModelGateway`, holding the routing table.
pub struct Gateway {
    providers: Vec<Arc<dyn Provider>>,
    /// The configured table: provider and model aliases are only ever its.
    base: RoutingTable,
    /// The founders' confirmed changes, as last read.
    overrides: RwLock<Vec<RouteOverride>>,
}

/// The engine error codes the gateway answers with, all declared in `errors.ts`.
pub const CODES: [&str; 4] = [
    "agents.route_not_found",
    "agents.capability_unavailable",
    "agents.provider_unavailable",
    "agents.provider_failed",
];

fn engine_unavailable(code: &'static str, message: String) -> AgentError {
    AgentError::declared(code, "agents.error.engine_unavailable", message)
}

impl Gateway {
    pub fn new(providers: Vec<Arc<dyn Provider>>, base: RoutingTable) -> Gateway {
        Gateway {
            providers,
            base,
            overrides: RwLock::new(Vec::new()),
        }
    }

    /// The configured table, before any founder's change.
    pub fn base(&self) -> &RoutingTable {
        &self.base
    }

    pub fn providers(&self) -> &[Arc<dyn Provider>] {
        &self.providers
    }

    /// Lays a fresh read of `route_overrides` over the configured table.
    pub fn set_overrides(&self, overrides: Vec<RouteOverride>) {
        *self
            .overrides
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = overrides;
    }

    /// `gateway.routingTable`: the table in force at `now`.
    pub fn routing_table(&self, now: Instant) -> RoutingTable {
        let overrides = self
            .overrides
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        with_overrides(&self.base, &overrides, now)
    }

    /// `registeredProvider`: the adapter under this id, if any.
    pub fn registered(&self, provider_id: &str) -> Option<&Arc<dyn Provider>> {
        self.providers.iter().find(|p| p.id() == provider_id)
    }

    /// The router's `routeEngine`: the engine the route's adapter is, and whether the route would be billed.
    pub fn route_engine(&self, route: &Route, metering_enabled: Option<bool>) -> (Engine, bool) {
        let engine = self
            .registered(&route.provider_id)
            .map_or(Engine::Unknown, |p| p.engine());
        (
            engine,
            route_is_metered(metering_enabled, route.price.as_ref()),
        )
    }

    /// `providerFor`: the route's provider, proven able to serve it before any request is built.
    pub fn provider_for(
        &self,
        route: &Route,
        now: Instant,
    ) -> Result<&Arc<dyn Provider>, AgentError> {
        let Some(provider) = self.registered(&route.provider_id) else {
            return Err(AgentError::declared(
                "agents.route_not_found",
                "agents.error.route_not_found",
                format!(
                    "Route \"{}\" names provider \"{}\", which is not registered",
                    route.task, route.provider_id
                ),
            ));
        };
        if !supports(provider.as_ref(), route.capability) {
            return Err(AgentError::declared(
                "agents.capability_unavailable",
                "agents.error.capability_unavailable",
                format!(
                    "Provider \"{}\" does not support capability \"{}\" required by task \"{}\"",
                    provider.id(),
                    route.capability.name(),
                    route.task
                ),
            ));
        }
        if !is_usable(provider.as_ref(), now) {
            let health = provider.health(now);
            // Unprobed is not an outage: the next call is the probe. A stale but healthy engine is called too.
            if !health.healthy && health.reason.as_deref() != Some(UNPROBED) {
                return Err(engine_unavailable(
                    "agents.provider_unavailable",
                    format!(
                        "Provider \"{}\" is not currently usable: {}",
                        provider.id(),
                        health.reason.as_deref().unwrap_or("unhealthy or stale")
                    ),
                ));
            }
        }
        Ok(provider)
    }

    /// `complete(task, request)`.
    pub fn complete(
        &self,
        task: &str,
        request: &TaskRequest,
        now: Instant,
    ) -> Result<GatewayCompletion, AgentError> {
        let table = self.routing_table(now);
        let route = resolve_route(&table, task)?.clone();
        let provider = self.provider_for(&route, now)?;
        let completion = build_request(&route, request);
        let result = provider
            .complete(&completion)
            .map_err(|f| rethrow(provider.id(), f))?;
        Ok(GatewayCompletion { route, result })
    }

    /// `embed(task, inputs)`.
    pub fn embed(
        &self,
        task: &str,
        inputs: &[String],
        now: Instant,
    ) -> Result<GatewayEmbedding, AgentError> {
        let table = self.routing_table(now);
        let route = resolve_route(&table, task)?.clone();
        let provider = self.provider_for(&route, now)?;
        let request = EmbedRequest {
            model: route.model.clone(),
            inputs: inputs.to_vec(),
        };
        match provider.embed(&request) {
            None => Err(AgentError::declared(
                "agents.capability_unavailable",
                "agents.error.capability_unavailable",
                format!(
                    "Provider \"{}\" declared the embed capability but does not implement it",
                    provider.id()
                ),
            )),
            Some(out) => out
                .map(|result| GatewayEmbedding { route, result })
                .map_err(|f| rethrow(provider.id(), f)),
        }
    }
}

/// `rethrowAsAgentError`: an engine's failure, re-shaped once at the gateway; the copy key is decided here.
fn rethrow(provider_id: &str, failure: Failure) -> AgentError {
    match failure {
        Failure::Provider(e) => engine_unavailable(
            if e.retryable {
                "agents.provider_unavailable"
            } else {
                "agents.provider_failed"
            },
            format!("Provider \"{provider_id}\" failed: {}", e.message),
        ),
        Failure::Unexpected => engine_unavailable(
            "agents.provider_failed",
            format!("Provider \"{provider_id}\" failed unexpectedly"),
        ),
    }
}

/// `buildRequest`: the route's ceiling is a maximum; asking for more is clamped, not refused.
pub fn build_request(route: &Route, request: &TaskRequest) -> CompletionRequest {
    CompletionRequest {
        model: route.model.clone(),
        system: request.system.clone().filter(|s| !s.is_empty()),
        messages: request.messages.clone(),
        max_output_tokens: request
            .max_output_tokens
            .map_or(route.max_output_tokens, |m| m.min(route.max_output_tokens)),
        temperature: request.temperature,
        stop_sequences: request.stop_sequences.clone(),
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// `digestOf`: SHA-256 over the canonical request, so a trace and an audit row can be matched without the prompt.
pub fn digest_of(request: &CompletionRequest) -> String {
    let canonical = Json::obj([
        ("model", Json::str(request.model.clone())),
        (
            "system",
            request.system.clone().map_or(Json::Null, Json::String),
        ),
        (
            "messages",
            Json::Array(
                request
                    .messages
                    .iter()
                    .map(|m| {
                        Json::Array(vec![Json::str(m.role.name()), Json::str(m.content.clone())])
                    })
                    .collect(),
            ),
        ),
        ("maxOutputTokens", Json::int(request.max_output_tokens)),
    ]);
    hex(&Sha256::digest(canonical.compact().as_bytes()))
}

/// `digestOfText`.
pub fn digest_of_text(text: &str) -> String {
    hex(&Sha256::digest(text.as_bytes()))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test: a failure is the point")]
    use super::*;
    use crate::errors_table;

    #[test]
    fn every_code_the_gateway_answers_is_declared_in_errors_ts() {
        for code in CODES {
            assert!(
                errors_table::CODES.iter().any(|(c, _)| *c == code),
                "{code}"
            );
        }
    }
}
