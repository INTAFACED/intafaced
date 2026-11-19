//! How svc-tax signs a call to another service (`packages/contracts/src/service-auth.ts`, `service-keys.ts`,
//! `service-auth-http.ts`, `s2s-env.ts`): the shared-secret form (v2, bound to the body) and, once S2S is on, the
//! service's own Ed25519 key (v3). Header names, values and their order are the TypeScript's, byte for byte
//! (`tests/s2s_vector.rs` replays a vector the TypeScript signer recorded).

use std::sync::Arc;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ed25519_dalek::pkcs8::DecodePrivateKey as _;
use ed25519_dalek::{Signer as _, SigningKey};
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};

use crate::json::{self, Json};

pub const SERVICE_HEADER: &str = "x-intafaced-service";
pub const SERVICE_TIMESTAMP_HEADER: &str = "x-intafaced-service-ts";
pub const SERVICE_SIGNATURE_HEADER: &str = "x-intafaced-service-sig";
pub const SERVICE_BODY_DIGEST_HEADER: &str = "x-intafaced-service-body";

pub const S2S_KID_HEADER: &str = "x-intafaced-s2s-kid";
pub const S2S_AUDIENCE_HEADER: &str = "x-intafaced-s2s-aud";
pub const S2S_TIMESTAMP_HEADER: &str = "x-intafaced-s2s-ts";
pub const S2S_NONCE_HEADER: &str = "x-intafaced-s2s-nonce";
pub const S2S_BODY_HEADER: &str = "x-intafaced-s2s-body";
pub const S2S_SIGNATURE_HEADER: &str = "x-intafaced-s2s-sig";

const MIN_SECRET_LENGTH: usize = 32;
const V2_DOMAIN: &str = "intafaced-s2s-v2";
const V3_DOMAIN: &str = "intafaced-s2s-v3\n";

/// `SERVICE_NAMES`: services that sign or receive S2S calls.
pub const SERVICE_NAMES: [&str; 22] = [
    "svc-academy",
    "svc-agents",
    "svc-bank",
    "svc-campaigns",
    "svc-edge",
    "svc-execution",
    "svc-fix",
    "svc-identity",
    "svc-ledger",
    "svc-market",
    "svc-matching",
    "svc-mining-pool",
    "svc-notify",
    "svc-ops",
    "svc-p2p",
    "svc-pay",
    "svc-quant",
    "svc-support",
    "svc-tax",
    "svc-token",
    "svc-trade",
    "svc-ws",
];

pub type Headers = Vec<(String, String)>;

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// `serviceBodyDigest`: SHA-256 of the body's UTF-8 bytes, lower-case hex.
pub fn body_digest(body: &str) -> String {
    hex(&Sha256::digest(body.as_bytes()))
}

/// `lengthPrefixed`: `<utf-8 byte length>:<value>\n`.
pub fn length_prefixed(value: &str) -> String {
    format!("{}:{value}\n", value.len())
}

/// JavaScript's `string.length`: UTF-16 code units.
pub fn js_length(s: &str) -> usize {
    s.encode_utf16().count()
}

/// `serviceAuthHeadersForBody(service, secret, body)` at `now_seconds`.
pub fn legacy_headers(
    service: &str,
    secret: &str,
    body: &str,
    now_seconds: i64,
) -> Result<Headers, String> {
    if secret.is_empty() || js_length(secret) < MIN_SECRET_LENGTH {
        return Err(format!(
            "signServiceCallWithBody: INTERNAL_SERVICE_SECRET must be at least {MIN_SECRET_LENGTH} characters. \
             Without it, service-to-service calls are unauthenticated and `ledger.post` accepts anyone (§2)."
        ));
    }
    let digest = body_digest(body);
    let preimage = format!(
        "{V2_DOMAIN}\n{}{}{}",
        length_prefixed(service),
        length_prefixed(&now_seconds.to_string()),
        length_prefixed(&digest)
    );
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).map_err(|e| e.to_string())?;
    mac.update(preimage.as_bytes());
    let signature = hex(&mac.finalize().into_bytes());
    Ok(vec![
        (SERVICE_HEADER.to_owned(), service.to_owned()),
        (SERVICE_TIMESTAMP_HEADER.to_owned(), now_seconds.to_string()),
        (SERVICE_BODY_DIGEST_HEADER.to_owned(), digest),
        (SERVICE_SIGNATURE_HEADER.to_owned(), signature),
    ])
}

