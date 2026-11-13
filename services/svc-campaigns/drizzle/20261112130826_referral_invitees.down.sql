-- intafaced:destructive reversal of 20261112130826_referral_invitees.sql: drops the invitee tables and the referral column
DROP TABLE IF EXISTS campaigns.referral_events;
DROP TABLE IF EXISTS campaigns.referral_invitees;
DROP VIEW IF EXISTS campaigns.campaign_rows;
ALTER TABLE campaigns.campaigns DROP COLUMN IF EXISTS referral;
CREATE VIEW campaigns.campaign_rows AS
SELECT c.*,
  COALESCE((SELECT sum(i.amount) FROM campaigns.reward_intents i
    WHERE i.campaign_id = c.id AND i.state NOT IN ('failed', 'forfeited', 'withheld')), 0)::text AS budget_drawn
FROM campaigns.campaigns c;
