/**
 * J-bank-01 #7 (BK-acct-01): every account call carries the profile it is made for, and a profile the caller does not hold
 * is refused before anything is read or written. Enters through the router. Uses TEST_DATABASE_URL. Does not start Docker.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger, parseAmount, recipes } from '@intafaced/ledger-client';
import { createBankServices, memoryRecipientState } from '../bank-service.js';
import { memoryLedgerHistory } from '../analytics/ledger-history.js';
import { createBankRouter } from '../router.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const SECRET = 'c'.repeat(32);
const ADA = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const SID = '99999999-9999-4999-8999-999999999999';
const ADA_CO = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BOB_CO = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

/** Labelled TEST owner values, so a personal call reaches its real answer. */
const OPTIONS = {
  accountTerms: JSON.stringify({
    tier: 'TEST base tier',
    version: 'test-1',
    currency: 'USDT',
    monthlyFee: '0',
    minimumBalance: '0',
    overdraftFee: null,
    included: ['TEST spaces'],
  }),
  accountCurrencies: 'USDT,USDC',
  accountDetails: { currencies: 'EUR' },
};

function principal(userId: string): Principal {
  return {
    sub: userId,
    userId,
    sid: SID,
    scopes: ['bank:read', 'bank:write'],
    tier: 'full',
    mfa: true,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal;
}

const refusal = (err: unknown) => ({
  status: (err as { code?: string }).code,
  code: (err as { cause?: { code?: string } }).cause?.code,
});

describe('the profile on every account call (J-bank-01 #7)', () => {
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let ledger: MemoryLedger;

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

  function as(userId: string) {
    const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      nativeAssetId: 'IFC',
      recipients: memoryRecipientState(),
      ...OPTIONS,
    });
    const raw = encodePrincipal(principal(userId));
    const edge = createEdgeContext({ secret: SECRET, serviceName: 'svc-bank' });
    return createBankRouter(bank).createCaller(
      edge({
        headers: {
          'x-intafaced-principal': raw,
          'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
          'x-intafaced-region': 'DE',
        },
        id: `req-${randomUUID()}`,
      }),
    );
  }

  /** Everything a refused call could have written: spaces and business rows (account details keep no rows here). */
  const footprint = async () => {
    const [counts] = await sql<Array<Record<string, string>>>`
      SELECT (SELECT count(*) FROM bank.spaces)::text AS spaces,
             (SELECT count(*) FROM bank.spaces WHERE removed_at IS NOT NULL)::text AS removed,
             (SELECT count(*) FROM bank.business_accounts)::text AS businesses,
             (SELECT count(*) FROM bank.business_members)::text AS members
    `;
    return counts;
  };

  beforeEach(async () => {
    await sql`TRUNCATE bank.spaces, bank.business_accounts RESTART IDENTITY CASCADE`;
    ledger = new MemoryLedger();
    await ledger.post(recipes.deposit({ userId: ADA, assetId: 'USDT', amount: parseAmount('100'), rail: 'test', railRef: randomUUID() }));
    await as(ADA).business.create({ accountId: ADA_CO, name: 'Ada TEST Studio', assetId: 'USDT', spendThreshold: '10' });
    await as(BOB).business.create({ accountId: BOB_CO, name: 'Bob TEST Works', assetId: 'USDT', spendThreshold: '10' });
  });

  it('a call with no profile, or Personal, is the personal account as before', async () => {
    const ada = as(ADA);
    for (const input of [undefined, {}, { profile: 'personal' }]) {
      expect((await ada.accounts.features(input)).tier).toBe('TEST base tier');
      expect((await ada.currencies.list(input)).currencies.map((c) => c.assetId)).toEqual(['USDT']);
      expect((await ada.accountDetails.list(input)).currencies.map((c) => c.currency)).toEqual(['EUR']);
    }
    expect(await ada.accounts.profile({ profile: 'personal' })).toEqual({ profile: 'personal', kind: 'personal', business: null });
    expect((await ada.currencies.add({ assetId: 'USDC', profile: 'personal' })).assetId).toBe('USDC');
  });

  it('a business the caller holds reads back with its name and their role, and has no company account to show', async () => {
    const ada = as(ADA);
    const profile = `business:${ADA_CO}`;
    expect(await ada.accounts.profile({ profile })).toEqual({
      profile,
      kind: 'business',
      business: { accountId: ADA_CO, name: 'Ada TEST Studio', role: 'admin' },
    });
    // A member who is not an admin sees their own role.
    await ada.business.addMember({ accountId: ADA_CO, userId: BOB, role: 'viewer' });
    expect((await as(BOB).accounts.profile({ profile })).business?.role).toBe('viewer');

    const before = await footprint();
    for (const call of [
      () => ada.accounts.features({ profile }),
      () => ada.currencies.list({ profile }),
      () => ada.accountDetails.list({ profile }),
      () => ada.accountDetails.get({ currency: 'EUR', profile }),
      () => ada.accountDetails.request({ currency: 'EUR', profile }),
      () => ada.currencies.add({ assetId: 'USDC', profile }),
      () => ada.currencies.remove({ assetId: 'USDT', profile }),
    ]) {
      expect(refusal(await call().catch((e: unknown) => e))).toEqual({
        status: 'PRECONDITION_FAILED',
        code: 'bank.company_account_unwired',
      });
    }
    // Personal money is not moved, labelled or hidden by a business call.
    expect(await footprint()).toEqual(before);
    expect((await ada.currencies.list()).currencies).toEqual([expect.objectContaining({ assetId: 'USDT', balance: '100' })]);
  });

  it('a profile the caller does not hold is refused with one answer and no side effect', async () => {
    const ada = as(ADA);
    await sql`UPDATE bank.business_accounts SET status = 'closed' WHERE id = ${BOB_CO}::uuid`;
    const closedOwn = randomUUID();
    await ada.business.create({ accountId: closedOwn, name: 'Ada TEST Closed', assetId: 'USDT', spendThreshold: '10' });
    await sql`UPDATE bank.business_accounts SET status = 'closed' WHERE id = ${closedOwn}::uuid`;
    const before = await footprint();
    // Someone else's business, one that does not exist, and the caller's own closed one.
    for (const profile of [`business:${BOB_CO}`, `business:${randomUUID()}`, `business:${closedOwn}`]) {
      for (const call of [
        () => ada.accounts.profile({ profile }),
        () => ada.accounts.features({ profile }),
        () => ada.currencies.list({ profile }),
        () => ada.accountDetails.list({ profile }),
        () => ada.accountDetails.request({ currency: 'EUR', profile }),
        () => ada.currencies.add({ assetId: 'USDC', profile }),
        () => ada.currencies.remove({ assetId: 'USDT', profile }),
      ]) {
        expect(refusal(await call().catch((e: unknown) => e))).toEqual({ status: 'FORBIDDEN', code: 'bank.profile_not_held' });
      }
    }
    expect(await footprint()).toEqual(before);
    // The person's own personal account still answers.
    expect((await ada.currencies.list({ profile: 'personal' })).currencies).toHaveLength(1);
  });

  it('a profile that is not in the stored form is a bad request, never a business lookup', async () => {
    const ada = as(ADA);
    for (const profile of ['business:', 'business:not-a-uuid', `company:${ADA_CO}`, ADA_CO, '']) {
      expect(refusal(await ada.accounts.profile({ profile }).catch((e: unknown) => e)).status).toBe('BAD_REQUEST');
    }
    // Case and spaces are the same profile.
    expect((await ada.accounts.profile({ profile: ` BUSINESS:${ADA_CO.toUpperCase()} ` })).business?.accountId).toBe(ADA_CO);
  });
});
