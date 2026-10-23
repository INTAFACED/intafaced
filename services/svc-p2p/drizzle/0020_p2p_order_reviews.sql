-- P-ads-merchant-21: one review per party per released trade, plus the hide audit.
-- Ratings are counts. No balance is stored here.
-- Reversal: 0020_p2p_order_reviews.down.sql
CREATE TABLE IF NOT EXISTS "p2p"."order_reviews" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "trade_id" uuid NOT NULL REFERENCES "p2p"."p2p_trades" ("id"),
  "author_id" text NOT NULL,
  "subject_id" text NOT NULL,
  "rating" text NOT NULL,
  "comment" text NOT NULL DEFAULT '',
  "explanation" text,
  "reply" text,
  "replied_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "hidden" boolean NOT NULL DEFAULT false,
  "hidden_reason" text,
  "hidden_at" timestamptz,
  "hidden_by" text,
  CONSTRAINT "order_reviews_one_per_party" UNIQUE ("trade_id", "author_id"),
  CONSTRAINT "order_reviews_rating_ck" CHECK ("rating" IN ('good', 'bad')),
  CONSTRAINT "order_reviews_parties_ck" CHECK ("author_id" <> "subject_id"),
  CONSTRAINT "order_reviews_bad_explanation_ck" CHECK (
    "rating" <> 'bad' OR length(btrim(coalesce("explanation", ''))) > 0
  ),
  CONSTRAINT "order_reviews_hidden_ck" CHECK (
    ("hidden" = false AND "hidden_reason" IS NULL AND "hidden_at" IS NULL AND "hidden_by" IS NULL)
    OR (
      "hidden" = true
      AND length(btrim(coalesce("hidden_reason", ''))) > 0
      AND "hidden_at" IS NOT NULL
      AND "hidden_by" IS NOT NULL
    )
  ),
  CONSTRAINT "order_reviews_reply_ck" CHECK (
    ("reply" IS NULL AND "replied_at" IS NULL)
    OR (length(btrim(coalesce("reply", ''))) > 0 AND "replied_at" IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS "order_reviews_subject_idx"
  ON "p2p"."order_reviews" ("subject_id", "created_at" DESC, "id" DESC);

CREATE TABLE IF NOT EXISTS "p2p"."order_review_audit" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "review_id" uuid NOT NULL REFERENCES "p2p"."order_reviews" ("id"),
  "actor_id" text NOT NULL,
  "reason" text NOT NULL,
  "before_hidden" boolean NOT NULL,
  "after_hidden" boolean NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "order_review_audit_reason_ck" CHECK (length(btrim("reason")) > 0),
  CONSTRAINT "order_review_audit_change_ck" CHECK ("before_hidden" IS DISTINCT FROM "after_hidden")
);
