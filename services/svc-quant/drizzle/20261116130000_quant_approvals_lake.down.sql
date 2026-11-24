-- Reverses the live approval policy and market data lake migration (J-algo-dev-16). Every policy, approval, captured
-- lake row, capture pass and capture change row is lost.
DROP TABLE IF EXISTS "quant"."lake_capture_changes";
DROP TABLE IF EXISTS "quant"."lake_passes";
DROP TABLE IF EXISTS "quant"."lake_rows";
DROP TABLE IF EXISTS "quant"."strategy_approvals";
DROP TABLE IF EXISTS "quant"."approval_policies";
