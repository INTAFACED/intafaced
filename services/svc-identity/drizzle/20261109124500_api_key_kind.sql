-- J-developer-15 #5 (DV-keys-05): an API key is a person's own key or a key for an AI agent. An agent key is tagged on
-- the key list and restricted at create (no refund, payout, withdrawal or settings permission). Every existing key is a
-- person's own key.
ALTER TABLE "identity"."api_keys" ADD COLUMN IF NOT EXISTS "kind" text NOT NULL DEFAULT 'personal' CHECK ("kind" IN ('personal', 'agent'));
