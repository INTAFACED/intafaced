-- svc-agents · place-tool idempotency (PTX-M28-R05)
-- Reversal: 0001_place_intents.down.sql
--
-- Conversational repeat must not duplicate a live order. The first successful
-- place for (session_id, idempotency_key) is the only execute; later acts with
-- the same key reuse that row. Idempotent CREATE so a re-run is a no-op.

CREATE TABLE IF NOT EXISTS "agents"."agent_place_intents" (
  "session_id"       uuid NOT NULL REFERENCES "agents"."agent_sessions" ("id"),
  "idempotency_key"  text NOT NULL,
  "tool"             text NOT NULL,
  "action_id"        uuid NOT NULL REFERENCES "agents"."agent_actions" ("id"),
  "result_json"      text NOT NULL,
  "created_at"       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("session_id", "idempotency_key")
);

ALTER TABLE "agents"."agent_place_intents" DROP CONSTRAINT IF EXISTS "agent_place_intents_key_len_ck";
ALTER TABLE "agents"."agent_place_intents" ADD CONSTRAINT "agent_place_intents_key_len_ck"
  CHECK (char_length("idempotency_key") >= 1 AND char_length("idempotency_key") <= 128);
