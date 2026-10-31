-- intafaced:destructive drops and rebuilds the campaign_rows view (a read view, no data) so it carries the new column
-- J-campaigns-16 #7, CM-eligibility-rules-03 (eligibility-rules-008): a campaign's limits, part of its definition and so
-- of each revision. `{ perCustomer: { count, periodSeconds }, totalRedemptions }`: a blank per-customer limit refuses
-- activation; every reward intent written past either limit refuses. A limit, never a balance.

ALTER TABLE campaigns.campaigns ADD COLUMN IF NOT EXISTS limits jsonb;

DROP VIEW IF EXISTS campaigns.campaign_rows;
CREATE VIEW campaigns.campaign_rows AS
SELECT c.*,
  COALESCE((SELECT sum(i.amount) FROM campaigns.reward_intents i
    WHERE i.campaign_id = c.id AND i.state NOT IN ('failed', 'forfeited', 'withheld')), 0)::text AS budget_drawn
FROM campaigns.campaigns c;

-- The per-customer count reads one account's intents in one campaign over a window.
CREATE INDEX IF NOT EXISTS reward_intents_account_idx ON campaigns.reward_intents (campaign_id, account_id, created_at);
