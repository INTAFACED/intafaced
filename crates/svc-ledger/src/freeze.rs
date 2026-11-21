//! The posting freeze: the switch in `posting_freeze` and the `ledgerFreezeUpdated` intent written beside it
//! (`services/svc-ledger/src/ledger/freeze.ts`), and the relay that publishes each intent once it committed
//! (`service.ts` `publishUnpublishedFreezeOutbox`, `ledgerFreezeUpdatedPayload`).
//!
//! - A freeze always carries a reason and an actor. Frozen already by the same reason and actor, nothing moves (no
//!   `changed_at` bump, no second intent); frozen by another, refused with `ledger.freeze_attributed`: the first
//!   reason stands.
//! - A thaw names two people: the caller and a confirming operator who is neither the caller nor the one who froze the
//!   book (`unfreezeRefusal`, refused as `missing_operator`). A thaw of an open book is a no-op.
//! - When the switch moves, its intent commits in the same transaction, numbered by `switch_seq` under the singleton
//!   row lock; its key is `ledger.freeze:seq:<n>`. Publishing comes after the commit: a failed publish leaves the row
//!   for the next call or the outbox recovery, which publish it without moving the switch again.

use std::sync::Mutex;

use postgres::{GenericClient, IsolationLevel};
use service_kit::json::{self, Json};
use service_kit::time::zod_datetime;

use crate::boot::Relay;
use crate::db::{Store, StoreError, transaction, with_client};
use crate::status::{FREEZE_COLUMNS, FREEZE_MISSING, FreezeState, freeze_row};

/// `ledger.freeze_attributed`: frozen already, by another reason or actor.
pub const FREEZE_ATTRIBUTED: &str = "ledger.freeze_attributed";
/// `MISSING_OPERATOR` (`dual-control.ts`): a thaw without a distinct second person.
pub const MISSING_OPERATOR: &str = "missing_operator";
/// `ledger.outbox_payload`: an outbox row that is not the event it claims to be.
pub const OUTBOX_PAYLOAD: &str = "ledger.outbox_payload";
/// `ledgerFreezeUpdated`'s subject and version in the event catalogue.
pub const SUBJECT: &str = "intafaced.ledger.freeze.updated";
pub const VERSION: i64 = 1;
/// `unpublishedFreezeOutbox(sql, limit = 100)`.
pub const OUTBOX_BATCH: i64 = 100;
/// The idempotency key's prefix (`freezeEventKey`).
const KEY_PREFIX: &str = "ledger.freeze:";

/// `FreezeCommand`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Command<'a> {
    Freeze {
        reason: &'a str,
        actor: &'a str,
    },
    Thaw {
        actor: &'a str,
        confirm_operator_id: Option<&'a str>,
    },
}

/// `canonicalOperatorId`: trimmed and hex case folded; blank is nobody.
fn canonical(raw: Option<&str>) -> Option<String> {
    raw.map(|r| service_kit::schema::js_trim(r).to_lowercase())
        .filter(|r| !r.is_empty())
}

/// `dualControlRefuse(operatorId, confirmOperatorId)`: why two ids are not two people, or none.
pub fn dual_control_refuse(operator: Option<&str>, confirm: Option<&str>) -> Option<&'static str> {
    let actor = canonical(operator);
    let confirm = canonical(confirm);
    match (actor, confirm) {
        (None, _) => Some("operator identity is required; the ledger does not invent a caller"),
        (Some(_), None) => Some(
            "confirming operator identity is required; the ledger does not invent a second caller",
        ),
        (Some(a), Some(c)) if a == c => Some(
            "confirming operator must be a distinct identity; the ledger does not invent a second caller",
        ),
        _ => None,
    }
}

/// `unfreezeRefusal(current, actor, confirmOperatorId)`: an open book is never refused; a frozen one needs two
/// distinct operators, and the confirming one is not the one who froze it.
pub fn unfreeze_refusal(
    current: &FreezeState,
    actor: Option<&str>,
    confirm: Option<&str>,
) -> Option<&'static str> {
    if !current.frozen {
        return None;
    }
    if let Some(refused) = dual_control_refuse(actor, confirm) {
        return Some(refused);
    }
    let confirm = canonical(confirm).unwrap_or_default();
    let freezer = canonical(current.actor.as_deref()).unwrap_or_default();
    (!freezer.is_empty() && confirm == freezer)
        .then_some("the operator who froze posting cannot be the one who clears it")
}

