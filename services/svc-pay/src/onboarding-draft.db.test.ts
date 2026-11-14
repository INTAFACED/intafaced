import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { truncatePayForTest } from './payment-events-test-reset.js';
import { OnboardingDraftStore, onboardingDraftFieldsSchema, onboardingDraftSaveInputSchema } from './onboarding-draft.js';

/**
 * The business step's saved draft (M-plat-org-13; J-merchant-02 #1). Postgres required: TEST_DATABASE_URL, or a
 * Testcontainers postgres:16-alpine. No skip.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));
const IMAGE = 'postgres:16-alpine';

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  try {
    const container = await new PostgreSqlContainer(IMAGE)
      .withDatabase('intafaced_onboarding_draft_test')
      .withUsername('intafaced')
      .withPassword('intafaced')
      .start();
    return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `The onboarding draft is PG-hard (no skip-green). TEST_DATABASE_URL unset and Testcontainers could not start ${IMAGE}: ${msg}`,
    );
  }
}

const ANA = '66666666-6666-4666-8666-666666666666';
const BEN = '77777777-7777-4777-8777-777777777777';
const fields = (over: Record<string, string> = {}) =>
  onboardingDraftFieldsSchema.parse({
    legalName: 'TEST Draft Ltd',
    country: 'DE',
    businessType: 'online shop',
    contactEmail: 'ana@test.invalid',
    ...over,
  });

describe('the business step draft', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let store!: OnboardingDraftStore;

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
  }, 120_000);

  beforeEach(async () => {
    await truncatePayForTest(db!.sql, 'pay', 'TRUNCATE pay.merchant_onboarding_drafts');
    store = new OnboardingDraftStore(db!.sql);
  });

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  });

  it('keeps what was typed for that person only, and reads null when nothing is saved', async () => {
    expect(await store.get(ANA)).toBeNull();
    const saved = await store.save(ANA, fields(), 1);
    expect(saved?.fields).toEqual(fields());
    expect((await store.get(ANA))?.fields).toEqual(fields());
    expect(await store.get(BEN)).toBeNull();
  });

  it('a late save never overwrites a newer one, and a repeated save changes nothing', async () => {
    await store.save(ANA, fields({ legalName: 'TEST Newer Ltd' }), 20);
    const late = await store.save(ANA, fields({ legalName: 'TEST Older Ltd' }), 10);
    expect(late?.fields.legalName).toBe('TEST Newer Ltd');
    const repeated = await store.save(ANA, fields({ legalName: 'TEST Replay Ltd' }), 20);
    expect(repeated?.fields.legalName).toBe('TEST Newer Ltd');
    expect((await store.get(ANA))?.fields.legalName).toBe('TEST Newer Ltd');
  });

  it('all-blank fields read as no draft, and clearing removes it', async () => {
    await store.save(ANA, fields(), 1);
    expect(await store.save(ANA, onboardingDraftFieldsSchema.parse({}), 2)).toBeNull();
    expect(await store.get(ANA)).toBeNull();
    await store.save(ANA, fields(), 3);
    await store.clear(ANA);
    expect(await store.get(ANA)).toBeNull();
    expect((await db!.sql`SELECT count(*)::int AS n FROM pay.merchant_onboarding_drafts`)[0]!.n).toBe(0);
  });

  it('refuses a field past its limit, an unknown field and a missing seq at the door', () => {
    expect(onboardingDraftSaveInputSchema.safeParse({ fields: { legalName: 'x'.repeat(121) }, seq: 1 }).success).toBe(false);
    expect(onboardingDraftSaveInputSchema.safeParse({ fields: { iban: 'TEST' }, seq: 1 }).success).toBe(false);
    expect(onboardingDraftSaveInputSchema.safeParse({ fields: {} }).success).toBe(false);
    expect(onboardingDraftSaveInputSchema.safeParse({ fields: {}, seq: 1 }).success).toBe(true);
  });
});
