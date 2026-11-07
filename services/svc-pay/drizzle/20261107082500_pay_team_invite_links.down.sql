-- intafaced:destructive — reversal of 20261107082500_pay_team_invite_links.sql
--
-- Drops the link hash and lifetime of email invitations: an invitation already mailed can then only be accepted from
-- the Invitations list after the person confirms that address, as before. The trail keeps every row; `resent` rows
-- would break the old action check, so the reversal refuses while any exist.
--   SELECT count(*)::int FROM pay.merchant_team_events WHERE action = 'resent';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "pay"."merchant_team_events" WHERE "action" = 'resent') THEN
    RAISE EXCEPTION 'merchant_team_events holds resent rows, which the append-only trail keeps; this reversal cannot drop them';
  END IF;
END $$;

ALTER TABLE "pay"."merchant_team_events" DROP CONSTRAINT IF EXISTS "merchant_team_events_action_ck";
ALTER TABLE "pay"."merchant_team_events"
  ADD CONSTRAINT "merchant_team_events_action_ck"
  CHECK ("action" IN ('invited', 'accepted', 'role_changed', 'removed', 'declined'));

ALTER TABLE "pay"."merchant_team_members"
  DROP COLUMN IF EXISTS "invite_link_hash",
  DROP COLUMN IF EXISTS "invite_expires_at";