/// `attributedOverwriteError`.
fn attributed(current: &FreezeState, reason: &str, actor: &str) -> StoreError {
    StoreError::new(
        format!(
            "Ledger already frozen by {}: {} — refusing to overwrite with {actor}: {reason} (STOP §4.2b #3)",
            current.actor.as_deref().unwrap_or("unknown"),
            current.reason.as_deref().unwrap_or("no reason"),
        ),
        Some(FREEZE_ATTRIBUTED),
    )
}

/// `writeFreeze(sql, next)`: the switch, and its intent when it moved, in one transaction; what the database now says
/// and whether it moved. A refused thaw is a `StoreError` coded `missing_operator`.
pub fn write(store: &Store, next: Command<'_>) -> Result<(FreezeState, bool), StoreError> {
    transaction(store.pool()?, IsolationLevel::ReadCommitted, |tx| {
        write_in(tx, next)
    })
}

/// `writeFreezeInTransaction(tx, next)`: [`write`] inside a transaction the caller holds open, so the switch and its
/// intent commit with whatever else that transaction writes (reconciliation's mismatch run row).
pub fn write_in(
    tx: &mut impl GenericClient,
    next: Command<'_>,
) -> Result<(FreezeState, bool), StoreError> {
    let rows = tx.query(
        &format!("SELECT {FREEZE_COLUMNS} FROM ledger.posting_freeze WHERE id = true FOR UPDATE"),
        &[],
    )?;
    let Some(row) = rows.first() else {
        return Err(StoreError::new(
            FREEZE_MISSING,
            Some("ledger.uninitialised"),
        ));
    };
    let current = freeze_row(row)?;
    let (frozen, reason, actor) = match next {
        Command::Freeze { reason, actor } => {
            if current.frozen {
                // `resolveAttributedFreeze`.
                if current.reason.as_deref() == Some(reason)
                    && current.actor.as_deref() == Some(actor)
                {
                    return Ok((current, false));
                }
                return Err(attributed(&current, reason, actor));
            }
            (true, Some(reason), actor)
        }
        Command::Thaw {
            actor,
            confirm_operator_id,
        } => {
            if !current.frozen {
                return Ok((current, false));
            }
            if let Some(refused) = unfreeze_refusal(&current, Some(actor), confirm_operator_id) {
                return Err(StoreError::new(refused, Some(MISSING_OPERATOR)));
            }
            (false, None, actor)
        }
    };
    let updated = tx.query_one(
        &format!(
            "UPDATE ledger.posting_freeze
                SET frozen = $1, reason = $2, actor = $3, changed_at = clock_timestamp()
              WHERE id = true
             RETURNING {FREEZE_COLUMNS}"
        ),
        &[&frozen, &reason, &actor],
    )?;
    let state = freeze_row(&updated)?;
    // `freezeOutboxPayload`: the JS instant the column returned; `actor ?? 'unknown'`.
    let payload = Json::Object(vec![
        ("frozen".to_owned(), Json::Bool(state.frozen)),
        (
            "reason".to_owned(),
            state.reason.clone().map_or(Json::Null, Json::String),
        ),
        (
            "actor".to_owned(),
            Json::str(state.actor.clone().unwrap_or_else(|| "unknown".to_owned())),
        ),
        ("changedAt".to_owned(), Json::str(state.changed_at.clone())),
    ])
    .compact();
    // The order is allocated under the singleton row lock: an earlier start cannot take an earlier place.
    tx.execute(
        "WITH next_switch AS (
           SELECT nextval(pg_get_serial_sequence('ledger.ledger_freeze_outbox', 'switch_seq')) AS seq
         )
         INSERT INTO ledger.ledger_freeze_outbox (switch_seq, idempotency_key, payload)
         SELECT seq, 'ledger.freeze:seq:' || seq::text, $1::text::jsonb
           FROM next_switch",
        &[&payload],
    )?;
    Ok((state, true))
}

