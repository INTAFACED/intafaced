DROP TABLE IF EXISTS "bank"."activity_disputes";
DROP TABLE IF EXISTS "bank"."activity_note_commands";
DROP TABLE IF EXISTS "bank"."activity_notes";
DROP TABLE IF EXISTS "bank"."transfer_messages";
ALTER TABLE "bank"."personal_transfers" DROP CONSTRAINT IF EXISTS "personal_transfers_reference_ck";
ALTER TABLE "bank"."personal_transfers" DROP COLUMN IF EXISTS "reference";
