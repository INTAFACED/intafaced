/**
 * Q-bank leftover — card-sim is not a live issuer.
 *
 * H8b cooling is already PG-hard on main; this file does not recut it.
 *
 * Live `BANK_CARD_ISSUER=card-sim` / `none` must refuse issue and authorise
 * before a card row or a withdrawHold. `tellIssuer` swallows adapter errors
 * after the ledger has moved, so HTTP must hit `assertIssuerMayMutate`, not
 * the adapter methods.
 *
 * PG-hard: never `describe.skip` / `postgresAvailable`. CI uses TEST_DATABASE_URL.
 * Local without that env starts Testcontainers `postgres:16-alpine`. Docker/PG
 * down is a failed suite, not a green skip.
 *
 * Door: Fastify+tRPC `/trpc` as index.ts mounts — not createCaller-only.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { MemoryLedger, parseAmount as amt, recipes, userAvailable } from '@intafaced/ledger-client';
import { memoryLedgerHistory } from '../analytics/ledger-history.js';
import { createBankServices } from '../bank-service.js';
import { stubApprovalConsumer } from '../action-approval-consume.js';
import { createBankRouter, type BankRouter } from '../router.js';
import { cardIssuerFor } from './issuer.js';

const SECRET = 'bank-q-card-sim-not-issuer-http-secret-32';
const HOLDER = '11111111-1111-4111-8111-111111111111';
const OPERATOR = '33333333-3333-4333-8333-333333333333';
const CONFIRM = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const APPROVAL = { approvalId: 'appr-1', operationId: 'op-1' } as const;
const Q_BANK_IMAGE = 'postgres:16-alpine';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

type WireBody = {
  result?: { data?: unknown };
  error?: { message?: string; data?: { code?: string; httpStatus?: number } };
};

async function openQBankAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) {
    return { url: envUrl, stop: async () => undefined };
  }
  try {
    const container = await new PostgreSqlContainer(Q_BANK_IMAGE)
      .withDatabase('intafaced_qbank_card_test')
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
      `Q-bank: card-sim is not a live issuer is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${Q_BANK_IMAGE}: ${msg}`,
    );
  }
}

describe('Q-bank card-sim ≠ live issuer hitch (source)', () => {
  it('Q-bank card-sim money suite is not skip-green (no postgresAvailable / describe.skip)', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bpostgresAvailable\s*\(/);
    expect(src).not.toMatch(/describe\.skip\s*\(/);
    expect(src).not.toMatch(/\bit\.skip\s*\(/);
  });

  it('assertIssuerMayMutate runs before issue INSERT and before authorize hold', () => {
    const src = readFileSync(join(here, 'card-service.ts'), 'utf8');
    const assertFn = src.indexOf('private assertIssuerMayMutate()');
    const issueFn = src.indexOf('async issue(');
    const issueAssert = src.indexOf('this.assertIssuerMayMutate();', issueFn);
    const insert = src.indexOf('INSERT INTO bank.cards', issueFn);
    const authorizeFn = src.indexOf('async authorize(');
    const authAssert = src.indexOf('this.assertIssuerMayMutate();', authorizeFn);
    const hold = src.indexOf('recipes.withdrawHold({', authorizeFn);
    expect(assertFn).toBeGreaterThan(-1);
    expect(issueAssert).toBeGreaterThan(issueFn);
    expect(insert).toBeGreaterThan(issueAssert);
    expect(authAssert).toBeGreaterThan(authorizeFn);
    expect(hold).toBeGreaterThan(authAssert);
  });
});

const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-bank' });

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    sub: HOLDER,
    userId: HOLDER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['bank:read', 'bank:write'],
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
    'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
    'x-intafaced-region': 'DE',
    'content-type': 'application/json',
  };
}

const treasury = () => principal({ sub: OPERATOR, userId: OPERATOR, scopes: ['admin:treasury'] });

async function mountDoors(bank: ReturnType<typeof createBankServices>): Promise<FastifyInstance> {
  const router = createBankRouter(bank, { approvals: stubApprovalConsumer(CONFIRM) });
  const app = Fastify({ logger: false });
  await app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: {
      router,
      createContext: ({ req }) => edgeContext(req),
    } satisfies FastifyTRPCPluginOptions<BankRouter>['trpcOptions'],
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
  path: string,
  headers: Record<string, string> = signedHeaders(),
): Promise<{ statusCode: number; body: WireBody }> {
  const res = await app.inject({ method: 'GET', url: `/trpc/${path}`, headers });
  return { statusCode: res.statusCode, body: res.json() as WireBody };
}

function expectNamedRefuse(body: WireBody, named: string) {
  expect(body.error?.data?.code).toBe('PRECONDITION_FAILED');
  const wire = JSON.stringify(body.error);
  expect(wire).toMatch(new RegExp(named.replace('.', '\\.')));
}

function procedureData(body: WireBody): unknown {
  const data = body.result?.data;
  if (data && typeof data === 'object' && data !== null && 'json' in data) {
    return (data as { json: unknown }).json;
  }
  return data;
}

/**
 * Issue / programme / live-authorise refuse before SQL. A throwing sql proves
 * the HTTP door does not look up or insert a card (and does not need Docker).
 */
