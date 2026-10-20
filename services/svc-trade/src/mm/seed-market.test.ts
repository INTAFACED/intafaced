import { describe, expect, it } from 'vitest';
import {
  formatAmount,
  marketMaker,
  marketMakerOrderHoldAccount,
  MemoryLedger,
  parseAmount as amt,
  recipes,
} from '@intafaced/ledger-client';
import type { EngineCancelResult, EngineSubmitRequest, EngineSubmitResult, MatchingClient } from '../spot/matching-client.js';
import {
  cancelSeedMarket,
  isHouseMmAccount,
  MM_MATCHING_ACCOUNT_ID,
  seedMarket,
  seedOrderIdsForRun,
  summarizeCancelSeed,
  summarizeSeedMarket,
  type SeedTradableMarket,
} from './seed-market.js';
import { mmSeedOrderIdFor } from '../spot/ids.js';
import { READY_MARKET_LIFECYCLE, READY_MARKET_NOW, readyMarket } from '../spot/testing.js';

async function fundMm(ledger: MemoryLedger, asset: string, amount: string, seedId: string) {
  await ledger.post(recipes.marketMakerSeedFund({ assetId: asset, amount: amt(amount), seedId }));
}

/** Active spot — the only market users can trade by default. */
const ACTIVE_SPOT: SeedTradableMarket = {
  symbol: 'BTC/USDT',
  assetClass: 'crypto',
  kind: 'spot',
  status: 'active',
};

const HALTED_SPOT: SeedTradableMarket = {
  symbol: 'BTC/USDT',
  assetClass: 'crypto',
  kind: 'spot',
  status: 'halted',
};

const ACTIVE_FUTURES: SeedTradableMarket = {
  symbol: 'BTC/USDT-PERP',
  assetClass: 'crypto',
  kind: 'futures',
  status: 'active',
};

const readySeedDeps = (market: SeedTradableMarket, marketId = 'btc-usdt') => ({
  marketLifecycle: READY_MARKET_LIFECYCLE,
  lifecycleMarket: readyMarket(marketId, { kind: market.kind }),
  now: READY_MARKET_NOW,
});

/** Minimal matching double — avoids pulling contracts via spot/testing. */
class SeedStubMatching implements Pick<MatchingClient, 'submit' | 'cancel'> {
  readonly submitted: Array<{ marketId: string; request: EngineSubmitRequest }> = [];
  readonly cancelled: Array<{ marketId: string; orderId: string }> = [];
  /** Live order ids after successful submit (cleared on cancel). */
  readonly live = new Set<string>();
  private seq = 0;
  private readonly scripts: Array<(req: EngineSubmitRequest) => EngineSubmitResult> = [];
  cancelThrows = false;

  script(fn: (req: EngineSubmitRequest) => EngineSubmitResult): this {
    this.scripts.push(fn);
    return this;
  }

