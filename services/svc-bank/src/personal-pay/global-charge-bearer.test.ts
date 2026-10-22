import { describe, expect, it } from 'vitest';
import { GlobalSendService, parseOurFees } from './global.js';
import { personalPayError, PersonalPayError } from './errors.js';
import { emptyGlobalPorts, type FxQuote, type GlobalPorts } from './ports.js';

/**
 * BK-xfer-03 (svc-bank, part one): the SHA/OUR charge bearer on `global.quote`, the owner OUR flat-fee table
 * (`BANK_GLOBAL_OUR_FEES_JSON`, blank refuses), and the bank-side firm-rate FX held as a typed refusal until
 * LG-fx-bank-grant-01. The quote path reads no database; the service gets null handles it never touches.
 */
const NOW = new Date('2026-10-22T10:00:00Z');
const quoted: FxQuote = {
  rate: '0.92',
  fee: '1.50',
  feeAsset: 'USDT',
  receiveAmount: '90.62',
  validUntil: '2026-10-22T10:05:00Z',
  eta: '2026-10-23T10:00:00Z',
};

function ports(answer: FxQuote = quoted): { ports: GlobalPorts; asked: () => number } {
  let n = 0;
  const base = emptyGlobalPorts();
  return {
    ports: {
      ...base,
      fx: {
        status: () => 'live',
        async quote() {
          n += 1;
          return answer;
        },
      },
    },
    asked: () => n,
  };
}
const svc = (p: GlobalPorts, ourFees?: string) =>
  new GlobalSendService(null as never, null as never, null as never, p, undefined, undefined, undefined, ourFees);
const OUR_EUR = JSON.stringify([{ currency: 'EUR', fee: '25.00', feeAsset: 'USDT' }]);
const q = { asset: 'usdt', amount: '100', toCurrency: 'eur', now: NOW };

describe('global.quote charge bearer (BK-xfer-03)', () => {
  it('TEST provider quote: rate/fee/valid-until come from the provider; no bearer keeps the old shape', async () => {
    const out = await svc(ports().ports).quote(q);
    expect(out).toEqual(quoted);
    expect(out).not.toHaveProperty('chargeBearer');
  });

  it('SHA returns the provider quote with chargeBearer SHA and no OUR fee', async () => {
    expect(await svc(ports().ports, OUR_EUR).quote({ ...q, chargeBearer: 'SHA' })).toEqual({ ...quoted, chargeBearer: 'SHA' });
  });

  it('OUR with a published fee adds the owner flat fee', async () => {
    expect(await svc(ports().ports, OUR_EUR).quote({ ...q, chargeBearer: 'OUR' })).toEqual({
      ...quoted,
      chargeBearer: 'OUR',
      ourFee: '25.00',
      ourFeeAsset: 'USDT',
    });
  });

  it('OUR with a blank table, or no row for the currency, refuses bank.our_fee_unset before the provider is asked', async () => {
    expect.assertions(6);
    for (const table of [undefined, '', OUR_EUR]) {
      const p = ports();
      const toCurrency = table === OUR_EUR ? 'GBP' : 'EUR';
      await expect(svc(p.ports, table).quote({ ...q, toCurrency, chargeBearer: 'OUR' })).rejects.toMatchObject({
        code: 'bank.our_fee_unset',
      });
      expect(p.asked()).toBe(0);
    }
  });

  it('an expired provider quote refuses bank.global_quote_expired', async () => {
    const p = ports({ ...quoted, validUntil: '2026-10-22T09:59:59Z' });
    await expect(svc(p.ports, OUR_EUR).quote({ ...q, chargeBearer: 'SHA' })).rejects.toMatchObject({ code: 'bank.global_quote_expired' });
  });

  it('no FX provider refuses bank.global_fx_unset (socket.psp-partners), even for OUR', async () => {
    await expect(svc(emptyGlobalPorts(), OUR_EUR).quote({ ...q, chargeBearer: 'OUR' })).rejects.toMatchObject({
      code: 'bank.global_fx_unset',
      blocker: 'socket.psp-partners',
    });
  });
});

describe('firm-rate FX is HELD (LG-fx-bank-grant-01)', () => {
  it('firmRateConvert always refuses bank.fx_firm_rate_held naming its blocker, and never asks for a rate', async () => {
    const p = ports();
    const err = await svc(p.ports, OUR_EUR)
      .firmRateConvert({ userId: 'u', fromAsset: 'USDT', toAsset: 'EUR', amount: '10' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PersonalPayError);
    expect(err).toMatchObject({ code: 'bank.fx_firm_rate_held', http: 'PRECONDITION_FAILED', blocker: 'LG-fx-bank-grant-01' });
    expect(p.asked()).toBe(0);
  });

  it('our_fee_unset is a precondition with the currency named, not the generic fallback', () => {
    const e = personalPayError('bank.our_fee_unset', 'GBP');
    expect(e.http).toBe('PRECONDITION_FAILED');
    expect(e.message).toContain('GBP');
  });
});

describe('parseOurFees (owner table)', () => {
  it('parses rows; anything malformed is unset (null), never a partial table', () => {
    expect(parseOurFees(OUR_EUR)?.get('EUR')).toEqual({ fee: '25.00', feeAsset: 'USDT' });
    for (const bad of [
      undefined,
      ' ',
      '{',
      '{}',
      JSON.stringify([{ currency: 'eur', fee: '1', feeAsset: 'USDT' }]),
      JSON.stringify([{ currency: 'EUR', fee: 1, feeAsset: 'USDT' }]),
      JSON.stringify([{ currency: 'EUR', fee: '-1', feeAsset: 'USDT' }]),
      JSON.stringify([
        { currency: 'EUR', fee: '1', feeAsset: 'USDT' },
        { currency: 'EUR', fee: '2', feeAsset: 'USDT' },
      ]),
    ])
      expect(parseOurFees(bad)).toBeNull();
  });
});
