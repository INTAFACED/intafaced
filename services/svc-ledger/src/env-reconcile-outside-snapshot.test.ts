/**
 * LEDGER_RECONCILE_OUTSIDE_SNAPSHOT_URL (OPS-reconciliation-02): an owner value with no default. The balances an
 * outside-balance control trusts travel only over https; plain http boots for a loopback host alone (the local TEST stack).
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

async function loadWith(url: string | undefined) {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv('NODE_ENV', 'test');
  for (const [key, value] of Object.entries({ ...BASE_ENV, LEDGER_RECONCILE_OUTSIDE_SNAPSHOT_URL: url })) vi.stubEnv(key, value);
  return (await import('./env.js')).env;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('LEDGER_RECONCILE_OUTSIDE_SNAPSHOT_URL', () => {
  it('stays unset when blank or absent', async () => {
    expect((await loadWith(undefined)).LEDGER_RECONCILE_OUTSIDE_SNAPSHOT_URL).toBeUndefined();
    expect((await loadWith('')).LEDGER_RECONCILE_OUTSIDE_SNAPSHOT_URL).toBeUndefined();
  });

  it('accepts https anywhere and http on a loopback host', async () => {
    for (const url of ['https://rail.example/snapshot', 'http://127.0.0.1:9/x', 'http://localhost:8080/x', 'http://[::1]:9/x'])
      expect((await loadWith(url)).LEDGER_RECONCILE_OUTSIDE_SNAPSHOT_URL).toBe(url);
  });

  it('refuses boot for plain http to any other host, or not a URL', async () => {
    for (const url of ['http://rail.example/snapshot', 'http://10.0.0.5/snapshot', 'ftp://rail.example/x', 'not a url'])
      await expect(loadWith(url)).rejects.toThrow();
  });
});
