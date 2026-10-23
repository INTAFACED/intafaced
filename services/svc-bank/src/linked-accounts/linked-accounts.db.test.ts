/**
 * Linked bank accounts (BK-acct-02, J-bank-02 #6) through the mounted router: linked as typed and kept unverified, the
 * IBAN as the business key, the owner's cap and cooling-off window, the step-up scope, and removal. Nothing here posts to
 * the ledger. Uses TEST_DATABASE_URL. Does not start Docker.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger } from '@intafaced/ledger-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { memoryLedgerHistory } from '../analytics/ledger-history.js';
import { createBankServices } from '../bank-service.js';
import { createBankRouter } from '../router.js';
import { maskIban, normalizeIban } from './linked-accounts.js';

const SECRET = 'bank-linked-accounts-edge-secret-long-enough';
const ADA = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const GB = 'GB82WEST12345698765432';
const DE = 'DE89370400440532013000';
const NL = 'NL91ABNA0417164300';

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

describe('linked bank accounts (J-bank-02 #6)', () => {
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
    await sql`TRUNCATE bank.linked_bank_accounts CASCADE`;
    ledger = new MemoryLedger();
  });

  type Owner = { addressBookCap?: string; offrampCoolingHours?: string };
  function as(userId: string, scopes = STEPPED, owner: Owner = { addressBookCap: '10', offrampCoolingHours: '24' }) {
    const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), { ramps: owner });
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

  const ada = { label: 'TEST salary account', holderName: 'Ada Lovelace', iban: GB };
  const rows = async (userId = ADA) => sql`SELECT * FROM bank.linked_bank_accounts WHERE user_id = ${userId} ORDER BY created_at`;
  const refused = async (call: Promise<unknown>) => {
    try {
      await call;
    } catch (err) {
      return errorOf(err);
    }
    throw new Error('expected a refusal');
  };

  it('lists nothing before an account is linked', async () => {
    expect(await as(ADA).linkedAccounts.list()).toEqual({ accounts: [] });
  });

  it('links an account as unverified: listed with its state, never usable, and the full IBAN never sent back', async () => {
    const { account, created } = await as(ADA).linkedAccounts.link({ ...ada, iban: 'gb82 west 1234 5698 7654 32' });
    expect(created).toBe(true);
    expect(account).toMatchObject({
      label: 'TEST salary account',
      holderName: 'Ada Lovelace',
      ibanMasked: 'GB82 •••• 5432',
      country: 'GB',
      state: 'unverified',
      usable: false,
      blocker: 'bank.linked_account_unverified',
      verificationRail: 'rail.bank',
    });
    const [stored] = await rows();
    expect(stored).toMatchObject({ iban: GB, state: 'unverified', verified_at: null, removed_at: null });
    expect(account.coolingOffEndsAt).toBe(new Date(stored!.created_at.getTime() + 24 * 3_600_000).toISOString());
    const { accounts } = await as(ADA).linkedAccounts.list();
    expect(accounts).toEqual([account]);
    expect(JSON.stringify(accounts)).not.toContain('WEST1234');
    expect(ledger.journal()).toHaveLength(0);
  });

  it('linking the same IBAN again returns the same account unchanged and links nothing twice', async () => {
    const first = await as(ADA).linkedAccounts.link(ada);
    const again = await as(ADA).linkedAccounts.link({ ...ada, label: 'TEST other name', iban: GB.toLowerCase() });
    expect(again).toEqual({ account: first.account, created: false });
    expect(await rows()).toHaveLength(1);
  });

  it('refuses an IBAN that fails its check digits, and a blank name, keeping nothing', async () => {
    const bad = await refused(as(ADA).linkedAccounts.link({ ...ada, iban: 'GB82WEST12345698765433' }));
    expect(bad).toEqual({ code: 'BAD_REQUEST', bank: 'bank.linked_account_invalid' });
    const blank = await refused(as(ADA).linkedAccounts.link({ ...ada, holderName: '   ' }));
    expect(blank).toEqual({ code: 'BAD_REQUEST', bank: 'bank.linked_account_invalid' });
    expect(await rows()).toHaveLength(0);
  });

  it('needs the step-up scope to link or remove: a plain session is refused and nothing changes', async () => {
    expect((await refused(as(ADA, PLAIN).linkedAccounts.link(ada))).code).toBe('FORBIDDEN');
    expect(await rows()).toHaveLength(0);
    const { account } = await as(ADA).linkedAccounts.link(ada);
    expect((await refused(as(ADA, PLAIN).linkedAccounts.remove({ accountId: account.accountId }))).code).toBe('FORBIDDEN');
    expect(await as(ADA, PLAIN).linkedAccounts.list()).toEqual({ accounts: [account] });
  });

  it("holds the owner's cap, and a blank cap refuses rather than inventing one", async () => {
    const capped = { addressBookCap: '2', offrampCoolingHours: '24' };
    await as(ADA, STEPPED, capped).linkedAccounts.link(ada);
    await as(ADA, STEPPED, capped).linkedAccounts.link({ ...ada, iban: DE });
    expect(await refused(as(ADA, STEPPED, capped).linkedAccounts.link({ ...ada, iban: NL }))).toEqual({
      code: 'PRECONDITION_FAILED',
      bank: 'bank.linked_accounts_full',
    });
    // At the cap, linking one already linked still answers with it.
    expect((await as(ADA, STEPPED, capped).linkedAccounts.link(ada)).created).toBe(false);
    expect(await refused(as(BOB, STEPPED, { offrampCoolingHours: '24', addressBookCap: ' ' }).linkedAccounts.link(ada))).toEqual({
      code: 'PRECONDITION_FAILED',
      bank: 'bank.address_book_cap_unset',
    });
    expect(await rows(BOB)).toHaveLength(0);
  });

  it('two links racing at the last free place: one is linked and the other is refused full', async () => {
    const capped = { addressBookCap: '1', offrampCoolingHours: '24' };
    const results = await Promise.allSettled([
      as(ADA, STEPPED, capped).linkedAccounts.link(ada),
      as(ADA, STEPPED, capped).linkedAccounts.link({ ...ada, iban: DE }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(errorOf(lost.reason).bank).toBe('bank.linked_accounts_full');
    expect(await rows()).toHaveLength(1);
  });

  it('names the cooling-off for a verified account: blank window, inside the window, and usable once it ends', async () => {
    const { account } = await as(ADA).linkedAccounts.link(ada);
    await sql`UPDATE bank.linked_bank_accounts SET state = 'verified', verified_at = now() WHERE id = ${account.accountId}`;
    const blank = (await as(ADA, STEPPED, { addressBookCap: '10' }).linkedAccounts.list()).accounts[0]!;
    expect(blank).toMatchObject({ state: 'verified', verificationRail: null, usable: false, blocker: 'bank.offramp_cooling_unset' });
    expect(blank.coolingOffEndsAt).toBeNull();
    expect((await as(ADA).linkedAccounts.list()).accounts[0]).toMatchObject({ usable: false, blocker: 'bank.offramp_cooling_active' });
    const now = (await as(ADA, STEPPED, { addressBookCap: '10', offrampCoolingHours: '0' }).linkedAccounts.list()).accounts[0]!;
    expect(now).toMatchObject({ usable: true, blocker: null });
    await sql`UPDATE bank.linked_bank_accounts SET created_at = now() - interval '25 hours' WHERE id = ${account.accountId}`;
    expect((await as(ADA).linkedAccounts.list()).accounts[0]).toMatchObject({ usable: true, blocker: null });
  });

  it('a window too large for a date reads as unset: the list still answers and the account is not usable', async () => {
    const { account } = await as(ADA).linkedAccounts.link(ada);
    await sql`UPDATE bank.linked_bank_accounts SET state = 'verified', verified_at = now() WHERE id = ${account.accountId}`;
    for (const hours of ['2500000000', '99999999999']) {
      const [row] = (await as(ADA, STEPPED, { addressBookCap: '10', offrampCoolingHours: hours }).linkedAccounts.list()).accounts;
      expect(row).toMatchObject({ usable: false, blocker: 'bank.offramp_cooling_unset', coolingOffEndsAt: null });
    }
  });

  it('an unverified account stays unusable whatever the cooling-off says', async () => {
    const { account } = await as(ADA, STEPPED, { addressBookCap: '10', offrampCoolingHours: '0' }).linkedAccounts.link(ada);
    expect(account).toMatchObject({ usable: false, blocker: 'bank.linked_account_unverified' });
  });

  it('removes once, answers the same again, and linking it later is a new account with a new window', async () => {
    const { account } = await as(ADA).linkedAccounts.link(ada);
    expect(await as(ADA).linkedAccounts.remove({ accountId: account.accountId })).toEqual({ accountId: account.accountId, removed: true });
    expect(await as(ADA).linkedAccounts.remove({ accountId: account.accountId })).toEqual({ accountId: account.accountId, removed: true });
    expect(await as(ADA).linkedAccounts.list()).toEqual({ accounts: [] });
    const again = await as(ADA).linkedAccounts.link(ada);
    expect(again.created).toBe(true);
    expect(again.account.accountId).not.toBe(account.accountId);
    expect(await rows()).toHaveLength(2);
  });

  it('each customer sees and removes only their own accounts', async () => {
    const { account } = await as(ADA).linkedAccounts.link(ada);
    expect(await as(BOB).linkedAccounts.list()).toEqual({ accounts: [] });
    expect(await refused(as(BOB).linkedAccounts.remove({ accountId: account.accountId }))).toEqual({
      code: 'NOT_FOUND',
      bank: 'bank.linked_account_not_found',
    });
    expect((await as(ADA).linkedAccounts.list()).accounts).toHaveLength(1);
    // Bob may link the same IBAN: the business key is per customer.
    expect((await as(BOB).linkedAccounts.link(ada)).created).toBe(true);
  });

  it('normalises and masks an IBAN, and refuses a bad shape', () => {
    expect(normalizeIban(' nl91 abna 0417 1643 00 ')).toBe(NL);
    expect(maskIban(DE)).toBe('DE89 •••• 3000');
    expect(() => normalizeIban('0x0000000000000000000000000000000000000000')).toThrow(/IBAN/);
  });
});
