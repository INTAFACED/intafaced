//! svc-ledger's environment (`services/svc-ledger/src/env.ts`): `serviceEnvSchema` (base, postgres, redis, nats, otel,
//! http), `internalServiceEnvSchema`, `authEnvSchema` and `s2sEnvSchema` from `@intafaced/config`, merged with the
//! ledger's own fields and loaded by `loadEnv` (which first refuses development material in production posture); then
//! what `env.ts` reads after it: the reconciliation rails' statement and open-items addresses, the clock-skew bound and
//! the idempotency conflict mode. Same defaults, same refusals, every problem of the schema listed at once in its order.
//!
//! The loaded values are kept as the TypeScript's `env` object (`LedgerEnv::json`, in its key order), which
//! `tests/env_parity.rs` holds to the TypeScript's own answers.

use std::collections::BTreeMap;

use service_kit::env::{
    EnvError, Fields, REQUIRED_STRING, ServiceName, coerce_int, min_len, one_of,
};
use service_kit::json::Json;
use service_kit::schema::js_trim;

/// The ledger's port (`HTTP_PORT`'s default).
pub const DEFAULT_PORT: i64 = 4001;

/// `ledger/reconcile-config.ts`: each reconciliation limit's default and bounds.
pub const RECONCILE_STATEMENT_TIMEOUT_MS: (i64, i64, i64) = (600_000, 1_000, 3_600_000);
pub const RECONCILE_MAX_STALE_HOURS: (i64, i64, i64) = (24, 1, 24 * 30);
pub const RECONCILE_MAX_CONSECUTIVE_INCOMPLETE: (i64, i64, i64) = (3, 1, 1_000);

/// The loaded environment.
#[derive(Debug, Clone, PartialEq)]
pub struct LedgerEnv {
    /// The TypeScript's `env`, key for key.
    pub json: Json,
    /// `clockSkewBoundMs`: the owner's bound, or none while blank.
    pub clock_skew_bound_ms: Option<i64>,
    /// `idempotencyConflictMode`: `refuse` in production posture whatever is set.
    pub idempotency_conflict_mode: &'static str,
    /// `railStatementUrls`: rail id to its statement address.
    pub rail_statement_urls: BTreeMap<String, String>,
    /// `openItemsUrls`: rail id to its open-items address.
    pub open_items_urls: BTreeMap<String, String>,
}

impl LedgerEnv {
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

    /// An integer value.
    pub fn int(&self, key: &str) -> Option<i64> {
        match self.get(key) {
            Some(Json::Number(n)) => format!("{n}").parse().ok(),
            _ => None,
        }
    }

