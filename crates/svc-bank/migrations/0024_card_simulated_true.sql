-- cards.simulated can be set false. 0003 says false means a real card exists,
-- and no check keeps the flag true.
--
-- A new insert that sets simulated false is refused. An update that sets
-- simulated false is refused. An omitted simulated stays the default true.
-- An explicit true stores. NOT VALID because rows already stored may be the
-- old shape. A validating CHECK would fail this migration on them. New inserts
-- and updates are still refused. This file does not update or delete any row.
--
-- Reversal: 0024_card_simulated_true.down.sql

ALTER TABLE "bank"."cards" DROP CONSTRAINT IF EXISTS "cards_simulated_true";

ALTER TABLE "bank"."cards"
  ADD CONSTRAINT "cards_simulated_true"
  CHECK ("simulated" = true) NOT VALID;
