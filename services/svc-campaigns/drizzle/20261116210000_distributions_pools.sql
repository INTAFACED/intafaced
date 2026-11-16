-- intafaced:destructive drops and rebuilds the campaign_rows view (a read view, no data) so it carries the new columns
-- J-campaigns-13, CM-airdrop-campaigns-01 and -02: an airdrop distribution and a reward pool paying daily, both from
-- INTAFACED's own pool (the campaign's budget). Their terms are part of the campaign's definition. A distribution's
-- snapshot is taken once: each account that joined is read from the venue once and its standing kept (counted, excluded
-- for a negative equity, or held out when unread), then every share is written in one transaction, summing exactly to
-- the pool, each a reward intent `distribution:<campaign>:<account>` owed once and paid once by the reward saga and
-- payer. A run stopped part way resumes from the standings it kept, so no account is read twice or owed twice. A pool's
-- day is settled once: each entrant's activity, venue equity and share, the shares total and the remainder are written
-- together, each share a reward intent `pool:<campaign>:<day>:<account>`. No balance here. Reversal: the .down.sql.

ALTER TABLE campaigns.campaigns ADD COLUMN IF NOT EXISTS distribution jsonb;
ALTER TABLE campaigns.campaigns ADD COLUMN IF NOT EXISTS pool jsonb;

DROP VIEW IF EXISTS campaigns.campaign_rows;
CREATE VIEW campaigns.campaign_rows AS
SELECT c.*,
  COALESCE((SELECT sum(i.amount) FROM campaigns.reward_intents i
    WHERE i.campaign_id = c.id AND i.state NOT IN ('failed', 'forfeited', 'withheld')), 0)::text AS budget_drawn
FROM campaigns.campaigns c;

ALTER TABLE campaigns.reward_intents DROP CONSTRAINT IF EXISTS reward_intents_key_ck;
ALTER TABLE campaigns.reward_intents ADD CONSTRAINT reward_intents_key_ck CHECK (
  reward_key = 'task:' || campaign_id || ':' || account_id || ':' || period
  OR (period ~ '^voucher:[^:]+:[1-9][0-9]*$'
    AND reward_key = 'voucher:' || split_part(period, ':', 2) || ':' || account_id || ':' || split_part(period, ':', 3))
  OR (period ~ '^competition:[1-9][0-9]*$'
    AND reward_key = 'competition:' || campaign_id || ':' || split_part(period, ':', 2) || ':' || account_id)
  OR (period ~ '^competition:[1-9][0-9]*:m[1-9][0-9]*$'
    AND reward_key = 'competition:' || campaign_id || ':' || split_part(period, ':', 2) || ':' || account_id || ':'
      || split_part(period, ':', 3))
  OR (period = 'distribution' AND reward_key = 'distribution:' || campaign_id || ':' || account_id)
  OR (period ~ '^pool:[1-9][0-9]*$'
    AND reward_key = 'pool:' || campaign_id || ':' || split_part(period, ':', 2) || ':' || account_id)
);

CREATE TABLE IF NOT EXISTS campaigns.distribution_runs (
  campaign_id text PRIMARY KEY REFERENCES campaigns.campaigns (id),
  snapshot_at timestamptz NOT NULL,
  asset text NOT NULL,
  equity_asset text NOT NULL,
  pool numeric(38, 18) NOT NULL CHECK (pool > 0),
  -- `reading` while standings are being taken; `owed` once every share is written, in the same transaction.
  state text NOT NULL DEFAULT 'reading' CHECK (state IN ('reading', 'owed')),
  total_equity numeric(38, 18),
  shares_total numeric(38, 18),
  started_at timestamptz NOT NULL DEFAULT now(),
  owed_at timestamptz,
  -- Shares sum exactly to the pool, or to nothing when no account counted had equity.
  CONSTRAINT distribution_runs_owed_ck CHECK (state <> 'owed' OR (owed_at IS NOT NULL AND total_equity IS NOT NULL
    AND (shares_total = pool OR (total_equity = 0 AND shares_total = 0))))
);

CREATE TABLE IF NOT EXISTS campaigns.distribution_standings (
  campaign_id text NOT NULL REFERENCES campaigns.distribution_runs (campaign_id),
  account_id text NOT NULL,
  -- `unread` while the venue has not answered and the run still waits for it; `held_out` once the wait is over.
  standing text NOT NULL CHECK (standing IN ('counted', 'excluded_negative', 'held_out', 'unread')),
  equity numeric(38, 18),
  as_of timestamptz,
  reason text,
  attempts integer NOT NULL DEFAULT 1,
  share numeric(38, 18),
  reward_key text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (campaign_id, account_id),
  CONSTRAINT distribution_standings_equity_ck CHECK ((standing IN ('counted', 'excluded_negative')) = (equity IS NOT NULL)),
  CONSTRAINT distribution_standings_negative_ck CHECK (standing <> 'excluded_negative' OR equity < 0),
  CONSTRAINT distribution_standings_counted_ck CHECK (standing <> 'counted' OR equity >= 0),
  CONSTRAINT distribution_standings_share_ck CHECK (share IS NULL OR (standing = 'counted' AND share >= 0))
);

CREATE TABLE IF NOT EXISTS campaigns.pool_days (
  campaign_id text NOT NULL REFERENCES campaigns.campaigns (id),
  day integer NOT NULL CHECK (day > 0),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  slice numeric(38, 18) NOT NULL CHECK (slice >= 0),
  total_activity numeric(38, 18) NOT NULL CHECK (total_activity >= 0),
  shares_total numeric(38, 18) NOT NULL CHECK (shares_total >= 0),
  remainder numeric(38, 18) NOT NULL CHECK (remainder >= 0),
  settled_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (campaign_id, day),
  CONSTRAINT pool_days_sum_ck CHECK (shares_total + remainder = slice)
);

CREATE TABLE IF NOT EXISTS campaigns.pool_day_shares (
  campaign_id text NOT NULL,
  day integer NOT NULL,
  account_id text NOT NULL,
  activity numeric(38, 18) NOT NULL CHECK (activity >= 0),
  balance numeric(38, 18) NOT NULL,
  balance_as_of timestamptz NOT NULL,
  eligible boolean NOT NULL,
  share numeric(38, 18) NOT NULL CHECK (share >= 0),
  capped boolean NOT NULL,
  reward_key text,
  PRIMARY KEY (campaign_id, day, account_id),
  FOREIGN KEY (campaign_id, day) REFERENCES campaigns.pool_days (campaign_id, day),
  CONSTRAINT pool_day_shares_ineligible_ck CHECK (eligible OR share = 0),
  CONSTRAINT pool_day_shares_key_ck CHECK ((share > 0) = (reward_key IS NOT NULL))
);
