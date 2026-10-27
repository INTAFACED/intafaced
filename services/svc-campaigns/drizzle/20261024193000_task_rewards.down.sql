DROP VIEW IF EXISTS campaigns.campaign_rows;
DROP TABLE IF EXISTS campaigns.pot_fundings;
DROP TABLE IF EXISTS campaigns.redemption_attempts;
DROP TABLE IF EXISTS campaigns.reward_intents;
DROP TABLE IF EXISTS campaigns.task_completions;
DROP TABLE IF EXISTS campaigns.task_progress;
ALTER TABLE campaigns.campaigns DROP COLUMN IF EXISTS tasks;
