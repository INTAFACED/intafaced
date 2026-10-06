-- svc-p2p · freeze p2p_trades.amount once escrow has been taken.
-- Reversal: 0010_p2p_escrow_amount_frozen.down.sql
--
-- NOT tagged `intafaced:destructive`: it drops no table, no column and no row.
-- The trigger only ever refuses. The new column is a copy of amount.
--
-- WHAT WAS WRONG
--
-- `0000` lines 137–139 only require amount > 0. `escrowLock` has already moved
-- that original amount into the per-trade escrow. `settleOnce` posts whatever
-- amount is on the row at settlement. Lowering amount after `escrowed_at` is
-- set releases only the new figure and leaves the difference in that escrow
-- account. The trade is then terminal, so nothing refunds the remainder.
--
-- A CHECK cannot see the previous amount. Reading only OLD.escrowed_at is not
-- enough either: one statement can put the trade back to `created` and clear
-- the timestamp, and the next statement can then lower amount. The frozen
-- figure has to survive that, so it is copied into `escrow_amount` the first
-- time the row is known to hold escrow and compared on every later update.
--
-- WHY 0010 AND NOT AN EDIT TO 0000
--
-- `scripts/migrate.ts` tracks applied migrations by filename in
-- `p2p.__migrations`. `0000` will not run again on a database that already
-- applied it. Same reason `0002` and `0003` are their own files.

ALTER TABLE "p2p"."p2p_trades"
  ADD COLUMN IF NOT EXISTS "escrow_amount" numeric(38, 18);

-- Rows that already hold escrow freeze at the amount they have now. This does
-- not rewrite amount, and it does not touch a row whose lock was never stamped.
UPDATE "p2p"."p2p_trades"
   SET "escrow_amount" = "amount"
 WHERE "escrowed_at" IS NOT NULL
   AND "escrow_amount" IS NULL;

ALTER TABLE "p2p"."p2p_trades" DROP CONSTRAINT IF EXISTS "p2p_trades_escrow_amount_matches_ck";
ALTER TABLE "p2p"."p2p_trades" ADD CONSTRAINT "p2p_trades_escrow_amount_matches_ck"
  CHECK ("escrow_amount" IS NULL OR "escrow_amount" = "amount");

CREATE OR REPLACE FUNCTION "p2p"."p2p_trades_escrow_amount_frozen"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  locked numeric(38, 18);
BEGIN
  IF TG_OP = 'UPDATE' THEN
    locked := OLD."escrow_amount";
    IF locked IS NULL AND OLD."escrowed_at" IS NOT NULL THEN
      locked := OLD."amount";
    END IF;

    -- `IS DISTINCT FROM`, not `<>`. A NULL comparison must not read as
    -- "not different" and let the write through.
    IF locked IS NOT NULL AND (
         NEW."amount" IS DISTINCT FROM locked
      OR (NEW."escrow_amount" IS NOT NULL AND NEW."escrow_amount" IS DISTINCT FROM locked)
    ) THEN
      RAISE EXCEPTION
        'p2p: trade % amount is frozen once escrowed — escrow locked % and settlement posts the row amount, so changing it to % leaves the difference in that escrow account',
        NEW."id", locked, NEW."amount"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- First time this row is known to hold escrow, remember the figure. A later
  -- statement that clears escrowed_at does not clear this.
  IF NEW."escrow_amount" IS NULL AND (NEW."escrowed_at" IS NOT NULL OR locked IS NOT NULL) THEN
    NEW."escrow_amount" := COALESCE(locked, NEW."amount");
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "p2p_trades_escrow_amount_frozen_trg" ON "p2p"."p2p_trades";
CREATE TRIGGER "p2p_trades_escrow_amount_frozen_trg"
  BEFORE INSERT OR UPDATE ON "p2p"."p2p_trades"
  FOR EACH ROW EXECUTE FUNCTION "p2p"."p2p_trades_escrow_amount_frozen"();
