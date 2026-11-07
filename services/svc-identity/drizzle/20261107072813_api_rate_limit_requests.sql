-- API rate limits for keys (DV-limits-01 to 03, J-developer-06 #5 #6): a person asks for a higher limit on one of their
-- live keys, with an optional spike window, and a support reviewer grants all of it, part of it, or refuses.
--
-- api_keys.rate_refill_per_minute_granted is a key's own refill once a reviewer granted it (null: the key is on its
-- tier). The tiers themselves and the grant ceiling are owner values (IDENTITY_API_RATE_LIMITS), never stored here.
-- api_limit_requests keeps one row per request; one waiting request per key at a time (the partial unique index).
-- api_limit_audit keeps exactly one row per decision, written in the decision's own transaction.
--
-- Reversal: 20261107072813_api_rate_limit_requests.down.sql

ALTER TABLE "identity"."api_keys" ADD COLUMN IF NOT EXISTS "rate_refill_per_minute_granted" integer;
ALTER TABLE "identity"."api_keys" DROP CONSTRAINT IF EXISTS "api_keys_rate_refill_granted_ck";
ALTER TABLE "identity"."api_keys"
  ADD CONSTRAINT "api_keys_rate_refill_granted_ck" CHECK ("rate_refill_per_minute_granted" IS NULL OR "rate_refill_per_minute_granted" > 0);

CREATE TABLE IF NOT EXISTS "identity"."api_limit_requests" (
  "id"                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"             uuid NOT NULL REFERENCES "identity"."users"("id") ON DELETE CASCADE,
  "key_id"              uuid NOT NULL REFERENCES "identity"."api_keys"("id") ON DELETE CASCADE,
  "request_id"          text NOT NULL,
  "asked_per_minute"    integer NOT NULL,
  "current_per_minute"  integer NOT NULL,
  "spike_starts_on"     date,
  "spike_ends_on"       date,
  "note"                text NOT NULL DEFAULT '',
  "status"              text NOT NULL DEFAULT 'waiting',
  "granted_per_minute"  integer,
  "reviewer_id"         uuid,
  "review_reason"       text,
  "reviewed_at"         timestamptz,
  "created_at"          timestamptz NOT NULL DEFAULT now(),
  "updated_at"          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "api_limit_requests_status_ck" CHECK ("status" IN ('waiting', 'granted', 'granted_in_part', 'refused')),
  CONSTRAINT "api_limit_requests_asked_ck" CHECK ("asked_per_minute" > "current_per_minute" AND "current_per_minute" > 0),
  CONSTRAINT "api_limit_requests_spike_ck" CHECK (
    ("spike_starts_on" IS NULL AND "spike_ends_on" IS NULL)
    OR ("spike_starts_on" IS NOT NULL AND "spike_ends_on" IS NOT NULL AND "spike_starts_on" <= "spike_ends_on")
  ),
  CONSTRAINT "api_limit_requests_note_ck" CHECK (char_length("note") <= 500),
  CONSTRAINT "api_limit_requests_granted_ck" CHECK (
    ("status" IN ('granted', 'granted_in_part') AND "granted_per_minute" IS NOT NULL AND "granted_per_minute" <= "asked_per_minute")
    OR ("status" IN ('waiting', 'refused') AND "granted_per_minute" IS NULL)
  ),
  CONSTRAINT "api_limit_requests_review_ck" CHECK (("status" = 'waiting') = ("reviewed_at" IS NULL))
);

-- A repeat of one submission returns the same row; a key has at most one waiting request.
CREATE UNIQUE INDEX IF NOT EXISTS "api_limit_requests_request_uq" ON "identity"."api_limit_requests" ("user_id", "request_id");
CREATE UNIQUE INDEX IF NOT EXISTS "api_limit_requests_waiting_uq" ON "identity"."api_limit_requests" ("key_id") WHERE "status" = 'waiting';
CREATE INDEX IF NOT EXISTS "api_limit_requests_user_idx" ON "identity"."api_limit_requests" ("user_id", "created_at" DESC);

CREATE TABLE IF NOT EXISTS "identity"."api_limit_audit" (
  "id"                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "request_id"           uuid NOT NULL UNIQUE REFERENCES "identity"."api_limit_requests"("id") ON DELETE CASCADE,
  "key_id"               uuid NOT NULL,
  "actor_id"             uuid NOT NULL,
  "decision"             text NOT NULL,
  "asked_per_minute"     integer NOT NULL,
  "previous_per_minute"  integer NOT NULL,
  "granted_per_minute"   integer,
  "reason"               text NOT NULL,
  "created_at"           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "api_limit_audit_decision_ck" CHECK ("decision" IN ('granted', 'granted_in_part', 'refused')),
  CONSTRAINT "api_limit_audit_granted_ck" CHECK (("decision" = 'refused') = ("granted_per_minute" IS NULL))
);
CREATE INDEX IF NOT EXISTS "api_limit_audit_created_idx" ON "identity"."api_limit_audit" ("created_at" DESC);
