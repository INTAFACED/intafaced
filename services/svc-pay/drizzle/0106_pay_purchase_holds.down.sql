-- intafaced:destructive — reversal of 0106_pay_purchase_holds.sql
--
-- Drops the recorded purchase holds, their releases and the period history. No balance lives in these tables (the
-- ledger is the balance); this is for CI proof of reversibility and a database that recorded no real hold.

DROP TRIGGER IF EXISTS "purchase_hold_policy_events_append_only_trg" ON "pay"."purchase_hold_policy_events";
DROP TRIGGER IF EXISTS "purchase_hold_releases_append_only_trg" ON "pay"."purchase_hold_releases";
DROP TRIGGER IF EXISTS "purchase_holds_append_only_trg" ON "pay"."purchase_holds";
DROP FUNCTION IF EXISTS "pay"."purchase_holds_append_only"();
DROP TABLE IF EXISTS "pay"."purchase_hold_policy_events";
DROP TABLE IF EXISTS "pay"."purchase_hold_releases";
DROP INDEX IF EXISTS "pay"."purchase_holds_user_asset_idx";
DROP INDEX IF EXISTS "pay"."purchase_holds_ref_uq";
DROP TABLE IF EXISTS "pay"."purchase_holds";
