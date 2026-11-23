//! THE GLOBAL-SEND STAND-IN, AND IT IS A TEST FIXTURE (`personal-pay/global-sim.ts`).
//!
//! `BANK_GLOBAL_PARTNER` picks who answers a global send. `none` (the default) leaves every port unset, so each send
//! refuses by name and nothing posts. `global-sim` answers from a catalogue someone typed (`BANK_GLOBAL_SIM_JSON`,
//! labelled TEST), calls no network, holds no credentials and pays nobody; it runs only in a process whose raw `APP_ENV`
//! is exactly `dev` or `test` and whose `NODE_ENV` is not `production`, and over a readable catalogue, or the service
//! refuses to start. Its numbers come only from the catalogue; a pair's TEST fee is taken from what arrives, never from
//! the sender's balance. A send of an asset at or over its TEST `reviewFrom` amount is screened (put on hold before
//! anything posts).

use std::collections::BTreeMap;
use std::sync::Mutex;

use service_kit::json::{self, Json};
use service_kit::money::{Rounding, format_amount, js_trim, mul_rounded, parse_amount};
use service_kit::time::Instant;

use super::ports::{
    BicHit, Corridor, FxQuote, GlobalPorts, Live, Payout, PayoutAnswer, SWIFT_CHARGES,
    StandInPayout, TravelRuleDecision,
};
use super::rules::{compact_upper, is_decimal};

/// `GLOBAL_SIM_RAIL`: the ledger rail boundary the stand-in's postings land on. Never a partner's name.
pub const GLOBAL_SIM_RAIL: &str = "global-sim";

/// One corridor of the catalogue, with its TEST payout switch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SimCorridor {
    pub corridor: Corridor,
    /// `payout: false` lists and quotes the corridor but gives it no payout.
    pub payout: Option<bool>,
}

/// One rate line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SimRate {
    pub asset: String,
    pub to_currency: String,
    pub rate: String,
    pub valid_seconds: Option<i64>,
    pub fee: Option<String>,
}

/// `GlobalSimCatalogue`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Catalogue {
    pub label: String,
    pub corridors: Vec<SimCorridor>,
    pub rates: Vec<SimRate>,
    /// `(asset, amount)`.
    pub review_from: Option<Vec<(String, String)>>,
    pub quote_valid_seconds: i64,
    pub eta_hours: i64,
    pub banks: Vec<BicHit>,
    pub travel_rule: TravelRuleDecision,
}

fn fields<'a>(v: &'a Json, allowed: &[&str]) -> Option<&'a [(String, Json)]> {
    let Json::Object(f) = v else { return None };
    f.iter()
        .all(|(k, _)| allowed.contains(&k.as_str()))
        .then_some(f.as_slice())
}

fn get<'a>(f: &'a [(String, Json)], k: &str) -> Option<&'a Json> {
    f.iter().find(|(key, _)| key == k).map(|(_, v)| v)
}

fn string(v: &Json) -> Option<&str> {
    match v {
        Json::String(s) => Some(s),
        _ => None,
    }
}

fn units(s: &str) -> usize {
    s.encode_utf16().count()
}

/// `^[A-Z]{lo,hi}$` (`digits` also allows 0-9).
fn caps(s: &str, lo: usize, hi: usize, digits: bool) -> bool {
    (lo..=hi).contains(&s.len())
        && s.bytes()
            .all(|b| b.is_ascii_uppercase() || (digits && b.is_ascii_digit()))
}

/// `/^TEST\b/`.
fn test_label(s: &str) -> bool {
    s.strip_prefix("TEST").is_some_and(|rest| {
        rest.bytes()
            .next()
            .is_none_or(|b| !(b.is_ascii_alphanumeric() || b == b'_'))
    })
}

fn trimmed(v: &Json, min: usize, max: usize) -> Option<String> {
    let t = js_trim(string(v)?);
    (units(t) >= min && units(t) <= max).then(|| t.to_owned())
}

fn int(v: &Json, min: f64, max: f64) -> Option<i64> {
    let Json::Number(n) = v else { return None };
    #[expect(
        clippy::cast_possible_truncation,
        reason = "a whole number inside the bounds"
    )]
    (n.fract() == 0.0 && *n >= min && *n <= max).then_some(*n as i64)
}

