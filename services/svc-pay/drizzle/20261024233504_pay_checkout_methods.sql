-- THE PAYMENT METHODS A BUSINESS'S HOSTED CHECKOUT OFFERS (M-adv-payments-core-11; J-merchant-04 step 7).
--
-- One row per business, made by its first save: every catalogue method once, in the order the checkout offers them,
-- each on or off with an optional minimum and maximum in one asset (decimal strings, never numbers; blank is no rule).
-- No row is the default: the catalogue order with the methods the platform can take on. `version` counts saves, so a
-- save made from an older read refuses instead of overwriting a newer one. Nothing here moves money.
--
-- Every save is also kept in `checkout_method_saves` with its request id and a hash of what it asked for, so a retried
-- save finds that it was made (even after later saves) and the same id with other details refuses. That log is
-- append-only.

CREATE TABLE IF NOT EXISTS "pay"."checkout_methods" (
  "merchant_id"  uuid PRIMARY KEY REFERENCES "pay"."merchants"("id"),
  "methods"      jsonb NOT NULL CONSTRAINT "checkout_methods_is_list" CHECK (jsonb_typeof("methods") = 'array' AND jsonb_array_length("methods") > 0),
  "version"      integer NOT NULL DEFAULT 1 CONSTRAINT "checkout_methods_version_positive" CHECK ("version" >= 1),
  "updated_by"   text NOT NULL CONSTRAINT "checkout_methods_actor_not_blank" CHECK (length(btrim("updated_by")) > 0),
  "updated_at"   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "pay"."checkout_method_saves" (
  "merchant_id"  uuid NOT NULL REFERENCES "pay"."merchants"("id"),
  "request_id"   uuid NOT NULL,
  "request_hash" text NOT NULL CONSTRAINT "checkout_method_saves_hash_format" CHECK ("request_hash" ~ '^[0-9a-f]{64}$'),
  "version"      integer NOT NULL CONSTRAINT "checkout_method_saves_version_positive" CHECK ("version" >= 1),
  "saved_by"     text NOT NULL CONSTRAINT "checkout_method_saves_actor_not_blank" CHECK (length(btrim("saved_by")) > 0),
  "saved_at"     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("merchant_id", "request_id")
);

CREATE OR REPLACE FUNCTION "pay"."checkout_method_saves_kept"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'pay.checkout_method_saves: the save log is append-only.' USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS "checkout_method_saves_kept_trg" ON "pay"."checkout_method_saves";
CREATE TRIGGER "checkout_method_saves_kept_trg" BEFORE UPDATE OR DELETE ON "pay"."checkout_method_saves"
  FOR EACH ROW EXECUTE FUNCTION "pay"."checkout_method_saves_kept"();
