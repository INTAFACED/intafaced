//! What a global send is checked against before anything is quoted or posted, each as the TypeScript reads it:
//!
//! - the account and BIC shape (`personal-pay/account-format.ts`, `withdraw-destination.ts` `isIbanRef`, `isIfscRef`):
//!   shape only, never proof the account or bank exists;
//! - the owner's payee controls, proof-upload limits and exchange allowance (`personal-pay/payee-controls.ts`);
//! - the owner's purpose, source-of-funds and reference table (`personal-pay/send-fields.ts`).
//!
//! Each owner value has no default: blank, not JSON or not in its zod shape reads as unset (`None`), and the send or
//! upload that needs it refuses by name.

use std::collections::{BTreeMap, BTreeSet};

use service_kit::json::{self, Json};
use service_kit::money::{Amount, is_js_whitespace, js_trim, parse_amount};

/// `raw.replace(/\s+/g, '').toUpperCase()`.
pub fn compact_upper(raw: &str) -> String {
    raw.chars()
        .filter(|c| !is_js_whitespace(*c))
        .collect::<String>()
        .to_uppercase()
}

/// `normalizeAccount`.
pub fn normalize_account(account: &str) -> String {
    compact_upper(account)
}

/// `AccountKind`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AccountKind {
    Iban,
    Ifsc,
    AccountNumber,
}

impl AccountKind {
    pub fn as_str(self) -> &'static str {
        match self {
            AccountKind::Iban => "iban",
            AccountKind::Ifsc => "ifsc",
            AccountKind::AccountNumber => "account_number",
        }
    }
}

fn upper(b: u8) -> bool {
    b.is_ascii_uppercase()
}

fn alnum(b: u8) -> bool {
    b.is_ascii_uppercase() || b.is_ascii_digit()
}

/// `isIbanRef`: the shape, 15 to 34 characters, and mod 97 of the rearranged digits is 1.
pub fn is_iban(reference: &str) -> bool {
    let c = compact_upper(reference);
    let b = c.as_bytes();
    let (Some(head), Some(tail)) = (b.get(..4), b.get(4..)) else {
        return false;
    };
    let shaped = !tail.is_empty()
        && head.iter().take(2).all(|x| upper(*x))
        && head.iter().skip(2).all(u8::is_ascii_digit)
        && tail.iter().all(|x| alnum(*x));
    if !shaped || !(15..=34).contains(&b.len()) {
        return false;
    }
    let mut remainder: u32 = 0;
    for &ch in tail.iter().chain(head) {
        if ch.is_ascii_uppercase() {
            for d in (u32::from(ch) - 55).to_string().bytes() {
                remainder = (remainder * 10 + u32::from(d - b'0')) % 97;
            }
        } else {
            remainder = (remainder * 10 + u32::from(ch - b'0')) % 97;
        }
    }
    remainder == 1
}

/// `isIfscRef`: four letters, a zero, six letters or digits.
pub fn is_ifsc(reference: &str) -> bool {
    let c = compact_upper(reference);
    let b = c.as_bytes();
    b.len() == 11
        && b.iter().take(4).all(|x| upper(*x))
        && b.get(4) == Some(&b'0')
        && b.iter().skip(5).all(|x| alnum(*x))
}

/// `classifyAccount`: the kind and the compact form, or none.
pub fn classify_account(raw: &str) -> Option<(AccountKind, String)> {
    let compact = compact_upper(raw);
    if is_iban(&compact) {
        return Some((AccountKind::Iban, compact));
    }
    if is_ifsc(&compact) {
        return Some((AccountKind::Ifsc, compact));
    }
    let b = compact.as_bytes();
    if (6..=17).contains(&b.len()) && b.iter().all(u8::is_ascii_digit) {
        return Some((AccountKind::AccountNumber, compact));
    }
    None
}

/// `classifyBic`: an 8 or 11 character ISO 9362 shape, compacted; none otherwise.
pub fn classify_bic(raw: &str) -> Option<String> {
    let c = compact_upper(raw);
    let b = c.as_bytes();
    let ok = (b.len() == 8 || b.len() == 11)
        && b.iter().take(6).all(|x| upper(*x))
        && b.iter().skip(6).all(|x| alnum(*x));
    ok.then_some(c)
}

// ── zod, as far as these shapes need it ────────────────────────────────────────────────────────────────────────────

/// A JSON object's fields, refusing any key `allowed` does not name when `strict`, and a duplicate key's first value
/// replaced by its last as `JSON.parse` keeps it (`json::parse` already does).
fn object<'a>(v: &'a Json, allowed: &[&str], strict: bool) -> Option<&'a [(String, Json)]> {
    let Json::Object(fields) = v else { return None };
    if strict && fields.iter().any(|(k, _)| !allowed.contains(&k.as_str())) {
        return None;
    }
    Some(fields)
}

