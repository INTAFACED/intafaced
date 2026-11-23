-- svc-agents · the payment method a person chose for their own agent's runs (J-agents-02 #4)
-- Reversal: 20261108205922_own_agent_payment_methods.down.sql
--
-- One row per own agent at most: the wallet the person chose, one they linked by their own signature (identity holds
-- the link; svc-agents keeps only the address). Choosing checks through identity that it is linked right now; each run
-- checks again before the wallet's balance is read from the chain. No row: runs are checked against the platform
-- balance as before. The address is not a balance and nothing here moves value (OWNER 226: users pay from their own
-- wallets; INTAFACED holds no customer money).

CREATE TABLE IF NOT EXISTS "agents"."own_agent_payment_methods" (
  "agent_id"   uuid PRIMARY KEY REFERENCES "agents"."own_agents" ("id"),
  "owner_id"   text NOT NULL,
  "kind"       text NOT NULL,
  "address"    text NOT NULL,
  "chosen_at"  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "own_agent_payment_methods_kind_ck" CHECK ("kind" = 'wallet'),
  CONSTRAINT "own_agent_payment_methods_address_ck" CHECK ("address" ~ '^0x[0-9a-f]{40}$')
);

CREATE INDEX IF NOT EXISTS "own_agent_payment_methods_owner_idx" ON "agents"."own_agent_payment_methods" ("owner_id");
