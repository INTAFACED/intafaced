/**
 * Unit card — BLUEPRINT_CREW_CAPACITY / MENTOR_SHORTLIST_SIZE / SEASON refuse-closed
 *
 * 1. Promise: blank / unset is unpublished (undefined). Owner-explicit 6 / 3 / 1
 *    parse as those numbers. Garbage / out of range refuse boot. env.ts has no
 *    .default(6|3|1).
 * 2. Break: z.coerce.number().default(6) makes blank look published.
 * 3. Done bar: production env.ts loadEnv (not a forked slice) + source pin.
 * 4. Class M
 * 5. Paths: env.ts via loadEnv at import (same as boot)
 * 6. RED: unset parses as 6 / 3 / 1, or .default(6|3|1) returns
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const BASE_ENV = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  DATABASE_POOL_MAX: '10',
  EDGE_PRINCIPAL_SECRET: 'an-edge-principal-secret-long-enough-for-the-schema',
  BLUEPRINT_ENGINE_MODE: 'mock',
};

const KEYS = [
  { name: 'BLUEPRINT_CREW_CAPACITY', invented: 6, owner: '6', parsed: 6 },
  { name: 'BLUEPRINT_MENTOR_SHORTLIST_SIZE', invented: 3, owner: '3', parsed: 3 },
  { name: 'BLUEPRINT_SEASON', invented: 1, owner: '1', parsed: 1 },
] as const;

async function loadWith(overrides: Record<string, string | undefined> = {}) {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('BLUEPRINT_CREW_CAPACITY', undefined);
  vi.stubEnv('BLUEPRINT_MENTOR_SHORTLIST_SIZE', undefined);
  vi.stubEnv('BLUEPRINT_SEASON', undefined);
  for (const [key, value] of Object.entries({ ...BASE_ENV, ...overrides })) {
    vi.stubEnv(key, value);
  }
  const module = await import('./env.js');
  return module.env;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('BLUEPRINT crew / mentor / season refuse-closed', () => {
  for (const key of KEYS) {
    it(`unset ${key.name} is unpublished (not ${key.invented})`, async () => {
      const parsed = await loadWith({});
      expect(parsed[key.name]).toBeUndefined();
    });

    it(`blank ${key.name} is unpublished (not ${key.invented})`, async () => {
      const parsed = await loadWith({ [key.name]: '' });
      expect(parsed[key.name]).toBeUndefined();
    });

    it(`whitespace ${key.name} is unpublished (not ${key.invented})`, async () => {
      const parsed = await loadWith({ [key.name]: '   ' });
      expect(parsed[key.name]).toBeUndefined();
    });

    it(`owner-explicit ${key.owner} is allowed`, async () => {
      const parsed = await loadWith({ [key.name]: key.owner });
      expect(parsed[key.name]).toBe(key.parsed);
    });

    it(`garbage ${key.name} refuses boot (does not invent ${key.invented})`, async () => {
      await expect(loadWith({ [key.name]: 'garbage' })).rejects.toThrow(new RegExp(key.name));
    });
  }

  it('zero crew capacity refuses boot (not a published size)', async () => {
    await expect(loadWith({ BLUEPRINT_CREW_CAPACITY: '0' })).rejects.toThrow(/BLUEPRINT_CREW_CAPACITY/);
  });

  it('zero mentor shortlist refuses boot (not a published length)', async () => {
    await expect(loadWith({ BLUEPRINT_MENTOR_SHORTLIST_SIZE: '0' })).rejects.toThrow(/BLUEPRINT_MENTOR_SHORTLIST_SIZE/);
  });

  it('zero season refuses boot (not a published season)', async () => {
    await expect(loadWith({ BLUEPRINT_SEASON: '0' })).rejects.toThrow(/BLUEPRINT_SEASON/);
  });
});
