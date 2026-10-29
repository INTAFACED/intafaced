-- BUSINESS CATEGORIES: A STANDARD CLASS FOR ORDINARY VERIFIED BUSINESSES (RC-merchant-08, OWNER 108).
--
-- A standard category takes every rail the platform has (cards, crypto-native and bank transfer) and, like a
-- permissionless one, carries no reserve and no extra documents. Restricted still loses card rails; permissionless
-- stays crypto-native only; prohibited takes nothing. Widening the class check rejects nothing already stored.
ALTER TABLE "pay"."business_categories" DROP CONSTRAINT IF EXISTS "business_categories_class_known";
ALTER TABLE "pay"."business_categories" ADD CONSTRAINT "business_categories_class_known"
  CHECK ("class" IN ('standard', 'permissionless', 'restricted', 'prohibited'));
