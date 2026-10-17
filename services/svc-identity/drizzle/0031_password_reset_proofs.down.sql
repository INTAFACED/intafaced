-- intafaced:destructive — reversal of 0031_password_reset_proofs.sql; drops outstanding password-reset proofs.
DROP TABLE IF EXISTS "identity"."password_reset_proofs";
