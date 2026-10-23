import { describe, expect, it } from 'vitest';
import {
  GLOBAL_SIM_RAIL,
  GlobalSimRefusedError,
  globalPortsFor,
  globalSimPorts,
  parseGlobalSim,
  type GlobalSimCatalogue,
} from './global-sim.js';

const catalogue: GlobalSimCatalogue = {
  label: 'TEST stand-in',
  corridors: [{ country: 'DE', currency: 'EUR', deliveryMethods: ['sepa'], minAmount: '1', maxAmount: '1000', cutOffTime: null }],
  rates: [{ asset: 'USDT', toCurrency: 'EUR', rate: '2' }],
  quoteValidSeconds: 300,
  etaHours: 24,
  banks: [{ bic: 'TESTDEFF', bankName: 'TEST Bank' }],
  travelRule: { decidedBy: 'TEST local stack', requiredFields: [] },
};
const json = (over: Record<string, unknown> = {}) => JSON.stringify({ ...catalogue, ...over });

describe('the global-send stand-in (TEST only)', () => {
  it('reads only a catalogue labelled TEST, in shape, with rates and bounds above zero', () => {
    expect(parseGlobalSim(json())).toEqual(catalogue);
    expect(parseGlobalSim(undefined)).toBeNull();
    expect(parseGlobalSim('  ')).toBeNull();
    expect(parseGlobalSim('{not json')).toBeNull();
    expect(parseGlobalSim(json({ label: 'Partner catalogue' }))).toBeNull();
    expect(parseGlobalSim(json({ travelRule: { decidedBy: 'Compliance', requiredFields: [] } }))).toBeNull();
    expect(parseGlobalSim(json({ rates: [{ asset: 'USDT', toCurrency: 'EUR', rate: '0' }] }))).toBeNull();
    expect(parseGlobalSim(json({ corridors: [{ ...catalogue.corridors[0], maxAmount: '0' }] }))).toBeNull();
    expect(parseGlobalSim(json({ corridors: [] }))).toBeNull();
    expect(parseGlobalSim(json({ extra: true }))).toBeNull();
    expect(parseGlobalSim(json({ reviewFrom: [{ asset: 'USDT', amount: '0' }] }))).toBeNull();
    expect(parseGlobalSim(json({ reviewFrom: [{ asset: 'USDT' }] }))).toBeNull();
    expect(parseGlobalSim(json({ reviewFrom: '500' }))).toBeNull();
    // Absent is a catalogue that screens nothing, so one written before screening existed still reads.
    expect(parseGlobalSim(json({}))).not.toBeNull();
  });

  it('is never chosen by default, and refuses to start outside an explicit dev or test process or over a blank catalogue', () => {
    const dev = { APP_ENV: 'dev' };
    expect(globalPortsFor('none', json(), dev).corridors.status()).toBe('unset');
    expect(globalPortsFor('none', json(), {}).standIn).toBeUndefined();
    const refused = (env: { APP_ENV?: string; NODE_ENV?: string }, catalogueJson: string | undefined = json()) => {
      try {
        globalPortsFor('global-sim', catalogueJson, env);
      } catch (err) {
        return err instanceof GlobalSimRefusedError ? err.code : 'other';
      }
      return 'started';
    };
    // The raw APP_ENV: unset (which the schema would default to dev), a typo, staging or prod all refuse.
    expect(refused({})).toBe('bank.global_sim_outside_dev_test');
    expect(refused({ APP_ENV: 'DEV' })).toBe('bank.global_sim_outside_dev_test');
    expect(refused({ APP_ENV: 'staging' })).toBe('bank.global_sim_outside_dev_test');
    expect(refused({ APP_ENV: 'prod' })).toBe('bank.global_sim_outside_dev_test');
    expect(refused({ APP_ENV: 'dev', NODE_ENV: 'production' })).toBe('bank.global_sim_outside_dev_test');
    expect(refused(dev, '')).toBe('bank.global_sim_catalogue_unreadable');
    expect(refused(dev, json({ label: 'Partner catalogue' }))).toBe('bank.global_sim_catalogue_unreadable');
    expect(refused({ APP_ENV: 'test' })).toBe('started');
    expect(globalPortsFor('global-sim', json(), dev).standIn).toEqual({ label: 'TEST stand-in' });
  });

  it('answers only from the catalogue: corridors, banks, the travel-rule fields and the rate', async () => {
    const now = new Date('2026-10-23T12:00:00.000Z');
    const ports = globalSimPorts(catalogue, () => now);
    expect(await ports.corridors.list()).toEqual(catalogue.corridors);
    expect(await ports.bic.lookup('testdeff')).toEqual({ bic: 'TESTDEFF', bankName: 'TEST Bank' });
    expect(await ports.bic.lookup('NOPEDEFF')).toBeNull();
    expect(ports.travelRule.decision()).toEqual({ decidedBy: 'TEST local stack', requiredFields: [] });
    // The receive amount is the amount times the typed rate, exactly; no fee, since a global send posts the amount alone.
    expect(await ports.fx.quote({ asset: 'USDT', amount: '40.5', toCurrency: 'EUR' })).toEqual({
      rate: '2',
      fee: '0',
      feeAsset: 'USDT',
      receiveAmount: '81',
      validUntil: '2026-10-23T12:05:00.000Z',
      eta: '2026-10-24T12:00:00.000Z',
    });
    await expect(ports.fx.quote({ asset: 'USDT', amount: '1', toCurrency: 'GBP' })).rejects.toThrow('no TEST rate');
    // Rounded down to the ledger's 18 places, never up; a receive amount the ledger cannot hold is an unusable answer.
    const third = globalSimPorts({ ...catalogue, rates: [{ asset: 'USDT', toCurrency: 'EUR', rate: '0.333333333333333333' }] });
    expect((await third.fx.quote({ asset: 'USDT', amount: '0.5', toCurrency: 'EUR' })).receiveAmount).toBe('0.166666666666666666');
    const huge = globalSimPorts({ ...catalogue, rates: [{ asset: 'USDT', toCurrency: 'EUR', rate: '99999999999999999999' }] });
    await expect(huge.fx.quote({ asset: 'USDT', amount: '99999999999999999999', toCurrency: 'EUR' })).rejects.toThrow();
  });

  it('screens a send at or over its TEST amount for that asset; another asset, or no list, is not screened', () => {
    expect(globalSimPorts(catalogue).review).toBeUndefined();
    expect(globalSimPorts({ ...catalogue, reviewFrom: [] }).review).toBeUndefined();
    const review = globalSimPorts({ ...catalogue, reviewFrom: [{ asset: 'USDT', amount: '500' }] }).review!;
    expect(review.waits({ assetId: 'USDT', amount: '499.999999999999999999' })).toBe(false);
    expect(review.waits({ assetId: 'USDT', amount: '500' })).toBe(true);
    expect(review.waits({ assetId: 'BTC', amount: '500' })).toBe(false);
  });

  it('pays nobody: the payout is acknowledged with a TEST reference keyed by the send, on its own rail boundary', async () => {
    const ports = globalSimPorts(catalogue);
    expect(ports.payout.railId()).toBe(GLOBAL_SIM_RAIL);
    const input = { sendId: 's-1', idempotencyKey: 'k-12345678', amount: '1', assetId: 'USDT', toCurrency: 'EUR', recipientId: 'r-1' };
    expect(await ports.payout.submit(input)).toEqual({ ok: true, providerRef: 'TEST-s-1', status: 'sent' });
    expect(await ports.payout.submit(input)).toEqual({ ok: true, providerRef: 'TEST-s-1', status: 'sent' });
  });
});
