//! svc-bank's environment (`services/svc-bank/src/env.ts`): `serviceEnvSchema` (base, postgres, redis, nats, otel,
//! http), `edgeEnvSchema`, `internalServiceEnvSchema` and `s2sEnvSchema` from `@intafaced/config` (the kit's slices,
//! `service_kit::env`), merged with svc-bank's own fields, loaded by `loadEnv` (which first refuses development
//! material in production posture). Same defaults, same refusals, every problem listed at once in the schema's order.
//!
//! The loaded values are kept as the TypeScript's `env` object (`BankEnv::json`, in its key order), which
//! `tests/env_parity.rs` holds to the TypeScript's own answers; the typed accessors read from it.
//!
//! Most owner values (`BANK_*_JSON`, caps, windows, fees) are plain optional strings here, as in `env.ts`: each is read
//! and refused by the module that uses it, which is its slice's.

use std::collections::BTreeMap;

use service_kit::env::{
    EnvError, Fields, REQUIRED_STRING, ServiceName, coerce_int, one_of, url_field,
};
use service_kit::json::Json;
use service_kit::schema::js_trim;

/// The service's default port (`HTTP_PORT`).
pub const DEFAULT_PORT: i64 = 4009;

/// The loaded environment.
#[derive(Debug, Clone, PartialEq)]
pub struct BankEnv {
    /// The TypeScript's `env`, key for key.
    pub json: Json,
    /// The whole process environment, for the jurisdiction guard's switches and lists.
    pub raw: BTreeMap<String, String>,
}

impl BankEnv {
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

