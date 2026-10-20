/**
 * Unit card — a frozen or closed recipient cannot be paid
 *
 * 1. Promise: every credit-by-id path in svc-bank asks identity whether the
 *    recipient can receive, and refuses `bank.recipient_cannot_receive` BEFORE
 *    any ledger posting. Frozen, closed and unknown give one code, one message.
 * 2. Break: `findPrimary` only checked that a primary space row existed, so a
 *    sender with a saved user id could still pay a frozen or closed account.
 * 3. Done bar: frozen refused, closed refused (same message), active succeeds,
 *    no ledger line on refusal, retry with the same transferId refuses the same
 *    way, a retry of a transfer that already posted returns the original, an
 *    identity outage and an unset IDENTITY_URL both post nothing.
 * 4. Class M
 * 5. Paths: services/svc-bank/src/{recipient-state,spaces/space-service,transfers/transfer-service,business/business-service,router}.ts
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
import { MemoryLedger, formatAmount, parseAmount as amt, recipes, userAvailable } from '@intafaced/ledger-client';
import { memoryLedgerHistory } from './analytics/ledger-history.js';
import { createBankServices, type BankServices } from './bank-service.js';
import { createBankRouter, type BankRouter } from './router.js';
import {
  RecipientStateUnavailableError,
  createIdentityRecipientState,
  memoryRecipientState,
  unconfiguredRecipientState,
} from './recipient-state.js';

const SECRET = 'bank-recipient-cannot-receive-secret-0123456789';
const SENDER = '11111111-1111-4111-8111-111111111111';
const RECIPIENT = '22222222-2222-4222-8222-222222222222';
const MAKER = '33333333-3333-4333-8333-333333333333';
const CHECKER = '55555555-5555-4555-8555-555555555555';
const GHOST = '66666666-6666-4666-8666-666666666666';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', 'drizzle');
const MIGRATIONS = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';

const db: TestDatabase = await createTestDatabase({ service: 'bank', url: DB_URL, migrations: MIGRATIONS });
const sql = db.sql;
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-bank' });

afterAll(async () => {
  await db.drop();
}, 30_000);

const REFUSAL = { code: 'bank.recipient_cannot_receive', message: 'This recipient cannot receive payments' };

describe('recipient cannot receive — svc-bank refuses before posting', () => {
  let ledger: MemoryLedger;
  let identity: ReturnType<typeof memoryRecipientState>;
  let bank: BankServices;

  const available = async (userId: string) => formatAmount((await ledger.balance(userAvailable(userId, 'USDT'))).amount);
  const journalKeys = () => ledger.journal().map((tx) => tx.idempotencyKey);

  async function fund(userId: string, value: string) {
    await ledger.post(
      recipes.deposit({ userId, assetId: 'USDT', amount: amt(value), rail: 'test', railRef: `${userId}:${Math.random()}` }),
    );
  }

  async function sender() {
    const primary = await bank.spaces.ensurePrimary(SENDER, 'USDT');
    await bank.spaces.ensurePrimary(RECIPIENT, 'USDT');
    await fund(SENDER, '100');
    return primary;
  }

  beforeEach(async () => {
    await sql`
      TRUNCATE bank.business_payroll_lines, bank.business_payroll_runs,
               bank.business_approvals, bank.business_members, bank.business_accounts,
               bank.transfer_executions, bank.scheduled_transfers, bank.spaces
      RESTART IDENTITY CASCADE
    `;
    ledger = new MemoryLedger();
    identity = memoryRecipientState();
    bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), { nativeAssetId: 'IFC', recipients: identity });
  });

  describe('transferToUser', () => {
    it('refuses a frozen recipient and posts nothing', async () => {
      const from = await sender();
      identity.set(RECIPIENT, 'frozen');
      const before = journalKeys();

      await expect(
        bank.transfers.transferToUser({ transferId: 'frozen-transfer-1', fromSpaceId: from.id, toUserId: RECIPIENT, amount: amt('10') }),
      ).rejects.toMatchObject(REFUSAL);

      expect(journalKeys()).toEqual(before);
      expect(await available(SENDER)).toBe('100');
      expect(await available(RECIPIENT)).toBe('0');
    });

    it('refuses a closed recipient with the SAME code and message as frozen', async () => {
      const from = await sender();
      const refusal = async (status: 'frozen' | 'closed' | 'not_found') => {
        identity.set(RECIPIENT, status);
        return bank.transfers
          .transferToUser({ transferId: `state-${status}-1`, fromSpaceId: from.id, toUserId: RECIPIENT, amount: amt('10') })
          .then(
            () => null,
            (err: unknown) => err as { code: string; message: string },
          );
      };
      const frozen = await refusal('frozen');
      const closed = await refusal('closed');
      const unknown = await refusal('not_found');

      expect(frozen).toMatchObject(REFUSAL);
      expect(closed).toMatchObject(REFUSAL);
      expect(unknown).toMatchObject(REFUSAL);
      // Nothing in the wording names the state.
      expect(closed?.message).toBe(frozen?.message);
      expect(unknown?.message).toBe(frozen?.message);
      expect(frozen?.message).not.toMatch(/frozen|closed/i);
      expect(journalKeys().filter((k) => k.startsWith('bank.transfer'))).toEqual([]);
    });

    it('pays an active recipient', async () => {
      const from = await sender();
      const moved = await bank.transfers.transferToUser({
        transferId: 'active-transfer-1',
        fromSpaceId: from.id,
        toUserId: RECIPIENT,
        amount: amt('10'),
      });
      expect(moved.ledgerTxId).toBeTruthy();
      expect(await available(SENDER)).toBe('90');
      expect(await available(RECIPIENT)).toBe('10');
      expect(identity.asked).toContain(RECIPIENT);
    });

    it('a retry with the same transferId gets the same refusal, still posting nothing', async () => {
      const from = await sender();
      identity.set(RECIPIENT, 'frozen');
      const before = journalKeys();
      const input = { transferId: 'frozen-retry-1', fromSpaceId: from.id, toUserId: RECIPIENT, amount: amt('10') };

      const refuse = () =>
        bank.transfers.transferToUser(input).then(
          () => null,
          (e: unknown) => e as { code: string; message: string },
        );
      const first = await refuse();
      const second = await refuse();

      expect(first).toMatchObject(REFUSAL);
      expect(second).toMatchObject(REFUSAL);
      expect(second?.message).toBe(first?.message);
      expect(journalKeys()).toEqual(before);
    });

    it('a retry of a transfer that already posted returns the original after the recipient is frozen', async () => {
      const from = await sender();
      const input = { transferId: 'posted-then-frozen-1', fromSpaceId: from.id, toUserId: RECIPIENT, amount: amt('10') };
      const original = await bank.transfers.transferToUser(input);
      identity.set(RECIPIENT, 'frozen');
      const keysAfterFirst = journalKeys();

      const retry = await bank.transfers.transferToUser(input);

      expect(retry.ledgerTxId).toBe(original.ledgerTxId);
      expect(journalKeys()).toEqual(keysAfterFirst);
      expect(await available(RECIPIENT)).toBe('10');
    });

    it('a changed body on a posted id is NOT waved through just because the recipient is frozen', async () => {
      const from = await sender();
      await bank.transfers.transferToUser({
        transferId: 'posted-then-changed-1',
        fromSpaceId: from.id,
        toUserId: RECIPIENT,
        amount: amt('10'),
      });
      identity.set(RECIPIENT, 'frozen');
      const keys = journalKeys();

      await expect(
        bank.transfers.transferToUser({
          transferId: 'posted-then-changed-1',
          fromSpaceId: from.id,
          toUserId: RECIPIENT,
          amount: amt('99'),
        }),
      ).rejects.toBeTruthy();
      expect(journalKeys()).toEqual(keys);
      expect(await available(RECIPIENT)).toBe('10');
    });

    it("refuses by space id too (transfer to another user's space)", async () => {
      const from = await sender();
      const to = await bank.spaces.ensurePrimary(RECIPIENT, 'USDT');
      identity.set(RECIPIENT, 'closed');
      await expect(
        bank.transfers.transfer({ transferId: 'by-space-closed-1', fromSpaceId: from.id, toSpaceId: to.id, amount: amt('5') }),
      ).rejects.toMatchObject(REFUSAL);
      expect(await available(RECIPIENT)).toBe('0');
    });

    it('moving value between your OWN spaces needs no identity call', async () => {
      const from = await sender();
      const pot = await bank.spaces.create({ userId: SENDER, assetId: 'USDT', name: 'Rent' });
      identity.failWith(new RecipientStateUnavailableError('down'));
      await bank.transfers.transfer({ transferId: 'own-spaces-1', fromSpaceId: from.id, toSpaceId: pot.id, amount: amt('5') });
      expect(identity.asked).toEqual([]);
      expect(formatAmount(await bank.spaces.balanceOf(pot))).toBe('5');
    });
  });

  describe('one answer for frozen, closed and no such account', () => {
    it('toUser: a user with no primary space refuses exactly like a frozen one', async () => {
      const from = await sender();
      identity.set(RECIPIENT, 'frozen');
      const refusal = (toUserId: string, transferId: string) =>
        bank.transfers.transferToUser({ transferId, fromSpaceId: from.id, toUserId, amount: amt('10') }).then(
          () => null,
          (e: unknown) => e as { code: string; message: string },
        );
      const frozen = await refusal(RECIPIENT, 'uniform-frozen-1');
      const ghost = await refusal(GHOST, 'uniform-ghost-1');
      const blank = await refusal('  ', 'uniform-blank-1');
      expect(ghost).toMatchObject(REFUSAL);
      expect(ghost?.message).toBe(frozen?.message);
      expect(blank).toMatchObject(REFUSAL);
    });

    it('scheduleToUser: no primary space refuses exactly like a frozen one', async () => {
      const from = await sender();
      identity.set(RECIPIENT, 'frozen');
      const refusal = (toUserId: string) =>
        bank.transfers
          .scheduleToUser({
            scheduleId: randomUUID(),
            userId: SENDER,
            fromSpaceId: from.id,
            toUserId,
            amount: amt('10'),
            cadence: 'monthly',
            startsAt: new Date('2099-01-01T09:00:00Z'),
          })
          .then(
            () => null,
            (e: unknown) => e as { code: string; message: string },
          );
      const frozen = await refusal(RECIPIENT);
      const ghost = await refusal(GHOST);
      expect(frozen).toMatchObject(REFUSAL);
      expect(ghost).toMatchObject(REFUSAL);
      expect(ghost?.message).toBe(frozen?.message);
      expect(await sql`SELECT id FROM bank.scheduled_transfers`).toHaveLength(0);
    });
  });

  describe('identity down or not configured', () => {
    it('identity unreachable: retryable refusal, nothing posted, works again when identity is back', async () => {
      const from = await sender();
      identity.failWith(new RecipientStateUnavailableError('identity did not answer'));
      const before = journalKeys();
      const input = { transferId: 'identity-down-1', fromSpaceId: from.id, toUserId: RECIPIENT, amount: amt('10') };

      await expect(bank.transfers.transferToUser(input)).rejects.toMatchObject({ code: 'bank.recipient_check_unavailable' });
      expect(journalKeys()).toEqual(before);

      identity.failWith(null);
      const moved = await bank.transfers.transferToUser(input);
      expect(moved.amount).toBe('10');
      expect(await available(RECIPIENT)).toBe('10');
    });

    it('no IDENTITY_URL (unconfigured port): credits to another user refuse bank.recipient_check_unset, nothing posted', async () => {
      const unwired = createBankServices(sql, ledger, memoryLedgerHistory(ledger), { nativeAssetId: 'IFC' });
      const from = await unwired.spaces.ensurePrimary(SENDER, 'USDT');
      await unwired.spaces.ensurePrimary(RECIPIENT, 'USDT');
      await fund(SENDER, '100');
      const before = journalKeys();

      await expect(
        unwired.transfers.transferToUser({ transferId: 'unwired-1', fromSpaceId: from.id, toUserId: RECIPIENT, amount: amt('10') }),
      ).rejects.toMatchObject({ code: 'bank.recipient_check_unset' });
      expect(journalKeys()).toEqual(before);

      // Other features keep working: a move between your own spaces.
      const pot = await unwired.spaces.create({ userId: SENDER, assetId: 'USDT', name: 'Rent' });
      await unwired.transfers.transfer({ transferId: 'unwired-own-1', fromSpaceId: from.id, toSpaceId: pot.id, amount: amt('5') });
      expect(formatAmount(await unwired.spaces.balanceOf(pot))).toBe('5');
    });
  });

  describe('standing orders', () => {
    async function order(toUserId = RECIPIENT) {
      const from = await sender();
      return bank.transfers.scheduleToUser({
        scheduleId: randomUUID(),
        userId: SENDER,
        fromSpaceId: from.id,
        toUserId,
        amount: amt('25'),
        cadence: 'monthly',
        startsAt: new Date('2026-01-01T09:00:00Z'),
      });
    }

    it('scheduleToUser refuses a frozen recipient: no row, nothing posted', async () => {
      const from = await sender();
      identity.set(RECIPIENT, 'frozen');
      await expect(
        bank.transfers.scheduleToUser({
          scheduleId: randomUUID(),
          userId: SENDER,
          fromSpaceId: from.id,
          toUserId: RECIPIENT,
          amount: amt('25'),
          cadence: 'monthly',
          startsAt: new Date('2026-01-01T09:00:00Z'),
        }),
      ).rejects.toMatchObject(REFUSAL);
      expect(await sql`SELECT id FROM bank.scheduled_transfers`).toHaveLength(0);
    });

    it('a recipient frozen AFTER scheduling: the run records a rejection, posts nothing, does not crash', async () => {
      const schedule = await order();
      identity.set(RECIPIENT, 'frozen');
      const before = journalKeys();

      const report = await bank.transfers.runDueTransfers({ now: new Date('2026-01-01T10:00:00Z'), limit: 200 });

      expect(report.rejected).toBe(1);
      expect(report.settled).toBe(0);
      expect(report.failures).toEqual([]);
      expect(journalKeys()).toEqual(before);
      const runs = await bank.transfers.executions(schedule.id, 50);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ status: 'rejected', rejectionCode: 'bank.recipient_cannot_receive' });
      expect(await available(RECIPIENT)).toBe('0');
    });

    it('identity down at run time does NOT consume the occurrence; it settles when identity is back', async () => {
      const schedule = await order();
      identity.failWith(new RecipientStateUnavailableError('down'));
      const now = new Date('2026-01-01T10:00:00Z');

      const down = await bank.transfers.runDueTransfers({ now, limit: 200 });
      expect(down.settled).toBe(0);
      expect(down.failures).toHaveLength(1);
      expect(await bank.transfers.executions(schedule.id, 50)).toHaveLength(0);

      identity.failWith(null);
      const up = await bank.transfers.runDueTransfers({ now, limit: 200 });
      expect(up.settled).toBe(1);
      expect(await available(RECIPIENT)).toBe('25');
    });
  });

  describe('business', () => {
    it('payroll to a frozen recipient is refused before posting', async () => {
      const account = await bank.business.createAccount({
        accountId: randomUUID(),
        name: 'Ops Co',
        assetId: 'USDT',
        spendThreshold: amt('500'),
        creatorUserId: MAKER,
      });
      const primary = await bank.spaces.ensurePrimary(MAKER, 'USDT');
      const alice = await bank.spaces.ensurePrimary(RECIPIENT, 'USDT');
      await fund(MAKER, '100');
      identity.set(RECIPIENT, 'frozen');
      const before = journalKeys();

      await expect(
        bank.business.runPayroll({
          payrollId: randomUUID(),
          accountId: account.id,
          actorUserId: MAKER,
          fromSpaceId: primary.id,
          recipients: [{ toSpaceId: alice.id, amount: amt('10') }],
        }),
      ).rejects.toMatchObject(REFUSAL);
      expect(journalKeys()).toEqual(before);
    });

    it('a business transfer to a closed recipient is refused before posting or claiming', async () => {
      const account = await bank.business.createAccount({
        accountId: randomUUID(),
        name: 'Ops Co',
        assetId: 'USDT',
        spendThreshold: amt('500'),
        creatorUserId: MAKER,
      });
      const primary = await bank.spaces.ensurePrimary(MAKER, 'USDT');
      const vendor = await bank.spaces.ensurePrimary(RECIPIENT, 'USDT');
      await fund(MAKER, '100');
      identity.set(RECIPIENT, 'closed');
      const before = journalKeys();

      await expect(
        bank.business.proposeTransfer({
          clientId: randomUUID(),
          accountId: account.id,
          makerUserId: MAKER,
          fromSpaceId: primary.id,
          toSpaceId: vendor.id,
          amount: amt('10'),
        }),
      ).rejects.toMatchObject(REFUSAL);
      expect(journalKeys()).toEqual(before);
      expect(await sql`SELECT id FROM bank.business_approvals`).toHaveLength(0);
    });

    async function pendingToRecipient(bankUnderTest: BankServices = bank) {
      const account = await bankUnderTest.business.createAccount({
        accountId: randomUUID(),
        name: 'Ops Co',
        assetId: 'USDT',
        spendThreshold: amt('100'),
        creatorUserId: MAKER,
      });
      await bankUnderTest.business.addMember({ accountId: account.id, actorUserId: MAKER, userId: CHECKER, role: 'checker' });
      const primary = await bankUnderTest.spaces.ensurePrimary(MAKER, 'USDT');
      const vendor = await bankUnderTest.spaces.ensurePrimary(RECIPIENT, 'USDT');
      await fund(MAKER, '1000');
      const proposed = await bankUnderTest.business.proposeTransfer({
        clientId: randomUUID(),
        accountId: account.id,
        makerUserId: MAKER,
        fromSpaceId: primary.id,
        toSpaceId: vendor.id,
        amount: amt('250'),
      });
      if (proposed.kind !== 'pending') throw new Error('expected pending');
      expect(await available(MAKER)).toBe('750');
      return proposed.approval;
    }

    it('approve to a recipient frozen after the proposal is refused, leaves the row PENDING, and the hold can still be released', async () => {
      const approval = await pendingToRecipient();
      identity.set(RECIPIENT, 'frozen');

      await expect(bank.business.approve({ approvalId: approval.id, checkerUserId: CHECKER })).rejects.toMatchObject(REFUSAL);
      const [row] = await sql<Array<{ status: string }>>`SELECT status FROM bank.business_approvals WHERE id = ${approval.id}::uuid`;
      expect(row?.status).toBe('pending');
      expect(await available(RECIPIENT)).toBe('0');
      expect(journalKeys().filter((k) => k.startsWith('bank.business.settle:'))).toEqual([]);

      // The row can be closed, and the maker's money comes back.
      await bank.business.reject({ approvalId: approval.id, checkerUserId: CHECKER });
      expect(await available(MAKER)).toBe('1000');
    });

    it('the maker can also cancel a refused settlement and gets the hold back', async () => {
      const approval = await pendingToRecipient();
      identity.set(RECIPIENT, 'closed');
      await expect(bank.business.approve({ approvalId: approval.id, checkerUserId: CHECKER })).rejects.toMatchObject(REFUSAL);

      await bank.business.cancel({ approvalId: approval.id, actorUserId: MAKER });
      expect(await available(MAKER)).toBe('1000');
      expect(await available(RECIPIENT)).toBe('0');
    });

    it('a recipient frozen between the pre-claim check and the settle: row closed as rejected, hold released, never stuck', async () => {
      let asks = 0;
      const flaky = {
        // 1 = propose, 2 = approve pre-claim check, 3 = the settle after the claim.
        async statusOf() {
          asks += 1;
          return asks >= 3 ? ('frozen' as const) : ('active' as const);
        },
      };
      const racing = createBankServices(sql, ledger, memoryLedgerHistory(ledger), { nativeAssetId: 'IFC', recipients: flaky });
      const approval = await pendingToRecipient(racing);

      await expect(racing.business.approve({ approvalId: approval.id, checkerUserId: CHECKER })).rejects.toMatchObject(REFUSAL);

      const [row] = await sql<Array<{ status: string; rejection_code: string | null }>>`
        SELECT status, rejection_code FROM bank.business_approvals WHERE id = ${approval.id}::uuid
      `;
      expect(row).toMatchObject({ status: 'rejected', rejection_code: 'bank.recipient_cannot_receive' });
      expect(await available(MAKER)).toBe('1000');
      expect(await available(RECIPIENT)).toBe('0');
    });
  });
});

describe('router: a stranger learns nothing about the recipient', () => {
  const principal = (): Principal =>
    ({
      sub: SENDER,
      userId: SENDER,
      sid: '44444444-4444-4444-8444-444444444444',
      scopes: ['bank:read', 'bank:write'],
      tier: 'full',
      mfa: true,
      expiresAt: new Date(Date.now() + 60_000),
    }) as Principal;

  function headers(): Record<string, string> {
    const raw = encodePrincipal(principal());
    return {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
      'content-type': 'application/json',
    };
  }

  async function mount(bank: BankServices): Promise<FastifyInstance> {
    const app = Fastify({ logger: false });
    await app.register(fastifyTRPCPlugin, {
      prefix: '/trpc',
      trpcOptions: {
        router: createBankRouter(bank),
        createContext: ({ req }) => edgeContext(req),
      } satisfies FastifyTRPCPluginOptions<BankRouter>['trpcOptions'],
    });
    await app.ready();
    return app;
  }

  it('transfers.create to a frozen stranger answers exactly like a space that does not exist', async () => {
    await sql`TRUNCATE bank.spaces RESTART IDENTITY CASCADE`;
    const ledger = new MemoryLedger();
    const identity = memoryRecipientState({ [RECIPIENT]: 'frozen' });
    const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), { recipients: identity });
    const from = await bank.spaces.ensurePrimary(SENDER, 'USDT');
    const to = await bank.spaces.ensurePrimary(RECIPIENT, 'USDT');
    await ledger.post(recipes.deposit({ userId: SENDER, assetId: 'USDT', amount: amt('50'), rail: 'test', railRef: 'router-fund-1' }));
    const app = await mount(bank);
    try {
      const call = async (toSpaceId: string, transferId: string) => {
        const res = await app.inject({
          method: 'POST',
          url: '/trpc/transfers.create',
          headers: headers(),
          payload: { transferId, fromSpaceId: from.id, toSpaceId, amount: '5' },
        });
        return { status: res.statusCode, error: (res.json() as { error?: { message?: string } }).error?.message };
      };
      const frozen = await call(to.id, 'router-frozen-1');
      const missing = await call(randomUUID(), 'router-missing-1');
      expect(frozen).toEqual(missing);
      expect(frozen.error).toBe('No such space');
      expect(ledger.journal().filter((tx) => tx.idempotencyKey.startsWith('bank.transfer'))).toHaveLength(0);
    } finally {
      await app.close();
    }
  });
});

describe('createIdentityRecipientState (identity /internal/account/:userId)', () => {
  const USER = RECIPIENT;
  const body = (status: string, userId = USER) => ({ userId, status, kycTier: 'none' });
  const reply = (status: number, json?: unknown): Response =>
    new Response(json === undefined ? null : JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } });
  const port = (fetchFn: typeof fetch) => createIdentityRecipientState('http://identity.test/', SECRET, fetchFn, () => undefined);

  it('reads active, frozen and closed from the status field', async () => {
    for (const status of ['active', 'frozen', 'closed'] as const) {
      expect(await port(async () => reply(200, body(status))).statusOf(USER)).toBe(status);
    }
  });

  it('sends a service-authenticated GET to identity for that user only', async () => {
    let seen: { url: string; method?: string; headers?: unknown } | null = null;
    await port(async (url, init) => {
      seen = { url: String(url), method: init?.method, headers: init?.headers };
      return reply(200, body('active'));
    }).statusOf(USER);
    expect(seen).not.toBeNull();
    expect(seen!.url).toBe(`http://identity.test/internal/account/${USER}`);
    expect(seen!.method).toBe('GET');
    expect(Object.keys((seen!.headers ?? {}) as Record<string, string>).length).toBeGreaterThan(0);
  });

  it('404 means identity does not know them: not_found, which bank refuses like frozen', async () => {
    expect(await port(async () => reply(404, { code: 'identity.account_not_found' })).statusOf(USER)).toBe('not_found');
  });

  it('logs WHY a check failed (server log only), and the error a caller sees carries no such detail', async () => {
    const logged: Array<{ userId: string; reason: string; httpStatus?: number }> = [];
    const log = (d: { userId: string; reason: string; httpStatus?: number }) => void logged.push(d);
    const withLog = (fetchFn: typeof fetch) => createIdentityRecipientState('http://identity.test', SECRET, fetchFn, log);

    await expect(withLog(async () => reply(401, { code: 'identity.unauthenticated' })).statusOf(USER)).rejects.toThrow();
    await expect(
      withLog(async () => {
        throw new TypeError('connect ECONNREFUSED');
      }).statusOf(USER),
    ).rejects.toThrow();
    await expect(withLog(async () => new Response('nope', { status: 200 })).statusOf(USER)).rejects.toThrow();
    await expect(withLog(async () => reply(200, { userId: USER })).statusOf(USER)).rejects.toThrow();

    expect(logged).toHaveLength(4);
    expect(logged[0]).toMatchObject({ userId: USER, httpStatus: 401, reason: 'identity answered non-2xx' });
    expect(logged[1]?.reason).toMatch(/request failed/);
    expect(logged[2]?.reason).toMatch(/not JSON/);
    expect(logged[3]?.reason).toMatch(/schema/);

    // Through the service: the client-facing error never mentions the status or the cause.
    const spaces = createBankServices(sql, new MemoryLedger(), memoryLedgerHistory(new MemoryLedger()), {
      recipients: withLog(async () => reply(401, {})),
    }).spaces;
    const seen = await spaces.assertCanReceive(USER).then(
      () => null,
      (e: unknown) => e as { code: string; message: string },
    );
    expect(seen?.code).toBe('bank.recipient_check_unavailable');
    expect(seen?.message).not.toMatch(/401|identity|secret/i);
  });

  it('outage, non-2xx, bad body and a body about someone else are all "unavailable", never active', async () => {
    const cases: Array<typeof fetch> = [
      async () => {
        throw new TypeError('connect ECONNREFUSED');
      },
      async () => reply(500, { error: 'boom' }),
      async () => reply(401, { code: 'identity.unauthenticated' }),
      async () => reply(403, {}),
      async () => new Response('not json', { status: 200 }),
      async () => reply(200, { userId: USER }),
      async () => reply(200, body('active', '99999999-9999-4999-8999-999999999999')),
      async () => reply(200, body('suspended')),
    ];
    for (const fetchFn of cases) {
      await expect(port(fetchFn).statusOf(USER)).rejects.toBeInstanceOf(RecipientStateUnavailableError);
    }
  });

  it('the unconfigured port always refuses as unset', async () => {
    await expect(unconfiguredRecipientState().statusOf(USER)).rejects.toMatchObject({ reason: 'unset' });
  });
});
