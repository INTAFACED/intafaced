-- intafaced:destructive — reversal of 0028_founder_invites_used.sql; forgets which founder invites were spent, so a rolled-back deployment must also unset IDENTITY_FOUNDER_INVITE_HASHES.
DROP TABLE IF EXISTS "identity"."founder_invites_used";
DROP FUNCTION IF EXISTS "identity"."founder_invites_used_immutable"();
