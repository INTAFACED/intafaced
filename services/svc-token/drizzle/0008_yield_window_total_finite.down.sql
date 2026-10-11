-- Reverse of 0008. Restores the 0004 comparison. Does not rewrite a stored
-- total and does not set a default.

ALTER TABLE "token"."yield_windows" DROP CONSTRAINT IF EXISTS "yield_windows_total_positive_ck";
ALTER TABLE "token"."yield_windows" ADD CONSTRAINT "yield_windows_total_positive_ck"
  CHECK ("total_amount" > 0);
