//! The owner's and the TEST partner's card values, read once at boot (`index.ts`): the card programme terms
//! (`card-programme.ts`), the cashback rates by rank card tier, the TEST partner card adapter's switches
//! (`partner-terms.ts`), the assets a card may pay from and the two try counts. Every one is an owner value with no
//! default: blank stays `None` and refuses where it is read.

use service_kit::json::{self, Json};
use service_kit::money::{Amount, parse_amount};
use service_kit::time::{Instant, js_date};

/// `CARD_CUSTODY_MODES`.
pub const CUSTODY_MODES: [&str; 2] = ["partner_holds", "wallet_pull"];
/// `LOSS_BEARERS`.
pub const LOSS_BEARERS: [&str; 3] = ["partner", "programme", "cardholder"];
/// `DELIVERY_SPEEDS`.
pub const DELIVERY_SPEEDS: [&str; 3] = ["standard", "express", "signed"];
/// `CARD_TIERS`.
pub const CARD_TIERS: [&str; 4] = ["none", "standard", "metal", "obsidian"];
/// `CARD_SIM_FIGURES_STALE_AFTER_MS`.
pub const SIM_FIGURES_STALE_AFTER_MS: i64 = 60_000;

/// `reserve`: none required, or required with an amount in an asset.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Reserve {
    NotRequired,
    Required { amount: String, asset_id: String },
}

/// `fundingOffers`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FundingOffers {
    pub fund: bool,
    pub defund: bool,
    pub auto_reload: bool,
}

/// `disputeRules`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DisputeRules {
    pub window_days: i64,
    pub evidence_after_submission: bool,
}

/// `rates`: one unit of each asset in `in_asset`, as decimal strings above zero.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PartnerRates {
    pub in_asset: String,
    pub per_unit: Vec<(String, String)>,
}

/// `figuresAsOf`: the partner's own clock at each read, a fixed time, or none sent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FiguresAsOf {
    Now,
    At(String),
}

/// `CardPartnerTerms`: what the card partner reports about its unknowns. Every `None` is "not known".
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PartnerTerms {
    pub test: bool,
    pub custody_mode: Option<String>,
    pub spend_from: Option<Vec<String>>,
    /// `(bearer, terms)`.
    pub loss_liability: Option<(String, String)>,
    pub reserve: Option<Reserve>,
    pub funder: Option<String>,
    /// Per asset, in the order the switches gave them.
    pub balances: Option<Vec<(String, String)>>,
    /// Per asset: `(held, captured)`.
    pub programme_figures: Option<Vec<(String, (String, String))>>,
    pub figures_as_of: Option<FiguresAsOf>,
    pub figures_stale_after_ms: i64,
    pub funding_asset_id: Option<String>,
    pub funding_offers: Option<FundingOffers>,
    /// `secrets: "test"`.
    pub test_secrets: bool,
    pub dispute_rules: Option<DisputeRules>,
    pub rates: Option<PartnerRates>,
}

impl PartnerTerms {
    /// `NOTHING_REPORTED`.
    pub fn nothing_reported() -> PartnerTerms {
        PartnerTerms {
            test: true,
            custody_mode: None,
            spend_from: None,
            loss_liability: None,
            reserve: None,
            funder: None,
            balances: None,
            programme_figures: None,
            figures_as_of: None,
            figures_stale_after_ms: SIM_FIGURES_STALE_AFTER_MS,
            funding_asset_id: None,
            funding_offers: None,
            test_secrets: false,
            dispute_rules: None,
            rates: None,
        }
    }

    /// `partnerFiguresAsOf`: the partner's own time for its figures, read at `now`, or none.
    pub fn figures_as_of_at(&self, now: Instant) -> Option<Instant> {
        match &self.figures_as_of {
            None => None,
            Some(FiguresAsOf::Now) => Some(now),
            Some(FiguresAsOf::At(t)) => js_date(t),
        }
    }

