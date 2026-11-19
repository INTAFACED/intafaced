//! The edge trust boundary (`packages/contracts/src/edge.ts`): the principal the edge forwards is believed only when its
//! HMAC over the exact header bytes and the region verifies, it parses as a principal, and it has not expired.
//!
//! Two forms: the HMAC over the shared secret, and, when `EDGE_PRINCIPAL_PUBLIC_KEY` is set, the edge's Ed25519
//! signature (`ed25519:`), which also needs an issue time and both lifetime limits (`edgeTrustFromEnv`,
//! `createEdgeContext`). Without the public key an `ed25519:` principal is refused, as the TypeScript refuses it.

use hmac::{Hmac, Mac};
use sha2::Sha256;

use crate::json::{self, Json};
use crate::time::{self, Instant};

/// `MIN_SECRET_LENGTH`: shorter is guessable offline.
pub const MIN_SECRET_LENGTH: usize = 32;

/// The verified caller, with the fields a service's guards read (svc-tax's today).
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
fn parse_principal(v: &Json) -> Option<(Principal, Instant, Option<i64>)> {
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
    let iat = match v.get("iat") {
        #[expect(
            clippy::cast_possible_truncation,
            reason = "a positive whole number below 2^53, checked above"
        )]
        Some(Json::Number(n)) => Some(*n as i64),
        _ => None,
    };
    Some((
        Principal {
            user_id: user_id.clone(),
            scopes: scopes.into_iter().map(str::to_owned).collect(),
            tier,
        },
        expires_at,
        iat,
    ))
}

/// `EdgePrincipalLimits`: positive whole seconds, both required with the public key.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    pub max_lifetime_seconds: i64,
    pub clock_skew_seconds: i64,
}

/// The edge's public key and the limits its principals are held to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EdgeKey {
    pub public_key: [u8; 32],
    pub limits: Limits,
}

/// `EDGE_PRINCIPAL_LIMITS_REQUIRED`.
pub const EDGE_PRINCIPAL_LIMITS_REQUIRED: &str = "EDGE_PRINCIPAL_LIMITS_REQUIRED";

impl EdgeKey {
    /// `createEdgeContext`'s boot checks for the asymmetric form: a raw 32-byte key, base64url, and both limits
    /// (`edgeTrustFromEnv` leaves them out unless both are set). The error is `EdgeTrustError`'s message.
    pub fn from_env(
        service: &str,
        public_key: &str,
        max_lifetime_seconds: Option<i64>,
        clock_skew_seconds: Option<i64>,
    ) -> Result<EdgeKey, String> {
        let Some(key) = crate::s2s::canonical_key(public_key) else {
            return Err(format!(
                "{service}: EDGE_PRINCIPAL_PUBLIC_KEY must be a raw 32-byte Ed25519 public key, base64url."
            ));
        };
        let (Some(max), Some(skew)) = (max_lifetime_seconds, clock_skew_seconds) else {
            return Err(format!(
                "{service}: Forwarded-principal maxLifetimeSeconds and clockSkewSeconds are required configuration and have no default."
            ));
        };
        if max <= 0 || skew <= 0 {
            return Err(format!(
                "{service}: Forwarded-principal maxLifetimeSeconds and clockSkewSeconds must be positive integers (seconds)."
            ));
        }
        Ok(EdgeKey {
            public_key: key,
            limits: Limits {
                max_lifetime_seconds: max,
                clock_skew_seconds: skew,
            },
        })
    }
}

/// `ed25519Matches`: 86 base64url characters after the prefix, verified over `intafaced-principal-v2\n<raw>\nregion=<r>`.
fn ed25519_matches(raw: &str, signature: &str, key: &[u8; 32], region: &str) -> bool {
    use base64::Engine as _;
    let Some(body) = signature.strip_prefix("ed25519:") else {
        return false;
    };
    if body.len() != 86
        || !body
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return false;
    }
    let Ok(sig) = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(body) else {
        return false;
    };
    let Ok(sig) = ed25519_dalek::Signature::from_slice(&sig) else {
        return false;
    };
    let Ok(vk) = ed25519_dalek::VerifyingKey::from_bytes(key) else {
        return false;
    };
    vk.verify_strict(
        format!("intafaced-principal-v2\n{raw}\nregion={region}").as_bytes(),
        &sig,
    )
    .is_ok()
}

/// `verifyForwardedPrincipal` with an HMAC secret: the principal, or none (the caller is then anonymous).
pub fn verify(
    raw: Option<&str>,
    signature: Option<&str>,
    secret: &str,
    now: Instant,
    region: &str,
) -> Option<Principal> {
    verify_with(raw, signature, secret, None, now, region)
}

/// `verifyForwardedPrincipal` with the shared secret and, when set, the edge's public key.
pub fn verify_with(
    raw: Option<&str>,
    signature: Option<&str>,
    secret: &str,
    edge_key: Option<&EdgeKey>,
    now: Instant,
    region: &str,
) -> Option<Principal> {
    let raw = raw.filter(|r| !r.is_empty())?;
    let signature = signature.filter(|s| !s.is_empty())?;
    let asymmetric = signature.starts_with("ed25519:");
    if asymmetric {
        let key = edge_key?;
        if !ed25519_matches(raw, signature, &key.public_key, region) {
            return None;
        }
    } else if !signature_matches(raw, signature, secret, region) {
        return None;
    }
    let parsed = json::parse(raw).ok()?;
    let (principal, expires_at, iat) = parse_principal(&parsed)?;
    if expires_at <= now {
        return None;
    }
    if let (true, Some(key)) = (asymmetric, edge_key) {
        // Short-lived by construction: iat is required, not in the future past the skew, and the expiry at most the
        // configured lifetime after it.
        let iat_ms = iat?.checked_mul(1000)?;
        if iat_ms
            > now
                .0
                .saturating_add(key.limits.clock_skew_seconds.saturating_mul(1000))
        {
            return None;
        }
        if expires_at.0.saturating_sub(iat_ms)
            > key.limits.max_lifetime_seconds.saturating_mul(1000)
        {
            return None;
        }
    }
    Some(principal)
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
