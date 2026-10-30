import { describe, expect, it } from 'vitest';
import type { ProtocolSwapPairs } from '@intafaced/contracts';
import { parseMinReserveUsd, parseUsdTokens, priceTokens, usdText } from './prices.js';

const A = '0x00000000000000000000000000000000000a11ce';
const B = '0x00000000000000000000000000000000000b0b00';
const THIN = '0x00000000000000000000000000000000000071a0';
const USD = '0x000000000000000000000000000000000000d011';
const LONE = '0x00000000000000000000000000000000000001e0';
const e = (n: string, d: number) => (BigInt(n) * 10n ** BigInt(d)).toString();
const pool = (pool: string, token0: string, token1: string, reserve0: string, reserve1: string) => ({
  pool,
  token0,
  token1,
  feeBps: 30,
  reserve0,
  reserve1,
  blockTimestampLast: 1,
});
const tokens = [
  { address: A, name: 'TEST Token A', symbol: 'A', decimals: 6 },
  { address: B, name: 'TEST Token B', symbol: 'B', decimals: 18 },
  { address: THIN, name: 'TEST Thin', symbol: 'T', decimals: 18 },
  { address: USD, name: 'TEST USD', symbol: 'U', decimals: 6 },
  { address: LONE, name: 'Lone', symbol: 'L', decimals: 18 },
];
const pairs = (pools: ProtocolSwapPairs['pools']): ProtocolSwapPairs => ({ factory: A, blockNumber: '9', tokens, pools, skipped: 0 });
const setting = { usdTokens: new Set([USD]), minReserveUsd: 1000n };

describe('priceTokens', () => {
  const book = pairs([
    pool('0x1', A, USD, e('500000', 6), e('500000', 6)),
    pool('0x2', B, USD, e('250000', 18), e('500000', 6)),
    pool('0x3', A, B, e('1000000', 6), e('1000000', 18)),
    pool('0x4', A, THIN, e('1', 3), e('1', 15)),
    pool('0x5', USD, B, e('10', 6), e('1', 18)),
  ]);
  const byAddress = Object.fromEntries(priceTokens(book, setting).map((price) => [price.address, price]));

  it('prices a token from its deepest pool against a reference, across decimals', () => {
    expect(byAddress[A]).toEqual({ address: A, usd: '1', basis: 'pool', reason: null });
    // B/USD 250,000 : 500,000 is 2 dollars; the 10-dollar USD/B pool is under the minimum and is not used.
    expect(byAddress[B]).toEqual({ address: B, usd: '2', basis: 'pool', reason: null });
  });

  it('counts a reference token as one dollar', () => {
    expect(byAddress[USD]).toEqual({ address: USD, usd: '1', basis: 'reference', reason: null });
  });

  it('gives no price, and says why, when every pool is under the minimum reserve or nothing leads to a dollar', () => {
    expect(byAddress[THIN]).toEqual({ address: THIN, usd: null, basis: null, reason: 'thin_reserve' });
    expect(byAddress[LONE]).toEqual({ address: LONE, usd: null, basis: null, reason: 'no_route' });
  });

  it('prices through one priced token when no reference pool exists', () => {
    const hop = priceTokens(
      pairs([pool('0x1', A, USD, e('500000', 6), e('500000', 6)), pool('0x9', LONE, A, e('1000', 18), e('4000', 6))]),
      setting,
    ).find((price) => price.address === LONE);
    expect(hop).toEqual({ address: LONE, usd: '4', basis: 'one_hop', reason: null });
  });
});

describe('price settings', () => {
  it('parse only what the owner wrote', () => {
    expect(parseUsdTokens('')).toBeNull();
    expect(parseUsdTokens(`${USD}, nope`)).toBeNull();
    expect(parseUsdTokens(` ${USD.toUpperCase().replace('0X', '0x')} `)).toEqual(new Set([USD]));
    expect(parseMinReserveUsd('')).toBeNull();
    expect(parseMinReserveUsd('0')).toBeNull();
    expect(parseMinReserveUsd('1.5')).toBeNull();
    expect(parseMinReserveUsd('1000')).toBe(1000n);
    expect(usdText(1_500_000_000_000_000_000n)).toBe('1.5');
  });
});
