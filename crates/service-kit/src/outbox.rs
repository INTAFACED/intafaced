//! The one way a service publishes an event (INTAFACED/project-state#3867): the event is written to the service's own
//! `<schema>.event_outbox` in the same transaction as the change it announces ([`Outbox::write`]), and a relay
//! publishes it after the commit ([`Outbox::relay`]), with the envelope's idempotency key as its `Nats-Msg-Id`, until
//! the server acks it. A publish that fails stays in the table with its error and is tried again with a backoff, by
//! the next relay: the one the service runs after its own commit, or its timer's. A crash anywhere loses nothing: before
//! the commit there is no change and no event; after it, both are on disk.
//!
//! A relay holds a row's lock while it publishes it (`FOR UPDATE SKIP LOCKED`), so two relays at once never send the
//! same row twice; a crash between the server's ack and the row's mark sends it again under the same key, which the
//! server deduplicates inside its window and every consumer ignores, as consumers are idempotent.
//!
//! Only the relay calls [`Bus::publish`]: `tests/one_outbox.rs` refuses any other call in a service's code.

use postgres::GenericClient;

use crate::json::{self, Json};
use crate::pg::{DbError, Pool, db_message};

/// The event bus's publish side (`JetStreamEventBus.publish`): one envelope, deduplicated by `msg_id` (the event's
/// idempotency key). Only [`Outbox::relay`] calls it.
pub trait Bus: Send + Sync {
    fn publish(&self, subject: &str, msg_id: &str, envelope: &Json) -> Result<(), String>;
}

/// No bus wired: every publish fails, as `JetStreamEventBus` would with no connection, so each event stays owed.
pub struct NoBus;

impl Bus for NoBus {
    fn publish(&self, _: &str, _: &str, _: &Json) -> Result<(), String> {
        Err("no event bus is wired".to_owned())
    }
}

/// The bus over NATS JetStream.
pub struct JetStreamBus(pub std::sync::Arc<crate::nats::JetStream>);

impl Bus for JetStreamBus {
    fn publish(&self, subject: &str, msg_id: &str, envelope: &Json) -> Result<(), String> {
        self.0
            .publish(subject, msg_id, envelope.compact().as_bytes())
            .map(|_| ())
            .map_err(|e| e.0)
    }
}

/// The table every service's outbox migration creates in its own schema, byte for byte (`tests/one_outbox.rs` reads
/// each service's migration for it). `envelope` is the compact JSON text exactly as it is published: `jsonb` would
/// reorder its keys.
pub fn ddl(schema: &str) -> String {
    format!(
        r#"CREATE TABLE IF NOT EXISTS "{schema}"."event_outbox" (
  "seq"              bigserial PRIMARY KEY,
  "subject"          text NOT NULL,
  "idempotency_key"  text NOT NULL,
  "envelope"         text NOT NULL,
  "created_at"       timestamptz NOT NULL DEFAULT now(),
  "attempts"         integer NOT NULL DEFAULT 0,
  "next_attempt_at"  timestamptz NOT NULL DEFAULT now(),
  "last_error"       text,
  "published_at"     timestamptz,
  CONSTRAINT "event_outbox_key_uq" UNIQUE ("idempotency_key"),
  CONSTRAINT "event_outbox_envelope_ck" CHECK (
    length("subject") > 0 AND length("idempotency_key") > 0
    AND jsonb_typeof("envelope"::jsonb) = 'object'
    AND ("envelope"::jsonb ->> 'subject') IS NOT DISTINCT FROM "subject"
    AND ("envelope"::jsonb ->> 'idempotencyKey') IS NOT DISTINCT FROM "idempotency_key"
  )
);
CREATE INDEX IF NOT EXISTS "event_outbox_ready_idx" ON "{schema}"."event_outbox" ("next_attempt_at", "seq") WHERE "published_at" IS NULL;
"#
    )
}

/// What one relay pass did.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Relayed {
    /// Rows the bus took.
    pub published: usize,
    /// Rows the bus refused: each waits its backoff, then goes again.
    pub failed: usize,
}

/// How long a row waits after its `attempts`-th failure: 1 s, doubling, at most five minutes.
pub fn backoff_secs(attempts: i32) -> i32 {
    1_i32
        .checked_shl(u32::try_from(attempts.clamp(1, 30) - 1).unwrap_or(0))
        .unwrap_or(i32::MAX)
        .min(300)
}

/// One service's outbox: `<schema>.event_outbox`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Outbox {
    schema: &'static str,
}

impl Outbox {
    pub const fn new(schema: &'static str) -> Outbox {
        Outbox { schema }
    }

