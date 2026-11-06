-- svc-identity · a customer's own idle sign-out, shorter than the owner's (I-signin-sessions-06, J-identity-06 #4).
-- One row per account; no row means the owner's limit applies. Reversal: the matching .down.sql
CREATE TABLE IF NOT EXISTS "identity"."session_settings" (
  "user_id" uuid PRIMARY KEY REFERENCES "identity"."users"("id") ON DELETE CASCADE,
  "idle_seconds" integer NOT NULL CHECK ("idle_seconds" >= 60),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
