-- intafaced:destructive relaxes NOT NULL on action_id and result_json so a claim row can exist before the place tool executes; drops no rows and no columns
-- svc-agents · place intent claimed before execute
-- Reversal: 0003_place_claim.down.sql
--
-- The audit row and the tool result do not exist until execute returns. The
-- claim commits first, unique on (session_id, idempotency_key). Null action
-- and null result mean the place has not been stored. A failed execute deletes
-- that row. A stored place does not.

ALTER TABLE "agents"."agent_place_intents" ALTER COLUMN "action_id" DROP NOT NULL;
ALTER TABLE "agents"."agent_place_intents" ALTER COLUMN "result_json" DROP NOT NULL;

ALTER TABLE "agents"."agent_place_intents" DROP CONSTRAINT IF EXISTS "agent_place_intents_claim_ck";
ALTER TABLE "agents"."agent_place_intents" ADD CONSTRAINT "agent_place_intents_claim_ck"
  CHECK (
    ("action_id" IS NULL AND "result_json" IS NULL)
    OR ("action_id" IS NOT NULL AND "result_json" IS NOT NULL)
  );
