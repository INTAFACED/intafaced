-- The owner's unsupported-case list per deposit pair (W-deposit-03, J-wallet-02 #2): the cases custody will not credit on this
-- network (for example a send from a smart contract), shown to the customer before any address. Empty means the owner published
-- none, and the customer sees only the standard wrong-network line; nothing is made up for a pair.
ALTER TABLE "pay"."custody_deposit_settings" ADD COLUMN IF NOT EXISTS "unsupported_cases" text[] NOT NULL DEFAULT '{}';
ALTER TABLE "pay"."custody_deposit_settings"
  ADD CONSTRAINT "custody_deposit_settings_unsupported_cases_ck" CHECK (
    cardinality("unsupported_cases") <= 20 AND array_position("unsupported_cases", NULL) IS NULL
  );
