import { OtcDeskService } from '../controls/test-admission.js';
/**
 * D26-P1-T2 done bar — RFQ → stake gate → fail-closed quote → ledger settle.
 *
 * Proves the product-complete path on OtcDeskService with ledger-client only.
 * No invented mids/spreads: mid is observed + age-gated; spread/stake/max age
 * come from owner-published desk law.
 */

import { describe, expect, it } from 'vitest';
import { formatAmount, MemoryLedger, parseAmount, recipes, userAvailable } from '@intafaced/ledger-client';

import { FixedOtcStake } from './stake-source.js';
import type { OtcDeskLaw } from './desk-law.js';
import { createObservedOtcMidSource } from './mid-source.js';

const USER = '00000000-0000-4000-8000-000000000099';
const principal = { userId: USER } as import('@intafaced/auth').Principal;

const law: OtcDeskLaw = {
  published: true,
  spreadBps: 50,
  minStake: parseAmount('500'),
  counterparty: 'platform',
  quoteTtlMs: 30_000,
  maxMidAgeSeconds: 30,
};

describe('D26-P1-T2 OTC RFQ stake fail-closed settle', () => {
  it('happy path: RFQ → stake ok → fresh mid quote → accept → ledger settle', async () => {
    const ledger = new MemoryLedger();
    await ledger.post(recipes.marketMakerSeedFund({ assetId: 'BTC', amount: parseAmount('5'), seedId: 'd26-otc-btc' }));
    await ledger.post(recipes.deposit({ userId: USER, assetId: 'USDT', amount: parseAmount('5000'), rail: 'test', railRef: 'd26-otc-u' }));

    let now = new Date('2026-08-12T05:00:00.000Z');
    const svc = new OtcDeskService(ledger, new FixedOtcStake(parseAmount('1000')), {
      law,
      midSource: createObservedOtcMidSource('BTC/USDT:1000', () => now),
      now: () => now,
    });

    const quote = await svc.quote(principal, { side: 'buy', baseAsset: 'BTC', quoteAsset: 'USDT', qty: '1' });
    expect(quote.midPrice).toBe('1000');
    expect(quote.spreadBps).toBe(50);

    const bound = await svc.accept(principal, { quoteId: quote.quoteId });
    expect(bound.fillPrice).toBe(quote.quotedPrice);

    const settled = await svc.settle(principal, { quoteId: quote.quoteId });
    expect(settled.fillId).toBeTruthy();
    expect(formatAmount((await ledger.balance(userAvailable(USER, 'BTC'))).amount)).toBe('1');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('stake gate refuses before any quote is priced', async () => {
    let now = new Date('2026-08-12T05:00:00.000Z');
    const svc = new OtcDeskService(new MemoryLedger(), new FixedOtcStake(parseAmount('1')), {
      law,
      midSource: createObservedOtcMidSource('BTC/USDT:1000', () => now),
      now: () => now,
    });
    await expect(svc.quote(principal, { side: 'buy', baseAsset: 'BTC', quoteAsset: 'USDT', qty: '1' })).rejects.toMatchObject({
      code: 'trade.otc_stake_gate',
    });
  });

  it('fail-closed quote when mid is stale vs owner maxMidAgeSeconds', async () => {
    const observedAt = new Date('2026-08-12T05:00:00.000Z');
    const now = new Date('2026-08-12T05:01:00.000Z'); // 60s > 30s
    const svc = new OtcDeskService(new MemoryLedger(), new FixedOtcStake(parseAmount('1000')), {
      law,
      midSource: createObservedOtcMidSource('BTC/USDT:1000', () => observedAt),
      now: () => now,
    });
    await expect(svc.quote(principal, { side: 'buy', baseAsset: 'BTC', quoteAsset: 'USDT', qty: '1' })).rejects.toMatchObject({
      code: 'trade.otc_no_reference_price',
    });
  });
});
