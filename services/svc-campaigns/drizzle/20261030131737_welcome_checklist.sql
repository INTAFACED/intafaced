-- The welcome checklist (CM-rewards-hub-03, J-campaigns-04). A `welcome` campaign is a task campaign whose tasks are a
-- fixed first-time list (verify, first crypto deposit credited, first spot fill) with a reward per task, and whose window
-- opens at each account's sign-up. Nothing here is a balance: a claimed task is a reward intent like any other, under
-- `task:<campaign>:<account>:welcome:<event>`, paid by the reward saga. Reversal: the matching .down.sql.

ALTER TABLE campaigns.campaigns DROP CONSTRAINT IF EXISTS campaigns_type_ck;
ALTER TABLE campaigns.campaigns ADD CONSTRAINT campaigns_type_ck CHECK (type IN ('referral', 'task', 'voucher', 'competition',
  'milestone', 'draw', 'pool', 'distribution', 'trial_pass', 'gift_card', 'points', 'welcome'));

-- When each account signed up (`identity.user.created`), and the welcome campaign that was live then (null: none was).
-- Written once per account: a redelivered sign-up changes nothing.
CREATE TABLE IF NOT EXISTS campaigns.welcome_accounts (
  account_id text PRIMARY KEY,
  signed_up_at timestamptz NOT NULL,
  campaign_id text REFERENCES campaigns.campaigns (id),
  event_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- The first event of each welcome task kind per account: it ticks the task once. A later event of the same kind, or the
-- same one again, changes nothing; one that arrives out of order and happened earlier takes its place.
CREATE TABLE IF NOT EXISTS campaigns.welcome_events (
  account_id text NOT NULL,
  event text NOT NULL,
  event_id text NOT NULL,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, event),
  CONSTRAINT welcome_events_event_ck CHECK (event IN ('identity.verified', 'pay.deposit', 'trade.fill'))
);
