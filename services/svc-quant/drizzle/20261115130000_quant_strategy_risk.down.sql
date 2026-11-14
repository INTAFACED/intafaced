-- Reverses the strategy risk migration (AL-risk-01). Every strategy's caps and trading switch are lost; the switch reads off.
DROP TABLE IF EXISTS "quant"."strategy_risk";
