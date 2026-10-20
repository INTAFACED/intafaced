-- Reverse 0013_kb_scam_guides.sql
-- Version rows are immutable (0008) and stay; the head rows go, so the public doors stop serving the guides.
DELETE FROM "support"."kb_articles"
WHERE "id" IN ('kb-security-scam-tactics', 'kb-security-spoofed-sms', 'kb-security-dusting', 'kb-security-email-compromise');
