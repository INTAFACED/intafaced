import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger, parseAmount as amt } from '@intafaced/ledger-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { truncatePayForTest } from '../payment-events-test-reset.js';
import { RailRegistry } from '../rails/registry.js';
import { CardSandboxAdapter } from '../rails/card-sandbox.js';
import { BankPayoutAbsentAdapter } from '../rails/bank-payout.js';
import { PayGuardRefusal, composeGuards } from '../seams/guards.js';
import { UserMoneyService } from '../user-money-service.js';
import { loadWithdrawalLimitMode, loadWithdrawalLimits } from './config.js';
import { createWithdrawalLimitGuards, type KycTierOf } from './guards.js';
import { createIdentityLimitOverrideClient, type LimitOverride, type LimitOverrideOf } from './identity-override.js';
import { createIdentityKycTierClient } from './identity-tier.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

const SECRET = 'svc-pay-withdrawal-limit-test-secret-at-least-32-chars';
const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('intafaced_withdrawal_limit_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

// TEST figures, illustrative only. The guard has no defaults of its own.
const LIMITS = JSON.stringify({ basic: { USDT: { perTx: '10', rolling24h: '15' } } });
const REQUIRED = { PAY_WITHDRAWAL_LIMITS: 'required', PAY_WITHDRAWAL_LIMITS_BY_TIER: LIMITS };
const basic: KycTierOf = async () => 'basic';
const noOverride: LimitOverrideOf = async () => null;

describe('D-148 per-customer withdrawal limits (real Postgres)', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase;
  let sql!: TestDatabase['sql'];
  let ledger: MemoryLedger;
  let rails: RailRegistry;

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
    sql = db.sql;
  }, 120_000);

  beforeEach(async () => {
    await truncatePayForTest(sql, 'pay', `TRUNCATE pay.withdrawals, pay.deposits RESTART IDENTITY CASCADE`);
    ledger = new MemoryLedger();
    rails = new RailRegistry([new CardSandboxAdapter({ secret: SECRET, toleranceSeconds: 300 }), new BankPayoutAbsentAdapter()]);
  }, 30_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  /** `null` leaves the override read unwired. */
  const money = (env: Record<string, string>, tierOf?: KycTierOf, overrideOf: LimitOverrideOf | null = noOverride) =>
    new UserMoneyService(sql, ledger, rails, {
      operatorCreditRails: ['card-sandbox'],
      guards: composeGuards(createWithdrawalLimitGuards({ sql, env, tierOf, overrideOf: overrideOf ?? undefined })),
    });

  async function fund(service: UserMoneyService, userId = USER) {
    await service.credit({
      userId,
      assetId: 'USDT',
      amount: amt('500'),
      rail: 'card-sandbox',
      railRef: `seed-${userId}`,
      creditedBy: '99999999-9999-4999-8999-999999999999',
    });
  }
  const request = (amount: string, clientRef: string, userId = USER) => ({
    userId,
    assetId: 'USDT',
    amount: amt(amount),
    rail: 'card-sandbox',
    destination: { kind: 'bank', ref: 'DE89370400440532013000' },
    clientRef,
  });
  const refusal = async (p: Promise<unknown>): Promise<PayGuardRefusal> => {
    const error = await p.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(PayGuardRefusal);
    return error as PayGuardRefusal;
  };

  it('is off by default and refuses boot on a mode that is not off or required', () => {
    expect(loadWithdrawalLimitMode({})).toBe('off');
    expect(loadWithdrawalLimitMode({ PAY_WITHDRAWAL_LIMITS: 'required' })).toBe('required');
    expect(() => loadWithdrawalLimitMode({ PAY_WITHDRAWAL_LIMITS: '' })).toThrow(/off.*required/);
    expect(() => loadWithdrawalLimitMode({ PAY_WITHDRAWAL_LIMITS: 'on' })).toThrow(/off.*required/);
  });

  it('treats a blank, malformed or non-positive limit as unset, never as unlimited', () => {
    const load = (v: string | undefined) => loadWithdrawalLimits({ PAY_WITHDRAWAL_LIMITS_BY_TIER: v });
    expect(load(undefined).byTier.size).toBe(0);
    expect(load('not json').byTier.size).toBe(0);
    expect(
      load(JSON.stringify({ basic: { USDT: { perTx: '0', rolling24h: '5' } } }))
        .byTier.get('basic')
        ?.has('USDT'),
    ).toBeFalsy();
    expect(
      load(JSON.stringify({ basic: { USDT: { perTx: '5' } } }))
        .byTier.get('basic')
        ?.has('USDT'),
    ).toBeFalsy();
    expect(load(LIMITS).byTier.get('basic')?.get('USDT')).toEqual({ perTx: amt('10'), rolling24h: amt('15') });
  });

  it('off: no limit is checked', async () => {
    const service = money({}, undefined);
    await fund(service);
    expect((await service.withdraw(request('400', 'big'))).status).toBe('sent');
  });

  it('required with no limit for the tier and asset: refuses with a typed error and leaves no claim', async () => {
    const service = money({ PAY_WITHDRAWAL_LIMITS: 'required' }, basic);
    await fund(service);
    expect((await refusal(service.withdraw(request('1', 'unset')))).code).toBe('pay.guard_withdrawal_limit_unset');
    const noTier = money(
      { ...REQUIRED, PAY_WITHDRAWAL_LIMITS_BY_TIER: JSON.stringify({ full: { USDT: { perTx: '5', rolling24h: '5' } } }) },
      basic,
    );
    expect((await refusal(noTier.withdraw(request('1', 'unset2')))).code).toBe('pay.guard_withdrawal_limit_unset');
    expect(await sql`SELECT 1 FROM pay.withdrawals`).toHaveLength(0);
  });

  it('required with no tier source wired: refuses, because a missing answer is not evidence of a high tier', async () => {
    const service = money(REQUIRED, undefined);
    await fund(service);
    expect((await refusal(service.withdraw(request('1', 'untiered')))).code).toBe('pay.guard_withdrawal_tier_unwired');
    expect(await sql`SELECT 1 FROM pay.withdrawals`).toHaveLength(0);
  });

  it('per-transaction limit: over refuses with the allowance; exactly at passes', async () => {
    const service = money(REQUIRED, basic);
    await fund(service);
    const over = await refusal(service.withdraw(request('10.000000000000000001', 'over')));
    expect(over.code).toBe('pay.guard_withdrawal_limit_exceeded');
    expect(over.remaining).toEqual({ perTx: '10', rolling24h: '15' });
    expect(await sql`SELECT 1 FROM pay.withdrawals`).toHaveLength(0);
    expect((await service.withdraw(request('10', 'at'))).status).toBe('sent');
  });

  it('rolling 24h: counts sent, held and pending; a hit returns what is left; failed and older than 24h do not count', async () => {
    const service = money(REQUIRED, basic);
    await fund(service);
    expect((await service.withdraw(request('10', 'a'))).status).toBe('sent');
    const hit = await refusal(service.withdraw(request('6', 'b')));
    expect(hit.code).toBe('pay.guard_withdrawal_limit_exceeded');
    expect(hit.remaining).toEqual({ perTx: '10', rolling24h: '5' });
    expect((await service.withdraw(request('5', 'c'))).status).toBe('sent');

    await sql`UPDATE pay.withdrawals SET created_at = now() - interval '25 hours', updated_at = now() - interval '25 hours' WHERE client_ref = 'a'`;
    expect((await service.withdraw(request('10', 'd'))).status).toBe('sent');
    await sql`UPDATE pay.withdrawals SET status = 'failed' WHERE client_ref = 'c'`;
    const left = await refusal(service.withdraw(request('6', 'e')));
    expect(left.remaining).toEqual({ perTx: '10', rolling24h: '5' });
  });

  it('a failed claim reopened by a retry counts from the retry, not from when it was first made', async () => {
    const service = money(REQUIRED, basic);
    await fund(service);
    expect((await service.withdraw(request('10', 'old'))).status).toBe('sent');
    await sql`UPDATE pay.withdrawals SET status = 'failed', created_at = now() - interval '30 hours', updated_at = now() - interval '30 hours' WHERE client_ref = 'old'`;
    expect((await service.withdraw(request('10', 'old'))).status).toBe('sent');
    const hit = await refusal(service.withdraw(request('6', 'next')));
    expect(hit.remaining).toEqual({ perTx: '10', rolling24h: '5' });
  });

  it('with the identity tier client wired, required works end to end; an identity failure refuses with no claim', async () => {
    let tier: string | undefined = 'basic';
    const fetchImpl = (async (input: string | URL | Request) => {
      const userId = decodeURIComponent(String(input).split('/').pop() ?? '');
      if (tier === undefined) return new Response('down', { status: 503 });
      return new Response(JSON.stringify({ userId, status: 'active', kycTier: tier }), { status: 200 });
    }) as typeof fetch;
    const tierOf = createIdentityKycTierClient({ baseUrl: 'http://identity.test', internalSecret: 'x'.repeat(32), fetchImpl });
    const service = money(REQUIRED, tierOf);
    await fund(service);
    expect((await service.withdraw(request('10', 'wired'))).status).toBe('sent');
    tier = undefined;
    expect((await refusal(service.withdraw(request('1', 'dark')))).code).toBe('pay.guard_unavailable');
    expect(await sql`SELECT 1 FROM pay.withdrawals WHERE client_ref = 'dark'`).toHaveLength(0);
  });

  it('one customer reaching their limit does not touch another', async () => {
    const service = money(REQUIRED, basic);
    await fund(service);
    await fund(service, OTHER);
    expect((await service.withdraw(request('10', 'a'))).status).toBe('sent');
    expect((await service.withdraw(request('5', 'b'))).status).toBe('sent');
    expect((await service.withdraw(request('10', 'a2', OTHER))).status).toBe('sent');
  });

  it('two parallel withdrawals that together pass the 24h limit: exactly one is admitted', async () => {
    const service = money(REQUIRED, basic);
    await fund(service);
    const results = await Promise.all([
      service.withdraw(request('9', 'p1')).then(
        (r) => r.status,
        (e: { code?: string }) => `refused ${e.code}`,
      ),
      service.withdraw(request('9', 'p2')).then(
        (r) => r.status,
        (e: { code?: string }) => `refused ${e.code}`,
      ),
    ]);
    expect(results.filter((r) => r === 'sent')).toHaveLength(1);
    expect(results.filter((r) => r === 'refused pay.guard_withdrawal_limit_exceeded')).toHaveLength(1);
  });

  it('a retry of a withdrawal already claimed is not counted twice', async () => {
    const service = money(REQUIRED, basic);
    await fund(service);
    const first = await service.withdraw(request('10', 'same'));
    const again = await service.withdraw(request('10', 'same'));
    expect(again.id).toBe(first.id);
    expect((await service.withdraw(request('5', 'next'))).status).toBe('sent');
  });

  describe('a founder override (J-ops-console-04 #12)', () => {
    const inAnHour = () => new Date(Date.now() + 3_600_000);
    const fixed =
      (o: Omit<LimitOverride, 'expiresAt'> | null): LimitOverrideOf =>
      async () =>
        o && { ...o, expiresAt: inAnHour() };

    it('a raise lets a withdrawal through above the base; a null figure keeps the base figure', async () => {
      const service = money(REQUIRED, basic, fixed({ perTx: amt('12'), rolling24h: null }));
      await fund(service);
      expect((await service.withdraw(request('12', 'raised'))).status).toBe('sent');
      const hit = await refusal(service.withdraw(request('4', 'rolling')));
      expect(hit.code).toBe('pay.guard_withdrawal_limit_exceeded');
      expect(hit.remaining).toEqual({ perTx: '12', rolling24h: '3' });
    });

    it('a lowered limit refuses with the override as the allowance, and the base returns once identity stops answering it', async () => {
      let override: Omit<LimitOverride, 'expiresAt'> | null = { perTx: amt('4'), rolling24h: amt('6') };
      const service = money(REQUIRED, basic, async () => override && { ...override, expiresAt: inAnHour() });
      await fund(service);
      const low = await refusal(service.withdraw(request('5', 'low')));
      expect(low.code).toBe('pay.guard_withdrawal_limit_exceeded');
      expect(low.remaining).toEqual({ perTx: '4', rolling24h: '6' });
      expect(await sql`SELECT 1 FROM pay.withdrawals`).toHaveLength(0);
      override = null;
      expect((await service.withdraw(request('5', 'low'))).status).toBe('sent');
    });

    it('no override read wired refuses, since a lowered limit must never be skipped; a failed read refuses with no claim', async () => {
      const unwired = money(REQUIRED, basic, null);
      await fund(unwired);
      expect((await refusal(unwired.withdraw(request('1', 'unwired')))).code).toBe('pay.guard_withdrawal_override_unwired');
      const dark = money(REQUIRED, basic, async () => {
        throw new Error('identity unreachable: limit override not read');
      });
      expect((await refusal(dark.withdraw(request('1', 'dark')))).code).toBe('pay.guard_unavailable');
      expect(await sql`SELECT 1 FROM pay.withdrawals`).toHaveLength(0);
    });

    it('an override never stands in for an unset base figure', async () => {
      const service = money({ PAY_WITHDRAWAL_LIMITS: 'required' }, basic, fixed({ perTx: amt('100'), rolling24h: amt('100') }));
      await fund(service);
      expect((await refusal(service.withdraw(request('1', 'nobase')))).code).toBe('pay.guard_withdrawal_limit_unset');
    });

    it('with the identity override client wired: applied until its end time by our own clock too, then the base', async () => {
      let clock = new Date();
      const expiresAt = new Date(clock.getTime() + 60_000).toISOString();
      const fetchImpl = (async (input: string | URL | Request) => {
        const url = new URL(String(input));
        const userId = decodeURIComponent(url.pathname.split('/').pop() ?? '');
        return new Response(
          JSON.stringify({
            userId,
            rail: url.searchParams.get('rail'),
            assetId: url.searchParams.get('assetId'),
            override: { version: '1', perTx: '20', rolling24h: '20', expiresAt },
          }),
          { status: 200 },
        );
      }) as typeof fetch;
      const overrideOf = createIdentityLimitOverrideClient({
        baseUrl: 'http://identity.test',
        internalSecret: 'x'.repeat(32),
        fetchImpl,
        now: () => clock,
      });
      const service = money(REQUIRED, basic, overrideOf);
      await fund(service);
      expect((await service.withdraw(request('20', 'wired'))).status).toBe('sent');
      await sql`UPDATE pay.withdrawals SET updated_at = now() - interval '25 hours' WHERE client_ref = 'wired'`;
      clock = new Date(clock.getTime() + 61_000);
      const back = await refusal(service.withdraw(request('11', 'after')));
      expect(back.remaining).toEqual({ perTx: '10', rolling24h: '15' });
    });
  });
});
