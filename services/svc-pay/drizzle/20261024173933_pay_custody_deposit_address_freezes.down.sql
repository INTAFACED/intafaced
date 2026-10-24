-- Reverses 20261024173933_pay_custody_deposit_address_freezes.sql. Refuses while a deposit is on hold or any freeze exists:
-- those rows describe a compliance decision, and dropping them would release held funds without the second founder.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "pay"."custody_deposits" WHERE "status" = 'on_hold' OR "reason" = 'address_frozen') THEN
    RAISE EXCEPTION 'custody deposits on hold for a frozen address exist; release them before reversing';
  END IF;
  IF EXISTS (SELECT 1 FROM "pay"."custody_deposit_address_freezes") THEN
    RAISE EXCEPTION 'deposit address freezes exist; they are the compliance record and are not dropped';
  END IF;
END
$$;
DROP INDEX IF EXISTS "pay"."custody_deposits_on_hold_idx";
ALTER TABLE "pay"."custody_deposits" DROP CONSTRAINT IF EXISTS "custody_deposits_on_hold_ck";
ALTER TABLE "pay"."custody_deposits" DROP CONSTRAINT IF EXISTS "custody_deposits_status_ck";
ALTER TABLE "pay"."custody_deposits" ADD CONSTRAINT "custody_deposits_status_ck" CHECK ("status" IN
  ('detected', 'confirming', 'credited', 'below_minimum', 'held_for_screening', 'held_for_release', 'rejected', 'reversed',
   'needs_review'));
ALTER TABLE "pay"."custody_deposits" DROP CONSTRAINT IF EXISTS "custody_deposits_reason_ck";
ALTER TABLE "pay"."custody_deposits" ADD CONSTRAINT "custody_deposits_reason_ck" CHECK ("reason" IS NULL OR "reason" IN
  ('below_minimum', 'amount_mismatch', 'unknown_asset', 'minimum_unset', 'confirmations_unset', 'address_expired', 'chain_reorg',
   'reversal_unfunded'));
DROP TABLE IF EXISTS "pay"."custody_deposit_address_freezes";