fn decimal(v: &Json) -> Option<String> {
    let s = string(v)?;
    is_decimal(s).then(|| s.to_owned())
}

fn nullable<T>(v: &Json, f: impl FnOnce(&Json) -> Option<T>) -> Option<Option<T>> {
    match v {
        Json::Null => Some(None),
        other => f(other).map(Some),
    }
}

fn array<T>(v: &Json, f: impl Fn(&Json) -> Option<T>) -> Option<Vec<T>> {
    let Json::Array(items) = v else { return None };
    items.iter().map(f).collect()
}

fn corridor(v: &Json) -> Option<SimCorridor> {
    let f = fields(
        v,
        &[
            "country",
            "currency",
            "deliveryMethods",
            "minAmount",
            "maxAmount",
            "cutOffTime",
            "payout",
            "swiftCharges",
        ],
    )?;
    let country = string(get(f, "country")?).filter(|s| caps(s, 2, 2, false))?;
    let currency = string(get(f, "currency")?).filter(|s| caps(s, 3, 8, false))?;
    let methods = array(get(f, "deliveryMethods")?, |m| trimmed(m, 1, 64))?;
    if methods.is_empty() {
        return None;
    }
    let payout = match get(f, "payout") {
        None => None,
        Some(Json::Bool(b)) => Some(*b),
        Some(_) => return None,
    };
    let swift = match get(f, "swiftCharges") {
        None => None,
        Some(v) => Some(string(v).filter(|s| SWIFT_CHARGES.contains(s))?.to_owned()),
    };
    Some(SimCorridor {
        corridor: Corridor {
            country: country.to_owned(),
            currency: currency.to_owned(),
            delivery_methods: methods,
            min_amount: nullable(get(f, "minAmount")?, decimal)?,
            max_amount: nullable(get(f, "maxAmount")?, decimal)?,
            cut_off_time: nullable(get(f, "cutOffTime")?, |c| trimmed(c, 1, 80))?,
            swift_charges: swift,
        },
        payout,
    })
}

fn rate(v: &Json) -> Option<SimRate> {
    let f = fields(v, &["asset", "toCurrency", "rate", "validSeconds", "fee"])?;
    Some(SimRate {
        asset: string(get(f, "asset")?)
            .filter(|s| caps(s, 2, 16, true))?
            .to_owned(),
        to_currency: string(get(f, "toCurrency")?)
            .filter(|s| caps(s, 3, 8, false))?
            .to_owned(),
        rate: decimal(get(f, "rate")?)?,
        valid_seconds: match get(f, "validSeconds") {
            None => None,
            Some(v) => Some(int(v, 1.0, 3600.0)?),
        },
        fee: match get(f, "fee") {
            None => None,
            Some(v) => Some(decimal(v)?),
        },
    })
}

fn shape(v: &Json) -> Option<Catalogue> {
    let f = fields(
        v,
        &[
            "label",
            "corridors",
            "rates",
            "reviewFrom",
            "quoteValidSeconds",
            "etaHours",
            "banks",
            "travelRule",
        ],
    )?;
    let label = string(get(f, "label")?)
        .filter(|s| test_label(s))?
        .to_owned();
    let corridors = array(get(f, "corridors")?, corridor)?;
    let rates = array(get(f, "rates")?, rate)?;
    if corridors.is_empty() || rates.is_empty() {
        return None;
    }
    let review_from = match get(f, "reviewFrom") {
        None => None,
        Some(v) => Some(array(v, |line| {
            let l = fields(line, &["asset", "amount"])?;
            Some((
                string(get(l, "asset")?)
                    .filter(|s| caps(s, 2, 16, true))?
                    .to_owned(),
                decimal(get(l, "amount")?)?,
            ))
        })?),
    };
    let banks = array(get(f, "banks")?, |b| {
        let l = fields(b, &["bic", "bankName"])?;
        let bic = string(get(l, "bic")?)
            .filter(|s| (s.len() == 8 || s.len() == 11) && caps(s, 8, 11, true))?;
        Some(BicHit {
            bic: bic.to_owned(),
            bank_name: trimmed(get(l, "bankName")?, 1, 140)?,
        })
    })?;
    let rule = fields(get(f, "travelRule")?, &["decidedBy", "requiredFields"])?;
    let decided_by = string(get(rule, "decidedBy")?)
        .filter(|s| test_label(s))?
        .to_owned();
    let required_fields = array(get(rule, "requiredFields")?, |x| {
        let s = string(x)?;
        let ok = (1..=64).contains(&s.len())
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b':' | b'-'));
        ok.then(|| s.to_owned())
    })?;
    Some(Catalogue {
        label,
        corridors,
        rates,
        review_from,
        quote_valid_seconds: int(get(f, "quoteValidSeconds")?, 1.0, 3600.0)?,
        eta_hours: int(get(f, "etaHours")?, 0.0, 240.0)?,
        banks,
        travel_rule: TravelRuleDecision {
            decided_by,
            required_fields,
        },
    })
}

