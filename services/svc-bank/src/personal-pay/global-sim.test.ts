import { describe, expect, it } from 'vitest';
import { GLOBAL_SIM_RAIL, globalPortsFor, globalSimPorts, parseGlobalSim, type GlobalSimCatalogue } from './global-sim.js';

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
  });

  it('is never chosen by default, under live posture, or over a blank catalogue', () => {
    expect(globalPortsFor('none', json(), { live: false }).corridors.status()).toBe('unset');
    expect(globalPortsFor('global-sim', json(), { live: true }).corridors.status()).toBe('unset');
    expect(globalPortsFor('global-sim', json(), { NODE_ENV: 'production' }).payout.status()).toBe('unset');
    expect(globalPortsFor('global-sim', json(), { NODE_ENV: 'test', APP_ENV: 'prod' }).fx.status()).toBe('unset');
    expect(globalPortsFor('global-sim', undefined, { live: false }).fx.status()).toBe('unset');
    expect(globalPortsFor('global-sim', json(), { live: false }).corridors.status()).toBe('live');
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
  });

  it('pays nobody: the payout is acknowledged with a TEST reference keyed by the send, on its own rail boundary', async () => {
    const ports = globalSimPorts(catalogue);
    expect(ports.payout.railId()).toBe(GLOBAL_SIM_RAIL);
    const input = { sendId: 's-1', idempotencyKey: 'k-12345678', amount: '1', assetId: 'USDT', toCurrency: 'EUR', recipientId: 'r-1' };
    expect(await ports.payout.submit(input)).toEqual({ ok: true, providerRef: 'TEST-s-1', status: 'sent' });
    expect(await ports.payout.submit(input)).toEqual({ ok: true, providerRef: 'TEST-s-1', status: 'sent' });
  });
});
