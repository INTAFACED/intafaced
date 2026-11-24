-- svc-bank — atomic multi-recipient payroll (bank.business / §31:811)
--
-- One ledger post pays every line or none. These tables are RECORDS of a
-- completed run (instruction amounts, write-once). No balance column.
-- ledger_tx_id names that post: unique, and not a blank string.

CREATE TABLE IF NOT EXISTS "bank"."business_payroll_runs" (
  "id" uuid PRIMARY KEY,
  "account_id" uuid NOT NULL REFERENCES "bank"."business_accounts" ("id"),
  "actor_user_id" text NOT NULL,
  "from_space_id" uuid NOT NULL,
  "asset_id" text NOT NULL,
  "ledger_tx_id" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "business_payroll_runs_ledger_tx_id_key" UNIQUE ("ledger_tx_id"),
  CONSTRAINT "business_payroll_runs_ledger_tx_id_nonblank" CHECK ("ledger_tx_id" <> '')
);

CREATE TABLE IF NOT EXISTS "bank"."business_payroll_lines" (
  "payroll_id" uuid NOT NULL REFERENCES "bank"."business_payroll_runs" ("id"),
  "to_space_id" uuid NOT NULL,
  "amount" numeric(38, 18) NOT NULL,
  PRIMARY KEY ("payroll_id", "to_space_id"),
  CONSTRAINT "business_payroll_lines_amount_positive" CHECK ("amount" > 0)
);

CREATE INDEX IF NOT EXISTS "business_payroll_runs_account_idx"
  ON "bank"."business_payroll_runs" ("account_id", "created_at");
