-- The owner's unsupported-case list per deposit pair (W-deposit-03, J-wallet-02 #2): the cases custody will not credit on this
-- network (for example a send from a smart contract), shown to the customer before any address. Empty means the owner published
-- none, and the customer sees only the standard wrong-network line; nothing is made up for a pair.
--
-- The table holds the contract's own rule (`payCustodyDepositEntrySchema`): at most 20 cases, each written once, trimmed and 1 to
-- 280 characters, so no row can make the catalogue svc-bank reads fail to parse.
CREATE OR REPLACE FUNCTION "pay"."deposit_unsupported_cases_ok"(cases text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT cardinality(cases) <= 20
     AND NOT EXISTS (
           SELECT 1 FROM unnest(cases) AS c
            WHERE c IS NULL OR c ~ '^\s|\s$' OR length(c) NOT BETWEEN 1 AND 280)
     AND (SELECT count(DISTINCT c) FROM unnest(cases) AS c) = cardinality(cases)
$$;
ALTER TABLE "pay"."custody_deposit_settings" ADD COLUMN IF NOT EXISTS "unsupported_cases" text[] NOT NULL DEFAULT '{}';
ALTER TABLE "pay"."custody_deposit_settings"
  ADD CONSTRAINT "custody_deposit_settings_unsupported_cases_ck" CHECK ("pay"."deposit_unsupported_cases_ok"("unsupported_cases"));
