//! svc-tax's environment (`services/svc-tax/src/env.ts`): `baseEnvSchema`, `otelEnvSchema`, `httpEnvSchema`,
//! `edgeEnvSchema`, `internalServiceEnvSchema` and `s2sEnvSchema` from `@intafaced/config`, merged with svc-tax's own
//! fields, loaded by `loadEnv` (which first refuses development material in production posture). Same defaults, same
//! blank-as-absent fields, same refusals; every problem is listed at once.

use std::collections::BTreeMap;

use crate::money::js_trim;

pub const TAX_DATABASE_POOL_MAX_UNSET: &str = "tax.database_pool_max_unset";

/// The loaded environment.
#[derive(Debug, Clone, PartialEq)]
pub struct TaxEnv {
    pub node_env: String,
    pub app_env: String,
    pub log_level: String,
    pub service_name: String,
    pub launch_drop: String,
    pub otel_endpoint: String,
    pub otel_enabled: bool,
    pub http_host: String,
    pub http_port: i64,
    pub edge_secret: String,
    pub edge_public_key: Option<String>,
    pub edge_max_lifetime_seconds: Option<i64>,
    pub edge_clock_skew_seconds: Option<i64>,
    pub internal_secret: String,
    pub internal_body_bind: String,
    pub s2s_mode: String,
    pub s2s_keyring: Option<String>,
    pub s2s_signing_kid: Option<String>,
    pub s2s_signing_key: Option<String>,
    pub ledger_url: String,
    pub tax_jurisdiction_map_json: String,
    pub tax_history_years: Option<i64>,
    pub data_lake_url: Option<String>,
    pub indexer_url: Option<String>,
    pub trade_url: Option<String>,
    pub bank_url: Option<String>,
    pub tax_deposit_basis: Option<String>,
    pub database_url: Option<String>,
    pub database_pool_max: Option<i64>,
    /// The whole process environment, for the jurisdiction guard's switches and lists.
    pub raw: BTreeMap<String, String>,
}

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

/// One field's verdict.
type Check<T> = Result<T, String>;

const MAX_SAFE: f64 = 9_007_199_254_740_991.0;