    pub fn flag(&self, key: &str) -> bool {
        matches!(self.get(key), Some(Json::Bool(true)))
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

/// `isOutsideSnapshotUrl`: https, or plain http to a loopback host. `None` when it is no URL at all (`new URL` throws).
fn is_outside_snapshot_url(value: &str) -> Option<bool> {
    let url = url::Url::parse(value).ok()?;
    Some(
        url.scheme() == "https"
            || (url.scheme() == "http"
                && url
                    .host_str()
                    .is_some_and(|h| ["127.0.0.1", "localhost", "[::1]"].contains(&h))),
    )
}

const SNAPSHOT_URL_MESSAGE: &str = "must be https (plain http only for a loopback host)";

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

    fn verdict<T>(&mut self, key: &str, v: Result<T, String>, json: impl FnOnce(T) -> Json) {
        match v {
            Ok(v) => self.set(key, json(v)),
            Err(m) => self.issue(key, &m),
        }
    }

    /// `z.coerce.number().int()[.min().max()].default(default)`: blank reads as 0.
    fn int(&mut self, key: &str, (default, min, max): (i64, Option<i64>, Option<i64>)) {
        let v = self.f.get(key).map_or(Ok(default), |raw| {
            coerce_int(raw, min.map(|m| (m, false)), max)
        });
        self.verdict(key, v, Json::int);
    }

    /// `z.preprocess(blank → undefined, z.coerce.number().int().min().max()[.default(default)])`: unset with no default is
    /// `Number(undefined)`, which is NaN.
    fn blank_int(&mut self, key: &str, default: Option<i64>, min: i64, max: Option<i64>) {
        let v = match (self.f.blank(key), default) {
            (None, Some(d)) => Ok(d),
            (None, None) => Err("Invalid input: expected number, received NaN".to_owned()),
            (Some(raw), _) => coerce_int(raw, Some((min, false)), max),
        };
        self.verdict(key, v, Json::int);
    }

    /// `z.string().default(default)`.
    fn string(&mut self, key: &str, default: &str) {
        let v = self.f.get(key).unwrap_or(default).to_owned();
        self.set(key, Json::String(v));
    }
}

/// `loadEnv(schema, source)`, then the reads `env.ts` makes after it, in its order.
pub fn load(source: &BTreeMap<String, String>) -> Result<LedgerEnv, EnvError> {
    service_kit::posture::assert_production_posture(source)?;
    let mut f = Fields::new(source);
    // The ledger's own SERVICE_NAME replaces the base one in its place: any string, default svc-ledger.
    let base = service_kit::env::base(&mut f, ServiceName::Own("svc-ledger"));
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
    // The ledger's own HTTP_PORT, in httpEnvSchema's place: any integer, default 4001.
    o.int("HTTP_PORT", (DEFAULT_PORT, None, None));
    let internal = service_kit::env::internal_service(o.f);
    o.set("INTERNAL_SERVICE_SECRET", Json::str(internal.secret));
    o.set("INTERNAL_SERVICE_BODY_BIND", Json::str(internal.body_bind));

    // authEnvSchema.
    let secret =
        o.f.get("JWT_ACCESS_SECRET")
            .map_or(Err(REQUIRED_STRING.to_owned()), |v| min_len(v, 32));
    o.verdict("JWT_ACCESS_SECRET", secret, Json::String);
    o.int("JWT_ACCESS_TTL_SECONDS", (900, Some(60), Some(3600)));
    o.int(
        "JWT_REFRESH_TTL_SECONDS",
        (60 * 60 * 24 * 30, Some(3600), Some(60 * 60 * 24 * 90)),
    );
    o.string("JWT_ISSUER", "intafaced");
    o.string("JWT_AUDIENCE", "intafaced.api");

    let s2s = service_kit::env::s2s(o.f);
    o.set("S2S_AUTH_MODE", Json::str(s2s.mode));
    for (k, v) in [
        ("S2S_KEYRING", s2s.keyring),
        ("S2S_SIGNING_KID", s2s.signing_kid),
        ("S2S_SIGNING_KEY", s2s.signing_key),
    ] {
        if let Some(v) = v {
            o.set(k, Json::str(v));
        }
    }

    // The ledger's own fields.
    let mode =
        o.f.get("LEDGER_IDEMPOTENCY_CONFLICT_MODE")
            .map_or(Ok("detect".to_owned()), |v| {
                one_of(v, &["detect", "refuse"])
            });
    o.verdict("LEDGER_IDEMPOTENCY_CONFLICT_MODE", mode, Json::String);
    o.blank_int("RECONCILE_CRON_MINUTES", None, 1, None);
    for (key, (default, min, max)) in [
        (
            "LEDGER_RECONCILE_STATEMENT_TIMEOUT_MS",
            RECONCILE_STATEMENT_TIMEOUT_MS,
        ),
        (
            "LEDGER_RECONCILE_MAX_STALE_HOURS",
            RECONCILE_MAX_STALE_HOURS,
        ),
        (
            "RECONCILE_MAX_CONSECUTIVE_INCOMPLETE",
            RECONCILE_MAX_CONSECUTIVE_INCOMPLETE,
        ),
    ] {
        o.blank_int(key, Some(default), min, Some(max));
    }
    let custody = parse_custody_layer(o.f.get("LEDGER_CUSTODY_LAYER"));
    o.verdict("LEDGER_CUSTODY_LAYER", custody, Json::str);
    let posting = o
        .f
        .get("LEDGER_POSTING_ENABLED")
        .is_none_or(|v| ["true", "yes", "on", "1"].contains(&js_trim(v).to_lowercase().as_str()));
    o.set("LEDGER_POSTING_ENABLED", Json::Bool(posting));
    if let Some(v) = o.f.get("LEDGER_CLOCK_SKEW_BOUND_MS") {
        o.set("LEDGER_CLOCK_SKEW_BOUND_MS", Json::str(v));
    }
    if let Some(v) = o.f.get("IDENTITY_URL") {
        o.verdict("IDENTITY_URL", url_value(v), Json::String);
    }
    if let Some(v) =
        o.f.get("LEDGER_RECONCILE_OUTSIDE_SNAPSHOT_URL")
            .filter(|v| !v.is_empty())
    {
        let checked = url_value(v).and_then(|u| {
            if is_outside_snapshot_url(&u) == Some(true) {
                Ok(u)
            } else {
                Err(SNAPSHOT_URL_MESSAGE.to_owned())
            }
        });
        o.verdict(
            "LEDGER_RECONCILE_OUTSIDE_SNAPSHOT_URL",
            checked,
            Json::String,
        );
    }
    let json = Json::Object(std::mem::take(&mut o.json));
    f.finish()?;

    let thrown = |message: String| EnvError {
        message,
        issues: Vec::new(),
    };
    let rail_statement_urls = rail_urls(source, "LEDGER_RECONCILE_RAIL_").map_err(thrown)?;
    let open_items_urls = rail_urls(source, "LEDGER_RECONCILE_OPEN_ITEMS_").map_err(thrown)?;
    let clock_skew_bound_ms =
        parse_clock_skew_bound_ms(source.get("LEDGER_CLOCK_SKEW_BOUND_MS").map(String::as_str))
            .map_err(thrown)?;
    let configured = if mode_of(&json) == "refuse" {
        "refuse"
    } else {
        "detect"
    };
    let idempotency_conflict_mode = if service_kit::posture::is_production_posture(source) {
        "refuse"
    } else {
        configured
    };
    Ok(LedgerEnv {
        json,
        clock_skew_bound_ms,
        idempotency_conflict_mode,
        rail_statement_urls,
        open_items_urls,
    })
}

fn mode_of(json: &Json) -> &str {
    match json.get("LEDGER_IDEMPOTENCY_CONFLICT_MODE") {
        Some(Json::String(s)) => s,
        _ => "detect",
    }
}

/// `parseCustodyLayer` (`@intafaced/ledger-client`): blank is off.
pub fn parse_custody_layer(raw: Option<&str>) -> Result<&'static str, String> {
    let Some(raw) = raw.filter(|r| !js_trim(r).is_empty()) else {
        return Ok("off");
    };
    match js_trim(raw).to_lowercase().as_str() {
        "on" => Ok("on"),
        "off" => Ok("off"),
        _ => Err(format!(
            "LEDGER_CUSTODY_LAYER must be \"on\" or \"off\", got \"{raw}\""
        )),
    }
}

