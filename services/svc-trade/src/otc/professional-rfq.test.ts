import { OtcDeskService } from '../controls/test-admission.js';
/**
 * Professional RFQ on svc-trade (PTX-M12): firm quote/accept/expire.
 * Reuses the OTC desk. Never invents a mid. Not a book fill.
 */
import { describe, expect, it } from 'vitest';
import { MemoryLedger, parseAmount } from '@intafaced/ledger-client';

import { MemoryOtcQuoteStore } from './quote-store.js';
import { FixedOtcStake } from './stake-source.js';
import { type OtcDeskLaw } from './desk-law.js';
import { OtcError, RFQ_ALLOCATION_RESIDUAL, RFQ_GIVE_UP_RESIDUAL } from './errors.js';
import { createObservedOtcMidSource } from './mid-source.js';
import { expireOtcQuote, parseRequiredOtcPrice, parseRequiredOtcSize } from './rfq.js';

const USER = '00000000-0000-4000-8000-000000000001';
const principal = { userId: USER } as import('@intafaced/auth').Principal;

const published: OtcDeskLaw = {
  published: true,
  spreadBps: 50,
  minStake: parseAmount('500'),
  counterparty: 'platform',
  quoteTtlMs: 60_000,
  maxMidAgeSeconds: 60,
};

function desk(now = new Date('2026-08-26T12:00:00.000Z'), mids = true) {
  return new OtcDeskService(new MemoryLedger(), new FixedOtcStake(parseAmount('1000')), {
    law: published,
    midSource: mids ? createObservedOtcMidSource('BTC/USDT:200', () => now) : undefined,
    now: () => now,
    store: new MemoryOtcQuoteStore(),
  });
}

describe('professional RFQ — missing size/price refuse', () => {
  it('refuses blank size — never invents quantity', () => {
    for (const raw of ['', '   ', null, undefined] as const) {
      try {
        parseRequiredOtcSize(raw);
        expect.unreachable('must refuse blank size');
      } catch (err) {
        expect(err).toBeInstanceOf(OtcError);
        expect((err as OtcError).code).toBe('trade.rfq_missing_size');
      }
    }
  });

  it('refuses blank price — never invents a mid', () => {
    for (const raw of ['', '   ', null, undefined] as const) {
      try {
        parseRequiredOtcPrice(raw);
        expect.unreachable('must refuse blank price');
      } catch (err) {
        expect(err).toBeInstanceOf(OtcError);
        expect((err as OtcError).code).toBe('trade.rfq_missing_price');
      }
    }
  });

  it('quote with blank size refuses', async () => {
    await expect(desk().rfqQuote(principal, { side: 'buy', baseAsset: 'BTC', quoteAsset: 'USDT', qty: '' })).rejects.toMatchObject({
      code: 'trade.rfq_missing_size',
    });
  });

  it('quote with no desk mid refuses rather than invent a price', async () => {
    await expect(
      desk(new Date('2026-08-26T12:00:00.000Z'), false).rfqQuote(principal, {
        side: 'buy',
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
        qty: '1',
      }),
    ).rejects.toMatchObject({ code: 'trade.rfq_missing_price' });
  });
});

describe('professional RFQ — quote / accept / expire', () => {
  it('quotes exact decimals, expiry, and is not a book fill', async () => {
    const quoted = await desk().rfqQuote(principal, {
      side: 'buy',
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
      qty: '1.5',
    });
    expect(quoted.qty).toBe('1.5');
    expect(quoted.midPrice).toBe('200');
    expect(quoted.quotedPrice).toBe('201');
    expect(quoted.userNotional).toBe('301.5');
    expect(quoted.expiresAt).toBe('2026-08-26T12:01:00.000Z');
    expect(quoted.lifecycle).toBe('open');
    expect(quoted.bookFill).toBe(false);
    expect(quoted.midInvented).toBe(false);
  });

  it('accept binds the quoted price — last look on a different price refuses', async () => {
    const svc = desk();
    const quoted = await svc.rfqQuote(principal, { side: 'buy', baseAsset: 'BTC', quoteAsset: 'USDT', qty: '1' });
    await expect(svc.rfqAccept(principal, { quoteId: quoted.quoteId, assertedPrice: '1' })).rejects.toMatchObject({
      code: 'trade.otc_last_look_forbidden',
    });
    const bound = await svc.rfqAccept(principal, { quoteId: quoted.quoteId, assertedPrice: quoted.quotedPrice });
    expect(bound.lifecycle).toBe('bound');
    expect(bound.fillPrice).toBe(quoted.quotedPrice);
    expect(bound.bookFill).toBe(false);
    expect(bound.midInvented).toBe(false);
    const again = await svc.rfqAccept(principal, { quoteId: quoted.quoteId });
    expect(again.acceptedAt).toBe(bound.acceptedAt);
  });

  it('expire then accept refuses — not a book fill and not a requote', async () => {
    const svc = desk();
    const quoted = await svc.rfqQuote(principal, { side: 'sell', baseAsset: 'BTC', quoteAsset: 'USDT', qty: '1' });
    const expired = await svc.rfqExpire(principal, { quoteId: quoted.quoteId });
    expect(expired.lifecycle).toBe('expired');
    expect(expired.bookFill).toBe(false);
    await expect(svc.rfqAccept(principal, { quoteId: quoted.quoteId })).rejects.toMatchObject({
      code: 'trade.otc_quote_expired',
    });
  });

  it('bound quote cannot expire into a book unwind', () => {
    expect(() => expireOtcQuote({ lifecycle: 'bound' })).toThrow(OtcError);
    expect(() => expireOtcQuote({ lifecycle: 'settled' })).toThrow(OtcError);
  });

  it('rfqExpire after accept refuses and does not overwrite the bound quote', async () => {
    const svc = desk();
    const quoted = await svc.rfqQuote(principal, { side: 'buy', baseAsset: 'BTC', quoteAsset: 'USDT', qty: '1' });
    const bound = await svc.rfqAccept(principal, { quoteId: quoted.quoteId, assertedPrice: quoted.quotedPrice });
    expect(bound.lifecycle).toBe('bound');
    await expect(svc.rfqExpire(principal, { quoteId: quoted.quoteId })).rejects.toMatchObject({
      code: 'trade.rfq_already_bound',
    });
    const still = await svc.rfqGet(principal, quoted.quoteId);
    expect(still.lifecycle).toBe('bound');
    expect(still.fillPrice).toBe(bound.fillPrice);
    expect(still.bookFill).toBe(false);
  });
});

describe('professional RFQ — allocation / give-up refuse-closed', () => {
  it('allocate never invents a split', () => {
    try {
      desk().rfqAllocate(principal, { quoteId: '00000000-0000-4000-8000-000000000001' });
      expect.unreachable('must refuse allocation');
    } catch (err) {
      expect(err).toBeInstanceOf(OtcError);
      expect((err as OtcError).code).toBe('trade.rfq_allocation_refused');
      expect((err as OtcError).residual).toBe(RFQ_ALLOCATION_RESIDUAL);
    }
  });

  it('give-up never invents a carrying account', () => {
    try {
      desk().rfqGiveUp(principal, { quoteId: '00000000-0000-4000-8000-000000000001' });
      expect.unreachable('must refuse give-up');
    } catch (err) {
      expect(err).toBeInstanceOf(OtcError);
      expect((err as OtcError).code).toBe('trade.rfq_give_up_refused');
      expect((err as OtcError).residual).toBe(RFQ_GIVE_UP_RESIDUAL);
    }
  });
});
