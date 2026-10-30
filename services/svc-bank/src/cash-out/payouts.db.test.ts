/**
 * Cash out that pays out (BK-xfer-08, BK-xfer-09, J-bank-03 #4/#5), with the TEST payout stand-in as the partner: the
 * partner verifies the account, the amount is held once at confirm, the partner's paid, failed and returned answers move
 * it once each, and a paid cash-out has a signed receipt. Funds are TEST deposits on a MemoryLedger. Uses
 * TEST_DATABASE_URL. Does not start Docker.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import {
  MemoryLedger,
  formatAmount,
  parseAmount,
  railBoundary,
  recipes,
  userAvailable,
  withdrawalHoldAccount,
} from '@intafaced/ledger-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { memoryLedgerHistory } from '../analytics/ledger-history.js';
import { createBankServices } from '../bank-service.js';
import { BankError } from '../errors.js';
import { LinkedAccountService } from '../linked-accounts/linked-accounts.js';
import { createBankRouter } from '../router.js';
import type { SecurityLockPort } from '../security-lock.js';
import { CashOutService, cashOutWithdrawalId } from './cash-out.js';
import { PAYOUT_SIM_RAIL, payoutSim, type CashOutPartner } from './payout-sim.js';

const SECRET = 'bank-cash-out-payout-edge-secret-long-enough';
const RECEIPTS = 'bank-cash-out-receipt-secret-long-enough';
const ADA = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const GB = 'GB82WEST12345698765432';
const SIM = payoutSim({
  label: 'TEST payout stand-in',
  payouts: [{ asset: 'USDT', currency: 'EUR', rate: '0.9', fee: '1.5' }],
});

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
  .sort()
  .map((file) => readFileSync(join(drizzle, file), 'utf8'));

const OPEN: SecurityLockPort = { read: async () => ({ locked: false, unlocksAt: null, selfFrozen: false }) };
const LOCKED: SecurityLockPort = { read: async () => ({ locked: true, unlocksAt: null, selfFrozen: false }) };
const SELF_FROZEN: SecurityLockPort = { read: async () => ({ locked: false, unlocksAt: null, selfFrozen: true }) };

const codeOf = (err: unknown) => (err instanceof BankError ? err.code : (err as { cause?: { code?: string } }).cause?.code);

describe('cash out that pays out, with the TEST payout stand-in (J-bank-03 #4/#5)', () => {
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let ledger: MemoryLedger;
  const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-bank' });

  beforeAll(async () => {
    const raw = process.env.TEST_DATABASE_URL?.trim();
    if (!raw) throw new Error('TEST_DATABASE_URL is unset. This suite does not start Docker.');
    const url = new URL(raw);
    if (!url.pathname.replace(/^\//, '').endsWith('_test')) url.pathname = '/intafaced_test';
    db = await createTestDatabase({ service: 'bank', url: url.toString(), migrations });
    sql = db.sql;
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
  });

  beforeEach(async () => {
    await sql`TRUNCATE bank.cash_out_requests, bank.linked_bank_accounts`;
    ledger = new MemoryLedger();
    await ledger.post(
      recipes.deposit({ userId: ADA, assetId: 'USDT', amount: parseAmount('50'), rail: 'test', railRef: 'cash-out-fund-ada' }),
    );
  });

  function services(partner: CashOutPartner | null = SIM, securityLock = OPEN) {
    return createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      ramps: { addressBookCap: '10', offrampCoolingHours: '24', securityLock },
      cashOutPartner: partner,
      receiptSecret: RECEIPTS,
    });
  }

  function as(userId: string, partner: CashOutPartner | null = SIM, securityLock = OPEN) {
    const raw = encodePrincipal({
      sub: userId,
      userId,
      sid: randomUUID(),
      scopes: ['bank:read', 'bank:write', 'trade:withdraw'],
      tier: 'full',
      mfa: true,
      expiresAt: new Date(Date.now() + 60_000),
    } as Principal);
    return createBankRouter(services(partner, securityLock)).createCaller(
      edgeContext({
        headers: {
          'x-intafaced-principal': raw,
          'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
          'x-intafaced-region': 'DE',
        },
        id: `req-${randomUUID()}`,
      }),
    );
  }

  const refused = async (call: Promise<unknown>) => {
    try {
      await call;
    } catch (err) {
      return codeOf(err);
    }
    throw new Error('expected a refusal');
  };
  const available = async (userId = ADA) => (await ledger.balance(userAvailable(userId, 'USDT'))).amount;
  const held = async (id: string) => (await ledger.balance(withdrawalHoldAccount(ADA, 'USDT', cashOutWithdrawalId(id)))).amount;
  /** A linked account the partner verified, linked `hoursAgo` hours ago (past the 24-hour cooling-off by default). */
  const usable = async (userId = ADA, hoursAgo = 25) => {
    const { accountId } = (await as(userId).linkedAccounts.link({ label: 'TEST salary account', holderName: 'TEST Holder', iban: GB }))
      .account;
    await services().cashOut.verifyAccount(accountId);
    await sql`UPDATE bank.linked_bank_accounts SET created_at = now() - make_interval(hours => ${hoursAgo}) WHERE id = ${accountId}::uuid`;
    return accountId;
  };
  const start = async (accountId: string, amount = '20', requestId = randomUUID()) =>
    as(ADA).cashOut.start({ requestId, assetId: 'USDT', amount, linkedAccountId: accountId });

  describe('the partner verifies the account', () => {
    it('only through the partner: with none it refuses rail.bank and the account stays unverified', async () => {
      const { accountId } = (await as(ADA).linkedAccounts.link({ label: 'TEST', holderName: 'TEST Holder', iban: GB })).account;
      expect(await refused(services(null).cashOut.verifyAccount(accountId))).toBe('rail.bank');
      expect((await as(ADA).linkedAccounts.list()).accounts[0]).toMatchObject({ state: 'unverified' });
      const verified = await services().cashOut.verifyAccount(accountId);
      expect(verified).toMatchObject({ state: 'verified', verificationRail: null, blocker: 'bank.offramp_cooling_active' });
      // Again is the same answer; an account that is not linked (removed, or none) is not found.
      expect((await services().cashOut.verifyAccount(accountId)).state).toBe('verified');
      expect(await refused(services().cashOut.verifyAccount(randomUUID()))).toBe('bank.linked_account_not_found');
      await as(ADA).linkedAccounts.remove({ accountId });
      expect(await refused(services().cashOut.verifyAccount(accountId))).toBe('bank.linked_account_not_found');
    });
  });

  describe('the quote', () => {
    it("a usable account shows the partner's fee and what arrives, with its TEST label; an unverified one shows neither", async () => {
      const id = await usable();
      expect(await as(ADA).cashOut.quote({ assetId: 'USDT', amount: '20', linkedAccountId: id })).toMatchObject({
        available: '50',
        fee: '1.5',
        receiveAmount: '16.5',
        receiveCurrency: 'EUR',
        blocker: null,
        standIn: 'TEST payout stand-in',
      });
      await sql`UPDATE bank.linked_bank_accounts SET created_at = now() WHERE id = ${id}::uuid`;
      expect(await as(ADA).cashOut.quote({ assetId: 'USDT', amount: '20', linkedAccountId: id })).toMatchObject({
        fee: null,
        receiveAmount: null,
        blocker: 'bank.offramp_cooling_active',
        standIn: null,
      });
      // An amount the fee eats is not priced, so the partner is what stands in the way.
      await sql`UPDATE bank.linked_bank_accounts SET created_at = now() - interval '25 hours' WHERE id = ${id}::uuid`;
      expect((await as(ADA).cashOut.quote({ assetId: 'USDT', amount: '1', linkedAccountId: id })).blocker).toBe('bank.fiat_ramp_socket');
      expect(ledger.journal()).toHaveLength(1);
    });
  });

  describe('confirming', () => {
    it('holds the amount once under the request, hands it to the partner, and the same id posts nothing twice', async () => {
      const id = await usable();
      const requestId = randomUUID();
      const first = await start(id, '20', requestId);
      expect(first).toMatchObject({
        requestId,
        status: 'processing',
        refusalCode: null,
        fee: '1.5',
        receiveAmount: '16.5',
        receiveCurrency: 'EUR',
        payoutRef: `TEST-PAYOUT-${requestId}`,
        ledgerTxId: null,
      });
      expect(await available()).toBe(parseAmount('30'));
      expect(await held(requestId)).toBe(parseAmount('20'));
      const posts = ledger.journal().length;
      expect(await start(id, '20.0', requestId)).toEqual(first);
      expect(ledger.journal()).toHaveLength(posts);
      expect(await as(ADA).cashOut.requests({ limit: 10 })).toEqual([first]);
    });

    it('a balance that moved after the quote keeps the request refused with nothing held', async () => {
      const id = await usable();
      const linked = new LinkedAccountService(sql, { addressBookCap: () => '10', offrampCoolingHours: () => '24' });
      // The available read says 50, but the ledger holds only 50 and the ask is 60: the hold is what refuses.
      const cashOut = new CashOutService(
        sql,
        ledger,
        { available: async () => parseAmount('100'), linked },
        { partner: SIM, securityLock: OPEN },
      );
      const kept = await cashOut.start(ADA, { requestId: randomUUID(), assetId: 'USDT', amount: '60', linkedAccountId: id });
      expect(kept).toMatchObject({ status: 'refused', refusalCode: 'bank.cash_out_over_available', payoutRef: null });
      expect(await available()).toBe(parseAmount('50'));
      expect(ledger.journal()).toHaveLength(1);
    });

    it("while the owner's security lock holds, no cash-out starts: nothing kept, nothing held", async () => {
      const id = await usable();
      const requestId = randomUUID();
      expect(await refused(as(ADA, SIM, LOCKED).cashOut.start({ requestId, assetId: 'USDT', amount: '20', linkedAccountId: id }))).toBe(
        'bank.security_locked',
      );
      expect(await as(ADA).cashOut.requests({ limit: 10 })).toEqual([]);
      expect(ledger.journal()).toHaveLength(1);
    });

    it('with no partner a usable account is still kept refused on the missing partner, with nothing held', async () => {
      const id = await usable();
      const kept = await as(ADA, null).cashOut.start({ requestId: randomUUID(), assetId: 'USDT', amount: '5', linkedAccountId: id });
      expect(kept).toMatchObject({ status: 'refused', refusalCode: 'bank.fiat_ramp_socket' });
      expect(ledger.journal()).toHaveLength(1);
    });

    it('a request left before its hold or the partner is driven on by the re-drive job, once', async () => {
      const id = await usable();
      const requestId = randomUUID();
      // As if the process stopped right after writing the request.
      await sql`
        INSERT INTO bank.cash_out_requests (id, user_id, asset_id, amount, linked_account_id, status, payout_rail, created_at)
        VALUES (${requestId}::uuid, ${ADA}, 'USDT', 20, ${id}::uuid, 'processing', ${PAYOUT_SIM_RAIL}, now() - interval '5 minutes')
      `;
      const cashOut = services().cashOut;
      expect(await cashOut.redrive(10)).toEqual([{ id: requestId, outcome: 'completed' }]);
      expect(await cashOut.redrive(10)).toEqual([]);
      expect(await held(requestId)).toBe(parseAmount('20'));
      expect((await as(ADA).cashOut.requests({ limit: 1 }))[0]).toMatchObject({
        status: 'processing',
        payoutRef: `TEST-PAYOUT-${requestId}`,
      });
    });
  });

  describe('if it crashes partway', () => {
    /** A request written `processing` five minutes ago, as if the process stopped right after; `held` posts its hold too. */
    const left = async (accountId: string, booked: boolean) => {
      const requestId = randomUUID();
      await sql`
        INSERT INTO bank.cash_out_requests (id, user_id, asset_id, amount, linked_account_id, status, payout_rail, created_at)
        VALUES (${requestId}::uuid, ${ADA}, 'USDT', 20, ${accountId}::uuid, 'processing', ${PAYOUT_SIM_RAIL}, now() - interval '5 minutes')
      `;
      if (booked) {
        await ledger.post(
          recipes.withdrawHold({
            userId: ADA,
            assetId: 'USDT',
            amount: parseAmount('20'),
            rail: PAYOUT_SIM_RAIL,
            withdrawalId: cashOutWithdrawalId(requestId),
          }),
        );
      }
      return requestId;
    };

    it('a hold the ledger booked but the request never recorded is stamped, never posted twice', async () => {
      const requestId = await left(await usable(), true);
      const posts = ledger.journal().length;
      expect(await services().cashOut.redrive(10)).toEqual([{ id: requestId, outcome: 'completed' }]);
      expect(ledger.journal()).toHaveLength(posts);
      expect(await held(requestId)).toBe(parseAmount('20'));
      expect(await available()).toBe(parseAmount('30'));
    });

    it("while the owner's self-freeze is open the re-drive holds nothing new and pays nothing; lifted, it carries on", async () => {
      const id = await usable();
      const unheld = await left(id, false);
      const posts = ledger.journal().length;
      expect(await services(SIM, SELF_FROZEN).cashOut.redrive(10)).toEqual([
        { id: unheld, outcome: 'failed', reason: 'bank.account_frozen_self' },
      ]);
      expect(ledger.journal()).toHaveLength(posts);
      expect(await held(unheld)).toBe(0n);
      expect(await available()).toBe(parseAmount('50'));
      expect((await as(ADA).cashOut.requests({ limit: 1 }))[0]).toMatchObject({ status: 'processing', payoutRef: null });
      expect(await services().cashOut.redrive(10)).toEqual([{ id: unheld, outcome: 'completed' }]);
      expect(await held(unheld)).toBe(parseAmount('20'));
    });

    it('a hold booked before the self-freeze is stamped and stays held, and the partner is not asked to pay', async () => {
      const requestId = await left(await usable(), true);
      const posts = ledger.journal().length;
      expect(await services(SIM, SELF_FROZEN).cashOut.redrive(10)).toEqual([
        { id: requestId, outcome: 'failed', reason: 'bank.account_frozen_self' },
      ]);
      expect(ledger.journal()).toHaveLength(posts);
      expect(await held(requestId)).toBe(parseAmount('20'));
      expect((await as(ADA).cashOut.requests({ limit: 1 }))[0]).toMatchObject({ status: 'processing', payoutRef: null });
    });

    it('a failed payout gives back a hold the ledger booked but the request never recorded', async () => {
      const requestId = await left(await usable(), true);
      expect(await services().cashOut.fail(requestId, 'bank.payout_rejected')).toMatchObject({ status: 'failed' });
      expect(await held(requestId)).toBe(0n);
      expect(await available()).toBe(parseAmount('50'));
    });

    it('with nothing held and no partner here, nothing is held and it stays processing for a hold that may yet land', async () => {
      const requestId = await left(await usable(), false);
      expect(await services(null).cashOut.redrive(10)).toEqual([
        { id: requestId, outcome: 'failed', reason: 'bank.cash_out_partner_gone' },
      ]);
      expect((await as(ADA).cashOut.requests({ limit: 1 }))[0]).toMatchObject({ status: 'processing', payoutRef: null });
      expect(await held(requestId)).toBe(0n);
      expect(await available()).toBe(parseAmount('50'));
      // The hold lands late: the next drive with the partner back finds it and posts none again.
      await ledger.post(
        recipes.withdrawHold({
          userId: ADA,
          assetId: 'USDT',
          amount: parseAmount('20'),
          rail: PAYOUT_SIM_RAIL,
          withdrawalId: cashOutWithdrawalId(requestId),
        }),
      );
      const posts = ledger.journal().length;
      expect(await services().cashOut.redrive(10)).toEqual([{ id: requestId, outcome: 'completed' }]);
      expect(ledger.journal()).toHaveLength(posts);
      expect(await held(requestId)).toBe(parseAmount('20'));
    });
  });

  describe("the partner's answers", () => {
    it('paid: the hold settles to the payout rail once, and the receipt is signed and names the ledger transaction', async () => {
      const id = await usable();
      const { requestId } = await start(id);
      expect(await refused(as(ADA).cashOut.receipt({ requestId }))).toBe('bank.cash_out_receipt_not_ready');
      const cashOut = services().cashOut;
      const paid = await cashOut.complete(requestId);
      expect(paid).toMatchObject({ status: 'completed', ledgerTxId: expect.any(String) });
      expect(await cashOut.complete(requestId)).toEqual(paid);
      expect(await held(requestId)).toBe(0n);
      expect(await available()).toBe(parseAmount('30'));
      expect((await ledger.balance(railBoundary(PAYOUT_SIM_RAIL, 'USDT'))).amount).not.toBe(0n);
      // Nothing else can close it now.
      expect(await refused(cashOut.fail(requestId, 'bank.payout_rejected'))).toBe('bank.ramp_conflict');

      const receipt = await as(ADA).cashOut.receipt({ requestId });
      expect(receipt.fileName).toBe(`receipt-${requestId}.txt`);
      expect(receipt.ledgerTxId).toBe(paid.ledgerTxId);
      expect(receipt.text).toContain(`Ledger transaction: ${paid.ledgerTxId}`);
      expect(receipt.text).toContain('Sent: 20 USDT');
      expect(receipt.text).toContain('Arrives: 16.5 EUR');
      expect(receipt.text).toContain('To: TEST Holder · GB82 •••• 5432');
      expect(receipt.sha256).toBe(createHash('sha256').update(receipt.text).digest('hex'));
      expect(receipt.signature).toMatch(/^[0-9a-f]{64}$/);
      expect(await as(ADA).cashOut.receipt({ requestId })).toEqual(receipt);
      expect(await refused(as(BOB).cashOut.receipt({ requestId }))).toBe('bank.cash_out_not_found');
    });

    it('failed: the hold comes back once with the reason, and the cash-out has no receipt', async () => {
      const id = await usable();
      const { requestId } = await start(id, '10');
      const cashOut = services().cashOut;
      const failed = await cashOut.fail(requestId, 'bank.payout_account_closed');
      expect(failed).toMatchObject({ status: 'failed', failureCode: 'bank.payout_account_closed', ledgerTxId: null });
      expect(await available()).toBe(parseAmount('50'));
      const posts = ledger.journal().length;
      expect(await cashOut.fail(requestId, 'bank.payout_account_closed')).toEqual(failed);
      expect(ledger.journal()).toHaveLength(posts);
      expect(await refused(cashOut.fail(requestId, 'bank.payout_rejected'))).toBe('bank.ramp_conflict');
      expect(await refused(cashOut.complete(requestId))).toBe('bank.ramp_conflict');
      expect(await refused(as(ADA).cashOut.receipt({ requestId }))).toBe('bank.cash_out_receipt_not_ready');
      expect(await available()).toBe(parseAmount('50'));
    });

    it('returned in part: what came back is credited once, the rest stays paid out, and the receipt still stands', async () => {
      const id = await usable();
      const { requestId } = await start(id);
      const cashOut = services().cashOut;
      expect(await refused(cashOut.returned(requestId, { amount: '5', assetId: 'USDT', reason: 'bank.payout_returned_by_bank' }))).toBe(
        'bank.ramp_conflict',
      );
      await cashOut.complete(requestId);
      expect(await refused(cashOut.returned(requestId, { amount: '20.1', assetId: 'USDT', reason: 'bank.payout_returned_by_bank' }))).toBe(
        'bank.ramp_invalid_amount',
      );
      const back = await cashOut.returned(requestId, { amount: '5', assetId: 'USDT', reason: 'bank.payout_returned_by_bank' });
      expect(back).toMatchObject({
        status: 'returned',
        returnedAmount: '5',
        remainsPaidOut: '15',
        failureCode: 'bank.payout_returned_by_bank',
      });
      expect(await available()).toBe(parseAmount('35'));
      const posts = ledger.journal().length;
      expect(await cashOut.returned(requestId, { amount: '5.0', assetId: 'USDT', reason: 'bank.payout_returned_by_bank' })).toEqual(back);
      expect(await refused(cashOut.returned(requestId, { amount: '6', assetId: 'USDT', reason: 'bank.payout_returned_by_bank' }))).toBe(
        'bank.ramp_conflict',
      );
      expect(ledger.journal()).toHaveLength(posts);
      expect(await available()).toBe(parseAmount('35'));
      const receipt = (await as(ADA).cashOut.receipt({ requestId })).text;
      expect(receipt).toContain('Status: returned');
      expect(receipt).toContain('Sent: 20 USDT');
      expect(receipt).toContain('Came back: 5 USDT (bank.payout_returned_by_bank)');
      expect(receipt).toContain('Stays paid out: 15 USDT');
    });

    it('what came back is stated in the asset that left, never in the currency paid out', async () => {
      const id = await usable();
      const { requestId } = await start(id);
      const cashOut = services().cashOut;
      await cashOut.complete(requestId);
      expect(await refused(cashOut.returned(requestId, { amount: '5', assetId: 'EUR', reason: 'bank.payout_returned_by_bank' }))).toBe(
        'bank.ramp_invalid_asset',
      );
      expect(await available()).toBe(parseAmount('30'));
    });

    it('with no partner here, or another one, no answer moves anything', async () => {
      const id = await usable();
      const { requestId } = await start(id);
      const posts = ledger.journal().length;
      expect(await refused(services(null).cashOut.complete(requestId))).toBe('rail.bank');
      expect(await refused(services(null).cashOut.fail(requestId, 'bank.payout_rejected'))).toBe('rail.bank');
      const other: CashOutPartner = { ...SIM, rail: 'another-partner' };
      expect(await refused(services(other).cashOut.complete(requestId))).toBe('rail.bank');
      await services().cashOut.complete(requestId);
      expect(
        await refused(services(null).cashOut.returned(requestId, { amount: '5', assetId: 'USDT', reason: 'bank.payout_returned_by_bank' })),
      ).toBe('rail.bank');
      expect(ledger.journal()).toHaveLength(posts + 1);
    });

    it("with its records folder, the stand-in's own word on its rail matches the payout rail boundary; a failed payout records nothing", async () => {
      const dir = join(mkdtempSync(join(tmpdir(), 'bank-payout-records-')), 'test-rail-records');
      const recording = payoutSim(
        { label: 'TEST payout stand-in', payouts: [{ asset: 'USDT', currency: 'EUR', rate: '0.9', fee: '1.5' }] },
        dir,
      );
      const cashOut = services(recording).cashOut;
      const id = await usable();
      const { requestId: paidOut } = await start(id, '20');
      const { requestId: notPaid } = await start(id, '4');
      await cashOut.complete(paidOut);
      await cashOut.complete(paidOut);
      await cashOut.returned(paidOut, { amount: '5', assetId: 'USDT', reason: 'bank.payout_returned_by_bank' });
      await cashOut.returned(paidOut, { amount: '5', assetId: 'USDT', reason: 'bank.payout_returned_by_bank' });
      await cashOut.fail(notPaid, 'bank.payout_rejected');

      const records = readFileSync(join(dir, 'payout-sim.jsonl'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { label: string; key: string; direction: string; assetId: string; amount: string });
      expect(records.map(({ label, key, direction, assetId, amount }) => [label, key, direction, assetId, amount])).toEqual([
        ['TEST', `${cashOutWithdrawalId(paidOut)}:paid`, 'out', 'USDT', '20'],
        ['TEST', `${cashOutWithdrawalId(paidOut)}:returned`, 'in', 'USDT', '5'],
      ]);
      // The rail's own total, in the ledger's signed form for its boundary (out positive, in negative), against the ledger.
      const said = records.reduce((sum, r) => sum + (r.direction === 'in' ? -1n : 1n) * parseAmount(r.amount), 0n);
      expect(formatAmount(said)).toBe('15');
      expect((await ledger.balance(railBoundary(PAYOUT_SIM_RAIL, 'USDT'))).amount).toBe(said);
    });

    it('a record the stand-in cannot write stops the answer before anything is posted', async () => {
      const dir = join(mkdtempSync(join(tmpdir(), 'bank-payout-records-')), 'test-rail-records');
      const recording = payoutSim(
        { label: 'TEST payout stand-in', payouts: [{ asset: 'USDT', currency: 'EUR', rate: '0.9', fee: '1.5' }] },
        dir,
      );
      const id = await usable();
      const { requestId } = await start(id, '10');
      // The rail already says otherwise about this payout: it would contradict itself, so nothing settles.
      mkdirSync(dir, { recursive: true });
      const line = {
        label: 'TEST',
        rail: 'payout-sim',
        key: `${cashOutWithdrawalId(requestId)}:paid`,
        direction: 'out',
        assetId: 'USDT',
        amount: '9',
      };
      writeFileSync(join(dir, 'payout-sim.jsonl'), `${JSON.stringify({ ...line, at: new Date().toISOString() })}\n`);
      const posts = ledger.journal().length;
      expect(await refused(services(recording).cashOut.complete(requestId))).toBe('bank.ramp_conflict');
      expect(ledger.journal()).toHaveLength(posts);
      expect(await held(requestId)).toBe(parseAmount('10'));
      expect((await services(recording).cashOut.list(ADA, 10)).find((r) => r.requestId === requestId)?.status).toBe('processing');
    });

    it('a settle that failed after the stand-in recorded paid is finished by saying paid again, never by saying failed', async () => {
      const dir = join(mkdtempSync(join(tmpdir(), 'bank-payout-records-')), 'test-rail-records');
      const recording = payoutSim(
        { label: 'TEST payout stand-in', payouts: [{ asset: 'USDT', currency: 'EUR', rate: '0.9', fee: '1.5' }] },
        dir,
      );
      const id = await usable();
      const { requestId } = await start(id, '20');
      const post = ledger.post.bind(ledger);
      let down = true;
      ledger.post = (async (...args: Parameters<MemoryLedger['post']>) => {
        if (down) throw new Error('TEST ledger unavailable');
        return post(...args);
      }) as MemoryLedger['post'];
      try {
        await expect(services(recording).cashOut.complete(requestId)).rejects.toThrow('TEST ledger unavailable');
      } finally {
        down = false;
      }
      expect(await refused(services(recording).cashOut.fail(requestId, 'bank.payout_rejected'))).toBe('bank.ramp_conflict');
      expect(await held(requestId)).toBe(parseAmount('20'));
      expect(await services(recording).cashOut.complete(requestId)).toMatchObject({ status: 'completed' });
      const records = readFileSync(join(dir, 'payout-sim.jsonl'), 'utf8').split('\n').filter(Boolean);
      expect(records).toHaveLength(1);
      expect((await ledger.balance(railBoundary(PAYOUT_SIM_RAIL, 'USDT'))).amount).toBe(parseAmount('20'));
    });

    it('an answer for no cash-out is not found', async () => {
      expect(await refused(services().cashOut.complete(randomUUID()))).toBe('bank.cash_out_not_found');
    });
  });
});
