import type { QuantEquityStopPolicy, QuantRiskCaps } from '@intafaced/contracts';

/** A strategy's stored risk screen (AL-risk-01). A cap is a decimal string, or null while blank. Holds no balance. */
export interface StoredRisk {
  readonly caps: QuantRiskCaps;
  readonly floorPolicy: QuantEquityStopPolicy | null;
  /** The version the trading switch was last turned on for; null when it is off or never was on. */
  readonly tradingVersion: number | null;
  readonly updatedAt: string;
}

export interface RiskRepository {
  get(input: { readonly accountId: string; readonly strategyId: string }): Promise<StoredRisk | null>;
  /** Saves the caps and the floor policy; the trading switch is left as it was. */
  saveCaps(input: {
    readonly accountId: string;
    readonly strategyId: string;
    readonly caps: QuantRiskCaps;
    readonly floorPolicy: QuantEquityStopPolicy | null;
  }): Promise<StoredRisk>;
  /** Turns the switch on for one version, or off (null). The caps are left as they were. */
  setTrading(input: { readonly accountId: string; readonly strategyId: string; readonly version: number | null }): Promise<StoredRisk>;
}

export const BLANK_CAPS: QuantRiskCaps = { depositPercent: null, maxPositionNotional: null, maxDailyLoss: null, equityFloor: null };
