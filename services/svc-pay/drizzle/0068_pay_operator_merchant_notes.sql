-- W15 operator notes: founder-only notes, tags and a flag on a merchant.
--
-- NEVER READ BY A MERCHANT-FACING PROCEDURE. Only `founderAdmin.ops.notes.*`
-- touches this table, and each of those sits behind founder authority.
-- A note is append-only; "retract" records who withdrew it and when, and the
-- text stays so the operator history is complete.

CREATE TABLE IF NOT EXISTS "pay"."operator_merchant_notes" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "seq"          bigserial NOT NULL,
  "merchant_id"  uuid NOT NULL REFERENCES "pay"."merchants"("id"),
  "body"         text NOT NULL CONSTRAINT "operator_merchant_notes_body_not_blank" CHECK (length(btrim("body")) > 0),
  "tags"         text[] NOT NULL DEFAULT '{}',
  "flagged"      boolean NOT NULL DEFAULT false,
  "author_id"    text NOT NULL CONSTRAINT "operator_merchant_notes_author_not_blank" CHECK (length(btrim("author_id")) > 0),
  "created_at"   timestamptz NOT NULL DEFAULT now(),
  "retracted_at" timestamptz,
  "retracted_by" text,
  "retract_reason" text,
  CONSTRAINT "operator_merchant_notes_retract_all_or_none_ck"
    CHECK (("retracted_at" IS NULL) = ("retracted_by" IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS "operator_merchant_notes_seq_idx" ON "pay"."operator_merchant_notes" ("seq");
CREATE INDEX IF NOT EXISTS "operator_merchant_notes_merchant_idx" ON "pay"."operator_merchant_notes" ("merchant_id", "seq" DESC);

-- Only the retraction columns may ever change; the note text and author are fixed.
CREATE OR REPLACE FUNCTION "pay"."operator_merchant_notes_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'pay.operator_merchant_notes rows are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF ROW(NEW.id, NEW.seq, NEW.merchant_id, NEW.body, NEW.tags, NEW.flagged, NEW.author_id, NEW.created_at)
     IS DISTINCT FROM ROW(OLD.id, OLD.seq, OLD.merchant_id, OLD.body, OLD.tags, OLD.flagged, OLD.author_id, OLD.created_at) THEN
    RAISE EXCEPTION 'pay.operator_merchant_notes text is immutable; retract and add a new note' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.retracted_at IS NOT NULL THEN
    RAISE EXCEPTION 'pay.operator_merchant_notes note is already retracted' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "operator_merchant_notes_guard_trg" ON "pay"."operator_merchant_notes";
CREATE TRIGGER "operator_merchant_notes_guard_trg"
  BEFORE UPDATE OR DELETE ON "pay"."operator_merchant_notes"
  FOR EACH ROW EXECUTE FUNCTION "pay"."operator_merchant_notes_guard"();
