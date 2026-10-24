-- Receipt branding and payment status emails (M-adv-payments-core-07).
--
-- A template version is a complete snapshot (logo reference, accent, footer, language).
-- Versions, the request that created them, and an issued receipt's pin are append-only:
-- a later edit inserts a new version and does not change the one a receipt was issued with.
-- Merchants with no version use the latest ops default (merchant_id IS NULL).
--
-- Payment status email (succeeded, failed, refunded) is a switch. NULL is unset, not on.
-- pay.payment_status_email_queue is the queue a provider would write. Nothing in this
-- build inserts into it: sending refuses vendor.email and queues nothing.

CREATE TABLE IF NOT EXISTS "pay"."receipt_template_versions" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "merchant_id" uuid REFERENCES "pay"."merchants"("id"),
  "version"     integer NOT NULL CONSTRAINT "receipt_template_versions_version_ck" CHECK ("version" > 0),
  "logo_ref"    text CONSTRAINT "receipt_template_versions_logo_ck" CHECK (
                  "logo_ref" IS NULL
                  OR (
                    "logo_ref" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
                    AND "logo_ref" !~ '\.\.'
                    AND "logo_ref" !~ '://'
                  )
                ),
  "accent"      text CONSTRAINT "receipt_template_versions_accent_ck" CHECK (
                  "accent" IS NULL OR "accent" ~ '^#[0-9A-F]{6}$'
                ),
  "footer"      text NOT NULL CONSTRAINT "receipt_template_versions_footer_ck" CHECK (char_length("footer") <= 500),
  "language"    text NOT NULL CONSTRAINT "receipt_template_versions_language_ck" CHECK (
                  char_length(btrim("language")) BETWEEN 1 AND 35
                ),
  "body_hash"   text NOT NULL CONSTRAINT "receipt_template_versions_hash_ck" CHECK ("body_hash" ~ '^[0-9a-f]{64}$'),
  "actor_id"    text NOT NULL CONSTRAINT "receipt_template_versions_actor_ck" CHECK (length(btrim("actor_id")) > 0),
  "created_at"  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "receipt_template_versions_merchant_version_idx"
  ON "pay"."receipt_template_versions" ("merchant_id", "version")
  WHERE "merchant_id" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "receipt_template_versions_ops_version_idx"
  ON "pay"."receipt_template_versions" ("version")
  WHERE "merchant_id" IS NULL;
CREATE INDEX IF NOT EXISTS "receipt_template_versions_latest_idx"
  ON "pay"."receipt_template_versions" ("merchant_id", "version" DESC);

CREATE TABLE IF NOT EXISTS "pay"."receipt_template_requests" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "merchant_id" uuid REFERENCES "pay"."merchants"("id"),
  "request_id"  uuid NOT NULL,
  "body_hash"   text NOT NULL CONSTRAINT "receipt_template_requests_hash_ck" CHECK ("body_hash" ~ '^[0-9a-f]{64}$'),
  "version_id"  uuid NOT NULL REFERENCES "pay"."receipt_template_versions"("id"),
  "actor_id"    text NOT NULL CONSTRAINT "receipt_template_requests_actor_ck" CHECK (length(btrim("actor_id")) > 0),
  "created_at"  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "receipt_template_requests_merchant_idx"
  ON "pay"."receipt_template_requests" ("merchant_id", "request_id")
  WHERE "merchant_id" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "receipt_template_requests_ops_idx"
  ON "pay"."receipt_template_requests" ("request_id")
  WHERE "merchant_id" IS NULL;

CREATE TABLE IF NOT EXISTS "pay"."receipt_issues" (
  "id"                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "merchant_id"         uuid NOT NULL REFERENCES "pay"."merchants"("id"),
  "request_id"          uuid NOT NULL,
  "template_version_id" uuid NOT NULL REFERENCES "pay"."receipt_template_versions"("id"),
  "actor_id"            text NOT NULL CONSTRAINT "receipt_issues_actor_ck" CHECK (length(btrim("actor_id")) > 0),
  "created_at"          timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "receipt_issues_request_idx"
  ON "pay"."receipt_issues" ("merchant_id", "request_id");

CREATE TABLE IF NOT EXISTS "pay"."merchant_status_email_settings" (
  "merchant_id" uuid PRIMARY KEY REFERENCES "pay"."merchants"("id"),
  "succeeded"   boolean,
  "failed"      boolean,
  "refunded"    boolean,
  "updated_by"  text NOT NULL CONSTRAINT "merchant_status_email_settings_actor_ck" CHECK (length(btrim("updated_by")) > 0),
  "created_at"  timestamptz NOT NULL DEFAULT now(),
  "updated_at"  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "pay"."payment_status_email_queue" (
  "id"                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "merchant_id"         uuid NOT NULL REFERENCES "pay"."merchants"("id"),
  "kind"                text NOT NULL CONSTRAINT "payment_status_email_queue_kind_ck" CHECK (
                          "kind" IN ('succeeded', 'failed', 'refunded')
                        ),
  "template_version_id" uuid NOT NULL REFERENCES "pay"."receipt_template_versions"("id"),
  "created_at"          timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION "pay"."receipt_branding_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not permitted. Record a new version instead.', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS "receipt_template_versions_append_only_trg" ON "pay"."receipt_template_versions";
CREATE TRIGGER "receipt_template_versions_append_only_trg"
  BEFORE UPDATE OR DELETE ON "pay"."receipt_template_versions"
  FOR EACH ROW EXECUTE FUNCTION "pay"."receipt_branding_append_only"();

DROP TRIGGER IF EXISTS "receipt_template_requests_append_only_trg" ON "pay"."receipt_template_requests";
CREATE TRIGGER "receipt_template_requests_append_only_trg"
  BEFORE UPDATE OR DELETE ON "pay"."receipt_template_requests"
  FOR EACH ROW EXECUTE FUNCTION "pay"."receipt_branding_append_only"();

DROP TRIGGER IF EXISTS "receipt_issues_append_only_trg" ON "pay"."receipt_issues";
CREATE TRIGGER "receipt_issues_append_only_trg"
  BEFORE UPDATE OR DELETE ON "pay"."receipt_issues"
  FOR EACH ROW EXECUTE FUNCTION "pay"."receipt_branding_append_only"();

DROP TRIGGER IF EXISTS "payment_status_email_queue_append_only_trg" ON "pay"."payment_status_email_queue";
CREATE TRIGGER "payment_status_email_queue_append_only_trg"
  BEFORE UPDATE OR DELETE ON "pay"."payment_status_email_queue"
  FOR EACH ROW EXECUTE FUNCTION "pay"."receipt_branding_append_only"();
