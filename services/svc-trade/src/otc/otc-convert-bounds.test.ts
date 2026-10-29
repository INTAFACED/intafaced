/**
 * CB-otc-12 — one-click large buy and convert at OTC pricing: owner bounds.
 * Bounds, spread, stake and mid below are TEST fixtures, not owner values.
 */
import { OtcDeskService } from '../controls/test-admission.js';
import { describe, expect, it } from 'vitest';
import { MemoryLedger, parseAmount } from '@intafaced/ledger-client';
import type { OtcDeskLaw } from './desk-law.js';
import { OtcError, type OtcErrorCode } from './errors.js';
import { createObservedOtcMidSource } from './mid-source.js';
import { FixedOtcStake } from './stake-source.js';
import {
  assertOtcConvertBounds,
  describeOtcConvertBounds,
  NO_OTC_CONVERT_BOUNDS,
  parseOtcConvertBoundsJson,
} from './otc-convert-bounds.js';

const principal = { userId: '00000000-0000-4000-8000-000000000001' } as import('@intafaced/auth').Principal;
const TEST_LAW: OtcDeskLaw = {
  published: true,
  spreadBps: 50,
  minStake: parseAmount('500'),
  counterparty: 'platform',
  quoteTtlMs: 60_000,
  maxMidAgeSeconds: 60,
  // The desk minimum is left blank on purpose: convert is sized by its own owner bounds, never by the RFQ desk minimum
  // (CB-otc-07), so every convert below prices without one.
};
const TEST_BOUNDS_JSON = JSON.stringify({ convert: { minQty: '1', maxQty: '10' }, oneClickBuy: { minQty: '2', maxQty: '5' } });

function codeOf(fn: () => unknown): OtcErrorCode {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(OtcError);
    return (err as OtcError).code;
  }
  throw new Error('expected a refusal');
}

function desk(convertBoundsJson: string) {
  const now = () => new Date('2026-10-22T03:00:00.000Z');
  return new OtcDeskService(new MemoryLedger(), new FixedOtcStake(parseAmount('9999')), {
    law: TEST_LAW,
    midSource: createObservedOtcMidSource('BTC/USDT:200', now),
    convertBounds: parseOtcConvertBoundsJson(convertBoundsJson),
    now,
  });
}

describe('parseOtcConvertBoundsJson', () => {
  it('blank sets no bounds', () => {
    expect(parseOtcConvertBoundsJson('')).toEqual({});
    expect(parseOtcConvertBoundsJson(undefined)).toEqual({});
  });

  it('parses both flows as scaled bigint', () => {
    const b = parseOtcConvertBoundsJson(TEST_BOUNDS_JSON);
    expect(b.convert).toEqual({ minQty: parseAmount('1'), maxQty: parseAmount('10') });
    expect(describeOtcConvertBounds(b)).toEqual({
      convert: { minQty: '1', maxQty: '10' },
      oneClickBuy: { minQty: '2', maxQty: '5' },
    });
  });

  it.each([
    ['not json', '{'],
    ['array', '[]'],
    ['unknown flow', JSON.stringify({ swap: { minQty: '1', maxQty: '2' } })],
    ['number amount', JSON.stringify({ convert: { minQty: 1, maxQty: '2' } })],
    ['missing max', JSON.stringify({ convert: { minQty: '1' } })],
    ['zero min', JSON.stringify({ convert: { minQty: '0', maxQty: '2' } })],
    ['min above max', JSON.stringify({ convert: { minQty: '3', maxQty: '2' } })],
    ['extra field', JSON.stringify({ convert: { minQty: '1', maxQty: '2', fee: '1' } })],
  ])('refuses %s', (_l, raw) => {
    expect(codeOf(() => parseOtcConvertBoundsJson(raw))).toBe('trade.convert_bounds_not_set');
  });
});

describe('assertOtcConvertBounds', () => {
  const b = parseOtcConvertBoundsJson(JSON.stringify({ convert: { minQty: '1', maxQty: '10' } }));
  it('blank flow refuses trade.convert_bounds_not_set', () => {
    expect(codeOf(() => assertOtcConvertBounds(NO_OTC_CONVERT_BOUNDS, 'convert', parseAmount('2')))).toBe('trade.convert_bounds_not_set');
    expect(codeOf(() => assertOtcConvertBounds(b, 'oneClickBuy', parseAmount('2')))).toBe('trade.convert_bounds_not_set');
  });
  it('inside the bounds (edges included) passes; outside refuses', () => {
    expect(() => assertOtcConvertBounds(b, 'convert', parseAmount('1'))).not.toThrow();
    expect(() => assertOtcConvertBounds(b, 'convert', parseAmount('10'))).not.toThrow();
    expect(codeOf(() => assertOtcConvertBounds(b, 'convert', parseAmount('0.5')))).toBe('trade.convert_out_of_bounds');
    expect(codeOf(() => assertOtcConvertBounds(b, 'convert', parseAmount('10.000000000000000001')))).toBe('trade.convert_out_of_bounds');
  });
});

describe('OtcDeskService.convertQuote', () => {
  const input = { flow: 'convert' as const, side: 'buy' as const, baseAsset: 'BTC', quoteAsset: 'USDT', qty: '2' };

  it('blank bounds refuse before any price is quoted', async () => {
    await expect(desk('').convertQuote(principal, input)).rejects.toMatchObject({ code: 'trade.convert_bounds_not_set' });
  });

  it('an amount inside the bounds returns the OTC desk price and expiry', async () => {
    const q = await desk(TEST_BOUNDS_JSON).convertQuote(principal, input);
    expect(q.flow).toBe('convert');
    expect(q.midPrice).toBe('200');
    expect(q.quotedPrice).not.toBe(q.midPrice);
    expect(q.expiresAt).toBeTruthy();
  });

  it('an amount outside the bounds refuses', async () => {
    await expect(desk(TEST_BOUNDS_JSON).convertQuote(principal, { ...input, qty: '11' })).rejects.toMatchObject({
      code: 'trade.convert_out_of_bounds',
    });
  });

  it('one-click buy has its own bounds and only buys', async () => {
    const svc = desk(TEST_BOUNDS_JSON);
    await expect(svc.convertQuote(principal, { ...input, flow: 'oneClickBuy', qty: '6' })).rejects.toMatchObject({
      code: 'trade.convert_out_of_bounds',
    });
    await expect(svc.convertQuote(principal, { ...input, flow: 'oneClickBuy', side: 'sell', qty: '3' })).rejects.toMatchObject({
      code: 'trade.convert_flow_side_refused',
    });
    expect((await svc.convertQuote(principal, { ...input, flow: 'oneClickBuy', qty: '3' })).flow).toBe('oneClickBuy');
  });

  it('a non-positive amount refuses as an invalid size', async () => {
    await expect(desk(TEST_BOUNDS_JSON).convertQuote(principal, { ...input, qty: '0' })).rejects.toBeInstanceOf(OtcError);
  });
});
