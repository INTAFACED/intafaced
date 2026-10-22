/**
 * PP-money-balance-03 (J-pay-14 step 3): a Pay send in an asset the recipient has never held opens their balance.
 * The admin URL in runs/test-db.env names database `test`, which assertTestDatabase
 * refuses. This file rewrites that name to `intafaced_test` on the same server.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { issueAccessToken, verifyAccessToken, type Scope } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { MemoryLedger, formatAmount, parseAmount, recipes, userAvailable } from '@intafaced/ledger-client';
import { createBankRouter } from '../router.js';
import { createBankServices, memoryLedgerHistory, memoryRecipientState } from '../bank-service.js';
import { RecipientStateUnavailableError } from '../recipient-state.js';
import type { LedgerHistoryPages } from '../activity/activity-service.js';
import { memoryPartyHandles } from './party-handles.js';
import { eventPersonalRequestNotices, type RequestCreatedNotice } from './request-notices.js';

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

describe('a payment in a new asset opens the recipient balance (Postgres)', () => {
  let db: TestDatabase;
  let ledger: MemoryLedger;
  let bank: ReturnType<typeof createBankServices>;
  let router: ReturnType<typeof createBankRouter>;
  let created: RequestCreatedNotice[];
  let identity: ReturnType<typeof memoryRecipientState>;

  beforeAll(async () => {
    db = await createTestDatabase({ service: 'bank', url: adminUrl(), migrations });
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  beforeEach(async () => {
    await db.sql`
      TRUNCATE bank.personal_request_reminds, bank.personal_transfers, bank.personal_requests,
               bank.personal_transfer_terms, bank.spaces
      RESTART IDENTITY CASCADE
    `;
    ledger = new MemoryLedger();
    created = [];
    identity = memoryRecipientState({}, { strict: true });
    identity.set(ADA, 'active');
    identity.set(BOB, 'active');
    const bus = new MemoryEventBus('svc-bank');
    const inner = eventPersonalRequestNotices(bus);
    bank = createBankServices(db.sql, ledger, memoryLedgerHistory(ledger), {
      nativeAssetId: 'IFC',
      recipients: identity,
      handles: memoryPartyHandles({ [ADA]: 'ada', [BOB]: 'bob', [CY]: 'cy' }),
      requestNotices: {
        created: async (input) => {
          created.push(input);
          await inner.created(input);
        },
        paid: (input) => inner.paid(input),
      },
      activity: { pages: pagesFrom(ledger), cursorSecret: tokenConfig.secret },
    });
    router = createBankRouter(bank);
  });

  async function caller(userId: string, scopes: Scope[]) {
    const { token } = await issueAccessToken({ userId, sessionId: SID, scopes, tier: 'full', mfa: true }, tokenConfig);
    const ctx: Context = {
      principal: await verifyAccessToken(token, tokenConfig),
      service: null,
      region: 'DE',
      requestId: 'paysend',
    };
    return router.createCaller(ctx);
  }

  /** Ada holds USDT; Bob has never held USDT (no primary space). */
  async function adaFunded() {
    const from = await bank.spaces.ensurePrimary(ADA, 'USDT');
    await ledger.post(
      recipes.deposit({ userId: ADA, assetId: 'USDT', amount: parseAmount('100'), rail: 'test', railRef: `ada-${Math.random()}` }),
    );
    return from;
  }

  const primaries = (userId: string) => db.sql<{ id: string }[]>`
    SELECT id FROM bank.spaces WHERE user_id = ${userId} AND asset_id = 'USDT' AND kind = 'primary'
  `;
  const available = async (userId: string) => formatAmount((await ledger.balance(userAvailable(userId, 'USDT'))).amount);
  const sends = () => ledger.journal().filter((tx) => tx.reason === 'bank.transfer.manual');

  it('a payment in a new asset opens one primary balance for the recipient and posts once', async () => {
    const from = await adaFunded();
    expect(await primaries(BOB)).toHaveLength(0);
    const ada = await caller(ADA, ['bank:read', 'bank:write']);
    const sent = await ada.transfers.toUser({ transferId: 'new-asset-1', fromSpaceId: from.id, toUserId: BOB, amount: '12.5' });
    expect(sent.amount).toBe('12.5');
    expect(sent.ledgerTxId).toBeTruthy();
    expect(await primaries(BOB)).toHaveLength(1);
    expect(await available(BOB)).toBe('12.5');
    expect(await available(ADA)).toBe('87.5');
    expect(sends()).toHaveLength(1);

    // Bob now sees a USDT balance among his spaces.
    const bob = await caller(BOB, ['bank:read', 'bank:write']);
    const list = await bob.spaces.list({ assetId: 'USDT', limit: 50 });
    expect(list.map((s) => [s.kind, s.balance])).toEqual([['primary', '12.5']]);
  });

  it('a retry with the same id opens nothing more and posts nothing more', async () => {
    const from = await adaFunded();
    const ada = await caller(ADA, ['bank:read', 'bank:write']);
    const first = await ada.transfers.toUser({ transferId: 'new-asset-2', fromSpaceId: from.id, toUserId: BOB, amount: '5' });
    const again = await ada.transfers.toUser({ transferId: 'new-asset-2', fromSpaceId: from.id, toUserId: BOB, amount: '5' });
    expect(again.ledgerTxId).toBe(first.ledgerTxId);
    expect(await primaries(BOB)).toHaveLength(1);
    expect(sends()).toHaveLength(1);
    expect(await available(BOB)).toBe('5');
  });

  it('two different sends racing to a new recipient open one balance', async () => {
    const from = await adaFunded();
    const ada = await caller(ADA, ['bank:read', 'bank:write']);
    await Promise.all([
      ada.transfers.toUser({ transferId: 'race-send-a', fromSpaceId: from.id, toUserId: BOB, amount: '1' }),
      ada.transfers.toUser({ transferId: 'race-send-b', fromSpaceId: from.id, toUserId: BOB, amount: '2' }),
    ]);
    expect(await primaries(BOB)).toHaveLength(1);
    expect(await available(BOB)).toBe('3');
  });

  it('a frozen, closed or unknown recipient is refused uniformly and no balance is opened for them', async () => {
    const from = await adaFunded();
    const ada = await caller(ADA, ['bank:read', 'bank:write']);
    identity.set(BOB, 'frozen');
    await expect(ada.transfers.toUser({ transferId: 'nf-frozen', fromSpaceId: from.id, toUserId: BOB, amount: '1' })).rejects.toMatchObject(
      {
        message: expect.stringContaining('This recipient cannot receive payments'),
      },
    );
    identity.set(BOB, 'closed');
    await expect(ada.transfers.toUser({ transferId: 'nf-closed', fromSpaceId: from.id, toUserId: BOB, amount: '1' })).rejects.toMatchObject(
      {
        message: expect.stringContaining('This recipient cannot receive payments'),
      },
    );
    // CY has a handle but identity does not know the account (strict port: not_found).
    await expect(ada.transfers.toUser({ transferId: 'nf-ghost', fromSpaceId: from.id, toUserId: CY, amount: '1' })).rejects.toMatchObject({
      message: expect.stringContaining('This recipient cannot receive payments'),
    });
    expect(await primaries(BOB)).toHaveLength(0);
    expect(await primaries(CY)).toHaveLength(0);
    expect(sends()).toHaveLength(0);
    expect(await available(ADA)).toBe('100');
  });

  it('identity down: retryable refusal, no balance opened, nothing posted', async () => {
    const from = await adaFunded();
    const ada = await caller(ADA, ['bank:read', 'bank:write']);
    identity.failWith(new RecipientStateUnavailableError('identity timed out', 'unavailable'));
    await expect(
      ada.transfers.toUser({ transferId: 'nf-down-01', fromSpaceId: from.id, toUserId: BOB, amount: '1' }),
    ).rejects.toMatchObject({
      message: expect.stringContaining('bank.recipient_check_unavailable'),
    });
    expect(await primaries(BOB)).toHaveLength(0);
    expect(sends()).toHaveLength(0);
  });

  it('an archived primary is not reopened by a payment', async () => {
    const from = await adaFunded();
    const bobPrimary = await bank.spaces.ensurePrimary(BOB, 'USDT');
    await db.sql`UPDATE bank.spaces SET archived_at = now() WHERE id = ${bobPrimary.id}`;
    const ada = await caller(ADA, ['bank:read', 'bank:write']);
    await expect(
      ada.transfers.toUser({ transferId: 'nf-archived', fromSpaceId: from.id, toUserId: BOB, amount: '1' }),
    ).rejects.toMatchObject({
      message: expect.stringContaining('This recipient cannot receive payments'),
    });
    expect(sends()).toHaveLength(0);
  });

  it('transferToUser without the Pay flag still refuses a recipient with no balance (other callers unchanged)', async () => {
    const from = await adaFunded();
    await expect(
      bank.transfers.transferToUser({ transferId: 'no-flag', fromSpaceId: from.id, toUserId: BOB, amount: parseAmount('1') }),
    ).rejects.toMatchObject({ code: 'bank.recipient_cannot_receive' });
    expect(await primaries(BOB)).toHaveLength(0);
  });
});
