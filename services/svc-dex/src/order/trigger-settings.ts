/**
 * Owner-published bounds for price-trigger orders.
 * Blank is unset. Nothing here fills in a minimum, a list, a slippage, or a freshness window.
 */

import { MoneyError, parseAmount } from '@intafaced/ledger-client/money';
import { z } from 'zod';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/i;
const TIMER_MAX = 2_147_483_647;

export interface TriggerSettings {
  /** Scaled minimum `amountIn`. Unset refuses `dex.order.min_size_unset`. Explicit 0 is published. */
  readonly minSize?: bigint;
  /** Lowercased addresses. Unset refuses. An explicit empty list restricts nothing. */
  readonly restrictedTokens?: readonly string[];
  /** Warn tier. Unset means the tier is unpublished, not that every token is warned. */
  readonly warnTokens?: readonly string[];
  /** Owner default, basis points 0..10000. Unset refuses `dex.order.slippage_unset`. */
  readonly slippageBps?: number;
  /** Maximum age of a trigger price. Unset blocks the fill; it does not mean "fresh forever". */
  readonly oracleMaxAgeMs?: number;
}

export function blankEnv(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

export function parseMinSizeEnv(raw: string): bigint {
  let parsed: bigint;
  try {
    parsed = parseAmount(raw.trim());
  } catch (err) {
    if (err instanceof MoneyError) throw new Error('DEX_ORDER_MIN_SIZE must be a decimal string with at most 18 decimal places');
    throw err;
  }
  if (parsed < 0n) throw new Error('DEX_ORDER_MIN_SIZE cannot be negative');
  return parsed;
}

export function parseAddressListEnv(raw: string, name: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${name} is not a JSON array of addresses`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${name} is not a JSON array of addresses`);
  const out: string[] = [];
  for (const item of parsed) {
    if (typeof item !== 'string' || !ADDRESS.test(item)) {
      throw new Error(`${name} must be 0x addresses of 20 bytes`);
    }
    const lower = item.toLowerCase();
    if (!out.includes(lower)) out.push(lower);
  }
  return out;
}

/** Basis points are an integer on the closed range 0..10000. That is the unit, not a default. */
export function parseBpsEnv(raw: string, name: string): number {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) throw new Error(`${name} must be an integer from 0 to 10000`);
  const n = Number(trimmed);
  if (!Number.isSafeInteger(n) || n > 10_000) throw new Error(`${name} must be an integer from 0 to 10000`);
  return n;
}

/** A positive millisecond count the runtime can schedule. Blank is not turned into an interval. */
export function parsePositiveIntEnv(raw: string, name: string): number {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) throw new Error(`${name} must be a positive integer; blank does not start a timer`);
  const n = Number(trimmed);
  if (!Number.isSafeInteger(n) || n < 1 || n > TIMER_MAX) {
    throw new Error(`${name} must be a positive integer up to ${TIMER_MAX}; blank does not start a timer`);
  }
  return n;
}

function optionalString() {
  return z.preprocess((v) => (blankEnv(v) ? undefined : v), z.string().optional());
}

function envTransform<T>(name: string, parse: (raw: string) => T) {
  return optionalString().transform((raw, ctx) => {
    if (raw === undefined) return undefined;
    try {
      return parse(raw);
    } catch (err) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: err instanceof Error ? err.message : `${name} is invalid`,
      });
      return z.NEVER;
    }
  });
}

export const dexOrderMinSizeField = envTransform('DEX_ORDER_MIN_SIZE', parseMinSizeEnv);
export const dexOrderRestrictedTokensField = envTransform('DEX_ORDER_RESTRICTED_TOKENS', (raw) =>
  parseAddressListEnv(raw, 'DEX_ORDER_RESTRICTED_TOKENS'),
);
export const dexOrderWarnTokensField = envTransform('DEX_ORDER_WARN_TOKENS', (raw) => parseAddressListEnv(raw, 'DEX_ORDER_WARN_TOKENS'));
export const dexOrderSlippageField = envTransform('DEX_ORDER_SLIPPAGE_BPS', (raw) => parseBpsEnv(raw, 'DEX_ORDER_SLIPPAGE_BPS'));
export const dexOrderOracleMaxAgeField = envTransform('DEX_ORDER_ORACLE_MAX_AGE_MS', (raw) =>
  parsePositiveIntEnv(raw, 'DEX_ORDER_ORACLE_MAX_AGE_MS'),
);
export const dexOrderKeeperIntervalField = envTransform('DEX_ORDER_KEEPER_INTERVAL_MS', (raw) =>
  parsePositiveIntEnv(raw, 'DEX_ORDER_KEEPER_INTERVAL_MS'),
);
