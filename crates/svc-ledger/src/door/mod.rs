//! svc-ledger's served doors, as `index.ts` registers them on its Fastify app: the service doors
//! (`registerS2sHttp`, `s2s-http.ts`), the operator doors (`registerOperatorHttp`, `operator-http.ts`) and the status
//! doors (`registerLedgerStatusHttp`). The door decides, in the TypeScript's order:
//!
//! 1. the route (Fastify's 404 for any other);
//! 2. the body (`retainRawBody`'s JSON parser, keeping the exact bytes; Fastify's own text parser and its 415);
//! 3. who is calling: a service's signature (`verifyServiceRequest`: its key, or the shared secret while the mode
//!    allows it) and the door's caller list for a proven key; an operator's access token and the door's scopes;
//! 4. the door's first input check, where the handler parses its body, path or query with one schema before it
//!    reaches the ledger (`schemas.json`).
//!
//! Past those the call is its slice's: [`Outcome::Owed`] names which, until the slice is ported. Ported so far:
//! `/health` and `/ready` (the `store` slice, `crate::status`), the freeze doors (the `freeze` slice, `freeze.rs`) and
//! the history doors (the `history` slice, `history.rs`).

mod callers;
mod freeze;
mod history;

pub use callers::DOOR_CALLERS;

use std::sync::{Arc, LazyLock};

use service_kit::json::{self, Json};
use service_kit::s2s::Mode;
use service_kit::s2s_verify::{self, BodyBind, Incoming, ServiceVerifier};
use service_kit::schema::{self, Outcome as Parsed, Schema, Value};
use service_kit::server::{Door, Request, RequestIds, Response};
use service_kit::telemetry::Logger;
use service_kit::tokens::{self, TokenConfig};

use crate::approval::Approvals;
use crate::freeze::Bus;

use crate::errors::{self, Failure};
use crate::refines::LedgerRefines;

/// The slices the port is cut into (`PORT.md`, `## Slices`): which one owes a call past the door.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Slice {
    Store,
    Posting,
    PostRecipe,
    Balances,
    History,
    Assets,
    OpsReads,
    Reports,
    Freeze,
    Reconcile,
    Controls,
    Desk,
}

impl Slice {
    pub const ALL: [Slice; 12] = [
        Slice::Store,
        Slice::Posting,
        Slice::PostRecipe,
        Slice::Balances,
        Slice::History,
        Slice::Assets,
        Slice::OpsReads,
        Slice::Reports,
        Slice::Freeze,
        Slice::Reconcile,
        Slice::Controls,
        Slice::Desk,
    ];

    /// The slice's name in `PORT.md`.
    pub fn name(self) -> &'static str {
        match self {
            Slice::Store => "store",
            Slice::Posting => "posting",
            Slice::PostRecipe => "post-recipe",
            Slice::Balances => "balances",
            Slice::History => "history",
            Slice::Assets => "assets",
            Slice::OpsReads => "ops-reads",
            Slice::Reports => "reports",
            Slice::Freeze => "freeze",
            Slice::Reconcile => "reconcile",
            Slice::Controls => "controls",
            Slice::Desk => "desk",
        }
    }
}

/// Who may call an operator door (`registerOperatorHttp`'s `authorize`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Authority {
    /// `requireScope(principal, 'admin:treasury')`, which needs a second factor.
    Treasury,
    /// `requireLookupAuthority`: `admin:read` (or a scope implying it), then a second factor.
    Lookup,
    /// `requireControlList`: `admin:treasury` with a second factor, or `admin:compliance`.
    ControlList,
}

