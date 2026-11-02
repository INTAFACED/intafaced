-- svc-support · checks the customer can confirm, recorded on a request (RC-support-public-01, J-support-public-20 #2)
-- Reversal: 20261102021000_ticket_verification_checks.down.sql
--
-- One row per check, written only after the service that owns the quoted record said it is the ticket customer's. The row
-- holds the check's kind, the record's kind and id, who recorded it and when: no amount, status, asset or address. The desk
-- reads a balance or a withdrawal destination only with two rows on the request. Once per record; refuses update and delete.

CREATE TABLE IF NOT EXISTS "support"."ticket_verification_checks" (
  "ticket_id" uuid NOT NULL REFERENCES "support"."tickets" ("id") ON DELETE RESTRICT,
  "kind" text NOT NULL CHECK ("kind" IN ('owned_record')),
  "record_kind" text NOT NULL CHECK ("record_kind" IN ('order', 'withdrawal', 'deposit')),
  "record_id" uuid NOT NULL,
  "recorded_by" text NOT NULL CHECK (char_length("recorded_by") BETWEEN 1 AND 128),
  "recorded_at" timestamptz NOT NULL,
  PRIMARY KEY ("ticket_id", "record_kind", "record_id")
);

CREATE OR REPLACE FUNCTION "support"."ticket_verification_checks_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'support.ticket_verification_checks is append-only' USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "ticket_verification_checks_append_only_trg" ON "support"."ticket_verification_checks";
CREATE TRIGGER "ticket_verification_checks_append_only_trg"
  BEFORE UPDATE OR DELETE ON "support"."ticket_verification_checks"
  FOR EACH ROW EXECUTE FUNCTION "support"."ticket_verification_checks_append_only"();
