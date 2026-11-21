//! svc-matching's environment (`services/svc-matching/src/env.ts`): `baseEnvSchema`, `redisEnvSchema`,
//! `natsEnvSchema`, `otelEnvSchema`, `httpEnvSchema`, `internalServiceEnvSchema` and `s2sEnvSchema` from
//! `@intafaced/config`, merged with the engine's own fields and loaded by `loadEnv` (which first refuses development
//! material in production posture). There is no `DATABASE_URL`: the engine keeps its books in memory and its journal
//! in a file. Same defaults, same refusals, every problem of the schema listed at once in its order; then the boot
//! guard that keeps our own order book off while the custodial layer is off (`resolveOwnOrderBook`).
//!
//! The loaded values are kept as the TypeScript's `env` object (`MatchingEnv::json`, in its key order), which
//! `tests/env_parity.rs` holds to the TypeScript's own answers.

use std::collections::BTreeMap;

use service_kit::env::{EnvError, Fields, ServiceName, coerce_int, min_len};
use service_kit::json::Json;
use service_kit::schema::js_trim;

/// The engine's port (`HTTP_PORT`'s default).
pub const DEFAULT_PORT: i64 = 4004;

/// `MATCHING_JOURNAL_PATH`'s default.
pub const DEFAULT_JOURNAL_PATH: &str = "./.data/matching/engine_journal.ndjson";

/// The loaded environment.
#[derive(Debug, Clone, PartialEq)]
pub struct MatchingEnv {
    /// The TypeScript's `env`, key for key.
    pub json: Json,
}

impl MatchingEnv {
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

    /// `MATCHING_OPERATOR_IDS` as `parseOperatorIds` reads it.
    pub fn operator_ids(&self) -> Vec<String> {
        parse_operator_ids(self.str("MATCHING_OPERATOR_IDS"))
    }
}

/// `parseOperatorIds`: comma-separated, each trimmed and lower-cased, blanks dropped, each id once.
pub fn parse_operator_ids(raw: Option<&str>) -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();
    for id in raw.unwrap_or("").split(',') {
        let id = js_trim(id).to_lowercase();
        if !id.is_empty() && !ids.contains(&id) {
            ids.push(id);
        }
    }
    ids
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

/// `resolveOwnOrderBook` (`@intafaced/ledger-client`): unset follows the custody switch; on with custody off refuses.
pub fn resolve_own_order_book(
    flag: &str,
    asked: Option<bool>,
    custody: &str,
) -> Result<bool, String> {
    match asked {
        None => Ok(custody == "on"),
        Some(true) if custody == "off" => Err(format!(
            "{flag} is on but LEDGER_CUSTODY_LAYER is off: our own order book settles every fill in our ledger as customer \
             money, which INTAFACED does not hold with the custodial layer off. Leave the switch unset or set it off, or turn \
             the custodial layer on (the TEST journeys marked Later: custody)."
        )),
        Some(on) => Ok(on),
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

/// `z.preprocess(v => blank ? undefined : v.trim(), ...)`: the trimmed value, or none when blank or unset.
fn trimmed<'a>(f: &Fields<'a>, key: &str) -> Option<&'a str> {
    f.get(key).map(js_trim).filter(|v| !v.is_empty())
}

const OPERATOR_IDS_MESSAGE: &str = "FATAL: MATCHING_OPERATOR_IDS must list at least two distinct operator user ids (comma-separated). \
     svc-matching refuses to boot without them: with no operators nobody could halt or open a market.";

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

    /// An optional field: set only when present and valid.
    fn optional<T>(
        &mut self,
        key: &str,
        v: Option<Result<T, String>>,
        json: impl FnOnce(T) -> Json,
    ) {
        if let Some(v) = v {
            self.verdict(key, v, json);
        }
    }
}

