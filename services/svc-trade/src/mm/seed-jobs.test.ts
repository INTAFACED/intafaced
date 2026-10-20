import { describe, expect, it } from 'vitest';
import { formatAmount, marketMaker, MemoryLedger, parseAmount as amt, recipes } from '@intafaced/ledger-client';
import type { EngineCancelResult, EngineDepth, EngineSubmitRequest, EngineSubmitResult, MatchingClient } from '../spot/matching-client.js';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadMmSeedLastRun,
  parseMmSeedMids,
  parseMmSeedTargets,
  saveMmSeedLastRun,
  startMmSeedJobs,
  type MmSeedJobsDeps,
} from './seed-jobs.js';
import { AcceptedMmMid } from './accepted-mid.js';
import { MM_MATCHING_ACCOUNT_ID, type SeedTradableMarket } from './seed-market.js';
import { READY_MARKET_LIFECYCLE, READY_MARKET_NOW, readyMarket } from '../spot/testing.js';

const marketForActive = (): SeedTradableMarket => readyMarket('btc-usdt');

const startReadyMmSeedJobs = (deps: Omit<MmSeedJobsDeps, 'marketLifecycle' | 'now'>) =>
  startMmSeedJobs({ ...deps, marketLifecycle: READY_MARKET_LIFECYCLE, now: READY_MARKET_NOW });

class JobStubMatching implements Pick<MatchingClient, 'submit' | 'depth' | 'cancel'> {
  readonly submitted: Array<{ marketId: string; request: EngineSubmitRequest }> = [];
  readonly cancelled: string[] = [];
  readonly live = new Set<string>();
  depthReply: EngineDepth = { bids: [], asks: [], sequence: 0 };
  private seq = 0;
  /** When true, depth follows live set (empty when no live orders). */
  trackDepthFromLive = false;

  async depth(_marketId: string, _limit?: number): Promise<EngineDepth> {
    if (this.trackDepthFromLive) {
      if (this.live.size === 0) return { bids: [], asks: [], sequence: this.seq };
      return { bids: [['99', '1']], asks: [['101', '1']], sequence: this.seq };
    }
    return this.depthReply;
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
    if (!this.live.has(orderId)) {
      return { cancelled: false, orderId, sequence: null, cancellation: null };
    }
    this.live.delete(orderId);
    const sequence = ++this.seq;
    return {
      cancelled: true,
      orderId,
      sequence,
      cancellation: {
        orderId,
        accountId: MM_MATCHING_ACCOUNT_ID,
        remainingQty: '1',
        sequence,
        reason: 'requested',
      },
    };
  }
}

describe('parseMmSeedTargets', () => {
  it('parses marketId:base:quote list; empty → []', () => {
    expect(parseMmSeedTargets('')).toEqual([]);
    expect(parseMmSeedTargets(undefined)).toEqual([]);
    expect(parseMmSeedTargets('btc-usdt:BTC:USDT, eth-usdt:ETH:USDT')).toEqual([
      { marketId: 'btc-usdt', baseAsset: 'BTC', quoteAsset: 'USDT' },
      { marketId: 'eth-usdt', baseAsset: 'ETH', quoteAsset: 'USDT' },
    ]);
    // bad segments skipped
    expect(parseMmSeedTargets('only-two:parts,ok:A:B')).toEqual([{ marketId: 'ok', baseAsset: 'A', quoteAsset: 'B' }]);
  });
});

describe('parseMmSeedMids', () => {
  it('parses mid map; never invents', () => {
    expect(parseMmSeedMids('')).toEqual(new Map());
    const m = parseMmSeedMids('btc-usdt:100,eth-usdt:3000');
    expect(m.get('btc-usdt')).toBe('100');
    expect(m.get('eth-usdt')).toBe('3000');
    expect(m.get('missing')).toBeUndefined();
  });
});

