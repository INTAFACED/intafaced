-- intafaced:destructive — drops bank.step_up_uses, the record of which operation spent each money-out step-up approval.
-- Approvals live five minutes and identity has already consumed them, so no open approval depends on a row here;
-- a lost row only means a retry of an already-posted operation needs a fresh approval. Forward migration: 0033_step_up_uses.sql
DROP INDEX IF EXISTS "bank"."step_up_uses_user_idx";
DROP TABLE IF EXISTS "bank"."step_up_uses";
