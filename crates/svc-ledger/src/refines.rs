//! The ledger's own checks inside its input schemas, by the names `scripts/record-door.mjs` gives them in
//! `door/schemas.json`: the account owner's identifier space (`accountRefSchema`'s `superRefine`, from
//! `@intafaced/ledger-client`'s `isValidOwnerId`), the operator desk's list query (`operator-desk.ts`), and an account metadata delete's revision
//! (`operator-account-metadata.ts`).

use service_kit::json::Json;
use service_kit::schema::{Refiner, Value};

/// `UUID_OWNER_ID_PATTERN`: a lowercase canonical UUID.
pub fn is_uuid_owner_id(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| {
            if matches!(i, 8 | 13 | 18 | 23) {
                *c == b'-'
            } else {
                c.is_ascii_digit() || (b'a'..=b'f').contains(c)
            }
        })
}

/// `PLATFORM_OWNER_ID_PATTERN`: `^[a-z][a-z0-9_-]*(:[A-Za-z0-9._-]+)*$`.
pub fn is_platform_owner_id(s: &str) -> bool {
    let mut parts = s.split(':');
    let head = parts.next().unwrap_or("");
    let mut hb = head.bytes();
    hb.next().is_some_and(|c| c.is_ascii_lowercase())
        && hb.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_' || c == b'-')
        && parts.all(|p| {
            !p.is_empty()
                && p.bytes()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-'))
        })
}

/// `UUID_OWNER_TYPES`: owners whose id is a person's (or sub-identity's) UUID.
const UUID_OWNER_TYPES: [&str; 2] = ["user", "subaccount"];

/// `isValidOwnerId(ownerType, ownerId)`.
pub fn is_valid_owner_id(owner_type: &str, owner_id: &str) -> bool {
    if UUID_OWNER_TYPES.contains(&owner_type) {
        is_uuid_owner_id(owner_id)
    } else {
        is_platform_owner_id(owner_id) && !is_uuid_owner_id(owner_id)
    }
}

/// `describeOwnerIdSpace(ownerType)`.
pub fn describe_owner_id_space(owner_type: &str) -> &'static str {
    if UUID_OWNER_TYPES.contains(&owner_type) {
        "a lowercase canonical UUID (identity.users.id / identity.sub_accounts.id)"
    } else {
        "a namespaced platform slug starting with a lowercase letter, e.g. \"fees:trade\" or \"rail:card-sandbox\""
    }
}

/// `INT8_MAX`: the largest sequence the ledger can hold.
const INT8_MAX: u64 = 9_223_372_036_854_775_807;

/// `BigInt(text) <= max`, or none where `BigInt` throws: JavaScript's whitespace trimmed, blank is 0, `0x`/`0o`/`0b`
/// digits, or decimal digits with one optional sign.
fn js_bigint_at_most(text: &str, max: u64) -> Option<bool> {
    let t = service_kit::schema::js_trim(text);
    if t.is_empty() {
        return Some(true);
    }
    let lower = t.get(..2).map(str::to_ascii_lowercase);
    let (negative, radix, digits) = match lower.as_deref() {
        Some("0x") => (false, 16, t.get(2..)?),
        Some("0o") => (false, 8, t.get(2..)?),
        Some("0b") => (false, 2, t.get(2..)?),
        _ => match t.strip_prefix('-') {
            Some(rest) => (true, 10, rest),
            None => (false, 10, t.strip_prefix('+').unwrap_or(t)),
        },
    };
    if digits.is_empty() || !digits.chars().all(|c| c.is_digit(radix)) {
        return None;
    }
    if negative {
        return Some(true);
    }
    // Past u128 is past any `max`.
    Some(u128::from_str_radix(digits, radix).is_ok_and(|n| n <= u128::from(max)))
}

/// The ledger's refines.
pub struct LedgerRefines;

impl Refiner for LedgerRefines {
    fn refine(&self, id: &str, v: &Value) -> Result<bool, String> {
        match id {
            // `!q.from || !q.to || Date.parse(q.from) < Date.parse(q.to)`.
            "from_before_to" => {
                let (from, to) = (
                    v.get("from").as_str().unwrap_or(""),
                    v.get("to").as_str().unwrap_or(""),
                );
                if from.is_empty() || to.is_empty() {
                    return Ok(true);
                }
                let parse = service_kit::time::js_date;
                Ok(matches!((parse(from), parse(to)), (Some(a), Some(b)) if a.0 < b.0))
            }
            // `BigInt(v) <= INT8_MAX`. zod runs it after a failed pattern too, so it sees any string.
            "seq_within_int8" => {
                let text = v.js_string();
                js_bigint_at_most(&text, INT8_MAX)
                    .ok_or_else(|| format!("Cannot convert {text} to a BigInt"))
            }
            // `r >= 1` on an account metadata delete's revision: a key never set has nothing to delete.
            "revision_set" => Ok(v.as_number().is_some_and(|r| r >= 1.0)),
            other => Err(format!("no refine named {other}")),
        }
    }

    fn super_refine(&self, id: &str, v: &Value) -> Result<Vec<(Vec<Json>, String)>, String> {
        match id {
            "owner_id_space" => {
                let owner_type = v.get("ownerType").js_string();
                let owner_id = v.get("ownerId").js_string();
                if is_valid_owner_id(&owner_type, &owner_id) {
                    return Ok(Vec::new());
                }
                Ok(vec![(
                    vec![Json::str("ownerId")],
                    format!(
                        "owner_type \"{owner_type}\" requires {} — got \"{owner_id}\"",
                        describe_owner_id_space(&owner_type)
                    ),
                )])
            }
            other => Err(format!("no superRefine named {other}")),
        }
    }
}
