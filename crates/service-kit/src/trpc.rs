//! tRPC over HTTP as a TypeScript service serves it through the Fastify adapter (`@trpc/server/adapters/fastify`):
//! the route (`/trpc/<path>`), the method a query or a mutation takes, the input (`?input=` for a query, the body for
//! a mutation), and the error envelope `packages/contracts/src/trpc.ts`'s formatter writes: message, JSON-RPC code, and
//! `data` with the tRPC code, HTTP status, the stack outside production, the path, the request id, `intafacedCode` for a
//! guard's refusal and `cause.code` for a refusal that names one.
//!
//! Not served: tRPC batching (`?batch=1`), HTTP methods other than GET and POST, and V8's own wording of a JSON syntax
//! error. A service's wire replay sends none of them.

use crate::access::Refused;
use crate::json::{self, Json};
use crate::server::{Request, Response};

/// A tRPC error before it is formatted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrpcError {
    pub code: &'static str,
    pub message: String,
    /// `intafacedCode`: set for a scope, two-factor or jurisdiction refusal (an `AuthError` or `JurisdictionError`).
    pub intafaced_code: Option<String>,
    /// `cause.code`: the refusal's own code, when its cause names one.
    pub cause: Option<String>,
}

impl TrpcError {
    /// An error with no cause code.
    pub fn plain(code: &'static str, message: impl Into<String>) -> TrpcError {
        TrpcError {
            code,
            message: message.into(),
            intafaced_code: None,
            cause: None,
        }
    }

    /// An error whose cause carries `cause` as its code.
    pub fn caused(
        code: &'static str,
        message: impl Into<String>,
        cause: impl Into<String>,
    ) -> TrpcError {
        TrpcError {
            code,
            message: message.into(),
            intafaced_code: None,
            cause: Some(cause.into()),
        }
    }

    /// A guard's refusal (`refuseGuard`, `refuseJurisdiction`): two-factor is `UNAUTHORIZED`, the rest `FORBIDDEN`.
    pub fn guard(refused: Refused) -> TrpcError {
        let code = if refused.code == "mfa.required" {
            "UNAUTHORIZED"
        } else {
            "FORBIDDEN"
        };
        TrpcError {
            code,
            message: refused.message,
            intafaced_code: Some(refused.code.clone()),
            cause: Some(refused.code),
        }
    }

    /// `protectedProcedure` with no principal.
    pub fn unauthenticated() -> TrpcError {
        TrpcError::plain("UNAUTHORIZED", "Authentication required")
    }
}

/// tRPC's JSON-RPC code and HTTP status for each error code.
pub fn codes(code: &str) -> (i64, u16) {
    match code {
        "BAD_REQUEST" => (-32600, 400),
        "UNAUTHORIZED" => (-32001, 401),
        "FORBIDDEN" => (-32003, 403),
        "NOT_FOUND" => (-32004, 404),
        "METHOD_NOT_SUPPORTED" => (-32005, 405),
        "CONFLICT" => (-32009, 409),
        "PRECONDITION_FAILED" => (-32012, 412),
        "TOO_MANY_REQUESTS" => (-32029, 429),
        _ => (-32603, 500),
    }
}

/// The answer to a call that succeeded: `{"result":{"data":...}}`, or `{"result":{}}` when it returned nothing.
pub fn ok(data: Option<Json>) -> Response {
    let result = match data {
        Some(d) => Json::obj([("data", d)]),
        None => Json::Object(Vec::new()),
    };
    Response {
        status: 200,
        body: Json::obj([("result", result)]).compact(),
    }
}

