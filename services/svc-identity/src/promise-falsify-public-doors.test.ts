/**
 * Unit card (D26-P2-12 identity slice):
 * Promise: sub-account ownership / cross-leak ban still honest through mounted
 *   Fastify+tRPC public doors and the S2S ownership HTTP snapshot — not
 *   createCaller / AuthService-unit theater (#1743 already covers caller).
 * Break: a stranger could assertOwned / assertTransferDoor / revoke another
 *   identity's partition; a missing id could invent primary; list/S2S could
 *   invent a balance identity must never hold.
 * Done bar:
 *   · POST /trpc/subAccounts.assertOwned refuses foreign / missing / revoked
 *     over the wire (FORBIDDEN / BAD_REQUEST); never defaults to primary.
 *   · POST /trpc/subAccounts.assertTransferDoor refuses cross-parent leak
 *     and posts nothing (identity has no ledger post on this door).
 *   · GET /trpc/subAccounts.list is parent-scoped; payload has no balance.
 *   · GET /internal/sub-accounts/:id requires service auth; 404 unknown;
 *     snapshot is {id, parentUserId, revoked} only.
 * Class: N (honesty) / M surface (no invented balances). Leverage:
 *   createIdentityRouter + createEdgeContext + verifyServiceHeaders
 *   (Phase A S-ID / D-S-11 — wire existing doors, do not rebuild).
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify';
import type { Principal } from '@intafaced/auth';
import {
  createEdgeContext,
  encodePrincipal,
  rawBodyOf,
  retainRawBody,
  serviceAuthHeadersForBody,
  signPrincipalHeader,
  verifyServiceHeaders,
} from '@intafaced/contracts';
import { AuthError, publishedSubAccountsListLimit, type AuthService } from './auth/auth-service.js';
import type { RankService } from './rank/rank-service.js';
import { MemoryLedger, formatAmount, houseFees, parseAmount, recipes, rewardsEngine, userAvailable } from '@intafaced/ledger-client';
import { MemoryAccrualStore } from './affiliates/accrual-store.js';
import type { FreezeService } from './affiliates/freeze-service.js';
import type { CommissionRow } from './affiliates/commission.js';
import { createIdentityRouter } from './router.js';
import type { SubAccountDeleteService } from './sub-accounts/sub-account-delete.js';
import { stubActionApprovals } from './auth/privileged-dual-control.js';
import { userCopy } from './user-copy.js';

const EDGE_SECRET = 'identity-promise-falsify-public-doors-edge-secret-32';
const INTERNAL_SECRET = 'identity-promise-falsify-public-doors-internal';
const OWNER = '11111111-1111-4111-8111-111111111111';
const STRANGER = '22222222-2222-4222-8222-222222222222';
const GHOST = '00000000-0000-4000-8000-000000000099';
const OPERATOR = '33333333-3333-4333-8333-333333333333';
const CONFIRM = '55555555-5555-4555-8555-555555555555';
const PAYER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const BENE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const FEE_EVT = 'fee-evt-promise-falsify-door';
const ASSET = 'USDT';

const publishedLaw = {
  published: true as const,
  tiers: [{ hop: 0, rate: '0.10' }],
};

const here = dirname(fileURLToPath(import.meta.url));
const edgeContext = createEdgeContext({ secret: EDGE_SECRET, serviceName: 'svc-identity' });

type Book = {
  id: string;
  parentUserId: string;
  label: string;
  purpose: string | null;
  revoked: boolean;
  frozen: boolean;
  kind: 'standard';
  nickname: string | null;
  createdAt: Date;
};

/**
 * In-memory books that copy AuthService fail-closed rules (SPEC-SUBACCOUNTS
 * §1–§2). Public-door tests prove the wire; identity.test.ts still owns Postgres.
 */
class MemorySubAccountAuth {
  readonly books = new Map<string, Book>();

  async createSubAccount(userId: string, label: string, purpose?: string): Promise<{ id: string }> {
    const id = randomUUID();
    this.books.set(id, {
      id,
      parentUserId: userId,
      label,
      purpose: purpose ?? null,
      revoked: false,
      frozen: false,
      kind: 'standard',
      nickname: null,
      createdAt: new Date('2026-08-15T00:00:00.000Z'),
    });
    return { id };
  }

