import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import {
  bankHoldingsChangeSchema,
  bankValueOverTimeSchema,
  createEdgeContext,
  encodePrincipal,
  signPrincipalHeader,
  type LedgerHoldingsHistory,
  type LedgerHoldingsHistoryInput,
  type LedgerMovement,
} from '@intafaced/contracts';
import { LedgerError, parseAmount as amt } from '@intafaced/ledger-client';
import { createBankRouter } from '../router.js';
import type { BankServices } from '../bank-service.js';
import type { SpaceRecord } from '../spaces/space-service.js';
import type { CloseSeries, CloseSeriesSource } from './candles.js';
import { PortfolioService } from './portfolio-service.js';
import { bucketOf, chooseInterval, gridOf, holdingsChange, valueOverTime } from './value-history.js';

// J-portfolio-05 #6 and #7. Every figure is hand-computed TEST data, not a real balance.
const DAY = 86_400_000;
const day = (d: number, hour = 0) => new Date(Date.UTC(2026, 9, d, hour));
const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const SPACE = '44444444-4444-4444-8444-444444444444';
const BOBS_SPACE = '55555555-5555-4555-8555-555555555555';
const CLOSED = '66666666-6666-4666-8666-666666666666';

const move = (d: number, assetId: string, module: string, reason: string, inflow: string, outflow: string, fee = '0'): LedgerMovement => ({
  assetId,
  module,
  reason,
  bucketStart: day(d).toISOString(),
  inflow,
  outflow,
  fee,
});
const history = (holdings: Record<string, string>, movements: LedgerMovement[]): LedgerHoldingsHistory => ({
  asOf: day(10).toISOString(),
  from: day(1).toISOString(),
  bucketSeconds: 86_400,
  holdings: Object.entries(holdings).map(([assetId, amount]) => ({ assetId, amount })),
  movements,
});

// Day 2: TEST 1000 USDT deposited. Day 3: 1 BTC bought for 500 USDT, 0.01 BTC fee taken from what arrived. Day 4: 0.5 BTC
// moved to the customer's own Space (both halves under one reason), and 100 USDT withdrawn.
const MAIN = history({ BTC: '0.5', USDT: '400' }, [
  move(2, 'USDT', 'ledger', 'deposit.credited', '1000', '0'),
  move(3, 'BTC', 'trade', 'trade.fill', '1', '0', '0.01'),
  move(3, 'USDT', 'trade', 'trade.fill', '0', '500'),
  move(4, 'BTC', 'identity', 'identity.sub_account.transfer', '0', '0.5'),
  move(4, 'USDT', 'ledger', 'withdraw.settled', '0', '100'),
]);
const SAVINGS = history({ BTC: '0.5' }, [move(4, 'BTC', 'identity', 'identity.sub_account.transfer', '0.5', '0')]);

// Daily BTC/USDT candles: the one opening on day d closes at 100d.
const daily = (first: number, last = 10): CloseSeries => ({
  market: 'BTC/USDT',
  candles: Array.from({ length: last - first + 1 }, (_, i) => [day(first + i).getTime(), amt(String(100 * (first + i)))] as const),
});
const samples = [1, 2, 3, 4, 5].map((d) => day(d));

