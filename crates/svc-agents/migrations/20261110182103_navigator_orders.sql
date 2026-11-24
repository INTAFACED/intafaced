-- svc-agents · the orders the Navigator sends through the session key the person signed (J-agents-19 #4)
-- Reversal: 20261110182103_navigator_orders.down.sql
--
-- A person who signed a cap for the Navigator's session key has consented to trades inside it. An order is one trade
-- the Navigator sent for them, keyed agents:navigator:order:<session>:<request id>, so a retried ask is the same order
-- and is sent once. It records what was asked, the pool, the amount spent in wei of the token the cap measures, the
-- minimum out, and the transaction hash; the fill is the chain's, read from its receipt. Nothing here is a balance: an
-- order holds part of the cap until the chain says it reverted or the network refused it.

CREATE TABLE IF NOT EXISTS "agents"."navigator_orders" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"         text NOT NULL,
  "session_id"      uuid NOT NULL REFERENCES "agents"."agent_sessions" ("id"),
  "order_key"       text NOT NULL,
  "ask_text"        text NOT NULL,
  "chain_id"        integer NOT NULL,
  "account"         text NOT NULL,
  "session_key"     text NOT NULL,
  -- The granted scope the order was sent under: the cap it counts against is that grant's.
  "spec_hash"       text NOT NULL,
  "pool"            text NOT NULL,
  "token_in"        text NOT NULL,
  "token_in_symbol" text NOT NULL,
  "token_out"       text NOT NULL,
  "token_out_symbol" text NOT NULL,
  -- Wei, exact. Never a float.
  "amount_in_wei"   numeric(78, 0) NOT NULL,
  "min_out_wei"     numeric(78, 0) NOT NULL,
  "status"          text NOT NULL DEFAULT 'sending',
  "tx_hash"         text,
  "created_at"      timestamptz NOT NULL DEFAULT now(),
  "updated_at"      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "navigator_orders_amount_ck" CHECK ("amount_in_wei" > 0 AND "min_out_wei" > 0),
  CONSTRAINT "navigator_orders_status_ck" CHECK ("status" IN ('sending', 'sent', 'filled', 'reverted', 'failed')),
  CONSTRAINT "navigator_orders_key_uq" UNIQUE ("user_id", "order_key")
);
CREATE INDEX IF NOT EXISTS "navigator_orders_session_idx" ON "agents"."navigator_orders" ("user_id", "session_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "navigator_orders_grant_idx" ON "agents"."navigator_orders" ("user_id", "chain_id", "account", "spec_hash");
