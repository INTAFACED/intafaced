-- Reversal of the matching up migration: published upload rules are no longer bounded by the HTTP body limits.

ALTER TABLE "pay"."kyb_upload_rules" DROP CONSTRAINT IF EXISTS "kyb_upload_rules_max_bytes_fits_transport";
