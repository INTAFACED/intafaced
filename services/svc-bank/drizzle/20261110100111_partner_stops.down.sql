-- intafaced:destructive drops the partner stop tables; lift every partner stop first so no partner is left refusing
DROP TABLE IF EXISTS "bank"."partner_stop_history";
DROP TABLE IF EXISTS "bank"."partner_stops";