/// One entry of the public keyring.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyringEntry {
    pub kid: String,
    pub svc: String,
    pub use_: String,
    pub x: String,
}

/// `KID`: `^[a-z0-9-]{1,40}\.[a-z0-9]{1,16}$`.
fn is_kid(s: &str) -> bool {
    let Some((owner, label)) = s.split_once('.') else {
        return false;
    };
    let ok = |part: &str, max: usize, dash: bool| {
        (1..=max).contains(&part.len())
            && part
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || (dash && b == b'-'))
    };
    ok(owner, 40, true) && ok(label, 16, false)
}

/// `isCanonicalKey`: 43 base64url characters that decode to 32 bytes and re-encode to the same text.
pub fn canonical_key(x: &str) -> Option<[u8; 32]> {
    if x.len() != 43
        || !x
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return None;
    }
    let raw = URL_SAFE_NO_PAD.decode(x).ok()?;
    if URL_SAFE_NO_PAD.encode(&raw) != x {
        return None;
    }
    raw.try_into().ok()
}

/// `parseKeyring`: the public keyring, refusing anything unexpected with the TypeScript's message.
pub fn parse_keyring(text: &str) -> Result<Vec<KeyringEntry>, String> {
    let parsed = json::parse(text).map_err(|_| "S2S keyring is not valid JSON".to_owned())?;
    let Some(Json::Array(keys)) = parsed.get("keys") else {
        return Err("S2S keyring must be {\"keys\":[...]}".to_owned());
    };
    let mut out: Vec<KeyringEntry> = Vec::new();
    for raw in keys {
        let Json::Object(fields) = raw else {
            return Err("S2S keyring entry must be an object".to_owned());
        };
        if fields
            .iter()
            .any(|(k, _)| !["kid", "svc", "use", "x"].contains(&k.as_str()))
        {
            return Err("S2S keyring entry has an unexpected field; private key material never belongs in the keyring".to_owned());
        }
        let text = |k: &str| match raw.get(k) {
            Some(Json::String(s)) => Some(s.clone()),
            _ => None,
        };
        let svc = text("svc").filter(|s| SERVICE_NAMES.contains(&s.as_str()));
        let Some(svc) = svc else {
            return Err("S2S keyring entry names an unknown service".to_owned());
        };
        let Some(use_) = text("use").filter(|u| u == "s2s" || u == "principal") else {
            return Err("S2S keyring entry use must be s2s or principal".to_owned());
        };
        let Some(kid) = text("kid").filter(|k| is_kid(k) && k.starts_with(&format!("{svc}.")))
        else {
            return Err(
                "S2S key id must look like <service>.<label> and name its own service".to_owned(),
            );
        };
        let Some(x) = text("x").filter(|x| canonical_key(x).is_some()) else {
            return Err(
                "S2S public key must be canonical base64url of exactly 32 bytes".to_owned(),
            );
        };
        if out.iter().any(|e| e.kid == kid) {
            return Err("S2S keyring has a duplicate key id".to_owned());
        }
        if out.iter().any(|e| e.x == x) {
            return Err("S2S keyring lists the same public key twice".to_owned());
        }
        if out
            .iter()
            .filter(|e| e.svc == svc && e.use_ == use_)
            .count()
            >= 2
        {
            return Err("S2S keyring allows at most two keys per service and use".to_owned());
        }
        out.push(KeyringEntry { kid, svc, use_, x });
    }
    Ok(out)
}

