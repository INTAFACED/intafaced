import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createW1ControlGuards } from '../seams/slots/w1-control.js';
import { MERCHANT_CONTROLS_BOOT_CODE, MerchantControlsModeError, parseMerchantControlsMode } from './mode.js';

const here = dirname(fileURLToPath(import.meta.url));
const sql = {} as Sql;

describe('PAY_MERCHANT_CONTROLS boot', () => {
  it('allows unset, blank and off only when APP_ENV is exactly dev or test, and required everywhere', () => {
    for (const APP_ENV of ['dev', 'test'] as const) {
      expect(parseMerchantControlsMode({ APP_ENV })).toBe('off');
      expect(parseMerchantControlsMode({ APP_ENV, PAY_MERCHANT_CONTROLS: '' })).toBe('off');
      expect(parseMerchantControlsMode({ APP_ENV, PAY_MERCHANT_CONTROLS: '   ' })).toBe('off');
      expect(parseMerchantControlsMode({ APP_ENV, PAY_MERCHANT_CONTROLS: 'off' })).toBe('off');
      expect(parseMerchantControlsMode({ APP_ENV, PAY_MERCHANT_CONTROLS: 'required' })).toBe('required');
    }
    expect(parseMerchantControlsMode({ APP_ENV: 'prod', PAY_MERCHANT_CONTROLS: 'required' })).toBe('required');
    expect(parseMerchantControlsMode({ APP_ENV: 'staging', PAY_MERCHANT_CONTROLS: 'required' })).toBe('required');
    expect(parseMerchantControlsMode({ PAY_MERCHANT_CONTROLS: 'required' })).toBe('required');
  });

  it('refuses unset and off outside an explicit dev or test APP_ENV', () => {
    for (const APP_ENV of [undefined, '', '  ', 'staging', 'prod', 'production', 'DEV', 'prodd', 'local'] as const) {
      const env = APP_ENV === undefined ? {} : { APP_ENV };
      expect(() => parseMerchantControlsMode(env)).toThrow(MerchantControlsModeError);
      expect(() => parseMerchantControlsMode({ ...env, PAY_MERCHANT_CONTROLS: '' })).toThrow(MerchantControlsModeError);
      expect(() => parseMerchantControlsMode({ ...env, PAY_MERCHANT_CONTROLS: 'off' })).toThrow(MerchantControlsModeError);
      try {
        parseMerchantControlsMode({ ...env, PAY_MERCHANT_CONTROLS: 'off' });
      } catch (error) {
        expect(error).toMatchObject({ code: MERCHANT_CONTROLS_BOOT_CODE, name: 'MerchantControlsModeError' });
      }
    }
  });

  it('refuses any other flag value in every APP_ENV and does not fall through to off', () => {
    for (const APP_ENV of ['dev', 'test', 'prod', undefined] as const) {
      const base = APP_ENV === undefined ? {} : { APP_ENV };
      for (const PAY_MERCHANT_CONTROLS of ['on', 'Required', 'true', 'OFF', ' off', 'required ']) {
        expect(() => parseMerchantControlsMode({ ...base, PAY_MERCHANT_CONTROLS })).toThrow(MerchantControlsModeError);
      }
    }
  });

  it('the guard slot uses the same boot rule, so prod cannot build a silent no-op', () => {
    const prevApp = process.env.APP_ENV;
    const prevFlag = process.env.PAY_MERCHANT_CONTROLS;
    try {
      process.env.APP_ENV = 'prod';
      delete process.env.PAY_MERCHANT_CONTROLS;
      expect(() => createW1ControlGuards({ sql })).toThrow(MerchantControlsModeError);
      process.env.PAY_MERCHANT_CONTROLS = 'off';
      expect(() => createW1ControlGuards({ sql })).toThrow(MerchantControlsModeError);
      process.env.PAY_MERCHANT_CONTROLS = 'required';
      expect(Object.keys(createW1ControlGuards({ sql }))).toContain('beforePayoutAdmit');
    } finally {
      if (prevApp === undefined) delete process.env.APP_ENV;
      else process.env.APP_ENV = prevApp;
      if (prevFlag === undefined) delete process.env.PAY_MERCHANT_CONTROLS;
      else process.env.PAY_MERCHANT_CONTROLS = prevFlag;
    }
  });

  it('env.ts does not default the flag to off and resolves it from the raw env', () => {
    const envTs = readFileSync(join(here, '..', 'env.ts'), 'utf8');
    expect(envTs).not.toMatch(/PAY_MERCHANT_CONTROLS:\s*z\.enum\(\['off', 'required'\]\)\.default\('off'\)/);
    expect(envTs).toMatch(/PAY_MERCHANT_CONTROLS:\s*z\.string\(\)\.optional\(\)/);
    expect(envTs).toContain('parseMerchantControlsMode(process.env)');
  });
});
