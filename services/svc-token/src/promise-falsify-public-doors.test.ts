/**
 * Unit card (D26-P2-01g):
 * Promise: stake / unstake / buyback crash windows refuse invent through mounted
 *   Fastify tRPC public doors (`/trpc` + signed createEdgeContext) and the
 *   S2S emissions HTTP door wired to TokenService.mintNextEpoch — not
 *   createCaller-only or stub-mint theater.
 * Break: underfunded stake could invent an active row; locked unstake could
 *   invent a return of principal; overlapping buyback windows could invent a
 *   second burn after the irreversible leg; zero tokensBought / bad revenue
 *   could spend the window claim; mint could invent supply when emissions are off;
 *   yield over-claim could invent fees that were never in houseFees.
 * Done bar:
 *   · stake over available → BAD_REQUEST; zero stake rows; available untouched.
 *   · unstake locked m12 → BAD_REQUEST / token.stake_locked; principal still staked.
 *   · recordBuyback overlapping window → CONFLICT / token.buyback_window_overlap;
 *     burn account does not double (read the burn, not only the exception).
 *   · concurrent same-window recordBuyback → each 400 unmoved or 409 overlap
 *     (not always one of each: winner DELETE-releases pending, so both can 400);
 *     never 500 (GiST deadlock) and never 200 (invented buy).
 *   · tokensBought>0 with no market-buy on the ledger → BAD_REQUEST /
 *     token.buyback_tokens_unmoved; no settle, engine untouched.
 *   · tokensBought=0 / invalid revenueTotal refuse before claim — window free later.
 *   · mintEpoch + POST /internal/emissions/mint-next refuse when emissions off.
 *   · distributeRevenue over houseFees → BAD_REQUEST / token.yield_source_underfunded.
 * Class: N (honesty) / M surface (no invent emission/buyback §8 numbers — P0-04).
 * Leverage: createTokenRouter + TokenService + MemoryLedger + registerInternalEmissions
 *   (Phase A — deepen existing token doors, no rebuild).
 *
 * H8a PG-hard: this file never `describe.skip` / `postgresAvailable`. CI uses
 * TEST_DATABASE_URL (per-run `createTestDatabase`, not shared table mutations).
 * Local without that env starts Testcontainers `postgres:16-alpine`. Docker/PG
 * down is a failed suite, not a green skip.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, serviceAuthHeadersForBody, signPrincipalHeader } from '@intafaced/contracts';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import {
  MemoryLedger,
  formatAmount,
  houseFees,
  parseAmount as amt,
  recipes,
  rewardsEngine,
  userAvailable,
  type LedgerClient,
} from '@intafaced/ledger-client';
import { DEFAULT_BUYBACK_PARAMS } from './economics/buyback.js';
import { DEFAULT_EMISSION_PARAMS } from './economics/emission.js';
import { registerInternalEmissions } from './internal-emissions.js';
import { stubApprovalConsumer } from './action-approval-consume.js';
import { createTokenRouter } from './router.js';
import { TokenService } from './token-service.js';

const SECRET = 'token-promise-falsify-public-doors-secret-32';
const USER = '11111111-1111-4111-8111-111111111111';
const OPERATOR = '33333333-3333-4333-8333-333333333333';
const CONFIRM = '44444444-4444-4444-8444-444444444444';
const APPROVAL = { approvalId: 'appr-1', operationId: 'op-1' } as const;
const INTERNAL_SECRET = 'token-promise-falsify-internal-emissions-secret';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const edgeContext = createEdgeContext({
  secret: SECRET,
  serviceName: 'svc-token',
  internalSecret: INTERNAL_SECRET,
});

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
      `H8a: svc-token promise-falsify public doors is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}

describe('D26-P2-01g public doors (source)', () => {
  it('H8a money suite is not skip-green (no postgresAvailable / describe.skip)', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bpostgresAvailable\s*\(/);
    expect(src).not.toMatch(/describe\.skip\s*\(/);
    expect(src).not.toMatch(/\bit\.skip\s*\(/);
  });
});

describe('D26-P2-01g public doors PG-hard', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase;
  let sql: TestDatabase['sql'];
  let ledger: MemoryLedger;
  let bus: MemoryEventBus;
  let token: TokenService;

  const options = {
    assetId: 'IFC',
    emission: DEFAULT_EMISSION_PARAMS,
    buyback: DEFAULT_BUYBACK_PARAMS,
    loadParamsFromDb: false,
    feeScheduleTtlMs: 0,
  };

  function principal(overrides: Partial<Principal> = {}): Principal {
    return {
      sub: USER,
      userId: USER,
      sid: '22222222-2222-4222-8222-222222222222',
      scopes: ['token:read', 'token:stake'],
      tier: 'full',
      mfa: true,
      expiresAt: new Date(Date.now() + 60_000),
      ...overrides,
    } as Principal;
  }

  function caller(p: Principal = principal()) {
    const raw = encodePrincipal(p);
    return createTokenRouter(token, { emissionsEnabled: true, approvals: stubApprovalConsumer(CONFIRM) }).createCaller(
      edgeContext({
        headers: {
          'x-intafaced-principal': raw,
          'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
          'x-intafaced-region': 'DE',
        },
        id: `req-${randomUUID()}`,
      }),
    );
  }

  type WireBody = {
    result?: { data?: { json?: unknown } | unknown };
    error?: {
      message?: string;
      data?: { code?: string; httpStatus?: number; cause?: { code?: string } };
    };
  };

  function signedHeaders(p: Principal = principal()): Record<string, string> {
    const raw = encodePrincipal(p);
    return {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
      'content-type': 'application/json',
    };
  }

  function adminHeaders(): Record<string, string> {
    return signedHeaders(
      principal({
        sub: OPERATOR,
        userId: OPERATOR,
        scopes: ['admin:treasury', 'token:read'],
        mfa: true,
      }),
    );
  }

  function jobHeaders(body: Record<string, unknown> = {}): Record<string, string> {
    const payload = JSON.stringify(body);
    return {
      'content-type': 'application/json',
      ...serviceAuthHeadersForBody('svc-token', INTERNAL_SECRET, payload),
    };
  }

  async function mountDoors(emissionsEnabled = true): Promise<FastifyInstance> {
    const tokenRouter = createTokenRouter(token, { emissionsEnabled, approvals: stubApprovalConsumer(CONFIRM) });
    const app = Fastify({ logger: false });
    registerInternalEmissions(app, {
      internalSecret: INTERNAL_SECRET,
      emissionsEnabled,
      mintNextEpoch: () => token.mintNextEpoch(),
    });
    await app.register(fastifyTRPCPlugin, {
      prefix: '/trpc',
      trpcOptions: {
        router: tokenRouter,
        createContext: ({ req }) => edgeContext(req),
      } satisfies FastifyTRPCPluginOptions<typeof tokenRouter>['trpcOptions'],
    });
    await app.ready();
    return app;
  }

  async function trpcMutate(
    app: FastifyInstance,
    path: string,
    input: Record<string, unknown>,
    headers: Record<string, string>,
  ): Promise<{ statusCode: number; body: WireBody }> {
    const payload = JSON.stringify(input);
    const res = await app.inject({
      method: 'POST',
      url: `/trpc/${path}`,
      headers: { 'content-type': 'application/json', ...headers },
      payload,
    });
    return { statusCode: res.statusCode, body: res.json() as WireBody };
  }

  function wireJson(body: WireBody): unknown {
    const data = body.result?.data;
    if (data && typeof data === 'object' && data !== null && 'json' in data) {
      return (data as { json: unknown }).json;
    }
    return data;
  }

  /** Unique half-open window per test — avoids GiST races with sibling files. */
  function uniqueWindow(tag: string): { from: string; to: string } {
    let h = 0;
    for (let i = 0; i < tag.length; i += 1) h = (h * 33 + tag.charCodeAt(i)) >>> 0;
    const day = (h % 300) + 1;
    const from = new Date(Date.UTC(2030, 0, 1, 0, 0, 0) + day * 86_400_000);
    const to = new Date(from.getTime() + 7 * 86_400_000);
    return { from: from.toISOString(), to: to.toISOString() };
  }

  function adminCaller(emissionsEnabled = true) {
    const raw = encodePrincipal(
      principal({
        sub: OPERATOR,
        userId: OPERATOR,
        scopes: ['admin:treasury', 'token:read'],
        mfa: true,
      }),
    );
    return createTokenRouter(token, { emissionsEnabled, approvals: stubApprovalConsumer(CONFIRM) }).createCaller(
      edgeContext({
        headers: {
          'x-intafaced-principal': raw,
          'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
          'x-intafaced-region': 'DE',
        },
        id: `req-admin-${randomUUID()}`,
      }),
    );
  }

  function jobCaller(emissionsEnabled = true) {
    const raw = encodePrincipal(
      principal({
        sub: OPERATOR,
        userId: OPERATOR,
        scopes: ['admin:treasury', 'token:read'],
        mfa: true,
      }),
    );
    return createTokenRouter(token, { emissionsEnabled, approvals: stubApprovalConsumer(CONFIRM) }).createCaller({
      ...edgeContext({
        headers: {
          'x-intafaced-principal': raw,
          'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
          'x-intafaced-region': 'DE',
        },
        id: `req-job-${randomUUID()}`,
      }),
      service: 'svc-token',
    });
  }

  async function fund(userId: string, amount: string) {
    await ledger.post(
      recipes.deposit({
        userId,
        assetId: 'IFC',
        amount: amt(amount),
        rail: 'test',
        railRef: `${userId}:${amount}:${randomUUID()}`,
      }),
    );
  }

  async function accrueFees(module: string, amount: string) {
    const payer = '99999999-9999-4999-8999-999999999999';
    await fund(payer, amount);
    await ledger.post(
      recipes.feeCharge({
        chargeId: `${module}:${randomUUID()}`,
        userId: payer,
        module,
        mode: 'asset',
        assetId: 'IFC',
        amount: amt(amount),
      }),
    );
  }

  async function fundRewards(amount: string, windowId: string) {
    await accrueFees('trade', amount);
    await token.distributeRevenue({ windowId, sources: [{ module: 'trade', amount: amt(amount) }] });
  }

  async function seedBuybackRun(input: { runId: string; window: { from: Date; to: Date }; status?: 'pending' | 'settled' }) {
    await sql`
      INSERT INTO token.buyback_runs (
        id, revenue_window_from, revenue_window_to, revenue_total,
        tokens_bought, tokens_burned, tokens_to_rewards, status, executed_at
      ) VALUES (
        ${input.runId}, ${input.window.from}, ${input.window.to}, ${sql.json({ IFC: '1000' } as never)},
        1000::numeric, 600::numeric, 400::numeric,
        ${input.status ?? 'settled'}, now()
      )
    `;
  }

  const balanceOf = async (userId: string) => formatAmount((await ledger.balance(userAvailable(userId, 'IFC'))).amount);
  const stakedOf = async (userId: string) => {
    const all = await ledger.balances('user', userId);
    const total = all.filter((b) => b.account.kind === 'stake' && b.account.assetId === 'IFC').reduce((acc, b) => acc + b.amount, 0n);
    return formatAmount(total);
  };

  beforeAll(async () => {
    const admin = await openH8aAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'token', url: admin.url, migrations });
    sql = db.sql;
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  beforeEach(async () => {
    await sql`
      TRUNCATE token.governance_votes, token.proposals, token.stakes, token.buyback_runs,
               token.emission_epochs, token.yield_payouts, token.yield_windows
      RESTART IDENTITY CASCADE
    `;
    ledger = new MemoryLedger();
    bus = new MemoryEventBus('svc-token');
    token = new TokenService(sql, ledger, bus, options);
  });

  describe('D26-P2-01g public doors — stake refuse invent funding', () => {
    it('stake refuses over available — invents no active row and leaves principal untouched', async () => {
      await fund(USER, '100');
      const api = caller();

      await expect(api.stake({ amount: '101', tier: 'flex', stakeId: randomUUID() })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });

      const rows = await sql`SELECT id, status FROM token.stakes`;
      expect(rows).toHaveLength(0);
      expect(await balanceOf(USER)).toBe('100');
      expect(await stakedOf(USER)).toBe('0');
      expect(await token.stakeOf(USER)).toBe(0n);
    });

    it('stake refuses a non-positive amount at the door before the service runs', async () => {
      await fund(USER, '100');
      const stake = vi.spyOn(token, 'stake');

      await expect(caller().stake({ amount: '0', tier: 'flex', stakeId: randomUUID() })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
      expect(stake).not.toHaveBeenCalled();
      expect(await balanceOf(USER)).toBe('100');
    });
  });

  describe('D26-P2-01g public doors — unstake refuse invent unlock', () => {
    it('unstake refuses a locked m12 stake by name and invents no principal return', async () => {
      await fund(USER, '1000');
      const api = caller();
      const opened = await api.stake({ amount: '1000', tier: 'm12', stakeId: randomUUID() });
      expect(opened.status).toBe('active');
      expect(await stakedOf(USER)).toBe('1000');
      expect(await balanceOf(USER)).toBe('0');

      await expect(api.unstake({ stakeId: opened.id })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        cause: { code: 'token.stake_locked' },
      });

      expect(await balanceOf(USER)).toBe('0');
      expect(await stakedOf(USER)).toBe('1000');
      const [row] = await sql<Array<{ status: string }>>`
        SELECT status FROM token.stakes WHERE id = ${opened.id}
      `;
      expect(row?.status).toBe('active');
    });
  });

  describe('D26-P2-01g public doors — buyback crash windows', () => {
    it('recordBuyback refuses a NEW run id over an identical window — burn does not double', async () => {
      await fundRewards('4000', 'w-door-identical');
      const ops = adminCaller();
      const window = uniqueWindow('identical');
      const firstId = randomUUID();
      await seedBuybackRun({ runId: firstId, window: { from: new Date(window.from), to: new Date(window.to) } });
      const burnedAfterFirst = amt((await ops.burnedSupply()).burned);

      await expect(
        ops.recordBuyback({
          runId: randomUUID(),
          revenueWindow: window,
          revenueTotal: { IFC: '1000' },
          tokensBought: '1000',
          confirmOperatorId: CONFIRM,
          ...APPROVAL,
        }),
      ).rejects.toMatchObject({
        code: 'CONFLICT',
        cause: { code: 'token.buyback_window_overlap' },
      });

      // THE POINT — read the burn account, not only the exception name.
      expect(amt((await ops.burnedSupply()).burned)).toBe(burnedAfterFirst);
      expect(await sql`SELECT id FROM token.buyback_runs WHERE id = ${firstId}`).toHaveLength(1);
      expect(bus.emitted('buybackExecuted')).toHaveLength(0);
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('recordBuyback refuses a nested overlapping window without inventing a second burn', async () => {
      await fundRewards('4000', 'w-door-nested');
      const ops = adminCaller();
      const outer = uniqueWindow('nested');
      const outerFrom = new Date(outer.from);
      const nested = {
        from: new Date(outerFrom.getTime() + 2 * 86_400_000).toISOString(),
        to: new Date(outerFrom.getTime() + 4 * 86_400_000).toISOString(),
      };
      const firstId = randomUUID();
      await seedBuybackRun({ runId: firstId, window: { from: new Date(outer.from), to: new Date(outer.to) } });
      const burnedAfterFirst = amt((await ops.burnedSupply()).burned);

      await expect(
        ops.recordBuyback({
          runId: randomUUID(),
          revenueWindow: nested,
          revenueTotal: { IFC: '1000' },
          tokensBought: '1000',
          confirmOperatorId: CONFIRM,
          ...APPROVAL,
        }),
      ).rejects.toMatchObject({
        code: 'CONFLICT',
        cause: { code: 'token.buyback_window_overlap' },
      });

      expect(amt((await ops.burnedSupply()).burned)).toBe(burnedAfterFirst);
      expect(await sql`SELECT id FROM token.buyback_runs WHERE id = ${firstId}`).toHaveLength(1);
    });

    it('recordBuyback refuses tokensBought that did not move on the ledger — no settle, engine untouched', async () => {
      await fundRewards('4000', 'w-door-unmoved');
      const ops = adminCaller();
      const window = uniqueWindow('unmoved');
      const engineBefore = (await ledger.balance(rewardsEngine('IFC'))).amount;

      await expect(
        ops.recordBuyback({
          runId: randomUUID(),
          revenueWindow: window,
          revenueTotal: { IFC: '1000' },
          tokensBought: '1000',
          confirmOperatorId: CONFIRM,
          ...APPROVAL,
        }),
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        cause: { code: 'token.buyback_tokens_unmoved' },
      });

      expect(amt((await ops.burnedSupply()).burned)).toBe(0n);
      expect(await sql`SELECT id FROM token.buyback_runs`).toHaveLength(0);
      expect((await ledger.balance(rewardsEngine('IFC'))).amount).toBe(engineBefore);
    });

    it('recordBuyback refuses tokensBought=0 before claiming the window — later real burn stays free', async () => {
      const ops = adminCaller();
      const window = uniqueWindow('zero');

      await expect(
        ops.recordBuyback({
          runId: randomUUID(),
          revenueWindow: window,
          revenueTotal: { IFC: '0' },
          tokensBought: '0',
          confirmOperatorId: CONFIRM,
          ...APPROVAL,
        }),
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        cause: { code: 'token.buyback_revenue_invalid' },
      });

      expect(
        await sql`
          SELECT id FROM token.buyback_runs
           WHERE revenue_window_from = ${new Date(window.from)}
             AND revenue_window_to = ${new Date(window.to)}
        `,
      ).toHaveLength(0);
      expect(amt((await ops.burnedSupply()).burned)).toBe(0n);

      await fundRewards('500', 'w-door-zero-then-real');
      const realId = randomUUID();
      await expect(
        ops.recordBuyback({
          runId: realId,
          revenueWindow: window,
          revenueTotal: { IFC: '500' },
          tokensBought: '500',
          confirmOperatorId: CONFIRM,
          ...APPROVAL,
        }),
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        cause: { code: 'token.buyback_tokens_unmoved' },
      });
      expect(amt((await ops.burnedSupply()).burned)).toBe(0n);
      expect(await sql`SELECT id FROM token.buyback_runs WHERE id = ${realId}`).toHaveLength(0);
    });

    it('recordBuyback refuses a non-ordered window at the door — service never claims', async () => {
      const record = vi.spyOn(token, 'recordBuyback');
      const ops = adminCaller();

      await expect(
        ops.recordBuyback({
          runId: randomUUID(),
          revenueWindow: {
            from: '2026-08-01T00:00:00.000Z',
            to: '2026-07-01T00:00:00.000Z',
          },
          revenueTotal: { IFC: '1000' },
          tokensBought: '100',
          confirmOperatorId: CONFIRM,
          ...APPROVAL,
        }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

      expect(record).not.toHaveBeenCalled();
      expect(await sql`SELECT id FROM token.buyback_runs`).toHaveLength(0);
    });

    it('recordBuyback refuses invented negative revenueTotal before any claim row', async () => {
      const ops = adminCaller();
      const window = uniqueWindow('negative-revenue');

      await expect(
        ops.recordBuyback({
          runId: randomUUID(),
          revenueWindow: window,
          revenueTotal: { IFC: '-999' },
          tokensBought: '100',
          confirmOperatorId: CONFIRM,
          ...APPROVAL,
        }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

      expect(
        await sql`
          SELECT id FROM token.buyback_runs
           WHERE revenue_window_from = ${new Date(window.from)}
             AND revenue_window_to = ${new Date(window.to)}
        `,
      ).toHaveLength(0);
      expect(amt((await ops.burnedSupply()).burned)).toBe(0n);
    });
  });

  describe('D26-P2-01g public doors — yield refuse invent fees', () => {
    it('distributeRevenue refuses over-claim of houseFees by name — no invent sweep', async () => {
      await accrueFees('trade', '100');
      const ops = adminCaller();

      await expect(
        ops.distributeRevenue({
          windowId: 'w-door-underfund',
          sources: [{ module: 'trade', amount: '101' }],
          confirmOperatorId: CONFIRM,
          ...APPROVAL,
        }),
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        cause: { code: 'token.yield_source_underfunded' },
      });

      expect(await sql`SELECT window_id FROM token.yield_windows`).toHaveLength(0);
      expect(await sql`SELECT window_id FROM token.yield_payouts`).toHaveLength(0);
      expect(formatAmount((await ledger.balance(houseFees('trade', 'IFC'))).amount)).toBe('100');
    });
  });

  describe('D26-P2-01g public doors — emissions refuse invent mint', () => {
    it('mintEpoch refuses when emissions are disabled — no invent supply', async () => {
      const mintNext = vi.spyOn(token, 'mintNextEpoch');
      const mintEpoch = vi.spyOn(token, 'mintEpoch');
      const ops = jobCaller(false);

      await expect(ops.mintEpoch({})).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
      });
      expect(mintNext).not.toHaveBeenCalled();
      expect(mintEpoch).not.toHaveBeenCalled();
      expect(await sql`SELECT epoch FROM token.emission_epochs`).toHaveLength(0);
    });

    it('POST /internal/emissions/mint-next refuses when emissions are disabled — kill-switch door', async () => {
      const mintNextEpoch = vi.fn(async () => ({ epoch: 0, minted: amt('1') }));
      const app = Fastify({ logger: false });
      registerInternalEmissions(app, {
        internalSecret: INTERNAL_SECRET,
        emissionsEnabled: false,
        mintNextEpoch,
      });
      await app.ready();

      const res = await app.inject({
        method: 'POST',
        url: '/internal/emissions/mint-next',
        headers: serviceAuthHeadersForBody('svc-token', INTERNAL_SECRET, ''),
      });

      expect(res.statusCode).toBe(503);
      expect(res.json().code).toBe('token.emissions_disabled');
      expect(mintNextEpoch).not.toHaveBeenCalled();
      await app.close();
    });

    it('POST /internal/emissions/mint-next with TokenService wired does not invent an epoch row', async () => {
      const mintNext = vi.spyOn(token, 'mintNextEpoch');
      const app = await mountDoors(false);

      const res = await app.inject({
        method: 'POST',
        url: '/internal/emissions/mint-next',
        headers: serviceAuthHeadersForBody('svc-token', INTERNAL_SECRET, ''),
      });

      expect(res.statusCode).toBe(503);
      expect(res.json().code).toBe('token.emissions_disabled');
      expect(mintNext).not.toHaveBeenCalled();
      expect(await sql`SELECT epoch FROM token.emission_epochs`).toHaveLength(0);
      await app.close();
    });
  });

  describe('D26-P2-01g mounted Fastify tRPC doors', () => {
    it('POST /trpc/stake refuses over available — invents no row', async () => {
      await fund(USER, '100');
      const app = await mountDoors();

      const { statusCode, body } = await trpcMutate(app, 'stake', { amount: '101', tier: 'flex', stakeId: randomUUID() }, signedHeaders());

      expect(statusCode).toBe(400);
      expect(body.error?.data?.code).toBe('BAD_REQUEST');
      expect(await sql`SELECT id FROM token.stakes`).toHaveLength(0);
      expect(await balanceOf(USER)).toBe('100');
      expect(await stakedOf(USER)).toBe('0');
      await app.close();
    });

    it('POST /trpc/unstake refuses a locked m12 stake and keeps principal staked', async () => {
      await fund(USER, '1000');
      const app = await mountDoors();
      const opened = await trpcMutate(app, 'stake', { amount: '1000', tier: 'm12', stakeId: randomUUID() }, signedHeaders());
      expect(opened.statusCode).toBe(200);
      const stake = wireJson(opened.body) as { id: string; status: string };
      expect(stake.status).toBe('active');
      expect(await stakedOf(USER)).toBe('1000');
      expect(await balanceOf(USER)).toBe('0');

      const refused = await trpcMutate(app, 'unstake', { stakeId: stake.id }, signedHeaders());
      expect(refused.statusCode).toBe(400);
      expect(refused.body.error?.data?.code).toBe('BAD_REQUEST');
      expect(refused.body.error?.data?.cause?.code ?? refused.body.error?.message).toMatch(/stake_locked|locked/i);

      expect(await balanceOf(USER)).toBe('0');
      expect(await stakedOf(USER)).toBe('1000');
      const [row] = await sql<Array<{ status: string }>>`SELECT status FROM token.stakes WHERE id = ${stake.id}`;
      expect(row?.status).toBe('active');
      await app.close();
    });

    it('POST /trpc/unstake concurrent crash does not double-return principal', async () => {
      await fund(USER, '1000');
      const app = await mountDoors();
      const opened = await trpcMutate(app, 'stake', { amount: '1000', tier: 'flex', stakeId: randomUUID() }, signedHeaders());
      const stake = wireJson(opened.body) as { id: string };

      const results = await Promise.all(
        Array.from({ length: 8 }, () => trpcMutate(app, 'unstake', { stakeId: stake.id }, signedHeaders())),
      );

      expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
      expect(await balanceOf(USER)).toBe('1000');
      expect(await stakedOf(USER)).toBe('0');
      await app.close();
    });

    it('POST /trpc/recordBuyback overlapping crash does not double-burn', async () => {
      await fundRewards('4000', 'w-mounted-identical');
      const app = await mountDoors();
      const window = uniqueWindow('mounted-identical');
      const firstId = randomUUID();
      await seedBuybackRun({ runId: firstId, window: { from: new Date(window.from), to: new Date(window.to) } });
      const burnedAfterFirst = await token.burnedSupply();

      const second = await trpcMutate(
        app,
        'recordBuyback',
        {
          runId: randomUUID(),
          revenueWindow: window,
          revenueTotal: { IFC: '1000' },
          tokensBought: '1000',
          confirmOperatorId: CONFIRM,
          ...APPROVAL,
        },
        adminHeaders(),
      );
      expect(second.statusCode).toBe(409);
      expect(second.body.error?.data?.code).toBe('CONFLICT');

      expect(await token.burnedSupply()).toBe(burnedAfterFirst);
      expect(await sql`SELECT id FROM token.buyback_runs WHERE id = ${firstId}`).toHaveLength(1);
      expect(bus.emitted('buybackExecuted')).toHaveLength(0);
      expect(ledger.reconcile()).toEqual({ ok: true });
      await app.close();
    });

    it('POST /trpc/recordBuyback concurrent same-window crash does not invent a buy', async () => {
      await fundRewards('4000', 'w-mounted-concurrent');
      const app = await mountDoors();
      const window = uniqueWindow('mounted-concurrent');
      const a = randomUUID();
      const b = randomUUID();
      const engineBefore = (await ledger.balance(rewardsEngine('IFC'))).amount;

      const [left, right] = await Promise.all([
        trpcMutate(
          app,
          'recordBuyback',
          { runId: a, revenueWindow: window, revenueTotal: { IFC: '1000' }, tokensBought: '1000', confirmOperatorId: CONFIRM, ...APPROVAL },
          adminHeaders(),
        ),
        trpcMutate(
          app,
          'recordBuyback',
          { runId: b, revenueWindow: window, revenueTotal: { IFC: '1000' }, tokensBought: '1000', confirmOperatorId: CONFIRM, ...APPROVAL },
          adminHeaders(),
        ),
      ]);

      // Each is 400 unmoved or 409 overlap — never 200 (invent a buy) or 500
      // (unmapped GiST deadlock). Do not require the exact 400+409 pair: if the
      // other INSERT runs after the winner DELETE-releases pending, both are 400.
      const codes = [left.statusCode, right.statusCode];
      expect(
        codes.every((c) => c === 400 || c === 409),
        `recordBuyback concurrent same-window: ${JSON.stringify({
          left: { status: left.statusCode, error: left.body.error },
          right: { status: right.statusCode, error: right.body.error },
        })}`,
      ).toBe(true);
      expect(codes.some((c) => c === 200)).toBe(false);
      expect(codes.some((c) => c === 500)).toBe(false);
      for (const res of [left, right]) {
        if (res.statusCode === 400) {
          expect(res.body.error?.data?.code).toBe('BAD_REQUEST');
          expect(res.body.error?.data?.cause?.code).toBe('token.buyback_tokens_unmoved');
        } else {
          expect(res.body.error?.data?.code).toBe('CONFLICT');
          expect(res.body.error?.data?.cause?.code).toBe('token.buyback_window_overlap');
        }
      }

      expect(await token.burnedSupply()).toBe(0n);
      expect((await ledger.balance(rewardsEngine('IFC'))).amount).toBe(engineBefore);
      expect(await sql`SELECT id FROM token.buyback_runs`).toHaveLength(0);
      expect(bus.emitted('buybackExecuted')).toHaveLength(0);
      expect(ledger.reconcile()).toEqual({ ok: true });
      await app.close();
    });

    it('POST /trpc/recordBuyback tail-overlap refuses without a second burn', async () => {
      await fundRewards('4000', 'w-mounted-tail');
      const app = await mountDoors();
      const outer = uniqueWindow('mounted-tail');
      const outerFrom = new Date(outer.from);
      const tail = {
        from: new Date(outerFrom.getTime() + 6 * 86_400_000).toISOString(),
        to: new Date(outerFrom.getTime() + 10 * 86_400_000).toISOString(),
      };
      const firstId = randomUUID();
      await seedBuybackRun({ runId: firstId, window: { from: new Date(outer.from), to: new Date(outer.to) } });
      const burnedAfterFirst = await token.burnedSupply();

      const second = await trpcMutate(
        app,
        'recordBuyback',
        {
          runId: randomUUID(),
          revenueWindow: tail,
          revenueTotal: { IFC: '1000' },
          tokensBought: '1000',
          confirmOperatorId: CONFIRM,
          ...APPROVAL,
        },
        adminHeaders(),
      );
      expect(second.statusCode).toBe(409);

      expect(await token.burnedSupply()).toBe(burnedAfterFirst);
      expect(await sql`SELECT id FROM token.buyback_runs`).toHaveLength(1);
      await app.close();
    });

    it('POST /trpc/recordBuyback same runId on a different window refuses without a second burn', async () => {
      await fundRewards('4000', 'w-mounted-runid');
      const app = await mountDoors();
      const firstWindow = uniqueWindow('mounted-runid');
      const runId = randomUUID();
      await seedBuybackRun({ runId, window: { from: new Date(firstWindow.from), to: new Date(firstWindow.to) } });
      const burnedAfterFirst = await token.burnedSupply();

      const other = uniqueWindow('mounted-runid-other');
      const second = await trpcMutate(
        app,
        'recordBuyback',
        { runId, revenueWindow: other, revenueTotal: { IFC: '1000' }, tokensBought: '1000', confirmOperatorId: CONFIRM, ...APPROVAL },
        adminHeaders(),
      );
      expect(second.statusCode).toBe(409);
      expect(second.body.error?.data?.code).toBe('CONFLICT');

      expect(await token.burnedSupply()).toBe(burnedAfterFirst);
      expect(await sql`SELECT id FROM token.buyback_runs`).toHaveLength(1);
      await app.close();
    });

    it('POST /trpc/recordBuyback releases a pending crash rather than completing a fee-funded burn', async () => {
      await fundRewards('2000', 'w-mounted-pending');
      const app = await mountDoors();
      const window = uniqueWindow('mounted-pending');
      const runId = randomUUID();

      await seedBuybackRun({
        runId,
        window: { from: new Date(window.from), to: new Date(window.to) },
        status: 'pending',
      });

      const retry = await trpcMutate(
        app,
        'recordBuyback',
        { runId, revenueWindow: window, revenueTotal: { IFC: '1000' }, tokensBought: '1000', confirmOperatorId: CONFIRM, ...APPROVAL },
        adminHeaders(),
      );
      expect(retry.statusCode).toBe(400);
      expect(retry.body.error?.data?.cause?.code).toBe('token.buyback_tokens_unmoved');
      expect(await token.burnedSupply()).toBe(0n);
      expect(await sql`SELECT id FROM token.buyback_runs WHERE id = ${runId}`).toHaveLength(0);

      const again = await trpcMutate(
        app,
        'recordBuyback',
        {
          runId: randomUUID(),
          revenueWindow: window,
          revenueTotal: { IFC: '1000' },
          tokensBought: '1000',
          confirmOperatorId: CONFIRM,
          ...APPROVAL,
        },
        adminHeaders(),
      );
      expect(again.statusCode).toBe(400);
      expect(await token.burnedSupply()).toBe(0n);
      await app.close();
    });

    it('POST /trpc/recordBuyback live getTxByKey throw is 400 unmoved, never 500', async () => {
      const inner = ledger;
      const s2s: LedgerClient = {
        post: inner.post.bind(inner),
        balance: inner.balance.bind(inner),
        balances: inner.balances.bind(inner),
        getTx: async () => {
          throw new Error('getTx is not exposed over the internal ledger API — query svc-ledger directly');
        },
        getTxByKey: async () => {
          throw new Error('getTxByKey is not exposed over the internal ledger API — query svc-ledger directly');
        },
      };
      token = new TokenService(sql, s2s, bus, options);
      const app = await mountDoors();
      const window = uniqueWindow('mounted-gettx-live');

      const fresh = await trpcMutate(
        app,
        'recordBuyback',
        {
          runId: randomUUID(),
          revenueWindow: window,
          revenueTotal: { IFC: '1000' },
          tokensBought: '1000',
          confirmOperatorId: CONFIRM,
          ...APPROVAL,
        },
        adminHeaders(),
      );
      expect(fresh.statusCode).toBe(400);
      expect(fresh.body.error?.data?.code).toBe('BAD_REQUEST');
      expect(fresh.body.error?.data?.cause?.code).toBe('token.buyback_tokens_unmoved');
      expect(await sql`SELECT id FROM token.buyback_runs`).toHaveLength(0);

      const runId = randomUUID();
      await seedBuybackRun({
        runId,
        window: { from: new Date(window.from), to: new Date(window.to) },
        status: 'pending',
      });
      const retry = await trpcMutate(
        app,
        'recordBuyback',
        { runId, revenueWindow: window, revenueTotal: { IFC: '1000' }, tokensBought: '1000', confirmOperatorId: CONFIRM, ...APPROVAL },
        adminHeaders(),
      );
      expect(retry.statusCode).toBe(400);
      expect(retry.body.error?.data?.cause?.code).toBe('token.buyback_tokens_unmoved');
      expect(retry.body.error?.message ?? '').not.toMatch(/getTxByKey/);
      const rows = await sql<Array<{ status: string }>>`SELECT status FROM token.buyback_runs WHERE id = ${runId}`;
      expect(rows[0]?.status).toBe('pending');
      expect(bus.emitted('buybackExecuted')).toHaveLength(0);
      await app.close();
    });

    it('POST /trpc/distributeRevenue without approval ids refuses and moves nothing', async () => {
      await accrueFees('trade', '100');
      const app = await mountDoors();

      const refused = await trpcMutate(
        app,
        'distributeRevenue',
        { windowId: 'w-mounted-no-confirm', sources: [{ module: 'trade', amount: '10' }] },
        adminHeaders(),
      );
      expect(refused.statusCode).toBe(412);
      expect(refused.body.error?.data?.code).toBe('PRECONDITION_FAILED');
      expect(await sql`SELECT window_id FROM token.yield_windows`).toHaveLength(0);
      expect(formatAmount((await ledger.balance(houseFees('trade', 'IFC'))).amount)).toBe('100');
      await app.close();
    });

    it('POST /trpc/distributeRevenue over-claim leaves houseFees untouched', async () => {
      await accrueFees('trade', '100');
      const app = await mountDoors();

      const refused = await trpcMutate(
        app,
        'distributeRevenue',
        { windowId: 'w-mounted-underfund', sources: [{ module: 'trade', amount: '101' }], confirmOperatorId: CONFIRM, ...APPROVAL },
        adminHeaders(),
      );
      expect(refused.statusCode).toBe(400);
      expect(refused.body.error?.data?.code).toBe('BAD_REQUEST');
      expect(refused.body.error?.data?.cause?.code ?? refused.body.error?.message).toMatch(/yield_source_underfunded|underfund/i);
      expect(await sql`SELECT window_id FROM token.yield_windows`).toHaveLength(0);
      expect(await sql`SELECT window_id FROM token.yield_payouts`).toHaveLength(0);
      expect(formatAmount((await ledger.balance(houseFees('trade', 'IFC'))).amount)).toBe('100');
      await app.close();
    });

    it('POST /trpc/mintEpoch refuses when emissions are off — no invent supply', async () => {
      const mintNext = vi.spyOn(token, 'mintNextEpoch');
      const mintEpoch = vi.spyOn(token, 'mintEpoch');
      const app = await mountDoors(false);

      const refused = await trpcMutate(app, 'mintEpoch', {}, jobHeaders());
      expect(refused.statusCode).toBe(412);
      expect(refused.body.error?.data?.code).toBe('PRECONDITION_FAILED');
      expect(mintNext).not.toHaveBeenCalled();
      expect(mintEpoch).not.toHaveBeenCalled();
      expect(await sql`SELECT epoch FROM token.emission_epochs`).toHaveLength(0);
      await app.close();
    });
  });
});
