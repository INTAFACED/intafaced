/**
 * Unit card — proposeTransfer retry is one transfer / one hold (caller clientId)
 *
 * 1. Promise: proposeTransfer requires clientId. An identical retry returns the
 *    original post or the original hold. A clientId reused with different terms,
 *    including an amount that crosses the account spendThreshold, conflicts and
 *    does not post or hold a second time.
 * 2. Break: randomUUID transferId/approvalId makes a retry a second movement.
 *    A second shape for the same clientId moves money twice.
 * 3. Done bar: same clientId and same terms → one post or one hold. Different
 *    terms throw bank.business_request_conflict and do not post or hold again.
 *    HTTP omit clientId is 400.
 * 4. Class M
 * 5. Paths: services/svc-bank/src/business/business-service.ts, router.ts
 * 6. RED: two random ids, two posts; source matches randomUUID
 * 7. Collision: business.test dual-control — this file does not change approve
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { MemoryLedger, parseAmount as amt, recipes } from '@intafaced/ledger-client';
import { memoryLedgerHistory } from '../analytics/ledger-history.js';
import { createBankServices } from '../bank-service.js';
import { createBankRouter, type BankRouter } from '../router.js';

const SECRET = 'bank-business-propose-retry-id-secret';
const MAKER = '11111111-1111-4111-8111-111111111111';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const MIGRATIONS = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';

type WireBody = {
  result?: { data?: unknown };
  error?: { message?: string; data?: { code?: string; httpStatus?: number } };
};

describe('proposeTransfer pins a required caller clientId and does not mint', () => {
  it('proposeTransfer does not call randomUUID for transferId or approvalId', () => {
    const src = readFileSync(join(here, 'business-service.ts'), 'utf8');
    const at = src.indexOf('async proposeTransfer(input:');
    const approveAt = src.indexOf('async approve(input:', at);
    const body = src.slice(at, approveAt);
    expect(at).toBeGreaterThan(-1);
    expect(body).toMatch(/bank\.business_request_id_required/);
    expect(body).not.toMatch(/randomUUID/);
  });

  it('public door requires clientId so omit is not a second movement', () => {
    const src = readFileSync(join(here, '..', 'router.ts'), 'utf8');
    const doorAt = src.indexOf("proposeTransfer: scopedProcedure('bank:write'");
    const nextAt = src.indexOf('approve: scopedProcedure', doorAt);
    const body = src.slice(doorAt, nextAt === -1 ? doorAt + 1800 : nextAt);
    expect(doorAt).toBeGreaterThan(-1);
    expect(body).toMatch(/clientId:\s*z\.string\(\)\.guid\(\)/);
    expect(body).not.toMatch(/clientId:\s*z\.string\(\)\.guid\(\)\.optional\(\)/);
  });
});

const db: TestDatabase = await createTestDatabase({ service: 'bank', url: DB_URL, migrations: MIGRATIONS });
const sql = db.sql;
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-bank' });

afterAll(async () => {
  await db.drop();
}, 30_000);

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    sub: MAKER,
    userId: MAKER,
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

async function mountDoors(bank: ReturnType<typeof createBankServices>): Promise<FastifyInstance> {
  const router = createBankRouter(bank);
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

async function post(app: FastifyInstance, path: string, input: Record<string, unknown>): Promise<{ statusCode: number; body: WireBody }> {
  const res = await app.inject({ method: 'POST', url: `/trpc/${path}`, headers: signedHeaders(), payload: input });
  return { statusCode: res.statusCode, body: res.json() as WireBody };
}

function procedureData(body: WireBody): unknown {
  const data = body.result?.data;
  if (data && typeof data === 'object' && data !== null && 'json' in data) {
    return (data as { json: unknown }).json;
  }
  return data;
}

async function fund(ledger: MemoryLedger, userId: string, value: string) {
  await ledger.post(
    recipes.deposit({
      userId,
      assetId: 'USDT',
      amount: amt(value),
      rail: 'test',
      railRef: `${userId}:USDT:${randomUUID()}`,
    }),
  );
}

function movementCounts(ledger: MemoryLedger): { posts: number; holds: number } {
  const journal = ledger.journal();
  return {
    posts: journal.filter((tx) => tx.reason === 'bank.transfer.manual').length,
    holds: journal.filter((tx) => tx.reason === 'bank.business.approval.held').length,
  };
}

describe('BusinessService.proposeTransfer — retry with the same clientId is one movement', () => {
  let ledger: MemoryLedger;

  beforeEach(async () => {
    await sql`
      TRUNCATE bank.business_payroll_lines, bank.business_payroll_runs,
               bank.business_approvals, bank.business_members, bank.business_accounts,
               bank.transfer_executions, bank.scheduled_transfers, bank.spaces
      RESTART IDENTITY CASCADE
    `;
    ledger = new MemoryLedger();
  });

  it('omit clientId refuses bank.business_request_id_required', async () => {
    const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), { nativeAssetId: 'IFC' });
    const account = await bank.business.createAccount({
      accountId: randomUUID(),
      name: 'Ops Co',
      assetId: 'USDT',
      spendThreshold: amt('500'),
      creatorUserId: MAKER,
    });
    const from = await bank.spaces.ensurePrimary(MAKER, 'USDT');
    const to = await bank.spaces.create({ userId: MAKER, assetId: 'USDT', name: 'Vendor' });
    await fund(ledger, MAKER, '400');
    await expect(
      bank.business.proposeTransfer({
        accountId: account.id,
        makerUserId: MAKER,
        fromSpaceId: from.id,
        toSpaceId: to.id,
        amount: amt('100'),
        clientId: '',
      }),
    ).rejects.toMatchObject({ code: 'bank.business_request_id_required' });
  });

  it('under-threshold retry — one manual transfer', async () => {
    const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), { nativeAssetId: 'IFC' });
    const account = await bank.business.createAccount({
      accountId: randomUUID(),
      name: 'Ops Co',
      assetId: 'USDT',
      spendThreshold: amt('500'),
      creatorUserId: MAKER,
    });
    const from = await bank.spaces.ensurePrimary(MAKER, 'USDT');
    const to = await bank.spaces.create({ userId: MAKER, assetId: 'USDT', name: 'Vendor' });
    await fund(ledger, MAKER, '400');
    const clientId = randomUUID();

    const input = {
      accountId: account.id,
      makerUserId: MAKER,
      fromSpaceId: from.id,
      toSpaceId: to.id,
      amount: amt('100'),
      clientId,
    };
    const first = await bank.business.proposeTransfer(input);
    const retry = await bank.business.proposeTransfer(input);
    expect(first.kind).toBe('posted');
    expect(retry.kind).toBe('posted');
    if (first.kind !== 'posted' || retry.kind !== 'posted') throw new Error('expected posted');
    expect(retry.transferId).toBe(first.transferId);
    expect(retry.transferId).toBe(clientId);
    expect(retry.ledgerTxId).toBe(first.ledgerTxId);
    expect(ledger.journal().filter((tx) => tx.reason === 'bank.transfer.manual').length).toBe(1);
  });

  it('over-threshold retry — one approval hold', async () => {
    const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), { nativeAssetId: 'IFC' });
    const account = await bank.business.createAccount({
      accountId: randomUUID(),
      name: 'Ops Co',
      assetId: 'USDT',
      spendThreshold: amt('100'),
      creatorUserId: MAKER,
    });
    const from = await bank.spaces.ensurePrimary(MAKER, 'USDT');
    const to = await bank.spaces.create({ userId: MAKER, assetId: 'USDT', name: 'Payroll' });
    await fund(ledger, MAKER, '1000');
    const clientId = randomUUID();

    const input = {
      accountId: account.id,
      makerUserId: MAKER,
      fromSpaceId: from.id,
      toSpaceId: to.id,
      amount: amt('250'),
      clientId,
    };
    const first = await bank.business.proposeTransfer(input);
    const retry = await bank.business.proposeTransfer(input);
    expect(first.kind).toBe('pending');
    expect(retry.kind).toBe('pending');
    if (first.kind !== 'pending' || retry.kind !== 'pending') throw new Error('expected pending');
    expect(retry.approval.id).toBe(first.approval.id);
    expect(retry.approval.id).toBe(clientId);
    expect(retry.approval.holdLedgerTxId).toBe(first.approval.holdLedgerTxId);
    expect(ledger.journal().filter((tx) => tx.reason === 'bank.business.approval.held').length).toBe(1);
    const rows = await sql<Array<{ id: string }>>`
      SELECT id FROM bank.business_approvals WHERE account_id = ${account.id}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(clientId);
  });

  it('under-threshold clientId with different terms conflicts and does not post again', async () => {
    const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), { nativeAssetId: 'IFC' });
    const account = await bank.business.createAccount({
      accountId: randomUUID(),
      name: 'Ops Co',
      assetId: 'USDT',
      spendThreshold: amt('500'),
      creatorUserId: MAKER,
    });
    const otherAccount = await bank.business.createAccount({
      accountId: randomUUID(),
      name: 'Other Co',
      assetId: 'USDT',
      spendThreshold: account.spendThreshold,
      creatorUserId: MAKER,
    });
    const from = await bank.spaces.ensurePrimary(MAKER, 'USDT');
    const to = await bank.spaces.create({ userId: MAKER, assetId: 'USDT', name: 'Vendor' });
    const other = await bank.spaces.create({ userId: MAKER, assetId: 'USDT', name: 'Other' });
    await fund(ledger, MAKER, '5000');
    const below = amt('100');
    const stillBelow = below + amt('1');
    expect(below < account.spendThreshold).toBe(true);
    expect(stillBelow < account.spendThreshold).toBe(true);
    const clientId = randomUUID();
    const original = {
      accountId: account.id,
      makerUserId: MAKER,
      fromSpaceId: from.id,
      toSpaceId: to.id,
      amount: below,
      clientId,
    };

    const first = await bank.business.proposeTransfer(original);
    await expect(bank.business.proposeTransfer({ ...original, accountId: otherAccount.id })).rejects.toMatchObject({
      code: 'bank.business_request_conflict',
    });
    await expect(bank.business.proposeTransfer({ ...original, toSpaceId: other.id })).rejects.toMatchObject({
      code: 'bank.business_request_conflict',
    });
    await expect(bank.business.proposeTransfer({ ...original, amount: stillBelow })).rejects.toMatchObject({
      code: 'bank.business_request_conflict',
    });
    const retry = await bank.business.proposeTransfer(original);
    expect(first.kind).toBe('posted');
    expect(retry).toEqual(first);
    expect(movementCounts(ledger)).toEqual({ posts: 1, holds: 0 });
    const rows = await sql<Array<{ id: string }>>`
      SELECT id FROM bank.business_approvals WHERE id = ${clientId}::uuid
    `;
    expect(rows).toHaveLength(1);
  });

  it('over-threshold clientId with different terms conflicts and does not hold again', async () => {
    const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), { nativeAssetId: 'IFC' });
    const account = await bank.business.createAccount({
      accountId: randomUUID(),
      name: 'Ops Co',
      assetId: 'USDT',
      spendThreshold: amt('500'),
      creatorUserId: MAKER,
    });
    const otherAccount = await bank.business.createAccount({
      accountId: randomUUID(),
      name: 'Other Co',
      assetId: 'USDT',
      spendThreshold: account.spendThreshold,
      creatorUserId: MAKER,
    });
    const from = await bank.spaces.ensurePrimary(MAKER, 'USDT');
    const to = await bank.spaces.create({ userId: MAKER, assetId: 'USDT', name: 'Payroll' });
    const other = await bank.spaces.create({ userId: MAKER, assetId: 'USDT', name: 'Other' });
    await fund(ledger, MAKER, '5000');
    const atThreshold = account.spendThreshold;
    const stillOver = account.spendThreshold + amt('1');
    const clientId = randomUUID();
    const original = {
      accountId: account.id,
      makerUserId: MAKER,
      fromSpaceId: from.id,
      toSpaceId: to.id,
      amount: atThreshold,
      clientId,
    };

    const first = await bank.business.proposeTransfer(original);
    await expect(bank.business.proposeTransfer({ ...original, accountId: otherAccount.id })).rejects.toMatchObject({
      code: 'bank.business_request_conflict',
    });
    await expect(bank.business.proposeTransfer({ ...original, toSpaceId: other.id })).rejects.toMatchObject({
      code: 'bank.business_request_conflict',
    });
    await expect(bank.business.proposeTransfer({ ...original, amount: stillOver })).rejects.toMatchObject({
      code: 'bank.business_request_conflict',
    });
    const retry = await bank.business.proposeTransfer(original);
    expect(first.kind).toBe('pending');
    expect(retry).toEqual(first);
    expect(movementCounts(ledger)).toEqual({ posts: 0, holds: 1 });
    const rows = await sql<Array<{ id: string }>>`
      SELECT id FROM bank.business_approvals WHERE id = ${clientId}::uuid
    `;
    expect(rows).toHaveLength(1);
  });

  it('an amount that moves from below spendThreshold to at or above it conflicts and does not hold', async () => {
    const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), { nativeAssetId: 'IFC' });
    const account = await bank.business.createAccount({
      accountId: randomUUID(),
      name: 'Ops Co',
      assetId: 'USDT',
      spendThreshold: amt('500'),
      creatorUserId: MAKER,
    });
    const from = await bank.spaces.ensurePrimary(MAKER, 'USDT');
    const to = await bank.spaces.create({ userId: MAKER, assetId: 'USDT', name: 'Vendor' });
    await fund(ledger, MAKER, '5000');
    const below = amt('100');
    expect(below < account.spendThreshold).toBe(true);
    const base = {
      accountId: account.id,
      makerUserId: MAKER,
      fromSpaceId: from.id,
      toSpaceId: to.id,
    };

    const atClient = randomUUID();
    const firstAt = await bank.business.proposeTransfer({ ...base, amount: below, clientId: atClient });
    await expect(bank.business.proposeTransfer({ ...base, amount: account.spendThreshold, clientId: atClient })).rejects.toMatchObject({
      code: 'bank.business_request_conflict',
    });
    const retryAt = await bank.business.proposeTransfer({ ...base, amount: below, clientId: atClient });
    expect(firstAt.kind).toBe('posted');
    expect(retryAt).toEqual(firstAt);

    const aboveClient = randomUUID();
    const firstAbove = await bank.business.proposeTransfer({ ...base, amount: below, clientId: aboveClient });
    await expect(
      bank.business.proposeTransfer({
        ...base,
        amount: account.spendThreshold + amt('1'),
        clientId: aboveClient,
      }),
    ).rejects.toMatchObject({ code: 'bank.business_request_conflict' });
    const retryAbove = await bank.business.proposeTransfer({ ...base, amount: below, clientId: aboveClient });
    expect(firstAbove.kind).toBe('posted');
    expect(retryAbove).toEqual(firstAbove);
    expect(movementCounts(ledger)).toEqual({ posts: 2, holds: 0 });
    const rows = await sql<Array<{ id: string }>>`
      SELECT id FROM bank.business_approvals WHERE account_id = ${account.id}
    `;
    expect(rows).toHaveLength(2);
  });

  it('an amount that moves from at or above spendThreshold to below it conflicts and does not post', async () => {
    const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), { nativeAssetId: 'IFC' });
    const account = await bank.business.createAccount({
      accountId: randomUUID(),
      name: 'Ops Co',
      assetId: 'USDT',
      spendThreshold: amt('500'),
      creatorUserId: MAKER,
    });
    const from = await bank.spaces.ensurePrimary(MAKER, 'USDT');
    const to = await bank.spaces.create({ userId: MAKER, assetId: 'USDT', name: 'Payroll' });
    await fund(ledger, MAKER, '5000');
    const below = amt('100');
    expect(below < account.spendThreshold).toBe(true);
    const base = {
      accountId: account.id,
      makerUserId: MAKER,
      fromSpaceId: from.id,
      toSpaceId: to.id,
    };

    const atClient = randomUUID();
    const firstAt = await bank.business.proposeTransfer({
      ...base,
      amount: account.spendThreshold,
      clientId: atClient,
    });
    await expect(bank.business.proposeTransfer({ ...base, amount: below, clientId: atClient })).rejects.toMatchObject({
      code: 'bank.business_request_conflict',
    });
    const retryAt = await bank.business.proposeTransfer({
      ...base,
      amount: account.spendThreshold,
      clientId: atClient,
    });
    expect(firstAt.kind).toBe('pending');
    expect(retryAt).toEqual(firstAt);

    const aboveClient = randomUUID();
    const firstAbove = await bank.business.proposeTransfer({
      ...base,
      amount: account.spendThreshold + amt('1'),
      clientId: aboveClient,
    });
    await expect(bank.business.proposeTransfer({ ...base, amount: below, clientId: aboveClient })).rejects.toMatchObject({
      code: 'bank.business_request_conflict',
    });
    const retryAbove = await bank.business.proposeTransfer({
      ...base,
      amount: account.spendThreshold + amt('1'),
      clientId: aboveClient,
    });
    expect(firstAbove.kind).toBe('pending');
    expect(retryAbove).toEqual(firstAbove);
    expect(movementCounts(ledger)).toEqual({ posts: 0, holds: 2 });
    const rows = await sql<Array<{ id: string }>>`
      SELECT id FROM bank.business_approvals WHERE account_id = ${account.id}
    `;
    expect(rows).toHaveLength(2);
  });
});

describe('HTTP /trpc/business.proposeTransfer — retry with the same clientId is one post', () => {
  let ledger: MemoryLedger;

  beforeEach(async () => {
    await sql`
      TRUNCATE bank.business_payroll_lines, bank.business_payroll_runs,
               bank.business_approvals, bank.business_members, bank.business_accounts,
               bank.transfer_executions, bank.scheduled_transfers, bank.spaces
      RESTART IDENTITY CASCADE
    `;
    ledger = new MemoryLedger();
  });

  it('HTTP without clientId is 400', async () => {
    const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), { nativeAssetId: 'IFC' });
    const account = await bank.business.createAccount({
      accountId: randomUUID(),
      name: 'Ops Co',
      assetId: 'USDT',
      spendThreshold: amt('500'),
      creatorUserId: MAKER,
    });
    const from = await bank.spaces.ensurePrimary(MAKER, 'USDT');
    const to = await bank.spaces.create({ userId: MAKER, assetId: 'USDT', name: 'Vendor' });
    await fund(ledger, MAKER, '400');
    const app = await mountDoors(bank);
    const omitted = await post(app, 'business.proposeTransfer', {
      accountId: account.id,
      fromSpaceId: from.id,
      toSpaceId: to.id,
      amount: '100',
    });
    expect(omitted.statusCode).toBe(400);
    await app.close();
    expect(ledger.journal().filter((tx) => tx.reason === 'bank.transfer.manual').length).toBe(0);
  });

  it('two HTTP posts with the same clientId are one transfer', async () => {
    const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), { nativeAssetId: 'IFC' });
    const account = await bank.business.createAccount({
      accountId: randomUUID(),
      name: 'Ops Co',
      assetId: 'USDT',
      spendThreshold: amt('500'),
      creatorUserId: MAKER,
    });
    const from = await bank.spaces.ensurePrimary(MAKER, 'USDT');
    const to = await bank.spaces.create({ userId: MAKER, assetId: 'USDT', name: 'Vendor' });
    await fund(ledger, MAKER, '400');
    const clientId = randomUUID();
    const app = await mountDoors(bank);
    const payload = {
      accountId: account.id,
      fromSpaceId: from.id,
      toSpaceId: to.id,
      amount: '100',
      clientId,
    };

    const first = await post(app, 'business.proposeTransfer', payload);
    expect(first.statusCode).toBe(200);
    const firstData = procedureData(first.body) as { kind: string; transferId: string; ledgerTxId: string };

    const retry = await post(app, 'business.proposeTransfer', payload);
    expect(retry.statusCode).toBe(200);
    const retryData = procedureData(retry.body) as { kind: string; transferId: string; ledgerTxId: string };
    expect(retryData.transferId).toBe(firstData.transferId);
    expect(retryData.transferId).toBe(clientId);
    expect(retryData.ledgerTxId).toBe(firstData.ledgerTxId);
    await app.close();

    expect(ledger.journal().filter((tx) => tx.reason === 'bank.transfer.manual').length).toBe(1);
  });
});
