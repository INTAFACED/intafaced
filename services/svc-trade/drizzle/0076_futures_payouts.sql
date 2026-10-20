-- trade.futures_payouts · one row per realised futures profit: paid, or owed until the clearing pot holds it
-- Reversal: 0076_futures_payouts.down.sql
--
-- docs/adr/2026-10-20-futures-matched-traders.md section 4. A winner is paid from the futures clearing pot
-- (`futuresLossSink`). When the pot cannot cover the profit, the position still closes and the profit is kept here
-- as an intent to post `futuresRealizeProfit` under `profit_id`, exactly once, when the pot holds it. This row is
-- never a balance: nothing can be spent, moved or withdrawn from it. The ledger posting under `profit_id` is the
-- money; `state` only says whether that posting has happened yet.

CREATE TABLE IF NOT EXISTS "trade"."futures_payouts" (
  "profit_id"       text           PRIMARY KEY,
  "position_id"     uuid           NOT NULL,
  "user_id"         uuid           NOT NULL,
  "asset_id"        text           NOT NULL,
  "amount"          numeric(38, 18) NOT NULL,
  "state"           text           NOT NULL,
  "refusal_code"    text,
  "attempts"        integer        NOT NULL DEFAULT 0,
  "created_at"      timestamptz    NOT NULL DEFAULT now(),
  "last_attempt_at" timestamptz,
  "paid_at"         timestamptz,
  CONSTRAINT "futures_payouts_amount_ck" CHECK ("amount" > 0),
  CONSTRAINT "futures_payouts_state_ck" CHECK ("state" IN ('pending', 'paid')),
  CONSTRAINT "futures_payouts_paid_at_ck" CHECK (("state" = 'paid') = ("paid_at" IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS "futures_payouts_pending_idx" ON "trade"."futures_payouts" ("created_at") WHERE "state" = 'pending';
CREATE INDEX IF NOT EXISTS "futures_payouts_user_idx" ON "trade"."futures_payouts" ("user_id", "created_at" DESC);
