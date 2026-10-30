-- J-campaigns-08, CM-vouchers-coupons-01 and CM-eligibility-rules-04: the voucher redemption key and code attempts.
-- A voucher redemption's business key is the spec's own form (CM-vouchers-coupons-01), with the n-th use after it since a
-- voucher may be used in parts: `voucher:<voucher>:<account>:<n>` (period `voucher:<voucher>:<n>`), so its ledger key is
-- `reward:voucher:<voucher>:<account>:<n>`. Every other intent keeps `task:<campaign>:<account>:<period>`.
ALTER TABLE campaigns.reward_intents DROP CONSTRAINT IF EXISTS reward_intents_key_ck;
ALTER TABLE campaigns.reward_intents ADD CONSTRAINT reward_intents_key_ck CHECK (
  reward_key = 'task:' || campaign_id || ':' || account_id || ':' || period
  OR (period ~ '^voucher:[^:]+:[1-9][0-9]*$'
    AND reward_key = 'voucher:' || split_part(period, ':', 2) || ':' || account_id || ':' || split_part(period, ':', 3))
);

-- Claim and check attempts on voucher codes (CM-eligibility-rules-04, VC-3), counted per account and per source address
-- against owner limits over an owner window. Append only; a row holds no value.
CREATE TABLE IF NOT EXISTS campaigns.voucher_attempts (
  id bigserial PRIMARY KEY,
  account_id text NOT NULL,
  source text,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS voucher_attempts_account_idx ON campaigns.voucher_attempts (account_id, at);
CREATE INDEX IF NOT EXISTS voucher_attempts_source_idx ON campaigns.voucher_attempts (source, at) WHERE source IS NOT NULL;
