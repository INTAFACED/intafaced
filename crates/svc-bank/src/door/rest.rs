//! The REST doors `index.ts` mounts through an exported register function, each answered as far as its first checks:
//! Fastify's body parser, the signing service (`verifyServiceRequest`, the body always bound), the one service the
//! door is for, and the body's own check. Past those a door is owed by its slice, as a tRPC call is.
//!
//! - `POST /internal/closure-check` (`closure/closure-check.ts`): svc-identity, `parseClosureCheckBody`.
//! - `POST /internal/agents/team-membership` (`agents/team-membership.ts`): svc-agents,
//!   `agentsTeamMembershipRequestSchema`.
//! - `POST /internal/agents/usage-payment` (`agents/usage-payment.ts`): svc-agents, `agentsUsagePaymentRequestSchema`.
//!
//! The two contract schemas are recorded with the tRPC inputs (`schemas.json`, under the door's name) and held by
//! `tests/input_parity.rs`; the closure check's own parser is written here, held by `tests/closure_body.rs`.

use service_kit::json::{self, Json};
use service_kit::s2s_verify::BodyBind;
use service_kit::schema::Value;
use service_kit::server::{Request, Response};

use super::{BankDoor, Slice, inputs};

/// One REST door.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RestDoor {
    pub path: &'static str,
    /// The only service it answers.
    pub caller: &'static str,
    /// Its refusal of any other signed service.
    pub forbidden: (&'static str, &'static str),
    /// Its refusal of a body that is not in shape.
    pub invalid: (&'static str, &'static str),
    pub body: BodyCheck,
    pub slice: Slice,
}

/// How a door reads its body.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BodyCheck {
    /// `parseClosureCheckBody`.
    ClosureCheck,
    /// A recorded zod schema, by the door's name in `schemas.json`.
    Schema,
}

/// The doors, in the order `index.ts` registers them.
pub const DOORS: [RestDoor; 3] = [
    RestDoor {
        path: "/internal/closure-check",
        caller: "svc-identity",
        forbidden: (
            "closure check is for the identity service only",
            "bank.closure_check_forbidden",
        ),
        invalid: ("closure check input is invalid", "bank.closure_check_input"),
        body: BodyCheck::ClosureCheck,
        slice: Slice::PartnerAccount,
    },
    RestDoor {
        path: "/internal/agents/team-membership",
        caller: "svc-agents",
        forbidden: (
            "business team read is for the agents service only",
            "bank.team_membership_forbidden",
        ),
        invalid: (
            "team membership request is invalid",
            "bank.team_membership_input",
        ),
        body: BodyCheck::Schema,
        slice: Slice::Business,
    },
    RestDoor {
        path: "/internal/agents/usage-payment",
        caller: "svc-agents",
        forbidden: (
            "agent usage payment is for the agents service only",
            "bank.usage_payment_forbidden",
        ),
        invalid: (
            "usage payment request is invalid",
            "bank.usage_payment_input",
        ),
        body: BodyCheck::Schema,
        slice: Slice::Partner,
    },
];

impl RestDoor {
    /// The door's name, as the wire replay and `schemas.json` name it.
    pub fn name(&self) -> String {
        format!("POST {}", self.path)
    }
}

pub(super) fn reply(status: u16, error: &str, code: &str) -> Response {
    Response {
        status,
        body: Json::obj([("error", Json::str(error)), ("code", Json::str(code))]).compact(),
    }
}

pub(super) fn fastify_error(status: u16, code: &str, error: &str, message: &str) -> Response {
    Response {
        status,
        body: Json::obj([
            ("statusCode", Json::int(i64::from(status))),
            ("code", Json::str(code)),
            ("error", Json::str(error)),
            ("message", Json::str(message)),
        ])
        .compact(),
    }
}

/// `assertNoPrototypePoison`: an own `__proto__` key anywhere, or a `constructor` object with its own `prototype`.
fn poisoned(v: &Json) -> bool {
    match v {
        Json::Object(fields) => fields.iter().any(|(k, child)| {
            k == "__proto__"
                || (k == "constructor"
                    && matches!(child, Json::Object(c) if c.iter().any(|(ck, _)| ck == "prototype")))
                || poisoned(child)
        }),
        Json::Array(items) => items.iter().any(poisoned),
        _ => false,
    }
}

/// Fastify's body parsers: the body as the handler reads it (`undefined` when absent), or Fastify's refusal.
pub(crate) fn read_body(req: &Request<'_>) -> Result<Value, Response> {
    let unsupported = || {
        fastify_error(
            415,
            "FST_ERR_CTP_INVALID_MEDIA_TYPE",
            "Unsupported Media Type",
            "Unsupported Media Type",
        )
    };
    let Some(content_type) = service_kit::trpc::header(req, "content-type") else {
        return if req.body.is_empty() {
            Ok(Value::Undefined)
        } else {
            Err(unsupported())
        };
    };
    let media = content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    match media.as_str() {
        "application/json" => {
            if req.body.is_empty() {
                return Err(fastify_error(
                    400,
                    "FST_ERR_CTP_EMPTY_JSON_BODY",
                    "Bad Request",
                    "Body cannot be empty when content-type is set to 'application/json'",
                ));
            }
            match json::parse(req.body) {
                Ok(v) if !poisoned(&v) => Ok(Value::from_json(&v)),
                _ => Err(fastify_error(
                    400,
                    "FST_ERR_CTP_INVALID_JSON_BODY",
                    "Bad Request",
                    "Body is not valid JSON but content-type is set to 'application/json'",
                )),
            }
        }
        "text/plain" => Ok(Value::String(req.body.to_owned())),
        _ => Err(unsupported()),
    }
}

