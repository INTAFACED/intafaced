import type { Sql } from 'postgres';
import { describe, expect, it } from 'vitest';
import { createW10B2bRampGuards } from '../seams/slots/w10-b2b-ramp.js';
import { B2bRampBootError } from './errors.js';
import { loadB2bRampConfig } from './config.js';
import { parseAsset, parsePositiveAmount, sameAmount } from './money.js';
import { payEnv } from '../env.testkit.js';

const sql = {} as Sql;
const attestation = 'operator-attestation-present';

describe('pay.b2b_ramp flag', () => {
  it('defaults to off, and off boots in prod without an attestation', () => {
    expect(loadB2bRampConfig({}).mode).toBe('off');
    expect(loadB2bRampConfig({ APP_ENV: 'prod' }).mode).toBe('off');
    expect(loadB2bRampConfig({ APP_ENV: 'staging', PAY_B2B_RAMP: 'off' }).licenceAttestation).toBe('absent');
    expect(createW10B2bRampGuards({ sql, env: { APP_ENV: 'prod' } })).toEqual({});
  });

  it('accepts only off or on, and any other value fails boot', () => {
    for (const bad of ['required', 'ON', 'true', '1']) {
      expect(() => loadB2bRampConfig({ PAY_B2B_RAMP: bad, APP_ENV: 'dev' })).toThrow(B2bRampBootError);
      expect(() => createW10B2bRampGuards({ sql, env: { PAY_B2B_RAMP: bad, APP_ENV: 'dev' } })).toThrow(B2bRampBootError);
    }
  });

  it('fails boot in staging, prod, and an unset APP_ENV when enabled without a licence attestation', () => {
    for (const APP_ENV of ['staging', 'prod', 'production', undefined, '', '  ', 'DEV'] as const) {
      const env = APP_ENV === undefined ? { PAY_B2B_RAMP: 'on' } : { PAY_B2B_RAMP: 'on', APP_ENV };
      expect(() => loadB2bRampConfig(env)).toThrow(/PAY_B2B_RAMP_LICENCE_ATTESTATION is unset/);
      expect(() => createW10B2bRampGuards({ sql, env })).toThrow(B2bRampBootError);
    }
  });

  it('treats a blank attestation as absent', () => {
    expect(() => loadB2bRampConfig({ PAY_B2B_RAMP: 'on', APP_ENV: 'prod', PAY_B2B_RAMP_LICENCE_ATTESTATION: '   ' })).toThrow(
      B2bRampBootError,
    );
  });

  it('boots in prod when the operator supplied an attestation, and does not echo it', () => {
    const config = loadB2bRampConfig({
      PAY_B2B_RAMP: 'on',
      APP_ENV: 'prod',
      PAY_B2B_RAMP_LICENCE_ATTESTATION: attestation,
    });
    expect(config).toMatchObject({ flag: 'pay.b2b_ramp', mode: 'on', licenceAttestation: 'present', reconciliationSocket: 'wired' });
    expect(JSON.stringify(config)).not.toContain(attestation);
    expect(
      createW10B2bRampGuards({ sql, env: { PAY_B2B_RAMP: 'on', APP_ENV: 'staging', PAY_B2B_RAMP_LICENCE_ATTESTATION: attestation } }),
    ).toEqual({});
  });

  it('allows dev and test to enable without an attestation so the socket can be tested', () => {
    for (const APP_ENV of ['dev', 'test'] as const) {
      const config = loadB2bRampConfig({ PAY_B2B_RAMP: 'on', APP_ENV });
      expect(config.mode).toBe('on');
      expect(config.licenceAttestation).toBe('absent');
    }
  });

  it('does not install payment hooks: the ramp is not on the intake path', () => {
    expect(Object.keys(createW10B2bRampGuards({ sql, env: { PAY_B2B_RAMP: 'on', APP_ENV: 'test' } }))).toEqual([]);
  });

  it('the service settings default the flag off and do not default an attestation', () => {
    const unset = payEnv({ PAY_B2B_RAMP: undefined, PAY_B2B_RAMP_LICENCE_ATTESTATION: undefined });
    expect(unset.PAY_B2B_RAMP).toBe('off');
    expect(unset.PAY_B2B_RAMP_LICENCE_ATTESTATION).toBeUndefined();
    expect(payEnv({ PAY_B2B_RAMP: 'on' }).PAY_B2B_RAMP).toBe('on');
    expect(() => payEnv({ PAY_B2B_RAMP: 'yes' })).toThrow(/PAY_B2B_RAMP/);
    expect(payEnv({ PAY_B2B_RAMP_LICENCE_ATTESTATION: 'TEST-attestation' }).PAY_B2B_RAMP_LICENCE_ATTESTATION).toBe('TEST-attestation');
  });
});

describe('ramp amounts', () => {
  it('compares scaled amounts and rejects zero, negative, and non-decimal strings', () => {
    expect(sameAmount('10.10', '10.100')).toBe(true);
    expect(sameAmount('10.10', '10.11')).toBe(false);
    expect(parsePositiveAmount('10.10').canonical).toBe('10.1');
    for (const bad of ['0', '0.0', '-1', '1e2', '1.2.3', '']) {
      expect(() => parsePositiveAmount(bad)).toThrow(/pay\.b2b_ramp_amount_rejected/);
    }
    expect(() => parsePositiveAmount(1 as unknown as string)).toThrow(/pay\.b2b_ramp_amount_rejected/);
  });

  it('trims an asset and rejects a blank one, without inventing a currency list', () => {
    expect(parseAsset(' USD ')).toBe('USD');
    expect(parseAsset('USDT')).toBe('USDT');
    expect(() => parseAsset('')).toThrow(/pay\.b2b_ramp_asset_rejected/);
    expect(() => parseAsset('US D')).toThrow(/pay\.b2b_ramp_asset_rejected/);
  });
});
