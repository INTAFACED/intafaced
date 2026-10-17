/**
 * Seam: production env.ts loadEnv parse of LEDGER_POSTING_ENABLED.
 * Unrecognized, blank, untrimmed disable tokens, leave posting off; unset preserves the current default.
 * Enable tokens after trim and lower case: true, yes, on, 1.
 *
 * Each token is its own test. One test used to reimport env.ts once per token
 * (15 times). That single test sat at 4.5–4.9 s in CI against Vitest's 5 s
 * default, so a loaded runner killed the suite. Local peak for that bundled
 * test was 913 ms (20 runs).
 *
 * APP_ENV / NODE_ENV are pinned to test before the import. loadEnv runs
 * assertProductionPosture on process.env, and APP_ENV=production throws
 * ProductionPostureError before the posting flag is parsed. That failure
 * reproduces with the variable set and disappears when this file pins it.
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

const OFF = ['disabled', '', '   ', ' false ', ' off ', ' no ', ' 0 ', 'false', 'off', 'no', '0', 'FALSE', 'enabled'] as const;

async function loadWith(overrides: Record<string, string | undefined> = {}) {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('APP_ENV', 'test');
  const leaked = Object.keys(process.env).filter(
    (key) => key.startsWith('LEDGER_') || key.startsWith('RECONCILE_') || key === 'IDENTITY_URL',
  );
  for (const key of leaked) vi.stubEnv(key, undefined);
  for (const [key, value] of Object.entries({ ...BASE_ENV, ...overrides })) {
    if (value === undefined) vi.stubEnv(key, undefined);
    else vi.stubEnv(key, value);
  }
  const module = await import('./env.js');
  return module.env;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('LEDGER_POSTING_ENABLED refuse-closed', () => {
  it.each(OFF)('leaves posting off for %j', async (token) => {
    const parsed = await loadWith({ LEDGER_POSTING_ENABLED: token });
    expect(parsed.LEDGER_POSTING_ENABLED, token).toBe(false);
  });

  it('unset preserves the current default', async () => {
    const unset = await loadWith({ LEDGER_POSTING_ENABLED: undefined });
    expect(unset.LEDGER_POSTING_ENABLED).toBe(true);
  });

  it('explicit true enables posting', async () => {
    const enabled = await loadWith({ LEDGER_POSTING_ENABLED: 'true' });
    expect(enabled.LEDGER_POSTING_ENABLED).toBe(true);
  });

  it('yes, on, and 1 enable posting; disabled and blank stay off', async () => {
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
