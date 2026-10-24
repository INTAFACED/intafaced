-- KYB DOCUMENT REVIEW: A COMPLIANCE REVIEWER MARKS EACH UPLOAD VERIFIED OR INVALID (J-merchant-02 step 3).
--
-- A reviewer with admin:compliance gives one verdict per upload: accepted (the business reads Verified) or rejected with
-- the reason the business reads (Invalid). The verdict is written onto the upload's row, which may change only from
-- `provided`, and only in its state and reason; the business answers a rejection with a new file. Every verdict is
-- also an append-only row naming who gave it, and every time a reviewer opens a file's bytes is an append-only row.
-- Not money.

CREATE TABLE IF NOT EXISTS "pay"."kyb_document_reviews" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "document_id"    uuid NOT NULL REFERENCES "pay"."kyb_documents"("id"),
  "application_id" uuid NOT NULL REFERENCES "pay"."kyb_applications"("id"),
  "verdict"        text NOT NULL CONSTRAINT "kyb_document_reviews_verdict_ck" CHECK ("verdict" IN ('accepted', 'rejected')),
  "reason"         text CONSTRAINT "kyb_document_reviews_reason_len" CHECK ("reason" IS NULL OR length(btrim("reason")) BETWEEN 3 AND 1000),
  "actor_id"       text NOT NULL CONSTRAINT "kyb_document_reviews_actor_not_blank" CHECK (length(btrim("actor_id")) > 0),
  "actor_scope"    text NOT NULL CONSTRAINT "kyb_document_reviews_scope_ck" CHECK ("actor_scope" = 'admin:compliance'),
  "created_at"     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "kyb_document_reviews_reason_only_when_rejected" CHECK (("verdict" = 'rejected') = ("reason" IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS "kyb_document_reviews_once_idx" ON "pay"."kyb_document_reviews" ("document_id");

CREATE TABLE IF NOT EXISTS "pay"."kyb_document_reads" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "document_id" uuid NOT NULL REFERENCES "pay"."kyb_documents"("id"),
  "actor_id"    text NOT NULL CONSTRAINT "kyb_document_reads_actor_not_blank" CHECK (length(btrim("actor_id")) > 0),
  "actor_scope" text NOT NULL CONSTRAINT "kyb_document_reads_scope_ck" CHECK ("actor_scope" = 'admin:compliance'),
  "created_at"  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "kyb_document_reads_document_idx" ON "pay"."kyb_document_reads" ("document_id", "created_at");

CREATE OR REPLACE FUNCTION "pay"."kyb_document_review_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'pay.% is append-only: % is not permitted.', TG_TABLE_NAME, TG_OP USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS "kyb_document_reviews_append_only_trg" ON "pay"."kyb_document_reviews";
CREATE TRIGGER "kyb_document_reviews_append_only_trg"
  BEFORE UPDATE OR DELETE ON "pay"."kyb_document_reviews"
  FOR EACH ROW EXECUTE FUNCTION "pay"."kyb_document_review_append_only"();

DROP TRIGGER IF EXISTS "kyb_document_reads_append_only_trg" ON "pay"."kyb_document_reads";
CREATE TRIGGER "kyb_document_reads_append_only_trg"
  BEFORE UPDATE OR DELETE ON "pay"."kyb_document_reads"
  FOR EACH ROW EXECUTE FUNCTION "pay"."kyb_document_review_append_only"();

-- An upload's bytes and metadata never change; only a waiting upload takes a verdict.
CREATE OR REPLACE FUNCTION "pay"."kyb_documents_verdict_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'pay.kyb_documents rows are kept: DELETE is not permitted.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."state" <> 'provided' OR NEW."state" NOT IN ('accepted', 'rejected')
     OR (NEW."id", NEW."seq", NEW."application_id", NEW."document_key", NEW."content_type", NEW."byte_length", NEW."sha256",
         NEW."ciphertext", NEW."nonce", NEW."uploaded_by", NEW."created_at")
        IS DISTINCT FROM
        (OLD."id", OLD."seq", OLD."application_id", OLD."document_key", OLD."content_type", OLD."byte_length", OLD."sha256",
         OLD."ciphertext", OLD."nonce", OLD."uploaded_by", OLD."created_at") THEN
    RAISE EXCEPTION 'pay.kyb_documents: only a waiting upload takes a verdict, and only its state and reason change.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "kyb_documents_verdict_only_trg" ON "pay"."kyb_documents";
CREATE TRIGGER "kyb_documents_verdict_only_trg"
  BEFORE UPDATE OR DELETE ON "pay"."kyb_documents"
  FOR EACH ROW EXECUTE FUNCTION "pay"."kyb_documents_verdict_only"();
