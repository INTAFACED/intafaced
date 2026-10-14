-- intafaced:destructive — reversal of 0050_liquidation_rungs.sql
--
-- Drops the stored rungs. Only rungs that posted but had not yet moved their
-- position row matter, and after the drop those re-plan from the live mark
-- (the claim-based behaviour before this migration).

DROP TABLE IF EXISTS "trade"."liquidation_rungs";
