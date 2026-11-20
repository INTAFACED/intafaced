//! The XP a certificate is worth and its publish (`certs/xp-policy.ts`, `xp-emit.ts`, `xp-publish.ts`).
//!
//! A priced certificate's grant publishes `intafaced.identity.xp.earned` (`xpEarned`, version 1) once per business key,
//! `academy.cert:cert:<user>:<cert>`; a revocation publishes the same amount negative under
//! `academy.cert:reverse:cert:<user>:<cert>`. Identity drops a repeat key, so publishing again is the recovery path when
//! the bus was down. svc-identity is the only rank writer and owns the stream; the Academy only publishes. XP is an
//! integer, never money: no ledger, no amount. A failed publish is reported, never thrown: the grant is the durable fact.

use service_kit::json::Json;
use service_kit::time::Instant;

use super::honesty;
use super::progress::{Grant, idempotency_key};
use crate::errors::Refusal;
use crate::ports::Bus;

/// `CERT_XP_V0`: only certificates in the catalogue carry XP.
pub const POLICIES: [(&str, &str); 1] = [("foundations-v1", "100")];
/// `CERT_XP_SOURCE_MODULE`.
pub const SOURCE_MODULE: &str = "academy";
/// `CERT_XP_ACTION`.
pub const ACTION: &str = "cert.granted";
/// `CERT_XP_REVERSE_ACTION`.
pub const REVERSE_ACTION: &str = "cert.revoked";
/// `xpEarned`'s subject and version in the event catalogue.
pub const SUBJECT: &str = "intafaced.identity.xp.earned";
pub const VERSION: i64 = 1;

/// `xpPolicyFor`: the decimal XP string a certificate is worth.
pub fn policy_for(cert_id: &str) -> Option<&'static str> {
    POLICIES
        .iter()
        .find(|(id, _)| *id == cert_id)
        .map(|(_, xp)| *xp)
}

fn digits(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

/// `XpEarnedIntent`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EarnedIntent {
    pub user_id: String,
    pub cert_id: String,
    pub xp_delta: String,
    pub idempotency_key: String,
}

/// `xpIntentFromGrant`: none for an unpriced certificate or a zero or malformed amount.
pub fn intent_from_grant(grant: &Grant) -> Result<Option<EarnedIntent>, Refusal> {
    honesty::assert_grant_path_honest(&grant.json())?;
    let Some(xp) = policy_for(&grant.cert_id) else {
        return Ok(None);
    };
    if !digits(xp) || xp == "0" {
        return Ok(None);
    }
    Ok(Some(EarnedIntent {
        user_id: grant.user_id.clone(),
        cert_id: grant.cert_id.clone(),
        xp_delta: xp.to_owned(),
        idempotency_key: format!(
            "academy.cert:{}",
            idempotency_key(&grant.user_id, &grant.cert_id)
        ),
    }))
}

/// `mayPublishXp`.
pub fn may_publish(intent: Option<&EarnedIntent>) -> bool {
    intent.is_some_and(|i| {
        digits(&i.xp_delta) && i.xp_delta != "0" && i.idempotency_key.starts_with("academy.cert:")
    })
}

/// `certXpDeltaToInt`: a positive safe integer, or none rather than a rounded guess.
pub fn delta_to_int(xp_delta: &str) -> Option<i64> {
    let raw = service_kit::schema::js_trim(xp_delta);
    if !digits(raw) {
        return None;
    }
    // `Number(raw)` is a safe integer only below 2^53.
    let n: i64 = raw.parse().ok()?;
    (n > 0 && n < (1i64 << 53)).then_some(n)
}

/// `CertXpSkipReason`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Skip {
    NoPolicy,
    NotPublishable,
    DeltaUnrepresentable,
    PublisherUnavailable,
    PublishFailed,
}

impl Skip {
    pub fn id(self) -> &'static str {
        match self {
            Skip::NoPolicy => "no_policy",
            Skip::NotPublishable => "not_publishable",
            Skip::DeltaUnrepresentable => "delta_unrepresentable",
            Skip::PublisherUnavailable => "publisher_unavailable",
            Skip::PublishFailed => "publish_failed",
        }
    }
}

