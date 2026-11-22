-- Removes early unlocks. A pot with an early unlock, waiting or already past, is locked again until its full lock date.
ALTER TABLE "bank"."spaces"
  DROP CONSTRAINT IF EXISTS "spaces_early_unlock_ck",
  DROP COLUMN IF EXISTS "unlocks_at",
  DROP COLUMN IF EXISTS "unlock_requested_at";
