/**
 * Limit-increase requests (BK-acct-04) against the shared test Postgres. Harness copied from personal-pay.db.test.ts.
 * The admin URL in runs/test-db.env names database `test`, which assertTestDatabase
 * refuses. This file rewrites that name to `intafaced_test` on the same server.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { issueAccessToken, verifyAccessToken, type Scope } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import {
  MemoryLedger,
  formatAmount,
  parseAmount,
  recipes,
  subAccountAvailable,
  userAvailable,
  type Amount,
} from '@intafaced/ledger-client';
import { createBankRouter } from '../router.js';
import { createBankServices, memoryLedgerHistory, memoryRecipientState, type BankServices } from '../bank-service.js';
import type { LedgerHistoryPages } from '../activity/activity-service.js';
import { memoryPartyHandles } from './party-handles.js';

const ADA = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const CY = '33333333-3333-4333-8333-333333333333';
const SID = '44444444-4444-4444-8444-444444444444';

const tokenConfig = {
  secret: 'paysend-test-signing-secret-long-enough-ok',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
  refreshTtlSeconds: 2_592_000,
};

function adminUrl(): string {
  const raw = process.env.TEST_DATABASE_URL?.trim();
  if (!raw) throw new Error('TEST_DATABASE_URL is unset');
  const url = new URL(raw);
  const name = url.pathname.replace(/^\//, '');
  if (!name.endsWith('_test')) url.pathname = '/intafaced_test';
  return url.toString();
}

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

function pagesFrom(ledger: MemoryLedger): LedgerHistoryPages {
  return {
    async page(request) {
      const accounts = await ledger.balances(request.ownerType, request.ownerId);
      const ids = new Set(
        accounts
          .filter((row) => row.account.kind === 'available' && (request.assetId === undefined || row.account.assetId === request.assetId))
          .map((row) => row.accountId),
      );
      const entries = ledger
        .journal()
        .flatMap((tx) =>
          tx.entries
            .filter((entry) => ids.has(entry.accountId) && (request.assetId === undefined || entry.assetId === request.assetId))
            .map((entry) => ({
              txId: tx.id,
              module: tx.module,
              reason: tx.reason,
              direction: entry.direction,
              amount: formatAmount(entry.amount),
              postedAt: tx.postedAt,
              assetId: entry.assetId,
            })),
        )
        .sort((a, b) => b.postedAt.getTime() - a.postedAt.getTime());
      return { entries: entries.slice(0, request.limit), nextCursor: null };
    },
  };
}

describe('limit-increase requests (BK-acct-04)', () => {
  let db: TestDatabase;
  let ledger: MemoryLedger;
  let bank: BankServices;
  let router: ReturnType<typeof createBankRouter>;

  beforeAll(async () => {
    db = await createTestDatabase({ service: 'bank', url: adminUrl(), migrations });
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  beforeEach(async () => {
    await db.sql`
      TRUNCATE bank.limit_increase_requests, bank.personal_transfers, bank.personal_transfer_terms, bank.spaces
      RESTART IDENTITY CASCADE
    `;
    ledger = new MemoryLedger();
    bank = createBankServices(db.sql, ledger, memoryLedgerHistory(ledger), {
      nativeAssetId: 'IFC',
      recipients: memoryRecipientState(),
      handles: memoryPartyHandles({ [ADA]: 'ada', [BOB]: 'bob' }),
      activity: { pages: pagesFrom(ledger), cursorSecret: tokenConfig.secret },
    });
    router = createBankRouter(bank);
  });

  async function caller(userId: string, scopes: Scope[]) {
    const { token } = await issueAccessToken({ userId, sessionId: SID, scopes, tier: 'full', mfa: true }, tokenConfig);
    const ctx: Context = { principal: await verifyAccessToken(token, tokenConfig), service: null, region: 'DE', requestId: 'limits' };
    return router.createCaller(ctx);
  }

  /** TEST terms only; not owner values. */
  async function publish() {
    await db.sql`INSERT INTO bank.personal_transfer_terms (asset_id, per_transfer_limit, daily_limit, fee) VALUES ('USDT', 25, 100, 0)`;
    await bank.spaces.ensurePrimary(ADA, 'USDT');
    await bank.spaces.ensurePrimary(BOB, 'USDT');
    await ledger.post(
      recipes.deposit({ userId: ADA, assetId: 'USDT', amount: parseAmount('200'), rail: 'test', railRef: `ada-${Math.random()}` }),
    );
  }

  const REASON = 'TEST: paying rent this month';

  it('an approved grant raises the per-transfer limit for that customer only, in the quote and the send', async () => {
    await publish();
    const ada = await caller(ADA, ['bank:read', 'bank:write']);
    const bob = await caller(BOB, ['bank:read', 'bank:write']);
    const desk = await caller(CY, ['admin:compliance']);
    const requestId = randomUUID();
    const opened = await ada.limits.requestIncrease({ requestId, assetId: 'USDT', kind: 'per_transfer', requested: '60', reason: REASON });
    expect(opened).toMatchObject({ id: requestId, status: 'open', requested: '60', granted: null, replayed: false });
    expect(await desk.ops.limitRequests({ limit: 10 })).toEqual([expect.objectContaining({ id: requestId, userId: ADA })]);

    const from = await bank.spaces.ensurePrimary(ADA, 'USDT');
    await expect(
      ada.transfers.toUser({ transferId: 'over-before-grant', fromSpaceId: from.id, toUserId: BOB, amount: '40' }),
    ).rejects.toMatchObject({ message: expect.stringContaining('bank.personal_transfer_limit_exceeded') });

    const decided = await desk.ops.decideLimitRequest({ requestId, decision: 'approve', granted: '50', note: 'TEST: income verified' });
    expect(decided).toMatchObject({ status: 'approved', granted: '50', decidedBy: CY, replayed: false });
    expect(await ada.transfers.quote({ assetId: 'USDT', amount: '40' })).toMatchObject({
      perTransferLimit: '50',
      withinPerTransfer: true,
      dailyLimit: '100',
    });
    expect(await bob.transfers.quote({ assetId: 'USDT', amount: '40' })).toMatchObject({
      perTransferLimit: '25',
      withinPerTransfer: false,
    });

    await ada.transfers.toUser({ transferId: 'under-grant', fromSpaceId: from.id, toUserId: BOB, amount: '40' });
    await expect(
      ada.transfers.toUser({ transferId: 'over-grant', fromSpaceId: from.id, toUserId: BOB, amount: '51' }),
    ).rejects.toMatchObject({ message: expect.stringContaining('bank.personal_transfer_limit_exceeded') });
    expect(await desk.ops.limitRequests({ limit: 10 })).toEqual([]);
  });

  it('a decline grants nothing; a replayed decision returns the first, a different one conflicts', async () => {
    await publish();
    const ada = await caller(ADA, ['bank:read', 'bank:write']);
    const desk = await caller(CY, ['admin:compliance']);
    const requestId = randomUUID();
    await ada.limits.requestIncrease({ requestId, assetId: 'USDT', kind: 'daily', requested: '500', reason: REASON });
    await expect(
      desk.ops.decideLimitRequest({ requestId, decision: 'decline', granted: '10', note: 'TEST: not this time' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await desk.ops.decideLimitRequest({ requestId, decision: 'decline', note: 'TEST: not this time' });
    const again = await desk.ops.decideLimitRequest({ requestId, decision: 'decline', note: 'TEST: not this time' });
    expect(again.replayed).toBe(true);
    await expect(
      desk.ops.decideLimitRequest({ requestId, decision: 'approve', granted: '500', note: 'TEST: changed my mind' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await ada.transfers.quote({ assetId: 'USDT', amount: '1' })).toMatchObject({ dailyLimit: '100' });
    expect(await ada.limits.myRequests({ limit: 10 })).toEqual([expect.objectContaining({ id: requestId, status: 'declined' })]);
  });

  it('refuses an approval with no granted amount, a short note, a self-decision and an unknown request', async () => {
    await publish();
    const ada = await caller(ADA, ['bank:read', 'bank:write', 'admin:compliance']);
    const desk = await caller(CY, ['admin:compliance']);
    const requestId = randomUUID();
    await ada.limits.requestIncrease({ requestId, assetId: 'USDT', kind: 'daily', requested: '500', reason: REASON });
    await expect(desk.ops.decideLimitRequest({ requestId, decision: 'approve', note: 'TEST: income verified' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('never defaulted'),
    });
    await expect(desk.ops.decideLimitRequest({ requestId, decision: 'approve', granted: '500', note: 'ok' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(
      ada.ops.decideLimitRequest({ requestId, decision: 'approve', granted: '500', note: 'TEST: approving my own' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      desk.ops.decideLimitRequest({ requestId: randomUUID(), decision: 'decline', note: 'TEST: no such request' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const [row] = await db.sql`SELECT status FROM bank.limit_increase_requests WHERE id = ${requestId}`;
    expect(row?.status).toBe('open');
  });

  it('one open request per asset and kind; a retry replays; a reused id with other terms conflicts', async () => {
    await publish();
    const ada = await caller(ADA, ['bank:read', 'bank:write']);
    const requestId = randomUUID();
    const input = { requestId, assetId: 'USDT', kind: 'daily' as const, requested: '500', reason: REASON };
    await ada.limits.requestIncrease(input);
    expect((await ada.limits.requestIncrease(input)).replayed).toBe(true);
    await expect(ada.limits.requestIncrease({ ...input, requested: '600' })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(ada.limits.requestIncrease({ ...input, requestId: randomUUID() })).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('already open'),
    });
    // A different kind is its own request.
    await ada.limits.requestIncrease({ ...input, requestId: randomUUID(), kind: 'per_transfer' });
  });

  it('refuses a short reason, a zero amount, an asset with no published limits, a missing page size and the wrong scopes', async () => {
    const ada = await caller(ADA, ['bank:read', 'bank:write']);
    const base = { assetId: 'USDT', kind: 'daily' as const, requested: '500', reason: REASON };
    await expect(ada.limits.requestIncrease({ ...base, requestId: randomUUID() })).rejects.toMatchObject({
      message: expect.stringContaining('bank.personal_transfer_terms_unset'),
    });
    await publish();
    await expect(ada.limits.requestIncrease({ ...base, requestId: randomUUID(), reason: 'short' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(ada.limits.requestIncrease({ ...base, requestId: randomUUID(), requested: '0' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(ada.limits.myRequests({})).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect((await caller(CY, ['admin:compliance'])).ops.limitRequests({})).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(ada.ops.limitRequests({ limit: 10 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect((await caller(ADA, ['bank:read'])).limits.requestIncrease({ ...base, requestId: randomUUID() })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(await db.sql`SELECT 1 FROM bank.limit_increase_requests`).toHaveLength(0);
  });
});
