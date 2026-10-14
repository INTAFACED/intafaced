/**
 * Unit card (D26-P2-01e):
 * Promise: earn / cards / ramps refuse invent through mounted Fastify+tRPC
 *   public doors (`/trpc` as index.ts mounts, signed createEdgeContext) —
 *   not createCaller-only or service-unit-only guards.
 * Break: underfunded earn accrual could invent yield; JIT card auth could invent
 *   an FX rate when rates are unset; ramp money paths could invent a rail or
 *   a fiat PSP when the programme / socket is absent.
 * Done bar:
 *   · ops.accrueInterest on an unfunded pool → PRECONDITION_FAILED /
 *     bank.pool_underfunded; principal untouched; day not consumed.
 *   · cards.issue + ops.cardAuthorize with settlement ≠ funding and no rates →
 *     PRECONDITION_FAILED / bank.mark_missing; no authorization row; no hold.
 *   · ramps.offramp / ops.creditOnramp with programme none → PRECONDITION_FAILED /
 *     bank.no_ramp_rail; fiat kind → bank.fiat_ramp_socket before any row.
 * Class: N (honesty) / M surface (no invent yields or §8 rates). Leverage:
 *   createBankRouter + Fastify TRPC mount + MemoryLedger (Phase A IN).
 *
 * H8a PG-hard: this file never `describe.skip` / `postgresAvailable`. CI uses
 * TEST_DATABASE_URL (per-run database via `createTestDatabase` so schema-qualified
 * `bank.*` SQL stays on `bank`). Local without that env starts Testcontainers
 * `postgres:16-alpine`. Docker/PG down is a failed suite, not a green skip.
 * The admin URL is `TEST_DATABASE_URL`, not `TEST_DATABASE_URL_BANK`: creating a
 * database needs CREATEDB, which the per-service roles deliberately lack.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import Fastify, { type FastifyInstance } from 'fastify';
import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { SANCTIONS_REGIONS_ENV, SANCTIONS_SOURCE_ENV, SCREENING_FAIL_CLOSED_ENV } from '@intafaced/config';
import {
  createEdgeContext,
  encodePrincipal,
  rawBodyOf,
  retainRawBody,
  serviceAuthHeadersForBody,
  signPrincipalHeader,
  verifyServiceHeaders,
} from '@intafaced/contracts';
import { MemoryLedger, parseAmount as amt, recipes, userAvailable } from '@intafaced/ledger-client';
import { memoryLedgerHistory } from './analytics/ledger-history.js';
import { createBankServices } from './bank-service.js';
import { CARD_ISSUER_SETTINGS, cardIssuerFor } from './cards/issuer.js';
import { noConversionRates } from './cards/conversion.js';
import { stubApprovalConsumer } from './action-approval-consume.js';
import { createBankRouter, type BankRouter } from './router.js';
import { CRYPTO_LEDGER_PROGRAMME, NO_RAMP_PROGRAMME, RAMP_SETTINGS, rampProgrammeFor } from './ramps/rails.js';

const SECRET = 'bank-promise-falsify-public-doors-secret-32b';
const HOLDER = '11111111-1111-4111-8111-111111111111';
const OPERATOR = '33333333-3333-4333-8333-333333333333';
const CONFIRM = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const APPROVAL = { approvalId: 'appr-1', operationId: 'op-1' } as const;

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', 'drizzle');
const MIGRATIONS = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

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
      `H8a: svc-bank promise-falsify-public-doors is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}

type WireBody = {
  result?: { data?: unknown };
  error?: { message?: string; data?: { code?: string; httpStatus?: number; intafacedCode?: string } };
};

describe('promise-falsify-public-doors (source)', () => {
  it('H8a money suite is not skip-green (no postgresAvailable / describe.skip)', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bpostgresAvailable\s*\(/);
    expect(src).not.toMatch(/describe\.skip\s*\(/);
    expect(src).not.toMatch(/\bit\.skip\s*\(/);
  });
});

describe('D26-P2-01e refuse-closed defaults (no invent)', () => {
  it('card issuer silence is none — never the simulator', () => {
    expect([...CARD_ISSUER_SETTINGS]).toEqual(['none', 'card-sim']);
    expect(cardIssuerFor('none').programme.id).toBe('none');
  });

  it('conversion rates unset expose an empty mark set — not a synthetic FX', async () => {
    expect((await noConversionRates.marks(['BTC', 'USDT', 'IFC'], 'USDT')).size).toBe(0);
  });

  it('ramp silence is none — every money path must refuse bank.no_ramp_rail', () => {
    expect([...RAMP_SETTINGS]).toEqual(['none', 'crypto-ledger']);
    expect(rampProgrammeFor('none')).toBe(NO_RAMP_PROGRAMME);
    expect(rampProgrammeFor('none').cryptoRail).toBeNull();
  });
});

describe('D26-P2-01e public doors (PG-hard)', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-bank', internalSecret: SECRET });

  beforeAll(async () => {
    const admin = await openH8aAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'bank', url: admin.url, migrations: MIGRATIONS });
    sql = db.sql;
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  function principal(overrides: Partial<Principal> = {}): Principal {
    return {
      sub: HOLDER,
      userId: HOLDER,
      sid: '22222222-2222-4222-8222-222222222222',
      scopes: ['bank:read', 'bank:write', 'trade:withdraw'],
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

  function caller(bank: ReturnType<typeof createBankServices>, p: Principal = principal(), service: string | null = null) {
    const raw = encodePrincipal(p);
    return createBankRouter(bank, { approvals: stubApprovalConsumer(CONFIRM) }).createCaller({
      ...edgeContext({
        headers: {
          'x-intafaced-principal': raw,
          'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
          'x-intafaced-region': 'DE',
        },
        id: `req-${randomUUID()}`,
      }),
      service,
    });
  }

  function jobHeaders(payload: Record<string, unknown>, p: Principal = treasury()): Record<string, string> {
    const body = JSON.stringify(payload);
    return {
      ...signedHeaders(p),
      ...serviceAuthHeadersForBody('svc-bank', SECRET, body),
    };
  }

  /** Same Fastify+tRPC mount as index.ts — the public door, not createCaller theater. */
  async function mountDoors(bank: ReturnType<typeof createBankServices>): Promise<FastifyInstance> {
    const router = createBankRouter(bank, { approvals: stubApprovalConsumer(CONFIRM) });
    const app = Fastify({ logger: false });
    await app.register(fastifyTRPCPlugin, {
      prefix: '/trpc',
      trpcOptions: {
        router,
        createContext: ({ req }) => {
          const ctx = edgeContext(req);
          const rawBody = typeof req.body === 'string' ? { retained: true as const, bytes: Buffer.from(req.body, 'utf8') } : rawBodyOf(req);
          const { service } = verifyServiceHeaders(req.headers, SECRET, {
            rawBody,
            mode: 'require',
          });
          return { ...ctx, service };
        },
      } satisfies FastifyTRPCPluginOptions<BankRouter>['trpcOptions'],
    });
    retainRawBody(app);
    await app.ready();
    return app;
  }

  async function post(
    app: FastifyInstance,
    path: string,
    input: Record<string, unknown>,
    headers: Record<string, string> = signedHeaders(),
  ): Promise<{ statusCode: number; body: WireBody }> {
    const body = JSON.stringify(input);
    const res = await app.inject({
      method: 'POST',
      url: `/trpc/${path}`,
      headers: { 'content-type': 'application/json', ...headers },
      payload: body,
    });
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

  async function fund(ledger: MemoryLedger, userId: string, assetId: string, value: string) {
    await ledger.post(
      recipes.deposit({
        userId,
        assetId,
        amount: amt(value),
        rail: 'test',
        railRef: `${userId}:${assetId}:${randomUUID()}`,
      }),
    );
  }

  describe('D26-P2-01e public doors — earn refuse invent yields', () => {
    let ledger: MemoryLedger;
    let bank: ReturnType<typeof createBankServices>;

    beforeEach(async () => {
      await sql`
        TRUNCATE bank.interest_accruals, bank.earn_positions, bank.earn_pools
        RESTART IDENTITY CASCADE
      `;
      ledger = new MemoryLedger();
      bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger));
    });

    it('ops.accrueInterest refuses an unfunded pool by name and invents no yield', async () => {
      const pool = await bank.earn.createPool({
        assetId: 'USDT',
        kind: 'flexible',
        name: 'Unfunded invent probe',
        aprBps: 3650,
      });
      await fund(ledger, HOLDER, 'USDT', '1000');
      // Seed position with a past opened_at so the accrual day is interest-eligible.
      // The refuse under test is the ops.accrueInterest public door, not deposit.
      await bank.earn.deposit({
        positionId: randomUUID(),
        poolId: pool.id,
        userId: HOLDER,
        amount: amt('1000'),
        now: new Date('2026-03-01T00:00:00.000Z'),
      });
      expect((await ledger.balance(userAvailable(HOLDER, 'USDT'))).amount).toBe(0n);

      const ops = caller(bank, treasury(), 'svc-bank');
      await expect(ops.ops.accrueInterest({ poolId: pool.id, at: '2026-03-02T00:00:00.000Z' })).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
        cause: { code: 'bank.pool_underfunded' },
      });

      // No invented interest in available; accrual day not consumed.
      expect((await ledger.balance(userAvailable(HOLDER, 'USDT'))).amount).toBe(0n);
      const rows = await sql`SELECT id FROM bank.interest_accruals WHERE pool_id = ${pool.id}`;
      expect(rows).toHaveLength(0);
    });

    it('ops.accrueInterest (all pools) reports underfunded failure without inventing paid', async () => {
      const empty = await bank.earn.createPool({
        assetId: 'USDT',
        kind: 'flexible',
        name: 'Empty first',
        aprBps: 5000,
      });
      await fund(ledger, HOLDER, 'USDT', '1000');
      await bank.earn.deposit({
        positionId: randomUUID(),
        poolId: empty.id,
        userId: HOLDER,
        amount: amt('1000'),
        now: new Date('2026-03-01T00:00:00.000Z'),
      });

      const ops = caller(bank, treasury(), 'svc-bank');
      const report = await ops.ops.accrueInterest({ at: '2026-03-02T00:00:00.000Z' });

      expect(report.failures).toEqual(
        expect.arrayContaining([expect.objectContaining({ poolId: empty.id, code: 'bank.pool_underfunded' })]),
      );
      expect(report.results.some((r) => r.poolId === empty.id)).toBe(false);
      expect((await ledger.balance(userAvailable(HOLDER, 'USDT'))).amount).toBe(0n);
    });

    it('HTTP /trpc/ops.accrueInterest refuses unfunded pool; retry proves the day was not consumed', async () => {
      const pool = await bank.earn.createPool({
        assetId: 'USDT',
        kind: 'flexible',
        name: 'HTTP unfunded day',
        aprBps: 3650,
      });
      await fund(ledger, HOLDER, 'USDT', '1000');
      await bank.earn.deposit({
        positionId: randomUUID(),
        poolId: pool.id,
        userId: HOLDER,
        amount: amt('1000'),
        now: new Date('2026-03-01T00:00:00.000Z'),
      });

      const app = await mountDoors(bank);
      const firstInput = { poolId: pool.id, at: '2026-03-02T00:00:00.000Z' };
      const first = await post(app, 'ops.accrueInterest', firstInput, jobHeaders(firstInput));
      expect(first.statusCode).toBe(412);
      expectNamedRefuse(first.body, 'bank.pool_underfunded');

      const secondInput = { poolId: pool.id, at: '2026-03-02T12:00:00.000Z' };
      const second = await post(app, 'ops.accrueInterest', secondInput, jobHeaders(secondInput));
      expect(second.statusCode).toBe(412);
      expectNamedRefuse(second.body, 'bank.pool_underfunded');
      await app.close();

      expect(await sql`SELECT id FROM bank.interest_accruals WHERE pool_id = ${pool.id}`).toHaveLength(0);
      expect(ledger.journal().some((tx) => tx.reason === 'bank.earn.interest')).toBe(false);
      expect((await ledger.balance(userAvailable(HOLDER, 'USDT'))).amount).toBe(0n);
    });
  });

  describe('D26-P2-01e public doors — cards refuse invent rates', () => {
    let ledger: MemoryLedger;
    let bank: ReturnType<typeof createBankServices>;

    beforeEach(async () => {
      await sql`
        TRUNCATE bank.card_cashback, bank.card_settlements, bank.card_conversions,
                 bank.card_authorizations, bank.cards
        RESTART IDENTITY CASCADE
      `;
      ledger = new MemoryLedger();
      // Simulator reachable, rates unset — shipping honest default for FX.
      bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
        cards: { issuer: cardIssuerFor('card-sim') },
      });
    });

    it('ops.cardAuthorize refuses JIT conversion when rates are unset (no invent FX)', async () => {
      await fund(ledger, HOLDER, 'BTC', '1');
      const user = caller(bank);
      const card = await user.cards.issue({
        cardId: randomUUID(),
        assetId: 'BTC',
        settlementAssetId: 'USDT',
        perAuthorizationLimit: '1',
      });

      const ops = caller(bank, treasury());
      await expect(
        ops.ops.cardAuthorize({
          cardId: card.id,
          authorizationRef: `auth-${randomUUID()}`,
          amount: '100',
          confirmOperatorId: CONFIRM,
          ...APPROVAL,
        }),
      ).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
        cause: { code: 'bank.mark_missing' },
      });

      expect(await user.cards.authorizations({ cardId: card.id, limit: 50 })).toEqual([]);
      expect((await ledger.balance(userAvailable(HOLDER, 'BTC'))).amount).toBe(amt('1'));
    });

    it('cards.issue refuses when no issuer is configured — never invents a programme', async () => {
      const bare = createBankServices(sql, ledger, memoryLedgerHistory(ledger));
      await expect(
        caller(bare).cards.issue({
          cardId: randomUUID(),
          assetId: 'USDT',
          perAuthorizationLimit: '250',
        }),
      ).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
        cause: { code: 'bank.no_card_issuer' },
      });
    });

    it('HTTP cards.issue refuses an unconfigured screening list before creating a card', async () => {
      const envKeys = [SCREENING_FAIL_CLOSED_ENV, SANCTIONS_REGIONS_ENV, SANCTIONS_SOURCE_ENV] as const;
      const prior = new Map(envKeys.map((key) => [key, process.env[key]]));
      const app = await mountDoors(bank);

      try {
        process.env[SCREENING_FAIL_CLOSED_ENV] = 'on';
        delete process.env[SANCTIONS_REGIONS_ENV];
        delete process.env[SANCTIONS_SOURCE_ENV];

        const refused = await post(app, 'cards.issue', {
          cardId: randomUUID(),
          assetId: 'USDT',
          perAuthorizationLimit: '250',
        });

        expect(refused.statusCode).toBe(403);
        expect(refused.body.error?.data?.code).toBe('FORBIDDEN');
        expect(refused.body.error?.data?.intafacedCode).toBe('denied.screening_unconfigured');
        expect(await sql`SELECT id FROM bank.cards`).toHaveLength(0);
        expect(ledger.journal()).toHaveLength(0);
      } finally {
        for (const key of envKeys) {
          const value = prior.get(key);
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
        await app.close();
      }
    });

    it('HTTP /trpc/ops.cardAuthorize JIT with settlement≠funding and no mark writes no hold', async () => {
      await fund(ledger, HOLDER, 'BTC', '1');
      const app = await mountDoors(bank);
      const issued = await post(
        app,
        'cards.issue',
        {
          cardId: randomUUID(),
          assetId: 'BTC',
          settlementAssetId: 'USDT',
          perAuthorizationLimit: '1',
        },
        signedHeaders(),
      );
      expect(issued.statusCode).toBe(200);
      const cardId = (procedureData(issued.body) as { id: string }).id;

      const auth = await post(
        app,
        'ops.cardAuthorize',
        {
          cardId,
          authorizationRef: `auth-${randomUUID()}`,
          amount: '100',
          confirmOperatorId: CONFIRM,
          ...APPROVAL,
        },
        signedHeaders(treasury()),
      );
      expect(auth.statusCode).toBe(412);
      expectNamedRefuse(auth.body, 'bank.mark_missing');
      await app.close();

      expect(await sql`SELECT id FROM bank.card_authorizations WHERE card_id = ${cardId}`).toHaveLength(0);
      expect(await sql`SELECT id FROM bank.card_conversions`).toHaveLength(0);
      expect(ledger.journal().some((tx) => tx.reason === 'withdraw.held')).toBe(false);
      expect((await ledger.balance(userAvailable(HOLDER, 'BTC'))).amount).toBe(amt('1'));
    });
  });

  describe('D26-P2-01e public doors — ramps refuse invent rails', () => {
    let ledger: MemoryLedger;

    beforeEach(async () => {
      await sql`TRUNCATE bank.ramp_onramps, bank.ramp_offramps, bank.user_withdraw_destinations RESTART IDENTITY CASCADE`;
      ledger = new MemoryLedger();
    });

    it('ramps.offramp refuses when programme is unset (bank.no_ramp_rail)', async () => {
      const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger));
      await fund(ledger, HOLDER, 'USDT', '50');
      await expect(
        caller(bank).ramps.offramp({
          offrampId: randomUUID(),
          assetId: 'USDT',
          amount: '10',
          kind: 'crypto',
          destinationRef: '0xdead',
          clientRef: `c-${randomUUID()}`,
        }),
      ).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
        cause: { code: 'bank.no_ramp_rail' },
      });
      expect((await ledger.balance(userAvailable(HOLDER, 'USDT'))).amount).toBe(amt('50'));
      const rows = await sql`SELECT count(*)::text AS c FROM bank.ramp_offramps`;
      expect(rows[0]?.c).toBe('0');
    });

    it('ops.creditOnramp refuses fiat by socket name before inventing a PSP row', async () => {
      const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
        ramps: { programme: CRYPTO_LEDGER_PROGRAMME },
      });
      const ops = caller(bank, treasury());
      await expect(
        ops.ops.creditOnramp({
          userId: HOLDER,
          assetId: 'USDT',
          amount: '10',
          kind: 'fiat',
          railRef: `fiat-${randomUUID()}`,
          confirmOperatorId: CONFIRM,
          ...APPROVAL,
        }),
      ).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
        cause: { code: 'bank.fiat_ramp_socket' },
      });
      const rows = await sql`SELECT count(*)::text AS c FROM bank.ramp_onramps`;
      expect(rows[0]?.c).toBe('0');
      expect((await ledger.balance(userAvailable(HOLDER, 'USDT'))).amount).toBe(0n);
    });

    it('ops.creditOnramp refuses when programme is none — no invent deposit', async () => {
      const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
        ramps: { programme: NO_RAMP_PROGRAMME },
      });
      const ops = caller(bank, treasury());
      await expect(
        ops.ops.creditOnramp({
          userId: HOLDER,
          assetId: 'USDT',
          amount: '10',
          kind: 'crypto',
          railRef: `none-${randomUUID()}`,
          confirmOperatorId: CONFIRM,
          ...APPROVAL,
        }),
      ).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
        cause: { code: 'bank.no_ramp_rail' },
      });
    });

    it('HTTP /trpc ramps: programme none and fiat socket refuse before any row', async () => {
      await fund(ledger, HOLDER, 'USDT', '50');
      const none = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
        ramps: { programme: NO_RAMP_PROGRAMME },
      });
      const crypto = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
        ramps: { programme: CRYPTO_LEDGER_PROGRAMME },
      });

      const noneApp = await mountDoors(none);
      const offramp = await post(
        noneApp,
        'ramps.offramp',
        {
          offrampId: randomUUID(),
          assetId: 'USDT',
          amount: '10',
          kind: 'crypto',
          destinationRef: '0xdead',
          clientRef: `c-${randomUUID()}`,
        },
        signedHeaders(),
      );
      expect(offramp.statusCode).toBe(412);
      expectNamedRefuse(offramp.body, 'bank.no_ramp_rail');

      const fiatNone = await post(
        noneApp,
        'ops.creditOnramp',
        {
          userId: HOLDER,
          assetId: 'USDT',
          amount: '10',
          kind: 'fiat',
          railRef: `fiat-none-${randomUUID()}`,
          confirmOperatorId: CONFIRM,
          ...APPROVAL,
        },
        signedHeaders(treasury()),
      );
      expect(fiatNone.statusCode).toBe(412);
      expectNamedRefuse(fiatNone.body, 'bank.fiat_ramp_socket');
      await noneApp.close();

      const cryptoApp = await mountDoors(crypto);
      const fiatSocket = await post(
        cryptoApp,
        'ops.creditOnramp',
        {
          userId: HOLDER,
          assetId: 'USDT',
          amount: '10',
          kind: 'fiat',
          railRef: `fiat-crypto-${randomUUID()}`,
          confirmOperatorId: CONFIRM,
          ...APPROVAL,
        },
        signedHeaders(treasury()),
      );
      expect(fiatSocket.statusCode).toBe(412);
      expectNamedRefuse(fiatSocket.body, 'bank.fiat_ramp_socket');
      await cryptoApp.close();

      expect((await sql`SELECT count(*)::text AS c FROM bank.ramp_offramps`)[0]?.c).toBe('0');
      expect((await sql`SELECT count(*)::text AS c FROM bank.ramp_onramps`)[0]?.c).toBe('0');
      expect(ledger.journal().some((tx) => tx.reason === 'withdraw.held')).toBe(false);
      expect((await ledger.balance(userAvailable(HOLDER, 'USDT'))).amount).toBe(amt('50'));
    });
  });
});
