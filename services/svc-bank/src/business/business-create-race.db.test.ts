/**
 * Two creates of one business account at once (a retry racing its first try) both get the account, never 23505.
 * business_accounts has two unique keys on the same row, its primary key (id) and (id, asset_id) for the approvals'
 * foreign key; an insert that names only (id) in ON CONFLICT does not absorb a clash Postgres finds on the other first.
 * Uses TEST_DATABASE_URL. Does not start Docker.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger, parseAmount } from '@intafaced/ledger-client';
import { createBankServices, memoryRecipientState, type BankServices } from '../bank-service.js';
import { memoryLedgerHistory } from '../analytics/ledger-history.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '../..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const OWNER = '11111111-1111-4111-8111-111111111111';
const ROUNDS = 40;
const AT_ONCE = 8;

describe('creating one business account twice at once', () => {
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let bank: BankServices;

  beforeAll(async () => {
    const url = process.env.TEST_DATABASE_URL?.trim();
    if (!url) throw new Error('TEST_DATABASE_URL is unset');
    db = await createTestDatabase({ service: 'bank', url, migrations });
    sql = db.sql;
    const ledger = new MemoryLedger();
    bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), { nativeAssetId: 'IFC', recipients: memoryRecipientState() });
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  it('every racing create returns the one account that won, with one admin member', async () => {
    const failures: string[] = [];
    for (let round = 0; round < ROUNDS; round++) {
      const accountId = randomUUID();
      const results = await Promise.allSettled(
        Array.from({ length: AT_ONCE }, () =>
          bank.business.createAccount({
            accountId,
            name: 'Race Co',
            assetId: 'USDT',
            spendThreshold: parseAmount('100'),
            creatorUserId: OWNER,
          }),
        ),
      );
      for (const result of results) {
        if (result.status === 'rejected') failures.push(String((result.reason as Error).message ?? result.reason));
        else expect(result.value.id).toBe(accountId);
      }
      const accounts = await sql`SELECT id FROM bank.business_accounts WHERE id = ${accountId}::uuid`;
      const members = await sql`SELECT user_id, role FROM bank.business_members WHERE account_id = ${accountId}::uuid`;
      expect(accounts).toHaveLength(1);
      expect(members.map((m) => [m.user_id, m.role])).toEqual([[OWNER, 'admin']]);
    }
    expect(failures).toEqual([]);
  }, 120_000);

  it('a racing create on different terms is still refused as bank.business_conflict', async () => {
    const accountId = randomUUID();
    const results = await Promise.allSettled([
      bank.business.createAccount({
        accountId,
        name: 'Race Co',
        assetId: 'USDT',
        spendThreshold: parseAmount('100'),
        creatorUserId: OWNER,
      }),
      bank.business.createAccount({
        accountId,
        name: 'Race Co',
        assetId: 'USDC',
        spendThreshold: parseAmount('100'),
        creatorUserId: OWNER,
      }),
    ]);
    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost.map((r) => (r.reason as { code?: string }).code)).toEqual(['bank.business_conflict']);
  });
});
