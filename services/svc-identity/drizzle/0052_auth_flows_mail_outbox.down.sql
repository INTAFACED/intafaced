-- intafaced:destructive — reversal of 0052_auth_flows_mail_outbox.sql; drops open recovery flows and unsent mail jobs.
DROP TABLE IF EXISTS "identity"."mail_outbox";
DROP TABLE IF EXISTS "identity"."auth_flows";
