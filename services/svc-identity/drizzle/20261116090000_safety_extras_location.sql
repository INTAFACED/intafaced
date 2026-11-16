-- Step-up extras and the location signal (BK-safe-01, J-bank-18 #4). The person's own opt-in controls with an allowance
-- above which a send to another person waits (svc-bank reads them on /internal/extra-controls), and an optional location
-- consent kept as a record of each change. Only while the newest consent is on does a sign-in keep the region the edge
-- resolved for it; turning it off deletes the kept regions.
-- Reversal: 20261116090000_safety_extras_location.down.sql

CREATE TABLE IF NOT EXISTS "identity"."extra_controls" (
  "user_id" uuid PRIMARY KEY REFERENCES "identity"."users" ("id") ON DELETE CASCADE,
  "controls" text[] NOT NULL CHECK (
    cardinality("controls") >= 1
    AND "controls" <@ ARRAY['known_locations', 'trusted_contacts', 'secret_qr', 'video_fallback']::text[]
  ),
  "allowance_amount" numeric(36, 8) NOT NULL CHECK ("allowance_amount" > 0),
  "allowance_asset" text NOT NULL CHECK ("allowance_asset" IN ('USDT', 'USDC')),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "identity"."location_consent_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "identity"."users" ("id") ON DELETE CASCADE,
  "consent" boolean NOT NULL,
  "changed_at" timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS "location_consent_events_user_idx"
  ON "identity"."location_consent_events" ("user_id", "changed_at" DESC, "id" DESC);

CREATE TABLE IF NOT EXISTS "identity"."sign_in_location_signals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "identity"."users" ("id") ON DELETE CASCADE,
  "session_id" uuid NOT NULL,
  "region" text NOT NULL CHECK ("region" ~ '^[A-Z]{2}$'),
  "at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "sign_in_location_signals_user_idx"
  ON "identity"."sign_in_location_signals" ("user_id", "at" DESC);