    /// The partner's reported balance for one asset, if it reports one.
    pub fn balance(&self, asset_id: &str) -> Option<&str> {
        self.balances
            .as_ref()?
            .iter()
            .find(|(a, _)| a == asset_id)
            .map(|(_, v)| v.as_str())
    }
}

/// `assetId`: `^[A-Z0-9]{2,16}$`.
pub fn is_asset_id(s: &str) -> bool {
    (2..=16).contains(&s.len())
        && s.bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
}

/// `^\d+(\.\d{1,18})?$`.
pub fn is_decimal(s: &str) -> bool {
    let (whole, frac) = s.split_once('.').map_or((s, None), |(w, f)| (w, Some(f)));
    !whole.is_empty()
        && whole.bytes().all(|b| b.is_ascii_digit())
        && frac.is_none_or(|f| (1..=18).contains(&f.len()) && f.bytes().all(|b| b.is_ascii_digit()))
}

fn above_zero(s: &str) -> bool {
    s.bytes().any(|b| (b'1'..=b'9').contains(&b))
}

/// `isExplicitDevOrTest(APP_ENV)` and not `NODE_ENV=production`.
pub fn dev_or_test(app_env: Option<&str>, node_env: Option<&str>) -> bool {
    matches!(app_env, Some("dev" | "test")) && node_env != Some("production")
}

fn obj(v: &Json) -> Option<&[(String, Json)]> {
    match v {
        Json::Object(f) => Some(f),
        _ => None,
    }
}

fn strict(fields: &[(String, Json)], known: &[&str]) -> Result<(), String> {
    match fields.iter().find(|(k, _)| !known.contains(&k.as_str())) {
        Some((k, _)) => Err(format!("unrecognized key {k}")),
        None => Ok(()),
    }
}

/// A required key, present as a value or as null: `Ok(None)` for null.
fn nullable<'a>(v: &'a Json, key: &str) -> Result<Option<&'a Json>, String> {
    match v.get(key) {
        None => Err(format!("{key}: Required")),
        Some(Json::Null) => Ok(None),
        Some(x) => Ok(Some(x)),
    }
}

/// An optional key: absent or null is `None`.
fn optional<'a>(v: &'a Json, key: &str) -> Option<&'a Json> {
    match v.get(key) {
        None | Some(Json::Null) => None,
        Some(x) => Some(x),
    }
}

fn string_of<'a>(v: &'a Json, key: &str) -> Result<&'a str, String> {
    match v {
        Json::String(s) => Ok(s),
        _ => Err(format!("{key}: Expected string")),
    }
}

fn trimmed(v: &Json, key: &str, max: usize) -> Result<String, String> {
    let s = service_kit::money::js_trim(string_of(v, key)?);
    if s.is_empty() || s.chars().count() > max {
        return Err(format!("{key}: length"));
    }
    Ok(s.to_owned())
}

fn asset(v: &Json, key: &str) -> Result<String, String> {
    let s = string_of(v, key)?;
    if is_asset_id(s) {
        Ok(s.to_owned())
    } else {
        Err(format!("{key}: Invalid"))
    }
}

fn bool_at(v: &Json, key: &str) -> Result<bool, String> {
    match v.get(key) {
        Some(Json::Bool(b)) => Ok(*b),
        _ => Err(format!("{key}: Expected boolean")),
    }
}

fn int_in(v: &Json, key: &str, lo: i64, hi: i64) -> Result<i64, String> {
    match v {
        Json::Number(n) if n.fract() == 0.0 && *n >= lo as f64 && *n <= hi as f64 =>
        {
            #[allow(
                clippy::cast_possible_truncation,
                reason = "checked whole and in range"
            )]
            Ok(*n as i64)
        }
        _ => Err(format!("{key}: Invalid")),
    }
}