/// Where a door reads the input its first check parses.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Input {
    /// Nothing before the slice.
    None,
    /// A service door: `schema.parse(body)`; a refusal is a `ZodError` through `httpError`.
    Body(&'static str),
    /// An operator write: `schema.parse(body ?? {})`; a refusal is `guarded`'s 400 with the error's message.
    BodyOrEmpty(&'static str),
    /// An operator write: `schema.parse(body)`, an absent body included; a refusal as [`Input::BodyOrEmpty`]'s.
    OperatorBody(&'static str),
    /// An operator lookup: `schema.safeParse(<from the path or query>)`; a refusal is 400 with the door's sentence.
    Lookup(&'static str, LookupFrom, &'static str),
}

/// What an operator lookup's input is made of.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LookupFrom {
    /// `{ <name>: <path parameter> }`.
    Param(&'static str),
    /// `{ <name>: query.<name> }`.
    QueryOne(&'static str),
    /// `queryOf(req, keys)`: the named query keys that are set and not blank.
    Query(&'static [&'static str]),
    /// `{}`.
    Nothing,
}

/// Who a door lets in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Guard {
    /// No one is checked (`/health`, `/ready`).
    Open,
    /// A service door: its name in `LEDGER_DOOR_CALLERS`.
    Service(&'static str),
    Operator(Authority),
}

/// One served route.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Route {
    pub method: &'static str,
    /// Fastify's pattern: `:name` is one path segment.
    pub path: &'static str,
    pub guard: Guard,
    pub input: Input,
    pub slice: Slice,
}

const fn s2s(door: &'static str, path: &'static str, input: Input, slice: Slice) -> Route {
    Route {
        method: "POST",
        path,
        guard: Guard::Service(door),
        input,
        slice,
    }
}

const fn op(
    method: &'static str,
    path: &'static str,
    authority: Authority,
    input: Input,
    slice: Slice,
) -> Route {
    Route {
        method,
        path,
        guard: Guard::Operator(authority),
        input,
        slice,
    }
}

const TX: Input = Input::Lookup(
    "txGet",
    LookupFrom::Param("txId"),
    "A transaction id is a UUID.",
);
const TRACE: Input = Input::Lookup(
    "trace",
    LookupFrom::QueryOne("businessKey"),
    "A business key is 1 to 512 characters.",
);
const TX_LIST: Input = Input::Lookup(
    "txList",
    LookupFrom::Query(&["assetId", "from", "to", "before"]),
    "An asset is 1 to 32 characters, times are ISO 8601 with from before to, and the cursor is the one a page answered.",
);
const ACCOUNTS: Input = Input::Lookup(
    "accountSearch",
    LookupFrom::Query(&["prefix", "after"]),
    "An address prefix is an owner type, a colon, and the first 1 to 128 characters of the owner id.",
);
const STATS: Input = Input::Lookup("stats", LookupFrom::Nothing, "The counts take no input.");
const METADATA: Input = Input::Lookup(
    "metadataRead",
    LookupFrom::Param("accountId"),
    "An account id is a UUID.",
);

use Authority::{ControlList, Lookup, Treasury};
use Slice::{
    Assets, Balances, Controls, Desk, Freeze, History, OpsReads, PostRecipe, Posting, Reconcile,
    Reports, Store,
};

/// Every route `index.ts` serves but `/metrics`, in its order of registration.
pub const ROUTES: [Route; 44] = [
    Route {
        method: "GET",
        path: "/health",
        guard: Guard::Open,
        input: Input::None,
        slice: Store,
    },
    Route {
        method: "GET",
        path: "/ready",
        guard: Guard::Open,
        input: Input::None,
        slice: Store,
    },
    s2s("post", "/trpc/post", Input::Body("post"), Posting),
    s2s("postRecipe", "/trpc/postRecipe", Input::None, PostRecipe),
    s2s("balance", "/trpc/balance", Input::Body("balance"), Balances),
    s2s(
        "balances",
        "/trpc/balances",
        Input::Body("balances"),
        Balances,
    ),
    s2s("txByKey", "/trpc/txByKey", Input::Body("txByKey"), Balances),
    s2s("txById", "/trpc/txById", Input::Body("txById"), Balances),
    s2s("history", "/trpc/history", Input::Body("history"), History),
    s2s(
        "historyPage",
        "/trpc/historyPage",
        Input::Body("historyPage"),
        History,
    ),
    s2s(
        "holdingsHistory",
        "/trpc/holdingsHistory",
        Input::Body("holdingsHistory"),
        History,
    ),
    s2s("assetsList", "/trpc/assetsList", Input::None, Assets),
    s2s("assetsGet", "/trpc/assetsGet", Input::None, Assets),
    s2s("feeRevenue", "/trpc/feeRevenue", Input::None, OpsReads),
    s2s("ownFunds", "/trpc/ownFunds", Input::None, OpsReads),
    s2s(
        "restoreWatermark",
        "/trpc/restoreWatermark",
        Input::None,
        OpsReads,
    ),
    s2s(
        "reconciliationEvaluations",
        "/trpc/reconciliationEvaluations",
        Input::None,
        OpsReads,
    ),
    s2s(
        "transactionsExist",
        "/trpc/transactionsExist",
        Input::None,
        OpsReads,
    ),
    s2s(
        "portfolio",
        "/trpc/portfolio",
        Input::Body("portfolio"),
        Balances,
    ),
    s2s("statementPnl", "/trpc/statementPnl", Input::None, Reports),
    s2s("reportExport", "/trpc/reportExport", Input::None, Reports),
    s2s("custody", "/trpc/custody", Input::None, Reports),
    s2s("financeClose", "/trpc/financeClose", Input::None, Reports),
    s2s("resilience", "/trpc/resilience", Input::None, Reports),
    op("GET", "/operator/freeze", Treasury, Input::None, Freeze),
    op(
        "GET",
        "/operator/integrity/clock",
        Treasury,
        Input::None,
        Freeze,
    ),
    op(
        "POST",
        "/operator/freeze",
        Treasury,
        Input::OperatorBody("freeze"),
        Freeze,
    ),
    op(
        "POST",
        "/operator/unfreeze",
        Treasury,
        Input::BodyOrEmpty("unfreeze"),
        Freeze,
    ),
    op(
        "POST",
        "/operator/reconcile",
        Treasury,
        Input::BodyOrEmpty("reconcile"),
        Reconcile,
    ),
    op("GET", "/operator/transactions/:txId", Lookup, TX, Desk),
    op("GET", "/operator/trace", Lookup, TRACE, Desk),
    op("GET", "/operator/transactions", Lookup, TX_LIST, Desk),
    op("GET", "/operator/accounts", Lookup, ACCOUNTS, Desk),
    op("GET", "/operator/stats", Lookup, STATS, Desk),
    op(
        "GET",
        "/operator/accounts/:accountId/metadata",
        Lookup,
        METADATA,
        Desk,
    ),
    op(
        "POST",
        "/operator/accounts/:accountId/metadata/set",
        Treasury,
        Input::None,
        Desk,
    ),
    op(
        "POST",
        "/operator/accounts/:accountId/metadata/delete",
        Treasury,
        Input::None,
        Desk,
    ),
    op("GET", "/operator/assets", Treasury, Input::None, Assets),
    op(
        "POST",
        "/operator/assets/apply-edit",
        Treasury,
        Input::None,
        Assets,
    ),
    // The control doors check their source, then their input: both the reconcile slice's.
    op(
        "GET",
        "/operator/reconciliation/controls",
        ControlList,
        Input::None,
        Controls,
    ),
    op(
        "POST",
        "/operator/reconciliation/controls/runs",
        ControlList,
        Input::None,
        Controls,
    ),
    op(
        "POST",
        "/operator/reconciliation/controls",
        Treasury,
        Input::None,
        Controls,
    ),
    op(
        "POST",
        "/operator/reconciliation/controls/update",
        Treasury,
        Input::None,
        Controls,
    ),
    op(
        "POST",
        "/operator/reconciliation/controls/run",
        Treasury,
        Input::None,
        Controls,
    ),
];

/// The door's answer: decided here, or the named slice's to give.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    Answer(Response),
    Owed(Slice),
}

