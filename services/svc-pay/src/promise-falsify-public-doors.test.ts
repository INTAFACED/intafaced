/**
 * Unit card (D26-P2-01b):
 * Promise: settle / mandate / dispute / grant refuse invent through mounted
 *   Fastify+tRPC public doors (edge-signed createEdgeContext) — not unit-only
 *   service stubs behind createCaller alone.
 * Break: settleWindow could invent a zero fee when pricing is blank; a card
 *   mandate fire could invent a rail; dispute/chargeback could silently reverse
 *   money; submerchant grant could invent self/lateral areas or invent pay:*
 *   onto a user session.
 * Done bar:
 *   · settlement.run with unpublished fee → wire refuse
 *     pay.fee_bps_unset; settleWindow not invented at zero.
 *   · mandate.create / subscription.create / cycle fire refuse inactive,
 *     reconsent, fee_unpublished, and pay.mandate_rail_absent by code on the
 *     mounted path.
 *   · dispute **case** procedures may exist (D26-P1-P5); merchant REST still
 *     has no reverse-money dispute door. Chargeback posts go through chargeback-ledger.ts.
 *   · submerchantPermission.grant refuses self / lateral / unknown area over
 *     the wire; pay:* remains WITHHELD_FROM_SESSION (no invent grant).
 * Class: N (honesty) / M surface (no invent fees or reverse-money). Leverage:
 *   mergeRouters + createEdgeContext + registerSubscriptionCycleRoutes
 *   (Phase A shell doors — wire honesty, do not rebuild pay).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify';
import type { Principal } from '@intafaced/auth';
import { WITHHELD_FROM_SESSION } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, mergeRouters, serviceAuthHeadersForBody, signPrincipalHeader } from '@intafaced/contracts';
import { parseAmount as amt } from '@intafaced/ledger-client';
import { createPayRouter } from './router.js';
import { createSubscriptionRouter } from './subscription-router.js';
import { createSubMerchantRouter } from './submerchant-router.js';
import { PayError, type PayService } from './payment-service.js';
import { SubMerchantError, type SubMerchantService } from './submerchants.js';
import type { SubscriptionService } from './subscriptions/subscription-service.js';
import { registerSubscriptionCycleRoutes } from './subscriptions/internal-cycle-routes.js';
import type { UserMoneyService } from './user-money-service.js';
import { RailRegistry } from './rails/registry.js';
import { CardSandboxAdapter } from './rails/card-sandbox.js';
import { payServiceSource } from './payment-service/source.testkit.js';

const EDGE_SECRET = 'pay-promise-falsify-public-doors-edge-secret-32';
const INTERNAL_SECRET = 'pay-promise-falsify-public-doors-internal-secret';
const USER = '11111111-1111-4111-8111-111111111111';
const STRANGER = '22222222-2222-4222-8222-222222222222';
const MERCHANT = '55555555-5555-4555-8555-555555555555';
const OTHER_MERCHANT = '66666666-6666-4666-8666-666666666666';
const SUB_MERCHANT = '77777777-7777-4777-8777-777777777777';
const MANDATE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SUB = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SETTLEMENT = '33333333-3333-4333-8333-333333333333';

const here = dirname(fileURLToPath(import.meta.url));
const edgeContext = createEdgeContext({ secret: EDGE_SECRET, serviceName: 'svc-pay' });
const rails = new RailRegistry([new CardSandboxAdapter({ secret: 'pay-promise-falsify-rail-sandbox-secret-32b', toleranceSeconds: 300 })]);

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    sub: USER,
    userId: USER,
    sid: '44444444-4444-4444-8444-444444444444',
    scopes: ['pay:read', 'pay:write', 'pay:payout'],
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

type WireBody = {
  result?: { data?: unknown };
  error?: { message?: string; data?: { code?: string } };
};

function mandateRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: MANDATE,
    merchantId: MERCHANT,
    customerId: 'cust-1',
    assetId: 'USDT',
    amount: amt('10'),
    ceiling: null,
    cadence: 'monthly' as const,
    startsAt: new Date('2026-01-01T00:00:00.000Z'),
    endsAt: null,
    railAdapter: 'card',
    railMandateRef: null,
    status: 'active' as const,
    cancelledAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function subRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: SUB,
    mandateId: MANDATE,
    merchantId: MERCHANT,
    customerId: 'cust-1',
    nextRunAt: new Date('2026-01-01T00:00:00.000Z'),
    status: 'active' as const,
    cancelledAt: null,
    path: 'card',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    anchorAt: null,
    anchorOccurrence: 0,
    pausedAt: null,
    resumedAt: null,
    stalledAt: null,
    stallReason: null,
    ...overrides,
  };
}

interface PayStubs {
  settleWindow?: ReturnType<typeof vi.fn>;
  getSettlement?: ReturnType<typeof vi.fn>;
  getMerchant?: ReturnType<typeof vi.fn>;
  getMerchantByUserId?: ReturnType<typeof vi.fn>;
  openCheckoutSession?: ReturnType<typeof vi.fn>;
}

interface SubStubs {
  createMandate?: ReturnType<typeof vi.fn>;
  getMandate?: ReturnType<typeof vi.fn>;
  createSubscription?: ReturnType<typeof vi.fn>;
  getSubscription?: ReturnType<typeof vi.fn>;
  grantPermission?: ReturnType<typeof vi.fn>;
  runDueSubscriptions?: ReturnType<typeof vi.fn>;
}

/**
 * Mount the same three merchant surfaces `index.ts` merges — pay + payfac +
 * subscriptions — behind real edge context. Stubs prove refuse codes cross the
 * wire without inventing fees, rails, disputes, or grants.
 */
