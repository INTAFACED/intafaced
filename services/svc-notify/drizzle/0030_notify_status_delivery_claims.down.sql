DROP INDEX IF EXISTS notify.status_subscribers_state_idx;
DROP INDEX IF EXISTS notify.status_deliveries_event_idx;
ALTER TABLE notify.status_subscribers DROP COLUMN IF EXISTS source;
ALTER TABLE notify.status_deliveries DROP COLUMN IF EXISTS claimed_until;
