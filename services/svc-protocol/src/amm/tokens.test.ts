import { describe, expect, it } from 'vitest';
import type { Address, Hex } from 'viem';
import {
  ORGANIC_SCORE_UNSET,
  TOKENS_READ_TOO_LARGE,
  TRUST_CRITERIA_UNSET,
  tokenPageOutputSchema,
  tokensLeaderboardOutputSchema,
  tokensListOutputSchema,
  type TokenBasics,
} from '@intafaced/contracts';
import {
  formatScaled,
  holdersFrom,
  leaderboard,
  MAX_HOLDERS,
  normaliseName,
  tokenPage,
  tokensList,
  TokensReadError,
  type MarketSnapshot,
  type SwapLog,
} from './tokens.js';

// TEST tokens and pools only: every figure below is made up for the arithmetic, none is a market value.
const A: TokenBasics = { address: '0x00000000000000000000000000000000000a11ce', name: 'TEST Token A', symbol: 'TESTA', decimals: 6 };
const B: TokenBasics = { address: '0x00000000000000000000000000000000000b0b00', name: 'TEST Token B', symbol: 'TESTB', decimals: 18 };
// Same name as A once invisible characters and case are dropped, listed later.
const LOOK: TokenBasics = { address: '0x000000000000000000000000000000000000100c', name: 'test​ token a', symbol: '', decimals: 18 };
const P1 = '0x1000000000000000000000000000000000000001' as Address;
const P2 = '0x2000000000000000000000000000000000000002' as Address;
const W1 = '0x00000000000000000000000000000000000000a1' as Address;
const W2 = '0x00000000000000000000000000000000000000a2' as Address;
const ZERO = '0x0000000000000000000000000000000000000000' as Address;
const DEAD = '0x000000000000000000000000000000000000dEaD' as Address;
const E6 = 10n ** 6n;
const E18 = 10n ** 18n;
const NOW = 10_000;
const tx = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex;

/** A buys or sells of A against B in P1 (token0 = A, token1 = B). */
const swap = (n: number, time: number, wallet: Address, side: 'buy' | 'sell', a: bigint, b: bigint): SwapLog => ({
  pool: P1,
  tx: tx(n),
  logIndex: 0,
  block: BigInt(n),
  time,
  wallet,
  amount0In: side === 'sell' ? a : 0n,
  amount1In: side === 'buy' ? b : 0n,
  amount0Out: side === 'buy' ? a : 0n,
  amount1Out: side === 'sell' ? b : 0n,
});

const snapshot = (): MarketSnapshot => ({
  blockNumber: 40n,
  asOf: NOW,
  tokens: [A, B, LOOK],
  pools: [
    {
      pool: P1,
      token0: A.address as Address,
      token1: B.address as Address,
      feeBps: 30,
      reserve0: 1_000n * E6,
      reserve1: 3_000n * E18,
      createdAt: 100,
      index: 0,
    },
    {
      pool: P2,
      token0: LOOK.address as Address,
      token1: B.address as Address,
      feeBps: 30,
      reserve0: 10n * E18,
      reserve1: 10n * E18,
      createdAt: 9_000,
      index: 1,
    },
  ],
  syncs: [
    // A at 2 B a day ago, 3 B now.
    { pool: P1, tx: tx(1), logIndex: 1, block: 1n, time: 100, reserve0: 1_000n * E6, reserve1: 2_000n * E18 },
    { pool: P1, tx: tx(30), logIndex: 1, block: 30n, time: NOW - 30, reserve0: 1_000n * E6, reserve1: 3_000n * E18 },
    { pool: P2, tx: tx(20), logIndex: 1, block: 20n, time: 9_000, reserve0: 10n * E18, reserve1: 10n * E18 },
  ],
  swaps: [
    swap(10, NOW - 7_200, W1, 'buy', 10n * E6, 20n * E18),
    swap(11, NOW - 120, W1, 'sell', 5n * E6, 15n * E18),
    swap(12, NOW - 100, W2, 'sell', 4n * E6, 12n * E18),
    swap(13, NOW - 90, W2, 'buy', 2n * E6, 6n * E18),
  ],
});

