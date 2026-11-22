//! THE ADD-MONEY RATE STAND-IN, A TEST FIXTURE (`ramps/onramp-sim.ts`, J-bank-02 #4).
//!
//! `BANK_ONRAMP_RATES=ramp-sim` answers quotes from a typed catalogue (`BANK_ONRAMP_SIM_JSON`, labelled TEST), for the
//! countries, ways to pay and assets it lists and nothing else. It is a rate source only: it opens no payment, takes no
//! money and credits nothing. Outside a process whose `APP_ENV` is exactly `dev` or `test` (and not
//! `NODE_ENV=production`), or over a blank or unreadable catalogue, the service refuses to start.

use service_kit::json::{self, Json};
use service_kit::money::{Amount, Rounding, format_amount, js_trim, mul_rounded, parse_amount};
use service_kit::time::Instant;

use super::ports::{ONRAMP_METHODS, QuoteAsk, QuoteSource, QuoteTerms};
use super::shape::{decimal, field, int_in, js_len, strict, string, test_label, upper};
use crate::errors::Refusal;

/// `ONRAMP_RATE_SETTINGS`.
pub const SETTINGS: [&str; 2] = ["none", "ramp-sim"];

/// One priced line of the catalogue.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Line {
    pub country: String,
    pub method: String,
    pub asset: String,
    pub pay_currency: String,
    /// The rate and fee as typed: the quote hands the fee on as written.
    pub rate: String,
    pub fee: String,
    pub delivery_estimate: Option<String>,
    pub quote_valid_seconds: Option<i64>,
}

/// The typed catalogue (`OnrampSimCatalogue`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Catalogue {
    pub label: String,
    pub quote_valid_seconds: i64,
    pub quotes: Vec<Line>,
}

fn line(j: &Json) -> Option<Line> {
    let f = strict(
        j,
        &[
            "country",
            "method",
            "asset",
            "payCurrency",
            "rate",
            "fee",
            "deliveryEstimate",
            "quoteValidSeconds",
        ],
    )?;
    let country = string(f, "country").filter(|s| upper(s, 2, 2, false))?;
    let method = string(f, "method").filter(|m| ONRAMP_METHODS.contains(m))?;
    let asset = string(f, "asset").filter(|s| upper(s, 2, 16, true))?;
    let pay_currency = string(f, "payCurrency").filter(|s| upper(s, 3, 16, false))?;
    let rate = string(f, "rate").filter(|s| decimal(s))?;
    let fee = string(f, "fee").filter(|s| decimal(s))?;
    let delivery_estimate = match field(f, "deliveryEstimate")? {
        Json::Null => None,
        Json::String(s) => {
            let t = js_trim(s);
            if !(1..=140).contains(&js_len(t)) {
                return None;
            }
            Some(t.to_owned())
        }
        _ => return None,
    };
    let quote_valid_seconds = match field(f, "quoteValidSeconds") {
        None => None,
        Some(_) => Some(int_in(f, "quoteValidSeconds", 1, 3600)?),
    };
    Some(Line {
        country: country.to_owned(),
        method: method.to_owned(),
        asset: asset.to_owned(),
        pay_currency: pay_currency.to_owned(),
        rate: rate.to_owned(),
        fee: fee.to_owned(),
        delivery_estimate,
        quote_valid_seconds,
    })
}

