-- svc-support · guest support requests (SP-tickets-01, J-support-public-03)
-- Reversal: 20261031000000_guest_requests.down.sql
--
-- NOT tagged `intafaced:destructive`: it adds two tables and drops nothing.

-- One row per guest submission. No ticket exists until the emailed link is used; `ticket_id` is then set once.
-- The address is kept twice: `address_hash` (sha256, for matching and the rate window) and `address_sealed` (AES-256-GCM,
-- for sending). Only hashes of the one-time tokens are kept, never a token or a link.
CREATE TABLE IF NOT EXISTS "support"."guest_requests" (
  "id"                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "client_key"         text NOT NULL,
  "fingerprint"        text NOT NULL,
  "address_hash"       text NOT NULL,
  "address_sealed"     text,
  "category"           text NOT NULL,
  "subject"            text NOT NULL,
  "body"               text NOT NULL,
  "status"             text NOT NULL,
  "send_ordinal"       integer NOT NULL DEFAULT 0,
  "delivery_code"      text,
  "token_id"           text,
  "token_hash"         text,
  "token_expires_at"   timestamptz,
  "ticket_id"          uuid,
  "access_id"          text,
  "access_hash"        text,
  "access_expires_at"  timestamptz,
  "erase_after"        timestamptz NOT NULL,
  "erased_at"          timestamptz,
  "created_at"         timestamptz NOT NULL DEFAULT now(),
  "updated_at"         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "guest_requests_client_key_uq" UNIQUE ("client_key"),
  CONSTRAINT "guest_requests_token_id_uq" UNIQUE ("token_id"),
  CONSTRAINT "guest_requests_access_id_uq" UNIQUE ("access_id"),
  CONSTRAINT "guest_requests_status_ck" CHECK ("status" IN ('pending_delivery', 'sent', 'delivery_unknown', 'verified')),
  CONSTRAINT "guest_requests_verified_ck" CHECK (("status" = 'verified') = ("ticket_id" IS NOT NULL)),
  CONSTRAINT "guest_requests_erased_ck" CHECK ("erased_at" IS NULL OR "address_sealed" IS NULL)
);
CREATE INDEX IF NOT EXISTS "guest_requests_erase_after_idx" ON "support"."guest_requests" ("erase_after") WHERE "erased_at" IS NULL;

-- Sends per address per window. A refused send stores no request row.
CREATE TABLE IF NOT EXISTS "support"."guest_rate_windows" (
  "address_hash"  text NOT NULL,
  "window_start"  bigint NOT NULL,
  "attempts"      integer NOT NULL,
  PRIMARY KEY ("address_hash", "window_start")
);
