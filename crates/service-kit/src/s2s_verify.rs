//! How a service judges an incoming call from another service (`packages/contracts/src/service-auth.ts`
//! `verifyServiceCall`, `service-keys.ts` `createServiceVerifier`, `service-auth-http.ts` `verifyServiceRequest`): the
//! caller's own Ed25519 key (v3) when the request carries any v3 header, else the shared secret (v2 bound to the body,
//! v1 without it) while the mode allows it. Every step fails closed; the reasons are the TypeScript's.
//!
//! A request with no service credentials has no service caller and is not a refusal: it is a user's or an anonymous
//! request.

use std::collections::BTreeMap;
use std::sync::Mutex;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ed25519_dalek::{Signature, Verifier as _, VerifyingKey};
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};

use crate::s2s::{
    KeyringEntry, Mode, S2S_AUDIENCE_HEADER, S2S_BODY_HEADER, S2S_KID_HEADER, S2S_NONCE_HEADER,
    S2S_SIGNATURE_HEADER, S2S_TIMESTAMP_HEADER, SERVICE_BODY_DIGEST_HEADER, SERVICE_HEADER,
    SERVICE_SIGNATURE_HEADER, SERVICE_TIMESTAMP_HEADER, SignedContext, body_digest, canonical_key,
    js_length, length_prefixed,
};

/// `SERVICE_CALL_MAX_SKEW_SECONDS`.
pub const SERVICE_CALL_MAX_SKEW_SECONDS: i64 = 300;
/// `S2S_PAST_SECONDS`, `S2S_FUTURE_SECONDS`.
pub const S2S_PAST_SECONDS: i64 = 60;
pub const S2S_FUTURE_SECONDS: i64 = 5;
const NONCE_TTL_PAST_SECONDS: i64 = S2S_PAST_SECONDS + 1;
const V3_DOMAIN: &str = "intafaced-s2s-v3\n";
const V2_DOMAIN: &str = "intafaced-s2s-v2";
const MIN_SECRET_LENGTH: usize = 32;

const V3_HEADERS: [&str; 6] = [
    S2S_KID_HEADER,
    S2S_AUDIENCE_HEADER,
    S2S_TIMESTAMP_HEADER,
    S2S_NONCE_HEADER,
    S2S_BODY_HEADER,
    S2S_SIGNATURE_HEADER,
];

/// One incoming request as the verifier reads it. `body` is the bytes it carried, when the server kept them.
pub struct Incoming<'a> {
    pub method: &'a str,
    /// The raw request target as received: path and query.
    pub url: &'a str,
    pub headers: &'a [(String, String)],
    pub body: Option<&'a [u8]>,
}

impl Incoming<'_> {
    /// The header's value; `Err(())` when it came more than once (Node's array form).
    fn single(&self, name: &str) -> Option<Result<&str, ()>> {
        let mut values = self
            .headers
            .iter()
            .filter(|(k, _)| k == name)
            .map(|(_, v)| v.as_str());
        let first = values.next()?;
        Some(if values.next().is_some() {
            Err(())
        } else {
            Ok(first)
        })
    }

    /// `headerValue`: the first value of a repeated header.
    fn first(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    }

    fn has(&self, name: &str) -> bool {
        self.headers.iter().any(|(k, _)| k == name)
    }
}

/// `createNonceCache`: remembers each signed call's nonce until it could no longer be fresh.
pub struct NonceCache {
    max: usize,
    entries: Mutex<BTreeMap<String, i64>>,
}

/// `NonceCache.add`'s outcome.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NonceAdd {
    Ok,
    Replay,
    Full,
}

impl NonceCache {
    pub fn new(max: usize) -> NonceCache {
        NonceCache {
            max,
            entries: Mutex::new(BTreeMap::new()),
        }
    }

    /// Remembers `key` until `expires_at`; never evicts a live entry to make room.
    pub fn add(&self, key: &str, expires_at: i64, now: i64) -> NonceAdd {
        let mut entries = self
            .entries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        entries.retain(|_, expiry| *expiry > now);
        if entries.contains_key(key) {
            return NonceAdd::Replay;
        }
        if entries.len() >= self.max {
            return NonceAdd::Full;
        }
        entries.insert(key.to_owned(), expires_at);
        NonceAdd::Ok
    }
}

/// `ServiceVerifyResultV3`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum V3Outcome {
    Absent,
    Accepted { service: String, kid: String },
    Rejected(&'static str),
}

