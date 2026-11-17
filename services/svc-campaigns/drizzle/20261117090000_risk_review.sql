-- intafaced:destructive drops and rebuilds the campaign_rows view (a read view, no data) so a cancelled reward holds no budget
-- J-campaigns-18, CM-abuse-fraud-01 and -02: the risk review of campaign rewards. Reversal: the .down.sql.
--
-- A signal is stored once by (kind, subject, account): the same signal sent twice is one row. An account whose own
-- distinct signals reach the owner's threshold has its new rewards held for review (`review`): they keep their place in
-- the budget and nothing is owed or posted. Revoking an account's rewards cancels each owed reward not yet sent to the
-- wallet once (`reclaiming`, then `cancelled` after the ledger's `campaigns:reclaim:` answer), records what was already
-- paid to the customer's own wallet (never pulled back), and flags the account. An appeal is filed once per case and
-- decided by a person other than the one who revoked.

ALTER TABLE campaigns.reward_intents DROP CONSTRAINT IF EXISTS reward_intents_state_ck;
ALTER TABLE campaigns.reward_intents ADD CONSTRAINT reward_intents_state_ck CHECK (state IN ('held', 'review', 'reclaiming',
  'cancelled', 'qualified', 'posting', 'owed', 'paid', 'locked', 'settling', 'posted', 'pending_funding', 'pending_retry',
  'unknown', 'withheld', 'failed', 'forfeited'));
-- A reward being reclaimed or cancelled was owed first, and is a paid-form reward.
ALTER TABLE campaigns.reward_intents ADD CONSTRAINT reward_intents_reclaim_ck CHECK (
  state NOT IN ('reclaiming', 'cancelled') OR (owe_tx_id IS NOT NULL AND form = 'paid' AND ledger_tx_id IS NULL));

ALTER TABLE campaigns.redemption_attempts DROP CONSTRAINT IF EXISTS redemption_attempts_outcome_ck;
ALTER TABLE campaigns.redemption_attempts ADD CONSTRAINT redemption_attempts_outcome_ck CHECK (outcome IN ('held', 'released',
  'qualified', 'owed', 'paid', 'posted', 'locked', 'unlocked', 'refused', 'unknown', 'withheld', 'forfeited', 'cancelled'));

CREATE TABLE IF NOT EXISTS campaigns.risk_signals (
  kind text NOT NULL CHECK (kind IN ('duplicate_account', 'device', 'anti_churn')),
  subject text NOT NULL CHECK (subject ~ '^[A-Za-z0-9_.:-]{3,128}$'),
  account_id text NOT NULL CHECK (account_id ~ '^[0-9a-f-]{36}$'),
  note text,
  recorded_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, subject, account_id)
);
CREATE INDEX IF NOT EXISTS risk_signals_account_idx ON campaigns.risk_signals (account_id);

CREATE TABLE IF NOT EXISTS campaigns.risk_cases (
  account_id text PRIMARY KEY CHECK (account_id ~ '^[0-9a-f-]{36}$'),
  flagged boolean NOT NULL DEFAULT false,
  revoked_by text,
  revoked_at timestamptz,
  revoke_reason text,
  appeal_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT risk_cases_revoked_ck CHECK ((revoked_at IS NULL) = (revoked_by IS NULL) AND (revoked_at IS NULL) = (appeal_until IS NULL))
);

CREATE TABLE IF NOT EXISTS campaigns.risk_appeals (
  account_id text PRIMARY KEY REFERENCES campaigns.risk_cases (account_id),
  text text NOT NULL,
  filed_at timestamptz NOT NULL DEFAULT now(),
  decided_by text,
  outcome text CHECK (outcome IN ('upheld', 'overturned')),
  decision_reason text,
  decided_at timestamptz,
  CONSTRAINT risk_appeals_decided_ck CHECK ((decided_by IS NULL) = (outcome IS NULL) AND (decided_by IS NULL) = (decided_at IS NULL))
);

CREATE TABLE IF NOT EXISTS campaigns.risk_actions (
  id bigserial PRIMARY KEY,
  account_id text NOT NULL REFERENCES campaigns.risk_cases (account_id),
  action text NOT NULL CHECK (action IN ('withhold', 'revoke', 'cancel', 'record_paid', 'appeal', 'appeal_decided')),
  reward_key text REFERENCES campaigns.reward_intents (reward_key),
  amount numeric(38, 18),
  actor text NOT NULL,
  reason text,
  ledger_tx_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- One withhold, one cancel and one paid record per reward.
CREATE UNIQUE INDEX IF NOT EXISTS risk_actions_once_idx ON campaigns.risk_actions (action, reward_key) WHERE reward_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS risk_actions_account_idx ON campaigns.risk_actions (account_id, created_at);

-- One reclaim per reward: written before the post, so a lost answer posts the same key again and never a second one.
CREATE TABLE IF NOT EXISTS campaigns.risk_reclaims (
  reward_key text PRIMARY KEY REFERENCES campaigns.reward_intents (reward_key),
  account_id text NOT NULL CHECK (account_id ~ '^[0-9a-f-]{36}$'),
  amount numeric(38, 18) NOT NULL CHECK (amount > 0),
  state text NOT NULL DEFAULT 'posting' CHECK (state IN ('posting', 'posted', 'refused')),
  ledger_tx_id text,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT risk_reclaims_posted_ck CHECK ((state = 'posted') = (ledger_tx_id IS NOT NULL))
);

DROP VIEW IF EXISTS campaigns.campaign_rows;
CREATE VIEW campaigns.campaign_rows AS
SELECT c.*,
  COALESCE((SELECT sum(i.amount) FROM campaigns.reward_intents i
    WHERE i.campaign_id = c.id AND i.state NOT IN ('failed', 'forfeited', 'withheld', 'cancelled')), 0)::text AS budget_drawn
FROM campaigns.campaigns c;
