//! THE CASH-OUT PAYOUT STAND-IN, AND IT IS A TEST FIXTURE (`cash-out/payout-sim.ts`).
//!
//! Paying out to a bank account is `rail.bank`: a banking partner verifies the account, prices the payout, pays it and
//! later says whether it arrived, failed or came back. None is wired, so `BANK_PAYOUT_PARTNER=none` (the default) keeps
//! every cash-out refused by name. `payout-sim` stands in on the local test stack: it prices the assets its TEST
//! catalogue lists (`BANK_PAYOUT_SIM_JSON`) and takes a payout with a TEST reference; the partner's verify, paid, failed,
//! cancelled and returned answers are its signed job doors. Chosen outside an explicit dev or test process, or over a
//! blank or unreadable catalogue, the service refuses to start. `BANK_PAYOUT_SIM_RECORDS_DIR` keeps its own TEST record
//! of each payout (`rail_records`).

use service_kit::json::{self, Json};
use service_kit::money::{Amount, Rounding, format_amount, mul_rounded, parse_amount};

use crate::partner_account::rail_records::RailRecorder;

/// `PAYOUT_SIM_RAIL`: the ledger rail boundary the stand-in pays out to and returns from.
pub const RAIL: &str = "payout-sim";

/// `PAYOUT_FAILURES`, `PAYOUT_RETURNS`, `PAYOUT_CANCELS`.
pub const FAILURES: [&str; 3] = [
    "bank.payout_account_closed",
    "bank.payout_name_mismatch",
    "bank.payout_rejected",
];
pub const RETURNS: [&str; 2] = [
    "bank.payout_returned_account_closed",
    "bank.payout_returned_by_bank",
];
pub const CANCELS: [&str; 2] = [
    "bank.payout_cancelled_by_bank",
    "bank.payout_cancelled_compliance",
];

/// One asset the stand-in pays out: the currency, its TEST rate and fee as the catalogue wrote them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Line {
    pub asset: String,
    pub currency: String,
    pub rate: String,
    pub fee: String,
}

/// The partner's price for one payout (`PayoutPrice`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Price {
    pub fee: String,
    pub receive_amount: String,
    pub receive_currency: String,
}

/// Who pays out to bank accounts (`CashOutPartner`); the stand-in is the only one in this build.
#[derive(Debug, Clone)]
pub struct Partner {
    pub label: String,
    pub rail: String,
    pub payouts: Vec<Line>,
    pub records: Option<RailRecorder>,
}

impl Partner {
    /// `price`: what arrives is the amount at the TEST rate, rounded down, less the TEST fee; one the fee eats, or one
    /// too large for the ledger's numeric(38,18), is not priced.
    pub fn price(&self, asset_id: &str, amount: Amount) -> Option<Price> {
        let line = self.payouts.iter().find(|p| p.asset == asset_id)?;
        let rate = parse_amount(&line.rate).ok()?;
        let fee = parse_amount(&line.fee).ok()?;
        let receive = mul_rounded(amount, rate, Rounding::Floor).checked_sub(fee)?;
        if receive <= 0 {
            return None;
        }
        let text = format_amount(receive);
        parse_amount(&text).ok()?;
        Some(Price {
            fee: line.fee.clone(),
            receive_amount: text,
            receive_currency: line.currency.clone(),
        })
    }

    /// `pay`: the cash-out id is the payout's idempotency key.
    pub fn pay(&self, cash_out_id: &str) -> String {
        format!("TEST-PAYOUT-{cash_out_id}")
    }
}

fn decimal(s: &str) -> bool {
    let (whole, frac) = match s.split_once('.') {
        Some((w, f)) => (w, Some(f)),
        None => (s, None),
    };
    !whole.is_empty()
        && whole.bytes().all(|c| c.is_ascii_digit())
        && frac.is_none_or(|f| (1..=18).contains(&f.len()) && f.bytes().all(|c| c.is_ascii_digit()))
}

fn all(s: &str, min: usize, max: usize, ok: fn(&u8) -> bool) -> bool {
    (min..=max).contains(&s.len()) && s.as_bytes().iter().all(ok)
}

/// `/^TEST\b/`.
fn test_label(s: &str) -> bool {
    s.strip_prefix("TEST").is_some_and(|rest| {
        !rest
            .bytes()
            .next()
            .is_some_and(|c| c.is_ascii_alphanumeric() || c == b'_')
    })
}