    /// The schema whose `event_outbox` it is.
    pub const fn schema(&self) -> &'static str {
        self.schema
    }

    /// The event, inside the caller's transaction: it commits or rolls back with the change it announces. The
    /// envelope's own `subject` and `idempotencyKey` are the ones it is published under (the table refuses an envelope
    /// missing either). The same key written again
    /// keeps the first row (the event already owed), and the answer says whether this call wrote it.
    pub fn write(
        &self,
        tx: &mut impl GenericClient,
        envelope: &Json,
    ) -> Result<bool, postgres::Error> {
        let subject = text_field(envelope, "subject");
        let key = text_field(envelope, "idempotencyKey");
        let text = envelope.compact();
        let written = tx.execute(
            &format!(
                r#"INSERT INTO "{}"."event_outbox" (subject, idempotency_key, envelope)
                   VALUES ($1::text, $2::text, $3::text)
                   ON CONFLICT (idempotency_key) DO NOTHING"#,
                self.schema
            ),
            &[&subject, &key, &text],
        )?;
        Ok(written == 1)
    }

    /// Publishes up to `limit` owed rows whose wait is over, oldest first, each in its own transaction under its lock:
    /// marked published once the bus took it, else its failure recorded and its next attempt pushed back. A bus
    /// failure never stops the pass; a database failure does. The service's timer runs it.
    pub fn relay(&self, pool: &Pool, bus: &dyn Bus, limit: usize) -> Result<Relayed, DbError> {
        let mut done = Relayed::default();
        let mut conn = pool.get()?;
        let client = conn.client()?;
        for _ in 0..limit {
            match self.send_one(client, bus, None)? {
                None => break,
                Some(true) => done.published += 1,
                Some(false) => done.failed += 1,
            }
        }
        Ok(done)
    }

    /// The one event under `key`, now, if it is still owed, whatever its wait: what a call does right after the commit
    /// that wrote it, and what a retry of that call does for an event an earlier try could not send. True when the bus
    /// has it (taken now, or before); false when it is still owed: the bus refused it, another relay holds it, or no
    /// such event was written. A bus failure is never the caller's error: the event is on disk, and a row whose own
    /// state says "announced" is marked only once this answers true.
    pub fn send(&self, pool: &Pool, bus: &dyn Bus, key: &str) -> Result<bool, DbError> {
        let mut conn = pool.get()?;
        let client = conn.client()?;
        Ok(self.send_one(client, bus, Some(key))? == Some(true))
    }

    /// [`Outbox::send`] inside the caller's transaction, for an event written in it: a caller that holds its own row's
    /// lock while it announces it, and rolls both back when the bus refused.
    pub fn send_in(
        &self,
        tx: &mut impl GenericClient,
        bus: &dyn Bus,
        key: &str,
    ) -> Result<bool, DbError> {
        Ok(self.send_one(tx, bus, Some(key))? == Some(true))
    }

    /// One row under its lock: the oldest ready one, or the one under `key`. None when there is none.
    fn send_one(
        &self,
        client: &mut impl GenericClient,
        bus: &dyn Bus,
        key: Option<&str>,
    ) -> Result<Option<bool>, DbError> {
        let fail = |e: postgres::Error| DbError(db_message(&e));
        let mut tx = client.transaction().map_err(fail)?;
        let row = tx
            .query_opt(
                &format!(
                    r#"SELECT seq, subject, idempotency_key, envelope, attempts, published_at IS NOT NULL
                         FROM "{}"."event_outbox"
                        WHERE CASE WHEN $1::text IS NULL THEN published_at IS NULL AND next_attempt_at <= now()
                                   ELSE idempotency_key = $1::text END
                        ORDER BY seq LIMIT 1 FOR UPDATE SKIP LOCKED"#,
                    self.schema
                ),
                &[&key],
            )
            .map_err(fail)?;
        let Some(row) = row else {
            tx.commit().map_err(fail)?;
            return Ok(None);
        };
        if row.get::<_, bool>(5) {
            tx.commit().map_err(fail)?;
            return Ok(Some(true));
        }
        let seq: i64 = row.get(0);
        let subject: String = row.get(1);
        let msg_id: String = row.get(2);
        let text: String = row.get(3);
        let attempts: i32 = row.get::<_, i32>(4).saturating_add(1);
        let sent = json::parse(&text)
            .map_err(|e| format!("event_outbox {seq}: envelope: {}", e.message))
            .and_then(|envelope| bus.publish(&subject, &msg_id, &envelope));
        let took = sent.is_ok();
        match sent {
            Ok(()) => tx.execute(
                &format!(
                    r#"UPDATE "{}"."event_outbox" SET published_at = now(), attempts = $2, last_error = NULL
                        WHERE seq = $1"#,
                    self.schema
                ),
                &[&seq, &attempts],
            ),
            Err(e) => tx.execute(
                &format!(
                    r#"UPDATE "{}"."event_outbox"
                          SET attempts = $2, last_error = $3::text,
                              next_attempt_at = now() + make_interval(secs => $4::int)
                        WHERE seq = $1"#,
                    self.schema
                ),
                &[&seq, &attempts, &e, &backoff_secs(attempts)],
            ),
        }
        .map_err(fail)?;
        tx.commit().map_err(fail)?;
        Ok(Some(took))
    }
}

fn text_field(envelope: &Json, name: &str) -> String {
    match envelope.get(name) {
        Some(Json::String(s)) => s.clone(),
        _ => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_failed_row_waits_longer_each_time_up_to_five_minutes() {
        let waits: Vec<i32> = (1..=11).map(backoff_secs).collect();
        assert_eq!(waits, [1, 2, 4, 8, 16, 32, 64, 128, 256, 300, 300]);
        assert_eq!(backoff_secs(i32::MAX), 300);
        assert_eq!(backoff_secs(0), 1);
    }

    #[test]
    fn the_table_is_in_the_schema_it_is_made_for() {
        let sql = ddl("agents");
        assert!(sql.contains(r#""agents"."event_outbox""#));
        assert!(!sql.contains("{schema}"));
    }
}