async function mountDoors(opts: { pay?: PayStubs; subs?: SubStubs; trees?: SubMerchantService | null } = {}) {
  const settleWindow =
    opts.pay?.settleWindow ??
    vi.fn(async (_input: { merchantId: string; window: string; assetId: string }) => {
      throw new PayError('PAY_DEFAULT_FEE_BPS is unset — refusing rather than settling at 0 bps', 'pay.fee_bps_unset');
    });
  const getSettlement =
    opts.pay?.getSettlement ??
    vi.fn(async (_settlementId: string) => {
      throw new PayError(`Settlement ${SETTLEMENT} not found`, 'pay.settlement_not_found');
    });
  const getMerchant =
    opts.pay?.getMerchant ??
    vi.fn(async (id: string) => {
      if (id !== MERCHANT) throw new PayError('nf', 'pay.merchant_not_found');
      return { id: MERCHANT, userId: USER, status: 'active', pricing: {} } as never;
    });
  const getMerchantByUserId =
    opts.pay?.getMerchantByUserId ?? vi.fn(async (userId: string) => (userId === USER ? ({ id: MERCHANT } as never) : null));
  const openCheckoutSession =
    opts.pay?.openCheckoutSession ??
    vi.fn(async () => {
      throw new PayError('checkout not exercised in this test', 'pay.checkout_session_not_found');
    });

  const pay = {
    settleWindow,
    getSettlement,
    getMerchant,
    getMerchantByUserId,
    openCheckoutSession,
    getCheckoutSession: async () => {
      throw new PayError('checkout not exercised in this test', 'pay.checkout_session_not_found');
    },
    listSettlements: async () => ({ items: [], nextCursor: null }),
    releasePendingSettlement: async () => {
      throw new PayError('not pending', 'pay.settlement_not_pending');
    },
    payoutSettlement: async () => {
      throw new PayError('no payout', 'pay.rail_failed');
    },
  } as unknown as PayService;

  const money = {
    listWithdrawals: async () => [],
    availableBalance: async () => 0n,
  } as unknown as UserMoneyService;

  const createMandate =
    opts.subs?.createMandate ??
    vi.fn(async () => {
      throw new PayError('Mandate inactive', 'pay.mandate_inactive');
    });
  const getMandate = opts.subs?.getMandate ?? vi.fn(async () => mandateRecord());
  const createSubscription =
    opts.subs?.createSubscription ??
    vi.fn(async () => {
      throw new PayError('Mandate inactive', 'pay.mandate_inactive');
    });
  const getSubscription = opts.subs?.getSubscription ?? vi.fn(async () => subRecord());

  const subscriptions = {
    createMandate,
    getMandate,
    listMandates: async () => [],
    cancelMandate: async () => mandateRecord({ status: 'cancelled' }),
    createSubscription,
    getSubscription,
    listSubscriptions: async () => [],
    listExecutions: async () => [],
    cancelSubscription: async () => subRecord({ status: 'cancelled' }),
    pauseSubscription: async () => subRecord({ status: 'paused', stallReason: 'operator_pause' }),
    resumeSubscription: async () => ({
      subscription: subRecord(),
      projectedEnd: new Date('2026-12-01T00:00:00.000Z'),
    }),
    listCycles: async () => [],
    runDueSubscriptions:
      opts.subs?.runDueSubscriptions ??
      vi.fn(async () => ({
        examined: 1,
        fired: 0,
        retried: 0,
        stalled: 0,
        outcomes: [{ outcome: 'rejected', rejectionCode: 'pay.mandate_rail_absent' }],
      })),
  } as unknown as SubscriptionService;

  const grantPermission =
    opts.subs?.grantPermission ??
    vi.fn(async () => {
      throw new SubMerchantError(
        'A merchant already holds every area over its own node; a grant to itself would be a row that can be revoked without taking anything away.',
        'pay.submerchant_grant_self',
      );
    });

  const trees =
    opts.trees ??
    ({
      grantPermission,
      revokePermission: async () => {
        throw new Error('not exercised');
      },
      listPermissions: async () => [],
      permissionHistory: async () => [],
      createSubMerchant: async () => {
        throw new Error('not exercised');
      },
      listSubMerchants: async () => [],
      getSubMerchant: async () => {
        throw new Error('not exercised');
      },
      hasPermission: async () => true,
    } as unknown as SubMerchantService);

  const router = mergeRouters(
    createPayRouter(pay, rails, money, null),
    createSubMerchantRouter(trees, pay),
    createSubscriptionRouter(subscriptions, pay, null),
  );

  const app = Fastify({ logger: false });
  await app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: {
      router,
      createContext: ({ req }) => edgeContext(req),
    } satisfies FastifyTRPCPluginOptions<typeof router>['trpcOptions'],
  });
  registerSubscriptionCycleRoutes(app, {
    internalSecret: INTERNAL_SECRET,
    subscriptions,
  });
  await app.ready();

  return {
    app,
    settleWindow,
    createMandate,
    createSubscription,
    grantPermission,
    getMandate,
    getSubscription,
    runDue: subscriptions.runDueSubscriptions as ReturnType<typeof vi.fn>,
  };
}

