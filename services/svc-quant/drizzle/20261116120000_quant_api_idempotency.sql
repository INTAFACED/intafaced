-- svc-quant · the strategy API's Idempotency-Key (AL-api-01, J-algo-dev-14 #4)
-- Reversal: the matching .down.sql
--
-- No money, no balance, no ledger post. One row per account and Idempotency-Key a key sent to start a backtest, with a
-- hash of what that request asked for: the same key with the same request goes on and reads back the one stored run;
-- the same key with a different request is refused quant.idempotency_key_reused and runs nothing.

CREATE TABLE IF NOT EXISTS "quant"."api_idempotency" (
  "account_id" uuid NOT NULL,
  "idempotency_key" text NOT NULL CHECK (char_length("idempotency_key") BETWEEN 1 AND 128),
  "request_hash" text NOT NULL CHECK ("request_hash" ~ '^[0-9a-f]{64}$'),
  "created_at" timestamptz NOT NULL,
  PRIMARY KEY ("account_id", "idempotency_key")
);
