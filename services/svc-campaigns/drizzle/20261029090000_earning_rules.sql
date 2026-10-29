-- intafaced:destructive drops and rebuilds the campaign_rows view (a read view, no data) so it carries the new column
-- J-campaigns-16 #6, CM-rewards-hub-05: a campaign's earning rules (trigger, condition, incentive formula), part of its
-- definition and so of each revision. Nothing reads them to give a reward yet; that is the next slice.

ALTER TABLE campaigns.campaigns ADD COLUMN IF NOT EXISTS earning jsonb NOT NULL DEFAULT '[]'::jsonb;

DROP VIEW IF EXISTS campaigns.campaign_rows;
CREATE VIEW campaigns.campaign_rows AS
SELECT c.*,
  COALESCE((SELECT sum(i.amount) FROM campaigns.reward_intents i
    WHERE i.campaign_id = c.id AND i.state NOT IN ('failed', 'forfeited', 'withheld')), 0)::text AS budget_drawn
FROM campaigns.campaigns c;
