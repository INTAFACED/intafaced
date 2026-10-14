-- svc-identity · single-use founder enrolment invites. Reversal: 0028_founder_invites_used.down.sql.
--
-- One row per invite that has been spent. The invite code itself is never stored;
-- `hash` is the lowercase SHA-256 hex of its canonical form (the same value the
-- operator puts in IDENTITY_FOUNDER_INVITE_HASHES). The primary key is the
-- single-use guarantee: the row is inserted in the SAME transaction as the user,
-- so one invite makes one account and a race has exactly one winner.
-- Rows are history: they can be neither changed nor deleted, so a spent invite
-- cannot be revived. Policy lives in src/auth/founder-enrolment.ts.
CREATE TABLE "identity"."founder_invites_used" (
  hash text PRIMARY KEY CHECK (hash ~ '^[0-9a-f]{64}$'),
  user_id uuid NOT NULL REFERENCES "identity"."users"(id),
  used_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION "identity"."founder_invites_used_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'identity founder invite history is immutable';
END;
$$;
CREATE TRIGGER "founder_invites_used_immutable" BEFORE UPDATE OR DELETE ON "identity"."founder_invites_used"
  FOR EACH ROW EXECUTE FUNCTION "identity"."founder_invites_used_immutable"();
