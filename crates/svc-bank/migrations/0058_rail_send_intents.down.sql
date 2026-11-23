-- intafaced:destructive drops every rail send intent record; none held or posted money, so no balance or ledger entry is touched
DROP INDEX IF EXISTS "bank"."rail_send_intents_user_idx";
DROP TABLE IF EXISTS "bank"."rail_send_intents";
