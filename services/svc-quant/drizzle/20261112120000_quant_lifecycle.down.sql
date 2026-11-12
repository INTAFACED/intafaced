-- Reverses the lifecycle migration (AL-lifecycle-01). Every stage row, gate decision and runtime owner criterion is lost.
DROP TABLE IF EXISTS "quant"."strategy_stages";
DROP TABLE IF EXISTS "quant"."gate_decisions";
DROP TABLE IF EXISTS "quant"."owner_criteria_audit";
DROP TABLE IF EXISTS "quant"."owner_criteria";
