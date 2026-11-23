import { describe, expect, it } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client';
import { LocalTestReferenceRefusedError, createLocalTestReferencePrices } from './local-test-reference.js';

const KEY = 'LOCAL_TEST_P2P_REFERENCE_PRICES';

describe('createLocalTestReferencePrices', () => {
  it('is no source when unset or blank, as in production', () => {
    expect(createLocalTestReferencePrices({ APP_ENV: 'test' })).toBeUndefined();
    expect(createLocalTestReferencePrices({ APP_ENV: 'test', [KEY]: ' ' })).toBeUndefined();
    expect(createLocalTestReferencePrices({ APP_ENV: 'production' })).toBeUndefined();
  });

  it('prices only the pairs it names, exactly', async () => {
    const source = createLocalTestReferencePrices({ APP_ENV: 'dev', [KEY]: '{"USDT/EUR":"0.92"}' });
    expect(await source?.price('USDT', 'EUR')).toBe(parseAmount('0.92'));
    expect(await source?.price('USDT', 'USD')).toBeNull();
    expect(await source?.price('BTC', 'EUR')).toBeNull();
  });

  it.each([
    [{ APP_ENV: 'production' }, 'APP_ENV must be exactly dev or test'],
    [{}, 'APP_ENV must be exactly dev or test'],
    [{ APP_ENV: 'test', NODE_ENV: 'production' }, 'NODE_ENV is production'],
  ])('refuses to start outside an explicit test stack (%o)', (env, reason) => {
    const make = () => createLocalTestReferencePrices({ ...env, [KEY]: '{"USDT/EUR":"0.92"}' });
    expect(make).toThrow(LocalTestReferenceRefusedError);
    expect(make).toThrow(reason);
  });

  it.each([
    ['not json', 'it is not JSON'],
    ['["USDT/EUR"]', 'it is not a map of pair to price'],
    ['{}', 'it names no pair'],
    ['{"usdt-eur":"0.92"}', 'is not COIN/FIAT'],
    ['{"USDT/EUR":0.92}', 'not a positive decimal string'],
    ['{"USDT/EUR":"0"}', 'not a positive decimal string'],
    ['{"USDT/EUR":"-1"}', 'not a positive decimal string'],
    ['{"USDT/EUR":"1e3"}', 'not a positive decimal string'],
  ])('refuses a malformed value %s, never falling back to no feed', (raw, reason) => {
    const make = () => createLocalTestReferencePrices({ APP_ENV: 'test', [KEY]: raw });
    expect(make).toThrow(LocalTestReferenceRefusedError);
    expect(make).toThrow(reason);
  });
});
