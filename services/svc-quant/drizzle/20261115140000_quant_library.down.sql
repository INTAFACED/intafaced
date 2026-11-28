-- Reverses the strategy library migration (J-algo-dev-09). Every listing, access row, clone lineage and review is lost;
-- the cloned strategies themselves stay in their owners' libraries.
DROP TABLE IF EXISTS "quant"."library_reviews";
DROP TABLE IF EXISTS "quant"."library_clones";
DROP TABLE IF EXISTS "quant"."library_access";
DROP TABLE IF EXISTS "quant"."library_listings";
DROP FUNCTION IF EXISTS "quant"."reject_library_rewrite"();
