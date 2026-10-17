-- intafaced:destructive — reversal of 0002_catalogue_charged_asset.sql
ALTER TABLE "agents"."usage_windows" DROP CONSTRAINT IF EXISTS "usage_windows_charged_asset_len_ck";
ALTER TABLE "agents"."agent_definitions" DROP CONSTRAINT IF EXISTS "agent_definitions_purpose_len_ck";
ALTER TABLE "agents"."agent_definitions" DROP CONSTRAINT IF EXISTS "agent_definitions_name_len_ck";
ALTER TABLE "agents"."usage_windows" DROP COLUMN IF EXISTS "charged_asset";
ALTER TABLE "agents"."agent_definitions" DROP COLUMN IF EXISTS "purpose";
ALTER TABLE "agents"."agent_definitions" DROP COLUMN IF EXISTS "name";
