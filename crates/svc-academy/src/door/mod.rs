//! svc-academy's door, as the TypeScript service serves it (`services/svc-academy/src/router.ts` through the Fastify
//! adapter): tRPC over HTTP at `/trpc/<path>`, with the router's guards and the contracts' error formatter.
//!
//! The order of the checks is the TypeScript's: the call is found and its method checked; a scoped call's caller is
//! authenticated, holds the scope (`scopedProcedure`: implied scopes, interactive-only and session-MFA scopes) and is
//! served in their region; only then is the input read and checked by the call's zod schema. An approval-gated call
//! then checks its operator and the approval ids (`consumeApproval`, before anything is stored), and the call's slice
//! answers. A guarded call (`guard(...)`) turns a refusal into its answer by the error table; an unguarded one lets it
//! reach tRPC as it is.
//!
//! Every call is in [`calls::CALLS`], generated from the TypeScript router and its recorded answers
//! (`scripts/record-door.mjs`): path, query or mutation, scope or public, guarded or not, approval-gated or not, which
//! slice owns it and whether it takes an input. `tests/wire_replay.rs` holds the door to the TypeScript's answers.

pub mod calls;
pub mod errors_table;
pub mod inputs;

use std::collections::BTreeMap;

use service_kit::access::{self, Jurisdiction};
use service_kit::edge::{self, EdgeKey, MIN_SECRET_LENGTH, Principal};
use service_kit::json::Json;
use service_kit::schema::Value;
use service_kit::server::{Door, Request, RequestIds, Response};
use service_kit::time::Instant;
use service_kit::trpc::{self, TrpcError};

use crate::access::{ApprovalIds, approval_precheck};
use crate::db::Store;
use crate::errors::Refusal;
use crate::ports::Ports;
use crate::settings::Settings;
use crate::slices;

/// A query answers GET, a mutation POST.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Query,
    Mutation,
}

/// Who may call: anyone, or a caller holding the scope.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Access {
    Public,
    Scope(&'static str),
}

/// Which slice of the port owns a call's handler. `Door` is answered here (`health`, `admin.settingsStatus`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Slice {
    Door,
    Curriculum,
    Lobbies,
    Authoring,
    Learner,
    Assessment,
    Certs,
    Community,
    Programme,
}

impl Slice {
    pub const ALL: [Slice; 9] = [
        Slice::Door,
        Slice::Curriculum,
        Slice::Lobbies,
        Slice::Authoring,
        Slice::Learner,
        Slice::Assessment,
        Slice::Certs,
        Slice::Community,
        Slice::Programme,
    ];

    pub fn name(self) -> &'static str {
        match self {
            Slice::Door => "door",
            Slice::Curriculum => "curriculum",
            Slice::Lobbies => "lobbies",
            Slice::Authoring => "authoring",
            Slice::Learner => "learner",
            Slice::Assessment => "assessment",
            Slice::Certs => "certs",
            Slice::Community => "community",
            Slice::Programme => "programme",
        }
    }
}

/// Which message a refusal's answer carries: the code's user copy, or the refusal's own.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Send {
    UserCopy,
    Message,
}

/// One call of the router.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Call {
    pub path: &'static str,
    pub kind: Kind,
    pub access: Access,
    /// Its handler runs inside `guard(...)`: a refusal is answered by the error table.
    pub guarded: bool,
    /// Its handler consumes an identity-issued approval first.
    pub approval: bool,
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
                Access::Public => "public",
                Access::Scope(_) => "scope",
            };
            (c.path, kind, caller)
        })
        .collect();
    out.sort_unstable();
    out
}

