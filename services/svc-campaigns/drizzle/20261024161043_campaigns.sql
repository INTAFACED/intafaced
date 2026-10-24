-- The campaign object, its lifecycle and participations (CM-campaign-types-01, CM-eligibility-rules-03 time frame and
-- budget limit). Reversal: the matching .down.sql.
--
-- Nothing here is a balance. A budget is a limit, numeric(38,18) like every amount; nothing in this version reserves
-- or spends against it (the reward saga and its counters are CM-payouts-ledger-02). Joining moves nothing.

CREATE TABLE IF NOT EXISTS campaigns.campaigns (
  id text PRIMARY KEY,
  name text NOT NULL,
  type text NOT NULL,
  state text NOT NULL DEFAULT 'draft',
  revision integer NOT NULL DEFAULT 1,
  rules text NOT NULL DEFAULT '',
  starts_at timestamptz,
  ends_at timestamptz,
  weekdays smallint[],
  hours_from text,
  hours_to text,
  participation jsonb,
  budget_asset text,
  budget_limit numeric(38, 18),
  reward_asset text,
  reward_amount numeric(38, 18),
  created_by text NOT NULL,
  submitted_by text,
  approved_by text,
  approved_revision integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT campaigns_type_ck CHECK (type IN ('referral', 'task', 'voucher', 'competition', 'milestone', 'draw', 'pool',
    'distribution', 'trial_pass', 'gift_card', 'points')),
  CONSTRAINT campaigns_state_ck CHECK (state IN ('draft', 'pending_approval', 'approved', 'scheduled', 'active', 'paused',
    'ended', 'closed', 'archived')),
  CONSTRAINT campaigns_window_ck CHECK (starts_at IS NULL OR ends_at IS NULL OR ends_at > starts_at),
  -- HH:MM in the platform time zone; `to` is exclusive and may be 24:00.
  CONSTRAINT campaigns_hours_ck CHECK ((hours_from IS NULL) = (hours_to IS NULL) AND (hours_from IS NULL OR hours_to > hours_from)),
  CONSTRAINT campaigns_budget_ck CHECK (budget_limit IS NULL OR budget_limit > 0),
  CONSTRAINT campaigns_reward_ck CHECK (reward_amount IS NULL OR reward_amount > 0),
  -- The person who wrote it, and the person who asked for approval, never give it.
  CONSTRAINT campaigns_second_person_ck CHECK (
    approved_by IS NULL OR (submitted_by IS NOT NULL AND approved_by <> submitted_by AND approved_by <> created_by)
  ),
  -- Past approval, the revision approved is the revision live.
  CONSTRAINT campaigns_approved_ck CHECK (
    state IN ('draft', 'pending_approval', 'archived') OR (approved_by IS NOT NULL AND approved_revision = revision)
  )
);

-- One business name per campaign that is not archived.
CREATE UNIQUE INDEX IF NOT EXISTS campaigns_name_live_uq ON campaigns.campaigns (lower(name)) WHERE state <> 'archived';
CREATE INDEX IF NOT EXISTS campaigns_state_idx ON campaigns.campaigns (state, starts_at);

CREATE TABLE IF NOT EXISTS campaigns.participations (
  participation_key text PRIMARY KEY,
  campaign_id text NOT NULL REFERENCES campaigns.campaigns (id),
  account_id text NOT NULL,
  revision integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT participations_one_per_account UNIQUE (campaign_id, account_id),
  CONSTRAINT participations_key_ck CHECK (participation_key = 'campaign:join:' || campaign_id || ':' || account_id)
);

CREATE INDEX IF NOT EXISTS participations_account_idx ON campaigns.participations (account_id, created_at DESC);
