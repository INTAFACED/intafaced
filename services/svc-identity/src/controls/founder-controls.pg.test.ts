import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, postgresAvailable, type TestDatabase } from '@intafaced/db';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import { MemoryEventBus } from '@intafaced/events';
import type { AccountControlInput, Context } from '@intafaced/contracts';
import { FounderControls, parseFounderPair } from './founder-controls.js';
import { AuthService } from '../auth/auth-service.js';
import { hashPassword } from '../auth/passwords.js';
import { RankService } from '../rank/rank-service.js';
import {
  syncNavigatorSessionClosed,
  syncNavigatorSessionOpen,
  syncNavigatorSessionsClosedForUser,
} from '../agents/navigator-session-projection-sync.js';
import { createNavigatorSessionStore } from '../agents/navigator-session-store.js';

const url = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';
const migrationDirectory = join(dirname(fileURLToPath(import.meta.url)), '../../drizzle');
const migrations = readdirSync(migrationDirectory)
  .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
  .sort()
  .map((file) => readFileSync(join(migrationDirectory, file), 'utf8'));
const tokens = {
  secret: 'a-founder-controls-test-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};
const available = await postgresAvailable(url);

if (!available) {
  describe.skip('founder controls (Postgres unavailable)', () => {
    it('requires isolated Postgres evidence', () => undefined);
  });
} else {
  const db: TestDatabase = await createTestDatabase({ service: 'identity', url, migrations });
  let controls: FounderControls;
  let first: Context;
  let second: Context;
  let ordinary: Context;
  let target: string;

  const seed = async (mfa = true): Promise<Context> => {
    const userId = randomUUID();
    const sessionId = randomUUID();
    const handle = `f${userId.replaceAll('-', '').slice(0, 16)}`;
    await db.sql`INSERT INTO users (id, handle, email, password_hash, totp_secret, totp_enrolled_at) VALUES (${userId}, ${handle}, ${`${handle}@example.com`}, ${'test-password-hash'}, ${mfa ? 'verified-test-factor' : null}, ${mfa ? new Date() : null})`;
    await db.sql`INSERT INTO sessions (id, user_id, refresh_hash, mfa, expires_at) VALUES (${sessionId}, ${userId}, ${`refresh:${sessionId}`}, ${mfa}, ${new Date(Date.now() + 3600000)})`;
    const { token } = await issueAccessToken(
      { userId, sessionId, scopes: ['identity:read', 'identity:write', 'ops:read', 'ops:write'], mfa },
      tokens,
    );
    return { principal: await verifyAccessToken(token, tokens), service: null, region: 'DE', requestId: randomUUID() };
  };
  const command = (action: 'restrict' | 'restore' = 'restrict', expectedVersion = '0'): AccountControlInput => ({
    requestId: randomUUID(),
    target: { area: 'identity', userId: target },
    action,
    reason: 'Incident review',
    expectedVersion,
  });
  const state = async (userId = target) =>
    (
      await db.sql<
        Array<{ status: string; version: string }>
      >`SELECT status, identity_control_version::text AS version FROM users WHERE id = ${userId}`
    )[0];

  beforeEach(async () => {
    await db.truncateAll();
    first = await seed();
    second = await seed();
    ordinary = await seed();
    target = ordinary.principal!.userId;
    controls = new FounderControls(db.sql, parseFounderPair(first.principal!.userId, second.principal!.userId));
    expect(await controls.bootstrap()).toBe(true);
  });
  afterAll(async () => {
    await db.drop();
  });

  describe('atomic founder identity controls against Postgres', () => {
    it('either founder independently freezes/restores and never revives credentials', async () => {
      const keyId = randomUUID();
      const subId = randomUUID();
      await db.sql`INSERT INTO api_keys (id, user_id, name, key_hash, key_prefix, scopes) VALUES (${keyId}, ${target}, ${'bot'}, ${`hash:${keyId}`}, ${'fixture'}, ${['trade:read']})`;
      await db.sql`INSERT INTO sub_accounts (id, parent_user_id, label) VALUES (${subId}, ${target}, ${'Partition'})`;
      const frozen = await controls.change(first, command());
      expect(frozen).toMatchObject({ outcome: 'changed', after: { version: '1', restricted: true } });
      expect(await state()).toEqual({ status: 'frozen', version: '1' });
      expect((await db.sql<Array<{ revoked: boolean }>>`SELECT revoked FROM sessions WHERE user_id = ${target}`)[0]!.revoked).toBe(true);
      expect((await db.sql<Array<{ revoked: boolean }>>`SELECT revoked FROM api_keys WHERE id = ${keyId}`)[0]!.revoked).toBe(true);
      expect((await db.sql<Array<{ revoked: boolean }>>`SELECT revoked FROM sub_accounts WHERE id = ${subId}`)[0]!.revoked).toBe(true);
      expect(await controls.change(second, command('restore', '1'))).toMatchObject({
        outcome: 'changed',
        after: { version: '2', restricted: false },
      });
      expect(await state()).toEqual({ status: 'active', version: '2' });
      expect((await db.sql<Array<{ revoked: boolean }>>`SELECT revoked FROM sessions WHERE user_id = ${target}`)[0]!.revoked).toBe(true);
      expect((await db.sql<Array<{ revoked: boolean }>>`SELECT revoked FROM api_keys WHERE id = ${keyId}`)[0]!.revoked).toBe(true);
      expect((await db.sql<Array<{ revoked: boolean }>>`SELECT revoked FROM sub_accounts WHERE id = ${subId}`)[0]!.revoked).toBe(true);
    });

    it('durably refuses generic admins, API keys, service impersonation, stale sessions and absent MFA without state disclosure', async () => {
      const admin = { ...ordinary, principal: { ...ordinary.principal!, scopes: ['admin:compliance', 'admin:write'] } };
      for (const context of [
        admin,
        { ...first, principal: { ...first.principal!, kid: randomUUID() } },
        { ...first, service: 'svc-ops' },
        { ...first, principal: { ...first.principal!, mfa: false } },
      ]) {
        expect(await controls.change(context, command())).toMatchObject({ outcome: 'refused', current: null });
      }
      await db.sql`UPDATE sessions SET mfa = false WHERE id = ${first.principal!.sid}`;
      expect(await controls.change(first, command())).toMatchObject({ code: 'mfa.required', current: null });
      await db.sql`UPDATE sessions SET mfa = true, revoked = true WHERE id = ${first.principal!.sid}`;
      expect(await controls.change(first, command())).toMatchObject({ code: 'operator.denied', current: null });
      expect(await state()).toEqual({ status: 'active', version: '0' });
      expect(
        (await db.sql<Array<{ count: string }>>`SELECT count(*)::text AS count FROM founder_control_audit WHERE kind = 'identity'`)[0]!
          .count,
      ).toBe('6');
    });

    it('re-authenticates retries; same request replays once and changed payload conflicts', async () => {
      const input = command();
      const original = await controls.change(first, input);
      expect(await controls.change(first, input)).toEqual(original);
      expect(await controls.change(first, { ...input, reason: 'Different operation' })).toMatchObject({ code: 'request.conflict' });
      expect(await controls.change(second, input)).toMatchObject({ code: 'request.conflict' });
      await db.sql`UPDATE sessions SET revoked = true WHERE id = ${first.principal!.sid}`;
      expect(await controls.change(first, input)).toMatchObject({ code: 'operator.denied', current: null });
      expect(await state()).toEqual({ status: 'frozen', version: '1' });
      expect(
        (
          await db.sql<
            Array<{ count: string }>
          >`SELECT count(*)::text AS count FROM founder_control_audit WHERE result->>'outcome' = 'changed' AND kind = 'identity'`
        )[0]!.count,
      ).toBe('1');
    });

    it('canonicalizes uppercase UUID inputs for target state, immutable history and retry fingerprints', async () => {
      const input = command();
      const upperTarget = { area: 'identity' as const, userId: target.toUpperCase() };
      const result = await controls.change(first, { ...input, requestId: input.requestId.toUpperCase(), target: upperTarget });
      expect(result).toMatchObject({ outcome: 'changed', requestId: input.requestId, target: input.target });
      expect(await controls.change(first, input)).toEqual(result);
      expect(await controls.getState(first, { target: upperTarget })).toEqual({ target: input.target, version: '1', restricted: true });
      expect(await controls.history(first, { target: upperTarget, limit: 10 })).toEqual([result]);
      expect(await controls.history(first, { target: input.target, limit: 10 })).toEqual([result]);
      expect(
        (await db.sql<Array<{ count: string }>>`SELECT count(*)::text AS count FROM founder_control_audit WHERE kind = 'identity'`)[0]!
          .count,
      ).toBe('1');
    });

    it('serializes racing founders and records coherent version conflicts/noops', async () => {
      const results = await Promise.all([controls.change(first, command()), controls.change(second, command())]);
      expect(results.map((result) => result.outcome).sort()).toEqual(['changed', 'conflict']);
      expect(await controls.change(second, command('restrict', '1'))).toMatchObject({
        outcome: 'noop',
        before: { version: '1' },
        after: { version: '1' },
      });
      expect(await state()).toEqual({ status: 'frozen', version: '1' });
    });

    it('freezing serializes with session, key and subaccount minting and refuses later minting', async () => {
      const bus = new MemoryEventBus();
      const auth = new AuthService(
        db.sql,
        bus,
        new RankService(db.sql, bus),
        { ...tokens, refreshTtlSeconds: 3600 },
        undefined,
        undefined,
        undefined,
        undefined,
        100,
      );
      const password = 'founder-race-test-password';
      const passwordHash = await hashPassword(password);
      await db.sql`UPDATE users SET password_hash = ${passwordHash}, totp_secret = NULL, totp_enrolled_at = NULL WHERE id = ${target}`;
      const [row] = await db.sql<Array<{ handle: string }>>`SELECT handle FROM users WHERE id = ${target}`;
      const mintKey = () => auth.createApiKey({ userId: target, name: 'Race key', scopes: ['trade:read'], grantorScopes: ['trade:read'] });
      const mintSub = () => auth.createSubAccount(target, 'Race partition');
      const login = () => auth.login({ identifier: row!.handle, password });
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt) await controls.change(second, command('restore', String(attempt * 2 - 1)));
        const results = await Promise.allSettled([
          mintKey(),
          mintSub(),
          login(),
          controls.change(first, command('restrict', String(attempt * 2))),
        ]);
        expect(results[3]).toMatchObject({ status: 'fulfilled', value: { outcome: 'changed' } });
        for (const result of results.slice(0, 3)) {
          if (result.status === 'rejected') expect(result.reason).toMatchObject({ code: 'auth.account_frozen' });
        }
        const [live] = await db.sql<
          Array<{ n: string }>
        >`SELECT ((SELECT count(*) FROM sessions WHERE user_id = ${target} AND NOT revoked) + (SELECT count(*) FROM api_keys WHERE user_id = ${target} AND NOT revoked) + (SELECT count(*) FROM sub_accounts WHERE parent_user_id = ${target} AND NOT revoked))::text AS n`;
        expect(live!.n).toBe('0');
      }
      for (const mint of [mintKey, mintSub, login]) await expect(mint()).rejects.toMatchObject({ code: 'auth.account_frozen' });
    });

    it('cannot reopen a revoked projection when an auth open callback arrives after freeze or restore', async () => {
      const sessionId = ordinary.principal!.sid;
      const projection = async () =>
        (await db.sql<Array<{ status: string }>>`SELECT status FROM navigator_session_projections WHERE session_id = ${sessionId}`)[0];
      await syncNavigatorSessionOpen(db.sql, sessionId, target);
      expect(await projection()).toEqual({ status: 'open' });
      const delayOpen = () => {
        let release!: () => void;
        const run = new Promise<void>((resolve) => {
          release = resolve;
        }).then(() => syncNavigatorSessionOpen(db.sql, sessionId, target));
        return { release, run };
      };
      const afterFreeze = delayOpen();
      await controls.change(first, command());
      afterFreeze.release();
      await afterFreeze.run;
      expect(await projection()).toEqual({ status: 'closed' });
      const afterRestore = delayOpen();
      await controls.change(second, command('restore', '1'));
      afterRestore.release();
      await afterRestore.run;
      expect(await projection()).toEqual({ status: 'closed' });
    });

    it('projects legitimate sessions but refuses mismatched, expired and logged-out late opens', async () => {
      const sessionId = ordinary.principal!.sid;
      const projection = async () =>
        (
          await db.sql<
            Array<{ user_id: string; status: string }>
          >`SELECT user_id, status FROM navigator_session_projections WHERE session_id = ${sessionId}`
        )[0];
      await syncNavigatorSessionOpen(db.sql, sessionId, first.principal!.userId);
      expect(await projection()).toBeUndefined();
      await syncNavigatorSessionOpen(db.sql, sessionId, target);
      expect(await projection()).toEqual({ user_id: target, status: 'open' });
      await db.sql`UPDATE sessions SET expires_at = now() - interval '1 second' WHERE id = ${sessionId}`;
      await syncNavigatorSessionsClosedForUser(db.sql, target);
      await syncNavigatorSessionOpen(db.sql, sessionId, target);
      expect(await projection()).toEqual({ user_id: target, status: 'closed' });
      await db.sql`UPDATE sessions SET expires_at = now() + interval '1 hour', revoked = true WHERE id = ${sessionId}`;
      await syncNavigatorSessionClosed(db.sql, sessionId);
      await syncNavigatorSessionOpen(db.sql, sessionId, target);
      expect(await projection()).toEqual({ user_id: target, status: 'closed' });
    });

    it('binds explicit navigator publishes and reads to real session owners', async () => {
      const store = createNavigatorSessionStore(db.sql);
      const snapshot = { sessionId: ordinary.principal!.sid, userId: target, status: 'open' as const };
      await expect(store.publishSession({ ...snapshot, userId: first.principal!.userId })).rejects.toMatchObject({
        code: 'session_authority_denied',
      });
      await expect(store.publishSession({ ...snapshot, sessionId: randomUUID() })).rejects.toMatchObject({
        code: 'session_authority_denied',
      });
      await store.publishSession({ ...snapshot, sessionId: snapshot.sessionId.toUpperCase(), userId: target.toUpperCase() });
      expect(await store.readSession(snapshot.sessionId)).toEqual(snapshot);
      await db.sql`UPDATE navigator_session_projections SET user_id = ${first.principal!.userId} WHERE session_id = ${snapshot.sessionId}`;
      expect(await store.readSession(snapshot.sessionId)).toEqual(snapshot);
      const missingId = randomUUID();
      await db.sql`INSERT INTO navigator_session_projections (session_id, user_id, status) VALUES (${missingId}, ${target}, 'open')`;
      expect(await store.readSession(missingId)).toBeNull();
      expect(await store.refreshFromAuthSessions()).toBe(3);
      expect(
        (
          await db.sql<
            Array<{ user_id: string; status: string }>
          >`SELECT user_id, status FROM navigator_session_projections WHERE session_id = ${snapshot.sessionId}`
        )[0],
      ).toEqual({ user_id: target, status: 'open' });
      expect(
        (await db.sql<Array<{ status: string }>>`SELECT status FROM navigator_session_projections WHERE session_id = ${missingId}`)[0],
      ).toEqual({ status: 'closed' });
    });

    it('refuses delayed publisher snapshots and refreshes durable closed state after freeze and restore', async () => {
      const store = createNavigatorSessionStore(db.sql);
      const snapshot = { sessionId: ordinary.principal!.sid, userId: target, status: 'open' as const };
      await store.publishSession(snapshot);
      const delayPublish = () => {
        let release!: () => void;
        const run = new Promise<void>((resolve) => {
          release = resolve;
        }).then(() => store.publishSession(snapshot));
        return { release, run };
      };
      const frozen = delayPublish();
      const frozenRefusal = expect(frozen.run).rejects.toMatchObject({ code: 'session_authority_denied' });
      await controls.change(first, command());
      frozen.release();
      await frozenRefusal;
      await store.refreshFromAuthSessions();
      expect(await store.readSession(snapshot.sessionId)).toEqual({ ...snapshot, status: 'closed' });
      const restored = delayPublish();
      const restoredRefusal = expect(restored.run).rejects.toMatchObject({ code: 'session_authority_denied' });
      await controls.change(second, command('restore', '1'));
      restored.release();
      await restoredRefusal;
      await store.refreshFromAuthSessions();
      expect(await store.readSession(snapshot.sessionId)).toEqual({ ...snapshot, status: 'closed' });
      expect(await store.readSession(first.principal!.sid)).toMatchObject({ userId: first.principal!.userId, status: 'open' });
    });

    it('keeps auth authoritative when projection persistence fails; explicit publishers report the failure', async () => {
      const sessionId = ordinary.principal!.sid;
      await db.sql.unsafe(
        `CREATE FUNCTION identity.test_reject_projection() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected projection failure'; END $$; CREATE TRIGGER test_projection_failure BEFORE INSERT OR UPDATE ON identity.navigator_session_projections FOR EACH ROW EXECUTE FUNCTION identity.test_reject_projection()`,
      );
      try {
        await expect(syncNavigatorSessionOpen(db.sql, sessionId, target)).resolves.toBeUndefined();
        await expect(createNavigatorSessionStore(db.sql).publishSession({ sessionId, userId: target, status: 'open' })).rejects.toThrow(
          'injected projection failure',
        );
        expect(await controls.currentAuthority({ userId: target, credential: { kind: 'session', sessionId } })).toMatchObject({
          status: 'eligible',
        });
        expect((await db.sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM navigator_session_projections`)[0]!.n).toBe('0');
      } finally {
        await db.sql.unsafe(
          'DROP TRIGGER test_projection_failure ON identity.navigator_session_projections; DROP FUNCTION identity.test_reject_projection()',
        );
      }
    });

    it('allows freezing a founder; only the other live founder restores them', async () => {
      target = second.principal!.userId;
      expect(await controls.change(first, command())).toMatchObject({ outcome: 'changed' });
      expect(await controls.change(second, command('restore', '1'))).toMatchObject({ code: 'operator.denied', current: null });
      expect(await controls.change(first, command('restore', '1'))).toMatchObject({ outcome: 'changed' });
      expect((await db.sql<Array<{ revoked: boolean }>>`SELECT revoked FROM sessions WHERE user_id = ${target}`)[0]!.revoked).toBe(true);
    });

    it('cannot turn a closed account into a restorable frozen identity', async () => {
      await db.sql`UPDATE users SET status = 'closed' WHERE id = ${target}`;
      expect(await controls.change(first, command())).toMatchObject({ outcome: 'noop' });
      expect(await controls.change(first, command('restore'))).toMatchObject({ code: 'restore.not_permitted' });
      expect(await state()).toEqual({ status: 'closed', version: '0' });
    });

    it('rolls back all status, version and credential changes if durable audit fails', async () => {
      await db.sql.unsafe(
        `CREATE FUNCTION identity.test_reject_control_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind = 'identity' THEN RAISE EXCEPTION 'injected audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER test_control_audit_failure BEFORE INSERT ON identity.founder_control_audit FOR EACH ROW EXECUTE FUNCTION identity.test_reject_control_audit()`,
      );
      try {
        await expect(controls.change(first, command())).rejects.toMatchObject({ code: 'identity.controls_unavailable' });
        expect(await state()).toEqual({ status: 'active', version: '0' });
        expect((await db.sql<Array<{ revoked: boolean }>>`SELECT revoked FROM sessions WHERE user_id = ${target}`)[0]!.revoked).toBe(false);
      } finally {
        await db.sql.unsafe(
          'DROP TRIGGER test_control_audit_failure ON identity.founder_control_audit; DROP FUNCTION identity.test_reject_control_audit()',
        );
      }
    });

    it('rejects history rewrites/deletion in PostgreSQL', async () => {
      const result = await controls.change(first, command());
      await expect(db.sql`UPDATE founder_control_audit SET result = '{}'::jsonb WHERE audit_id = ${result.auditId}`).rejects.toThrow(
        'immutable',
      );
      await expect(db.sql`DELETE FROM founder_control_audit WHERE audit_id = ${result.auditId}`).rejects.toThrow('immutable');
      expect(await controls.history(first, { target: { area: 'identity', userId: target }, limit: 20 })).toEqual([result]);
      await expect(controls.history(ordinary, { target: { area: 'identity', userId: target }, limit: 20 })).rejects.toMatchObject({
        code: 'operator.denied',
      });
    });

    it('checks live founder authority before reading identity state and bounded history', async () => {
      const lookup = { target: { area: 'identity' as const, userId: target } };
      expect(await controls.getState(first, lookup)).toEqual({ ...lookup, version: '0', restricted: false });
      expect(await controls.getState(first, { target: { area: 'identity', userId: randomUUID() } })).toBeNull();
      const frozen = await controls.change(first, command());
      const restored = await controls.change(second, command('restore', '1'));
      expect(await controls.getState(second, lookup)).toEqual({ ...lookup, version: '2', restricted: false });
      expect(await controls.history(second, { ...lookup, limit: 1 })).toEqual([restored]);
      expect(await controls.history(second, { ...lookup, limit: 2 })).toEqual([restored, frozen]);
      await expect(controls.getState(ordinary, lookup)).rejects.toMatchObject({ code: 'operator.denied' });
      await db.sql`UPDATE sessions SET revoked = true WHERE id = ${first.principal!.sid}`;
      await expect(controls.getState(first, lookup)).rejects.toMatchObject({ code: 'operator.denied' });
      await expect(controls.history(first, { ...lookup, limit: 1 })).rejects.toMatchObject({ code: 'operator.denied' });
    });

    it('replays entitlement commands exactly and durably attributes their reasons', async () => {
      const input = {
        requestId: randomUUID(),
        userId: second.principal!.userId,
        action: 'revoke' as const,
        expectedVersion: '1',
        reason: 'Lost operator device',
      };
      const result = await controls.changeEntitlement(first, {
        ...input,
        requestId: input.requestId.toUpperCase(),
        userId: input.userId.toUpperCase(),
      });
      expect(await controls.changeEntitlement(first, input)).toEqual(result);
      const [audit] = await db.sql<
        Array<{ actor_id: string; detail: unknown }>
      >`SELECT actor_id, detail FROM founder_control_audit WHERE audit_id = ${result.auditId}`;
      expect(audit).toEqual({ actor_id: first.principal!.userId, detail: { input, actorUserId: first.principal!.userId } });
      await db.sql`UPDATE sessions SET revoked = true WHERE id = ${first.principal!.sid}`;
      expect(await controls.changeEntitlement(first, input)).toMatchObject({
        outcome: 'refused',
        entitlement: null,
        code: 'operator.denied',
      });
    });

    it('pins the original pair and preserves revoked entitlements across restart', async () => {
      const revoked = await controls.changeEntitlement(first, {
        requestId: randomUUID(),
        userId: second.principal!.userId,
        action: 'revoke',
        expectedVersion: '1',
        reason: 'Lost operator device',
      });
      expect(revoked).toMatchObject({ outcome: 'changed', entitlement: { status: 'revoked', version: '2' } });
      const restarted = new FounderControls(db.sql, parseFounderPair(first.principal!.userId, second.principal!.userId));
      expect(await restarted.bootstrap()).toBe(true);
      expect(await restarted.entitlement(second.principal!.userId)).toMatchObject({ status: 'revoked', version: '2' });
      expect(await restarted.change(second, command())).toMatchObject({ code: 'operator.denied' });
      expect(
        await restarted.changeEntitlement(first, {
          requestId: randomUUID(),
          userId: second.principal!.userId,
          action: 'restore',
          expectedVersion: '2',
          reason: 'Verified replacement device',
        }),
      ).toMatchObject({ entitlement: { status: 'enabled', version: '3' } });
      const changedPair = new FounderControls(db.sql, parseFounderPair(first.principal!.userId, ordinary.principal!.userId));
      expect(await changedPair.bootstrap()).toBe(false);
      expect(await changedPair.change(first, command())).toMatchObject({ code: 'operator.denied' });
    });

    it('delegated and own-status reads require actual session MFA and matching signed principal', async () => {
      const delegated = { ...first, service: 'svc-ops' };
      expect(await controls.operatorEntitlement(delegated, first.principal!.userId)).toMatchObject({ status: 'enabled' });
      expect(await controls.operatorEntitlement(delegated, first.principal!.userId.toUpperCase())).toMatchObject({
        status: 'enabled',
        userId: first.principal!.userId,
      });
      expect(await controls.operatorStatus(first)).toMatchObject({ status: 'enabled' });
      expect(await controls.operatorStatus(ordinary)).toMatchObject({ status: 'not_operator' });
      expect(await controls.operatorEntitlement(delegated, second.principal!.userId)).toMatchObject({ status: 'not_operator' });
      expect(await controls.operatorEntitlement({ ...delegated, principal: null }, first.principal!.userId)).toMatchObject({
        status: 'not_operator',
      });
      await db.sql`UPDATE sessions SET mfa = false WHERE id = ${first.principal!.sid}`;
      expect(await controls.operatorEntitlement(delegated, first.principal!.userId)).toMatchObject({ status: 'not_operator' });
      expect(await controls.operatorStatus(first)).toMatchObject({ status: 'not_operator' });
    });

    it('returns bounded credential snapshots, then denies revoked credentials and frozen identities', async () => {
      const subject = { userId: target, credential: { kind: 'session' as const, sessionId: ordinary.principal!.sid } };
      const result = await controls.currentAuthority({
        userId: target.toUpperCase(),
        credential: { kind: 'session', sessionId: ordinary.principal!.sid.toUpperCase() },
      });
      expect(result.status).toBe('eligible');
      expect(result.subject).toEqual(subject);
      const apiKeyId = randomUUID();
      const subAccountId = randomUUID();
      await db.sql`INSERT INTO api_keys (id, user_id, name, key_hash, key_prefix, scopes) VALUES (${apiKeyId}, ${target}, ${'Canonical key'}, ${`hash:${apiKeyId}`}, ${'fixture'}, ${['trade:read']})`;
      await db.sql`INSERT INTO sub_accounts (id, parent_user_id, label) VALUES (${subAccountId}, ${target}, ${'Canonical partition'})`;
      expect(
        await controls.currentAuthority({
          userId: target.toUpperCase(),
          credential: { kind: 'api_key', apiKeyId: apiKeyId.toUpperCase() },
          subAccountId: subAccountId.toUpperCase(),
        }),
      ).toMatchObject({ status: 'eligible', subject: { userId: target, credential: { kind: 'api_key', apiKeyId }, subAccountId } });
      if (result.status === 'eligible') expect(Date.parse(result.leaseExpiresAt) - Date.parse(result.checkedAt)).toBe(5000);
      await controls.change(first, command());
      expect(await controls.currentAuthority(subject)).toMatchObject({ status: 'denied', code: 'auth.account_frozen' });
      await controls.change(second, command('restore', '1'));
      expect(await controls.currentAuthority(subject)).toMatchObject({ status: 'denied', code: 'auth.credential_revoked' });
    });

    it('initial bootstrap requires both existing active verified MFA identities', async () => {
      await db.truncateAll();
      const a = await seed();
      const b = await seed(false);
      const missingMfa = new FounderControls(db.sql, parseFounderPair(a.principal!.userId, b.principal!.userId));
      expect(await missingMfa.bootstrap()).toBe(false);
      expect((await db.sql<Array<{ count: string }>>`SELECT count(*)::text AS count FROM founder_operator_entitlements`)[0]!.count).toBe(
        '0',
      );
      expect(await new FounderControls(db.sql, parseFounderPair(a.principal!.userId, randomUUID())).bootstrap()).toBe(false);
    });

    it('bootstraps established passkey founders with registration counter zero and no invented verification field', async () => {
      await db.truncateAll();
      const a = await seed();
      const b = await seed();
      const credential = {
        credentialId: 'registered-key',
        publicKey: 'verified-registration-public-key',
        counter: 0,
        createdAt: new Date().toISOString(),
      };
      await db.sql`UPDATE users SET totp_secret = NULL, totp_enrolled_at = NULL, webauthn_creds = ${db.sql.json([credential])} WHERE id = ${b.principal!.userId}`;
      const passkeyControls = new FounderControls(db.sql, parseFounderPair(a.principal!.userId, b.principal!.userId));
      expect(await passkeyControls.bootstrap()).toBe(true);
      expect(await passkeyControls.operatorStatus(b)).toMatchObject({ status: 'enabled' });
    });
  });
}
