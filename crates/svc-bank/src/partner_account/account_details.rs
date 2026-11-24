//! `accountDetails.list/get/request` and `eligibility.get` (`account-details/`), as `account-details.router.ts` serves
//! them from `AccountDetailsService`.
//!
//! Reads, and one request the banking partner answers; nothing here writes to the ledger or the database. A set of
//! account details is issued by a banking partner, never made up here: with no partner for the person every currency
//! answers `unavailable` with the blocker `rail.bank`, and `get` and `request` refuse `rail.bank`. On the TEST stack the
//! TEST partner answers only a person whose `accountDetails` switch is `issued` (`testPartnerAccountDetails`). The
//! currencies are the owner's list (`BANK_ACCOUNT_DETAILS_CURRENCIES`), and the eligibility statement the owner's rule set
//! (`BANK_ELIGIBILITY_JSON`) beside the platform's own verdict for a region (`JURISDICTION_MATRIX`'s bank rule and its
//! whole-region business blocks); a blank or unreadable value refuses with its own code.

use std::collections::BTreeMap;

use service_kit::json::{self, Json};
use service_kit::money::js_trim;
use service_kit::schema::Value;
use service_kit::server::Response;

use super::{Deps, refuse};
use crate::door::Ctx;
use crate::errors::Refusal;
use crate::partner::{LABEL, TestPartner, partner_down};

/// The states a partner's details can be in (`ACCOUNT_DETAIL_REQUEST_STATES`).
pub const REQUEST_STATES: [&str; 3] = ["pending_user", "requirements_fulfilled", "done"];

/// One set of details as the partner issued it (`AccountDetailSet`). A field the scheme has no use for is `None`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DetailSet {
    pub id: String,
    pub account_number: Option<String>,
    pub sort_code: Option<String>,
    pub routing_number: Option<String>,
    pub bsb: Option<String>,
    pub iban: Option<String>,
    pub bic: Option<String>,
    pub partner_bank: String,
    pub restrictions: Vec<String>,
}

impl DetailSet {
    /// The set as the router's `detailSet` output writes it, in its order.
    pub fn json(&self) -> Json {
        let opt = |v: &Option<String>| v.as_deref().map_or(Json::Null, Json::str);
        Json::obj([
            ("id", Json::str(&self.id)),
            ("accountNumber", opt(&self.account_number)),
            ("sortCode", opt(&self.sort_code)),
            ("routingNumber", opt(&self.routing_number)),
            ("bsb", opt(&self.bsb)),
            ("iban", opt(&self.iban)),
            ("bic", opt(&self.bic)),
            ("partnerBank", Json::str(&self.partner_bank)),
            (
                "restrictions",
                Json::Array(self.restrictions.iter().map(Json::str).collect()),
            ),
        ])
    }
}

/// What the partner says for one currency (`AccountDetailsForCurrency`): one of [`REQUEST_STATES`] and its sets.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForCurrency {
    pub state: String,
    pub sets: Vec<DetailSet>,
}

/// The banking partner (`AccountDetailsPartner`). `request` takes a business key so a retry is the same request. A
/// [`Refusal::Bank`] is passed on as it is; anything else is the partner not answering.
pub trait DetailsPartner: Send + Sync {
    fn details_for(&self, user_id: &str, currency: &str) -> Result<ForCurrency, Refusal>;
    fn request(&self, user_id: &str, currency: &str, key: &str) -> Result<ForCurrency, Refusal>;
}

/// One currency's answer (`CurrencyDetails`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CurrencyDetails {
    pub currency: String,
    /// `unavailable` or the partner's state.
    pub state: String,
    /// `rail.bank` while no partner answers the person; `None` once one does.
    pub blocker: Option<&'static str>,
    pub sets: Vec<DetailSet>,
}

