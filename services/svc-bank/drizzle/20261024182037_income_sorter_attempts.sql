-- When a sorter split last went to the ledger. Until the post in-flight bound has passed since then, an absent key
-- proves nothing (that post may still land), so the split is neither posted again nor refused.
ALTER TABLE "bank"."income_sorter_run_legs" ADD COLUMN IF NOT EXISTS "attempted_at" timestamp with time zone;
