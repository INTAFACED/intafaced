-- W-withdraw-08: the withdrawal address book.
-- One saved destination per (user, kind) becomes a book keyed by (asset, network, address, tag).
-- The legacy single slot (the row the offramp and `setWithdrawDestination` write) stays, marked origin 'legacy',
-- one per (user, kind). A saved book entry has origin 'customer' and its own asset, network and optional tag.
-- A label is unique per user, ignoring case. A rename never touches updated_at: the cooling clock runs from the
-- last change of WHERE money goes, and a label is not that.
-- Reversal: 0043_withdraw_address_book.down.sql

ALTER TABLE "bank"."user_withdraw_destinations"
  ADD COLUMN IF NOT EXISTS "asset_id" text,
  ADD COLUMN IF NOT EXISTS "network" text,
  ADD COLUMN IF NOT EXISTS "tag" text,
  ADD COLUMN IF NOT EXISTS "origin" text NOT NULL DEFAULT 'legacy',
  ADD COLUMN IF NOT EXISTS "state" text NOT NULL DEFAULT 'active';

ALTER TABLE "bank"."user_withdraw_destinations"
  ADD CONSTRAINT "user_withdraw_destinations_origin_ck" CHECK ("origin" IN ('legacy', 'customer')),
  ADD CONSTRAINT "user_withdraw_destinations_state_ck" CHECK ("state" IN ('pending', 'cooling', 'active', 'blocked', 'archived')),
  ADD CONSTRAINT "user_withdraw_destinations_book_ck" CHECK (
    "origin" = 'legacy' OR ("asset_id" IS NOT NULL AND "network" IS NOT NULL)
  ),
  ADD CONSTRAINT "user_withdraw_destinations_tag_ck" CHECK ("tag" IS NULL OR (length("tag") BETWEEN 1 AND 64 AND "tag" = btrim("tag")));

-- Two old rows of one user could share a label (one per kind). Keep the first, suffix the rest, so the unique label
-- index below can be created without losing a row.
WITH dup AS (
  SELECT user_id, kind, row_number() OVER (PARTITION BY user_id, lower(label) ORDER BY created_at, kind) AS n
    FROM "bank"."user_withdraw_destinations"
   WHERE label IS NOT NULL
)
UPDATE "bank"."user_withdraw_destinations" d
   SET label = left(d.label, 56) || ' (' || dup.n || ')'
  FROM dup
 WHERE d.user_id = dup.user_id AND d.kind = dup.kind AND dup.n > 1;

ALTER TABLE "bank"."user_withdraw_destinations" DROP CONSTRAINT "user_withdraw_destinations_pkey";
ALTER TABLE "bank"."user_withdraw_destinations"
  ADD CONSTRAINT "user_withdraw_destinations_pkey" PRIMARY KEY USING INDEX "user_withdraw_destinations_id_idx";

-- The legacy slot: one per (user, kind), as before.
CREATE UNIQUE INDEX "user_withdraw_destinations_legacy_idx"
  ON "bank"."user_withdraw_destinations" ("user_id", "kind") WHERE "origin" = 'legacy';

-- A book entry: one per (user, kind, asset, network, address, tag).
CREATE UNIQUE INDEX "user_withdraw_destinations_book_idx"
  ON "bank"."user_withdraw_destinations" ("user_id", "kind", "asset_id", "network", lower("ref"), coalesce("tag", ''))
  WHERE "origin" = 'customer';

CREATE UNIQUE INDEX "user_withdraw_destinations_label_idx"
  ON "bank"."user_withdraw_destinations" ("user_id", lower("label")) WHERE "label" IS NOT NULL;
