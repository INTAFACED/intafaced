-- W2c settlement reads: when a window was sent, posted, or failed, and a catalog code.
--
-- sent_at    — the payout rail accepted the send.
-- settled_at — the window was posted to the ledger.
-- failed_at  — the settlement failed.
-- failure_code — a catalog code. Not a provider payload and not a free-text reason.
--
-- All four are nullable. There is no backfill: a row that existed before this
-- migration stays null. Copying updated_at into settled_at would invent a time.

ALTER TABLE "pay"."settlements" ADD COLUMN IF NOT EXISTS "sent_at" timestamptz;
ALTER TABLE "pay"."settlements" ADD COLUMN IF NOT EXISTS "settled_at" timestamptz;
ALTER TABLE "pay"."settlements" ADD COLUMN IF NOT EXISTS "failed_at" timestamptz;
ALTER TABLE "pay"."settlements" ADD COLUMN IF NOT EXISTS "failure_code" text;

ALTER TABLE "pay"."settlements" DROP CONSTRAINT IF EXISTS "settlements_failure_code_ck";
ALTER TABLE "pay"."settlements" ADD CONSTRAINT "settlements_failure_code_ck"
  CHECK ("failure_code" IS NULL OR "failure_code" ~ '^[a-z][a-z0-9._]{0,63}$');

-- Keyset lists walk (created_at, id). The id column keeps two rows from the same
-- microsecond in a stable order.
CREATE INDEX IF NOT EXISTS "payments_merchant_list_idx"
  ON "pay"."payments" ("merchant_id", "created_at" DESC, "id" DESC);
CREATE INDEX IF NOT EXISTS "settlements_merchant_list_idx"
  ON "pay"."settlements" ("merchant_id", "created_at" DESC, "id" DESC);
