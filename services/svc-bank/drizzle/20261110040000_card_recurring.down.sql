-- intafaced:destructive — reversal of 20261110040000_card_recurring.sql
DROP INDEX IF EXISTS "bank"."card_authorizations_recurring_idx";
ALTER TABLE "bank"."card_authorizations" DROP COLUMN IF EXISTS "recurring";
