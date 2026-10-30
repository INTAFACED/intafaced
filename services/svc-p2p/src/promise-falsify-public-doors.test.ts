/**
 * Unit card (D26-P2-01f):
 * Promise: escrow / dispute / fee integrity hold through mounted Fastify+tRPC
 *   public doors (edge-signed createEdgeContext) — not unit-only
 *   assertReleasePostable / bare P2pService.createCaller theater.
 * Break: trades.take could invent feeBps=0 on the wire; dust+fee could lock
 *   then strand release forever; cancel could skim a fee; disputes.resolve
 *   could run from an API key / empty moderation / party session; disputed
 *   escrow could auto-refund on a timer; a stranger could confirmReceived.
 * Done bar:
 *   · trades.take wire schema has no feeBps; dust take with feeBps>0 refuses
 *     p2p.release_unpostable before any lock over /trpc.
 *   · confirmReceived splits house fee via ledger recipes; cancel refunds
 *     full (no fee); stranger confirm/cancel never reaches settle.
 *   · disputes.resolve refuses unconfigured / non-moderator / kid API key
 *     before resolveDispute; open discloses escalated_and_held.
 *   · GET /internal/escrow-integrity requires service auth; ok after paths.
 * Class: N (honesty) / M surface (no invent fees, no machine ruling). Leverage:
 *   createP2pRouter + MemoryLedger + existing escrow recipes (Phase A shell).
 *
 * H8a PG-hard: this file never `describe.skip` / `postgresAvailable`. CI uses
 * TEST_DATABASE_URL (per-run database via `createTestDatabase` so schema-qualified
 * `p2p.*` SQL stays on `p2p`). Local without that env starts Testcontainers
 * `postgres:16-alpine`. Docker/PG down is a failed suite, not a green skip.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, serviceAuthHeadersForBody, signPrincipalHeader } from '@intafaced/contracts';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { MemoryLedger, formatAmount, houseFees, parseAmount as amt, recipes, userAvailable } from '@intafaced/ledger-client';
import { ANY_COUNTRY } from './instruments.js';
import { installP2pS2sRawBody, p2pInternalServiceOf } from './s2s-auth.js';
import { InstrumentService } from './instrument-service.js';
import { P2pError, P2pService } from './p2p-service.js';
import { stubApprovalConsumer } from './action-approval-consume.js';
import { createP2pRouter } from './router.js';
import {
  mayGrantProgrammePrivileges,
  mayRestoreProgrammePrivileges,
  programmeVouch,
  reputationOnPublicDoor,
} from './merchant-programme.js';
import { snapshotOf, type ReputationCounters } from './reputation.js';
import { confirmedReleaseStepUp, confirmedTakeStepUp, metTakeGate } from './take-gate-fixture.js';

// Attributed local fixture for downstream doors; never a production screening declaration.
beforeEach(() => {
  vi.stubEnv('INTAFACED_SANCTIONS_REGIONS', 'none');
  vi.stubEnv('INTAFACED_SANCTIONS_LIST_SOURCE', 'test-fixture:p2p-public-doors');
  vi.stubEnv('INTAFACED_SCREENING_FAIL_CLOSED', 'false');
});
afterEach(() => vi.unstubAllEnvs());

const EDGE_SECRET = 'p2p-promise-falsify-public-doors-edge-secret-32';
const INTERNAL_SECRET = 'p2p-promise-falsify-public-doors-internal-secret';
const SELLER = '11111111-1111-4111-8111-111111111111';
const BUYER = '22222222-2222-4222-8222-222222222222';
const STRANGER = '33333333-3333-4333-8333-333333333333';
const MODERATOR = '44444444-4444-4444-8444-444444444444';
const TRADE = '55555555-5555-4555-8555-555555555555';
const OFFER = '66666666-6666-4666-8666-666666666666';
const ASSET = 'USDT';
const METHOD = 'sepa';

const here = dirname(fileURLToPath(import.meta.url));
const edgeContext = createEdgeContext({ secret: EDGE_SECRET, serviceName: 'svc-p2p' });

const migrations = [
  '0000_p2p_init.sql',
  '0001_p2p_payment_instruments.sql',
  '0002_p2p_instrument_field_guard.sql',
  '0003_p2p_dispute_ruling_invariant.sql',
  '0005_p2p_late_settle_error.sql',
  '0006_p2p_dispute_open_origin.sql',
  '0007_p2p_dispute_chat_thread.sql',
  '0010_p2p_immutable_trade_terms.sql',
  '0011_p2p_payto_snapshot.sql',
  '0012_p2p_dispute_resolution_match.sql',
  '0013_p2p_dispute_ruling_frozen.sql',
  '0014_p2p_escrow_lock_attempts.sql',
  '0015_p2p_customer_depth.sql',
  '0016_p2p_ops_escalation.sql',
  '0019_p2p_maker_verification_tier.sql',
  '0022_p2p_method_delist_reason.sql',
  '0023_p2p_take_step_ups.sql',
  '20261024075545_p2p_non_instant_methods.sql',
  '20261024111016_p2p_release_step_ups.sql',
  '20261024125300_p2p_trade_reminders.sql',
  '20261024133500_p2p_trade_mismatches.sql',
  '20261024141500_p2p_rail_exceptions.sql',
  // The sold-out close (P-ads-merchant-06) clears `pause_reason` on every decision.
  '20261025003000_p2p_method_removal_pauses.sql',
  '20261025020000_p2p_method_rules.sql',
  '20261030125739_p2p_ad_lifecycle.sql',
  '20261030135324_p2p_private_ads.sql',
].map((file) => readFileSync(join(here, '..', 'drizzle', file), 'utf8'));

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
      `H8a: svc-p2p promise-falsify-public-doors is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}

describe('svc-p2p promise-falsify-public-doors PG-hard (source)', () => {
  it('H8a money suite is not skip-green (no postgresAvailable / describe.skip)', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bpostgresAvailable\s*\(/);
    expect(src).not.toMatch(/describe\.skip\s*\(/);
    expect(src).not.toMatch(/\bit\.skip\s*\(/);
  });
});

type WireBody = {
  result?: { data?: unknown };
  error?: { message?: string; data?: { code?: string; httpStatus?: number } };
};

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    sub: SELLER,
    userId: SELLER,
    sid: '77777777-7777-4777-8777-777777777777',
    scopes: ['p2p:read', 'p2p:write'],
    tier: 'basic',
    mfa: false,
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
    'content-type': 'application/json',
  };
}

function stubInstruments() {
  const refuse = async () => {
    throw new Error('promise-falsify stub: instrument path must not run for this case');
  };
  return {
    listMethodSchemas: refuse,
    listInstruments: refuse,
    revealOwn: refuse,
    revealForTrade: refuse,
    accessLogFor: refuse,
    createInstrument: refuse,
    updateInstrument: refuse,
    removeInstrument: refuse,
    registerMethodSchema: refuse,
    setMethodEnabled: refuse,
  } as unknown as InstrumentService;
}

function stubP2p(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    listOffers: async () => [],
    listOfferBoard: async () => ({ offers: [], nextCursor: null }),
    releasedTradeCounts: async () => new Map<string, number>(),
    tradesInWindow: async () => 0,
    ...overrides,
  } as unknown as P2pService;
}

async function mountStub(
  opts: {
    p2p?: P2pService;
    moderatorUserIds?: readonly string[];
    offerLimits?: { standardMaxAmount: bigint | null; merchantMaxAmount: bigint | null };
    merchants?: {
      get: (userId: string) => Promise<{ status: string } | null>;
      transition?: (input: {
        userId: string;
        to: string;
        by: string;
        reason: string;
        actorId: string;
        actorScope: string;
      }) => Promise<unknown>;
    };
  } = {},
): Promise<FastifyInstance> {
  const router = createP2pRouter(
    opts.p2p ?? stubP2p(),
    stubInstruments(),
    undefined,
    {
      moderatorUserIds: opts.moderatorUserIds ?? [],
      offerLimits: opts.offerLimits,
      approvals: stubApprovalConsumer('99999999-9999-4999-8999-999999999999'),
      takeGate: metTakeGate(),
      takeStepUp: confirmedTakeStepUp(),
      releaseStepUp: confirmedReleaseStepUp(),
    },
    opts.merchants as never,
  );

  const app = Fastify({ logger: false });
  installP2pS2sRawBody(app);
  await app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: {
      router,
      createContext: ({ req }) => edgeContext(req),
    } satisfies FastifyTRPCPluginOptions<typeof router>['trpcOptions'],
  });

  // Same reputation door index.ts mounts — freeze must be on this payload,
  // not only on tRPC, or other modules keep reading badges as if vouched.
  app.get<{ Params: { userId: string } }>('/internal/reputation/:userId', async (req, reply) => {
    if (p2pInternalServiceOf(req, INTERNAL_SECRET) === null) {
      return reply.code(401).send({ error: 'service credentials required', code: 'p2p.unauthenticated' });
    }
    const p2p = opts.p2p ?? stubP2p();
    const snapshot = await p2p.reputationOf(req.params.userId);
    const record = opts.merchants ? await opts.merchants.get(req.params.userId) : null;
    return reputationOnPublicDoor(snapshot, programmeVouch(record?.status as never, Boolean(opts.merchants)));
  });

  await app.ready();
  return app;
}

async function post(
  app: FastifyInstance,
  path: string,
  input: Record<string, unknown>,
  headers: Record<string, string> = signedHeaders(),
): Promise<{ statusCode: number; body: WireBody }> {
  const res = await app.inject({ method: 'POST', url: `/trpc/${path}`, headers, payload: input });
  return { statusCode: res.statusCode, body: res.json() as WireBody };
}

async function get(
  app: FastifyInstance,
  url: string,
  headers: Record<string, string> = {},
): Promise<{ statusCode: number; body: unknown }> {
  const res = await app.inject({ method: 'GET', url, headers });
  return { statusCode: res.statusCode, body: res.json() };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Closed selectors — fee invent / dispute machine ruling refuse on the wire.
// ═══════════════════════════════════════════════════════════════════════════════

describe('D26-P2-01f refuse-closed defaults (no invent)', () => {
  it('trades.take input schema has no feeBps — wire cannot invent a zero fee', async () => {
    let takeArgs: unknown;
    const p2p = stubP2p({
      takeOffer: async (input: unknown) => {
        takeArgs = input;
        throw new P2pError('probe', 'p2p.offer_not_found');
      },
    });
    const app = await mountStub({ p2p });

    const { statusCode, body } = await post(
      app,
      'trades.take',
      {
        offerId: OFFER,
        tradeId: TRADE,
        amount: '100',
        method: METHOD,
        feeBps: 0,
      },
      signedHeaders(principal({ sub: BUYER, userId: BUYER })),
    );

    // Zod strips unknown keys by default — the service must never see feeBps.
    expect(statusCode).toBe(404);
    expect(body.error!.message).toMatch(/probe|not found/i);
    expect(takeArgs).toEqual({
      offerId: OFFER,
      takerId: BUYER,
      amount: amt('100'),
      tradeId: TRADE,
      method: METHOD,
      tier: 'basic',
    });
    expect(takeArgs).not.toHaveProperty('feeBps');
    await app.close();
  });

  it('disputes.resolve input allows only release|refund — no invent third outcome', async () => {
    let resolved = 0;
    const p2p = stubP2p({
      resolveDispute: async () => {
        resolved += 1;
        throw new Error('resolve must not run');
      },
    });
    const app = await mountStub({ p2p, moderatorUserIds: [MODERATOR] });

    const { statusCode } = await post(
      app,
      'disputes.resolve',
      { tradeId: TRADE, resolution: 'split' },
      signedHeaders(principal({ sub: MODERATOR, userId: MODERATOR, scopes: ['p2p:read'] })),
    );

    expect(statusCode).toBe(400);
    expect(resolved).toBe(0);
    await app.close();
  });

  it('offers.create HTTP named-refuses until OWNER KMS — createOffer never runs', async () => {
    let created = 0;
    const p2p = stubP2p({
      createOffer: async () => {
        created += 1;
        throw new Error('create must not run');
      },
    });
    const app = await mountStub({ p2p });
    const { statusCode, body } = await post(app, 'offers.create', {
      side: 'sell',
      asset: ASSET,
      fiatCurrency: 'USD',
      priceType: 'fixed',
      price: '1',
      minAmount: '10',
      maxAmount: '500',
      methods: [METHOD],
      idempotencyKey: 'kms-refuse-key',
    });
    expect(statusCode).toBe(412);
    expect(body.error!.message).toBe('p2p.instrument_kms_required');
    expect(created).toBe(0);
    await app.close();
  });

  it('trades.take surfaces release_unpostable over the wire (no invent postable fee)', async () => {
    const takeOffer = vi.fn(async () => {
      throw new P2pError(
        'Trade amount is too small for a 30 bps fee — after the fee the buyer would receive nothing. Raise the size or set fee to 0.',
        'p2p.release_unpostable',
      );
    });
    const app = await mountStub({ p2p: stubP2p({ takeOffer }) });

    const { statusCode, body } = await post(
      app,
      'trades.take',
      { offerId: OFFER, tradeId: TRADE, amount: '100', method: METHOD },
      signedHeaders(principal({ sub: BUYER, userId: BUYER })),
    );

    expect(statusCode).toBe(400);
    expect(body.error!.message).toMatch(/too small for a 30 bps fee/);
    expect(takeOffer).toHaveBeenCalledOnce();
    await app.close();
  });

  it('merchants.apiAccess discloses interactive_human_only for dispute resolution', async () => {
    const merchants = {
      get: async () => ({
        userId: SELLER,
        status: 'approved',
        appliedCompletionRate: 1,
        appliedTradesTotal: 100,
        appliedAt: new Date('2026-01-01T00:00:00.000Z'),
        decidedAt: new Date('2026-01-02T00:00:00.000Z'),
      }),
    };
    const app = await mountStub({ merchants: merchants as never });

    const res = await app.inject({
      method: 'GET',
      url: '/trpc/merchants.apiAccess',
      headers: signedHeaders(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().result?.data).toMatchObject({
      disputeResolution: 'interactive_human_only',
      keyPlane: 'identity',
      rateLimitPlane: 'edge',
    });
    await app.close();
  });
});

describe('D26-P2-01f public doors — dispute refuse invent rulings', () => {
  it('disputes.resolve refuses when moderation is unconfigured — resolveDispute never runs', async () => {
    let resolved = 0;
    const p2p = stubP2p({
      resolveDispute: async () => {
        resolved += 1;
        throw new Error('resolve must not run');
      },
    });
    const app = await mountStub({ p2p });

    const { statusCode, body } = await post(
      app,
      'disputes.resolve',
      { tradeId: TRADE, resolution: 'release' },
      signedHeaders(principal({ scopes: ['p2p:read', 'p2p:write'] })),
    );

    expect(statusCode).toBe(412);
    expect(body.error!.message).toMatch(/moderation is not configured/i);
    expect(resolved).toBe(0);
    await app.close();
  });

  it('disputes.resolve refuses a non-moderator when the queue is staffed', async () => {
    let resolved = 0;
    const p2p = stubP2p({
      resolveDispute: async () => {
        resolved += 1;
        throw new Error('resolve must not run');
      },
    });
    const app = await mountStub({ p2p, moderatorUserIds: [MODERATOR] });

    const { statusCode, body } = await post(
      app,
      'disputes.resolve',
      { tradeId: TRADE, resolution: 'refund' },
      signedHeaders(principal({ sub: BUYER, userId: BUYER, scopes: ['p2p:read', 'p2p:write'] })),
    );

    expect(statusCode).toBe(403);
    expect(body.error!.message).toMatch(/Moderator authority required|not on P2P_MODERATOR/i);
    expect(resolved).toBe(0);
    await app.close();
  });

  it('disputes.resolve refuses an allowlisted API key (kid) — D-S-08 / #1697 deepen', async () => {
    let resolved = 0;
    const p2p = stubP2p({
      resolveDispute: async () => {
        resolved += 1;
        throw new Error('resolve must not run');
      },
    });
    const merchants = {
      get: async () => ({
        userId: MODERATOR,
        status: 'approved',
        appliedCompletionRate: 1,
        appliedTradesTotal: 100,
        appliedAt: new Date('2026-01-01T00:00:00.000Z'),
        decidedAt: new Date('2026-01-02T00:00:00.000Z'),
      }),
    };
    const app = await mountStub({ p2p, moderatorUserIds: [MODERATOR], merchants: merchants as never });

    const { statusCode, body } = await post(
      app,
      'disputes.resolve',
      { tradeId: TRADE, resolution: 'release' },
      signedHeaders(
        principal({
          sub: MODERATOR,
          userId: MODERATOR,
          scopes: ['p2p:read', 'admin:compliance'],
          kid: 'merchant-key-1',
        }),
      ),
    );

    expect(statusCode).toBe(403);
    expect(body.error!.message).toMatch(/API keys cannot adjudicate/i);
    expect(resolved).toBe(0);
    await app.close();
  });

  it('disputes.open discloses escalated_and_held when nobody rules', async () => {
    const p2p = stubP2p({
      openDispute: async () => ({
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        tradeId: TRADE,
        openedBy: BUYER,
        openedVia: 'party' as const,
        reason: 'x',
        chatThreadId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        evidence: [],
        moderatorId: null,
        resolution: null,
        resolutionNotes: null,
        status: 'open' as const,
        deadlineAt: new Date('2026-08-20T00:00:00.000Z'),
        openedAt: new Date('2026-08-12T00:00:00.000Z'),
        resolvedAt: null,
        lastSeenByModeratorAt: null,
        moderatorViews: 0,
        escalatedAt: null,
        escalations: 0,
      }),
    });
    const app = await mountStub({ p2p });

    const { statusCode, body } = await post(
      app,
      'disputes.open',
      { tradeId: TRADE, reason: 'seller unresponsive' },
      signedHeaders(principal({ sub: BUYER, userId: BUYER })),
    );

    expect(statusCode).toBe(200);
    expect(body.result?.data).toMatchObject({
      ifNobodyRules: 'escalated_and_held',
      moderationConfigured: false,
      moderation: { status: 'absent', code: 'p2p.moderation_unreachable' },
      chatThreadId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    });
    expect(body.result?.data).not.toHaveProperty('moderationReachable');
    await app.close();
  });
});

describe('p2p.merchants public doors — operator freeze against reputation snapshot', () => {
  const OPERATOR = '88888888-8888-4888-8888-888888888888';
  const CONFIRM = '99999999-9999-4999-8999-999999999999';
  const clean: ReputationCounters = {
    tradesTotal: 60,
    completed: 60,
    cancelled: 0,
    disputed: 0,
    disputesLost: 0,
    totalReleaseSecs: 600,
    releaseSamples: 60,
  };

  function merchantRow(status: string) {
    return {
      userId: SELLER,
      status,
      appliedCompletionRate: 1,
      appliedTradesTotal: 60,
      appliedAt: new Date('2026-01-01T00:00:00.000Z'),
      decidedAt: new Date('2026-01-02T00:00:00.000Z'),
    };
  }

  it('GET /internal/reputation refuses without service auth — freeze is not a public leak', async () => {
    const app = await mountStub({
      p2p: stubP2p({ reputationOf: async () => snapshotOf(clean) }),
      merchants: { get: async () => merchantRow('approved') },
    });
    const { statusCode, body } = await get(app, `/internal/reputation/${SELLER}`);
    expect(statusCode).toBe(401);
    expect(body).toMatchObject({ code: 'p2p.unauthenticated' });
    await app.close();
  });

  it('GET /internal/reputation shows freeze on the same snapshot badges use', async () => {
    const snap = snapshotOf(clean);
    const app = await mountStub({
      p2p: stubP2p({ reputationOf: async () => snap }),
      merchants: { get: async () => merchantRow('suspended') },
    });
    const res = await app.inject({
      method: 'GET',
      url: `/internal/reputation/${SELLER}`,
      headers: serviceAuthHeadersForBody('svc-ops', INTERNAL_SECRET, ''),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { merchant: boolean; badges: string[] };
    expect(body.merchant).toBe(false);
    expect(body.badges).toEqual([...snap.badges]);
    expect(body.badges).toContain('spotless');
    expect(body).not.toHaveProperty('p2pLimitMultiplier');
    await app.close();
  });

  it('GET /internal/reputation 401s when the v2 digest is not the empty GET body', async () => {
    const app = await mountStub({
      p2p: stubP2p({ reputationOf: async () => snapshotOf(clean) }),
      merchants: { get: async () => merchantRow('approved') },
    });
    const res = await app.inject({
      method: 'GET',
      url: `/internal/reputation/${SELLER}`,
      headers: serviceAuthHeadersForBody('svc-ops', INTERNAL_SECRET, '{"not":"empty"}'),
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'p2p.unauthenticated' });
    await app.close();
  });

  it('merchants.decide freeze drops API + merchant-band privileges over the wire', async () => {
    const { parseAmount } = await import('@intafaced/ledger-client');
    let status = 'approved';
    const merchants = {
      get: async () => merchantRow(status),
      transition: async (input: { to: string }) => {
        status = input.to;
        return merchantRow(status);
      },
    };
    const app = await mountStub({
      p2p: stubP2p({ reputationOf: async () => snapshotOf(clean) }),
      offerLimits: {
        standardMaxAmount: parseAmount('1000'),
        merchantMaxAmount: parseAmount('5000'),
      },
      merchants: merchants as never,
    });

    const freeze = await post(
      app,
      'merchants.decide',
      {
        userId: SELLER,
        to: 'suspended',
        reason: 'operator freeze',
        confirmOperatorId: CONFIRM,
        approvalId: 'appr-1',
        operationId: 'op-1',
      },
      signedHeaders(principal({ sub: OPERATOR, userId: OPERATOR, scopes: ['admin:compliance'], mfa: true, tier: 'full' })),
    );
    expect(freeze.statusCode).toBe(200);
    expect(freeze.body.result?.data).toMatchObject({ status: 'suspended', confirmOperatorId: CONFIRM });

    const access = await app.inject({
      method: 'GET',
      url: '/trpc/merchants.apiAccess',
      headers: signedHeaders(principal({ kid: 'merchant-key-1', scopes: ['p2p:read'] })),
    });
    expect(access.statusCode).toBe(200);
    expect(access.json().result?.data).toMatchObject({ eligible: false, merchantStatus: 'suspended' });

    const ceiling = await app.inject({
      method: 'GET',
      url: '/trpc/merchants.myOfferCeiling',
      headers: signedHeaders(),
    });
    expect(ceiling.statusCode).toBe(200);
    expect(ceiling.json().result?.data).toMatchObject({
      band: 'standard',
      merchantStatus: 'suspended',
      maxAmount: '1000',
    });
    await app.close();
  });

  it('unfreeze refuses when live reputation would fail the apply rule', async () => {
    const broken = snapshotOf({ ...clean, disputed: 1, disputesLost: 1 });
    const restore = mayRestoreProgrammePrivileges(broken);
    expect(restore.eligible).toBe(false);
    const merchants = {
      get: async () => merchantRow('suspended'),
      transition: async () => {
        throw new P2pError(
          `Cannot grant programme privileges while live reputation fails the same rule badges use. ${restore.eligible === false ? restore.reason : ''}`,
          'p2p.merchant_ineligible',
        );
      },
    };
    const app = await mountStub({
      p2p: stubP2p({ reputationOf: async () => broken }),
      merchants: merchants as never,
    });
    const res = await post(
      app,
      'merchants.decide',
      {
        userId: SELLER,
        to: 'approved',
        reason: 'operator unfreeze',
        confirmOperatorId: CONFIRM,
        approvalId: 'appr-1',
        operationId: 'op-1',
      },
      signedHeaders(principal({ sub: OPERATOR, userId: OPERATOR, scopes: ['admin:compliance'], mfa: true, tier: 'full' })),
    );
    expect(res.statusCode).toBe(400);
    expect(res.body.error!.message).toMatch(/live reputation fails the same rule badges use/i);
    await app.close();
  });

  it('first approval refuses when live reputation would fail the apply rule', async () => {
    const broken = snapshotOf({ ...clean, disputed: 1, disputesLost: 1 });
    const grant = mayGrantProgrammePrivileges(broken);
    expect(grant.eligible).toBe(false);
    const merchants = {
      get: async () => merchantRow('applied'),
      transition: async () => {
        throw new P2pError(
          `Cannot grant programme privileges while live reputation fails the same rule badges use. ${grant.eligible === false ? grant.reason : ''}`,
          'p2p.merchant_ineligible',
        );
      },
    };
    const app = await mountStub({
      p2p: stubP2p({ reputationOf: async () => broken }),
      merchants: merchants as never,
    });
    const res = await post(
      app,
      'merchants.decide',
      {
        userId: SELLER,
        to: 'approved',
        reason: 'operator first approve',
        confirmOperatorId: CONFIRM,
        approvalId: 'appr-1',
        operationId: 'op-1',
      },
      signedHeaders(principal({ sub: OPERATOR, userId: OPERATOR, scopes: ['admin:compliance'], mfa: true, tier: 'full' })),
    );
    expect(res.statusCode).toBe(400);
    expect(res.body.error!.message).toMatch(/live reputation fails the same rule badges use/i);
    await app.close();
  });

  it('empty moderator allowlist still refuses disputes.resolve — freeze does not mint p2p:moderate', async () => {
    let resolved = 0;
    const app = await mountStub({
      p2p: stubP2p({
        resolveDispute: async () => {
          resolved += 1;
          throw new Error('resolve must not run');
        },
      }),
      merchants: { get: async () => merchantRow('approved') },
    });
    const { statusCode, body } = await post(
      app,
      'disputes.resolve',
      { tradeId: TRADE, resolution: 'release' },
      signedHeaders(principal({ scopes: ['p2p:read', 'p2p:write'] })),
    );
    expect(statusCode).toBe(412);
    expect(body.error!.message).toMatch(/moderation is not configured/i);
    expect(resolved).toBe(0);
    await app.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Money paths — real Postgres + MemoryLedger through the same Fastify doors.
// ═══════════════════════════════════════════════════════════════════════════════

describe('D26-P2-01f public doors money', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let instruments!: InstrumentService;
  let ledger: MemoryLedger;
  let bus: MemoryEventBus;
  let p2p: P2pService;
  let app: FastifyInstance;

  beforeAll(async () => {
    const admin = await openH8aAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'p2p', url: admin.url, migrations });
    sql = db.sql;
    instruments = new InstrumentService(sql);
  }, 120_000);

  async function seedPaymentRails() {
    await instruments.registerMethodSchema({
      methodId: METHOD,
      country: ANY_COUNTRY,
      label: 'Bank transfer (promise-falsify fixture)',
      fields: [{ key: 'account_reference', label: 'Account reference', required: true }],
    });
    for (const ownerId of [SELLER, BUYER, STRANGER, MODERATOR]) {
      await instruments.createInstrument({
        ownerId,
        methodId: METHOD,
        country: 'DE',
        fiatCurrency: 'USD',
        label: 'USD destination',
        details: { account_reference: `ref-${ownerId}` },
        instrumentId: crypto.randomUUID(),
      });
    }
  }

  async function fund(userId: string, amount: string) {
    await ledger.post(
      recipes.deposit({
        userId,
        assetId: ASSET,
        amount: amt(amount),
        rail: 'test',
        railRef: `${userId}:${amount}:${crypto.randomUUID()}`,
      }),
    );
  }

  const availableOf = async (userId: string) => formatAmount((await ledger.balance(userAvailable(userId, ASSET))).amount);
  const houseOf = async () => formatAmount((await ledger.balance(houseFees('p2p', ASSET))).amount);

  async function mountMoney(feeBps: number, moderatorUserIds: readonly string[] = [MODERATOR]): Promise<void> {
    p2p = new P2pService(sql, ledger, bus, {
      instruments,
      feeBps,
      deadlines: {
        escrowSeconds: 120,
        paymentSeconds: 900,
        releaseSeconds: 1800,
        disputeSeconds: 604_800,
        escalationRecheckSeconds: 3_600,
      },
    });

    const router = createP2pRouter(p2p, instruments, undefined, {
      moderatorUserIds,
      takeGate: metTakeGate(),
      takeStepUp: confirmedTakeStepUp(),
      releaseStepUp: confirmedReleaseStepUp(),
    });
    app = Fastify({ logger: false });
    installP2pS2sRawBody(app);
    await app.register(fastifyTRPCPlugin, {
      prefix: '/trpc',
      trpcOptions: {
        router,
        createContext: ({ req }) => edgeContext(req),
      } satisfies FastifyTRPCPluginOptions<typeof router>['trpcOptions'],
    });

    // Same integrity door index.ts mounts — prove auth + drift check over HTTP.
    app.get('/internal/escrow-integrity', async (req, reply) => {
      if (p2pInternalServiceOf(req, INTERNAL_SECRET) === null) {
        return reply.code(401).send({ error: 'service credentials required', code: 'p2p.unauthenticated' });
      }
      const result = await p2p.escrowIntegrity();
      if (!result.ok) reply.status(500);
      return result;
    });

    await app.ready();
  }

  async function createSellOfferViaDoor(total = '500'): Promise<string> {
    // Live HTTP offers.create is refuse-closed until OWNER KMS. Money-path
    // doors under test (take / confirm / cancel / resolve) seed the offer
    // through the service engine, not the live create door.
    const offer = await p2p.createOffer({
      makerId: SELLER,
      side: 'sell',
      asset: ASSET,
      fiatCurrency: 'USD',
      priceType: 'fixed',
      price: amt('1'),
      minAmt: amt('10'),
      maxAmt: amt('500'),
      totalAmt: amt(total),
      methods: [METHOD],
    });
    return offer.id;
  }

  async function takeViaDoor(offerId: string, amount: string): Promise<{ id: string; status: string }> {
    const { statusCode, body } = await post(
      app,
      'trades.take',
      { offerId, amount, method: METHOD, tradeId: crypto.randomUUID() },
      signedHeaders(principal({ sub: BUYER, userId: BUYER })),
    );
    expect(statusCode).toBe(200);
    return body.result?.data as { id: string; status: string };
  }

  beforeEach(async () => {
    await sql`
      TRUNCATE p2p.instrument_access_log, p2p.trade_payment_instruments, p2p.payment_instruments,
               p2p.payment_method_schemas, p2p.p2p_disputes, p2p.p2p_trades, p2p.offers, p2p.p2p_reputation
      RESTART IDENTITY CASCADE
    `;
    ledger = new MemoryLedger();
    bus = new MemoryEventBus('svc-p2p');
    await seedPaymentRails();
  });

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  });

  describe('D26-P2-01f public doors — fee integrity', () => {
    it('trades.take refuses dust before any lock — fee/fiat refuse, escrow untouched', async () => {
      await fund(SELLER, '1000');
      await mountMoney(30);

      // Offer created at service layer so min can be one scaled unit; the public
      // door under test is trades.take. Pricing may refuse first (zero fiat);
      // either way no escrow locks and integrity stays clean.
      const offer = await p2p.createOffer({
        makerId: SELLER,
        side: 'sell',
        asset: ASSET,
        fiatCurrency: 'USD',
        priceType: 'fixed',
        price: amt('1'),
        minAmt: 1n,
        maxAmt: amt('1'),
        totalAmt: amt('1'),
        methods: [METHOD],
      });

      const { statusCode, body } = await post(
        app,
        'trades.take',
        { offerId: offer.id, amount: '0.000000000000000001', method: METHOD, tradeId: crypto.randomUUID() },
        signedHeaders(principal({ sub: BUYER, userId: BUYER })),
      );

      expect(statusCode).toBe(400);
      expect(body.error!.message).toMatch(/too small for a 30 bps fee|rounds to zero|must be positive|below the offer minimum/i);
      expect(await availableOf(SELLER)).toBe('1000');
      expect(await p2p.escrowIntegrity()).toEqual({ ok: true });
      await app.close();
    });

    it('trades.take stamps constructor fee only — second take still carries service feeBps', async () => {
      await fund(SELLER, '1000');
      await mountMoney(100);

      const offerId = await createSellOfferViaDoor();
      const first = await takeViaDoor(offerId, '100');
      const second = await takeViaDoor(offerId, '100');

      const t1 = await p2p.getTrade(first.id);
      const t2 = await p2p.getTrade(second.id);
      expect(t1.feeBps).toBe(100);
      expect(t2.feeBps).toBe(100);
      await app.close();
    });
  });

  describe('D26-P2-01f public doors — escrow integrity', () => {
    it('confirmReceived releases buyer net of fee; houseFees receives the cut; integrity ok', async () => {
      await fund(SELLER, '1000');
      await mountMoney(100);

      const offerId = await createSellOfferViaDoor();
      const trade = await takeViaDoor(offerId, '100');
      expect(trade.status).toBe('escrowed');
      expect(await availableOf(SELLER)).toBe('900');

      const { statusCode, body } = await post(app, 'trades.confirmReceived', { tradeId: trade.id });
      expect(statusCode).toBe(200);
      expect(body.result?.data).toMatchObject({ status: 'released', resolution: 'released' });

      expect(await availableOf(BUYER)).toBe('99');
      expect(await houseOf()).toBe('1');
      expect(ledger.totalsByAsset()[ASSET] ?? '0').toBe('0');
      expect(await p2p.escrowIntegrity()).toEqual({ ok: true });

      const integrity = await get(app, '/internal/escrow-integrity', serviceAuthHeadersForBody('svc-ops', INTERNAL_SECRET, ''));
      expect(integrity.statusCode).toBe(200);
      expect(integrity.body).toEqual({ ok: true });
      await app.close();
    });

    it('cancel refunds the seller in full — no invent fee on refund', async () => {
      await fund(SELLER, '1000');
      await mountMoney(100);

      const offerId = await createSellOfferViaDoor();
      const trade = await takeViaDoor(offerId, '100');

      // From escrowed, either party may cancel; buyer path proves no fee skim.
      const { statusCode, body } = await post(
        app,
        'trades.cancel',
        { tradeId: trade.id, reason: 'changed_mind' },
        signedHeaders(principal({ sub: BUYER, userId: BUYER })),
      );
      expect(statusCode).toBe(200);
      expect(body.result?.data).toMatchObject({ status: 'cancelled', resolution: 'refunded' });

      expect(await availableOf(SELLER)).toBe('1000');
      expect(await houseOf()).toBe('0');
      expect(await p2p.escrowIntegrity()).toEqual({ ok: true });
      await app.close();
    });

    it('stranger confirmReceived never moves escrow', async () => {
      await fund(SELLER, '1000');
      await mountMoney(100);

      const offerId = await createSellOfferViaDoor();
      const trade = await takeViaDoor(offerId, '100');

      const { statusCode, body } = await post(
        app,
        'trades.confirmReceived',
        { tradeId: trade.id },
        signedHeaders(principal({ sub: STRANGER, userId: STRANGER })),
      );

      expect(statusCode).toBe(404);
      expect(body.error!.message).toBe(`Trade ${trade.id} not found`);
      expect(await availableOf(SELLER)).toBe('900');
      expect(await availableOf(BUYER)).toBe('0');
      expect((await p2p.getTrade(trade.id)).status).toBe('escrowed');
      await app.close();
    });

    it('unauthenticated escrow-integrity door never runs the compare', async () => {
      await fund(SELLER, '1000');
      await mountMoney(0);
      const { statusCode, body } = await get(app, '/internal/escrow-integrity');
      expect(statusCode).toBe(401);
      expect(body).toMatchObject({ code: 'p2p.unauthenticated' });
      await app.close();
    });
  });

  describe('D26-P2-01f public doors — dispute escrow integrity', () => {
    it('disputed escrow refuses cancel/confirm; only human resolve moves value', async () => {
      await fund(SELLER, '1000');
      await mountMoney(100);

      const offerId = await createSellOfferViaDoor();
      const trade = await takeViaDoor(offerId, '100');

      const opened = await post(
        app,
        'disputes.open',
        { tradeId: trade.id, reason: 'paid, not released' },
        signedHeaders(principal({ sub: BUYER, userId: BUYER })),
      );
      expect(opened.statusCode).toBe(200);
      expect(opened.body.result?.data).toMatchObject({ ifNobodyRules: 'escalated_and_held' });

      const cancel = await post(app, 'trades.cancel', { tradeId: trade.id }, signedHeaders());
      expect(cancel.statusCode).toBe(409);
      expect(cancel.body.error!.message).toMatch(/resolved by a moderator/i);

      const confirm = await post(app, 'trades.confirmReceived', { tradeId: trade.id });
      expect(confirm.statusCode).toBe(409);
      expect(confirm.body.error!.message).toMatch(/resolved by a moderator/i);

      expect((await p2p.getTrade(trade.id)).status).toBe('disputed');
      expect(await availableOf(SELLER)).toBe('900');

      const resolved = await post(
        app,
        'disputes.resolve',
        { tradeId: trade.id, resolution: 'release' },
        signedHeaders(principal({ sub: MODERATOR, userId: MODERATOR, scopes: ['p2p:read', 'admin:compliance'] })),
      );
      expect(resolved.statusCode).toBe(200);
      expect(resolved.body.result?.data).toMatchObject({ status: 'released', resolution: 'released' });
      expect(await availableOf(BUYER)).toBe('99');
      expect(await houseOf()).toBe('1');
      expect(await p2p.escrowIntegrity()).toEqual({ ok: true });
      await app.close();
    });

    it('disputes.resolve refund path returns full escrow to seller — no invent fee', async () => {
      await fund(SELLER, '1000');
      await mountMoney(100, [MODERATOR]);

      const offerId = await createSellOfferViaDoor();
      const trade = await takeViaDoor(offerId, '100');
      const opened = await post(
        app,
        'disputes.open',
        { tradeId: trade.id, reason: 'no payment' },
        signedHeaders(principal({ sub: SELLER, userId: SELLER })),
      );
      expect(opened.statusCode).toBe(200);

      const resolved = await post(
        app,
        'disputes.resolve',
        { tradeId: trade.id, resolution: 'refund' },
        signedHeaders(principal({ sub: MODERATOR, userId: MODERATOR, scopes: ['p2p:read'] })),
      );
      expect(resolved.statusCode).toBe(200);
      expect(resolved.body.result?.data).toMatchObject({ status: 'cancelled', resolution: 'refunded' });

      expect(await availableOf(SELLER)).toBe('1000');
      expect(await houseOf()).toBe('0');
      expect(await p2p.escrowIntegrity()).toEqual({ ok: true });
      await app.close();
    });
  });
});
