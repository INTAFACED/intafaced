-- THE LOOK OF A BUSINESS'S HOSTED CHECKOUT (M-payments-core-08; J-merchant-04 step 1).
--
-- One row per business, made by its first save: its brand colour (#rrggbb, lower case) and an optional logo (PNG, JPEG
-- or WebP bytes, checked by svc-pay against the owner's published size). No row is the default look. `version` counts
-- saves, so a save made from an older read refuses instead of overwriting a newer one. The hosted page reads this row
-- for every link of the business. Nothing here moves money.
--
-- Every save is also kept in `checkout_branding_saves` with its request id and a hash of what it asked for, so a retried
-- save finds that it was made (even after later saves) and the same id with other details refuses. That log is
-- append-only.

CREATE TABLE IF NOT EXISTS "pay"."checkout_branding" (
  "merchant_id"  uuid PRIMARY KEY REFERENCES "pay"."merchants"("id"),
  "brand_color"  text NOT NULL CONSTRAINT "checkout_branding_color_format" CHECK ("brand_color" ~ '^#[0-9a-f]{6}$'),
  "logo_type"    text CONSTRAINT "checkout_branding_logo_type_known" CHECK ("logo_type" IN ('image/png', 'image/jpeg', 'image/webp')),
  "logo_bytes"   bytea,
  "logo_sha256"  text CONSTRAINT "checkout_branding_logo_sha_format" CHECK ("logo_sha256" ~ '^[0-9a-f]{64}$'),
  "version"      integer NOT NULL DEFAULT 1 CONSTRAINT "checkout_branding_version_positive" CHECK ("version" >= 1),
  "updated_by"   text NOT NULL CONSTRAINT "checkout_branding_actor_not_blank" CHECK (length(btrim("updated_by")) > 0),
  "updated_at"   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "checkout_branding_logo_whole" CHECK (
    ("logo_type" IS NULL AND "logo_bytes" IS NULL AND "logo_sha256" IS NULL)
    OR ("logo_type" IS NOT NULL AND "logo_bytes" IS NOT NULL AND "logo_sha256" IS NOT NULL AND octet_length("logo_bytes") > 0)
  )
);

CREATE TABLE IF NOT EXISTS "pay"."checkout_branding_saves" (
  "merchant_id"  uuid NOT NULL REFERENCES "pay"."merchants"("id"),
  "request_id"   uuid NOT NULL,
  "request_hash" text NOT NULL CONSTRAINT "checkout_branding_saves_hash_format" CHECK ("request_hash" ~ '^[0-9a-f]{64}$'),
  "version"      integer NOT NULL CONSTRAINT "checkout_branding_saves_version_positive" CHECK ("version" >= 1),
  "saved_by"     text NOT NULL CONSTRAINT "checkout_branding_saves_actor_not_blank" CHECK (length(btrim("saved_by")) > 0),
  "saved_at"     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("merchant_id", "request_id")
);

CREATE OR REPLACE FUNCTION "pay"."checkout_branding_saves_kept"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'pay.checkout_branding_saves: the save log is append-only.' USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS "checkout_branding_saves_kept_trg" ON "pay"."checkout_branding_saves";
CREATE TRIGGER "checkout_branding_saves_kept_trg" BEFORE UPDATE OR DELETE ON "pay"."checkout_branding_saves"
  FOR EACH ROW EXECUTE FUNCTION "pay"."checkout_branding_saves_kept"();