/// What a `/trpc` request is answered before anything else reads it: Fastify's body parsers as the tRPC plugin sets
/// them (JSON and multipart kept as text, Fastify's own text parser, anything else its 415), then tRPC's
/// `getRequestInfo`, which serves a call other than a GET only in JSON (multipart, which no call takes, is not
/// modelled). tRPC answers before it makes the context, so its refusal names no path and no request.
pub(crate) fn trpc_media(req: &Request<'_>, dev: bool) -> Option<Response> {
    let unsupported = || {
        fastify_error(
            415,
            "FST_ERR_CTP_INVALID_MEDIA_TYPE",
            "Unsupported Media Type",
            "Unsupported Media Type",
        )
    };
    let content_type = service_kit::trpc::header(req, "content-type");
    let media = content_type.as_deref().map(|c| {
        c.split(';')
            .next()
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase()
    });
    match media.as_deref() {
        None if !req.body.is_empty() => return Some(unsupported()),
        None | Some("application/json" | "multipart/form-data" | "text/plain") => {}
        Some(_) => return Some(unsupported()),
    }
    if req.method == "GET"
        || matches!(
            media.as_deref(),
            Some("application/json" | "multipart/form-data")
        )
    {
        return None;
    }
    let message = content_type.map_or_else(
        || "Missing content-type header".to_owned(),
        // tRPC's own words, its missing closing quote included.
        |c| format!("Unsupported content-type \"{c}"),
    );
    let mut data = vec![
        ("code".to_owned(), Json::str("UNSUPPORTED_MEDIA_TYPE")),
        ("httpStatus".to_owned(), Json::int(415)),
    ];
    if dev {
        data.push((
            "stack".to_owned(),
            Json::str(format!("TRPCError: {message}\n    at svc-bank (Rust)")),
        ));
    }
    Some(Response {
        status: 415,
        body: Json::obj([(
            "error",
            Json::obj([
                ("message", Json::str(message)),
                ("code", Json::int(-32015)),
                ("data", Json::Object(data)),
            ]),
        )])
        .compact(),
    })
}

/// `UUID` of `closure-check.ts`: any case, versions 1 to 8, the RFC variant.
fn is_uuid(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 36 {
        return false;
    }
    b.iter().enumerate().all(|(i, c)| match i {
        8 | 13 | 18 | 23 => *c == b'-',
        14 => (b'1'..=b'8').contains(c),
        19 => matches!(c.to_ascii_lowercase(), b'8' | b'9' | b'a' | b'b'),
        _ => c.is_ascii_hexdigit(),
    })
}

/// The most sub-accounts one closure check names (`MAX_SUB_ACCOUNTS`).
const MAX_SUB_ACCOUNTS: usize = 100;

/// `parseClosureCheckBody`: whether the body is a closure check (the parsed check itself is the slice's).
pub fn closure_body_ok(body: &Value) -> bool {
    if !matches!(body, Value::Object(_)) {
        return false;
    }
    let scope = body.get("scope");
    if !matches!(scope, Value::Undefined)
        && scope.as_str() != Some("account")
        && scope.as_str() != Some("sub_accounts")
    {
        return false;
    }
    let sub_only = scope.as_str() == Some("sub_accounts");
    let Some(user) = body.get("userId").as_str().filter(|u| is_uuid(u)) else {
        return false;
    };
    let Some(ids) = body.get("subAccountIds").as_array() else {
        return false;
    };
    if ids.len() > MAX_SUB_ACCOUNTS {
        return false;
    }
    let mut lower = Vec::new();
    for id in ids {
        let Some(id) = id.as_str().filter(|i| is_uuid(i)) else {
            return false;
        };
        lower.push(id.to_ascii_lowercase());
    }
    let user = user.to_ascii_lowercase();
    !(sub_only && lower.iter().all(|id| *id == user))
}

/// The door's body check: whether the body is in shape.
fn body_ok(door: &RestDoor, body: &Value) -> Result<bool, String> {
    match door.body {
        BodyCheck::ClosureCheck => Ok(closure_body_ok(body)),
        BodyCheck::Schema => Ok(inputs::parse_named(&door.name(), body.clone())?.is_ok()),
    }
}

/// The REST door a request is for, answered as far as its first checks; `None` when it is for no REST door.
pub fn answer(door: &BankDoor, req: &Request<'_>) -> Option<Response> {
    if req.method != "POST" {
        return None;
    }
    let path = req.url.split_once('?').map_or(req.url, |(p, _)| p);
    let rest = DOORS.iter().find(|d| d.path == path)?;
    let body = match read_body(req) {
        Ok(b) => b,
        Err(res) => return Some(res),
    };
    let Some(caller) = door.service(req, BodyBind::Require) else {
        return Some(reply(
            401,
            "service credentials required",
            "bank.unauthenticated",
        ));
    };
    if caller != rest.caller {
        return Some(reply(403, rest.forbidden.0, rest.forbidden.1));
    }
    Some(match body_ok(rest, &body) {
        Ok(true) if rest.slice == Slice::Partner => {
            let parsed = inputs::parse_named(&rest.name(), body)
                .ok()
                .and_then(Result::ok)
                .unwrap_or(Value::Undefined);
            crate::partner::usage_payment::answer(door.partner(), door.store(), &parsed, door.now())
        }
        Ok(true) => Response {
            status: 500,
            body: Json::obj([(
                "error",
                Json::str(format!(
                    "svc-bank in Rust: the {} slice is not ported",
                    rest.slice.name()
                )),
            )])
            .compact(),
        },
        Ok(false) => reply(400, rest.invalid.0, rest.invalid.1),
        Err(broken) => Response {
            status: 500,
            body: Json::obj([("error", Json::str(broken))]).compact(),
        },
    })
}
