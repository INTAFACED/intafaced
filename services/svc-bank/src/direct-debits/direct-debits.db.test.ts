/**
 * BK-xfer-11 (J-bank-06 #4): Direct Debit mandates, block and unblock, the collection run and refund requests.
 *
 * Postgres (TEST_DATABASE_URL) and a MemoryLedger. The scheme is the TEST stand-in over a typed catalogue; each case
 * drives the collection run with its own `now`.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import {
  InvalidEntryError,
  MemoryLedger,
  formatAmount,
  parseAmount as amt,
  railBoundary,
  recipes,
  userAvailable,
  type LedgerClient,
} from '@intafaced/ledger-client';
import { memoryLedgerHistory } from '../analytics/ledger-history.js';
import { createBankServices } from '../bank-service.js';
import { createBankRouter, type BankRouter } from '../router.js';
import { RecipientStateUnavailableError, memoryRecipientState } from '../recipient-state.js';
import { postToRail } from '../personal-pay/post.js';
import { collectionTransferId } from './direct-debits.js';
import { ddSimCollectionBody, ddSimMandateBody } from './job-bodies.js';
import { DD_SIM_RAIL, directDebitSimScheme, unsetDirectDebitScheme, type DirectDebitScheme } from './scheme.js';

const SECRET = 'bank-direct-debits-principal-secret-32chars';
const USER = '41111111-1111-4111-8111-111111111111';
const OTHER = '42222222-2222-4222-8222-222222222222';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const MIGRATIONS = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));
const DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';

const db: TestDatabase = await createTestDatabase({ service: 'bank', url: DB_URL, migrations: MIGRATIONS });
const sql = db.sql;

afterAll(async () => {
  await db.drop();
}, 30_000);

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-11-02T09:00:00.000Z');
const at = (days: number) => new Date(NOW.getTime() + days * DAY);
const CREDITOR = 'TEST-GYM';
const sim = (guaranteeDays: number | null = 30) =>
  directDebitSimScheme({ label: 'TEST direct debit stand-in', guaranteeDays, creditors: [{ id: CREDITOR, name: 'TEST Gym' }] });

let ledger: MemoryLedger;
let recipients: ReturnType<typeof memoryRecipientState>;

beforeEach(async () => {
  await sql`TRUNCATE bank.dd_refund_requests, bank.dd_collections, bank.dd_mandates, bank.spaces RESTART IDENTITY CASCADE`;
  ledger = new MemoryLedger();
  recipients = memoryRecipientState();
});

function services(scheme: DirectDebitScheme = sim(), book: LedgerClient = ledger) {
  return createBankServices(sql, book, memoryLedgerHistory(ledger), { recipients, directDebitScheme: scheme });
}

async function fund(amount: string, ref: string, userId = USER) {
  await ledger.post(recipes.deposit({ userId, assetId: 'USDT', amount: amt(amount), rail: 'test', railRef: ref }));
}
const main = async (userId = USER) => formatAmount((await ledger.balance(userAvailable(userId, 'USDT'))).amount);
const atRail = async () => formatAmount((await ledger.balance(railBoundary(DD_SIM_RAIL, 'USDT'))).amount);

async function mandate(bank: ReturnType<typeof services>, id = 'MD-1', userId = USER) {
  return bank.directDebits.setUpMandate({
    mandateId: id,
    userId,
    creditorId: CREDITOR,
    reference: 'TEST membership 0042',
    assetId: 'USDT',
  });
}

describe('no scheme wired', () => {
  it('lists nothing with rail.bank, and every control and scheme door refuses rail.bank', async () => {
    const bank = services(unsetDirectDebitScheme);
    expect(await bank.directDebits.list(USER, NOW)).toEqual({
      scheme: { status: 'unset', standIn: null, guaranteeDays: null, blocker: 'rail.bank' },
      mandates: [],
      collections: [],
    });
    for (const attempt of [
      () => bank.directDebits.block({ userId: USER, mandateId: 'MD-1' }),
      () => bank.directDebits.unblock({ userId: USER, mandateId: 'MD-1' }),
      () => bank.directDebits.requestRefund({ userId: USER, collectionRowId: '00000000-0000-4000-8000-000000000000', reason: 'x' }),
      () => mandate(bank),
      () => bank.directDebits.present({ mandateId: 'MD-1', collectionId: 'C-1', amount: '1', dueAt: NOW.toISOString() }),
      () => bank.directDebits.runDue({ limit: 10, now: NOW }),
    ]) {
      await expect(attempt()).rejects.toMatchObject({ code: 'rail.bank' });
    }
    expect(ledger.journal()).toHaveLength(0);
  });
});

describe('setting up a mandate (the scheme speaking)', () => {
  it('answers a replay with the same mandate, and refuses other terms, an unknown creditor and a frozen account', async () => {
    const bank = services();
    const first = await mandate(bank);
    expect(first).toMatchObject({ id: 'MD-1', creditorName: 'TEST Gym', status: 'active', userId: USER });
    expect(await mandate(bank)).toMatchObject({ id: 'MD-1', createdAt: first.createdAt });
    await expect(mandate(bank, 'MD-1', OTHER)).rejects.toMatchObject({ code: 'bank.dd_mandate_conflict' });
    await expect(
      bank.directDebits.setUpMandate({ mandateId: 'MD-2', userId: USER, creditorId: 'NOBODY', reference: 'r', assetId: 'USDT' }),
    ).rejects.toMatchObject({ code: 'bank.dd_creditor_unknown' });
    recipients.set(OTHER, 'frozen');
    await expect(mandate(bank, 'MD-3', OTHER)).rejects.toMatchObject({ code: 'bank.recipient_cannot_receive' });
  });
});

describe('the collection run', () => {
  it('collects a due debit once to the scheme boundary, and a replayed presentment or a second run posts nothing', async () => {
    const bank = services();
    await fund('50', 'dd-fund-1');
    await mandate(bank);
    const presented = await bank.directDebits.present({
      mandateId: 'MD-1',
      collectionId: 'C-1',
      amount: '10',
      dueAt: at(1).toISOString(),
      now: NOW,
    });
    expect(presented).toMatchObject({ status: 'upcoming', amount: '10', userId: USER });

    expect(await bank.directDebits.runDue({ limit: 10, now: NOW })).toMatchObject({ considered: 0, collected: 0 });
    expect(await main()).toBe('50');

    expect(await bank.directDebits.runDue({ limit: 10, now: at(1) })).toMatchObject({ considered: 1, collected: 1 });
    expect(await main()).toBe('40');
    expect(await atRail()).toBe('10');
    const key = `bank.transfer.rail:${collectionTransferId('MD-1', 'C-1')}:0`;
    expect(await ledger.getTxByKey(key)).not.toBeNull();

    const again = await bank.directDebits.present({ mandateId: 'MD-1', collectionId: 'C-1', amount: '10', dueAt: at(1).toISOString() });
    expect(again).toMatchObject({ id: presented.id, status: 'collected' });
    await expect(
      bank.directDebits.present({ mandateId: 'MD-1', collectionId: 'C-1', amount: '11', dueAt: at(1).toISOString() }),
    ).rejects.toMatchObject({ code: 'bank.dd_collection_conflict' });
    const posts = ledger.journal().length;
    expect(await bank.directDebits.runDue({ limit: 10, now: at(5) })).toMatchObject({ considered: 0 });
    expect(ledger.journal()).toHaveLength(posts);
  });

  it('fails a collection of 10 against a balance of 4 with bank.insufficient_funds, posts nothing, and shows the fee as not set', async () => {
    const bank = services();
    await fund('4', 'dd-fund-short');
    await mandate(bank);
    const presented = await bank.directDebits.present({ mandateId: 'MD-1', collectionId: 'C-10', amount: '10', dueAt: NOW.toISOString() });
    expect(await bank.directDebits.runDue({ limit: 10, now: NOW })).toMatchObject({ considered: 1, failed: 1, collected: 0 });
    expect(await main()).toBe('4');
    expect(await atRail()).toBe('0');
    const view = await bank.directDebits.list(USER, NOW);
    expect(view.collections).toEqual([
      expect.objectContaining({
        id: presented.id,
        status: 'failed',
        failureCode: 'bank.insufficient_funds',
        ledgerTxId: null,
        failureFee: null,
        failureFeeBlocker: 'bank.dd_failure_fee_unset',
        refund: { state: 'none', endsAt: null, requestedAt: null },
      }),
    ]);
    // The failure is recorded once: a later run does not retry or record it again.
    expect(await bank.directDebits.runDue({ limit: 10, now: at(1) })).toMatchObject({ considered: 0 });
    await expect(
      bank.directDebits.requestRefund({ userId: USER, collectionRowId: presented.id, reason: 'nothing was taken', now: NOW }),
    ).rejects.toMatchObject({ code: 'bank.dd_refund_not_collected' });
  });

  it('records an entry that posted before a crash instead of posting it again', async () => {
    const bank = services();
    await fund('30', 'dd-fund-crash');
    await mandate(bank);
    const presented = await bank.directDebits.present({ mandateId: 'MD-1', collectionId: 'C-9', amount: '7', dueAt: NOW.toISOString() });
    // The run claimed it, posted, and stopped before marking the row.
    await sql`UPDATE bank.dd_collections SET status = 'processing' WHERE id = ${presented.id}`;
    const posted = await postToRail(ledger, collectionTransferId('MD-1', 'C-9'), userAvailable(USER, 'USDT'), DD_SIM_RAIL, amt('7'));
    expect(await bank.directDebits.runDue({ limit: 10, now: NOW })).toMatchObject({ collected: 1 });
    expect(await main()).toBe('23');
    const view = await bank.directDebits.list(USER, NOW);
    expect(view.collections[0]).toMatchObject({ status: 'collected', ledgerTxId: posted.id });
  });

  it('rejects a collection on a frozen account without posting', async () => {
    const bank = services();
    await fund('30', 'dd-fund-frozen');
    await mandate(bank);
    await bank.directDebits.present({ mandateId: 'MD-1', collectionId: 'C-F', amount: '5', dueAt: NOW.toISOString() });
    recipients.set(USER, 'frozen');
    expect(await bank.directDebits.runDue({ limit: 10, now: NOW })).toMatchObject({ rejected: 1 });
    expect(await main()).toBe('30');
    expect((await bank.directDebits.list(USER, NOW)).collections[0]).toMatchObject({
      status: 'rejected',
      failureCode: 'bank.dd_account_unavailable',
    });
  });
});

describe('the collection run when things go wrong', () => {
  const due = (bank: ReturnType<typeof services>, collectionId: string, amount = '5') =>
    bank.directDebits.present({ mandateId: 'MD-1', collectionId, amount, dueAt: NOW.toISOString(), now: NOW });
  const status = async (bank: ReturnType<typeof services>, collectionId: string) =>
    (
      await sql<{ status: string; failure_code: string | null }[]>`
      SELECT status, failure_code FROM bank.dd_collections WHERE collection_id = ${collectionId}`
    )[0];

  it("refuses a ':' in a scheme id, so two collections never share one ledger key", async () => {
    const body = { userId: USER, creditorId: CREDITOR, reference: 'r', assetId: 'USDT' };
    expect(ddSimMandateBody.safeParse({ ...body, mandateId: 'X:Y' }).success).toBe(false);
    expect(ddSimMandateBody.safeParse({ ...body, mandateId: 'X.Y-1_2' }).success).toBe(true);
    expect(ddSimCollectionBody.safeParse({ mandateId: 'X', collectionId: 'Y:Z', amount: '1', dueAt: NOW.toISOString() }).success).toBe(
      false,
    );
    // And the table refuses one too, whoever writes it.
    await expect(mandate(services(), 'X:Y')).rejects.toThrow();
  });

  it('two overlapping runs debit a collection once, and the books agree with the rows', async () => {
    const bank = services();
    await fund('50', 'dd-fund-overlap');
    await mandate(bank);
    for (const id of ['C-A', 'C-B', 'C-C']) await due(bank, id, '4');
    await Promise.all([bank.directDebits.runDue({ limit: 10, now: NOW }), bank.directDebits.runDue({ limit: 10, now: NOW })]);
    // Invariant: what left the person, what reached the scheme's boundary and the collected rows are the same 12.
    expect(await main()).toBe('38');
    expect(await atRail()).toBe('12');
    const rows = await sql<{ total: string }[]>`
      SELECT coalesce(sum(amount), 0)::text AS total FROM bank.dd_collections WHERE status = 'collected'`;
    expect(formatAmount(amt(rows[0]!.total))).toBe('12');
    expect(ledger.journal()).toHaveLength(4);
  });

  it('a block racing the run never errors: each collection ends collected or refused, never both', async () => {
    const bank = services();
    await fund('100', 'dd-fund-race');
    await mandate(bank);
    for (let i = 0; i < 8; i += 1) await due(bank, `C-R${i}`, '1');
    const [blocked] = await Promise.all([
      bank.directDebits.block({ userId: USER, mandateId: 'MD-1', now: NOW }),
      bank.directDebits.runDue({ limit: 10, now: NOW }),
    ]);
    const rows = await sql<{ status: string }[]>`SELECT status FROM bank.dd_collections`;
    const collected = rows.filter((r) => r.status === 'collected').length;
    expect(rows.every((r) => r.status === 'collected' || r.status === 'rejected')).toBe(true);
    expect(blocked.rejected.length).toBeLessThanOrEqual(8 - collected);
    expect(await main()).toBe(formatAmount(amt('100') - amt(String(collected))));
  });

  it('a main balance that cannot be debited fails by its reason and posts nothing', async () => {
    const bank = services();
    await fund('50', 'dd-fund-locked');
    await mandate(bank);
    const primary = await bank.spaces.ensurePrimary(USER, 'USDT');
    await sql`UPDATE bank.spaces SET locked_until = ${at(5)} WHERE id = ${primary.id}`;
    await due(bank, 'C-L');
    expect(await bank.directDebits.runDue({ limit: 10, now: NOW })).toMatchObject({ failed: 1 });
    expect(await status(bank, 'C-L')).toEqual({ status: 'failed', failure_code: 'bank.space_locked' });
    expect(await main()).toBe('50');
  });

  it('an identity outage leaves the collection processing, and the next run collects it once', async () => {
    const bank = services();
    await fund('50', 'dd-fund-outage');
    await mandate(bank);
    await due(bank, 'C-O');
    recipients.failWith(new RecipientStateUnavailableError('identity is down'));
    const report = await bank.directDebits.runDue({ limit: 10, now: NOW });
    expect(report).toMatchObject({ collected: 0, failed: 0, rejected: 0 });
    expect(report.failures).toHaveLength(1);
    expect(await status(bank, 'C-O')).toEqual({ status: 'processing', failure_code: null });
    expect(await main()).toBe('50');
    recipients.failWith(null);
    expect(await bank.directDebits.runDue({ limit: 10, now: NOW })).toMatchObject({ collected: 1 });
    expect(await main()).toBe('45');
  });

  it('an entry the ledger refuses as invalid fails by name instead of staying processing', async () => {
    const refusing = Object.create(ledger) as MemoryLedger;
    refusing.post = async () => {
      throw new InvalidEntryError('TEST: the ledger holds no such asset');
    };
    const bank = services(sim(), refusing);
    await fund('50', 'dd-fund-invalid');
    await mandate(bank);
    await due(bank, 'C-I');
    expect(await bank.directDebits.runDue({ limit: 10, now: NOW })).toMatchObject({ failed: 1 });
    expect(await status(bank, 'C-I')).toEqual({ status: 'failed', failure_code: 'bank.dd_collection_invalid' });
    expect(await main()).toBe('50');
  });
});

describe('blocking a mandate', () => {
  it('rejects its upcoming and new collections with the reason, lists it blocked, and unblocking collects again', async () => {
    const bank = services();
    await fund('50', 'dd-fund-block');
    await mandate(bank);
    await bank.directDebits.present({ mandateId: 'MD-1', collectionId: 'C-1', amount: '10', dueAt: at(3).toISOString() });

    const blocked = await bank.directDebits.block({ userId: USER, mandateId: 'MD-1', now: NOW });
    expect(blocked).toMatchObject({ mandate: { status: 'blocked', blockedAt: NOW.toISOString() }, rejected: ['C-1'], tooLate: [] });
    // Blocking again changes nothing.
    expect(await bank.directDebits.block({ userId: USER, mandateId: 'MD-1' })).toMatchObject({
      mandate: { blockedAt: NOW.toISOString() },
      rejected: [],
    });

    const next = await bank.directDebits.present({ mandateId: 'MD-1', collectionId: 'C-2', amount: '10', dueAt: at(4).toISOString() });
    expect(next).toMatchObject({ status: 'rejected', failureCode: 'bank.dd_mandate_blocked' });
    expect(await bank.directDebits.runDue({ limit: 10, now: at(10) })).toMatchObject({ considered: 0 });
    expect(await main()).toBe('50');
    const view = await bank.directDebits.list(USER, NOW);
    expect(view.mandates).toEqual([expect.objectContaining({ id: 'MD-1', status: 'blocked', upcoming: [] })]);
    expect(view.collections.map((c) => [c.collectionId, c.status, c.failureCode])).toEqual([
      ['C-2', 'rejected', 'bank.dd_mandate_blocked'],
      ['C-1', 'rejected', 'bank.dd_mandate_blocked'],
    ]);

    expect(await bank.directDebits.unblock({ userId: USER, mandateId: 'MD-1' })).toMatchObject({
      mandate: { status: 'active', blockedAt: null },
    });
    await bank.directDebits.present({ mandateId: 'MD-1', collectionId: 'C-3', amount: '10', dueAt: at(5).toISOString() });
    expect(await bank.directDebits.runDue({ limit: 10, now: at(5) })).toMatchObject({ collected: 1 });
    expect(await main()).toBe('40');
  });

  it('names a collection a run already claimed as too late, and that one still settles', async () => {
    const bank = services();
    await fund('20', 'dd-fund-late');
    await mandate(bank);
    const claimed = await bank.directDebits.present({ mandateId: 'MD-1', collectionId: 'C-L', amount: '5', dueAt: NOW.toISOString() });
    await sql`UPDATE bank.dd_collections SET status = 'processing' WHERE id = ${claimed.id}`;
    const blocked = await bank.directDebits.block({ userId: USER, mandateId: 'MD-1', now: NOW });
    expect(blocked.tooLate).toEqual([{ collectionId: 'C-L', code: 'bank.dd_too_late' }]);
    expect(await bank.directDebits.runDue({ limit: 10, now: NOW })).toMatchObject({ collected: 1 });
    expect(await main()).toBe('15');
  });

  it("reads another person's mandate as missing", async () => {
    const bank = services();
    await mandate(bank);
    await expect(bank.directDebits.block({ userId: OTHER, mandateId: 'MD-1' })).rejects.toMatchObject({
      code: 'bank.dd_mandate_not_found',
    });
    await expect(bank.directDebits.unblock({ userId: OTHER, mandateId: 'MD-1' })).rejects.toMatchObject({
      code: 'bank.dd_mandate_not_found',
    });
    expect((await bank.directDebits.list(OTHER, NOW)).mandates).toEqual([]);
  });

  it('shows the next month of upcoming collections on the mandate, soonest first', async () => {
    const bank = services();
    await mandate(bank);
    for (const [id, days] of [
      ['C-40', 40],
      ['C-20', 20],
      ['C-5', 5],
    ] as const) {
      await bank.directDebits.present({ mandateId: 'MD-1', collectionId: id, amount: '1', dueAt: at(days).toISOString() });
    }
    const view = await bank.directDebits.list(USER, NOW);
    expect(view.mandates[0]!.upcoming.map((c) => c.collectionId)).toEqual(['C-5', 'C-20']);
    expect(view.collections).toEqual([]);
  });
});

describe('a refund request', () => {
  async function collected(bank: ReturnType<typeof services>) {
    await fund('50', 'dd-fund-refund');
    await mandate(bank);
    const row = await bank.directDebits.present({ mandateId: 'MD-1', collectionId: 'C-R', amount: '12', dueAt: NOW.toISOString() });
    await bank.directDebits.runDue({ limit: 10, now: NOW });
    return row.id;
  }

  it('is created once inside the guarantee period, and support sees it', async () => {
    const bank = services();
    const id = await collected(bank);
    const before = (await bank.directDebits.list(USER, NOW)).collections[0]!;
    expect(before.refund).toEqual({ state: 'available', endsAt: at(30).toISOString(), requestedAt: null });

    const first = await bank.directDebits.requestRefund({
      userId: USER,
      collectionRowId: id,
      reason: 'I cancelled this membership',
      now: at(2),
    });
    expect(first).toMatchObject({ created: true, collection: { refund: { state: 'requested', requestedAt: at(2).toISOString() } } });
    const second = await bank.directDebits.requestRefund({ userId: USER, collectionRowId: id, reason: 'again', now: at(3) });
    expect(second).toMatchObject({ created: false, collection: { refund: { requestedAt: at(2).toISOString() } } });

    expect(await bank.directDebits.opsRefunds({}, at(3))).toEqual([
      expect.objectContaining({ id, userId: USER, reason: 'I cancelled this membership', amount: '12', creditorName: 'TEST Gym' }),
    ]);
    // A request moves no money: the credit back is the scheme's answer.
    expect(await main()).toBe('38');
    await expect(
      bank.directDebits.requestRefund({ userId: OTHER, collectionRowId: id, reason: 'not mine', now: at(2) }),
    ).rejects.toMatchObject({ code: 'bank.dd_collection_not_found' });
  });

  it('is refused after the period with its end date, keeps the window fixed when collected, and is refused with no period', async () => {
    const bank = services();
    const id = await collected(bank);
    await expect(bank.directDebits.requestRefund({ userId: USER, collectionRowId: id, reason: 'late', now: at(31) })).rejects.toMatchObject(
      {
        code: 'bank.dd_refund_window_closed',
        message: expect.stringContaining(at(30).toISOString()),
      },
    );
    // The period changes later (here to 8 days): the window this debit was collected with does not move.
    const shorter = services(sim(8));
    expect((await shorter.directDebits.list(USER, at(10))).collections[0]!.refund).toEqual({
      state: 'available',
      endsAt: at(30).toISOString(),
      requestedAt: null,
    });

    // Collected while no period was set: no refund window, and a request is refused by name.
    const unset = services(sim(null));
    await unset.directDebits.present({ mandateId: 'MD-1', collectionId: 'C-U', amount: '1', dueAt: NOW.toISOString() });
    await unset.directDebits.runDue({ limit: 10, now: NOW });
    const without = (await unset.directDebits.list(USER, NOW)).collections.find((c) => c.collectionId === 'C-U')!;
    expect(without.refund).toEqual({ state: 'unset', endsAt: null, requestedAt: null });
    await expect(
      unset.directDebits.requestRefund({ userId: USER, collectionRowId: without.id, reason: 'x', now: NOW }),
    ).rejects.toMatchObject({ code: 'bank.dd_guarantee_unset' });
  });
});

describe('the customer doors', () => {
  const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-bank' });
  function headers(userId: string): Record<string, string> {
    const raw = encodePrincipal({
      sub: userId,
      userId,
      sid: '33333333-3333-4333-8333-333333333333',
      scopes: ['bank:read', 'bank:write'],
      tier: 'full',
      mfa: true,
      expiresAt: new Date(Date.now() + 60_000),
    } as Principal);
    return {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
      'content-type': 'application/json',
    };
  }
  async function mount(scheme: DirectDebitScheme): Promise<FastifyInstance> {
    const app = Fastify({ logger: false });
    await app.register(fastifyTRPCPlugin, {
      prefix: '/trpc',
      trpcOptions: {
        router: createBankRouter(services(scheme)),
        createContext: ({ req }) => edgeContext(req),
      } satisfies FastifyTRPCPluginOptions<BankRouter>['trpcOptions'],
    });
    await app.ready();
    return app;
  }

  it('lists, blocks and refuses a stranger and the support queue over HTTP; with no scheme, a block is rail.bank', async () => {
    await mandate(services());
    const app = await mount(sim());
    try {
      const list = await app.inject({ method: 'GET', url: '/trpc/directDebits.list', headers: headers(USER) });
      expect(list.statusCode).toBe(200);
      expect(list.json().result.data.mandates[0]).toMatchObject({ id: 'MD-1', status: 'active' });
      const block = (userId: string) =>
        app.inject({ method: 'POST', url: '/trpc/directDebits.block', headers: headers(userId), payload: { mandateId: 'MD-1' } });
      expect((await block(OTHER)).statusCode).toBe(404);
      const mine = await block(USER);
      expect(mine.statusCode).toBe(200);
      expect(mine.json().result.data.mandate.status).toBe('blocked');
      const ops = await app.inject({
        method: 'GET',
        url: `/trpc/directDebits.ops.refunds?input=${encodeURIComponent('{}')}`,
        headers: headers(USER),
      });
      expect(ops.statusCode).toBe(403);
    } finally {
      await app.close();
    }
    const off = await mount(unsetDirectDebitScheme);
    try {
      const refused = await off.inject({
        method: 'POST',
        url: '/trpc/directDebits.block',
        headers: headers(USER),
        payload: { mandateId: 'MD-1' },
      });
      expect(refused.statusCode).toBe(412);
      expect(refused.json().error.data.cause.code).toBe('rail.bank');
    } finally {
      await off.close();
    }
  });
});
