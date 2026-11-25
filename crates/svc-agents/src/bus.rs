//! The bus events svc-agents takes (`services/svc-agents/src/index.ts`): each one's catalog entry
//! (`packages/events/src/catalog.ts`), its durable consumer, and the work a delivery does. The kit's `consume` pulls,
//! acks only once the work has committed, and naks a failure so JetStream delivers it again; the work is idempotent in
//! Postgres, so a redelivery changes nothing.

use service_kit::json::Json;
use service_kit::nats::{ConsumerSpec, Envelope};
use service_kit::pg::Pool;

use crate::own::automation::{AutoRuns, SUBJECT_PREFIX, TriggerEvent, deliver_trigger_event};
use crate::own::freeze_applied::{on_self_freeze_applied, on_support_account_frozen};

/// One event svc-agents consumes: its `defineEvent(service, entity, verb, version, …)` and the durable it is taken
/// under.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Taken {
    /// The catalog's export name.
    pub event: &'static str,
    pub service: &'static str,
    pub entity: &'static str,
    pub verb: &'static str,
    pub version: i64,
    pub durable: &'static str,
}

impl Taken {
    /// `subject(service, entity, verb)`: `intafaced.<service>.<entity>.<verb>`.
    pub fn subject(&self) -> String {
        format!(
            "{SUBJECT_PREFIX}.{}.{}.{}",
            self.service, self.entity, self.verb
        )
    }

    /// The durable consumer on the stream of the event's service (`NATS_STREAM_PREFIX`).
    pub fn spec(&self, prefix: &str) -> ConsumerSpec {
        ConsumerSpec::new(
            self.service,
            prefix,
            &self.subject(),
            self.version,
            self.durable,
        )
    }
}

/// `subscribeSelfFreezeApplied`: the owner's own freeze (J-wallet-13 #1).
pub const SELF_FREEZE_APPLIED: Taken = Taken {
    event: "selfFreezeApplied",
    service: "identity",
    entity: "self_freeze",
    verb: "frozen",
    version: 1,
    durable: "agents-identity-self-freeze-frozen",
};

/// `supportAccountFrozen`: a support agent froze the customer's account from their request (J-support-public-20 #7).
pub const SUPPORT_ACCOUNT_FROZEN: Taken = Taken {
    event: "supportAccountFrozen",
    service: "identity",
    entity: "support_account_freeze",
    verb: "frozen",
    version: 1,
    durable: "agents-identity-support-account-freeze-frozen",
};

/// The own agents' event triggers on a settled fill (AG-sessions-02).
pub const FILL_SETTLED: Taken = Taken {
    event: "fillSettled",
    service: "trade",
    entity: "fill",
    verb: "settled",
    version: 1,
    durable: "agents-own-trigger-fill-settled",
};

/// Every event the binary takes.
pub const TAKEN: [Taken; 3] = [SELF_FREEZE_APPLIED, SUPPORT_ACCOUNT_FROZEN, FILL_SETTLED];

/// A payload string field the work reads: present and not blank, or the delivery is refused (and nak'd), as the
/// catalog's schema refuses it.
fn field<'a>(payload: &'a Json, k: &str) -> Result<&'a str, String> {
    match payload.get(k) {
        Some(Json::String(s)) if !s.trim().is_empty() => Ok(s),
        _ => Err(format!("payload: {k} is missing")),
    }
}

/// One `selfFreezeApplied` delivery: the freeze applied once under its id, in one transaction.
pub fn on_self_freeze(pool: &Pool, env: &Envelope) -> Result<(), String> {
    for k in ["userId", "freezeId", "since"] {
        field(&env.payload, k)?;
    }
    on_self_freeze_applied(pool, &env.payload)
        .map(|_| ())
        .map_err(|e| format!("self-freeze not applied: {e:?}"))
}

/// One `supportAccountFrozen` delivery: the support agent's freeze applied once under its id, in one transaction.
pub fn on_support_freeze(pool: &Pool, env: &Envelope) -> Result<(), String> {
    for k in ["userId", "freezeId", "since"] {
        field(&env.payload, k)?;
    }
    on_support_account_frozen(pool, &env.payload)
        .map(|_| ())
        .map_err(|e| format!("support account freeze not applied: {e:?}"))
}

/// One `fillSettled` delivery: `deliverTriggerEvent` for the fill's owner, the run row under the fill's id its
/// seen-set.
pub fn on_fill_settled(runs: &AutoRuns<'_>, env: &Envelope) -> Result<(), String> {
    let p = &env.payload;
    deliver_trigger_event(
        runs,
        &TriggerEvent {
            subject: &env.subject,
            user_id: field(p, "userId")?,
            event_id: field(p, "fillId")?,
            envelope_id: &env.id,
            occurred_at: field(p, "ts")?,
        },
    )
    .map(|_| ())
    .map_err(|e| format!("trigger delivery failed: {e:?}"))
}