/// What a v3 signature commits to besides the body (`ServiceSignedContext`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SignedContext {
    pub principal: Option<String>,
    pub principal_signature: Option<String>,
    pub region: Option<String>,
    pub content_type: Option<String>,
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

pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;
pub type NonceSource = Arc<dyn Fn() -> Option<[u8; 16]> + Send + Sync>;

/// The process clock, in whole seconds (`Math.floor(Date.now() / 1000)`).
pub fn system_seconds() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_secs()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

/// `randomBytes(16)`. `None` when the system's randomness cannot be read: the call is then refused, never signed with a
/// predictable nonce.
fn random_nonce() -> Option<[u8; 16]> {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).ok().map(|()| b)
}

/// `createServiceSigner`: the service's own key, refused unless the keyring publishes its public half for this service.
pub struct ServiceSigner {
    pub service: String,
    pub kid: String,
    key: SigningKey,
    clock: Clock,
    nonce: NonceSource,
}

impl ServiceSigner {
    pub fn new(
        service: &str,
        kid: &str,
        private_key: &str,
        keyring: &[KeyringEntry],
    ) -> Result<ServiceSigner, String> {
        let entry = keyring.iter().find(|k| k.kid == kid);
        let Some(entry) = entry.filter(|e| e.svc == service && e.use_ == "s2s") else {
            return Err(format!(
                "{service}: no s2s key {kid} for this service in the keyring"
            ));
        };
        let not_pkcs8 =
            || format!("{service}: S2S private key is not a PKCS8 Ed25519 key, base64url");
        // Buffer.from(text, 'base64url') skips characters outside the alphabet and padding; so does this.
        let cleaned: String = private_key
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
            .collect();
        let der = base64::engine::GeneralPurpose::new(
            &base64::alphabet::URL_SAFE,
            base64::engine::GeneralPurposeConfig::new()
                .with_decode_allow_trailing_bits(true)
                .with_decode_padding_mode(base64::engine::DecodePaddingMode::Indifferent),
        )
        .decode(cleaned)
        .map_err(|_| not_pkcs8())?;
        let key = SigningKey::from_pkcs8_der(&der).map_err(|_| not_pkcs8())?;
        if URL_SAFE_NO_PAD.encode(key.verifying_key().as_bytes()) != entry.x {
            return Err(format!(
                "{service}: S2S private key does not match the published key {kid}"
            ));
        }
        Ok(ServiceSigner {
            service: service.to_owned(),
            kid: kid.to_owned(),
            key,
            clock: Arc::new(system_seconds),
            nonce: Arc::new(random_nonce),
        })
    }

    /// Pins the clock and the nonce, so a test can compare signatures byte for byte.
    pub fn with_sources(mut self, clock: Clock, nonce: NonceSource) -> ServiceSigner {
        self.clock = clock;
        self.nonce = nonce;
        self
    }

    /// `signer.headers({ audience, method, url, body, context })`. `target` is `url.pathname + url.search`.
    pub fn headers(
        &self,
        audience: &str,
        method: &str,
        target: &str,
        body: &str,
        context: &SignedContext,
    ) -> Result<Headers, String> {
        let ts = (self.clock)().to_string();
        let nonce = URL_SAFE_NO_PAD
            .encode((self.nonce)().ok_or_else(|| "randomBytes failed: no S2S nonce".to_owned())?);
        let digest = body_digest(body);
        let preimage = format!(
            "{V3_DOMAIN}{}",
            [
                self.kid.as_str(),
                audience,
                &method.to_uppercase(),
                target,
                &ts,
                &nonce,
                &digest,
                &context_digest(context),
            ]
            .iter()
            .map(|f| length_prefixed(f))
            .collect::<String>()
        );
        let signature = URL_SAFE_NO_PAD.encode(self.key.sign(preimage.as_bytes()).to_bytes());
        Ok(vec![
            (S2S_KID_HEADER.to_owned(), self.kid.clone()),
            (S2S_AUDIENCE_HEADER.to_owned(), audience.to_owned()),
            (S2S_TIMESTAMP_HEADER.to_owned(), ts),
            (S2S_NONCE_HEADER.to_owned(), nonce),
            (S2S_BODY_HEADER.to_owned(), digest),
            (S2S_SIGNATURE_HEADER.to_owned(), signature),
        ])
    }
}