/// The event bus's publish side (`JetStreamEventBus.publish`): one envelope on a subject, deduplicated by `msg_id`.
pub trait Bus: Send + Sync {
    fn publish(&self, subject: &str, msg_id: &str, envelope: &Json) -> Result<(), String>;
}

/// The bus over NATS JetStream, in the ledger's own stream.
pub struct JetStreamBus(pub service_kit::nats::JetStream);

impl Bus for JetStreamBus {
    fn publish(&self, subject: &str, msg_id: &str, envelope: &Json) -> Result<(), String> {
        self.0
            .publish(subject, msg_id, envelope.compact().as_bytes())
            .map(|_| ())
            .map_err(|e| e.0)
    }
}

/// `MemoryEventBus`: keeps what it was given, or refuses every publish while `failing` is set (a bus that is down).
#[derive(Default)]
pub struct MemoryBus {
    pub sent: Mutex<Vec<(String, String, Json)>>,
    pub failing: std::sync::atomic::AtomicBool,
}

impl MemoryBus {
    /// The envelopes published on `subject`, in order.
    pub fn emitted(&self, subject: &str) -> Vec<Json> {
        self.sent
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .iter()
            .filter(|(s, _, _)| s == subject)
            .map(|(_, _, e)| e.clone())
            .collect()
    }
}

impl Bus for MemoryBus {
    fn publish(&self, subject: &str, msg_id: &str, envelope: &Json) -> Result<(), String> {
        if self.failing.load(std::sync::atomic::Ordering::SeqCst) {
            return Err("bus down".to_owned());
        }
        self.sent
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push((subject.to_owned(), msg_id.to_owned(), envelope.clone()));
        Ok(())
    }
}

fn outbox_error(id: &str, what: &str) -> StoreError {
    StoreError::new(
        format!("ledger_freeze_outbox {id} {what}"),
        Some(OUTBOX_PAYLOAD),
    )
}

fn holds_number(v: &Json) -> bool {
    match v {
        Json::Number(_) => true,
        Json::Array(items) => items.iter().any(holds_number),
        Json::Object(fields) => fields.iter().any(|(_, v)| holds_number(v)),
        _ => false,
    }
}

/// `ledgerFreezeUpdatedPayload(row)`, then the catalogue's check of the payload (`validatePayload`): the payload to
/// publish, or why the row is not a freeze event.
pub fn event_payload(id: &str, key: &str, payload: &Json) -> Result<Json, StoreError> {
    if !matches!(payload, Json::Object(_)) {
        return Err(outbox_error(id, "payload is not an object"));
    }
    if holds_number(payload) {
        return Err(outbox_error(id, "payload contains a JSON number"));
    }
    let Some(Json::Bool(frozen)) = payload.get("frozen") else {
        return Err(outbox_error(id, "frozen must be a boolean"));
    };
    let actor = match payload.get("actor") {
        Some(Json::String(a)) if !a.is_empty() => a.clone(),
        _ => return Err(outbox_error(id, "actor must be a non-empty string")),
    };
    let changed_at = match payload.get("changedAt") {
        Some(Json::String(c)) if !c.is_empty() => c.clone(),
        _ => return Err(outbox_error(id, "changedAt must be a string")),
    };
    let reason = match (frozen, payload.get("reason")) {
        (true, Some(Json::String(r))) if !r.is_empty() => Json::str(r.clone()),
        (true, _) => return Err(outbox_error(id, "freeze reason must be a non-empty string")),
        (false, Some(Json::Null)) => Json::Null,
        (false, _) => return Err(outbox_error(id, "thaw reason must be null")),
    };
    if !key.starts_with(KEY_PREFIX) || key.len() <= KEY_PREFIX.len() {
        return Err(outbox_error(
            id,
            "idempotency key is not a freeze event key",
        ));
    }
    // The catalogue's own check: a datetime with an offset.
    if zod_datetime(&changed_at, true).is_none() {
        return Err(StoreError::new(
            "ledgerFreezeUpdated payload is invalid: changedAt must be an ISO datetime",
            None,
        ));
    }
    Ok(Json::Object(vec![
        ("frozen".to_owned(), Json::Bool(*frozen)),
        ("reason".to_owned(), reason),
        ("actor".to_owned(), Json::str(actor)),
        ("changedAt".to_owned(), Json::str(changed_at)),
    ]))
}

