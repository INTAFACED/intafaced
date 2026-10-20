-- svc-support · scam and phishing guides join the platform KB (I-signin-sessions-26)
-- Reversal: 0013_kb_scam_guides.down.sql
--
-- NOT tagged `intafaced:destructive`: insert-only, idempotent, no row is
-- changed or removed. Category and tags sit on the immutable version row
-- (0011), so they are written with it.

INSERT INTO "support"."kb_articles" ("id", "title_key", "body_key", "revision", "published")
VALUES
  ('kb-security-scam-tactics', 'support.kb.scam_tactics.title', 'support.kb.scam_tactics.body', 1, true),
  ('kb-security-spoofed-sms', 'support.kb.spoofed_sms.title', 'support.kb.spoofed_sms.body', 1, true),
  ('kb-security-dusting', 'support.kb.dusting.title', 'support.kb.dusting.body', 1, true),
  ('kb-security-email-compromise', 'support.kb.email_compromise.title', 'support.kb.email_compromise.body', 1, true)
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "support"."kb_article_versions" ("id", "version", "title_key", "body_key", "category", "tags")
VALUES
  ('kb-security-scam-tactics', 1, 'support.kb.scam_tactics.title', 'support.kb.scam_tactics.body', 'security', '["scams"]'::jsonb),
  ('kb-security-spoofed-sms', 1, 'support.kb.spoofed_sms.title', 'support.kb.spoofed_sms.body', 'security', '["scams"]'::jsonb),
  ('kb-security-dusting', 1, 'support.kb.dusting.title', 'support.kb.dusting.body', 'security', '["scams"]'::jsonb),
  ('kb-security-email-compromise', 1, 'support.kb.email_compromise.title', 'support.kb.email_compromise.body', 'security', '["scams"]'::jsonb)
ON CONFLICT ("id", "version") DO NOTHING;
