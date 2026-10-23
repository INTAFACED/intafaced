/**
 * Cash out to a linked bank account (BK-ord-01, J-bank-03 #1-#3) through the mounted router: the entry checks, the
 * account, what stands in the way, the step-up scope, and the request kept refused with nothing held or posted. Funds
 * are TEST deposits on a MemoryLedger. Uses TEST_DATABASE_URL. Does not start Docker.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger, parseAmount, recipes, userAvailable } from '@intafaced/ledger-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { memoryLedgerHistory } from '../analytics/ledger-history.js';
import { createBankServices } from '../bank-service.js';
import { createBankRouter } from '../router.js';

const SECRET = 'bank-cash-out-edge-secret-long-enough';
const ADA = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const GB = 'GB82WEST12345698765432';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
  .sort()
  .map((file) => readFileSync(join(drizzle, file), 'utf8'));

const STEPPED = ['bank:read', 'bank:write', 'trade:withdraw'];
const PLAIN = ['bank:read', 'bank:write'];
const errorOf = (err: unknown) => ({
  code: (err as { code?: string }).code,
  bank: (err as { cause?: { code?: string } }).cause?.code,
});

describe('cash out to a linked bank account (J-bank-03)', () => {
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

  function as(userId: string, scopes = STEPPED, cooling = '24') {
    const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      ramps: { addressBookCap: '10', offrampCoolingHours: cooling },
    });
    const raw = encodePrincipal({
      sub: userId,
      userId,
      sid: randomUUID(),
      scopes,
      tier: 'full',
      mfa: true,
      expiresAt: new Date(Date.now() + 60_000),
    } as Principal);
    return createBankRouter(bank).createCaller(
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
      return errorOf(err);
    }
    throw new Error('expected a refusal');
  };
  const linked = async (userId = ADA) =>
    (await as(userId).linkedAccounts.link({ label: 'TEST salary account', holderName: 'TEST Holder', iban: GB })).account.accountId;
  const verify = (id: string, hoursAgo = 0) =>
    sql`UPDATE bank.linked_bank_accounts SET state = 'verified', verified_at = now(), created_at = now() - make_interval(hours => ${hoursAgo}) WHERE id = ${id}`;
  const nothingMoved = () => expect(ledger.journal()).toHaveLength(1);

  describe('the quote and its entry checks', () => {
    it('an unverified account: the amount, the available balance, no fee invented, and the account as the reason', async () => {
      const id = await linked();
      const quote = await as(ADA).cashOut.quote({ assetId: 'usdt', amount: '20', linkedAccountId: id });
      expect(quote).toMatchObject({
        assetId: 'USDT',
        amount: '20',
        available: '50',
        rail: 'rail.bank',
        fee: null,
        receiveAmount: null,
        blocker: 'bank.linked_account_unverified',
      });
      expect(quote.account).toMatchObject({ accountId: id, state: 'unverified', ibanMasked: 'GB82 •••• 5432' });
      nothingMoved();
    });

    it('refuses a zero or malformed amount and more than the available balance, before reading the account', async () => {
      const id = await linked();
      for (const amount of ['0', '0.000']) {
        expect(await refused(as(ADA).cashOut.quote({ assetId: 'USDT', amount, linkedAccountId: id }))).toEqual({
          code: 'BAD_REQUEST',
          bank: 'bank.ramp_invalid_amount',
        });
      }
      expect((await refused(as(ADA).cashOut.quote({ assetId: 'USDT', amount: '1e3', linkedAccountId: id }))).code).toBe('BAD_REQUEST');
      expect(await refused(as(ADA).cashOut.quote({ assetId: 'USDT', amount: '50.000000000000000001', linkedAccountId: id }))).toEqual({
        code: 'PRECONDITION_FAILED',
        bank: 'bank.cash_out_over_available',
      });
      // Exactly the balance is allowed.
      expect((await as(ADA).cashOut.quote({ assetId: 'USDT', amount: '50', linkedAccountId: id })).amount).toBe('50');
    });

    it("someone else's account, a removed one or none is not found", async () => {
      const bobs = await linked(BOB);
      expect(await refused(as(ADA).cashOut.quote({ assetId: 'USDT', amount: '1', linkedAccountId: bobs }))).toEqual({
        code: 'NOT_FOUND',
        bank: 'bank.linked_account_not_found',
      });
      const id = await linked();
      await as(ADA).linkedAccounts.remove({ accountId: id });
      expect((await refused(as(ADA).cashOut.quote({ assetId: 'USDT', amount: '1', linkedAccountId: id }))).bank).toBe(
        'bank.linked_account_not_found',
      );
      expect((await refused(as(ADA).cashOut.quote({ assetId: 'USDT', amount: '1', linkedAccountId: randomUUID() }))).bank).toBe(
        'bank.linked_account_not_found',
      );
    });

    it('a verified account names its cooling-off first (blank, then active with the end), and after it the missing partner', async () => {
      const id = await linked();
      await verify(id);
      expect((await as(ADA, STEPPED, '').cashOut.quote({ assetId: 'USDT', amount: '5', linkedAccountId: id })).blocker).toBe(
        'bank.offramp_cooling_unset',
      );
      const inside = await as(ADA).cashOut.quote({ assetId: 'USDT', amount: '5', linkedAccountId: id });
      expect(inside.blocker).toBe('bank.offramp_cooling_active');
      expect(inside.account.coolingOffEndsAt).not.toBeNull();
      await verify(id, 25);
      expect((await as(ADA).cashOut.quote({ assetId: 'USDT', amount: '5', linkedAccountId: id })).blocker).toBe('bank.fiat_ramp_socket');
      nothingMoved();
    });
  });

  describe('asking to cash out', () => {
    it('needs the step-up scope: a plain session is refused and nothing is kept', async () => {
      const id = await linked();
      const requestId = randomUUID();
      expect((await refused(as(ADA, PLAIN).cashOut.start({ requestId, assetId: 'USDT', amount: '20', linkedAccountId: id }))).code).toBe(
        'FORBIDDEN',
      );
      expect(await sql`SELECT 1 FROM bank.cash_out_requests`).toHaveLength(0);
      nothingMoved();
    });

    it('is kept refused with the first reason, nothing held or posted, and the same id is the same request', async () => {
      const id = await linked();
      const requestId = randomUUID();
      const ask = { requestId, assetId: 'USDT', amount: '20', linkedAccountId: id };
      const first = await as(ADA).cashOut.start(ask);
      expect(first).toMatchObject({
        requestId,
        assetId: 'USDT',
        amount: '20',
        linkedAccountId: id,
        rail: 'rail.bank',
        status: 'refused',
        refusalCode: 'bank.linked_account_unverified',
      });
      expect(await as(ADA).cashOut.start({ ...ask, amount: '20.0' })).toEqual(first);
      expect(await as(ADA).cashOut.requests({ limit: 10 })).toEqual([first]);
      nothingMoved();
      expect((await ledger.balance(userAvailable(ADA, 'USDT'))).amount).toBe(parseAmount('50'));
    });

    it('a usable account still ends on the missing partner, with nothing held', async () => {
      const id = await linked();
      await verify(id, 25);
      const kept = await as(ADA).cashOut.start({ requestId: randomUUID(), assetId: 'USDT', amount: '5', linkedAccountId: id });
      expect(kept.refusalCode).toBe('bank.fiat_ramp_socket');
      nothingMoved();
    });

    it('the same id on other terms, or from someone else, is a conflict and changes nothing', async () => {
      const id = await linked();
      const requestId = randomUUID();
      await as(ADA).cashOut.start({ requestId, assetId: 'USDT', amount: '20', linkedAccountId: id });
      expect((await refused(as(ADA).cashOut.start({ requestId, assetId: 'USDT', amount: '21', linkedAccountId: id }))).bank).toBe(
        'bank.ramp_conflict',
      );
      const bobs = await linked(BOB);
      expect((await refused(as(BOB).cashOut.start({ requestId, assetId: 'USDT', amount: '20', linkedAccountId: bobs }))).bank).toBe(
        'bank.ramp_conflict',
      );
      expect(await as(BOB).cashOut.requests({ limit: 10 })).toEqual([]);
      expect(await sql`SELECT 1 FROM bank.cash_out_requests`).toHaveLength(1);
    });

    it('an entry check that fails keeps nothing', async () => {
      const id = await linked();
      expect(
        (await refused(as(ADA).cashOut.start({ requestId: randomUUID(), assetId: 'USDT', amount: '51', linkedAccountId: id }))).bank,
      ).toBe('bank.cash_out_over_available');
      expect(await sql`SELECT 1 FROM bank.cash_out_requests`).toHaveLength(0);
    });
  });
});
