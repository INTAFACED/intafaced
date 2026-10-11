-- Reverse 0007_support_citation_shape.sql
-- Restores the 0001 case-file check: citations is a non-empty jsonb array.

ALTER TABLE "support"."case_files" DROP CONSTRAINT IF EXISTS "case_files_grounded_ck";
ALTER TABLE "support"."case_files" ADD CONSTRAINT "case_files_grounded_ck"
  CHECK (jsonb_typeof("citations") = 'array' AND jsonb_array_length("citations") >= 1);

DROP FUNCTION IF EXISTS "support"."case_file_is_grounded"(jsonb, jsonb);