/// `parseGlobalSim`: the typed catalogue, or none when it is blank, not JSON, not labelled TEST or not in shape. A
/// rate of zero, a screening amount or corridor bound of zero, or two screening lines for one asset is unreadable.
pub fn parse(raw: Option<&str>) -> Option<Catalogue> {
    let raw = raw.filter(|r| !js_trim(r).is_empty())?;
    let c = shape(&json::parse(raw).ok()?)?;
    let positive = |s: &str| parse_amount(s).is_ok_and(|a| a > 0);
    if !c.rates.iter().all(|r| positive(&r.rate)) {
        return None;
    }
    let review = c.review_from.as_deref().unwrap_or_default();
    if !review.iter().all(|(_, a)| positive(a)) {
        return None;
    }
    let mut assets: Vec<&str> = review.iter().map(|(a, _)| a.as_str()).collect();
    assets.sort_unstable();
    assets.dedup();
    if assets.len() != review.len() {
        return None;
    }
    for s in &c.corridors {
        for bound in [&s.corridor.min_amount, &s.corridor.max_amount]
            .into_iter()
            .flatten()
        {
            if !positive(bound) {
                return None;
            }
        }
    }
    Some(c)
}

/// `globalSimPorts`: the stand-in's ports over one catalogue. What it paid out is kept in this process only.
pub struct SimPorts {
    catalogue: Catalogue,
    now: fn() -> Instant,
    paid: Mutex<BTreeMap<String, StandInPayout>>,
}

impl SimPorts {
    pub fn new(catalogue: Catalogue, now: fn() -> Instant) -> SimPorts {
        SimPorts {
            catalogue,
            now,
            paid: Mutex::new(BTreeMap::new()),
        }
    }
}

impl GlobalPorts for SimPorts {
    fn stand_in(&self) -> Option<String> {
        Some(self.catalogue.label.clone())
    }

    fn stand_in_payout(&self, send_id: &str) -> Option<StandInPayout> {
        self.paid.lock().ok()?.get(send_id).cloned()
    }

    fn review_waits(&self, asset_id: &str, amount: &str) -> Option<bool> {
        let lines = self
            .catalogue
            .review_from
            .as_ref()
            .filter(|l| !l.is_empty())?;
        let asset = asset_id.to_uppercase();
        Some(lines.iter().find(|(a, _)| *a == asset).is_some_and(|(_, from)| {
            matches!((parse_amount(amount), parse_amount(from)), (Ok(a), Ok(f)) if a >= f)
        }))
    }

    fn corridors_live(&self) -> Live {
        true
    }

    fn corridors(&self) -> Result<Vec<Corridor>, String> {
        Ok(self
            .catalogue
            .corridors
            .iter()
            .map(|c| c.corridor.clone())
            .collect())
    }

    fn bic_live(&self) -> Live {
        true
    }

    fn bic_lookup(&self, bic: &str) -> Result<Option<BicHit>, String> {
        let wanted = compact_upper(bic);
        Ok(self
            .catalogue
            .banks
            .iter()
            .find(|b| b.bic == wanted)
            .cloned())
    }

    fn fx_live(&self) -> Live {
        true
    }

