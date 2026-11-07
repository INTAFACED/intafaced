import { getAddress } from 'viem';
import { z } from 'zod';
import { envTransform } from '../order/trigger-settings.js';
import type { OrderPair } from './model.js';

/**
 * The order vault's owner settings (D-limit-dca-01 to -04). Blank stays blank: no node, vault or keeper means every
 * keeper action reads rail.crypto; no pair refuses `dex.order.pair_unset`; no trailing bounds refuse
 * `dex.order.trail_bounds_unset`. Nothing here invents a pool, an address or a distance.
 */
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const tokenSchema = z.object({
  address,
  symbol: z.string().min(1).max(32),
  decimals: z.number().int().min(0).max(36),
  /** The token's full name, where a page names it whole ("TEST Token A"); the symbol otherwise. */
  name: z.string().min(1).max(64).optional(),
});
const pairSchema = z.object({ base: tokenSchema, quote: tokenSchema, pool: address });

export function parsePairs(raw: string): OrderPair[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('DEX_ORDER_PAIRS is not JSON');
  }
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('DEX_ORDER_PAIRS must be a non-empty JSON array');
  return parsed.map((row, i) => {
    let pair: z.infer<typeof pairSchema>;
    try {
      pair = pairSchema.parse(row);
    } catch {
      throw new Error(`DEX_ORDER_PAIRS[${i}] must be { base, quote, pool } with tokens { address, symbol, decimals }`);
    }
    return {
      base: { ...pair.base, address: getAddress(pair.base.address) },
      quote: { ...pair.quote, address: getAddress(pair.quote.address) },
      pool: getAddress(pair.pool),
    };
  });
}

/** `min,max` in basis points, each 1..9999 and min <= max. */
export function parseTrailBounds(raw: string): { min: number; max: number } {
  const parts = raw.split(',').map((p) => p.trim());
  const [min, max] = parts.map(Number);
  if (parts.length !== 2 || !Number.isInteger(min) || !Number.isInteger(max) || min! < 1 || max! > 9999 || min! > max!)
    throw new Error('DEX_ORDER_TRAIL_BOUNDS_BPS must be "min,max" whole basis points from 1 to 9999');
  return { min: min!, max: max! };
}

const addressField = (name: string) =>
  envTransform(name, (raw) => {
    if (!/^0x[0-9a-fA-F]{40}$/.test(raw.trim())) throw new Error(`${name} must be a 20-byte 0x address`);
    return getAddress(raw.trim());
  });

export const dexOrderPairsField = envTransform('DEX_ORDER_PAIRS', parsePairs);
export const dexOrderTrailBoundsField = envTransform('DEX_ORDER_TRAIL_BOUNDS_BPS', parseTrailBounds);
export const dexOrderVaultField = addressField('DEX_ORDER_VAULT_ADDRESS');
export const dexOrderKeeperField = addressField('DEX_ORDER_KEEPER_ADDRESS');
/** The recurring buy vault (D-limit-dca-05). Blank: recurring buys are unwired and refuse `dex.recurring.unwired`. */
export const dexRecurringVaultField = addressField('DEX_RECURRING_ADDRESS');
/** Seconds a round outside its price band is retried before it moves to the next interval. NO DEFAULT. */
export const dexRecurringRetryWindowField = envTransform('DEX_RECURRING_RETRY_WINDOW_SECONDS', (raw) => {
  const n = Number(raw.trim());
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error('DEX_RECURRING_RETRY_WINDOW_SECONDS must be a positive whole number of seconds');
  return n;
});
export const dexOrderRpcField = envTransform('DEX_ORDER_RPC_URL', (raw) => new URL(raw.trim()).toString().replace(/\/$/, ''));
export const dexOrderChainIdField = envTransform('DEX_ORDER_CHAIN_ID', (raw) => {
  const n = Number(raw.trim());
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error('DEX_ORDER_CHAIN_ID must be a positive integer');
  return n;
});