/// `buildEnvelope('ledgerFreezeUpdated', payload, producer, { idempotencyKey })`.
pub fn envelope(
    producer: &str,
    key: &str,
    payload: Json,
    occurred_at_ms: i64,
) -> Result<Json, String> {
    event_envelope(SUBJECT, VERSION, producer, key, payload, occurred_at_ms)
}

/// `buildEnvelope(name, payload, producer, { idempotencyKey })` for any of the ledger's events, by its catalogue subject
/// and version: `createEnvelope`'s fields in its order.
pub fn event_envelope(
    subject: &str,
    version: i64,
    producer: &str,
    key: &str,
    payload: Json,
    occurred_at_ms: i64,
) -> Result<Json, String> {
    Ok(Json::obj([
        ("id", Json::str(service_kit::approvals::random_uuid()?)),
        ("subject", Json::str(subject)),
        ("version", Json::int(version)),
        (
            "occurredAt",
            Json::str(service_kit::time::Instant(occurred_at_ms).iso()),
        ),
        ("producer", Json::str(producer)),
        ("idempotencyKey", Json::str(key)),
        ("payload", payload),
    ]))
}

/// The `ledgerFreezeUpdated` relay: `publishUnpublishedFreezeOutbox`.
pub struct FreezeRelay<'a> {
    pub bus: &'a dyn Bus,
    /// `SERVICE_NAME`: the envelope's producer.
    pub producer: String,
    /// The wall clock in milliseconds: the envelope's `occurredAt`.
    pub now_ms: fn() -> i64,
}

impl Relay for FreezeRelay<'_> {
    /// Each unpublished intent, oldest switch first (100 at most): published under its stored key, then marked sent.
    /// The first failure stops the drain and leaves that row and the ones after it unsent.
    fn drain(&self, store: &Store) -> Result<usize, StoreError> {
        let rows = with_client(store.pool()?, |c| {
            Ok(c.query(
                "SELECT id::text, idempotency_key, payload::text
                   FROM ledger.ledger_freeze_outbox
                  WHERE published_at IS NULL
                  ORDER BY switch_seq ASC
                  LIMIT $1",
                &[&OUTBOX_BATCH],
            )?)
        })?;
        for row in &rows {
            let id: String = row.try_get(0)?;
            let key: String = row.try_get(1)?;
            let text: String = row.try_get(2)?;
            let payload =
                json::parse(&text).map_err(|_| outbox_error(&id, "payload is not an object"))?;
            let payload = event_payload(&id, &key, &payload)?;
            let env = envelope(&self.producer, &key, payload, (self.now_ms)())
                .map_err(|e| StoreError::new(e, None))?;
            self.bus
                .publish(SUBJECT, &key, &env)
                .map_err(|e| StoreError::new(e, None))?;
            with_client(store.pool()?, |c| {
                c.execute(
                    "UPDATE ledger.ledger_freeze_outbox SET published_at = now()
                      WHERE id = $1::text::uuid AND published_at IS NULL",
                    &[&id],
                )?;
                Ok(())
            })?;
        }
        Ok(rows.len())
    }
}

