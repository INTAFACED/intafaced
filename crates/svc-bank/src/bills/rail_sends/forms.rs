//! Each bank rail's recipient form and its checks (`rail-sends.ts`: `BANK_RAILS`, `RAIL_FORMS`, `isAbaRouting`,
//! `checkRecipient`, `maskRecipient`; `withdraw-destination.ts`: `isIbanRef`). A form that passes proves nothing about
//! the account: these are format checks only.
//!
//! The strings are read as JavaScript reads them: `trim` and `\s` are ECMAScript's whitespace, `\p{Cc}` is U+0000 to
//! U+001F and U+007F to U+009F, a length in a `u`-flag pattern counts code points, and `slice` counts UTF-16 units.

use service_kit::json::Json;
use service_kit::money::js_trim;
use service_kit::schema::Value;

use crate::errors::Refusal;
use crate::partner::refuse;

/// `BANK_RAILS`, in their order.
pub const BANK_RAILS: [&str; 5] = ["ach", "wire", "instant", "sepa", "proxy"];

/// One field of a rail's form (`RailField`).
pub struct RailField {
    pub name: &'static str,
    pub required: bool,
    /// The values a choice field takes; none for a typed field.
    pub choices: Option<&'static [&'static str]>,
}

const fn text(name: &'static str) -> RailField {
    RailField {
        name,
        required: true,
        choices: None,
    }
}

const fn choice(name: &'static str, choices: &'static [&'static str]) -> RailField {
    RailField {
        name,
        required: true,
        choices: Some(choices),
    }
}

const ACH: [RailField; 4] = [
    text("holderName"),
    text("routingNumber"),
    text("accountNumber"),
    choice("accountType", &["checking", "savings"]),
];
const WIRE: [RailField; 4] = [
    text("holderName"),
    text("routingNumber"),
    text("accountNumber"),
    text("bankName"),
];
const INSTANT: [RailField; 3] = [
    text("holderName"),
    text("routingNumber"),
    text("accountNumber"),
];
const SEPA: [RailField; 4] = [
    text("holderName"),
    text("iban"),
    RailField {
        name: "bic",
        required: false,
        choices: None,
    },
    choice("transferType", &["standard", "instant"]),
];
const PROXY: [RailField; 2] = [choice("aliasType", &["phone", "email"]), text("alias")];

/// `RAIL_FORMS[rail]`: the rail's form in the order it is filled; none for a name that is no rail.
pub fn form(rail: &str) -> Option<&'static [RailField]> {
    Some(match rail {
        "ach" => &ACH,
        "wire" => &WIRE,
        "instant" => &INSTANT,
        "sepa" => &SEPA,
        "proxy" => &PROXY,
        _ => return None,
    })
}

/// `RailSendService.requirements`: each rail's form and who carries it (no one in this build).
pub fn requirements() -> Json {
    Json::Array(
        BANK_RAILS
            .iter()
            .map(|rail| {
                let fields = form(rail).unwrap_or_default().iter().map(|f| {
                    Json::obj([
                        ("name", Json::str(f.name)),
                        ("required", Json::Bool(f.required)),
                        (
                            "choices",
                            f.choices.map_or(Json::Null, |c| {
                                Json::Array(c.iter().map(|v| Json::str(*v)).collect())
                            }),
                        ),
                    ])
                });
                Json::obj([
                    ("rail", Json::str(*rail)),
                    ("fields", Json::Array(fields.collect())),
                    ("partner", Json::Null),
                    ("blocker", Json::str("rail.bank")),
                ])
            })
            .collect(),
    )
}

/// A recipient as its rail's form keeps it: field name and value, in the form's order.
pub type Recipient = Vec<(String, String)>;

/// The value of `name` in a recipient, as `recipient[name]` reads it.
pub fn field<'r>(r: &'r [(String, String)], name: &str) -> Option<&'r str> {
    r.iter()
        .rev()
        .find(|(k, _)| k == name)
        .map(|(_, v)| v.as_str())
}

fn set(r: &mut Recipient, name: &str, value: String) {
    if let Some(slot) = r.iter_mut().find(|(k, _)| k == name) {
        slot.1 = value;
    } else {
        r.push((name.to_owned(), value));
    }
}

pub fn invalid(message: impl Into<String>) -> Refusal {
    refuse("bank.rail_send_invalid", message)
}

/// JavaScript's `\s`.
pub fn js_space(c: char) -> bool {
    u16::try_from(u32::from(c)).is_ok_and(service_kit::jsregex::is_js_space)
}

/// `\p{Cc}`.
pub fn control(c: char) -> bool {
    c <= '\u{1f}' || ('\u{7f}'..='\u{9f}').contains(&c)
}

