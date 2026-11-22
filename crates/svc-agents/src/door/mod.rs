//! svc-agents' door, as the TypeScript service serves it (`services/svc-agents/src/router.ts` through the Fastify
//! adapter): tRPC over HTTP at `/trpc/<path>`, with the router's guards and the contracts' error formatter.
//!
//! The order of the checks is the TypeScript's, middleware by middleware:
//!
//! 1. the call is found and its method checked;
//! 2. who may call: a scoped call needs a signed-in caller (`protectedProcedure`), then `scopedProcedure`'s guards in
//!    their order (a service on the request refused for a person's call, a key or a sub-account on a person-only call
//!    refused with the call's own code, the scope with its interactive-only and
//!    two-factor rules, the region for the `agents` module); a service call needs a verified service, one the call
//!    lists (`serviceProcedureFor`) or svc-agents itself (`requireSettleService`);
//! 3. the call's own middleware before its input: a person-only check (a key or a sub-account refused with the call's
//!    own code), or the Coach run's three checks;
//! 4. the input, read only now and checked by the call's zod schema;
//! 5. the person checks the handler runs first (`assertPersonSetsLimits` and its kin): a key, a sub-account or a
//!    session without `identity:write` refused as no signed-in user session;
//! 6. then the call's slice answers.
//!
//! Every call is in [`calls::CALLS`], generated from the TypeScript router by running its middlewares on probe callers
//! (`scripts/record-door.mjs`). `tests/wire_replay.rs` holds the door to the TypeScript's recorded answers.

pub mod calls;
pub mod inputs;

use std::collections::BTreeMap;

use service_kit::access::{self, Jurisdiction};
use service_kit::edge::{self, EdgeKey, MIN_SECRET_LENGTH, Principal};
use service_kit::json::Json;
use service_kit::s2s::Mode;
use service_kit::s2s_verify::{self, BodyBind, Incoming, ServiceVerifier};
use service_kit::schema::Value;
use service_kit::server::{Door, Request, RequestIds, Response};
use service_kit::time::Instant;
use service_kit::trpc::{self, TrpcError};

use crate::advisors::Advisors;
use crate::db::Store;
use crate::gateway::desk::GatewaySlice;
use crate::gateway::readiness::{self, ReadyInput};
use crate::metering::Metering;
use crate::ops::Ops;
use crate::own::Own;
use crate::runtime::Runtime;
use crate::team::Team;

/// A query answers GET, a mutation POST.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Query,
    Mutation,
}

/// `scopedProcedure(scope, { module: 'agents', person })`'s guards.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Scoped {
    pub scope: &'static str,
    /// `person: true`: a service calling with a person's principal is refused.
    pub person: bool,
    /// `module: 'agents'`: the region is checked.
    pub module: bool,
}

/// Who may call.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Access {
    /// `publicProcedure`: anyone.
    Public,
    /// `requireSettleService`: svc-agents itself, by its service credentials.
    Settle,
    /// `serviceProcedureFor(callers)`.
    Service(&'static [&'static str]),
    /// A signed-in caller with the scope.
    Scope(Scoped),
}

/// The call's own middleware before its input.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pre {
    None,
    /// A key (`kid`) or a sub-account is refused with this code (`executeProcedure`, `personReadProcedure`, ...).
    PersonOnly(&'static str),
    /// `coachRunProcedure`: `agents:execute` held, then its scope rules, then never a key or a sub-account.
    CoachRun,
}

/// The person checks the handler runs first, once the input passed: each refuses as no signed-in user session.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Post {
    pub key: bool,
    pub sub_account: bool,
    pub lacks_identity_write: bool,
}

/// Which slice of the port owns a call's handler (`PORT.md`, `## Slices`). `Door` is answered here (`health`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Slice {
    Door,
    Gateway,
    Runtime,
    Metering,
    Background,
    Navigator,
    Factories,
    Advisors,
    Ops,
    Team,
    OwnBuilder,
    OwnRuns,
    OwnControls,
    OwnSharing,
    Webhooks,
}

impl Slice {
    pub const ALL: [Slice; 15] = [
        Slice::Door,
        Slice::Gateway,
        Slice::Runtime,
        Slice::Metering,
        Slice::Background,
        Slice::Navigator,
        Slice::Factories,
        Slice::Advisors,
        Slice::Ops,
        Slice::Team,
        Slice::OwnBuilder,
        Slice::OwnRuns,
        Slice::OwnControls,
        Slice::OwnSharing,
        Slice::Webhooks,
    ];