/// `parsePayoutSim`: the typed catalogue, or none when blank, not JSON, not labelled TEST or not in shape.
pub fn parse_catalogue(text: Option<&str>) -> Option<(String, Vec<Line>)> {
    let text = text.filter(|t| !service_kit::money::js_trim(t).is_empty())?;
    let doc = json::parse(text).ok()?;
    let Json::Object(top) = &doc else { return None };
    if top.len() != 2 || !top.iter().all(|(k, _)| k == "label" || k == "payouts") {
        return None;
    }
    let Some(Json::String(label)) = doc.get("label") else {
        return None;
    };
    let Some(Json::Array(items)) = doc.get("payouts") else {
        return None;
    };
    if !test_label(label) || items.is_empty() {
        return None;
    }
    let mut lines = Vec::new();
    for item in items {
        let Json::Object(fields) = item else {
            return None;
        };
        let known = ["asset", "currency", "rate", "fee"];
        if fields.iter().any(|(k, _)| !known.contains(&k.as_str())) {
            return None;
        }
        let s = |k: &str| match item.get(k) {
            Some(Json::String(v)) => Some(v.clone()),
            _ => None,
        };
        let (Some(asset), Some(currency), Some(rate), Some(fee)) =
            (s("asset"), s("currency"), s("rate"), s("fee"))
        else {
            return None;
        };
        let ok = all(&asset, 2, 16, |c| {
            c.is_ascii_uppercase() || c.is_ascii_digit()
        }) && all(&currency, 3, 16, u8::is_ascii_uppercase)
            && decimal(&rate)
            && decimal(&fee);
        if !ok {
            return None;
        }
        lines.push(Line {
            asset,
            currency,
            rate,
            fee,
        });
    }
    let mut assets: Vec<&str> = lines.iter().map(|l| l.asset.as_str()).collect();
    assets.sort_unstable();
    assets.dedup();
    if assets.len() != lines.len() {
        return None;
    }
    // Both must fit the ledger's numeric(38,18), so a catalogue that cannot price refuses at boot.
    for l in &lines {
        match (parse_amount(&l.rate), parse_amount(&l.fee)) {
            (Ok(r), Ok(f)) if r > 0 && f >= 0 => {}
            _ => return None,
        }
    }
    Some((label.clone(), lines))
}

/// `PayoutSimRefusedError`'s three refusals, in its words.
pub const RECORDS_OUTSIDE_DEV_TEST: &str = "BANK_PAYOUT_SIM_RECORDS_DIR is the local-test stack's records folder; it is an absolute path and is set only with APP_ENV exactly dev or test.";
pub const OUTSIDE_DEV_TEST: &str = "BANK_PAYOUT_PARTNER=payout-sim is a local-test stand-in that pays nobody; it runs only with APP_ENV exactly dev or test.";
pub const CATALOGUE_UNREADABLE: &str = "BANK_PAYOUT_PARTNER=payout-sim needs BANK_PAYOUT_SIM_JSON: a catalogue labelled TEST, in shape (see cash-out/payout-sim.ts).";

/// `cashOutPartnerFor(setting, catalogue, rawEnv, recordsDir)`: `none` is no partner; `payout-sim` is the stand-in only
/// in an explicit dev or test process with a readable TEST catalogue. A records folder outside such a process, or not
/// absolute, refuses whatever the setting.
pub fn partner_for(
    setting: &str,
    catalogue: Option<&str>,
    app_env: Option<&str>,
    node_env: Option<&str>,
    records_dir: Option<&str>,
) -> Result<Option<Partner>, String> {
    let dev_or_test = matches!(app_env, Some("dev" | "test")) && node_env != Some("production");
    if let Some(dir) = records_dir
        && (!dev_or_test || !dir.starts_with('/'))
    {
        return Err(RECORDS_OUTSIDE_DEV_TEST.to_owned());
    }
    if setting != "payout-sim" {
        return Ok(None);
    }
    if !dev_or_test {
        return Err(OUTSIDE_DEV_TEST.to_owned());
    }
    let (label, payouts) =
        parse_catalogue(catalogue).ok_or_else(|| CATALOGUE_UNREADABLE.to_owned())?;
    Ok(Some(Partner {
        label,
        rail: RAIL.to_owned(),
        payouts,
        records: records_dir.map(|d| RailRecorder::new(d, RAIL)),
    }))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test")]
    use super::*;

    const CAT: &str = r#"{"label":"TEST payout stand-in","payouts":[{"asset":"USDT","currency":"EUR","rate":"0.9","fee":"1.5"}]}"#;

    #[test]
    fn prices_at_the_test_rate_rounded_down_less_the_fee_and_not_a_payout_the_fee_eats() {
        let p = partner_for("payout-sim", Some(CAT), Some("test"), None, None)
            .unwrap()
            .unwrap();
        let price = p.price("USDT", parse_amount("20").unwrap()).unwrap();
        assert_eq!(
            (
                price.fee.as_str(),
                price.receive_amount.as_str(),
                price.receive_currency.as_str()
            ),
            ("1.5", "16.5", "EUR")
        );
        assert!(p.price("USDT", parse_amount("1").unwrap()).is_none());
        assert!(p.price("BTC", parse_amount("1").unwrap()).is_none());
        assert_eq!(p.pay("x"), "TEST-PAYOUT-x");
    }

    #[test]
    fn refuses_to_start_outside_dev_or_test_or_over_an_unreadable_catalogue() {
        assert!(
            partner_for("none", None, None, None, None)
                .unwrap()
                .is_none()
        );
        assert_eq!(
            partner_for("payout-sim", Some(CAT), Some("prod"), None, None)
                .err()
                .as_deref(),
            Some(OUTSIDE_DEV_TEST)
        );
        assert_eq!(
            partner_for("payout-sim", Some("{}"), Some("dev"), None, None)
                .err()
                .as_deref(),
            Some(CATALOGUE_UNREADABLE)
        );
        assert_eq!(
            partner_for("none", None, Some("dev"), None, Some("relative"))
                .err()
                .as_deref(),
            Some(RECORDS_OUTSIDE_DEV_TEST)
        );
        assert!(parse_catalogue(Some(r#"{"label":"TESTING","payouts":[{"asset":"USDT","currency":"EUR","rate":"1","fee":"0"}]}"#)).is_none());
        assert!(parse_catalogue(Some(r#"{"label":"TEST x","payouts":[{"asset":"USDT","currency":"EUR","rate":"0","fee":"0"}]}"#)).is_none());
    }
}
