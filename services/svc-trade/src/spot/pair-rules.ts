/**
 * SP-order-entry-03 (J-cex-spot-04 steps 2-6, read half): the pair rules a
 * trader is told in words before sending an order. Each value comes from the
 * listing row or the latest approved operator risk version
 * (`trade.operator_risk_limits`). A blank value is the literal "not set", never
 * a guessed number, so a screen can say so instead of showing a default.
 */
import { formatAmount } from '@intafaced/ledger-client';
import type { RiskVersion } from '../admin/risk.js';
import type { Market } from './types.js';

export const PAIR_RULE_NOT_SET = 'not set' as const;
export type PairRuleValue = string | typeof PAIR_RULE_NOT_SET;

export interface PairRules {
  readonly tick: string;
  readonly lot: string;
  readonly minQty: string;
  readonly minNotional: string;
  readonly maxQty: PairRuleValue;
  readonly protection: {
    /** Highest accepted limit price (operator collar). */
    readonly collar: PairRuleValue;
    /** Largest accepted order value (operator fat-finger limit). */
    readonly fatFinger: PairRuleValue;
    /** Market-order slippage cap in basis points. */
    readonly slippageCapBps: PairRuleValue;
    /** Open orders one account may hold on this market. */
    readonly openOrdersPerMarket: PairRuleValue;
  };
  /** Operator risk version the protection values were read from; "0" when none was ever approved. */
  readonly riskVersion: string;
}

function orNotSet(value: string | null): PairRuleValue {
  return value == null ? PAIR_RULE_NOT_SET : value;
}

export function presentPairRules(market: Market, risk: RiskVersion | null): PairRules {
  return {
    tick: formatAmount(market.tickSize),
    lot: formatAmount(market.lotSize),
    minQty: formatAmount(market.minQty),
    minNotional: formatAmount(market.minNotional),
    maxQty: market.maxQty === null ? PAIR_RULE_NOT_SET : formatAmount(market.maxQty),
    protection: {
      collar: orNotSet(risk?.collar ?? null),
      fatFinger: orNotSet(risk?.fatFinger ?? null),
      slippageCapBps: orNotSet(risk?.slippageCap ?? null),
      openOrdersPerMarket: orNotSet(risk?.throttle ?? null),
    },
    riskVersion: risk?.version ?? '0',
  };
}