/// What one handler sees: the call, its checked input, the caller, the region, and the service's parts.
pub struct Ctx<'a> {
    pub call: &'static Call,
    /// The input as the call's schema returned it (defaults filled, unknown keys stripped); `Undefined` when absent.
    pub input: Value,
    /// `ctx.principal`: none for an anonymous caller of a public call.
    pub principal: Option<&'a Principal>,
    pub region: &'a str,
    /// The approval ids an approval-gated call checked before its slice ran.
    pub approval: Option<ApprovalIds>,
    pub now: Instant,
    pub store: &'a Store,
    pub ports: &'a Ports,
    pub settings: &'a Settings,
    /// `ctx.quizClientAddress`: the edge's client address, believed only from a trusted proxy (`index.ts`).
    pub quiz_client_address: Option<String>,
}

impl Ctx<'_> {
    /// The database, or the refusal a store that cannot serve gives (down, or refusing in the replay).
    pub fn service(&self) -> Result<&service_kit::pg::Pool, Refusal> {
        self.store.pool()
    }

    /// The caller, for a scoped call (the guard already refused an anonymous one).
    pub fn user_id(&self) -> &str {
        self.principal.map_or("", |p| p.user_id.as_str())
    }
}

/// What the door is built from, once, at start-up.
pub struct DoorConfig {
    /// `EDGE_PRINCIPAL_SECRET`: at least 32 characters.
    pub edge_secret: String,
    /// The process environment: the jurisdiction check's switches and lists, and `NODE_ENV`.
    pub env: BTreeMap<String, String>,
    pub store: Store,
    pub ports: Ports,
    pub settings: Settings,
    /// The clock.
    pub now: fn() -> Instant,
}

pub struct AcademyDoor {
    secret: String,
    jurisdiction: Jurisdiction,
    /// tRPC sends a stack trace in every error outside production.
    dev: bool,
    store: Store,
    ports: Ports,
    settings: Settings,
    now: fn() -> Instant,
    requests: RequestIds,
    edge_key: Option<EdgeKey>,
    /// `createQuizAddressResolver(ACADEMY_TRUSTED_PROXY_CIDRS)`: built before the listener opens.
    quiz_proxies: Vec<String>,
}

/// The system clock.
pub fn system_now() -> Instant {
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX));
    Instant(ms)
}

impl AcademyDoor {
    /// Refuses to start without a strong edge secret or with a malformed jurisdiction list, as the TypeScript does.
    pub fn new(config: DoorConfig) -> Result<AcademyDoor, String> {
        if config.edge_secret.chars().count() < MIN_SECRET_LENGTH {
            return Err(format!(
                "svc-academy: EDGE_PRINCIPAL_SECRET must be at least {MIN_SECRET_LENGTH} characters to mount /trpc. \
                 Without it the principal header is caller-controlled and every scope check is decorative (§9)."
            ));
        }
        // A malformed proxy range stops the service instead of reading no address.
        let quiz_proxies = crate::assessment::quizzes::proxy_rules(
            crate::assessment::setting_str(&config.settings, "ACADEMY_TRUSTED_PROXY_CIDRS"),
        )?;
        Ok(AcademyDoor {
            quiz_proxies,
            secret: config.edge_secret,
            jurisdiction: Jurisdiction::from_env(&config.env)?,
            dev: config.env.get("NODE_ENV").map(String::as_str) != Some("production"),
            store: config.store,
            ports: config.ports,
            settings: config.settings,
            now: config.now,
            requests: RequestIds::new(),
            edge_key: None,
        })
    }

    /// Also believes principals the edge signed with its key (`EDGE_PRINCIPAL_PUBLIC_KEY`).
    pub fn with_edge_key(mut self, key: EdgeKey) -> AcademyDoor {
        self.edge_key = Some(key);
        self
    }

    pub fn trusts_edge_key(&self) -> bool {
        self.edge_key.is_some()
    }

    /// `GET /ready`'s body.
    pub fn ready(&self) -> Json {
        self.ports.ready()
    }

    /// Closes the database pool (`sql.end()`).
    /// The database, for the service's own background work (outbox drain, sweeps).
    pub fn store(&self) -> &Store {
        &self.store
    }

    /// What the service asks outside itself, for its background work.
    pub fn ports(&self) -> &Ports {
        &self.ports
    }

