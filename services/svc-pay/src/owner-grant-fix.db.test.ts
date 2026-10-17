/**
 * Child-row adoption and payment-profile ownership.
 * Uses TEST_DATABASE_URL when set; otherwise a throwaway Postgres container.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger, parseAmount } from '@intafaced/ledger-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PayError, PayService } from './payment-service.js';
import { truncatePayForTest } from './payment-events-test-reset.js';
import { CardSandboxAdapter } from './rails/card-sandbox.js';
import { RailRegistry } from './rails/registry.js';
import { SubMerchantService } from './submerchants.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((name) => name.endsWith('.sql') && !name.endsWith('.down.sql'))
  .sort()
  .map((name) => readFileSync(join(drizzleDir, name), 'utf8'));

const ROOT_USER = '11111111-1111-4111-8111-111111111111';
const VICTIM = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('intafaced_owner_grant_fix')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

describe('owner grant fix against postgres', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let pay!: PayService;
  let trees!: SubMerchantService;

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
    sql = db.sql;
  }, 180_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  });

  beforeEach(async () => {
    await truncatePayForTest(sql, 'pay', 'TRUNCATE pay.merchants RESTART IDENTITY CASCADE');
    const rails = new RailRegistry([
      new CardSandboxAdapter({ secret: 'owner-grant-fix-secret-at-least-32-characters', toleranceSeconds: 300 }),
    ]);
    pay = new PayService(sql, new MemoryLedger(), rails);
    trees = new SubMerchantService(sql);
  });

  it('refuses to adopt a child row when that user opens an account', async () => {
    const root = await pay.createMerchant({ userId: ROOT_USER, pricing: { feeBps: 150 } });
    const child = await trees.createSubMerchant({
      actorMerchantId: root.id,
      parentMerchantId: root.id,
      userId: VICTIM,
      pricing: { feeBps: 0 },
    });
    await expect(pay.createMerchant({ userId: VICTIM, pricing: { feeBps: 250 } })).rejects.toMatchObject({
      code: 'pay.merchant_parent_present',
    });
    const rows = await sql<Array<{ id: string; parent_merchant_id: string | null }>>`
      SELECT id, parent_merchant_id FROM pay.merchants WHERE user_id = ${VICTIM}`;
    expect(rows[0]?.id).toBe(child.id);
    expect(rows[0]?.parent_merchant_id).toBe(root.id);
    const again = await pay.createMerchant({ userId: ROOT_USER, pricing: { feeBps: 150 } });
    expect(again.id).toBe(root.id);
  });

  it('refuses a payment profile that belongs to another merchant', async () => {
    const owner = await pay.createMerchant({ userId: ROOT_USER, pricing: { feeBps: 150 } });
    const other = await pay.createMerchant({ userId: OTHER, pricing: { feeBps: 150 } });
    const profile = await pay.createProfile({ merchantId: owner.id });
    const foreign = pay.createPayment({
      merchantId: other.id,
      profileId: profile.id,
      amount: parseAmount('1'),
      assetId: 'USDT',
      method: 'card',
      railAdapter: 'card-sandbox',
    });
    await expect(foreign).rejects.toBeInstanceOf(PayError);
    await expect(foreign).rejects.toMatchObject({ code: 'pay.profile_not_found' });
    const own = pay.createPayment({
      requestId: randomUUID(),
      merchantId: owner.id,
      profileId: profile.id,
      amount: parseAmount('1'),
      assetId: 'USDT',
      method: 'card',
      railAdapter: 'card-sandbox',
    });
    const outcome = await own.then(
      () => 'created',
      (err: unknown) => (err instanceof PayError ? err.code : 'other'),
    );
    expect(outcome).not.toBe('pay.profile_not_found');
  });
});
