-- svc-identity · per-surface share hits (RC-campaigns-06, J-campaigns-05 #2)
-- Reversal: the .down.sql beside this file.
--
-- One row per (token, surface, session key): a signed share tag counts one visit per browser session per surface.
-- A visit counter, not money and not attribution (attribution stays on identity.referral_edges).

CREATE TABLE IF NOT EXISTS "identity"."affiliate_share_hits" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "token"        uuid NOT NULL REFERENCES "identity"."affiliate_share_tokens" ("token") ON DELETE CASCADE,
  "surface"      text NOT NULL,
  "session_key"  text NOT NULL,
  "counted_at"   timestamptz NOT NULL DEFAULT now(),
  "created_at"   timestamptz NOT NULL DEFAULT now(),
  "updated_at"   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "affiliate_share_hits_surface_ck" CHECK ("surface" IN ('promotion', 'card', 'token', 'strategy', 'receipt')),
  CONSTRAINT "affiliate_share_hits_session_ck" CHECK ("session_key" ~ '^[A-Za-z0-9_-]{16,64}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS "affiliate_share_hits_once_uidx"
  ON "identity"."affiliate_share_hits" ("token", "surface", "session_key");
