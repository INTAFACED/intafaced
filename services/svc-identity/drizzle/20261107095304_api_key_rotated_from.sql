-- Rotate a key with an overlap (DV-keys-04, J-developer-07 #1 #2): the replacement names the key it replaces. A key is
-- replaced at most once (the partial unique index), so a rotation retried after a lost reply finds the replacement
-- already made instead of minting a second one. During the overlap the old key keeps working until its end date, which
-- the rotation moved to the overlap's end.
--
-- Reversal: 20261107095304_api_key_rotated_from.down.sql

ALTER TABLE "identity"."api_keys" ADD COLUMN IF NOT EXISTS "rotated_from" uuid;
CREATE UNIQUE INDEX IF NOT EXISTS "api_keys_rotated_from_uq" ON "identity"."api_keys" ("rotated_from") WHERE "rotated_from" IS NOT NULL;
