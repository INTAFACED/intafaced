-- NOTIFICATION PREFERENCES PER PERSON (M-plat-org-11, J-merchant-01 #6: "Saved per person with a history").
--
-- A preference was one row per (business, kind), so one teammate's choice became everyone's. Each person now keeps
-- their own: one row per (business, person, kind). The person is `user_id`; the feed stays the business's, and each
-- person's view of it leaves out the kinds that person turned off. A kind with no row for the person is still ON.
--
-- Rows already here were each set by `updated_by` for the whole business; each becomes that person's own choice, so
-- nobody else's view changes from what they chose (they chose nothing: their kinds read ON, the default). The change
-- history (`merchant_notification_preference_events`) is unchanged: its `actor_id` is the person whose preference it
-- is, since a person changes only their own. In-app records only, not money.

ALTER TABLE "pay"."merchant_notification_preferences" ADD COLUMN IF NOT EXISTS "user_id" text;
UPDATE "pay"."merchant_notification_preferences" SET "user_id" = "updated_by" WHERE "user_id" IS NULL;
ALTER TABLE "pay"."merchant_notification_preferences" ALTER COLUMN "user_id" SET NOT NULL;
ALTER TABLE "pay"."merchant_notification_preferences" DROP CONSTRAINT IF EXISTS "merchant_notification_preferences_user_not_blank";
ALTER TABLE "pay"."merchant_notification_preferences"
  ADD CONSTRAINT "merchant_notification_preferences_user_not_blank" CHECK (length(btrim("user_id")) > 0);

-- The key widens from (business, kind) to (business, person, kind): every row the old key allowed, the new one allows.
ALTER TABLE "pay"."merchant_notification_preferences" DROP CONSTRAINT IF EXISTS "merchant_notification_preferences_pkey";
ALTER TABLE "pay"."merchant_notification_preferences"
  ADD CONSTRAINT "merchant_notification_preferences_pkey" PRIMARY KEY ("merchant_id", "user_id", "kind");

CREATE INDEX IF NOT EXISTS "merchant_notification_preference_events_actor_idx"
  ON "pay"."merchant_notification_preference_events" ("merchant_id", "actor_id", "seq" DESC);
