-- svc-agents · customer catalogue fields and the asset a sealed window was posted in
-- Reversal: 0002_catalogue_charged_asset.down.sql
--
-- `purpose` and `name` are stored columns. Absent means null — nothing here
-- composes a sentence from the guardrail. `charged_asset` is the asset
-- settlement posted, written once with `charged_amount`, so a later read sums
-- recorded amounts per asset and does not reprice the window.

ALTER TABLE "agents"."agent_definitions" ADD COLUMN IF NOT EXISTS "name" text;
ALTER TABLE "agents"."agent_definitions" ADD COLUMN IF NOT EXISTS "purpose" text;

ALTER TABLE "agents"."usage_windows" ADD COLUMN IF NOT EXISTS "charged_asset" text;

ALTER TABLE "agents"."agent_definitions" DROP CONSTRAINT IF EXISTS "agent_definitions_name_len_ck";
ALTER TABLE "agents"."agent_definitions" ADD CONSTRAINT "agent_definitions_name_len_ck"
  CHECK ("name" IS NULL OR (char_length("name") >= 1 AND char_length("name") <= 120));

ALTER TABLE "agents"."agent_definitions" DROP CONSTRAINT IF EXISTS "agent_definitions_purpose_len_ck";
ALTER TABLE "agents"."agent_definitions" ADD CONSTRAINT "agent_definitions_purpose_len_ck"
  CHECK ("purpose" IS NULL OR (char_length("purpose") >= 1 AND char_length("purpose") <= 400));

ALTER TABLE "agents"."usage_windows" DROP CONSTRAINT IF EXISTS "usage_windows_charged_asset_len_ck";
ALTER TABLE "agents"."usage_windows" ADD CONSTRAINT "usage_windows_charged_asset_len_ck"
  CHECK ("charged_asset" IS NULL OR (char_length("charged_asset") >= 1 AND char_length("charged_asset") <= 32));

-- The asset is part of the posted charge. Seal-once already freezes the amount
-- and the key; freezing the asset stops a later update from relabelling spend.
CREATE OR REPLACE FUNCTION "agents"."usage_windows_seal_once"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."sealed_at" IS NOT NULL AND (
       NEW."sealed_at" IS DISTINCT FROM OLD."sealed_at"
    OR NEW."charged_amount" IS DISTINCT FROM OLD."charged_amount"
    OR NEW."charged_asset" IS DISTINCT FROM OLD."charged_asset"
    OR NEW."charge_key" IS DISTINCT FROM OLD."charge_key"
  ) THEN
    RAISE EXCEPTION 'usage window % for session % is already settled and cannot be re-settled',
      OLD."window_id", OLD."session_id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