  async listSubAccounts(userId: string, limit: number): Promise<Book[]> {
    const published = publishedSubAccountsListLimit(limit);
    return [...this.books.values()]
      .filter((b) => b.parentUserId === userId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, published);
  }

  async revokeSubAccount(userId: string, subAccountId: string): Promise<boolean> {
    const row = this.books.get(subAccountId);
    if (!row || row.parentUserId !== userId || row.revoked) return false;
    row.revoked = true;
    return true;
  }

  async getSubAccountOwnership(subAccountId: string): Promise<{ id: string; parentUserId: string; revoked: boolean } | null> {
    const row = this.books.get(subAccountId);
    if (!row) return null;
    return { id: row.id, parentUserId: row.parentUserId, revoked: row.revoked };
  }

  async assertSubAccountOwned(userId: string, subAccountId: string | null | undefined): Promise<{ id: string; parentUserId: string }> {
    const id = typeof subAccountId === 'string' ? subAccountId.trim() : '';
    if (!id) {
      throw new AuthError(
        'Sub-account id is required — a missing id is a refusal, never a default to primary',
        'auth.sub_account_required',
      );
    }
    const row = await this.getSubAccountOwnership(id);
    if (!row || row.parentUserId !== userId) {
      throw new AuthError('Sub-account not found or not owned by caller', 'auth.sub_account_denied');
    }
    if (row.revoked) {
      throw new AuthError('Sub-account is revoked', 'auth.sub_account_revoked');
    }
    return { id: row.id, parentUserId: row.parentUserId };
  }

  async assertSubAccountTransferDoor(
    userId: string,
    fromSubAccountId: string | null | undefined,
    toSubAccountId: string | null | undefined,
  ): Promise<{ fromId: string; toId: string }> {
    const fromId = typeof fromSubAccountId === 'string' ? fromSubAccountId.trim() : '';
    const toId = typeof toSubAccountId === 'string' ? toSubAccountId.trim() : '';
    if (!fromId || !toId) {
      throw new AuthError(
        'Both from and to sub-account ids are required — a missing id is a refusal, never a default to primary',
        'auth.sub_account_required',
      );
    }
    if (fromId === toId) {
      throw new AuthError('A transfer needs two different sub-accounts', 'auth.sub_account_same');
    }
    const from = await this.assertSubAccountOwned(userId, fromId);
    const to = await this.assertSubAccountOwned(userId, toId);
    return { fromId: from.id, toId: to.id };
  }
}

type WireBody = {
  result?: { data?: unknown };
  error?: { message?: string; data?: { code?: string; httpStatus?: number } };
};

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    sub: OWNER,
    userId: OWNER,
    sid: '44444444-4444-4444-8444-444444444444',
    scopes: ['identity:read', 'identity:write'],
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

function adminHeaders(): Record<string, string> {
  return signedHeaders(
    principal({
      sub: OPERATOR,
      userId: OPERATOR,
      scopes: ['admin:write'],
    }),
  );
}

function accrualRow(): CommissionRow {
  return {
    feeEventId: FEE_EVT,
    beneficiaryId: BENE,
    payerId: PAYER,
    hop: 0,
    rate: '0.10',
    feeAmount: '100',
    commissionAmount: '10',
    asset: ASSET,
    accruedAt: new Date('2026-08-12T00:00:00.000Z'),
    sourceModule: 'identity',
  };
}

async function fundedPayoutLedger(): Promise<MemoryLedger> {
  const ledger = new MemoryLedger();
  await ledger.post(
    recipes.deposit({
      userId: PAYER,
      assetId: ASSET,
      amount: parseAmount('1000'),
      rail: 'crypto-native',
      railRef: 'promise-falsify-payout-seed',
    }),
  );
  await ledger.post(
    recipes.feeCharge({
      mode: 'asset',
      chargeId: FEE_EVT,
      userId: PAYER,
      module: 'identity',
      assetId: ASSET,
      amount: parseAmount('100'),
    }),
  );
  return ledger;
}

const bal = async (l: MemoryLedger, ref: Parameters<MemoryLedger['balance']>[0]) => formatAmount((await l.balance(ref)).amount);

function unwrapData(body: WireBody): unknown {
  const data = body.result?.data;
  if (data && typeof data === 'object' && 'json' in (data as Record<string, unknown>)) {
    return (data as { json: unknown }).json;
  }
  return data;
}

