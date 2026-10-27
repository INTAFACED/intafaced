-- P-ads-merchant-19 / J-p2p-04 #5: a party to an order reports a sensitive remark in its payment note, and a case opens.
-- One case per (order, reporter), written under the order's lock with the other party as the reported one. The row is
-- also the outbox for p2pRemarkCaseOpened (handed_at), which tells the reported party. No balance is stored here.
-- Reversal: 20261025030000_p2p_remark_cases.down.sql
CREATE TABLE IF NOT EXISTS "p2p"."remark_cases" (
  "id" uuid PRIMARY KEY,
  "trade_id" uuid NOT NULL REFERENCES "p2p"."p2p_trades" ("id"),
  "reporter_id" text NOT NULL,
  "reported_id" text NOT NULL,
  "reporter_role" text NOT NULL,
  "remark" text NOT NULL,
  "status" text NOT NULL DEFAULT 'open',
  "opened_at" timestamptz NOT NULL,
  "handed_at" timestamptz,
  CONSTRAINT "remark_cases_one_per_reporter" UNIQUE ("trade_id", "reporter_id"),
  CONSTRAINT "remark_cases_parties_ck" CHECK ("reporter_id" <> "reported_id"),
  CONSTRAINT "remark_cases_role_ck" CHECK ("reporter_role" IN ('buyer', 'seller')),
  CONSTRAINT "remark_cases_remark_ck" CHECK (char_length("remark") BETWEEN 1 AND 280),
  CONSTRAINT "remark_cases_status_ck" CHECK ("status" IN ('open'))
);
CREATE INDEX IF NOT EXISTS "remark_cases_owed_idx" ON "p2p"."remark_cases" ("opened_at") WHERE "handed_at" IS NULL;
CREATE INDEX IF NOT EXISTS "remark_cases_open_idx" ON "p2p"."remark_cases" ("opened_at") WHERE "status" = 'open';