/// `loadEnv(schema, source)`, as `env.ts` composes the schema.
pub fn load(source: &BTreeMap<String, String>) -> Result<MatchingEnv, EnvError> {
    service_kit::posture::assert_production_posture(source)?;
    let mut f = Fields::new(source);
    // The engine's own SERVICE_NAME replaces the base one in its place: any string, default svc-matching.
    let base = service_kit::env::base(&mut f, ServiceName::Own("svc-matching"));
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
    // The engine's own HTTP_PORT, in httpEnvSchema's place: any integer, default 4004.
    let port =
        o.f.get("HTTP_PORT")
            .map_or(Ok(DEFAULT_PORT), |v| coerce_int(v, None, None));
    o.verdict("HTTP_PORT", port, Json::int);
    let internal = service_kit::env::internal_service(o.f);
    o.set("INTERNAL_SERVICE_SECRET", Json::str(internal.secret));
    o.set("INTERNAL_SERVICE_BODY_BIND", Json::str(internal.body_bind));
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

    // The engine's own fields.
    let journal =
        o.f.get("MATCHING_JOURNAL_PATH")
            .map_or(Ok(DEFAULT_JOURNAL_PATH.to_owned()), |v| min_len(v, 1));
    o.verdict("MATCHING_JOURNAL_PATH", journal, Json::String);
    // Blank is undefined, and `Number(undefined)` is NaN: the cadence has no default.
    let every = coerce_int(
        o.f.blank("MATCHING_SNAPSHOT_EVERY").unwrap_or("NaN"),
        Some((0, false)),
        None,
    );
    o.verdict("MATCHING_SNAPSHOT_EVERY", every, Json::int);
    let asked = o
        .f
        .get("MATCHING_ENGINE_ENABLED")
        .map(|v| !["", "0", "false", "off", "no"].contains(&js_trim(v).to_lowercase().as_str()));
    let custody = parse_custody_layer(o.f.get("LEDGER_CUSTODY_LAYER"));
    // The engine switch's place in the object; its value is the boot guard's, set below.
    let engine_at = o.json.len();
    o.verdict("LEDGER_CUSTODY_LAYER", custody.clone(), Json::str);
    let identity = o.f.get("IDENTITY_URL").map(url_value);
    o.optional("IDENTITY_URL", identity, Json::String);
    let ledger = trimmed(o.f, "LEDGER_URL").map(url_value);
    o.optional("LEDGER_URL", ledger, Json::String);
    let edge_secret = trimmed(o.f, "EDGE_PRINCIPAL_SECRET").map(|v| min_len(v, 32));
    o.optional("EDGE_PRINCIPAL_SECRET", edge_secret, Json::String);
    let key = o.f.get("EDGE_PRINCIPAL_PUBLIC_KEY").map(|v| {
        let ok = v.len() == 43
            && v.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
        if ok {
            Ok(v.to_owned())
        } else {
            Err("must be a raw 32-byte Ed25519 public key, base64url".to_owned())
        }
    });
    o.optional("EDGE_PRINCIPAL_PUBLIC_KEY", key, Json::String);
    let lifetime =
        o.f.get("EDGE_PRINCIPAL_MAX_LIFETIME_SECONDS")
            .map(|v| coerce_int(v, Some((1, false)), Some(300)));
    o.optional("EDGE_PRINCIPAL_MAX_LIFETIME_SECONDS", lifetime, Json::int);
    let skew =
        o.f.get("EDGE_PRINCIPAL_CLOCK_SKEW_SECONDS")
            .map(|v| coerce_int(v, Some((1, false)), Some(60)));
    o.optional("EDGE_PRINCIPAL_CLOCK_SKEW_SECONDS", skew, Json::int);
    let operators = o.f.get("MATCHING_OPERATOR_IDS").unwrap_or("").to_owned();
    if parse_operator_ids(Some(&operators)).len() < 2 {
        o.issue("MATCHING_OPERATOR_IDS", OPERATOR_IDS_MESSAGE);
    }
    o.set("MATCHING_OPERATOR_IDS", Json::String(operators));

    // The boot guard runs only on an environment that parsed: our own order book never runs with the custodial layer off.
    if o.f.issues.is_empty()
        && let Ok(custody) = custody
    {
        match resolve_own_order_book("MATCHING_ENGINE_ENABLED", asked, custody) {
            // Set, the switch keeps its place in the object; unset, the guard's spread adds it last.
            Ok(enabled) => o.json.insert(
                if asked.is_some() {
                    engine_at
                } else {
                    o.json.len()
                },
                ("MATCHING_ENGINE_ENABLED".to_owned(), Json::Bool(enabled)),
            ),
            Err(refusal) => o.issue("MATCHING_ENGINE_ENABLED", &refusal),
        }
    }
    let json = Json::Object(std::mem::take(&mut o.json));
    f.finish()?;
    Ok(MatchingEnv { json })
}
