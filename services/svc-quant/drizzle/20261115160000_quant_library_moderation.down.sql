-- Reverses the library moderation migration (J-algo-dev-10). Every moderation audit row and dispute is lost; a hidden or
-- removed listing reads as listed again.
DROP TABLE IF EXISTS "quant"."library_dispute_resolutions";
DROP TABLE IF EXISTS "quant"."library_disputes";
DROP TABLE IF EXISTS "quant"."library_moderation";
