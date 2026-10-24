DROP TRIGGER IF EXISTS alert_notify_audit_append_only ON ops.alert_notify_audit;
DROP FUNCTION IF EXISTS ops.alert_notify_audit_append_only();
DROP TABLE IF EXISTS ops.alert_notify_audit;
DROP TRIGGER IF EXISTS alert_channel_attempts_append_only ON ops.alert_channel_attempts;
DROP FUNCTION IF EXISTS ops.alert_channel_attempts_append_only();
DROP TABLE IF EXISTS ops.alert_channel_attempts;
DROP TRIGGER IF EXISTS alert_send_claims_append_only ON ops.alert_send_claims;
DROP FUNCTION IF EXISTS ops.alert_send_claims_append_only();
DROP TABLE IF EXISTS ops.alert_send_claims;
DROP TABLE IF EXISTS ops.alert_notifications;
DROP TRIGGER IF EXISTS alert_silences_append_only ON ops.alert_silences;
DROP FUNCTION IF EXISTS ops.alert_silences_append_only();
DROP TABLE IF EXISTS ops.alert_silences;
DROP TRIGGER IF EXISTS alert_contact_versions_append_only ON ops.alert_contact_versions;
DROP FUNCTION IF EXISTS ops.alert_contact_versions_append_only();
DROP TABLE IF EXISTS ops.alert_contact_versions;
DROP TABLE IF EXISTS ops.alert_contacts;
DROP TRIGGER IF EXISTS alert_route_versions_append_only ON ops.alert_route_versions;
DROP FUNCTION IF EXISTS ops.alert_route_versions_append_only();
DROP TABLE IF EXISTS ops.alert_route_versions;
DROP TABLE IF EXISTS ops.alert_route_policy;
-- The policy events belong to the routing tree dropped above; the old check cannot hold them.
DELETE FROM ops.alert_outbox WHERE event = 'coreOpsAlertPolicyUpdated';
ALTER TABLE ops.alert_outbox DROP CONSTRAINT IF EXISTS alert_outbox_event_check;
ALTER TABLE ops.alert_outbox ADD CONSTRAINT alert_outbox_event_check
  CHECK (event IN ('coreOpsAlertRuleUpdated','coreOpsAlertOpened','coreOpsAlertResolved'));
