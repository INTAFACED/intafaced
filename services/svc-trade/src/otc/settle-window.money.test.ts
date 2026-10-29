import { OtcDeskService } from '../controls/test-admission.js';
/**
 * CB-otc-07 deferred settlement: an accepted quote settles only inside the owner's window (or, with the window blank,
 * while the quote itself is firm). Past it the settle refuses `trade.rfq_window_passed` and nothing moves; a settle that
 * already began in time still finishes on retry, so the funds its first post held are never stranded.
 */
import { describe, expect, it } from 'vitest';
import {
  formatAmount,
  MemoryLedger,
  parseAmount,
  recipes,
  userAvailable,
  type LedgerClient,
  type PostRequest,
} from '@intafaced/ledger-client';

import { FixedOtcStake } from './stake-source.js';
import { parseOtcDeskLawJson, type OtcDeskLaw } from './desk-law.js';
import { createObservedOtcMidSource } from './mid-source.js';
import { MemoryOtcQuoteStore } from './quote-store.js';

const USER = '00000000-0000-4000-8000-000000000077';
const principal = { userId: USER } as import('@intafaced/auth').Principal;
const WINDOW_MS = 90_000;

const law = (settleWindowMs: number | null): OtcDeskLaw => ({
  published: true,
  spreadBps: 50,
  minStake: parseAmount('0'),
  counterparty: 'platform',
  quoteTtlMs: 30_000,
  maxMidAgeSeconds: 86_400,
  // A zero desk minimum is an owner value: these quotes are not held by the CB-otc-07 minimum.
  minNotional: { USDT: 0n },
  assets: ['BTC'],
  settleWindowMs,
});

async function boundDesk(settleWindowMs: number | null, ledger: MemoryLedger = new MemoryLedger()) {
  await ledger.post(recipes.marketMakerSeedFund({ assetId: 'BTC', amount: parseAmount('5'), seedId: 'otc-window-btc' }));
  await ledger.post(recipes.deposit({ userId: USER, assetId: 'USDT', amount: parseAmount('5000'), rail: 'test', railRef: 'otc-window-u' }));
  const clock = { now: new Date('2026-10-29T12:00:00.000Z') };
  const store = new MemoryOtcQuoteStore();
  const desk = new OtcDeskService(ledger, new FixedOtcStake(parseAmount('0')), {
    // The house desk is the one provider these requests ask (CB-otc-01).
    makerDirectory: { published: true, makers: [{ id: 'house', name: 'House desk', route: 'platform' }], selectCap: 1 },
    law: law(settleWindowMs),
    midSource: createObservedOtcMidSource('BTC/USDT:1000', () => clock.now),
    now: () => clock.now,
    store,
  });
  const quote = await desk.rfqQuote(principal, { side: 'buy', baseAsset: 'BTC', quoteAsset: 'USDT', qty: '1', makerIds: ['house'] });
  const accepted = await desk.rfqAccept(principal, { quoteId: quote.quoteId, assertedPrice: quote.quotedPrice });
  const postsBeforeSettle = ledger.journal().length;
  return { ledger, desk, store, clock, quote, accepted, postsBeforeSettle };
}

const usdt = async (ledger: LedgerClient) => formatAmount((await ledger.balance(userAvailable(USER, 'USDT'))).amount);
const btc = async (ledger: LedgerClient) => formatAmount((await ledger.balance(userAvailable(USER, 'BTC'))).amount);

