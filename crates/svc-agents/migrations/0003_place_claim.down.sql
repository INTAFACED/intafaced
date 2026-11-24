-- intafaced:destructive — reversal of 0003_place_claim.sql
ALTER TABLE "agents"."agent_place_intents" DROP CONSTRAINT IF EXISTS "agent_place_intents_claim_ck";
DELETE FROM "agents"."agent_place_intents" WHERE "action_id" IS NULL OR "result_json" IS NULL;
ALTER TABLE "agents"."agent_place_intents" ALTER COLUMN "action_id" SET NOT NULL;
ALTER TABLE "agents"."agent_place_intents" ALTER COLUMN "result_json" SET NOT NULL;
