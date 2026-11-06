-- J-merchant-06: refund, void or reverse a payment safely.
--
-- 1. `voided`: an authorised payment released before capture. No value moved, so no ledger post exists for it.
-- 2. The owner's refund approval rule: a refund above `threshold` (per asset) waits for a second person. No row means
--    no rule: the owner has not asked for one, and nothing is defaulted.
-- 3. Refund requests: a refund that waits (queued) before anything is posted. It is bound to one payment, one amount
--    and one refund key; the refund runs only for exactly those, once, under that key, after a checker who is not the
--    maker approves it. A queued request can be cancelled; a request for another amount on the same payment voids it.
-- 4. Bulk refund rows: one row per payment in a batch; each row's refund key is the batch id and the row, so running a
--    batch again refunds nothing twice.

DO $$ BEGIN
  ALTER TYPE "pay"."payment_status" ADD VALUE IF NOT EXISTS 'voided';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "pay"."refund_approval_rules" (
  "merchant_id"  uuid NOT NULL REFERENCES "pay"."merchants"("id"),
  "asset_code"   text NOT NULL,
  "threshold"    numeric(60, 18) NOT NULL CONSTRAINT "refund_rules_threshold_positive" CHECK ("threshold" > 0),
  "set_by"       text NOT NULL,
  "set_at"       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("merchant_id", "asset_code")
);

-- Every change to the rule, append-only: who set what, when. Nothing here is ever updated or deleted.
CREATE TABLE IF NOT EXISTS "pay"."refund_approval_rule_changes" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "seq"           bigserial NOT NULL,
  "merchant_id"   uuid NOT NULL REFERENCES "pay"."merchants"("id"),
  "asset_code"    text NOT NULL,
  "old_threshold" numeric(60, 18),
  "new_threshold" numeric(60, 18),
  "changed_by"    text NOT NULL,
  "changed_at"    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "refund_rule_changes_merchant_idx" ON "pay"."refund_approval_rule_changes" ("merchant_id", "seq" DESC);

CREATE TABLE IF NOT EXISTS "pay"."refund_requests" (
  "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "seq"              bigserial NOT NULL,
  "merchant_id"      uuid NOT NULL REFERENCES "pay"."merchants"("id"),
  "payment_id"       uuid NOT NULL REFERENCES "pay"."payments"("id"),
  "asset_code"       text NOT NULL,
  "amount"           numeric(60, 18) NOT NULL CONSTRAINT "refund_requests_amount_positive" CHECK ("amount" > 0),
  "refund_id"        text NOT NULL,
  "status"           text NOT NULL DEFAULT 'queued'
    CONSTRAINT "refund_requests_status_known" CHECK ("status" IN ('queued', 'approved', 'refunded', 'failed', 'rejected', 'cancelled', 'voided')),
  "maker_user_id"    text NOT NULL,
  -- The maker's key environment: a request a sandbox key asked for only ever runs as sandbox, so never on the live book.
  "maker_key_env"    text CONSTRAINT "refund_requests_key_env_known" CHECK ("maker_key_env" IS NULL OR "maker_key_env" = 'sandbox'),
  "checker_user_id"  text,
  "checker_reason"   text,
  "failure_code"     text,
  "void_reason"      text,
  "created_at"       timestamptz NOT NULL DEFAULT now(),
  "decided_at"       timestamptz,
  "closed_at"        timestamptz,
  -- The database refuses a maker who approves their own request, whatever the application does.
  CONSTRAINT "refund_requests_maker_not_checker" CHECK ("checker_user_id" IS NULL OR "checker_user_id" <> "maker_user_id"),
  CONSTRAINT "refund_requests_approved_has_checker" CHECK ("status" NOT IN ('approved', 'refunded') OR "checker_user_id" IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS "refund_requests_key_idx" ON "pay"."refund_requests" ("payment_id", "refund_id");
CREATE INDEX IF NOT EXISTS "refund_requests_merchant_idx" ON "pay"."refund_requests" ("merchant_id", "seq" DESC);
-- One live request per payment: asking again for another amount voids the live one first.
CREATE UNIQUE INDEX IF NOT EXISTS "refund_requests_live_idx" ON "pay"."refund_requests" ("payment_id") WHERE "status" IN ('queued', 'approved');

CREATE TABLE IF NOT EXISTS "pay"."refund_batch_rows" (
  "batch_id"     uuid NOT NULL,
  "row_no"       integer NOT NULL CONSTRAINT "refund_batch_row_positive" CHECK ("row_no" > 0),
  "merchant_id"  uuid NOT NULL REFERENCES "pay"."merchants"("id"),
  "payment_id"   uuid NOT NULL,
  "amount"       numeric(60, 18),
  "refund_id"    text NOT NULL,
  "outcome"      text NOT NULL DEFAULT 'pending'
    CONSTRAINT "refund_batch_outcome_known" CHECK ("outcome" IN ('pending', 'refunded', 'refused', 'unknown')),
  "refusal_code" text,
  "maker_user_id" text NOT NULL,
  "created_at"   timestamptz NOT NULL DEFAULT now(),
  "updated_at"   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("batch_id", "row_no")
);
CREATE INDEX IF NOT EXISTS "refund_batch_rows_merchant_idx" ON "pay"."refund_batch_rows" ("merchant_id", "batch_id");
