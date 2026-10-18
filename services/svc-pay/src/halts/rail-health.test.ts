import { describe, expect, it } from 'vitest';
import { loadHaltAutoTripConfig } from './config.js';
import { isRailHealthFailureCode } from './rail-health.js';

describe('rail-health failure codes', () => {
  it('counts rail outages, timeouts, server errors and auth failures', () => {
    for (const code of [
      'rail.down',
      'rail.health_stale',
      'rail.probe_failed',
      'rail.marked_down',
      'rail.unavailable',
      'rail.timeout',
      'rail.auth_failed',
      'acquirer.unavailable',
      'gateway.timeout',
      'ETIMEDOUT',
      'http.500',
      'http.503',
      '500',
      'upstream.5xx',
      'rail.auth_denied',
    ]) {
      expect(isRailHealthFailureCode(code), code).toBe(true);
    }
  });

  it('does not count destination or customer results', () => {
    for (const code of [
      'card.declined',
      'card.expired',
      'invalid_address',
      'destination.invalid_address',
      'destination.insufficient',
      'insufficient_funds',
      'bank.rejected',
      'chain.underpaid',
      'chain.wrong_asset',
      'chain.insufficient_confirmations',
      'chain.broadcast_failed',
      'rail.failed',
      'destination.unavailable',
      '',
      null,
      undefined,
    ]) {
      expect(isRailHealthFailureCode(code), String(code)).toBe(false);
    }
  });
});

describe('auto-trip config', () => {
  it('leaves both counts unset when the env is blank or not a positive integer', () => {
    expect(loadHaltAutoTripConfig({}).railFailures).toBeNull();
    for (const bad of ['', '0', '-3', 'three', '2.5']) {
      const loaded = loadHaltAutoTripConfig({
        PAY_HALT_AUTOTRIP_FAILURES: bad,
        PAY_HALT_AUTOTRIP_RAIL_FAILURES: bad,
      });
      expect(loaded.failures).toBeNull();
      expect(loaded.railFailures).toBeNull();
    }
    expect(loadHaltAutoTripConfig({ PAY_HALT_AUTOTRIP_FAILURES: '4', PAY_HALT_AUTOTRIP_RAIL_FAILURES: '2' })).toEqual({
      failures: 4,
      railFailures: 2,
    });
  });
});
