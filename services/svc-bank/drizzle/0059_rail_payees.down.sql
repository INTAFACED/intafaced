-- intafaced:destructive drops every saved bank-rail recipient; no balance or ledger entry refers to them
DROP INDEX IF EXISTS "bank"."rail_payees_user_idx";
DROP INDEX IF EXISTS "bank"."rail_payees_live_destination_uq";
DROP TABLE IF EXISTS "bank"."rail_payees";
