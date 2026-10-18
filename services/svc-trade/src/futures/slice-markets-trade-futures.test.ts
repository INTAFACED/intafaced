/**
 * S34 markets — services/svc-trade/src/futures
 * MKT-0057, MKT-0082, MKT-0085, MKT-0105, MKT-0106, MKT-0107, MKT-0126, MKT-0128.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { serviceAuthHeadersForBody } from '@intafaced/contracts';
import { parseAmount as amt } from '@intafaced/ledger-client';
import { DEFAULT_FUTURES_MARK_POLICY, acceptableForLiquidation, judgeLiquidationMark, type FuturesQuotedMark } from './mark-policy.js';
import { memoryLiquidationAttemptStore, runLiquidationTick } from './liquidation-tick.js';
import { memoryAcceptedMarkStore } from './accepted-mark.js';
import { markSourceFromBook } from './mark-source.js';
import { presentFundingHistory, registerFundingHistory, type FundingHistoryListing, type FundingHistoryRow } from './funding-history.js';
import { exportMarkHistory } from './mark-history.js';
import { MemoryApprovalBook, payloadHash } from '../admin/common.js';
import { registerInternalFundingRate } from './internal-funding-rate.js';
import type { FundingRateEntry } from './funding-rate-source.js';

const NOW = new Date('2026-08-06T12:00:00.000Z');
const SECRET = 'test-internal-secret-for-trade-funding-rate';

function freshMark(): FuturesQuotedMark {
  return { marketId: 'btc-perp', price: amt('50000'), asOf: NOW, quality: 'mid' };
}

describe('MKT-0057 unpublished liquidation max age', () => {
  it('refuses the judgment and does not treat compiled 60, 300 and 2000 as a publication', () => {
    const mark = freshMark();
    const check = judgeLiquidationMark(mark, null, NOW, null);
    expect(check.ok).toBe(false);
    expect(check.code).toBe('trade.mark_unusable');
    expect(check.reason).toContain('300');
    expect(check.reason).toContain('60');
    expect(check.reason).toContain('2000');
    expect(check.reason).toMatch(/not an owner publication/);
    // The same fresh mark would pass if those compiled figures were the policy.
    expect(acceptableForLiquidation(mark, null, NOW, DEFAULT_FUTURES_MARK_POLICY).ok).toBe(true);
  });

  it('the liquidation tick does not seize when no limits were published', async () => {
    const closed: string[] = [];
    const result = await runLiquidationTick({
      marks: {
        async quote() {
          return freshMark();
        },
        async markPrice() {
          return '50000';
        },
      },
      positions: {
        async listOpen() {
          return [
            {
              positionId: 'pos-1',
              userId: '11111111-1111-4111-8111-111111111111',
              side: 'long',
              size: amt('1'),
              entryPrice: amt('100'),
              margin: amt('10'),
              marginAsset: 'USDT',
              marketId: 'btc-perp',
              symbol: 'BTC/USDT-PERP',
            },
          ];
        },
      },
      closer: {
        async markLiquidated(id) {
          closed.push(id);
        },
      },
      attempts: memoryLiquidationAttemptStore(),
      acceptedMarks: memoryAcceptedMarkStore(),
      ledger: {
        async post() {
          throw new Error('unpublished limits must not post');
        },
        async balance() {
          throw new Error('unpublished limits must not read a balance');
        },
      },
      now: () => NOW,
      publishedLiquidationLimits: null,
    });
    expect(result.liquidated).toBe(0);
    expect(closed).toEqual([]);
    expect(result.items[0]?.outcome).toBe('skipped_mark_unusable');
    expect(result.items[0]?.summary).toMatch(/not an owner publication/);
  });

  it('production liquidation jobs pass null published limits', () => {
    const src = readFileSync(new URL('./futures-jobs.ts', import.meta.url), 'utf8');
    expect(src).toContain('publishedLiquidationLimits: null');
  });
});

const spot: FundingHistoryListing = {
  id: 'spot-1',
  symbol: 'BTC-USDT',
  kind: 'spot',
};
const perp: FundingHistoryListing = {
  id: 'perp-1',
  symbol: 'BTC/USDT-PERP',
  kind: 'futures',
  futuresContractStyle: 'perpetual',
};
const option: FundingHistoryListing = {
  id: 'opt-1',
  symbol: 'BTC-OPT',
  kind: 'options',
};

function historyApp(markets: Record<string, FundingHistoryListing | null>, rows: readonly FundingHistoryRow[] | null | 'throw') {
  const app = Fastify();
  registerFundingHistory(app, {
    marketBySymbol: async (symbol) => markets[symbol] ?? null,
    historyForMarket: async () => {
      if (rows === 'throw') throw new Error('provider down');
      return rows;
    },
  });
  return app;
}

describe('MKT-0082 MKT-0085 MKT-0105 MKT-0106 funding history', () => {
  it('refuses a symbol that is not a perpetual with HTTP 400 and no rate list', async () => {
    const app = historyApp({ 'BTC-OPT': option }, [
      { marketId: 'opt-1', periodId: 'p', periodTimestamp: 1, fundingRate: '0.1', markPrice: '1' },
    ]);
    const res = await app.inject({ method: 'GET', url: '/api/v1/funding-history/BTC-OPT' });
    expect(res.statusCode).toBe(400);
    const body = res.json() as Record<string, unknown>;
    expect(body.rates).toBeUndefined();
    expect(body.fundingRate).toBeUndefined();
    expect(JSON.stringify(body)).not.toMatch(/fundingRate/);
    await app.close();
  });

  it('returns a perpetual history sorted ascending by period time, including mark_price', () => {
    const rows: FundingHistoryRow[] = [
      { marketId: 'perp-1', periodId: 'late', periodTimestamp: 3_000, fundingRate: '0.0003', markPrice: '103' },
      { marketId: 'perp-1', periodId: 'early', periodTimestamp: 1_000, fundingRate: '0.0001', markPrice: '101' },
      { marketId: 'perp-1', periodId: 'mid', periodTimestamp: 2_000, fundingRate: '0.0002', markPrice: '102' },
    ];
    const presented = presentFundingHistory({ symbol: perp.symbol, market: perp, rows });
    expect(presented.status).toBe(200);
    const rates = presented.body.rates as { periodId: string; mark_price: string }[];
    expect(rates.map((row) => row.periodId)).toEqual(['early', 'mid', 'late']);
    expect(rates[0]?.mark_price).toBe('101');
    expect(rates).toHaveLength(3);
  });

  it('refuses spot funding history as trade.funding_rate_spot_market with no fundingRate', async () => {
    const app = historyApp({ 'BTC-USDT': spot }, [
      { marketId: 'spot-1', periodId: 'p', periodTimestamp: 1, fundingRate: '0.1', markPrice: '1' },
    ]);
    const res = await app.inject({ method: 'GET', url: '/api/v1/funding-history/BTC-USDT' });
    const body = res.json() as Record<string, unknown>;
    expect(body.intafacedCode).toBe('trade.funding_rate_spot_market');
    expect(body.fundingRate).toBeUndefined();
    expect(JSON.stringify(body)).not.toMatch(/fundingRate/);
    await app.close();
  });

  it('refuses a perpetual with no published rate and does not answer fundingRate 0', async () => {
    const app = historyApp({ 'BTC/USDT-PERP': perp }, null);
    const res = await app.inject({ method: 'GET', url: '/api/v1/funding-history/' + encodeURIComponent('BTC/USDT-PERP') });
    const body = res.json() as Record<string, unknown>;
    expect(body.intafacedCode).toBe('trade.funding_rate_unavailable');
    expect(body.fundingRate).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('"fundingRate"');
    expect(JSON.stringify(body)).not.toContain('"0"');
    await app.close();
  });

  it('a provider failure is unavailable and is not fundingRate 0', async () => {
    const app = historyApp({ 'BTC/USDT-PERP': perp }, 'throw');
    const res = await app.inject({ method: 'GET', url: '/api/v1/funding-history/' + encodeURIComponent('BTC/USDT-PERP') });
    const body = res.json() as Record<string, unknown>;
    expect(body.intafacedCode).toBe('trade.funding_rate_unavailable');
    expect(JSON.stringify(body)).not.toContain('"fundingRate"');
    await app.close();
  });
});

describe('MKT-0107 mark history export', () => {
  it('leaves an unpublished period mark null and does not copy the last trade', () => {
    const [slot] = exportMarkHistory([
      { periodId: 'p1', riskMark: null, lastTrade: '48000' },
      { periodId: 'p2', riskMark: '50000', lastTrade: '49900' },
    ]);
    expect(slot?.mark).toBeNull();
    expect(JSON.stringify(slot)).not.toContain('48000');
    const exported = exportMarkHistory([{ periodId: 'p2', riskMark: '50000', lastTrade: '49900' }]);
    expect(exported[0]?.mark).toBe('50000');
  });
});

describe('MKT-0126 mark quote without observedAt', () => {
  it('returns null and does not store the caller clock', async () => {
    const caller = new Date('2030-01-01T00:00:00.000Z');
    const src = markSourceFromBook({
      readBook: async () => ({ bestBid: '100', bestAsk: '102', last: '99' }),
      now: () => caller,
    });
    const quote = await src.quote({ marketId: 'm1', at: caller });
    expect(quote).toBeNull();
    expect(await src.markPrice({ marketId: 'm1', at: caller })).toBeNull();
  });
});

describe('MKT-0128 funding publish consumes a four-eyes approval', () => {
  const PATH = '/internal/futures/funding-rate';

  function signed(payload: unknown) {
    const raw = JSON.stringify(payload);
    return {
      headers: { 'content-type': 'application/json', ...serviceAuthHeadersForBody('svc-oracle', SECRET, raw) },
      payload: raw,
    };
  }

  function post(app: ReturnType<typeof Fastify>, payload: unknown) {
    return app.inject({ method: 'POST', url: PATH, ...signed(payload) });
  }

  function appWith(published: FundingRateEntry[], history: FundingHistoryRow[], approvals: MemoryApprovalBook | null) {
    const app = Fastify();
    registerInternalFundingRate(app, {
      internalSecret: SECRET,
      publishFundingRate: (entry) => published.push(entry),
      recordFundingHistory: (row) => history.push(row),
      maxAbsRate: '1',
      now: () => 1_700_000_000_000,
      approvals,
    });
    return app;
  }

  function bind(
    book: MemoryApprovalBook,
    input: {
      approvalId: string;
      marketId: string;
      periodId: string;
      rate: string;
      markPrice: string | null;
      requesterId: string;
      approverId: string;
    },
  ) {
    book.put({
      approvalId: input.approvalId,
      actionType: 'trade.funding_rate.publish',
      targetService: 'svc-trade',
      targetId: input.marketId,
      expectedVersion: input.periodId,
      payloadHash: payloadHash({
        actionType: 'trade.funding_rate.publish',
        marketId: input.marketId,
        periodId: input.periodId,
        rate: input.rate,
        markPrice: input.markPrice,
      }),
      requesterId: input.requesterId,
      approverId: input.approverId,
    });
  }

  it('a service secret alone publishes nothing', async () => {
    const published: FundingRateEntry[] = [];
    const app = appWith(published, [], new MemoryApprovalBook());
    const secretOnly = await post(app, { marketId: 'm1', rate: '0.0001', periodId: 'm1:p0' });
    expect(secretOnly.statusCode).toBe(403);
    expect(published).toEqual([]);
    await app.close();
  });

  it('two posts with the same secret and different free-text operator ids publish nothing', async () => {
    const published: FundingRateEntry[] = [];
    const app = appWith(published, [], new MemoryApprovalBook());
    const body = { marketId: 'm1', rate: '0.0001', periodId: 'm1:p0' };
    const first = await post(app, { ...body, operatorId: 'operator-a' });
    const second = await post(app, { ...body, operatorId: 'operator-b' });
    expect(first.statusCode).toBe(403);
    expect(second.statusCode).toBe(403);
    expect(published).toEqual([]);
    await app.close();
  });

  it('a missing approval book refuses even when an approval id is sent', async () => {
    const published: FundingRateEntry[] = [];
    const app = appWith(published, [], null);
    const res = await post(app, { marketId: 'm1', rate: '0.0001', periodId: 'm1:p0', approvalId: 'apr-1' });
    expect(res.statusCode).toBe(403);
    expect(published).toEqual([]);
    await app.close();
  });

  it('refuses an approval whose requester is the approver', async () => {
    const published: FundingRateEntry[] = [];
    const book = new MemoryApprovalBook();
    const app = appWith(published, [], book);
    const body = { marketId: 'm1', rate: '0.0001', periodId: 'm1:p0', markPrice: '50000' };
    bind(book, {
      approvalId: 'apr-self',
      marketId: 'm1',
      periodId: 'm1:p0',
      rate: '0.0001',
      markPrice: '50000',
      requesterId: 'same-person',
      approverId: 'same-person',
    });
    const res = await post(app, { ...body, approvalId: 'apr-self' });
    expect(res.statusCode).toBe(403);
    expect(published).toEqual([]);
    await app.close();
  });

  it('refuses an approval bound to a different rate', async () => {
    const published: FundingRateEntry[] = [];
    const book = new MemoryApprovalBook();
    const app = appWith(published, [], book);
    bind(book, {
      approvalId: 'apr-other-rate',
      marketId: 'm1',
      periodId: 'm1:p0',
      rate: '0.0002',
      markPrice: '50000',
      requesterId: 'requester-1',
      approverId: 'approver-2',
    });
    const res = await post(app, {
      marketId: 'm1',
      rate: '0.0001',
      periodId: 'm1:p0',
      markPrice: '50000',
      approvalId: 'apr-other-rate',
    });
    expect(res.statusCode).toBe(403);
    expect(published).toEqual([]);
    await app.close();
  });

  it('publishes once for a bound approval, replays as a duplicate, and refuses reuse on another period', async () => {
    const published: FundingRateEntry[] = [];
    const history: FundingHistoryRow[] = [];
    const book = new MemoryApprovalBook();
    const app = appWith(published, history, book);
    const body = { marketId: 'm1', rate: '0.0001', periodId: 'm1:p1', markPrice: '50000' };
    bind(book, {
      approvalId: 'apr-ok',
      marketId: 'm1',
      periodId: 'm1:p1',
      rate: '0.0001',
      markPrice: '50000',
      requesterId: 'requester-1',
      approverId: 'approver-2',
    });
    const stored = await post(app, { ...body, approvalId: 'apr-ok' });
    expect(stored.statusCode).toBe(200);
    expect(stored.json().approverId).toBe('approver-2');
    expect(published).toHaveLength(1);
    expect(history).toEqual([expect.objectContaining({ markPrice: '50000', fundingRate: '0.0001', periodId: 'm1:p1' })]);

    const replay = await post(app, { ...body, approvalId: 'apr-ok' });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().duplicate).toBe(true);
    expect(published).toHaveLength(1);
    expect(history).toHaveLength(1);

    const reused = await post(app, {
      marketId: 'm1',
      rate: '0.0001',
      periodId: 'm1:p2',
      markPrice: '50000',
      approvalId: 'apr-ok',
    });
    expect(reused.statusCode).toBe(403);
    expect(published).toHaveLength(1);
    expect(history).toHaveLength(1);
    await app.close();
  });
});