/// `ServiceAuthMode`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Dual,
    Keypair,
}

/// `s2sFromEnv`'s outcome as svc-tax uses it: a signer and its mode, or nothing (the shared secret alone).
pub struct S2s {
    pub signer: Option<Arc<ServiceSigner>>,
    pub mode: Option<Mode>,
}

/// `s2sFromEnv(env, self)`. The verifier it also builds is not kept: svc-tax receives no service calls.
pub fn s2s_from_env(
    mode: &str,
    keyring: Option<&str>,
    kid: Option<&str>,
    key: Option<&str>,
    service: &str,
) -> Result<S2s, String> {
    if mode == "off" {
        return Ok(S2s {
            signer: None,
            mode: None,
        });
    }
    let parsed_mode = match mode {
        "dual" => Mode::Dual,
        "keypair" => Mode::Keypair,
        _ => return Err("S2S_AUTH_MODE must be exactly off, dual or keypair".to_owned()),
    };
    let Some(ring) = keyring.filter(|k| !crate::money::js_trim(k).is_empty()) else {
        return Err(format!("S2S_AUTH_MODE={mode} needs S2S_KEYRING"));
    };
    let keyring = parse_keyring(ring)?;
    if kid.is_some() != key.is_some() {
        return Err(
            "S2S_SIGNING_KID and S2S_SIGNING_KEY are set together or not at all".to_owned(),
        );
    }
    let signer = match (kid, key) {
        (Some(kid), Some(key)) => Some(Arc::new(ServiceSigner::new(service, kid, key, &keyring)?)),
        _ => None,
    };
    Ok(S2s {
        signer,
        mode: Some(parsed_mode),
    })
}

/// `serviceCallSigner({ service, audience, legacySecret, s2s })`: the headers for one JSON call to one service.
#[derive(Clone)]
pub struct CallSigner {
    pub service: String,
    pub audience: String,
    pub legacy_secret: String,
    pub s2s: Option<(Arc<ServiceSigner>, Mode)>,
    pub clock: Clock,
}

impl CallSigner {
    pub fn new(
        service: &str,
        audience: &str,
        legacy_secret: &str,
        s2s: Option<(Arc<ServiceSigner>, Mode)>,
    ) -> CallSigner {
        CallSigner {
            service: service.to_owned(),
            audience: audience.to_owned(),
            legacy_secret: legacy_secret.to_owned(),
            s2s,
            clock: Arc::new(system_seconds),
        }
    }

    /// The headers for `payload` sent as `method` to `target` (`url.pathname + url.search`) with `content_type`.
    pub fn sign(
        &self,
        payload: &str,
        method: &str,
        target: &str,
        content_type: &str,
    ) -> Result<Headers, String> {
        let Some((signer, mode)) = &self.s2s else {
            return legacy_headers(&self.service, &self.legacy_secret, payload, (self.clock)());
        };
        let context = SignedContext {
            content_type: Some(content_type.to_owned()),
            ..SignedContext::default()
        };
        let mut headers = signer.headers(&self.audience, method, target, payload, &context)?;
        // `{ ...headers, ...serviceAuthHeadersForBody(signer.service, ...) }`, only while the shared secret is still sent.
        if *mode == Mode::Dual && !self.legacy_secret.is_empty() {
            headers.extend(legacy_headers(
                &signer.service,
                &self.legacy_secret,
                payload,
                (self.clock)(),
            )?);
        }
        Ok(headers)
    }
}
