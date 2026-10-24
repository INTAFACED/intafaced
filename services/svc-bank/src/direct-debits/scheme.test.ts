import { describe, expect, it } from 'vitest';
import { DirectDebitSimRefusedError, directDebitSchemeFor, parseDirectDebitSim, unsetDirectDebitScheme } from './scheme.js';

const CATALOGUE = JSON.stringify({
  label: 'TEST direct debit stand-in',
  guaranteeDays: 30,
  creditors: [{ id: 'TEST-GYM', name: 'TEST Gym' }],
});
const DEV = { APP_ENV: 'dev' };

describe('the direct debit scheme setting', () => {
  it('is unset by default: no stand-in, no guarantee period, no creditor', () => {
    expect(directDebitSchemeFor('none', CATALOGUE, DEV)).toBe(unsetDirectDebitScheme);
    expect(unsetDirectDebitScheme).toMatchObject({ status: 'unset', standIn: null, guaranteeDays: null });
  });

  it('gives the stand-in in dev or test over a TEST catalogue', () => {
    const scheme = directDebitSchemeFor('dd-sim', CATALOGUE, { APP_ENV: 'test' });
    expect(scheme).toMatchObject({ status: 'live', standIn: 'TEST direct debit stand-in', railId: 'dd-sim', guaranteeDays: 30 });
    expect(scheme.creditor('TEST-GYM')).toEqual({ id: 'TEST-GYM', name: 'TEST Gym' });
    expect(scheme.creditor('NOBODY')).toBeNull();
  });

  it('refuses to start outside dev or test, or under NODE_ENV=production', () => {
    for (const env of [{}, { APP_ENV: 'production' }, { APP_ENV: 'staging' }, { APP_ENV: 'dev', NODE_ENV: 'production' }]) {
      expect(() => directDebitSchemeFor('dd-sim', CATALOGUE, env)).toThrow(DirectDebitSimRefusedError);
    }
  });

  it('refuses to start over a blank, unlabelled or out-of-shape catalogue', () => {
    for (const bad of [
      undefined,
      '',
      'not json',
      JSON.stringify({ label: 'Live scheme', guaranteeDays: 30, creditors: [{ id: 'A', name: 'TEST A' }] }),
      JSON.stringify({ label: 'TEST', guaranteeDays: 30, creditors: [{ id: 'A', name: 'A real company' }] }),
      JSON.stringify({ label: 'TEST', guaranteeDays: 30, creditors: [] }),
      JSON.stringify({
        label: 'TEST',
        guaranteeDays: 30,
        creditors: [
          { id: 'A', name: 'TEST A' },
          { id: 'A', name: 'TEST B' },
        ],
      }),
      JSON.stringify({ label: 'TEST', guaranteeDays: 30, creditors: [{ id: 'A', name: 'TEST A' }], failureFees: [] }),
    ]) {
      expect(parseDirectDebitSim(bad)).toBeNull();
      expect(() => directDebitSchemeFor('dd-sim', bad, DEV)).toThrow(DirectDebitSimRefusedError);
    }
  });

  it('keeps a null guarantee period as not set', () => {
    const parsed = parseDirectDebitSim(JSON.stringify({ label: 'TEST', guaranteeDays: null, creditors: [{ id: 'A', name: 'TEST A' }] }));
    expect(parsed?.guaranteeDays).toBeNull();
  });
});