    /// The slice's name in `PORT.md`.
    pub fn name(self) -> &'static str {
        match self {
            Slice::Door => "door",
            Slice::Gateway => "gateway",
            Slice::Runtime => "runtime",
            Slice::Metering => "metering",
            Slice::Background => "background",
            Slice::Navigator => "navigator",
            Slice::Factories => "factories",
            Slice::Advisors => "advisors",
            Slice::Ops => "ops",
            Slice::Team => "team",
            Slice::OwnBuilder => "own-builder",
            Slice::OwnRuns => "own-runs",
            Slice::OwnControls => "own-controls",
            Slice::OwnSharing => "own-sharing",
            Slice::Webhooks => "webhooks",
        }
    }
}

/// One call of the router.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Call {
    pub path: &'static str,
    pub kind: Kind,
    pub access: Access,
    pub pre: Pre,
    pub post: Post,
    pub slice: Slice,
    pub has_input: bool,
}

/// The call at `path`.
pub fn call(path: &str) -> Option<&'static Call> {
    calls::CALLS.iter().find(|c| c.path == path)
}

/// Each call's path, kind and caller, sorted by path: what `procedureCallers` reports for the TypeScript router.
pub fn callers() -> Vec<(&'static str, &'static str, &'static str)> {
    let mut out: Vec<_> = calls::CALLS
        .iter()
        .map(|c| {
            let kind = match c.kind {
                Kind::Query => "query",
                Kind::Mutation => "mutation",
            };
            let caller = match c.access {
                Access::Public | Access::Settle => "public",
                Access::Service(_) => "service",
                Access::Scope(_) => "scope",
            };
            (c.path, kind, caller)
        })
        .collect();
    out.sort_unstable();
    out
}

/// What a slice's handler sees once the door's checks passed.
pub struct Ctx<'a> {
    pub call: &'static Call,
    /// The input as the call's schema returned it (defaults filled, unknown keys stripped); `Undefined` when absent.
    pub input: Value,
    /// `ctx.principal`: none for a public or a service call made without one.
    pub principal: Option<&'a Principal>,
    /// `ctx.service`: the verified calling service, if any.
    pub service: Option<&'a str>,
    pub region: &'a str,
    pub now: Instant,
    /// `forwardedPrincipalHeaders(ctx)`: the edge-signed principal, byte for byte, its signature and its region, for a
    /// call made while acting for this person; empty without a verified principal.
    pub forwarded: Vec<(String, String)>,
}

/// The answer of a call whose slice is not ported yet: the door's checks passed, and nothing past them is served.
pub fn not_ported(slice: Slice) -> TrpcError {
    TrpcError::plain(
        "INTERNAL_SERVER_ERROR",
        format!(
            "svc-agents in Rust: the {} slice is not ported",
            slice.name()
        ),
    )
}

/// How the door judges a service on the request: `createEdgeContext` with the shared secret and, when on, the
/// per-service keys. The tRPC door binds the body (`EDGE_CONTEXT_BODY_BIND_MODE`, `require`).
pub struct ServiceAuth {
    /// `INTERNAL_SERVICE_SECRET`, when it is at least 32 characters (`buildEdgeContext` passes no shorter one).
    pub secret: Option<String>,
    /// The verifier `s2sFromEnv` builds and `S2S_AUTH_MODE`, when the mode is not `off`.
    pub keys: Option<(ServiceVerifier, Mode)>,
}

impl ServiceAuth {
    /// No secret and no keys: no request carries a service.
    pub fn unwired() -> ServiceAuth {
        ServiceAuth {
            secret: None,
            keys: None,
        }
    }

    /// `ctx.service` for one request at `now` (seconds).
    fn service(&self, req: &Request<'_>, now: i64) -> Option<String> {
        let incoming = Incoming {
            method: req.method,
            url: req.url,
            headers: req.headers,
            body: Some(req.body.as_bytes()),
        };
        match &self.keys {
            Some((v, mode)) => {
                s2s_verify::verify_request(
                    &incoming,
                    Some(v),
                    self.secret.as_deref(),
                    *mode,
                    BodyBind::Require,
                    now,
                )
                .service
            }
            None => self
                .secret
                .as_deref()
                .and_then(|s| s2s_verify::verify_legacy(&incoming, s, BodyBind::Require, now).ok()),
        }
    }
}