const BALANCE_KEYS = ['balance', 'available', 'hold', 'amount', 'qty'];

function assertNoInventedBalance(payload: unknown, path = '$'): void {
  if (payload === null || payload === undefined) return;
  if (Array.isArray(payload)) {
    payload.forEach((item, i) => assertNoInventedBalance(item, `${path}[${i}]`));
    return;
  }
  if (typeof payload !== 'object') return;
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    expect(BALANCE_KEYS, `${path}.${key} must not invent a balance field`).not.toContain(key.toLowerCase());
    assertNoInventedBalance(value, `${path}.${key}`);
  }
}

type MoneyMountOpts = {
  accruals?: MemoryAccrualStore;
  accrualTierLaw?: typeof publishedLaw | undefined;
  ledger?: MemoryLedger;
  freeze?: FreezeService;
};

/** A wired freeze service that reports nobody frozen (the set is KNOWN-empty). */
const noOneFrozen = { frozenIds: async () => new Set<string>() } as unknown as FreezeService;

async function mountDoors(auth: MemorySubAccountAuth, money: MoneyMountOpts = {}): Promise<FastifyInstance> {
  const router = createIdentityRouter(auth as unknown as AuthService, {} as RankService, {
    registrationOpen: true,
    actionApprovals: stubActionApprovals(),
    // The revoke door reads the money services first; these doors test ownership, so the read answers "empty".
    subAccountDelete: { assertEmpty: async () => undefined } as unknown as SubAccountDeleteService,
    ...money,
  });
  const app = Fastify({ logger: false });
  retainRawBody(app);
  await app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: {
      router,
      createContext: ({ req }) => edgeContext(req),
    } satisfies FastifyTRPCPluginOptions<typeof router>['trpcOptions'],
  });

  // Same S2S ownership door index.ts mounts for svc-trade placeOrder.
  app.get<{ Params: { subAccountId: string } }>('/internal/sub-accounts/:subAccountId', async (req, reply) => {
    if (
      verifyServiceHeaders(req.headers, INTERNAL_SECRET, {
        rawBody: rawBodyOf(req),
        mode: 'accept-both',
      }).service === null
    ) {
      return reply.code(401).send({ error: 'service credentials required', code: 'identity.unauthenticated' });
    }
    const row = await auth.getSubAccountOwnership(req.params.subAccountId);
    if (!row) {
      return reply.code(404).send({ error: 'sub-account not found', code: 'identity.sub_account_not_found' });
    }
    return row;
  });

  await app.ready();
  return app;
}

let books: MemorySubAccountAuth;
let app: FastifyInstance;

beforeAll(async () => {
  books = new MemorySubAccountAuth();
  app = await mountDoors(books);
}, 20_000);

beforeEach(() => {
  books.books.clear();
});

afterAll(async () => {
  await app.close();
});

async function post(
  app: FastifyInstance,
  path: string,
  input: Record<string, unknown> | undefined,
  headers: Record<string, string> = signedHeaders(),
): Promise<{ statusCode: number; body: WireBody }> {
  const res = await app.inject({ method: 'POST', url: `/trpc/${path}`, headers, payload: input ?? {} });
  return { statusCode: res.statusCode, body: res.json() as WireBody };
}

async function get(
  app: FastifyInstance,
  path: string,
  headers: Record<string, string> = signedHeaders(),
): Promise<{ statusCode: number; body: WireBody }> {
  const res = await app.inject({ method: 'GET', url: `/trpc/${path}`, headers });
  return { statusCode: res.statusCode, body: res.json() as WireBody };
}

