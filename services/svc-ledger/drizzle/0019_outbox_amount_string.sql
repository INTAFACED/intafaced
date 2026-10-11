-- svc-ledger · outbox amounts are decimal strings
-- Reversal: 0019_outbox_amount_string.down.sql
--
-- THE DEFECT
--
-- 0013 named `ledger_tx_outbox_amount_string_ck` and required only that payload
-- be a JSON object and payload.entries be an array. A missing `entries` key
-- makes `jsonb_typeof(payload->'entries')` NULL, and CHECK accepts NULL. A raw
-- insert can store a JSON number amount or an entry-less payload. Application
-- code refuses a JSON number; the named constraint did not.
--
-- 0013 will not re-run on a book that already applied it. This file replaces
-- the constraint. Postgres forbids subqueries in CHECK, so the amount rule is
-- `jsonb_path_query_array` (immutable), not `jsonb_array_elements`.
--
-- Amounts are decimal strings: optional minus, digits, optional fraction.
-- No magnitude cap is stated here. An empty entries array has no amount to be
-- a number and passes. A JSON number, a non-decimal string, or a missing
-- entries key fails.
--
-- STEP 1 · REFUSE. There is no honest rewrite of a stored amount. A JSON
-- number is not a decimal string, and deleting the row would drop publish
-- intent for a movement already in the journal. Name the rows and stop.
-- Precedent: 0005 STEP 3, 0006 STEP 1, 0008 STEP 1, 0009 STEP 1.

DO $$
DECLARE
  offenders text;
  n bigint;
BEGIN
  SELECT count(*), string_agg(format('%s tx_id=%s', "id", "tx_id"), E'\n  ')
    INTO n, offenders
    FROM "ledger"."ledger_tx_outbox"
   WHERE NOT (
     jsonb_typeof(payload) = 'object' AND jsonb_exists(payload, 'entries') AND jsonb_typeof(payload -> 'entries') = 'array' AND jsonb_array_length(jsonb_path_query_array(payload, '$.entries[*] ? (!(@.type() == "object" && exists(@.amount) && @.amount.type() == "string" && @.amount like_regex "^-?[0-9]+([.][0-9]+)?$"))')) = 0
   );

  IF n > 0 THEN
    RAISE EXCEPTION
      E'Cannot apply 0017: % ledger_tx_outbox row(s) store a payload with no entries array or an amount that is not a decimal string.\n  %\n\n'
      'A JSON number is not money. This migration will not rewrite or delete those rows — that would either forge an amount or drop the publish intent for a movement already in the journal. Repair each payload by hand, then re-run.',
      n, offenders;
  END IF;
END $$;

-- STEP 2 · The named constraint checks amounts.
ALTER TABLE "ledger"."ledger_tx_outbox" DROP CONSTRAINT IF EXISTS "ledger_tx_outbox_amount_string_ck";
ALTER TABLE "ledger"."ledger_tx_outbox" ADD CONSTRAINT "ledger_tx_outbox_amount_string_ck"
  CHECK (jsonb_typeof(payload) = 'object' AND jsonb_exists(payload, 'entries') AND jsonb_typeof(payload -> 'entries') = 'array' AND jsonb_array_length(jsonb_path_query_array(payload, '$.entries[*] ? (!(@.type() == "object" && exists(@.amount) && @.amount.type() == "string" && @.amount like_regex "^-?[0-9]+([.][0-9]+)?$"))')) = 0);