/// Per-service keys (S2S v3) and the mode they run in; none leaves every door on the shared secret alone.
pub struct Keys {
    pub verifier: ServiceVerifier,
    pub mode: Mode,
}

/// What the door is put together from, once, at start-up.
pub struct DoorConfig {
    /// `INTERNAL_SERVICE_SECRET`.
    pub internal_secret: String,
    /// `INTERNAL_SERVICE_BODY_BIND`, as `index.ts` passes it.
    pub body_bind: BodyBind,
    pub keys: Option<Keys>,
    /// The access tokens' key, issuer and audience (`JWT_*`).
    pub tokens: TokenConfig,
    /// Seconds since the epoch.
    pub clock: fn() -> i64,
    /// The book: one pool for every slice.
    pub store: crate::db::Store,
    /// `SERVICE_NAME`, as `/health` names it and as events name their producer.
    pub service_name: String,
    /// The event bus the outbox relays publish on.
    pub bus: Arc<dyn Bus>,
    /// The identity approvals the operator writes spend (`IDENTITY_URL`, or none).
    pub approvals: Box<dyn Approvals>,
    /// `LEDGER_CLOCK_SKEW_BOUND_MS`: none when the owner has not set it.
    pub clock_skew_bound_ms: Option<i64>,
    /// The wall clock in milliseconds.
    pub now_ms: fn() -> i64,
    /// `app.log`.
    pub log: Logger,
}

