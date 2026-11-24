//! svc-blueprint's environment (`services/svc-blueprint/src/env.ts`): `serviceEnvSchema` (base, postgres, redis, nats,
//! otel, http) and `edgeEnvSchema` from `@intafaced/config` (the kit's slices, `service_kit::env`), merged with the
//! Blueprint's own fields and its one cross-field check, loaded by `loadEnv` (which first refuses development material
//! in production posture), then `assertProdEngine`. Same defaults, same blank-as-unpublished owner values, same
//! refusals; every problem is listed at once, in the schema's order.
//!
//! The loaded values are kept as the TypeScript's `env` object (`BlueprintEnv::json`, in its key order), which
//! `tests/env_parity.rs` holds to the TypeScript's own answers; the typed accessors read from it.

use std::collections::BTreeMap;

use service_kit::env::{EnvError, Fields, ServiceName, js_number, one_of};
use service_kit::json::Json;
use service_kit::schema::js_trim;

/// The service's default port (`HTTP_PORT`).
pub const DEFAULT_PORT: i64 = 4008;

/// `PROD_ENGINE_CONFIG_CODE` (`prod-engine.ts`): the refusal of a production process with no real Neural Engine.
pub const PROD_ENGINE_CONFIG_CODE: &str = "blueprint.prod_engine_config";

/// The engine refine's words (`superRefine` in `env.ts`).
const ENGINE_URL_UNSET: &str =
    "BLUEPRINT_ENGINE_URL is unset — will not invent http://host.docker.internal:4108 as live";

/// The loaded environment.
#[derive(Debug, Clone, PartialEq)]
pub struct BlueprintEnv {
    /// The TypeScript's `env`, key for key.
    pub json: Json,
    /// The whole process environment, for the jurisdiction guard's switches and lists.
    pub raw: BTreeMap<String, String>,
}

impl BlueprintEnv {
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

    /// `BLUEPRINT_ENGINE_MODE`: `mock` runs the in-process engine; anything else is `http`.
    pub fn engine_is_mock(&self) -> bool {
        self.str("BLUEPRINT_ENGINE_MODE") == Some("mock")
    }
}

const MAX_SAFE: f64 = 9_007_199_254_740_991.0;
const MIN_SAFE: f64 = -9_007_199_254_740_991.0;

/// `z.coerce.number().int().min(min).max(max)` on one string: the integer, or every issue zod raises, in its order.
fn int_issues(raw: &str, min: i64, max: Option<i64>) -> Result<i64, Vec<String>> {
    let Some(n) = js_number(raw) else {
        return Err(vec![
            "Invalid input: expected number, received NaN".to_owned(),
        ]);
    };
    if n.is_infinite() {
        let shown = if n > 0.0 { "Infinity" } else { "-Infinity" };
        return Err(vec![format!(
            "Invalid input: expected number, received {shown}"
        )]);
    }
    if n.fract() != 0.0 {
        return Err(vec![
            "Invalid input: expected int, received number".to_owned(),
        ]);
    }
    let mut issues = Vec::new();
    if n > MAX_SAFE {
        issues.push("Too big: expected int to be <=9007199254740991".to_owned());
    } else if n < MIN_SAFE {
        issues.push("Too small: expected int to be >=-9007199254740991".to_owned());
    }
    #[expect(clippy::cast_precision_loss, reason = "the bounds are below 2^53")]
    let lo = min as f64;
    if n < lo {
        issues.push(format!("Too small: expected number to be >={min}"));
    }
    if let Some(max) = max {
        #[expect(clippy::cast_precision_loss, reason = "the bounds are below 2^53")]
        let hi = max as f64;
        if n > hi {
            issues.push(format!("Too big: expected number to be <={max}"));
        }
    }
    if issues.is_empty() {
        #[expect(
            clippy::cast_possible_truncation,
            reason = "an integer inside the safe range"
        )]
        Ok(n as i64)
    } else {
        Err(issues)
    }
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

impl Out<'_, '_> {
    fn set(&mut self, key: &str, v: Json) {
        self.json.push((key.to_owned(), v));
    }

    fn issue(&mut self, key: &str, message: &str) {
        self.f.issues.push(format!("{key}: {message}"));
    }

    fn checked(&mut self, key: &str, v: Result<Json, Vec<String>>) {
        match v {
            Ok(v) => self.set(key, v),
            Err(messages) => {
                for m in messages {
                    self.issue(key, &m);
                }
            }
        }
    }

    /// `z.coerce.number().int().min().max().default(default)`: blank reads as 0.
    fn int(&mut self, key: &str, min: i64, max: Option<i64>, default: i64) {
        let v = match self.f.get(key) {
            None => Ok(default),
            Some(raw) => int_issues(raw, min, max),
        };
        self.checked(key, v.map(Json::int));
    }