async function post(
  app: Awaited<ReturnType<typeof mountDoors>>['app'],
  path: string,
  input: Record<string, unknown>,
  headers: Record<string, string> = signedHeaders(),
): Promise<{ statusCode: number; body: WireBody }> {
  const res = await app.inject({ method: 'POST', url: `/trpc/${path}`, headers, payload: input });
  return { statusCode: res.statusCode, body: res.json() as WireBody };
}

describe('D26-P2-01b refuse-closed defaults (no invent)', () => {
  it('pay:* scopes stay WITHHELD_FROM_SESSION — agents cannot invent a session grant', () => {
    expect(WITHHELD_FROM_SESSION['pay:read']).toMatch(/merchant onboarding/i);
    expect(WITHHELD_FROM_SESSION['pay:write']).toMatch(/merchant onboarding/i);
    expect(WITHHELD_FROM_SESSION['pay:refund']).toMatch(/refund/i);
    expect(WITHHELD_FROM_SESSION['pay:payout']).toMatch(/step-up/i);
  });

  it('chargeback recipes remain OWNER SIGN-OFF / NOT WIRED — no invent reverse-money', () => {
    const recipe = readFileSync(join(here, '../../../packages/ledger-client/src/recipes/chargeback.ts'), 'utf8');
    expect(recipe).toMatch(/OWNER SIGN-OFF REQUIRED/);
    expect(recipe).toMatch(/NOT WIRED/);
  });
});

