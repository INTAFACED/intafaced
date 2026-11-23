-- intafaced:destructive — reversal of 20261024141500_certificate_revocations.sql
ALTER TABLE "academy"."cert_issue_rule_events" DROP CONSTRAINT IF EXISTS "cert_issue_rule_events_mode_chk";
DROP TABLE IF EXISTS "academy"."cert_revocations";
