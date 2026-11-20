//! svc-academy's environment (`services/svc-academy/src/env.ts`): `serviceEnvSchema` (base, postgres, redis, nats,
//! otel, http), `edgeEnvSchema`, `internalServiceEnvSchema` and `s2sEnvSchema` from `@intafaced/config` (the kit's
//! slices, `service_kit::env`), merged with the Academy's own fields, loaded by `loadEnv` (which first refuses
//! development material in production posture). Same defaults, same blank-as-unset owner values, same refusals; every
//! problem is listed at once, in the schema's order.
//!
//! The loaded values are kept as the TypeScript's `env` object (`AcademyEnv::json`, in its key order), which
//! `tests/env_parity.rs` holds to the TypeScript's own answers; the typed accessors read from it.

use std::collections::BTreeMap;

use service_kit::env::{EnvError, Fields, ServiceName, js_number, one_of};
use service_kit::json::Json;
use service_kit::jsregex::Regex;
use service_kit::schema::js_trim;

/// `ACADEMY_DISCUSSION_IMAGE_MAX_BYTES`.
pub const DISCUSSION_IMAGE_MAX_BYTES: i64 = 524_288;

/// The service's default port: 4000 to 4015 are taken in `docker-compose.apps.yml`.
pub const DEFAULT_PORT: i64 = 4016;

/// The loaded environment.
#[derive(Debug, Clone, PartialEq)]
pub struct AcademyEnv {
    /// The TypeScript's `env`, key for key.
    pub json: Json,
    /// The whole process environment, for the jurisdiction guard's switches and lists.
    pub raw: BTreeMap<String, String>,
}

impl AcademyEnv {
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

    pub fn flag(&self, key: &str) -> bool {
        matches!(self.get(key), Some(Json::Bool(true)))
    }

    /// A list value (the upload types).
    pub fn list(&self, key: &str) -> Option<Vec<String>> {
        match self.get(key) {
            Some(Json::Array(a)) => Some(
                a.iter()
                    .filter_map(|v| match v {
                        Json::String(s) => Some(s.clone()),
                        _ => None,
                    })
                    .collect(),
            ),
            _ => None,
        }
    }
}

const MAX_SAFE: f64 = 9_007_199_254_740_991.0;
const MIN_SAFE: f64 = -9_007_199_254_740_991.0;

/// `z.coerce.number().int().min(min).max(max)` on one string, with every issue zod raises, in its order. The first
/// flag says whether an issue aborts (a union then reports only "Invalid input").
fn int_issues(raw: Option<&str>, min: i64, max: i64) -> Result<i64, (bool, Vec<String>)> {
    // `Number(undefined)` is NaN.
    let Some(n) = raw.and_then(js_number) else {
        return Err((
            true,
            vec!["Invalid input: expected number, received NaN".to_owned()],
        ));
    };
    if n.is_infinite() {
        let shown = if n > 0.0 { "Infinity" } else { "-Infinity" };
        return Err((
            true,
            vec![format!("Invalid input: expected number, received {shown}")],
        ));
    }
    if n.fract() != 0.0 {
        return Err((
            true,
            vec!["Invalid input: expected int, received number".to_owned()],
        ));
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
    if !issues.is_empty() {
        return Err((false, issues));
    }
    #[expect(
        clippy::cast_possible_truncation,
        reason = "a safe integer, checked above"
    )]
    Ok(n as i64)
}

/// `z.string().url()`: the value is trimmed and loses its tabs and newlines, as zod's check writes it back.
fn url_value(raw: &str) -> Result<String, String> {
    let t = js_trim(raw);
    match url::Url::parse(t) {
        Ok(_) => Ok(t.replace(['\t', '\n', '\r'], "")),
        Err(_) => Err("Invalid URL".to_owned()),
    }
}

struct Out<'a, 'b> {
    f: &'b mut Fields<'a>,
    json: Vec<(String, Json)>,
}

