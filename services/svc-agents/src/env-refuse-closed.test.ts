/**
 * Unit card — svc-agents money env refuse-closed (S11-1 / S11-3 / S11-4)
 *
 * 1. Promise: unset / blank AGENTS_METERING_ENABLED refuses
 *    `agents.metering_enabled_unset` (never invent true, never silent false);
 *    garbage / untrimmed non-boolean metering strings refuse; unset LEDGER_URL
 *    must refuse (no silent localhost); unset / blank / whitespace-only
 *    AGENTS_FEE_ASSET_ID must refuse (no invent IFC); a padded owner id boots
 *    as the trimmed value; unset AGENTS_USAGE_WINDOW_MINUTES must refuse (never 60).
 * 2. Break: bool.default(true) / compose `:-true` / LEDGER_URL localhost / fee
 *    asset default IFC still feeCharge or invent an owner asset when the
 *    operator never set them. A forked Zod slice stays green while production
 *    loadEnv fail-opens. Denylist `!['0','false','off','no']` treats `false `
 *    and `garbage` as true.
 * 3. Done bar: production env.ts loadEnv (not a forked slice) refuses unset /
 *    blank metering with `agents.metering_enabled_unset`; garbage metering
 *    refuses; unset ledger / fee asset fail; env.ts source matches (no
 *    fail-open defaults).
 * 4. Class M
 * 5. Paths: env.ts via loadEnv at import (same as boot)
 * 6. RED: fail-open defaults return, unset metering parses as true, or garbage
 *    / untrimmed `false ` still bills
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SECRET = 's'.repeat(32);

/** Minimum boot env so assertions are about the money-path keys. */
const BASE_ENV = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  DATABASE_POOL_MAX: '10',
  EDGE_PRINCIPAL_SECRET: SECRET,
  INTERNAL_SERVICE_SECRET: SECRET,
  LEDGER_URL: 'http://svc-ledger:4001',
  AGENTS_FEE_ASSET_ID: 'X',
  AGENTS_USAGE_WINDOW_MINUTES: '60',
  AGENTS_METERING_ENABLED: 'false',
};

/**
 * Load production env.ts the way the process does.
 *
 * `vi.resetModules` + explicit clears are load-bearing: env.ts calls
 * `loadEnv(process.env)` at import. A forked Zod slice would stay green if
 * production preprocess flipped back to `v ?? true`.
 */
