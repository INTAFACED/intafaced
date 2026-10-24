-- MERCHANT TERMS ACCEPTANCE (M-plat-org-13, J-merchant-02 going live).
--
-- One append-only row each time a business's owner accepts a published version of the merchant terms of service:
-- which version, the address it was read at, who accepted it and when. A business accepts each version once; a new version needs a new row. The
-- published version and where to read it are owner settings (PAY_MERCHANT_TERMS_VERSION, PAY_MERCHANT_TERMS_URL);
-- while they are blank nothing can be accepted. Not money.

CREATE TABLE IF NOT EXISTS "pay"."merchant_terms_acceptances" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "merchant_id" uuid NOT NULL REFERENCES "pay"."merchants"("id"),
  "version"     text NOT NULL CONSTRAINT "merchant_terms_acceptances_version_ck" CHECK ("version" ~ '^[A-Za-z0-9._-]{1,64}$'),
  "terms_url"   text NOT NULL CONSTRAINT "merchant_terms_acceptances_url_ck" CHECK ("terms_url" ~ '^https://'),
  "accepted_by" text NOT NULL CONSTRAINT "merchant_terms_acceptances_by_not_blank" CHECK (length(btrim("accepted_by")) > 0),
  "actor_scope" text NOT NULL CONSTRAINT "merchant_terms_acceptances_scope_ck" CHECK ("actor_scope" IN ('pay:write', 'pay:onboard')),
  "accepted_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "merchant_terms_acceptances_once_idx" ON "pay"."merchant_terms_acceptances" ("merchant_id", "version");

CREATE OR REPLACE FUNCTION "pay"."merchant_terms_acceptances_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'pay.merchant_terms_acceptances is append-only: % is not permitted. Record a new acceptance instead.', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS "merchant_terms_acceptances_append_only_trg" ON "pay"."merchant_terms_acceptances";
CREATE TRIGGER "merchant_terms_acceptances_append_only_trg"
  BEFORE UPDATE OR DELETE ON "pay"."merchant_terms_acceptances"
  FOR EACH ROW EXECUTE FUNCTION "pay"."merchant_terms_acceptances_append_only"();