/// `CertXpEmitResult`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Emit {
    Emitted {
        idempotency_key: String,
        xp_delta: i64,
    },
    Skipped(Skip),
}

impl Emit {
    /// The `certXpOut` union as the router answers it.
    pub fn json(&self) -> Json {
        match self {
            Emit::Emitted {
                idempotency_key,
                xp_delta,
            } => Json::obj([
                ("emitted", Json::Bool(true)),
                ("idempotencyKey", Json::str(idempotency_key.clone())),
                ("xpDelta", Json::int(*xp_delta)),
            ]),
            Emit::Skipped(s) => Json::obj([
                ("emitted", Json::Bool(false)),
                ("reason", Json::str(s.id())),
            ]),
        }
    }

    /// `isUnpricedCertXp`.
    pub fn is_unpriced(&self) -> bool {
        *self == Emit::Skipped(Skip::NoPolicy)
    }
}

/// `CertXpIntent`: the event payload and its business key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Intent {
    pub idempotency_key: String,
    pub user_id: String,
    pub action: &'static str,
    pub xp_delta: i64,
    pub cert_id: String,
}

impl Intent {
    /// `CertXpEventPayload`, in `xpEarned`'s schema order.
    pub fn payload(&self) -> Json {
        Json::obj([
            ("userId", Json::str(self.user_id.clone())),
            ("sourceModule", Json::str(SOURCE_MODULE)),
            ("action", Json::str(self.action)),
            ("xpDelta", Json::int(self.xp_delta)),
            (
                "meta",
                Json::obj([("certId", Json::str(self.cert_id.clone()))]),
            ),
        ])
    }
}

/// `certXpIntentFor(grant, direction)`: pure; the publishable intent or why it is not one.
pub fn intent_for(grant: &Grant, reverse: bool) -> Result<Result<Intent, Skip>, Refusal> {
    let Some(intent) = intent_from_grant(grant)? else {
        return Ok(Err(Skip::NoPolicy));
    };
    if !may_publish(Some(&intent)) {
        return Ok(Err(Skip::NotPublishable));
    }
    let Some(xp) = delta_to_int(&intent.xp_delta) else {
        return Ok(Err(Skip::DeltaUnrepresentable));
    };
    Ok(Ok(Intent {
        idempotency_key: if reverse {
            intent
                .idempotency_key
                .replacen("academy.cert:", "academy.cert:reverse:", 1)
        } else {
            intent.idempotency_key
        },
        user_id: intent.user_id,
        action: if reverse { REVERSE_ACTION } else { ACTION },
        xp_delta: if reverse { -xp } else { xp },
        cert_id: intent.cert_id,
    }))
}

/// `CertXpPublisher`: publishes one event and may not subscribe to anything.
pub trait Publisher: Send + Sync {
    /// Reported on `/ready` and `certXpPlane`. `none` means awards are not leaving this process.
    fn id(&self) -> &str;
    fn usable(&self) -> bool;
    fn publish(&self, grant: &Grant) -> Result<Emit, Refusal>;
    fn reverse(&self, grant: &Grant) -> Result<Emit, Refusal>;
}

/// `z.string().guid()`.
fn is_guid(s: &str) -> bool {
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

/// `crypto.randomUUID()`: a version-4 UUID from the platform CSPRNG.
pub fn random_uuid() -> Result<String, String> {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).map_err(|e| e.to_string())?;
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let hex: String = b.iter().map(|x| format!("{x:02x}")).collect();
    Ok(format!(
        "{}-{}-{}-{}-{}",
        hex.get(0..8).unwrap_or_default(),
        hex.get(8..12).unwrap_or_default(),
        hex.get(12..16).unwrap_or_default(),
        hex.get(16..20).unwrap_or_default(),
        hex.get(20..32).unwrap_or_default()
    ))
}

