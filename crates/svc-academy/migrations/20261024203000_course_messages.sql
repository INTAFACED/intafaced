-- svc-academy · message the course team (AC-rooms-04)
-- Reversal: 20261024203000_course_messages.down.sql
--
-- One conversation per course staff made and learner, with when each side last read it. A message is from the learner or
-- from staff (with the staff account). A retry with the same client request id is the same message. Mail copies need an
-- email provider, which this build has none of: messages are stored here either way. No money moves.

CREATE TABLE IF NOT EXISTS "academy"."course_conversations" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "course_id"       uuid NOT NULL REFERENCES "academy"."courses" ("id"),
  "learner_id"      uuid NOT NULL,
  "created_at"      timestamptz NOT NULL,
  "last_message_at" timestamptz NOT NULL,
  "learner_read_at" timestamptz,
  "staff_read_at"   timestamptz,
  CONSTRAINT "course_conversations_uq" UNIQUE ("course_id", "learner_id")
);
CREATE INDEX IF NOT EXISTS "course_conversations_learner_idx" ON "academy"."course_conversations" ("learner_id", "last_message_at" DESC);
CREATE INDEX IF NOT EXISTS "course_conversations_recent_idx" ON "academy"."course_conversations" ("last_message_at" DESC);

CREATE TABLE IF NOT EXISTS "academy"."course_messages" (
  "id"                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "conversation_id"   uuid NOT NULL REFERENCES "academy"."course_conversations" ("id"),
  "sender"            text NOT NULL,
  "sender_id"         uuid NOT NULL,
  "body"              text NOT NULL,
  "client_request_id" text NOT NULL,
  "sent_at"           timestamptz NOT NULL,
  CONSTRAINT "course_messages_request_uq" UNIQUE ("sender_id", "client_request_id"),
  CONSTRAINT "course_messages_sender_chk" CHECK ("sender" IN ('learner', 'staff')),
  CONSTRAINT "course_messages_body_chk" CHECK (length(btrim("body")) >= 1)
);
CREATE INDEX IF NOT EXISTS "course_messages_conversation_idx" ON "academy"."course_messages" ("conversation_id", "sent_at");