/// `/^[^\p{Cc}]{1,max}$/u`.
pub fn plain_text(s: &str, max: usize) -> bool {
    let n = s.chars().count();
    (1..=max).contains(&n) && !s.chars().any(control)
}

/// `EMAIL_RE`: `/^[^\s@\p{Cc}]{1,64}@[^\s@\p{Cc}]{1,190}\.[^\s@\p{Cc}]{2,63}$/u`.
pub fn is_email(s: &str) -> bool {
    let ok = |c: &char| !js_space(*c) && *c != '@' && !control(*c);
    let Some((local, domain)) = s.split_once('@') else {
        return false;
    };
    let local: Vec<char> = local.chars().collect();
    let domain: Vec<char> = domain.chars().collect();
    if !(1..=64).contains(&local.len()) || !local.iter().all(ok) || !domain.iter().all(ok) {
        return false;
    }
    // Some dot splits the domain into 1 to 190 characters before it and 2 to 63 after it.
    domain.iter().enumerate().any(|(i, c)| {
        *c == '.' && (1..=190).contains(&i) && (2..=63).contains(&(domain.len() - i - 1))
    })
}

fn digits(s: &str) -> bool {
    s.bytes().all(|b| b.is_ascii_digit())
}

/// `isAbaRouting`: nine digits, a Federal Reserve prefix (01-12, 21-32, 61-72, 80; 00 is the US government's), and a
/// weighted sum (3, 7, 1 repeating) that is a multiple of ten.
pub fn is_aba_routing(value: &str) -> bool {
    if value.len() != 9 || !digits(value) || value.bytes().all(|b| b == b'0') {
        return false;
    }
    let d: Vec<u32> = value.bytes().map(|b| u32::from(b - b'0')).collect();
    let prefix = d.first().copied().unwrap_or(0) * 10 + d.get(1).copied().unwrap_or(0);
    if !(prefix <= 12 || (21..=32).contains(&prefix) || (61..=72).contains(&prefix) || prefix == 80)
    {
        return false;
    }
    let at = |i: usize| d.get(i).copied().unwrap_or(0);
    let sum = 3 * (at(0) + at(3) + at(6)) + 7 * (at(1) + at(4) + at(7)) + (at(2) + at(5) + at(8));
    sum % 10 == 0
}

/// `isIbanRef`: an IBAN's shape (two letters, two digits, letters and digits; 15 to 34 long) and its mod-97.
pub fn is_iban_ref(r: &str) -> bool {
    let compact: String = r
        .chars()
        .filter(|c| !js_space(*c))
        .collect::<String>()
        .to_uppercase();
    let b = compact.as_bytes();
    let shaped = b.len() > 4
        && b.iter().take(2).all(u8::is_ascii_uppercase)
        && b.iter().skip(2).take(2).all(u8::is_ascii_digit)
        && b.iter()
            .skip(4)
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit());
    if !shaped || !(15..=34).contains(&b.len()) {
        return false;
    }
    let mut remainder: u32 = 0;
    for c in b.iter().skip(4).chain(b.iter().take(4)) {
        let expanded = if c.is_ascii_uppercase() {
            (u32::from(*c) - 55).to_string()
        } else {
            char::from(*c).to_string()
        };
        for d in expanded.bytes() {
            remainder = (remainder * 10 + u32::from(d - b'0')) % 97;
        }
    }
    remainder == 1
}

fn is_bic(s: &str) -> bool {
    let b = s.as_bytes();
    let alnum = |c: &u8| c.is_ascii_uppercase() || c.is_ascii_digit();
    (b.len() == 8 || b.len() == 11)
        && b.iter().take(6).all(u8::is_ascii_uppercase)
        && b.iter().skip(6).all(alnum)
}

fn is_phone(s: &str) -> bool {
    let b = s.as_bytes();
    b.first() == Some(&b'+')
        && b.get(1).is_some_and(|c| (b'1'..=b'9').contains(c))
        && (8..=16).contains(&b.len())
        && digits(s.get(1..).unwrap_or_default())
}

fn strip(s: &str, gone: impl Fn(char) -> bool) -> String {
    s.chars().filter(|c| !gone(*c)).collect()
}

/// `Object.keys(given)`: integer-like keys first, ascending, then the rest in the order first given.
fn js_keys(given: &[(String, Value)]) -> Vec<&str> {
    let mut keys: Vec<&str> = Vec::new();
    for (k, _) in given {
        if !keys.contains(&k.as_str()) {
            keys.push(k);
        }
    }
    let index = |k: &str| -> Option<u64> {
        let n: u64 = k.parse().ok()?;
        (n.to_string() == k && n < u64::from(u32::MAX)).then_some(n)
    };
    let mut ints: Vec<(u64, &str)> = keys
        .iter()
        .filter_map(|k| index(k).map(|n| (n, *k)))
        .collect();
    ints.sort_unstable();
    let mut out: Vec<&str> = ints.into_iter().map(|(_, k)| k).collect();
    out.extend(keys.iter().filter(|k| index(k).is_none()));
    out
}