function sqlMustNotRun(): never {
  throw new Error('sql must not run — card-sim/none live mutation refuses before a row');
}

describe('svc-bank card-sim is not a live issuer (HTTP /trpc, before SQL)', () => {
  it('HTTP cards.programme under live card-sim stays simulated — not a BIN', async () => {
    const ledger = new MemoryLedger();
    const bank = createBankServices(sqlMustNotRun as never, ledger, memoryLedgerHistory(ledger), {
      cards: { issuer: cardIssuerFor('card-sim', { NODE_ENV: 'production' }) },
    });
    const app = await mountDoors(bank);
    const res = await get(app, 'cards.programme');
    expect(res.statusCode).toBe(200);
    expect(procedureData(res.body)).toEqual({
      id: 'card-sim',
      simulated: true,
      displayName: 'Simulated card (no card programme)',
    });
    await app.close();
  });

  it('HTTP /trpc/cards.issue under live card-sim named-refuses before SQL', async () => {
    const ledger = new MemoryLedger();
    const bank = createBankServices(sqlMustNotRun as never, ledger, memoryLedgerHistory(ledger), {
      cards: { issuer: cardIssuerFor('card-sim', { NODE_ENV: 'production' }) },
    });
    const app = await mountDoors(bank);
    const issued = await post(app, 'cards.issue', {
      cardId: randomUUID(),
      assetId: 'USDT',
      perAuthorizationLimit: '100',
    });
    expect(issued.statusCode).toBe(412);
    expectNamedRefuse(issued.body, 'bank.card_sim_not_live');
    expect(issued.body.result).toBeUndefined();
    await app.close();
    expect(ledger.journal()).toEqual([]);
  });

  it('HTTP /trpc/ops.cardAuthorize under live card-sim refuses before SQL/hold', async () => {
    const ledger = new MemoryLedger();
    await ledger.post(
      recipes.deposit({
        userId: HOLDER,
        assetId: 'USDT',
        amount: amt('500'),
        rail: 'test',
        railRef: `${HOLDER}:${randomUUID()}`,
      }),
    );
    const bank = createBankServices(sqlMustNotRun as never, ledger, memoryLedgerHistory(ledger), {
      cards: { issuer: cardIssuerFor('card-sim', { APP_ENV: 'prod' }) },
    });
    const app = await mountDoors(bank);
    const auth = await post(
      app,
      'ops.cardAuthorize',
      {
        cardId: randomUUID(),
        authorizationRef: `auth-${randomUUID()}`,
        amount: '10',
        confirmOperatorId: CONFIRM,
        ...APPROVAL,
      },
      signedHeaders(treasury()),
    );
    expect(auth.statusCode).toBe(412);
    expectNamedRefuse(auth.body, 'bank.card_sim_not_live');
    await app.close();
    expect(ledger.journal().some((tx) => tx.reason === 'withdraw.held')).toBe(false);
    expect((await ledger.balance(userAvailable(HOLDER, 'USDT'))).amount).toBe(amt('500'));
  });

  it('HTTP /trpc/cards.issue under none (live posture) is bank.no_card_issuer before SQL', async () => {
    const ledger = new MemoryLedger();
    const bank = createBankServices(sqlMustNotRun as never, ledger, memoryLedgerHistory(ledger), {
      cards: { issuer: cardIssuerFor('none', { NODE_ENV: 'production', APP_ENV: 'prod' }) },
    });
    const app = await mountDoors(bank);
    const programme = await get(app, 'cards.programme');
    expect(programme.statusCode).toBe(200);
    expect(procedureData(programme.body)).toEqual({
      id: 'none',
      simulated: true,
      displayName: 'No card programme',
    });

    const issued = await post(app, 'cards.issue', {
      cardId: randomUUID(),
      assetId: 'USDT',
      perAuthorizationLimit: '100',
    });
    expect(issued.statusCode).toBe(412);
    expectNamedRefuse(issued.body, 'bank.no_card_issuer');
    await app.close();
    expect(ledger.journal()).toEqual([]);
  });
});

