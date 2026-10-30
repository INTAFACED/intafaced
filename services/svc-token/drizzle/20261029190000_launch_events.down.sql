-- intafaced:destructive — drops the launch tables added for J-more-catalogue-11. No balance is rewritten:
-- a launch snapshot is a measurement of stake, and the stakes themselves stay.

DROP TABLE IF EXISTS "token"."launch_snapshots";
DROP TABLE IF EXISTS "token"."launch_event_moves";
DROP TABLE IF EXISTS "token"."launch_events";
DROP TABLE IF EXISTS "token"."launch_issuer_moves";
DROP TABLE IF EXISTS "token"."launch_issuers";
