-- svc-identity · session auth_time, session family, and the refresh grace window. Reversal: 0030_session_auth_time_refresh_grace.down.sql.
--
-- auth_time: when the password (and the second factor, if any) were last actually
-- verified. A refresh carries it forward unchanged; it is the clock the MFA max age
-- runs against, so a 30-day sliding session can no longer keep an `mfa` claim alive.
-- Sessions that already passed a second factor are backfilled to the epoch: their real
-- sign-in time is not recorded, so they lose `mfa` at their next refresh and the person
-- signs in again. Password-only sessions never carry `mfa`; they take their created_at.
--
-- family_id: one value for a whole refresh chain (each rotation is a new row). The
-- grace window only ever answers inside one family.
--
-- session_refresh_grace: the answer to a refresh whose response was lost. One row per
-- rotation, keyed by the SHA-256 of the retired refresh token. `sealed` is the
-- successor token pair encrypted under a key derived from the retired token itself plus
-- the service signing secret, so a database read yields nothing usable. A row is
-- spent once (consumed_at) and useless after the configured window.
ALTER TABLE "identity"."sessions"
  ADD COLUMN "auth_time" timestamptz,
  ADD COLUMN "family_id" uuid NOT NULL DEFAULT gen_random_uuid();
UPDATE "identity"."sessions" SET "auth_time" = CASE WHEN "mfa" THEN to_timestamp(0) ELSE "created_at" END;
ALTER TABLE "identity"."sessions"
  ALTER COLUMN "auth_time" SET NOT NULL,
  ALTER COLUMN "auth_time" SET DEFAULT now();
CREATE INDEX "sessions_family_idx" ON "identity"."sessions" ("family_id");

CREATE TABLE "identity"."session_refresh_grace" (
  retired_hash text PRIMARY KEY CHECK (retired_hash ~ '^[0-9a-f]{64}$'),
  user_id uuid NOT NULL REFERENCES "identity"."users"(id) ON DELETE CASCADE,
  family_id uuid NOT NULL,
  retired_session_id uuid NOT NULL,
  successor_session_id uuid NOT NULL,
  sealed text NOT NULL,
  rotated_at timestamptz NOT NULL DEFAULT now(),
  consumed_at timestamptz
);
CREATE INDEX "session_refresh_grace_rotated_idx" ON "identity"."session_refresh_grace" ("rotated_at");
