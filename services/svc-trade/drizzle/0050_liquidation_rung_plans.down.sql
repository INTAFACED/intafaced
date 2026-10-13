-- intafaced:destructive — reversal of 0050_liquidation_rung_plans.sql
--
-- Drops the stored rung plans. Only plans for rungs that posted but had not yet
-- moved their position row matter, and after the drop those rungs re-plan from
-- the live mark (the behaviour before this migration).

DROP TABLE IF EXISTS "trade"."liquidation_rung_plans";
