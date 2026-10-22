-- SP-order-entry-03 write half. An order whose price was moved to the band edge (priceCorrection amend),
-- and the per-account priceCorrection preference (no row = spec default 'cancel').
-- Reversal: 0088_order_entry_rules.down.sql
-- requested_price is set only when the price was moved; the order's price is then the band edge.
ALTER TABLE trade.orders ADD COLUMN IF NOT EXISTS requested_price numeric;
CREATE TABLE IF NOT EXISTS trade.account_price_correction (
  user_id text PRIMARY KEY,
  mode text NOT NULL CHECK (mode IN ('cancel', 'amend')),
  updated_at timestamptz NOT NULL DEFAULT now()
);
