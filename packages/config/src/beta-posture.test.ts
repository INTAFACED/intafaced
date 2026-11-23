import { describe, expect, it } from 'vitest';
import {
  BETA_POSTURE_ENV,
  BETA_POSTURE_REFUSE_CODE,
  BetaPostureError,
  KNOWN_DEV_PRIVATE_KEYS,
  LocalTestFixtureError,
  PRODUCTION_POSTURE_REFUSE_CODE,
  ProductionPostureError,
  SANCTIONS_REGIONS_ENV,
  SANCTIONS_SOURCE_ENV,
  SCREENING_FAIL_CLOSED_ENV,
  assertNoLocalTestFixtures,
  baseEnvSchema,
  betaPostureIssues,
  isBetaPostureEnv,
  isProductionPosture,
  loadEnv,
  s2sEnvSchema,
  screeningFailClosedFromEnv,
  testNetworksAllowed,
} from './index.js';

type Env = Record<string, string | undefined>;
const REAL = 'q8Vx2mZr7LpT4nBw9KcYh3JdFgA6sUeO1iRtXvNzMoE';
const schema = baseEnvSchema.merge(s2sEnvSchema);

/** A beta process on TEST networks only: staging's real secrets, testnet chains and endpoints, TEST stand-ins for bank and card. */
const beta = (extra: Env = {}): Env => ({
  APP_ENV: 'staging',
  [BETA_POSTURE_ENV]: 'test-networks',
  INTERNAL_SERVICE_SECRET: REAL,
  INTERNAL_SERVICE_BODY_BIND: 'require',
  PAY_CRYPTO_RPC_URL: 'https://sepolia.base.org',
  PAY_CRYPTO_CHAIN_ID: '84532',
  PROTOCOL_CHAIN_ID: '11155111',
  PROTOCOL_RPC_URL: 'https://eth-sepolia.g.alchemy.com/v2/k',
  TRADE_USER_VENUE_URL: 'https://api.hyperliquid-testnet.xyz',
  BANK_CARD_ISSUER: 'card-sim',
  BANK_PAYOUT_PARTNER: 'payout-sim',
  BANK_TEST_PARTNER: 'off',
  BANK_DD_SCHEME: 'none',
  [SANCTIONS_REGIONS_ENV]: 'ZZ:TEST sanctions list stand-in',
  [SANCTIONS_SOURCE_ENV]: 'TEST fixture',
  ...extra,
});

describe('the beta posture boots on TEST networks', () => {
  it('loads its env, opens TEST networks, takes the labelled TEST sanctions list, and stays in production posture', () => {
    const env = beta();
    expect(() => loadEnv(schema, env)).not.toThrow();
    expect(betaPostureIssues(env)).toEqual([]);
    expect(isBetaPostureEnv(env)).toBe(true);
    expect(testNetworksAllowed(env)).toBe(true);
    expect(() => assertNoLocalTestFixtures(env)).not.toThrow();
    expect(isProductionPosture(env)).toBe(true);
    expect(screeningFailClosedFromEnv(env)).toBe(true);
  });
});

