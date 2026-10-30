-- J-identity-08 #7: a trading restriction keeps the owner-listed reason code staff chose, so the customer's account
-- status shows its words (IDENTITY_TRADING_RESTRICTION_REASONS). Null when staff gave none; a restore clears it.
ALTER TABLE "identity"."trading_restrictions" ADD COLUMN IF NOT EXISTS "reason_code" text;
