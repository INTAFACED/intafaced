-- Payout destinations created before D-142 are not payable.
-- Reversal: 0090_pay_payout_destination_verified.down.sql
--
-- A payout pays the stored verified destination for its rail. It does not
-- write one. Rows that already exist were saved by settlement.payout, which
-- checked format only. verified defaults false, so those rows are unverified
-- and cannot receive a payout until an owner or admin re-verifies them.
-- The migration sets that flag and nothing else: kind and ref stay as they are.
--
-- Read-only count of rows that cannot be paid until re-verified:
--   SELECT count(*)::int AS unverified
--     FROM pay.merchant_payout_destinations
--    WHERE verified = false;
--
-- A change of a verified destination is stored beside it (pending_*) and
-- becomes the active ref only after pending_activates_at. The hold length is
-- not in this table. Blank config refuses the change.

ALTER TABLE "pay"."merchant_payout_destinations"
  ADD COLUMN IF NOT EXISTS "verified" boolean NOT NULL DEFAULT false;

ALTER TABLE "pay"."merchant_payout_destinations"
  ADD COLUMN IF NOT EXISTS "verified_at" timestamptz;

ALTER TABLE "pay"."merchant_payout_destinations"
  ADD COLUMN IF NOT EXISTS "pending_kind" text;

ALTER TABLE "pay"."merchant_payout_destinations"
  ADD COLUMN IF NOT EXISTS "pending_ref" text;

ALTER TABLE "pay"."merchant_payout_destinations"
  ADD COLUMN IF NOT EXISTS "pending_activates_at" timestamptz;

ALTER TABLE "pay"."merchant_payout_destinations"
  DROP CONSTRAINT IF EXISTS "merchant_payout_destinations_pending_complete";

ALTER TABLE "pay"."merchant_payout_destinations"
  ADD CONSTRAINT "merchant_payout_destinations_pending_complete" CHECK (
    (
      "pending_kind" IS NULL
      AND "pending_ref" IS NULL
      AND "pending_activates_at" IS NULL
    )
    OR (
      "pending_kind" IS NOT NULL
      AND "pending_ref" IS NOT NULL
      AND "pending_activates_at" IS NOT NULL
      AND length(btrim("pending_kind")) > 0
      AND length(btrim("pending_ref")) > 0
    )
  );

-- In-app notice for an add or a change. Email stays on the notify service,
-- which may be unset. The feed is the existing merchant notification row.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM information_schema.tables
     WHERE table_schema = 'pay'
       AND table_name = 'merchant_notifications'
  ) THEN
    ALTER TABLE "pay"."merchant_notifications"
      DROP CONSTRAINT IF EXISTS "merchant_notifications_kind_ck";
    ALTER TABLE "pay"."merchant_notifications"
      ADD CONSTRAINT "merchant_notifications_kind_ck" CHECK ("kind" IN (
        'payout_awaiting_approval', 'settlement_failed', 'payout_failed', 'limit_threshold',
        'dispute_opened', 'dispute_due', 'webhook_failing', 'operator_pause', 'export_ready',
        'team_change', 'payout_destination'
      ));
  END IF;
END $$;
