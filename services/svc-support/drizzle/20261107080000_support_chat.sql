-- svc-support · live chat (SP-chat-01, J-support-public-05)
-- Reversal: 20261107080000_support_chat.down.sql
--
-- NOT tagged `intafaced:destructive`: it adds five tables and drops nothing.

-- One row per chat. `user_id` is the signed identity it belongs to, NULL for a guest. Every chat has an access token
-- (only its hash is kept): a guest, or a page embedding the chat with no session of ours, comes back with it. `client_key` (the sha256 of the page's key) makes a lost open answer recoverable: the same key opens the same
-- chat, and `fingerprint` refuses the same key with different content. A closed chat
-- holds the request it became (`ticket_id`) and takes no more messages.
CREATE TABLE IF NOT EXISTS "support"."chat_sessions" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "client_key"     text NOT NULL,
  "fingerprint"    text NOT NULL,
  "user_id"        text,
  "access_hash"    text NOT NULL,
  "claim"          text NOT NULL,
  "claim_refusal"  text,
  "status"         text NOT NULL,
  "agent_id"       text,
  "accepted_at"    timestamptz,
  "profile_type"   text,
  "profile_read"   text NOT NULL,
  "ticket_id"      uuid,
  "last_seq"       integer NOT NULL DEFAULT 0,
  "created_at"     timestamptz NOT NULL DEFAULT now(),
  "updated_at"     timestamptz NOT NULL DEFAULT now(),
  "closed_at"      timestamptz,
  "closed_by"      text,
  CONSTRAINT "chat_sessions_client_key_uq" UNIQUE ("client_key"),
  CONSTRAINT "chat_sessions_status_ck" CHECK ("status" IN ('waiting', 'active', 'closed')),
  CONSTRAINT "chat_sessions_claim_ck" CHECK ("claim" IN ('none', 'verified', 'refused')),
  CONSTRAINT "chat_sessions_profile_ck" CHECK ("profile_type" IS NULL OR "profile_type" IN ('individual', 'business')),
  CONSTRAINT "chat_sessions_profile_read_ck" CHECK ("profile_read" IN ('read', 'unread', 'guest')),
  CONSTRAINT "chat_sessions_active_ck" CHECK (("status" = 'active') <= ("agent_id" IS NOT NULL)),
  CONSTRAINT "chat_sessions_closed_ck" CHECK (("status" = 'closed') = ("closed_at" IS NOT NULL)),
  CONSTRAINT "chat_sessions_ticket_ck" CHECK ("ticket_id" IS NULL OR "status" = 'closed'),
  CONSTRAINT "chat_sessions_ticket_uq" UNIQUE ("ticket_id")
);
CREATE INDEX IF NOT EXISTS "chat_sessions_open_idx" ON "support"."chat_sessions" ("created_at") WHERE "status" <> 'closed';

-- Messages, dense per chat. (session, client_message_id) makes a resend store nothing new.
CREATE TABLE IF NOT EXISTS "support"."chat_messages" (
  "id"                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "session_id"         uuid NOT NULL REFERENCES "support"."chat_sessions" ("id"),
  "seq"                integer NOT NULL,
  "author_role"        text NOT NULL,
  "author_id"          text,
  "client_message_id"  text NOT NULL,
  "body"               text NOT NULL,
  "created_at"         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "chat_messages_seq_uq" UNIQUE ("session_id", "seq"),
  CONSTRAINT "chat_messages_client_uq" UNIQUE ("session_id", "client_message_id"),
  CONSTRAINT "chat_messages_role_ck" CHECK ("author_role" IN ('customer', 'agent'))
);

-- Messages per chat per rate window (the owner's limit). A refused send stores no message.
CREATE TABLE IF NOT EXISTS "support"."chat_rate_windows" (
  "session_id"    uuid NOT NULL REFERENCES "support"."chat_sessions" ("id"),
  "window_start"  bigint NOT NULL,
  "sent"          integer NOT NULL,
  PRIMARY KEY ("session_id", "window_start")
);

-- A guest's pre-chat form: an enquiry with source chat. The address is kept sealed (the guest address key) and hashed,
-- and erased after the guest retention; it is never answered back.
CREATE TABLE IF NOT EXISTS "support"."chat_enquiries" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "session_id"      uuid NOT NULL REFERENCES "support"."chat_sessions" ("id"),
  "source"          text NOT NULL,
  "name"            text,
  "address_hash"    text,
  "address_sealed"  text,
  "erase_after"     timestamptz,
  "erased_at"       timestamptz,
  "created_at"      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "chat_enquiries_session_uq" UNIQUE ("session_id"),
  CONSTRAINT "chat_enquiries_source_ck" CHECK ("source" = 'chat'),
  CONSTRAINT "chat_enquiries_address_ck" CHECK (("address_sealed" IS NULL) OR ("erase_after" IS NOT NULL))
);

-- Where a request came from, beside the ticket and never on it: the chat it was made from and the profile type identity
-- answered when the chat opened.
CREATE TABLE IF NOT EXISTS "support"."ticket_sources" (
  "ticket_id"        uuid PRIMARY KEY REFERENCES "support"."tickets" ("id"),
  "source"           text NOT NULL,
  "chat_session_id"  uuid NOT NULL REFERENCES "support"."chat_sessions" ("id"),
  "profile_type"     text,
  "profile_read"     text NOT NULL,
  "created_at"       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "ticket_sources_session_uq" UNIQUE ("chat_session_id"),
  CONSTRAINT "ticket_sources_source_ck" CHECK ("source" = 'chat'),
  CONSTRAINT "ticket_sources_profile_ck" CHECK ("profile_type" IS NULL OR "profile_type" IN ('individual', 'business')),
  CONSTRAINT "ticket_sources_profile_read_ck" CHECK ("profile_read" IN ('read', 'unread', 'guest'))
);