describe('the same posture refuses one planted mainnet, real bank or real card route', () => {
  it.each([
    ['a Base mainnet chain id', { PAY_CRYPTO_CHAIN_ID: '8453' }, 'PAY_CRYPTO_CHAIN_ID'],
    ['an Ethereum mainnet chain id', { PROTOCOL_CHAIN_ID: '1' }, 'PROTOCOL_CHAIN_ID'],
    ['the Hyperliquid mainnet API', { TRADE_USER_VENUE_URL: 'https://api.hyperliquid.xyz' }, 'TRADE_USER_VENUE_URL'],
    ['a mainnet RPC host', { PROTOCOL_RPC_URL: 'https://eth-mainnet.g.alchemy.com/v2/k' }, 'PROTOCOL_RPC_URL'],
    [
      'a mainnet venue in a list',
      { TRADE_USER_VENUE_URLS: 'https://api.hyperliquid-testnet.xyz,https://api.hyperliquid.xyz' },
      'TRADE_USER_VENUE_URLS',
    ],
    ['a real card issuer', { BANK_CARD_ISSUER: 'acme-issuing' }, 'BANK_CARD_ISSUER'],
    ['a real payout partner', { BANK_PAYOUT_PARTNER: 'acme-bank' }, 'BANK_PAYOUT_PARTNER'],
  ] as const)('%s', (_label, planted, key) => {
    const env = beta(planted);
    expect(betaPostureIssues(env)).toHaveLength(1);
    let caught: unknown;
    try {
      loadEnv(schema, env);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BetaPostureError);
    expect((caught as BetaPostureError).code).toBe(BETA_POSTURE_REFUSE_CODE);
    expect((caught as Error).message).toContain(key);
    // The message names the variable, never its value.
    expect((caught as Error).message).not.toContain(Object.values(planted)[0]);
  });

  it('refuses the switch outside staging and any other switch value', () => {
    expect(() => loadEnv(schema, beta({ APP_ENV: 'prod' }))).toThrow(BetaPostureError);
    expect(() => loadEnv(schema, beta({ APP_ENV: 'dev' }))).toThrow(BetaPostureError);
    expect(() => loadEnv(schema, beta({ [BETA_POSTURE_ENV]: 'mainnet' }))).toThrow(BetaPostureError);
    expect(isBetaPostureEnv(beta({ APP_ENV: 'prod' }))).toBe(false);
    expect(testNetworksAllowed(beta({ APP_ENV: 'prod' }))).toBe(false);
  });
});

describe("staging's refusals still hold, in the beta posture and without it", () => {
  it('a dev key refuses the beta posture as it refuses staging', () => {
    for (const env of [
      beta({ PAY_KEY: KNOWN_DEV_PRIVATE_KEYS[0] }),
      { ...beta({ PAY_KEY: KNOWN_DEV_PRIVATE_KEYS[0] }), [BETA_POSTURE_ENV]: undefined },
    ]) {
      let caught: unknown;
      try {
        loadEnv(schema, env);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ProductionPostureError);
      expect((caught as ProductionPostureError).code).toBe(PRODUCTION_POSTURE_REFUSE_CODE);
    }
  });

  it("a local dev chain refuses the beta posture through staging's own check, and the beta check refuses it too", () => {
    const env = beta({ PROTOCOL_CHAIN_ID: '31337' });
    expect(() => loadEnv(schema, env)).toThrow(ProductionPostureError);
    expect(betaPostureIssues(env).join()).toContain('PROTOCOL_CHAIN_ID');
  });

  it('a dev-only secret refuses the beta posture', () => {
    expect(() => loadEnv(schema, beta({ INTERNAL_SERVICE_SECRET: 'dev-only-secret' }))).toThrow(ProductionPostureError);
  });

  it('screening stays fail-closed: an explicit off refuses the beta posture and is ignored by the switch', () => {
    const env = beta({ [SCREENING_FAIL_CLOSED_ENV]: 'off' });
    expect(() => assertNoLocalTestFixtures(env)).toThrow(LocalTestFixtureError);
    expect(screeningFailClosedFromEnv(env)).toBe(true);
  });

  it('a TEST KMS key still refuses the beta posture', () => {
    expect(() => assertNoLocalTestFixtures(beta({ LOCAL_TEST_KMS: 'x' }))).toThrow(LocalTestFixtureError);
  });

  it('plain staging, with no switch, still refuses the TEST sanctions list and opens no TEST network', () => {
    const staging = { ...beta(), [BETA_POSTURE_ENV]: undefined };
    expect(() => assertNoLocalTestFixtures(staging)).toThrow(LocalTestFixtureError);
    expect(testNetworksAllowed(staging)).toBe(false);
    expect(betaPostureIssues(staging)).toEqual([]);
  });
});
