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
import { PersonalPayService } from './personal-pay.js';
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

describe('personal send and request (Postgres)', () => {
  let db: TestDatabase;
  let ledger: MemoryLedger;
  let bank: BankServices;
  let router: ReturnType<typeof createBankRouter>;
  let created: RequestCreatedNotice[];

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
    const bus = new MemoryEventBus('svc-bank');
    const inner = eventPersonalRequestNotices(bus);
    bank = createBankServices(db.sql, ledger, memoryLedgerHistory(ledger), {
      nativeAssetId: 'IFC',
      recipients: memoryRecipientState(),
      handles: memoryPartyHandles({ [ADA]: 'ada', [BOB]: 'bob' }),
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

  async function ready() {
    await bank.spaces.ensurePrimary(ADA, 'USDT');
    await bank.spaces.ensurePrimary(BOB, 'USDT');
    await ledger.post(
      recipes.deposit({ userId: ADA, assetId: 'USDT', amount: parseAmount('100'), rail: 'test', railRef: `ada-${Math.random()}` }),
    );
  }

  async function available(userId: string) {
    return formatAmount((await ledger.balance(userAvailable(userId, 'USDT'))).amount);
  }

  it('records a note, both handles, and one ledger posting', async () => {
    await ready();
    const ada = await caller(ADA, ['bank:read', 'bank:write']);
    const from = await bank.spaces.ensurePrimary(ADA, 'USDT');
    const sent = await ada.transfers.toUser({
      transferId: 'send-note-1',
      fromSpaceId: from.id,
      toUserId: BOB,
      amount: '20',
      note: '  rent share  ',
    });
    expect(sent.note).toBe('rent share');
    expect(sent.amount).toBe('20');
    expect(sent.requestId).toBeNull();

    const again = await ada.transfers.toUser({
      transferId: 'send-note-1',
      fromSpaceId: from.id,
      toUserId: BOB,
      amount: '20',
      note: 'rent share',
    });
    expect(again.ledgerTxId).toBe(sent.ledgerTxId);
    expect(ledger.journal().filter((tx) => tx.reason === 'bank.transfer.manual')).toHaveLength(1);
    expect(await available(ADA)).toBe('80');
    expect(await available(BOB)).toBe('20');

    const tx = await ledger.getTx(sent.ledgerTxId);
    const bob = await caller(BOB, ['bank:read', 'bank:write']);
    const receipt = await bob.transfers.get({ ledgerTxId: sent.ledgerTxId });
    expect(receipt).toMatchObject({
      ledgerTxId: sent.ledgerTxId,
      transferId: 'send-note-1',
      createdAt: tx!.postedAt.toISOString(),
      fromHandle: 'ada',
      toHandle: 'bob',
      handlesBlocker: null,
      fee: null,
      status: 'posted',
      amount: '20',
      assetId: 'USDT',
      note: 'rent share',
    });

    const feed = await bob.activity.list({ limit: 20 });
    const incoming = feed.items.find((item) => item.kind === 'transfer_in');
    expect(incoming).toMatchObject({ note: 'rent share', counterparty: { handle: 'ada' }, amount: '20' });

    await expect(
      ada.transfers.toUser({ transferId: 'send-note-1', fromSpaceId: from.id, toUserId: BOB, amount: '20', note: 'different' }),
    ).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('bank.personal_transfer_conflict') });
    expect(ledger.journal().filter((tx) => tx.reason === 'bank.transfer.manual')).toHaveLength(1);

    const stranger = await caller(CY, ['bank:read']);
    await expect(stranger.transfers.get({ ledgerTxId: sent.ledgerTxId })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: expect.stringContaining('bank.personal_transfer_not_found'),
    });
  });

  it('refuses a control-character note and posts nothing', async () => {
    await ready();
    const ada = await caller(ADA, ['bank:write']);
    const from = await bank.spaces.ensurePrimary(ADA, 'USDT');
    await expect(
      ada.transfers.toUser({ transferId: 'send-bad-note', fromSpaceId: from.id, toUserId: BOB, amount: '1', note: 'hi\nthere' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringContaining('bank.personal_note_invalid') });
    expect(ledger.journal().filter((tx) => tx.reason === 'bank.transfer.manual')).toHaveLength(0);
  });

  it('quotes only a published zero fee and refuses an unpublished or unwired fee', async () => {
    await ready();
    const ada = await caller(ADA, ['bank:read', 'bank:write']);
    await expect(ada.transfers.quote({ assetId: 'USDT', amount: '10' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining('bank.personal_transfer_terms_unset'),
    });

    await db.sql`
      INSERT INTO bank.personal_transfer_terms (asset_id, per_transfer_limit, daily_limit, fee)
      VALUES ('USDT', 25.5, 100, 0)
    `;
    expect(await ada.transfers.quote({ assetId: 'USDT', amount: '10' })).toEqual({
      assetId: 'USDT',
      amount: '10',
      perTransferLimit: '25.5',
      dailyLimit: '100',
      spentToday: '0',
      fee: '0',
      feeBlocker: null,
      withinPerTransfer: true,
      withinDaily: true,
    });

    const from = await bank.spaces.ensurePrimary(ADA, 'USDT');
    await expect(
      ada.transfers.toUser({ transferId: 'send-over-cap', fromSpaceId: from.id, toUserId: BOB, amount: '26' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringContaining('bank.personal_transfer_limit_exceeded') });
    expect(ledger.journal().filter((tx) => tx.reason === 'bank.transfer.manual')).toHaveLength(0);

    await ada.transfers.toUser({ transferId: 'send-under-cap', fromSpaceId: from.id, toUserId: BOB, amount: '20' });
    expect(await ada.transfers.quote({ assetId: 'USDT', amount: '10' })).toMatchObject({
      spentToday: '20',
      withinDaily: true,
    });

    await db.sql`UPDATE bank.personal_transfer_terms SET fee = 1.5 WHERE asset_id = 'USDT'`;
    expect(await ada.transfers.quote({ assetId: 'USDT', amount: '1' })).toMatchObject({
      fee: '1.5',
      feeBlocker: 'bank.personal_transfer_fee_unwired',
    });
    const before = ledger.journal().length;
    await expect(
      ada.transfers.toUser({ transferId: 'send-fee-blocked', fromSpaceId: from.id, toUserId: BOB, amount: '1' }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', message: expect.stringContaining('bank.personal_transfer_fee_unwired') });
    expect(ledger.journal()).toHaveLength(before);
  });

  it('opens, lists, cancels, declines, reminds, and settles one request exactly once', async () => {
    await ready();
    const ada = await caller(ADA, ['bank:read', 'bank:write']);
    const bob = await caller(BOB, ['bank:read', 'bank:write']);
    const expiresAt = '2026-12-01T00:00:00.000Z';

    const opened = await ada.personalRequest.create({
      payerUserId: BOB,
      assetId: 'USDT',
      amount: '12.5',
      note: 'lunch',
      expiresAt,
      idempotencyKey: 'request-key-1',
    });
    expect(opened).toMatchObject({
      payeeUserId: ADA,
      payerUserId: BOB,
      payeeHandle: 'ada',
      payerHandle: 'bob',
      amount: '12.5',
      note: 'lunch',
      status: 'open',
      ledgerTxId: null,
      notice: { delivered: true, blocker: null },
    });
    expect(created.map((row) => row.sequence)).toEqual([1]);

    const replay = await ada.personalRequest.create({
      payerUserId: BOB,
      assetId: 'USDT',
      amount: '12.5',
      note: 'lunch',
      expiresAt,
      idempotencyKey: 'request-key-1',
    });
    expect(replay.requestId).toBe(opened.requestId);

    expect(await bob.personalRequest.list({ direction: 'incoming', status: 'open', limit: 20 })).toHaveLength(1);
    expect(await ada.personalRequest.list({ direction: 'outgoing', limit: 20 })).toHaveLength(1);
    expect((await bob.personalRequest.get({ requestId: opened.requestId })).status).toBe('open');

    const toCancel = await ada.personalRequest.create({
      payerUserId: BOB,
      assetId: 'USDT',
      amount: '1',
      expiresAt,
      idempotencyKey: 'request-key-cancel',
    });
    await expect(bob.personalRequest.cancel({ requestId: toCancel.requestId })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: expect.stringContaining('bank.personal_request_not_payee'),
    });
    expect((await ada.personalRequest.cancel({ requestId: toCancel.requestId })).status).toBe('cancelled');

    const toDecline = await ada.personalRequest.create({
      payerUserId: BOB,
      assetId: 'USDT',
      amount: '1',
      expiresAt,
      idempotencyKey: 'request-key-decline',
    });
    expect((await bob.personalRequest.decline({ requestId: toDecline.requestId })).status).toBe('declined');

    const reminded = await ada.personalRequest.remind({ requestId: opened.requestId, idempotencyKey: 'remind-key-1' });
    expect(reminded.status).toBe('open');
    expect(created.map((row) => row.sequence)).toEqual([1, 1, 1, 2]);

    const from = await bank.spaces.ensurePrimary(BOB, 'USDT');
    await ledger.post(
      recipes.deposit({ userId: BOB, assetId: 'USDT', amount: parseAmount('30'), rail: 'test', railRef: `bob-${Math.random()}` }),
    );
    const paid = await bob.transfers.toUser({
      transferId: 'pay-request-1',
      fromSpaceId: from.id,
      toUserId: ADA,
      amount: '12.5',
      requestId: opened.requestId,
    });
    expect((await ada.personalRequest.get({ requestId: opened.requestId })).status).toBe('paid');
    expect((await ada.personalRequest.get({ requestId: opened.requestId })).ledgerTxId).toBe(paid.ledgerTxId);

    await expect(
      bob.transfers.toUser({
        transferId: 'pay-request-2',
        fromSpaceId: from.id,
        toUserId: ADA,
        amount: '12.5',
        requestId: opened.requestId,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(ledger.journal().filter((tx) => tx.idempotencyKey.startsWith('pay.personal.request:pay-request-'))).toHaveLength(1);
  });

  async function bobPots(namedId: string) {
    return {
      primary: formatAmount((await ledger.balance(userAvailable(BOB, 'USDT'))).amount),
      named: formatAmount((await ledger.balance(subAccountAvailable(namedId, 'USDT'))).amount),
    };
  }

  /** A refusal the door may wrap. The ledger code lives on the cause when the sentence is not published. */
  function refusalText(err: unknown): string {
    const chunks: string[] = [];
    let current: unknown = err;
    for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth += 1) {
      if (typeof current !== 'object') {
        chunks.push(String(current));
        break;
      }
      const record = current as { message?: unknown; code?: unknown; cause?: unknown };
      if (record.message !== undefined) chunks.push(String(record.message));
      if (record.code !== undefined) chunks.push(String(record.code));
      current = record.cause;
    }
    return chunks.join('\n');
  }

  it('refuses to mark a request paid when the transfer pays the payer or a third user', async () => {
    await ready();
    const ada = await caller(ADA, ['bank:read', 'bank:write']);
    const bob = await caller(BOB, ['bank:read', 'bank:write']);
    const expiresAt = '2026-12-01T00:00:00.000Z';
    const opened = await ada.personalRequest.create({
      payerUserId: BOB,
      assetId: 'USDT',
      amount: '12.5',
      expiresAt,
      idempotencyKey: 'request-payee-mismatch',
    });
    await ledger.post(
      recipes.deposit({ userId: BOB, assetId: 'USDT', amount: parseAmount('40'), rail: 'test', railRef: `bob-named-${Math.random()}` }),
    );
    const primary = await bank.spaces.ensurePrimary(BOB, 'USDT');
    const named = await bob.spaces.create({ assetId: 'USDT', name: 'Spending' });
    await bank.transfers.transfer({
      transferId: 'fund-bob-named-space',
      fromSpaceId: primary.id,
      toSpaceId: named.id,
      amount: parseAmount('20'),
    });
    const before = await bobPots(named.id);
    const selfId = 'pay-request-to-self';

    await expect(
      bob.transfers.toUser({
        transferId: selfId,
        fromSpaceId: named.id,
        toUserId: BOB,
        amount: '12.5',
        requestId: opened.requestId,
      }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('bank.personal_request_payee_mismatch'),
    });

    const afterSelf = await ada.personalRequest.get({ requestId: opened.requestId });
    expect(afterSelf.status).toBe('open');
    expect(afterSelf.ledgerTxId).toBeNull();
    expect(ledger.journal().some((tx) => tx.idempotencyKey === `pay.personal.request:${selfId}:0`)).toBe(false);
    expect(await bobPots(named.id)).toEqual(before);

    await bank.spaces.ensurePrimary(CY, 'USDT');
    const thirdId = 'pay-request-to-third';
    await expect(
      bob.transfers.toUser({
        transferId: thirdId,
        fromSpaceId: named.id,
        toUserId: CY,
        amount: '12.5',
        requestId: opened.requestId,
      }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('bank.personal_request_payee_mismatch'),
    });

    const afterThird = await ada.personalRequest.get({ requestId: opened.requestId });
    expect(afterThird.status).toBe('open');
    expect(afterThird.ledgerTxId).toBeNull();
    expect(ledger.journal().some((tx) => tx.idempotencyKey === `pay.personal.request:${thirdId}:0`)).toBe(false);
    expect(await bobPots(named.id)).toEqual(before);
    expect(formatAmount((await ledger.balance(userAvailable(CY, 'USDT'))).amount)).toBe('0');
  });

  it('does not adopt an own-space ledger transaction as payment of a request', async () => {
    await ready();
    const ada = await caller(ADA, ['bank:read', 'bank:write']);
    const bob = await caller(BOB, ['bank:read', 'bank:write']);
    const opened = await ada.personalRequest.create({
      payerUserId: BOB,
      assetId: 'USDT',
      amount: '12.5',
      expiresAt: '2026-12-01T00:00:00.000Z',
      idempotencyKey: 'request-key-reuse',
    });
    await ledger.post(
      recipes.deposit({ userId: BOB, assetId: 'USDT', amount: parseAmount('40'), rail: 'test', railRef: `bob-own-${Math.random()}` }),
    );
    const primary = await bank.spaces.ensurePrimary(BOB, 'USDT');
    const named = await bob.spaces.create({ assetId: 'USDT', name: 'Spending' });
    const own = await bank.transfers.transfer({
      transferId: 'own-space-key',
      fromSpaceId: primary.id,
      toSpaceId: named.id,
      amount: parseAmount('12.5'),
    });

    const refused = await bob.transfers
      .toUser({
        transferId: 'own-space-key',
        fromSpaceId: primary.id,
        toUserId: ADA,
        amount: '12.5',
        requestId: opened.requestId,
      })
      .then(
        () => {
          throw new Error('expected a refusal');
        },
        (err: unknown) => err,
      );
    expect(refusalText(refused)).toMatch(/idempotency_conflict|bank\.personal_transfer_conflict/);

    const request = await ada.personalRequest.get({ requestId: opened.requestId });
    expect(request.status).toBe('open');
    expect(request.ledgerTxId).toBeNull();
    const posted = await db.sql<Array<{ status: string }>>`
      SELECT status FROM bank.personal_transfers WHERE transfer_id = 'own-space-key' AND status = 'posted'
    `;
    expect(posted).toHaveLength(0);
    await expect(ada.transfers.get({ ledgerTxId: own.ledgerTxId })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: expect.stringContaining('bank.personal_transfer_not_found'),
    });
  });

  it('keeps the request claim when the ledger reply is lost and resumes the same transfer', async () => {
    await ready();
    const ada = await caller(ADA, ['bank:read', 'bank:write']);
    const bob = await caller(BOB, ['bank:read', 'bank:write']);
    const opened = await ada.personalRequest.create({
      payerUserId: BOB,
      assetId: 'USDT',
      amount: '12.5',
      expiresAt: '2026-12-01T00:00:00.000Z',
      idempotencyKey: 'request-lost-reply',
    });
    await ledger.post(
      recipes.deposit({ userId: BOB, assetId: 'USDT', amount: parseAmount('40'), rail: 'test', railRef: `bob-lost-${Math.random()}` }),
    );
    const primary = await bank.spaces.ensurePrimary(BOB, 'USDT');
    const transferId = 'lost-reply-send';
    let posts = 0;
    let lookups = 0;
    const personal = new PersonalPayService(
      db.sql,
      {
        getTx: (id) => ledger.getTx(id),
        getTxByKey: async (key) => {
          lookups += 1;
          if (lookups === 1) return null;
          return ledger.getTxByKey(key);
        },
        balance: (ref) => ledger.balance(ref),
      },
      {
        transferToUser: async (input) => {
          const posted = await bank.transfers.transferToUser(input);
          posts += 1;
          if (posts === 1) throw new Error('timeout');
          return posted;
        },
      },
      bank.spaces,
      { handles: memoryPartyHandles({ [ADA]: 'ada', [BOB]: 'bob' }) },
    );
    const sendInput = {
      actorUserId: BOB,
      transferId,
      fromSpaceId: primary.id,
      toUserId: ADA,
      amount: parseAmount('12.5') as Amount,
      requestId: opened.requestId,
    };

    await expect(personal.send(sendInput)).rejects.toThrow('timeout');

    const reserved = await db.sql<Array<{ status: string }>>`
      SELECT status FROM bank.personal_transfers WHERE transfer_id = ${transferId}
    `;
    expect(reserved).toEqual([{ status: 'reserved' }]);
    const claimed = await db.sql<Array<{ claim_transfer_id: string | null; status: string; ledger_tx_id: string | null }>>`
      SELECT claim_transfer_id, status, ledger_tx_id FROM bank.personal_requests WHERE id = ${opened.requestId}
    `;
    expect(claimed).toEqual([{ claim_transfer_id: transferId, status: 'open', ledger_tx_id: null }]);

    await expect(
      bob.transfers.toUser({
        transferId: 'lost-reply-new1',
        fromSpaceId: primary.id,
        toUserId: ADA,
        amount: '12.5',
        requestId: opened.requestId,
      }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('bank.personal_request_claim_held'),
    });

    const booked = ledger.journal().find((tx) => tx.idempotencyKey === `pay.personal.request:${transferId}:0`);
    const again = await personal.send(sendInput);
    expect(again.ledgerTxId).toBe(booked?.id);
    const paid = await ada.personalRequest.get({ requestId: opened.requestId });
    expect(paid.status).toBe('paid');
    expect(paid.ledgerTxId).toBe(booked?.id);
    expect(ledger.journal().filter((tx) => tx.idempotencyKey.startsWith('pay.personal.request:'))).toHaveLength(1);
  });

  it('refuses a session that lacks the procedure scope', async () => {
    const readOnly = await caller(ADA, ['bank:read']);
    const writeOnly = await caller(ADA, ['bank:write']);
    await expect(
      readOnly.transfers.toUser({
        transferId: 'send-no-scope',
        fromSpaceId: '55555555-5555-4555-8555-555555555555',
        toUserId: BOB,
        amount: '1',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      readOnly.personalRequest.create({
        payerUserId: BOB,
        assetId: 'USDT',
        amount: '1',
        expiresAt: '2026-12-01T00:00:00.000Z',
        idempotencyKey: 'request-no-scope',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(writeOnly.transfers.quote({ assetId: 'USDT', amount: '1' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(writeOnly.transfers.get({ ledgerTxId: 'missing' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
