/**
 * LEDGER_RECONCILE_STATEMENT_TIMEOUT_MS and LEDGER_RECONCILE_MAX_STALE_HOURS (#4755).
 *
 * Both carry a published default (10 minutes, 24 hours) because they are
 * operational limits, not money magnitudes. A value that is set must pass the
 * bounds: the timeout is interpolated into `SET LOCAL statement_timeout`, and a
 * stale window of 0 would raise a stale log on every tick.
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

async function loadWith(overrides: Record<string, string | undefined> = {}) {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('LEDGER_RECONCILE_STATEMENT_TIMEOUT_MS', undefined);
  vi.stubEnv('LEDGER_RECONCILE_MAX_STALE_HOURS', undefined);
  for (const [key, value] of Object.entries({ ...BASE_ENV, ...overrides })) vi.stubEnv(key, value);
  return (await import('./env.js')).env;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('svc-ledger reconcile limits', () => {
  it('defaults to 10 minutes and 24 hours when unset or blank', async () => {
    const unset = await loadWith();
    expect(unset.LEDGER_RECONCILE_STATEMENT_TIMEOUT_MS).toBe(600_000);
    expect(unset.LEDGER_RECONCILE_MAX_STALE_HOURS).toBe(24);
    const blank = await loadWith({ LEDGER_RECONCILE_STATEMENT_TIMEOUT_MS: '  ', LEDGER_RECONCILE_MAX_STALE_HOURS: '' });
    expect(blank.LEDGER_RECONCILE_STATEMENT_TIMEOUT_MS).toBe(600_000);
    expect(blank.LEDGER_RECONCILE_MAX_STALE_HOURS).toBe(24);
  });

  it('takes an explicit in-range override', async () => {
    const parsed = await loadWith({ LEDGER_RECONCILE_STATEMENT_TIMEOUT_MS: '1800000', LEDGER_RECONCILE_MAX_STALE_HOURS: '48' });
    expect(parsed.LEDGER_RECONCILE_STATEMENT_TIMEOUT_MS).toBe(1_800_000);
    expect(parsed.LEDGER_RECONCILE_MAX_STALE_HOURS).toBe(48);
  });

  it.each(['0', '999', '3600001', '1.5', 'ten minutes', '-5'])('refuses statement timeout %s', async (bad) => {
    await expect(loadWith({ LEDGER_RECONCILE_STATEMENT_TIMEOUT_MS: bad })).rejects.toThrow(/LEDGER_RECONCILE_STATEMENT_TIMEOUT_MS/);
  });

  it.each(['0', '721', '2.5', 'a day', '-1'])('refuses max stale hours %s', async (bad) => {
    await expect(loadWith({ LEDGER_RECONCILE_MAX_STALE_HOURS: bad })).rejects.toThrow(/LEDGER_RECONCILE_MAX_STALE_HOURS/);
  });
});