describe('valueOverTime: what the holdings were worth at each moment', () => {
  it('replays the holdings backwards from now and values each moment at the last closed candle', () => {
    const out = valueOverTime({ histories: [MAIN, SAVINGS], interval: '1d', samples, live: false, closes: new Map([['BTC', daily(0)]]) });
    // Day 5: 1 BTC (both accounts) at the day-4 close of 400, plus 400 USDT. Day 4: 1 BTC at 300 + 500 USDT.
    // Day 3: 1000 USDT, no BTC yet. Day 2 and day 1: nothing.
    expect(out.points.map((p) => p.valueUsd)).toEqual(['0', '0', '1000', '800', '800']);
    expect(out.points.every((p) => p.missing.length === 0)).toBe(true);
    expect(bankValueOverTimeSchema.parse(out)).toEqual(out);
  });

  it('a moment with a coin held and no price is missing and names the coin, never zero', () => {
    const withSol = history({ BTC: '0.5', USDT: '400', SOL: '3' }, [
      ...MAIN.movements,
      move(3, 'SOL', 'ledger', 'deposit.credited', '3', '0'),
    ]);
    const out = valueOverTime({
      histories: [withSol, SAVINGS],
      interval: '1d',
      samples,
      live: false,
      closes: new Map<string, CloseSeries | null>([
        ['BTC', daily(0)],
        ['SOL', null],
      ]),
    });
    // The SOL arrived during day 3, so the day-3 moment (its start) holds none; from day 4 on it is held with no price.
    expect(out.points.slice(0, 3).map((p) => p.valueUsd)).toEqual(['0', '0', '1000']);
    for (const p of out.points.slice(3)) expect(p).toMatchObject({ valueUsd: null, missing: [{ assetId: 'SOL', reason: 'no_price' }] });
    // A day before BTC's first candle is missing too, while a day holding only dollar coins needs no price.
    const late = valueOverTime({ histories: [MAIN, SAVINGS], interval: '1d', samples, live: false, closes: new Map([['BTC', daily(4)]]) });
    expect(late.points.map((p) => p.valueUsd)).toEqual(['0', '0', '1000', null, '800']);
  });

  it('a live end is the ledger read itself, priced at the candle still open', () => {
    const live = [...samples, day(5, 12)];
    const out = valueOverTime({
      histories: [MAIN, SAVINGS],
      interval: '1d',
      samples: live,
      live: true,
      closes: new Map([['BTC', daily(0)]]),
    });
    // Mid day 5: the same holdings, at the open day-5 candle's close of 500.
    expect(out.points.at(-1)).toMatchObject({ at: day(5, 12).toISOString(), valueUsd: '900' });
  });
});

describe('holdingsChange: what rose and fell in amount over a range (J-portfolio-06 #3)', () => {
  it('gives each coin its amount at both ends, the change between them and its price and value there', () => {
    const out = holdingsChange({ histories: [MAIN, SAVINGS], interval: '1d', samples, live: false, closes: new Map([['BTC', daily(0)]]) });
    expect(bankHoldingsChangeSchema.parse(out)).toEqual(out);
    // From day 1 (nothing held yet; BTC at the day-0 close of 0) to day 5: 1 BTC across both accounts at the day-4 close of
    // 400, and 400 USDT at 1.
    expect(out.rows).toEqual([
      {
        assetId: 'BTC',
        startAmount: '0',
        endAmount: '1',
        change: '1',
        startPriceUsd: '0',
        endPriceUsd: '400',
        startValueUsd: '0',
        endValueUsd: '400',
      },
      {
        assetId: 'USDT',
        startAmount: '0',
        endAmount: '400',
        change: '400',
        startPriceUsd: '1',
        endPriceUsd: '1',
        startValueUsd: '0',
        endValueUsd: '400',
      },
    ]);
  });

  it('counts what fell, leaves out a coin held at neither end, and never prices a coin with no market', () => {
    const withSol = history({ BTC: '0.5', USDT: '400', SOL: '3' }, [
      ...MAIN.movements,
      move(3, 'SOL', 'ledger', 'deposit.credited', '3', '0'),
    ]);
    const out = holdingsChange({
      histories: [withSol, SAVINGS],
      interval: '1d',
      samples: [day(4), day(5)],
      live: false,
      closes: new Map<string, CloseSeries | null>([
        ['BTC', daily(0)],
        ['SOL', null],
      ]),
    });
    // Day 4 to day 5: the 100 USDT withdrawn on day 4 is the fall; BTC moved between own accounts, so it did not change.
    expect(out.rows.map((r) => [r.assetId, r.startAmount, r.endAmount, r.change])).toEqual([
      ['BTC', '1', '1', '0'],
      ['SOL', '3', '3', '0'],
      ['USDT', '500', '400', '-100'],
    ]);
    expect(out.rows.find((r) => r.assetId === 'SOL')).toMatchObject({ startPriceUsd: null, endPriceUsd: null, endValueUsd: null });
  });
});