/// `checkRecipient`: the recipient as the rail's form takes it, normalised, or a refusal naming the first field it
/// refuses. `given` is the asked object (field name and value).
pub fn check_recipient(rail: &str, given: &[(String, Value)]) -> Result<Recipient, Refusal> {
    let Some(form) = form(rail) else {
        return Err(Refusal::Other(format!("no rail {rail}")));
    };
    for name in js_keys(given) {
        if !form.iter().any(|f| f.name == name) {
            return Err(invalid(format!("The {rail} form has no field {name}")));
        }
    }
    let asked = |name: &str| -> String {
        given
            .iter()
            .rev()
            .find(|(k, _)| k == name)
            .and_then(|(_, v)| v.as_str())
            .unwrap_or_default()
            .to_owned()
    };
    let mut out: Recipient = Vec::new();
    for f in form {
        let raw = js_trim(&asked(f.name)).to_owned();
        if raw.is_empty() {
            if f.required {
                return Err(invalid(format!("Fill in {}", f.name)));
            }
            continue;
        }
        if let Some(choices) = f.choices
            && !choices.contains(&raw.as_str())
        {
            return Err(invalid(format!(
                "Choose {}: {}",
                f.name,
                choices.join(" or ")
            )));
        }
        out.push((f.name.to_owned(), raw));
    }
    let get = |out: &Recipient, name: &str| field(out, name).unwrap_or_default().to_owned();
    if field(&out, "holderName").is_some() && !plain_text(&get(&out, "holderName"), 140) {
        return Err(invalid("The holder name is up to 140 characters"));
    }
    if field(&out, "bankName").is_some() && !plain_text(&get(&out, "bankName"), 140) {
        return Err(invalid("The bank name is up to 140 characters"));
    }
    if field(&out, "routingNumber").is_some() {
        let v = strip(&get(&out, "routingNumber"), |c| js_space(c) || c == '-');
        set(&mut out, "routingNumber", v.clone());
        if !is_aba_routing(&v) {
            return Err(invalid(
                "The routing number is nine digits with a valid check digit",
            ));
        }
    }
    if field(&out, "accountNumber").is_some() {
        let v = strip(&get(&out, "accountNumber"), |c| js_space(c) || c == '-');
        set(&mut out, "accountNumber", v.clone());
        if !((4..=17).contains(&v.len()) && digits(&v)) {
            return Err(invalid("The account number is 4 to 17 digits"));
        }
    }
    if field(&out, "iban").is_some() {
        let v = strip(&get(&out, "iban"), js_space).to_uppercase();
        set(&mut out, "iban", v.clone());
        if !is_iban_ref(&v) {
            return Err(invalid("The IBAN does not check out"));
        }
    }
    if field(&out, "bic").is_some() {
        let v = strip(&get(&out, "bic"), js_space).to_uppercase();
        set(&mut out, "bic", v.clone());
        if !is_bic(&v) {
            return Err(invalid("The BIC is 8 or 11 letters and digits"));
        }
    }
    if rail == "proxy" {
        if get(&out, "aliasType") == "phone" {
            let v = strip(&get(&out, "alias"), |c| {
                js_space(c) || matches!(c, '(' | ')' | '-')
            });
            set(&mut out, "alias", v.clone());
            if !is_phone(&v) {
                return Err(invalid(
                    "The phone number starts with + and the country code",
                ));
            }
        } else {
            let v = get(&out, "alias").to_lowercase();
            set(&mut out, "alias", v.clone());
            if !is_email(&v) {
                return Err(invalid("The email address does not look right"));
            }
        }
    }
    Ok(out)
}

/// A kept recipient (strings only) as `checkRecipient` takes it again.
pub fn as_given(r: &[(String, String)]) -> Vec<(String, Value)> {
    r.iter()
        .map(|(k, v)| (k.clone(), Value::String(v.clone())))
        .collect()
}

/// `String.prototype.slice` on UTF-16 units, from `start` (negative counts from the end) to the end.
fn js_slice(s: &str, start: i64, end: Option<i64>) -> String {
    let units: Vec<u16> = s.encode_utf16().collect();
    let len = i64::try_from(units.len()).unwrap_or(i64::MAX);
    let clamp = |i: i64| -> usize {
        let i = if i < 0 { (len + i).max(0) } else { i.min(len) };
        usize::try_from(i).unwrap_or(0)
    };
    let (from, to) = (clamp(start), clamp(end.unwrap_or(len)));
    String::from_utf16_lossy(units.get(from..to.max(from)).unwrap_or_default())
}

