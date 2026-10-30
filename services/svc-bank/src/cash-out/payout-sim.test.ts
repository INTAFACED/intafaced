import { describe, expect, it } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client';
import { PAYOUT_SIM_RAIL, PayoutSimRefusedError, cashOutPartnerFor, parsePayoutSim, payoutSim } from './payout-sim.js';

const LINE = { asset: 'USDT', currency: 'EUR', rate: '0.9', fee: '1.5' };
const CATALOGUE = JSON.stringify({ label: 'TEST payout stand-in', payouts: [LINE] });

describe('the cash-out payout stand-in', () => {
  it('is off by default', () => {
    expect(cashOutPartnerFor('none', CATALOGUE, { APP_ENV: 'dev' })).toBeNull();
  });

  it('prices only its listed assets: the amount at its TEST rate rounded down, less its fee; a payout the fee eats is not priced', async () => {
    const sim = payoutSim(parsePayoutSim(CATALOGUE)!);
    expect(sim.rail).toBe(PAYOUT_SIM_RAIL);
    expect(sim.price('USDT', parseAmount('20'))).toEqual({ fee: '1.5', receiveAmount: '16.5', receiveCurrency: 'EUR' });
    expect(sim.price('USDT', parseAmount('0.000000000000000003'))).toBeNull();
    expect(sim.price('USDT', parseAmount('1'))).toBeNull();
    expect(sim.price('BTC', parseAmount('1'))).toBeNull();
    // The cash-out id is its idempotency key: the same id is the same TEST reference.
    expect(await sim.pay({ cashOutId: 'c1', assetId: 'USDT', amount: '20' })).toEqual({ payoutRef: 'TEST-PAYOUT-c1' });
  });

  it('refuses to start outside dev or test, or under NODE_ENV=production', () => {
    for (const env of [{}, { APP_ENV: 'production' }, { APP_ENV: 'dev', NODE_ENV: 'production' }]) {
      expect(() => cashOutPartnerFor('payout-sim', CATALOGUE, env)).toThrow(PayoutSimRefusedError);
    }
    expect(cashOutPartnerFor('payout-sim', CATALOGUE, { APP_ENV: 'test' })?.label).toBe('TEST payout stand-in');
  });

  it('keeps its own TEST records only in an explicit dev or test process, at an absolute path; unset, it keeps none', () => {
    expect(cashOutPartnerFor('payout-sim', CATALOGUE, { APP_ENV: 'test' })?.records).toBeUndefined();
    expect(cashOutPartnerFor('payout-sim', CATALOGUE, { APP_ENV: 'test' }, '/var/lib/stack/test-rail-records')?.records).toBeDefined();
    // Refused whatever the setting: a records folder outside dev or test, under NODE_ENV=production, or not absolute.
    for (const [setting, env, dir] of [
      ['none', {}, '/var/lib/stack/test-rail-records'],
      ['payout-sim', { APP_ENV: 'production' }, '/var/lib/stack/test-rail-records'],
      ['none', { APP_ENV: 'dev', NODE_ENV: 'production' }, '/var/lib/stack/test-rail-records'],
      ['payout-sim', { APP_ENV: 'dev' }, 'test-rail-records'],
    ] as const) {
      expect(() => cashOutPartnerFor(setting, CATALOGUE, env, dir)).toThrow(
        expect.objectContaining({ code: 'bank.payout_sim_records_outside_dev_test' }),
      );
    }
  });

  it('refuses to start over a blank, unlabelled, zero-rate, oversized, duplicated or out-of-shape catalogue', () => {
    for (const bad of [
      undefined,
      ' ',
      '{',
      JSON.stringify({ label: 'Live payouts', payouts: [LINE] }),
      JSON.stringify({ label: 'TEST', payouts: [{ ...LINE, rate: '0' }] }),
      JSON.stringify({ label: 'TEST', payouts: [{ ...LINE, fee: `1${'0'.repeat(30)}` }] }),
      JSON.stringify({ label: 'TEST', payouts: [LINE, LINE] }),
      JSON.stringify({ label: 'TEST', payouts: [] }),
      JSON.stringify({ label: 'TEST', payouts: [{ ...LINE, iban: 'GB82WEST12345698765432' }] }),
    ]) {
      expect(parsePayoutSim(bad)).toBeNull();
      expect(() => cashOutPartnerFor('payout-sim', bad, { APP_ENV: 'dev' })).toThrow(PayoutSimRefusedError);
    }
  });
});
