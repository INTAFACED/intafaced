//! The shared environment slices of `@intafaced/config` (`packages/config/src/env.ts`): `baseEnvSchema`,
//! `otelEnvSchema`, `httpEnvSchema`, `edgeEnvSchema`, `internalServiceEnvSchema` and `s2sEnvSchema`, with zod 4's
//! messages, and what `loadEnv` does with them: every problem is listed at once, as `<NAME>: <message>`, in the order
//! the fields are read.
//!
//! A service reads its environment through one `Fields`: first `posture::assert_production_posture` (as `loadEnv`
//! runs it before any schema), then the slices it merges, in its schema's order, then its own fields, then `finish`.
//! A slice is called by its full path (`service_kit::env::edge(&mut f)`): `tooling/scripts/services-map.mjs` reads a
//! Rust service's required env from those calls and from this file.

use std::collections::BTreeMap;

use crate::money::js_trim;
use crate::s2s::js_length;

/// `EnvError` / `ProductionPostureError`: refused at boot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EnvError {
    pub message: String,
    pub issues: Vec<String>,
}

/// `Number(text)` as JavaScript reads a string: `None` is `NaN`.
pub fn js_number(text: &str) -> Option<f64> {
    let t = js_trim(text);
    if t.is_empty() {
        return Some(0.0);
    }
    let radix = |p: &str, r: u32| {
        t.get(2..)
            .filter(|_| t.len() > 2 && t.get(..2).is_some_and(|x| x.eq_ignore_ascii_case(p)))
            .map(|digits| {
                digits.chars().try_fold(0.0_f64, |acc, c| {
                    #[expect(
                        clippy::float_arithmetic,
                        reason = "Number('0x..') is a float in JavaScript too"
                    )]
                    c.to_digit(r).map(|d| acc * f64::from(r) + f64::from(d))
                })
            })
    };
    for (p, r) in [("0x", 16), ("0o", 8), ("0b", 2)] {
        if let Some(v) = radix(p, r) {
            return v;
        }
    }
    let body = t.strip_prefix(['+', '-']).unwrap_or(t);
    if body == "Infinity" {
        return Some(if t.starts_with('-') {
            f64::NEG_INFINITY
        } else {
            f64::INFINITY
        });
    }
    // StrDecimalLiteral: digits with an optional point and fraction (one side may be empty, not both), optional exponent.
    let (mantissa, exponent) = match body.find(['e', 'E']) {
        Some(i) => (body.get(..i)?, Some(body.get(i + 1..)?)),
        None => (body, None),
    };
    let (whole, frac) = mantissa.split_once('.').unwrap_or((mantissa, ""));
    let digits = |s: &str| s.bytes().all(|b| b.is_ascii_digit());
    if !digits(whole) || !digits(frac) || (whole.is_empty() && frac.is_empty()) {
        return None;
    }
    if let Some(e) = exponent {
        let e = e.strip_prefix(['+', '-']).unwrap_or(e);
        if e.is_empty() || !digits(e) {
            return None;
        }
    }
    t.parse::<f64>().ok()
}

/// One field's verdict: its value, or zod's message.
pub type Check<T> = Result<T, String>;

const MAX_SAFE: f64 = 9_007_199_254_740_991.0;

/// `z.coerce.number().int()` with optional bounds (`min` as `(bound, exclusive)`); the zod 4 messages.
pub fn coerce_int(raw: &str, min: Option<(i64, bool)>, max: Option<i64>) -> Check<i64> {
    let n = js_number(raw).ok_or("Invalid input: expected number, received NaN")?;
    if !n.is_finite() || n.fract() != 0.0 || n.abs() > MAX_SAFE {
        return Err("Invalid input: expected int, received number".to_owned());
    }
    #[expect(
        clippy::cast_possible_truncation,
        reason = "a safe integer, checked above"
    )]
    let v = n as i64;
    if let Some((lo, exclusive)) = min {
        if exclusive && v <= lo {
            return Err(format!("Too small: expected number to be >{lo}"));
        }
        if !exclusive && v < lo {
            return Err(format!("Too small: expected number to be >={lo}"));
        }
    }
    if let Some(hi) = max.filter(|hi| v > *hi) {
        return Err(format!("Too big: expected number to be <={hi}"));
    }
    Ok(v)
}

/// `z.enum(options)`.
pub fn one_of(raw: &str, options: &[&str]) -> Check<String> {
    if options.contains(&raw) {
        Ok(raw.to_owned())
    } else {
        Err(format!(
            "Invalid option: expected one of {}",
            options
                .iter()
                .map(|o| format!("\"{o}\""))
                .collect::<Vec<_>>()
                .join("|")
        ))
    }
}

