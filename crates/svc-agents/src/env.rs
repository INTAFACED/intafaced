//! svc-agents' environment (`services/svc-agents/src/env.ts`): `serviceEnvSchema` (base, postgres, redis, nats, otel,
//! http), `edgeEnvSchema`, `internalServiceEnvSchema` and `s2sEnvSchema` from `@intafaced/config` (the kit's slices,
//! `service_kit::env`), merged with svc-agents' own fields, loaded by `loadEnv` (which first refuses development
//! material in production posture). Same defaults, same blank-as-absent owner values, same refusals; every problem is
//! listed at once, in the schema's order.
//!
//! The loaded values are kept as the TypeScript's `env` object (`AgentsEnv::json`, in its key order), which
//! `tests/env_parity.rs` holds to the TypeScript's own answers; the typed accessors read from it.
//!
//! One wording is not the TypeScript's: a JSON syntax error in `AGENTS_UPSTREAM_HEADERS` or `AGENTS_UPSTREAM_MODELS`
//! other than an empty value is refused with the kit's parser's words, not V8's (`service_kit::trpc` keeps the same
//! gap). The boot still refuses; only the message differs.

use std::collections::BTreeMap;

use service_kit::env::{EnvError, Fields, REQUIRED_STRING, ServiceName, js_number, one_of};
use service_kit::json::{self, Json};
use service_kit::jsregex::Regex;
use service_kit::s2s::js_length;
use service_kit::schema::js_trim;

/// The service's default port (`HTTP_PORT`).
pub const DEFAULT_PORT: i64 = 4008;

/// The loaded environment.
#[derive(Debug, Clone, PartialEq)]
pub struct AgentsEnv {
    /// The TypeScript's `env`, key for key.
    pub json: Json,
    /// The whole process environment, for the jurisdiction guard's switches and lists.
    pub raw: BTreeMap<String, String>,
}

impl AgentsEnv {
    pub fn get(&self, key: &str) -> Option<&Json> {
        self.json.get(key)
    }

    /// A string value (`None` when unset).
    pub fn str(&self, key: &str) -> Option<&str> {
        match self.get(key) {
            Some(Json::String(s)) => Some(s),
            _ => None,
        }
    }

    /// An integer value (`None` when unset: an owner value not yet published).
    pub fn int(&self, key: &str) -> Option<i64> {
        match self.get(key) {
            Some(Json::Number(n)) => format!("{n}").parse().ok(),
            _ => None,
        }
    }

    /// A boolean value.
    pub fn flag(&self, key: &str) -> Option<bool> {
        match self.get(key) {
            Some(Json::Bool(b)) => Some(*b),
            _ => None,
        }
    }
}

const MAX_SAFE: f64 = 9_007_199_254_740_991.0;
const MIN_SAFE: f64 = -9_007_199_254_740_991.0;

/// `z.coerce.number().int().min(min).max(max)` on one string: the number when it is an integer (even out of range),
/// and every issue zod raises, in its order. The flag says whether an issue aborted the parse (no number to refine).
fn int_issues(raw: &str, min: i64, max: i64) -> (Option<i64>, Vec<String>, bool) {
    let Some(n) = js_number(raw) else {
        return (
            None,
            vec!["Invalid input: expected number, received NaN".to_owned()],
            true,
        );
    };
    if n.is_infinite() {
        let shown = if n > 0.0 { "Infinity" } else { "-Infinity" };
        return (
            None,
            vec![format!("Invalid input: expected number, received {shown}")],
            true,
        );
    }
    if n.fract() != 0.0 {
        return (
            None,
            vec!["Invalid input: expected int, received number".to_owned()],
            true,
        );
    }
    let mut issues = Vec::new();
    if n > MAX_SAFE {
        issues.push("Too big: expected int to be <=9007199254740991".to_owned());
    } else if n < MIN_SAFE {
        issues.push("Too small: expected int to be >=-9007199254740991".to_owned());
    }
    #[expect(clippy::cast_precision_loss, reason = "the bounds are below 2^53")]
    let (lo, hi) = (min as f64, max as f64);
    if n < lo {
        issues.push(format!("Too small: expected number to be >={min}"));
    }
    if n > hi {
        issues.push(format!("Too big: expected number to be <={max}"));
    }
    #[expect(
        clippy::cast_possible_truncation,
        reason = "an integer; one past the safe range is refused above"
    )]
    (Some(n as i64), issues, false)
}

