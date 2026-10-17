import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryLedger } from '@intafaced/ledger-client';
import { PayService } from './payment-service.js';
import { memoryPayoutDestinations } from './merchant-payout-destination.js';
import { RailRegistry } from './rails/registry.js';
import { CardSandboxAdapter } from './rails/card-sandbox.js';

/**
 * W4b merchant names: what `PayService.createMerchant` persists, against a real
 * Postgres with every forward migration applied (the `pay` schema, as in
 * production). The migration itself is covered in merchant-names.db.test.ts.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('intafaced_names_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

describe('merchant names through the service', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let service: PayService;

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
    sql = db.sql;
    const rails = new RailRegistry([new CardSandboxAdapter({ secret: 'merchant-names-secret-at-least-32-chars', toleranceSeconds: 300 })]);
    service = new PayService(sql, new MemoryLedger(), rails, {
      checkoutRiskBand: 'low',
      payoutDestinations: memoryPayoutDestinations(),
      routingProfiles: [],
      linkDefaultTtlDays: 30,
      linkMaxTtlDays: 365,
      checkoutSessionTtlSeconds: 900,
      maxOpenSessionsPerLink: 25,
    });
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  const names = async (id: string) => {
    const [row] = await sql<Array<{ display_name: string | null; legal_name: string | null }>>`
      SELECT display_name, legal_name FROM pay.merchants WHERE id = ${id}`;
    return row;
  };

  it('stores names through createMerchant, trimmed, and falls back to the legal name for the display name', async () => {
    const a = await service.createMerchant({
      userId: randomUUID(),
      pricing: { feeBps: 250 },
      displayName: '  Acme Shop ',
      legalName: 'Acme Ltd',
    });
    expect(await names(a.id)).toEqual({ display_name: 'Acme Shop', legal_name: 'Acme Ltd' });
    const b = await service.createMerchant({ userId: randomUUID(), pricing: { feeBps: 250 }, legalName: 'Only Legal Ltd' });
    expect(await names(b.id)).toEqual({ display_name: 'Only Legal Ltd', legal_name: 'Only Legal Ltd' });
    const c = await service.createMerchant({ userId: randomUUID(), pricing: { feeBps: 250 }, displayName: 'Only Trading' });
    expect(await names(c.id)).toEqual({ display_name: 'Only Trading', legal_name: null });
    const d = await service.createMerchant({ userId: randomUUID(), pricing: { feeBps: 250 } });
    expect(await names(d.id)).toEqual({ display_name: null, legal_name: null });
  });

  it('reads the legal name from the business details an older client sends', async () => {
    const m = await service.createMerchant({
      userId: randomUUID(),
      pricing: { feeBps: 250 },
      settlementPrefs: { businessDetails: { legalName: 'Portal Ltd', country: 'GB' } },
    });
    expect(await names(m.id)).toEqual({ display_name: 'Portal Ltd', legal_name: 'Portal Ltd' });
  });

  it('refuses a bad explicit name in the service, and ignores a bad one found only in free-form preferences', async () => {
    await expect(
      service.createMerchant({ userId: randomUUID(), pricing: { feeBps: 250 }, displayName: 'bad\nname' }),
    ).rejects.toMatchObject({ code: 'pay.merchant_name_invalid' });
    await expect(
      service.createMerchant({ userId: randomUUID(), pricing: { feeBps: 250 }, legalName: 'x'.repeat(121) }),
    ).rejects.toMatchObject({
      code: 'pay.merchant_name_invalid',
    });
    const m = await service.createMerchant({
      userId: randomUUID(),
      pricing: { feeBps: 250 },
      settlementPrefs: { businessDetails: { legalName: 'bad\u0007name' } },
    });
    expect(await names(m.id)).toEqual({ display_name: null, legal_name: null });
  });

  it('keeps the first names when onboarding is retried, and a second call never renames another merchant', async () => {
    const user = randomUUID();
    const first = await service.createMerchant({ userId: user, pricing: { feeBps: 250 }, displayName: 'First Name' });
    const again = await service.createMerchant({ userId: user, pricing: { feeBps: 250 }, displayName: 'Second Name' });
    expect(again.id).toBe(first.id);
    expect((await names(first.id))?.display_name).toBe('First Name');
    const other = await service.createMerchant({ userId: randomUUID(), pricing: { feeBps: 250 }, displayName: 'Other' });
    expect((await names(first.id))?.display_name).toBe('First Name');
    expect((await names(other.id))?.display_name).toBe('Other');
  });
});
