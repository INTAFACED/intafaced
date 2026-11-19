//! The edge trust boundary (`packages/contracts/src/edge.ts`): the principal the edge forwards is believed only when its
//! HMAC over the exact header bytes and the region verifies, it parses as a principal, and it has not expired.
//!
//! The HMAC form only. A principal signed with Ed25519 (`ed25519:` signatures) is refused here exactly as the TypeScript
//! service refuses it when it holds only `EDGE_PRINCIPAL_SECRET` and no `EDGE_PRINCIPAL_PUBLIC_KEY`.

use hmac::{Hmac, Mac};
use sha2::Sha256;

use crate::json::{self, Json};
use crate::time::{self, Instant};

/// `MIN_SECRET_LENGTH`: shorter is guessable offline.
pub const MIN_SECRET_LENGTH: usize = 32;

/// The verified caller, with the fields svc-tax's guards read.
#[derive(Debug, Clone, PartialEq)]
pub struct Principal {
    pub user_id: String,
    pub scopes: Vec<String>,
    pub tier: String,
}

/// `signPrincipalHeader`: HMAC-SHA256 over `<raw>\nregion=<region>`, lower-case hex.
pub fn sign(raw: &str, secret: &str, region: &str) -> Result<String, String> {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).map_err(|e| e.to_string())?;
    mac.update(format!("{raw}\nregion={region}").as_bytes());
    Ok(mac
        .finalize()
        .into_bytes()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}

fn hex_bytes(s: &str) -> Option<Vec<u8>> {
    let b = s.as_bytes();
    if !b.len().is_multiple_of(2) {
        return None;
    }
    b.chunks(2)
        .map(|pair| match pair {
            [h, l] => Some(nibble(*h)? << 4 | nibble(*l)?),
            _ => None,
        })
        .collect()
}

fn nibble(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        _ => None,
    }
}

/// `signatureMatches`: same length as the expected hex, lower-case hex only, compared in constant time.
fn signature_matches(raw: &str, signature: &str, secret: &str, region: &str) -> bool {
    let Ok(mut mac) = Hmac::<Sha256>::new_from_slice(secret.as_bytes()) else {
        return false;
    };
    if signature.len() != 64 {
        return false;
    }
    let Some(given) = hex_bytes(signature) else {
        return false;
    };
    mac.update(format!("{raw}\nregion={region}").as_bytes());
    mac.verify_slice(&given).is_ok()
}

/// zod's `z.string().guid()`: 8-4-4-4-12 hex digits, any case.
fn is_guid(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| {
            if [8, 13, 18, 23].contains(&i) {
                *c == b'-'
            } else {
                c.is_ascii_hexdigit()
            }
        })
}

/// `STAFF_AREAS` x `STAFF_VERBS` (`packages/auth/src/staff-permissions.ts`): the `<area>:<verb>` a principal may carry.
const STAFF_AREAS: [&str; 11] = [
    "staff",
    "accounts",
    "ledger",
    "payments",
    "cards",
    "trading",
    "documents",
    "flags",
    "tokens",
    "settings",
    "authentication",
];
const STAFF_VERBS: [&str; 8] = [
    "read", "write", "create", "update", "delete", "approve", "apply", "skip",
];

fn is_staff_area_verb(s: &str) -> bool {
    s.split_once(':')
        .is_some_and(|(a, v)| STAFF_AREAS.contains(&a) && STAFF_VERBS.contains(&v))
}

fn strings(v: &Json) -> Option<Vec<&str>> {
    match v {
        Json::Array(items) => items
            .iter()
            .map(|i| match i {
                Json::String(s) => Some(s.as_str()),
                _ => None,
            })
            .collect(),
        _ => None,
    }
}

