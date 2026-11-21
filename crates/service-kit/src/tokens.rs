//! Access tokens as a service verifies them itself (`packages/auth/src/tokens.ts` `verifyAccessToken`, with
//! `bearerToken` from `guards.ts`): an HS256 JWT signed with the access secret (or a verify-only key named by the
//! token's `kid`), its issuer and audience, a required expiry, and the claims `accessClaimsSchema` reads. The refusals
//! are the TypeScript's: `token.expired` for a signature that matched and an expiry that passed, `token.invalid` for a
//! claim that is wrong or a token that does not verify, `token.malformed` for verified claims of the wrong shape.
//!
//! jose 5's own checks are followed for what a matching signature can still carry (`jwt_claims_set.js`): required
//! claims, issuer, audience, `iat`, `nbf` and `exp` with no clock tolerance. Two cases are refused here that jose
//! might accept, both fail closed: a header with `crit` (jose accepts `crit: ["b64"]` with `b64: true`), and base64url
//! text with characters outside the alphabet (Node's decoder skips them).

use hmac::{Hmac, Mac};
use sha2::Sha256;

use crate::edge::Principal;
use crate::json::{self, Json};

/// One verify-only key: the `kid` it answers to and its secret.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifyKey {
    pub key_id: String,
    pub secret: String,
}

/// `TokenConfig`, the parts a verifier reads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TokenConfig {
    pub secret: String,
    pub issuer: String,
    pub audience: String,
    /// The signing key's id, when it has one.
    pub key_id: Option<String>,
    pub verify_only: Vec<VerifyKey>,
}

/// `AuthError`: its message and code.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthError {
    pub message: String,
    pub code: &'static str,
}

impl AuthError {
    pub fn new(message: impl Into<String>, code: &'static str) -> AuthError {
        AuthError {
            message: message.into(),
            code,
        }
    }
}

/// A verified token: the principal the guards read, and its expiry in seconds.
#[derive(Debug, Clone, PartialEq)]
pub struct Verified {
    pub principal: Principal,
    pub expires_at: i64,
}

/// `bearerToken(header)`: the token after `Bearer` and whitespace, matched without case, on the trimmed header.
pub fn bearer_token(header: Option<&str>) -> Option<String> {
    let h = crate::schema::js_trim(header.filter(|h| !h.is_empty())?);
    let (word, rest) = h.split_at_checked(6)?;
    if !word.eq_ignore_ascii_case("bearer") {
        return None;
    }
    let token = rest.trim_start_matches(js_space);
    // `\s+` needs at least one space, and `(.+)` one character that is not a line end.
    if token.len() == rest.len()
        || token.is_empty()
        || token.contains(['\n', '\r', '\u{2028}', '\u{2029}'])
    {
        return None;
    }
    Some(token.to_owned())
}

fn js_space(c: char) -> bool {
    crate::schema::js_trim(c.encode_utf8(&mut [0; 4])).is_empty()
}

const COULD_NOT_VERIFY: &str = "Access token could not be verified";

fn invalid() -> AuthError {
    AuthError::new(COULD_NOT_VERIFY, "token.invalid")
}

/// base64url without padding, the alphabet only.
fn b64url(text: &str) -> Option<Vec<u8>> {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(text.trim_end_matches('='))
        .ok()
}

/// How one candidate key judged the token.
enum Judged {
    /// The signature did not match, or the token is not a JWT this key can read: try the next key.
    NotThisKey,
    /// The signature matched and a claim refused it.
    Expired,
    ClaimRejected,
    Ok(Json),
}

/// `verifyAccessToken(token, config)` at `now` (seconds since the epoch).
pub fn verify_access_token(
    token: &str,
    config: &TokenConfig,
    now: i64,
) -> Result<Verified, AuthError> {
    let payload = verify_signature_and_claims(token, config, now)?;
    let malformed = || AuthError::new("Access token payload is malformed", "token.malformed");
    let principal = claims(&payload).ok_or_else(malformed)?;
    let exp = match payload.get("exp") {
        Some(Json::Number(n)) => js_floor(*n),
        _ => return Err(malformed()),
    };
    Ok(Verified {
        principal,
        expires_at: exp,
    })
}

fn js_floor(n: f64) -> i64 {
    format!("{:.0}", n.floor()).parse().unwrap_or(i64::MAX)
}

