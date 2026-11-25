//! The engine's events on JetStream (`JetStreamEventBus`): each one as `buildEnvelope` writes it, on its catalog
//! subject, with its idempotency key as the `Nats-Msg-Id` so the stream drops a repeat inside its window.

use std::sync::Arc;

use service_kit::json::Json;
use service_kit::nats::JetStream;
use service_kit::time::Instant;

use crate::engine::EventBus;

/// The stream svc-matching owns (`ownedStreams: ['matching']`).
pub const STREAM_SERVICE: &str = "matching";

/// The catalog subject of an engine event (`packages/events/src/catalog.ts`): `intafaced.<service>.<entity>.<verb>`
/// (`subject.ts`), inside the stream's `intafaced.matching.>` (`tests/bus.rs`).
pub fn subject_of(name: &str) -> Option<&'static str> {
    match name {
        "orderAccepted" => Some("intafaced.matching.order.accepted"),
        "orderFilled" => Some("intafaced.matching.order.filled"),
        "orderCancelled" => Some("intafaced.matching.order.cancelled"),
        "orderTriggered" => Some("intafaced.matching.order.triggered"),
        "spreadFilled" => Some("intafaced.matching.spread.filled"),
        _ => None,
    }
}

/// `createEnvelope`: id, subject, version, occurredAt, producer, idempotencyKey, payload, in that order.
pub fn envelope(
    id: &str,
    subject: &str,
    at: Instant,
    producer: &str,
    key: &str,
    payload: &Json,
) -> Json {
    Json::obj([
        ("id", Json::str(id)),
        ("subject", Json::str(subject)),
        ("version", Json::int(1)),
        ("occurredAt", Json::str(at.iso())),
        ("producer", Json::str(producer)),
        ("idempotencyKey", Json::str(key)),
        ("payload", payload.clone()),
    ])
}

/// `crypto.randomUUID()`.
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

/// The engine's bus on a JetStream connection.
pub struct JetStreamEvents {
    pub js: Arc<JetStream>,
    /// `SERVICE_NAME`.
    pub producer: String,
    /// Milliseconds since the epoch: each envelope's `occurredAt`.
    pub clock: fn() -> i64,
}

impl EventBus for JetStreamEvents {
    fn publish(&mut self, name: &str, payload: &Json, idempotency_key: &str) -> Result<(), String> {
        let subject =
            subject_of(name).ok_or_else(|| format!("event {name} is not in the catalog"))?;
        let env = envelope(
            &random_uuid()?,
            subject,
            Instant((self.clock)()),
            &self.producer,
            idempotency_key,
            payload,
        );
        self.js
            .publish(subject, idempotency_key, env.compact().as_bytes())
            .map(|_| ())
            .map_err(|e| e.0)
    }
}
