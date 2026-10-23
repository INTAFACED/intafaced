import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, postgresAvailable, type TestDatabase } from '@intafaced/db/testing';
import { MemoryLedger, parseAmount } from '@intafaced/ledger-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PayError, PayService } from './payment-service.js';
import { truncatePayForTest } from './payment-events-test-reset.js';
import { CardSandboxAdapter } from './rails/card-sandbox.js';
import { RailRegistry } from './rails/registry.js';

/**
 * M-adv-payments-core-19. A deactivated link shows the stored message.
 * An http confirmation is refused. An embed snippet exists only for a fixed amount.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((name) => name.endsWith('.sql') && !name.endsWith('.down.sql'))
  .sort()
  .map((name) => readFileSync(join(drizzleDir, name), 'utf8'));

const OWNER = '11111111-1111-4111-8111-111111111111';
const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/intafaced_test';
const available = await postgresAvailable(databaseUrl);

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('intafaced_pay_link_share_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

describe.runIf(available)('payment link share', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let pay!: PayService;

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
    sql = db.sql;
  }, 180_000);

  beforeEach(async () => {
    await truncatePayForTest(sql, 'pay', 'TRUNCATE pay.merchants RESTART IDENTITY CASCADE');
    const ledger = new MemoryLedger();
    const rails = new RailRegistry([
      new CardSandboxAdapter({ secret: 'svc-pay-test-secret-at-least-32-characters', toleranceSeconds: 300 }),
    ]);
    pay = new PayService(sql, ledger, rails, {
      checkoutRiskBand: 'low',
      linkDefaultTtlDays: 30,
      linkMaxTtlDays: 365,
      checkoutSessionTtlSeconds: 900,
      maxOpenSessionsPerLink: 25,
      checkoutPublicBasePath: '/api/pay',
    });
  }, 30_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  async function link(amount?: string) {
    const merchant = await pay.createMerchant({ userId: OWNER, pricing: { feeBps: 250 } });
    const created = await pay.createPaymentLink({
      merchantId: merchant.id,
      label: 'Invoice 7',
      ...(amount ? { amount: parseAmount(amount), currency: 'USDT' } : {}),
      maxUses: 1,
    });
    return { merchantId: merchant.id, created };
  }

  it('shows the stored deactivation message and does not replace it on a second call', async () => {
    const { merchantId, created } = await link('12.50');
    expect((await pay.getPaymentLink(merchantId, created.id)).embedSnippet).toContain('data-amount="12.500000000000000000"');
    expect(await pay.deactivatePaymentLink(merchantId, created.id, 'Closed for the day')).toEqual({ deactivated: true });
    expect(await pay.deactivatePaymentLink(merchantId, created.id, 'A later sentence')).toEqual({ deactivated: false });
    expect((await pay.getPaymentLink(merchantId, created.id)).inactiveMessage).toBe('Closed for the day');
    await expect(pay.resolvePaymentLink(created.token)).rejects.toMatchObject({
      code: 'pay.link_inactive',
      message: 'Closed for the day',
    });
  });

  it('refuses an http redirect and stores an https confirmation', async () => {
    const merchant = await pay.createMerchant({ userId: OWNER, pricing: { feeBps: 250 } });
    await expect(
      pay.createPaymentLink({
        merchantId: merchant.id,
        label: 'Invoice 7',
        amount: parseAmount('12.50'),
        currency: 'USDT',
        confirmation: { kind: 'redirect', url: 'http://merchant.example/done' },
      }),
    ).rejects.toBeInstanceOf(PayError);
    await expect(
      pay.createPaymentLink({
        merchantId: merchant.id,
        label: 'Invoice 7',
        amount: parseAmount('12.50'),
        currency: 'USDT',
        confirmation: { kind: 'redirect', url: 'http://merchant.example/done' },
      }),
    ).rejects.toMatchObject({ code: 'pay.link_redirect_not_https' });
    const created = await pay.createPaymentLink({
      merchantId: merchant.id,
      label: 'Invoice 7',
      amount: parseAmount('12.50'),
      currency: 'USDT',
      confirmation: { kind: 'redirect', url: 'https://merchant.example/done' },
    });
    expect(await pay.getPaymentLink(merchant.id, created.id)).toMatchObject({
      confirmationUrl: 'https://merchant.example/done',
      confirmationMessage: null,
    });
    await expect(
      pay.createPaymentLink({
        merchantId: merchant.id,
        label: 'Invoice 7',
        confirmation: { kind: 'message', message: '   ' },
      }),
    ).rejects.toMatchObject({ code: 'pay.link_confirmation_unset' });
  });

  it('does not embed a snippet when the amount is not fixed', async () => {
    const { merchantId, created } = await link();
    expect((await pay.getPaymentLink(merchantId, created.id)).embedSnippet).toBeNull();
  });
});
