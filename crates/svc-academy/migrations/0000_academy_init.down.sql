-- intafaced:destructive — reversal of 0000_academy_init.sql
--
-- It exists so the migration is provably reversible in CI against a scratch
-- schema (§14). It must NEVER be run against a database with live users.
--
-- Nothing of anyone's MONEY is here to lose — this service holds none, and the
-- one money-shaped column (`rooms.min_stake`) is a threshold, not a balance.
-- What dies is the live layer: every room and its access terms, every
-- invitation that had been granted into an invite-only room, every scheduled
-- and past session, and the attendance record of who was in them.
--
-- The invitations are the part with no way back. A room's `access = 'invite'`
-- means the ONLY thing admitting anyone is a `room_invites` row; drop the table
-- and every invite-only lobby becomes a room nobody but its host can enter,
-- with no record of who was supposed to be able to. Re-creating them means
-- knowing who had been invited, and after this file nothing does.
--
-- The "academy" schema itself is left in place: the bootstrap owns it, not this
-- migration (§2), and this role has no DROP SCHEMA privilege anyway.

DROP TABLE IF EXISTS "academy"."session_attendees";
DROP TABLE IF EXISTS "academy"."sessions";
DROP TABLE IF EXISTS "academy"."room_invites";
DROP TABLE IF EXISTS "academy"."rooms";

DROP TYPE IF EXISTS "academy"."attendee_role";
DROP TYPE IF EXISTS "academy"."session_status";
DROP TYPE IF EXISTS "academy"."room_access";
DROP TYPE IF EXISTS "academy"."room_kind";
