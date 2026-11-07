-- A key asks for its own rotation (DV-keys-04, J-developer-07 #3): the request waits for a different person (the
-- account's owner, signed in on a device) to approve it; the requesting key can never approve it. One waiting request
-- per key; approving it rotates the key once and records the replacement.
--
-- Reversal: 20261107095910_api_key_rotation_requests.down.sql

CREATE TABLE IF NOT EXISTS "identity"."api_key_rotation_requests" (
  "id"                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"             uuid NOT NULL REFERENCES "identity"."users"("id") ON DELETE CASCADE,
  "key_id"              uuid NOT NULL REFERENCES "identity"."api_keys"("id") ON DELETE CASCADE,
  "overlap_seconds"     integer NOT NULL DEFAULT 0,
  "status"              text NOT NULL DEFAULT 'waiting',
  "replacement_key_id"  uuid,
  "approved_by"         uuid,
  "created_at"          timestamptz NOT NULL DEFAULT now(),
  "decided_at"          timestamptz,
  CONSTRAINT "api_key_rotation_requests_status_ck" CHECK ("status" IN ('waiting', 'approved')),
  CONSTRAINT "api_key_rotation_requests_overlap_ck" CHECK ("overlap_seconds" >= 0),
  CONSTRAINT "api_key_rotation_requests_decided_ck" CHECK (
    ("status" = 'waiting' AND "decided_at" IS NULL AND "replacement_key_id" IS NULL)
    OR ("status" = 'approved' AND "decided_at" IS NOT NULL AND "replacement_key_id" IS NOT NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS "api_key_rotation_requests_waiting_uq" ON "identity"."api_key_rotation_requests" ("key_id") WHERE "status" = 'waiting';