/// The door.
pub struct LedgerDoor {
    cfg: DoorConfig,
    ids: RequestIds,
}

/// The recorded input schemas and which part each door starts at.
struct Inputs {
    schema: Schema,
    roots: Vec<(String, usize)>,
}

static INPUTS: LazyLock<Result<Inputs, String>> = LazyLock::new(|| {
    let doc =
        json::parse(include_str!("schemas.json")).map_err(|e| format!("schemas.json: {e:?}"))?;
    let schema = Schema::from_json(&doc)?;
    let roots = match doc.get("inputs") {
        Some(Json::Object(o)) => o
            .iter()
            .map(|(k, v)| match v {
                Json::Number(n) => format!("{n}")
                    .parse::<usize>()
                    .map(|i| (k.clone(), i))
                    .map_err(|e| e.to_string()),
                _ => Err(format!("schemas.json: input {k} names no part")),
            })
            .collect::<Result<Vec<_>, _>>()?,
        _ => return Err("schemas.json: no inputs".to_owned()),
    };
    Ok(Inputs { schema, roots })
});

/// Fastify's error body: `{ statusCode, code, error, message }`.
fn fastify_error(status: u16, code: &str, error: &str, message: &str) -> Response {
    let body = Json::Object(vec![
        ("statusCode".to_owned(), Json::int(i64::from(status))),
        ("code".to_owned(), Json::str(code)),
        ("error".to_owned(), Json::str(error)),
        ("message".to_owned(), Json::str(message)),
    ]);
    Response {
        status,
        body: body.compact(),
    }
}

fn answer((status, body): (u16, Json)) -> Outcome {
    Outcome::Answer(Response {
        status,
        body: body.compact(),
    })
}

/// A body as the handler sees it: absent (`undefined`) or the value parsed.
#[derive(Debug, Clone, PartialEq)]
enum Body {
    Absent,
    Parsed(Json),
}

/// `assertNoPrototypePoison`: an own `__proto__` key anywhere, or a `constructor` object with its own `prototype`.
fn poisoned(v: &Json) -> bool {
    match v {
        Json::Object(fields) => fields.iter().any(|(k, child)| {
            k == "__proto__"
                || (k == "constructor" && matches!(child, Json::Object(c) if c.iter().any(|(ck, _)| ck == "prototype")))
                || poisoned(child)
        }),
        Json::Array(items) => items.iter().any(poisoned),
        _ => false,
    }
}

/// The parsed body and the bytes the S2S verifier may check (only `application/json` bodies are kept), or Fastify's
/// refusal.
fn read_body(req: &Request<'_>) -> Result<(Body, Option<Vec<u8>>), Response> {
    if req.method == "GET" || req.method == "HEAD" {
        return Ok((Body::Absent, None));
    }
    let content_type = service_kit::trpc::header(req, "content-type");
    let Some(content_type) = content_type else {
        if req.body.is_empty() {
            return Ok((Body::Absent, None));
        }
        return Err(fastify_error(
            415,
            "FST_ERR_CTP_INVALID_MEDIA_TYPE",
            "Unsupported Media Type",
            "Unsupported Media Type",
        ));
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
                Ok(v) if !poisoned(&v) => Ok((Body::Parsed(v), Some(req.body.as_bytes().to_vec()))),
                _ => Err(fastify_error(
                    400,
                    "FST_ERR_CTP_INVALID_JSON_BODY",
                    "Bad Request",
                    "Body is not valid JSON but content-type is set to 'application/json'",
                )),
            }
        }
        "text/plain" => Ok((Body::Parsed(Json::str(req.body)), None)),
        _ => Err(fastify_error(
            415,
            "FST_ERR_CTP_INVALID_MEDIA_TYPE",
            "Unsupported Media Type",
            "Unsupported Media Type",
        )),
    }
}

