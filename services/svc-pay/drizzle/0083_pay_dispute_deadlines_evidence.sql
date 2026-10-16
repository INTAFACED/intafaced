-- Merchant dispute response deadlines and evidence bytes.
-- Reversal: 0083_pay_dispute_deadlines_evidence.down.sql
--
-- A deadline is recorded only when a rail event carries one. A null
-- response_due_at means that event did not include a due date. A later event
-- may fill a null once. A recorded date is not replaced.
--
-- Evidence bytes sit beside the existing metadata table. The 1 MiB ceiling is
-- a storage bound so a request cannot write an unbounded bytea. It is not a
-- product file-size policy. Upload stays off until the service flag is on,
-- and a scan hook must be configured or the upload is refused.

CREATE TABLE IF NOT EXISTS "pay"."dispute_response_deadlines" (
  "merchant_id" uuid NOT NULL REFERENCES "pay"."merchants"("id"),
  "dispute_id" text NOT NULL,
  "response_due_at" timestamptz,
  "rail_event_id" text NOT NULL,
  "recorded_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("merchant_id", "dispute_id"),
  CONSTRAINT "dispute_response_deadlines_dispute_ck"
    CHECK (char_length(btrim("dispute_id")) > 0),
  CONSTRAINT "dispute_response_deadlines_event_ck"
    CHECK (char_length(btrim("rail_event_id")) > 0)
);

CREATE INDEX IF NOT EXISTS "dispute_response_deadlines_due_idx"
  ON "pay"."dispute_response_deadlines" ("merchant_id", "response_due_at")
  WHERE "response_due_at" IS NOT NULL;

CREATE OR REPLACE FUNCTION "pay"."dispute_response_deadline_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'dispute_response_deadlines cannot be deleted'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.merchant_id IS DISTINCT FROM OLD.merchant_id OR NEW.dispute_id IS DISTINCT FROM OLD.dispute_id THEN
    RAISE EXCEPTION 'dispute deadline identity is immutable'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.response_due_at IS NOT NULL THEN
    RAISE EXCEPTION 'a recorded rail due date cannot be replaced'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.response_due_at IS NULL THEN
    RAISE EXCEPTION 'a missing rail due date cannot be rewritten without a date'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "dispute_response_deadlines_guard_trg" ON "pay"."dispute_response_deadlines";
CREATE TRIGGER "dispute_response_deadlines_guard_trg"
  BEFORE UPDATE OR DELETE ON "pay"."dispute_response_deadlines"
  FOR EACH ROW EXECUTE FUNCTION "pay"."dispute_response_deadline_guard"();

CREATE TABLE IF NOT EXISTS "pay"."merchant_dispute_evidence_content" (
  "evidence_id" uuid PRIMARY KEY REFERENCES "pay"."merchant_dispute_evidence"("id"),
  "merchant_id" uuid NOT NULL REFERENCES "pay"."merchants"("id"),
  "content" bytea NOT NULL,
  CONSTRAINT "merchant_dispute_evidence_content_size_ck"
    CHECK (octet_length("content") BETWEEN 1 AND 1048576)
);

CREATE INDEX IF NOT EXISTS "merchant_dispute_evidence_content_merchant_idx"
  ON "pay"."merchant_dispute_evidence_content" ("merchant_id", "evidence_id");

CREATE OR REPLACE FUNCTION "pay"."merchant_dispute_evidence_content_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' OR TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '% is append-only: % is not permitted.', TG_TABLE_NAME, TG_OP
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM "pay"."merchant_dispute_evidence" e
     WHERE e.id = NEW.evidence_id
       AND e.merchant_id = NEW.merchant_id
  ) THEN
    RAISE EXCEPTION 'evidence content merchant does not match the evidence row'
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "merchant_dispute_evidence_content_guard_trg" ON "pay"."merchant_dispute_evidence_content";
CREATE TRIGGER "merchant_dispute_evidence_content_guard_trg"
  BEFORE INSERT OR UPDATE OR DELETE ON "pay"."merchant_dispute_evidence_content"
  FOR EACH ROW EXECUTE FUNCTION "pay"."merchant_dispute_evidence_content_guard"();