fn decimal_record(v: &Json, key: &str, positive: bool) -> Result<Vec<(String, String)>, String> {
    let fields = obj(v).ok_or_else(|| format!("{key}: Expected object"))?;
    if fields.len() > 50 {
        return Err(format!("{key}: at most 50 assets"));
    }
    fields
        .iter()
        .map(|(k, x)| {
            if !is_asset_id(k) {
                return Err(format!("{key}.{k}: Invalid key"));
            }
            let s = string_of(x, key)?;
            if !is_decimal(s) || (positive && !above_zero(s)) {
                return Err(format!("{key}.{k}: Invalid"));
            }
            Ok((k.clone(), s.to_owned()))
        })
        .collect()
}

const SIM_PARTNER_ENV: &str = "BANK_CARD_SIM_PARTNER_JSON";

/// `cardSimPartnerFor`: the TEST partner card adapter's switches. Blank is nothing reported; set outside dev or test,
/// or malformed, refuses to start naming the variable.
pub fn sim_partner_for(
    raw: Option<&str>,
    app_env: Option<&str>,
    node_env: Option<&str>,
) -> Result<PartnerTerms, String> {
    let Some(raw) = raw.filter(|r| !service_kit::money::js_trim(r).is_empty()) else {
        return Ok(PartnerTerms::nothing_reported());
    };
    if !dev_or_test(app_env, node_env) {
        return Err(format!(
            "{SIM_PARTNER_ENV} is the TEST partner card adapter's switches and refuses to start outside APP_ENV=dev or test, or under NODE_ENV=production"
        ));
    }
    let v = json::parse(raw).map_err(|_| format!("{SIM_PARTNER_ENV} is not JSON"))?;
    sim_partner(&v).map_err(|e| format!("{SIM_PARTNER_ENV} is not in shape: {e}"))
}

