-- Reverses 20261024204652_pay_custody_deposit_travel_rule.sql. Refuses while any deposit is held or parked for the travel rule,
-- or any travel-rule record exists: those rows are the compliance record, and dropping them would release held funds unreviewed.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "pay"."custody_deposits" WHERE "status" = 'held_travel_rule' OR "reason" LIKE 'travel_rule%') THEN
    RAISE EXCEPTION 'custody deposits held for the travel rule exist; release them before reversing';
  END IF;
  IF EXISTS (SELECT 1 FROM "pay"."custody_deposit_travel_rule") THEN
    RAISE EXCEPTION 'deposit travel-rule records exist; they are the compliance record and are not dropped';
  END IF;
END
$$;
ALTER TABLE "pay"."custody_deposits" DROP CONSTRAINT IF EXISTS "custody_deposits_travel_rule_ck";
ALTER TABLE "pay"."custody_deposits" DROP CONSTRAINT IF EXISTS "custody_deposits_status_ck";
ALTER TABLE "pay"."custody_deposits" ADD CONSTRAINT "custody_deposits_status_ck" CHECK ("status" IN
  ('detected', 'confirming', 'credited', 'below_minimum', 'held_for_screening', 'held_for_release', 'on_hold', 'rejected',
   'reversed', 'needs_review'));
ALTER TABLE "pay"."custody_deposits" DROP CONSTRAINT IF EXISTS "custody_deposits_reason_ck";
ALTER TABLE "pay"."custody_deposits" ADD CONSTRAINT "custody_deposits_reason_ck" CHECK ("reason" IS NULL OR "reason" IN
  ('below_minimum', 'amount_mismatch', 'unknown_asset', 'minimum_unset', 'confirmations_unset', 'address_expired', 'chain_reorg',
   'reversal_unfunded', 'address_frozen'));
DROP TABLE IF EXISTS "pay"."custody_deposit_travel_rule_events";
DROP TABLE IF EXISTS "pay"."custody_deposit_travel_rule";
DROP TABLE IF EXISTS "pay"."travel_rule_inbound_rule_events";
