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
    /**
     * EFFECTIVE market-order slippage cap in basis points: the operator cap when
     * it is an integer, else the owner env `TRADE_MARKET_SLIPPAGE_CAP_BPS`, else
     * "not set" — the same precedence the order path enforces.
     */
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

/** Range the order path accepts for a market-buy cap (`requireMarketSlippageCapBps`, spot/risk.ts). */
const SLIPPAGE_CAP_MIN_BPS = 1;
const SLIPPAGE_CAP_MAX_BPS = 5000;

function honouredCapBps(bps: number): boolean {
  return Number.isInteger(bps) && bps >= SLIPPAGE_CAP_MIN_BPS && bps <= SLIPPAGE_CAP_MAX_BPS;
}

/**
 * Mirrors `requireMarketSlippageCapBps(operatorSlippageCapBps(...) ?? marketSlippageCapBps)`
 * in the order path. A cap the order path would refuse (non-integer, outside
 * 1–5000) is never published as an effective cap: "not set" instead.
 */
export function effectiveSlippageCapBps(risk: RiskVersion | null, envCapBps: number | null): PairRuleValue {
  if (risk?.slippageCap != null) {
    const bps = Number(risk.slippageCap);
    if (Number.isInteger(bps)) return honouredCapBps(bps) ? String(bps) : PAIR_RULE_NOT_SET;
  }
  return envCapBps == null || !honouredCapBps(envCapBps) ? PAIR_RULE_NOT_SET : String(envCapBps);
}

export function presentPairRules(market: Market, risk: RiskVersion | null, envSlippageCapBps: number | null = null): PairRules {
  return {
    tick: formatAmount(market.tickSize),
    lot: formatAmount(market.lotSize),
    minQty: formatAmount(market.minQty),
    minNotional: formatAmount(market.minNotional),
    maxQty: market.maxQty === null ? PAIR_RULE_NOT_SET : formatAmount(market.maxQty),
    protection: {
      collar: orNotSet(risk?.collar ?? null),
      fatFinger: orNotSet(risk?.fatFinger ?? null),
      slippageCapBps: effectiveSlippageCapBps(risk, envSlippageCapBps),
      openOrdersPerMarket: orNotSet(risk?.throttle ?? null),
    },
    riskVersion: risk?.version ?? '0',
  };
}

/** Refusal code the order path throws for every order while the operator circuit breaker is set. */
export const PAIR_HALT_CIRCUIT_BREAKER_CODE = 'trade.circuit_breaker_reference_unset' as const;

/**
 * SP-order-entry-03 review fix: whether the pair currently accepts orders under
 * its operator circuit breaker. Read from the same approved operator risk row
 * `assertOperatorRiskOnPlace` (admin/risk.ts) enforces: a set circuit breaker
 * has no reference mark yet, so it refuses EVERY order. Published beside
 * `pairRules` so a halted pair never looks tradable.
 */
export interface PairHalt {
  /** Operator circuit-breaker value, or "not set". */
  readonly circuitBreaker: PairRuleValue;
  /** True when the order path refuses every order on this pair. */
  readonly refusesAllOrders: boolean;
  /** The refusal code an order gets while halted; null when not halted. */
  readonly refusalCode: typeof PAIR_HALT_CIRCUIT_BREAKER_CODE | null;
  /** Operator risk version this was read from; "0" when none was ever approved. */
  readonly riskVersion: string;
}

export function presentPairHalt(risk: RiskVersion | null): PairHalt {
  const set = risk?.circuitBreaker != null;
  return {
    circuitBreaker: set ? (risk!.circuitBreaker as string) : PAIR_RULE_NOT_SET,
    refusesAllOrders: set,
    refusalCode: set ? PAIR_HALT_CIRCUIT_BREAKER_CODE : null,
    riskVersion: risk?.version ?? '0',
  };
}

/** Rules and halt state for one market, from one operator risk row. */
export interface PairRisk {
  readonly rules: PairRules;
  readonly halt: PairHalt;
}

export function presentPairRisk(market: Market, risk: RiskVersion | null, envSlippageCapBps: number | null = null): PairRisk {
  return { rules: presentPairRules(market, risk, envSlippageCapBps), halt: presentPairHalt(risk) };
}
