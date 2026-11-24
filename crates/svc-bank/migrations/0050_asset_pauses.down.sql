-- intafaced:destructive drops the per-asset pause tables; clear every pause first so no asset is left refusing
DROP TABLE IF EXISTS "bank"."asset_pause_history";
DROP TABLE IF EXISTS "bank"."asset_pauses";
