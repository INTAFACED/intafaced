-- Refuses while any reward or log line uses a hold state: reversing would leave rows the old constraints refuse.
DROP INDEX IF EXISTS campaigns.reward_intents_held_idx;
ALTER TABLE campaigns.reward_intents DROP CONSTRAINT IF EXISTS reward_intents_held_ck;
ALTER TABLE campaigns.reward_intents DROP CONSTRAINT IF EXISTS reward_intents_state_ck;
ALTER TABLE campaigns.reward_intents ADD CONSTRAINT reward_intents_state_ck CHECK (state IN ('qualified', 'posting', 'posted',
  'pending_funding', 'pending_retry', 'unknown', 'withheld', 'failed', 'forfeited'));
ALTER TABLE campaigns.redemption_attempts DROP CONSTRAINT IF EXISTS redemption_attempts_outcome_ck;
ALTER TABLE campaigns.redemption_attempts ADD CONSTRAINT redemption_attempts_outcome_ck CHECK (outcome IN ('qualified',
  'posted', 'refused', 'unknown', 'withheld', 'forfeited'));
ALTER TABLE campaigns.reward_intents DROP COLUMN IF EXISTS hold_until;