describe('valueOverTime: the change-in-value bridge', () => {
  it('opening + deposits − withdrawals − fees + other flows + market move = closing, and own moves cancel', () => {
    const { bridge } = valueOverTime({
      histories: [MAIN, SAVINGS],
      interval: '1d',
      samples,
      live: false,
      closes: new Map([['BTC', daily(0)]]),
    });
    // The fee is 0.01 BTC at the close by the end of its day (the day-3 candle, 300): 3. The market move is the rest:
    // 800 − 0 − 1000 + 100 + 3 − 0 = −97 (1 BTC bought for 500 now worth 400, less the fee already counted).
    expect(bridge).toEqual({
      openingUsd: '0',
      depositsUsd: '1000',
      withdrawalsUsd: '100',
      feesUsd: '3',
      otherFlowsUsd: '0',
      marketMoveUsd: '-97',
      closingUsd: '800',
      missing: [],
    });
  });

  it('counts other money in and out at its value then, and leaves a past end’s later movements out', () => {
    const reward = history({ BTC: '0.6', USDT: '450' }, [
      ...MAIN.movements,
      move(3, 'BTC', 'token', 'token.yield.distributed', '0.1', '0'),
      move(4, 'USDT', 'ledger', 'deposit.credited', '50', '0'),
    ]);
    const { bridge } = valueOverTime({
      histories: [reward, SAVINGS],
      interval: '1d',
      samples: samples.slice(0, 4),
      live: false,
      closes: new Map([['BTC', daily(0)]]),
    });
    // To day 4: 0.1 BTC of reward during day 3, at the close by its end (300), is 30 of other flows. The day-4 deposit and
    // withdrawal are after the end, so they are not counted. Closing: 1.1 BTC at 300 + 500 USDT.
    expect(bridge).toMatchObject({
      openingUsd: '0',
      depositsUsd: '1000',
      withdrawalsUsd: '0',
      feesUsd: '3',
      otherFlowsUsd: '30',
      closingUsd: '830',
    });
    const sum =
      amt(bridge.openingUsd!) +
      amt(bridge.depositsUsd!) -
      amt(bridge.withdrawalsUsd!) -
      amt(bridge.feesUsd!) +
      amt(bridge.otherFlowsUsd!) +
      amt(bridge.marketMoveUsd!);
    expect(sum).toBe(amt(bridge.closingUsd!));
  });

  it('is unknown, with the coin named, when a part of it has no price', () => {
    const { bridge } = valueOverTime({
      histories: [MAIN, SAVINGS],
      interval: '1d',
      samples,
      live: false,
      closes: new Map<string, CloseSeries | null>([['BTC', null]]),
    });
    expect(bridge).toMatchObject({
      openingUsd: '0',
      depositsUsd: null,
      marketMoveUsd: null,
      closingUsd: null,
      missing: [{ assetId: 'BTC', reason: 'no_price' }],
    });
  });
});

describe('the grid', () => {
  it('picks the finest candle that fits, reads weeks in days, and sets the moments on the ledger grid', () => {
    expect(chooseInterval(day(9), day(10), day(10))).toBe('5m');
    expect(chooseInterval(new Date(day(10).getTime() - 365 * DAY), day(10), day(10))).toBe('1d');
    expect(chooseInterval(new Date(day(10).getTime() - 20 * 365 * DAY), day(10), day(10))).toBeNull();
    expect(bucketOf('1w')).toBe(86_400);
    expect(bucketOf('5m')).toBe(300);
    const grid = gridOf(day(1, 7), day(3, 7), day(10), '1d')!;
    expect(grid.samples.map((d) => d.toISOString())).toEqual([day(1), day(2), day(3)].map((d) => d.toISOString()));
    expect(grid.live).toBe(false);
    expect(gridOf(day(3, 1), day(3, 2), day(10), '1d')).toBeNull();
    expect(gridOf(day(9, 7), day(11), day(10, 5), '1d')!.samples.at(-1)!.toISOString()).toBe(day(10, 5).toISOString());
  });
});

