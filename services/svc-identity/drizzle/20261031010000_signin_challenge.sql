-- I-signin-sessions-30: the self-hosted sign-in challenge. Failed password sign-ins counted per address (a keyed hash,
-- never the address), and each challenge token spent once until it expires.
CREATE TABLE IF NOT EXISTS "identity"."signin_address_failures" (
  "address_hash"      text PRIMARY KEY,
  "window_started_at" timestamptz NOT NULL,
  "failures"          integer NOT NULL CHECK ("failures" > 0)
);

CREATE TABLE IF NOT EXISTS "identity"."signin_challenges_used" (
  "token_hash" text PRIMARY KEY,
  "used_at"    timestamptz NOT NULL,
  "expires_at" timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS "signin_challenges_used_expires_idx" ON "identity"."signin_challenges_used" ("expires_at");