    /// `unpublishedInt(min, max)`: blank or whitespace is unpublished (absent).
    fn unpublished_int(&mut self, key: &str, min: i64, max: Option<i64>) {
        if let Some(raw) = self.f.blank(key) {
            let v = int_issues(raw, min, max).map(Json::int);
            self.checked(key, v);
        }
    }

    /// `unpublishedUrl()`: blank or whitespace is unpublished; else trimmed, then a URL.
    fn unpublished_url(&mut self, key: &str) {
        if let Some(raw) = self.f.blank(key) {
            let v = url_value(raw).map(Json::String).map_err(|m| vec![m]);
            self.checked(key, v);
        }
    }

    /// `optionalUrl`: only the empty string is unset; whitespace is checked as a URL (and refused).
    fn optional_url(&mut self, key: &str) {
        if let Some(raw) = self.f.get(key).filter(|v| !v.is_empty()) {
            let v = url_value(raw).map(Json::String).map_err(|m| vec![m]);
            self.checked(key, v);
        }
    }

    /// `z.string().min(1).optional()`: the empty string is refused, unset omits.
    fn secret(&mut self, key: &str) {
        if let Some(raw) = self.f.get(key) {
            if raw.is_empty() {
                self.issue(key, "Too small: expected string to have >=1 characters");
            } else {
                self.set(key, Json::str(raw));
            }
        }
    }
}

/// zod runs an object's own refine only when no field's issue aborted it: a wrong type or a value outside an enum.
fn aborted(issues: &[String]) -> bool {
    issues.iter().any(|i| {
        i.split_once(": ")
            .is_some_and(|(_, m)| m.starts_with("Invalid input") || m.starts_with("Invalid option"))
    })
}

/// `loadEnv(schema, source)`, then `assertProdEngine(env)`.
pub fn load(source: &BTreeMap<String, String>) -> Result<BlueprintEnv, EnvError> {
    service_kit::posture::assert_production_posture(source)?;
    let mut f = Fields::new(source);
    // svc-blueprint's own SERVICE_NAME replaces the base one in its place: any string, default svc-blueprint.
    let base = service_kit::env::base(&mut f, ServiceName::Own("svc-blueprint"));
    let pg = service_kit::env::postgres(&mut f);
    let redis = service_kit::env::redis(&mut f);
    let nats = service_kit::env::nats(&mut f);
    let otel = service_kit::env::otel(&mut f);
    let host = f.get("HTTP_HOST").unwrap_or("0.0.0.0").to_owned();
    let early: Vec<(String, Json)> = vec![
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
    let mut o = Out {
        f: &mut f,
        json: early,
    };
    // svc-blueprint's own HTTP_PORT, in httpEnvSchema's place: any integer, default 4008.
    o.int("HTTP_PORT", i64::MIN, None, DEFAULT_PORT);
    let mut json = std::mem::take(&mut o.json);
    let edge = service_kit::env::edge(&mut f);
    json.push(("EDGE_PRINCIPAL_SECRET".into(), Json::str(edge.secret)));
    if let Some(k) = edge.public_key {
        json.push(("EDGE_PRINCIPAL_PUBLIC_KEY".into(), Json::str(k)));
    }
    if let Some(n) = edge.max_lifetime_seconds {
        json.push(("EDGE_PRINCIPAL_MAX_LIFETIME_SECONDS".into(), Json::int(n)));
    }
    if let Some(n) = edge.clock_skew_seconds {
        json.push(("EDGE_PRINCIPAL_CLOCK_SKEW_SECONDS".into(), Json::int(n)));
    }

    let mut o = Out { f: &mut f, json };
    o.unpublished_url("BLUEPRINT_ENGINE_URL");
    o.int("BLUEPRINT_ENGINE_TIMEOUT_MS", 1_000, Some(120_000), 20_000);
    o.secret("BLUEPRINT_ENGINE_API_KEY");
    // `z.preprocess('' → undefined, z.enum(['http', 'mock']).default('http'))`.
    let mode = match o.f.get("BLUEPRINT_ENGINE_MODE").filter(|v| !v.is_empty()) {
        None => Ok("http".to_owned()),
        Some(v) => one_of(v, &["http", "mock"]),
    };
    o.checked(
        "BLUEPRINT_ENGINE_MODE",
        mode.map(Json::String).map_err(|m| vec![m]),
    );
    o.unpublished_int("BLUEPRINT_CREW_CAPACITY", 2, Some(24));
    o.unpublished_int("BLUEPRINT_MENTOR_SHORTLIST_SIZE", 1, Some(10));
    o.unpublished_int("BLUEPRINT_SEASON", 1, None);
    o.unpublished_int("BLUEPRINT_SHARES_PER_OWNER", 0, None);
    o.unpublished_int("BLUEPRINT_OPENS_LIST_LIMIT", 0, None);
    o.optional_url("BLUEPRINT_CARD_RENDERER_URL");
    o.int(
        "BLUEPRINT_CARD_RENDERER_TIMEOUT_MS",
        500,
        Some(60_000),
        10_000,
    );
    o.secret("BLUEPRINT_CARD_RENDERER_API_KEY");
    let json = Json::Object(std::mem::take(&mut o.json));

    // `.superRefine`: an `http` engine needs its URL. zod hands it the parsed value, an invalid URL included, so only
    // an unset or blank one is refused here.
    let http = json.get("BLUEPRINT_ENGINE_MODE") == Some(&Json::str("http"));
    if !aborted(&f.issues) && http && f.blank("BLUEPRINT_ENGINE_URL").is_none() {
        f.issues
            .push(format!("BLUEPRINT_ENGINE_URL: {ENGINE_URL_UNSET}"));
    }
    f.finish()?;
    let env = BlueprintEnv {
        json,
        raw: source.clone(),
    };
    assert_prod_engine(&env).map_err(|message| EnvError {
        message,
        issues: Vec::new(),
    })?;
    Ok(env)
}

/// `isLoopbackEngineUrl(url)`: a URL that does not parse counts as loopback.
pub fn is_loopback_engine_url(raw: &str) -> bool {
    let Ok(url) = url::Url::parse(raw) else {
        return true;
    };
    let host = url.host_str().unwrap_or("").to_lowercase();
    let host = host
        .strip_prefix('[')
        .and_then(|h| h.strip_suffix(']'))
        .unwrap_or(&host);
    if host == "localhost." {
        return true;
    }
    ["localhost", "127.0.0.1", "::1", "0.0.0.0"].contains(&host)
        || ipv4_loopback(host)
        || ipv4_mapped_loopback(host)
}

/// `isIpv4Loopback`: four decimal octets, the first 127.
fn ipv4_loopback(host: &str) -> bool {
    let parts: Vec<&str> = host.split('.').collect();
    if parts.len() != 4 {
        return false;
    }
    let mut first = None;
    for part in parts {
        if part.is_empty() || part.len() > 3 || !part.bytes().all(|b| b.is_ascii_digit()) {
            return false;
        }
        let Ok(octet) = part.parse::<u16>() else {
            return false;
        };
        if octet > 255 {
            return false;
        }
        first.get_or_insert(octet);
    }
    first == Some(127)
}

/// `isIpv4MappedLoopback`: `::ffff:<hi>:<lo>` with the high byte 0x7f.
fn ipv4_mapped_loopback(host: &str) -> bool {
    let Some(rest) = host.strip_prefix("::ffff:") else {
        return false;
    };
    let Some((hi, lo)) = rest.split_once(':') else {
        return false;
    };
    let hex = |s: &str| (1..=4).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_hexdigit());
    if !hex(hi) || !hex(lo) {
        return false;
    }
    u16::from_str_radix(hi, 16).is_ok_and(|hi| hi >> 8 == 0x7f)
}

