-- Reverse 20261024060245_p2p_order_reviews. Drops order reviews and the hide audit. Reputation counts return to no rating.
DROP TABLE IF EXISTS "p2p"."order_review_audit";
DROP INDEX IF EXISTS "p2p"."order_reviews_subject_idx";
DROP TABLE IF EXISTS "p2p"."order_reviews";
