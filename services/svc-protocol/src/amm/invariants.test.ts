/**
 * S-A2 residual — invariant / property + LP accounting (do not rebuild AMM).
 *
 * Pure TypeScript mirror of ConstantProductPool maths. Proves:
 *   · k never decreases across a swap (fee-adjusted Uniswap V2 check)
 *   · round-trip swap extracts no free value
 *   · LP mint/burn pro-rata accounting + MINIMUM_LIQUIDITY lock
 *   · fee tier changes output (immutable fee is a constructor param in Solidity)
 *
 * On-chain mint/swapExactIn already proven (#288). audited stays false.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FEE_DENOM, getAmountOut } from './math.js';
import { loadArtifact } from '../chain/artifacts.js';

const here = dirname(fileURLToPath(import.meta.url));
const poolSrc = readFileSync(join(here, '..', '..', 'contracts/amm/ConstantProductPool.sol'), 'utf8');

const MINIMUM_LIQUIDITY = 1_000n;

function sqrt(y: bigint): bigint {
  if (y <= 3n) return y === 0n ? 0n : 1n;
  let z = y;
  let x = y / 2n + 1n;
  while (x < z) {
    z = x;
    x = (y / x + x) / 2n;
  }
  return z;
}

interface Pool {
  r0: bigint;
  r1: bigint;
  totalSupply: bigint;
  /** LP balances incl. address(0) lock */
  lp: Map<string, bigint>;
  feeBps: number;
}

function createPool(feeBps: number): Pool {
  return { r0: 0n, r1: 0n, totalSupply: 0n, lp: new Map([['0', 0n]]), feeBps };
}

/** Smallest integer amount that still supports `liquidity` against `reserve`. */
function tokensForLiquidity(liquidity: bigint, reserve: bigint, supply: bigint): bigint {
  const product = liquidity * reserve;
  let used = product / supply;
  if (used * supply < product) used += 1n;
  return used;
}

function mint(p: Pool, to: string, amount0: bigint, amount1: bigint): bigint {
  let liquidity: bigint;
  let book0 = amount0;
  let book1 = amount1;
  if (p.totalSupply === 0n) {
    liquidity = sqrt(amount0 * amount1);
    if (liquidity <= MINIMUM_LIQUIDITY) throw new Error('insufficient liquidity');
    p.totalSupply = liquidity;
    p.lp.set('0', MINIMUM_LIQUIDITY);
    liquidity -= MINIMUM_LIQUIDITY;
    p.lp.set(to, (p.lp.get(to) ?? 0n) + liquidity);
  } else {
    const liq0 = (amount0 * p.totalSupply) / p.r0;
    const liq1 = (amount1 * p.totalSupply) / p.r1;
    liquidity = liq0 < liq1 ? liq0 : liq1;
    if (liquidity === 0n) throw new Error('insufficient liquidity');
    const used0 = tokensForLiquidity(liquidity, p.r0, p.totalSupply);
    const used1 = tokensForLiquidity(liquidity, p.r1, p.totalSupply);
    book0 = used0 < amount0 ? used0 : amount0;
    book1 = used1 < amount1 ? used1 : amount1;
    p.totalSupply += liquidity;
    p.lp.set(to, (p.lp.get(to) ?? 0n) + liquidity);
  }
  p.r0 += book0;
  p.r1 += book1;
  return liquidity;
}

function burn(p: Pool, from: string, liquidity: bigint): { amount0: bigint; amount1: bigint } {
  const bal = p.lp.get(from) ?? 0n;
  if (liquidity === 0n || bal < liquidity) throw new Error('insufficient liquidity');
  const amount0 = (liquidity * p.r0) / p.totalSupply;
  const amount1 = (liquidity * p.r1) / p.totalSupply;
  if (amount0 === 0n || amount1 === 0n) throw new Error('insufficient liquidity');
  p.lp.set(from, bal - liquidity);
  p.totalSupply -= liquidity;
  p.r0 -= amount0;
  p.r1 -= amount1;
  return { amount0, amount1 };
}

/** Exact-in swap token0 → token1. Returns amountOut. Enforces V2 k check. */
function swap0to1(p: Pool, amountIn: bigint): bigint {
  const out = getAmountOut(amountIn, p.r0, p.r1, p.feeBps);
  const new0 = p.r0 + amountIn;
  const new1 = p.r1 - out;
  const bal0Adj = new0 * FEE_DENOM - amountIn * BigInt(p.feeBps);
  const bal1Adj = new1 * FEE_DENOM;
  const kOk = bal0Adj * bal1Adj >= p.r0 * p.r1 * FEE_DENOM * FEE_DENOM;
  if (!kOk) throw new Error('K');
  p.r0 = new0;
  p.r1 = new1;
  return out;
}