describe('CB-otc-07 deferred settlement window', () => {
  it('reads the window from the owner law; left out is blank, out of range refuses at boot', () => {
    const base = { published: true, spreadBps: 0, minStake: '0', counterparty: 'platform', quoteTtlMs: 1000, maxMidAgeSeconds: 1 };
    expect(parseOtcDeskLawJson(JSON.stringify(base))).toMatchObject({ settleWindowMs: null });
    expect(parseOtcDeskLawJson(JSON.stringify({ ...base, settleWindowMs: WINDOW_MS }))).toMatchObject({ settleWindowMs: WINDOW_MS });
    for (const bad of [0, 999, 86_400_001, 1.5, '90000']) {
      expect(() => parseOtcDeskLawJson(JSON.stringify({ ...base, settleWindowMs: bad }))).toThrow(/settleWindowMs/);
    }
  });

  it('names the settle-by time on the accepted quote: the accept plus the window', async () => {
    const { desk, quote, accepted } = await boundDesk(WINDOW_MS);
    expect(accepted.lifecycle).toBe('bound');
    expect(Date.parse(accepted.settleBy ?? '') - Date.parse(accepted.acceptedAt ?? '')).toBe(WINDOW_MS);
    expect((await desk.rfqGet(principal, quote.quoteId)).settleBy).toBe(accepted.settleBy);
  });

  it('settles once at the last moment of the window, with its key, and a retry posts nothing more', async () => {
    const { ledger, desk, clock, quote, accepted, postsBeforeSettle } = await boundDesk(WINDOW_MS);
    clock.now = new Date(Date.parse(accepted.settleBy ?? ''));
    const settled = await desk.settle(principal, { quoteId: quote.quoteId });
    expect(settled.fillId).toBeTruthy();
    expect(ledger.journal().length - postsBeforeSettle).toBe(3);
    expect(await btc(ledger)).toBe('1');
    expect(await usdt(ledger)).toBe(formatAmount(parseAmount('5000') - parseAmount(quote.userNotional)));

    const again = await desk.settle(principal, { quoteId: quote.quoteId });
    expect(again.fillId).toBe(settled.fillId);
    expect(ledger.journal().length - postsBeforeSettle).toBe(3);
    expect(await btc(ledger)).toBe('1');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('refuses a settle after the window, moves nothing, and leaves the quote accepted', async () => {
    const { ledger, desk, store, clock, quote, accepted, postsBeforeSettle } = await boundDesk(WINDOW_MS);
    clock.now = new Date(Date.parse(accepted.settleBy ?? '') + 1);
    await expect(desk.settle(principal, { quoteId: quote.quoteId })).rejects.toMatchObject({ code: 'trade.rfq_window_passed' });
    expect(ledger.journal()).toHaveLength(postsBeforeSettle);
    expect(await usdt(ledger)).toBe('5000');
    expect(await btc(ledger)).toBe('0');
    expect((await store.load(quote.quoteId))?.lifecycle).toBe('bound');
  });

  it('finishes a settle that began inside the window and crashed, even when the retry comes after it', async () => {
    const real = new MemoryLedger();
    let failNext = false;
    let posts = 0;
    // Crashes on the settle's second post (the customer's hold), after the house hold has landed.
    const flaky = Object.assign(Object.create(real) as MemoryLedger, {
      async post(request: PostRequest) {
        if (failNext && ++posts === 2) throw new Error('crash between the house hold and the customer hold');
        return real.post(request);
      },
    });
    const { desk, store, clock, quote, accepted } = await boundDesk(WINDOW_MS, flaky);
    failNext = true;
    await expect(desk.settle(principal, { quoteId: quote.quoteId })).rejects.toThrow(/crash/);
    failNext = false;

    clock.now = new Date(Date.parse(accepted.settleBy ?? '') + 60_000);
    const settled = await desk.settle(principal, { quoteId: quote.quoteId });
    expect(settled.fillId).toBeTruthy();
    expect(await btc(real)).toBe('1');
    expect((await store.load(quote.quoteId))?.lifecycle).toBe('settled');
    expect(real.reconcile()).toEqual({ ok: true });
  });

  it('with the window blank there is no deferral: "Not set", settle by the quote expiry, and a settle after it refuses', async () => {
    const { ledger, desk, clock, quote, accepted, postsBeforeSettle } = await boundDesk(null);
    expect(accepted.settleWindowMs).toBeNull();
    expect(accepted.settleBy).toBe(quote.expiresAt);
    expect((await desk.rfqGet(principal, quote.quoteId)).settleBy).toBe(quote.expiresAt);
    clock.now = new Date(Date.parse(quote.expiresAt) + 1);
    await expect(desk.settle(principal, { quoteId: quote.quoteId })).rejects.toMatchObject({ code: 'trade.rfq_window_passed' });
    expect(ledger.journal()).toHaveLength(postsBeforeSettle);
  });

  it('with the window blank a settle while the quote is still firm goes through', async () => {
    const { ledger, desk, clock, quote } = await boundDesk(null);
    clock.now = new Date(Date.parse(quote.expiresAt));
    await desk.settle(principal, { quoteId: quote.quoteId });
    expect(await btc(ledger)).toBe('1');
  });
});
