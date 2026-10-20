-- intafaced:destructive — reversal of 0082_risk_agreements_eligibility.sql
-- Drops the published agreement versions and texts, every user's acceptances, the eligibility rules and every
-- assessment. Acceptances and assessments are compliance records: take an export first (admin.agreements.export).
DROP TABLE IF EXISTS "trade"."derivatives_eligibility_assessments";
DROP TABLE IF EXISTS "trade"."derivatives_eligibility_rules";
DROP TABLE IF EXISTS "trade"."risk_agreement_acceptances";
DROP TABLE IF EXISTS "trade"."risk_agreement_texts";
DROP TABLE IF EXISTS "trade"."risk_agreement_versions";