fn verify_signature_and_claims(
    token: &str,
    config: &TokenConfig,
    now: i64,
) -> Result<Json, AuthError> {
    // `candidateKeys`: the header must read as JSON (`Buffer.from(..., 'base64url')`, then `JSON.parse`).
    let first = token.split('.').next().unwrap_or("");
    let header_text = b64url(first).map(|b| String::from_utf8_lossy(&b).into_owned());
    let header = header_text
        .as_deref()
        .and_then(|t| json::parse(t).ok())
        .ok_or_else(invalid)?;
    if header == Json::Null {
        // `(null).kid` throws.
        return Err(invalid());
    }
    let kid = header.get("kid");
    let ring = std::iter::once((config.key_id.as_deref(), config.secret.as_str())).chain(
        config
            .verify_only
            .iter()
            .map(|k| (Some(k.key_id.as_str()), k.secret.as_str())),
    );
    let candidates: Vec<&str> = match kid {
        None => ring.map(|(_, s)| s).collect(),
        Some(Json::String(kid)) => ring
            .filter(|(id, _)| *id == Some(kid.as_str()))
            .map(|(_, s)| s)
            .collect(),
        Some(_) => Vec::new(),
    };
    // `key(secret)` refuses a short secret before any key is tried.
    if candidates.iter().any(|s| s.encode_utf16().count() < 32) {
        return Err(invalid());
    }
    for secret in candidates {
        match judge(token, secret, config, now) {
            Judged::NotThisKey => {}
            Judged::Expired => return Err(AuthError::new("Access token expired", "token.expired")),
            Judged::ClaimRejected => {
                return Err(AuthError::new("Token claims rejected", "token.invalid"));
            }
            Judged::Ok(payload) => return Ok(payload),
        }
    }
    Err(invalid())
}

fn judge(token: &str, secret: &str, config: &TokenConfig, now: i64) -> Judged {
    let parts: Vec<&str> = token.split('.').collect();
    let [protected, payload, signature] = parts.as_slice() else {
        return Judged::NotThisKey;
    };
    let Some(header) =
        b64url(protected).and_then(|b| json::parse(&String::from_utf8_lossy(&b)).ok())
    else {
        return Judged::NotThisKey;
    };
    if !matches!(header, Json::Object(_)) || header.get("crit").is_some() {
        return Judged::NotThisKey;
    }
    if !matches!(header.get("alg"), Some(Json::String(a)) if a == "HS256") {
        return Judged::NotThisKey;
    }
    let Some(sig) = b64url(signature) else {
        return Judged::NotThisKey;
    };
    let Ok(mut mac) = Hmac::<Sha256>::new_from_slice(secret.as_bytes()) else {
        return Judged::NotThisKey;
    };
    mac.update(format!("{protected}.{payload}").as_bytes());
    if mac.verify_slice(&sig).is_err() {
        return Judged::NotThisKey;
    }
    let Some(claims) = b64url(payload).and_then(|b| json::parse(&String::from_utf8_lossy(&b)).ok())
    else {
        return Judged::NotThisKey;
    };
    if !matches!(claims, Json::Object(_)) {
        return Judged::NotThisKey;
    }
    // jose: presence of exp, aud, iss; then iss, aud, iat, nbf, exp.
    if ["iss", "aud", "exp"]
        .iter()
        .any(|c| claims.get(c).is_none())
    {
        return Judged::ClaimRejected;
    }
    if !matches!(claims.get("iss"), Some(Json::String(i)) if *i == config.issuer) {
        return Judged::ClaimRejected;
    }
    let aud_ok = match claims.get("aud") {
        Some(Json::String(a)) => *a == config.audience,
        Some(Json::Array(a)) => a
            .iter()
            .any(|x| matches!(x, Json::String(s) if *s == config.audience)),
        _ => false,
    };
    if !aud_ok {
        return Judged::ClaimRejected;
    }
    if claims
        .get("iat")
        .is_some_and(|v| !matches!(v, Json::Number(_)))
    {
        return Judged::ClaimRejected;
    }
    // A JSON number against the clock, compared as jose compares them.
    let now = now as f64;
    match claims.get("nbf") {
        None => {}
        Some(Json::Number(n)) if *n <= now => {}
        Some(_) => return Judged::ClaimRejected,
    }
    match claims.get("exp") {
        Some(Json::Number(n)) if *n > now => Judged::Ok(claims),
        Some(Json::Number(_)) => Judged::Expired,
        _ => Judged::ClaimRejected,
    }
}

