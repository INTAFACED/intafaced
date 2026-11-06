import { describe, expect, it } from 'vitest';
import { MemoryLedger, parseAmount as amt, recipes } from '@intafaced/ledger-client';
import type { EngineCancelResult, EngineDepth, EngineSubmitRequest, EngineSubmitResult, MatchingClient } from '../spot/matching-client.js';
import { startMmSeedJobs, type MmSeedJobsDeps, type OperatorSeedTarget } from './seed-jobs.js';
import { AcceptedMmMid } from './accepted-mid.js';
import { MM_MATCHING_ACCOUNT_ID } from './seed-market.js';
import { READY_MARKET_LIFECYCLE, READY_MARKET_NOW, readyMarket } from '../spot/testing.js';

// J-cex-spot-20 #5 (RC-cex-spot-17): the seed job places from the operator-written configuration once any row exists.

class Book implements Pick<MatchingClient, 'submit' | 'depth' | 'cancel'> {
  readonly submitted: Array<{ marketId: string; request: EngineSubmitRequest }> = [];
  readonly cancelled: string[] = [];
  readonly live = new Set<string>();
  private seq = 0;
  async depth(): Promise<EngineDepth> {
    return this.live.size === 0
      ? { bids: [], asks: [], sequence: this.seq }
      : { bids: [['99', '1']], asks: [['101', '1']], sequence: this.seq };
  }
  async submit(marketId: string, request: EngineSubmitRequest): Promise<EngineSubmitResult> {
    this.submitted.push({ marketId, request });
    const sequence = ++this.seq;
    this.live.add(request.orderId);
    return {
      accepted: true,
      sequence,
      fills: [],
      resting: {
        kind: 'book',
        orderId: request.orderId,
        accountId: request.accountId,
        side: request.side,
        price: request.price ?? '0',
        remaining: request.qty,
        sequence,
      },
      rejected: null,
      cancellations: [],
      triggered: [],
    };
  }
  async cancel(_marketId: string, orderId: string): Promise<EngineCancelResult> {
    this.cancelled.push(orderId);
    if (!this.live.delete(orderId)) return { cancelled: false, orderId, sequence: null, cancellation: null };
    const sequence = ++this.seq;
    return {
      cancelled: true,
      orderId,
      sequence,
      cancellation: { orderId, accountId: MM_MATCHING_ACCOUNT_ID, remainingQty: '1', sequence, reason: 'requested' },
    };
  }
}

/** Ends the environment-leftover test once both the cancel and the switched-off row have been reported. */
const results_has_not_configured = (n: number) => n >= 3;

const ROW: OperatorSeedTarget = {
  marketId: 'btc-usdt',
  baseAsset: 'BTC',
  quoteAsset: 'USDT',
  enabled: true,
  version: '1',
  config: { ok: true, halfSpreadBps: 100, stepBps: 10, levels: 3, qtyPerLevel: '1', midSource: 'configured', configuredMid: '100' },
};

async function funded(): Promise<MemoryLedger> {
  const ledger = new MemoryLedger();
  await ledger.post(recipes.marketMakerSeedFund({ assetId: 'USDT', amount: amt('100000'), seedId: 'op-1' }));
  await ledger.post(recipes.marketMakerSeedFund({ assetId: 'BTC', amount: amt('100'), seedId: 'op-2' }));
  return ledger;
}

/** Runs ticks until `done` says stop, collecting every result. */
function ticks(
  deps: Partial<MmSeedJobsDeps> & Pick<MmSeedJobsDeps, 'ledger' | 'matching' | 'operatorConfigs'>,
  done: (n: number) => boolean,
) {
  const results: Array<{ marketId: string; result: unknown }> = [];
  return new Promise<typeof results>((resolve, reject) => {
    const h = startMmSeedJobs({
      midSource: () => AcceptedMmMid.venue('5000'),
      marketFor: () => readyMarket('btc-usdt'),
      marketLifecycle: READY_MARKET_LIFECYCLE,
      now: READY_MARKET_NOW,
      config: { enabled: false, intervalMs: 15, halfSpreadBps: null, stepBps: null, levels: 1, qtyPerLevel: '1', targets: [] },
      ...deps,
      onResult: (marketId, result) => {
        results.push({ marketId, result });
        if (done(results.length)) {
          h.stop();
          resolve(results);
        }
      },
    });
    setTimeout(() => {
      h.stop();
      reject(new Error(`tick timeout after ${results.length} results: ${JSON.stringify(results)}`));
    }, 3000);
  });
}

