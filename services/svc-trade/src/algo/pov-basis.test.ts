/**
 * POV on opposite-side liquidity: the participation rate is applied to the size of the side the child takes from,
 * each child records that size, and an empty side is a miss naming the book, never an invented size.
 */
import { describe, expect, it } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client';
import { sideQty } from '../spot/trade-service/algo.js';
import { TwapEngine, type TwapEnginePorts } from './twap-engine.js';
import type { AlgoQuotedMark, CreateTwapInput } from './types.js';

const LOT = parseAmount('0.001');
const MARKET = '11111111-1111-1111-1111-111111111111';
const USER = '22222222-2222-2222-2222-222222222222';

function input(over: Partial<CreateTwapInput> = {}): CreateTwapInput {
  return {
    marketId: MARKET,
    symbol: 'BTC/USDT',
    side: 'buy',
    totalQty: parseAmount('1'),
    durationMs: 10_000,
    sliceIntervalMs: 2_000,
    limitPrice: parseAmount('100'),
    subAccountId: null,
    clientAlgoId: 'pov-basis',
    kind: 'pov',
    participationBps: 1_000,
    ...over,
  };
}

function ports(over: Partial<TwapEnginePorts> = {}) {
  const sides: string[] = [];
  const limits: Array<bigint | null> = [];
  const base: TwapEnginePorts = {
    now: () => new Date(1_700_000_000_000),
    randomId: () => 'id',
    placeChild: async (req) => ({ orderId: `order-${req.sliceIndex}` }),
    cancelChild: async () => {},
    bestOpposingPrice: async () => parseAmount('50'),
    markFor: async (marketId): Promise<AlgoQuotedMark | null> => ({
      marketId,
      price: parseAmount('50'),
      asOf: new Date(1_700_000_000_000),
      quality: 'mid',
    }),
    intervalTakerVolume: async () => parseAmount('9'),
    oppositeBookQty: async (_marketId, side, limitPrice) => {
      sides.push(side);
      limits.push(limitPrice);
      return parseAmount('2.3456');
    },
  };
  return { ...base, ...over, sides, limits };
}

describe('POV participation basis', () => {
  it('applies participation to the opposite-side book size and records that size on the child', async () => {
    const p = ports();
    const engine = new TwapEngine(p);
    const parent = engine.create(USER, input({ povBasis: 'opposite_liquidity' }), LOT);
    expect(parent.povBasis).toBe('opposite_liquidity');
    const out = await engine.tick(parent.id);
    expect(out.kind).toBe('placed');
    if (out.kind !== 'placed') return;
    // 2.3456 × 1000 bps = 0.23456, floored to the 0.001 lot: 0.234. Tape (9) is not used.
    expect(out.child.qty).toBe(parseAmount('0.234'));
    expect(out.child.basisQty).toBe(parseAmount('2.3456'));
    expect(p.sides).toEqual(['buy']);
  });

  it('caps the child at the remaining quantity', async () => {
    const engine = new TwapEngine(ports());
    const parent = engine.create(USER, input({ povBasis: 'opposite_liquidity', totalQty: parseAmount('0.1') }), LOT);
    const out = await engine.tick(parent.id);
    expect(out.kind === 'placed' ? out.child.qty : null).toBe(parseAmount('0.1'));
  });

  it('an empty opposite side is a no-volume miss naming the book, and nothing is placed', async () => {
    const placed: number[] = [];
    const engine = new TwapEngine(
      ports({
        oppositeBookQty: async () => 0n,
        placeChild: async (req) => {
          placed.push(req.sliceIndex);
          return { orderId: 'never' };
        },
      }),
    );
    const parent = engine.create(USER, input({ povBasis: 'opposite_liquidity' }), LOT);
    const out = await engine.tick(parent.id);
    expect(out.kind).toBe('miss');
    if (out.kind !== 'miss') return;
    expect(out.miss.code).toBe('trade.algo_no_volume');
    expect(out.miss.reason).toContain('opposite-side book quantity');
    expect(placed).toEqual([]);
    expect(engine.get(parent.id)!.children).toEqual([]);
  });

  it('defaults to traded volume and records the tape it used', async () => {
    const engine = new TwapEngine(ports());
    const parent = engine.create(USER, input(), LOT);
    expect(parent.povBasis).toBe('traded_volume');
    const out = await engine.tick(parent.id);
    expect(out.kind === 'placed' ? out.child.basisQty : null).toBe(parseAmount('9'));
    expect(out.kind === 'placed' ? out.child.qty : null).toBe(parseAmount('0.9'));
  });

  it('refuses a basis on a non-POV schedule and an unknown basis', () => {
    const engine = new TwapEngine(ports());
    expect(() => engine.create(USER, input({ kind: 'twap', participationBps: undefined, povBasis: 'opposite_liquidity' }), LOT)).toThrow(
      expect.objectContaining({ code: 'trade.algo_invalid_schedule' }),
    );
    expect(() => engine.create(USER, input({ povBasis: 'book' as never, clientAlgoId: 'bad' }), LOT)).toThrow(
      expect.objectContaining({ code: 'trade.algo_invalid_schedule' }),
    );
  });

  it('passes the limit to the book read, so only reachable levels size the child', async () => {
    const p = ports();
    const engine = new TwapEngine(p);
    const parent = engine.create(USER, input({ povBasis: 'opposite_liquidity', clientAlgoId: 'limit' }), LOT);
    await engine.tick(parent.id);
    expect(p.limits).toEqual([parseAmount('100')]);
  });

  it('counts only the levels at or inside the limit: asks at or below a buy limit, bids at or above a sell limit', () => {
    const asks: Array<[string, string]> = [
      ['1.00', '1'],
      ['5.00', '10000'],
    ];
    expect(sideQty(asks, 'buy', parseAmount('1.00'))).toBe(parseAmount('1'));
    expect(sideQty(asks, 'buy', parseAmount('0.99'))).toBe(0n);
    expect(sideQty(asks, 'buy', null)).toBe(parseAmount('10001'));
    const bids: Array<[string, string]> = [
      ['0.99', '40'],
      ['0.50', '7'],
    ];
    expect(sideQty(bids, 'sell', parseAmount('0.99'))).toBe(parseAmount('40'));
    expect(sideQty(bids, 'sell', parseAmount('1'))).toBe(0n);
    expect(sideQty(bids, 'sell', null)).toBe(parseAmount('47'));
  });
});