describe('S-A2 invariants · k and no free extraction', () => {
  it('property: fee-adjusted k never decreases across random swaps', () => {
    for (let seed = 1; seed <= 64; seed++) {
      const p = createPool(30);
      mint(p, 'lp', 1_000n * 10n ** 18n, 1_000n * 10n ** 18n);
      let kAdj = p.r0 * p.r1;
      for (let i = 0; i < 8; i++) {
        const amountIn = BigInt(((seed * 17 + i * 13) % 50) + 1) * 10n ** 16n;
        const before0 = p.r0;
        const before1 = p.r1;
        swap0to1(p, amountIn);
        const afterProd = p.r0 * p.r1;
        expect(afterProd, `seed=${seed} i=${i}`).toBeGreaterThanOrEqual(kAdj);
        // raw k grows because fee stays in the pool
        expect(p.r0).toBeGreaterThan(before0);
        expect(p.r1).toBeLessThan(before1);
        kAdj = afterProd;
      }
    }
  });

  it('property: round-trip swap leaves the trader with less of token0 (no free extraction)', () => {
    const p = createPool(30);
    mint(p, 'lp', 5_000n * 10n ** 18n, 5_000n * 10n ** 18n);
    const start = 100n * 10n ** 18n;
    const out1 = swap0to1(p, start);
    // reverse: token1 → token0
    const out0 = getAmountOut(out1, p.r1, p.r0, p.feeBps);
    const new1 = p.r1 + out1;
    const new0 = p.r0 - out0;
    p.r1 = new1;
    p.r0 = new0;
    expect(out0).toBeLessThan(start);
  });

  it('ConstantProductPool.sol enforces K() and has no admin/pause/fee setter', () => {
    expect(poolSrc).toMatch(/revert K\(\)/);
    expect(poolSrc).toMatch(/immutable feeBps/);
    expect(poolSrc).not.toMatch(/function\s+setFee\b/);
    expect(poolSrc).not.toMatch(/function\s+pause\b/);
    expect(poolSrc).not.toMatch(/\bonlyOwner\b/);
    const names: string[] = [];
    for (const item of loadArtifact('ConstantProductPool').abi) {
      if (item.type === 'function') names.push(item.name);
    }
    expect(names).not.toContain('setFee');
    expect(names).not.toContain('pause');
  });
});

describe('S-A2 LP accounting + fee tiers', () => {
  it('first mint locks MINIMUM_LIQUIDITY; burn returns pro-rata reserves', () => {
    const p = createPool(30);
    const liq = mint(p, 'alice', 100n * 10n ** 18n, 100n * 10n ** 18n);
    expect(p.lp.get('0')).toBe(MINIMUM_LIQUIDITY);
    expect(liq).toBe(p.totalSupply - MINIMUM_LIQUIDITY);
    expect(p.lp.get('alice') ?? 0n).toBe(liq);

    const burnLiq = liq / 2n;
    const expect0 = (burnLiq * p.r0) / p.totalSupply;
    const expect1 = (burnLiq * p.r1) / p.totalSupply;
    const { amount0, amount1 } = burn(p, 'alice', burnLiq);
    expect(amount0).toBe(expect0);
    expect(amount1).toBe(expect1);
    expect(amount0).toBeLessThan((100n * 10n ** 18n) / 2n); // MINIMUM lock → less than half deposits
  });

  it('later mint refunds the surplus and does not book it as reserves', () => {
    const p = createPool(30);
    const seed = 1_000_000n;
    mint(p, 'alice', seed, seed);
    const supply = p.totalSupply;
    const r0 = p.r0;
    const r1 = p.r1;
    const amount0 = seed;
    const amount1 = (seed * 5n) / 2n;
    const minted = mint(p, 'bob', amount0, amount1);
    expect(minted).toBe((amount0 * supply) / r0);
    expect(p.r0 - r0).toBe(amount0);
    expect(p.r1 - r1).toBe(amount0);
    expect(p.r1 - r1).not.toBe(amount1);
  });

  it('second LP mints pro-rata; cannot dilute the first beyond deposits', () => {
    const p = createPool(30);
    mint(p, 'alice', 1_000n * 10n ** 18n, 1_000n * 10n ** 18n);
    const aliceLp = p.lp.get('alice')!;
    const bobLiq = mint(p, 'bob', 1_000n * 10n ** 18n, 1_000n * 10n ** 18n);
    // Alice's balance excludes permanently locked MINIMUM_LIQUIDITY; Bob's equal deposit mints full pro-rata.
    expect(bobLiq).toBe(aliceLp + MINIMUM_LIQUIDITY);
    expect(p.lp.get('alice')).toBe(aliceLp);
  });

  it('higher feeBps strictly reduces amountOut for the same trade', () => {
    const rIn = 1_000n * 10n ** 18n;
    const rOut = 1_000n * 10n ** 18n;
    const amountIn = 10n * 10n ** 18n;
    const out30 = getAmountOut(amountIn, rIn, rOut, 30);
    const out100 = getAmountOut(amountIn, rIn, rOut, 100);
    expect(out100).toBeLessThan(out30);
  });

  it('fee accrued on swaps increases pool product (LP value), not a platform skim path', () => {
    const p = createPool(30);
    mint(p, 'lp', 1_000n * 10n ** 18n, 1_000n * 10n ** 18n);
    const k0 = p.r0 * p.r1;
    swap0to1(p, 50n * 10n ** 18n);
    expect(p.r0 * p.r1).toBeGreaterThan(k0);
    // No feeTo / protocol skim in ABI
    const names: string[] = [];
    for (const item of loadArtifact('ConstantProductPool').abi) {
      if (item.type === 'function') names.push(item.name);
    }
    expect(names).not.toContain('skim');
    expect(names).not.toContain('setFeeTo');
  });
});
