-- svc-identity · per-account sign-in attempt lockouts. Reversal: 0027_auth_attempt_lockouts.down.sql.
--
-- Shared across replicas and restarts (Postgres, not process memory). Prevents
-- online guessing of a password / 6-digit TOTP / recovery code by an attacker
-- who spreads attempts over many IPs, which the per-IP edge limiter cannot see.
-- One row per (user, kind); at most two rows per user. Policy lives in
-- src/auth/attempt-lockout.ts. No secret, code or IP is stored here.
CREATE TABLE "identity"."auth_attempts" (
  user_id uuid NOT NULL REFERENCES "identity"."users"(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('password', 'mfa')),
  failures integer NOT NULL DEFAULT 0 CHECK (failures >= 0),
  -- Failed-or-pending attempts since the last success. Window resets never touch it; only a success does.
  consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  window_started_at timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, kind)
);