impl CurrencyDetails {
    /// The router's `currencyDetails` output, in its order.
    pub fn json(&self) -> Json {
        Json::obj([
            ("currency", Json::str(&self.currency)),
            ("state", Json::str(&self.state)),
            ("blocker", self.blocker.map_or(Json::Null, Json::str)),
            (
                "sets",
                Json::Array(self.sets.iter().map(DetailSet::json).collect()),
            ),
        ])
    }
}

/// What this part holds, built once from the environment (`index.ts`'s `accountDetails` options).
pub struct Wiring {
    /// `BANK_ACCOUNT_DETAILS_CURRENCIES`: the owner's comma-separated ISO-4217 codes.
    pub currencies: Option<String>,
    /// `BANK_ELIGIBILITY_JSON`: the owner's rule set.
    pub eligibility_json: Option<String>,
    /// `options.partner`: a partner for everyone, which wins over the TEST partner's per-person switch. No build wires
    /// one; a test does.
    pub partner: Option<Box<dyn DetailsPartner>>,
    /// `activeBusinessBlocks()`: the matrix's whole-region blocks and, on a dev or test process, the TEST ones
    /// (`INTAFACED_TEST_BUSINESS_BLOCKS`), each with its reason.
    pub business_blocks: Vec<(String, String)>,
}

/// `SHIPPED_BUSINESS_BLOCKS` (`JURISDICTION_MATRIX`'s `blocked: true` rows), with their reasons.
pub const SHIPPED_BUSINESS_BLOCKS: [(&str, &str); 2] = [
    ("US", "The United States is not served at launch."),
    ("CA-ON", "Ontario, Canada is not served at launch."),
];

/// `TEST_BUSINESS_BLOCK_REASON`.
const TEST_BLOCK_REASON: &str = "TEST region, not served at launch";

impl Wiring {
    pub fn from_env(env: &BTreeMap<String, String>) -> Result<Wiring, String> {
        let mut business_blocks: Vec<(String, String)> = SHIPPED_BUSINESS_BLOCKS
            .iter()
            .map(|(r, why)| ((*r).to_owned(), (*why).to_owned()))
            .collect();
        // `testBusinessBlocksFromEnv`: the door's jurisdiction check has already refused a malformed list at start-up.
        let dev_or_test = matches!(env.get("APP_ENV").map(String::as_str), Some("dev" | "test"));
        let raw = env
            .get("INTAFACED_TEST_BUSINESS_BLOCKS")
            .map(|v| js_trim(v).to_owned())
            .unwrap_or_default();
        if dev_or_test && !raw.is_empty() {
            for item in raw.split(',') {
                let code = js_trim(item)
                    .strip_prefix("TEST:")
                    .filter(|c| c.len() == 2 && c.bytes().all(|b| b.is_ascii_alphabetic()))
                    .ok_or_else(|| {
                        "INTAFACED_TEST_BUSINESS_BLOCKS: each entry must be TEST:<a user-assigned ISO code such as AA> (value not shown)"
                            .to_owned()
                    })?;
                business_blocks.push((code.to_ascii_uppercase(), TEST_BLOCK_REASON.to_owned()));
            }
        }
        Ok(Wiring {
            currencies: env.get("BANK_ACCOUNT_DETAILS_CURRENCIES").cloned(),
            eligibility_json: env.get("BANK_ELIGIBILITY_JSON").cloned(),
            partner: None,
            business_blocks,
        })
    }
}

/// `requestKey`: the business key of one person's request for one currency.
pub fn request_key(user_id: &str, currency: &str) -> String {
    format!("accountDetails:request:{user_id}:{currency}")
}

fn is_currency(code: &str) -> bool {
    code.len() == 3 && code.bytes().all(|b| b.is_ascii_uppercase())
}