async function loadWith(overrides: Record<string, string | undefined> = {}) {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('AGENTS_METERING_ENABLED', undefined);
  vi.stubEnv('LEDGER_URL', undefined);
  vi.stubEnv('AGENTS_FEE_ASSET_ID', undefined);
  vi.stubEnv('AGENTS_USAGE_WINDOW_MINUTES', undefined);
  vi.stubEnv('AGENTS_OVERAGE_GRACE', undefined);
  for (const [key, value] of Object.entries({ ...BASE_ENV, ...overrides })) {
    vi.stubEnv(key, value);
  }
  const module = await import('./env.js');
  return module.env;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('svc-agents money env refuse-closed', () => {
  it('env.ts keeps the refuse-closed shapes production loadEnv parses', () => {
    const envTs = readFileSync(join(HERE, 'env.ts'), 'utf8');
    expect(envTs).not.toMatch(/LEDGER_URL:\s*z\.string\(\)\.url\(\)\.default\('http:\/\/localhost:4001'\)/);
    expect(envTs).toMatch(/LEDGER_URL:\s*z\.string\(\)\.url\(\)/);
    expect(envTs).not.toMatch(/AGENTS_FEE_ASSET_ID:\s*z\.string\(\)\.default\('IFC'\)/);
    expect(envTs).toMatch(/AGENTS_FEE_ASSET_ID:\s*z\.string\(\)\.trim\(\)\.min\(1\)/);
    expect(envTs).not.toMatch(/AGENTS_METERING_ENABLED:\s*bool\.default\(true\)/);
    expect(envTs).toMatch(/AGENTS_METERING_ENABLED:\s*z\.preprocess\(/);
    expect(envTs).toMatch(/agents\.metering_enabled_unset/);
    expect(envTs).not.toMatch(/return trimmed === '' \? false : trimmed/);
    expect(envTs).not.toMatch(/!\['0', 'false', 'off', 'no'\]\.includes/);
    expect(envTs).toMatch(/AGENTS_USAGE_WINDOW_MINUTES:\s*z\.coerce\s*\.number\(\)\s*\.int\(\)\s*\.min\(1\)\s*\.max\(1440\)/);
    expect(envTs).not.toMatch(/AGENTS_USAGE_WINDOW_MINUTES:\s*z\.coerce\.number\(\)\.int\(\)\.min\(1\)\.max\(1440\)\.default\(60\)/);
  });

  it('unset LEDGER_URL refuses (no silent localhost book)', async () => {
    await expect(loadWith({ LEDGER_URL: undefined })).rejects.toThrow(/LEDGER_URL/);
  });

  it('unset AGENTS_FEE_ASSET_ID refuses (no invent IFC)', async () => {
    await expect(loadWith({ AGENTS_FEE_ASSET_ID: undefined })).rejects.toThrow(/AGENTS_FEE_ASSET_ID/);
  });

  it('blank AGENTS_FEE_ASSET_ID refuses', async () => {
    await expect(loadWith({ AGENTS_FEE_ASSET_ID: '' })).rejects.toThrow(/AGENTS_FEE_ASSET_ID/);
  });

  it('whitespace AGENTS_FEE_ASSET_ID refuses the same way a blank fee asset does', async () => {
    await expect(loadWith({ AGENTS_FEE_ASSET_ID: '   ' })).rejects.toThrow(/AGENTS_FEE_ASSET_ID/);
    await expect(loadWith({ AGENTS_FEE_ASSET_ID: '\t\n' })).rejects.toThrow(/AGENTS_FEE_ASSET_ID/);
  });

  it('a real fee asset id boots after trim', async () => {
    const parsed = await loadWith({ AGENTS_FEE_ASSET_ID: '  X  ' });
    expect(parsed.AGENTS_FEE_ASSET_ID).toBe('X');
  });

  it('unset or blank AGENTS_OVERAGE_GRACE is no grace at all, never a default amount', async () => {
    expect((await loadWith()).AGENTS_OVERAGE_GRACE).toBeUndefined();
    expect((await loadWith({ AGENTS_OVERAGE_GRACE: '' })).AGENTS_OVERAGE_GRACE).toBeUndefined();
    expect((await loadWith({ AGENTS_OVERAGE_GRACE: '   ' })).AGENTS_OVERAGE_GRACE).toBeUndefined();
  });

  it('AGENTS_OVERAGE_GRACE takes a decimal amount and refuses anything else', async () => {
    expect((await loadWith({ AGENTS_OVERAGE_GRACE: ' 0.5 ' })).AGENTS_OVERAGE_GRACE).toBe('0.5');
    for (const garbage of ['-1', '1e3', 'lots', '0.1234567890123456789']) {
      await expect(loadWith({ AGENTS_OVERAGE_GRACE: garbage })).rejects.toThrow(/AGENTS_OVERAGE_GRACE/);
    }
  });

  it('unset AGENTS_USAGE_WINDOW_MINUTES refuses (no invent 60)', async () => {
    await expect(loadWith({ AGENTS_USAGE_WINDOW_MINUTES: undefined })).rejects.toThrow(/AGENTS_USAGE_WINDOW_MINUTES/);
  });

  it('blank AGENTS_USAGE_WINDOW_MINUTES refuses', async () => {
    await expect(loadWith({ AGENTS_USAGE_WINDOW_MINUTES: '' })).rejects.toThrow(/AGENTS_USAGE_WINDOW_MINUTES/);
  });

  it('explicit 60 is owner-published (not invented)', async () => {
    const parsed = await loadWith({ AGENTS_USAGE_WINDOW_MINUTES: '60' });
    expect(parsed.AGENTS_USAGE_WINDOW_MINUTES).toBe(60);
  });

  it('refuses a configured usage window that does not divide 1440', async () => {
    // 7, 61, and 100 sit inside 1..1440 and do not divide the day.
    for (const minutes of ['7', '61', '100'] as const) {
      await expect(loadWith({ AGENTS_USAGE_WINDOW_MINUTES: minutes }), minutes).rejects.toThrow(/must divide 1440/);
    }
  });

  it('accepts a configured usage window that divides 1440', async () => {
    for (const minutes of ['1', '15', '1440'] as const) {
      const parsed = await loadWith({ AGENTS_USAGE_WINDOW_MINUTES: minutes });
      expect(parsed.AGENTS_USAGE_WINDOW_MINUTES, minutes).toBe(Number(minutes));
    }
  });

  it('unset AGENTS_METERING_ENABLED refuses agents.metering_enabled_unset', async () => {
    await expect(loadWith({ AGENTS_METERING_ENABLED: undefined })).rejects.toThrow(/agents\.metering_enabled_unset/);
  });

  it('blank AGENTS_METERING_ENABLED refuses agents.metering_enabled_unset', async () => {
    await expect(loadWith({ AGENTS_METERING_ENABLED: '' })).rejects.toThrow(/agents\.metering_enabled_unset/);
  });

  it('whitespace AGENTS_METERING_ENABLED refuses agents.metering_enabled_unset', async () => {
    await expect(loadWith({ AGENTS_METERING_ENABLED: '   ' })).rejects.toThrow(/agents\.metering_enabled_unset/);
  });

  it('trimmed false tokens must not bill', async () => {
    for (const token of ['false', 'FALSE', '0', 'off', 'no'] as const) {
      const parsed = await loadWith({ AGENTS_METERING_ENABLED: token });
      expect(parsed.AGENTS_METERING_ENABLED, token).toBe(false);
    }
  });

  it('untrimmed false must not bill', async () => {
    const parsed = await loadWith({ AGENTS_METERING_ENABLED: 'false ' });
    expect(parsed.AGENTS_METERING_ENABLED).toBe(false);
  });

  it('garbage metering strings refuse (must not bill)', async () => {
    await expect(loadWith({ AGENTS_METERING_ENABLED: 'garbage' })).rejects.toThrow(/AGENTS_METERING_ENABLED/);
    await expect(loadWith({ AGENTS_METERING_ENABLED: 'maybe' })).rejects.toThrow(/AGENTS_METERING_ENABLED/);
    await expect(loadWith({ AGENTS_METERING_ENABLED: 'enabled' })).rejects.toThrow(/AGENTS_METERING_ENABLED/);
  });

  it('explicit true is owner-on (not invented)', async () => {
    const parsed = await loadWith({ AGENTS_METERING_ENABLED: 'true' });
    expect(parsed.AGENTS_METERING_ENABLED).toBe(true);
    expect(parsed.AGENTS_FEE_ASSET_ID).toBe('X');
    expect(parsed.LEDGER_URL).toBe('http://svc-ledger:4001');
  });
});
