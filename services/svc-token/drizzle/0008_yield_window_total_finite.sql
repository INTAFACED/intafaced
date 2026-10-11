-- L1250: yield_windows.total_amount must be a finite value greater than 0.
--
-- 0004 checks total_amount > 0. numeric(38, 18) stores NaN, and PostgreSQL
-- orders NaN above every finite value, so NaN > 0 is true. A NaN total then
-- claims window_id. The primary key keeps that claim. It is not a positive
-- revenue amount.
--
-- numeric NaN compares equal to itself, so total_amount <> 'NaN' is not true
-- for that value. A check that is not true rejects the row. A positive finite
-- total still passes. Zero and negative still fail total_amount > 0.
-- Infinity does not fit this precision; the column already rejects it.
--
-- This replaces the check only. It does not set a default and it does not
-- rewrite a stored total. A NaN row already claimed is not given a number.

ALTER TABLE "token"."yield_windows" DROP CONSTRAINT IF EXISTS "yield_windows_total_positive_ck";
ALTER TABLE "token"."yield_windows" ADD CONSTRAINT "yield_windows_total_positive_ck"
  CHECK ("total_amount" > 0 AND "total_amount" <> 'NaN'::numeric);
