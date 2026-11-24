-- Reversal of 0019_outbox_amount_string.sql.
--
-- STEP 1 raised rather than writing, so it has nothing to reverse: no payload
-- was rewritten on the way in, so none has to be restored here.
--
-- Going back widens what the table accepts, to the 0013 object-and-array
-- check. A missing entries key is NULL under that check, and CHECK accepts
-- NULL. No row is rewritten. The loss is the amount-string backstop.
ALTER TABLE "ledger"."ledger_tx_outbox" DROP CONSTRAINT IF EXISTS "ledger_tx_outbox_amount_string_ck";
ALTER TABLE "ledger"."ledger_tx_outbox" ADD CONSTRAINT "ledger_tx_outbox_amount_string_ck"
  CHECK (jsonb_typeof(payload) = 'object' AND jsonb_typeof(payload->'entries') = 'array');