/// The formatted error. `service` names the stack's one frame; `dev` sends it (tRPC sends a stack outside production).
pub fn render(e: &TrpcError, path: &str, request_id: &str, service: &str, dev: bool) -> Response {
    let (rpc, status) = codes(e.code);
    let mut data = vec![
        ("code".to_owned(), Json::str(e.code)),
        ("httpStatus".to_owned(), Json::int(i64::from(status))),
    ];
    if dev {
        data.push((
            "stack".to_owned(),
            Json::str(format!("TRPCError: {}\n    at {service} (Rust)", e.message)),
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

/// The call's path and the query string, when the URL is a tRPC route; `None` is outside it.
pub fn route(url: &str) -> Option<(String, &str)> {
    let (path_part, query) = url.split_once('?').unwrap_or((url, ""));
    let raw = path_part
        .strip_prefix("/trpc/")
        .filter(|p| !p.contains('/'))?;
    Some((percent_decode(raw, false), query))
}

/// Fastify's own answer outside every route.
pub fn route_not_found(req: &Request<'_>) -> Response {
    let body = Json::obj([
        (
            "message",
            Json::str(format!("Route {}:{} not found", req.method, req.url)),
        ),
        ("error", Json::str("Not Found")),
        ("statusCode", Json::int(404)),
    ]);
    Response {
        status: 404,
        body: body.compact(),
    }
}

/// A query answers GET, a mutation POST; the rest as tRPC refuses them.
pub fn check_method(method: &str, is_query: bool, path: &str) -> Result<(), TrpcError> {
    match (method, is_query) {
        ("GET", true) | ("POST", false) => Ok(()),
        ("GET" | "POST", _) => {
            let (m, k) = if method == "GET" {
                ("GET", "mutation")
            } else {
                ("POST", "query")
            };
            Err(TrpcError::plain(
                "METHOD_NOT_SUPPORTED",
                format!("Unsupported {m}-request to {k} procedure at path \"{path}\""),
            ))
        }
        (other, _) => Err(TrpcError::plain(
            "METHOD_NOT_SUPPORTED",
            format!("Unsupported {other}-request"),
        )),
    }
}

/// `No procedure found on path "<path>"`.
pub fn no_procedure(path: &str) -> TrpcError {
    TrpcError::plain(
        "NOT_FOUND",
        format!("No procedure found on path \"{path}\""),
    )
}

/// A header as Node joins a repeated one: with `", "`.
pub fn header(req: &Request<'_>, name: &str) -> Option<String> {
    let values: Vec<&str> = req
        .headers
        .iter()
        .filter(|(k, _)| k == name)
        .map(|(_, v)| v.as_str())
        .collect();
    (!values.is_empty()).then(|| values.join(", "))
}

/// The call's raw input, read only after the guard, as tRPC reads it lazily: `?input=` for GET, the body for POST.
pub fn read_input(req: &Request<'_>, query: &str) -> Result<Option<Json>, TrpcError> {
    let raw = match req.method {
        "GET" => query_param(query, "input"),
        _ => (!req.body.is_empty()).then(|| req.body.to_owned()),
    };
    match raw {
        None => Ok(None),
        Some(text) => json::parse(&text)
            .map(Some)
            .map_err(|e| TrpcError::plain("BAD_REQUEST", e.message)),
    }
}

/// `URLSearchParams#get`: the first value of `name`, with `+` as a space and `%XX` decoded.
pub fn query_param(query: &str, name: &str) -> Option<String> {
    query.split('&').find_map(|pair| {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        (percent_decode(k, true) == name).then(|| percent_decode(v, true))
    })
}

/// Percent-decoding as the WHATWG URL parser does it: a `%` not followed by two hex digits stays as it is, and bytes that
/// are not UTF-8 become U+FFFD.
pub fn percent_decode(s: &str, plus_is_space: bool) -> String {
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

    #[test]
    fn a_two_factor_refusal_is_unauthorized_and_the_rest_forbidden() {
        let r = |code: &str| Refused {
            message: "m".to_owned(),
            code: code.to_owned(),
        };
        assert_eq!(TrpcError::guard(r("mfa.required")).code, "UNAUTHORIZED");
        assert_eq!(TrpcError::guard(r("scope.denied")).code, "FORBIDDEN");
    }
}