impl<'a> Out<'a, '_> {
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

    /// `z.string().optional().default(default)`.
    fn string(&mut self, key: &str, default: &str) {
        let v = self.f.get(key).unwrap_or(default).to_owned();
        self.set(key, Json::String(v));
    }

    /// `z.string().url().default(default)`.
    fn url(&mut self, key: &str, default: &str) {
        match self.f.get(key).map_or(Ok(default.to_owned()), url_value) {
            Ok(v) => self.set(key, Json::String(v)),
            Err(m) => self.issue(key, &m),
        }
    }

    /// `z.coerce.number().int().min().max().default(default)`: blank reads as 0.
    fn int(&mut self, key: &str, min: i64, max: i64, default: i64) {
        match self.f.get(key) {
            None => self.set(key, Json::int(default)),
            Some(raw) => match int_issues(Some(raw), min, max) {
                Ok(v) => self.set(key, Json::int(v)),
                Err((_, m)) => self.issues(key, m),
            },
        }
    }

    /// An owner value: `z.preprocess(blank → undefined, z.union([z.undefined(), int]))`. Unset is unpublished.
    fn owner_int(&mut self, key: &str, min: i64, max: i64) {
        let Some(raw) = self.f.blank(key) else {
            return;
        };
        match int_issues(Some(raw), min, max) {
            Ok(v) => self.set(key, Json::int(v)),
            Err((true, _)) => self.issue(key, "Invalid input"),
            Err((false, m)) => self.issues(key, m),
        }
    }

    /// `blankAsUnset(z.coerce.number().int().min().max())`.
    fn blank_int(&mut self, key: &str, min: i64, max: i64) {
        let Some(raw) = self.f.blank(key) else {
            return;
        };
        match int_issues(Some(raw), min, max) {
            Ok(v) => self.set(key, Json::int(v)),
            Err((_, m)) => self.issues(key, m),
        }
    }

    /// `blankAsUnset(z.string().url())`.
    fn blank_url(&mut self, key: &str) {
        let Some(raw) = self.f.blank(key) else {
            return;
        };
        match url_value(raw) {
            Ok(v) => self.set(key, Json::String(v)),
            Err(m) => self.issue(key, &m),
        }
    }

    /// `blankAsUnset(z.string().trim().regex(pattern, message))`.
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

    /// A kill switch: `z.union([z.boolean(), z.string()]).default(true)`, off only for 0, false, off or no.
    fn switch(&mut self, key: &str) {
        let on = self
            .f
            .get(key)
            .is_none_or(|v| !["0", "false", "off", "no"].contains(&v.to_lowercase().as_str()));
        self.set(key, Json::Bool(on));
    }

    /// A comma-separated list of MIME types (`mimeList`), at least one; blank is unset.
    fn mime_list(&mut self, key: &str) {
        let Some(raw) = self.f.blank(key) else {
            return;
        };
        let items: Vec<String> = raw
            .split(',')
            .map(|t| js_trim(t).to_lowercase())
            .filter(|t| !t.is_empty())
            .collect();
        let pattern = "/^[a-z]+\\/[a-z0-9.+-]+$/";
        let Ok(re) = Regex::new(pattern) else {
            return;
        };
        let mut bad = false;
        for (i, t) in items.iter().enumerate() {
            if !re.test(t) {
                bad = true;
                self.f.issues.push(format!(
                    "{key}.{i}: Invalid string: must match pattern {pattern}"
                ));
            }
        }
        if items.is_empty() {
            bad = true;
            self.issue(key, "Too small: expected array to have >=1 items");
        }
        if !bad {
            self.set(
                key,
                Json::Array(items.into_iter().map(Json::String).collect()),
            );
        }
    }
}

