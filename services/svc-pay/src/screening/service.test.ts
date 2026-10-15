import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { createFixtureScreeningProvider } from '@intafaced/screening';
import { PayScreeningService } from './service.js';
import { createW9ScreeningGuards } from '../seams/slots/w9-screening.js';
import { composeGuards } from '../seams/guards.js';
import { parseAmount } from '@intafaced/ledger-client';

const merchantId = '11111111-1111-4111-8111-111111111111';
const kybRef = 'TEST-DOSSIER';
const party = { name: 'TEST DATA merchant', country: 'AA', registration: 'TEST-REG', identityKycTier: 'full' as const };
const address = '0x0000000000000000000000000000000000000f01';
const sql = vi.fn(async () => [{ kyb_ref: kybRef }]) as unknown as Sql;
afterEach(() => vi.unstubAllEnvs());

describe('pay screening boundary', () => {
  it('refuses unavailable KYB, destination and payout screening; recovery still finishes', async () => {
    const screening = new PayScreeningService({ sql, env: { APP_ENV: 'prod' } });
    await expect(screening.beforeKybSubmit({ merchantId, kybRef })).rejects.toMatchObject({ code: 'pay.guard_screening_unavailable' });
    await expect(
      screening.beforeDestinationPersist({ merchantId, railId: 'crypto-native', kind: 'crypto', ref: address }),
    ).rejects.toMatchObject({ code: 'pay.guard_screening_unavailable' });
    const guards = composeGuards(createW9ScreeningGuards({ sql, screening }));
    const context = {
      sql,
      merchantId,
      settlementId: merchantId,
      assetId: 'USDT',
      amount: parseAmount('1'),
      railId: 'crypto-native',
      destination: { kind: 'crypto', ref: address },
      attempt: 0,
    };
    await expect(guards.beforePayoutExecute({ ...context, replay: { kind: 'fresh' } })).rejects.toMatchObject({
      code: 'pay.guard_screening_unavailable',
    });
    await expect(
      guards.beforePayoutExecute({ ...context, replay: { kind: 'recovery', reason: 'payout_hold_booked' } }),
    ).resolves.toBeUndefined();
  });

  it('explicit synthetic party and wallet pass; absent network and unknown references refuse', async () => {
    const provider = createFixtureScreeningProvider({
      appEnv: 'test',
      cases: [
        { reference: { merchantId, kybRef }, party, partyOutcome: 'pass', wallets: [{ address, chain: 'eip155:31337', outcome: 'pass' }] },
      ],
    });
    const env = { APP_ENV: 'test', INTAFACED_SCREENING_FAIL_CLOSED: 'off', PAY_CRYPTO_CHAIN_ID: '31337' };
    const service = new PayScreeningService({ sql, provider, env });
    await expect(service.beforeKybSubmit({ merchantId, kybRef })).resolves.toBeUndefined();
    await expect(service.beforeKybSubmit({ merchantId, kybRef: 'unknown' })).rejects.toMatchObject({
      code: 'pay.guard_screening_unavailable',
    });
    await expect(
      service.beforeDestinationPersist({ merchantId, railId: 'crypto-native', kind: 'crypto', ref: address }),
    ).resolves.toBeUndefined();
    await expect(
      new PayScreeningService({ sql, provider, env: { ...env, PAY_CRYPTO_CHAIN_ID: undefined } }).beforeDestinationPersist({
        merchantId,
        railId: 'crypto-native',
        kind: 'crypto',
        ref: address,
      }),
    ).rejects.toMatchObject({ code: 'pay.guard_screening_unavailable' });
  });

  it('region screening remains independent of a passing name provider; account identity evidence is required', async () => {
    vi.stubEnv('INTAFACED_SANCTIONS_REGIONS', 'AA:TEST DATA blocked region');
    vi.stubEnv('INTAFACED_SANCTIONS_LIST_SOURCE', 'test-fixture-governance');
    const provider = createFixtureScreeningProvider({
      appEnv: 'test',
      cases: [{ reference: { merchantId, kybRef }, party, partyOutcome: 'pass' }],
    });
    const service = new PayScreeningService({
      sql,
      provider,
      env: {
        APP_ENV: 'test',
        INTAFACED_SCREENING_FAIL_CLOSED: 'off',
        INTAFACED_SANCTIONS_REGIONS: 'AA:TEST DATA blocked region',
        INTAFACED_SANCTIONS_LIST_SOURCE: 'test-fixture',
      },
    });
    await expect(service.beforeKybSubmit({ merchantId, kybRef })).rejects.toMatchObject({ code: 'pay.guard_screening_region' });
    vi.stubEnv('INTAFACED_SANCTIONS_REGIONS', '');
    const noIdentity = createFixtureScreeningProvider({
      appEnv: 'test',
      cases: [{ reference: { merchantId, kybRef }, party: { ...party, identityKycTier: 'none' }, partyOutcome: 'pass' }],
    });
    await expect(
      new PayScreeningService({
        sql,
        provider: noIdentity,
        env: { APP_ENV: 'test', INTAFACED_SCREENING_FAIL_CLOSED: 'off' },
      }).beforeKybSubmit({ merchantId, kybRef }),
    ).rejects.toMatchObject({ code: 'pay.guard_screening_region' });
  });

  it.each(['review', 'block', 'unavailable'] as const)('refuses provider %s at submission and destination entry', async (outcome) => {
    const provider = createFixtureScreeningProvider({
      appEnv: 'test',
      cases: [{ reference: { merchantId, kybRef }, party, partyOutcome: outcome }],
    });
    const service = new PayScreeningService({ sql, provider, env: { APP_ENV: 'test', INTAFACED_SCREENING_FAIL_CLOSED: 'off' } });
    await expect(service.beforeKybSubmit({ merchantId, kybRef })).rejects.toMatchObject({ code: `pay.guard_screening_${outcome}` });
    await expect(
      service.beforeDestinationPersist({ merchantId, railId: 'bank-payout', kind: 'bank', ref: 'TEST DATA' }),
    ).rejects.toMatchObject({ code: `pay.guard_screening_${outcome}` });
  });

  it('uses the injected sanctions list even when the global list permits the region', async () => {
    vi.stubEnv('INTAFACED_SANCTIONS_REGIONS', '');
    const provider = createFixtureScreeningProvider({
      appEnv: 'test',
      cases: [{ reference: { merchantId, kybRef }, party, partyOutcome: 'pass' }],
    });
    const service = new PayScreeningService({
      sql,
      provider,
      env: {
        APP_ENV: 'test',
        INTAFACED_SCREENING_FAIL_CLOSED: 'off',
        INTAFACED_SANCTIONS_REGIONS: 'AA:TEST DATA blocked region',
        INTAFACED_SANCTIONS_LIST_SOURCE: 'test-fixture',
      },
    });
    await expect(service.beforeKybSubmit({ merchantId, kybRef })).rejects.toMatchObject({ code: 'pay.guard_screening_region' });
  });

  it('queue write failure refuses closed and drops the database error text', async () => {
    const failingSql = vi.fn(async (query: TemplateStringsArray) => {
      if (query.join('').includes('INSERT')) throw new Error('sensitive wallet in database error');
      return [{ kyb_ref: kybRef }];
    }) as unknown as Sql;
    const provider = createFixtureScreeningProvider({
      appEnv: 'test',
      cases: [{ reference: { merchantId, kybRef }, party, partyOutcome: 'review' }],
    });
    const service = new PayScreeningService({
      sql: failingSql,
      provider,
      env: { APP_ENV: 'test', INTAFACED_SCREENING_FAIL_CLOSED: 'off' },
    });
    const ctx = {
      sql: failingSql,
      merchantId,
      settlementId: merchantId,
      assetId: 'USDT',
      amount: parseAmount('1'),
      railId: 'bank-payout',
      destination: { kind: 'bank', ref: 'TEST DATA bank' },
      attempt: 0,
      replay: { kind: 'fresh' as const },
    };
    const error = await service.beforePayoutExecute(ctx).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: 'pay.guard_screening_unavailable', message: 'pay.guard_screening_unavailable' });
    expect(error).not.toHaveProperty('internal');
    expect(error).not.toHaveProperty('cause');
  });
});
