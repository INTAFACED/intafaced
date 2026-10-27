-- earn.interestHistory (J-bank-07 #5) finds one person's paid days by containment on the stored plan.
CREATE INDEX IF NOT EXISTS interest_accruals_planned_payouts_idx ON bank.interest_accruals USING gin (planned_payouts jsonb_path_ops);
