-- svc-protocol · prune challenges a failed check spent (D-launch-listing-01 follow-up)
-- Reversal: 20261030193000_protocol_listing_spent_expiry.down.sql
--
-- `used_at` is set both when a proof is stored and when a failed check spends the challenge (no proof). `failed_at` tells
-- the two apart in the row itself: set with `used_at` by a failed check, never by a proof. Once expired, a failed
-- challenge refuses nothing a missing row would not (an unknown nonce refuses too), so pruning deletes it, found through
-- this partial index; a proven challenge is never in it and stays with its proof.
ALTER TABLE "protocol"."listing_challenges" ADD COLUMN IF NOT EXISTS "failed_at" timestamptz;

-- Challenges a failed check spent before this column existed: used, with no proof.
UPDATE "protocol"."listing_challenges" AS c SET "failed_at" = c."used_at"
WHERE c."used_at" IS NOT NULL AND c."failed_at" IS NULL
  AND NOT EXISTS (SELECT 1 FROM "protocol"."listing_ownership_proofs" AS p WHERE p."nonce" = c."nonce");

CREATE INDEX IF NOT EXISTS "listing_challenges_failed_expiry_idx" ON "protocol"."listing_challenges" ("expires_at") WHERE "failed_at" IS NOT NULL;
