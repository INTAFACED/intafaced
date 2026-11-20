-- intafaced:destructive reversal of 20261117090000_risk_review.sql: drops the risk review tables
-- Refuses while a reward is held for review, being reclaimed or cancelled: the older states have no word for them.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM campaigns.reward_intents WHERE state IN ('review', 'reclaiming', 'cancelled')) THEN
    RAISE EXCEPTION 'campaigns: a reward is held for review, being reclaimed or cancelled; reversing would lose that';
  END IF;
  IF EXISTS (SELECT 1 FROM campaigns.redemption_attempts WHERE outcome = 'cancelled') THEN
    RAISE EXCEPTION 'campaigns: the redemption log names a cancelled reward; reversing would refuse that line';
  END IF;
END $$;
DROP TABLE IF EXISTS campaigns.risk_reclaims;
DROP TABLE IF EXISTS campaigns.risk_actions;
DROP TABLE IF EXISTS campaigns.risk_appeals;
DROP TABLE IF EXISTS campaigns.risk_cases;
DROP TABLE IF EXISTS campaigns.risk_signals;
ALTER TABLE campaigns.reward_intents DROP CONSTRAINT IF EXISTS reward_intents_reclaim_ck;
ALTER TABLE campaigns.reward_intents DROP CONSTRAINT IF EXISTS reward_intents_state_ck;
ALTER TABLE campaigns.reward_intents ADD CONSTRAINT reward_intents_state_ck CHECK (state IN ('held', 'qualified', 'posting',
  'owed', 'paid', 'locked', 'settling', 'posted', 'pending_funding', 'pending_retry', 'unknown', 'withheld', 'failed', 'forfeited'));
ALTER TABLE campaigns.redemption_attempts DROP CONSTRAINT IF EXISTS redemption_attempts_outcome_ck;
ALTER TABLE campaigns.redemption_attempts ADD CONSTRAINT redemption_attempts_outcome_ck CHECK (outcome IN ('held', 'released',
  'qualified', 'owed', 'paid', 'posted', 'locked', 'unlocked', 'refused', 'unknown', 'withheld', 'forfeited'));
DROP VIEW IF EXISTS campaigns.campaign_rows;
CREATE VIEW campaigns.campaign_rows AS
SELECT c.*,
  COALESCE((SELECT sum(i.amount) FROM campaigns.reward_intents i
    WHERE i.campaign_id = c.id AND i.state NOT IN ('failed', 'forfeited', 'withheld')), 0)::text AS budget_drawn
FROM campaigns.campaigns c;
