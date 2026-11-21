import {
  QUANT_EQUITY_STOP_POLICIES,
  QUANT_RISK_CAPS,
  type QuantEquityStopPolicy,
  type QuantRiskCap,
  type QuantRiskCaps,
  type QuantRiskScreen,
} from '@intafaced/contracts';
import { formatAmount, parseAmount } from '@intafaced/ledger-client/money';
import { QUANT_RISK_CAP_INVALID, QUANT_RISK_CAP_UNSET, QuantError } from '../errors.js';
import { BLANK_CAPS, type StoredRisk } from './repository.js';

/** What each cap is called on a refusal, as the risk screen labels it. */
export const RISK_CAP_NAMES: Record<QuantRiskCap, string> = {
  depositPercent: 'Deposit-percentage cap',
  maxPositionNotional: 'Position notional cap',
  maxDailyLoss: 'Daily loss cap',
  equityFloor: 'Equity-stop floor',
};

const DECIMAL = /^\d{1,18}(\.\d{1,18})?$/;
const HUNDRED = parseAmount('100');
/** Below the floor the strategy is reduce-only unless the developer chose close-out as well (journey step words). */
export const DEFAULT_FLOOR_POLICY: QuantEquityStopPolicy = 'reduce_only';

/**
 * The caps as the developer typed them, checked. Blank stays blank (null) and is never filled in; anything else must be a
 * decimal above 0, and the deposit percentage at most 100. One that does not read refuses by name and nothing is saved.
 */
export function checkCaps(
  input: Record<QuantRiskCap, string>,
  policy: string,
): { caps: QuantRiskCaps; floorPolicy: QuantEquityStopPolicy } {
  const caps: Record<QuantRiskCap, string | null> = { ...BLANK_CAPS };
  for (const name of QUANT_RISK_CAPS) {
    const text = input[name].trim();
    if (!text) continue;
    const value = DECIMAL.test(text) ? parseAmount(text) : 0n;
    if (value <= 0n) throw new QuantError(QUANT_RISK_CAP_INVALID, `${RISK_CAP_NAMES[name]} — must be an amount above 0, or blank`);
    if (name === 'depositPercent' && value > HUNDRED) {
      throw new QuantError(QUANT_RISK_CAP_INVALID, `${RISK_CAP_NAMES[name]} — a percentage of the deposit, at most 100`);
    }
    caps[name] = formatAmount(value);
  }
  const chosen = policy.trim();
  if (chosen && !(QUANT_EQUITY_STOP_POLICIES as readonly string[]).includes(chosen)) {
    throw new QuantError(QUANT_RISK_CAP_INVALID, `floor policy — choose one of ${QUANT_EQUITY_STOP_POLICIES.join(', ')}`);
  }
  return { caps, floorPolicy: chosen ? (chosen as QuantEquityStopPolicy) : DEFAULT_FLOOR_POLICY };
}

/** The caps still blank, in screen order. */
export function unsetCaps(caps: QuantRiskCaps): QuantRiskCap[] {
  return QUANT_RISK_CAPS.filter((name) => caps[name] === null);
}

/**
 * Turning the switch on: every cap must be set; a refusal names each blank one and the switch stays off.
 */
export function checkTradingOn(stored: StoredRisk | null): void {
  const blank = unsetCaps(stored?.caps ?? BLANK_CAPS).map((name) => RISK_CAP_NAMES[name]);
  if (blank.length) {
    throw new QuantError(QUANT_RISK_CAP_UNSET, `trading stays off — still blank: ${blank.join(', ')}`);
  }
}

/** The screen as the developer reads it. The switch is on only for the version it was turned on for. */
export function riskScreenOf(strategyId: string, latestVersion: number, stored: StoredRisk | null): QuantRiskScreen {
  const caps = stored?.caps ?? BLANK_CAPS;
  const version = stored?.tradingVersion ?? null;
  return {
    strategyId,
    caps: { ...caps },
    floorPolicy: stored?.floorPolicy ?? DEFAULT_FLOOR_POLICY,
    unset: unsetCaps(caps),
    trading: { on: version === latestVersion, version, offByNewVersion: version !== null && version !== latestVersion },
    latestVersion,
    updatedAt: stored?.updatedAt ?? null,
  };
}
