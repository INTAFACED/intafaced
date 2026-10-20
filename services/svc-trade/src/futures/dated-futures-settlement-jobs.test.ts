/**
 * H6 — JobHost actually invokes dated futures settlement (not mill-only).
 *
 * Blank TRADE_FUTURES_SETTLEMENT_FIXING refuses. Owner decimal posts
 * ledger-client recipes. lastTrade / mark are ignored. Env default stays empty.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  MemoryLedger,
  formatAmount,
  futuresLossSink,
  parseAmount as amt,
  positionCollateralAccount,
  recipes,
  userAvailable,
  houseFees,
} from '@intafaced/ledger-client';
import { DATED_FUTURES_SETTLEMENT_PRICE_UNSET, datedSettlementIdFor } from './dated-futures-settlement.js';
import { startFuturesJobs } from './futures-jobs.js';

const here = dirname(fileURLToPath(import.meta.url));
const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const POS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MARKET = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const EXPIRY = new Date('2026-12-26T08:00:00.000Z');
const AFTER = new Date('2026-12-26T08:00:01.000Z');

function captureIntervals() {
  const timers: Array<{ id: number; fn: () => unknown; ms: number }> = [];
  let nextId = 1;
  return {
    timers,
    setIntervalFn: ((fn: () => void, ms: number) => {
      const id = nextId++;
      timers.push({ id, fn, ms });
      return id as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval,
    clearIntervalFn: ((id: number) => {
      const i = timers.findIndex((t) => t.id === id);
      if (i >= 0) timers.splice(i, 1);
    }) as typeof clearInterval,
  };
}

function longPosition() {
  return {
    positionId: POS,
    userId: ALICE,
    side: 'long' as const,
    size: amt('1'),
    entryPrice: amt('100'),
    margin: amt('20'),
    marginAsset: 'USDT',
  };
}

/**
 * Alice locks 20 of a 1000 deposit. Bob is the loser on the other side: his
 * 50 deposit, margin lock and realised loss fill the clearing pot
 * (`futuresLossSink`), the account losers pay into and `futuresRealizeProfit`
 * pays winners from.
 */
async function seedMarginAndProfitPot(ledger: MemoryLedger) {
  await ledger.post(recipes.deposit({ userId: ALICE, assetId: 'USDT', amount: amt('1000'), rail: 'test', railRef: 'alice-usdt' }));
  await ledger.post(recipes.futuresMarginLock({ positionId: POS, userId: ALICE, assetId: 'USDT', amount: amt('20') }));
  await ledger.post(recipes.deposit({ userId: BOB, assetId: 'USDT', amount: amt('50'), rail: 'test', railRef: 'bob-loser-seed' }));
  await ledger.post(recipes.futuresMarginLock({ positionId: 'loser-pot-seed', userId: BOB, assetId: 'USDT', amount: amt('50') }));
  await ledger.post(
    recipes.futuresRealizeLoss({
      positionId: 'loser-pot-seed',
      userId: BOB,
      assetId: 'USDT',
      fromMargin: amt('50'),
      fromInsurance: 0n,
      lossId: 'pot-seed',
    }),
  );
}

function mockSql() {
  return Object.assign((strings: TemplateStringsArray) => {
    void strings;
    return Promise.resolve([]);
  }, {}) as never;
}

