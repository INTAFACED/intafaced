//! svc-blueprint's door, as the TypeScript service serves it (`services/svc-blueprint/src/router.ts`, mounted from its
//! records by `mountRecords`, through the Fastify adapter): tRPC over HTTP at `/trpc/<path>`, with the records' guards
//! and the contracts' error formatter.
//!
//! The calls are svc-blueprint's records themselves, read from their published schema
//! (`packages/contracts/procedures/svc-blueprint.schema.json`, written from `packages/contracts/src/blueprint-procedures.ts`):
//! path, query or mutation, and who may call. A record added there is served here with no edit; one whose guard this
//! door does not know stops the door from starting.
//!
//! The order of the checks is the TypeScript's:
//!
//! 1. the call is found and its method checked;
//! 2. a scoped call needs a signed-in caller (`protectedProcedure`), then holds the scope, then is served in their
//!    region for the record's module (`scopedProcedure`'s `requireScope` and `refuseJurisdiction`);
//! 3. the input, read only now and checked by the record's zod schema (`inputs`);
//! 4. then the call's slice answers. Until a slice is ported, its calls answer that it is not ported;
//! 5. what a handler returns is parsed by the record's output schema (`.output(record.output)`): what leaves is that
//!    parse, and an answer that fails it is tRPC's `Output validation failed`.
//!
//! `tests/wire_replay.rs` holds the door to the TypeScript's recorded answers.

pub mod inputs;

use std::collections::BTreeMap;
use std::sync::OnceLock;

use service_kit::access::{self, Jurisdiction};
use service_kit::edge::{self, EdgeKey, MIN_SECRET_LENGTH, Principal};
use service_kit::json::{self, Json};
use service_kit::schema::Value;
use service_kit::server::{Door, Request, RequestIds, Response};
use service_kit::time::Instant;
use service_kit::trpc::{self, TrpcError};

use crate::card::renderer::CardRenderer;
use crate::db::Store;
use crate::errors::Refusal;

/// The records' published schema: the one list of the calls.
pub const RECORDS_JSON: &str =
    include_str!("../../../../packages/contracts/procedures/svc-blueprint.schema.json");

/// A query answers GET, a mutation POST.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Query,
    Mutation,
}

/// A module's rule in the jurisdiction matrix (`packages/config/src/jurisdiction.ts`): open everywhere the region check
/// lets through, at this verification tier. Only the modules svc-blueprint's records name.
const MODULES: [(&str, &str); 1] = [("blueprint", "none")];

/// Who may call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Access {
    /// Anyone (`publicProcedure`).
    Public,
    /// A signed-in caller holding the scope, served in their region for the module (`scopedProcedure`).
    Scope {
        scope: String,
        /// The module and its minimum tier, when the record names one.
        module: Option<(&'static str, &'static str)>,
    },
}

/// Which slice of the port owns a call's handler (`PORT.md`, `## Slices`). `Door` is answered here (`health`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Slice {
    Door,
    Profile,
    Onboard,
    Card,
    Shares,
    Privacy,
}

impl Slice {
    pub const ALL: [Slice; 6] = [
        Slice::Door,
        Slice::Profile,
        Slice::Onboard,
        Slice::Card,
        Slice::Shares,
        Slice::Privacy,
    ];

    pub fn name(self) -> &'static str {
        match self {
            Slice::Door => "door",
            Slice::Profile => "profile",
            Slice::Onboard => "onboard",
            Slice::Card => "card",
            Slice::Shares => "shares",
            Slice::Privacy => "privacy",
        }
    }

    /// The slice that owns the call at `path`; `None` for a call no slice has taken yet (a new record).
    pub fn of(path: &str) -> Option<Slice> {
        Some(match path {
            "health" => Slice::Door,
            "me" | "setVisibility" | "mentors" => Slice::Profile,
            "onboard" => Slice::Onboard,
            "card" | "cardOf" => Slice::Card,
            "shares.create" | "shares.list" | "shares.revoke" | "shares.openers" => Slice::Shares,
            "export" | "erase" => Slice::Privacy,
            _ => return None,
        })
    }
}

/// One record of the router.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Call {
    /// The record's name (`blueprint.card`).
    pub name: String,
    pub path: String,
    pub kind: Kind,
    pub access: Access,
    pub slice: Slice,
    /// Its handler's refusals are answered by `toTrpcError`; `me`, `mentors` and `export` never mapped theirs.
    pub mapped: bool,
}

/// The calls whose handlers send what they throw as tRPC sends an unknown error (`unmapped` in `router.ts`).
const UNMAPPED: [&str; 3] = ["me", "mentors", "export"];