/// `currencies()`: the owner's currencies, in the order given, without repeats. Blank, unreadable or empty refuses.
pub fn currencies(w: &Wiring) -> Result<Vec<String>, Refusal> {
    let raw = w.currencies.as_deref().map(js_trim).unwrap_or_default();
    let mut codes: Vec<String> = Vec::new();
    if !raw.is_empty() {
        for c in raw.split(',') {
            let code = js_trim(c).to_uppercase();
            if !codes.contains(&code) {
                codes.push(code);
            }
        }
    }
    if codes.is_empty() || codes.iter().any(|c| !is_currency(c)) {
        return Err(refuse(
            "bank.account_details_currencies_unset",
            "The owner has not published which currencies have account details, so none is shown",
        ));
    }
    Ok(codes)
}

fn known(w: &Wiring, currency: &str) -> Result<String, Refusal> {
    let code = js_trim(currency).to_uppercase();
    if !currencies(w)?.contains(&code) {
        return Err(refuse(
            "bank.account_details_currency_unknown",
            format!("{code} is not a currency with account details"),
        ));
    }
    Ok(code)
}

/// The TEST partner's details for one person (`testPartnerAccountDetails`): one set per currency, every value TEST.
pub(crate) fn test_set(user_id: &str, currency: &str) -> DetailSet {
    DetailSet {
        id: format!("test-partner:{user_id}:{currency}"),
        account_number: Some(format!(
            "TEST-{currency}-{}",
            user_id.replace('-', "").to_uppercase()
        )),
        sort_code: None,
        routing_number: None,
        bsb: None,
        iban: None,
        bic: None,
        partner_bank: LABEL.to_owned(),
        restrictions: vec![
            "TEST details: no real account exists and nothing can be received".to_owned(),
        ],
    }
}

/// Who answers a person's details.
enum Issuer<'a> {
    Wired(&'a dyn DetailsPartner),
    Test(&'a TestPartner),
}

impl Issuer<'_> {
    fn answer(
        &self,
        user_id: &str,
        currency: &str,
        key: Option<&str>,
    ) -> Result<ForCurrency, Refusal> {
        let got = match self {
            Issuer::Wired(p) => match key {
                Some(key) => p.request(user_id, currency, key),
                None => p.details_for(user_id, currency),
            },
            // `assertPartnerAnswering`: the partner down answers nothing.
            Issuer::Test(p) => {
                if p.switches(user_id).down {
                    Err(partner_down())
                } else {
                    Ok(ForCurrency {
                        state: "done".to_owned(),
                        sets: vec![test_set(user_id, currency)],
                    })
                }
            }
        };
        // `fromPartner`: a BankError passes; anything else is the partner not answering.
        got.map_err(|e| match e {
            Refusal::Bank(_) => e,
            _ => refuse(
                "bank.account_details_unavailable",
                "The banking partner did not answer. Nothing was changed, try again",
            ),
        })
    }
}

/// `partnerOf`: the wired partner, else the TEST partner for a person it issued details to.
fn partner_of<'a>(d: &'a Deps<'_>, user_id: &str) -> Option<Issuer<'a>> {
    if let Some(p) = d.wiring.account_details.partner.as_deref() {
        return Some(Issuer::Wired(p));
    }
    let partner = d.partner.partner.as_ref()?;
    (partner.switches(user_id).account_details == "issued").then_some(Issuer::Test(partner))
}

fn partner<'a>(d: &'a Deps<'_>, user_id: &str) -> Result<Issuer<'a>, Refusal> {
    partner_of(d, user_id).ok_or_else(|| {
        refuse(
            "rail.bank",
            "Account details need a banking partner. It is switched off in this build",
        )
    })
}

/// `list`: every owner-listed currency, `unavailable` with `rail.bank` when no partner answers the person.
pub fn list(d: &Deps<'_>, user_id: &str) -> Result<Vec<CurrencyDetails>, Refusal> {
    let codes = currencies(&d.wiring.account_details)?;
    let Some(partner) = partner_of(d, user_id) else {
        return Ok(codes
            .into_iter()
            .map(|currency| CurrencyDetails {
                currency,
                state: "unavailable".to_owned(),
                blocker: Some("rail.bank"),
                sets: Vec::new(),
            })
            .collect());
    };
    codes
        .into_iter()
        .map(|currency| {
            let got = partner.answer(user_id, &currency, None)?;
            Ok(CurrencyDetails {
                currency,
                state: got.state,
                blocker: None,
                sets: got.sets,
            })
        })
        .collect()
}