describe('D26-P2-01b public doors — settle refuse invent fees', () => {
  it('settlement.run refuses unpublished fee over the wire (no invent zero)', async () => {
    const { app, settleWindow } = await mountDoors();

    const { statusCode, body } = await post(app, 'settlement.run', {
      merchantId: MERCHANT,
      window: 'w-nofee',
      assetId: 'USDT',
    });

    expect(statusCode).toBe(412);
    expect(body.error!.message).toMatch(/pay\.fee_bps_unset/);
    expect(settleWindow).toHaveBeenCalledWith({
      merchantId: MERCHANT,
      window: 'w-nofee',
      assetId: 'USDT',
    });
    await app.close();
  });

  it('anonymous settlement.run never reaches settleWindow', async () => {
    const settleWindow = vi.fn();
    const { app } = await mountDoors({ pay: { settleWindow } });

    const { statusCode } = await post(
      app,
      'settlement.run',
      { merchantId: MERCHANT, window: 'w-anon', assetId: 'USDT' },
      { 'x-intafaced-region': 'DE' },
    );

    expect(statusCode).toBe(401);
    expect(settleWindow).not.toHaveBeenCalled();
    await app.close();
  });

  it('a stranger cannot settle another merchant — ownership gate before invent', async () => {
    const settleWindow = vi.fn();
    const { app } = await mountDoors({ pay: { settleWindow } });

    const { statusCode } = await post(
      app,
      'settlement.run',
      { merchantId: MERCHANT, window: 'w-stranger', assetId: 'USDT' },
      signedHeaders(principal({ sub: STRANGER, userId: STRANGER })),
    );

    expect(statusCode).toBe(404);
    expect(settleWindow).not.toHaveBeenCalled();
    await app.close();
  });

  it('settlement.run that would consume the whole window refuses fee_exceeds_gross on the door', async () => {
    const settleWindow = vi.fn(async () => {
      throw new PayError('Fee consumes the whole window', 'pay.fee_exceeds_gross');
    });
    const { app } = await mountDoors({ pay: { settleWindow } });

    const { statusCode, body } = await post(app, 'settlement.run', {
      merchantId: MERCHANT,
      window: 'w-allfee',
      assetId: 'USDT',
    });

    expect(statusCode).toBe(400);
    expect(body.error!.message).toMatch(/pay\.fee_exceeds_gross/);
    await app.close();
  });
});

