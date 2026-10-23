-- Saved payment-list views (M-adv-payments-core-01, J-merchant-05 step 3).
--
-- 0132 and 0133 are in other slices, so this is the next number above both.
-- A private view is one user's. A shared view is the business's, and only an
-- owner or admin may write it. The name is the idempotency key: the same
-- definition returns the first row. Shopper reveals are not stored here;
-- they are an append-only row in pay.control_audit.

CREATE TABLE IF NOT EXISTS "pay"."merchant_payment_views" (
  "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "merchant_id"      uuid NOT NULL REFERENCES "pay"."merchants"("id"),
  "user_id"          text NOT NULL CONSTRAINT "merchant_payment_views_user_not_blank" CHECK (length(btrim("user_id")) > 0),
  "name"             text NOT NULL CONSTRAINT "merchant_payment_views_name_not_blank" CHECK (length(btrim("name")) > 0 AND char_length("name") <= 80),
  "visibility"       text NOT NULL CONSTRAINT "merchant_payment_views_visibility_ck" CHECK ("visibility" IN ('private', 'shared')),
  "filters"          jsonb NOT NULL,
  "sort_field"       text NOT NULL CONSTRAINT "merchant_payment_views_sort_field_ck" CHECK ("sort_field" IN ('createdAt', 'amount', 'status')),
  "sort_direction"   text NOT NULL CONSTRAINT "merchant_payment_views_sort_direction_ck" CHECK ("sort_direction" IN ('asc', 'desc')),
  "columns"          text[] NOT NULL CONSTRAINT "merchant_payment_views_columns_ck" CHECK (cardinality("columns") >= 1),
  "definition_hash"  text NOT NULL CONSTRAINT "merchant_payment_views_hash_ck" CHECK ("definition_hash" ~ '^[0-9a-f]{64}$'),
  "created_at"       timestamptz NOT NULL DEFAULT now(),
  "updated_at"       timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "merchant_payment_views_private_name_uq"
  ON "pay"."merchant_payment_views" ("merchant_id", "user_id", "name")
  WHERE "visibility" = 'private';

CREATE UNIQUE INDEX IF NOT EXISTS "merchant_payment_views_shared_name_uq"
  ON "pay"."merchant_payment_views" ("merchant_id", "name")
  WHERE "visibility" = 'shared';

CREATE INDEX IF NOT EXISTS "merchant_payment_views_list_idx"
  ON "pay"."merchant_payment_views" ("merchant_id", "name", "id");