describe('H6 JobHost dated settlement source', () => {
  it('schedules futures.dated_settlement via scan; never last-trade as owner price', () => {
    const jobs = readFileSync(join(here, 'futures-jobs.ts'), 'utf8');
    expect(jobs).toMatch(/host\.every\('futures\.dated_settlement'/);
    expect(jobs).toMatch(/runDatedFuturesSettlementScan/);
    expect(jobs).toMatch(/settlementFixingConfigured:\s*deps\.config\.settlementFixing/);
    expect(jobs).not.toMatch(/ownerSettlementPriceFor:\s*deps\.lastTradePrice/);
    expect(jobs).not.toMatch(/ownerSettlementPrice:\s*(deps\.)?lastTrade/);
    expect(jobs).not.toMatch(/ownerSettlementPriceFor:\s*[\s\S]{0,80}markPrice/);
    const mill = readFileSync(join(here, 'dated-futures-settlement.ts'), 'utf8');
    expect(mill).toMatch(/void input\.lastTradePrice/);
    expect(mill).toMatch(/void input\.markPrice/);
    expect(mill).not.toMatch(/exitPrice:\s*input\.lastTradePrice/);
    const envSrc = readFileSync(join(here, '..', 'env.ts'), 'utf8');
    expect(envSrc).toMatch(/TRADE_FUTURES_SETTLEMENT_FIXING:\s*z\.string\(\)\.default\(''\)/);
    const indexSrc = readFileSync(join(here, '..', 'index.ts'), 'utf8');
    expect(indexSrc).toMatch(/settlementFixing:\s*env\.TRADE_FUTURES_SETTLEMENT_FIXING/);
    expect(indexSrc).not.toMatch(/ownerSettlementPriceFor/);
    expect(indexSrc).not.toMatch(/TRADE_FUTURES_SETTLEMENT_FIXING:\s*['"][0-9]/);
  });
});

describe('H6 JobHost invokes settlement mill', () => {
  it('interval tick posts owner decimal recipes and ignores last trade 1 / mark 2', async () => {
    const ledger = new MemoryLedger();
    await seedMarginAndProfitPot(ledger);
    const before = ledger.journal().length;
    const closed: string[] = [];
    const clock = captureIntervals();
    const millCalls = { n: 0 };
    const handle = startFuturesJobs({
      sql: mockSql(),
      ledger,
      matching: { depth: async () => ({ bids: [], asks: [], sequence: 0 }) } as never,
      bus: null,
      now: () => AFTER,
      setIntervalFn: clock.setIntervalFn,
      clearIntervalFn: clock.clearIntervalFn,
      lastTradePrice: '1',
      markPrice: '2',
      ownerSettlementPriceFor: () => '110',
      datedSettlement: {
        markets: {
          listExpiredDated: async () => {
            millCalls.n += 1;
            return [{ marketId: MARKET, style: 'dated', expiryAt: EXPIRY }];
          },
        },
        positions: { listOpenForMarket: async () => [longPosition()] },
        markClosed: async (id) => {
          closed.push(id);
        },
      },
      config: {
        enabled: true,
        liqIntervalMs: 15_000,
        fundingIntervalMs: null,
        fundingMarketIds: [],
        fundingMaxAbsRate: null,
        settlementFixing: 'owner-stamp',
      },
    });
    expect(handle.host.list()).toContain('futures.dated_settlement');
    expect(clock.timers[0]!.ms).toBe(15_000);
    await clock.timers[0]!.fn();
    expect(millCalls.n).toBe(1);
    expect(ledger.journal().length).toBe(before + 2);
    expect(
      ledger
        .journal()
        .slice(before)
        .map((p) => p.reason),
    ).toEqual(['futures.profit.realized', 'futures.margin.release']);
    expect(formatAmount((await ledger.balance(positionCollateralAccount(ALICE, 'USDT', POS))).amount)).toBe('0');
    // 1000 - 20 lock + 10 profit + 20 release = 1010. Clearing pot 50 - 10 = 40.
    expect(formatAmount((await ledger.balance(userAvailable(ALICE, 'USDT'))).amount)).toBe('1010');
    expect(formatAmount((await ledger.balance(futuresLossSink('USDT'))).amount)).toBe('40');
    // House trade fees never pay a winner.
    expect(formatAmount((await ledger.balance(houseFees('trade', 'USDT'))).amount)).toBe('0');
    expect(ledger.reconcile()).toEqual({ ok: true });
    expect(closed).toEqual([POS]);
    expect(datedSettlementIdFor(POS)).toBe(`dated-settle:${POS}`);
    handle.stop();
  });

  it('blank TRADE_FUTURES_SETTLEMENT_FIXING refuses the JobHost tick; last trade is not settlement', async () => {
    const ledger = new MemoryLedger();
    await seedMarginAndProfitPot(ledger);
    const before = ledger.journal().length;
    const clock = captureIntervals();
    let sawMarket = false;
    const handle = startFuturesJobs({
      sql: mockSql(),
      ledger,
      matching: { depth: async () => ({ bids: [], asks: [], sequence: 0 }) } as never,
      bus: null,
      now: () => AFTER,
      setIntervalFn: clock.setIntervalFn,
      clearIntervalFn: clock.clearIntervalFn,
      lastTradePrice: '1',
      markPrice: '2',
      ownerSettlementPriceFor: () => '999',
      datedSettlement: {
        markets: {
          listExpiredDated: async () => {
            sawMarket = true;
            return [{ marketId: MARKET, style: 'dated', expiryAt: EXPIRY }];
          },
        },
        positions: { listOpenForMarket: async () => [longPosition()] },
        markClosed: async () => {
          throw new Error('must not close on refuse');
        },
      },
      config: {
        enabled: true,
        liqIntervalMs: 15_000,
        fundingIntervalMs: null,
        fundingMarketIds: [],
        fundingMaxAbsRate: null,
        settlementFixing: '',
      },
    });
    await clock.timers[0]!.fn();
    expect(sawMarket).toBe(true);
    expect(ledger.journal()).toHaveLength(before);
    expect(formatAmount((await ledger.balance(positionCollateralAccount(ALICE, 'USDT', POS))).amount)).toBe('20');
    expect(ledger.reconcile()).toEqual({ ok: true });
    handle.stop();
    expect(DATED_FUTURES_SETTLEMENT_PRICE_UNSET).toBe('trade.dated_futures_settlement_price_unset');
  });

  it('stamp set but no owner decimal (production) refuses; last trade is not a fallback', async () => {
    const ledger = new MemoryLedger();
    await seedMarginAndProfitPot(ledger);
    const before = ledger.journal().length;
    const clock = captureIntervals();
    const handle = startFuturesJobs({
      sql: mockSql(),
      ledger,
      matching: { depth: async () => ({ bids: [], asks: [], sequence: 0 }) } as never,
      bus: null,
      now: () => AFTER,
      setIntervalFn: clock.setIntervalFn,
      clearIntervalFn: clock.clearIntervalFn,
      lastTradePrice: '1',
      markPrice: '2',
      datedSettlement: {
        markets: {
          listExpiredDated: async () => [{ marketId: MARKET, style: 'dated', expiryAt: EXPIRY }],
        },
        positions: { listOpenForMarket: async () => [longPosition()] },
        markClosed: async () => {
          throw new Error('must not close on refuse');
        },
      },
      config: {
        enabled: true,
        liqIntervalMs: 15_000,
        fundingIntervalMs: null,
        fundingMarketIds: [],
        fundingMaxAbsRate: null,
        settlementFixing: 'owner-stamp',
      },
    });
    await clock.timers[0]!.fn();
    expect(ledger.journal()).toHaveLength(before);
    handle.stop();
  });
});