describe('D26-P2-01b public doors — mandate refuse invent rails / rates', () => {
  it('mandate.create refuses inactive mandate state over the wire', async () => {
    const createMandate = vi.fn(async () => {
      throw new PayError('Mandate is cancelled', 'pay.mandate_inactive');
    });
    const { app } = await mountDoors({ subs: { createMandate } });

    const { statusCode, body } = await post(app, 'mandate.create', {
      merchantId: MERCHANT,
      customerId: 'cust-1',
      assetId: 'USDT',
      amount: '10',
      cadence: 'monthly',
      startsAt: '2026-01-01T00:00:00.000Z',
      railAdapter: 'card',
    });

    expect(statusCode).toBe(409);
    expect(body.error!.message).toMatch(/pay\.mandate_inactive/);
    expect(createMandate).toHaveBeenCalled();
    await app.close();
  });

  it('subscription.create on an inactive mandate refuses over the wire', async () => {
    const createSubscription = vi.fn(async () => {
      throw new PayError(`Mandate ${MANDATE} is cancelled`, 'pay.mandate_inactive');
    });
    const { app } = await mountDoors({
      subs: {
        getMandate: vi.fn(async () => mandateRecord({ status: 'cancelled' })),
        createSubscription,
      },
    });

    const { statusCode, body } = await post(app, 'subscription.create', {
      mandateId: MANDATE,
      path: 'card_mandate',
    });

    expect(statusCode).toBe(409);
    expect(body.error!.message).toMatch(/pay\.mandate_inactive/);
    await app.close();
  });

  it('subscription.resume that needs re-consent refuses rather than inventing a higher mandate', async () => {
    const resumeSubscription = vi.fn(async () => {
      throw new PayError('would run past the mandate window', 'pay.subscription_resume_exceeds_mandate');
    });
    const pay = {
      getMerchant: async (id: string) => {
        if (id !== MERCHANT) throw new PayError('nf', 'pay.merchant_not_found');
        return { id: MERCHANT, userId: USER } as never;
      },
      getMerchantByUserId: async (userId: string) => (userId === USER ? ({ id: MERCHANT } as never) : null),
    } as unknown as PayService;
    const subscriptions = {
      getSubscription: async () => subRecord({ status: 'paused', stallReason: 'operator_pause' }),
      resumeSubscription,
      createMandate: async () => mandateRecord(),
      getMandate: async () => mandateRecord(),
      listMandates: async () => [],
      cancelMandate: async () => mandateRecord({ status: 'cancelled' }),
      createSubscription: async () => subRecord(),
      listSubscriptions: async () => [],
      listExecutions: async () => [],
      cancelSubscription: async () => subRecord({ status: 'cancelled' }),
      pauseSubscription: async () => subRecord({ status: 'paused' }),
      listCycles: async () => [],
      runDueSubscriptions: async () => ({ examined: 0, fired: 0, retried: 0, stalled: 0, outcomes: [] }),
    } as unknown as SubscriptionService;

    const router = mergeRouters(createSubscriptionRouter(subscriptions, pay, null));
    const app = Fastify({ logger: false });
    await app.register(fastifyTRPCPlugin, {
      prefix: '/trpc',
      trpcOptions: {
        router,
        createContext: ({ req }) => edgeContext(req),
      } satisfies FastifyTRPCPluginOptions<typeof router>['trpcOptions'],
    });
    await app.ready();

    const { statusCode, body } = await post(app, 'subscription.resume', { subscriptionId: SUB });
    expect(statusCode).toBe(409);
    expect(body.error!.message).toMatch(/pay\.subscription_resume_exceeds_mandate/);
    expect(resumeSubscription).toHaveBeenCalledWith(SUB);
    await app.close();
  });

  it('unpublished subscription fee refuses over the wire rather than charging at invent-zero', async () => {
    const pauseSubscription = vi.fn(async () => {
      throw new PayError('no rate published', 'pay.subscription_fee_unpublished');
    });
    const pay = {
      getMerchant: async (id: string) => {
        if (id !== MERCHANT) throw new PayError('nf', 'pay.merchant_not_found');
        return { id: MERCHANT, userId: USER } as never;
      },
      getMerchantByUserId: async (userId: string) => (userId === USER ? ({ id: MERCHANT } as never) : null),
    } as unknown as PayService;
    const subscriptions = {
      getSubscription: async () => subRecord(),
      pauseSubscription,
      createMandate: async () => mandateRecord(),
      getMandate: async () => mandateRecord(),
      listMandates: async () => [],
      cancelMandate: async () => mandateRecord({ status: 'cancelled' }),
      createSubscription: async () => subRecord(),
      listSubscriptions: async () => [],
      listExecutions: async () => [],
      cancelSubscription: async () => subRecord({ status: 'cancelled' }),
      resumeSubscription: async () => ({
        subscription: subRecord(),
        projectedEnd: new Date('2026-12-01T00:00:00.000Z'),
      }),
      listCycles: async () => [],
      runDueSubscriptions: async () => ({ examined: 0, fired: 0, retried: 0, stalled: 0, outcomes: [] }),
    } as unknown as SubscriptionService;

    const router = mergeRouters(createSubscriptionRouter(subscriptions, pay, null));
    const app = Fastify({ logger: false });
    await app.register(fastifyTRPCPlugin, {
      prefix: '/trpc',
      trpcOptions: {
        router,
        createContext: ({ req }) => edgeContext(req),
      } satisfies FastifyTRPCPluginOptions<typeof router>['trpcOptions'],
    });
    await app.ready();

    const { statusCode, body } = await post(app, 'subscription.pause', { subscriptionId: SUB });
    expect(statusCode).toBe(403);
    expect(body.error!.message).toMatch(/pay\.subscription_fee_unpublished/);
    await app.close();
  });

  it('cycle runner reports pay.mandate_rail_absent — no invent card-mandate rail', async () => {
    const runDueSubscriptions = vi.fn(async () => ({
      examined: 1,
      fired: 0,
      retried: 0,
      stalled: 0,
      outcomes: [{ outcome: 'rejected' as const, rejectionCode: 'pay.mandate_rail_absent' }],
    }));
    const { app, runDue } = await mountDoors({ subs: { runDueSubscriptions } });

    const payload = JSON.stringify({ limit: 50 });
    const res = await app.inject({
      method: 'POST',
      url: '/internal/jobs/run-due-subscriptions',
      headers: { 'content-type': 'application/json', ...serviceAuthHeadersForBody('svc-cron', INTERNAL_SECRET, payload) },
      payload,
    });

    expect(res.statusCode).toBe(200);
    expect(runDue).toHaveBeenCalledWith({ limit: 50 });
    expect(res.json().outcomes[0].rejectionCode).toBe('pay.mandate_rail_absent');
    await app.close();
  });
});

