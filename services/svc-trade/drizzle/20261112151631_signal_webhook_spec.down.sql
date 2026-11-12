DELETE FROM trade.signal_alert_results WHERE webhook_id IN (SELECT id FROM trade.signal_webhooks WHERE kind = 'notify');
DELETE FROM trade.signal_webhooks WHERE kind = 'notify';
ALTER TABLE trade.signal_webhooks DROP CONSTRAINT IF EXISTS signal_webhooks_ended_ck;
ALTER TABLE trade.signal_webhooks DROP CONSTRAINT IF EXISTS signal_webhooks_kind_fields_ck;
ALTER TABLE trade.signal_webhooks ALTER COLUMN symbol SET NOT NULL;
ALTER TABLE trade.signal_webhooks ALTER COLUMN venue_owner SET NOT NULL;
ALTER TABLE trade.signal_webhooks ALTER COLUMN place_grant SET NOT NULL;
ALTER TABLE trade.signal_webhooks ALTER COLUMN grant_expires_at SET NOT NULL;
ALTER TABLE trade.signal_webhooks DROP CONSTRAINT IF EXISTS signal_webhooks_failures_ck;
ALTER TABLE trade.signal_webhooks DROP CONSTRAINT IF EXISTS signal_webhooks_kind_ck;
ALTER TABLE trade.signal_webhooks
  DROP COLUMN IF EXISTS ended_at,
  DROP COLUMN IF EXISTS ended_reason,
  DROP COLUMN IF EXISTS consecutive_failures,
  DROP COLUMN IF EXISTS kind;
