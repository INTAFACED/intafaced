import { OtcDeskService } from '../controls/test-admission.js';
/**
 * Pin: OTC quote stays fail-closed when DIRECTION §8 spreads / stake /
 * maxMidAgeSeconds are blank, OR the reference mid is dark / stale.
 *
 * Do not invent a spread or a mid. Owner numbers stay residual — this suite
 * only pins the refuse, it does not publish law.
 */

import { describe, expect, it } from 'vitest';
import { parseAmount, MemoryLedger } from '@intafaced/ledger-client';

import { FixedOtcStake } from './stake-source.js';
import { parseOtcDeskLawJson, UNPUBLISHED_OTC_DESK_LAW, type OtcDeskLaw } from './desk-law.js';
import { OtcError } from './errors.js';
import { createConfigOtcMidSource, createObservedOtcMidSource, NO_OTC_MIDS } from './mid-source.js';

const USER = '00000000-0000-4000-8000-000000000077';
const principal = { userId: USER } as import('@intafaced/auth').Principal;

const published: OtcDeskLaw = {
  published: true,
  spreadBps: 50,
  minStake: parseAmount('500'),
  counterparty: 'platform',
  quoteTtlMs: 60_000,
  maxMidAgeSeconds: 60,
};

function buyBtc() {
  return { side: 'buy' as const, baseAsset: 'BTC', quoteAsset: 'USDT', qty: '1' };
}

describe('OTC quote fail-closed pin — blank §8 law or dark/stale mid', () => {
  it('unpublished law object carries no invented spread, stake, or max-age', () => {
    expect(UNPUBLISHED_OTC_DESK_LAW).toEqual({ published: false });
    expect('spreadBps' in UNPUBLISHED_OTC_DESK_LAW).toBe(false);
    expect('minStake' in UNPUBLISHED_OTC_DESK_LAW).toBe(false);
    expect('maxMidAgeSeconds' in UNPUBLISHED_OTC_DESK_LAW).toBe(false);
  });

  it('JSON missing spreadBps / minStake / maxMidAgeSeconds refuses — no default numbers', () => {
    const base = { published: true, counterparty: 'platform', quoteTtlMs: 15_000 };
    expect(() => parseOtcDeskLawJson(JSON.stringify({ ...base, minStake: '1', maxMidAgeSeconds: 60 }))).toThrow(OtcError);
    expect(() => parseOtcDeskLawJson(JSON.stringify({ ...base, spreadBps: 25, maxMidAgeSeconds: 60 }))).toThrow(OtcError);
    expect(() => parseOtcDeskLawJson(JSON.stringify({ ...base, spreadBps: 25, minStake: '1' }))).toThrow(OtcError);
  });

  it('quote refuses when law is omitted (constructor default) even if a mid is present', async () => {
    const now = new Date('2026-08-15T09:00:00.000Z');
    const svc = new OtcDeskService(new MemoryLedger(), new FixedOtcStake(parseAmount('9999')), {
      midSource: createObservedOtcMidSource('BTC/USDT:200', () => now),
      now: () => now,
    });
    await expect(svc.quote(principal, buyBtc())).rejects.toMatchObject({ code: 'trade.otc_desk_law_blank' });
  });

  it('quote refuses unpublished law even when a live mid is sitting on the desk', async () => {
    const now = new Date('2026-08-15T09:00:00.000Z');
    const svc = new OtcDeskService(new MemoryLedger(), new FixedOtcStake(parseAmount('9999')), {
      law: UNPUBLISHED_OTC_DESK_LAW,
      midSource: createObservedOtcMidSource('BTC/USDT:200', () => now),
      now: () => now,
    });
    await expect(svc.quote(principal, buyBtc())).rejects.toMatchObject({ code: 'trade.otc_desk_law_blank' });
  });

  it('quote refuses a dark mid — production default sources nothing', async () => {
    const now = new Date('2026-08-15T09:00:00.000Z');
    const svc = new OtcDeskService(new MemoryLedger(), new FixedOtcStake(parseAmount('1000')), {
      law: published,
      midSource: NO_OTC_MIDS,
      now: () => now,
    });
    await expect(svc.quote(principal, buyBtc())).rejects.toMatchObject({ code: 'trade.otc_no_reference_price' });
  });

  it('quote refuses a blank sourced mid string — never treat empty as zero', async () => {
    const now = new Date('2026-08-15T09:00:00.000Z');
    const svc = new OtcDeskService(new MemoryLedger(), new FixedOtcStake(parseAmount('1000')), {
      law: published,
      midSource: () => ({ mid: '   ', asOf: now }),
      now: () => now,
    });
    await expect(svc.quote(principal, buyBtc())).rejects.toMatchObject({ code: 'trade.otc_no_reference_price' });
  });

  it('quote refuses a stale mid vs owner maxMidAgeSeconds — no memory price', async () => {
    const boot = new Date('2026-08-15T09:00:00.000Z');
    const now = new Date('2026-08-15T09:02:00.000Z'); // 120s > 60s
    const svc = new OtcDeskService(new MemoryLedger(), new FixedOtcStake(parseAmount('1000')), {
      law: published,
      midSource: createConfigOtcMidSource('BTC/USDT:200', boot),
      now: () => now,
    });
    await expect(svc.quote(principal, buyBtc())).rejects.toMatchObject({ code: 'trade.otc_no_reference_price' });
  });
});
