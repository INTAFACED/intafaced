-- intafaced:destructive — reversal of 20261108230236_card_blocks.sql
ALTER TABLE "bank"."card_authorizations" DROP COLUMN IF EXISTS "merchant_country";
ALTER TABLE "bank"."card_authorizations" DROP COLUMN IF EXISTS "merchant";
DROP TABLE IF EXISTS "bank"."card_status_events";
DROP TABLE IF EXISTS "bank"."card_controls";
