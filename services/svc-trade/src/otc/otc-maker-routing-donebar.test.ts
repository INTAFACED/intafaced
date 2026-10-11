import { OtcDeskService } from '../controls/test-admission.js';
/**
 * Done bar — SOCKET §13 `socket.otc-maker-routing`.
 *
 * Platform-principal RFQ settle is real. Maker-routed settle must refuse by
 * name on the public desk door and in planOtcSettle — never invent a maker
 * ledger path. Closing the socket needs owner routing recipe + ledger posts.
 */

import { describe, expect, it } from 'vitest';
import { MemoryLedger, parseAmount } from '@intafaced/ledger-client';

import { FixedOtcStake } from './stake-source.js';
import { planOtcSettle } from './settle.js';
import { acceptOtcQuote, buildOtcQuote } from './rfq.js';
import type { OtcDeskLaw } from './desk-law.js';
import { OTC_MAKER_ROUTING_RESIDUAL, OTC_MAKER_ROUTING_SOCKET, otcMakerRoutingStatus } from './maker-routing.js';
import { OtcError } from './errors.js';

const USER = '00000000-0000-4000-8000-0000000000aa';

const platformLaw: OtcDeskLaw = {
  published: true,
  spreadBps: 50,
  minStake: parseAmount('100'),
  counterparty: 'platform',
  quoteTtlMs: 30_000,
  maxMidAgeSeconds: 60,
};

describe('socket.otc-maker-routing Done bar', () => {
  it('deskStatus names the socket refuse-closed (never published)', () => {
    const svc = new OtcDeskService(new MemoryLedger(), new FixedOtcStake(parseAmount('0')), {
      law: platformLaw,
    });
    const status = svc.deskStatus();
    expect(status.makerRouting).toEqual(otcMakerRoutingStatus());
    expect(status.makerRouting.published).toBe(false);
    expect(status.makerRouting.socket).toBe(OTC_MAKER_ROUTING_SOCKET);
    expect(status.residuals.makerRouting).toBe(OTC_MAKER_ROUTING_RESIDUAL);
  });

  it('planOtcSettle refuses maker counterparty naming the socket', () => {
    const q = buildOtcQuote({
      quoteId: 'maker-q1',
      userId: USER,
      side: 'buy',
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
      qty: parseAmount('1'),
      midPrice: parseAmount('100'),
      spreadBps: 100,
      counterparty: 'maker',
      counterpartyId: 'maker:external-1',
      now: new Date('2026-08-12T12:00:00.000Z'),
      quoteTtlMs: 30_000,
    });
    const bound = acceptOtcQuote({ quote: q, now: new Date('2026-08-12T12:00:01.000Z') });

    expect(() =>
      planOtcSettle({
        law: { ...platformLaw, counterparty: 'maker' },
        bound,
        takerOrderId: 't1',
        makerOrderId: 'm1',
        fillId: 'f1',
      }),
    ).toThrow(OtcError);

    try {
      planOtcSettle({
        law: { ...platformLaw, counterparty: 'maker' },
        bound,
        takerOrderId: 't1',
        makerOrderId: 'm1',
        fillId: 'f1',
      });
    } catch (e) {
      expect(e).toBeInstanceOf(OtcError);
      const err = e as OtcError;
      expect(err.message).toContain(OTC_MAKER_ROUTING_SOCKET);
      expect(err.residual).toBe(OTC_MAKER_ROUTING_RESIDUAL);
      expect(err.code).toBe('trade.otc_settle_refused');
    }
  });
});
