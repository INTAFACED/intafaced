-- Reverse 0016_desk_groups.sql
-- Lossy by nature: groups, memberships, ticket placements and the log are dropped.
-- Visibility goes back to "every support:ops caller sees the queue".

DROP TABLE IF EXISTS "support"."group_log";
DROP TABLE IF EXISTS "support"."ticket_groups";
DROP TABLE IF EXISTS "support"."group_members";
DROP TABLE IF EXISTS "support"."groups";