/// `assertProdEngine(env)`: production reaches a real Neural Engine over HTTP, never the mock or a loopback URL.
pub fn assert_prod_engine(env: &BlueprintEnv) -> Result<(), String> {
    if env.str("APP_ENV") != Some("prod") {
        return Ok(());
    }
    if env.engine_is_mock() {
        return Err(format!(
            "APP_ENV=prod refuses BLUEPRINT_ENGINE_MODE=mock ({PROD_ENGINE_CONFIG_CODE}). \
             Production must reach a real Neural Engine over HTTP — mock is a local stand-in, not a fallback. \
             Set BLUEPRINT_ENGINE_MODE=http and BLUEPRINT_ENGINE_URL to the engine deployment."
        ));
    }
    let Some(url) = env.str("BLUEPRINT_ENGINE_URL").filter(|u| !u.is_empty()) else {
        return Err(format!(
            "APP_ENV=prod refuses unset BLUEPRINT_ENGINE_URL ({PROD_ENGINE_CONFIG_CODE}). \
             Blank is unpublished — will not invent http://localhost:4108 or http://host.docker.internal:4108. \
             Set BLUEPRINT_ENGINE_URL to the engine deployment."
        ));
    };
    if is_loopback_engine_url(url) {
        return Err(format!(
            "APP_ENV=prod refuses BLUEPRINT_ENGINE_URL={url} ({PROD_ENGINE_CONFIG_CODE}). \
             Loopback is not a production engine. \
             Set BLUEPRINT_ENGINE_URL to the engine deployment."
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loopback_is_read_as_the_typescript_reads_it() {
        for url in [
            "http://localhost:4108",
            "http://LOCALHOST",
            "http://127.0.0.1",
            "http://127.200.3.4",
            "http://[::1]:4108",
            "http://[::ffff:7f00:1]",
            "http://[::ffff:127.0.0.1]",
            "http://0.0.0.0",
            "http://localhost.:1",
            "not a url",
        ] {
            assert!(is_loopback_engine_url(url), "{url}");
        }
        for url in [
            "https://engine.example",
            "http://128.0.0.1",
            "http://[::2]",
            "http://[::ffff:8000:1]",
        ] {
            assert!(!is_loopback_engine_url(url), "{url}");
        }
    }
}
