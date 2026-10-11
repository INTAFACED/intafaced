-- intafaced:destructive drops the constraint deliveries_delivered_ck, replaced in this
-- same migration by deliveries_accepted_ck. The guarantee is strengthened, not
-- relaxed: accepted_at may not be written on a failure, so an undelivered margin
-- call cannot be confused with one a transport took.
-- svc-notify · rename the outcome to what it can actually prove
-- Reversal: 0002_notify_delivery_accepted.down.sql
--
-- WHY A RENAME IS WORTH A MIGRATION
--
-- `delivered_at` was set the moment a gateway answered 2xx. A gateway answering
-- 2xx has taken custody of the message. It has NOT said the mail server took it,
-- that the handset was reachable, or that a human saw it — and this service
-- receives no delivery receipts, so it never learns any of those things.
--
-- The column therefore claimed more than the code could support, and the gap
-- between the two is the exact shape of the svc-bank bug found in audit: a
-- margin call stamped `notified_at` after a sink that delivered nothing, with
-- the liquidation grace clock running off the stamp. A word that gates somebody
-- else's collateral has to mean precisely what it says.
--
--   accepted_at   a transport accepted the message for delivery. The strongest
--                 true statement available here, and now the one being made.
--   attempted_at  we handed it to a transport. Unchanged.
--
-- There is deliberately no `delivered_at` left behind and no view restoring the
-- old name. A column that still reads "delivered" is a column somebody builds a
-- clock on.
--
-- Not destructive: no data is lost, the column and its values are renamed in
-- place, and the reversal renames them back.
--
-- The 0001 checks are still in force until they are dropped. deliveries_status_ck
-- does not allow 'accepted', and deliveries_delivered_ck still requires status
-- 'delivered' whenever the timestamp is set. Updating a delivered row first is
-- rejected, so both checks come off before any row is rewritten. The replacement
-- checks go on after the rewrite: they allow 'accepted', and accepted_at is set
-- if and only if status is 'accepted'. Adding that biconditional before the
-- UPDATE would reject the same delivered rows, which still say 'delivered'.

ALTER TABLE "notify"."deliveries" DROP CONSTRAINT IF EXISTS "deliveries_status_ck";
ALTER TABLE "notify"."deliveries" DROP CONSTRAINT IF EXISTS "deliveries_delivered_ck";

ALTER TABLE "notify"."deliveries" RENAME COLUMN "delivered_at" TO "accepted_at";

UPDATE "notify"."deliveries" SET "status" = 'accepted' WHERE "status" = 'delivered';

ALTER TABLE "notify"."deliveries" ADD CONSTRAINT "deliveries_status_ck"
  CHECK ("status" IN ('pending', 'accepted', 'refused', 'failed', 'abandoned'));

-- THE INVARIANT, ENFORCED BY THE DATABASE RATHER THAN BY EVERY CALLER:
--   accepted_at is set if and only if status = 'accepted'.
-- A bug that wrote accepted_at on a failure would make an undelivered margin
-- call indistinguishable from one a transport took, which is the exact failure
-- this table exists to prevent. So the database refuses the row.
ALTER TABLE "notify"."deliveries" DROP CONSTRAINT IF EXISTS "deliveries_accepted_ck";
ALTER TABLE "notify"."deliveries" ADD CONSTRAINT "deliveries_accepted_ck"
  CHECK (("status" = 'accepted') = ("accepted_at" IS NOT NULL));