/// `z.string().url()`: the value is trimmed and loses its tabs and newlines, as zod's check writes it back.
fn url_value(raw: &str) -> Result<String, String> {
    let t = js_trim(raw);
    match url::Url::parse(t) {
        Ok(_) => Ok(t.replace(['\t', '\n', '\r'], "")),
        Err(_) => Err("Invalid URL".to_owned()),
    }
}

/// `jsonRecord(label)`: a JSON object of string values, in JavaScript's key order.
fn json_record(label: &str, raw: &str) -> Result<Json, String> {
    let fail = |why: &str| format!("{label} must be a JSON object of string values: {why}");
    if js_trim(raw).is_empty() {
        return Err(fail("Unexpected end of JSON input"));
    }
    let parsed = json::parse(raw).map_err(|e| fail(&e.message))?;
    let Json::Object(fields) = parsed else {
        return Err(fail("not an object"));
    };
    let fields = json::js_key_order(fields);
    for (k, v) in &fields {
        if !matches!(v, Json::String(_)) {
            return Err(fail(&format!("value for \"{k}\" is not a string")));
        }
    }
    Ok(Json::Object(fields))
}

const METERING_TRUE: [&str; 4] = ["1", "true", "yes", "on"];
const METERING_FALSE: [&str; 4] = ["0", "false", "no", "off"];

struct Out<'a, 'b> {
    f: &'b mut Fields<'a>,
    json: Vec<(String, Json)>,
}

impl Out<'_, '_> {
    fn set(&mut self, key: &str, v: Json) {
        self.json.push((key.to_owned(), v));
    }

    fn issue(&mut self, key: &str, message: &str) {
        self.f.issues.push(format!("{key}: {message}"));
    }

    fn issues(&mut self, key: &str, messages: Vec<String>) {
        for m in messages {
            self.issue(key, &m);
        }
    }

    fn checked(&mut self, key: &str, v: Result<Json, String>) {
        match v {
            Ok(v) => self.set(key, v),
            Err(m) => self.issue(key, &m),
        }
    }

    /// `z.string().default(default)`.
    fn string(&mut self, key: &str, default: &str) {
        let v = self.f.get(key).unwrap_or(default).to_owned();
        self.set(key, Json::String(v));
    }

    /// `z.string().optional()`.
    fn opt_string(&mut self, key: &str) {
        if let Some(v) = self.f.get(key) {
            self.set(key, Json::str(v));
        }
    }

    /// `z.string().min(1).optional()`, trimmed first when `trim`.
    fn opt_nonempty(&mut self, key: &str, trim: bool) {
        let Some(raw) = self.f.get(key) else {
            return;
        };
        let v = if trim { js_trim(raw) } else { raw };
        if v.is_empty() {
            self.issue(key, "Too small: expected string to have >=1 characters");
        } else {
            self.set(key, Json::str(v));
        }
    }

    /// `z.string().url()`: required.
    fn url(&mut self, key: &str) {
        match self.f.get(key) {
            None => self.issue(key, REQUIRED_STRING),
            Some(raw) => {
                let v = url_value(raw).map(Json::String);
                self.checked(key, v);
            }
        }
    }

    /// `z.string().url().optional()`.
    fn opt_url(&mut self, key: &str) {
        if let Some(raw) = self.f.get(key) {
            let v = url_value(raw).map(Json::String);
            self.checked(key, v);
        }
    }

    /// `blankAsAbsent(z.string().url().optional())`.
    fn blank_url(&mut self, key: &str) {
        if let Some(raw) = self.f.blank(key) {
            let v = url_value(raw).map(Json::String);
            self.checked(key, v);
        }
    }

    /// `blankAsAbsent(z.string().max(max).optional())`, trimmed first (then at least one character) when `trim`.
    fn blank_string(&mut self, key: &str, trim: bool, max: Option<usize>) {
        let Some(raw) = self.f.blank(key) else {
            return;
        };
        let v = if trim { js_trim(raw) } else { raw };
        if let Some(max) = max
            && js_length(v) > max
        {
            self.issue(
                key,
                &format!("Too big: expected string to have <={max} characters"),
            );
            return;
        }
        self.set(key, Json::str(v));
    }

