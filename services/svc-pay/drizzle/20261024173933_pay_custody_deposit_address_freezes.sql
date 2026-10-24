-- W-compliance-notices-03 (J-wallet-03 #4): compliance freezes one customer deposit address, and a second founder unfreezes it.
-- NO BALANCE LIVES HERE AND NOTHING IS POSTED BY A FREEZE. While an address has an open freeze, a deposit to it that is not yet
-- credited is `on_hold` with reason `address_frozen`, and it is never credited. A credit that already started is finished,
-- because it may already be in the ledger. The unfreeze needs an identity approval from a second founder, bound to this freeze
-- id. The held deposits then go back to being judged, and each is credited once under its usual `deposit` key. Every freeze
-- stays as a row, so the table is also the history.
-- Reversal: 20261024173933_pay_custody_deposit_address_freezes.down.sql

CREATE TABLE IF NOT EXISTS "pay"."custody_deposit_address_freezes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" text NOT NULL,
  "network_id" text NOT NULL,
  "address" text NOT NULL,
  "reason" text NOT NULL,
  "frozen_by" text NOT NULL,
  "frozen_at" timestamptz NOT NULL DEFAULT now(),
  "unfrozen_by" text,
  "unfreeze_approver" text,
  "unfreeze_reason" text,
  "unfrozen_at" timestamptz,
  CONSTRAINT "custody_deposit_address_freezes_address_ck" CHECK ("address" = lower("address") AND length("address") BETWEEN 1 AND 256),
  CONSTRAINT "custody_deposit_address_freezes_reason_ck" CHECK (length(btrim("reason")) BETWEEN 1 AND 500),
  CONSTRAINT "custody_deposit_address_freezes_unfreeze_ck" CHECK (
    ("unfrozen_at" IS NULL AND "unfrozen_by" IS NULL AND "unfreeze_approver" IS NULL AND "unfreeze_reason" IS NULL)
    OR ("unfrozen_at" IS NOT NULL AND "unfrozen_by" IS NOT NULL AND "unfreeze_approver" IS NOT NULL
        AND length(btrim("unfreeze_reason")) BETWEEN 1 AND 500 AND lower("unfreeze_approver") <> lower("unfrozen_by")))
);
-- One open freeze per address.
CREATE UNIQUE INDEX IF NOT EXISTS "custody_deposit_address_freezes_open_uq"
  ON "pay"."custody_deposit_address_freezes" ("network_id", "address") WHERE "unfrozen_at" IS NULL;
CREATE INDEX IF NOT EXISTS "custody_deposit_address_freezes_user_idx"
  ON "pay"."custody_deposit_address_freezes" ("user_id", "frozen_at" DESC);

ALTER TABLE "pay"."custody_deposits" DROP CONSTRAINT IF EXISTS "custody_deposits_status_ck";
ALTER TABLE "pay"."custody_deposits" ADD CONSTRAINT "custody_deposits_status_ck" CHECK ("status" IN
  ('detected', 'confirming', 'credited', 'below_minimum', 'held_for_screening', 'held_for_release', 'on_hold', 'rejected',
   'reversed', 'needs_review'));
ALTER TABLE "pay"."custody_deposits" DROP CONSTRAINT IF EXISTS "custody_deposits_reason_ck";
ALTER TABLE "pay"."custody_deposits" ADD CONSTRAINT "custody_deposits_reason_ck" CHECK ("reason" IS NULL OR "reason" IN
  ('below_minimum', 'amount_mismatch', 'unknown_asset', 'minimum_unset', 'confirmations_unset', 'address_expired', 'chain_reorg',
   'reversal_unfunded', 'address_frozen'));
-- An on-hold deposit is never credited, and it is held for no other reason.
ALTER TABLE "pay"."custody_deposits" DROP CONSTRAINT IF EXISTS "custody_deposits_on_hold_ck";
ALTER TABLE "pay"."custody_deposits" ADD CONSTRAINT "custody_deposits_on_hold_ck" CHECK (
  "status" <> 'on_hold' OR ("reason" = 'address_frozen' AND "credited_at" IS NULL AND "credit_started_at" IS NULL));

-- settleOpen looks for held rows whose freeze was lifted on every pass; this keeps that to the held rows only.
CREATE INDEX IF NOT EXISTS "custody_deposits_on_hold_idx"
  ON "pay"."custody_deposits" ("network_id", lower("address")) WHERE "status" = 'on_hold';
