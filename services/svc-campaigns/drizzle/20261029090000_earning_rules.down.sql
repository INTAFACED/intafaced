-- intafaced:destructive reversal of 20261029090000_earning_rules.sql: drops the earning rules column and rebuilds the view
DROP VIEW IF EXISTS campaigns.campaign_rows;
ALTER TABLE campaigns.campaigns DROP COLUMN IF EXISTS earning;
CREATE VIEW campaigns.campaign_rows AS
SELECT c.*,
  COALESCE((SELECT sum(i.amount) FROM campaigns.reward_intents i
    WHERE i.campaign_id = c.id AND i.state NOT IN ('failed', 'forfeited', 'withheld')), 0)::text AS budget_drawn
FROM campaigns.campaigns c;
