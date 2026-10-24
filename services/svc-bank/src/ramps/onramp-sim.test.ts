import { describe, expect, it } from 'vitest';
import { OnrampSimRefusedError, onrampSim, onrampStandInFor, parseOnrampSim } from './onramp-sim.js';

const LINE = { country: 'NL', method: 'bank_transfer', asset: 'USDT', payCurrency: 'EUR', rate: '2', fee: '1', deliveryEstimate: null };
const CATALOGUE = JSON.stringify({ label: 'TEST add-money stand-in', quoteValidSeconds: 20, quotes: [LINE] });

describe('the add-money rate stand-in', () => {
  it('is off by default', () => {
    expect(onrampStandInFor('none', CATALOGUE, { APP_ENV: 'dev' })).toBeNull();
  });

  it('quotes the amount at its TEST rate rounded up plus its fee, valid for its seconds, for its listed asks only', async () => {
    const at = new Date('2026-11-02T09:00:00.000Z');
    const sim = onrampSim(parseOnrampSim(CATALOGUE)!, () => at);
    expect(sim.covers({ assetId: 'USDT', method: 'bank_transfer', country: 'NL' })).toBe(true);
    expect(sim.covers({ assetId: 'USDT', method: 'card', country: 'NL' })).toBe(false);
    expect(sim.covers({ assetId: 'USDT', method: 'bank_transfer', country: 'DE' })).toBe(false);
    expect(
      await sim.quotes.quote({ assetId: 'USDT', amount: '0.000000000000000001', method: 'bank_transfer', country: 'NL' }),
    ).toMatchObject({
      payAmount: '1.000000000000000002',
    });
    expect(await sim.quotes.quote({ assetId: 'USDT', amount: '20', method: 'bank_transfer', country: 'NL' })).toEqual({
      payAmount: '41',
      fee: '1',
      rate: '2',
      payCurrency: 'EUR',
      expiresAt: new Date(at.getTime() + 20_000),
      deliveryEstimate: null,
    });
    expect(await sim.quotes.quote({ assetId: 'BTC', amount: '1', method: 'bank_transfer', country: 'NL' })).toBeNull();
  });

  it('refuses to start outside dev or test, or under NODE_ENV=production', () => {
    for (const env of [{}, { APP_ENV: 'production' }, { APP_ENV: 'dev', NODE_ENV: 'production' }]) {
      expect(() => onrampStandInFor('ramp-sim', CATALOGUE, env)).toThrow(OnrampSimRefusedError);
    }
    expect(onrampStandInFor('ramp-sim', CATALOGUE, { APP_ENV: 'test' })?.label).toBe('TEST add-money stand-in');
  });

  it('refuses to start over a blank, unlabelled, zero-rate, oversized, duplicated or out-of-shape catalogue', () => {
    for (const bad of [
      undefined,
      ' ',
      '{',
      JSON.stringify({ label: 'Live rates', quoteValidSeconds: 20, quotes: [LINE] }),
      JSON.stringify({ label: 'TEST', quoteValidSeconds: 20, quotes: [{ ...LINE, rate: '0' }] }),
      JSON.stringify({ label: 'TEST', quoteValidSeconds: 20, quotes: [{ ...LINE, fee: `1${'0'.repeat(30)}` }] }),
      JSON.stringify({ label: 'TEST', quoteValidSeconds: 20, quotes: [{ ...LINE, rate: `1${'0'.repeat(30)}` }] }),
      JSON.stringify({ label: 'TEST', quoteValidSeconds: 20, quotes: [LINE, LINE] }),
      JSON.stringify({ label: 'TEST', quoteValidSeconds: 0, quotes: [LINE] }),
      JSON.stringify({ label: 'TEST', quoteValidSeconds: 20, quotes: [] }),
      JSON.stringify({ label: 'TEST', quoteValidSeconds: 20, quotes: [{ ...LINE, method: 'cheque' }] }),
    ]) {
      expect(parseOnrampSim(bad)).toBeNull();
      expect(() => onrampStandInFor('ramp-sim', bad, { APP_ENV: 'dev' })).toThrow(OnrampSimRefusedError);
    }
  });
});