fn sim_partner(v: &Json) -> Result<PartnerTerms, String> {
    let fields = obj(v).ok_or("Expected object")?;
    strict(
        fields,
        &[
            "custodyMode",
            "spendFrom",
            "lossLiability",
            "reserve",
            "funder",
            "balances",
            "programmeFigures",
            "figuresAsOf",
            "fundingAssetId",
            "fundingOffers",
            "secrets",
            "disputeRules",
            "rates",
        ],
    )?;
    let custody_mode = nullable(v, "custodyMode")?
        .map(|x| {
            let s = string_of(x, "custodyMode")?;
            if CUSTODY_MODES.contains(&s) {
                Ok(s.to_owned())
            } else {
                Err("custodyMode: Invalid enum value".to_owned())
            }
        })
        .transpose()?;
    let spend_from = nullable(v, "spendFrom")?
        .map(|x| {
            let Json::Array(items) = x else {
                return Err("spendFrom: Expected array".to_owned());
            };
            if items.is_empty() || items.len() > 50 {
                return Err("spendFrom: length".to_owned());
            }
            let list = items
                .iter()
                .map(|i| asset(i, "spendFrom"))
                .collect::<Result<Vec<_>, _>>()?;
            let mut seen = list.clone();
            seen.sort();
            seen.dedup();
            if seen.len() != list.len() {
                return Err("lists an asset twice in spendFrom".to_owned());
            }
            Ok(list)
        })
        .transpose()?;
    let loss_liability = nullable(v, "lossLiability")?
        .map(|x| {
            let f = obj(x).ok_or("lossLiability: Expected object")?;
            strict(f, &["bearer", "terms"])?;
            let bearer = string_of(x.get("bearer").unwrap_or(&Json::Null), "bearer")?;
            if !LOSS_BEARERS.contains(&bearer) {
                return Err("lossLiability.bearer: Invalid enum value".to_owned());
            }
            Ok((
                bearer.to_owned(),
                trimmed(x.get("terms").unwrap_or(&Json::Null), "terms", 500)?,
            ))
        })
        .transpose()?;
    let reserve = nullable(v, "reserve")?
        .map(|x| {
            let f = obj(x).ok_or("reserve: Expected object")?;
            match x.get("required") {
                Some(Json::Bool(false)) => {
                    strict(f, &["required"])?;
                    Ok(Reserve::NotRequired)
                }
                Some(Json::Bool(true)) => {
                    strict(f, &["required", "amount", "assetId"])?;
                    let amount = string_of(x.get("amount").unwrap_or(&Json::Null), "amount")?;
                    if !is_decimal(amount) || !above_zero(amount) {
                        return Err("reserve.amount: Invalid".to_owned());
                    }
                    Ok(Reserve::Required {
                        amount: amount.to_owned(),
                        asset_id: asset(x.get("assetId").unwrap_or(&Json::Null), "assetId")?,
                    })
                }
                _ => Err("reserve: Invalid input".to_owned()),
            }
        })
        .transpose()?;
    let funder = nullable(v, "funder")?
        .map(|x| trimmed(x, "funder", 200))
        .transpose()?;
    let balances = nullable(v, "balances")?
        .map(|x| decimal_record(x, "balances", false))
        .transpose()?;
    let programme_figures = nullable(v, "programmeFigures")?
        .map(|x| {
            let f = obj(x).ok_or("programmeFigures: Expected object")?;
            if f.len() > 50 {
                return Err("programmeFigures: at most 50 assets".to_owned());
            }
            f.iter()
                .map(|(k, e)| {
                    if !is_asset_id(k) {
                        return Err(format!("programmeFigures.{k}: Invalid key"));
                    }
                    let ef = obj(e).ok_or("programmeFigures: Expected object")?;
                    strict(ef, &["held", "captured"])?;
                    let d = |key: &str| -> Result<String, String> {
                        let s = string_of(e.get(key).unwrap_or(&Json::Null), key)?;
                        if is_decimal(s) {
                            Ok(s.to_owned())
                        } else {
                            Err(format!("programmeFigures.{k}.{key}: Invalid"))
                        }
                    };
                    Ok((k.clone(), (d("held")?, d("captured")?)))
                })
                .collect::<Result<Vec<_>, _>>()
        })
        .transpose()?;
    let figures_as_of = nullable(v, "figuresAsOf")?
        .map(|x| {
            let s = string_of(x, "figuresAsOf")?;
            if s == "now" {
                Ok(FiguresAsOf::Now)
            } else if service_kit::zod::Ctx::new().datetime(s, &[]).is_some() {
                Ok(FiguresAsOf::At(s.to_owned()))
            } else {
                Err("figuresAsOf: Invalid".to_owned())
            }
        })
        .transpose()?;
    let funding_asset_id = nullable(v, "fundingAssetId")?
        .map(|x| asset(x, "fundingAssetId"))
        .transpose()?;
    let funding_offers = nullable(v, "fundingOffers")?
        .map(|x| {
            let f = obj(x).ok_or("fundingOffers: Expected object")?;
            strict(f, &["fund", "defund", "autoReload"])?;
            Ok::<_, String>(FundingOffers {
                fund: bool_at(x, "fund")?,
                defund: bool_at(x, "defund")?,
                auto_reload: bool_at(x, "autoReload")?,
            })
        })
        .transpose()?;
    let test_secrets = match v.get("secrets") {
        None => false,
        Some(Json::String(s)) if s == "test" => true,
        Some(_) => return Err("secrets: Invalid literal value, expected \"test\"".to_owned()),
    };
    let dispute_rules = optional(v, "disputeRules")
        .map(|x| {
            let f = obj(x).ok_or("disputeRules: Expected object")?;
            strict(f, &["windowDays", "evidenceAfterSubmission"])?;
            Ok::<_, String>(DisputeRules {
                window_days: int_in(
                    x.get("windowDays").unwrap_or(&Json::Null),
                    "windowDays",
                    1,
                    540,
                )?,
                evidence_after_submission: bool_at(x, "evidenceAfterSubmission")?,
            })
        })
        .transpose()?;
    let rates = optional(v, "rates")
        .map(|x| {
            let f = obj(x).ok_or("rates: Expected object")?;
            strict(f, &["in", "perUnit"])?;
            Ok::<_, String>(PartnerRates {
                in_asset: asset(x.get("in").unwrap_or(&Json::Null), "in")?,
                per_unit: decimal_record(x.get("perUnit").unwrap_or(&Json::Null), "perUnit", true)?,
            })
        })
        .transpose()?;
    Ok(PartnerTerms {
        test: true,
        custody_mode,
        spend_from,
        loss_liability,
        reserve,
        funder,
        balances,
        programme_figures,
        figures_as_of,
        figures_stale_after_ms: SIM_FIGURES_STALE_AFTER_MS,
        funding_asset_id,
        funding_offers,
        test_secrets,
        dispute_rules,
        rates,
    })
}

