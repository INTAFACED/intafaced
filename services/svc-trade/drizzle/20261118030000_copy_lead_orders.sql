-- trade.copy · a lead's own orders, each marked a lead trade or not (CB-copy-14, CB-copy-15, CB-copy-16, J-copy-bots-otc-04)
-- Reversal: 20261118030000_copy_lead_orders.down.sql
--
-- A listed lead places ordinary spot orders on the web; each one it sends with the lead switch is recorded here once, by
-- its order id (the engine's business key for the lead's client order id): a lead trade or not, and why not. The copy
-- driver copies only a lead's fills whose order is not recorded as not-lead; an iceberg is never a lead trade. The
-- notional is the order's price times its amount, a decimal string, read for the lead's daily buy cap and per-pair
-- holding. No money moves here: the order itself goes through the ordinary order path.

CREATE TABLE IF NOT EXISTS trade.copy_lead_orders (
  order_id uuid PRIMARY KEY,
  leader_user_id text NOT NULL CONSTRAINT copy_lead_orders_user_ck CHECK (length(btrim(leader_user_id)) > 0),
  symbol text NOT NULL,
  side text NOT NULL CONSTRAINT copy_lead_orders_side_ck CHECK (side IN ('buy', 'sell')),
  notional numeric(38, 18) NOT NULL CONSTRAINT copy_lead_orders_notional_ck CHECK (notional > 0),
  lead boolean NOT NULL,
  not_lead_reason text,
  created_at timestamptz NOT NULL,
  CONSTRAINT copy_lead_orders_reason_ck CHECK (lead OR not_lead_reason IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS copy_lead_orders_leader_idx ON trade.copy_lead_orders (leader_user_id, created_at DESC);
