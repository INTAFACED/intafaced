//! svc-matching's served doors, as `index.ts` mounts them on its Fastify app: `/metrics` (`registerMetrics`),
//! `/health` (`registerHealth`), `/ready`, and every door of `registerRoutes` (`router.ts`). The door decides, in the
//! TypeScript's order:
//!
//! 1. the route (Fastify's 404 for any other, and its 414 for a path parameter over 100 characters);
//! 2. the body (`retainRawBody`'s JSON parser, keeping the exact bytes the signature binds);
//! 3. who is calling: a service's signature (`verifyServiceRequest`: its key, or the shared secret while the mode
//!    allows it) and the door's caller list (`requireTradingService`, `requireBasketChildService`); or, on the founder
//!    doors, the edge-signed principal and its scope (`founderPrincipal`);
//! 4. the door's input checks before it reaches the engine: its body schema (`door-inputs.ts`, `schemas.json`), the
//!    lifecycle proof's binding to the route and the order, the post-only rule, a list's published window, the
//!    position read's account, and the founder doors' idempotency key and market.
//!
//! Past those the call is its slice's: [`Outcome::Owed`] names which. Nothing here reads or moves a book.

pub mod book;
pub mod venue;

use std::sync::{LazyLock, Mutex, PoisonError};

use service_kit::edge::{self, EdgeKey};
use service_kit::json::{self, Json};
use service_kit::s2s::Mode;
use service_kit::s2s_verify::{self, BodyBind, Incoming, ServiceVerifier};
use service_kit::schema::{Outcome as Parsed, Schema, Value};
use service_kit::server::{Request, Response};
use service_kit::time::Instant;

use crate::engine::MatchingEngine;
use crate::errors;
use crate::refines::MatchingRefines;

/// The slices the port is cut into (`PORT.md`, `## Slices`): which one owes a call past the door.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Slice {
    Journal,
    Book,
    Serve,
    Triggers,
    Liquidity,
    Venue,
    Spreads,
    Rulebook,
    Operator,
}

impl Slice {
    pub const ALL: [Slice; 9] = [
        Slice::Journal,
        Slice::Book,
        Slice::Serve,
        Slice::Triggers,
        Slice::Liquidity,
        Slice::Venue,
        Slice::Spreads,
        Slice::Rulebook,
        Slice::Operator,
    ];

    /// Whether the port serves this slice's doors. The door answers them; the wire replay fails while any owes an
    /// answer.
    pub fn is_served(self) -> bool {
        matches!(self, Slice::Book | Slice::Venue)
    }

    /// The slice's name in `PORT.md`.
    pub fn name(self) -> &'static str {
        match self {
            Slice::Journal => "journal",
            Slice::Book => "book",
            Slice::Serve => "serve",
            Slice::Triggers => "triggers",
            Slice::Liquidity => "liquidity",
            Slice::Venue => "venue",
            Slice::Spreads => "spreads",
            Slice::Rulebook => "rulebook",
            Slice::Operator => "operator",
        }
    }
}

/// The book writes svc-trade alone may make (`TRADE_ONLY`).
pub const TRADE_ONLY: &[&str] = &["svc-trade"];
/// The writes a basket child or a FIX order may also make (`BASKET_CHILD_CALLERS`).
pub const BASKET_CHILD_CALLERS: &[&str] = &["svc-trade", "svc-execution", "svc-fix"];

/// The scope a founder door needs (`founderPrincipal(req, scope)`); `admin:write` also needs a second factor.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    Read,
    Write,
}

/// Who a door lets in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Guard {
    /// No one is checked: the public reads, `/health`, `/ready`, `/metrics`.
    Open,
    /// A service with a valid signature on this list.
    Service(&'static [&'static str]),
    /// An edge-signed founder principal with this scope.
    Founder(Scope),
}

/// The lifecycle proof's binding a door checks after its schema: the route parameter it must name, the action it must
/// carry, and the words each refusal says.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProofRule {
    /// The route parameter the snapshot's market must equal (`marketId`, or `spreadId` on a spread order).
    pub param: &'static str,
    /// The action it must carry; `None` is the submit's own rule (`PLACE_POST_ONLY` for `tif: PO` or `postOnly`).
    pub action: Option<&'static str>,
    /// What the action refusal ends with: `for this order`, `for this quote set`, `for a spread order`.
    pub what: &'static str,
}

