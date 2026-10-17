DROP TABLE IF EXISTS "pay"."conversion_late_fill_books";

DROP INDEX IF EXISTS "pay"."conversion_orders_late_fill_due_idx";

ALTER TABLE "pay"."conversion_orders"
  DROP CONSTRAINT IF EXISTS "conversion_orders_late_fill_checks";

ALTER TABLE "pay"."conversion_orders"
  DROP COLUMN IF EXISTS "late_fill_check_final_at";

ALTER TABLE "pay"."conversion_orders"
  DROP COLUMN IF EXISTS "late_fill_next_check_at";

ALTER TABLE "pay"."conversion_orders"
  DROP COLUMN IF EXISTS "late_fill_check_count";