/// `createServiceVerifier`: v3 calls to `self_name`, by the keyring's `s2s` keys.
pub struct ServiceVerifier {
    self_name: String,
    keys: Vec<(String, String, VerifyingKey)>,
    nonce: NonceCache,
    clock: fn() -> i64,
    boot_second: i64,
}

fn matches_pattern(header: &str, v: &str) -> bool {
    let b = v.as_bytes();
    let b64 = |c: &u8| c.is_ascii_alphanumeric() || *c == b'-' || *c == b'_';
    match header {
        S2S_KID_HEADER => v.split_once('.').is_some_and(|(owner, label)| {
            (1..=40).contains(&owner.len())
                && owner
                    .bytes()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
                && (1..=16).contains(&label.len())
                && label
                    .bytes()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        }),
        S2S_AUDIENCE_HEADER => v.strip_prefix("svc-").is_some_and(|rest| {
            (1..=40).contains(&rest.len())
                && rest
                    .bytes()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
        }),
        S2S_TIMESTAMP_HEADER => {
            (10..=11).contains(&b.len())
                && b.first().is_some_and(|c| (b'1'..=b'9').contains(c))
                && b.iter().all(u8::is_ascii_digit)
        }
        S2S_NONCE_HEADER => b.len() == 22 && b.iter().all(b64),
        S2S_BODY_HEADER => is_digest(v),
        S2S_SIGNATURE_HEADER => b.len() == 86 && b.iter().all(b64),
        _ => false,
    }
}

