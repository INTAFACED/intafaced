-- svc-agents · the owner's own freezes this service has applied (W-security-accounts-03; J-wallet-13 #1)
-- Reversal: 20261117220744_self_freeze_applied.down.sql
--
-- One row per freeze (identity's `selfFreezeApplied`, keyed by its freezeId), written in the same transaction that
-- revokes every agent permission kept for the person and stops their scheduled agent runs: a second delivery of the
-- same freeze finds the row and changes nothing. `applied` counts what that one application changed. A revoked
-- permission stays revoked after the freeze lifts; nothing here restores one. Nothing here is a balance and no value moves.

CREATE TABLE IF NOT EXISTS "agents"."self_freezes_applied" (
  "freeze_id"   uuid PRIMARY KEY,
  "user_id"     text NOT NULL,
  "since"       timestamptz NOT NULL,
  "applied"     jsonb NOT NULL,
  "applied_at"  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "self_freezes_applied_user_idx" ON "agents"."self_freezes_applied" ("user_id", "applied_at" DESC);
