/**
 * D26-P1-P6 Done bar — Mandates product-complete; notify gaps honest.
 *
 * Promise: ONE crypto mandate lifecycle is product-complete end-to-end without
 * inventing money or inventing pre-charge delivery; card refuses by name;
 * price change without re-consent refuses on the mounted door; cancel is
 * immediate; bounded dunning stalls with a named reason after MAX_ATTEMPTS.
 * Break: mock ledger invent, card pull invent, notified:true invent, infinite
 * retry, cancel retention delay, silent re-consent.
 * Class: M. Leverage: SubscriptionService + PayService + mandate-product matrix
 * + merchant tRPC doors (Phase A — wire/extend, no second book).
 *
 * H8a PG-hard: this file never `describe.skip` / `postgresAvailable`. CI uses
 * TEST_DATABASE_URL (per-run database via `createTestDatabase` so schema-qualified
 * `pay.*` SQL stays on `pay`). Local without that env starts Testcontainers
 * `postgres:16-alpine`. Docker/PG down is a failed suite, not a green skip.
 * The admin URL is `TEST_DATABASE_URL`, not `TEST_DATABASE_URL_PAY`: creating a
 * database needs CREATEDB, which the per-service roles deliberately lack.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import Fastify from 'fastify';
import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify';
import type { Principal } from '@intafaced/auth';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { createEdgeContext, encodePrincipal, mergeRouters, serviceAuthHeadersForBody, signPrincipalHeader } from '@intafaced/contracts';
import { MemoryLedger, formatAmount, merchantClearing, parseAmount as amt } from '@intafaced/ledger-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { truncatePayForTest } from '../payment-events-test-reset.js';
import { createSubscriptionRouter } from '../subscription-router.js';
import { PayError, PayService } from '../payment-service.js';
import { RailRegistry } from '../rails/registry.js';
import { CardSandboxAdapter } from '../rails/card-sandbox.js';
import { signPayload } from '../rails/webhook-signature.js';
import { registerSubscriptionCycleRoutes } from './internal-cycle-routes.js';
import { MAX_ATTEMPTS_PER_CYCLE } from './charge-cycle.js';
import {
  CARD_MANDATE_CHARGE_SOCKET,
  PRECHARGE_NOTIFY_SOCKET,
  SubscriptionService,
  type SubscriptionInvoiceOpener,
  acknowledgePreChargeNotifyBeforeCharge,
  mandateChargeDisposition,
  subscriptionsProductPosture,
} from './index.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const SECRET = 'svc-pay-subscriptions-done-bar-secret-32chars!!';
const EDGE_SECRET = 'svc-pay-subscriptions-done-bar-edge-secret-32';
const INTERNAL_SECRET = 'svc-pay-subscriptions-done-bar-internal-secret';
const MERCHANT_USER = '11111111-1111-4111-8111-111111111111';
const CUSTOMER = 'cust-done-bar-1';
const utc = (y: number, m: number, d: number, h = 0) => new Date(Date.UTC(y, m - 1, d, h, 0, 0, 0));
const JAN = utc(2026, 1, 1);

const EDGE = createEdgeContext({ secret: EDGE_SECRET, serviceName: 'svc-pay' });

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    sub: MERCHANT_USER,
    userId: MERCHANT_USER,
    sid: '33333333-3333-4333-8333-333333333333',
    scopes: ['pay:read', 'pay:write'],
    tier: 'full',
    mfa: true,
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  } as Principal;
}

function signedHeaders(p: Principal = principal()): Record<string, string> {
  const raw = encodePrincipal(p);
  return {
    'x-intafaced-principal': raw,
    'x-intafaced-principal-sig': signPrincipalHeader(raw, EDGE_SECRET, 'DE'),
    'x-intafaced-region': 'DE',
  };
}

type WireBody = { result?: { data?: unknown }; error?: { message?: string; data?: { code?: string } } };

const H8A_IMAGE = 'postgres:16-alpine';

async function openH8aAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) {
    return { url: envUrl, stop: async () => undefined };
  }

  try {
    const container = await new PostgreSqlContainer(H8A_IMAGE)
      .withDatabase('intafaced_h8a_test')
      .withUsername('intafaced')
      .withPassword('intafaced')
      .start();
    return {
      url: container.getConnectionUri(),
      stop: async () => {
        await container.stop();
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `H8a: svc-pay subscriptions-done-bar is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}

describe('svc-pay subscriptions-done-bar (source)', () => {
  it('H8a money suite is not skip-green (no postgresAvailable / describe.skip)', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bpostgresAvailable\s*\(/);
    expect(src).not.toMatch(/describe\.skip\s*\(/);
    expect(src).not.toMatch(/\bit\.skip\s*\(/);
  });
});

describe('pay.subscriptions Done bar PG-hard', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let ledger: MemoryLedger;
  let card: CardSandboxAdapter;
  let pay: PayService;
  let opened: Array<{ occurrence: number; idempotencyKey: string; paymentId: string }>;
  let failOn: Set<number>;
  /** Controllable clock — internal route refuses body `now` by law. */
  let clock: Date;

  beforeAll(async () => {
    const admin = await openH8aAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
    sql = db.sql;
  }, 120_000);

  beforeEach(async () => {
    if (!db || !sql) throw new Error('H8a: svc-pay subscriptions-done-bar PG was not opened');
    await truncatePayForTest(
      sql,
      'pay',
      `TRUNCATE pay.subscription_executions, pay.subscriptions, pay.subscription_mandates,
               pay.payment_events, pay.payments, pay.merchants
       RESTART IDENTITY CASCADE`,
    );
    ledger = new MemoryLedger();
    card = new CardSandboxAdapter({ secret: SECRET, toleranceSeconds: 300 });
    opened = [];
    failOn = new Set();
    clock = JAN;
  });

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  const opener: SubscriptionInvoiceOpener = async (input) => {
    if (failOn.has(input.occurrence)) {
      throw new PayError(`rail unavailable for occurrence ${input.occurrence}`, 'pay.rail_failed');
    }
    const ack = acknowledgePreChargeNotifyBeforeCharge({
      subscriptionId: input.subscriptionId,
      occurrence: input.occurrence,
      path: 'crypto_invoice',
    });
    expect(ack.notified).toBe(false);
    expect(ack.socket).toBe(PRECHARGE_NOTIFY_SOCKET);

    const payment = await pay.createPayment({
      merchantId: input.merchantId,
      amount: input.amount,
      assetId: input.assetId,
      method: 'card',
      railAdapter: 'card-sandbox',
      instrument: { kind: 'card', token: 'tok_ok' },
      metadata: {
        source: 'subscription',
        subscriptionId: input.subscriptionId,
        occurrence: String(input.occurrence),
        subscriptionCycleKey: input.idempotencyKey,
      },
    });
    opened.push({ occurrence: input.occurrence, idempotencyKey: input.idempotencyKey, paymentId: payment.id });
    return { paymentId: payment.id };
  };

  function build(): { subs: SubscriptionService } {
    let subs: SubscriptionService;
    pay = new PayService(sql, ledger, new RailRegistry([card]), {
      defaultFeeBps: 250,
      afterPaymentEvent: async (event) => {
        if (event.type === 'payment.captured') await subs.markExecutionSettledForPayment(event.payment.id);
      },
    });
    subs = new SubscriptionService(sql, () => clock, opener, {
      defaultFeeBps: 250,
      resolveMerchantFeeBps: async (merchantId) => (await pay.getMerchant(merchantId)).pricing.feeBps,
    });
    return { subs };
  }

  async function settleLanded(paymentId: string): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt++) {
      const rows = await sql<Array<{ status: string }>>`
        SELECT status FROM pay.subscription_executions WHERE payment_id = ${paymentId}
      `;
      if (rows.length === 0 || rows[0]!.status === 'settled') return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`capture watch did not settle ${paymentId}`);
  }

  async function payInvoice(paymentId: string, amount: string): Promise<void> {
    const payment = await pay.authorize(paymentId);
    const body = JSON.stringify({ id: `evt_${paymentId}`, type: 'captured', ref: payment.railRef, amount });
    const timestamp = Math.floor(Date.now() / 1000).toString();
    await pay.handleWebhook('card-sandbox', {
      body,
      headers: {
        'x-sandbox-signature': signPayload(SECRET, timestamp, body),
        'x-sandbox-timestamp': timestamp,
      },
    });
    await settleLanded(paymentId);
  }

  async function clearingOf(merchantId: string): Promise<string> {
    return formatAmount((await ledger.balance(merchantClearing(merchantId, 'USDT'))).amount);
  }

  async function mountDoors(subs: SubscriptionService) {
    const router = mergeRouters(createSubscriptionRouter(subs, pay, null));
    const app = Fastify({ logger: false });
    await app.register(fastifyTRPCPlugin, {
      prefix: '/trpc',
      trpcOptions: {
        router,
        createContext: ({ req }) => EDGE({ headers: req.headers, id: req.id }),
      } satisfies FastifyTRPCPluginOptions<typeof router>['trpcOptions'],
    });
    registerSubscriptionCycleRoutes(app, {
      internalSecret: INTERNAL_SECRET,
      subscriptions: subs,
    });
    await app.ready();
    return app;
  }

  async function post(
    app: Awaited<ReturnType<typeof mountDoors>>,
    path: string,
    input: Record<string, unknown>,
    headers: Record<string, string> = signedHeaders(),
  ): Promise<{ statusCode: number; body: WireBody }> {
    const res = await app.inject({ method: 'POST', url: `/trpc/${path}`, headers, payload: input });
    return { statusCode: res.statusCode, body: res.json() as WireBody };
  }

  async function get(
    app: Awaited<ReturnType<typeof mountDoors>>,
    path: string,
    input?: Record<string, unknown>,
    headers: Record<string, string> = signedHeaders(),
  ): Promise<{ statusCode: number; body: WireBody }> {
    const q = input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`;
    const res = await app.inject({ method: 'GET', url: `/trpc/${path}${q}`, headers });
    return { statusCode: res.statusCode, body: res.json() as WireBody };
  }

  const dueBody = JSON.stringify({ limit: 50 });
  const serviceHeaders = (body: string = dueBody): Record<string, string> => ({
    'content-type': 'application/json',
    ...serviceAuthHeadersForBody('svc-cron', INTERNAL_SECRET, body),
  });

  describe('pay.subscriptions Done bar — crypto E2E + honesty doors', () => {
    it('productReady seals notify gap and card refuse — notified is never true', async () => {
      const { subs } = build();
      const app = await mountDoors(subs);
      const { statusCode, body } = await get(app, 'subscription.productReady');
      expect(statusCode).toBe(200);
      const data = body.result!.data as ReturnType<typeof subscriptionsProductPosture>;
      expect(data.crypto.status).toBe('product_complete');
      expect(data.card).toEqual({
        status: 'refuse_closed',
        code: 'pay.mandate_rail_absent',
        socket: CARD_MANDATE_CHARGE_SOCKET,
      });
      expect(data.preChargeNotify.notified).toBe(false);
      expect(data.preChargeNotify.code).toBe('pay.subscription_notify_unwired');
      expect(data.preChargeNotify.notifyStatus).toBe('skipped_unwired');
      expect(data.preChargeNotify.socket).toBe(PRECHARGE_NOTIFY_SOCKET);
      expect(data.dunning.maxAttemptsPerCycle).toBe(MAX_ATTEMPTS_PER_CYCLE);
      expect(mandateChargeDisposition('card').kind).toBe('refuse');
      await app.close();
    });

    it('ONE crypto lifecycle: create → due → invoice → capture settle → cancel immediate', async () => {
      const { subs } = build();
      const app = await mountDoors(subs);
      const merchant = await pay.createMerchant({ userId: MERCHANT_USER, pricing: { feeBps: 250 } });

      const createdMandate = await post(app, 'mandate.create', {
        merchantId: merchant.id,
        customerId: CUSTOMER,
        assetId: 'USDT',
        amount: '25.00',
        cadence: 'monthly',
        startsAt: JAN.toISOString(),
      });
      expect(createdMandate.statusCode).toBe(200);
      const mandate = createdMandate.body.result!.data as { id: string; status: string; amount: string };
      expect(mandate.status).toBe('active');
      expect(mandate.amount).toBe('25');

      const createdSub = await post(app, 'subscription.create', {
        mandateId: mandate.id,
        path: 'crypto_invoice',
      });
      expect(createdSub.statusCode).toBe(200);
      const sub = createdSub.body.result!.data as { id: string; path: string; status: string };
      expect(sub.path).toBe('crypto_invoice');
      expect(sub.status).toBe('active');

      clock = JAN;
      const fire = await app.inject({
        method: 'POST',
        url: '/internal/jobs/run-due-subscriptions',
        headers: serviceHeaders(),
        payload: dueBody,
      });
      expect(fire.statusCode).toBe(200);
      const fireBody = fire.json() as {
        fired: number;
        outcomes: Array<{ outcome: string; noticeCode?: string; rejectionCode?: string }>;
      };
      expect(fireBody.fired).toBe(1);
      expect(fireBody.outcomes[0]!.outcome).toBe('invoiced');
      expect(fireBody.outcomes[0]!.noticeCode).toBe('pay.subscription_notify_unwired');
      expect(fireBody.outcomes[0]!.rejectionCode).toBeUndefined();
      expect(opened).toHaveLength(1);

      const cyclesBefore = await get(app, 'subscription.cycles', { subscriptionId: sub.id, limit: 50 });
      const cycleRow = (cyclesBefore.body.result!.data as { cycles: Array<{ status: string; paymentId: string | null }> }).cycles[0]!;
      expect(cycleRow.status).toBe('invoiced');
      expect(cycleRow.paymentId).toBe(opened[0]!.paymentId);

      await payInvoice(opened[0]!.paymentId, '25');
      const cyclesAfter = await get(app, 'subscription.cycles', { subscriptionId: sub.id, limit: 50 });
      expect((cyclesAfter.body.result!.data as { cycles: Array<{ status: string }> }).cycles[0]!.status).toBe('settled');
      expect(await clearingOf(merchant.id)).toBe('25');

      const cancelSub = await post(app, 'subscription.cancel', { subscriptionId: sub.id });
      expect(cancelSub.statusCode).toBe(200);
      expect((cancelSub.body.result!.data as { status: string }).status).toBe('cancelled');

      const cancelMandate = await post(app, 'mandate.cancel', { mandateId: mandate.id });
      expect(cancelMandate.statusCode).toBe(200);
      expect((cancelMandate.body.result!.data as { status: string }).status).toBe('cancelled');

      // Immediate — no retention: a later due pass does not reopen money.
      opened.length = 0;
      clock = utc(2026, 2, 1);
      await app.inject({
        method: 'POST',
        url: '/internal/jobs/run-due-subscriptions',
        headers: serviceHeaders(),
        payload: dueBody,
      });
      expect(opened).toHaveLength(0);

      await app.close();
    });

    it('price/terms change without re-consent is refused on the public door', async () => {
      const { subs } = build();
      const app = await mountDoors(subs);
      const merchant = await pay.createMerchant({ userId: MERCHANT_USER, pricing: { feeBps: 250 } });
      const mandate = await subs.createMandate({
        merchantId: merchant.id,
        customerId: CUSTOMER,
        assetId: 'USDT',
        amount: amt('10'),
        ceiling: null,
        cadence: 'monthly',
        startsAt: JAN,
        endsAt: null,
      });

      const res = await post(app, 'mandate.proposeTerms', {
        mandateId: mandate.id,
        amount: '11',
      });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(JSON.stringify(res.body)).toMatch(/pay\.subscription_reconsent_required/);
      await app.close();
    });

    it('card path refuses pay.mandate_rail_absent — no invent charge-against-mandate', async () => {
      const { subs } = build();
      const app = await mountDoors(subs);
      const merchant = await pay.createMerchant({ userId: MERCHANT_USER, pricing: { feeBps: 250 } });
      const mandate = await subs.createMandate({
        merchantId: merchant.id,
        customerId: CUSTOMER,
        assetId: 'USDT',
        amount: amt('10'),
        ceiling: null,
        cadence: 'monthly',
        startsAt: JAN,
        endsAt: null,
        railAdapter: 'card',
      });
      const sub = await subs.createSubscription({ mandateId: mandate.id, path: 'card' });

      clock = JAN;
      const fire = await app.inject({
        method: 'POST',
        url: '/internal/jobs/run-due-subscriptions',
        headers: serviceHeaders(),
        payload: dueBody,
      });
      expect(fire.statusCode).toBe(200);
      const body = fire.json() as { outcomes: Array<{ outcome: string; rejectionCode?: string }> };
      expect(body.outcomes[0]!.outcome).toBe('rejected');
      expect(body.outcomes[0]!.rejectionCode).toBe('pay.mandate_rail_absent');
      expect(opened).toHaveLength(0);

      const cycles = await subs.listCycles(sub.id, { limit: 50 });
      expect(cycles[0]!.rejectionCode).toBe('pay.mandate_rail_absent');
      await app.close();
    });

    it('bounded dunning on crypto: MAX_ATTEMPTS then named arrears stall (fire path)', async () => {
      const { subs } = build();
      const merchant = await pay.createMerchant({ userId: MERCHANT_USER, pricing: { feeBps: 250 } });
      const mandate = await subs.createMandate({
        merchantId: merchant.id,
        customerId: CUSTOMER,
        assetId: 'USDT',
        amount: amt('10'),
        ceiling: null,
        cadence: 'monthly',
        startsAt: JAN,
        endsAt: null,
      });
      const sub = await subs.createSubscription({ mandateId: mandate.id, path: 'crypto_invoice' });

      failOn.add(0);
      for (const day of [1, 10, 20, 25]) {
        clock = utc(2026, 1, day);
        await subs.runDueSubscriptions({ limit: 50, now: clock });
      }

      const cycles = await subs.listCycles(sub.id, { limit: 50 });
      expect(cycles).toHaveLength(1);
      expect(cycles[0]!.attemptCount).toBe(MAX_ATTEMPTS_PER_CYCLE);
      expect(cycles[0]!.exhaustedAt).not.toBeNull();

      const stalled = await subs.getSubscription(sub.id);
      expect(stalled.status).toBe('paused');
      expect(stalled.stallReason).toBe('arrears');
      expect(opened).toHaveLength(0);
      expect(await clearingOf(merchant.id)).toBe('0');
    });
  });
});
