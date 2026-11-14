-- Reverses 20261114074000_api_key_rotated_from.sql.
DROP INDEX IF EXISTS "identity"."api_keys_rotated_from_uq";
ALTER TABLE "identity"."api_keys" DROP COLUMN IF EXISTS "rotated_from";
