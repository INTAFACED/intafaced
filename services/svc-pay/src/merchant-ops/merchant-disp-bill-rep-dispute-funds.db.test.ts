import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import type { Principal } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createFounderAuthority } from '../founder-authority.js';
import { createMerchantOpsRouter } from './router.js';
import { parseAmount, recipes, type LedgerTx } from '@intafaced/ledger-client';
import { MemoryDisputeCaseStore } from '../fraud/dispute-case.js';

/** M-disp-01 merchantOps.disputes.funds through the router, against a real Postgres. */

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('intafaced_dispute_funds_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

const id = () => randomUUID();
const founderAuthority = createFounderAuthority({
  identityUrl: 'https://identity.invalid',
  serviceSecret: 's'.repeat(32),
  fetcher: async () => new Response('{}', { status: 500 }),
});
const principalOf = (userId: string, over: Partial<Principal> = {}): Principal => ({
  userId,
  sub: userId,
  sid: id(),
  scopes: ['pay:read', 'pay:write'],
  mfa: true,
  tier: 'full',
  expiresAt: new Date(Date.now() + 600_000),
  ...over,
});
const ctxOf = (principal: Principal): Context => ({
  principal,
  service: null,
  region: 'DE',
  requestId: id(),
  forwardedPrincipal: { raw: 'test-principal', signature: 'test-signature', region: 'DE' },
});

async function refusal(fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (e) {
    const err = e as { code: string; message: string };
    return { code: err.code, message: err.message };
  }
  throw new Error('expected a refusal');
}

describe('M-disp-01 merchantOps.disputes.funds (Postgres)', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: Sql;
  const owner = id();
  const stranger = id();
  let merchantId = '';
  const disputes = new MemoryDisputeCaseStore();
  const disputeId = `dp-${id()}`;
  const request = () =>
    recipes.chargebackOpen({
      disputeId,
      paymentId: id(),
      merchantId,
      merchantUserId: owner,
      assetId: 'USDT',
      rail: 'card',
      fromClearing: 0n,
      fromMerchantBalance: parseAmount('100'),
    });
  const tx = (): LedgerTx => {
    const r = request();
    return {
      id: 'tx-open',
      idempotencyKey: r.idempotencyKey,
      module: r.module,
      reason: r.reason,
      meta: r.meta ?? {},
      postedAt: new Date(),
      hash: 'h',
      previousHash: null,
      entries: [],
    };
  };
  const reads: string[] = [];
  const disputeFundsLedger = {
    getTxByKey: async (key: string) => {
      reads.push(key);
      return key === tx().idempotencyKey ? tx() : null;
    },
  };

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
    sql = db.sql;
    merchantId = (await sql<Array<{ id: string }>>`INSERT INTO pay.merchants (user_id) VALUES (${owner}) RETURNING id`)[0]!.id;
    disputes.open({ disputeId, paymentId: id(), merchantId, amount: '100', assetId: 'USDT', ledgerPost: { txId: 'tx-open' } });
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  });

  const as = (userId: string, withLedger = true) =>
    createMerchantOpsRouter({ sql, founderAuthority, disputes, ...(withLedger ? { disputeFundsLedger } : {}) }).createCaller(
      ctxOf(principalOf(userId, { scopes: ['pay:read'] })),
    );

  it('owner reads taken at opening 100, returned 0, status open; only key reads reach the ledger', async () => {
    const funds = await as(owner).merchantOps.disputes.funds({ disputeId });
    expect(funds).toMatchObject({ status: 'open', disputed: '100', takenAtOpening: '100', returned: '0', fee: { state: 'not_set' } });
    expect(reads.every((k) => k.endsWith(`:${disputeId}`))).toBe(true);
  });

  it('a non-member is refused; an unknown dispute is not found', async () => {
    expect(await refusal(() => as(stranger).merchantOps.disputes.funds({ disputeId }))).toEqual({
      code: 'FORBIDDEN',
      message: 'pay.merchant_ops_not_merchant',
    });
    expect(await refusal(() => as(owner).merchantOps.disputes.funds({ disputeId: 'dp-missing' }))).toEqual({
      code: 'NOT_FOUND',
      message: 'pay.dispute_not_found',
    });
  });

  it('no ledger wired: refuses unavailable, never a zero', async () => {
    expect(await refusal(() => as(owner, false).merchantOps.disputes.funds({ disputeId }))).toEqual({
      code: 'SERVICE_UNAVAILABLE',
      message: 'pay.dispute_funds_unavailable',
    });
  });
});
