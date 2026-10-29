import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { MemoryEventBus } from '@intafaced/events';
import { postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { SESSION_SCOPES, issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import { mergeRouters, type Context } from '@intafaced/contracts';
import { createTestDb } from '../fixture-truncate.testkit.js';
import { AuthService } from '../auth/auth-service.js';
import { RankService } from '../rank/rank-service.js';
import { createIdentityRouter } from '../router.js';
import { SavedRecipientService } from '../saved-recipients.js';
import { createHandleRouter } from './handle-router.js';
import { HandleSettingsService } from './handle-settings.js';

/**
 * Handle change and discoverability (PP-send-request-03) against real Postgres: rule refusals name the rule, the
 * lifetime cap refuses with the count, a blank cap refuses every change, and an undiscoverable handle is the same miss
 * as an unknown one for anyone but its owner.
 */

function dedicatedTestUrl(raw: string): string {
  const parsed = new URL(raw);
  const name = parsed.pathname.replace(/^\//, '');
  if (!name.endsWith('_test')) parsed.pathname = '/intafaced_test';
  return parsed.toString();
}

const ADMIN_URL = dedicatedTestUrl(process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test');
const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

const tokenConfig = {
  secret: 'an-identity-handle-pg-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
  refreshTtlSeconds: 2_592_000,
};

const available = await postgresAvailable(ADMIN_URL);

if (!available) {
  describe.skip('handle settings (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  const db: TestDb = await createTestDb({
    service: 'identity_handle',
    url: ADMIN_URL,
    migrations: migrations.map((body) => (schema: string) => rewriteSchemaSql(body, 'identity', schema)),
  });
  const bus = new MemoryEventBus('svc-identity');
  const rank = new RankService(db.sql, bus);
  const auth = new AuthService(db.sql, bus, rank, tokenConfig);
  const CAP = 2;
  const router = mergeRouters(
    createIdentityRouter(auth, rank, { registrationOpen: true }),
    createHandleRouter(new HandleSettingsService(db.sql, CAP)),
  );
  const blankCap = createHandleRouter(new HandleSettingsService(db.sql, null));

  afterAll(async () => {
    await db.drop();
  });

  async function signUp(handle: string) {
    const session = await auth.register({ handle, email: `${handle}@example.com`, password: 'correct horse battery staple', region: 'DE' });
    return { userId: session.userId, sessionId: session.sessionId };
  }

  async function ctxOf(who: { userId: string; sessionId: string }, extra: { apiKeyId?: string } = {}): Promise<Context> {
    const { token } = await issueAccessToken(
      { userId: who.userId, sessionId: who.sessionId, scopes: [...SESSION_SCOPES], tier: 'none', mfa: true, ...extra },
      tokenConfig,
    );
    return { principal: await verifyAccessToken(token, tokenConfig), service: null, region: 'DE', requestId: 'r' };
  }
  const as = async (who: { userId: string; sessionId: string }) => router.createCaller(await ctxOf(who));

  const refusal = (p: Promise<unknown>) =>
    p.then(
      () => {
        throw new Error('expected a refusal');
      },
      (err: { code?: string; message: string; cause?: { code?: string; details?: unknown } }) => ({
        trpc: err.code,
        code: err.cause?.code,
        message: err.message,
        details: err.cause?.details,
      }),
    );

  describe('handle.change', () => {
    it('refuses a handle that breaks a rule with the code naming that rule, and changes nothing', async () => {
      const me = await signUp('rule_maker');
      const api = await as(me);
      const chars = await refusal(api.handle.change({ handle: 'no spaces-allowed!', fromHandle: 'rule_maker' }));
      expect(chars).toMatchObject({ trpc: 'BAD_REQUEST', code: 'identity.handle_characters' });
      expect(chars.message).toContain('letters, digits and underscore');
      expect(await refusal(api.handle.change({ handle: 'ab', fromHandle: 'rule_maker' }))).toMatchObject({
        code: 'identity.handle_length',
      });
      expect(await refusal(api.handle.change({ handle: 'x'.repeat(33), fromHandle: 'rule_maker' }))).toMatchObject({
        code: 'identity.handle_length',
      });
      expect(await api.handle.get()).toMatchObject({ handle: 'rule_maker', changesUsed: 0, changeCap: CAP, changesLeft: CAP });
    });

    it('changes the handle, counts it, writes the audit, and releases the old one', async () => {
      const me = await signUp('old_name');
      const api = await as(me);
      const after = await api.handle.change({ handle: '@new_name', fromHandle: 'old_name' });
      expect(after).toEqual({ handle: 'new_name', discoverable: true, changesUsed: 1, changeCap: CAP, changesLeft: 1 });
      expect((await api.me()).handle).toBe('new_name');
      const audit = await db.sql<Array<{ event: string; old_handle: string; new_handle: string }>>`
        SELECT event, old_handle::text, new_handle::text FROM handle_audit WHERE user_id = ${me.userId}`;
      expect(audit).toEqual([{ event: 'changed', old_handle: 'old_name', new_handle: 'new_name' }]);
      // A retry of the same change after a lost reply is the same answer, not a second change.
      expect(await api.handle.change({ handle: 'new_name', fromHandle: 'old_name' })).toEqual(after);
      const other = await signUp('somebody_else');
      expect(await (await as(other)).handle.change({ handle: 'old_name', fromHandle: 'somebody_else' })).toMatchObject({
        handle: 'old_name',
      });
    });

    it('refuses a taken handle, whatever its case, and a stale fromHandle', async () => {
      await signUp('taken_one');
      const me = await signUp('wants_taken');
      const api = await as(me);
      expect(await refusal(api.handle.change({ handle: 'TAKEN_one', fromHandle: 'wants_taken' }))).toMatchObject({
        trpc: 'CONFLICT',
        code: 'identity.handle_taken',
      });
      expect(await refusal(api.handle.change({ handle: 'fresh_one', fromHandle: 'not_mine' }))).toMatchObject({
        code: 'identity.handle_changed_elsewhere',
      });
      expect(await refusal(api.handle.change({ handle: 'wants_taken', fromHandle: 'wants_taken' }))).toMatchObject({
        code: 'identity.handle_unchanged',
      });
      expect((await api.handle.get()).changesUsed).toBe(0);
    });

    it('refuses past the lifetime cap with the count', async () => {
      const me = await signUp('capped_a');
      const api = await as(me);
      await api.handle.change({ handle: 'capped_b', fromHandle: 'capped_a' });
      const last = await api.handle.change({ handle: 'capped_c', fromHandle: 'capped_b' });
      expect(last).toMatchObject({ changesUsed: 2, changesLeft: 0 });
      const over = await refusal(api.handle.change({ handle: 'capped_d', fromHandle: 'capped_c' }));
      expect(over).toMatchObject({ trpc: 'PRECONDITION_FAILED', code: 'identity.handle_change_cap_reached', details: { used: 2, cap: 2 } });
      expect(over.message).toContain('2 times');
      expect((await api.handle.get()).handle).toBe('capped_c');
    });

    it('refuses every change while the owner has published no cap', async () => {
      const me = await signUp('no_cap_yet');
      const api = blankCap.createCaller(await ctxOf(me));
      expect(await refusal(api.handle.change({ handle: 'no_cap_next', fromHandle: 'no_cap_yet' }))).toMatchObject({
        code: 'identity.handle_change_cap_unset',
      });
      expect(await api.handle.get()).toMatchObject({ changeCap: null, changesLeft: null, changesUsed: 0 });
    });

    it('refuses an API key and a revoked session', async () => {
      const me = await signUp('key_holder');
      const keyed = router.createCaller(await ctxOf(me, { apiKeyId: '55555555-5555-4555-8555-555555555555' }));
      expect(await refusal(keyed.handle.change({ handle: 'key_next', fromHandle: 'key_holder' }))).toMatchObject({
        code: 'identity.delegated_refused',
      });
      await db.sql`UPDATE sessions SET revoked = true WHERE id::text = ${me.sessionId}`;
      const api = await as(me);
      expect(await refusal(api.handle.change({ handle: 'key_next', fromHandle: 'key_holder' }))).toMatchObject({
        trpc: 'UNAUTHORIZED',
        code: 'identity.session_not_live',
      });
    });
  });

  describe('handle.setDiscoverable', () => {
    it('off: others get the same miss as an unknown handle, the owner still finds themself; on again: found', async () => {
      const me = await signUp('shy_person');
      const stranger = await signUp('curious_one');
      const mine = await as(me);
      const theirs = await as(stranger);
      expect(await theirs.users.resolveHandle({ handle: 'shy_person' })).toMatchObject({ found: true, userId: me.userId });

      expect(await mine.handle.setDiscoverable({ discoverable: false })).toMatchObject({ discoverable: false });
      expect(await theirs.users.resolveHandle({ handle: 'shy_person' })).toEqual({ found: false });
      expect(await theirs.users.resolveHandle({ handle: 'shy_person' })).toEqual(
        await theirs.users.resolveHandle({ handle: 'nobody_at_all' }),
      );
      expect(await mine.users.resolveHandle({ handle: 'shy_person' })).toMatchObject({ found: true, self: true });
      // Saving them as a recipient by handle is the same miss.
      await expect(new SavedRecipientService(db.sql).add(stranger.userId, 'shy_person', 'Shy', 'save:shy_person:1')).rejects.toMatchObject({
        code: 'identity.recipient_unknown',
      });

      expect(await mine.handle.setDiscoverable({ discoverable: true })).toMatchObject({ discoverable: true });
      expect(await theirs.users.resolveHandle({ handle: 'shy_person' })).toMatchObject({ found: true, userId: me.userId });
      const audit = await db.sql<Array<{ event: string }>>`
        SELECT event FROM handle_audit WHERE user_id = ${me.userId} ORDER BY created_at, id`;
      expect(audit.map((r) => r.event).sort()).toEqual(['discoverable_off', 'discoverable_on']);
    });
  });
}
