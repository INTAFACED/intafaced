-- intafaced:destructive — reversal of 0002_catalogue_charged_asset.sql
CREATE OR REPLACE FUNCTION "agents"."usage_windows_seal_once"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."sealed_at" IS NOT NULL AND (
       NEW."sealed_at" IS DISTINCT FROM OLD."sealed_at"
    OR NEW."charged_amount" IS DISTINCT FROM OLD."charged_amount"
    OR NEW."charge_key" IS DISTINCT FROM OLD."charge_key"
  ) THEN
    RAISE EXCEPTION 'usage window % for session % is already settled and cannot be re-settled',
      OLD."window_id", OLD."session_id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

ALTER TABLE "agents"."usage_windows" DROP CONSTRAINT IF EXISTS "usage_windows_charged_asset_len_ck";
ALTER TABLE "agents"."agent_definitions" DROP CONSTRAINT IF EXISTS "agent_definitions_purpose_len_ck";
ALTER TABLE "agents"."agent_definitions" DROP CONSTRAINT IF EXISTS "agent_definitions_name_len_ck";
ALTER TABLE "agents"."usage_windows" DROP COLUMN IF EXISTS "charged_asset";
ALTER TABLE "agents"."agent_definitions" DROP COLUMN IF EXISTS "purpose";
ALTER TABLE "agents"."agent_definitions" DROP COLUMN IF EXISTS "name";