    fn fx_quote(&self, asset: &str, amount: &str, to_currency: &str) -> Result<FxQuote, String> {
        let row = self
            .catalogue
            .rates
            .iter()
            .find(|r| r.asset == asset && r.to_currency == to_currency)
            .ok_or_else(|| format!("no TEST rate for {asset} to {to_currency}"))?;
        let at = (self.now)().0;
        // Floor, as a provider pays no more than it quotes; past what the ledger can hold, the quote is unusable.
        let gross = mul_rounded(
            parse_amount(amount)?,
            parse_amount(&row.rate)?,
            Rounding::Floor,
        );
        let gross = parse_amount(&format_amount(gross))?;
        let fee = row.fee.clone().unwrap_or_else(|| "0".to_owned());
        let net = gross - parse_amount(&fee)?;
        if net <= 0 {
            return Err(format!(
                "a TEST fee of {fee} {to_currency} leaves nothing to arrive"
            ));
        }
        let valid = row
            .valid_seconds
            .unwrap_or(self.catalogue.quote_valid_seconds);
        Ok(FxQuote {
            rate: row.rate.clone(),
            fee_asset: if row.fee.is_some() {
                to_currency
            } else {
                asset
            }
            .to_owned(),
            fee,
            receive_amount: format_amount(net),
            valid_until: Instant(at + valid * 1000).iso(),
            eta: Instant(at + self.catalogue.eta_hours * 3_600_000).iso(),
        })
    }

    fn payout_live(&self) -> Live {
        true
    }

    fn payout_covers(
        &self,
        country: &str,
        currency: &str,
        delivery_method: &str,
    ) -> Option<Result<bool, String>> {
        Some(Ok(self.catalogue.corridors.iter().any(|c| {
            c.payout != Some(false)
                && c.corridor.country == country
                && c.corridor.currency == currency
                && c.corridor
                    .delivery_methods
                    .iter()
                    .any(|m| m == delivery_method)
        })))
    }

    fn payout_rail_id(&self) -> Result<String, String> {
        Ok(GLOBAL_SIM_RAIL.to_owned())
    }

    /// The stand-in pays nobody: it acknowledges the send so the tracker has a reference, keyed by the send itself.
    fn payout_submit(&self, p: &Payout) -> Result<PayoutAnswer, String> {
        let mut paid = self.paid.lock().map_err(|e| e.to_string())?;
        paid.entry(p.send_id.clone())
            .and_modify(|r| r.calls += 1)
            .or_insert_with(|| StandInPayout {
                send_id: p.send_id.clone(),
                quote_id: p.quote_id.clone(),
                asset_id: p.asset_id.clone(),
                amount: p.amount.clone(),
                to_currency: p.to_currency.clone(),
                rate: p.rate.clone(),
                receive_amount: p.receive_amount.clone(),
                conversions: 1,
                calls: 1,
            });
        Ok(PayoutAnswer::Accepted {
            provider_ref: format!("TEST-{}", p.send_id),
            status: "sent".to_owned(),
        })
    }

    fn travel_rule(&self) -> Option<TravelRuleDecision> {
        Some(self.catalogue.travel_rule.clone())
    }
}

/// `globalPortsFor`: `none` gives the unset ports; `global-sim` gives the stand-in only in an explicit dev or test
/// process (the RAW `APP_ENV`, never a defaulted one) with a readable catalogue, and refuses to start otherwise.
pub fn ports_for(
    setting: &str,
    catalogue: Option<&str>,
    app_env: Option<&str>,
    node_env: Option<&str>,
    now: fn() -> Instant,
) -> Result<Box<dyn GlobalPorts>, String> {
    if setting != "global-sim" {
        return Ok(Box::new(super::ports::EmptyPorts));
    }
    if !matches!(app_env, Some("dev" | "test")) || node_env == Some("production") {
        return Err(
            "BANK_GLOBAL_PARTNER=global-sim is a local-test stand-in that pays nobody; it runs only with APP_ENV exactly dev or test. (bank.global_sim_outside_dev_test)"
                .to_owned(),
        );
    }
    let catalogue = parse(catalogue).ok_or_else(|| {
        "BANK_GLOBAL_PARTNER=global-sim needs BANK_GLOBAL_SIM_JSON: a catalogue labelled TEST, in shape (see global-sim.ts). (bank.global_sim_catalogue_unreadable)"
            .to_owned()
    })?;
    Ok(Box::new(SimPorts::new(catalogue, now)))
}

#[cfg(test)]
mod tests {
    //! `personal-pay/global-sim.test.ts`, each test named after its words.
    #![allow(clippy::unwrap_used, clippy::panic, reason = "a test")]
    use super::*;

