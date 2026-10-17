-- The buyback quiet period used created_at, which is when the claim was
-- inserted. A burn attempt can start long after that. recordBuyback then saw
-- an old created_at, treated the quiet period as over, and deleted the pending
-- row while that burn could still land and spend the same window again.
--
-- last_post_at is the clock of the last burn/post attempt. The quiet period
-- reads it. Existing rows copy created_at so a claim already inside its quiet
-- window keeps that window. No amount, rate, or duration is written here.

ALTER TABLE "token"."buyback_runs"
  ADD COLUMN IF NOT EXISTS "last_post_at" timestamptz;

UPDATE "token"."buyback_runs"
   SET "last_post_at" = "created_at"
 WHERE "last_post_at" IS NULL;
