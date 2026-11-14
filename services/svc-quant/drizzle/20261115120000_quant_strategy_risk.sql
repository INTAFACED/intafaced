-- svc-quant · a strategy's risk screen (AL-risk-01)
-- Reversal: 20261115120000_quant_strategy_risk.down.sql
--
-- No money, no balance, no ledger post. One row per strategy: the developer's own caps (null is blank, never assumed),
-- the equity-stop floor's policy, and the version the trading switch was last turned on for. The switch reads on only
-- while that version is the strategy's newest, so any new version turns it off again without a second write.

CREATE TABLE IF NOT EXISTS "quant"."strategy_risk" (
  "account_id"            uuid NOT NULL,
  "strategy_id"           text NOT NULL,
  "deposit_percent"       numeric(38, 18),
  "max_position_notional" numeric(38, 18),
  "max_daily_loss"        numeric(38, 18),
  "equity_floor"          numeric(38, 18),
  "floor_policy"          text,
  "trading_version"       integer,
  "updated_at"            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("account_id", "strategy_id"),
  CONSTRAINT "strategy_risk_policy_ck" CHECK ("floor_policy" IS NULL OR "floor_policy" IN ('reduce_only', 'close_out')),
  CONSTRAINT "strategy_risk_version_ck" CHECK ("trading_version" IS NULL OR "trading_version" >= 1)
);
