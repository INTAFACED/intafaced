-- When a sorter split last went to the ledger. Until the post in-flight bound has passed since then, an absent key
-- proves nothing (that post may still land), so the split is neither posted again nor refused.
ALTER TABLE "bank"."income_sorter_run_legs" ADD COLUMN IF NOT EXISTS "attempted_at" timestamp with time zone;
-- A split pending when this lands may have a post in flight: it counts as attempted now, so it waits out the bound.
UPDATE "bank"."income_sorter_run_legs" SET "attempted_at" = now() WHERE "status" = 'pending' AND "attempted_at" IS NULL;
