-- intafaced:destructive — reversal of 20261030193000_protocol_listing_spent_expiry.sql
DROP INDEX IF EXISTS "protocol"."listing_challenges_failed_expiry_idx";
ALTER TABLE "protocol"."listing_challenges" DROP COLUMN IF EXISTS "failed_at";
