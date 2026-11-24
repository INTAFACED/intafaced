-- intafaced:destructive — reversal of 20261109094904_rail_payees_scam_warning.sql
ALTER TABLE "bank"."rail_payees" DROP COLUMN IF EXISTS "scam_warning_read_at";
