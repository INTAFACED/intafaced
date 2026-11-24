-- Genuinely reversible, unlike 0001 and 0005.
--
-- This migration adds no enum value and rewrites no row's meaning: the backfill
-- set `settlement_asset_id` to the value `asset_id` already held, which is what
-- every pre-0007 card meant anyway, so dropping the column returns those cards
-- to exactly the shape they had. Nothing read them differently in between.
--
-- Dropping `card_conversions` DOES discard records — the rate each converted
-- authorisation was quoted at. That is the correct rollback nonetheless: the
-- only rows in it are ones written by code this rollback is removing, and no
-- pre-0007 path can produce or read one. Value is unaffected either way; every
-- movement those rows describe is a transaction in the ledger, which is the book
-- that has to be right and is not touched here.
--
-- Order matters: the table references `card_authorizations`, so it goes first.
DROP TABLE IF EXISTS "bank"."card_conversions";

ALTER TABLE "bank"."cards" DROP COLUMN IF EXISTS "settlement_asset_id";
