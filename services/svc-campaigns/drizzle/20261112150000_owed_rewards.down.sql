-- Refuses while any reward was owed: dropping the Owe transaction would leave a reward the ledger owes with no record of
-- it here, and the old saga would pay it to the customer's balance.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM campaigns.reward_intents WHERE owe_tx_id IS NOT NULL) THEN
    RAISE EXCEPTION 'campaigns: a reward is owed; it must be paid or reversed before reversing this migration';
  END IF;
  IF EXISTS (SELECT 1 FROM campaigns.redemption_attempts WHERE outcome = 'owed') THEN
    RAISE EXCEPTION 'campaigns: the redemption log names an owed reward; reversing would refuse that line';
  END IF;
  IF EXISTS (SELECT 1 FROM campaigns.pot_fundings WHERE source_module = 'builder') THEN
    RAISE EXCEPTION 'campaigns: a pot funding came from builder fees; reversing would refuse that row';
  END IF;
END $$;
ALTER TABLE campaigns.pot_fundings DROP CONSTRAINT IF EXISTS pot_fundings_module_ck;
ALTER TABLE campaigns.pot_fundings ADD CONSTRAINT pot_fundings_module_ck CHECK (source_module IN ('trade'));
ALTER TABLE campaigns.reward_intents DROP CONSTRAINT IF EXISTS reward_intents_owed_ck;
ALTER TABLE campaigns.reward_intents DROP CONSTRAINT IF EXISTS reward_intents_state_ck;
ALTER TABLE campaigns.reward_intents ADD CONSTRAINT reward_intents_state_ck CHECK (state IN ('held', 'qualified', 'posting',
  'locked', 'settling', 'posted', 'pending_funding', 'pending_retry', 'unknown', 'withheld', 'failed', 'forfeited'));
ALTER TABLE campaigns.redemption_attempts DROP CONSTRAINT IF EXISTS redemption_attempts_outcome_ck;
ALTER TABLE campaigns.redemption_attempts ADD CONSTRAINT redemption_attempts_outcome_ck CHECK (outcome IN ('held', 'released',
  'qualified', 'posted', 'locked', 'unlocked', 'refused', 'unknown', 'withheld', 'forfeited'));
ALTER TABLE campaigns.reward_intents DROP COLUMN IF EXISTS owed_at;
ALTER TABLE campaigns.reward_intents DROP COLUMN IF EXISTS owe_tx_id;