/// `buildEnvelope('xpEarned', payload, producer, { idempotencyKey })`: the payload checked against `xpEarned`'s schema,
/// then `{ id, subject, version, occurredAt, producer, idempotencyKey, payload }`.
pub fn envelope(intent: &Intent, producer: &str, occurred_at: Instant) -> Result<Json, String> {
    if !is_guid(&intent.user_id) {
        return Err(format!(
            "xpEarned payload from {producer} is invalid: userId must be a uuid"
        ));
    }
    Ok(Json::obj([
        ("id", Json::str(random_uuid()?)),
        ("subject", Json::str(SUBJECT)),
        ("version", Json::int(VERSION)),
        ("occurredAt", Json::str(occurred_at.iso())),
        ("producer", Json::str(producer)),
        ("idempotencyKey", Json::str(intent.idempotency_key.clone())),
        ("payload", intent.payload()),
    ]))
}

/// The publisher over the service's bus: `BusCertXpPublisher` when the bus is usable, else `NullCertXpPublisher`.
pub struct BusPublisher<'a> {
    pub bus: &'a dyn Bus,
    /// `SERVICE_NAME`: the envelope's producer.
    pub producer: String,
    /// The wall clock: the envelope's `occurredAt`.
    pub clock: fn() -> Instant,
}

impl BusPublisher<'_> {
    fn send(&self, grant: &Grant, decided: Result<Intent, Skip>) -> Result<Emit, Refusal> {
        let intent = match decided {
            Ok(i) => i,
            Err(s) => return Ok(Emit::Skipped(s)),
        };
        if !self.bus.usable() {
            return Ok(Emit::Skipped(Skip::PublisherUnavailable));
        }
        let sent = honesty::assert_may_publish_on_identity_graph(honesty::XP_IDENTITY_GRAPH_EVENT)
            .map_err(|r| format!("{r:?}"))
            .and_then(|()| envelope(&intent, &self.producer, (self.clock)()))
            .and_then(|env| self.bus.publish(SUBJECT, &intent.idempotency_key, &env));
        if let Err(err) = sent {
            // `onError`: `cert XP publish failed`.
            eprintln!(
                "{}",
                Json::obj([
                    ("level", Json::int(50)),
                    ("err", Json::str(err)),
                    ("certId", Json::str(grant.cert_id.clone())),
                    ("msg", Json::str("cert XP publish failed")),
                ])
                .compact()
            );
            return Ok(Emit::Skipped(Skip::PublishFailed));
        }
        Ok(Emit::Emitted {
            idempotency_key: intent.idempotency_key,
            xp_delta: intent.xp_delta,
        })
    }
}

impl Publisher for BusPublisher<'_> {
    fn id(&self) -> &str {
        if self.bus.usable() { "bus" } else { "none" }
    }
    fn usable(&self) -> bool {
        self.bus.usable()
    }
    fn publish(&self, grant: &Grant) -> Result<Emit, Refusal> {
        honesty::assert_grant_path_honest(&grant.json())?;
        honesty::decide_ledger_post();
        self.send(grant, intent_for(grant, false)?)
    }
    fn reverse(&self, grant: &Grant) -> Result<Emit, Refusal> {
        honesty::assert_grant_path_honest(&grant.json())?;
        self.send(grant, intent_for(grant, true)?)
    }
}

/// `certXpPlaneStatus(publisher)`.
pub fn plane_status(publisher: &dyn Publisher) -> Json {
    let mut policies: Vec<(&str, i64)> = POLICIES
        .iter()
        .filter_map(|(id, xp)| delta_to_int(xp).map(|n| (*id, n)))
        .collect();
    policies.sort_by(|a, b| a.0.cmp(b.0));
    Json::obj([
        ("publisherId", Json::str(publisher.id())),
        ("emitEnabled", Json::Bool(publisher.usable())),
        ("sourceModule", Json::str(SOURCE_MODULE)),
        ("action", Json::str(ACTION)),
        ("rankWriter", Json::str("svc-identity")),
        (
            "policies",
            Json::Array(
                policies
                    .into_iter()
                    .map(|(id, xp)| {
                        Json::obj([("certId", Json::str(id)), ("xpDelta", Json::int(xp))])
                    })
                    .collect(),
            ),
        ),
    ])
}

/// `xpPolicyCatalogConsistent`: every priced certificate is in the catalogue.
pub fn policy_catalog_consistent(catalog: &[super::catalog::CertDefinition]) -> bool {
    POLICIES
        .iter()
        .all(|(id, _)| catalog.iter().any(|c| c.id == *id))
}
