-- svc-bank — opening collateral is a TERM, like principal
--
-- `open()` accepts a caller-supplied loan id so a retry is the same loan (§5).
-- Principal is snapshotted on the row and compared on conflict. Collateral was
-- not: a first open that failed the lock still wrote the loan at principal X,
-- and a retry with the same id, same principal, and a SMALLER collateral amount
-- could pass LTV on the new figure and lock dust while the draw still paid X.
--
-- `opening_collateral` is write-once at insert — not a live balance. Live
-- holdings stay in the ledger + `loan_collateral_events` log. This column exists
-- only so "same terms" includes how much was pledged at open.

ALTER TABLE "bank"."loans"
  ADD COLUMN IF NOT EXISTS "opening_collateral" numeric(38, 18);

-- Backfill from the first lock event when one exists (drawn or pending-locked).
UPDATE "bank"."loans" AS l
   SET "opening_collateral" = e."amount"
  FROM "bank"."loan_collateral_events" AS e
 WHERE e."loan_id" = l."id"
   AND e."sequence" = 0
   AND e."direction" = 'lock'
   AND l."opening_collateral" IS NULL;

-- Pending rows that never locked have no independent figure. Leave NULL; open()
-- only enforces the compare when the column is set (every new insert sets it).

ALTER TABLE "bank"."loans"
  DROP CONSTRAINT IF EXISTS "loans_opening_collateral_positive";

ALTER TABLE "bank"."loans"
  ADD CONSTRAINT "loans_opening_collateral_positive"
  CHECK ("opening_collateral" IS NULL OR "opening_collateral" > 0);
