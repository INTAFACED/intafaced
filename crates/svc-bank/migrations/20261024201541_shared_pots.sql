-- Shared pots (BK-acct-09, J-bank-07 #6): the owner of a named pot invites another person by handle or email to see it
-- (viewer) or to add money to it (contributor). An invite lasts the owner-set BANK_SHARED_POT_INVITE_MINUTES from when it
-- was made, on the database clock; accepting it later refuses bank.invite_expired. Membership only decides who may
-- read the pot and call a move; it is never a balance. The pot's money stays the owner's ledger account, and every
-- move into it is the same bankTransfer as before. Who did what to a shared pot is a row in its activity log.
-- Reversal: the matching .down.sql

CREATE TABLE IF NOT EXISTS "bank"."shared_pot_invites" (
  -- The caller's own request id: asking again with it returns the same invite.
  "id" uuid PRIMARY KEY,
  "space_id" uuid NOT NULL REFERENCES "bank"."spaces" ("id"),
  "inviter_user_id" text NOT NULL,
  "invitee_user_id" text NOT NULL,
  "role" text NOT NULL CONSTRAINT "shared_pot_invites_role_ck" CHECK ("role" IN ('contributor', 'viewer')),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "expires_at" timestamptz NOT NULL,
  -- Set once: the invitee accepts or declines, or the owner cancels. None, and past expires_at, is an expired invite.
  "accepted_at" timestamptz,
  "declined_at" timestamptz,
  "cancelled_at" timestamptz,
  CONSTRAINT "shared_pot_invites_answer_ck" CHECK (num_nonnulls("accepted_at", "declined_at", "cancelled_at") <= 1),
  CONSTRAINT "shared_pot_invites_expiry_ck" CHECK ("expires_at" > "created_at")
);
CREATE INDEX IF NOT EXISTS "shared_pot_invites_invitee_idx" ON "bank"."shared_pot_invites" ("invitee_user_id", "created_at");
CREATE INDEX IF NOT EXISTS "shared_pot_invites_space_idx" ON "bank"."shared_pot_invites" ("space_id", "created_at");

CREATE TABLE IF NOT EXISTS "bank"."shared_pot_members" (
  "space_id" uuid NOT NULL REFERENCES "bank"."spaces" ("id"),
  "user_id" text NOT NULL,
  "role" text NOT NULL CONSTRAINT "shared_pot_members_role_ck" CHECK ("role" IN ('contributor', 'viewer')),
  "invite_id" uuid NOT NULL REFERENCES "bank"."shared_pot_invites" ("id"),
  "joined_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("space_id", "user_id")
);
CREATE INDEX IF NOT EXISTS "shared_pot_members_user_idx" ON "bank"."shared_pot_members" ("user_id");

CREATE TABLE IF NOT EXISTS "bank"."shared_pot_activity" (
  "id" bigserial PRIMARY KEY,
  "space_id" uuid NOT NULL REFERENCES "bank"."spaces" ("id"),
  -- Who acted, and who it was about (the invitee, the person removed); never a balance.
  "actor_user_id" text NOT NULL,
  "subject_user_id" text,
  "kind" text NOT NULL CONSTRAINT "shared_pot_activity_kind_ck" CHECK ("kind" IN ('invited', 'cancelled', 'joined', 'declined', 'left', 'removed')),
  "role" text,
  "at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "shared_pot_activity_space_idx" ON "bank"."shared_pot_activity" ("space_id", "id");
