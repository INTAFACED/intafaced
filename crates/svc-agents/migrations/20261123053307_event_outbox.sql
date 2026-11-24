-- svc-agents · the event outbox (INTAFACED/project-state#3867)
-- Reversal: 20261123053307_event_outbox.down.sql
--
-- Every event svc-agents publishes is written here in the same transaction as the change it announces, then published
-- by the relay (`service_kit::outbox`) until the bus takes it. Before this, the service committed and then published,
-- so a failed publish lost the event: a billed settlement's `agentUsageSettled` (intafaced#10084) and a refused or
-- completed action's notice were never sent again. The table is `service_kit::outbox::ddl("agents")`, byte for byte;
-- it holds envelopes only, no balance, and no value moves through it.

CREATE TABLE IF NOT EXISTS "agents"."event_outbox" (
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
CREATE INDEX IF NOT EXISTS "event_outbox_ready_idx" ON "agents"."event_outbox" ("next_attempt_at", "seq") WHERE "published_at" IS NULL;