describe('D26-P2-01b public doors — dispute refuse invent reverse-money', () => {
  it('dispute case doors exist; merchant REST has no reverse-money chargeback door', () => {
    const routerSrc = readFileSync(join(here, 'router.ts'), 'utf8');
    const restSrc = readFileSync(join(here, 'public-rest.ts'), 'utf8');
    const paySrc = payServiceSource();

    expect(routerSrc).toMatch(/openDispute|contestDispute|getDispute/);
    expect(routerSrc).not.toMatch(/recipes\.chargeback/);
    // Merchant public REST still has no dispute / chargeback reverse-money door.
    expect(restSrc).not.toMatch(/\/dispute|chargeback/i);
    expect(paySrc).not.toMatch(/recipes\.chargeback/);
    expect(paySrc).toMatch(/postDisputeWon/);
    expect(paySrc).toMatch(/postDisputeShortfall/);
  });

  it('payment status disputed is case-reachable; merchant REST has no reverse-money dispute door', () => {
    const schema = readFileSync(join(here, 'db/schema.ts'), 'utf8');
    // Schema declares the status; honesty requires the case-only / NOT WIRED banner.
    expect(schema).toMatch(/disputed/);
    expect(schema).toMatch(/NOT WIRED|OWNER SIGN-OFF|case/i);

    const rest = readFileSync(join(here, 'public-rest.ts'), 'utf8');
    // Merchant REST mutates: create / authorize / capture / refund only.
    expect(rest).toMatch(/payments\/:id\/authorize/);
    expect(rest).toMatch(/payments\/:id\/capture/);
    expect(rest).toMatch(/payments\/:id\/refund/);
    expect(rest).not.toMatch(/payments\/:id\/dispute/);
  });

  it('mounted settlement surface cannot be used to invent a dispute status flip', async () => {
    const { app, settleWindow } = await mountDoors();
    // Settlement door runs settleWindow only — never a dispute transition.
    await post(app, 'settlement.run', {
      merchantId: MERCHANT,
      window: 'w-chargeback-probe',
      assetId: 'USDT',
    });
    expect(settleWindow).toHaveBeenCalledWith({
      merchantId: MERCHANT,
      window: 'w-chargeback-probe',
      assetId: 'USDT',
    });
    // settleWindow args are merchant/window/asset only — no status / dispute fields.
    const first = settleWindow.mock.calls.at(0);
    expect(first).toBeDefined();
    const args = first![0] as Record<string, unknown>;
    expect(Object.keys(args).sort()).toEqual(['assetId', 'merchantId', 'window']);
    expect(args).not.toHaveProperty('status');
    expect(args).not.toHaveProperty('disputeId');
    await app.close();
  });
});