/// `get`: one owner-listed currency's details from the person's partner.
pub fn get(d: &Deps<'_>, user_id: &str, currency: &str) -> Result<CurrencyDetails, Refusal> {
    let code = known(&d.wiring.account_details, currency)?;
    let got = partner(d, user_id)?.answer(user_id, &code, None)?;
    Ok(CurrencyDetails {
        currency: code,
        state: got.state,
        blocker: None,
        sets: got.sets,
    })
}

/// `request`: asks the partner for details in one currency; the same person and currency twice is one request.
pub fn request(d: &Deps<'_>, user_id: &str, currency: &str) -> Result<CurrencyDetails, Refusal> {
    let code = known(&d.wiring.account_details, currency)?;
    let key = request_key(user_id, &code);
    let got = partner(d, user_id)?.answer(user_id, &code, Some(&key))?;
    Ok(CurrencyDetails {
        currency: code,
        state: got.state,
        blocker: None,
        sets: got.sets,
    })
}

fn eligibility_unset() -> Refusal {
    refuse(
        "bank.eligibility_unset",
        "The owner has not published who can open an account, so no statement is shown",
    )
}

/// A JavaScript string's `.length`.
fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// The strict object's fields, when it holds exactly `keys`.
fn strict<'a>(v: &'a Json, keys: &[&str]) -> Option<Vec<&'a Json>> {
    let Json::Object(fields) = v else { return None };
    if fields.iter().any(|(k, _)| !keys.contains(&k.as_str())) {
        return None;
    }
    keys.iter().map(|k| v.get(k)).collect()
}

fn strings(v: &Json, ok: impl Fn(&str) -> bool) -> Option<Vec<&str>> {
    let Json::Array(items) = v else { return None };
    items
        .iter()
        .map(|i| match i {
            Json::String(s) if ok(s) => Some(s.as_str()),
            _ => None,
        })
        .collect()
}

/// `parseEligibilityRules`: the owner's rule set held to `ruleSetSchema` and written in its order. Blank, not JSON or
/// not in shape refuses; there is no built-in list.
pub fn parse_rules(raw: Option<&str>) -> Result<Json, Refusal> {
    let text = raw.map(js_trim).unwrap_or_default();
    if text.is_empty() {
        return Err(eligibility_unset());
    }
    let parsed = json::parse(text).map_err(|_| eligibility_unset())?;
    rules_of(&parsed).ok_or_else(eligibility_unset)
}

fn rules_of(v: &Json) -> Option<Json> {
    let [countries, entity_types, restrictions] = <[&Json; 3]>::try_from(strict(
        v,
        &["countries", "entityTypes", "productRestrictions"],
    )?)
    .ok()?;
    let countries = strings(countries, |s| {
        s.len() == 2 && s.bytes().all(|b| b.is_ascii_uppercase())
    })
    .filter(|l| !l.is_empty())?;
    let entity_types =
        strings(entity_types, |s| (1..=64).contains(&js_len(s))).filter(|l| !l.is_empty())?;
    let Json::Array(items) = restrictions else {
        return None;
    };
    let restrictions = items
        .iter()
        .map(|item| {
            let [product, restriction] =
                <[&Json; 2]>::try_from(strict(item, &["product", "restriction"])?).ok()?;
            match (product, restriction) {
                (Json::String(p), Json::String(r))
                    if (1..=64).contains(&js_len(p)) && (1..=280).contains(&js_len(r)) =>
                {
                    Some(Json::obj([
                        ("product", Json::str(p)),
                        ("restriction", Json::str(r)),
                    ]))
                }
                _ => None,
            }
        })
        .collect::<Option<Vec<Json>>>()?;
    Some(Json::obj([
        (
            "countries",
            Json::Array(countries.into_iter().map(Json::str).collect()),
        ),
        (
            "entityTypes",
            Json::Array(entity_types.into_iter().map(Json::str).collect()),
        ),
        ("productRestrictions", Json::Array(restrictions)),
    ]))
}

