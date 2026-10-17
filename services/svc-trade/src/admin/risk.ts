/**
 * Per-market operator limits. A null field is unset: the order path keeps the
 * refusal it already had for a blank limit and does not invent a number.
 */
import type { Sql } from 'postgres';
import { formatAmount, mul, parseAmount, type Amount } from '@intafaced/ledger-client';
import { TradeError } from '../spot/types.js';
import { exactDecimal, exactInteger, TradeOpsError } from './common.js';

export interface RiskLimits {
  readonly collar: string | null;
  readonly fatFinger: string | null;
  readonly slippageCap: string | null;
  readonly throttle: string | null;
  readonly circuitBreaker: string | null;
}

export interface RiskVersion extends RiskLimits {
  readonly marketId: string;
  readonly version: string;
  readonly operatorId: string;
  readonly approverId: string;
  readonly reason: string;
  readonly approvalId: string;
  readonly createdAt: string;
}

interface RiskRow {
  market_id: string;
  version: string;
  collar: string | null;
  fat_finger: string | null;
  slippage_cap: string | null;
  throttle: string | null;
  circuit_breaker: string | null;
  operator_id: string;
  approver_id: string;
  reason: string;
  approval_id: string;
  created_at: Date;
}

const EMPTY: RiskLimits = {
  collar: null,
  fatFinger: null,
  slippageCap: null,
  throttle: null,
  circuitBreaker: null,
};

function present(row: RiskRow): RiskVersion {
  return {
    marketId: row.market_id,
    version: row.version,
    collar: row.collar,
    fatFinger: row.fat_finger,
    slippageCap: row.slippage_cap,
    throttle: row.throttle,
    circuitBreaker: row.circuit_breaker,
    operatorId: row.operator_id,
    approverId: row.approver_id,
    reason: row.reason,
    approvalId: row.approval_id,
    createdAt: row.created_at.toISOString(),
  };
}

export function validateLimits(input: RiskLimits): RiskLimits {
  const collar = input.collar == null ? null : exactDecimal(input.collar, 'collar');
  const fatFinger = input.fatFinger == null ? null : exactDecimal(input.fatFinger, 'fatFinger');
  const slippageCap = input.slippageCap == null ? null : exactInteger(input.slippageCap, 'slippageCap');
  const throttle = input.throttle == null ? null : exactInteger(input.throttle, 'throttle');
  const circuitBreaker = input.circuitBreaker == null ? null : exactInteger(input.circuitBreaker, 'circuitBreaker');
  if (slippageCap != null) {
    const bps = Number(slippageCap);
    if (!Number.isInteger(bps) || bps < 1 || bps > 5000) {
      throw new TradeOpsError('risk_limit_not_exact', 'slippageCap must be an integer basis-point string from 1 to 5000');
    }
  }
  return { collar, fatFinger, slippageCap, throttle, circuitBreaker };
}

export async function currentRisk(sql: Sql, marketId: string): Promise<RiskVersion | null> {
  const [row] = await sql<RiskRow[]>`
    SELECT market_id, version::text, collar, fat_finger, slippage_cap, throttle, circuit_breaker,
           operator_id, approver_id, reason, approval_id, created_at
      FROM trade.operator_risk_limits
     WHERE market_id = ${marketId}
     ORDER BY version DESC
     LIMIT 1`;
  return row ? present(row) : null;
}

export async function riskHistory(sql: Sql, marketId: string): Promise<RiskVersion[]> {
  const rows = await sql<RiskRow[]>`
    SELECT market_id, version::text, collar, fat_finger, slippage_cap, throttle, circuit_breaker,
           operator_id, approver_id, reason, approval_id, created_at
      FROM trade.operator_risk_limits
     WHERE market_id = ${marketId}
     ORDER BY version ASC`;
  return rows.map(present);
}

export function riskView(marketId: string, row: RiskVersion | null): RiskLimits & { marketId: string; version: string } {
  return { marketId, version: row?.version ?? '0', ...(row ?? EMPTY) };
}

/**
 * Order-path gate. Unset fields do nothing. A set fat-finger, collar, or
 * throttle is enforced here. A set circuit breaker has no reference mark in
 * this path, so the order refuses rather than inventing a price. A set
 * slippage cap is applied by `operatorSlippageCapBps` at the existing cap site.
 */
export async function assertOperatorRiskOnPlace(
  sql: Sql,
  marketId: string,
  userId: string,
  input: { readonly price: Amount | null; readonly qty: Amount },
): Promise<void> {
  const limits = await currentRisk(sql, marketId);
  if (!limits) return;
  if (limits.fatFinger != null) {
    if (input.price == null) {
      throw new TradeError('fat-finger limit is set and this order has no price to value against it', 'trade.operator_fat_finger');
    }
    const notional = mul(input.price, input.qty, 'floor');
    if (notional > parseAmount(limits.fatFinger)) {
      throw new TradeError(
        `order notional ${formatAmount(notional)} exceeds the operator fat-finger limit ${limits.fatFinger}`,
        'trade.operator_fat_finger',
      );
    }
  }
  if (limits.collar != null && input.price != null && input.price > parseAmount(limits.collar)) {
    throw new TradeError(`order price exceeds the operator collar ${limits.collar}`, 'trade.operator_collar');
  }
  if (limits.throttle != null) {
    const [row] = await sql<Array<{ n: string }>>`
      SELECT count(*)::text AS n FROM trade.orders
       WHERE market_id = ${marketId} AND user_id = ${userId} AND status IN ('open', 'pending')`;
    if (BigInt(row?.n ?? '0') >= BigInt(limits.throttle)) {
      throw new TradeError('operator message throttle is already full for this account and market', 'trade.operator_throttle');
    }
  }
  if (limits.circuitBreaker != null) {
    throw new TradeError(
      'circuit breaker is set and no reference mark is configured (circuit_breaker_reference_unset)',
      'trade.circuit_breaker_reference_unset',
    );
  }
}

/** Integer bps from the latest operator row, or null when that field is blank. */
export async function operatorSlippageCapBps(sql: Sql, marketId: string): Promise<number | null> {
  const limits = await currentRisk(sql, marketId);
  if (limits?.slippageCap == null) return null;
  const bps = Number(limits.slippageCap);
  if (!Number.isInteger(bps)) return null;
  return bps;
}