/// The route a method and path match, with the path's parameters.
fn find(method: &str, path: &str) -> Option<(&'static Route, Vec<(&'static str, String)>)> {
    let segments: Vec<&str> = path.split('/').collect();
    ROUTES
        .iter()
        .filter(|r| r.method == method || (method == "HEAD" && r.method == "GET"))
        .find_map(|r| {
            let pattern: Vec<&str> = r.path.split('/').collect();
            if pattern.len() != segments.len() {
                return None;
            }
            let mut params = Vec::new();
            for (p, s) in pattern.iter().zip(&segments) {
                if let Some(name) = p.strip_prefix(':') {
                    if s.is_empty() {
                        return None;
                    }
                    params.push((name, service_kit::trpc::percent_decode(s, false)));
                } else if p != s {
                    return None;
                }
            }
            Some((r, params))
        })
}

/// Node's `querystring.parse`: a repeated key is a list.
fn query(url: &str) -> Vec<(String, Json)> {
    let Some((_, q)) = url.split_once('?') else {
        return Vec::new();
    };
    let mut out: Vec<(String, Json)> = Vec::new();
    for pair in q.split('&').filter(|p| !p.is_empty()) {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        let (k, v) = (
            service_kit::trpc::percent_decode(k, true),
            service_kit::trpc::percent_decode(v, true),
        );
        match out.iter_mut().find(|(key, _)| *key == k) {
            Some((_, Json::Array(list))) => list.push(Json::String(v)),
            Some((_, slot)) => *slot = Json::Array(vec![slot.clone(), Json::String(v)]),
            None => out.push((k, Json::String(v))),
        }
    }
    out
}

fn callers_of(door: &str) -> &'static [&'static str] {
    DOOR_CALLERS
        .iter()
        .find(|(d, _)| *d == door)
        .map_or(&[], |(_, c)| c)
}

impl LedgerDoor {
    /// The door; fails when the recorded schemas do not read.
    pub fn new(cfg: DoorConfig) -> Result<LedgerDoor, String> {
        INPUTS.as_ref().map_err(Clone::clone)?;
        Ok(LedgerDoor {
            cfg,
            ids: RequestIds::new(),
        })
    }

    /// The book every slice reads and writes.
    pub fn store(&self) -> &crate::db::Store {
        &self.cfg.store
    }

    /// `sql.end()`.
    pub fn end(&self) {
        self.cfg.store.end();
    }

    /// A route the door opens to anyone: the store slice's status doors.
    fn open(&self, route: &Route) -> Outcome {
        match route.path {
            "/health" => Outcome::Answer(crate::status::health(
                &self.cfg.store,
                &self.cfg.service_name,
            )),
            "/ready" => Outcome::Answer(crate::status::ready(&self.cfg.store)),
            _ => Outcome::Owed(route.slice),
        }
    }

    /// Decides one request, or names the slice that owes its answer.
    pub fn decide(&self, req: &Request<'_>) -> Outcome {
        let path = req.url.split_once('?').map_or(req.url, |(p, _)| p);
        let Some((route, params)) = find(req.method, path) else {
            let body = Json::Object(vec![
                (
                    "message".to_owned(),
                    Json::str(format!("Route {}:{} not found", req.method, req.url)),
                ),
                ("error".to_owned(), Json::str("Not Found")),
                ("statusCode".to_owned(), Json::int(404)),
            ]);
            return Outcome::Answer(Response {
                status: 404,
                body: body.compact(),
            });
        };
        let (body, raw) = match read_body(req) {
            Ok(b) => b,
            Err(refused) => return Outcome::Answer(refused),
        };
        match route.guard {
            Guard::Open => self.open(route),
            Guard::Service(door) => self.service(req, route, door, &body, raw.as_deref()),
            Guard::Operator(authority) => self.operator(req, route, authority, &body, &params),
        }
    }

