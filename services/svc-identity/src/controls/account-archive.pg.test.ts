import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { postgresAvailable, type TestDatabase } from '@intafaced/db';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { AccountArchiveInput, AccountArchiveReasonCode, AccountClosureInput, Context } from '@intafaced/contracts';
import { createTestDatabase } from '../fixture-truncate.testkit.js';
import { FounderControls, parseFounderPair } from './founder-controls.js';
import { approvedArchive } from './archive-approval.testkit.js';
import { approvedClosure } from './closure-approval.testkit.js';

const url = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';
const migrationDirectory = join(dirname(fileURLToPath(import.meta.url)), '../../drizzle');
const migrations = readdirSync(migrationDirectory)
  .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
  .sort()
  .map((file) => readFileSync(join(migrationDirectory, file), 'utf8'));
const tokens = {
  secret: 'an-account-archive-test-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};
const available = await postgresAvailable(url);
const REASON = 'Closed two years ago, no contact since';

if (!available) {
  describe.skip('staff archive of a customer record (Postgres unavailable)', () => {
    it('requires isolated Postgres evidence', () => undefined);
  });
} else {
  const db: TestDatabase = await createTestDatabase({ service: 'identity', url, migrations });
  let controls: FounderControls;
  let first: Context;
  let second: Context;
  let customer: Context;
  let target: string;

  const seed = async (): Promise<Context> => {
    const userId = randomUUID();
    const sessionId = randomUUID();
    const handle = `a${userId.replaceAll('-', '').slice(0, 16)}`;
    await db.sql`INSERT INTO users (id, handle, email, password_hash, totp_secret, totp_enrolled_at) VALUES (${userId}, ${handle}, ${`${handle}@example.com`}, ${'test-password-hash'}, ${'verified-test-factor'}, ${new Date()})`;
    await db.sql`INSERT INTO sessions (id, user_id, refresh_hash, mfa, expires_at) VALUES (${sessionId}, ${userId}, ${`refresh:${sessionId}`}, ${true}, ${new Date(Date.now() + 3600000)})`;
    const { token } = await issueAccessToken({ userId, sessionId, scopes: ['identity:read', 'identity:write'], mfa: true }, tokens);
    return { principal: await verifyAccessToken(token, tokens), service: null, region: 'DE', requestId: randomUUID() };
  };
  const id = (context: Context) => context.principal!.userId;
  const archive = (
    expectedVersion: string,
    reasonCode: AccountArchiveReasonCode = 'dormant',
    approvalId?: string,
  ): AccountArchiveInput => ({
    requestId: randomUUID(),
    userId: target,
    reasonCode,
    reason: REASON,
    expectedVersion,
    ...(approvalId ? { approvalId } : {}),
  });
  const approved = async (by: Context, approver: string, input: AccountArchiveInput): Promise<AccountArchiveInput> => ({
    ...input,
    approvalId: await approvedArchive(db.sql, { requesterId: id(by), approverId: approver, ...input }),
  });
  /** Closes the customer the way a staff close does, at the customer's request (so it would be reopenable). */
  const closeCustomer = async () => {
    const input: AccountClosureInput = {
      requestId: randomUUID(),
      userId: target,
      action: 'close',
      reasonCode: 'customer_request',
      reason: 'Customer asked to close by letter',
      expectedVersion: '0',
    };
    const approvalId = await approvedClosure(db.sql, { requesterId: id(first), approverId: id(second), ...input });
    expect(await controls.closure(first, { ...input, approvalId })).toMatchObject({ outcome: 'changed' });
  };
  const row = async () =>
    (
      await db.sql<
        Array<{ status: string; version: string; archived_at: Date | null; archive_reason: string | null }>
      >`SELECT status, identity_control_version::text AS version, archived_at, archive_reason FROM users WHERE id = ${target}`
    )[0]!;
  const approvalStatus = async (approvalId: string) =>
    (await db.sql<Array<{ status: string }>>`SELECT status FROM action_approvals WHERE approval_id = ${approvalId}`)[0]!.status;

  beforeEach(async () => {
    await db.truncateAll();
    first = await seed();
    second = await seed();
    customer = await seed();
    target = id(customer);
    controls = new FounderControls(db.sql, parseFounderPair(id(first), id(second)));
    expect(await controls.bootstrap()).toBe(true);
    controls.useClosureChecks(async () => ({ ok: true, blockers: [] }));
  });
  afterAll(async () => {
    await db.drop();
  });

  describe('staff archive of a customer record (J-ops-console-04 #10)', () => {
    it('refuses while the account is open, and spends no approval', async () => {
      const input = await approved(first, id(second), archive('0'));
      expect(await controls.archive(first, input)).toMatchObject({
        outcome: 'refused',
        code: 'identity.archive_blocked_open_account',
        current: { status: 'active', archivedAt: null, archiveReasonCode: null },
      });
      expect(await approvalStatus(input.approvalId!)).toBe('APPROVED');
      expect(await row()).toMatchObject({ status: 'active', archived_at: null });
    });

    it('archives a closed account only with a second person approval, spent once, and the history names both', async () => {
      await closeCustomer();
      expect(await controls.archive(first, archive('1'))).toMatchObject({ code: 'identity.archive_requires_approver' });
      // Proposed by the other founder: not the actor's own request.
      expect(await controls.archive(first, await approved(second, id(first), archive('1')))).toMatchObject({
        code: 'identity.archive_approval_mismatch',
      });
      // An approval over another reason code, or an older version, does not bind.
      const other = await approvedArchive(db.sql, {
        requesterId: id(first),
        approverId: id(second),
        ...archive('1', 'duplicate'),
      });
      expect(await controls.archive(first, archive('1', 'dormant', other))).toMatchObject({ code: 'identity.archive_approval_mismatch' });
      expect((await row()).archived_at).toBeNull();

      const input = await approved(first, id(second), archive('1'));
      const done = await controls.archive(first, input);
      expect(done).toMatchObject({
        outcome: 'changed',
        actorUserId: id(first),
        approverUserId: id(second),
        before: { status: 'closed', version: '1', archivedAt: null },
        after: { status: 'closed', version: '2', archiveReasonCode: 'dormant' },
      });
      expect(await row()).toMatchObject({ status: 'closed', version: '2', archive_reason: 'dormant' });
      expect((await row()).archived_at).toBeInstanceOf(Date);
      expect(await approvalStatus(input.approvalId!)).toBe('CONSUMED');
      // The same request again returns the stored answer; the same approval on a new request is spent.
      expect(await controls.archive(first, input)).toEqual(done);
      expect(await controls.archive(first, { ...input, requestId: randomUUID() })).toMatchObject({ code: 'identity.account_archived' });

      const history = await controls.archiveHistory(first, { userId: target, limit: 20 });
      expect(history.map((entry) => entry.outcome)).toEqual(['refused', 'changed', 'refused', 'refused', 'refused']);
      expect(history[1]).toMatchObject({ outcome: 'changed', approverUserId: id(second) });
      expect(await controls.archiveState(first, { userId: target })).toMatchObject({ archiveReasonCode: 'dormant', version: '2' });
    });

    it('leaves the record read-only: reopen, unfreeze, freeze and a second archive refuse identity.account_archived', async () => {
      await closeCustomer();
      expect(await controls.archive(first, await approved(first, id(second), archive('1')))).toMatchObject({ outcome: 'changed' });
      const reopen: AccountClosureInput = {
        requestId: randomUUID(),
        userId: target,
        action: 'reopen',
        reason: 'Customer came back',
        expectedVersion: '2',
      };
      const reopenApproval = await approvedClosure(db.sql, { requesterId: id(first), approverId: id(second), ...reopen });
      expect(await controls.closure(first, { ...reopen, approvalId: reopenApproval })).toMatchObject({
        outcome: 'refused',
        code: 'identity.account_archived',
      });
      expect(await approvalStatus(reopenApproval)).toBe('APPROVED');
      for (const action of ['restrict', 'restore'] as const)
        expect(
          await controls.change(first, {
            requestId: randomUUID(),
            target: { area: 'identity', userId: target },
            action,
            reason: 'Read-only check',
            expectedVersion: '2',
          }),
        ).toMatchObject({ outcome: 'refused', code: 'identity.account_archived' });
      expect(await controls.archive(first, await approved(first, id(second), archive('2')))).toMatchObject({
        code: 'identity.account_archived',
      });
      expect(await row()).toMatchObject({ status: 'closed', version: '2', archive_reason: 'dormant' });
    });

    it('refuses a founder record, a stale version, and anyone who is not a live founder', async () => {
      target = id(second);
      expect(await controls.archive(first, archive('0'))).toMatchObject({ code: 'identity.archive_founder_forbidden' });
      target = id(customer);
      await closeCustomer();
      expect(await controls.archive(first, await approved(first, id(second), archive('0')))).toMatchObject({
        outcome: 'conflict',
        code: 'restriction.version_conflict',
        current: { version: '1' },
      });
      expect(await controls.archive(customer, archive('1'))).toMatchObject({ code: 'operator.denied', current: null });
      await expect(controls.archiveState(customer, { userId: target })).rejects.toMatchObject({ code: 'operator.denied' });
      await expect(controls.archiveProposals(customer)).rejects.toMatchObject({ code: 'operator.denied' });
    });

    it('never stores an archive on an open account, or one without its reason', async () => {
      await expect(db.sql`UPDATE users SET archived_at = now(), archive_reason = 'dormant' WHERE id = ${target}`).rejects.toThrow(
        /users_archive_ck/,
      );
      await closeCustomer();
      await expect(db.sql`UPDATE users SET archived_at = now() WHERE id = ${target}`).rejects.toThrow(/users_archive_ck/);
      await expect(db.sql`UPDATE users SET archived_at = now(), archive_reason = 'made_up' WHERE id = ${target}`).rejects.toThrow(
        /users_archive_ck/,
      );
    });
  });

  describe('dormant customers proposed for archive', () => {
    it('makes no proposal while the owner has set no dormancy period', async () => {
      await closeCustomer();
      await db.sql`UPDATE users SET updated_at = now() - interval '400 days' WHERE id = ${target}`;
      await db.sql`UPDATE sessions SET created_at = now() - interval '400 days' WHERE user_id = ${target}`;
      expect(await controls.archiveProposals(first)).toMatchObject({ dormancyDays: null, proposals: [] });
    });

    it('proposes closed, unarchived records with no change and no new session for the period, and nothing else', async () => {
      controls.useDormancyDays(30);
      await closeCustomer();
      const quiet = target;
      const recent = id(await seed());
      const open = id(await seed());
      await db.sql`UPDATE users SET status = 'closed', closed_reason = 'other' WHERE id = ${recent}`;
      await db.sql`UPDATE users SET updated_at = now() - interval '40 days' WHERE id IN (${quiet}, ${recent}, ${open})`;
      await db.sql`UPDATE sessions SET created_at = now() - interval '40 days' WHERE user_id IN (${quiet}, ${open})`;
      const proposals = await controls.archiveProposals(first);
      expect(proposals.dormancyDays).toBe(30);
      expect(proposals.proposals.map((p) => p.userId)).toEqual([quiet]);
      // Once archived it is no longer proposed.
      expect(await controls.archive(first, await approved(first, id(second), archive('1')))).toMatchObject({ outcome: 'changed' });
      await db.sql`UPDATE users SET updated_at = now() - interval '40 days' WHERE id = ${quiet}`;
      expect((await controls.archiveProposals(first)).proposals).toEqual([]);
    });
  });
}
