DROP VIEW IF EXISTS campaigns.campaign_rows;
ALTER TABLE campaigns.campaigns DROP COLUMN IF EXISTS time_zone_blank;
CREATE VIEW campaigns.campaign_rows AS
SELECT c.*,
  COALESCE((SELECT sum(i.amount) FROM campaigns.reward_intents i
    WHERE i.campaign_id = c.id AND i.state NOT IN ('failed', 'forfeited', 'withheld')), 0)::text AS budget_drawn
FROM campaigns.campaigns c;