/// One design (`designs[]`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Design {
    pub id: String,
    pub name: String,
}

/// `CardProgrammeTerms` (`BANK_CARD_PROGRAMME_JSON`): eligibility, count limits, terms, designs, speeds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProgrammeTerms {
    pub network: String,
    /// Upper-cased, as zod's transform returns them.
    pub countries: Vec<String>,
    pub limit_virtual: i64,
    pub limit_physical: i64,
    pub terms_version: String,
    pub terms_text: String,
    pub designs: Vec<Design>,
    /// `(speed, days)`.
    pub speeds: Vec<(String, i64)>,
    pub delivery_countries: Vec<String>,
}

impl ProgrammeTerms {
    /// `limits[cardType]`.
    pub fn limit(&self, card_type: &str) -> i64 {
        if card_type == "physical" {
            self.limit_physical
        } else {
            self.limit_virtual
        }
    }
}

fn countries(v: Option<&Json>, key: &str) -> Option<Vec<String>> {
    let Some(Json::Array(items)) = v else {
        return None;
    };
    if items.is_empty() || items.len() > 250 {
        return None;
    }
    items
        .iter()
        .map(|i| match i {
            Json::String(s) if s.len() == 2 && s.bytes().all(|b| b.is_ascii_alphabetic()) => {
                Some(s.to_ascii_uppercase())
            }
            _ => None,
        })
        .collect::<Option<Vec<_>>>()
        .filter(|_| !key.is_empty())
}

/// `parseCardProgramme`: the published terms, or `None` for blank, unreadable or out of shape.
pub fn parse_programme(raw: Option<&str>) -> Option<ProgrammeTerms> {
    let raw = raw.filter(|r| !service_kit::money::js_trim(r).is_empty())?;
    let v = json::parse(raw).ok()?;
    let f = obj(&v)?;
    strict(
        f,
        &[
            "network",
            "countries",
            "limits",
            "terms",
            "designs",
            "speeds",
            "deliveryCountries",
        ],
    )
    .ok()?;
    let network = trimmed(v.get("network")?, "network", 80).ok()?;
    let countries_list = countries(v.get("countries"), "countries")?;
    let limits = v.get("limits")?;
    strict(obj(limits)?, &["virtual", "physical"]).ok()?;
    let limit_virtual = int_in(limits.get("virtual")?, "virtual", 0, 1000).ok()?;
    let limit_physical = int_in(limits.get("physical")?, "physical", 0, 1000).ok()?;
    let terms = v.get("terms")?;
    strict(obj(terms)?, &["version", "text"]).ok()?;
    let terms_version = trimmed(terms.get("version")?, "version", 64).ok()?;
    let terms_text = trimmed(terms.get("text")?, "text", 20_000).ok()?;
    let Json::Array(ds) = v.get("designs")? else {
        return None;
    };
    if ds.is_empty() || ds.len() > 20 {
        return None;
    }
    let designs = ds
        .iter()
        .map(|d| {
            strict(obj(d)?, &["id", "name"]).ok()?;
            let id = string_of(d.get("id")?, "id").ok()?;
            let ok = (1..=32).contains(&id.len())
                && id
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
            ok.then_some(())?;
            Some(Design {
                id: id.to_owned(),
                name: trimmed(d.get("name")?, "name", 80).ok()?,
            })
        })
        .collect::<Option<Vec<_>>>()?;
    let Json::Array(ss) = v.get("speeds")? else {
        return None;
    };
    if ss.is_empty() || ss.len() > DELIVERY_SPEEDS.len() {
        return None;
    }
    let speeds = ss
        .iter()
        .map(|s| {
            strict(obj(s)?, &["speed", "days"]).ok()?;
            let speed = string_of(s.get("speed")?, "speed").ok()?;
            DELIVERY_SPEEDS.contains(&speed).then_some(())?;
            Some((
                speed.to_owned(),
                int_in(s.get("days")?, "days", 1, 90).ok()?,
            ))
        })
        .collect::<Option<Vec<_>>>()?;
    let delivery_countries = countries(v.get("deliveryCountries"), "deliveryCountries")?;
    let mut ids: Vec<&str> = designs.iter().map(|d| d.id.as_str()).collect();
    ids.sort_unstable();
    ids.dedup();
    let mut sp: Vec<&str> = speeds.iter().map(|(s, _)| s.as_str()).collect();
    sp.sort_unstable();
    sp.dedup();
    if ids.len() != designs.len() || sp.len() != speeds.len() {
        return None;
    }
    Some(ProgrammeTerms {
        network,
        countries: countries_list,
        limit_virtual,
        limit_physical,
        terms_version,
        terms_text,
        designs,
        speeds,
        delivery_countries,
    })
}

