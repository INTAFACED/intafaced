-- intafaced:destructive drops trusted_by; devices stay trusted, how they were trusted is forgotten.
ALTER TABLE "identity"."trusted_devices" DROP CONSTRAINT IF EXISTS "trusted_devices_trusted_by_check";
ALTER TABLE "identity"."trusted_devices" DROP COLUMN IF EXISTS "trusted_by";