describe('svc-bank card-sim is not a live issuer (HTTP /trpc, PG-hard rows)', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase;
  let sql: TestDatabase['sql'];
  let ledger: MemoryLedger;

  beforeAll(async () => {
    const admin = await openQBankAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'bank', url: admin.url, migrations });
    sql = db.sql;
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  beforeEach(async () => {
    await sql`
      TRUNCATE bank.card_cashback, bank.card_settlements, bank.card_conversions,
               bank.card_authorizations, bank.cards
      RESTART IDENTITY CASCADE
    `;
    ledger = new MemoryLedger();
  });

  async function fund(userId: string, value: string) {
    await ledger.post(
      recipes.deposit({
        userId,
        assetId: 'USDT',
        amount: amt(value),
        rail: 'test',
        railRef: `${userId}:${randomUUID()}`,
      }),
    );
  }

  it('HTTP cards.programme under live card-sim stays simulated — not a BIN', async () => {
    const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      cards: { issuer: cardIssuerFor('card-sim', { NODE_ENV: 'production' }) },
    });
    const app = await mountDoors(bank);
    const res = await get(app, 'cards.programme');
    expect(res.statusCode).toBe(200);
    expect(procedureData(res.body)).toEqual({
      id: 'card-sim',
      simulated: true,
      displayName: 'Simulated card (no card programme)',
    });
    await app.close();
  });

  it('HTTP /trpc/cards.issue under live card-sim named-refuses; zero card rows', async () => {
    const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      cards: { issuer: cardIssuerFor('card-sim', { NODE_ENV: 'production' }) },
    });
    const app = await mountDoors(bank);
    const issued = await post(app, 'cards.issue', {
      cardId: randomUUID(),
      assetId: 'USDT',
      perAuthorizationLimit: '100',
    });
    expect(issued.statusCode).toBe(412);
    expectNamedRefuse(issued.body, 'bank.card_sim_not_live');
    expect(issued.body.result).toBeUndefined();
    await app.close();

    const rows = await sql<Array<{ count: string }>>`SELECT count(*)::text AS count FROM bank.cards`;
    expect(rows[0]?.count).toBe('0');
    expect(ledger.journal().some((tx) => tx.reason === 'withdraw.held')).toBe(false);
  });

  it('HTTP /trpc/ops.cardAuthorize under live card-sim refuses before hold on an existing sim card', async () => {
    await fund(HOLDER, '500');
    const armed = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      cards: { issuer: cardIssuerFor('card-sim', { live: false }) },
    });
    const armedApp = await mountDoors(armed);
    const issued = await post(armedApp, 'cards.issue', {
      cardId: randomUUID(),
      assetId: 'USDT',
      perAuthorizationLimit: '100',
    });
    expect(issued.statusCode).toBe(200);
    const cardId = (procedureData(issued.body) as { id: string; simulated: boolean }).id;
    expect((procedureData(issued.body) as { simulated: boolean }).simulated).toBe(true);
    await armedApp.close();

    const live = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      cards: { issuer: cardIssuerFor('card-sim', { APP_ENV: 'prod' }) },
    });
    const liveApp = await mountDoors(live);
    const auth = await post(
      liveApp,
      'ops.cardAuthorize',
      {
        cardId,
        authorizationRef: `auth-${randomUUID()}`,
        amount: '10',
        confirmOperatorId: CONFIRM,
        ...APPROVAL,
      },
      signedHeaders(treasury()),
    );
    expect(auth.statusCode).toBe(412);
    expectNamedRefuse(auth.body, 'bank.card_sim_not_live');
    await liveApp.close();

    expect((await sql<Array<{ count: string }>>`SELECT count(*)::text AS count FROM bank.card_authorizations`)[0]?.count).toBe('0');
    expect(ledger.journal().some((tx) => tx.reason === 'withdraw.held')).toBe(false);
    expect((await ledger.balance(userAvailable(HOLDER, 'USDT'))).amount).toBe(amt('500'));
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('HTTP /trpc/cards.issue under none (live posture) is bank.no_card_issuer; zero card rows', async () => {
    const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      cards: { issuer: cardIssuerFor('none', { NODE_ENV: 'production', APP_ENV: 'prod' }) },
    });
    const app = await mountDoors(bank);
    const programme = await get(app, 'cards.programme');
    expect(programme.statusCode).toBe(200);
    expect(procedureData(programme.body)).toEqual({
      id: 'none',
      simulated: true,
      displayName: 'No card programme',
    });

    const issued = await post(app, 'cards.issue', {
      cardId: randomUUID(),
      assetId: 'USDT',
      perAuthorizationLimit: '100',
    });
    expect(issued.statusCode).toBe(412);
    expectNamedRefuse(issued.body, 'bank.no_card_issuer');
    await app.close();

    const rows = await sql<Array<{ count: string }>>`SELECT count(*)::text AS count FROM bank.cards`;
    expect(rows[0]?.count).toBe('0');
  });
});
