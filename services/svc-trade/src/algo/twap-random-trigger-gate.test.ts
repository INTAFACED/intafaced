/**
 * The creation gate for a random or triggered TWAP: the band and the first slice's funding are read at the trigger
 * price, and a random plan whose smallest slice the market would refuse is refused before anything is stored.
 */
import { describe, expect, it } from 'vitest';
import { formatAmount, parseAmount as amt, type Amount } from '@intafaced/ledger-client';
import { PUBLISHED_TEST_FEE_SCHEDULE, readyMarket } from '../spot/testing.js';
import { TradeError } from '../spot/types.js';
import { assertSmallestSliceTradable, childSliceCover, gateAlgoCreate, type AlgoCreateGateInput } from './create-gate.js';
import { planTwapSlices } from './schedule.js';
import type { CreateTwapInput } from './types.js';

const NOW = new Date('2026-08-24T16:00:00.000Z');
const MARKET = readyMarket('11111111-1111-1111-1111-111111111111');

function ctx(input: Partial<CreateTwapInput>, available: Amount, reads: string[] = []): AlgoCreateGateInput {
  return {
    sql: {} as AlgoCreateGateInput['sql'],
    ledger: {
      balance: async (ref: { assetId?: string }) => {
        reads.push(String(ref.assetId));
        return { amount: available };
      },
    } as unknown as AlgoCreateGateInput['ledger'],
    perks: { perksOf: async () => ({ feeDiscountBps: 0 }) } as unknown as AlgoCreateGateInput['perks'],
    feeSchedule: PUBLISHED_TEST_FEE_SCHEDULE,
    slippageCapBps: 100,
    markPolicy: { maxAgeSeconds: 60 },
    now: NOW,
    userId: '22222222-2222-2222-2222-222222222222',
    market: MARKET,
    bid: amt('49.99'),
    ask: amt('50'),
    verification: { policy: { mode: 'off' }, tier: 'basic' },
    input: {
      marketId: MARKET.id,
      symbol: MARKET.symbol,
      side: 'buy',
      totalQty: amt('0.003'),
      durationMs: 300_000,
      sliceIntervalMs: 30_000,
      limitPrice: null,
      subAccountId: null,
      clientAlgoId: 'gate-fixture',
      ...input,
    },
  };
}

async function refusal(p: Promise<unknown>): Promise<TradeError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof TradeError) return err;
    throw err;
  }
  throw new Error('expected a refusal');
}

describe('creation gate with a trigger price', () => {
  it('judges a buy limit against the trigger, not today’s ask', async () => {
    // A limit of 60 is inside the band at an ask of 50 but cannot fill once the trigger at 100 is reached.
    const err = await refusal(gateAlgoCreate(ctx({ limitPrice: amt('60'), triggerPrice: amt('100'), triggerAbove: true }, amt('1000000'))));
    expect(err.code).toBe('trade.algo_price_band');
    // The same limit with no trigger passes the band.
    await expect(gateAlgoCreate(ctx({ limitPrice: amt('60') }, amt('1000000')))).resolves.toBeUndefined();
  });

  it('funds a market buy’s first slice at the trigger when it is above the ask', async () => {
    const input = { triggerPrice: amt('100'), triggerAbove: true };
    const slice = planTwapSlices({ totalQty: amt('0.003'), durationMs: 300_000, sliceIntervalMs: 30_000, lotSize: MARKET.lotSize })
      .slices[0]!;
    const base = {
      market: MARKET,
      side: 'buy' as const,
      qty: slice,
      limitPrice: null,
      bid: amt('49.99'),
      slippageCapBps: 100,
      feeSchedule: PUBLISHED_TEST_FEE_SCHEDULE,
      takerDiscountBps: 0,
    };
    const atTrigger = await childSliceCover({ ...base, ask: amt('100') });
    const atAsk = await childSliceCover({ ...base, ask: amt('50') });
    expect(atTrigger.required > atAsk.required).toBe(true);
    // Enough for the slice at today's ask, short of it at the trigger: refused, naming the trigger-priced amount.
    const err = await refusal(gateAlgoCreate(ctx(input, atAsk.required)));
    expect(err.code).toBe('trade.algo_insufficient_balance');
    expect(err.data).toMatchObject({ required: formatAmount(atTrigger.required) });
    const short = await refusal(gateAlgoCreate(ctx(input, atTrigger.required - 1n)));
    expect(short.code).toBe('trade.algo_insufficient_balance');
    await expect(gateAlgoCreate(ctx(input, atTrigger.required))).resolves.toBeUndefined();
  });
});

describe('creation gate with random slice sizes', () => {
  it('refuses a random plan whose smallest slice is below the market minimum, before reading a balance', async () => {
    const market = readyMarket(MARKET.id, { minQty: amt('0.0002') });
    const reads: string[] = [];
    // Eleven lots over ten slices: most slices are one lot, below a two-lot minimum.
    const c = { ...ctx({ randomSeed: 2310, totalQty: amt('0.0011') }, amt('1000000'), reads), market };
    const slices = planTwapSlices({
      totalQty: amt('0.0011'),
      durationMs: 300_000,
      sliceIntervalMs: 30_000,
      lotSize: market.lotSize,
      randomSeed: 2310,
    }).slices;
    expect(slices.some((q) => q < market.minQty)).toBe(true);
    const err = await refusal(gateAlgoCreate(c));
    expect(err.code).toBe('trade.algo_invalid_qty');
    expect(reads).toEqual([]);
  });

  it('passes a random plan whose every slice the market takes', async () => {
    await expect(gateAlgoCreate(ctx({ randomSeed: 2310 }, amt('1000000')))).resolves.toBeUndefined();
    expect(() => assertSmallestSliceTradable(MARKET, [amt('0.0001'), amt('0.0005')])).not.toThrow();
  });
});