    /// The owner settings, for its background work.
    pub fn settings(&self) -> &Settings {
        &self.settings
    }

    pub fn end(&self) {
        self.store.end();
    }

    /// One pass of the purchase reconciler (`reconcileCoursePurchases`): up to 100 open purchases and 100 set aside.
    pub fn reconcile_course_purchases(
        &self,
        on_error: &mut dyn FnMut(&str, &Refusal),
    ) -> Result<usize, Refusal> {
        crate::learner::purchases::CoursePurchases {
            pool: &self.store,
            deps: crate::learner::purchases::Deps::of(&self.ports),
        }
        .reconcile(100, on_error)
    }

    /// Answers one request under a fresh request id.
    pub fn handle(&self, req: &Request<'_>) -> Response {
        let id = self.requests.next();
        self.handle_as(req, &id)
    }

    /// Answers one request under the id the server already gave it.
    pub fn handle_as(&self, req: &Request<'_>, request_id: &str) -> Response {
        // The coach's S2S door, beside `/trpc` (`registerInternalCurriculumRoute`).
        if let Some(res) = crate::curriculum::internal::route(&self.ports.services, req) {
            return res;
        }
        let Some((path, query)) = trpc::route(req.url) else {
            return trpc::route_not_found(req);
        };
        match self.answer(req, &path, query) {
            Ok(data) => trpc::ok(data),
            Err(e) => trpc::render(&e, &path, request_id, "svc-academy", self.dev),
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
                "Batching is not served by svc-academy in Rust",
            ));
        }
        let Some(call) = call(path) else {
            return Err(trpc::no_procedure(path));
        };
        trpc::check_method(req.method, call.kind == Kind::Query, path)?;

        let now = (self.now)();
        let region = trpc::header(req, "x-intafaced-region").unwrap_or_else(|| "XX".to_owned());
        let principal = edge::verify_with(
            trpc::header(req, "x-intafaced-principal").as_deref(),
            trpc::header(req, "x-intafaced-principal-sig").as_deref(),
            &self.secret,
            self.edge_key.as_ref(),
            now,
            &region,
        );
        if let Access::Scope(scope) = call.access {
            let Some(p) = &principal else {
                return Err(TrpcError::unauthenticated());
            };
            access::require_scope(p, scope).map_err(TrpcError::guard)?;
            self.jurisdiction
                .check_open(&region)
                .map_err(TrpcError::guard)?;
        }

        // The input is read only now, after the guard, as tRPC reads it lazily.
        let raw = trpc::read_input(req, query)?;
        let input = match inputs::parse(path, raw.as_ref()) {
            Ok(Ok(v)) => v,
            Ok(Err(refused)) => return Err(TrpcError::plain("BAD_REQUEST", refused.message())),
            Err(broken) => return Err(TrpcError::plain("INTERNAL_SERVER_ERROR", broken)),
        };

        let refuse = |r: Refusal| {
            if call.guarded {
                r.guarded()
            } else {
                r.unguarded()
            }
        };
        let approval = if call.approval {
            Some(approval_precheck(principal.as_ref(), &input).map_err(refuse)?)
        } else {
            None
        };
        let ctx = Ctx {
            call,
            input,
            principal: principal.as_ref(),
            region: &region,
            approval,
            now,
            store: &self.store,
            ports: &self.ports,
            settings: &self.settings,
            quiz_client_address: crate::assessment::quizzes::resolve_address(
                &self.quiz_proxies,
                trpc::header(req, service_kit::server::SOCKET_PEER).as_deref(),
                trpc::header(req, "x-intafaced-client-ip").as_deref(),
            ),
        };
        slices::handle(&ctx).map_err(refuse)
    }
}

/// The kit's server serves the door.
impl Door for AcademyDoor {
    fn next_request_id(&self) -> String {
        self.requests.next()
    }

    fn handle_as(&self, req: &Request<'_>, request_id: &str) -> Response {
        AcademyDoor::handle_as(self, req, request_id)
    }
}