fn field<'a>(fields: &'a [(String, Json)], key: &str) -> Option<&'a Json> {
    fields.iter().find(|(k, _)| k == key).map(|(_, v)| v)
}

fn units(s: &str) -> usize {
    s.encode_utf16().count()
}

/// `z.string().trim().min(min).max(max)`: the trimmed string.
fn trimmed(v: &Json, min: usize, max: usize) -> Option<String> {
    let Json::String(s) = v else { return None };
    let t = js_trim(s);
    (units(t) >= min && units(t) <= max).then(|| t.to_owned())
}

/// `z.number().int().min(min).max(max)`.
fn int(v: &Json, min: f64, max: f64) -> Option<i64> {
    let Json::Number(n) = v else { return None };
    #[expect(
        clippy::cast_possible_truncation,
        reason = "a whole number inside the bounds"
    )]
    (n.is_finite() && n.fract() == 0.0 && *n >= min && *n <= max).then_some(*n as i64)
}

fn array(v: &Json) -> Option<&[Json]> {
    match v {
        Json::Array(items) => Some(items),
        _ => None,
    }
}

/// `/^\d+(\.\d{1,18})?$/`.
pub fn is_decimal(s: &str) -> bool {
    let (whole, frac) = match s.split_once('.') {
        Some((w, f)) => (w, Some(f)),
        None => (s, None),
    };
    let digits = |t: &str| !t.is_empty() && t.bytes().all(|b| b.is_ascii_digit());
    digits(whole) && frac.is_none_or(|f| digits(f) && f.len() <= 18)
}

/// `parseJson`: none when blank or not JSON.
fn parse_json(raw: Option<&str>) -> Option<Json> {
    let raw = raw?;
    if js_trim(raw).is_empty() {
        return None;
    }
    json::parse(raw).ok()
}

// ── payee-controls.ts ───────────────────────────────────────────────────────────────────────────────────────────────

/// `PayeeControls`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PayeeControls {
    pub blocked: BTreeSet<String>,
}

/// `parsePayeeControls`: `{ "blockedAccounts": [...] }`, or none.
pub fn payee_controls(raw: Option<&str>) -> Option<PayeeControls> {
    let v = parse_json(raw)?;
    let f = object(&v, &["blockedAccounts"], true)?;
    let list = array(field(f, "blockedAccounts")?)?;
    let blocked = list
        .iter()
        .map(|a| trimmed(a, 1, 64).map(|a| normalize_account(&a)))
        .collect::<Option<BTreeSet<_>>>()?;
    Some(PayeeControls { blocked })
}

/// `ProofLimits`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProofLimits {
    pub allowed_types: Vec<String>,
    pub max_bytes: i64,
}

/// `/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i`.
fn media_type(s: &str) -> bool {
    let part = |t: &str| {
        !t.is_empty()
            && t.bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'+' | b'-'))
    };
    s.split_once('/').is_some_and(|(a, b)| part(a) && part(b))
}

/// `parseProofLimits`: `{ "allowedTypes": [...], "maxBytes": n }`, the types lowercased, or none.
pub fn proof_limits(raw: Option<&str>) -> Option<ProofLimits> {
    let v = parse_json(raw)?;
    let f = object(&v, &["allowedTypes", "maxBytes"], true)?;
    let types = array(field(f, "allowedTypes")?)?;
    let allowed_types = types
        .iter()
        .map(|t| {
            let Json::String(s) = t else { return None };
            let t = js_trim(s);
            media_type(t).then(|| t.to_lowercase())
        })
        .collect::<Option<Vec<_>>>()?;
    if allowed_types.is_empty() {
        return None;
    }
    let max_bytes = int(field(f, "maxBytes")?, 1.0, 25_000_000.0)?;
    Some(ProofLimits {
        allowed_types,
        max_bytes,
    })
}

/// `ExchangeAllowance`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExchangeAllowance {
    pub accounts: BTreeSet<String>,
    /// In the owner's order, as `[...set]` gives them.
    pub account_list: Vec<String>,
    pub window_days: i64,
    /// By asset, uppercased; a repeated asset keeps its last limit, as a `Map` built from the list does.
    pub limits: BTreeMap<String, String>,
}

