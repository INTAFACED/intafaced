-- J-campaigns-16 #3 and #7: each campaign names the time zone its time frame is typed in. In this version that is the
-- platform time zone (owner value CAMPAIGNS_PLATFORM_TIME_ZONE); a campaign may differ from it only once windows are read
-- per campaign. The builder leaves it blank until the founder picks it, and a blank refuses activation
-- `campaigns.timezone_unset`. Rows written before this, and every caller that does not send one, read the platform zone.

ALTER TABLE campaigns.campaigns ADD COLUMN IF NOT EXISTS time_zone_blank boolean NOT NULL DEFAULT false;

-- `c.*` is expanded when the view is made, so the view is made again to carry the new column.
DROP VIEW IF EXISTS campaigns.campaign_rows;
CREATE VIEW campaigns.campaign_rows AS
SELECT c.*,
  COALESCE((SELECT sum(i.amount) FROM campaigns.reward_intents i
    WHERE i.campaign_id = c.id AND i.state NOT IN ('failed', 'forfeited', 'withheld')), 0)::text AS budget_drawn
FROM campaigns.campaigns c;
