-- Reverses 20261116090000_business_payouts.sql. Refuses, changing nothing, while any bulk run or contractor batch reached
-- the partner, or any crypto payroll run was signed: dropping its row would erase the only record of an instruction the
-- partner carried out, or of what the business's wallet signed.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "bank"."business_bulk_runs" WHERE "partner_move_id" IS NOT NULL OR "status" = 'sending')
     OR EXISTS (SELECT 1 FROM "bank"."business_contractor_batches" WHERE "partner_move_id" IS NOT NULL OR "status" = 'sending')
     OR EXISTS (SELECT 1 FROM "bank"."business_crypto_payroll_runs" WHERE "status" = 'signed') THEN
    RAISE EXCEPTION 'business_payouts down: payouts reached the partner or a payroll run was signed; nothing was changed';
  END IF;
END
$$;

-- intafaced:destructive the bulk run, contractor and crypto payroll tables this migration added, with nothing the partner carried out or a wallet signed
DROP TABLE IF EXISTS "bank"."business_crypto_payslips";
DROP TABLE IF EXISTS "bank"."business_crypto_payroll_runs";
DROP TABLE IF EXISTS "bank"."business_crypto_payroll_members";
DROP TABLE IF EXISTS "bank"."business_crypto_payrolls";
DROP TABLE IF EXISTS "bank"."business_payroll_wallets";
DROP TABLE IF EXISTS "bank"."business_payroll_wallet_offers";
DROP TABLE IF EXISTS "bank"."business_contractor_invites";
DROP TABLE IF EXISTS "bank"."business_contractor_batch_approvals";
DROP TABLE IF EXISTS "bank"."business_contractor_batch_lines";
DROP TABLE IF EXISTS "bank"."business_contractor_batches";
DROP TABLE IF EXISTS "bank"."business_contractor_invoices";
DROP TABLE IF EXISTS "bank"."business_contractors";
DROP TABLE IF EXISTS "bank"."business_bulk_approvals";
DROP TABLE IF EXISTS "bank"."business_bulk_issues";
DROP TABLE IF EXISTS "bank"."business_bulk_lines";
DROP TABLE IF EXISTS "bank"."business_bulk_runs";
