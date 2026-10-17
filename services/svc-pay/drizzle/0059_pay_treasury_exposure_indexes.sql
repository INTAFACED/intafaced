-- W5 treasury exposure reads the payout admission book (pay.payout_admissions and
-- its outcomes) directly; it keeps no balance of its own. These indexes keep the
-- "pending payouts per asset" sum and the "latest rail results" streak read cheap.
CREATE INDEX pay_payout_admissions_asset_idx ON pay.payout_admissions (asset_id);
CREATE INDEX pay_payout_admissions_rail_idx ON pay.payout_admissions (rail_id);