fn text<'a>(v: &'a Json, key: &str) -> Option<&'a str> {
    match v.get(key) {
        Some(Json::String(s)) => Some(s),
        _ => None,
    }
}

fn load() -> Result<Vec<Call>, String> {
    let doc = json::parse(RECORDS_JSON).map_err(|e| e.message)?;
    let Some(Json::Object(records)) = doc.get("procedures") else {
        return Err("svc-blueprint.schema.json: no procedures".to_owned());
    };
    let mut calls = Vec::new();
    for (name, r) in records {
        if text(r, "service") != Some("svc-blueprint") || text(r, "transport") != Some("trpc") {
            continue;
        }
        let path = text(r, "path").ok_or(format!("{name}: no path"))?;
        let kind = match text(r, "kind") {
            Some("query") => Kind::Query,
            Some("mutation") => Kind::Mutation,
            other => return Err(format!("{name}: kind {other:?} is not served")),
        };
        let a = r.get("access").ok_or(format!("{name}: no access"))?;
        let access = match text(a, "caller") {
            Some("public") => Access::Public,
            Some("scope") => {
                let scope = text(a, "scope").ok_or(format!("{name}: no scope"))?;
                // A guard this door does not run would be skipped: refuse the record instead.
                if let Json::Object(fields) = a
                    && let Some((k, _)) = fields
                        .iter()
                        .find(|(k, _)| !["caller", "scope", "module"].contains(&k.as_str()))
                {
                    return Err(format!("{name}: its guard's {k} is not run by this door"));
                }
                let module = match text(a, "module") {
                    None => None,
                    Some(m) => Some(
                        *MODULES
                            .iter()
                            .find(|(id, _)| *id == m)
                            .ok_or(format!("{name}: module {m} has no rule here"))?,
                    ),
                };
                Access::Scope {
                    scope: scope.to_owned(),
                    module,
                }
            }
            other => return Err(format!("{name}: caller {other:?} is not served")),
        };
        let slice = Slice::of(path).ok_or(format!("{name}: no slice owns {path} (PORT.md)"))?;
        calls.push(Call {
            name: name.clone(),
            path: path.to_owned(),
            kind,
            access,
            slice,
            mapped: !UNMAPPED.contains(&path),
        });
    }
    calls.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(calls)
}

/// Every call, sorted by path; `Err` when a record cannot be served by this door.
pub fn calls() -> Result<&'static [Call], String> {
    static CALLS: OnceLock<Result<Vec<Call>, String>> = OnceLock::new();
    CALLS
        .get_or_init(load)
        .as_ref()
        .map(Vec::as_slice)
        .map_err(Clone::clone)
}

/// The call at `path`.
pub fn call(path: &str) -> Option<&'static Call> {
    calls().ok()?.iter().find(|c| c.path == path)
}

/// Each call's path, kind and caller, sorted by path: what `procedureCallers` reports for the TypeScript router.
pub fn callers() -> Result<Vec<(String, &'static str, &'static str)>, String> {
    Ok(calls()?
        .iter()
        .map(|c| {
            let kind = match c.kind {
                Kind::Query => "query",
                Kind::Mutation => "mutation",
            };
            let caller = match c.access {
                Access::Public => "public",
                Access::Scope { .. } => "scope",
            };
            (c.path.clone(), kind, caller)
        })
        .collect())
}

/// What one handler sees: the call, its checked input and the caller.
pub struct Ctx<'a> {
    pub call: &'static Call,
    /// The input as the call's schema returned it (defaults filled, unknown keys stripped); `Undefined` when absent.
    pub input: Value,
    /// `ctx.principal`: none for an anonymous caller of a public call.
    pub principal: Option<&'a Principal>,
    pub region: &'a str,
    pub now: Instant,
}

/// The answer of a call whose slice is not ported yet: the door's checks passed, and nothing past them is served.
pub fn not_ported(slice: Slice) -> Refusal {
    Refusal::Trpc(TrpcError::plain(
        "INTERNAL_SERVER_ERROR",
        format!(
            "svc-blueprint in Rust: the {} slice is not ported",
            slice.name()
        ),
    ))
}

/// The slices' answers.
fn handle(
    store: &Store,
    renderer: &dyn CardRenderer,
    ctx: &Ctx<'_>,
) -> Result<Option<Json>, Refusal> {
    match ctx.call.slice {
        Slice::Door => Ok(Some(Json::obj([
            ("ok", Json::Bool(true)),
            ("service", Json::str("svc-blueprint")),
        ]))),
        Slice::Profile => crate::profile::handle(store, ctx),
        Slice::Card => crate::card::handle(store, renderer, ctx),
        other => Err(not_ported(other)),
    }
}

