-- intafaced:destructive — drops the API-key action audit rows and the proof binding columns. Forward migration: 0047_api_key_action_audit.sql

DROP TABLE IF EXISTS "identity"."api_key_action_audit";
ALTER TABLE "identity"."pay_step_up_proofs" DROP COLUMN IF EXISTS "consumed_at";
ALTER TABLE "identity"."pay_step_up_proofs" DROP COLUMN IF EXISTS "bound_key_id";
ALTER TABLE "identity"."pay_step_up_proofs" DROP COLUMN IF EXISTS "bound_action";
