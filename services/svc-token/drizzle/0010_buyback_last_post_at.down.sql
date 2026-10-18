-- intafaced:destructive — drops token.buyback_runs.last_post_at.
-- The quiet-period clock returns to created_at. No balance is rewritten.

ALTER TABLE "token"."buyback_runs" DROP COLUMN IF EXISTS "last_post_at";