const space = (id: string, userId: string): SpaceRecord => ({
  id,
  userId,
  assetId: 'USDT',
  kind: 'named',
  name: 'Savings',
  goalTarget: null,
  lockedUntil: null,
  unlockRequestedAt: null,
  unlocksAt: null,
  archivedAt: null,
});

function service(options: { fail?: Error; closes?: CloseSeriesSource | null } = {}) {
  const asked: LedgerHoldingsHistoryInput[] = [];
  const portfolio = new PortfolioService(
    { balances: async () => [] },
    {
      namedSpaces: async () => [space(SPACE, ALICE), space(BOBS_SPACE, BOB)],
      // An archived Space, emptied before the range: history reads still see it.
      allNamedSpaces: async () => [space(SPACE, ALICE), { ...space(CLOSED, ALICE), archivedAt: day(1) }, space(BOBS_SPACE, BOB)],
    },
    {
      now: () => day(5, 12),
      history: {
        holdingsHistory: async (input) => {
          asked.push(input);
          if (options.fail) throw options.fail;
          return input.ownerType === 'user' ? MAIN : input.ownerId === CLOSED ? history({}, []) : SAVINGS;
        },
      },
      ...(options.closes === null ? {} : { closes: options.closes ?? { closes: async () => daily(0) } }),
    },
  );
  return { portfolio, asked };
}

