-- Reward holds (CM-payouts-ledger-01 part 1, J-campaigns-03 #2-#3). Reversal: the matching .down.sql.
--
-- A claimed reward on a campaign with a risk-review hold is written `held` with the time its hold ends. It stays in the
-- budget (the campaign_rows view counts it) and nothing is posted. When the hold ends it is released once, by a
-- conditional update to `qualified`, and the reward saga posts it under its own key; an account that is not active then
-- is `withheld` instead.

ALTER TABLE campaigns.reward_intents ADD COLUMN IF NOT EXISTS hold_until timestamptz;

ALTER TABLE campaigns.reward_intents DROP CONSTRAINT IF EXISTS reward_intents_state_ck;
ALTER TABLE campaigns.reward_intents ADD CONSTRAINT reward_intents_state_ck CHECK (state IN ('held', 'qualified', 'posting',
  'posted', 'pending_funding', 'pending_retry', 'unknown', 'withheld', 'failed', 'forfeited'));
-- A held reward always knows when its hold ends.
ALTER TABLE campaigns.reward_intents ADD CONSTRAINT reward_intents_held_ck CHECK (state <> 'held' OR hold_until IS NOT NULL);

CREATE INDEX IF NOT EXISTS reward_intents_held_idx ON campaigns.reward_intents (hold_until) WHERE state = 'held';

ALTER TABLE campaigns.redemption_attempts DROP CONSTRAINT IF EXISTS redemption_attempts_outcome_ck;
ALTER TABLE campaigns.redemption_attempts ADD CONSTRAINT redemption_attempts_outcome_ck CHECK (outcome IN ('held', 'released',
  'qualified', 'posted', 'refused', 'unknown', 'withheld', 'forfeited'));

-- A task campaign approved before holds existed was approved to pay at once: it keeps that (0). A draft stays blank, so
-- its activation gate names the hold.
UPDATE campaigns.campaigns SET tasks = tasks || '{"holdSeconds": 0}'::jsonb
WHERE tasks IS NOT NULL AND NOT (tasks ? 'holdSeconds') AND state NOT IN ('draft', 'pending_approval');