/// `^[0-9a-f]{64}$`.
fn is_digest(v: &str) -> bool {
    v.len() == 64
        && v.bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

impl ServiceVerifier {
    /// The verifier for `self_name`, believing the keyring's `s2s` keys. `boot_second`: calls signed earlier are
    /// refused, so a restart cannot reopen a cleared replay cache.
    pub fn new(
        self_name: &str,
        keyring: &[KeyringEntry],
        clock: fn() -> i64,
    ) -> Result<ServiceVerifier, String> {
        let mut keys = Vec::new();
        for entry in keyring.iter().filter(|e| e.use_ == "s2s") {
            let raw = canonical_key(&entry.x)
                .ok_or_else(|| format!("keyring: {} is not a raw Ed25519 key", entry.kid))?;
            let key = VerifyingKey::from_bytes(&raw)
                .map_err(|e| format!("keyring: {}: {e}", entry.kid))?;
            keys.retain(|(kid, _, _)| kid != &entry.kid);
            keys.push((entry.kid.clone(), entry.svc.clone(), key));
        }
        Ok(ServiceVerifier {
            self_name: self_name.to_owned(),
            keys,
            nonce: NonceCache::new(100_000),
            clock,
            boot_second: clock(),
        })
    }

    /// Sets the boot second (a test's fixed clock).
    pub fn with_boot_second(mut self, second: i64) -> ServiceVerifier {
        self.boot_second = second;
        self
    }

    /// `verifier.verify(request)`.
    pub fn verify(&self, req: &Incoming<'_>) -> V3Outcome {
        if !V3_HEADERS.iter().any(|h| req.has(h)) {
            return V3Outcome::Absent;
        }
        let reject = V3Outcome::Rejected;
        let mut values = Vec::with_capacity(6);
        for name in V3_HEADERS {
            match req.single(name) {
                Some(Ok(v)) if matches_pattern(name, v) => values.push(v),
                _ => return reject("malformed"),
            }
        }
        let [kid, aud, ts_text, nonce, body, sig] = values[..] else {
            return reject("malformed");
        };
        if aud != self.self_name {
            return reject("wrong-audience");
        }
        let Some((_, svc, key)) = self.keys.iter().find(|(k, _, _)| k == kid) else {
            return reject("unknown-key");
        };
        let now = (self.clock)();
        let Ok(ts) = ts_text.parse::<i64>() else {
            return reject("malformed");
        };
        if ts < now - S2S_PAST_SECONDS || ts > now + S2S_FUTURE_SECONDS || ts < self.boot_second {
            return reject("stale");
        }
        let header = |name: &str| match req.single(name) {
            Some(Ok(v)) => Some(v.to_owned()),
            _ => None,
        };
        let ctx = SignedContext {
            principal: header("x-intafaced-principal"),
            principal_signature: header("x-intafaced-principal-sig"),
            region: header("x-intafaced-region"),
            content_type: header("content-type"),
        };
        let preimage = format!(
            "{V3_DOMAIN}{}",
            [
                kid,
                aud,
                &req.method.to_uppercase(),
                req.url,
                ts_text,
                nonce,
                body,
                &context_digest(&ctx)
            ]
            .iter()
            .map(|f| length_prefixed(f))
            .collect::<String>()
        );
        let verified = URL_SAFE_NO_PAD
            .decode(sig)
            .ok()
            .and_then(|bytes| Signature::from_slice(&bytes).ok())
            .is_some_and(|s| key.verify(preimage.as_bytes(), &s).is_ok());
        if !verified {
            return reject("bad-signature");
        }
        let Some(bytes) = req.body else {
            return reject("body-unavailable");
        };
        if hex(&Sha256::digest(bytes)) != body {
            return reject("body-mismatch");
        }
        match self
            .nonce
            .add(&format!("{kid}|{nonce}"), ts + NONCE_TTL_PAST_SECONDS, now)
        {
            NonceAdd::Replay => reject("replay"),
            NonceAdd::Full => reject("replay-cache-full"),
            NonceAdd::Ok => V3Outcome::Accepted {
                service: svc.clone(),
                kid: kid.to_owned(),
            },
        }
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn context_digest(c: &SignedContext) -> String {
    let field = |v: &Option<String>| length_prefixed(v.as_deref().unwrap_or(""));
    hex(&Sha256::digest(
        format!(
            "{}{}{}{}",
            field(&c.principal),
            field(&c.principal_signature),
            field(&c.region),
            field(&c.content_type)
        )
        .as_bytes(),
    ))
}

/// `ServiceBodyBindMode`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BodyBind {
    AcceptBoth,
    Require,
}

/// `Number(text)` is an integer: decimal digits with an optional sign, after JavaScript's whitespace trim (an empty
/// string is 0). Other spellings `Number` reads (hex, exponents) are refused as missing; no signer writes them.
fn js_integer(text: &str) -> Option<i64> {
    let t = crate::schema::js_trim(text);
    if t.is_empty() {
        return Some(0);
    }
    let digits = t.strip_prefix(['+', '-']).unwrap_or(t);
    if digits.is_empty() || !digits.bytes().all(|c| c.is_ascii_digit()) {
        return None;
    }
    t.parse().ok()
}

/// Constant-time comparison of a hex signature with the expected one; non-hex is refused.
fn hex_equals(actual: &str, expected: &str) -> bool {
    if actual.len() != expected.len()
        || !actual
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    {
        return false;
    }
    actual
        .bytes()
        .zip(expected.bytes())
        .fold(0u8, |acc, (a, b)| acc | (a ^ b))
        == 0
}

/// `ServiceVerifyResult`: the caller, or why it was refused.
pub type LegacyOutcome = Result<String, &'static str>;

/// `verifyServiceHeaders(headers, secret, { rawBody, mode })` at `now` (seconds).
pub fn verify_legacy(req: &Incoming<'_>, secret: &str, mode: BodyBind, now: i64) -> LegacyOutcome {
    let (Some(service), Some(timestamp), Some(signature)) = (
        req.first(SERVICE_HEADER).filter(|s| !s.is_empty()),
        req.first(SERVICE_TIMESTAMP_HEADER)
            .filter(|s| !s.is_empty()),
        req.first(SERVICE_SIGNATURE_HEADER)
            .filter(|s| !s.is_empty()),
    ) else {
        return Err("missing");
    };
    let Some(ts) = js_integer(timestamp) else {
        return Err("missing");
    };
    if (now - ts).abs() > SERVICE_CALL_MAX_SKEW_SECONDS {
        return Err("stale");
    }
    let digest = req.first(SERVICE_BODY_DIGEST_HEADER);
    if digest.is_some_and(|d| !is_digest(d)) {
        return Err("bad-signature");
    }
    if secret.is_empty() || js_length(secret) < MIN_SECRET_LENGTH {
        return Err("bad-signature");
    }
    let Ok(mut mac) = Hmac::<Sha256>::new_from_slice(secret.as_bytes()) else {
        return Err("bad-signature");
    };
    match digest {
        None => mac.update(format!("{service}\n{ts}").as_bytes()),
        Some(d) => mac.update(
            format!(
                "{V2_DOMAIN}\n{}{}{}",
                length_prefixed(service),
                length_prefixed(&ts.to_string()),
                length_prefixed(d)
            )
            .as_bytes(),
        ),
    }
    if !hex_equals(signature, &hex(&mac.finalize().into_bytes())) {
        return Err("bad-signature");
    }
    let Some(d) = digest else {
        return if mode == BodyBind::Require {
            Err("missing-body-digest")
        } else {
            Ok(service.to_owned())
        };
    };
    let Some(bytes) = req.body else {
        return if mode == BodyBind::Require {
            Err("body-unavailable")
        } else {
            Ok(service.to_owned())
        };
    };
    if !hex_equals(&hex(&Sha256::digest(bytes)), d) {
        return Err("body-mismatch");
    }
    Ok(service.to_owned())
}

/// `ServiceRequestAuth`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RequestAuth {
    /// The verified caller; none when there is none or the credentials failed.
    pub service: Option<String>,
    /// `keypair` or `shared`.
    pub scheme: Option<&'static str>,
    /// Why credentials were refused; none for success and for a request with no service credentials.
    pub rejected: Option<&'static str>,
}

/// `verifyServiceRequest(req, { verifier, legacySecret, mode, bodyBindMode })`: a key-signed call is judged by the key
/// and never falls back to the shared secret. `body_bind` defaults to `Require` in the TypeScript.
pub fn verify_request(
    req: &Incoming<'_>,
    verifier: Option<&ServiceVerifier>,
    legacy_secret: Option<&str>,
    mode: Mode,
    body_bind: BodyBind,
    now: i64,
) -> RequestAuth {
    let none = RequestAuth {
        service: None,
        scheme: None,
        rejected: None,
    };
    let refused = |reason| RequestAuth {
        rejected: Some(reason),
        ..none.clone()
    };
    if let Some(v) = verifier.filter(|_| V3_HEADERS.iter().any(|h| req.has(h))) {
        match v.verify(req) {
            V3Outcome::Accepted { service, .. } => {
                return RequestAuth {
                    service: Some(service),
                    scheme: Some("keypair"),
                    rejected: None,
                };
            }
            V3Outcome::Rejected(reason) => return refused(reason),
            V3Outcome::Absent => {}
        }
    }
    if !req.has(SERVICE_SIGNATURE_HEADER) {
        return none;
    }
    if mode == Mode::Keypair {
        return refused("legacy-refused");
    }
    let Some(secret) = legacy_secret.filter(|s| !s.is_empty()) else {
        return none;
    };
    match verify_legacy(req, secret, body_bind, now) {
        Ok(service) => RequestAuth {
            service: Some(service),
            scheme: Some("shared"),
            rejected: None,
        },
        Err(reason) => refused(reason),
    }
}

/// The digest a signer sends for `body`, for a test building a request.
pub fn digest_of(body: &str) -> String {
    body_digest(body)
}

#[cfg(test)]
mod tests {
    #![allow(
        clippy::unwrap_used,
        clippy::expect_used,
        reason = "a test: a failure is the point"
    )]
    use super::*;
    use crate::s2s::{ServiceSigner, legacy_headers};
    use std::sync::Arc;

    const SECRET: &str = "an-internal-service-secret-long-enough";
    const NOW: i64 = 1_795_046_400;

    fn now() -> i64 {
        NOW
    }

    fn incoming<'a>(headers: &'a [(String, String)], body: &'a str) -> Incoming<'a> {
        Incoming {
            method: "POST",
            url: "/internal/x",
            headers,
            body: Some(body.as_bytes()),
        }
    }

    #[test]
    fn a_shared_secret_call_is_accepted_bound_to_its_body_and_refused_on_another() {
        let headers = legacy_headers("svc-token", SECRET, "{\"a\":1}", NOW).unwrap();
        let ok = verify_request(
            &incoming(&headers, "{\"a\":1}"),
            None,
            Some(SECRET),
            Mode::Dual,
            BodyBind::Require,
            NOW,
        );
        assert_eq!(ok.service.as_deref(), Some("svc-token"));
        assert_eq!(ok.scheme, Some("shared"));
        let tampered = verify_request(
            &incoming(&headers, "{\"a\":2}"),
            None,
            Some(SECRET),
            Mode::Dual,
            BodyBind::Require,
            NOW,
        );
        assert_eq!(tampered.rejected, Some("body-mismatch"));
        let stale = verify_request(
            &incoming(&headers, "{\"a\":1}"),
            None,
            Some(SECRET),
            Mode::Dual,
            BodyBind::Require,
            NOW + 301,
        );
        assert_eq!(stale.rejected, Some("stale"));
        let keypair = verify_request(
            &incoming(&headers, "{\"a\":1}"),
            None,
            Some(SECRET),
            Mode::Keypair,
            BodyBind::Require,
            NOW,
        );
        assert_eq!(keypair.rejected, Some("legacy-refused"));
        let wrong = verify_request(
            &incoming(&headers, "{\"a\":1}"),
            None,
            Some("another-internal-secret-long-enough!"),
            Mode::Dual,
            BodyBind::Require,
            NOW,
        );
        assert_eq!(wrong.rejected, Some("bad-signature"));
    }

    #[test]
    fn no_credentials_is_no_caller_not_a_refusal() {
        let none = verify_request(
            &incoming(&[], ""),
            None,
            Some(SECRET),
            Mode::Dual,
            BodyBind::Require,
            NOW,
        );
        assert_eq!(
            none,
            RequestAuth {
                service: None,
                scheme: None,
                rejected: None
            }
        );
    }

    fn keyring_and_signer() -> (Vec<KeyringEntry>, ServiceSigner) {
        use ed25519_dalek::SigningKey;
        use ed25519_dalek::pkcs8::EncodePrivateKey as _;
        let key = SigningKey::from_bytes(&[7u8; 32]);
        let der = key.to_pkcs8_der().unwrap();
        let private = URL_SAFE_NO_PAD.encode(der.as_bytes());
        let keyring = vec![KeyringEntry {
            kid: "svc-token.k1".to_owned(),
            svc: "svc-token".to_owned(),
            use_: "s2s".to_owned(),
            x: URL_SAFE_NO_PAD.encode(key.verifying_key().as_bytes()),
        }];
        let signer = ServiceSigner::new("svc-token", "svc-token.k1", &private, &keyring)
            .unwrap()
            .with_sources(Arc::new(now), Arc::new(|| Some([1u8; 16])));
        (keyring, signer)
    }

    #[test]
    fn a_key_signed_call_is_accepted_once_and_a_replay_refused() {
        let (keyring, signer) = keyring_and_signer();
        let ctx = SignedContext {
            content_type: Some("application/json".to_owned()),
            ..SignedContext::default()
        };
        let mut headers = signer
            .headers("svc-academy", "POST", "/internal/x", "{}", &ctx)
            .unwrap();
        headers.push(("content-type".to_owned(), "application/json".to_owned()));
        let verifier = ServiceVerifier::new("svc-academy", &keyring, now).unwrap();
        let req = incoming(&headers, "{}");
        assert_eq!(
            verifier.verify(&req),
            V3Outcome::Accepted {
                service: "svc-token".to_owned(),
                kid: "svc-token.k1".to_owned()
            }
        );
        assert_eq!(verifier.verify(&req), V3Outcome::Rejected("replay"));
        let other = ServiceVerifier::new("svc-bank", &keyring, now).unwrap();
        assert_eq!(other.verify(&req), V3Outcome::Rejected("wrong-audience"));
        let fresh = ServiceVerifier::new("svc-academy", &keyring, now).unwrap();
        assert_eq!(
            fresh.verify(&incoming(&headers, "{\"x\":1}")),
            V3Outcome::Rejected("body-mismatch")
        );
        let mut forged = headers.clone();
        forged.retain(|(k, _)| k != "content-type");
        forged.push(("content-type".to_owned(), "text/plain".to_owned()));
        let fresh = ServiceVerifier::new("svc-academy", &keyring, now).unwrap();
        assert_eq!(
            fresh.verify(&incoming(&forged, "{}")),
            V3Outcome::Rejected("bad-signature")
        );
        let partial = vec![(S2S_KID_HEADER.to_owned(), "svc-token.k1".to_owned())];
        assert_eq!(
            fresh.verify(&incoming(&partial, "{}")),
            V3Outcome::Rejected("malformed")
        );
        // A key-signed call that fails never falls back to the shared secret.
        let both: Vec<(String, String)> = partial
            .into_iter()
            .chain(legacy_headers("svc-token", SECRET, "{}", NOW).unwrap())
            .collect();
        let auth = verify_request(
            &incoming(&both, "{}"),
            Some(&fresh),
            Some(SECRET),
            Mode::Dual,
            BodyBind::Require,
            NOW,
        );
        assert_eq!(auth.rejected, Some("malformed"));
    }

    #[test]
    fn a_call_signed_before_boot_is_stale() {
        let (keyring, signer) = keyring_and_signer();
        let headers = signer
            .headers(
                "svc-academy",
                "POST",
                "/internal/x",
                "{}",
                &SignedContext::default(),
            )
            .unwrap();
        let verifier = ServiceVerifier::new("svc-academy", &keyring, now)
            .unwrap()
            .with_boot_second(NOW + 1);
        assert_eq!(
            verifier.verify(&incoming(&headers, "{}")),
            V3Outcome::Rejected("stale")
        );
    }
}