/// `eligibilityFor`: the owner's rules and, for a region, the platform's verdict for the bank module there. No region of
/// the matrix names the bank module, so its rule is the default (`open`, tier `full`), or `BLOCKED` for an unresolved
/// region (`XX`); a whole-region business block says `blocked` with the block's reason.
pub fn eligibility(w: &Wiring, region: Option<&str>) -> Result<Json, Refusal> {
    let rules = parse_rules(w.eligibility_json.as_deref())?;
    let Some(region) = region else {
        return Ok(Json::obj([("rules", rules), ("verdict", Json::Null)]));
    };
    let code = js_trim(region).to_uppercase();
    let unresolved = code.is_empty() || code == "XX";
    let (status, min_tier) = if unresolved {
        ("blocked", "institutional")
    } else {
        ("open", "full")
    };
    let block = (!unresolved)
        .then(|| w.business_blocks.iter().find(|(r, _)| *r == code))
        .flatten();
    let listed =
        matches!(rules.get("countries"), Some(Json::Array(c)) if c.contains(&Json::str(&code)));
    Ok(Json::obj([
        ("rules", rules),
        (
            "verdict",
            Json::obj([
                ("region", Json::str(&code)),
                (
                    "status",
                    Json::str(if block.is_some() { "blocked" } else { status }),
                ),
                ("minTier", Json::str(min_tier)),
                ("notes", block.map_or(Json::Null, |(_, why)| Json::str(why))),
                ("source", Json::str("JURISDICTION_MATRIX")),
                ("listed", Json::Bool(listed)),
            ]),
        ),
    ]))
}

/// The answer of one of this part's calls, by its path; `None` for a path outside it.
pub fn answer(d: &Deps<'_>, ctx: &Ctx<'_>) -> Option<Result<Json, Refusal>> {
    let user = ctx
        .principal
        .map(|p| p.user_id.as_str())
        .unwrap_or_default();
    let input = &ctx.input;
    let profile =
        || crate::spaces::home::personal_only(d.store, user, input.get("profile").as_str());
    let currency = || {
        input
            .get("currency")
            .as_str()
            .unwrap_or_default()
            .to_owned()
    };
    Some(match ctx.call.path {
        "accountDetails.list" => profile().and_then(|()| {
            let rows = list(d, user)?;
            Ok(Json::obj([(
                "currencies",
                Json::Array(rows.iter().map(CurrencyDetails::json).collect()),
            )]))
        }),
        "accountDetails.get" => {
            profile().and_then(|()| get(d, user, &currency()).map(|c| c.json()))
        }
        "accountDetails.request" => {
            profile().and_then(|()| request(d, user, &currency()).map(|c| c.json()))
        }
        "eligibility.get" => eligibility(&d.wiring.account_details, input.get("region").as_str()),
        _ => return None,
    })
}

