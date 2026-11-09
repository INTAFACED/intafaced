/**
 * Seam: production env.ts loadEnv parse of LEDGER_CUSTODY_LAYER, the custody switch (OWNER 226).
 * Unset or blank is off (no customer money is the launch decision); on and off are the only values; anything else
 * refuses boot, so a typo can never turn custody on. Same loader as env-posting-switch.test.ts.
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

describe('LEDGER_CUSTODY_LAYER', () => {
  it.each([undefined, '', '   '])('reads %j as off', async (token) => {
    const parsed = await loadWith({ LEDGER_CUSTODY_LAYER: token });
    expect(parsed.LEDGER_CUSTODY_LAYER).toBe('off');
  });

  it.each([
    ['on', 'on'],
    [' ON ', 'on'],
    ['off', 'off'],
    ['Off', 'off'],
  ])('reads %j as %s', async (token, want) => {
    const parsed = await loadWith({ LEDGER_CUSTODY_LAYER: token });
    expect(parsed.LEDGER_CUSTODY_LAYER).toBe(want);
  });

  it.each(['true', '1', 'yes', 'of', 'enabled'])('refuses boot on %j rather than guess', async (token) => {
    await expect(loadWith({ LEDGER_CUSTODY_LAYER: token })).rejects.toThrow(/LEDGER_CUSTODY_LAYER/);
  });
});
