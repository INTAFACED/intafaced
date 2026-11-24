//! The Academy's own refines: the `.refine(...)` checks its TypeScript schemas carry (`packages/contracts/src/academy-*.ts`),
//! by the name `scripts/record-door.mjs` gives each in `door/schemas.json`. Each takes the value zod hands a refine (the
//! part's parsed output) and answers as the TypeScript function does: pass, fail, or throw (only `levels_ascend` can,
//! when a level is not an integer `BigInt` reads, with V8's message).

use service_kit::schema::{Refiner, Value};

/// `ACADEMY_BUILTIN_ROLES`.
pub const BUILTIN_ROLES: [&str; 9] = [
    "admin",
    "instructor",
    "author",
    "staff",
    "limited_staff",
    "data_researcher",
    "discussion_admin",
    "moderator",
    "community_ta",
];

/// `ACADEMY_DISCUSSION_GENERAL_TOPIC`.
pub const GENERAL_TOPIC: &str = "general";

/// Every refine the schemas name.
pub const NAMES: [&str; 21] = [
    "grant_or_public_id",
    "not_builtin_role",
    "pricing_holds",
    "has_nonzero_digit",
    "link_has_url",
    "unique_question_ids",
    "graded_has_keys",
    "only_survey_anonymous",
    "after_last_needs_limit",
    "unique_choice_ids",
    "single_key_is_choice",
    "multi_keys_are_choices",
    "partial_credit_splits",
    "not_negative",
    "text_or_file",
    "levels_ascend",
    "unique_topic_ids",
    "unique_course_slugs",
    "not_general_topic",
    "only_delayed_has_delay",
    "course_or_certificate",
];

pub struct AcademyRefines;

/// `new Set(values).size === values.length`, for the strings, numbers and booleans these hold (an object is never equal
/// to another).
fn unique(values: &[&Value]) -> bool {
    values.iter().enumerate().all(|(i, a)| {
        values
            .iter()
            .skip(i + 1)
            .all(|b| !matches!((a, b), (Value::Array(_) | Value::Object(_), _)) && a != b)
    })
}

fn is_null(v: &Value) -> bool {
    *v == Value::Null
}

fn is(v: &Value, s: &str) -> bool {
    v.as_str() == Some(s)
}

/// `TypeError: Cannot read properties of ...` when a refine reaches into what is not there.
fn items<'a>(v: &'a Value, key: &str) -> Result<&'a [Value], String> {
    match v.get(key) {
        Value::Array(a) => Ok(a),
        Value::Undefined => Err(format!(
            "Cannot read properties of undefined (reading '{key}')"
        )),
        _ => Err(format!("{key}.map is not a function")),
    }
}

/// `questionHasKey`.
fn question_has_key(q: &Value) -> bool {
    let kind = q.get("kind");
    if is(kind, "essay") {
        return true;
    }
    if is(kind, "single") {
        return !is_null(q.get("correctChoiceId"));
    }
    if is(kind, "multi") {
        return !is_null(q.get("correctChoiceIds"));
    }
    !is_null(q.get("answer"))
}

/// A signed integer as `BigInt` holds it: a sign and base-1e9 limbs, least significant first.
#[derive(Clone, PartialEq, Eq)]
struct Big {
    negative: bool,
    limbs: Vec<u32>,
}

const BASE: u64 = 1_000_000_000;

impl Big {
    fn zero() -> Big {
        Big {
            negative: false,
            limbs: Vec::new(),
        }
    }

    fn trim(mut self) -> Big {
        while self.limbs.last() == Some(&0) {
            self.limbs.pop();
        }
        if self.limbs.is_empty() {
            self.negative = false;
        }
        self
    }

    /// `|self| * m + a`, sign kept.
    fn mul_add(mut self, m: u32, a: u32) -> Big {
        let mut carry = u64::from(a);
        for limb in &mut self.limbs {
            let x = u64::from(*limb) * u64::from(m) + carry;
            *limb = u32::try_from(x % BASE).unwrap_or(0);
            carry = x / BASE;
        }
        while carry > 0 {
            self.limbs.push(u32::try_from(carry % BASE).unwrap_or(0));
            carry /= BASE;
        }
        self.trim()
    }

    fn cmp_abs(&self, other: &Big) -> std::cmp::Ordering {
        self.limbs
            .len()
            .cmp(&other.limbs.len())
            .then_with(|| self.limbs.iter().rev().cmp(other.limbs.iter().rev()))
    }

