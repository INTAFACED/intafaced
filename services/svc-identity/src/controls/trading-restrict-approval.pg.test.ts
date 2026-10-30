/**
 * Trading restriction four-eyes, against Postgres.
 * Flag off: identity still refuses a trading area and an identity change records fourEyes false.
 * Flag on: no approval changes nothing; a bound approval applies once; a second request id,
 * a different payload, and a different account are refused.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { postgresAvailable, type TestDatabase } from '@intafaced/db';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { IdentityAccountControlInput, Context } from '@intafaced/contracts';
import { createTestDatabase } from '../fixture-truncate.testkit.js';
import { ActionApprovalService } from '../auth/action-approval-service.js';
import { SqlActionApprovalStore } from '../auth/action-approval-store.js';
import { FounderControls, FounderControlError, parseFounderPair, tradingRestrictPayloadHash } from './founder-controls.js';

const url = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';
const migrationDirectory = join(dirname(fileURLToPath(import.meta.url)), '../../drizzle');
const migrations = readdirSync(migrationDirectory)
  .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
  .sort()
  .map((file) => readFileSync(join(migrationDirectory, file), 'utf8'));
const tokens = {
  secret: 'a-trading-restrict-approval-test-secret-long',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};
const available = await postgresAvailable(url);

if (!available) {
  describe.skip('trading restrict approval (Postgres unavailable)', () => {
    it('requires isolated Postgres evidence', () => undefined);
  });
} else {
  const db: TestDatabase = await createTestDatabase({ service: 'identity', url, migrations });
  let maker: Context;
  let checker: Context;
  let plain: Context;
  let target: string;
  let approvals: ActionApprovalService;
  let on: FounderControls;

  const seed = async (scopes: string[]): Promise<Context> => {
    const userId = randomUUID();
    const sessionId = randomUUID();
    const handle = `t${userId.replaceAll('-', '').slice(0, 16)}`;
    await db.sql`INSERT INTO users (id, handle, email, password_hash, totp_secret, totp_enrolled_at) VALUES (${userId}, ${handle}, ${`${handle}@example.com`}, ${'test-password-hash'}, ${'verified-test-factor'}, ${new Date()})`;
    await db.sql`INSERT INTO sessions (id, user_id, refresh_hash, mfa, expires_at) VALUES (${sessionId}, ${userId}, ${`refresh:${sessionId}`}, ${true}, ${new Date(Date.now() + 3600000)})`;
    const { token } = await issueAccessToken({ userId, sessionId, scopes: scopes as never, mfa: true }, tokens);
    return { principal: await verifyAccessToken(token, tokens), service: null, region: 'DE', requestId: randomUUID() };
  };

  const trading = (extra: Partial<IdentityAccountControlInput> = {}): IdentityAccountControlInput => ({
    requestId: randomUUID(),
    target: { area: 'trading', userId: target },
    action: 'restrict',
    reason: 'Incident review',
    expectedVersion: '0',
    ...extra,
  });

  const mint = async (
    userId: string,
    reason = 'Incident review',
    action: 'restrict' | 'restore' = 'restrict',
    expectedVersion = '0',
    reasonCode?: string,
  ) => {
    const payloadHash = tradingRestrictPayloadHash({ userId, action, reason, expectedVersion, ...(reasonCode ? { reasonCode } : {}) });
    const pending = await approvals.propose(maker.principal!.userId, {
      actionType: 'trading.restrict',
      targetService: 'svc-identity',
      targetId: userId,
      expectedVersion,
      payloadHash,
      policyVersion: 'trading-restriction-v1',
    });
    return approvals.approve(checker.principal!.userId, pending.approvalId, payloadHash);
  };

  const restriction = async (userId = target) =>
    (
      await db.sql<
        Array<{ restricted: boolean; version: string }>
      >`SELECT restricted, version::text AS version FROM trading_restrictions WHERE user_id = ${userId}`
    )[0];

  const approvalRow = async (approvalId: string) =>
    (
      await db.sql<
        Array<{
          status: string;
          consumed_request_id: string | null;
          consumed_by_service: string | null;
          consumed_by_principal: string | null;
        }>
      >`SELECT status, consumed_request_id, consumed_by_service, consumed_by_principal FROM action_approvals WHERE approval_id = ${approvalId}`
    )[0];

  beforeEach(async () => {
    await db.truncateAll();
    maker = await seed(['identity:read', 'identity:write', 'admin:write']);
    checker = await seed(['identity:read', 'identity:write', 'admin:write']);
    plain = await seed(['identity:read', 'identity:write']);
    const customer = await seed(['identity:read']);
    target = customer.principal!.userId;
    approvals = new ActionApprovalService(new SqlActionApprovalStore(db.sql), { ttlSeconds: 600 });
    on = new FounderControls(db.sql, null, { tradingRestrictRequiresApproval: true });
  });

  afterAll(async () => {
    await db.drop();
  });

  describe('trading.restrict approval consumption', () => {
    it('flag on, no approval refuses and writes nothing', async () => {
      const result = await on.change(checker, trading());
      expect(result).toMatchObject({
        outcome: 'refused',
        code: 'restriction_no_four_eyes',
        changed: false,
        current: { version: '0', restricted: false },
      });
      expect(await restriction()).toBeUndefined();
      const detail = (
        await db.sql<
          Array<{ detail: { fourEyes?: boolean } }>
        >`SELECT detail FROM founder_control_audit WHERE request_id = ${result.requestId}`
      )[0];
      expect(detail?.detail).toMatchObject({ fourEyes: false, area: 'trading' });
    });

    it('flag on, a bound approval applies once and a second request id refuses', async () => {
      const approved = await mint(target);
      const first = trading({ approvalId: approved.approvalId });
      const applied = await on.change(checker, first);
      expect(applied).toMatchObject({ outcome: 'changed', changed: true, after: { version: '1', restricted: true } });
      expect(await restriction()).toEqual({ restricted: true, version: '1' });
      expect(await approvalRow(approved.approvalId)).toMatchObject({
        status: 'CONSUMED',
        consumed_request_id: first.requestId,
        consumed_by_service: 'svc-identity',
        consumed_by_principal: checker.principal!.userId,
      });
      expect(await on.change(checker, first)).toEqual(applied);
      const second = await on.change(checker, trading({ approvalId: approved.approvalId, expectedVersion: '1' }));
      expect(second).toMatchObject({
        outcome: 'refused',
        code: 'restriction_approval_consumed',
        current: { version: '1', restricted: true },
      });
      expect(await restriction()).toEqual({ restricted: true, version: '1' });
      const success = (
        await db.sql<
          Array<{ detail: { fourEyes?: boolean; approvalId?: string } }>
        >`SELECT detail FROM founder_control_audit WHERE request_id = ${first.requestId}`
      )[0];
      expect(success?.detail).toMatchObject({ fourEyes: true, approvalId: approved.approvalId });
    });

    it('consumes an approval that applies a restriction which is already in place', async () => {
      const first = await mint(target);
      await on.change(checker, trading({ approvalId: first.approvalId }));
      const second = await mint(target, 'Incident review', 'restrict', '1');
      const noop = await on.change(checker, trading({ approvalId: second.approvalId, expectedVersion: '1' }));
      expect(noop).toMatchObject({ outcome: 'noop', changed: false, after: { version: '1', restricted: true } });
      expect(await approvalRow(second.approvalId)).toMatchObject({ status: 'CONSUMED', consumed_by_service: 'svc-identity' });
      expect(await restriction()).toEqual({ restricted: true, version: '1' });
    });

    it('refuses a payload or account that does not match the approval and does not consume it', async () => {
      const approved = await mint(target);
      const payload = await on.change(checker, trading({ approvalId: approved.approvalId, reason: 'Different reason' }));
      expect(payload).toMatchObject({ outcome: 'refused', code: 'restriction_approval_mismatch' });
      expect(await approvalRow(approved.approvalId)).toMatchObject({ status: 'APPROVED', consumed_request_id: null });
      expect(await restriction()).toBeUndefined();

      const other = randomUUID();
      await db.sql`INSERT INTO users (id, handle, email, password_hash) VALUES (${other}, ${`o${other.replaceAll('-', '').slice(0, 16)}`}, ${`${other}@example.com`}, ${'test-password-hash'})`;
      const foreign = await mint(other);
      const account = await on.change(checker, trading({ approvalId: foreign.approvalId }));
      expect(account).toMatchObject({ outcome: 'refused', code: 'restriction_approval_mismatch' });
      expect(await approvalRow(foreign.approvalId)).toMatchObject({ status: 'APPROVED', consumed_request_id: null });
      expect(await restriction()).toBeUndefined();
    });

    it('a session without admin:write is refused and the approval stays approved', async () => {
      const approved = await mint(target);
      const result = await on.change(plain, trading({ approvalId: approved.approvalId }));
      expect(result).toMatchObject({ outcome: 'refused', code: 'operator.denied', current: null });
      expect(await approvalRow(approved.approvalId)).toMatchObject({ status: 'APPROVED', consumed_request_id: null });
      expect(await restriction()).toBeUndefined();
    });

    it('flag off keeps the old refusal and records fourEyes false on an identity change', async () => {
      const off = new FounderControls(db.sql, parseFounderPair(maker.principal!.userId, checker.principal!.userId));
      expect(await off.bootstrap()).toBe(true);
      await expect(off.change(checker, trading())).rejects.toBeInstanceOf(FounderControlError);
      await expect(off.change(checker, trading())).rejects.toMatchObject({ code: 'operator.denied' });
      expect(await restriction()).toBeUndefined();
      const identity = await off.change(maker, {
        requestId: randomUUID(),
        target: { area: 'identity', userId: target },
        action: 'restrict',
        reason: 'Incident review',
        expectedVersion: '0',
      });
      expect(identity).toMatchObject({ outcome: 'changed' });
      const detail = (
        await db.sql<
          Array<{ detail: { fourEyes?: boolean } }>
        >`SELECT detail FROM founder_control_audit WHERE request_id = ${identity.requestId}`
      )[0];
      expect(detail?.detail).toMatchObject({ fourEyes: false });
    });
  });

  describe('trading restriction reason code', () => {
    const REASONS = new Map([
      ['market_conduct_review', { code: 'market_conduct_review', reason: 'TEST: paused for review.', guidance: 'TEST: ask Support.' }],
      ['account_review', { code: 'account_review', reason: 'TEST: paused while we check the account.', guidance: 'TEST: wait.' }],
    ]);
    const storedCode = async (userId = target) =>
      (await db.sql<Array<{ reason_code: string | null }>>`SELECT reason_code FROM trading_restrictions WHERE user_id = ${userId}`)[0]
        ?.reason_code;

    it('stores a listed code with the restriction, bound into the approval, and a restore clears it', async () => {
      const listed = new FounderControls(db.sql, null, { tradingRestrictRequiresApproval: true, tradingRestrictionReasons: REASONS });
      // An approval minted without the code does not cover a change that carries one.
      const unbound = await mint(target);
      const mismatch = await listed.change(checker, trading({ approvalId: unbound.approvalId, reasonCode: 'market_conduct_review' }));
      expect(mismatch).toMatchObject({ outcome: 'refused', code: 'restriction_approval_mismatch' });
      expect(await approvalRow(unbound.approvalId)).toMatchObject({ status: 'APPROVED', consumed_request_id: null });
      const bound = await mint(target, 'Incident review', 'restrict', '0', 'market_conduct_review');
      const applied = await listed.change(checker, trading({ approvalId: bound.approvalId, reasonCode: 'market_conduct_review' }));
      expect(applied).toMatchObject({ outcome: 'changed', after: { version: '1', restricted: true } });
      expect(await storedCode()).toBe('market_conduct_review');
      // The audit row names the code staff set.
      const [audit] = await db.sql<Array<{ detail: { reasonCode?: string } }>>`
        SELECT detail FROM founder_control_audit WHERE detail->>'approvalId' = ${bound.approvalId}`;
      expect(audit?.detail.reasonCode).toBe('market_conduct_review');
      // Another listed code on the restriction in force refuses before the approval is spent, and the code stays.
      const other = await mint(target, 'Incident review', 'restrict', '1', 'account_review');
      expect(
        await listed.change(checker, trading({ approvalId: other.approvalId, expectedVersion: '1', reasonCode: 'account_review' })),
      ).toMatchObject({ outcome: 'refused', code: 'restriction.reason_in_force', current: { version: '1', restricted: true } });
      expect(await approvalRow(other.approvalId)).toMatchObject({ status: 'APPROVED', consumed_request_id: null });
      expect(await storedCode()).toBe('market_conduct_review');
      // A no-op repeat without a code keeps the restriction's own code.
      const again = await mint(target, 'Incident review', 'restrict', '1');
      expect(await listed.change(checker, trading({ approvalId: again.approvalId, expectedVersion: '1' }))).toMatchObject({
        outcome: 'noop',
      });
      expect(await storedCode()).toBe('market_conduct_review');
      const lift = await mint(target, 'Incident review', 'restore', '1');
      const restored = await listed.change(checker, trading({ approvalId: lift.approvalId, action: 'restore', expectedVersion: '1' }));
      expect(restored).toMatchObject({ outcome: 'changed', after: { version: '2', restricted: false } });
      expect(await storedCode()).toBeNull();
    });

    it('refuses an unlisted code, a code on a restore, and any code while the list is unset, without spending the approval', async () => {
      const listed = new FounderControls(db.sql, null, { tradingRestrictRequiresApproval: true, tradingRestrictionReasons: REASONS });
      const unlisted = await mint(target, 'Incident review', 'restrict', '0', 'not_on_the_list');
      expect(await listed.change(checker, trading({ approvalId: unlisted.approvalId, reasonCode: 'not_on_the_list' }))).toMatchObject({
        outcome: 'refused',
        code: 'restriction.reason_unlisted',
        current: { version: '0', restricted: false },
      });
      expect(await approvalRow(unlisted.approvalId)).toMatchObject({ status: 'APPROVED', consumed_request_id: null });
      const restore = await listed.change(checker, trading({ action: 'restore', reasonCode: 'market_conduct_review' }));
      expect(restore).toMatchObject({ outcome: 'refused', code: 'restriction.reason_unlisted' });
      // `on` has no list: the owner has not published one, so no code is accepted.
      const blank = await mint(target, 'Incident review', 'restrict', '0', 'market_conduct_review');
      expect(await on.change(checker, trading({ approvalId: blank.approvalId, reasonCode: 'market_conduct_review' }))).toMatchObject({
        outcome: 'refused',
        code: 'restriction.reason_unlisted',
      });
      expect(await approvalRow(blank.approvalId)).toMatchObject({ status: 'APPROVED', consumed_request_id: null });
      expect(await restriction()).toBeUndefined();
    });

    it('refuses a reason code on an identity-area change', async () => {
      const off = new FounderControls(db.sql, parseFounderPair(maker.principal!.userId, checker.principal!.userId));
      expect(await off.bootstrap()).toBe(true);
      await expect(
        off.change(maker, {
          requestId: randomUUID(),
          target: { area: 'identity', userId: target },
          action: 'restrict',
          reason: 'Incident review',
          expectedVersion: '0',
          reasonCode: 'market_conduct_review',
        }),
      ).rejects.toMatchObject({ code: 'operator.denied' });
    });
  });
}