/// `z.coerce.number().int()` with optional bounds; the zod 4 messages.
fn coerce_int(raw: &str, min: Option<(i64, bool)>, max: Option<i64>) -> Check<i64> {
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

fn one_of(raw: &str, options: &[&str]) -> Check<String> {
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

fn min_len(raw: &str, min: usize) -> Check<String> {
    if crate::s2s::js_length(raw) < min {
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

fn url_field(raw: &str) -> Check<String> {
    if is_url(raw) {
        Ok(raw.to_owned())
    } else {
        Err("Invalid URL".to_owned())
    }
}

const REQUIRED_STRING: &str = "Invalid input: expected string, received undefined";

/// `bool`: a string is true when it is 1, true, yes or on (any case).
fn truthy(raw: &str) -> bool {
    ["1", "true", "yes", "on"].contains(&raw.to_lowercase().as_str())
}

/// `loadEnv(schema, source)`.
pub fn load(source: &BTreeMap<String, String>) -> Result<TaxEnv, EnvError> {
    crate::posture::assert_production_posture(source)?;
    let mut issues: Vec<String> = Vec::new();
    let get = |k: &str| source.get(k).map(String::as_str);
    fn blank(v: Option<&str>) -> Option<&str> {
        v.filter(|s| !js_trim(s).is_empty())
    }

    macro_rules! field {
        ($name:literal, $value:expr, $default:expr) => {
            match $value {
                Ok(v) => v,
                Err(m) => {
                    issues.push(format!("{}: {m}", $name));
                    $default
                }
            }
        };
    }

    let node_env = field!(
        "NODE_ENV",
        get("NODE_ENV").map_or(Ok("development".to_owned()), |v| one_of(
            v,
            &["development", "test", "production"]
        )),
        String::new()
    );
    let app_env = field!(
        "APP_ENV",
        get("APP_ENV").map_or(Ok("dev".to_owned()), |v| one_of(
            v,
            &["dev", "test", "staging", "prod"]
        )),
        String::new()
    );
    let log_level = field!(
        "LOG_LEVEL",
        get("LOG_LEVEL").map_or(Ok("info".to_owned()), |v| one_of(
            v,
            &["fatal", "error", "warn", "info", "debug", "trace"]
        )),
        String::new()
    );
    // svc-tax's own field replaces the base one in its place: any string, default svc-tax.
    let service_name = get("SERVICE_NAME").unwrap_or("svc-tax").to_owned();
    let launch_drop = field!(
        "LAUNCH_DROP",
        get("LAUNCH_DROP").map_or(Ok("0".to_owned()), |v| one_of(
            v,
            &["0", "I", "II", "III", "IV", "V"]
        )),
        String::new()
    );
    let otel_endpoint = field!(
        "OTEL_EXPORTER_OTLP_ENDPOINT",
        get("OTEL_EXPORTER_OTLP_ENDPOINT")
            .map_or(Ok("http://localhost:4318".to_owned()), url_field),
        String::new()
    );
    let otel_enabled = get("OTEL_ENABLED").is_none_or(truthy);
    let http_host = get("HTTP_HOST").unwrap_or("0.0.0.0").to_owned();
    let http_port = field!(
        "HTTP_PORT",
        get("HTTP_PORT").map_or(Ok(4020), |v| coerce_int(v, Some((0, true)), None)),
        0
    );
    let edge_secret = field!(
        "EDGE_PRINCIPAL_SECRET",
        get("EDGE_PRINCIPAL_SECRET").map_or(Err(REQUIRED_STRING.to_owned()), |v| min_len(v, 32)),
        String::new()
    );
    let edge_public_key = field!(
        "EDGE_PRINCIPAL_PUBLIC_KEY",
        get("EDGE_PRINCIPAL_PUBLIC_KEY")
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
            .transpose(),
        None
    );
    let edge_max_lifetime_seconds = field!(
        "EDGE_PRINCIPAL_MAX_LIFETIME_SECONDS",
        get("EDGE_PRINCIPAL_MAX_LIFETIME_SECONDS")
            .map(|v| coerce_int(v, Some((1, false)), Some(300)))
            .transpose(),
        None
    );
    let edge_clock_skew_seconds = field!(
        "EDGE_PRINCIPAL_CLOCK_SKEW_SECONDS",
        get("EDGE_PRINCIPAL_CLOCK_SKEW_SECONDS")
            .map(|v| coerce_int(v, Some((1, false)), Some(60)))
            .transpose(),
        None
    );
    let internal_secret = field!(
        "INTERNAL_SERVICE_SECRET",
        get("INTERNAL_SERVICE_SECRET").map_or(Err(REQUIRED_STRING.to_owned()), |v| min_len(v, 32)),
        String::new()
    );
    let internal_body_bind = field!(
        "INTERNAL_SERVICE_BODY_BIND",
        get("INTERNAL_SERVICE_BODY_BIND").map_or(Ok("accept-both".to_owned()), |v| one_of(
            v,
            &["accept-both", "require"]
        )),
        String::new()
    );
    let s2s_mode = field!(
        "S2S_AUTH_MODE",
        get("S2S_AUTH_MODE").map_or(Ok("off".to_owned()), |v| one_of(
            v,
            &["off", "dual", "keypair"]
        )),
        String::new()
    );
    let s2s_keyring = field!(
        "S2S_KEYRING",
        get("S2S_KEYRING").map(|v| min_len(v, 2)).transpose(),
        None
    );
    let s2s_signing_kid = field!(
        "S2S_SIGNING_KID",
        get("S2S_SIGNING_KID")
            .map(|v| {
                let n = crate::s2s::js_length(v);
                if n < 3 {
                    Err("Too small: expected string to have >=3 characters".to_owned())
                } else if n > 64 {
                    Err("Too big: expected string to have <=64 characters".to_owned())
                } else {
                    Ok(v.to_owned())
                }
            })
            .transpose(),
        None
    );
    let s2s_signing_key = field!(
        "S2S_SIGNING_KEY",
        get("S2S_SIGNING_KEY").map(|v| min_len(v, 40)).transpose(),
        None
    );
    let ledger_url = field!(
        "LEDGER_URL",
        get("LEDGER_URL").map_or(Ok("http://localhost:4001".to_owned()), url_field),
        String::new()
    );
    let tax_jurisdiction_map_json = get("TAX_JURISDICTION_MAP_JSON").unwrap_or("").to_owned();
    let tax_history_years = field!(
        "TAX_HISTORY_YEARS",
        blank(get("TAX_HISTORY_YEARS"))
            .map(|v| coerce_int(v, Some((1, false)), Some(100)))
            .transpose(),
        None
    );
    let optional_url = |k: &str| blank(get(k)).map(url_field).transpose();
    let data_lake_url = field!(
        "CONNECT_DATA_LAKE_TSDB_URL",
        optional_url("CONNECT_DATA_LAKE_TSDB_URL"),
        None
    );
    let indexer_url = field!("INDEXER_URL", optional_url("INDEXER_URL"), None);
    let trade_url = field!("TRADE_URL", optional_url("TRADE_URL"), None);
    let bank_url = field!("BANK_URL", optional_url("BANK_URL"), None);
    let tax_deposit_basis = field!(
        "TAX_DEPOSIT_BASIS",
        blank(get("TAX_DEPOSIT_BASIS"))
            .map(|v| one_of(v, &["market", "customer"]))
            .transpose(),
        None
    );
    let database_url = field!("DATABASE_URL", optional_url("DATABASE_URL"), None);

    // The superRefine runs once every field parsed: a set DATABASE_URL needs the shared schema's DATABASE_POOL_MAX.
    let mut database_pool_max = None;
    if issues.is_empty() && database_url.is_some() {
        match blank(get("DATABASE_POOL_MAX")) {
            None => issues.push(format!("DATABASE_POOL_MAX: {TAX_DATABASE_POOL_MAX_UNSET}")),
            Some(v) => match coerce_int(v, Some((1, false)), Some(200)) {
                Ok(n) => database_pool_max = Some(n),
                Err(m) => issues.push(format!("DATABASE_POOL_MAX: {m}")),
            },
        }
    }

    if !issues.is_empty() {
        return Err(EnvError {
            message: format!(
                "Invalid environment for {}:\n  - {}",
                get("SERVICE_NAME").unwrap_or("process"),
                issues.join("\n  - ")
            ),
            issues,
        });
    }
    Ok(TaxEnv {
        node_env,
        app_env,
        log_level,
        service_name,
        launch_drop,
        otel_endpoint,
        otel_enabled,
        http_host,
        http_port,
        edge_secret,
        edge_public_key,
        edge_max_lifetime_seconds,
        edge_clock_skew_seconds,
        internal_secret,
        internal_body_bind,
        s2s_mode,
        s2s_keyring,
        s2s_signing_kid,
        s2s_signing_key,
        ledger_url,
        tax_jurisdiction_map_json,
        tax_history_years,
        data_lake_url,
        indexer_url,
        trade_url,
        bank_url,
        tax_deposit_basis,
        database_url,
        database_pool_max,
        raw: source.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        let s = "s".repeat(32);
        let mut m: BTreeMap<String, String> = [
            ("EDGE_PRINCIPAL_SECRET", s.as_str()),
            ("INTERNAL_SERVICE_SECRET", s.as_str()),
            ("NODE_ENV", "test"),
        ]
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect();
        for (k, v) in pairs {
            m.insert((*k).to_owned(), (*v).to_owned());
        }
        m
    }

    const URL: &str = "postgres://svc_tax:svc_tax@127.0.0.1:55432/intafaced_test";

    // pool-max.test.ts
    #[test]
    fn a_blank_size_with_a_database_refuses_and_does_not_invent_one() {
        for pool in [Some(""), Some("   "), None] {
            let mut pairs = vec![("DATABASE_URL", URL)];
            if let Some(p) = pool {
                pairs.push(("DATABASE_POOL_MAX", p));
            }
            let err = load(&env(&pairs)).unwrap_err();
            assert_eq!(
                err.issues,
                vec![format!("DATABASE_POOL_MAX: {TAX_DATABASE_POOL_MAX_UNSET}")]
            );
            assert!(err.message.starts_with("Invalid environment for process:"));
        }
    }

    #[test]
    fn zero_and_a_non_integer_are_not_a_pool() {
        for pool in ["0", "1.5"] {
            let err =
                load(&env(&[("DATABASE_URL", URL), ("DATABASE_POOL_MAX", pool)])).unwrap_err();
            assert!(
                err.message.contains("DATABASE_POOL_MAX"),
                "{pool}: {}",
                err.message
            );
        }
    }

    #[test]
    fn uses_the_owner_size_and_a_missing_database_does_not_need_one() {
        let sized = load(&env(&[("DATABASE_URL", URL), ("DATABASE_POOL_MAX", "4")])).unwrap();
        assert_eq!(sized.database_pool_max, Some(4));
        let unwired = load(&env(&[("DATABASE_URL", ""), ("DATABASE_POOL_MAX", "")])).unwrap();
        assert_eq!(unwired.database_url, None);
        assert_eq!(unwired.database_pool_max, None);
    }

    #[test]
    fn defaults_and_blank_as_absent_as_env_ts() {
        let e = load(&env(&[])).unwrap();
        assert_eq!(
            (
                e.service_name.as_str(),
                e.http_port,
                e.ledger_url.as_str(),
                e.http_host.as_str()
            ),
            ("svc-tax", 4020, "http://localhost:4001", "0.0.0.0")
        );
        assert_eq!(e.tax_history_years, None);
        assert!(e.otel_enabled);
        let e = load(&env(&[
            ("TAX_HISTORY_YEARS", " "),
            ("TRADE_URL", ""),
            ("TAX_DEPOSIT_BASIS", ""),
        ]))
        .unwrap();
        assert_eq!(
            (e.tax_history_years, e.trade_url, e.tax_deposit_basis),
            (None, None, None)
        );
        assert_eq!(
            load(&env(&[("TAX_HISTORY_YEARS", "10")]))
                .unwrap()
                .tax_history_years,
            Some(10)
        );
        for bad in ["0", "101", "2.5", "ten"] {
            assert!(load(&env(&[("TAX_HISTORY_YEARS", bad)])).is_err(), "{bad}");
        }
        assert!(load(&env(&[("TAX_DEPOSIT_BASIS", "cost")])).is_err());
        assert!(
            !load(&env(&[("OTEL_ENABLED", "false")]))
                .unwrap()
                .otel_enabled
        );
        assert!(load(&env(&[("OTEL_ENABLED", "On")])).unwrap().otel_enabled);
        assert!(load(&env(&[("EDGE_PRINCIPAL_SECRET", "short")])).is_err());
        assert_eq!(load(&env(&[("HTTP_PORT", "0x10")])).unwrap().http_port, 16);
        assert!(
            load(&env(&[("HTTP_PORT", "")])).is_err(),
            "Number('') is 0, not positive"
        );
    }

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
}
