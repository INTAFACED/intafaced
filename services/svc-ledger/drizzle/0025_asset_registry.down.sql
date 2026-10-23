-- intafaced:destructive — reversal of 0025_asset_registry.sql
--
-- Dropping the registry columns discards every published precision, network and
-- allowed action, and `asset_edits` is the record of who changed them. Refuse
-- while any edit has been applied rather than silently drop that history.

DO $$
DECLARE
  n bigint;
BEGIN
  LOCK TABLE "ledger"."asset_edits" IN SHARE ROW EXCLUSIVE MODE;

  SELECT count(*) INTO n FROM "ledger"."asset_edits";

  IF n > 0 THEN
    RAISE EXCEPTION 'Cannot reverse 0025: % applied asset edit(s). The registry history must be preserved.', n;
  END IF;

  DROP TRIGGER IF EXISTS "asset_edits_no_truncate" ON "ledger"."asset_edits";
  DROP TRIGGER IF EXISTS "asset_edits_append_only" ON "ledger"."asset_edits";
  DROP FUNCTION IF EXISTS "ledger"."asset_edits_append_only"();
  DROP TABLE "ledger"."asset_edits";

  ALTER TABLE "ledger"."assets"
    DROP CONSTRAINT IF EXISTS "assets_precision_ck",
    DROP CONSTRAINT IF EXISTS "assets_networks_array_ck",
    DROP CONSTRAINT IF EXISTS "assets_state_ck",
    DROP CONSTRAINT IF EXISTS "assets_allowed_actions_ck",
    DROP CONSTRAINT IF EXISTS "assets_revision_ck",
    DROP COLUMN IF EXISTS "precision",
    DROP COLUMN IF EXISTS "networks",
    DROP COLUMN IF EXISTS "default_network_id",
    DROP COLUMN IF EXISTS "allowed_actions",
    DROP COLUMN IF EXISTS "state",
    DROP COLUMN IF EXISTS "revision",
    DROP COLUMN IF EXISTS "updated_at";
END $$;