/// `z.string().guid()`.
pub fn is_guid(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| {
            if matches!(i, 8 | 13 | 18 | 23) {
                *c == b'-'
            } else {
                c.is_ascii_hexdigit()
            }
        })
}

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
const STAFF_ENVS: [&str; 3] = ["local", "staging", "production"];

fn is_staff_area_verb(v: &Json) -> bool {
    let Json::String(s) = v else { return false };
    s.split_once(':')
        .is_some_and(|(a, v)| STAFF_AREAS.contains(&a) && STAFF_VERBS.contains(&v))
}

/// `accessClaimsSchema.safeParse(payload)`, then the staff pairing check: the principal, or none when malformed.
fn claims(p: &Json) -> Option<Principal> {
    let str_of = |k: &str| match p.get(k) {
        Some(Json::String(s)) => Some(Some(s.clone())),
        None => Some(None),
        Some(_) => None,
    };
    let guid_of = |k: &str| match str_of(k)? {
        Some(s) if !is_guid(&s) => None,
        v => Some(v),
    };
    let one_of = |k: &str, options: &[&str]| match str_of(k)? {
        Some(s) if !options.contains(&s.as_str()) => None,
        v => Some(v),
    };
    let strings = |k: &str| match p.get(k) {
        Some(Json::Array(a)) => a
            .iter()
            .map(|v| match v {
                Json::String(s) => Some(s.clone()),
                _ => None,
            })
            .collect::<Option<Vec<_>>>()
            .map(Some),
        None => Some(None),
        Some(_) => None,
    };
    let bool_of = |k: &str| match p.get(k) {
        Some(Json::Bool(b)) => Some(Some(*b)),
        None => Some(None),
        Some(_) => None,
    };
    let sub = guid_of("sub")??;
    let scopes = strings("scopes")??;
    let sub_account = guid_of("sub_account")?;
    let kid = str_of("kid")?;
    one_of("key_env", &["live", "sandbox"])?;
    let tier = one_of("tier", &["none", "basic", "full", "institutional"])?
        .unwrap_or_else(|| "none".to_owned());
    bool_of("trd")?;
    let mfa = bool_of("mfa")?.unwrap_or(false);
    guid_of("sid")??;
    guid_of("fam")?;
    guid_of("dev")?;
    strings("stp")?;
    let staff = match p.get("staffPermissions") {
        None => false,
        Some(Json::Array(list)) => {
            let distinct = list
                .iter()
                .enumerate()
                .all(|(i, v)| !list.iter().take(i).any(|w| w == v));
            if !list.iter().all(is_staff_area_verb)
                || list.len() > STAFF_AREAS.len() * STAFF_VERBS.len()
                || !distinct
            {
                return None;
            }
            true
        }
        Some(_) => return None,
    };
    let staff_env = one_of("staffEnv", &STAFF_ENVS)?;
    if staff != staff_env.is_some() || (staff && (kid.is_some() || sub_account.is_some())) {
        return None;
    }
    Some(Principal {
        user_id: sub,
        scopes,
        tier,
        mfa,
        kid,
        sub_account,
    })
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test")]
    use super::*;

    #[test]
    fn bearer_reads_as_the_typescript_regex() {
        assert_eq!(bearer_token(Some("Bearer abc")), Some("abc".to_owned()));
        assert_eq!(
            bearer_token(Some("  bearer\t abc ")),
            Some("abc".to_owned())
        );
        assert_eq!(bearer_token(Some("Bearer")), None);
        assert_eq!(bearer_token(Some("Bearerabc")), None);
        assert_eq!(bearer_token(Some("Basic abc")), None);
        assert_eq!(bearer_token(None), None);
        assert_eq!(bearer_token(Some("")), None);
    }

    #[test]
    fn guid_is_zods() {
        assert!(is_guid("11111111-1111-4111-8111-111111111111"));
        assert!(is_guid("AAAAAAAA-1111-1111-1111-111111111111"));
        assert!(!is_guid("11111111-1111-4111-8111-11111111111"));
    }
}
