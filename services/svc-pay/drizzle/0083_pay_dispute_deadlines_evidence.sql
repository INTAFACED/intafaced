-- Merchant dispute cases, response deadlines, and evidence bytes.
-- Reversal: 0083_pay_dispute_deadlines_evidence.down.sql
--
-- Dispute cases are the durable copy of the in-process case store. Nothing
-- is migrated: there is no previous table of cases. A rail outcome is applied
-- once per rail event id. Case identity, amount, and the opening ledger
-- result do not change after insert. Status moves only forward.
--
-- A deadline is recorded only when a rail event carries one. A null
-- response_due_at means that event did not include a due date. A later event
-- may fill a null once. A recorded date is not replaced. Deadlines are not
-- foreign-keyed to cases: a deadline row can be written for a case that the
-- process recorded before this table existed.
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

-- Durable dispute cases. Amount is the decimal string the case store already
-- accepts (not a float). No rows are copied from anywhere.

CREATE TABLE IF NOT EXISTS "pay"."dispute_cases" (
  "dispute_id" text PRIMARY KEY,
  "payment_id" text NOT NULL,
  "merchant_id" uuid NOT NULL REFERENCES "pay"."merchants"("id"),
  "amount" text NOT NULL,
  "asset_id" text NOT NULL,
  "reason_code" text,
  "status" text NOT NULL,
  "opened_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL,
  "contested_at" timestamptz,
  "closed_at" timestamptz,
  "payment_marked_disputed" boolean NOT NULL,
  "ledger_wire" text NOT NULL,
  "ledger_tx_id" text,
  "ledger_refuse" jsonb,
  CONSTRAINT "dispute_cases_id_ck"
    CHECK (char_length(btrim("dispute_id")) BETWEEN 1 AND 500),
  CONSTRAINT "dispute_cases_payment_ck"
    CHECK (char_length(btrim("payment_id")) BETWEEN 1 AND 80),
  CONSTRAINT "dispute_cases_asset_ck"
    CHECK (char_length(btrim("asset_id")) BETWEEN 1 AND 32),
  CONSTRAINT "dispute_cases_amount_ck"
    CHECK ("amount" ~ '^[0-9]+(\.[0-9]{1,18})?$'),
  CONSTRAINT "dispute_cases_reason_ck"
    CHECK ("reason_code" IS NULL OR char_length(btrim("reason_code")) BETWEEN 1 AND 200),
  CONSTRAINT "dispute_cases_status_ck"
    CHECK ("status" IN ('open', 'contested', 'accepted', 'won', 'lost')),
  CONSTRAINT "dispute_cases_wire_ck"
    CHECK (
      ("ledger_wire" = 'posted' AND "ledger_tx_id" IS NOT NULL AND char_length(btrim("ledger_tx_id")) > 0 AND "ledger_refuse" IS NULL)
      OR ("ledger_wire" = 'refused' AND "ledger_tx_id" IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS "dispute_cases_merchant_idx"
  ON "pay"."dispute_cases" ("merchant_id", "opened_at", "dispute_id");

CREATE INDEX IF NOT EXISTS "dispute_cases_payment_idx"
  ON "pay"."dispute_cases" ("payment_id", "opened_at");

CREATE OR REPLACE FUNCTION "pay"."dispute_cases_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'dispute_cases cannot be deleted'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.dispute_id IS DISTINCT FROM OLD.dispute_id
     OR NEW.payment_id IS DISTINCT FROM OLD.payment_id
     OR NEW.merchant_id IS DISTINCT FROM OLD.merchant_id
     OR NEW.amount IS DISTINCT FROM OLD.amount
     OR NEW.asset_id IS DISTINCT FROM OLD.asset_id
     OR NEW.reason_code IS DISTINCT FROM OLD.reason_code
     OR NEW.opened_at IS DISTINCT FROM OLD.opened_at
     OR NEW.payment_marked_disputed IS DISTINCT FROM OLD.payment_marked_disputed
     OR NEW.ledger_wire IS DISTINCT FROM OLD.ledger_wire
     OR NEW.ledger_tx_id IS DISTINCT FROM OLD.ledger_tx_id
     OR NEW.ledger_refuse IS DISTINCT FROM OLD.ledger_refuse
  THEN
    RAISE EXCEPTION 'dispute case identity and opening ledger result are immutable'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.contested_at IS NOT NULL AND NEW.contested_at IS DISTINCT FROM OLD.contested_at THEN
    RAISE EXCEPTION 'a recorded contest time cannot be replaced'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.closed_at IS NOT NULL AND NEW.closed_at IS DISTINCT FROM OLD.closed_at THEN
    RAISE EXCEPTION 'a recorded close time cannot be replaced'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;
  IF OLD.status IN ('accepted', 'won', 'lost') THEN
    RAISE EXCEPTION 'a closed dispute case cannot change status'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status = 'open' AND NEW.status IN ('contested', 'accepted', 'won', 'lost') THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'contested' AND NEW.status IN ('accepted', 'won', 'lost') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'dispute case status cannot move from % to %', OLD.status, NEW.status
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS "dispute_cases_guard_trg" ON "pay"."dispute_cases";
CREATE TRIGGER "dispute_cases_guard_trg"
  BEFORE UPDATE OR DELETE ON "pay"."dispute_cases"
  FOR EACH ROW EXECUTE FUNCTION "pay"."dispute_cases_guard"();

-- One row per rail delivery that resolved a case. A repeated id does not
-- move the case again.

CREATE TABLE IF NOT EXISTS "pay"."dispute_case_rail_events" (
  "rail_event_id" text PRIMARY KEY,
  "dispute_id" text NOT NULL REFERENCES "pay"."dispute_cases"("dispute_id"),
  "outcome" text NOT NULL,
  "applied_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "dispute_case_rail_events_id_ck"
    CHECK (char_length(btrim("rail_event_id")) BETWEEN 1 AND 300),
  CONSTRAINT "dispute_case_rail_events_outcome_ck"
    CHECK ("outcome" IN ('won', 'lost', 'closed'))
);

CREATE INDEX IF NOT EXISTS "dispute_case_rail_events_dispute_idx"
  ON "pay"."dispute_case_rail_events" ("dispute_id", "applied_at");

CREATE OR REPLACE FUNCTION "pay"."dispute_case_rail_events_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not permitted.', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS "dispute_case_rail_events_append_only_trg" ON "pay"."dispute_case_rail_events";
CREATE TRIGGER "dispute_case_rail_events_append_only_trg"
  BEFORE UPDATE OR DELETE ON "pay"."dispute_case_rail_events"
  FOR EACH ROW EXECUTE FUNCTION "pay"."dispute_case_rail_events_append_only"();