/// What the door is built from, once, at start-up.
pub struct DoorConfig {
    /// `EDGE_PRINCIPAL_SECRET`: at least 32 characters.
    pub edge_secret: String,
    pub services: ServiceAuth,
    /// The process environment: the jurisdiction check's switches and lists, and `NODE_ENV`.
    pub env: BTreeMap<String, String>,
    /// The clock.
    pub now: fn() -> Instant,
    /// The `agents` schema, opened once by the binary (`db::open`).
    pub store: Store,
    /// The gateway slice: the routing table, the providers and the founders' desk.
    pub gateway: GatewaySlice,
    /// What `/ready` reports besides the gateway.
    pub ready: ReadyInput,
    /// The meter, its settings and what it asks outside the process (`metering`).
    pub metering: Metering,
    /// The runtime's own settings: the spend gate, the funds, the transcript and the grace (`runtime`).
    pub runtime: Runtime,
    /// The operator desks' owner values: the log's reasons, limit and retention, the registry's page, the baseline.
    pub ops: Ops,
    /// The owner's values for a session's background runs (`background`).
    pub background: crate::background::Settings,
    /// The advisors' curriculum, holdings, prices and switches (`advisors`).
    pub advisors: Advisors,
    /// The own agents' templates and owner values (`own-builder`).
    pub own: Own,
    pub team: Team,
}

pub struct AgentsDoor {
    secret: String,
    services: ServiceAuth,
    jurisdiction: Jurisdiction,
    /// tRPC sends a stack trace in every error outside production.
    dev: bool,
    now: fn() -> Instant,
    requests: RequestIds,
    edge_key: Option<EdgeKey>,
    store: Store,
    gateway: GatewaySlice,
    ready: ReadyInput,
    metering: Metering,
    runtime: Runtime,
    ops: Ops,
    background: crate::background::Settings,
    advisors: Advisors,
    own: Own,
    team: Team,
}

/// The system clock.
pub fn system_now() -> Instant {
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX));
    Instant(ms)
}

const SESSION_REQUIRED: &str = "A signed-in user session is required";

fn forbidden(message: &str) -> TrpcError {
    TrpcError::plain("FORBIDDEN", message)
}

/// A key or a sub-account: not the person.
fn delegated(p: &Principal) -> bool {
    p.kid.is_some() || p.sub_account.is_some()
}

impl AgentsDoor {
    /// Refuses to start without a strong edge secret or with a malformed jurisdiction list, as the TypeScript does.
    pub fn new(config: DoorConfig) -> Result<AgentsDoor, String> {
        if config.edge_secret.chars().count() < MIN_SECRET_LENGTH {
            return Err(format!(
                "svc-agents: EDGE_PRINCIPAL_SECRET must be at least {MIN_SECRET_LENGTH} characters to mount /trpc. \
                 Without it the principal header is caller-controlled and every scope check is decorative (§9)."
            ));
        }
        Ok(AgentsDoor {
            secret: config.edge_secret,
            services: config.services,
            jurisdiction: Jurisdiction::from_env(&config.env)?,
            dev: config.env.get("NODE_ENV").map(String::as_str) != Some("production"),
            now: config.now,
            requests: RequestIds::new(),
            edge_key: None,
            store: config.store,
            gateway: config.gateway,
            ready: config.ready,
            metering: config.metering,
            runtime: config.runtime,
            ops: config.ops,
            background: config.background,
            advisors: config.advisors,
            own: config.own,
            team: config.team,
        })
    }

    /// Also believes principals the edge signed with its key (`EDGE_PRINCIPAL_PUBLIC_KEY`).
    pub fn with_edge_key(mut self, key: EdgeKey) -> AgentsDoor {
        self.edge_key = Some(key);
        self
    }

    /// The meter every metering call and timer goes through.
    pub fn metering(&self) -> &Metering {
        &self.metering
    }

    /// The database every slice reads and writes through.
    pub fn store(&self) -> &Store {
        &self.store
    }

    /// The gateway slice.
    pub fn gateway(&self) -> &GatewaySlice {
        &self.gateway
    }

    /// The operator desks' owner values.
    pub fn ops(&self) -> &Ops {
        &self.ops
    }

    /// The runtime's own settings.
    pub fn runtime(&self) -> &Runtime {
        &self.runtime
    }

    /// The owner's values for background runs.
    pub fn background(&self) -> crate::background::Settings {
        self.background
    }

