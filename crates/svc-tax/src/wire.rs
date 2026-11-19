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
use std::sync::atomic::{AtomicU64, Ordering};

use crate::access::{self, Jurisdiction};
use crate::edge::{self, MIN_SECRET_LENGTH, Principal};
use crate::inputs;
use crate::json::{self, Json};
use crate::tax::{Failure, TaxService};
use crate::zod;

/// One HTTP request as it reaches the service.
pub struct Request<'a> {
    pub method: &'a str,
    /// The path and query, as sent (`/trpc/lotBook?input=...`).
    pub url: &'a str,
    /// Header names in lower case.
    pub headers: &'a [(String, String)],
    pub body: &'a str,
}

/// The answer: status and body. The body is always JSON.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Response {
    pub status: u16,
    pub body: String,
}

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

/// A tRPC error before it is formatted.
struct Error {
    code: &'static str,
    message: String,
    /// `intafacedCode`: set for a scope or jurisdiction refusal.
    intafaced_code: Option<String>,
    /// `cause.code`.
    cause: Option<String>,
}

impl Error {
    fn plain(code: &'static str, message: impl Into<String>) -> Error {
        Error {
            code,
            message: message.into(),
            intafaced_code: None,
            cause: None,
        }
    }

    fn guard(refused: access::Refused) -> Error {
        Error {
            code: "FORBIDDEN",
            message: refused.message,
            intafaced_code: Some(refused.code.clone()),
            cause: Some(refused.code),
        }
    }
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
            },
            Failure::Internal(message) => Error::plain("INTERNAL_SERVER_ERROR", message),
        }
    }
}