/// No job door is this part's.
pub fn job(_d: &Deps<'_>, _path: &str, _body: &Value) -> Option<Response> {
    None
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test")]
    use super::*;

    fn wiring(currencies: Option<&str>, rules: Option<&str>) -> Wiring {
        let mut env = BTreeMap::new();
        env.insert("APP_ENV".to_owned(), "test".to_owned());
        let mut w = Wiring::from_env(&env).unwrap();
        w.currencies = currencies.map(str::to_owned);
        w.eligibility_json = rules.map(str::to_owned);
        w
    }

    fn code(r: Result<impl std::fmt::Debug, Refusal>) -> String {
        match r {
            Err(Refusal::Bank(e)) => e.row.code.to_owned(),
            other => format!("{other:?}"),
        }
    }

    #[test]
    fn lists_nothing_and_says_why_while_the_owner_has_published_no_currencies() {
        assert_eq!(
            code(currencies(&wiring(None, None))),
            "bank.account_details_currencies_unset"
        );
        assert_eq!(
            code(currencies(&wiring(Some("GBP,EURO"), None))),
            "bank.account_details_currencies_unset"
        );
        assert_eq!(
            currencies(&wiring(Some(" gbp, EUR,GBP"), None)).unwrap(),
            vec!["GBP", "EUR"]
        );
    }

    #[test]
    fn asking_twice_for_the_same_currency_sends_the_same_business_key() {
        assert_eq!(
            request_key("11111111-1111-4111-8111-111111111111", "GBP"),
            "accountDetails:request:11111111-1111-4111-8111-111111111111:GBP"
        );
    }

    const RULES: &str = r#"{"countries":["GB","DE"],"entityTypes":["individual","company"],"productRestrictions":[{"product":"crypto","restriction":"TEST: held as crypto, not as cash"}]}"#;

    #[test]
    fn refuses_while_the_owner_has_published_no_rule_set_or_one_that_is_not_in_shape() {
        for raw in [
            None,
            Some(""),
            Some("   "),
            Some("not json"),
            Some("{}"),
            Some(r#"{"countries":["gb"],"entityTypes":["x"],"productRestrictions":[]}"#),
            Some(r#"{"countries":["GB"],"entityTypes":["x"],"productRestrictions":[],"extra":1}"#),
            Some(r#"{"countries":["GB"],"entityTypes":[],"productRestrictions":[]}"#),
        ] {
            assert_eq!(
                code(eligibility(&wiring(None, raw), None)),
                "bank.eligibility_unset",
                "{raw:?}"
            );
        }
    }

    #[test]
    fn is_readable_before_sign_up_and_returns_the_owners_rules_as_published() {
        let out = eligibility(&wiring(None, Some(RULES)), None).unwrap();
        assert_eq!(
            out.compact(),
            format!(r#"{{"rules":{RULES},"verdict":null}}"#)
        );
    }

    #[test]
    fn a_us_region_is_told_the_bank_is_not_available_there_and_which_rule_says_so() {
        let out = eligibility(&wiring(None, Some(RULES)), Some("us")).unwrap();
        assert_eq!(
            out.get("verdict").unwrap().compact(),
            r#"{"region":"US","status":"blocked","minTier":"full","notes":"The United States is not served at launch.","source":"JURISDICTION_MATRIX","listed":false}"#
        );
    }

    #[test]
    fn a_listed_open_region_is_open_and_listed_an_unlisted_open_region_is_open_but_not_listed() {
        let w = wiring(None, Some(RULES));
        let verdict = |r| {
            eligibility(&w, Some(r))
                .unwrap()
                .get("verdict")
                .unwrap()
                .compact()
        };
        assert_eq!(
            verdict("DE"),
            r#"{"region":"DE","status":"open","minTier":"full","notes":null,"source":"JURISDICTION_MATRIX","listed":true}"#
        );
        assert!(
            verdict("FR").contains(r#""status":"open""#)
                && verdict("FR").contains(r#""listed":false"#)
        );
        assert!(
            verdict("xx").contains(r#""status":"blocked","minTier":"institutional","notes":null"#)
        );
    }

    /// While the TypeScript runs, the matrix's business blocks are the ones held here.
    #[test]
    fn the_business_blocks_are_the_matrixs() {
        let file = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../packages/config/src/jurisdiction.ts");
        let Ok(text) = std::fs::read_to_string(file) else {
            return;
        };
        for (region, reason) in SHIPPED_BUSINESS_BLOCKS {
            assert!(
                text.contains(&format!(
                    "region: '{region}',\n    blocked: true,\n    reason: '{reason}'"
                )),
                "{region}"
            );
        }
        assert!(text.contains("  bank: OPEN_FULL,"));
        assert!(text.contains(&format!(
            "TEST_BUSINESS_BLOCK_REASON = '{TEST_BLOCK_REASON}'"
        )));
    }
}
