import { OtcDeskService } from '../controls/test-admission.js';
import { describe, expect, it } from 'vitest';
import { MemoryLedger, parseAmount, recipes } from '@intafaced/ledger-client';

import { MemoryOtcQuoteStore } from './quote-store.js';
import { FixedOtcStake } from './stake-source.js';
import { UNPUBLISHED_OTC_DESK_LAW, type OtcDeskLaw } from './desk-law.js';
import { OtcError } from './errors.js';
import { createConfigOtcMidSource, createObservedOtcMidSource } from './mid-source.js';
import { describeOtcPolicy } from './otc-policy.js';

const USER = '00000000-0000-4000-8000-000000000001';
/** Minimal principal — avoid pulling auth/contracts into this suite's graph. */
const principal = { userId: USER } as import('@intafaced/auth').Principal;

const published: OtcDeskLaw = {
  published: true,
  spreadBps: 50,
  minStake: parseAmount('500'),
  counterparty: 'platform',
  quoteTtlMs: 60_000,
  maxMidAgeSeconds: 60,
};

/** Fresh observed mid — standing in for a live TRADE_OTC_MIDS / feed. */
function freshMids(now: () => Date) {
  return createObservedOtcMidSource('BTC/USDT:200', now);
}

describe('OtcDeskService', () => {
  it('deskStatus midFeed matches policy bootMidFeedWiring when wiring not injected (D42)', () => {
    const svc = new OtcDeskService(new MemoryLedger(), new FixedOtcStake(parseAmount('0')));
    expect(svc.deskStatus().midFeed).toEqual(describeOtcPolicy().bootMidFeedWiring);
  });

  it('deskStatus refuse-closed when law blank', () => {
    const svc = new OtcDeskService(new MemoryLedger(), new FixedOtcStake(parseAmount('0')), {
      law: UNPUBLISHED_OTC_DESK_LAW,
    });
    const s = svc.deskStatus();
    expect(s.published).toBe(false);
    expect(s.residual).toContain('DIRECTION §8');
    expect(s.makerRouting.socket).toBe('socket.otc-maker-routing');
    expect(s.makerRouting.published).toBe(false);
  });

  it('quote refuses when desk law blank — never invents spread', async () => {
    let now = new Date('2026-08-07T12:00:00.000Z');
    const svc = new OtcDeskService(new MemoryLedger(), new FixedOtcStake(parseAmount('9999')), {
      law: UNPUBLISHED_OTC_DESK_LAW,
      midSource: freshMids(() => now),
    });
    await expect(svc.quote(principal, { side: 'buy', baseAsset: 'BTC', quoteAsset: 'USDT', qty: '1' })).rejects.toMatchObject({
      code: 'trade.otc_desk_law_blank',
    });
  });

  it('quote refuses stake gate when below owner min', async () => {
    let now = new Date('2026-08-07T12:00:00.000Z');
    const svc = new OtcDeskService(new MemoryLedger(), new FixedOtcStake(parseAmount('100')), {
      law: published,
      midSource: freshMids(() => now),
    });
    await expect(svc.quote(principal, { side: 'buy', baseAsset: 'BTC', quoteAsset: 'USDT', qty: '1' })).rejects.toMatchObject({
      code: 'trade.otc_stake_gate',
    });
  });

  it('quote → accept binds price; last look refused; settle via ledger', async () => {
    const ledger = new MemoryLedger();
    await ledger.post(recipes.marketMakerSeedFund({ assetId: 'BTC', amount: parseAmount('10'), seedId: 'otc-btc' }));
    await ledger.post(recipes.deposit({ userId: USER, assetId: 'USDT', amount: parseAmount('10000'), rail: 'test', railRef: 'otc-u' }));

    let now = new Date('2026-08-07T12:00:00.000Z');
    const svc = new OtcDeskService(ledger, new FixedOtcStake(parseAmount('1000')), {
      law: published,
      midSource: freshMids(() => now),
      now: () => now,
    });

    const quote = await svc.quote(principal, { side: 'buy', baseAsset: 'BTC', quoteAsset: 'USDT', qty: '1' });
    expect(quote.counterparty).toBe('platform');
    expect(quote.spreadBps).toBe(50);
    expect(quote.qty).toBe('1');
    expect(quote.expiresAt).toBeTruthy();
    // The mid is the desk's published one, not anything the caller could reach.
    expect(quote.midPrice).toBe('200');

    await expect(svc.accept(principal, { quoteId: quote.quoteId, assertedPrice: '1' })).rejects.toMatchObject({
      code: 'trade.otc_last_look_forbidden',
    });

    const bound = await svc.accept(principal, { quoteId: quote.quoteId });
    expect(bound.fillPrice).toBe(quote.quotedPrice);
    expect(bound.fillNotional).toBe(quote.userNotional);

    const settled = await svc.settle(principal, { quoteId: quote.quoteId });
    expect(settled.fillId).toBeTruthy();
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('a stranger accept matches a missing quote', async () => {
    let now = new Date('2026-08-07T12:00:00.000Z');
    const svc = new OtcDeskService(new MemoryLedger(), new FixedOtcStake(parseAmount('1000')), {
      law: published,
      midSource: freshMids(() => now),
      now: () => now,
    });
    const quote = await svc.quote(principal, { side: 'buy', baseAsset: 'BTC', quoteAsset: 'USDT', qty: '1' });
    const stranger = { userId: '00000000-0000-4000-8000-000000000002' } as import('@intafaced/auth').Principal;
    const missing = await svc.accept(stranger, { quoteId: '00000000-0000-4000-8000-000000000099' }).then(
      () => null,
      (err: unknown) => err,
    );
    const foreign = await svc.accept(stranger, { quoteId: quote.quoteId }).then(
      () => null,
      (err: unknown) => err,
    );
    expect(missing).toBeInstanceOf(OtcError);
    expect(foreign).toBeInstanceOf(OtcError);
    expect((foreign as OtcError).code).toBe((missing as OtcError).code);
    expect((foreign as OtcError).message).toBe((missing as OtcError).message);
  });

  it('accept after expiry refuses', async () => {
    let now = new Date('2026-08-07T12:00:00.000Z');
    const svc = new OtcDeskService(new MemoryLedger(), new FixedOtcStake(parseAmount('1000')), {
      law: published,
      midSource: freshMids(() => now),
      now: () => now,
    });
    const quote = await svc.quote(principal, { side: 'sell', baseAsset: 'BTC', quoteAsset: 'USDT', qty: '1' });
    now = new Date('2026-08-07T13:00:00.000Z');
    await expect(svc.accept(principal, { quoteId: quote.quoteId })).rejects.toBeInstanceOf(OtcError);
  });

  /**
   * The caller cannot price their own trade.
   *
   * Before this, `midPrice` was a required wire input: a staked caller quoted
   * `midPrice: "1"` for 10 BTC, accepted, settled, and the house market-maker
   * inventory left at their number. There is no defence left if this refusal
   * stops firing, so it is asserted directly rather than through the router.
   */
  it('refuses when the desk can source no mid — and there is no caller override', async () => {
    const svc = new OtcDeskService(new MemoryLedger(), new FixedOtcStake(parseAmount('1000')), {
      law: published,
      // No midSource → production default → nothing published for any pair.
    });
    await expect(svc.quote(principal, { side: 'buy', baseAsset: 'BTC', quoteAsset: 'USDT', qty: '1' })).rejects.toMatchObject({
      code: 'trade.otc_no_reference_price',
    });

    // A pair the ops map does not name refuses too — an empty entry is not zero.
    let now = new Date('2026-08-07T12:00:00.000Z');
    const partial = new OtcDeskService(new MemoryLedger(), new FixedOtcStake(parseAmount('1000')), {
      law: published,
      midSource: freshMids(() => now),
      now: () => now,
    });
    await expect(partial.quote(principal, { side: 'buy', baseAsset: 'SOL', quoteAsset: 'USDT', qty: '1' })).rejects.toMatchObject({
      code: 'trade.otc_no_reference_price',
    });
  });

  /**
   * Stale mid is refuse-closed (TRADE-PROMISE F4 / D26-P1-T2 fail-closed quote).
   * Boot-stamped config mids go dark after owner maxMidAgeSeconds.
   */
  it('refuses when mid asOf is older than owner maxMidAgeSeconds', async () => {
    const boot = new Date('2026-08-07T12:00:00.000Z');
    const now = new Date('2026-08-07T12:02:00.000Z'); // 120s > 60s law
    const svc = new OtcDeskService(new MemoryLedger(), new FixedOtcStake(parseAmount('1000')), {
      law: published,
      midSource: createConfigOtcMidSource('BTC/USDT:200', boot),
      now: () => now,
    });
    await expect(svc.quote(principal, { side: 'buy', baseAsset: 'BTC', quoteAsset: 'USDT', qty: '1' })).rejects.toMatchObject({
      code: 'trade.otc_no_reference_price',
    });
  });

  /**
   * A settle retry must find the ledger's original transaction.
   *
   * The ids were `randomUUID()` per call, so a settle that threw after the
   * taker hold posted left the bound fill in place, and the retry posted a
   * SECOND hold under fresh keys with nothing that ever released the first.
   */
  it('settle ids are derived from the quote, so a retry cannot double-post', async () => {
    const ledger = new MemoryLedger();
    await ledger.post(recipes.marketMakerSeedFund({ assetId: 'BTC', amount: parseAmount('10'), seedId: 'otc-btc-2' }));
    await ledger.post(recipes.deposit({ userId: USER, assetId: 'USDT', amount: parseAmount('10000'), rail: 'test', railRef: 'otc-u2' }));

    let now = new Date('2026-08-07T12:00:00.000Z');
    const svc = new OtcDeskService(ledger, new FixedOtcStake(parseAmount('1000')), {
      law: published,
      midSource: freshMids(() => now),
      now: () => now,
    });

    const quote = await svc.quote(principal, { side: 'buy', baseAsset: 'BTC', quoteAsset: 'USDT', qty: '1' });
    await svc.accept(principal, { quoteId: quote.quoteId });

    const first = await svc.settle(principal, { quoteId: quote.quoteId });

    // Re-derive from the same quote id the way a retry would, and prove the
    // keys are stable — the property the ledger's dedupe rests on.
    const { otcSettleIdsFor } = await import('../spot/ids.js');
    expect(otcSettleIdsFor(quote.quoteId)).toEqual({
      takerOrderId: first.takerOrderId,
      makerOrderId: first.makerOrderId,
      fillId: first.fillId,
    });
    expect(otcSettleIdsFor(quote.quoteId)).toEqual(otcSettleIdsFor(quote.quoteId));
    // A different quote is a different settle.
    expect(otcSettleIdsFor('other-quote').fillId).not.toBe(first.fillId);

    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('accept and settle survive a new process sharing the durable store', async () => {
    const ledger = new MemoryLedger();
    await ledger.post(recipes.marketMakerSeedFund({ assetId: 'BTC', amount: parseAmount('10'), seedId: 'otc-btc-d' }));
    await ledger.post(recipes.deposit({ userId: USER, assetId: 'USDT', amount: parseAmount('10000'), rail: 'test', railRef: 'otc-ud' }));

    const store = new MemoryOtcQuoteStore();
    let now = new Date('2026-08-07T12:00:00.000Z');
    const opts = {
      law: published,
      midSource: freshMids(() => now),
      now: () => now,
      store,
    };
    const first = new OtcDeskService(ledger, new FixedOtcStake(parseAmount('1000')), opts);
    const quote = await first.quote(principal, { side: 'buy', baseAsset: 'BTC', quoteAsset: 'USDT', qty: '1' });

    const afterRestart = new OtcDeskService(ledger, new FixedOtcStake(parseAmount('1000')), opts);
    const bound = await afterRestart.accept(principal, { quoteId: quote.quoteId });
    expect(bound.fillPrice).toBe(quote.quotedPrice);

    const afterAcceptRestart = new OtcDeskService(ledger, new FixedOtcStake(parseAmount('1000')), opts);
    const settled = await afterAcceptRestart.settle(principal, { quoteId: quote.quoteId });
    expect(settled.fillId).toBeTruthy();
    expect(ledger.reconcile()).toEqual({ ok: true });

    const replay = await afterAcceptRestart.settle(principal, { quoteId: quote.quoteId });
    expect(replay.fillId).toBe(settled.fillId);
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('accept after settle on the durable store refuses rather than requoting', async () => {
    const ledger = new MemoryLedger();
    await ledger.post(recipes.marketMakerSeedFund({ assetId: 'BTC', amount: parseAmount('10'), seedId: 'otc-btc-s' }));
    await ledger.post(recipes.deposit({ userId: USER, assetId: 'USDT', amount: parseAmount('10000'), rail: 'test', railRef: 'otc-us' }));
    const store = new MemoryOtcQuoteStore();
    let now = new Date('2026-08-07T12:00:00.000Z');
    const svc = new OtcDeskService(ledger, new FixedOtcStake(parseAmount('1000')), {
      law: published,
      midSource: freshMids(() => now),
      now: () => now,
      store,
    });
    const quote = await svc.quote(principal, { side: 'buy', baseAsset: 'BTC', quoteAsset: 'USDT', qty: '1' });
    await svc.accept(principal, { quoteId: quote.quoteId });
    await svc.settle(principal, { quoteId: quote.quoteId });
    await expect(svc.accept(principal, { quoteId: quote.quoteId })).rejects.toMatchObject({
      code: 'trade.otc_already_settled',
    });
  });
});
