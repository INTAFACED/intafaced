-- W15 merchant operations: what a merchant attaches to, and says about, a dispute.
--
-- The dispute CASE itself (status, amount, reason, ledger wire) stays in
-- src/fraud/dispute-case.ts. These tables hold only the merchant's side, keyed by
-- the case's `dispute_id` and the merchant that owns it. No second dispute model.
--
-- Evidence is METADATA: a file name, type, size and sha256 digest the merchant
-- computed. No bytes are stored here; file capture needs a storage vendor.

CREATE TABLE IF NOT EXISTS "pay"."merchant_dispute_evidence" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "merchant_id"  uuid NOT NULL REFERENCES "pay"."merchants"("id"),
  "dispute_id"   text NOT NULL CONSTRAINT "merchant_dispute_evidence_dispute_not_blank" CHECK (length(btrim("dispute_id")) > 0),
  "kind"         text NOT NULL CONSTRAINT "merchant_dispute_evidence_kind_ck" CHECK ("kind" IN
                   ('receipt', 'shipping_proof', 'customer_communication', 'terms_accepted', 'identity_check', 'other')),
  "file_name"    text NOT NULL CONSTRAINT "merchant_dispute_evidence_file_not_blank" CHECK (length(btrim("file_name")) > 0),
  "content_type" text NOT NULL,
  "size_bytes"   bigint NOT NULL CONSTRAINT "merchant_dispute_evidence_size_ck" CHECK ("size_bytes" >= 0),
  "sha256"       text NOT NULL CONSTRAINT "merchant_dispute_evidence_sha_ck" CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
  "note"         text,
  "added_by"     text NOT NULL CONSTRAINT "merchant_dispute_evidence_by_not_blank" CHECK (length(btrim("added_by")) > 0),
  "created_at"   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "merchant_dispute_evidence_dispute_idx"
  ON "pay"."merchant_dispute_evidence" ("merchant_id", "dispute_id", "created_at", "id");

-- The merchant's decision on a dispute. One request id = one decision, so a
-- retried click replays the first answer instead of acting twice.
CREATE TABLE IF NOT EXISTS "pay"."merchant_dispute_responses" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "merchant_id"  uuid NOT NULL REFERENCES "pay"."merchants"("id"),
  "dispute_id"   text NOT NULL CONSTRAINT "merchant_dispute_responses_dispute_not_blank" CHECK (length(btrim("dispute_id")) > 0),
  "request_id"   uuid NOT NULL,
  "action"       text NOT NULL CONSTRAINT "merchant_dispute_responses_action_ck" CHECK ("action" IN ('contest', 'accept_liability')),
  "note"         text,
  "resulting_status" text NOT NULL,
  "evidence_count" integer NOT NULL DEFAULT 0,
  "responded_by" text NOT NULL CONSTRAINT "merchant_dispute_responses_by_not_blank" CHECK (length(btrim("responded_by")) > 0),
  "created_at"   timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "merchant_dispute_responses_request_idx"
  ON "pay"."merchant_dispute_responses" ("merchant_id", "request_id");
CREATE INDEX IF NOT EXISTS "merchant_dispute_responses_dispute_idx"
  ON "pay"."merchant_dispute_responses" ("merchant_id", "dispute_id", "created_at");

CREATE OR REPLACE FUNCTION "pay"."merchant_dispute_ops_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not permitted.', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS "merchant_dispute_evidence_append_only_trg" ON "pay"."merchant_dispute_evidence";
CREATE TRIGGER "merchant_dispute_evidence_append_only_trg"
  BEFORE UPDATE OR DELETE ON "pay"."merchant_dispute_evidence"
  FOR EACH ROW EXECUTE FUNCTION "pay"."merchant_dispute_ops_append_only"();

DROP TRIGGER IF EXISTS "merchant_dispute_responses_append_only_trg" ON "pay"."merchant_dispute_responses";
CREATE TRIGGER "merchant_dispute_responses_append_only_trg"
  BEFORE UPDATE OR DELETE ON "pay"."merchant_dispute_responses"
  FOR EACH ROW EXECUTE FUNCTION "pay"."merchant_dispute_ops_append_only"();
