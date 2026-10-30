import { formatUnits } from 'viem';
import type { PoolToken } from './pools-api';
import type { PoolsTranslate } from './copy';

/** A raw amount in the token's own decimals; one that never said its decimals stays in base units, never guessed. */
export function tokenAmount(raw: string, token: PoolToken, t: PoolsTranslate): string {
  return token.decimals === null ? t('rawUnits', { amount: raw }) : formatUnits(BigInt(raw), token.decimals);
}

/** What the page calls a token: its symbol, else its address cut short. */
export function tokenSymbol(token: PoolToken): string {
  return token.symbol ?? `${token.address.slice(0, 8)}…`;
}

/** The pair as the chain names it: token0 / token1. */
export function pairName(token0: PoolToken, token1: PoolToken, t: PoolsTranslate): string {
  return t('pairName', { token0: tokenSymbol(token0), token1: tokenSymbol(token1) });
}

/** Basis points as a percent with two places, from whole numbers only (30 → "0.30"). */
export function bpsPercent(bps: number): string {
  return `${Math.trunc(bps / 100)}.${String(bps % 100).padStart(2, '0')}`;
}