/// `parseClockSkewBoundMs`: a non-negative integer string, or blank for none.
pub fn parse_clock_skew_bound_ms(raw: Option<&str>) -> Result<Option<i64>, String> {
    let Some(raw) = raw else { return Ok(None) };
    let t = js_trim(raw);
    if t.is_empty() {
        return Ok(None);
    }
    let digits = t.bytes().all(|b| b.is_ascii_digit()) && (t == "0" || !t.starts_with('0'));
    if !digits {
        return Err(
            "LEDGER_CLOCK_SKEW_BOUND_MS must be a non-negative integer string or blank".to_owned(),
        );
    }
    match t.parse::<i64>() {
        Ok(n) if n <= 9_007_199_254_740_991 => Ok(Some(n)),
        _ => Err("LEDGER_CLOCK_SKEW_BOUND_MS is outside the safe integer range".to_owned()),
    }
}

/// `railUrlsFrom(source, /^<prefix>(.*)_URL$/i)`: each set key names a rail (upper case, `_` for `-`) and holds an https
/// address, or plain http to a loopback host.
fn rail_urls(
    source: &BTreeMap<String, String>,
    prefix: &str,
) -> Result<BTreeMap<String, String>, String> {
    let mut urls = BTreeMap::new();
    for (name, value) in source {
        let upper = name.to_ascii_uppercase();
        let Some(middle) = upper
            .strip_prefix(prefix)
            .and_then(|rest| rest.strip_suffix("_URL"))
            .and_then(|_| name.get(prefix.len()..name.len().saturating_sub(4)))
        else {
            continue;
        };
        if value.is_empty() {
            continue;
        }
        let rail = middle.to_lowercase().replace('_', "-");
        let named = !middle.is_empty()
            && middle
                .bytes()
                .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_');
        let rail_ok = rail.len() <= 63
            && rail.bytes().next().is_some_and(|b| b.is_ascii_lowercase())
            && rail
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
        if !named || !rail_ok {
            return Err(format!("{name}: not a rail id"));
        }
        if is_outside_snapshot_url(value) != Some(true) {
            return Err(format!("{name}: {SNAPSHOT_URL_MESSAGE}"));
        }
        urls.insert(rail, value.clone());
    }
    Ok(urls)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test: a failure is the point")]
    use super::*;

    // `env-idempotency-conflict-mode.test.ts`, case for case: a production-posture process refuses a reused key with
    // a different body whatever the setting says; dev and test keep the setting and its `detect` default.
    fn mode(vars: &[(&str, &str)]) -> &'static str {
        let secret = "s".repeat(32);
        let mut source: BTreeMap<String, String> = [
            ("NODE_ENV", "test"),
            ("DATABASE_URL", "postgres://u:p@localhost:5432/db"),
            ("DATABASE_POOL_MAX", "10"),
            ("INTERNAL_SERVICE_SECRET", secret.as_str()),
            ("INTERNAL_SERVICE_BODY_BIND", "require"),
            ("JWT_ACCESS_SECRET", secret.as_str()),
            ("RECONCILE_CRON_MINUTES", "60"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_owned(), v.to_owned()))
        .collect();
        for (k, v) in vars {
            source.insert((*k).to_owned(), (*v).to_owned());
        }
        match load(&source) {
            Ok(env) => env.idempotency_conflict_mode,
            Err(e) => panic!("{vars:?}: {}", e.message),
        }
    }

    #[test]
    fn app_env_prod_or_staging_resolves_refuse_for_the_default_and_for_an_explicit_detect() {
        for app_env in ["prod", "staging"] {
            assert_eq!(mode(&[("APP_ENV", app_env)]), "refuse", "{app_env} default");
            assert_eq!(
                mode(&[
                    ("APP_ENV", app_env),
                    ("LEDGER_IDEMPOTENCY_CONFLICT_MODE", "detect")
                ]),
                "refuse",
                "{app_env} detect"
            );
            assert_eq!(
                mode(&[
                    ("APP_ENV", app_env),
                    ("LEDGER_IDEMPOTENCY_CONFLICT_MODE", "refuse")
                ]),
                "refuse",
                "{app_env} refuse"
            );
        }
    }

    #[test]
    fn node_env_production_without_app_env_is_enforced_too() {
        assert_eq!(
            mode(&[
                ("NODE_ENV", "production"),
                ("LEDGER_IDEMPOTENCY_CONFLICT_MODE", "detect")
            ]),
            "refuse"
        );
    }

    #[test]
    fn app_env_dev_or_test_keeps_the_configured_value_and_the_detect_default() {
        for app_env in ["dev", "test"] {
            assert_eq!(mode(&[("APP_ENV", app_env)]), "detect", "{app_env} default");
            assert_eq!(
                mode(&[
                    ("APP_ENV", app_env),
                    ("LEDGER_IDEMPOTENCY_CONFLICT_MODE", "detect")
                ]),
                "detect",
                "{app_env} detect"
            );
            assert_eq!(
                mode(&[
                    ("APP_ENV", app_env),
                    ("LEDGER_IDEMPOTENCY_CONFLICT_MODE", "refuse")
                ]),
                "refuse",
                "{app_env} refuse"
            );
        }
    }
}