    /// The slices' answers: the door's own call, the ported slices, and "not ported" for the rest.
    fn handle_call(&self, ctx: &Ctx<'_>) -> Result<Option<Json>, TrpcError> {
        match ctx.call.slice {
            Slice::Door => Ok(Some(Json::obj([
                ("ok", Json::Bool(true)),
                ("service", Json::str("svc-agents")),
            ]))),
            Slice::Gateway => self.gateway.handle(&self.store, ctx),
            Slice::Metering => crate::metering::slice::handle(ctx, &self.store, &self.metering),
            Slice::Runtime => crate::runtime::slice::handle(
                ctx,
                &self.store,
                &self.gateway,
                &self.metering,
                &self.runtime,
            ),
            Slice::Ops => crate::ops::handle(ctx, &self.store, &self.metering, &self.ops),
            Slice::Navigator => crate::navigator::slice::handle(
                ctx,
                &self.store,
                &self.gateway,
                &self.metering,
                &self.runtime,
            ),
            Slice::Background => crate::background::slice::handle(
                ctx,
                &self.store,
                &self.gateway,
                &self.metering,
                &self.runtime,
                self.background,
            ),
            Slice::Advisors => crate::advisors::slice::handle(
                ctx,
                &crate::advisors::slice::Deps {
                    store: &self.store,
                    gateway: &self.gateway,
                    m: &self.metering,
                    rt: &self.runtime,
                    advisors: &self.advisors,
                    jurisdiction: &self.jurisdiction,
                },
            ),
            Slice::OwnBuilder => crate::own::slice::handle(
                ctx,
                &crate::own::slice::Deps {
                    store: &self.store,
                    gateway: &self.gateway,
                    m: &self.metering,
                    rt: &self.runtime,
                    own: &self.own,
                },
            ),
            Slice::Team => crate::team::slice::handle(
                ctx,
                &crate::team::slice::Deps {
                    store: &self.store,
                    gateway: &self.gateway,
                    m: &self.metering,
                    rt: &self.runtime,
                    team: &self.team,
                },
            ),
            other => Err(not_ported(other)),
        }
    }

    /// `sql.end()`: closes the pool once the server has stopped.
    pub fn end(&self) {
        self.store.end();
    }

    /// Answers one request under a fresh request id.
    pub fn handle(&self, req: &Request<'_>) -> Response {
        let id = self.requests.next();
        self.handle_as(req, &id)
    }

    /// Answers one request under the id the server already gave it.
    pub fn handle_as(&self, req: &Request<'_>, request_id: &str) -> Response {
        let Some((path, query)) = trpc::route(req.url) else {
            return trpc::route_not_found(req);
        };
        match self.answer(req, &path, query) {
            Ok(data) => trpc::ok(data),
            Err(e) => trpc::render(&e, &path, request_id, "svc-agents", self.dev),
        }
    }

    /// Who may call, in the middlewares' order.
    fn admit(
        &self,
        call: &Call,
        principal: Option<&Principal>,
        service: Option<&str>,
        region: &str,
    ) -> Result<(), TrpcError> {
        let unauthenticated_service = || {
            TrpcError::plain(
                "UNAUTHORIZED",
                "This procedure is callable only by another INTAFACED service with valid service credentials (§2)",
            )
        };
        match call.access {
            Access::Public => Ok(()),
            Access::Settle => match service {
                None => Err(unauthenticated_service()),
                Some("svc-agents") => Ok(()),
                Some(_) => Err(forbidden("usage settle is callable only as svc-agents")),
            },
            Access::Service(listed) => match service {
                None => Err(unauthenticated_service()),
                Some(s) if listed.contains(&s) => Ok(()),
                Some(_) => Err(TrpcError::caused(
                    "FORBIDDEN",
                    "This service is not allowed to call this procedure",
                    "s2s.caller_forbidden",
                )),
            },
            Access::Scope(g) => {
                let Some(p) = principal else {
                    return Err(TrpcError::unauthenticated());
                };
                if g.person && service.is_some() {
                    return Err(forbidden(SESSION_REQUIRED));
                }
                // The person's own call: a key or a sub-account is told so before the scope, never to ask for a
                // scope no key can hold (`scopedProcedure`'s `ownSession`, J-agents-12 #3).
                if let Pre::PersonOnly(code) = call.pre
                    && delegated(p)
                {
                    return Err(forbidden(code));
                }
                access::require_scope(p, g.scope).map_err(TrpcError::guard)?;
                if g.module {
                    self.jurisdiction
                        .check_open(region)
                        .map_err(TrpcError::guard)?;
                }
                Ok(())
            }
        }
    }

