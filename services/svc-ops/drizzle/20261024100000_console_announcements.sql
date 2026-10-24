-- svc-ops · founder console announcement banner and staff preferences (OPS-admin-access-08)
-- Reversal: 20261024100000_console_announcements.down.sql
--
-- Announcements are the console's own banner for staff (not svc-notify's public notice board). Each is saved once under
-- its business key (`announcement:<hash>`) as a draft or published, and later published or withdrawn. Only one shows at a
-- time: the exclusion constraint refuses two published announcements whose windows overlap, whatever the code in front of
-- it does. A published window never starts before it was published (`starts_at` is clipped to that instant; the founder's
-- own start stays in `requested_starts_at`), so an announcement that has already ended never holds a window it can no
-- longer show. Every save, publish and withdraw is appended to a log that refuses update and delete.
--
-- Preferences are stored per level: one organisation row (subject '') and one row per founder (subject = their user id).
-- A null column leaves that preference to the level above; the server level is fixed in code, so nothing is seeded.
CREATE TABLE ops.console_announcements (
 id uuid PRIMARY KEY,
 key text NOT NULL UNIQUE,
 kind text NOT NULL CHECK (kind IN ('information', 'warning', 'error', 'success')),
 -- The contract's limits count UTF-16 units, never fewer than code points, so these bounds hold for anything it passed.
 title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
 body text NOT NULL CHECK (char_length(body) <= 500),
 action jsonb NOT NULL CHECK (action ->> 'type' IN ('none', 'link', 'dialog')),
 requested_starts_at timestamptz NOT NULL,
 starts_at timestamptz NOT NULL,
 ends_at timestamptz NOT NULL,
 status text NOT NULL CHECK (status IN ('draft', 'published', 'withdrawn')),
 created_by text NOT NULL,
 created_at timestamptz NOT NULL,
 published_by text,
 published_at timestamptz,
 withdrawn_by text,
 withdrawn_at timestamptz,
 CHECK (ends_at > starts_at),
 CHECK (starts_at >= requested_starts_at),
 CHECK (status <> 'draft' OR (published_at IS NULL AND withdrawn_at IS NULL)),
 CHECK (status <> 'published' OR published_at IS NOT NULL),
 CHECK (status <> 'withdrawn' OR withdrawn_at IS NOT NULL),
 CONSTRAINT console_announcements_one_at_a_time EXCLUDE USING gist (tstzrange(starts_at, ends_at, '[)') WITH &&)
   WHERE (status = 'published')
);
CREATE INDEX console_announcements_newest ON ops.console_announcements (created_at DESC, id);
CREATE TABLE ops.console_announcement_log (
 seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 announcement_id uuid NOT NULL REFERENCES ops.console_announcements (id),
 op text NOT NULL CHECK (op IN ('save', 'publish', 'withdraw')),
 outcome text NOT NULL CHECK (outcome IN ('created', 'changed', 'noop')),
 status_after text NOT NULL,
 actor_id text NOT NULL,
 logged_at timestamptz NOT NULL
);
CREATE TABLE ops.console_preferences (
 level text NOT NULL CHECK (level IN ('organisation', 'person')),
 subject text NOT NULL,
 theme text CHECK (theme IN ('dark')),
 home_page text CHECK (char_length(home_page) BETWEEN 1 AND 200),
 time_zone text CHECK (char_length(time_zone) BETWEEN 1 AND 64),
 week_start text CHECK (week_start IN ('monday', 'saturday', 'sunday')),
 revision integer NOT NULL CHECK (revision >= 1),
 updated_by text NOT NULL,
 updated_at timestamptz NOT NULL,
 PRIMARY KEY (level, subject),
 CHECK ((level = 'organisation') = (subject = ''))
);
CREATE TABLE ops.console_preference_log (
 seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 level text NOT NULL,
 subject text NOT NULL,
 before jsonb NOT NULL,
 after jsonb NOT NULL,
 actor_id text NOT NULL,
 logged_at timestamptz NOT NULL
);
CREATE FUNCTION ops.console_log_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'ops.% is append-only', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END $$;
CREATE TRIGGER console_announcement_log_append_only BEFORE UPDATE OR DELETE ON ops.console_announcement_log FOR EACH ROW EXECUTE FUNCTION ops.console_log_append_only();
CREATE TRIGGER console_preference_log_append_only BEFORE UPDATE OR DELETE ON ops.console_preference_log FOR EACH ROW EXECUTE FUNCTION ops.console_log_append_only();
