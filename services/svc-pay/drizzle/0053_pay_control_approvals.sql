-- W1 MERCHANT CONTROL ROOM (4/5): maker-checker on payouts.
--
-- An approval is bound to ONE payload hash (merchant, settlement, asset, amount,
-- rail, destination). A payout whose hash differs finds no approval and voids
-- the stale one. `founder_required` payouts also need two DISTINCT founders
-- after the merchant-side checker.

CREATE TABLE IF NOT EXISTS "pay"."control_payout_approvals" (
  "id"                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "seq"                      bigserial NOT NULL,
  "merchant_id"              uuid NOT NULL REFERENCES "pay"."merchants"("id"),
  "settlement_id"            uuid NOT NULL REFERENCES "pay"."settlements"("id"),
  "asset_code"               text NOT NULL,
  "amount"                   numeric(60, 18) NOT NULL CONSTRAINT "control_approvals_amount_positive" CHECK ("amount" > 0),
  "rail_id"                  text NOT NULL,
  "destination_kind"         text NOT NULL,
  "destination_ref"          text NOT NULL,
  "payload_hash"             text NOT NULL CONSTRAINT "control_approvals_hash_shape" CHECK ("payload_hash" ~ '^sha256:[a-f0-9]{64}$'),
  "status"                   text NOT NULL DEFAULT 'pending'
    CONSTRAINT "control_approvals_status_known" CHECK ("status" IN ('pending', 'approved', 'rejected', 'voided', 'expired', 'consumed')),
  "founder_required"         boolean NOT NULL,
  "maker_user_id"            text NOT NULL,
  "checker_user_id"          text,
  "checker_reason"           text,
  "checker_decided_at"       timestamptz,
  "founder_first_user_id"    text,
  "founder_second_user_id"   text,
  "void_reason"              text,
  "consumed_attempt"         integer,
  "created_at"               timestamptz NOT NULL DEFAULT now(),
  "decided_at"               timestamptz,
  "expires_at"               timestamptz NOT NULL,
  -- The database refuses a maker who approves their own request, whatever the application does.
  CONSTRAINT "control_approvals_maker_not_checker" CHECK ("checker_user_id" IS NULL OR "checker_user_id" <> "maker_user_id"),
  CONSTRAINT "control_approvals_founders_distinct" CHECK ("founder_second_user_id" IS NULL OR ("founder_first_user_id" IS NOT NULL AND "founder_second_user_id" <> "founder_first_user_id")),
  CONSTRAINT "control_approvals_approved_complete" CHECK (
    "status" NOT IN ('approved', 'consumed')
    OR ("checker_user_id" IS NOT NULL AND (NOT "founder_required" OR "founder_second_user_id" IS NOT NULL))
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS "control_approvals_seq_idx" ON "pay"."control_payout_approvals" ("seq");
CREATE INDEX IF NOT EXISTS "control_approvals_merchant_idx" ON "pay"."control_payout_approvals" ("merchant_id", "seq" DESC);
CREATE INDEX IF NOT EXISTS "control_approvals_settlement_idx" ON "pay"."control_payout_approvals" ("settlement_id");
-- One live request per exact payload.
CREATE UNIQUE INDEX IF NOT EXISTS "control_approvals_live_payload_idx"
  ON "pay"."control_payout_approvals" ("settlement_id", "payload_hash") WHERE "status" IN ('pending', 'approved');