    const CATALOGUE: &str = r#"{"label":"TEST stand-in","corridors":[{"country":"DE","currency":"EUR","deliveryMethods":["sepa"],"minAmount":"1","maxAmount":"1000","cutOffTime":null}],"rates":[{"asset":"USDT","toCurrency":"EUR","rate":"2"}],"quoteValidSeconds":300,"etaHours":24,"banks":[{"bic":"TESTDEFF","bankName":"TEST Bank"}],"travelRule":{"decidedBy":"TEST local stack","requiredFields":[]}}"#;

    /// The catalogue with `key` replaced (or added) by `value`.
    fn with(key: &str, value: &str) -> String {
        let Json::Object(mut f) = json::parse(CATALOGUE).unwrap() else {
            panic!()
        };
        let v = json::parse(value).unwrap();
        match f.iter_mut().find(|(k, _)| k == key) {
            Some(slot) => slot.1 = v,
            None => f.push((key.to_owned(), v)),
        }
        Json::Object(f).compact()
    }

    fn now() -> Instant {
        service_kit::time::js_date("2026-10-23T12:00:00.000Z").unwrap()
    }

    fn ports(over: &[(&str, &str)]) -> SimPorts {
        let mut text = CATALOGUE.to_owned();
        for (k, v) in over {
            let Json::Object(mut f) = json::parse(&text).unwrap() else {
                panic!()
            };
            let v = json::parse(v).unwrap();
            match f.iter_mut().find(|(key, _)| key == k) {
                Some(slot) => slot.1 = v,
                None => f.push(((*k).to_owned(), v)),
            }
            text = Json::Object(f).compact();
        }
        SimPorts::new(parse(Some(&text)).unwrap(), now)
    }

