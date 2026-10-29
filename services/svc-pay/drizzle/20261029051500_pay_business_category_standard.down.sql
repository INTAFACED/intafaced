-- intafaced:destructive — reversal of 20261029051500_pay_business_category_standard.sql
--
-- Refuses to run while any category is standard: the narrower check would reject it. Re-class those categories first
-- through the founders' two-person edit.
ALTER TABLE "pay"."business_categories" DROP CONSTRAINT IF EXISTS "business_categories_class_known";
ALTER TABLE "pay"."business_categories" ADD CONSTRAINT "business_categories_class_known"
  CHECK ("class" IN ('permissionless', 'restricted', 'prohibited'));
