//! svc-tax's door, as the TypeScript service serves it: tRPC over HTTP at `/trpc/<path>`, through the Fastify adapter
//! (`@trpc/server/adapters/fastify`), with its records' guards (`packages/contracts/src/procedure-mount.ts`, `trpc.ts`)
//! and error formatter.
//!
//! The order of the checks is the TypeScript's: the caller is authenticated, then holds the scope, then is served in
//! their region; only then is the input read and checked, and the handler runs.
//!
//! Not served here yet, and answered differently from the TypeScript service: tRPC batching (`?batch=1`), HTTP methods
//! other than GET and POST, and the wording of a JSON syntax error (V8's own text). The replay sends none of them.

use std::collections::BTreeMap;

use crate::edge::{self, EdgeKey, MIN_SECRET_LENGTH, Principal};
use crate::inputs;
use crate::json::Json;
use crate::tax::{Failure, TaxService};
use crate::zod;
use service_kit::access::{self, Jurisdiction};

use service_kit::server::{Door, RequestIds};
pub use service_kit::server::{Request, Response};
use service_kit::trpc::{self, TrpcError as Error};

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Query,
    Mutation,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Access {
    Public,
    Scope(&'static str),
}

/// svc-tax's twelve records: path, kind and who may call (`packages/contracts/src/tax-procedures.ts`).
const PROCEDURES: [(&str, Kind, Access); 12] = [
    ("health", Kind::Query, Access::Public),
    ("lotBook", Kind::Query, Access::Scope("tax:read")),
    ("pnlOverTime", Kind::Query, Access::Scope("tax:read")),
    ("missingBasis", Kind::Query, Access::Scope("tax:read")),
    (
        "basisOverride.set",
        Kind::Mutation,
        Access::Scope("tax:write"),
    ),
    (
        "basisOverride.remove",
        Kind::Mutation,
        Access::Scope("tax:write"),
    ),
    ("setLotMethod", Kind::Mutation, Access::Scope("tax:write")),
    ("setDayMethod", Kind::Mutation, Access::Scope("tax:write")),
    ("pickSaleLot", Kind::Mutation, Access::Scope("tax:write")),
    (
        "setIncludeTransfers",
        Kind::Mutation,
        Access::Scope("tax:write"),
    ),
    ("exportPreview", Kind::Query, Access::Scope("tax:read")),
    // A read, but a mutation on the wire (its reply is a file), as its record keeps it.
    ("exportPack", Kind::Mutation, Access::Scope("tax:read")),
];

/// Each call's path, kind and caller, sorted by path: what `procedureCallers` reports for the TypeScript router.
pub fn callers() -> Vec<(&'static str, &'static str, &'static str)> {
    let mut out: Vec<_> = PROCEDURES
        .iter()
        .map(|(path, kind, access)| {
            let kind = if *kind == Kind::Query {
                "query"
            } else {
                "mutation"
            };
            let caller = if *access == Access::Public {
                "public"
            } else {
                "scope"
            };
            (*path, kind, caller)
        })
        .collect();
    out.sort_unstable();
    out
}

impl From<Failure> for Error {
    fn from(f: Failure) -> Error {
        match f {
            // svc-tax's one refusal type: PRECONDITION_FAILED, the code leading the message (`taxRefusal`).
            Failure::Refused(e) => Error {
                code: "PRECONDITION_FAILED",
                message: format!("{} — {}", e.code, e.message),
                intafaced_code: None,
                cause: Some(e.code.to_owned()),
                preview: None,
                spend: None,
            },
            Failure::Internal(message) => Error::plain("INTERNAL_SERVER_ERROR", message),
        }
    }
}

/// What the service is built from, once, at start-up.
pub struct WireConfig {
    /// `EDGE_PRINCIPAL_SECRET`: at least 32 characters.
    pub edge_secret: String,
    /// The process environment: the jurisdiction check's switches and lists, and `NODE_ENV`.
    pub env: BTreeMap<String, String>,
    pub tax: TaxService,
}

pub struct Wire {
    secret: String,
    jurisdiction: Jurisdiction,
    /// tRPC sends a stack trace in every error outside production.
    dev: bool,
    tax: TaxService,
    /// Fastify's request ids: `req-1`, `req-2`, ... in base 36, one per request this process takes.
    requests: RequestIds,
    /// `EDGE_PRINCIPAL_PUBLIC_KEY` with its limits: the edge's Ed25519 principals are believed too.
    edge_key: Option<EdgeKey>,
}

impl Wire {
    /// Refuses to start without a strong edge secret or with a malformed jurisdiction list, as the TypeScript does.
    pub fn new(config: WireConfig) -> Result<Wire, String> {
        if config.edge_secret.chars().count() < MIN_SECRET_LENGTH {
            return Err(format!(
                "svc-tax: EDGE_PRINCIPAL_SECRET must be at least {MIN_SECRET_LENGTH} characters to mount /trpc. \
                 Without it the principal header is caller-controlled and every scope check is decorative (§9)."
            ));
        }
        Ok(Wire {
            secret: config.edge_secret,
            jurisdiction: Jurisdiction::from_env(&config.env)?,
            dev: config.env.get("NODE_ENV").map(String::as_str) != Some("production"),
            tax: config.tax,
            requests: RequestIds::new(),
            edge_key: None,
        })
    }

    /// Also believes principals the edge signed with its key (`edgeTrustFromEnv`).
    /// Whether a principal signed by the edge's key is believed here (`EDGE_PRINCIPAL_PUBLIC_KEY` set at boot).
    pub fn trusts_edge_key(&self) -> bool {
        self.edge_key.is_some()
    }

    pub fn with_edge_key(mut self, key: EdgeKey) -> Wire {
        self.edge_key = Some(key);
        self
    }

    /// The next Fastify request id. The server takes one for every request, whatever its route.
    pub fn next_request_id(&self) -> String {
        self.requests.next()
    }

    /// Answers one request.
    pub fn handle(&self, req: &Request<'_>) -> Response {
        let request_id = self.next_request_id();
        self.handle_as(req, &request_id)
    }

    /// Answers one request under the id the server already gave it.
    pub fn handle_as(&self, req: &Request<'_>, request_id: &str) -> Response {
        // Outside the tRPC route: Fastify's own not-found answer.
        let Some((path, query)) = trpc::route(req.url) else {
            return trpc::route_not_found(req);
        };
        match self.call(req, &path, query) {
            Ok(data) => trpc::ok(Some(data)),
            Err(e) => trpc::render(&e, &path, request_id, "svc-tax", self.dev),
        }
    }

    fn call(&self, req: &Request<'_>, path: &str, query: &str) -> Result<Json, Error> {
        if trpc::query_param(query, "batch").is_some() {
            return Err(Error::plain(
                "BAD_REQUEST",
                "Batching is not served by svc-tax in Rust",
            ));
        }
        let Some((_, kind, guard)) = PROCEDURES.iter().find(|(p, _, _)| *p == path) else {
            return Err(trpc::no_procedure(path));
        };
        trpc::check_method(req.method, *kind == Kind::Query, path)?;

        let region = trpc::header(req, "x-intafaced-region").unwrap_or_else(|| "XX".to_owned());
        let principal = edge::verify_with(
            trpc::header(req, "x-intafaced-principal").as_deref(),
            trpc::header(req, "x-intafaced-principal-sig").as_deref(),
            &self.secret,
            self.edge_key.as_ref(),
            self.tax.now(),
            &region,
        );

        let principal: Principal = match guard {
            Access::Public => {
                return Ok(Json::obj([
                    ("ok", Json::Bool(true)),
                    ("service", Json::str("svc-tax")),
                ]));
            }
            Access::Scope(scope) => {
                let Some(p) = principal else {
                    return Err(Error::unauthenticated());
                };
                access::require_scope(&p, scope).map_err(Error::guard)?;
                self.jurisdiction
                    .check_open(&region)
                    .map_err(Error::guard)?;
                p
            }
        };

        // The input is read only now, after the guard, as tRPC reads it lazily.
        let input = trpc::read_input(req, query)?;
        self.dispatch(path, &principal, &region, input.as_ref())
    }

    fn dispatch(
        &self,
        path: &str,
        who: &Principal,
        region: &str,
        input: Option<&Json>,
    ) -> Result<Json, Error> {
        let bad = |issues: Vec<zod::Issue>| Error::plain("BAD_REQUEST", zod::message(&issues));
        let user = who.user_id.as_str();
        let out = match path {
            "lotBook" => {
                let method = inputs::lot_book(input).map_err(bad)?;
                self.tax.lot_book(user, method.as_deref()).map(|b| b.json())
            }
            "missingBasis" => {
                let method = inputs::lot_book(input).map_err(bad)?;
                self.tax.missing_basis(user, method.as_deref())
            }
            "pnlOverTime" => self
                .tax
                .pnl_over_time(user, &inputs::pnl_over_time(input).map_err(bad)?),
            "basisOverride.set" => self
                .tax
                .basis_override_set(user, &inputs::basis_override_set(input).map_err(bad)?),
            "basisOverride.remove" => self
                .tax
                .basis_override_remove(user, &inputs::basis_override_remove(input).map_err(bad)?),
            "setLotMethod" => self
                .tax
                .set_lot_method(user, &inputs::set_lot_method(input).map_err(bad)?),
            "setDayMethod" => self
                .tax
                .set_day_method(user, &inputs::set_day_method(input).map_err(bad)?),
            "pickSaleLot" => self
                .tax
                .pick_sale_lot(user, &inputs::pick_sale_lot(input).map_err(bad)?),
            "setIncludeTransfers" => self
                .tax
                .set_include_transfers(user, inputs::set_include_transfers(input).map_err(bad)?),
            "exportPreview" | "exportPack" => {
                let i = inputs::export(input).map_err(bad)?;
                let export = self.tax.export(user, region, &i.lot_method, i.complete);
                export.map(|x| {
                    if path == "exportPack" {
                        x.pack()
                    } else {
                        x.preview()
                    }
                })
            }
            _ => Err(Failure::Internal(format!("no handler for {path}"))),
        };
        out.map_err(Error::from)
    }
}

/// The kit's server serves the wire as svc-tax's door.
impl Door for Wire {
    fn next_request_id(&self) -> String {
        Wire::next_request_id(self)
    }

    fn handle_as(&self, req: &Request<'_>, request_id: &str) -> Response {
        Wire::handle_as(self, req, request_id)
    }
}