    /// `registerS2sHttp`'s `authenticate`, then the door's input.
    fn service(
        &self,
        req: &Request<'_>,
        route: &Route,
        door: &str,
        body: &Body,
        raw: Option<&[u8]>,
    ) -> Outcome {
        let incoming = Incoming {
            method: req.method,
            url: req.url,
            headers: req.headers,
            body: raw,
        };
        let keys = self.cfg.keys.as_ref();
        let auth = s2s_verify::verify_request(
            &incoming,
            keys.map(|k| &k.verifier),
            Some(&self.cfg.internal_secret),
            keys.map_or(Mode::Dual, |k| k.mode),
            self.cfg.body_bind,
            (self.cfg.clock)(),
        );
        let Some(service) = auth.service else {
            let reason = auth.rejected.unwrap_or("missing");
            return answer(errors::http_error(&Failure::ledger(
                errors::UNAUTHENTICATED,
                format!(
                    "Service credentials are required on the internal ledger API (§2): {reason}"
                ),
            )));
        };
        if auth.scheme == Some("keypair") && !callers_of(door).contains(&service.as_str()) {
            return answer(errors::http_error(&Failure::ledger(
                errors::CALLER_FORBIDDEN,
                format!("Caller {service} may not call {door}."),
            )));
        }
        let Input::Body(name) = route.input else {
            return Outcome::Owed(route.slice);
        };
        // `refuseHistoryCursor`: on the raw body, before the schema would strip the field.
        if door == "history"
            && let Body::Parsed(Json::Object(fields)) = body
            && let Some(f) =
                crate::history::page_socket_field(fields.iter().map(|(k, _)| k.as_str()))
        {
            return answer(errors::http_error(&crate::history::page_socket(f).into()));
        }
        let value = match body {
            Body::Absent => Value::Undefined,
            Body::Parsed(j) => Value::from_json(j),
        };
        match parse(name, value) {
            Ok(Parsed::Ok(input)) => match route.slice {
                Slice::History => Outcome::Answer(self.history_door(door, &input)),
                slice => Outcome::Owed(slice),
            },
            Ok(Parsed::Issues(issues)) => {
                answer(errors::http_error(&Failure::Zod(schema::message(&issues))))
            }
            // A refine that throws escapes `parse` as a plain error.
            Err(_) => answer(errors::http_error(&Failure::Fault)),
        }
    }

    /// `registerOperatorHttp`'s `guarded`: the token, the door's authority, then the door's input.
    fn operator(
        &self,
        req: &Request<'_>,
        route: &Route,
        authority: Authority,
        body: &Body,
        params: &[(&str, String)],
    ) -> Outcome {
        let header = service_kit::trpc::header(req, "authorization");
        let Some(token) = tokens::bearer_token(header.as_deref()) else {
            return answer(errors::auth_error(
                "An operator access token is required",
                "token.invalid",
            ));
        };
        let principal =
            match tokens::verify_access_token(&token, &self.cfg.tokens, (self.cfg.clock)()) {
                Ok(v) => v.principal,
                Err(e) => return answer(errors::auth_error(&e.message, e.code)),
            };
        if let Err((message, code)) = authorize(&principal, authority) {
            return answer(errors::auth_error(&message, &code));
        }
        let past = |input: Value| match route.slice {
            Slice::Freeze => {
                Outcome::Answer(self.freeze_door(route.method, route.path, &principal, &input))
            }
            slice => Outcome::Owed(slice),
        };
        match route.input {
            Input::None | Input::Body(_) => past(Value::Undefined),
            Input::BodyOrEmpty(name) | Input::OperatorBody(name) => {
                let value = match body {
                    Body::Absent | Body::Parsed(Json::Null)
                        if matches!(route.input, Input::BodyOrEmpty(_)) =>
                    {
                        Value::from_json(&Json::Object(Vec::new()))
                    }
                    Body::Absent => Value::Undefined,
                    Body::Parsed(j) => Value::from_json(j),
                };
                match parse(name, value) {
                    Ok(Parsed::Ok(input)) => past(input),
                    Ok(Parsed::Issues(issues)) => {
                        answer(errors::operator_failed(&schema::message(&issues)))
                    }
                    Err(thrown) => answer(errors::operator_failed(&thrown)),
                }
            }
            Input::Lookup(name, from, invalid) => {
                let q = query(req.url);
                let pick = |k: &str| q.iter().find(|(key, _)| key == k).map(|(_, v)| v.clone());
                let fields: Vec<(String, Json)> = match from {
                    LookupFrom::Param(p) => params
                        .iter()
                        .find(|(n, _)| *n == p)
                        .map(|(_, v)| vec![(p.to_owned(), Json::str(v.clone()))])
                        .unwrap_or_default(),
                    LookupFrom::QueryOne(k) => {
                        pick(k).map(|v| vec![(k.to_owned(), v)]).unwrap_or_default()
                    }
                    LookupFrom::Query(keys) => keys
                        .iter()
                        .filter_map(|k| {
                            pick(k)
                                .filter(|v| *v != Json::str(""))
                                .map(|v| ((*k).to_owned(), v))
                        })
                        .collect(),
                    LookupFrom::Nothing => Vec::new(),
                };
                match parse(name, Value::from_json(&Json::Object(fields))) {
                    Ok(Parsed::Ok(_)) => Outcome::Owed(route.slice),
                    _ => answer(errors::lookup_invalid(invalid)),
                }
            }
        }
    }
}

