DROP TABLE IF EXISTS notify.status_deliveries;
DROP TABLE IF EXISTS notify.status_challenges_used;
DROP TABLE IF EXISTS notify.status_subscribe_requests;
DROP TABLE IF EXISTS notify.status_subscribers;
ALTER TABLE notify.status_page DROP COLUMN IF EXISTS subscribe_rate_per_hour, DROP COLUMN IF EXISTS challenge_bits;
