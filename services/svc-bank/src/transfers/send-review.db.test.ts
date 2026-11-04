/**
 * Personal send, receipt, and payment request against the shared test Postgres.
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
import { accountForSpace } from '../spaces/space-service.js';
import { parseSendReviewRule } from './send-review.js';
import type { LedgerHistoryPages } from '../activity/activity-service.js';
import { memoryPartyHandles } from './party-handles.js';
import { eventPersonalRequestNotices, type RequestCreatedNotice } from './request-notices.js';
import { eventPersonalTransferNotices, type TransferPostedNotice } from './transfer-notices.js';

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

describe('personal send review: a held send moves nothing until it is released (Postgres)', () => {
  let db: TestDatabase;
  let ledger: MemoryLedger;
  let bank: BankServices;
  let router: ReturnType<typeof createBankRouter>;
  let created: RequestCreatedNotice[];
  let postedNotices: TransferPostedNotice[];
  let postedFails: boolean;

  beforeAll(async () => {
    db = await createTestDatabase({ service: 'bank', url: adminUrl(), migrations });
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  beforeEach(async () => {
    await db.sql`
      TRUNCATE bank.personal_send_reviews, bank.personal_request_reminds, bank.personal_transfers, bank.personal_requests,
               bank.personal_transfer_terms, bank.spaces
      RESTART IDENTITY CASCADE
    `;
    ledger = new MemoryLedger();
    created = [];
    postedNotices = [];
    postedFails = false;
    const bus = new MemoryEventBus('svc-bank');
    const inner = eventPersonalRequestNotices(bus);
    const transferBus = eventPersonalTransferNotices(bus);
    bank = createBankServices(db.sql, ledger, memoryLedgerHistory(ledger), {
      nativeAssetId: 'IFC',
      // A labelled TEST space limit, so the router's create door is open in this suite.
      spaceLimit: '10',
      recipients: memoryRecipientState(),
      handles: memoryPartyHandles({ [ADA]: 'ada', [BOB]: 'bob' }),
      requestNotices: {
        created: async (input) => {
          created.push(input);
          await inner.created(input);
        },
        paid: (input) => inner.paid(input),
      },
      transferNotices: {
        posted: async (input) => {
          if (postedFails) throw new Error('bus down');
          postedNotices.push(input);
          await transferBus.posted(input);
        },
      },
      activity: { pages: pagesFrom(ledger), cursorSecret: tokenConfig.secret },
      portfolio: { pages: pagesFrom(ledger) },
      // LOCAL TEST review line: a USDT send above 50 waits for a review.
      sendReviewRule: parseSendReviewRule('{"USDT":"50"}'),
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

  /** Funded spaces, and TEST limits published for USDT unless a test is about blank terms. */
  async function ready({ terms = true }: { terms?: boolean } = {}) {
    await bank.spaces.ensurePrimary(ADA, 'USDT');
    await bank.spaces.ensurePrimary(BOB, 'USDT');
    await ledger.post(
      recipes.deposit({ userId: ADA, assetId: 'USDT', amount: parseAmount('100'), rail: 'test', railRef: `ada-${Math.random()}` }),
    );
    if (terms)
      await db.sql`
        INSERT INTO bank.personal_transfer_terms (asset_id, per_transfer_limit, daily_limit, fee) VALUES ('USDT', 1000, 10000, 0)
      `;
  }

  async function available(userId: string) {
    return formatAmount((await ledger.balance(userAvailable(userId, 'USDT'))).amount);
  }

  const held = (id: string) => ({ code: 'PRECONDITION_FAILED', message: expect.stringContaining(`Payment ${id} is in review`) });
  const p2p = () => ledger.journal().filter((tx) => tx.reason === 'bank.transfer.manual');

  it('holds a send above the line: In review with its reason class, nothing taken, and a retry answers the same', async () => {
    await ready();
    const ada = await caller(ADA, ['bank:read', 'bank:write']);
    const from = await bank.spaces.ensurePrimary(ADA, 'USDT');
    const send = { transferId: 'held-send-1', fromSpaceId: from.id, toUserId: BOB, amount: '60', note: 'Rent, TEST' };
    await expect(ada.transfers.toUser(send)).rejects.toMatchObject(held('held-send-1'));
    await expect(ada.transfers.toUser(send)).rejects.toMatchObject(held('held-send-1'));
    expect(await ada.transfers.held({ transferId: 'held-send-1' })).toMatchObject({
      transferId: 'held-send-1',
      status: 'in_review',
      reasonClass: 'amount_over_review_line',
      amount: '60',
      assetId: 'USDT',
      note: 'Rent, TEST',
      toHandle: 'bob',
      ledgerTxId: null,
      decidedAt: null,
    });
    // Invariant: a held send is an instruction, not money. Nothing posted, nothing reserved, both balances as they were.
    expect(p2p()).toHaveLength(0);
    expect(await available(ADA)).toBe('100');
    expect(await available(BOB)).toBe('0');
    expect((await db.sql`SELECT count(*)::int AS n FROM bank.personal_transfers`)[0]!.n).toBe(0);
    // The same id on different terms is a conflict, never a second held send.
    await expect(ada.transfers.toUser({ ...send, amount: '61' })).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('bank.personal_transfer_conflict'),
    });
    // At or under the line goes now.
    await ada.transfers.toUser({ transferId: 'small-send-1', fromSpaceId: from.id, toUserId: BOB, amount: '50' });
    expect(p2p()).toHaveLength(1);
    expect(await available(BOB)).toBe('50');
  });

  it('only the sender reads a held send; anyone else gets the same not-found as a missing id', async () => {
    await ready();
    const ada = await caller(ADA, ['bank:read', 'bank:write']);
    const from = await bank.spaces.ensurePrimary(ADA, 'USDT');
    await expect(
      ada.transfers.toUser({ transferId: 'held-send-2', fromSpaceId: from.id, toUserId: BOB, amount: '70' }),
    ).rejects.toMatchObject(held('held-send-2'));
    for (const who of [BOB, CY]) {
      const other = await caller(who, ['bank:read']);
      await expect(other.transfers.held({ transferId: 'held-send-2' })).rejects.toMatchObject({
        code: 'NOT_FOUND',
        message: expect.stringContaining('bank.held_send_not_found'),
      });
    }
    await expect(ada.transfers.held({ transferId: 'no-such-send' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('over the limits is refused at once, never held', async () => {
    await ready();
    await db.sql`UPDATE bank.personal_transfer_terms SET per_transfer_limit = 55 WHERE asset_id = 'USDT'`;
    const ada = await caller(ADA, ['bank:read', 'bank:write']);
    const from = await bank.spaces.ensurePrimary(ADA, 'USDT');
    await expect(
      ada.transfers.toUser({ transferId: 'held-send-3', fromSpaceId: from.id, toUserId: BOB, amount: '60' }),
    ).rejects.not.toMatchObject(held('held-send-3'));
    expect((await db.sql`SELECT count(*)::int AS n FROM bank.personal_send_reviews`)[0]!.n).toBe(0);
  });

  it('an operator release posts it once under its own id; a repeat changes nothing; the sender then reads it posted', async () => {
    await ready();
    const ada = await caller(ADA, ['bank:read', 'bank:write']);
    const from = await bank.spaces.ensurePrimary(ADA, 'USDT');
    const send = { transferId: 'held-send-4', fromSpaceId: from.id, toUserId: BOB, amount: '60' };
    await expect(ada.transfers.toUser(send)).rejects.toMatchObject(held('held-send-4'));
    const released = await bank.personalPay.releaseHeld('held-send-4', 'operator-1');
    expect(released).toMatchObject({ status: 'released', ledgerTxId: expect.any(String) });
    expect(await bank.personalPay.releaseHeld('held-send-4', 'operator-1')).toMatchObject({ ledgerTxId: released.ledgerTxId });
    expect(p2p()).toHaveLength(1);
    expect(await available(ADA)).toBe('40');
    expect(await available(BOB)).toBe('60');
    // The sender's retry now answers the posted send, not a hold.
    expect((await ada.transfers.toUser(send)).ledgerTxId).toBe(released.ledgerTxId);
    expect(await bank.personalPay.rejectHeld('held-send-4', 'operator-1').catch((err: { code?: string }) => err.code)).toBe(
      'bank.held_send_decided',
    );
  });

  it('a release the balance no longer covers is refused and stays held; a rejection moves nothing and answers the sender', async () => {
    await ready();
    const ada = await caller(ADA, ['bank:read', 'bank:write']);
    const from = await bank.spaces.ensurePrimary(ADA, 'USDT');
    await expect(
      ada.transfers.toUser({ transferId: 'held-send-5', fromSpaceId: from.id, toUserId: BOB, amount: '60' }),
    ).rejects.toMatchObject(held('held-send-5'));
    // Meanwhile Ada spends most of it on a send under the line.
    await ada.transfers.toUser({ transferId: 'small-send-5', fromSpaceId: from.id, toUserId: CY, amount: '45' });
    await expect(bank.personalPay.releaseHeld('held-send-5', 'operator-1')).rejects.toBeTruthy();
    expect((await ada.transfers.held({ transferId: 'held-send-5' })).status).toBe('in_review');
    expect(await available(ADA)).toBe('55');

    const rejected = await bank.personalPay.rejectHeld('held-send-5', 'operator-1');
    expect(rejected).toMatchObject({ status: 'rejected', ledgerTxId: null, decidedAt: expect.any(String) });
    expect(await bank.personalPay.rejectHeld('held-send-5', 'operator-1')).toMatchObject({ status: 'rejected' });
    await expect(
      ada.transfers.toUser({ transferId: 'held-send-5', fromSpaceId: from.id, toUserId: BOB, amount: '60' }),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining('bank.personal_send_rejected'),
    });
    expect(p2p()).toHaveLength(1);
    expect(await available(ADA)).toBe('55');
    expect(await available(BOB)).toBe('0');
  });

  it('no other door pays another person above the line: a transfer to their space and a scheduled send refuse, nothing moves', async () => {
    await ready();
    const ada = await caller(ADA, ['bank:read', 'bank:write']);
    const from = await bank.spaces.ensurePrimary(ADA, 'USDT');
    const bobs = await bank.spaces.ensurePrimary(BOB, 'USDT');
    const door = { code: 'PRECONDITION_FAILED', message: expect.stringContaining('bank.personal_send_review_door') };
    await expect(
      ada.transfers.create({ transferId: 'door-create-1', fromSpaceId: from.id, toSpaceId: bobs.id, amount: '60' }),
    ).rejects.toMatchObject(door);
    await expect(
      ada.transfers.scheduleToUser({
        scheduleId: '55555555-5555-4555-8555-555555555555',
        fromSpaceId: from.id,
        toUserId: BOB,
        amount: '60',
        cadence: 'once',
        startsAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    ).rejects.toMatchObject(door);
    // An unknown destination counts as another person's.
    await expect(
      ada.transfers.create({
        transferId: 'door-create-2',
        fromSpaceId: from.id,
        toSpaceId: '66666666-6666-4666-8666-666666666666',
        amount: '60',
      }),
    ).rejects.toMatchObject(door);
    expect(await available(ADA)).toBe('100');
    expect(await available(BOB)).toBe('0');
    // At the line, the same doors are open as before.
    await expect(
      ada.transfers.scheduleToUser({
        scheduleId: '77777777-7777-4777-8777-777777777777',
        fromSpaceId: from.id,
        toUserId: BOB,
        amount: '50',
        cadence: 'once',
        startsAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    ).resolves.toBeTruthy();
  });

  it('the balance page names each personal send’s fee and state; other entries’ fee stays unknown', async () => {
    await ready();
    const ada = await caller(ADA, ['bank:read', 'bank:write']);
    const from = await bank.spaces.ensurePrimary(ADA, 'USDT');
    const sent = await ada.transfers.toUser({ transferId: 'fee-send-1', fromSpaceId: from.id, toUserId: BOB, amount: '20' });
    const page = await ada.portfolio.balanceEntries({ assetId: 'USDT' });
    const send = page.entries.find((e) => e.txId === sent.ledgerTxId);
    const deposit = page.entries.find((e) => e.txId !== sent.ledgerTxId);
    expect(send).toMatchObject({ state: 'completed', fee: '0' });
    expect(deposit).toMatchObject({ state: 'completed', fee: null });
    const bob = await caller(BOB, ['bank:read']);
    expect((await bob.portfolio.balanceEntries({ assetId: 'USDT' })).entries).toEqual([
      expect.objectContaining({ txId: sent.ledgerTxId, state: 'completed', fee: '0' }),
    ]);
  });
});
