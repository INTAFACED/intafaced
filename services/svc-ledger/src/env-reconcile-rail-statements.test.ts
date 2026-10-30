/**
 * LEDGER_RECONCILE_RAIL_<RAIL>_URL (OPS-reconciliation-04 per-rail controls): owner values with no default. A blank one
 * leaves that rail's outside side unset; a bad name or a URL that is not https (http only for a loopback host) refuses boot.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const SECRET = 's'.repeat(32);
const BASE_ENV = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  DATABASE_POOL_MAX: '10',
  INTERNAL_SERVICE_SECRET: SECRET,
  JWT_ACCESS_SECRET: SECRET,
  RECONCILE_CRON_MINUTES: '60',
};

async function loadWith(rails: Record<string, string>) {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv('NODE_ENV', 'test');
  for (const [key, value] of Object.entries({ ...BASE_ENV, ...rails })) vi.stubEnv(key, value);
  return import('./env.js');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('LEDGER_RECONCILE_RAIL_<RAIL>_URL', () => {
  it('maps each named rail to its statement URL, upper case and underscores back to the rail id', async () => {
    const { railStatementUrls } = await loadWith({
      LEDGER_RECONCILE_RAIL_CRYPTO_NATIVE_URL: 'http://127.0.0.1:4999/rails/statement',
      LEDGER_RECONCILE_RAIL_TEST_URL: 'https://rails.example/statement',
    });
    expect([...railStatementUrls.entries()].sort()).toEqual([
      ['crypto-native', 'http://127.0.0.1:4999/rails/statement'],
      ['test', 'https://rails.example/statement'],
    ]);
  });

  it('leaves a blank or absent rail out, so its controls stay unset', async () => {
    const { railStatementUrls } = await loadWith({ LEDGER_RECONCILE_RAIL_TEST_URL: '' });
    expect(railStatementUrls.has('test')).toBe(false);
    expect(railStatementUrls.size).toBe(0);
  });

  it('refuses boot for plain http to another host, a value that is not a URL, or a name that is not a rail id', async () => {
    for (const rails of <Array<Record<string, string>>>[
      { LEDGER_RECONCILE_RAIL_TEST_URL: 'http://rails.example/statement' },
      { LEDGER_RECONCILE_RAIL_TEST_URL: 'ftp://rails.example/statement' },
      { LEDGER_RECONCILE_RAIL_TEST_URL: 'not a url' },
      { LEDGER_RECONCILE_RAIL_9TEST_URL: 'https://rails.example/statement' },
      { 'LEDGER_RECONCILE_RAIL_crypto-native_URL': 'https://rails.example/statement' },
      { LEDGER_RECONCILE_RAIL__URL: 'https://rails.example/statement' },
    ])
      await expect(loadWith(rails)).rejects.toThrow(/LEDGER_RECONCILE_RAIL_/);
  });
});

describe('LEDGER_RECONCILE_OPEN_ITEMS_<RAIL>_URL', () => {
  it('maps each rail to its open-items URL, kept apart from the statement URLs', async () => {
    const { openItemsUrls, railStatementUrls } = await loadWith({
      LEDGER_RECONCILE_OPEN_ITEMS_CRYPTO_NATIVE_URL: 'http://127.0.0.1:4506/internal/custody/open-items',
      LEDGER_RECONCILE_RAIL_CRYPTO_NATIVE_URL: 'http://127.0.0.1:4999/rails/statement',
    });
    expect([...openItemsUrls.entries()]).toEqual([['crypto-native', 'http://127.0.0.1:4506/internal/custody/open-items']]);
    expect([...railStatementUrls.entries()]).toEqual([['crypto-native', 'http://127.0.0.1:4999/rails/statement']]);
  });

  it('leaves a blank rail out and refuses boot for plain http to another host or a name that is not a rail id', async () => {
    expect((await loadWith({ LEDGER_RECONCILE_OPEN_ITEMS_TEST_URL: '' })).openItemsUrls.size).toBe(0);
    for (const rails of <Array<Record<string, string>>>[
      { LEDGER_RECONCILE_OPEN_ITEMS_TEST_URL: 'http://pay.example/items' },
      { LEDGER_RECONCILE_OPEN_ITEMS_9TEST_URL: 'https://pay.example/items' },
    ])
      await expect(loadWith(rails)).rejects.toThrow(/LEDGER_RECONCILE_OPEN_ITEMS_/);
  });
});
