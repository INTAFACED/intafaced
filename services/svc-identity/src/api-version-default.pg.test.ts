/**
 * The account default API version (J-developer-16 #5): blank until set, only a version the API implements, the same value
 * again changes nothing, a key cannot read or set it, and the key exchange carries it to the edge.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { LATEST_API_VERSION } from '@intafaced/contracts/api-versions';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { ApiVersionDefaults, createApiVersionRouter } from './api-version-default.js';

process.env.APP_ENV = 'test';
process.env.INTAFACED_SCREENING_FAIL_CLOSED = 'off';

const ADA = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const SID = '44444444-4444-4444-8444-444444444444';
const KEY = '55555555-5555-4555-8555-555555555555';

const tokenConfig = {
  secret: 'api-version-identity-signing-secret-long-enough',
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

const drizzle = join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

describe('account default API version (Postgres)', () => {
  let db: TestDatabase;
  let router: ReturnType<typeof createApiVersionRouter>;

  beforeAll(async () => {
    db = await createTestDatabase({ service: 'identity', url: adminUrl(), migrations });
    router = createApiVersionRouter(new ApiVersionDefaults(db.sql));
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  beforeEach(async () => {
    await db.sql`TRUNCATE api_version_defaults, users RESTART IDENTITY CASCADE`;
    await db.sql`
      INSERT INTO users (id, handle, email, password_hash, status) VALUES
        (${ADA}, 'ada', 'ada@example.com', 'x', 'active'),
        (${BOB}, 'bob', 'bob@example.com', 'x', 'active')
    `;
  });

  async function caller(userId: string, { key = false } = {}) {
    const { token } = await issueAccessToken(
      {
        userId,
        sessionId: SID,
        scopes: ['identity:read', 'identity:write'],
        tier: 'none',
        mfa: !key,
        ...(key ? { apiKeyId: KEY, keyEnv: 'live' as const } : {}),
      },
      tokenConfig,
    );
    const ctx: Context = { principal: await verifyAccessToken(token, tokenConfig), service: null, region: 'DE', requestId: 'api-version' };
    return router.createCaller(ctx);
  }

  it('reads not set, sets a known version, and setting it again changes nothing', async () => {
    const ada = await caller(ADA);
    expect(await ada.developer.apiVersion.get()).toEqual({ version: null, setAt: null });
    const set = await ada.developer.apiVersion.set({ version: LATEST_API_VERSION });
    expect(set).toMatchObject({ version: LATEST_API_VERSION, changed: true });
    expect(set.setAt).not.toBeNull();
    const again = await ada.developer.apiVersion.set({ version: LATEST_API_VERSION });
    expect(again).toEqual({ ...set, changed: false });
    expect(await ada.developer.apiVersion.get()).toEqual({ version: LATEST_API_VERSION, setAt: set.setAt });
    // One account's default is its own.
    expect(await (await caller(BOB)).developer.apiVersion.get()).toEqual({ version: null, setAt: null });
    expect(await new ApiVersionDefaults(db.sql).versionOf(ADA)).toBe(LATEST_API_VERSION);
    expect(await new ApiVersionDefaults(db.sql).versionOf(BOB)).toBeNull();
  });

  it('refuses a version the API does not implement, and writes nothing', async () => {
    const ada = await caller(ADA);
    await expect(ada.developer.apiVersion.set({ version: '1999-01-01' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('version.unknown'),
    });
    expect(await ada.developer.apiVersion.get()).toEqual({ version: null, setAt: null });
  });

  it('refuses a key, which is a delegate: the default is read and set from a session', async () => {
    const key = await caller(ADA, { key: true });
    await expect(key.developer.apiVersion.get()).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: expect.stringContaining('identity.api_version_session_only'),
    });
    await expect(key.developer.apiVersion.set({ version: LATEST_API_VERSION })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: expect.stringContaining('identity.api_version_session_only'),
    });
    expect(await (await caller(ADA)).developer.apiVersion.get()).toEqual({ version: null, setAt: null });
  });
});
