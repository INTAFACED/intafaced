-- Reverses 0067_anti_phishing_codes.sql. Every anti-phishing code and its audit rows are dropped.
DROP TABLE IF EXISTS "identity"."anti_phishing_audit";
DROP TABLE IF EXISTS "identity"."anti_phishing_codes";