    fn answer(
        &self,
        req: &Request<'_>,
        path: &str,
        query: &str,
    ) -> Result<Option<Json>, TrpcError> {
        if trpc::query_param(query, "batch").is_some() {
            return Err(TrpcError::plain(
                "BAD_REQUEST",
                "Batching is not served by svc-agents in Rust",
            ));
        }
        let Some(call) = call(path) else {
            return Err(trpc::no_procedure(path));
        };
        trpc::check_method(req.method, call.kind == Kind::Query, path)?;

        let now = (self.now)();
        let region = trpc::header(req, "x-intafaced-region").unwrap_or_else(|| "XX".to_owned());
        let raw_principal = trpc::header(req, "x-intafaced-principal");
        let principal_signature = trpc::header(req, "x-intafaced-principal-sig");
        let principal = edge::verify_with(
            raw_principal.as_deref(),
            principal_signature.as_deref(),
            &self.secret,
            self.edge_key.as_ref(),
            now,
            &region,
        );
        let forwarded = match (&principal, raw_principal, principal_signature) {
            (Some(_), Some(raw), Some(sig)) if !raw.is_empty() && !sig.is_empty() => vec![
                ("x-intafaced-principal".to_owned(), raw),
                ("x-intafaced-principal-sig".to_owned(), sig),
                ("x-intafaced-region".to_owned(), region.clone()),
            ],
            _ => Vec::new(),
        };
        let service = self.services.service(req, now.0.div_euclid(1000));
        self.admit(call, principal.as_ref(), service.as_deref(), &region)?;

        // The call's own middleware; it runs only behind `protectedProcedure`, so a principal is there.
        if let (Some(p), pre) = (principal.as_ref(), call.pre) {
            match pre {
                Pre::None => {}
                Pre::PersonOnly(code) => {
                    if delegated(p) {
                        return Err(forbidden(code));
                    }
                }
                Pre::CoachRun => {
                    if !access::has_scope(&p.scopes, "agents:execute") {
                        return Err(forbidden("agents.execute_scope_unset"));
                    }
                    // The AuthError keeps its message and code, and is always FORBIDDEN (two-factor included).
                    access::require_scope(p, "agents:execute").map_err(|r| TrpcError {
                        code: "FORBIDDEN",
                        ..TrpcError::guard(r)
                    })?;
                    if delegated(p) {
                        return Err(forbidden("agents.execute_person_only"));
                    }
                }
            }
        }

        // The input is read only now, after the middlewares, as tRPC reads it lazily.
        let raw = trpc::read_input(req, query)?;
        let input = match inputs::parse(path, raw.as_ref()) {
            Ok(Ok(v)) => v,
            Ok(Err(refused)) => return Err(TrpcError::plain("BAD_REQUEST", refused.message())),
            Err(broken) => return Err(TrpcError::plain("INTERNAL_SERVER_ERROR", broken)),
        };

        if let Some(p) = principal.as_ref() {
            let post = call.post;
            if (post.key && p.kid.is_some())
                || (post.sub_account && p.sub_account.is_some())
                || (post.lacks_identity_write && !access::has_scope(&p.scopes, "identity:write"))
            {
                return Err(forbidden(SESSION_REQUIRED));
            }
        }

        self.handle_call(&Ctx {
            call,
            input,
            principal: principal.as_ref(),
            service: service.as_deref(),
            region: &region,
            now,
            forwarded,
        })
    }
}

/// The kit's server serves the door.
impl Door for AgentsDoor {
    fn next_request_id(&self) -> String {
        self.requests.next()
    }

    fn handle_as(&self, req: &Request<'_>, request_id: &str) -> Response {
        AgentsDoor::handle_as(self, req, request_id)
    }

    /// `/ready` (`agentsReadiness`): the providers, the routing table in force and whether a completion can leave the
    /// process. `/health` is the server's own `{ ok, service }`, as `index.ts` answers it.
    fn status(&self, req: &Request<'_>) -> Option<Response> {
        let path = req.url.split_once('?').map_or(req.url, |(p, _)| p);
        (path == "/ready").then(|| Response {
            status: 200,
            body: readiness::readiness(&self.gateway.gateway, &self.ready, (self.now)()).compact(),
        })
    }
}