function callerFor(portfolio: PortfolioService, userId: string) {
  const SECRET = 'a-bank-value-history-edge-secret-long-enough';
  const raw = encodePrincipal({
    sub: userId,
    userId,
    sid: '33333333-3333-4333-8333-333333333333',
    scopes: ['bank:read'],
    tier: 'full',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal);
  return createBankRouter({ portfolio } as unknown as BankServices).createCaller(
    createEdgeContext({ secret: SECRET, serviceName: 'svc-bank' })({
      headers: {
        'x-intafaced-principal': raw,
        'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
        'x-intafaced-region': 'DE',
      },
      id: 'req-value',
    }),
  );
}

describe('PortfolioService.valueOverTime', () => {
  it('reads the caller’s main account and own named Spaces only (archived ones too), from the start of the grid, in the bucket the range needs', async () => {
    const { portfolio, asked } = service();
    const out = await callerFor(portfolio, ALICE).portfolio.valueOverTime({ from: day(1, 7).toISOString(), to: day(5).toISOString() });
    // Under four days fits hourly candles, so the ledger is read by the hour from the hour the range starts in.
    expect(asked).toEqual([
      { ownerType: 'user', ownerId: ALICE, from: day(1, 7).toISOString(), bucketSeconds: 3_600 },
      { ownerType: 'subaccount', ownerId: SPACE, from: day(1, 7).toISOString(), bucketSeconds: 3_600 },
      { ownerType: 'subaccount', ownerId: CLOSED, from: day(1, 7).toISOString(), bucketSeconds: 3_600 },
    ]);
    expect(out.interval).toBe('1h');
    expect(out.points[0]).toMatchObject({ at: day(1, 7).toISOString(), valueUsd: '0' });
    expect(out.points.find((p) => p.at === day(3).toISOString())?.valueUsd).toBe('1000');
    expect(out.points.at(-1)).toMatchObject({ at: day(5).toISOString(), valueUsd: '800' });
    // Nobody else can be asked about: the input has no owner, and a smuggled one is refused.
    await expect(
      callerFor(portfolio, ALICE).portfolio.valueOverTime({ from: day(1).toISOString(), userId: BOB } as never),
    ).rejects.toThrow();
  });

  it('refuses a range that is empty, in the future or too long ago, by name', async () => {
    const { portfolio } = service();
    await expect(portfolio.valueOverTime(ALICE, { from: day(5).toISOString(), to: day(4).toISOString() })).rejects.toMatchObject({
      code: 'bank.value_range_invalid',
    });
    await expect(portfolio.valueOverTime(ALICE, { from: day(6).toISOString() })).rejects.toMatchObject({
      code: 'bank.value_range_invalid',
    });
    await expect(portfolio.valueOverTime(ALICE, { from: new Date(day(5).getTime() - 20 * 365 * DAY).toISOString() })).rejects.toMatchObject(
      {
        code: 'bank.value_range_too_long',
      },
    );
  });

  it('names a ledger answer too large, and refuses rather than guesses when the ledger or the prices cannot be read', async () => {
    const tooBig = service({ fail: new LedgerError('too many rows', 'ledger.holdings_history_too_large') });
    await expect(tooBig.portfolio.valueOverTime(ALICE, { from: day(1).toISOString() })).rejects.toMatchObject({
      code: 'bank.value_history_too_large',
    });
    const down = service({ fail: new Error('connection reset') });
    await expect(down.portfolio.valueOverTime(ALICE, { from: day(1).toISOString() })).rejects.toMatchObject({
      code: 'bank.value_history_unavailable',
    });
    const noPrices = service({ closes: null });
    await expect(noPrices.portfolio.valueOverTime(ALICE, { from: day(1).toISOString() })).rejects.toMatchObject({
      code: 'bank.prices_unavailable',
    });
    const pricesDown = service({ closes: { closes: async () => Promise.reject(new Error('timeout')) } });
    await expect(pricesDown.portfolio.valueOverTime(ALICE, { from: day(1).toISOString() })).rejects.toMatchObject({
      code: 'bank.prices_unavailable',
    });
    const unwired = new PortfolioService({ balances: async () => [] }, { namedSpaces: async () => [] }, { now: () => day(5) });
    await expect(unwired.valueOverTime(ALICE, { from: day(1).toISOString() })).rejects.toMatchObject({
      code: 'bank.value_history_unavailable',
    });
  });
});

describe('PortfolioService.holdingsChange', () => {
  it('gives the two ends through the router for the caller only, with the same range refusals as the value over time', async () => {
    const { portfolio } = service();
    const out = await callerFor(portfolio, ALICE).portfolio.holdingsChange({ from: day(1, 7).toISOString(), to: day(5).toISOString() });
    expect(out.rows.map((r) => [r.assetId, r.startAmount, r.endAmount, r.change])).toEqual([
      ['BTC', '0', '1', '1'],
      ['USDT', '0', '400', '400'],
    ]);
    await expect(
      callerFor(portfolio, ALICE).portfolio.holdingsChange({ from: day(1).toISOString(), userId: BOB } as never),
    ).rejects.toThrow();
    await expect(portfolio.holdingsChange(ALICE, { from: day(6).toISOString() })).rejects.toMatchObject({
      code: 'bank.value_range_invalid',
    });
    const tooBig = service({ fail: new LedgerError('too many rows', 'ledger.holdings_history_too_large') });
    await expect(tooBig.portfolio.holdingsChange(ALICE, { from: day(1).toISOString() })).rejects.toMatchObject({
      code: 'bank.value_history_too_large',
    });
    const down = service({ fail: new Error('connection reset') });
    await expect(down.portfolio.holdingsChange(ALICE, { from: day(1).toISOString() })).rejects.toMatchObject({
      code: 'bank.value_history_unavailable',
    });
  });

  it('still answers the amounts when the prices cannot be read: those coins are not priced, never zero', async () => {
    for (const closes of [null, { closes: async () => Promise.reject(new Error('timeout')) }]) {
      const { portfolio } = service({ closes });
      const out = await portfolio.holdingsChange(ALICE, { from: day(1, 7).toISOString(), to: day(5).toISOString() });
      expect(out.rows.find((r) => r.assetId === 'BTC')).toMatchObject({ endAmount: '1', endPriceUsd: null, endValueUsd: null });
      // Dollar coins need no price.
      expect(out.rows.find((r) => r.assetId === 'USDT')).toMatchObject({ endPriceUsd: '1', endValueUsd: '400' });
    }
  });
});