/// The recorded schema of door `name`, run on `value`: its verdict, or the message of a refine that threw.
pub fn parse(name: &str, value: Value) -> Result<Parsed, String> {
    let inputs = INPUTS.as_ref().map_err(Clone::clone)?;
    let root = inputs
        .roots
        .iter()
        .find(|(n, _)| n == name)
        .map(|(_, r)| *r)
        .ok_or_else(|| format!("no recorded input for {name}"))?;
    inputs
        .schema
        .parse(root, value, &LedgerRefines)
        .map_err(|t| t.0)
}

/// The doors' `authorize`: the refusal's message and code (`AuthError`).
fn authorize(
    p: &service_kit::edge::Principal,
    authority: Authority,
) -> Result<(), (String, String)> {
    use service_kit::access::{has_scope, require_mfa, require_scope};
    let refused = |r: service_kit::access::Refused| (r.message, r.code);
    match authority {
        Authority::Treasury => require_scope(p, "admin:treasury").map_err(refused),
        Authority::Lookup => {
            require_scope(p, "admin:read").map_err(refused)?;
            require_mfa(p).map_err(refused)
        }
        Authority::ControlList => {
            let mut saw_mfa = false;
            for scope in ["admin:treasury", "admin:compliance"] {
                if !has_scope(&p.scopes, scope) {
                    continue;
                }
                match require_scope(p, scope) {
                    Ok(()) => return Ok(()),
                    Err(r) if r.code == "mfa.required" => saw_mfa = true,
                    Err(_) => {}
                }
            }
            if saw_mfa {
                Err((
                    "A second factor is required".to_owned(),
                    "mfa.required".to_owned(),
                ))
            } else {
                Err((
                    "One of admin:treasury, admin:compliance is required".to_owned(),
                    "scope.denied".to_owned(),
                ))
            }
        }
    }
}

/// What a call past the door answers until its slice is ported: 503, and which slice owes it.
pub fn not_ported(slice: Slice) -> Response {
    let body = Json::Object(vec![
        (
            "message".to_owned(),
            Json::str(format!(
                "svc-ledger's Rust port does not serve this yet (slice {})",
                slice.name()
            )),
        ),
        ("code".to_owned(), Json::str("ledger.not_ported")),
    ]);
    Response {
        status: 503,
        body: body.compact(),
    }
}

impl Door for LedgerDoor {
    fn next_request_id(&self) -> String {
        self.ids.next()
    }

    /// The door's answer; a call its slice has not ported yet is [`not_ported`].
    fn handle_as(&self, req: &Request<'_>, _request_id: &str) -> Response {
        match self.decide(req) {
            Outcome::Answer(r) => r,
            Outcome::Owed(slice) => not_ported(slice),
        }
    }

    /// `/health` and `/ready` read the freeze from the book, so the door answers them, not the kit's fixed bodies.
    fn status(&self, req: &Request<'_>) -> Option<Response> {
        Some(self.handle_as(req, ""))
    }
}