    fn add(self, other: Big) -> Big {
        use std::cmp::Ordering;
        if self.negative == other.negative {
            let mut out = Vec::new();
            let mut carry = 0u64;
            for i in 0..self.limbs.len().max(other.limbs.len()) {
                let x = u64::from(self.limbs.get(i).copied().unwrap_or(0))
                    + u64::from(other.limbs.get(i).copied().unwrap_or(0))
                    + carry;
                out.push(u32::try_from(x % BASE).unwrap_or(0));
                carry = x / BASE;
            }
            if carry > 0 {
                out.push(u32::try_from(carry).unwrap_or(0));
            }
            return Big {
                negative: self.negative,
                limbs: out,
            }
            .trim();
        }
        let (big, small) = match self.cmp_abs(&other) {
            Ordering::Less => (other, self),
            _ => (self, other),
        };
        let mut out = Vec::new();
        let mut borrow = 0i64;
        for i in 0..big.limbs.len() {
            let mut x = i64::from(big.limbs.get(i).copied().unwrap_or(0))
                - i64::from(small.limbs.get(i).copied().unwrap_or(0))
                - borrow;
            borrow = 0;
            if x < 0 {
                x += i64::try_from(BASE).unwrap_or(0);
                borrow = 1;
            }
            out.push(u32::try_from(x).unwrap_or(0));
        }
        Big {
            negative: big.negative,
            limbs: out,
        }
        .trim()
    }

    fn cmp(&self, other: &Big) -> std::cmp::Ordering {
        use std::cmp::Ordering;
        match (self.negative, other.negative) {
            (false, true) => Ordering::Greater,
            (true, false) => Ordering::Less,
            (false, false) => self.cmp_abs(other),
            (true, true) => other.cmp_abs(self),
        }
    }
}

/// `BigInt(text)`: ECMAScript's StringToBigInt, or V8's SyntaxError message.
fn bigint(text: &str) -> Result<Big, String> {
    let fail = || format!("Cannot convert {text} to a BigInt");
    let s = service_kit::schema::js_trim(text);
    if s.is_empty() {
        return Ok(Big::zero());
    }
    let lower = s.get(..2).map(str::to_ascii_lowercase);
    let (radix, digits, negative) = match lower.as_deref() {
        Some("0x") => (16, s.get(2..).unwrap_or(""), false),
        Some("0o") => (8, s.get(2..).unwrap_or(""), false),
        Some("0b") => (2, s.get(2..).unwrap_or(""), false),
        _ => match s.strip_prefix('-') {
            Some(rest) => (10, rest, true),
            None => (10, s.strip_prefix('+').unwrap_or(s), false),
        },
    };
    if digits.is_empty() {
        return Err(fail());
    }
    let mut n = Big::zero();
    for c in digits.chars() {
        let d = c.to_digit(radix).ok_or_else(fail)?;
        n = n.mul_add(radix, d);
    }
    n.negative = negative;
    Ok(n.trim())
}

/// `levelHundredths`: `BigInt(whole) * 100n + BigInt(`${fraction}00`.slice(0, 2))`.
fn hundredths(level: &str) -> Result<Big, String> {
    let mut parts = level.split('.');
    let whole = parts.next().unwrap_or("");
    let fraction = parts.next().unwrap_or("");
    let w = bigint(whole)?;
    let padded = format!("{fraction}00");
    let two = String::from_utf16_lossy(&padded.encode_utf16().take(2).collect::<Vec<u16>>());
    let f = bigint(&two)?;
    let negative = w.negative;
    let scaled = Big {
        negative,
        limbs: w.limbs,
    }
    .mul_add(100, 0);
    Ok(Big { negative, ..scaled }.trim().add(f))
}

/// `ascending(levels)`: each level above the one before, compared as exact decimals.
fn ascending(levels: &[Value]) -> Result<bool, String> {
    for pair in levels.windows(2) {
        let [a, b] = pair else { continue };
        let a = hundredths(&a.js_string())?;
        let b = hundredths(&b.js_string())?;
        if a.cmp(&b) != std::cmp::Ordering::Less {
            return Ok(false);
        }
    }
    Ok(true)
}

