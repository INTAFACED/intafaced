/**
 * PP-money-balance-04 (partial): `fees.schedule.get` serves the published personal-send fee schedule.
 * TEST figures only.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { issueAccessToken, verifyAccessToken, type Scope } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger } from '@intafaced/ledger-client';
import { createBankRouter } from '../router.js';
import { createBankServices, memoryLedgerHistory, memoryRecipientState } from '../bank-service.js';
import { memoryPartyHandles } from './party-handles.js';

const ADA = '11111111-1111-4111-8111-111111111111';
const tokenConfig = {
  secret: 'feeschedule-test-signing-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
  refreshTtlSeconds: 2_592_000,
};

function adminUrl(): string {
  const raw = process.env.TEST_DATABASE_URL?.trim();
  if (!raw) throw new Error('TEST_DATABASE_URL is unset');
  const url = new URL(raw);
  if (!url.pathname.replace(/^\//, '').endsWith('_test')) url.pathname = '/intafaced_test';
  return url.toString();
}

const drizzle = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

describe('fees.schedule.get (PP-money-balance-04)', () => {
  let db: TestDatabase;
  let router: ReturnType<typeof createBankRouter>;

  beforeAll(async () => {
    db = await createTestDatabase({ service: 'bank', url: adminUrl(), migrations });
  }, 120_000);
  afterAll(async () => {
    await db?.drop();
  }, 30_000);
  beforeEach(async () => {
    await db.sql`TRUNCATE bank.personal_transfer_terms`;
    const ledger = new MemoryLedger();
    router = createBankRouter(
      createBankServices(db.sql, ledger, memoryLedgerHistory(ledger), {
        nativeAssetId: 'IFC',
        recipients: memoryRecipientState(),
        handles: memoryPartyHandles({}),
      }),
    );
  });

  async function caller(scopes: Scope[]) {
    const { token } = await issueAccessToken(
      { userId: ADA, sessionId: '44444444-4444-4444-8444-444444444444', scopes, tier: 'full', mfa: true },
      tokenConfig,
    );
    const ctx: Context = { principal: await verifyAccessToken(token, tokenConfig), service: null, region: 'DE', requestId: 'fee-schedule' };
    return router.createCaller(ctx);
  }

  it('blank: no terms published → published false and no entries (never an invented free row)', async () => {
    expect(await (await caller(['bank:read'])).fees.schedule.get()).toEqual({ published: false, entries: [] });
  });

  it('zero is not blank: a published zero fee is listed as free; an above-zero fee is listed with the unwired blocker', async () => {
    await db.sql`
      INSERT INTO bank.personal_transfer_terms (asset_id, per_transfer_limit, daily_limit, fee, published_at)
      VALUES ('USDT', 25, 100, 0, '2026-10-22T00:00:00Z'), ('IFC', 10, 50, 0.25, '2026-10-22T00:00:00Z')
    `;
    const out = await (await caller(['bank:read'])).fees.schedule.get();
    expect(out).toEqual({
      published: true,
      entries: [
        {
          assetId: 'IFC',
          fee: '0.25',
          free: false,
          feeBlocker: 'bank.personal_transfer_fee_unwired',
          publishedAt: '2026-10-22T00:00:00.000Z',
        },
        { assetId: 'USDT', fee: '0', free: true, feeBlocker: null, publishedAt: '2026-10-22T00:00:00.000Z' },
      ],
    });
    // Money stays a decimal string on the wire.
    for (const e of out.entries) expect(typeof e.fee).toBe('string');
  });

  it('requires bank:read', async () => {
    await expect((await caller(['bank:write'])).fees.schedule.get()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
