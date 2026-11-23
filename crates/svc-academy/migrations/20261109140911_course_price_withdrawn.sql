-- svc-academy · a published paid course's price can be withdrawn (J-academy-01 #5; AC-course-structure-01)
-- Reversal: 20261109140911_course_price_withdrawn.down.sql
--
-- Staff still cannot publish a paid course with no price (`academy.price_unset`). A published paid course can lose its
-- price afterwards, when staff withdraw it; the course then shows with no price. `price_withdrawn_at` records when, and the
-- published-price check is narrowed, not dropped: a published paid course may lack a price only when its price was
-- withdrawn. The withdrawal writes a `price_withdrawn` course event with who and why. No money moves.

ALTER TABLE "academy"."courses" ADD COLUMN IF NOT EXISTS "price_withdrawn_at" timestamptz;

ALTER TABLE "academy"."courses" DROP CONSTRAINT IF EXISTS "courses_published_price_chk";
ALTER TABLE "academy"."courses"
  ADD CONSTRAINT "courses_published_price_chk"
  CHECK ("state" = 'draft' OR "pricing" = 'free' OR "price" IS NOT NULL OR "price_withdrawn_at" IS NOT NULL);

ALTER TABLE "academy"."course_events" DROP CONSTRAINT IF EXISTS "course_events_kind_chk";
ALTER TABLE "academy"."course_events"
  ADD CONSTRAINT "course_events_kind_chk"
  CHECK ("kind" IN ('created', 'updated', 'state', 'outline', 'lesson', 'topics', 'withdrawn', 'price_withdrawn'));
