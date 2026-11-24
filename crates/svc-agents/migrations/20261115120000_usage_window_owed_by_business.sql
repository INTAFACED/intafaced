-- svc-agents · which business owes a team run's usage window (J-agents-11; launch money model, OWNER 226)
-- Reversal: 20261115120000_usage_window_owed_by_business.down.sql
--
-- A business team's run is paid by the business: its sealed window is earned in our ledger as owed by the business,
-- naming the member, and collected from the business's payment method. `owed_by_business` is that business, written
-- when the window is earned; null on every other window (owed by the person who ran it, or the custodial layer's
-- charge to them). Nothing here is a balance and no value moves.

ALTER TABLE "agents"."usage_windows" ADD COLUMN IF NOT EXISTS "owed_by_business" text;
