-- A look-alike address saved after the customer confirmed it (W-withdraw-03, J-wallet-04 #3).
--
-- An address that shows like one already in the customer's book (same `0x` and first four, same last four, a different
-- middle: the address-poisoning shape) is saved only once the customer says they checked it. The confirmation is recorded
-- on the entry: which saved entry it was confirmed against, and when. Both are set together or not at all. The other
-- entry is kept by id only, with no foreign key, so removing it later does not erase the record.
--
-- Reversal: 0054_withdraw_lookalike_confirmed.down.sql

ALTER TABLE "bank"."user_withdraw_destinations" ADD COLUMN IF NOT EXISTS "lookalike_of" uuid;
ALTER TABLE "bank"."user_withdraw_destinations" ADD COLUMN IF NOT EXISTS "lookalike_confirmed_at" timestamptz;

ALTER TABLE "bank"."user_withdraw_destinations" DROP CONSTRAINT IF EXISTS "user_withdraw_destinations_lookalike_ck";
ALTER TABLE "bank"."user_withdraw_destinations" ADD CONSTRAINT "user_withdraw_destinations_lookalike_ck"
  CHECK (("lookalike_of" IS NULL) = ("lookalike_confirmed_at" IS NULL));