/// `CashbackRates`: the asset cashback is paid in and the rate per tier that has one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CashbackRates {
    pub asset_id: String,
    /// `(tier, bps)`, in the order published.
    pub rates: Vec<(String, i64)>,
}

impl CashbackRates {
    pub fn rate(&self, tier: &str) -> Option<i64> {
        self.rates.iter().find(|(t, _)| t == tier).map(|(_, b)| *b)
    }
}

/// `parseCashbackRates`.
pub fn parse_cashback_rates(raw: Option<&str>) -> Option<CashbackRates> {
    let raw = raw.filter(|r| !service_kit::money::js_trim(r).is_empty())?;
    let v = json::parse(raw).ok()?;
    strict(obj(&v)?, &["assetId", "rates"]).ok()?;
    let asset_id = asset(v.get("assetId")?, "assetId").ok()?;
    let rf = obj(v.get("rates")?)?;
    let rates = rf
        .iter()
        .map(|(k, x)| {
            CARD_TIERS.contains(&k.as_str()).then_some(())?;
            Some((k.clone(), int_in(x, k, 0, 10_000).ok()?))
        })
        .collect::<Option<Vec<_>>>()?;
    if rates.is_empty() {
        return None;
    }
    Some(CashbackRates { asset_id, rates })
}

/// `cardSimCashbackFor`: `test` lets the simulator pay cashback, on a dev or test stack only.
pub fn sim_cashback_for(
    setting: Option<&str>,
    app_env: Option<&str>,
    node_env: Option<&str>,
) -> Result<bool, String> {
    if setting.unwrap_or("off") != "test" {
        return Ok(false);
    }
    if !dev_or_test(app_env, node_env) {
        return Err("BANK_CARD_SIM_CASHBACK=test is the local test stack\u{2019}s stand-in and refuses to start outside APP_ENV=dev or test, or under NODE_ENV=production".to_owned());
    }
    Ok(true)
}

/// `parseSpendAssets`: a comma list of asset ids, each trimmed, none twice; blank or malformed is `None`. JavaScript's
/// `trim` is `js_trim`.
pub fn parse_spend_assets(raw: Option<&str>) -> Option<Vec<String>> {
    let raw = raw?;
    if service_kit::money::js_trim(raw).is_empty() {
        return None;
    }
    let ids: Vec<String> = raw
        .split(',')
        .map(|s| service_kit::money::js_trim(s).to_owned())
        .collect();
    let mut seen = ids.clone();
    seen.sort();
    seen.dedup();
    if ids.iter().any(|i| !is_asset_id(i)) || seen.len() != ids.len() {
        return None;
    }
    Some(ids)
}