/// tRPC's JSON-RPC code and HTTP status for each error code.
fn codes(code: &str) -> (i64, u16) {
    match code {
        "BAD_REQUEST" => (-32600, 400),
        "UNAUTHORIZED" => (-32001, 401),
        "FORBIDDEN" => (-32003, 403),
        "NOT_FOUND" => (-32004, 404),
        "METHOD_NOT_SUPPORTED" => (-32005, 405),
        "PRECONDITION_FAILED" => (-32012, 412),
        _ => (-32603, 500),
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
    requests: AtomicU64,
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
            requests: AtomicU64::new(0),
        })
    }

    fn next_request_id(&self) -> String {
        let mut n = self
            .requests
            .fetch_add(1, Ordering::Relaxed)
            .saturating_add(1);
        let mut digits = Vec::new();
        while n > 0 {
            digits.push(char::from_digit(u32::try_from(n % 36).unwrap_or(0), 36).unwrap_or('0'));
            n /= 36;
        }
        format!("req-{}", digits.iter().rev().collect::<String>())
    }

    /// Answers one request.
    pub fn handle(&self, req: &Request<'_>) -> Response {
        let request_id = self.next_request_id();
        let (path_part, query) = req.url.split_once('?').unwrap_or((req.url, ""));
        let Some(raw_path) = path_part
            .strip_prefix("/trpc/")
            .filter(|p| !p.contains('/'))
        else {
            // Outside the tRPC route: Fastify's own not-found answer.
            let body = Json::obj([
                (
                    "message",
                    Json::str(format!("Route {}:{} not found", req.method, req.url)),
                ),
                ("error", Json::str("Not Found")),
                ("statusCode", Json::int(404)),
            ]);
            return Response {
                status: 404,
                body: body.compact(),
            };
        };
        let path = percent_decode(raw_path, false);
        let answer = self.call(req, &path, query);
        match answer {
            Ok(data) => Response {
                status: 200,
                body: Json::obj([("result", Json::obj([("data", data)]))]).compact(),
            },
            Err(e) => self.error(&e, &path, &request_id),
        }
    }

    fn error(&self, e: &Error, path: &str, request_id: &str) -> Response {
        let (rpc, status) = codes(e.code);
        let mut data = vec![
            ("code".to_owned(), Json::str(e.code)),
            ("httpStatus".to_owned(), Json::int(i64::from(status))),
        ];
        if self.dev {
            data.push((
                "stack".to_owned(),
                Json::str(format!("TRPCError: {}\n    at svc-tax (Rust)", e.message)),
            ));
        }
        data.push(("path".to_owned(), Json::str(path)));
        data.push(("requestId".to_owned(), Json::str(request_id)));
        if let Some(code) = &e.intafaced_code {
            data.push(("intafacedCode".to_owned(), Json::str(code.clone())));
        }
        if let Some(code) = &e.cause {
            data.push((
                "cause".to_owned(),
                Json::obj([("code", Json::str(code.clone()))]),
            ));
        }
        let body = Json::obj([(
            "error",
            Json::obj([
                ("message", Json::str(e.message.clone())),
                ("code", Json::int(rpc)),
                ("data", Json::Object(data)),
            ]),
        )]);
        Response {
            status,
            body: body.compact(),
        }
    }

    fn header(req: &Request<'_>, name: &str) -> Option<String> {
        let values: Vec<&str> = req
            .headers
            .iter()
            .filter(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
            .collect();
        // Node joins a repeated header with ", ".
        (!values.is_empty()).then(|| values.join(", "))
    }

    fn call(&self, req: &Request<'_>, path: &str, query: &str) -> Result<Json, Error> {
        if query_param(query, "batch").is_some() {
            return Err(Error::plain(
                "BAD_REQUEST",
                "Batching is not served by svc-tax in Rust",
            ));
        }
        let Some((_, kind, guard)) = PROCEDURES.iter().find(|(p, _, _)| *p == path) else {
            return Err(Error::plain(
                "NOT_FOUND",
                format!("No procedure found on path \"{path}\""),
            ));
        };
        match (req.method, kind) {
            ("GET", Kind::Query) | ("POST", Kind::Mutation) => {}
            ("GET" | "POST", _) => {
                let (m, k) = if req.method == "GET" {
                    ("GET", "mutation")
                } else {
                    ("POST", "query")
                };
                return Err(Error::plain(
                    "METHOD_NOT_SUPPORTED",
                    format!("Unsupported {m}-request to {k} procedure at path \"{path}\""),
                ));
            }
            (other, _) => {
                return Err(Error::plain(
                    "METHOD_NOT_SUPPORTED",
                    format!("Unsupported {other}-request"),
                ));
            }
        }

        let region = Self::header(req, "x-intafaced-region").unwrap_or_else(|| "XX".to_owned());
        let principal = edge::verify(
            Self::header(req, "x-intafaced-principal").as_deref(),
            Self::header(req, "x-intafaced-principal-sig").as_deref(),
            &self.secret,
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
                    return Err(Error::plain("UNAUTHORIZED", "Authentication required"));
                };
                access::require_scope(&p.scopes, scope).map_err(Error::guard)?;
                self.jurisdiction.check_tax(&region).map_err(Error::guard)?;
                p
            }
        };

        // The input is read only now, after the guard, as tRPC reads it lazily.
        let raw = match req.method {
            "GET" => query_param(query, "input"),
            _ => (!req.body.is_empty()).then(|| req.body.to_owned()),
        };
        let input = match raw {
            None => None,
            Some(text) => {
                Some(json::parse(&text).map_err(|e| Error::plain("BAD_REQUEST", e.message))?)
            }
        };
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
            "lotBook" | "missingBasis" => {
                let method = inputs::lot_book(input).map_err(bad)?;
                self.tax.lot_book(user, method.as_deref())
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

/// `URLSearchParams#get`: the first value of `name`, with `+` as a space and `%XX` decoded.
fn query_param(query: &str, name: &str) -> Option<String> {
    query.split('&').find_map(|pair| {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        (percent_decode(k, true) == name).then(|| percent_decode(v, true))
    })
}

/// Percent-decoding as the WHATWG URL parser does it: a `%` not followed by two hex digits stays as it is, and bytes that
/// are not UTF-8 become U+FFFD.
fn percent_decode(s: &str, plus_is_space: bool) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while let Some(&c) = b.get(i) {
        let hex = |at: usize| b.get(at).and_then(|h| char::from(*h).to_digit(16));
        match c {
            b'%' => match (hex(i + 1), hex(i + 2)) {
                (Some(h), Some(l)) => {
                    out.push(u8::try_from(h * 16 + l).unwrap_or(b'?'));
                    i += 3;
                    continue;
                }
                _ => out.push(c),
            },
            b'+' if plus_is_space => out.push(b' '),
            _ => out.push(c),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_query_values_as_url_search_params_does() {
        assert_eq!(
            query_param("input=%7B%22a%22%3A1%7D&x=1", "input").as_deref(),
            Some("{\"a\":1}")
        );
        assert_eq!(
            query_param("input=a+b%2", "input").as_deref(),
            Some("a b%2")
        );
        assert_eq!(query_param("x=1", "input"), None);
    }
}