impl Refiner for AcademyRefines {
    fn refine(&self, id: &str, v: &Value) -> Result<bool, String> {
        Ok(match id {
            "grant_or_public_id" => {
                u8::from(v.get("grantId").truthy()) + u8::from(v.get("publicId").truthy()) == 1
            }
            "not_builtin_role" => !v.as_str().is_some_and(|n| BUILTIN_ROLES.contains(&n)),
            "pricing_holds" => {
                let price_null = is_null(v.get("price"));
                (price_null == is_null(v.get("priceAsset")))
                    && (is(v.get("pricing"), "paid") || price_null)
            }
            "has_nonzero_digit" => v.js_string().chars().any(|c| ('1'..='9').contains(&c)),
            "link_has_url" => is(v.get("kind"), "link") == !is_null(v.get("url")),
            "unique_question_ids" => {
                let qs = items(v, "questions")?;
                unique(&qs.iter().map(|q| q.get("id")).collect::<Vec<_>>())
            }
            "graded_has_keys" => {
                is(v.get("kind"), "survey") || items(v, "questions")?.iter().all(question_has_key)
            }
            "only_survey_anonymous" => is(v.get("kind"), "survey") || !v.get("anonymous").truthy(),
            "after_last_needs_limit" => {
                !is(v.get("resultsVisibility"), "after_last_attempt")
                    || !is_null(v.get("attemptLimit"))
            }
            "unique_choice_ids" => {
                !v.has("choices") || {
                    let cs = items(v, "choices")?;
                    unique(&cs.iter().map(|c| c.get("id")).collect::<Vec<_>>())
                }
            }
            "single_key_is_choice" => {
                let key = v.get("correctChoiceId");
                !is(v.get("kind"), "single")
                    || is_null(key)
                    || items(v, "choices")?.iter().any(|c| c.get("id") == key)
            }
            "multi_keys_are_choices" => {
                !is(v.get("kind"), "multi") || is_null(v.get("correctChoiceIds")) || {
                    let keys = items(v, "correctChoiceIds")?;
                    let choices = items(v, "choices")?;
                    unique(&keys.iter().collect::<Vec<_>>())
                        && keys
                            .iter()
                            .all(|k| choices.iter().any(|c| c.get("id") == k))
                }
            }
            "partial_credit_splits" => {
                !is(v.get("kind"), "multi")
                    || !v.get("partialCredit").truthy()
                    || is_null(v.get("correctChoiceIds"))
                    || {
                        let n = items(v, "correctChoiceIds")?.len();
                        // `points` is a safe integer here: its int check aborts first otherwise.
                        let points = v.get("points").as_number().unwrap_or(f64::NAN);
                        let whole = format!("{points}").parse::<i64>().ok();
                        match (whole, i64::try_from(n)) {
                            (Some(p), Ok(n)) if n > 0 => p % n == 0,
                            _ => false,
                        }
                    }
            }
            "not_negative" => !v.js_string().starts_with('-'),
            "text_or_file" => !is(v.get("text"), "off") || !is(v.get("file"), "off"),
            "levels_ascend" => ascending(items(v, "levels")?)?,
            "unique_topic_ids" => unique(&items(v, "topicIds")?.iter().collect::<Vec<_>>()),
            "unique_course_slugs" => unique(&items(v, "courseSlugs")?.iter().collect::<Vec<_>>()),
            "not_general_topic" => !is(v, GENERAL_TOPIC),
            "only_delayed_has_delay" => {
                is(v.get("mode"), "delayed") || is_null(v.get("delayMinutes"))
            }
            "course_or_certificate" => !(v.get("course").truthy() && v.get("certificate").truthy()),
            other => return Err(format!("svc-academy: no refine named {other}")),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_levels_as_bigint_does() {
        let lv = |xs: &[&str]| {
            ascending(
                &xs.iter()
                    .map(|s| Value::String((*s).to_owned()))
                    .collect::<Vec<_>>(),
            )
        };
        assert_eq!(lv(&["0", "1.5", "2"]), Ok(true));
        assert_eq!(lv(&["1.5", "1.50"]), Ok(false));
        assert_eq!(lv(&["0x10", "17"]), Ok(true));
        assert_eq!(lv(&["-1", "0"]), Ok(true));
        assert_eq!(
            lv(&["1", "😀"]),
            Err("Cannot convert 😀 to a BigInt".to_owned())
        );
    }
}