/// `parsePinTryLimit` (and `parseThreeDSTryLimit`): `^\s*\d{1,2}\s*$`, a whole count from 1 to 10, else `None`.
pub fn parse_try_limit(raw: Option<&str>) -> Option<i64> {
    let t = service_kit::money::js_trim(raw?);
    if t.is_empty() || t.len() > 2 || !t.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let n: i64 = t.parse().ok()?;
    (1..=10).contains(&n).then_some(n)
}

/// A decimal string as an amount, for a partner figure already held to `is_decimal`.
pub fn amount(s: &str) -> Result<Amount, String> {
    parse_amount(s)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test")]
    use super::*;

    #[test]
    fn blank_partner_switches_report_nothing_and_any_switch_outside_dev_or_test_refuses_to_start() {
        assert_eq!(
            sim_partner_for(None, Some("prod"), None).unwrap(),
            PartnerTerms::nothing_reported()
        );
        assert!(sim_partner_for(Some("{}"), Some("staging"), None).is_err());
        assert!(sim_partner_for(Some("{}"), Some("test"), Some("production")).is_err());
        // Every key must be present, as a value or null.
        assert!(sim_partner_for(Some("{}"), Some("test"), None).is_err());
    }

    #[test]
    fn a_full_set_of_partner_switches_reads_back_with_secrets_and_rates() {
        let raw = r#"{"custodyMode":"partner_holds","spendFrom":["USDC","BTC"],"lossLiability":null,"reserve":{"required":false},"funder":null,"balances":{"USDC":"10"},"programmeFigures":null,"figuresAsOf":"now","fundingAssetId":null,"fundingOffers":null,"secrets":"test","rates":{"in":"USDC","perUnit":{"BTC":"60000"}}}"#;
        let t = sim_partner_for(Some(raw), Some("test"), None).unwrap();
        assert!(t.test_secrets);
        assert_eq!(t.balance("USDC"), Some("10"));
        assert_eq!(t.reserve, Some(Reserve::NotRequired));
        assert_eq!(
            t.rates.unwrap().per_unit,
            vec![("BTC".to_owned(), "60000".to_owned())]
        );
        assert!(
            sim_partner_for(
                Some(&raw.replace("\"BTC\"]", "\"USDC\"]")),
                Some("test"),
                None
            )
            .is_err()
        );
    }

    #[test]
    fn programme_terms_need_every_field_in_shape_and_no_design_or_speed_twice() {
        let raw = r#"{"network":"TEST net","countries":["gb","DE"],"limits":{"virtual":3,"physical":1},"terms":{"version":"v1","text":"TEST terms"},"designs":[{"id":"black","name":"Black"}],"speeds":[{"speed":"standard","days":5}],"deliveryCountries":["GB"]}"#;
        let t = parse_programme(Some(raw)).unwrap();
        assert_eq!(t.countries, vec!["GB", "DE"]);
        assert_eq!(t.limit("physical"), 1);
        assert!(
            parse_programme(Some(&raw.replace(
                "\"black\",\"name\":\"Black\"}]",
                "\"black\",\"name\":\"Black\"},{\"id\":\"black\",\"name\":\"B\"}]"
            )))
            .is_none()
        );
        assert!(parse_programme(Some("")).is_none());
        assert!(parse_programme(Some("{")).is_none());
    }

    #[test]
    fn cashback_rates_need_a_tier_and_a_known_one() {
        assert_eq!(
            parse_cashback_rates(Some(r#"{"assetId":"IFC","rates":{"metal":100}}"#))
                .unwrap()
                .rate("metal"),
            Some(100)
        );
        assert!(parse_cashback_rates(Some(r#"{"assetId":"IFC","rates":{}}"#)).is_none());
        assert!(parse_cashback_rates(Some(r#"{"assetId":"IFC","rates":{"gold":1}}"#)).is_none());
    }
}
