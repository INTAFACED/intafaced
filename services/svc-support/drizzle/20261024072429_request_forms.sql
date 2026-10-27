-- svc-support · request forms per type and ticket fields (SP-tickets-03)
-- Reversal: 20261024072429_request_forms.down.sql
--
-- One row per field or form definition, written at a revision by a support lead. Every write is appended to the log
-- with who and why; the log refuses update and delete. The answers a request was sent with are kept once per ticket,
-- with the form revision they were checked against. The form and field caps are owner values and are not stored here.

CREATE TABLE IF NOT EXISTS "support"."request_definitions" (
  "kind" text NOT NULL CHECK ("kind" IN ('field', 'form')),
  "id" text NOT NULL CHECK ("id" ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  "definition" jsonb NOT NULL,
  "revision" integer NOT NULL CHECK ("revision" >= 1),
  "updated_at" timestamptz NOT NULL,
  PRIMARY KEY ("kind", "id")
);

CREATE TABLE IF NOT EXISTS "support"."request_definition_log" (
  "kind" text NOT NULL,
  "id" text NOT NULL,
  "revision" integer NOT NULL CHECK ("revision" >= 1),
  "definition" jsonb NOT NULL,
  "actor_id" text NOT NULL,
  "reason" text NOT NULL CHECK (char_length("reason") BETWEEN 1 AND 500),
  "at" timestamptz NOT NULL,
  PRIMARY KEY ("kind", "id", "revision")
);

CREATE OR REPLACE FUNCTION "support"."request_definition_log_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'support.request_definition_log is append-only' USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "request_definition_log_append_only_trg" ON "support"."request_definition_log";
CREATE TRIGGER "request_definition_log_append_only_trg"
  BEFORE UPDATE OR DELETE ON "support"."request_definition_log"
  FOR EACH ROW EXECUTE FUNCTION "support"."request_definition_log_append_only"();

CREATE TABLE IF NOT EXISTS "support"."ticket_field_values" (
  "ticket_id" uuid PRIMARY KEY REFERENCES "support"."tickets" ("id"),
  "form_id" text NOT NULL,
  "form_revision" integer NOT NULL CHECK ("form_revision" >= 1),
  "field_values" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL
);
