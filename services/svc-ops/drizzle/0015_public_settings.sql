-- svc-ops · owner-set outreach public settings (SP-pages-02)
-- Reversal: 0015_public_settings.down.sql
--
-- One row holds where the invitation site is served (join_url) and the partner programme terms (partner_terms). Each is
-- NULL until a founder sets it: nothing is seeded and no address or wording is built in. Every change is appended to the
-- log under a business key (`ops.public_settings:r<revision>`) with who made it and why, and the log refuses update and delete.
CREATE TABLE ops.public_settings (
 singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
 join_url text CHECK (join_url IS NULL OR char_length(join_url) BETWEEN 8 AND 300),
 partner_terms text CHECK (partner_terms IS NULL OR char_length(partner_terms) BETWEEN 1 AND 20000),
 revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
 updated_by text,
 updated_at timestamptz
);
CREATE TABLE ops.public_settings_log (
 key text PRIMARY KEY,
 fingerprint text NOT NULL,
 revision_after integer NOT NULL UNIQUE CHECK (revision_after >= 1),
 before jsonb NOT NULL,
 after jsonb NOT NULL,
 set_by text NOT NULL,
 reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 500),
 set_at timestamptz NOT NULL
);
CREATE FUNCTION ops.public_settings_log_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'ops.public_settings_log is append-only' USING ERRCODE = 'restrict_violation';
END $$;
CREATE TRIGGER public_settings_log_append_only BEFORE UPDATE OR DELETE ON ops.public_settings_log FOR EACH ROW EXECUTE FUNCTION ops.public_settings_log_append_only();