    /// An integer value (`None` when unset, or `null`: switched off).
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

/// The words a `*_ENABLED` switch that defaults on reads as off, in any case and untrimmed.
const OFF_WORDS: [&str; 4] = ["0", "false", "off", "no"];
/// The words a switch that defaults off reads as on.
const ON_WORDS: [&str; 4] = ["1", "true", "on", "yes"];

/// The `*_SETTINGS` lists `env.ts` imports, by field, in the schema's order.
const CARD_ISSUER: [&str; 2] = ["none", "card-sim"];
const RAMP: [&str; 2] = ["none", "crypto-ledger"];
const OFF_TEST: [&str; 2] = ["off", "test"];
const ONRAMP_RATES: [&str; 2] = ["none", "ramp-sim"];
const PAYOUT: [&str; 2] = ["none", "payout-sim"];
const PAYROLL: [&str; 2] = ["none", "payroll-sim"];
const ONRAMP: [&str; 2] = ["none", "payin-sim"];
const STEP_UP: [&str; 2] = ["off", "required"];
const BILL_READER: [&str; 2] = ["off", "test-lines"];
const GLOBAL: [&str; 2] = ["none", "global-sim"];
const DD_SCHEME: [&str; 2] = ["none", "dd-sim"];

/// `integerInRange` (`recovery-jobs.ts`) and `optionalInteger` (`statement-jobs.ts`): trimmed ASCII digits whose number
/// is in range.
fn digits_in_range(raw: &str, min: u64, max: u64) -> Option<u64> {
    let t = js_trim(raw);
    if t.is_empty() || !t.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    // Past u64 the number is far past every bound here.
    t.parse::<u64>().ok().filter(|v| (min..=max).contains(v))
}

/// `readStrangerHoldDays`: one to three digits, 1 to 365.
fn stranger_hold_days(raw: &str) -> bool {
    let t = js_trim(raw);
    (1..=3).contains(&t.len())
        && t.bytes().all(|b| b.is_ascii_digit())
        && t.parse::<u16>().is_ok_and(|d| (1..=365).contains(&d))
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

    /// `z.string().url()`, with `default` when unset (`None`: optional). zod writes the value back trimmed, without
    /// its tabs and newlines.
    fn url(&mut self, key: &str, default: Option<&str>) {
        match self.f.get(key) {
            None => {
                if let Some(d) = default {
                    self.set(key, Json::str(d));
                }
            }
            Some(raw) => {
                let v = url_field(raw)
                    .map(|_| Json::String(js_trim(raw).replace(['\t', '\n', '\r'], "")));
                self.checked(key, v);
            }
        }
    }

    /// `z.enum(options).default(default)`.
    fn choice(&mut self, key: &str, options: &[&str], default: &str) {
        let v = self
            .f
            .get(key)
            .map_or(Ok(default.to_owned()), |raw| one_of(raw, options))
            .map(Json::String);
        self.checked(key, v);
    }

    /// `z.union([z.boolean(), z.string()]).default(on).transform(...)`: a switch that defaults on reads off only for
    /// an off word; one that defaults off reads on only for an on word.
    fn switch(&mut self, key: &str, on: bool) {
        let v = self.f.get(key).map_or(on, |raw| {
            let word = raw.to_lowercase();
            if on {
                !OFF_WORDS.contains(&word.as_str())
            } else {
                ON_WORDS.contains(&word.as_str())
            }
        });
        self.set(key, Json::Bool(v));
    }

    /// `z.preprocess(blank as undefined, z.coerce.number().int().min(min).max(max))`: required, a blank one read as
    /// `Number(undefined)` (`NaN`) when `required`, else absent.
    fn batch(&mut self, key: &str, min: i64, max: i64, required: bool) {
        let v = match self.f.blank(key) {
            Some(raw) => coerce_int(raw, Some((min, false)), Some(max)),
            None if required => Err("Invalid input: expected number, received NaN".to_owned()),
            None => return,
        };
        let v = v.map(Json::int).map_err(infinity(self.f.get(key)));
        self.checked(key, v);
    }

    /// `parseRecoveryInterval` and `parseRecoveryBatchLimit`: unset is the default, blank is off (`null`).
    fn recovery(&mut self, key: &str, default: i64, min: u64, max: u64, message: &str) {
        let v = match self.f.get(key) {
            None => Ok(Json::int(default)),
            Some(raw) if js_trim(raw).is_empty() => Ok(Json::Null),
            Some(raw) => digits_in_range(raw, min, max)
                .and_then(|v| i64::try_from(v).ok())
                .map(Json::int)
                .ok_or_else(|| message.to_owned()),
        };
        self.checked(key, v);
    }

    /// `parseStatementJobsInterval` and `parseStatementJobsLease`: unset or blank is off (`null`).
    fn statement_jobs(&mut self, key: &str, min: u64, max: u64) {
        let v = match self.f.blank(key) {
            None => Ok(Json::Null),
            Some(raw) => digits_in_range(raw, min, max)
                .and_then(|v| i64::try_from(v).ok())
                .map(Json::int)
                .ok_or_else(|| {
                    format!("{key} must be an integer {min}–{max}, or empty to leave background exports off")
                }),
        };
        self.checked(key, v);
    }
}

/// zod names an infinite number for what it is (`received Infinity`), where the kit's integer check calls it a number.
fn infinity(raw: Option<&str>) -> impl FnOnce(String) -> String {
    let shown = raw.and_then(service_kit::env::js_number).and_then(|n| {
        if n == f64::INFINITY {
            Some("Infinity")
        } else if n == f64::NEG_INFINITY {
            Some("-Infinity")
        } else {
            None
        }
    });
    move |m| match shown {
        Some(s) => format!("Invalid input: expected number, received {s}"),
        None => m,
    }
}

/// `loadEnv(schema, source)`.
pub fn load(source: &BTreeMap<String, String>) -> Result<BankEnv, EnvError> {
    service_kit::posture::assert_production_posture(source)?;
    let mut f = Fields::new(source);
    // svc-bank's own SERVICE_NAME replaces the base one in its place: any string, default svc-bank.
    let base = service_kit::env::base(&mut f, ServiceName::Own("svc-bank"));
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
    // svc-bank's own HTTP_PORT, in httpEnvSchema's place: any integer, default 4009.
    match f.get("HTTP_PORT") {
        None => early.push(("HTTP_PORT".into(), Json::int(DEFAULT_PORT))),
        Some(raw) => match coerce_int(raw, None, None) {
            Ok(v) => early.push(("HTTP_PORT".into(), Json::int(v))),
            Err(m) => f.issues.push(format!("HTTP_PORT: {m}")),
        },
    }
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
    o.url("LEDGER_URL", Some("http://localhost:4001"));
    o.url("IDENTITY_URL", None);
    o.url("PAY_URL", None);
    o.string("TOKEN_ASSET_ID", "IFC");
    o.switch("SCHEDULED_TRANSFERS_ENABLED", true);
    o.switch("BANK_DD_COLLECTIONS_ENABLED", true);
    o.switch("INTEREST_ACCRUAL_ENABLED", true);
    o.batch("TRANSFER_BATCH_SIZE", 1, 10_000, true);
    o.url("TRADE_URL", Some("http://localhost:4004"));
    match o.f.get("LOAN_QUOTE_ASSET_ID") {
        None => o.issue("LOAN_QUOTE_ASSET_ID", REQUIRED_STRING),
        Some(raw) if js_trim(raw).is_empty() => o.issue(
            "LOAN_QUOTE_ASSET_ID",
            "Too small: expected string to have >=1 characters",
        ),
        Some(raw) => o.set("LOAN_QUOTE_ASSET_ID", Json::str(js_trim(raw))),
    }
    o.switch("LOAN_ACCRUAL_ENABLED", true);
    o.switch("BANK_LOANS_ENABLED", true);
    o.switch("LOAN_RISK_SWEEP_ENABLED", false);
    o.batch("LOAN_SWEEP_BATCH_SIZE", 1, 10_000, true);
    o.choice("BANK_CARD_ISSUER", &CARD_ISSUER, "none");
    o.switch("BANK_CARDS_ENABLED", true);
    o.choice("BANK_RAMP_MODE", &RAMP, "none");
    o.choice("BANK_TEST_PARTNER", &OFF_TEST, "off");
    o.choice("BANK_TAX_EFFECTS", &OFF_TEST, "off");
    // `parseCustodyLayer`: unset or blank is off; on or off in any case, trimmed; anything else refuses.
    let custody = match o.f.get("LEDGER_CUSTODY_LAYER") {
        None => Ok("off".to_owned()),
        Some(raw) => match js_trim(raw).to_lowercase().as_str() {
            "" | "off" => Ok("off".to_owned()),
            "on" => Ok("on".to_owned()),
            _ => Err(format!(
                "LEDGER_CUSTODY_LAYER must be \"on\" or \"off\", got \"{raw}\""
            )),
        },
    };
    o.checked("LEDGER_CUSTODY_LAYER", custody.map(Json::String));
    o.choice("BANK_ONRAMP_RATES", &ONRAMP_RATES, "none");
    o.opt_string("BANK_ONRAMP_SIM_JSON");
    o.choice("BANK_PAYOUT_PARTNER", &PAYOUT, "none");
    o.opt_string("BANK_PAYOUT_SIM_JSON");
    o.opt_string("BANK_PAYOUT_SIM_RECORDS_DIR");
    o.choice("BANK_PAYROLL_PARTNER", &PAYROLL, "none");
    for k in [
        "BANK_PAYROLL_SIM_RECORDS_DIR",
        "BANK_DIRECT_DEPOSIT_REVERSAL_DAYS",
        "BANK_TEST_CASH_LEG_RATES",
        "BANK_TEST_CASH_LEG_VENUE_URL",
        "BANK_TEST_PAY_IN_RPC_URL",
        "BANK_TEST_PAY_IN_CHAIN_ID",
        "BANK_TEST_PAY_IN_TOKEN",
    ] {
        o.opt_string(k);
    }
    o.choice("BANK_ONRAMP_PARTNER", &ONRAMP, "none");
    for k in [
        "BANK_PAYIN_SIM_JSON",
        "BANK_PAYIN_SIM_PAGE_URL",
        "BANK_PAYIN_SIM_RETURN_URL",
        "BANK_PAYIN_SIM_DELIVER_URL",
    ] {
        o.opt_string(k);
    }
    o.choice("BANK_STEP_UP_MONEY_OUT", &STEP_UP, "off");
    o.opt_string("BANK_PERSONAL_SEND_REVIEW_JSON");
    o.opt_string("BANK_REQUEST_REMIND_POLICY_JSON");
    // `readStrangerHoldDays` only checks it: the raw value is kept, blank included.
    if let Some(raw) = o.f.get("BANK_STRANGER_HOLD_DAYS") {
        if js_trim(raw).is_empty() || stranger_hold_days(raw) {
            o.set("BANK_STRANGER_HOLD_DAYS", Json::str(raw));
        } else {
            o.issue(
                "BANK_STRANGER_HOLD_DAYS",
                "BANK_STRANGER_HOLD_DAYS must be a whole number of days from 1 to 365, or blank",
            );
        }
    }
    // `readMarginWarningLevel`: blank until the custodial layer.
    if o.f.blank("BANK_MARGIN_WARNING_LTV_BPS").is_some() {
        o.issue(
            "BANK_MARGIN_WARNING_LTV_BPS",
            "BANK_MARGIN_WARNING_LTV_BPS must stay blank: Home lists a loan nearing its margin call only with the \
             custodial layer (J-home-ia-01 #7, Later)",
        );
    } else {
        o.set("BANK_MARGIN_WARNING_LTV_BPS", Json::Null);
    }
    for k in [
        "BANK_OFFRAMP_COOLING_HOURS",
        "BANK_PAYEE_COOLING_HOURS",
        "BANK_SCHEDULE_EDIT_CUTOFF_MINUTES",
        "BANK_GLOBAL_HOLD_CANCEL_HOURS",
        "BANK_GLOBAL_REFUND_FEE",
        "BANK_LOAN_PAYOFF_FEE",
        "BANK_LOAN_ORIGINATION_FEE_BPS",
        "BANK_LOAN_PAYOFF_WINDOW_MINUTES",
        "BANK_ADDRESS_BOOK_CAP",
        "BANK_DESTINATION_SANCTIONS",
        "BANK_DEPOSIT_ADDRESS_CAP",
        "BANK_DEPOSIT_ADDRESS_EXPIRY_DAYS",
        "BANK_WALLET_PROOF_WINDOW_MINUTES",
        "BANK_ADDRESS_APPROVAL_LINK_MINUTES",
        "BANK_WALLET_PROOF_VALID_DAYS",
        "BANK_ACCOUNT_DETAILS_CURRENCIES",
        "BANK_ELIGIBILITY_JSON",
        "BANK_ACCOUNT_TERMS_JSON",
        "BANK_PLANS_JSON",
        "BANK_DORMANCY_RULES_JSON",
        "BANK_FEE_SCHEDULE_JSON",
        "BANK_CARD_PROGRAMME_JSON",
        "BANK_CARD_CASHBACK_RATES_JSON",
    ] {
        o.opt_string(k);
    }
    o.choice("BANK_CARD_SIM_CASHBACK", &OFF_TEST, "off");
    for k in [
        "BANK_CARD_SIM_PARTNER_JSON",
        "BANK_CARD_SPEND_ASSETS",
        "BANK_CARD_PIN_TRY_LIMIT",
        "BANK_CARD_3DS_TRY_LIMIT",
        "BANK_CARD_DISPUTE_CAP_JSON",
        "BANK_CARDHOLDER_SANCTIONS",
        "BANK_EARN_RISK_WORDING_JSON",
        "BANK_BLOCKED_REGION_NOTICE",
        "BANK_ONBOARDING_REQUIREMENTS_JSON",
        "BANK_INFO_REQUEST_UPLOAD_JSON",
        "BANK_REOPEN_WINDOW_DAYS",
        "BANK_ACCOUNT_CURRENCIES",
        "BANK_SPACE_LIMIT",
        "BANK_SPACE_UNLOCK_WAIT_HOURS",
        "BANK_INCOME_SORTER_MIN_CREDIT",
        "BANK_SHARED_POT_INVITE_MINUTES",
        "BANK_BUSINESS_INVITE_MINUTES",
    ] {
        o.opt_string(k);
    }
    o.choice("BANK_BILL_READER", &BILL_READER, "off");
    o.opt_string("BANK_SHARED_POT_PEOPLE_CAP");
    o.opt_string("BANK_SEND_FIELD_RULES_JSON");
    o.choice("BANK_GLOBAL_PARTNER", &GLOBAL, "none");
    o.opt_string("BANK_GLOBAL_SIM_JSON");
    o.choice("BANK_DD_SCHEME", &DD_SCHEME, "none");
    for k in [
        "BANK_DD_SIM_JSON",
        "BANK_PAYEE_CONTROLS_JSON",
        "BANK_PROOF_LIMITS_JSON",
        "BANK_EXCHANGE_ALLOWANCE_JSON",
    ] {
        o.opt_string(k);
    }
    o.switch("AUTO_INVEST_ENABLED", true);
    o.batch("CONVERT_MARKETS_LIMIT", 1, 500, false);
    o.recovery(
        "BANK_RECOVERY_JOBS_INTERVAL_MS",
        60_000,
        5_000,
        3_600_000,
        "BANK_RECOVERY_JOBS_INTERVAL_MS must be an integer 5000–3600000, or empty to disable",
    );
    o.recovery(
        "BANK_RECOVERY_JOBS_BATCH_LIMIT",
        50,
        1,
        1_000,
        "BANK_RECOVERY_JOBS_BATCH_LIMIT must be an integer 1–1000, or empty to disable",
    );
    o.statement_jobs("BANK_STATEMENT_JOBS_INTERVAL_MS", 500, 3_600_000);
    o.statement_jobs("BANK_STATEMENT_JOBS_LEASE_MS", 1_000, 3_600_000);
    o.opt_string("BANK_STATEMENT_JOBS_TEST_RENDER_HOLD_MS");
    o.opt_string("BANK_ACTIVITY_TEST_FAULT");
    let json = Json::Object(std::mem::take(&mut o.json));
    f.finish()?;
    Ok(BankEnv {
        json,
        raw: source.clone(),
    })
}
