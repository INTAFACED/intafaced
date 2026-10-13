import { describe, expect, it } from 'vitest';
import {
  KNOWN_DEV_PRIVATE_KEYS,
  PRODUCTION_POSTURE_REFUSE_CODE,
  ProductionPostureError,
  assertProductionPosture,
  baseEnvSchema,
  isProductionPosture,
  loadEnv,
  productionPostureIssues,
} from './index.js';

type Env = Record<string, string | undefined>;
const REAL = 'q8Vx2mZr7LpT4nBw9KcYh3JdFgA6sUeO1iRtXvNzMoE';
const realProd = (extra: Env = {}): Env => ({
  APP_ENV: 'prod',
  INTERNAL_SERVICE_SECRET: REAL,
  DATABASE_URL: 'postgres://svc:Zr7LpT4nBw9K@db.internal:5432/app',
  ...extra,
});

describe('isProductionPosture', () => {
  it.each([
    ['dev', { APP_ENV: 'dev' }, false],
    ['test', { APP_ENV: 'test' }, false],
    ['dev inside a production container (compose)', { APP_ENV: 'dev', NODE_ENV: 'production' }, false],
    ['unset on a laptop or unit test', {}, false],
    ['unset in a production container', { NODE_ENV: 'production' }, true],
    ['empty in a production container', { APP_ENV: '', NODE_ENV: 'production' }, true],
    ['staging', { APP_ENV: 'staging' }, true],
    ['prod', { APP_ENV: 'prod' }, true],
    ['near miss "DEV"', { APP_ENV: 'DEV' }, true],
    ['typo "production"', { APP_ENV: 'production' }, true],
  ] as const)('%s', (_label, env, expected) => {
    expect(isProductionPosture(env)).toBe(expected);
  });
});

describe('productionPostureIssues', () => {
  it('is empty for real material', () => {
    expect(productionPostureIssues(realProd())).toEqual([]);
  });

  it('is always empty in explicit dev/test, whatever the material', () => {
    const dirty = { INTERNAL_SERVICE_SECRET: 'dev-only-x', PAY_KEY: KNOWN_DEV_PRIVATE_KEYS[0], CHAIN_ID: '31337' };
    expect(productionPostureIssues({ APP_ENV: 'dev', ...dirty })).toEqual([]);
    expect(productionPostureIssues({ APP_ENV: 'test', ...dirty })).toEqual([]);
  });

  it.each([
    'dev-only-edge-secret-at-least-32-chars-long',
    'test-only-internal-service-secret-0123456789',
    'replace-me-before-anything-real',
    'prefix-CHANGE-ME-suffix',
  ])('refuses the placeholder %s', (value) => {
    expect(productionPostureIssues(realProd({ JWT_ACCESS_SECRET: value }))).toEqual([
      expect.stringContaining('JWT_ACCESS_SECRET holds a dev/test placeholder'),
    ]);
  });

  it('refuses every well-known Anvil key, with or without 0x and in any case', () => {
    for (const k of KNOWN_DEV_PRIVATE_KEYS) {
      expect(productionPostureIssues(realProd({ HOT_KEY: k })).length).toBe(1);
      expect(productionPostureIssues(realProd({ HOT_KEY: k.slice(2).toUpperCase() })).length).toBe(1);
    }
    expect(KNOWN_DEV_PRIVATE_KEYS).toHaveLength(10);
  });

  it('refuses the Anvil mnemonic', () => {
    const issues = productionPostureIssues(
      realProd({ PAY_CRYPTO_DEPOSIT_MNEMONIC: 'Test test test test test test test test test test test junk' }),
    );
    expect(issues).toEqual([expect.stringContaining('PAY_CRYPTO_DEPOSIT_MNEMONIC')]);
  });

  it('refuses chain 31337 and 1337, accepts a real chain', () => {
    expect(productionPostureIssues(realProd({ INDEXER_CHAIN_ID: '31337' })).length).toBe(1);
    expect(productionPostureIssues(realProd({ PAY_CRYPTO_CHAIN_ID: '1337' })).length).toBe(1);
    expect(productionPostureIssues(realProd({ INDEXER_CHAIN_ID: '8453' }))).toEqual([]);
  });

  it('refuses an RPC URL that points at a local node', () => {
    for (const url of ['http://127.0.0.1:8545', 'http://localhost:8545', 'http://[::1]:8545', 'http://host.docker.internal:8545']) {
      expect(productionPostureIssues(realProd({ PAY_CRYPTO_RPC_URL: url })).length).toBe(1);
    }
    expect(productionPostureIssues(realProd({ PAY_CRYPTO_RPC_URL: 'https://mainnet.base.org' }))).toEqual([]);
  });

  it('refuses published, equal-to-user and empty database passwords', () => {
    for (const url of [
      'postgres://intafaced:intafaced@db:5432/x',
      'postgres://svc_ops:svc_ops@db/x',
      'postgres://u:postgres@db/x',
      'postgres://u@db/x',
    ]) {
      expect(productionPostureIssues(realProd({ OPS_DATABASE_URL: url })).length).toBe(1);
    }
  });

  it('ignores TEST_ variables, which only the test runner sets', () => {
    expect(productionPostureIssues(realProd({ TEST_DATABASE_URL: 'postgres://u:u@127.0.0.1:5433/x_test' }))).toEqual([]);
  });

  it('never prints a value', () => {
    const secret = 'dev-only-super-secret-value-123456789012';
    const message = new ProductionPostureError('prod', productionPostureIssues(realProd({ JWT_ACCESS_SECRET: secret }))).message;
    expect(message).not.toContain(secret);
    expect(message).toContain('JWT_ACCESS_SECRET');
  });
});

describe('boot', () => {
  it('assertProductionPosture throws a coded error listing every problem', () => {
    try {
      assertProductionPosture(realProd({ JWT_ACCESS_SECRET: 'dev-only-a', INDEXER_CHAIN_ID: '31337' }));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ProductionPostureError);
      expect((e as ProductionPostureError).code).toBe(PRODUCTION_POSTURE_REFUSE_CODE);
      expect((e as ProductionPostureError).issues).toHaveLength(2);
    }
  });

  it('loadEnv refuses before the schema runs, so every service gets the guard', () => {
    expect(() => loadEnv(baseEnvSchema, { APP_ENV: 'prod', SERVICE_NAME: 'svc-x', JWT_ACCESS_SECRET: 'dev-only-a' })).toThrow(
      ProductionPostureError,
    );
    expect(loadEnv(baseEnvSchema, { APP_ENV: 'prod', SERVICE_NAME: 'svc-x' }).APP_ENV).toBe('prod');
    expect(loadEnv(baseEnvSchema, { APP_ENV: 'dev', SERVICE_NAME: 'svc-x', JWT_ACCESS_SECRET: 'dev-only-a' }).APP_ENV).toBe('dev');
  });
});