/// `loadEnv(schema, source)`.
pub fn load(source: &BTreeMap<String, String>) -> Result<AcademyEnv, EnvError> {
    service_kit::posture::assert_production_posture(source)?;
    let mut f = Fields::new(source);
    // The Academy's own SERVICE_NAME replaces the base one in its place: any string, default svc-academy.
    let base = service_kit::env::base(&mut f, ServiceName::Own("svc-academy"));
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
    // The Academy's own HTTP_PORT, in httpEnvSchema's place: any integer, default 4016.
    let mut out = Out {
        f: &mut f,
        json: Vec::new(),
    };
    out.int("HTTP_PORT", i64::MIN, i64::MAX, DEFAULT_PORT);
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
    o.url("TOKEN_URL", "http://localhost:4003");
    o.url("IDENTITY_URL", "http://localhost:4002");
    match o
        .f
        .get("ACADEMY_STREAM_PROVIDER")
        .map_or(Ok("none".to_owned()), |v| one_of(v, &["none", "livekit"]))
    {
        Ok(v) => o.set("ACADEMY_STREAM_PROVIDER", Json::String(v)),
        Err(m) => o.issue("ACADEMY_STREAM_PROVIDER", &m),
    }
    o.string("LIVEKIT_URL", "");
    o.string("LIVEKIT_API_KEY", "");
    o.string("LIVEKIT_API_SECRET", "");
    o.int("LIVEKIT_TOKEN_TTL_SECONDS", 60, 86_400, 3600);
    o.owner_int("ACADEMY_MAX_ROOM_CAPACITY", 1, 100_000);
    o.owner_int("ACADEMY_PLANNER_TODO_LIMIT", 1, 10_000);
    o.owner_int("ACADEMY_OUTLINE_MAX_SECTIONS", 1, 1000);
    o.owner_int("ACADEMY_OUTLINE_MAX_ITEMS", 1, 1000);
    o.owner_int("ACADEMY_LESSON_IMPORT_MAX_BYTES", 1, 1_048_576);
    o.owner_int("ACADEMY_PROGRAMME_MAX_COURSES", 1, 100);
    o.owner_int("ACADEMY_CUSTOM_ROLE_LIMIT", 1, 1000);
    o.owner_int("ACADEMY_POST_MAX_CHARS", 1, 20_000);
    o.owner_int(
        "ACADEMY_POST_IMAGE_MAX_BYTES",
        1,
        DISCUSSION_IMAGE_MAX_BYTES,
    );
    o.owner_int("ACADEMY_MESSAGE_MAX_CHARS", 1, 20_000);
    if let Some(raw) = o.f.blank("ACADEMY_TRUSTED_PROXY_CIDRS") {
        if raw.chars().count() > 4000 {
            o.issue(
                "ACADEMY_TRUSTED_PROXY_CIDRS",
                "Too big: expected string to have <=4000 characters",
            );
        } else {
            o.set("ACADEMY_TRUSTED_PROXY_CIDRS", Json::str(raw));
        }
    }
    o.owner_int("ACADEMY_CERT_ISSUE_SWEEP_SECONDS", 1, 86_400);
    o.owner_int("ACADEMY_GRADER_LEASE_SECONDS", 1, 86_400);
    o.blank_int("ACADEMY_GRADE_REPORT_ROWS", 1, 100_000);
    o.blank_int("ACADEMY_CERT_ISSUED_ROWS", 1, 100_000);
    o.blank_int("ACADEMY_LEARNER_SUMMARIES_PAGE_SIZE", 1, 200);
    o.blank_int("ACADEMY_REPORT_TASKS_PAGE_SIZE", 1, 200);
    o.blank_int("ACADEMY_REPORT_CENTRE_RETENTION_MINUTES", 1, 5_256_000);
    o.blank_int("ACADEMY_REPORT_SWEEP_SECONDS", 1, 86_400);
    o.blank_int("ACADEMY_BULK_FILE_MAX_BYTES", 1, 900_000);
    o.blank_int("ACADEMY_BULK_ENROL_ROWS", 1, 1000);
    o.blank_int("ACADEMY_BULK_EMAIL_INACTIVE_DAYS", 1, 3650);
    o.blank_int("ACADEMY_REPORT_RETENTION_HOURS", 1, 8760);
    o.blank_int("ACADEMY_LEARNER_EXPORT_ROWS", 1, 100_000);
    o.blank_int("ACADEMY_GRANT_AUDIT_PAGE_SIZE", 1, 200);
    o.owner_int("ACADEMY_TOPICS_LIST_LIMIT", 1, 1000);
    o.owner_int("ACADEMY_UPLOAD_MAX_BYTES", 1, 5_368_709_120);
    o.mime_list("ACADEMY_UPLOAD_VIDEO_TYPES");
    o.mime_list("ACADEMY_UPLOAD_HANDOUT_TYPES");
    o.switch("ACADEMY_TOURNAMENT_ENABLED");
    o.switch("ACADEMY_PAPER_TRADING_ENABLED");
    o.string("ACADEMY_AMBASSADOR_IFC_PAY_LAW_JSON", "");
    o.string("ACADEMY_AMBASSADOR_REVENUE_SHARE_LAW_JSON", "");
    o.blank_url("TRADE_URL");
    o.owner_int("ACADEMY_PAPER_MARKETS_LIMIT", 1, 500);
    for k in [
        "ACADEMY_VIDEO_S3_ENDPOINT",
        "ACADEMY_VIDEO_S3_BUCKET",
        "ACADEMY_VIDEO_S3_ACCESS_KEY",
        "ACADEMY_VIDEO_S3_SECRET_KEY",
        "ACADEMY_VIDEO_S3_REGION",
    ] {
        o.string(k, "");
    }
    o.owner_int("ACADEMY_VIDEO_URL_TTL_SECONDS", 1, 3600);
    o.owner_int("ACADEMY_VIDEO_WATCH_THRESHOLD_SECONDS", 1, 86_400);
    o.owner_int("ACADEMY_VIDEO_POSITION_SAVE_SECONDS", 1, 3600);
    o.string("ACADEMY_VIDEO_MIN_TIER", "");
    o.string("ACADEMY_VIDEO_MIN_STAKE", "");
    o.owner_int("ACADEMY_CERT_VERIFY_RATE_MAX", 1, 10_000);
    o.owner_int("ACADEMY_CERT_VERIFY_RATE_WINDOW_SECONDS", 1, 86_400);
    o.blank_url("ACADEMY_PAYMENT_RPC_URL");
    o.blank_int("ACADEMY_PAYMENT_CHAIN_ID", 1, 2_147_483_647);
    let address = "/^0x[0-9a-fA-F]{40}$/";
    o.blank_pattern(
        "ACADEMY_PAYMENT_TOKEN_ADDRESS",
        address,
        "a 0x token address",
    );
    o.blank_int("ACADEMY_PAYMENT_TOKEN_DECIMALS", 0, 36);
    o.blank_pattern(
        "ACADEMY_PAYMENT_ASSET",
        "/^[A-Z0-9]{2,12}$/",
        "an asset code",
    );
    o.blank_pattern(
        "ACADEMY_PAYMENT_RECEIVER",
        address,
        "INTAFACED's receiving address",
    );
    o.blank_int("ACADEMY_PAYMENT_CONFIRMATIONS", 1, 1000);
    o.blank_url("ACADEMY_REFUND_SIGNER_URL");
    o.blank_url("LEDGER_URL");
    o.blank_int("ACADEMY_PURCHASE_RECONCILE_SECONDS", 1, 3600);
    let json = Json::Object(std::mem::take(&mut o.json));
    f.finish()?;
    Ok(AcademyEnv {
        json,
        raw: source.clone(),
    })
}