  async submit(marketId: string, request: EngineSubmitRequest): Promise<EngineSubmitResult> {
    this.submitted.push({ marketId, request });
    const scripted = this.scripts.shift();
    if (scripted) return scripted(request);
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

  async cancel(marketId: string, orderId: string): Promise<EngineCancelResult> {
    this.cancelled.push({ marketId, orderId });
    if (this.cancelThrows) throw new Error('matching down');
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

describe('mm seed ids', () => {
  it('mmSeedOrderIdFor is deterministic uuid; isHouseMmAccount matches STP id', () => {
    const a = mmSeedOrderIdFor('run-a', 'mkt', 'buy', 1);
    const b = mmSeedOrderIdFor('run-a', 'mkt', 'buy', 1);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(isHouseMmAccount(MM_MATCHING_ACCOUNT_ID)).toBe(true);
    expect(isHouseMmAccount(ALICE_FAKE)).toBe(false);
  });
});

const ALICE_FAKE = '11111111-1111-4111-8111-111111111111';

describe('seedMarket', () => {
  /**
   * Handoff §7 / house-desk fairness rule 2: house is an ordinary participant.
   * assertTradable must refuse before hold or matching.submit — same codes as
   * user placeOrder. No isHouse bypass.
   */
  it('refuses halted market before hold and before matching.submit', async () => {
    const ledger = new MemoryLedger();
    await fundMm(ledger, 'USDT', '10000', 'fund-h');
    await fundMm(ledger, 'BTC', '100', 'fund-h-b');
    const matching = new SeedStubMatching();
    const potUsdt = formatAmount((await ledger.balance(marketMaker('USDT'))).amount);
    const potBtc = formatAmount((await ledger.balance(marketMaker('BTC'))).amount);

    const result = await seedMarket(
      {
        marketId: 'btc-usdt',
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
        midPrice: '100',
        halfSpreadBps: 100,
        stepBps: 0,
        levels: 1,
        qtyPerLevel: '1',
        runId: 'run-halted',
      },
      { ledger, matching, market: HALTED_SPOT },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('trade.market_not_tradable');
    expect(result.placements).toHaveLength(0);
    expect(matching.submitted).toHaveLength(0);
    // no hold drawn
    expect(formatAmount((await ledger.balance(marketMaker('USDT'))).amount)).toBe(potUsdt);
    expect(formatAmount((await ledger.balance(marketMaker('BTC'))).amount)).toBe(potBtc);
  });

  it('refuses an active market when lifecycle authority is absent', async () => {
    const ledger = new MemoryLedger();
    await fundMm(ledger, 'USDT', '10000', 'fund-no-authority');
    await fundMm(ledger, 'BTC', '100', 'fund-no-authority-b');
    const matching = new SeedStubMatching();

    const result = await seedMarket(
      {
        marketId: 'btc-usdt',
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
        midPrice: '100',
        halfSpreadBps: 100,
        stepBps: 0,
        levels: 1,
        qtyPerLevel: '1',
        runId: 'run-no-authority',
      },
      { ledger, matching, market: ACTIVE_SPOT },
    );

    expect(result).toMatchObject({ ok: false, reason: 'trade.lifecycle_authority_unavailable', placements: [] });
    expect(matching.submitted).toHaveLength(0);
    expect(formatAmount((await ledger.balance(marketMaker('USDT'))).amount)).toBe('10000');
    expect(formatAmount((await ledger.balance(marketMaker('BTC'))).amount)).toBe('100');
  });

  it('refuses futures when TRADE_FUTURES_ENABLED is off — before hold/submit', async () => {
    const ledger = new MemoryLedger();
    await fundMm(ledger, 'USDT', '10000', 'fund-f');
    await fundMm(ledger, 'BTC', '100', 'fund-f-b');
    const matching = new SeedStubMatching();

    const result = await seedMarket(
      {
        marketId: 'btc-usdt-perp',
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
        midPrice: '100',
        halfSpreadBps: 100,
        stepBps: 0,
        levels: 1,
        qtyPerLevel: '1',
        runId: 'run-fut-off',
      },
      { ledger, matching, market: ACTIVE_FUTURES, futuresEnabled: false },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('trade.futures_disabled');
    expect(matching.submitted).toHaveLength(0);
    expect(result.placements).toHaveLength(0);
  });

  it('refuses futures when futuresEnabled is omitted and the published flag is off', async () => {
    const previous = process.env.TRADE_FUTURES_ENABLED;
    process.env.TRADE_FUTURES_ENABLED = 'false';
    try {
      const ledger = new MemoryLedger();
      const matching = new SeedStubMatching();
      const result = await seedMarket(
        {
          marketId: 'btc-usdt-perp',
          baseAsset: 'BTC',
          quoteAsset: 'USDT',
          midPrice: '100',
          halfSpreadBps: 100,
          stepBps: 0,
          levels: 1,
          qtyPerLevel: '1',
          runId: 'run-fut-default',
        },
        { ledger, matching, market: ACTIVE_FUTURES },
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('trade.futures_disabled');
      expect(matching.submitted).toHaveLength(0);
    } finally {
      if (previous === undefined) delete process.env.TRADE_FUTURES_ENABLED;
      else process.env.TRADE_FUTURES_ENABLED = previous;
    }
  });

  it('seeds futures when futuresEnabled is true and market is active', async () => {
    const ledger = new MemoryLedger();
    await fundMm(ledger, 'USDT', '10000', 'fund-fon');
    await fundMm(ledger, 'BTC', '100', 'fund-fon-b');
    const matching = new SeedStubMatching();
    const result = await seedMarket(
      {
        marketId: 'btc-usdt-perp',
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
        midPrice: '100',
        halfSpreadBps: 100,
        stepBps: 0,
        levels: 1,
        qtyPerLevel: '1',
        runId: 'run-fut-on',
      },
      { ledger, matching, market: ACTIVE_FUTURES, futuresEnabled: true, ...readySeedDeps(ACTIVE_FUTURES, 'btc-usdt-perp') },
    );
    expect(result.ok).toBe(true);
    expect(matching.submitted).toHaveLength(2);
  });

  it('refuses missing mid — no hold, no submit', async () => {
    const ledger = new MemoryLedger();
    const matching = new SeedStubMatching();
    const result = await seedMarket(
      {
        marketId: 'btc-usdt',
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
        midPrice: null,
        halfSpreadBps: 10,
        stepBps: 10,
        levels: 1,
        qtyPerLevel: '1',
        runId: 'run-1',
      },
      { ledger, matching, market: ACTIVE_SPOT, ...readySeedDeps(ACTIVE_SPOT) },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('missing_mid');
    expect(matching.submitted).toHaveLength(0);
  });

  it('refuses unset half-spread/step rather than inventing 10 — no hold, no submit', async () => {
    const ledger = new MemoryLedger();
    const matching = new SeedStubMatching();
    const result = await seedMarket(
      {
        marketId: 'btc-usdt',
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
        midPrice: '100',
        halfSpreadBps: null,
        stepBps: null,
        levels: 1,
        qtyPerLevel: '1',
        runId: 'run-bps-unset',
      },
      { ledger, matching, market: ACTIVE_SPOT, ...readySeedDeps(ACTIVE_SPOT) },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('trade.mm_seed_bps_unset');
    expect(matching.submitted).toHaveLength(0);
  });

  it('holds inventory and rests post-only limits under house:market-maker', async () => {
    const ledger = new MemoryLedger();
    await fundMm(ledger, 'USDT', '10000', 'fund-quote');
    await fundMm(ledger, 'BTC', '100', 'fund-base');
    const matching = new SeedStubMatching();

    const result = await seedMarket(
      {
        marketId: 'btc-usdt',
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
        midPrice: '100',
        halfSpreadBps: 100, // 1% → bid 99 / ask 101
        stepBps: 0,
        levels: 1,
        qtyPerLevel: '1',
        runId: 'run-a',
      },
      { ledger, matching, market: ACTIVE_SPOT, ...readySeedDeps(ACTIVE_SPOT) },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.placements).toHaveLength(2);
    expect(result.placements.every((p) => p.status === 'resting')).toBe(true);
    expect(matching.submitted).toHaveLength(2);

    for (const sub of matching.submitted) {
      expect(sub.marketId).toBe('btc-usdt');
      expect(sub.request.accountId).toBe(MM_MATCHING_ACCOUNT_ID);
      expect(sub.request.type).toBe('limit');
      expect(sub.request.tif).toBe('PO');
      expect(sub.request.lifecycleProof?.action).toBe('PLACE_POST_ONLY');
      expect(sub.request.lifecycleProof?.decision).toBe('ELIGIBLE');
    }

    const buy = matching.submitted.find((s) => s.request.side === 'buy')!;
    const sell = matching.submitted.find((s) => s.request.side === 'sell')!;
    expect(buy.request.price).toBe('99');
    expect(sell.request.price).toBe('101');

    // buy holds quote (99 * 1), sell holds base (1)
    expect(formatAmount((await ledger.balance(marketMakerOrderHoldAccount('USDT', buy.request.orderId))).amount)).toBe('99');
    expect(formatAmount((await ledger.balance(marketMakerOrderHoldAccount('BTC', sell.request.orderId))).amount)).toBe('1');
    // pot drawn down
    expect(formatAmount((await ledger.balance(marketMaker('USDT'))).amount)).toBe('9901');
    expect(formatAmount((await ledger.balance(marketMaker('BTC'))).amount)).toBe('99');
    expect(summarizeSeedMarket(result)).toContain('resting=2/2');
  });

  it('releases hold when engine rejects (post-only would cross)', async () => {
    const ledger = new MemoryLedger();
    await fundMm(ledger, 'USDT', '1000', 'fund-r');
    await fundMm(ledger, 'BTC', '10', 'fund-r-b');
    const matching = new SeedStubMatching();
    const reject = (): EngineSubmitResult => ({
      accepted: false,
      sequence: null,
      fills: [],
      resting: null,
      rejected: { code: 'post_only_would_cross', message: 'would cross' },
      cancellations: [],
      triggered: [],
    });
    matching.script(reject).script(reject);

    const result = await seedMarket(
      {
        marketId: 'btc-usdt',
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
        midPrice: '100',
        halfSpreadBps: 100,
        stepBps: 0,
        levels: 1,
        qtyPerLevel: '1',
        runId: 'run-reject',
      },
      { ledger, matching, market: ACTIVE_SPOT, ...readySeedDeps(ACTIVE_SPOT) },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('no_resting_orders');
    expect(result.placements.every((p) => p.status === 'released_after_reject')).toBe(true);
    // inventory fully returned
    expect(formatAmount((await ledger.balance(marketMaker('USDT'))).amount)).toBe('1000');
    expect(formatAmount((await ledger.balance(marketMaker('BTC'))).amount)).toBe('10');
  });

  it('idempotent re-seed reuses order hold key (no double draw)', async () => {
    const ledger = new MemoryLedger();
    await fundMm(ledger, 'USDT', '1000', 'fund-i');
    await fundMm(ledger, 'BTC', '10', 'fund-i-b');
    const matching = new SeedStubMatching();

    const spec = {
      marketId: 'btc-usdt',
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
      midPrice: '100',
      halfSpreadBps: 100,
      stepBps: 0,
      levels: 1,
      qtyPerLevel: '1',
      runId: 'run-idem',
    } as const;

    const first = await seedMarket(spec, { ledger, matching, market: ACTIVE_SPOT, ...readySeedDeps(ACTIVE_SPOT) });
    expect(first.ok).toBe(true);
    const usdtAfterFirst = formatAmount((await ledger.balance(marketMaker('USDT'))).amount);
    const btcAfterFirst = formatAmount((await ledger.balance(marketMaker('BTC'))).amount);

    // Second run: hold posts are idempotent; matching gets another submit (caller
    // must not double-seed live books without cancel — residual ops concern).
    const second = await seedMarket(spec, { ledger, matching, market: ACTIVE_SPOT, ...readySeedDeps(ACTIVE_SPOT) });
    expect(second.ok).toBe(true);
    expect(formatAmount((await ledger.balance(marketMaker('USDT'))).amount)).toBe(usdtAfterFirst);
    expect(formatAmount((await ledger.balance(marketMaker('BTC'))).amount)).toBe(btcAfterFirst);
  });

  it('hold_failed when pot empty — no matching submit for that intent', async () => {
    const ledger = new MemoryLedger();
    // only base funded; buy side needs quote
    await fundMm(ledger, 'BTC', '10', 'fund-only-base');
    const matching = new SeedStubMatching();

    const result = await seedMarket(
      {
        marketId: 'btc-usdt',
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
        midPrice: '100',
        halfSpreadBps: 100,
        stepBps: 0,
        levels: 1,
        qtyPerLevel: '1',
        runId: 'run-empty',
      },
      { ledger, matching, market: ACTIVE_SPOT, ...readySeedDeps(ACTIVE_SPOT) },
    );

    // plan order is buy then sell per level — buy hold fails first
    const buyPlacement = result.placements.find((p) => p.intent.side === 'buy');
    const sellPlacement = result.placements.find((p) => p.intent.side === 'sell');
    expect(buyPlacement?.status).toBe('hold_failed');
    expect(sellPlacement?.status).toBe('resting');
    expect(matching.submitted.every((s) => s.request.side === 'sell')).toBe(true);
  });
});

describe('cancelSeedMarket', () => {
  it('seedOrderIdsForRun is buy+sell × levels deterministic', () => {
    const ids = seedOrderIdsForRun('run-c', 'btc-usdt', 2);
    expect(ids).toHaveLength(4);
    expect(ids.map((r) => r.orderId)).toEqual([
      mmSeedOrderIdFor('run-c', 'btc-usdt', 'buy', 1),
      mmSeedOrderIdFor('run-c', 'btc-usdt', 'sell', 1),
      mmSeedOrderIdFor('run-c', 'btc-usdt', 'buy', 2),
      mmSeedOrderIdFor('run-c', 'btc-usdt', 'sell', 2),
    ]);
  });

  it('cancels live seed orders and releases MM holds back to pot', async () => {
    const ledger = new MemoryLedger();
    await fundMm(ledger, 'USDT', '10000', 'fund-c');
    await fundMm(ledger, 'BTC', '100', 'fund-c-b');
    const matching = new SeedStubMatching();

    const seeded = await seedMarket(
      {
        marketId: 'btc-usdt',
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
        midPrice: '100',
        halfSpreadBps: 100,
        stepBps: 0,
        levels: 1,
        qtyPerLevel: '1',
        runId: 'run-cancel',
      },
      { ledger, matching, market: ACTIVE_SPOT, ...readySeedDeps(ACTIVE_SPOT) },
    );
    expect(seeded.ok).toBe(true);
    expect(matching.live.size).toBe(2);
    expect(formatAmount((await ledger.balance(marketMaker('USDT'))).amount)).toBe('9901');
    expect(formatAmount((await ledger.balance(marketMaker('BTC'))).amount)).toBe('99');

    const cancelled = await cancelSeedMarket(
      {
        marketId: 'btc-usdt',
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
        levels: 1,
        runId: 'run-cancel',
      },
      { ledger, matching },
    );

    expect(cancelled.ok).toBe(true);
    expect(matching.live.size).toBe(0);
    expect(matching.cancelled).toHaveLength(2);
    expect(cancelled.placements.every((p) => p.status === 'cancelled_and_released')).toBe(true);
    // inventory fully returned
    expect(formatAmount((await ledger.balance(marketMaker('USDT'))).amount)).toBe('10000');
    expect(formatAmount((await ledger.balance(marketMaker('BTC'))).amount)).toBe('100');
    expect(summarizeCancelSeed(cancelled)).toContain('released=2/2');
  });

  it('not-live cancel leaves a positive hold in place (levels already off the book)', async () => {
    const ledger = new MemoryLedger();
    await fundMm(ledger, 'USDT', '1000', 'fund-nl');
    await fundMm(ledger, 'BTC', '10', 'fund-nl-b');
    const matching = new SeedStubMatching();

    const seeded = await seedMarket(
      {
        marketId: 'btc-usdt',
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
        midPrice: '100',
        halfSpreadBps: 100,
        stepBps: 0,
        levels: 1,
        qtyPerLevel: '1',
        runId: 'run-nl',
      },
      { ledger, matching, market: ACTIVE_SPOT, ...readySeedDeps(ACTIVE_SPOT) },
    );
    expect(seeded.ok).toBe(true);
    if (!seeded.ok) return;
    // Order is already off the book (just filled, or already gone) while the hold remains.
    matching.live.clear();

    const cancelled = await cancelSeedMarket(
      {
        marketId: 'btc-usdt',
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
        levels: 1,
        runId: 'run-nl',
      },
      { ledger, matching },
    );

    expect(cancelled.ok).toBe(true);
    expect(cancelled.placements.every((p) => p.engineCancelled === false)).toBe(true);
    expect(cancelled.placements.every((p) => p.status === 'not_live_hold_kept')).toBe(true);
    // Inventory stays on the order hold for the fill. It is not paid back to the pot.
    expect(formatAmount((await ledger.balance(marketMaker('USDT'))).amount)).toBe('901');
    expect(formatAmount((await ledger.balance(marketMaker('BTC'))).amount)).toBe('9');
    for (const placement of seeded.placements) {
      const hold = await ledger.balance(marketMakerOrderHoldAccount(placement.holdAsset, placement.orderId));
      expect(formatAmount(hold.amount)).not.toBe('0');
    }
    expect(ledger.journal().some((tx) => tx.reason === 'order.hold.mm.released')).toBe(false);
  });

  it('does not release a positive hold when matching answers cancelled false', async () => {
    const ledger = new MemoryLedger();
    await fundMm(ledger, 'USDT', '1000', 'fund-filled');
    await fundMm(ledger, 'BTC', '10', 'fund-filled-b');
    const matching = new SeedStubMatching();

    const seeded = await seedMarket(
      {
        marketId: 'btc-usdt',
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
        midPrice: '100',
        halfSpreadBps: 100,
        stepBps: 0,
        levels: 1,
        qtyPerLevel: '1',
        runId: 'run-filled',
      },
      { ledger, matching, market: ACTIVE_SPOT, ...readySeedDeps(ACTIVE_SPOT) },
    );
    expect(seeded.ok).toBe(true);
    if (!seeded.ok) return;

    const holds = await Promise.all(
      seeded.placements.map(async (placement) => ({
        orderId: placement.orderId,
        asset: placement.holdAsset,
        amount: formatAmount((await ledger.balance(marketMakerOrderHoldAccount(placement.holdAsset, placement.orderId))).amount),
      })),
    );
    expect(holds.every((hold) => hold.amount !== '0')).toBe(true);

    const answeredNotCancelled: Pick<MatchingClient, 'cancel'> = {
      async cancel(_marketId, orderId) {
        return { cancelled: false, orderId, sequence: null, cancellation: null };
      },
    };

    const cancelled = await cancelSeedMarket(
      {
        marketId: 'btc-usdt',
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
        levels: 1,
        runId: 'run-filled',
      },
      { ledger, matching: answeredNotCancelled },
    );

    expect(cancelled.ok).toBe(true);
    if (!cancelled.ok) return;
    expect(cancelled.placements).toHaveLength(2);
    expect(cancelled.placements.every((p) => p.engineCancelled === false)).toBe(true);
    expect(cancelled.placements.every((p) => p.status === 'not_live_hold_kept')).toBe(true);
    expect(formatAmount((await ledger.balance(marketMaker('USDT'))).amount)).toBe('901');
    expect(formatAmount((await ledger.balance(marketMaker('BTC'))).amount)).toBe('9');
    for (const hold of holds) {
      expect(formatAmount((await ledger.balance(marketMakerOrderHoldAccount(hold.asset, hold.orderId))).amount)).toBe(hold.amount);
    }
    expect(ledger.journal().some((tx) => tx.reason === 'order.hold.mm.released')).toBe(false);
  });

  it('cancel_indeterminate does not release hold (order may still be live)', async () => {
    const ledger = new MemoryLedger();
    await fundMm(ledger, 'USDT', '1000', 'fund-ind');
    await fundMm(ledger, 'BTC', '10', 'fund-ind-b');
    const matching = new SeedStubMatching();

    await seedMarket(
      {
        marketId: 'btc-usdt',
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
        midPrice: '100',
        halfSpreadBps: 100,
        stepBps: 0,
        levels: 1,
        qtyPerLevel: '1',
        runId: 'run-ind',
      },
      { ledger, matching, market: ACTIVE_SPOT, ...readySeedDeps(ACTIVE_SPOT) },
    );

    matching.cancelThrows = true;
    const cancelled = await cancelSeedMarket(
      {
        marketId: 'btc-usdt',
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
        levels: 1,
        runId: 'run-ind',
      },
      { ledger, matching },
    );

    expect(cancelled.ok).toBe(false);
    if (cancelled.ok) return;
    expect(cancelled.reason).toBe('cancel_indeterminate');
    expect(cancelled.placements.every((p) => p.status === 'cancel_indeterminate')).toBe(true);
    // holds still locked
    expect(formatAmount((await ledger.balance(marketMaker('USDT'))).amount)).toBe('901');
    expect(formatAmount((await ledger.balance(marketMaker('BTC'))).amount)).toBe('9');
  });

  it('reseed after cancel with new runId redraws holds (same runId would not)', async () => {
    const ledger = new MemoryLedger();
    await fundMm(ledger, 'USDT', '10000', 'fund-rs');
    await fundMm(ledger, 'BTC', '100', 'fund-rs-b');
    const matching = new SeedStubMatching();

    const first = await seedMarket(
      {
        marketId: 'btc-usdt',
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
        midPrice: '100',
        halfSpreadBps: 100,
        stepBps: 0,
        levels: 1,
        qtyPerLevel: '1',
        runId: 'run-1',
      },
      { ledger, matching, market: ACTIVE_SPOT, ...readySeedDeps(ACTIVE_SPOT) },
    );
    expect(first.ok).toBe(true);

    const cancelled = await cancelSeedMarket(
      {
        marketId: 'btc-usdt',
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
        levels: 1,
        runId: 'run-1',
      },
      { ledger, matching },
    );
    expect(cancelled.ok).toBe(true);
    expect(formatAmount((await ledger.balance(marketMaker('USDT'))).amount)).toBe('10000');

    const second = await seedMarket(
      {
        marketId: 'btc-usdt',
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
        midPrice: '100',
        halfSpreadBps: 100,
        stepBps: 0,
        levels: 1,
        qtyPerLevel: '1',
        runId: 'run-2',
      },
      { ledger, matching, market: ACTIVE_SPOT, ...readySeedDeps(ACTIVE_SPOT) },
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.placements.every((p) => p.status === 'resting')).toBe(true);
    expect(formatAmount((await ledger.balance(marketMaker('USDT'))).amount)).toBe('9901');
    expect(formatAmount((await ledger.balance(marketMaker('BTC'))).amount)).toBe('99');
    // new order ids
    expect(second.placements[0]!.orderId).not.toBe(first.ok ? first.placements[0]!.orderId : '');
  });
});
