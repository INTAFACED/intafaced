-- intafaced:destructive reversal of 20261031010000_campaign_limits.sql: drops the limits column and rebuilds the view
DROP INDEX IF EXISTS campaigns.reward_intents_account_idx;
DROP VIEW IF EXISTS campaigns.campaign_rows;
ALTER TABLE campaigns.campaigns DROP COLUMN IF EXISTS limits;
CREATE VIEW campaigns.campaign_rows AS
SELECT c.*,
  COALESCE((SELECT sum(i.amount) FROM campaigns.reward_intents i
    WHERE i.campaign_id = c.id AND i.state NOT IN ('failed', 'forfeited', 'withheld')), 0)::text AS budget_drawn
FROM campaigns.campaigns c;