/// `z.string().min(min)`.
pub fn min_len(raw: &str, min: usize) -> Check<String> {
    if js_length(raw) < min {
        Err(format!(
            "Too small: expected string to have >={min} characters"
        ))
    } else {
        Ok(raw.to_owned())
    }
}

fn is_url(raw: &str) -> bool {
    url::Url::parse(raw).is_ok()
}

/// `z.string().url()`.
pub fn url_field(raw: &str) -> Check<String> {
    if is_url(raw) {
        Ok(raw.to_owned())
    } else {
        Err("Invalid URL".to_owned())
    }
}

/// zod's message for a required string that is unset.
pub const REQUIRED_STRING: &str = "Invalid input: expected string, received undefined";

/// `bool`: a string is true when it is 1, true, yes or on (any case).
pub fn truthy(raw: &str) -> bool {
    ["1", "true", "yes", "on"].contains(&raw.to_lowercase().as_str())
}

/// The environment being read, and every problem found so far.
pub struct Fields<'a> {
    source: &'a BTreeMap<String, String>,
    pub issues: Vec<String>,
}

impl<'a> Fields<'a> {
    pub fn new(source: &'a BTreeMap<String, String>) -> Fields<'a> {
        Fields {
            source,
            issues: Vec::new(),
        }
    }

    /// The variable as set, blank included.
    pub fn get(&self, key: &str) -> Option<&'a str> {
        self.source.get(key).map(String::as_str)
    }

    /// The variable, a blank one read as absent.
    pub fn blank(&self, key: &str) -> Option<&'a str> {
        self.get(key).filter(|s| !js_trim(s).is_empty())
    }

    /// One field's value, or `default` with its problem listed as `<name>: <message>`.
    pub fn field<T>(&mut self, name: &str, value: Check<T>, default: T) -> T {
        match value {
            Ok(v) => v,
            Err(m) => {
                self.issues.push(format!("{name}: {m}"));
                default
            }
        }
    }

    /// `loadEnv`'s verdict: every problem at once, under the process's `SERVICE_NAME` (else `process`).
    pub fn finish(self) -> Result<(), EnvError> {
        if self.issues.is_empty() {
            return Ok(());
        }
        Err(EnvError {
            message: format!(
                "Invalid environment for {}:\n  - {}",
                self.get("SERVICE_NAME").unwrap_or("process"),
                self.issues.join("\n  - ")
            ),
            issues: self.issues,
        })
    }
}

/// How a service reads `SERVICE_NAME`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ServiceName {
    /// `baseEnvSchema`'s: at least one character, default `unknown-service`.
    Base,
    /// A service's own field in its place: any string, this default.
    Own(&'static str),
}

/// `baseEnvSchema`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BaseEnv {
    pub node_env: String,
    pub app_env: String,
    pub log_level: String,
    pub service_name: String,
    pub launch_drop: String,
}

/// `baseEnvSchema`'s fields, in its order.
pub fn base(f: &mut Fields<'_>, service_name: ServiceName) -> BaseEnv {
    let v = f.get("NODE_ENV").map_or(Ok("development".to_owned()), |v| {
        one_of(v, &["development", "test", "production"])
    });
    let node_env = f.field("NODE_ENV", v, String::new());
    let v = f.get("APP_ENV").map_or(Ok("dev".to_owned()), |v| {
        one_of(v, &["dev", "test", "staging", "prod"])
    });
    let app_env = f.field("APP_ENV", v, String::new());
    let v = f.get("LOG_LEVEL").map_or(Ok("info".to_owned()), |v| {
        one_of(v, &["fatal", "error", "warn", "info", "debug", "trace"])
    });
    let log_level = f.field("LOG_LEVEL", v, String::new());
    let service_name = match service_name {
        ServiceName::Own(default) => f.get("SERVICE_NAME").unwrap_or(default).to_owned(),
        ServiceName::Base => {
            let v = f
                .get("SERVICE_NAME")
                .map_or(Ok("unknown-service".to_owned()), |v| min_len(v, 1));
            f.field("SERVICE_NAME", v, String::new())
        }
    };
    let v = f.get("LAUNCH_DROP").map_or(Ok("0".to_owned()), |v| {
        one_of(v, &["0", "I", "II", "III", "IV", "V"])
    });
    let launch_drop = f.field("LAUNCH_DROP", v, String::new());
    BaseEnv {
        node_env,
        app_env,
        log_level,
        service_name,
        launch_drop,
    }
}

/// `postgresEnvSchema`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PostgresEnv {
    pub url: String,
    pub pool_max: i64,
    pub ssl: bool,
}

