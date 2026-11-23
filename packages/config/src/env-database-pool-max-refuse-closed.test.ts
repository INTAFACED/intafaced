/**
 * Unit card — config DATABASE_POOL_MAX unset refuse (no invented 10)
 *
 * 1. Promise: unset / blank DATABASE_POOL_MAX refuses boot (never invent 10).
 *    Owner-explicit 10 is a published pool size.
 * 2. Break: env.ts `.default(10)` / compose `:-10` makes a blank host env look
 *    published as a pool size nobody chose. Empty string must not coerce to 0
 *    (0 is not a legal pool).
 * 3. Done bar: production postgresEnvSchema via loadEnv (not a forked slice)
 *    refuses unset, blank, whitespace, 0 and out-of-range sizes; explicit 10
 *    parses.
 * 4. Class N
 * 5. Paths: env.ts postgresEnvSchema via loadEnv (same schema services merge)
 * 6. RED: git-default 10 returns, or unset/blank parses as 10 or 0
 */
import { describe, expect, it } from 'vitest';
import { EnvError, loadEnv, postgresEnvSchema, serviceEnvSchema } from './env.js';

const BASE_PG = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  DATABASE_POOL_MAX: '10',
};

describe('config DATABASE_POOL_MAX refuse-closed', () => {
  it('a pool size outside 1..200, or not a whole number, refuses; the bounds parse', () => {
    for (const bad of ['201', '-1', '2.5', 'ten']) {
      expect(() => loadEnv(postgresEnvSchema, { ...BASE_PG, DATABASE_POOL_MAX: bad }), bad).toThrow(EnvError);
    }
    expect(loadEnv(postgresEnvSchema, { ...BASE_PG, DATABASE_POOL_MAX: '1' }).DATABASE_POOL_MAX).toBe(1);
    expect(loadEnv(postgresEnvSchema, { ...BASE_PG, DATABASE_POOL_MAX: '200' }).DATABASE_POOL_MAX).toBe(200);
  });

  it('unset DATABASE_POOL_MAX refuses (no invent 10)', () => {
    try {
      loadEnv(postgresEnvSchema, { DATABASE_URL: BASE_PG.DATABASE_URL });
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(EnvError);
      expect((e as EnvError).issues.some((i) => i.startsWith('DATABASE_POOL_MAX'))).toBe(true);
    }
  });

  it('blank DATABASE_POOL_MAX refuses (empty is not 0)', () => {
    expect(() => loadEnv(postgresEnvSchema, { ...BASE_PG, DATABASE_POOL_MAX: '' })).toThrow(EnvError);
  });

  it('whitespace DATABASE_POOL_MAX refuses', () => {
    expect(() => loadEnv(postgresEnvSchema, { ...BASE_PG, DATABASE_POOL_MAX: '   ' })).toThrow(EnvError);
  });

  it('explicit 0 refuses (0 is not a legal pool)', () => {
    expect(() => loadEnv(postgresEnvSchema, { ...BASE_PG, DATABASE_POOL_MAX: '0' })).toThrow(EnvError);
  });

  it('explicit 10 is owner-published (not invented)', () => {
    const parsed = loadEnv(postgresEnvSchema, BASE_PG);
    expect(parsed.DATABASE_POOL_MAX).toBe(10);
  });

  it('serviceEnvSchema merge also refuses unset pool (boot path)', () => {
    try {
      loadEnv(serviceEnvSchema, {
        SERVICE_NAME: 'svc-ledger',
        DATABASE_URL: BASE_PG.DATABASE_URL,
      });
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(EnvError);
      expect((e as EnvError).issues.some((i) => i.startsWith('DATABASE_POOL_MAX'))).toBe(true);
    }
  });
});