/// tRPC's output check: the answer as the record's output schema returns it (its key order, unknown keys dropped).
fn output(path: &str, answer: Option<Json>) -> Result<Option<Json>, TrpcError> {
    let broken = |m: String| TrpcError::plain("INTERNAL_SERVER_ERROR", m);
    let Some(part) = inputs::output_part(path).map_err(broken)? else {
        return Ok(answer);
    };
    let value = answer.as_ref().map_or(Value::Undefined, Value::from_json);
    match inputs::parse_part(part, value).map_err(broken)? {
        Ok(v) => Ok(v.to_json()),
        Err(_) => Err(TrpcError::plain(
            "INTERNAL_SERVER_ERROR",
            "Output validation failed",
        )),
    }
}

/// What the door is built from, once, at start-up.
pub struct DoorConfig {
    /// `EDGE_PRINCIPAL_SECRET`: at least 32 characters.
    pub edge_secret: String,
    /// The process environment: the jurisdiction check's switches and lists, and `NODE_ENV`.
    pub env: BTreeMap<String, String>,
    /// The clock.
    pub now: fn() -> Instant,
    /// The `blueprint` schema's pool (`db::open`), or a store that refuses every query.
    pub store: Store,
    /// The card rasterizer (`card::renderer::from_env`, as `index.ts` picks it).
    pub renderer: Box<dyn CardRenderer>,
}

pub struct BlueprintDoor {
    secret: String,
    jurisdiction: Jurisdiction,
    now: fn() -> Instant,
    requests: RequestIds,
    edge_key: Option<EdgeKey>,
    store: Store,
    renderer: Box<dyn CardRenderer>,
}

/// The system clock.
pub fn system_now() -> Instant {
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX));
    Instant(ms)
}

impl BlueprintDoor {
    /// Refuses to start without a strong edge secret, with a malformed jurisdiction list, or with a record it cannot
    /// serve, as the TypeScript refuses to mount.
    pub fn new(config: DoorConfig) -> Result<BlueprintDoor, String> {
        if config.edge_secret.chars().count() < MIN_SECRET_LENGTH {
            return Err(format!(
                "svc-blueprint: EDGE_PRINCIPAL_SECRET must be at least {MIN_SECRET_LENGTH} characters to mount /trpc. \
                 Without it the principal header is caller-controlled and every scope check is decorative (§9)."
            ));
        }
        calls()?;
        Ok(BlueprintDoor {
            secret: config.edge_secret,
            jurisdiction: Jurisdiction::from_env(&config.env)?,
            now: config.now,
            requests: RequestIds::new(),
            edge_key: None,
            store: config.store,
            renderer: config.renderer,
        })
    }

    /// Also believes principals the edge signed with its key (`EDGE_PRINCIPAL_PUBLIC_KEY`).
    pub fn with_edge_key(mut self, key: EdgeKey) -> BlueprintDoor {
        self.edge_key = Some(key);
        self
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
            // The contracts' formatter sends no stack, in any environment.
            Err(e) => trpc::render(&e, &path, request_id, "svc-blueprint", false),
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
                "Batching is not served by svc-blueprint in Rust",
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
        if let Access::Scope { scope, module } = &call.access {
            let Some(p) = &principal else {
                return Err(TrpcError::unauthenticated());
            };
            access::require_scope(p, scope).map_err(TrpcError::guard)?;
            if let Some((module, min_tier)) = module {
                self.jurisdiction
                    .check_module(&region, &p.tier, module, min_tier)
                    .map_err(TrpcError::guard)?;
            }
        }

        // The input is read only now, after the guard, as tRPC reads it lazily.
        let raw = trpc::read_input(req, query)?;
        let input = match inputs::parse(path, raw.as_ref()) {
            Ok(Ok(v)) => v,
            Ok(Err(refused)) => return Err(TrpcError::plain("BAD_REQUEST", refused.message())),
            Err(broken) => return Err(TrpcError::plain("INTERNAL_SERVER_ERROR", broken)),
        };
        let ctx = Ctx {
            call,
            input,
            principal: principal.as_ref(),
            region: &region,
            now,
        };
        let answer = handle(&self.store, self.renderer.as_ref(), &ctx).map_err(|r| {
            if call.mapped {
                r.mapped()
            } else {
                r.unmapped()
            }
        })?;
        output(path, answer)
    }
}

/// The kit's server serves the door.
impl Door for BlueprintDoor {
    fn next_request_id(&self) -> String {
        self.requests.next()
    }

    fn handle_as(&self, req: &Request<'_>, request_id: &str) -> Response {
        BlueprintDoor::handle_as(self, req, request_id)
    }
}
