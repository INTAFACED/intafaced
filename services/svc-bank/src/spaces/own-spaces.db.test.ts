import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { createEdgeContext } from '@intafaced/contracts';
import { MemoryLedger } from '@intafaced/ledger-client';
import { createBankServices, memoryRecipientState, type BankServices } from '../bank-service.js';
import { memoryLedgerHistory } from '../analytics/ledger-history.js';
import { createBankRouter } from '../router.js';

/**
 * PF-cost-basis-02 (LB-6): the list of a customer's own named spaces that svc-tax asks for, so the lot book can follow the
 * customer's coins between their main account and a space. Every named space ever owned, archived too; never the primary, never
 * another customer's, never a balance; and the door answers svc-tax and nobody else.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '../..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const ADA = '11111111-1111-4111-8111-111111111111';
const BO = '22222222-2222-4222-8222-222222222222';
const edge = createEdgeContext({ secret: 'a-bank-own-spaces-test-secret-of-32-chars', serviceName: 'svc-bank' });

describe('own spaces for the lot book', () => {
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let bank: BankServices;

  beforeAll(async () => {
    const url = process.env.TEST_DATABASE_URL?.trim();
    if (!url) throw new Error('TEST_DATABASE_URL is unset');
    db = await createTestDatabase({ service: 'bank', url, migrations });
    sql = db.sql;
  }, 120_000);

  beforeEach(async () => {
    await sql`TRUNCATE bank.spaces RESTART IDENTITY CASCADE`;
    const ledger = new MemoryLedger();
    bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), { nativeAssetId: 'IFC', recipients: memoryRecipientState() });
  });

  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  const call = (service: string | null, userId: string) =>
    createBankRouter(bank)
      .createCaller({ ...edge({ headers: {}, id: 'req-1' }), service } as never)
      .spaces.ownedAccounts({ userId });

  it('lists every named space the customer owns, archived ones too, and no primary and nobody else’s', async () => {
    await bank.spaces.ensurePrimary(ADA, 'BTC');
    const cold = await bank.spaces.create({ userId: ADA, assetId: 'BTC', name: 'TEST cold' });
    const old = await bank.spaces.create({ userId: ADA, assetId: 'ETH', name: 'TEST old' });
    await bank.spaces.archive(old.id);
    await bank.spaces.create({ userId: BO, assetId: 'BTC', name: 'TEST not Ada’s' });

    const got = await call('svc-tax', ADA);
    expect(got.spaces).toEqual(
      expect.arrayContaining([
        { spaceId: cold.id, assetId: 'BTC', name: 'TEST cold', archived: false },
        { spaceId: old.id, assetId: 'ETH', name: 'TEST old', archived: true },
      ]),
    );
    expect(got.spaces).toHaveLength(2);
    expect(JSON.stringify(got)).not.toMatch(/balance|goal|locked/i);
  });

  it('answers an empty list for a customer with no named space', async () => {
    await bank.spaces.ensurePrimary(BO, 'BTC');
    await expect(call('svc-tax', BO)).resolves.toEqual({ spaces: [] });
  });

  it('serves svc-tax only: another service is forbidden and no service is unauthorized', async () => {
    await expect(call('svc-pay', ADA)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(call(null, ADA)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
});
