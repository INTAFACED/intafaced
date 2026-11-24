-- Send to a bank account over a bank rail (BK-xfer-02, J-bank-04 #1): the customer's send intents.
--
-- A customer picks a rail (ACH, domestic wire, real-time, SEPA or a proxy id such as a phone number or email), fills
-- that rail's recipient form and asks to send. With no banking partner on the rail (`rail.bank`) the intent is kept
-- `refused` with the code, and nothing is held or posted. The request id is the customer's business key for one ask:
-- the same id on the same terms is the same intent. Money only leaves a space through the ledger's recipes once a partner
-- carries the rail, never through this table.
--
-- Reversal: 0058_rail_send_intents.down.sql

CREATE TABLE IF NOT EXISTS "bank"."rail_send_intents" (
  "id" uuid PRIMARY KEY,
  "user_id" text NOT NULL,
  "from_space_id" uuid NOT NULL,
  "asset_id" text NOT NULL,
  "amount" numeric(38, 18) NOT NULL,
  "rail" text NOT NULL,
  "recipient" jsonb NOT NULL,
  "status" text NOT NULL,
  "refusal_code" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "rail_send_intents_amount_ck" CHECK ("amount" > 0),
  CONSTRAINT "rail_send_intents_rail_ck" CHECK ("rail" IN ('ach', 'wire', 'instant', 'sepa', 'proxy')),
  CONSTRAINT "rail_send_intents_status_ck" CHECK ("status" = 'refused' AND "refusal_code" IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS "rail_send_intents_user_idx"
  ON "bank"."rail_send_intents" ("user_id", "created_at" DESC);
