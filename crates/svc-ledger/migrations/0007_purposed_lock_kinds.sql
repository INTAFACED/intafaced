-- intafaced:destructive drops hold-only CHECK accounts_hold_purposed_ck, replaced
-- in the same migration by accounts_lock_purposed_ck covering all lock kinds.
-- svc-ledger · purposed locks for escrow / stake / collateral (STOP §4.2b #1)
-- Reversal: 0007_purposed_lock_kinds.down.sql
--
-- THE DEFECT
--
-- TypeScript `assertPurposedLocks` requires a purpose on hold, escrow, stake,
-- and collateral. The only database CHECK was `accounts_hold_purposed_ck` on
-- hold alone. A raw SQL insert of an unpurposed collateral pot is the worst
-- case: releasing loan A could hand back value securing loan B — every posting
-- balances, recon is green, loan B is quietly unsecured (accounts.ts).
--
-- Same shape as #1044 (asset must exist): TS is not the only insert path the
-- README says will exist.

-- Backfill empty purpose on non-hold lock kinds (none expected on a clean tip;
-- legacy rows get a stable purpose so the CHECK can be added fail-closed).
UPDATE "ledger"."accounts"
   SET "purpose" = 'legacy:' || "id"::text
 WHERE "kind" IN ('escrow', 'stake', 'collateral')
   AND length("purpose") = 0;

ALTER TABLE "ledger"."accounts" DROP CONSTRAINT IF EXISTS "accounts_hold_purposed_ck";
ALTER TABLE "ledger"."accounts" DROP CONSTRAINT IF EXISTS "accounts_lock_purposed_ck";
ALTER TABLE "ledger"."accounts" ADD CONSTRAINT "accounts_lock_purposed_ck"
  CHECK (
    "kind" NOT IN ('hold', 'escrow', 'stake', 'collateral')
    OR length("purpose") > 0
  );
