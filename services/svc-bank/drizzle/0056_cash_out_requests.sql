-- Cash out to a linked bank account (BK-ord-01, J-bank-03): the customer's cash-out requests.
--
-- A request is kept whatever the bank answers. With no banking partner (`rail.bank`), or with an account that is not
-- verified or still inside its cooling-off, it is kept `refused` with the code, and nothing is held or posted. The request
-- id is the customer's business key for one ask: the same id on the same terms is the same request. Money only leaves the
-- balance through the ledger's withdraw recipes once a partner pays out, never through this table.
--
-- Reversal: 0056_cash_out_requests.down.sql

CREATE TABLE IF NOT EXISTS "bank"."cash_out_requests" (
  "id" uuid PRIMARY KEY,
  "user_id" text NOT NULL,
  "asset_id" text NOT NULL,
  "amount" numeric(38, 18) NOT NULL,
  "linked_account_id" uuid NOT NULL REFERENCES "bank"."linked_bank_accounts" ("id"),
  "rail" text NOT NULL DEFAULT 'rail.bank',
  "status" text NOT NULL,
  "refusal_code" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "cash_out_requests_amount_ck" CHECK ("amount" > 0),
  CONSTRAINT "cash_out_requests_rail_ck" CHECK ("rail" = 'rail.bank'),
  CONSTRAINT "cash_out_requests_status_ck" CHECK ("status" = 'refused' AND "refusal_code" IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS "cash_out_requests_user_idx"
  ON "bank"."cash_out_requests" ("user_id", "created_at" DESC);
