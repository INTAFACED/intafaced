-- The recipient book for bank rails (BK-xfer-06, J-bank-04 #2): the bank accounts and aliases a customer sends to.
--
-- One live row per (customer, destination): saving the same account again is the same recipient. Details are never
-- edited; a changed account is a new row, so the owner's cooling-off window (BANK_PAYEE_COOLING_HOURS) starts again from
-- its created_at. A removed recipient keeps its row with removed_at set. No money is held or posted from this table.
--
-- Reversal: 0059_rail_payees.down.sql

CREATE TABLE IF NOT EXISTS "bank"."rail_payees" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" text NOT NULL,
  "nickname" text NOT NULL,
  "country" text NOT NULL,
  "rail" text NOT NULL,
  "recipient" jsonb NOT NULL,
  "destination_key" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "removed_at" timestamptz,
  CONSTRAINT "rail_payees_rail_ck" CHECK ("rail" IN ('ach', 'wire', 'instant', 'sepa', 'proxy'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "rail_payees_live_destination_uq"
  ON "bank"."rail_payees" ("user_id", "destination_key") WHERE "removed_at" IS NULL;

CREATE INDEX IF NOT EXISTS "rail_payees_user_idx"
  ON "bank"."rail_payees" ("user_id", "created_at" DESC);
