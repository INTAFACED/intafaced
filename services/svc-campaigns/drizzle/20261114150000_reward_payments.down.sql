-- Refuses while any reward was paid or a payment was sent: dropping them would lose the record of money that left our
-- wallet, and the reward would read owed again and could be paid twice.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM campaigns.reward_intents WHERE state = 'paid') THEN
    RAISE EXCEPTION 'campaigns: a reward was paid to a wallet; reversing would lose that payment';
  END IF;
  IF EXISTS (SELECT 1 FROM campaigns.reward_payments) THEN
    RAISE EXCEPTION 'campaigns: a reward payment was sent; reversing would lose it and could pay it twice';
  END IF;
  IF EXISTS (SELECT 1 FROM campaigns.redemption_attempts WHERE outcome = 'paid') THEN
    RAISE EXCEPTION 'campaigns: the redemption log names a paid reward; reversing would refuse that line';
  END IF;
END $$;
DROP TABLE IF EXISTS campaigns.reward_payments;
ALTER TABLE campaigns.reward_intents DROP CONSTRAINT IF EXISTS reward_intents_paid_ck;
ALTER TABLE campaigns.reward_intents DROP CONSTRAINT IF EXISTS reward_intents_pay_to_ck;
ALTER TABLE campaigns.reward_intents DROP CONSTRAINT IF EXISTS reward_intents_state_ck;
ALTER TABLE campaigns.reward_intents ADD CONSTRAINT reward_intents_state_ck CHECK (state IN ('held', 'qualified', 'posting',
  'owed', 'locked', 'settling', 'posted', 'pending_funding', 'pending_retry', 'unknown', 'withheld', 'failed', 'forfeited'));
ALTER TABLE campaigns.redemption_attempts DROP CONSTRAINT IF EXISTS redemption_attempts_outcome_ck;
ALTER TABLE campaigns.redemption_attempts ADD CONSTRAINT redemption_attempts_outcome_ck CHECK (outcome IN ('held', 'released',
  'qualified', 'owed', 'posted', 'locked', 'unlocked', 'refused', 'unknown', 'withheld', 'forfeited'));
ALTER TABLE campaigns.reward_intents DROP COLUMN IF EXISTS paid_chain_tx;
ALTER TABLE campaigns.reward_intents DROP COLUMN IF EXISTS paid_at;
ALTER TABLE campaigns.reward_intents DROP COLUMN IF EXISTS pay_to_wallet;