/// `LedgerService.freeze(reason, actor)` and `unfreeze(actor, confirm)`: the switch, then every unpublished freeze
/// intent. A failed publish fails the call; the switch it moved stays moved.
pub fn switch(
    store: &Store,
    relay: &FreezeRelay<'_>,
    next: Command<'_>,
) -> Result<FreezeState, StoreError> {
    let (state, _) = write(store, next)?;
    relay.drain(store)?;
    Ok(state)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test: a failure is the point")]
    use super::*;

    fn state(frozen: bool, actor: Option<&str>) -> FreezeState {
        FreezeState {
            frozen,
            reason: frozen.then(|| "drift".to_owned()),
            actor: actor.map(str::to_owned),
            changed_at: "2026-11-21T00:00:00.000Z".to_owned(),
            changed_at_precise: "2026-11-21 00:00:00.123456+00".to_owned(),
        }
    }

    const A: &str = "11111111-1111-4111-8111-111111111111";
    const B: &str = "22222222-2222-4222-8222-222222222222";
    const C: &str = "33333333-3333-4333-8333-333333333333";

    // `four-eyes-unfreeze.test.ts` and `dual-control.test.ts`, case for case.
    #[test]
    fn a_thaw_needs_two_distinct_people_and_not_the_freezer() {
        let frozen = state(true, Some(A));
        assert_eq!(unfreeze_refusal(&state(false, None), Some(A), None), None);
        assert_eq!(
            unfreeze_refusal(&frozen, None, Some(B)),
            Some("operator identity is required; the ledger does not invent a caller")
        );
        assert_eq!(
            unfreeze_refusal(&frozen, Some(B), Some("   ")),
            Some(
                "confirming operator identity is required; the ledger does not invent a second caller"
            )
        );
        assert_eq!(
            unfreeze_refusal(&frozen, Some(B), Some(&B.to_uppercase())),
            Some(
                "confirming operator must be a distinct identity; the ledger does not invent a second caller"
            )
        );
        assert_eq!(
            unfreeze_refusal(&frozen, Some(B), Some(&format!(" {} ", A.to_uppercase()))),
            Some("the operator who froze posting cannot be the one who clears it")
        );
        assert_eq!(unfreeze_refusal(&frozen, Some(B), Some(C)), None);
        // The freezer may be the caller, with someone else confirming.
        assert_eq!(unfreeze_refusal(&frozen, Some(A), Some(B)), None);
    }

    fn row(fields: &[(&str, Json)]) -> Json {
        Json::Object(
            fields
                .iter()
                .map(|(k, v)| ((*k).to_owned(), v.clone()))
                .collect(),
        )
    }

    #[test]
    fn an_outbox_row_must_be_the_event_it_claims() {
        let ok = row(&[
            ("frozen", Json::Bool(true)),
            ("reason", Json::str("drift")),
            ("actor", Json::str(A)),
            ("changedAt", Json::str("2026-11-21T00:00:00.000Z")),
        ]);
        assert_eq!(event_payload("r", "ledger.freeze:seq:1", &ok).unwrap(), ok);
        let refused = |p: &Json, key: &str| event_payload("r", key, p).unwrap_err().message;
        assert_eq!(
            refused(&Json::Array(Vec::new()), "ledger.freeze:seq:1"),
            "ledger_freeze_outbox r payload is not an object"
        );
        assert_eq!(
            refused(
                &row(&[("frozen", Json::Bool(true)), ("n", Json::int(1))]),
                "ledger.freeze:seq:1"
            ),
            "ledger_freeze_outbox r payload contains a JSON number"
        );
        assert_eq!(
            refused(
                &row(&[
                    ("frozen", Json::Bool(false)),
                    ("reason", Json::str("x")),
                    ("actor", Json::str(A)),
                    ("changedAt", Json::str("2026-11-21T00:00:00.000Z")),
                ]),
                "ledger.freeze:seq:1"
            ),
            "ledger_freeze_outbox r thaw reason must be null"
        );
        assert_eq!(
            refused(
                &row(&[
                    ("frozen", Json::Bool(true)),
                    ("reason", Json::Null),
                    ("actor", Json::str(A)),
                    ("changedAt", Json::str("2026-11-21T00:00:00.000Z")),
                ]),
                "ledger.freeze:seq:1"
            ),
            "ledger_freeze_outbox r freeze reason must be a non-empty string"
        );
        assert_eq!(
            refused(&ok, "ledger.freeze:"),
            "ledger_freeze_outbox r idempotency key is not a freeze event key"
        );
    }

    #[test]
    fn the_envelope_is_the_catalogues() {
        let env = envelope("svc-ledger", "ledger.freeze:seq:7", Json::Null, 0).unwrap();
        assert_eq!(env.get("subject"), Some(&Json::str(SUBJECT)));
        assert_eq!(env.get("version"), Some(&Json::int(1)));
        assert_eq!(
            env.get("occurredAt"),
            Some(&Json::str("1970-01-01T00:00:00.000Z"))
        );
        assert_eq!(
            env.get("idempotencyKey"),
            Some(&Json::str("ledger.freeze:seq:7"))
        );
        assert_eq!(env.get("producer"), Some(&Json::str("svc-ledger")));
    }
}