describe('mm seed last-run durability', () => {
  it('round-trips last-run map; corrupt/missing → empty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mm-seed-'));
    const path = join(dir, 'last-run.json');
    expect(loadMmSeedLastRun(undefined).size).toBe(0);
    expect(loadMmSeedLastRun(path).size).toBe(0);

    const map = new Map([['m1', { runId: 'ops-seed:m1:1', levels: 3 }]]);
    saveMmSeedLastRun(path, map);
    const loaded = loadMmSeedLastRun(path);
    expect(loaded.get('m1')).toEqual({ runId: 'ops-seed:m1:1', levels: 3 });

    writeFileSync(path, '{not json', 'utf8');
    expect(loadMmSeedLastRun(path).size).toBe(0);
  });
});

describe('startMmSeedJobs', () => {
  it('unnamed targets or an unset interval schedule zero timers', () => {
    const base = {
      ledger: new MemoryLedger(),
      matching: new JobStubMatching(),
      midSource: () => AcceptedMmMid.configured('100'),
      marketFor: marketForActive,
      config: {
        enabled: true,
        intervalMs: 1000,
        halfSpreadBps: 10,
        stepBps: 10,
        levels: 1,
        qtyPerLevel: '1',
        targets: [{ marketId: '', baseAsset: 'BTC', quoteAsset: 'USDT' }],
      },
    };
    const unnamed = startReadyMmSeedJobs(base);
    expect(unnamed.host.list()).toEqual([]);
    unnamed.stop();

    const noInterval = startReadyMmSeedJobs({
      ...base,
      config: {
        ...base.config,
        intervalMs: undefined,
        targets: [{ marketId: 'btc-usdt', baseAsset: 'BTC', quoteAsset: 'USDT' }],
      },
    });
    expect(noInterval.host.list()).toEqual([]);
    noInterval.stop();
  });

  it('production env does not manufacture an MM seed interval', () => {
    const envSource = readFileSync(new URL('../env.ts', import.meta.url), 'utf8');
    expect(envSource).toMatch(/TRADE_MM_SEED_INTERVAL_MS:\s*z\.coerce\.number\(\)\.int\(\)\.min\(5_000\)\.max\(3_600_000\)\.optional\(\)/);
    expect(envSource).not.toMatch(/TRADE_MM_SEED_INTERVAL_MS:[^\n]*\.default\(/);
  });

  it('unset half-spread or step bps schedule zero timers (never invent 10)', () => {
    const base = {
      ledger: new MemoryLedger(),
      matching: new JobStubMatching(),
      midSource: () => AcceptedMmMid.configured('100'),
      marketFor: marketForActive,
      config: {
        enabled: true,
        intervalMs: 1000,
        halfSpreadBps: 10 as number | null,
        stepBps: 10 as number | null,
        levels: 1,
        qtyPerLevel: '1',
        targets: [{ marketId: 'btc-usdt', baseAsset: 'BTC', quoteAsset: 'USDT' }],
      },
    };
    const noHalf = startReadyMmSeedJobs({
      ...base,
      config: { ...base.config, halfSpreadBps: null },
    });
    expect(noHalf.host.list()).toEqual([]);
    expect((base.matching as JobStubMatching).submitted).toHaveLength(0);
    noHalf.stop();

    const noStep = startReadyMmSeedJobs({
      ...base,
      config: { ...base.config, stepBps: null },
    });
    expect(noStep.host.list()).toEqual([]);
    expect((base.matching as JobStubMatching).submitted).toHaveLength(0);
    noStep.stop();
  });

  it('production env does not manufacture MM seed 10 bps', () => {
    const envSource = readFileSync(new URL('../env.ts', import.meta.url), 'utf8');
    expect(envSource).toMatch(/TRADE_MM_SEED_HALF_SPREAD_BPS:\s*z\.string\(\)\.default\(''\)\.transform\(parseOwnerIntegerEnv\)/);
    expect(envSource).toMatch(/TRADE_MM_SEED_STEP_BPS:\s*z\.string\(\)\.default\(''\)\.transform\(parseOwnerIntegerEnv\)/);
    expect(envSource).not.toMatch(/TRADE_MM_SEED_HALF_SPREAD_BPS:[^\n]*\.default\(10\)/);
    expect(envSource).not.toMatch(/TRADE_MM_SEED_STEP_BPS:[^\n]*\.default\(10\)/);
  });

  it('disabled or empty targets → no scheduled jobs', () => {
    const host1 = startReadyMmSeedJobs({
      ledger: new MemoryLedger(),
      matching: new JobStubMatching(),
      midSource: () => AcceptedMmMid.configured('100'),
      marketFor: marketForActive,
      config: {
        enabled: false,
        intervalMs: 1000,
        halfSpreadBps: 10,
        stepBps: 10,
        levels: 1,
        qtyPerLevel: '1',
        targets: [{ marketId: 'm', baseAsset: 'BTC', quoteAsset: 'USDT' }],
      },
    });
    expect(host1.host.list()).toEqual([]);
    host1.stop();

    const host2 = startReadyMmSeedJobs({
      ledger: new MemoryLedger(),
      matching: new JobStubMatching(),
      midSource: () => AcceptedMmMid.configured('100'),
      marketFor: marketForActive,
      config: {
        enabled: true,
        intervalMs: 1000,
        halfSpreadBps: 10,
        stepBps: 10,
        levels: 1,
        qtyPerLevel: '1',
        targets: [],
      },
    });
    expect(host2.host.list()).toEqual([]);
    host2.stop();
  });

  it('tick seeds empty book with external mid under house:market-maker', async () => {
    const matching = new JobStubMatching();
    const ledger = new MemoryLedger();
    await ledger.post(recipes.marketMakerSeedFund({ assetId: 'USDT', amount: amt('10000'), seedId: 'k1' }));
    await ledger.post(recipes.marketMakerSeedFund({ assetId: 'BTC', amount: amt('100'), seedId: 'k2' }));

    await new Promise<void>((resolve, reject) => {
      const h = startReadyMmSeedJobs({
        ledger,
        matching,
        midSource: () => AcceptedMmMid.configured('100'),
        marketFor: marketForActive,
        config: {
          enabled: true,
          intervalMs: 20,
          halfSpreadBps: 100,
          stepBps: 0,
          levels: 1,
          qtyPerLevel: '1',
          targets: [{ marketId: 'btc-usdt', baseAsset: 'BTC', quoteAsset: 'USDT' }],
        },
        onResult: (marketId, result) => {
          try {
            expect(marketId).toBe('btc-usdt');
            expect('ok' in result && result.ok).toBe(true);
            expect(matching.submitted.length).toBe(2);
            expect(matching.submitted.every((s) => s.request.accountId === MM_MATCHING_ACCOUNT_ID)).toBe(true);
            expect(matching.submitted.every((s) => s.request.tif === 'PO')).toBe(true);
            h.stop();
            resolve();
          } catch (e) {
            h.stop();
            reject(e);
          }
        },
      });
      expect(h.host.list()).toEqual(['mm.seed']);
      setTimeout(() => {
        h.stop();
        reject(new Error('tick timeout'));
      }, 2000);
    });
  });

  it('skips when book already has depth (no re-seed race)', async () => {
    const matching = new JobStubMatching();
    matching.depthReply = { bids: [['99', '1']], asks: [['101', '1']], sequence: 1 };
    const ledger = new MemoryLedger();

    await new Promise<void>((resolve, reject) => {
      const h = startReadyMmSeedJobs({
        ledger,
        matching,
        midSource: () => AcceptedMmMid.configured('100'),
        marketFor: marketForActive,
        config: {
          enabled: true,
          intervalMs: 20,
          halfSpreadBps: 100,
          stepBps: 0,
          levels: 1,
          qtyPerLevel: '1',
          targets: [{ marketId: 'btc-usdt', baseAsset: 'BTC', quoteAsset: 'USDT' }],
        },
        onResult: (_id, result) => {
          try {
            expect('skipped' in result && result.skipped).toBe('book_not_empty');
            expect(matching.submitted).toHaveLength(0);
            h.stop();
            resolve();
          } catch (e) {
            h.stop();
            reject(e);
          }
        },
      });
      setTimeout(() => {
        h.stop();
        reject(new Error('tick timeout'));
      }, 2000);
    });
  });

  it('skips missing mid — no submit', async () => {
    const matching = new JobStubMatching();
    const ledger = new MemoryLedger();

    await new Promise<void>((resolve, reject) => {
      const h = startReadyMmSeedJobs({
        ledger,
        matching,
        midSource: () => null,
        marketFor: marketForActive,
        config: {
          enabled: true,
          intervalMs: 20,
          halfSpreadBps: 100,
          stepBps: 0,
          levels: 1,
          qtyPerLevel: '1',
          targets: [{ marketId: 'btc-usdt', baseAsset: 'BTC', quoteAsset: 'USDT' }],
        },
        onResult: (_id, result) => {
          try {
            expect('skipped' in result && result.skipped).toBe('missing_mid');
            expect(matching.submitted).toHaveLength(0);
            h.stop();
            resolve();
          } catch (e) {
            h.stop();
            reject(e);
          }
        },
      });
      setTimeout(() => {
        h.stop();
        reject(new Error('tick timeout'));
      }, 2000);
    });
  });

  it('refuses an unaccepted bare price — no submit', async () => {
    const matching = new JobStubMatching();

    await new Promise<void>((resolve, reject) => {
      const h = startReadyMmSeedJobs({
        ledger: new MemoryLedger(),
        matching,
        // Fail-first boundary: a decimal alone says nothing about provenance.
        midSource: (() => '100') as never,
        marketFor: marketForActive,
        config: {
          enabled: true,
          intervalMs: 20,
          halfSpreadBps: 100,
          stepBps: 0,
          levels: 1,
          qtyPerLevel: '1',
          targets: [{ marketId: 'btc-usdt', baseAsset: 'BTC', quoteAsset: 'USDT' }],
        },
        onResult: (_id, result) => {
          try {
            expect('skipped' in result && result.skipped).toBe('missing_mid');
            expect(matching.submitted).toHaveLength(0);
            h.stop();
            resolve();
          } catch (error) {
            h.stop();
            reject(error);
          }
        },
      });
      setTimeout(() => {
        h.stop();
        reject(new Error('tick timeout'));
      }, 2000);
    });
  });

  it('skips when marketFor returns null — no invent-active, no submit', async () => {
    const matching = new JobStubMatching();
    const ledger = new MemoryLedger();

    await new Promise<void>((resolve, reject) => {
      const h = startReadyMmSeedJobs({
        ledger,
        matching,
        midSource: () => AcceptedMmMid.configured('100'),
        marketFor: () => null,
        config: {
          enabled: true,
          intervalMs: 20,
          halfSpreadBps: 100,
          stepBps: 0,
          levels: 1,
          qtyPerLevel: '1',
          targets: [{ marketId: 'btc-usdt', baseAsset: 'BTC', quoteAsset: 'USDT' }],
        },
        onResult: (_id, result) => {
          try {
            expect('skipped' in result && result.skipped).toBe('market_unknown');
            expect(matching.submitted).toHaveLength(0);
            h.stop();
            resolve();
          } catch (e) {
            h.stop();
            reject(e);
          }
        },
      });
      setTimeout(() => {
        h.stop();
        reject(new Error('tick timeout'));
      }, 2000);
    });
  });

  it('job refuses halted market — no matching.submit (assertTradable via seedMarket)', async () => {
    const matching = new JobStubMatching();
    const ledger = new MemoryLedger();
    await ledger.post(recipes.marketMakerSeedFund({ assetId: 'USDT', amount: amt('10000'), seedId: 'jh' }));
    await ledger.post(recipes.marketMakerSeedFund({ assetId: 'BTC', amount: amt('100'), seedId: 'jh-b' }));

    await new Promise<void>((resolve, reject) => {
      const h = startReadyMmSeedJobs({
        ledger,
        matching,
        midSource: () => AcceptedMmMid.configured('100'),
        marketFor: () => ({ symbol: 'BTC/USDT', kind: 'spot', assetClass: 'crypto', status: 'halted' }),
        config: {
          enabled: true,
          intervalMs: 20,
          halfSpreadBps: 100,
          stepBps: 0,
          levels: 1,
          qtyPerLevel: '1',
          targets: [{ marketId: 'btc-usdt', baseAsset: 'BTC', quoteAsset: 'USDT' }],
        },
        onResult: (_id, result) => {
          try {
            expect('ok' in result && !result.ok).toBe(true);
            if ('ok' in result && !result.ok) {
              expect(result.reason).toBe('trade.market_not_tradable');
            }
            expect(matching.submitted).toHaveLength(0);
            h.stop();
            resolve();
          } catch (e) {
            h.stop();
            reject(e);
          }
        },
      });
      setTimeout(() => {
        h.stop();
        reject(new Error('tick timeout'));
      }, 2000);
    });
  });

  it('cancel+reseed when book empty after levels cleared — new runId, holds redrawn', async () => {
    const matching = new JobStubMatching();
    matching.trackDepthFromLive = true;
    const ledger = new MemoryLedger();
    await ledger.post(recipes.marketMakerSeedFund({ assetId: 'USDT', amount: amt('10000'), seedId: 'rs1' }));
    await ledger.post(recipes.marketMakerSeedFund({ assetId: 'BTC', amount: amt('100'), seedId: 'rs2' }));

    let seedCount = 0;
    let cancelCount = 0;
    const runIds: string[] = [];

    await new Promise<void>((resolve, reject) => {
      const h = startReadyMmSeedJobs({
        ledger,
        matching,
        midSource: () => AcceptedMmMid.configured('100'),
        marketFor: marketForActive,
        config: {
          enabled: true,
          intervalMs: 25,
          halfSpreadBps: 100,
          stepBps: 0,
          levels: 1,
          qtyPerLevel: '1',
          targets: [{ marketId: 'btc-usdt', baseAsset: 'BTC', quoteAsset: 'USDT' }],
        },
        runIdFor: (marketId) => {
          const id = `ops-seed:${marketId}:g${runIds.length + 1}`;
          runIds.push(id);
          return id;
        },
        onCancelResult: () => {
          cancelCount += 1;
        },
        onResult: async (_id, result) => {
          try {
            if ('skipped' in result) {
              // book_not_empty between first seed and clear is fine
              return;
            }
            if (!('ok' in result) || !result.ok) {
              h.stop();
              reject(new Error(`unexpected seed fail: ${'reason' in result ? result.reason : '?'}`));
              return;
            }
            seedCount += 1;
            if (seedCount === 1) {
              expect(matching.submitted).toHaveLength(2);
              expect(matching.live.size).toBe(2);
              // Book empty and the orders are gone, so cancel answers cancelled false.
              // Those holds stay for the fill; the next run draws again.
              matching.live.clear();
              return;
            }
            if (seedCount === 2) {
              expect(cancelCount).toBeGreaterThanOrEqual(1);
              expect(runIds[0]).not.toBe(runIds[1]);
              // second seed used new order ids (4 submits total)
              expect(matching.submitted.length).toBe(4);
              expect(matching.cancelled.length).toBe(2);
              // first holds were not returned; second seed drew another 99 USDT and 1 BTC
              expect(formatAmount((await ledger.balance(marketMaker('USDT'))).amount)).toBe('9802');
              expect(formatAmount((await ledger.balance(marketMaker('BTC'))).amount)).toBe('98');
              h.stop();
              resolve();
            }
          } catch (e) {
            h.stop();
            reject(e);
          }
        },
      });
      setTimeout(() => {
        h.stop();
        reject(new Error(`reseed timeout seedCount=${seedCount} cancelCount=${cancelCount}`));
      }, 3000);
    });
  });
});
