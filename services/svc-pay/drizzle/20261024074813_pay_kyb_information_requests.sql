-- KYB INFORMATION REQUESTS: INTAFACED ASKS A BUSINESS FOR MORE, THE BUSINESS ANSWERS, A REVIEWER CLOSES (J-merchant-02 step 4).
--
-- A compliance reviewer (admin:compliance) opens a request with words and a due date; the business answers once with a
-- note, a file, or both; a reviewer closes it with a note the business reads. A request's words and due date never
-- change; its state moves open -> answered -> closed, or open -> closed. An answer's file is kept only after the
-- malware scanner called it clean, encrypted like business documents. Every step, a refused infected file and every
-- read of a file's bytes are append-only events. Not money.

CREATE TABLE IF NOT EXISTS "pay"."kyb_information_requests" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "merchant_id" uuid NOT NULL REFERENCES "pay"."merchants"("id"),
  "request_key" text NOT NULL CONSTRAINT "kyb_information_requests_key_format" CHECK ("request_key" ~ '^[A-Za-z0-9:._-]{8,128}$'),
  "text"        text NOT NULL CONSTRAINT "kyb_information_requests_text_len" CHECK (length(btrim("text")) BETWEEN 3 AND 2000),
  "due_at"      timestamptz NOT NULL,
  "created_by"  text NOT NULL CONSTRAINT "kyb_information_requests_creator_not_blank" CHECK (length(btrim("created_by")) > 0),
  "created_at"  timestamptz NOT NULL DEFAULT now(),
  "state"       text NOT NULL DEFAULT 'open' CONSTRAINT "kyb_information_requests_state_known" CHECK ("state" IN ('open', 'answered', 'closed')),
  "closed_by"   text,
  "closed_at"   timestamptz,
  "close_note"  text CONSTRAINT "kyb_information_requests_close_note_len" CHECK ("close_note" IS NULL OR length(btrim("close_note")) BETWEEN 3 AND 1000),
  CONSTRAINT "kyb_information_requests_due_after_created" CHECK ("due_at" > "created_at"),
  CONSTRAINT "kyb_information_requests_closed_has_who" CHECK (
    ("state" = 'closed') = ("closed_by" IS NOT NULL AND "closed_at" IS NOT NULL AND "close_note" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS "kyb_information_requests_key_idx" ON "pay"."kyb_information_requests" ("request_key");
CREATE INDEX IF NOT EXISTS "kyb_information_requests_merchant_idx" ON "pay"."kyb_information_requests" ("merchant_id", "created_at" DESC);

CREATE TABLE IF NOT EXISTS "pay"."kyb_request_answers" (
  "request_id"   uuid PRIMARY KEY REFERENCES "pay"."kyb_information_requests"("id"),
  "note"         text CONSTRAINT "kyb_request_answers_note_len" CHECK ("note" IS NULL OR length(btrim("note")) BETWEEN 1 AND 2000),
  "file_id"      uuid,
  "content_type" text,
  "byte_length"  integer CONSTRAINT "kyb_request_answers_bytes_positive" CHECK ("byte_length" IS NULL OR "byte_length" > 0),
  "sha256"       text CONSTRAINT "kyb_request_answers_sha_format" CHECK ("sha256" IS NULL OR "sha256" ~ '^[0-9a-f]{64}$'),
  "ciphertext"   bytea,
  "nonce"        bytea,
  "answered_by"  text NOT NULL CONSTRAINT "kyb_request_answers_actor_not_blank" CHECK (length(btrim("answered_by")) > 0),
  "created_at"   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "kyb_request_answers_file_whole" CHECK (
    ("file_id" IS NULL) = ("content_type" IS NULL) AND ("file_id" IS NULL) = ("byte_length" IS NULL)
    AND ("file_id" IS NULL) = ("sha256" IS NULL) AND ("file_id" IS NULL) = ("ciphertext" IS NULL)
    AND ("file_id" IS NULL) = ("nonce" IS NULL)
  ),
  CONSTRAINT "kyb_request_answers_not_empty" CHECK ("note" IS NOT NULL OR "file_id" IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS "pay"."kyb_request_events" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "request_id"  uuid NOT NULL REFERENCES "pay"."kyb_information_requests"("id"),
  "kind"        text NOT NULL CONSTRAINT "kyb_request_events_kind_known" CHECK ("kind" IN ('created', 'answered', 'file_refused', 'closed', 'file_read')),
  "actor_id"    text NOT NULL CONSTRAINT "kyb_request_events_actor_not_blank" CHECK (length(btrim("actor_id")) > 0),
  "actor_scope" text NOT NULL CONSTRAINT "kyb_request_events_scope_ck" CHECK ("actor_scope" IN ('admin:compliance', 'pay:onboard')),
  "detail"      jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at"  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "kyb_request_events_request_idx" ON "pay"."kyb_request_events" ("request_id", "created_at");

CREATE OR REPLACE FUNCTION "pay"."kyb_request_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'pay.% is append-only: % is not permitted.', TG_TABLE_NAME, TG_OP USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS "kyb_request_answers_append_only_trg" ON "pay"."kyb_request_answers";
CREATE TRIGGER "kyb_request_answers_append_only_trg"
  BEFORE UPDATE OR DELETE ON "pay"."kyb_request_answers"
  FOR EACH ROW EXECUTE FUNCTION "pay"."kyb_request_append_only"();

DROP TRIGGER IF EXISTS "kyb_request_events_append_only_trg" ON "pay"."kyb_request_events";
CREATE TRIGGER "kyb_request_events_append_only_trg"
  BEFORE UPDATE OR DELETE ON "pay"."kyb_request_events"
  FOR EACH ROW EXECUTE FUNCTION "pay"."kyb_request_append_only"();

-- A request's words, due date and author never change; it moves forward only, and is never deleted.
CREATE OR REPLACE FUNCTION "pay"."kyb_information_requests_forward_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'pay.kyb_information_requests rows are kept: DELETE is not permitted.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW."id", NEW."merchant_id", NEW."request_key", NEW."text", NEW."due_at", NEW."created_by", NEW."created_at")
       IS DISTINCT FROM (OLD."id", OLD."merchant_id", OLD."request_key", OLD."text", OLD."due_at", OLD."created_by", OLD."created_at")
     OR NOT ((OLD."state" = 'open' AND NEW."state" IN ('answered', 'closed'))
             OR (OLD."state" = 'answered' AND NEW."state" = 'closed')) THEN
    RAISE EXCEPTION 'pay.kyb_information_requests: a request only moves open -> answered -> closed, and its words never change.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "kyb_information_requests_forward_only_trg" ON "pay"."kyb_information_requests";
CREATE TRIGGER "kyb_information_requests_forward_only_trg"
  BEFORE UPDATE OR DELETE ON "pay"."kyb_information_requests"
  FOR EACH ROW EXECUTE FUNCTION "pay"."kyb_information_requests_forward_only"();