    /// `blankAsAbsent(z.string().trim().regex(pattern, message).optional())`.
    fn blank_pattern(&mut self, key: &str, pattern: &str, message: &str) {
        let Some(raw) = self.f.blank(key) else {
            return;
        };
        let v = js_trim(raw);
        if Regex::new(pattern).is_ok_and(|re| re.test(v)) {
            self.set(key, Json::str(v));
        } else {
            self.issue(key, message);
        }
    }

    /// `z.coerce.number().int().min().max()`, with `default` when unset (`None`: optional): blank reads as 0.
    fn int(&mut self, key: &str, min: i64, max: i64, default: Option<i64>) {
        match self.f.get(key) {
            None => {
                if let Some(d) = default {
                    self.set(key, Json::int(d));
                }
            }
            Some(raw) => match int_issues(raw, min, max) {
                (Some(v), issues, _) if issues.is_empty() => self.set(key, Json::int(v)),
                (_, issues, _) => self.issues(key, issues),
            },
        }
    }

    /// `blankAsAbsent(z.coerce.number().int().min().max().optional())`.
    fn blank_int(&mut self, key: &str, min: i64, max: i64) {
        let Some(raw) = self.f.blank(key) else {
            return;
        };
        match int_issues(raw, min, max) {
            (Some(v), issues, _) if issues.is_empty() => self.set(key, Json::int(v)),
            (_, issues, _) => self.issues(key, issues),
        }
    }

    /// `jsonRecord(key)`: default `{}`.
    fn record(&mut self, key: &str) {
        let v = json_record(key, self.f.get(key).unwrap_or("{}"));
        self.checked(key, v);
    }
}

