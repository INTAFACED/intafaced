-- Task campaigns and the reward saga (CM-tasks-quests-01, CM-payouts-ledger-02, J-campaigns-02). Reversal: the
-- matching .down.sql.
--
-- Nothing here is a balance. Progress is one row per (campaign, account, step, event id), so a redelivered event adds
-- nothing. A reward intent is written before any ledger call, unique on its business key, and the key it posts under is
-- `reward:` || reward_key. A budget is still a limit: what a campaign has reserved or spent is summed from its intents.
-- The reward pot is svc-ledger's; a pot funding row is the intent of one sweep of earned fees into it.

ALTER TABLE campaigns.campaigns ADD COLUMN IF NOT EXISTS tasks jsonb;

CREATE TABLE IF NOT EXISTS campaigns.task_progress (
  campaign_id text NOT NULL REFERENCES campaigns.campaigns (id),
  account_id text NOT NULL,
  step_index smallint NOT NULL,
  event_id text NOT NULL,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (campaign_id, account_id, step_index, event_id),
  CONSTRAINT task_progress_step_ck CHECK (step_index >= 0 AND step_index < 10)
);

-- When an account's last step completed: the claim window opens then. Written once.
CREATE TABLE IF NOT EXISTS campaigns.task_completions (
  campaign_id text NOT NULL REFERENCES campaigns.campaigns (id),
  account_id text NOT NULL,
  completed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (campaign_id, account_id)
);

CREATE TABLE IF NOT EXISTS campaigns.reward_intents (
  reward_key text PRIMARY KEY,
  campaign_id text NOT NULL REFERENCES campaigns.campaigns (id),
  account_id text NOT NULL,
  period text NOT NULL,
  asset text NOT NULL,
  amount numeric(38, 18) NOT NULL,
  state text NOT NULL,
  reason text,
  ledger_tx_id text,
  attempts integer NOT NULL DEFAULT 0,
  last_attempt_at timestamptz,
  posted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reward_intents_one_per_period UNIQUE (campaign_id, account_id, period),
  CONSTRAINT reward_intents_key_ck CHECK (reward_key = 'task:' || campaign_id || ':' || account_id || ':' || period),
  CONSTRAINT reward_intents_amount_ck CHECK (amount > 0),
  CONSTRAINT reward_intents_state_ck CHECK (state IN ('qualified', 'posting', 'posted', 'pending_funding', 'pending_retry',
    'unknown', 'withheld', 'failed', 'forfeited')),
  -- A posted intent names its ledger transaction; nothing else does.
  CONSTRAINT reward_intents_posted_ck CHECK ((state = 'posted') = (ledger_tx_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS reward_intents_open_idx ON campaigns.reward_intents (state, last_attempt_at)
  WHERE state IN ('qualified', 'posting', 'pending_funding', 'pending_retry', 'unknown');
CREATE INDEX IF NOT EXISTS reward_intents_campaign_idx ON campaigns.reward_intents (campaign_id, state);

-- The redemption log: every attempt on an intent, with its outcome and typed reason. Append only.
CREATE TABLE IF NOT EXISTS campaigns.redemption_attempts (
  id bigserial PRIMARY KEY,
  reward_key text NOT NULL REFERENCES campaigns.reward_intents (reward_key),
  outcome text NOT NULL,
  reason text,
  at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT redemption_attempts_outcome_ck CHECK (outcome IN ('qualified', 'posted', 'refused', 'unknown', 'withheld',
    'forfeited'))
);

CREATE INDEX IF NOT EXISTS redemption_attempts_key_idx ON campaigns.redemption_attempts (reward_key, id);

CREATE TABLE IF NOT EXISTS campaigns.pot_fundings (
  reference text PRIMARY KEY,
  source_module text NOT NULL,
  asset text NOT NULL,
  amount numeric(38, 18) NOT NULL,
  state text NOT NULL DEFAULT 'requested',
  reason text,
  requested_by text NOT NULL,
  approved_by text,
  ledger_tx_id text,
  attempts integer NOT NULL DEFAULT 0,
  last_attempt_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pot_fundings_module_ck CHECK (source_module IN ('trade')),
  CONSTRAINT pot_fundings_amount_ck CHECK (amount > 0),
  CONSTRAINT pot_fundings_state_ck CHECK (state IN ('requested', 'posting', 'posted', 'refused', 'unknown')),
  -- The person who asked never approves.
  CONSTRAINT pot_fundings_second_person_ck CHECK (approved_by IS NULL OR approved_by <> requested_by),
  CONSTRAINT pot_fundings_approved_ck CHECK (state = 'requested' OR approved_by IS NOT NULL),
  CONSTRAINT pot_fundings_posted_ck CHECK ((state = 'posted') = (ledger_tx_id IS NOT NULL))
);

-- The campaign as every read sees it: its row and what its reward intents draw on the budget limit (every intent that
-- is not failed, forfeited or withheld). A sum over the intents, never a stored counter.
CREATE OR REPLACE VIEW campaigns.campaign_rows AS
SELECT c.*,
  COALESCE((SELECT sum(i.amount) FROM campaigns.reward_intents i
    WHERE i.campaign_id = c.id AND i.state NOT IN ('failed', 'forfeited', 'withheld')), 0)::text AS budget_drawn
FROM campaigns.campaigns c;
