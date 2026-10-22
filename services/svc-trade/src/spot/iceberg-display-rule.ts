import type { Amount } from '@intafaced/ledger-client';
import { TradeError } from './types.js';
const TRADE_ICEBERG_DISPLAY_INVALID = 'trade.iceberg_display_invalid' as const;

/** SP-conditional-algo-03: the owner has not published a minimum iceberg display ratio. */
export const TRADE_ICEBERG_DISPLAY_RULE_UNSET = 'trade.iceberg_display_rule_unset' as const;

/** Owner minimum display ratio, display / total >= numerator / denominator. */
export interface IcebergDisplayRule {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

/**
 * Parse `TRADE_ICEBERG_MIN_DISPLAY_RATIO` ("<n>/<d>", positive integers, n < d).
 * Blank → null (every iceberg then refuses `trade.iceberg_display_rule_unset`).
 * Anything else throws, so the service fails at boot. No default is invented.
 */
export function parseIcebergDisplayRule(raw: string | undefined): IcebergDisplayRule | null {
  const text = (raw ?? '').trim();
  if (text === '') return null;
  const match = /^([1-9]\d{0,17})\/([1-9]\d{0,17})$/.exec(text);
  if (!match) throw new Error(`TRADE_ICEBERG_MIN_DISPLAY_RATIO must be "<n>/<d>" with positive integers, got "${text}"`);
  const numerator = BigInt(match[1]!);
  const denominator = BigInt(match[2]!);
  if (numerator >= denominator) {
    throw new Error(`TRADE_ICEBERG_MIN_DISPLAY_RATIO must be below 1, got "${text}"`);
  }
  return { numerator, denominator };
}

/** Refuse a display below the owner ratio; refuse every iceberg when the ratio is blank. */
export function assertIcebergDisplayRatio(rule: IcebergDisplayRule | null, qty: Amount, displayQty: Amount): void {
  if (rule === null) {
    throw new TradeError('the iceberg minimum display ratio is not set by the owner', TRADE_ICEBERG_DISPLAY_RULE_UNSET);
  }
  if ((displayQty as bigint) * rule.denominator < (qty as bigint) * rule.numerator) {
    throw new TradeError(
      `iceberg displayQty must be at least ${rule.numerator}/${rule.denominator} of the order quantity`,
      TRADE_ICEBERG_DISPLAY_INVALID,
    );
  }
}
