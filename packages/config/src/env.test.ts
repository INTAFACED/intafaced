import { describe, expect, it } from 'vitest';
import { EnvError, loadEnv, redactEnv, serviceEnvSchema, authEnvSchema, edgeEnvSchema, internalServiceEnvSchema } from './env.js';

const validServiceEnv = {
  SERVICE_NAME: 'svc-ledger',
  DATABASE_URL: 'postgres://svc_ledger:svc_ledger@localhost:5432/intafaced',
  DATABASE_POOL_MAX: '10',
};

describe('loadEnv', () => {
  it('applies defaults for everything not supplied', () => {
    const env = loadEnv(serviceEnvSchema, validServiceEnv);
    expect(env.APP_ENV).toBe('dev');
    expect(env.REDIS_URL).toBe('redis://localhost:6379');
    expect(env.NATS_URL).toBe('nats://localhost:4222');
    expect(env.HTTP_PORT).toBe(3000);
  });

  it('coerces numeric and boolean strings', () => {
    const env = loadEnv(serviceEnvSchema, { ...validServiceEnv, HTTP_PORT: '8080', DATABASE_SSL: 'true' });
    expect(env.HTTP_PORT).toBe(8080);
    expect(env.DATABASE_SSL).toBe(true);
  });

  it.each(['', ' ', '\t\n'])('refuses an explicitly blank NATS_URL (%j)', (NATS_URL) => {
    expect(() => loadEnv(serviceEnvSchema, { ...validServiceEnv, NATS_URL })).toThrow(EnvError);
  });

  it('trims surrounding whitespace from a configured NATS_URL', () => {
    const env = loadEnv(serviceEnvSchema, { ...validServiceEnv, NATS_URL: ' nats://bus:4222 ' });
    expect(env.NATS_URL).toBe('nats://bus:4222');
  });

  it('reports every problem in one throw', () => {
    try {
      loadEnv(serviceEnvSchema, { SERVICE_NAME: 'svc-x', DATABASE_URL: 'not-a-url', HTTP_PORT: '99999' });
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(EnvError);
      const issues = (e as EnvError).issues;
      expect(issues.some((i) => i.startsWith('DATABASE_URL'))).toBe(true);
      expect(issues.some((i) => i.startsWith('HTTP_PORT'))).toBe(true);
    }
  });

  it('refuses a weak JWT signing key', () => {
    expect(() => loadEnv(authEnvSchema, { JWT_ACCESS_SECRET: 'short' })).toThrow(EnvError);
    expect(() => loadEnv(authEnvSchema, { JWT_ACCESS_SECRET: 'a'.repeat(32) })).not.toThrow();
  });

  it('accepts a public key or a test seed, and refuses a short or malformed one', () => {
    expect(() => loadEnv(edgeEnvSchema, {})).not.toThrow();
    expect(() => loadEnv(edgeEnvSchema, { EDGE_PRINCIPAL_SECRET: 'a'.repeat(32) })).not.toThrow();
    expect(() => loadEnv(edgeEnvSchema, { EDGE_PRINCIPAL_PUBLIC_KEY: 'CAulhhCYaMwJuz_ZSQeSr0xdTJaAFjRxEBrPV2uVWl8' })).not.toThrow();
    for (const source of [{ EDGE_PRINCIPAL_SECRET: 'short' }, { EDGE_PRINCIPAL_PUBLIC_KEY: 'not-a-key' }]) {
      try {
        loadEnv(edgeEnvSchema, source);
        expect.unreachable('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(EnvError);
      }
    }
  });

  it('refuses a missing or short INTERNAL_SERVICE_SECRET', () => {
    for (const source of [{}, { INTERNAL_SERVICE_SECRET: 'short' }]) {
      try {
        loadEnv(internalServiceEnvSchema, source);
        expect.unreachable('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(EnvError);
        expect((e as EnvError).issues.some((i) => i.startsWith('INTERNAL_SERVICE_SECRET'))).toBe(true);
      }
    }
    expect(() => loadEnv(internalServiceEnvSchema, { INTERNAL_SERVICE_SECRET: 'a'.repeat(32) })).not.toThrow();
  });
});

describe('redactEnv', () => {
  it('hides secrets, connection strings and keys', () => {
    const out = redactEnv({
      SERVICE_NAME: 'svc-ledger',
      DATABASE_URL: 'postgres://user:pw@host/db',
      JWT_ACCESS_SECRET: 'super-secret',
      ISSUER_API_KEY: 'k-123',
      HTTP_PORT: 3000,
    });
    expect(out.SERVICE_NAME).toBe('svc-ledger');
    expect(out.HTTP_PORT).toBe(3000);
    expect(out.DATABASE_URL).toBe('«redacted»');
    expect(out.JWT_ACCESS_SECRET).toBe('«redacted»');
    expect(out.ISSUER_API_KEY).toBe('«redacted»');
  });
});
