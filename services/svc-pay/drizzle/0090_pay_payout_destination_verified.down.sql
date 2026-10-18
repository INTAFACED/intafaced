-- intafaced:destructive — reversal of 0090_pay_payout_destination_verified.sql

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM information_schema.tables
     WHERE table_schema = 'pay'
       AND table_name = 'merchant_notifications'
  ) THEN
    DELETE FROM "pay"."merchant_notifications" WHERE "kind" = 'payout_destination';
    ALTER TABLE "pay"."merchant_notifications"
      DROP CONSTRAINT IF EXISTS "merchant_notifications_kind_ck";
    ALTER TABLE "pay"."merchant_notifications"
      ADD CONSTRAINT "merchant_notifications_kind_ck" CHECK ("kind" IN (
        'payout_awaiting_approval', 'settlement_failed', 'payout_failed', 'limit_threshold',
        'dispute_opened', 'dispute_due', 'webhook_failing', 'operator_pause', 'export_ready',
        'team_change'
      ));
  END IF;
END $$;

ALTER TABLE "pay"."merchant_payout_destinations"
  DROP CONSTRAINT IF EXISTS "merchant_payout_destinations_pending_complete";

ALTER TABLE "pay"."merchant_payout_destinations"
  DROP COLUMN IF EXISTS "pending_activates_at";

ALTER TABLE "pay"."merchant_payout_destinations"
  DROP COLUMN IF EXISTS "pending_ref";

ALTER TABLE "pay"."merchant_payout_destinations"
  DROP COLUMN IF EXISTS "pending_kind";

ALTER TABLE "pay"."merchant_payout_destinations"
  DROP COLUMN IF EXISTS "verified_at";

ALTER TABLE "pay"."merchant_payout_destinations"
  DROP COLUMN IF EXISTS "verified";