/// `parseExchangeAllowance`: `{ exchangeAccounts, windowDays, limits: [{ asset, maxAmount }] }`, or none.
pub fn exchange_allowance(raw: Option<&str>) -> Option<ExchangeAllowance> {
    let v = parse_json(raw)?;
    let f = object(&v, &["exchangeAccounts", "windowDays", "limits"], true)?;
    let accounts = array(field(f, "exchangeAccounts")?)?
        .iter()
        .map(|a| trimmed(a, 1, 64))
        .collect::<Option<Vec<_>>>()?;
    let window_days = int(field(f, "windowDays")?, 1.0, 365.0)?;
    let mut limits = Vec::new();
    for item in array(field(f, "limits")?)? {
        let o = object(item, &[], false)?;
        let asset = trimmed(field(o, "asset")?, 2, 16)?;
        let Json::String(max) = field(o, "maxAmount")? else {
            return None;
        };
        if !is_decimal(max) {
            return None;
        }
        limits.push((asset, max.clone()));
    }
    // A limit the ledger cannot read as money makes the whole setting unreadable, never a throw at send time.
    if limits.iter().any(|(_, m)| parse_amount(m).is_err()) {
        return None;
    }
    let mut account_list = Vec::new();
    for a in accounts.iter().map(|a| normalize_account(a)) {
        if !account_list.contains(&a) {
            account_list.push(a);
        }
    }
    Some(ExchangeAllowance {
        accounts: account_list.iter().cloned().collect(),
        account_list,
        window_days,
        limits: limits
            .into_iter()
            .map(|(a, m)| (a.to_uppercase(), m))
            .collect(),
    })
}

// ── send-fields.ts ──────────────────────────────────────────────────────────────────────────────────────────────────

/// One reference rule.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReferenceRule {
    pub delivery_method: String,
    pub country: Option<String>,
    pub max_length: i64,
}

/// `SendFieldRules`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SendFieldRules {
    pub reference: Vec<ReferenceRule>,
    pub purpose_required: Vec<String>,
    pub source_of_funds: Vec<(String, String)>,
}

/// `parseSendFieldRules`: the owner's table, or none when blank, not JSON or not in shape.
pub fn send_field_rules(raw: Option<&str>) -> Option<SendFieldRules> {
    let v = parse_json(raw)?;
    let f = object(&v, &["reference", "purposeRequired", "sourceOfFunds"], true)?;
    let mut reference = Vec::new();
    for item in array(field(f, "reference")?)? {
        let o = object(item, &[], false)?;
        let delivery_method = trimmed(field(o, "deliveryMethod")?, 1, 64)?;
        let country = match field(o, "country") {
            None => None,
            Some(c) => {
                let c = trimmed(c, 0, usize::MAX)?;
                if !(c.len() == 2 && c.bytes().all(|b| b.is_ascii_alphabetic())) {
                    return None;
                }
                Some(c.to_uppercase())
            }
        };
        let max_length = int(field(o, "maxLength")?, 1.0, 200.0)?;
        reference.push(ReferenceRule {
            delivery_method,
            country,
            max_length,
        });
    }
    let purpose_required = array(field(f, "purposeRequired")?)?
        .iter()
        .map(|c| trimmed(c, 2, 8).map(|c| c.to_uppercase()))
        .collect::<Option<Vec<_>>>()?;
    let mut source_of_funds = Vec::new();
    for item in array(field(f, "sourceOfFunds")?)? {
        let o = object(item, &[], false)?;
        let asset = trimmed(field(o, "asset")?, 2, 16)?;
        let Json::String(threshold) = field(o, "threshold")? else {
            return None;
        };
        if !is_decimal(threshold) {
            return None;
        }
        source_of_funds.push((asset, threshold.clone()));
    }
    // A threshold the ledger cannot hold is an unreadable table, not a crash on the first send.
    if source_of_funds
        .iter()
        .any(|(_, t)| parse_amount(t).is_err())
    {
        return None;
    }
    Some(SendFieldRules {
        reference,
        purpose_required,
        source_of_funds: source_of_funds
            .into_iter()
            .map(|(a, t)| (a.to_uppercase(), t))
            .collect(),
    })
}

/// `SendFieldRefusal`: the code, and the reference's limit for `bank.reference_too_long`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FieldRefusal {
    pub code: &'static str,
    pub max_length: Option<i64>,
}

/// `SendFieldContext`.
pub struct FieldContext<'a> {
    pub asset_id: &'a str,
    pub amount: &'a str,
    pub to_currency: &'a str,
    pub country: &'a str,
    pub delivery_method: &'a str,
    pub compliance: &'a [(String, String)],
}

fn refusal(code: &'static str) -> Option<FieldRefusal> {
    Some(FieldRefusal {
        code,
        max_length: None,
    })
}