describe('D26-P2-12 refuse-closed identity money doors (no invent balances)', () => {
  it('tRPC list/assertOwned/assertTransferDoor output schemas have no balance columns', () => {
    const src = readFileSync(join(here, 'router.ts'), 'utf8');
    const start = src.indexOf('subAccounts: router({');
    expect(start).toBeGreaterThanOrEqual(0);
    const block = src.slice(start, src.indexOf('affiliates: router({', start));
    expect(block).toMatch(/assertOwned:\s*scopedProcedure/);
    expect(block).toMatch(/assertTransferDoor:\s*scopedProcedure/);
    expect(block.toLowerCase()).not.toMatch(/\bbalance\b/);
    expect(block.toLowerCase()).not.toMatch(/\bavailable\b/);
    expect(block.toLowerCase()).not.toMatch(/\bhold\b/);
  });

  it('S2S ownership snapshot in index.ts stays fail-closed (401 / 404, no balance body)', () => {
    const src = readFileSync(join(here, 'index.ts'), 'utf8');
    const start = src.indexOf('/internal/sub-accounts/:subAccountId');
    expect(start).toBeGreaterThanOrEqual(0);
    const block = src.slice(start, start + 900);
    expect(block).toMatch(/serviceOfRequest/);
    expect(block).toMatch(/identity\.unauthenticated/);
    expect(block).toMatch(/identity\.sub_account_not_found/);
    expect(block).toMatch(/getSubAccountOwnership/);
    expect(block.toLowerCase()).not.toMatch(/\bbalance\b/);
  });
});

describe('D26-P2-12 public doors — ownership gate over mounted tRPC', () => {
  it('assertOwned accepts a live partition the caller owns and returns no balance', async () => {
    const mine = await books.createSubAccount(OWNER, 'bot');
    const { statusCode, body } = await post(app, 'subAccounts.assertOwned', { subAccountId: mine.id });
    expect(statusCode).toBe(200);
    const data = unwrapData(body);
    expect(data).toEqual({ id: mine.id, parentUserId: OWNER });
    assertNoInventedBalance(data);
  });

  it('assertOwned refuses a missing id over the wire — never invents primary', async () => {
    await books.createSubAccount(OWNER, 'only');
    const { statusCode, body } = await post(app, 'subAccounts.assertOwned', { subAccountId: null });
    expect(statusCode).toBe(400);
    expect(body.error?.data?.code).toBe('BAD_REQUEST');
    // Wire copy is the code key (no catalog sentence) — never a 200 default-to-primary.
    expect(body.error?.message).toBe(userCopy('auth.sub_account_required'));
  });

  it('assertOwned refuses foreign and ghost with the same denied shape (no existence oracle)', async () => {
    const theirs = await books.createSubAccount(STRANGER, 'theirs');
    const foreign = await post(app, 'subAccounts.assertOwned', { subAccountId: theirs.id });
    const ghost = await post(app, 'subAccounts.assertOwned', { subAccountId: GHOST });

    expect(foreign.statusCode).toBe(403);
    expect(ghost.statusCode).toBe(403);
    expect(foreign.body.error?.data?.code).toBe('FORBIDDEN');
    expect(ghost.body.error?.data?.code).toBe('FORBIDDEN');
    expect(foreign.body.error?.message).toBe(ghost.body.error?.message);
    expect(foreign.body.error?.message).toBe(userCopy('auth.sub_account_denied'));
  });

  it('assertOwned refuses a revoked partition over the wire', async () => {
    const dead = await books.createSubAccount(OWNER, 'dead');
    await books.revokeSubAccount(OWNER, dead.id);
    const { statusCode, body } = await post(app, 'subAccounts.assertOwned', { subAccountId: dead.id });
    expect(statusCode).toBe(403);
    expect(body.error?.data?.code).toBe('FORBIDDEN');
    // Same catalog alias as denied — public wire is not a revocation oracle.
    expect(body.error?.message).toBe(userCopy('auth.sub_account_revoked'));
  });
});

