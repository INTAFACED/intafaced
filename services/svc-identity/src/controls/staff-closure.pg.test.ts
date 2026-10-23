import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { postgresAvailable, type TestDatabase } from '@intafaced/db';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { AccountCloseReasonCode, AccountClosureInput, Context } from '@intafaced/contracts';
import { createTestDatabase } from '../fixture-truncate.testkit.js';
import { FounderControls, parseFounderPair, type StaffClosureChecks } from './founder-controls.js';
import { approvedClosure } from './closure-approval.testkit.js';

const url = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';
const migrationDirectory = join(dirname(fileURLToPath(import.meta.url)), '../../drizzle');
const migrations = readdirSync(migrationDirectory)
  .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
  .sort()
  .map((file) => readFileSync(join(migrationDirectory, file), 'utf8'));
const tokens = {
  secret: 'a-staff-closure-test-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};
const available = await postgresAvailable(url);
const REASON = 'Customer asked to close by letter';

if (!available) {
  describe.skip('staff account closure (Postgres unavailable)', () => {
    it('requires isolated Postgres evidence', () => undefined);
  });
} else {
  const db: TestDatabase = await createTestDatabase({ service: 'identity', url, migrations });
  let controls: FounderControls;
  let first: Context;
  let second: Context;
  let customer: Context;
  let target: string;
  let checks: Array<{ userId: string; subAccountIds: readonly string[] }>;
  let blockers: Array<{ code: string; count: number }>;

  const seed = async (): Promise<Context> => {
    const userId = randomUUID();
    const sessionId = randomUUID();
    const handle = `c${userId.replaceAll('-', '').slice(0, 16)}`;
    await db.sql`INSERT INTO users (id, handle, email, password_hash, totp_secret, totp_enrolled_at) VALUES (${userId}, ${handle}, ${`${handle}@example.com`}, ${'test-password-hash'}, ${'verified-test-factor'}, ${new Date()})`;
    await db.sql`INSERT INTO sessions (id, user_id, refresh_hash, mfa, expires_at) VALUES (${sessionId}, ${userId}, ${`refresh:${sessionId}`}, ${true}, ${new Date(Date.now() + 3600000)})`;
    const { token } = await issueAccessToken({ userId, sessionId, scopes: ['identity:read', 'identity:write'], mfa: true }, tokens);
    return { principal: await verifyAccessToken(token, tokens), service: null, region: 'DE', requestId: randomUUID() };
  };
  const id = (context: Context) => context.principal!.userId;
  const close = (
    expectedVersion = '0',
    reasonCode: AccountCloseReasonCode = 'customer_request',
    approvalId?: string,
  ): AccountClosureInput => ({
    requestId: randomUUID(),
    userId: target,
    action: 'close',
    reasonCode,
    reason: REASON,
    expectedVersion,
    ...(approvalId ? { approvalId } : {}),
  });
  const reopen = (expectedVersion: string, approvalId?: string): AccountClosureInput => ({
    requestId: randomUUID(),
    userId: target,
    action: 'reopen',
    reason: REASON,
    expectedVersion,
    ...(approvalId ? { approvalId } : {}),
  });
  /** `by` proposes and `approver` approves this exact close or reopen. */
  const approve = (by: Context, approver: string, input: AccountClosureInput) =>
    approvedClosure(db.sql, {
      requesterId: id(by),
      approverId: approver,
      userId: input.userId,
      action: input.action,
      ...(input.action === 'close' ? { reasonCode: input.reasonCode } : {}),
      reason: input.reason,
      expectedVersion: input.expectedVersion,
    });
  const approved = async (by: Context, approver: string, input: AccountClosureInput): Promise<AccountClosureInput> => ({
    ...input,
    approvalId: await approve(by, approver, input),
  });
  const user = async () =>
    (
      await db.sql<
        Array<{ status: string; version: string; closed_reason: string | null }>
      >`SELECT status, identity_control_version::text AS version, closed_reason FROM users WHERE id = ${target}`
    )[0];
  const approvalStatus = async (approvalId: string) =>
    (await db.sql<Array<{ status: string }>>`SELECT status FROM action_approvals WHERE approval_id = ${approvalId}`)[0]!.status;

  beforeEach(async () => {
    await db.truncateAll();
    first = await seed();
    second = await seed();
    customer = await seed();
    target = id(customer);
    checks = [];
    blockers = [];
    controls = new FounderControls(db.sql, parseFounderPair(id(first), id(second)));
    expect(await controls.bootstrap()).toBe(true);
    const fake: StaffClosureChecks = async (input) => {
      checks.push(input);
      return { ok: true, blockers };
    };
    controls.useClosureChecks(fake);
  });
  afterAll(async () => {
    await db.drop();
  });

  describe('staff close and reopen of one account (J-ops-console-04 #7)', () => {
    it('closes only with a second person approval, spent once, and the history names both', async () => {
      const subId = randomUUID();
      await db.sql`INSERT INTO sub_accounts (id, parent_user_id, label) VALUES (${subId}, ${target}, ${'Partition'})`;
      expect(await controls.closure(first, close())).toMatchObject({
        outcome: 'refused',
        code: 'identity.close_requires_approver',
        current: { status: 'active', closedBy: null, reopenable: false },
      });
      // Proposed by the other founder: the approval is not the actor's own request.
      expect(await controls.closure(first, await approved(second, id(first), close()))).toMatchObject({
        code: 'identity.close_approval_mismatch',
      });
      // An approval over another reason code does not bind.
      const other = await approve(first, id(second), close('0', 'fraud'));
      expect(await controls.closure(first, close('0', 'customer_request', other))).toMatchObject({
        code: 'identity.close_approval_mismatch',
      });
      expect(await user()).toEqual({ status: 'active', version: '0', closed_reason: null });

      const input = await approved(first, id(second), close());
      const done = await controls.closure(first, input);
      expect(done).toMatchObject({
        outcome: 'changed',
        actorUserId: id(first),
        approverUserId: id(second),
        reasonCode: 'customer_request',
        before: { status: 'active', version: '0' },
        after: { status: 'closed', version: '1', closedBy: 'customer', closeReasonCode: 'customer_request', reopenable: true },
      });
      expect(checks).toEqual([{ userId: target, subAccountIds: [subId] }]);
      expect(await user()).toEqual({ status: 'closed', version: '1', closed_reason: 'customer_request' });
      expect((await db.sql<Array<{ revoked: boolean }>>`SELECT revoked FROM sessions WHERE user_id = ${target}`)[0]!.revoked).toBe(true);
      expect((await db.sql<Array<{ revoked: boolean }>>`SELECT revoked FROM sub_accounts WHERE id = ${subId}`)[0]!.revoked).toBe(true);
      expect(await approvalStatus(input.approvalId!)).toBe('CONSUMED');

      // The same request id returns the stored answer; a new request with the spent approval is refused.
      expect(await controls.closure(first, input)).toEqual(done);
      expect(await controls.closure(first, { ...input, requestId: randomUUID(), expectedVersion: '1' })).toMatchObject({
        outcome: 'refused',
        code: 'identity.close_already_closed',
      });
      const history = await controls.closureHistory(first, { userId: target, limit: 10 });
      expect(history.map((row) => row.outcome)).toEqual(['refused', 'changed', 'refused', 'refused', 'refused']);
      expect(history[1]).toMatchObject({ actorUserId: id(first), approverUserId: id(second) });
    });

    it('refuses a founder, the actor themself, a stale version and an unauthenticated caller', async () => {
      target = id(second);
      expect(await controls.closure(first, await approved(first, id(customer), close()))).toMatchObject({
        code: 'identity.close_founder_forbidden',
      });
      target = id(customer);
      expect(await controls.closure(first, close('7'))).toMatchObject({ outcome: 'conflict', code: 'restriction.version_conflict' });
      expect(await controls.closure({ ...customer }, close())).toMatchObject({
        outcome: 'refused',
        code: 'operator.denied',
        current: null,
      });
      expect(await user()).toEqual({ status: 'active', version: '0', closed_reason: null });
    });

    it('refuses an approval given at an earlier control version, after a freeze moved the account on', async () => {
      const early = await approved(first, id(second), close('0'));
      await controls.change(first, {
        requestId: randomUUID(),
        target: { area: 'identity', userId: target },
        action: 'restrict',
        reason: 'Incident review',
        expectedVersion: '0',
      });
      expect(await controls.closure(first, { ...early, requestId: randomUUID(), expectedVersion: '1' })).toMatchObject({
        outcome: 'refused',
        code: 'identity.close_approval_mismatch',
      });
      expect(await user()).toEqual({ status: 'frozen', version: '1', closed_reason: null });
      expect(await approvalStatus(early.approvalId!)).toBe('APPROVED');
    });

    it('refuses while the closure checks report open products, and keeps the approval unspent', async () => {
      blockers = [{ code: 'bank.balance_open', count: 1 }];
      const input = await approved(first, id(second), close());
      expect(await controls.closure(first, input)).toMatchObject({
        outcome: 'refused',
        code: 'identity.close_blocked',
        blockers: [{ code: 'bank.balance_open', count: 1 }],
      });
      expect(await approvalStatus(input.approvalId!)).toBe('APPROVED');
      controls.useClosureChecks(async () => ({ ok: false }));
      expect(await controls.closure(first, { ...input, requestId: randomUUID() })).toMatchObject({
        code: 'identity.close_check_unavailable',
      });
      expect(await approvalStatus(input.approvalId!)).toBe('APPROVED');
      blockers = [];
      controls.useClosureChecks(async () => ({ ok: true, blockers }));
      expect(await controls.closure(first, { ...input, requestId: randomUUID() })).toMatchObject({ outcome: 'changed' });
      expect(await user()).toMatchObject({ status: 'closed' });
    });

    it('reopens a customer-closed account with a second approver, and refuses one closed for another reason', async () => {
      await controls.closure(first, await approved(first, id(second), close()));
      expect(await controls.closure(second, reopen('1'))).toMatchObject({ code: 'identity.close_requires_approver' });
      expect(await controls.closure(second, await approved(second, id(first), reopen('1')))).toMatchObject({
        outcome: 'changed',
        approverUserId: id(first),
        after: { status: 'active', version: '2', closedBy: null, closeReasonCode: null, reopenable: false },
      });
      expect(await user()).toEqual({ status: 'active', version: '2', closed_reason: null });
      expect(await controls.closure(second, await approved(second, id(first), reopen('2')))).toMatchObject({
        code: 'identity.reopen_not_closed',
      });

      await controls.closure(first, await approved(first, id(second), close('2', 'bank_reason')));
      expect(await controls.closureState(first, { userId: target })).toMatchObject({
        status: 'closed',
        closedBy: 'staff',
        closeReasonCode: 'bank_reason',
        reopenable: false,
      });
      expect(await controls.closure(second, await approved(second, id(first), reopen('3')))).toMatchObject({
        outcome: 'refused',
        code: 'identity.reopen_not_allowed',
      });
      expect(await user()).toEqual({ status: 'closed', version: '3', closed_reason: 'bank_reason' });
    });

    it('treats an account the customer closed through the closure flow as customer-closed', async () => {
      await db.sql`INSERT INTO account_closures (user_id, status, requested_at, effective_at, finalized_at, client_request_id) VALUES (${target}, 'closed', now(), now(), now(), ${'flow-1'})`;
      await db.sql`UPDATE users SET status = 'closed' WHERE id = ${target}`;
      expect(await controls.closureState(first, { userId: target })).toMatchObject({ closedBy: 'customer', reopenable: true });
      expect(await controls.closure(first, await approved(first, id(second), reopen('0')))).toMatchObject({ outcome: 'changed' });
      expect(await user()).toMatchObject({ status: 'active' });
      // A close with no flow row and no staff code is not the customer's: it stays closed.
      target = id(await seed());
      await db.sql`UPDATE users SET status = 'closed' WHERE id = ${target}`;
      expect(await controls.closureState(first, { userId: target })).toMatchObject({
        closedBy: 'staff',
        closeReasonCode: null,
        reopenable: false,
      });
    });
  });
}