describe('tokensList', () => {
  it('prices each token in the quote token and states growth and volume for the window from the pool logs', () => {
    const list = tokensListOutputSchema.parse(tokensList(snapshot(), B, '24h'));
    const a = list.tokens.find((t) => t.token.address === A.address)!;
    expect(a.price).toBe('3');
    // 2 B a day ago, 3 B now: +50%.
    expect(a.growthBps).toBe(5_000);
    // 10 + 5 + 4 + 2 A traded at today's 3 B.
    expect(a.volume).toBe('63');
    expect(a.trades).toBe(4);
    expect(a.listedAt).toBe(100);
    expect(list.tokens.find((t) => t.token.address === B.address)!.price).toBe('1');
  });

  it('counts only swaps inside the window', () => {
    const a = tokensList(snapshot(), B, '1h').tokens.find((t) => t.token.address === A.address)!;
    expect(a.trades).toBe(3);
    expect(a.volume).toBe('33');
  });

  it('marks the later token whose name reads the same as an earlier one, and not the earlier one', () => {
    const list = tokensList(snapshot(), B, '24h');
    expect(list.tokens.find((t) => t.token.address === LOOK.address)!.lookalikeOf).toEqual({
      address: A.address,
      name: A.name,
      symbol: A.symbol,
    });
    expect(list.tokens.find((t) => t.token.address === A.address)!.lookalikeOf).toBeNull();
  });

  it('gives no price, growth or volume to a token no pool connects to the quote token', () => {
    const snap = snapshot();
    snap.pools = snap.pools.filter((p) => p.pool === P2);
    snap.swaps = [];
    expect(tokensList(snap, B, '24h').tokens.find((t) => t.token.address === LOOK.address)!.price).toBe('1');
    const noRoute = tokensList(
      snap,
      { address: '0x000000000000000000000000000000000000c0de', name: 'Q', symbol: 'Q', decimals: 18 },
      '24h',
    );
    expect(noRoute.tokens.every((t) => t.price === null && t.growthBps === null && t.volume === '0')).toBe(true);
  });
});

describe('normaliseName', () => {
  it('drops invisible characters, spaces and case, and folds compatibility forms', () => {
    expect(normaliseName('T​EST Token Ａ')).toBe('testtokena');
  });
});

describe('tokenPage', () => {
  const holders = holdersFrom(
    [
      { from: ZERO, to: W1, value: 600n },
      { from: ZERO, to: W2, value: 400n },
      { from: W1, to: DEAD, value: 100n },
      { from: W2, to: W1, value: 50n },
    ],
    1_000n,
    100n,
  );

  it('states liquidity in token amounts, volume equal to the sum of swaps, and one candle per traded minute', () => {
    const page = tokenPageOutputSchema.parse(tokenPage(snapshot(), B, A, holders));
    const pair = page.pairs.find((p) => p.pool === P1)!;
    expect(pair.reserve).toBe((1_000n * E6).toString());
    expect(pair.reserveOther).toBe((3_000n * E18).toString());
    const sumOfSwaps = page.trades.filter((t) => t.pool === P1).reduce((sum, t) => sum + BigInt(t.amount), 0n);
    expect(pair.volume).toBe(sumOfSwaps.toString());
    expect(pair.volume).toBe((21n * E6).toString());
    expect(pair.candles.map((c) => c.time)).toEqual([NOW - 7_200, NOW - 120, NOW - 100]);
    // The second candle's minute holds the sells at 3 B; the last holds 3 B too; the first is the 2 B buy.
    expect(pair.candles[0]).toEqual({ time: NOW - 7_200, open: '2', high: '2', low: '2', close: '2' });
    expect(page.trades[0]).toMatchObject({ wallet: W2, side: 'buy', amount: (2n * E6).toString(), amountOther: (6n * E18).toString() });
  });

  it('values fees as each swap input times the pool fee, in the quote token', () => {
    // Inputs: 20 B, 5 A, 4 A, 6 B; at 30 bps and A = 3 B: 0.06 + 0.045 + 0.036 + 0.018.
    expect(tokenPage(snapshot(), B, A, holders).feesPaid).toBe('0.159');
  });

  it('refuses the trust tier by name while its criteria are blank, and never scores', () => {
    const { trust } = tokenPage(snapshot(), B, A, holders);
    expect(trust).toMatchObject({ tier: null, tierRefusal: TRUST_CRITERIA_UNSET, organicScore: null, organicRefusal: ORGANIC_SCORE_UNSET });
    expect(trust.flags).toEqual(['no_lp_lock', 'no_vesting']);
  });

  it('gives a token with no trade the tier "unknown", the no-history flag and the lookalike it copies', () => {
    const page = tokenPage(snapshot(), B, LOOK, holders);
    expect(page.trust.tier).toBe('unknown');
    expect(page.trust.tierRefusal).toBeNull();
    expect(page.trust.flags).toEqual(['no_lp_lock', 'no_vesting', 'lookalike', 'no_history']);
    expect(page.trust.lookalikeOf?.address).toBe(A.address);
    expect(page.trades).toEqual([]);
  });

  it('answers a token in no pool as unlisted, with no price', () => {
    const stranger = { address: '0x000000000000000000000000000000000000beef', name: 'X', symbol: 'X', decimals: 18 };
    const page = tokenPage(snapshot(), B, stranger, holders);
    expect(page).toMatchObject({ listed: false, price: null, growthBps24h: null, pairs: [], trades: [] });
  });
});

