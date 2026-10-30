-- intafaced:destructive drops and rebuilds the campaign_rows view (a read view, no data) so it carries the new column
-- J-campaigns-08, CM-vouchers-coupons-01: a voucher campaign's claim-by and use-by times (part of its definition and so
-- of each revision), and a voucher's claim, use and expiry. A voucher keeps the claim-by and use-by of the revision it
-- was issued under, as it keeps its face value. The face value is a counter, not a balance: each redemption is a reward
-- intent under its own business key, paid by the reward saga (`rewardPay`). What a voucher used is never stored: it is
-- the sum of its redemption intents, read under a lock on the voucher.

ALTER TABLE campaigns.campaigns ADD COLUMN IF NOT EXISTS vouchers jsonb;

DROP VIEW IF EXISTS campaigns.campaign_rows;
CREATE VIEW campaigns.campaign_rows AS
SELECT c.*,
  COALESCE((SELECT sum(i.amount) FROM campaigns.reward_intents i
    WHERE i.campaign_id = c.id AND i.state NOT IN ('failed', 'forfeited', 'withheld')), 0)::text AS budget_drawn
FROM campaigns.campaigns c;

ALTER TABLE campaigns.vouchers ADD COLUMN IF NOT EXISTS claim_by timestamptz;
ALTER TABLE campaigns.vouchers ADD COLUMN IF NOT EXISTS use_by timestamptz;
ALTER TABLE campaigns.vouchers ADD COLUMN IF NOT EXISTS claimed_by text;
ALTER TABLE campaigns.vouchers ADD COLUMN IF NOT EXISTS claimed_at timestamptz;
ALTER TABLE campaigns.vouchers ADD COLUMN IF NOT EXISTS expired_at timestamptz;

-- A voucher past `published` has an owner; one still published has none.
ALTER TABLE campaigns.vouchers DROP CONSTRAINT IF EXISTS vouchers_claimed_ck;
ALTER TABLE campaigns.vouchers ADD CONSTRAINT vouchers_claimed_ck CHECK (
  (state IN ('claimed', 'partially_used', 'used', 'expired')) = (claimed_by IS NOT NULL AND claimed_at IS NOT NULL)
);
ALTER TABLE campaigns.vouchers DROP CONSTRAINT IF EXISTS vouchers_expired_ck;
ALTER TABLE campaigns.vouchers ADD CONSTRAINT vouchers_expired_ck CHECK ((state = 'expired') = (expired_at IS NOT NULL));

CREATE INDEX IF NOT EXISTS vouchers_code_idx ON campaigns.vouchers (code);
CREATE INDEX IF NOT EXISTS vouchers_owner_idx ON campaigns.vouchers (claimed_by, claimed_at) WHERE claimed_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS vouchers_use_by_idx ON campaigns.vouchers (use_by)
  WHERE state IN ('claimed', 'partially_used', 'used');

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
