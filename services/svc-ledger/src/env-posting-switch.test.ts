/**
 * Seam: production env.ts loadEnv parse of LEDGER_POSTING_ENABLED.
 * Unrecognized, blank, untrimmed disable tokens, leave posting off; unset preserves the current default.
 * Enable tokens after trim and lower case: true, yes, on, 1.
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
  vi.stubEnv('LEDGER_POSTING_ENABLED', undefined);
  for (const [key, value] of Object.entries({ ...BASE_ENV, ...overrides })) {
    vi.stubEnv(key, value);
  }
  const module = await import('./env.js');
  return module.env;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('LEDGER_POSTING_ENABLED refuse-closed', () => {
  it('unrecognized, blank, untrimmed disables, leave posting off; unset preserves the current default', async () => {
    const off = ['disabled', '', '   ', ' false ', ' off ', ' no ', ' 0 ', 'false', 'off', 'no', '0', 'FALSE', 'enabled'];
    for (const token of off) {
      const parsed = await loadWith({ LEDGER_POSTING_ENABLED: token });
      expect(parsed.LEDGER_POSTING_ENABLED, token).toBe(false);
    }
    const unset = await loadWith({ LEDGER_POSTING_ENABLED: undefined });
    expect(unset.LEDGER_POSTING_ENABLED).toBe(true);
    const enabled = await loadWith({ LEDGER_POSTING_ENABLED: 'true' });
    expect(enabled.LEDGER_POSTING_ENABLED).toBe(true);
  });

  it('yes and 1 enable posting; disabled and blank stay off', async () => {
    const yes = await loadWith({ LEDGER_POSTING_ENABLED: 'yes' });
    expect(yes.LEDGER_POSTING_ENABLED).toBe(true);
    const one = await loadWith({ LEDGER_POSTING_ENABLED: '1' });
    expect(one.LEDGER_POSTING_ENABLED).toBe(true);
    const on = await loadWith({ LEDGER_POSTING_ENABLED: 'on' });
    expect(on.LEDGER_POSTING_ENABLED).toBe(true);
    const disabled = await loadWith({ LEDGER_POSTING_ENABLED: 'disabled' });
    expect(disabled.LEDGER_POSTING_ENABLED).toBe(false);
    const blank = await loadWith({ LEDGER_POSTING_ENABLED: '' });
    expect(blank.LEDGER_POSTING_ENABLED).toBe(false);
  });
});