describe('D26-P2-12 public doors — cross-sub-account leak refuse', () => {
  it('assertTransferDoor refuses a foreign to-leg (cross-parent leak)', async () => {
    const mine = await books.createSubAccount(OWNER, 'from');
    const theirs = await books.createSubAccount(STRANGER, 'to');
    const { statusCode, body } = await post(app, 'subAccounts.assertTransferDoor', {
      fromSubAccountId: mine.id,
      toSubAccountId: theirs.id,
    });
    expect(statusCode).toBe(403);
    expect(body.error?.data?.code).toBe('FORBIDDEN');
    expect(body.error?.message).toBe(userCopy('auth.sub_account_denied'));
  });

  it('assertTransferDoor happy path returns ids and still invents no balance', async () => {
    const a = await books.createSubAccount(OWNER, 'from');
    const b = await books.createSubAccount(OWNER, 'to');
    const { statusCode, body } = await post(app, 'subAccounts.assertTransferDoor', {
      fromSubAccountId: a.id,
      toSubAccountId: b.id,
    });
    expect(statusCode).toBe(200);
    const data = unwrapData(body);
    expect(data).toEqual({ fromId: a.id, toId: b.id });
    assertNoInventedBalance(data);
  });

  it('list is parent-scoped — stranger does not see owner books; no balance fields', async () => {
    const mine = await books.createSubAccount(OWNER, 'mine');
    await books.createSubAccount(STRANGER, 'theirs');

    const listInput = encodeURIComponent(JSON.stringify({ limit: 200 }));
    const ownerList = await get(app, `subAccounts.list?input=${listInput}`);
    expect(ownerList.statusCode).toBe(200);
    const ownerRows = unwrapData(ownerList.body) as Array<Record<string, unknown>>;
    expect(ownerRows).toHaveLength(1);
    expect(ownerRows[0]?.id).toBe(mine.id);
    assertNoInventedBalance(ownerRows);

    const strangerList = await get(
      app,
      `subAccounts.list?input=${listInput}`,
      signedHeaders(principal({ sub: STRANGER, userId: STRANGER, scopes: ['identity:read'] })),
    );
    expect(strangerList.statusCode).toBe(200);
    const strangerRows = unwrapData(strangerList.body) as Array<Record<string, unknown>>;
    expect(strangerRows).toHaveLength(1);
    expect(strangerRows[0]?.id).not.toBe(mine.id);
    assertNoInventedBalance(strangerRows);
  });

  it('revoke over the wire is self-only — stranger cannot retire owner books', async () => {
    const mine = await books.createSubAccount(OWNER, 'keep');
    const attack = await post(
      app,
      'subAccounts.revoke',
      { subAccountId: mine.id },
      signedHeaders(principal({ sub: STRANGER, userId: STRANGER })),
    );
    expect(attack.statusCode).toBe(200);
    expect(unwrapData(attack.body)).toEqual({ revoked: false });
    expect(books.books.get(mine.id)?.revoked).toBe(false);
  });
});