/// `postgresEnvSchema`'s fields: the address has no default, and a blank or unset pool size refuses (never 10).
pub fn postgres(f: &mut Fields<'_>) -> PostgresEnv {
    let v = f
        .get("DATABASE_URL")
        .map_or(Err(REQUIRED_STRING.to_owned()), url_field);
    let url = f.field("DATABASE_URL", v, String::new());
    // Blank is undefined, and `Number(undefined)` is NaN.
    let v = coerce_int(
        f.blank("DATABASE_POOL_MAX").unwrap_or("NaN"),
        Some((1, false)),
        Some(200),
    );
    let pool_max = f.field("DATABASE_POOL_MAX", v, 0);
    let ssl = f.get("DATABASE_SSL").is_some_and(truthy);
    PostgresEnv { url, pool_max, ssl }
}

/// `redisEnvSchema`'s one field.
pub fn redis(f: &mut Fields<'_>) -> String {
    let v = f
        .get("REDIS_URL")
        .map_or(Ok("redis://localhost:6379".to_owned()), url_field);
    f.field("REDIS_URL", v, String::new())
}

/// `natsEnvSchema`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NatsEnv {
    pub url: String,
    pub stream_prefix: String,
}

/// `natsEnvSchema`'s fields: the address is trimmed and must not be blank.
pub fn nats(f: &mut Fields<'_>) -> NatsEnv {
    let v = f
        .get("NATS_URL")
        .map_or(Ok("nats://localhost:4222".to_owned()), |v| {
            min_len(js_trim(v), 1)
        });
    let url = f.field("NATS_URL", v, String::new());
    let stream_prefix = f
        .get("NATS_STREAM_PREFIX")
        .unwrap_or("INTAFACED")
        .to_owned();
    NatsEnv { url, stream_prefix }
}

/// `otelEnvSchema`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OtelEnv {
    pub endpoint: String,
    pub enabled: bool,
}

/// `otelEnvSchema`'s fields.
pub fn otel(f: &mut Fields<'_>) -> OtelEnv {
    let v = f
        .get("OTEL_EXPORTER_OTLP_ENDPOINT")
        .map_or(Ok("http://localhost:4318".to_owned()), url_field);
    let endpoint = f.field("OTEL_EXPORTER_OTLP_ENDPOINT", v, String::new());
    let enabled = f.get("OTEL_ENABLED").is_none_or(truthy);
    OtelEnv { endpoint, enabled }
}

/// `httpEnvSchema`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpEnv {
    pub host: String,
    pub port: i64,
}

/// `httpEnvSchema`'s fields, with the service's own default port in place of 3000.
pub fn http(f: &mut Fields<'_>, default_port: i64) -> HttpEnv {
    let host = f.get("HTTP_HOST").unwrap_or("0.0.0.0").to_owned();
    let v = f
        .get("HTTP_PORT")
        .map_or(Ok(default_port), |v| coerce_int(v, Some((0, true)), None));
    let port = f.field("HTTP_PORT", v, 0);
    HttpEnv { host, port }
}

/// `edgeEnvSchema`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EdgeEnv {
    pub secret: String,
    pub public_key: Option<String>,
    pub max_lifetime_seconds: Option<i64>,
    pub clock_skew_seconds: Option<i64>,
}

/// `edgeEnvSchema`'s fields: the shared secret has no default.
pub fn edge(f: &mut Fields<'_>) -> EdgeEnv {
    let v = f
        .get("EDGE_PRINCIPAL_SECRET")
        .map_or(Err(REQUIRED_STRING.to_owned()), |v| min_len(v, 32));
    let secret = f.field("EDGE_PRINCIPAL_SECRET", v, String::new());
    let v = f
        .get("EDGE_PRINCIPAL_PUBLIC_KEY")
        .map(|v| {
            let ok = v.len() == 43
                && v.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
            if ok {
                Ok(v.to_owned())
            } else {
                Err("must be a raw 32-byte Ed25519 public key, base64url".to_owned())
            }
        })
        .transpose();
    let public_key = f.field("EDGE_PRINCIPAL_PUBLIC_KEY", v, None);
    let v = f
        .get("EDGE_PRINCIPAL_MAX_LIFETIME_SECONDS")
        .map(|v| coerce_int(v, Some((1, false)), Some(300)))
        .transpose();
    let max_lifetime_seconds = f.field("EDGE_PRINCIPAL_MAX_LIFETIME_SECONDS", v, None);
    let v = f
        .get("EDGE_PRINCIPAL_CLOCK_SKEW_SECONDS")
        .map(|v| coerce_int(v, Some((1, false)), Some(60)))
        .transpose();
    let clock_skew_seconds = f.field("EDGE_PRINCIPAL_CLOCK_SKEW_SECONDS", v, None);
    EdgeEnv {
        secret,
        public_key,
        max_lifetime_seconds,
        clock_skew_seconds,
    }
}

