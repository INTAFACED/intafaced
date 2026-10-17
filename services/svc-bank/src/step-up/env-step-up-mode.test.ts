/**
 * Unit card — BANK_STEP_UP_MONEY_OUT is off | required, default off, anything else refuses boot
 *
 * 1. Promise: production env.ts parses `off` (default) and `required`; any other value, including blank
 *    and a wrong case, refuses boot, and compose passes the name through with default `off`.
 * 2. Break: a typo ("requried", "on") that quietly read as `off` would ship money-out with no step-up
 *    while the operator believed it was on.
 * 3. Done bar: loadEnv refuses '', 'on', 'REQUIRED'; accepts the two real values; compose has the key once.
 * 4. Class N
 * 5. Paths: services/svc-bank/src/env.ts (via loadEnv at import), docker-compose.apps.yml
 * 6. RED: z.string() / a lenient transform replaces the enum
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..', '..');
const SECRET = 's'.repeat(32);

const BASE_ENV = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  DATABASE_POOL_MAX: '10',
  EDGE_PRINCIPAL_SECRET: SECRET,
  INTERNAL_SERVICE_SECRET: SECRET,
  LOAN_QUOTE_ASSET_ID: 'X',
  TRANSFER_BATCH_SIZE: '200',
  LOAN_SWEEP_BATCH_SIZE: '500',
};

async function loadWith(overrides: Record<string, string | undefined> = {}) {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('BANK_STEP_UP_MONEY_OUT', undefined);
  for (const [key, value] of Object.entries({ ...BASE_ENV, ...overrides })) vi.stubEnv(key, value);
  const module = await import('../env.js');
  return module.env;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('BANK_STEP_UP_MONEY_OUT', () => {
  it('defaults to off when unset', async () => {
    expect((await loadWith()).BANK_STEP_UP_MONEY_OUT).toBe('off');
  });

  it('accepts off and required', async () => {
    expect((await loadWith({ BANK_STEP_UP_MONEY_OUT: 'off' })).BANK_STEP_UP_MONEY_OUT).toBe('off');
    expect((await loadWith({ BANK_STEP_UP_MONEY_OUT: 'required' })).BANK_STEP_UP_MONEY_OUT).toBe('required');
  });

  it.each(['', 'on', 'true', 'REQUIRED', 'requried'])('refuses %j at boot', async (bad) => {
    await expect(loadWith({ BANK_STEP_UP_MONEY_OUT: bad })).rejects.toThrow(/BANK_STEP_UP_MONEY_OUT/);
  });

  it('compose passes it through exactly once with default off', () => {
    const compose = readFileSync(join(ROOT, 'docker-compose.apps.yml'), 'utf8');
    expect(compose.match(/^\s+BANK_STEP_UP_MONEY_OUT:/gm) ?? []).toHaveLength(1);
    expect(compose).toMatch(/BANK_STEP_UP_MONEY_OUT:\s*\$\{BANK_STEP_UP_MONEY_OUT:-off\}/);
  });
});
