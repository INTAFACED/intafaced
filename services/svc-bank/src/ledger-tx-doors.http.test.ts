/**
 * #4694: svc-bank's HTTP ledger client used to throw on `getTx` and
 * `getTxByKey`, while the in-memory ledger every suite hands the services
 * implements both. So business transfers and card cashback worked in tests and
 * failed on a real deployment.
 *
 * Here the real services run on the real `createLedgerClient`, signing every
 * request, against a fake svc-ledger door over the reference ledger. Nothing
 * here touches the in-memory ledger directly except to seed it and to read the
 * book back.
 *
 * Call sites covered:
 *  - business `proposeTransfer`: getTxByKey (business-service.ts:301, :324) and,
 *    for an immediate transfer, getTx on the receipt (:803)
 *  - business approve of a held proposal (finishSettle, :896 on a lost acknowledgement)
 *  - card cashback settle (card-service.ts:1100)
 *
 * Receipts over HTTP carry no entries (`post` ack and `txByKey`), but
 * `postedPayrollMatches` reads them, so the business service re-reads the
 * transaction by id first (`withEntries`). The last describe covers that.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger, formatAmount, parseAmount as amt, recipes, rewardsEngine, userAvailable } from '@intafaced/ledger-client';
import { createBankServices, memoryRecipientState } from './bank-service.js';
import { memoryLedgerHistory } from './analytics/ledger-history.js';
import { CardService } from './cards/card-service.js';
import { cardProgrammeOutput, cardSim, type CardIssuerAdapter } from './cards/issuer.js';
import { createLedgerClient } from './ledger-client.js';
import { fakeLedgerDoor, type DoorCall } from './ledger-door-fake.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const SECRET = 'svc-bank-test-internal-secret-0123456789';
const MAKER = '11111111-1111-4111-8111-111111111111';
const CHECKER = '22222222-2222-4222-8222-222222222222';
const FEE_PAYER = '99999999-9999-4999-8999-999999999999';

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  try {
    const container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('intafaced_h8a_test')
      .withUsername('intafaced')
      .withPassword('intafaced')
      .start();
    return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
  } catch (err) {
    throw new Error(`TEST_DATABASE_URL unset and Testcontainers could not start postgres:16-alpine: ${(err as Error).message}`);
  }
}

describe('svc-bank over the HTTP ledger client (#4694)', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let ledger: MemoryLedger;
  let calls: DoorCall[];
  const realFetch = globalThis.fetch;

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'bank', url: admin.url, migrations });
    sql = db.sql;
  }, 120_000);

  beforeEach(async () => {
    await sql`
      TRUNCATE bank.business_payroll_lines, bank.business_payroll_runs,
               bank.business_approvals, bank.business_members, bank.business_accounts,
               bank.transfer_executions, bank.scheduled_transfers, bank.spaces,
               bank.card_cashback, bank.card_settlements, bank.card_conversions, bank.card_authorizations, bank.cards
      RESTART IDENTITY CASCADE
    `;
    ledger = new MemoryLedger();
    calls = [];
    globalThis.fetch = fakeLedgerDoor(ledger, SECRET, calls);
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  const http = () => createLedgerClient('http://ledger.test', SECRET);
  const asked = (path: string) => calls.filter((c) => c.path === path);

  async function fund(userId: string, assetId: string, value: string) {
    await ledger.post(
      recipes.deposit({ userId, assetId, amount: amt(value), rail: 'test', railRef: `${userId}:${assetId}:${randomUUID()}` }),
    );
  }
  const availableOf = async (userId: string, assetId: string) =>
    formatAmount((await ledger.balance(userAvailable(userId, assetId))).amount);

  function bankOverHttp() {
    return createBankServices(sql, http(), memoryLedgerHistory(ledger), { nativeAssetId: 'IFC', recipients: memoryRecipientState() });
  }

  describe('business transfers', () => {
    it('an immediate transfer posts: propose looks up both keys and reads the receipt back', async () => {
      const bank = bankOverHttp();
      const account = await bank.business.createAccount({
        name: 'Ops Co',
        assetId: 'USDT',
        spendThreshold: amt('500'),
        creatorUserId: MAKER,
      });
      const primary = await bank.spaces.ensurePrimary(MAKER, 'USDT');
      const pot = await bank.spaces.create({ userId: MAKER, assetId: 'USDT', name: 'Vendor' });
      await fund(MAKER, 'USDT', '200');
      const clientId = randomUUID();

      const result = await bank.business.proposeTransfer({
        clientId,
        accountId: account.id,
        makerUserId: MAKER,
        fromSpaceId: primary.id,
        toSpaceId: pot.id,
        amount: amt('100'),
      });

      expect(result.kind).toBe('posted');
      expect(await availableOf(MAKER, 'USDT')).toBe('100');
      expect(formatAmount(await bank.spaces.balanceOf(pot))).toBe('100');
      // :301/:324 asked both keys; :803 fetched the receipt by id, with its entries.
      const keys = asked('/trpc/txByKey').map((c) => c.body.idempotencyKey);
      expect(keys).toContain(`bank.transfer:${clientId}:0`);
      expect(keys).toContain(`bank.business.hold:${clientId}`);
      expect(asked('/trpc/txById').length).toBeGreaterThan(0);
      expect(calls.every((c) => c.service === 'svc-bank')).toBe(true);
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('an approved hold settles over the HTTP client (the proposal was held in-process)', async () => {
      // The hold is posted in-process here; the held proposal over HTTP is its own describe below.
      const direct = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
        nativeAssetId: 'IFC',
        recipients: memoryRecipientState(),
      });
      const bank = bankOverHttp();
      const account = await direct.business.createAccount({
        name: 'Ops Co',
        assetId: 'USDT',
        spendThreshold: amt('50'),
        creatorUserId: MAKER,
      });
      await direct.business.addMember({ accountId: account.id, actorUserId: MAKER, userId: CHECKER, role: 'checker' });
      const primary = await direct.spaces.ensurePrimary(MAKER, 'USDT');
      const pot = await direct.spaces.create({ userId: MAKER, assetId: 'USDT', name: 'Vendor' });
      await fund(MAKER, 'USDT', '1000');
      const clientId = randomUUID();
      const proposed = await direct.business.proposeTransfer({
        clientId,
        accountId: account.id,
        makerUserId: MAKER,
        fromSpaceId: primary.id,
        toSpaceId: pot.id,
        amount: amt('100'),
      });
      expect(proposed.kind).toBe('pending');
      expect(await availableOf(MAKER, 'USDT')).toBe('900');

      const settled = await bank.business.approve({ approvalId: clientId, checkerUserId: CHECKER });

      expect(settled.ledgerTxId).toBeTruthy();
      expect(formatAmount(await bank.spaces.balanceOf(pot))).toBe('100');
      expect(await availableOf(MAKER, 'USDT')).toBe('900');
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('an approval whose settle acknowledgement was lost recovers the booked transaction by key (finishSettle, :896)', async () => {
      // The hold is posted in-process here; the held proposal over HTTP is its own describe below.
      const direct = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
        nativeAssetId: 'IFC',
        recipients: memoryRecipientState(),
      });
      const bank = bankOverHttp();
      const account = await direct.business.createAccount({
        name: 'Ops Co',
        assetId: 'USDT',
        spendThreshold: amt('50'),
        creatorUserId: MAKER,
      });
      await direct.business.addMember({ accountId: account.id, actorUserId: MAKER, userId: CHECKER, role: 'checker' });
      const primary = await direct.spaces.ensurePrimary(MAKER, 'USDT');
      const pot = await direct.spaces.create({ userId: MAKER, assetId: 'USDT', name: 'Vendor' });
      await fund(MAKER, 'USDT', '1000');
      const clientId = randomUUID();
      const proposed = await direct.business.proposeTransfer({
        clientId,
        accountId: account.id,
        makerUserId: MAKER,
        fromSpaceId: primary.id,
        toSpaceId: pot.id,
        amount: amt('100'),
      });
      expect(proposed.kind).toBe('pending');
      expect(await availableOf(MAKER, 'USDT')).toBe('900');

      // The settle commits in svc-ledger, then its acknowledgement is lost on the wire.
      const door = globalThis.fetch;
      let dropped = false;
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const response = await door(input, init);
        if (!dropped && String(input).endsWith('/trpc/post') && String(init?.body).includes('bank.business.settle:')) {
          dropped = true;
          return new Response('bad gateway', { status: 502 });
        }
        return response;
      }) as typeof fetch;

      const settled = await bank.business.approve({ approvalId: clientId, checkerUserId: CHECKER });

      expect(dropped).toBe(true);
      expect(settled.ledgerTxId).toBeTruthy();
      expect(asked('/trpc/txByKey').map((c) => c.body.idempotencyKey)).toContain(`bank.business.settle:${clientId}`);
      expect(formatAmount(await bank.spaces.balanceOf(pot))).toBe('100');
      expect(await availableOf(MAKER, 'USDT')).toBe('900');
      expect(ledger.reconcile()).toEqual({ ok: true });
    });
  });

  describe('card cashback', () => {
    function connectedIssuer(): CardIssuerAdapter {
      const sim = cardSim();
      return {
        programme: cardProgrammeOutput({ id: 'outside-issuer', simulated: false, displayName: 'Connected card issuer' }),
        issue: (input) => sim.issue(input),
        respondToAuthorization: (input) => sim.respondToAuthorization(input),
        setStatus: (input) => sim.setStatus(input),
      };
    }

    it('a capture settles its cashback: the reward key is looked up before it is posted', async () => {
      await fund(MAKER, 'USDT', '500');
      await fund(FEE_PAYER, 'USDT', '10');
      await ledger.post(
        recipes.feeCharge({
          chargeId: `bank:${randomUUID()}`,
          userId: FEE_PAYER,
          module: 'bank',
          mode: 'asset',
          assetId: 'USDT',
          amount: amt('10'),
        }),
      );
      const seeding = new CardService(sql, ledger, { issuer: cardSim() });
      await seeding.fundCashbackPot({ windowId: `w:${randomUUID()}`, assetId: 'USDT', amount: amt('10') });
      const issued = await seeding.issue({
        cardId: randomUUID(),
        userId: MAKER,
        assetId: 'USDT',
        cashbackBps: 100,
        perAuthorizationLimit: amt('1000'),
      });
      // A preserved connected-issuer card is the only kind that pays cashback.
      await sql.begin(async (tx) => {
        await tx.unsafe(readFileSync(join(drizzle, '0024_card_simulated_true.down.sql'), 'utf8'));
        await tx`UPDATE bank.cards SET issuer = 'outside-issuer', simulated = false WHERE id = ${issued.id}`;
        await tx.unsafe(readFileSync(join(drizzle, '0024_card_simulated_true.sql'), 'utf8'));
      });

      const paying = new CardService(sql, http(), { issuer: connectedIssuer() });
      await paying.authorize({ cardId: issued.id, authorizationRef: 'auth-1', amount: amt('200') });
      const result = await paying.capture({ cardId: issued.id, authorizationRef: 'auth-1', amount: amt('200') });

      expect(result.cashback.status).toBe('paid');
      expect(formatAmount(result.cashback.amount)).toBe('2');
      expect(await availableOf(MAKER, 'USDT')).toBe('302');
      expect(formatAmount((await ledger.balance(rewardsEngine('USDT'))).amount)).toBe('8');
      expect(asked('/trpc/txByKey').some((c) => String(c.body.idempotencyKey).includes('bank.card.cashback:'))).toBe(true);
      expect(ledger.totalsByAsset().USDT).toBe('0');
    });
  });

  describe('held and legacy business proposals over HTTP (entry-less receipts)', () => {
    async function fixture() {
      const bank = bankOverHttp();
      const account = await bank.business.createAccount({
        name: 'Ops Co',
        assetId: 'USDT',
        spendThreshold: amt('50'),
        creatorUserId: MAKER,
      });
      await bank.business.addMember({ accountId: account.id, actorUserId: MAKER, userId: CHECKER, role: 'checker' });
      const primary = await bank.spaces.ensurePrimary(MAKER, 'USDT');
      const pot = await bank.spaces.create({ userId: MAKER, assetId: 'USDT', name: 'Vendor' });
      await fund(MAKER, 'USDT', '1000');
      const input = {
        clientId: randomUUID(),
        accountId: account.id,
        makerUserId: MAKER,
        fromSpaceId: primary.id,
        toSpaceId: pot.id,
        amount: amt('100'),
      };
      return { bank, account, primary, pot, input };
    }
    const holds = (clientId: string) => ledger.journal().filter((tx) => tx.idempotencyKey === `bank.business.hold:${clientId}`);

    it('an over-threshold proposal holds, a retry resumes it, and approve settles: no false conflict', async () => {
      const { bank, pot, input } = await fixture();

      const proposed = await bank.business.proposeTransfer(input);
      expect(proposed.kind).toBe('pending');
      expect(await availableOf(MAKER, 'USDT')).toBe('900');

      const retried = await bank.business.proposeTransfer(input);
      expect(retried.kind).toBe('pending');
      expect(holds(input.clientId)).toHaveLength(1);

      const settled = await bank.business.approve({ approvalId: input.clientId, checkerUserId: CHECKER });
      expect(settled.ledgerTxId).toBeTruthy();
      expect(formatAmount(await bank.spaces.balanceOf(pot))).toBe('100');
      expect(await availableOf(MAKER, 'USDT')).toBe('900');
      expect(asked('/trpc/txById').length).toBeGreaterThan(0);
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('a held proposal can still be cancelled, freeing the money', async () => {
      const { bank, input } = await fixture();
      await bank.business.proposeTransfer(input);
      await bank.business.cancel({ approvalId: input.clientId, actorUserId: MAKER });
      expect(await availableOf(MAKER, 'USDT')).toBe('1000');
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('legacy recovery: a hold booked before any approval row is recovered once, and changed terms still conflict', async () => {
      const { bank, input } = await fixture();
      const original = await ledger.post(
        recipes.businessApprovalHold({ approvalId: input.clientId, from: userAvailable(MAKER, 'USDT'), amount: input.amount }),
      );

      // A real mismatch is still a conflict, decided on the entries read back by id.
      await expect(bank.business.proposeTransfer({ ...input, amount: amt('20') })).rejects.toMatchObject({
        code: 'bank.business_request_conflict',
      });
      expect(await sql`SELECT id FROM bank.business_approvals WHERE id = ${input.clientId}`).toHaveLength(0);

      const recovered = await bank.business.proposeTransfer(input);
      expect(recovered.kind).toBe('pending');
      if (recovered.kind !== 'pending') throw new Error('expected pending');
      expect(recovered.approval.holdLedgerTxId).toBe(original.id);
      expect(holds(input.clientId)).toHaveLength(1);
      expect(await availableOf(MAKER, 'USDT')).toBe('900');
    });

    it('legacy recovery: an immediate transfer booked before any approval row is recovered, and changed terms still conflict', async () => {
      const { bank, primary, pot, input } = await fixture();
      const small = { ...input, amount: amt('10') };
      const original = await bank.transfers.transfer({
        transferId: small.clientId,
        fromSpaceId: primary.id,
        toSpaceId: pot.id,
        amount: small.amount,
      });

      await expect(bank.business.proposeTransfer({ ...small, amount: amt('20') })).rejects.toMatchObject({
        code: 'bank.business_request_conflict',
      });
      expect(await bank.business.proposeTransfer(small)).toEqual({
        kind: 'posted',
        transferId: small.clientId,
        ledgerTxId: original.ledgerTxId,
      });
      expect(ledger.journal().filter((tx) => tx.idempotencyKey === `bank.transfer:${small.clientId}:0`)).toHaveLength(1);
    });

    it('a receipt the ledger cannot show is unavailable, never a conflict', async () => {
      const { bank, input } = await fixture();
      const door = globalThis.fetch;
      globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) =>
        String(url).endsWith('/trpc/txById')
          ? new Response(JSON.stringify({ found: false }), { status: 200 })
          : door(url, init)) as typeof fetch;
      await expect(bank.business.proposeTransfer(input)).rejects.toMatchObject({ code: 'ledger.unavailable' });
    });
  });
});
