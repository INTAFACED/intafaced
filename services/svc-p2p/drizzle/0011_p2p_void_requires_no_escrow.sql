-- svc-p2p · a voided trade cannot already be escrowed.
-- Reversal: 0011_p2p_void_requires_no_escrow.down.sql
--
-- NOT tagged `intafaced:destructive`: it drops no table, no column and no row.
-- The check only ever refuses. `amount` and `escrow_amount` are not rewritten.
--
-- WHAT WAS WRONG
--
-- `0000` lines 207–213 (`p2p_trades_escrow_timestamp_ck`) pass when
-- `escrowed_at` is set even if `resolution` is `voided`. `cancelled` +
-- `voided` is already allowed by `p2p_trades_resolution_matches_status_ck`.
-- An escrowed trade whose lock already posted can be voided. `settleOnce`
-- posts nothing for `voided` and then stamps `settled_at`. The comment at
-- `0000` lines 200–206 says voided means no lock ever happened. The predicate
-- does not require `escrowed_at` IS NULL, so the seller's escrow stays in the
-- per-trade escrow account.
--
-- `0010` copies the locked figure into `escrow_amount` and keeps it when a
-- later statement clears `escrowed_at`. Voided still means that lock never
-- happened, so both the timestamp and the frozen figure have to be absent.
-- Clearing `escrow_amount` is not how a void is recorded: the `0010` trigger
-- puts the figure back, and this check then refuses the row.
--
-- WHY 0011 AND NOT AN EDIT TO 0000
--
-- `scripts/migrate.ts` tracks applied migrations by filename in
-- `p2p.__migrations`. `0000` will not run again on a database that already
-- applied it. Same reason `0010` is its own file.
--
-- A book that already holds a voided row with `escrowed_at` or `escrow_amount`
-- set fails here. Those rows are not updated and not deleted.

DO $$
DECLARE
  violating bigint;
BEGIN
  SELECT count(*) INTO violating
    FROM "p2p"."p2p_trades"
   WHERE "resolution" IS NOT DISTINCT FROM 'voided'
     AND ("escrowed_at" IS NOT NULL OR "escrow_amount" IS NOT NULL);
  IF violating > 0 THEN
    RAISE EXCEPTION
      'p2p: refusing p2p_trades_voided_requires_no_escrow_ck — % voided trade(s) already have escrowed_at or escrow_amount set. Rows are not deleted and amount and escrow_amount are not rewritten.',
      violating
      USING ERRCODE = 'check_violation';
  END IF;
END $$;

ALTER TABLE "p2p"."p2p_trades" DROP CONSTRAINT IF EXISTS "p2p_trades_voided_requires_no_escrow_ck";
ALTER TABLE "p2p"."p2p_trades" ADD CONSTRAINT "p2p_trades_voided_requires_no_escrow_ck"
  CHECK (
    "resolution" IS DISTINCT FROM 'voided'
    OR ("escrowed_at" IS NULL AND "escrow_amount" IS NULL)
  );
