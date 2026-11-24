-- intafaced:destructive drops and rebuilds the campaign_rows view (a read view, no data) so it carries the new column
-- J-campaigns-14, CM-vip-tiers-01: a `trial_pass` campaign's terms (the fee tier its pass grants, and for how many
-- seconds) are part of its definition. The pass itself is held by svc-trade (`trade.tier_passes`), keyed
-- `trial-pass:<campaign>:<account>`; nothing is owed or paid, so no reward intent and no balance here.
-- Reversal: the .down.sql.

ALTER TABLE campaigns.campaigns ADD COLUMN IF NOT EXISTS trial_pass jsonb;

DROP VIEW IF EXISTS campaigns.campaign_rows;
CREATE VIEW campaigns.campaign_rows AS
SELECT c.*,
  COALESCE((SELECT sum(i.amount) FROM campaigns.reward_intents i
    WHERE i.campaign_id = c.id AND i.state NOT IN ('failed', 'forfeited', 'withheld')), 0)::text AS budget_drawn
FROM campaigns.campaigns c;
