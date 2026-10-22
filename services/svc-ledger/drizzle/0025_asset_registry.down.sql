-- intafaced:destructive — reversal of 0025_asset_registry.sql
--
-- Dropping the registry columns discards founder-set precision, networks and actions, and who approved
-- them. Refuse while any asset carries an applied edit rather than silently drop it.

DO $$
DECLARE
  n bigint;
BEGIN
  LOCK TABLE "ledger"."assets" IN SHARE ROW EXCLUSIVE MODE;
  SELECT count(*) INTO n FROM "ledger"."assets" WHERE "revision" > 0;
  IF n > 0 THEN
    RAISE EXCEPTION 'Cannot reverse 0025: % asset(s) carry a founder edit. Registry values must be preserved.', n;
  END IF;

  ALTER TABLE "ledger"."assets"
    DROP CONSTRAINT "assets_registry_edit_named",
    DROP COLUMN "last_approved_by",
    DROP COLUMN "last_edited_by",
    DROP COLUMN "last_operation_id",
    DROP COLUMN "last_approval_id",
    DROP COLUMN "registry_updated_at",
    DROP COLUMN "revision",
    DROP COLUMN "state",
    DROP COLUMN "allowed_actions",
    DROP COLUMN "default_network_id",
    DROP COLUMN "networks",
    DROP COLUMN "precision";
END $$;