describe('holdersFrom', () => {
  const transfers = [
    { from: ZERO, to: W1, value: 600n },
    { from: ZERO, to: W2, value: 400n },
    { from: W1, to: DEAD, value: 100n },
    { from: W2, to: W1, value: 50n },
    { from: W2, to: ZERO, value: 50n },
  ];

  it('takes a burn that already lowered the supply off once, not twice', () => {
    // A standard burn: totalSupply fell to 950 and the zero address holds nothing; the dead address holds 100.
    const h = holdersFrom(transfers, 950n, 100n);
    expect(h.burned).toBe('100');
    expect(h.supplyLessBurned).toBe('850');
    expect(h.list.reduce((s, x) => s + BigInt(x.amount), 0n).toString()).toBe(h.supplyLessBurned);
  });

  it('folds transfers into balances whose sum is supply less burned', () => {
    // A token whose transfers to the zero address stay in its supply: the chain shows both burn addresses holding.
    const h = holdersFrom(transfers, 1_000n, 150n);
    expect(h.burned).toBe('150');
    expect(h.supplyLessBurned).toBe('850');
    expect(h.list).toEqual([
      { address: W1, amount: '550' },
      { address: W2, amount: '300' },
    ]);
    expect(h.list.reduce((s, x) => s + BigInt(x.amount), 0n).toString()).toBe(h.supplyLessBurned);
  });

  it('refuses past its holder limit instead of listing part of them', () => {
    const transfers = Array.from({ length: MAX_HOLDERS + 1 }, (_, i) => ({
      from: ZERO,
      to: `0x${(i + 1).toString(16).padStart(40, '0')}` as Address,
      value: 1n,
    }));
    expect(() => holdersFrom(transfers, BigInt(MAX_HOLDERS + 1), 0n)).toThrow(TokensReadError);
    try {
      holdersFrom(transfers, BigInt(MAX_HOLDERS + 1), 0n);
    } catch (err) {
      expect((err as TokensReadError).code).toBe(TOKENS_READ_TOO_LARGE);
    }
  });
});

/** A decimal string as an exact 1e18-scaled bigint, so money is compared without a `number`. */
function scaledOf(value: string): bigint {
  const negative = value.startsWith('-');
  const [whole = '0', fraction = ''] = (negative ? value.slice(1) : value).split('.');
  const units = BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, '0'));
  return negative ? -units : units;
}

describe('leaderboard', () => {
  it('realises a sell against the average cost of what the wallet bought, and each row equals the sum of its trades', () => {
    const board = tokensLeaderboardOutputSchema.parse(leaderboard(snapshot(), B));
    const w1 = board.rows.find((r) => r.wallet === W1)!;
    // Bought 10 A for 20 B; sold 5 A for 15 B: 15 - 10 = 5 B.
    expect(w1.trades.map((t) => t.realised)).toEqual([null, '5']);
    expect(w1.realised).toBe('5');
    for (const row of board.rows) {
      const sum = row.trades.reduce((s, t) => s + (t.realised === null ? 0n : scaledOf(t.realised)), 0n);
      expect(scaledOf(row.realised)).toBe(sum);
    }
  });

  it('realises nothing on a sell with no buy on record, rather than guess its cost', () => {
    const w2 = leaderboard(snapshot(), B).rows.find((r) => r.wallet === W2)!;
    expect(w2.trades.map((t) => t.realised)).toEqual([null, null]);
    expect(w2.realised).toBe('0');
  });

  it('ranks wallets by realised result', () => {
    expect(leaderboard(snapshot(), B).rows.map((r) => r.wallet)).toEqual([W1, W2]);
  });
});

describe('formatScaled', () => {
  it('keeps negatives and trims trailing zeros', () => {
    expect(formatScaled(-15n * 10n ** 17n)).toBe('-1.5');
    expect(formatScaled(0n)).toBe('0');
  });
});
