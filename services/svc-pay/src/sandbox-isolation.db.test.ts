import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import {
  MemoryLedger,
  formatAmount,
  houseFees,
  insuranceFund,
  merchantClearing,
  merchantProceeds,
  railBoundary,
  recipes,
  userAvailable,
  parseAmount as amt,
  type AccountRef,
  type LedgerClient,
} from '@intafaced/ledger-client';
import { PayService } from './payment-service.js';
import { registerPublicPayRest } from './public-rest.js';
import { MemoryRestIdempotencyStore } from './rest-idempotency.js';
import { truncatePayForTest } from './payment-events-test-reset.js';
import { RailRegistry } from './rails/registry.js';
import { CardSandboxAdapter } from './rails/card-sandbox.js';
import { CryptoNativeAdapter } from './rails/crypto-native.js';
import { BankPayoutAbsentAdapter } from './rails/bank-payout.js';
import { MemoryChain } from './rails/chain-port.js';

/**
 * A sandbox key, a test card, and the card-sandbox dispute simulator must not
 * post a live settlement, a live payout, chargebackOpen, or any other recipe
 * against the live book.
 */
const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((name) => name.endsWith('.sql') && !name.endsWith('.down.sql'))
  .sort()
  .map((name) => readFileSync(join(drizzle, name), 'utf8'));

