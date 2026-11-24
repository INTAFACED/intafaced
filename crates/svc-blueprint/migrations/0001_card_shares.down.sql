-- intafaced:destructive — reversal of 0001_card_shares.sql
-- Drops share records and opener rows. The rest of the Blueprint schema stays.

DROP TABLE IF EXISTS "blueprint"."card_opens";
DROP TABLE IF EXISTS "blueprint"."card_shares";
