/**
 * D26-P1-B1 — bank.earn product boundary.
 *
 * Breaks caught:
 *   · an empty deployment presents an empty-but-apparently-working earn screen
 *     instead of refusing because no rate has been configured;
 *   · a late scheduler run pays a full day to a position opened after that
 *     UTC day's boundary.
 *
 * These enter through the mounted router with a signed edge principal. The
 * ledger stays real (MemoryLedger's conformance-proven implementation), and
 * every value movement uses an imported ledger-client recipe.
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
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger, parseAmount as amount, recipes, userAvailable } from '@intafaced/ledger-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { memoryLedgerHistory } from '../analytics/ledger-history.js';
import { createBankServices } from '../bank-service.js';
import { createBankRouter } from '../router.js';

const SECRET = 'bank-earn-product-boundary-secret-32';
const USER = '11111111-1111-4111-8111-111111111111';
const OPERATOR = '33333333-3333-4333-8333-333333333333';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
  .sort()
  .map((file) => readFileSync(join(drizzle, file), 'utf8'));

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
      `H8a: svc-bank earn-product is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}

describe('earn-product (source)', () => {
  it('H8a money suite is not skip-green (no postgresAvailable / describe.skip)', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bpostgresAvailable\s*\(/);
    expect(src).not.toMatch(/describe\.skip\s*\(/);
    expect(src).not.toMatch(/\bit\.skip\s*\(/);
  });
});

describe('mounted earn doors', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let ledger: MemoryLedger;
  let bank: ReturnType<typeof createBankServices>;
  const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-bank' });

  beforeAll(async () => {
    const admin = await openH8aAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'bank', url: admin.url, migrations });
    sql = db.sql;
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  function principal(userId: string, scopes: Principal['scopes']): Principal {
    return {
      sub: userId,
      userId,
      sid: randomUUID(),
      scopes,
      tier: 'full',
      mfa: true,
      expiresAt: new Date(Date.now() + 60_000),
    } as Principal;
  }

  function signedCaller(actor: Principal, service: string | null = null) {
    const raw = encodePrincipal(actor);
    return createBankRouter(bank).createCaller({
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

  async function fundUser(userId: string, value: string) {
    await ledger.post(
      recipes.deposit({
        userId,
        assetId: 'USDT',
        amount: amount(value),
        rail: 'test',
        railRef: `${userId}:${randomUUID()}`,
      }),
    );
  }

  async function fundPoolReserve(poolId: string, value: string) {
    const payer = '99999999-9999-4999-8999-999999999999';
    await fundUser(payer, value);
    await ledger.post(
      recipes.feeCharge({
        chargeId: `bank-earn:${randomUUID()}`,
        userId: payer,
        module: 'bank',
        mode: 'asset',
        assetId: 'USDT',
        amount: amount(value),
      }),
    );
    await bank.earn.fundPool({ poolId, fundingId: `fund-${randomUUID()}`, amount: amount(value) });
  }

  beforeEach(async () => {
    await sql`
      TRUNCATE bank.interest_accruals, bank.earn_positions, bank.earn_pools
      RESTART IDENTITY CASCADE
    `;
    ledger = new MemoryLedger();
    bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger));
  });

  it('earn.pools refuses unset page size — never invent 50', async () => {
    const user = signedCaller(principal(USER, ['bank:read', 'bank:write']));

    await expect(user.earn.pools({})).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      cause: { code: 'bank.earn_pools_list_limit_unset' },
    });
  });

  it('earn.pools refuses by name when no yield rate is configured', async () => {
    const user = signedCaller(principal(USER, ['bank:read', 'bank:write']));

    await expect(user.earn.pools({ limit: 50 })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      cause: { code: 'bank.earn_rate_unset' },
    });
  });

  it('earn.pools({ assetId }) refuses by name rather than inventing a default APY', async () => {
    const user = signedCaller(principal(USER, ['bank:read', 'bank:write']));

    await expect(user.earn.pools({ assetId: 'USDT', limit: 50 })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      cause: { code: 'bank.earn_rate_unset' },
    });
  });

  it('ops.accrueInterest refuses by name when no yield rate is configured', async () => {
    const ops = signedCaller(principal(OPERATOR, ['admin:treasury']), 'svc-bank');

    await expect(ops.ops.accrueInterest({ at: '2026-03-02T23:59:59.999Z' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      cause: { code: 'bank.earn_rate_unset' },
    });
  });

  it('accrues only positions open before the UTC day boundary', async () => {
    const pool = await bank.earn.createPool({
      assetId: 'USDT',
      kind: 'flexible',
      name: 'Configured USDT',
      aprBps: 3650,
    });
    await fundPoolReserve(pool.id, '100');
    await fundUser(USER, '1000');
    await bank.earn.deposit({
      positionId: randomUUID(),
      poolId: pool.id,
      userId: USER,
      amount: amount('1000'),
      now: new Date('2026-03-02T00:00:00.000Z'),
    });

    const ops = signedCaller(principal(OPERATOR, ['admin:treasury']), 'svc-bank');
    const sameDay = await ops.ops.accrueInterest({ poolId: pool.id, at: '2026-03-02T23:59:59.999Z' });
    expect(sameDay.results[0]).toMatchObject({
      date: '2026-03-02',
      paid: '0',
      recipients: 0,
      alreadyAccrued: false,
    });
    expect((await ledger.balance(userAvailable(USER, 'USDT'))).amount).toBe(0n);

    const nextDay = await ops.ops.accrueInterest({ poolId: pool.id, at: '2026-03-03T00:00:00.000Z' });
    expect(nextDay.results[0]).toMatchObject({
      date: '2026-03-03',
      paid: '1',
      recipients: 1,
      alreadyAccrued: false,
    });
    expect((await ledger.balance(userAvailable(USER, 'USDT'))).amount).toBe(amount('1'));
    expect(ledger.reconcile()).toEqual({ ok: true });
  });
});
