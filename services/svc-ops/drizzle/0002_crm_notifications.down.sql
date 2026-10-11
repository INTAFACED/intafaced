DROP TRIGGER IF EXISTS crm_dispatch_origin_immutable ON ops.crm_outbox;
DROP FUNCTION IF EXISTS ops.crm_dispatch_origin_immutable();
DROP INDEX IF EXISTS ops.crm_outbox_dispatch;
ALTER TABLE ops.crm_outbox DROP COLUMN IF EXISTS dispatch_payload, DROP COLUMN IF EXISTS notification_receipt,
 DROP COLUMN IF EXISTS lease_token, DROP COLUMN IF EXISTS lease_until, DROP COLUMN IF EXISTS retry_at,
 DROP COLUMN IF EXISTS opportunity_id, DROP COLUMN IF EXISTS actor_user_id;