describe('D26-P2-01b public doors — grant refuse invent authority', () => {
  it('submerchantPermission.grant stays closed until the named account consents', async () => {
    const grantPermission = vi.fn(async (input: { actorMerchantId: string }) => {
      void input;
      throw new SubMerchantError('A merchant already holds every area over its own node', 'pay.submerchant_grant_self');
    });
    const { app } = await mountDoors({ subs: { grantPermission } });

    const { statusCode, body } = await post(app, 'submerchantPermission.grant', {
      granteeMerchantId: MERCHANT,
      subjectMerchantId: MERCHANT,
      area: 'payment',
      reason: 'self grant probe must refuse',
    });

    expect(statusCode).toBe(403);
    expect(body.error!.message).toMatch(/pay\.submerchant_consent_required/);
    expect(grantPermission).not.toHaveBeenCalled();
    await app.close();
  });

  it('submerchantPermission.grant does not reach a lateral journal write', async () => {
    const grantPermission = vi.fn(async () => {
      throw new SubMerchantError('Authority does not flow sideways between siblings', 'pay.submerchant_grant_lateral');
    });
    const { app } = await mountDoors({ subs: { grantPermission } });

    const { statusCode, body } = await post(app, 'submerchantPermission.grant', {
      granteeMerchantId: OTHER_MERCHANT,
      subjectMerchantId: SUB_MERCHANT,
      area: 'settlement.payout',
      reason: 'lateral invent probe must refuse',
    });

    expect(statusCode).toBe(403);
    expect(body.error!.message).toMatch(/pay\.submerchant_consent_required/);
    expect(grantPermission).not.toHaveBeenCalled();
    await app.close();
  });

  it('unknown permission area is refused at the schema before the service invents one', async () => {
    const grantPermission = vi.fn();
    const { app } = await mountDoors({ subs: { grantPermission } });

    const { statusCode } = await post(app, 'submerchantPermission.grant', {
      granteeMerchantId: OTHER_MERCHANT,
      subjectMerchantId: SUB_MERCHANT,
      area: 'everything',
      reason: 'invent an area that does not exist',
    });

    expect(statusCode).toBe(400);
    expect(grantPermission).not.toHaveBeenCalled();
    await app.close();
  });

  it('forged principal cannot invent a grant — unsigned header never reaches grantPermission', async () => {
    const grantPermission = vi.fn();
    const { app } = await mountDoors({ subs: { grantPermission } });
    const raw = encodePrincipal(principal({ scopes: ['pay:write', 'admin:treasury'] }));

    const { statusCode } = await post(
      app,
      'submerchantPermission.grant',
      {
        granteeMerchantId: OTHER_MERCHANT,
        subjectMerchantId: SUB_MERCHANT,
        area: 'payment',
        reason: 'forged principal grant probe',
      },
      { 'x-intafaced-principal': raw, 'x-intafaced-region': 'DE' },
    );

    expect(statusCode).toBe(401);
    expect(grantPermission).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('D28 public doors — live-only KYB money gate on checkout.open', () => {
  it('checkout.open refuses pay.kyb_required over the wire (no invent hosted session)', async () => {
    const openCheckoutSession = vi.fn(async () => {
      throw new PayError(`Merchant ${MERCHANT} KYB is none; live acquiring requires approved KYB`, 'pay.kyb_required');
    });
    const { app } = await mountDoors({ pay: { openCheckoutSession } });

    const { statusCode, body } = await post(
      app,
      'checkout.open',
      { token: 'link-token-abc12345', geoCountry: 'DE' },
      { 'x-intafaced-region': 'DE' },
    );

    expect(statusCode).toBe(403);
    expect(body.error!.message).toMatch(/pay\.kyb_required/);
    expect(openCheckoutSession).toHaveBeenCalledWith({
      linkToken: 'link-token-abc12345',
      amount: undefined,
      assetId: undefined,
      geoCountry: 'DE',
      method: undefined,
    });
    await app.close();
  });
});
