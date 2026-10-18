-- intafaced:destructive — reversal of 0051_pay_control_pricing.sql
--
-- Drops every pricing rule and every per-payment/settlement pricing snapshot.

DROP TRIGGER IF EXISTS "control_snapshots_append_only_trg" ON "pay"."control_pricing_snapshots";
DROP TABLE IF EXISTS "pay"."control_pricing_snapshots";
DROP TRIGGER IF EXISTS "control_pricing_rules_immutable_trg" ON "pay"."control_pricing_rules";
DROP TABLE IF EXISTS "pay"."control_pricing_rules";
DROP FUNCTION IF EXISTS "pay"."control_pricing_rules_immutable"();
