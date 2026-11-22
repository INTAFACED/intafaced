-- Drops the approval links and the approval columns. Code from before approvals reads only `blocked` and `archived`, so an
-- entry still waiting for approval is made `blocked` first: it must never become sendable without the approval. The
-- customer removes it and saves it again. Nothing about money is lost, because a pending entry was never sent to.
UPDATE "bank"."user_withdraw_destinations" SET "state" = 'blocked' WHERE "state" = 'pending';
DROP TABLE IF EXISTS "bank"."destination_approval_links";
ALTER TABLE "bank"."user_withdraw_destinations"
  DROP CONSTRAINT IF EXISTS "user_withdraw_destinations_approved_ck",
  DROP CONSTRAINT IF EXISTS "user_withdraw_destinations_approved_by_ck",
  DROP COLUMN IF EXISTS "approved_by",
  DROP COLUMN IF EXISTS "approved_at";
