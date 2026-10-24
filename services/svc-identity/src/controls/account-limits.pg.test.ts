import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { postgresAvailable, type TestDatabase } from '@intafaced/db';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { AccountLimitOverrideSetInput, Context } from '@intafaced/contracts';
import { ActionApprovalService } from '../auth/action-approval-service.js';
import { SqlActionApprovalStore } from '../auth/action-approval-store.js';
import { IDENTITY_LIMIT_CHANGE_ACTION_TYPE } from '../auth/action-approval-audience.js';
import { createTestDatabase } from '../fixture-truncate.testkit.js';
import { FounderControls, parseFounderPair } from './founder-controls.js';
import { AccountLimitsDesk, identityLimitPayloadHash, parseLimitPolicy } from './account-limits.js';

const url = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';
const migrationDirectory = join(dirname(fileURLToPath(import.meta.url)), '../../drizzle');
const migrations = readdirSync(migrationDirectory)
  .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
  .sort()
  .map((file) => readFileSync(join(migrationDirectory, file), 'utf8'));
const tokens = {
  secret: 'an-account-limits-test-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};
const available = await postgresAvailable(url);
const REASON = 'Customer is moving house this week';
const POLICY = parseLimitPolicy(JSON.stringify({ maxLifetimeHours: '48', ceilings: { withdrawal: { USDT: '5000' } } }));

if (!available) {
  describe.skip('account limit overrides (Postgres unavailable)', () => {
    it('requires isolated Postgres evidence', () => undefined);
  });
} else {
  const db: TestDatabase = await createTestDatabase({ service: 'identity', url, migrations });
  let controls: FounderControls;
  let desk: AccountLimitsDesk;
  let first: Context;
  let second: Context;
  let customer: Context;
  let target: string;

  const seed = async (): Promise<Context> => {
    const userId = randomUUID();
    const sessionId = randomUUID();
    const handle = `l${userId.replaceAll('-', '').slice(0, 16)}`;
    await db.sql`INSERT INTO users (id, handle, email, password_hash, totp_secret, totp_enrolled_at) VALUES (${userId}, ${handle}, ${`${handle}@example.com`}, ${'test-password-hash'}, ${'verified-test-factor'}, ${new Date()})`;
    await db.sql`INSERT INTO sessions (id, user_id, refresh_hash, mfa, expires_at) VALUES (${sessionId}, ${userId}, ${`refresh:${sessionId}`}, ${true}, ${new Date(Date.now() + 3600000)})`;
    const { token } = await issueAccessToken({ userId, sessionId, scopes: ['identity:read', 'identity:write'], mfa: true }, tokens);
    return { principal: await verifyAccessToken(token, tokens), service: null, region: 'DE', requestId: randomUUID() };
  };
  const id = (context: Context) => context.principal!.userId;
  const inHours = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();
  const override = (patch: Partial<AccountLimitOverrideSetInput> = {}): AccountLimitOverrideSetInput => ({
    requestId: randomUUID(),
    userId: target,
    rail: 'withdrawal',
    assetId: 'USDT',
    perTx: '1500',
    rolling24h: '3000',
    expiresAt: inHours(24),
    reason: REASON,
    expectedVersion: '0',
    ...patch,
  });
  const approved = async (by: Context, approver: string, input: AccountLimitOverrideSetInput): Promise<AccountLimitOverrideSetInput> => {
    const approvals = new ActionApprovalService(new SqlActionApprovalStore(db.sql), {
      ttlSeconds: 600,
      founders: { isFounder: (userId) => controls.isLiveFounder(userId) },
    });
    const payloadHash = identityLimitPayloadHash(input);
    const pending = await approvals.propose(id(by), {
      actionType: IDENTITY_LIMIT_CHANGE_ACTION_TYPE,
      targetService: 'svc-identity',
      targetId: input.userId,
      expectedVersion: input.expectedVersion,
      payloadHash,
      policyVersion: 'v1',
    });
    return { ...input, approvalId: (await approvals.approve(approver, pending.approvalId, payloadHash)).approvalId };
  };
  const events = async () =>
    (await db.sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM account_limit_events WHERE user_id = ${target}`)[0]!.n;

  beforeEach(async () => {
    await db.truncateAll();
    first = await seed();
    second = await seed();
    customer = await seed();
    target = id(customer);
    controls = new FounderControls(db.sql, parseFounderPair(id(first), id(second)));
    expect(await controls.bootstrap()).toBe(true);
    desk = new AccountLimitsDesk(db.sql, controls, POLICY);
  });
  afterAll(async () => {
    await db.drop();
  });

  describe('account limit overrides', () => {
    it('sets an override under the ceiling with one founder; it is in force, replays, and a different body under its id conflicts', async () => {
      expect(await desk.state(first, { userId: target })).toEqual({
        userId: target,
        overrides: [],
        policy: { configured: true, maxLifetimeHours: '48', ceilings: [{ rail: 'withdrawal', assetId: 'USDT', ceiling: '5000' }] },
        closed: false,
        archived: false,
      });
      expect(await desk.overrideInForce(target, 'withdrawal', 'USDT')).toEqual({
        userId: target,
        rail: 'withdrawal',
        assetId: 'USDT',
        override: null,
      });

      const input = override();
      const set = await desk.set(first, input);
      expect(set).toMatchObject({
        outcome: 'changed',
        action: 'set',
        actorUserId: id(first),
        approverUserId: null,
        before: null,
        after: { version: '1', perTx: '1500', rolling24h: '3000', status: 'active', setBy: id(first), approvedBy: null },
      });
      expect(await desk.set(first, input)).toEqual(set);
      expect(await desk.set(first, { ...input, perTx: '1600' })).toMatchObject({ outcome: 'refused', code: 'request.conflict' });
      expect(await desk.overrideInForce(target.toUpperCase(), 'withdrawal', 'USDT')).toEqual({
        userId: target,
        rail: 'withdrawal',
        assetId: 'USDT',
        override: { version: '1', perTx: '1500', rolling24h: '3000', expiresAt: input.expiresAt },
      });
      // A null figure keeps the base figure; an unchanged override is refused by name.
      const keep = await desk.set(first, override({ perTx: null, expectedVersion: '1' }));
      expect(keep).toMatchObject({ outcome: 'changed', after: { version: '2', perTx: null, rolling24h: '3000' } });
      const after = keep.outcome === 'changed' ? keep.after : null;
      expect(await desk.set(first, override({ perTx: null, expiresAt: after!.expiresAt, expectedVersion: '2' }))).toMatchObject({
        outcome: 'refused',
        code: 'identity.limit_unchanged',
      });
      expect(await desk.set(first, override({ expectedVersion: '1' }))).toMatchObject({
        outcome: 'conflict',
        code: 'restriction.version_conflict',
        current: { version: '2' },
      });
      const history = await desk.history(second, { userId: target, limit: 10 });
      expect(history.map((row) => row.outcome)).toEqual(['conflict', 'refused', 'changed', 'refused', 'changed']);
    });

    it('above the ceiling needs the other founder: refused alone with the ceiling, done once with an approval bound to the same override', async () => {
      const big = override({ rolling24h: '8000' });
      expect(await desk.set(first, big)).toMatchObject({
        outcome: 'refused',
        code: 'identity.limit_requires_approver',
        ceiling: '5000',
        current: null,
      });
      // An approval for another figure does not fit this override.
      const other = await approved(first, id(second), override({ rolling24h: '9000' }));
      expect(await desk.set(first, { ...big, requestId: randomUUID(), approvalId: other.approvalId })).toMatchObject({
        outcome: 'refused',
        code: 'identity.limit_approval_mismatch',
      });
      const input = await approved(first, id(second), { ...big, requestId: randomUUID() });
      const set = await desk.set(first, input);
      expect(set).toMatchObject({
        outcome: 'changed',
        actorUserId: id(first),
        approverUserId: id(second),
        after: { version: '1', rolling24h: '8000', approvedBy: id(second) },
      });
      const [row] = await db.sql<Array<{ status: string }>>`SELECT status FROM action_approvals WHERE approval_id = ${input.approvalId!}`;
      expect(row!.status).toBe('CONSUMED');
      // Spent once: after a clear, the same approval cannot raise it again.
      await desk.clear(second, {
        requestId: randomUUID(),
        userId: target,
        rail: 'withdrawal',
        assetId: 'USDT',
        reason: REASON,
        expectedVersion: '1',
      });
      expect(await desk.set(first, { ...input, requestId: randomUUID(), expectedVersion: '2' })).toMatchObject({
        outcome: 'refused',
        code: 'identity.limit_approval_consumed',
      });
    });

    it('applies until the stored expiry, then the base limit is back; an ended override cannot be cleared, and a clear ends one at once', async () => {
      expect(await desk.set(first, override({ expiresAt: new Date(Date.now() - 1000).toISOString() }))).toMatchObject({
        code: 'identity.limit_expiry_past',
      });
      expect(await desk.set(first, override({ expiresAt: inHours(49) }))).toMatchObject({ code: 'identity.limit_lifetime_exceeded' });
      await desk.set(first, override());
      // Time passes: the stored expiry is now behind us.
      await db.sql`UPDATE account_limit_overrides SET set_at = now() - interval '2 hours', expires_at = now() - interval '1 second'
        WHERE user_id = ${target}`;
      expect((await desk.overrideInForce(target, 'withdrawal', 'USDT'))!.override).toBeNull();
      expect((await desk.state(first, { userId: target }))!.overrides).toMatchObject([{ status: 'expired', version: '1' }]);
      expect(
        await desk.clear(first, {
          requestId: randomUUID(),
          userId: target,
          rail: 'withdrawal',
          assetId: 'USDT',
          reason: REASON,
          expectedVersion: '1',
        }),
      ).toMatchObject({ outcome: 'refused', code: 'identity.limit_override_expired' });

      await desk.set(first, override({ expectedVersion: '1' }));
      const cleared = await desk.clear(second, {
        requestId: randomUUID(),
        userId: target,
        rail: 'withdrawal',
        assetId: 'USDT',
        reason: REASON,
        expectedVersion: '2',
      });
      expect(cleared).toMatchObject({
        outcome: 'changed',
        action: 'clear',
        before: { status: 'active', version: '2' },
        after: { status: 'cleared', version: '3', clearedBy: id(second) },
      });
      expect((await desk.overrideInForce(target, 'withdrawal', 'USDT'))!.override).toBeNull();
      expect(
        await desk.clear(second, {
          requestId: randomUUID(),
          userId: target,
          rail: 'withdrawal',
          assetId: 'USDT',
          reason: REASON,
          expectedVersion: '3',
        }),
      ).toMatchObject({ outcome: 'refused', code: 'identity.limit_override_not_found' });
    });

    it('refuses by name: unset policy, an asset without a ceiling, own record, closed and archived accounts; a non-founder leaves no row', async () => {
      const unset = new AccountLimitsDesk(db.sql, controls, parseLimitPolicy(''));
      expect(await unset.set(first, override())).toMatchObject({ code: 'identity.limit_ceiling_unset' });
      expect((await unset.state(first, { userId: target }))!.policy).toEqual({ configured: false, code: 'identity.limit_ceiling_unset' });
      expect(await desk.set(first, override({ assetId: 'BTC' }))).toMatchObject({ code: 'identity.limit_ceiling_unset' });
      expect(await desk.set(first, override({ userId: id(first) }))).toMatchObject({ code: 'identity.limit_self_forbidden' });
      expect(await desk.set(first, override({ userId: randomUUID() }))).toMatchObject({ code: 'target.not_found' });

      const before = await events();
      expect(await desk.set(customer, override())).toMatchObject({ code: 'operator.denied', current: null });
      expect(await events()).toBe(before);
      await expect(desk.state(customer, { userId: target })).rejects.toMatchObject({ code: 'operator.denied' });

      await db.sql`UPDATE users SET status = 'closed' WHERE id = ${target}`;
      expect(await desk.set(first, override())).toMatchObject({ code: 'identity.limit_account_closed' });
      await db.sql`UPDATE users SET archived_at = now(), archive_reason = 'dormant' WHERE id = ${target}`;
      expect(await desk.set(first, override())).toMatchObject({ code: 'identity.account_archived' });
      expect(await desk.state(first, { userId: target })).toMatchObject({ closed: true, archived: true });
    });

    it('the service read names a bad query and an unknown customer apart, so the caller refuses instead of reading "none"', async () => {
      expect(await desk.overrideInForce(randomUUID(), 'withdrawal', 'USDT')).toBe('not_found');
      expect(await desk.overrideInForce(target, 'deposit', 'USDT')).toBe('bad_query');
      expect(await desk.overrideInForce(target, 'withdrawal', 'usdt')).toBe('bad_query');
      expect(await desk.overrideInForce('not-a-uuid', 'withdrawal', 'USDT')).toBe('bad_query');
    });

    it('a closed account has no override in force, and figures spelled differently are the same override', async () => {
      const input = override();
      await desk.set(first, input);
      expect(
        await desk.set(first, override({ perTx: '1500.00', rolling24h: '3000.0', expiresAt: input.expiresAt, expectedVersion: '1' })),
      ).toMatchObject({
        outcome: 'refused',
        code: 'identity.limit_unchanged',
      });
      expect(await desk.overrideInForce(target, 'withdrawal', 'USDT')).toMatchObject({ override: { version: '1' } });
      await db.sql`UPDATE users SET status = 'closed' WHERE id = ${target}`;
      expect(await desk.overrideInForce(target, 'withdrawal', 'USDT')).toMatchObject({ override: null });
    });
  });
}
