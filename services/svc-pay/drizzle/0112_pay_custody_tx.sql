-- Custody transaction history, lifecycle timeouts and confirmation policy (W-custody-ops-11). NOTHING HERE HOLDS A BALANCE.
-- The transactions themselves are the rows of `pay.withdrawals`; this adds what an operator writes ABOUT them. Operator
-- notes and lifecycle timeouts are append-only. A confirmation override is a request with a snapshot of the network
-- default it was judged against, and approvals are separate rows, so no request is ever edited to become effective.
CREATE TABLE IF NOT EXISTS "pay"."custody_tx_notes" (
  "seq" bigserial PRIMARY KEY,
  "withdrawal_id" uuid NOT NULL REFERENCES "pay"."withdrawals" ("id"),
  "note" text NOT NULL,
  "author" text NOT NULL,
  "at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "custody_tx_notes_text_ck" CHECK (length(btrim("note")) > 0 AND length("note") <= 2000 AND length(btrim("author")) > 0)
);
CREATE INDEX IF NOT EXISTS "custody_tx_notes_subject_idx" ON "pay"."custody_tx_notes" ("withdrawal_id", "seq");

-- Owner-set time a transaction may sit in one lifecycle state before it reads as overdue. No row means no timeout.
CREATE TABLE IF NOT EXISTS "pay"."custody_lifecycle_timeout_events" (
  "seq" bigserial PRIMARY KEY,
  "state" text NOT NULL,
  "seconds" integer NOT NULL,
  "reason" text NOT NULL,
  "set_by" text NOT NULL,
  "at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "custody_lifecycle_timeout_seconds_ck" CHECK ("seconds" > 0),
  CONSTRAINT "custody_lifecycle_timeout_text_ck" CHECK (length(btrim("reason")) > 0 AND length(btrim("set_by")) > 0 AND length(btrim("state")) > 0)
);
CREATE INDEX IF NOT EXISTS "custody_lifecycle_timeout_state_idx" ON "pay"."custody_lifecycle_timeout_events" ("state", "seq" DESC);

CREATE TABLE IF NOT EXISTS "pay"."confirmation_override_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "scope" text NOT NULL,
  "network_id" text NOT NULL,
  "withdrawal_id" uuid REFERENCES "pay"."withdrawals" ("id"),
  "confirmations" integer NOT NULL,
  -- The registry default this request was judged against; a request below it carries an expiry.
  "default_at_request" integer NOT NULL,
  "reason" text NOT NULL,
  "requested_by" text NOT NULL,
  "expires_at" timestamptz,
  "requested_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "confirmation_override_scope_ck" CHECK (
    ("scope" = 'network' AND "withdrawal_id" IS NULL) OR ("scope" = 'transaction' AND "withdrawal_id" IS NOT NULL)
  ),
  CONSTRAINT "confirmation_override_count_ck" CHECK ("confirmations" >= 0 AND "default_at_request" >= 0),
  CONSTRAINT "confirmation_override_zero_ck" CHECK ("confirmations" > 0 OR "scope" = 'transaction'),
  CONSTRAINT "confirmation_override_expiry_ck" CHECK ("confirmations" >= "default_at_request" OR "expires_at" IS NOT NULL),
  CONSTRAINT "confirmation_override_text_ck" CHECK (length(btrim("reason")) > 0 AND length(btrim("requested_by")) > 0)
);
CREATE INDEX IF NOT EXISTS "confirmation_override_network_idx" ON "pay"."confirmation_override_requests" ("network_id", "requested_at" DESC);
CREATE INDEX IF NOT EXISTS "confirmation_override_withdrawal_idx" ON "pay"."confirmation_override_requests" ("withdrawal_id", "requested_at" DESC);

CREATE TABLE IF NOT EXISTS "pay"."confirmation_override_approvals" (
  "seq" bigserial PRIMARY KEY,
  "request_id" uuid NOT NULL REFERENCES "pay"."confirmation_override_requests" ("id"),
  "approver" text NOT NULL,
  "at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "confirmation_override_approver_ck" CHECK (length(btrim("approver")) > 0),
  CONSTRAINT "confirmation_override_approval_uq" UNIQUE ("request_id", "approver")
);

CREATE OR REPLACE FUNCTION "pay"."custody_tx_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% on pay.% is not permitted: notes, timeouts, confirmation overrides and their approvals are never edited or deleted.', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS "custody_tx_notes_append_only_trg" ON "pay"."custody_tx_notes";
CREATE TRIGGER "custody_tx_notes_append_only_trg"
  BEFORE UPDATE OR DELETE ON "pay"."custody_tx_notes"
  FOR EACH ROW EXECUTE FUNCTION "pay"."custody_tx_append_only"();
DROP TRIGGER IF EXISTS "custody_lifecycle_timeout_append_only_trg" ON "pay"."custody_lifecycle_timeout_events";
CREATE TRIGGER "custody_lifecycle_timeout_append_only_trg"
  BEFORE UPDATE OR DELETE ON "pay"."custody_lifecycle_timeout_events"
  FOR EACH ROW EXECUTE FUNCTION "pay"."custody_tx_append_only"();
DROP TRIGGER IF EXISTS "confirmation_override_requests_append_only_trg" ON "pay"."confirmation_override_requests";
CREATE TRIGGER "confirmation_override_requests_append_only_trg"
  BEFORE UPDATE OR DELETE ON "pay"."confirmation_override_requests"
  FOR EACH ROW EXECUTE FUNCTION "pay"."custody_tx_append_only"();
DROP TRIGGER IF EXISTS "confirmation_override_approvals_append_only_trg" ON "pay"."confirmation_override_approvals";
CREATE TRIGGER "confirmation_override_approvals_append_only_trg"
  BEFORE UPDATE OR DELETE ON "pay"."confirmation_override_approvals"
  FOR EACH ROW EXECUTE FUNCTION "pay"."custody_tx_append_only"();
