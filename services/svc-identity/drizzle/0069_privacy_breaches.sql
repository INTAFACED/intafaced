-- Privacy breach log (RC-identity-11 follow-up). One row per incident id: the incident time and the affected-user
-- count only (counts, never user lists). Opening a breach writes, in the same transaction, one notice request to
-- `privacy_breach_notices` (an outbox row), so a crash never loses the notice to svc-notify. Deadlines are owner
-- values and are not stored here. No balance, no ledger.
-- Reversal: 0069_privacy_breaches.down.sql

CREATE TABLE IF NOT EXISTS "identity"."privacy_breaches" (
  "incident_id" text PRIMARY KEY CHECK ("incident_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  "occurred_at" timestamptz NOT NULL,
  "affected_count" integer NOT NULL CHECK ("affected_count" >= 0),
  "opened_by" uuid NOT NULL,
  "opened_at" timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS "identity"."privacy_breach_notices" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "incident_id" text NOT NULL UNIQUE REFERENCES "identity"."privacy_breaches" ("incident_id"),
  "payload" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  "delivered_at" timestamptz
);
CREATE INDEX IF NOT EXISTS "privacy_breach_notices_pending_idx"
  ON "identity"."privacy_breach_notices" ("created_at") WHERE "delivered_at" IS NULL;