/// `parseOnrampSim`: the typed catalogue, or `None` when it is blank, not JSON, not labelled TEST, out of shape, lists
/// one ask twice, or has a rate that is not above zero or a figure outside the ledger's `numeric(38,18)`.
pub fn parse(raw: Option<&str>) -> Option<Catalogue> {
    let raw = raw.filter(|r| !js_trim(r).is_empty())?;
    let j = json::parse(raw).ok()?;
    let f = strict(&j, &["label", "quoteValidSeconds", "quotes"])?;
    let label = string(f, "label").filter(|s| test_label(s))?;
    let quote_valid_seconds = int_in(f, "quoteValidSeconds", 1, 3600)?;
    let Some(Json::Array(items)) = field(f, "quotes") else {
        return None;
    };
    if items.is_empty() {
        return None;
    }
    let quotes = items.iter().map(line).collect::<Option<Vec<_>>>()?;
    let mut keys: Vec<String> = quotes
        .iter()
        .map(|q| format!("{}:{}:{}", q.country, q.method, q.asset))
        .collect();
    keys.sort();
    keys.dedup();
    if keys.len() != quotes.len() {
        return None;
    }
    for q in &quotes {
        let (Ok(rate), Ok(fee)) = (parse_amount(&q.rate), parse_amount(&q.fee)) else {
            return None;
        };
        if rate <= 0 || fee < 0 {
            return None;
        }
    }
    Some(Catalogue {
        label: label.to_owned(),
        quote_valid_seconds,
        quotes,
    })
}

/// The stand-in over one typed catalogue (`onrampSim`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OnrampSim {
    pub catalogue: Catalogue,
}

impl OnrampSim {
    pub fn label(&self) -> &str {
        &self.catalogue.label
    }

    fn line(&self, asset_id: &str, method: &str, country: &str) -> Option<&Line> {
        self.catalogue
            .quotes
            .iter()
            .find(|q| q.country == country && q.method == method && q.asset == asset_id)
    }

    /// `covers`: whether it lists this ask (the country already upper case).
    pub fn covers(&self, asset_id: &str, method: &str, country: &str) -> bool {
        self.line(asset_id, method, country).is_some()
    }
}

impl QuoteSource for OnrampSim {
    /// The amount at the TEST rate rounded up, plus the TEST fee, in the pay currency, for the line's seconds.
    fn quote(&self, ask: &QuoteAsk, now: Instant) -> Result<Option<QuoteTerms>, Refusal> {
        let Some(hit) = self.line(&ask.asset_id, &ask.method, &ask.country) else {
            return Ok(None);
        };
        let amount =
            |s: &str| -> Result<Amount, Refusal> { parse_amount(s).map_err(Refusal::Other) };
        let pay = mul_rounded(amount(&ask.amount)?, amount(&hit.rate)?, Rounding::Ceil)
            .saturating_add(amount(&hit.fee)?);
        let seconds = hit
            .quote_valid_seconds
            .unwrap_or(self.catalogue.quote_valid_seconds);
        Ok(Some(QuoteTerms {
            pay_amount: format_amount(pay),
            fee: hit.fee.clone(),
            rate: hit.rate.clone(),
            pay_currency: Some(hit.pay_currency.clone()),
            expires_at: Some(Instant(now.0.saturating_add(seconds.saturating_mul(1000)))),
            delivery_estimate: hit.delivery_estimate.clone(),
        }))
    }
}

/// Why the service will not start with the stand-in chosen (`OnrampSimRefusedError`): its code and words.
pub type Refused = (&'static str, &'static str);

/// `onrampStandInFor`: `none` is no stand-in; `ramp-sim` is the stand-in only in an explicit dev or test process with a
/// readable TEST catalogue.
pub fn stand_in_for(
    setting: Option<&str>,
    catalogue: Option<&str>,
    app_env: Option<&str>,
    node_env: Option<&str>,
) -> Result<Option<OnrampSim>, Refused> {
    if setting != Some("ramp-sim") {
        return Ok(None);
    }
    if !crate::cards::terms::dev_or_test(app_env, node_env) {
        return Err((
            "bank.onramp_sim_outside_dev_test",
            "BANK_ONRAMP_RATES=ramp-sim is a local-test stand-in that prices nothing real; it runs only with APP_ENV exactly dev or test.",
        ));
    }
    let catalogue = parse(catalogue).ok_or((
        "bank.onramp_sim_catalogue_unreadable",
        "BANK_ONRAMP_RATES=ramp-sim needs BANK_ONRAMP_SIM_JSON: a catalogue labelled TEST, in shape (see ramps/onramp-sim.ts).",
    ))?;
    Ok(Some(OnrampSim { catalogue }))
}
