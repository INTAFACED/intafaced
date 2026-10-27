-- Refuses while any reward or log line uses a lock state or form: reversing would leave rows the old constraints refuse.
-- An unsettled locked reward or bonus would become an ordinary reward once `form` is gone, and the old saga would pay it
-- to the customer's balance, so any such row refuses first, before anything is dropped.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM campaigns.reward_intents WHERE form <> 'paid' AND state NOT IN ('posted', 'failed', 'withheld')) THEN
    RAISE EXCEPTION 'campaigns: a locked reward or bonus is not settled; settle it before reversing this migration';
  END IF;
END $$;
DROP TABLE IF EXISTS campaigns.lock_progress;
DROP INDEX IF EXISTS campaigns.reward_intents_locked_idx;
ALTER TABLE campaigns.reward_intents DROP CONSTRAINT IF EXISTS reward_intents_posted_ck;
ALTER TABLE campaigns.reward_intents ADD CONSTRAINT reward_intents_posted_ck CHECK ((state = 'posted') = (ledger_tx_id IS NOT NULL));
ALTER TABLE campaigns.reward_intents DROP CONSTRAINT IF EXISTS reward_intents_settle_ck;
ALTER TABLE campaigns.reward_intents DROP CONSTRAINT IF EXISTS reward_intents_locked_ck;
ALTER TABLE campaigns.reward_intents DROP CONSTRAINT IF EXISTS reward_intents_lock_terms_ck;
ALTER TABLE campaigns.reward_intents DROP CONSTRAINT IF EXISTS reward_intents_form_ck;
ALTER TABLE campaigns.reward_intents DROP CONSTRAINT IF EXISTS reward_intents_state_ck;
ALTER TABLE campaigns.reward_intents ADD CONSTRAINT reward_intents_state_ck CHECK (state IN ('held', 'qualified', 'posting',
  'posted', 'pending_funding', 'pending_retry', 'unknown', 'withheld', 'failed', 'forfeited'));
ALTER TABLE campaigns.redemption_attempts DROP CONSTRAINT IF EXISTS redemption_attempts_outcome_ck;
ALTER TABLE campaigns.redemption_attempts ADD CONSTRAINT redemption_attempts_outcome_ck CHECK (outcome IN ('held', 'released',
  'qualified', 'posted', 'refused', 'unknown', 'withheld', 'forfeited'));
ALTER TABLE campaigns.reward_intents DROP COLUMN IF EXISTS settle;
ALTER TABLE campaigns.reward_intents DROP COLUMN IF EXISTS lock_until;
ALTER TABLE campaigns.reward_intents DROP COLUMN IF EXISTS locked_at;
ALTER TABLE campaigns.reward_intents DROP COLUMN IF EXISTS lock_tx_id;
ALTER TABLE campaigns.reward_intents DROP COLUMN IF EXISTS lock_seconds;
ALTER TABLE campaigns.reward_intents DROP COLUMN IF EXISTS form;
