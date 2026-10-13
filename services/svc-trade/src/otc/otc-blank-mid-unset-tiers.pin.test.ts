import { OtcDeskService } from '../controls/test-admission.js';
/**
 * Pin (trade.otc): blank/unset mid and unset DIRECTION §8 owner tiers refuse.
 * Never invent a mid or stake-tier / spread numbers.
 */

import { describe, expect, it } from 'vitest';
import { MemoryLedger, parseAmount } from '@intafaced/ledger-client';
import { parseOtcDeskLawJson, requirePublishedOtcDeskLaw, UNPUBLISHED_OTC_DESK_LAW, type OtcDeskLaw } from './desk-law.js';
import { OtcError } from './errors.js';

import { parseOtcMidPrice } from './rfq.js';
import { FixedOtcStake } from './stake-source.js';

const USER = '00000000-0000-4000-8000-000000000088';
const principal = { userId: USER } as import('@intafaced/auth').Principal;

const published: OtcDeskLaw = {
  published: true,
  spreadBps: 50,
  minStake: parseAmount('500'),
  counterparty: 'platform',
  quoteTtlMs: 60_000,
  maxMidAgeSeconds: 60,
};

describe('OTC RFQ — blank mid and unset owner tiers refuse', () => {
  it('parseOtcMidPrice refuses blank / null / undefined — never invents zero', () => {
    for (const raw of ['', '   ', null, undefined] as const) {
      try {
        parseOtcMidPrice(raw);
        expect.unreachable('must refuse blank mid');
      } catch (err) {
        expect(err).toBeInstanceOf(OtcError);
        expect((err as OtcError).code).toBe('trade.otc_no_reference_price');
      }
    }
  });

  it('unset owner §8 JSON is unpublished; requirePublished refuses without inventing tiers', () => {
    expect(parseOtcDeskLawJson('')).toEqual({ published: false });
    expect(parseOtcDeskLawJson(null)).toEqual(UNPUBLISHED_OTC_DESK_LAW);
    expect(UNPUBLISHED_OTC_DESK_LAW).toEqual({ published: false });
    try {
      requirePublishedOtcDeskLaw(UNPUBLISHED_OTC_DESK_LAW);
      expect.unreachable('must refuse unset owner tiers');
    } catch (err) {
      expect(err).toBeInstanceOf(OtcError);
      expect((err as OtcError).code).toBe('trade.otc_desk_law_blank');
    }
  });

  it('quote refuses unset owner desk law even when a mid is present', async () => {
    const now = new Date('2026-08-15T10:00:00.000Z');
    const svc = new OtcDeskService(new MemoryLedger(), new FixedOtcStake(parseAmount('9999')), {
      law: UNPUBLISHED_OTC_DESK_LAW,
      midSource: () => ({ mid: '200', asOf: now }),
      now: () => now,
    });
    await expect(svc.quote(principal, { side: 'buy', baseAsset: 'BTC', quoteAsset: 'USDT', qty: '1' })).rejects.toMatchObject({
      code: 'trade.otc_desk_law_blank',
    });
  });

  it('quote refuses a blank sourced mid string — no invented mid', async () => {
    const now = new Date('2026-08-15T10:00:00.000Z');
    const svc = new OtcDeskService(new MemoryLedger(), new FixedOtcStake(parseAmount('1000')), {
      law: published,
      midSource: () => ({ mid: '', asOf: now }),
      now: () => now,
    });
    await expect(svc.quote(principal, { side: 'buy', baseAsset: 'BTC', quoteAsset: 'USDT', qty: '1' })).rejects.toMatchObject({
      code: 'trade.otc_no_reference_price',
    });
  });
});
