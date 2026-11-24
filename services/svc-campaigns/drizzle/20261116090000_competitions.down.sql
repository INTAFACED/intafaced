-- intafaced:destructive reversal of 20261116090000_competitions.sql: drops the competition tables, column and key form
DROP TABLE IF EXISTS campaigns.competition_settlements;
DROP TABLE IF EXISTS campaigns.competition_milestones;
DROP TABLE IF EXISTS campaigns.competition_fills;
DROP TABLE IF EXISTS campaigns.competition_entries;
ALTER TABLE campaigns.reward_intents DROP CONSTRAINT IF EXISTS reward_intents_key_ck;
ALTER TABLE campaigns.reward_intents ADD CONSTRAINT reward_intents_key_ck CHECK (
  reward_key = 'task:' || campaign_id || ':' || account_id || ':' || period
  OR (period ~ '^voucher:[^:]+:[1-9][0-9]*$'
    AND reward_key = 'voucher:' || split_part(period, ':', 2) || ':' || account_id || ':' || split_part(period, ':', 3))
) NOT VALID; -- a competition prize already owed keeps its row (a money record is never deleted); new rows are checked
DROP VIEW IF EXISTS campaigns.campaign_rows;
ALTER TABLE campaigns.campaigns DROP COLUMN IF EXISTS competition;
CREATE VIEW campaigns.campaign_rows AS
SELECT c.*,
  COALESCE((SELECT sum(i.amount) FROM campaigns.reward_intents i
    WHERE i.campaign_id = c.id AND i.state NOT IN ('failed', 'forfeited', 'withheld')), 0)::text AS budget_drawn
FROM campaigns.campaigns c;