    #[test]
    fn reads_only_a_catalogue_labelled_test_in_shape_with_rates_and_bounds_above_zero() {
        let c = parse(Some(CATALOGUE)).unwrap();
        assert_eq!(c.label, "TEST stand-in");
        assert_eq!(c.corridors[0].corridor.cut_off_time, None);
        assert!(parse(None).is_none());
        assert!(parse(Some("  ")).is_none());
        assert!(parse(Some("{not json")).is_none());
        assert!(parse(Some(&with("label", "\"Partner catalogue\""))).is_none());
        assert!(
            parse(Some(&with(
                "travelRule",
                r#"{"decidedBy":"Compliance","requiredFields":[]}"#
            )))
            .is_none()
        );
        assert!(
            parse(Some(&with(
                "rates",
                r#"[{"asset":"USDT","toCurrency":"EUR","rate":"0"}]"#
            )))
            .is_none()
        );
        assert!(
            parse(Some(&with(
                "corridors",
                r#"[{"country":"DE","currency":"EUR","deliveryMethods":["sepa"],"minAmount":"1","maxAmount":"0","cutOffTime":null}]"#
            )))
            .is_none()
        );
        assert!(parse(Some(&with("corridors", "[]"))).is_none());
        assert!(parse(Some(&with("extra", "true"))).is_none());
        assert!(
            parse(Some(&with(
                "reviewFrom",
                r#"[{"asset":"USDT","amount":"0"}]"#
            )))
            .is_none()
        );
        assert!(parse(Some(&with("reviewFrom", r#"[{"asset":"USDT"}]"#))).is_none());
        assert!(parse(Some(&with("reviewFrom", "\"500\""))).is_none());
        assert!(
            parse(Some(&with(
                "reviewFrom",
                r#"[{"asset":"USDT","amount":"5000"},{"asset":"USDT","amount":"500"}]"#
            )))
            .is_none()
        );
        assert!(
            test_label("TEST")
                && test_label("TEST-x")
                && !test_label("TESTING")
                && !test_label("TEST_x")
        );
    }

    #[test]
    fn is_never_chosen_by_default_and_refuses_to_start_outside_an_explicit_dev_or_test_process_or_over_a_blank_catalogue()
     {
        let dev = Some("dev");
        assert!(
            !ports_for("none", Some(CATALOGUE), dev, None, now)
                .unwrap()
                .corridors_live()
        );
        assert!(
            ports_for("none", Some(CATALOGUE), None, None, now)
                .unwrap()
                .stand_in()
                .is_none()
        );
        let refused = |app: Option<&str>, node: Option<&str>, cat: Option<&str>| match ports_for(
            "global-sim",
            cat,
            app,
            node,
            now,
        ) {
            Ok(_) => "started".to_owned(),
            Err(e) => e,
        };
        for (app, node) in [
            (None, None),
            (Some("DEV"), None),
            (Some("staging"), None),
            (Some("prod"), None),
            (dev, Some("production")),
        ] {
            assert!(
                refused(app, node, Some(CATALOGUE)).ends_with("(bank.global_sim_outside_dev_test)")
            );
        }
        assert!(refused(dev, None, Some("")).ends_with("(bank.global_sim_catalogue_unreadable)"));
        assert!(
            refused(dev, None, Some(&with("label", "\"Partner catalogue\"")))
                .ends_with("(bank.global_sim_catalogue_unreadable)")
        );
        assert_eq!(refused(Some("test"), None, Some(CATALOGUE)), "started");
        assert_eq!(
            ports_for("global-sim", Some(CATALOGUE), dev, None, now)
                .unwrap()
                .stand_in()
                .as_deref(),
            Some("TEST stand-in")
        );
    }

    #[test]
    fn answers_only_from_the_catalogue_corridors_banks_the_travel_rule_fields_and_the_rate() {
        let p = ports(&[]);
        assert_eq!(p.corridors().unwrap()[0].swift_charges, None);
        assert_eq!(
            p.bic_lookup("testdeff").unwrap(),
            Some(BicHit {
                bic: "TESTDEFF".to_owned(),
                bank_name: "TEST Bank".to_owned()
            })
        );
        assert_eq!(p.bic_lookup("NOPEDEFF").unwrap(), None);
        assert_eq!(p.travel_rule().unwrap().decided_by, "TEST local stack");
        assert_eq!(
            p.fx_quote("USDT", "40.5", "EUR").unwrap(),
            FxQuote {
                rate: "2".to_owned(),
                fee: "0".to_owned(),
                fee_asset: "USDT".to_owned(),
                receive_amount: "81".to_owned(),
                valid_until: "2026-10-23T12:05:00.000Z".to_owned(),
                eta: "2026-10-24T12:00:00.000Z".to_owned(),
            }
        );
        assert!(
            p.fx_quote("USDT", "1", "GBP")
                .unwrap_err()
                .contains("no TEST rate")
        );
        let third = ports(&[(
            "rates",
            r#"[{"asset":"USDT","toCurrency":"EUR","rate":"0.333333333333333333"}]"#,
        )]);
        assert_eq!(
            third.fx_quote("USDT", "0.5", "EUR").unwrap().receive_amount,
            "0.166666666666666666"
        );
        let huge = ports(&[(
            "rates",
            r#"[{"asset":"USDT","toCurrency":"EUR","rate":"99999999999999999999"}]"#,
        )]);
        assert!(
            huge.fx_quote("USDT", "99999999999999999999", "EUR")
                .is_err()
        );
    }

    #[test]
    fn passes_a_swift_corridors_charges_on_as_given_and_locks_a_pairs_quote_for_its_own_test_seconds()
     {
        let p = ports(&[
            (
                "corridors",
                r#"[{"country":"DE","currency":"EUR","deliveryMethods":["sepa"],"minAmount":"1","maxAmount":"1000","cutOffTime":null},{"country":"US","currency":"USD","deliveryMethods":["swift"],"minAmount":"1","maxAmount":"1000","cutOffTime":null,"swiftCharges":"SHA"}]"#,
            ),
            (
                "rates",
                r#"[{"asset":"USDT","toCurrency":"EUR","rate":"2"},{"asset":"USDT","toCurrency":"USD","rate":"1","validSeconds":20,"fee":"0.5"}]"#,
            ),
        ]);
        let listed = p.corridors().unwrap();
        assert_eq!(listed[1].swift_charges.as_deref(), Some("SHA"));
        assert_eq!(listed[0].swift_charges, None);
        let q = p.fx_quote("USDT", "5", "USD").unwrap();
        assert_eq!(
            (
                q.rate.as_str(),
                q.fee.as_str(),
                q.fee_asset.as_str(),
                q.receive_amount.as_str(),
                q.valid_until.as_str()
            ),
            ("1", "0.5", "USD", "4.5", "2026-10-23T12:00:20.000Z")
        );
        assert!(
            p.fx_quote("USDT", "0.5", "USD")
                .unwrap_err()
                .contains("leaves nothing to arrive")
        );
        assert_eq!(
            p.fx_quote("USDT", "5", "EUR").unwrap().valid_until,
            "2026-10-23T12:05:00.000Z"
        );
        assert!(
            parse(Some(&with(
                "corridors",
                r#"[{"country":"US","currency":"USD","deliveryMethods":["swift"],"minAmount":"1","maxAmount":"1000","cutOffTime":null,"swiftCharges":"ALL"}]"#
            )))
            .is_none()
        );
        assert!(
            parse(Some(&with(
                "rates",
                r#"[{"asset":"USDT","toCurrency":"USD","rate":"1","validSeconds":0}]"#
            )))
            .is_none()
        );
    }

    #[test]
    fn screens_a_send_at_or_over_its_test_amount_for_that_asset_another_asset_or_no_list_is_not_screened()
     {
        assert_eq!(ports(&[]).review_waits("USDT", "500"), None);
        assert_eq!(
            ports(&[("reviewFrom", "[]")]).review_waits("USDT", "500"),
            None
        );
        let p = ports(&[("reviewFrom", r#"[{"asset":"USDT","amount":"500"}]"#)]);
        assert_eq!(
            p.review_waits("USDT", "499.999999999999999999"),
            Some(false)
        );
        assert_eq!(p.review_waits("USDT", "500"), Some(true));
        assert_eq!(p.review_waits("BTC", "500"), Some(false));
        assert_eq!(p.review_waits("usdt", "500"), Some(true));
    }

    #[test]
    fn a_corridor_marked_payout_false_is_listed_without_the_flag_and_its_payout_covers_nothing() {
        let p = ports(&[(
            "corridors",
            r#"[{"country":"DE","currency":"EUR","deliveryMethods":["sepa"],"minAmount":"1","maxAmount":"1000","cutOffTime":null},{"country":"NL","currency":"EUR","deliveryMethods":["sepa"],"minAmount":null,"maxAmount":null,"cutOffTime":null,"payout":false}]"#,
        )]);
        assert_eq!(p.corridors().unwrap().len(), 2);
        assert_eq!(p.payout_covers("DE", "EUR", "sepa"), Some(Ok(true)));
        assert_eq!(p.payout_covers("NL", "EUR", "sepa"), Some(Ok(false)));
        assert_eq!(p.payout_covers("DE", "EUR", "swift"), Some(Ok(false)));
        assert!(
            parse(Some(&with(
                "corridors",
                r#"[{"country":"DE","currency":"EUR","deliveryMethods":["sepa"],"minAmount":"1","maxAmount":"1000","cutOffTime":null,"payout":"no"}]"#
            )))
            .is_none()
        );
    }

    #[test]
    fn pays_nobody_the_payout_is_acknowledged_with_a_test_reference_keyed_by_the_send_on_its_own_rail_boundary()
     {
        let p = ports(&[]);
        assert_eq!(p.payout_rail_id().unwrap(), GLOBAL_SIM_RAIL);
        let input = Payout {
            send_id: "s-1".to_owned(),
            idempotency_key: "k-12345678".to_owned(),
            amount: "1".to_owned(),
            asset_id: "USDT".to_owned(),
            to_currency: "EUR".to_owned(),
            recipient_id: "r-1".to_owned(),
            quote_id: "q-1".to_owned(),
            rate: "2".to_owned(),
            receive_amount: "2".to_owned(),
        };
        assert_eq!(p.stand_in_payout("s-1"), None);
        let sent = PayoutAnswer::Accepted {
            provider_ref: "TEST-s-1".to_owned(),
            status: "sent".to_owned(),
        };
        assert_eq!(p.payout_submit(&input).unwrap(), sent);
        assert_eq!(p.payout_submit(&input).unwrap(), sent);
        let record = p.stand_in_payout("s-1").unwrap();
        assert_eq!(
            (
                record.rate.as_str(),
                record.receive_amount.as_str(),
                record.conversions,
                record.calls
            ),
            ("2", "2", 1, 2)
        );
    }
}
