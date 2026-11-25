-- Drops payment reminder rules and the standing-order notice outbox. Nothing here moved value; notices already sent
-- stay in svc-notify's inbox, and an owed one is never sent.
DROP TABLE IF EXISTS "bank"."scheduled_notices";
DROP TABLE IF EXISTS "bank"."reminder_rules";
