-- svc-notify · genuine-communication contact policy (BK-safe-02)
-- Reversal: 0024_notify_contact_policy.down.sql
--
-- Owner-published policy on how we contact customers: official domains, the
-- "we never ask you to move money" statement, the channels we use, whether an
-- SMS ever carries a link, and where to report phishing. Append-only versions,
-- each behind a second person's approval. No copy is seeded: with no row the
-- public read says not published.

CREATE TABLE IF NOT EXISTS "notify"."contact_policy_versions" (
  "version"              integer PRIMARY KEY,
  "official_domains"     text[] NOT NULL,
  "never_ask_statement"  text NOT NULL,
  "contact_channels"     text[] NOT NULL,
  "sms_carries_links"    boolean NOT NULL,
  "phishing_report"      text NOT NULL,
  "author_id"            text NOT NULL,
  "approval_id"          text NOT NULL,
  "created_at"           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "contact_policy_version_ck" CHECK ("version" >= 1),
  CONSTRAINT "contact_policy_domains_ck" CHECK (cardinality("official_domains") BETWEEN 1 AND 20),
  CONSTRAINT "contact_policy_channels_ck" CHECK (
    cardinality("contact_channels") >= 1
    AND "contact_channels" <@ ARRAY['email', 'sms', 'push', 'in_app', 'phone']::text[]
  ),
  CONSTRAINT "contact_policy_copy_ck" CHECK (btrim("never_ask_statement") <> '' AND btrim("phishing_report") <> '')
);

CREATE UNIQUE INDEX IF NOT EXISTS "contact_policy_versions_approval_uq"
  ON "notify"."contact_policy_versions" ("approval_id");

DROP TRIGGER IF EXISTS contact_policy_versions_append_only ON notify.contact_policy_versions;
CREATE TRIGGER contact_policy_versions_append_only
  BEFORE UPDATE OR DELETE ON notify.contact_policy_versions
  FOR EACH ROW EXECUTE FUNCTION notify.append_only();