/// `internalServiceEnvSchema`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InternalServiceEnv {
    pub secret: String,
    pub body_bind: String,
}

/// `internalServiceEnvSchema`'s fields: the shared secret has no default.
pub fn internal_service(f: &mut Fields<'_>) -> InternalServiceEnv {
    let v = f
        .get("INTERNAL_SERVICE_SECRET")
        .map_or(Err(REQUIRED_STRING.to_owned()), |v| min_len(v, 32));
    let secret = f.field("INTERNAL_SERVICE_SECRET", v, String::new());
    let v = f
        .get("INTERNAL_SERVICE_BODY_BIND")
        .map_or(Ok("accept-both".to_owned()), |v| {
            one_of(v, &["accept-both", "require"])
        });
    let body_bind = f.field("INTERNAL_SERVICE_BODY_BIND", v, String::new());
    InternalServiceEnv { secret, body_bind }
}

/// `s2sEnvSchema`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct S2sEnv {
    pub mode: String,
    pub keyring: Option<String>,
    pub signing_kid: Option<String>,
    pub signing_key: Option<String>,
}

/// `s2sEnvSchema`'s fields; `off` by default.
pub fn s2s(f: &mut Fields<'_>) -> S2sEnv {
    let v = f.get("S2S_AUTH_MODE").map_or(Ok("off".to_owned()), |v| {
        one_of(v, &["off", "dual", "keypair"])
    });
    let mode = f.field("S2S_AUTH_MODE", v, String::new());
    let v = f.get("S2S_KEYRING").map(|v| min_len(v, 2)).transpose();
    let keyring = f.field("S2S_KEYRING", v, None);
    let v = f
        .get("S2S_SIGNING_KID")
        .map(|v| {
            let n = js_length(v);
            if n < 3 {
                Err("Too small: expected string to have >=3 characters".to_owned())
            } else if n > 64 {
                Err("Too big: expected string to have <=64 characters".to_owned())
            } else {
                Ok(v.to_owned())
            }
        })
        .transpose();
    let signing_kid = f.field("S2S_SIGNING_KID", v, None);
    let v = f.get("S2S_SIGNING_KEY").map(|v| min_len(v, 40)).transpose();
    let signing_key = f.field("S2S_SIGNING_KEY", v, None);
    S2sEnv {
        mode,
        keyring,
        signing_kid,
        signing_key,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn number_reads_strings_as_javascript_does() {
        assert_eq!(js_number(" 12 "), Some(12.0));
        assert_eq!(js_number(""), Some(0.0));
        assert_eq!(js_number("1e3"), Some(1000.0));
        assert_eq!(js_number(".5"), Some(0.5));
        assert_eq!(js_number("5."), Some(5.0));
        assert_eq!(js_number("0b101"), Some(5.0));
        assert_eq!(js_number("-0x10"), None);
        assert_eq!(js_number("inf"), None);
        assert_eq!(js_number("NaN"), None);
        assert_eq!(js_number("1_000"), None);
        assert_eq!(js_number("-Infinity"), Some(f64::NEG_INFINITY));
    }

    fn source(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect()
    }

    #[test]
    fn base_service_name_is_at_least_one_character_and_defaults_as_the_schema() {
        let empty = source(&[]);
        let mut f = Fields::new(&empty);
        assert_eq!(
            base(&mut f, ServiceName::Base).service_name,
            "unknown-service"
        );
        assert!(f.finish().is_ok());
        let blank = source(&[("SERVICE_NAME", "")]);
        let mut f = Fields::new(&blank);
        base(&mut f, ServiceName::Base);
        assert_eq!(
            f.issues,
            vec!["SERVICE_NAME: Too small: expected string to have >=1 characters".to_owned()]
        );
        let mut f = Fields::new(&blank);
        assert_eq!(base(&mut f, ServiceName::Own("svc-x")).service_name, "");
        assert!(f.finish().is_ok());
    }

    #[test]
    fn every_problem_is_listed_at_once_under_the_service_name() {
        let env = source(&[("SERVICE_NAME", "svc-x"), ("HTTP_PORT", "0")]);
        let mut f = Fields::new(&env);
        http(&mut f, 4000);
        edge(&mut f);
        internal_service(&mut f);
        let err = f.finish().unwrap_err();
        assert_eq!(
            err.issues,
            vec![
                "HTTP_PORT: Too small: expected number to be >0".to_owned(),
                format!("EDGE_PRINCIPAL_SECRET: {REQUIRED_STRING}"),
                format!("INTERNAL_SERVICE_SECRET: {REQUIRED_STRING}"),
            ]
        );
        assert!(
            err.message
                .starts_with("Invalid environment for svc-x:\n  - HTTP_PORT")
        );
    }
}