describe('D26-P2-12 public doors — S2S ownership HTTP snapshot', () => {
  it('refuses without service credentials', async () => {
    const mine = await books.createSubAccount(OWNER, 's2s');
    const res = await app.inject({ method: 'GET', url: `/internal/sub-accounts/${mine.id}` });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'identity.unauthenticated' });
  });

  it('404 unknown id — never invents a live partition', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/internal/sub-accounts/${GHOST}`,
      headers: serviceAuthHeadersForBody('svc-trade', INTERNAL_SECRET, ''),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'identity.sub_account_not_found' });
  });

  it('returns parent + revoked only — no invented balance', async () => {
    const mine = await books.createSubAccount(OWNER, 's2s-book');
    const live = await app.inject({
      method: 'GET',
      url: `/internal/sub-accounts/${mine.id}`,
      headers: serviceAuthHeadersForBody('svc-trade', INTERNAL_SECRET, ''),
    });
    expect(live.statusCode).toBe(200);
    expect(live.json()).toEqual({ id: mine.id, parentUserId: OWNER, revoked: false });
    assertNoInventedBalance(live.json());

    await books.revokeSubAccount(OWNER, mine.id);
    const retired = await app.inject({
      method: 'GET',
      url: `/internal/sub-accounts/${mine.id}`,
      headers: serviceAuthHeadersForBody('svc-trade', INTERNAL_SECRET, ''),
    });
    expect(retired.statusCode).toBe(200);
    expect(retired.json()).toEqual({ id: mine.id, parentUserId: OWNER, revoked: true });
    assertNoInventedBalance(retired.json());
  });
});

describe('D26-P2-12 spine reprove — transfer door unset / malformed over wire', () => {
  it('assertTransferDoor refuses a missing to-leg — never invents primary', async () => {
    const mine = await books.createSubAccount(OWNER, 'from-only');
    const { statusCode, body } = await post(app, 'subAccounts.assertTransferDoor', {
      fromSubAccountId: mine.id,
      toSubAccountId: null,
    });
    expect(statusCode).toBe(400);
    expect(body.error?.data?.code).toBe('BAD_REQUEST');
    expect(body.error?.message).toBe(userCopy('auth.sub_account_required'));
  });

  it('assertTransferDoor refuses a missing from-leg — never invents primary', async () => {
    const mine = await books.createSubAccount(OWNER, 'to-only');
    const { statusCode, body } = await post(app, 'subAccounts.assertTransferDoor', {
      fromSubAccountId: null,
      toSubAccountId: mine.id,
    });
    expect(statusCode).toBe(400);
    expect(body.error?.data?.code).toBe('BAD_REQUEST');
    expect(body.error?.message).toBe(userCopy('auth.sub_account_required'));
  });

  it('assertTransferDoor refuses the same partition twice', async () => {
    const mine = await books.createSubAccount(OWNER, 'solo');
    const { statusCode, body } = await post(app, 'subAccounts.assertTransferDoor', {
      fromSubAccountId: mine.id,
      toSubAccountId: mine.id,
    });
    expect(statusCode).toBe(400);
    expect(body.error?.data?.code).toBe('BAD_REQUEST');
    expect(body.error?.message).toBe(userCopy('auth.sub_account_same'));
  });

  it('assertTransferDoor refuses a foreign from-leg (cross-parent leak)', async () => {
    const theirs = await books.createSubAccount(STRANGER, 'from');
    const mine = await books.createSubAccount(OWNER, 'to');
    const { statusCode, body } = await post(app, 'subAccounts.assertTransferDoor', {
      fromSubAccountId: theirs.id,
      toSubAccountId: mine.id,
    });
    expect(statusCode).toBe(403);
    expect(body.error?.data?.code).toBe('FORBIDDEN');
    expect(body.error?.message).toBe(userCopy('auth.sub_account_denied'));
  });

  it('assertTransferDoor refuses when either side is revoked', async () => {
    const live = await books.createSubAccount(OWNER, 'live');
    const dead = await books.createSubAccount(OWNER, 'dead');
    await books.revokeSubAccount(OWNER, dead.id);

    const fromRevoked = await post(app, 'subAccounts.assertTransferDoor', {
      fromSubAccountId: dead.id,
      toSubAccountId: live.id,
    });
    expect(fromRevoked.statusCode).toBe(403);
    expect(fromRevoked.body.error?.data?.code).toBe('FORBIDDEN');

    const toRevoked = await post(app, 'subAccounts.assertTransferDoor', {
      fromSubAccountId: live.id,
      toSubAccountId: dead.id,
    });
    expect(toRevoked.statusCode).toBe(403);
    expect(toRevoked.body.error?.data?.code).toBe('FORBIDDEN');
  });
});

describe('D26-P2-12 spine reprove — affiliates.payout money routing over wire', () => {
  let moneyApp: FastifyInstance;
  let ledger: MemoryLedger;
  let store: MemoryAccrualStore;

  beforeEach(async () => {
    ledger = await fundedPayoutLedger();
    store = new MemoryAccrualStore();
    await store.saveRows([accrualRow()]);
    moneyApp = await mountDoors(books, { accruals: store, accrualTierLaw: publishedLaw, ledger, freeze: noOneFrozen });
  });

  afterEach(async () => {
    await moneyApp.close();
  });

  it('refuses without admin:write over the wire — ledger untouched', async () => {
    const { statusCode, body } = await post(
      moneyApp,
      'affiliates.payout',
      { feeEventId: FEE_EVT },
      signedHeaders(principal({ scopes: ['identity:read'] })),
    );
    expect(statusCode).toBe(403);
    expect(body.error?.data?.code).toBe('FORBIDDEN');
    expect(await bal(ledger, userAvailable(BENE, ASSET))).toBe('0');
    expect(await bal(ledger, houseFees('identity', ASSET))).toBe('100');
  });

  it('refuses unpublished rate law over the wire — rates_unset, ledger untouched', async () => {
    const unwired = await mountDoors(books, { accruals: store, ledger });
    try {
      const { statusCode, body } = await post(unwired, 'affiliates.payout', { feeEventId: FEE_EVT }, adminHeaders());
      expect(statusCode).toBe(412);
      expect(body.error?.data?.code).toBe('PRECONDITION_FAILED');
      expect(body.error?.message).toContain('DIRECTION §8');
      expect(await bal(ledger, userAvailable(BENE, ASSET))).toBe('0');
      expect(await bal(ledger, houseFees('identity', ASSET))).toBe('100');
    } finally {
      await unwired.close();
    }
  });

  it('rate refusal wins over a missing feeEventId on the wire', async () => {
    const unwired = await mountDoors(books, { accruals: store });
    try {
      const { statusCode, body } = await post(unwired, 'affiliates.payout', {}, adminHeaders());
      expect(statusCode).toBe(412);
      expect(body.error?.data?.code).toBe('PRECONDITION_FAILED');
      expect(body.error?.message).toContain('DIRECTION §8');
      expect(body.error?.message).not.toContain('feeEventId is required');
    } finally {
      await unwired.close();
    }
  });

  it('refuses ledger_unwired over the wire when rates are published — no silent payment', async () => {
    const noLedger = await mountDoors(books, { accruals: store, accrualTierLaw: publishedLaw, freeze: noOneFrozen });
    try {
      const { statusCode, body } = await post(noLedger, 'affiliates.payout', { feeEventId: FEE_EVT }, adminHeaders());
      expect(statusCode).toBe(412);
      expect(body.error?.data?.code).toBe('PRECONDITION_FAILED');
      expect(body.error?.message).toContain('no ledger client');
    } finally {
      await noLedger.close();
    }
  });

  it('refuses freeze_unwired over the wire when the freeze service is unset — no payment, no plan', async () => {
    const noFreeze = await mountDoors(books, { accruals: store, accrualTierLaw: publishedLaw, ledger });
    try {
      for (const input of [
        { feeEventId: FEE_EVT, approvalId: 'appr-1', operationId: 'op-1' },
        { feeEventId: FEE_EVT, dryRun: true },
      ]) {
        const { statusCode, body } = await post(noFreeze, 'affiliates.payout', input, adminHeaders());
        expect(statusCode).toBe(412);
        expect(body.error?.data?.code).toBe('PRECONDITION_FAILED');
        expect(body.error?.message).toContain('no freeze service');
      }
      expect(await bal(ledger, userAvailable(BENE, ASSET))).toBe('0');
      expect(await bal(ledger, houseFees('identity', ASSET))).toBe('100');
    } finally {
      await noFreeze.close();
    }
  });

  it('dryRun over the wire plans without posting and invents no balance fields', async () => {
    const { statusCode, body } = await post(moneyApp, 'affiliates.payout', { feeEventId: FEE_EVT, dryRun: true }, adminHeaders());
    expect(statusCode).toBe(200);
    const data = unwrapData(body) as Record<string, unknown>;
    expect(data.posted).toBe(false);
    expect(data.totalCommission).toBe('10');
    assertNoInventedBalance(data);
    expect(await bal(ledger, userAvailable(BENE, ASSET))).toBe('0');
    expect(await bal(ledger, houseFees('identity', ASSET))).toBe('100');
    expect(await bal(ledger, rewardsEngine(ASSET))).toBe('0');
  });

  it('payout over the wire without confirmOperatorId refuses and moves nothing', async () => {
    const { statusCode, body } = await post(moneyApp, 'affiliates.payout', { feeEventId: FEE_EVT }, adminHeaders());
    expect(statusCode).toBe(412);
    expect(body.error?.data?.code).toBe('PRECONDITION_FAILED');
    expect(body.error?.message).toMatch(/typed-in second name|approvalId/);
    expect(await bal(ledger, userAvailable(BENE, ASSET))).toBe('0');
    expect(await bal(ledger, houseFees('identity', ASSET))).toBe('100');
  });

  it('payout over the wire posts once; retry leaves balances unchanged', async () => {
    const first = await post(
      moneyApp,
      'affiliates.payout',
      { feeEventId: FEE_EVT, approvalId: 'appr-1', operationId: 'op-1' },
      adminHeaders(),
    );
    const second = await post(
      moneyApp,
      'affiliates.payout',
      { feeEventId: FEE_EVT, approvalId: 'appr-1', operationId: 'op-1' },
      adminHeaders(),
    );
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    const firstData = unwrapData(first.body) as { posted: boolean; idempotencyKeys: string[] };
    const secondData = unwrapData(second.body) as { idempotencyKeys: string[] };
    expect(firstData.posted).toBe(true);
    expect(secondData.idempotencyKeys).toEqual(firstData.idempotencyKeys);
    assertNoInventedBalance(firstData);
    expect(await bal(ledger, userAvailable(BENE, ASSET))).toBe('10');
    expect(await bal(ledger, houseFees('identity', ASSET))).toBe('90');
    expect(await bal(ledger, rewardsEngine(ASSET))).toBe('0');
  });
});
