import { describe, expect, it } from 'vitest';
import type { BankError } from '../errors.js';
import { testPartner } from '../partner/test-partner.js';
import { onrampSim, parseOnrampSim } from './onramp-sim.js';
import { createOnramp, onrampQuoteOf, quoteOnramp, type CustomerRampDeps } from './customer-ramps.js';

/**
 * The TEST ramp's switches (CUSTODY-DELTA §4): the partner's quote expired, and the partner's fee not known. Each runs at
 * the quote functions the add-money and buy-to-wallet doors call, with a store that records every write.
 */
const ADA = '11111111-1111-4111-8111-111111111111';
const QUOTE = '44444444-4444-4444-8444-444444444444';
const ONRAMP = '55555555-5555-4555-8555-555555555555';

const catalogue = parseOnrampSim(
  JSON.stringify({
    label: 'TEST rates',
    quoteValidSeconds: 600,
    quotes: [{ country: 'NL', method: 'bank_transfer', asset: 'USDT', payCurrency: 'EUR', rate: '2', fee: '1', deliveryEstimate: null }],
  }),
)!;

function deps(partner: ReturnType<typeof testPartner>, stored: Record<string, unknown> | null) {
  const writes: string[] = [];
  const sql = (async (parts: TemplateStringsArray) => {
    const text = parts.join('?');
    if (/INSERT/i.test(text)) {
      writes.push(text);
      return [row()];
    }
    if (/FROM bank\.ramp_onramp_quotes/.test(text)) return stored ? [stored] : [];
    return [];
  }) as unknown as CustomerRampDeps['sql'];
  return {
    writes,
    deps: {
      sql,
      standIn: onrampSim(catalogue),
      testRamp: partner,
      programme: {} as never,
      payFiat: {} as never,
      quotes: null,
      payments: null,
    } as unknown as CustomerRampDeps,
  };
}

const codeOf = async (call: Promise<unknown>) => {
  try {
    await call;
  } catch (err) {
    return (err as BankError).code;
  }
  return null;
};

const row = () => ({
  id: QUOTE,
  user_id: ADA,
  asset_id: 'USDT',
  amount: '20',
  method: 'bank_transfer',
  country: 'NL',
  pay_amount: '41',
  fee: '1',
  rate: '2',
  pay_currency: 'EUR',
  expires_at: new Date(Date.now() + 600_000),
  simulated: true,
  delivery_estimate: null,
  created_at: new Date(),
});

describe('TEST ramp: fee not known', () => {
  it('refuses the quote bank.onramp_fee_not_known and keeps nothing; off, the same ask is quoted', async () => {
    const partner = testPartner();
    partner.set(ADA, { rampFee: 'unknown' });
    const off = deps(partner, null);
    const ask = { userId: ADA, assetId: 'USDT', amount: '20', method: 'bank_transfer' as const, country: 'NL' };
    expect(await codeOf(quoteOnramp(off.deps, ask))).toBe('bank.onramp_fee_not_known');
    expect(off.writes).toEqual([]);

    partner.set(ADA, { rampFee: 'known' });
    const on = deps(partner, null);
    expect(await quoteOnramp(on.deps, ask)).toMatchObject({ fee: '1', payAmount: '41', payCurrency: 'EUR' });
    expect(on.writes).toHaveLength(1);
  });
});

describe('TEST ramp: quote expired', () => {
  it('a live quote reads as run out, and accepting it refuses bank.onramp_quote_expired with nothing opened', async () => {
    const partner = testPartner();
    const live = deps(partner, row());
    expect(Date.parse((await onrampQuoteOf(live.deps, ADA, QUOTE)).expiresAt)).toBeGreaterThan(Date.now());

    partner.set(ADA, { rampQuote: 'expired' });
    const ran = deps(partner, row());
    expect(Date.parse((await onrampQuoteOf(ran.deps, ADA, QUOTE)).expiresAt)).toBeLessThanOrEqual(Date.now());
    expect(await codeOf(createOnramp(ran.deps, { userId: ADA, onrampId: ONRAMP, quoteId: QUOTE, method: 'bank_transfer' }))).toBe(
      'bank.onramp_quote_expired',
    );
    expect(ran.writes).toEqual([]);
  });
});
