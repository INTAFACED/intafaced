-- Reverses 0066_agreements.sql. Acceptances and versions are dropped; nothing else references them.
DROP TABLE IF EXISTS "identity"."agreement_acceptances";
DROP TRIGGER IF EXISTS "agreement_versions_immutable" ON "identity"."agreement_versions";
DROP TABLE IF EXISTS "identity"."agreement_versions";
DROP FUNCTION IF EXISTS "identity"."agreement_versions_immutable"();