/// `checkSendFields`: the first thing wrong with the three fields, or none when they meet the owner's table.
pub fn check_send_fields(
    rules: Option<&SendFieldRules>,
    ctx: &FieldContext<'_>,
) -> Option<FieldRefusal> {
    let Some(rules) = rules else {
        return refusal("bank.send_field_rules_unset");
    };
    let get = |k: &str| {
        ctx.compliance
            .iter()
            .find(|(key, _)| key == k)
            .map_or("", |(_, v)| js_trim(v))
    };
    let reference = get("reference");
    if !reference.is_empty() {
        let rule = rules
            .reference
            .iter()
            .find(|r| {
                r.delivery_method == ctx.delivery_method
                    && r.country.as_deref() == Some(ctx.country)
            })
            .or_else(|| {
                rules
                    .reference
                    .iter()
                    .find(|r| r.delivery_method == ctx.delivery_method && r.country.is_none())
            });
        let Some(rule) = rule else {
            return refusal("bank.reference_rules_unset");
        };
        if i64::try_from(units(reference)).unwrap_or(i64::MAX) > rule.max_length {
            return Some(FieldRefusal {
                code: "bank.reference_too_long",
                max_length: Some(rule.max_length),
            });
        }
    }
    if rules.purpose_required.iter().any(|c| c == ctx.to_currency) && get("purpose").is_empty() {
        return refusal("bank.send_purpose_required");
    }
    let asset = ctx.asset_id.to_uppercase();
    if let Some((_, threshold)) = rules.source_of_funds.iter().find(|(a, _)| *a == asset)
        && get("sourceOfFunds").is_empty()
    {
        let over = |a: &str, t: &str| -> Option<bool> {
            Some(parse_amount(a).ok()? > parse_amount(t).ok()?)
        };
        if over(ctx.amount, threshold) == Some(true) {
            return refusal("bank.source_of_funds_required");
        }
    }
    None
}

/// `parseAmount` for a value already checked as a decimal.
pub fn amount(s: &str) -> Option<Amount> {
    parse_amount(s).ok()
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test")]
    use super::*;

    #[test]
    fn account_shapes_are_the_typescripts() {
        // account-format.test.ts
        assert_eq!(
            classify_account("GB82 WEST 1234 5698 7654 32"),
            Some((AccountKind::Iban, "GB82WEST12345698765432".to_owned()))
        );
        assert_eq!(classify_account("GB82WEST12345698765433"), None);
        assert_eq!(
            classify_account("sbin0001234"),
            Some((AccountKind::Ifsc, "SBIN0001234".to_owned()))
        );
        assert_eq!(
            classify_account("123456"),
            Some((AccountKind::AccountNumber, "123456".to_owned()))
        );
        assert_eq!(classify_account("12345"), None);
        assert_eq!(classify_account("not-an-account"), None);
        assert_eq!(classify_bic("deut de ff"), Some("DEUTDEFF".to_owned()));
        assert_eq!(classify_bic("COBADEFFXXX"), Some("COBADEFFXXX".to_owned()));
        assert_eq!(classify_bic("COBADEFFXXXX"), None);
        assert_eq!(classify_bic("1OBADEFF"), None);
    }

    #[test]
    fn owner_values_read_as_unset_unless_in_shape() {
        assert_eq!(payee_controls(None), None);
        assert_eq!(
            payee_controls(Some("{\"blockedAccounts\":[]}"))
                .unwrap()
                .blocked
                .len(),
            0
        );
        assert!(payee_controls(Some("{\"blockedAccounts\":[\"x\"],\"more\":1}")).is_none());
        assert_eq!(
            payee_controls(Some("{\"blockedAccounts\":[\"1234 56789\"]}"))
                .unwrap()
                .blocked,
            ["123456789".to_owned()].into()
        );
        assert_eq!(
            proof_limits(Some(
                "{\"allowedTypes\":[\"Application/PDF\"],\"maxBytes\":64}"
            )),
            Some(ProofLimits {
                allowed_types: vec!["application/pdf".to_owned()],
                max_bytes: 64
            })
        );
        assert!(proof_limits(Some("{\"allowedTypes\":[],\"maxBytes\":64}")).is_none());
        assert!(proof_limits(Some("{\"allowedTypes\":[\"pdf\"],\"maxBytes\":64}")).is_none());
        assert!(
            exchange_allowance(Some(
                "{\"exchangeAccounts\":[],\"windowDays\":30,\"limits\":[]}"
            ))
            .is_some()
        );
        assert!(
            exchange_allowance(Some(
                "{\"exchangeAccounts\":[],\"windowDays\":0,\"limits\":[]}"
            ))
            .is_none()
        );
        assert!(send_field_rules(Some("{\"reference\": \"x\"}")).is_none());
        assert!(
            send_field_rules(Some(
                "{\"reference\":[],\"purposeRequired\":[],\"sourceOfFunds\":[]}"
            ))
            .is_some()
        );
    }
}
