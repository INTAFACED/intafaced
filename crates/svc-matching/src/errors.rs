//! How svc-matching's doors refuse, as `router.ts` writes each body: the service signature's 401 and the caller list's
//! 403 (`authFailure`), a body or query its schema refuses (400 `BadRequest` with zod's issues, each `<path>: <message>`),
//! a list window that is not published (400 with the window's code), and the founder door's edge principal (503 while
//! unconfigured, 401 and 403 from the principal and its scope).
//!
//! Every message a client reads goes through `userCopy`: the recorded copy in `errors_table`, or the code itself.

use service_kit::json::Json;
use service_kit::schema::Issue;
use service_kit::server::Response;

use crate::errors_table::USER_COPY;

/// `userCopy(code)`: the catalogue sentence, or the code itself when the catalogue has none.
pub fn user_copy(code: &str) -> String {
    USER_COPY
        .iter()
        .find(|(c, _)| *c == code)
        .map_or(code, |(_, t)| t)
        .to_owned()
}

fn json(status: u16, fields: Vec<(&str, Json)>) -> Response {
    let body = Json::Object(fields.into_iter().map(|(k, v)| (k.to_owned(), v)).collect());
    Response {
        status,
        body: body.compact(),
    }
}

/// `unauthenticatedBody`: 401, with why the signature was refused.
pub fn unauthenticated(rejected: &str) -> Response {
    let mut fields = vec![
        ("code", Json::str("Unauthenticated")),
        ("message", Json::str(user_copy("matching.unauthenticated"))),
    ];
    if !rejected.is_empty() {
        fields.push(("rejected", Json::str(rejected)));
    }
    json(401, fields)
}

/// `forbiddenBody`: 403, a proven service that is not on the door's list.
pub fn forbidden() -> Response {
    json(
        403,
        vec![
            ("code", Json::str("Forbidden")),
            ("message", Json::str(user_copy("error.forbidden"))),
        ],
    )
}

/// zod's issue as the router writes it: `<path joined with dots>: <message>`.
pub fn issue_line(issue: &Issue) -> String {
    let path: Vec<String> = issue
        .path()
        .iter()
        .map(|seg| match seg {
            Json::String(s) => s.clone(),
            other => other.compact(),
        })
        .collect();
    format!("{}: {}", path.join("."), issue.message())
}

/// 400 `BadRequest` with these issue lines.
pub fn bad_request(lines: Vec<String>) -> Response {
    json(
        400,
        vec![
            ("code", Json::str("BadRequest")),
            (
                "issues",
                Json::Array(lines.into_iter().map(Json::String).collect()),
            ),
        ],
    )
}

/// 400 with a code and its user copy: an unpublished list window.
pub fn coded(status: u16, code: &str) -> Response {
    json(
        status,
        vec![
            ("code", Json::str(code)),
            ("message", Json::str(user_copy(code))),
        ],
    )
}

/// 400 with a code and a fixed sentence (`matching.idempotency_key_invalid`, `matching.market_required`).
pub fn plain(status: u16, code: &str, message: &str) -> Response {
    json(
        status,
        vec![("code", Json::str(code)), ("message", Json::str(message))],
    )
}

/// The founder door with neither the edge secret nor the edge key: 503, and it reads nothing.
pub fn operator_auth_unconfigured() -> Response {
    plain(
        503,
        "matching.operator_auth_unconfigured",
        "EDGE_PRINCIPAL_SECRET is unpublished. The founder door does not read the book and does not halt.",
    )
}

/// No edge principal believed: 401 `token.invalid`, with why (`null` when none was sent).
pub fn principal_refused(rejected: Option<&str>) -> Response {
    json(
        401,
        vec![
            ("code", Json::str("token.invalid")),
            (
                "message",
                Json::str(rejected.map_or_else(
                    || "An edge-signed principal is required.".to_owned(),
                    |r| format!("Edge principal refused ({r})."),
                )),
            ),
            ("rejected", rejected.map_or(Json::Null, Json::str)),
        ],
    )
}

/// An `AuthError` from the principal's scope or second factor: 403 for `scope.denied`, else 401.
pub fn auth_error(code: &str, message: &str) -> Response {
    plain(
        if code == "scope.denied" { 403 } else { 401 },
        code,
        message,
    )
}

/// Fastify's answer to a path parameter over its 100 characters.
pub fn param_too_long(url: &str) -> Response {
    json(
        414,
        vec![
            ("error", Json::str("Bad Request")),
            ("code", Json::str("FST_ERR_MAX_PARAM_LENGTH")),
            (
                "message",
                Json::str(format!("'{url}' is exceeding the max param length")),
            ),
            ("statusCode", Json::int(414)),
        ],
    )
}

/// Fastify's 404 for a route nobody serves.
pub fn route_not_found(method: &str, url: &str) -> Response {
    json(
        404,
        vec![
            (
                "message",
                Json::str(format!("Route {method}:{url} not found")),
            ),
            ("error", Json::str("Not Found")),
            ("statusCode", Json::int(404)),
        ],
    )
}

/// Fastify's 500 for an error a handler threw.
pub fn thrown(message: &str) -> Response {
    json(
        500,
        vec![
            ("statusCode", Json::int(500)),
            ("error", Json::str("Internal Server Error")),
            ("message", Json::str(message)),
        ],
    )
}
