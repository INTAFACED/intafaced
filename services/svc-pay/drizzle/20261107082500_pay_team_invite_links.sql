-- J-merchant-11 #1 #2: an emailed team invitation carries a link that runs out, and a resend replaces it.
-- Reversal: see the .down.sql beside this file.
--
-- An email invitation stores only the SHA-256 of its link code, never the code: the code is in the mail alone. A resend
-- writes a new hash, so the old link no longer matches and is refused. `invite_expires_at` is when the link and the
-- invitation stop working (the published PAY_TEAM_EMAIL_INVITE_TTL_MS after it was sent); an account-ID invitation
-- keeps it NULL and never expires. `resent` joins the append-only trail.

ALTER TABLE "pay"."merchant_team_members"
  ADD COLUMN IF NOT EXISTS "invite_link_hash" text,
  ADD COLUMN IF NOT EXISTS "invite_expires_at" timestamptz;

ALTER TABLE "pay"."merchant_team_events" DROP CONSTRAINT IF EXISTS "merchant_team_events_action_ck";
ALTER TABLE "pay"."merchant_team_events"
  ADD CONSTRAINT "merchant_team_events_action_ck"
  CHECK ("action" IN ('invited', 'accepted', 'role_changed', 'removed', 'declined', 'resent'));
