-- Reverses 0001_purpose_keyed_holds.sql
--
-- NOTE ON DATA LOSS, because a reversal that quietly destroys money is worse
-- than one that refuses.
--
-- Going back means collapsing every purpose-keyed hold for a (user, asset) into
-- one row. If more than one purposed hold exists for that pair, the collapse
-- would either violate the old unique index or silently merge two reservations
-- into a single indistinguishable pot — re-creating P0-3 and losing the record
-- of which order the value belonged to. A zero balance does not make the
-- second row legal: the index is unique on identity, not on the amount.
--
-- Any recorded purpose identity refuses, including a zero-balance hold.
-- The table lock covers the check and every DDL statement in this block.
DO $$
DECLARE
  offending bigint;
BEGIN
  LOCK TABLE "ledger"."accounts" IN ACCESS EXCLUSIVE MODE;
  IF EXISTS (SELECT 1 FROM "ledger"."accounts" WHERE "purpose" <> '') THEN
    RAISE EXCEPTION 'Cannot reverse 0001: recorded purpose identity must be preserved';
  END IF;
  SELECT count(*) INTO offending
    FROM (
      SELECT 1
        FROM "ledger"."accounts"
       WHERE "kind" = 'hold'
       GROUP BY "owner_type", "owner_id", "asset_id"
      HAVING count(*) > 1
    ) dupes;

  IF offending > 0 THEN
    RAISE EXCEPTION
      'Cannot reverse 0001: % (owner, asset) pair(s) have more than one hold row. '
      'Collapsing them would merge distinct reservations into one bucket and lose which is which (P0-3). '
      'The restored unique index rejects the extra row even at balance zero. '
      'Settle any value, then remove the extra hold rows before rolling back.', offending;
  END IF;
DROP INDEX IF EXISTS "ledger"."accounts_hold_purpose_idx";

CREATE UNIQUE INDEX IF NOT EXISTS "accounts_identity_idx"
  ON "ledger"."accounts" ("owner_type", "owner_id", "asset_id", "kind");

DROP INDEX IF EXISTS "ledger"."accounts_identity_purpose_idx";

ALTER TABLE "ledger"."accounts" DROP CONSTRAINT IF EXISTS "accounts_hold_purposed_ck";
ALTER TABLE "ledger"."accounts" DROP CONSTRAINT IF EXISTS "accounts_purpose_len_ck";
ALTER TABLE "ledger"."accounts" DROP COLUMN IF EXISTS "purpose";

END $$;
