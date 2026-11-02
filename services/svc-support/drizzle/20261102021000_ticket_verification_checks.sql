-- svc-support · checks the customer can confirm, recorded on a request, and their audit (RC-support-public-01, J-support-public-20 #2)
-- Reversal: 20261102021000_ticket_verification_checks.down.sql
--
-- ticket_verification_checks: one row per check an owning service answered. It holds the check's kind, a sha256 digest of
-- the value bound to the ticket and kind, whether it matched, who recorded it and when. Never the typed email or id. Once
-- per (ticket, kind, digest).
-- verification_audit: one row per check attempt, per check outcome and per read behind the gate, with the operator. No value.
-- Both refuse update and delete.

CREATE TABLE IF NOT EXISTS "support"."ticket_verification_checks" (
  "ticket_id" uuid NOT NULL REFERENCES "support"."tickets" ("id") ON DELETE RESTRICT,
  "kind" text NOT NULL CHECK ("kind" IN ('email', 'client_order_id', 'withdrawal_id', 'deposit_id')),
  "value_digest" text NOT NULL CHECK ("value_digest" ~ '^[0-9a-f]{64}$'),
  "matched" boolean NOT NULL,
  "checked_by" text NOT NULL CHECK (char_length("checked_by") BETWEEN 1 AND 128),
  "checked_at" timestamptz NOT NULL,
  PRIMARY KEY ("ticket_id", "kind", "value_digest")
);

CREATE TABLE IF NOT EXISTS "support"."verification_audit" (
  "id" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "ticket_id" uuid NOT NULL REFERENCES "support"."tickets" ("id") ON DELETE RESTRICT,
  "action" text NOT NULL CHECK ("action" IN ('record_attempt', 'record', 'disclosure')),
  "kind" text NOT NULL CHECK ("kind" IN ('email', 'client_order_id', 'withdrawal_id', 'deposit_id', 'balance', 'fills', 'destination')),
  "outcome" text NOT NULL CHECK ("outcome" ~ '^[a-z_.]{1,64}$'),
  "operator" text NOT NULL CHECK (char_length("operator") BETWEEN 1 AND 128),
  "at" timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS "verification_audit_ticket_idx" ON "support"."verification_audit" ("ticket_id", "action");

CREATE OR REPLACE FUNCTION "support"."ticket_verification_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "ticket_verification_checks_append_only_trg" ON "support"."ticket_verification_checks";
CREATE TRIGGER "ticket_verification_checks_append_only_trg"
  BEFORE UPDATE OR DELETE ON "support"."ticket_verification_checks"
  FOR EACH ROW EXECUTE FUNCTION "support"."ticket_verification_append_only"();

DROP TRIGGER IF EXISTS "verification_audit_append_only_trg" ON "support"."verification_audit";
CREATE TRIGGER "verification_audit_append_only_trg"
  BEFORE UPDATE OR DELETE ON "support"."verification_audit"
  FOR EACH ROW EXECUTE FUNCTION "support"."ticket_verification_append_only"();
