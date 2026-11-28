import type { Sql } from 'postgres';
import { fakeSql } from '@intafaced/service-kit/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { buildPayGuards } from '../seams/registry.js';
import { MerchantControlsBootError, MerchantControlsModeError, resolveMerchantControlsMode } from './mode.js';
import { payEnv } from '../env.testkit.js';

describe('PAY_MERCHANT_CONTROLS is never silently off', () => {
  it('unset or blank outside an explicit dev or test run refuses boot with a typed error', () => {
    for (const appEnv of [undefined, '', ' ', 'production', 'prod', 'staging', 'DEV', 'Test', 'development', 'local']) {
      for (const raw of [undefined, null, '', '   ']) {
        expect(() => resolveMerchantControlsMode(raw, appEnv)).toThrow(MerchantControlsBootError);
        expect(() => resolveMerchantControlsMode(raw, appEnv)).toThrow(expect.objectContaining({ code: 'pay.merchant_controls_unset' }));
      }
    }
  });

  it('off outside an explicit dev or test run refuses boot with a typed error', () => {
    for (const appEnv of [undefined, '', 'production', 'staging', 'DEV']) {
      expect(() => resolveMerchantControlsMode('off', appEnv)).toThrow(
        expect.objectContaining({ code: 'pay.merchant_controls_off_refused' }),
      );
    }
  });

  it('required boots in every environment', () => {
    for (const appEnv of [undefined, 'production', 'staging', 'dev', 'test']) {
      expect(resolveMerchantControlsMode('required', appEnv)).toBe('required');
    }
  });

  it('dev and test may leave it unset (off) or set it to off', () => {
    for (const appEnv of ['dev', 'test']) {
      expect(resolveMerchantControlsMode(undefined, appEnv)).toBe('off');
      expect(resolveMerchantControlsMode('', appEnv)).toBe('off');
      expect(resolveMerchantControlsMode('off', appEnv)).toBe('off');
    }
  });

  it('any other value fails boot in every environment, including dev', () => {
    for (const appEnv of [undefined, 'production', 'dev']) {
      for (const bad of ['on', 'Required', 'true', 'OFF', ' off', 'requird']) {
        expect(() => resolveMerchantControlsMode(bad, appEnv)).toThrow(MerchantControlsModeError);
      }
    }
  });

  describe('the guard registry', () => {
    const saved = { controls: process.env.PAY_MERCHANT_CONTROLS, appEnv: process.env.APP_ENV };
    afterEach(() => {
      for (const [key, value] of [
        ['PAY_MERCHANT_CONTROLS', saved.controls],
        ['APP_ENV', saved.appEnv],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
    const sql = fakeSql<Sql>();

    it('does not fall back to off when the process env leaves it unset in a prod-like env', () => {
      delete process.env.PAY_MERCHANT_CONTROLS;
      delete process.env.APP_ENV;
      expect(() => buildPayGuards({ sql })).toThrow(MerchantControlsBootError);
      process.env.APP_ENV = 'production';
      process.env.PAY_MERCHANT_CONTROLS = 'off';
      expect(() => buildPayGuards({ sql })).toThrow(MerchantControlsBootError);
    });

    it('enforces when required, and is off only for an explicit dev or test run', () => {
      process.env.APP_ENV = 'production';
      process.env.PAY_MERCHANT_CONTROLS = 'required';
      expect(() => buildPayGuards({ sql })).not.toThrow();
      process.env.APP_ENV = 'test';
      delete process.env.PAY_MERCHANT_CONTROLS;
      expect(() => buildPayGuards({ sql })).not.toThrow();
    });
  });

  it('the boot settings carry no off default, and guards built from them refuse an unset mode outside dev or test', () => {
    // What the boot reads: unset stays unset (no default), blank stays blank, a value passes through for the resolver.
    expect(payEnv({ PAY_MERCHANT_CONTROLS: undefined }).PAY_MERCHANT_CONTROLS).toBeUndefined();
    expect(payEnv({ PAY_MERCHANT_CONTROLS: '' }).PAY_MERCHANT_CONTROLS).toBe('');
    expect(payEnv({ PAY_MERCHANT_CONTROLS: 'required' }).PAY_MERCHANT_CONTROLS).toBe('required');
    // The guard registry the boot builds resolves the mode itself, so an unset one cannot reach the guards as off.
    const saved = { controls: process.env.PAY_MERCHANT_CONTROLS, appEnv: process.env.APP_ENV };
    try {
      process.env.APP_ENV = 'staging';
      delete process.env.PAY_MERCHANT_CONTROLS;
      expect(() => buildPayGuards({ sql: fakeSql<Sql>() })).toThrow(expect.objectContaining({ code: 'pay.merchant_controls_unset' }));
    } finally {
      if (saved.controls === undefined) delete process.env.PAY_MERCHANT_CONTROLS;
      else process.env.PAY_MERCHANT_CONTROLS = saved.controls;
      if (saved.appEnv === undefined) delete process.env.APP_ENV;
      else process.env.APP_ENV = saved.appEnv;
    }
  });
});
