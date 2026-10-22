-- intafaced:destructive — reversal of 0025_asset_registry.sql
--
-- Dropping the registry columns discards founder-set precision, networks and actions, and dropping asset_edits
-- discards the record of who approved them. Refuse while any edit has been applied rather than silently drop it.

DO $$
DECLARE
  n bigint;
BEGIN
  LOCK TABLE "ledger"."asset_edits" IN SHARE ROW EXCLUSIVE MODE;
  SELECT count(*) INTO n FROM "ledger"."asset_edits";
  IF n > 0 THEN
    RAISE EXCEPTION 'Cannot reverse 0025: % applied asset edit(s). Registry history must be preserved.', n;
  END IF;

  DROP TRIGGER IF EXISTS "asset_edits_append_only" ON "ledger"."asset_edits";
  DROP FUNCTION IF EXISTS "ledger"."asset_edits_append_only"();
  DROP TABLE "ledger"."asset_edits";
  ALTER TABLE "ledger"."assets"
    DROP COLUMN "registry_updated_at",
    DROP COLUMN "revision",
    DROP COLUMN "state",
    DROP COLUMN "allowed_actions",
    DROP COLUMN "default_network_id",
    DROP COLUMN "networks",
    DROP COLUMN "precision";
END $$;
