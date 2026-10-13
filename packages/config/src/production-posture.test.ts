import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  KNOWN_DEV_ADDRESSES,
  KNOWN_DEV_PRIVATE_KEYS,
  PUBLISHED_DATABASE_PASSWORDS,
  PRODUCTION_POSTURE_REFUSE_CODE,
  ProductionPostureError,
  assertProductionPosture,
  baseEnvSchema,
  isProductionPosture,
  loadEnv,
  productionPostureIssues,
  productionPostureWarnings,
} from './index.js';

type Env = Record<string, string | undefined>;
/** Connection URLs are assembled at runtime so no credential-shaped literal sits in the tree (the secret scan flags those). */
const cred = (scheme: string, user: string, password: string, rest: string) => [scheme, '://', user, ':', password, '@', rest].join('');
const REAL = 'q8Vx2mZr7LpT4nBw9KcYh3JdFgA6sUeO1iRtXvNzMoE';
const realProd = (extra: Env = {}): Env => ({
  APP_ENV: 'prod',
  INTERNAL_SERVICE_SECRET: REAL,
  DATABASE_URL: cred('postgres', 'svc', 'Zr7LpT4nBw9K', 'db.internal:5432/app'),
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
    expect(KNOWN_DEV_PRIVATE_KEYS).toHaveLength(20);
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
      cred('postgres', 'intafaced', 'intafaced', 'db:5432/x'),
      cred('postgres', 'svc_ops', 'svc_ops', 'db/x'),
      cred('postgres', 'u', 'postgres', 'db/x'),
      'postgres://u@db/x',
    ]) {
      expect(productionPostureIssues(realProd({ OPS_DATABASE_URL: url })).length).toBe(1);
    }
  });

  it('does not flag ordinary words that merely contain "change me" or "replace me"', () => {
    for (const v of [
      'service.namespace=exchange-metrics',
      'https://feeds.example/exchangemeta',
      'ui-replacement',
      'fix/ledger-replacement-flow',
      'exchange-me-here',
    ]) {
      expect(productionPostureIssues(realProd({ OTEL_RESOURCE_ATTRIBUTES: v }))).toEqual([]);
    }
    for (const v of ['replace-me', 'change-me', 'x-CHANGEME-y', 'a/replace-me/b']) {
      expect(productionPostureIssues(realProd({ SOME_SECRET: v })).length).toBe(1);
    }
  });

  it('refuses a published database password whatever the variable is called, and in query strings', () => {
    for (const [key, value] of [
      ['CONNECT_DATA_LAKE_TSDB_URL', cred('postgres', 'svc_connect_lake', 'svc_connect_lake', 'postgres:5432/x')],
      ['OPS_DB_URL', cred('postgresql', 'ops', 'intafaced', 'db/x')],
      ['DATABASE_URL_PAY', cred('postgres', 'svc_pay_prod', 'svc_pay', 'db/x')],
      ['SOME_URL', 'postgres://u@db/x?password=postgres'],
      ['PGPASSWORD', 'intafaced'],
      ['REDIS_URL', cred('redis', 'default', 'intafaced', 'cache:6379')],
    ] as const) {
      expect(productionPostureIssues(realProd({ [key]: value })).length, key).toBe(1);
    }
  });

  it('accepts a passwordless database URL only when PGPASSWORD or a client certificate supplies the credential', () => {
    expect(productionPostureIssues(realProd({ OPS_DATABASE_URL: 'postgres://svc@db.internal/x?sslmode=verify-full' })).length).toBe(1);
    expect(productionPostureIssues(realProd({ OPS_DATABASE_URL: 'postgres://svc@db.internal/x', PGPASSWORD: 'Zr7LpT4nBw9Kq2Xs' }))).toEqual(
      [],
    );
    expect(productionPostureIssues(realProd({ OPS_DATABASE_URL: 'postgres://svc@db.internal/x?sslcert=/etc/tls/c.pem' }))).toEqual([]);
  });

  it('does not crash on a malformed percent escape in a URL', () => {
    expect(() => productionPostureIssues(realProd({ OPS_DATABASE_URL: cred('postgres', 'u', '%zz', 'db/x') }))).not.toThrow();
  });

  it('reads chain ids the way the schemas do (numerically)', () => {
    for (const v of ['0x7a69', '031337', '31337.0', '3.1337e4', ' 31337 ', '0x539', '1337']) {
      expect(productionPostureIssues(realProd({ PAY_CRYPTO_CHAIN_ID: v })).length, v).toBe(1);
    }
    expect(productionPostureIssues(realProd({ PAY_CRYPTO_CHAIN_ID: '8453' }))).toEqual([]);
  });

  it('recognises loopback and the local node in every spelling, across lists and other RPC-ish names', () => {
    for (const url of [
      'http://127.0.0.2:8545',
      'http://localhost.:8545',
      'http://node.localhost:8545',
      'http://[::ffff:127.0.0.1]:8545',
      'http://evm:8545',
      'http://anvil:8545',
      'https://mainnet.base.org,http://127.0.0.1:8545',
    ]) {
      expect(productionPostureIssues(realProd({ PROTOCOL_RPC_URL: url })).length, url).toBe(1);
    }
    expect(productionPostureIssues(realProd({ PROTOCOL_BUNDLER_URL: 'http://localhost:4337' })).length).toBe(1);
    expect(productionPostureIssues(realProd({ INDEXER_WS_URL: 'ws://127.0.0.1:8546' })).length).toBe(1);
    expect(productionPostureIssues(realProd({ PROTOCOL_RPC_URL: 'https://base-mainnet.g.alchemy.com/v2/abc' }))).toEqual([]);
  });

  it('refuses the well-known Anvil addresses and account 0 deployments', () => {
    for (const a of KNOWN_DEV_ADDRESSES) {
      expect(productionPostureIssues(realProd({ PROTOCOL_ROUTER_ADDRESS: a })).length, a).toBe(1);
      expect(productionPostureIssues(realProd({ PROTOCOL_ROUTER_ADDRESS: a.toLowerCase() })).length, a).toBe(1);
    }
    expect(KNOWN_DEV_ADDRESSES).toHaveLength(30);
    expect(productionPostureIssues(realProd({ PROTOCOL_ROUTER_ADDRESS: '0x4200000000000000000000000000000000000006' }))).toEqual([]);
  });

  it('exempts only the test runner database variables, not any TEST_ name', () => {
    expect(productionPostureIssues(realProd({ TEST_DATABASE_URL: cred('postgres', 'u', 'u', '127.0.0.1/x_test') }))).toEqual([]);
    expect(productionPostureIssues(realProd({ TEST_FLAG: 'dev-only-x' })).length).toBe(1);
  });

  it('warns (does not refuse) when S2S body binding is not "require" where the shared secret is held', () => {
    expect(productionPostureIssues(realProd({ INTERNAL_SERVICE_BODY_BIND: undefined }))).toEqual([]);
    expect(productionPostureWarnings(realProd({ INTERNAL_SERVICE_BODY_BIND: undefined })).length).toBe(1);
    expect(productionPostureWarnings(realProd({ INTERNAL_SERVICE_BODY_BIND: 'accept-both' })).length).toBe(1);
    expect(productionPostureWarnings(realProd({ INTERNAL_SERVICE_BODY_BIND: 'require' }))).toEqual([]);
    // A process with no shared secret does not speak S2S, and dev stays on the migration default.
    expect(productionPostureWarnings({ APP_ENV: 'prod' })).toEqual([]);
    expect(productionPostureWarnings({ APP_ENV: 'dev', INTERNAL_SERVICE_SECRET: REAL })).toEqual([]);
  });

  it('loadEnv logs that warning once and still boots', () => {
    const logged: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((line: string) => void logged.push(line));
    try {
      loadEnv(baseEnvSchema, { APP_ENV: 'prod', SERVICE_NAME: 'svc-x', INTERNAL_SERVICE_SECRET: REAL });
    } finally {
      spy.mockRestore();
    }
    expect(logged).toHaveLength(1);
    expect(JSON.parse(logged[0]!)).toMatchObject({ event: 'config.production_posture_warning', service: 'svc-x' });
    expect(logged[0]).not.toContain(REAL);
  });

  it('keeps the published-password list in step with the init SQL that creates the roles', () => {
    const sql = readFileSync(resolve(import.meta.dirname, '../../../tooling/infra/postgres-init/01-service-schemas.sql'), 'utf8');
    const block = /services text\[\] := ARRAY\[([\s\S]*?)\];/.exec(sql)?.[1] ?? '';
    const names = [...block.matchAll(/'([a-z_0-9]+)'/g)].map((m) => m[1]!);
    expect(names.length).toBeGreaterThan(15);
    for (const name of names) expect(PUBLISHED_DATABASE_PASSWORDS.has(`svc_${name}`), name).toBe(true);
    expect(PUBLISHED_DATABASE_PASSWORDS.has('intafaced_ops')).toBe(true);
  });

  it('refuses only the exact published passwords, not strong ones that share a prefix', () => {
    expect(
      productionPostureIssues(realProd({ OPS_DATABASE_URL: cred('postgres', 'svc_ledger', 'svc_7f3a9c2e4b1d8e6f0a5b', 'db/x') })),
    ).toEqual([]);
    expect(
      productionPostureIssues(realProd({ OPS_DATABASE_URL: cred('postgres', 'ledger', 'intafaced_9f8a7c6b5d4e3f2a1b0c', 'db/x') })),
    ).toEqual([]);
  });

  it('does not match unrelated keys that merely contain RPC or WS', () => {
    for (const key of [
      'OTEL_EXPORTER_OTLP_GRPC_ENDPOINT',
      'RISK_GRPC_URL',
      'IDENTITY_TRPC_URL',
      'VAULT_NODE_URL',
      'NEXT_PUBLIC_WS_URL',
      'GAME_CHAIN_ID_OFFSET',
    ]) {
      expect(productionPostureIssues(realProd({ [key]: key === 'GAME_CHAIN_ID_OFFSET' ? '1337' : 'http://localhost:9' })), key).toEqual([]);
    }
  });

  it('reads a list of chain ids and underscore placeholders', () => {
    expect(productionPostureIssues(realProd({ SUPPORTED_CHAIN_IDS: '8453,31337' })).length).toBe(1);
    expect(productionPostureIssues(realProd({ SOME_SECRET: 'dev_only_thing' })).length).toBe(1);
    expect(productionPostureIssues(realProd({ SOME_SECRET: 'REPLACEME' })).length).toBe(1);
    expect(productionPostureIssues(realProd({ OPS_DATABASE_URL: 'postgres://svc@db/x?sslcert=' })).length).toBe(1);
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