/// What a door checks before its slice.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Input {
    /// Nothing.
    None,
    /// `schema.safeParse(req.body)`, then the proof's binding when it has one, and the submit's post-only rule.
    Body(&'static str, Option<ProofRule>),
    /// `schema.safeParse(req.body ?? {})`: the founder doors.
    BodyOrEmpty(&'static str),
    /// The founder mutations: `founderBody` on `req.body ?? {}`, the idempotency key, and the market when it needs one.
    Founder { needs_market: bool },
    /// `parsePublicL2QueryLimit(query.limit)`: unpublished answers 400 with this code.
    Limit(&'static str),
    /// `/markets/:marketId/positions/:accountId`: the account is 1 to 128 characters.
    Account,
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

const L2: &str = "matching.l2_limit_unset";
const L3: &str = "matching.l3_depth_limit_unset";
const RESTING: &str = "matching.resting_orders_limit_unset";
const CASES: &str = "matching.surveillance_cases_limit_unset";

const fn route(
    method: &'static str,
    path: &'static str,
    guard: Guard,
    input: Input,
    slice: Slice,
) -> Route {
    Route {
        method,
        path,
        guard,
        input,
        slice,
    }
}

const fn open(path: &'static str, input: Input, slice: Slice) -> Route {
    route("GET", path, Guard::Open, input, slice)
}

const fn trade(path: &'static str, input: Input, slice: Slice) -> Route {
    route("POST", path, Guard::Service(TRADE_ONLY), input, slice)
}

const KILL: Input = Input::Body("venueKill", None);
const fn proof(param: &'static str, action: &'static str, what: &'static str) -> Option<ProofRule> {
    Some(ProofRule {
        param,
        action: Some(action),
        what,
    })
}

use Slice::{Book, Liquidity, Operator, Rulebook, Serve, Spreads, Triggers, Venue};

/// Every route `index.ts` serves, in its order of registration.
pub const ROUTES: [Route; 46] = [
    open("/metrics", Input::None, Serve),
    open("/health", Input::None, Serve),
    open("/ready", Input::None, Serve),
    route(
        "POST",
        "/markets/:marketId/orders",
        Guard::Service(BASKET_CHILD_CALLERS),
        Input::Body(
            "submit",
            Some(ProofRule {
                param: "marketId",
                action: None,
                what: "for this order",
            }),
        ),
        Book,
    ),
    trade(
        "/markets/:marketId/positions/close",
        Input::Body(
            "closePosition",
            proof("marketId", "PLACE", "for this order"),
        ),
        Book,
    ),
    route(
        "GET",
        "/markets/:marketId/positions/:accountId",
        Guard::Service(TRADE_ONLY),
        Input::Account,
        Book,
    ),
    route(
        "PATCH",
        "/markets/:marketId/orders/:orderId",
        Guard::Service(TRADE_ONLY),
        Input::Body("amend", proof("marketId", "AMEND", "for this order")),
        Book,
    ),
    route(
        "POST",
        "/markets/:marketId/mark",
        Guard::Service(BASKET_CHILD_CALLERS),
        Input::Body("mark", None),
        Triggers,
    ),
    route(
        "DELETE",
        "/markets/:marketId/orders/:orderId",
        Guard::Service(BASKET_CHILD_CALLERS),
        Input::None,
        Book,
    ),
    trade(
        "/markets/:marketId/orders/mass-cancel",
        Input::Body("massCancel", None),
        Book,
    ),
    trade(
        "/markets/:marketId/mass-quote",
        Input::Body(
            "massQuote",
            proof("marketId", "PLACE", "for this quote set"),
        ),
        Liquidity,
    ),
    trade("/markets/:marketId/halt", KILL, Venue),
    trade("/markets/:marketId/resume", KILL, Venue),
    trade("/halt-all", KILL, Venue),
    trade("/resume-all", KILL, Venue),
    route(
        "POST",
        "/session/dead",
        Guard::Service(BASKET_CHILD_CALLERS),
        Input::Body("sessionDead", None),
        Venue,
    ),
    trade("/markets/:marketId/reduce-only", KILL, Venue),
    trade("/markets/:marketId/reduce-only/resume", KILL, Venue),
    trade("/markets/:marketId/post-only", KILL, Venue),
    trade("/markets/:marketId/post-only/resume", KILL, Venue),
    trade("/markets/:marketId/prelaunch", KILL, Venue),
    trade("/markets/:marketId/open", KILL, Venue),
    trade("/markets/:marketId/expire", KILL, Venue),
    trade("/markets/:marketId/delist", KILL, Venue),
    open("/markets/:marketId/depth/l3", Input::Limit(L3), Book),
    open("/markets/:marketId/depth/sbe", Input::Limit(L2), Book),
    open("/markets/:marketId/depth", Input::Limit(L2), Book),
    route(
        "GET",
        "/markets/:marketId/orders",
        Guard::Service(TRADE_ONLY),
        Input::Limit(RESTING),
        Book,
    ),
    trade("/reconcile", Input::Body("reconcile", None), Book),
    open("/markets", Input::None, Book),
    open("/spreads", Input::None, Spreads),
    open("/spreads/:spreadId/book", Input::Limit(L2), Spreads),
    trade(
        "/spreads/:spreadId/list",
        Input::Body("spreadList", None),
        Spreads,
    ),
    trade(
        "/spreads/:spreadId/orders",
        Input::Body(
            "spreadOrder",
            proof("spreadId", "PLACE", "for a spread order"),
        ),
        Spreads,
    ),
    open("/rulebook", Input::None, Rulebook),
    open("/rulebook/versions", Input::None, Rulebook),
    route(
        "GET",
        "/surveillance/cases",
        Guard::Service(TRADE_ONLY),
        Input::Limit(CASES),
        Venue,
    ),
    trade("/surveillance/adjudicate", Input::None, Venue),
    trade("/surveillance/fine", Input::None, Venue),
    route(
        "GET",
        "/operator/in-flight",
        Guard::Founder(Scope::Read),
        Input::None,
        Operator,
    ),
    route(
        "POST",
        "/operator/rulebook/check",
        Guard::Founder(Scope::Write),
        Input::BodyOrEmpty("rulebookDraft"),
        Rulebook,
    ),
    route(
        "POST",
        "/operator/rulebook/publish",
        Guard::Founder(Scope::Write),
        Input::BodyOrEmpty("rulebookPublish"),
        Rulebook,
    ),
    route(
        "POST",
        "/operator/halt",
        Guard::Founder(Scope::Write),
        Input::Founder { needs_market: true },
        Operator,
    ),
    route(
        "POST",
        "/operator/resume",
        Guard::Founder(Scope::Write),
        Input::Founder { needs_market: true },
        Operator,
    ),
    route(
        "POST",
        "/operator/halt-all",
        Guard::Founder(Scope::Write),
        Input::Founder {
            needs_market: false,
        },
        Operator,
    ),
    route(
        "POST",
        "/operator/resume-all",
        Guard::Founder(Scope::Write),
        Input::Founder {
            needs_market: false,
        },
        Operator,
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
    /// `index.ts` passes `require` whatever `INTERNAL_SERVICE_BODY_BIND` says: order writes are money instructions.
    pub body_bind: BodyBind,
    pub keys: Option<Keys>,
    /// `EDGE_PRINCIPAL_SECRET`: the founder doors' shared secret with the edge.
    pub edge_secret: Option<String>,
    /// `EDGE_PRINCIPAL_PUBLIC_KEY` and its limits.
    pub edge_key: Option<EdgeKey>,
    /// Milliseconds since the epoch.
    pub clock: fn() -> i64,
}

/// The door.
pub struct MatchingDoor {
    cfg: DoorConfig,
    engine: Mutex<MatchingEngine>,
    venue: venue::VenueConfig,
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

/// The recorded schema of door input `name`, run on `value`: its verdict, or the message of a refine that threw.
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
        .parse(root, value, &MatchingRefines)
        .map_err(|t| t.0)
}

/// Fastify's `maxParamLength`.
const MAX_PARAM_LENGTH: usize = 100;

/// A body as the handler sees it: absent (`undefined`) or the value parsed.
#[derive(Debug, Clone, PartialEq)]
enum Body {
    Absent,
    Parsed(Json),
}

impl Body {
    fn value(&self) -> Value {
        match self {
            Body::Absent => Value::Undefined,
            Body::Parsed(j) => Value::from_json(j),
        }
    }

    /// `req.body ?? {}`.
    fn or_empty(&self) -> Value {
        match self {
            Body::Absent | Body::Parsed(Json::Null) => Value::Object(Vec::new()),
            Body::Parsed(j) => Value::from_json(j),
        }
    }
}

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

/// The parsed body and the bytes the S2S verifier checks: a bodyless request is the empty body (`rawBodyOf`); a JSON
/// body is its exact bytes; any other is Fastify's refusal.
fn read_body(req: &Request<'_>) -> Result<(Body, Vec<u8>), Response> {
    let Some(content_type) = service_kit::trpc::header(req, "content-type") else {
        if req.body.is_empty() || req.method == "GET" || req.method == "HEAD" {
            return Ok((Body::Absent, Vec::new()));
        }
        return Err(fastify_error(
            415,
            "FST_ERR_CTP_INVALID_MEDIA_TYPE",
            "Unsupported Media Type",
            "Unsupported Media Type",
        ));
    };
    if req.method == "GET" || req.method == "HEAD" {
        return Ok((Body::Absent, Vec::new()));
    }
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
                Ok(v) if !poisoned(&v) => Ok((Body::Parsed(v), req.body.as_bytes().to_vec())),
                _ => Err(fastify_error(
                    400,
                    "FST_ERR_CTP_INVALID_JSON_BODY",
                    "Bad Request",
                    "Body is not valid JSON but content-type is set to 'application/json'",
                )),
            }
        }
        _ => Err(fastify_error(
            415,
            "FST_ERR_CTP_INVALID_MEDIA_TYPE",
            "Unsupported Media Type",
            "Unsupported Media Type",
        )),
    }
}

/// How many path segments a route names exactly: Fastify prefers a static segment over a parameter.
fn statics(r: &Route) -> usize {
    r.path.split('/').filter(|p| !p.starts_with(':')).count()
}

/// A path parameter: its name, as sent, and decoded.
type Param = (&'static str, String, String);

/// The route a method and path match, with the path's parameters.
fn find(method: &str, path: &str) -> Option<(&'static Route, Vec<Param>)> {
    let segments: Vec<&str> = path.split('/').collect();
    let mut found: Option<(&'static Route, Vec<Param>)> = None;
    for r in ROUTES
        .iter()
        .filter(|r| r.method == method || (method == "HEAD" && r.method == "GET"))
    {
        let pattern: Vec<&str> = r.path.split('/').collect();
        if pattern.len() != segments.len() {
            continue;
        }
        let mut params = Vec::new();
        let matched = pattern.iter().zip(&segments).all(|(p, s)| {
            if let Some(name) = p.strip_prefix(':') {
                if s.is_empty() {
                    return false;
                }
                params.push((
                    name,
                    (*s).to_owned(),
                    service_kit::trpc::percent_decode(s, false),
                ));
                true
            } else {
                p == s
            }
        });
        if matched && found.as_ref().is_none_or(|(f, _)| statics(r) > statics(f)) {
            found = Some((r, params));
        }
    }
    found
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

/// `parsePublicL2QueryLimit`: 1 to 500, digits only after a trim; anything else is unpublished.
pub fn published_limit(raw: &str) -> Option<u32> {
    let t = service_kit::schema::js_trim(raw);
    if t.is_empty() || !t.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let digits = t.trim_start_matches('0');
    if digits.len() > 3 {
        return None;
    }
    let n: u32 = if digits.is_empty() {
        0
    } else {
        digits.parse().ok()?
    };
    (1..=500).contains(&n).then_some(n)
}

/// `idempotencyKeyOrNull`: a string of 8 to 200 characters after a trim.
fn idempotency_key_ok(v: &Value) -> bool {
    match v {
        Value::String(s) => {
            let n = service_kit::s2s::js_length(service_kit::schema::js_trim(s));
            (8..=200).contains(&n)
        }
        _ => false,
    }
}

fn answer(r: Response) -> Outcome {
    Outcome::Answer(r)
}

impl MatchingDoor {
    /// The door over the one engine every slice reaches the books through; fails when the recorded schemas do not
    /// read.
    pub fn new(cfg: DoorConfig, engine: MatchingEngine) -> Result<MatchingDoor, String> {
        INPUTS.as_ref().map_err(Clone::clone)?;
        Ok(MatchingDoor {
            cfg,
            engine: Mutex::new(engine),
            venue: venue::VenueConfig {
                approvals: Box::new(crate::approval::Unwired),
                operator_ids: std::collections::HashSet::new(),
            },
        })
    }

    /// The venue doors' approvals and operator list (`options.approvals`, `options.operatorIds`). Without this call
    /// they are `index.ts`'s on an empty environment: the unwired consumer, and nobody an operator.
    pub fn with_venue(mut self, venue: venue::VenueConfig) -> MatchingDoor {
        self.venue = venue;
        self
    }

    /// Decides one request, or names the slice that owes its answer.
    pub fn decide(&self, req: &Request<'_>) -> Outcome {
        let path = req.url.split_once('?').map_or(req.url, |(p, _)| p);
        let Some((route, params)) = find(req.method, path) else {
            return answer(errors::route_not_found(req.method, req.url));
        };
        if params
            .iter()
            .any(|(_, raw, _)| raw.len() > MAX_PARAM_LENGTH)
        {
            return answer(errors::param_too_long(req.url));
        }
        let (body, raw) = match read_body(req) {
            Ok(b) => b,
            Err(refused) => return answer(refused),
        };
        let checked = match route.guard {
            Guard::Open => Ok(()),
            Guard::Service(allowed) => self.service(req, allowed, &raw),
            Guard::Founder(scope) => self.founder(req, scope),
        };
        if let Err(refused) = checked {
            return answer(refused);
        }
        let parsed = match input(req, route, &body, &params) {
            Ok(parsed) => parsed,
            Err(refused) => return answer(refused),
        };
        if !route.slice.is_served() {
            return Outcome::Owed(route.slice);
        }
        let param = |name: &str| {
            params
                .iter()
                .find(|(n, _, _)| *n == name)
                .map_or_else(String::new, |(_, _, v)| v.clone())
        };
        let mut engine = self.engine.lock().unwrap_or_else(PoisonError::into_inner);
        if route.slice == Slice::Venue {
            return venue::serve(&self.venue, route, req, &param, &parsed, &mut engine);
        }
        book::serve(route, req, &param, &parsed, &mut engine)
    }

    /// The engine, for what runs beside the doors (the cold start, the tests).
    pub fn engine(&self) -> std::sync::MutexGuard<'_, MatchingEngine> {
        self.engine.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// `requireService`: a verified caller on the door's list, else 401 (with why) or 403.
    fn service(&self, req: &Request<'_>, allowed: &[&str], raw: &[u8]) -> Result<(), Response> {
        let incoming = Incoming {
            method: req.method,
            url: req.url,
            headers: req.headers,
            body: Some(raw),
        };
        let keys = self.cfg.keys.as_ref();
        let auth = s2s_verify::verify_request(
            &incoming,
            keys.map(|k| &k.verifier),
            Some(&self.cfg.internal_secret),
            keys.map_or(Mode::Dual, |k| k.mode),
            self.cfg.body_bind,
            (self.cfg.clock)().div_euclid(1000),
        );
        match auth.service {
            Some(service) if allowed.contains(&service.as_str()) => Ok(()),
            Some(_) => Err(errors::forbidden()),
            None => Err(errors::unauthenticated(
                auth.rejected.unwrap_or("unauthenticated"),
            )),
        }
    }

    /// `founderPrincipal(req, scope)`: the edge principal, believed, with the door's scope.
    fn founder(&self, req: &Request<'_>, scope: Scope) -> Result<(), Response> {
        if self.cfg.edge_secret.is_none() && self.cfg.edge_key.is_none() {
            return Err(errors::operator_auth_unconfigured());
        }
        let header = |name: &str| service_kit::trpc::header(req, name);
        let region = header("x-intafaced-region").unwrap_or_else(|| "XX".to_owned());
        let principal = edge::verify_reason(
            header("x-intafaced-principal").as_deref(),
            header("x-intafaced-principal-sig").as_deref(),
            self.cfg.edge_secret.as_deref(),
            self.cfg.edge_key.as_ref(),
            Instant((self.cfg.clock)()),
            &region,
        )
        .map_err(|r| errors::principal_refused(r.word()))?;
        let refused = |r: service_kit::access::Refused| errors::auth_error(&r.code, &r.message);
        match scope {
            Scope::Read => {
                service_kit::access::require_scope(&principal, "admin:read").map_err(refused)
            }
            Scope::Write => {
                service_kit::access::require_scope(&principal, "admin:write").map_err(refused)?;
                service_kit::access::require_mfa(&principal).map_err(refused)
            }
        }
    }
}

/// The door's input checks, after the caller is let in.
fn input(
    req: &Request<'_>,
    route: &Route,
    body: &Body,
    params: &[Param],
) -> Result<Value, Response> {
    let param = |name: &str| {
        params
            .iter()
            .find(|(n, _, _)| *n == name)
            .map_or("", |(_, _, v)| v.as_str())
    };
    match route.input {
        Input::None => Ok(Value::Undefined),
        Input::Account => {
            let n = service_kit::s2s::js_length(param("accountId"));
            if (1..=128).contains(&n) {
                Ok(Value::Undefined)
            } else {
                Err(errors::bad_request(vec![
                    "accountId: must be 1 to 128 characters".to_owned(),
                ]))
            }
        }
        Input::Limit(code) => {
            let q = query(req.url);
            match q.iter().find(|(k, _)| k == "limit").map(|(_, v)| v) {
                None => Err(errors::coded(400, code)),
                Some(Json::String(raw)) => published_limit(raw)
                    .map(|_| Value::Undefined)
                    .ok_or_else(|| errors::coded(400, code)),
                // A repeated `limit` is a list, and `raw.trim` is not a function on it.
                Some(_) => Err(errors::thrown("raw.trim is not a function")),
            }
        }
        Input::Body(name, rule) => {
            let parsed = checked(name, body.value())?;
            if name == "submit" {
                post_only(&parsed)?;
            }
            if let Some(rule) = rule {
                bound(&parsed, rule, param(rule.param))?;
            }
            Ok(parsed)
        }
        Input::BodyOrEmpty(name) => checked(name, body.or_empty()),
        Input::Founder { needs_market } => {
            let parsed = checked("founder", body.or_empty())?;
            if !idempotency_key_ok(parsed.get("idempotencyKey")) {
                return Err(errors::plain(
                    400,
                    "matching.idempotency_key_invalid",
                    "idempotencyKey must be 8 to 200 characters",
                ));
            }
            let market = parsed.get("marketId").as_str().unwrap_or("");
            if needs_market && market.is_empty() {
                return Err(errors::plain(
                    400,
                    "matching.market_required",
                    "marketId is required for this door",
                ));
            }
            Ok(parsed)
        }
    }
}

/// `schema.safeParse(value)`: the parsed value, or 400 `BadRequest` with each issue; a refine that throws escapes the
/// handler as Fastify's 500.
fn checked(name: &str, value: Value) -> Result<Value, Response> {
    match parse(name, value) {
        Ok(Parsed::Ok(v)) => Ok(v),
        Ok(Parsed::Issues(issues)) => Err(errors::bad_request(
            issues.iter().map(errors::issue_line).collect(),
        )),
        Err(thrown) => Err(errors::thrown(&thrown)),
    }
}

/// `postOnlyCannotRest`: a post-only order with an immediate time-in-force.
fn post_only(parsed: &Value) -> Result<(), Response> {
    let tif = parsed.get("tif").as_str().unwrap_or("");
    if matches!(parsed.get("postOnly"), Value::Bool(true)) && (tif == "IOC" || tif == "FOK") {
        return Err(errors::bad_request(vec![
            "postOnly cannot rest an immediate time-in-force; the engine does not invent a price"
                .to_owned(),
        ]));
    }
    Ok(())
}

/// The lifecycle proof names the route's market and the action this door needs.
fn bound(parsed: &Value, rule: ProofRule, route_value: &str) -> Result<(), Response> {
    let proof = parsed.get("lifecycleProof");
    let expected = rule.action.unwrap_or_else(|| {
        let po = parsed.get("tif").as_str() == Some("PO")
            || matches!(parsed.get("postOnly"), Value::Bool(true));
        if po { "PLACE_POST_ONLY" } else { "PLACE" }
    });
    let mut issues = Vec::new();
    if proof.get("snapshot").get("marketId").as_str() != Some(route_value) {
        issues.push(format!(
            "lifecycleProof.snapshot.marketId: must match the route {}",
            rule.param
        ));
    }
    if proof.get("action").as_str() != Some(expected) {
        issues.push(format!(
            "lifecycleProof.action: must be {expected} {}",
            rule.what
        ));
    }
    if issues.is_empty() {
        Ok(())
    } else {
        Err(errors::bad_request(issues))
    }
}

/// What a call past the door answers until its slice is ported: 503, and which slice owes it.
pub fn not_ported(slice: Slice) -> Response {
    let body = Json::Object(vec![
        (
            "message".to_owned(),
            Json::str(format!(
                "svc-matching's Rust port does not serve this yet (slice {})",
                slice.name()
            )),
        ),
        ("code".to_owned(), Json::str("matching.not_ported")),
    ]);
    Response {
        status: 503,
        body: body.compact(),
    }
}
