//! The ledger's own checks inside its input schemas, by the names `scripts/record-door.mjs` gives them in
//! `door/schemas.json`: the account owner's identifier space (`accountRefSchema`'s `superRefine`, from
//! `@intafaced/ledger-client`'s `isValidOwnerId`), the operator desk's list query (`operator-desk.ts`), an account
//! metadata delete's revision (`operator-account-metadata.ts`), the asset registry's body (`checkBody` in
//! `packages/contracts/src/asset-registry.ts`), and a reconciliation control's threshold, account set and lifecycle
//! move (`packages/contracts/src/ledger-reconciliation.ts`) with svc-pay's signed decimals it reads.

use service_kit::json::Json;
use service_kit::schema::{Added, Refiner, Value};

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

/// `ASSET_DEFAULT_NETWORK_NOT_LISTED`: `parseAssetEdit` finds the issue by this message.
pub const DEFAULT_NETWORK_NOT_LISTED: &str = "ledger.asset_default_network_not_listed";

/// `checkBody(body, ctx)`: the network ids unique, the default network one of them, the actions unique. It runs only on
/// a body whose parts parsed (zod skips it after any other issue), so every part here is the type its schema says.
fn asset_body(v: &Value) -> Vec<Added> {
    let texts = |key: &str, field: Option<&str>| -> Vec<String> {
        v.get(key)
            .as_array()
            .unwrap_or_default()
            .iter()
            .map(|item| field.map_or(item, |f| item.get(f)).js_string())
            .collect()
    };
    let unique = |list: &[String]| {
        list.iter()
            .enumerate()
            .all(|(i, a)| list.iter().skip(i + 1).all(|b| a != b))
    };
    let ids = texts("networks", Some("networkId"));
    let mut issues = Vec::new();
    if !unique(&ids) {
        issues.push(Added::at(
            vec![Json::str("networks")],
            "network ids must be unique",
        ));
    }
    if let Some(default) = v.get("defaultNetworkId").as_str()
        && !ids.iter().any(|id| id == default)
    {
        issues.push(Added::at(
            vec![Json::str("defaultNetworkId")],
            DEFAULT_NETWORK_NOT_LISTED,
        ));
    }
    if !unique(&texts("allowedActions", None)) {
        issues.push(Added::at(
            vec![Json::str("allowedActions")],
            "actions must be unique",
        ));
    }
    issues
}

/// `/^-0(\.0+)?$/`.
fn is_negative_zero(s: &str) -> bool {
    match s.strip_prefix("-0") {
        Some("") => true,
        Some(rest) => rest
            .strip_prefix('.')
            .is_some_and(|zeros| !zeros.is_empty() && zeros.bytes().all(|b| b == b'0')),
        None => false,
    }
}

/// `OPS_CONTROL_POLICY_UNSET` and `OPS_CONTROL_STATE_ILLEGAL`, the messages a control's input refuses with.
const POLICY_UNSET: &str = "ops.control_policy_unset";
const STATE_ILLEGAL: &str = "ops.control_state_illegal";

/// `queryAccountSetSchema`'s `superRefine`: a rail names its boundary itself (no owner type, no owner id prefix, no kind
/// but `available` beside it), and a query names at least one predicate.
fn rail_boundary(v: &Value) -> Vec<Added> {
    let set = |k: &str| !matches!(v.get(k), Value::Undefined);
    let mut issues = Vec::new();
    if set("rail")
        && (set("ownerType")
            || set("ownerIdPrefix")
            || (set("kind") && v.get("kind").as_str() != Some("available")))
    {
        issues.push(Added::saying(POLICY_UNSET, vec![Json::str("rail")]));
    }
    let predicated = [
        "rail",
        "ownerType",
        "ownerIdPrefix",
        "kind",
        "purpose",
        "assetId",
    ]
    .iter()
    .any(|k| set(k));
    if !predicated {
        issues.push(Added::saying(POLICY_UNSET, Vec::new()));
    }
    issues
}

/// `updateReconciliationControlInputSchema`'s `superRefine`: a lifecycle move travels alone with its two approval ids,
/// and the approval ids ride with nothing else. A path lists every key it names, as the TypeScript passes them.
fn lifecycle_alone(v: &Value) -> Vec<Added> {
    let present: Vec<&str> = match v {
        Value::Object(o) => o
            .iter()
            .filter(|(_, value)| !matches!(value, Value::Undefined))
            .map(|(k, _)| k.as_str())
            .collect(),
        _ => Vec::new(),
    };
    let keys = |list: Vec<&str>| list.into_iter().map(Json::str).collect::<Vec<_>>();
    let mut issues = Vec::new();
    if matches!(v.get("lifecycle"), Value::Undefined) {
        let stray: Vec<&str> = present
            .iter()
            .copied()
            .filter(|k| *k == "approvalId" || *k == "operationId")
            .collect();
        if !stray.is_empty() {
            issues.push(Added::saying(STATE_ILLEGAL, keys(stray)));
        }
        return issues;
    }
    let allowed = [
        "controlId",
        "reason",
        "lifecycle",
        "approvalId",
        "operationId",
    ];
    let extra: Vec<&str> = present
        .iter()
        .copied()
        .filter(|k| !allowed.contains(k))
        .collect();
    if !extra.is_empty() {
        issues.push(Added::saying(STATE_ILLEGAL, keys(extra)));
    }
    for key in ["approvalId", "operationId"] {
        if matches!(v.get(key), Value::Undefined) {
            issues.push(Added::saying(
                "action_approval.missing",
                vec![Json::str(key)],
            ));
        }
    }
    issues
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
            // `Object.keys(value.byAsset).length > 0` on a control's threshold: a bound with no asset bounds nothing.
            "threshold_has_assets" => {
                Ok(matches!(v.get("byAsset"), Value::Object(o) if !o.is_empty()))
            }
            // `!/^-0(\.0+)?$/.test(v)` on svc-pay's signed decimals: a zero is never negative.
            "not_negative_zero" => Ok(!is_negative_zero(&v.js_string())),
            other => Err(format!("no refine named {other}")),
        }
    }

    fn super_refine(&self, id: &str, v: &Value) -> Result<Vec<Added>, String> {
        match id {
            "owner_id_space" => {
                let owner_type = v.get("ownerType").js_string();
                let owner_id = v.get("ownerId").js_string();
                if is_valid_owner_id(&owner_type, &owner_id) {
                    return Ok(Vec::new());
                }
                Ok(vec![Added::at(
                    vec![Json::str("ownerId")],
                    format!(
                        "owner_type \"{owner_type}\" requires {} — got \"{owner_id}\"",
                        describe_owner_id_space(&owner_type)
                    ),
                )])
            }
            "asset_body" => Ok(asset_body(v)),
            "rail_boundary" => Ok(rail_boundary(v)),
            "lifecycle_alone" => Ok(lifecycle_alone(v)),
            other => Err(format!("no superRefine named {other}")),
        }
    }
}
