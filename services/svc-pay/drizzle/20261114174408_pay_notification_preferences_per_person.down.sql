-- intafaced:destructive — reversal of 20261114174408_pay_notification_preferences_per_person.sql
--
-- Folds each person's preferences back into one per (business, kind): the most recently changed row wins and the
-- others are deleted. The change history is untouched, so every person's choice stays on record there.

DROP INDEX IF EXISTS "pay"."merchant_notification_preference_events_actor_idx";
DELETE FROM "pay"."merchant_notification_preferences" p
 USING "pay"."merchant_notification_preferences" q
 WHERE p."merchant_id" = q."merchant_id" AND p."kind" = q."kind"
   AND (p."updated_at", p."user_id") < (q."updated_at", q."user_id");
ALTER TABLE "pay"."merchant_notification_preferences" DROP CONSTRAINT IF EXISTS "merchant_notification_preferences_pkey";
ALTER TABLE "pay"."merchant_notification_preferences"
  ADD CONSTRAINT "merchant_notification_preferences_pkey" PRIMARY KEY ("merchant_id", "kind");
ALTER TABLE "pay"."merchant_notification_preferences" DROP CONSTRAINT IF EXISTS "merchant_notification_preferences_user_not_blank";
ALTER TABLE "pay"."merchant_notification_preferences" DROP COLUMN IF EXISTS "user_id";
