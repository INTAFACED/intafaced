/**
 * Appeals against a trading restriction (I-account-lifecycle-12, J-identity-14 #3 and #4), against Postgres: one open
 * appeal at a time, the owner's window, the decider who set the restriction refused, an uphold that changes only the
 * appeal, and a lift through the founder control's four-eyes that applies once, also when retried after a crash.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { postgresAvailable, type TestDatabase } from '@intafaced/db';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import { appealLiftReason, type Context } from '@intafaced/contracts';
import { createTestDatabase } from '../fixture-truncate.testkit.js';
import { ActionApprovalService } from '../auth/action-approval-service.js';
import { SqlActionApprovalStore } from '../auth/action-approval-store.js';
import { FounderControls, tradingRestrictPayloadHash } from '../controls/founder-controls.js';
import type { KycRejectReasons } from '../kyc/cases.js';
import { AccountAppeals, AppealError, appealLiftRequestId, parseAppealWindowDays } from './appeals.js';

const url = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';
const migrationDirectory = join(dirname(fileURLToPath(import.meta.url)), '../../drizzle');
const migrations = readdirSync(migrationDirectory)
  .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
  .sort()
  .map((file) => readFileSync(join(migrationDirectory, file), 'utf8'));
const tokens = {
  secret: 'an-account-appeals-test-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};
const available = await postgresAvailable(url);
const REASONS: KycRejectReasons = new Map([
  ['review_complete', { code: 'review_complete', reason: 'TEST: we reviewed the account', guidance: 'TEST: trade as usual' }],
  ['restriction_stands', { code: 'restriction_stands', reason: 'TEST: the restriction stands', guidance: 'TEST: contact support' }],
]);

const codeOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (err) {
    if (err instanceof AppealError) return err.code;
    throw err;
  }
  return 'no refusal';
};

describe('parseAppealWindowDays', () => {
  it('reads whole days and leaves blank unset', () => {
    expect(parseAppealWindowDays(undefined)).toBeUndefined();
    expect(parseAppealWindowDays(' ')).toBeUndefined();
    expect(parseAppealWindowDays('30')).toBe(30);
    for (const bad of ['0', '-1', '1.5', 'x', '3651']) expect(() => parseAppealWindowDays(bad)).toThrow(/whole days/);
  });
});

if (!available) {
  describe.skip('account appeals (Postgres unavailable)', () => {
    it('requires isolated Postgres evidence', () => undefined);
  });
} else {
  const db: TestDatabase = await createTestDatabase({ service: 'identity', url, migrations });
  let maker: Context;
  let restrictor: Context;
  let decider: Context;
  let customer: Context;
  let target: string;
  let approvals: ActionApprovalService;
  let controls: FounderControls;

  const seed = async (scopes: string[]): Promise<Context> => {
    const userId = randomUUID();
    const sessionId = randomUUID();
    const handle = `t${userId.replaceAll('-', '').slice(0, 16)}`;
    await db.sql`INSERT INTO users (id, handle, email, email_verified_at, password_hash, totp_secret, totp_enrolled_at) VALUES (${userId}, ${handle}, ${`${handle}@example.com`}, ${new Date()}, ${'test-password-hash'}, ${'verified-test-factor'}, ${new Date()})`;
    await db.sql`INSERT INTO sessions (id, user_id, refresh_hash, mfa, expires_at) VALUES (${sessionId}, ${userId}, ${`refresh:${sessionId}`}, ${true}, ${new Date(Date.now() + 3600000)})`;
    const { token } = await issueAccessToken({ userId, sessionId, scopes: scopes as never, mfa: true }, tokens);
    return { principal: await verifyAccessToken(token, tokens), service: null, region: 'DE', requestId: randomUUID() };
  };

  /** A bound `trading.restrict` approval: `by` proposes, `approver` approves. */
  const mint = async (by: Context, approver: Context, action: 'restrict' | 'restore', reason: string, expectedVersion: string) => {
    const payloadHash = tradingRestrictPayloadHash({ userId: target, action, reason, expectedVersion });
    const pending = await approvals.propose(by.principal!.userId, {
      actionType: 'trading.restrict',
      targetService: 'svc-identity',
      targetId: target,
      expectedVersion,
      payloadHash,
      policyVersion: 'trading-restriction-v1',
    });
    return approvals.approve(approver.principal!.userId, pending.approvalId, payloadHash);
  };

  const restrict = async () => {
    const approved = await mint(restrictor, maker, 'restrict', 'Incident review', '0');
    const done = await controls.change(restrictor, {
      requestId: randomUUID(),
      target: { area: 'trading', userId: target },
      action: 'restrict',
      reason: 'Incident review',
      expectedVersion: '0',
      approvalId: approved.approvalId,
    });
    expect(done.outcome).toBe('changed');
  };

  const held = async () =>
    (
      await db.sql<
        Array<{ restricted: boolean; version: string }>
      >`SELECT restricted, version::text FROM trading_restrictions WHERE user_id = ${target}`
    )[0];
  const notices = async () =>
    db.sql<
      Array<{ purpose: string; detail: string | null }>
    >`SELECT purpose, detail FROM mail_outbox WHERE user_id = ${target} AND purpose = 'appeal-decided'`;

  const desk = (windowDays: number | null = 30, decisionReasons: KycRejectReasons = REASONS) =>
    new AccountAppeals(db.sql, { windowDays: windowDays ?? undefined, decisionReasons, controls });

  const submit = (appeals: AccountAppeals, clientRequestId = randomUUID(), text = 'I did nothing wrong') =>
    appeals.submit(target, { restriction: 'trading_restricted', text, clientRequestId });

  beforeEach(async () => {
    await db.truncateAll();
    maker = await seed(['identity:read', 'identity:write', 'admin:write']);
    restrictor = await seed(['identity:read', 'identity:write', 'admin:write', 'admin:compliance']);
    decider = await seed(['identity:read', 'identity:write', 'admin:write', 'admin:compliance']);
    customer = await seed(['identity:read', 'identity:write']);
    target = customer.principal!.userId;
    approvals = new ActionApprovalService(new SqlActionApprovalStore(db.sql), { ttlSeconds: 600 });
    controls = new FounderControls(db.sql, null, { tradingRestrictRequiresApproval: true });
  });

  afterAll(async () => {
    await db.drop();
  });

  describe('submit', () => {
    it('refuses with the window unset, and with no restriction to appeal', async () => {
      await restrict();
      expect(await codeOf(submit(desk(null)))).toBe('identity.appeal_window_unset');
      await db.sql`UPDATE trading_restrictions SET restricted = false WHERE user_id = ${target}`;
      expect(await codeOf(submit(desk()))).toBe('identity.appeal_no_restriction');
      expect(await db.sql`SELECT id FROM account_appeals`).toHaveLength(0);
    });

    it('keeps one open appeal: a retry returns it, a second is refused, the same key with other text conflicts', async () => {
      await restrict();
      const appeals = desk();
      const key = randomUUID();
      const first = await submit(appeals, key);
      expect(first).toMatchObject({ restriction: 'trading_restricted', status: 'submitted', decision: null, version: '1' });
      expect(await submit(appeals, key)).toEqual(first);
      expect(await codeOf(submit(appeals))).toBe('identity.appeal_open');
      expect(await codeOf(submit(appeals, key, 'another text'))).toBe('identity.appeal_request_conflict');
      const rows = await db.sql<
        Array<{ restricted_by: string; restriction_ref: string }>
      >`SELECT restricted_by, restriction_ref FROM account_appeals`;
      expect(rows).toEqual([{ restricted_by: restrictor.principal!.userId, restriction_ref: 'trading:1' }]);
      expect((await appeals.mine(target)).appeals.map((a) => a.id)).toEqual([first.id]);
    });

    it('counts the window from the change that set the restriction, not from a later write to its row', async () => {
      await restrict();
      // The audit row says it was set just now, so an old row write does not close the window.
      await db.sql`UPDATE trading_restrictions SET updated_at = now() - interval '8 days' WHERE user_id = ${target}`;
      expect((await submit(desk(7))).status).toBe('submitted');
    });

    it('refuses once the window has passed (a restriction with no audit row counts from its row)', async () => {
      await db.sql`INSERT INTO trading_restrictions (user_id, restricted, version, updated_at) VALUES (${target}, true, 1, now() - interval '8 days')`;
      expect(await codeOf(submit(desk(7)))).toBe('identity.appeal_window_closed');
      expect((await submit(desk(9))).status).toBe('submitted');
    });
  });

  describe('decide', () => {
    it('refuses the person who restricted, the account holder, a blank or unlisted reason, and a stale version', async () => {
      await restrict();
      const appeal = await submit(desk());
      const uphold = { appealId: appeal.id, decision: 'uphold' as const, reasonCode: 'restriction_stands', expectedVersion: '1' };
      expect(await codeOf(desk().decide(restrictor, uphold))).toBe('identity.appeal_decider_restricted');
      // The restriction's four-eyes approver set it too.
      expect(await codeOf(desk().decide(maker, uphold))).toBe('identity.appeal_decider_restricted');
      expect(await codeOf(desk().decide(customer, uphold))).toBe('identity.appeal_decider_restricted');
      expect(await codeOf(desk(30, new Map()).decide(decider, uphold))).toBe('identity.appeal_reasons_unset');
      expect(await codeOf(desk().decide(decider, { ...uphold, reasonCode: 'not_listed' }))).toBe('identity.appeal_reason_unlisted');
      expect(await codeOf(desk().decide(decider, { ...uphold, expectedVersion: '2' }))).toBe('identity.appeal_version_conflict');
      expect((await desk().mine(target)).appeals[0]).toMatchObject({ status: 'submitted', version: '1' });
      expect(await notices()).toHaveLength(0);
    });

    it('an uphold keeps the restriction, records the reason, sends one notice, and a repeat changes nothing', async () => {
      await restrict();
      const appeal = await submit(desk());
      const uphold = { appealId: appeal.id, decision: 'uphold' as const, reasonCode: 'restriction_stands', expectedVersion: '1' };
      const done = await desk().decide(decider, uphold);
      expect(done).toMatchObject({
        status: 'upheld',
        decidedBy: decider.principal!.userId,
        decision: { outcome: 'upheld', reason: { code: 'restriction_stands', text: 'TEST: the restriction stands' } },
        version: '2',
      });
      expect(await held()).toEqual({ restricted: true, version: '1' });
      expect(await desk().decide(decider, uphold)).toEqual(done);
      expect(await codeOf(desk().decide(decider, { ...uphold, reasonCode: 'review_complete' }))).toBe('identity.appeal_decided');
      expect(await notices()).toEqual([{ purpose: 'appeal-decided', detail: 'upheld' }]);
      const events = await db.sql<
        Array<{ status: string }>
      >`SELECT status FROM account_appeal_events WHERE appeal_id = ${appeal.id} ORDER BY id`;
      expect(events.map((e) => e.status)).toEqual(['submitted', 'upheld']);
      // Decided, so the person may appeal the same restriction again.
      expect((await submit(desk())).status).toBe('submitted');
    });

    it('a lift releases the restriction once through the four-eyes control, also when retried after a crash', async () => {
      await restrict();
      const appeal = await submit(desk());
      const approved = await mint(decider, maker, 'restore', appealLiftReason(appeal.id), '1');
      const lift = {
        appealId: appeal.id,
        decision: 'lift' as const,
        reasonCode: 'review_complete',
        expectedVersion: '1',
        approvalId: approved.approvalId,
        restrictionVersion: '1',
      };
      expect(await codeOf(desk().decide(decider, { ...lift, restrictionVersion: '0' }))).toBe('identity.appeal_restriction_changed');
      // The crash: the control ran with the appeal's own request key, and the appeal never moved.
      const ran = await controls.change(decider, {
        requestId: appealLiftRequestId(appeal.id, approved.approvalId),
        target: { area: 'trading', userId: target },
        action: 'restore',
        reason: appealLiftReason(appeal.id),
        expectedVersion: '1',
        approvalId: approved.approvalId,
      });
      expect(ran.outcome).toBe('changed');
      // An uphold now refuses: the restriction it names is gone.
      expect(
        await codeOf(desk().decide(decider, { appealId: appeal.id, decision: 'uphold', reasonCode: 'restriction_stands', expectedVersion: '1' })),
      ).toBe('identity.appeal_restriction_changed');
      const done = await desk().decide(decider, lift);
      expect(done).toMatchObject({ status: 'lifted', decision: { outcome: 'lifted', reason: { code: 'review_complete' } } });
      expect(await held()).toEqual({ restricted: false, version: '2' });
      expect(await desk().decide(decider, lift)).toEqual(done);
      expect(await notices()).toEqual([{ purpose: 'appeal-decided', detail: 'lifted' }]);
      const audits = await db.sql`SELECT audit_id FROM founder_control_audit WHERE request_id = ${appealLiftRequestId(appeal.id, approved.approvalId)}`;
      expect(audits).toHaveLength(1);
    });

    it('a lift whose approval does not bind is refused by the control and leaves the appeal open', async () => {
      await restrict();
      const appeal = await submit(desk());
      const wrong = await mint(decider, maker, 'restore', 'Some other reason', '1');
      const code = await codeOf(
        desk().decide(decider, {
          appealId: appeal.id,
          decision: 'lift',
          reasonCode: 'review_complete',
          expectedVersion: '1',
          approvalId: wrong.approvalId,
          restrictionVersion: '1',
        }),
      );
      expect(code).toBe('identity.appeal_lift_refused');
      expect(await held()).toEqual({ restricted: true, version: '1' });
      expect((await desk().mine(target)).appeals[0]).toMatchObject({ status: 'submitted' });
      expect(await notices()).toHaveLength(0);
      // The refusal does not block a later lift with a bound approval, and another compliance decider may make it.
      const other = await seed(['identity:read', 'identity:write', 'admin:write', 'admin:compliance']);
      const good = await mint(other, maker, 'restore', appealLiftReason(appeal.id), '1');
      const done = await desk().decide(other, {
        appealId: appeal.id,
        decision: 'lift',
        reasonCode: 'review_complete',
        expectedVersion: '1',
        approvalId: good.approvalId,
        restrictionVersion: '1',
      });
      expect(done).toMatchObject({ status: 'lifted', decidedBy: other.principal!.userId });
      expect(await held()).toEqual({ restricted: false, version: '2' });
    });
  });
}