/// `loadEnv(schema, source)`.
pub fn load(source: &BTreeMap<String, String>) -> Result<AgentsEnv, EnvError> {
    service_kit::posture::assert_production_posture(source)?;
    let mut f = Fields::new(source);
    // svc-agents' own SERVICE_NAME replaces the base one in its place: any string, default svc-agents.
    let base = service_kit::env::base(&mut f, ServiceName::Own("svc-agents"));
    let pg = service_kit::env::postgres(&mut f);
    let redis = service_kit::env::redis(&mut f);
    let nats = service_kit::env::nats(&mut f);
    let otel = service_kit::env::otel(&mut f);
    let host = f.get("HTTP_HOST").unwrap_or("0.0.0.0").to_owned();
    let mut early: Vec<(String, Json)> = vec![
        ("NODE_ENV".into(), Json::str(base.node_env)),
        ("APP_ENV".into(), Json::str(base.app_env)),
        ("LOG_LEVEL".into(), Json::str(base.log_level)),
        ("SERVICE_NAME".into(), Json::str(base.service_name)),
        ("LAUNCH_DROP".into(), Json::str(base.launch_drop)),
        ("DATABASE_URL".into(), Json::str(pg.url)),
        ("DATABASE_POOL_MAX".into(), Json::int(pg.pool_max)),
        ("DATABASE_SSL".into(), Json::Bool(pg.ssl)),
        ("REDIS_URL".into(), Json::str(redis)),
        ("NATS_URL".into(), Json::str(nats.url)),
        ("NATS_STREAM_PREFIX".into(), Json::str(nats.stream_prefix)),
        (
            "OTEL_EXPORTER_OTLP_ENDPOINT".into(),
            Json::str(otel.endpoint),
        ),
        ("OTEL_ENABLED".into(), Json::Bool(otel.enabled)),
        ("HTTP_HOST".into(), Json::str(host)),
    ];
    // svc-agents' own HTTP_PORT, in httpEnvSchema's place: any integer, default 4008.
    let mut out = Out {
        f: &mut f,
        json: Vec::new(),
    };
    out.int("HTTP_PORT", i64::MIN, i64::MAX, Some(DEFAULT_PORT));
    early.append(&mut out.json);
    let edge = service_kit::env::edge(&mut f);
    early.push(("EDGE_PRINCIPAL_SECRET".into(), Json::str(edge.secret)));
    if let Some(k) = edge.public_key {
        early.push(("EDGE_PRINCIPAL_PUBLIC_KEY".into(), Json::str(k)));
    }
    if let Some(n) = edge.max_lifetime_seconds {
        early.push(("EDGE_PRINCIPAL_MAX_LIFETIME_SECONDS".into(), Json::int(n)));
    }
    if let Some(n) = edge.clock_skew_seconds {
        early.push(("EDGE_PRINCIPAL_CLOCK_SKEW_SECONDS".into(), Json::int(n)));
    }
    let internal = service_kit::env::internal_service(&mut f);
    early.push(("INTERNAL_SERVICE_SECRET".into(), Json::str(internal.secret)));
    early.push((
        "INTERNAL_SERVICE_BODY_BIND".into(),
        Json::str(internal.body_bind),
    ));
    let s2s = service_kit::env::s2s(&mut f);
    early.push(("S2S_AUTH_MODE".into(), Json::str(s2s.mode)));
    for (k, v) in [
        ("S2S_KEYRING", s2s.keyring),
        ("S2S_SIGNING_KID", s2s.signing_kid),
        ("S2S_SIGNING_KEY", s2s.signing_key),
    ] {
        if let Some(v) = v {
            early.push((k.into(), Json::str(v)));
        }
    }

    let mut o = Out {
        f: &mut f,
        json: early,
    };
    o.url("LEDGER_URL");
    for k in ["IDENTITY_URL", "ACADEMY_URL", "SUPPORT_URL", "TRADE_URL"] {
        o.blank_url(k);
    }
    o.blank_string("PORTFOLIO_QUOTE_ASSET", true, Some(32));
    for k in ["PAY_URL", "BANK_URL"] {
        o.blank_url(k);
    }
    if let Some(raw) = o.f.blank("LIVE_TRADE_COPY_LEADER_PLANE_OPEN") {
        let v = if raw == "true" {
            Ok(Json::str("true"))
        } else {
            Err("Invalid input: expected \"true\"".to_owned())
        };
        o.checked("LIVE_TRADE_COPY_LEADER_PLANE_OPEN", v);
    }
    o.blank_string("LIVE_TRADE_COPY_LEADER_IDS", false, None);
    match o.f.get("AGENTS_FEE_ASSET_ID") {
        None => o.issue("AGENTS_FEE_ASSET_ID", REQUIRED_STRING),
        Some(_) => o.opt_nonempty("AGENTS_FEE_ASSET_ID", true),
    }
    o.blank_pattern(
        "AGENTS_OVERAGE_GRACE",
        "/^\\d{1,20}(\\.\\d{1,18})?$/",
        "a decimal amount, such as 0.5",
    );
    // `.refine((minutes) => 1440 % minutes === 0)` runs on any integer, after the range issues.
    let window = o.f.get("AGENTS_USAGE_WINDOW_MINUTES").unwrap_or("NaN");
    match int_issues(window, 1, 1440) {
        (Some(n), mut issues, _) => {
            if n == 0 || 1440 % n != 0 {
                issues.push(
                    "must divide 1440 so a billing window never straddles midnight".to_owned(),
                );
            }
            if issues.is_empty() {
                o.set("AGENTS_USAGE_WINDOW_MINUTES", Json::int(n));
            } else {
                o.issues("AGENTS_USAGE_WINDOW_MINUTES", issues);
            }
        }
        (None, issues, _) => o.issues("AGENTS_USAGE_WINDOW_MINUTES", issues),
    }
    match o.f.blank("AGENTS_METERING_ENABLED") {
        None => o.issue("AGENTS_METERING_ENABLED", "agents.metering_enabled_unset"),
        Some(raw) => {
            let token = js_trim(raw).to_lowercase();
            let v = if METERING_TRUE.contains(&token.as_str()) {
                Ok(Json::Bool(true))
            } else if METERING_FALSE.contains(&token.as_str()) {
                Ok(Json::Bool(false))
            } else {
                Err("Invalid input".to_owned())
            };
            o.checked("AGENTS_METERING_ENABLED", v);
        }
    }
    let provider =
        o.f.get("AGENTS_PROVIDER")
            .map_or(Ok("mock".to_owned()), |v| one_of(v, &["mock", "upstream"]))
            .map(Json::String);
    o.checked("AGENTS_PROVIDER", provider);
    o.int("AGENTS_MOCK_DELAY_MS", 0, 10_000, None);
    o.opt_nonempty("AGENTS_MOCK_HOLD_FILE", true);
    o.opt_url("AGENTS_UPSTREAM_BASE_URL");
    o.opt_nonempty("AGENTS_UPSTREAM_API_KEY", false);
    o.string("AGENTS_UPSTREAM_AUTH_HEADER", "x-api-key");
    o.string("AGENTS_UPSTREAM_AUTH_PREFIX", "");
    o.record("AGENTS_UPSTREAM_HEADERS");
    o.string("AGENTS_UPSTREAM_COMPLETIONS_PATH", "/v1/messages");
    o.opt_string("AGENTS_UPSTREAM_EMBEDDINGS_PATH");
    o.record("AGENTS_UPSTREAM_MODELS");
    o.int("AGENTS_UPSTREAM_TIMEOUT_MS", 1000, 600_000, Some(60_000));
    o.opt_string("AGENTS_ROUTING_TABLE");
    o.opt_string("AGENTS_TIER_LAWS");
    o.blank_string("AGENTS_OWN_TEMPLATES", false, None);
    o.blank_string("AGENTS_POLICY_BASELINE", false, None);
    o.blank_int("AGENTS_OWN_TOKEN_LIFETIME_MINUTES", 1, 525_600);
    o.blank_string("AGENTS_OWN_ASSISTANT_MODEL", false, Some(200));
    o.blank_string("AGENTS_REVIEWER_MODEL", false, Some(200));
    o.blank_int("AGENTS_APPROVAL_TTL_SECONDS", 1, 604_800);
    for k in [
        "AGENTS_RETENTION_ACTION_LOG_DAYS",
        "AGENTS_RETENTION_MEMORY_DAYS",
        "AGENTS_RETENTION_TRANSCRIPTS_DAYS",
        "AGENTS_RETENTION_APPROVALS_DAYS",
        "AGENTS_RETENTION_USAGE_DAYS",
    ] {
        o.blank_int(k, 1, 36_500);
    }
    let address = "/^0x[0-9a-fA-F]{40}$/";
    o.blank_pattern("AGENTS_NAVIGATOR_ONCHAIN_SIGNER", address, "a 0x address");
    o.blank_url("AGENTS_NAVIGATOR_ONCHAIN_RPC_URL");
    o.blank_url("AGENTS_NAVIGATOR_ONCHAIN_SENDER_URL");
    o.blank_string("AGENTS_NAVIGATOR_ONCHAIN_MARKET", false, Some(4000));
    o.blank_string("AGENTS_LOG_READ_REASONS", false, None);
    o.blank_int("AGENTS_OPS_ACTIONS_LIMIT", 1, 500);
    o.blank_int("AGENTS_REGISTRY_LIST_LIMIT", 1, 500);
    o.blank_int("AGENTS_BACKGROUND_TEST_STEPS", 1, 10_000);
    o.blank_int("AGENTS_BACKGROUND_STEP_MS", 200, 600_000);
    o.blank_int("AGENTS_SCHEDULE_MIN_INTERVAL_MINUTES", 1, 525_600);
    o.blank_int("AGENTS_SCHEDULE_DAILY_LIMIT", 1, 10_000);
    o.blank_int("AGENTS_SCHEDULE_TICK_MS", 500, 3_600_000);
    o.blank_int("AGENTS_SCHEDULE_WORKERS", 1, 8);
    o.blank_int("AGENTS_SESSION_RUN_MAX_STEPS", 1, 1000);
    o.blank_string("AGENTS_RESEARCH_UNCERTAINTY_SCALE", true, None);
    o.blank_int("AGENTS_TRANSCRIPT_RETENTION_DAYS", 0, 3650);
    o.blank_url("AGENTS_PAYMENT_RPC_URL");
    o.blank_int("AGENTS_PAYMENT_CHAIN_ID", 1, 2_147_483_647);
    o.blank_pattern(
        "AGENTS_PAYMENT_TOKEN_ADDRESS",
        address,
        "a 0x token address",
    );
    o.blank_int("AGENTS_PAYMENT_TOKEN_DECIMALS", 0, 36);
    let json = Json::Object(std::mem::take(&mut o.json));
    f.finish()?;
    Ok(AgentsEnv {
        json,
        raw: source.clone(),
    })
}
