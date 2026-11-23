//! svc-tax's environment (`env.ts`): `baseEnvSchema`, `otelEnvSchema`, `httpEnvSchema`,
//! `edgeEnvSchema`, `internalServiceEnvSchema` and `s2sEnvSchema` from `@intafaced/config` (the kit's slices,
//! `service_kit::env`), merged with svc-tax's own fields, loaded by `loadEnv` (which first refuses development material
//! in production posture). Same defaults, same blank-as-absent fields, same refusals; every problem is listed at once.

use std::collections::BTreeMap;

pub use service_kit::env::{EnvError, js_number};
use service_kit::env::{Fields, ServiceName, coerce_int, one_of, url_field};

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

/// `loadEnv(schema, source)`.
pub fn load(source: &BTreeMap<String, String>) -> Result<TaxEnv, EnvError> {
    crate::posture::assert_production_posture(source)?;
    let mut f = Fields::new(source);
    // svc-tax's own SERVICE_NAME replaces the base one in its place: any string, default svc-tax.
    let base = service_kit::env::base(&mut f, ServiceName::Own("svc-tax"));
    let otel = service_kit::env::otel(&mut f);
    let http = service_kit::env::http(&mut f, 4020);
    let edge = service_kit::env::edge(&mut f);
    let internal = service_kit::env::internal_service(&mut f);
    let s2s = service_kit::env::s2s(&mut f);
    let v = f
        .get("LEDGER_URL")
        .map_or(Ok("http://localhost:4001".to_owned()), url_field);
    let ledger_url = f.field("LEDGER_URL", v, String::new());
    let tax_jurisdiction_map_json = f.get("TAX_JURISDICTION_MAP_JSON").unwrap_or("").to_owned();
    let v = f
        .blank("TAX_HISTORY_YEARS")
        .map(|v| coerce_int(v, Some((1, false)), Some(100)))
        .transpose();
    let tax_history_years = f.field("TAX_HISTORY_YEARS", v, None);
    let mut optional_url = |k: &str| {
        let v = f.blank(k).map(url_field).transpose();
        f.field(k, v, None)
    };
    let data_lake_url = optional_url("CONNECT_DATA_LAKE_TSDB_URL");
    let indexer_url = optional_url("INDEXER_URL");
    let trade_url = optional_url("TRADE_URL");
    let bank_url = optional_url("BANK_URL");
    let v = f
        .blank("TAX_DEPOSIT_BASIS")
        .map(|v| one_of(v, &["market", "customer"]))
        .transpose();
    let tax_deposit_basis = f.field("TAX_DEPOSIT_BASIS", v, None);
    let v = f.blank("DATABASE_URL").map(url_field).transpose();
    let database_url = f.field("DATABASE_URL", v, None);

    // The superRefine runs once every field parsed: a set DATABASE_URL needs the shared schema's DATABASE_POOL_MAX.
    let mut database_pool_max = None;
    if f.issues.is_empty() && database_url.is_some() {
        match f.blank("DATABASE_POOL_MAX") {
            None => f
                .issues
                .push(format!("DATABASE_POOL_MAX: {TAX_DATABASE_POOL_MAX_UNSET}")),
            Some(v) => match coerce_int(v, Some((1, false)), Some(200)) {
                Ok(n) => database_pool_max = Some(n),
                Err(m) => f.issues.push(format!("DATABASE_POOL_MAX: {m}")),
            },
        }
    }

    f.finish()?;
    Ok(TaxEnv {
        node_env: base.node_env,
        app_env: base.app_env,
        log_level: base.log_level,
        service_name: base.service_name,
        launch_drop: base.launch_drop,
        otel_endpoint: otel.endpoint,
        otel_enabled: otel.enabled,
        http_host: http.host,
        http_port: http.port,
        edge_secret: edge.secret,
        edge_public_key: edge.public_key,
        edge_max_lifetime_seconds: edge.max_lifetime_seconds,
        edge_clock_skew_seconds: edge.clock_skew_seconds,
        internal_secret: internal.secret,
        internal_body_bind: internal.body_bind,
        s2s_mode: s2s.mode,
        s2s_keyring: s2s.keyring,
        s2s_signing_kid: s2s.signing_kid,
        s2s_signing_key: s2s.signing_key,
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
}
