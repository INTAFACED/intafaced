-- trade.venue_convert_quotes cash leg, trade.test_cash_partner_legs · J-cex-spot-11 #11
-- Reversal: 20261121060548_venue_convert_cash_leg.down.sql
--
-- A convert from a cash currency is two linked legs (src/venue/cash-partner.ts): the partner's cash leg (cash in, a
-- stablecoin delivered to the person's own venue account) and one wallet-signed venue order buying the coin with it. The
-- quote keeps the partner's figure for its cash leg; all four columns are set on a cash quote and null on every other.
-- Nothing here is a balance: we hold none of the money and the ledger posts nothing for either leg.
ALTER TABLE trade.venue_convert_quotes
  ADD COLUMN IF NOT EXISTS cash_stable text,
  ADD COLUMN IF NOT EXISTS cash_rate numeric(38, 18),
  ADD COLUMN IF NOT EXISTS cash_fee numeric(38, 18),
  ADD COLUMN IF NOT EXISTS cash_stable_amount numeric(38, 18);

ALTER TABLE trade.venue_convert_quotes DROP CONSTRAINT IF EXISTS venue_convert_quotes_cash_ck;
ALTER TABLE trade.venue_convert_quotes ADD CONSTRAINT venue_convert_quotes_cash_ck CHECK (
  (cash_stable IS NULL AND cash_rate IS NULL AND cash_fee IS NULL AND cash_stable_amount IS NULL)
  OR (cash_stable IS NOT NULL AND cash_rate > 0 AND cash_fee >= 0 AND cash_stable_amount > 0 AND side = 'buy')
);

-- The LOCAL TEST cash partner's own record of each cash leg (TRADE_CONVERT_CASH_PARTNER=test, refused outside APP_ENV dev
-- or test): one row per business key `convert-cash:<owner>:<quoteId>`, so a retry never runs a leg twice. `leg_id` is the
-- reference the TEST venue credits the delivered stablecoin under. Every figure is TEST.
CREATE TABLE IF NOT EXISTS trade.test_cash_partner_legs (
  business_key text PRIMARY KEY CONSTRAINT test_cash_partner_legs_key_ck CHECK (business_key LIKE 'convert-cash:%'),
  leg_id text NOT NULL UNIQUE,
  user_id text NOT NULL,
  venue_id text NOT NULL,
  owner text NOT NULL CONSTRAINT test_cash_partner_legs_owner_ck CHECK (owner ~ '^0x[0-9a-f]{40}$'),
  currency text NOT NULL,
  cash numeric(38, 18) NOT NULL CONSTRAINT test_cash_partner_legs_cash_ck CHECK (cash > 0),
  fee numeric(38, 18) NOT NULL CONSTRAINT test_cash_partner_legs_fee_ck CHECK (fee >= 0 AND fee < cash),
  rate numeric(38, 18) NOT NULL CONSTRAINT test_cash_partner_legs_rate_ck CHECK (rate > 0),
  stable text NOT NULL,
  stable_amount numeric(38, 18) NOT NULL CONSTRAINT test_cash_partner_legs_stable_ck CHECK (stable_amount > 0),
  state text NOT NULL CONSTRAINT test_cash_partner_legs_state_ck CHECK (state IN ('pending', 'settled', 'refused')),
  refusal text,
  created_at timestamptz NOT NULL,
  settled_at timestamptz,
  CONSTRAINT test_cash_partner_legs_decided_ck CHECK (
    (state = 'pending' AND settled_at IS NULL AND refusal IS NULL)
    OR (state = 'settled' AND settled_at IS NOT NULL AND refusal IS NULL)
    OR (state = 'refused' AND settled_at IS NULL AND refusal IS NOT NULL)
  )
);
