-- trade · VIP applications with a proof file (SP-fees-vip-04, J-cex-spot-10 #7)
-- Reversal: 20261025020000_vip_applications.down.sql
--
-- A person asks for a VIP tier with a proof of status. The proof is stored encrypted (AES-256-GCM, key from the
-- environment): the row holds ciphertext, a nonce and the plaintext SHA-256, never the plaintext. One application is
-- pending per person at a time. `request_key` is the business key of the request (`vip-application:<userId>:<id>`).
-- Compliance review and a trial grant come with their own migration. Not money.
CREATE TABLE IF NOT EXISTS "trade"."vip_applications" (
  "id"                  uuid PRIMARY KEY,
  "user_id"             uuid NOT NULL,
  "request_id"          text NOT NULL CONSTRAINT "vip_applications_request_id_ck" CHECK ("request_id" ~ '^[A-Za-z0-9._:-]{8,64}$'),
  "request_key"         text NOT NULL,
  "status"              text NOT NULL DEFAULT 'pending'
                          CONSTRAINT "vip_applications_status_ck" CHECK ("status" IN ('pending', 'approved', 'approved_no_trial', 'rejected')),
  "proof_file_name"     text NOT NULL CONSTRAINT "vip_applications_file_name_ck" CHECK (length("proof_file_name") BETWEEN 1 AND 200),
  "proof_content_type"  text NOT NULL,
  "proof_byte_length"   integer NOT NULL CONSTRAINT "vip_applications_byte_length_ck" CHECK ("proof_byte_length" >= 1),
  "proof_sha256"        text NOT NULL CONSTRAINT "vip_applications_sha256_ck" CHECK ("proof_sha256" ~ '^[0-9a-f]{64}$'),
  "proof_ciphertext"    bytea NOT NULL,
  "proof_nonce"         bytea NOT NULL CONSTRAINT "vip_applications_nonce_ck" CHECK (octet_length("proof_nonce") = 12),
  "note"                text CONSTRAINT "vip_applications_note_ck" CHECK ("note" IS NULL OR length("note") BETWEEN 1 AND 1000),
  "schedule_version"    text NOT NULL,
  "created_at"          timestamptz NOT NULL DEFAULT now(),
  "updated_at"          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "vip_applications_request_key_ck" CHECK ("request_key" = 'vip-application:' || "user_id"::text || ':' || "request_id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "vip_applications_request_key_idx" ON "trade"."vip_applications" ("request_key");
CREATE UNIQUE INDEX IF NOT EXISTS "vip_applications_one_pending_idx" ON "trade"."vip_applications" ("user_id") WHERE "status" = 'pending';
CREATE INDEX IF NOT EXISTS "vip_applications_user_idx" ON "trade"."vip_applications" ("user_id", "created_at" DESC);

-- Every status an application takes, and who gave it. Append-only.
CREATE TABLE IF NOT EXISTS "trade"."vip_application_events" (
  "id"              bigserial PRIMARY KEY,
  "application_id"  uuid NOT NULL REFERENCES "trade"."vip_applications"("id"),
  "status"          text NOT NULL
                      CONSTRAINT "vip_application_events_status_ck" CHECK ("status" IN ('pending', 'approved', 'approved_no_trial', 'rejected')),
  "actor_id"        text NOT NULL CONSTRAINT "vip_application_events_actor_ck" CHECK (length(btrim("actor_id")) > 0),
  "actor_role"      text NOT NULL CONSTRAINT "vip_application_events_role_ck" CHECK ("actor_role" IN ('applicant', 'compliance')),
  "reason"          text CONSTRAINT "vip_application_events_reason_ck" CHECK ("reason" IS NULL OR length(btrim("reason")) BETWEEN 3 AND 1000),
  "created_at"      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "vip_application_events_application_idx" ON "trade"."vip_application_events" ("application_id", "id");

CREATE OR REPLACE FUNCTION "trade"."vip_application_events_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'trade.vip_application_events is append-only: % is not permitted.', TG_OP USING ERRCODE = 'restrict_violation';
END;
$$;
DROP TRIGGER IF EXISTS "vip_application_events_append_only_trg" ON "trade"."vip_application_events";
CREATE TRIGGER "vip_application_events_append_only_trg"
  BEFORE UPDATE OR DELETE ON "trade"."vip_application_events"
  FOR EACH ROW EXECUTE FUNCTION "trade"."vip_application_events_append_only"();

-- The proof and who sent it never change; only the status and its time do, and a row is never deleted.
CREATE OR REPLACE FUNCTION "trade"."vip_applications_status_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'trade.vip_applications rows are kept: DELETE is not permitted.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW."id", NEW."user_id", NEW."request_id", NEW."request_key", NEW."proof_file_name", NEW."proof_content_type",
      NEW."proof_byte_length", NEW."proof_sha256", NEW."proof_ciphertext", NEW."proof_nonce", NEW."note",
      NEW."schedule_version", NEW."created_at")
     IS DISTINCT FROM
     (OLD."id", OLD."user_id", OLD."request_id", OLD."request_key", OLD."proof_file_name", OLD."proof_content_type",
      OLD."proof_byte_length", OLD."proof_sha256", OLD."proof_ciphertext", OLD."proof_nonce", OLD."note",
      OLD."schedule_version", OLD."created_at") THEN
    RAISE EXCEPTION 'trade.vip_applications: only the status changes.' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS "vip_applications_status_only_trg" ON "trade"."vip_applications";
CREATE TRIGGER "vip_applications_status_only_trg"
  BEFORE UPDATE OR DELETE ON "trade"."vip_applications"
  FOR EACH ROW EXECUTE FUNCTION "trade"."vip_applications_status_only"();