describe('seed job from the operator configuration (J-cex-spot-20 #5)', () => {
  it('with the environment off, an approved row places levels on each side on the house account at the configured mid; a second tick places none', async () => {
    const matching = new Book();
    const results = await ticks({ ledger: await funded(), matching, operatorConfigs: async () => [ROW] }, (n) => n >= 2);
    expect(matching.submitted).toHaveLength(6);
    expect(matching.submitted.every((s) => s.request.accountId === MM_MATCHING_ACCOUNT_ID && s.request.tif === 'PO')).toBe(true);
    const prices = matching.submitted.map((s) => Number(s.request.price));
    expect(Math.max(...prices.filter((_, i) => matching.submitted[i]!.request.side === 'buy'))).toBeLessThan(100);
    expect(Math.min(...prices.filter((_, i) => matching.submitted[i]!.request.side === 'sell'))).toBeGreaterThan(100);
    // The book now holds the seed: the next tick leaves it alone.
    expect(results[1]).toEqual({ marketId: 'btc-usdt', result: { skipped: 'book_not_empty' } });
  });

  it('a row switched off cancels the last run it placed, and places nothing', async () => {
    const matching = new Book();
    const ledger = await funded();
    let rows: OperatorSeedTarget[] = [ROW];
    const results = await ticks(
      {
        ledger,
        matching,
        operatorConfigs: async () => rows,
        onCancelResult: () => undefined,
      },
      (n) => {
        if (n === 1) rows = [{ ...ROW, enabled: false }];
        return n >= 2;
      },
    );
    expect(matching.submitted).toHaveLength(6);
    expect(new Set(matching.cancelled)).toEqual(new Set(matching.submitted.map((s) => s.request.orderId)));
    expect(matching.live.size).toBe(0);
    expect(results[1]).toEqual({ marketId: 'btc-usdt', result: { skipped: 'operator_seed_off' } });
  });

  it('a row with a blank value places nothing and names it', async () => {
    const matching = new Book();
    const results = await ticks(
      { ledger: await funded(), matching, operatorConfigs: async () => [{ ...ROW, config: { ok: false, unset: 'step' } }] },
      (n) => n >= 1,
    );
    expect(results[0]).toEqual({ marketId: 'btc-usdt', result: { skipped: 'mm.seed_unset:step' } });
    expect(matching.submitted).toHaveLength(0);
  });

  it('once any operator row exists the environment markets are not seeded', async () => {
    const matching = new Book();
    const results = await ticks(
      {
        ledger: await funded(),
        matching,
        operatorConfigs: async () => [{ ...ROW, marketId: 'eth-usdt', enabled: false }],
        config: {
          enabled: true,
          intervalMs: 15,
          halfSpreadBps: 100,
          stepBps: 10,
          levels: 1,
          qtyPerLevel: '1',
          targets: [{ marketId: 'btc-usdt', baseAsset: 'BTC', quoteAsset: 'USDT' }],
        },
      },
      (n) => n >= 2,
    );
    expect(results.every((r) => r.marketId === 'eth-usdt')).toBe(true);
    expect(matching.submitted).toHaveLength(0);
  });

  it('a venue mid source reads the outside venue alone, never the environment mids; with no venue feed it places nothing', async () => {
    const venueRow: OperatorSeedTarget = {
      ...ROW,
      config: { ...(ROW.config as Extract<OperatorSeedTarget['config'], { ok: true }>), midSource: 'venue', configuredMid: null },
    };
    const withFeed = new Book();
    await ticks(
      {
        ledger: await funded(),
        matching: withFeed,
        operatorConfigs: async () => [venueRow],
        venueMidSource: () => AcceptedMmMid.venue('5000'),
      },
      (n) => n >= 1,
    );
    expect(withFeed.submitted.length).toBeGreaterThan(0);
    expect(withFeed.submitted.every((s) => Math.abs(Number(s.request.price) - 5000) < 500)).toBe(true);

    // midSource stands for the environment chain (TRADE_MM_SEED_MIDS first): it is never asked for a venue row.
    const noFeed = new Book();
    const results = await ticks(
      {
        ledger: await funded(),
        matching: noFeed,
        operatorConfigs: async () => [venueRow],
        midSource: () => AcceptedMmMid.configured('100'),
      },
      (n) => n >= 1,
    );
    expect(results[0]).toEqual({ marketId: 'btc-usdt', result: { skipped: 'feed.market_not_connected' } });
    expect(noFeed.submitted).toHaveLength(0);
  });

  it('a newly approved version cancels the run placed from the old one, then places from the new one', async () => {
    const matching = new Book();
    let rows: OperatorSeedTarget[] = [ROW];
    await ticks({ ledger: await funded(), matching, operatorConfigs: async () => rows }, (n) => {
      if (n === 1)
        rows = [{ ...ROW, version: '2', config: { ...(ROW.config as Extract<OperatorSeedTarget['config'], { ok: true }>), levels: 1 } }];
      return n >= 2;
    });
    expect(matching.submitted).toHaveLength(6 + 2);
    const first = new Set(matching.submitted.slice(0, 6).map((s) => s.request.orderId));
    expect(new Set(matching.cancelled)).toEqual(first);
    expect(matching.live.size).toBe(2);
  });

  it('a row left with a blank value cancels the run an earlier version placed', async () => {
    const matching = new Book();
    let rows: OperatorSeedTarget[] = [ROW];
    const results = await ticks({ ledger: await funded(), matching, operatorConfigs: async () => rows }, (n) => {
      if (n === 1) rows = [{ ...ROW, version: '2', config: { ok: false, unset: 'half spread' } }];
      return n >= 2;
    });
    expect(matching.live.size).toBe(0);
    expect(results[1]).toEqual({ marketId: 'btc-usdt', result: { skipped: 'mm.seed_unset:half spread' } });
  });

  it('once operator rows exist, a run the environment placed on a market they do not name is cancelled', async () => {
    const matching = new Book();
    let rows: OperatorSeedTarget[] = [];
    const results = await ticks(
      {
        ledger: await funded(),
        matching,
        operatorConfigs: async () => rows,
        config: {
          enabled: true,
          intervalMs: 15,
          halfSpreadBps: 100,
          stepBps: 10,
          levels: 1,
          qtyPerLevel: '1',
          targets: [{ marketId: 'btc-usdt', baseAsset: 'BTC', quoteAsset: 'USDT' }],
        },
      },
      (n) => {
        if (n === 1) rows = [{ ...ROW, marketId: 'eth-usdt', baseAsset: 'ETH', quoteAsset: 'USDT', enabled: false }];
        return results_has_not_configured(n);
      },
    );
    expect(matching.submitted).toHaveLength(2);
    expect(matching.live.size).toBe(0);
    expect(
      results.some((r) => r.marketId === 'btc-usdt' && JSON.stringify(r.result) === JSON.stringify({ skipped: 'not_configured' })),
    ).toBe(true);
  });

  it('with no rows and the environment off, nothing is scheduled to place (default off)', async () => {
    const matching = new Book();
    const h = startMmSeedJobs({
      ledger: await funded(),
      matching,
      midSource: () => AcceptedMmMid.configured('100'),
      marketFor: () => readyMarket('btc-usdt'),
      operatorConfigs: async () => [],
      config: { enabled: false, intervalMs: 10, halfSpreadBps: null, stepBps: null, levels: 1, qtyPerLevel: '1', targets: [] },
    });
    await new Promise((r) => setTimeout(r, 80));
    h.stop();
    expect(matching.submitted).toHaveLength(0);
  });
});
