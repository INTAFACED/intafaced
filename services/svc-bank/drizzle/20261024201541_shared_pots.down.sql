-- Reverses shared pots. Money added to a shared pot stays in the owner's pot under its own transfer keys.
DROP TABLE IF EXISTS "bank"."shared_pot_activity";
DROP TABLE IF EXISTS "bank"."shared_pot_members";
DROP TABLE IF EXISTS "bank"."shared_pot_invites";