/// `principalHeaderSchema.safeParse`: the access claims, `userId`, `expiresAt` and an optional `iat`. Unknown keys are
/// ignored; a present key of the wrong shape (null included) refuses the whole principal.
fn parse_principal(v: &Json) -> Option<(Principal, Instant)> {
    let Json::Object(_) = v else { return None };
    let guid = |key: &str, required: bool| match v.get(key) {
        None => !required,
        Some(Json::String(s)) => is_guid(s),
        Some(_) => false,
    };
    let opt_str = |key: &str| matches!(v.get(key), None | Some(Json::String(_)));
    let opt_bool = |key: &str| matches!(v.get(key), None | Some(Json::Bool(_)));
    let opt_enum = |key: &str, allowed: &[&str]| match v.get(key) {
        None => true,
        Some(Json::String(s)) => allowed.contains(&s.as_str()),
        Some(_) => false,
    };
    let scopes = v.get("scopes").and_then(strings)?;
    let shaped = guid("sub", true)
        && opt_str("kid")
        && guid("sub_account", false)
        && opt_enum("key_env", &["live", "sandbox"])
        && opt_enum("tier", &["none", "basic", "full", "institutional"])
        && opt_bool("trd")
        && opt_bool("mfa")
        && guid("sid", true)
        && guid("fam", false)
        && guid("dev", false)
        && v.get("stp").is_none_or(|s| strings(s).is_some())
        && v.get("staffPermissions").is_none_or(|s| {
            strings(s).is_some_and(|list| {
                list.len() <= STAFF_AREAS.len() * STAFF_VERBS.len()
                    && list.iter().all(|p| is_staff_area_verb(p))
                    && list
                        .iter()
                        .enumerate()
                        .all(|(i, p)| !list.iter().take(i).any(|q| q == p))
            })
        })
        && opt_enum("staffEnv", &["local", "staging", "production"])
        && guid("userId", true)
        && match v.get("iat") {
            None => true,
            Some(Json::Number(n)) => {
                n.is_finite() && n.fract() == 0.0 && *n > 0.0 && *n <= 9_007_199_254_740_991.0
            }
            Some(_) => false,
        };
    if !shaped {
        return None;
    }
    let Some(Json::String(expires)) = v.get("expiresAt") else {
        return None;
    };
    let expires_at = time::zod_datetime(expires, false)?;
    let Some(Json::String(user_id)) = v.get("userId") else {
        return None;
    };
    let tier = match v.get("tier") {
        Some(Json::String(t)) => t.clone(),
        _ => "none".to_owned(),
    };
    Some((
        Principal {
            user_id: user_id.clone(),
            scopes: scopes.into_iter().map(str::to_owned).collect(),
            tier,
        },
        expires_at,
    ))
}

/// `verifyForwardedPrincipal` with an HMAC secret: the principal, or none (the caller is then anonymous).
pub fn verify(
    raw: Option<&str>,
    signature: Option<&str>,
    secret: &str,
    now: Instant,
    region: &str,
) -> Option<Principal> {
    let raw = raw.filter(|r| !r.is_empty())?;
    let signature = signature.filter(|s| !s.is_empty())?;
    if signature.starts_with("ed25519:") || !signature_matches(raw, signature, secret, region) {
        return None;
    }
    let parsed = json::parse(raw).ok()?;
    let (principal, expires_at) = parse_principal(&parsed)?;
    (expires_at > now).then_some(principal)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &str = "a-tax-wire-replay-edge-secret-long-enough";
    const RAW: &str = r#"{"sub":"11111111-1111-4111-8111-111111111111","scopes":["tax:read"],"tier":"none","mfa":false,"sid":"22222222-2222-4222-8222-222222222222","userId":"11111111-1111-4111-8111-111111111111","expiresAt":"2099-01-01T00:00:00.000Z"}"#;

    #[test]
    fn believes_only_a_signed_unexpired_principal_for_its_region() {
        let now = Instant(1_795_046_400_000);
        let sig = sign(RAW, SECRET, "DE").unwrap();
        assert!(verify(Some(RAW), Some(&sig), SECRET, now, "DE").is_some());
        assert!(
            verify(Some(RAW), Some(&sig), SECRET, now, "US").is_none(),
            "the region is signed"
        );
        assert!(
            verify(Some(RAW), Some(&sig.to_uppercase()), SECRET, now, "DE").is_none(),
            "lower-case hex only"
        );
        assert!(
            verify(
                Some(RAW),
                Some(&sig),
                "another-secret-that-is-long-enough-x",
                now,
                "DE"
            )
            .is_none()
        );
        assert!(
            verify(
                Some(RAW),
                Some(&sig),
                SECRET,
                Instant(4_070_908_800_000),
                "DE"
            )
            .is_none(),
            "expired"
        );
        let null_tier = RAW.replace(r#""tier":"none""#, r#""tier":null"#);
        let sig2 = sign(&null_tier, SECRET, "DE").unwrap();
        assert!(
            verify(Some(&null_tier), Some(&sig2), SECRET, now, "DE").is_none(),
            "a null field is not absent"
        );
    }
}