const SECRET = 'svc-pay-sandbox-isolation-secret-32chars';
const EDGE = 'svc-pay-sandbox-isolation-edge-secret-32';
const OWNER = '11111111-1111-4111-8111-111111111111';
const ASSET = 'USDT';

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) {
    const parsed = new URL(envUrl);
    const name = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
    // createTestDatabase refuses an admin connection whose database does not
    // end in _test. The shared lead Postgres is named "test"; intafaced_test
    // is already on that server.
    if (!name.endsWith('_test')) parsed.pathname = '/intafaced_test';
    return { url: parsed.toString(), stop: async () => undefined };
  }
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('intafaced_sandbox_isolation_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

describe('sandbox payments cannot reach the live book', { timeout: 30_000 }, () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let ledger: MemoryLedger;
  let card: CardSandboxAdapter;
  let pay: PayService;

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
    sql = db.sql;
  }, 120_000);

  beforeEach(async () => {
    await truncatePayForTest(
      sql,
      'pay',
      `TRUNCATE pay.checkout_sessions, pay.payment_links, pay.settlements, pay.payment_events, pay.payments, pay.payment_profiles, pay.merchants, pay.withdrawals, pay.deposits RESTART IDENTITY CASCADE`,
    );
    ledger = new MemoryLedger();
    card = new CardSandboxAdapter({ secret: SECRET, toleranceSeconds: 300 });
    const rails = new RailRegistry([
      card,
      new CryptoNativeAdapter({ chain: new MemoryChain(), secret: SECRET, minConfirmations: 6, toleranceSeconds: 300 }),
      new BankPayoutAbsentAdapter(),
    ]);
    pay = new PayService(sql, ledger as LedgerClient, rails, {});
  }, 30_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  const read = async (account: AccountRef) => formatAmount((await ledger.balance(account)).amount);

  async function book(): Promise<Record<string, string>> {
    return {
      clearing: await read(merchantClearing(merchantId, ASSET)),
      proceeds: await read(merchantProceeds(merchantId, ASSET)),
      user: await read(userAvailable(OWNER, ASSET)),
      fees: await read(houseFees('pay', ASSET)),
      insurance: await read(insuranceFund(ASSET)),
      liveRail: await read(railBoundary('crypto-native', ASSET)),
      sandboxRail: await read(railBoundary('card-sandbox', ASSET)),
    };
  }

  let merchantId = '';

  it('refuses settlement, payout, chargebackOpen, and live balance movement', async () => {
    const merchant = await pay.createMerchant({ userId: OWNER, pricing: { feeBps: 0 } });
    merchantId = merchant.id;
    const bounds = { from: new Date(Date.now() - 24 * 3600_000), to: new Date(Date.now() + 24 * 3600_000) };

    await ledger.post(
      recipes.deposit({
        userId: OWNER,
        assetId: ASSET,
        amount: amt('40'),
        rail: 'crypto-native',
        railRef: 'live-seed',
      }),
    );

    const live = await pay.createPayment({
      merchantId: merchant.id,
      amount: amt('100'),
      assetId: ASSET,
      method: 'card',
      railAdapter: 'card-sandbox',
      instrument: { kind: 'card', token: 'tok_ok' },
    });
    await pay.authorize(live.id);
    await pay.capture(live.id);
    expect(await read(merchantClearing(merchant.id, ASSET))).toBe('100');

    await expect(
      pay.settleWindow({ merchantId: merchant.id, window: '2026-10-17', assetId: ASSET, ...bounds, keyEnv: 'sandbox' }),
    ).rejects.toMatchObject({ code: 'pay.sandbox_live_account_refused' });
    expect(await read(merchantProceeds(merchant.id, ASSET))).toBe('0');
    expect(await read(merchantClearing(merchant.id, ASSET))).toBe('100');

    const settled = await pay.settleWindow({ merchantId: merchant.id, window: '2026-10-17', assetId: ASSET, ...bounds });
    expect(settled.status).toBe('posted');
    expect(await read(merchantProceeds(merchant.id, ASSET))).toBe('100');

    const before = await book();

    const sandbox = await pay.createPayment({
      merchantId: merchant.id,
      amount: amt('25'),
      assetId: ASSET,
      method: 'card',
      railAdapter: 'card-sandbox',
      instrument: { kind: 'card', token: 'tok_ok' },
      keyEnv: 'sandbox',
    });
    const authorized = await pay.authorize(sandbox.id);
    await expect(pay.capture(sandbox.id)).rejects.toMatchObject({ code: 'pay.sandbox_live_account_refused' });
    await expect(pay.capture(sandbox.id, { keyEnv: 'sandbox' })).rejects.toMatchObject({
      code: 'pay.sandbox_live_account_refused',
    });
    expect(await ledger.getTxByKey(`payment.capture:${sandbox.id}`)).toBeNull();

    await expect(
      pay.handleWebhook(
        'card-sandbox',
        card.signWebhook({
          id: 'evt_sandbox_dispute',
          type: 'dispute.opened',
          ref: authorized.railRef,
          amount: '25',
          assetId: ASSET,
          disputeId: 'dp_sandbox_1',
          occurredAt: new Date().toISOString(),
        }),
      ),
    ).rejects.toMatchObject({ code: 'pay.sandbox_live_account_refused' });
    expect(await ledger.getTxByKey('pay.chargeback.open:dp_sandbox_1')).toBeNull();

    await expect(
      pay.openChargeback({
        disputeId: 'dp_live_from_sandbox_key',
        paymentId: live.id,
        merchantId: merchant.id,
        amount: '100',
        assetId: ASSET,
        keyEnv: 'sandbox',
      }),
    ).rejects.toMatchObject({ code: 'pay.sandbox_live_account_refused' });
    expect(await ledger.getTxByKey('pay.chargeback.open:dp_live_from_sandbox_key')).toBeNull();

    await expect(pay.refund(live.id, amt('10'), { refundId: 'sandbox-refund', keyEnv: 'sandbox' })).rejects.toMatchObject({
      code: 'pay.sandbox_live_account_refused',
    });
    await expect(pay.payoutSettlement({ settlementId: settled.id, railId: 'crypto-native', keyEnv: 'sandbox' })).rejects.toMatchObject({
      code: 'pay.sandbox_live_account_refused',
    });
    expect((await pay.getSettlement(settled.id)).status).toBe('posted');

    await expect(
      pay.settleWindow({ merchantId: merchant.id, window: '2026-10-18', assetId: ASSET, ...bounds, keyEnv: 'sandbox' }),
    ).rejects.toMatchObject({ code: 'pay.sandbox_live_account_refused' });

    expect(await book()).toEqual(before);

    const http = Fastify({ logger: false });
    await registerPublicPayRest(http, { edgeSecret: EDGE, serviceName: 'svc-pay', pay, idempotency: new MemoryRestIdempotencyStore() });
    const raw = encodePrincipal({
      userId: OWNER,
      sub: OWNER,
      sid: '55555555-5555-4555-8555-555555555555',
      kid: 'sandbox-key',
      key_env: 'sandbox',
      scopes: ['pay:read', 'pay:write', 'pay:refund', 'pay:payout'],
      tier: 'full',
      mfa: false,
      expiresAt: new Date(Date.now() + 60_000),
    } as Principal);
    const headers = {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, EDGE, 'DE'),
      'x-intafaced-region': 'DE',
      'content-type': 'application/json',
    };
    const created = await http.inject({
      method: 'POST',
      url: '/v1/payments',
      headers: { ...headers, 'idempotency-key': 'sandbox-http-create' },
      payload: {
        merchantId: merchant.id,
        amount: '15',
        assetId: ASSET,
        method: 'card',
        railAdapter: 'crypto-native',
        instrument: { kind: 'card', token: 'tok_ok' },
      },
    });
    expect(created.statusCode, created.body).toBe(200);
    expect(created.json().railAdapter).toBe('card-sandbox');
    const httpId = created.json().id as string;
    const httpAuthorized = await http.inject({
      method: 'POST',
      url: `/v1/payments/${httpId}/authorize`,
      headers: { ...headers, 'idempotency-key': 'sandbox-http-authorize' },
      payload: {},
    });
    expect(httpAuthorized.statusCode, httpAuthorized.body).toBe(200);
    const httpCaptured = await http.inject({
      method: 'POST',
      url: `/v1/payments/${httpId}/capture`,
      headers: { ...headers, 'idempotency-key': 'sandbox-http-capture' },
      payload: {},
    });
    expect(httpCaptured.statusCode, httpCaptured.body).toBe(403);
    expect(httpCaptured.json().error.code).toBe('pay.sandbox_live_account_refused');
    expect(await ledger.getTxByKey(`payment.capture:${httpId}`)).toBeNull();
    expect(await book()).toEqual(before);
    await http.close();
  });
});
