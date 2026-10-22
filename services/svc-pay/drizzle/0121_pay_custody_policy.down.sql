-- intafaced:destructive — reversal of 0121_pay_custody_policy.sql
--
-- Drops the custody policy versions. No balance lives here; with the table gone the policy guard has nothing published
-- and refuses (when switched on), so this never opens a send.

DROP TRIGGER IF EXISTS "custody_policy_immutable_trg" ON "pay"."custody_policy_versions";
DROP FUNCTION IF EXISTS "pay"."custody_policy_immutable"();
DROP INDEX IF EXISTS "pay"."custody_policy_one_published_uq";
DROP INDEX IF EXISTS "pay"."custody_policy_one_draft_uq";
DROP TABLE IF EXISTS "pay"."custody_policy_versions";
