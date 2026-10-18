/**
 * Saved pay recipients. Names on the wire are handles. The admin URL is rewritten
 * to `intafaced_test` when TEST_DATABASE_URL names a database that does not end in `_test`.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { SavedRecipientService } from './saved-recipients.js';
import { createSavedRecipientsRouter } from './saved-recipients.router.js';

// Same test posture as the other services' vitest configs. Does not supply a sanctions list.
// Off is honoured only when APP_ENV is exactly test (or dev).
process.env.APP_ENV = 'test';
process.env.INTAFACED_SCREENING_FAIL_CLOSED = 'off';

const ADA = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const FROZEN = '33333333-3333-4333-8333-333333333333';
const CLOSED = '55555555-5555-4555-8555-555555555555';
const SID = '44444444-4444-4444-8444-444444444444';

const tokenConfig = {
  secret: 'paysend-identity-signing-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
  refreshTtlSeconds: 2_592_000,
};

function adminUrl(): string {
  const raw = process.env.TEST_DATABASE_URL?.trim();
  if (!raw) throw new Error('TEST_DATABASE_URL is unset');
  const url = new URL(raw);
  const name = url.pathname.replace(/^\//, '');
  if (!name.endsWith('_test')) url.pathname = '/intafaced_test';
  return url.toString();
}

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

describe('saved recipients (Postgres)', () => {
  let db: TestDatabase;
  let router: ReturnType<typeof createSavedRecipientsRouter>;

  beforeAll(async () => {
    db = await createTestDatabase({ service: 'identity', url: adminUrl(), migrations });
    router = createSavedRecipientsRouter(new SavedRecipientService(db.sql));
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  beforeEach(async () => {
    await db.sql`TRUNCATE saved_recipient_commands, saved_recipients, users RESTART IDENTITY CASCADE`;
    await db.sql`
      INSERT INTO users (id, handle, email, password_hash, status) VALUES
        (${ADA}, 'ada', 'ada@example.com', 'x', 'active'),
        (${BOB}, 'Bob_Pal', 'bob@example.com', 'x', 'active'),
        (${FROZEN}, 'Frozen_Pal', 'frozen@example.com', 'x', 'frozen'),
        (${CLOSED}, 'Closed_Pal', 'closed@example.com', 'x', 'closed')
    `;
  });

  async function caller(userId: string, scopes: Array<'identity:read' | 'identity:write'>) {
    const { token } = await issueAccessToken({ userId, sessionId: SID, scopes, tier: 'none', mfa: true }, tokenConfig);
    const ctx: Context = {
      principal: await verifyAccessToken(token, tokenConfig),
      service: null,
      region: 'DE',
      requestId: 'paysend',
    };
    return router.createCaller(ctx);
  }

  it('adds, lists, and removes a handle, and a reused key does not apply twice', async () => {
    const ada = await caller(ADA, ['identity:read', 'identity:write']);
    const saved = await ada.recipients.add({ handle: '@bob_pal', label: '  lunch  ', idempotencyKey: 'contact-add-1' });
    expect(saved.handle).toBe('Bob_Pal');
    expect(saved.label).toBe('lunch');

    const replay = await ada.recipients.add({ handle: 'Bob_Pal', label: 'lunch', idempotencyKey: 'contact-add-1' });
    expect(replay).toEqual(saved);

    await expect(ada.recipients.add({ handle: 'Bob_Pal', label: 'other', idempotencyKey: 'contact-add-1' })).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('identity.recipient_conflict'),
    });
    expect(await ada.recipients.list({ limit: 20 })).toEqual([saved]);

    const removed = await ada.recipients.remove({ handle: 'bob_pal', idempotencyKey: 'contact-rm-1' });
    expect(removed).toEqual({ removed: true, handle: 'Bob_Pal' });
    expect(await ada.recipients.remove({ handle: 'Bob_Pal', idempotencyKey: 'contact-rm-1' })).toEqual(removed);
    expect(await ada.recipients.list({ limit: 20 })).toEqual([]);
  });

  it('refuses an unknown, frozen, closed, or self handle with one unknown code, and refuses a missing list limit', async () => {
    const ada = await caller(ADA, ['identity:read', 'identity:write']);
    const missing = await ada.recipients
      .add({ handle: 'missing_pal', label: 'nope', idempotencyKey: 'contact-missing' })
      .then(() => '')
      .catch((err: { message: string }) => err.message);
    expect(missing).toContain('identity.recipient_unknown');
    await expect(ada.recipients.add({ handle: 'frozen_pal', label: 'nope', idempotencyKey: 'contact-frozen' })).rejects.toMatchObject({
      message: missing,
    });
    await expect(ada.recipients.add({ handle: 'closed_pal', label: 'nope', idempotencyKey: 'contact-closed' })).rejects.toMatchObject({
      message: missing,
    });
    await expect(ada.recipients.add({ handle: 'ada', label: 'me', idempotencyKey: 'contact-self' })).rejects.toMatchObject({
      message: expect.stringContaining('identity.recipient_self'),
    });
    await expect(ada.recipients.list({})).rejects.toMatchObject({
      message: expect.stringContaining('identity.saved_recipient_list_limit_unset'),
    });
  });

  it('refuses add when the session has only identity:read', async () => {
    const reader = await caller(ADA, ['identity:read']);
    await expect(reader.recipients.add({ handle: 'Bob_Pal', label: 'lunch', idempotencyKey: 'contact-no-write' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(reader.recipients.remove({ handle: 'Bob_Pal', idempotencyKey: 'contact-no-write-rm' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});
