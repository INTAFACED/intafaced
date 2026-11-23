/**
 * Unit card — REGISTRATION_OPEN refuse-closed
 *
 * 1. Promise: blank / unset is unpublished (undefined). Owner-explicit true
 *    parses as true. Garbage refuses boot. env.ts has no .default(true).
 * 2. Break: boolish .default(true) makes blank look published open.
 * 3. Done bar: production env.ts loadEnv (not a forked slice) + source pin.
 * 4. Class M
 * 5. Paths: env.ts via loadEnv at import (same as boot)
 * 6. RED: unset parses as true, or .default(true) returns on REGISTRATION_OPEN
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SECRET = 's'.repeat(32);

const BASE_ENV = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  DATABASE_POOL_MAX: '10',
  EDGE_PRINCIPAL_SECRET: SECRET,
  INTERNAL_SERVICE_SECRET: SECRET,
  JWT_ACCESS_SECRET: SECRET,
};

async function loadWith(overrides: Record<string, string | undefined> = {}) {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('REGISTRATION_OPEN', undefined);
  vi.stubEnv('REGISTRATION_EMAIL_ALLOWLIST', undefined);
  for (const [key, value] of Object.entries({ ...BASE_ENV, ...overrides })) {
    vi.stubEnv(key, value);
  }
  const module = await import('./env.js');
  return module.env;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('REGISTRATION_OPEN refuse-closed', () => {
  it('env.ts does not git-default true', () => {
    const envTs = readFileSync(join(HERE, 'env.ts'), 'utf8');
    expect(envTs).not.toMatch(/REGISTRATION_OPEN:[\s\S]{0,80}boolish/);
    expect(envTs).not.toMatch(/REGISTRATION_OPEN:[\s\S]{0,200}\.default\(true\)/);
  });

  it('unset is unpublished (not true)', async () => {
    const parsed = await loadWith({});
    expect(parsed.REGISTRATION_OPEN).toBeUndefined();
  });

  it('blank is unpublished (not true)', async () => {
    const parsed = await loadWith({ REGISTRATION_OPEN: '' });
    expect(parsed.REGISTRATION_OPEN).toBeUndefined();
  });

  it('whitespace is unpublished (not true)', async () => {
    const parsed = await loadWith({ REGISTRATION_OPEN: '   ' });
    expect(parsed.REGISTRATION_OPEN).toBeUndefined();
  });

  it('owner-explicit true is allowed', async () => {
    const parsed = await loadWith({ REGISTRATION_OPEN: 'true' });
    expect(parsed.REGISTRATION_OPEN).toBe(true);
  });

  it('owner-explicit false is closed, not unset', async () => {
    const parsed = await loadWith({ REGISTRATION_OPEN: 'false' });
    expect(parsed.REGISTRATION_OPEN).toBe(false);
  });

  it('garbage refuses boot (does not invent open)', async () => {
    await expect(loadWith({ REGISTRATION_OPEN: 'garbage' })).rejects.toThrow(/REGISTRATION_OPEN/);
  });
});

describe('REGISTRATION_EMAIL_ALLOWLIST at boot (#9167)', () => {
  it('unset or blank is no list; a list parses lowercased; a non-address refuses boot', async () => {
    expect((await loadWith({})).REGISTRATION_EMAIL_ALLOWLIST).toBeUndefined();
    expect((await loadWith({ REGISTRATION_EMAIL_ALLOWLIST: '  ' })).REGISTRATION_EMAIL_ALLOWLIST).toBeUndefined();
    const listed = await loadWith({ REGISTRATION_OPEN: 'false', REGISTRATION_EMAIL_ALLOWLIST: 'A@example.com,b@example.com' });
    expect([...(listed.REGISTRATION_EMAIL_ALLOWLIST ?? [])]).toEqual(['a@example.com', 'b@example.com']);
    await expect(loadWith({ REGISTRATION_EMAIL_ALLOWLIST: 'a@example.com,oops' })).rejects.toThrow(/REGISTRATION_EMAIL_ALLOWLIST/);
  });
});
