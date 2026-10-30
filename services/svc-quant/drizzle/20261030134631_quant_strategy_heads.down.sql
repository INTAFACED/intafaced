-- Reverses the strategy heads migration (AL-editor-01). A rename, folder or description is lost; versions are untouched.
-- Receipts of organise and restore writes go with the head fields they answered.
DELETE FROM "quant"."write_receipts" WHERE "operation" IN ('organise', 'restore');
ALTER TABLE "quant"."write_receipts" DROP CONSTRAINT IF EXISTS "write_receipts_operation_ck";
ALTER TABLE "quant"."write_receipts" ADD CONSTRAINT "write_receipts_operation_ck"
  CHECK ("operation" IN ('create', 'revise', 'delete', 'backtest'));
ALTER TABLE "quant"."strategies" DROP CONSTRAINT IF EXISTS "strategies_head_ck";
ALTER TABLE "quant"."strategies" DROP COLUMN IF EXISTS "restores";
ALTER TABLE "quant"."strategies" DROP COLUMN IF EXISTS "organised";
ALTER TABLE "quant"."strategies" DROP COLUMN IF EXISTS "description";
ALTER TABLE "quant"."strategies" DROP COLUMN IF EXISTS "folder";
ALTER TABLE "quant"."strategies" DROP COLUMN IF EXISTS "name";
