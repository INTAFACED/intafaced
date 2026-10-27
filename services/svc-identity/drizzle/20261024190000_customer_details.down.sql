-- intafaced:destructive drops every customer's staff-edited personal details, their compliance reviews and the edit
-- history. Nothing else reads these tables; identity's sign-up, KYC records and documents are untouched.
DROP TABLE IF EXISTS "identity"."customer_detail_events";
DROP TABLE IF EXISTS "identity"."customer_detail_reviews";
DROP TABLE IF EXISTS "identity"."customer_details";