/// `maskRecipient`: the recipient as a list row shows it, never the full account.
pub fn mask_recipient(rail: &str, r: &[(String, String)]) -> String {
    if rail == "proxy" {
        let alias = field(r, "alias").unwrap_or_default();
        let alias_type = field(r, "aliasType");
        let shown = if alias_type == Some("email") {
            // `alias.indexOf('@')` in UTF-16 units; -1 when absent, as `slice(-1)` then reads.
            let at = alias.find('@').map_or(-1, |byte| {
                i64::try_from(alias.get(..byte).unwrap_or_default().encode_utf16().count())
                    .unwrap_or(0)
            });
            format!(
                "{}…{}",
                js_slice(alias, 0, Some(1)),
                js_slice(alias, at, None)
            )
        } else {
            format!("…{}", js_slice(alias, -4, None))
        };
        return format!("{} {shown}", alias_type.unwrap_or_default());
    }
    let account = field(r, "iban")
        .or_else(|| field(r, "accountNumber"))
        .unwrap_or_default();
    format!(
        "{} · …{}",
        field(r, "holderName").unwrap_or_default(),
        js_slice(account, -4, None)
    )
}

/// `canonical`: key order does not change a recipient.
pub fn canonical(r: &[(String, String)]) -> Vec<(String, String)> {
    let mut v = r.to_vec();
    // JavaScript's sort compares UTF-16 units; the form's field names are ASCII, where that is byte order.
    v.sort_by(|a, b| a.0.encode_utf16().cmp(b.0.encode_utf16()));
    v
}

/// A recipient as the jsonb column takes it.
pub fn to_json(r: &[(String, String)]) -> Json {
    Json::Object(
        r.iter()
            .map(|(k, v)| (k.clone(), Json::str(v.clone())))
            .collect(),
    )
}

/// A recipient read back from its jsonb column.
pub fn from_json_text(text: &str) -> Result<Recipient, Refusal> {
    match service_kit::json::parse(text) {
        Ok(Json::Object(o)) => Ok(o
            .into_iter()
            .map(|(k, v)| {
                let s = match v {
                    Json::String(s) => s,
                    other => other.compact(),
                };
                (k, s)
            })
            .collect()),
        _ => Err(Refusal::Other(format!(
            "recipient is not an object: {text}"
        ))),
    }
}

/// `destinationKey`: who the money reaches, the account (or alias) without the name, so a new holder name is the same
/// destination. ACH, a wire and a real-time payment reach the same US account: one destination, one window.
pub fn destination_key(rail: &str, r: &[(String, String)]) -> String {
    let f = |k: &str| field(r, k).unwrap_or("undefined");
    match rail {
        "sepa" => format!("iban:{}", f("iban")),
        "proxy" => format!("{}:{}", f("aliasType"), f("alias")),
        _ => format!("aba:{}:{}", f("routingNumber"), f("accountNumber")),
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test")]
    use super::*;

    #[test]
    fn routing_numbers_need_a_reserve_prefix_and_the_check_digit() {
        assert!(is_aba_routing("021000021"));
        assert!(!is_aba_routing("021000022"));
        assert!(!is_aba_routing("500000005"));
        assert!(!is_aba_routing("000000000"));
    }

    #[test]
    fn an_iban_checks_its_mod_97() {
        assert!(is_iban_ref("DE89 3704 0044 0532 0130 00"));
        assert!(!is_iban_ref("DE89370400440532013001"));
        assert!(is_iban_ref("FR1420041010050500013M02606"));
    }

    #[test]
    fn emails_split_on_some_dot() {
        assert!(is_email("ada.test@example.com"));
        assert!(!is_email("nobody"));
        assert!(!is_email("a@b.c"));
        assert!(is_email("a@b.c.de"));
    }

    #[test]
    fn integer_keys_come_first_as_object_keys_reads_them() {
        let given = vec![
            ("b".to_owned(), Value::Null),
            ("2".to_owned(), Value::Null),
            ("1".to_owned(), Value::Null),
        ];
        assert_eq!(js_keys(&given), vec!["1", "2", "b"]);
    }

    #[test]
    fn masks_never_show_the_account() {
        let r = vec![
            ("aliasType".to_owned(), "email".to_owned()),
            ("alias".to_owned(), "ada.test@example.com".to_owned()),
        ];
        assert_eq!(mask_recipient("proxy", &r), "email a…@example.com");
    }
}
